import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Hono } from 'hono';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { managedAppStorageSql } from '../src/schema/managed-app-storage';
// Synthetic config required by Tower's existing auth module; injected ledger is the only DB used.
process.env.SUPERBASED_DIRECT_HTTPS_URL = 'https://destination.example';
for (const key of ['DB_USER', 'DB_PASSWORD', 'GRAPH_DB_ADMIN_USER', 'GRAPH_DB_ADMIN_PASSWORD', 'GRAPH_DB_APP_USER', 'GRAPH_DB_APP_PASSWORD', 'STORAGE_S3_ACCESS_KEY', 'STORAGE_S3_SECRET_KEY']) process.env[key] = 'managed-storage-fixture';
process.env.STORAGE_S3_ENDPOINT_PUBLIC = 'https://objects.invalid';
for (const key of ['ADMIN_NPUB', 'FLIGHT_DECK_PG_APP_NPUB']) process.env[key] = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(60)));
const { createManagedStorageRouter, createLazyManagedStorageRouter } = await import('../src/managed-storage/routes');
const { hostingWriteBlock } = await import('../src/services/hosting-billing');
import { digest, PREFIX, TOKEN_HEADER, boundedBytes } from '../src/managed-storage/contract';
import { parseStorageGrants, readStorageGrants, type StorageGrant } from '../src/managed-storage/grants';
import { StorageLedger } from '../src/managed-storage/ledger';
import { ManagedStorageService } from '../src/managed-storage/service';

// Own disposable cluster, private socket, TCP disabled. Never uses DB_* or a live provider.
const directory = mkdtempSync('/tmp/managed-storage-pg-');
const pgBin = process.env.TEST_POSTGRES_BIN || '';
function pg(command: string, args: string[]) {
  const result = spawnSync(pgBin ? join(pgBin, command) : command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Fixture ${command} failed: ${result.stderr}`);
}
let db: ReturnType<typeof postgres>;
let running = false;
const secret = new Uint8Array(32).fill(61);
const stranger = new Uint8Array(32).fill(62);
const npub = (key: Uint8Array) => nip19.npubEncode(getPublicKey(key));
const grant: StorageGrant = { delegationId: randomUUID(), revision: '1', origin: 'https://destination.example',
  serviceNpub: npub(stranger), workspaceId: randomUUID(), workspaceOwnerNpub: npub(new Uint8Array(32).fill(63)),
  installationId: 'installation-fixture', appId: 'backup-fixture', appNpub: npub(secret),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), maxObjectBytes: 64, quotaBytes: 16_384,
  maxObjects: 4, billing: 'operator_budget' };
let grants: StorageGrant[];
let blocked: boolean;
let now: number;
let blobs: Map<string, Uint8Array>;
let writes: number;
let app: Hono;
let service: ManagedStorageService;
let holdRead: (() => Promise<void>) | undefined;
function newService() {
  return new ManagedStorageService({ ledger: new StorageLedger(db), grants: () => grants,
    serviceNpub: () => grant.serviceNpub, creditBlock: async () => blocked, now: () => now,
    blobs: {
      async write(key, bytes) { writes++; blobs.set(key, new Uint8Array(bytes)); },
      async read(key, limit) {
        await holdRead?.();
        const value = blobs.get(key);
        if (!value || value.length > limit) throw new Error('fixture blob missing/oversized');
        return new Uint8Array(value);
      },
    },
  });
}
function mount(value = newService()) { service = value; app = new Hono(); app.route(PREFIX, createManagedStorageRouter(service)); }
function path(tail: string, workspace = grant.workspaceId) {
  return `${PREFIX}/workspaces/${workspace}/delegations/${grant.delegationId}/${tail}`;
}
async function control(tail: string, extra: Record<string, unknown> = {}, options: { key?: Uint8Array; workspace?: string; overrides?: Record<string, unknown>; stale?: boolean } = {}) {
  const url = grant.origin + path(tail, options.workspace);
  const body = JSON.stringify({ installation_id: grant.installationId, app_id: grant.appId,
    revision: grants[0]?.revision ?? grant.revision, expected_service_npub: grant.serviceNpub, ...extra, ...options.overrides });
  const event = finalizeEvent({ kind: 27235, content: '', created_at: Math.floor(Date.now() / 1000) - (options.stale ? 120 : 0),
    tags: [['u', url], ['method', 'POST'], ['payload', digest(body)]] }, options.key ?? secret);
  return app.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` }, body }));
}
async function prepare(bytes: Uint8Array, key = randomUUID()) {
  const response = await control('prepare', { idempotency_key: key, sha256_hex: digest(bytes), size_bytes: bytes.length });
  return { response, data: await response.json() as any, key };
}
async function upload(data: any, bytes: Uint8Array, extraHeaders = {}) {
  return app.fetch(new Request(data.upload.url, { method: 'PUT', headers: { ...data.upload.headers, ...extraHeaders }, body: new Uint8Array(bytes) }));
}
const bytes = new TextEncoder().encode('encrypted fixture archive chunk');

