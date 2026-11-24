import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';
import { createReceiverClient, createReceiverLightningProvider, validateReceiverOrigin } from '../src/services/lightning-receiver-client';
import { FakeMintReceiver } from './helpers/fake-mint-receiver';

/** Real TLS against an in-process receiver that verifies NIP-98 exactly as the real one does (fresh, exact URL/method/body hash, caller allowlist, one use). */
function selfSigned(dir: string, cn: string) {
  const key = join(dir, `${cn}.key`), crt = join(dir, `${cn}.crt`);
  const r = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', `/CN=${cn}`, '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost']);
  if (r.exitCode !== 0) throw new Error(`openssl failed: ${r.stderr.toString()}`);
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(crt, 'utf8') };
}

describe('receiver private transport (real TLS)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recv-'));
  const secret = generateSecretKey(), nsec = nip19.nsecEncode(secret), serviceHex = getPublicKey(secret);
  let good: ReturnType<typeof selfSigned>, evil: ReturnType<typeof selfSigned>;
  let server: Server, port = 0, rx: FakeMintReceiver;
  const seen = new Set<string>(); let mode: 'ok' | 'redirect' | 'html' | 'huge' | 'slow' | 'error500' | 'drip' | 'hang' = 'ok'; const log: { method: string; url: string }[] = [];
  const allowed = new Set<string>();

  function authorize(req: any, body: Buffer, origin: string) {
    const h = String(req.headers.authorization ?? '');
    if (!h.startsWith('Nostr ')) throw new Error('missing');
    const ev = JSON.parse(Buffer.from(h.slice(6), 'base64').toString('utf8'));
    if (!verifyEvent(ev) || ev.kind !== 27235 || Math.abs(Date.now() / 1000 - ev.created_at) > 60 || ev.content.length > 64) throw new Error('bad event');
    if (ev.tags.some((t: string[]) => !['u', 'method', 'payload'].includes(t[0]!))) throw new Error('tag');
    const tag = (n: string) => ev.tags.filter((t: string[]) => t[0] === n).map((t: string[]) => t[1]);
    if (tag('u').length !== 1 || tag('u')[0] !== `${origin}${req.url}`) throw new Error('url');
    if (tag('method')[0]?.toUpperCase() !== req.method) throw new Error('method');
    if (body.length ? tag('payload')[0] !== createHash('sha256').update(body).digest('hex') : tag('payload').length) throw new Error('payload');
    if (seen.has(ev.id)) throw new Error('replay');
    seen.add(ev.id);
    if (!allowed.has(ev.pubkey)) throw new Error('caller');
  }
  beforeAll(async () => {
    good = selfSigned(dir, 'receiver-good'); evil = selfSigned(dir, 'receiver-evil'); rx = new FakeMintReceiver(); allowed.add(serviceHex);
    server = createHttpsServer({ key: good.key, cert: good.cert }, async (req, res) => {
      log.push({ method: req.method!, url: req.url! });
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const send = (status: number, payload: unknown, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
      try {
        if (mode === 'redirect') { res.writeHead(302, { location: 'https://127.0.0.1:1/steal' }); return void res.end(); }
        if (mode === 'html') return send(200, '<html>', 'text/html');
        if (mode === 'huge') return send(200, JSON.stringify({ pad: 'x'.repeat(2_000_000) }));
        if (mode === 'slow') return void setTimeout(() => send(200, {}), 2000);
        if (mode === 'error500') return send(500, { error: 'internal' });
        if (mode === 'hang') return; // never answers
        if (mode === 'drip') {
          // Slow-drip: a byte every 100 ms keeps the socket 'active' forever from an inactivity timer's point of view.
          res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"pad":"');
          let i = 0; const t = setInterval(() => { if (res.destroyed || ++i > 60) { clearInterval(t); if (!res.destroyed) res.end('"}'); } else res.write('x'); }, 100);
          return;
        }
        authorize(req, body, `https://127.0.0.1:${port}`);
        const url = new URL(req.url!, 'http://x'); const m = url.pathname.match(/^\/v1\/orders\/([^/]+)(\/settle|\/evidence)?$/);
        if (m && req.method === 'PUT' && !m[2]) return send(200, await rx.put(decodeURIComponent(m[1]!), JSON.parse(body.toString())));
        if (m && req.method === 'POST' && m[2] === '/settle') return send(200, await rx.settle(decodeURIComponent(m[1]!)));
        if (m && req.method === 'GET' && m[2] === '/evidence') return send(200, await rx.evidence(decodeURIComponent(m[1]!)));
        if (url.pathname === '/v1/bindings') return send(200, await rx.bindings(Number(url.searchParams.get('after')), Number(url.searchParams.get('limit'))));
        return send(404, { error: 'not_found' });
      } catch (e) { return send(401, { error: 'unauthorized', message: String((e as Error).message) }); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as any).port;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const client = (over: Record<string, unknown> = {}) => createReceiverClient({ origin: `https://127.0.0.1:${port}`, caPem: good.cert, serviceNsec: nsec, ...over } as any);

  test('signed requests carry the exact URL, method and body hash; the full order flow works through the provider', async () => {
    mode = 'ok';
    const provider = createReceiverLightningProvider(client(), rx.expectation);
    const issued = await provider.issueInvoice({ orderRef: 'order-1', amountCents: 2100 });
    expect(issued).toMatchObject({ amountSats: 2100 * 25, payeeRef: rx.payeeRef });
    expect((issued.binding as any).orderRef).toBe('order-1');
    // Quote expiry is the earlier of invoice expiry and rate validity.
    expect(new Date(issued.expiresAt).getTime() / 1000).toBeLessThanOrEqual(rx.attempts.get('order-1')!.binding.expiresAt);
    expect(await provider.settleOrder!('order-1')).toMatchObject({ status: 'pending' });
    rx.pay('order-1');
    expect(await provider.settleOrder!('order-1')).toMatchObject({ status: 'settled', creditable: true });
    expect(await client().bindings(0, 10)).toMatchObject({ v: 1, head: { count: 1 } });
    expect(await client().evidence('order-1')).toMatchObject({ status: 'settled' });
    expect(log.some(l => l.method === 'POST' && l.url === '/v1/orders/order-1/settle')).toBe(true);
    await expect(provider.lookupInvoice('00'.repeat(32))).rejects.toThrow();
    expect(provider.payouts).toBeUndefined();
  });

  test('an unlisted service key is refused by the receiver and surfaces as a generic failure', async () => {
    allowed.delete(serviceHex);
    try { await expect(client().evidence('order-1')).rejects.toMatchObject({ code: 'receiver_rejected' }); } finally { allowed.add(serviceHex); }
  });

  test('fail closed: the pinned certificate is mandatory, a different certificate for the same address is refused, and redirects are never followed', async () => {
    mode = 'ok';
    await expect(client({ caPem: evil.cert }).evidence('order-1')).rejects.toMatchObject({ code: 'receiver_unavailable' });
    expect(() => createReceiverClient({ origin: `https://127.0.0.1:${port}`, caPem: '', serviceNsec: nsec })).toThrow();
    // The system trust store is not consulted: a client pinned to nothing valid cannot talk to this self-signed server at all.
    await expect(client({ caPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' }).evidence('order-1')).rejects.toBeDefined();
    mode = 'redirect';
    const before = log.length;
    await expect(client().evidence('order-1')).rejects.toMatchObject({ code: 'receiver_rejected' });
    expect(log.length).toBe(before + 1); // exactly one request; the Location target was never contacted
    mode = 'ok';
  });

  test('bounded and typed: non-JSON, oversized, slow and 5xx responses are failures, never interpreted', async () => {
    mode = 'html'; await expect(client().evidence('o')).rejects.toMatchObject({ code: 'receiver_response_invalid' });
    mode = 'huge'; await expect(client({ maxBytes: 4096 }).evidence('o')).rejects.toMatchObject({ code: 'receiver_response_too_large' });
    mode = 'slow'; await expect(client({ timeoutMs: 300 }).evidence('o')).rejects.toMatchObject({ code: 'receiver_unavailable' });
    mode = 'error500'; await expect(client().evidence('o')).rejects.toMatchObject({ code: 'receiver_unavailable' });
    mode = 'ok';
  });

  test('one absolute deadline: a slow-drip body below the inactivity timeout is still cut off, and later requests proceed', async () => {
    mode = 'drip';
    const c = client({ timeoutMs: 600 });
    const t0 = Date.now();
    await expect(c.evidence('o')).rejects.toMatchObject({ code: 'receiver_unavailable' });
    expect(Date.now() - t0).toBeLessThan(2000); // the body would have taken ~6 s
    mode = 'ok';
    expect(await c.evidence('order-1')).toMatchObject({ status: 'settled' }); // the slot and timer were released
  });

  test('in-flight and waiting work are bounded; excess fails fast and slots are always returned', async () => {
    mode = 'hang';
    const c = client({ timeoutMs: 700, maxInFlight: 1, maxWaiting: 1 });
    const first = c.evidence('a').catch(e => e), second = c.evidence('b').catch(e => e);
    await new Promise(r => setTimeout(r, 50));
    await expect(c.evidence('c')).rejects.toMatchObject({ code: 'receiver_busy', status: 503 });
    const t0 = Date.now();
    expect(await first).toMatchObject({ code: 'receiver_unavailable' });
    expect(await second).toMatchObject({ code: 'receiver_unavailable' });
    expect(Date.now() - t0).toBeLessThan(2500);
    mode = 'ok';
    expect(await c.evidence('order-1')).toMatchObject({ status: 'settled' });
  });

  test('no caller-chosen destination: origin shape and order references are validated, no plain http', async () => {
    for (const bad of ['http://127.0.0.1:1', ['https://', 'user', ':', 'pw', '@host'].join(''), 'https://host/path', 'https://host?x=1', 'https://host#f', 'ftp://host', 'host', 'https://host/']) expect(() => validateReceiverOrigin(bad)).toThrow();
    expect(validateReceiverOrigin('https://receiver.internal:8443').port).toBe('8443');
    for (const ref of ['../etc', 'a/b', 'a b', '', 'x'.repeat(65), 'a?b=c']) await expect(client().evidence(ref)).rejects.toMatchObject({ code: 'receiver_request_invalid' });
    await expect(client().bindings(-1, 10)).rejects.toMatchObject({ code: 'receiver_request_invalid' });
    await expect(client().bindings(0, 501)).rejects.toMatchObject({ code: 'receiver_request_invalid' });
    // Plain http listener must never be reachable through the client.
    const plain = createHttpServer((_q, r) => { r.end('{}'); }); await new Promise<void>(r => plain.listen(0, '127.0.0.1', r));
    try { await expect(createReceiverClient({ origin: `https://127.0.0.1:${(plain.address() as any).port}`, caPem: good.cert, serviceNsec: nsec }).evidence('o')).rejects.toMatchObject({ code: 'receiver_unavailable' }); } finally { plain.close(); }
    void randomBytes;
  });
});
