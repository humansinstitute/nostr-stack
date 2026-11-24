import { createHash, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { HostingError } from './hosting-billing';
import type { LightningProvider } from './hosting-lightning';
import { receiverPayeeRef, type ReceiverExpectation } from './hosting-lightning-receiver';

/** Fail-closed private transport to the isolated mint-backed receiver.
 *
 * The receiver's responses are NOT signed, and credit is money, so authenticity comes from the channel: https only, to ONE operator-configured
 * origin, and the server certificate must chain to a CA/certificate pinned in trusted configuration (the default trust store is never used).
 * No caller supplies a URL, there is no redirect following, no proxy, no plain http, bounded time and size, and JSON only. DNS cannot redirect
 * the client to another host without that host presenting a certificate from the pinned CA. Requests are NIP-98 signed with Tower's own
 * service identity for the exact URL, method and body, so the receiver can allowlist this service. */
export interface ReceiverTransport {
  put(orderRef: string, body: { currency: 'USD'; amountMinor: number }): Promise<unknown>;
  settle(orderRef: string): Promise<unknown>;
  evidence(orderRef: string): Promise<unknown>;
  bindings(after: number, limit: number): Promise<unknown>;
}
export interface ReceiverClientOptions {
  /** https://host[:port] exactly; this is also the origin the receiver verifies in the signed `u` tag. */
  origin: string;
  /** PEM of the pinned certificate or private CA. Required. */
  caPem: string;
  /** Tower's service secret key (nsec). Held in memory only for signing. */
  serviceNsec: string;
  timeoutMs?: number; maxBytes?: number; now?: () => number;
}
const ORDER_REF = /^[A-Za-z0-9_\-:.]{1,64}$/;
const fail = (code: string, status = 502) => new HostingError(status, code);

export function validateReceiverOrigin(origin: string): URL {
  let u: URL;
  try { u = new URL(origin); } catch { throw fail('receiver_config_invalid', 503); }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || u.origin !== origin || !u.hostname) throw fail('receiver_config_invalid', 503);
  return u;
}

