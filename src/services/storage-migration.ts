import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketReplicationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectTaggingCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { objectKey, type StorageObject as ManagedStorageObject } from '../managed-storage/ledger';
import type { StorageProvider } from './storage-provider';
import {
  parseStorageSentinel,
  STORAGE_SENTINEL_KEY,
  type MigrationPhase,
  type StorageSentinelDocument,
} from './storage-startup-guard';

export const MIGRATION_EXIT = {
  OK: 0,
  USAGE: 2,
  LOCK_OR_CONFLICT: 3,
  PHASE_DENIED: 4,
  PREFLIGHT_BLOCK: 10,
  FENCE_OR_BACKUP: 11,
  TRANSIENT_IO: 12,
  INTEGRITY_MISMATCH: 13,
  SMOKE_FAILED: 14,
  ROLLBACK_REFUSED: 15,
} as const;

export type MigrationExitCode = (typeof MIGRATION_EXIT)[keyof typeof MIGRATION_EXIT];

export class MigrationError extends Error {
  readonly exitCode: MigrationExitCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(exitCode: MigrationExitCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'MigrationError';
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

type Sql = ReturnType<typeof postgres>;
type S3Like = Pick<S3Client, 'send'>;

// Fixed session-level advisory lock key for NStack storage migration runs.
const MIGRATION_ADVISORY_LOCK_KEY = '783041928374615291';
const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
const MULTIPART_PART_BYTES = 16 * 1024 * 1024;
const ACTIVE_PHASES_SQL = ['committed', 'rolled_back', 'source_retired', 'aborted_restore'];
// Phases in which the source was fenced and Tower must not have run (snapshot window).
export const QUIESCED_PHASES: MigrationPhase[] = [
  'source_fenced', 'backed_up', 'synced', 'verified', 'switch_prepared', 'db_switched', 'config_switched',
];
// At or after the write boundary: only RB2 (reverse migration) may return to the source.
export const POST_WRITE_PHASES: MigrationPhase[] = ['start_intent', 'started', 'committed'];

export interface S3EndpointConfig {
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export interface MigrationContext {
  sql: Sql;
  serviceNpub: string;
  serviceNsec?: string;
  source: S3EndpointConfig;
  target: S3EndpointConfig & { provider: 'minio' | 'seaweedfs' };
  sourceIdentity: string;
  sourceClient?: S3Like;
  targetClient?: S3Like;
  /** Per-request socket inactivity timeout; the host enforces the absolute window deadline. */
  requestTimeoutMs?: number;
}

export interface FingerprintComponents {
  service_npub: string;
  pg_system_identifier: string;
  pg_database: string;
  source_provider: StorageProvider;
  source_endpoint: string;
  source_bucket: string;
  source_identity: string;
  target_provider: 'minio' | 'seaweedfs';
  target_endpoint: string;
  target_bucket: string;
  target_sentinel_id: string;
}

export interface MigrationRunRow {
  run_id: string;
  phase: MigrationPhase;
  fingerprint: string;
  fingerprint_details: FingerprintComponents;
  source_provider: StorageProvider;
  target_provider: 'minio' | 'seaweedfs';
  target_sentinel_id: string | null;
  source_boot_id: string | null;
  target_boot_id: string | null;
  fence_identity: Record<string, unknown> | null;
  old_config_digest: string | null;
  new_config_digest: string | null;
  verified_backup_dir: string | null;
  backup_manifest_sha256: string | null;
  rollback_from_phase: MigrationPhase | null;
  smoke_evidence: Record<string, unknown> | null;
  smoke_passed_at: Date | null;
  last_evidence: Record<string, unknown>;
  source_fenced_at: Date | null;
  backed_up_at: Date | null;
  start_intent_at: Date | null;
  started_at: Date | null;
  committed_at: Date | null;
  rolling_back_at: Date | null;
  rolled_back_at: Date | null;
  source_retired_at: Date | null;
  aborted_restore_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface V4DbRow {
  id: string;
  storage_path: string;
  owner_npub: string;
  content_type: string;
  size_bytes: string | number;
  sha256_hex: string | null;
  sha256_verified_etag: string | null;
  completed_at: Date | null;
  created_at: Date;
  is_public: boolean;
  registered_app_npub: string | null;
}

interface EligibleObject {
  kind: 'v4' | 'managed';
  objectId: string;
  storageKey: string;
  /** Completed upload acknowledged to a client (v4 completed_at, managed complete). */
  acknowledged: boolean;
  /** DB records an authoritative hash and size that bytes must match. */
  identityKnown: boolean;
  dbSizeBytes: number;
  dbSha256Hex: string | null;
  dbVerifiedEtag: string | null;
  isPublic: boolean;
}

/** Preserved object attributes. Anything else the copy cannot reproduce is refused. */
export interface ObjectAttributes {
  contentType: string;
  metadata: Record<string, string>;
  headers: Record<string, string>;
}

interface JournalRow {
  storage_key: string;
  kind: 'v4' | 'managed';
  object_id: string;
  size_bytes: string | number;
  sha256_hex: string;
  original_sha256_hex: string | null;
  original_size_bytes: string | number;
  original_verified_etag: string | null;
  original_completed: boolean;
  content_type: string | null;
  object_headers: Record<string, string>;
  custom_metadata: Record<string, string>;
  src_etag: string | null;
  dst_etag: string | null;
  state: string;
}

export function createMigrationS3Client(cfg: S3EndpointConfig, requestTimeoutMs = 120_000): S3Client {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: requestTimeoutMs },
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
  });
}

function getSourceClient(ctx: MigrationContext): S3Like {
  if (!ctx.sourceClient) ctx.sourceClient = createMigrationS3Client(ctx.source, ctx.requestTimeoutMs);
  return ctx.sourceClient;
}

function getTargetClient(ctx: MigrationContext): S3Like {
  if (!ctx.targetClient) ctx.targetClient = createMigrationS3Client(ctx.target, ctx.requestTimeoutMs);
  return ctx.targetClient;
}

function isNotFound(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode;
  const code = err?.name || err?.Code;
  return (
    status === 404 ||
    code === 'NoSuchKey' ||
    code === 'NotFound' ||
    code === 'NoSuchBucket' ||
    code === 'NoSuchTagSet' ||
    code === 'NoSuchLifecycleConfiguration' ||
    code === 'ServerSideEncryptionConfigurationNotFoundError' ||
    code === 'ObjectLockConfigurationNotFoundError' ||
    code === 'ReplicationConfigurationNotFoundError'
  );
}

function isFeatureUnsupportedOrNotFound(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode;
  const code = err?.name || err?.Code;
  return isNotFound(err) || status === 405 || status === 501 || code === 'NotImplemented';
}

export function isTransientError(err: any): boolean {
  if (err instanceof MigrationError) return false;
  const status = err?.$metadata?.httpStatusCode;
  if (status && status >= 500) return true;
  const code = String(err?.code || err?.name || '');
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|Timeout|NetworkingError|SlowDown|ServiceUnavailable|socket/i.test(
    code + ' ' + String(err?.message || ''),
  );
}

/** Map transient IO to resumable exit 12; everything else propagates unchanged. */
async function transientAsResumable<T>(code: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isTransientError(err)) {
      throw new MigrationError(
        MIGRATION_EXIT.TRANSIENT_IO,
        code,
        `Transient I/O error (safe to resume): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
}

async function readStreamToBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function hashBodyStream(body: any): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  if (body) {
    for await (const chunk of body) {
      const buf = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      size += buf.byteLength;
      hash.update(buf);
    }
  }
  return { sha256: hash.digest('hex'), size };
}

class BandwidthLimiter {
  private bytesSent = 0;
  private readonly startMs = Date.now();
  constructor(private readonly maxBytesPerSec: number) {}
  async consume(bytes: number) {
    if (this.maxBytesPerSec <= 0 || bytes <= 0) return;
    this.bytesSent += bytes;
    const expectedMs = (this.bytesSent / this.maxBytesPerSec) * 1000;
    const elapsedMs = Date.now() - this.startMs;
    if (expectedMs > elapsedMs + 5) {
      await Bun.sleep(Math.ceil(expectedMs - elapsedMs));
    }
  }
}

/**
 * Bounded worker pool. The first failure stops new work, every in-flight worker
 * settles, then the failure is rethrown, so no copy runs after the caller returns.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, 4));
  let nextIdx = 0;
  let failure: unknown;
  let failed = false;
  async function loop() {
    while (!failed) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx]!, idx);
      } catch (err) {
        if (!failed) {
          failed = true;
          failure = err;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => loop()));
  if (failed) throw failure;
}

/**
 * Hold a session-level PostgreSQL advisory lock on a dedicated reserved connection
 * for the duration of a mutating migration operation. Exits 3 if already held.
 */
export async function withMigrationAdvisoryLock<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  const reserved = await sql.reserve();
  try {
    const [row] = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY}::bigint) AS locked
    `;
    if (!row?.locked) {
      throw new MigrationError(
        MIGRATION_EXIT.LOCK_OR_CONFLICT,
        'migration_lock_held',
        'Another migration process currently holds the session-level PostgreSQL advisory lock.',
      );
    }
    try {
      return await fn();
    } finally {
      await reserved`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY}::bigint)`.catch(() => {});
    }
  } finally {
    reserved.release();
  }
}

/** Typed JSONB parameter (never `JSON.stringify(x)::jsonb`, which stores a JSON string scalar). */
function jsonb(sql: Sql, value: Record<string, unknown>) {
  return sql.json(value as any);
}

export async function requireJournalSchema(sql: Sql) {
  const [row] = await sql<{ runs: string | null; objects: string | null; probes: string | null }[]>`
    SELECT to_regclass('public.storage_migration_runs')::text AS runs,
           to_regclass('public.storage_migration_objects')::text AS objects,
           to_regclass('public.storage_migration_probes')::text AS probes
  `;
  if (!row?.runs || !row.objects || !row.probes) {
    throw new MigrationError(
      MIGRATION_EXIT.PREFLIGHT_BLOCK,
      'journal_schema_missing',
      'Storage migration journal tables are missing. Deploy the NStack release that includes storage-migration-v1 (Tower startup installs it) before migrating.',
    );
  }
}

export async function readTargetSentinel(
  client: S3Like,
  bucket: string,
  expectedProvider: 'minio' | 'seaweedfs',
): Promise<StorageSentinelDocument> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err: any) {
    throw new MigrationError(
      MIGRATION_EXIT.PREFLIGHT_BLOCK,
      'target_bucket_unreachable',
      `Target bucket "${bucket}" is unreachable or denied: ${err?.message || String(err)}`,
    );
  }
  const ver = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  if (ver.Status || ver.MFADelete) {
    throw new MigrationError(
      MIGRATION_EXIT.PREFLIGHT_BLOCK,
      'target_bucket_versioned',
      `Target bucket "${bucket}" has S3 versioning/MFADelete enabled (Status=${ver.Status ?? 'none'}).`,
    );
  }
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: STORAGE_SENTINEL_KEY }));
    const sentinel = parseStorageSentinel((await readStreamToBuffer(res.Body)).toString('utf8'));
    if (sentinel.provider !== expectedProvider || sentinel.bucket !== bucket) {
      throw new MigrationError(
        MIGRATION_EXIT.PREFLIGHT_BLOCK,
        'target_sentinel_mismatch',
        `Target sentinel declares provider=${sentinel.provider} bucket=${sentinel.bucket}, expected provider=${expectedProvider} bucket=${bucket}.`,
      );
    }
    return sentinel;
  } catch (err: any) {
    if (err instanceof MigrationError) throw err;
    throw new MigrationError(
      MIGRATION_EXIT.PREFLIGHT_BLOCK,
      'target_sentinel_missing',
      `Target bucket "${bucket}" is missing a valid ${STORAGE_SENTINEL_KEY} (run storage init first): ${err?.message || String(err)}`,
    );
  }
}

export async function computeInstallationFingerprint(
  ctx: MigrationContext,
  sentinelOverride?: string,
): Promise<{ fingerprint: string; details: FingerprintComponents }> {
  const [pgInfo] = await ctx.sql<{ sysid: string; db: string }[]>`
    SELECT system_identifier::text AS sysid, current_database() AS db
    FROM pg_control_system()
  `;
  const sentinelId =
    sentinelOverride ??
    (await readTargetSentinel(getTargetClient(ctx), ctx.target.bucket, ctx.target.provider)).sentinel_id;
  const details: FingerprintComponents = {
    service_npub: ctx.serviceNpub,
    pg_system_identifier: pgInfo!.sysid,
    pg_database: pgInfo!.db,
    source_provider: ctx.source.provider,
    source_endpoint: ctx.source.endpoint,
    source_bucket: ctx.source.bucket,
    source_identity: ctx.sourceIdentity,
    target_provider: ctx.target.provider,
    target_endpoint: ctx.target.endpoint,
    target_bucket: ctx.target.bucket,
    target_sentinel_id: sentinelId,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(details)).digest('hex');
  return { fingerprint, details };
}

async function listAllBucketKeys(
  client: S3Like,
  bucket: string,
): Promise<Map<string, { size: number; etag: string | null }>> {
  const out = new Map<string, { size: number; etag: string | null }>();
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const item of page.Contents || []) {
      if (item.Key) out.set(item.Key, { size: item.Size ?? 0, etag: item.ETag ?? null });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !token) {
      throw new MigrationError(MIGRATION_EXIT.PREFLIGHT_BLOCK, 'listing_pagination_invalid', `Truncated listing of "${bucket}" without a continuation token.`);
    }
  } while (token);
  return out;
}

async function listIncompleteMultipartUploads(client: S3Like, bucket: string) {
  const uploads: Array<{ key: string; upload_id: string; initiated: string | null }> = [];
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  for (;;) {
    const page = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker }),
    );
    for (const u of page.Uploads || []) {
      uploads.push({ key: u.Key || '', upload_id: u.UploadId || '', initiated: u.Initiated ? new Date(u.Initiated).toISOString() : null });
    }
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker && !page.NextUploadIdMarker) {
      throw new MigrationError(MIGRATION_EXIT.PREFLIGHT_BLOCK, 'multipart_listing_invalid', `Truncated multipart listing of "${bucket}" without markers.`);
    }
    keyMarker = page.NextKeyMarker;
    uploadIdMarker = page.NextUploadIdMarker;
  }
  return uploads;
}

async function tableExists(sql: Sql, name: string) {
  const [row] = await sql<{ exists: string | null }[]>`SELECT to_regclass(${'public.' + name})::text AS exists`;
  return Boolean(row?.exists);
}

