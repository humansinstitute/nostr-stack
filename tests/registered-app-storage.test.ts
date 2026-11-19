import { beforeAll, afterAll, test, expect } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { createApp } from '../src/server';
import { unclassifiedFixtureCeiling } from '../src/services/agent-notifications';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest } from '../src/services/storage';
import { buildOpenApiDocument } from '../src/openapi';

// Explicit isolated database only. Never falls back to configured/shared DB.
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith('/tower_app_files_test')) throw new Error('TEST_DATABASE_URL must name a disposable tower_app_files_test database');
const sql = postgres(url);
const keys = [61, 62, 63, 64, 65].map(n => new Uint8Array(32).fill(n));
const npubs = keys.map(k => nip19.npubEncode(getPublicKey(k)));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const app = createApp({ agentCeiling: unclassifiedFixtureCeiling });
const base = (owner = npubs[0], principal = npubs[1]) => `/api/v4/workspaces/${owner}/apps/${principal}/storage`;
const bytes = Buffer.from('private registered app fixture');
const input = () => ({ idempotency_key: randomUUID(), file_name: 'image.png', content_type: 'image/png', size_bytes: bytes.length, sha256_hex: hash(bytes) });
const identity = { size_bytes: bytes.length, sha256_hex: hash(bytes) };
function req(path: string, method = 'GET', who = 1, body?: unknown, raw = false) {
  const text = body === undefined ? undefined : raw ? String(body) : JSON.stringify(body);
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now()/1000), tags: [['u', `http://localhost${path}`], ['method', method], ...(text ? [['payload', hash(text)]] : [])], content: '' }, keys[who]);
  return app.request(path, { method, body: text, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'Content-Type': 'application/json' } });
}
async function prepare() {
  const body = input(); const response = await req(`${base()}/prepare`, 'POST', 1, body); expect(response.status).toBe(201);
  const object = await response.json(); return { body, object, path: `${base()}/objects/${object.object_id}` };
}
async function enabled(value: boolean) { await sql`UPDATE workspace_apps SET enabled=${value} WHERE workspace_owner_npub=${npubs[0]} AND app_npub=${npubs[1]}`; }
beforeAll(async () => {
  setDb(sql);
  for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await sql.unsafe(statement);
  // Exercise upgrade idempotency as well as bootstrap.
  await sql.unsafe(readFileSync(new URL('../src/schema/registered-app-storage-v1.sql', import.meta.url), 'utf8'));
  if (!process.env.APP_STORAGE_TEST_S3) enableInMemoryStorageForTest();
  for (const i of [0, 3, 4]) {
    const [actor] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npubs[i]},'human') RETURNING id`;
    if (i === 3) continue;
    await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('fixture-tower',${'fixture-' + i},${npubs[i]},'fixture-fd','App files fixture',${actor.id})`;
  }
  for (const owner of [npubs[0], npubs[4]]) for (const principal of [npubs[1], npubs[2]]) {
    await sql`INSERT INTO workspace_apps(workspace_owner_npub,app_npub,app_name,created_by_npub) VALUES(${owner},${principal},'Fixture',${owner})`;
  }
});
afterAll(async () => { resetInMemoryStorageForTest(); await sql.end(); });

test('full signed lifecycle for nonmember app; stable wire metadata, replay and immutable bytes', async () => {
  expect((await sql`SELECT 1 FROM flightdeck_pg_actors WHERE npub=${npubs[1]}`).length).toBe(0);
  const descriptor = await req(`${base()}/descriptor`); expect(descriptor.status).toBe(200);
  expect(await descriptor.json()).toEqual({ protocol: 'registered-app-storage-v1', workspace_owner_npub: npubs[0], app_npub: npubs[1], max_object_bytes: 8388608, private_only: true, operations: ['prepare','upload','complete','metadata','content','head'] });
  const { body, object, path } = await prepare();
  expect(object).toEqual({ protocol: 'registered-app-storage-v1', workspace_owner_npub: npubs[0], app_npub: npubs[1], object_id: expect.any(String), file_name: body.file_name, content_type: body.content_type, ...identity, is_public: false, completed_at: null });
  expect(await (await req(`${base()}/prepare`, 'POST', 1, body)).json()).toEqual(object);
  expect((await req(`${path}/content`)).status).toBe(409);
  expect((await req(`${path}/complete`, 'POST', 1, identity)).status).toBe(409);
  expect(await (await req(path, 'PUT', 1, { base64_data: bytes.toString('base64') })).json()).toEqual(object);
  const complete = await req(`${path}/complete`, 'POST', 1, identity); expect(complete.status).toBe(200); const completed = await complete.json();
  expect(completed.completed_at).toEqual(expect.any(String));
  expect(await (await req(`${path}/complete`, 'POST', 1, identity)).json()).toEqual(completed);
  expect(await (await req(`${base()}/prepare`, 'POST', 1, body)).json()).toEqual(completed);
  expect((await req(path, 'PUT', 1, { base64_data: bytes.toString('base64') })).status).toBe(409);
  expect((await req(`${path}/complete`, 'POST', 1, { ...identity, size_bytes: 1 })).status).toBe(409);
  const content = await req(`${path}/content`); expect(content.status).toBe(200); expect(Buffer.from(await content.arrayBuffer())).toEqual(bytes); expect(content.headers.get('cache-control')).toBe('private, no-store');
  const head = await req(`${path}/content`, 'HEAD'); expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe(String(bytes.length)); expect(await head.text()).toBe('');
  for (const field of ['file_name', 'content_type', 'size_bytes', 'sha256_hex']) {
    const changed = { ...body, [field]: field === 'size_bytes' ? 1 : field === 'sha256_hex' ? '0'.repeat(64) : field === 'content_type' ? 'text/plain' : 'other.png' };
    expect((await req(`${base()}/prepare`, 'POST', 1, changed)).status).toBe(409);
  }
});

