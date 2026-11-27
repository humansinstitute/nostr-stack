import postgres from 'postgres';
import { getPublicKey, nip19 } from 'nostr-tools';
import { resolveStorageProviderConfig, type StorageProvider } from '../services/storage-provider';
import {
  beginRollbackRb1,
  cleanupMigrationProbes,
  commitMigrationRun,
  finishMigrationRollback,
  getMigrationStatus,
  markMigrationPhase,
  MIGRATION_EXIT,
  MigrationError,
  prepareMigrationSwitch,
  requireJournalSchema,
  resetMigrationSnapshot,
  rewriteMigrationEtags,
  runMigrationDelta,
  runMigrationPrecopy,
  runMigrationPreflight,
  runMigrationSmoke,
  runMigrationVerify,
  runReverseMigrateSync,
  type MigrationContext,
} from '../services/storage-migration';
import type { MigrationPhase } from '../services/storage-startup-guard';

// Data CLI for the storage migration. It runs in a one-off container with DB and
// internal storage network access only: no Docker socket, no host files, no Tower
// runtime configuration. Every input arrives as an explicit environment variable.

function parseFlags(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] || '', flags };
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function flagNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = flagString(flags, name);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new MigrationError(MIGRATION_EXIT.USAGE, 'invalid_numeric_flag', `Invalid --${name}: ${raw}`);
  return n;
}

function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  const v = flags[name];
  return v === true || (typeof v === 'string' && /^(1|true|yes|on)$/i.test(v));
}

