import { beforeAll, afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { randomUUID, createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { requireNamespacePermission } from '../src/services/namespace-permissions';

const schema = 'permission_test_' + randomUUID().replaceAll('-', '');
const keys = Array.from({ length: 5 }, (_, i) => new Uint8Array(32).fill(119 + i));
const [owner, agent, stranger, appNpub, foreign] = keys.map(k => nip19.npubEncode(getPublicKey(k)));
let admin: ReturnType<typeof postgres>, db: ReturnType<typeof postgres>;
const app = createApp();
const opts = () => ({ host: config.db.host, port: config.db.port, database: config.db.database, username: config.db.user, password: config.db.password, onnotice: () => {} });
beforeAll(async () => {
  admin = postgres({ ...opts(), max: 1 }); await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  db = postgres({ ...opts(), max: 6, connection: { search_path: schema + ',public' } }); setDb(db);
  for (const t of ['namespace_app_permissions', 'workspace_apps', 'v4_workspaces', 'v4_groups', 'v4_group_members', 'flightdeck_pg_workspaces', 'user_workspace_keys']) await db.unsafe(`CREATE TABLE "${schema}"."${t}" (LIKE public."${t}" INCLUDING ALL)`);
  // Deliberately use minimal typed rows in the disposable schema, no real membership.
  await db`INSERT INTO flightdeck_pg_workspaces(id,app_npub,workspace_owner_npub,workspace_service_npub,tower_service_npub,name) VALUES(${randomUUID()},${appNpub},${owner},${foreign},${owner},'Permission fixture')`;
  await db`INSERT INTO flightdeck_pg_workspaces(id,app_npub,workspace_owner_npub,workspace_service_npub,tower_service_npub,name) VALUES(${randomUUID()},${appNpub},${foreign},${owner},${foreign},'Foreign fixture')`;
});
afterAll(async () => { if (db) await db.end(); if (admin) { await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); } });
async function request(path: string, method = 'GET', body?: any, key = keys[0], address = owner) {
  const url = 'http://localhost/api/v4/workspaces/' + address + path, raw = body === undefined ? '' : JSON.stringify(body);
  const tags = [['u', url], ['method', method]]; if (raw) tags.push(['payload', createHash('sha256').update(raw).digest('hex')]);
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now()/1000), tags, content: '' }, key);
  return app.request(url, { method, headers: { authorization: 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64'), ...(raw ? { 'content-type': 'application/json' } : {}) }, ...(raw ? { body: raw } : {}) });
}
const grantBody = (overrides = {}) => ({ idempotency_key: randomUUID(), agent_npub: agent, app_npub: appNpub, permission: 'namespace.manage', expires_at: new Date(Date.now() + 3600000).toISOString(), ...overrides });
const register = (key = keys[1], address = owner, identity = appNpub) => request('/apps', 'POST', { app_npub: identity, app_name: 'Delegated fixture', enabled: true }, key, address);

test('owner approval unlocks only the exact signer/app/address; no grant onward or broad list', async () => {
  expect((await register()).status).toBe(403);
  const body = grantBody();
  expect((await request('/app-permissions', 'POST', body, keys[1])).status).toBe(403);
  expect((await request('/app-permissions', 'POST', body, keys[2])).status).toBe(403);
  const approved = await request('/app-permissions', 'POST', body); expect(approved.status).toBe(201);
  const grant = (await approved.json()).grant; expect(grant.agent_npub).toBe(agent); expect(grant.revision).toBe(1);
  expect((await register()).status).toBe(201);
  expect((await register(keys[2])).status).toBe(403);
  expect((await register(keys[1], foreign)).status).toBe(403);
  expect((await register(keys[1], owner, stranger)).status).toBe(403);
  expect((await request('/apps', 'GET', undefined, keys[1])).status).toBe(403);
  const scoped = await request('/apps?app_npub=' + appNpub, 'GET', undefined, keys[1]); expect(scoped.status).toBe(200); expect((await scoped.json()).apps).toHaveLength(1);
  expect((await request('/app-permissions', 'GET', undefined, keys[1])).status).toBe(403);
  expect((await request('/app-permissions/' + grant.id + '/revoke', 'POST', {expected_revision:1}, keys[1])).status).toBe(403);
  expect((await request('/app-permissions', 'POST', grantBody(), keys[1])).status).toBe(403);
  expect((await request('/apps/' + appNpub + '/db/provision', 'POST', {app_slug:'denied'}, keys[1])).status).toBe(403);
  const list = await request('/app-permissions'); expect(list.headers.get('cache-control')).toBe('private, no-store'); expect((await list.json()).grants.some((g:any)=>g.id===grant.id)).toBe(true);
  expect((await request('/app-permissions/' + grant.id + '/revoke','POST',{expected_revision:9})).status).toBe(409);
  expect((await request('/app-permissions/' + grant.id + '/revoke','POST',{expected_revision:1},keys[4],foreign)).status).toBe(404);
  const revoked = await request('/app-permissions/' + grant.id + '/revoke','POST',{expected_revision:1}); expect(revoked.status).toBe(200); expect((await revoked.json()).grant.revoked_at).toBeTruthy();
  expect((await register()).status).toBe(403);
  expect((await request('/apps?app_npub=' + appNpub,'GET',undefined,keys[1])).status).toBe(403);
  const retry = await request('/app-permissions','POST',body); expect((await retry.json()).grant.revoked_at).toBeTruthy();
  expect((await register()).status).toBe(403);
  expect((await request('/app-permissions/' + grant.id + '/revoke','POST',{expected_revision:1})).status).toBe(200);
  expect((await request('/apps')).status).toBe(200); // established owner listing preserved
});
test('invalid scope, expiry, identity, idempotency changes and expired grants are rejected', async () => {
  for (const overrides of [{permission:'workspace.manage'}, {agent_npub:'nsec1-private'}, {expires_at:'invalid'}, {expires_at:new Date(Date.now()-1000).toISOString()}, {expires_at:new Date(Date.now()+400*86400000).toISOString()}, {extra:true}]) expect((await request('/app-permissions','POST',grantBody(overrides))).status).toBe(400);
  const body = grantBody(); expect((await request('/app-permissions','POST',body)).status).toBe(201);
  expect((await request('/app-permissions','POST',{...body,app_npub:stranger})).status).toBe(409);
  await db`UPDATE namespace_app_permissions SET expires_at=NOW()-interval '1 second' WHERE id=${body.idempotency_key}`;
  expect((await register()).status).toBe(403);
  expect((await request('/app-permissions/' + body.idempotency_key + '/revoke','POST',{expected_revision:'1'})).status).toBe(400);
});
test('revocation serializes after admitted operations and denies subsequent ones', async () => {
  const body = grantBody(); expect((await request('/app-permissions','POST',body)).status).toBe(201);
  let release!: () => void, entered!: () => void;
  const admitted = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const running = db.begin(async tx => { await requireNamespacePermission(owner, appNpub, agent, tx as unknown as typeof db); entered(); await gate; });
  await admitted;
  let finished = false;
  const revoke = request('/app-permissions/' + body.idempotency_key + '/revoke','POST',{expected_revision:1}).then(r=>{finished=true;return r;});
  try { await Bun.sleep(100); expect(finished).toBe(false); } finally { release(); }
  await running; expect((await revoke).status).toBe(200); expect((await register()).status).toBe(403);
});

test('legacy creator can grant; group admin and owner-mapped workspace key cannot grant onward', async () => {
  const service = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(126))), group = randomUUID();
  await db`INSERT INTO v4_groups(id,owner_npub,name,group_npub,group_kind) VALUES(${group},${service},'Fixture administrators',${service},'workspace_admin')`;
  await db`INSERT INTO v4_workspaces(workspace_owner_npub,creator_npub,name,wrapped_workspace_nsec,wrapped_by_npub,admin_group_id) VALUES(${service},${owner},'Legacy permission fixture','fixture ciphertext',${owner},${group})`;
  await db`INSERT INTO v4_group_members(group_id,member_npub) VALUES(${group},${agent})`;
  expect((await request('/app-permissions','POST',grantBody(),keys[1],service)).status).toBe(403);
  expect((await register(keys[1],service)).status).toBe(201); // existing admin path preserved
  const approved=await request('/app-permissions','POST',grantBody(),keys[0],service); expect(approved.status).toBe(201);
  const aliasKey=new Uint8Array(32).fill(125), alias=nip19.npubEncode(getPublicKey(aliasKey));
  await db`INSERT INTO user_workspace_keys(user_npub,workspace_owner_npub,ws_key_npub) VALUES(${owner},${service},${alias})`;
  expect((await request('/app-permissions','POST',grantBody(),aliasKey,service)).status).toBe(403);
  expect((await request('/app-permissions','GET',undefined,aliasKey,service)).status).toBe(403);
  const grant=(await approved.json()).grant;
  await db`UPDATE v4_workspaces SET creator_npub=${stranger} WHERE workspace_owner_npub=${service}`;
  await db`DELETE FROM v4_group_members WHERE group_id=${group} AND member_npub=${agent}`;
  expect((await register(keys[1],service)).status).toBe(403); // former creator's grant no longer authorizes
  expect((await request('/app-permissions','POST',grantBody(),keys[0],service)).status).toBe(403);
});
test('owner pagination is bounded and retains earlier grants without cross-namespace disclosure', async () => {
  const rows=Array.from({length:205},()=>({id:randomUUID(),workspace_owner_npub:owner,app_npub:appNpub,agent_npub:agent,permission:'namespace.manage',expires_at:new Date(Date.now()-1000),created_by_npub:owner}));
  await db`INSERT INTO namespace_app_permissions ${db(rows)}`;
  const first=await (await request('/app-permissions')).json(); expect(first.grants).toHaveLength(200); expect(first.truncated).toBe(true);
  const second=await (await request('/app-permissions?before='+first.next_cursor)).json(); expect(second.grants.length).toBeGreaterThan(0); expect(second.truncated).toBe(false);
  expect(new Set([...first.grants,...second.grants].map((g:any)=>g.id)).size).toBe(first.grants.length+second.grants.length);
  const foreignCursor=await (await request('/app-permissions?before='+first.next_cursor,'GET',undefined,keys[4],foreign)).json(); expect(foreignCursor.grants).toHaveLength(0);
});
