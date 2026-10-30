import { beforeAll, afterAll, test, expect } from 'bun:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { Hono } from 'hono';
import { nip19, generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { setDb, closeDb } from '../src/db';
import { authorizeFlightDeckPgOperation } from '../src/services/flightdeck-pg-authorization';
import { readPermissionDiagnostics, parseDiagnosticAuthorizations, matchDiagnosticAuthorization, sanitizeDiagnosticAudit } from '../src/services/permission-diagnostics';
import { createFlightDeckPgChannelGrants, flightDeckPgPermissionsForAccessLevel, resolveFlightDeckPgChannel } from '../src/services/flightdeck-pg-api';
import { flightDeckPgRouter } from '../src/routes/flightdeck-pg';
import { registerPermissionDiagnosticRoutes } from '../src/routes/permission-diagnostics';
import type { PermissionDiagnosticAuthorization, PermissionDiagnosticRequest } from '../src/types';

const npub = (s:string) => nip19.npubEncode(createHash('sha256').update(s).digest('hex'));
const database = `tower_diag_test_${randomUUID().replaceAll('-','')}`; // never use caller-selected/shared DB
const options = { host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),username:process.env.DB_USER||'postgres',password:process.env.DB_PASSWORD||'postgres' };
let sql: ReturnType<typeof postgres>;
const workdir=mkdtempSync(join(tmpdir(),'tower-diagnostics-'));
const originalCwd=process.cwd();
const signingKey=generateSecretKey(), signerNpub=nip19.npubEncode(getPublicKey(signingKey));
const actorId=randomUUID(), targetId=randomUUID(), otherActor=randomUUID(), workspaceId=randomUUID(), scopeId=randomUUID(), siblingScope=randomUUID(), channelId=randomUUID(), siblingChannel=randomUUID(), child=randomUUID(), parent=randomUUID();
const targetNpub=npub('diagnostic target'), appNpub=npub('diagnostic app'), towerNpub=npub('diagnostic tower');
const input: PermissionDiagnosticRequest={workspaceId,channelId,signerNpub,userNpub:signerNpub,appNpub,targetNpub,caseId:'test-case',limit:100,offset:0};
const authorization: PermissionDiagnosticAuthorization={case_id:input.caseId,signer_npub:signerNpub,target_actor_npub:targetNpub,tower_service_npub:towerNpub,app_npub:appNpub,workspace_id:workspaceId,scope_id:scopeId,channel_id:channelId,issued_at:new Date(Date.now()-60000).toISOString(),expires_at:new Date(Date.now()+3600000).toISOString()};
const configFile=join(workdir,'config/permission-diagnostics.json');
function manifest(entries: unknown= [authorization]) { writeFileSync(configFile,JSON.stringify({version:1,authorizations:entries})); }
async function report(overrides: Partial<PermissionDiagnosticRequest>={}) {
  process.chdir(workdir);
  try { return await readPermissionDiagnostics({...input,...overrides},sql); } finally { process.chdir(originalCwd); }
}
async function denied(overrides: Partial<PermissionDiagnosticRequest>={}) { await expect(report(overrides)).rejects.toMatchObject({status:403,code:'diagnostic_access_denied'}); }
beforeAll(async()=>{
  mkdirSync(join(workdir,'config'));
  const admin=postgres({...options,database:'postgres'});
  try { await admin.unsafe(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
  sql=postgres({...options,database}); setDb(sql);
  await sql.unsafe(readFileSync(join(originalCwd,'src/schema/001_init.sql'),'utf8'));
  await sql`INSERT INTO flightdeck_pg_actors(id,npub,kind) VALUES(${actorId},${signerNpub},'agent'),(${targetId},${targetNpub},'human'),(${otherActor},${npub('wrong target')},'human')`;
  await sql`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${workspaceId},${towerNpub},${npub('diag workspace')},${npub('diag owner')},${appNpub},'diagnostic fixture')`;
  for(const id of [actorId,targetId,otherActor]) await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${id},'member')`;
  for(const id of [scopeId,siblingScope]) await sql`INSERT INTO flightdeck_pg_scopes(id,workspace_id,name,kind) VALUES(${id},${workspaceId},${id},'project')`;
  for(const id of [channelId,siblingChannel]) await sql`INSERT INTO flightdeck_pg_channels(id,workspace_id,scope_id,name,kind) VALUES(${id},${workspaceId},${scopeId},${id},'channel')`;
  for(const id of [child,parent]) await sql`INSERT INTO flightdeck_pg_groups(id,workspace_id,name,kind) VALUES(${id},${workspaceId},${id},'custom')`;
  await sql`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${workspaceId},${child},${targetId})`;
  await sql`INSERT INTO flightdeck_pg_group_edges(workspace_id,parent_group_id,child_group_id) VALUES(${workspaceId},${parent},${child})`;
  await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission) VALUES(${workspaceId},'actor',${targetId},'scope',${scopeId},'scope.manage')`;
  await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,resource_channel_id,permission) VALUES(${workspaceId},'group',${parent},'channel',${channelId},'channel.read')`;
  await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission,revoked_at) VALUES(${workspaceId},'actor',${targetId},'channel',${channelId},'channel.write',now()),(${workspaceId},'actor',${otherActor},'channel',${channelId},'channel.manage',NULL),(${workspaceId},'actor',${targetId},'channel',${siblingChannel},'channel.write',NULL)`;
  for(let i=0;i<3;i++) await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,actor_id,action,resource_type,resource_id,metadata) VALUES(${workspaceId},${otherActor},'channel_grant.update','channel',${channelId},${sql.json({principal_type:'actor',principal_id:otherActor,access_level:'manage',permissions:['channel.manage','arbitrary secret'],body:'DO NOT LEAK',wrapped_keys:'DO NOT LEAK',metadata:{secret:'DO NOT LEAK'}})})`;
  await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,action,resource_type,resource_id,metadata) VALUES(${workspaceId},'channel_grant.update','channel',${siblingChannel},${sql.json({body:'SIBLING SECRET'})}),(${workspaceId},'doc.update','channel',${channelId},${sql.json({body:'CONTENT SECRET'})})`;
});
afterAll(async()=>{
  process.chdir(originalCwd); await closeDb();
  const admin=postgres({...options,database:'postgres'});
  try { if(!/^tower_diag_test_[a-f0-9]{32}$/.test(database))throw Error('unsafe test DB'); await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); } finally {await admin.end();rmSync(workdir,{recursive:true,force:true});}
});
test('manifest validation fails closed; exact signer/resource/audience/time match only',()=>{
  expect(parseDiagnosticAuthorizations({version:1,authorizations:[authorization]})).toEqual([authorization]);
  for(const patch of [{workspace_id:'*'},{scope_id:'*'},{signer_npub:'npub1bad'},{case_id:4},{issued_at:'yesterday'},{expires_at:'2026-02-30T00:00:00.000Z'},{extra:'ignored?'},{expires_at:new Date(Date.now()+48*3600000).toISOString()}]) expect(parseDiagnosticAuthorizations({version:1,authorizations:[{...authorization,...patch}]})).toEqual([]);
  expect(matchDiagnosticAuthorization([authorization],input)).toBeDefined();
  expect(matchDiagnosticAuthorization([authorization],{...input,signerNpub:npub('another signer')})).toBeUndefined();
  expect(matchDiagnosticAuthorization([authorization],input,Date.parse(authorization.expires_at))).toBeUndefined();
  expect(matchDiagnosticAuthorization([authorization],input,Date.parse(authorization.issued_at)-1)).toBeUndefined();
});
test('approved exact case: revoked/wrong-principal grants, scope distinction, actual group provenance and sanitized audit',async()=>{
  manifest();const r=await report();
  if(process.env.DIAGNOSTIC_TEST_SAMPLE_PATH) writeFileSync(process.env.DIAGNOSTIC_TEST_SAMPLE_PATH,JSON.stringify(r,null,2));
  expect(r.access.mode).toBe('operator_support');expect(r.target.id).toBe(targetId);
  expect(r.grants.items.some(g=>g.revoked_at && g.permission==='channel.write')).toBe(true);
  expect(r.grants.items.some(g=>g.principal_actor_id===otherActor)).toBe(true);
  expect(r.grants.items.every(g=>g.resource_channel_id===channelId||g.resource_scope_id===scopeId)).toBe(true);
  expect(r.group_provenance.items.map(p=>p.source).sort()).toEqual(['direct','parent']);
  expect(r.decisions.find(d=>d.permission==='channel.read')).toMatchObject({allowed:true,reason:'allowed'});
  expect(r.matching_sources.some(s=>s.principal_group_id===parent)).toBe(true);
  expect(r.decisions.find(d=>d.permission==='scope.manage')).toMatchObject({allowed:true});
  expect(r.decisions.find(d=>d.permission==='channel.write')).toMatchObject({allowed:false,reason:'permission-grant-required'});
  expect(r.audit.items).toHaveLength(3);expect(r.audit.items[0]!.changes).toMatchObject({principal_id:otherActor,permissions:['channel.manage']});
  expect(JSON.stringify(r)).not.toContain('SECRET');expect(JSON.stringify(r)).not.toContain('DO NOT LEAK');expect(JSON.stringify(r)).not.toContain(siblingChannel);
  const [receipt]=await sql`SELECT metadata FROM flightdeck_pg_audit_events WHERE id=${r.audit_receipt_id}`;
  expect(receipt!.metadata).toMatchObject({case_id:input.caseId,signer_npub:signerNpub,resolved_user_npub:signerNpub,access:'operator_support'});
});
test('support cannot change actual channel write or grant-management authority',async()=>{
  manifest();
  for(const permission of ['channel.write','channel.grants.read','channel.grants.manage']) {
    const request={actorNpub:signerNpub,appNpub,workspaceId,permission,resource:{type:'channel' as const,channelId}};
    expect((await authorizeFlightDeckPgOperation(request,sql)).allowed).toBe(false);
    await report();
    expect((await authorizeFlightDeckPgOperation(request,sql)).allowed).toBe(false);
  }
});
test('wrong signer, resolved-user-only match, case, target, workspace, channel, app and scope all deny',async()=>{
  manifest();await denied({signerNpub:npub('different signer')});await denied({caseId:'wrong-case'});await denied({targetNpub:npub('wrong target')});await denied({channelId:siblingChannel});await denied({workspaceId:randomUUID()});await denied({appNpub:npub('wrong app')});
  for(const patch of [{tower_service_npub:npub('wrong tower')},{app_npub:npub('wrong app')},{scope_id:siblingScope}]){manifest([{...authorization,...patch}]);await denied();}
  manifest();await sql`UPDATE flightdeck_pg_channels SET scope_id=${siblingScope} WHERE id=${channelId}`;
  try {await denied();}finally{await sql`UPDATE flightdeck_pg_channels SET scope_id=${scopeId} WHERE id=${channelId}`;}
});
test('missing, malformed, expired, future-issued file and target nonmembership deny; reload observes removal',async()=>{
  for(const entries of [[],[{...authorization,expires_at:new Date(Date.now()-1).toISOString()}],[{...authorization,issued_at:new Date(Date.now()+10000).toISOString()}],[{...authorization,workspace_id:'*'}]]){manifest(entries);await denied();}
  writeFileSync(configFile,'{');await denied();rmSync(configFile);await denied();
  manifest();await report();rmSync(configFile);await denied();
  manifest([{...authorization,target_actor_npub:npub('nonmember')}]);await expect(report({targetNpub:npub('nonmember')})).rejects.toMatchObject({status:404});
});
test('bounded independent collections, allowlisted permission bounds and explicit truncation',async()=>{
  manifest();const r=await report({limit:1});
  for(const collection of [r.grants,r.audit,r.group_provenance]){expect(collection.items).toHaveLength(1);expect(collection.truncated).toBe(true);expect(collection.next_offset).toBe(1);}
  const next=await report({limit:1,offset:1});expect(next.grants.items[0]!.id).not.toBe(r.grants.items[0]!.id);
  expect(sanitizeDiagnosticAudit({principal_type:['actor'],access_level:['manage'],role:['scope_manager']})).toEqual({});
  expect(sanitizeDiagnosticAudit({permissions:Array(100).fill('channel.read'),body:'secret'})).toEqual({permissions:Array(64).fill('channel.read'),permissions_truncated:true});
});
test('workspace.manage alone grants no diagnostic channel or membership authority',async()=>{
  manifest([]);await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${workspaceId},'actor',${actorId},'workspace','workspace.manage')`;
  try{await denied();}finally{await sql`DELETE FROM flightdeck_pg_permission_grants WHERE workspace_id=${workspaceId} AND principal_actor_id=${actorId}`;}
});
test('existing channel grant-read remains available, with scope and membership provenance independently redacted',async()=>{
  manifest([]);await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspaceId},'actor',${actorId},'channel',${channelId},'channel.grants.read')`;
  try{const r=await report();expect(r.access).toMatchObject({mode:'existing_acl',scope_metadata:false,group_provenance:false});expect(r.group_provenance.items).toEqual([]);expect(r.grants.items.every(g=>g.resource_type==='channel')).toBe(true);expect(r.decisions.every(d=>d.resource_type==='channel')).toBe(true);}
  finally{await sql`DELETE FROM flightdeck_pg_permission_grants WHERE workspace_id=${workspaceId} AND principal_actor_id=${actorId}`;}
});
test('exact NIP98 HTTP, no-store, unsupported fields, signature URL/method mismatch and no unauthenticated access',async()=>{
  manifest();const router=new Hono();registerPermissionDiagnosticRoutes(router);
  const url=`http://localhost/workspaces/${workspaceId}/channels/${channelId}/permission-diagnostics?target_npub=${targetNpub}&case_id=test-case`;
  const header=(u=url,method='GET')=>'Nostr '+Buffer.from(JSON.stringify(finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',u],['method',method]],content:''},signingKey))).toString('base64');
  process.chdir(workdir);
  try{
    const r=await router.request(url,{headers:{authorization:header()}});expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await router.request(url)).status).toBe(401);
    expect((await router.request(url,{headers:{authorization:header(url,'POST')}})).status).toBe(401);
    expect((await router.request(url+'&limit=1',{headers:{authorization:header()}})).status).toBe(401);
    for(const suffix of ['&path=/tmp/foo','&case_id=duplicate','&limit=-1'])expect((await router.request(url+suffix,{headers:{authorization:header(url+suffix)}})).status).toBe(400);
  }finally{process.chdir(originalCwd);}
});

