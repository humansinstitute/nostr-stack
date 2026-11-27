import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireHostLock, assertSafeUrl, hostLockPath, casReplaceFile, fenceProblems, fileDigest, generateCredential, HostError,
  parseEnvText, planSwitch, readTargetCredentials, releaseHostLock, renderAdminEnv, renderSwitchedEnv, renderTargetCredentials,
  resolveAdminEnvPath, snapshotProblems, sourceCoordinates, writeFileOnce, type ContainerView,
} from '../scripts/nstack-migrate-storage-host-lib';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'nstack-host-lib-'));
}

// Synthetic identities generated per run (distinct app/admin, safe alphabet).
const creds = { appAccessKey: generateCredential('access'), appSecretKey: generateCredential('secret'), adminAccessKey: generateCredential('access'), adminSecretKey: generateCredential('secret') };

function container(over: Partial<ContainerView> & { running?: boolean; nets?: string[]; ports?: Record<string, any> } = {}): ContainerView {
  return {
    Id: over.Id ?? 'cid1',
    Name: '/c',
    State: { Status: over.running === false ? 'exited' : 'running', Running: over.running !== false, Restarting: false, StartedAt: 't-start', FinishedAt: 't-finish', ...(over.State || {}) },
    Image: 'img',
    Config: { Labels: { 'com.docker.compose.project': 'lab' } },
    HostConfig: { PortBindings: {} },
    NetworkSettings: { Ports: over.ports ?? {}, Networks: Object.fromEntries((over.nets ?? ['lab_migration-source']).map((n) => [n, {}])) },
    Mounts: [{ Type: 'volume', Name: 'lab_tower-minio-data', Destination: '/data' }],
  };
}

