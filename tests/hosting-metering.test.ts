import { assertHostingResponse } from './hosting-response-contract';
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { auditHostingHour } from '../src/services/hosting-billing';
import { storageUsageSnapshot } from '../src/services/workspace-storage-usage';
import { settleWorkspaceSnapshot } from '../src/services/hosting-workspace-billing';
import { config } from '../src/config';
import { setDb, closeDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { hostingMeteringV1Sql } from '../src/schema/hosting-metering-v1';
import { collectMeteredStorage, meteredCoveredBytes, readStoredMetering, runStorageMeteringTick } from '../src/services/hosting-metering';
import { createApp } from '../src/server';
import type { FlightDeckPgWorkspaceStorage } from '../src/types';
const at = new Date('2026-11-01T00:00:00Z');
function evidence(id: string, time = at, bytes: number | null = 10): FlightDeckPgWorkspaceStorage {
  return { format: 'workspace-storage-v1', workspace_id: id, scope: 'current-workspace', as_of: time.toISOString(), activity_range_applies: false,
    groups: [{ id: 'postgres', metrics: [{ id: 'column_bytes', value: bytes, unit: 'bytes', status: bytes === null ? 'unavailable' : 'estimated', method: 'stored-column-size' }] },
      { id: 'object_storage', metrics: [{ id: 'bytes', value: 20, unit: 'bytes', status: 'estimated', method: 'completed-metadata-distinct-paths' }] }],
    caveats: [], provider_measured_at: null, last_object_completed_at: null };
}
test('exact covered subtotal rejects unavailable, foreign and out-of-hour evidence', () => {
  expect(meteredCoveredBytes(evidence('x'), 'x', at)).toBe('30');
  expect(() => meteredCoveredBytes(evidence('x', at, null), 'x', at)).toThrow();
  expect(() => meteredCoveredBytes(evidence('x'), 'y', at)).toThrow();
  expect(() => meteredCoveredBytes(evidence('x'), 'x', new Date(at.getTime() + 3600000))).toThrow();
  expect(meteredCoveredBytes(evidence('x', at, Number.MAX_SAFE_INTEGER), 'x', at)).toBe((BigInt(Number.MAX_SAFE_INTEGER) + 20n).toString());
});
const port = Number(process.env.METERING_TEST_PORT);
describe.skipIf(!port || port === 5432)('stored metering on disposable PostgreSQL', () => {
  const name = `tower_metering_${process.pid}_${Date.now()}`;
  const options = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  let db: ReturnType<typeof postgres>, actor: string, manager: string, agent: string, member: string, account: string;
  const [a,b,c,d] = Array.from({length: 4}, () => randomUUID());
  const keys = [91,92,93,94].map(n => new Uint8Array(32).fill(n));
  const npubs = keys.map(k => nip19.npubEncode(getPublicKey(k)));
  const app = createApp();
  beforeAll(async () => {
    const admin = postgres({...options, database: 'postgres'}); await admin.unsafe(`CREATE DATABASE ${name}`); await admin.end();
    db = postgres({...options, database: name}); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await db.unsafe(hostingMeteringV1Sql); // Runtime migration replay is idempotent.
    const ids=[];
    for (let i=0;i<keys.length;i++) {
      const [row]=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npubs[i]},${i===2?'agent':'human'}) RETURNING id`; ids.push(row!.id);
    }
    [actor,manager,agent,member]=ids;
    for (const id of [a,b,c,d]) {
      await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${id},'tower',${id},${npubs[0]},'metering-fixture','Fixture')`;
      await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${id},${actor},'owner')`;
    }
    for (const id of [manager,agent,member]) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${a},${id},'member')`;
    for (const id of [actor,manager,agent]) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${a},'actor',${id},'workspace','workspace.manage')`;
  });
  afterAll(async () => {
    await closeDb();
    const admin=postgres({...options,database:'postgres'}); await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
  });
  function req(id: string, op: string, key=keys[0]) {
    const url=`http://localhost/api/v4/hosting-billing/workspaces/${id}/${op}`;
    const proof=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:randomUUID(),tags:[['u',url],['method','GET']]},key!);
    return app.request(url,{headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(proof)).toString('base64')}`}});
  }
  test('GET never creates accounts, enrolls or collects; empty is unavailable',async()=>{
    const r=await req(a,'metering'); expect(r.status).toBe(200);
    assertHostingResponse('status',await (await req(a,'status')).json());
    expect(await r.json()).toMatchObject({snapshots:[],freshness:'unavailable',next_measurement_at:null,settlement:{status:'separate_costs_api'}});
    expect((await db`SELECT * FROM hosting_accounts`).length).toBe(0);
    expect((await db`SELECT * FROM hosting_metering_workspaces`).length).toBe(0);
  });
  test('concurrent replicas collect once; immutable evidence and no ledger debit',async()=>{
    await db`INSERT INTO hosting_metering_workspaces(workspace_id,enabled_at) VALUES(${a},${at})`;
    let calls=0;
    const collector=async(id:string)=>{calls++;return evidence(id);};
    await Promise.all(Array.from({length:8},()=>runStorageMeteringTick(db,at,collector)));
    expect(calls).toBe(1);
    const fresh=await readStoredMetering(a,1,db,at); expect(fresh.freshness).toBe('current');
    expect(fresh.next_measurement_at).toBe(new Date(at.getTime()+3600000).toISOString());
    expect((await readStoredMetering(a,1,db,new Date(at.getTime()+3600000))).freshness).toBe('stale');
    const [row]=await db`SELECT * FROM hosting_storage_snapshots WHERE workspace_id=${a}`;
    expect(row!.covered_bytes).toBe('30'); expect(row!.owner_actor_id).toBe(actor); expect(row!.account_id).toBeNull();
    expect((await db`SELECT * FROM hosting_ledger`).length).toBe(0);
    await expect(db`UPDATE hosting_storage_snapshots SET covered_bytes=50 WHERE workspace_id=${a}`).rejects.toThrow('immutable');
    await expect(db`DELETE FROM hosting_storage_snapshots WHERE workspace_id=${a}`).rejects.toThrow('immutable');
  });
  test('restart persists missing/partial/failed periods without current-data backfill',async()=>{
    await db`INSERT INTO hosting_metering_workspaces(workspace_id,enabled_at) VALUES(${b},${new Date(at.getTime()+1000)}),(${c},${at})`;
    const now=new Date(at.getTime()+2*3600000); let calls=0;
    await runStorageMeteringTick(db,now,async()=>{calls++;throw new Error('private provider detail');});
    const rows=await db`SELECT * FROM hosting_storage_snapshots WHERE workspace_id=${b} ORDER BY period_start`;
    expect(rows.map(r=>r.status)).toEqual(['partial_hour','missed','unavailable']);
    expect(rows.every(r=>r.covered_bytes===null&&r.evidence===null)).toBe(true); expect(calls).toBe(3);
    await runStorageMeteringTick(db,now,async(id)=>evidence(id,now));
    expect((await readStoredMetering(b,50,db,now)).freshness).toBe('unavailable');
    expect(JSON.stringify(await readStoredMetering(b,50,db,now))).not.toContain('private provider detail');
  });
  test('accounting tables are excluded from periodic policy, real collector remains stored-column',async()=>{
    await db`INSERT INTO hosting_metering_workspaces(workspace_id,enabled_at) VALUES(${d},${at})`;
    const e=await collectMeteredStorage(d,db);
    const before=meteredCoveredBytes(e,d,new Date(Math.floor(Date.parse(e.as_of)/3600000)*3600000));
    await db`INSERT INTO hosting_storage_snapshots(workspace_id,owner_actor_id,period_start,period_end,measurement_version,status,reason) VALUES(${d},${actor},${at},${new Date(at.getTime()+3600000)},'stored-columns-accounting-excluded-v1','missed',${'x'.repeat(20000)})`;
    const after=await collectMeteredStorage(d,db);
    expect(meteredCoveredBytes(after,d,new Date(Math.floor(Date.parse(after.as_of)/3600000)*3600000))).toBe(before);
    expect(after.caveats.some(c=>c.includes('excludes hosting'))).toBe(true);
  });
  test('workspace manager/agent access, ordinary member and other-workspace denial',async()=>{
    expect((await req(a,'metering',keys[1])).status).toBe(200);
    expect((await req(a,'metering',keys[2])).status).toBe(200);
    expect((await req(a,'metering',keys[3])).status).toBe(403);
    expect((await req(b,'metering',keys[1])).status).toBe(403);
    expect((await app.request(`http://localhost/api/v4/hosting-billing/workspaces/${a}/metering`)).status).toBe(401);
    await db`DELETE FROM flightdeck_pg_permission_grants WHERE workspace_id=${a} AND principal_actor_id=${agent}`;
    expect((await req(a,'metering',keys[2])).status).toBe(403);
  });
  test('managers cannot see shared balances, other workspace usage or after-balances',async()=>{
    const [acc]=await db`INSERT INTO hosting_accounts(owner_actor_id,paid_units) VALUES(${actor},123456) RETURNING id`; account=acc!.id;
    for(const id of [a,b]) await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id,enabled_at) VALUES(${id},${account},${at})`;
    await db`INSERT INTO hosting_ledger(account_id,workspace_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason,actor_npub)
      VALUES(${account},${a},'usage',-10,123446,0,'fixture-a','private reason','private actor'),(${account},${b},'usage',-20,123426,0,'fixture-b','other workspace','private actor')`;
    const v1usage=storageUsageSnapshot(a,at.toISOString(),[{id:'objects',label:'Objects',bytes:3,status:'partial',measurement:'registered_bytes',reason:'fixture'},{id:'database',label:'Database',bytes:0,status:'partial',measurement:'logical_estimate',reason:'fixture'}]);
    await auditHostingHour(a,at,v1usage,db,at);
    // Deliberately hostile nested evidence must never be forwarded to managers.
    await db`UPDATE hosting_usage_hours SET evidence=${db.json({account_id:account,payer:{owner_actor_id:actor},foreign_workspace:b})} WHERE workspace_id=${a}`;
    const assertUsage=async(key:typeof keys[number])=>{
      const statusResponse=await req(a,'status',key);expect(statusResponse.status).toBe(200);
      const status=await statusResponse.json();assertHostingResponse('status',status);expect(()=>assertHostingResponse('status',{...status,account_id:account})).toThrow();expect(status.measurements.length).toBe(1);
      expect(Object.keys(status.measurements[0]).sort()).toEqual(['bytes','debit_units','hour','status','workspace_id']);
      for(const secret of [account,actor,b,'account_id','owner_actor_id','payer','evidence','foreign_workspace'])expect(JSON.stringify(status)).not.toContain(secret);
      const response=await req(a,'usage',key);expect(response.status).toBe(200);
      const payload=await response.json();assertHostingResponse('usage',payload);expect(()=>assertHostingResponse('usage',{...payload,entries:[{...payload.entries[0],evidence:{account_id:account}}]})).toThrow();expect(payload.entries.length).toBe(1);
      expect(Object.keys(payload.entries[0]).sort()).toEqual(['bytes','debit_units','hour','status','workspace_id']);
      for(const secret of [account,actor,b,'account_id','owner_actor_id','payer','evidence'])expect(JSON.stringify(payload)).not.toContain(secret);
    };
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${a},'actor',${agent},'workspace','workspace.manage')`;
    await assertUsage(keys[1]!);await assertUsage(keys[2]!);
    await db`UPDATE flightdeck_pg_workspaces SET workspace_owner_npub=${npubs[1]} WHERE id=${a}`;
    await assertUsage(keys[0]!);
    await db`UPDATE flightdeck_pg_workspaces SET workspace_owner_npub=${npubs[0]} WHERE id=${a}`;
    const owner=await (await req(a,'status')).json(); assertHostingResponse('status',owner); assertHostingResponse('usage',await (await req(a,'usage')).json()); expect(owner.balance_units).toBeDefined();
    const status=await (await req(a,'status',keys[1])).json();
    expect(status.financial_scope).toBe('workspace'); expect(status.balance_units).toBeUndefined(); expect(status.account_id).toBeUndefined();
    expect(status.hourly_burn_usd).toBeUndefined(); expect(status.promo_expires_at).toBeUndefined();
    const metering=await (await req(a,'metering',keys[1])).json();
    expect(JSON.stringify(metering)).not.toContain(account); expect(JSON.stringify(metering)).not.toContain(actor);
    expect(metering.snapshots.every((s:any)=>s.account_id===undefined&&s.owner_actor_id===undefined)).toBe(true);
    const ledger=await (await req(a,'ledger',keys[1])).json();
    expect(ledger.entries.length).toBe(2); expect(Object.keys(ledger.entries[0]).sort()).toEqual(['amount_units','created_at','id','kind','workspace_id']);
    expect(JSON.stringify(ledger)).not.toContain('123446'); expect(JSON.stringify(ledger)).not.toContain(b);
    expect((await (await req(a,'ledger')).json()).entries.length).toBe(3);
  });
  test('persisted GET works while measured source table is exclusively locked',async()=>{
    const locked=db.begin(async tx=>{
      const sql=tx as unknown as typeof db;
      await sql`LOCK TABLE v4_storage_objects IN ACCESS EXCLUSIVE MODE`;
      const result=await Promise.race([req(a,'metering'),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('GET scanned storage')),1000))]);
      expect(result.status).toBe(200);
    });
    await locked;
  });
  test('bounded schedules make progress beyond 64 workspaces and reject foreign account attribution',async()=>{
    const now=new Date(at.getTime()+3*3600000), ids=Array.from({length:66},()=>randomUUID());
    for(const id of ids){
      await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${id},'tower',${id},${npubs[0]},'metering-fixture','Bounded')`;
      await db`INSERT INTO hosting_metering_workspaces(workspace_id,enabled_at) VALUES(${id},${now})`;
    }
    const [foreign]=await db`INSERT INTO hosting_accounts(owner_actor_id) VALUES(${manager}) RETURNING id`;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${ids[0]},${foreign!.id})`;
    const seen=new Map<string,number>();
    const collect=async(id:string)=>{seen.set(id,(seen.get(id)||0)+1);return evidence(id,now);};
    for(let i=0;i<3;i++)await runStorageMeteringTick(db,now,collect);
    expect(ids.every(id=>seen.get(id)===1)).toBe(true);
    const [row]=await db`SELECT account_id FROM hosting_storage_snapshots WHERE workspace_id=${ids[0]}`;
    expect(row!.account_id).toBeNull();
    const [own]=await db`SELECT account_id FROM hosting_storage_snapshots WHERE workspace_id=${a} AND period_start=${now}`;
    expect(own!.account_id).toBe(account);
  });
  test('restart catchup is bounded to 24 immutable unbilled hours per tick',async()=>{
    const id=randomUUID(), now=new Date(at.getTime()+3*3600000), enabled=new Date(now.getTime()-48*3600000);
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${id},'tower',${id},${npubs[0]},'metering-fixture','Catchup')`;
    await db`INSERT INTO hosting_metering_workspaces(workspace_id,enabled_at) VALUES(${id},${enabled})`;
    let calls=0; const collect=async(workspace:string)=>{calls++;return evidence(workspace,now);};
    await runStorageMeteringTick(db,now,collect);
    expect((await readStoredMetering(id,200,db,now)).snapshots.length).toBe(24); expect(calls).toBe(0);
    await runStorageMeteringTick(db,now,collect);
    expect((await readStoredMetering(id,200,db,now)).snapshots.length).toBe(48); expect(calls).toBe(0);
    await runStorageMeteringTick(db,now,collect);
    expect((await readStoredMetering(id,200,db,now)).snapshots.length).toBe(49); expect(calls).toBe(1);
  });

  test('v2 APIs enforce signed mutations, owner funding and platform-only rate changes',async()=>{
    const priorFlag=process.env.HOSTING_WORKSPACE_BILLING_ENABLED,priorAdmin=config.adminNpub;
    process.env.HOSTING_WORKSPACE_BILLING_ENABLED='true';
    async function mutate(op:string,body:any,key=keys[0],signPayload=true){
      const url=`http://localhost/api/v4/hosting-billing/workspaces/${a}/${op}`,raw=JSON.stringify(body);
      const tags=[['u',url],['method','POST'],...(signPayload?[['payload',createHash('sha256').update(raw).digest('hex')]]:[])];
      const proof=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:randomUUID(),tags},key!);
      return app.request(url,{method:'POST',body:raw,headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(proof)).toString('base64')}`}});
    }
    try{
      expect((await mutate('enroll',{confirm_v1_transition:true},keys[0],false)).status).toBe(401);
      expect((await mutate('enroll',{confirm_v1_transition:true},keys[1])).status).toBe(403);
      expect((await mutate('enroll',{confirm_v1_transition:true})).status).toBe(200);
      expect((await mutate('allocate',{amount_units:'1000',idempotency_key:'api-fund-fixture'},keys[1])).status).toBe(403);
      expect((await mutate('allocate',{amount_units:'1000',idempotency_key:'api-fund-fixture'})).status).toBe(200);
      const input={version:'api-rate-fixture',effective_at:new Date((Math.floor(Date.now()/3600000)+1)*3600000).toISOString(),numerator:'1',denominator:'1'};
      expect((await mutate('rate',input,keys[1])).status).toBe(403);
      config.adminNpub=npubs[0]!;expect((await mutate('rate',input)).status).toBe(201);
      const managerCosts=await (await req(a,'costs',keys[1])).json(),ownerCosts=await (await req(a,'costs')).json();
      expect(managerCosts.wallet).toBeNull();expect(ownerCosts.wallet.balance_units).toBe('1000');
      expect(JSON.stringify(managerCosts)).not.toContain(account);expect(JSON.stringify(managerCosts)).not.toContain(actor);
      const future=new Date((Math.floor((Date.now()+40*86400000)/3600000))*3600000);
      const [sample]=await db`INSERT INTO hosting_storage_snapshots(workspace_id,owner_actor_id,account_id,period_start,period_end,captured_at,measurement_version,status,covered_bytes,evidence) VALUES(${a},${actor},${account},${future},${new Date(future.getTime()+3600000)},${future},'stored-columns-accounting-excluded-v1','measured',1,'{}') RETURNING id`;
      await settleWorkspaceSnapshot(sample!.id,db,future);
      expect((await db`SELECT * FROM hosting_ledger WHERE workspace_id=${a} AND balance_scope='workspace' AND kind='promo_expiry'`).length).toBe(1);
      for(const key of [keys[1],keys[2]]){
        const ledger=await (await req(a,'ledger',key)).json();
        assertHostingResponse('ledger',ledger);
        // Schemas must reject private fields even when the row kind is valid.
        expect(()=>assertHostingResponse('ledger',{...ledger,entries:[{...ledger.entries[0],account_id:account}]})).toThrow();
        expect(ledger.entries.some((e:any)=>e.kind==='workspace_usage')).toBe(true);
        expect(ledger.entries.every((e:any)=>['usage','workspace_usage'].includes(e.kind))).toBe(true);
        for(const secret of ['workspace_allocation','promo_expiry','paid_after_units','promo_after_units','account_id',account])expect(JSON.stringify(ledger)).not.toContain(secret);
      }
      const ownerLedger=await (await req(a,'ledger')).json();
      expect(ownerLedger.entries.some((e:any)=>e.kind==='workspace_allocation')).toBe(true);
      assertHostingResponse('ledger',ownerLedger);
      for (const kind of ['welcome','usage','admin','stripe','promo_expiry','workspace_allocation','workspace_usage'])
        assertHostingResponse('ledger',{...ownerLedger,entries:[{...ownerLedger.entries[0],kind}]});
      expect(()=>assertHostingResponse('ledger',{...ownerLedger,entries:[{...ownerLedger.entries[0],kind:'unknown'}]})).toThrow();
      config.adminNpub=priorAdmin;
      await db`UPDATE flightdeck_pg_workspaces SET workspace_owner_npub=${npubs[1]} WHERE id=${a}`;
      const formerOwner=await (await req(a,'status')).json();expect(formerOwner.balance_units).toBeUndefined();
      expect((await (await req(a,'costs')).json()).wallet).toBeNull();
      await db`UPDATE flightdeck_pg_workspaces SET workspace_owner_npub=${npubs[0]} WHERE id=${a}`;
    }finally{
      config.adminNpub=priorAdmin;if(priorFlag===undefined)delete process.env.HOSTING_WORKSPACE_BILLING_ENABLED;else process.env.HOSTING_WORKSPACE_BILLING_ENABLED=priorFlag;
    }
  });

});
