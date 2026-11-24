import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { HostingError } from './hosting-billing';

/** Verification of a mint-backed receiver's records against NStack's OWN immutable quote and trusted configuration.
 * Nothing in a receiver response is believed on its own: every identity, amount, key and time field is recomputed or compared. */
type Db = ReturnType<typeof getDb>;
const HEX64 = /^[0-9a-f]{64}$/;
const HEXKEY = /^(02|03)?[0-9a-f]{64}$/;
const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const isSec = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Identical to the receiver's canonical JSON: sorted keys, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export interface ReceiverRate { source: string; quotedAt: number; ref: string; validUntil: number }
export interface BindingRecord {
  v: 1; kind: 'receiver_order_binding'; seq: number; prevSeq: number; orderRef: string; requestHash: string; currency: string; amountMinor: number; mint: string;
  quoteId: string; paymentHash: string; bolt11: string; amountSats: number; rate: ReceiverRate; expiresAt: number; issuedAt: number; keyNamespace: string; keyEpoch: number;
  derivationIndex: number; lockPubkey: string; treasuryFingerprint: string; digest: string;
}
/** Trusted operator configuration: where value must be held. Never taken from a response. */
export interface ReceiverExpectation { mint: string; treasuryFingerprint: string }
export const receiverPayeeRef = (e: ReceiverExpectation) => `cashu:${e.mint}#${e.treasuryFingerprint}`;

export function bindingDigest(record: Omit<BindingRecord, 'digest'> | BindingRecord): string {
  const { digest: _drop, ...body } = record as BindingRecord;
  return sha256(canonicalJson(body));
}

const invalid = (code = 'receiver_binding_invalid') => new HostingError(502, code);
function shapeRate(r: any): r is ReceiverRate {
  return !!r && typeof r.source === 'string' && r.source.length > 0 && r.source.length < 200 && isSec(r.quotedAt) && typeof r.ref === 'string' && isSec(r.validUntil);
}
/** Validates the binding the receiver returned with an issued invoice, against the quote and the issued invoice, and returns it typed. */
export function verifyIssuedBinding(raw: unknown, quote: { id: string; amount_cents: number }, issued: { invoice: string; paymentHash: string; amountSats: number; expiresAt: string; lockPubkey?: string }, expect: ReceiverExpectation, now: Date): BindingRecord {
  const b = raw as BindingRecord;
  if (!b || typeof b !== 'object' || b.v !== 1 || b.kind !== 'receiver_order_binding' || !HEX64.test(String(b.digest))) throw invalid();
  if (!Number.isSafeInteger(b.seq) || b.seq < 1 || !isSec(b.prevSeq) || b.prevSeq >= b.seq) throw invalid();
  if (bindingDigest(b) !== b.digest) throw invalid();
  if (b.orderRef !== quote.id || b.currency !== 'USD' || b.amountMinor !== quote.amount_cents) throw invalid();
  if (b.mint !== expect.mint || b.treasuryFingerprint !== expect.treasuryFingerprint) throw invalid();
  if (b.paymentHash !== issued.paymentHash || b.bolt11 !== issued.invoice || b.amountSats !== issued.amountSats || !HEX64.test(b.paymentHash)) throw invalid();
  if (typeof b.quoteId !== 'string' || !b.quoteId || typeof b.lockPubkey !== 'string' || !HEXKEY.test(b.lockPubkey) || (issued.lockPubkey !== undefined && issued.lockPubkey !== b.lockPubkey)) throw invalid();
  if (typeof b.keyNamespace !== 'string' || !isSec(b.keyEpoch) || !isSec(b.derivationIndex) || !shapeRate(b.rate) || !isSec(b.issuedAt) || !isSec(b.expiresAt)) throw invalid();
  // A bound invoice must still be payable, and a quote may never outlive the receiver's own invoice or rate window.
  const nowSec = Math.floor(now.getTime() / 1000);
  if (b.expiresAt <= nowSec || b.rate.validUntil < Math.floor(new Date(issued.expiresAt).getTime() / 1000) || b.expiresAt < Math.floor(new Date(issued.expiresAt).getTime() / 1000) || b.issuedAt > nowSec + 300) throw invalid();
  return b;
}

