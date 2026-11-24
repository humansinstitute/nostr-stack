import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import Stripe from 'stripe';
import { getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { createHostingCheckout, fulfillHostingCheckout, receiveHostingStripeWebhook, reconcileStripePayment, requestStripeRefund, resolveCheckoutOrders } from '../src/services/hosting-stripe';
import { registerFundingReserve, fundingReversalSummary, REQUIRED_RESERVE_SOURCES } from '../src/services/hosting-funding';
import { cancelIntent, createIntent, createInvite, openOwnerAccount, provisionIntent, readIntent, releaseInviteSeat } from '../src/services/onboarding';
import { USD_UNITS } from '../src/services/hosting-billing';

// Runs only against a dedicated disposable PostgreSQL: FUNDING_TEST_PORT=<free port>.
const port = Number(process.env.FUNDING_TEST_PORT);
const returnUrl = 'https://example.test/billing';
const sdk = new Stripe('sk_test_fixture_not_a_real_key');
const newNpub = () => nip19.npubEncode(getPublicKey(randomBytes(32)));
const admin = newNpub();
const usd = (cents: number) => (BigInt(cents) * (USD_UNITS / 100n)).toString();

/** In-memory provider honouring the documented Stripe contract shapes used by production code:
 * Checkout Session (status open|complete|expired, payment_status), Refund (status pending|succeeded|failed|canceled) and
 * Dispute (status needs_response|under_review|won|lost|warning_*). Only the HTTP edge is faked. */
class FakeStripe {
  sessions = new Map<string, any>(); refundStore = new Map<string, any>(); disputeStore = new Map<string, any>();
  expireFails = false; refundError: any = null; refundCalls = 0; sessionCreates = 0;
  webhooks = sdk.webhooks;
  checkout = { sessions: {
    create: async (p: any, o: any) => {
      this.sessionCreates++;
      const id = `cs_test_${o.idempotencyKey}`;
      if (!this.sessions.has(id)) this.sessions.set(id, { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/${id}`, livemode: false, mode: 'payment', status: 'open', payment_status: 'unpaid', currency: 'usd',
        amount_total: p.line_items[0].price_data.unit_amount, payment_intent: null, client_reference_id: p.client_reference_id, metadata: p.metadata });
      return { ...this.sessions.get(id) };
    },
    retrieve: async (id: string) => ({ ...this.sessions.get(id)! }),
    list: async (q: { payment_intent: string }) => ({ data: [...this.sessions.values()].filter(s => s.payment_intent === q.payment_intent), has_more: false }),
    expire: async (id: string) => {
      const s = this.sessions.get(id)!;
      if (this.expireFails || s.status !== 'open') throw Object.assign(new Error('session not open'), { statusCode: 400 });
      s.status = 'expired'; return { ...s };
    },
  } };
  refunds = {
    list: async (q: { payment_intent: string }) => ({ data: [...this.refundStore.values()].filter(r => r.payment_intent === q.payment_intent), has_more: false }),
    create: async (p: any, o: any) => {
      this.refundCalls++;
      if (this.refundError) throw this.refundError;
      const id = `re_${o.idempotencyKey}`;
      if (!this.refundStore.has(id)) this.refundStore.set(id, { id, object: 'refund', amount: p.amount, currency: 'usd', payment_intent: p.payment_intent, status: 'pending', reason: p.reason, metadata: p.metadata, failure_reason: null });
      return { ...this.refundStore.get(id) };
    },
  };
  disputes = { list: async (q: { payment_intent: string }) => ({ data: [...this.disputeStore.values()].filter(d => d.payment_intent === q.payment_intent), has_more: false }) };
  charges = { retrieve: async (id: string) => ({ id, payment_intent: [...this.disputeStore.values()].find(d => d.charge === id)?.payment_intent ?? null }) };
  pay(sessionId: string) { const s = this.sessions.get(sessionId)!; s.status = 'complete'; s.payment_status = 'paid'; s.payment_intent = `pi_${randomUUID().replace(/-/g, '')}`; return { ...s }; }
}

describe.skipIf(!port || port === 5432)('shared funding settlement, reversals and checkout holds on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_funding_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  const saved = { admin: config.adminNpub, service: config.service.npub };
  let n = 0;
  const key = () => `req-${process.pid}-${++n}-${randomUUID().slice(0, 8)}`;
  const fake = () => new FakeStripe();

  /** Funds a fresh owner account through the real checkout + fulfilment code. */
  async function funded(f: FakeStripe, cents = 5000) {
    const owner = newNpub();
    const { account_id } = await openOwnerAccount(owner, db as any);
    const checkout = await createHostingCheckout(account_id, { amount_cents: cents, idempotency_key: key(), return_url: returnUrl }, db as any, f as any);
    const [order] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${checkout.order_id}`;
    const session = f.pay(order!.session_id);
    await fulfillHostingCheckout(session, db as any);
    const [settlement] = await db`SELECT * FROM hosting_funding_settlements WHERE order_id=${order!.id}`;
    return { owner, accountId: account_id as string, order: order!, session, settlement: settlement!, pi: session.payment_intent as string };
  }
  const paidUnits = async (id: string) => BigInt((await db`SELECT paid_units FROM hosting_accounts WHERE id=${id}`)[0]!.paid_units);
  const refundFixture = (pi: string, amount: number, status: string, extra: Record<string, unknown> = {}) => ({ id: `re_${randomUUID()}`, object: 'refund', amount, currency: 'usd', payment_intent: pi, status, reason: null, metadata: {}, failure_reason: null, ...extra });
  const disputeFixture = (pi: string, amount: number, status: string, extra: Record<string, unknown> = {}) => ({ id: `dp_${randomUUID()}`, object: 'dispute', amount, currency: 'usd', payment_intent: pi, charge: `ch_${randomUUID()}`, status, reason: 'fraudulent', ...extra });
  async function webhook(f: FakeStripe, type: string, object: unknown, id = `evt_${randomUUID()}`) {
    const raw = Buffer.from(JSON.stringify({ id, object: 'event', api_version: '2025-01-01', created: Math.floor(Date.now() / 1000), livemode: false, type, data: { object }, pending_webhooks: 1, request: { id: null, idempotency_key: null } }));
    const signature = await sdk.webhooks.generateTestHeaderStringAsync({ payload: raw.toString(), secret: 'whsec_fixture' });
    return receiveHostingStripeWebhook(raw, signature, db as any, f as any);
  }

  beforeAll(async () => {
    process.env.HOSTING_STRIPE_RETURN_URLS = returnUrl; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture'; process.env.ONBOARDING_ENABLED = 'true';
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    config.adminNpub = admin;
    config.service.npub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(86)));
  });
  afterAll(async () => { delete process.env.ONBOARDING_ENABLED; config.adminNpub = saved.admin; config.service.npub = saved.service; await closeDb(); });

  test('a verified payment becomes one immutable settlement and one ledger credit under concurrency; rebinding is refused', async () => {
    const f = fake(), x = await funded(f, 2500);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => fulfillHostingCheckout(x.session, db as any)));
    expect(outcomes.filter(o => o.credited).length).toBe(0); // already fulfilled by funded(); replays are duplicates
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(2500)));
    expect((await db`SELECT * FROM hosting_ledger WHERE account_id=${x.accountId}`).length).toBe(1);
    expect(x.settlement).toMatchObject({ method: 'stripe', amount_cents: 2500, currency: 'USD', provider_ref: x.pi, order_id: x.order.id });
    // The same provider payment cannot credit a second order, and the evidence cannot be rewritten or deleted.
    const second = await createHostingCheckout(x.accountId, { amount_cents: 2500, idempotency_key: key(), return_url: returnUrl }, db as any, f as any);
    const [o2] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${second.order_id}`;
    await expect(fulfillHostingCheckout({ ...f.pay(o2!.session_id), payment_intent: x.pi }, db as any)).rejects.toThrow();
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(2500)));
    await expect(db`UPDATE hosting_funding_settlements SET amount_cents=1 WHERE id=${x.settlement.id}`).rejects.toThrow('append-only');
    await expect(db`DELETE FROM hosting_funding_settlements WHERE id=${x.settlement.id}`).rejects.toThrow('append-only');
  });

  test('a signed refund webhook withholds the funds exactly once; replays, duplicates and failed refunds converge', async () => {
    const f = fake(), x = await funded(f, 5000);
    const refund = refundFixture(x.pi, 2000, 'pending'); f.refundStore.set(refund.id, refund);
    const results = await Promise.all([webhook(f, 'refund.created', refund, 'evt_a'), webhook(f, 'refund.created', refund, 'evt_a'), webhook(f, 'charge.refund.updated', refund)]);
    expect(results.every(r => (r as any).reconciled)).toBe(true);
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(3000)));
    expect((await db`SELECT * FROM hosting_ledger WHERE account_id=${x.accountId} AND kind='refund'`).length).toBe(1);
    // Out-of-order terminal delivery: success after pending changes nothing further; a replay of the stale pending event still converges on current truth.
    refund.status = 'succeeded'; await webhook(f, 'refund.updated', refund);
    await webhook(f, 'refund.created', { ...refund, status: 'pending' });
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(3000)));
    // A second refund that later fails releases its withheld funds by explicit ledger entry; history is kept.
    const other = refundFixture(x.pi, 1000, 'pending'); f.refundStore.set(other.id, other);
    await webhook(f, 'refund.created', other); expect(await paidUnits(x.accountId)).toBe(BigInt(usd(2000)));
    other.status = 'failed'; other.failure_reason = 'lost_or_stolen_card'; await webhook(f, 'refund.failed', other);
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(3000)));
    const rows = await db`SELECT kind,state,effective_cents FROM hosting_funding_adjustments WHERE account_id=${x.accountId} ORDER BY created_at`;
    expect(rows.map(r => `${r.state}:${r.effective_cents}`)).toEqual(['succeeded:2000', 'failed:0']);
    expect((await db`SELECT amount_units FROM hosting_ledger WHERE account_id=${x.accountId} AND kind='refund' ORDER BY created_at`).map(r => r.amount_units))
      .toEqual([`-${usd(2000)}`, `-${usd(1000)}`, usd(1000)]);
    expect((await db`SELECT count(*)::int AS n FROM hosting_funding_events WHERE settlement_id=${x.settlement.id}`)[0]!.n).toBeGreaterThanOrEqual(4);
    await expect(db`DELETE FROM hosting_funding_adjustments WHERE account_id=${x.accountId}`).rejects.toThrow('append-only');
  });

  test('a reversal that arrives before the payment event settles the payment first, then withholds', async () => {
    const f = fake();
    const owner = newNpub(), { account_id } = await openOwnerAccount(owner, db as any);
    const checkout = await createHostingCheckout(account_id, { amount_cents: 1000, idempotency_key: key(), return_url: returnUrl }, db as any, f as any);
    const [order] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${checkout.order_id}`;
    const session = f.pay(order!.session_id);
    const refund = refundFixture(session.payment_intent, 400, 'succeeded'); f.refundStore.set(refund.id, refund);
    expect((await webhook(f, 'refund.created', refund) as any).reconciled).toBe(true);
    expect(await paidUnits(account_id)).toBe(BigInt(usd(600)));
    // The late original event is a duplicate and credits nothing more.
    expect((await webhook(f, 'checkout.session.completed', session) as any).credited).toBe(false);
    expect(await paidUnits(account_id)).toBe(BigInt(usd(600)));
    // Reversals for payments this service never settled are ignored without effect.
    expect((await reconcileStripePayment(f as any, 'pi_unknown', db as any)).reconciled).toBe(false);
  });

  test('disputes follow provider state: withdrawn then reinstated or lost, never spendable while withheld', async () => {
    const f = fake(), x = await funded(f, 10000);
    const warning = disputeFixture(x.pi, 10000, 'warning_needs_response'); f.disputeStore.set(warning.id, warning);
    await webhook(f, 'charge.dispute.created', warning);
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(10000))); // inquiries withdraw nothing
    const dispute = disputeFixture(x.pi, 10000, 'needs_response'); f.disputeStore.set(dispute.id, dispute);
    await Promise.all([webhook(f, 'charge.dispute.created', dispute), webhook(f, 'charge.dispute.funds_withdrawn', dispute), webhook(f, 'charge.dispute.updated', dispute)]);
    expect(await paidUnits(x.accountId)).toBe(0n);
    expect((await db`SELECT depleted_at FROM hosting_accounts WHERE id=${x.accountId}`)[0]!.depleted_at).not.toBeNull();
    dispute.status = 'won'; await webhook(f, 'charge.dispute.closed', dispute); await webhook(f, 'charge.dispute.funds_reinstated', dispute);
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(10000)));
    expect((await db`SELECT depleted_at FROM hosting_accounts WHERE id=${x.accountId}`)[0]!.depleted_at).toBeNull();
    // A later lost dispute (re-opened by the network) keeps the loss; closing event retrieved out of order cannot restore it.
    dispute.status = 'lost'; await webhook(f, 'charge.dispute.closed', dispute); await webhook(f, 'charge.dispute.updated', { ...dispute, status: 'needs_response' });
    expect(await paidUnits(x.accountId)).toBe(0n);
    const summary = await fundingReversalSummary(db as any, x.accountId);
    expect(summary.adjustments.map(a => `${a.kind}:${a.state}:${a.effective_cents}`).sort()).toEqual(['dispute:inactive:0', 'dispute:lost:10000']);
  });

  test('reversal of already-spent funds becomes explicit debt and blocks the account; spent funds are never silently dropped', async () => {
    const f = fake(), x = await funded(f, 1000);
    // Spend 700 of the 1000 (storage debit evidence is out of scope; the ledger/balance effect is what matters here).
    const spent = BigInt(usd(700));
    await db`UPDATE hosting_accounts SET paid_units=paid_units-${spent.toString()} WHERE id=${x.accountId}`;
    const refund = refundFixture(x.pi, 1000, 'succeeded'); f.refundStore.set(refund.id, refund);
    await webhook(f, 'charge.refund.updated', refund);
    expect(await paidUnits(x.accountId)).toBe(-BigInt(usd(700)));
    const [row] = await db`SELECT uncovered_units FROM hosting_funding_adjustments WHERE account_id=${x.accountId}`;
    expect(row!.uncovered_units).toBe(usd(700));
    expect((await db`SELECT depleted_at FROM hosting_accounts WHERE id=${x.accountId}`)[0]!.depleted_at).not.toBeNull();
    expect((await fundingReversalSummary(db as any, x.accountId)).reversal_debt_units).toBe(usd(700));
  });

  test('support refund: unused unreserved funds only, funds withheld first, idempotent, ambiguous outcomes keep the hold', async () => {
    const f = fake(), x = await funded(f, 5000);
    const request = (over: Record<string, unknown> = {}) => ({ settlement_id: x.settlement.id, amount_cents: 1500, idempotency_key: key(), reason: 'customer asked', ...over });
    await expect(requestStripeRefund({ ...request(), extra: 1 }, admin, db as any, f as any)).rejects.toMatchObject({ code: 'invalid_refund' });
    // Release gate: with no registered reserve (storage runway / agent holds) an empty registry is not proof of unreserved funds.
    await expect(requestStripeRefund(request(), admin, db as any, f as any)).rejects.toMatchObject({ code: 'refund_reserves_unregistered' });
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(5000)));
    // Either required source alone (storage protection or agent holds) still leaves refunds closed.
    for (const only of REQUIRED_RESERVE_SOURCES) {
      const lone = registerFundingReserve(only, async () => 0n);
      await expect(requestStripeRefund(request(), admin, db as any, f as any)).rejects.toMatchObject({ code: 'refund_reserves_unregistered' });
      lone();
    }
    await expect(requestStripeRefund(request(), newNpub(), db as any, f as any)).rejects.toMatchObject({ code: 'platform_admin_required' });
    // Reserved funds (registered by storage/agent slices) are not refundable.
    let held = BigInt(usd(4000));
    const offStorage = registerFundingReserve('storage_protection', async () => held), offAgents = registerFundingReserve('agent_holds', async () => 0n);
    const unregister = () => { offStorage(); offAgents(); };
    await expect(requestStripeRefund(request(), admin, db as any, f as any)).rejects.toMatchObject({ code: 'refund_exceeds_available' });
    held = 0n;
    const body = request();
    const first = await requestStripeRefund(body, admin, db as any, f as any);
    expect(first).toMatchObject({ state: 'pending', amount_cents: 1500 });
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(3500)));
    // Replays are idempotent; a different body under the same key conflicts.
    expect((await requestStripeRefund(body, admin, db as any, f as any)).adjustment_id).toBe(first.adjustment_id);
    await expect(requestStripeRefund({ ...body, amount_cents: 1400 }, admin, db as any, f as any)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(f.refundCalls).toBe(1);
    // The provider's own refund event matches the request by metadata and does not debit twice.
    const stripeRefund = [...f.refundStore.values()][0]; stripeRefund.status = 'succeeded';
    await webhook(f, 'refund.updated', stripeRefund);
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(3500)));
    expect((await db`SELECT provider_ref,state FROM hosting_funding_adjustments WHERE id=${first.adjustment_id}`)[0]).toMatchObject({ provider_ref: stripeRefund.id, state: 'succeeded' });
    // Cannot exceed what remains refundable on the payment or the unspent balance.
    await expect(requestStripeRefund(request({ amount_cents: 3600 }), admin, db as any, f as any)).rejects.toMatchObject({ code: 'refund_exceeds_available' });
    // Definite provider rejection returns the funds; ambiguous failure keeps them withheld and a replay completes it.
    f.refundError = Object.assign(new Error('rejected'), { statusCode: 400, code: 'charge_already_refunded' });
    const rejected = await requestStripeRefund(request({ amount_cents: 500 }), admin, db as any, f as any);
    expect(rejected.state).toBe('failed'); expect(await paidUnits(x.accountId)).toBe(BigInt(usd(3500)));
    f.refundError = Object.assign(new Error('connection reset'), { statusCode: 503 });
    const ambiguous = request({ amount_cents: 500 });
    await expect(requestStripeRefund(ambiguous, admin, db as any, f as any)).rejects.toMatchObject({ code: 'refund_outcome_unknown' });
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(3000)));
    f.refundError = null;
    expect((await requestStripeRefund(ambiguous, admin, db as any, f as any)).state).toBe('pending');
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(3000)));
    unregister();
    await expect(requestStripeRefund(request(), admin, db as any, f as any)).rejects.toMatchObject({ code: 'refund_reserves_unregistered' });
  });

  test('onboarding funding reversed before provisioning stops setup; completed provisioning and ownership are preserved', async () => {
    const f = fake();
    const invite = await createInvite({ max_admissions: 5 }, admin, db as any);
    const make = async (label: string) => {
      const owner = newNpub();
      const { intent } = await createIntent(owner, { client_request_key: key(), invite_code: invite.code, workspace_name: label, funding_cents: 2100 }, db as any);
      const checkout = await createHostingCheckout(intent.account_id, { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl }, db as any, f as any, { intentId: intent.id });
      const [order] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${checkout.order_id}`;
      const session = f.pay(order!.session_id);
      await fulfillHostingCheckout(session, db as any);
      return { owner, intent, session };
    };
    const a = await make('Reversed Before');
    const refund = refundFixture(a.session.payment_intent, 2100, 'succeeded'); f.refundStore.set(refund.id, refund);
    await webhook(f, 'refund.created', refund);
    expect(await readIntent(a.intent.id, a.owner, db as any)).toMatchObject({ status: 'funded', funding_reversed: true });
    await expect(provisionIntent(a.intent.id, a.owner, db as any)).rejects.toMatchObject({ code: 'funding_reversed' });
    expect((await db`SELECT count(*)::int AS n FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${a.owner}`)[0]!.n).toBe(0);
    // After provisioning the workspace, intent and seat remain even if the payment is later disputed; the account carries the debt.
    const b = await make('Reversed After');
    const done = await provisionIntent(b.intent.id, b.owner, db as any);
    expect(done.status).toBe('provisioned');
    const dispute = disputeFixture(b.session.payment_intent, 2100, 'lost'); f.disputeStore.set(dispute.id, dispute);
    await webhook(f, 'charge.dispute.closed', dispute);
    const after = await readIntent(b.intent.id, b.owner, db as any);
    expect(after).toMatchObject({ status: 'provisioned', workspace_id: done.workspace_id, funding_reversed: true });
    expect((await db`SELECT status FROM onboarding_invite_seats WHERE invite_id=${invite.id} AND owner_actor_id=(SELECT id FROM flightdeck_pg_actors WHERE npub=${b.owner})`)[0]!.status).toBe('redeemed');
    expect(await paidUnits(b.intent.account_id)).toBe(0n);
  });

  test('checkout holds resolve only from verified provider state: expire open, credit paid, keep unverifiable', async () => {
    const f = fake();
    const invite = await createInvite({ max_admissions: 10 }, admin, db as any);
    const start = async (label: string) => {
      const owner = newNpub();
      const { intent } = await createIntent(owner, { client_request_key: key(), invite_code: invite.code, workspace_name: label, funding_cents: 2100 }, db as any);
      const checkout = await createHostingCheckout(intent.account_id, { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl }, db as any, f as any, { intentId: intent.id });
      const [order] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${checkout.order_id}`;
      return { owner, intent, order: order! };
    };
    const seat = async (owner: string) => (await db`SELECT status FROM onboarding_invite_seats WHERE invite_id=${invite.id} AND owner_actor_id=(SELECT id FROM flightdeck_pg_actors WHERE npub=${owner})`)[0]!.status;
    const resolver = (client: any) => (ids: string[], d: any) => resolveCheckoutOrders(ids, d, () => client);

    // Open session: provider expires it, then cancel succeeds and releases the seat. A later payment is impossible.
    const open = await start('Open Session');
    expect((await cancelIntent(open.intent.id, open.owner, db as any, resolver(f))).status).toBe('cancelled');
    expect(f.sessions.get(open.order.session_id)!.status).toBe('expired');
    expect(await seat(open.owner)).toBe('released');
    expect((await db`SELECT terminal_reason FROM hosting_checkout_orders WHERE id=${open.order.id}`)[0]!.terminal_reason).toBe('expired');

    // Paid-but-unseen session: resolution credits and funds the intent; cancel is refused and nothing is lost.
    const late = await start('Late Paid');
    f.pay(late.order.session_id);
    await expect(cancelIntent(late.intent.id, late.owner, db as any, resolver(f))).rejects.toMatchObject({ code: 'intent_not_cancellable' });
    expect(await readIntent(late.intent.id, late.owner, db as any)).toMatchObject({ status: 'funded', funded: true });
    expect(await paidUnits(late.intent.account_id)).toBe(BigInt(usd(2100)));
    expect(await seat(late.owner)).toBe('reserved');

    // Provider cannot expire the session (and it is not paid): stays outstanding, seat held.
    const stuck = await start('Stuck Session');
    f.expireFails = true;
    await expect(cancelIntent(stuck.intent.id, stuck.owner, db as any, resolver(f))).rejects.toMatchObject({ code: 'checkout_outstanding' });
    await expect(releaseInviteSeat(invite.id, stuck.owner, admin, db as any, resolver(f))).rejects.toMatchObject({ code: 'checkout_outstanding' });
    expect(await seat(stuck.owner)).toBe('reserved');
    f.expireFails = false;
    // Async payment pending (complete but unpaid): cannot be cancelled either.
    f.sessions.get(stuck.order.session_id)!.status = 'complete';
    await expect(cancelIntent(stuck.intent.id, stuck.owner, db as any, resolver(f))).rejects.toMatchObject({ code: 'checkout_outstanding' });
    // Unconfigured provider is fail-closed too.
    const noProvider = (ids: string[], d: any) => resolveCheckoutOrders(ids, d, () => { throw new Error('stripe_unconfigured'); });
    await expect(cancelIntent(stuck.intent.id, stuck.owner, db as any, noProvider)).rejects.toMatchObject({ code: 'checkout_outstanding' });

    // Webhook path: checkout.session.expired from the provider marks a verified-expired order terminal; duplicate is harmless.
    const hooked = await start('Hooked Expiry');
    f.sessions.get(hooked.order.session_id)!.status = 'expired';
    await webhook(f, 'checkout.session.expired', { id: hooked.order.session_id });
    await webhook(f, 'checkout.session.expired', { id: hooked.order.session_id });
    expect((await db`SELECT terminal_reason FROM hosting_checkout_orders WHERE id=${hooked.order.id}`)[0]!.terminal_reason).toBe('expired');
    // Adversarial binding: a valid expired session that is NOT this order's own (spoofed metadata, other session, wrong amount or
    // account) never releases an unrelated still-payable order, so its seat cannot be reused.
    const victim = await start('Victim Order');
    const forge = (over: Record<string, unknown>) => { const id = `cs_test_forged_${randomUUID()}`; f.sessions.set(id, { ...f.sessions.get(victim.order.session_id)!, id, status: 'expired', ...over }); return id; };
    for (const over of [{}, { client_reference_id: randomUUID() }, { amount_total: 5000 }, { metadata: { hosting_order_id: victim.order.id, hosting_account_id: randomUUID() } }, { currency: 'eur' }, { livemode: true }]) {
      await webhook(f, 'checkout.session.expired', { id: forge(over) });
    }
    expect((await db`SELECT terminal_at FROM hosting_checkout_orders WHERE id=${victim.order.id}`)[0]!.terminal_at).toBeNull();
    // Even the order's own recorded session is not trusted if the provider returns different binding data for it.
    const real = f.sessions.get(victim.order.session_id)!;
    const original = { ...real }; Object.assign(real, { status: 'expired', amount_total: 4200 });
    await webhook(f, 'checkout.session.expired', { id: real.id });
    await expect(cancelIntent(victim.intent.id, victim.owner, db as any, resolver(f))).rejects.toMatchObject({ code: 'checkout_outstanding' });
    expect(await seat(victim.owner)).toBe('reserved');
    // Another claimant cannot take the seat while the victim's checkout is unresolved.
    Object.assign(real, original);
    await expect(releaseInviteSeat(invite.id, victim.owner, admin, db as any, (ids: string[], d: any) => resolveCheckoutOrders(ids, d, () => ({ ...f, checkout: { sessions: { ...f.checkout.sessions, retrieve: async () => ({ ...real, amount_total: 1 }), expire: async () => ({ ...real, status: 'expired', amount_total: 1 }) } } }) as any))).rejects.toMatchObject({ code: 'checkout_outstanding' });
    // The properly bound, still-open order resolves normally.
    expect((await cancelIntent(victim.intent.id, victim.owner, db as any, resolver(f))).status).toBe('cancelled');
    // An expired event for a session that was in fact paid credits instead of releasing.
    const racy = await start('Racy Expiry');
    f.pay(racy.order.session_id);
    await webhook(f, 'checkout.session.expired', { id: racy.order.session_id });
    expect(await readIntent(racy.intent.id, racy.owner, db as any)).toMatchObject({ status: 'funded' });
  });

  test('live Stripe remains blocked and source fixtures cannot mint production credit', async () => {
    const { hostingStripeClient } = await import('../src/services/hosting-stripe');
    const before = { mode: process.env.HOSTING_STRIPE_MODE, key: process.env.STRIPE_SECRET_KEY };
    process.env.HOSTING_STRIPE_MODE = 'live'; process.env.STRIPE_SECRET_KEY = 'sk_live_fixture';
    try { expect(() => hostingStripeClient()).toThrow('stripe_live_rollout_blocked'); }
    finally { before.mode === undefined ? delete process.env.HOSTING_STRIPE_MODE : process.env.HOSTING_STRIPE_MODE = before.mode; before.key === undefined ? delete process.env.STRIPE_SECRET_KEY : process.env.STRIPE_SECRET_KEY = before.key; }
    const f = fake(), x = await funded(f, 500);
    // A livemode event or unsigned body never reaches the ledger.
    const raw = Buffer.from(JSON.stringify({ id: 'evt_live', object: 'event', livemode: true, type: 'checkout.session.completed', data: { object: {} } }));
    await expect(receiveHostingStripeWebhook(raw, await sdk.webhooks.generateTestHeaderStringAsync({ payload: raw.toString(), secret: 'whsec_fixture' }), db as any, f as any)).rejects.toMatchObject({ code: 'stripe_mode_mismatch' });
    await expect(receiveHostingStripeWebhook(raw, 't=1,v1=bad', db as any, f as any)).rejects.toMatchObject({ code: 'stripe_signature_invalid' });
    expect(await paidUnits(x.accountId)).toBe(BigInt(usd(500)));
  });
});
