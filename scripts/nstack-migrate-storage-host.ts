#!/usr/bin/env bun
// Host orchestration for the NStack MinIO -> SeaweedFS storage migration (plan §6).
// It owns every Docker/Compose/config action; all DB and S3 work runs in the
// `storage-migrate` data CLI container (DB and storage networks only).
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { join, resolve, isAbsolute } from 'node:path';
import {
  acquireHostLock, atomicWrite, bootId, casReplaceFile, dataVolume, EXIT, fenceProblems, fileDigest,
  generateCredential, HostError, hostLockPath, isStopped, networkNames, planSwitch, publishedPorts, readEnvFile, readTargetCredentials,
  releaseHostLock, renderAdminEnv, renderSwitchedEnv, renderTargetCredentials, resolveAdminEnvPath, sha256Hex, snapshotProblems,
  sourceCoordinates, writeFileOnce, type ContainerView, type FenceIdentity, type LockRecord, type TargetCredentials,
} from './nstack-migrate-storage-host-lib';
import { buildImage, immutableRef, SEAWEEDFS_IMAGE_TAG, SeaweedfsImageError, saveImage, validateArtifact, verifyImage } from './nstack-seaweedfs-image';

const REPO_ROOT = resolve(import.meta.dir, '..');
const QUIESCED = ['source_fenced', 'backed_up', 'synced', 'verified', 'switch_prepared', 'db_switched', 'config_switched'];
const POST_WRITE = ['start_intent', 'started', 'committed'];
const MINUTE = 60_000;

interface Options {
  command: string;
  mode: string;
  project: string;
  envFile: string;
  composeFile: string;
  fips: boolean;
  fipsEnvFile: string;
  fipsComposeFile: string;
  stateDir: string;
  targetEnvFile: string;
  backupRecipient: string;
  backupIdentity: string;
  concurrency: number;
  maxMbps: number;
  abortMaxMinutes: number;
  rehearsalMinutes: number | null;
  seaweedfsPostPort: number | undefined;
  checkPublicPut: boolean;
  resume: boolean;
  reverseMigrate: boolean;
  standalone: boolean;
  store: 'target' | 'source';
  confirm: string;
  retentionDays: number;
  sampleCount: number | undefined;
  apiUrl: string;
  /** Test-only crash injection: exit with code 99 right after the named step completes. */
  crashAfter: string;
}

function usage() {
  return `Usage: bun scripts/nstack-migrate-storage-host.ts <command> [options]

Commands:
  target-init     Create distinct target credentials (mode 0600) and start SeaweedFS internal-only + init
  preflight       Read-only checks (fingerprint, source features, sentinel, disk, inventory)
  precopy         Online warm copy (resumable)
  cutover         Maintenance-window cutover, steps 1-13 (--resume continues an interrupted run)
  verify          Cutover read-back (or --standalone [--store source|target] against the live DB)
  status          Journal phase, counts, rollback boundary and host state
  rollback        RB0/RB1 before start_intent; --reverse-migrate for RB2 at or after it
  retire-source   Remove the stopped MinIO container and volume after retention (--confirm <project>)

Options:
  --project NAME             Compose project (default: COMPOSE_PROJECT_NAME or wingman-tower)
  --env-file PATH            Env file (default: .env.prod)
  --compose-file PATH        Compose file (default: docker-compose.prod.yml)
  --no-fips                  Omit the FIPS overlay (isolated rehearsal labs only)
  --state-dir PATH           Host state (default: .runtime/migration/<project>)
  --target-env-file PATH     Target credentials (default: <state-dir>/target.env)
  --backup-recipient AGE     age recipient for the window backup
  --backup-identity PATH     age identity used to verify the window backup
  --concurrency N            1-4 (default 4)      --max-mbps N   precopy cap (MiB/s, default 0)
  --abort-max-minutes N      window abort cap (default 60, never above 60)
  --rehearsal-minutes N      measured rehearsal window; cap becomes min(2x, abort cap)
  --seaweedfs-post-port P    host port SeaweedFS binds after the switch (default: MinIO's MINIO_API_HOST_PORT)
  --check-public-put         smoke the presigned PUT through STORAGE_S3_ENDPOINT_PUBLIC
  --sample-count N           smoke sample of larger objects (default 200)
  --resume | --reverse-migrate | --standalone | --store source|target | --confirm NAME
  --retention-days N         retire-source minimum age (default 14)`;
}

function parseOptions(argv: string[]): Options {
  const command = argv[0] || '';
  const o: Options = {
    command, mode: 'prod', project: process.env.COMPOSE_PROJECT_NAME || 'wingman-tower',
    envFile: '.env.prod', composeFile: 'docker-compose.prod.yml', fips: true,
    fipsEnvFile: '.env.fips', fipsComposeFile: 'docker-compose.fips.yml', stateDir: '', targetEnvFile: '',
    backupRecipient: '', backupIdentity: '', concurrency: 4, maxMbps: 0, abortMaxMinutes: 60, rehearsalMinutes: null,
    seaweedfsPostPort: undefined, checkPublicPut: false, resume: false, reverseMigrate: false, standalone: false,
    store: 'target', confirm: '', retentionDays: 14, sampleCount: undefined, apiUrl: 'http://tower:3100', crashAfter: '',
  };
  const num = (flag: string, v: string | undefined) => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n < 0) throw new HostError(EXIT.USAGE, `Invalid ${flag}: ${v}`);
    return n;
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => { const v = argv[++i]; if (v === undefined) throw new HostError(EXIT.USAGE, `${a} requires a value`); return v; };
    switch (a) {
      case '--mode': o.mode = next(); break;
      case '--project': o.project = next(); break;
      case '--env-file': o.envFile = next(); break;
      case '--compose-file': o.composeFile = next(); break;
      case '--fips-env-file': o.fipsEnvFile = next(); break;
      case '--fips-compose-file': o.fipsComposeFile = next(); break;
      case '--no-fips': o.fips = false; break;
      case '--state-dir': o.stateDir = next(); break;
      case '--target-env-file': o.targetEnvFile = next(); break;
      case '--backup-recipient': o.backupRecipient = next(); break;
      case '--backup-identity': o.backupIdentity = next(); break;
      case '--concurrency': o.concurrency = Math.min(4, Math.max(1, num(a, next()))); break;
      case '--max-mbps': o.maxMbps = num(a, next()); break;
      case '--abort-max-minutes': o.abortMaxMinutes = Math.min(60, num(a, next())); break;
      case '--rehearsal-minutes': o.rehearsalMinutes = num(a, next()); break;
      case '--seaweedfs-post-port': o.seaweedfsPostPort = num(a, next()); break;
      case '--check-public-put': o.checkPublicPut = true; break;
      case '--sample-count': o.sampleCount = num(a, next()); break;
      case '--resume': o.resume = true; break;
      case '--reverse-migrate': o.reverseMigrate = true; break;
      case '--standalone': o.standalone = true; break;
      case '--store': { const v = next(); if (v !== 'target' && v !== 'source') throw new HostError(EXIT.USAGE, '--store must be target or source'); o.store = v; break; }
      case '--confirm': o.confirm = next(); break;
      case '--retention-days': o.retentionDays = num(a, next()); break;
      case '--crash-after': o.crashAfter = next(); break;
      case '--verified-backup-dir': throw new HostError(EXIT.USAGE, '--verified-backup-dir is not supported: the window backup is always taken after the source fence, and its manifest digest is journalled.');
      case '--setup': throw new HostError(EXIT.USAGE, '--setup is not supported by this orchestrator (production compose installations only).');
      case '-h': case '--help': console.log(usage()); process.exit(0);
      default: throw new HostError(EXIT.USAGE, `Unknown argument: ${a}`);
    }
  }
  if (o.mode !== 'prod') {
    throw new HostError(EXIT.USAGE, `--mode ${o.mode} is not implemented: this orchestrator migrates production-compose installations only. Setup-mode (nstack:setup) installations are not supported by this release.`);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(o.project)) throw new HostError(EXIT.USAGE, 'Invalid --project name.');
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
  o.envFile = abs(o.envFile);
  o.composeFile = abs(o.composeFile);
  o.fipsEnvFile = abs(o.fipsEnvFile);
  o.fipsComposeFile = abs(o.fipsComposeFile);
  o.stateDir = abs(o.stateDir || `.runtime/migration/${o.project}`);
  o.targetEnvFile = abs(o.targetEnvFile || join(o.stateDir, 'target.env'));
  if (o.backupIdentity) o.backupIdentity = abs(o.backupIdentity);
  return o;
}

interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }

