import { Hono } from 'hono';
import { requireNip98AuthResolved, verifyStrictNip98Mutation } from '../auth';
import { HostingError } from '../services/hosting-billing';
import { backupThrottles, clientKey, getOwnIdentityBackup, getPublicIdentityBackup, putIdentityBackup } from '../services/hosted-identity-backup';

/** Hosted identity backup: opaque ncryptsec only. Public read returns ciphertext and revision, never an npub. */
export const identityBackupRouter = new Hono();
const guard = (handler: (c: any) => Promise<Response>) => async (c: any) => {
  c.header('Cache-Control', 'no-store');
  try { return await handler(c); }
  catch (e) {
    if (e instanceof HostingError) return c.json({ code: e.code, error: e.message, ...((e as any).extra ?? {}) }, e.status as any);
    throw e;
  }
};
function throttle(c: any, ...buckets: [{ take(key: string): number }, string][]) {
  for (const [bucket, key] of buckets) {
    const wait = bucket.take(key);
    if (wait) { c.header('Retry-After', String(wait)); throw new HostingError(429, 'rate_limited'); }
  }
}
const ip = (c: any) => clientKey(c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'));

identityBackupRouter.get('/me', guard(async c => {
  throttle(c, [backupThrottles.readIp, `me:${ip(c)}`]);
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) throw new HostingError(401, 'nip98_auth_required');
  if (auth.userNpub !== auth.signerNpub) throw new HostingError(403, 'direct_user_signature_required');
  return c.json(await getOwnIdentityBackup(auth.signerNpub));
}));
identityBackupRouter.get('/:username', guard(async c => {
  throttle(c, [backupThrottles.readIp, `get:${ip(c)}`], [backupThrottles.readGlobal, 'global']);
  return c.json(await getPublicIdentityBackup(c.req.param('username')));
}));
identityBackupRouter.put('/:username', guard(async c => {
  throttle(c, [backupThrottles.writeIp, `put:${ip(c)}`], [backupThrottles.writeGlobal, 'global']);
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > 1024) throw new HostingError(400, 'body_too_large');
  const proof = await verifyStrictNip98Mutation(c.req.header('authorization') ?? null, c.req.raw, raw);
  if (!proof.ok) throw new HostingError(401, proof.reasonCode);
  // The key that signs is the owner; no workspace-key delegation.
  if (proof.userNpub !== proof.signerNpub) throw new HostingError(403, 'direct_user_signature_required');
  throttle(c, [backupThrottles.writeOwner, proof.signerNpub]);
  let body: any;
  try { body = JSON.parse(raw); } catch { throw new HostingError(400, 'invalid_json'); }
  const result = await putIdentityBackup(proof.signerNpub, c.req.param('username'), body);
  return c.json(result, result.created ? 201 : 200);
}));
