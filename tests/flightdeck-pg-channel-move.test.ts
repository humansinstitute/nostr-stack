import { beforeAll, afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb, closeDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import type { WorkReceipt } from '../src/services/agent-work-receipts';
import { listVisibleFlightDeckPgEvents } from '../src/services/flightdeck-pg-api';

const database = `tower_test_channel_move_${process.pid}`;
let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
const connection = {host:process.env.DB_HOST || '127.0.0.1',port:Number(process.env.DB_PORT || 5432),username:process.env.DB_USER || 'postgres',password:process.env.DB_PASSWORD || 'postgres'};
beforeAll(async () => {
  const admin = postgres({...connection,database:'postgres'});
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
  await admin.unsafe(`CREATE DATABASE ${database}`);
  await admin.end();
  sql = postgres({...connection,database}); setDb(sql);
  for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8'))) await sql.unsafe(statement);
  for (const name of ['notifications-v1.sql','agent-notifications-v1.sql','channel-move-v1.sql']) await sql.unsafe(readFileSync(new URL(`../src/schema/${name}`,import.meta.url),'utf8'));
  app = createApp();
},30000);
afterAll(async () => { await closeDb(); });

async function fixture() {
  const secret = randomBytes(32), npub = nip19.npubEncode(getPublicKey(secret)), appNpub = `test-app-${randomUUID()}`;
  const [actor] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${npub},'human','Mover') RETURNING *`;
  const [workspace] = await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
    VALUES('test-tower',${randomUUID()},${npub},${appNpub},'Move test',${actor.id}) RETURNING *`;
  await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace.id},${actor.id},'owner')`;
  await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${workspace.id},'actor',${actor.id},'workspace','workspace.read')`;
  const scopes = await sql`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind,created_by_actor_id) VALUES(${workspace.id},'Source','project',${actor.id}),(${workspace.id},'Destination','custom',${actor.id}) RETURNING *`;
  for (const s of scopes) for (const permission of ['scope.read','scope.manage']) await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission) VALUES(${workspace.id},'actor',${actor.id},'scope',${s.id},${permission})`;
  const [channel] = await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,position,created_by_actor_id) VALUES(${workspace.id},${scopes[0].id},'Channel',1,${actor.id}) RETURNING *`;
  for (const permission of ['channel.manage','channel.grants.read','channel.read','channel.write','task.read','doc.read','file.read']) await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,resource_channel_id,permission)
    VALUES(${workspace.id},'actor',${actor.id},'channel',${scopes[0].id},${channel.id},${permission})`;
  const root = `/api/v4/flightdeck-pg/workspaces/${workspace.id}/channels/${channel.id}`;
  const input = {workspaceId:workspace.id,appNpub,actorNpub:npub,channelId:channel.id,destinationScopeId:scopes[1].id};
  async function request(operation: string,body: any,key=secret) {
    const path = `${root}/${operation}`, text = JSON.stringify(body);
    const event = finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',`http://localhost${path}`],['method','POST'],['payload',createHash('sha256').update(text).digest('hex')]]},key);
    const response = await app.request(path,{method:'POST',headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,'content-type':'application/json','x-flightdeck-pg-app-npub':appNpub},body:text});
    return {status:response.status,body:await response.json() as any};
  }
  async function preview() { const r = await request('move-preview',{destination_scope_id:input.destinationScopeId}); expect(r.status).toBe(200); return r.body.preview; }
  async function moveBody() { return {destination_scope_id:input.destinationScopeId,confirmation_token:(await preview()).confirmation_token,mutation_id:randomUUID()}; }
  return {secret,npub,actor,workspace,channel,source:scopes[0],destination:scopes[1],input,request,preview,moveBody};
}
async function insertRow(table: string, row: Record<string,any>) {
  const [result] = await sql`INSERT INTO ${sql(table)} ${sql(row)} RETURNING *`; return result;
}
async function contents(f: Awaited<ReturnType<typeof fixture>>) {
  const base={workspace_id:f.workspace.id,scope_id:f.source.id,channel_id:f.channel.id};
  const authors={created_by_actor_id:f.actor.id,updated_by_actor_id:f.actor.id};
  const thread=await insertRow('flightdeck_pg_threads',{...base,...authors,title:'History',metadata:{stable:'thread'}});
  const message=await insertRow('flightdeck_pg_messages',{...base,...authors,thread_id:thread.id,body:'Message bytes 🧭',metadata:{attachments:[]}});
  const branch=await insertRow('flightdeck_pg_threads',{...base,...authors,title:'Branch',parent_thread_id:thread.id,branch_point_message_id:message.id});
  const task=await insertRow('flightdeck_pg_tasks',{...base,...authors,title:'Keep task',thread_id:thread.id,description:'Preserve all text'});
  await insertRow('flightdeck_pg_task_comments',{...base,...authors,task_id:task.id,body:'Keep comment'});
  await insertRow('flightdeck_pg_task_assignments',{...base,...authors,task_id:task.id,actor_id:f.actor.id});
  const [storage]=await sql`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,file_name,content_type,size_bytes,storage_path) VALUES(${f.npub},${f.npub},'proof.txt','text/plain',42,${randomUUID()}) RETURNING *`;
  const doc=await insertRow('flightdeck_pg_docs',{...base,...authors,title:'Keep doc',storage_object_id:storage.id,metadata:{text:'Byte preservation'}});
  await insertRow('flightdeck_pg_doc_versions',{...base,doc_id:doc.id,row_version:1,title:doc.title,storage_object_id:storage.id,actor_id:f.actor.id});
  await insertRow('flightdeck_pg_doc_comments',{...base,...authors,doc_id:doc.id,body:'Doc comment'});
  const folder=await insertRow('flightdeck_pg_file_folders',{...base,...authors,title:'Folder'});
  const file=await insertRow('flightdeck_pg_files',{...base,...authors,folder_id:folder.id,storage_object_id:storage.id,display_name:'Keep file'});
  await insertRow('flightdeck_pg_storage_links',{...base,entity_type:'file',entity_id:file.id,storage_object_id:storage.id,created_by_actor_id:f.actor.id});
  await insertRow('flightdeck_pg_resource_view_states',{...base,viewer_actor_id:f.actor.id,resource_type:'task',resource_id:task.id,viewed_activity_version:0});
  const workroom=await insertRow('flightdeck_pg_workrooms',{...base,...authors,thread_id:thread.id,title:'Keep workroom',goal:'Relocate without changing IDs'});
  await insertRow('flightdeck_pg_workroom_links',{...base,workroom_id:workroom.id,link_type:'task',target_type:'task',target_id:task.id,created_by_actor_id:f.actor.id});
  await insertRow('flightdeck_pg_approvals',{...base,target_type:'workroom',target_id:workroom.id,action:'deploy',requested_by_actor_id:f.actor.id,requested_by_npub:f.npub});
  await insertRow('flightdeck_pg_thread_pins',{...base,actor_id:f.actor.id,resource_type:'thread',resource_id:thread.id,thread_id:thread.id,root_record_id:thread.id,pinned:true});
  await insertRow('flightdeck_pg_outbox_events',{...base,actor_id:f.actor.id,event_type:'test.content',entity_type:'message',entity_id:message.id,payload:{body:'Historical payload remains'}});
  // Workspace-owned canvas plus a stable task link: there is no scope to move.
  const canvas=await insertRow('flightdeck_pg_canvases',{workspace_id:f.workspace.id,...authors,title:'Workspace canvas',position:1});
  const fileVersion=await insertRow('flightdeck_pg_file_versions',{workspace_id:f.workspace.id,file_id:file.id,storage_object_id:storage.id,version_number:1,created_by_actor_id:f.actor.id});
  const naplet=await insertRow('flightdeck_pg_canvas_naplets',{workspace_id:f.workspace.id,canvas_id:canvas.id,source_type:'document',source_id:doc.id,...authors});
  const component=await insertRow('flightdeck_pg_context_components',{workspace_id:f.workspace.id,scope_id:f.source.id,title:'Source context',sort_order:0});
  const reference=await insertRow('flightdeck_pg_context_references',{workspace_id:f.workspace.id,scope_id:f.source.id,component_id:component.id,target_type:'task',target:{record_id:task.id},sort_order:0});
  await insertRow('flightdeck_pg_doc_recovery_versions',{...base,doc_id:doc.id,storage_object_id:storage.id,reason_code:'base_unavailable',head_row_version:1,head_version_id:'head-v1',head_storage_object_id:storage.id,submitted_body_sha256_hex:'a'.repeat(64),idempotency_key:randomUUID(),created_by_actor_id:f.actor.id,created_by_signer_npub:f.npub});
  const daily=await insertRow('flightdeck_pg_daily_notes',{...base,...authors,owner_actor_id:f.actor.id,note_date:'2026-01-01',body:'Personal history'});
  await insertRow('flightdeck_pg_daily_note_versions',{...base,daily_note_id:daily.id,row_version:1,owner_actor_id:f.actor.id,note_date:'2026-01-01',body:'Personal history',content_fingerprint:'stable',actor_id:f.actor.id});
  await insertRow('flightdeck_pg_personal_wapps',{...base,...authors,owner_actor_id:f.actor.id,title:'Tool',launch_url:'https://example.test/tool'});
  await insertRow('flightdeck_pg_audio_notes',{...base,...authors,storage_object_id:storage.id,mime_type:'audio/webm'});
  await insertRow('flightdeck_pg_reactions',{...base,...authors,target_type:'message',target_id:message.id,reactor_actor_id:f.actor.id,emoji:'thumbs_up',emoji_shortcode:':thumbs_up:'});
  await insertRow('flightdeck_pg_invocations',{...base,prompt:'Keep invocation',created_by_actor_id:f.actor.id});
  await insertRow('flightdeck_pg_workroom_events',{...base,workroom_id:workroom.id,event_type:'created',payload:{preserve:'event'}});
  return {thread,message,branch,task,storage,doc,file,workroom,canvas,fileVersion,naplet,reference};
}
async function locationRows(f: Awaited<ReturnType<typeof fixture>>) {
  const tables=await sql`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND starts_with(table_name,'flightdeck_pg_') AND column_name IN ('workspace_id','scope_id','channel_id') GROUP BY table_name HAVING count(*)=3 ORDER BY table_name`;
  const rows: Record<string,any[]>={};
  for(const {table_name} of tables) rows[table_name]=await sql`SELECT to_jsonb(t) AS row FROM ${sql(table_name)} t WHERE workspace_id=${f.workspace.id} AND channel_id=${f.channel.id} ORDER BY to_jsonb(t)::text`;
  return rows;
}

