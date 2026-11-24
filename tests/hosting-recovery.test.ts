import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { enrollPeakStorage, takeStorageAnchor } from '../src/services/hosting-storage';
import { accountLifecycle } from '../src/services/hosting-lifecycle';
import { openOwnerAccount } from '../src/services/onboarding';
import { RECOVERY_COPY_DAYS, accountRecoveryState, configureRecoveryVault, expireRecoveryCopies, removalGate, sealRecoveryCopy, verifyRecoveryRestore, type RecoveryManifest, type RecoveryVault } from '../src/services/hosting-recovery';

// Runs only against a dedicated disposable PostgreSQL: RECOVERY_TEST_PORT=<free port>.
const port = Number(process.env.RECOVERY_TEST_PORT);
const HOUR = 3_600_000, DAY = 24 * HOUR;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const npub = nip19.npubEncode(getPublicKey(randomBytes(32)));

/** In-memory double. It "encrypts" nothing: it exists to drive the state machine. Clearly a fixture, never a vault. */
class FixtureVault implements RecoveryVault {
  store = new Map<string, Uint8Array>(); destroyed: string[] = []; corrupt = false; down = false; destroyFails = false;
  constructor(public provenance: 'production' | 'test') {}
  async seal({ plaintext }: { workspaceId: string; plaintext: Uint8Array }) {
    const objectRef = `fixture://${randomUUID()}`; this.store.set(objectRef, plaintext);
    return { objectRef, keyRef: `key-ref-${objectRef.slice(-6)}`, ciphertextSha256: sha(`ct:${sha(plaintext)}`), ciphertextBytes: plaintext.byteLength + 28 };
  }
  async restoreIdentity(objectRef: string) {
    if (this.down) throw new Error('vault down');
    const bytes = this.store.get(objectRef); if (!bytes) throw new Error('gone');
    const got = this.corrupt ? new Uint8Array([...bytes.slice(0, -1), bytes[bytes.length - 1]! ^ 1]) : bytes;
    return { plaintextSha256: sha(got), plaintextBytes: got.byteLength };
  }
  async destroy(objectRef: string) { if (this.destroyFails) throw new Error('cannot destroy'); this.store.delete(objectRef); this.destroyed.push(objectRef); }
}