async function loadEligibleObjectsFromDb(
  sql: Sql,
  sourceListing: Map<string, { size: number; etag: string | null }> | null,
) {
  const v4Rows = await sql<V4DbRow[]>`
    SELECT id::text, storage_path, owner_npub, content_type, size_bytes,
           sha256_hex, sha256_verified_etag, completed_at, created_at,
           is_public, registered_app_npub
    FROM v4_storage_objects
    ORDER BY id
  `;
  const managedRows: ManagedStorageObject[] = (await tableExists(sql, 'managed_app_storage_objects'))
    ? await sql<ManagedStorageObject[]>`SELECT * FROM managed_app_storage_objects ORDER BY id`
    : [];

  const eligible: EligibleObject[] = [];
  const ineligibleManagedKeys = new Set<string>();
  let v4IncompleteNoBytes = 0;
  let v4IncompleteSizeMismatch = 0;
  let v4NullHashCompleted = 0;
  let v4NullEtagCompleted = 0;
  let zeroByteCount = 0;

  for (const row of v4Rows) {
    const dbSize = Number(row.size_bytes);
    if (row.completed_at) {
      if (!row.sha256_hex) v4NullHashCompleted++;
      if (!row.sha256_verified_etag) v4NullEtagCompleted++;
      if (dbSize === 0) zeroByteCount++;
      eligible.push({
        kind: 'v4',
        objectId: row.id,
        storageKey: row.storage_path,
        acknowledged: true,
        identityKnown: Boolean(row.sha256_hex),
        dbSizeBytes: dbSize,
        dbSha256Hex: row.sha256_hex ? row.sha256_hex.toLowerCase() : null,
        dbVerifiedEtag: row.sha256_verified_etag,
        isPublic: row.is_public,
      });
      continue;
    }
    // An incomplete v4 row is eligible only when bytes exist. Its declared size is
    // preserved untouched: unacknowledged bytes are copied as-is, never "fixed".
    const srcEntry = sourceListing?.get(row.storage_path);
    if (sourceListing && !srcEntry) {
      v4IncompleteNoBytes++;
      continue;
    }
    if (srcEntry && srcEntry.size !== dbSize) v4IncompleteSizeMismatch++;
    eligible.push({
      kind: 'v4',
      objectId: row.id,
      storageKey: row.storage_path,
      acknowledged: false,
      identityKnown: false,
      dbSizeBytes: dbSize,
      dbSha256Hex: null,
      dbVerifiedEtag: null,
      isPublic: row.is_public,
    });
  }

  for (const row of managedRows) {
    const key = objectKey(row);
    const live = (row.state === 'complete' || row.state === 'uploaded') && row.deletion_job === null && row.physical_absent === false;
    if (!live) {
      ineligibleManagedKeys.add(key);
      continue;
    }
    // `uploaded` bytes were verified against the declared hash before the write; `complete` is acknowledged.
    if (row.state === 'complete' || !sourceListing || sourceListing.has(key)) {
      const dbSize = Number(row.size_bytes);
      if (dbSize === 0) zeroByteCount++;
      eligible.push({
        kind: 'managed',
        objectId: row.id,
        storageKey: key,
        acknowledged: row.state === 'complete',
        identityKnown: true,
        dbSizeBytes: dbSize,
        dbSha256Hex: row.sha256_hex.toLowerCase(),
        dbVerifiedEtag: null,
        isPublic: false,
      });
    }
  }

  return {
    eligible,
    ineligibleManagedKeys,
    v4IncompleteNoBytes,
    v4IncompleteSizeMismatch,
    v4NullHashCompleted,
    v4NullEtagCompleted,
    zeroByteCount,
    v4TotalRows: v4Rows.length,
    managedTotalRows: managedRows.length,
  };
}

function normalizeStringMap(value: unknown): Record<string, string> {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    // Pre-fix journals may hold a JSON string scalar; read it, never write it.
    try { parsed = JSON.parse(value); } catch { parsed = {}; }
  }
  const out: Record<string, string> = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const key of Object.keys(parsed as Record<string, unknown>).sort()) {
    out[key.toLowerCase()] = String((parsed as Record<string, unknown>)[key] ?? '');
  }
  return out;
}

function mapsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

function headerMap(head: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (head.CacheControl) out['cache-control'] = String(head.CacheControl);
  if (head.ContentDisposition) out['content-disposition'] = String(head.ContentDisposition);
  if (head.ContentLanguage) out['content-language'] = String(head.ContentLanguage);
  const expires = head.ExpiresString ?? (head.Expires instanceof Date ? head.Expires.toUTCString() : head.Expires);
  if (expires) out['expires'] = String(expires);
  return out;
}

function putHeaderParams(headers: Record<string, string>) {
  return {
    ...(headers['cache-control'] ? { CacheControl: headers['cache-control'] } : {}),
    ...(headers['content-disposition'] ? { ContentDisposition: headers['content-disposition'] } : {}),
    ...(headers['content-language'] ? { ContentLanguage: headers['content-language'] } : {}),
    ...(headers['expires'] ? { Expires: new Date(headers['expires']) } : {}),
  };
}

function attributesEqual(a: ObjectAttributes, b: ObjectAttributes) {
  const expires = (h: Record<string, string>) => (h.expires ? Date.parse(h.expires) : null);
  const strip = (h: Record<string, string>) => { const { expires: _e, ...rest } = h; return rest; };
  return a.contentType === b.contentType && mapsEqual(a.metadata, b.metadata)
    && mapsEqual(strip(a.headers), strip(b.headers)) && expires(a.headers) === expires(b.headers);
}

async function checkSourceBucketFeatures(client: S3Like, bucket: string) {
  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  if (versioning.Status || versioning.MFADelete) {
    throw new MigrationError(
      MIGRATION_EXIT.PREFLIGHT_BLOCK,
      'source_bucket_versioned',
      `Source bucket "${bucket}" has S3 versioning/MFADelete enabled (Status=${versioning.Status ?? 'none'}). Refusing migration.`,
    );
  }
  const checkDisallowed = async (label: string, fn: () => Promise<any>, hasFeature: (res: any) => boolean) => {
    try {
      if (hasFeature(await fn())) {
        throw new MigrationError(
          MIGRATION_EXIT.PREFLIGHT_BLOCK,
          `source_bucket_${label}_unsupported`,
          `Source bucket "${bucket}" uses unsupported S3 feature "${label}". Refusing migration.`,
        );
      }
    } catch (err: any) {
      if (err instanceof MigrationError) throw err;
      if (!isFeatureUnsupportedOrNotFound(err)) throw err;
    }
  };
  await checkDisallowed('object_lock', () => client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket })), (r) => Boolean(r?.ObjectLockConfiguration?.ObjectLockEnabled));
  await checkDisallowed('encryption', () => client.send(new GetBucketEncryptionCommand({ Bucket: bucket })), (r) => Boolean(r?.ServerSideEncryptionConfiguration?.Rules?.length));
  await checkDisallowed('lifecycle', () => client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })), (r) => Boolean(r?.Rules?.length));
  await checkDisallowed('replication', () => client.send(new GetBucketReplicationCommand({ Bucket: bucket })), (r) => Boolean(r?.ReplicationConfiguration?.Rules?.length));

  let incompleteMultipartUploads: Awaited<ReturnType<typeof listIncompleteMultipartUploads>> = [];
  try {
    incompleteMultipartUploads = await listIncompleteMultipartUploads(client, bucket);
  } catch (err: any) {
    if (err instanceof MigrationError) throw err;
    if (!isFeatureUnsupportedOrNotFound(err)) throw err;
  }
  return {
    versioning: 'unversioned',
    object_lock: 'none',
    encryption: 'none',
    lifecycle: 'none',
    replication: 'none',
    // Listed for the operator; in-progress multipart parts are never copied (no row references them).
    incomplete_multipart_uploads: incompleteMultipartUploads.length,
    incomplete_multipart_upload_keys: incompleteMultipartUploads.slice(0, 100),
  };
}

/** Read object attributes, refusing any feature the copy cannot reproduce exactly (exit 10). */
async function readSupportedObjectAttributes(
  client: S3Like,
  bucket: string,
  key: string,
): Promise<ObjectAttributes & { size: number; etag: string | null }> {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const unsupported = [
    head.ContentEncoding ? `ContentEncoding=${head.ContentEncoding}` : '',
    head.ServerSideEncryption ? `SSE=${head.ServerSideEncryption}` : '',
    head.SSECustomerAlgorithm ? 'SSE-C' : '',
    head.SSEKMSKeyId ? 'SSE-KMS' : '',
    head.ObjectLockMode ? `ObjectLock=${head.ObjectLockMode}` : '',
    head.ObjectLockLegalHoldStatus === 'ON' ? 'LegalHold' : '',
    head.WebsiteRedirectLocation ? 'WebsiteRedirect' : '',
    head.ReplicationStatus ? `Replication=${head.ReplicationStatus}` : '',
  ].filter(Boolean);
  if (unsupported.length) {
    throw new MigrationError(
      MIGRATION_EXIT.PREFLIGHT_BLOCK,
      'source_object_unsupported_feature',
      `Source object "${key}" uses S3 features the migration cannot reproduce (${unsupported.join(', ')}). Refusing migration.`,
      { key, unsupported },
    );
  }
  try {
    const tags = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
    if ((tags.TagSet?.length ?? 0) > 0) {
      throw new MigrationError(
        MIGRATION_EXIT.PREFLIGHT_BLOCK,
        'source_object_tags_unsupported',
        `Source object "${key}" has ${tags.TagSet!.length} S3 object tag(s), which the migration does not preserve. Refusing migration.`,
        { key },
      );
    }
  } catch (err: any) {
    if (err instanceof MigrationError) throw err;
    if (!isFeatureUnsupportedOrNotFound(err)) throw err;
  }
  return {
    contentType: head.ContentType || 'application/octet-stream',
    metadata: normalizeStringMap(head.Metadata),
    headers: headerMap(head),
    size: head.ContentLength ?? 0,
    etag: head.ETag ?? null,
  };
}

export async function getLatestMigrationRun(sql: Sql, includeAbortedRestore = false): Promise<MigrationRunRow | null> {
  if (!(await tableExists(sql, 'storage_migration_runs'))) return null;
  const [row] = includeAbortedRestore
    ? await sql<MigrationRunRow[]>`SELECT * FROM storage_migration_runs ORDER BY created_at DESC, run_id DESC LIMIT 1`
    : await sql<MigrationRunRow[]>`
        SELECT * FROM storage_migration_runs WHERE phase <> 'aborted_restore'
        ORDER BY created_at DESC, run_id DESC LIMIT 1
      `;
  return row ?? null;
}

export async function getActiveMigrationRun(sql: Sql): Promise<MigrationRunRow | null> {
  if (!(await tableExists(sql, 'storage_migration_runs'))) return null;
  const [row] = await sql<MigrationRunRow[]>`
    SELECT * FROM storage_migration_runs
    WHERE phase NOT IN ${sql(ACTIVE_PHASES_SQL)}
    ORDER BY created_at DESC, run_id DESC LIMIT 1
  `;
  return row ?? null;
}

async function requireRun(ctx: MigrationContext, runId: string | undefined, allowed: MigrationPhase[], command: string) {
  const run = runId
    ? (await ctx.sql<MigrationRunRow[]>`SELECT * FROM storage_migration_runs WHERE run_id = ${runId}`)[0] ?? null
    : await getLatestMigrationRun(ctx.sql);
  if (!run || !allowed.includes(run.phase)) {
    throw new MigrationError(
      MIGRATION_EXIT.PHASE_DENIED,
      `${command.replace(/-/g, '_')}_phase_denied`,
      `${command} requires phase ${allowed.join(' | ')}; current phase is "${run?.phase ?? 'none'}".`,
    );
  }
  return run;
}

function assertFingerprintMatches(run: MigrationRunRow, expectedFingerprint: string) {
  if (run.fingerprint !== expectedFingerprint) {
    throw new MigrationError(
      MIGRATION_EXIT.PREFLIGHT_BLOCK,
      'fingerprint_mismatch',
      `Installation fingerprint mismatch for run ${run.run_id}: expected ${run.fingerprint}, computed ${expectedFingerprint}. Refusing to operate on a mismatched instance or store.`,
    );
  }
}

/**
 * Bind every command to the live installation: service npub, Postgres system
 * identifier, database, source identity and target coordinates. The live target
 * sentinel must match; only rollback may fall back to the journalled sentinel ID
 * when the target is unreachable.
 */
async function verifyRunFingerprint(
  ctx: MigrationContext,
  run: MigrationRunRow,
  options: { allowJournalSentinelFallback?: boolean } = {},
) {
  let sentinelId: string;
  try {
    sentinelId = (await readTargetSentinel(getTargetClient(ctx), ctx.target.bucket, ctx.target.provider)).sentinel_id;
  } catch (err) {
    if (options.allowJournalSentinelFallback && err instanceof MigrationError && err.code === 'target_bucket_unreachable' && run.target_sentinel_id) {
      sentinelId = run.target_sentinel_id;
    } else {
      throw err;
    }
  }
  const { fingerprint } = await computeInstallationFingerprint(ctx, sentinelId);
  assertFingerprintMatches(run, fingerprint);
  return { fingerprint, sentinelId };
}

/** Strictly read-only preflight: writes nothing to the DB or either store. */
export async function runMigrationPreflight(
  ctx: MigrationContext,
  options: { diskFreeBytes?: number; concurrency?: number } = {},
) {
  return transientAsResumable('preflight_transient_io', async () => {
    const sourceClient = getSourceClient(ctx);
    const sourceFeatures = await checkSourceBucketFeatures(sourceClient, ctx.source.bucket);
    const targetSentinel = await readTargetSentinel(getTargetClient(ctx), ctx.target.bucket, ctx.target.provider);
    const { fingerprint, details } = await computeInstallationFingerprint(ctx, targetSentinel.sentinel_id);
    const activeRun = await getActiveMigrationRun(ctx.sql);
    if (activeRun) assertFingerprintMatches(activeRun, fingerprint);

    const sourceListing = await listAllBucketKeys(sourceClient, ctx.source.bucket);
    const inventory = await loadEligibleObjectsFromDb(ctx.sql, sourceListing);
    let sourceTotalBytes = 0;
    for (const v of sourceListing.values()) sourceTotalBytes += v.size;
    const requiredDiskBytes = Math.ceil(sourceTotalBytes * 2.5);
    if (options.diskFreeBytes !== undefined && options.diskFreeBytes < requiredDiskBytes) {
      throw new MigrationError(
        MIGRATION_EXIT.PREFLIGHT_BLOCK,
        'insufficient_disk_space',
        `Insufficient disk headroom: free=${options.diskFreeBytes} bytes, required >= 2.5x source (${requiredDiskBytes} bytes).`,
        { diskFreeBytes: options.diskFreeBytes, requiredDiskBytes, sourceTotalBytes },
      );
    }

    const eligibleKeySet = new Set(inventory.eligible.map((e) => e.storageKey));
    let missingAtSource = 0;
    let eligiblePresent = 0;
    let eligiblePresentBytes = 0;
    let largestEligibleBytes = 0;
    const missingAcknowledgedIds: string[] = [];
    const presentEligible: EligibleObject[] = [];
    for (const item of inventory.eligible) {
      const found = sourceListing.get(item.storageKey);
      if (found) {
        eligiblePresent++;
        eligiblePresentBytes += found.size;
        largestEligibleBytes = Math.max(largestEligibleBytes, found.size);
        presentEligible.push(item);
      } else if (item.acknowledged) {
        missingAtSource++;
        missingAcknowledgedIds.push(item.objectId);
      }
    }
    let orphanCount = 0;
    let orphanBytes = 0;
    let deletedManagedBytes = 0;
    let deletedManagedPresent = 0;
    for (const [key, meta] of sourceListing) {
      if (key === STORAGE_SENTINEL_KEY) continue;
      if (inventory.ineligibleManagedKeys.has(key)) {
        deletedManagedPresent++;
        deletedManagedBytes += meta.size;
      } else if (!eligibleKeySet.has(key)) {
        orphanCount++;
        orphanBytes += meta.size;
      }
    }
    const headerCounts: Record<string, number> = {};
    await runWithConcurrency(presentEligible, options.concurrency ?? 4, async (item) => {
      const attrs = await readSupportedObjectAttributes(sourceClient, ctx.source.bucket, item.storageKey);
      for (const h of Object.keys(attrs.headers)) headerCounts[h] = (headerCounts[h] ?? 0) + 1;
      if (Object.keys(attrs.metadata).length) headerCounts['x-amz-meta-*'] = (headerCounts['x-amz-meta-*'] ?? 0) + 1;
    });

    return {
      ok: true,
      read_only: true,
      fingerprint,
      fingerprint_details: details,
      active_run_id: activeRun?.run_id ?? null,
      active_run_phase: activeRun?.phase ?? null,
      source_features: sourceFeatures,
      preserved_attribute_counts: headerCounts,
      target_sentinel: targetSentinel,
      disk: { free_bytes: options.diskFreeBytes ?? null, required_bytes: requiredDiskBytes, source_total_bytes: sourceTotalBytes },
      counts: {
        source_total_objects: sourceListing.size,
        source_total_bytes: sourceTotalBytes,
        v4_total_rows: inventory.v4TotalRows,
        managed_total_rows: inventory.managedTotalRows,
        eligible_total: inventory.eligible.length,
        eligible_present_at_source: eligiblePresent,
        eligible_present_bytes: eligiblePresentBytes,
        largest_eligible_bytes: largestEligibleBytes,
        acknowledged_missing_at_source: missingAtSource,
        v4_incomplete_no_bytes: inventory.v4IncompleteNoBytes,
        v4_incomplete_size_mismatch: inventory.v4IncompleteSizeMismatch,
        v4_null_hash_completed: inventory.v4NullHashCompleted,
        v4_null_etag_completed: inventory.v4NullEtagCompleted,
        zero_byte_eligible: inventory.zeroByteCount,
        deleted_managed_present_at_source: deletedManagedPresent,
        deleted_managed_bytes: deletedManagedBytes,
        orphan_count: orphanCount,
        orphan_bytes: orphanBytes,
      },
      acknowledged_missing_ids: missingAcknowledgedIds.slice(0, 1000),
    };
  });
}