test('only paths reaching exact grant principals are exposed; cyclic graph is finite and unreachable grant group explicit',async()=>{
  manifest();const unrelated=randomUUID(),unreachable=randomUUID();
  for(const id of [unrelated,unreachable])await sql`INSERT INTO flightdeck_pg_groups(id,workspace_id,name,kind) VALUES(${id},${workspaceId},${id},'custom')`;
  await sql`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${workspaceId},${unrelated},${targetId})`;
  await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,resource_channel_id,permission) VALUES(${workspaceId},'group',${unreachable},'channel',${channelId},'channel.manage')`;
  await sql`INSERT INTO flightdeck_pg_group_edges(workspace_id,parent_group_id,child_group_id) VALUES(${workspaceId},${child},${parent})`;
  try{const r=await report();expect(JSON.stringify(r)).not.toContain(unrelated);expect(r.group_provenance.items.length).toBe(3);expect(r.group_reachability.items).toContainEqual({group_id:unreachable,target_reaches_group:false});}
  finally{await sql`DELETE FROM flightdeck_pg_group_edges WHERE workspace_id=${workspaceId} AND parent_group_id=${child}`;await sql`DELETE FROM flightdeck_pg_groups WHERE workspace_id=${workspaceId} AND id IN ${sql([unrelated,unreachable])}`;}
});
test('failed audit receipt prevents any successful report',async()=>{
  manifest();await sql.unsafe(`CREATE FUNCTION diagnostic_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='permission_diagnostic.read' THEN RAISE EXCEPTION 'receipt disabled'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER diagnostic_test_reject_audit BEFORE INSERT ON flightdeck_pg_audit_events FOR EACH ROW EXECUTE FUNCTION diagnostic_test_reject_audit()`);
  try{await expect(report()).rejects.toThrow('receipt disabled');}finally{await sql.unsafe('DROP TRIGGER diagnostic_test_reject_audit ON flightdeck_pg_audit_events');await sql.unsafe('DROP FUNCTION diagnostic_test_reject_audit()');}
});

test('operator support does not authorize existing HTTP grant reads or grant writes',async()=>{
  manifest();process.chdir(workdir);
  try {
    const url=`http://localhost/workspaces/${workspaceId}/channels/${channelId}/grants`;
    for(const method of ['GET','POST']) {
      const body=method==='POST'?JSON.stringify({principal_type:'actor',principal_id:actorId,access_level:'manage'}):undefined;
      const tags=[['u',url],['method',method]];if(body)tags.push(['payload',createHash('sha256').update(body).digest('hex')]);
      const authorization='Nostr '+Buffer.from(JSON.stringify(finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags,content:''},signingKey))).toString('base64');
      const r=await flightDeckPgRouter.request(url,{method,body,headers:{authorization,'content-type':'application/json','x-flightdeck-pg-app-npub':appNpub}});
      expect(r.status).toBe(403);const data=await r.json();expect(JSON.stringify(data)).toContain(method==='POST'?'channel.grants.manage':'channel.grants.read');
    }
  } finally {process.chdir(originalCwd);}
});

