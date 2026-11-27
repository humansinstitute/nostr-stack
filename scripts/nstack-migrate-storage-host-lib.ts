// Pure helpers for the storage migration host orchestrator: env-file parsing and
// rendering, config digests, the host operation lock and container fence checks.
// Kept free of Docker calls so they are unit tested directly.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, constants } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';

export const EXIT = {
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

export class HostError extends Error {
  constructor(readonly exitCode: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'HostError';
  }
}

export function sha256Hex(data: string | Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

export function fileDigest(path: string) {
  return sha256Hex(readFileSync(path));
}

/** Docker Compose env-file subset: KEY=VALUE, optional quotes, full-line and unquoted inline comments. */
export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.lastIndexOf('"') > 0) || (value.startsWith("'") && value.lastIndexOf("'") > 0)) {
      value = value.slice(1, value.lastIndexOf(value[0]!));
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out.set(key, value);
  }
  return out;
}

export function readEnvFile(path: string) {
  return parseEnvText(readFileSync(path, 'utf8'));
}

const SAFE_SECRET = /^[A-Za-z0-9._~+\/=:-]{16,256}$/;
const SAFE_ACCESS_KEY = /^[A-Za-z0-9._~+\/=:-]{3,128}$/;

/** Values written into env files must survive Compose interpolation and the SeaweedFS renderer unchanged. */
export function assertSafeCredential(name: string, value: string, kind: 'access' | 'secret') {
  if (!(kind === 'secret' ? SAFE_SECRET : SAFE_ACCESS_KEY).test(value) || value.includes('$')) {
    throw new HostError(EXIT.PREFLIGHT_BLOCK, `${name} has unsupported characters or length (allowed: A-Z a-z 0-9 . _ ~ + / = : -).`);
  }
}