/** Persists the binding in the caller's transaction (the same one that opens the quote). Idempotent for an identical record; any difference is a hard conflict. */
export async function storeBinding(tx: Db, quoteId: string, b: BindingRecord) {
  const [byQuote] = await tx`SELECT digest FROM hosting_lightning_bindings WHERE quote_id=${quoteId}`;
  if (byQuote) { if (byQuote.digest !== b.digest) throw new HostingError(409, 'binding_conflict'); return; }
  const [bySeq] = await tx`SELECT quote_id FROM hosting_lightning_bindings WHERE treasury_fingerprint=${b.treasuryFingerprint} AND seq=${b.seq}`;
  if (bySeq) throw new HostingError(409, 'binding_conflict');
  await tx`INSERT INTO hosting_lightning_bindings(treasury_fingerprint,seq,quote_id,digest,record) VALUES(${b.treasuryFingerprint},${b.seq},${quoteId},${b.digest},${tx.json(b as any)})`;
}

export type MintOutcome =
  | { kind: 'credit'; evidence: Record<string, unknown>; evidenceDigest: string; settledAt: Date; paidAt: Date | null }
  | { kind: 'pending' }
  | { kind: 'late'; evidence: Record<string, unknown> | null; settledAt: Date | null }
  | { kind: 'mismatch'; reason: string };

/** Decides what a receiver view means for ONE stored quote. Credit only when every field agrees with the quote, its stored binding and trusted configuration. */
export function verifyMintView(view: any, quote: { id: string; payment_hash: string; amount_sats: unknown; expires_at: unknown; payee_ref: string }, binding: BindingRecord, expect: ReceiverExpectation): MintOutcome {
  if (!view || typeof view !== 'object') return { kind: 'mismatch', reason: 'view_invalid' };
  switch (view.status) {
    case 'pending': return { kind: 'pending' };
    case 'unknown': return { kind: 'mismatch', reason: 'receiver_unknown_order' };
    case 'rejected': return { kind: 'mismatch', reason: 'receiver_rejected' };
    case 'late_payment': return { kind: 'late', evidence: view.evidence && typeof view.evidence === 'object' ? view.evidence : null, settledAt: isSec(view.evidence?.settledAt) ? new Date(view.evidence.settledAt * 1000) : null };
    case 'settled': break;
    default: return { kind: 'mismatch', reason: 'view_invalid' };
  }
  const e = view.evidence, bad = (reason: string): MintOutcome => ({ kind: 'mismatch', reason });
  if (view.creditable !== true || !e || typeof e !== 'object') return bad('not_creditable');
  if (e.v !== 1 || e.kind !== 'mint_redemption') return bad('evidence_kind');
  if (typeof view.evidenceDigest !== 'string' || !HEX64.test(view.evidenceDigest) || sha256(canonicalJson(e)) !== view.evidenceDigest) return bad('evidence_digest');
  if (e.orderRef !== quote.id || e.orderRef !== binding.orderRef) return bad('order');
  if (e.paymentHash !== quote.payment_hash || e.paymentHash !== binding.paymentHash) return bad('payment_hash');
  if (e.quoteId !== binding.quoteId || e.mint !== binding.mint || e.mint !== expect.mint) return bad('mint_quote');
  if (e.lockPubkey !== binding.lockPubkey || e.keyNamespace !== binding.keyNamespace || e.keyEpoch !== binding.keyEpoch || e.derivationIndex !== binding.derivationIndex) return bad('lock_key');
  if (!Number.isSafeInteger(e.amountSats) || e.amountSats !== Number(quote.amount_sats) || e.amountSats !== binding.amountSats) return bad('amount');
  if (e.payeeRef !== quote.payee_ref || e.payeeRef !== receiverPayeeRef(expect)) return bad('payee');
  if (e.mintChecked !== true || e.proofsHeld !== 'local_ready_unreserved' || !Number.isSafeInteger(e.proofCount) || e.proofCount < 1) return bad('proofs_not_verified');
  if (typeof e.proofsDigest !== 'string' || !HEX64.test(e.proofsDigest) || typeof e.operationId !== 'string' || !e.operationId || typeof e.claimant !== 'string' || !isSec(e.walletStateSeq)) return bad('evidence_shape');
  if (e.late !== false) return { kind: 'late', evidence: e, settledAt: isSec(e.settledAt) ? new Date(e.settledAt * 1000) : null };
  if (!isSec(e.settledAt) || !(e.paidAt === null || isSec(e.paidAt)) || e.expiresAt !== binding.expiresAt || canonicalJson(e.rate) !== canonicalJson(binding.rate)) return bad('times');
  if (e.settledAt < binding.issuedAt) return bad('times');
  // The stricter of the receiver's own `late` and NStack's quote expiry decides: payment observed after our window is never credited.
  const quoteExpiry = Math.floor(new Date(quote.expires_at as any).getTime() / 1000);
  if ((e.paidAt ?? e.settledAt) > quoteExpiry) return { kind: 'late', evidence: e, settledAt: new Date(e.settledAt * 1000) };
  return { kind: 'credit', evidence: e, evidenceDigest: view.evidenceDigest, settledAt: new Date(e.settledAt * 1000), paidAt: e.paidAt === null ? null : new Date(e.paidAt * 1000) };
}

