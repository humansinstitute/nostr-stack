import { createHash } from 'node:crypto';
import { bech32 } from '@scure/base';
import { getDb } from '../db';
import { HostingError } from './hosting-billing';

type Db = ReturnType<typeof getDb>;
const RESERVED = new Set(['admin', 'support', 'nstack', 'wingman', 'root', 'system']);
const USERNAME = /^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/;
const NCRYPTSEC_LENGTH = 162; // 'ncryptsec1' + ceil(91*8/5)=146 data chars + 6 checksum chars
const bad = (code: string, status = 400) => new HostingError(status, code);

/** NFKC then lowercase; only a conservative ASCII set survives, so compatibility/homoglyph forms that normalise elsewhere are refused. */
export function normalizeUsername(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 64) throw bad('invalid_username');
  const name = raw.normalize('NFKC').toLowerCase();
  if (!USERNAME.test(name) || RESERVED.has(name)) throw bad('invalid_username');
  return name;
}

/** Shape, length and header checks run BEFORE any bech32 decoding allocation. The server has no password and cannot prove the blob decrypts. */
export function validateNcryptsec(value: unknown): { ncryptsec: string; logn: number } {
  if (typeof value !== 'string' || value.length !== NCRYPTSEC_LENGTH || !/^ncryptsec1[02-9ac-hj-np-z]+$/.test(value)) throw bad('invalid_backup');
  let bytes: Uint8Array;
  try { const { prefix, words } = bech32.decode(value as `${string}1${string}`, NCRYPTSEC_LENGTH); if (prefix !== 'ncryptsec') throw new Error('prefix'); bytes = new Uint8Array(bech32.fromWords(words)); }
  catch { throw bad('invalid_backup'); }
  // version(1) logN(1) salt(16) nonce(24) security(1) ciphertext+tag(48)
  if (bytes.length !== 91 || bytes[0] !== 2 || bytes[1]! < 16 || bytes[1]! > 18 || bytes[42]! > 2) throw bad('invalid_backup');
  return { ncryptsec: value, logn: bytes[1]! };
}

const view = (r: any) => ({ username: r.username as string, revision: String(r.revision), updated_at: new Date(r.updated_at).toISOString() });

export async function putIdentityBackup(ownerNpub: string, usernameRaw: string, body: any, db: Db = getDb()) {
  const username = normalizeUsername(usernameRaw);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['ncryptsec', 'expected_revision'].includes(k)) || !('ncryptsec' in body) || !('expected_revision' in body)) throw bad('invalid_body');
  if (typeof body.expected_revision !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(body.expected_revision)) throw bad('invalid_body');
  const expected = BigInt(body.expected_revision);
  const { ncryptsec, logn } = validateNcryptsec(body.ncryptsec);
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    // One serialisation point per username and per owner key keeps first-claim-wins and one-per-npub exact under concurrency.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`identity-backup:${username}`}))`;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`identity-backup-owner:${ownerNpub}`}))`;
    const [existing] = await sql`SELECT * FROM hosted_identity_backups WHERE username=${username}`;
    if (!existing) {
      if (expected !== 0n) throw new HostingError(409, 'revision_conflict');
      const [mine] = await sql`SELECT username FROM hosted_identity_backups WHERE owner_npub=${ownerNpub}`;
      if (mine) throw new HostingError(409, 'identity_already_backed_up');
      const [row] = await sql`INSERT INTO hosted_identity_backups(username,owner_npub,ncryptsec,logn) VALUES(${username},${ownerNpub},${ncryptsec},${logn}) RETURNING *`;
      return { ...view(row), created: true };
    }
    // A taken name is the same answer to a creator whoever owns it; only the owner reaches the update path.
    if (existing.owner_npub !== ownerNpub) throw new HostingError(expected === 0n ? 409 : 403, expected === 0n ? 'username_unavailable' : 'backup_owner_mismatch');
    // A lost create response may be retried verbatim by its owner: same ciphertext at revision 1 is the same write.
    if (expected === 0n) { if (existing.ncryptsec === ncryptsec && BigInt(existing.revision) === 1n) return { ...view(existing), created: false }; throw new HostingError(409, 'username_unavailable'); }
    if (existing.ncryptsec === ncryptsec && BigInt(existing.revision) === expected + 1n) return { ...view(existing), created: false };
    if (BigInt(existing.revision) !== expected) { const e: any = new HostingError(409, 'revision_conflict'); e.extra = { current_revision: String(existing.revision) }; throw e; }
    const [row] = await sql`UPDATE hosted_identity_backups SET ncryptsec=${ncryptsec},logn=${logn},revision=revision+1,updated_at=now() WHERE username=${username} RETURNING *`;
    return { ...view(row), created: false };
  });
}

export async function getPublicIdentityBackup(usernameRaw: string, db: Db = getDb()) {
  let username: string;
  try { username = normalizeUsername(usernameRaw); } catch { throw new HostingError(404, 'backup_not_found'); }
  const [row] = await db`SELECT username,ncryptsec,revision,updated_at FROM hosted_identity_backups WHERE username=${username}`;
  if (!row) throw new HostingError(404, 'backup_not_found');
  return { username: row.username as string, ncryptsec: row.ncryptsec as string, revision: String(row.revision), updated_at: new Date(row.updated_at).toISOString() };
}

export async function getOwnIdentityBackup(ownerNpub: string, db: Db = getDb()) {
  const [row] = await db`SELECT username,revision,updated_at FROM hosted_identity_backups WHERE owner_npub=${ownerNpub}`;
  if (!row) throw new HostingError(404, 'backup_not_found');
  return view(row);
}
export async function hasIdentityBackup(ownerNpub: string, db: Db = getDb()) {
  const [row] = await db`SELECT 1 FROM hosted_identity_backups WHERE owner_npub=${ownerNpub}`;
  return Boolean(row);
}

/** Payment gate for intents that declare a brand-new on-device key: a durable hosted ciphertext must exist first. `existing` never gates. */
export async function requireIdentityBackup(intent: { identity_origin?: string }, ownerNpub: string, db: Db = getDb()) {
  if (intent.identity_origin === 'new' && !(await hasIdentityBackup(ownerNpub, db))) throw new HostingError(409, 'identity_backup_required');
}

/** Bounded in-process token buckets. They limit, not eliminate, abuse; each replica counts separately. */
export class Throttle {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number, private maxKeys = 10_000) {}
  /** Returns seconds to wait, or 0 when allowed. */
  take(key: string, now = Date.now()): number {
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (recent.length >= this.limit) { this.hits.set(key, recent); return Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000)); }
    recent.push(now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
    this.hits.set(key, recent);
    return 0;
  }
  reset() { this.hits.clear(); }
}
export const backupThrottles = {
  readIp: new Throttle(30, 60_000), readGlobal: new Throttle(600, 60_000),
  writeIp: new Throttle(20, 60_000), writeOwner: new Throttle(10, 60_000), writeGlobal: new Throttle(300, 60_000),
};
export const clientKey = (forwarded: string | undefined | null) => createHash('sha256').update((forwarded ?? 'unknown').split(',')[0]!.trim()).digest('hex').slice(0, 24);