function flagJson(flags: Record<string, string | boolean>, name: string): Record<string, unknown> | undefined {
  const raw = flagString(flags, name);
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new MigrationError(MIGRATION_EXIT.USAGE, 'invalid_json_flag', `--${name} must be a JSON object.`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MigrationError(MIGRATION_EXIT.USAGE, 'invalid_json_flag', `--${name} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new MigrationError(MIGRATION_EXIT.USAGE, 'missing_env', `${name} must be set.`);
  return value;
}

function boolEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === '') return fallback;
  return !/^(false|0|no)$/i.test(value.trim());
}

function resolveServiceIdentity(env: Record<string, string | undefined>) {
  const nsec = String(env.SUPERBASED_SERVICE_NSEC || '').trim();
  const explicit = String(env.SUPERBASED_SERVICE_NPUB || '').trim();
  let derived: string | undefined;
  if (nsec) {
    let decoded: ReturnType<typeof nip19.decode> | null = null;
    try { decoded = nip19.decode(nsec); } catch { decoded = null; }
    if (!decoded || decoded.type !== 'nsec') throw new MigrationError(MIGRATION_EXIT.USAGE, 'invalid_service_nsec', 'SUPERBASED_SERVICE_NSEC is not a valid nsec.');
    derived = nip19.npubEncode(getPublicKey(decoded.data as Uint8Array));
  }
  if (explicit && derived && explicit !== derived) throw new MigrationError(MIGRATION_EXIT.USAGE, 'service_identity_conflict', 'SUPERBASED_SERVICE_NPUB does not match SUPERBASED_SERVICE_NSEC.');
  const npub = derived ?? explicit;
  if (!npub.startsWith('npub1')) throw new MigrationError(MIGRATION_EXIT.USAGE, 'missing_service_identity', 'SUPERBASED_SERVICE_NSEC or SUPERBASED_SERVICE_NPUB must be set.');
  return { npub, nsec: nsec || undefined };
}

export function buildMigrationContext(env: Record<string, string | undefined>, sql: ReturnType<typeof postgres>): MigrationContext {
  // The source is always described explicitly; Tower's own STORAGE_PROVIDER is never inherited
  // (it names the target once the config switched).
  const sourceProvider = required(env, 'STORAGE_S3_SOURCE_PROVIDER');
  const sourceResolved = resolveStorageProviderConfig({ STORAGE_PROVIDER: sourceProvider, STORAGE_S3_ENDPOINT: required(env, 'STORAGE_S3_SOURCE_ENDPOINT') });
  const targetProvider = String(env.STORAGE_S3_TARGET_PROVIDER || 'seaweedfs').trim().toLowerCase();
  if (targetProvider !== 'seaweedfs' && targetProvider !== 'minio') {
    throw new MigrationError(MIGRATION_EXIT.USAGE, 'invalid_target_provider', `Unsupported target provider "${targetProvider}".`);
  }
  const targetResolved = resolveStorageProviderConfig({ STORAGE_PROVIDER: targetProvider, STORAGE_S3_ENDPOINT: required(env, 'STORAGE_S3_TARGET_ENDPOINT') });
  if (sourceResolved.provider === targetResolved.provider) throw new MigrationError(MIGRATION_EXIT.USAGE, 'same_provider', 'Source and target providers must differ.');
  const sourceBucket = required(env, 'STORAGE_S3_SOURCE_BUCKET');
  const sourceAccessKey = required(env, 'STORAGE_S3_SOURCE_ACCESS_KEY');
  const targetAccessKey = required(env, 'STORAGE_S3_TARGET_ACCESS_KEY');
  if (sourceAccessKey === targetAccessKey) throw new MigrationError(MIGRATION_EXIT.PREFLIGHT_BLOCK, 'credentials_reused', 'Target credentials must be distinct from the source credentials.');
  const identity = resolveServiceIdentity(env);
  return {
    sql,
    serviceNpub: identity.npub,
    serviceNsec: identity.nsec,
    source: {
      provider: sourceResolved.provider as StorageProvider,
      endpoint: sourceResolved.endpoint,
      region: String(env.STORAGE_S3_SOURCE_REGION || 'us-east-1').trim(),
      bucket: sourceBucket,
      accessKey: sourceAccessKey,
      secretKey: required(env, 'STORAGE_S3_SOURCE_SECRET_KEY'),
      forcePathStyle: boolEnv(env.STORAGE_S3_SOURCE_FORCE_PATH_STYLE, true),
    },
    target: {
      provider: targetResolved.provider as 'minio' | 'seaweedfs',
      endpoint: targetResolved.endpoint,
      region: String(env.STORAGE_S3_TARGET_REGION || 'us-east-1').trim(),
      bucket: String(env.STORAGE_S3_TARGET_BUCKET || sourceBucket).trim(),
      accessKey: targetAccessKey,
      secretKey: required(env, 'STORAGE_S3_TARGET_SECRET_KEY'),
      forcePathStyle: boolEnv(env.STORAGE_S3_TARGET_FORCE_PATH_STYLE, true),
    },
    sourceIdentity: required(env, 'STORAGE_MIGRATION_SOURCE_IDENTITY'),
    requestTimeoutMs: Number(env.STORAGE_MIGRATION_REQUEST_TIMEOUT_MS || 120_000),
  };
}

function usage(): string {
  return `Usage: bun run nstack:migrate-storage <command> [flags]

Data CLI (DB + internal storage networks only). Operators normally use the host
orchestrator: bun scripts/nstack-migrate-storage-host.ts <command>.

  preflight         Read-only inventory, feature, sentinel, disk and fingerprint checks
  precopy           Online resumable warm copy (--run-id, --concurrency <=4, --max-mbps)
  delta             Cutover steps 5-7 (eligibility purge, delta copy, identity check)
  verify            Step 9 read-back + listing parity; --published [--strict] after the
                    post-switch SeaweedFS recreate; --standalone [--store source|target]
  prepare-switch    Step 10 (--old-config-digest, --new-config-digest)
  rewrite-etags     Step 11 single-transaction ETag rewrite
  mark              Host step marker (--phase, --run-id, --source-boot-id, --fence-identity JSON,
                    --verified-backup-dir, --backup-manifest-sha256, --config-digest, --evidence JSON)
  reset-snapshot    Invalidated quiesced snapshot: exact ETag revert, back to precopied (--reason)
  rollback-begin    RB1: exact ETag revert, phase rolling_back
  reverse-sync      RB2: copy target -> source, deletes, ETag reconciliation (phase rolling_back)
  rollback-finish   rolling_back -> rolled_back after the host restored the source (--evidence JSON)
  smoke-data        Live smoke (--api-url, --store target|source, --expected-public-endpoint, --check-public-put)
  cleanup-probes    Remove uncleaned smoke probes (--run-id, --store)
  commit            started -> committed (requires passing target smoke)
  status            Phase, counts, boundary, next command (--check-target-readable)`;
}

const READ_ONLY = new Set(['preflight', 'status']);

async function main() {
  const { command, flags } = parseFlags(process.argv.slice(2));
  if (!command || command === 'help' || flagBool(flags, 'help')) {
    console.log(usage());
    process.exit(MIGRATION_EXIT.OK);
  }
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    const env = process.env;
    sql = postgres({
      host: required(env, 'DB_HOST'),
      port: Number(env.DB_PORT || 5432),
      database: required(env, 'DB_NAME'),
      username: required(env, 'DB_USER'),
      password: required(env, 'DB_PASSWORD'),
      max: 6,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
    const ctx = buildMigrationContext(env, sql);
    const standaloneVerify = command === 'verify' && flagBool(flags, 'standalone');
    if (!READ_ONLY.has(command) && !standaloneVerify) await requireJournalSchema(sql);
    const store = (flagString(flags, 'store') ?? 'target') as 'target' | 'source';
    if (store !== 'target' && store !== 'source') throw new MigrationError(MIGRATION_EXIT.USAGE, 'invalid_store', '--store must be target or source.');

    let output: unknown;
    switch (command) {
      case 'preflight':
        output = await runMigrationPreflight(ctx, { diskFreeBytes: flagNumber(flags, 'disk-free-bytes'), concurrency: flagNumber(flags, 'concurrency') });
        break;
      case 'precopy':
        output = await runMigrationPrecopy(ctx, { concurrency: flagNumber(flags, 'concurrency'), maxMbps: flagNumber(flags, 'max-mbps'), runId: flagString(flags, 'run-id') });
        break;
      case 'delta':
        output = await runMigrationDelta(ctx, { concurrency: flagNumber(flags, 'concurrency'), maxMbps: flagNumber(flags, 'max-mbps') });
        break;
      case 'verify':
        output = await runMigrationVerify(ctx, { concurrency: flagNumber(flags, 'concurrency'), standalone: standaloneVerify, published: flagBool(flags, 'published'), strict: flagBool(flags, 'strict'), store, targetBootId: flagString(flags, 'target-boot-id') });
        break;
      case 'prepare-switch':
        output = await prepareMigrationSwitch(ctx, { oldConfigDigest: flagString(flags, 'old-config-digest') || '', newConfigDigest: flagString(flags, 'new-config-digest') || '' });
        break;
      case 'rewrite-etags':
        output = await rewriteMigrationEtags(ctx);
        break;
      case 'reset-snapshot':
        output = await resetMigrationSnapshot(ctx, flagString(flags, 'reason') || 'snapshot_invalidated');
        break;
      case 'rollback-begin':
        output = await beginRollbackRb1(ctx);
        break;
      case 'reverse-sync':
        output = await runReverseMigrateSync(ctx, { concurrency: flagNumber(flags, 'concurrency') });
        break;
      case 'rollback-finish':
        output = await finishMigrationRollback(ctx, flagJson(flags, 'evidence') ?? {});
        break;
      case 'mark': {
        const phase = flagString(flags, 'phase') as MigrationPhase | undefined;
        if (!phase) throw new MigrationError(MIGRATION_EXIT.USAGE, 'missing_phase', '--phase is required for mark.');
        output = await markMigrationPhase(ctx, {
          phase,
          runId: flagString(flags, 'run-id'),
          sourceBootId: flagString(flags, 'source-boot-id'),
          targetBootId: flagString(flags, 'target-boot-id'),
          fenceIdentity: flagJson(flags, 'fence-identity'),
          verifiedBackupDir: flagString(flags, 'verified-backup-dir'),
          backupManifestSha256: flagString(flags, 'backup-manifest-sha256'),
          configDigest: flagString(flags, 'config-digest'),
          evidence: flagJson(flags, 'evidence'),
        });
        break;
      }
      case 'smoke-data':
        output = await runMigrationSmoke(ctx, {
          apiBaseUrl: flagString(flags, 'api-url') || 'http://tower:3100',
          expectedPublicEndpoint: flagString(flags, 'expected-public-endpoint'),
          checkPublicDirectPut: flagBool(flags, 'check-public-put'),
          sampleCount: flagNumber(flags, 'sample-count'),
          store,
        });
        break;
      case 'cleanup-probes':
        output = await cleanupMigrationProbes(ctx, { runId: flagString(flags, 'run-id'), store: flagString(flags, 'store') as 'target' | 'source' | undefined });
        break;
      case 'commit':
        output = await commitMigrationRun(ctx);
        break;
      case 'status':
        output = await getMigrationStatus(ctx, { checkTargetReadable: flagBool(flags, 'check-target-readable') });
        break;
      default:
        throw new MigrationError(MIGRATION_EXIT.USAGE, 'unknown_command', `Unknown command "${command}". Run with --help for usage.`);
    }
    console.log(JSON.stringify(output, null, 2));
    await sql.end({ timeout: 5 });
    process.exit(MIGRATION_EXIT.OK);
  } catch (err) {
    await sql?.end({ timeout: 5 }).catch(() => {});
    if (err instanceof MigrationError) {
      console.error(JSON.stringify({ ok: false, exit_code: err.exitCode, code: err.code, error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) }, null, 2));
      process.exit(err.exitCode);
    }
    console.error(JSON.stringify({ ok: false, exit_code: 1, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) }, null, 2));
    process.exit(1);
  }
}

if (import.meta.main) await main();
