import { beforeAll, afterAll, test, expect, describe } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'fs';
import { randomUUID, createHash } from 'crypto';
import { nip19, getPublicKey, finalizeEvent } from 'nostr-tools';
import { createApp } from '../src/server';
import { setDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { nativeBatch, nativeRead, nativeQuery, registerNativePolicy, nativeFence, nativeSetAuthority, nativeStatus, type NativeContext } from '../src/services/app-db-native';
import { createWappDbTableRow, runWappDbMigrations, provisionWappDbNamespace } from '../src/services/app-db';
import { resolveOrCreateFlightDeckPgActor } from '../src/services/flightdeck-pg-authorization';

// Dedicated task-owned PG only. Never point at an existing service/database.
const url = process.env.NATIVE_FIXTURE_DATABASE_URL;
if (url && (!url.includes('native_fixture') || !['127.0.0.1','localhost'].includes(new URL(url).hostname))) throw new Error('NATIVE_FIXTURE_DATABASE_URL must be an explicit local disposable native_fixture service');
describe.skipIf(!url)('registered native app database integration',()=>{
const fixtureName = 'native_fixture_'+process.pid;
const fixtureUrl = new URL(url || 'postgres://postgres:native_fixture@127.0.0.1:1/postgres');fixtureUrl.pathname='/'+fixtureName;
const admin = postgres(url || fixtureUrl.toString(),{onnotice:()=>{}});
const sql = postgres(fixtureUrl.toString(),{max:8,onnotice:()=>{}});
const fixtureSecret = (v:string)=>new Uint8Array(createHash('sha256').update(v).digest());
const npub = (v:string)=>nip19.npubEncode(getPublicKey(fixtureSecret(v)));
let fixtures: any[]=[];
const mime='application/x-fixture-record';
const batch=(channel:string,operations:any[],extra={})=>({version:1 as const,operation_id:randomUUID(),channel_id:channel,operations,...extra});
async function signedRequest(f:{ctx:NativeContext;label:string},action:string,body:any) {
 const url=`http://localhost/api/v4/workspaces/${f.ctx.owner}/apps/${f.ctx.app}/db/native-v1/${f.ctx.workspace}/${action}`;
 const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method','POST'],['payload',createHash('sha256').update(JSON.stringify(body)).digest('hex')]]},fixtureSecret(f.label+'owner'));
 return createApp().request(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')},body:JSON.stringify(body)});
}
async function seed(label:string,consumerModule?:string) {
 const actor = await resolveOrCreateFlightDeckPgActor(npub(label+'owner'),'human',{sql});
 const agent = await resolveOrCreateFlightDeckPgActor(npub(label+'agent'),'agent',{sql});
 const member = await resolveOrCreateFlightDeckPgActor(npub(label+'member'),'human',{sql});
 const app=npub(label+'app');
 const [w]=await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
 VALUES(${npub('tower')},${npub(label+'service')},${actor.npub},${app},${label},${actor.id}) RETURNING *`;
 for(const a of [actor,agent,member]) await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role,created_by_actor_id) VALUES(${w.id},${a.id},'member',${actor.id})`;
 const [s]=await sql`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind,created_by_actor_id) VALUES(${w.id},'Fixture','project',${actor.id}) RETURNING *`;
 const channels=[];
 for(const name of ['primary','other']) { const [c]=await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind,created_by_actor_id) VALUES(${w.id},${s.id},${name},'channel',${actor.id}) RETURNING *`;channels.push(c); }
 await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission,created_by_actor_id) VALUES(${w.id},'actor',${actor.id},'workspace','workspace.manage',${actor.id})`;
 for(const a of [actor,agent]) for(const c of channels) for(const permission of ['file.read','file.write']) await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission,created_by_actor_id)
 VALUES(${w.id},'actor',${a.id},'channel',${c.id},${permission},${actor.id})`;
 await sql`INSERT INTO workspace_apps(workspace_owner_npub,app_npub,app_name,created_by_npub) VALUES(${actor.npub},${app},${label},${actor.npub})`;
 const ctx:NativeContext={owner:actor.npub,app,workspace:w.id,actor:actor.npub};
 const descriptor=await provisionWappDbNamespace(ctx.owner,app,{app_slug:label},actor.npub,w.id);
 const schema=descriptor.schema_name;
 if (consumerModule) {
  const consumer=await import(consumerModule);
  const migrated=await signedRequest({ctx,label},'deployment',{app_slug:label,migrations:[consumer.migration(schema)]});
  const deployment=await migrated.json();expect(migrated.status,JSON.stringify(deployment)).toBe(200);
  for(const p of consumer.policies()) {const response=await signedRequest({ctx,label},'policy',p);expect(response.status,JSON.stringify(await response.json())).toBe(200);}
  return {ctx,actor,agent,member,channels,channel:channels[0].id,scope:s.id,schema,label};
 }
 const ddl=`CREATE TABLE records(id text PRIMARY KEY,workspace_id uuid NOT NULL,channel_id uuid NOT NULL,revision bigint NOT NULL,title text NOT NULL,extensions jsonb,on_date date,at_time timestamptz,UNIQUE(id,workspace_id,channel_id));
 CREATE INDEX records_scope ON records(workspace_id,channel_id,id COLLATE "C");
 CREATE TABLE lines(id text PRIMARY KEY,workspace_id uuid NOT NULL,channel_id uuid NOT NULL,revision bigint NOT NULL,parent_id text NOT NULL,position integer NOT NULL CHECK(position>=0),value text,FOREIGN KEY(parent_id,workspace_id,channel_id) REFERENCES "${schema}"."records"(id,workspace_id,channel_id));
 CREATE INDEX lines_scope ON lines(workspace_id,channel_id,id COLLATE "C");
 CREATE TABLE history(id text PRIMARY KEY,workspace_id uuid NOT NULL,channel_id uuid NOT NULL,revision bigint NOT NULL,parent_id text NOT NULL,source_version text NOT NULL,FOREIGN KEY(parent_id,workspace_id,channel_id) REFERENCES "${schema}"."records"(id,workspace_id,channel_id));
 CREATE INDEX history_scope ON history(workspace_id,channel_id,id COLLATE "C");
 CREATE TABLE provenance(id text PRIMARY KEY,workspace_id uuid NOT NULL,channel_id uuid NOT NULL,revision bigint NOT NULL,title text);
 CREATE INDEX provenance_scope ON provenance(workspace_id,channel_id,id COLLATE "C");`;
 const migration={migrations:[{version:'v1',sql:ddl,checksum:'sha256:'+createHash('sha256').update(ddl).digest('hex')}]};
 await runWappDbMigrations(ctx.owner,app,migration,actor.npub,w.id);
 await runWappDbMigrations(ctx.owner,app,migration,actor.npub,w.id); // exact checksum retry
 for(const [table,columns,parent,append_only] of [['records',['title','extensions','on_date','at_time'],undefined,false],['lines',['parent_id','position','value'],{table:'records',column:'parent_id'},false],['history',['parent_id','source_version'],{table:'records',column:'parent_id'},true]] as const) {
  await registerNativePolicy(ctx,table,{version:1,columns:[...columns],...(parent?{parent}:{}),...(append_only?{append_only}:{}),managed_content_type:mime});
 }
 await registerNativePolicy(ctx,'provenance',{version:1,columns:['title'],append_only:true,manager_only_writes:true,managed_content_type:mime});
 const channel=channels[0].id;
 await nativeSetAuthority(ctx,{channel_id:channel,content_type:mime,mode:'staging',expected_revision:0});
 return {ctx,actor,agent,member,channels,channel,scope:s.id,schema,label};
}
beforeAll(async()=>{
 await admin.unsafe(`CREATE DATABASE "${fixtureName}"`);
 setDb(sql);
 for(const stmt of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8'))) await sql.unsafe(stmt);
 await sql.unsafe(readFileSync(new URL('../src/schema/app-db-native-v1.sql',import.meta.url),'utf8'));
 fixtures=[await seed('normalized_goals'),await seed('inventory_orders')];
},60000);
afterAll(async()=>{await sql.end();await admin.unsafe(`DROP DATABASE "${fixtureName}" WITH (FORCE)`);await admin.end();});

for(const index of [0,1]) test(`independent consumer ${index}: scoped stage, fence, atomic CAS, receipt, snapshot and recovery`,async()=>{
 const f=fixtures[index],ctx=f.ctx,c=f.channel,id=randomUUID();
 const insert=batch(c,[{kind:'insert',table:'records',id,data:{title:'Original',extensions:{unknown:[1,2]}}},{kind:'insert',table:'lines',id:id+':cp',data:{parent_id:id,position:0,value:'stable string checkpoint'}}],{staging:true});
 await expect(nativeBatch(ctx,{...insert,staging:undefined})).rejects.toMatchObject({code:'authority_unavailable'});
 const first=await nativeBatch(ctx,insert);expect(first.results).toHaveLength(2);
 expect(await nativeBatch(ctx,insert)).toEqual(first);
 await expect(nativeBatch(ctx,{...insert,operations:[{...insert.operations[0],data:{title:'Changed'}}]})).rejects.toMatchObject({code:'operation_conflict'});
 await expect(nativeSetAuthority(ctx,{channel_id:c,content_type:mime,mode:'active',expected_revision:1})).rejects.toMatchObject({code:'source_fence_required'});
 await nativeFence(ctx,{channel_id:c,content_type:mime,active:true,expected_revision:0});
 const staged=await nativeStatus(ctx,{channel_id:c,content_type:mime});
 await expect(nativeSetAuthority(ctx,{channel_id:c,content_type:mime,mode:'active',expected_revision:1,expected_generation:'0',expected_fence_revision:staged.fence!.revision})).rejects.toMatchObject({code:'snapshot_changed'});
 await nativeSetAuthority(ctx,{channel_id:c,content_type:mime,mode:'active',expected_revision:1,expected_generation:staged.generation,expected_fence_revision:staged.fence!.revision});
 const before=await nativeQuery(ctx,'records',{version:1,channel_id:c,limit:1});
 const update={kind:'update',table:'records',id,expected_revision:1,data:{title:'Changed'}};
 // Failed child check rolls back successful parent CAS and receipt.
 const bad=batch(c,[update,{kind:'insert',table:'lines',id:id+':bad',data:{parent_id:id,position:-1}}]);
 await expect(nativeBatch(ctx,bad)).rejects.toBeDefined();
 expect((await nativeQuery(ctx,'records',{version:1,channel_id:c,limit:10})).rows[0].title).toBe('Original');
 const good=batch(c,[update,{kind:'insert',table:'history',id:id+':h1',data:{parent_id:id,source_version:'exact-file-version'}}]);
 const updated=await nativeBatch({...ctx,actor:f.agent.npub},good);expect(updated.results[0].row.revision).toBe('2');
 await expect(nativeBatch(ctx,batch(c,[update]))).rejects.toMatchObject({code:'row_conflict'});
 await expect(nativeBatch(ctx,batch(c,[{kind:'update',table:'history',id:id+':h1',expected_revision:1,data:{source_version:'fake'}}]))).rejects.toMatchObject({code:'append_only'});
 await expect(nativeQuery(ctx,'lines',{version:1,channel_id:c,limit:10,generation:before.generation})).rejects.toMatchObject({code:'snapshot_changed'});
 await expect(nativeBatch(ctx,batch(c,[{kind:'delete',table:'lines',id:id+':cp',expected_revision:1}]))).rejects.toMatchObject({code:'parent_cas_required'});
 await expect(nativeBatch({...ctx,actor:f.agent.npub},batch(c,[{kind:'insert',table:'provenance',id:'forged',data:{title:'Fake'}}]))).rejects.toMatchObject({code:'permission_denied'});
 await nativeBatch(ctx,batch(c,[{kind:'insert',table:'provenance',id:'verified',data:{title:'Source manifest'}}]));
 // Receipt recovery still checks current access.
 await sql`DELETE FROM flightdeck_pg_permission_grants WHERE workspace_id=${ctx.workspace} AND principal_actor_id=${f.agent.id}`;
 await expect(nativeBatch({...ctx,actor:f.agent.npub},good)).rejects.toMatchObject({code:'permission_denied'});
 await nativeSetAuthority(ctx,{channel_id:c,content_type:mime,mode:'frozen',expected_revision:2});
 await expect(nativeBatch(ctx,batch(c,[{...update,expected_revision:2}]))).rejects.toMatchObject({code:'authority_unavailable'});
 expect((await nativeQuery(ctx,'records',{version:1,channel_id:c,limit:10,staging:true})).rows.length).toBe(1);
 expect((await nativeStatus(ctx,{channel_id:c,content_type:mime})).authority?.mode).toBe('frozen');
});

test('owner/app/workspace, member, scope spoof and legacy signer denials',async()=>{
 const f=fixtures[0],other=fixtures[1],q={version:1 as const,channel_id:f.channel,limit:10};
 for(const ctx of [{...f.ctx,owner:other.ctx.owner},{...f.ctx,app:other.ctx.app},{...f.ctx,workspace:other.ctx.workspace},{...f.ctx,actor:f.member.npub}]) await expect(nativeQuery(ctx,'records',q)).rejects.toMatchObject({status:403});
 await nativeSetAuthority(f.ctx,{channel_id:f.channel,content_type:mime,mode:'staging',expected_revision:3});
 for(const key of ['workspace_id','channel_id','revision','id']) await expect(nativeBatch(f.ctx,batch(f.channel,[{kind:'insert',table:'records',id:randomUUID(),data:{title:'Injected',[key]:other.channel}}],{staging:true}))).rejects.toMatchObject({code:'column_forbidden'});
 await expect(createWappDbTableRow(f.ctx.owner,f.ctx.app,'records',{id:randomUUID(),data:{title:'old app'}},f.ctx.app)).rejects.toMatchObject({code:'native_policy_required'});
 await expect(sql.unsafe(`UPDATE "${f.schema}".records SET title='bypass'`)).rejects.toMatchObject({message:'native_policy_required'});
});

test('keyset completeness and namespace-wide snapshot restart',async()=>{
 const f=fixtures[0];
 const ops=['a','A','Z','z','_','é'].map(i=>({kind:'insert',table:'records',id:'page:'+i,data:{title:'Page'+i}}));
 await nativeBatch(f.ctx,batch(f.channel,ops,{staging:true}));
 let after:string|undefined,generation:string|undefined,ids:string[]=[];
 do {const p=await nativeQuery(f.ctx,'records',{version:1,channel_id:f.channel,limit:2,staging:true,after,generation});generation=p.generation;ids.push(...p.rows.map(r=>r.id));after=p.next_after??undefined;} while(after);
 expect(new Set(ids).size).toBe(ids.length);expect(ids.filter(id=>id.startsWith('page:'))).toHaveLength(6);
 const child=await nativeQuery(f.ctx,'lines',{version:1,channel_id:f.channel,limit:10,staging:true,generation});expect(child.generation).toBe(generation);
 await nativeBatch(f.ctx,batch(f.channel,[{kind:'insert',table:'records',id:'later',data:{title:'Later'}}],{staging:true}));
 await expect(nativeQuery(f.ctx,'history',{version:1,channel_id:f.channel,limit:10,staging:true,generation})).rejects.toMatchObject({code:'snapshot_changed'});
});

test('File MIME fences cover create, updates, moves, versions, delete and storage metadata; unrelated Files survive',async()=>{
 const f=fixtures[0];
 async function object(type:string){const [o]=await sql`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,storage_path) VALUES(${f.ctx.owner},${f.ctx.owner},${type},${randomUUID()}) RETURNING id`;return o.id;}
 const obj=await object(mime),plain=await object('text/plain');
 // Existing source prior to fence installation in second channel.
 const c=f.channels[1].id;
 const [file]=await sql`INSERT INTO flightdeck_pg_files(workspace_id,scope_id,channel_id,storage_object_id,created_by_actor_id,updated_by_actor_id) VALUES(${f.ctx.workspace},${f.scope},${c},${obj},${f.actor.id},${f.actor.id}) RETURNING id`;
 const [version]=await sql`INSERT INTO flightdeck_pg_file_versions(workspace_id,file_id,version_number,storage_object_id,created_by_actor_id) VALUES(${f.ctx.workspace},${file.id},1,${obj},${f.actor.id}) RETURNING id`;
 await nativeFence(f.ctx,{channel_id:c,content_type:mime,active:true,expected_revision:0});
 const attempts=[()=>sql`INSERT INTO flightdeck_pg_files(workspace_id,scope_id,channel_id,storage_object_id,created_by_actor_id,updated_by_actor_id) VALUES(${f.ctx.workspace},${f.scope},${c},${obj},${f.actor.id},${f.actor.id})`,()=>sql`UPDATE flightdeck_pg_files SET channel_id=${f.channel},storage_object_id=${plain} WHERE id=${file.id}`,()=>sql`UPDATE flightdeck_pg_files SET metadata='{"changed":true}' WHERE id=${file.id}`,()=>sql`DELETE FROM flightdeck_pg_files WHERE id=${file.id}`,()=>sql`UPDATE flightdeck_pg_file_versions SET storage_object_id=${plain} WHERE id=${version.id}`,()=>sql`DELETE FROM flightdeck_pg_file_versions WHERE id=${version.id}`,()=>sql`UPDATE v4_storage_objects SET content_type='text/plain' WHERE id=${obj}`,()=>sql`INSERT INTO flightdeck_pg_file_versions(workspace_id,file_id,version_number,storage_object_id,created_by_actor_id) VALUES(${f.ctx.workspace},${file.id},2,${obj},${f.actor.id})`];
 attempts.push(()=>sql`INSERT INTO flightdeck_pg_file_versions(workspace_id,file_id,version_number,storage_object_id,created_by_actor_id) VALUES(${f.ctx.workspace},${file.id},2,${plain},${f.actor.id})`);
 for(const attempt of attempts) await expect(attempt()).rejects.toMatchObject({message:'managed_content_fenced'});
 const [normal]=await sql`INSERT INTO flightdeck_pg_files(workspace_id,scope_id,channel_id,storage_object_id,created_by_actor_id,updated_by_actor_id) VALUES(${f.ctx.workspace},${f.scope},${c},${plain},${f.actor.id},${f.actor.id}) RETURNING id`;
 await sql`UPDATE flightdeck_pg_files SET display_name='Still usable' WHERE id=${normal.id}`;
 expect((await sql`SELECT count(*)::integer n FROM flightdeck_pg_file_versions WHERE file_id=${file.id}`)[0].n).toBe(1);
});

test('competing CAS has one winner and child foreign scope rolls back the root',async()=>{
 const f=fixtures[0],id='race-root';
 await nativeBatch(f.ctx,batch(f.channel,[{kind:'insert',table:'records',id,data:{title:'Race'}}],{staging:true}));
 const operation={kind:'update',table:'records',id,expected_revision:1,data:{title:'Winner'}};
 const results=await Promise.allSettled([nativeBatch(f.ctx,batch(f.channel,[operation],{staging:true})),nativeBatch(f.ctx,batch(f.channel,[operation],{staging:true}))]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 await expect(nativeBatch(f.ctx,batch(f.channel,[{...operation,expected_revision:2},{kind:'insert',table:'lines',id:'scope-injection',data:{parent_id:fixtures[1].ctx.workspace,position:0}}],{staging:true}))).rejects.toMatchObject({code:'parent_cas_required'});
 const [root]=await sql.unsafe(`SELECT revision::text FROM "${f.schema}".records WHERE id=$1`,[id]);expect(root.revision).toBe('2');
});


test('native signed HTTP facade binds the actual actor and returns versioned errors',async()=>{
 const f=fixtures[0],app=createApp();
 async function request(action:string,body:any,signer=f.label+'owner') {
  const path=`/api/v4/workspaces/${f.ctx.owner}/apps/${f.ctx.app}/db/native-v1/${f.ctx.workspace}/${action}`;
  const url='http://localhost'+path;
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method','POST'],['payload',createHash('sha256').update(JSON.stringify(body)).digest('hex')]]},fixtureSecret(signer));
  return app.request(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')},body:JSON.stringify(body)});
 }
 const existingPolicy={version:1,columns:['title','extensions','on_date','at_time'],managed_content_type:mime};
 const policy=await request('policy',{table:'records',policy:existingPolicy});expect(policy.status).toBe(200);
 const hbatch=batch(f.channel,[{kind:'insert',table:'records',id:'http-row',data:{title:'HTTP signed',on_date:'2026-11-27',at_time:'2026-11-27T03:00:00Z'} }],{staging:true});
 const wrote=await request('batch',hbatch);expect(wrote.status).toBe(200);const written=(await wrote.json()).results[0].row;expect(written.id).toBe('http-row');expect(written.on_date).toBe('2026-11-27');expect(written.at_time).toStartWith('2026-11-27T03:00:00');
 const identity=await request('read',{version:1,table:'records',id:'http-row',staging:true});expect(identity.status).toBe(200);expect((await identity.json()).channel_id).toBe(f.channel);
 const read=await request('query',{version:1,table:'records',channel_id:f.channel,limit:200,staging:true});expect(read.status).toBe(200);expect((await read.json()).rows.find((r:any)=>r.id==='http-row').on_date).toBe('2026-11-27');
 const replay=await request('batch',hbatch);expect(replay.status).toBe(200);
 const status=await request('status',{channel_id:f.channel,content_type:mime});expect(status.status).toBe(200);expect((await status.json()).version).toBe(1);
 const denied=await request('query',{version:1,table:'records',channel_id:f.channel,limit:10},f.label+'member');expect(denied.status).toBe(403);expect((await denied.json()).code).toBe('permission_denied');
 const deployment=await request('deployment',{});expect(deployment.status).toBe(200);expect((await deployment.json()).descriptor.schema_name).toBe(f.schema);
 const missing=await request('read',{version:1,table:'records',id:'missing',staging:true});expect(missing.status).toBe(404);
 const deniedRead=await request('read',{version:1,table:'records',id:'http-row'},f.label+'member');expect(deniedRead.status).toBe(403);
 const unsigned=await app.request(`http://localhost/api/v4/workspaces/${f.ctx.owner}/apps/${f.ctx.app}/db/native-v1/${f.ctx.workspace}/status`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});expect(unsigned.status).toBe(401);
});


test.skipIf(!process.env.NATIVE_CONSUMER_MODULE)('app-owned consumer DDL and complete policy set apply through deployment services',async()=>{
 const f=await seed('consumer_contract',process.env.NATIVE_CONSUMER_MODULE);
 const policies=await sql`SELECT table_name FROM app_db_native_policies WHERE workspace_id=${f.ctx.workspace}`;
 expect(policies.length).toBeGreaterThanOrEqual(8);
 const columns=await sql`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=${f.schema}`;
 expect(columns.length).toBeGreaterThan(30);
 const consumer=await import(process.env.NATIVE_CONSUMER_MODULE!);
 const {normalize,digest}=await import(new URL('./model.mjs','file://'+process.env.NATIVE_CONSUMER_MODULE).href);
 const bytes=Buffer.from(JSON.stringify({schema:'ambulando.goal',schema_version:1,name:'Dated fixture',description:'Round trip',status:'active',start_date:'2026-11-27',target_date:'2027-01-01',checkpoints:[{id:'checkpoint-string',title:'First',reached:false,date:'2026-12-01'}],links:[],future:'__precise__'}).replace('"__precise__"','9007199254740993'));
 const id=randomUUID(),version=randomUUID(),contentType='application/vnd.ambulando.goal+json';
 const normalized=normalize(bytes,{workspace_id:f.ctx.workspace,channel_id:f.channel,owner_npub:f.ctx.owner,file_id:id,version_id:version,file_revision:'1',sha256:digest(bytes),size_bytes:bytes.length});
 await nativeSetAuthority(f.ctx,{channel_id:f.channel,content_type:contentType,mode:'staging',expected_revision:0});
 const response=await signedRequest(f,'batch',consumer.importBatch(normalized,{timestamp:'2026-11-27T03:00:00Z',actor:f.ctx.actor}));
 const imported=await response.json();expect(response.status,JSON.stringify(imported)).toBe(200);
 const read=await signedRequest(f,'read',{version:1,table:'goals',id,staging:true});const resolved=await read.json();expect(read.status,JSON.stringify(resolved)).toBe(200);expect(resolved.row.start_date).toBe('2026-11-27');expect(resolved.row.target_date).toBe('2027-01-01');expect(resolved.row.extensions).toContain('9007199254740993');

});

});