interface CopyResult {
  sha256: string;
  size: number;
  attrs: ObjectAttributes;
  srcEtag: string | null;
  dstEtag: string | null;
}

/**
 * Stream one object from `from` to `to` (multipart above 32 MiB) preserving content
 * type, x-amz-meta-* and cache/disposition/language/expires headers, then verify by
 * an independent target read-back: SHA-256, exact size (including 0) and attributes.
 */
async function copyAndVerifySingleObject(
  fromClient: S3Like,
  fromBucket: string,
  toClient: S3Like,
  toBucket: string,
  key: string,
  limiter: BandwidthLimiter,
): Promise<CopyResult> {
  const srcAttrs = await readSupportedObjectAttributes(fromClient, fromBucket, key);
  const srcGet = await fromClient.send(new GetObjectCommand({ Bucket: fromBucket, Key: key }));
  if (srcAttrs.etag && srcGet.ETag && srcGet.ETag !== srcAttrs.etag) {
    throw new MigrationError(MIGRATION_EXIT.TRANSIENT_IO, 'source_changed_during_copy', `Source object "${key}" changed between HEAD and GET; retry.`);
  }
  const srcHash = createHash('sha256');
  let srcBytes = 0;
  const writeParams = {
    Bucket: toBucket,
    Key: key,
    ContentType: srcAttrs.contentType,
    Metadata: Object.keys(srcAttrs.metadata).length ? srcAttrs.metadata : undefined,
    ...putHeaderParams(srcAttrs.headers),
  };

  if (srcAttrs.size <= MULTIPART_THRESHOLD_BYTES) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of (srcGet.Body as any) ?? []) {
      const buf = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      srcBytes += buf.byteLength;
      srcHash.update(buf);
      chunks.push(buf);
      await limiter.consume(buf.byteLength);
    }
    await toClient.send(new PutObjectCommand({ ...writeParams, Body: Buffer.concat(chunks) }));
  } else {
    const created = await toClient.send(new CreateMultipartUploadCommand(writeParams));
    const uploadId = created.UploadId!;
    const parts: { ETag: string; PartNumber: number }[] = [];
    let partChunks: Buffer[] = [];
    let partLen = 0;
    const flushPart = async () => {
      if (partLen === 0) return;
      const body = Buffer.concat(partChunks, partLen);
      partChunks = [];
      partLen = 0;
      const partNumber = parts.length + 1;
      const up = await toClient.send(new UploadPartCommand({ Bucket: toBucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body }));
      parts.push({ ETag: up.ETag!, PartNumber: partNumber });
    };
    try {
      for await (const chunk of (srcGet.Body as any) ?? []) {
        const buf = Buffer.from(chunk instanceof Uint8Array ? chunk : chunk);
        srcBytes += buf.byteLength;
        srcHash.update(buf);
        await limiter.consume(buf.byteLength);
        let offset = 0;
        while (offset < buf.byteLength) {
          const take = Math.min(MULTIPART_PART_BYTES - partLen, buf.byteLength - offset);
          partChunks.push(buf.subarray(offset, offset + take));
          partLen += take;
          offset += take;
          if (partLen >= MULTIPART_PART_BYTES) await flushPart();
        }
      }
      await flushPart();
      await toClient.send(new CompleteMultipartUploadCommand({ Bucket: toBucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
    } catch (err) {
      await toClient.send(new AbortMultipartUploadCommand({ Bucket: toBucket, Key: key, UploadId: uploadId })).catch(() => {});
      throw err;
    }
  }
  const srcSha = srcHash.digest('hex');
  if (srcBytes !== srcAttrs.size) {
    throw new MigrationError(MIGRATION_EXIT.TRANSIENT_IO, 'source_short_read', `Source object "${key}" returned ${srcBytes} bytes, HEAD declared ${srcAttrs.size}; retry.`);
  }

  const readback = await readObjectIdentity(toClient, toBucket, key);
  if (readback.size !== srcBytes || readback.sha256 !== srcSha || !attributesEqual(readback.attrs, srcAttrs)) {
    throw new MigrationError(
      MIGRATION_EXIT.INTEGRITY_MISMATCH,
      'copy_readback_mismatch',
      `Read-back mismatch after copying "${key}": src=(${srcBytes}B, ${srcSha}, ${srcAttrs.contentType}), dst=(${readback.size}B, ${readback.sha256}, ${readback.attrs.contentType}).`,
      { key, src_attrs: srcAttrs, dst_attrs: readback.attrs },
    );
  }
  return { sha256: srcSha, size: srcBytes, attrs: { contentType: srcAttrs.contentType, metadata: srcAttrs.metadata, headers: srcAttrs.headers }, srcEtag: srcAttrs.etag, dstEtag: readback.etag };
}

/** Independent full read of one object: HEAD attributes plus a streamed GET hash. */
async function readObjectIdentity(client: S3Like, bucket: string, key: string) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const get = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const hashed = await hashBodyStream(get.Body);
  if ((head.ContentLength ?? -1) !== hashed.size) {
    throw new MigrationError(MIGRATION_EXIT.INTEGRITY_MISMATCH, 'readback_length_mismatch', `Object "${key}" HEAD length ${head.ContentLength} differs from ${hashed.size} streamed bytes.`, { key });
  }
  return {
    ...hashed,
    etag: head.ETag ?? null,
    attrs: { contentType: head.ContentType || 'application/octet-stream', metadata: normalizeStringMap(head.Metadata), headers: headerMap(head) } as ObjectAttributes,
  };
}

async function upsertJournalCopy(
  sql: Sql,
  runId: string,
  item: EligibleObject,
  copy: CopyResult,
  state: 'copied' | 'integrity_mismatch',
) {
  await sql`
    INSERT INTO storage_migration_objects (
      run_id, storage_key, kind, object_id, size_bytes, sha256_hex,
      original_sha256_hex, original_size_bytes, original_verified_etag, original_completed,
      content_type, object_headers, custom_metadata, src_etag, dst_etag, state, updated_at
    ) VALUES (
      ${runId}, ${item.storageKey}, ${item.kind}, ${item.objectId}, ${copy.size}, ${copy.sha256},
      ${item.dbSha256Hex}, ${item.dbSizeBytes}, ${item.dbVerifiedEtag}, ${item.acknowledged},
      ${copy.attrs.contentType}, ${jsonb(sql, copy.attrs.headers)}, ${jsonb(sql, copy.attrs.metadata)},
      ${copy.srcEtag}, ${copy.dstEtag}, ${state}, NOW()
    )
    ON CONFLICT (run_id, storage_key) DO UPDATE SET
      kind = EXCLUDED.kind,
      object_id = EXCLUDED.object_id,
      size_bytes = EXCLUDED.size_bytes,
      sha256_hex = EXCLUDED.sha256_hex,
      original_sha256_hex = EXCLUDED.original_sha256_hex,
      original_size_bytes = EXCLUDED.original_size_bytes,
      original_verified_etag = EXCLUDED.original_verified_etag,
      original_completed = EXCLUDED.original_completed,
      content_type = EXCLUDED.content_type,
      object_headers = EXCLUDED.object_headers,
      custom_metadata = EXCLUDED.custom_metadata,
      src_etag = EXCLUDED.src_etag,
      dst_etag = EXCLUDED.dst_etag,
      state = EXCLUDED.state,
      updated_at = NOW()
  `;
}

function identityMismatch(item: EligibleObject, sha: string, size: number): string | null {
  if (!item.identityKnown && !item.acknowledged) return null;
  if (item.dbSha256Hex !== null && sha !== item.dbSha256Hex) return 'sha256_mismatch';
  if (size !== item.dbSizeBytes) return 'size_mismatch';
  return null;
}

async function deleteKeyIfPresent(client: S3Like, bucket: string, key: string) {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err: any) {
    if (!isNotFound(err)) throw err;
  }
}

/** Online warm pre-copy (no interruption). Resumable and idempotent. */
export async function runMigrationPrecopy(
  ctx: MigrationContext,
  options: { concurrency?: number; maxMbps?: number; runId?: string } = {},
) {
  return withMigrationAdvisoryLock(ctx.sql, () => transientAsResumable('precopy_transient_io', async () => {
    const sourceClient = getSourceClient(ctx);
    const targetClient = getTargetClient(ctx);
    await checkSourceBucketFeatures(sourceClient, ctx.source.bucket);
    const sentinel = await readTargetSentinel(targetClient, ctx.target.bucket, ctx.target.provider);
    const { fingerprint, details } = await computeInstallationFingerprint(ctx, sentinel.sentinel_id);

    let run = await getActiveMigrationRun(ctx.sql);
    if (run) {
      assertFingerprintMatches(run, fingerprint);
      if (options.runId && options.runId !== run.run_id) {
        throw new MigrationError(MIGRATION_EXIT.LOCK_OR_CONFLICT, 'other_run_active', `Run ${run.run_id} is active; refusing to start run ${options.runId}.`);
      }
      if (run.phase !== 'planned' && run.phase !== 'precopied') {
        throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'precopy_phase_denied', `Cannot run precopy while run ${run.run_id} is in phase "${run.phase}".`);
      }
    } else {
      const [inserted] = await ctx.sql<MigrationRunRow[]>`
        INSERT INTO storage_migration_runs (
          run_id, phase, fingerprint, fingerprint_details, source_provider, target_provider, target_sentinel_id
        ) VALUES (
          ${options.runId || randomUUID()}, 'planned', ${fingerprint}, ${jsonb(ctx.sql, details as unknown as Record<string, unknown>)},
          ${ctx.source.provider}, ${ctx.target.provider}, ${sentinel.sentinel_id}
        )
        RETURNING *
      `;
      run = inserted!;
    }

    const sourceListing = await listAllBucketKeys(sourceClient, ctx.source.bucket);
    const inventory = await loadEligibleObjectsFromDb(ctx.sql, sourceListing);
    const existingRows = await ctx.sql<JournalRow[]>`SELECT * FROM storage_migration_objects WHERE run_id = ${run.run_id}`;
    const journalMap = new Map(existingRows.map((r) => [r.storage_key, r]));
    const limiter = new BandwidthLimiter((options.maxMbps ?? 0) * 1024 * 1024);
    let copied = 0;
    let skippedResumed = 0;
    let missingAtSource = 0;
    let bytesCopied = 0;
    let identityMismatches = 0;

    await runWithConcurrency(inventory.eligible, options.concurrency ?? 4, async (item) => {
      const srcEntry = sourceListing.get(item.storageKey);
      if (!srcEntry) {
        missingAtSource++;
        return;
      }
      const existing = journalMap.get(item.storageKey);
      if (existing && (existing.state === 'copied' || existing.state === 'verified') && existing.src_etag === srcEntry.etag && existing.dst_etag) {
        try {
          const dstHead = await targetClient.send(new HeadObjectCommand({ Bucket: ctx.target.bucket, Key: item.storageKey }));
          if (dstHead.ETag === existing.dst_etag && (dstHead.ContentLength ?? -1) === srcEntry.size) {
            skippedResumed++;
            return;
          }
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }
      const result = await copyAndVerifySingleObject(sourceClient, ctx.source.bucket, targetClient, ctx.target.bucket, item.storageKey, limiter);
      // Online precopy never decides integrity; a mismatch is recorded and re-checked in the fenced window.
      const mismatch = identityMismatch(item, result.sha256, result.size);
      if (mismatch) {
        identityMismatches++;
        await deleteKeyIfPresent(targetClient, ctx.target.bucket, item.storageKey);
      }
      await upsertJournalCopy(ctx.sql, run!.run_id, item, result, mismatch ? 'integrity_mismatch' : 'copied');
      if (!mismatch) {
        copied++;
        bytesCopied += result.size;
      }
    });

    const evidence = { copied, skipped_resumed: skippedResumed, missing_at_source: missingAtSource, bytes_copied: bytesCopied, identity_mismatches: identityMismatches };
    const [updated] = await ctx.sql<MigrationRunRow[]>`
      UPDATE storage_migration_runs
      SET phase = 'precopied', last_evidence = ${jsonb(ctx.sql, evidence)}, updated_at = NOW()
      WHERE run_id = ${run.run_id} AND phase IN ('planned', 'precopied')
      RETURNING *
    `;
    if (!updated) {
      throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', `Concurrent phase transition prevented advancing run ${run.run_id} to precopied.`);
    }
    return { ok: true, run_id: updated.run_id, phase: updated.phase, fingerprint: updated.fingerprint, ...evidence };
  }));
}

/**
 * Cutover steps 5-7 (quiesced: source fenced, backup verified):
 * 5. re-evaluate eligibility from the quiesced DB; delete run-owned target copies of
 *    rows that became ineligible (even while the source still holds the bytes);
 * 6. delta-copy newly eligible and changed-ETag keys (single source read per object);
 * 7. every identity-bearing row's bytes must match its immutable DB identity, else
 *    exit 13 listing the exact object IDs.
 */
