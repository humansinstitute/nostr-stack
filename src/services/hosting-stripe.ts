import Stripe from 'stripe';
import { config } from '../config';
import { getDb } from '../db';
import { HostingError } from './hosting-billing';
import { applyAdjustment, availableRefundableUnits, missingFundingReserves, recordFundingEvent, recordSettlement, refundableCents, UNITS_PER_CENT } from './hosting-funding';
import { markOnboardingFunded, ONBOARDING_MIN_FUNDING_CENTS } from './onboarding';
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS } from './hosting-topup-limits';
type Db=ReturnType<typeof getDb>;
export function hostingStripeClient() {
  const key=process.env.STRIPE_SECRET_KEY;
  const mode=process.env.HOSTING_STRIPE_MODE||'test';
  // Live rollout stays blocked until refund/dispute reconciliation and live acceptance are reviewed.
  if(mode!=='test')throw new HostingError(503,'stripe_live_rollout_blocked');
  if(!key||!process.env.STRIPE_WEBHOOK_SECRET||!process.env.HOSTING_STRIPE_RETURN_URLS)throw new HostingError(503,'stripe_unconfigured');
  if(!key.startsWith('sk_test_')&&!key.startsWith('rk_test_'))throw new HostingError(503,'stripe_mode_mismatch');
  return new Stripe(key,{maxNetworkRetries:2,timeout:15000});
}
export async function createHostingCheckout(accountId:string,body:unknown,db:Db=getDb(),client=hostingStripeClient(),opts:{intentId?:string;topup?:boolean}={}) {
  const b=body as any;
  if(!b||Object.keys(b).sort().join(',')!=='amount_cents,idempotency_key,return_url'||!(opts.intentId?Number.isSafeInteger(b.amount_cents)&&b.amount_cents>=ONBOARDING_MIN_FUNDING_CENTS&&b.amount_cents<=1_000_000:opts.topup?Number.isSafeInteger(b.amount_cents)&&b.amount_cents>=TOPUP_MIN_CENTS&&b.amount_cents<=TOPUP_MAX_CENTS:[500,1000,2500,5000,10000].includes(b.amount_cents))
    ||typeof b.idempotency_key!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(b.idempotency_key)||typeof b.return_url!=='string')throw new HostingError(400,'invalid_checkout');
  const allowed=(process.env.HOSTING_STRIPE_RETURN_URLS||'').split(',').map(s=>s.trim());
  if(!allowed.includes(b.return_url))throw new HostingError(400,'return_url_not_allowed');
  let u:URL;try{u=new URL(b.return_url);}catch{throw new HostingError(400,'invalid_return_url');}
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw new HostingError(400,'invalid_return_url');
  const order=await db.begin(async transaction=>{
    const tx=transaction as unknown as Db;
    await tx`SELECT id FROM hosting_accounts WHERE id=${accountId} FOR UPDATE`;
    if(opts.intentId){
      // Serializes with cancel/release: an order is attached only to a still-open intent of this account.
      const [i]=await tx`SELECT status,account_id FROM onboarding_intents WHERE id=${opts.intentId} FOR UPDATE`;
      if(!i||i.account_id!==accountId)throw new HostingError(404,'intent_not_found');
      if(i.status!=='open')throw new HostingError(409,'intent_not_open');
    }
    // Legacy checkout never references onboarding columns; only intent-bound orders carry intent_id.
    const [o]=opts.intentId
      ?await tx`INSERT INTO hosting_checkout_orders(account_id,idempotency_key,amount_cents,return_url,mode,intent_id)
        VALUES(${accountId},${b.idempotency_key},${b.amount_cents},${b.return_url},'test',${opts.intentId})
        ON CONFLICT(account_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`
      :await tx`INSERT INTO hosting_checkout_orders(account_id,idempotency_key,amount_cents,return_url,mode)
        VALUES(${accountId},${b.idempotency_key},${b.amount_cents},${b.return_url},'test')
        ON CONFLICT(account_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`;
    if(o!.amount_cents!==b.amount_cents||o!.return_url!==b.return_url||o!.mode!=='test'||(o!.intent_id??null)!==(opts.intentId??null))throw new HostingError(409,'idempotency_conflict');return o!;
  });
  const session=await ensureCheckoutSession(order,client,db);
  return {order_id:order.id,checkout_url:session.url,mode:'test',amount_cents:order.amount_cents};
}
/** The exact return URLs a client may send, as configured by the operator: https (or loopback http) with no userinfo, query or
 * fragment, which is the shape the native clients accept. Nothing else is ever listed; a client cannot add to it. */
