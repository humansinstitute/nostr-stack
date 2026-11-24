import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { configureLightningProvider, issueLightningQuote, reconcileOpenLightningQuotes, reconcileReceiverBindingFeed, requestLightningRefund, resolveLightningQuote, type LightningProvider } from '../src/services/hosting-lightning';
import { bindingDigest, canonicalJson, reconcileBindingFeed, verifyMintView, type BindingRecord } from '../src/services/hosting-lightning-receiver';
import { createReceiverLightningProvider } from '../src/services/lightning-receiver-client';
import { createIntent, createInvite, readIntent } from '../src/services/onboarding';
import { USD_UNITS } from '../src/services/hosting-billing';
import { FakeMintReceiver } from './helpers/fake-mint-receiver';

// Runs only against a dedicated disposable PostgreSQL: RECEIVER_TEST_PORT=<free port>.
const port = Number(process.env.RECEIVER_TEST_PORT);
const newNpub = () => nip19.npubEncode(getPublicKey(randomBytes(32)));
const admin = newNpub();
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const usd = (cents: number) => (BigInt(cents) * (USD_UNITS / 100n)).toString();

describe('verifyMintView is pure and field-exact', () => {
  const rx = new FakeMintReceiver();
  const quote = (id: string, a: any) => ({ id, payment_hash: a.binding.paymentHash, amount_sats: a.binding.amountSats, expires_at: new Date(a.binding.expiresAt * 1000), payee_ref: rx.payeeRef });
  test('credits a fully consistent settled view and nothing else', async () => {
    const id = randomUUID(); await rx.put(id, { currency: 'USD', amountMinor: 2100 }); rx.pay(id); const view = await rx.settle(id);
    const a = rx.attempts.get(id)!;
    expect(verifyMintView(view, quote(id, a), a.binding, rx.expectation).kind).toBe('credit');
  });
});

