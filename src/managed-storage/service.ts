import { encodeStorageCursor, type PublisherReceipt } from './recovery';
import { randomBytes } from 'node:crypto';
import type { getDb } from '../db';
import { boundedBytes, digest, PREFIX, PROTOCOL, requireCondition, sha256, TOKEN_HEADER, TOKEN_TTL_MS, uuid } from './contract';
import type { StorageGrant } from './grants';
import { objectKey, StorageLedger, type StorageObject } from './ledger';
import type { StorageBlobs } from './blobs';

type Db = ReturnType<typeof getDb>;
export interface StorageServiceOptions {
  ledger: StorageLedger;
  blobs: StorageBlobs;
  grants: () => StorageGrant[];
  serviceNpub: () => string | null;
  creditBlock: (grant: StorageGrant, db?: Db) => Promise<boolean>;
  now?: () => number;
}
export class ManagedStorageService {
  readonly now: () => number;
  private transfers = 0;
  private readonly busy = new Set<string>();
  constructor(readonly options: StorageServiceOptions) { this.now = options.now ?? Date.now; }
  configured(): boolean { return this.options.grants().length > 0; }
  async authorize(workspace: string, delegation: string, origin: string, signer?: string, db?: Db): Promise<StorageGrant> {
    const grant = this.options.grants().find(g => g.workspaceId === workspace && g.delegationId === delegation);
    requireCondition(grant && grant.origin === origin && grant.serviceNpub === this.options.serviceNpub()
      && Date.parse(grant.expiresAt) > this.now() && (signer === undefined || signer === grant.appNpub),
    'storage_delegation_denied', 403);
    await this.options.ledger.workspace(grant, db);
    return grant;
  }
  private async recheck(grant: StorageGrant, writes = false, db?: Db): Promise<void> {
    const current = await this.authorize(grant.workspaceId, grant.delegationId, grant.origin, grant.appNpub, db);
    requireCondition(JSON.stringify(current) === JSON.stringify(grant), 'storage_delegation_changed', 403);
    if (writes) requireCondition(!await this.options.creditBlock(grant, db), 'storage_credits_required', 402);
  }
  binding(grant: StorageGrant) {
    return { protocol: PROTOCOL, service_npub: grant.serviceNpub, workspace_id: grant.workspaceId,
      delegation_id: grant.delegationId, installation_id: grant.installationId };
  }
  private identity(grant: StorageGrant, row: StorageObject) {
    return { ...this.binding(grant), object_id: row.id, state: row.state, size_bytes: Number(row.size_bytes),
      sha256_hex: row.sha256_hex, verified_at: row.verified_at?.toISOString() ?? null };
  }
  private streamUrl(grant: StorageGrant, id: string, direction: 'upload' | 'download', token: string, expiry: Date, size: number) {
    return { url: `${grant.origin}${PREFIX}/workspaces/${grant.workspaceId}/delegations/${grant.delegationId}/objects/${id}/${direction}`,
      method: direction === 'upload' ? 'PUT' : 'GET', expires_at: expiry.toISOString(),
      headers: { [TOKEN_HEADER]: token, ...(direction === 'upload'
        ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) } : {}) } };
  }
  private async mint(grant: StorageGrant, row: StorageObject, direction: 'upload' | 'download', tx: Db) {
    const token = randomBytes(32).toString('base64url');
    const expiry = new Date(Math.min(this.now() + TOKEN_TTL_MS, Date.parse(grant.expiresAt)));
    if (direction === 'upload') {
      await tx`UPDATE managed_app_storage_objects SET upload_digest=${digest(token)}, upload_expires_at=${expiry}, upload_revision=${grant.revision} WHERE id=${row.id}`;
    } else {
      await tx`UPDATE managed_app_storage_objects SET download_digest=${digest(token)}, download_expires_at=${expiry}, download_revision=${grant.revision} WHERE id=${row.id}`;
    }
    return this.streamUrl(grant, row.id, direction, token, expiry, Number(row.size_bytes));
  }
  async status(grant: StorageGrant, id?: string, cursor?: string) {
    await this.recheck(grant);
    if (id !== undefined) {
      const row = await this.options.ledger.object(grant, id);
      return { ...this.identity(grant, row), publisher_receipt: row.publisher_receipt };
    }
    if (cursor !== undefined) {
      const rows = await this.options.ledger.page(grant, cursor);
      const page = rows.slice(0, 50);
      await this.recheck(grant);
      return { ...this.binding(grant), objects: page.map(row => {
          const { object_id, state, size_bytes, sha256_hex, verified_at } = this.identity(grant, row);
          return { object_id, state, size_bytes, sha256_hex, verified_at };
        }),
        next_cursor: rows.length > 50 ? encodeStorageCursor(grant, page.at(-1)!) : null };
    }
    const usage = await this.options.ledger.usage(grant);
    return { ...this.binding(grant), remaining_bytes: Math.max(0, grant.quotaBytes - usage.bytes),
      remaining_objects: Math.max(0, grant.maxObjects - usage.objects), max_object_bytes: grant.maxObjectBytes, max_receipt_bytes: 6144,
      list_cursor: encodeStorageCursor(grant), billing: grant.billing, budget_mode: 'operator_allocated_unmetered', billing_ok: !await this.options.creditBlock(grant) };
  }
  async prepare(grant: StorageGrant, input: Record<string, unknown>, receipt: PublisherReceipt) {
    requireCondition(typeof input.idempotency_key === 'string' && uuid.test(input.idempotency_key)
      && typeof input.sha256_hex === 'string' && sha256.test(input.sha256_hex), 'storage_request_invalid');
    requireCondition(Number.isSafeInteger(input.size_bytes) && Number(input.size_bytes) > 0
      && Number(input.size_bytes) <= grant.maxObjectBytes, 'storage_size_invalid', 413);
    await this.recheck(grant, true);
    return this.options.ledger.transaction(async tx => {
      const row = await this.options.ledger.prepare(grant,
        { key: input.idempotency_key as string, hash: input.sha256_hex as string, size: Number(input.size_bytes), receipt }, tx);
      const upload = row.state === 'pending' ? await this.mint(grant, row, 'upload', tx) : undefined;
      await this.recheck(grant, true, tx);
      return { ...this.identity(grant, row), ...(upload ? { upload } : {}) };
    });
  }
  async complete(grant: StorageGrant, id: string, signal: AbortSignal) {
    await this.recheck(grant, true);
    return this.transfer(grant, async () => this.options.ledger.transaction(async tx => {
      const row = await this.options.ledger.object(grant, id, tx, true);
      requireCondition(row.state !== 'pending', 'storage_upload_incomplete', 409);
      const bytes = await this.options.blobs.read(objectKey(row), Number(row.size_bytes), signal);
      this.verify(row, bytes);
      await this.recheck(grant, true, tx);
      signal.throwIfAborted();
      const [updated] = await tx<StorageObject[]>`UPDATE managed_app_storage_objects SET state='complete', verified_at=NOW(),
        upload_digest=NULL, upload_expires_at=NULL WHERE id=${id} RETURNING *`;
      return this.identity(grant, updated!);
    }));
  }
  async downloadUrl(grant: StorageGrant, id: string) {
    await this.recheck(grant);
    return this.options.ledger.transaction(async tx => {
      const row = await this.options.ledger.object(grant, id, tx, true);
      requireCondition(row.state === 'complete', 'storage_upload_incomplete', 409);
      const download = await this.mint(grant, row, 'download', tx);
      await this.recheck(grant, false, tx);
      return { ...this.identity(grant, row), download };
    });
  }
  private verify(row: StorageObject, bytes: Uint8Array) {
    requireCondition(bytes.byteLength === Number(row.size_bytes) && digest(bytes) === row.sha256_hex, 'storage_identity_mismatch', 409);
  }
  private token(row: StorageObject, grant: StorageGrant, token: string, direction: 'upload' | 'download') {
    requireCondition(row[`${direction}_digest`] === digest(token)
      && row[`${direction}_revision`] === grant.revision
      && (row[`${direction}_expires_at`]?.getTime() ?? 0) > this.now(), 'storage_stream_denied', 403);
    requireCondition(direction === 'upload' ? row.state === 'pending' : row.state === 'complete', 'storage_stream_denied', 403);
  }
  private async transfer<T>(grant: StorageGrant, operation: () => Promise<T>): Promise<T> {
    const key = `${grant.workspaceId}:${grant.delegationId}`;
    requireCondition(this.transfers < 2 && !this.busy.has(key), 'storage_transfer_busy', 429);
    this.transfers++; this.busy.add(key);
    try { return await operation(); } finally { this.transfers--; this.busy.delete(key); }
  }
  async upload(grant: StorageGrant, id: string, token: string, request: Request, signal: AbortSignal) {
    const row = await this.options.ledger.object(grant, id);
    this.token(row, grant, token, 'upload');
    await this.recheck(grant, true);
    requireCondition(request.headers.get('content-type') === 'application/octet-stream'
      && request.headers.get('content-length') === String(row.size_bytes), 'storage_upload_headers_invalid');
    return this.transfer(grant, async () => {
      const bytes = await boundedBytes(request.body, Number(row.size_bytes), signal);
      this.verify(row, bytes);
      return this.options.ledger.transaction(async tx => {
        const locked = await this.options.ledger.object(grant, id, tx, true);
        this.token(locked, grant, token, 'upload');
        await this.recheck(grant, true, tx);
        await this.options.blobs.write(objectKey(locked), bytes, signal);
        await this.recheck(grant, true, tx);
        signal.throwIfAborted();
        await tx`UPDATE managed_app_storage_objects SET state='uploaded',upload_digest=NULL,upload_expires_at=NULL WHERE id=${id}`;
        return { ...this.identity(grant, locked), state: 'uploaded' };
      });
    });
  }
  async download(grant: StorageGrant, id: string, token: string, signal: AbortSignal) {
    const row = await this.options.ledger.object(grant, id);
    this.token(row, grant, token, 'download');
    await this.recheck(grant);
    return this.transfer(grant, async () => {
      const bytes = await this.options.blobs.read(objectKey(row), Number(row.size_bytes), signal);
      this.verify(row, bytes);
      await this.recheck(grant);
      signal.throwIfAborted();
      return bytes;
    });
  }
}