export function approvedCheckoutReturnUrls():string[] {
  const out:string[]=[];
  for(const raw of (process.env.HOSTING_STRIPE_RETURN_URLS||'').split(',').map(v=>v.trim()).filter(Boolean)){
    try{
      const u=new URL(raw);
      const loopback=['localhost','127.0.0.1'].includes(u.hostname);
      if(u.username||u.password||u.search||u.hash)continue;
      if(u.protocol==='https:'||(u.protocol==='http:'&&loopback))out.push(raw);
    }catch{/* an unparseable entry is never offered */}
  }
  return [...new Set(out)];
}
/** Creates (idempotently) or retrieves the provider session bound to a local order and records its id. */
async function ensureCheckoutSession(order:any,client:Stripe,db:Db) {
  const session=order.session_id?await client.checkout.sessions.retrieve(order.session_id):await client.checkout.sessions.create({
    mode:'payment',allowed_payment_method_types:['card'],client_reference_id:order.id,
    metadata:{hosting_order_id:order.id,hosting_account_id:order.account_id},
    payment_intent_data:{metadata:{hosting_order_id:order.id,hosting_account_id:order.account_id}},
    line_items:[{price_data:{currency:'usd',unit_amount:order.amount_cents,product_data:{name:'Prepaid NStack hosting credit'}},quantity:1}],
    success_url:order.return_url,cancel_url:order.return_url,
  },{idempotencyKey:`hosting-v1:${order.id}`});
  if(session.livemode)throw new HostingError(503,'stripe_mode_mismatch');
  await db`UPDATE hosting_checkout_orders SET session_id=${session.id} WHERE id=${order.id} AND (session_id IS NULL OR session_id=${session.id})`;
  return session;
}
/** The full immutable binding between a provider Checkout Session and its local order. Crediting and releasing a hold both require it. */
function sessionBoundToOrder(o:any,session:Stripe.Checkout.Session) {
  return o.mode==='test'&&!session.livemode&&session.mode==='payment'&&session.client_reference_id===o.id
    &&session.metadata?.hosting_order_id===o.id&&session.metadata?.hosting_account_id===o.account_id
    &&session.currency==='usd'&&session.amount_total===o.amount_cents&&(!o.session_id||o.session_id===session.id);
}
export async function fulfillHostingCheckout(session:Stripe.Checkout.Session,db:Db=getDb()) {
  if(session.livemode||session.mode!=='payment'||session.payment_status!=='paid')return {credited:false};
  if(!session.metadata?.hosting_order_id)return {credited:false};
  return db.begin(async transaction=>{
    const tx=transaction as unknown as Db;
    const [o]=await tx`SELECT * FROM hosting_checkout_orders WHERE id=${session.metadata!.hosting_order_id} FOR UPDATE`;
    if(!o)return {credited:false};
    if(!sessionBoundToOrder(o,session)||typeof session.payment_intent!=='string')throw new HostingError(400,'stripe_binding_mismatch');
    if(o.fulfilled_at)return {credited:false,duplicate:true};
    // Method-neutral binding: one immutable settlement and one ledger credit per verified payment. The unique provider
    // reference prevents two orders from ever crediting the same payment.
    const settled=await recordSettlement(tx,{accountId:o.account_id,method:'stripe',providerRef:session.payment_intent,orderId:o.id,intentId:o.intent_id??null,amountCents:o.amount_cents,
      ledgerKind:'stripe',reason:'Verified paid Stripe Checkout',evidence:{session_id:session.id,payment_intent:session.payment_intent,mode:'test'}});
    await tx`UPDATE hosting_checkout_orders SET session_id=${session.id},payment_intent=${session.payment_intent},fulfilled_at=now() WHERE id=${o.id}`;
    // Only this verified, ledgered payment may fund an onboarding intent; redirects and client flags cannot.
    if(o.intent_id)await markOnboardingFunded(o,settled.settlement.id,tx);
    return {credited:settled.credited};
  });
}

// ---- Checkout terminal state (verified provider truth, never a local guess) -------------------------------------------

