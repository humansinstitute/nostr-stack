import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { configureLightningProvider, type LightningProvider } from '../src/services/hosting-lightning';
import { createTopupCheckout, issueTopupQuote, listTopups, refreshTopupQuote } from '../src/services/hosting-topup';
import { createIntent, createInvite, openOwnerAccount, provisionIntent } from '../src/services/onboarding';
import { USD_UNITS } from '../src/services/hosting-billing';
import { buildOpenApiDocument } from '../src/openapi';

// Runs only against a dedicated disposable PostgreSQL: TOPUP_TEST_PORT=<free port>.
const port = Number(process.env.TOPUP_TEST_PORT);
const keys = Array.from({ length: 5 }, () => randomBytes(32));
const [adminKey, aliceKey, bobKey, carolKey] = keys as [Buffer, Buffer, Buffer, Buffer];
const [admin, alice, bob, carol] = keys.map(k => nip19.npubEncode(getPublicKey(k))) as [string, string, string, string];
void adminKey;
const app = createApp();
const returnUrl = 'https://example.test/billing';
const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

/** Fixture-only Lightning provider honouring the NStack port. */
class FakeLightning implements LightningProvider {
  id = 'fixture'; payeeRef = 'fixture-payee'; byOrder = new Map<string, any>(); invoices = new Map<string, any>(); issueCalls = 0;
  async issueInvoice(req: { orderRef: string; amountCents: number }) {
    this.issueCalls++;
    if (!this.byOrder.has(req.orderRef)) {
      const preimage = randomBytes(32).toString('hex'), hash = sha(preimage);
      const r = { paymentHash: hash, preimage, invoice: `lnbc${hash.slice(0, 40)}fixture${hash.slice(40)}`, amountSats: req.amountCents * 25, payeeRef: this.payeeRef,
        expiresAt: new Date(Date.now() + 900_000).toISOString(), rate: { source: 'fixture-fx', quotedAt: new Date(Date.now() - 1000).toISOString() }, status: 'pending', received: 0, settledAt: undefined as string | undefined };
      this.byOrder.set(req.orderRef, r); this.invoices.set(hash, r);
    }
    const r = this.byOrder.get(req.orderRef);
    return { invoice: r.invoice, paymentHash: r.paymentHash, amountSats: r.amountSats, expiresAt: r.expiresAt, payeeRef: r.payeeRef, rate: r.rate };
  }
  async lookupInvoice(hash: string) {
    const r = this.invoices.get(hash)!;
    return { status: r.status, paymentHash: hash, payeeRef: r.payeeRef, amountSatsReceived: r.received || undefined, settledAt: r.settledAt, preimage: r.status === 'settled' ? r.preimage : undefined };
  }
  pay(hash: string) { Object.assign(this.invoices.get(hash)!, { status: 'settled', received: this.invoices.get(hash)!.amountSats, settledAt: new Date().toISOString() }); }
}

