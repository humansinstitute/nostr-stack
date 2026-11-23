import { beforeAll,afterAll,describe,test,expect,setSystemTime } from 'bun:test';
import postgres from 'postgres';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auditHostingHour as preChangeAudit } from './fixtures/hosting-billing-pre-cutover';
import { config } from '../src/config';
import { setDb,closeDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { hostingMeteringV1Sql } from '../src/schema/hosting-metering-v1';
import { hostingWorkspaceBillingV2Sql } from '../src/schema/hosting-workspace-billing-v2';
import { configureStorageRate,enrollWorkspaceBilling,allocateWorkspaceCredit,settleWorkspaceSnapshot,exactStorageCharge,readWorkspaceCosts,runWorkspaceBillingTick } from '../src/services/hosting-workspace-billing';
import { auditHostingHour,runHostingBillingTick,hostingWriteBlock } from '../src/services/hosting-billing';
import { storageUsageSnapshot } from '../src/services/workspace-storage-usage';
const H=3600000,base=new Date('2026-11-01T00:00:00Z'),period=new Date(base.getTime()+H);
test('rational integer carry is exact, bounded and independent of floating point',()=>{
  let remainder='0',total=0n;
  for(let i=0;i<3;i++){const q=exactStorageCharge('1','1','3',remainder);total+=BigInt(q.debit);remainder=q.remainder;}
  expect(total).toBe(1n);expect(remainder).toBe('0');
  expect(()=>exactStorageCharge('1','1','0')).toThrow();expect(()=>exactStorageCharge('1','1','3','3')).toThrow();
});
const port=Number(process.env.METERING_TEST_PORT);
describe.skipIf(!port||port===5432)('workspace allocated billing on disposable PostgreSQL',()=>{
  const name=`tower_workspace_billing_${process.pid}_${Date.now()}`;
  const options={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
  const [a,b,c]=[randomUUID(),randomUUID(),randomUUID()];
  let db:ReturnType<typeof postgres>,actor:string,other:string,account:string;
  const originalFlag=process.env.HOSTING_WORKSPACE_BILLING_ENABLED,originalAdmin=config.adminNpub,originalMode=config.billing.mode;
  beforeAll(async()=>{
    const admin=postgres({...options,database:'postgres'});await admin.unsafe(`CREATE DATABASE ${name}`);await admin.end();
    db=postgres({...options,database:name});setDb(db);
    // Start with the exact pre-change bootstrap, then apply additive runtime migrations.
    const baseline=readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8').split('\n-- hosting_metering_v1')[0]!.trimEnd()+'\n';
    expect(createHash('sha256').update(baseline).digest('hex')).toBe('ee7342dd396fe997ad21c0cf185c3f0f73eb8bdf84813770805d46b253940d4e');
    for(const q of splitSqlStatements(baseline))await db.unsafe(q);
    await db.unsafe(hostingMeteringV1Sql);
    await db.unsafe(hostingWorkspaceBillingV2Sql);
    await db.unsafe(hostingWorkspaceBillingV2Sql); // Idempotent runtime replay.

    const [owner]=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('owner-fixture','human') RETURNING id`;actor=owner!.id;
    const [o]=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('other-fixture','human') RETURNING id`;other=o!.id;
    for(const id of [a,b,c])await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${id},'tower',${id},'owner-fixture','app','Fixture')`;
    const [acc]=await db`INSERT INTO hosting_accounts(owner_actor_id,paid_units,promo_units,promo_expires_at) VALUES(${actor},100000,1000,'2026-11-02') RETURNING id`;account=acc!.id;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id,enabled_at) VALUES(${a},${account},${base})`;
    config.adminNpub='platform-admin-fixture';config.billing.mode='disabled';
  });
  afterAll(async()=>{
    if(originalFlag===undefined)delete process.env.HOSTING_WORKSPACE_BILLING_ENABLED;else process.env.HOSTING_WORKSPACE_BILLING_ENABLED=originalFlag;
    config.adminNpub=originalAdmin;config.billing.mode=originalMode;await closeDb();
    const admin=postgres({...options,database:'postgres'});await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();
  });
  async function snapshot(workspaceId:string,time:Date,bytes:string|null='1',status='measured'){
    const [r]=await db`INSERT INTO hosting_storage_snapshots(workspace_id,owner_actor_id,account_id,period_start,period_end,captured_at,measurement_version,status,covered_bytes,evidence)
      VALUES(${workspaceId},${actor},${account},${time},${new Date(time.getTime()+H)},${status==='measured'?time:null},'stored-columns-accounting-excluded-v1',${status},${bytes},${status==='measured'?db.json({fixture:true}):null}) RETURNING id`;return r!.id;
  }
  test('disabled default prevents monetary mutations and ticks',async()=>{
    delete process.env.HOSTING_WORKSPACE_BILLING_ENABLED;
    await expect(enrollWorkspaceBilling(a,actor,true,db,base)).rejects.toThrow('rollout_disabled');
    await runWorkspaceBillingTick(db,base);expect((await db`SELECT * FROM hosting_workspace_wallets`).length).toBe(0);
    process.env.HOSTING_WORKSPACE_BILLING_ENABLED='true';
  });
  test('only platform admin may append future rate versions; replay cannot reprice history',async()=>{
    const input={version:'rate-one-third',effective_at:period.toISOString(),numerator:'1',denominator:'3'};
    await expect(configureStorageRate(input,'workspace-manager',db,base)).rejects.toThrow('platform_admin_required');
    await expect(configureStorageRate({...input,effective_at:base.toISOString()},config.adminNpub,db,base)).rejects.toThrow('future_hour');
    const r=await configureStorageRate(input,config.adminNpub,db,base);
    expect((await configureStorageRate(input,config.adminNpub,db,new Date(base.getTime()+10*H)))!.id).toBe(r!.id);
    await expect(configureStorageRate({...input,numerator:'2'},config.adminNpub,db,base)).rejects.toThrow('idempotency_conflict');
    await expect(db`UPDATE hosting_storage_rates SET numerator=2 WHERE id=${r!.id}`).rejects.toThrow('immutable');
  });
  test('explicit next-hour v1 transition preserves links and history, creates no grant',async()=>{
    await expect(enrollWorkspaceBilling(a,other,true,db,base)).rejects.toThrow('workspace_owner_required');
    await expect(enrollWorkspaceBilling(a,actor,false,db,base)).rejects.toThrow('explicit_v1_transition_required');
    const results=await Promise.all(Array.from({length:4},()=>enrollWorkspaceBilling(a,actor,true,db,base)));
    expect(results.every(r=>new Date(r.enabled_at).getTime()===period.getTime())).toBe(true);
    await enrollWorkspaceBilling(b,actor,false,db,base);
    expect((await db`SELECT * FROM hosting_accounts`).length).toBe(1);
    expect((await db`SELECT * FROM hosting_ledger`).length).toBe(0);
    expect((await db`SELECT * FROM hosting_workspace_accounts WHERE workspace_id=${a}`)[0]!.account_id).toBe(account);
    const rollback=randomUUID();await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${rollback},'tower',${rollback},'owner-fixture','app','Rollback')`;
    await db.unsafe(`CREATE FUNCTION fail_schedule_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'enrollment rollback fixture'; END; $$; CREATE TRIGGER fail_schedule_fixture BEFORE INSERT ON hosting_metering_workspaces FOR EACH ROW EXECUTE FUNCTION fail_schedule_fixture()`);
    await expect(enrollWorkspaceBilling(rollback,actor,false,db,base)).rejects.toThrow('enrollment rollback fixture');
    await db.unsafe('DROP TRIGGER fail_schedule_fixture ON hosting_metering_workspaces');
    expect((await db`SELECT * FROM hosting_workspace_wallets WHERE workspace_id=${rollback}`).length).toBe(0);
    expect((await db`SELECT * FROM hosting_workspace_accounts WHERE workspace_id=${rollback}`).length).toBe(0);
  });
  test('explicit owner funding is retry-safe, conserves balances and preserves promo expiry',async()=>{
    const results=await Promise.all(Array.from({length:8},()=>allocateWorkspaceCredit(a,actor,'1200','fund-a-fixture',db,base)));
    expect(results.every(r=>r.allocated_units==='1200')).toBe(true);
    await allocateWorkspaceCredit(b,actor,'100','fund-b-fixture',db,base);
    const [acc]=await db`SELECT * FROM hosting_accounts WHERE id=${account}`;
    const rows=await db`SELECT * FROM hosting_workspace_wallets ORDER BY workspace_id`;
    expect(BigInt(acc!.paid_units)+BigInt(acc!.promo_units)+rows.reduce((s,r)=>s+BigInt(r.paid_units)+BigInt(r.promo_units),0n)).toBe(101000n);
    const wallet=rows.find(r=>r.workspace_id===a)!;expect(wallet.promo_units).toBe('1000');expect(wallet.paid_units).toBe('200');expect(new Date(wallet.promo_expires_at).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect((await db`SELECT * FROM hosting_ledger WHERE kind='workspace_allocation'`).length).toBe(4);
    await expect(db`UPDATE hosting_ledger SET amount_units=0 WHERE kind='workspace_allocation'`).rejects.toThrow('immutable');
    await expect(allocateWorkspaceCredit(a,actor,'1201','fund-a-fixture',db,base)).rejects.toThrow('idempotency_conflict');
    await expect(allocateWorkspaceCredit(a,other,'1','fund-foreign-fixture',db,base)).rejects.toThrow('workspace_owner_required');
    await expect(allocateWorkspaceCredit(a,actor,'999999','fund-huge-fixture',db,base)).rejects.toThrow('insufficient_owner_credit');
  });
  test('concurrent patched-v1/new charging paths produce one immutable snapshot/rate/period debit',async()=>{
    const id=await snapshot(a,period,'3');
    const usage=storageUsageSnapshot(a,period.toISOString(),[{id:'objects',label:'Objects',bytes:3,status:'partial',measurement:'registered_bytes',reason:'fixture'},{id:'database',label:'Database',bytes:0,status:'partial',measurement:'logical_estimate',reason:'fixture'}]);
    const results=await Promise.all([auditHostingHour(a,period,usage,db,period),...Array.from({length:8},()=>settleWorkspaceSnapshot(id,db,period)),runHostingBillingTick(db,period,async(w)=>storageUsageSnapshot(w,period.toISOString(),usage.categories))]);
    expect(results[0]).toBeNull();
    expect((await db`SELECT * FROM hosting_usage_hours WHERE workspace_id=${a} AND hour=${period}`).length).toBe(0);
    const rows=await db`SELECT * FROM hosting_ledger WHERE snapshot_id=${id}`;
    expect(rows.length).toBe(1);expect(rows[0]!.amount_units).toBe('-1');expect(rows[0]!.duration_seconds).toBe(3600);expect(rows[0]!.rate_id).toBeTruthy();expect(rows[0]!.balance_scope).toBe('workspace');
    const [settlement]=await db`SELECT * FROM hosting_workspace_settlements WHERE snapshot_id=${id}`;
    await expect(db`UPDATE hosting_workspace_settlements SET debit_units=999 WHERE snapshot_id=${id}`).rejects.toThrow('immutable');
    expect(settlement!.debit_units).toBe('1');
  });
  // Release only after PostgreSQL confirms the operation is blocked on our lock.
  async function acrossLock<T>(lock:(sql:typeof db)=>Promise<unknown>,operation:()=>Promise<T>,advance:()=>void|Promise<void>) {
    let release!:()=>void, ready!:()=>void;
    const gate=new Promise<void>(r=>release=r), acquired=new Promise<void>(r=>ready=r);
    let pid=0;
    const blocker=db.begin(async tx=>{const sql=tx as unknown as typeof db;await lock(sql);pid=(await sql`SELECT pg_backend_pid() AS pid`)[0]!.pid;ready();await gate;});
    await acquired;const pending=operation();
    // Attach immediately so expected rejection is never unhandled.
    const result=pending.then(value=>({value,error:null}),error=>({value:null,error}));
    try {
      let waiting=false;
      for(let i=0;i<200;i++){
        const rows=await db`SELECT 1 FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))`;
        if(rows.length){waiting=true;break;}await Bun.sleep(5);
      }
      expect(waiting).toBe(true);await advance();
    }finally{release();await blocker;}
    return result;
  }
  test('pre-change HEAD transaction waits behind enrollment and is rejected with full account rollback',async()=>{
    const workspace=randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${workspace},'tower',${workspace},'owner-fixture','app','Mixed binary')`;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id,enabled_at) VALUES(${workspace},${account},${base})`;
    const [preEnrollment]=await db`SELECT * FROM hosting_accounts WHERE id=${account}`;
    const preLedger=await db`SELECT id FROM hosting_ledger WHERE account_id=${account} ORDER BY id`;
    // Pause the real enrollment after it owns the account lock but before its
    // wallet insertion commits. Start the unchanged old transaction while paused.
    await db.unsafe(`CREATE FUNCTION pause_enrollment_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1440000799); RETURN NEW; END; $$; CREATE TRIGGER pause_enrollment_fixture BEFORE INSERT ON hosting_workspace_wallets FOR EACH ROW EXECUTE FUNCTION pause_enrollment_fixture()`);
    let oldResult:Promise<any>|undefined;
    const race=await acrossLock(async sql=>{await sql`SELECT pg_advisory_xact_lock(1440000799)`;},()=>enrollWorkspaceBilling(workspace,actor,true,db,base),async()=>{
      const usage=storageUsageSnapshot(workspace,period.toISOString(),[{id:'objects',label:'Objects',bytes:3,status:'partial',measurement:'registered_bytes',reason:'fixture'},{id:'database',label:'Database',bytes:0,status:'partial',measurement:'logical_estimate',reason:'fixture'}]);
      oldResult=preChangeAudit(workspace,period,usage,db,period).then(value=>({value,error:null}),error=>({value:null,error}));
      let oldWaiting=false;
      for(let i=0;i<200;i++){
        const rows=await db`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM hosting_accounts%'`;
        if(rows.length){oldWaiting=true;break;}await Bun.sleep(5);
      }
      expect(oldWaiting).toBe(true);
    });
    expect(race.error).toBeNull();expect((await oldResult)!.error?.message).toContain('hosting_v1_workspace_cutover');
    expect((await db`SELECT * FROM hosting_accounts WHERE id=${account}`)[0]).toEqual(preEnrollment);
    expect((await db`SELECT id FROM hosting_ledger WHERE account_id=${account} ORDER BY id`).map(r=>r.id)).toEqual(preLedger.map(r=>r.id));
    await db.unsafe('DROP TRIGGER pause_enrollment_fixture ON hosting_workspace_wallets');
    await allocateWorkspaceCredit(workspace,actor,'100','mixed-binary-fund',db,base);
    const id=await snapshot(workspace,period,'3');
    const usage=storageUsageSnapshot(workspace,period.toISOString(),[{id:'objects',label:'Objects',bytes:3,status:'partial',measurement:'registered_bytes',reason:'fixture'},{id:'database',label:'Database',bytes:0,status:'partial',measurement:'logical_estimate',reason:'fixture'}]);
    const [before]=await db`SELECT * FROM hosting_accounts WHERE id=${account}`;
    const ledgerBefore=await db`SELECT id FROM hosting_ledger WHERE account_id=${account} AND balance_scope='account'`;
    const result=await acrossLock(async sql=>{await sql`SELECT id FROM hosting_accounts WHERE id=${account} FOR UPDATE`;},()=>Promise.allSettled([preChangeAudit(workspace,period,usage,db,period),...Array.from({length:4},()=>settleWorkspaceSnapshot(id,db,period))]),()=>{});
    expect(result.error).toBeNull();
    const outcomes=result.value as PromiseSettledResult<any>[];
    expect(outcomes[0]!.status).toBe('rejected');
    expect((outcomes[0] as PromiseRejectedResult).reason.message).toContain('hosting_v1_workspace_cutover');
    expect(outcomes.slice(1).every(r=>r.status==='fulfilled')).toBe(true);
    const [after]=await db`SELECT * FROM hosting_accounts WHERE id=${account}`;
    expect(after).toEqual(before);
    expect((await db`SELECT id FROM hosting_ledger WHERE account_id=${account} AND balance_scope='account' ORDER BY id`).map(r=>r.id)).toEqual(ledgerBefore.map(r=>r.id).sort());
    expect((await db`SELECT * FROM hosting_usage_hours WHERE workspace_id=${workspace}`).length).toBe(0);
    expect((await db`SELECT * FROM hosting_ledger WHERE workspace_id=${workspace} AND kind IN ('usage','workspace_usage')`).length).toBe(1);
    const [wallet]=await db`SELECT paid_units,promo_units FROM hosting_workspace_wallets WHERE workspace_id=${workspace}`;
    expect(BigInt(wallet!.paid_units)+BigInt(wallet!.promo_units)).toBe(99n);
    // The same frozen binary retains historical behavior before cutover.
    expect((await preChangeAudit(workspace,base,storageUsageSnapshot(workspace,base.toISOString(),usage.categories),db,base))!.status).toBe('charged');
  });
  test('enrollment and rate effectivity use the post-lock UTC hour',async()=>{
    const workspace=randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${workspace},'tower',${workspace},'owner-fixture','app','Hour boundary')`;
    let current=new Date('2026-12-01T00:59:59.999Z');
    const enrollment=await acrossLock(async sql=>{await sql`SELECT id FROM hosting_accounts WHERE id=${account} FOR UPDATE`;},()=>enrollWorkspaceBilling(workspace,actor,false,db,()=>current),()=>{current=new Date('2026-12-01T01:00:00Z');});
    expect(enrollment.error).toBeNull();expect(new Date((enrollment.value as any).enabled_at).toISOString()).toBe('2026-12-01T02:00:00.000Z');
    current=new Date('2026-12-01T00:59:59.999Z');
    const rate=await acrossLock(async sql=>{await sql`SELECT pg_advisory_xact_lock(1440000722)`;},()=>configureStorageRate({version:'cross-hour-rejected',effective_at:'2026-12-01T01:00:00Z',numerator:'1',denominator:'1'},config.adminNpub,db,()=>current),()=>{current=new Date('2026-12-01T01:00:00Z');});
    expect(rate.error?.message).toContain('rate_must_be_future_hour');
    expect((await db`SELECT * FROM hosting_storage_rates WHERE version='cross-hour-rejected'`).length).toBe(0);
  });

  async function clockFixture() {
    const workspace=randomUUID(),npub=randomUUID();
    const [payer]=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING id`;
    const [acc]=await db`INSERT INTO hosting_accounts(owner_actor_id,paid_units,promo_units) VALUES(${payer!.id},100,100) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${workspace},'tower',${workspace},${npub},'app','Clock fixture')`;
    await enrollWorkspaceBilling(workspace,payer!.id,false,db,base);
    await db`UPDATE hosting_workspace_wallets SET paid_units=100,promo_units=100,promo_expires_at='2099-01-01' WHERE workspace_id=${workspace}`;
    return {workspace,payer:payer!.id,account:acc!.id};
  }
  async function clockSnapshot(f:Awaited<ReturnType<typeof clockFixture>>,time:Date) {
    const [row]=await db`INSERT INTO hosting_storage_snapshots(workspace_id,owner_actor_id,account_id,period_start,period_end,captured_at,measurement_version,status,covered_bytes,evidence)
      VALUES(${f.workspace},${f.payer},${f.account},${time},${new Date(time.getTime()+H)},${time},'stored-columns-accounting-excluded-v1','measured','6',${db.json({fixture:true})}) RETURNING id`;
    return row!.id;
  }
  test('default production settlement clock expires promo after confirmed wallet lock wait',async()=>{
    const f=await clockFixture(),time=new Date(Math.floor(Date.now()/H)*H),id=await clockSnapshot(f,time);
    const expires=new Date(Date.now()+500);
    await db`UPDATE hosting_workspace_wallets SET promo_expires_at=${expires} WHERE workspace_id=${f.workspace}`;
    const [accountBefore]=await db`SELECT * FROM hosting_accounts WHERE id=${f.account}`;
    const result=await acrossLock(async sql=>{await sql`SELECT workspace_id FROM hosting_workspace_wallets WHERE workspace_id=${f.workspace} FOR UPDATE`;},()=>settleWorkspaceSnapshot(id,db),async()=>{await Bun.sleep(Math.max(0,expires.getTime()-Date.now())+50);});
    expect(result.error).toBeNull();expect(result.value!.debit_units).toBe('2');
    const [wallet]=await db`SELECT paid_units,promo_units FROM hosting_workspace_wallets WHERE workspace_id=${f.workspace}`;
    expect(wallet).toEqual({paid_units:'98',promo_units:'0'});
    const entries=await db`SELECT kind,amount_units,paid_after_units,promo_after_units FROM hosting_ledger WHERE workspace_id=${f.workspace} ORDER BY created_at,id`;
    expect(entries.find(e=>e.kind==='promo_expiry')!.amount_units).toBe('-100');
    expect(entries.find(e=>e.kind==='workspace_usage')).toMatchObject({amount_units:'-2',paid_after_units:'98',promo_after_units:'0'});
    expect(200n+entries.reduce((n,e)=>n+BigInt(e.amount_units),0n)).toBe(98n);
    await settleWorkspaceSnapshot(id,db);
    expect((await db`SELECT id FROM hosting_ledger WHERE workspace_id=${f.workspace}`).length).toBe(2);
    expect((await db`SELECT * FROM hosting_accounts WHERE id=${f.account}`)[0]).toEqual(accountBefore);
  });
  for(const lockTarget of ['account','wallet'] as const) test('default allocation clock expires account and wallet promo after '+lockTarget+' lock wait',async()=>{
    const f=await clockFixture(),expires=new Date(Date.now()+500);
    await db`UPDATE hosting_accounts SET promo_expires_at=${expires} WHERE id=${f.account}`;
    await db`UPDATE hosting_workspace_wallets SET promo_expires_at=${expires} WHERE workspace_id=${f.workspace}`;
    const result=await acrossLock(async sql=>{
      if(lockTarget==='account')await sql`SELECT id FROM hosting_accounts WHERE id=${f.account} FOR UPDATE`;
      else await sql`SELECT workspace_id FROM hosting_workspace_wallets WHERE workspace_id=${f.workspace} FOR UPDATE`;
    },()=>allocateWorkspaceCredit(f.workspace,f.payer,'2','clock-fund-fixture',db),async()=>{await Bun.sleep(Math.max(0,expires.getTime()-Date.now())+50);});
    expect(result.error).toBeNull();
    const [acc]=await db`SELECT paid_units,promo_units FROM hosting_accounts WHERE id=${f.account}`;
    const [wallet]=await db`SELECT paid_units,promo_units FROM hosting_workspace_wallets WHERE workspace_id=${f.workspace}`;
    expect(acc).toEqual({paid_units:'98',promo_units:'0'});expect(wallet).toEqual({paid_units:'102',promo_units:'0'});
    const entries=await db`SELECT balance_scope,kind,amount_units,metadata FROM hosting_ledger WHERE account_id=${f.account}`;
    expect(entries.filter(e=>e.kind==='promo_expiry').map(e=>e.amount_units)).toEqual(['-100','-100']);
    expect(entries.filter(e=>e.kind==='workspace_allocation').map(e=>e.amount_units).sort()).toEqual(['-2','2']);
    expect(entries.filter(e=>e.kind==='workspace_allocation').every(e=>e.metadata.paid_units==='2'&&e.metadata.promo_units==='0')).toBe(true);
    expect(400n+entries.reduce((n,e)=>n+BigInt(e.amount_units),0n)).toBe(BigInt(acc!.paid_units)+BigInt(wallet!.paid_units));
    await allocateWorkspaceCredit(f.workspace,f.payer,'2','clock-fund-fixture',db);
    expect((await db`SELECT id FROM hosting_ledger WHERE account_id=${f.account}`).length).toBe(4);
  });
  for(const runner of [false,true]) test((runner?'runner':'settlement')+' uses post-lock decision hour; late periods preserve wallet, ledger and carry',async()=>{
      const f=await clockFixture(),time=new Date('2026-11-01T01:00:00Z'),id=await clockSnapshot(f,time);
      setSystemTime(new Date('2026-11-01T01:59:59.999Z'));
      const [before]=await db`SELECT * FROM hosting_workspace_wallets WHERE workspace_id=${f.workspace}`;
      let result;
      try {result=await acrossLock(async sql=>{await sql`SELECT workspace_id FROM hosting_workspace_wallets WHERE workspace_id=${f.workspace} FOR UPDATE`;},
        async()=>{if(runner)await runWorkspaceBillingTick(db);else await settleWorkspaceSnapshot(id,db);},
        ()=>{setSystemTime(new Date('2026-11-01T02:00:00Z'));});
      }finally{setSystemTime();}
      expect(result.error).toBeNull();
      expect((await db`SELECT status,debit_units FROM hosting_workspace_settlements WHERE snapshot_id=${id}`)[0]).toEqual({status:'missed',debit_units:null});
      expect((await db`SELECT * FROM hosting_workspace_wallets WHERE workspace_id=${f.workspace}`)[0]).toEqual(before);
      expect((await db`SELECT id FROM hosting_ledger WHERE workspace_id=${f.workspace}`).length).toBe(0);
      expect((await db`SELECT * FROM hosting_workspace_rate_carry WHERE workspace_id=${f.workspace}`).length).toBe(0);
  });

  test('adjacent legacy settlement uses fresh expiry and current-hour decisions after account lock',async()=>{
    for(const crossing of ['expiry','hour']){
      const f=await clockFixture(),workspace=randomUUID();
      const [payer]=await db`SELECT npub FROM flightdeck_pg_actors WHERE id=${f.payer}`;
      await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${workspace},'tower',${workspace},${payer!.npub},'app','Legacy clock')`;
      await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id,enabled_at) VALUES(${workspace},${f.account},${base})`;
      const expires=new Date(Date.now()+500);
      await db`UPDATE hosting_accounts SET promo_expires_at=${expires} WHERE id=${f.account}`;
      if(crossing==='hour')setSystemTime(new Date('2026-11-01T01:59:59.999Z'));
      const time=new Date(Math.floor(Date.now()/H)*H);
      const usage=storageUsageSnapshot(workspace,time.toISOString(),[{id:'objects',label:'Objects',bytes:2,status:'partial',measurement:'registered_bytes',reason:'fixture'},{id:'database',label:'Database',bytes:0,status:'partial',measurement:'logical_estimate',reason:'fixture'}]);
      let result;
      try {result=await acrossLock(async sql=>{await sql`SELECT id FROM hosting_accounts WHERE id=${f.account} FOR UPDATE`;},
        ()=>auditHostingHour(workspace,time,usage,db),
        async()=>{if(crossing==='hour')setSystemTime(new Date('2026-11-01T02:00:00Z'));else await Bun.sleep(Math.max(0,expires.getTime()-Date.now())+50);});
      }finally{setSystemTime();}
      expect(result.error).toBeNull();
      const [acc]=await db`SELECT paid_units,promo_units FROM hosting_accounts WHERE id=${f.account}`;
      expect(result.value!.status).toBe(crossing==='expiry'?'charged':'missed');
      expect(acc).toEqual(crossing==='expiry'?{paid_units:'98',promo_units:'0'}:{paid_units:'100',promo_units:'100'});
      const entries=await db`SELECT kind,amount_units FROM hosting_ledger WHERE account_id=${f.account}`;
      expect(entries.length).toBe(crossing==='expiry'?2:0);
      expect(200n+entries.reduce((n,e)=>n+BigInt(e.amount_units),0n)).toBe(BigInt(acc!.paid_units)+BigInt(acc!.promo_units));
    }
  });
  test('transaction failure rolls back wallet, ledger, carry and settlement together',async()=>{
    const time=new Date(period.getTime()+H),id=await snapshot(a,time,'7');
    const [before]=await db`SELECT * FROM hosting_workspace_wallets WHERE workspace_id=${a}`;
    await db.unsafe(`CREATE FUNCTION fail_settlement_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END; $$; CREATE TRIGGER fail_settlement_fixture BEFORE INSERT ON hosting_workspace_settlements FOR EACH ROW EXECUTE FUNCTION fail_settlement_fixture()`);
    await expect(settleWorkspaceSnapshot(id,db,time)).rejects.toThrow('fixture failure');
    await db.unsafe('DROP TRIGGER fail_settlement_fixture ON hosting_workspace_settlements');
    expect((await db`SELECT * FROM hosting_ledger WHERE snapshot_id=${id}`).length).toBe(0);
    const [after]=await db`SELECT * FROM hosting_workspace_wallets WHERE workspace_id=${a}`;
    expect(after!.paid_units).toBe(before!.paid_units);expect(after!.promo_units).toBe(before!.promo_units);
    expect((await settleWorkspaceSnapshot(id,db,time))!.debit_units).toBe('2');
  });
  test('rate changes preserve old charges and per-version fractional remainder',async()=>{
    const time=new Date(period.getTime()+2*H);
    const r=await configureStorageRate({version:'rate-two',effective_at:time.toISOString(),numerator:'2',denominator:'1'},config.adminNpub,db,new Date(time.getTime()-H));
    const id=await snapshot(a,time,'2');expect((await settleWorkspaceSnapshot(id,db,time))!.debit_units).toBe('4');
    const carry=await db`SELECT c.remainder FROM hosting_workspace_rate_carry c JOIN hosting_storage_rates r ON r.id=c.rate_id WHERE c.workspace_id=${a} AND r.version='rate-one-third'`;
    expect(carry[0]!.remainder).toBe('1');
    const old=await db`SELECT debit_units FROM hosting_workspace_settlements WHERE workspace_id=${a} ORDER BY period_start LIMIT 1`;expect(old[0]!.debit_units).toBe('1');
  });
  test('missing pricing, failed samples and historical periods remain unbilled',async()=>{
    const beforeRate=new Date(base.getTime()-H);await enrollWorkspaceBilling(c,actor,false,db,new Date(beforeRate.getTime()-H));
    const missing=await snapshot(c,beforeRate,'100');expect((await settleWorkspaceSnapshot(missing,db,beforeRate))!.status).toBe('no_rate');
    const unavailable=await snapshot(c,period,null,'unavailable');expect((await settleWorkspaceSnapshot(unavailable,db,period))!.debit_units).toBeNull();
    const old=await snapshot(c,new Date(period.getTime()+H),'100');expect((await settleWorkspaceSnapshot(old,db,new Date(period.getTime()+2*H)))!.status).toBe('missed');
    expect((await db`SELECT * FROM hosting_ledger WHERE workspace_id=${c} AND kind='workspace_usage'`).length).toBe(0);
  });
  test('expired allocated promo cannot be extended; exhaustion is workspace-local and restores on allocation',async()=>{
    const time=new Date('2026-11-02T01:00:00Z'),id=await snapshot(a,time,'200');
    expect((await settleWorkspaceSnapshot(id,db,time))!.debit_units).toBe('400');
    const [wallet]=await db`SELECT * FROM hosting_workspace_wallets WHERE workspace_id=${a}`;
    expect(wallet!.promo_units).toBe('0');expect(BigInt(wallet!.paid_units)<0n).toBe(true);expect(wallet!.depleted_at).toBeTruthy();
    expect((await hostingWriteBlock(a,db))!.code).toBe('hosting_balance_exhausted');expect(await hostingWriteBlock(b,db)).toBeNull();
    const [otherWallet]=await db`SELECT * FROM hosting_workspace_wallets WHERE workspace_id=${b}`;expect(otherWallet!.paid_units).toBe('100');
    await allocateWorkspaceCredit(a,actor,'1000','restore-fixture',db,time);
    expect((await db`SELECT depleted_at FROM hosting_workspace_wallets WHERE workspace_id=${a}`)[0]!.depleted_at).toBeNull();
  });
  test('stored costs never expose pooled identity/balances and owner changes fence funding/settlement',async()=>{
    const costs=await readWorkspaceCosts(a,50,db,period);
    expect(costs.wallet).toBeNull();expect(JSON.stringify(costs)).not.toContain(account);expect(JSON.stringify(costs)).not.toContain(actor);
    expect((await readWorkspaceCosts(a,50,db,period,true)).wallet).toBeTruthy();
    await db`UPDATE flightdeck_pg_workspaces SET workspace_owner_npub='other-fixture' WHERE id=${a}`;
    expect((await readWorkspaceCosts(a,50,db,period,true)).wallet).toBeNull();
    await expect(allocateWorkspaceCredit(a,actor,'1','old-owner-fixture',db,period)).rejects.toThrow('workspace_owner_required');
    await expect(enrollWorkspaceBilling(a,other,true,db,period)).rejects.toThrow('existing_hosting_account_required');
    const time=new Date('2026-11-02T02:00:00Z'),id=await snapshot(a,time,'10');
    expect((await settleWorkspaceSnapshot(id,db,time))!.status).toBe('owner_changed');
    expect((await hostingWriteBlock(a,db))!.code).toBe('hosting_owner_changed');
  });
});