test('same resource UUID in foreign workspace audit cannot leak; exact Manage changes real target decisions and revocation removes them',async()=>{
  manifest();const foreign=randomUUID();
  await sql`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${foreign},${towerNpub},${npub('foreign workspace')},${npub('foreign owner')},${appNpub},'foreign private')`;
  await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,action,resource_type,resource_id,metadata) VALUES(${foreign},'channel_grant.update','channel',${channelId},${sql.json({principal_type:'actor',principal_id:foreign,permissions:['channel.write']})})`;
  const before=await report();expect(before.audit.items.every(a=>a.changes.principal_id!==foreign)).toBe(true);
  expect(before.decisions.find(d=>d.permission==='channel.write')!.allowed).toBe(false);
  const channel=await resolveFlightDeckPgChannel(workspaceId,channelId,sql);
  const grants=await createFlightDeckPgChannelGrants({workspaceId,channel:channel!,principalType:'actor',principalId:targetId,permissions:flightDeckPgPermissionsForAccessLevel('manage'),createdByActorId:otherActor},sql);
  try {
    const after=await report();for(const p of ['channel.write','channel.grants.read','channel.grants.manage'])expect(after.decisions.find(d=>d.permission===p)!.allowed).toBe(true);
    expect((await authorizeFlightDeckPgOperation({actorNpub:targetNpub,appNpub,workspaceId,permission:'channel.grants.manage',resource:{type:'channel',channelId:siblingChannel}},sql)).allowed).toBe(false);
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE id IN ${sql(grants.map(g=>g.id))}`;
    const revoked=await report();expect(revoked.decisions.find(d=>d.permission==='channel.write')!.allowed).toBe(false);
  } finally {await sql`DELETE FROM flightdeck_pg_workspaces WHERE id=${foreign}`;await sql`DELETE FROM flightdeck_pg_permission_grants WHERE id IN ${sql(grants.map(g=>g.id))}`;}
});
test('support permits neither existing message creation nor cross-workspace diagnostic access',async()=>{
  manifest();process.chdir(workdir);
  try {
    const url=`http://localhost/workspaces/${workspaceId}/channels/${channelId}/messages`,body=JSON.stringify({body:'must remain denied'});
    const tags=[['u',url],['method','POST'],['payload',createHash('sha256').update(body).digest('hex')]];
    const authorization='Nostr '+Buffer.from(JSON.stringify(finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags,content:''},signingKey))).toString('base64');
    const r=await flightDeckPgRouter.request(url,{method:'POST',body,headers:{authorization,'content-type':'application/json','x-flightdeck-pg-app-npub':appNpub}});
    expect(r.status).toBe(403);expect(JSON.stringify(await r.json())).toContain('channel.write');
  } finally {process.chdir(originalCwd);}
});

test('expiry during slow audit work rolls back receipt and refuses report',async()=>{
  manifest([{...authorization,expires_at:new Date(Date.now()+150).toISOString()}]);
  const [before]=await sql`SELECT count(*)::int AS count FROM flightdeck_pg_audit_events WHERE action='permission_diagnostic.read'`;
  await sql.unsafe(`CREATE FUNCTION diagnostic_test_delay_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='permission_diagnostic.read' THEN PERFORM pg_sleep(0.25); END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER diagnostic_test_delay_audit BEFORE INSERT ON flightdeck_pg_audit_events FOR EACH ROW EXECUTE FUNCTION diagnostic_test_delay_audit()`);
  try{await denied();const [after]=await sql`SELECT count(*)::int AS count FROM flightdeck_pg_audit_events WHERE action='permission_diagnostic.read'`;expect(after!.count).toBe(before!.count);}
  finally{await sql.unsafe('DROP TRIGGER diagnostic_test_delay_audit ON flightdeck_pg_audit_events');await sql.unsafe('DROP FUNCTION diagnostic_test_delay_audit()');manifest();}
});
