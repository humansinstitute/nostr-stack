import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { createHostingCheckout, fulfillHostingCheckout, resolveCheckoutOrders } from '../src/services/hosting-stripe';
import { configureLightningProvider, issueLightningQuote, issueLightningQuoteResult, resolveLightningQuote, type LightningProvider } from '../src/services/hosting-lightning';
import { cancelIntent, createIntent, createInvite, readIntent, releasePaymentAttempt, updateIntent } from '../src/services/onboarding';

// Runs only against a dedicated disposable PostgreSQL: ONBOARDING_TEST_PORT=<free port>. No real Stripe or Lightning credentials: both providers are fixtures.
const port = Number(process.env.ONBOARDING_TEST_PORT);
const newKey = () => randomBytes(32);
const newNpub = () => nip19.npubEncode(getPublicKey(newKey()));
const admin = newNpub();
const returnUrl = 'https://example.test/billing';
const otherReturnUrl = 'https://example.test/other';
const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const PAYEE = 'fixture-payee-node';
const app = createApp();

/** Stateful Stripe double: only the HTTP edge. Order binding, verification, fulfilment and terminal marking are production code. */
class FakeStripe {
  sessions = new Map<string, any>(); byIdem = new Map<string, string>(); createCalls = 0; failNextCreate = false; retrieveFails = false;
  checkout = {
    sessions: {
      create: async (p: any, o: any) => {
        if (this.failNextCreate) { this.failNextCreate = false; throw new Error('response lost'); }
        const existing = this.byIdem.get(o.idempotencyKey);
        if (existing) return this.sessions.get(existing);
        this.createCalls++;
        const s = { id: `cs_test_${randomUUID()}`, url: `https://checkout.stripe.com/c/${randomUUID()}`, livemode: false, mode: 'payment', status: 'open', payment_status: 'unpaid', currency: 'usd',
          amount_total: p.line_items[0].price_data.unit_amount, client_reference_id: p.client_reference_id, metadata: p.metadata, payment_intent: null };
        this.sessions.set(s.id, s); this.byIdem.set(o.idempotencyKey, s.id); return s;
      },
      retrieve: async (id: string) => { if (this.retrieveFails) throw new Error('provider unreachable'); return this.sessions.get(id); },
      expire: async (id: string) => { const s = this.sessions.get(id); if (s.payment_status !== 'paid') s.status = 'expired'; return s; },
    },
  };
  pay(id: string) { Object.assign(this.sessions.get(id), { payment_status: 'paid', status: 'complete', payment_intent: `pi_${randomUUID()}` }); return this.sessions.get(id); }
  get asClient() { return this as any; }
}

class FakeLightning implements LightningProvider {
  id = 'fixture'; payeeRef = PAYEE; issueCalls = 0; failIssue = false; lookupFails = false; cancelSupported = true; ttlMs = 900_000;
  invoices = new Map<string, any>(); byOrder = new Map<string, any>();
  async issueInvoice(req: { orderRef: string; amountCents: number }) {
    this.issueCalls++;
    if (this.failIssue) throw new Error('response lost');
    if (!this.byOrder.has(req.orderRef)) {
      const preimage = randomBytes(32).toString('hex'), hash = sha(preimage), at = new Date();
      const r = { paymentHash: hash, preimage, invoice: `lnbc${hash.slice(0, 40)}fixture${hash.slice(40)}`, amountSats: req.amountCents * 25, payeeRef: PAYEE, expiresAt: new Date(at.getTime() + this.ttlMs).toISOString(),
        rate: { source: 'fixture-fx', quotedAt: new Date(at.getTime() - 1000).toISOString() }, status: 'pending' as string, received: 0, settledAt: undefined as string | undefined };
      this.byOrder.set(req.orderRef, r); this.invoices.set(hash, r);
    }
    const r = this.byOrder.get(req.orderRef);
    return { invoice: r.invoice, paymentHash: r.paymentHash, amountSats: r.amountSats, expiresAt: r.expiresAt, payeeRef: r.payeeRef, rate: r.rate };
  }
  async lookupInvoice(hash: string) {
    if (this.lookupFails) throw new Error('provider unreachable');
    const r = this.invoices.get(hash)!;
    return { status: r.status, paymentHash: hash, payeeRef: r.payeeRef, amountSatsReceived: r.received || undefined, settledAt: r.settledAt, preimage: r.status === 'settled' ? r.preimage : undefined };
  }
  async cancelInvoice(hash: string) { if (!this.cancelSupported) throw new Error('unsupported'); const r = this.invoices.get(hash)!; if (r.status === 'pending') r.status = 'cancelled'; return { status: r.status }; }
  pay(hash: string) { Object.assign(this.invoices.get(hash)!, { status: 'settled', received: this.invoices.get(hash)!.amountSats, settledAt: new Date().toISOString() }); }
  expire(hash: string) { this.invoices.get(hash)!.status = 'expired'; }
}

