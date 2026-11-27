import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { objectKey } from '../src/managed-storage/ledger';
import { STORAGE_SENTINEL_KEY } from '../src/services/storage-startup-guard';
import {
  beginRollbackRb1,
  commitMigrationRun,
  finishMigrationRollback,
  getMigrationStatus,
  markMigrationPhase,
  MIGRATION_EXIT,
  prepareMigrationSwitch,
  resetMigrationSnapshot,
  rewriteMigrationEtags,
  runMigrationDelta,
  runMigrationPrecopy,
  runMigrationPreflight,
  runMigrationVerify,
  runReverseMigrateSync,
  withMigrationAdvisoryLock,
  type MigrationContext,
} from '../src/services/storage-migration';
import { buildMigrationContext } from '../src/scripts/migrate-storage';

const TEST_DB = 'tower_test_storage_migration';
const svcSecret = new Uint8Array(32).fill(77);
const svcNsec = nip19.nsecEncode(svcSecret);
const svcNpub = nip19.npubEncode(getPublicKey(svcSecret));
const ownerNpub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(88)));
const appNpub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(99)));
const sha256 = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

interface MockObject {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
  headers: Record<string, string>;
  etag: string;
  contentEncoding?: string;
  tags?: Array<{ Key: string; Value: string }>;
}

function notFound(name: string) {
  const e: any = new Error(name);
  e.name = name;
  e.$metadata = { httpStatusCode: 404 };
  return e;
}

/** In-memory S3 with paginated listings, object headers and multipart-upload listings. */
class InMemoryS3 {
  versioningStatus: string | undefined;
  objects = new Map<string, MockObject>();
  multipartUploads: Array<{ Key: string; UploadId: string }> = [];
  pageSize = 3;
  counter = 0;
  reachable = true;
  constructor(readonly etagPrefix: string) {}

  put(key: string, body: Buffer | string, opts: { contentType?: string; metadata?: Record<string, string>; headers?: Record<string, string>; etag?: string; contentEncoding?: string; tags?: Array<{ Key: string; Value: string }> } = {}) {
    const buf = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
    const etag = opts.etag ?? `"${this.etagPrefix}-${++this.counter}-${sha256(buf).slice(0, 12)}"`;
    this.objects.set(key, { body: buf, contentType: opts.contentType || 'application/octet-stream', metadata: { ...(opts.metadata || {}) }, headers: { ...(opts.headers || {}) }, etag, contentEncoding: opts.contentEncoding, tags: opts.tags });
    return etag;
  }

  client() {
    const self = this;
    return {
      async send(cmd: any): Promise<any> {
        const name = cmd.constructor.name;
        const input = cmd.input;
        if (!self.reachable) {
          const e: any = new Error('connect ECONNREFUSED');
          e.code = 'ECONNREFUSED';
          throw e;
        }
        switch (name) {
          case 'HeadBucketCommand': return { $metadata: { httpStatusCode: 200 } };
          case 'GetBucketVersioningCommand': return { $metadata: { httpStatusCode: 200 }, Status: self.versioningStatus };
          case 'GetObjectLockConfigurationCommand': throw notFound('ObjectLockConfigurationNotFoundError');
          case 'GetBucketEncryptionCommand': throw notFound('ServerSideEncryptionConfigurationNotFoundError');
          case 'GetBucketLifecycleConfigurationCommand': throw notFound('NoSuchLifecycleConfiguration');
          case 'GetBucketReplicationCommand': throw notFound('ReplicationConfigurationNotFoundError');
          case 'ListMultipartUploadsCommand': {
            const startIdx = input.KeyMarker ? self.multipartUploads.findIndex((u) => u.Key === input.KeyMarker && u.UploadId === input.UploadIdMarker) + 1 : 0;
            const page = self.multipartUploads.slice(startIdx, startIdx + 2);
            const truncated = startIdx + 2 < self.multipartUploads.length;
            return { Uploads: page, IsTruncated: truncated, NextKeyMarker: truncated ? page.at(-1)!.Key : undefined, NextUploadIdMarker: truncated ? page.at(-1)!.UploadId : undefined };
          }
          case 'ListObjectsV2Command': {
            const keys = [...self.objects.keys()].sort();
            const startIdx = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
            const page = keys.slice(startIdx, startIdx + self.pageSize);
            const truncated = startIdx + self.pageSize < keys.length;
            return { Contents: page.map((Key) => ({ Key, Size: self.objects.get(Key)!.body.byteLength, ETag: self.objects.get(Key)!.etag })), IsTruncated: truncated, NextContinuationToken: truncated ? String(startIdx + self.pageSize) : undefined };
          }
          case 'HeadObjectCommand': {
            const obj = self.objects.get(input.Key);
            if (!obj) throw notFound('NotFound');
            return {
              $metadata: { httpStatusCode: 200 }, ContentLength: obj.body.byteLength, ContentType: obj.contentType, Metadata: obj.metadata, ETag: obj.etag, ContentEncoding: obj.contentEncoding,
              CacheControl: obj.headers['cache-control'], ContentDisposition: obj.headers['content-disposition'], ContentLanguage: obj.headers['content-language'],
              ...(obj.headers.expires ? { Expires: new Date(obj.headers.expires), ExpiresString: obj.headers.expires } : {}),
            };
          }
          case 'GetObjectTaggingCommand': return { TagSet: self.objects.get(input.Key)?.tags ?? [] };
          case 'GetObjectCommand': {
            const obj = self.objects.get(input.Key);
            if (!obj) throw notFound('NoSuchKey');
            async function* stream() { if (obj!.body.byteLength > 0) yield obj!.body; }
            return { $metadata: { httpStatusCode: 200 }, ContentLength: obj.body.byteLength, ContentType: obj.contentType, Metadata: obj.metadata, ETag: obj.etag, Body: Object.assign(stream(), { transformToByteArray: async () => new Uint8Array(obj.body) }) };
          }
          case 'PutObjectCommand': {
            const headers: Record<string, string> = {};
            if (input.CacheControl) headers['cache-control'] = input.CacheControl;
            if (input.ContentDisposition) headers['content-disposition'] = input.ContentDisposition;
            if (input.ContentLanguage) headers['content-language'] = input.ContentLanguage;
            if (input.Expires) headers.expires = new Date(input.Expires).toUTCString();
            const etag = self.put(input.Key, Buffer.from(input.Body ?? Buffer.alloc(0)), { contentType: input.ContentType, metadata: input.Metadata, headers });
            return { $metadata: { httpStatusCode: 200 }, ETag: etag };
          }
          case 'DeleteObjectCommand':
            self.objects.delete(input.Key);
            return { $metadata: { httpStatusCode: 204 } };
          default:
            throw new Error(`Unsupported mock S3 command: ${name}`);
        }
      },
    };
  }
}