/** Response of GET /v1/bindings, validated before any record is used. */
export function parseBindingsPage(raw: any, expect: ReceiverExpectation) {
  if (!raw || raw.v !== 1 || raw.treasuryFingerprint !== expect.treasuryFingerprint || !Array.isArray(raw.records) || raw.records.length > 500 || !raw.head || !isSec(raw.head.seq) || !isSec(raw.head.count)) throw invalid('receiver_feed_invalid');
  return { head: { seq: raw.head.seq as number, count: raw.head.count as number }, records: raw.records as BindingRecord[] };
}

export interface FeedReport { verified_through_seq: number; head_seq: number; head_count: number; verified: number; orphans: number; conflicts: number; gap: boolean; behind: boolean; quotes_without_binding: string[] }
/** Completeness check only (never the primary path): walks the receiver's bindings from the verified watermark, proving a gap-free prevSeq chain and
 * that every record is either one of our quotes' stored bindings (identical digest) or an orphan retained for support. */
export async function reconcileBindingFeed(db: Db, fetchPage: (after: number, limit: number) => Promise<unknown>, expect: ReceiverExpectation, limit = 100, maxPages = 20): Promise<FeedReport> {
  const fp = expect.treasuryFingerprint;
  await db`INSERT INTO hosting_lightning_binding_feed(treasury_fingerprint) VALUES(${fp}) ON CONFLICT DO NOTHING`;
  const [feed] = await db`SELECT * FROM hosting_lightning_binding_feed WHERE treasury_fingerprint=${fp}`;
  let through = Number(feed!.verified_through_seq), headSeq = Number(feed!.head_seq), headCount = Number(feed!.head_count);
  let verified = 0, orphans = 0, conflicts = 0, gap = false, behind = false;
  for (let page = 0; page < maxPages; page++) {
    const parsed = parseBindingsPage(await fetchPage(through, limit), expect);
    headSeq = parsed.head.seq; headCount = parsed.head.count;
    if (!parsed.records.length) break;
    let last = through;
    for (const rec of parsed.records) {
      if (!HEX64.test(String(rec?.digest)) || bindingDigest(rec) !== rec.digest || rec.treasuryFingerprint !== fp || !Number.isSafeInteger(rec.seq) || rec.seq <= last) throw invalid('receiver_feed_invalid');
      // prevSeq names the previous issued attempt: a holder of every record sees each link; a break means a record is missing.
      if (rec.prevSeq !== last) { gap = true; break; }
      const [stored] = await db`SELECT quote_id,digest FROM hosting_lightning_bindings WHERE treasury_fingerprint=${fp} AND seq=${rec.seq}`;
      if (stored) { if (stored.digest !== rec.digest) { conflicts++; await db`INSERT INTO hosting_lightning_binding_orphans(treasury_fingerprint,seq,order_ref,digest,record,reason) VALUES(${fp},${rec.seq},${rec.orderRef},${rec.digest},${db.json(rec as any)},'digest_conflict') ON CONFLICT DO NOTHING`; } }
      else { orphans++; await db`INSERT INTO hosting_lightning_binding_orphans(treasury_fingerprint,seq,order_ref,digest,record,reason) VALUES(${fp},${rec.seq},${rec.orderRef},${rec.digest},${db.json(rec as any)},'no_quote_binding') ON CONFLICT DO NOTHING`; }
      last = rec.seq; verified++;
    }
    if (last !== through) { through = last; await db`UPDATE hosting_lightning_binding_feed SET verified_through_seq=${through},head_seq=${headSeq},head_count=${headCount},updated_at=now() WHERE treasury_fingerprint=${fp}`; }
    if (gap) break;
    if (through >= headSeq) break;
    if (page === maxPages - 1) behind = true;
  }
  await db`UPDATE hosting_lightning_binding_feed SET head_seq=${headSeq},head_count=${headCount},updated_at=now() WHERE treasury_fingerprint=${fp}`;
  // Every open mint quote must already have its binding; one without is reported (it can never be credited).
  const missing = await db`SELECT q.id FROM hosting_lightning_quotes q WHERE q.evidence_kind='mint_redemption' AND q.state IN ('open','late_payment','mismatch') AND NOT EXISTS(SELECT 1 FROM hosting_lightning_bindings b WHERE b.quote_id=q.id)`;
  return { verified_through_seq: through, head_seq: headSeq, head_count: headCount, verified, orphans, conflicts, gap, behind, quotes_without_binding: missing.map(r => r.id as string) };
}
