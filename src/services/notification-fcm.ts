import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { secretEnv } from '../secret-env';
import { NotificationError } from './notification-core';
import { genericAlertTitle, type AlertContent, type ApnsOutcome } from './notification-apns';

export const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export type FcmConfig = { projectId: string; senderId: string; packageName: string; email: string; key: KeyObject; fingerprint: string; publicOrigin: string | null };
export function loadFcmConfig(): { ready: true; config: FcmConfig } | { ready: false; reason: string } {
  try {
    const raw = secretEnv('FCM_SERVICE_ACCOUNT_JSON');
    const projectId = process.env.FCM_PROJECT_ID ?? '', senderId = process.env.FCM_SENDER_ID ?? '', packageName = process.env.FCM_ANDROID_PACKAGE ?? '';
    if (!raw || !projectId || !senderId || !packageName) return { ready: false, reason: 'fcm_not_configured' };
    const account = JSON.parse(raw);
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || !/^[1-9][0-9]{4,19}$/.test(senderId) || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)
      || account.type !== 'service_account' || account.project_id !== projectId || typeof account.client_email !== 'string'
      || !new RegExp(`^[a-zA-Z0-9_-]+@${projectId}\\.iam\\.gserviceaccount\\.com$`).test(account.client_email)
      || (account.token_uri !== undefined && account.token_uri !== FCM_TOKEN_URL)) throw new Error();
    const key = createPrivateKey(account.private_key);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
    const fingerprint = createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).update(account.client_email).update(projectId).digest('hex');
    let publicOrigin: string | null = null;
    if (process.env.NOTIF_PUBLIC_ORIGIN) {
      const url = new URL(process.env.NOTIF_PUBLIC_ORIGIN);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
      publicOrigin = url.origin;
    }
    return { ready: true, config: { projectId, senderId, packageName, email: account.client_email, key, fingerprint, publicOrigin } };
  } catch { return { ready: false, reason: 'fcm_invalid_configuration' }; }
}
export type FcmInput = { device_token: string; project_id: string; sender_id: string; package_name: string; preview: 'generic'; lease_seconds: number };
export function parseFcmInput(body: Record<string, any>): FcmInput {
  const state = loadFcmConfig();
  if (!state.ready) throw new NotificationError(409, 'transport_unavailable', state.reason);
  const invalid = () => new NotificationError(400, 'validation_error', 'Invalid FCM registration');
  if (typeof body.device_token !== 'string' || !/^[A-Za-z0-9_:.-]{20,4096}$/.test(body.device_token) || (body.preview ?? 'generic') !== 'generic') throw invalid();
  if (body.project_id !== state.config.projectId || body.sender_id !== state.config.senderId || body.package_name !== state.config.packageName) throw new NotificationError(409, 'provider_mismatch', 'FCM project, sender and package must match this Tower');
  const lease = body.lease_seconds ?? 604800;
  if (!Number.isInteger(lease) || lease < 1 || lease > 2592000) throw invalid();
  return { device_token: body.device_token, project_id: body.project_id, sender_id: body.sender_id, package_name: body.package_name, preview: 'generic', lease_seconds: lease };
}