describe('storage migration host helpers', () => {
  test('env parsing follows Compose env-file rules used by the live file', () => {
    const env = parseEnvText('# c\nA=1\nexport B="two words"\nC=three # comment\nD=\'q#v\'\nbad line\nE=\n');
    expect([...env.entries()]).toEqual([['A', '1'], ['B', 'two words'], ['C', 'three'], ['D', 'q#v'], ['E', '']]);
  });

  test('switched env keeps unmanaged settings, replaces managed keys once and preserves the public meaning', () => {
    const old = 'COMPOSE_PROJECT_NAME=wingman-tower\nSTORAGE_S3_ENDPOINT=http://minio:9000\nSTORAGE_S3_ENDPOINT_PUBLIC=https://storage.example.org\nSTORAGE_S3_ACCESS_KEY=root\nSTORAGE_S3_SECRET_KEY=rootsecret\nMINIO_API_HOST_PORT=9010\nSEAWEEDFS_API_HOST_PORT=8333\nSEAWEEDFS_IMAGE=chrislusf/seaweedfs:latest\nOTHER=keep\n';
    const image = `sha256:${'a'.repeat(64)}`;
    const plan = planSwitch(parseEnvText(old), '/abs/.env.seaweedfs-admin', undefined, image);
    expect(plan).toMatchObject({ publicEndpoint: 'https://storage.example.org', postPort: 9010, bindAddress: '127.0.0.1' });
    const out = renderSwitchedEnv(old, creds, plan, 'run-1');
    const env = parseEnvText(out);
    expect(env.get('STORAGE_PROVIDER')).toBe('seaweedfs');
    expect(env.get('COMPOSE_PROFILES')).toBe('seaweedfs');
    expect(env.get('STORAGE_S3_ENDPOINT')).toBe('http://seaweedfs:8333');
    expect(env.get('STORAGE_S3_ENDPOINT_PUBLIC')).toBe('https://storage.example.org');
    expect(env.get('STORAGE_S3_ACCESS_KEY')).toBe(creds.appAccessKey);
    expect(env.get('SEAWEEDFS_API_HOST_PORT')).toBe('9010');
    expect(env.get('OTHER')).toBe('keep');
    expect(env.get('SEAWEEDFS_IMAGE')).toBe(image);
    expect(out.match(/^SEAWEEDFS_IMAGE=/gm)!.length).toBe(1);
    for (const bad of ['chrislusf/seaweedfs@sha256:' + 'b'.repeat(64), 'nstack-seaweedfs@sha256:' + 'b'.repeat(64), 'nstack-seaweedfs:4.55-nstack.1', '']) {
      expect(() => planSwitch(parseEnvText(old), '/abs/.env.seaweedfs-admin', undefined, bad)).toThrow('immutable NStack reference');
    }
    expect(env.get('MINIO_API_HOST_PORT')).toBe('9010');
    expect(out).not.toContain(creds.adminSecretKey);
    expect(out.match(/^STORAGE_S3_ACCESS_KEY=/gm)!.length).toBe(1);
    expect(renderSwitchedEnv(old, creds, plan, 'run-1')).toBe(out);
  });

  test('unsafe URLs and credentials are rejected before anything is written', () => {
    const credentialed = new URL('https://x.org');
    credentialed.username = 'u';
    credentialed.password = 'p';
    for (const bad of ['https://x.org;id', credentialed.href, 'https://x.org/?a=1', 'ftp://x.org', 'https://x.org/$(id)', 'https://x .org']) {
      expect(() => assertSafeUrl('U', bad)).toThrow(HostError);
    }
    const dir = tmp();
    try {
      const p = join(dir, 't.env');
      writeFileSync(p, renderTargetCredentials({ ...creds, appSecretKey: 'has$dollar-and-long-enough' }));
      expect(() => readTargetCredentials(p)).toThrow(/unsupported/);
      writeFileSync(p, renderTargetCredentials({ ...creds, adminAccessKey: creds.appAccessKey }));
      expect(() => readTargetCredentials(p)).toThrow(/distinct/);
      writeFileSync(p, renderTargetCredentials(creds));
      expect(readTargetCredentials(p)).toEqual(creds);
      const gen = generateCredential('secret');
      expect(gen).toMatch(/^[A-Za-z0-9]{40}$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('config CAS replaces only from the expected digest, is idempotent and refuses concurrent edits', () => {
    const dir = tmp();
    try {
      const p = join(dir, '.env.prod');
      writeFileSync(p, 'A=old\n');
      const oldDigest = fileDigest(p);
      expect(casReplaceFile(p, oldDigest, 'A=new\n')).toBe('replaced');
      expect(readFileSync(p, 'utf8')).toBe('A=new\n');
      expect((statSync(p).mode & 0o777).toString(8)).toBe('600');
      expect(casReplaceFile(p, oldDigest, 'A=new\n')).toBe('already');
      writeFileSync(p, 'A=edited-by-operator\n');
      expect(() => casReplaceFile(p, oldDigest, 'A=new\n')).toThrow(/concurrent edit/);
      expect(readFileSync(p, 'utf8')).toBe('A=edited-by-operator\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('host lock is canonical per daemon+project, exclusive, and never reclaimed automatically', () => {
    const dir = tmp();
    try {
      expect(hostLockPath(dir, 'daemon-A', 'p')).toBe(hostLockPath(dir, 'daemon-A', 'p'));
      expect(hostLockPath(dir, 'daemon-A', 'p')).not.toBe(hostLockPath(dir, 'daemon-B', 'p'));
      expect(() => hostLockPath(dir, '', 'p')).toThrow(/daemon/);
      const p = join(dir, 'x.lock');
      const start = (pid: number) => (pid === process.pid ? 'self-start' : null);
      const held = acquireHostLock(p, 'cutover', 'scope', start);
      expect(() => acquireHostLock(p, 'rollback', 'scope', start)).toThrow(/held by running pid/);
      releaseHostLock(p, held);
      expect(existsSync(p)).toBe(false);
      // A dead holder is reported as probably stale but still refused (operator removes it).
      writeFileSync(p, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), started: 'x', command: 'old', nonce: 'n', scope: 's' }));
      expect(() => acquireHostLock(p, 'cutover', 'scope', start)).toThrow(/probably stale/);
      writeFileSync(p, 'garbage');
      expect(() => acquireHostLock(p, 'cutover', 'scope', start)).toThrow(/unreadable/);
      // Releasing with a different nonce never removes someone else's lock.
      releaseHostLock(p, { ...held, nonce: 'other' });
      expect(existsSync(p)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('fence and snapshot checks fail closed on ports, networks, restarts and NStack runs after the fence', () => {
    expect(fenceProblems(container(), 'lab')).toEqual([]);
    expect(fenceProblems(container({ ports: { '9000/tcp': [{ HostIp: '127.0.0.1', HostPort: '9010' }] } }), 'lab').join()).toContain('host ports');
    expect(fenceProblems(container({ nets: ['lab_default', 'lab_migration-source'] }), 'lab').join()).toContain('networks');
    expect(fenceProblems(null, 'lab')).toEqual(['source container missing']);
    const recorded = { project: 'lab', minio: { id: 'cid1', name: 'm', started_at: 't-start', volume: 'lab_tower-minio-data', image: 'img' }, tower: { id: 'tw', name: 't', started_at: 'ts', finished_at: 'tf' } };
    const tower = container({ Id: 'tw', running: false, State: { Status: 'exited', Running: false, Restarting: false, StartedAt: 'ts', FinishedAt: 'tf' } });
    expect(snapshotProblems(recorded, container(), tower, 'lab')).toEqual([]);
    const ranAndStopped = container({ Id: 'tw', running: false, State: { Status: 'exited', Running: false, Restarting: false, StartedAt: 'ts2', FinishedAt: 'tf2' } });
    expect(snapshotProblems(recorded, container(), ranAndStopped, 'lab').join()).toContain('NStack ran after the fence');
    expect(snapshotProblems(recorded, container(), null, 'lab').join()).toContain('disappeared');
    expect(snapshotProblems(recorded, container({ State: { Status: 'running', Running: true, Restarting: false, StartedAt: 'later', FinishedAt: '' } }), tower, 'lab').join()).toContain('restarted');
  });

  test('only the bundled MinIO source is accepted by the local orchestrator', () => {
    expect(sourceCoordinates(parseEnvText('STORAGE_S3_ACCESS_KEY=a\nSTORAGE_S3_SECRET_KEY=b\n')).endpoint).toBe('http://minio:9000');
    expect(() => sourceCoordinates(parseEnvText('STORAGE_S3_ENDPOINT=https://s3.example.org\nSTORAGE_S3_ACCESS_KEY=a\nSTORAGE_S3_SECRET_KEY=b\n'))).toThrow(/bundled MinIO/);
    expect(() => sourceCoordinates(parseEnvText('STORAGE_PROVIDER=seaweedfs\nSTORAGE_S3_ACCESS_KEY=a\nSTORAGE_S3_SECRET_KEY=b\n'))).toThrow(/bundled MinIO/);
  });

  test('admin env path follows the selected env file and never falls back to the production file for other installations', () => {
    const projectDir = '/srv/nstack';
    const prodEnv = '/srv/nstack/.env.prod';
    const labEnv = '/srv/labs/a/lab.env';
    // Default production env file keeps the Compose default.
    expect(resolveAdminEnvPath({ envFile: prodEnv, env: parseEnvText(''), projectDir })).toBe('/srv/nstack/.env.seaweedfs-admin');
    expect(resolveAdminEnvPath({ envFile: prodEnv, env: parseEnvText('SEAWEEDFS_ADMIN_ENV_FILE=secrets/admin.env'), projectDir })).toBe('/srv/nstack/secrets/admin.env');
    // Any other env file must declare its own absolute admin path.
    expect(resolveAdminEnvPath({ envFile: labEnv, env: parseEnvText('SEAWEEDFS_ADMIN_ENV_FILE=/srv/labs/a/seaweedfs-admin.env'), projectDir })).toBe('/srv/labs/a/seaweedfs-admin.env');
    const refuse = (envFile: string, text: string, msg: string, targetEnvFile?: string) => {
      try { resolveAdminEnvPath({ envFile, env: parseEnvText(text), projectDir, targetEnvFile }); throw new Error('accepted'); } catch (err) {
        expect(err).toBeInstanceOf(HostError);
        expect((err as HostError).exitCode).toBe(10);
        expect((err as Error).message).toContain(msg);
      }
    };
    refuse(labEnv, '', 'must set SEAWEEDFS_ADMIN_ENV_FILE');
    refuse(labEnv, 'SEAWEEDFS_ADMIN_ENV_FILE=seaweedfs-admin.env', 'absolute path');
    refuse(labEnv, 'SEAWEEDFS_ADMIN_ENV_FILE=/srv/nstack/.env.seaweedfs-admin', 'production admin file');
    refuse(labEnv, 'SEAWEEDFS_ADMIN_ENV_FILE=/srv/nstack/../nstack/.env.seaweedfs-admin', 'production admin file');
    refuse(labEnv, 'SEAWEEDFS_ADMIN_ENV_FILE=/srv/labs/a/lab.env', 'must not be');
    refuse(labEnv, 'SEAWEEDFS_ADMIN_ENV_FILE=/srv/labs/a/state/target.env', 'must not be', '/srv/labs/a/state/target.env');
    refuse(labEnv, 'SEAWEEDFS_ADMIN_ENV_FILE="/srv/labs/a/$HOME"', 'unsupported characters');
    // The switched env carries the resolved path explicitly, so Compose and the runner agree after the switch.
    const plan = planSwitch(parseEnvText('STORAGE_S3_ENDPOINT_PUBLIC=http://127.0.0.1:29010'), '/srv/labs/a/seaweedfs-admin.env', undefined, `sha256:${'c'.repeat(64)}`);
    expect(parseEnvText(renderSwitchedEnv('A=1\n', creds, plan, 'run-1')).get('SEAWEEDFS_ADMIN_ENV_FILE')).toBe('/srv/labs/a/seaweedfs-admin.env');
  });

  test('admin env file is created once, accepted on identical resume and never overwritten', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'admin.env');
      const content = renderAdminEnv(creds);
      expect(writeFileOnce(path, content)).toBe('created');
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
      expect(writeFileOnce(path, content)).toBe('already');
      writeFileSync(path, 'SEAWEEDFS_ADMIN_ACCESS_KEY=OTHER\n');
      expect(() => writeFileOnce(path, content)).toThrow('Refusing to overwrite');
      expect(readFileSync(path, 'utf8')).toBe('SEAWEEDFS_ADMIN_ACCESS_KEY=OTHER\n');
      expect(() => writeFileOnce(join(dir, 'missing-dir', 'admin.env'), content)).toThrow('does not exist');
      expect(() => writeFileOnce(dir, content)).toThrow('not a regular file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('retire-source refuses to run without the backup identity it needs to re-verify the backup', () => {
    const res = Bun.spawnSync(['bun', join(import.meta.dir, '../scripts/nstack-migrate-storage-host.ts'), 'retire-source', '--confirm', 'wingman-tower', '--no-fips', '--env-file', join(import.meta.dir, '../.env.example')], { stderr: 'pipe', stdout: 'pipe' });
    expect(res.exitCode).toBe(2);
    expect(res.stderr.toString()).toContain('requires --backup-identity');
  });

  test('setup mode is refused honestly', async () => {
    const res = Bun.spawnSync(['bun', join(import.meta.dir, '../scripts/nstack-migrate-storage-host.ts'), 'status', '--mode', 'setup'], { stderr: 'pipe', stdout: 'pipe' });
    expect(res.exitCode).toBe(2);
    expect(res.stderr.toString()).toContain('not implemented');
  });
});
