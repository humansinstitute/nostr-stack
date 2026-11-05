import { beforeAll, afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb, closeDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { authorizeFlightDeckPgOperation } from '../src/services/flightdeck-pg-authorization';

const database=`tower_test_general_${process.pid}`;
const connection={host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),username:process.env.DB_USER||'postgres',password:process.env.DB_PASSWORD||'postgres',onnotice:()=>{}};
let sql: ReturnType<typeof postgres>, app: ReturnType<typeof createApp>;
beforeAll(async()=>{
  const admin=postgres({...connection,database:'postgres'});
  await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
  sql=postgres({...connection,database});setDb(sql);
  for(const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8'))) await sql.unsafe(statement);
  for(const name of ['notifications-v1.sql','agent-notifications-v1.sql','workspace-membership-admin-v1.sql']) await sql.unsafe(readFileSync(new URL(`../src/schema/${name}`,import.meta.url),'utf8'));
  // Runtime migration must also be repeatable.
  for(let n=0;n<2;n++) await sql.unsafe(readFileSync(new URL('../src/schema/workspace-general-v1.sql',import.meta.url),'utf8'));
  app=createApp();
},30000);
afterAll(async()=>{await closeDb();const admin=postgres({...connection,database:'postgres'});await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);await admin.end();});
async function fixture(){
  const secret=randomBytes(32), npub=nip19.npubEncode(getPublicKey(secret)), appNpub=`test-app-${randomUUID()}`;
  const [actor]=await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING *`;
  const [workspace]=await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id) VALUES('test',${randomUUID()},${npub},${appNpub},'Test',${actor.id}) RETURNING *`;
  await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace.id},${actor.id},'owner')`;
  const [group]=await sql`SELECT * FROM flightdeck_pg_groups WHERE workspace_id=${workspace.id} AND name='Workspace'`;
  for(const permission of ['workspace.read','workspace.manage','workspace.invite']) await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${workspace.id},'actor',${actor.id},'workspace',${permission})`;
  async function request(suffix='general/ensure',body:unknown={},key=secret,w=workspace.id){
    const path=`/api/v4/flightdeck-pg/workspaces/${w}/${suffix}`,text=JSON.stringify(body);
    const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',`http://localhost${path}`],['method','POST'],['payload',createHash('sha256').update(text).digest('hex')]]},key);
    const r=await app.request(path,{method:'POST',headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,'content-type':'application/json','x-flightdeck-pg-app-npub':appNpub},body:text});
    return {status:r.status,body:await r.json() as any};
  }
  const allowed=async(npub:string,permission:string,channelId:string)=> (await authorizeFlightDeckPgOperation({actorNpub:npub,appNpub,workspaceId:workspace.id,permission:permission as any,resource:{type:'channel',channelId}},sql)).allowed;
  return {secret,npub,actor,workspace,group,request,allowed};
}
async function member(f:Awaited<ReturnType<typeof fixture>>){
  const secret=randomBytes(32),npub=nip19.npubEncode(getPublicKey(secret));
  const r=await f.request('invites',{invitee_npub:npub,kind:'agent',role:'member'});expect(r.status).toBe(201);
  return {secret,npub,id:r.body.actor.actor_id};
}

test('concurrent ensure converges; does not adopt private names; survives rename and repeat migration',async()=>{
  const f=await fixture();
  const [privateScope]=await sql`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${f.workspace.id},'General','custom') RETURNING *`;
  const results=await Promise.all(Array.from({length:6},()=>f.request()));
  expect(results.map(r=>r.status).sort()).toEqual([200,200,200,200,200,201]);
  const ids=new Set(results.map(r=>r.body.channel.id));expect(ids.size).toBe(1);
  const a=results[0].body;expect(a.scope.id).not.toBe(privateScope.id);expect(a.policy).toEqual({version:1,kind:'all_workspace_members',group_id:f.group.id,access_level:'contribute'});
  await sql`UPDATE flightdeck_pg_channels SET name='Renamed' WHERE id=${a.channel.id}`;
  expect((await f.request()).body.channel.id).toBe(a.channel.id);
  await expect(sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NOW() WHERE workspace_id=${f.workspace.id} AND resource_channel_id=${a.channel.id} AND principal_group_id=${f.group.id}`).rejects.toThrow('cannot be narrowed');
  await sql`UPDATE flightdeck_pg_channels SET archived_at=NOW() WHERE id=${a.channel.id}`;
  expect((await f.request()).status).toBe(409);
  await sql`DELETE FROM flightdeck_pg_workspaces WHERE id=${f.workspace.id}`;
});

test('present/future members contribute; workspace removal revokes General; General never exposes exact-pair DM',async()=>{
  const f=await fixture(),early=await member(f);const g=await f.request();expect(g.status).toBe(201);
  // Future joins remain correct even if mutable group labels change.
  await sql`UPDATE flightdeck_pg_groups SET name='Renamed Workspace' WHERE id=${f.group.id}`;
  const late=await member(f);
  for(const m of [early,late]) expect(await f.allowed(m.npub,'channel.write',g.body.channel.id)).toBe(true);
  await expect(sql`DELETE FROM flightdeck_pg_group_memberships WHERE workspace_id=${f.workspace.id} AND group_id=${f.group.id} AND actor_id=${late.id}`).rejects.toThrow('General includes');
  const scopes=await sql`SELECT id FROM flightdeck_pg_scopes WHERE workspace_id=${f.workspace.id} AND kind='dm'`;
  const dm=await f.request(`scopes/${scopes[0].id}/channels`,{name:'Agent',kind:'dm',participant_npubs:[f.npub,early.npub]});expect(dm.status).toBe(201);
  const reuse=await f.request(`scopes/${scopes[0].id}/channels`,{name:'Other name',kind:'dm',participant_npubs:[early.npub,f.npub]});expect(reuse.status).toBe(200);expect(reuse.body.channel.id).toBe(dm.body.channel.id);
  expect(await f.allowed(late.npub,'channel.read',dm.body.channel.id)).toBe(false);
  expect(await f.allowed(early.npub,'channel.read',dm.body.channel.id)).toBe(true);
  const preview=await f.request(`members/${early.id}/removal-preview`);expect(preview.status).toBe(200);
  const removal=await f.request(`members/${early.id}/remove`,{confirmation_token:preview.body.preview.confirmation_token,confirm_npub:early.npub});expect(removal.status).toBe(200);
  expect(await f.allowed(early.npub,'channel.read',g.body.channel.id)).toBe(false);
  expect(await f.allowed(early.npub,'channel.read',dm.body.channel.id)).toBe(false);
});

test('requires canonical owner authority, valid empty body and correct workspace; no auth fails',async()=>{
  const f=await fixture(),m=await member(f),other=await fixture();
  expect((await f.request('general/ensure',{},m.secret)).status).toBe(403);
  expect((await f.request('general/ensure',{},f.secret,other.workspace.id)).status).toBe(403);
  for(const body of [{purchase_id:'not-authority'},[],1,null]) expect((await f.request('general/ensure',body)).status).toBe(400);
  expect((await app.request(`/api/v4/flightdeck-pg/workspaces/${f.workspace.id}/general/ensure`,{method:'POST',body:'{}'})).status).toBe(401);
  await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NOW() WHERE workspace_id=${f.workspace.id} AND permission='workspace.manage'`;
  expect((await f.request()).status).toBe(403);
});
