import type { getDb } from '../db';
import { HostingError } from './hosting-billing';
import { quoteView } from './hosting-lightning';

type Db = ReturnType<typeof getDb>;
export type AttemptMethod = 'card' | 'lightning';
/** A Lightning quote is outstanding until the provider verified it settled, expired or cancelled; `issuing` counts, unknown never releases. */
export const OUTSTANDING_QUOTE_STATES = ['issuing', 'open', 'late_payment', 'mismatch'];
export type OutstandingAttempt = { method: AttemptMethod; row: any };

/** Every payable attempt of one onboarding intent that is not provider-verified terminal. Plain reads: callers that must serialize hold the
 * account then intent locks first, and these reads never lock order/quote rows (settlement locks those before the account). */
export async function outstandingAttempts(intentId: string, sql: Db): Promise<OutstandingAttempt[]> {
  const orders = await sql`SELECT * FROM hosting_checkout_orders WHERE intent_id=${intentId} AND fulfilled_at IS NULL AND terminal_at IS NULL ORDER BY created_at,id`;
  const quotes = await sql`SELECT * FROM hosting_lightning_quotes WHERE intent_id=${intentId} AND state IN ('issuing','open','late_payment','mismatch') ORDER BY created_at,id`;
  return [...orders.map(row => ({ method: 'card' as const, row })), ...quotes.map(row => ({ method: 'lightning' as const, row }))];
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
/** Owner-only, additive intent field. Carries ids and quote state only: no idempotency key, session secret or provider credential. */
export function paymentAttemptDto(attempts: OutstandingAttempt[]) {
  if (!attempts.length) return null;
  if (attempts.length > 1) {
    return { method: null, state: 'ambiguous' as const, resume: 'support' as const, order_id: null, quote_id: null, amount_cents: null, created_at: iso(attempts[0]!.row.created_at), quote: null, count: attempts.length };
  }
  const { method, row } = attempts[0]!;
  if (method === 'card') {
    return { method, state: (row.session_id ? 'open' : 'issuing') as 'open' | 'issuing', resume: 'checkout' as const, order_id: row.id as string, quote_id: null, amount_cents: row.amount_cents as number, created_at: iso(row.created_at), quote: null, count: 1 };
  }
  return {
    method, state: (row.state === 'issuing' ? 'issuing' : row.state === 'open' ? 'open' : 'needs_support') as 'issuing' | 'open' | 'needs_support',
    resume: (row.state === 'issuing' || row.state === 'open' ? 'lightning_quote' : 'support') as 'lightning_quote' | 'support',
    order_id: null, quote_id: row.id as string, amount_cents: row.amount_cents as number, created_at: iso(row.created_at), quote: quoteView(row), count: 1,
  };
}
export type PaymentAttemptView = ReturnType<typeof paymentAttemptDto>;
export async function paymentAttemptView(intentId: string, sql: Db) { return paymentAttemptDto(await outstandingAttempts(intentId, sql)); }

/** The single canonical attempt a request for `method` may reuse, or null when a new one may be created. Another method outstanding,
 * or ambiguous legacy rows, is refused here, before any provider call. */
export function reusableAttempt(attempts: OutstandingAttempt[], method: AttemptMethod): OutstandingAttempt | null {
  if (!attempts.length) return null;
  const dto = paymentAttemptDto(attempts);
  if (attempts.length > 1) throw new HostingError(409, 'payment_attempt_ambiguous', { payment_attempt: dto });
  if (attempts[0]!.method !== method) throw new HostingError(409, 'payment_attempt_outstanding', { payment_attempt: dto });
  return attempts[0]!;
}