test('foreign app, owner namespace, raw signer and unregistered app denied at every stage', async () => {
  const { object } = await prepare();
  for (const [owner, principal, signer] of [[npubs[0], npubs[2], 2], [npubs[4], npubs[1], 1], [npubs[0], npubs[1], 0], [npubs[0], npubs[3], 3]] as const) {
    const path = `${base(owner, principal)}/objects/${object.object_id}`;
    for (const [suffix, method, body] of [['', 'GET', undefined], ['', 'PUT', { base64_data: bytes.toString('base64') }], ['/complete', 'POST', identity], ['/content', 'GET', undefined], ['/content', 'HEAD', undefined]] as const) {
      expect([403,404]).toContain((await req(path + suffix, method, signer, body)).status);
    }
  }
  expect((await req(`${base(npubs[0], npubs[3])}/prepare`, 'POST', 3, input())).status).toBe(404);
  expect((await req(`${base()}/descriptor`, 'GET', 0)).status).toBe(403);
});

test('registration revocation blocks every app endpoint after prepare and upload; generic bypass closed; human owner recovery retained', async () => {
  const { object, path } = await prepare();
  for (const uploaded of [false, true]) {
    if (uploaded) expect((await req(path, 'PUT', 1, { base64_data: bytes.toString('base64') })).status).toBe(200);
    await enabled(false);
    for (const [target, method, body] of [[`${base()}/descriptor`, 'GET', undefined], [`${base()}/prepare`, 'POST', input()], [path, 'GET', undefined], [path, 'PUT', { base64_data: bytes.toString('base64') }], [`${path}/complete`, 'POST', identity], [`${path}/content`, 'GET', undefined], [`${path}/content`, 'HEAD', undefined]] as const) expect((await req(target, method, 1, body)).status).toBe(404);
    await enabled(true);
  }
  expect((await req(`${path}/complete`, 'POST', 1, identity)).status).toBe(200);
  await enabled(false);
  const generic = `/api/v4/storage/${object.object_id}`;
  for (const who of [1,2,3]) for (const suffix of ['', '/content', '/download-url']) expect((await req(generic + suffix, 'GET', who)).status).toBe(404);
  expect((await req(generic, 'PUT', 1, { base64_data: bytes.toString('base64') })).status).toBe(404);
  expect((await req(`${generic}/complete`, 'POST', 1, identity)).status).toBe(404);
  expect((await req(generic, 'GET', 0)).status).toBe(200);
  expect(Buffer.from(await (await req(`${generic}/content`, 'GET', 0)).arrayBuffer())).toEqual(bytes);
  await enabled(true);
});

test('reject malformed, authority-bearing, oversize and noncanonical/mismatched content', async () => {
  for (const body of [null, {}, { ...input(), is_public: true }, { ...input(), owner_npub: npubs[0] }, { ...input(), size_bytes: 0 }, { ...input(), size_bytes: 8388609 }, { ...input(), size_bytes: '2' }, { ...input(), sha256_hex: 'no' }]) expect((await req(`${base()}/prepare`, 'POST', 1, body)).status).toBe(400);
  expect((await req(`${base()}/prepare`, 'POST', 1, '{invalid', true)).status).toBe(400);
  const { path } = await prepare();
  for (const data of ['a', bytes.toString('base64') + '\n', '!!!!']) expect((await req(path, 'PUT', 1, { base64_data: data })).status).toBe(400);
  expect((await req(path, 'PUT', 1, { base64_data: Buffer.from('wrong').toString('base64') })).status).toBe(409);
  expect((await req(path, 'PUT', 1, { base64_data: Buffer.alloc(bytes.length, 9).toString('base64') })).status).toBe(409);
  expect((await req(path, 'PUT', 1, { base64_data: '', is_public: true })).status).toBe(400);
  expect((await req(path, 'PUT', 1, { base64_data: 'a'.repeat(12*1024*1024) })).status).toBe(413);
});