test('signed API atomically preserves content, direct grants, historical versions, links and all record projections; retry is exact',async()=>{
  const f=await fixture(), c=await contents(f);
  const preview=await f.preview();
  expect(preview.access_changes.gained).toEqual([]);expect(preview.access_changes.lost).toEqual([]);
  expect(preview.access_changes.direct_grants_preserved).toBe(true);
  expect(preview.access_changes.retained[0].actor_id).toBe(f.actor.id);
  expect(preview.access_changes.unchanged_direct_grants).toHaveLength(7);
  expect(preview.warnings.join(' ')).toContain('do not grant inherited');
  const before=await locationRows(f), [clock]=await sql`SELECT * FROM flightdeck_pg_record_clock WHERE workspace_id=${f.workspace.id}`;
  const body={destination_scope_id:f.destination.id,confirmation_token:preview.confirmation_token,mutation_id:randomUUID()};
  const moved=await f.request('move',body);
  expect(moved.status).toBe(200);expect(moved.body.channel.id).toBe(f.channel.id);expect(moved.body.channel.scope_id).toBe(f.destination.id);
  const after=await locationRows(f);
  for(const [table,rows] of Object.entries(before)) {
    expect(after[table].length).toBeGreaterThanOrEqual(rows.length);
    for(const {row} of rows) {
      const key=table==='flightdeck_pg_resource_view_states'?'resource_id':table==='flightdeck_pg_doc_versions'?'doc_id':table==='flightdeck_pg_daily_note_versions'?'daily_note_id':'id';
      const found=after[table].find(r=>r.row[key]===row[key])?.row;
      expect(found,table).toBeDefined();expect(found.scope_id,table).toBe(f.destination.id);
      // A relocation changes location only, preserving text, attribution, time,
      // row versions, storage references and nested branch relationships.
      expect({...found,scope_id:row.scope_id},table).toEqual(row);
    }
  }
  const [newClock]=await sql`SELECT * FROM flightdeck_pg_record_clock WHERE workspace_id=${f.workspace.id}`;
  expect(newClock.epoch).toBe(clock.epoch);
  const projections=await sql`SELECT family,context,row FROM flightdeck_pg_record_current WHERE workspace_id=${f.workspace.id} AND context->>'channel_id'=${f.channel.id}`;
  expect(projections.length).toBeGreaterThan(10);
  for(const row of projections) expect(row.context.scope_id,row.family).toBe(f.destination.id);
  const journal=await sql`SELECT family,context FROM flightdeck_pg_record_journal WHERE workspace_id=${f.workspace.id} AND position>${clock.position} AND context->>'channel_id'=${f.channel.id}`;
  expect(journal.some(r=>r.family==='task_comment')).toBe(true);expect(journal.some(r=>r.family==='doc')).toBe(true);
  for(const row of journal) expect(row.context.scope_id).toBe(f.destination.id);
  const [stored]=await sql`SELECT * FROM flightdeck_pg_storage_links WHERE entity_id=${c.file.id}`;expect(stored.storage_object_id).toBe(c.storage.id);
  const [canvas]=await sql`SELECT * FROM flightdeck_pg_canvases WHERE id=${c.canvas.id}`;expect(canvas).toEqual(c.canvas);
  for(const [table,row] of [['flightdeck_pg_file_versions',c.fileVersion],['flightdeck_pg_canvas_naplets',c.naplet],['flightdeck_pg_context_references',c.reference]] as const) {const [stored]=await sql`SELECT * FROM ${sql(table)} WHERE id=${row.id}`;expect(stored).toEqual(row);}
  const [grants]=await sql`SELECT count(*)::int AS n FROM flightdeck_pg_permission_grants WHERE resource_channel_id=${f.channel.id} AND resource_scope_id=${f.destination.id}`;expect(grants.n).toBe(7);
  const retry=await f.request('move',body);expect(retry.status).toBe(200);expect(retry.body).toEqual(moved.body);
  const conflict=await f.request('move',{...body,destination_scope_id:f.source.id});expect(conflict.status).toBe(409);
  const events=await listVisibleFlightDeckPgEvents({workspaceId:f.workspace.id,actorId:f.actor.id,groupIds:[],afterRowVersion:0,limit:1000});
  const event=events.find(e=>e.event_type==='channel.moved');expect(event?.payload).toMatchObject({...moved.body.move,channel_id:f.channel.id});
  const [audit]=await sql`SELECT count(*)::int AS n FROM flightdeck_pg_audit_events WHERE workspace_id=${f.workspace.id} AND action='channel.move'`;expect(audit.n).toBe(1);
});

