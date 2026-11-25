import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { enrollPeakStorage, takeStorageAnchor } from '../src/services/hosting-storage';
import { accountLifecycle } from '../src/services/hosting-lifecycle';
import { openOwnerAccount } from '../src/services/onboarding';
import { accountRecoveryState, configureRecoveryVault, expireRecoveryCopies, removalGate, sealRecoveryCopy, verifyRecoveryRestore } from '../src/services/hosting-recovery';
import { ageIdentityRestore, openAgeRecoveryVault } from '../src/services/hosting-recovery-age-vault';

// Real age CLI, SYNTHETIC identities generated into a throwaway directory. No real recipient, key or path is assumed or searched for.
const AGE = '/opt/homebrew/bin/age', KEYGEN = '/opt/homebrew/bin/age-keygen';
const have = existsSync(AGE) && existsSync(KEYGEN);
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const ws = () => randomUUID();

const sandbox = have ? realpathSync(mkdtempSync(join(tmpdir(), 'age-vault-test-'))) : '';
function identity(label: string) {
  const path = join(sandbox, `${label}.key`);
  const r = spawnSync(KEYGEN, ['-o', path], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('keygen failed');
  return { path, recipient: /age1[a-z0-9]{58}/.exec(readFileSync(path, 'utf8'))![0] };
}
afterAll(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });
const newRoot = (label: string) => { const d = join(sandbox, label); mkdirSync(d, { mode: 0o700 }); chmodSync(d, 0o700); return d; };