/** Brings unfulfilled orders to a verified terminal state. A paid session is credited; an open session is expired at the
 * provider (so it can never be paid later) and recorded terminal only once the provider confirms `expired`. Anything
 * unverifiable (provider error, async payment pending, unconfigured provider) stays outstanding and keeps its seat. */
export async function resolveCheckoutOrders(orderIds:string[],db:Db=getDb(),clientFactory:()=>Stripe=hostingStripeClient) {
  if(!orderIds.length)return {outstanding:0};
  const orders=await db`SELECT * FROM hosting_checkout_orders WHERE id=ANY(${orderIds}::uuid[]) AND fulfilled_at IS NULL AND terminal_at IS NULL`;
  if(!orders.length)return {outstanding:0};
  let client:Stripe;
  try{client=clientFactory();}catch{return {outstanding:orders.length};}
  let outstanding=0;
  for(const order of orders){
    try{
      if(order.mode!=='test')throw new HostingError(503,'stripe_mode_mismatch');
      let session=await ensureCheckoutSession(order,client,db);
      if(session.payment_status!=='paid'&&session.status==='open'){
        try{session=await client.checkout.sessions.expire(session.id);}catch{session=await client.checkout.sessions.retrieve(session.id);}
      }
      // A session that does not match the order's immutable binding proves nothing about it: the hold stays.
      if(!sessionBoundToOrder(order,session)){outstanding++;continue;}
      if(session.payment_status==='paid'){await fulfillHostingCheckout(session,db);continue;}
      if(session.status==='expired'){await markOrderExpired(order,session,db);continue;}
      outstanding++;
    }catch{outstanding++;}
  }
  return {outstanding};
}
/** Records a verified-unpayable order. Requires the provider session to be the order's own recorded session with the full binding. */
async function markOrderExpired(order:any,session:Stripe.Checkout.Session,db:Db) {
  if(session.status!=='expired'||session.payment_status==='paid'||!order.session_id||order.session_id!==session.id||!sessionBoundToOrder(order,session))return false;
  const done=await db`UPDATE hosting_checkout_orders SET terminal_at=now(),terminal_reason='expired' WHERE id=${order.id} AND session_id=${session.id} AND fulfilled_at IS NULL AND terminal_at IS NULL RETURNING id`;
  return done.length>0;
}

// ---- Refund and dispute reconciliation ------------------------------------------------------------------------------

const refundState=(r:Stripe.Refund)=>r.status==='succeeded'?'succeeded':r.status==='failed'?'failed':r.status==='canceled'?'canceled':'pending';
/** Pending and succeeded refunds withhold the funds; failed and canceled refunds release them. */
const refundEffect=(r:Stripe.Refund)=>['pending','requires_action','succeeded',null].includes(r.status as any)?r.amount:0;
const disputeState=(d:Stripe.Dispute)=>['needs_response','under_review','won','lost'].includes(d.status)?d.status:'inactive';
/** Stripe withdraws the disputed funds from needs_response onward; warnings/inquiries and prevented disputes withdraw nothing, a win reinstates. */
const disputeEffect=(d:Stripe.Dispute)=>['needs_response','under_review','lost'].includes(d.status)?d.amount:0;
async function listAll<T extends {id:string}>(page:(after?:string)=>Promise<{data:T[];has_more:boolean}>) {
  const out:T[]=[];let after:string|undefined;
  for(let i=0;i<50;i++){const r=await page(after);out.push(...r.data);if(!r.has_more||!r.data.length)return out;after=r.data[r.data.length-1]!.id;}
  throw new HostingError(502,'stripe_pagination_limit');
}
const idOf=(v:unknown)=>typeof v==='string'?v:(v&&typeof v==='object'&&typeof (v as any).id==='string'?(v as any).id as string:null);

/** Converges every refund and dispute of one PaymentIntent onto the ledger from Stripe's authoritative current state.
 * Webhook delivery order, duplicates and replays cannot change the result; unknown payments are ignored. */