/** Strict http(s) URL without credentials, query, fragment, whitespace or shell/compose metacharacters. */
export function assertSafeUrl(name: string, value: string, options: { allowPath?: boolean } = {}) {
  if (!value || /[\s"'`$\\;&|<>(){}]/.test(value)) throw new HostError(EXIT.PREFLIGHT_BLOCK, `${name} is not a safe URL.`);
  let url: URL;
  try { url = new URL(value); } catch { throw new HostError(EXIT.PREFLIGHT_BLOCK, `${name} is not a valid URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new HostError(EXIT.PREFLIGHT_BLOCK, `${name} must be an http(s) URL without credentials, query or fragment.`);
  }
  if (!options.allowPath && url.pathname !== '/' && url.pathname !== '') throw new HostError(EXIT.PREFLIGHT_BLOCK, `${name} must not contain a path.`);
  return url;
}

export function generateCredential(kind: 'access' | 'secret') {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  if (kind === 'access') {
    const bytes = randomBytes(20);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  }
  return randomBytes(30).toString('base64url').replace(/[-_]/g, 'x');
}

/** Write a file atomically (temp file in the same directory, fsync, rename) with the given mode. */
export function atomicWrite(path: string, content: string | Buffer, mode = 0o600) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    writeSync(fd, typeof content === 'string' ? Buffer.from(content) : content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dirFd = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* directory fsync is best effort on some platforms */ }
}

/**
 * Replace `path` only if its current digest equals `expectedDigest` (config CAS).
 * Returns 'replaced', or 'already' when it already holds `content`.
 */
export function casReplaceFile(path: string, expectedDigest: string, content: string): 'replaced' | 'already' {
  const current = existsSync(path) ? fileDigest(path) : null;
  const next = sha256Hex(content);
  if (current === next) return 'already';
  if (current !== expectedDigest) {
    throw new HostError(EXIT.FENCE_OR_BACKUP, `Refusing to replace ${path}: its digest ${current ?? 'missing'} is neither the expected ${expectedDigest} nor the target ${next} (concurrent edit). Resolve manually; nothing was written.`);
  }
  atomicWrite(path, content, 0o600);
  if (fileDigest(path) !== next) throw new HostError(EXIT.FENCE_OR_BACKUP, `Post-write digest mismatch for ${path}.`);
  return 'replaced';
}

/**
 * Create `path` with `content` unless it already holds exactly that content (resume).
 * An existing file with other content, or a non-regular file, is never overwritten.
 */
export function writeFileOnce(path: string, content: string): 'created' | 'already' {
  if (existsSync(path) || isSymlink(path)) {
    const st = lstatSync(path);
    if (!st.isFile()) throw new HostError(EXIT.FENCE_OR_BACKUP, `Refusing to write ${path}: it exists and is not a regular file.`);
    if (fileDigest(path) === sha256Hex(content)) return 'already';
    throw new HostError(EXIT.FENCE_OR_BACKUP, `Refusing to overwrite ${path}: it already exists with different content (another installation or a manual edit). Nothing was written.`);
  }
  if (!existsSync(dirname(path))) throw new HostError(EXIT.FENCE_OR_BACKUP, `Directory of ${path} does not exist.`);
  atomicWrite(path, content, 0o600);
  return 'created';
}

function isSymlink(path: string) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/**
 * The SeaweedFS admin env file that Compose loads for the selected env file, resolved the
 * way Compose resolves it (relative to the project directory). Only the default production
 * env file may fall back to the default `.env.seaweedfs-admin`; any other env file must name
 * its own admin file, so a rehearsal or second installation can never read or write the
 * production admin identity.
 */
export function resolveAdminEnvPath(opts: { envFile: string; env: Map<string, string>; projectDir: string; targetEnvFile?: string }) {
  const defaultEnvFile = resolve(opts.projectDir, '.env.prod');
  const defaultAdmin = resolve(opts.projectDir, '.env.seaweedfs-admin');
  const isDefaultEnv = resolve(opts.envFile) === defaultEnvFile;
  const declared = (opts.env.get('SEAWEEDFS_ADMIN_ENV_FILE') || '').trim();
  if (!declared && !isDefaultEnv) {
    throw new HostError(EXIT.PREFLIGHT_BLOCK, `${opts.envFile} is not the default production env file, so it must set SEAWEEDFS_ADMIN_ENV_FILE to its own admin env path; refusing to use ${defaultAdmin}.`);
  }
  if (declared && (/[\s"'`$\\]/.test(declared) || declared.includes('\0'))) throw new HostError(EXIT.PREFLIGHT_BLOCK, 'SEAWEEDFS_ADMIN_ENV_FILE contains unsupported characters.');
  if (declared && !isDefaultEnv && !isAbsolute(declared)) throw new HostError(EXIT.PREFLIGHT_BLOCK, `${opts.envFile} must set SEAWEEDFS_ADMIN_ENV_FILE to an absolute path.`);
  const path = declared ? resolve(opts.projectDir, declared) : defaultAdmin;
  if (!isDefaultEnv && path === defaultAdmin) throw new HostError(EXIT.PREFLIGHT_BLOCK, `${opts.envFile} points SEAWEEDFS_ADMIN_ENV_FILE at the production admin file ${defaultAdmin}; refusing.`);
  for (const other of [opts.envFile, opts.targetEnvFile].filter(Boolean) as string[]) {
    if (path === resolve(other)) throw new HostError(EXIT.PREFLIGHT_BLOCK, `SEAWEEDFS_ADMIN_ENV_FILE must not be ${other}.`);
  }
  return path;
}

export const MANAGED_ENV_KEYS = [
  'STORAGE_PROVIDER', 'COMPOSE_PROFILES', 'STORAGE_REQUIRE_SENTINEL', 'STORAGE_S3_ENDPOINT', 'STORAGE_S3_ENDPOINT_PUBLIC',
  'STORAGE_S3_ACCESS_KEY', 'STORAGE_S3_SECRET_KEY', 'SEAWEEDFS_ACCESS_KEY', 'SEAWEEDFS_SECRET_KEY',
  'SEAWEEDFS_ADMIN_ACCESS_KEY', 'SEAWEEDFS_ADMIN_SECRET_KEY', 'SEAWEEDFS_ADMIN_ENV_FILE', 'SEAWEEDFS_HOST_BIND_ADDRESS',
  'SEAWEEDFS_API_HOST_PORT', 'SEAWEEDFS_EXTERNAL_URL', 'SEAWEEDFS_JWT_SECRET', 'SEAWEEDFS_JWT_READ_SECRET',
  'SEAWEEDFS_JWT_FILER_SECRET', 'SEAWEEDFS_JWT_FILER_READ_SECRET', 'SEAWEEDFS_JWT_FILER_SUBSCRIBE_SECRET',
];

export interface TargetCredentials {
  appAccessKey: string;
  appSecretKey: string;
  adminAccessKey: string;
  adminSecretKey: string;
}

export function readTargetCredentials(path: string): TargetCredentials {
  const env = readEnvFile(path);
  const creds = {
    appAccessKey: env.get('STORAGE_S3_TARGET_ACCESS_KEY') || '',
    appSecretKey: env.get('STORAGE_S3_TARGET_SECRET_KEY') || '',
    adminAccessKey: env.get('SEAWEEDFS_ADMIN_ACCESS_KEY') || '',
    adminSecretKey: env.get('SEAWEEDFS_ADMIN_SECRET_KEY') || '',
  };
  assertSafeCredential('STORAGE_S3_TARGET_ACCESS_KEY', creds.appAccessKey, 'access');
  assertSafeCredential('STORAGE_S3_TARGET_SECRET_KEY', creds.appSecretKey, 'secret');
  assertSafeCredential('SEAWEEDFS_ADMIN_ACCESS_KEY', creds.adminAccessKey, 'access');
  assertSafeCredential('SEAWEEDFS_ADMIN_SECRET_KEY', creds.adminSecretKey, 'secret');
  if (creds.appAccessKey === creds.adminAccessKey || creds.appSecretKey === creds.adminSecretKey) {
    throw new HostError(EXIT.PREFLIGHT_BLOCK, 'SeaweedFS admin and app credentials must be distinct.');
  }
  return creds;
}

export function renderTargetCredentials(creds: TargetCredentials) {
  return [
    '# NStack SeaweedFS migration target credentials (mode 0600; never commit or print).',
    `STORAGE_S3_TARGET_ACCESS_KEY=${creds.appAccessKey}`,
    `STORAGE_S3_TARGET_SECRET_KEY=${creds.appSecretKey}`,
    `SEAWEEDFS_ADMIN_ACCESS_KEY=${creds.adminAccessKey}`,
    `SEAWEEDFS_ADMIN_SECRET_KEY=${creds.adminSecretKey}`,
    '',
  ].join('\n');
}

export function renderAdminEnv(creds: TargetCredentials) {
  return [
    '# SeaweedFS init/admin identity; loaded only by the seaweedfs and seaweedfs-init services.',
    `SEAWEEDFS_ADMIN_ACCESS_KEY=${creds.adminAccessKey}`,
    `SEAWEEDFS_ADMIN_SECRET_KEY=${creds.adminSecretKey}`,
    '',
  ].join('\n');
}

export interface SwitchPlan {
  publicEndpoint: string;
  bindAddress: string;
  postPort: number;
  adminEnvPath: string;
}

/** Decide the post-cutover public meaning: the public URL is unchanged; SeaweedFS takes MinIO's host port. */
export function planSwitch(oldEnv: Map<string, string>, adminEnvPath: string, postPortOverride?: number): SwitchPlan {
  const publicEndpoint = oldEnv.get('STORAGE_S3_ENDPOINT_PUBLIC') || '';
  assertSafeUrl('STORAGE_S3_ENDPOINT_PUBLIC', publicEndpoint);
  const bindAddress = oldEnv.get('MINIO_HOST_BIND_ADDRESS') || '127.0.0.1';
  if (!/^(127\.0\.0\.1|0\.0\.0\.0|[0-9.]{7,15}|\[[0-9a-fA-F:]+\])$/.test(bindAddress)) throw new HostError(EXIT.PREFLIGHT_BLOCK, 'MINIO_HOST_BIND_ADDRESS is not an IP address.');
  const postPort = postPortOverride ?? Number(oldEnv.get('MINIO_API_HOST_PORT') || 9000);
  if (!Number.isInteger(postPort) || postPort < 1 || postPort > 65535) throw new HostError(EXIT.USAGE, 'Invalid SeaweedFS post-cutover port.');
  if (!adminEnvPath.startsWith('/') || /[\s"'`$\\]/.test(adminEnvPath)) throw new HostError(EXIT.USAGE, 'Admin env path must be an absolute path without special characters.');
  return { publicEndpoint, bindAddress, postPort, adminEnvPath };
}

/** Render the switched env file: old content without managed keys, plus one deterministic block. */
export function renderSwitchedEnv(oldText: string, creds: TargetCredentials, plan: SwitchPlan, runId: string) {
  const managed = new Set(MANAGED_ENV_KEYS);
  const kept = oldText.split(/\r?\n/).filter((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return !(m && managed.has(m[1]!));
  });
  while (kept.length && kept[kept.length - 1]!.trim() === '') kept.pop();
  const block = [
    '',
    `# Storage provider: SeaweedFS (switched by nstack-migrate-storage-host, run ${runId}).`,
    'STORAGE_PROVIDER=seaweedfs',
    'COMPOSE_PROFILES=seaweedfs',
    'STORAGE_REQUIRE_SENTINEL=true',
    'STORAGE_S3_ENDPOINT=http://seaweedfs:8333',
    `STORAGE_S3_ENDPOINT_PUBLIC=${plan.publicEndpoint}`,
    `STORAGE_S3_ACCESS_KEY=${creds.appAccessKey}`,
    `STORAGE_S3_SECRET_KEY=${creds.appSecretKey}`,
    `SEAWEEDFS_ACCESS_KEY=${creds.appAccessKey}`,
    `SEAWEEDFS_SECRET_KEY=${creds.appSecretKey}`,
    `SEAWEEDFS_ADMIN_ENV_FILE=${plan.adminEnvPath}`,
    `SEAWEEDFS_HOST_BIND_ADDRESS=${plan.bindAddress}`,
    `SEAWEEDFS_API_HOST_PORT=${plan.postPort}`,
    `SEAWEEDFS_EXTERNAL_URL=${plan.publicEndpoint}`,
    '',
  ];
  return [...kept, ...block].join('\n');
}

export interface SourceCoordinates {
  provider: 'minio';
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: string;
  publicEndpoint: string;
  apiHostPort: number;
}

/** Source coordinates from the pre-switch env file; only the bundled MinIO source is supported here. */
export function sourceCoordinates(env: Map<string, string>): SourceCoordinates {
  const provider = (env.get('STORAGE_PROVIDER') || '').toLowerCase();
  const endpoint = env.get('STORAGE_S3_ENDPOINT') || 'http://minio:9000';
  const host = new URL(endpoint).hostname;
  if ((provider && provider !== 'minio') || !['minio', 'wingman-tower-minio'].includes(host)) {
    throw new HostError(EXIT.PREFLIGHT_BLOCK, `The local orchestrator migrates only the bundled MinIO provider (found provider=${provider || 'inferred'} endpoint host=${host}).`);
  }
  const accessKey = env.get('STORAGE_S3_ACCESS_KEY') || '';
  const secretKey = env.get('STORAGE_S3_SECRET_KEY') || '';
  if (!accessKey || !secretKey) throw new HostError(EXIT.PREFLIGHT_BLOCK, 'Source STORAGE_S3_ACCESS_KEY/STORAGE_S3_SECRET_KEY missing.');
  return {
    provider: 'minio',
    endpoint: 'http://minio:9000',
    bucket: env.get('STORAGE_S3_BUCKET') || 'superbased-storage',
    region: env.get('STORAGE_S3_REGION') || 'us-east-1',
    accessKey,
    secretKey,
    forcePathStyle: env.get('STORAGE_S3_FORCE_PATH_STYLE') || 'true',
    publicEndpoint: env.get('STORAGE_S3_ENDPOINT_PUBLIC') || '',
    apiHostPort: Number(env.get('MINIO_API_HOST_PORT') || 9000),
  };
}

export interface LockRecord {
  pid: number;
  host: string;
  started: string;
  command: string;
  nonce: string;
  scope: string;
}

/** Canonical lock path for one Docker daemon + compose project, independent of checkout and --state-dir. */
export function hostLockPath(stateHome: string, daemonId: string, project: string) {
  if (!daemonId.trim()) throw new HostError(EXIT.PREFLIGHT_BLOCK, 'Docker daemon ID unavailable; refusing to operate without a canonical lock.');
  return join(stateHome, 'nstack-migration', 'locks', `${sha256Hex(`${daemonId.trim()}:${project}`).slice(0, 32)}.lock`);
}

/**
 * Exclusive operation lock (O_EXCL). An existing lock always fails closed with exit 3:
 * the holder (live or not) is reported and an operator removes a stale file only after
 * confirming no orchestrator is running. There is no automatic reclaim.
 */
export function acquireHostLock(path: string, command: string, scope: string, processStart: (pid: number) => string | null): LockRecord {
  const record: LockRecord = { pid: process.pid, host: hostname(), started: processStart(process.pid) ?? '', command, nonce: randomBytes(8).toString('hex'), scope };
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeSync(fd, Buffer.from(JSON.stringify(record))); fsyncSync(fd); } finally { closeSync(fd); }
    return record;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }
  let held: LockRecord | null = null;
  try { held = JSON.parse(readFileSync(path, 'utf8')) as LockRecord; } catch { held = null; }
  let state = 'unreadable';
  if (held) {
    const alive = held.host === hostname() && (() => { try { process.kill(held!.pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } })();
    state = held.host !== hostname() ? `held on host ${held.host}` : alive && processStart(held.pid) === held.started ? `held by running pid ${held.pid}` : `probably stale (pid ${held.pid} not running with the recorded start time)`;
  }
  throw new HostError(EXIT.LOCK_OR_CONFLICT, `Migration lock ${path} exists (${state}${held ? `, command "${held.command}", scope ${held.scope}` : ''}). Refusing to run. After confirming no orchestrator is running for this Docker daemon and project, remove the file and retry.`);
}

export function releaseHostLock(path: string, record: LockRecord) {
  try {
    const held = JSON.parse(readFileSync(path, 'utf8')) as LockRecord;
    if (held.nonce === record.nonce) unlinkSync(path);
  } catch { /* already gone */ }
}

export interface ContainerView {
  Id: string;
  Name: string;
  State: { Status: string; Running: boolean; Restarting: boolean; StartedAt: string; FinishedAt: string };
  Image: string;
  Config: { Labels: Record<string, string> };
  HostConfig: { PortBindings: Record<string, unknown> | null };
  NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | null; Networks: Record<string, unknown> };
  Mounts: Array<{ Type: string; Name?: string; Destination: string }>;
}

export function publishedPorts(c: ContainerView): string[] {
  const out: string[] = [];
  for (const [port, binds] of Object.entries(c.NetworkSettings.Ports || {})) {
    for (const b of binds || []) out.push(`${b.HostIp}:${b.HostPort}->${port}`);
  }
  for (const [port, binds] of Object.entries(c.HostConfig.PortBindings || {})) {
    if (Array.isArray(binds) && binds.length) out.push(`binding:${port}`);
  }
  return [...new Set(out)];
}

export function networkNames(c: ContainerView) {
  return Object.keys(c.NetworkSettings.Networks || {}).sort();
}

export function dataVolume(c: ContainerView) {
  return c.Mounts.find((m) => m.Type === 'volume' && m.Destination === '/data')?.Name ?? null;
}

export function bootId(c: ContainerView) {
  return `${c.Id}:${c.State.StartedAt}`;
}

export function isStopped(c: ContainerView | null) {
  return !c || (!c.State.Running && !c.State.Restarting && ['exited', 'created', 'dead'].includes(c.State.Status));
}

/** A fenced source runs, publishes nothing and is attached only to the migration-source network. */
export function fenceProblems(c: ContainerView | null, project: string): string[] {
  if (!c) return ['source container missing'];
  const problems: string[] = [];
  if (!c.State.Running) problems.push(`source container is ${c.State.Status}`);
  const ports = publishedPorts(c);
  if (ports.length) problems.push(`source publishes host ports: ${ports.join(', ')}`);
  const nets = networkNames(c);
  if (nets.length !== 1 || nets[0] !== `${project}_migration-source`) problems.push(`source networks are [${nets.join(', ')}], expected [${project}_migration-source]`);
  if (c.Config.Labels['com.docker.compose.project'] !== project) problems.push('source container belongs to another compose project');
  return problems;
}

export interface FenceIdentity {
  minio: { id: string; name: string; started_at: string; volume: string | null; image: string };
  tower: { id: string; name: string; started_at: string; finished_at: string } | null;
  project: string;
}

/** §7.6 snapshot validity: the fenced source and the stopped Tower are exactly as recorded at the fence. */
export function snapshotProblems(recorded: FenceIdentity, minio: ContainerView | null, tower: ContainerView | null, project: string): string[] {
  const problems = fenceProblems(minio, project);
  if (minio && (minio.Id !== recorded.minio.id || minio.State.StartedAt !== recorded.minio.started_at)) problems.push('source container was restarted or recreated after the fence');
  if (minio && dataVolume(minio) !== recorded.minio.volume) problems.push('source data volume changed');
  if (recorded.tower) {
    if (!tower) problems.push('NStack container disappeared after the fence');
    else {
      if (!isStopped(tower)) problems.push(`NStack container is ${tower.State.Status}`);
      if (tower.Id !== recorded.tower.id) problems.push('NStack container was recreated after the fence');
      if (tower.State.StartedAt !== recorded.tower.started_at || tower.State.FinishedAt !== recorded.tower.finished_at) problems.push('NStack ran after the fence');
    }
  } else if (tower) {
    problems.push('an NStack container appeared after the fence');
  }
  return problems;
}
