import { Hono } from 'hono';
import { requireNip98AuthResolved, verifyStrictNip98Mutation } from '../auth';
import { config } from '../config';
import { HostingError } from '../services/hosting-billing';
import {
  appendAgentTariff, clearAgentSpendBlock, createAgentGrant, dispatchAgentHold, listAgentGrants, listAgentTariffs, markAgentHoldPending,
  readAgentHold, releaseAgentHold, reserveAgentHold, revokeAgentGrant, settleAgentHold,
} from '../services/hosting-agent-holds';

/** Paid agent holds. Runtime-service routes accept only an allowlisted service key signing directly; payer routes the account owner directly. */
export const agentHoldsRouter = new Hono();
async function mutation(c: any, maxBytes = 8192) {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new HostingError(400, 'body_too_large');
  const proof = await verifyStrictNip98Mutation(c.req.header('authorization') ?? null, c.req.raw, raw);
  if (!proof.ok) throw new HostingError(401, proof.reasonCode);
  // No workspace-key delegation: the signing key itself is the identity that is authorized.
  if (proof.userNpub !== proof.signerNpub) throw new HostingError(403, 'direct_signature_required');
  let body: any = {};
  if (raw.length) { try { body = JSON.parse(raw); } catch { throw new HostingError(400, 'invalid_json'); } }
  return { actor: proof.signerNpub as string, body };
}
async function reader(c: any) {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) throw new HostingError(401, 'nip98_auth_required');
  if (auth.userNpub !== auth.signerNpub) throw new HostingError(403, 'direct_signature_required');
  return auth.signerNpub as string;
}
const guard = (handler: (c: any) => Promise<Response>) => async (c: any) => {
  c.header('Cache-Control', 'private, no-store');
  try { return await handler(c); }
  catch (e) { if (e instanceof HostingError) return c.json({ code: e.code, error: e.message }, e.status as any); throw e; }
};
const admin = (npub: string) => { if (!config.adminNpub || npub !== config.adminNpub) throw new HostingError(403, 'platform_admin_required'); return npub; };

agentHoldsRouter.get('/tariffs', guard(async c => { await reader(c); return c.json({ tariffs: await listAgentTariffs() }); }));
agentHoldsRouter.post('/tariffs', guard(async c => { const { actor, body } = await mutation(c, 65536); const r = await appendAgentTariff(admin(actor), body); return c.json(r, r.created ? 201 : 200); }));
agentHoldsRouter.post('/blocks/:accountId/clear', guard(async c => { const { actor } = await mutation(c); return c.json(await clearAgentSpendBlock(admin(actor), c.req.param('accountId'))); }));

agentHoldsRouter.post('/grants', guard(async c => { const { actor, body } = await mutation(c); const r = await createAgentGrant(actor, body); return c.json(r, r.replayed ? 200 : 201); }));
agentHoldsRouter.get('/grants', guard(async c => c.json({ grants: await listAgentGrants(await reader(c)) })));
agentHoldsRouter.post('/grants/:grantId/revoke', guard(async c => { const { actor } = await mutation(c); return c.json(await revokeAgentGrant(actor, c.req.param('grantId'))); }));

agentHoldsRouter.post('/holds/reserve', guard(async c => { const { actor, body } = await mutation(c); const r = await reserveAgentHold(actor, body); return c.json(r.hold, r.replayed ? 200 : 201); }));
agentHoldsRouter.post('/holds/dispatch', guard(async c => { const { actor, body } = await mutation(c); return c.json((await dispatchAgentHold(actor, body)).hold); }));
agentHoldsRouter.post('/holds/pending', guard(async c => { const { actor, body } = await mutation(c); return c.json((await markAgentHoldPending(actor, body)).hold); }));
agentHoldsRouter.post('/holds/release', guard(async c => { const { actor, body } = await mutation(c); return c.json((await releaseAgentHold(actor, body)).hold); }));
agentHoldsRouter.post('/holds/settle', guard(async c => { const { actor, body } = await mutation(c); return c.json((await settleAgentHold(actor, body)).hold); }));
agentHoldsRouter.get('/holds', guard(async c => c.json((await readAgentHold(await reader(c), { account_id: c.req.query('account_id'), call_id: c.req.query('call_id'), hold_id: c.req.query('hold_id') })).hold)));