export async function runMigrationDelta(
  ctx: MigrationContext,
  options: { concurrency?: number; maxMbps?: number } = {},
) {
  return withMigrationAdvisoryLock(ctx.sql, () => transientAsResumable('delta_transient_io', async () => {
    const run = await requireRun(ctx, undefined, ['backed_up', 'synced'], 'delta');
    const sourceClient = getSourceClient(ctx);
    const targetClient = getTargetClient(ctx);
    await verifyRunFingerprint(ctx, run);

    const sourceListing = await listAllBucketKeys(sourceClient, ctx.source.bucket);
    const inventory = await loadEligibleObjectsFromDb(ctx.sql, sourceListing);
    const eligibleByKey = new Map(inventory.eligible.map((e) => [e.storageKey, e]));
    const journalRows = await ctx.sql<JournalRow[]>`SELECT * FROM storage_migration_objects WHERE run_id = ${run.run_id}`;
    const journalMap = new Map(journalRows.map((r) => [r.storage_key, r]));

    // Step 5.
    let purgedIneligible = 0;
    for (const jRow of journalRows) {
      if (jRow.state === 'deleted_ineligible') continue;
      const current = eligibleByKey.get(jRow.storage_key);
      const hashChanged = Boolean(current?.dbSha256Hex && jRow.original_sha256_hex && current.dbSha256Hex !== jRow.original_sha256_hex);
      if (!current || hashChanged || current.kind !== jRow.kind || current.objectId !== jRow.object_id) {
        await deleteKeyIfPresent(targetClient, ctx.target.bucket, jRow.storage_key);
        await ctx.sql`
          UPDATE storage_migration_objects SET state = 'deleted_ineligible', updated_at = NOW()
          WHERE run_id = ${run.run_id} AND storage_key = ${jRow.storage_key}
        `;
        journalMap.set(jRow.storage_key, { ...jRow, state: 'deleted_ineligible' });
        purgedIneligible++;
      }
    }

    // Steps 6 and 7.
    const limiter = new BandwidthLimiter((options.maxMbps ?? 0) * 1024 * 1024);
    let deltaCopied = 0;
    let unchangedChecked = 0;
    const integrityFailures: Array<Record<string, unknown>> = [];

    await runWithConcurrency(inventory.eligible, options.concurrency ?? 4, async (item) => {
      const srcEntry = sourceListing.get(item.storageKey);
      if (!srcEntry) {
        if (item.acknowledged) {
          integrityFailures.push({ kind: item.kind, object_id: item.objectId, storage_key: item.storageKey, reason: 'missing_at_source' });
          await ctx.sql`
            INSERT INTO storage_migration_objects (
              run_id, storage_key, kind, object_id, size_bytes, sha256_hex,
              original_sha256_hex, original_size_bytes, original_verified_etag, original_completed, state, updated_at
            ) VALUES (
              ${run.run_id}, ${item.storageKey}, ${item.kind}, ${item.objectId}, ${item.dbSizeBytes}, ${item.dbSha256Hex || '0'.repeat(64)},
              ${item.dbSha256Hex}, ${item.dbSizeBytes}, ${item.dbVerifiedEtag}, ${item.acknowledged}, 'missing_source', NOW()
            )
            ON CONFLICT (run_id, storage_key) DO UPDATE SET state = 'missing_source', updated_at = NOW()
          `;
        }
        return;
      }

      const jRow = journalMap.get(item.storageKey);
      let fresh = false;
      if (jRow && (jRow.state === 'copied' || jRow.state === 'verified') && jRow.src_etag === srcEntry.etag && jRow.dst_etag) {
        try {
          const dstHead = await targetClient.send(new HeadObjectCommand({ Bucket: ctx.target.bucket, Key: item.storageKey }));
          fresh = dstHead.ETag === jRow.dst_etag && (dstHead.ContentLength ?? -1) === srcEntry.size;
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }

      if (fresh) {
        // Same source ETag as the hashed precopy read: the journalled hash is the source bytes' hash.
        const mismatch = identityMismatch(item, jRow!.sha256_hex, Number(jRow!.size_bytes));
        if (mismatch) {
          integrityFailures.push({ kind: item.kind, object_id: item.objectId, storage_key: item.storageKey, reason: `source_${mismatch}`, expected_sha256: item.dbSha256Hex, actual_sha256: jRow!.sha256_hex, expected_size: item.dbSizeBytes, actual_size: Number(jRow!.size_bytes) });
          await deleteKeyIfPresent(targetClient, ctx.target.bucket, item.storageKey);
          await ctx.sql`UPDATE storage_migration_objects SET state = 'integrity_mismatch', updated_at = NOW() WHERE run_id = ${run.run_id} AND storage_key = ${item.storageKey}`;
          return;
        }
        // Refresh exact originals from the quiesced DB (a backfill may have run during precopy).
        await ctx.sql`
          UPDATE storage_migration_objects
          SET original_sha256_hex = ${item.dbSha256Hex}, original_size_bytes = ${item.dbSizeBytes},
              original_verified_etag = ${item.dbVerifiedEtag}, original_completed = ${item.acknowledged},
              kind = ${item.kind}, object_id = ${item.objectId}, updated_at = NOW()
          WHERE run_id = ${run.run_id} AND storage_key = ${item.storageKey}
        `;
        unchangedChecked++;
        return;
      }

      const copy = await copyAndVerifySingleObject(sourceClient, ctx.source.bucket, targetClient, ctx.target.bucket, item.storageKey, limiter);
      const mismatch = identityMismatch(item, copy.sha256, copy.size);
      if (mismatch) {
        integrityFailures.push({ kind: item.kind, object_id: item.objectId, storage_key: item.storageKey, reason: `source_${mismatch}`, expected_sha256: item.dbSha256Hex, actual_sha256: copy.sha256, expected_size: item.dbSizeBytes, actual_size: copy.size });
        await deleteKeyIfPresent(targetClient, ctx.target.bucket, item.storageKey);
        await upsertJournalCopy(ctx.sql, run.run_id, item, copy, 'integrity_mismatch');
        return;
      }
      await upsertJournalCopy(ctx.sql, run.run_id, item, copy, 'copied');
      deltaCopied++;
    });

    if (integrityFailures.length > 0) {
      throw new MigrationError(
        MIGRATION_EXIT.INTEGRITY_MISMATCH,
        'source_integrity_mismatch',
        `Cutover aborted (exit 13): ${integrityFailures.length} acknowledged object(s) do not match their immutable DB identity. Nothing was switched; use rollback (RB1).`,
        { integrity_failures: integrityFailures },
      );
    }

    const evidence = { purged_ineligible: purgedIneligible, delta_copied: deltaCopied, unchanged_checked: unchangedChecked };
    const [updated] = await ctx.sql<MigrationRunRow[]>`
      UPDATE storage_migration_runs SET phase = 'synced', last_evidence = ${jsonb(ctx.sql, evidence)}, updated_at = NOW()
      WHERE run_id = ${run.run_id} AND phase IN ('backed_up', 'synced')
      RETURNING *
    `;
    if (!updated) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', 'Failed to advance run to synced.');
    return { ok: true, run_id: updated.run_id, phase: updated.phase, ...evidence };
  }));
}

/**
 * Independent read-back verification.
 * - `cutover` (step 9, phase synced/verified): 100% read-back of the target against the
 *   quiesced DB identity and the journal, exact listing parity (journal + sentinel).
 * - `published` (phase start_intent/started): the same full read-back after SeaweedFS was
 *   recreated with its public binding, before NStack serves. `strict` (NStack not yet
 *   started) also requires exact journal parity; otherwise new uploads are legitimate.
 * - `standalone`: read-only verification of either store against the live DB.
 */
export async function runMigrationVerify(
  ctx: MigrationContext,
  options: { concurrency?: number; standalone?: boolean; published?: boolean; strict?: boolean; store?: 'target' | 'source'; targetBootId?: string } = {},
) {
  const mode: 'cutover' | 'published' | 'standalone' = options.standalone ? 'standalone' : options.published ? 'published' : 'cutover';
  const exec = () => transientAsResumable('verify_transient_io', async () => {
    const store = options.store ?? 'target';
    const client = store === 'target' ? getTargetClient(ctx) : getSourceClient(ctx);
    const bucket = store === 'target' ? ctx.target.bucket : ctx.source.bucket;
    let run: MigrationRunRow | null = null;
    if (mode !== 'standalone') {
      if (store !== 'target') throw new MigrationError(MIGRATION_EXIT.USAGE, 'verify_store_invalid', 'Cutover verification always reads the target store.');
      run = await requireRun(ctx, undefined, mode === 'cutover' ? ['synced', 'verified'] : ['start_intent', 'started'], 'verify');
      await verifyRunFingerprint(ctx, run);
    }
    const strictJournal = mode === 'cutover' || (mode === 'published' && Boolean(options.strict));

    const listing = await listAllBucketKeys(client, bucket);
    const inventory = await loadEligibleObjectsFromDb(ctx.sql, mode === 'cutover' ? null : listing);
    const journalRows = run
      ? await ctx.sql<JournalRow[]>`
          SELECT * FROM storage_migration_objects
          WHERE run_id = ${run.run_id} AND state ${mode === 'cutover' ? ctx.sql`NOT IN ('deleted_ineligible', 'missing_source', 'integrity_mismatch')` : ctx.sql`IN ('verified', 'switched')`}
        `
      : [];
    const journalMap = new Map(journalRows.map((r) => [r.storage_key, r]));
    const eligibleByKey = new Map(inventory.eligible.map((e) => [e.storageKey, e]));
    const expectedKeys = new Set<string>();
    const mismatches: Array<{ key: string; object_id?: string; reason: string; detail?: unknown }> = [];
    const strayKeys: string[] = [];

    for (const item of inventory.eligible) {
      const j = journalMap.get(item.storageKey);
      if (strictJournal) {
        // Every eligible row must have been journalled; an unjournalled key is never accepted.
        if (j) expectedKeys.add(item.storageKey);
        else if (item.acknowledged || listing.has(item.storageKey)) mismatches.push({ key: item.storageKey, object_id: item.objectId, reason: 'missing_from_journal' });
      } else if (item.acknowledged || listing.has(item.storageKey)) {
        expectedKeys.add(item.storageKey);
      }
    }
    if (strictJournal) {
      for (const key of journalMap.keys()) {
        if (!eligibleByKey.has(key)) mismatches.push({ key, reason: 'ineligible_key_still_active_in_journal' });
      }
    } else if (mode === 'published') {
      // Journalled objects must still be present unless their row legitimately became ineligible.
      for (const key of journalMap.keys()) if (eligibleByKey.has(key)) expectedKeys.add(key);
    }
    for (const key of listing.keys()) {
      if (key === STORAGE_SENTINEL_KEY || expectedKeys.has(key)) continue;
      if (strictJournal) mismatches.push({ key, reason: 'stray_key_in_target_bucket' });
      else strayKeys.push(key);
    }
    for (const key of expectedKeys) {
      if (!listing.has(key)) mismatches.push({ key, object_id: eligibleByKey.get(key)?.objectId, reason: 'missing_from_bucket' });
    }

    const toVerify = inventory.eligible.filter((e) => expectedKeys.has(e.storageKey) && listing.has(e.storageKey));
    let verifiedCount = 0;
    let verifiedBytes = 0;
    const verifiedEtags = new Map<string, string | null>();
    await runWithConcurrency(toVerify, options.concurrency ?? 4, async (item) => {
      const rb = await readObjectIdentity(client, bucket, item.storageKey);
      const j = journalMap.get(item.storageKey);
      const mismatch = identityMismatch(item, rb.sha256, rb.size);
      if (mismatch) {
        mismatches.push({ key: item.storageKey, object_id: item.objectId, reason: `db_${mismatch}`, detail: { expected_sha: item.dbSha256Hex, actual_sha: rb.sha256, expected_size: item.dbSizeBytes, actual_size: rb.size } });
        return;
      }
      if (j && (strictJournal || item.identityKnown)) {
        if (rb.sha256 !== j.sha256_hex || rb.size !== Number(j.size_bytes)) {
          mismatches.push({ key: item.storageKey, object_id: item.objectId, reason: 'journal_bytes_mismatch', detail: { expected_sha: j.sha256_hex, actual_sha: rb.sha256, expected_size: Number(j.size_bytes), actual_size: rb.size } });
          return;
        }
        const expectedAttrs: ObjectAttributes = { contentType: j.content_type || 'application/octet-stream', metadata: normalizeStringMap(j.custom_metadata), headers: normalizeStringMap(j.object_headers) };
        if (!attributesEqual(rb.attrs, expectedAttrs)) {
          mismatches.push({ key: item.storageKey, object_id: item.objectId, reason: 'attributes_mismatch', detail: { expected: expectedAttrs, actual: rb.attrs } });
          return;
        }
        // Rewritten DB ETags are If-Match preconditions for Blossom reads; they must survive the recreate.
        if (mode === 'published' && j.state === 'switched' && rb.etag !== j.dst_etag) {
          mismatches.push({ key: item.storageKey, object_id: item.objectId, reason: 'etag_changed_after_publish', detail: { expected: j.dst_etag, actual: rb.etag } });
          return;
        }
        verifiedEtags.set(item.storageKey, rb.etag);
      }
      verifiedCount++;
      verifiedBytes += rb.size;
    });

    if (mismatches.length > 0) {
      throw new MigrationError(
        mode === 'published' ? MIGRATION_EXIT.SMOKE_FAILED : MIGRATION_EXIT.INTEGRITY_MISMATCH,
        'verification_failed',
        `${mode} ${store} verification failed with ${mismatches.length} mismatch(es).`,
        { mismatches: mismatches.slice(0, 1000), mismatch_count: mismatches.length },
      );
    }

    const evidence = { mode, verified_count: verifiedCount, verified_bytes: verifiedBytes, listing_exact_match: strayKeys.length === 0, target_boot_id: options.targetBootId ?? null, at: new Date().toISOString() };
    if (run && mode === 'cutover') {
      await ctx.sql.begin(async (tx) => {
        for (const [key, etag] of verifiedEtags) {
          await tx`UPDATE storage_migration_objects SET dst_etag = ${etag}, state = 'verified', updated_at = NOW() WHERE run_id = ${run!.run_id} AND storage_key = ${key}`;
        }
        const [updated] = await tx<MigrationRunRow[]>`
          UPDATE storage_migration_runs
          SET phase = 'verified', last_evidence = ${jsonb(ctx.sql, evidence)},
              target_boot_id = COALESCE(${options.targetBootId ?? null}, target_boot_id), updated_at = NOW()
          WHERE run_id = ${run!.run_id} AND phase IN ('synced', 'verified')
          RETURNING run_id
        `;
        if (!updated) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', 'Failed to advance run to verified.');
      });
    } else if (run && mode === 'published') {
      // Journal ETags are not rewritten here: the recreate keeps object identity; a changed ETag is a mismatch above via bytes.
      await ctx.sql`
        UPDATE storage_migration_runs
        SET target_boot_id = COALESCE(${options.targetBootId ?? null}, target_boot_id),
            last_evidence = last_evidence || ${jsonb(ctx.sql, { published_verify: evidence })}, updated_at = NOW()
        WHERE run_id = ${run.run_id}
      `;
    }
    return {
      ok: true,
      mode,
      store,
      run_id: run?.run_id ?? null,
      phase: mode === 'cutover' ? 'verified' : run?.phase ?? null,
      verified_count: verifiedCount,
      verified_bytes: verifiedBytes,
      listing_count: listing.size,
      listing_exact_match: strayKeys.length === 0,
      stray_keys: strayKeys.slice(0, 1000),
      stray_key_count: strayKeys.length,
    };
  });
  return mode === 'standalone' ? exec() : withMigrationAdvisoryLock(ctx.sql, exec);
}

/** Step 10: confirm exact journal originals and record old/new config digests. */
export async function prepareMigrationSwitch(
  ctx: MigrationContext,
  options: { oldConfigDigest: string; newConfigDigest: string },
) {
  return withMigrationAdvisoryLock(ctx.sql, async () => {
    const digestPattern = /^[0-9a-f]{64}$/;
    if (!digestPattern.test(options.oldConfigDigest) || !digestPattern.test(options.newConfigDigest) || options.oldConfigDigest === options.newConfigDigest) {
      throw new MigrationError(MIGRATION_EXIT.USAGE, 'invalid_config_digests', 'Distinct SHA-256 old and new config digests are required.');
    }
    const run = await requireRun(ctx, undefined, ['verified', 'switch_prepared'], 'prepare-switch');
    await verifyRunFingerprint(ctx, run);
    if (run.phase === 'switch_prepared' && (run.old_config_digest !== options.oldConfigDigest || run.new_config_digest !== options.newConfigDigest)) {
      throw new MigrationError(MIGRATION_EXIT.LOCK_OR_CONFLICT, 'config_digest_conflict', 'Run is already prepared with different config digests.');
    }
    const [unverified] = await ctx.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM storage_migration_objects
      WHERE run_id = ${run.run_id} AND state NOT IN ('verified', 'deleted_ineligible')
    `;
    if (Number(unverified?.count ?? '0') > 0) {
      throw new MigrationError(MIGRATION_EXIT.INTEGRITY_MISMATCH, 'unverified_journal_rows', `Cannot prepare switch: ${unverified!.count} journal row(s) are not verified.`);
    }
    const [missingEtag] = await ctx.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM storage_migration_objects
      WHERE run_id = ${run.run_id} AND kind = 'v4' AND state = 'verified' AND original_verified_etag IS NOT NULL AND dst_etag IS NULL
    `;
    if (Number(missingEtag?.count ?? '0') > 0) {
      throw new MigrationError(MIGRATION_EXIT.INTEGRITY_MISMATCH, 'missing_dst_etag', `Cannot prepare switch: ${missingEtag!.count} verified v4 row(s) lack dst_etag.`);
    }
    const [updated] = await ctx.sql<MigrationRunRow[]>`
      UPDATE storage_migration_runs
      SET phase = 'switch_prepared', old_config_digest = ${options.oldConfigDigest}, new_config_digest = ${options.newConfigDigest}, updated_at = NOW()
      WHERE run_id = ${run.run_id} AND phase IN ('verified', 'switch_prepared')
      RETURNING *
    `;
    if (!updated) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', 'Failed to advance run to switch_prepared.');
    return { ok: true, run_id: updated.run_id, phase: updated.phase, old_config_digest: updated.old_config_digest, new_config_digest: updated.new_config_digest };
  });
}

/**
 * Step 11: one transaction that rewrites sha256_verified_etag only on completed v4
 * rows that already had a verified ETag and still hold their exact original identity,
 * and advances switch_prepared -> db_switched.
 */
export async function rewriteMigrationEtags(ctx: MigrationContext) {
  return withMigrationAdvisoryLock(ctx.sql, async () => {
    const latest = await requireRun(ctx, undefined, ['switch_prepared', 'db_switched'], 'rewrite-etags');
    await verifyRunFingerprint(ctx, latest);
    return ctx.sql.begin(async (tx) => {
      const [run] = await tx<MigrationRunRow[]>`SELECT * FROM storage_migration_runs WHERE run_id = ${latest.run_id} FOR UPDATE`;
      if (run!.phase === 'db_switched') return { ok: true, run_id: run!.run_id, phase: run!.phase, rewritten_count: 0, already_switched: true };
      if (run!.phase !== 'switch_prepared') throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'rewrite_etags_phase_denied', `rewrite-etags requires switch_prepared; current phase is "${run!.phase}".`);
      const targets = await tx<JournalRow[]>`
        SELECT * FROM storage_migration_objects
        WHERE run_id = ${run!.run_id} AND kind = 'v4' AND state = 'verified' AND original_verified_etag IS NOT NULL
        ORDER BY object_id
      `;
      let rewrittenCount = 0;
      for (const row of targets) {
        if (!row.dst_etag) throw new MigrationError(MIGRATION_EXIT.INTEGRITY_MISMATCH, 'missing_dst_etag', `Journal row for v4 object ${row.object_id} is missing dst_etag.`);
        const [res] = await tx<{ id: string }[]>`
          UPDATE v4_storage_objects SET sha256_verified_etag = ${row.dst_etag}
          WHERE id = ${row.object_id}::uuid
            AND completed_at IS NOT NULL
            AND sha256_verified_etag = ${row.original_verified_etag}
            AND sha256_hex IS NOT DISTINCT FROM ${row.original_sha256_hex}
            AND size_bytes = ${Number(row.original_size_bytes)}
          RETURNING id::text
        `;
        if (!res) {
          throw new MigrationError(MIGRATION_EXIT.INTEGRITY_MISMATCH, 'etag_rewrite_row_changed', `v4_storage_objects row ${row.object_id} changed since verification; ETag rewrite aborted.`, { object_id: row.object_id });
        }
        await tx`UPDATE storage_migration_objects SET state = 'switched', updated_at = NOW() WHERE run_id = ${run!.run_id} AND storage_key = ${row.storage_key}`;
        rewrittenCount++;
      }
      const [updated] = await tx<MigrationRunRow[]>`
        UPDATE storage_migration_runs SET phase = 'db_switched', last_evidence = ${jsonb(ctx.sql, { rewritten_etag_count: rewrittenCount })}, updated_at = NOW()
        WHERE run_id = ${run!.run_id} AND phase = 'switch_prepared'
        RETURNING *
      `;
      if (!updated) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', 'Failed to advance run to db_switched.');
      return { ok: true, run_id: updated.run_id, phase: updated.phase, rewritten_count: rewrittenCount, already_switched: false };
    });
  });
}

