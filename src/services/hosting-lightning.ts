import { createHash } from 'node:crypto';
import { config } from '../config';
import { getDb } from '../db';
import { HostingError } from './hosting-billing';
import { applyAdjustment, availableRefundableUnits, missingFundingReserves, recordSettlement, refundableCents, UNITS_PER_CENT } from './hosting-funding';
import { markOnboardingFunded, requireOnboardingEnabled } from './onboarding';

type Db = ReturnType<typeof getDb>;
const HASH = /^[0-9a-f]{64}$/;
const KEY = /^[a-zA-Z0-9_-]{8,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const preimageMatches = (preimageHex: unknown, paymentHash: string) => typeof preimageHex === 'string' && /^[0-9a-f]{64}$/.test(preimageHex) && createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex') === paymentHash;

/** What NStack requires of a Lightning provider before it may fund USD credit. No production adapter exists: a real provider's
 * invoice, FX-quote and settlement contract has not been verified, so none is invented here. A future adapter is a trusted,
 * server-configured module that implements this port; callers can never supply settlement evidence themselves. */
export interface LightningProvider {
  readonly id: string;
  /** Our receiving identity (node/account). Every issued invoice and every settlement must report exactly this. */
  readonly payeeRef: string;
  /** Idempotent per orderRef: a retry returns the same invoice. The provider converts USD to sats and reports its rate evidence. */
  issueInvoice(req: { orderRef: string; amountCents: number }): Promise<{
    invoice: string; paymentHash: string; amountSats: number; expiresAt: string; payeeRef: string;
    rate: { source: string; quotedAt: string; ref?: string };
  }>;
  /** Authoritative provider state for one invoice. The preimage is checked locally against the payment hash. */
  lookupInvoice(paymentHash: string): Promise<{
    status: 'pending' | 'settled' | 'expired' | 'cancelled'; paymentHash: string; payeeRef: string;
    amountSatsReceived?: number; settledAt?: string; preimage?: string;
  }>;
  /** Optional: make a pending invoice unpayable so its hold can be released before natural expiry. */
  cancelInvoice?(paymentHash: string): Promise<{ status: 'pending' | 'settled' | 'expired' | 'cancelled' }>;
  /** Optional payout capability required for support-assisted refunds to a verified customer invoice. */
  payouts?: {
    quoteSats(amountCents: number): Promise<{ sats: number; rate: { source: string; quotedAt: string; ref?: string } }>;
    decodeInvoice(bolt11: string): Promise<{ paymentHash: string; amountSats: number | null; expiresAt: string; payeeRef: string }>;
    pay(req: { bolt11: string; orderRef: string }): Promise<{ status: 'succeeded' | 'failed' | 'pending'; preimage?: string }>;
    lookupPayment(paymentHash: string): Promise<{ status: 'succeeded' | 'failed' | 'pending'; preimage?: string }>;
  };
}
let provider: LightningProvider | null = null;
/** Trusted startup/test hook only. No route, environment value or request can register a provider. */
export function configureLightningProvider(next: LightningProvider | null) { provider = next; }
export function lightningProvider(): LightningProvider {
  if (process.env.HOSTING_LIGHTNING_ENABLED !== 'true' || !provider) throw new HostingError(503, 'lightning_unavailable');
  return provider;
}

const quoteView = (q: any) => ({
  id: q.id as string, intent_id: q.intent_id as string, state: q.state as string, amount_cents: q.amount_cents as number,
  amount_sats: q.amount_sats === null ? null : Number(q.amount_sats), invoice: q.invoice as string | null, payment_hash: q.payment_hash as string | null,
  expires_at: q.expires_at ? new Date(q.expires_at).toISOString() : null,
  rate: q.rate_source ? { source: q.rate_source as string, quoted_at: new Date(q.rate_quoted_at).toISOString() } : null,
});
export type LightningQuoteView = ReturnType<typeof quoteView>;

function validateIssued(issued: Awaited<ReturnType<LightningProvider['issueInvoice']>>, p: LightningProvider, now: Date) {
  const expires = new Date(issued?.expiresAt), quoted = new Date(issued?.rate?.quotedAt);
  if (!issued || typeof issued.invoice !== 'string' || issued.invoice.length < 20 || issued.invoice.length > 4000 || !HASH.test(issued.paymentHash)
    || !Number.isSafeInteger(issued.amountSats) || issued.amountSats < 1 || issued.payeeRef !== p.payeeRef
    || !issued.rate || typeof issued.rate.source !== 'string' || !issued.rate.source || Number.isNaN(quoted.getTime()) || quoted.getTime() > now.getTime()
    || Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime() || expires.getTime() <= quoted.getTime()) throw new HostingError(502, 'lightning_quote_invalid');
}

/** Issues (or replays) the Lightning quote for an open intent. The USD amount is the intent's server-held figure, never caller input. */
export async function issueLightningQuote(intentId: string, ownerNpub: string, body: unknown, db: Db = getDb(), p: LightningProvider = lightningProvider()) {
  requireOnboardingEnabled();
  const b = body as any;
  if (!b || Object.keys(b).join(',') !== 'idempotency_key' || typeof b.idempotency_key !== 'string' || !KEY.test(b.idempotency_key)) throw new HostingError(400, 'invalid_quote_request');
  const digest = sha256(JSON.stringify([intentId, b.idempotency_key]));
  const held = await db.begin(async transaction => {
    const tx = transaction as unknown as Db;
    const [intent] = await tx`SELECT i.* FROM onboarding_intents i JOIN flightdeck_pg_actors a ON a.id=i.owner_actor_id WHERE i.id=${intentId} AND a.npub=${ownerNpub} FOR UPDATE OF i`;
    if (!intent) throw new HostingError(404, 'intent_not_found');
    const [prior] = await tx`SELECT * FROM hosting_lightning_quotes WHERE account_id=${intent.account_id} AND idempotency_key=${b.idempotency_key} FOR UPDATE`;
    if (prior) {
      if (prior.request_sha256 !== digest) throw new HostingError(409, 'idempotency_conflict');
      return prior;
    }
    if (intent.status !== 'open') throw new HostingError(409, 'intent_not_open');
    const [row] = await tx`INSERT INTO hosting_lightning_quotes(account_id,intent_id,idempotency_key,request_sha256,amount_cents) VALUES(${intent.account_id},${intent.id},${b.idempotency_key},${digest},${intent.funding_cents}) RETURNING *`;
    return row!;
  });
  return quoteView(held.state === 'issuing' ? await completeIssuance(held, db, p) : held);
}
/** The provider call is idempotent per quote id, so a crash between issue and record is repaired by replaying the same request. */
async function completeIssuance(held: any, db: Db, p: LightningProvider) {
  const issued = await p.issueInvoice({ orderRef: held.id, amountCents: held.amount_cents });
  validateIssued(issued, p, new Date());
  const [row] = await db`UPDATE hosting_lightning_quotes SET state='open',provider=${p.id},payee_ref=${p.payeeRef},invoice=${issued.invoice},payment_hash=${issued.paymentHash},amount_sats=${issued.amountSats},
    rate_source=${issued.rate.source},rate_ref=${issued.rate.ref ?? null},rate_quoted_at=${issued.rate.quotedAt},expires_at=${issued.expiresAt},updated_at=now() WHERE id=${held.id} AND state='issuing' RETURNING *`;
  return row ?? (await db`SELECT * FROM hosting_lightning_quotes WHERE id=${held.id}`)[0];
}

/** Polls the provider for one quote and applies only verified terminal state: settlement credits once and funds the intent;
 * expiry/cancellation releases the hold; anything inconsistent stays unresolved (and keeps the seat) for support. */
export async function resolveLightningQuote(quoteId: string, db: Db = getDb(), p: LightningProvider = lightningProvider(), now: () => Date = () => new Date(), cancel = false) {
  const [peek] = await db`SELECT * FROM hosting_lightning_quotes WHERE id=${quoteId}`;
  if (!peek) throw new HostingError(404, 'quote_not_found');
  if (!['open', 'late_payment', 'mismatch'].includes(peek.state)) return quoteView(peek);
  let info = await p.lookupInvoice(peek.payment_hash);
  if (info.status === 'pending' && p.cancelInvoice && (cancel || new Date(peek.expires_at).getTime() <= now().getTime())) {
    // Cancelling (or an invoice past its stated expiry) is made unpayable at the provider before the hold is released.
    try { info = { ...info, ...(await p.cancelInvoice(peek.payment_hash)) }; } catch { /* stays unresolved */ }
  }
  return db.begin(async transaction => {
    const tx = transaction as unknown as Db;
    const [q] = await tx`SELECT * FROM hosting_lightning_quotes WHERE id=${quoteId} FOR UPDATE`;
    if (!['open', 'late_payment', 'mismatch'].includes(q!.state)) return quoteView(q);
    const note = async (state: string, evidence: Record<string, unknown>) => quoteView((await tx`UPDATE hosting_lightning_quotes SET state=${state},evidence=${tx.json({ ...q!.evidence, ...evidence } as any)},updated_at=now() WHERE id=${q!.id} RETURNING *`)[0]);
    if (info.paymentHash !== q!.payment_hash || info.payeeRef !== q!.payee_ref) return note('mismatch', { reason: 'identity', observed_at: now().toISOString() });
    if (info.status === 'expired' || info.status === 'cancelled') return note(info.status, { observed_at: now().toISOString() });
    if (info.status !== 'settled') return quoteView(q);
    const settledAt = new Date(info.settledAt ?? NaN);
    if (!Number.isSafeInteger(info.amountSatsReceived) || (info.amountSatsReceived as number) < Number(q!.amount_sats) || Number.isNaN(settledAt.getTime()) || !preimageMatches(info.preimage, q!.payment_hash))
      return note('mismatch', { reason: 'settlement_evidence', received_sats: info.amountSatsReceived ?? null, observed_at: now().toISOString() });
    // Payment after the quoted expiry is real money outside the quote's rate guarantee: recorded for support, never auto-credited.
    if (settledAt.getTime() > new Date(q!.expires_at).getTime()) return note('late_payment', { settled_at: settledAt.toISOString(), received_sats: info.amountSatsReceived, observed_at: now().toISOString() });
    const [intent] = await tx`SELECT id,account_id FROM onboarding_intents WHERE id=${q!.intent_id}`;
    const settled = await recordSettlement(tx, { accountId: q!.account_id, method: 'lightning', providerRef: q!.payment_hash, orderId: q!.id, intentId: q!.intent_id, amountCents: q!.amount_cents, ledgerKind: 'lightning',
      reason: 'Verified Lightning payment', evidence: { provider: q!.provider, payee_ref: q!.payee_ref, amount_sats: Number(q!.amount_sats), received_sats: info.amountSatsReceived, rate_source: q!.rate_source, rate_quoted_at: new Date(q!.rate_quoted_at).toISOString(), settled_at: settledAt.toISOString(), preimage: info.preimage } });
    if (intent) await markOnboardingFunded({ id: q!.id, intent_id: q!.intent_id, account_id: q!.account_id, amount_cents: q!.amount_cents }, settled.settlement.id, tx, null);
    const [done] = await tx`UPDATE hosting_lightning_quotes SET state='settled',settled_at=${settledAt},evidence=${tx.json({ ...q!.evidence, received_sats: info.amountSatsReceived } as any)},updated_at=now() WHERE id=${q!.id} RETURNING *`;
    return quoteView(done);
  });
}

/** Owner-visible quote (resume). Another identity gets the same neutral 404. */
export async function readLightningQuote(quoteId: string, intentId: string, ownerNpub: string, db: Db = getDb()) {
  if (!UUID.test(quoteId) || !UUID.test(intentId)) throw new HostingError(404, 'quote_not_found');
  const [q] = await db`SELECT q.* FROM hosting_lightning_quotes q JOIN onboarding_intents i ON i.id=q.intent_id JOIN flightdeck_pg_actors a ON a.id=i.owner_actor_id WHERE q.id=${quoteId} AND q.intent_id=${intentId} AND a.npub=${ownerNpub}`;
  if (!q) throw new HostingError(404, 'quote_not_found');
  return q;
}

/** Hold resolution for cancel/release. Unverifiable or unconfigured providers leave the quote unresolved. */
export async function resolveIntentLightningQuotes(intentIds: string[], db: Db = getDb(), providerFactory: () => LightningProvider = lightningProvider) {
  if (!intentIds.length) return { unresolved: 0 };
  const quotes = await db`SELECT id,state FROM hosting_lightning_quotes WHERE intent_id=ANY(${intentIds}::uuid[]) AND state IN ('issuing','open','late_payment','mismatch')`;
  if (!quotes.length) return { unresolved: 0 };
  let p: LightningProvider;
  try { p = providerFactory(); } catch { return { unresolved: quotes.length }; }
  let unresolved = 0;
  for (const quote of quotes) {
    try {
      if (quote.state === 'issuing') await completeIssuance((await db`SELECT * FROM hosting_lightning_quotes WHERE id=${quote.id}`)[0], db, p);
      if (['issuing', 'open', 'late_payment', 'mismatch'].includes((await resolveLightningQuote(quote.id, db, p, undefined, true)).state)) unresolved++;
    } catch { unresolved++; }
  }
  return { unresolved };
}

/** Administrator-triggered reconciliation of open quotes (the future periodic runner calls the same function). */
export async function reconcileOpenLightningQuotes(actorNpub: string, db: Db = getDb(), p: LightningProvider = lightningProvider()) {
  if (!config.adminNpub || actorNpub !== config.adminNpub) throw new HostingError(403, 'platform_admin_required');
  const quotes = await db`SELECT id FROM hosting_lightning_quotes WHERE state IN ('open','late_payment','mismatch') ORDER BY created_at LIMIT 100`;
  const out: Record<string, number> = {};
  for (const q of quotes) { try { const r = await resolveLightningQuote(q.id, db, p); out[r.state] = (out[r.state] ?? 0) + 1; } catch { out.error = (out.error ?? 0) + 1; } }
  return { checked: quotes.length, states: out };
}

// ---- Support-assisted refund to a verified customer invoice --------------------------------------------------------

/** A payout rate older than this is not a current provider conversion and cannot bound the refunded sats. */
export const REFUND_RATE_MAX_AGE_MS = 300_000;
const isTime = (v: unknown) => typeof v === 'string' && v !== '' && !Number.isNaN(new Date(v).getTime());
type Decoded = Awaited<ReturnType<NonNullable<LightningProvider['payouts']>['decodeInvoice']>>;
type PayoutQuote = Awaited<ReturnType<NonNullable<LightningProvider['payouts']>['quoteSats']>>;
/** Shape of the provider's decode of the customer invoice. Anything unparseable (NaN expiry, non-positive or unsafe sats, bad hash,
 * missing or our own payee) is refused before any funds are withheld. */
function invoiceIsWellFormed(d: Decoded, p: LightningProvider) {
  return !!d && HASH.test(d.paymentHash as string) && Number.isSafeInteger(d.amountSats) && (d.amountSats as number) >= 1 && isTime(d.expiresAt)
    && typeof d.payeeRef === 'string' && d.payeeRef !== '' && d.payeeRef !== p.payeeRef;
}
/** The provider's own current USD to sats conversion must be positive, identified (source) and fresh, never from the future. */
function payoutQuoteIsCurrent(q: PayoutQuote, now: Date) {
  if (!q || !Number.isSafeInteger(q.sats) || q.sats < 1 || !q.rate || typeof q.rate.source !== 'string' || !q.rate.source.trim()
    || (q.rate.ref !== undefined && typeof q.rate.ref !== 'string') || !isTime(q.rate.quotedAt)) return false;
  const age = now.getTime() - new Date(q.rate.quotedAt).getTime();
  return age >= 0 && age <= REFUND_RATE_MAX_AGE_MS;
}

/** Funds are withheld first (bounded by the payment's remaining amount and unreserved paid balance), then the provider pays the
 * customer's invoice. The sat amount may not exceed the provider's own current conversion of the refunded USD. The customer invoice's
 * payment hash is claimed globally and durably inside the same transaction as the hold, before any payout is attempted. */
export async function requestLightningRefund(body: unknown, actorNpub: string, db: Db = getDb(), p: LightningProvider = lightningProvider(), now: () => Date = () => new Date()) {
  if (!config.adminNpub || actorNpub !== config.adminNpub) throw new HostingError(403, 'platform_admin_required');
  const b = body as any;
  if (!b || Object.keys(b).sort().join(',') !== 'amount_cents,customer_verified,idempotency_key,invoice,reason,settlement_id' || b.customer_verified !== true || !Number.isSafeInteger(b.amount_cents) || b.amount_cents < 1
    || typeof b.idempotency_key !== 'string' || !KEY.test(b.idempotency_key) || typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 500
    || typeof b.invoice !== 'string' || b.invoice.length < 20 || b.invoice.length > 4000 || typeof b.settlement_id !== 'string' || !UUID.test(b.settlement_id)) throw new HostingError(400, 'invalid_refund');
  if (missingFundingReserves().length) throw new HostingError(503, 'refund_reserves_unregistered');
  const payouts = p.payouts;
  if (!payouts) throw new HostingError(503, 'lightning_refund_unavailable');
  const [peek] = await db`SELECT * FROM hosting_funding_settlements WHERE id=${b.settlement_id}`;
  if (!peek || peek.method !== 'lightning') throw new HostingError(404, 'settlement_not_found');
  const decoded = await payouts.decodeInvoice(b.invoice);
  if (!invoiceIsWellFormed(decoded, p) || decoded.paymentHash === peek.provider_ref) throw new HostingError(409, 'refund_invoice_invalid');
  // A replay of an already-held request resolves that hold (its invoice may legitimately have expired since); only a new hold needs a live invoice and rate.
  const [replay] = await db`SELECT 1 FROM hosting_funding_adjustments WHERE account_id=${peek.account_id} AND request_key=${b.idempotency_key}`;
  let ceiling: PayoutQuote | null = null;
  if (!replay) {
    ceiling = await payouts.quoteSats(b.amount_cents);
    if (!payoutQuoteIsCurrent(ceiling, now())) throw new HostingError(502, 'refund_quote_invalid');
    if (new Date(decoded.expiresAt).getTime() <= now().getTime() || (decoded.amountSats as number) > ceiling.sats) throw new HostingError(409, 'refund_invoice_invalid');
  }
  const held = await db.begin(async transaction => {
    const tx = transaction as unknown as Db;
    await tx`SELECT id FROM hosting_accounts WHERE id=${peek.account_id} FOR UPDATE`;
    const [existing] = await tx`SELECT * FROM hosting_funding_adjustments WHERE account_id=${peek.account_id} AND request_key=${b.idempotency_key}`;
    if (existing) {
      if (existing.settlement_id !== peek.id || existing.amount_cents !== b.amount_cents || existing.reason !== b.reason || existing.evidence?.payment_hash !== decoded.paymentHash) throw new HostingError(409, 'idempotency_conflict');
      return existing;
    }
    if (!ceiling) throw new HostingError(409, 'idempotency_conflict');
    const [reused] = await tx`SELECT 1 FROM hosting_funding_adjustments WHERE provider_ref=${`ln:${decoded.paymentHash}`}
      UNION ALL SELECT 1 FROM hosting_lightning_quotes WHERE payment_hash=${decoded.paymentHash}`;
    if (reused) throw new HostingError(409, 'refund_invoice_invalid');
    const limit = Math.min(await refundableCents(tx, peek), Number((await availableRefundableUnits(tx, peek.account_id)) / UNITS_PER_CENT));
    if (b.amount_cents > limit) throw new HostingError(409, 'refund_exceeds_available');
    const requestId = crypto.randomUUID();
    // The unique payment-hash claim serialises concurrent requests across accounts and settlements: the loser waits for this
    // transaction, then conflicts here (and rolls back its own hold) without ever reaching the provider.
    const [claim] = await tx`INSERT INTO hosting_lightning_payout_claims(payment_hash,settlement_id,account_id,request_id) VALUES(${decoded.paymentHash},${peek.id},${peek.account_id},${requestId}) ON CONFLICT(payment_hash) DO NOTHING RETURNING payment_hash`;
    if (!claim) throw new HostingError(409, 'refund_invoice_invalid');
    return (await applyAdjustment(tx, peek, { kind: 'refund', providerRef: `req:${requestId}`, requestId, requestKey: b.idempotency_key, state: 'requested', amountCents: b.amount_cents, effectiveCents: b.amount_cents,
      reason: b.reason, actorNpub, evidence: { payment_hash: decoded.paymentHash, amount_sats: decoded.amountSats, rate_source: ceiling.rate.source, rate_quoted_at: ceiling.rate.quotedAt, customer_verified: true } })).adjustment;
  });
  const settle = (state: string, effective: number, evidence: Record<string, unknown>) => db.begin(async transaction => {
    const tx = transaction as unknown as Db;
    return (await applyAdjustment(tx, peek, { kind: 'refund', providerRef: `ln:${decoded.paymentHash}`, requestId: held.request_id, state, amountCents: held.amount_cents, effectiveCents: effective, reason: `Lightning refund ${state}`, actorNpub, evidence: { ...held.evidence, ...evidence } })).adjustment;
  });
  const view = (a: any) => ({ adjustment_id: a.id as string, settlement_id: a.settlement_id as string, kind: a.kind as string, state: a.state as string, amount_cents: a.amount_cents as number, effective_cents: a.effective_cents as number, provider_ref: a.provider_ref as string });
  if (['succeeded', 'failed'].includes(held.state)) return view(held);
  let result: Awaited<ReturnType<NonNullable<LightningProvider['payouts']>['pay']>>;
  try {
    result = held.state === 'pending' ? await payouts.lookupPayment(decoded.paymentHash) : await payouts.pay({ bolt11: b.invoice, orderRef: held.request_id });
  } catch { throw new HostingError(502, 'refund_outcome_unknown'); }
  if (result.status === 'succeeded') {
    // Success is only believed with the preimage that hashes to the customer invoice's payment hash.
    if (!preimageMatches(result.preimage, decoded.paymentHash)) return view(await settle('pending', held.amount_cents, { note: 'success_without_valid_preimage' }));
    return view(await settle('succeeded', held.amount_cents, { preimage: result.preimage }));
  }
  if (result.status === 'failed') return view(await settle('failed', 0, {}));
  return view(await settle('pending', held.amount_cents, {}));
}
