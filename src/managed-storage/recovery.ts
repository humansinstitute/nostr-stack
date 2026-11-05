import { requireCondition, exactObject, StorageDelegationError, uuid } from './contract';
import type { StorageGrant } from './grants';

export interface PublisherReceipt { event: Record<string, unknown>; body: string; accepted_at: string; }
export function encodeStorageCursor(grant: StorageGrant, after: { created_at: Date; created_at_cursor?: string; id: string } = { created_at: new Date(0), id: '00000000-0000-0000-0000-000000000000' }): string {
  return Buffer.from(JSON.stringify({ w: grant.workspaceId, d: grant.delegationId, t: after.created_at_cursor ?? after.created_at.toISOString(), id: after.id })).toString('base64url');
}
export function decodeStorageCursor(cursor: unknown, grant: StorageGrant) {
  requireCondition(typeof cursor === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(cursor), 'storage_cursor_invalid');
  let row: Record<string, unknown>;
  try { row = exactObject(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')), ['w', 'd', 't', 'id']); }
  catch { throw new StorageDelegationError('storage_cursor_invalid'); }
  requireCondition(row.w === grant.workspaceId && row.d === grant.delegationId
    && typeof row.t === 'string' && Number.isFinite(Date.parse(row.t)) && typeof row.id === 'string' && uuid.test(row.id), 'storage_cursor_invalid');
  return { time: row.t, id: row.id };
}
