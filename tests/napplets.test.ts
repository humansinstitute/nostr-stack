import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { nappletOperation, normalizeNappletManifest, nappletReleaseExpands, verifyNappletBundle } from '../src/services/napplets';
import { resolveOrCreateFlightDeckPgActor } from '../src/services/flightdeck-pg-authorization';
import { createWappDelegation, revokeWappDelegation } from '../src/services/wapp-management';
import { decodeJson } from '../src/services/napplet-protocol.js';

// Opt-in disposable database only; never default to the managed workspace database.
const enabled = Boolean(process.env.NAPPLET_TEST_DATABASE_URL);
const suite = enabled ? describe : describe.skip;
const manifest = JSON.parse(readFileSync(new URL('./fixtures/napplet-manifest-v3.json', import.meta.url), 'utf8'));
const secret = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());
const npub = (s: string) => nip19.npubEncode(getPublicKey(secret(s)));
let sql: ReturnType<typeof postgres>;
let fixture: any;
async function seed(label: string) {
  const actors: any = {};
  for (const key of ['owner', 'user', 'peer', 'agent', 'outsider']) actors[key] = await resolveOrCreateFlightDeckPgActor(npub(label + key), key === 'agent' ? 'agent' : 'human', { sql });
  const app = npub(label + 'app');
  const [w] = await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
    VALUES (${npub(label+'tower')},${npub(label+'service')},${actors.owner.npub},${app},${label},${actors.owner.id}) RETURNING *`;
  for (const key of ['owner', 'user', 'peer', 'agent']) await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES (${w.id},${actors[key].id},${key==='owner'?'owner':'member'})`;
  for (const [who, permission] of [['owner','napplet.install'],['agent','napplet.publish']]) await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission,created_by_actor_id) VALUES (${w.id},'actor',${actors[who].id},'workspace',${permission},${actors.owner.id})`;
  const [s] = await sql`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind,created_by_actor_id) VALUES (${w.id},'test','project',${actors.owner.id}) RETURNING *`;
  const [c] = await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind,created_by_actor_id) VALUES (${w.id},${s.id},'test','channel',${actors.owner.id}) RETURNING *`;
  for (const key of ['owner','agent']) await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission,created_by_actor_id)
    VALUES (${w.id},'actor',${actors[key].id},'channel',${c.id},'file.read',${actors.owner.id})`;
  const [storage] = await sql`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,storage_path,sha256_hex,completed_at) VALUES (${actors.owner.npub},${actors.owner.npub},'text/html','test',${'a'.repeat(64)},now()) RETURNING *`;
  const [file] = await sql`INSERT INTO flightdeck_pg_files(workspace_id,scope_id,channel_id,storage_object_id,created_by_actor_id,updated_by_actor_id) VALUES (${w.id},${s.id},${c.id},${storage.id},${actors.owner.id},${actors.owner.id}) RETURNING *`;
  const [version] = await sql`INSERT INTO flightdeck_pg_file_versions(workspace_id,file_id,version_number,storage_object_id,created_by_actor_id) VALUES (${w.id},${file.id},1,${storage.id},${actors.owner.id}) RETURNING *`;
  const bundle = { file_id: file.id, file_version_id: version.id, sha256_hex: storage.sha256_hex };
  const request = (who: string, id = 'field-notes') => ({workspaceId:w.id,appNpub:app,nappletId:id,actorNpub:actors[who].npub});
  const install = (extra = {}) => ({expected_revision:0,requester_npub:actors.user.npub,publisher_npub:actors.agent.npub,display_name:'Field Notes',bundle,manifest,...extra});
  return {actors,w,c,bundle,request,install,label};
}

suite('napplet authority on disposable Postgres', () => {
  beforeAll(async () => {
    sql = postgres(process.env.NAPPLET_TEST_DATABASE_URL!, { max: 5, onnotice: () => {} }); setDb(sql);
    const [db] = await sql`SELECT current_database() AS name`;
    if (!String(db.name).startsWith('napplet_test_')) throw new Error('Refusing non-test database');
    for (const stmt of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await sql.unsafe(stmt);
    fixture = await seed('napplet-'+randomUUID());
  }, 30000);
  afterAll(async () => { if (sql) await sql.end(); });
  test('bootstrap/runtime schema share identical additive SQL and upgrades preserve rows',async()=>{
    const bootstrap=readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8').split('-- napplet_runtime_v1\n')[1].split('-- end_napplet_runtime_v1')[0];
    const runtime=readFileSync(new URL('../src/schema/napplets.sql',import.meta.url),'utf8');expect(bootstrap).toBe(runtime);
    await sql.unsafe(runtime);await sql.unsafe(runtime);
    const [version]=await sql`SELECT id FROM flightdeck_pg_file_versions WHERE id=${fixture.bundle.file_version_id}`;expect(version.id).toBe(fixture.bundle.file_version_id);
  });
  test('requester-private publication requires actual management delegation and immutable bundle identity', async () => {
    const f=fixture;
    await expect(nappletOperation(f.request('agent'),'install',f.install())).rejects.toMatchObject({code:'delegation_required'});
    const delegation = await createWappDelegation({workspaceId:f.w.id,ownerActorId:f.actors.owner.id,delegateActorId:f.actors.agent.id,expiresAt:new Date(Date.now()+3600000).toISOString(),filters:{app_ids:['field-notes']}},sql);
    f.delegation=delegation;
    await expect(nappletOperation(f.request('agent'),'install',f.install({bundle:{...f.bundle,sha256_hex:'b'.repeat(64)},delegation_id:delegation.id}))).rejects.toMatchObject({code:'bundle_integrity_mismatch'});
    const r:any=await nappletOperation(f.request('agent'),'install',f.install({delegation_id:delegation.id}));
    expect(r.installation.audience_npubs).toEqual([f.actors.user.npub]); expect(r.installation.publisher_npub).toBe(f.actors.agent.npub);
    await expect(nappletOperation(f.request('peer'),'get')).rejects.toMatchObject({code:'napplet_not_found'});
    const list:any=await nappletOperation({...f.request('peer'),nappletId:undefined},'list'); expect(list.installations).toEqual([]);
    await expect(nappletOperation(f.request('owner'),'install',f.install())).rejects.toMatchObject({code:'revision_conflict'});
  });
  test('forged workspace, application, napplet and metadata cannot cross authority',async()=>{
    const f=fixture, foreign=await seed('foreign-'+randomUUID());
    await expect(nappletOperation({...f.request('user'),workspaceId:foreign.w.id},'get')).rejects.toMatchObject({code:'workspace_membership_required'});
    await expect(nappletOperation({...f.request('user'),appNpub:foreign.w.app_npub},'get')).rejects.toMatchObject({code:'workspace_app_mismatch'});
    await expect(nappletOperation(f.request('outsider'),'get')).rejects.toMatchObject({code:'workspace_membership_required'});
    await expect(nappletOperation(f.request('user','forged'),'get')).rejects.toMatchObject({code:'napplet_not_found'});
    await expect(nappletOperation(f.request('user'),'create_collection',{name:'entries',scope:'personal',schema_version:1,owner_npub:f.actors.owner.npub})).rejects.toMatchObject({code:'unknown_field'});
  });
  test('personal data stays private even from manager and UI audience; explicit agents read/write as themselves',async()=>{
    const f=fixture;
    const r:any=await nappletOperation(f.request('user'),'create_collection',{name:'entries',scope:'personal',schema_version:1}); f.collection=r.collection;
    let i:any=await nappletOperation(f.request('user'),'get');
    await nappletOperation(f.request('owner'),'audience',{expected_revision:i.installation.revision,audience_npubs:[f.actors.user.npub,f.actors.peer.npub,f.actors.owner.npub]});
    const opts={collectionId:f.collection.id};
    for(const who of ['peer','owner','agent']) await expect(nappletOperation(f.request(who),'records',{},opts)).rejects.toMatchObject({code:'collection_not_found'});
    await nappletOperation(f.request('user'),'collection_grants',{expected_revision:1,read_npubs:[f.actors.peer.npub],write_npubs:[f.actors.agent.npub]},opts);
    await expect(nappletOperation(f.request('peer'),'put_record',{expected_revision:0,schema_version:1,data:{}},{...opts,recordId:'no'})).rejects.toMatchObject({code:'collection_write_denied'});
    const data:any=await nappletOperation(f.request('agent'),'put_record',{expected_revision:0,schema_version:1,data:{text:'by agent'}},{...opts,recordId:'one'});
    expect(data.record.updated_by_npub).toBe(f.actors.agent.npub);
    await expect(nappletOperation(f.request('peer'),'collection_grants',{expected_revision:2,write_npubs:[f.actors.peer.npub]},opts)).rejects.toMatchObject({code:'collection_owner_required'});
  });
  test('CAS serializes races, bounds pagination, retains revisions/tombstones and revokes agents',async()=>{
    const f=fixture,opts={collectionId:f.collection.id,recordId:'one'};
    const outcomes=await Promise.allSettled([1,2].map(n=>nappletOperation(f.request('agent'),'put_record',{expected_revision:1,schema_version:1,data:{n}},opts)));
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    await expect(nappletOperation(f.request('agent'),'put_record',{expected_revision:0,schema_version:1,data:{}},opts)).rejects.toMatchObject({code:'revision_conflict'});
    for(const id of ['two','three']) await nappletOperation(f.request('user'),'put_record',{expected_revision:0,schema_version:1,data:{id}},{...opts,recordId:id});
    let list:any=await nappletOperation(f.request('peer'),'records',{}, {...opts,limit:2}); expect(list.records).toHaveLength(2); expect(list.next_cursor).toBeTruthy();
    const rest:any=await nappletOperation(f.request('peer'),'records',{}, {...opts,limit:2,after:list.next_cursor}); expect(rest.records).toHaveLength(1); expect(rest.next_cursor).toBeNull();
    expect(new Set([...list.records,...rest.records].map(r=>r.id)).size).toBe(3);
    await expect(nappletOperation(f.request('user'),'records',{}, {...opts,limit:201})).rejects.toMatchObject({code:'invalid_limit'});
    await nappletOperation(f.request('user'),'delete_record',{expected_revision:2},opts);
    const h:any=await nappletOperation(f.request('peer'),'history',{}, {...opts,limit:2}); expect(h.versions.map((r:any)=>r.revision)).toEqual([1,2]); expect(h.next_cursor).toBe('2');
    const h2:any=await nappletOperation(f.request('peer'),'history',{}, {...opts,after:'2'}); expect(h2.versions[0].deleted).toBe(true);
    await expect(nappletOperation(f.request('user'),'put_record',{expected_revision:0,schema_version:1,data:{}},opts)).rejects.toMatchObject({code:'revision_conflict'});
    await nappletOperation(f.request('user'),'collection_grants',{expected_revision:2,read_npubs:[],write_npubs:[]},opts);
    await expect(nappletOperation(f.request('agent'),'record',{},opts)).rejects.toMatchObject({code:'collection_not_found'});
    await expect(nappletOperation(f.request('peer'),'delete_record',{expected_revision:3},opts)).rejects.toMatchObject({code:'collection_not_found'});
  });
  test('committed revocation wins queued writes and removed audience loses open permission',async()=>{
    const f=fixture, opts={collectionId:f.collection.id,recordId:'after_revoke'};
    await nappletOperation(f.request('user'),'collection_grants',{expected_revision:3,write_npubs:[f.actors.agent.npub],read_npubs:[]},opts);
    let locked!:()=>void; const acquired=new Promise<void>(r=>locked=r);
    let unlock!:()=>void; const release=new Promise<void>(r=>unlock=r);
    const revoke=sql.begin(async tx=>{
      const db=tx as unknown as typeof sql;
      await db`SELECT napplet_id FROM flightdeck_pg_napplets WHERE workspace_id=${f.w.id} AND napplet_id='field-notes' FOR UPDATE`;
      locked(); await release;
      await db`UPDATE flightdeck_pg_napplet_collections SET write_npubs='[]',revision=revision+1 WHERE id=${f.collection.id}`;
    });
    await acquired;
    const write=nappletOperation(f.request('agent'),'put_record',{expected_revision:0,schema_version:1,data:{}},opts);
    unlock();await revoke;
    await expect(write).rejects.toMatchObject({code:'collection_not_found'});
    const i:any=await nappletOperation(f.request('user'),'get');
    await nappletOperation(f.request('user'),'audience',{expected_revision:i.installation.revision,audience_npubs:[f.actors.user.npub]});
    await expect(nappletOperation(f.request('peer'),'get')).rejects.toMatchObject({code:'napplet_not_found'});
    const next:any=await nappletOperation(f.request('user'),'get');
    await nappletOperation(f.request('user'),'audience',{expected_revision:next.installation.revision,audience_npubs:[f.actors.user.npub,f.actors.peer.npub,f.actors.owner.npub]});
  });
  test('authenticated production Hono routes enforce payload auth, exact JSON and isolation',async()=>{
    const { createApp }=await import('../src/server'); const app=createApp();const f=fixture;
    const root=`/api/v4/flightdeck-pg/workspaces/${f.w.id}/apps/${f.w.app_npub}/napplets/field-notes`;
    const signed=async(method:string,path:string,who:string,body?:any)=>{
      const tags=[['u',`http://localhost${path}`],['method',method]];
      if(body!==undefined)tags.push(['payload',createHash('sha256').update(JSON.stringify(body)).digest('hex')]);
      const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags,content:''},secret(f.label+who));
      return app.request(path,{method,headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    };
    expect((await app.request(root)).status).toBe(401);
    const visible=await signed('GET',root,'user');expect(visible.status).toBe(200);expect(visible.headers.get('cache-control')).toBe('no-store');
    expect((await signed('GET',root,'outsider')).status).toBe(403);
    const spoof=await signed('PUT',root+`/collections/${f.collection.id}/records/spoof`,'user',{expected_revision:0,schema_version:1,data:{},owner_npub:f.actors.peer.npub});
    expect(spoof.status).toBe(400);expect((await spoof.json()).code).toBe('unknown_field');
    const write=await signed('PUT',root+`/collections/${f.collection.id}/records/http_record`,'user',{expected_revision:0,schema_version:1,data:{confirmed:true}});
    expect(write.status).toBe(200);expect((await write.json()).record.data).toEqual({confirmed:true});
  });
  test('publisher updates automatically within grants, expansion stages and cannot be approved by agent',async()=>{
    const f=fixture;
    let i:any=await nappletOperation(f.request('agent'),'get'); const updated=structuredClone(manifest);updated.bundle_version='1.0.1';updated.title='Updated title';
    let r:any=await nappletOperation(f.request('agent'),'publish',{expected_revision:i.installation.revision,bundle:f.bundle,manifest:updated});expect(r.installation.pending_release).toBeNull();expect(r.installation.manifest.bundle_version).toBe('1.0.1');
    const expanded=structuredClone(updated);expanded.capabilities={'nostr-dm':{version:1,resources:['relay'],operations:['read']}};
    r=await nappletOperation(f.request('agent'),'publish',{expected_revision:r.installation.revision,bundle:f.bundle,manifest:expanded}); expect(r.installation.manifest.capabilities).toEqual({}); expect(r.installation.pending_release.manifest.capabilities).toEqual(expanded.capabilities);
    await expect(nappletOperation(f.request('agent'),'approve',{expected_revision:r.installation.revision,delegation_id:f.delegation.id})).rejects.toMatchObject({code:'human_expansion_approval_required'});
    await expect(nappletOperation(f.request('peer'),'publish',{expected_revision:r.installation.revision,bundle:f.bundle,manifest:updated})).rejects.toMatchObject({code:'publisher_required'});
    await revokeWappDelegation(f.w.id,f.delegation.id,f.actors.owner.id,sql);
    await expect(nappletOperation(f.request('agent'),'audience',{expected_revision:r.installation.revision,audience_npubs:[f.actors.agent.npub],delegation_id:f.delegation.id})).rejects.toMatchObject({code:'delegation_revoked'});
  });
  test('revoked dedicated installation/publishing rights cannot be bypassed by identity or role',async()=>{
    const f=await seed('revoked-'+randomUUID());
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.w.id} AND permission='napplet.install'`;
    await expect(nappletOperation(f.request('owner'),'install',f.install())).rejects.toMatchObject({code:'napplet_install_required'});
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${f.w.id} AND permission='napplet.install'`;
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.w.id} AND permission='napplet.publish'`;
    await expect(nappletOperation(f.request('owner'),'install',f.install())).rejects.toMatchObject({code:'napplet_publish_required'});
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${f.w.id} AND permission='napplet.publish'`;
    await nappletOperation(f.request('owner'),'install',f.install());
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.w.id} AND permission='napplet.publish'`;
    await expect(nappletOperation(f.request('agent'),'publish',{expected_revision:1,bundle:f.bundle,manifest})).rejects.toMatchObject({code:'napplet_publish_required'});
  });
  test('team grants remain separate and declared read-only operations cannot write',async()=>{
    const f=fixture;const r:any=await nappletOperation(f.request('user'),'create_collection',{name:'team_notes',scope:'team',schema_version:1,read_npubs:[f.actors.peer.npub]});
    expect(r.collection.scope).toBe('team');
    await expect(nappletOperation(f.request('user'),'put_record',{expected_revision:0,schema_version:1,data:{}},{collectionId:r.collection.id,recordId:'new'})).rejects.toMatchObject({code:'operation_not_declared'});
    const list:any=await nappletOperation(f.request('peer'),'records',{}, {collectionId:r.collection.id});expect(list.records).toEqual([]);
  });
  test('explicit compatible File import preserves original/history and rejects overwrite or forged sources',async()=>{
    const f=fixture,opts={collectionId:f.collection.id};
    const [g]=await sql`SELECT revision FROM flightdeck_pg_napplet_collections WHERE id=${f.collection.id}`;
    const input={expected_revision:g.revision,from_schema_version:1,to_schema_version:1,compatible:true,source:f.bundle,records:[{id:'imported',data:{retained:true}}]};
    // Import owner needs explicit File read permission; UI audience alone does not grant it.
    await expect(nappletOperation(f.request('user'),'migrate',input,opts)).rejects.toMatchObject({code:'file_read_denied'});
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission,created_by_actor_id) VALUES (${f.w.id},'actor',${f.actors.user.id},'channel',${f.c.id},'file.read',${f.actors.owner.id})`;
    const result:any=await nappletOperation(f.request('user'),'migrate',input,opts);expect(result.source_preserved).toBe(true);expect(result.imported).toBe(1);
    const [source]=await sql`SELECT id FROM flightdeck_pg_file_versions WHERE id=${f.bundle.file_version_id}`;expect(source.id).toBe(f.bundle.file_version_id);
    await expect(nappletOperation(f.request('user'),'migrate',{...input,expected_revision:result.collection.revision},opts)).rejects.toMatchObject({code:'record_conflict'});
    await expect(nappletOperation(f.request('user'),'migrate',{...input,expected_revision:result.collection.revision,compatible:false},opts)).rejects.toMatchObject({code:'incompatible_migration'});
    await expect(nappletOperation(f.request('user'),'migrate',{...input,expected_revision:result.collection.revision,source:{...f.bundle,file_version_id:randomUUID()}},opts)).rejects.toMatchObject({code:'bundle_integrity_mismatch'});
  });
  test('confirmed owner deletion removes collection history but keeps immutable File versions',async()=>{
    const f=await seed('delete-'+randomUUID());
    await nappletOperation(f.request('owner'),'install',f.install({requester_npub:f.actors.owner.npub}));
    const c:any=await nappletOperation(f.request('owner'),'create_collection',{name:'entries',scope:'personal',schema_version:1});
    await nappletOperation(f.request('owner'),'put_record',{expected_revision:0,schema_version:1,data:{remove:true}},{collectionId:c.collection.id,recordId:'owned'});
    await nappletOperation(f.request('owner'),'remove',{expected_revision:1,data:'delete',confirm_napplet_id:'field-notes'});
    const [count]=await sql`SELECT count(*)::int n FROM flightdeck_pg_napplet_record_versions WHERE collection_id=${c.collection.id}`;expect(count.n).toBe(0);
    const [source]=await sql`SELECT id FROM flightdeck_pg_file_versions WHERE id=${f.bundle.file_version_id}`;expect(source.id).toBe(f.bundle.file_version_id);
  });
  test('removal keep/reinstall retains data; delete requires confirmation and every collection owner',async()=>{
    const f=fixture;let i:any=await nappletOperation(f.request('user'),'get');
    await expect(nappletOperation(f.request('owner'),'remove',{expected_revision:i.installation.revision,data:'delete',confirm_napplet_id:'field-notes'})).rejects.toMatchObject({code:'collection_owner_required'});
    await expect(nappletOperation(f.request('owner'),'remove',{expected_revision:i.installation.revision,data:'delete'})).rejects.toMatchObject({code:'deletion_confirmation_required'});
    const removed:any=await nappletOperation(f.request('owner'),'remove',{expected_revision:i.installation.revision,data:'keep'});
    const reconnect:any=await nappletOperation(f.request('user'),'get');expect(reconnect.installation.removed).toBe(true);expect(reconnect.installation.revision).toBe(removed.installation.revision);
    const publisher:any=await nappletOperation(f.request('agent'),'get');expect(publisher.installation.removed).toBe(true);
    await expect(nappletOperation(f.request('peer'),'get')).rejects.toMatchObject({code:'delegation_required'});
    await expect(nappletOperation(f.request('user'),'records',{}, {collectionId:f.collection.id})).rejects.toMatchObject({code:'napplet_not_found'});
    const reinstalled:any=await nappletOperation(f.request('owner'),'install',f.install({expected_revision:removed.installation.revision}));
    const kept:any=await nappletOperation(f.request('user'),'record',{}, {collectionId:f.collection.id,recordId:'imported'});expect(kept.record.data.retained).toBe(true);
    await expect(nappletOperation(f.request('peer'),'remove',{expected_revision:reinstalled.installation.revision,data:'keep'})).rejects.toMatchObject({code:'delegation_required'});
  });
});