describe.skipIf(!port || port === 5432)('repeat account top-ups on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_topup_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  const saved = { admin: config.adminNpub, service: config.service.npub };
  let invite: { id: string; code: string };
  let n = 0;
  const key = () => `req-${process.pid}-${++n}-${randomUUID().slice(0, 8)}`;
  const ln = new FakeLightning();
  const paid = (orderId: string, accountId: string, amount: number, id: string, intent = `pi_${randomUUID()}`) =>
    ({ id, mode: 'payment', livemode: false, payment_status: 'paid', currency: 'usd', amount_total: amount, payment_intent: intent, client_reference_id: orderId, metadata: { hosting_order_id: orderId, hosting_account_id: accountId } }) as unknown as Stripe.Checkout.Session;
  const stripeDouble = (id = `cs_test_${randomUUID()}`) => ({ checkout: { sessions: { create: async () => ({ id, url: 'https://checkout.stripe.com/test', livemode: false }), retrieve: async () => ({ id, url: 'https://checkout.stripe.com/test', livemode: false }) } } }) as any;
  const paidUnits = async (accountId: string) => BigInt((await db`SELECT paid_units FROM hosting_accounts WHERE id=${accountId}`)[0]!.paid_units);
  const counts = async (accountId: string) => ({
    intents: (await db`SELECT 1 FROM onboarding_intents WHERE account_id=${accountId}`).length,
    links: (await db`SELECT 1 FROM hosting_workspace_accounts WHERE account_id=${accountId}`).length,
    enrollments: (await db`SELECT 1 FROM hosting_storage_enrollments WHERE account_id=${accountId}`).length,
    workspaces: (await db`SELECT 1 FROM flightdeck_pg_workspaces WHERE workspace_owner_npub IN (SELECT npub FROM flightdeck_pg_actors WHERE id=(SELECT owner_actor_id FROM hosting_accounts WHERE id=${accountId}))`).length,
    seats: (await db`SELECT 1 FROM onboarding_invite_seats WHERE owner_actor_id=(SELECT owner_actor_id FROM hosting_accounts WHERE id=${accountId})`).length,
  });
  async function provisioned(owner: string, label: string) {
    const { intent } = await createIntent(owner, { client_request_key: key(), invite_code: invite.code, workspace_name: label, funding_cents: 2100 }, db as any);
    const double = stripeDouble();
    const checkout = await createHostingCheckout(intent.account_id, { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl }, db as any, double, { intentId: intent.id });
    const [order] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${checkout.order_id}`;
    await fulfillHostingCheckout(paid(order!.id, order!.account_id, 2100, (await double.checkout.sessions.retrieve()).id), db as any);
    return provisionIntent(intent.id, owner, db as any);
  }
  async function call(method: 'GET' | 'POST', path: string, signer?: Uint8Array, body?: unknown) {
    const url = `http://localhost/api/v4/onboarding${path}`;
    const raw = body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (signer) {
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(), tags: [['u', url], ['method', method], ...(raw ? [['payload', createHash('sha256').update(raw).digest('hex')]] : [])] }, signer);
      headers.Authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
    }
    const response = await app.request(url, { method, headers, body: raw });
    return { status: response.status, json: (await response.json().catch(() => ({}))) as any };
  }

  beforeAll(async () => {
    process.env.HOSTING_STRIPE_RETURN_URLS = returnUrl;
    process.env.ONBOARDING_ENABLED = 'true';
    process.env.HOSTING_LIGHTNING_ENABLED = 'true';
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    config.adminNpub = admin;
    config.service.npub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(86)));
    configureLightningProvider(ln);
    invite = await createInvite({ max_admissions: 10 }, admin, db as any);
  });
  afterAll(async () => {
    delete process.env.ONBOARDING_ENABLED; delete process.env.HOSTING_LIGHTNING_ENABLED; configureLightningProvider(null);
    config.adminNpub = saved.admin; config.service.npub = saved.service; await closeDb();
  });

  test('requires an owned, provisioned account; nothing is created for others', async () => {
    await expect(createTopupCheckout(carol, { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl }, db as any, stripeDouble())).rejects.toMatchObject({ code: 'account_not_found' });
    await openOwnerAccount(carol, db as any);
    await expect(createTopupCheckout(carol, { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl }, db as any, stripeDouble())).rejects.toMatchObject({ code: 'account_not_provisioned' });
    await expect(issueTopupQuote(carol, { amount_cents: 2100, idempotency_key: key() }, db as any, ln)).rejects.toMatchObject({ code: 'account_not_provisioned' });
    expect((await call('GET', '/topups')).status).toBe(401);
    expect((await call('POST', '/topups/checkout', undefined, { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl })).status).toBe(401);
    expect((await call('GET', '/topups', carolKey)).status).toBe(409);
  });

  test('a failed or partial provisioning is not post-provisioning: no top-up until activation', async () => {
    const dave = nip19.npubEncode(getPublicKey(randomBytes(32)));
    const { intent } = await createIntent(dave, { client_request_key: key(), invite_code: invite.code, workspace_name: 'Partial Dave', funding_cents: 2100 }, db as any);
    const double = stripeDouble();
    const checkout = await createHostingCheckout(intent.account_id, { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl }, db as any, double, { intentId: intent.id });
    const [order] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${checkout.order_id}`;
    await fulfillHostingCheckout(paid(order!.id, order!.account_id, 2100, (await double.checkout.sessions.retrieve()).id), db as any);
    const attempt = { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl };
    // Funded but nothing provisioned.
    await expect(createTopupCheckout(dave, attempt, db as any, stripeDouble())).rejects.toMatchObject({ code: 'account_not_provisioned' });
    // Workspace exists but the billing step failed: still no top-up path.
    await expect(provisionIntent(intent.id, dave, db as any, { beforeStep: s => { if (s === 'billing_link') throw new Error('fixture failure'); } })).rejects.toMatchObject({ code: 'provisioning_step_failed' });
    await expect(createTopupCheckout(dave, attempt, db as any, stripeDouble())).rejects.toMatchObject({ code: 'account_not_provisioned' });
    // A billing link with an enrollment that was never activated is not provisioned either.
    const [row] = await db`SELECT workspace_id FROM onboarding_intents WHERE id=${intent.id}`;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${row!.workspace_id},${intent.account_id})`;
    await db`INSERT INTO hosting_storage_enrollments(workspace_id,account_id,origin_intent_id) VALUES(${row!.workspace_id},${intent.account_id},${intent.id})`;
    await expect(issueTopupQuote(dave, { amount_cents: 2100, idempotency_key: key() }, db as any, ln)).rejects.toMatchObject({ code: 'account_not_provisioned' });
    expect((await call('GET', '/topups', undefined)).status).toBe(401);
    // Completing provisioning (activation) opens the path.
    await provisionIntent(intent.id, dave, db as any);
    await expect(createTopupCheckout(dave, attempt, db as any, stripeDouble())).resolves.toMatchObject({ amount_cents: 2100 });
  });

  test('Stripe: repeat top-ups credit once per verified payment, with no intent, workspace, seat or introduction', async () => {
    const ws = await provisioned(alice, 'Topup Alice');
    const before = await counts(ws.account_id), balance = await paidUnits(ws.account_id);
    const [enrollmentBefore] = await db`SELECT intro_ends_at,activated_at FROM hosting_storage_enrollments WHERE account_id=${ws.account_id}`;
    const bad = [{ amount_cents: 2099 }, { amount_cents: 1_000_001 }, { amount_cents: 12.5 }, { amount_cents: '2100' }];
    for (const b of bad) await expect(createTopupCheckout(alice, { ...b, idempotency_key: key(), return_url: returnUrl }, db as any, stripeDouble())).rejects.toMatchObject({ code: 'invalid_checkout' });
    await expect(createTopupCheckout(alice, { amount_cents: 2100, idempotency_key: key(), return_url: 'https://evil.test' }, db as any, stripeDouble())).rejects.toMatchObject({ code: 'return_url_not_allowed' });

    const sid = `cs_test_${randomUUID()}`, double = stripeDouble(sid), k = key();
    const body = { amount_cents: 2234, idempotency_key: k, return_url: returnUrl };
    const first = await createTopupCheckout(alice, body, db as any, double);
    expect((await createTopupCheckout(alice, body, db as any, double)).order_id).toBe(first.order_id);
    await expect(createTopupCheckout(alice, { ...body, amount_cents: 2235 }, db as any, double)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const [order] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${first.order_id}`;
    expect(order!.intent_id).toBeNull();
    expect((await listTopups(alice, db as any)).pending_checkout.map(o => o.order_id)).toEqual([order!.id]);

    // Unpaid or mismatched evidence credits nothing; verified payment credits exactly once under concurrent and replayed delivery.
    expect(await fulfillHostingCheckout({ ...paid(order!.id, order!.account_id, 2234, sid), payment_status: 'unpaid' } as any, db as any)).toEqual({ credited: false });
    await expect(fulfillHostingCheckout(paid(order!.id, order!.account_id, 1200, sid), db as any)).rejects.toThrow('stripe_binding_mismatch');
    expect(await paidUnits(ws.account_id)).toBe(balance);
    const session = paid(order!.id, order!.account_id, 2234, sid);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => fulfillHostingCheckout(session, db as any)));
    expect(outcomes.filter(o => o.credited).length).toBe(1);
    await fulfillHostingCheckout(session, db as any);
    expect(await paidUnits(ws.account_id)).toBe(balance + 2234n * (USD_UNITS / 100n));
    expect((await db`SELECT 1 FROM hosting_ledger WHERE account_id=${ws.account_id} AND kind='stripe'`).length).toBe(2);

    // A second top-up on the same account compounds; a payment reference cannot be reused by a different order.
    const sid2 = `cs_test_${randomUUID()}`, second = await createTopupCheckout(alice, { amount_cents: 2500, idempotency_key: key(), return_url: returnUrl }, db as any, stripeDouble(sid2));
    const [order2] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${second.order_id}`;
    await expect(fulfillHostingCheckout(paid(order2!.id, order2!.account_id, 2500, sid2, session.payment_intent as string), db as any)).rejects.toThrow('settlement_binding_conflict');
    await fulfillHostingCheckout(paid(order2!.id, order2!.account_id, 2500, sid2), db as any);
    expect(await paidUnits(ws.account_id)).toBe(balance + 4734n * (USD_UNITS / 100n));

    expect(await counts(ws.account_id)).toEqual(before);
    const [enrollmentAfter] = await db`SELECT intro_ends_at,activated_at FROM hosting_storage_enrollments WHERE account_id=${ws.account_id}`;
    expect(enrollmentAfter).toEqual(enrollmentBefore);
    const listed = await listTopups(alice, db as any);
    expect(listed.pending_checkout).toEqual([]);
    expect(listed.credited.filter(c => c.method === 'stripe').map(c => c.amount_cents).sort((a, b) => a - b)).toEqual([2234, 2500]); // the intent-funding payment is not a top-up
  });

  test('Lightning: quote, verified settlement credits once; late, short or forged payments never credit; replay is safe', async () => {
    const ws = await provisioned(bob, 'Topup Bob');
    const before = await counts(ws.account_id), balance = await paidUnits(ws.account_id);
    await expect(issueTopupQuote(bob, { amount_cents: 2000, idempotency_key: key() }, db as any, ln)).rejects.toMatchObject({ code: 'invalid_quote_request' });
    await expect(issueTopupQuote(bob, { amount_cents: 2100, idempotency_key: key(), extra: 1 }, db as any, ln)).rejects.toMatchObject({ code: 'invalid_quote_request' });
    const k = key();
    const [a, b] = await Promise.all([issueTopupQuote(bob, { amount_cents: 2500, idempotency_key: k }, db as any, ln), issueTopupQuote(bob, { amount_cents: 2500, idempotency_key: k }, db as any, ln)]);
    expect(a.id).toBe(b.id); expect(a.intent_id).toBeNull(); expect(a.state).toBe('open'); expect(a.amount_sats).toBe(62500);
    await expect(issueTopupQuote(bob, { amount_cents: 2600, idempotency_key: k }, db as any, ln)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    // Unpaid refresh credits nothing.
    expect((await refreshTopupQuote(bob, a.id, db as any, ln)).state).toBe('open');
    expect(await paidUnits(ws.account_id)).toBe(balance);
    expect((await listTopups(bob, db as any)).pending_lightning.map(q => q.quote_id)).toEqual([a.id]);
    // Another owner cannot read or settle it (neutral 404).
    await expect(refreshTopupQuote(alice, a.id, db as any, ln)).rejects.toMatchObject({ code: 'quote_not_found' });
    ln.pay(a.payment_hash!);
    const results = await Promise.all(Array.from({ length: 6 }, () => refreshTopupQuote(bob, a.id, db as any, ln)));
    expect(results.every(r => r.state === 'settled')).toBe(true);
    await refreshTopupQuote(bob, a.id, db as any, ln);
    expect(await paidUnits(ws.account_id)).toBe(balance + 2500n * (USD_UNITS / 100n));
    expect((await db`SELECT 1 FROM hosting_ledger WHERE account_id=${ws.account_id} AND kind='lightning'`).length).toBe(1);
    expect((await db`SELECT intent_id FROM hosting_funding_settlements WHERE account_id=${ws.account_id} AND method='lightning'`)[0]!.intent_id).toBeNull();
    // Short payment is a mismatch, never credit.
    const short = await issueTopupQuote(bob, { amount_cents: 2800, idempotency_key: key() }, db as any, ln);
    ln.invoices.get(short.payment_hash!).status = 'settled'; ln.invoices.get(short.payment_hash!).received = short.amount_sats! - 1; ln.invoices.get(short.payment_hash!).settledAt = new Date().toISOString();
    expect((await refreshTopupQuote(bob, short.id, db as any, ln)).state).toBe('mismatch');
    // Payment after expiry is recorded for support, not credited.
    const late = await issueTopupQuote(bob, { amount_cents: 2700, idempotency_key: key() }, db as any, ln);
    ln.pay(late.payment_hash!); ln.invoices.get(late.payment_hash!).settledAt = new Date(Date.now() + 3_600_000).toISOString();
    expect((await refreshTopupQuote(bob, late.id, db as any, ln)).state).toBe('late_payment');
    expect(await paidUnits(ws.account_id)).toBe(balance + 2500n * (USD_UNITS / 100n));
    expect(await counts(ws.account_id)).toEqual(before);
    // Open-quote cap.
    await provisioned(carol, 'Topup Carol');
    for (let i = 0; i < 5; i++) await issueTopupQuote(carol, { amount_cents: 2600, idempotency_key: key() }, db as any, ln);
    await expect(issueTopupQuote(carol, { amount_cents: 2600, idempotency_key: key() }, db as any, ln)).rejects.toMatchObject({ code: 'too_many_open_topup_quotes' });
  });

  test('a topup quote and an intent quote cannot be confused: an intent idempotency key never replays as a topup', async () => {
    const ws = await provisioned(alice, 'Topup Alice Two');
    const k = key();
    await db`INSERT INTO hosting_lightning_quotes(account_id,intent_id,idempotency_key,request_sha256,amount_cents) VALUES(${ws.account_id},${ws.id},${k},'x',2100)`;
    await expect(issueTopupQuote(alice, { amount_cents: 2100, idempotency_key: k }, db as any, ln)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const quote = (await db`SELECT id FROM hosting_lightning_quotes WHERE idempotency_key=${k}`)[0]!;
    await expect(refreshTopupQuote(alice, quote.id, db as any, ln)).rejects.toMatchObject({ code: 'quote_not_found' });
  });

  test('top-up resumes a depleted account without side effects; reversal debt is netted first', async () => {
    const ws = await provisioned(bob, 'Topup Bob Two');
    await db`UPDATE hosting_accounts SET paid_units='0',promo_units='0',depleted_at=now() WHERE id=${ws.account_id}`;
    const sid = `cs_test_${randomUUID()}`;
    const order = await createTopupCheckout(bob, { amount_cents: 2600, idempotency_key: key(), return_url: returnUrl }, db as any, stripeDouble(sid));
    const [row] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${order.order_id}`;
    await fulfillHostingCheckout(paid(row!.id, row!.account_id, 2600, sid), db as any);
    const [account] = await db`SELECT paid_units,depleted_at FROM hosting_accounts WHERE id=${ws.account_id}`;
    expect(BigInt(account!.paid_units)).toBe(2600n * (USD_UNITS / 100n)); expect(account!.depleted_at).toBeNull();
    await db`UPDATE hosting_accounts SET paid_units=${(-100n * USD_UNITS).toString()},depleted_at=now() WHERE id=${ws.account_id}`;
    const sid2 = `cs_test_${randomUUID()}`;
    const o2 = await createTopupCheckout(bob, { amount_cents: 2600, idempotency_key: key(), return_url: returnUrl }, db as any, stripeDouble(sid2));
    const [r2] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${o2.order_id}`;
    await fulfillHostingCheckout(paid(r2!.id, r2!.account_id, 2600, sid2), db as any);
    const [after] = await db`SELECT paid_units,depleted_at FROM hosting_accounts WHERE id=${ws.account_id}`;
    expect(BigInt(after!.paid_units)).toBe(-100n * USD_UNITS + 2600n * (USD_UNITS / 100n)); expect(after!.depleted_at).not.toBeNull();
  });

  test('bounded pending checkout lists explicitly distinguish truncation from terminal absence', async () => {
    const owner = nip19.npubEncode(getPublicKey(randomBytes(32)));
    const ws = await provisioned(owner, 'Pending list fixture');
    expect((await listTopups(owner, db as any)).pending_checkout_complete).toBe(true);
    const created: string[] = [];
    for (let i = 0; i < 21; i++) {
      const order = await createTopupCheckout(owner, { amount_cents: 2100, idempotency_key: key(), return_url: returnUrl }, db as any, stripeDouble());
      created.push(order.order_id as string);
      if (i === 19) {
        const full = await listTopups(owner, db as any);
        expect(full.pending_checkout_complete).toBe(true); expect(full.pending_checkout).toHaveLength(20);
      }
    }
    const truncated = await listTopups(owner, db as any);
    expect(truncated.pending_checkout_complete).toBe(false); expect(truncated.pending_checkout).toHaveLength(20);
    const omitted = created.find(id => !truncated.pending_checkout.some(o => o.order_id === id))!;
    expect(omitted).toBeDefined(); // It is still payable despite being absent from this page.
    const [row] = await db`SELECT * FROM hosting_checkout_orders WHERE id=${omitted}`;
    expect(row!.fulfilled_at).toBeNull(); expect(row!.terminal_at).toBeNull();
    await fulfillHostingCheckout(paid(omitted, ws.account_id, 2100, row!.session_id), db as any);
    const complete = await listTopups(owner, db as any);
    expect(complete.pending_checkout_complete).toBe(true); expect(complete.pending_checkout).toHaveLength(20);
    expect(complete.pending_checkout.some(o => o.order_id === omitted)).toBe(false);
  });

  test('config: reports only operator-approved return URLs and real availability, never secrets', async () => {
    // Built at runtime so no credential-bearing URL literal is tracked in source.
    const credentialUrl = ['https://user', ':pw@example.test/x'].join('');
    const saved = { urls: process.env.HOSTING_STRIPE_RETURN_URLS, key: process.env.STRIPE_SECRET_KEY, hook: process.env.STRIPE_WEBHOOK_SECRET };
    expect((await call('GET', '/config', undefined)).status).toBe(401);
    try {
      process.env.HOSTING_STRIPE_RETURN_URLS = `${returnUrl}, ${credentialUrl}, https://example.test/x?y=1, https://example.test/x#f, ftp://example.test/y, http://localhost:3000/ret, http://example.test/plain, not a url, ${returnUrl}`;
      delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
      const off = await call('GET', '/config', bobKey);
      expect(off.status).toBe(200);
      expect(off.json.card.available).toBe(false); // Stripe itself is unconfigured
      expect(off.json.card.return_urls).toEqual([returnUrl, 'http://localhost:3000/ret']);
      process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture';
      const on = await call('GET', '/config', bobKey);
      expect(on.json).toMatchObject({ version: 1, onboarding_enabled: true, funding: { min_cents: 2100, topup_min_cents: 2100, topup_max_cents: 1_000_000 }, card: { available: true, mode: 'test', live_rollout_blocked: true }, lightning: { available: true } });
      expect(JSON.stringify(on.json)).not.toContain('sk_test_fixture');
      expect(JSON.stringify(on.json)).not.toContain('whsec_fixture');
      process.env.HOSTING_STRIPE_RETURN_URLS = credentialUrl;
      expect((await call('GET', '/config', bobKey)).json.card).toMatchObject({ available: false, return_urls: [] });
      process.env.ONBOARDING_ENABLED = 'false';
      expect((await call('GET', '/config', bobKey)).json).toMatchObject({ onboarding_enabled: false, lightning: { available: false } });
    } finally {
      process.env.ONBOARDING_ENABLED = 'true';
      for (const [k, v] of [['HOSTING_STRIPE_RETURN_URLS', saved.urls], ['STRIPE_SECRET_KEY', saved.key], ['STRIPE_WEBHOOK_SECRET', saved.hook]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test('HTTP: human direct signature only; rollout gate closed fails closed; owner reads only own', async () => {
    await provisioned(bob, 'Topup Bob Http');
    const quoteBody = { amount_cents: 2900, idempotency_key: key() };
    const created = await call('POST', '/topups/lightning/quote', bobKey, quoteBody);
    expect(created.status).toBe(201); expect(created.json.quote.intent_id).toBeNull();
    expect((await call('POST', `/topups/lightning/quotes/${created.json.quote.id}/refresh`, aliceKey)).status).toBe(404);
    expect((await call('POST', `/topups/lightning/quotes/${created.json.quote.id}/refresh`, bobKey)).json.quote.state).toBe('open');
    expect((await call('GET', '/topups', bobKey)).json.pending_lightning.some((q: any) => q.quote_id === created.json.quote.id)).toBe(true);
    process.env.ONBOARDING_ENABLED = 'false';
    try {
      expect((await call('POST', '/topups/lightning/quote', bobKey, { amount_cents: 2900, idempotency_key: key() })).json.code).toBe('onboarding_rollout_disabled');
      expect((await call('POST', '/topups/checkout', bobKey, { amount_cents: 2900, idempotency_key: key(), return_url: returnUrl })).json.code).toBe('onboarding_rollout_disabled');
    } finally { process.env.ONBOARDING_ENABLED = 'true'; }
    const paths = buildOpenApiDocument().paths as any;
    for (const p of ['/api/v4/onboarding/topups', '/api/v4/onboarding/topups/checkout', '/api/v4/onboarding/topups/lightning/quote', '/api/v4/onboarding/topups/lightning/quotes/{quoteId}/refresh']) expect(paths[p]).toBeDefined();
  });
});
