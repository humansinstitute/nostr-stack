import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import {
  resolveProdComposeProfiles,
  resolveStorageProviderConfig,
} from '../src/services/storage-provider';
import {
  checkStorageMigrationStartupGuard,
  STORAGE_SENTINEL_KEY,
  StorageStartupGuardError,
  verifyAuthenticatedStorageReadiness,
  type MigrationPhase,
} from '../src/services/storage-startup-guard';
import {
  completeStorageObject,
  enableInMemoryStorageForTest,
  prepareStorageObjectForAuthorizedOwner,
  resetInMemoryStorageForTest,
  setStorageIntegrityAlertHandler,
  verifyStorageIdentity,
  writeAuthorizedStorageBytes,
  writeStorageObject,
  type StorageIntegrityAlert,
} from '../src/services/storage';

const TEST_DB = 'tower_test_storage_hardening';
const secret = new Uint8Array(32).fill(91);
const owner = nip19.npubEncode(getPublicKey(secret));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let sql: ReturnType<typeof postgres>;
const alerts: StorageIntegrityAlert[] = [];

beforeAll(async () => {
  const opts = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };
  const admin = postgres({ ...opts, database: 'postgres' });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  sql = postgres({ ...opts, database: TEST_DB });
  setDb(sql);
  for (const stmt of splitSqlStatements(
    readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'),
  )) {
    await sql.unsafe(stmt);
  }
  await sql.unsafe(
    readFileSync(new URL('../src/schema/storage-migration-v1.sql', import.meta.url), 'utf8'),
  );
  enableInMemoryStorageForTest();
  setStorageIntegrityAlertHandler((a) => alerts.push(a));
});

beforeEach(async () => {
  alerts.length = 0;
  await sql`DELETE FROM storage_migration_runs`;
});

afterAll(async () => {
  setStorageIntegrityAlertHandler(null);
  resetInMemoryStorageForTest();
  if (sql) await sql.end();
});

describe('E2 storage provider resolution', () => {
  test('infers minio when STORAGE_PROVIDER is unset and endpoint is unset or bundled minio', () => {
    expect(resolveStorageProviderConfig({})).toEqual({
      provider: 'minio',
      explicit: false,
      endpoint: 'http://127.0.0.1:9000',
    });
    expect(resolveStorageProviderConfig({ STORAGE_S3_ENDPOINT: 'http://minio:9000' })).toEqual({
      provider: 'minio',
      explicit: false,
      endpoint: 'http://minio:9000',
    });
    expect(resolveProdComposeProfiles({ STORAGE_S3_ENDPOINT: 'http://minio:9000' })).toEqual(['minio']);
  });

  test('infers external-s3 passthrough without failing when STORAGE_PROVIDER is unset and endpoint is non-minio', () => {
    expect(
      resolveStorageProviderConfig({ STORAGE_S3_ENDPOINT: 'https://s3.external.invalid' }),
    ).toEqual({
      provider: 'external-s3',
      explicit: false,
      endpoint: 'https://s3.external.invalid',
    });
    expect(
      resolveProdComposeProfiles({ STORAGE_S3_ENDPOINT: 'https://s3.external.invalid' }),
    ).toEqual([]);
  });

  test('accepts explicit seaweedfs, minio, and external-s3 with matching endpoints and rejects conflicts', () => {
    expect(resolveStorageProviderConfig({ STORAGE_PROVIDER: 'seaweedfs' })).toEqual({
      provider: 'seaweedfs',
      explicit: true,
      endpoint: 'http://seaweedfs:8333',
    });
    expect(resolveProdComposeProfiles({ STORAGE_PROVIDER: 'seaweedfs' })).toEqual(['seaweedfs']);

    expect(() =>
      resolveStorageProviderConfig({
        STORAGE_PROVIDER: 'seaweedfs',
        STORAGE_S3_ENDPOINT: 'http://minio:9000',
      }),
    ).toThrow(/conflicts/);
    expect(() =>
      resolveStorageProviderConfig({
        STORAGE_PROVIDER: 'minio',
        STORAGE_S3_ENDPOINT: 'http://seaweedfs:8333',
      }),
    ).toThrow(/conflicts/);
    expect(() =>
      resolveStorageProviderConfig({
        STORAGE_PROVIDER: 'external-s3',
        STORAGE_S3_ENDPOINT: 'http://minio:9000',
      }),
    ).toThrow(/conflicts/);
    expect(() =>
      resolveStorageProviderConfig({
        STORAGE_PROVIDER: 'external-s3',
      }),
    ).toThrow(/STORAGE_S3_ENDPOINT must be set/);
    expect(() =>
      resolveStorageProviderConfig({ STORAGE_PROVIDER: 'unknown-s3' }),
    ).toThrow(/Invalid STORAGE_PROVIDER/);
    expect(() =>
      resolveProdComposeProfiles({
        STORAGE_PROVIDER: 'seaweedfs',
        COMPOSE_PROFILES: 'minio',
      }),
    ).toThrow(/COMPOSE_PROFILES/);
  });
});

