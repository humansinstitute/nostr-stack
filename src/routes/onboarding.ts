import { Hono } from 'hono';
import { requireNip98AuthResolved, verifyStrictNip98Mutation } from '../auth';
import { HostingError } from '../services/hosting-billing';
import { createHostingCheckout } from '../services/hosting-stripe';
import {
  cancelIntent, createAgentOffer, createIntent, createInvite, intentForCheckout, inviteAvailability, listAgentOffers, listIntents, listInvites,
  openOwnerAccount, provisionIntent, readIntent, readOwnerAccount, releaseInviteSeat, revokeInvite, updateIntent,
} from '../services/onboarding';

/** Invited onboarding. Human, direct-signature routes only; none are reachable by agent bindings. */
export const onboardingRouter = new Hono();
async function mutation(c: any, maxBytes = 4096) {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new HostingError(400, 'body_too_large');
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
  catch (e) { if (e instanceof HostingError) return c.json({ code: e.code, error: e.message }, e.status as any); throw e; }
};

onboardingRouter.get('/invites/:code', guard(async c => c.json(await inviteAvailability(c.req.param('code')))));
onboardingRouter.get('/account', guard(async c => c.json({ account: await readOwnerAccount(await reader(c)) })));
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
  return c.json(await createHostingCheckout(target.accountId, { amount_cents: target.amountCents, ...body }, undefined, undefined, { intentId: target.intentId }), 201);
}));
onboardingRouter.post('/intents/:id/provision', guard(async c => {
  const { actor } = await mutation(c);
  return c.json({ intent: await provisionIntent(c.req.param('id'), actor) });
}));

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