beforeAll(async () => {
  pg('initdb', ['-D', join(directory, 'data'), '-A', 'trust', '-U', 'storage_fixture', '--no-locale']);
  pg('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'), '-o', `-h '' -k ${directory}`, '-w', 'start']);
  running = true;
  db = postgres({ host: directory, username: 'storage_fixture', database: 'postgres', max: 8 });
  await db.unsafe('CREATE TABLE flightdeck_pg_workspaces(id uuid PRIMARY KEY,workspace_owner_npub text,tower_service_npub text)');
  await db.unsafe(managedAppStorageSql);
  await db.unsafe('CREATE TABLE hosting_accounts(id uuid PRIMARY KEY,paid_units numeric,promo_units numeric,promo_expires_at timestamptz,depleted_at timestamptz); CREATE TABLE hosting_workspace_accounts(workspace_id uuid PRIMARY KEY,account_id uuid)');
  await db`INSERT INTO flightdeck_pg_workspaces VALUES(${grant.workspaceId},${grant.workspaceOwnerNpub},${grant.serviceNpub})`;
}, 30_000);
afterAll(async () => {
  await db?.end();
  if (running) pg('pg_ctl', ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop']);
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  grants = [{ ...grant }]; blocked = false; now = Date.now(); writes = 0; holdRead = undefined; blobs = new Map();
  await db`TRUNCATE managed_app_storage_objects`;
  mount();
});

describe('managed storage destination contract', () => {
  test('lazy production mounting retains the full API prefix', async () => {
    const mounted = new Hono().route(PREFIX, createLazyManagedStorageRouter(() => service));
    expect((await mounted.fetch(new Request(grant.origin + PREFIX + '/descriptor'))).status).toBe(200);
    const status = await control('status');
    expect(status.status).toBe(200);
  });
  test('private prepare, direct bounded upload, verified complete and revocation-aware read', async () => {
    const p = await prepare(bytes);
    expect(p.response.status).toBe(200);
    expect(p.data.upload.url).not.toContain(p.data.upload.headers[TOKEN_HEADER]);
    expect(p.data).not.toHaveProperty('is_public');
    expect((await upload(p.data, bytes)).status).toBe(200);
    const completed = await control(`objects/${p.data.object_id}/complete`);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ state: 'complete', sha256_hex: digest(bytes), size_bytes: bytes.length });
    const repeated = await control(`objects/${p.data.object_id}/complete`);
    expect(repeated.status).toBe(200);
    expect((await upload(p.data, bytes)).status).toBe(403);
    const link = await (await control(`objects/${p.data.object_id}/download-url`)).json() as any;
    const read = await app.fetch(new Request(link.download.url, { headers: link.download.headers }));
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    expect(read.headers.get('cache-control')).toContain('no-store');
    grants = [];
    expect((await app.fetch(new Request(link.download.url, { headers: link.download.headers }))).status).toBe(404);
    expect(writes).toBe(1);
  });
  test('concurrent duplicate prepares reserve once and survive a new service instance', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => prepare(bytes, key)));
    expect(new Set(results.map(p => p.data.object_id)).size).toBe(1);
    const [count] = await db`SELECT COUNT(*)::int AS n FROM managed_app_storage_objects`;
    expect(count!.n).toBe(1);
    mount();
    expect((await prepare(bytes, key)).data.object_id).toBe(results[0]!.data.object_id);
    const conflict = await prepare(new Uint8Array([1, 2]), key);
    expect(conflict.response.status).toBe(409);
  });
  test('atomic budget and row reservations include pending data', async () => {
    grants[0] = { ...grant, quotaBytes: 10_000, maxObjects: 2 };
    const result = await Promise.all(Array.from({ length: 5 }, () => prepare(new Uint8Array(32))));
    expect(result.filter(p => p.response.status === 200)).toHaveLength(2);
    expect(result.filter(p => p.data.error === 'storage_budget_exhausted')).toHaveLength(3);
    const status = await (await control('status')).json() as any;
    expect(status).toMatchObject({ remaining_objects: 0, budget_mode: 'operator_allocated_unmetered' });
  });
  test('denies wrong signer/workspace/install/revision/service and unknown control fields before writes', async () => {
    for (const options of [{ key: stranger }, { workspace: randomUUID() }, { overrides: { installation_id: 'other' } },
      { overrides: { revision: 'other' } }, { overrides: { expected_service_npub: grant.appNpub } }, { stale: true }]) {
      expect((await control('status', {}, options)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await control('prepare', { owner_npub: grant.workspaceOwnerNpub })).status).toBe(400);
    expect((await control('status', { objectId: null })).status).toBe(400);
    expect(writes).toBe(0);
  });
  test('402 gates prepare, upload and complete but reads and status remain possible', async () => {
    blocked = true;
    expect((await prepare(bytes)).response.status).toBe(402);
    blocked = false;
    const p = await prepare(bytes);
    blocked = true;
    expect((await upload(p.data, bytes)).status).toBe(402);
    blocked = false;
    await upload(p.data, bytes);
    blocked = true;
    expect((await control(`objects/${p.data.object_id}/complete`)).status).toBe(402);
    expect(await (await control('status')).json()).toMatchObject({ billing_ok: false });
  });
  test('bad lengths, hashes, oversized bytes and purpose tokens never write blobs', async () => {
    const p = await prepare(bytes);
    expect((await upload(p.data, bytes, { 'Content-Length': '1' })).status).toBe(400);
    expect((await upload(p.data, new Uint8Array(bytes.length + 1))).status).toBe(413);
    expect((await upload(p.data, new Uint8Array(bytes.length))).status).toBe(409);
    expect((await upload(p.data, bytes.slice(1))).status).toBe(409);
    expect((await app.fetch(new Request(p.data.upload.url.replace('/upload', '/download'), { headers: p.data.upload.headers }))).status).toBe(403);
    expect(writes).toBe(0);
    now += 60_001;
    expect((await upload(p.data, bytes)).status).toBe(403);
  });
  test('routine budget revision preserves objects, invalidates tokens and renews by prepare', async () => {
    const p = await prepare(bytes);
    grants[0] = { ...grant, revision: '2', quotaBytes: 20_000 };
    expect((await upload(p.data, bytes)).status).toBe(403);
    const renewed = await prepare(bytes, p.key);
    expect(renewed.data.object_id).toBe(p.data.object_id);
    expect((await upload(renewed.data, bytes)).status).toBe(200);
    expect((await control(`objects/${p.data.object_id}/complete`)).status).toBe(200);
    grants[0] = { ...grants[0]!, installationId: 'foreign-install' };
    expect((await control(`objects/${p.data.object_id}/status`, {}, { overrides: { installation_id: 'foreign-install' } })).status).toBe(404);
  });
  test('recovery pages are grant-scoped and receipts remain historical and immutable', async () => {
    const p = await prepare(bytes);
    await upload(p.data, bytes);
    await control(`objects/${p.data.object_id}/complete`);
    const status = await (await control('status')).json() as any;
    const page = await (await control('status', { cursor: status.list_cursor })).json() as any;
    expect(page.objects.map((o: any) => o.object_id)).toEqual([p.data.object_id]);
    expect(page.next_cursor).toBeNull();
    expect(page.objects[0]).not.toHaveProperty('publisher_receipt');
    const object = await (await control(`objects/${p.data.object_id}/status`)).json() as any;
    expect(object.publisher_receipt.body).toContain(digest(bytes));
    expect(object.publisher_receipt.event.pubkey).toBe(getPublicKey(secret));
    await expect(db`UPDATE managed_app_storage_objects SET publisher_receipt='{}'::jsonb WHERE id=${p.data.object_id}`).rejects.toThrow('immutable');
    const original = JSON.stringify(object.publisher_receipt);
    grants[0] = { ...grant, revision: '2' };
    await prepare(bytes, p.key);
    expect(JSON.stringify((await (await control(`objects/${p.data.object_id}/status`)).json() as any).publisher_receipt)).toBe(original);
    const cursor = JSON.parse(Buffer.from(status.list_cursor, 'base64url').toString());
    cursor.w = randomUUID();
    expect((await control('status', { cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') })).status).toBe(400);
    expect((await control('status', { cursor: null })).status).toBe(400);
    expect((await control('status', { cursor: 'invalid' })).status).toBe(400);
    const [usage] = await db`SELECT SUM(size_bytes + receipt_bytes)::int AS n FROM managed_app_storage_objects`;
    expect(status.remaining_bytes).toBe(grant.quotaBytes - usage!.n);
  });
  test('recovery keyset pages fit the control budget and expose no other owner namespace', async () => {
    grants[0] = { ...grant, quotaBytes: 1_000_000, maxObjects: 100 };
    for (let i = 0; i < 51; i++) {
      const p = await prepare(bytes);
      await upload(p.data, bytes);
      await control(`objects/${p.data.object_id}/complete`);
    }
    const status = await (await control('status')).json() as any;
    const firstResponse = await control('status', { cursor: status.list_cursor });
    const raw = await firstResponse.text();
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(16384);
    const first = JSON.parse(raw);
    expect(first.objects).toHaveLength(50);
    const second = await (await control('status', { cursor: first.next_cursor })).json() as any;
    expect(second.objects).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.objects, ...second.objects].map((row: any) => row.object_id)).size).toBe(51);
    grants[0] = { ...grants[0]!, appId: 'other-app' };
    const denied = await (await control('status', { cursor: status.list_cursor }, { overrides: { app_id: 'other-app' } })).json() as any;
    expect(denied.objects).toEqual([]);
  });
  test('transactional rechecks work with a one-connection pool and mid-request edits abort', async () => {
    const single = postgres({ host: directory, username: 'storage_fixture', database: 'postgres', max: 1 });
    const instance = new ManagedStorageService({ ...service.options, ledger: new StorageLedger(single),
      creditBlock: async (_grant, tx) => { await (tx ?? single)`SELECT 1`; return false; } });
    mount(instance);
    try {
      const p = await prepare(bytes);
      expect(p.response.status).toBe(200);
      await upload(p.data, bytes);
      holdRead = async () => { grants[0] = { ...grant, revision: 'edited-during-io' }; };
      expect((await control(`objects/${p.data.object_id}/complete`)).status).toBe(403);
      const [row] = await single`SELECT state FROM managed_app_storage_objects WHERE id=${p.data.object_id}`;
      expect(row!.state).toBe('uploaded');
    } finally { await single.end(); }
  });
  test('tampered persisted bytes prevent complete and never mark a set verified', async () => {
    const p = await prepare(bytes);
    await upload(p.data, bytes);
    for (const key of blobs.keys()) blobs.set(key, new Uint8Array(bytes.length));
    expect((await control(`objects/${p.data.object_id}/complete`)).status).toBe(409);
    expect(await (await control(`objects/${p.data.object_id}/status`)).json()).toMatchObject({ state: 'uploaded', verified_at: null });
  });
  test('validated delegation admission rejects concurrent transfer without accepting anonymous token', async () => {
    const p = await prepare(bytes);
    await upload(p.data, bytes);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    holdRead = () => held;
    const first = control(`objects/${p.data.object_id}/complete`);
    await Bun.sleep(20);
    const second = await control(`objects/${p.data.object_id}/complete`);
    release();
    expect(second.status).toBe(429);
    expect((await first).status).toBe(200);
  });
});