export async function reconcileStripePayment(client:Stripe,paymentIntentId:string,db:Db=getDb(),event?:{id:string;type:string}) {
  let [settlement]=await db`SELECT * FROM hosting_funding_settlements WHERE method='stripe' AND provider_ref=${paymentIntentId}`;
  if(!settlement){
    // A reversal can be delivered before the payment's own event: settle first from the verified paid session.
    const sessions=await client.checkout.sessions.list({payment_intent:paymentIntentId,limit:1});
    if(sessions.data[0])await fulfillHostingCheckout(await client.checkout.sessions.retrieve(sessions.data[0].id),db);
    [settlement]=await db`SELECT * FROM hosting_funding_settlements WHERE method='stripe' AND provider_ref=${paymentIntentId}`;
  }
  if(!settlement){
    if(event)await recordFundingEvent(db,'stripe',event.id,event.type,null,'ignored_unsettled');
    return {reconciled:false};
  }
  const refunds=await listAll(after=>client.refunds.list({payment_intent:paymentIntentId,limit:100,...(after?{starting_after:after}:{})}));
  const disputes=await listAll(after=>client.disputes.list({payment_intent:paymentIntentId,limit:100,...(after?{starting_after:after}:{})}));
  for(const r of refunds)if(r.currency!=='usd')throw new HostingError(502,'stripe_currency_mismatch');
  for(const d of disputes)if(d.currency!=='usd')throw new HostingError(502,'stripe_currency_mismatch');
  return db.begin(async transaction=>{
    const tx=transaction as unknown as Db;
    // The settlement is re-read under the transaction; evidence rows are immutable.
    for(const r of refunds){
      const requestId=r.metadata?.nstack_request_id&&/^[0-9a-f-]{36}$/i.test(r.metadata.nstack_request_id)?r.metadata.nstack_request_id:null;
      await applyAdjustment(tx,settlement,{kind:'refund',providerRef:r.id,requestId,state:refundState(r),amountCents:r.amount,effectiveCents:refundEffect(r),
        reason:`Stripe refund ${r.status}`,evidence:{refund_id:r.id,status:r.status,reason:r.reason,failure_reason:r.failure_reason??null}});
    }
    for(const d of disputes){
      await applyAdjustment(tx,settlement,{kind:'dispute',providerRef:d.id,state:disputeState(d),amountCents:d.amount,effectiveCents:disputeEffect(d),
        reason:`Stripe dispute ${d.status}`,evidence:{dispute_id:d.id,status:d.status,reason:d.reason}});
    }
    if(event)await recordFundingEvent(tx,'stripe',event.id,event.type,settlement.id,'reconciled');
    return {reconciled:true,refunds:refunds.length,disputes:disputes.length};
  });
}

/** Support-assisted refund of unused, unreserved purchased credit to the original Stripe payment. The funds are withheld
 * from the account first (so they cannot be spent while the refund is in flight); the provider call follows. */