test('source/destination management and grant disclosure authority are independently required',async()=>{
  for(const permission of ['scope.manage','channel.manage','channel.grants.read']) {
    const f=await fixture();
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.workspace.id} AND permission=${permission} AND (resource_scope_id=${f.destination.id} OR resource_channel_id=${f.channel.id})`;
    const r=await f.request('move-preview',{destination_scope_id:f.destination.id});expect(r.status).toBe(403);expect(r.body.preview).toBeUndefined();
  }
  const f=await fixture();await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.workspace.id} AND permission='scope.manage' AND resource_scope_id=${f.source.id}`;
  expect((await f.request('move-preview',{destination_scope_id:f.destination.id})).status).toBe(403);
});

test('token binds requester, channel revision, scopes, grants, nested group membership and expiry',async()=>{
  const changes=[
    async(f:any)=>sql`UPDATE flightdeck_pg_channels SET description='changed' WHERE id=${f.channel.id}`,
    async(f:any)=>sql`UPDATE flightdeck_pg_scopes SET owner_actor_id=${f.actor.id} WHERE id=${f.destination.id}`,
    async(f:any)=>sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.workspace.id} AND permission='channel.write'`,
    async(f:any)=>{const [g]=await sql`INSERT INTO flightdeck_pg_groups(workspace_id,name,kind) VALUES(${f.workspace.id},'New group','custom') RETURNING id`;await sql`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${f.workspace.id},${g.id},${f.actor.id})`;},
    async(f:any)=>sql`UPDATE flightdeck_pg_channel_move_previews SET expires_at=now()-interval '1 second' WHERE workspace_id=${f.workspace.id}`,
  ];
  for(const change of changes){const f=await fixture(),body=await f.moveBody();await change(f);const r=await f.request('move',body);expect(r.status).toBe(409);expect(r.body.code).toBe('stale_preview');const [c]=await sql`SELECT scope_id FROM flightdeck_pg_channels WHERE id=${f.channel.id}`;expect(c.scope_id).toBe(f.source.id);}
  const f=await fixture(), other=await fixture(),body=await f.moveBody();
  const [foreign]=await sql`SELECT token FROM flightdeck_pg_channel_move_previews WHERE workspace_id=${other.workspace.id}`;
  const otherPreview=foreign?.token || (await other.preview()).confirmation_token;
  expect((await f.request('move',{...body,confirmation_token:otherPreview})).status).toBe(409);
});

test('missing/cross-workspace targets, malformed bodies, same destination, special/default/archived channels and duplicate names fail safely',async()=>{
  const f=await fixture(), other=await fixture();
  for(const destination_scope_id of [randomUUID(),other.destination.id]) expect((await f.request('move-preview',{destination_scope_id})).status).toBe(404);
  expect((await f.request('move-preview',{destination_scope_id:'wrong'})).status).toBe(400);
  expect((await f.request('move-preview',{destination_scope_id:f.source.id})).status).toBe(409);
  expect((await f.request('move-preview',{destination_scope_id:f.destination.id,scope_id:f.source.id})).status).toBe(400);
  await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${f.workspace.id},${f.destination.id},${f.channel.name})`;
  expect((await f.request('move-preview',{destination_scope_id:f.destination.id})).body.code).toBe('duplicate_channel');
  for(const field of ['default','archived','dm','system','scope_archive','scope_dm']){
    const g=await fixture();
    if(field==='default') await sql`UPDATE flightdeck_pg_scopes SET default_channel_id=${g.channel.id} WHERE id=${g.source.id}`;
    else if(field==='archived') await sql`UPDATE flightdeck_pg_channels SET archived_at=now() WHERE id=${g.channel.id}`;
    else if(field==='scope_archive') await sql`UPDATE flightdeck_pg_scopes SET archived_at=now() WHERE id=${g.destination.id}`;
    else if(field==='scope_dm') await sql`UPDATE flightdeck_pg_scopes SET kind='dm' WHERE id=${g.destination.id}`;
    else await sql`UPDATE flightdeck_pg_channels SET kind=${field} WHERE id=${g.channel.id}`;
    const r=await g.request('move-preview',{destination_scope_id:g.destination.id});expect(r.status,field).toBe(409);
  }
});

