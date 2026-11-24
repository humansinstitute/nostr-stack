import { getDb } from '../db';
import { HostingError, unitsUsd } from './hosting-billing';
import { createHostingCheckout, hostingStripeClient } from './hosting-stripe';
import { issueTopupLightningQuote, lightningProvider, readTopupLightningQuote, resolveLightningQuote, type LightningProvider } from './hosting-lightning';
import { requireOnboardingEnabled } from './onboarding';

type Db = ReturnType<typeof getDb>;
/** The owner's shared USD account, but only once it backs a provisioned workspace. Top-ups never create an intent, workspace,
 * introduction or any other resource: a verified payment is one settlement and one ledger credit on this account. */
export async function ownerTopupAccount(ownerNpub: string, db: Db = getDb()) {
  const [account] = await db`SELECT a.id FROM hosting_accounts a JOIN flightdeck_pg_actors o ON o.id=a.owner_actor_id WHERE o.npub=${ownerNpub}`;
  if (!account) throw new HostingError(404, 'account_not_found');
  const [linked] = await db`SELECT 1 FROM hosting_workspace_accounts WHERE account_id=${account.id} LIMIT 1`;
  if (!linked) throw new HostingError(409, 'account_not_provisioned');
  return account.id as string;
}

/** Stripe Checkout for a repeat top-up. Amount and account are server-bound; fulfilment is the shared verified-payment path. */
export async function createTopupCheckout(ownerNpub: string, body: unknown, db: Db = getDb(), client?: ReturnType<typeof hostingStripeClient>) {
  requireOnboardingEnabled();
  const accountId = await ownerTopupAccount(ownerNpub, db);
  return createHostingCheckout(accountId, body, db, client ?? hostingStripeClient(), { topup: true });
}
export async function issueTopupQuote(ownerNpub: string, body: unknown, db: Db = getDb(), p: LightningProvider = lightningProvider()) {
  requireOnboardingEnabled();
  return issueTopupLightningQuote(await ownerTopupAccount(ownerNpub, db), body, db, p);
}
/** Server-side re-poll of the provider for the owner's own top-up quote; only provider-verified state credits. */
export async function refreshTopupQuote(ownerNpub: string, quoteId: string, db: Db = getDb(), p: LightningProvider = lightningProvider()) {
  const quote = await readTopupLightningQuote(quoteId, await ownerTopupAccount(ownerNpub, db), db);
  return resolveLightningQuote(quote.id, db, p);
}

/** Owner view: what has been credited by top-ups and what is still waiting on a provider. */
export async function listTopups(ownerNpub: string, db: Db = getDb()) {
  const accountId = await ownerTopupAccount(ownerNpub, db);
  const settlements = await db`SELECT id,method,amount_cents,amount_units,settled_at FROM hosting_funding_settlements WHERE account_id=${accountId} AND intent_id IS NULL ORDER BY settled_at DESC,id LIMIT 50`;
  const quotes = await db`SELECT id,state,amount_cents,amount_sats,invoice,payment_hash,expires_at,rate_source,rate_quoted_at FROM hosting_lightning_quotes WHERE account_id=${accountId} AND intent_id IS NULL AND state IN ('open','late_payment','mismatch') ORDER BY created_at DESC LIMIT 20`;
  const orders = await db`SELECT id,amount_cents,created_at FROM hosting_checkout_orders WHERE account_id=${accountId} AND intent_id IS NULL AND fulfilled_at IS NULL AND terminal_at IS NULL ORDER BY created_at DESC LIMIT 20`;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    credited: settlements.map(s => ({ settlement_id: s.id as string, method: s.method as string, amount_cents: s.amount_cents as number, amount_usd: unitsUsd(s.amount_units), settled_at: iso(s.settled_at) })),
    pending_lightning: quotes.map(q => ({ quote_id: q.id as string, state: q.state as string, amount_cents: q.amount_cents as number, amount_sats: q.amount_sats === null ? null : Number(q.amount_sats), invoice: q.invoice as string | null, payment_hash: q.payment_hash as string | null, expires_at: iso(q.expires_at) })),
    pending_checkout: orders.map(o => ({ order_id: o.id as string, amount_cents: o.amount_cents as number, created_at: iso(o.created_at) })),
  };
}