/** Spawn with an absolute deadline; never inherits ambient compose/storage variables. */
async function run(cmd: string[], opts: { env?: Record<string, string>; timeoutMs?: number; stdin?: string; quiet?: boolean } = {}): Promise<RunResult> {
  const base: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'SSH_AUTH_SOCK']) {
    if (process.env[k]) base[k] = process.env[k]!;
  }
  const child = Bun.spawn(cmd, { cwd: REPO_ROOT, env: { ...base, ...(opts.env || {}) }, stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs) : null;
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (timer) clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
}

class Orchestrator {
  readonly o: Options;
  readonly runsDir: string;
  lock: LockRecord | null = null;
  lockPath = '';
  runId = '';
  fingerprint = '';
  windowStartedAt = 0;

  constructor(o: Options) {
    this.o = o;
    this.runsDir = join(o.stateDir, 'runs');
  }

  // ---------- infrastructure ----------
  log(msg: string) { console.error(`[migrate-host] ${msg}`); }

  event(step: string, data: Record<string, unknown>) {
    if (!this.runId) return;
    const line = JSON.stringify({ at: new Date().toISOString(), run_id: this.runId, step, ...data });
    appendFileSync(join(this.runDir(), 'events.jsonl'), line + '\n', { mode: 0o600 });
  }

  runDir() {
    const dir = join(this.runsDir, this.runId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  crashPoint(step: string) {
    if (this.o.crashAfter && this.o.crashAfter === step) {
      this.log(`TEST crash injection after ${step}`);
      process.exit(99);
    }
  }

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.log(`step ${name} ...`);
    try {
      const out = await fn();
      this.event(name, { ok: true, ms: Date.now() - started });
      this.log(`step ${name} ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      this.crashPoint(name);
      return out;
    } catch (err) {
      this.event(name, { ok: false, ms: Date.now() - started, exit: err instanceof HostError ? err.exitCode : 1, error: err instanceof Error ? err.message.slice(0, 500) : String(err) });
      throw err;
    }
  }

  async prepareStateDir() {
    mkdirSync(this.runsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.o.stateDir, 0o700);
    // One lock per Docker daemon + project, wherever the checkout or --state-dir is.
    const daemon = await run(['docker', 'info', '--format', '{{.ID}}'], { timeoutMs: 30_000 });
    if (daemon.code !== 0) throw new HostError(EXIT.PREFLIGHT_BLOCK, `Docker is unavailable: ${daemon.stderr.trim()}`);
    const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
    this.lockPath = hostLockPath(stateHome, daemon.stdout.trim(), this.o.project);
    mkdirSync(join(stateHome, 'nstack-migration', 'locks'), { recursive: true, mode: 0o700 });
    this.lock = acquireHostLock(this.lockPath, `${this.o.command} ${this.o.project}`, `${daemon.stdout.trim()}:${this.o.project}:${this.o.stateDir}`, (pid) => {
      const r = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
      const out = r.stdout.toString().trim();
      return r.exitCode === 0 && out ? out : null;
    });
  }

  release() {
    if (this.lock) releaseHostLock(this.lockPath, this.lock);
  }

  composeArgs(envFile: string, overrides: string[] = []) {
    const args = ['docker', 'compose', '-p', this.o.project, '--project-directory', REPO_ROOT, '--env-file', envFile, '-f', this.o.composeFile];
    if (this.o.fips) args.push('--env-file', this.o.fipsEnvFile, '-f', this.o.fipsComposeFile);
    for (const f of overrides) args.push('-f', f);
    return args;
  }

  composeEnv(envFile: string, profiles: string, extra: Record<string, string> = {}) {
    return { COMPOSE_PROFILES: profiles, TOWER_ENV_FILE: this.o.envFile, COMPOSE_PROJECT_NAME: this.o.project, ...extra, ...(envFile ? {} : {}) };
  }

  async compose(envFile: string, profiles: string, args: string[], opts: { overrides?: string[]; extra?: Record<string, string>; timeoutMs?: number; failCode?: number; what?: string } = {}) {
    const res = await run([...this.composeArgs(envFile, opts.overrides), ...args], { env: this.composeEnv(envFile, profiles, opts.extra), timeoutMs: opts.timeoutMs ?? 3 * MINUTE });
    if (res.code !== 0) {
      throw new HostError(opts.failCode ?? EXIT.FENCE_OR_BACKUP, `${opts.what ?? 'docker compose ' + args.join(' ')} failed (exit ${res.code}${res.timedOut ? ', timed out' : ''}): ${res.stderr.trim().split('\n').slice(-5).join(' | ')}`);
    }
    return res;
  }

  async docker(args: string[], timeoutMs = MINUTE) {
    return run(['docker', ...args], { timeoutMs });
  }

  async inspect(id: string | null): Promise<ContainerView | null> {
    if (!id) return null;
    const res = await this.docker(['inspect', id]);
    if (res.code !== 0) return null;
    return (JSON.parse(res.stdout) as ContainerView[])[0] ?? null;
  }

  /** Resolve a service's container through Compose labels; never by a default name. */
  async serviceContainer(service: string): Promise<ContainerView | null> {
    const res = await this.docker(['ps', '-a', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${this.o.project}`, '--filter', `label=com.docker.compose.service=${service}`, '--filter', 'label=com.docker.compose.oneoff=False']);
    if (res.code !== 0) throw new HostError(EXIT.FENCE_OR_BACKUP, `docker ps failed: ${res.stderr.trim()}`);
    const ids = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length > 1) throw new HostError(EXIT.FENCE_OR_BACKUP, `Ambiguous: ${ids.length} containers for service ${service} in project ${this.o.project}.`);
    return this.inspect(ids[0] ?? null);
  }