export function createReceiverClient(o: ReceiverClientOptions): ReceiverTransport {
  const base = validateReceiverOrigin(o.origin);
  if (typeof o.caPem !== 'string' || !/-----BEGIN CERTIFICATE-----/.test(o.caPem)) throw fail('receiver_config_invalid', 503);
  const decoded = nip19.decode(o.serviceNsec);
  if (decoded.type !== 'nsec') throw fail('receiver_config_invalid', 503);
  const secret = decoded.data;
  const timeoutMs = o.timeoutMs ?? 10_000, maxBytes = o.maxBytes ?? 256 * 1024, clock = o.now ?? (() => Date.now());
  const servername = /^[\d.]+$|:/.test(base.hostname) ? undefined : base.hostname; // IP literals take no SNI; the pinned certificate must still match the address

  function send(method: string, target: string, bodyText: string | null): Promise<unknown> {
    const url = `${o.origin}${target}`;
    const tags: string[][] = [['u', url], ['method', method]];
    if (bodyText !== null) tags.push(['payload', createHash('sha256').update(bodyText, 'utf8').digest('hex')]);
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(clock() / 1000), content: randomBytes(16).toString('hex'), tags }, secret);
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` };
    if (bodyText !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(bodyText)); }
    return new Promise((resolve, reject) => {
      const req = httpsRequest({
        protocol: 'https:', hostname: base.hostname, port: base.port || 443, method, path: target, headers, agent: false,
        ca: o.caPem, rejectUnauthorized: true, servername, timeout: timeoutMs, minVersion: 'TLSv1.2',
      }, res => {
        const status = res.statusCode ?? 0;
        // Redirects, informational and anything non-JSON are protocol failures: never followed, never interpreted.
        const type = String(res.headers['content-type'] ?? '');
        const chunks: Buffer[] = []; let n = 0;
        res.on('data', (c: Buffer) => { n += c.length; if (n > maxBytes) { req.destroy(); reject(fail('receiver_response_too_large')); } else chunks.push(c); });
        res.on('end', () => {
          if (status < 200 || status >= 300) return reject(fail(status >= 500 || status === 429 ? 'receiver_unavailable' : 'receiver_rejected'));
          if (!/^application\/json\b/i.test(type)) return reject(fail('receiver_response_invalid'));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(fail('receiver_response_invalid')); }
        });
        res.on('error', () => reject(fail('receiver_unavailable')));
      });
      req.on('timeout', () => { req.destroy(); reject(fail('receiver_unavailable')); });
      req.on('error', () => reject(fail('receiver_unavailable')));
      if (bodyText !== null) req.write(bodyText);
      req.end();
    });
  }
  const order = (ref: string) => { if (typeof ref !== 'string' || !ORDER_REF.test(ref)) throw fail('receiver_request_invalid', 400); return encodeURIComponent(ref); };
  return {
    put: async (ref, body) => send('PUT', `/v1/orders/${order(ref)}`, JSON.stringify({ currency: body.currency, amountMinor: body.amountMinor })),
    settle: async ref => send('POST', `/v1/orders/${order(ref)}/settle`, null),
    evidence: async ref => send('GET', `/v1/orders/${order(ref)}/evidence`, null),
    bindings: async (after, limit) => {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw fail('receiver_request_invalid', 400);
      return send('GET', `/v1/bindings?after=${after}&limit=${limit}`, null);
    },
  };
}

const iso = (sec: number) => new Date(sec * 1000).toISOString();
/** Mint-backed provider over a receiver transport. Registration is a trusted startup act (`configureLightningProvider`); nothing here reads the
 * environment. Refunds are unavailable: the receiver has no payout, so `payouts` is deliberately undefined. */
export function createReceiverLightningProvider(transport: ReceiverTransport, expect: ReceiverExpectation, id = 'cashu-receiver'): LightningProvider {
  if (!expect?.mint || !expect.treasuryFingerprint) throw fail('receiver_config_invalid', 503);
  return {
    id, evidenceKind: 'mint_redemption', mintBacked: { mint: expect.mint, treasuryFingerprint: expect.treasuryFingerprint }, payeeRef: receiverPayeeRef(expect),
    async issueInvoice({ orderRef, amountCents }) {
      const r = (await transport.put(orderRef, { currency: 'USD', amountMinor: amountCents })) as any;
      if (!r || r.orderRef !== orderRef || typeof r.invoice !== 'string' || typeof r.paymentHash !== 'string' || !Number.isSafeInteger(r.amountSats) || !Number.isSafeInteger(r.expiresAt)
        || typeof r.payeeRef !== 'string' || !r.rate || !Number.isSafeInteger(r.rate.quotedAt) || !Number.isSafeInteger(r.rate.validUntil) || typeof r.rate.source !== 'string' || !r.binding) throw fail('receiver_response_invalid');
      // The quote never outlives the receiver's invoice or its rate window.
      return {
        invoice: r.invoice, paymentHash: r.paymentHash, amountSats: r.amountSats, expiresAt: iso(Math.min(r.expiresAt, r.rate.validUntil)), payeeRef: r.payeeRef,
        rate: { source: r.rate.source, quotedAt: iso(r.rate.quotedAt), ref: typeof r.rate.ref === 'string' ? r.rate.ref : undefined }, binding: r.binding, lockPubkey: typeof r.lockPubkey === 'string' ? r.lockPubkey : undefined,
      };
    },
    // Mint settlement is by order, never by payment hash alone; credit goes only through NStack's verifier.
    async lookupInvoice() { throw fail('receiver_lookup_by_order_only', 500); },
    settleOrder: orderRef => transport.settle(orderRef),
    bindingsPage: (after, limit) => transport.bindings(after, limit),
  };
}
