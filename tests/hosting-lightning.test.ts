import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { registerFundingReserve } from '../src/services/hosting-funding';
import { configureLightningProvider, issueLightningQuote, reconcileOpenLightningQuotes, requestLightningRefund, resolveLightningQuote, type LightningProvider } from '../src/services/hosting-lightning';
import { cancelIntent, createIntent, createInvite, provisionIntent, readIntent } from '../src/services/onboarding';
import { USD_UNITS } from '../src/services/hosting-billing';

// Runs only against a dedicated disposable PostgreSQL: LIGHTNING_TEST_PORT=<free port>.
const port = Number(process.env.LIGHTNING_TEST_PORT);
const newNpub = () => nip19.npubEncode(getPublicKey(randomBytes(32)));
const admin = newNpub();
const usd = (cents: number) => (BigInt(cents) * (USD_UNITS / 100n)).toString();
const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const PAYEE = 'fixture-payee-node';

/** Fixture-only provider honouring the NStack port. It is never reachable in production: no route, environment value or request registers a provider. */
class FakeLightning implements LightningProvider {
  id = 'fixture'; payeeRef = PAYEE; satsPerCent = 25; ttlMs = 900_000; now = () => new Date();
  invoices = new Map<string, any>(); byOrder = new Map<string, any>(); issueCalls = 0; cancelSupported = true; lookupFails = false; payFails: 'none' | 'definite' | 'unknown' | 'pending' = 'none';
  async issueInvoice(req: { orderRef: string; amountCents: number }) {
    this.issueCalls++;
    if (!this.byOrder.has(req.orderRef)) {
      const preimage = randomBytes(32).toString('hex'), hash = sha(preimage), at = this.now();
      const record = { paymentHash: hash, preimage, invoice: `lnbc${hash.slice(0, 40)}fixture${hash.slice(40)}`, amountSats: req.amountCents * this.satsPerCent, payeeRef: PAYEE, expiresAt: new Date(at.getTime() + this.ttlMs).toISOString(),
        rate: { source: 'fixture-fx', quotedAt: new Date(at.getTime() - 1000).toISOString(), ref: 'fx-1' }, status: 'pending' as string, received: 0, settledAt: undefined as string | undefined };
      this.byOrder.set(req.orderRef, record); this.invoices.set(hash, record);
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
  pay(hash: string, over: Record<string, unknown> = {}) { Object.assign(this.invoices.get(hash)!, { status: 'settled', received: this.invoices.get(hash)!.amountSats, settledAt: new Date().toISOString() }, over); }
  refunds = new Map<string, any>();
  payouts = {
    quoteSats: async (cents: number) => ({ sats: cents * this.satsPerCent, rate: { source: 'fixture-fx', quotedAt: new Date().toISOString() } }),
    decodeInvoice: async (bolt11: string) => { const r = this.refunds.get(bolt11)!; return { paymentHash: r.hash, amountSats: r.sats, expiresAt: r.expiresAt, payeeRef: 'customer-node' }; },
    pay: async (req: { bolt11: string; orderRef: string }) => {
      const r = this.refunds.get(req.bolt11)!;
      if (this.payFails === 'unknown') throw new Error('timeout');
      if (this.payFails === 'definite') return { status: 'failed' as const };
      if (this.payFails === 'pending') return { status: 'pending' as const };
      r.paid = true; return { status: 'succeeded' as const, preimage: r.preimage };
    },
    lookupPayment: async (hash: string) => { const r = [...this.refunds.values()].find(x => x.hash === hash)!; return r.paid ? { status: 'succeeded' as const, preimage: r.preimage } : { status: 'pending' as const }; },
  };
  customerInvoice(sats: number, expiresMs = 3_600_000) { const preimage = randomBytes(32).toString('hex'), hash = sha(preimage), bolt11 = `lnbcrefund${hash.slice(0, 50)}`; this.refunds.set(bolt11, { hash, preimage, sats, expiresAt: new Date(Date.now() + expiresMs).toISOString(), paid: false }); return bolt11; }
}

describe.skipIf(!port || port === 5432)('Lightning funding port on disposable PostgreSQL (fixture provider only)', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_lightning_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  const saved = { admin: config.adminNpub, service: config.service.npub };
  let n = 0, invite: { id: string; code: string };
  const key = () => `req-${process.pid}-${++n}-${randomUUID().slice(0, 8)}`;
  const paidUnits = async (id: string) => BigInt((await db`SELECT paid_units FROM hosting_accounts WHERE id=${id}`)[0]!.paid_units);
  const start = async (label: string, funding = 2100) => {
    const owner = newNpub();
    const { intent } = await createIntent(owner, { client_request_key: key(), invite_code: invite.code, workspace_name: label, funding_cents: funding }, db as any);
    return { owner, intent };
  };
  const seat = async (owner: string) => (await db`SELECT status FROM onboarding_invite_seats WHERE invite_id=${invite.id} AND owner_actor_id=(SELECT id FROM flightdeck_pg_actors WHERE npub=${owner})`)[0]!.status;

  beforeAll(async () => {
    process.env.ONBOARDING_ENABLED = 'true'; process.env.HOSTING_LIGHTNING_ENABLED = 'true';
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    config.adminNpub = admin;
    config.service.npub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(87)));
    invite = await createInvite({ max_admissions: 50 }, admin, db as any);
  });
  afterAll(async () => { configureLightningProvider(null); delete process.env.ONBOARDING_ENABLED; delete process.env.HOSTING_LIGHTNING_ENABLED; config.adminNpub = saved.admin; config.service.npub = saved.service; await closeDb(); });