  async waitHealthy(service: string, timeoutMs = 3 * MINUTE): Promise<ContainerView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = await this.serviceContainer(service);
      const health = c ? ((await this.docker(['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', c.Id])).stdout.trim()) : 'missing';
      if (c && c.State.Running && (health === 'healthy' || health === 'none')) return c;
      if (Date.now() > deadline) throw new HostError(EXIT.FENCE_OR_BACKUP, `${service} did not become healthy (state=${c?.State.Status ?? 'missing'}, health=${health}).`);
      await Bun.sleep(1000);
    }
  }

  async stopService(envFile: string, profiles: string, service: string) {
    const before = await this.serviceContainer(service);
    if (!before || isStopped(before)) return before;
    // NStack runs as PID 1 without a SIGTERM handler, so a stop always ends in SIGKILL; bound it.
    // Datastores get a longer graceful window.
    const grace = service === 'tower' ? '15' : '60';
    await this.compose(envFile, profiles, ['stop', '-t', grace, service], { timeoutMs: 2 * MINUTE, what: `stop ${service}` });
    const after = await this.serviceContainer(service);
    if (!isStopped(after)) throw new HostError(EXIT.FENCE_OR_BACKUP, `${service} is still ${after?.State.Status} after stop.`);
    return after;
  }

  writeOverride(name: string, content: string) {
    const path = join(this.o.stateDir, name);
    atomicWrite(path, content, 0o600);
    return path;
  }

  minioFenceOverride() {
    return this.writeOverride('override-minio-fenced.yml', 'services:\n  minio:\n    ports: !reset []\n    networks: !override\n      migration-source: {}\n');
  }

  seaweedfsInternalOverride() {
    return this.writeOverride('override-seaweedfs-internal.yml', 'services:\n  seaweedfs:\n    ports: !reset []\n    networks: !override\n      storage-internal: {}\n');
  }

  targetCreds(): TargetCredentials {
    if (!existsSync(this.o.targetEnvFile)) throw new HostError(EXIT.PREFLIGHT_BLOCK, `Target credentials ${this.o.targetEnvFile} missing; run target-init first.`);
    const mode = Bun.spawnSync(['stat', '-f', '%Lp', this.o.targetEnvFile]).stdout.toString().trim() || Bun.spawnSync(['stat', '-c', '%a', this.o.targetEnvFile]).stdout.toString().trim();
    if (mode !== '600' && mode !== '400') throw new HostError(EXIT.PREFLIGHT_BLOCK, `${this.o.targetEnvFile} must be mode 0600 (found ${mode}).`);
    return readTargetCredentials(this.o.targetEnvFile);
  }

  /**
   * The admin env file Compose loads for the selected env file (never a hardcoded checkout
   * path). An existing file must already hold exactly this run's admin identity.
   */
  adminEnvPath(creds?: TargetCredentials) {
    const path = resolveAdminEnvPath({ envFile: this.o.envFile, env: readEnvFile(this.o.envFile), projectDir: REPO_ROOT, targetEnvFile: this.o.targetEnvFile });
    if (creds && existsSync(path) && fileDigest(path) !== sha256Hex(renderAdminEnv(creds))) {
      throw new HostError(EXIT.PREFLIGHT_BLOCK, `${path} already exists with a different SeaweedFS admin identity; refusing (it would not be replaced).`);
    }
    return path;
  }

  /** The NStack SeaweedFS image recorded for this installation at target-init (immutable reference). */
  seaweedfsImage(): { ref: string; id: string } {
    const p = join(this.o.stateDir, 'seaweedfs-image.json');
    if (!existsSync(p)) throw new HostError(EXIT.PREFLIGHT_BLOCK, `No SeaweedFS image is recorded (${p}); run target-init first.`);
    const recorded = JSON.parse(readFileSync(p, 'utf8')) as { ref: string; id: string };
    let v: { ref: string; id: string };
    try { v = verifyImage(recorded.ref); } catch (err) { throw new HostError(EXIT.PREFLIGHT_BLOCK, err instanceof Error ? err.message : String(err)); }
    if (v.id !== recorded.id) throw new HostError(EXIT.PREFLIGHT_BLOCK, `SeaweedFS image ${recorded.ref} now resolves to ${v.id}, not the recorded ${recorded.id}.`);
    return recorded;
  }

  seaweedfsArtifactDir() { return join(this.o.stateDir, 'seaweedfs-image-artifact'); }

  /**
   * Record the image once: the env file's SEAWEEDFS_IMAGE, else the local NStack build, else build it.
   * The exact image is saved (validated, atomically renamed) BEFORE the record is written, and every
   * later call re-validates the saved artifact, so an interrupted save can never be skipped.
   */
  async recordSeaweedfsImage() {
    const p = join(this.o.stateDir, 'seaweedfs-image.json');
    try {
      if (existsSync(p)) {
        const recorded = this.seaweedfsImage();
        await validateArtifact(this.seaweedfsArtifactDir(), recorded);
        return recorded;
      }
      const declared = readEnvFile(this.o.envFile).get('SEAWEEDFS_IMAGE');
      const tagPresent = Bun.spawnSync(['docker', 'image', 'inspect', SEAWEEDFS_IMAGE_TAG], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
      const v = declared ? verifyImage(declared) : tagPresent ? verifyImage(immutableRef(SEAWEEDFS_IMAGE_TAG)) : buildImage();
      await saveImage(v.ref, this.seaweedfsArtifactDir());
      const record = { ref: v.ref, id: v.id, recorded_at: new Date().toISOString() };
      atomicWrite(p, JSON.stringify(record, null, 2) + '\n', 0o600);
      return record;
    } catch (err) {
      if (err instanceof SeaweedfsImageError) throw new HostError(EXIT.PREFLIGHT_BLOCK, err.message);
      throw err;
    }
  }

  /** Cutover gate: the recorded image and its saved artifact must both still be exactly right. */
  async assertSeaweedfsArtifact() {
    try { await validateArtifact(this.seaweedfsArtifactDir(), this.seaweedfsImage()); } catch (err) {
      if (err instanceof SeaweedfsImageError) throw new HostError(EXIT.PREFLIGHT_BLOCK, err.message);
      throw err;
    }
  }

  seaweedfsEnv(creds: TargetCredentials) {
    // Stopping needs no image; anything that creates or starts SeaweedFS asserts the recorded one.
    const recorded = existsSync(join(this.o.stateDir, 'seaweedfs-image.json')) ? { SEAWEEDFS_IMAGE: this.seaweedfsImage().ref } : {};
    return { ...recorded, SEAWEEDFS_ACCESS_KEY: creds.appAccessKey, SEAWEEDFS_SECRET_KEY: creds.appSecretKey, SEAWEEDFS_ADMIN_ACCESS_KEY: creds.adminAccessKey, SEAWEEDFS_ADMIN_SECRET_KEY: creds.adminSecretKey };
  }

  currentRunPointer() {
    const p = join(this.o.stateDir, 'current-run');
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
  }

  /**
   * Source description for this run: the window snapshot once the window opened; before
   * that the live env file while it still describes MinIO; otherwise the precopy snapshot.
   * A fresh process after the config switch therefore binds the run without the live file.
   */
  sourceEnvFile() {
    const runId = this.runId || this.currentRunPointer();
    if (runId) {
      const dir = join(this.runsDir, runId);
      if (existsSync(join(dir, 'old-config.env'))) return join(dir, 'old-config.env');
      try { sourceCoordinates(readEnvFile(this.o.envFile)); return this.o.envFile; } catch { /* live file no longer describes the source */ }
      if (existsSync(join(dir, 'source.env'))) return join(dir, 'source.env');
      throw new HostError(EXIT.PREFLIGHT_BLOCK, `Run ${runId} has no source snapshot and ${this.o.envFile} does not describe MinIO.`);
    }
    return this.o.envFile;
  }

  /** Source identity bound to the actual MinIO /data volume; a cached value must still match it. */
  async sourceIdentity(): Promise<string> {
    const cacheFile = join(this.o.stateDir, 'source-identity');
    const cached = existsSync(cacheFile) ? readFileSync(cacheFile, 'utf8').trim() : '';
    const minio = await this.serviceContainer('minio');
    const volume = minio ? dataVolume(minio) : null;
    if (!minio || !volume) {
      if (cached) return cached;
      throw new HostError(EXIT.PREFLIGHT_BLOCK, 'Cannot resolve the MinIO container and its /data volume for this project.');
    }
    const actual = `minio:${this.o.project}:${volume}`;
    if (cached && cached !== actual) throw new HostError(EXIT.PREFLIGHT_BLOCK, `MinIO source volume changed (${cached} recorded, ${actual} now); refusing.`);
    if (!cached) atomicWrite(cacheFile, actual + '\n', 0o600);
    return actual;
  }

  async dataEnv(): Promise<Record<string, string>> {
    const src = sourceCoordinates(readEnvFile(this.sourceEnvFile()));
    const creds = this.targetCreds();
    if (creds.appAccessKey === src.accessKey || creds.adminAccessKey === src.accessKey) throw new HostError(EXIT.PREFLIGHT_BLOCK, 'Target credentials must be distinct from the MinIO root credentials.');
    const identity = await this.sourceIdentity();
    return {
      STORAGE_S3_SOURCE_PROVIDER: 'minio',
      STORAGE_S3_SOURCE_ENDPOINT: src.endpoint,
      STORAGE_S3_SOURCE_REGION: src.region,
      STORAGE_S3_SOURCE_BUCKET: src.bucket,
      STORAGE_S3_SOURCE_ACCESS_KEY: src.accessKey,
      STORAGE_S3_SOURCE_SECRET_KEY: src.secretKey,
      STORAGE_S3_SOURCE_FORCE_PATH_STYLE: src.forcePathStyle,
      STORAGE_S3_TARGET_PROVIDER: 'seaweedfs',
      STORAGE_S3_TARGET_ENDPOINT: 'http://seaweedfs:8333',
      STORAGE_S3_TARGET_REGION: src.region,
      STORAGE_S3_TARGET_BUCKET: src.bucket,
      STORAGE_S3_TARGET_ACCESS_KEY: creds.appAccessKey,
      STORAGE_S3_TARGET_SECRET_KEY: creds.appSecretKey,
      STORAGE_S3_TARGET_FORCE_PATH_STYLE: 'true',
      STORAGE_MIGRATION_SOURCE_IDENTITY: identity,
    };
  }

  /** Run one data CLI command in a labelled one-off container; parse its JSON result. */
  async data(args: string[], opts: { timeoutMs?: number; allowFail?: boolean } = {}): Promise<{ code: number; json: any }> {
    const labels = ['--label', 'nstack.migration=1', '--label', `nstack.migration.project=${this.o.project}`];
    if (this.runId) labels.push('--label', `nstack.migration.run=${this.runId}`);
    if (this.fingerprint) labels.push('--label', `nstack.migration.fingerprint=${this.fingerprint}`);
    const env = await this.dataEnv();
    const timeoutMs = opts.timeoutMs ?? 30 * MINUTE;
    const res = await run([...this.composeArgs(this.o.envFile), 'run', '--rm', '--no-deps', '-T', ...labels, 'storage-migrate', ...args], { env: this.composeEnv(this.o.envFile, 'migration', env), timeoutMs });
    if (res.timedOut) {
      await this.killRunContainers();
      throw new HostError(EXIT.TRANSIENT_IO, `Data command ${args[0]} exceeded its deadline (${Math.round(timeoutMs / 1000)}s) and was killed.`);
    }
    let json: any = null;
    const text = (res.code === 0 ? res.stdout : res.stderr).trim();
    const start = text.indexOf('{');
    if (start >= 0) { try { json = JSON.parse(text.slice(start)); } catch { json = null; } }
    if (res.code !== 0 && !opts.allowFail) {
      const exit = typeof json?.exit_code === 'number' ? json.exit_code : res.code === 1 ? 1 : res.code;
      throw new HostError(exit, `Data command ${args[0]} failed: ${json?.code ?? 'error'}: ${json?.error ?? res.stderr.trim().slice(-800)}`, json?.details);
    }
    return { code: res.code, json };
  }

  /** Stop this project's migration containers for this run; another run's live container is a conflict (exit 3). */
  async killRunContainers(stopOnly = false) {
    const res = await this.docker(['ps', '-q', '--no-trunc', '--filter', 'label=nstack.migration=1', '--filter', `label=nstack.migration.project=${this.o.project}`]);
    for (const id of res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const c = await this.inspect(id);
      const runLabel = c?.Config.Labels['nstack.migration.run'] ?? '';
      if (runLabel && runLabel !== this.runId) throw new HostError(EXIT.LOCK_OR_CONFLICT, `Migration container ${id.slice(0, 12)} of another run (${runLabel}) is alive for project ${this.o.project}.`);
      await this.docker([stopOnly ? 'stop' : 'kill', id]);
    }
  }

  async status(): Promise<any> {
    return (await this.data(['status'], { timeoutMs: 3 * MINUTE })).json;
  }

  bindRun(st: any) {
    if (!st?.has_run) throw new HostError(EXIT.PHASE_DENIED, 'No migration run exists; run precopy first.');
    const pointer = this.currentRunPointer();
    if (pointer && pointer !== st.run_id && !['rolled_back', 'aborted_restore'].includes(st.phase)) {
      throw new HostError(EXIT.PREFLIGHT_BLOCK, `Host state points at run ${pointer} but the journal's latest run is ${st.run_id}; refusing.`);
    }
    this.runId = st.run_id;
    this.fingerprint = st.fingerprint;
  }

  hostState(): Record<string, any> {
    const p = join(this.runDir(), 'host.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  }

  saveHostState(patch: Record<string, any>) {
    atomicWrite(join(this.runDir(), 'host.json'), JSON.stringify({ ...this.hostState(), ...patch }, null, 2) + '\n', 0o600);
  }

  // ---------- window clock ----------
  abortLimitMs() {
    let limit = Math.min(this.o.abortMaxMinutes, 60) * MINUTE;
    if (this.o.rehearsalMinutes !== null) limit = Math.min(limit, this.o.rehearsalMinutes * 2 * MINUTE);
    return limit;
  }

  remainingMs() {
    return this.windowStartedAt + this.abortLimitMs() - Date.now();
  }

  checkAbort(where: string) {
    const remaining = this.remainingMs();
    if (remaining <= 0) throw new HostError(EXIT.FENCE_OR_BACKUP, `ABORT_RULE: window exceeded ${Math.round(this.abortLimitMs() / MINUTE)} min before start_intent (at ${where}).`, { abort_rule: true });
    return remaining;
  }

  // ---------- health ----------
  async towerHealth(timeoutMs = 3 * MINUTE) {
    const env = readEnvFile(this.o.envFile);
    const port = env.get('TOWER_HOST_PORT') || '3100';
    const deadline = Date.now() + timeoutMs;
    let body: any = null;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) { body = await res.json(); break; }
      } catch { /* retry */ }
      if (Date.now() > deadline) throw new HostError(EXIT.SMOKE_FAILED, `NStack /health on 127.0.0.1:${port} did not succeed.`);
      await Bun.sleep(1000);
    }
    let fips: string = 'not-configured';
    if (this.o.fips) {
      const f = readEnvFile(this.o.fipsEnvFile);
      const npub = f.get('TOWER_FIPS_NODE_NPUB'), addr = f.get('TOWER_FIPS_MESH_ADDRESS'), fport = f.get('TOWER_FIPS_PORT');
      const res = await run(['curl', '--noproxy', '*', '--fail', '--silent', '--show-error', '--max-time', '5', '--retry', '30', '--retry-delay', '1', '--retry-all-errors', '-H', `Host: ${npub}.fips:${fport}`, `http://[${addr}]:${fport}/health`], { timeoutMs: 2 * MINUTE });
      if (res.code !== 0) throw new HostError(EXIT.SMOKE_FAILED, `NStack FIPS health failed: ${res.stderr.trim()}`);
      fips = 'ok';
    }
    return { status: body.status, service_npub: body.service_npub, build: body.build, fips };
  }

  async tcpOpen(port: number) {
    return new Promise<boolean>((resolvePromise) => {
      const sock = createConnection({ host: '127.0.0.1', port });
      const done = (v: boolean) => { sock.destroy(); resolvePromise(v); };
      sock.setTimeout(1500, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  }

  // ---------- container steps ----------
  async ensureSeaweedfsInternal(creds: TargetCredentials, recreate: boolean) {
    this.seaweedfsImage();
    const overrides = [this.seaweedfsInternalOverride()];
    await this.compose(this.o.envFile, 'seaweedfs', ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', ...(recreate ? ['--force-recreate'] : []), 'seaweedfs'], { overrides, extra: this.seaweedfsEnv(creds), what: 'start SeaweedFS internal-only' });
    const c = await this.waitHealthy('seaweedfs');
    const ports = publishedPorts(c);
    if (ports.length) throw new HostError(EXIT.FENCE_OR_BACKUP, `SeaweedFS publishes host ports while internal-only: ${ports.join(', ')}`);
    const nets = networkNames(c);
    if (nets.length !== 1 || nets[0] !== `${this.o.project}_storage-internal`) throw new HostError(EXIT.FENCE_OR_BACKUP, `SeaweedFS networks [${nets.join(', ')}] are not internal-only.`);
    await this.assertSeaweedfsImage(c);
    return c;
  }

  async assertSeaweedfsImage(c: ContainerView) {
    const image = this.seaweedfsImage();
    const declared = readEnvFile(this.o.envFile).get('SEAWEEDFS_IMAGE');
    if (declared && declared !== image.ref) throw new HostError(EXIT.PREFLIGHT_BLOCK, `${this.o.envFile} declares SEAWEEDFS_IMAGE=${declared}, not the recorded ${image.ref}.`);
    const res = await this.docker(['image', 'inspect', '-f', '{{.Id}}', c.Image]);
    if (res.code !== 0 || res.stdout.trim() !== image.id) {
      throw new HostError(EXIT.PREFLIGHT_BLOCK, `SeaweedFS container image ${c.Image} is not the recorded NStack image ${image.ref}.`);
    }
  }

  async fenceSource(): Promise<ContainerView> {
    await this.compose(this.sourceEnvFile(), 'minio', ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'minio'], { overrides: [this.minioFenceOverride()], what: 'recreate MinIO fenced' });
    const c = await this.waitHealthy('minio');
    const problems = fenceProblems(c, this.o.project);
    if (problems.length) throw new HostError(EXIT.FENCE_OR_BACKUP, `Source fence verification failed: ${problems.join('; ')}`);
    const src = sourceCoordinates(readEnvFile(this.sourceEnvFile()));
    if (await this.tcpOpen(src.apiHostPort)) throw new HostError(EXIT.FENCE_OR_BACKUP, `127.0.0.1:${src.apiHostPort} still accepts connections after the fence.`);
    if (src.publicEndpoint.startsWith('https://')) {
      const probe = await fetch(`${src.publicEndpoint.replace(/\/+$/, '')}/minio/health/live`, { signal: AbortSignal.timeout(10_000) }).then((r) => ({ status: r.status, server: r.headers.get('server') || '' })).catch(() => ({ status: 0, server: '' }));
      if (probe.status === 200 || /minio/i.test(probe.server)) throw new HostError(EXIT.FENCE_OR_BACKUP, `Public endpoint ${src.publicEndpoint} still reaches MinIO after the fence (HTTP ${probe.status}).`);
    }
    return c;
  }

  async restoreSourceService() {
    // Free the post-switch port first, then MinIO returns with its original bindings and networks.
    const creds = this.targetCreds();
    const sfs = await this.serviceContainer('seaweedfs');
    if (sfs && !isStopped(sfs)) await this.compose(this.o.envFile, 'seaweedfs', ['stop', '-t', '60', 'seaweedfs'], { extra: this.seaweedfsEnv(creds), what: 'stop SeaweedFS' });
    await this.compose(this.sourceEnvFile(), 'minio', ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'minio'], { what: 'recreate MinIO with original bindings' });
    const c = await this.waitHealthy('minio');
    const nets = networkNames(c);
    if (nets.includes(`${this.o.project}_migration-source`) || !nets.includes(`${this.o.project}_default`)) throw new HostError(EXIT.FENCE_OR_BACKUP, `MinIO networks after restore are [${nets.join(', ')}].`);
    return c;
  }

  async startTower(runIdForGuard: string) {
    await this.compose(this.o.envFile, readEnvFile(this.o.envFile).get('COMPOSE_PROFILES') || '', ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'tower'], { extra: { NSTACK_MIGRATION_START_RUN_ID: runIdForGuard }, failCode: EXIT.SMOKE_FAILED, what: 'start NStack' });
  }

  /** Encrypted copy of the configuration and identity files needed to restore this installation. */
  async encryptConfigArtifact(out: string) {
    const staging = mkdtempSync(join(this.runDir(), '.config-artifact-'));
    try {
      copyFileSync(join(this.runDir(), 'old-config.env'), join(staging, 'env-file'));
      if (this.o.fips) copyFileSync(this.o.fipsEnvFile, join(staging, 'fips-env-file'));
      copyFileSync(this.o.targetEnvFile, join(staging, 'storage-target.env'));
      const tar = Bun.spawn(['tar', '-C', staging, '-cf', '-', '.'], { stdout: 'pipe', stderr: 'pipe' });
      const age = Bun.spawn(['age', '--encrypt', '--recipient', this.o.backupRecipient, '--output', out], { stdin: tar.stdout, stderr: 'pipe' });
      const [tc, ac] = await Promise.all([tar.exited, age.exited]);
      if (tc !== 0 || ac !== 0) throw new HostError(EXIT.FENCE_OR_BACKUP, `Encrypted config artifact failed (tar ${tc}, age ${ac}).`);
      chmodSync(out, 0o600);
      const check = await run(['age', '--decrypt', '--identity', this.o.backupIdentity, out], { timeoutMs: 60_000 });
      if (check.code !== 0) throw new HostError(EXIT.FENCE_OR_BACKUP, 'Encrypted config artifact does not decrypt with the backup identity.');
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  // ---------- commands ----------
  async targetInit() {
    if (!existsSync(this.o.targetEnvFile)) {
      const creds: TargetCredentials = { appAccessKey: generateCredential('access'), appSecretKey: generateCredential('secret'), adminAccessKey: generateCredential('access'), adminSecretKey: generateCredential('secret') };
      atomicWrite(this.o.targetEnvFile, renderTargetCredentials(creds), 0o600);
      this.log(`created target credentials ${this.o.targetEnvFile} (mode 0600)`);
    }
    const creds = this.targetCreds();
    const env = readEnvFile(this.o.envFile);
    if ((env.get('STORAGE_PROVIDER') || 'minio') !== 'minio') throw new HostError(EXIT.PHASE_DENIED, 'target-init is for installations still on MinIO.');
    const adminEnvPath = this.adminEnvPath(creds);
    const image = await this.recordSeaweedfsImage();
    const src = sourceCoordinates(env);
    if (creds.appAccessKey === src.accessKey || creds.adminAccessKey === src.accessKey) throw new HostError(EXIT.PREFLIGHT_BLOCK, 'Target credentials must differ from the MinIO root credentials.');
    const c = await this.ensureSeaweedfsInternal(creds, false);
    const init = await run([...this.composeArgs(this.o.envFile), 'run', '--rm', '--no-deps', '-T', 'seaweedfs-init'], { env: this.composeEnv(this.o.envFile, 'seaweedfs', this.seaweedfsEnv(creds)), timeoutMs: 5 * MINUTE });
    if (init.code !== 0) throw new HostError(EXIT.PREFLIGHT_BLOCK, `seaweedfs-init failed: ${init.stderr.trim().split('\n').slice(-5).join(' | ')}`);
    const summary = JSON.parse(init.stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1) || '{}');
    return { ok: true, seaweedfs_container: c.Name.replace(/^\//, ''), boot_id: bootId(c), networks: networkNames(c), published_ports: publishedPorts(c), admin_env_path: adminEnvPath, seaweedfs_image: image.ref, init: summary };
  }

  async freeBytes() {
    const sfs = await this.serviceContainer('seaweedfs');
    const vol = sfs ? dataVolume(sfs) : null;
    if (!vol) throw new HostError(EXIT.PREFLIGHT_BLOCK, 'SeaweedFS volume not found; run target-init.');
    const res = await this.docker(['run', '--rm', '--network', 'none', '-v', `${vol}:/data:ro`, 'postgres:16-alpine', 'df', '-Pk', '/data']);
    const kb = Number(res.stdout.trim().split('\n').at(-1)?.split(/\s+/)[3]);
    if (res.code !== 0 || !Number.isFinite(kb)) throw new HostError(EXIT.PREFLIGHT_BLOCK, 'Cannot measure Docker VM free space.');
    return kb * 1024;
  }

  async preflight() {
    const adminEnvPath = this.adminEnvPath(this.targetCreds());
    const free = await this.freeBytes();
    const sfs = await this.serviceContainer('seaweedfs');
    if (!sfs) throw new HostError(EXIT.PREFLIGHT_BLOCK, 'SeaweedFS not running; run target-init.');
    await this.assertSeaweedfsImage(sfs);
    if (publishedPorts(sfs).length) throw new HostError(EXIT.PREFLIGHT_BLOCK, 'SeaweedFS publishes host ports before cutover.');
    const out = (await this.data(['preflight', '--disk-free-bytes', String(free), '--concurrency', String(this.o.concurrency)], { timeoutMs: 60 * MINUTE })).json;
    return { ...out, admin_env_path: adminEnvPath };
  }

  async precopy() {
    const st = await this.status();
    if (st.has_run && !['planned', 'precopied', 'rolled_back', 'committed', 'source_retired', 'aborted_restore'].includes(st.phase)) {
      throw new HostError(EXIT.PHASE_DENIED, `Run ${st.run_id} is in phase ${st.phase}; precopy is not permitted.`);
    }
    const active = st.has_run && (st.phase === 'planned' || st.phase === 'precopied');
    this.runId = active ? st.run_id : crypto.randomUUID();
    if (active) this.fingerprint = st.fingerprint;
    sourceCoordinates(readEnvFile(this.o.envFile));
    this.adminEnvPath(this.targetCreds());
    atomicWrite(join(this.runDir(), 'source.env'), readFileSync(this.o.envFile), 0o600);
    atomicWrite(join(this.o.stateDir, 'current-run'), this.runId + '\n', 0o600);
    const out = await this.step('precopy', async () => (await this.data(['precopy', '--run-id', this.runId, '--concurrency', String(this.o.concurrency), '--max-mbps', String(this.o.maxMbps)], { timeoutMs: 24 * 60 * MINUTE })).json);
    return out;
  }

  /** Snapshot-validity check (§7.6) on resume of a quiesced phase; false means re-fence. */
  async snapshotValid(st: any) {
    const recorded = st.fence_identity as FenceIdentity | null;
    if (!recorded) return { valid: false, problems: ['no fence identity recorded'] };
    const problems = snapshotProblems(recorded, await this.serviceContainer('minio'), await this.serviceContainer('tower'), this.o.project);
    if (['verified', 'switch_prepared', 'db_switched', 'config_switched'].includes(st.phase)) {
      const sfs = await this.serviceContainer('seaweedfs');
      if (!sfs || bootId(sfs) !== st.target_boot_id) problems.push('SeaweedFS restarted or was recreated after the verified target boundary');
    }
    return { valid: problems.length === 0, problems };
  }

  async cutover() {
    let st = await this.status();
    this.bindRun(st);
    if (st.phase === 'precopied' && this.o.resume) this.log('resume requested; run is precopied, starting the window');
    if (st.phase !== 'precopied' && !this.o.resume) throw new HostError(EXIT.PHASE_DENIED, `Run ${this.runId} is in phase ${st.phase}; pass --resume to continue.`);
    if (!['precopied', ...QUIESCED, ...POST_WRITE].includes(st.phase)) throw new HostError(EXIT.PHASE_DENIED, `cutover is not applicable in phase ${st.phase}.`);
    const creds = this.targetCreds();
    if (!POST_WRITE.includes(st.phase) && st.phase !== 'config_switched') this.adminEnvPath(creds);
    const hs = this.hostState();
    this.windowStartedAt = hs.window_started_at ? Date.parse(hs.window_started_at) : Date.now();
    if (!hs.window_started_at && !POST_WRITE.includes(st.phase)) this.saveHostState({ window_started_at: new Date(this.windowStartedAt).toISOString() });
    if (st.phase === 'precopied' && !this.o.backupRecipient) throw new HostError(EXIT.USAGE, '--backup-recipient and --backup-identity are required for the window backup.');
    if (!POST_WRITE.includes(st.phase)) await this.assertSeaweedfsArtifact();

    try {
      return await this.cutoverSteps(st, creds);
    } catch (err) {
      if (err instanceof HostError && (err.details as any)?.abort_rule) {
        this.log(`${err.message} Executing RB1.`);
        const rb = await this.rollback();
        throw new HostError(EXIT.FENCE_OR_BACKUP, `${err.message} RB1 completed: ${JSON.stringify(rb.result)}`);
      }
      throw err;
    }
  }

  async cutoverSteps(st: any, creds: TargetCredentials) {
    let phase: string = st.phase;
    const oldPath = join(this.runDir(), 'old-config.env');
    const newPath = join(this.runDir(), 'new-config.env');

    // Resume in a quiesced phase: prove the stable snapshot still holds, or re-fence.
    if (QUIESCED.includes(phase)) {
      const check = await this.snapshotValid(st);
      if (!check.valid) {
        this.log(`snapshot invalid (${check.problems.join('; ')}); re-fencing and redoing steps 2-9`);
        await this.stopService(this.o.envFile, '', 'tower');
        const current = fileDigest(this.o.envFile);
        const hs = this.hostState();
        if (hs.new_config_digest && current === hs.new_config_digest) {
          casReplaceFile(this.o.envFile, hs.new_config_digest, readFileSync(oldPath, 'utf8'));
        } else if (current !== hs.old_config_digest) {
          throw new HostError(EXIT.FENCE_OR_BACKUP, `${this.o.envFile} matches neither this run's old nor new config; refusing to reset the snapshot.`);
        }
        await this.step('reset_snapshot', () => this.data(['reset-snapshot', '--reason', check.problems.join('; ').slice(0, 300)]));
        phase = 'precopied';
      }
    }

    if (phase === 'precopied') {
      this.checkAbort('start');
      // The window snapshot of the live config is the source description for every later step.
      sourceCoordinates(readEnvFile(this.o.envFile));
      if (existsSync(oldPath) && fileDigest(oldPath) !== fileDigest(this.o.envFile)) this.log('replacing an older window snapshot of the config');
      copyFileSync(this.o.envFile, oldPath);
      chmodSync(oldPath, 0o600);
      this.saveHostState({ old_config_digest: fileDigest(oldPath), new_config_digest: null });
      await this.step('stop_tower', async () => {
        await this.killRunContainers(true);
        await this.stopService(this.o.envFile, '', 'tower');
      });
      const tower = await this.serviceContainer('tower');
      const minio = await this.step('fence_source', () => this.fenceSource());
      const identity: FenceIdentity = {
        project: this.o.project,
        minio: { id: minio.Id, name: minio.Name.replace(/^\//, ''), started_at: minio.State.StartedAt, volume: dataVolume(minio), image: minio.Image },
        tower: tower ? { id: tower.Id, name: tower.Name.replace(/^\//, ''), started_at: tower.State.StartedAt, finished_at: tower.State.FinishedAt } : null,
      };
      await this.data(['mark', '--phase', 'source_fenced', '--run-id', this.runId, '--source-boot-id', bootId(minio), '--fence-identity', JSON.stringify(identity), '--evidence', JSON.stringify({ fence: 'minio-recreated-internal', networks: networkNames(minio) })]);
      phase = 'source_fenced';
      this.crashPoint('mark_source_fenced');
    }

    if (phase === 'source_fenced') {
      const remaining = this.checkAbort('backup');
      const fenced = await this.status();
      const fi = fenced.fence_identity as FenceIdentity;
      const backupDir = join(this.runDir(), `window-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      await this.step('backup', async () => {
        const env = {
          TOWER_BACKUP_APP_CONTAINER: fi.tower?.name || `${this.o.project}-no-tower`,
          TOWER_BACKUP_MAIN_CONTAINER: (await this.serviceContainer('postgres'))?.Name.replace(/^\//, '') || '',
          TOWER_BACKUP_GRAPH_CONTAINER: (await this.serviceContainer('graph-postgres'))?.Name.replace(/^\//, '') || '',
          TOWER_BACKUP_MINIO_CONTAINER: fi.minio.name,
          TOWER_BACKUP_STORAGE_PROVIDER: 'minio',
        };
        const b = await run(['bash', join(REPO_ROOT, 'scripts/tower-backup.sh'), 'backup', '--output', backupDir, '--recipient', this.o.backupRecipient, '--quiesced', '--storage-provider', 'minio'], { env, timeoutMs: remaining });
        if (b.code !== 0) throw new HostError(EXIT.FENCE_OR_BACKUP, `Window backup failed (exit ${b.code}${b.timedOut ? ', deadline' : ''}): ${b.stderr.trim().slice(-500)}`, b.timedOut ? { abort_rule: true } : undefined);
        const v = await run(['bash', join(REPO_ROOT, 'scripts/tower-backup.sh'), 'verify', '--backup', backupDir, '--identity', this.o.backupIdentity], { timeoutMs: Math.max(60_000, this.remainingMs()) });
        if (v.code !== 0) throw new HostError(EXIT.FENCE_OR_BACKUP, `Window backup verification failed: ${v.stderr.trim().slice(-500)}`);
        await this.encryptConfigArtifact(join(backupDir, 'config.tar.age'));
      });
      await this.data(['mark', '--phase', 'backed_up', '--run-id', this.runId, '--verified-backup-dir', backupDir, '--backup-manifest-sha256', fileDigest(join(backupDir, 'manifest.json.age')), '--evidence', JSON.stringify({ backup: 'verified', config_artifact_sha256: fileDigest(join(backupDir, 'config.tar.age')) })]);
      phase = 'backed_up';
      this.crashPoint('mark_backed_up');
    }

    if (phase === 'backed_up') {
      const remaining = this.checkAbort('delta');
      await this.step('delta', () => this.data(['delta', '--concurrency', String(this.o.concurrency)], { timeoutMs: remaining }));
      phase = 'synced';
    }

    if (phase === 'synced') {
      this.checkAbort('target_boundary');
      await this.step('target_boundary', async () => {
        await this.killRunContainers(true);
        await this.ensureSeaweedfsInternal(creds, true);
      });
      const remaining = this.checkAbort('verify');
      const sfs = await this.serviceContainer('seaweedfs');
      await this.step('verify', () => this.data(['verify', '--concurrency', String(this.o.concurrency), '--target-boot-id', bootId(sfs!)], { timeoutMs: remaining }));
      phase = 'verified';
    }

    if (phase === 'verified' || phase === 'switch_prepared') {
      this.checkAbort('prepare_switch');
      const hs = this.hostState();
      if (fileDigest(this.o.envFile) !== hs.old_config_digest || fileDigest(oldPath) !== hs.old_config_digest) {
        throw new HostError(EXIT.FENCE_OR_BACKUP, `${this.o.envFile} changed during the window; refusing to prepare the switch.`);
      }
      const adminPath = this.adminEnvPath(creds);
      const plan = planSwitch(readEnvFile(oldPath), adminPath, this.o.seaweedfsPostPort, this.seaweedfsImage().ref);
      const rendered = renderSwitchedEnv(readFileSync(oldPath, 'utf8'), creds, plan, this.runId);
      atomicWrite(newPath, rendered, 0o600);
      this.saveHostState({ new_config_digest: sha256Hex(rendered), post_port: plan.postPort, admin_env_path: adminPath });
      if (phase === 'verified') await this.step('prepare_switch', () => this.data(['prepare-switch', '--old-config-digest', hs.old_config_digest, '--new-config-digest', sha256Hex(rendered)]));
      phase = 'switch_prepared';
    }

    if (phase === 'switch_prepared') {
      this.checkAbort('rewrite_etags');
      await this.step('rewrite_etags', () => this.data(['rewrite-etags']));
      phase = 'db_switched';
    }

    if (phase === 'db_switched') {
      this.checkAbort('config_switch');
      const fresh = await this.status();
      const hs = this.hostState();
      if (fresh.old_config_digest !== hs.old_config_digest || fresh.new_config_digest !== hs.new_config_digest) throw new HostError(EXIT.FENCE_OR_BACKUP, 'Journal and host config digests disagree; refusing the config switch.');
      if (fileDigest(newPath) !== hs.new_config_digest) throw new HostError(EXIT.FENCE_OR_BACKUP, 'Rendered new config does not match its journalled digest.');
      if (!hs.admin_env_path || hs.admin_env_path !== this.adminEnvPath(creds) || readEnvFile(newPath).get('SEAWEEDFS_ADMIN_ENV_FILE') !== hs.admin_env_path) {
        throw new HostError(EXIT.FENCE_OR_BACKUP, 'Prepared admin env path disagrees with the selected env file; refusing the config switch.');
      }
      await this.step('config_switch', async () => {
        writeFileOnce(hs.admin_env_path, renderAdminEnv(creds));
        casReplaceFile(this.o.envFile, hs.old_config_digest, readFileSync(newPath, 'utf8'));
      });
      this.crashPoint('config_written');
      await this.data(['mark', '--phase', 'config_switched', '--run-id', this.runId, '--config-digest', fileDigest(this.o.envFile), '--evidence', JSON.stringify({ config: 'switched' })]);
      phase = 'config_switched';
    }

    if (phase === 'config_switched') {
      this.checkAbort('start_intent');
      if (fileDigest(this.o.envFile) !== this.hostState().new_config_digest) throw new HostError(EXIT.FENCE_OR_BACKUP, 'Live config is not the journalled new config; refusing start_intent.');
      await this.data(['mark', '--phase', 'start_intent', '--run-id', this.runId, '--evidence', JSON.stringify({ write_boundary: 'start_intent', window_ms_before_start: Date.now() - this.windowStartedAt })]);
      this.event('start_intent', { window_ms: Date.now() - this.windowStartedAt });
      phase = 'start_intent';
      this.crashPoint('mark_start_intent');
    }

    if (phase === 'start_intent' || phase === 'started') {
      const minio = await this.serviceContainer('minio');
      if (minio && !isStopped(minio) && fenceProblems(minio, this.o.project).length) throw new HostError(EXIT.SMOKE_FAILED, 'MinIO is reachable outside the fence after start_intent; refusing to start NStack.');
      const tower = await this.serviceContainer('tower');
      const towerServing = Boolean(tower?.State.Running) && phase === 'started';
      if (!towerServing) {
        await this.step('seaweedfs_publish', async () => {
          await this.compose(this.o.envFile, 'seaweedfs', ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'seaweedfs'], { failCode: EXIT.SMOKE_FAILED, what: 'publish SeaweedFS' });
          const c = await this.waitHealthy('seaweedfs');
          await this.assertSeaweedfsImage(c);
          const env = readEnvFile(this.o.envFile);
          const ports = publishedPorts(c);
          if (!ports.some((p) => p.includes(`:${env.get('SEAWEEDFS_API_HOST_PORT')}->8333`))) throw new HostError(EXIT.SMOKE_FAILED, `SeaweedFS did not bind its post-cutover port (${ports.join(', ')}).`);
        });
        // The publish recreate is the last target restart before NStack serves: verify everything again.
        const sfs = await this.serviceContainer('seaweedfs');
        const strict = !this.hostState().tower_start_requested_at;
        await this.step('verify_published', () => this.data(['verify', '--published', ...(strict ? ['--strict'] : []), '--concurrency', String(this.o.concurrency), '--target-boot-id', bootId(sfs!)], { timeoutMs: 60 * MINUTE }));
        this.saveHostState({ tower_start_requested_at: new Date().toISOString(), published_boot_id: bootId(sfs!) });
      }
      const health = await this.step('start_tower', async () => {
        await this.startTower(this.runId);
        return this.towerHealth();
      });
      if (phase === 'start_intent') {
        await this.data(['mark', '--phase', 'started', '--run-id', this.runId, '--evidence', JSON.stringify({ health })]);
        phase = 'started';
      }
      const env = readEnvFile(this.o.envFile);
      const smokeArgs = ['smoke-data', '--api-url', this.o.apiUrl, '--expected-public-endpoint', env.get('STORAGE_S3_ENDPOINT_PUBLIC') || ''];
      if (this.o.checkPublicPut) smokeArgs.push('--check-public-put');
      if (this.o.sampleCount !== undefined) smokeArgs.push('--sample-count', String(this.o.sampleCount));
      await this.step('smoke', () => this.data(smokeArgs, { timeoutMs: 30 * MINUTE }));
      await this.step('commit', () => this.data(['commit']));
      phase = 'committed';
    }

    if (phase === 'committed') {
      await this.step('stop_source', () => this.stopService(this.sourceEnvFile(), 'minio', 'minio'));
      const minio = await this.serviceContainer('minio');
      if (!isStopped(minio)) throw new HostError(EXIT.SMOKE_FAILED, 'MinIO is not stopped after commit.');
      this.saveHostState({ source_stopped_at: new Date().toISOString(), source_container: minio?.Id ?? null, source_volume: minio ? dataVolume(minio) : null });
    }
    const final = await this.status();
    return { ok: true, run_id: this.runId, phase: final.phase, window_ms: this.hostState().window_started_at ? Date.now() - Date.parse(this.hostState().window_started_at) : null, smoke: final.smoke_evidence, source_stopped: true };
  }

  async rollback(): Promise<{ result: any }> {
    const st = await this.status();
    if (!st.has_run) return { result: { ok: true, boundary: 'RB0', note: 'no migration run' } };
    this.bindRun(st);
    const rb2 = POST_WRITE.includes(st.phase) || (st.phase === 'rolling_back' && POST_WRITE.includes(st.rollback_from_phase));
    if (rb2 && !this.o.reverseMigrate) {
      throw new HostError(EXIT.ROLLBACK_REFUSED, `Bare rollback refused in phase ${st.phase}${st.rollback_from_phase ? ` (from ${st.rollback_from_phase})` : ''}: at or after start_intent only --reverse-migrate (RB2) can return to MinIO; otherwise fail forward.`);
    }
    if (!rb2 && this.o.reverseMigrate) throw new HostError(EXIT.PHASE_DENIED, `--reverse-migrate applies only at or after start_intent (phase ${st.phase}).`);
    if (st.phase === 'rolled_back') return { result: { ok: true, phase: 'rolled_back', note: 'already rolled back' } };
    if (!['planned', 'precopied', 'rolling_back', ...QUIESCED, ...POST_WRITE].includes(st.phase)) throw new HostError(EXIT.PHASE_DENIED, `Rollback is not applicable in phase ${st.phase}.`);
    return rb2 ? { result: await this.rollbackRb2(st) } : { result: await this.rollbackRb1(st) };
  }

  /** Restore the run's old config if the live file holds its new config; refuse anything else. */
  restoreOldConfig() {
    const oldPath = join(this.runDir(), 'old-config.env');
    if (!existsSync(oldPath)) return 'no-snapshot';
    const hs = this.hostState();
    const current = fileDigest(this.o.envFile);
    if (current === hs.old_config_digest) return 'already-old';
    if (hs.new_config_digest && current === hs.new_config_digest) {
      if (fileDigest(oldPath) !== hs.old_config_digest) throw new HostError(EXIT.FENCE_OR_BACKUP, 'Saved old config does not match its recorded digest; refusing a blind restore.');
      casReplaceFile(this.o.envFile, hs.new_config_digest, readFileSync(oldPath, 'utf8'));
      return 'restored';
    }
    throw new HostError(EXIT.FENCE_OR_BACKUP, `${this.o.envFile} matches neither this run's old nor new config (concurrent edit); restore it manually from ${oldPath}.`);
  }

  async rollbackRb1(st: any) {
    const from = st.phase === 'rolling_back' ? st.rollback_from_phase : st.phase;
    const minio = await this.serviceContainer('minio');
    const fenced = Boolean(minio && networkNames(minio).includes(`${this.o.project}_migration-source`));
    const tower = await this.serviceContainer('tower');
    if ((from === 'planned' || from === 'precopied') && !fenced && tower && tower.State.Running && fileDigest(this.o.envFile) === (this.hostState().old_config_digest ?? fileDigest(this.o.envFile))) {
      // RB0: nothing was fenced or switched; NStack keeps serving on MinIO.
      if (st.phase !== 'rolling_back') await this.step('rb0_begin', () => this.data(['rollback-begin']));
      const creds = this.targetCreds();
      const sfs = await this.serviceContainer('seaweedfs');
      if (sfs && !isStopped(sfs)) await this.step('rb0_stop_target', () => this.compose(this.o.envFile, 'seaweedfs', ['stop', '-t', '60', 'seaweedfs'], { extra: this.seaweedfsEnv(creds), what: 'stop SeaweedFS' }));
      const fin = await this.step('rb0_finish', () => this.data(['rollback-finish', '--evidence', JSON.stringify({ rb0: true })]));
      return { ok: true, boundary: 'RB0', run_id: this.runId, phase: fin.json.phase };
    }
    const fencedOrLater = from !== 'planned' && from !== 'precopied';
    await this.step('rb1_stop_tower', () => this.stopService(this.o.envFile, '', 'tower'));
    if (st.phase !== 'rolling_back') await this.step('rb1_begin', () => this.data(['rollback-begin']));
    const config = await this.step('rb1_restore_config', async () => this.restoreOldConfig());
    await this.step('rb1_restore_source', () => this.restoreSourceService());
    const health = await this.step('rb1_start_tower', async () => { await this.startTower(this.runId); return this.towerHealth(); });
    const fin = await this.step('rb1_finish', () => this.data(['rollback-finish', '--evidence', JSON.stringify({ rb1_config: config, rb1_health: health, rb1_from_fenced: fencedOrLater })]));
    return { ok: true, boundary: 'RB1', run_id: this.runId, phase: fin.json.phase, config, health };
  }

  async rollbackRb2(st: any) {
    const creds = this.targetCreds();
    await this.step('rb2_stop_tower', () => this.stopService(this.o.envFile, '', 'tower'));
    await this.step('rb2_fence_target', () => this.ensureSeaweedfsInternal(creds, true));
    await this.step('rb2_fence_source', () => this.fenceSource());
    if (!(st.phase === 'rolling_back' && st.last_evidence?.rb2_reverse_synced === true)) {
      await this.step('rb2_reverse_sync', () => this.data(['reverse-sync', '--concurrency', String(this.o.concurrency)], { timeoutMs: 4 * 60 * MINUTE }));
    }
    const config = await this.step('rb2_restore_config', async () => this.restoreOldConfig());
    await this.step('rb2_restore_source', () => this.restoreSourceService());
    const health = await this.step('rb2_start_tower', async () => { await this.startTower(this.runId); return this.towerHealth(); });
    await this.step('rb2_smoke', () => this.data(['smoke-data', '--store', 'source', '--api-url', this.o.apiUrl], { timeoutMs: 30 * MINUTE }));
    const fin = await this.step('rb2_finish', () => this.data(['rollback-finish', '--evidence', JSON.stringify({ rb2_config: config, rb2_health: health })]));
    return { ok: true, boundary: 'RB2', run_id: this.runId, phase: fin.json.phase, config, health };
  }

  async retireSource() {
    if (this.o.confirm !== this.o.project) throw new HostError(EXIT.USAGE, `retire-source requires --confirm ${this.o.project}`);
    const st = await this.status();
    this.bindRun(st);
    if (st.phase !== 'committed') throw new HostError(EXIT.PHASE_DENIED, `retire-source requires phase committed (current ${st.phase}).`);
    const committedAt = Date.parse(st.timestamps?.committed_at || '');
    if (!Number.isFinite(committedAt) || Date.now() - committedAt < this.o.retentionDays * 86_400_000) throw new HostError(EXIT.PHASE_DENIED, `Retention of ${this.o.retentionDays} days since commit has not elapsed.`);
    const fi = st.fence_identity as FenceIdentity | null;
    const minio = await this.serviceContainer('minio');
    if (!fi || !minio) throw new HostError(EXIT.PHASE_DENIED, 'Fence identity or MinIO container missing; refusing retirement.');
    if (!isStopped(minio)) throw new HostError(EXIT.PHASE_DENIED, 'MinIO is running; refusing retirement.');
    if (minio.Id !== fi.minio.id || minio.Image !== fi.minio.image || dataVolume(minio) !== fi.minio.volume || minio.Config.Labels['com.docker.compose.project'] !== this.o.project || `minio:${this.o.project}:${fi.minio.volume}` !== st.fingerprint_details?.source_identity) {
      throw new HostError(EXIT.PHASE_DENIED, 'MinIO container, image or volume do not match the journalled fenced source; refusing retirement.');
    }
    const manifest = join(st.verified_backup_dir || '', 'manifest.json.age');
    if (!st.verified_backup_dir || !existsSync(manifest) || fileDigest(manifest) !== st.backup_manifest_sha256) throw new HostError(EXIT.PHASE_DENIED, 'The verified window backup is missing or its manifest digest changed; refusing retirement.');
    // An unchanged manifest does not prove the archives are still present and intact: verify the
    // whole encrypted set and the config artifact with the backup identity before deleting anything.
    if (!this.o.backupIdentity) throw new HostError(EXIT.USAGE, 'retire-source requires --backup-identity to re-verify the window backup before deletion.');
    const verify = await run(['bash', join(REPO_ROOT, 'scripts/tower-backup.sh'), 'verify', '--backup', st.verified_backup_dir, '--identity', this.o.backupIdentity], { timeoutMs: 4 * 60 * MINUTE });
    if (verify.code !== 0) throw new HostError(EXIT.PHASE_DENIED, `Window backup verification failed; refusing retirement: ${verify.stderr.trim().slice(-500)}`);
    const configArtifact = join(st.verified_backup_dir, 'config.tar.age');
    const configCheck = existsSync(configArtifact) ? await run(['age', '--decrypt', '--identity', this.o.backupIdentity, '--output', '/dev/null', configArtifact], { timeoutMs: 60_000 }) : null;
    if (!configCheck || configCheck.code !== 0) throw new HostError(EXIT.PHASE_DENIED, 'The encrypted config artifact is missing or does not decrypt with the backup identity; refusing retirement.');
    await this.step('retire_rm_container', async () => { const r = await this.docker(['rm', minio.Id]); if (r.code !== 0) throw new HostError(EXIT.FENCE_OR_BACKUP, r.stderr.trim()); });
    await this.step('retire_rm_volume', async () => { const r = await this.docker(['volume', 'rm', fi.minio.volume!]); if (r.code !== 0) throw new HostError(EXIT.FENCE_OR_BACKUP, r.stderr.trim()); });
    await this.data(['mark', '--phase', 'source_retired', '--run-id', this.runId, '--evidence', JSON.stringify({ removed_container: minio.Id, removed_volume: fi.minio.volume, backup_retained: st.verified_backup_dir })]);
    return { ok: true, run_id: this.runId, removed_container: minio.Id, removed_volume: fi.minio.volume };
  }

  async hostStatus() {
    const st = await this.status();
    if (st.has_run) this.bindRun(st);
    const view = async (svc: string) => {
      const c = await this.serviceContainer(svc);
      return c ? { name: c.Name.replace(/^\//, ''), state: c.State.Status, started_at: c.State.StartedAt, ports: publishedPorts(c), networks: networkNames(c) } : null;
    };
    let adminEnvPath: string;
    try { adminEnvPath = resolveAdminEnvPath({ envFile: this.o.envFile, env: readEnvFile(this.o.envFile), projectDir: REPO_ROOT, targetEnvFile: this.o.targetEnvFile }); } catch (err) { adminEnvPath = `unresolved: ${err instanceof Error ? err.message : String(err)}`; }
    return { journal: st, host: { admin_env_path: adminEnvPath, tower: await view('tower'), minio: await view('minio'), seaweedfs: await view('seaweedfs'), env_digest: fileDigest(this.o.envFile), run_state: st.has_run ? this.hostState() : null, runs: existsSync(this.runsDir) ? readdirSync(this.runsDir) : [] } };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv[0] || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    console.log(usage());
    return 0;
  }
  const o = parseOptions(argv);
  for (const f of [o.envFile, o.composeFile, ...(o.fips ? [o.fipsEnvFile, o.fipsComposeFile] : [])]) {
    if (!existsSync(f)) throw new HostError(EXIT.PREFLIGHT_BLOCK, `Required file not found: ${f}`);
  }
  if (o.fips && readEnvFile(o.fipsEnvFile).get('TOWER_FIPS_ENABLED') !== 'true') throw new HostError(EXIT.PREFLIGHT_BLOCK, `${o.fipsEnvFile} must declare TOWER_FIPS_ENABLED=true.`);
  if (o.backupIdentity && !existsSync(o.backupIdentity)) throw new HostError(EXIT.USAGE, `Backup identity ${o.backupIdentity} not found.`);
  if (o.command === 'retire-source' && !o.backupIdentity) throw new HostError(EXIT.USAGE, 'retire-source requires --backup-identity to re-verify the window backup before deletion.');
  const orch = new Orchestrator(o);
  await orch.prepareStateDir();
  try {
    let out: unknown;
    switch (o.command) {
      case 'target-init': out = await orch.targetInit(); break;
      case 'preflight': out = await orch.preflight(); break;
      case 'precopy': out = await orch.precopy(); break;
      case 'cutover': out = await orch.cutover(); break;
      case 'verify': {
        const st = await orch.status();
        if (st.has_run) orch.bindRun(st);
        const args = ['verify', '--concurrency', String(o.concurrency)];
        if (o.standalone) args.push('--standalone', '--store', o.store);
        out = (await orch.data(args, { timeoutMs: 4 * 60 * MINUTE })).json;
        break;
      }
      case 'status': out = await orch.hostStatus(); break;
      case 'rollback': out = (await orch.rollback()).result; break;
      case 'retire-source': out = await orch.retireSource(); break;
      default: throw new HostError(EXIT.USAGE, `Unknown command ${o.command}\n${usage()}`);
    }
    console.log(JSON.stringify(out, null, 2));
    return 0;
  } finally {
    orch.release();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  const code = err instanceof HostError ? err.exitCode : 1;
  console.error(JSON.stringify({ ok: false, exit_code: code, error: err instanceof Error ? err.message : String(err), ...(err instanceof HostError && err.details !== undefined ? { details: err.details } : {}) }, null, 2));
  process.exit(code);
});