test('failed child relocation rolls back channel, every content row, projections, audit and receipt',async()=>{
  const f=await fixture();await contents(f);const before=await locationRows(f),body=await f.moveBody();
  // A new family constraint deliberately rejects destination location at COMMIT.
  await sql.unsafe(`CREATE TABLE fd_test_move_blocker(workspace_id uuid,scope_id uuid,channel_id uuid,FOREIGN KEY(workspace_id,scope_id,channel_id) REFERENCES flightdeck_pg_channels(workspace_id,scope_id,id) DEFERRABLE INITIALLY IMMEDIATE)`);
  await sql`INSERT INTO fd_test_move_blocker VALUES(${f.workspace.id},${f.source.id},${f.channel.id})`;
  const r=await f.request('move',body);expect(r.status).toBe(409);
  expect(await locationRows(f)).toEqual(before);
  const [c]=await sql`SELECT scope_id FROM flightdeck_pg_channels WHERE id=${f.channel.id}`;expect(c.scope_id).toBe(f.source.id);
  expect(await sql`SELECT * FROM flightdeck_pg_channel_move_receipts WHERE workspace_id=${f.workspace.id}`).toHaveLength(0);
  expect(await sql`SELECT * FROM flightdeck_pg_audit_events WHERE workspace_id=${f.workspace.id} AND action='channel.move'`).toHaveLength(0);
  await sql.unsafe('DROP TABLE fd_test_move_blocker');
});

