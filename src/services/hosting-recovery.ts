import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { HostingError } from './hosting-billing';

/** Offline recovery SEAM for the approved policy: 30 days read-only, then live removal only with a 30-day encrypted offline copy that has passed an
 * isolated restore test, support restore, and expiry. This module is deliberately inert:
 *  - it holds no key and produces no ciphertext itself; a trusted `RecoveryVault` does (and none is configured by default);
 *  - it never reads, copies, moves or removes live workspace data, and no route reaches it;
 *  - NOTHING is claimed recoverable. Byte identity of an arbitrary blob (even from a `production` vault, even with an empty or self-serving manifest) is NOT proof of
 *    a complete workspace snapshot, so `promised` is false and `removalGate` always carries `recovery_snapshot_unverified` until a separately implemented, trusted
 *    full-workspace capture + isolated restore verifier exists and binds its attestation to the workspace and snapshot version. No flag, name or provenance label bypasses this.
 * Operator tooling that would remove live data must call `removalGate` and refuse unless it allows. */
type Db = ReturnType<typeof getDb>;
export const RECOVERY_COPY_DAYS = 30;
const DAY = 86_400_000;
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');

export interface RecoveryVault {
  /** 'production' = the real encrypted, isolated store. 'test' doubles can never produce a recoverability promise. */
  readonly provenance: 'production' | 'test';
  /** Encrypts under a key only the vault holds; returns opaque references and the ciphertext identity. NStack never sees key material. */
  seal(input: { workspaceId: string; plaintext: Uint8Array }): Promise<{ objectRef: string; keyRef: string; ciphertextSha256: string; ciphertextBytes: number }>;
  /** Isolated restore test: decrypt in an isolated target (never into live tables) and report the plaintext identity actually recovered. */
  restoreIdentity(objectRef: string): Promise<{ plaintextSha256: string; plaintextBytes: number }>;
  /** Irreversibly destroys the sealed copy at expiry. */
  destroy(objectRef: string): Promise<void>;
}
let vault: RecoveryVault | null = null;
/** Trusted startup/test hook only. No route, environment value or request registers a vault. */
export function configureRecoveryVault(next: RecoveryVault | null) { vault = next; }
const requireVault = () => { if (!vault) throw new HostingError(503, 'recovery_vault_unconfigured'); return vault; };