describe.skipIf(!have)('age filesystem recovery vault (real age CLI, synthetic identities, temporary storage)', () => {
  const id1 = have ? identity('one') : null!, id2 = have ? identity('two') : null!;
  const open = (root: string, extra: Record<string, unknown> = {}) => openAgeRecoveryVault({ rootDir: root, recipient: id1.recipient, ageBin: AGE, isolatedRestore: ageIdentityRestore({ ageBin: AGE, identityPath: id1.path }), ...extra } as any);
  const data = new TextEncoder().encode('synthetic workspace snapshot '.repeat(40));
  test('seals with real age, stores only ciphertext + immutable manifest, and the isolated restore recovers the exact identity', async () => {
    const root = newRoot('roundtrip'), v = open(root), workspaceId = ws();
    expect(v.provenance).toBe('test');
    const s = await v.seal({ workspaceId, plaintext: data });
    expect(s.objectRef).toMatch(/^agevault:[0-9a-f-]{36}$/);
    expect(s.keyRef).toMatch(/^age-recipient:[0-9a-f]{16}$/);
    const files = readdirSync(root).sort(); const uuid = s.objectRef.slice(9);
    expect(files).toEqual([`${uuid}.age`, `${uuid}.manifest.json`]); // no temp leftovers
    for (const f of files) expect(statSync(join(root, f)).mode & 0o777).toBe(0o400);
    const ct = readFileSync(join(root, `${uuid}.age`));
    expect(ct.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    expect(ct.includes(Buffer.from('synthetic workspace'))).toBe(false);
    expect(sha(ct)).toBe(s.ciphertextSha256); expect(ct.length).toBe(s.ciphertextBytes);
    const manifest = JSON.parse(readFileSync(join(root, `${uuid}.manifest.json`), 'utf8'));
    expect(manifest).toMatchObject({ workspace_id: workspaceId, plaintext_sha256: sha(data), plaintext_bytes: data.length, ciphertext_sha256: s.ciphertextSha256 });
    expect(JSON.stringify(manifest)).not.toContain('AGE-SECRET-KEY'); expect(JSON.stringify(manifest)).not.toContain(id1.recipient);
    // Independent decrypt with the real CLI proves actual encryption, not just our own readback.
    const dec = spawnSync(AGE, ['-d', '-i', id1.path], { input: ct }); expect(sha(dec.stdout)).toBe(sha(data));
    expect(await v.restoreIdentity(s.objectRef)).toEqual({ plaintextSha256: sha(data), plaintextBytes: data.length });
  });

  test('a public recipient alone cannot restore: with no isolated decrypt port it fails closed; the wrong identity decrypts nothing', async () => {
    const root = newRoot('norestore');
    const v = openAgeRecoveryVault({ rootDir: root, recipient: id1.recipient, ageBin: AGE });
    const s = await v.seal({ workspaceId: ws(), plaintext: data });
    await expect(v.restoreIdentity(s.objectRef)).rejects.toMatchObject({ code: 'recovery_restore_unconfigured' });
    const wrong = openAgeRecoveryVault({ rootDir: root, recipient: id1.recipient, ageBin: AGE, isolatedRestore: ageIdentityRestore({ ageBin: AGE, identityPath: id2.path }) });
    await expect(wrong.restoreIdentity(s.objectRef)).rejects.toMatchObject({ code: 'recovery_vault_exec_failed' });
  });

  test('tamper, substitution, symlink and traversal are all refused before any decrypt', async () => {
    const root = newRoot('tamper'), v = open(root);
    const s = await v.seal({ workspaceId: ws(), plaintext: data }); const uuid = s.objectRef.slice(9);
    const ctPath = join(root, `${uuid}.age`), mfPath = join(root, `${uuid}.manifest.json`);
    const goodCt = readFileSync(ctPath), goodMf = readFileSync(mfPath);
    const rewrite = (p: string, b: Buffer) => { chmodSync(p, 0o600); writeFileSync(p, b); chmodSync(p, 0o400); };
    const flipped = Buffer.from(goodCt); flipped[flipped.length - 3]! ^= 1; rewrite(ctPath, flipped);
    await expect(v.restoreIdentity(s.objectRef)).rejects.toMatchObject({ code: 'recovery_object_tampered' });
    rewrite(ctPath, goodCt); expect((await v.restoreIdentity(s.objectRef)).plaintextSha256).toBe(sha(data));
    rewrite(mfPath, Buffer.from(goodMf.toString().replace(/"plaintext_bytes":\d+/, '"plaintext_bytes":1')));
    expect((await v.restoreIdentity(s.objectRef)).plaintextBytes).toBe(data.length); // manifest digests of ciphertext still hold; seam compares plaintext identity itself
    rewrite(mfPath, Buffer.from(goodMf.toString().replace(/"ciphertext_sha256":"[0-9a-f]{64}"/, `"ciphertext_sha256":"${'0'.repeat(64)}"`)));
    await expect(v.restoreIdentity(s.objectRef)).rejects.toMatchObject({ code: 'recovery_object_tampered' });
    rewrite(mfPath, Buffer.from(goodMf.toString().replace('}', ',"extra":1}')));
    await expect(v.restoreIdentity(s.objectRef)).rejects.toMatchObject({ code: 'recovery_object_invalid' });
    rewrite(mfPath, goodMf);
    // Swap the ciphertext for a symlink to a valid-looking file elsewhere.
    const elsewhere = join(sandbox, 'elsewhere.age'); writeFileSync(elsewhere, goodCt);
    unlinkSync(ctPath); symlinkSync(elsewhere, ctPath);
    await expect(v.restoreIdentity(s.objectRef)).rejects.toBeDefined();
    await expect(v.destroy(s.objectRef)).rejects.toMatchObject({ code: 'recovery_object_invalid' });
    expect(existsSync(elsewhere)).toBe(true); // never followed or removed through the link
    unlinkSync(ctPath);
    for (const bad of ['agevault:../etc/passwd', `agevault:${uuid}/../../x`, 'agevault:', `../${uuid}`, `agevault:${'a'.repeat(36)}x`, 'fixture://x', '']) {
      await expect(v.restoreIdentity(bad)).rejects.toMatchObject({ code: 'recovery_object_invalid' });
      await expect(v.destroy(bad)).rejects.toMatchObject({ code: 'recovery_object_invalid' });
    }
    await expect(v.restoreIdentity(`agevault:${randomUUID()}`)).rejects.toMatchObject({ code: 'recovery_object_missing' });
  });

  test('destroy is idempotent and removes exactly that object; bounds on bytes and count hold; a failed seal leaves nothing behind', async () => {
    const root = newRoot('bounds'), v = open(root, { maxObjects: 2, maxPlaintextBytes: 100 });
    const a = await v.seal({ workspaceId: ws(), plaintext: new Uint8Array(50).fill(1) }), b = await v.seal({ workspaceId: ws(), plaintext: new Uint8Array(50).fill(2) });
    await expect(v.seal({ workspaceId: ws(), plaintext: new Uint8Array(50) })).rejects.toMatchObject({ code: 'recovery_vault_full' });
    await expect(v.seal({ workspaceId: ws(), plaintext: new Uint8Array(101) })).rejects.toMatchObject({ code: 'recovery_vault_input_invalid' });
    await expect(v.seal({ workspaceId: ws(), plaintext: new Uint8Array(0) })).rejects.toMatchObject({ code: 'recovery_vault_input_invalid' });
    await expect(v.seal({ workspaceId: 'not-a-uuid', plaintext: new Uint8Array(5) })).rejects.toMatchObject({ code: 'recovery_vault_input_invalid' });
    await v.destroy(a.objectRef); await v.destroy(a.objectRef);
    expect(readdirSync(root).length).toBe(2); expect(v.objectCount()).toBe(1);
    expect((await v.restoreIdentity(b.objectRef)).plaintextBytes).toBe(50);
    await expect(v.restoreIdentity(a.objectRef)).rejects.toMatchObject({ code: 'recovery_object_missing' });
    // age failing (never produces ciphertext) leaves no file.
    const broken = openAgeRecoveryVault({ rootDir: newRoot('broken'), recipient: id1.recipient, ageBin: '/usr/bin/false' });
    await expect(broken.seal({ workspaceId: ws(), plaintext: data })).rejects.toMatchObject({ code: 'recovery_vault_exec_failed' });
    expect(broken.objectCount()).toBe(0);
  });

  test('a hung age process is killed at the timeout', async () => {
    const script = join(sandbox, 'hang.sh'); writeFileSync(script, '#!/bin/sh\nsleep 30\n'); chmodSync(script, 0o700);
    const v = openAgeRecoveryVault({ rootDir: newRoot('hang'), recipient: id1.recipient, ageBin: script, timeoutMs: 1000 });
    const t = Date.now();
    await expect(v.seal({ workspaceId: ws(), plaintext: data })).rejects.toMatchObject({ code: 'recovery_vault_timeout' });
    expect(Date.now() - t).toBeLessThan(5000); expect(v.objectCount()).toBe(0);
  });

  test('unsafe trusted configuration is refused: private identities, relative or symlinked or world-readable roots, roots inside the runtime, bad binary', () => {
    const ok = { rootDir: newRoot('cfg'), recipient: id1.recipient, ageBin: AGE };
    expect(() => openAgeRecoveryVault(ok)).not.toThrow();
    const secret = readFileSync(id1.path, 'utf8').split('\n').find(l => l.startsWith('AGE-SECRET-KEY-'))!;
    const codes = (o: any) => { try { openAgeRecoveryVault(o); return 'accepted'; } catch (e: any) { return e.code; } };
    expect(codes({ ...ok, recipient: secret })).toBe('recovery_vault_config_invalid');
    expect(codes({ ...ok, recipient: 'age1short' })).toBe('recovery_vault_config_invalid');
    expect(codes({ ...ok, rootDir: 'relative/dir' })).toBe('recovery_vault_config_invalid');
    expect(codes({ ...ok, rootDir: `${ok.rootDir}/../cfg` })).toBe('recovery_vault_config_invalid');
    const link = join(sandbox, 'link'); symlinkSync(ok.rootDir, link);
    expect(codes({ ...ok, rootDir: link })).toBe('recovery_vault_config_invalid');
    const open755 = join(sandbox, 'open'); mkdirSync(open755); chmodSync(open755, 0o755);
    expect(codes({ ...ok, rootDir: open755 })).toBe('recovery_vault_config_invalid');
    expect(codes({ ...ok, rootDir: join(sandbox, 'missing') })).toBe('recovery_vault_config_invalid');
    expect(codes({ ...ok, forbiddenRoots: [sandbox] })).toBe('recovery_vault_config_invalid'); // inside agent/runtime data
    expect(codes({ ...ok, rootDir: process.cwd() })).toBe('recovery_vault_config_invalid');
    expect(codes({ ...ok, ageBin: 'age' })).toBe('recovery_vault_config_invalid');
    expect(codes({ ...ok, ageBin: join(sandbox, 'nope') })).toBe('recovery_vault_config_invalid');
  });
});

// Runs only against a dedicated disposable PostgreSQL: RECOVERY_TEST_PORT=<free port>.
const port = Number(process.env.RECOVERY_TEST_PORT);
const HOUR = 3_600_000, DAY = 24 * HOUR;
const npub = nip19.npubEncode(getPublicKey(randomBytes(32)));
describe.skipIf(!have || !port || port === 5432)('age vault under the existing recovery seam on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_agevault_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>, account: string, workspace: string;
  const manifest = () => ({ workspace_id: workspace, taken_at: new Date().toISOString(), includes: ['postgres rows'], excludes: ['git repositories'] });
  const plaintext = new TextEncoder().encode('synthetic snapshot for the seam');
  const idr = have ? identity('seam') : null!;

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

  test('encrypt-only vault: seals, but without an isolated decrypt it can never reach restore_verified; with one it is verified yet still never promised and the gate stays closed', async () => {
    const root = newRoot('seam');
    configureRecoveryVault(openAgeRecoveryVault({ rootDir: root, recipient: idr.recipient, ageBin: AGE }));
    const copy = await sealRecoveryCopy({ workspaceId: workspace, manifest: manifest(), plaintext }, new Date(), db as any);
    expect(copy).toMatchObject({ state: 'sealed', provenance: 'test' });
    expect(copy.object_ref).toMatch(/^agevault:/); expect(copy.key_ref).toMatch(/^age-recipient:/);
    await expect(verifyRecoveryRestore(copy.id, new Date(), db as any)).rejects.toMatchObject({ code: 'recovery_restore_unavailable' });
    expect((await db`SELECT state FROM hosting_recovery_copies WHERE id=${copy.id}`)[0]!.state).toBe('sealed');
    configureRecoveryVault(openAgeRecoveryVault({ rootDir: root, recipient: idr.recipient, ageBin: AGE, isolatedRestore: ageIdentityRestore({ ageBin: AGE, identityPath: idr.path }) }));
    expect((await verifyRecoveryRestore(copy.id, new Date(), db as any)).state).toBe('restore_verified');
    expect(await accountRecoveryState(db as any, account)).toMatchObject({ available: true, verified: true, promised: false });
    await db`UPDATE hosting_accounts SET paid_units=0,promo_units=0,depleted_at=${new Date(Date.now() - 31 * DAY)} WHERE id=${account}`;
    expect(await removalGate(workspace, new Date(), db as any)).toEqual({ allowed: false, reasons: ['no_verified_recovery_copy', 'recovery_snapshot_unverified'] });
    await db`UPDATE hosting_accounts SET depleted_at=NULL WHERE id=${account}`;
  });

  test('a restore of different bytes marks the copy failed, and expiry destroys the real encrypted files', async () => {
    const root = newRoot('seam2');
    const mk = (restore: any) => openAgeRecoveryVault({ rootDir: root, recipient: idr.recipient, ageBin: AGE, isolatedRestore: restore });
    configureRecoveryVault(mk(ageIdentityRestore({ ageBin: AGE, identityPath: idr.path })));
    // Producer sealed bytes A in the record but the stored ciphertext holds B (swapped before sealing): identity mismatch.
    const copy = await sealRecoveryCopy({ workspaceId: workspace, manifest: manifest(), plaintext }, new Date(), db as any);
    configureRecoveryVault(mk(async () => ({ plaintextSha256: sha('other'), plaintextBytes: 5 })));
    expect((await verifyRecoveryRestore(copy.id, new Date(), db as any)).state).toBe('failed');
    const fresh = await sealRecoveryCopy({ workspaceId: workspace, manifest: manifest(), plaintext }, new Date(), db as any);
    const uuid = fresh.object_ref.slice(9);
    expect(existsSync(join(root, `${uuid}.age`))).toBe(true);
    expect(await expireRecoveryCopies(new Date(Date.now() + 31 * DAY), db as any)).toEqual({ expired: 3 }); // the verified copy from the previous test, the failed copy and the fresh one
    expect(readdirSync(root)).toEqual([]); // the failed copy's ciphertext is destroyed too
    expect((await db`SELECT state FROM hosting_recovery_copies WHERE id=${copy.id}`)[0]!.state).toBe('failed');
    expect(await expireRecoveryCopies(new Date(Date.now() + 32 * DAY), db as any)).toEqual({ expired: 0 });
    expect((await db`SELECT state FROM hosting_recovery_copies WHERE id=${fresh.id}`)[0]!.state).toBe('expired');
  });
});