test('simultaneous moves have one winner; stale writes cannot create split scope state',async()=>{
  const f=await fixture();const body=await f.moveBody();
  const results=await Promise.all([f.request('move',body),f.request('move',{...body,mutation_id:randomUUID()})]);
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  await expect(sql`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id)
    VALUES(${f.workspace.id},${f.source.id},${f.channel.id},'Stale writer',${f.actor.id},${f.actor.id})`).rejects.toMatchObject({code:'23503'});
  // Pins intentionally lack a channel FK; the location guard closes that seam.
  await expect(sql`INSERT INTO flightdeck_pg_thread_pins(workspace_id,scope_id,channel_id,actor_id,resource_type,resource_id,pinned)
    VALUES(${f.workspace.id},${f.source.id},${f.channel.id},${f.actor.id},'channel',${f.channel.id},true)`).rejects.toMatchObject({code:'23503'});
});

test('exact retry returns current metadata and rejects a superseded location',async()=>{
  const f=await fixture(),body=await f.moveBody();expect((await f.request('move',body)).status).toBe(200);
  await sql`UPDATE flightdeck_pg_channels SET description='New description' WHERE id=${f.channel.id}`;
  const retry=await f.request('move',body);expect(retry.status).toBe(200);expect(retry.body.channel.description).toBe('New description');
  const back=await f.request('move-preview',{destination_scope_id:f.source.id});expect(back.status).toBe(200);
  expect((await f.request('move',{destination_scope_id:f.source.id,confirmation_token:back.body.preview.confirmation_token,mutation_id:randomUUID()})).status).toBe(200);
  const superseded=await f.request('move',body);expect(superseded.status).toBe(409);expect(superseded.body.code).toBe('move_superseded');expect(superseded.body.channel).toBeUndefined();
});