test('real hosting write gate uses the exact workspace UUID and caller transaction', async () => {
  const accountId = randomUUID();
  await db`INSERT INTO hosting_accounts VALUES(${accountId},0,0,NOW()-INTERVAL '1 day',NOW())`;
  await db`INSERT INTO hosting_workspace_accounts VALUES(${grant.workspaceId},${accountId})`;
  await db.begin(async transaction => {
    const tx = transaction as unknown as typeof db;
    expect(await hostingWriteBlock(grant.workspaceId, tx)).toMatchObject({ code: 'hosting_balance_exhausted' });
    expect(await hostingWriteBlock(randomUUID(), tx)).toBeNull();
    await tx`UPDATE hosting_accounts SET paid_units=1 WHERE id=${accountId}`;
    expect(await hostingWriteBlock(grant.workspaceId, tx)).toBeNull();
    await tx`UPDATE hosting_accounts SET paid_units=0,promo_units=100,promo_expires_at=NOW()+INTERVAL '1 day' WHERE id=${accountId}`;
    expect(await hostingWriteBlock(grant.workspaceId, tx)).toBeNull();
    await tx`UPDATE hosting_accounts SET promo_expires_at=NOW()-INTERVAL '1 day' WHERE id=${accountId}`;
    expect(await hostingWriteBlock(grant.workspaceId, tx)).toMatchObject({ code: 'hosting_balance_exhausted' });
  });
});
test('operator grants are explicit, private, symlink-free and require billing consent', () => {
  expect(parseStorageGrants({ version: 1, grants: [grant] })).toHaveLength(1);
  expect(() => parseStorageGrants({ version: 1, grants: [{ ...grant, billing: undefined }] })).toThrow('storage_billing_unconfigured');
  const file = join(directory, 'grants.json');
  writeFileSync(file, JSON.stringify({ version: 1, grants: [grant] }), { mode: 0o600 });
  expect(readStorageGrants(file)).toHaveLength(1);
  chmodSync(file, 0o644);
  expect(() => readStorageGrants(file)).toThrow('storage_config_invalid');
  chmodSync(file, 0o600);
  const link = join(directory, 'grants-link'); symlinkSync(file, link);
  expect(() => readStorageGrants(link)).toThrow('storage_config_invalid');
});
test('bounded readers terminate stalled bodies at the deadline', async () => {
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  await expect(boundedBytes(stream, 64, AbortSignal.timeout(10))).rejects.toMatchObject({ code: 'storage_timeout' });
});
