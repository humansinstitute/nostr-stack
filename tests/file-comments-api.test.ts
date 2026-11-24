import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { createApp } from '../src/server';
import { BILLABLE_STORAGE_TABLES } from '../src/services/hosting-storage-classification';
import { EXPORT_ADAPTERS } from '../src/services/workspace-export-adapters';
import { exportCoverage } from '../src/services/workspace-export-coverage';
import { unclassifiedFixtureCeiling } from '../src/services/agent-notifications';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest, writeStorageObject } from '../src/services/storage';

const port = Number(process.env.RECORD_TEST_PORT);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();

describe.skipIf(!port || port === 5432)('HTML artefact file comments and versioned review API', () => {
  const database = `file_comments_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: process.env.RECORD_TEST_USER || 'postgres', password: process.env.RECORD_TEST_PASSWORD ?? 'postgres', onnotice: () => {} };
  // 0 = owner/editor (file.read + file.write)
  // 1 = commenter A (file.read + comment.create ONLY — no file.write!)
  // 2 = commenter B (file.read + comment.create ONLY — no file.write!)
  // 3 = denied workspace member (no channel grants)
  const secrets = [201, 202, 203, 204].map((n) => new Uint8Array(32).fill(n));
  const npubs = secrets.map((secret) => nip19.npubEncode(getPublicKey(secret)));
  let db: ReturnType<typeof postgres>, app: ReturnType<typeof createApp>;
  let workspace: string, channelA: string, actors: string[];

  async function request(path: string, method = 'GET', actor = 0, body?: unknown) {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const event = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [['u', `http://localhost${path}`], ['method', method], ...(data ? [['payload', sha(encoder.encode(data))]] : [])],
    }, secrets[actor]!);
    const response = await app.request(path, {
      method,
      headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'Content-Type': 'application/json' },
      body: data,
    });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, body: type.includes('json') ? await response.json() as any : await response.text() };
  }
  const ws = (suffix: string) => `/api/v4/flightdeck-pg/workspaces/${workspace}${suffix}`;

  async function storeObject(bytes: Uint8Array, contentType = 'text/html') {
    const [row] = await db`
      INSERT INTO v4_storage_objects(owner_npub, created_by_npub, file_name, content_type, size_bytes, storage_path)
      VALUES (${npubs[0]!}, ${npubs[0]!}, 'artefact.html', ${contentType}, ${bytes.byteLength}, ${`test/${crypto.randomUUID()}`}) RETURNING id`;
    expect(await writeStorageObject(row!.id, bytes, npubs[0]!)).not.toBeNull();
    await db`UPDATE v4_storage_objects SET completed_at = NOW(), sha256_hex = ${sha(bytes)}, size_bytes = ${bytes.byteLength} WHERE id = ${row!.id}`;
    return row!.id as string;
  }

  async function createHtmlFile(name: string, html: string) {
    const bytes = encoder.encode(html);
    const objectId = await storeObject(bytes);
    const created = await request(ws(`/channels/${channelA}/files`), 'POST', 0, { storage_object_id: objectId, display_name: name });
    expect(created.status).toBe(201);
    const versions = await request(ws(`/files/${created.body.file.id}/versions`), 'GET', 0);
    return { fileId: created.body.file.id as string, versionId: versions.body.current_version_id as string, digest: sha(bytes) };
  }

  async function publishVersion(fileId: string, baseVersionId: string, html: string) {
    const bytes = encoder.encode(html);
    const objectId = await storeObject(bytes);
    const res = await request(ws(`/files/${fileId}/versions`), 'POST', 0, { base_version_id: baseVersionId, storage_object_id: objectId });
    expect(res.status).toBe(201);
    return { versionId: res.body.version.id as string, digest: sha(bytes) };
  }

  beforeAll(async () => {
    enableInMemoryStorageForTest();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    await admin.end();
    db = postgres({ ...connection, database });
    for (const stmt of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(stmt);
    await ensureRuntimeSchema(db);
    actors = [];
    for (const npub of npubs) {
      const [actor] = await db`INSERT INTO flightdeck_pg_actors(npub, kind) VALUES(${npub}, 'human') RETURNING id`;
      actors.push(actor!.id);
    }
    const [row] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub, workspace_service_npub, workspace_owner_npub, app_npub, name) VALUES('tower', 'service', ${npubs[0]!}, 'app', 'Review') RETURNING id`;
    workspace = row!.id;
    for (const [i, actor] of actors.entries()) {
      await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id, actor_id, role) VALUES(${workspace}, ${actor}, ${i === 0 ? 'owner' : 'member'})`;
    }
    const [scope] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id, name, kind) VALUES(${workspace}, 'Design', 'project') RETURNING id`;
    const [ch] = await db`INSERT INTO flightdeck_pg_channels(workspace_id, scope_id, name) VALUES(${workspace}, ${scope!.id}, 'Artefacts') RETURNING id`;
    channelA = ch!.id;
    for (const perm of ['file.read', 'file.write']) {
      await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id, principal_type, principal_actor_id, resource_type, resource_channel_id, permission) VALUES(${workspace}, 'actor', ${actors[0]!}, 'channel', ${channelA}, ${perm})`;
    }
    for (const idx of [1, 2]) {
      for (const perm of ['file.read', 'comment.create']) {
        await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id, principal_type, principal_actor_id, resource_type, resource_channel_id, permission) VALUES(${workspace}, 'actor', ${actors[idx]!}, 'channel', ${channelA}, ${perm})`;
      }
    }
    setDb(db);
    app = createApp({ agentCeiling: unclassifiedFixtureCeiling });
  });

  afterAll(async () => {
    resetInMemoryStorageForTest();
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  });

  test('threaded HTML comments, ACLs, spoof rejection, idempotency, concurrency, and v1/v2/v3 switching without mutating head', async () => {
    const f1 = await createHtmlFile('Landing.html', '<!doctype html><html><body><h1 id="hero">Version 1</h1><p>Alpha</p></body></html>');
    const f2 = await createHtmlFile('Other.html', '<!doctype html><html><body><p>Other</p></body></html>');
    const v2 = await publishVersion(f1.fileId, f1.versionId, '<!doctype html><html><body><h1 id="hero">Version 2</h1><p>Beta</p></body></html>');
    const v3 = await publishVersion(f1.fileId, v2.versionId, '<!doctype html><html><body><h1 id="hero">Version 3</h1><p>Gamma</p></body></html>');

    // v1/v2/v3 switch renders distinct content without changing head (v3).
    const htmlV1 = await request(ws(`/files/${f1.fileId}/html?version_id=${f1.versionId}`), 'GET', 1);
    expect(htmlV1.status).toBe(200);
    expect(htmlV1.body.content.html).toContain('Version 1');
    expect(htmlV1.body.content.version_number).toBe(1);
    expect(htmlV1.body.content.current_version_id).toBe(v3.versionId);
    expect(htmlV1.body.content.current_version_number).toBe(3);

    const htmlV2 = await request(ws(`/files/${f1.fileId}/html?version_id=${v2.versionId}`), 'GET', 1);
    expect(htmlV2.status).toBe(200);
    expect(htmlV2.body.content.html).toContain('Version 2');
    expect(htmlV2.body.content.current_version_id).toBe(v3.versionId);

    // Denied actor cannot read or write comments.
    expect((await request(ws(`/files/${f1.fileId}/comments`), 'GET', 3)).status).toBe(403);
    expect((await request(ws(`/files/${f1.fileId}/comments`), 'POST', 3, { body: 'Sneaky', file_version_id: v3.versionId })).status).toBe(403);

    // Author spoof rejected with 400.
    const spoof = await request(ws(`/files/${f1.fileId}/comments`), 'POST', 1, {
      body: 'Impersonating owner',
      file_version_id: v3.versionId,
      created_by_actor_npub: npubs[0],
    });
    expect(spoof.status).toBe(400);

    // Commenter A (comment.create only, NO file.write) posts root comment on v1 with HTML target anchor + idempotency key.
    const anchorV1 = {
      kind: 'html_element',
      element_id: 'hero',
      selector: '#hero',
      dom_path: [0],
      tag_name: 'h1',
      text_quote: 'Version 1',
      file_version_id: f1.versionId,
      version_digest: f1.digest,
    };
    const rootRes = await request(ws(`/files/${f1.fileId}/comments`), 'POST', 1, {
      body: 'Tighten hero headline spacing',
      file_version_id: f1.versionId,
      anchor: anchorV1,
      client_request_id: 'req-root-1',
    });
    expect(rootRes.status).toBe(201);
    const rootId = rootRes.body.comment.id as string;
    expect(rootRes.body.comment.created_by_actor_npub).toBe(npubs[1]);
    expect(rootRes.body.comment.file_version_id).toBe(f1.versionId);
    expect(rootRes.body.comment.file_version_number).toBe(1);
    expect(rootRes.body.comment.anchor.element_id).toBe('hero');

    // Idempotent retry (including simultaneous race) with same client_request_id returns same comment, no duplicate, no 500.
    const [replayA, replayB] = await Promise.all([
      request(ws(`/files/${f1.fileId}/comments`), 'POST', 1, {
        body: 'Tighten hero headline spacing',
        file_version_id: f1.versionId,
        anchor: anchorV1,
        client_request_id: 'req-root-1',
      }),
      request(ws(`/files/${f1.fileId}/comments`), 'POST', 1, {
        body: 'Tighten hero headline spacing',
        file_version_id: f1.versionId,
        anchor: anchorV1,
        client_request_id: 'req-root-1',
      }),
    ]);
    expect(replayA.status).toBe(200);
    expect(replayB.status).toBe(200);
    expect(replayA.body.comment.id).toBe(rootId);
    expect(replayB.body.comment.id).toBe(rootId);

    // Reusing same client_request_id with different payload is rejected with 409.
    const replayConflict = await request(ws(`/files/${f1.fileId}/comments`), 'POST', 1, {
      body: 'Completely different body',
      file_version_id: f1.versionId,
      anchor: anchorV1,
      client_request_id: 'req-root-1',
    });
    expect(replayConflict.status).toBe(409);

    // Cross-file version_id rejected on both GET and POST.
    expect((await request(ws(`/files/${f1.fileId}/comments?version_id=${f2.versionId}`), 'GET', 1)).status).toBe(404);
    expect((await request(ws(`/files/${f1.fileId}/comments`), 'POST', 1, { body: 'Wrong file version', file_version_id: f2.versionId })).status).toBe(404);

    // Cross-file parent rejected (404).
    const crossFile = await request(ws(`/files/${f2.fileId}/comments`), 'POST', 2, {
      body: 'Cross-file reply',
      parent_comment_id: rootId,
    });
    expect(crossFile.status).toBe(404);

    // Simultaneous replies from two authenticated actors survive and inherit root's version & anchor.
    const [replyA, replyB] = await Promise.all([
      request(ws(`/files/${f1.fileId}/comments`), 'POST', 2, {
        body: 'Agreed, let us reduce top margin',
        parent_comment_id: rootId,
        file_version_id: v3.versionId, // server must inherit root's v1!
      }),
      request(ws(`/files/${f1.fileId}/comments`), 'POST', 0, {
        body: 'Updated in v3!',
        parent_comment_id: rootId,
      }),
    ]);
    expect(replyA.status).toBe(201);
    expect(replyB.status).toBe(201);
    expect(replyA.body.comment.file_version_id).toBe(f1.versionId);
    expect(replyA.body.comment.anchor.element_id).toBe('hero');
    expect(replyB.body.comment.file_version_id).toBe(f1.versionId);

    // Nested reply-to-reply rejected.
    const nested = await request(ws(`/files/${f1.fileId}/comments`), 'POST', 1, {
      body: 'Nested',
      parent_comment_id: replyA.body.comment.id,
    });
    expect(nested.status).toBe(400);

    // Body edit: arbitrary commenter B cannot edit commenter A's comment (403); author A can edit with row_version; stale row_version -> 409.
    expect((await request(ws(`/files/${f1.fileId}/comments/${rootId}`), 'PATCH', 2, { body: 'Hijack', row_version: 1 })).status).toBe(403);
    const editOk = await request(ws(`/files/${f1.fileId}/comments/${rootId}`), 'PATCH', 1, { body: 'Tighten hero headline spacing (edited)', row_version: 1 });
    expect(editOk.status).toBe(200);
    expect(editOk.body.comment.row_version).toBe(2);
    expect((await request(ws(`/files/${f1.fileId}/comments/${rootId}`), 'PATCH', 1, { body: 'Stale edit', row_version: 1 })).status).toBe(409);

    // Resolve/reopen policy: commenter B (not author, not file.write, not mod) cannot resolve A's thread (403); owner/editor (file.write) CAN resolve; author CAN reopen.
    expect((await request(ws(`/files/${f1.fileId}/comments/${rootId}`), 'PATCH', 2, { comment_status: 'resolved', row_version: 2 })).status).toBe(403);
    const resolved = await request(ws(`/files/${f1.fileId}/comments/${rootId}`), 'PATCH', 0, { comment_status: 'resolved', row_version: 2 });
    expect(resolved.status).toBe(200);
    expect(resolved.body.comment.comment_status).toBe('resolved');
    expect(resolved.body.comment.row_version).toBe(3);

    // Status filter filters by root thread status: resolved root hides its replies from ?status=open and includes them in ?status=resolved.
    const openWhileResolved = await request(ws(`/files/${f1.fileId}/comments?status=open`), 'GET', 1);
    expect(openWhileResolved.status).toBe(200);
    expect(openWhileResolved.body.comments.length).toBe(0);
    const resolvedThreads = await request(ws(`/files/${f1.fileId}/comments?status=resolved`), 'GET', 1);
    expect(resolvedThreads.status).toBe(200);
    expect(resolvedThreads.body.comments.length).toBe(3);

    const reopened = await request(ws(`/files/${f1.fileId}/comments/${rootId}`), 'PATCH', 1, { comment_status: 'open', row_version: 3 });
    expect(reopened.status).toBe(200);
    expect(reopened.body.comment.comment_status).toBe('open');

    // Reply cannot be resolved directly (400).
    expect((await request(ws(`/files/${f1.fileId}/comments/${replyA.body.comment.id}`), 'PATCH', 2, { comment_status: 'resolved', row_version: 1 })).status).toBe(400);

    // Listing reflects shared state + accurate permissions for commenter A (can_comment=true, can_resolve_any=false, can_edit_source=false).
    const listA = await request(ws(`/files/${f1.fileId}/comments`), 'GET', 1);
    expect(listA.status).toBe(200);
    expect(listA.body.comments.length).toBe(3);
    expect(listA.body.permissions.can_comment).toBe(true);
    expect(listA.body.permissions.can_resolve_any).toBe(false);
    expect(listA.body.permissions.can_edit_source).toBe(false);
    expect(listA.body.comments.find((c: any) => c.id === rootId).can_resolve).toBe(true);

    // DELETE requires positive row_version and cascades soft-delete to replies without stranding them.
    expect((await request(ws(`/files/${f1.fileId}/comments/${rootId}`), 'DELETE', 1)).status).toBe(400);
    expect((await request(ws(`/files/${f1.fileId}/comments/${rootId}?row_version=1`), 'DELETE', 1)).status).toBe(409);
    const delRoot = await request(ws(`/files/${f1.fileId}/comments/${rootId}?row_version=4`), 'DELETE', 1);
    expect(delRoot.status).toBe(200);
    const afterDelete = await request(ws(`/files/${f1.fileId}/comments`), 'GET', 1);
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.comments.length).toBe(0);

    // Simultaneous FIRST creation race with a brand-new client_request_id: one 201, one 200 replay, same ID, zero 500s.
    const [raceA, raceB] = await Promise.all([
      request(ws(`/files/${f1.fileId}/comments`), 'POST', 1, {
        body: 'Simultaneous first create',
        file_version_id: v2.versionId,
        client_request_id: 'req-first-race-1',
      }),
      request(ws(`/files/${f1.fileId}/comments`), 'POST', 1, {
        body: 'Simultaneous first create',
        file_version_id: v2.versionId,
        client_request_id: 'req-first-race-1',
      }),
    ]);
    expect([raceA.status, raceB.status].sort()).toEqual([200, 201]);
    expect(raceA.body.comment.id).toBe(raceB.body.comment.id);

    // Export adapter & billable storage classification verification against disposable DB.
    expect(BILLABLE_STORAGE_TABLES.includes('flightdeck_pg_file_comments' as any)).toBe(true);
    const cov = exportCoverage();
    expect(cov.content_tables).toContain('flightdeck_pg_file_comments');
    expect(cov.uncovered.some((u) => u.table === 'flightdeck_pg_file_comments')).toBe(false);
    const adapter = EXPORT_ADAPTERS.find((a) => a.table === 'flightdeck_pg_file_comments')!;
    expect(adapter).toBeDefined();
    const exportedRows = await db.unsafe<any[]>(
      `SELECT t.*, ${adapter.channel} AS _channel FROM ${adapter.from} WHERE t.workspace_id = $1 AND ${adapter.where} ORDER BY ${adapter.key}`,
      [workspace],
    );
    expect(exportedRows.length).toBe(1);
    expect(exportedRows[0].id).toBe(raceA.body.comment.id);
    expect(adapter.refs(exportedRows[0])).toEqual([{ f: 'file', i: f1.fileId }]);
    const allowedVisible = await adapter.allow!(exportedRows[0], {
      viewer: { workspaceId: workspace, actorId: actors[1]!, npub: npubs[1]!, appNpub: 'app' },
      visible: async () => true,
      sql: db,
      canvasIds: async () => new Set(),
      canManage: async () => false,
    });
    const deniedVisible = await adapter.allow!(exportedRows[0], {
      viewer: { workspaceId: workspace, actorId: actors[3]!, npub: npubs[3]!, appNpub: 'app' },
      visible: async () => false,
      sql: db,
      canvasIds: async () => new Set(),
      canManage: async () => false,
    });
    expect(allowedVisible).toBe(true);
    expect(deniedVisible).toBe(false);

    // Audit & outbox events recorded with entity_id = file.id (never nonexistent comment ID) and without mutating file row_version.
    const audits = await db`SELECT action FROM flightdeck_pg_audit_events WHERE workspace_id = ${workspace} AND resource_type = 'file_comment'`;
    expect(audits.length).toBeGreaterThanOrEqual(5);
    const outbox = await db`SELECT entity_type, entity_id, event_type FROM flightdeck_pg_outbox_events WHERE workspace_id = ${workspace} AND event_type LIKE 'flightdeck_pg.file_comment.%'`;
    expect(outbox.length).toBeGreaterThanOrEqual(5);
    for (const row of outbox) {
      expect(row.entity_type).toBe('file');
      expect(row.entity_id).toBe(f1.fileId);
    }
  });
});