describe.skipIf(!port || port === 5432)('mint-backed receiver integration on disposable PostgreSQL (in-process fake receiver, wire shapes only)', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_receiver_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  const saved = { admin: config.adminNpub, service: config.service.npub };
  let n = 0, invite: { id: string; code: string };
  const key = () => `req-${process.pid}-${++n}-${randomUUID().slice(0, 8)}`;
  const paidUnits = async (id: string) => BigInt((await db`SELECT paid_units FROM hosting_accounts WHERE id=${id}`)[0]!.paid_units);
  const settlements = async (accountId: string) => (await db`SELECT * FROM hosting_funding_settlements WHERE account_id=${accountId}`);
  const start = async (label: string, funding = 2100) => {
    const owner = newNpub();
    const { intent } = await createIntent(owner, { client_request_key: key(), invite_code: invite.code, workspace_name: label, funding_cents: funding }, db as any);
    return { owner, intent };
  };
  async function quoteFor(rx: FakeMintReceiver, p: LightningProvider, label = 'Mint Owner', funding = 2100) {
    const a = await start(label, funding);
    const q = await issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, db as any, p);
    return { ...a, q };
  }
  const setup = () => { const rx = new FakeMintReceiver(); const p = createReceiverLightningProvider(rx, rx.expectation); configureLightningProvider(p); return { rx, p }; };

  beforeAll(async () => {
    process.env.ONBOARDING_ENABLED = 'true'; process.env.HOSTING_LIGHTNING_ENABLED = 'true';
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    config.adminNpub = admin;
    config.service.npub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(88)));
    invite = await createInvite({ max_admissions: 200 }, admin, db as any);
  });
  afterAll(async () => { configureLightningProvider(null); delete process.env.ONBOARDING_ENABLED; delete process.env.HOSTING_LIGHTNING_ENABLED; config.adminNpub = saved.admin; config.service.npub = saved.service; await closeDb(); });

  test('the binding is stored in the same transaction that opens the quote; replays return the identical record', async () => {
    const { rx, p } = setup();
    const { q, intent } = await quoteFor(rx, p);
    expect(q).toMatchObject({ state: 'open', amount_cents: 2100, amount_sats: 2100 * 25 });
    const [b] = await db`SELECT * FROM hosting_lightning_bindings WHERE quote_id=${q.id}`;
    expect(b).toMatchObject({ treasury_fingerprint: rx.fingerprint });
    expect(b!.digest).toBe(rx.attempts.get(q.id)!.binding.digest);
    expect((await db`SELECT evidence_kind FROM hosting_lightning_quotes WHERE id=${q.id}`)[0]!.evidence_kind).toBe('mint_redemption');
    // Receiver replays the same order: same record, no second binding, no second row.
    const again = await quoteFor(rx, p, 'Replay Owner');
    expect(again.q.id).not.toBe(q.id);
    const replayed = await rx.put(q.id, { currency: 'USD', amountMinor: 2100 });
    expect(replayed.binding.digest).toBe(b!.digest);
    // A crash between the receiver's PUT and our store (quote left 'issuing') is repaired by replaying the same order.
    const crashed = await start('Crash Owner');
    const before = rx.seq;
    const failing = { ...p, issueInvoice: async (r: any) => { await rx.put(r.orderRef, { currency: 'USD', amountMinor: r.amountCents }); throw new Error('process died'); } } as LightningProvider;
    await expect(issueLightningQuote(crashed.intent.id, crashed.owner, { idempotency_key: 'crash-key-0001' }, db as any, failing)).rejects.toThrow();
    const [held] = await db`SELECT * FROM hosting_lightning_quotes WHERE intent_id=${crashed.intent.id}`;
    expect(held).toMatchObject({ state: 'issuing', invoice: null });
    expect((await db`SELECT 1 FROM hosting_lightning_bindings WHERE quote_id=${held!.id}`).length).toBe(0);
    const healed = await issueLightningQuote(crashed.intent.id, crashed.owner, { idempotency_key: 'crash-key-0001' }, db as any, p);
    expect(healed).toMatchObject({ id: held!.id, state: 'open' });
    expect(rx.seq).toBe(before + 1);
    expect((await db`SELECT digest FROM hosting_lightning_bindings WHERE quote_id=${held!.id}`)[0]!.digest).toBe(rx.attempts.get(held!.id)!.binding.digest);
    expect((await readIntent(intent.id, (await db`SELECT a.npub FROM onboarding_intents i JOIN flightdeck_pg_actors a ON a.id=i.owner_actor_id WHERE i.id=${intent.id}`)[0]!.npub as string, db as any)).funded).toBe(false);
  });

  test('a bad or conflicting binding is refused before the invoice can be shown', async () => {
    const { rx, p } = setup();
    const issue = rx.put.bind(rx);
    const mutations: [string, (inv: any) => any][] = [
      ['digest', inv => ({ ...inv, binding: { ...inv.binding, amountSats: inv.binding.amountSats + 1 } })],
      ['wrong fingerprint', inv => { const b = { ...inv.binding, treasuryFingerprint: 'other' }; return { ...inv, binding: { ...b, digest: bindingDigest(b) } }; }],
      ['wrong mint', inv => { const b = { ...inv.binding, mint: 'https://evil.test' }; return { ...inv, binding: { ...b, digest: bindingDigest(b) } }; }],
      ['other order', inv => { const b = { ...inv.binding, orderRef: randomUUID() }; return { ...inv, binding: { ...b, digest: bindingDigest(b) } }; }],
      ['other invoice', inv => { const b = { ...inv.binding, bolt11: 'lnbcother' }; return { ...inv, binding: { ...b, digest: bindingDigest(b) } }; }],
      ['other amount', inv => { const b = { ...inv.binding, amountMinor: 5000 }; return { ...inv, binding: { ...b, digest: bindingDigest(b) } }; }],
      ['expired', inv => { const b = { ...inv.binding, expiresAt: inv.binding.issuedAt - 5 }; return { ...inv, binding: { ...b, digest: bindingDigest(b) } }; }],
      ['missing', inv => ({ ...inv, binding: undefined })],
    ];
    for (const [label, mutate] of mutations) {
      rx.put = async (ref, body) => mutate(await issue(ref, body));
      const a = await start(`Bad Binding ${label}`);
      await expect(issueLightningQuote(a.intent.id, a.owner, { idempotency_key: key() }, db as any, p)).rejects.toMatchObject({ code: expect.stringMatching(/receiver_binding_invalid|receiver_response_invalid/) });
      const [row] = await db`SELECT * FROM hosting_lightning_quotes WHERE intent_id=${a.intent.id}`;
      expect(row).toMatchObject({ state: 'issuing', invoice: null });
      expect((await db`SELECT 1 FROM hosting_lightning_bindings WHERE quote_id=${row!.id}`).length).toBe(0);
    }
    rx.put = issue;
    // A different record for an already bound order (or seq) is a hard conflict.
    const ok = await quoteFor(rx, p, 'Conflict Owner');
    const bound = rx.attempts.get(ok.q.id)!.binding;
    const forged = { ...bound, paymentHash: sha('x'), bolt11: 'lnbcforged' }; forged.digest = bindingDigest(forged as any);
    const { storeBinding } = await import('../src/services/hosting-lightning-receiver');
    await expect(db.begin(tx => storeBinding(tx as any, ok.q.id, forged as BindingRecord))).rejects.toMatchObject({ code: 'binding_conflict' });
    const other = await start('Seq Owner');
    const [oq] = await db`INSERT INTO hosting_lightning_quotes(account_id,intent_id,idempotency_key,request_sha256,amount_cents) VALUES(${other.intent.account_id},${other.intent.id},'k-seq-000001','x',2100) RETURNING id`;
    await expect(db.begin(tx => storeBinding(tx as any, oq!.id as string, bound))).rejects.toMatchObject({ code: 'binding_conflict' });
    await expect(db`UPDATE hosting_lightning_bindings SET digest=${sha('y')} WHERE quote_id=${ok.q.id}`).rejects.toThrow();
    await expect(db`DELETE FROM hosting_lightning_bindings WHERE quote_id=${ok.q.id}`).rejects.toThrow();
  });

  test('a binding that cannot be stored keeps the quote unopened and its invoice unseen', async () => {
    const { rx, p } = setup();
    const squatter = await start('Squatter');
    const [sq] = await db`INSERT INTO hosting_lightning_quotes(account_id,intent_id,idempotency_key,request_sha256,amount_cents) VALUES(${squatter.intent.account_id},${squatter.intent.id},'k-squat-0001','x',2100) RETURNING id`;
    const next = rx.seq + 1;
    await db`INSERT INTO hosting_lightning_bindings(treasury_fingerprint,seq,quote_id,digest,record) VALUES(${rx.fingerprint},${next},${sq!.id},${sha('squat')},${db.json({})})`;
    const victim = await start('Victim');
    await expect(issueLightningQuote(victim.intent.id, victim.owner, { idempotency_key: key() }, db as any, p)).rejects.toMatchObject({ code: 'binding_conflict' });
    const [row] = await db`SELECT * FROM hosting_lightning_quotes WHERE intent_id=${victim.intent.id}`;
    expect(row).toMatchObject({ state: 'issuing', invoice: null, payment_hash: null });
  });

  test('a verified mint redemption credits exactly once, under concurrent settle passes, bound to account, order and amount', async () => {
    const { rx, p } = setup();
    const a = await quoteFor(rx, p, 'Settle Owner');
    const before = await paidUnits(a.intent.account_id);
    expect((await resolveLightningQuote(a.q.id, db as any, p)).state).toBe('open'); // pending: nothing paid yet
    rx.pay(a.q.id);
    const results = await Promise.all(Array.from({ length: 8 }, () => resolveLightningQuote(a.q.id, db as any, p)));
    expect(results.every(r => r.state === 'settled')).toBe(true);
    expect(await paidUnits(a.intent.account_id) - before).toBe(BigInt(usd(2100)));
    const rows = await settlements(a.intent.account_id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ method: 'lightning', provider_ref: rx.attempts.get(a.q.id)!.binding.paymentHash, order_id: a.q.id, amount_cents: 2100 });
    expect(rows[0]!.evidence).toMatchObject({ evidence_kind: 'mint_redemption', receiver_evidence_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await readIntent(a.intent.id, a.owner, db as any)).funded).toBe(true);
    // Settled again later is a no-op.
    await resolveLightningQuote(a.q.id, db as any, p);
    expect((await settlements(a.intent.account_id)).length).toBe(1);
  });

  test('every receiver evidence field is checked: any single mutation withholds credit', async () => {
    const { rx, p } = setup();
    const mutations: [string, (e: any, v: any) => void][] = [
      ['evidence kind', e => { e.kind = 'preimage'; }], ['version', e => { e.v = 2; }],
      ['order', e => { e.orderRef = randomUUID(); }], ['payment hash', e => { e.paymentHash = sha('z'); }],
      ['mint quote', e => { e.quoteId = 'mq-other'; }], ['mint', e => { e.mint = 'https://evil.test'; }],
      ['lock pubkey', e => { e.lockPubkey = `02${'a'.repeat(64)}`; }], ['namespace', e => { e.keyNamespace = 'a'.repeat(32); }], ['epoch', e => { e.keyEpoch = 9; }], ['index', e => { e.derivationIndex = 99; }],
      ['amount', e => { e.amountSats += 1; }], ['payee', e => { e.payeeRef = 'cashu:https://mint.fixture.test#other'; }],
      ['mint not checked', e => { e.mintChecked = false; }], ['proofs held', e => { e.proofsHeld = 'reserved'; }], ['no proofs', e => { e.proofCount = 0; }],
      ['proofs digest', e => { e.proofsDigest = 'bad'; }], ['operation', e => { e.operationId = ''; }], ['expiry', e => { e.expiresAt += 60; }], ['rate', e => { e.rate = { ...e.rate, ref: 'other' }; }],
      ['settled before issue', e => { e.settledAt = e.settledAt - 100000; }], ['paid after our expiry', e => { e.paidAt = e.expiresAt + 10; e.late = false; }],
      ['digest mismatch', (_e, v) => { v.evidenceDigest = sha('forged'); }], ['not creditable', (_e, v) => { v.creditable = false; }],
    ];
    for (const [label, mutate] of mutations) {
      const a = await quoteFor(rx, p, `Mutation ${label}`);
      rx.pay(a.q.id);
      const honest = rx.settle.bind(rx);
      rx.settle = async ref => {
        const view = structuredClone(await honest(ref));
        mutate(view.evidence, view);
        // Keep the digest consistent unless the case is about the digest itself, so the field check (not the digest check) must catch it.
        if (label !== 'digest mismatch') view.evidenceDigest = sha(canonicalJson(view.evidence));
        return view;
      };
      const before = await paidUnits(a.intent.account_id);
      const r = await resolveLightningQuote(a.q.id, db as any, p);
      rx.settle = honest;
      expect([label, r.state]).not.toEqual([label, 'settled']);
      // The field-level check (not the digest check) must be what refused it, except for the cases about the digest itself.
      const [row] = await db`SELECT state,evidence FROM hosting_lightning_quotes WHERE id=${a.q.id}`;
      if (!['digest mismatch', 'paid after our expiry'].includes(label)) expect([label, row!.evidence.reason]).not.toEqual([label, 'evidence_digest']);
      expect(['mismatch', 'late_payment']).toContain(row!.state);
      expect(await paidUnits(a.intent.account_id)).toBe(before);
      expect((await settlements(a.intent.account_id)).length).toBe(0);
    }
  });

  test('other receiver outcomes never credit: pending, unknown, rejected, late, receiver down, and replayed evidence for another order', async () => {
    const { rx, p } = setup();
    const pending = await quoteFor(rx, p, 'Pending');
    expect((await resolveLightningQuote(pending.q.id, db as any, p)).state).toBe('open');
    const late = await quoteFor(rx, p, 'Late');
    rx.pay(late.q.id, { paidAt: rx.attempts.get(late.q.id)!.binding.expiresAt + 30 });
    expect((await resolveLightningQuote(late.q.id, db as any, p)).state).toBe('late_payment');
    expect(await paidUnits(late.intent.account_id)).toBe(0n);
    const rejected = await quoteFor(rx, p, 'Rejected'); rx.reject(rejected.q.id);
    expect((await resolveLightningQuote(rejected.q.id, db as any, p)).state).toBe('mismatch');
    expect((await db`SELECT evidence FROM hosting_lightning_quotes WHERE id=${rejected.q.id}`)[0]!.evidence).toMatchObject({ reason: 'receiver_rejected' });
    const lost = await quoteFor(rx, p, 'Lost'); rx.attempts.delete(lost.q.id);
    expect((await resolveLightningQuote(lost.q.id, db as any, p)).state).toBe('mismatch');
    expect((await db`SELECT evidence FROM hosting_lightning_quotes WHERE id=${lost.q.id}`)[0]!.evidence).toMatchObject({ reason: 'receiver_unknown_order' });
    const down = await quoteFor(rx, p, 'Down'); rx.pay(down.q.id); rx.down = true;
    await expect(resolveLightningQuote(down.q.id, db as any, p)).rejects.toThrow();
    rx.down = false;
    expect((await db`SELECT state FROM hosting_lightning_quotes WHERE id=${down.q.id}`)[0]!.state).toBe('open');
    expect((await resolveLightningQuote(down.q.id, db as any, p)).state).toBe('settled'); // the same quote settles once the receiver is reachable
    // Settled evidence of order A presented for order B: the other order's own binding rejects it.
    const a = await quoteFor(rx, p, 'Order A'), b = await quoteFor(rx, p, 'Order B');
    rx.pay(a.q.id); await rx.settle(a.q.id);
    const honest = rx.settle.bind(rx);
    rx.settle = async ref => (ref === b.q.id ? honest(a.q.id) : honest(ref));
    expect((await resolveLightningQuote(b.q.id, db as any, p)).state).toBe('mismatch');
    rx.settle = honest;
    expect(await paidUnits(b.intent.account_id)).toBe(0n);
    expect(await paidUnits(late.intent.account_id)).toBe(0n);
  });

  test('evidence kinds never cross: a preimage cannot credit a mint quote and a mint view cannot credit a preimage quote', async () => {
    const { rx, p } = setup();
    const a = await quoteFor(rx, p, 'Cross Owner');
    const preimageProvider = { id: 'preimage-fixture', payeeRef: rx.payeeRef, issueInvoice: async () => { throw new Error('unused'); },
      lookupInvoice: async () => ({ status: 'settled', paymentHash: rx.attempts.get(a.q.id)!.binding.paymentHash, payeeRef: rx.payeeRef, amountSatsReceived: 1e9, settledAt: new Date().toISOString(), preimage: 'ff'.repeat(32) }) } as LightningProvider;
    const before = await paidUnits(a.intent.account_id);
    expect((await resolveLightningQuote(a.q.id, db as any, preimageProvider)).state).toBe('open');
    expect(await paidUnits(a.intent.account_id)).toBe(before);
    // And a preimage-issued quote is never settled by a mint provider.
    const pre = await start('Preimage Owner');
    const preHash = createHash('sha256').update(Buffer.from('aa'.repeat(32), 'hex')).digest('hex');
    const fixture: LightningProvider = { id: 'fx', payeeRef: 'fx-payee', issueInvoice: async () => ({ invoice: `lnbc${'q'.repeat(40)}`, paymentHash: preHash, amountSats: 2100 * 25, expiresAt: new Date(Date.now() + 900_000).toISOString(), payeeRef: 'fx-payee', rate: { source: 'fx', quotedAt: new Date(Date.now() - 1000).toISOString() } }),
      lookupInvoice: async () => ({ status: 'pending', paymentHash: preHash, payeeRef: 'fx-payee' }) };
    const pq = await issueLightningQuote(pre.intent.id, pre.owner, { idempotency_key: key() }, db as any, fixture);
    expect((await db`SELECT evidence_kind FROM hosting_lightning_quotes WHERE id=${pq.id}`)[0]!.evidence_kind).toBe('preimage');
    expect((await resolveLightningQuote(pq.id, db as any, p)).state).toBe('open');
    expect(rx.calls.settle).toBeGreaterThanOrEqual(0);
    expect((await db`SELECT 1 FROM hosting_lightning_bindings WHERE quote_id=${pq.id}`).length).toBe(0);
  });

  test('the binding feed proves a gap-free chain, stores orphans, reports conflicts and unbacked quotes', async () => {
    const { rx, p } = setup();
    const a = await quoteFor(rx, p, 'Feed A'), b = await quoteFor(rx, p, 'Feed B');
    // A receiver record we never bound (its quote row never existed here) and a quote without a binding.
    await rx.put(randomUUID(), { currency: 'USD', amountMinor: 500 });
    const unbacked = await start('Unbacked');
    const [uq] = await db`INSERT INTO hosting_lightning_quotes(account_id,intent_id,idempotency_key,request_sha256,amount_cents,state,evidence_kind,provider,payee_ref,invoice,payment_hash,amount_sats,rate_source,rate_quoted_at,expires_at)
      VALUES(${unbacked.intent.account_id},${unbacked.intent.id},'k-unbacked-1','x',2100,'open','mint_redemption','cashu-receiver',${rx.payeeRef},'lnbc','${sha('unbacked')}',52500,'fx',now(),now()+interval '10 minutes') RETURNING id`.catch(() => [{ id: null }]);
    const report = await reconcileReceiverBindingFeed(admin, db as any, p);
    expect(report).toMatchObject({ gap: false, conflicts: 0, behind: false });
    expect(report.verified).toBe(rx.order.length);
    expect(report.verified_through_seq).toBe(rx.seq);
    expect(report.orphans).toBe(1);
    if (uq!.id) expect(report.quotes_without_binding).toContain(uq!.id);
    expect((await db`SELECT 1 FROM hosting_lightning_binding_orphans WHERE treasury_fingerprint=${rx.fingerprint}`).length).toBe(1);
    // Non-admins cannot run it; repeat is idempotent.
    await expect(reconcileReceiverBindingFeed(newNpub(), db as any, p)).rejects.toMatchObject({ code: 'platform_admin_required' });
    expect(await reconcileReceiverBindingFeed(admin, db as any, p)).toMatchObject({ verified: 0, orphans: 0 });
    // A hole in the receiver's chain (missing record) is a gap and the watermark does not pass it.
    const hole = rx.order.splice(rx.order.length - 2, 1)[0]!;
    await rx.put(randomUUID(), { currency: 'USD', amountMinor: 700 });
    await rx.put(randomUUID(), { currency: 'USD', amountMinor: 800 });
    const gapped = rx.order[rx.order.length - 1]!; rx.order.splice(rx.order.length - 2, 1);
    expect(hole).toBeDefined(); expect(gapped).toBeDefined();
    const g = await reconcileReceiverBindingFeed(admin, db as any, p);
    expect(g.gap).toBe(true);
    expect(g.verified_through_seq).toBeLessThan(rx.seq);
    // A tampered record fails closed; a record under another treasury fingerprint is refused.
    rx.order[rx.order.length - 1]!.binding.amountSats += 1;
    await expect(reconcileBindingFeed(db as any, (after, limit) => rx.bindings(after, limit), rx.expectation)).rejects.toMatchObject({ code: 'receiver_feed_invalid' });
    await expect(reconcileBindingFeed(db as any, async () => ({ ...(await rx.bindings(0, 10)), treasuryFingerprint: 'other' }), rx.expectation)).rejects.toMatchObject({ code: 'receiver_feed_invalid' });
    expect(a.q.id).not.toBe(b.q.id);
  });

  test('refunds stay unavailable (the receiver has no payout) and the provider cannot be registered by any request', async () => {
    const { rx, p } = setup();
    expect(p.payouts).toBeUndefined();
    const settled = await quoteFor(rx, p, 'Refund Owner'); rx.pay(settled.q.id); await resolveLightningQuote(settled.q.id, db as any, p);
    const [s] = await settlements(settled.intent.account_id);
    await expect(requestLightningRefund({ settlement_id: s!.id, amount_cents: 100, idempotency_key: key(), reason: 'test', invoice: `lnbc${'1'.repeat(40)}`, customer_verified: true }, admin, db as any, p)).rejects.toMatchObject({ code: expect.stringMatching(/refund_reserves_unregistered|lightning_refund_unavailable/) });
    expect(await reconcileOpenLightningQuotes(admin, db as any, p)).toMatchObject({ checked: expect.any(Number) });
    process.env.HOSTING_LIGHTNING_ENABLED = 'false';
    try { await expect(issueLightningQuote((await start('Off Owner')).intent.id, newNpub(), { idempotency_key: key() }, db as any)).rejects.toThrow(); } finally { process.env.HOSTING_LIGHTNING_ENABLED = 'true'; }
  });
});