test('OpenAPI covers frozen signed contract and private raw content', () => {
  const api = buildOpenApiDocument('http://localhost'); const root = '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/storage';
  expect(api.paths[`${root}/prepare`].post.security).toEqual([{ nip98: [] }]);
  expect(api.paths[`${root}/prepare`].post.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
  expect(api.paths[`${root}/objects/{objectId}/content`].head).toBeDefined();
});

test('simultaneous prepare replays allocate one object; upload and complete serialize', async () => {
  const body = input();
  const results = await Promise.all(Array.from({ length: 4 }, () => req(`${base()}/prepare`, 'POST', 1, body)));
  for (const response of results) expect(response.status).toBe(201);
  const objects = await Promise.all(results.map(r => r.json()));
  expect(new Set(objects.map(o => o.object_id)).size).toBe(1);
  const path = `${base()}/objects/${objects[0].object_id}`;
  expect((await req(path, 'PUT', 1, { base64_data: bytes.toString('base64') })).status).toBe(200);
  const racing = await Promise.all([req(`${path}/complete`, 'POST', 1, identity), req(path, 'PUT', 1, { base64_data: bytes.toString('base64') })]);
  expect(racing[0].status).toBe(200); expect([200,409]).toContain(racing[1].status);
  expect(Buffer.from(await (await req(`${path}/content`)).arrayBuffer())).toEqual(bytes);
});

test('canonical owner binding survives multiple PG facades; ambiguous PG-only owners fail closed', async () => {
  const [actor] = await sql`SELECT id FROM flightdeck_pg_actors WHERE npub=${npubs[0]}`;
  const addFacade = async (owner: string) => (await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
    VALUES('fixture-tower',${randomUUID()},${owner},'fixture-fd','Second facade',${actor.id}) RETURNING id`)[0].id;
  const duplicate = await addFacade(npubs[0]);
  expect((await req(`${base()}/prepare`, 'POST', 1, input())).status).toBe(409);
  await sql`INSERT INTO v4_workspaces(workspace_owner_npub,creator_npub,name,wrapped_workspace_nsec,wrapped_by_npub)
    VALUES(${npubs[0]},${npubs[0]},'Canonical fixture','not-a-secret',${npubs[0]})`;
  const saved = await prepare();
  expect((await req(`/api/v4/storage/${saved.object.object_id}`, 'GET', 0)).status).toBe(200);
  const [row] = await sql`SELECT pg_workspace_id FROM v4_storage_objects WHERE id=${saved.object.object_id}`;
  expect(row.pg_workspace_id).toBeNull();
  await sql`DELETE FROM flightdeck_pg_workspaces WHERE id=${duplicate}`;
});

test('credit and hosted exhaustion block writes while preserving read/recovery', async () => {
  const { path } = await prepare();
  const { config } = await import('../src/config'); const previous = config.billing.mode;
  config.billing.mode = 'metered';
  try {
    await sql`INSERT INTO workspace_credit_accounts(workspace_owner_npub,balance_credits,billing_state) VALUES(${npubs[0]},0,'read_only_grace')
      ON CONFLICT(workspace_owner_npub) DO UPDATE SET balance_credits=0,billing_state='read_only_grace'`;
    expect((await req(`${base()}/prepare`, 'POST', 1, input())).status).toBe(402);
    expect((await req(path, 'PUT', 1, { base64_data: bytes.toString('base64') })).status).toBe(402);
    expect((await req(path)).status).toBe(200);
    await sql`UPDATE workspace_credit_accounts SET balance_credits=100,billing_state='active' WHERE workspace_owner_npub=${npubs[0]}`;
    const [actor] = await sql`SELECT id FROM flightdeck_pg_actors WHERE npub=${npubs[0]}`;
    const [account] = await sql`INSERT INTO hosting_accounts(owner_actor_id,paid_units,promo_units,depleted_at) VALUES(${actor.id},0,0,NOW()) RETURNING id`;
    const [ws] = await sql`SELECT id FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${npubs[0]}`;
    await sql`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${ws.id},${account.id})`;
    expect((await req(`${base()}/prepare`, 'POST', 1, input())).status).toBe(402);
    expect((await req(path, 'PUT', 1, { base64_data: bytes.toString('base64') })).status).toBe(402);
    expect((await req(path)).status).toBe(200);
    await sql`DELETE FROM hosting_workspace_accounts WHERE workspace_id=${ws.id}`;
  } finally { config.billing.mode = previous; }
});

test('maximum 8 MiB object verified end to end; active HTML sandboxed', async () => {
  const large = Buffer.alloc(8388608, 17); const prepared = input(); prepared.size_bytes = large.length; prepared.sha256_hex = hash(large); prepared.content_type = 'text/html';
  const response = await req(`${base()}/prepare`, 'POST', 1, prepared); expect(response.status).toBe(201);
  const object = await response.json(); const path = `${base()}/objects/${object.object_id}`;
  expect((await req(path, 'PUT', 1, { base64_data: large.toString('base64') })).status).toBe(200);
  expect((await req(`${path}/complete`, 'POST', 1, { size_bytes: large.length, sha256_hex: hash(large) })).status).toBe(200);
  const content = await req(`${path}/content`); expect(content.status).toBe(200); expect(hash(new Uint8Array(await content.arrayBuffer()))).toBe(hash(large));
  expect(content.headers.get('content-security-policy')).toContain('sandbox'); expect(content.headers.get('x-content-type-options')).toBe('nosniff'); expect(content.headers.get('referrer-policy')).toBe('no-referrer');
});


test('member peers and workspace-key aliases gain no app authority; generic app writes stay denied after enrollment', async () => {
  const [ws] = await sql`SELECT id FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${npubs[0]}`;
  const [peer] = await sql`SELECT id FROM flightdeck_pg_actors WHERE npub=${npubs[3]}`;
  await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${ws.id},${peer.id},'member')`;
  const [principal] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npubs[1]},'app') RETURNING id`;
  await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${ws.id},${principal.id},'app')`;
  await sql`INSERT INTO user_profiles(user_npub) VALUES(${npubs[1]})`;
  await sql`INSERT INTO user_workspace_keys(user_npub,workspace_owner_npub,ws_key_npub) VALUES(${npubs[1]},${npubs[0]},${npubs[3]})`;
  expect((await req(`${base()}/descriptor`, 'GET', 3)).status).toBe(403);
  expect((await req(`${base()}/prepare`, 'POST', 3, input())).status).toBe(403);
  const { object } = await prepare(); const generic = `/api/v4/storage/${object.object_id}`;
  expect((await req(generic, 'GET', 3)).status).toBe(404);
  expect((await req(generic, 'PUT', 1, { base64_data: bytes.toString('base64') })).status).toBe(404);
  expect((await req(`${generic}/complete`, 'POST', 1, identity)).status).toBe(404);
  await sql`DELETE FROM user_workspace_keys WHERE ws_key_npub=${npubs[3]}`;
  expect((await req(generic, 'GET', 3)).status).toBe(404);
});


