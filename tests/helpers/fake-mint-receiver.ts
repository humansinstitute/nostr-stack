import { createHash, randomBytes } from 'node:crypto';
import { bindingDigest, canonicalJson, type BindingRecord } from '../../src/services/hosting-lightning-receiver';
import type { ReceiverTransport } from '../../src/services/lightning-receiver-client';

/** In-process stand-in speaking the receiver's exact wire shapes (cashu-wallet server/receiver): OrderInvoice with an immutable binding, evidence views
 * and the paged binding feed. Fixture only: it models behaviour the real receiver proves in its own tests. */
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export interface Attempt { orderRef: string; amountMinor: number; binding: BindingRecord; invoice: any; status: 'issued' | 'settled' | 'late' | 'rejected'; paidAt: number | null; settledAt: number | null; evidence: any | null; late: boolean }

export class FakeMintReceiver implements ReceiverTransport {
  mint = 'https://mint.fixture.test'; fingerprint = `fp-${randomBytes(6).toString('hex')}`; sats = 25; ttlSec = 900;
  seq = 0; attempts = new Map<string, Attempt>(); order: Attempt[] = [];
  down = false; calls = { put: 0, settle: 0 };
  now = () => Math.floor(Date.now() / 1000);
  get payeeRef() { return `cashu:${this.mint}#${this.fingerprint}`; }
  get expectation() { return { mint: this.mint, treasuryFingerprint: this.fingerprint }; }

  async put(orderRef: string, body: { currency: 'USD'; amountMinor: number }) {
    this.calls.put++;
    if (this.down) throw new Error('receiver down');
    const prior = this.attempts.get(orderRef);
    if (prior) {
      if (prior.amountMinor !== body.amountMinor) throw new Error('order_conflict');
      return prior.invoice;
    }
    const preimage = randomBytes(32).toString('hex'), hash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    const t = this.now(), expiresAt = t + this.ttlSec, prevSeq = this.seq; this.seq++;
    const rate = { source: 'fx-fixture', quotedAt: t - 1, ref: `fx-${this.seq}`, validUntil: expiresAt };
    const lockPubkey = `02${randomBytes(32).toString('hex')}`;
    const record: Omit<BindingRecord, 'digest'> = {
      v: 1, kind: 'receiver_order_binding', seq: this.seq, prevSeq, orderRef, requestHash: sha(canonicalJson({ currency: body.currency, amountMinor: body.amountMinor })), currency: 'USD', amountMinor: body.amountMinor,
      mint: this.mint, quoteId: `mq-${randomBytes(6).toString('hex')}`, paymentHash: hash, bolt11: `lnbc${hash.slice(0, 40)}fixture${hash.slice(40)}`, amountSats: body.amountMinor * this.sats, rate, expiresAt, issuedAt: t,
      keyNamespace: '', keyEpoch: 0, derivationIndex: this.seq - 1, lockPubkey, treasuryFingerprint: this.fingerprint,
    };
    const binding = { ...record, digest: bindingDigest(record as any) } as BindingRecord;
    const invoice = { orderRef, invoice: binding.bolt11, paymentHash: hash, amountSats: binding.amountSats, expiresAt, payeeRef: this.payeeRef, mint: this.mint, rate, lockPubkey, binding };
    const a: Attempt = { orderRef, amountMinor: body.amountMinor, binding, invoice, status: 'issued', paidAt: null, settledAt: null, evidence: null, late: false };
    this.attempts.set(orderRef, a); this.order.push(a);
    return invoice;
  }

  /** The payer paid at the mint; the next settle pass redeems and writes the evidence. */
  pay(orderRef: string, o: { paidAt?: number; late?: boolean } = {}) { const a = this.attempts.get(orderRef)!; a.paidAt = o.paidAt ?? this.now(); a.late = o.late ?? false; }
  reject(orderRef: string) { this.attempts.get(orderRef)!.status = 'rejected'; }

  view(a: Attempt): any {
    if (a.status === 'rejected') return { status: 'rejected', creditable: false, reason: 'mint_quote_mismatch' };
    if (a.status === 'issued') return { status: 'pending', expired: false, recovering: false, reason: null };
    const evidence = a.evidence;
    return a.status === 'settled' ? { status: 'settled', creditable: true, evidence, evidenceDigest: sha(canonicalJson(evidence)) }
      : { status: 'late_payment', creditable: false, evidence, evidenceDigest: sha(canonicalJson(evidence)) };
  }
  async settle(orderRef: string) {
    this.calls.settle++;
    if (this.down) throw new Error('receiver down');
    const a = this.attempts.get(orderRef);
    if (!a) return { status: 'unknown' };
    if (a.status === 'issued' && a.paidAt !== null) {
      const b = a.binding, t = this.now();
      a.evidence = {
        v: 1, kind: 'mint_redemption', orderRef, mint: b.mint, quoteId: b.quoteId, paymentHash: b.paymentHash, amountSats: b.amountSats, lockPubkey: b.lockPubkey, keyNamespace: b.keyNamespace, keyEpoch: b.keyEpoch,
        derivationIndex: b.derivationIndex, operationId: `op-${randomBytes(4).toString('hex')}`, proofsDigest: sha(orderRef), proofCount: 3, proofsHeld: 'local_ready_unreserved', mintChecked: true, payeeRef: this.payeeRef,
        rate: b.rate, paidAt: a.paidAt, expiresAt: b.expiresAt, settledAt: t, late: a.late || a.paidAt > b.expiresAt, claimant: 'coco-fixture', walletStateSeq: 7,
      };
      a.settledAt = t; a.status = a.evidence.late ? 'late' : 'settled';
    }
    return this.view(a);
  }
  async evidence(orderRef: string) { const a = this.attempts.get(orderRef); return a ? this.view(a) : { status: 'unknown' }; }
  async bindings(after: number, limit: number) {
    const records = this.order.filter(a => a.binding.seq > after).slice(0, limit).map(a => a.binding);
    return { v: 1, treasuryFingerprint: this.fingerprint, head: { seq: this.seq, count: this.order.length }, namespaces: [{ namespace: '', epoch: 0 }], records };
  }
}
