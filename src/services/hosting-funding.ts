import { getDb } from '../db';
import { centsUnits, lockedAccount, HostingError } from './hosting-billing';

type Db = ReturnType<typeof getDb>;
export type FundingMethod = 'stripe' | 'lightning';
export type AdjustmentKind = 'refund' | 'dispute';
export const UNITS_PER_CENT = centsUnits(1);
const big = (v: unknown) => BigInt(v as string);

/** Method-neutral credit binding. Every funding method ends here: one immutable settlement, one ledger credit.
 * Must run inside the caller's transaction after provider evidence has been verified against the order. */
export async function recordSettlement(sql: Db, input: {
  accountId: string; method: FundingMethod; providerRef: string; orderId: string; intentId: string | null;
  amountCents: number; ledgerKind: 'stripe' | 'lightning'; reason: string; evidence: Record<string, unknown>;
}) {
  const a = await lockedAccount(input.accountId, sql);
  const [prior] = await sql`SELECT * FROM hosting_funding_settlements WHERE method=${input.method} AND (provider_ref=${input.providerRef} OR order_id=${input.orderId})`;
  if (prior) {
    // A provider payment reference and an order are bound to each other exactly once.
    if (prior.provider_ref !== input.providerRef || prior.order_id !== input.orderId || prior.account_id !== input.accountId || prior.amount_cents !== input.amountCents) throw new HostingError(409, 'settlement_binding_conflict');
    return { settlement: prior, credited: false };
  }
  const units = centsUnits(input.amountCents), paid = big(a.paid_units) + units, ledgerKey = `${input.method === 'stripe' ? 'stripe' : 'lightning'}:${input.providerRef}`;
  const [settlement] = await sql`INSERT INTO hosting_funding_settlements(account_id,method,provider_ref,order_id,intent_id,currency,amount_cents,amount_units,ledger_key,evidence)
    VALUES(${input.accountId},${input.method},${input.providerRef},${input.orderId},${input.intentId},'USD',${input.amountCents},${units.toString()},${ledgerKey},${sql.json(input.evidence as any)}) RETURNING *`;
  await sql`UPDATE hosting_accounts SET paid_units=${paid.toString()},depleted_at=CASE WHEN ${paid.toString()}::numeric+promo_units>0 THEN NULL ELSE depleted_at END WHERE id=${input.accountId}`;
  await sql`INSERT INTO hosting_ledger(account_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason,metadata)
    VALUES(${input.accountId},${input.ledgerKind},${units.toString()},${paid.toString()},${a.promo_units},${ledgerKey},${input.reason},${sql.json({ ...input.evidence, settlement_id: settlement!.id } as any)})`;
  return { settlement: settlement!, credited: true };
}

export type DesiredAdjustment = {
  kind: AdjustmentKind; providerRef: string; requestId?: string | null; requestKey?: string | null; state: string;
  amountCents: number; effectiveCents: number; reason?: string | null; actorNpub?: string | null; evidence: Record<string, unknown>;
};

/** Converges one provider refund/dispute onto the ledger from its authoritative state.
 * Idempotent: only the delta between the effect already applied and the desired effect is written, once, under the account lock.
 * Debits may exceed the paid balance; the shortfall is recorded as uncovered (debt) and the account is blocked rather than the debit dropped. */
export async function applyAdjustment(sql: Db, settlement: any, d: DesiredAdjustment) {
  const a = await lockedAccount(settlement.account_id, sql);
  if (!Number.isSafeInteger(d.effectiveCents) || d.effectiveCents < 0 || d.effectiveCents > d.amountCents) throw new HostingError(502, 'adjustment_amount_invalid');
  let adj = d.requestId ? (await sql`SELECT * FROM hosting_funding_adjustments WHERE request_id=${d.requestId} FOR UPDATE`)[0] : undefined;
  if (!adj) adj = (await sql`SELECT * FROM hosting_funding_adjustments WHERE settlement_id=${settlement.id} AND kind=${d.kind} AND provider_ref=${d.providerRef} FOR UPDATE`)[0];
  if (!adj) {
    [adj] = await sql`INSERT INTO hosting_funding_adjustments(settlement_id,account_id,kind,provider_ref,request_id,request_key,state,amount_cents,reason,actor_npub,evidence)
      VALUES(${settlement.id},${settlement.account_id},${d.kind},${d.providerRef},${d.requestId ?? null},${d.requestKey ?? null},${d.state},${d.amountCents},${d.reason ?? null},${d.actorNpub ?? null},${sql.json(d.evidence as any)}) RETURNING *`;
  } else if (adj.settlement_id !== settlement.id) throw new HostingError(409, 'settlement_binding_conflict');
  const target = centsUnits(d.effectiveCents), delta = target - big(adj!.applied_units);
  let paid = big(a.paid_units), uncovered = big(adj!.uncovered_units);
  if (delta > 0n) { const free = paid > 0n ? paid : 0n; uncovered += delta > free ? delta - free : 0n; paid -= delta; }
  else if (delta < 0n) { const restore = -delta, repay = uncovered < restore ? uncovered : restore; uncovered -= repay; paid += restore; }
  if (delta !== 0n) {
    const promo = big(a.promo_units);
    await sql`UPDATE hosting_accounts SET paid_units=${paid.toString()},
      depleted_at=CASE WHEN ${paid.toString()}::numeric+promo_units<=0 THEN COALESCE(depleted_at,now()) ELSE NULL END WHERE id=${a.id}`;
    await sql`INSERT INTO hosting_ledger(account_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason,actor_npub,metadata)
      VALUES(${a.id},${d.kind},${(-delta).toString()},${paid.toString()},${promo.toString()},${`adj:${adj!.id}:${adj!.seq + 1}`},
        ${d.reason ?? `${d.kind} ${d.state}`},${d.actorNpub ?? null},${sql.json({ settlement_id: settlement.id, provider_ref: d.providerRef, state: d.state, effective_cents: d.effectiveCents, uncovered_units: uncovered.toString() } as any)})`;
  }
  const [row] = await sql`UPDATE hosting_funding_adjustments SET provider_ref=${d.providerRef},state=${d.state},effective_cents=${d.effectiveCents},applied_units=${target.toString()},
    uncovered_units=${uncovered.toString()},seq=seq+${delta === 0n ? 0 : 1},evidence=${sql.json(d.evidence as any)},updated_at=now() WHERE id=${adj!.id} RETURNING *`;
  return { adjustment: row!, delta };
}

