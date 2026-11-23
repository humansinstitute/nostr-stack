import { getDb } from '../db';
import { config } from '../config';
import type { HostingWorkspaceCosts } from '../types';
import { HostingError, lockedAccount } from './hosting-billing';
import { runStorageMeteringTick, STORAGE_MEASUREMENT_VERSION } from './hosting-metering';

type Db = ReturnType<typeof getDb>;
const HOUR=3_600_000;
const hour=(date:Date)=>Math.floor(date.getTime()/HOUR)*HOUR;
export const workspaceBillingEnabled=()=>process.env.HOSTING_WORKSPACE_BILLING_ENABLED==='true';
function enabled(){if(config.billing.mode!=='disabled')throw new HostingError(409,'legacy_credit_billing_must_be_disabled');if(!workspaceBillingEnabled())throw new HostingError(503,'workspace_billing_rollout_disabled');}
function integer(value:unknown,positive=false):bigint {
  if(typeof value!=='string'||!/^\d{1,30}$/.test(value))throw new HostingError(400,'invalid_exact_amount');
  const n=BigInt(value);if(positive&&n===0n)throw new HostingError(400,'invalid_exact_amount');return n;
}
async function owner(workspaceId:string,actorId:string,sql:Db) {
  const [w]=await sql`SELECT w.workspace_owner_npub,a.npub FROM flightdeck_pg_workspaces w JOIN flightdeck_pg_actors a ON a.id=${actorId} WHERE w.id=${workspaceId} FOR SHARE OF w`;
  if(!w||w.workspace_owner_npub!==w.npub)throw new HostingError(403,'workspace_owner_required');
}
export function exactStorageCharge(bytes:string,numerator:string,denominator:string,remainder='0') {
  const b=integer(bytes),n=integer(numerator),d=integer(denominator,true),r=integer(remainder);
  if(r>=d)throw new HostingError(409,'invalid_rate_carry');
  const total=b*n+r;return {debit:(total/d).toString(),remainder:(total%d).toString()};
}
/** Rate facts append only; authority is platform administration, never workspace.manage. */
export async function configureStorageRate(input:{version:string;effective_at:string;numerator:string;denominator:string},actorNpub:string,db:Db=getDb(),now:Date|(()=>Date)=()=>new Date()) {
  enabled();if(!config.adminNpub||actorNpub!==config.adminNpub)throw new HostingError(403,'platform_admin_required');
  const effective=new Date(input.effective_at),n=integer(input.numerator),d=integer(input.denominator,true);
  if(n>1_000_000_000_000_000_000n||d>1_000_000_000_000_000_000n)throw new HostingError(400,'rate_precision_exceeded');
  if(typeof input.version!=='string'||!/^[a-zA-Z0-9_.-]{1,100}$/.test(input.version)||!Number.isFinite(effective.getTime())||effective.getTime()%HOUR!==0)throw new HostingError(400,'invalid_rate');
  return db.begin(async tx=>{
    const sql=tx as unknown as Db;await sql`SELECT pg_advisory_xact_lock(1440000722)`;
    const [prior]=await sql`SELECT * FROM hosting_storage_rates WHERE version=${input.version}`;
    if(prior){if(new Date(prior.effective_at).getTime()!==effective.getTime()||prior.numerator!==n.toString()||prior.denominator!==d.toString())throw new HostingError(409,'idempotency_conflict');return prior;}
    if(effective.getTime()<hour(typeof now==='function'?now():now)+HOUR)throw new HostingError(400,'rate_must_be_future_hour');
    const [latest]=await sql`SELECT effective_at FROM hosting_storage_rates ORDER BY effective_at DESC LIMIT 1`;
    if(latest&&effective<=new Date(latest.effective_at))throw new HostingError(409,'rate_order_conflict');
    const [row]=await sql`INSERT INTO hosting_storage_rates(version,effective_at,measurement_version,numerator,denominator,actor_npub)
      VALUES(${input.version},${effective},${STORAGE_MEASUREMENT_VERSION},${n.toString()},${d.toString()},${actorNpub}) RETURNING *`;return row;
  });
}
/** Explicit enrollment reuses an EXISTING account, creates no welcome grant or conversion.
 * Acknowledged v1 transition starts next full hour; old rows and links are retained.
 */