  test('unavailable until a trusted provider is configured and enabled; quotes use the server-held amount and replay idempotently', async () => {
    const a = await start('Quote Owner', 5000);
    await expect(issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, db as any)).rejects.toMatchObject({ code: 'lightning_unavailable' });
    const f = new FakeLightning(); configureLightningProvider(f);
    process.env.HOSTING_LIGHTNING_ENABLED = 'false';
    await expect(issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, db as any)).rejects.toMatchObject({ code: 'lightning_unavailable' });
    process.env.HOSTING_LIGHTNING_ENABLED = 'true';
    const k = key();
    // The caller cannot choose the amount, sats, rate, expiry or payee.
    await expect(issueLightningQuote(a.intent.id, a.owner, { idempotency_key: k, amount_cents: 1 } as any, db as any)).rejects.toMatchObject({ code: 'invalid_quote_request' });
    const quotes = await Promise.all(Array.from({ length: 5 }, () => issueLightningQuote(a.intent.id, a.owner, { idempotency_key: k }, db as any)));
    expect(new Set(quotes.map(q => q.id)).size).toBe(1);
    expect(quotes[0]).toMatchObject({ state: 'open', amount_cents: 5000, amount_sats: 5000 * 25, rate: { source: 'fixture-fx' } });
    expect(f.issueCalls).toBeGreaterThanOrEqual(1);
    expect((await db`SELECT count(*)::int AS n FROM hosting_lightning_quotes WHERE intent_id=${a.intent.id}`)[0]!.n).toBe(1);
    // Other identities get a neutral 404; a different key creates a distinct quote with a distinct payment hash.
    await expect(issueLightningQuote(a.intent.id, newNpub(), { idempotency_key: key() }, db as any)).rejects.toMatchObject({ code: 'intent_not_found' });
    const second = await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, db as any);
    expect(second.payment_hash).not.toBe(quotes[0]!.payment_hash);
    // Malformed provider output (wrong payee, stale expiry, bad hash, future rate time) is refused, never stored as a payable quote.
    const bad = new FakeLightning(); configureLightningProvider(bad);
    const issue = bad.issueInvoice.bind(bad);
    for (const mutate of [(r: any) => ({ ...r, payeeRef: 'someone-else' }), (r: any) => ({ ...r, paymentHash: 'zz' }), (r: any) => ({ ...r, expiresAt: new Date(Date.now() - 1000).toISOString() }), (r: any) => ({ ...r, rate: { ...r.rate, quotedAt: new Date(Date.now() + 60_000).toISOString() } }), (r: any) => ({ ...r, amountSats: 0 })]) {
      bad.issueInvoice = async req => mutate(await issue(req));
      const fresh = await start(`Bad Provider ${n}`);
      await expect(issueLightningQuote(fresh.intent.id, fresh.owner, { idempotency_key: key() }, db as any)).rejects.toMatchObject({ code: 'lightning_quote_invalid' });
      expect((await readIntent(fresh.intent.id, fresh.owner, db as any)).funded).toBe(false);
    }
    configureLightningProvider(f);
  });

  test('only provider-verified settlement credits: exactly once under concurrency, bound to account, intent, amount and hash', async () => {
    const f = new FakeLightning(); configureLightningProvider(f);
    const a = await start('Settle Owner', 2100);
    const quote = await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, db as any);
    // Pending or provider-unreachable: nothing is credited and the seat stays held.
    expect((await resolveLightningQuote(quote.id, db as any, f)).state).toBe('open');
    f.lookupFails = true; await expect(resolveLightningQuote(quote.id, db as any, f)).rejects.toThrow(); f.lookupFails = false;
    expect(await paidUnits(a.intent.account_id)).toBe(0n);
    f.pay(quote.payment_hash!);
    const results = await Promise.all(Array.from({ length: 8 }, () => resolveLightningQuote(quote.id, db as any, f)));
    expect(results.every(r => r.state === 'settled')).toBe(true);
    expect(await paidUnits(a.intent.account_id)).toBe(BigInt(usd(2100)));
    const ledger = await db`SELECT * FROM hosting_ledger WHERE account_id=${a.intent.account_id}`;
    expect(ledger.map(l => l.kind)).toEqual(['lightning']);
    const [settlement] = await db`SELECT * FROM hosting_funding_settlements WHERE order_id=${quote.id}`;
    expect(settlement).toMatchObject({ method: 'lightning', provider_ref: quote.payment_hash, amount_cents: 2100, intent_id: a.intent.id, currency: 'USD' });
    expect(settlement!.evidence).toMatchObject({ payee_ref: PAYEE, amount_sats: 2100 * 25, rate_source: 'fixture-fx' });
    expect(await readIntent(a.intent.id, a.owner, db as any)).toMatchObject({ status: 'funded', funded: true, funding_reversed: false });
    // Exactly one provisioning, with a Lightning-funded intent.
    const done = await provisionIntent(a.intent.id, a.owner, db as any);
    expect(done.status).toBe('provisioned');
    expect(await seat(a.owner)).toBe('redeemed');
    // Replays after settlement (including a second refresh and the reconciler) change nothing.
    await resolveLightningQuote(quote.id, db as any, f); await reconcileOpenLightningQuotes(admin, db as any, f);
    expect(await paidUnits(a.intent.account_id)).toBe(BigInt(usd(2100)));
    // The same payment hash can never credit a second quote.
    await expect(db`UPDATE hosting_lightning_quotes SET payment_hash=${quote.payment_hash} WHERE id=(SELECT id FROM hosting_lightning_quotes WHERE id<>${quote.id} LIMIT 1)`).rejects.toThrow();
  });

  test('inconsistent, underpaid or late settlements never auto-credit and keep the seat for support', async () => {
    const f = new FakeLightning(); configureLightningProvider(f);
    const cases: [string, (hash: string) => void, string][] = [
      ['wrong preimage', h => f.pay(h, { preimage: randomBytes(32).toString('hex') }), 'mismatch'],
      ['underpaid', h => f.pay(h, { received: 1 }), 'mismatch'],
      ['other payee', h => f.pay(h, { payeeRef: 'attacker-node' }), 'mismatch'],
      ['after expiry', h => f.pay(h, { settledAt: new Date(Date.now() + 3_600_000).toISOString() }), 'late_payment'],
    ];
    for (const [label, mutate, expected] of cases) {
      const a = await start(`Case ${label}`);
      const quote = await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, db as any);
      mutate(quote.payment_hash!);
      expect((await resolveLightningQuote(quote.id, db as any, f)).state).toBe(expected);
      expect(await paidUnits(a.intent.account_id)).toBe(0n);
      expect((await readIntent(a.intent.id, a.owner, db as any)).funded).toBe(false);
      // Unresolved evidence blocks cancel and seat release.
      await expect(cancelIntent(a.intent.id, a.owner, db as any, async () => ({}))).rejects.toMatchObject({ code: 'checkout_outstanding' });
      expect(await seat(a.owner)).toBe('reserved');
    }
  });

  test('quote holds resolve only from verified provider state: cancel, expiry, late payment before cancel', async () => {
    const f = new FakeLightning(); configureLightningProvider(f);
    const none = async () => ({});
    // Provider can cancel the pending invoice: terminal, seat released.
    const a = await start('Cancel Quote');
    const q = await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, db as any);
    expect((await cancelIntent(a.intent.id, a.owner, db as any, none)).status).toBe('cancelled');
    expect(f.invoices.get(q.payment_hash!).status).toBe('cancelled');
    expect(await seat(a.owner)).toBe('released');
    // Provider cannot cancel and the invoice is unexpired: still payable, so the hold stays.
    const b = await start('Stuck Quote'); f.cancelSupported = false;
    await issueLightningQuote(b.intent.id, b.owner, { idempotency_key: key() }, db as any);
    await expect(cancelIntent(b.intent.id, b.owner, db as any, none)).rejects.toMatchObject({ code: 'checkout_outstanding' });
    // Provider reports it expired: verified terminal, released.
    const bq = (await db`SELECT * FROM hosting_lightning_quotes WHERE intent_id=${b.intent.id}`)[0]!;
    f.invoices.get(bq.payment_hash).status = 'expired';
    expect((await cancelIntent(b.intent.id, b.owner, db as any, none)).status).toBe('cancelled');
    // Paid before the cancel: funded, never cancelled, nothing lost.
    f.cancelSupported = true;
    const c = await start('Paid Before Cancel');
    const cq = await issueLightningQuote(c.intent.id, c.owner, { idempotency_key: key() }, db as any);
    f.pay(cq.payment_hash!);
    await expect(cancelIntent(c.intent.id, c.owner, db as any, none)).rejects.toMatchObject({ code: 'intent_not_cancellable' });
    expect(await paidUnits(c.intent.account_id)).toBe(BigInt(usd(2100)));
    expect(await seat(c.owner)).toBe('reserved');
    // Unreachable provider is fail-closed.
    const d = await start('Offline Provider');
    await issueLightningQuote(d.intent.id, d.owner, { idempotency_key: key() }, db as any);
    f.lookupFails = true;
    await expect(cancelIntent(d.intent.id, d.owner, db as any, none)).rejects.toMatchObject({ code: 'checkout_outstanding' });
    f.lookupFails = false;
    // Open quote attached to an intent that Stripe funded first: the later payment stays as credit; the intent is funded once.
    const e = await start('Both Methods');
    const eq = await issueLightningQuote(e.intent.id, e.owner, { idempotency_key: key() }, db as any);
    f.pay(eq.payment_hash!); await resolveLightningQuote(eq.id, db as any, f);
    const [funded] = await db`SELECT funded_settlement_id,funded_order_id FROM onboarding_intents WHERE id=${e.intent.id}`;
    expect(funded!.funded_settlement_id).not.toBeNull(); expect(funded!.funded_order_id).toBeNull();
  });

  test('support Lightning refund: gated, bounded by reserves and provider conversion, preimage-verified, idempotent', async () => {
    const f = new FakeLightning(); configureLightningProvider(f);
    const a = await start('Refund Owner', 5000);
    const quote = await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, db as any);
    f.pay(quote.payment_hash!); await resolveLightningQuote(quote.id, db as any, f);
    const [settlement] = await db`SELECT * FROM hosting_funding_settlements WHERE order_id=${quote.id}`;
    const request = (invoice: string, over: Record<string, unknown> = {}) => ({ settlement_id: settlement!.id, amount_cents: 1000, invoice, customer_verified: true, idempotency_key: key(), reason: 'customer left', ...over });
    const ok = f.customerInvoice(1000 * 25);
    await expect(requestLightningRefund(request(ok, { customer_verified: false }), admin, db as any, f)).rejects.toMatchObject({ code: 'invalid_refund' });
    await expect(requestLightningRefund(request(ok), admin, db as any, f)).rejects.toMatchObject({ code: 'refund_reserves_unregistered' });
    let held = 0n; const unregister = registerFundingReserve(async () => held);
    await expect(requestLightningRefund(request(ok), newNpub(), db as any, f)).rejects.toMatchObject({ code: 'platform_admin_required' });
    const original = f.payouts; (f as any).payouts = undefined;
    await expect(requestLightningRefund(request(ok), admin, db as any, f)).rejects.toMatchObject({ code: 'lightning_refund_unavailable' });
    (f as any).payouts = original;
    // Invoice asking for more sats than the provider's conversion of the refunded USD is refused; so are expired invoices.
    await expect(requestLightningRefund(request(f.customerInvoice(1000 * 25 + 1)), admin, db as any, f)).rejects.toMatchObject({ code: 'refund_invoice_invalid' });
    await expect(requestLightningRefund(request(f.customerInvoice(100, -1000)), admin, db as any, f)).rejects.toMatchObject({ code: 'refund_invoice_invalid' });
    // Reserved funds are not refundable.
    held = BigInt(usd(4500));
    await expect(requestLightningRefund(request(ok), admin, db as any, f)).rejects.toMatchObject({ code: 'refund_exceeds_available' });
    held = 0n;
    // Ambiguous payout keeps the funds withheld; the replay with the same key resolves it exactly once.
    const body = request(ok); f.payFails = 'unknown';
    await expect(requestLightningRefund(body, admin, db as any, f)).rejects.toMatchObject({ code: 'refund_outcome_unknown' });
    expect(await paidUnits(a.intent.account_id)).toBe(BigInt(usd(4000)));
    f.payFails = 'none';
    const done = await requestLightningRefund(body, admin, db as any, f);
    expect(done).toMatchObject({ state: 'succeeded', amount_cents: 1000, effective_cents: 1000 });
    expect(await paidUnits(a.intent.account_id)).toBe(BigInt(usd(4000)));
    expect((await requestLightningRefund(body, admin, db as any, f)).adjustment_id).toBe(done.adjustment_id);
    await expect(requestLightningRefund({ ...body, amount_cents: 1100 }, admin, db as any, f)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    // The same customer invoice cannot be paid twice under a different key.
    await expect(requestLightningRefund(request(ok), admin, db as any, f)).rejects.toMatchObject({ code: 'refund_invoice_invalid' });
    // A definite provider failure releases the funds.
    f.payFails = 'definite';
    const failed = await requestLightningRefund(request(f.customerInvoice(500 * 25), { amount_cents: 500 }), admin, db as any, f);
    expect(failed.state).toBe('failed'); expect(await paidUnits(a.intent.account_id)).toBe(BigInt(usd(4000)));
    // A success report whose preimage does not hash to the invoice is not believed: funds stay withheld as pending.
    f.payFails = 'none'; const liar = f.customerInvoice(500 * 25); f.refunds.get(liar).preimage = randomBytes(32).toString('hex');
    expect((await requestLightningRefund(request(liar, { amount_cents: 500 }), admin, db as any, f)).state).toBe('pending');
    expect(await paidUnits(a.intent.account_id)).toBe(BigInt(usd(3500)));
    unregister();
  });
});
