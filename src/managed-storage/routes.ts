import { Hono } from 'hono';
import { getEffectiveRequestUrl } from '../auth';
import { config } from '../config';
import { getDb } from '../db';
import { getInsufficientCreditsBlock } from '../services/billing';
import { hostingWriteBlock } from '../services/hosting-billing';
import { storageControlProof } from './auth';
import { createStorageBlobs } from './blobs';
import { boundedBytes, CONTROL_BYTES, exactObject, MAX_OBJECT_BYTES, PREFIX, PROTOCOL, requireCondition, StorageDelegationError, TOKEN_HEADER, tokenPattern, TRANSFER_MS, uuid } from './contract';
import { readStorageGrants } from './grants';
import { StorageLedger } from './ledger';
import { ManagedStorageService } from './service';

const common = ['installation_id', 'app_id', 'revision', 'expected_service_npub'];
export function createManagedStorageRouter(service: ManagedStorageService) {
  const router = new Hono();
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  router.onError((error, c) => {
    c.header('Cache-Control', 'private, no-store');
    // Never include provider errors or token headers in logs/responses.
    if (error instanceof StorageDelegationError) return c.json({ error: error.code }, error.status as 400);
    return c.json({ error: 'storage_unavailable' }, 503);
  });
  router.get('/descriptor', c => {
    requireCondition(service.configured(), 'storage_delegation_unsupported', 404);
    return c.json({ protocol: PROTOCOL, max_object_bytes: MAX_OBJECT_BYTES, max_receipt_bytes: 6144, token_ttl_seconds: 60,
      transfer_timeout_seconds: TRANSFER_MS / 1000, billing_modes: ['operator_budget'],
      features: ['durable_idempotency', 'quota_reservations', 'private_objects', 'immutable_completion', 'revocable_downloads', 'bounded_stream_uploads', 'recovery_status', 'publisher_receipts'] });
  });
  router.all('/workspaces/:workspaceId/delegations/:delegationId/*', async c => {
    requireCondition(service.configured(), 'storage_delegation_unsupported', 404);
    const workspace = c.req.param('workspaceId')!, delegation = c.req.param('delegationId')!;
    requireCondition(uuid.test(workspace) && uuid.test(delegation), 'storage_delegation_denied', 403);
    const effective = getEffectiveRequestUrl(c.req.raw);
    requireCondition(!effective.search && !effective.hash, 'storage_request_invalid');
    const prefix = `/api/v4/managed-app-storage/workspaces/${workspace}/delegations/${delegation}/`;
    requireCondition(effective.pathname.startsWith(prefix), 'storage_request_invalid');
    const tail = effective.pathname.slice(prefix.length);
    const object = /^objects\/([0-9a-f-]{36})\/(upload|download|complete|status|download-url)$/.exec(tail);
    const id = object?.[1];
    const action = object?.[2] ?? tail;
    if (id) requireCondition(uuid.test(id), 'storage_request_invalid');
    requireCondition(id || action === 'prepare' || action === 'status', 'storage_operation_not_allowed', 404);
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(TRANSFER_MS)]);
    if (action === 'upload' || action === 'download') {
      requireCondition(c.req.method === (action === 'upload' ? 'PUT' : 'GET'), 'storage_method_not_allowed', 405);
      const token = c.req.header(TOKEN_HEADER);
      requireCondition(token && tokenPattern.test(token), 'storage_stream_denied', 403);
      const grant = await service.authorize(workspace, delegation, effective.origin);
      if (action === 'upload') return c.json(await service.upload(grant, id!, token, c.req.raw, signal));
      const bytes = await service.download(grant, id!, token, signal);
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.byteLength), 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
    }
    requireCondition(c.req.method === 'POST', 'storage_method_not_allowed', 405);
    requireCondition(c.req.header('content-type')?.split(';')[0] === 'application/json', 'storage_json_required', 415);
    const raw = new TextDecoder().decode(await boundedBytes(c.req.raw.body, CONTROL_BYTES, signal));
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new StorageDelegationError('storage_request_invalid'); }
    const body = exactObject(parsed, action === 'prepare' ? [...common, 'idempotency_key', 'sha256_hex', 'size_bytes'] : action === 'status' && !id ? [...common, 'cursor'] : common);
    const proof = storageControlProof(c.req.raw, raw);
    const grant = await service.authorize(workspace, delegation, effective.origin, proof.signer);
    requireCondition(body.installation_id === grant.installationId && body.app_id === grant.appId
      && body.revision === grant.revision && body.expected_service_npub === grant.serviceNpub,
    'storage_delegation_denied', 403);
    if (action === 'prepare') {
      requireCondition(Buffer.byteLength(raw) <= 2048, 'storage_receipt_invalid', 413);
      return c.json(await service.prepare(grant, body, proof.receipt));
    }
    if (action === 'status') {
      if (Object.hasOwn(body, 'cursor')) requireCondition(typeof body.cursor === 'string', 'storage_cursor_invalid');
      return c.json(await service.status(grant, id, body.cursor as string | undefined));
    }
    if (action === 'complete') return c.json(await service.complete(grant, id!, signal));
    if (action === 'download-url') return c.json(await service.downloadUrl(grant, id!));
    throw new StorageDelegationError('storage_operation_not_allowed', 404);
  });
  return router;
}

// Lazy dependencies: importing the route does not connect to PG or provision keys.
let service: ManagedStorageService | undefined;
export function getManagedStorageService(): ManagedStorageService {
  return service ??= new ManagedStorageService({ ledger: new StorageLedger(getDb()), blobs: createStorageBlobs(),
    grants: readStorageGrants, serviceNpub: () => config.service.npub || null,
    creditBlock: async (grant, db) => Boolean(await hostingWriteBlock(grant.workspaceId, db)
      || await getInsufficientCreditsBlock(grant.workspaceOwnerNpub, db)),
  });
}
export function createLazyManagedStorageRouter(resolveService: () => ManagedStorageService) {
  const forwarder = new Hono();
  let mounted: Hono | undefined;
  forwarder.all('*', c => {
    mounted ??= new Hono().route(PREFIX, createManagedStorageRouter(resolveService()));
    return mounted.fetch(c.req.raw);
  });
  return forwarder;
}
export const managedStorageRouter = createLazyManagedStorageRouter(getManagedStorageService);