test('already-authorized nested group readers retain exact permissions; scope-only readers get no moved channel payload',async()=>{
  const f=await fixture();
  const [reader]=await sql`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${randomUUID()},'human','Nested reader') RETURNING id`;
  const [scopeReader]=await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${randomUUID()},'human') RETURNING id`;
  for(const actor of [reader,scopeReader]) await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id) VALUES(${f.workspace.id},${actor.id})`;
  const groups=await sql`INSERT INTO flightdeck_pg_groups(workspace_id,name,kind) VALUES(${f.workspace.id},'Parent','custom'),(${f.workspace.id},'Child','custom') RETURNING id`;
  await sql`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${f.workspace.id},${groups[1].id},${reader.id})`;
  await sql`INSERT INTO flightdeck_pg_group_edges(workspace_id,parent_group_id,child_group_id) VALUES(${f.workspace.id},${groups[0].id},${groups[1].id})`;
  for(const permission of ['channel.read','task.read']) await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,resource_channel_id,permission)
    VALUES(${f.workspace.id},'group',${groups[0].id},'channel',${f.channel.id},${permission})`;
  await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission)
    VALUES(${f.workspace.id},'actor',${scopeReader.id},'scope',${f.source.id},'scope.read')`;
  const preview=await f.preview();expect(preview.access_changes.retained.find((a:any)=>a.actor_id===reader.id).permissions).toEqual(['channel.read','task.read']);
  expect(preview.access_changes.retained.find((a:any)=>a.actor_id===scopeReader.id)).toBeUndefined();
  const {readFlightDeckRecordPage}=await import('../src/services/flightdeck-record-delta');
  let page=await readFlightDeckRecordPage({workspaceId:f.workspace.id,actorId:reader.id},sql);
  const initial=[...page.changes];
  while(page.has_more){page=await readFlightDeckRecordPage({workspaceId:f.workspace.id,actorId:reader.id,cursor:page.next_cursor},sql);initial.push(...page.changes);}
  expect(initial.some(r=>r.family==='scope' && r.id===f.destination.id)).toBe(false);
  let cursor=page.next_cursor;
  expect((await f.request('move',{destination_scope_id:f.destination.id,confirmation_token:preview.confirmation_token,mutation_id:randomUUID()})).status).toBe(200);
  const changes:any[]=[],access:any[]=[];
  for(let n=0;n<20;n++) {const p=await readFlightDeckRecordPage({workspaceId:f.workspace.id,actorId:reader.id,cursor},sql);changes.push(...p.changes);access.push(...(p.access_changes||[]));cursor=p.next_cursor;if(!p.has_more)break;}
  expect(changes.some(r=>r.family==='scope' && r.id===f.destination.id && r.operation==='upsert')).toBe(true);
  expect(changes.some(r=>r.family==='channel' && r.id===f.channel.id && r.row?.scope_id===f.destination.id)).toBe(true);
  const events=await listVisibleFlightDeckPgEvents({workspaceId:f.workspace.id,actorId:scopeReader.id,groupIds:[],afterRowVersion:0,limit:1000});
  expect(events.some(e=>e.event_type==='channel.moved')).toBe(false);
  const invalidation=events.find(e=>e.event_type==='scope.channels_changed');expect(invalidation?.payload).toEqual({scope_id:f.source.id,invalidate:true});
  expect(events.some(e=>e.channel_id===f.channel.id)).toBe(false);
});

