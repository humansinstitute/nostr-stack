import { Hono } from 'hono';
import { requireNip98AuthResolved, verifyStrictNip98Mutation } from '../auth';
import { HostingError } from '../services/hosting-billing';
import { readBoundedText } from '../http-body';
import { approvedCheckoutReturnUrls, createHostingCheckout, requestStripeRefund } from '../services/hosting-stripe';
import { fundingReversalSummary } from '../services/hosting-funding';
import { issueLightningQuoteResult, readLightningQuote, reconcileOpenLightningQuotes, reconcileReceiverBindingFeed, requestLightningRefund, resolveLightningQuote } from '../services/hosting-lightning';
import { getDb } from '../db';
import { ONBOARDING_MAX_FUNDING_CENTS, ONBOARDING_MIN_FUNDING_CENTS } from '../services/onboarding';
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS } from '../services/hosting-topup-limits';
import { createTopupCheckout, issueTopupQuote, listTopups, refreshTopupQuote } from '../services/hosting-topup';
import { providerAvailability } from '../services/hosting-account-admin';
import { accountStorageSummary } from '../services/hosting-storage';
import { accountLifecycle, acknowledgeLifecycleNotice, evaluateLifecycleNotices, listLifecycleNotices } from '../services/hosting-lifecycle';
import {
  cancelIntent, createAgentOffer, createIntent, createInvite, intentForCheckout, inviteAvailability, listAgentOffers, listIntents, listInvites,
  openOwnerAccount, provisionIntent, readIntent, readOwnerAccount, releaseInviteSeat, releasePaymentAttempt, revokeInvite, updateIntent,
} from '../services/onboarding';

/** Invited onboarding. Human, direct-signature routes only; none are reachable by agent bindings. */
export const onboardingRouter = new Hono();
async function mutation(c: any, maxBytes = 4096) {
  const raw = await readBoundedText(c.req.raw, maxBytes);
  const proof = await verifyStrictNip98Mutation(c.req.header('authorization') ?? null, c.req.raw, raw);
  if (!proof.ok) throw new HostingError(401, proof.reasonCode);
  if (proof.userNpub !== proof.signerNpub) throw new HostingError(403, 'direct_user_signature_required');
  let body: any = {};
  if (raw.length) { try { body = JSON.parse(raw); } catch { throw new HostingError(400, 'invalid_json'); } }
  return { actor: proof.userNpub as string, body };
}
async function reader(c: any) {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) throw new HostingError(401, 'nip98_auth_required');
  return auth.userNpub as string;
}
const guard = (handler: (c: any) => Promise<Response>) => async (c: any) => {
  c.header('Cache-Control', 'private, no-store');
  try { return await handler(c); }
  catch (e) { if (e instanceof HostingError) return c.json({ ...(e.detail ?? {}), code: e.code, error: e.message }, e.status as any); throw e; }
};

onboardingRouter.get('/invites/:code', guard(async c => c.json(await inviteAvailability(c.req.param('code')))));
/** What this deployment can actually do right now, for client gating. Operator configuration only: no secrets and nothing a client can alter. */
onboardingRouter.get('/config', guard(async c => {
  await reader(c);
  const providers = providerAvailability();
  return c.json({
    version: 1, onboarding_enabled: providers.onboarding_enabled,
    funding: { min_cents: ONBOARDING_MIN_FUNDING_CENTS, max_cents: ONBOARDING_MAX_FUNDING_CENTS, topup_min_cents: TOPUP_MIN_CENTS, topup_max_cents: TOPUP_MAX_CENTS },
    card: { ...providers.card, return_urls: approvedCheckoutReturnUrls() },
    lightning: providers.lightning,
  });
}));
onboardingRouter.get('/account', guard(async c => {
  const account = await readOwnerAccount(await reader(c));
  return c.json({ account, funding: account ? await fundingReversalSummary(getDb(), account.account_id) : null, storage: account ? await accountStorageSummary(getDb(), account.account_id) : null,
    lifecycle: account ? await accountLifecycle(getDb(), account.account_id) : null });
}));
onboardingRouter.post('/account', guard(async c => { const { actor } = await mutation(c); return c.json({ account: await openOwnerAccount(actor) }); }));
onboardingRouter.get('/agent-offers', guard(async c => { await reader(c); return c.json({ offers: await listAgentOffers() }); }));
onboardingRouter.get('/intents', guard(async c => c.json({ intents: await listIntents(await reader(c)) })));
onboardingRouter.post('/intents', guard(async c => {
  const { actor, body } = await mutation(c);
  const result = await createIntent(actor, body);
  return c.json(result, result.replayed ? 200 : 201);
}));
onboardingRouter.get('/intents/:id', guard(async c => c.json({ intent: await readIntent(c.req.param('id'), await reader(c)) })));
onboardingRouter.post('/intents/:id/options', guard(async c => {
  const { actor, body } = await mutation(c);
  return c.json({ intent: await updateIntent(c.req.param('id'), actor, body) });
}));
onboardingRouter.post('/intents/:id/cancel', guard(async c => {
  const { actor } = await mutation(c);
  return c.json({ intent: await cancelIntent(c.req.param('id'), actor) });
}));
onboardingRouter.post('/intents/:id/checkout', guard(async c => {
  const { actor, body } = await mutation(c);
  if (!body || Object.keys(body).sort().join(',') !== 'idempotency_key,return_url') throw new HostingError(400, 'invalid_checkout');
  const target = await intentForCheckout(c.req.param('id'), actor);
  // Amount is always the intent's server-held figure; the payment is bound to this intent and owner account.
  const checkout = await createHostingCheckout(target.accountId, { amount_cents: target.amountCents, ...body }, undefined, undefined, { intentId: target.intentId });
  return c.json(checkout, (checkout as any).reused ? 200 : 201);
}));
onboardingRouter.post('/intents/:id/lightning/quote', guard(async c => {
  const { actor, body } = await mutation(c);
  const result = await issueLightningQuoteResult(c.req.param('id'), actor, body);
  return c.json(result, result.reused ? 200 : 201);
}));
// Server-side re-poll of the provider for this quote. The caller supplies no settlement evidence; only provider-verified state credits.
onboardingRouter.post('/intents/:id/lightning/quotes/:quoteId/refresh', guard(async c => {
  const { actor } = await mutation(c);
  const row = await readLightningQuote(c.req.param('quoteId'), c.req.param('id'), actor);
  const quote = await resolveLightningQuote(row.id);
  return c.json({ quote, intent: await readIntent(c.req.param('id'), actor) });
}));
onboardingRouter.post('/intents/:id/payment-attempt/release', guard(async c => {
  const { actor } = await mutation(c);
  return c.json({ intent: await releasePaymentAttempt(c.req.param('id'), actor) });
}));
onboardingRouter.post('/intents/:id/provision', guard(async c => {
  const { actor } = await mutation(c);
  return c.json({ intent: await provisionIntent(c.req.param('id'), actor) });
}));