describe('portable manifest and hostile JSON',()=>{
  test('all runtime routes publish registered NIP-98 security and exact v3 request schema',async()=>{
    const {buildOpenApiDocument}=await import('../src/openapi');const api:any=buildOpenApiDocument('http://localhost');
    const prefix='/api/v4/flightdeck-pg/workspaces/{workspaceId}/apps/{appNpub}/napplets';
    const paths=Object.entries(api.paths).filter(([p])=>p.startsWith(prefix));
    expect(paths.reduce((n,[,v])=>n+Object.keys(v as any).length,0)).toBe(18);
    for(const [,v] of paths)for(const route of Object.values(v as any) as any[])expect(api.components.securitySchemes[Object.keys(route.security[0])[0]]).toBeDefined();
    const schema=api.paths[prefix+'/{nappletId}'].put.requestBody.content['application/json'].schema;
    expect(schema.additionalProperties).toBe(false);expect(schema.properties.manifest.properties.version.const).toBe(3);
  });
  test('frozen v3 validates and ordinary versions do not expand access',()=>{
    expect(normalizeNappletManifest(manifest)).toEqual(manifest);
    expect(nappletReleaseExpands(manifest,{...manifest,bundle_version:'2',title:'new'})).toBe(false);
    for(const change of [
      {...manifest,collections:{...manifest.collections,entries:{...manifest.collections.entries,scope:'team'}}},
      {...manifest,collections:{...manifest.collections,entries:{...manifest.collections.entries,schema_version:2}}},
      {...manifest,capabilities:{dm:{version:1,resources:['relay'],operations:['read']}}},
    ]) expect(nappletReleaseExpands(manifest,change)).toBe(true);
  });
  test('bundle bytes must match digest and every approved manifest declaration',()=>{
    const bytes=new TextEncoder().encode(`<html><script id="wingman-napplet-manifest" type="application/json">${JSON.stringify(manifest)}</script></html>`);
    const installation={bundle:{file_id:randomUUID(),file_version_id:randomUUID(),sha256_hex:createHash('sha256').update(bytes).digest('hex')},manifest};
    expect(verifyNappletBundle(bytes,installation)).toBe(installation.bundle.sha256_hex);
    expect(()=>verifyNappletBundle(bytes,{...installation,bundle:{...installation.bundle,sha256_hex:'b'.repeat(64)}})).toThrow('bundle_integrity_mismatch');
    expect(()=>verifyNappletBundle(bytes,{...installation,manifest:{...manifest,collections:{}}})).toThrow('bundle_manifest_mismatch');
  });
  test('rejects duplicate/unsafe keys and malformed identity/schema',()=>{
    for(const json of ['{"a":1,"a":2}','{"__proto__":{}}','{"a":9007199254740992}']) expect(()=>decodeJson(json)).toThrow();
    expect(()=>normalizeNappletManifest({...manifest,publisher_npub:'spoof'})).toThrow();
    expect(()=>normalizeNappletManifest({...manifest,napplet_id:'../other'})).toThrow();
  });
});