test('NIP-98 payload tamper and unsigned reads denied; GET/HEAD body hints rejected', async () => {
  const path = `${base()}/prepare`; const body = JSON.stringify(input());
  const event = finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',`http://localhost${path}`],['method','POST'],['payload',hash(body)]],content:''},keys[1]);
  const authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
  expect((await app.request(path,{method:'POST',body:body+' ',headers:{authorization}})).status).toBe(401);
  expect((await app.request(`${base()}/descriptor`)).status).toBe(401);
  for(const method of ['GET','HEAD']) expect((await app.request(`${base()}/descriptor`,{method,headers:{'content-length':'2'}})).status).toBe(400);
});

test('aborted chunked request stops bounded body admission', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
  const pending = app.request(new Request(`http://localhost${base()}/prepare`, { method: 'POST', body: stream, signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  const response = await pending;
  expect(response.status).toBe(408); expect(cancelled).toBe(true);
});

test('completion and content verify stored bytes rather than trusting upload or caller claims', async () => {
  const { getStorageObject, writeAuthorizedStorageBytes } = await import('../src/services/storage');
  const { object, path } = await prepare();
  const row = (await getStorageObject(object.object_id))!;
  await writeAuthorizedStorageBytes(row, Buffer.alloc(bytes.length, 3));
  expect((await req(`${path}/complete`, 'POST', 1, identity)).status).toBe(409);
  expect((await req(path, 'PUT', 1, { base64_data: bytes.toString('base64') })).status).toBe(200);
  expect((await req(`${path}/complete`, 'POST', 1, identity)).status).toBe(200);
  await writeAuthorizedStorageBytes(row, Buffer.alloc(bytes.length, 4));
  expect((await req(`${path}/content`)).status).toBe(409);
  expect((await req(`${path}/complete`, 'POST', 1, identity)).status).toBe(409);
});
