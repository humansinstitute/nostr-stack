import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { bech32 } from '@scure/base';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import * as nip49 from 'nostr-tools/nip49';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { buildOpenApiDocument } from '../src/openapi';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { Throttle, backupThrottles, normalizeUsername, putIdentityBackup, validateNcryptsec } from '../src/services/hosted-identity-backup';
import { createIntent, createInvite } from '../src/services/onboarding';
import { configureLightningProvider } from '../src/services/hosting-lightning';

// Runs only against a dedicated disposable PostgreSQL: BACKUP_TEST_PORT=<free port>.
const port = Number(process.env.BACKUP_TEST_PORT);
const app = createApp();
const sk = () => generateSecretKey();
const pub = (k: Uint8Array) => nip19.npubEncode(getPublicKey(k));
const seal = (logn = 16, ksb = 2) => nip49.encrypt(sk(), 'correct horse battery staple', logn, ksb as any);
const forge = (mutate: (b: Uint8Array) => void) => { const b = new Uint8Array(bech32.fromWords(bech32.decode(seal() as any, 5000).words)); mutate(b); return bech32.encode('ncryptsec', bech32.toWords(b), 5000); };

describe('ncryptsec and username validation', () => {
  test('accepts real NIP-49 output at logN 16-18 and every security byte', () => {
    for (const logn of [16, 17, 18]) expect(validateNcryptsec(seal(logn)).logn).toBe(logn);
    for (const ksb of [0, 1, 2]) validateNcryptsec(seal(16, ksb));
    expect(seal().length).toBe(162);
  });
  test('refuses wrong shape, length, case, header, version, cost and security byte', () => {
    const good = seal();
    for (const v of [undefined, 5, '', good.slice(0, 161), `${good}a`, good.toUpperCase(), good.replace('ncryptsec1', 'ncryptseb1'), `${good.slice(0, 161)}b`, 'a'.repeat(5_000_000)])
      expect(() => validateNcryptsec(v)).toThrow();
    expect(() => validateNcryptsec(forge(b => { b[0] = 1; }))).toThrow();
    expect(() => validateNcryptsec(forge(b => { b[1] = 15; }))).toThrow();
    expect(() => validateNcryptsec(forge(b => { b[1] = 19; }))).toThrow();
    expect(() => validateNcryptsec(forge(b => { b[42] = 3; }))).toThrow();
    // Checksum failure (one character changed) never reaches the header checks.
    const flipped = good.slice(0, 20) + (good[20] === 'q' ? 'p' : 'q') + good.slice(21);
    expect(() => validateNcryptsec(flipped)).toThrow();
  });
  test('usernames are NFKC-lowercase ASCII only, conservatively reserved', () => {
    expect(normalizeUsername('Alice_01')).toBe('alice_01');
    expect(normalizeUsername('ＡＬＩＣＥ')).toBe('alice'); // full-width compatibility forms fold
    for (const bad of ['', 'ab', 'a'.repeat(33), '-alice', 'alice-', 'al ice', 'alice!', 'аlice', 'ａdmin', 'Admin', 'wingman', 'ali\u0000ce', 'ß-name', 5 as any, undefined as any])
      expect(() => normalizeUsername(bad)).toThrow();
  });
  test('throttle bounds a key and a table size', () => {
    const t = new Throttle(2, 1000, 3);
    expect([t.take('a', 0), t.take('a', 1), t.take('a', 2)].map(Boolean)).toEqual([false, false, true]);
    expect(t.take('a', 1001)).toBe(0);
    for (const k of ['b', 'c', 'd', 'e']) t.take(k, 5);
    expect(t.take('a', 6)).toBe(0); // evicted under key pressure rather than growing without bound
  });
});