describe('E3 verifyStorageIdentity immutability guard', () => {
  test('never rewrites non-null sha256_hex or size_bytes on byte tamper and raises an integrity alert', async () => {
    const original = new Uint8Array([10, 20, 30, 40]);
    const prepared = await prepareStorageObjectForAuthorizedOwner(
      { owner_npub: owner, content_type: 'application/octet-stream', size_bytes: original.length },
      owner,
    );
    await writeStorageObject(prepared.id, original, owner);
    const completed = (await completeStorageObject(prepared.id, {}, owner))!;
    expect(completed.sha256_hex).toBe(sha256(original));

    // Overwrite stored bytes out-of-band (same size, different hash).
    await writeAuthorizedStorageBytes(completed, new Uint8Array([10, 20, 30, 99]));
    const result = await verifyStorageIdentity(completed);
    expect(result).toBeNull();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.reason).toBe('sha256_mismatch');
    expect(alerts[0]!.object_id).toBe(completed.id);

    const [dbRow] = await sql`SELECT sha256_hex, size_bytes FROM v4_storage_objects WHERE id = ${completed.id}`;
    expect(dbRow.sha256_hex).toBe(sha256(original));
    expect(Number(dbRow.size_bytes)).toBe(4);
  });

  test('protects zero-byte objects: accepts valid empty bytes and rejects non-empty overwrite', async () => {
    const empty = new Uint8Array([]);
    const prepared = await prepareStorageObjectForAuthorizedOwner(
      { owner_npub: owner, content_type: 'text/plain', size_bytes: 0 },
      owner,
    );
    await writeStorageObject(prepared.id, empty, owner);
    const completed = (await completeStorageObject(prepared.id, {}, owner))!;
    expect(Number(completed.size_bytes)).toBe(0);
    expect(completed.sha256_hex).toBe(sha256(empty));

    // Clear verified ETag to force re-hash verification on zero-byte object.
    await sql`UPDATE v4_storage_objects SET sha256_verified_etag = NULL WHERE id = ${completed.id}`;
    const [reloaded] = await sql<any[]>`SELECT * FROM v4_storage_objects WHERE id = ${completed.id}`;
    const ok = await verifyStorageIdentity(reloaded);
    expect(ok).not.toBeNull();
    expect(Number(ok!.size_bytes)).toBe(0);
    expect(alerts).toHaveLength(0);

    // Overwrite zero-byte object with non-empty bytes while sha256_hex is NULL -> size_bytes=0 still blocks rewrite!
    await sql`UPDATE v4_storage_objects SET sha256_hex = NULL, sha256_verified_etag = NULL WHERE id = ${completed.id}`;
    await writeAuthorizedStorageBytes(completed, new Uint8Array([1, 2, 3]));
    const [reloadedNullHash] = await sql<any[]>`SELECT * FROM v4_storage_objects WHERE id = ${completed.id}`;
    const blocked = await verifyStorageIdentity(reloadedNullHash);
    expect(blocked).toBeNull();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.reason).toBe('size_mismatch');
    expect(alerts[0]!.expected_size).toBe(0);
    expect(alerts[0]!.actual_size).toBe(3);

    const [dbRow] = await sql`SELECT sha256_hex, size_bytes FROM v4_storage_objects WHERE id = ${completed.id}`;
    expect(dbRow.sha256_hex).toBeNull();
    expect(Number(dbRow.size_bytes)).toBe(0);
  });
});