/** Restore switched rows' exact original ETags inside `tx`. */
async function revertSwitchedEtags(tx: Sql, runId: string, nextState: 'reverted' | 'copied') {
  const switched = await tx<JournalRow[]>`
    SELECT * FROM storage_migration_objects WHERE run_id = ${runId} AND kind = 'v4' AND state = 'switched' ORDER BY object_id
  `;
  for (const row of switched) {
    const [res] = await tx<{ id: string }[]>`
      UPDATE v4_storage_objects SET sha256_verified_etag = ${row.original_verified_etag}
      WHERE id = ${row.object_id}::uuid
        AND sha256_hex IS NOT DISTINCT FROM ${row.original_sha256_hex}
        AND size_bytes = ${Number(row.original_size_bytes)}
        AND sha256_verified_etag IS NOT DISTINCT FROM ${row.dst_etag}
      RETURNING id::text
    `;
    if (!res) {
      throw new MigrationError(MIGRATION_EXIT.INTEGRITY_MISMATCH, 'etag_revert_row_changed', `v4_storage_objects row ${row.object_id} changed after the ETag rewrite; refusing a blind revert.`, { object_id: row.object_id });
    }
    await tx`UPDATE storage_migration_objects SET state = ${nextState}, updated_at = NOW() WHERE run_id = ${runId} AND storage_key = ${row.storage_key}`;
  }
  return switched.length;
}

/**
 * RB1 begin (any phase before start_intent): restore exact original ETags and move
 * the run to `rolling_back` in one transaction. The host then restores config and
 * bindings, starts NStack on the source and calls `finish-rollback`. Re-running in
 * `rolling_back` is a no-op so an interrupted rollback resumes.
 */
export async function beginRollbackRb1(ctx: MigrationContext) {
  return withMigrationAdvisoryLock(ctx.sql, async () => {
    const latest = await getLatestMigrationRun(ctx.sql);
    if (!latest) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'no_run_found', 'No migration run found.');
    if (POST_WRITE_PHASES.includes(latest.phase) || latest.phase === 'source_retired') {
      throw new MigrationError(MIGRATION_EXIT.ROLLBACK_REFUSED, 'bare_rollback_refused_post_start_intent', `Bare rollback is refused in phase "${latest.phase}" (at or after the start_intent write boundary). Fail forward, or use --reverse-migrate (RB2) while the target is readable.`);
    }
    if (latest.phase === 'rolling_back') {
      if (latest.rollback_from_phase && POST_WRITE_PHASES.includes(latest.rollback_from_phase)) {
        throw new MigrationError(MIGRATION_EXIT.ROLLBACK_REFUSED, 'rb2_in_progress', 'An RB2 reverse migration is in progress; resume it with --reverse-migrate.');
      }
      return { ok: true, run_id: latest.run_id, phase: latest.phase, rollback_from_phase: latest.rollback_from_phase, reverted_count: 0, resumed: true };
    }
    if (latest.phase === 'rolled_back' || latest.phase === 'committed' || latest.phase === 'aborted_restore') {
      throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'rollback_not_applicable', `Rollback is not applicable in phase "${latest.phase}".`);
    }
    await verifyRunFingerprint(ctx, latest, { allowJournalSentinelFallback: true });
    return ctx.sql.begin(async (tx) => {
      const [run] = await tx<MigrationRunRow[]>`SELECT * FROM storage_migration_runs WHERE run_id = ${latest.run_id} FOR UPDATE`;
      if (run!.phase !== latest.phase) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', 'Concurrent phase change detected.');
      const reverted = await revertSwitchedEtags(tx as unknown as Sql, run!.run_id, 'reverted');
      await tx`
        UPDATE storage_migration_runs
        SET phase = 'rolling_back', rollback_from_phase = ${run!.phase}, rolling_back_at = NOW(),
            last_evidence = ${jsonb(ctx.sql, { rb1_reverted_etags: reverted, from_phase: run!.phase })}, updated_at = NOW()
        WHERE run_id = ${run!.run_id}
      `;
      return { ok: true, run_id: run!.run_id, phase: 'rolling_back', rollback_from_phase: run!.phase, reverted_count: reverted, resumed: false };
    });
  });
}

/**
 * Snapshot invalidated during a quiesced phase (§7.6): restore exact ETags, discard
 * the fence/backup/switch state and return to `precopied` so cutover re-fences and
 * redoes steps 2-9. The host restores the old config by digest before calling this.
 */
export async function resetMigrationSnapshot(ctx: MigrationContext, reason: string) {
  return withMigrationAdvisoryLock(ctx.sql, async () => {
    const latest = await requireRun(ctx, undefined, QUIESCED_PHASES, 'reset-snapshot');
    await verifyRunFingerprint(ctx, latest, { allowJournalSentinelFallback: true });
    return ctx.sql.begin(async (tx) => {
      const [run] = await tx<MigrationRunRow[]>`SELECT * FROM storage_migration_runs WHERE run_id = ${latest.run_id} FOR UPDATE`;
      if (run!.phase !== latest.phase) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', 'Concurrent phase change detected.');
      const reverted = await revertSwitchedEtags(tx as unknown as Sql, run!.run_id, 'copied');
      // Verified state is tied to the invalidated target boundary; everything is re-verified.
      await tx`UPDATE storage_migration_objects SET state = 'copied', updated_at = NOW() WHERE run_id = ${run!.run_id} AND state = 'verified'`;
      await tx`
        UPDATE storage_migration_runs
        SET phase = 'precopied', source_boot_id = NULL, target_boot_id = NULL, fence_identity = NULL,
            old_config_digest = NULL, new_config_digest = NULL, verified_backup_dir = NULL,
            backup_manifest_sha256 = NULL, source_fenced_at = NULL, backed_up_at = NULL,
            last_evidence = ${jsonb(ctx.sql, { snapshot_reset_from: run!.phase, reason, reverted_etags: reverted })}, updated_at = NOW()
        WHERE run_id = ${run!.run_id}
      `;
      return { ok: true, run_id: run!.run_id, phase: 'precopied', reset_from: run!.phase, reverted_etags: reverted };
    });
  });
}

/** Host confirms the source is serving again: rolling_back -> rolled_back. */
export async function finishMigrationRollback(ctx: MigrationContext, evidence: Record<string, unknown> = {}) {
  return withMigrationAdvisoryLock(ctx.sql, async () => {
    const run = await requireRun(ctx, undefined, ['rolling_back'], 'finish-rollback');
    const rb2 = run.rollback_from_phase !== null && POST_WRITE_PHASES.includes(run.rollback_from_phase);
    const merged = { ...normalizeEvidence(run.last_evidence), ...evidence };
    if (rb2 && merged.rb2_reverse_synced !== true) {
      throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'rb2_not_synced', 'RB2 cannot finish before reverse-sync completed.');
    }
    if (rb2 && !(run.smoke_passed_at && run.smoke_evidence?.store === 'source')) {
      throw new MigrationError(MIGRATION_EXIT.SMOKE_FAILED, 'rb2_smoke_missing', 'RB2 cannot finish without a passing smoke on the source store.');
    }
    const [updated] = await ctx.sql<MigrationRunRow[]>`
      UPDATE storage_migration_runs SET phase = 'rolled_back', rolled_back_at = NOW(), last_evidence = ${jsonb(ctx.sql, merged)}, updated_at = NOW()
      WHERE run_id = ${run.run_id} AND phase = 'rolling_back'
      RETURNING *
    `;
    if (!updated) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', 'Failed to finish rollback.');
    return { ok: true, run_id: updated.run_id, phase: updated.phase, rollback_from_phase: updated.rollback_from_phase };
  });
}

function normalizeEvidence(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch { /* ignored */ }
  }
  return {};
}

const LEGAL_MARK_TRANSITIONS: Partial<Record<MigrationPhase, MigrationPhase[]>> = {
  source_fenced: ['precopied'],
  backed_up: ['source_fenced'],
  config_switched: ['db_switched'],
  start_intent: ['config_switched'],
  started: ['start_intent'],
  source_retired: ['committed'],
};

export interface MarkOptions {
  phase: MigrationPhase;
  runId?: string;
  sourceBootId?: string | null;
  targetBootId?: string | null;
  fenceIdentity?: Record<string, unknown> | null;
  verifiedBackupDir?: string | null;
  backupManifestSha256?: string | null;
  configDigest?: string | null;
  evidence?: Record<string, unknown>;
}

async function markMigrationPhaseUnlocked(ctx: MigrationContext, options: MarkOptions) {
  const allowedFrom = LEGAL_MARK_TRANSITIONS[options.phase];
  if (!allowedFrom) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'mark_phase_not_allowed', `Phase "${options.phase}" cannot be set via mark.`);
  const run = await getLatestMigrationRun(ctx.sql);
  if (!run || (options.runId && run.run_id !== options.runId)) {
    throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'no_matching_run', 'No matching migration run found.');
  }
  // Idempotent re-mark of the phase already reached (crash between host step and mark output).
  if (run.phase === options.phase) return { ok: true, run_id: run.run_id, phase: run.phase, already: true };
  if (!allowedFrom.includes(run.phase)) {
    throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'illegal_phase_transition', `Cannot transition run ${run.run_id} from "${run.phase}" to "${options.phase}". Allowed prior phases: ${allowedFrom.join(', ')}.`);
  }
  if (options.phase === 'source_fenced' && (!options.sourceBootId || !options.fenceIdentity)) {
    throw new MigrationError(MIGRATION_EXIT.USAGE, 'fence_identity_required', 'source_fenced requires --source-boot-id and --fence-identity.');
  }
  if (options.phase === 'backed_up' && (!options.verifiedBackupDir || !/^[0-9a-f]{64}$/.test(options.backupManifestSha256 || ''))) {
    throw new MigrationError(MIGRATION_EXIT.USAGE, 'backup_evidence_required', 'backed_up requires --verified-backup-dir and --backup-manifest-sha256.');
  }
  if (options.phase === 'config_switched' && options.configDigest !== run.new_config_digest) {
    throw new MigrationError(MIGRATION_EXIT.FENCE_OR_BACKUP, 'config_digest_mismatch', 'config_switched requires the live config digest to equal the journalled new_config_digest.');
  }
  await verifyRunFingerprint(ctx, run);

  const [updated] = await ctx.sql<MigrationRunRow[]>`
    UPDATE storage_migration_runs
    SET phase = ${options.phase},
        source_boot_id = CASE WHEN ${options.phase} = 'source_fenced' THEN ${options.sourceBootId ?? null} ELSE source_boot_id END,
        fence_identity = CASE WHEN ${options.phase} = 'source_fenced' THEN ${options.fenceIdentity ? jsonb(ctx.sql, options.fenceIdentity) : null}::jsonb ELSE fence_identity END,
        target_boot_id = CASE WHEN ${options.phase} = 'source_fenced' THEN NULL ELSE COALESCE(${options.targetBootId ?? null}, target_boot_id) END,
        old_config_digest = CASE WHEN ${options.phase} = 'source_fenced' THEN NULL ELSE old_config_digest END,
        new_config_digest = CASE WHEN ${options.phase} = 'source_fenced' THEN NULL ELSE new_config_digest END,
        verified_backup_dir = CASE WHEN ${options.phase} = 'source_fenced' THEN NULL WHEN ${options.phase} = 'backed_up' THEN ${options.verifiedBackupDir ?? null} ELSE verified_backup_dir END,
        backup_manifest_sha256 = CASE WHEN ${options.phase} = 'source_fenced' THEN NULL WHEN ${options.phase} = 'backed_up' THEN ${options.backupManifestSha256 ?? null} ELSE backup_manifest_sha256 END,
        source_fenced_at = CASE WHEN ${options.phase} = 'source_fenced' THEN NOW() ELSE source_fenced_at END,
        backed_up_at = CASE WHEN ${options.phase} = 'source_fenced' THEN NULL WHEN ${options.phase} = 'backed_up' THEN NOW() ELSE backed_up_at END,
        start_intent_at = CASE WHEN ${options.phase} = 'start_intent' THEN COALESCE(start_intent_at, NOW()) ELSE start_intent_at END,
        started_at = CASE WHEN ${options.phase} = 'started' THEN COALESCE(started_at, NOW()) ELSE started_at END,
        source_retired_at = CASE WHEN ${options.phase} = 'source_retired' THEN NOW() ELSE source_retired_at END,
        last_evidence = ${jsonb(ctx.sql, options.evidence ?? {})},
        updated_at = NOW()
    WHERE run_id = ${run.run_id} AND phase = ${run.phase}
    RETURNING *
  `;
  if (!updated) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', 'Concurrent phase change detected.');
  return { ok: true, run_id: updated.run_id, phase: updated.phase, already: false };
}