test('in-flight content writer completes before relocation and its new row moves atomically',async()=>{
  const f=await fixture(),body=await f.moveBody();
  let unblock!:()=>void, inserted!:()=>void;
  const released=new Promise<void>(r=>unblock=r), ready=new Promise<void>(r=>inserted=r);
  const write=sql.begin(async tx=>{
    const transaction=tx as unknown as typeof sql;
    const [row]=await transaction`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id)
      VALUES(${f.workspace.id},${f.source.id},${f.channel.id},'In flight',${f.actor.id},${f.actor.id}) RETURNING id`;
    inserted();await released;return row;
  });
  await ready;
  const move=f.request('move',body);
  unblock();const row=await write;
  expect((await move).status).toBe(200);
  const [stored]=await sql`SELECT scope_id,title FROM flightdeck_pg_threads WHERE id=${row.id}`;
  expect(stored).toEqual({scope_id:f.destination.id,title:'In flight'});
});

test('concurrent identical mutation retries both return one authoritative committed result',async()=>{
  const f=await fixture(),body=await f.moveBody();
  const results=await Promise.all([f.request('move',body),f.request('move',body)]);
  expect(results.map(r=>r.status)).toEqual([200,200]);expect(results[0].body).toEqual(results[1].body);
  const [receipts]=await sql`SELECT count(*)::int AS n FROM flightdeck_pg_channel_move_receipts WHERE workspace_id=${f.workspace.id}`;expect(receipts.n).toBe(1);
});

test('system-key channels are protected even with ordinary channel kind',async()=>{
  const f=await fixture();await sql`UPDATE flightdeck_pg_channels SET metadata='{"system_key":"default-home"}'::jsonb WHERE id=${f.channel.id}`;
  const r=await f.request('move-preview',{destination_scope_id:f.destination.id});expect(r.status).toBe(409);expect(r.body.code).toBe('unsupported_channel_move');
});

test('location-only relocation preserves exact live work receipts and never revives stale versions',async()=>{
  const f=await fixture(), c=await contents(f);
  const notification=await insertRow('flightdeck_pg_agent_notifications',{workspace_id:f.workspace.id,recipient_actor_id:f.actor.id,seq:1,kind:'task_assigned',reason:'assignment',source_outbox_event_id:randomUUID(),source_event_type:'flightdeck_pg.task.created',source_created_at:new Date(),source_type:'task',source_id:c.task.id,task_id:c.task.id,scope_id:f.source.id,channel_id:f.channel.id,acl_key:`channel:${f.channel.id}:task`,dedupe_key:randomUUID(),addressing:{immutable:true}});
  await insertRow('flightdeck_pg_agent_notification_subscriptions',{workspace_id:f.workspace.id,recipient_actor_id:f.actor.id,consumer_id:'move-test',floor_at:new Date(0)});
  const receipt=await insertRow('flightdeck_pg_agent_work_receipts',{workspace_id:f.workspace.id,recipient_actor_id:f.actor.id,entity_type:'task',entity_id:c.task.id,channel_id:f.channel.id,origin_notification_id:notification.id,receipt_row_version:c.task.row_version});
  const {assertReceiptedVersion}=await import('../src/services/agent-work-receipts');
  await assertReceiptedVersion(sql as any,receipt as unknown as WorkReceipt,{rowVersion:c.task.row_version});
  expect((await f.request('move',await f.moveBody())).status).toBe(200);
  const [current]=await sql`SELECT * FROM flightdeck_pg_tasks WHERE id=${c.task.id}`;
  await assertReceiptedVersion(sql as any,receipt as unknown as WorkReceipt,{rowVersion:current.row_version});
  const [saved]=await sql`SELECT * FROM flightdeck_pg_agent_work_receipts WHERE entity_id=${c.task.id}`;expect(saved).toEqual(receipt);
  const [origin]=await sql`SELECT scope_id,addressing FROM flightdeck_pg_agent_notifications WHERE id=${notification.id}`;expect(origin).toEqual({scope_id:f.destination.id,addressing:{immutable:true}});
  await sql`UPDATE flightdeck_pg_tasks SET row_version=row_version+1 WHERE id=${c.task.id}`;
  const back=await f.request('move-preview',{destination_scope_id:f.source.id});
  expect((await f.request('move',{destination_scope_id:f.source.id,confirmation_token:back.body.preview.confirmation_token,mutation_id:randomUUID()})).status).toBe(200);
  await expect(assertReceiptedVersion(sql as any,receipt as unknown as WorkReceipt,{rowVersion:Number(c.task.row_version)+1})).rejects.toMatchObject({status:409});
});
