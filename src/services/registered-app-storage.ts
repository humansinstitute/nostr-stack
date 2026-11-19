import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { getInsufficientCreditsBlock } from './billing';
import { hostingWriteBlock } from './hosting-billing';
import { hashStorageBytes, getStorageObjectContent, writeAuthorizedStorageBytes } from './storage';
import type { V4StorageObject, RegisteredAppStoragePrepare, RegisteredAppStorageMetadata } from '../types';

export const REGISTERED_APP_STORAGE_PROTOCOL = 'registered-app-storage-v1' as const;
export const APP_STORAGE_MAX_BYTES = 8 * 1024 * 1024;
export class AppStorageError extends Error {
  constructor(public code: string, public status: 400 | 402 | 403 | 404 | 409 | 413, message = code) { super(message); }
}
function fail(code: string, status: 400 | 402 | 403 | 404 | 409 | 413): never { throw new AppStorageError(code, status); }
export const isStorageUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function exactStorageBody(body: unknown, fields: string[]): asserts body is Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length || fields.some(key => !(key in body))) fail('invalid_body', 400);
}
function identity(body: Record<string, unknown>) {
  if (!Number.isInteger(body.size_bytes) || Number(body.size_bytes) < 1 || Number(body.size_bytes) > APP_STORAGE_MAX_BYTES || typeof body.sha256_hex !== 'string' || !/^[0-9a-f]{64}$/i.test(body.sha256_hex)) fail('invalid_identity', 400);
}
function metadata(row: V4StorageObject): RegisteredAppStorageMetadata {
  return { protocol: REGISTERED_APP_STORAGE_PROTOCOL, workspace_owner_npub: row.owner_npub, app_npub: row.registered_app_npub!, object_id: row.id,
    file_name: row.file_name!, content_type: row.content_type, size_bytes: Number(row.size_bytes), sha256_hex: row.sha256_hex!, is_public: false,
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null };
}
type Sql = ReturnType<typeof getDb>;
// A registration share lock makes revocation linearize after an admitted operation.
// Per-idempotency advisory locks serialize prepare; object row locks serialize mutations.
async function authorized<T>(owner: string, app: string, signer: string, run: (tx: Sql, workspace: string | null) => Promise<T>, write = false): Promise<T> {
  if (signer !== app) fail('app_signer_required', 403);
  return await getDb().begin(async transaction => {
    const tx = transaction as unknown as Sql;
    const [registration] = await tx`SELECT id FROM workspace_apps WHERE workspace_owner_npub=${owner} AND app_npub=${app} AND enabled=true FOR SHARE`;
    if (!registration) fail('app_not_found', 404);
    const [canonical] = await tx`SELECT id FROM v4_workspaces WHERE workspace_owner_npub=${owner} FOR SHARE`;
    const workspaces = await tx`SELECT id FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${owner} FOR SHARE`;
    if (!canonical && !workspaces.length) fail('workspace_not_found', 404);
    if (!canonical && workspaces.length !== 1) fail('workspace_binding_ambiguous', 409);
    if (write) {
      const block = await getInsufficientCreditsBlock(owner, tx);
      if (block) fail(block.code || 'insufficient_credits', 402);
      for (const workspace of workspaces) {
        const hosted = await hostingWriteBlock(workspace.id, tx);
        if (hosted) fail(hosted.code, 402);
      }
    }
    return run(tx, canonical ? null : workspaces[0].id);
  }) as T;
}
async function bound(tx: Sql, owner: string, app: string, objectId: string) {
  if (!isStorageUuid(objectId)) fail('object_not_found', 404);
  const [row] = await tx<(V4StorageObject & { expected_size: string; expected_sha256: string })[]>`SELECT o.*,b.expected_size,b.expected_sha256 FROM v4_storage_objects o JOIN registered_app_storage_objects b ON b.object_id=o.id
    WHERE o.id=${objectId} AND b.workspace_owner_npub=${owner} AND b.app_npub=${app} AND b.creator_npub=${app}
      AND o.owner_npub=${owner} AND o.registered_app_npub=${app} AND o.created_by_npub=${app} AND o.is_public=false
    FOR UPDATE OF o`;
  if (!row) fail('object_not_found', 404);
  if (Number(row.size_bytes) !== Number(row.expected_size) || row.sha256_hex !== row.expected_sha256) fail('stored_identity_mismatch', 409);
  return row;
}
export async function registeredAppStorage(owner: string, app: string, signer: string, operation: 'descriptor' | 'prepare' | 'upload' | 'complete' | 'metadata' | 'content', objectId = '', body?: unknown) {
  return authorized(owner, app, signer, async (tx, workspace) => {
    if (operation === 'descriptor') return { protocol: REGISTERED_APP_STORAGE_PROTOCOL, workspace_owner_npub: owner, app_npub: app, max_object_bytes: APP_STORAGE_MAX_BYTES, private_only: true, operations: ['prepare', 'upload', 'complete', 'metadata', 'content', 'head'] };
    if (operation === 'prepare') {
      exactStorageBody(body, ['idempotency_key', 'file_name', 'content_type', 'size_bytes', 'sha256_hex']); identity(body);
      if (!isStorageUuid(body.idempotency_key) || typeof body.file_name !== 'string' || !body.file_name.trim() || body.file_name.length > 255 || /[\x00-\x1f\x7f]/.test(body.file_name) || typeof body.content_type !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(body.content_type) || body.content_type.length > 255) fail('invalid_prepare', 400);
      const input = body as unknown as RegisteredAppStoragePrepare;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${owner + ':' + app + ':' + input.idempotency_key}, 0))`;
      const [prior] = await tx`SELECT object_id FROM registered_app_storage_objects WHERE workspace_owner_npub=${owner} AND app_npub=${app} AND idempotency_key=${input.idempotency_key}`;
      if (prior) {
        const row = await bound(tx, owner, app, prior.object_id);
        if (row.file_name !== input.file_name || row.content_type !== input.content_type || Number(row.size_bytes) !== input.size_bytes || row.sha256_hex !== input.sha256_hex.toLowerCase()) fail('idempotency_conflict', 409);
        return metadata(row);
      }
      const id = randomUUID();
      const [row] = await tx<V4StorageObject[]>`INSERT INTO v4_storage_objects(id,owner_npub,created_by_npub,registered_app_npub,pg_workspace_id,is_public,file_name,content_type,size_bytes,sha256_hex,storage_path)
        VALUES(${id},${owner},${app},${app},${workspace},false,${input.file_name},${input.content_type},${input.size_bytes},${input.sha256_hex.toLowerCase()},${'v4/' + owner + '/apps/' + app + '/' + id}) RETURNING *`;
      await tx`INSERT INTO registered_app_storage_objects(object_id,workspace_owner_npub,app_npub,creator_npub,idempotency_key,expected_size,expected_sha256)
        VALUES(${id},${owner},${app},${app},${input.idempotency_key},${input.size_bytes},${input.sha256_hex.toLowerCase()})`;
      return metadata(row);
    }
    const row = await bound(tx, owner, app, objectId);
    if (operation === 'metadata') return metadata(row);
    if (operation === 'upload') {
      exactStorageBody(body, ['base64_data']);
      if (typeof body.base64_data !== 'string' || body.base64_data.length > 4 * Math.ceil(APP_STORAGE_MAX_BYTES / 3)) fail('invalid_base64', 400);
      const bytes = Buffer.from(body.base64_data, 'base64');
      if (bytes.toString('base64') !== body.base64_data) fail('invalid_base64', 400);
      if (row.completed_at) fail('object_completed', 409);
      if (bytes.length !== Number(row.size_bytes) || createHash('sha256').update(bytes).digest('hex') !== row.sha256_hex) fail('identity_mismatch', 409);
      await writeAuthorizedStorageBytes(row, bytes);
      return metadata(row);
    }
    if (operation === 'complete') {
      exactStorageBody(body, ['size_bytes', 'sha256_hex']); identity(body);
      if (body.size_bytes !== Number(row.size_bytes) || String(body.sha256_hex).toLowerCase() !== row.sha256_hex) fail('identity_mismatch', 409);
      const stored = await hashStorageBytes(row, APP_STORAGE_MAX_BYTES);
      if (!stored || stored.size !== Number(row.size_bytes) || stored.sha256 !== row.sha256_hex) fail('stored_identity_mismatch', 409);
      if (!row.completed_at) {
        const [completed] = await tx<V4StorageObject[]>`UPDATE v4_storage_objects SET completed_at=NOW(),sha256_verified_etag=${stored.etag} WHERE id=${row.id} RETURNING *`;
        return metadata(completed);
      }
      return metadata(row);
    }
    if (!row.completed_at) fail('object_incomplete', 409);
    const stored = await hashStorageBytes(row, APP_STORAGE_MAX_BYTES);
    if (!stored || stored.size !== Number(row.size_bytes) || stored.sha256 !== row.sha256_hex) fail('stored_identity_mismatch', 409);
    const content = await getStorageObjectContent(row.id);
    if (!content || content.bytes.length !== Number(row.size_bytes) || createHash('sha256').update(content.bytes).digest('hex') !== row.sha256_hex) fail('stored_identity_mismatch', 409);
    return { metadata: metadata(row), bytes: content.bytes };
  }, ['prepare', 'upload', 'complete'].includes(operation));
}
