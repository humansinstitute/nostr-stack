import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest, writeAuthorizedStorageBytes } from '../src/services/storage';
import { finalizeWorkspaceExport, readWorkspaceExportPage, startWorkspaceExport, EXPORT_MAX_OPEN_SESSIONS } from '../src/services/workspace-export';
import { EXPORT_COVERED_TABLES, EXPORT_UNCOVERED, exportCoverage } from '../src/services/workspace-export-coverage';
import { buildOpenApiDocument } from '../src/openapi';
import { BILLABLE_STORAGE_TABLES } from '../src/services/hosting-storage-classification';

// Runs only against a dedicated disposable PostgreSQL: EXPORT_TEST_PORT=<free port>.
const port = Number(process.env.EXPORT_TEST_PORT);
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const keyOf = () => randomBytes(32);
const ownerKey = keyOf(), readerKey = keyOf(), outsiderKey = keyOf();
const npubOf = (key: Uint8Array) => nip19.npubEncode(getPublicKey(key));
const [owner, reader, outsider] = [ownerKey, readerKey, outsiderKey].map(npubOf) as [string, string, string];
const app = createApp();

describe.skipIf(!port || port === 5432)('migration export on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_export_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  let ws: string, scope: string, open: string, closed: string, ownerId: string, readerId: string;
  const objects: Record<string, { id: string; bytes: Uint8Array; path: string }> = {};
  const ids: Record<string, string> = {};

  async function object(label: string, content: string, over: Record<string, unknown> = {}) {
    const bytes = new TextEncoder().encode(content), path = `fixture/${name}/${label}`;
    const [row] = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,sha256_hex,storage_path,completed_at,pg_workspace_id)
      VALUES(${owner},${owner},'text/plain',${bytes.length},${sha(bytes)},${path},now(),${ws}) RETURNING *`;
    await writeAuthorizedStorageBytes(row as any, bytes);
    objects[label] = { id: row!.id, bytes, path };
    void over;
    return row!.id as string;
  }
  async function grant(actor: string, channel: string | null, permission: string) {
    if (channel) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${ws},'actor',${actor},'channel',${channel},${permission})`;
    else await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${ws},'actor',${actor},'workspace',${permission})`;
  }
  async function message(channel: string, body: string, metadata: Record<string, unknown> = {}) {
    const [m] = await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,metadata,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${scope},${channel},${body},${db.json(metadata as any)},${ownerId},${ownerId}) RETURNING id`;
    return m!.id as string;
  }
  async function http(method: 'GET' | 'POST', path: string, key: Uint8Array, body?: unknown) {
    const url = `http://localhost/api/v4/hosting-billing/workspaces/${ws}${path}`;
    const raw = method === 'POST' ? JSON.stringify(body ?? {}) : undefined;
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(), tags: [['u', url], ['method', method], ...(raw ? [['payload', sha(raw)]] : [])] }, key);
    const response = await app.request(url, { method, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` }, body: raw });
    return { status: response.status, json: (await response.json().catch(() => ({}))) as any };
  }
  /** Drives a whole export through the service and verifies the client-side chain the manifest advertises. */
  async function run(actor: string, limit = 200) {
    const started = await startWorkspaceExport(ws, actor, db as any);
    const seen: Record<string, any[]> = { records: [], content: [], history: [], assets: [] };
    const chains: Record<string, string> = {};
    for (const section of ['records', 'content', 'history', 'assets'] as const) {
      let cursor: string | null = null, chain = sha('nstack-export-v1');
      for (let i = 0; i < 200; i++) {
        const page: any = await readWorkspaceExportPage(ws, started.export_id, actor, { section, cursor, limit }, db as any);
        seen[section]!.push(...page.items);
        const identities = page.items.map((item: any) => item.kind === 'table_row' ? `table_row:${item.table}:${item.key}` : item.kind === 'record' ? `record:${item.family}:${item.id}:${item.position}`
          : item.kind === 'asset' ? `asset:${item.object_id}:${item.status}:${item.sha256_hex ?? ''}`
          : item.kind === 'doc_recovery_version' ? `${item.kind}:${item.row.id}:0`
          : item.kind === 'doc_version' ? `${item.kind}:${item.row.doc_id}:${item.row.row_version}`
          : item.kind === 'file_version' ? `${item.kind}:${item.row.file_id}:${item.row.version_number}` : `${item.kind}:${item.row.daily_note_id}:${item.row.row_version}`);
        expect(page.page.digest).toBe(sha(identities.join('\n')));
        chain = sha(`${chain}\n${page.page.digest}`);
        expect(page.progress.chain).toBe(chain);
        if (page.next_cursor === null) break;
        cursor = page.next_cursor;
      }
      chains[section] = chain;
    }
    const result = await finalizeWorkspaceExport(ws, started.export_id, actor, db as any);
    for (const section of ['records', 'content', 'history', 'assets'] as const) {
      expect((result.manifest as any).sections[section]).toMatchObject({ items: seen[section]!.length, chain: chains[section] });
    }
    return { started, seen, ...result, manifest: result.manifest as any };
  }

  beforeAll(async () => {
    enableInMemoryStorageForTest();
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    [{ id: ownerId }] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${owner},'human') RETURNING id` as any;
    [{ id: readerId }] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${reader},'human') RETURNING id` as any;
    await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${outsider},'human')`;
    ws = randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${ws},'tower',${ws},${owner},'export-app','Export fixture')`;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${ws},${ownerId},'owner'),(${ws},${readerId},'member')`;
    [{ id: scope }] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${ws},'Export','project') RETURNING id` as any;
    [{ id: open }] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${ws},${scope},'Open') RETURNING id` as any;
    [{ id: closed }] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${ws},${scope},'Closed') RETURNING id` as any;
    await grant(ownerId, null, 'workspace.manage');
    for (const channel of [open, closed]) for (const permission of ['channel.read', 'doc.read', 'file.read', 'task.read']) await grant(ownerId, channel, permission);
    for (const permission of ['channel.read', 'doc.read', 'file.read', 'task.read']) await grant(readerId, open, permission);

    // Open channel: messages (one with an attachment), a doc with two versions, a file with a version, a task.
    const attachment = await object('attachment', 'attached bytes');
    ids.m1 = await message(open, 'first');
    ids.m2 = await message(open, 'with attachment', { attachments: [{ storage_object_id: attachment }] });
    await db`INSERT INTO flightdeck_pg_storage_links(workspace_id,scope_id,channel_id,entity_type,entity_id,storage_object_id) VALUES(${ws},${scope},${open},'message',${ids.m2},${attachment})`;
    const docV1 = await object('doc-v1', '# v1'), docV2 = await object('doc-v2', '# v2 body');
    [{ id: ids.doc }] = await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,title,storage_object_id,created_by_actor_id,updated_by_actor_id,row_version) VALUES(${ws},${scope},${open},'Doc',${docV2},${ownerId},${ownerId},2) RETURNING id` as any;
    await db`INSERT INTO flightdeck_pg_doc_versions(workspace_id,doc_id,row_version,scope_id,channel_id,storage_object_id,title,actor_id,operation) VALUES(${ws},${ids.doc},1,${scope},${open},${docV1},'Doc',${ownerId},'created'),(${ws},${ids.doc},2,${scope},${open},${docV2},'Doc',${ownerId},'updated')`;
    const fileV1 = await object('file-v1', 'file bytes');
    [{ id: ids.file }] = await db`INSERT INTO flightdeck_pg_files(workspace_id,scope_id,channel_id,storage_object_id,display_name,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${scope},${open},${fileV1},'File',${ownerId},${ownerId}) RETURNING id` as any;
    await db`INSERT INTO flightdeck_pg_file_versions(workspace_id,file_id,version_number,storage_object_id,created_by_actor_id) VALUES(${ws},${ids.file},1,${fileV1},${ownerId})`;
    [{ id: ids.task }] = await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${scope},${open},'Task',${ownerId},${ownerId}) RETURNING id` as any;
    // Closed channel: only the owner may read it.
    ids.secret = await message(closed, 'owner only');
    const secretDoc = await object('secret-doc', 'secret');
    [{ id: ids.secretDoc }] = await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,title,storage_object_id,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${scope},${closed},'Secret',${secretDoc},${ownerId},${ownerId}) RETURNING id` as any;
    await db`INSERT INTO flightdeck_pg_doc_versions(workspace_id,doc_id,row_version,scope_id,channel_id,storage_object_id,title,actor_id,operation) VALUES(${ws},${ids.secretDoc},1,${scope},${closed},${secretDoc},'Secret',${ownerId},'created')`;

    // Content outside the record families: each table follows the read rule of its own route.
    await db`INSERT INTO flightdeck_pg_reactions(workspace_id,scope_id,channel_id,target_type,target_id,emoji,emoji_shortcode,reactor_actor_id,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${scope},${open},'message',${ids.m1},'thumbs_up',':thumbs_up:',${ownerId},${ownerId},${ownerId})`;
    await db`INSERT INTO flightdeck_pg_task_watchers(workspace_id,scope_id,channel_id,task_id,actor_id,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${scope},${open},${ids.task},${ownerId},${ownerId},${ownerId})`;
    const workroom = async (channel: string, title: string) => {
      const [w] = await db`INSERT INTO flightdeck_pg_workrooms(workspace_id,scope_id,channel_id,title,goal,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${scope},${channel},${title},'goal',${ownerId},${ownerId}) RETURNING id`;
      await db`INSERT INTO flightdeck_pg_workroom_participants(workspace_id,workroom_id,actor_npub,kind,role) VALUES(${ws},${w!.id},${owner},'human','contributor')`;
      await db`INSERT INTO flightdeck_pg_workroom_events(workspace_id,workroom_id,scope_id,channel_id,event_type) VALUES(${ws},${w!.id},${scope},${channel},'created')`;
      await db`INSERT INTO flightdeck_pg_workroom_links(workspace_id,workroom_id,scope_id,channel_id,link_type,target_type,external_url) VALUES(${ws},${w!.id},${scope},${channel},'external_url','external_url','https://example.test/pr/1')`;
      return w!.id as string;
    };
    ids.workroom = await workroom(open, 'Open room'); ids.closedWorkroom = await workroom(closed, 'Closed room');
    const approval = async (target: string, type: string) => (await db`INSERT INTO flightdeck_pg_approvals(workspace_id,target_type,target_id,action,requested_by_actor_id,requested_by_npub) VALUES(${ws},${type},${target},'merge',${ownerId},${owner}) RETURNING id`)[0]!.id as string;
    ids.approvalOpen = await approval(ids.workroom, 'workroom'); ids.approvalClosed = await approval(ids.closedWorkroom, 'workroom'); ids.approvalDoc = await approval(ids.doc, 'doc');
    const invocation = async (channel: string, recipients: unknown[]) => (await db`INSERT INTO flightdeck_pg_invocations(workspace_id,scope_id,channel_id,created_by_actor_id,prompt,recipients) VALUES(${ws},${scope},${channel},${ownerId},'please',${db.json(recipients as any)}) RETURNING id`)[0]!.id as string;
    ids.invOpen = await invocation(open, []); ids.invRecipient = await invocation(closed, [{ npub: reader, type: 'person' }]); ids.invHidden = await invocation(closed, []);
    [{ id: ids.thread }] = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${scope},${open},'Thread',${ownerId},${ownerId}) RETURNING id` as any;
    [{ id: ids.activity }] = await db`INSERT INTO flightdeck_pg_agent_activities(workspace_id,scope_id,channel_id,thread_id,trigger_message_id,session_id,activity_id,agent_npub,publisher_actor_id,state,sequence,expires_at,lease_expires_at)
      VALUES(${ws},${scope},${open},${ids.thread},${ids.m1},'sess','act-1',${owner},${ownerId},'completed',1,now()+interval '1 day',now()+interval '1 day') RETURNING id` as any;
    await db`INSERT INTO flightdeck_pg_agent_activity_commentary(workspace_id,agent_activity_id,turn_id,activity_id,state,summary,sequence,delivery_cursor) VALUES(${ws},${ids.activity},'t1','act-1','working','did the thing',1,1)`;
    const canvas = async (title: string, mode: string) => (await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,visibility_mode,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${title},1,${mode},${ownerId},${ownerId}) RETURNING id`)[0]!.id as string;
    ids.canvasOpen = await canvas('Shared', 'workspace'); ids.canvasPrivate = await canvas('Private', 'restricted');
    await db`INSERT INTO flightdeck_pg_canvas_visibility_principals(workspace_id,canvas_id,principal_type,principal_actor_id,created_by_actor_id) VALUES(${ws},${ids.canvasPrivate},'actor',${ownerId},${ownerId})`;
    for (const c of [ids.canvasOpen, ids.canvasPrivate]) await db`INSERT INTO flightdeck_pg_canvas_elements(workspace_id,canvas_id,kind,layout,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${c},'text',${db.json({ x: 1 })},${ownerId},${ownerId})`;
    await db`INSERT INTO flightdeck_pg_canvas_naplets(workspace_id,canvas_id,source_type,source_id,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${ids.canvasOpen},'document',${ids.doc},${ownerId},${ownerId})`;
    for (const viewer of [ownerId, readerId]) await db`INSERT INTO flightdeck_pg_canvas_orders(workspace_id,viewer_actor_id,canvas_id,position) VALUES(${ws},${viewer},${ids.canvasOpen},3)`;
    // Org data: permission grants decide who may read at all; the type's access decides members vs admins.
    for (const actor of [ownerId, readerId]) for (const permission of ['workspace.read', 'org_data.read']) await grant(actor, null, permission);
    await grant(ownerId, null, 'org_data.schema');
    await db`INSERT INTO flightdeck_pg_org_data_types(workspace_id,key,label,fields,access) VALUES(${ws},'projects','Projects',${db.json([{ key: 'name', label: 'Name', type: 'text' }])},${db.json({ read: 'members', write: 'admins' })}),(${ws},'salaries','Salaries',${db.json([{ key: 'name', label: 'Name', type: 'text' }])},${db.json({ read: 'admins', write: 'admins' })})`;
    for (const [type, name] of [['projects', 'Alpha'], ['projects', 'Beta'], ['salaries', 'Secret']] as const) await db`INSERT INTO flightdeck_pg_org_data_records(workspace_id,type_key,values) VALUES(${ws},${type},${db.json({ name })})`;
  });
  afterAll(async () => { resetInMemoryStorageForTest(); await closeDb(); const root = postgres({ ...conn, database: 'postgres' }); await root.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await root.end(); });

  test('coverage map classifies every billable table; the manifest names what is not exported', () => {
    const unknown = BILLABLE_STORAGE_TABLES.filter(t => !EXPORT_COVERED_TABLES.has(t) && !(t in EXPORT_UNCOVERED));
    expect(unknown).toEqual([]);
    const coverage = exportCoverage();
    expect(coverage.uncovered_required.map(u => u.table)).not.toContain('flightdeck_pg_canvases');
    expect(coverage.uncovered_required.map(u => u.table)).toContain('git_repositories');
    expect(coverage.uncovered.find(u => u.table === 'flightdeck_pg_permission_grants')!.category).toBe('access');
  });

  test('contract: OpenAPI publishes every export route', () => {
    const paths = buildOpenApiDocument().paths as any;
    for (const p of ['', '/{exportId}', '/{exportId}/page', '/{exportId}/finalize']) expect(paths[`/api/v4/hosting-billing/workspaces/{workspaceId}/migration-export${p}`]).toBeDefined();
  });

  test('owner export: records, retained history and verified assets with an explicit manifest; incomplete while content families are unexported', async () => {
    const result = await run(owner);
    const records = result.seen.records!.filter(i => i.kind === 'record');
    const families = records.reduce((a: any, r) => ({ ...a, [r.family]: (a[r.family] ?? 0) + 1 }), {});
    expect(families).toMatchObject({ message: 3, doc: 2, file: 1, task: 1, channel: 2, scope: 1 });
    expect(result.seen.history!.map(h => h.kind).sort()).toEqual(['doc_version', 'doc_version', 'doc_version', 'file_version']);
    const assets = result.seen.assets!;
    expect(assets.every(a => a.status === 'verified')).toBe(true);
    // doc head + two versions share objects: deduplicated per object, with every reference listed.
    expect(assets.map(a => a.object_id).sort()).toEqual(Object.values(objects).map(o => o.id).sort());
    const docV2 = assets.find(a => a.object_id === objects['doc-v2']!.id);
    expect(docV2.reference_count).toBeGreaterThanOrEqual(2);
    expect(docV2.sha256_hex).toBe(sha(objects['doc-v2']!.bytes));
    expect(docV2.content_path).toBe(`/api/v4/storage/${docV2.object_id}/content`);
    expect(assets.find(a => a.object_id === objects.attachment!.id).references.some((r: any) => r.role === 'attachment')).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.manifest).toMatchObject({ version: 1, scope: 'actor_visible', status: 'incomplete', incomplete_reasons: ['uncovered_content'] });
    expect(result.manifest.integrity).toMatchObject({ consistent: true, dangling_relationships: [], asset_issues: {}, exported_scope_complete: true });
    expect(result.manifest.record_families).toMatchObject(families);
    // Finalizing is idempotent and the session keeps no exported keys.
    expect((await finalizeWorkspaceExport(ws, result.started.export_id, owner, db as any)).manifest).toEqual(result.manifest);
    expect((await db`SELECT 1 FROM workspace_export_keys WHERE export_id=${result.started.export_id}`).length).toBe(0);
  });

  test('authorization: a member exports only what the existing ACL lets them read; outsiders and other sessions are refused', async () => {
    const result = await run(reader);
    const records = result.seen.records!.filter(i => i.kind === 'record');
    expect(records.some(r => r.id === ids.secret || r.id === ids.secretDoc)).toBe(false);
    expect(records.filter(r => r.family === 'message').length).toBe(2);
    expect(JSON.stringify(result.seen)).not.toContain(objects['secret-doc']!.id);
    expect(result.seen.history!.some(h => h.row.doc_id === ids.secretDoc)).toBe(false);
    expect(result.manifest.integrity.exported_scope_complete).toBe(true);
    await expect(startWorkspaceExport(ws, outsider, db as any)).rejects.toMatchObject({ code: 'workspace_membership_required' });
    const mine = await startWorkspaceExport(ws, owner, db as any);
    await expect(readWorkspaceExportPage(ws, mine.export_id, reader, { section: 'records' }, db as any)).rejects.toMatchObject({ code: 'export_not_found' });
    await expect(readWorkspaceExportPage(randomUUID(), mine.export_id, owner, { section: 'records' }, db as any)).rejects.toMatchObject({ code: 'workspace_not_found' });
    // Losing membership stops further pages immediately.
    const lost = await startWorkspaceExport(ws, reader, db as any);
    await db`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${ws} AND actor_id=${readerId}`;
    await expect(readWorkspaceExportPage(ws, lost.export_id, reader, { section: 'records' }, db as any)).rejects.toMatchObject({ code: 'workspace_membership_required' });
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${ws},${readerId},'member')`;
    await db`DELETE FROM flightdeck_pg_permission_grants WHERE workspace_id=${ws} AND principal_actor_id=${readerId}`;
    for (const permission of ['channel.read', 'doc.read', 'file.read', 'task.read']) await grant(readerId, open, permission); // membership removal also removes the member's grants
  });

  test('paging: small pages, replay of the delivered page, no skipping, strict section order', async () => {
    const small = await run(owner, 2);
    expect(small.seen.records!.length).toBeGreaterThan(4);
    const started = await startWorkspaceExport(ws, owner, db as any);
    await expect(readWorkspaceExportPage(ws, started.export_id, owner, { section: 'content' }, db as any)).rejects.toMatchObject({ code: 'section_out_of_order' });
    const first: any = await readWorkspaceExportPage(ws, started.export_id, owner, { section: 'records', limit: 2 }, db as any);
    expect(first.next_cursor).not.toBeNull();
    const replay: any = await readWorkspaceExportPage(ws, started.export_id, owner, { section: 'records', limit: 2 }, db as any);
    expect(replay.items).toEqual(first.items); expect(replay.progress).toEqual(first.progress);
    const second: any = await readWorkspaceExportPage(ws, started.export_id, owner, { section: 'records', cursor: first.next_cursor, limit: 2 }, db as any);
    expect(second.progress.items).toBe(first.progress.items + second.items.length);
    // The first page is no longer replayable once a later page was delivered; a forged cursor never advances anything.
    await expect(readWorkspaceExportPage(ws, started.export_id, owner, { section: 'records', limit: 2 }, db as any)).rejects.toMatchObject({ code: 'cursor_invalid' });
    await expect(readWorkspaceExportPage(ws, started.export_id, owner, { section: 'records', cursor: 'not-a-cursor', limit: 2 }, db as any)).rejects.toMatchObject({ code: 'cursor_invalid' });
    await expect(finalizeWorkspaceExport(ws, started.export_id, owner, db as any)).rejects.toMatchObject({ code: 'export_not_traversed' });
    await expect(readWorkspaceExportPage(ws, started.export_id, owner, { section: 'records', limit: 201 }, db as any)).rejects.toMatchObject({ code: 'invalid_limit' });
    await expect(readWorkspaceExportPage(ws, started.export_id, owner, { section: 'nope' }, db as any)).rejects.toMatchObject({ code: 'invalid_section' });
  });

  test('missing, short, altered or unfinished assets fail the export instead of producing a fake backup', async () => {
    const cases: [string, () => Promise<void>, string][] = [
      ['file-v1', async () => { (await import('../src/services/storage')).resetInMemoryStorageForTest(); enableInMemoryStorageForTest(); for (const o of Object.values(objects)) if (o !== objects['file-v1']) await writeAuthorizedStorageBytes({ storage_path: o.path, content_type: 'text/plain' } as any, o.bytes); }, 'missing_bytes'],
      ['doc-v1', async () => { await writeAuthorizedStorageBytes({ storage_path: objects['doc-v1']!.path, content_type: 'text/plain' } as any, new TextEncoder().encode('# v1 and more')); }, 'size_mismatch'],
      ['doc-v2', async () => { await writeAuthorizedStorageBytes({ storage_path: objects['doc-v2']!.path, content_type: 'text/plain' } as any, new TextEncoder().encode('# X2 body')); }, 'hash_mismatch'],
      ['attachment', async () => { await db`UPDATE v4_storage_objects SET completed_at=NULL WHERE id=${objects.attachment!.id}`; }, 'upload_incomplete'],
    ];
    for (const [label, mutate, status] of cases) {
      await mutate();
      const result = await run(owner);
      const asset = result.seen.assets!.find(a => a.object_id === objects[label]!.id);
      expect(asset.status).toBe(status);
      expect(result.complete).toBe(false);
      expect(result.manifest.incomplete_reasons).toContain('asset_issues');
      expect(result.manifest.integrity.exported_scope_complete).toBe(false);
      expect(result.manifest.integrity.asset_issues[status]).toBe(1);
    }
    // Restore all bytes so later tests start clean.
    for (const o of Object.values(objects)) await writeAuthorizedStorageBytes({ storage_path: o.path, content_type: 'text/plain' } as any, o.bytes);
    await db`UPDATE v4_storage_objects SET completed_at=now() WHERE id=${objects.attachment!.id}`;
    expect((await run(owner)).manifest.integrity.asset_issues).toEqual({});
  });

  test('revocation ends the session before any further data, replay included; history re-authorizes its parents', async () => {
    const regrant = async () => { await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${ws} AND principal_actor_id=${readerId} AND resource_channel_id=${open}`; };
    const revoke = () => db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${ws} AND principal_actor_id=${readerId} AND resource_channel_id=${open}`;
    const drain = async (id: string, section: 'records' | 'content' | 'history' | 'assets') => {
      let cursor: string | null = null; const items: any[] = [];
      for (let i = 0; i < 50; i++) { const page: any = await readWorkspaceExportPage(ws, id, reader, { section, cursor, limit: 2 }, db as any); items.push(...page.items); if (page.next_cursor === null) return items; cursor = page.next_cursor; }
      throw new Error('runaway');
    };
    await db`DELETE FROM workspace_exports WHERE workspace_id=${ws}`;
    // 1. Channel access revoked between records and history while workspace membership remains: no history, no replay, no completion.
    const a = await startWorkspaceExport(ws, reader, db as any);
    const records = await drain(a.export_id, 'records');
    await drain(a.export_id, 'content');
    expect(records.some(r => r.id === ids.doc)).toBe(true);
    const firstPage: any = await readWorkspaceExportPage(ws, a.export_id, reader, { section: 'records', limit: 2 }, db as any).catch(() => null);
    void firstPage;
    await revoke();
    await expect(readWorkspaceExportPage(ws, a.export_id, reader, { section: 'history' }, db as any)).rejects.toMatchObject({ code: 'export_invalidated' });
    await expect(readWorkspaceExportPage(ws, a.export_id, reader, { section: 'records', limit: 2 }, db as any)).rejects.toMatchObject({ code: 'export_invalidated' });
    const closedOut = await finalizeWorkspaceExport(ws, a.export_id, reader, db as any).catch((e: any) => e);
    expect(closedOut).toMatchObject({ code: 'export_not_traversed' });
    // 2. Even when the pinned revision matches (a missed bump), history is filtered by the parents' CURRENT authority.
    const b = await startWorkspaceExport(ws, reader, db as any);
    await regrant();
    await expect(readWorkspaceExportPage(ws, b.export_id, reader, { section: 'records' }, db as any)).rejects.toMatchObject({ code: 'export_invalidated' });
    const c = await startWorkspaceExport(ws, reader, db as any);
    await drain(c.export_id, 'records'); await drain(c.export_id, 'content');
    await revoke();
    const [{ access_revision, epoch }] = await db`SELECT access_revision::text,epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${ws}` as any;
    await db`UPDATE workspace_exports SET access_revision=${access_revision},clock_epoch=${epoch} WHERE id=${c.export_id}`;
    expect(await drain(c.export_id, 'history')).toEqual([]);
    // 3. Assets referenced earlier now report not_readable instead of being offered as verified bytes.
    const assets = await drain(c.export_id, 'assets');
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.every(x => x.status === 'not_readable')).toBe(true);
    const done = await finalizeWorkspaceExport(ws, c.export_id, reader, db as any);
    expect(done.complete).toBe(false);
    expect(done.manifest.incomplete_reasons).toEqual(expect.arrayContaining(['asset_issues']));
    await regrant();
    await db`DELETE FROM workspace_exports WHERE workspace_id=${ws}`;
    // A fresh session after the revocation is reinstated again sees the channel.
    expect((await run(reader)).seen.records!.some(r => r.id === ids.doc)).toBe(true);
  });

  test('content adapters: each table follows its own route rule; the owner sees all, the member only what the rule allows', async () => {
    await db`DELETE FROM workspace_exports WHERE workspace_id=${ws}`;
    // Removing a membership (earlier test) removed that member's workspace grants and private ordering.
    await db`DELETE FROM flightdeck_pg_permission_grants WHERE workspace_id=${ws} AND principal_actor_id=${readerId} AND resource_type='workspace'`;
    for (const permission of ['workspace.read', 'org_data.read']) await grant(readerId, null, permission);
    await db`INSERT INTO flightdeck_pg_canvas_orders(workspace_id,viewer_actor_id,canvas_id,position) VALUES(${ws},${readerId},${ids.canvasOpen},3) ON CONFLICT DO NOTHING`;
    const owned = await run(owner);
    const mine = await run(reader);
    const idsOf = (r: any, table: string) => r.seen.content.filter((i: any) => i.table === `flightdeck_pg_${table}`).map((i: any) => i.row.id ?? i.key).sort();
    const want = (...x: string[]) => x.sort();
    expect(idsOf(owned, 'workrooms')).toEqual(want(ids.workroom!, ids.closedWorkroom!));
    expect(idsOf(mine, 'workrooms')).toEqual(want(ids.workroom!));
    expect(owned.seen.content.filter((i: any) => i.table.startsWith('flightdeck_pg_workroom_')).length).toBe(6);
    expect(mine.seen.content.filter((i: any) => i.table.startsWith('flightdeck_pg_workroom_')).length).toBe(3);
    // Approvals: a workroom approval follows the workroom's channel; any other target needs workspace.manage.
    expect(idsOf(owned, 'approvals')).toEqual(want(ids.approvalOpen!, ids.approvalClosed!, ids.approvalDoc!));
    expect(idsOf(mine, 'approvals')).toEqual(want(ids.approvalOpen!));
    // Invocations: channel readers, the creator, or a named recipient.
    expect(idsOf(owned, 'invocations')).toEqual(want(ids.invOpen!, ids.invRecipient!, ids.invHidden!));
    expect(idsOf(mine, 'invocations')).toEqual(want(ids.invOpen!, ids.invRecipient!));
    expect(idsOf(mine, 'reactions').length).toBe(1);
    expect(idsOf(mine, 'task_watchers').length).toBe(1);
    expect(idsOf(mine, 'agent_activities')).toEqual(want(ids.activity!));
    expect(idsOf(mine, 'agent_activity_commentary').length).toBe(1);
    expect(JSON.stringify(mine.seen.content.filter((i: any) => i.table === 'flightdeck_pg_agent_activities'))).not.toContain('lease_');
    // Canvases: workspace-mode for the member; the restricted one only for its principals (or workspace.manage).
    expect(idsOf(owned, 'canvases')).toEqual(want(ids.canvasOpen!, ids.canvasPrivate!));
    expect(idsOf(mine, 'canvases')).toEqual(want(ids.canvasOpen!));
    expect(mine.seen.content.filter((i: any) => i.table === 'flightdeck_pg_canvas_elements').length).toBe(1);
    expect(owned.seen.content.filter((i: any) => i.table === 'flightdeck_pg_canvas_elements').length).toBe(2);
    expect(mine.seen.content.filter((i: any) => i.table === 'flightdeck_pg_canvas_orders').map((i: any) => i.row.viewer_actor_id)).toEqual([readerId]);
    // Org data: members read 'members' types; 'admins' types need org_data.schema. A member without org_data.read gets nothing.
    expect(owned.seen.content.filter((i: any) => i.table === 'flightdeck_pg_org_data_types').map((i: any) => i.row.key)).toEqual(['projects', 'salaries']);
    expect(owned.seen.content.filter((i: any) => i.table === 'flightdeck_pg_org_data_records').map((i: any) => i.row.values.name).sort()).toEqual(['Alpha', 'Beta', 'Secret']);
    expect(mine.seen.content.filter((i: any) => i.table === 'flightdeck_pg_org_data_types').map((i: any) => i.row.key)).toEqual(['projects']);
    expect(mine.seen.content.filter((i: any) => i.table === 'flightdeck_pg_org_data_records').map((i: any) => i.row.values.name).sort()).toEqual(['Alpha', 'Beta']);
    expect(JSON.stringify(mine.seen)).not.toContain('Secret');
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${ws} AND principal_actor_id=${readerId} AND permission='org_data.read'`;
    const noOrg = await run(reader);
    expect(noOrg.seen.content.filter((i: any) => i.table.startsWith('flightdeck_pg_org_data'))).toEqual([]);
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${ws} AND principal_actor_id=${readerId} AND permission='org_data.read'`;
    expect(JSON.stringify(mine.seen)).not.toContain(ids.closedWorkroom!);
    expect(mine.manifest.content_tables).toMatchObject({ flightdeck_pg_canvases: 1, flightdeck_pg_workrooms: 1 });
    // Relationships hold (every parent was delivered) and what remains unexported is named per table with a reason.
    expect(owned.manifest.integrity.dangling_relationships).toEqual([]);
    expect(mine.manifest.integrity.dangling_relationships).toEqual([]);
    const required = owned.manifest.coverage.uncovered_required.map((u: any) => u.table);
    expect(required).not.toContain('flightdeck_pg_org_data_records');
    expect(required).toEqual(expect.arrayContaining(['managed_storage_sets', 'git_repositories']));
    for (const delivered of ['flightdeck_pg_napplets', 'flightdeck_pg_napplet_releases', 'flightdeck_pg_napplet_collections', 'flightdeck_pg_napplet_bundles', 'flightdeck_pg_napplet_installations', 'flightdeck_pg_drive_shares', 'flightdeck_pg_app_storage_objects']) expect(required).not.toContain(delivered);
    expect(required).not.toContain('flightdeck_pg_canvases');
    expect(owned.manifest.coverage.uncovered.find((u: any) => u.table === 'git_repositories').reason).toContain('Forgejo');
    expect(owned.manifest.coverage.uncovered.find((u: any) => u.table === 'flightdeck_pg_response_activities').category).toBe('operational');
    expect(owned.manifest.status).toBe('incomplete');
  });

  test('a content row whose parent was not delivered is a reported broken relationship', async () => {
    // A reaction on a doc the member cannot read (the doc is in the closed channel) but whose own channel is readable cannot occur;
    // force it by pointing a reaction in the open channel at a record that is not delivered.
    const orphan = randomUUID();
    await db`INSERT INTO flightdeck_pg_reactions(workspace_id,scope_id,channel_id,target_type,target_id,emoji,emoji_shortcode,reactor_actor_id,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${scope},${open},'message',${orphan},'heart',':heart:',${ownerId},${ownerId},${ownerId})`;
    await db`DELETE FROM workspace_exports WHERE workspace_id=${ws}`;
    const result = await run(owner);
    expect(result.manifest.integrity.dangling_relationships).toEqual([expect.objectContaining({ child: 'table:flightdeck_pg_reactions', parent: 'message', count: 1, sample: [expect.any(String)] })]);
    expect(result.manifest.incomplete_reasons).toContain('dangling_relationships');
    await db`DELETE FROM flightdeck_pg_reactions WHERE target_id=${orphan}`;
  });

  test('napplet registry, org napplets, drive shares and registered-app objects follow their own read rules', async () => {
    await db`DELETE FROM workspace_exports WHERE workspace_id=${ws}`;
    const app = 'export-app';
    const manifest = { collections: { notes: { scope: 'team', schema_version: 1, operations: ['list', 'get', 'create'] }, hidden: { scope: 'team', schema_version: 1, operations: ['create'] } } };
    const bundle = { file_id: ids.file, file_version: 1, sha256_hex: 'a'.repeat(64) };
    const install = (id: string, over: Record<string, unknown> = {}) => db`INSERT INTO flightdeck_pg_napplets(workspace_id,app_npub,napplet_id,owner_npub,publisher_npub,display_name,audience_npubs,bundle,manifest,removed)
      VALUES(${ws},${app},${id},${owner},${owner},${id},${db.json((over.audience ?? []) as any)},${db.json(bundle as any)},${db.json(manifest as any)},${over.removed === true})`;
    await install('nap-a', { audience: [reader] }); await install('nap-b'); await install('nap-gone', { audience: [reader], removed: true });
    for (const [n, rev] of [['nap-a', 1], ['nap-a', 2], ['nap-b', 1], ['nap-gone', 1]] as const) await db`INSERT INTO flightdeck_pg_napplet_releases(workspace_id,app_npub,napplet_id,revision,bundle,manifest,publisher_npub) VALUES(${ws},${app},${n},${rev},${db.json(bundle as any)},${db.json(manifest as any)},${owner})`;
    const collection = async (n: string, name: string, read: string[]) => (await db`INSERT INTO flightdeck_pg_napplet_collections(workspace_id,app_npub,napplet_id,name,scope,owner_npub,read_npubs,schema_version) VALUES(${ws},${app},${n},${name},'team',${owner},${db.json(read as any)},1) RETURNING id`)[0]!.id as string;
    const cShared = await collection('nap-a', 'notes', [reader]), cClosed = await collection('nap-a', 'hidden', [reader]), cOwnerOnly = await collection('nap-b', 'notes', []);
    // The member's own collection: readable by them as owner, never by the napplet's owner.
    const cReaderOwn = (await db`INSERT INTO flightdeck_pg_napplet_collections(workspace_id,app_npub,napplet_id,name,scope,owner_npub,read_npubs,schema_version) VALUES(${ws},${app},'nap-a','notes','personal',${reader},'[]'::jsonb,1) RETURNING id`)[0]!.id as string;
    const record = async (c: string, id: string, deleted = false, revs = 1) => {
      await db`INSERT INTO flightdeck_pg_napplet_records(collection_id,id,revision,schema_version,data,deleted,updated_by_npub) VALUES(${c},${id},${revs},1,${db.json({ id } as any)},${deleted},${owner})`;
      for (let r = 1; r <= revs; r++) await db`INSERT INTO flightdeck_pg_napplet_record_versions(collection_id,id,revision,schema_version,data,deleted,updated_by_npub,updated_at) VALUES(${c},${id},${r},1,${db.json({ id, r } as any)},false,${owner},now())`;
    };
    await record(cShared, 'r1', false, 2); await record(cShared, 'r-del', true); await record(cClosed, 'r-hidden'); await record(cOwnerOnly, 'r-owner');
    // Drive shares: the discovery rule (enabled, owner still a member; private only for its owner).
    const share = (id: string, actor: string, audience: string, enabled = true) => db`INSERT INTO flightdeck_pg_drive_shares(id,workspace_id,owner_actor_id,host_npub,endpoint,name,host_name,audience,enabled) VALUES(${id},${ws},${actor},${owner},'https://drive.example.invalid','s','h',${audience},${enabled})`;
    const [sOwnerPriv, sOwnerShared, sReaderPriv, sOff, sGone] = Array.from({ length: 5 }, () => randomUUID());
    const [{ id: goneActor }] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npubOf(keyOf())},'human') RETURNING id` as any;
    await share(sOwnerPriv!, ownerId, 'private'); await share(sOwnerShared!, ownerId, 'workspace'); await share(sReaderPriv!, readerId, 'private'); await share(sOff!, ownerId, 'workspace', false); await share(sGone!, goneActor, 'workspace');
    // Registered-app objects: only the workspace owner receives completed ones, with verified bytes.
    const appObject = await object('app-private', 'app bytes');
    await db`INSERT INTO flightdeck_pg_app_storage_objects(storage_object_id,workspace_id,app_npub,actor_id) VALUES(${appObject},${ws},${app},${ownerId})`;
    const [unfinished] = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,storage_path,pg_workspace_id) VALUES(${owner},${owner},'text/plain',3,'fixture/unfinished',${ws}) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_app_storage_objects(storage_object_id,workspace_id,app_npub,actor_id) VALUES(${unfinished!.id},${ws},${app},${ownerId})`;
    // Org napplets: the installed bundle's html for org_data.read members; version metadata only for publishers/installers.
    await db`INSERT INTO flightdeck_pg_napplet_bundles(workspace_id,key,version,title,bridge_version,capabilities,html,sha256,created_by_actor_id) VALUES(${ws},'dash',1,'Dash',1,'[]'::jsonb,'<p>one</p>',${sha('<p>one</p>')},${ownerId}),(${ws},'dash',2,'Dash',1,'[]'::jsonb,'<p>two</p>',${sha('<p>two</p>')},${ownerId})`;
    await db`INSERT INTO flightdeck_pg_napplet_installations(workspace_id,key,version) VALUES(${ws},'dash',1)`;
    await grant(ownerId, null, 'napplet.install');
    for (const permission of ['workspace.read', 'org_data.read']) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) SELECT ${ws},'actor',${readerId},'workspace',${permission} WHERE NOT EXISTS(SELECT 1 FROM flightdeck_pg_permission_grants WHERE workspace_id=${ws} AND principal_actor_id=${readerId} AND permission=${permission} AND revoked_at IS NULL)`;

    const owned = await run(owner), mine = await run(reader);
    const rows = (r: any, table: string) => r.seen.content.filter((i: any) => i.table === `flightdeck_pg_${table}`);
    const keys = (r: any, table: string) => rows(r, table).map((i: any) => i.key).sort();
    const nul = '\u0001', pad = (n: number) => String(n).padStart(10, '0');
    // Napplet registry: the list rule (owner / publisher / audience, not removed), the collection rule, declared operations only.
    expect(keys(owned, 'napplets')).toEqual(['nap-a', 'nap-b']);
    expect(keys(mine, 'napplets')).toEqual(['nap-a']);
    expect(keys(owned, 'napplet_releases')).toEqual([`nap-a${nul}${pad(1)}`, `nap-a${nul}${pad(2)}`, `nap-b${nul}${pad(1)}`]);
    expect(keys(mine, 'napplet_releases')).toEqual([`nap-a${nul}${pad(1)}`, `nap-a${nul}${pad(2)}`]);
    expect(keys(owned, 'napplet_collections')).toEqual([cShared, cClosed, cOwnerOnly].sort());
    expect(keys(mine, 'napplet_collections')).toEqual([cShared, cClosed, cReaderOwn].sort());
    expect(keys(owned, 'napplet_records')).toEqual([`${cShared}${nul}r1`, `${cOwnerOnly}${nul}r-owner`].sort()); // deleted rows and collections without a declared `list` are not delivered
    expect(keys(mine, 'napplet_records')).toEqual([`${cShared}${nul}r1`]);
    expect(keys(mine, 'napplet_record_versions')).toEqual([`${cShared}${nul}r1${nul}${pad(1)}`, `${cShared}${nul}r1${nul}${pad(2)}`]);
    expect(owned.manifest.integrity.dangling_relationships).toEqual([]);
    expect(mine.manifest.integrity.dangling_relationships).toEqual([]);
    // Drive: private shares only for their owner, enabled shares of current members only.
    expect(keys(owned, 'drive_shares')).toEqual([sOwnerPriv, sOwnerShared].sort());
    expect(keys(mine, 'drive_shares')).toEqual([sOwnerShared, sReaderPriv].sort());
    expect(rows(owned, 'drive_shares')[0].row.owner_npub).toBe(owner);
    // Registered-app objects: owner only, completed only, bytes verified in the assets section.
    expect(keys(owned, 'app_storage_objects')).toEqual([appObject]);
    expect(keys(mine, 'app_storage_objects')).toEqual([]);
    expect(owned.seen.assets.find((a: any) => a.object_id === appObject)).toMatchObject({ status: 'verified', sha256_hex: sha('app bytes') });
    expect(mine.seen.assets.some((a: any) => a.object_id === appObject)).toBe(false);
    // Org napplets: installed html for every org_data.read member; version metadata for the installer only.
    expect(rows(owned, 'napplet_installations').map((i: any) => i.row.html)).toEqual(['<p>one</p>']);
    expect(rows(mine, 'napplet_installations').map((i: any) => i.row.html)).toEqual(['<p>one</p>']);
    expect(keys(owned, 'napplet_bundles')).toEqual([`dash${nul}${pad(1)}`, `dash${nul}${pad(2)}`]);
    expect(keys(mine, 'napplet_bundles')).toEqual([]);
    expect(rows(owned, 'napplet_bundles').every((i: any) => i.row.html === undefined)).toBe(true); // metadata only; html has no read route for uninstalled versions
    // Parity with the discovery route's own query.
    const { discoverDriveShares } = await import('../src/services/drive');
    expect((await discoverDriveShares(ws, readerId)).map(s => s.id).sort()).toEqual(keys(mine, 'drive_shares'));
    expect((await discoverDriveShares(ws, ownerId)).map(s => s.id).sort()).toEqual(keys(owned, 'drive_shares'));
    await db`DELETE FROM workspace_exports WHERE workspace_id=${ws}`;
  });

  test('a write during the export is reported, never hidden', async () => {
    const started = await startWorkspaceExport(ws, owner, db as any);
    let cursor: string | null = null;
    for (const section of ['records', 'content', 'history', 'assets'] as const) {
      cursor = null;
      for (;;) { const page: any = await readWorkspaceExportPage(ws, started.export_id, owner, { section, cursor }, db as any); if (page.next_cursor === null) break; cursor = page.next_cursor; }
      if (section === 'records') await message(open, 'written mid-export');
    }
    const result = await finalizeWorkspaceExport(ws, started.export_id, owner, db as any);
    expect(result.complete).toBe(false);
    expect((result.manifest as any).incomplete_reasons).toContain('writes_during_export');
    expect((result.manifest as any).integrity.consistent).toBe(false);
  });

  test('a visible record whose parent is not readable is a reported broken relationship', async () => {
    // Doc access without channel access: the doc is delivered but its channel cannot be.
    const lonely = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${ws},${scope},'Docs only') RETURNING id`)[0]!.id;
    await grant(readerId, lonely, 'doc.read'); await grant(ownerId, lonely, 'doc.read');
    const obj = await object('lonely-doc', 'lonely');
    await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,title,storage_object_id,created_by_actor_id,updated_by_actor_id) VALUES(${ws},${scope},${lonely},'Lonely',${obj},${ownerId},${ownerId})`;
    const result = await run(reader);
    expect(result.manifest.incomplete_reasons).toContain('dangling_relationships');
    expect(result.manifest.integrity.dangling_relationships).toEqual([expect.objectContaining({ child: 'doc', field: 'channel_id', parent: 'channel', count: 1 })]);
    expect(result.manifest.integrity.exported_scope_complete).toBe(false);
  });

  test('sessions are bounded and expire', async () => {
    const actorId = ownerId;
    await db`DELETE FROM workspace_exports WHERE workspace_id=${ws}`;
    for (let i = 0; i < EXPORT_MAX_OPEN_SESSIONS; i++) await startWorkspaceExport(ws, owner, db as any);
    await expect(startWorkspaceExport(ws, owner, db as any)).rejects.toMatchObject({ code: 'too_many_open_exports' });
    const [oldest] = await db`SELECT id FROM workspace_exports WHERE workspace_id=${ws} AND actor_id=${actorId} LIMIT 1`;
    await db`UPDATE workspace_exports SET expires_at=now()-interval '1 second' WHERE id=${oldest!.id}`;
    await expect(readWorkspaceExportPage(ws, oldest!.id, owner, { section: 'records' }, db as any)).rejects.toMatchObject({ code: 'export_expired' });
    await startWorkspaceExport(ws, owner, db as any); // expired sessions are reclaimed
  });

  test('HTTP: signed routes, direct signature for mutations, 409 export_incomplete carries the manifest, and the export is readable while the workspace is read-only', async () => {
    await db`DELETE FROM workspace_exports WHERE workspace_id=${ws}`;
    expect((await http('POST', '/migration-export', ownerKey, {})).status).toBe(201);
    const unsigned = await app.request(`http://localhost/api/v4/hosting-billing/workspaces/${ws}/migration-export`, { method: 'POST', body: '{}' });
    expect(unsigned.status).toBe(401);
    expect((await http('POST', '/migration-export', outsiderKey, {})).status).toBe(403);
    const started = await http('POST', '/migration-export', ownerKey, {});
    const exportId = started.json.export_id as string;
    expect((await http('GET', `/migration-export/${exportId}`, readerKey)).status).toBe(404);
    expect((await http('GET', `/migration-export/${exportId}`, ownerKey)).json).toMatchObject({ export_id: exportId, finalized: false });
    for (const section of ['records', 'content', 'history', 'assets']) {
      let cursor = '';
      for (;;) {
        const page = await http('GET', `/migration-export/${exportId}/page?section=${section}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, ownerKey);
        expect(page.status).toBe(200);
        if (!page.json.next_cursor) break;
        cursor = page.json.next_cursor;
      }
    }
    const finalized = await http('POST', `/migration-export/${exportId}/finalize`, ownerKey, {});
    expect(finalized.status).toBe(409);
    expect(finalized.json).toMatchObject({ code: 'export_incomplete', manifest: { status: 'incomplete', version: 1 } });
    expect((await http('GET', `/migration-export/${exportId}`, ownerKey)).json.outcome.status).toBe('incomplete');
    // The PG write boundary does not apply: an enrolled, depleted workspace still exports (its mutations are refused with 402).
    const [account] = await db`INSERT INTO hosting_accounts(owner_actor_id,promo_units,promo_expires_at,depleted_at,opened_by) VALUES(${ownerId},0,now(),now(),'onboarding') RETURNING id`;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${ws},${account!.id})`;
    const pgUrl = `http://localhost/api/v4/flightdeck-pg/workspaces/${ws}/messages`, pgBody = JSON.stringify({ body: 'blocked' });
    const pgEvent = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(), tags: [['u', pgUrl], ['method', 'POST'], ['payload', sha(pgBody)]] }, ownerKey);
    const blocked = await app.request(pgUrl, { method: 'POST', headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(pgEvent)).toString('base64')}` }, body: pgBody });
    expect(blocked.status).toBe(402);
    expect((await http('POST', '/migration-export', ownerKey, {})).status).toBe(201);
  });
});