export async function enrollWorkspaceBilling(workspaceId:string,actorId:string,confirmTransition:boolean,db:Db=getDb(),now:Date|(()=>Date)=()=>new Date()) {
  enabled();
  return db.begin(async tx=>{
    const sql=tx as unknown as Db;await owner(workspaceId,actorId,sql);
    const [account]=await sql`SELECT id FROM hosting_accounts WHERE owner_actor_id=${actorId}`;
    if(!account)throw new HostingError(409,'existing_hosting_account_required');
    await sql`SELECT id FROM hosting_accounts WHERE id=${account.id} FOR UPDATE`;
    const [prior]=await sql`SELECT * FROM hosting_workspace_wallets WHERE workspace_id=${workspaceId}`;
    if(prior){if(prior.owner_actor_id!==actorId)throw new HostingError(409,'billing_owner_conflict');return {workspace_id:workspaceId,enabled_at:prior.enabled_at};}
    const [link]=await sql`SELECT account_id FROM hosting_workspace_accounts WHERE workspace_id=${workspaceId}`;
    if(link&&link.account_id!==account.id)throw new HostingError(409,'billing_owner_conflict');
    if(link&&!confirmTransition)throw new HostingError(409,'explicit_v1_transition_required');
    const starts=new Date(hour(typeof now==='function'?now():now)+HOUR);
    await sql`INSERT INTO hosting_workspace_accounts(workspace_id,account_id,enabled_at) VALUES(${workspaceId},${account.id},${starts}) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO hosting_workspace_wallets(workspace_id,account_id,owner_actor_id,enabled_at) VALUES(${workspaceId},${account.id},${actorId},${starts})`;
    await sql`INSERT INTO hosting_metering_workspaces(workspace_id,enabled_at) VALUES(${workspaceId},${starts}) ON CONFLICT(workspace_id) DO UPDATE SET enabled_at=EXCLUDED.enabled_at`;
    return {workspace_id:workspaceId,enabled_at:starts};
  });
}
async function expireWallet(wallet:any,sql:Db,now:Date) {
  if(wallet.promo_expires_at&&new Date(wallet.promo_expires_at)<=now&&BigInt(wallet.promo_units)>0n){
    await sql`INSERT INTO hosting_ledger(account_id,workspace_id,balance_scope,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason)
      VALUES(${wallet.account_id},${wallet.workspace_id},'workspace','promo_expiry',${(-BigInt(wallet.promo_units)).toString()},${wallet.paid_units},0,${`workspace-promo-expiry:${wallet.workspace_id}:${new Date(wallet.promo_expires_at).toISOString()}`},'Allocated promotional credit expired')`;
    await sql`UPDATE hosting_workspace_wallets SET promo_units=0 WHERE workspace_id=${wallet.workspace_id}`;
    wallet.promo_units='0';
  }
  return wallet;
}
export async function allocateWorkspaceCredit(workspaceId:string,actorId:string,amountUnits:string,key:string,db:Db=getDb(),now:Date|(()=>Date)=()=>new Date()) {
  enabled();const amount=integer(amountUnits,true);
  if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(key))throw new HostingError(400,'invalid_idempotency_key');
  return db.begin(async tx=>{
    const sql=tx as unknown as Db;await owner(workspaceId,actorId,sql);
    const [link]=await sql`SELECT account_id FROM hosting_workspace_wallets WHERE workspace_id=${workspaceId} AND owner_actor_id=${actorId}`;
    if(!link)throw new HostingError(409,'workspace_billing_not_enrolled');
    await sql`SELECT id FROM hosting_accounts WHERE id=${link.account_id} FOR UPDATE`;
    const [locked]=await sql`SELECT * FROM hosting_workspace_wallets WHERE workspace_id=${workspaceId} FOR UPDATE`;
    const decisionTime=typeof now==='function'?now():now;
    const account=await lockedAccount(link.account_id,sql,decisionTime);
    if(account.owner_actor_id!==actorId)throw new HostingError(409,'billing_owner_conflict');
    const wallet=await expireWallet(locked,sql,decisionTime),idempotency=`workspace-fund:${workspaceId}:${key}`;
    const [prior]=await sql`SELECT amount_units FROM hosting_ledger WHERE account_id=${account.id} AND idempotency_key=${idempotency}`;
    if(prior){if(prior.amount_units!==(-amount).toString())throw new HostingError(409,'idempotency_conflict');return {workspace_id:workspaceId,allocated_units:amount.toString(),idempotency_key:key};}
    const promo=BigInt(account.promo_units),paid=BigInt(account.paid_units);
    const available=promo+paid;
    if(available<amount)throw new HostingError(409,'insufficient_owner_credit');
    const fromPromo=promo<amount?promo:amount,fromPaid=amount-fromPromo;
    const accountPromo=promo-fromPromo,accountPaid=paid-fromPaid;
    const walletPromo=BigInt(wallet.promo_units)+fromPromo,walletPaid=BigInt(wallet.paid_units)+fromPaid;
    if(fromPromo&&BigInt(wallet.promo_units)>0n&&new Date(wallet.promo_expires_at).getTime()!==new Date(account.promo_expires_at).getTime())throw new HostingError(409,'promo_expiry_conflict');
    await sql`UPDATE hosting_accounts SET paid_units=${accountPaid.toString()},promo_units=${accountPromo.toString()} WHERE id=${account.id}`;
    await sql`UPDATE hosting_workspace_wallets SET paid_units=${walletPaid.toString()},promo_units=${walletPromo.toString()},promo_expires_at=CASE WHEN ${fromPromo.toString()}::numeric>0 THEN ${account.promo_expires_at} ELSE promo_expires_at END,
      depleted_at=CASE WHEN ${walletPaid.toString()}::numeric+${walletPromo.toString()}::numeric>0 THEN NULL ELSE depleted_at END WHERE workspace_id=${workspaceId}`;
    await sql`INSERT INTO hosting_ledger(account_id,workspace_id,balance_scope,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason,metadata)
      VALUES(${account.id},${workspaceId},'account','workspace_allocation',${(-amount).toString()},${accountPaid.toString()},${accountPromo.toString()},${idempotency},'Explicit owner funding allocation',${sql.json({paid_units:fromPaid.toString(),promo_units:fromPromo.toString(),promo_expires_at:account.promo_expires_at})}),
      (${account.id},${workspaceId},'workspace','workspace_allocation',${amount.toString()},${walletPaid.toString()},${walletPromo.toString()},${`${idempotency}:received`},'Received owner funding allocation',${sql.json({funding_key:idempotency,paid_units:fromPaid.toString(),promo_units:fromPromo.toString(),promo_expires_at:account.promo_expires_at})})`;
    return {workspace_id:workspaceId,allocated_units:amount.toString(),idempotency_key:key};
  });
}
export async function settleWorkspaceSnapshot(snapshotId:string,db:Db=getDb(),now:Date|(()=>Date)=()=>new Date()) {
  enabled();
  return db.begin(async tx=>{
    const sql=tx as unknown as Db;
    const [snapshot]=await sql`SELECT * FROM hosting_storage_snapshots WHERE id=${snapshotId}`;
    if(!snapshot)throw new HostingError(404,'snapshot_not_found');
    await sql`SELECT id FROM flightdeck_pg_workspaces WHERE id=${snapshot.workspace_id} FOR SHARE`;
    const [locked]=await sql`SELECT * FROM hosting_workspace_wallets WHERE workspace_id=${snapshot.workspace_id} FOR UPDATE`;
    if(!locked)return null;
    const [prior]=await sql`SELECT * FROM hosting_workspace_settlements WHERE snapshot_id=${snapshotId}`;if(prior)return prior;
    const period=new Date(snapshot.period_start),workspaceId=snapshot.workspace_id;
    if(period<new Date(locked.enabled_at))return null;
    const decisionTime=typeof now==='function'?now():now;
    let status=snapshot.status==='measured'?'charged':snapshot.status;
    if(period.getTime()!==hour(decisionTime))status='missed';
    const [current]=await sql`SELECT w.workspace_owner_npub,a.npub FROM flightdeck_pg_workspaces w JOIN flightdeck_pg_actors a ON a.id=${locked.owner_actor_id} WHERE w.id=${workspaceId}`;
    if(!current||current.workspace_owner_npub!==current.npub||snapshot.owner_actor_id!==locked.owner_actor_id||snapshot.account_id!==locked.account_id)status='owner_changed';
    const [rate]=await sql`SELECT id,numerator,denominator FROM hosting_storage_rates WHERE measurement_version=${snapshot.measurement_version} AND effective_at<=${period} ORDER BY effective_at DESC LIMIT 1`;
    if(status==='charged'&&!rate)status='no_rate';
    let debit:string|null=null,carryBefore:string|null=null,carryAfter:string|null=null,ledgerId:string|null=null;
    if(status==='charged'){
      const wallet=await expireWallet(locked,sql,decisionTime);
      const [carry]=await sql`SELECT remainder FROM hosting_workspace_rate_carry WHERE workspace_id=${workspaceId} AND rate_id=${rate!.id}`;
      carryBefore=carry?.remainder??'0';const charge=exactStorageCharge(snapshot.covered_bytes,rate!.numerator,rate!.denominator,carryBefore!);
      debit=charge.debit;carryAfter=charge.remainder;
      const amount=BigInt(debit),promo=BigInt(wallet.promo_units),fromPromo=promo<amount?promo:amount;
      const nextPromo=promo-fromPromo,nextPaid=BigInt(wallet.paid_units)-(amount-fromPromo);
      await sql`UPDATE hosting_workspace_wallets SET paid_units=${nextPaid.toString()},promo_units=${nextPromo.toString()},depleted_at=CASE WHEN ${nextPaid.toString()}::numeric+${nextPromo.toString()}::numeric<=0 THEN COALESCE(depleted_at,${decisionTime}) ELSE NULL END WHERE workspace_id=${workspaceId}`;
      await sql`INSERT INTO hosting_workspace_rate_carry(workspace_id,rate_id,remainder) VALUES(${workspaceId},${rate!.id},${carryAfter}) ON CONFLICT(workspace_id,rate_id) DO UPDATE SET remainder=EXCLUDED.remainder`;
      const [entry]=await sql`INSERT INTO hosting_ledger(account_id,workspace_id,balance_scope,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason,snapshot_id,rate_id,duration_seconds)
        VALUES(${wallet.account_id},${workspaceId},'workspace','workspace_usage',${(-amount).toString()},${nextPaid.toString()},${nextPromo.toString()},${`workspace-usage:${snapshotId}`},'Hourly stored-column covered sample; exact configured rate',${snapshotId},${rate!.id},3600) RETURNING id`;
      ledgerId=entry!.id;
    }
    const [result]=await sql`INSERT INTO hosting_workspace_settlements(snapshot_id,workspace_id,period_start,status,rate_id,duration_seconds,debit_units,carry_before,carry_after,ledger_id)
      VALUES(${snapshotId},${workspaceId},${period},${status},${rate?.id??null},3600,${debit},${carryBefore},${carryAfter},${ledgerId}) RETURNING *`;
    return result;
  });
}
/** Stored-only public projection: no owner account identifiers or balances. */
export async function readWorkspaceCosts(workspaceId:string,limit=50,db:Db=getDb(),now=new Date(),includeWallet=false):Promise<HostingWorkspaceCosts> {
  return db.begin(async tx=>{
    const sql=tx as unknown as Db;
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    return readWorkspaceCostsSnapshot(workspaceId,limit,sql,now,includeWallet);
  });
}
async function readWorkspaceCostsSnapshot(workspaceId:string,limit:number,db:Db,now:Date,includeWallet:boolean):Promise<HostingWorkspaceCosts> {
  const bound=Number.isSafeInteger(limit)?Math.max(1,Math.min(200,limit)):50;
  const [wallet]=await db`SELECT enabled_at,paid_units,promo_units,promo_expires_at,depleted_at FROM hosting_workspace_wallets w WHERE workspace_id=${workspaceId} AND ${includeWallet} AND EXISTS(SELECT 1 FROM flightdeck_pg_workspaces s JOIN flightdeck_pg_actors a ON a.npub=s.workspace_owner_npub WHERE s.id=w.workspace_id AND a.id=w.owner_actor_id)`;
  const [enrollment]=await db`SELECT enabled_at FROM hosting_workspace_wallets WHERE workspace_id=${workspaceId}`;
  const entries=await db`SELECT s.snapshot_id,s.period_start,s.status,s.duration_seconds,s.debit_units,s.carry_before,s.carry_after,r.version AS rate_version,r.numerator,r.denominator,l.id AS ledger_id,l.amount_units
    FROM hosting_workspace_settlements s LEFT JOIN hosting_storage_rates r ON r.id=s.rate_id LEFT JOIN hosting_ledger l ON l.id=s.ledger_id WHERE s.workspace_id=${workspaceId} ORDER BY s.period_start DESC LIMIT ${bound}`;
  const [summary]=await db`SELECT sum(debit_units) FILTER(WHERE status='charged')::text AS total_debit_units,count(*) FILTER(WHERE status='charged')::text AS charged_periods,count(*) FILTER(WHERE status<>'charged')::text AS unbilled_periods FROM hosting_workspace_settlements WHERE workspace_id=${workspaceId}`;
  const rates=await db`SELECT version,effective_at,measurement_version,numerator,denominator FROM hosting_storage_rates ORDER BY effective_at DESC LIMIT 200`;
  const promo=wallet&&wallet.promo_expires_at&&new Date(wallet.promo_expires_at)>now?BigInt(wallet.promo_units):0n;
  return {version:2,workspace_id:workspaceId,currency:'USD',units_per_usd:'144000000000',as_of:now.toISOString(),billing_mode:enrollment?'workspace_allocated':'not_enrolled',
    wallet:wallet?{enabled_at:wallet.enabled_at.toISOString(),balance_units:(BigInt(wallet.paid_units)+promo).toString(),paid_units:wallet.paid_units,promo_units:promo.toString(),promo_expires_at:wallet.promo_expires_at?.toISOString()??null,depleted_at:wallet.depleted_at?.toISOString()??null}:null,
    entries:entries.map(r=>({...r,period_start:r.period_start.toISOString()})) as HostingWorkspaceCosts['entries'],
    rates:rates.map(r=>({...r,effective_at:r.effective_at.toISOString()})) as HostingWorkspaceCosts['rates'],
    summary:{total_debit_units:summary!.total_debit_units,charged_periods:summary!.charged_periods,unbilled_periods:summary!.unbilled_periods},coverage:'partial_attributed',cost_precision:'exact integer units with retained rational remainder; no floating point projections'};
}
export async function runWorkspaceBillingTick(db:Db=getDb(),now:Date|(()=>Date)=()=>new Date()) {
  if(!workspaceBillingEnabled()||config.billing.mode!=='disabled')return;
  await runStorageMeteringTick(db,typeof now==='function'?now():now);
  const pending=await db`SELECT s.id FROM hosting_storage_snapshots s JOIN hosting_workspace_wallets w ON w.workspace_id=s.workspace_id
    LEFT JOIN hosting_workspace_settlements c ON c.snapshot_id=s.id WHERE s.period_start>=w.enabled_at AND c.snapshot_id IS NULL ORDER BY s.period_start,s.workspace_id LIMIT 256`;
  for(const row of pending)await settleWorkspaceSnapshot(row.id,db,now);
}
export function startWorkspaceBillingRunner(){
  if(!workspaceBillingEnabled())return ()=>{};
  let running=false;const tick=async()=>{if(running)return;running=true;try{await runWorkspaceBillingTick();}catch{console.error('[workspace-billing] tick failed; retry next minute');}finally{running=false;}};
  void tick();const timer=setInterval(()=>void tick(),60000);timer.unref();return ()=>clearInterval(timer);
}