export async function requestStripeRefund(body:unknown,actorNpub:string,db:Db=getDb(),client:Stripe=hostingStripeClient()) {
  if(!config.adminNpub||actorNpub!==config.adminNpub)throw new HostingError(403,'platform_admin_required');
  const b=body as any;
  if(!b||Object.keys(b).sort().join(',')!=='amount_cents,idempotency_key,reason,settlement_id'||!Number.isSafeInteger(b.amount_cents)||b.amount_cents<1
    ||typeof b.idempotency_key!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(b.idempotency_key)||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>500
    ||typeof b.settlement_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.settlement_id))throw new HostingError(400,'invalid_refund');
  // Release gate: an empty reserve registry is not proof that funds are unreserved. Refunds open only once both storage-protection and agent-hold reserves participate.
  if(missingFundingReserves().length)throw new HostingError(503,'refund_reserves_unregistered');
  const [peek]=await db`SELECT * FROM hosting_funding_settlements WHERE id=${b.settlement_id}`;
  if(!peek||peek.method!=='stripe')throw new HostingError(404,'settlement_not_found');
  const held=await db.begin(async transaction=>{
    const tx=transaction as unknown as Db;
    await tx`SELECT id FROM hosting_accounts WHERE id=${peek.account_id} FOR UPDATE`;
    const [existing]=await tx`SELECT * FROM hosting_funding_adjustments WHERE account_id=${peek.account_id} AND request_key=${b.idempotency_key}`;
    if(existing){
      if(existing.settlement_id!==peek.id||existing.amount_cents!==b.amount_cents||existing.reason!==b.reason)throw new HostingError(409,'idempotency_conflict');
      return existing;
    }
    const limit=Math.min(await refundableCents(tx,peek),Number((await availableRefundableUnits(tx,peek.account_id))/UNITS_PER_CENT));
    if(b.amount_cents>limit)throw new HostingError(409,'refund_exceeds_available');
    const requestId=crypto.randomUUID();
    const {adjustment}=await applyAdjustment(tx,peek,{kind:'refund',providerRef:`req:${requestId}`,requestId,requestKey:b.idempotency_key,state:'requested',amountCents:b.amount_cents,effectiveCents:b.amount_cents,
      reason:b.reason,actorNpub,evidence:{requested_by:actorNpub}});
    return adjustment;
  });
  if(['pending','succeeded','failed','canceled'].includes(held.state))return refundView(held);
  let refund:Stripe.Refund;
  try{
    refund=await client.refunds.create({payment_intent:peek.provider_ref,amount:held.amount_cents,reason:'requested_by_customer',metadata:{nstack_request_id:held.request_id,nstack_settlement_id:peek.id}},{idempotencyKey:`refund-v1:${held.request_id}`});
  }catch(e:any){
    // Only a definite provider rejection releases the withheld funds; an ambiguous outcome keeps them held for reconciliation.
    if(typeof e?.statusCode==='number'&&e.statusCode>=400&&e.statusCode<500&&![408,409,429].includes(e.statusCode)){
      return db.begin(async transaction=>refundView((await applyAdjustment(transaction as unknown as Db,peek,{kind:'refund',providerRef:held.provider_ref,requestId:held.request_id,state:'failed',amountCents:held.amount_cents,effectiveCents:0,
        reason:'Stripe rejected refund',actorNpub,evidence:{error:e?.code??e?.type??'rejected'}})).adjustment));
    }
    throw new HostingError(502,'refund_outcome_unknown');
  }
  if(refund.currency!=='usd'||refund.amount!==held.amount_cents)throw new HostingError(502,'stripe_binding_mismatch');
  return db.begin(async transaction=>refundView((await applyAdjustment(transaction as unknown as Db,peek,{kind:'refund',providerRef:refund.id,requestId:held.request_id,state:refundState(refund),amountCents:refund.amount,effectiveCents:refundEffect(refund),
    reason:`Stripe refund ${refund.status}`,actorNpub,evidence:{refund_id:refund.id,status:refund.status}})).adjustment));
}
const refundView=(a:any)=>({adjustment_id:a.id as string,settlement_id:a.settlement_id as string,kind:a.kind as string,state:a.state as string,amount_cents:a.amount_cents as number,effective_cents:a.effective_cents as number,provider_ref:a.provider_ref as string});

// ---- Webhook --------------------------------------------------------------------------------------------------------

export async function receiveHostingStripeWebhook(raw:Buffer,signature:string|null,db:Db=getDb(),client=hostingStripeClient()) {
  if(!signature)throw new HostingError(400,'stripe_signature_required');
  let event:Stripe.Event;
  try {event=await client.webhooks.constructEventAsync(raw,signature,process.env.STRIPE_WEBHOOK_SECRET!);}catch{throw new HostingError(400,'stripe_signature_invalid');}
  if(event.livemode)throw new HostingError(400,'stripe_mode_mismatch');
  const type=event.type as string,object=event.data.object as any;
  if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(type)){
    // Retrieve authoritative paid state; event ordering never rolls a paid order back.
    const session=await client.checkout.sessions.retrieve(object.id);
    return {received:true,...await fulfillHostingCheckout(session,db)};
  }
  if(type==='checkout.session.expired'){
    const session=await client.checkout.sessions.retrieve(object.id);
    const ref=session.metadata?.hosting_order_id;
    const [order]=ref&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)?await db`SELECT * FROM hosting_checkout_orders WHERE id=${ref}`:[];
    // An event for a session that is not exactly this order's own never releases anything.
    if(!order||order.fulfilled_at||!sessionBoundToOrder(order,session))return {received:true,credited:false};
    if(session.payment_status==='paid')return {received:true,...await fulfillHostingCheckout(session,db)};
    return {received:true,credited:false,expired:await markOrderExpired(order,session,db)};
  }
  if(['charge.refunded','charge.refund.updated','refund.created','refund.updated','refund.failed','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated'].includes(type)){
    let pi=idOf(object.payment_intent);
    if(!pi&&typeof object.charge==='string')pi=idOf((await client.charges.retrieve(object.charge)).payment_intent);
    if(!pi)return {received:true,credited:false,reconciled:false};
    return {received:true,credited:false,...await reconcileStripePayment(client,pi,db,{id:event.id,type})};
  }
  return {received:true,credited:false};
}
