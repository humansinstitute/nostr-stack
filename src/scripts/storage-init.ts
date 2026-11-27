import {
  CreateBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { resolveStorageProviderConfig, type StorageProvider } from '../services/storage-provider';
import {
  parseStorageSentinel,
  STORAGE_SENTINEL_KEY,
  type StorageSentinelDocument,
} from '../services/storage-startup-guard';

export interface StorageInitOptions {
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  adminAccessKey: string;
  adminSecretKey: string;
  rwAccessKey?: string;
  rwSecretKey?: string;
  forcePathStyle: boolean;
  writeSentinel: boolean;
  enforcePrivatePolicy?: boolean;
  verifyAnonymousDenied?: boolean;
  probeRw: boolean;
  maxAttempts: number;
  retryDelayMs: number;
}

function isBucketNotFound(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode;
  const code = err?.name || err?.Code;
  return code === 'NoSuchBucket' || (code === 'NotFound' && status === 404) || status === 404;
}

function isObjectNotFound(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode;
  const code = err?.name || err?.Code;
  return code === 'NoSuchKey' || code === 'NotFound' || status === 404;
}

function isPolicyNotFound(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode;
  const code = err?.name || err?.Code;
  return code === 'NoSuchBucketPolicy' || code === 'NotFound' || status === 404;
}

function isAlreadyExists(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode;
  const code = err?.name || err?.Code;
  return status === 409 || code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists';
}

async function bodyToBuffer(body: any): Promise<Buffer> {
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

export async function initializeStorageBucket(
  options: StorageInitOptions,
  deps?: {
    admin?: Pick<S3Client, 'send'>;
    rw?: Pick<S3Client, 'send'>;
    fetchImpl?: typeof fetch;
  },
): Promise<{
  ok: true;
  provider: StorageProvider;
  bucket: string;
  created: boolean;
  versioning: 'unversioned';
  anonymous_policy: 'private_verified' | 'policy_cleared';
  sentinel_id: string | null;
  rw_probe_passed: boolean;
}> {
  const makeClient = (accessKeyId: string, secretAccessKey: string) =>
    new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 1,
      credentials: { accessKeyId, secretAccessKey },
    });

  const admin = deps?.admin ?? makeClient(options.adminAccessKey, options.adminSecretKey);
  const fetchImpl = deps?.fetchImpl ?? fetch;

  let created = false;
  let ready = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, options.maxAttempts); attempt++) {
    try {
      try {
        await admin.send(new HeadBucketCommand({ Bucket: options.bucket }));
        ready = true;
        break;
      } catch (err: any) {
        if (!isBucketNotFound(err)) throw err;
        try {
          await admin.send(new CreateBucketCommand({ Bucket: options.bucket }));
          created = true;
        } catch (createErr: any) {
          if (!isAlreadyExists(createErr)) throw createErr;
        }
        await admin.send(new HeadBucketCommand({ Bucket: options.bucket }));
        ready = true;
        break;
      }
    } catch (err) {
      lastError = err;
      if (attempt < options.maxAttempts && options.retryDelayMs > 0) {
        await Bun.sleep(options.retryDelayMs);
      }
    }
  }
  if (!ready) {
    throw new Error(
      `Storage init failed for provider=${options.provider} bucket=${options.bucket} after ${options.maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  // Assert unversioned bucket (preserves MANAGED_STORAGE_PHYSICAL_DELETE_POLICY contract).
  const versioning = await admin.send(new GetBucketVersioningCommand({ Bucket: options.bucket }));
  if (versioning.Status || versioning.MFADelete) {
    throw new Error(
      `Refusing bucket "${options.bucket}": S3 versioning/MFADelete is enabled (Status=${versioning.Status ?? 'none'}, MFADelete=${versioning.MFADelete ?? 'none'}).`,
    );
  }

  // Explicit equivalent of `mc anonymous set none`:
  // For MinIO, clear any existing bucket policy so anonymous access cannot be left enabled.
  // For SeaweedFS (and MinIO), verify unauthenticated HTTP GET against the bucket returns 403/401.
  let anonymousPolicy: 'private_verified' | 'policy_cleared' = 'private_verified';
  const enforcePrivatePolicy = options.enforcePrivatePolicy ?? options.provider === 'minio';
  if (enforcePrivatePolicy) {
    let hasPolicy = false;
    try {
      const existingPolicy = await admin.send(new GetBucketPolicyCommand({ Bucket: options.bucket }));
      if (existingPolicy.Policy && existingPolicy.Policy.trim().length > 0) {
        hasPolicy = true;
      }
    } catch (err: any) {
      if (!isPolicyNotFound(err)) throw err;
    }
    if (hasPolicy) {
      await admin.send(new DeleteBucketPolicyCommand({ Bucket: options.bucket }));
      anonymousPolicy = 'policy_cleared';
    }
  }

  const verifyAnonymousDenied = options.verifyAnonymousDenied ?? true;
  if (verifyAnonymousDenied) {
    const base = options.endpoint.replace(/\/+$/, '');
    const anonUrl = `${base}/${encodeURIComponent(options.bucket)}`;
    const anonRes = await fetchImpl(anonUrl, { method: 'GET', redirect: 'error' });
    await anonRes.body?.cancel();
    if (anonRes.status !== 403 && anonRes.status !== 401) {
      throw new Error(
        `Refusing bucket "${options.bucket}": anonymous GET ${anonUrl} returned HTTP ${anonRes.status} (expected 401/403).`,
      );
    }
  }

  let sentinelId: string | null = null;
  if (options.writeSentinel) {
    let existing: StorageSentinelDocument | null = null;
    try {
      const res = await admin.send(
        new GetObjectCommand({ Bucket: options.bucket, Key: STORAGE_SENTINEL_KEY }),
      );
      existing = parseStorageSentinel((await bodyToBuffer(res.Body)).toString('utf8'));
    } catch (err: any) {
      if (!isObjectNotFound(err)) throw err;
    }

    if (existing) {
      if (existing.provider !== options.provider || existing.bucket !== options.bucket) {
        throw new Error(
          `Existing sentinel in bucket "${options.bucket}" mismatches expected provider=${options.provider} (found provider=${existing.provider}, bucket=${existing.bucket}).`,
        );
      }
      sentinelId = existing.sentinel_id;
    } else {
      const doc: StorageSentinelDocument = {
        version: 1,
        provider: options.provider,
        sentinel_id: randomUUID(),
        bucket: options.bucket,
        created_at: new Date().toISOString(),
      };
      const payload = `${JSON.stringify(doc, null, 2)}\n`;
      await admin.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: STORAGE_SENTINEL_KEY,
          Body: Buffer.from(payload, 'utf8'),
          ContentType: 'application/json',
        }),
      );
      const readback = await admin.send(
        new GetObjectCommand({ Bucket: options.bucket, Key: STORAGE_SENTINEL_KEY }),
      );
      const verified = parseStorageSentinel((await bodyToBuffer(readback.Body)).toString('utf8'));
      if (verified.sentinel_id !== doc.sentinel_id || verified.provider !== options.provider) {
        throw new Error('Sentinel readback verification failed.');
      }
      sentinelId = verified.sentinel_id;
    }
  }

  let rwProbePassed = false;
  if (options.probeRw) {
    const rw =
      deps?.rw ??
      makeClient(
        options.rwAccessKey || options.adminAccessKey,
        options.rwSecretKey || options.adminSecretKey,
      );
    const probeKey = `.nstack-init-probe-${randomUUID()}`;
    const probeBytes = Buffer.from(`nstack-init-probe:${randomUUID()}`, 'utf8');
    const expectedSha = createHash('sha256').update(probeBytes).digest('hex');

    await rw.send(
      new PutObjectCommand({
        Bucket: options.bucket,
        Key: probeKey,
        Body: probeBytes,
        ContentType: 'text/plain',
      }),
    );
    try {
      const got = await rw.send(new GetObjectCommand({ Bucket: options.bucket, Key: probeKey }));
      const actualBytes = await bodyToBuffer(got.Body);
      const actualSha = createHash('sha256').update(actualBytes).digest('hex');
      if (actualSha !== expectedSha || actualBytes.byteLength !== probeBytes.byteLength) {
        throw new Error('RW probe readback hash/size mismatch.');
      }
    } finally {
      await rw.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: probeKey }));
    }
    let deletedConfirmed = false;
    try {
      await rw.send(new HeadObjectCommand({ Bucket: options.bucket, Key: probeKey }));
    } catch (err: any) {
      if (isObjectNotFound(err)) deletedConfirmed = true;
      else throw err;
    }
    if (!deletedConfirmed) {
      throw new Error('RW probe delete verification failed: probe key still exists.');
    }
    rwProbePassed = true;
  }

  return {
    ok: true,
    provider: options.provider,
    bucket: options.bucket,
    created,
    versioning: 'unversioned',
    anonymous_policy: anonymousPolicy,
    sentinel_id: sentinelId,
    rw_probe_passed: rwProbePassed,
  };
}

if (import.meta.main) {
  const resolved = resolveStorageProviderConfig(process.env);
  const bucket = (process.env.STORAGE_S3_BUCKET || 'superbased-storage').trim();
  const region = (process.env.STORAGE_S3_REGION || 'us-east-1').trim();
  const forcePathStyle = !/^(false|0|no)$/i.test(
    (process.env.STORAGE_S3_FORCE_PATH_STYLE || 'true').trim(),
  );
  const explicitInitAccess = (
    process.env.STORAGE_INIT_ACCESS_KEY ||
    process.env.SEAWEEDFS_ADMIN_ACCESS_KEY ||
    process.env.STORAGE_INIT_ACCESS_KEY_OVERRIDE ||
    ''
  ).trim();
  const explicitInitSecret = (
    process.env.STORAGE_INIT_SECRET_KEY ||
    process.env.SEAWEEDFS_ADMIN_SECRET_KEY ||
    process.env.STORAGE_INIT_SECRET_KEY_OVERRIDE ||
    ''
  ).trim();
  if (resolved.provider === 'seaweedfs' && (!explicitInitAccess || !explicitInitSecret)) {
    console.error(
      'STORAGE_INIT_ACCESS_KEY/STORAGE_INIT_SECRET_KEY (or SEAWEEDFS_ADMIN_ACCESS_KEY/SECRET_KEY) must be explicitly set for seaweedfs init; refusing fallback to app credentials.',
    );
    process.exit(1);
  }
  const adminAccessKey =
    explicitInitAccess || (process.env.STORAGE_S3_ACCESS_KEY || '').trim();
  const adminSecretKey =
    explicitInitSecret || (process.env.STORAGE_S3_SECRET_KEY || '').trim();
  if (!adminAccessKey || !adminSecretKey) {
    console.error('STORAGE_INIT_ACCESS_KEY/SECRET_KEY or STORAGE_S3_ACCESS_KEY/SECRET_KEY must be set');
    process.exit(1);
  }
  const writeSentinelEnv = process.env.STORAGE_INIT_WRITE_SENTINEL;
  const writeSentinel =
    writeSentinelEnv !== undefined
      ? /^(1|true|yes|on)$/i.test(writeSentinelEnv.trim())
      : resolved.provider === 'seaweedfs';
  const enforcePrivateEnv = process.env.STORAGE_INIT_ENFORCE_PRIVATE_POLICY;
  const enforcePrivatePolicy =
    enforcePrivateEnv !== undefined
      ? /^(1|true|yes|on)$/i.test(enforcePrivateEnv.trim())
      : resolved.provider === 'minio';
  const probeRw = /^(1|true|yes|on)$/i.test((process.env.STORAGE_INIT_PROBE_RW || 'false').trim());
  const maxAttempts = Math.max(1, Number.parseInt(process.env.STORAGE_INIT_MAX_ATTEMPTS || '40', 10) || 40);
  const retryDelayMs = Math.max(100, Number.parseInt(process.env.STORAGE_INIT_RETRY_DELAY_MS || '1500', 10) || 1500);

  const summary = await initializeStorageBucket({
    provider: resolved.provider,
    endpoint: resolved.endpoint,
    region,
    bucket,
    adminAccessKey,
    adminSecretKey,
    rwAccessKey: (process.env.STORAGE_S3_ACCESS_KEY || '').trim() || undefined,
    rwSecretKey: (process.env.STORAGE_S3_SECRET_KEY || '').trim() || undefined,
    forcePathStyle,
    writeSentinel,
    enforcePrivatePolicy,
    probeRw,
    maxAttempts,
    retryDelayMs,
  });
  console.log(JSON.stringify(summary));
}