/** CAS-recorded host phase transition (`mark --phase ...`). */
export async function markMigrationPhase(ctx: MigrationContext, options: MarkOptions) {
  return withMigrationAdvisoryLock(ctx.sql, () => markMigrationPhaseUnlocked(ctx, options));
}

function nip98Header(url: string, method: string, secretKey: Uint8Array, body?: string): string {
  const tags: string[][] = [['u', url], ['method', method.toUpperCase()]];
  if (body !== undefined && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
    tags.push(['payload', createHash('sha256').update(body).digest('hex')]);
  }
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, secretKey);
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

function activeStore(ctx: MigrationContext, store: 'target' | 'source') {
  return store === 'target'
    ? { client: getTargetClient(ctx), bucket: ctx.target.bucket, endpoint: ctx.target.endpoint }
    : { client: getSourceClient(ctx), bucket: ctx.source.bucket, endpoint: ctx.source.endpoint };
}

/** Delete journalled probe rows (in a transaction) and their keys in the active store. */
async function cleanupMigrationProbesUnlocked(ctx: MigrationContext, run: MigrationRunRow, store: 'target' | 'source') {
  const { client, bucket } = activeStore(ctx, store);
  const probes = await ctx.sql<{ probe_id: string; kind: string; row_id: string | null; storage_key: string | null }[]>`
    SELECT probe_id::text, kind, row_id::text, storage_key FROM storage_migration_probes
    WHERE run_id = ${run.run_id} AND cleaned_at IS NULL
    ORDER BY created_at DESC
  `;
  let cleaned = 0;
  const ordered = [...probes.filter((p) => p.kind !== 'workspace'), ...probes.filter((p) => p.kind === 'workspace')];
  for (const p of ordered) {
    if (p.kind !== 'workspace' && p.storage_key) await deleteKeyIfPresent(client, bucket, p.storage_key);
    await ctx.sql.begin(async (tx) => {
      if (p.kind === 'v4' && p.row_id) {
        await tx`DELETE FROM registered_app_storage_objects WHERE object_id = ${p.row_id}::uuid`;
        await tx`DELETE FROM v4_storage_objects WHERE id = ${p.row_id}::uuid`;
      } else if (p.kind === 'workspace' && p.storage_key) {
        // storage_key holds the synthetic probe workspace owner npub; row_id its group.
        // The workspace is synthetic, so any object it still owns (prepared before a crash
        // could journal it) is a probe too.
        const owner = p.storage_key;
        const stray = await tx<{ id: string; storage_path: string }[]>`SELECT id::text, storage_path FROM v4_storage_objects WHERE owner_npub = ${owner}`;
        for (const obj of stray) await deleteKeyIfPresent(client, bucket, obj.storage_path);
        await tx`DELETE FROM registered_app_storage_objects WHERE workspace_owner_npub = ${owner}`;
        await tx`DELETE FROM v4_storage_objects WHERE owner_npub = ${owner}`;
        await tx`DELETE FROM workspace_apps WHERE workspace_owner_npub = ${owner}`;
        await tx`DELETE FROM v4_workspaces WHERE workspace_owner_npub = ${owner}`;
        await tx`DELETE FROM v4_groups WHERE owner_npub = ${owner}`;
      }
      await tx`UPDATE storage_migration_probes SET cleaned_at = NOW() WHERE run_id = ${run.run_id} AND probe_id = ${p.probe_id}::uuid`;
    });
    cleaned++;
  }
  return { ok: true, run_id: run.run_id, cleaned };
}

/** Clean up journalled smoke probes (`storage_migration_probes.cleaned_at IS NULL`). */
export async function cleanupMigrationProbes(ctx: MigrationContext, options: { runId?: string; store?: 'target' | 'source' } = {}) {
  return withMigrationAdvisoryLock(ctx.sql, async () => {
    const run = options.runId
      ? (await ctx.sql<MigrationRunRow[]>`SELECT * FROM storage_migration_runs WHERE run_id = ${options.runId}`)[0]
      : await getLatestMigrationRun(ctx.sql);
    if (!run) return { ok: true, cleaned: 0 };
    await verifyRunFingerprint(ctx, run, { allowJournalSentinelFallback: true });
    return cleanupMigrationProbesUnlocked(ctx, run, options.store ?? smokeStoreForRun(run));
  });
}

function smokeStoreForRun(run: MigrationRunRow): 'target' | 'source' {
  return run.phase === 'rolling_back' ? 'source' : 'target';
}

/**
 * Live smoke through NStack using journalled probes in a synthetic probe workspace
 * (§6 step 13, §7.3). Target store: phase start_intent/started. Source store: an RB2
 * rollback (`rolling_back` from a post-write phase) after NStack restarted on the source.
 * Records durable passing evidence (required by commit / finish-rollback) only after
 * every check and the probe cleanup succeed. Failures exit 14.
 */