describe.skipIf(!port || port === 5432)('offline recovery seam on disposable PostgreSQL (fixture vault only)', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_recovery_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>, account: string, workspace: string;
  const manifest = (): RecoveryManifest => ({ workspace_id: workspace, taken_at: new Date().toISOString(), includes: ['postgres rows', 'objects'], excludes: ['git repositories'] });
  const plaintext = new TextEncoder().encode('workspace snapshot bytes');
  const lifecycle = (now?: Date) => accountLifecycle(db as any, account, now);
  const liveRows = async () => (await db`SELECT (SELECT count(*) FROM flightdeck_pg_workspaces)::int AS w,(SELECT count(*) FROM flightdeck_pg_workspace_memberships)::int AS m,(SELECT count(*) FROM hosting_ledger)::int AS l`)[0];

  beforeAll(async () => {
    process.env.ONBOARDING_ENABLED = 'true';
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    const [actor] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING id` as any;
    account = (await openOwnerAccount(npub, db as any)).account_id;
    workspace = randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${workspace},'tower',${workspace},${npub},'recovery-fixture','Recovery')`;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace},${actor.id},'owner')`;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${workspace},${account})`;
    await enrollPeakStorage(db as any, workspace, account, null);
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    await db`UPDATE hosting_storage_enrollments SET activated_at=${new Date(hour - 60 * DAY)},intro_ends_at=${new Date(hour - 30 * DAY)} WHERE workspace_id=${workspace}`;
    await takeStorageAnchor(workspace, db as any);
  });
  afterAll(async () => { configureRecoveryVault(null); delete process.env.ONBOARDING_ENABLED; await closeDb(); const root = postgres({ ...conn, database: 'postgres' }); await root.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await root.end(); });

  test('unconfigured: nothing seals, nothing is promised, and the lifecycle says so', async () => {
    configureRecoveryVault(null);
    await expect(sealRecoveryCopy({ workspaceId: workspace, manifest: manifest(), plaintext }, new Date(), db as any)).rejects.toMatchObject({ code: 'recovery_vault_unconfigured', status: 503 });
    await expect(verifyRecoveryRestore(randomUUID(), new Date(), db as any)).rejects.toMatchObject({ code: 'recovery_vault_unconfigured' });
    expect((await lifecycle()).offline_recovery).toMatchObject({ available: false, verified: false, promised: false, expires_at: null });
    expect(await removalGate(workspace, new Date(), db as any)).toMatchObject({ allowed: false, reasons: expect.arrayContaining(['no_verified_recovery_copy']) });
    expect((await db`SELECT 1 FROM hosting_recovery_copies`).length).toBe(0);
  });

  test('a test-vault copy can be sealed and verified but never promises recoverability or opens the removal gate', async () => {
    const vault = new FixtureVault('test'); configureRecoveryVault(vault);
    const before = await liveRows();
    const copy = await sealRecoveryCopy({ workspaceId: workspace, manifest: manifest(), plaintext }, new Date(), db as any);
    expect(copy).toMatchObject({ state: 'sealed', provenance: 'test', plaintext_sha256: sha(plaintext), });
    expect(Number(copy.plaintext_bytes)).toBe(plaintext.byteLength);
    expect(new Date(copy.expires_at).getTime() - new Date(copy.sealed_at).getTime()).toBe(RECOVERY_COPY_DAYS * DAY);
    expect((await lifecycle()).offline_recovery).toMatchObject({ available: true, verified: false, promised: false });
    expect((await verifyRecoveryRestore(copy.id, new Date(), db as any)).state).toBe('restore_verified');
    expect((await lifecycle()).offline_recovery).toMatchObject({ available: true, verified: true, promised: false });
    await db`UPDATE hosting_accounts SET paid_units=0,promo_units=0,depleted_at=${new Date(Date.now() - 31 * DAY)} WHERE id=${account}`;
    expect((await lifecycle()).state).toBe('removal_due');
    expect(await removalGate(workspace, new Date(), db as any)).toEqual({ allowed: false, reasons: ['no_verified_recovery_copy'] });
    expect(await liveRows()).toEqual(before); // sealing and verifying touched no live data
    await db`UPDATE hosting_accounts SET depleted_at=NULL WHERE id=${account}`;
  });

  test('a production-vault copy that passes an isolated restore is promised until expiry; the removal gate needs both conditions', async () => {
    const vault = new FixtureVault('production'); configureRecoveryVault(vault);
    const copy = await sealRecoveryCopy({ workspaceId: workspace, manifest: manifest(), plaintext }, new Date(), db as any);
    expect((await lifecycle()).offline_recovery.promised).toBe(false); // sealed is not verified
    // Gate: neither condition holds, then only the copy, then both.
    expect((await removalGate(workspace, new Date(), db as any)).reasons).toEqual(['read_only_period_not_ended', 'no_verified_recovery_copy']);
    await verifyRecoveryRestore(copy.id, new Date(), db as any);
    expect((await lifecycle()).offline_recovery).toMatchObject({ available: true, verified: true, promised: true });
    expect(await removalGate(workspace, new Date(), db as any)).toEqual({ allowed: false, reasons: ['read_only_period_not_ended'] });
    await db`UPDATE hosting_accounts SET paid_units=0,promo_units=0,depleted_at=${new Date(Date.now() - 31 * DAY)} WHERE id=${account}`;
    expect(await removalGate(workspace, new Date(), db as any)).toEqual({ allowed: true, reasons: [] });
    // Another workspace's copy never opens this workspace's gate.
    const other = randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${other},'tower',${other},${npub},'recovery-fixture','Other')`;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${other},${account})`;
    expect((await removalGate(other, new Date(), db as any)).reasons).toContain('no_verified_recovery_copy');
    // A vault of the wrong provenance cannot vouch for a copy it did not seal.
    configureRecoveryVault(new FixtureVault('test'));
    await expect(verifyRecoveryRestore(copy.id, new Date(), db as any)).rejects.toMatchObject({ code: 'recovery_vault_mismatch' });
    configureRecoveryVault(vault);
    // Expiry: after 30 days the copy is destroyed, no longer promised, and the gate closes again.
    const later = new Date(Date.now() + 31 * DAY);
    expect((await accountRecoveryState(db as any, account, later)).promised).toBe(false);
    expect((await removalGate(workspace, later, db as any)).allowed).toBe(false);
    vault.destroyFails = true;
    expect(await expireRecoveryCopies(later, db as any)).toEqual({ expired: 0 }); // destruction failed: not marked expired, retried next run
    expect((await db`SELECT state FROM hosting_recovery_copies WHERE id=${copy.id}`)[0]!.state).toBe('restore_verified');
    vault.destroyFails = false;
    expect(await expireRecoveryCopies(later, db as any)).toEqual({ expired: expect.any(Number) });
    expect((await db`SELECT state,expired_at FROM hosting_recovery_copies WHERE id=${copy.id}`)[0]).toMatchObject({ state: 'expired' });
    expect(vault.destroyed).toContain(copy.object_ref);
    await expect(verifyRecoveryRestore(copy.id, later, db as any)).rejects.toMatchObject({ code: 'recovery_copy_not_verifiable' });
    await db`UPDATE hosting_accounts SET depleted_at=NULL WHERE id=${account}`;
  });

  test('a restore that recovers different bytes marks the copy failed forever; an unreachable vault changes nothing', async () => {
    const vault = new FixtureVault('production'); configureRecoveryVault(vault);
    const flaky = await sealRecoveryCopy({ workspaceId: workspace, manifest: manifest(), plaintext }, new Date(), db as any);
    vault.down = true;
    await expect(verifyRecoveryRestore(flaky.id, new Date(), db as any)).rejects.toMatchObject({ code: 'recovery_restore_unavailable', status: 502 });
    expect((await db`SELECT state FROM hosting_recovery_copies WHERE id=${flaky.id}`)[0]!.state).toBe('sealed');
    vault.down = false; vault.corrupt = true;
    const bad = await verifyRecoveryRestore(flaky.id, new Date(), db as any);
    expect(bad).toMatchObject({ state: 'failed', failure: 'restored_identity_mismatch' });
    vault.corrupt = false;
    await expect(verifyRecoveryRestore(flaky.id, new Date(), db as any)).rejects.toMatchObject({ code: 'recovery_copy_not_verifiable' });
    await expect(db`UPDATE hosting_recovery_copies SET state='restore_verified',restore_verified_at=now() WHERE id=${flaky.id}`).rejects.toThrow(); // final
    expect((await accountRecoveryState(db as any, account)).promised).toBe(false);
  });

  test('inputs and identity are guarded: bad manifests, empty or foreign workspaces, immutable rows, append-only events', async () => {
    configureRecoveryVault(new FixtureVault('production'));
    for (const bad of [{ ...manifest(), workspace_id: randomUUID() }, { ...manifest(), taken_at: 'yesterday' }, { ...manifest(), includes: 'all' as any }, { ...manifest(), excludes: [5 as any] }])
      await expect(sealRecoveryCopy({ workspaceId: workspace, manifest: bad as any, plaintext }, new Date(), db as any)).rejects.toMatchObject({ code: 'invalid_recovery_manifest' });
    await expect(sealRecoveryCopy({ workspaceId: workspace, manifest: manifest(), plaintext: new Uint8Array() }, new Date(), db as any)).rejects.toMatchObject({ code: 'invalid_recovery_source' });
    const stranger = randomUUID();
    await expect(sealRecoveryCopy({ workspaceId: stranger, manifest: { ...manifest(), workspace_id: stranger }, plaintext }, new Date(), db as any)).rejects.toMatchObject({ status: 404 });
    const [copy] = await db`SELECT * FROM hosting_recovery_copies LIMIT 1`;
    await expect(db`UPDATE hosting_recovery_copies SET object_ref='elsewhere' WHERE id=${copy!.id}`).rejects.toThrow();
    await expect(db`UPDATE hosting_recovery_copies SET expires_at=expires_at+interval '365 days' WHERE id=${copy!.id}`).rejects.toThrow();
    await expect(db`DELETE FROM hosting_recovery_copies WHERE id=${copy!.id}`).rejects.toThrow();
    await expect(db`UPDATE hosting_recovery_events SET kind='sealed'`).rejects.toThrow();
    await expect(db`DELETE FROM hosting_recovery_events`).rejects.toThrow();
    expect((await db`SELECT count(*)::int AS n FROM hosting_recovery_events WHERE kind='sealed'`)[0]!.n).toBeGreaterThan(0);
    // The manifest is stored verbatim as the producer's statement; it never changes what is promised.
    expect(JSON.stringify((await db`SELECT manifest FROM hosting_recovery_copies WHERE id=${copy!.id}`)[0]!.manifest)).toContain('git repositories');
  });
});
