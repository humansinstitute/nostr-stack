import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { getDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { unclassifiedFixtureCeiling } from '../src/services/agent-notifications';
import { updateFlightDeckPgThread } from '../src/services/flightdeck-pg-api';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';
import { validateFlightDeckPgThreadUpdate as validate } from '../src/services/flightdeck-pg-thread-update';

describe('thread metadata input contract', () => {
  test('published request schema requires CAS even with combined metadata/title', async () => {
    const spec = await (await createApp().request('/openapi.json')).json() as any;
    const schema = spec.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/threads/{threadId}'].patch.requestBody.content['application/json'].schema;
    const check = new Ajv({ strict: false }).compile(schema);
    for (const body of [{ title: 'Rename' }, { metadata: {}, row_version: 1 }, { title: 'Combined', metadata: {}, row_version: 2 }]) expect(check(body)).toBe(true);
    for (const body of [{}, { title: 'Combined', metadata: {} }, { metadata: {} }, { metadata: null, row_version: 1 }, { metadata: {}, row_version: '1' }]) expect(check(body)).toBe(false);
  });
  test('supports rename, replacement and combined operations', () => {
    expect(validate({ title: '  New\n title ' }).update).toEqual({ title: 'New title' });
    expect(validate({ metadata: {}, row_version: 1 }).fields).toEqual([]);
    expect(validate({ title: 'New', metadata: { review: { checklist: [true, null, 2] } }, row_version: 3 }).fields).toEqual([]);
  });
  test('rejects empty, invalid, oversized and deeply nested operations', () => {
    for (const input of [null, [], 1, {}, { row_version: 1 }, { title: '' }, { metadata: null, row_version: 1 }, { metadata: [], row_version: 1 }, { metadata: 'x', row_version: 1 }, { metadata: { n: Infinity }, row_version: 1 }, { metadata: { n: '\u0000' }, row_version: 1 }, { metadata: { n: '\ud800' }, row_version: 1 }]) expect(validate(input).fields.length).toBeGreaterThan(0);
    for (const row_version of [undefined, null, 0, -1, 1.5, true, '1', 2147483648]) expect(validate({ metadata: {}, row_version }).fields.some(f => f.path === 'row_version')).toBe(true);
    expect(validate({ metadata: { text: 'é'.repeat(32768) }, row_version: 1 }).fields.length).toBeGreaterThan(0);
    expect(validate({ metadata: { a: Array(8192).fill(0) }, row_version: 1 }).fields.length).toBeGreaterThan(0);
    let nested: any = {}; for (let i = 0; i < 33; i++) nested = { nested };
    expect(validate({ metadata: nested, row_version: 1 }).fields.length).toBeGreaterThan(0);
    expect(validate({ metadata: { text: 'x'.repeat(65525) }, row_version: 1 }).fields).toEqual([]); // exactly 65536 bytes
  });
});

// Explicit task-owned disposable PG only; never use runtime credentials or databases.
const port = Number(process.env.THREAD_METADATA_TEST_PORT);
describe.skipIf(!port || port === 5432)('thread metadata signed HTTP + PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const database = `thread_metadata_${process.pid}_${Date.now()}`;
  const keys = Array.from({ length: 4 }, () => generateSecretKey());
  const npubs = keys.map(key => nip19.npubEncode(getPublicKey(key)));
  const appNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
  // The fixture bot is intentionally unclassified. Production admission is unchanged.
  const app = createApp({ agentCeiling: unclassifiedFixtureCeiling });
  let db: ReturnType<typeof postgres>, previous: ReturnType<typeof postgres>;
  let workspace: string, foreignWorkspace: string, scope: string, channel: string;
  const actors: string[] = [];
  beforeAll(async () => {
    const admin = postgres({ ...conn, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...conn, database }); previous = getDb(); setDb(db);
    for (const stmt of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(stmt);
    await ensureRuntimeSchema(db);
    for (let i = 0; i < keys.length; i++) {
      const [a] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npubs[i]!},${i === 2 ? 'agent' : 'human'}) RETURNING id`; actors.push(a!.id);
    }
    for (let i = 0; i < 2; i++) {
      const [w] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
        VALUES(${`tower-${i}`},${`workspace-${i}`},${npubs[0]!},${appNpub},'Thread metadata test') RETURNING id`;
      if (i === 0) workspace = w!.id; else foreignWorkspace = w!.id;
      for (const actor of actors.slice(0, 3)) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w!.id},${actor},'member')`;
    }
    const [s] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspace},'Test','project') RETURNING id`; scope = s!.id;
    const [c] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspace},${scope},'Test') RETURNING id`; channel = c!.id;
    for (const actor of actors.slice(0, 3)) for (const permission of ['channel.read', ...(actor === actors[1] ? [] : ['channel.write'])]) {
      await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
        VALUES(${workspace},'actor',${actor},'channel',${channel},${permission})`;
    }
  }, 60000);
  afterAll(async () => {
    if (previous) setDb(previous); await db?.end();
    const admin = postgres({ ...conn, database: 'postgres' }); await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
  });
  async function thread(metadata: object = { other_app: { keep: true } }) {
    const [row] = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,latest,metadata,activity_version,attention,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspace},${scope},${channel},'Original title','Latest message',${db.json(metadata as any)},7,${db.json({ policy_version: 1, mention_activity_versions: {} })},${actors[0]!},${actors[0]!}) RETURNING *`;
    return row!;
  }
  async function stored(id: string) { return (await db`SELECT * FROM flightdeck_pg_threads WHERE id=${id}`)[0]!; }
  async function request(id: string, body?: unknown, actor = 0, targetWorkspace = workspace, rawBody?: string) {
    const method = body === undefined && rawBody === undefined ? 'GET' : 'PATCH';
    const path = `/api/v4/flightdeck-pg/workspaces/${targetWorkspace}/threads/${id}`;
    const raw = rawBody ?? (body === undefined ? '' : JSON.stringify(body));
    const tags = [['u', `http://localhost${path}`], ['method', method]];
    if (method === 'PATCH') tags.push(['payload', createHash('sha256').update(raw).digest('hex')]);
    const signed = finalizeEvent({ kind: 27235, content: '', created_at: Math.floor(Date.now() / 1000), tags }, keys[actor]!);
    const response = await app.request(path, { method, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(signed)).toString('base64')}`, 'content-type': 'application/json', 'x-flightdeck-pg-app-npub': appNpub }, ...(method === 'PATCH' ? { body: raw } : {}) });
    const text = await response.text();
    let json: any; try { json = JSON.parse(text); } catch { json = { error: text }; }
    return { status: response.status, json };
  }
  test('legacy rename preserves metadata; replacement and combined save preserve canonical fields', async () => {
    const original = await thread();
    const rename = await request(original.id, { title: ' Renamed\n thread ' }); expect(rename.status).toBe(200); expect(rename.json.audit.operation).toBe('thread.rename');
    expect((await stored(original.id)).metadata).toEqual(original.metadata);
    const [renameEvent] = await db`SELECT operation,payload FROM flightdeck_pg_outbox_events WHERE id=${rename.json.outbox.id}`;
    expect(renameEvent!.operation).toBe('renamed'); expect(renameEvent!.payload).toEqual({ thread_id: original.id, title: 'Renamed thread' });
    expect((await request(original.id, { title: 'Stale rename', metadata: {}, row_version: 1 })).status).toBe(409);
    expect((await stored(original.id)).title).toBe('Renamed thread');
    const metadata = { ...original.metadata, independent_review: { checklist: ['one'], refs: [randomUUID()] } };
    const result = await request(original.id, { metadata, row_version: rename.json.thread.row_version, latest: 'Forbidden', attention: {}, channel_id: randomUUID(), activity_version: 1000 });
    expect(result.status).toBe(200); expect(result.json.audit.operation).toBe('thread.update');
    const saved = await stored(original.id);
    for (const field of ['workspace_id', 'channel_id', 'scope_id', 'latest', 'attention', 'activity_version', 'created_by_actor_id', 'source_message_id', 'parent_thread_id', 'created_at']) expect(saved[field]).toEqual(original[field]);
    expect(saved.title).toBe('Renamed thread'); expect(saved.metadata).toEqual(metadata); expect(saved.row_version).toBe(3);
    const combined = await request(original.id, { title: 'Combined', metadata: {}, row_version: 3 }); expect(combined.status).toBe(200);
    expect(combined.json.thread.title).toBe('Combined'); expect(combined.json.thread.metadata).toEqual({});
    const readback = await request(original.id); expect(readback.json.thread.row_version).toBe(4); expect(readback.json.thread.metadata).toEqual({});
  });
  test('stale and competing writes have exactly one winner; refetch/reapply preserves winner', async () => {
    const row = await thread();
    const results = await Promise.all(['a', 'b'].map(key => request(row.id, { metadata: { ...row.metadata, [key]: true }, row_version: row.row_version })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409)!.json.code).toBe('stale_row_version');
    const current = (await request(row.id)).json.thread;
    const missing = current.metadata.a ? 'b' : 'a';
    expect((await request(row.id, { metadata: { ...current.metadata, [missing]: true }, row_version: current.row_version })).status).toBe(200);
    expect((await stored(row.id)).metadata).toEqual({ ...row.metadata, a: true, b: true });
    expect((await db`SELECT id FROM flightdeck_pg_outbox_events WHERE entity_id=${row.id}`).length).toBe(2);
  });
  test('rejects malformed, empty, invalid and oversized metadata without side effects', async () => {
    const row = await thread();
    for (const body of [{}, { row_version: 1 }, [], { metadata: null, row_version: 1 }, { metadata: [], row_version: 1 }, { metadata: 1, row_version: 1 }, { metadata: {}, row_version: '1' }, { metadata: {} }, { metadata: {}, row_version: 0 }, { metadata: {}, row_version: -1 }, { metadata: {}, row_version: 1.5 }, { metadata: {}, row_version: true }, { metadata: {}, row_version: null }, { metadata: { s: '\ud800' }, row_version: 1 }, { metadata: { s: 'x'.repeat(65536) }, row_version: 1 }]) expect((await request(row.id, body)).status).toBe(400);
    expect((await request(row.id, undefined, 0, workspace, '{')).status).toBe(400);
    expect(await stored(row.id)).toEqual(row);
    expect((await db`SELECT id FROM flightdeck_pg_outbox_events WHERE entity_id=${row.id}`).length).toBe(0);
    await expect(updateFlightDeckPgThread({ workspaceId: workspace, threadId: row.id, actorId: actors[0]!, metadata: {} }, db)).rejects.toThrow('row_version');
  });
  test('denies cross-workspace, reader, nonmember and nonparticipant bot writes; permits participant', async () => {
    const row = await thread(); const body = { metadata: {}, row_version: 1 };
    expect((await request(row.id, body, 0, foreignWorkspace)).status).toBe(404);
    expect((await request(row.id, body, 1)).status).toBe(403);
    expect((await request(row.id, body, 3)).status).toBe(403);
    const denied = await request(row.id, body, 2); expect(denied.status).toBe(403); expect(denied.json.code).toBe('thread_participation_required');
    expect(await stored(row.id)).toEqual(row);
    await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspace},${scope},${channel},${row.id},'Bot participates',${actors[2]!},${actors[2]!})`;
    expect((await request(row.id, body, 2)).status).toBe(200);
  });
  test('commits audit, outbox and canonical record delta without message or activity changes', async () => {
    const row = await thread();
    let page = await readFlightDeckRecordPage({ workspaceId: workspace, actorId: actors[0]! }, db);
    while (page.has_more) page = await readFlightDeckRecordPage({ workspaceId: workspace, actorId: actors[0]!, cursor: page.next_cursor }, db);
    const result = await request(row.id, { metadata: { review_app: { checklist: ['done'] } }, row_version: 1 }); expect(result.status).toBe(200);
    const [event] = await db`SELECT * FROM flightdeck_pg_outbox_events WHERE id=${result.json.outbox.id}`;
    expect(event!.event_type).toBe('flightdeck_pg.thread.updated'); expect(event!.operation).toBe('updated'); expect(Number(event!.entity_row_version)).toBe(2);
    expect(event!.payload.thread.metadata).toEqual(result.json.thread.metadata); expect(event!.payload.thread_id).toBe(row.id);
    expect(event!.row_version).toBe(result.json.outbox.row_version);
    // Existing SSE replays the committed outbox without a synthetic chat message.
    const streamPath = `/api/v4/flightdeck-pg/workspaces/${workspace}/events/stream`;
    const streamAuth = finalizeEvent({ kind: 27235, content: '', created_at: Math.floor(Date.now() / 1000), tags: [['u', `http://localhost${streamPath}`], ['method', 'GET']] }, keys[0]!);
    const abort = new AbortController();
    const stream = await app.request(streamPath, { signal: abort.signal, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(streamAuth)).toString('base64')}` } });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader(); let received = '';
    const timeout = setTimeout(() => abort.abort(), 3000);
    try {
      while (!received.includes(result.json.outbox.id)) {
        const chunk = await reader.read(); if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received).toContain(result.json.outbox.id);
      expect(received).toContain('review_app');
    } finally { clearTimeout(timeout); await reader.cancel(); abort.abort(); }

    const [audit] = await db`SELECT * FROM flightdeck_pg_audit_events WHERE id=${result.json.audit.event_id}`;
    expect(audit!.action).toBe('thread.update'); expect(audit!.resource_id).toBe(row.id); expect(audit!.metadata.changed_fields).toEqual(['metadata']);
    const delta = await readFlightDeckRecordPage({ workspaceId: workspace, actorId: actors[0]!, cursor: page.next_cursor }, db);
    expect(JSON.stringify(delta)).toContain('review_app');
    expect((await stored(row.id)).activity_version).toBe(row.activity_version);
    expect((await db`SELECT id FROM flightdeck_pg_messages WHERE thread_id=${row.id}`).length).toBe(0);
  });
  test('outbox failure rolls back canonical row, audit and record journal', async () => {
    const row = await thread();
    const journal = await db`SELECT * FROM flightdeck_pg_record_journal WHERE id=${row.id}`;
    await db.unsafe(`CREATE FUNCTION test_reject_thread_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test outbox failure'; END $$`);
    await db.unsafe(`CREATE TRIGGER test_reject_thread_event BEFORE INSERT ON flightdeck_pg_outbox_events FOR EACH ROW WHEN (NEW.entity_id = '${row.id}'::uuid) EXECUTE FUNCTION test_reject_thread_event()`);
    try { expect((await request(row.id, { title: 'Must rollback', metadata: {}, row_version: 1 })).status).toBe(500); }
    finally { await db.unsafe('DROP TRIGGER test_reject_thread_event ON flightdeck_pg_outbox_events'); await db.unsafe('DROP FUNCTION test_reject_thread_event()'); }
    expect(await stored(row.id)).toEqual(row);
    expect((await db`SELECT id FROM flightdeck_pg_audit_events WHERE resource_id=${row.id}`).length).toBe(0);
    expect(Array.from(await db`SELECT * FROM flightdeck_pg_record_journal WHERE id=${row.id}`)).toEqual(Array.from(journal));
  });
});