describe.skipIf(!port || port === 5432)('hosted identity backup on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_backup_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  const saved = { admin: config.adminNpub };
  const adminKey = sk(), admin = pub(adminKey);
  const url = (u: string) => `http://localhost/api/v4/identity-backup${u}`;
  async function call(method: 'GET' | 'PUT', path: string, signer?: Uint8Array, body?: unknown, ip = '203.0.113.7') {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { 'x-forwarded-for': ip };
    if (signer) headers.Authorization = `Nostr ${Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(), tags: [['u', url(path)], ['method', method], ...(raw ? [['payload', createHash('sha256').update(raw).digest('hex')]] : [])] }, signer))).toString('base64')}`;
    const response = await app.request(url(path), { method, headers, body: raw });
    return { status: response.status, headers: response.headers, json: (await response.json().catch(() => ({}))) as any };
  }
  const uniq = () => `user-${randomBytes(4).toString('hex')}`;
  beforeAll(async () => {
    process.env.ONBOARDING_ENABLED = 'true';
    process.env.HOSTING_LIGHTNING_ENABLED = 'true';
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    config.adminNpub = admin;
  });
  beforeEach(() => { for (const t of Object.values(backupThrottles)) t.reset(); });
  afterAll(async () => {
    config.adminNpub = saved.admin; delete process.env.ONBOARDING_ENABLED; delete process.env.HOSTING_LIGHTNING_ENABLED; configureLightningProvider(null);
    await closeDb(); const root = postgres({ ...conn, database: 'postgres' }); await root.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await root.end();
  });

  test('owner-signed create, public ciphertext-only read, /me, CAS update and idempotent retry', async () => {
    const key = sk(), owner = pub(key), username = uniq(), blob = seal();
    expect((await call('PUT', `/${username}`, undefined, { ncryptsec: blob, expected_revision: '0' })).status).toBe(401);
    const created = await call('PUT', `/${username}`, key, { ncryptsec: blob, expected_revision: '0' });
    expect(created.status).toBe(201); expect(created.json).toMatchObject({ username, revision: '1', created: true });
    // Lost-response retry of the very same create is the same write, not a conflict.
    const retry = await call('PUT', `/${username}`, key, { ncryptsec: blob, expected_revision: '0' });
    expect(retry.status).toBe(200); expect(retry.json).toMatchObject({ revision: '1', created: false });
    // Public read: ciphertext and revision only, never an npub, case-insensitive on the name.
    const read = await call('GET', `/${username.toUpperCase()}`);
    expect(read.status).toBe(200); expect(read.json).toMatchObject({ username, ncryptsec: blob, revision: '1' });
    expect(JSON.stringify(read.json)).not.toContain(owner); expect(Object.keys(read.json).sort()).toEqual(['ncryptsec', 'revision', 'updated_at', 'username']);
    expect((await call('GET', '/me', key)).json).toMatchObject({ username, revision: '1' });
    expect((await call('GET', '/me')).status).toBe(401);
    expect((await call('GET', '/me', sk())).status).toBe(404);
    // Compare-and-swap.
    const next = seal(17);
    const stale = await call('PUT', `/${username}`, key, { ncryptsec: next, expected_revision: '5' });
    expect(stale.status).toBe(409); expect(stale.json).toMatchObject({ code: 'revision_conflict', current_revision: '1' });
    expect((await call('PUT', `/${username}`, key, { ncryptsec: next, expected_revision: '0' })).json.code).toBe('username_unavailable');
    const updated = await call('PUT', `/${username}`, key, { ncryptsec: next, expected_revision: '1' });
    expect(updated.status).toBe(200); expect(updated.json).toMatchObject({ revision: '2', created: false });
    expect((await call('PUT', `/${username}`, key, { ncryptsec: next, expected_revision: '1' })).json.revision).toBe('2'); // verbatim retry, no third revision
    expect((await call('GET', `/${username}`)).json.ncryptsec).toBe(next);
    // Exact bodies only.
    expect((await call('PUT', `/${username}`, key, { ncryptsec: next, expected_revision: '2', extra: 1 })).json.code).toBe('invalid_body');
    expect((await call('PUT', `/${username}`, key, { ncryptsec: next, expected_revision: 2 })).json.code).toBe('invalid_body');
    expect((await call('PUT', `/${username}`, key, { ncryptsec: 'ncryptsec1' + 'q'.repeat(100), expected_revision: '2' })).json.code).toBe('invalid_backup');
  });

  test('first claim wins, one username per key, no takeover, no rename, no delete', async () => {
    const a = sk(), b = sk(), username = uniq();
    expect((await call('PUT', `/${username}`, a, { ncryptsec: seal(), expected_revision: '0' })).status).toBe(201);
    // Another key can neither claim the name nor overwrite it; both look like unavailable / mismatch, never a write.
    expect((await call('PUT', `/${username.toUpperCase()}`, b, { ncryptsec: seal(), expected_revision: '0' })).json.code).toBe('username_unavailable');
    expect((await call('PUT', `/${username}`, b, { ncryptsec: seal(), expected_revision: '1' })).json.code).toBe('backup_owner_mismatch');
    expect((await call('GET', `/${username}`)).json.revision).toBe('1');
    // One backup per npub: a second name for the same key is refused.
    expect((await call('PUT', `/${uniq()}`, a, { ncryptsec: seal(), expected_revision: '0' })).json.code).toBe('identity_already_backed_up');
    // Database guard: ownership is immutable and rows are never deleted or skipped ahead.
    await expect(db`UPDATE hosted_identity_backups SET username=${uniq()} WHERE username=${username}`).rejects.toThrow();
    await expect(db`UPDATE hosted_identity_backups SET owner_npub=${pub(b)} WHERE username=${username}`).rejects.toThrow();
    await expect(db`UPDATE hosted_identity_backups SET revision=7 WHERE username=${username}`).rejects.toThrow();
    await expect(db`DELETE FROM hosted_identity_backups WHERE username=${username}`).rejects.toThrow();
  });

  test('concurrent claims: one winner per name and one name per key', async () => {
    const name1 = uniq();
    const keys = Array.from({ length: 6 }, sk);
    const race = await Promise.allSettled(keys.map(k => putIdentityBackup(pub(k), name1, { ncryptsec: seal(), expected_revision: '0' }, db as any)));
    expect(race.filter(r => r.status === 'fulfilled').length).toBe(1);
    expect(race.filter(r => r.status === 'rejected').every(r => (r as PromiseRejectedResult).reason.code === 'username_unavailable')).toBe(true);
    const k = sk();
    const names = [uniq(), uniq(), uniq(), uniq()];
    const same = await Promise.allSettled(names.map(n => putIdentityBackup(pub(k), n, { ncryptsec: seal(), expected_revision: '0' }, db as any)));
    expect(same.filter(r => r.status === 'fulfilled').length).toBe(1);
    expect((await db`SELECT 1 FROM hosted_identity_backups WHERE owner_npub=${pub(k)}`).length).toBe(1);
  });

  test('uniform bounded errors and throttles; invalid names read as not found', async () => {
    const missing = await call('GET', '/nobody-here'), bad = await call('GET', '/%00%00');
    expect(missing.status).toBe(404); expect(bad.status).toBe(404);
    expect(missing.json).toEqual(bad.json);
    // Forwarded headers are client-controlled and ignored by default: rotating them never escapes the (shared, conservative) transport-peer bucket.
    let limited = 0, last: any;
    for (let i = 0; i < 40; i++) { last = await call('GET', '/nobody-here', undefined, undefined, `198.51.100.${i + 1}`); if (last.status === 429) limited++; }
    expect(limited).toBeGreaterThan(0); expect(last.headers.get('retry-after')).toBeTruthy(); expect(last.json.code).toBe('rate_limited');
    expect((await call('GET', '/nobody-here', undefined, undefined, '203.0.113.200')).status).toBe(429);
    for (const t of Object.values(backupThrottles)) t.reset();
    // Behind an explicitly trusted proxy only the entry that proxy wrote counts: forged leftmost entries are noise, a different peer has its own bucket.
    process.env.NSTACK_TRUSTED_PROXY_HOPS = '1';
    try {
      let proxied = 0;
      for (let i = 0; i < 40; i++) { const r = await call('GET', '/nobody-here', undefined, undefined, `10.0.0.${i}, 192.0.2.77`); if (r.status === 429) proxied++; }
      expect(proxied).toBeGreaterThan(0);
      expect((await call('GET', '/nobody-here', undefined, undefined, '10.9.9.9, 192.0.2.78')).status).toBe(404);
      expect((await call('GET', '/nobody-here', undefined, undefined, '10.9.9.9, 192.0.2.77')).status).toBe(429);
    } finally { delete process.env.NSTACK_TRUSTED_PROXY_HOPS; }
    for (const t of Object.values(backupThrottles)) t.reset();
    const key = sk(); let writes429 = 0;
    for (let i = 0; i < 14; i++) { const r = await call('PUT', `/${uniq()}`, key, { ncryptsec: 'x', expected_revision: '0' }, '192.0.2.5'); if (r.status === 429) writes429++; }
    expect(writes429).toBeGreaterThan(0);
  });

  test('new-key onboarding payment is gated on a durable hosted backup; existing keys are unaffected', async () => {
    const invite = await createInvite({ max_admissions: 10 }, admin, db as any);
    const { checkout } = await import('../src/services/onboarding').then(m => ({ checkout: m.intentForCheckout }));
    const newKey = sk(), oldKey = sk(), newer = pub(newKey), old = pub(oldKey);
    const fresh = (await createIntent(newer, { client_request_key: 'req-new-00001', invite_code: invite.code, workspace_name: 'Fresh', funding_cents: 2100, identity_origin: 'new' }, db as any)).intent;
    const legacy = (await createIntent(old, { client_request_key: 'req-old-00001', invite_code: invite.code, workspace_name: 'Legacy', funding_cents: 2100 }, db as any)).intent;
    expect(fresh.identity_origin).toBe('new'); expect(legacy.identity_origin).toBe('existing');
    // Idempotent intent replay with the same declaration; a different one conflicts.
    expect((await createIntent(newer, { client_request_key: 'req-new-00001', invite_code: invite.code, workspace_name: 'Fresh', funding_cents: 2100, identity_origin: 'new' }, db as any)).replayed).toBe(true);
    await expect(createIntent(newer, { client_request_key: 'req-new-00001', invite_code: invite.code, workspace_name: 'Fresh', funding_cents: 2100 }, db as any)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(createIntent(newer, { client_request_key: 'req-bad-00001', invite_code: invite.code, workspace_name: 'X', funding_cents: 2100, identity_origin: 'maybe' }, db as any)).rejects.toMatchObject({ code: 'invalid_identity_origin' });
    await expect(checkout(fresh.id, newer, db as any)).rejects.toMatchObject({ code: 'identity_backup_required', status: 409 });
    configureLightningProvider({ id: 'fixture', payeeRef: 'p', issueInvoice: async () => { throw new Error('provider must not be reached before the backup exists'); }, lookupInvoice: async () => { throw new Error('unused'); } } as any);
    const { issueLightningQuote } = await import('../src/services/hosting-lightning');
    await expect(issueLightningQuote(fresh.id, newer, { idempotency_key: 'quote-key-0001' }, db as any)).rejects.toMatchObject({ code: 'identity_backup_required' });
    expect((await db`SELECT 1 FROM hosting_lightning_quotes WHERE intent_id=${fresh.id}`).length).toBe(0);
    expect((await checkout(legacy.id, old, db as any)).intentId).toBe(legacy.id);
    // Another key's backup does not satisfy the gate.
    await putIdentityBackup(old, uniq(), { ncryptsec: seal(), expected_revision: '0' }, db as any);
    await expect(checkout(fresh.id, newer, db as any)).rejects.toMatchObject({ code: 'identity_backup_required' });
    await putIdentityBackup(newer, uniq(), { ncryptsec: seal(), expected_revision: '0' }, db as any);
    expect((await checkout(fresh.id, newer, db as any)).intentId).toBe(fresh.id);
  });

  test('OpenAPI documents the routes, and nothing else reveals an npub', async () => {
    const doc = buildOpenApiDocument('http://localhost') as any;
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/v4/identity-backup/{username}', '/api/v4/identity-backup/me']));
    expect(doc.components.schemas.IdentityBackupPublic.properties).not.toHaveProperty('npub');
    expect(doc.components.schemas.OnboardingIntentCreate.properties.identity_origin.enum).toEqual(['new', 'existing']);
  });
});
