import { S3Client, HeadBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type postgres from 'postgres';
import type { StorageProvider } from './storage-provider';

export const STORAGE_SENTINEL_KEY = '.nstack-storage-sentinel.json';

export type MigrationPhase =
  | 'planned'
  | 'precopied'
  | 'source_fenced'
  | 'backed_up'
  | 'synced'
  | 'verified'
  | 'switch_prepared'
  | 'db_switched'
  | 'config_switched'
  | 'start_intent'
  | 'started'
  | 'committed'
  | 'rolling_back'
  | 'rolled_back'
  | 'source_retired'
  | 'aborted_restore';

export interface StorageSentinelDocument {
  version: 1;
  provider: StorageProvider;
  sentinel_id: string;
  bucket: string;
  created_at: string;
}

export interface MigrationRunGuardRow {
  run_id: string;
  phase: MigrationPhase;
  source_provider: StorageProvider;
  target_provider: 'minio' | 'seaweedfs';
  target_sentinel_id: string | null;
  rollback_from_phase: MigrationPhase | null;
}

export class StorageStartupGuardError extends Error {
  readonly code: string;
  readonly runId?: string;
  readonly phase?: MigrationPhase;

  constructor(code: string, message: string, details?: { runId?: string; phase?: MigrationPhase }) {
    super(message);
    this.name = 'StorageStartupGuardError';
    this.code = code;
    this.runId = details?.runId;
    this.phase = details?.phase;
  }
}

const BLOCKED_INTERMEDIATE_PHASES = new Set<MigrationPhase>([
  'source_fenced',
  'backed_up',
  'synced',
  'verified',
  'switch_prepared',
  'db_switched',
  'config_switched',
]);

export interface StartupGuardDecision {
  allowed: true;
  latestRun: MigrationRunGuardRow | null;
  expectedSentinelId: string | null;
  expectedProvider: StorageProvider | null;
}

/**
 * Evaluate the normative §7.6 startup guard against `storage_migration_runs`.
 *
 * - `aborted_restore` runs are always ignored so restored clones boot cleanly.
 * - Quiesced and intermediate switch phases (`source_fenced` through `config_switched`)
 *   always refuse startup to preserve snapshot and ETag/config consistency.
 * - `start_intent` allows startup ONLY when explicitly authorized by `cutover --resume`
 *   via `NSTACK_MIGRATION_START_RUN_ID=<run_id>` and configured provider matches target.
 * - `rolling_back` after a fence or switch allows startup ONLY for the rollback launcher
 *   (`NSTACK_MIGRATION_START_RUN_ID=<run_id>`) on the source provider; a rollback that
 *   began before any fence (RB0) behaves like `precopied`.
 * - `planned` / `precopied` / `rolled_back` require configured provider == source_provider.
 * - `started` / `committed` / `source_retired` require configured provider == target_provider.
 */
export async function checkStorageMigrationStartupGuard(
  sql: ReturnType<typeof postgres>,
  options: {
    provider: StorageProvider;
    startRunId?: string | null;
  },
): Promise<StartupGuardDecision> {
  const [tableCheck] = await sql<{ exists: string | null }[]>`
    SELECT to_regclass('public.storage_migration_runs')::text AS exists
  `;
  if (!tableCheck?.exists) {
    return { allowed: true, latestRun: null, expectedSentinelId: null, expectedProvider: null };
  }

  const [latest] = await sql<MigrationRunGuardRow[]>`
    SELECT run_id::text, phase, source_provider, target_provider, target_sentinel_id, rollback_from_phase
    FROM storage_migration_runs
    WHERE phase <> 'aborted_restore'
    ORDER BY created_at DESC, run_id DESC
    LIMIT 1
  `;

  if (!latest) {
    return { allowed: true, latestRun: null, expectedSentinelId: null, expectedProvider: null };
  }

  if (BLOCKED_INTERMEDIATE_PHASES.has(latest.phase)) {
    throw new StorageStartupGuardError(
      'migration_phase_blocks_startup',
      `Refusing to start NStack: storage migration run ${latest.run_id} is in intermediate phase "${latest.phase}". Finish via cutover --resume or run rollback first.`,
      { runId: latest.run_id, phase: latest.phase },
    );
  }

  if (latest.phase === 'start_intent') {
    const startRunId = String(options.startRunId || '').trim();
    if (!startRunId || startRunId !== latest.run_id) {
      throw new StorageStartupGuardError(
        'migration_start_intent_requires_resume',
        `Refusing to start NStack: storage migration run ${latest.run_id} is in phase "start_intent". Start NStack only via cutover --resume (which supplies NSTACK_MIGRATION_START_RUN_ID).`,
        { runId: latest.run_id, phase: latest.phase },
      );
    }
    if (options.provider !== latest.target_provider) {
      throw new StorageStartupGuardError(
        'migration_provider_mismatch',
        `Refusing to start NStack: migration run ${latest.run_id} targets "${latest.target_provider}" in phase "start_intent", but configured STORAGE_PROVIDER is "${options.provider}".`,
        { runId: latest.run_id, phase: latest.phase },
      );
    }
    return {
      allowed: true,
      latestRun: latest,
      expectedSentinelId: latest.target_sentinel_id,
      expectedProvider: latest.target_provider,
    };
  }

  if (latest.phase === 'rolling_back' && latest.rollback_from_phase !== 'planned' && latest.rollback_from_phase !== 'precopied') {
    const startRunId = String(options.startRunId || '').trim();
    if (!startRunId || startRunId !== latest.run_id) {
      throw new StorageStartupGuardError(
        'migration_rollback_in_progress',
        `Refusing to start NStack: storage migration run ${latest.run_id} is rolling back. Finish via the migration rollback command, which starts NStack on the source.`,
        { runId: latest.run_id, phase: latest.phase },
      );
    }
    if (options.provider !== latest.source_provider) {
      throw new StorageStartupGuardError(
        'migration_provider_mismatch',
        `Refusing to start NStack: rollback of run ${latest.run_id} returns to "${latest.source_provider}", but configured STORAGE_PROVIDER is "${options.provider}".`,
        { runId: latest.run_id, phase: latest.phase },
      );
    }
    return { allowed: true, latestRun: latest, expectedSentinelId: null, expectedProvider: latest.source_provider };
  }

  if (latest.phase === 'started' || latest.phase === 'committed' || latest.phase === 'source_retired') {
    if (options.provider !== latest.target_provider) {
      throw new StorageStartupGuardError(
        'migration_provider_mismatch',
        `Refusing to start NStack: migration run ${latest.run_id} (${latest.phase}) switched storage to "${latest.target_provider}", but configured STORAGE_PROVIDER is "${options.provider}".`,
        { runId: latest.run_id, phase: latest.phase },
      );
    }
    return {
      allowed: true,
      latestRun: latest,
      expectedSentinelId: latest.target_sentinel_id,
      expectedProvider: latest.target_provider,
    };
  }

  // planned, precopied, rolled_back, and RB0 rolling_back
  if (options.provider !== latest.source_provider) {
    throw new StorageStartupGuardError(
      'migration_provider_mismatch',
      `Refusing to start NStack: migration run ${latest.run_id} (${latest.phase}) expects source provider "${latest.source_provider}", but configured STORAGE_PROVIDER is "${options.provider}".`,
      { runId: latest.run_id, phase: latest.phase },
    );
  }

  return {
    allowed: true,
    latestRun: latest,
    expectedSentinelId: null,
    expectedProvider: latest.source_provider,
  };
}

export function parseStorageSentinel(raw: string): StorageSentinelDocument {
  let parsed: Partial<StorageSentinelDocument>;
  try {
    parsed = JSON.parse(raw) as Partial<StorageSentinelDocument>;
  } catch {
    throw new StorageStartupGuardError(
      'storage_sentinel_invalid',
      `Invalid ${STORAGE_SENTINEL_KEY} JSON in active storage bucket.`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.version !== 1 ||
    !['seaweedfs', 'minio', 'external-s3'].includes(String(parsed.provider)) ||
    typeof parsed.sentinel_id !== 'string' ||
    parsed.sentinel_id.trim().length < 8 ||
    typeof parsed.bucket !== 'string' ||
    !parsed.bucket.trim()
  ) {
    throw new StorageStartupGuardError(
      'storage_sentinel_invalid',
      `Invalid ${STORAGE_SENTINEL_KEY} document in active storage bucket.`,
    );
  }
  return parsed as StorageSentinelDocument;
}

export interface StorageReadinessOptions {
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  expectedSentinelId?: string | null;
  requireSentinel?: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  client?: Pick<S3Client, 'send'>;
}

function isNotFoundError(error: any): boolean {
  const status = error?.$metadata?.httpStatusCode;
  const code = error?.name || error?.Code;
  return status === 404 || code === 'NoSuchKey' || code === 'NotFound';
}

async function readBodyToString(body: any): Promise<string> {
  if (!body) return '';
  if (typeof body.transformToString === 'function') {
    return body.transformToString('utf-8');
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Authenticated storage readiness & sentinel verification.
 * Replaces hard Compose `depends_on: minio-init` with provider-agnostic authenticated readiness.
 */
export async function verifyAuthenticatedStorageReadiness(
  options: StorageReadinessOptions,
): Promise<{ sentinel: StorageSentinelDocument | null }> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 20);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1500);
  const s3 =
    options.client ??
    new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 1,
      credentials: {
        accessKeyId: options.accessKey,
        secretAccessKey: options.secretKey,
      },
    });

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: options.bucket }));

      let sentinel: StorageSentinelDocument | null = null;
      try {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: STORAGE_SENTINEL_KEY }),
        );
        sentinel = parseStorageSentinel(await readBodyToString(res.Body));
      } catch (err: any) {
        if (err instanceof StorageStartupGuardError) throw err;
        if (!isNotFoundError(err)) throw err;
      }

      if (sentinel) {
        if (sentinel.provider !== options.provider) {
          throw new StorageStartupGuardError(
            'storage_sentinel_provider_mismatch',
            `Storage bucket "${options.bucket}" sentinel declares provider "${sentinel.provider}", but NStack is configured for "${options.provider}".`,
          );
        }
        if (sentinel.bucket !== options.bucket) {
          throw new StorageStartupGuardError(
            'storage_sentinel_bucket_mismatch',
            `Storage sentinel bucket "${sentinel.bucket}" does not match configured bucket "${options.bucket}".`,
          );
        }
        if (options.expectedSentinelId && sentinel.sentinel_id !== options.expectedSentinelId) {
          throw new StorageStartupGuardError(
            'storage_sentinel_id_mismatch',
            `Storage bucket sentinel ID "${sentinel.sentinel_id}" does not match migration journal target_sentinel_id "${options.expectedSentinelId}".`,
          );
        }
      } else if (options.expectedSentinelId || options.requireSentinel) {
        throw new StorageStartupGuardError(
          'storage_sentinel_missing',
          `Required storage sentinel "${STORAGE_SENTINEL_KEY}" is missing from bucket "${options.bucket}" (provider "${options.provider}").`,
        );
      }

      return { sentinel };
    } catch (err) {
      if (err instanceof StorageStartupGuardError) {
        // Policy / sentinel conflicts are fatal — never mask them with retries unless missing during init race.
        if (err.code !== 'storage_sentinel_missing' || attempt === maxAttempts) {
          throw err;
        }
      }
      lastError = err;
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await Bun.sleep(retryDelayMs);
      }
    }
  }

  throw new StorageStartupGuardError(
    'storage_not_ready',
    `Authenticated storage readiness failed for provider "${options.provider}" at ${options.endpoint} (bucket "${options.bucket}") after ${maxAttempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
