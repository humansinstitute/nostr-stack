import { Hono } from 'hono';
import { requireNip98AuthResolved, verifyStrictNip98Mutation } from '../auth';
import { config } from '../config';
import { getDb } from '../db';
import { authorizeFlightDeckPgOperation } from '../services/flightdeck-pg-authorization';
import { resolveFlightDeckPgRequestContext } from '../services/flightdeck-pg-api';
import { grantHostingCredit, hostingStatus, workspaceHostingStatus, HostingError } from '../services/hosting-billing';
import { allocateWorkspaceCredit, configureStorageRate, enrollWorkspaceBilling, readWorkspaceCosts } from '../services/hosting-workspace-billing';
import { readStoredMetering } from '../services/hosting-metering';
import { createHostingCheckout, receiveHostingStripeWebhook } from '../services/hosting-stripe';
import { accountStorageSummary, workspaceStorageHours } from '../services/hosting-storage';
export const hostingBillingRouter=new Hono();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
hostingBillingRouter.post('/stripe/webhook',async c=>{
  try {return c.json(await receiveHostingStripeWebhook(Buffer.from(await c.req.arrayBuffer()),c.req.header('stripe-signature')??null));}
  catch(e){if(e instanceof HostingError)return c.json({code:e.code,error:e.message},e.status as any);throw e;}
});
hostingBillingRouter.all('/workspaces/:workspaceId/:operation',async c=> {
  c.header('Cache-Control','private, no-store');
  try {
    const id=c.req.param('workspaceId'),op=c.req.param('operation'),write=c.req.method==='POST';
    if(!uuid.test(id)||!['status','usage','ledger','metering','costs','storage','checkout','grant','enroll','allocate','rate'].includes(op))throw new HostingError(404,'not_found');
    if(write?!['checkout','grant','enroll','allocate','rate'].includes(op):c.req.method!=='GET'||!['status','usage','ledger','metering','costs','storage'].includes(op))throw new HostingError(405,'method_not_allowed');
    let actor:string,body:any;
    if(write){const raw=await c.req.text();if(Buffer.byteLength(raw)>4096)throw new HostingError(400,'body_too_large');
      const proof=await verifyStrictNip98Mutation(c.req.header('authorization')??null,c.req.raw,raw);
      if(!proof.ok)throw new HostingError(401,proof.reasonCode);actor=proof.userNpub;
      try{body=JSON.parse(raw);}catch{throw new HostingError(400,'invalid_json');}
    }else{const auth=await requireNip98AuthResolved(c);if(auth instanceof Response)return auth;actor=auth.userNpub;}
    const context=await resolveFlightDeckPgRequestContext({workspaceId:id,actorNpub:actor});
    if(!context.workspace)throw new HostingError(404,'workspace_not_found');
    const [accountOwner]=await getDb()`SELECT a.owner_actor_id FROM hosting_workspace_accounts l JOIN hosting_accounts a ON a.id=l.account_id WHERE l.workspace_id=${id}`;
    const isAccountOwner=Boolean(accountOwner && context.actor?.id===accountOwner.owner_actor_id && context.actor?.npub===context.workspace.workspace_owner_npub);
    const platformAdmin=actor===config.adminNpub;
    if(['grant','rate'].includes(op)&&!platformAdmin)throw new HostingError(403,'platform_admin_required');
    if(!platformAdmin){
      const owner=isAccountOwner;
      const decision=await authorizeFlightDeckPgOperation({workspaceId:id,actorNpub:actor,appNpub:context.workspace.app_npub,permission:'workspace.manage',resource:{type:'workspace'}});
      if(!owner&&!decision.allowed)throw new HostingError(403,'workspace_manager_required');
    }
    if(op==='enroll'||op==='allocate') {
      if(!context.actor)throw new HostingError(403,'workspace_owner_required');
      if(op==='enroll'){
        if(!body||Object.keys(body).join(',')!=='confirm_v1_transition'||typeof body.confirm_v1_transition!=='boolean')throw new HostingError(400,'invalid_enrollment');
        return c.json(await enrollWorkspaceBilling(id,context.actor.id,body.confirm_v1_transition));
      }
      if(!body||Object.keys(body).sort().join(',')!=='amount_units,idempotency_key')throw new HostingError(400,'invalid_allocation');
      return c.json(await allocateWorkspaceCredit(id,context.actor.id,body.amount_units,body.idempotency_key));
    }
    if(op==='rate'){
      if(!body||Object.keys(body).sort().join(',')!=='denominator,effective_at,numerator,version')throw new HostingError(400,'invalid_rate');
      return c.json(await configureStorageRate(body,actor),201);
    }
    if(op==='costs')return c.json(await readWorkspaceCosts(id,Number(c.req.query('limit'))||50,getDb(),new Date(),isAccountOwner));
    if(op==='metering')return c.json(await readStoredMetering(id,Number(c.req.query('limit'))||50));
    const owner=isAccountOwner||platformAdmin;
    const [peak]=await getDb()`SELECT e.account_id,e.activated_at,e.intro_ends_at FROM hosting_storage_enrollments e WHERE e.workspace_id=${id}`;
    if(op==='storage'){
      if(!peak)throw new HostingError(409,'peak_storage_billing_not_enabled');
      const hours=await workspaceStorageHours(getDb(),id,Number(c.req.query('limit'))||50);
      // Membership or workspace.manage never confers shared-account balances.
      if(!owner)return c.json({version:1,workspace_id:id,financial_scope:'workspace',activated_at:peak.activated_at,intro_ends_at:peak.intro_ends_at,hours});
      return c.json({...await accountStorageSummary(getDb(),peak.account_id),workspace_id:id,hours});
    }
    if(peak&&(op==='status'||op==='usage')){
      const limit=Math.max(1,Math.min(200,Math.floor(Number(c.req.query('limit'))||50)));
      if(op==='usage')return c.json({workspace_id:id,billing_mode:'usd_peak_v1',entries:await workspaceStorageHours(getDb(),id,limit)});
      return c.json({version:1,billing_mode:'usd_peak_v1',workspace_id:id,...(owner?{account_id:peak.account_id,storage:await accountStorageSummary(getDb(),peak.account_id)}:{financial_scope:'workspace'}),activated_at:peak.activated_at,intro_ends_at:peak.intro_ends_at,can_top_up:isAccountOwner});
    }
    // Workspace authority does not confer shared customer-account financial access.
    const status=owner?await hostingStatus(id):await workspaceHostingStatus(id);

    if(op==='status'){const {account_id,...workspaceStatus}=status as any;return c.json({...(!owner?workspaceStatus:status),can_top_up:isAccountOwner});}
    const accountId=(status as any).account_id;
    if(!accountId)throw new HostingError(409,'billing_not_enabled_for_workspace');
    if(op==='checkout') {
      // Only account owner can spend into the account; managers may monitor.
      if(!isAccountOwner)throw new HostingError(403,'account_owner_required');
      return c.json(await createHostingCheckout(accountId,body),201);
    }
    if(op==='grant') {
      if(!body||Object.keys(body).sort().join(',')!=='amount_cents,idempotency_key,reason')throw new HostingError(400,'invalid_grant');
      return c.json({entry:await grantHostingCredit(accountId,body.amount_cents,body.idempotency_key,body.reason,actor)});
    }
    const limit=Math.max(1,Math.min(200,Math.floor(Number(c.req.query('limit'))||50)));
    // Ledger is shared financial data. Managers get workspace debits only, owners get account ledger.
    const entries=op==='usage'?(owner?await getDb()`SELECT * FROM hosting_usage_hours WHERE workspace_id=${id} ORDER BY hour DESC LIMIT ${limit}`:
      await getDb()`SELECT workspace_id,hour,status,bytes,debit_units FROM hosting_usage_hours WHERE workspace_id=${id} ORDER BY hour DESC LIMIT ${limit}`):
      owner?await getDb()`SELECT * FROM hosting_ledger WHERE account_id=${accountId} AND balance_scope='account' ORDER BY created_at DESC,id DESC LIMIT ${limit}`:
      await getDb()`SELECT id,workspace_id,kind,amount_units,created_at FROM hosting_ledger WHERE account_id=${accountId} AND workspace_id=${id}::uuid AND ((balance_scope='workspace' AND kind='workspace_usage') OR (balance_scope='account' AND kind='usage')) ORDER BY created_at DESC,id DESC LIMIT ${limit}`;
    return c.json({workspace_id:id,...(owner?{account_id:accountId}:{}),entries});
  }catch(e){if(e instanceof HostingError)return c.json({code:e.code,error:e.message},e.status as any);throw e;}
});