export async function runMigrationSmoke(
  ctx: MigrationContext,
  options: { apiBaseUrl: string; expectedPublicEndpoint?: string; checkPublicDirectPut?: boolean; sampleCount?: number; store?: 'target' | 'source' },
) {
  return withMigrationAdvisoryLock(ctx.sql, async () => {
    const store = options.store ?? 'target';
    const run = await getLatestMigrationRun(ctx.sql);
    const allowed = store === 'target'
      ? Boolean(run && (run.phase === 'start_intent' || run.phase === 'started'))
      : Boolean(run && run.phase === 'rolling_back' && run.rollback_from_phase && POST_WRITE_PHASES.includes(run.rollback_from_phase));
    if (!run || !allowed) {
      throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'smoke_phase_denied', `smoke-data (${store}) is not permitted in phase "${run?.phase ?? 'none'}".`);
    }
    await verifyRunFingerprint(ctx, run, { allowJournalSentinelFallback: store === 'source' });
    if (!ctx.serviceNsec) throw new MigrationError(MIGRATION_EXIT.USAGE, 'missing_service_nsec', 'SUPERBASED_SERVICE_NSEC is required for signed smoke probes.');
    const decoded = nip19.decode(ctx.serviceNsec);
    if (decoded.type !== 'nsec') throw new MigrationError(MIGRATION_EXIT.USAGE, 'invalid_service_nsec', 'Invalid SUPERBASED_SERVICE_NSEC.');
    const serviceSecret = decoded.data as Uint8Array;
    const serviceNpub = nip19.npubEncode(getPublicKey(serviceSecret));
    const { client: storeClient, bucket: storeBucket, endpoint: storeEndpoint } = activeStore(ctx, store);
    const apiBase = options.apiBaseUrl.replace(/\/+$/, '');
    const failSmoke = (code: string, message: string, detail?: unknown): never => {
      throw new MigrationError(MIGRATION_EXIT.SMOKE_FAILED, code, message, detail);
    };

    await ctx.sql`UPDATE storage_migration_runs SET smoke_evidence = NULL, smoke_passed_at = NULL, updated_at = NOW() WHERE run_id = ${run.run_id}`;
    try {
      const healthRes = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(10_000) });
      if (!healthRes.ok) failSmoke('smoke_health_failed', `/health returned HTTP ${healthRes.status}`);
      const healthJson = (await healthRes.json()) as any;
      if (healthJson.status !== 'ok' || healthJson.service_npub !== serviceNpub) {
        failSmoke('smoke_health_identity_mismatch', '/health status or service_npub mismatch', { status: healthJson.status, service_npub: healthJson.service_npub });
      }
      if (store === 'target' && run.phase === 'start_intent') {
        await markMigrationPhaseUnlocked(ctx, { phase: 'started', evidence: { health_ok: true } });
      }

      // Residual probes from an earlier interrupted smoke go first.
      await cleanupMigrationProbesUnlocked(ctx, run, store);

      const probeWsOwnerNpub = nip19.npubEncode(getPublicKey(randomBytes(32)));
      const probeGroupId = randomUUID();
      const probeGroupNpub = nip19.npubEncode(getPublicKey(randomBytes(32)));
      const outsiderSecret = randomBytes(32);
      const memberSecret = randomBytes(32);
      const memberNpub = nip19.npubEncode(getPublicKey(memberSecret));
      const appSecret = randomBytes(32);
      const appNpub = nip19.npubEncode(getPublicKey(appSecret));

      // Journal the workspace probe before creating it so a crash leaves a cleanable record.
      await ctx.sql`
        INSERT INTO storage_migration_probes (run_id, probe_id, kind, row_id, storage_key)
        VALUES (${run.run_id}, ${randomUUID()}, 'workspace', ${probeGroupId}, ${probeWsOwnerNpub})
      `;
      await ctx.sql.begin(async (tx) => {
        await tx`INSERT INTO v4_groups (id, owner_npub, name, group_npub, group_kind) VALUES (${probeGroupId}, ${probeWsOwnerNpub}, 'nstack-migration-smoke', ${probeGroupNpub}, 'shared')`;
        await tx`INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub) VALUES (${probeGroupId}, 1, ${probeGroupNpub}, ${serviceNpub})`;
        await tx`
          INSERT INTO v4_workspaces (workspace_owner_npub, creator_npub, name, wrapped_workspace_nsec, wrapped_by_npub, default_group_id)
          VALUES (${probeWsOwnerNpub}, ${serviceNpub}, 'Migration Smoke Probe Workspace', 'smoke-probe-wrapped', ${serviceNpub}, ${probeGroupId})
        `;
        await tx`INSERT INTO v4_group_members (group_id, member_npub) VALUES (${probeGroupId}, ${serviceNpub}), (${probeGroupId}, ${memberNpub})`;
      });

      const apiReq = async (path: string, method = 'GET', body?: unknown, signer: Uint8Array = serviceSecret) => {
        const raw = body === undefined ? undefined : JSON.stringify(body);
        const url = `${apiBase}${path}`;
        return fetch(url, {
          method,
          headers: { ...(raw !== undefined ? { 'Content-Type': 'application/json' } : {}), Authorization: nip98Header(url, method, signer, raw) },
          body: raw,
          signal: AbortSignal.timeout(15_000),
        });
      };
      const journalV4Probe = async (objectId: string | undefined) => {
        if (!objectId) failSmoke('smoke_prepare_missing_id', 'prepare response missing object_id');
        const [row] = await ctx.sql<{ storage_path: string }[]>`SELECT storage_path FROM v4_storage_objects WHERE id = ${objectId!}::uuid`;
        if (!row) failSmoke('smoke_prepare_row_missing', `prepared object ${objectId} has no row`);
        await ctx.sql`
          INSERT INTO storage_migration_probes (run_id, probe_id, kind, row_id, storage_key)
          VALUES (${run.run_id}, ${randomUUID()}, 'v4', ${objectId!}, ${row!.storage_path})
        `;
        return row!.storage_path;
      };
      /** PUT through Tower's presigned upload_url, reaching the store internally when the public route is not tested. */
      const presignedPut = async (uploadUrl: string, bytes: Buffer, contentType: string, viaPublic: boolean) => {
        const parsed = new URL(uploadUrl);
        if (!parsed.searchParams.has('X-Amz-Signature')) failSmoke('smoke_upload_url_not_presigned', `upload_url is not a presigned S3 URL: ${parsed.origin}${parsed.pathname}`);
        // Internally the signed public Host is preserved so either provider verifies the signature.
        const url = viaPublic ? uploadUrl : `${storeEndpoint.replace(/\/+$/, '')}${parsed.pathname}${parsed.search}`;
        const headers: Record<string, string> = { 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength) };
        if (!viaPublic) headers.Host = parsed.host;
        const res = await fetch(url, { method: 'PUT', headers, body: bytes, signal: AbortSignal.timeout(30_000) });
        const text = await res.text();
        if (!res.ok) failSmoke('smoke_presigned_put_failed', `Presigned PUT (${viaPublic ? 'public' : 'internal'}) returned HTTP ${res.status}`, { body: text.slice(0, 300) });
      };
      const expectedOrigin = options.expectedPublicEndpoint ? new URL(options.expectedPublicEndpoint).origin : null;

      // Private object: prepare -> upload -> complete; owner, member, revocation, outsider, anonymous.
      const privBytes = Buffer.from(`nstack-smoke-private-${run.run_id}-${randomUUID()}`);
      const privSha = createHash('sha256').update(privBytes).digest('hex');
      const prepPriv = await apiReq('/api/v4/storage/prepare', 'POST', {
        owner_npub: probeWsOwnerNpub, owner_group_id: probeGroupId, access_group_ids: [probeGroupId],
        content_type: 'text/plain', file_name: 'smoke-private.txt', size_bytes: privBytes.byteLength, is_public: false,
      });
      if (!prepPriv.ok) failSmoke('smoke_prepare_private_failed', `prepare private HTTP ${prepPriv.status}`, await prepPriv.text());
      const privMeta = (await prepPriv.json()) as any;
      await journalV4Probe(privMeta.object_id);
      if (expectedOrigin && !String(privMeta.upload_url || '').startsWith(expectedOrigin + '/')) {
        failSmoke('smoke_upload_url_mismatch', `Prepared upload_url does not point at STORAGE_S3_ENDPOINT_PUBLIC origin ${expectedOrigin}.`);
      }
      await presignedPut(privMeta.upload_url, privBytes, 'text/plain', Boolean(options.checkPublicDirectPut));
      const compPriv = await apiReq(`/api/v4/storage/${privMeta.object_id}/complete`, 'POST', { sha256_hex: privSha, size_bytes: privBytes.byteLength });
      if (!compPriv.ok) failSmoke('smoke_complete_private_failed', `complete private HTTP ${compPriv.status}`, await compPriv.text());
      const readPriv = await apiReq(`/api/v4/storage/${privMeta.object_id}/content`);
      if (!readPriv.ok || !Buffer.from(await readPriv.arrayBuffer()).equals(privBytes)) failSmoke('smoke_read_private_failed', `owner private read HTTP ${readPriv.status} or bytes mismatch`);
      const memberRead = await apiReq(`/api/v4/storage/${privMeta.object_id}/content`, 'GET', undefined, memberSecret);
      if (!memberRead.ok || !Buffer.from(await memberRead.arrayBuffer()).equals(privBytes)) failSmoke('smoke_member_read_failed', `group member read HTTP ${memberRead.status} or bytes mismatch`);
      await ctx.sql`DELETE FROM v4_group_members WHERE group_id = ${probeGroupId}::uuid AND member_npub = ${memberNpub}`;
      const memberRevoked = await apiReq(`/api/v4/storage/${privMeta.object_id}/content`, 'GET', undefined, memberSecret);
      await memberRevoked.body?.cancel();
      if (memberRevoked.status !== 404 && memberRevoked.status !== 403) failSmoke('smoke_acl_revocation_failed', `Revoked member still got HTTP ${memberRevoked.status}`);
      const anonPriv = await fetch(`${apiBase}/api/v4/storage/${privMeta.object_id}/content`, { signal: AbortSignal.timeout(10_000) });
      await anonPriv.body?.cancel();
      if (anonPriv.status !== 401) failSmoke('smoke_acl_anon_not_denied', `Anonymous private read returned ${anonPriv.status}`);
      const outsiderPriv = await apiReq(`/api/v4/storage/${privMeta.object_id}/content`, 'GET', undefined, outsiderSecret);
      await outsiderPriv.body?.cancel();
      if (outsiderPriv.status !== 404 && outsiderPriv.status !== 403) failSmoke('smoke_acl_outsider_not_denied', `Outsider private read returned ${outsiderPriv.status}`);

      // Registered app: prepare -> upload -> complete -> content + HEAD -> disable -> denied.
      await ctx.sql`
        INSERT INTO workspace_apps (workspace_owner_npub, app_npub, app_name, enabled, created_by_npub)
        VALUES (${probeWsOwnerNpub}, ${appNpub}, 'nstack-migration-smoke-app', true, ${serviceNpub})
      `;
      const appBytes = Buffer.from(`nstack-smoke-reg-app-${run.run_id}`);
      const appSha = createHash('sha256').update(appBytes).digest('hex');
      const appBase = `/api/v4/workspaces/${probeWsOwnerNpub}/apps/${appNpub}/storage`;
      const appPrep = await apiReq(`${appBase}/prepare`, 'POST', { idempotency_key: randomUUID(), file_name: 'smoke-app.txt', content_type: 'text/plain', size_bytes: appBytes.byteLength, sha256_hex: appSha }, appSecret);
      if (!appPrep.ok) failSmoke('smoke_regapp_prepare_failed', `registered-app prepare HTTP ${appPrep.status}`, await appPrep.text());
      const appMeta = (await appPrep.json()) as any;
      await journalV4Probe(appMeta.object_id);
      const appUp = await apiReq(`${appBase}/objects/${appMeta.object_id}`, 'PUT', { base64_data: appBytes.toString('base64') }, appSecret);
      if (!appUp.ok) failSmoke('smoke_regapp_upload_failed', `registered-app upload HTTP ${appUp.status}`, await appUp.text());
      const appComp = await apiReq(`${appBase}/objects/${appMeta.object_id}/complete`, 'POST', { size_bytes: appBytes.byteLength, sha256_hex: appSha }, appSecret);
      if (!appComp.ok) failSmoke('smoke_regapp_complete_failed', `registered-app complete HTTP ${appComp.status}`, await appComp.text());
      const appRead = await apiReq(`${appBase}/objects/${appMeta.object_id}/content`, 'GET', undefined, appSecret);
      if (!appRead.ok || !Buffer.from(await appRead.arrayBuffer()).equals(appBytes)) failSmoke('smoke_regapp_read_failed', `registered-app content HTTP ${appRead.status} or bytes mismatch`);
      const appHead = await apiReq(`${appBase}/objects/${appMeta.object_id}/content`, 'HEAD', undefined, appSecret);
      if (!appHead.ok || appHead.headers.get('content-length') !== String(appBytes.byteLength)) failSmoke('smoke_regapp_head_failed', `registered-app HEAD HTTP ${appHead.status}`);
      await ctx.sql`UPDATE workspace_apps SET enabled = false WHERE workspace_owner_npub = ${probeWsOwnerNpub} AND app_npub = ${appNpub}`;
      const appRevoked = await apiReq(`${appBase}/objects/${appMeta.object_id}/content`, 'GET', undefined, appSecret);
      await appRevoked.body?.cancel();
      if (appRevoked.status < 400 || appRevoked.status >= 500) failSmoke('smoke_regapp_revocation_failed', `Disabled registered-app read returned HTTP ${appRevoked.status}`);

      // Public object through the API PUT path, Blossom full GET with If-Match, and Range.
      const pubBytes = Buffer.from(`nstack-smoke-public-blossom-range-${run.run_id}-${randomUUID()}`);
      const pubSha = createHash('sha256').update(pubBytes).digest('hex');
      const prepPub = await apiReq('/api/v4/storage/prepare', 'POST', { owner_npub: probeWsOwnerNpub, content_type: 'text/plain', file_name: 'smoke-public.txt', size_bytes: pubBytes.byteLength, is_public: true });
      if (!prepPub.ok) failSmoke('smoke_prepare_public_failed', `prepare public HTTP ${prepPub.status}`, await prepPub.text());
      const pubMeta = (await prepPub.json()) as any;
      await journalV4Probe(pubMeta.object_id);
      const upPub = await apiReq(`/api/v4/storage/${pubMeta.object_id}`, 'PUT', { base64_data: pubBytes.toString('base64') });
      if (!upPub.ok) failSmoke('smoke_upload_public_failed', `upload public HTTP ${upPub.status}`, await upPub.text());
      const compPub = await apiReq(`/api/v4/storage/${pubMeta.object_id}/complete`, 'POST', { sha256_hex: pubSha, size_bytes: pubBytes.byteLength });
      if (!compPub.ok) failSmoke('smoke_complete_public_failed', `complete public HTTP ${compPub.status}`, await compPub.text());
      const blossomFull = await fetch(`${apiBase}/${pubSha}`, { signal: AbortSignal.timeout(15_000) });
      if (!blossomFull.ok || !Buffer.from(await blossomFull.arrayBuffer()).equals(pubBytes)) failSmoke('smoke_blossom_get_failed', `Blossom GET HTTP ${blossomFull.status} or bytes mismatch`);
      const [pubRow] = await ctx.sql<{ sha256_verified_etag: string | null }[]>`SELECT sha256_verified_etag FROM v4_storage_objects WHERE id = ${pubMeta.object_id}::uuid`;
      if (!pubRow?.sha256_verified_etag) failSmoke('smoke_blossom_etag_not_verified', 'Blossom read did not record a verified ETag for the probe object');
      const blossomRange = await fetch(`${apiBase}/${pubSha}`, { headers: { Range: 'bytes=0-11' }, signal: AbortSignal.timeout(15_000) });
      const rangeText = await blossomRange.text();
      if (blossomRange.status !== 206 || rangeText !== 'nstack-smoke') failSmoke('smoke_blossom_range_failed', `Blossom Range returned HTTP ${blossomRange.status}`);

      // Zero-byte object through Tower's presigned upload_url.
      const zeroSha = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
      const prepZero = await apiReq('/api/v4/storage/prepare', 'POST', { owner_npub: probeWsOwnerNpub, content_type: 'application/octet-stream', file_name: 'smoke-zero.bin', size_bytes: 0, is_public: true });
      if (!prepZero.ok) failSmoke('smoke_prepare_zero_failed', `prepare zero-byte HTTP ${prepZero.status}`, await prepZero.text());
      const zeroMeta = (await prepZero.json()) as any;
      await journalV4Probe(zeroMeta.object_id);
      await presignedPut(zeroMeta.upload_url, Buffer.alloc(0), 'application/octet-stream', false);
      const compZero = await apiReq(`/api/v4/storage/${zeroMeta.object_id}/complete`, 'POST', { sha256_hex: zeroSha, size_bytes: 0 });
      if (!compZero.ok) failSmoke('smoke_complete_zero_failed', `complete zero-byte HTTP ${compZero.status}`, await compZero.text());
      const zeroContent = await fetch(`${apiBase}/api/v4/storage/${zeroMeta.object_id}/content`, { signal: AbortSignal.timeout(10_000) });
      if (!zeroContent.ok || (await zeroContent.arrayBuffer()).byteLength !== 0) failSmoke('smoke_read_zero_failed', `read zero-byte HTTP ${zeroContent.status} or non-empty`);

      // Managed storage: the API is only available with configured delegations; the blob
      // protocol (presign-equivalent write/read, unversioned physical delete) runs against
      // the active store with Tower's app identity.
      const descRes = await fetch(`${apiBase}/api/v4/managed-app-storage/descriptor`, { signal: AbortSignal.timeout(10_000) });
      await descRes.body?.cancel();
      if (descRes.status !== 200 && descRes.status !== 404) failSmoke('smoke_managed_descriptor_failed', `managed descriptor returned HTTP ${descRes.status}`);
      const managedProbeKey = `managed-app-storage/${randomUUID()}/${randomUUID()}/${randomUUID()}`;
      await ctx.sql`INSERT INTO storage_migration_probes (run_id, probe_id, kind, row_id, storage_key) VALUES (${run.run_id}, ${randomUUID()}, 'object', NULL, ${managedProbeKey})`;
      const managedBytes = Buffer.from(`nstack-smoke-managed-${run.run_id}`);
      await storeClient.send(new PutObjectCommand({ Bucket: storeBucket, Key: managedProbeKey, Body: managedBytes, ContentType: 'application/octet-stream' }));
      const managedRead = await readObjectIdentity(storeClient, storeBucket, managedProbeKey);
      if (managedRead.sha256 !== createHash('sha256').update(managedBytes).digest('hex') || managedRead.size !== managedBytes.byteLength) failSmoke('smoke_managed_read_mismatch', 'Managed blob read-back mismatch');
      const verBefore = await storeClient.send(new GetBucketVersioningCommand({ Bucket: storeBucket }));
      if (verBefore.Status || verBefore.MFADelete) failSmoke('smoke_managed_versioning_guard_failed', 'Store bucket is not unversioned');
      const delRes = await storeClient.send(new DeleteObjectCommand({ Bucket: storeBucket, Key: managedProbeKey }));
      if ((delRes.$metadata.httpStatusCode !== 204 && delRes.$metadata.httpStatusCode !== 200) || delRes.DeleteMarker || delRes.VersionId) failSmoke('smoke_managed_delete_guard_failed', `Physical delete returned status=${delRes.$metadata.httpStatusCode}`);
      try {
        await storeClient.send(new HeadObjectCommand({ Bucket: storeBucket, Key: managedProbeKey }));
        failSmoke('smoke_managed_head_after_delete_failed', 'Managed probe key still exists after physical delete');
      } catch (err: any) {
        if (err instanceof MigrationError) throw err;
        if (err?.$metadata?.httpStatusCode !== 404) throw err;
      }
      const managedDescriptorStatus = descRes.status;

      // Sample through NStack: every completed public object <= 1 MiB plus >= N larger ones;
      // private objects (user keys are not held) by authenticated read of the active store.
      const smallLimit = 1024 * 1024;
      const sampleSize = Math.max(200, options.sampleCount ?? 200);
      const probeIds = (await ctx.sql<{ row_id: string }[]>`SELECT row_id::text FROM storage_migration_probes WHERE run_id = ${run.run_id} AND kind = 'v4' AND row_id IS NOT NULL`).map((r) => r.row_id);
      const sampleRows = await ctx.sql<{ id: string; storage_path: string; sha256_hex: string | null; size_bytes: string; is_public: boolean; sha256_verified_etag: string | null }[]>`
        (SELECT id::text, storage_path, sha256_hex, size_bytes::text, is_public, sha256_verified_etag
         FROM v4_storage_objects WHERE completed_at IS NOT NULL AND size_bytes <= ${smallLimit} AND NOT (id::text = ANY(${probeIds}::text[])))
        UNION ALL
        (SELECT id::text, storage_path, sha256_hex, size_bytes::text, is_public, sha256_verified_etag
         FROM v4_storage_objects WHERE completed_at IS NOT NULL AND size_bytes > ${smallLimit} AND NOT (id::text = ANY(${probeIds}::text[]))
         ORDER BY md5(id::text || ${run.run_id}) LIMIT ${sampleSize})
      `;
      let sampledApi = 0;
      let sampledStore = 0;
      let sampledBlossom = 0;
      await runWithConcurrency(sampleRows, 4, async (row) => {
        const expectedSize = Number(row.size_bytes);
        if (row.is_public) {
          const useBlossom = Boolean(row.sha256_hex && row.sha256_verified_etag);
          const url = useBlossom ? `${apiBase}/${row.sha256_hex}` : `${apiBase}/api/v4/storage/${row.id}/content`;
          const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
          if (!res.ok) failSmoke('smoke_sample_api_failed', `Public object ${row.id} via NStack returned HTTP ${res.status}`);
          const rb = await hashBodyStream(res.body);
          if ((row.sha256_hex && rb.sha256 !== row.sha256_hex.toLowerCase()) || rb.size !== expectedSize) failSmoke('smoke_sample_api_mismatch', `Public object ${row.id} via NStack failed hash/size`);
          sampledApi++;
          if (useBlossom) sampledBlossom++;
          return;
        }
        const rb = await readObjectIdentity(storeClient, storeBucket, row.storage_path);
        if ((row.sha256_hex && rb.sha256 !== row.sha256_hex.toLowerCase()) || rb.size !== expectedSize) failSmoke('smoke_sample_store_mismatch', `Object ${row.id} failed hash/size in the active store`);
        sampledStore++;
      });

      const cleanup = await cleanupMigrationProbesUnlocked(ctx, run, store);
      const [remaining] = await ctx.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM storage_migration_probes WHERE run_id = ${run.run_id} AND cleaned_at IS NULL`;
      if (Number(remaining?.count ?? '0') > 0) failSmoke('smoke_probes_remaining', `${remaining!.count} smoke probe(s) remained uncleaned.`);

      const evidence = {
        store,
        smoke_run_id: run.run_id,
        smoke_fingerprint: run.fingerprint,
        completed_at: new Date().toISOString(),
        health_ok: true,
        private_acl_revocation_ok: true,
        registered_app_ok: true,
        public_blossom_ifmatch_range_ok: true,
        zero_byte_presigned_ok: true,
        presigned_put_route: options.checkPublicDirectPut ? 'public' : 'internal',
        managed_descriptor_status: managedDescriptorStatus,
        managed_blob_protocol_ok: true,
        sampled_via_api: sampledApi,
        sampled_via_blossom: sampledBlossom,
        sampled_via_store: sampledStore,
        probes_cleaned: cleanup.cleaned,
      };
      const [stored] = await ctx.sql<{ run_id: string }[]>`
        UPDATE storage_migration_runs SET smoke_evidence = ${jsonb(ctx.sql, evidence)}, smoke_passed_at = NOW(), updated_at = NOW()
        WHERE run_id = ${run.run_id} AND phase IN ('started', 'rolling_back')
        RETURNING run_id
      `;
      if (!stored) failSmoke('smoke_evidence_not_recorded', 'Run phase changed during smoke; evidence not recorded.');
      return { ok: true, run_id: run.run_id, ...evidence };
    } catch (err) {
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(MIGRATION_EXIT.SMOKE_FAILED, 'smoke_unexpected_error', `Smoke test failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** started -> committed, only with matching passing smoke evidence and zero uncleaned probes. */
export async function commitMigrationRun(ctx: MigrationContext) {
  return withMigrationAdvisoryLock(ctx.sql, async () => {
    const run = await getLatestMigrationRun(ctx.sql);
    if (run?.phase === 'committed') return { ok: true, run_id: run.run_id, phase: run.phase, committed_at: run.committed_at, already: true };
    if (!run || run.phase !== 'started') throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'commit_phase_denied', `commit requires phase "started"; current phase is "${run?.phase ?? 'none'}".`);
    await verifyRunFingerprint(ctx, run);
    const [uncleaned] = await ctx.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM storage_migration_probes WHERE run_id = ${run.run_id} AND cleaned_at IS NULL`;
    if (Number(uncleaned?.count ?? '0') > 0) throw new MigrationError(MIGRATION_EXIT.SMOKE_FAILED, 'uncleaned_smoke_probes', `Cannot commit: ${uncleaned!.count} smoke probe(s) remain uncleaned.`);
    const ev = run.smoke_evidence;
    if (!run.smoke_passed_at || !ev || ev.store !== 'target' || ev.smoke_run_id !== run.run_id || ev.smoke_fingerprint !== run.fingerprint) {
      throw new MigrationError(MIGRATION_EXIT.SMOKE_FAILED, 'smoke_not_verified', `Cannot commit run ${run.run_id}: no passing target smoke evidence for this run and fingerprint.`);
    }
    const [updated] = await ctx.sql<MigrationRunRow[]>`
      UPDATE storage_migration_runs SET phase = 'committed', committed_at = NOW(), updated_at = NOW()
      WHERE run_id = ${run.run_id} AND phase = 'started'
      RETURNING *
    `;
    if (!updated) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', 'Failed to commit run.');
    return { ok: true, run_id: updated.run_id, phase: updated.phase, committed_at: updated.committed_at, already: false };
  });
}

/**
 * RB2 reverse migration data step (§8), with NStack stopped and both stores fenced:
 * the source (MinIO) receives every currently eligible object whose bytes it does not
 * already hold, managed rows deleted after start_intent are deleted from it, and v4
 * verified ETags are made to match the source (exact original when the object is
 * unchanged, the new source ETag for reverse-copied bytes, otherwise NULL so the next
 * read re-verifies the hash). Bytes are checked against DB identity; nothing is
 * marked rolled back until the host restarted NStack and smoke passed.
 */
export async function runReverseMigrateSync(ctx: MigrationContext, options: { concurrency?: number } = {}) {
  return withMigrationAdvisoryLock(ctx.sql, () => transientAsResumable('reverse_transient_io', async () => {
    let run = await getLatestMigrationRun(ctx.sql);
    const resumable = run?.phase === 'rolling_back' && run.rollback_from_phase !== null && POST_WRITE_PHASES.includes(run.rollback_from_phase);
    if (!run || (!POST_WRITE_PHASES.includes(run.phase) && !resumable)) {
      throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'reverse_migrate_phase_denied', `--reverse-migrate requires start_intent, started or committed (or an interrupted RB2); current phase is "${run?.phase ?? 'none'}".`);
    }
    const sourceClient = getSourceClient(ctx);
    const targetClient = getTargetClient(ctx);
    try {
      await targetClient.send(new HeadBucketCommand({ Bucket: ctx.target.bucket }));
    } catch {
      throw new MigrationError(MIGRATION_EXIT.INTEGRITY_MISMATCH, 'rb2_target_unreadable', 'RB2-lost: the target store is unreadable, so reverse migration is impossible. Run status for the at-risk object IDs.');
    }
    await verifyRunFingerprint(ctx, run);
    const srcVer = await sourceClient.send(new GetBucketVersioningCommand({ Bucket: ctx.source.bucket }));
    if (srcVer.Status || srcVer.MFADelete) throw new MigrationError(MIGRATION_EXIT.PREFLIGHT_BLOCK, 'reverse_dest_versioned', 'Source bucket is versioned; refusing reverse migration.');

    if (!resumable) {
      const [moved] = await ctx.sql<MigrationRunRow[]>`
        UPDATE storage_migration_runs
        SET phase = 'rolling_back', rollback_from_phase = ${run.phase}, rolling_back_at = NOW(), smoke_evidence = NULL, smoke_passed_at = NULL,
            last_evidence = ${jsonb(ctx.sql, { rb2_from_phase: run.phase })}, updated_at = NOW()
        WHERE run_id = ${run.run_id} AND phase = ${run.phase}
        RETURNING *
      `;
      if (!moved) throw new MigrationError(MIGRATION_EXIT.PHASE_DENIED, 'phase_cas_failed', 'Concurrent phase change detected.');
      run = moved;
    }
    const boundaryAt = run.start_intent_at ?? run.rolling_back_at ?? new Date();

    const targetListing = await listAllBucketKeys(targetClient, ctx.target.bucket);
    const sourceListing = await listAllBucketKeys(sourceClient, ctx.source.bucket);
    const inventory = await loadEligibleObjectsFromDb(ctx.sql, targetListing);
    const journalRows = await ctx.sql<JournalRow[]>`SELECT * FROM storage_migration_objects WHERE run_id = ${run.run_id}`;
    const journalMap = new Map(journalRows.map((r) => [r.storage_key, r]));
    const limiter = new BandwidthLimiter(0);
    const sourceEtagByKey = new Map<string, string | null>();
    const missingFromTarget: Array<{ kind: string; object_id: string }> = [];
    let reverseCopied = 0;
    let unchanged = 0;

    await runWithConcurrency(inventory.eligible, options.concurrency ?? 4, async (item) => {
      const tgt = targetListing.get(item.storageKey);
      if (!tgt) {
        if (item.acknowledged) missingFromTarget.push({ kind: item.kind, object_id: item.objectId });
        return;
      }
      const j = journalMap.get(item.storageKey);
      const src = sourceListing.get(item.storageKey);
      // Unchanged in the target since the fence: the source should still hold exactly the
      // journalled bytes. Prove it with a full read (no ETag shortcut); otherwise copy back.
      const journalCandidate = Boolean(
        j && ['verified', 'switched', 'reverted'].includes(j.state) && src && tgt.etag === j.dst_etag && Number(j.size_bytes) === tgt.size
        && !identityMismatch(item, j.sha256_hex, Number(j.size_bytes)),
      );
      if (journalCandidate) {
        const rb = await readObjectIdentity(sourceClient, ctx.source.bucket, item.storageKey);
        const expectedAttrs: ObjectAttributes = { contentType: j!.content_type || 'application/octet-stream', metadata: normalizeStringMap(j!.custom_metadata), headers: normalizeStringMap(j!.object_headers) };
        if (rb.sha256 === j!.sha256_hex && rb.size === Number(j!.size_bytes) && attributesEqual(rb.attrs, expectedAttrs)) {
          sourceEtagByKey.set(item.storageKey, rb.etag);
          unchanged++;
          return;
        }
      }
      // Copy back from the target; read-back on the source is verified against the bytes read
      // from the target, and those against DB identity (or, for incomplete rows, the journal
      // when the row is unchanged since the fence).
      const copy = await copyAndVerifySingleObject(targetClient, ctx.target.bucket, sourceClient, ctx.source.bucket, item.storageKey, limiter);
      const mismatch = identityMismatch(item, copy.sha256, copy.size);
      if (mismatch) {
        throw new MigrationError(MIGRATION_EXIT.INTEGRITY_MISMATCH, 'reverse_identity_mismatch', `Object ${item.objectId} in the target does not match its DB identity (${mismatch}); reverse migration stopped.`, { object_id: item.objectId, kind: item.kind });
      }
      sourceEtagByKey.set(item.storageKey, copy.dstEtag);
      reverseCopied++;
    });
    if (missingFromTarget.length) {
      throw new MigrationError(MIGRATION_EXIT.INTEGRITY_MISMATCH, 'reverse_target_missing', `${missingFromTarget.length} acknowledged object(s) are missing from the target; reverse migration stopped (RB2-lost for these IDs).`, { missing: missingFromTarget.slice(0, 1000) });
    }

    // Managed rows that were live at the fence (journalled) or created after the boundary and are now deleted.
    let reverseDeleted = 0;
    if (await tableExists(ctx.sql, 'managed_app_storage_objects')) {
      const deleted = await ctx.sql<ManagedStorageObject[]>`
        SELECT * FROM managed_app_storage_objects WHERE deletion_job IS NOT NULL OR physical_absent = true
      `;
      for (const row of deleted) {
        const key = objectKey(row);
        const j = journalMap.get(key);
        const liveAtFence = j && ['verified', 'switched', 'reverted', 'copied'].includes(j.state);
        if (!liveAtFence && !(row.created_at >= boundaryAt)) continue;
        if (sourceListing.has(key)) {
          await sourceClient.send(new DeleteObjectCommand({ Bucket: ctx.source.bucket, Key: key }));
          reverseDeleted++;
        }
      }
    }

    // Every verified v4 ETag becomes the source's actual HEAD ETag for bytes verified above
    // (exactly the original for unchanged objects); NULL stays NULL; hashes and sizes are untouched.
    let etagsRestored = 0;
    let etagsUpdated = 0;
    await ctx.sql.begin(async (tx) => {
      const rows = await tx<{ id: string; storage_path: string; sha256_verified_etag: string }[]>`
        SELECT id::text, storage_path, sha256_verified_etag FROM v4_storage_objects
        WHERE completed_at IS NOT NULL AND sha256_verified_etag IS NOT NULL
      `;
      for (const row of rows) {
        const next = sourceEtagByKey.get(row.storage_path);
        if (!next) {
          throw new MigrationError(MIGRATION_EXIT.INTEGRITY_MISMATCH, 'reverse_etag_unverified', `Completed object ${row.id} has a verified ETag but its source bytes were not verified; reverse migration stopped.`, { object_id: row.id });
        }
        const j = journalMap.get(row.storage_path);
        if (j?.original_verified_etag && next === j.original_verified_etag) etagsRestored++;
        else etagsUpdated++;
        if (next !== row.sha256_verified_etag) {
          await tx`UPDATE v4_storage_objects SET sha256_verified_etag = ${next} WHERE id = ${row.id}::uuid AND sha256_verified_etag = ${row.sha256_verified_etag}`;
        }
      }
      await tx`UPDATE storage_migration_objects SET state = 'reverted', updated_at = NOW() WHERE run_id = ${run!.run_id} AND state = 'switched'`;
      const evidence = {
        ...normalizeEvidence(run!.last_evidence),
        rb2_reverse_synced: true,
        rb2_reverse_copied: reverseCopied,
        rb2_unchanged: unchanged,
        rb2_reverse_deleted: reverseDeleted,
        rb2_etags_restored: etagsRestored,
        rb2_etags_updated: etagsUpdated,
      };
      await tx`UPDATE storage_migration_runs SET last_evidence = ${jsonb(ctx.sql, evidence)}, updated_at = NOW() WHERE run_id = ${run!.run_id}`;
    });

    return { ok: true, run_id: run.run_id, phase: 'rolling_back', rollback_from_phase: run.rollback_from_phase, reverse_copied: reverseCopied, unchanged, reverse_deleted: reverseDeleted, etags_restored: etagsRestored, etags_updated: etagsUpdated };
  }));
}

function rollbackBoundaryForPhase(run: MigrationRunRow | null): 'RB0' | 'RB1' | 'RB2' | 'RB3' | 'none' {
  if (!run) return 'RB0';
  const phase = run.phase;
  if (phase === 'planned' || phase === 'precopied') return 'RB0';
  if (QUIESCED_PHASES.includes(phase)) return 'RB1';
  if (phase === 'rolling_back') return run.rollback_from_phase && POST_WRITE_PHASES.includes(run.rollback_from_phase) ? 'RB2' : 'RB1';
  if (phase === 'source_retired') return 'RB3';
  if (POST_WRITE_PHASES.includes(phase)) return 'RB2';
  return 'none';
}

function nextLegalCommandForPhase(run: MigrationRunRow | null): string {
  switch (run?.phase ?? null) {
    case null:
    case 'rolled_back':
    case 'aborted_restore':
      return 'preflight | precopy';
    case 'planned':
      return 'precopy';
    case 'precopied':
      return 'precopy | cutover | rollback (RB0)';
    case 'start_intent':
    case 'started':
      return 'cutover --resume | rollback --reverse-migrate (RB2)';
    case 'committed':
      return 'verify --standalone | rollback --reverse-migrate (RB2) | retire-source (after retention)';
    case 'rolling_back':
      return rollbackBoundaryForPhase(run) === 'RB2' ? 'rollback --reverse-migrate (resume RB2)' : 'rollback (resume RB1)';
    case 'source_retired':
      return 'verify --standalone';
    default:
      return 'cutover --resume | rollback (RB1)';
  }
}

/**
 * Read-only status: phase, counts, uncleaned probes, rollback boundary, next legal
 * command. When the target is unreadable at or after start_intent, lists rows written
 * since start_intent as AT RISK (they may still exist in a later backup); it does not
 * claim they are lost.
 */
export async function getMigrationStatus(ctx: MigrationContext, options: { checkTargetReadable?: boolean } = {}) {
  const run = await getLatestMigrationRun(ctx.sql);
  if (!run) return { ok: true, has_run: false, phase: null, rollback_boundary: 'RB0', next_legal_command: nextLegalCommandForPhase(null) };
  const stateCounts = await ctx.sql<{ state: string; count: string }[]>`
    SELECT state, count(*)::text AS count FROM storage_migration_objects WHERE run_id = ${run.run_id} GROUP BY state
  `;
  const countsByState: Record<string, number> = {};
  for (const r of stateCounts) countsByState[r.state] = Number(r.count);
  const uncleanedProbes = await ctx.sql<{ probe_id: string; kind: string; row_id: string | null; storage_key: string | null }[]>`
    SELECT probe_id::text, kind, row_id::text, storage_key FROM storage_migration_probes WHERE run_id = ${run.run_id} AND cleaned_at IS NULL
  `;
  const boundary = rollbackBoundaryForPhase(run);
  let targetReadable: boolean | null = null;
  let atRisk: { since: Date; v4: string[]; managed: string[]; note: string } | null = null;
  if (options.checkTargetReadable && (boundary === 'RB2' || boundary === 'RB3')) {
    try {
      await getTargetClient(ctx).send(new HeadBucketCommand({ Bucket: ctx.target.bucket }));
      targetReadable = true;
    } catch {
      targetReadable = false;
      const since = run.start_intent_at ?? run.created_at;
      const v4 = await ctx.sql<{ id: string }[]>`SELECT id::text FROM v4_storage_objects WHERE created_at >= ${since} OR completed_at >= ${since} ORDER BY id`;
      const managed = (await tableExists(ctx.sql, 'managed_app_storage_objects'))
        ? await ctx.sql<{ id: string }[]>`SELECT id::text FROM managed_app_storage_objects WHERE created_at >= ${since} OR verified_at >= ${since} ORDER BY id`
        : [];
      atRisk = {
        since,
        v4: v4.map((r) => r.id),
        managed: managed.map((r) => r.id),
        note: 'Rows written since start_intent whose bytes only the unreadable target held. Recover by object ID from the latest readable backup; IDs found there are not lost.',
      };
    }
  }
  return {
    ok: true,
    has_run: true,
    run_id: run.run_id,
    phase: run.phase,
    rollback_from_phase: run.rollback_from_phase,
    fingerprint: run.fingerprint,
    fingerprint_details: normalizeEvidence(run.fingerprint_details),
    source_provider: run.source_provider,
    target_provider: run.target_provider,
    target_sentinel_id: run.target_sentinel_id,
    source_boot_id: run.source_boot_id,
    target_boot_id: run.target_boot_id,
    fence_identity: run.fence_identity,
    old_config_digest: run.old_config_digest,
    new_config_digest: run.new_config_digest,
    verified_backup_dir: run.verified_backup_dir,
    backup_manifest_sha256: run.backup_manifest_sha256,
    smoke_passed_at: run.smoke_passed_at,
    smoke_evidence: run.smoke_evidence,
    last_evidence: normalizeEvidence(run.last_evidence),
    timestamps: {
      created_at: run.created_at,
      updated_at: run.updated_at,
      source_fenced_at: run.source_fenced_at,
      backed_up_at: run.backed_up_at,
      start_intent_at: run.start_intent_at,
      started_at: run.started_at,
      committed_at: run.committed_at,
      rolling_back_at: run.rolling_back_at,
      rolled_back_at: run.rolled_back_at,
      source_retired_at: run.source_retired_at,
    },
    object_counts_by_state: countsByState,
    uncleaned_probes: uncleanedProbes,
    rollback_boundary: targetReadable === false ? 'RB2-lost' : boundary,
    target_readable: targetReadable,
    rb2_at_risk: atRisk,
    next_legal_command: nextLegalCommandForPhase(run),
  };
}
