import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import type Stripe from 'stripe';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { createHostingCheckout, fulfillHostingCheckout } from '../src/services/hosting-stripe';
import { createInvite, createIntent, provisionIntent, readIntent, openOwnerAccount, createAgentOffer, listIntents, updateIntent, cancelIntent, revokeInvite, releaseInviteSeat } from '../src/services/onboarding';
import { USD_UNITS, linkHostedAccount } from '../src/services/hosting-billing';
import { buildOpenApiDocument } from '../src/openapi';

// Runs only against a dedicated disposable PostgreSQL: ONBOARDING_TEST_PORT=<free port>.
const port = Number(process.env.ONBOARDING_TEST_PORT);
const keys = Array.from({ length: 8 }, (_, i) => new Uint8Array(32).fill(120 + i));
const npubs = keys.map(k => nip19.npubEncode(getPublicKey(k)));
const [adminKey, aliceKey, bobKey, carolKey, daveKey, eveKey, frankKey] = keys as Uint8Array[] as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
const [admin, alice, bob, carol, dave, eve, frank] = npubs as [string, string, string, string, string, string, string];
void [adminKey, carolKey, daveKey, eveKey, frankKey];
const app = createApp();
const returnUrl = 'https://example.test/billing';

describe.skipIf(!port || port === 5432)('invited onboarding on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_onboarding_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  const saved = { admin: config.adminNpub, service: config.service.npub };
  let invite: { id: string; code: string };
  let n = 0;
  const key = () => `req-${process.pid}-${++n}-${randomUUID().slice(0, 8)}`;

  async function call(method: 'GET' | 'POST', path: string, signer?: Uint8Array, body?: unknown) {
    const url = `http://localhost/api/v4/onboarding${path}`;
    const raw = body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (signer) {
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(),
        tags: [['u', url], ['method', method], ...(raw ? [['payload', createHash('sha256').update(raw).digest('hex')]] : [])] }, signer);
      headers.Authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
    }
    const response = await app.request(url, { method, headers, body: raw });
    return { status: response.status, json: (await response.json().catch(() => ({}))) as any };
  }
  const body = (workspace: string, extra: Record<string, unknown> = {}) => ({ client_request_key: key(), invite_code: invite.code, workspace_name: workspace, funding_cents: 2100, ...extra });
  const paid = (orderId: string, accountId: string, amount: number, id = `cs_test_${randomUUID()}`, intent = `pi_${randomUUID()}`) =>
    ({ id, mode: 'payment', livemode: false, payment_status: 'paid', currency: 'usd', amount_total: amount, payment_intent: intent, client_reference_id: orderId, metadata: { hosting_order_id: orderId, hosting_account_id: accountId } }) as unknown as Stripe.Checkout.Session;
  /** Test Stripe client double: only the HTTP edge is faked; order binding and fulfilment are production code. */
  const stripeDouble = (id = `cs_test_${randomUUID()}`) => ({ checkout: { sessions: { create: async () => ({ id, url: 'https://checkout.stripe.com/test', livemode: false }), retrieve: async () => ({ id, url: 'https://checkout.stripe.com/test', livemode: false }) } } }) as any;
  async function listIntentsOffer() { return (await db`SELECT id FROM onboarding_agent_offers WHERE active LIMIT 1`)[0]?.id as string | undefined; }
  async function fund(intentId: string, ownerNpub: string, cents?: number) {
    const intent = await readIntent(intentId, ownerNpub, db as any);
    const double = stripeDouble();
    const checkout = await createHostingCheckout(intent.account_id, { amount_cents: cents ?? intent.funding_cents, idempotency_key: key(), return_url: returnUrl }, db as any, double, { intentId });
    const [order] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${checkout.order_id}`;
    const session = paid(order!.id, order!.account_id, order!.amount_cents, (await double.checkout.sessions.retrieve()).id);
    return { order: order!, session };
  }

  beforeAll(async () => {
    process.env.HOSTING_STRIPE_RETURN_URLS = returnUrl;
    process.env.ONBOARDING_ENABLED = 'true';
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    config.adminNpub = admin;
    config.service.npub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(85)));
    invite = await createInvite({ max_admissions: 3, label: 'cap fixture' }, admin, db as any);
  });
  afterAll(async () => { delete process.env.ONBOARDING_ENABLED; config.adminNpub = saved.admin; config.service.npub = saved.service; await closeDb(); });

  test('an authenticated owner account exists before any workspace, with no welcome credit; legacy accounts are untouched', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => openOwnerAccount(alice, db as any)));
    expect(new Set(results.map(r => r.account_id)).size).toBe(1);
    expect(results[0]!.balance_units).toBe('0');
    expect((await db`SELECT * FROM hosting_ledger WHERE account_id=${results[0]!.account_id}`).length).toBe(0);
    expect((await db`SELECT * FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${alice}`).length).toBe(0);
    // Legacy: an account that already received the old welcome grant is returned unchanged.
    const [actor] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${dave},'human') RETURNING id`;
    const [legacy] = await db`INSERT INTO hosting_accounts(owner_actor_id) VALUES(${actor!.id}) RETURNING *`;
    const reopened = await openOwnerAccount(dave, db as any);
    expect(reopened.account_id).toBe(legacy!.id);
    const [after] = await db`SELECT promo_units,paid_units FROM hosting_accounts WHERE id=${legacy!.id}`;
    expect(after!.promo_units).toBe(legacy!.promo_units); expect(after!.paid_units).toBe('0');
  });

  test('HTTP: strict signature, direct signer and owner-only reads; other identities get a neutral 404', async () => {
    expect((await call('GET', '/account')).status).toBe(401);
    expect((await call('POST', '/account')).status).toBe(401);
    const created = await call('POST', '/intents', aliceKey, body('Alice HTTP'));
    expect(created.status).toBe(201);
    const id = created.json.intent.id;
    expect((await call('GET', `/intents/${id}`, aliceKey)).status).toBe(200);
    expect((await call('GET', `/intents/${id}`, bobKey)).status).toBe(404);
    expect((await call('POST', `/intents/${id}/provision`, bobKey)).status).toBe(404);
    expect((await call('POST', `/intents/${id}/options`, bobKey, { expected_revision: 1, workspace_name: 'Hijack' })).status).toBe(404);
    expect((await call('GET', `/intents/${id}`)).status).toBe(401);
    expect((await call('GET', '/intents', bobKey)).json.intents).toEqual([]);
    expect((await call('POST', '/admin/invites', aliceKey, { max_admissions: 5 })).status).toBe(403);
    expect((await call('GET', '/admin/invites', aliceKey)).status).toBe(403);
    expect((await call('GET', `/invites/${invite.code}`)).json).toEqual({ available: true });
    expect(Object.keys((await call('GET', `/invites/${invite.code}`)).json)).toEqual(['available']);
    expect((await call('GET', '/invites/inv_unknown_code_value')).json).toEqual({ available: false });
    expect((await call('POST', `/intents/${id}/provision`, aliceKey)).status).toBe(402);
  });

  test('capped group invite: concurrency and retries never exceed or over-consume capacity', async () => {
    const small = await createInvite({ max_admissions: 2 }, admin, db as any);
    const mk = (who: string, ws: string, k = key()) => createIntent(who, { client_request_key: k, invite_code: small.code, workspace_name: ws, funding_cents: 2100 }, db as any);
    const attempts = await Promise.allSettled([mk(alice, 'Cap A'), mk(bob, 'Cap B'), mk(carol, 'Cap C'), mk(dave, 'Cap D')]);
    expect(attempts.filter(a => a.status === 'fulfilled').length).toBe(2);
    expect(attempts.filter(a => a.status === 'rejected').every(a => (a as PromiseRejectedResult).reason.code === 'invite_full')).toBe(true);
    const winners = [alice, bob, carol, dave].filter((_, i) => attempts[i]!.status === 'fulfilled');
    const k1 = key();
    const first = await createIntent(winners[0]!, { client_request_key: k1, invite_code: small.code, workspace_name: 'Cap Retry', funding_cents: 2100 }, db as any);
    const replay = await Promise.all(Array.from({ length: 6 }, () => createIntent(winners[0]!, { client_request_key: k1, invite_code: small.code, workspace_name: 'Cap Retry', funding_cents: 2100 }, db as any)));
    expect(replay.every(r => r.intent.id === first.intent.id)).toBe(true);
    expect((await createIntent(winners[0]!, { client_request_key: key(), invite_code: small.code, workspace_name: 'Cap Second', funding_cents: 2100 }, db as any)).replayed).toBe(false);
    const [counts] = await db`SELECT count(*)::int AS seats FROM onboarding_invite_seats WHERE invite_id=${small.id} AND status<>'released'`;
    expect(counts!.seats).toBe(2);
    await expect(createIntent(winners[0]!, { client_request_key: k1, invite_code: small.code, workspace_name: 'Different', funding_cents: 2100 }, db as any)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    // Cancelling the only intent releases the seat; the identity's other live intents keep it.
    const loser = [alice, bob, carol, dave].find((_, i) => attempts[i]!.status === 'rejected')!;
    await expect(mk(loser, 'Late Arrival')).rejects.toMatchObject({ code: 'invite_full' });
    const other = winners[1]!;
    const sole = (await listIntents(other, db as any)).find(i => i.workspace_name.startsWith('Cap'))!;
    await cancelIntent(sole.id, other, db as any);
    expect((await mk(loser, 'Late Arrival')).replayed).toBe(false);
    // Revocation blocks new admissions only.
    await revokeInvite(small.id, admin, db as any);
    await expect(mk(carol === loser || carol === winners[0] || carol === other ? dave : carol, 'After Revoke')).rejects.toThrow();
    expect((await createIntent(winners[0]!, { client_request_key: key(), invite_code: small.code, workspace_name: 'Still Admitted', funding_cents: 2100 }, db as any)).replayed).toBe(false);
    await expect(createIntent(alice, { client_request_key: key(), invite_code: 'inv_does_not_exist', workspace_name: 'Nope', funding_cents: 2100 }, db as any)).rejects.toMatchObject({ code: 'invite_not_found' });
  });

  test('options are validated, revisioned and resumable; agents fail closed until versioned offers exist', async () => {
    await expect(createIntent(bob, body('Agent Early', { agent_offer_id: randomUUID() }), db as any)).rejects.toMatchObject({ code: 'agent_offer_unavailable' });
    await expect(createIntent(bob, body('Too Cheap', { funding_cents: 2099 }), db as any)).rejects.toMatchObject({ code: 'invalid_funding_amount' });
    await expect(createIntent(bob, body('Bad Return', { return_state: 'https://evil.test/x' }), db as any)).rejects.toMatchObject({ code: 'invalid_return_state' });
    await expect(createIntent(bob, { ...body('Extra'), unexpected: 1 }, db as any)).rejects.toMatchObject({ code: 'invalid_body' });
    await expect(createAgentOffer({ template: 'researcher', model_ref: 'm', rate_version: 'r1', default_daily_cap_cents: 500, max_daily_cap_cents: 1000 }, bob, db as any)).rejects.toMatchObject({ code: 'platform_admin_required' });
    const offer = await createAgentOffer({ template: 'researcher', model_ref: 'fixture-model@1', rate_version: 'fixture-rate-1', default_daily_cap_cents: 500, max_daily_cap_cents: 1000 }, admin, db as any);
    await expect(createIntent(bob, body('Cap Too High', { agent_offer_id: offer.id, agent_daily_cap_cents: 1001 }), db as any)).rejects.toMatchObject({ code: 'invalid_agent_daily_cap' });
    const { intent } = await createIntent(bob, body('Options Bob', { agent_offer_id: offer.id, funding_cents: 5000, return_state: 'resume:step=review' }), db as any);
    expect(intent.agent).toMatchObject({ id: offer.id, rate_version: 'fixture-rate-1', daily_cap_cents: 500 });
    expect(intent).toMatchObject({ funding_cents: 5000, return_state: 'resume:step=review', status: 'open', funded: false });
    expect((await listIntents(bob, db as any)).some(i => i.id === intent.id)).toBe(true);
    const updated = await updateIntent(intent.id, bob, { expected_revision: intent.revision, agent_daily_cap_cents: 800, funding_cents: 10000 }, db as any);
    expect(updated).toMatchObject({ revision: intent.revision + 1, funding_cents: 10000 });
    expect(updated.agent!.daily_cap_cents).toBe(800);
    await expect(updateIntent(intent.id, bob, { expected_revision: intent.revision, funding_cents: 2100 }, db as any)).rejects.toMatchObject({ code: 'stale_revision' });
    const cleared = await updateIntent(intent.id, bob, { expected_revision: updated.revision, agent_offer_id: null, agent_daily_cap_cents: null }, db as any);
    expect(cleared.agent).toBeNull();
    await expect(createIntent(bob, body('options bob'), db as any)).rejects.toMatchObject({ code: 'workspace_name_taken' });
  });

  test('funding gate: no client, redirect or unpaid event can fund; verified payment credits once and funds once', async () => {
    const { intent } = await createIntent(carol, body('Funding Carol', { funding_cents: 2100 }), db as any);
    await expect(provisionIntent(intent.id, carol, db as any)).rejects.toMatchObject({ code: 'funding_required' });
    // Intent-bound checkout is server amount-bound, idempotent and rejects below-minimum custom amounts.
    const sid = `cs_test_${randomUUID()}`, double = stripeDouble(sid);
    const checkoutKey = key();
    const payload = { amount_cents: 2100, idempotency_key: checkoutKey, return_url: returnUrl };
    const created = await createHostingCheckout(intent.account_id, payload, db as any, double, { intentId: intent.id });
    expect((await createHostingCheckout(intent.account_id, payload, db as any, double, { intentId: intent.id })).order_id).toBe(created.order_id);
    await expect(createHostingCheckout(intent.account_id, { ...payload, amount_cents: 2099, idempotency_key: key() }, db as any, double, { intentId: intent.id })).rejects.toThrow('invalid_checkout');
    await expect(createHostingCheckout(intent.account_id, { ...payload, amount_cents: 2100, idempotency_key: key() }, db as any, double)).rejects.toThrow('invalid_checkout'); // legacy allowlist intact
    await expect(createHostingCheckout(intent.account_id, { ...payload, return_url: 'https://evil.test' }, db as any, double, { intentId: intent.id })).rejects.toThrow('return_url_not_allowed');
    const [order] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${created.order_id}`;
    // Unpaid session and mismatched amount never fund.
    expect(await fulfillHostingCheckout({ ...paid(order!.id, order!.account_id, 2100), payment_status: 'unpaid' } as any, db as any)).toEqual({ credited: false });
    await expect(fulfillHostingCheckout(paid(order!.id, order!.account_id, 2000), db as any)).rejects.toThrow('stripe_binding_mismatch');
    expect((await readIntent(intent.id, carol, db as any)).funded).toBe(false);
    // A forged flag without a fulfilled order/ledger credit still cannot provision.
    await db`UPDATE onboarding_intents SET status='funded',funded_at=now() WHERE id=${intent.id}`;
    await expect(provisionIntent(intent.id, carol, db as any)).rejects.toMatchObject({ code: 'funding_required' });
    await db`UPDATE onboarding_intents SET status='open',funded_at=NULL WHERE id=${intent.id}`;
    // Verified paid session: concurrent/retried delivery credits and funds exactly once.
    const session = paid(order!.id, order!.account_id, 2100, sid);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => fulfillHostingCheckout(session, db as any)));
    expect(outcomes.filter(o => o.credited).length).toBe(1);
    const ledger = await db`SELECT * FROM hosting_ledger WHERE account_id=${order!.account_id}`;
    expect(ledger.length).toBe(1); expect(ledger[0]!.kind).toBe('stripe'); expect(ledger[0]!.amount_units).toBe((21n * USD_UNITS).toString());
    const funded = await readIntent(intent.id, carol, db as any);
    expect(funded).toMatchObject({ status: 'funded', funded: true });
    expect((await db`SELECT balance.* FROM (SELECT paid_units FROM hosting_accounts WHERE id=${order!.account_id}) balance`)[0]!.paid_units).toBe((21n * USD_UNITS).toString());
    // Funded intents cannot be cancelled or have the amount changed; credit is retained.
    await expect(cancelIntent(intent.id, carol, db as any)).rejects.toMatchObject({ code: 'intent_not_cancellable' });
    await expect(updateIntent(intent.id, carol, { expected_revision: funded.revision, funding_cents: 5000 }, db as any)).rejects.toMatchObject({ code: 'funding_locked' });
  });

  test('provisioning is exactly once under concurrency; seat redeemed; introductory boundary recorded', async () => {
    const { intent } = await createIntent(alice, body('Provision Alice'), db as any);
    const { session } = await fund(intent.id, alice);
    await fulfillHostingCheckout(session, db as any);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => provisionIntent(intent.id, alice, db as any)));
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    const done = await readIntent(intent.id, alice, db as any);
    expect(done).toMatchObject({ status: 'provisioned' });
    expect(Object.keys(done.steps).sort()).toEqual(['billing_link', 'workspace']);
    const workspaces = await db`SELECT * FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${alice} AND name='Provision Alice'`;
    expect(workspaces.length).toBe(1); expect(done.workspace_id).toBe(workspaces[0]!.id);
    const [link] = await db`SELECT * FROM hosting_workspace_accounts WHERE workspace_id=${done.workspace_id}`;
    expect(link!.account_id).toBe(done.account_id);
    const intro = new Date(done.intro_ends_at!).getTime() - new Date(done.provisioned_at!).getTime();
    expect(Math.abs(intro - 720 * 3_600_000)).toBeLessThan(60_000);
    const [seat] = await db`SELECT status FROM onboarding_invite_seats WHERE invite_id=${invite.id} AND owner_actor_id=(SELECT id FROM flightdeck_pg_actors WHERE npub=${alice})`;
    expect(seat!.status).toBe('redeemed');
    // No further credit, workspace or account change on replay.
    const again = await provisionIntent(intent.id, alice, db as any);
    expect(String(again.provisioned_at)).toBe(String(done.provisioned_at));
    expect((await db`SELECT * FROM hosting_ledger WHERE account_id=${done.account_id}`).length).toBe(1);
    await expect(releaseInviteSeat(invite.id, alice, admin, db as any)).rejects.toMatchObject({ code: 'seat_redeemed' });
  });

  test('a failed step keeps credit and completed progress; resume creates no duplicates or second charge', async () => {
    const { intent } = await createIntent(bob, body('Resume Bob'), db as any);
    const { session } = await fund(intent.id, bob);
    await fulfillHostingCheckout(session, db as any);
    await expect(provisionIntent(intent.id, bob, db as any, { beforeStep: s => { if (s === 'billing_link') throw new Error('fixture failure'); } })).rejects.toMatchObject({ code: 'provisioning_step_failed' });
    const partial = await readIntent(intent.id, bob, db as any);
    expect(partial.status).toBe('provisioning'); expect(partial.last_error).toBe('billing_link:provisioning_step_failed');
    expect(Object.keys(partial.steps)).toEqual(['workspace']);
    expect((await db`SELECT * FROM hosting_workspace_accounts WHERE workspace_id=${partial.workspace_id}`).length).toBe(0);
    const [account] = await db`SELECT paid_units FROM hosting_accounts WHERE id=${partial.account_id}`;
    expect(account!.paid_units).toBe((21n * USD_UNITS).toString());
    const resumed = await Promise.all([provisionIntent(intent.id, bob, db as any), provisionIntent(intent.id, bob, db as any)]);
    expect(resumed.every(r => r.status === 'provisioned' && r.last_error === null)).toBe(true);
    expect((await db`SELECT * FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${bob} AND name='Resume Bob'`).length).toBe(1);
    expect((await db`SELECT * FROM hosting_ledger WHERE account_id=${partial.account_id}`).length).toBe(1);
  });

  test('rollout gate: intent, checkout and provisioning fail closed until ONBOARDING_ENABLED', async () => {
    process.env.ONBOARDING_ENABLED = 'false';
    try {
      expect((await call('POST', '/intents', aliceKey, body('Gated'))).status).toBe(503);
      expect((await call('POST', `/intents/${randomUUID()}/provision`, aliceKey)).json.code).toBe('onboarding_rollout_disabled');
      expect((await call('POST', `/intents/${randomUUID()}/checkout`, aliceKey, { idempotency_key: key(), return_url: returnUrl })).status).toBe(503);
    } finally { process.env.ONBOARDING_ENABLED = 'true'; }
  });

  test('pending checkout holds the seat: no cancel or admin release, no reuse, and a late verified payment still provisions', async () => {
    const one = await createInvite({ max_admissions: 1 }, admin, db as any);
    const claimant = await createIntent(eve, { client_request_key: key(), invite_code: one.code, workspace_name: 'Late Payer', funding_cents: 2100 }, db as any);
    const double = stripeDouble(`cs_test_${randomUUID()}`);
    const checkout = await createHostingCheckout(claimant.intent.account_id, { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl }, db as any, double, { intentId: claimant.intent.id });
    await expect(cancelIntent(claimant.intent.id, eve, db as any)).rejects.toMatchObject({ code: 'checkout_outstanding' });
    await expect(releaseInviteSeat(one.id, eve, admin, db as any)).rejects.toMatchObject({ code: 'checkout_outstanding' });
    // Racing cancel / release / another claimant never frees the paid claimant's place.
    const race = await Promise.allSettled([
      cancelIntent(claimant.intent.id, eve, db as any), releaseInviteSeat(one.id, eve, admin, db as any),
      createIntent(frank, { client_request_key: key(), invite_code: one.code, workspace_name: 'Seat Thief', funding_cents: 2100 }, db as any),
    ]);
    expect(race.every(r => r.status === 'rejected')).toBe(true);
    expect((race[2] as PromiseRejectedResult).reason.code).toBe('invite_full');
    const [order] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${checkout.order_id}`;
    const session = paid(order!.id, order!.account_id, 2100, (await double.checkout.sessions.retrieve()).id);
    // Payment racing a release attempt serializes: whichever order, the payer ends funded with the seat intact.
    const [, fulfilled] = await Promise.allSettled([releaseInviteSeat(one.id, eve, admin, db as any), fulfillHostingCheckout(session, db as any)]);
    expect(fulfilled.status).toBe('fulfilled');
    expect((await readIntent(claimant.intent.id, eve, db as any)).status).toBe('funded');
    const [seat] = await db`SELECT status FROM onboarding_invite_seats WHERE invite_id=${one.id}`;
    expect(seat!.status).toBe('reserved');
    await expect(releaseInviteSeat(one.id, eve, admin, db as any)).rejects.toMatchObject({ code: 'seat_has_funded_intent' });
    const provisioned = await provisionIntent(claimant.intent.id, eve, db as any);
    expect(provisioned.status).toBe('provisioned');
    // A checkout cannot be attached to a cancelled intent.
    const cancelled = await createIntent(frank, { client_request_key: key(), invite_code: (await createInvite({ max_admissions: 50 }, admin, db as any)).code, workspace_name: 'Cancelled Frank', funding_cents: 2100 }, db as any);
    await cancelIntent(cancelled.intent.id, frank, db as any);
    await expect(createHostingCheckout(cancelled.intent.account_id, { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl }, db as any, stripeDouble(), { intentId: cancelled.intent.id })).rejects.toMatchObject({ code: 'intent_not_open' });
  });

  test('selected agents are explicitly not provisioned; onboarded accounts never gain legacy welcome credit', async () => {
    const offer = (await listIntentsOffer())!;
    const roomy = await createInvite({ max_admissions: 50 }, admin, db as any);
    const { intent } = await createIntent(carol, body('Agent Pending Carol', { agent_offer_id: offer, invite_code: roomy.code }), db as any);
    expect(intent.agent_state).toBe('selected_not_provisioned');
    const { session } = await fund(intent.id, carol);
    await fulfillHostingCheckout(session, db as any);
    const done = await provisionIntent(intent.id, carol, db as any);
    expect(done).toMatchObject({ status: 'provisioned', agent_state: 'selected_not_provisioned' });
    expect(done.steps.agent).toBeUndefined();
    expect((await createIntent(dave, body('No Agent Dave', { invite_code: roomy.code }), db as any)).intent.agent_state).toBe('none');
    // Zero-promo semantics survive workspace linking and a later legacy hosted link for the same owner.
    const extra = randomUUID();
    const [owner] = await db`SELECT id FROM flightdeck_pg_actors WHERE npub=${carol}`;
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${extra},'tower',${extra},${carol},'hosting-fixture','Legacy Link')`;
    await db.begin(tx => linkHostedAccount(extra, owner!.id, tx as any));
    const [account] = await db`SELECT * FROM hosting_accounts WHERE id=${done.account_id}`;
    expect(account!.promo_units).toBe('0'); expect(account!.opened_by).toBe('onboarding');
    const entries = await db`SELECT kind FROM hosting_ledger WHERE account_id=${done.account_id}`;
    expect(entries.length).toBeGreaterThan(0); expect(entries.every(e => e.kind === 'stripe')).toBe(true);
    expect((await db`SELECT 1 FROM hosting_workspace_accounts WHERE account_id=${done.account_id}`).length).toBe(2);
  });

  test('contract: OpenAPI publishes every onboarding route and keeps the live Stripe gate', async () => {
    const document = buildOpenApiDocument('http://localhost') as any;
    for (const path of ['/invites/{code}', '/account', '/agent-offers', '/intents', '/intents/{id}', '/intents/{id}/options', '/intents/{id}/cancel', '/intents/{id}/checkout', '/intents/{id}/provision', '/admin/invites', '/admin/invites/{id}/revoke', '/admin/invites/{id}/release-seat', '/admin/refunds', '/intents/{id}/lightning/quote', '/intents/{id}/lightning/quotes/{quoteId}/refresh', '/admin/lightning/reconcile', '/admin/lightning-refunds', '/admin/agent-offers']) {
      expect(document.paths[`/api/v4/onboarding${path}`]).toBeDefined();
    }
    expect(document.components.schemas.OnboardingIntent.properties.funding_cents.minimum).toBe(2100);
    process.env.HOSTING_STRIPE_MODE = 'live';
    try { await expect(createHostingCheckout(randomUUID(), { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl }, db as any, undefined, { intentId: randomUUID() })).rejects.toThrow('stripe_live_rollout_blocked'); }
    finally { delete process.env.HOSTING_STRIPE_MODE; }
  });
});