// Read-only recovery state and durable runway/read-only notices (owner only). Informational: nothing here deletes or restores anything.
onboardingRouter.get('/lifecycle', guard(async c => {
  const account = await readOwnerAccount(await reader(c));
  if (!account) throw new HostingError(404, 'account_not_found');
  await evaluateLifecycleNotices(getDb(), account.account_id);
  return c.json({ lifecycle: await accountLifecycle(getDb(), account.account_id), notices: await listLifecycleNotices(getDb(), account.account_id) });
}));
onboardingRouter.post('/lifecycle/notices/:id/acknowledge', guard(async c => {
  const { actor } = await mutation(c);
  const account = await readOwnerAccount(actor);
  if (!account) throw new HostingError(404, 'account_not_found');
  return c.json({ notice: await acknowledgeLifecycleNotice(getDb(), account.account_id, c.req.param('id')) });
}));

// Repeat account top-ups after provisioning. Account-level credit only: no intent, workspace, seat or introduction is created.
onboardingRouter.get('/topups', guard(async c => c.json(await listTopups(await reader(c)))));
onboardingRouter.post('/topups/checkout', guard(async c => { const { actor, body } = await mutation(c); return c.json(await createTopupCheckout(actor, body), 201); }));
onboardingRouter.post('/topups/lightning/quote', guard(async c => { const { actor, body } = await mutation(c); return c.json({ quote: await issueTopupQuote(actor, body) }, 201); }));
onboardingRouter.post('/topups/lightning/quotes/:quoteId/refresh', guard(async c => { const { actor } = await mutation(c); return c.json({ quote: await refreshTopupQuote(actor, c.req.param('quoteId')) }); }));

// Platform-administrator invitation and offer management.
onboardingRouter.get('/admin/invites', guard(async c => c.json({ invites: await listInvites(await reader(c)) })));
onboardingRouter.post('/admin/invites', guard(async c => { const { actor, body } = await mutation(c); return c.json(await createInvite(body, actor), 201); }));
onboardingRouter.post('/admin/invites/:id/revoke', guard(async c => { const { actor } = await mutation(c); return c.json(await revokeInvite(c.req.param('id'), actor)); }));
onboardingRouter.post('/admin/invites/:id/release-seat', guard(async c => {
  const { actor, body } = await mutation(c);
  if (!body || Object.keys(body).join(',') !== 'owner_npub' || typeof body.owner_npub !== 'string') throw new HostingError(400, 'invalid_body');
  return c.json(await releaseInviteSeat(c.req.param('id'), body.owner_npub, actor));
}));
onboardingRouter.post('/admin/agent-offers', guard(async c => { const { actor, body } = await mutation(c); return c.json({ offer: await createAgentOffer(body, actor) }, 201); }));
onboardingRouter.post('/admin/refunds', guard(async c => { const { actor, body } = await mutation(c); return c.json({ refund: await requestStripeRefund(body, actor) }, 201); }));
onboardingRouter.post('/admin/lightning/receiver/bindings/reconcile', guard(async c => { const { actor } = await mutation(c); return c.json(await reconcileReceiverBindingFeed(actor)); }));
onboardingRouter.post('/admin/lightning/reconcile', guard(async c => { const { actor } = await mutation(c); return c.json(await reconcileOpenLightningQuotes(actor)); }));
onboardingRouter.post('/admin/lightning-refunds', guard(async c => { const { actor, body } = await mutation(c, 8192); return c.json({ refund: await requestLightningRefund(body, actor) }, 201); }));
