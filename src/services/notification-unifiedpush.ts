import { createECDH, ECDH } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import tls from 'node:tls';
import webpush from 'web-push';
import { NotificationError } from './notification-core';

const invalid = () => new NotificationError(400, 'validation_error', 'Invalid UnifiedPush registration');
export type UnifiedPushInput = { endpoint: string; keys: { p256dh: string; auth: string }; preview: 'generic'; lease_seconds: number };
export type UnifiedPushConfig = { publicKey: string; privateKey: string; subject: string; origins: Set<string>; publicOrigin: string | null };
export function decodeKey(value: unknown, length: number) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw invalid();
  return bytes;
}
export function endpointUrl(endpoint: unknown, origins: Set<string>) {
  if (typeof endpoint !== 'string' || Buffer.byteLength(endpoint) > 1000) throw invalid();
  let url: URL;
  try { url = new URL(endpoint); } catch { throw invalid(); }
  if (Buffer.byteLength(url.href) > 1000 || url.protocol !== 'https:' || url.username || url.password || url.hash || endpoint.includes('#') || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !origins.has(url.origin)) throw invalid();
  return url;
}
export function loadUnifiedPushConfig(): { ready: true; config: UnifiedPushConfig } | { ready: false; reason: string } {
  const publicKey = Bun.env.UNIFIEDPUSH_VAPID_PUBLIC_KEY, privateKey = Bun.env.UNIFIEDPUSH_VAPID_PRIVATE_KEY, subject = Bun.env.UNIFIEDPUSH_VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject || !Bun.env.UNIFIEDPUSH_ALLOWED_ORIGINS) return { ready: false, reason: 'unifiedpush_not_configured' };
  try {
    const ec = createECDH('prime256v1'); ec.setPrivateKey(decodeKey(privateKey, 32));
    if (!ec.getPublicKey().equals(decodeKey(publicKey, 65))) throw invalid();
    const contact = new URL(subject); if (!['https:', 'mailto:'].includes(contact.protocol)) throw invalid();
    const origins = new Set(Bun.env.UNIFIEDPUSH_ALLOWED_ORIGINS.split(',').map(s => s.trim()));
    for (const origin of origins) { if (new URL(origin).origin !== origin) throw invalid(); endpointUrl(origin, origins); }
    const origin = Bun.env.NOTIF_PUBLIC_ORIGIN;
    const publicOrigin = origin && new URL(origin).protocol === 'https:' ? new URL(origin).origin : null;
    return { ready: true, config: { publicKey, privateKey, subject, origins, publicOrigin } };
  } catch { return { ready: false, reason: 'unifiedpush_invalid_configuration' }; }
}
export function parseUnifiedPushInput(body: Record<string, any>): UnifiedPushInput {
  const state = loadUnifiedPushConfig();
  if (!state.ready) throw new NotificationError(409, 'transport_unavailable', state.reason);
  const endpoint = endpointUrl(body.endpoint, state.config.origins).href;
  const p = decodeKey(body.keys?.p256dh, 65); decodeKey(body.keys?.auth, 16);
  try { if (p[0] !== 4) throw invalid(); ECDH.convertKey(p, 'prime256v1'); } catch { throw invalid(); }
  if (!body.keys || Object.keys(body.keys).some(k => !['p256dh', 'auth'].includes(k)) || (body.preview ?? 'generic') !== 'generic') throw invalid();
  const lease = body.lease_seconds ?? 604800;
  if (!Number.isInteger(lease) || lease < 1 || lease > 2592000) throw invalid();
  return { endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth }, preview: 'generic', lease_seconds: lease };
}

// Accept globally routable IPv4 only, or native global-unicast IPv6. Reject mapped/tunnel/special ranges.
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const first = parseInt(address.split(':')[0]!, 16);
  const second = parseInt(address.split(':')[1] || '0', 16);
  return first >= 0x2000 && first < 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
}
export async function resolveEndpoint(endpoint: string, origins: Set<string>, resolver = lookup) {
  const url = endpointUrl(endpoint, origins);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const records = await Promise.race([resolver(url.hostname, { all: true, verbatim: true }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('unifiedpush_dns_timeout')), 5000); })]).finally(() => clearTimeout(timer));
  if (!records.length || records.some(r => !publicAddress(r.address))) throw new Error('unifiedpush_endpoint_blocked');
  return { url, address: records[0]! };
}
export type UnifiedPushSender = typeof sendUnifiedPush;
export async function sendUnifiedPush(config: UnifiedPushConfig, input: { endpoint: string; keys: { p256dh: string; auth: string }; body: string; expiration: number }, deps: { resolver?: typeof lookup; connect?: typeof tls.connect } = {}) {
  const { url, address } = await resolveEndpoint(input.endpoint, config.origins, deps.resolver);
  const details = webpush.generateRequestDetails({ endpoint: input.endpoint, keys: input.keys }, input.body, {
    vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey }, contentEncoding: 'aes128gcm', TTL: Math.max(0, Math.min(86400, input.expiration - Math.floor(Date.now()/1000))),
  });
  // Bun 1.2 rewrites an https.request custom lookup to an IP URL, breaking hostname verification.
  // Direct TLS retains the original servername while connecting only to the validated IP. No DNS, proxy,
  // connection pool or redirect machinery exists after this point. Only bounded response headers are read.
  return new Promise<{ status: number; retryAfterMs: number | null }>((resolve, reject) => {
    let finished = false;
    let headers = Buffer.alloc(0);
    const finish = (result?: { status: number; retryAfterMs: number | null }) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      socket.destroy();
      if (result) resolve(result); else reject(new Error('unifiedpush_network_error'));
    };
    const socket = (deps.connect ?? tls.connect)({
      host: address.address, port: Number(url.port || 443), servername: url.hostname,
      rejectUnauthorized: true, ALPNProtocols: ['http/1.1'],
    }, () => {
      const payload = Buffer.from(details.body ?? '');
      const outgoing = { ...details.headers, Host: url.host, Connection: 'close', 'Content-Length': String(payload.length) };
      const lines = Object.entries(outgoing).map(([name, value]) => `${name}: ${value}`);
      socket.write(`POST ${url.pathname}${url.search} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      socket.write(payload);
    });
    const deadline = setTimeout(() => finish(), 10000);
    socket.on('error', () => finish());
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('data', (chunk: Buffer) => {
      // Ignore provider bodies entirely; neither error strings nor URLs enter logs/attempt records.
      const capacity = 16384 - headers.length;
      headers = Buffer.concat([headers, chunk.subarray(0, capacity)]);
      const end = headers.indexOf('\r\n\r\n');
      if (end < 0) { if (headers.length >= 16384) finish(); return; }
      const lines = headers.subarray(0, end).toString('latin1').split('\r\n');
      const match = /^HTTP\/1\.[01] ([2-5][0-9]{2})(?:[ \t]|$)/.exec(lines.shift() ?? '');
      if (!match) { finish(); return; }
      const retry = lines.find(line => /^retry-after:/i.test(line))?.split(':').slice(1).join(':').trim();
      const seconds = Number(retry);
      finish({ status: Number(match[1]), retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 86400000) : null });
    });
  });
}

export function classifyUnifiedPushResult(status: number) {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 404 || status === 410) return 'stale_token';
  if (status === 401 || status === 403) return 'credential';
  if (status === 429 || status >= 500 || status === 0) return 'transient';
  return 'permanent';
}