describe.skipIf(!port || port === 5432)('one canonical payment attempt per onboarding intent (disposable PostgreSQL, fixture providers)', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_payattempt_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  const saved = { admin: config.adminNpub, service: config.service.npub };
  let invite: { id: string; code: string };
  let n = 0;
  const key = () => `req-${process.pid}-${++n}-${randomUUID().slice(0, 8)}`;
  const D = () => db as any;
  const start = async (label: string, funding = 2100) => {
    const owner = newNpub();
    const { intent } = await createIntent(owner, { client_request_key: key(), invite_code: invite.code, workspace_name: label, funding_cents: funding }, D());
    return { owner, intent };
  };
  const checkout = (a: { intent: any }, stripe: FakeStripe, extra: Record<string, unknown> = {}) =>
    createHostingCheckout(a.intent.account_id, { amount_cents: a.intent.funding_cents, idempotency_key: key(), return_url: returnUrl, ...extra }, D(), stripe.asClient, { intentId: a.intent.id });
  const resolver = (stripe: FakeStripe) => (ids: string[], d: any) => resolveCheckoutOrders(ids, d, () => stripe.asClient);
  const rows = async (intentId: string) => ({
    orders: (await db`SELECT * FROM hosting_checkout_orders WHERE intent_id=${intentId}`).length,
    quotes: (await db`SELECT * FROM hosting_lightning_quotes WHERE intent_id=${intentId}`).length,
  });
  const paidUnits = async (accountId: string) => BigInt((await db`SELECT paid_units FROM hosting_accounts WHERE id=${accountId}`)[0]!.paid_units);
  const credits = async (accountId: string) => (await db`SELECT count(*)::int AS n FROM hosting_funding_settlements WHERE account_id=${accountId}`)[0]!.n as number;
  async function call(method: 'GET' | 'POST', path: string, signer: Uint8Array, body?: unknown) {
    const url = `http://localhost/api/v4/onboarding${path}`;
    const raw = body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body);
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(),
      tags: [['u', url], ['method', method], ...(raw ? [['payload', createHash('sha256').update(raw).digest('hex')]] : [])] }, signer);
    const response = await app.request(url, { method, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` }, body: raw });
    return { status: response.status, json: (await response.json().catch(() => ({}))) as any };
  }

  beforeAll(async () => {
    process.env.HOSTING_STRIPE_RETURN_URLS = `${returnUrl},${otherReturnUrl}`;
    process.env.ONBOARDING_ENABLED = 'true'; process.env.HOSTING_LIGHTNING_ENABLED = 'true';
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name, max: 20 }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    config.adminNpub = admin;
    config.service.npub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(86)));
    invite = await createInvite({ max_admissions: 500 }, admin, D());
  });
  afterAll(async () => {
    configureLightningProvider(null);
    delete process.env.ONBOARDING_ENABLED; delete process.env.HOSTING_LIGHTNING_ENABLED;
    config.adminNpub = saved.admin; config.service.npub = saved.service; await closeDb();
  });

  test('same intent, different keys, same method: one provider order and one canonical attempt (card)', async () => {
    const a = await start('Card Reuse'), stripe = new FakeStripe();
    expect((await readIntent(a.intent.id, a.owner, D())).payment_attempt).toBeNull();
    const results = await Promise.all(Array.from({ length: 8 }, () => checkout(a, stripe)));
    expect(new Set(results.map(r => r.order_id)).size).toBe(1);
    expect(new Set(results.map(r => r.checkout_url)).size).toBe(1);
    expect(results.filter((r: any) => !r.reused).length).toBe(1);
    expect(stripe.createCalls).toBe(1);
    expect((await rows(a.intent.id)).orders).toBe(1);
    const view = (await readIntent(a.intent.id, a.owner, D())).payment_attempt!;
    expect(view).toMatchObject({ method: 'card', state: 'open', resume: 'checkout', order_id: results[0]!.order_id, quote_id: null, amount_cents: 2100, count: 1 });
    // The DTO carries no idempotency key or provider detail.
    expect(JSON.stringify(view)).not.toMatch(/idempotency|session|cs_test|secret/);
  });

  test('same intent, different keys: one Lightning quote and one provider invoice', async () => {
    const a = await start('LN Reuse'), f = new FakeLightning();
    const results = await Promise.all(Array.from({ length: 8 }, () => issueLightningQuoteResult(a.intent.id, a.owner, { idempotency_key: key() }, D(), f)));
    expect(new Set(results.map(r => r.quote.id)).size).toBe(1);
    expect(results.filter(r => !r.reused).length).toBe(1);
    expect(f.byOrder.size).toBe(1);
    expect((await rows(a.intent.id)).quotes).toBe(1);
    const view = (await readIntent(a.intent.id, a.owner, D())).payment_attempt!;
    expect(view).toMatchObject({ method: 'lightning', state: 'open', resume: 'lightning_quote', quote_id: results[0]!.quote.id, order_id: null, quote: { id: results[0]!.quote.id, state: 'open' } });
  });

  test('card versus Lightning race creates exactly one payable attempt, and the loser never reaches its provider', async () => {
    for (let round = 0; round < 6; round++) {
      const a = await start(`Race ${round}`), stripe = new FakeStripe(), f = new FakeLightning();
      const [card, ln] = await Promise.allSettled([checkout(a, stripe), issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), f)]);
      const wins = [card, ln].filter(r => r.status === 'fulfilled').length;
      expect(wins).toBe(1);
      const loser = (card.status === 'rejected' ? card : ln) as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ code: 'payment_attempt_outstanding' });
      expect(loser.reason.detail.payment_attempt).toMatchObject({ method: card.status === 'fulfilled' ? 'card' : 'lightning' });
      expect(stripe.createCalls + f.issueCalls).toBe(1);
      const counts = await rows(a.intent.id);
      expect(counts.orders + counts.quotes).toBe(1);
    }
  });

  test('another method already outstanding is refused before any provider call, even with a fresh key', async () => {
    const a = await start('Refuse Other'), stripe = new FakeStripe(), f = new FakeLightning();
    await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), f);
    await expect(checkout(a, stripe)).rejects.toMatchObject({ code: 'payment_attempt_outstanding' });
    expect(stripe.createCalls).toBe(0);
    const b = await start('Refuse Other 2');
    await checkout(b, stripe);
    const before = f.issueCalls;
    await expect(issueLightningQuote(b.intent.id, b.owner, { idempotency_key: key() }, D(), f)).rejects.toMatchObject({ code: 'payment_attempt_outstanding' });
    expect(f.issueCalls).toBe(before);
  });

  test('lost provider response and new-device resume: an issuing attempt is outstanding and is completed, never duplicated', async () => {
    const a = await start('Lost Lightning'), f = new FakeLightning();
    f.failIssue = true;
    await expect(issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), f)).rejects.toThrow();
    const seen = (await readIntent(a.intent.id, a.owner, D())).payment_attempt!;
    expect(seen).toMatchObject({ method: 'lightning', state: 'issuing', resume: 'lightning_quote' });
    // A different device with a different key (and a card attempt) cannot create a second payable attempt while issuing.
    const stripe = new FakeStripe();
    await expect(checkout(a, stripe)).rejects.toMatchObject({ code: 'payment_attempt_outstanding' });
    f.failIssue = false;
    const resumed = await issueLightningQuoteResult(a.intent.id, a.owner, { idempotency_key: key() }, D(), f);
    expect(resumed).toMatchObject({ reused: true, quote: { id: seen.quote_id, state: 'open' } });
    expect(f.byOrder.size).toBe(1);

    const b = await start('Lost Card'), s2 = new FakeStripe();
    s2.failNextCreate = true;
    await expect(checkout(b, s2)).rejects.toThrow();
    const orderSeen = (await readIntent(b.intent.id, b.owner, D())).payment_attempt!;
    expect(orderSeen).toMatchObject({ method: 'card', state: 'issuing', resume: 'checkout' });
    const resumedCard: any = await checkout(b, s2);
    expect(resumedCard).toMatchObject({ order_id: orderSeen.order_id, reused: true });
    expect(s2.createCalls).toBe(1);
    expect((await readIntent(b.intent.id, b.owner, D())).payment_attempt).toMatchObject({ state: 'open', order_id: orderSeen.order_id });
  });

  test('same-key body conflicts and owner binding are preserved; a foreign owner never sees or reuses an attempt', async () => {
    const a = await start('Conflicts'), stripe = new FakeStripe(), f = new FakeLightning();
    const k = key();
    await createHostingCheckout(a.intent.account_id, { amount_cents: 2100, idempotency_key: k, return_url: returnUrl }, D(), stripe.asClient, { intentId: a.intent.id });
    await expect(createHostingCheckout(a.intent.account_id, { amount_cents: 2100, idempotency_key: k, return_url: otherReturnUrl }, D(), stripe.asClient, { intentId: a.intent.id })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const same: any = await createHostingCheckout(a.intent.account_id, { amount_cents: 2100, idempotency_key: k, return_url: returnUrl }, D(), stripe.asClient, { intentId: a.intent.id });
    expect(same.reused).toBe(false);
    // The amount is bound to the intent: a stale or forged amount never creates an order.
    await expect(createHostingCheckout(a.intent.account_id, { amount_cents: 5000, idempotency_key: key(), return_url: returnUrl }, D(), stripe.asClient, { intentId: a.intent.id })).rejects.toMatchObject({ code: 'intent_amount_changed' });
    const b = await start('Conflicts B');
    const lk = key();
    await issueLightningQuote(b.intent.id, b.owner, { idempotency_key: lk }, D(), f);
    const c = { owner: b.owner, intent: (await createIntent(b.owner, { client_request_key: key(), invite_code: invite.code, workspace_name: 'Conflicts C', funding_cents: 2100 }, D())).intent };
    // Another identity cannot reuse, see or conflict into this intent.
    const stranger = newNpub();
    await expect(readIntent(b.intent.id, stranger, D())).rejects.toMatchObject({ code: 'intent_not_found' });
    await expect(issueLightningQuote(b.intent.id, stranger, { idempotency_key: key() }, D(), f)).rejects.toMatchObject({ code: 'intent_not_found' });
    await expect(releasePaymentAttempt(b.intent.id, stranger, D())).rejects.toMatchObject({ code: 'intent_not_found' });
    // The same key from the same owner for another intent is a body conflict, never a cross-intent reuse.
    await expect(issueLightningQuote(c.intent.id, c.owner, { idempotency_key: lk }, D(), f)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect((await rows(c.intent.id)).quotes).toBe(0);
  });

  test('amount edits are refused while an attempt is outstanding, including an issuing one, and allowed once verified terminal', async () => {
    const a = await start('Edit Block'), f = new FakeLightning();
    f.failIssue = true;
    await expect(issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), f)).rejects.toThrow();
    f.failIssue = false;
    const fresh = await readIntent(a.intent.id, a.owner, D());
    await expect(updateIntent(a.intent.id, a.owner, { expected_revision: fresh.revision, funding_cents: 5000 }, D())).rejects.toMatchObject({ code: 'payment_attempt_outstanding', detail: { payment_attempt: { state: 'issuing' } } });
    // Non-amount edits and an unchanged amount remain allowed.
    const renamed = await updateIntent(a.intent.id, a.owner, { expected_revision: fresh.revision, workspace_name: 'Edit Block Renamed', funding_cents: 2100 }, D());
    expect(renamed.funding_cents).toBe(2100);
    const quote = (await issueLightningQuoteResult(a.intent.id, a.owner, { idempotency_key: key() }, D(), f)).quote;
    f.expire(f.byOrder.get(quote.id).paymentHash);
    expect((await resolveLightningQuote(quote.id, D(), f)).state).toBe('expired');
    const after = await readIntent(a.intent.id, a.owner, D());
    expect(after.payment_attempt).toBeNull();
    expect((await updateIntent(a.intent.id, a.owner, { expected_revision: after.revision, funding_cents: 5000 }, D())).funding_cents).toBe(5000);
    // The next quote is bound to the new amount.
    expect((await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), f)).amount_cents).toBe(5000);
  });

  test('a local clock never releases an attempt; only provider-verified terminal or settled state permits the next action', async () => {
    const a = await start('Clock'), f = new FakeLightning(); f.cancelSupported = false;
    const q1 = await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), f);
    await db`UPDATE hosting_lightning_quotes SET expires_at=now()-interval '1 hour' WHERE id=${q1.id}`;
    // Locally expired, provider still pending and unable to cancel: still the one outstanding attempt.
    const again = await issueLightningQuoteResult(a.intent.id, a.owner, { idempotency_key: key() }, D(), f);
    expect(again).toMatchObject({ reused: true, quote: { id: q1.id } });
    const stripe = new FakeStripe();
    await expect(checkout(a, stripe)).rejects.toMatchObject({ code: 'payment_attempt_outstanding' });
    // An unreachable provider never releases it through the explicit route either.
    f.lookupFails = true;
    configureLightningProvider(f);
    expect((await releasePaymentAttempt(a.intent.id, a.owner, D(), resolver(stripe))).payment_attempt).toMatchObject({ quote_id: q1.id });
    f.lookupFails = false;
    // Provider-verified expiry releases it; the other method may then start.
    f.expire(f.byOrder.get(q1.id).paymentHash);
    expect((await releasePaymentAttempt(a.intent.id, a.owner, D(), resolver(stripe))).payment_attempt).toBeNull();
    const card: any = await checkout(a, stripe);
    expect(card.reused).toBe(false);

    // Card: release asks the provider to expire the open session; only the verified expiry clears it.
    stripe.retrieveFails = true;
    const stuck = await releasePaymentAttempt(a.intent.id, a.owner, D(), resolver(stripe));
    expect(stuck.payment_attempt).toMatchObject({ method: 'card', order_id: card.order_id });
    stripe.retrieveFails = false;
    expect((await releasePaymentAttempt(a.intent.id, a.owner, D(), resolver(stripe))).payment_attempt).toBeNull();
    const next = await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), f);
    expect(next.id).not.toBe(q1.id);
  });

  test('settled attempts fund the intent once; a paid reused order is credited and no second attempt can be created', async () => {
    const a = await start('Settled'), stripe = new FakeStripe();
    const first: any = await checkout(a, stripe);
    const session = stripe.pay([...stripe.sessions.keys()][0]!);
    // Payment is discovered through release (as if the webhook was lost): credited once, intent funded.
    const released = await releasePaymentAttempt(a.intent.id, a.owner, D(), resolver(stripe));
    expect(released).toMatchObject({ status: 'funded', funded: true, payment_attempt: null });
    expect(await paidUnits(a.intent.account_id)).toBeGreaterThan(0n);
    // Replays, a webhook and concurrent fulfilment never double credit.
    await Promise.all([fulfillHostingCheckout(session, D()), fulfillHostingCheckout(session, D()), releasePaymentAttempt(a.intent.id, a.owner, D(), resolver(stripe))]);
    expect(await credits(a.intent.account_id)).toBe(1);
    await expect(checkout(a, stripe)).rejects.toMatchObject({ code: 'intent_not_open' });
    await expect(issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), new FakeLightning())).rejects.toMatchObject({ code: 'intent_not_open' });
    expect(first.order_id).toBeTruthy();

    // A paid session discovered by a reused request is credited and refused as a new attempt.
    const b = await start('Settled Reuse'), s2 = new FakeStripe();
    await checkout(b, s2);
    s2.pay([...s2.sessions.keys()][0]!);
    await expect(checkout(b, s2)).rejects.toMatchObject({ code: 'intent_not_open' });
    expect((await readIntent(b.intent.id, b.owner, D())).funded).toBe(true);
    expect(await credits(b.intent.account_id)).toBe(1);

    // A provider-verified expired reused order is marked terminal and the retried request creates the replacement.
    const c = await start('Expired Reuse'), s3 = new FakeStripe();
    const old: any = await checkout(c, s3);
    s3.sessions.get([...s3.sessions.keys()][0]!).status = 'expired';
    const replacement: any = await checkout(c, s3);
    expect(replacement.order_id).not.toBe(old.order_id);
    expect(s3.createCalls).toBe(2);
    expect((await db`SELECT terminal_reason FROM hosting_checkout_orders WHERE id=${old.order_id}`)[0]!.terminal_reason).toBe('expired');

    // Lightning settles once as well.
    const d = await start('Settled LN'), f = new FakeLightning();
    const q = await issueLightningQuote(d.intent.id, d.owner, { idempotency_key: key() }, D(), f);
    f.pay(q.payment_hash!);
    const settled = await Promise.all(Array.from({ length: 6 }, () => resolveLightningQuote(q.id, D(), f)));
    expect(settled.every(r => r.state === 'settled')).toBe(true);
    expect(await credits(d.intent.account_id)).toBe(1);
    expect((await readIntent(d.intent.id, d.owner, D())).payment_attempt).toBeNull();
  });

  test('legacy ambiguous or conflicting rows fail closed to support: nothing is chosen and nothing new is created', async () => {
    const a = await start('Legacy'), stripe = new FakeStripe(), f = new FakeLightning();
    // Pre-existing rows from before this guard: a card order and a Lightning quote for the same intent.
    await db`INSERT INTO hosting_checkout_orders(account_id,idempotency_key,amount_cents,return_url,mode,intent_id) VALUES(${a.intent.account_id},${key()},2100,${returnUrl},'test',${a.intent.id})`;
    await db`INSERT INTO hosting_lightning_quotes(account_id,intent_id,idempotency_key,request_sha256,amount_cents) VALUES(${a.intent.account_id},${a.intent.id},${key()},'x',2100)`;
    const view = (await readIntent(a.intent.id, a.owner, D())).payment_attempt!;
    expect(view).toMatchObject({ method: null, state: 'ambiguous', resume: 'support', order_id: null, quote_id: null, count: 2 });
    await expect(checkout(a, stripe)).rejects.toMatchObject({ code: 'payment_attempt_ambiguous' });
    await expect(issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), f)).rejects.toMatchObject({ code: 'payment_attempt_ambiguous' });
    expect(stripe.createCalls + f.issueCalls).toBe(0);
    expect(await rows(a.intent.id)).toEqual({ orders: 1, quotes: 1 });
    const fresh = await readIntent(a.intent.id, a.owner, D());
    await expect(updateIntent(a.intent.id, a.owner, { expected_revision: fresh.revision, funding_cents: 5000 }, D())).rejects.toMatchObject({ code: 'payment_attempt_outstanding' });
    // Two legacy card orders are equally ambiguous.
    const b = await start('Legacy Cards');
    for (let i = 0; i < 2; i++) await db`INSERT INTO hosting_checkout_orders(account_id,idempotency_key,amount_cents,return_url,mode,intent_id) VALUES(${b.intent.account_id},${key()},2100,${returnUrl},'test',${b.intent.id})`;
    await expect(checkout(b, stripe)).rejects.toMatchObject({ code: 'payment_attempt_ambiguous' });
    expect((await rows(b.intent.id)).orders).toBe(2);
  });

  test('independent account top-ups are not limited by an intent attempt', async () => {
    const a = await start('Topup Independent'), stripe = new FakeStripe();
    await checkout(a, stripe);
    const topup = (idem: string) => createHostingCheckout(a.intent.account_id, { amount_cents: 2100, idempotency_key: idem, return_url: returnUrl }, D(), stripe.asClient, { topup: true });
    const one: any = await topup(key()), two: any = await topup(key());
    expect(one.order_id).not.toBe(two.order_id);
    expect(one.reused).toBeUndefined();
    expect((await readIntent(a.intent.id, a.owner, D())).payment_attempt).toMatchObject({ method: 'card', count: 1 });
  });

  test('HTTP contract: payment_attempt on intents, 200 reuse, 409 payload, release route', async () => {
    const f = new FakeLightning(); configureLightningProvider(f);
    const sk = newKey(), owner = nip19.npubEncode(getPublicKey(sk));
    const created = await call('POST', '/intents', sk, { client_request_key: key(), invite_code: invite.code, workspace_name: 'HTTP Attempt', funding_cents: 2100 });
    expect(created.status).toBe(201);
    expect(created.json.intent.payment_attempt).toBeNull();
    const id = created.json.intent.id as string;
    const q1 = await call('POST', `/intents/${id}/lightning/quote`, sk, { idempotency_key: key() });
    expect(q1.status).toBe(201); expect(q1.json.reused).toBe(false);
    const q2 = await call('POST', `/intents/${id}/lightning/quote`, sk, { idempotency_key: key() });
    expect(q2.status).toBe(200); expect(q2.json).toMatchObject({ reused: true, quote: { id: q1.json.quote.id } });
    const got = await call('GET', `/intents/${id}`, sk);
    expect(got.json.intent.payment_attempt).toMatchObject({ method: 'lightning', state: 'open', quote_id: q1.json.quote.id, resume: 'lightning_quote' });
    const list = await call('GET', '/intents', sk);
    expect(list.json.intents[0].payment_attempt.quote_id).toBe(q1.json.quote.id);
    const edit = await call('POST', `/intents/${id}/options`, sk, { expected_revision: got.json.intent.revision, funding_cents: 5000 });
    expect(edit.status).toBe(409); expect(edit.json).toMatchObject({ code: 'payment_attempt_outstanding', payment_attempt: { quote_id: q1.json.quote.id } });
    // A foreign identity gets neutral 404s, never the attempt.
    const fk = newKey();
    expect((await call('GET', `/intents/${id}`, fk)).status).toBe(404);
    expect((await call('POST', `/intents/${id}/payment-attempt/release`, fk)).status).toBe(404);
    const released = await call('POST', `/intents/${id}/payment-attempt/release`, sk);
    expect(released.status).toBe(200);
    expect(released.json.intent.payment_attempt).toBeNull();
    void owner;
  });

  test('locking: concurrent create, settle, edit, cancel and refresh never deadlock or double credit', async () => {
    const f = new FakeLightning(); configureLightningProvider(f);
    const work = Array.from({ length: 6 }, async (_, i) => {
      const a = await start(`Stress ${i}`), stripe = new FakeStripe();
      const q = await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), f);
      f.pay(q.payment_hash!);
      const settle = Array.from({ length: 3 }, () => resolveLightningQuote(q.id, D(), f));
      const creators = Array.from({ length: 3 }, () => issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, D(), f));
      const cards = Array.from({ length: 2 }, () => checkout(a, stripe));
      const edits = [readIntent(a.intent.id, a.owner, D()).then(v => updateIntent(a.intent.id, a.owner, { expected_revision: v.revision, funding_cents: 3000 }, D()))];
      const cancel = [cancelIntent(a.intent.id, a.owner, D(), resolver(stripe))];
      const settled = await Promise.allSettled([...settle, ...creators, ...cards, ...edits, ...cancel]);
      for (const r of settled) if (r.status === 'rejected') expect(String((r.reason as any)?.message ?? r.reason)).not.toMatch(/deadlock/i);
      expect(await credits(a.intent.account_id)).toBeLessThanOrEqual(1);
      const counts = await rows(a.intent.id);
      expect(counts.orders + counts.quotes).toBeLessThanOrEqual(1);
    });
    await Promise.all(work);
  }, 60_000);
});