let sql: ReturnType<typeof postgres>;
let source: InMemoryS3;
let target: InMemoryS3;

function makeCtx(overrides: Partial<MigrationContext> = {}): MigrationContext {
  return {
    sql,
    serviceNpub: svcNpub,
    serviceNsec: svcNsec,
    source: { provider: 'minio', endpoint: 'http://minio:9000', region: 'us-east-1', bucket: 'superbased-storage', accessKey: 'minio-ak', secretKey: 'minio-sk', forcePathStyle: true },
    target: { provider: 'seaweedfs', endpoint: 'http://seaweedfs:8333', region: 'us-east-1', bucket: 'superbased-storage', accessKey: 'sfs-ak', secretKey: 'sfs-sk', forcePathStyle: true },
    sourceIdentity: 'minio:test:test-minio-vol',
    sourceClient: source.client(),
    targetClient: target.client(),
    ...overrides,
  };
}

function seedTargetSentinel(store: InMemoryS3, sentinelId = 'sentinel-unit-12345678') {
  store.put(STORAGE_SENTINEL_KEY, JSON.stringify({ version: 1, provider: 'seaweedfs', sentinel_id: sentinelId, bucket: 'superbased-storage', created_at: new Date().toISOString() }) + '\n', { contentType: 'application/json' });
}

async function insertV4(opts: { key?: string; bytes: Buffer; completed: boolean; etag?: string | null; declaredSize?: number; isPublic?: boolean; sha?: string | null; createdAt?: Date }) {
  const id = randomUUID();
  const key = opts.key ?? `v4/${ownerNpub}/${id}-obj.bin`;
  await sql`
    INSERT INTO v4_storage_objects (id, owner_npub, created_by_npub, storage_path, content_type, size_bytes, sha256_hex, sha256_verified_etag, completed_at, is_public, created_at)
    VALUES (${id}, ${ownerNpub}, ${ownerNpub}, ${key}, 'application/octet-stream', ${opts.declaredSize ?? opts.bytes.byteLength},
      ${opts.completed ? (opts.sha === undefined ? sha256(opts.bytes) : opts.sha) : null}, ${opts.etag ?? null}, ${opts.completed ? new Date() : null}, ${opts.isPublic ?? false}, ${opts.createdAt ?? new Date()})
  `;
  return { id, key };
}

async function insertManaged(bytes: Buffer, state: 'complete' | 'uploaded' = 'complete') {
  const row = { workspace_id: randomUUID(), delegation_id: randomUUID(), id: randomUUID() };
  await sql`
    INSERT INTO managed_app_storage_objects (id, workspace_id, delegation_id, installation_id, app_id, app_npub, idempotency_key, sha256_hex, size_bytes, state, physical_absent, publisher_receipt, receipt_bytes)
    VALUES (${row.id}, ${row.workspace_id}, ${row.delegation_id}, 'inst1', 'app1', ${appNpub}, ${randomUUID()}, ${sha256(bytes)}, ${bytes.byteLength}, ${state}, false, '{}'::jsonb, 2)
  `;
  return { id: row.id, key: objectKey(row as any) };
}

const fenceIdentity = { project: 'test', minio: { id: 'm1', name: 'minio', started_at: 't0', volume: 'test-minio-vol', image: 'img' }, tower: null };

async function advanceToVerified(ctx: MigrationContext) {
  await runMigrationPrecopy(ctx, { runId: randomUUID() });
  await markMigrationPhase(ctx, { phase: 'source_fenced', sourceBootId: 'boot-1', fenceIdentity });
  await markMigrationPhase(ctx, { phase: 'backed_up', verifiedBackupDir: '/backups/window', backupManifestSha256: digestA });
  await runMigrationDelta(ctx);
  return runMigrationVerify(ctx, { targetBootId: 'sfs-boot-1' });
}