/** Funds reserved against purchased credit (storage runway, agent holds). Later slices register their reserve here; nothing is reserved today. */
export type ReserveSource = (sql: Db, accountId: string) => Promise<bigint>;
const reserveSources: ReserveSource[] = [];
export function registerFundingReserve(source: ReserveSource) { reserveSources.push(source); return () => { const i = reserveSources.indexOf(source); if (i >= 0) reserveSources.splice(i, 1); }; }
/** Support refunds stay gated until at least one real reserve (storage runway, agent holds) participates. */
export const hasFundingReserves = () => reserveSources.length > 0;

/** Purchased credit that may leave the account: positive paid balance minus every registered reserve. Promotional credit is never refundable. */
export async function availableRefundableUnits(sql: Db, accountId: string, extra: ReserveSource[] = []) {
  const [a] = await sql`SELECT paid_units FROM hosting_accounts WHERE id=${accountId}`;
  let free = big(a!.paid_units);
  for (const source of [...reserveSources, ...extra]) free -= await source(sql, accountId);
  return free > 0n ? free : 0n;
}

/** Cents of a settlement still reversible: its amount minus every effective refund/dispute effect. */
export async function refundableCents(sql: Db, settlement: any) {
  const [r] = await sql`SELECT COALESCE(sum(effective_cents),0)::int AS reversed FROM hosting_funding_adjustments WHERE settlement_id=${settlement.id}`;
  return Math.max(0, settlement.amount_cents - (r!.reversed as number));
}

/** Settlement net of provider reversals: what actually remains funded. */
export async function netFundedCents(sql: Db, settlementId: string) {
  const [r] = await sql`SELECT s.amount_cents - COALESCE((SELECT sum(effective_cents) FROM hosting_funding_adjustments WHERE settlement_id=s.id),0)::int AS net FROM hosting_funding_settlements s WHERE s.id=${settlementId}`;
  return r ? (r.net as number) : 0;
}

export async function recordFundingEvent(sql: Db, method: FundingMethod, eventId: string, eventType: string, settlementId: string | null, outcome: string) {
  await sql`INSERT INTO hosting_funding_events(method,provider_event_id,event_type,settlement_id,outcome) VALUES(${method},${eventId},${eventType},${settlementId},${outcome}) ON CONFLICT(method,provider_event_id) DO NOTHING`;
}

/** Owner-visible reversal summary; reversals are explicit ledger-backed events, never silent. */
export async function fundingReversalSummary(sql: Db, accountId: string) {
  const rows = await sql`SELECT kind,state,provider_ref,amount_cents,effective_cents,uncovered_units,created_at,updated_at FROM hosting_funding_adjustments WHERE account_id=${accountId} ORDER BY created_at DESC LIMIT 100`;
  const [a] = await sql`SELECT paid_units FROM hosting_accounts WHERE id=${accountId}`;
  const paid = big(a!.paid_units);
  return {
    reversal_debt_units: (paid < 0n ? -paid : 0n).toString(),
    open_cents: rows.filter(r => ['requested', 'pending', 'needs_response', 'under_review'].includes(r.state)).reduce((s, r) => s + (r.effective_cents as number), 0),
    adjustments: rows.map(r => ({ kind: r.kind as string, state: r.state as string, provider_ref: r.provider_ref as string, amount_cents: r.amount_cents as number, effective_cents: r.effective_cents as number, uncovered_units: r.uncovered_units as string, updated_at: r.updated_at as string })),
  };
}
