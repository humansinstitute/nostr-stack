import type { PublisherReceipt } from './recovery';
import { decodeStorageCursor } from './recovery';
import { randomUUID } from 'node:crypto';
import type { getDb } from '../db';
import type { StorageGrant } from './grants';
import { requireCondition } from './contract';

type Db = ReturnType<typeof getDb>;
export interface StorageObject {
  id: string;
  workspace_id: string;
  delegation_id: string;
  installation_id: string;
  app_id: string;
  app_npub: string;
  idempotency_key: string;
  size_bytes: string | number;
  sha256_hex: string;
  state: 'pending' | 'uploaded' | 'complete';
  upload_digest: string | null;
  upload_expires_at: Date | null;
  upload_revision: string | null;
  download_digest: string | null;
  download_expires_at: Date | null;
  download_revision: string | null;
  verified_at: Date | null;
  created_at: Date;
  created_at_cursor?: string;
  publisher_receipt: PublisherReceipt;
  receipt_bytes: number;
}
export function objectKey(row: StorageObject): string {
  return `managed-app-storage/${row.workspace_id}/${row.delegation_id}/${row.id}`;
}
export function owns(row: StorageObject | undefined, grant: StorageGrant): asserts row is StorageObject {
  requireCondition(row && row.workspace_id === grant.workspaceId && row.delegation_id === grant.delegationId
    && row.installation_id === grant.installationId && row.app_id === grant.appId && row.app_npub === grant.appNpub,
  'storage_object_not_found', 404);
}
export class StorageLedger {
  constructor(readonly db: Db) {}
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return await this.db.begin(async tx => {
      const sql = tx as unknown as Db;
      await sql`SELECT set_config('statement_timeout', '15000', true)`;
      await sql`SELECT set_config('lock_timeout', '3000', true)`;
      return fn(sql);
    }) as T;
  }
  async workspace(grant: StorageGrant, db = this.db): Promise<void> {
    const [row] = await db`SELECT id FROM flightdeck_pg_workspaces WHERE id=${grant.workspaceId}
      AND workspace_owner_npub=${grant.workspaceOwnerNpub} AND tower_service_npub=${grant.serviceNpub}`;
    requireCondition(row, 'storage_delegation_denied', 403);
  }
  async object(grant: StorageGrant, id: string, tx = this.db, lock = false): Promise<StorageObject> {
    const rows = lock
      ? await tx<StorageObject[]>`SELECT * FROM managed_app_storage_objects WHERE id=${id} FOR UPDATE`
      : await tx<StorageObject[]>`SELECT * FROM managed_app_storage_objects WHERE id=${id}`;
    owns(rows[0], grant);
    return rows[0];
  }
  async usage(grant: StorageGrant, tx = this.db): Promise<{ bytes: number; objects: number }> {
    const [row] = await tx`SELECT COALESCE(SUM(size_bytes + receipt_bytes),0)::text AS bytes, COUNT(*)::text AS objects
      FROM managed_app_storage_objects WHERE workspace_id=${grant.workspaceId} AND delegation_id=${grant.delegationId}`;
    const bytes = Number(row!.bytes), objects = Number(row!.objects);
    requireCondition(Number.isSafeInteger(bytes) && Number.isSafeInteger(objects), 'storage_usage_invalid', 503);
    return { bytes, objects };
  }
  async prepare(grant: StorageGrant, input: { key: string; hash: string; size: number; receipt: PublisherReceipt }, tx: Db): Promise<StorageObject> {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`managed-storage:${grant.workspaceId}:${grant.delegationId}`}))`;
    const [existing] = await tx<StorageObject[]>`SELECT * FROM managed_app_storage_objects
      WHERE workspace_id=${grant.workspaceId} AND delegation_id=${grant.delegationId} AND idempotency_key=${input.key} FOR UPDATE`;
    if (existing) {
      owns(existing, grant);
      requireCondition(existing.sha256_hex === input.hash && Number(existing.size_bytes) === input.size, 'storage_idempotency_conflict', 409);
      return existing;
    }
    const receiptBytes = Buffer.byteLength(JSON.stringify(input.receipt));
    requireCondition(receiptBytes > 0 && receiptBytes <= 6144, "storage_receipt_invalid");
    const usage = await this.usage(grant, tx);
    requireCondition(usage.bytes <= grant.quotaBytes - input.size - receiptBytes && usage.objects < grant.maxObjects, 'storage_budget_exhausted', 409);
    const [row] = await tx<StorageObject[]>`INSERT INTO managed_app_storage_objects
      (id,workspace_id,delegation_id,installation_id,app_id,app_npub,idempotency_key,size_bytes,sha256_hex,publisher_receipt,receipt_bytes)
      VALUES(${randomUUID()},${grant.workspaceId},${grant.delegationId},${grant.installationId},${grant.appId},${grant.appNpub},${input.key},${input.size},${input.hash},${tx.json(input.receipt as never)},${receiptBytes}) RETURNING *`;
    return row!;
  }
  async page(grant: StorageGrant, cursor: string) {
    const after = decodeStorageCursor(cursor, grant);
    return this.db<StorageObject[]>`SELECT *, created_at::text AS created_at_cursor FROM managed_app_storage_objects
      WHERE workspace_id=${grant.workspaceId} AND delegation_id=${grant.delegationId}
      AND installation_id=${grant.installationId} AND app_id=${grant.appId} AND app_npub=${grant.appNpub}
      AND state='complete' AND (created_at,id)>(${after.time}::text::timestamptz,${after.id}::uuid)
      ORDER BY created_at,id LIMIT 51`;
  }

}