export interface RecoveryManifest {
  workspace_id: string; taken_at: string;
  /** What the snapshot producer states it contains and does not contain (for example the export coverage list); stored verbatim, never interpreted as proof. */
  includes: string[]; excludes: string[];
}
function checkManifest(m: RecoveryManifest, workspaceId: string) {
  if (!m || m.workspace_id !== workspaceId || typeof m.taken_at !== 'string' || Number.isNaN(Date.parse(m.taken_at)) || !Array.isArray(m.includes) || !Array.isArray(m.excludes)
    || [...m.includes, ...m.excludes].some(x => typeof x !== 'string' || x.length > 200) || m.includes.length > 500 || m.excludes.length > 500) throw new HostingError(400, 'invalid_recovery_manifest');
}
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as any).sort().map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}` : JSON.stringify(v);

async function note(sql: Db, copyId: string, kind: string, detail: Record<string, unknown>) {
  await sql`INSERT INTO hosting_recovery_events(copy_id,kind,detail) VALUES(${copyId},${kind},${sql.json(detail as any)})`;
}

/** Records a sealed copy produced from `plaintext` (supplied by whatever snapshot producer is authorised; this module does not read live data). */
export async function sealRecoveryCopy(input: { workspaceId: string; manifest: RecoveryManifest; plaintext: Uint8Array }, now = new Date(), db: Db = getDb()) {
  const v = requireVault();
  checkManifest(input.manifest, input.workspaceId);
  if (!(input.plaintext instanceof Uint8Array) || input.plaintext.byteLength < 1) throw new HostingError(400, 'invalid_recovery_source');
  const [link] = await db`SELECT account_id FROM hosting_storage_enrollments WHERE workspace_id=${input.workspaceId} UNION ALL SELECT account_id FROM hosting_workspace_accounts WHERE workspace_id=${input.workspaceId} LIMIT 1`;
  if (!link) throw new HostingError(404, 'workspace_not_billed');
  const sealed = await v.seal({ workspaceId: input.workspaceId, plaintext: input.plaintext });
  if (!sealed || !HEX64.test(sealed.ciphertextSha256) || !(sealed.ciphertextBytes > 0) || typeof sealed.objectRef !== 'string' || !sealed.objectRef || typeof sealed.keyRef !== 'string' || !sealed.keyRef) throw new HostingError(502, 'recovery_vault_invalid');
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    const [row] = await sql`INSERT INTO hosting_recovery_copies(workspace_id,account_id,state,provenance,manifest,manifest_sha256,plaintext_sha256,plaintext_bytes,object_ref,key_ref,ciphertext_sha256,ciphertext_bytes,sealed_at,expires_at)
      VALUES(${input.workspaceId},${link.account_id},'sealed',${v.provenance},${sql.json(input.manifest as any)},${sha256(canonical(input.manifest))},${sha256(input.plaintext)},${input.plaintext.byteLength},${sealed.objectRef},${sealed.keyRef},${sealed.ciphertextSha256},${sealed.ciphertextBytes},${now},${new Date(now.getTime() + RECOVERY_COPY_DAYS * DAY)}) RETURNING *`;
    await note(sql, row!.id as string, 'sealed', { provenance: v.provenance });
    return row!;
  });
}

/** The isolated restore test. A copy is only ever `restore_verified` when the vault recovers exactly the identity that was sealed. */
export async function verifyRecoveryRestore(copyId: string, now = new Date(), db: Db = getDb()) {
  const v = requireVault();
  const [copy] = await db`SELECT * FROM hosting_recovery_copies WHERE id=${copyId}`;
  if (!copy) throw new HostingError(404, 'recovery_copy_not_found');
  if (!['sealed', 'restore_verified'].includes(copy.state) || new Date(copy.expires_at) <= now) throw new HostingError(409, 'recovery_copy_not_verifiable');
  if (copy.provenance !== v.provenance) throw new HostingError(409, 'recovery_vault_mismatch');
  let got: { plaintextSha256: string; plaintextBytes: number } | null = null, failure: string | null = null;
  try { got = await v.restoreIdentity(copy.object_ref); } catch { failure = 'restore_unavailable'; }
  if (got && (got.plaintextSha256 !== copy.plaintext_sha256 || got.plaintextBytes !== Number(copy.plaintext_bytes))) failure = 'restored_identity_mismatch';
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    if (failure === 'restore_unavailable') { await note(sql, copyId, 'restore_failed', { reason: failure }); throw new HostingError(502, 'recovery_restore_unavailable'); }
    if (failure) {
      const [row] = await sql`UPDATE hosting_recovery_copies SET state='failed',failure=${failure} WHERE id=${copyId} AND state IN ('sealed','restore_verified') AND expires_at>${now} RETURNING *`;
      if (!row) throw new HostingError(409, 'recovery_copy_not_verifiable'); // expired or finalised while the restore ran: no event, no state change
      await note(sql, copyId, 'restore_failed', { reason: failure });
      return row;
    }
    const [row] = await sql`UPDATE hosting_recovery_copies SET state='restore_verified',restore_verified_at=${now},restore_evidence=${sql.json({ plaintext_sha256: got!.plaintextSha256, plaintext_bytes: got!.plaintextBytes, vault_provenance: v.provenance } as any)} WHERE id=${copyId} AND state IN ('sealed','restore_verified') AND expires_at>${now} RETURNING *`;
    if (!row) throw new HostingError(409, 'recovery_copy_not_verifiable'); // expiry (or another transition) won the race: never record a false restore_verified
    await note(sql, copyId, 'restore_verified', { plaintext_sha256: got!.plaintextSha256 });
    return row;
  });
}

/** Expires and destroys copies past their 30 days. Only sealed copies are touched; live data is never involved. A `failed` copy keeps its final state
 * but its sealed bytes are destroyed on the same schedule (recorded once as an `expired` event), so a failed restore test never extends retention. */
export async function expireRecoveryCopies(now = new Date(), db: Db = getDb()) {
  const due = await db`SELECT * FROM hosting_recovery_copies c WHERE expires_at<=${now} AND (state IN ('sealed','restore_verified') OR (state='failed' AND NOT EXISTS(SELECT 1 FROM hosting_recovery_events e WHERE e.copy_id=c.id AND e.kind='expired'))) ORDER BY expires_at LIMIT 100`;
  let expired = 0;
  for (const copy of due) {
    try { await requireVault().destroy(copy.object_ref); }
    catch { await note(db, copy.id, 'destroy_failed', {}); continue; } // stays un-expired so the next run retries destruction
    await db`UPDATE hosting_recovery_copies SET state='expired',expired_at=${now} WHERE id=${copy.id} AND state IN ('sealed','restore_verified')`;
    await note(db, copy.id, 'expired', {});
    expired++;
  }
  return { expired };
}

/** What may honestly be said about offline recovery for an account. `promised` requires a production-vault copy that passed an isolated restore and is unexpired. */
export async function accountRecoveryState(db: Db, accountId: string, now = new Date()) {
  const rows = await db`SELECT state,provenance,expires_at,restore_verified_at,workspace_id FROM hosting_recovery_copies WHERE account_id=${accountId} AND state IN ('sealed','restore_verified') AND expires_at>${now}`;
  const available = rows.length > 0;
  const verified = rows.some(r => r.state === 'restore_verified');
  const promised = false; // see the module header: no complete-snapshot verifier exists, so no copy can yet earn a recoverability promise
  const latest = rows.map(r => new Date(r.expires_at).getTime()).sort((a, b) => b - a)[0] ?? null;
  return { available, verified, promised, expires_at: latest ? new Date(latest).toISOString() : null,
    reason: 'No complete workspace snapshot has been captured and verified by an isolated restore. Live removal must not be described as erasure or as recoverable.' };
}

/** The activation gate for any future operator tool that would remove live data. It requires the free read-only period to have ended, a restore-verified unexpired
 * production-vault copy of THAT workspace AND a complete-snapshot attestation that does not exist yet, so it currently never allows. Nothing here removes anything. */
export async function removalGate(workspaceId: string, now = new Date(), db: Db = getDb()) {
  const [link] = await db`SELECT account_id FROM hosting_storage_enrollments WHERE workspace_id=${workspaceId} UNION ALL SELECT account_id FROM hosting_workspace_accounts WHERE workspace_id=${workspaceId} LIMIT 1`;
  if (!link) return { allowed: false, reasons: ['workspace_not_billed'] };
  const { accountLifecycle } = await import('./hosting-lifecycle');
  const lifecycle = await accountLifecycle(db, link.account_id as string, now);
  const reasons: string[] = [];
  if (!lifecycle.removal.due) reasons.push('read_only_period_not_ended');
  const [copy] = await db`SELECT 1 FROM hosting_recovery_copies WHERE workspace_id=${workspaceId} AND state='restore_verified' AND provenance='production' AND expires_at>${now} LIMIT 1`;
  if (!copy) reasons.push('no_verified_recovery_copy');
  // A byte-identical restore of whatever was sealed says nothing about completeness. Until a trusted complete-snapshot verifier exists the gate stays closed.
  reasons.push('recovery_snapshot_unverified');
  return { allowed: false, reasons };
}