async function expectExit(promise: Promise<unknown>, exitCode: number, code?: string) {
  try {
    await promise;
  } catch (err: any) {
    expect(err.exitCode).toBe(exitCode);
    if (code) expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected exit ${exitCode}`);
}

beforeAll(async () => {
  const opts = { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), username: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres' };
  const admin = postgres({ ...opts, database: 'postgres' });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  sql = postgres({ ...opts, database: TEST_DB, onnotice: () => {} });
  setDb(sql);
  for (const stmt of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await sql.unsafe(stmt);
  await ensureRuntimeSchema();
});

beforeEach(async () => {
  await sql`DELETE FROM storage_migration_probes`;
  await sql`DELETE FROM storage_migration_objects`;
  await sql`DELETE FROM storage_migration_runs`;
  await sql`DELETE FROM managed_app_storage_objects`;
  await sql`DELETE FROM v4_storage_objects`;
  source = new InMemoryS3('minio');
  target = new InMemoryS3('sfs');
  seedTargetSentinel(target);
});

afterAll(async () => {
  if (sql) await sql.end();
});

describe('E4 storage-migration engine', () => {
  test('preflight writes nothing, paginates listings and multipart uploads, and refuses unsupported features', async () => {
    for (let i = 0; i < 7; i++) {
      const bytes = Buffer.from(`obj-${i}`);
      const { key } = await insertV4({ bytes, completed: true });
      source.put(key, bytes);
    }
    source.multipartUploads = [1, 2, 3, 4, 5].map((n) => ({ Key: `v4/mpu-${n}`, UploadId: `u${n}` }));
    const ctx = makeCtx();
    const before = await sql`SELECT count(*)::int AS n FROM storage_migration_runs`;
    const out = await runMigrationPreflight(ctx, { diskFreeBytes: 10_000_000 });
    expect(out.counts.eligible_present_at_source).toBe(7);
    expect(out.source_features.incomplete_multipart_uploads).toBe(5);
    expect((await sql`SELECT count(*)::int AS n FROM storage_migration_runs`)[0]!.n).toBe(before[0]!.n);
    expect(target.objects.size).toBe(1);

    await expectExit(runMigrationPreflight(ctx, { diskFreeBytes: 1 }), MIGRATION_EXIT.PREFLIGHT_BLOCK, 'insufficient_disk_space');
    const tagged = await insertV4({ bytes: Buffer.from('tagged'), completed: true });
    source.put(tagged.key, 'tagged', { tags: [{ Key: 'k', Value: 'v' }] });
    await expectExit(runMigrationPreflight(makeCtx()), MIGRATION_EXIT.PREFLIGHT_BLOCK, 'source_object_tags_unsupported');
    source.put(tagged.key, 'tagged', { contentEncoding: 'gzip' });
    await expectExit(runMigrationPreflight(makeCtx()), MIGRATION_EXIT.PREFLIGHT_BLOCK, 'source_object_unsupported_feature');
    source.objects.delete(tagged.key);
    source.versioningStatus = 'Enabled';
    await expectExit(runMigrationPreflight(makeCtx()), MIGRATION_EXIT.PREFLIGHT_BLOCK, 'source_bucket_versioned');
  });

  test('journal JSON columns are real JSONB objects that SQL can merge (no string scalars)', async () => {
    const bytes = Buffer.from('json-probe');
    const { key } = await insertV4({ bytes, completed: true, etag: '"orig"' });
    source.put(key, bytes, { metadata: { owner: 'x' }, headers: { 'cache-control': 'max-age=60' } });
    const ctx = makeCtx();
    await advanceToVerified(ctx);
    const [run] = await sql`
      SELECT jsonb_typeof(fingerprint_details) AS fd, jsonb_typeof(last_evidence) AS le, jsonb_typeof(fence_identity) AS fi,
             last_evidence ? 'verified_count' AS has_key
      FROM storage_migration_runs
    `;
    expect(run).toMatchObject({ fd: 'object', le: 'object', fi: 'object', has_key: true });
    const [obj] = await sql`SELECT jsonb_typeof(custom_metadata) AS cm, jsonb_typeof(object_headers) AS oh, custom_metadata->>'owner' AS owner, object_headers->>'cache-control' AS cc FROM storage_migration_objects`;
    expect(obj).toMatchObject({ cm: 'object', oh: 'object', owner: 'x', cc: 'max-age=60' });
    const [merged] = await sql`
      UPDATE storage_migration_runs SET last_evidence = jsonb_set(last_evidence, '{probe}', 'true'::jsonb) || ${sql.json({ more: 1 })}
      RETURNING jsonb_typeof(last_evidence) AS t, last_evidence->>'probe' AS probe, last_evidence->>'more' AS more
    `;
    expect(merged).toMatchObject({ t: 'object', probe: 'true', more: '1' });
    // A string scalar would violate the table CHECK constraint.
    await expect(sql`UPDATE storage_migration_runs SET last_evidence = ${JSON.stringify({ x: 1 })}::jsonb`).rejects.toThrow();
  });

  test('full cutover: purge, identity preservation, header parity, exact ETag rewrite, smoke-gated commit and RB1 refusal after start_intent', async () => {
    const compBytes = Buffer.from('completed-object-bytes');
    const comp = await insertV4({ bytes: compBytes, completed: true, isPublic: true, etag: 'placeholder' });
    const compEtag = source.put(comp.key, compBytes, { contentType: 'text/plain', metadata: { 'x-custom': 'val1' }, headers: { 'content-disposition': 'attachment; filename="a.txt"', 'cache-control': 'no-cache', 'content-language': 'en', expires: 'Wed, 21 Oct 2037 07:28:00 GMT' } });
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = ${compEtag}, content_type = 'text/plain' WHERE id = ${comp.id}`;
    const nullEtagBytes = Buffer.from('null-etag');
    const nullEtag = await insertV4({ bytes: nullEtagBytes, completed: true });
    source.put(nullEtag.key, nullEtagBytes);
    const zero = await insertV4({ bytes: Buffer.alloc(0), completed: true, isPublic: true });
    const zeroEtag = source.put(zero.key, Buffer.alloc(0));
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = ${zeroEtag} WHERE id = ${zero.id}`;
    const incBytes = Buffer.from('actual-15-bytes');
    const inc = await insertV4({ bytes: incBytes, completed: false, declaredSize: 500 });
    source.put(inc.key, incBytes);
    const incNoBytes = await insertV4({ bytes: Buffer.from('never'), completed: false });
    const mDel = await insertManaged(Buffer.from('managed-will-delete'));
    source.put(mDel.key, 'managed-will-delete');
    const mKeep = await insertManaged(Buffer.from('managed-keep'));
    source.put(mKeep.key, 'managed-keep');
    source.put('v4/orphan/do-not-copy.bin', 'orphan');

    const ctx = makeCtx();
    const pre = await runMigrationPrecopy(ctx, { runId: randomUUID() });
    expect(pre.copied).toBe(6);
    expect(target.objects.has('v4/orphan/do-not-copy.bin')).toBe(false);
    expect(target.objects.has(incNoBytes.key)).toBe(false);

    // Deletion during precopy: the run-owned copy is purged at the window even though MinIO keeps the bytes.
    await sql`UPDATE managed_app_storage_objects SET deletion_job = ${randomUUID()} WHERE id = ${mDel.id}`;
    await expectExit(markMigrationPhase(ctx, { phase: 'source_fenced', sourceBootId: 'b' }), MIGRATION_EXIT.USAGE, 'fence_identity_required');
    await markMigrationPhase(ctx, { phase: 'source_fenced', sourceBootId: 'boot-1', fenceIdentity });
    await markMigrationPhase(ctx, { phase: 'backed_up', verifiedBackupDir: '/b', backupManifestSha256: digestA });
    const delta = await runMigrationDelta(ctx);
    expect(delta.purged_ineligible).toBe(1);
    expect(target.objects.has(mDel.key)).toBe(false);
    expect(source.objects.has(mDel.key)).toBe(true);

    const verified = await runMigrationVerify(ctx, { targetBootId: 'sfs-boot-1' });
    expect(verified.verified_count).toBe(5);
    const copiedComp = target.objects.get(comp.key)!;
    expect(copiedComp.headers).toEqual(source.objects.get(comp.key)!.headers);
    expect(copiedComp.metadata).toEqual({ 'x-custom': 'val1' });

    await expectExit(prepareMigrationSwitch(ctx, { oldConfigDigest: digestA, newConfigDigest: digestA }), MIGRATION_EXIT.USAGE, 'invalid_config_digests');
    await prepareMigrationSwitch(ctx, { oldConfigDigest: digestA, newConfigDigest: digestB });
    const rewrite = await rewriteMigrationEtags(ctx);
    expect(rewrite.rewritten_count).toBe(2);
    const rows = await sql`SELECT id::text, sha256_hex, size_bytes::int AS size, sha256_verified_etag FROM v4_storage_objects`;
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    expect(byId.get(comp.id).sha256_verified_etag).toBe(target.objects.get(comp.key)!.etag);
    expect(byId.get(nullEtag.id).sha256_verified_etag).toBeNull();
    expect(byId.get(inc.id)).toMatchObject({ sha256_hex: null, size: 500, sha256_verified_etag: null });
    expect(byId.get(zero.id).size).toBe(0);

    await expectExit(markMigrationPhase(ctx, { phase: 'config_switched', configDigest: digestA }), MIGRATION_EXIT.FENCE_OR_BACKUP, 'config_digest_mismatch');
    await markMigrationPhase(ctx, { phase: 'config_switched', configDigest: digestB });
    await markMigrationPhase(ctx, { phase: 'start_intent' });
    await expectExit(beginRollbackRb1(ctx), MIGRATION_EXIT.ROLLBACK_REFUSED);
    await markMigrationPhase(ctx, { phase: 'started' });
    await expectExit(commitMigrationRun(ctx), MIGRATION_EXIT.SMOKE_FAILED, 'smoke_not_verified');
    const [run] = await sql`SELECT run_id::text, fingerprint FROM storage_migration_runs`;
    await sql`UPDATE storage_migration_runs SET smoke_passed_at = NOW(), smoke_evidence = ${sql.json({ store: 'source', smoke_run_id: run!.run_id, smoke_fingerprint: run!.fingerprint })}`;
    await expectExit(commitMigrationRun(ctx), MIGRATION_EXIT.SMOKE_FAILED, 'smoke_not_verified');
    await sql`UPDATE storage_migration_runs SET smoke_evidence = ${sql.json({ store: 'target', smoke_run_id: run!.run_id, smoke_fingerprint: run!.fingerprint })}`;
    expect((await commitMigrationRun(ctx)).phase).toBe('committed');
    expect((await commitMigrationRun(ctx)).already).toBe(true);
  });

  test('every mutator refuses a fingerprint mismatch (other database identity, source or target)', async () => {
    const bytes = Buffer.from('fp');
    const { key } = await insertV4({ bytes, completed: true });
    source.put(key, bytes);
    await runMigrationPrecopy(makeCtx(), { runId: randomUUID() });
    const other = makeCtx({ sourceIdentity: 'minio:test:other-volume' });
    await expectExit(markMigrationPhase(other, { phase: 'source_fenced', sourceBootId: 'b', fenceIdentity }), MIGRATION_EXIT.PREFLIGHT_BLOCK, 'fingerprint_mismatch');
    await expectExit(runMigrationPrecopy(other), MIGRATION_EXIT.PREFLIGHT_BLOCK, 'fingerprint_mismatch');
    seedTargetSentinel(target, 'sentinel-other-87654321');
    await expectExit(markMigrationPhase(makeCtx(), { phase: 'source_fenced', sourceBootId: 'b', fenceIdentity }), MIGRATION_EXIT.PREFLIGHT_BLOCK, 'fingerprint_mismatch');
  });

  test('an overwritten completed key aborts the window with exit 13 and exact IDs; RB1 then restores the run', async () => {
    const good = Buffer.from('acknowledged-bytes');
    const { id, key } = await insertV4({ bytes: good, completed: true, etag: '"e1"' });
    source.put(key, good);
    const ctx = makeCtx();
    await runMigrationPrecopy(ctx, { runId: randomUUID() });
    source.put(key, 'replaced-by-direct-put');
    await markMigrationPhase(ctx, { phase: 'source_fenced', sourceBootId: 'boot', fenceIdentity });
    await markMigrationPhase(ctx, { phase: 'backed_up', verifiedBackupDir: '/b', backupManifestSha256: digestA });
    const err = await expectExit(runMigrationDelta(ctx), MIGRATION_EXIT.INTEGRITY_MISMATCH, 'source_integrity_mismatch');
    expect(err.details.integrity_failures.map((f: any) => f.object_id)).toEqual([id]);
    expect(target.objects.has(key)).toBe(false);
    const begun = await beginRollbackRb1(ctx);
    expect(begun.phase).toBe('rolling_back');
    expect((await beginRollbackRb1(ctx)).resumed).toBe(true);
    expect((await finishMigrationRollback(ctx)).phase).toBe('rolled_back');
    const [row] = await sql`SELECT sha256_verified_etag FROM v4_storage_objects WHERE id = ${id}`;
    expect(row!.sha256_verified_etag).toBe('"e1"');
  });

  test('RB1 after db_switched restores the exact original ETags, offline target tolerated; blind revert refused', async () => {
    const bytes = Buffer.from('rb1-object');
    const { id, key } = await insertV4({ bytes, completed: true, etag: 'placeholder' });
    const etag = source.put(key, bytes);
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = ${etag} WHERE id = ${id}`;
    const ctx = makeCtx();
    await advanceToVerified(ctx);
    await prepareMigrationSwitch(ctx, { oldConfigDigest: digestA, newConfigDigest: digestB });
    await rewriteMigrationEtags(ctx);
    const [switched] = await sql`SELECT sha256_verified_etag FROM v4_storage_objects WHERE id = ${id}`;
    expect(switched!.sha256_verified_etag).not.toBe(etag);

    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = '"tampered"' WHERE id = ${id}`;
    await expectExit(beginRollbackRb1(ctx), MIGRATION_EXIT.INTEGRITY_MISMATCH, 'etag_revert_row_changed');
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = ${switched!.sha256_verified_etag} WHERE id = ${id}`;
    target.reachable = false;
    await beginRollbackRb1(makeCtx({ targetClient: target.client() }));
    const [restored] = await sql`SELECT sha256_verified_etag FROM v4_storage_objects WHERE id = ${id}`;
    expect(restored!.sha256_verified_etag).toBe(etag);
  });

  test('an invalidated snapshot resets to precopied, reverting ETags and clearing fence/backup/switch state', async () => {
    const bytes = Buffer.from('snapshot');
    const { id, key } = await insertV4({ bytes, completed: true, etag: 'p' });
    const etag = source.put(key, bytes);
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = ${etag} WHERE id = ${id}`;
    const ctx = makeCtx();
    await advanceToVerified(ctx);
    await prepareMigrationSwitch(ctx, { oldConfigDigest: digestA, newConfigDigest: digestB });
    await rewriteMigrationEtags(ctx);
    const reset = await resetMigrationSnapshot(ctx, 'tower ran');
    expect(reset).toMatchObject({ phase: 'precopied', reset_from: 'db_switched', reverted_etags: 1 });
    const [run] = await sql`SELECT source_boot_id, target_boot_id, fence_identity, old_config_digest, new_config_digest, verified_backup_dir, backup_manifest_sha256, source_fenced_at FROM storage_migration_runs`;
    expect(Object.values(run!).every((v) => v === null)).toBe(true);
    const [row] = await sql`SELECT sha256_verified_etag FROM v4_storage_objects WHERE id = ${id}`;
    expect(row!.sha256_verified_etag).toBe(etag);
    expect((await sql`SELECT DISTINCT state FROM storage_migration_objects`).map((r: any) => r.state)).toEqual(['copied']);
    // The full window can run again from the re-fence.
    await markMigrationPhase(ctx, { phase: 'source_fenced', sourceBootId: 'boot-2', fenceIdentity });
    await markMigrationPhase(ctx, { phase: 'backed_up', verifiedBackupDir: '/b2', backupManifestSha256: digestA });
    await runMigrationDelta(ctx);
    expect((await runMigrationVerify(ctx)).verified_count).toBe(1);
  });

  test('cutover verify rejects stray and unjournalled keys; standalone verify checks the live DB and reports orphans', async () => {
    const bytes = Buffer.from('verify');
    const { key } = await insertV4({ bytes, completed: true });
    source.put(key, bytes);
    const ctx = makeCtx();
    await runMigrationPrecopy(ctx, { runId: randomUUID() });
    await markMigrationPhase(ctx, { phase: 'source_fenced', sourceBootId: 'boot', fenceIdentity });
    await markMigrationPhase(ctx, { phase: 'backed_up', verifiedBackupDir: '/b', backupManifestSha256: digestA });
    await runMigrationDelta(ctx);
    target.put('v4/stray.bin', 'stray');
    const err = await expectExit(runMigrationVerify(ctx), MIGRATION_EXIT.INTEGRITY_MISMATCH, 'verification_failed');
    expect(err.details.mismatches.map((m: any) => m.reason)).toContain('stray_key_in_target_bucket');
    target.objects.delete('v4/stray.bin');
    const late = await insertV4({ bytes: Buffer.from('late-incomplete'), completed: false });
    target.put(late.key, 'late-incomplete');
    const err2 = await expectExit(runMigrationVerify(ctx), MIGRATION_EXIT.INTEGRITY_MISMATCH);
    expect(err2.details.mismatches.map((m: any) => m.reason)).toContain('missing_from_journal');
    target.objects.delete(late.key);
    await runMigrationVerify(ctx);

    // Standalone: a legitimate post-cutover upload passes against the live DB; orphans are warnings.
    const post = await insertV4({ bytes: Buffer.from('post-cutover'), completed: true });
    target.put(post.key, 'post-cutover');
    target.put('v4/orphan.bin', 'orphan');
    const standalone = await runMigrationVerify(makeCtx(), { standalone: true });
    expect(standalone.verified_count).toBe(2);
    expect(standalone.stray_keys).toEqual(['v4/orphan.bin']);
    target.put(post.key, 'post-cutover-CORRUPT');
    await expectExit(runMigrationVerify(makeCtx(), { standalone: true }), MIGRATION_EXIT.INTEGRITY_MISMATCH);
  });

  test('RB2 reverse-sync copies only differing bytes, reconciles ETags with the source and applies only post-cutover deletes', async () => {
    const aBytes = Buffer.from('unchanged-a');
    const a = await insertV4({ bytes: aBytes, completed: true, isPublic: true, etag: 'p' });
    const aEtag = source.put(a.key, aBytes);
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = ${aEtag} WHERE id = ${a.id}`;
    const nBytes = Buffer.from('null-etag-b');
    const n = await insertV4({ bytes: nBytes, completed: true });
    source.put(n.key, nBytes);
    const incPre = await insertV4({ bytes: Buffer.alloc(0), completed: false, declaredSize: 9 });
    const mLive = await insertManaged(Buffer.from('managed-live'));
    source.put(mLive.key, 'managed-live');
    const mOld = await insertManaged(Buffer.from('managed-deleted-before'));
    source.put(mOld.key, 'managed-deleted-before');
    await sql`UPDATE managed_app_storage_objects SET deletion_job = ${randomUUID()} WHERE id = ${mOld.id}`;

    const ctx = makeCtx();
    await advanceToVerified(ctx);
    await prepareMigrationSwitch(ctx, { oldConfigDigest: digestA, newConfigDigest: digestB });
    await rewriteMigrationEtags(ctx);
    await markMigrationPhase(ctx, { phase: 'config_switched', configDigest: digestB });
    await markMigrationPhase(ctx, { phase: 'start_intent' });
    await markMigrationPhase(ctx, { phase: 'started' });

    // Post-cutover activity on SeaweedFS.
    const postBytes = Buffer.from('written-after-cutover');
    const post = await insertV4({ bytes: postBytes, completed: true, isPublic: true });
    const postEtag = target.put(post.key, postBytes);
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = ${postEtag} WHERE id = ${post.id}`;
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = ${target.objects.get(n.key)!.etag} WHERE id = ${n.id}`;
    target.put(incPre.key, 'late-body');
    await sql`UPDATE managed_app_storage_objects SET deletion_job = ${randomUUID()} WHERE id = ${mLive.id}`;
    target.objects.delete(mLive.key);

    await expectExit(beginRollbackRb1(ctx), MIGRATION_EXIT.ROLLBACK_REFUSED);
    const rb2 = await runReverseMigrateSync(ctx);
    expect(rb2).toMatchObject({ phase: 'rolling_back', reverse_copied: 2, unchanged: 2, reverse_deleted: 1, etags_restored: 1 });
    expect(source.objects.get(post.key)!.body.equals(postBytes)).toBe(true);
    expect(source.objects.get(incPre.key)!.body.toString()).toBe('late-body');
    expect(source.objects.has(mLive.key)).toBe(false);
    expect(source.objects.has(mOld.key)).toBe(true);
    const etags = new Map((await sql`SELECT id::text, sha256_verified_etag FROM v4_storage_objects`).map((r: any) => [r.id, r.sha256_verified_etag]));
    expect(etags.get(a.id)).toBe(aEtag);
    expect(etags.get(n.id)).toBe(source.objects.get(n.key)!.etag);
    expect(etags.get(post.id)).toBe(source.objects.get(post.key)!.etag);

    await expectExit(finishMigrationRollback(ctx), MIGRATION_EXIT.SMOKE_FAILED, 'rb2_smoke_missing');
    const [run] = await sql`SELECT run_id::text, fingerprint FROM storage_migration_runs`;
    await sql`UPDATE storage_migration_runs SET smoke_passed_at = NOW(), smoke_evidence = ${sql.json({ store: 'source', smoke_run_id: run!.run_id, smoke_fingerprint: run!.fingerprint })}`;
    expect((await finishMigrationRollback(ctx)).phase).toBe('rolled_back');
    const status = await getMigrationStatus(ctx);
    expect(status.phase).toBe('rolled_back');
  });

  test('post-publish verification re-reads everything before NStack serves and catches strays and ETag drift', async () => {
    const bytes = Buffer.from('published-object');
    const { id, key } = await insertV4({ bytes, completed: true, isPublic: true, etag: 'p' });
    const etag = source.put(key, bytes);
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = ${etag} WHERE id = ${id}`;
    const ctx = makeCtx();
    await advanceToVerified(ctx);
    await prepareMigrationSwitch(ctx, { oldConfigDigest: digestA, newConfigDigest: digestB });
    await rewriteMigrationEtags(ctx);
    await markMigrationPhase(ctx, { phase: 'config_switched', configDigest: digestB });
    await markMigrationPhase(ctx, { phase: 'start_intent' });
    expect((await runMigrationVerify(ctx, { published: true, strict: true, targetBootId: 'sfs-boot-2' })).verified_count).toBe(1);
    target.put('v4/stray-after-publish.bin', 'x');
    await expectExit(runMigrationVerify(ctx, { published: true, strict: true }), MIGRATION_EXIT.SMOKE_FAILED, 'verification_failed');
    // Once NStack may have served (non-strict), new keys are reported, not failures.
    const loose = await runMigrationVerify(ctx, { published: true });
    expect(loose.stray_keys).toEqual(['v4/stray-after-publish.bin']);
    target.objects.delete('v4/stray-after-publish.bin');
    target.put(key, bytes);
    const err = await expectExit(runMigrationVerify(ctx, { published: true, strict: true }), MIGRATION_EXIT.SMOKE_FAILED);
    expect(err.details.mismatches[0].reason).toBe('etag_changed_after_publish');
    const [run] = await sql`SELECT target_boot_id FROM storage_migration_runs`;
    expect(run!.target_boot_id).toBe('sfs-boot-2');
  });

  test('RB2 fully re-reads unchanged source objects and repairs a corrupted source copy from the target', async () => {
    const bytes = Buffer.from('rb2-unchanged-but-corrupted');
    const { id, key } = await insertV4({ bytes, completed: true, etag: 'p' });
    const etag = source.put(key, bytes, { etag: '"fixed-etag"' });
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = ${etag} WHERE id = ${id}`;
    const ctx = makeCtx();
    await advanceToVerified(ctx);
    await prepareMigrationSwitch(ctx, { oldConfigDigest: digestA, newConfigDigest: digestB });
    await rewriteMigrationEtags(ctx);
    await markMigrationPhase(ctx, { phase: 'config_switched', configDigest: digestB });
    await markMigrationPhase(ctx, { phase: 'start_intent' });
    // Same listing ETag, different bytes: only a full read can notice.
    source.put(key, 'corrupted!!', { etag: '"fixed-etag"' });
    const out = await runReverseMigrateSync(ctx);
    expect(out).toMatchObject({ reverse_copied: 1, unchanged: 0 });
    expect(source.objects.get(key)!.body.equals(bytes)).toBe(true);
    const [row] = await sql`SELECT sha256_verified_etag FROM v4_storage_objects WHERE id = ${id}`;
    expect(row!.sha256_verified_etag).toBe(source.objects.get(key)!.etag);
  });

  test('status reports RB2 at-risk IDs (never "lost") when the target is unreadable', async () => {
    const bytes = Buffer.from('status');
    const { key } = await insertV4({ bytes, completed: true });
    source.put(key, bytes);
    const ctx = makeCtx();
    await advanceToVerified(ctx);
    await prepareMigrationSwitch(ctx, { oldConfigDigest: digestA, newConfigDigest: digestB });
    await rewriteMigrationEtags(ctx);
    await markMigrationPhase(ctx, { phase: 'config_switched', configDigest: digestB });
    await markMigrationPhase(ctx, { phase: 'start_intent' });
    const post = await insertV4({ bytes: Buffer.from('after'), completed: true });
    target.reachable = false;
    const st: any = await getMigrationStatus(makeCtx({ targetClient: target.client() }), { checkTargetReadable: true });
    expect(st.rollback_boundary).toBe('RB2-lost');
    expect(st.rb2_at_risk.v4).toEqual([post.id]);
    expect(st.rb2_at_risk.note).toContain('not lost');
  });

  test('the session lock serialises mutators (exit 3)', async () => {
    await withMigrationAdvisoryLock(sql, async () => {
      await expectExit(runMigrationPrecopy(makeCtx()), MIGRATION_EXIT.LOCK_OR_CONFLICT, 'migration_lock_held');
    });
  });

  test('data CLI context requires explicit source and distinct target credentials and never inherits STORAGE_PROVIDER', () => {
    const env: Record<string, string> = {
      STORAGE_PROVIDER: 'seaweedfs', STORAGE_S3_ENDPOINT: 'http://seaweedfs:8333',
      STORAGE_S3_SOURCE_PROVIDER: 'minio', STORAGE_S3_SOURCE_ENDPOINT: 'http://minio:9000', STORAGE_S3_SOURCE_BUCKET: 'b',
      STORAGE_S3_SOURCE_ACCESS_KEY: 'src', STORAGE_S3_SOURCE_SECRET_KEY: 'srcsecret',
      STORAGE_S3_TARGET_ENDPOINT: 'http://seaweedfs:8333', STORAGE_S3_TARGET_ACCESS_KEY: 'tgt', STORAGE_S3_TARGET_SECRET_KEY: 'tgtsecret',
      STORAGE_MIGRATION_SOURCE_IDENTITY: 'minio:p:v', SUPERBASED_SERVICE_NSEC: svcNsec,
    };
    const ctx = buildMigrationContext(env, sql);
    expect(ctx.source.provider).toBe('minio');
    expect(ctx.target.provider).toBe('seaweedfs');
    expect(ctx.serviceNpub).toBe(svcNpub);
    expect(() => buildMigrationContext({ ...env, STORAGE_S3_TARGET_ACCESS_KEY: 'src' }, sql)).toThrow(/distinct/);
    const { STORAGE_S3_SOURCE_PROVIDER: _omit, ...noSource } = env;
    expect(() => buildMigrationContext(noSource, sql)).toThrow(/STORAGE_S3_SOURCE_PROVIDER/);
  });
});

