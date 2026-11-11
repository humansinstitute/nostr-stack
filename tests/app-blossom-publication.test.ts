import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { setDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest, prepareStorageObjectForAuthorizedOwner, writeStorageObject, completeStorageObject } from '../src/services/storage';
import { createApp } from '../src/server';
// Legacy fixture without the runtime schema and without agent classifications: explicit, test-only ceiling provider.
import { unclassifiedFixtureCeiling } from '../src/services/agent-notifications';
import { buildOpenApiDocument } from '../src/openapi';

// 0 owner, 1 uploader member, 2 other member, 3 outsider (no membership).
const keys = [101, 102, 103, 104].map(n => new Uint8Array(32).fill(n));
const npubs = keys.map(key => nip19.npubEncode(getPublicKey(key)));
const appNpub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(105)));
const otherAppNpub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(106)));
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const app = createApp({ agentCeiling: unclassifiedFixtureCeiling });
let sql: ReturnType<typeof postgres>;
let database: string;
const originalPublicOrigin = config.directHttpsUrl;
let workspaceId: string, otherWorkspaceId: string;
let actors: string[];

function request(path: string, method = 'GET', who = 0, payload?: unknown, headers: Record<string, string> = {}) {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000),
    tags: [['u', `http://localhost${path}`], ['method', method], ...(body ? [['payload', hash(body)]] : [])], content: '' }, keys[who]);
  return app.request(path, { method, ...(body ? { body } : {}),
    headers: { ...headers, Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` } });
}
const base = (ws = workspaceId, appKey = appNpub) => `/api/v4/flightdeck-pg/workspaces/${ws}/apps/${appKey}/storage`;
const pubPath = (id: string, ws = workspaceId, appKey = appNpub) => `${base(ws, appKey)}/${id}/blossom`;
const consent = (sha: string) => ({ public: true, expected_sha256: sha });

async function appObject(bytes: Uint8Array, who = 1, complete = true) {
  const res = await request(`${base()}/prepare`, 'POST', who, { content_type: 'application/octet-stream', file_name: 'private-book-title.epub' });
  expect(res.status).toBe(201);
  const prepared = await res.json();
  expect(prepared).toMatchObject({ app_npub: appNpub, is_public: false, owner_npub: npubs[0] });
  await writeStorageObject(prepared.object_id, bytes, npubs[who]);
  if (complete) await completeStorageObject(prepared.object_id, {}, npubs[who]);
  return { id: prepared.object_id as string, sha: hash(bytes), path: pubPath(prepared.object_id) };
}

beforeAll(async () => {
  config.directHttpsUrl = 'http://localhost';
  const options = { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), username: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres' };
  const admin = postgres({ ...options, database: 'postgres' });
  database = `tower_app_publication_${randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
  sql = postgres({ ...options, database }); setDb(sql);
  for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await sql.unsafe(statement);
  enableInMemoryStorageForTest();
  actors = [];
  for (const npub of npubs) { const [a] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING id`; actors.push(a.id); }
  const workspace = async (name: string) => (await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
    VALUES('npub1apppubtower',${'npub1apppubworkspace' + name},${npubs[0]},'npub1apppubflightdeck',${name},${actors[0]}) RETURNING id`)[0].id;
  workspaceId = await workspace('Alexandria fixture');
  otherWorkspaceId = await workspace('Other fixture');
  for (const ws of [workspaceId, otherWorkspaceId]) for (const [i, actor] of actors.slice(0, 3).entries()) {
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${ws},${actor},${i === 0 ? 'owner' : 'member'})`;
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission)
      VALUES(${ws},'actor',${actor},'workspace','workspace.read')`;
  }
  for (const appKey of [appNpub, otherAppNpub])
    await sql`INSERT INTO workspace_apps(workspace_owner_npub,app_npub,app_name,created_by_npub) VALUES(${npubs[0]},${appKey},'Fixture app',${npubs[0]})`;
});
afterAll(async () => {
  config.directHttpsUrl = originalPublicOrigin;
  resetInMemoryStorageForTest(); if (sql) await sql.end();
  if (database) {
    const admin = postgres({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), username: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres', database: 'postgres' });
    await admin.unsafe(`DROP DATABASE ${database}`); await admin.end();
  }
});

describe('channel-free app object Blossom publication', () => {
  test('documents prepare and publication lifecycle routes', () => {
    const api = buildOpenApiDocument('http://localhost');
    expect(api.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/apps/{appNpub}/storage/prepare'].post.security).toEqual([{ nip98: [] }]);
    const route = api.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/apps/{appNpub}/storage/{storageObjectId}/blossom'];
    expect(route.put.requestBody.content['application/json'].schema.required).toEqual(['public', 'expected_sha256']);
    expect(route.delete.description).toContain('only the caller');
  });

  test('prepare requires membership, an enabled registered app and private storage', async () => {
    expect((await request(`${base()}/prepare`, 'POST', 3, { content_type: 'text/plain' })).status).toBe(403);
    expect((await request(`${base()}/prepare`, 'POST', 1, { content_type: 'text/plain', is_public: true })).status).toBe(400);
    expect((await request(`${base(workspaceId, 'npub1notcanonical')}/prepare`, 'POST', 1, { content_type: 'text/plain' })).status).toBe(400);
    const unregistered = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(107)));
    expect((await request(`${base(workspaceId, unregistered)}/prepare`, 'POST', 1, { content_type: 'text/plain' })).status).toBe(404);
    expect((await request(`${base()}/prepare`, 'POST', 1, { content_type: 'text/plain' }, { 'x-flightdeck-pg-app-npub': otherAppNpub })).status).toBe(403);
    const [binding] = await sql`SELECT count(*)::int AS n FROM flightdeck_pg_app_storage_objects`;
    expect(binding.n).toBe(0);
  });

  test('creator explicitly publishes verified bytes; ACLs, is_public and filename stay private', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]); const o = await appObject(bytes);
    expect((await app.request('/' + o.sha)).status).toBe(401);
    const status = await (await request(o.path, 'GET', 1)).json();
    expect(status).toMatchObject({ published_by_you: false, public: false, available: true, linked: false, can_publish: true, sha256_hex: o.sha });
    expect((await app.request(o.path, { method: 'PUT' })).status).toBe(401);
    expect((await request(o.path, 'PUT', 1, { public: true })).status).toBe(400);
    expect((await request(o.path, 'PUT', 1, { expected_sha256: o.sha })).status).toBe(400);
    expect((await request(o.path, 'PUT', 1, consent(hash('other')))).status).toBe(409);
    // Not the creator: owner/manager, another member and an outsider cannot see or publish it.
    for (const who of [0, 2]) expect((await request(o.path, 'PUT', who, consent(o.sha))).status).toBe(404);
    expect((await request(o.path, 'GET', 0)).status).toBe(404);
    expect((await request(o.path, 'PUT', 3, consent(o.sha))).status).toBe(403);
    // Wrong workspace or app in the path does not resolve the object.
    expect((await request(pubPath(o.id, otherWorkspaceId), 'PUT', 1, consent(o.sha))).status).toBe(404);
    expect((await request(pubPath(o.id, workspaceId, otherAppNpub), 'PUT', 1, consent(o.sha))).status).toBe(404);
    expect((await request(o.path, 'PUT', 1, consent(o.sha), { 'x-flightdeck-pg-app-npub': otherAppNpub })).status).toBe(403);

    const published = await request(o.path, 'PUT', 1, consent(o.sha)); expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ changed: true, published_by_you: true, publication_active: true, public: true, published_sha256: o.sha, blossom_url: `http://localhost/${o.sha}` });
    expect((await (await request(o.path, 'PUT', 1, consent(o.sha))).json()).changed).toBe(false);
    const get = await app.request('/' + o.sha); expect(get.status).toBe(200);
    expect(hash(new Uint8Array(await get.arrayBuffer()))).toBe(o.sha);
    expect(get.headers.get('content-disposition')).not.toContain('private-book');
    const head = await app.request('/' + o.sha, { method: 'HEAD' }); expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('6'); expect(await head.text()).toBe('');
    const range = await app.request('/' + o.sha, { headers: { Range: 'bytes=1-3' } }); expect(range.status).toBe(206);
    expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([2, 3, 4]);
    // An authenticated non-member reads the public bytes without private metadata.
    const outsider = await request('/' + o.sha, 'GET', 3); expect(outsider.status).toBe(200);
    expect(outsider.headers.get('content-disposition')).not.toContain('private-book');
    // An invalid token never falls back to public access.
    expect((await app.request('/' + o.sha, { headers: { Authorization: 'Nostr invalid' } })).status).toBe(401);
    const [storage] = await sql`SELECT * FROM v4_storage_objects WHERE id=${o.id}`;
    expect(storage).toMatchObject({ is_public: false, owner_npub: npubs[0], created_by_npub: npubs[1], access_group_ids: [] });

    expect((await request(o.path, 'DELETE', 2)).status).toBe(404);
    expect((await (await request(o.path, 'DELETE', 1)).json())).toMatchObject({ changed: true, published_by_you: false, public: false, blossom_url: null });
    expect((await app.request('/' + o.sha)).status).toBe(401);
    expect((await (await request(o.path, 'DELETE', 1)).json()).changed).toBe(false);
  });

  test('incomplete, linked and generic uploads are not publishable', async () => {
    const pending = await appObject(new Uint8Array([7, 7]), 1, false);
    expect((await request(pending.path, 'PUT', 1, consent(pending.sha))).status).toBe(409);
    // Generic PG upload by the same creator has no app binding.
    const generic = await prepareStorageObjectForAuthorizedOwner({ owner_npub: npubs[0], content_type: 'text/plain' }, npubs[1], { workspaceId });
    await writeStorageObject(generic.id, new Uint8Array([8]), npubs[1]); await completeStorageObject(generic.id, {}, npubs[1]);
    expect((await request(pubPath(generic.id), 'PUT', 1, consent(hash(new Uint8Array([8]))))).status).toBe(404);
    // Linking an app object into workspace content blocks new publication and withdraws an active one.
    const o = await appObject(new Uint8Array([9, 9, 9]));
    expect((await request(o.path, 'PUT', 1, consent(o.sha))).status).toBe(200);
    expect((await app.request('/' + o.sha)).status).toBe(200);
    const [scope] = await sql`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'Linked','project') RETURNING id`;
    const [channel] = await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scope.id},'Linked') RETURNING id`;
    await sql`INSERT INTO flightdeck_pg_files(workspace_id,scope_id,channel_id,storage_object_id,display_name,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspaceId},${scope.id},${channel.id},${o.id},'Linked',${actors[1]},${actors[1]})`;
    expect((await app.request('/' + o.sha)).status).toBe(401);
    expect((await (await request(o.path, 'GET', 1)).json())).toMatchObject({ linked: true, publication_active: false, can_publish: false });
    await request(o.path, 'DELETE', 1);
    expect((await request(o.path, 'PUT', 1, consent(o.sha))).status).toBe(409);
  });

  test('identical copies: revoking one publication leaves another publisher public', async () => {
    const bytes = new Uint8Array([21, 22, 23]);
    const a = await appObject(bytes, 1), b = await appObject(bytes, 2);
    expect((await request(a.path, 'PUT', 1, consent(a.sha))).status).toBe(200);
    expect((await request(b.path, 'PUT', 2, consent(b.sha))).status).toBe(200);
    await request(a.path, 'DELETE', 1);
    expect((await app.request('/' + a.sha)).status).toBe(200);
    expect((await (await request(a.path, 'GET', 1)).json())).toMatchObject({ published_by_you: false, publication_active: false, public: true });
    const [rows] = await sql`SELECT count(*)::int AS n FROM flightdeck_pg_app_blossom_publications WHERE storage_object_id=${b.id} AND revoked_at IS NULL`;
    expect(rows.n).toBe(1);
    await request(b.path, 'DELETE', 2);
    expect((await app.request('/' + a.sha)).status).toBe(401);
  });

  test('concurrent publish/unpublish converges on one row and one change', async () => {
    const o = await appObject(new Uint8Array([31, 32]));
    const puts = await Promise.all(Array.from({ length: 6 }, () => request(o.path, 'PUT', 1, consent(o.sha))));
    expect(puts.map(r => r.status)).toEqual(Array(6).fill(200));
    expect((await Promise.all(puts.map(r => r.json()))).filter(r => r.changed).length).toBe(1);
    const deletes = await Promise.all(Array.from({ length: 6 }, () => request(o.path, 'DELETE', 1)));
    expect((await Promise.all(deletes.map(r => r.json()))).filter(r => r.changed).length).toBe(1);
    const [rows] = await sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE revoked_at IS NULL)::int AS active FROM flightdeck_pg_app_blossom_publications WHERE storage_object_id=${o.id}`;
    expect(rows).toEqual({ n: 1, active: 0 });
    const [audit] = await sql`SELECT count(*)::int AS n FROM flightdeck_pg_audit_events WHERE resource_id=${o.id}`;
    expect(audit.n).toBe(2);
  });

  test('app disable, membership loss and byte changes withdraw public authority', async () => {
    const o = await appObject(new Uint8Array([41, 42, 43, 44]));
    expect((await request(o.path, 'PUT', 1, consent(o.sha))).status).toBe(200);
    await sql`UPDATE workspace_apps SET enabled=false WHERE app_npub=${appNpub}`;
    expect((await app.request('/' + o.sha)).status).toBe(401);
    expect((await request(o.path, 'PUT', 1, consent(o.sha))).status).toBe(409);
    expect((await request(`${base()}/prepare`, 'POST', 1, { content_type: 'text/plain' })).status).toBe(409);
    await sql`UPDATE workspace_apps SET enabled=true WHERE app_npub=${appNpub}`;
    expect((await app.request('/' + o.sha)).status).toBe(200);

    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NOW() WHERE workspace_id=${workspaceId} AND principal_actor_id=${actors[1]} AND permission='workspace.read'`;
    expect((await app.request('/' + o.sha)).status).toBe(401);
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${workspaceId} AND principal_actor_id=${actors[1]} AND permission='workspace.read'`;
    expect((await app.request('/' + o.sha)).status).toBe(200);

    // Tamper: the object now points at different bytes; the pinned hash no longer verifies.
    const other = await appObject(new Uint8Array([45, 46]));
    const [original] = await sql`SELECT storage_path FROM v4_storage_objects WHERE id=${o.id}`;
    const [swap] = await sql`SELECT storage_path FROM v4_storage_objects WHERE id=${other.id}`;
    await sql`UPDATE v4_storage_objects SET storage_path=${swap.storage_path} WHERE id=${o.id}`;
    expect((await app.request('/' + o.sha)).status).toBe(401);
    expect((await (await request(o.path, 'GET', 1)).json())).toMatchObject({ publication_active: false, public: false });
    expect((await request(o.path, 'PUT', 1, consent(o.sha))).status).toBe(409);
    expect((await request(o.path, 'PUT', 1, consent(other.sha))).status).toBe(409);
    await sql`UPDATE v4_storage_objects SET storage_path=${original.storage_path} WHERE id=${o.id}`;
    // Restored bytes match the pinned consent again once re-verified.
    expect((await (await request(o.path, 'GET', 1)).json())).toMatchObject({ publication_active: true, sha256_hex: o.sha });
    expect((await app.request('/' + o.sha)).status).toBe(200);

    // Membership removal path revokes explicitly; the publication does not come back.
    await sql`UPDATE flightdeck_pg_app_blossom_publications SET revoked_at=NOW() WHERE workspace_id=${workspaceId} AND actor_id=${actors[1]} AND revoked_at IS NULL`;
    await sql`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId} AND actor_id=${actors[1]}`;
    expect((await app.request('/' + o.sha)).status).toBe(401);
    expect((await request(o.path, 'GET', 1)).status).toBe(403);
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${actors[1]},'member')`;
    if (!(await sql`SELECT 1 FROM flightdeck_pg_permission_grants WHERE workspace_id=${workspaceId} AND principal_actor_id=${actors[1]} AND permission='workspace.read' AND revoked_at IS NULL`).length)
      await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${workspaceId},'actor',${actors[1]},'workspace','workspace.read')`;
    // Rejoining does not reactivate the earlier consent.
    expect((await app.request('/' + o.sha)).status).toBe(401);
    expect((await (await request(o.path, 'GET', 1)).json())).toMatchObject({ published_by_you: false, publication_active: false });
  });

  test('an open anonymous stream stops once the publication is revoked', async () => {
    const bytes = new Uint8Array(256 * 1024).map((_, i) => i % 251);
    const o = await appObject(bytes);
    expect((await request(o.path, 'PUT', 1, consent(o.sha))).status).toBe(200);
    const res = await app.request('/' + o.sha); expect(res.status).toBe(200);
    await request(o.path, 'DELETE', 1);
    await expect(new Response(res.body).arrayBuffer()).rejects.toThrow();
  });
});