// Responses and exceptions never escape with provider text, tokens or credential material.
async function boundedJson(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 16384) throw new Error(); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch { return {}; } finally { await reader.cancel().catch(() => {}); }
}
let cache: { fingerprint: string; token: string; expires: number } | null = null;
let pending: { fingerprint: string; promise: Promise<string> } | null = null;
export function resetFcmOAuthCache() { cache = null; pending = null; }
export class FcmAuthError extends Error { constructor(public credential: boolean) { super('fcm_oauth_unavailable'); } }
export async function fcmAccessToken(config: FcmConfig, request: typeof fetch = fetch, now = Date.now()): Promise<string> {
  if (cache?.fingerprint === config.fingerprint && now < cache.expires) return cache.token;
  if (pending?.fingerprint === config.fingerprint) return pending.promise;
  const promise = (async () => {
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const iat = Math.floor(now / 1000);
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: config.email, scope: SCOPE, aud: FCM_TOKEN_URL, iat, exp: iat + 3600 })}`;
    const assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), config.key).toString('base64url')}`;
    let response: Response;
    try { response = await request(FCM_TOKEN_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) }); }
    catch { throw new FcmAuthError(false); }
    const data = await boundedJson(response);
    if (!response.ok) throw new FcmAuthError(response.status >= 400 && response.status < 500 && response.status !== 429);
    if (data.token_type !== 'Bearer' || typeof data.access_token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(data.access_token) || !Number.isFinite(data.expires_in) || data.expires_in <= 60 || data.expires_in > 3600) throw new FcmAuthError(true);
    cache = { fingerprint: config.fingerprint, token: data.access_token, expires: now + (data.expires_in - 60) * 1000 };
    return data.access_token as string;
  })();
  pending = { fingerprint: config.fingerprint, promise };
  try { return await promise; } finally { if (pending?.promise === promise) pending = null; }
}
export function buildFcmPayload(config: FcmConfig, input: { token: string; installationId: string; content: AlertContent; collapseId: string; expiration: number }, now = Date.now()) {
  const c = input.content;
  return { message: { token: input.token,
    notification: { title: genericAlertTitle(c.category, c.coreSource), body: 'Open Ambulando to view.' },
    data: { fd: JSON.stringify({ v: 1, installation_id: input.installationId, origin: c.origin, tower_service_npub: c.towerServiceNpub, workspace_id: c.workspaceId, notification_id: c.itemId, change_seq: c.changeSeq }) },
    android: { priority: 'HIGH', restricted_package_name: config.packageName, ttl: `${Math.max(0, Math.min(86400, input.expiration - Math.floor(now / 1000)))}s`,
      notification: { channel_id: 'workspace_activity_v1', click_action: 'studio.otherstuff.ambulando.PUSH_TAP', tag: `${input.installationId}:${c.workspaceId}:${c.itemId}`, sound: 'default' } },
  } };
}
const CODES = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH', 'INVALID_ARGUMENT', 'QUOTA_EXCEEDED', 'UNAVAILABLE', 'INTERNAL', 'THIRD_PARTY_AUTH_ERROR']);
export type FcmResult = { status: number; code: string | null; retryAfterMs: number | null };
export function classifyFcmResult(result: FcmResult): ApnsOutcome {
  if (result.status === 200) return 'sent';
  if (result.status === 404 && result.code === 'UNREGISTERED') return 'stale_token';
  if ([401,403].includes(result.status) || result.code === 'SENDER_ID_MISMATCH' || result.code === 'THIRD_PARTY_AUTH_ERROR') return 'credential';
  if (result.status === 0 || result.status === 429 || result.status >= 500) return 'transient';
  // INVALID_ARGUMENT also describes malformed payloads; never revoke a device for it.
  return 'permanent';
}
export type FcmSender = (config: FcmConfig, input: Parameters<typeof buildFcmPayload>[1]) => Promise<FcmResult>;
export async function sendFcm(config: FcmConfig, input: Parameters<typeof buildFcmPayload>[1], request: typeof fetch = fetch): Promise<FcmResult> {
  const token = await fcmAccessToken(config, request);
  let response: Response;
  try { response = await request(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(buildFcmPayload(config, input)) }); }
  catch { return { status: 0, code: null, retryAfterMs: null }; }
  const data = await boundedJson(response);
  const code = Array.isArray(data.error?.details) ? data.error.details.find((d: any) => d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && CODES.has(d.errorCode))?.errorCode ?? null : null;
  const retry = response.headers.get('retry-after');
  const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
  return { status: response.status, code, retryAfterMs: Number.isFinite(delay) && delay > 0 ? Math.min(delay, 86400000) : null };
}