describe('E5 tower-backup.sh manifest component validation', () => {
  test('verify rejects empty, missing, and duplicate component manifests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tower-backup-manifest-'));
    try {
      const keygen = Bun.spawnSync(['age-keygen', '-o', join(dir, 'key.txt')]);
      if (keygen.exitCode !== 0) {
        // Skip only if age-keygen is absent on host.
        return;
      }
      const keyText = readFileSync(join(dir, 'key.txt'), 'utf8');
      const recipient = keyText.match(/public key:\s*(age1[a-z0-9]+)/i)?.[1];
      expect(recipient).toBeTruthy();

      const runVerifyWithManifest = (manifestObj: unknown) => {
        const bdir = mkdtempSync(join(dir, 'b-'));
        const enc = Bun.spawnSync(
          ['age', '--encrypt', '--recipient', recipient!, '--output', join(bdir, 'manifest.json.age')],
          { stdin: Buffer.from(JSON.stringify(manifestObj)) },
        );
        expect(enc.exitCode).toBe(0);
        return Bun.spawnSync([
          'bash',
          join(import.meta.dir, '../scripts/tower-backup.sh'),
          'verify',
          '--backup',
          bdir,
          '--identity',
          join(dir, 'key.txt'),
        ]);
      };

      // Empty components
      const empty = runVerifyWithManifest({
        format: 'wingman-tower-backup',
        version: 2,
        storage_provider: 'seaweedfs',
        created_at: new Date().toISOString(),
        components: [],
      });
      expect(empty.exitCode).not.toBe(0);
      expect(empty.stderr.toString()).toContain('exactly 4 components');

      // Duplicate components (3 entries but missing seaweedfs)
      const dup = runVerifyWithManifest({
        format: 'wingman-tower-backup',
        version: 2,
        storage_provider: 'seaweedfs',
        created_at: new Date().toISOString(),
        components: [
          { name: 'main-postgres', file: 'main-postgres.dump.age', sha256: 'a', format: 'pg_dump-custom' },
          { name: 'main-postgres', file: 'main-postgres.dump.age', sha256: 'a', format: 'pg_dump-custom' },
          { name: 'graph-postgres', file: 'graph-postgres.dump.age', sha256: 'b', format: 'pg_dump-custom' },
          { name: 'seaweedfs-image', file: 'seaweedfs-image.tar.age', sha256: 'd', format: 'docker-image-archive', image_ref: `sha256:${'e'.repeat(64)}`, image_id: `sha256:${'e'.repeat(64)}` },
        ],
      });
      expect(dup.exitCode).not.toBe(0);
      expect(dup.stderr.toString()).toContain('components mismatch');

      // Wrong provider storage component filename
      const wrongProv = runVerifyWithManifest({
        format: 'wingman-tower-backup',
        version: 2,
        storage_provider: 'seaweedfs',
        created_at: new Date().toISOString(),
        components: [
          { name: 'main-postgres', file: 'main-postgres.dump.age', sha256: 'a', format: 'pg_dump-custom' },
          { name: 'graph-postgres', file: 'graph-postgres.dump.age', sha256: 'b', format: 'pg_dump-custom' },
          { name: 'minio', file: 'minio-data.tar.age', sha256: 'c', format: 'tar' },
          { name: 'seaweedfs-image', file: 'seaweedfs-image.tar.age', sha256: 'd', format: 'docker-image-archive', image_ref: `sha256:${'e'.repeat(64)}`, image_id: `sha256:${'e'.repeat(64)}` },
        ],
      });
      expect(wrongProv.exitCode).not.toBe(0);
      expect(wrongProv.stderr.toString()).toContain('components mismatch');

      // A SeaweedFS set must carry the exact SeaweedFS image.
      const base = [
        { name: 'main-postgres', file: 'main-postgres.dump.age', sha256: 'a', format: 'pg_dump-custom' },
        { name: 'graph-postgres', file: 'graph-postgres.dump.age', sha256: 'b', format: 'pg_dump-custom' },
        { name: 'seaweedfs', file: 'seaweedfs-data.tar.age', sha256: 'c', format: 'tar' },
      ];
      const noImage = runVerifyWithManifest({ format: 'wingman-tower-backup', version: 2, storage_provider: 'seaweedfs', created_at: new Date().toISOString(), components: base });
      expect(noImage.exitCode).not.toBe(0);
      expect(noImage.stderr.toString()).toContain('exactly 4 components');
      const badIdentity = runVerifyWithManifest({
        format: 'wingman-tower-backup', version: 2, storage_provider: 'seaweedfs', created_at: new Date().toISOString(),
        components: [...base, { name: 'seaweedfs-image', file: 'seaweedfs-image.tar.age', sha256: 'd', format: 'docker-image-archive', image_ref: 'chrislusf/seaweedfs:latest', image_id: 'x' }],
      });
      expect(badIdentity.exitCode).not.toBe(0);
      expect(badIdentity.stderr.toString()).toContain('lacks a valid image_ref/image_id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('E5 tower-backup.sh verify on production-sized dumps', () => {
  test('verify drains each encrypted dump even when pg_restore reads only the table of contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tower-backup-large-'));
    try {
      if (Bun.spawnSync(['age-keygen', '-o', join(dir, 'key.txt')]).exitCode !== 0) return;
      const recipient = readFileSync(join(dir, 'key.txt'), 'utf8').match(/public key:\s*(age1[a-z0-9]+)/i)![1]!;
      const bdir = join(dir, 'set');
      mkdirSync(bdir);
      const enc = (name: string, bytes: Buffer) => {
        expect(Bun.spawnSync(['age', '--encrypt', '--recipient', recipient, '--output', join(bdir, name)], { stdin: bytes }).exitCode).toBe(0);
        return createHash('sha256').update(readFileSync(join(bdir, name))).digest('hex');
      };
      // Far larger than a pipe buffer, like a real production dump.
      const big = randomBytes(4 * 1024 * 1024);
      const tar = Bun.spawnSync(['tar', '-cf', '-', '-C', dir, 'key.txt']).stdout;
      const components = [
        { name: 'main-postgres', file: 'main-postgres.dump.age', sha256: enc('main-postgres.dump.age', big), format: 'pg_dump-custom' },
        { name: 'graph-postgres', file: 'graph-postgres.dump.age', sha256: enc('graph-postgres.dump.age', big), format: 'pg_dump-custom' },
        { name: 'minio', file: 'minio-data.tar.age', sha256: enc('minio-data.tar.age', Buffer.from(tar)), format: 'tar' },
      ];
      enc('manifest.json.age', Buffer.from(JSON.stringify({ format: 'wingman-tower-backup', version: 2, storage_provider: 'minio', created_at: new Date().toISOString(), components })));
      // Fake docker: pg_restore --list reads only the TOC and exits without draining stdin.
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'docker'), `#!/bin/sh
case "$*" in
  *"pg_restore --list >/dev/null; rc="*) head -c 5 >/dev/null; cat >/dev/null; exit 0;;
  *"pg_restore --list"*) head -c 5 >/dev/null; exit 0;;
  *) exit 0;;
esac
`, { mode: 0o755 });
      const res = Bun.spawnSync(['bash', join(import.meta.dir, '../scripts/tower-backup.sh'), 'verify', '--backup', bdir, '--identity', join(dir, 'key.txt')], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(res.stderr.toString()).toBe('');
      expect(res.exitCode).toBe(0);
      expect(res.stdout.toString()).toContain('Verified backup set');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('E5 tower-backup.sh verify refuses damaged sets', () => {
  function makeSet(dir: string, recipient: string, mutate: (bdir: string) => void, mainPlain: Buffer) {
    const bdir = join(dir, `set-${randomUUID()}`);
    mkdirSync(bdir);
    const enc = (name: string, bytes: Buffer) => {
      expect(Bun.spawnSync(['age', '--encrypt', '--recipient', recipient, '--output', join(bdir, name)], { stdin: bytes }).exitCode).toBe(0);
    };
    enc('main-postgres.dump.age', mainPlain);
    enc('graph-postgres.dump.age', mainPlain);
    enc('minio-data.tar.age', Buffer.from(Bun.spawnSync(['tar', '-cf', '-', '-C', dir, 'key.txt']).stdout));
    mutate(bdir);
    // Checksums are recomputed after damage, so only decryption/authentication or format checks can catch it.
    const sha = (name: string) => createHash('sha256').update(readFileSync(join(bdir, name))).digest('hex');
    const components = [
      { name: 'main-postgres', file: 'main-postgres.dump.age', sha256: sha('main-postgres.dump.age'), format: 'pg_dump-custom' },
      { name: 'graph-postgres', file: 'graph-postgres.dump.age', sha256: sha('graph-postgres.dump.age'), format: 'pg_dump-custom' },
      { name: 'minio', file: 'minio-data.tar.age', sha256: sha('minio-data.tar.age'), format: 'tar' },
    ];
    enc('manifest.json.age', Buffer.from(JSON.stringify({ format: 'wingman-tower-backup', version: 2, storage_provider: 'minio', created_at: new Date().toISOString(), components })));
    return bdir;
  }
  const verify = (bdir: string, dir: string, path?: string) => Bun.spawnSync(['bash', join(import.meta.dir, '../scripts/tower-backup.sh'), 'verify', '--backup', bdir, '--identity', join(dir, 'key.txt')], {
    env: { ...process.env, ...(path ? { PATH: path } : {}) }, stdout: 'pipe', stderr: 'pipe',
  });

  test('truncated or corrupted age ciphertext fails verification even though the stream is drained', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tower-backup-damaged-'));
    try {
      if (Bun.spawnSync(['age-keygen', '-o', join(dir, 'key.txt')]).exitCode !== 0) return;
      const recipient = readFileSync(join(dir, 'key.txt'), 'utf8').match(/public key:\s*(age1[a-z0-9]+)/i)![1]!;
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      // Draining stand-in for the pg_restore container: format checks pass, so only age can fail.
      writeFileSync(join(bin, 'docker'), '#!/bin/sh\ncat >/dev/null; exit 0\n', { mode: 0o755 });
      const path = `${bin}:${process.env.PATH}`;
      const plain = randomBytes(2 * 1024 * 1024);
      expect(verify(makeSet(dir, recipient, () => {}, plain), dir, path).exitCode).toBe(0);
      const truncated = makeSet(dir, recipient, (b) => {
        const f = join(b, 'main-postgres.dump.age');
        writeFileSync(f, readFileSync(f).subarray(0, 1024 * 1024));
      }, plain);
      expect(verify(truncated, dir, path).exitCode).not.toBe(0);
      const corrupted = makeSet(dir, recipient, (b) => {
        const f = join(b, 'graph-postgres.dump.age');
        const bytes = Buffer.from(readFileSync(f));
        bytes[bytes.length - 100] ^= 0xff;
        writeFileSync(f, bytes);
      }, plain);
      expect(verify(corrupted, dir, path).exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a decryptable file that is not a pg_dump archive fails the real pg_restore check', () => {
    if (Bun.spawnSync(['docker', 'image', 'inspect', 'postgres:16-alpine'], { stdout: 'ignore', stderr: 'ignore' }).exitCode !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), 'tower-backup-malformed-'));
    try {
      if (Bun.spawnSync(['age-keygen', '-o', join(dir, 'key.txt')]).exitCode !== 0) return;
      const recipient = readFileSync(join(dir, 'key.txt'), 'utf8').match(/public key:\s*(age1[a-z0-9]+)/i)![1]!;
      const res = verify(makeSet(dir, recipient, () => {}, randomBytes(512 * 1024)), dir);
      expect(res.exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