describe('E3 startup guard across every §7.6 migration phase', () => {
  async function insertRun(
    phase: MigrationPhase,
    opts: { runId?: string; source?: 'minio' | 'seaweedfs'; target?: 'minio' | 'seaweedfs'; sentinel?: string | null; from?: MigrationPhase } = {},
  ) {
    const runId = opts.runId ?? randomUUID();
    await sql`
      INSERT INTO storage_migration_runs (run_id, phase, fingerprint, source_provider, target_provider, target_sentinel_id, rollback_from_phase)
      VALUES (${runId}, ${phase}, 'fp-test', ${opts.source ?? 'minio'}, ${opts.target ?? 'seaweedfs'}, ${opts.sentinel ?? 'sentinel-12345678'}, ${opts.from ?? null})
    `;
    return runId;
  }

  test('allows startup when no migration runs exist', async () => {
    const decision = await checkStorageMigrationStartupGuard(sql, { provider: 'minio' });
    expect(decision.allowed).toBe(true);
    expect(decision.latestRun).toBeNull();
  });

  test('blocks startup in every quiesced and intermediate switch phase (source_fenced..config_switched)', async () => {
    const blockedPhases: MigrationPhase[] = [
      'source_fenced',
      'backed_up',
      'synced',
      'verified',
      'switch_prepared',
      'db_switched',
      'config_switched',
    ];
    for (const phase of blockedPhases) {
      await sql`DELETE FROM storage_migration_runs`;
      const runId = await insertRun(phase);
      await expect(
        checkStorageMigrationStartupGuard(sql, { provider: 'minio', startRunId: runId }),
      ).rejects.toMatchObject({ code: 'migration_phase_blocks_startup', phase });
      await expect(
        checkStorageMigrationStartupGuard(sql, { provider: 'seaweedfs', startRunId: runId }),
      ).rejects.toMatchObject({ code: 'migration_phase_blocks_startup', phase });
    }
  });

  test('start_intent requires exact NSTACK_MIGRATION_START_RUN_ID and target provider', async () => {
    const runId = await insertRun('start_intent');
    await expect(
      checkStorageMigrationStartupGuard(sql, { provider: 'seaweedfs' }),
    ).rejects.toMatchObject({ code: 'migration_start_intent_requires_resume' });
    await expect(
      checkStorageMigrationStartupGuard(sql, { provider: 'seaweedfs', startRunId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'migration_start_intent_requires_resume' });
    await expect(
      checkStorageMigrationStartupGuard(sql, { provider: 'minio', startRunId: runId }),
    ).rejects.toMatchObject({ code: 'migration_provider_mismatch' });

    const ok = await checkStorageMigrationStartupGuard(sql, { provider: 'seaweedfs', startRunId: runId });
    expect(ok.allowed).toBe(true);
    expect(ok.expectedSentinelId).toBe('sentinel-12345678');
  });

  test('enforces provider agreement in planned, precopied, rolled_back, started, committed, source_retired', async () => {
    for (const sourcePhase of ['planned', 'precopied', 'rolled_back'] as MigrationPhase[]) {
      await sql`DELETE FROM storage_migration_runs`;
      await insertRun(sourcePhase);
      expect((await checkStorageMigrationStartupGuard(sql, { provider: 'minio' })).allowed).toBe(true);
      await expect(
        checkStorageMigrationStartupGuard(sql, { provider: 'seaweedfs' }),
      ).rejects.toMatchObject({ code: 'migration_provider_mismatch' });
    }
    for (const targetPhase of ['started', 'committed', 'source_retired'] as MigrationPhase[]) {
      await sql`DELETE FROM storage_migration_runs`;
      await insertRun(targetPhase);
      const ok = await checkStorageMigrationStartupGuard(sql, { provider: 'seaweedfs' });
      expect(ok.allowed).toBe(true);
      expect(ok.expectedSentinelId).toBe('sentinel-12345678');
      await expect(
        checkStorageMigrationStartupGuard(sql, { provider: 'minio' }),
      ).rejects.toMatchObject({ code: 'migration_provider_mismatch' });
    }
  });

  test('rolling_back after a fence or switch starts only via the rollback launcher on the source provider', async () => {
    for (const from of ['backed_up', 'config_switched', 'start_intent', 'committed'] as MigrationPhase[]) {
      await sql`DELETE FROM storage_migration_runs`;
      const runId = await insertRun('rolling_back', { from });
      await expect(checkStorageMigrationStartupGuard(sql, { provider: 'minio' })).rejects.toMatchObject({ code: 'migration_rollback_in_progress' });
      await expect(checkStorageMigrationStartupGuard(sql, { provider: 'seaweedfs', startRunId: runId })).rejects.toMatchObject({ code: 'migration_provider_mismatch' });
      const ok = await checkStorageMigrationStartupGuard(sql, { provider: 'minio', startRunId: runId });
      expect(ok.allowed).toBe(true);
      expect(ok.expectedSentinelId).toBeNull();
    }
    // RB0 (nothing fenced): behaves like precopied.
    await sql`DELETE FROM storage_migration_runs`;
    await insertRun('rolling_back', { from: 'precopied' });
    expect((await checkStorageMigrationStartupGuard(sql, { provider: 'minio' })).allowed).toBe(true);
  });

  test('ignores aborted_restore runs so restored clones boot cleanly', async () => {
    await insertRun('aborted_restore');
    const decision = await checkStorageMigrationStartupGuard(sql, { provider: 'minio' });
    expect(decision.allowed).toBe(true);
    expect(decision.latestRun).toBeNull();
  });
});

describe('E3 authenticated storage readiness and sentinel checks', () => {
  function mockClient(sentinelBody: string | 'missing') {
    return {
      send: async (cmd: any) => {
        if (cmd.constructor.name === 'HeadBucketCommand') return { $metadata: { httpStatusCode: 200 } };
        if (cmd.constructor.name === 'GetObjectCommand') {
          expect(cmd.input.Key).toBe(STORAGE_SENTINEL_KEY);
          if (sentinelBody === 'missing') {
            const err: any = new Error('NoSuchKey');
            err.name = 'NoSuchKey';
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return {
            $metadata: { httpStatusCode: 200 },
            Body: { transformToString: async () => sentinelBody },
          };
        }
        throw new Error(`Unexpected command ${cmd.constructor.name}`);
      },
    };
  }

  const baseOpts = {
    provider: 'seaweedfs' as const,
    endpoint: 'http://seaweedfs:8333',
    region: 'us-east-1',
    bucket: 'superbased-storage',
    accessKey: 'k',
    secretKey: 's',
    forcePathStyle: true,
    maxAttempts: 1,
    retryDelayMs: 0,
  };

  test('passes when sentinel matches provider, bucket, and expectedSentinelId', async () => {
    const sentinel = JSON.stringify({
      version: 1,
      provider: 'seaweedfs',
      sentinel_id: 'sentinel-abcdef12',
      bucket: 'superbased-storage',
      created_at: new Date().toISOString(),
    });
    const res = await verifyAuthenticatedStorageReadiness({
      ...baseOpts,
      expectedSentinelId: 'sentinel-abcdef12',
      requireSentinel: true,
      client: mockClient(sentinel),
    });
    expect(res.sentinel?.sentinel_id).toBe('sentinel-abcdef12');
  });

  test('fails closed on provider mismatch, sentinel ID mismatch, or missing required sentinel', async () => {
    const wrongProvider = JSON.stringify({
      version: 1,
      provider: 'minio',
      sentinel_id: 'sentinel-abcdef12',
      bucket: 'superbased-storage',
      created_at: new Date().toISOString(),
    });
    await expect(
      verifyAuthenticatedStorageReadiness({ ...baseOpts, client: mockClient(wrongProvider) }),
    ).rejects.toBeInstanceOf(StorageStartupGuardError);

    const wrongId = JSON.stringify({
      version: 1,
      provider: 'seaweedfs',
      sentinel_id: 'sentinel-other999',
      bucket: 'superbased-storage',
      created_at: new Date().toISOString(),
    });
    await expect(
      verifyAuthenticatedStorageReadiness({
        ...baseOpts,
        expectedSentinelId: 'sentinel-abcdef12',
        client: mockClient(wrongId),
      }),
    ).rejects.toMatchObject({ code: 'storage_sentinel_id_mismatch' });

    await expect(
      verifyAuthenticatedStorageReadiness({
        ...baseOpts,
        requireSentinel: true,
        client: mockClient('missing'),
      }),
    ).rejects.toMatchObject({ code: 'storage_sentinel_missing' });

    // Malformed sentinel JSON must fail fast as storage_sentinel_invalid on attempt 1 (not retry 20x).
    let getCalls = 0;
    const corruptClient = {
      send: async (cmd: any) => {
        if (cmd.constructor.name === 'HeadBucketCommand') return { $metadata: { httpStatusCode: 200 } };
        if (cmd.constructor.name === 'GetObjectCommand') {
          getCalls++;
          return {
            $metadata: { httpStatusCode: 200 },
            Body: { transformToString: async () => '{corrupt-json' },
          };
        }
        throw new Error(`Unexpected ${cmd.constructor.name}`);
      },
    };
    await expect(
      verifyAuthenticatedStorageReadiness({
        ...baseOpts,
        maxAttempts: 5,
        retryDelayMs: 1,
        client: corruptClient,
      }),
    ).rejects.toMatchObject({ code: 'storage_sentinel_invalid' });
    expect(getCalls).toBe(1);
  });

  test('permits legacy bucket without sentinel when sentinel is not required', async () => {
    const res = await verifyAuthenticatedStorageReadiness({
      ...baseOpts,
      provider: 'minio',
      requireSentinel: false,
      expectedSentinelId: null,
      client: mockClient('missing'),
    });
    expect(res.sentinel).toBeNull();
  });
});

describe('E2 storage-init provider-neutral initializer', () => {
  test('creates bucket, writes and parses real JSON sentinel with newline, and runs RW probe', async () => {
    const { initializeStorageBucket } = await import('../src/scripts/storage-init');
    const store = new Map<string, { body: Buffer; contentType?: string }>();
    let bucketExists = false;
    let bucketPolicy: string | null = '{"Version":"2012-10-17","Statement":[]}';
    const commands: string[] = [];

    const client = {
      send: async (cmd: any) => {
        const name = cmd.constructor.name;
        commands.push(name);
        if (name === 'HeadBucketCommand') {
          if (!bucketExists) {
            const err: any = new Error('NotFound');
            err.name = 'NotFound';
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return { $metadata: { httpStatusCode: 200 } };
        }
        if (name === 'CreateBucketCommand') {
          bucketExists = true;
          return { $metadata: { httpStatusCode: 200 } };
        }
        if (name === 'GetBucketVersioningCommand') {
          return { $metadata: { httpStatusCode: 200 } };
        }
        if (name === 'GetBucketPolicyCommand') {
          if (!bucketPolicy) {
            const err: any = new Error('NoSuchBucketPolicy');
            err.name = 'NoSuchBucketPolicy';
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return { $metadata: { httpStatusCode: 200 }, Policy: bucketPolicy };
        }
        if (name === 'DeleteBucketPolicyCommand') {
          bucketPolicy = null;
          return { $metadata: { httpStatusCode: 204 } };
        }
        if (name === 'PutObjectCommand') {
          store.set(cmd.input.Key, {
            body: Buffer.from(cmd.input.Body),
            contentType: cmd.input.ContentType,
          });
          return { $metadata: { httpStatusCode: 200 }, ETag: '"etag1"' };
        }
        if (name === 'GetObjectCommand') {
          const item = store.get(cmd.input.Key);
          if (!item) {
            const err: any = new Error('NoSuchKey');
            err.name = 'NoSuchKey';
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return {
            $metadata: { httpStatusCode: 200 },
            Body: { transformToByteArray: async () => new Uint8Array(item.body) },
          };
        }
        if (name === 'HeadObjectCommand') {
          const item = store.get(cmd.input.Key);
          if (!item) {
            const err: any = new Error('NotFound');
            err.name = 'NotFound';
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return { $metadata: { httpStatusCode: 200 }, ContentLength: item.body.byteLength };
        }
        if (name === 'DeleteObjectCommand') {
          store.delete(cmd.input.Key);
          return { $metadata: { httpStatusCode: 204 } };
        }
        throw new Error(`Unexpected command ${name}`);
      },
    };

    const anonDeniedFetch = (async () => new Response('AccessDenied', { status: 403 })) as unknown as typeof fetch;

    // 1. SeaweedFS fresh bucket: creates bucket, writes real newline-terminated JSON sentinel, verifies readback + RW probe
    const first = await initializeStorageBucket(
      {
        provider: 'seaweedfs',
        endpoint: 'http://seaweedfs:8333',
        region: 'us-east-1',
        bucket: 'nstack-test',
        adminAccessKey: 'adm',
        adminSecretKey: 'adm-sec',
        rwAccessKey: 'app',
        rwSecretKey: 'app-sec',
        forcePathStyle: true,
        writeSentinel: true,
        probeRw: true,
        maxAttempts: 1,
        retryDelayMs: 0,
      },
      { admin: client, rw: client, fetchImpl: anonDeniedFetch },
    );
    expect(first.created).toBe(true);
    expect(first.sentinel_id).toBeTruthy();
    expect(first.rw_probe_passed).toBe(true);
    expect(first.anonymous_policy).toBe('private_verified');
    const rawSentinel = store.get(STORAGE_SENTINEL_KEY)!.body.toString('utf8');
    expect(rawSentinel.endsWith('\n')).toBe(true);
    expect(rawSentinel).not.toContain('\\n');
    expect(JSON.parse(rawSentinel).sentinel_id).toBe(first.sentinel_id);

    // 2. Re-running preserves existing sentinel_id without overwriting
    const second = await initializeStorageBucket(
      {
        provider: 'seaweedfs',
        endpoint: 'http://seaweedfs:8333',
        region: 'us-east-1',
        bucket: 'nstack-test',
        adminAccessKey: 'adm',
        adminSecretKey: 'adm-sec',
        forcePathStyle: true,
        writeSentinel: true,
        probeRw: false,
        maxAttempts: 1,
        retryDelayMs: 0,
      },
      { admin: client, fetchImpl: anonDeniedFetch },
    );
    expect(second.created).toBe(false);
    expect(second.sentinel_id).toBe(first.sentinel_id);

    // 3. MinIO bucket clears public policy (mc anonymous set none equivalent) and rejects anonymous 200
    const minioRes = await initializeStorageBucket(
      {
        provider: 'minio',
        endpoint: 'http://minio:9000',
        region: 'us-east-1',
        bucket: 'nstack-test',
        adminAccessKey: 'adm',
        adminSecretKey: 'adm-sec',
        forcePathStyle: true,
        writeSentinel: false,
        probeRw: false,
        maxAttempts: 1,
        retryDelayMs: 0,
      },
      { admin: client, fetchImpl: anonDeniedFetch },
    );
    expect(minioRes.anonymous_policy).toBe('policy_cleared');
    expect(bucketPolicy).toBeNull();
    expect(commands).toContain('DeleteBucketPolicyCommand');

    const anonAllowedFetch = (async () => new Response('<ListBucketResult/>', { status: 200 })) as unknown as typeof fetch;
    await expect(
      initializeStorageBucket(
        {
          provider: 'minio',
          endpoint: 'http://minio:9000',
          region: 'us-east-1',
          bucket: 'nstack-test',
          adminAccessKey: 'adm',
          adminSecretKey: 'adm-sec',
          forcePathStyle: true,
          writeSentinel: false,
          probeRw: false,
          maxAttempts: 1,
          retryDelayMs: 0,
        },
        { admin: client, fetchImpl: anonAllowedFetch },
      ),
    ).rejects.toThrow(/anonymous GET/);
  });
});
