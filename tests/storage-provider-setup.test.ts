import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeInstallation } from '../src/installation/bootstrap';
import {
  detectSetupProjectStorageProvider,
  parseSetupStorageProviderFile,
  resolveBootstrapStorageProvider,
  SETUP_STORAGE_PROVIDER_FILE,
} from '../src/installation/setup-storage-provider';
import { removeInstallation, type Run, type Snapshot } from '../scripts/nstack-remove';

const root = join(import.meta.dir, '..');

describe('E2 setup bootstrap and storage-provider.json persistence', () => {
  test('fresh setup defaults to seaweedfs, isolates admin creds outside bootstrap dir, and preserves migrated app creds on repeat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nstack-bootstrap-fresh-'));
    const storageCredsDir = mkdtempSync(join(tmpdir(), 'nstack-storage-creds-'));
    try {
      const first = await initializeInstallation(dir, { storageCredentialsDirectory: storageCredsDir });
      expect(first.storage_provider).toBe('seaweedfs');
      expect(first.storage_admin).not.toBeNull();
      const bootstrap1 = JSON.parse(readFileSync(join(dir, 'bootstrap.json'), 'utf8'));
      const provider1 = parseSetupStorageProviderFile(
        readFileSync(join(dir, SETUP_STORAGE_PROVIDER_FILE), 'utf8'),
      );
      expect(provider1).toEqual({ version: 1, provider: 'seaweedfs' });
      expect(first.storage_admin!.admin_access_key).not.toBe(bootstrap1.storage_access_key);
      // Admin credentials MUST NOT be written into Tower-mounted bootstrap dir.
      expect(() => readFileSync(join(dir, 'storage-admin.json'), 'utf8')).toThrow();
      expect(JSON.parse(readFileSync(join(storageCredsDir, 'storage-admin.json'), 'utf8')).admin_access_key).toBe(
        first.storage_admin!.admin_access_key,
      );

      const runtimeEnv = readFileSync(join(dir, 'runtime.env'), 'utf8');
      expect(runtimeEnv).toContain('STORAGE_PROVIDER=seaweedfs');
      expect(runtimeEnv).toContain('STORAGE_S3_ENDPOINT=http://seaweedfs:8333');
      expect(runtimeEnv).toContain('STORAGE_REQUIRE_SENTINEL=true');
      expect(runtimeEnv).not.toContain('SEAWEEDFS_ADMIN_');

      // Repeating bootstrap preserves identity, claim code, admin keys, and provider.
      const second = await initializeInstallation(dir, { storageCredentialsDirectory: storageCredsDir });
      expect(second.service_npub).toBe(first.service_npub);
      expect(second.storage_provider).toBe('seaweedfs');
      expect(second.storage_admin!.admin_access_key).toBe(first.storage_admin!.admin_access_key);
      const bootstrap2 = JSON.parse(readFileSync(join(dir, 'bootstrap.json'), 'utf8'));
      expect(bootstrap2.claim_code).toBe(bootstrap1.claim_code);
      expect(bootstrap2.service_nsec).toBe(bootstrap1.service_nsec);

      // Simulate migrated setup install with rotated SeaweedFS app credentials: repeat bootstrap keeps rotated keys.
      const rotatedAccess = randomBytes(16).toString('hex');
      const rotatedSecret = 'a'.repeat(64);
      writeFileSync(
        join(dir, 'storage-seaweedfs-app.json'),
        JSON.stringify({ version: 1, access_key: rotatedAccess, secret_key: rotatedSecret }),
      );
      const afterMigrationUpdate = await initializeInstallation(dir, {
        storageCredentialsDirectory: storageCredsDir,
      });
      expect(afterMigrationUpdate.storage_access_key).toBe(rotatedAccess);
      expect(afterMigrationUpdate.storage_secret_key).toBe(rotatedSecret);
      const updatedRuntime = readFileSync(join(dir, 'runtime.env'), 'utf8');
      expect(updatedRuntime).toContain(`STORAGE_S3_ACCESS_KEY=${rotatedAccess}`);
      expect(updatedRuntime).toContain(`STORAGE_S3_SECRET_KEY=${rotatedSecret}`);

      // Conflicting override fails closed without altering bootstrap.json.
      await expect(
        initializeInstallation(dir, { requestedProvider: 'minio', storageCredentialsDirectory: storageCredsDir }),
      ).rejects.toThrow(/Storage provider conflict/);
      expect(readFileSync(join(dir, 'bootstrap.json'), 'utf8')).toBe(JSON.stringify(bootstrap1));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(storageCredsDir, { recursive: true, force: true });
    }
  });

  test('existing MinIO bootstrap without storage-provider.json upgrades cleanly to minio and refuses silent switch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nstack-bootstrap-legacy-'));
    try {
      // Seed an existing pre-SeaweedFS install (explicit minio, then delete storage-provider.json to mimic legacy).
      const legacy = await initializeInstallation(dir, { requestedProvider: 'minio' });
      const bootstrapBefore = readFileSync(join(dir, 'bootstrap.json'), 'utf8');
      rmSync(join(dir, SETUP_STORAGE_PROVIDER_FILE));

      // Refuses silent switch to seaweedfs without altering bootstrap.json.
      await expect(
        initializeInstallation(dir, { requestedProvider: 'seaweedfs' }),
      ).rejects.toThrow(/Storage provider conflict/);
      expect(readFileSync(join(dir, 'bootstrap.json'), 'utf8')).toBe(bootstrapBefore);

      // Unset request resolves legacy install to minio and persists storage-provider.json.
      const upgraded = await initializeInstallation(dir);
      expect(upgraded.service_npub).toBe(legacy.service_npub);
      expect(upgraded.storage_provider).toBe('minio');
      expect(
        parseSetupStorageProviderFile(readFileSync(join(dir, SETUP_STORAGE_PROVIDER_FILE), 'utf8')),
      ).toEqual({ version: 1, provider: 'minio' });
      const runtimeEnv = readFileSync(join(dir, 'runtime.env'), 'utf8');
      expect(runtimeEnv).toContain('STORAGE_PROVIDER=minio');
      expect(runtimeEnv).toContain('STORAGE_S3_ENDPOINT=http://minio:9000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('external-s3 rejects unsafe/shell-injectable endpoints BEFORE creating bootstrap.json or storage-provider.json', async () => {
    // Credential-bearing URL built with the URL setters so no credential literal is tracked.
    const withCredentials = (base: string) => { const u = new URL(base); u.username = 'user'; u.password = 'pass'; return u.href; };
    const badEndpoints = [
      '',
      'https://s3.example.com;echo PWN',
      'https://s3.example.com/$(id)',
      'https://s3.example.com\nADMIN_NPUB=npub1evil',
      'https://s3.example.com echo PWN',
      withCredentials('https://s3.example.com'),
      'https://s3.example.com/bucket?x=1',
      'https://s3.example.com/bucket#frag',
      'http://minio:9000',
      'http://seaweedfs:8333',
    ];
    for (const ep of badEndpoints) {
      const dir = mkdtempSync(join(tmpdir(), 'nstack-bootstrap-badext-'));
      try {
        await expect(
          initializeInstallation(dir, {
            requestedProvider: 'external-s3',
            externalS3Endpoint: ep,
          }),
        ).rejects.toThrow();
        expect(() => readFileSync(join(dir, 'bootstrap.json'), 'utf8')).toThrow();
        expect(() => readFileSync(join(dir, SETUP_STORAGE_PROVIDER_FILE), 'utf8')).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('migrated setup install switching bootstrap to seaweedfs without storage-seaweedfs-app.json rotates away from MinIO key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nstack-bootstrap-migrotate-'));
    const storageCredsDir = mkdtempSync(join(tmpdir(), 'nstack-storage-creds-mig-'));
    try {
      const legacy = await initializeInstallation(dir, { requestedProvider: 'minio' });
      const legacyKey = legacy.storage_access_key;
      // Explicit migration switches provider marker to seaweedfs without pre-seeding storage-seaweedfs-app.json.
      writeFileSync(
        join(dir, SETUP_STORAGE_PROVIDER_FILE),
        JSON.stringify({ version: 1, provider: 'seaweedfs' }) + '\n',
      );
      const migrated = await initializeInstallation(dir, {
        storageCredentialsDirectory: storageCredsDir,
      });
      expect(migrated.storage_provider).toBe('seaweedfs');
      expect(migrated.storage_access_key).not.toBe(legacyKey);
      expect(migrated.storage_admin!.admin_access_key).not.toBe(migrated.storage_access_key);
      expect(migrated.storage_admin!.admin_access_key).not.toBe(legacyKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(storageCredsDir, { recursive: true, force: true });
    }
  });

  test('detectSetupProjectStorageProvider covers fresh, legacy, migrated, and fails closed on ambiguity', () => {
    expect(
      detectSetupProjectStorageProvider({
        hasBootstrapVolume: false,
        hasMinioStorageVolume: false,
        hasSeaweedfsStorageVolume: false,
        providerFile: null,
      }),
    ).toBe('seaweedfs');

    expect(
      detectSetupProjectStorageProvider({
        hasBootstrapVolume: true,
        hasMinioStorageVolume: true,
        hasSeaweedfsStorageVolume: false,
        providerFile: null,
      }),
    ).toBe('minio');

    // Migrated install has both volumes (cold retained MinIO + active SeaweedFS) AND durable storage-provider.json.
    expect(
      detectSetupProjectStorageProvider({
        hasBootstrapVolume: true,
        hasMinioStorageVolume: true,
        hasSeaweedfsStorageVolume: true,
        providerFile: { version: 1, provider: 'seaweedfs' },
      }),
    ).toBe('seaweedfs');

    // Ambiguous dual volumes without storage-provider.json fails closed.
    expect(() =>
      detectSetupProjectStorageProvider({
        hasBootstrapVolume: true,
        hasMinioStorageVolume: true,
        hasSeaweedfsStorageVolume: true,
        providerFile: null,
      }),
    ).toThrow(/Ambiguous installation state/);

    // Orphan storage volume without bootstrap fails closed.
    expect(() =>
      detectSetupProjectStorageProvider({
        hasBootstrapVolume: false,
        hasMinioStorageVolume: true,
        hasSeaweedfsStorageVolume: false,
        providerFile: null,
      }),
    ).toThrow(/without a matching bootstrap volume/);

    // Explicit provider disagreement fails closed.
    expect(() =>
      resolveBootstrapStorageProvider({
        bootstrapExisted: true,
        existingProviderDoc: { version: 1, provider: 'seaweedfs' },
        requestedProvider: 'minio',
      }),
    ).toThrow(/Storage provider conflict/);
  });
});

describe('E1 SeaweedFS config renderer validation', () => {
  test('renders hardened security.toml + dual-identity s3.json and fails closed on bad inputs', async () => {
    const renderer = join(root, 'deploy/nstack/render-seaweedfs-config.sh');
    expect(statSync(renderer).mode & 0o111).not.toBe(0);
    const dir = mkdtempSync(join(tmpdir(), 'nstack-sfs-render-'));
    try {
      const ok = Bun.spawn(['sh', renderer], {
        env: {
          ...Bun.env,
          SEAWEEDFS_CONFIG_DIR: dir,
          SEAWEEDFS_VALIDATE_ONLY: 'true',
          STORAGE_S3_BUCKET: 'superbased-storage',
          STORAGE_S3_ACCESS_KEY: `app_key_${randomBytes(8).toString('hex')}`,
          STORAGE_S3_SECRET_KEY: `app_secret_${randomBytes(14).toString('hex')}`,
          SEAWEEDFS_ADMIN_ACCESS_KEY: `adm_key_${randomBytes(8).toString('hex')}`,
          SEAWEEDFS_ADMIN_SECRET_KEY: `adm_secret_${randomBytes(14).toString('hex')}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await ok.exited).toBe(0);

      const secToml = readFileSync(join(dir, 'security.toml'), 'utf8');
      expect(secToml).toContain('ui = false');
      expect(secToml).toContain('enabled = false');
      expect(secToml).toContain('[jwt.signing]');
      expect(secToml).toContain('[jwt.filer_signing]');
      expect(secToml).toContain('[jwt.filer_signing.subscribe]');
      expect(secToml).toContain('white_list = "127.0.0.1,@"');

      // Rejects multiline injection even under POSIX /bin/sh (BusyBox ash safe).
      const multiline = Bun.spawn(['sh', renderer], {
        env: {
          ...Bun.env,
          SEAWEEDFS_CONFIG_DIR: dir,
          SEAWEEDFS_VALIDATE_ONLY: 'true',
          STORAGE_S3_BUCKET: 'superbased-storage',
          STORAGE_S3_ACCESS_KEY: 'app_key_1',
          STORAGE_S3_SECRET_KEY: 'line1\nline2',
          SEAWEEDFS_ADMIN_ACCESS_KEY: 'adm_key_1',
          SEAWEEDFS_ADMIN_SECRET_KEY: 'adm_secret_1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await multiline.exited).not.toBe(0);

      const s3Json = JSON.parse(readFileSync(join(dir, 's3.json'), 'utf8'));
      expect(s3Json.identities).toHaveLength(2);
      expect(s3Json.identities.some((i: any) => i.name === 'anonymous')).toBe(false);
      const admin = s3Json.identities.find((i: any) => i.name === 'nstack_admin');
      const app = s3Json.identities.find((i: any) => i.name === 'nstack_app');
      expect(admin.actions).toContain('Admin');
      expect(app.actions).toEqual([
        'Read:superbased-storage',
        'List:superbased-storage',
        'Tagging:superbased-storage',
        'Write:superbased-storage',
      ]);

      // Rejects identical app and admin access keys.
      const sameKey = Bun.spawn(['sh', renderer], {
        env: {
          ...Bun.env,
          SEAWEEDFS_CONFIG_DIR: dir,
          SEAWEEDFS_VALIDATE_ONLY: 'true',
          STORAGE_S3_BUCKET: 'superbased-storage',
          STORAGE_S3_ACCESS_KEY: 'same_key',
          STORAGE_S3_SECRET_KEY: 'app_secret',
          SEAWEEDFS_ADMIN_ACCESS_KEY: 'same_key',
          SEAWEEDFS_ADMIN_SECRET_KEY: 'adm_secret',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await sameKey.exited).not.toBe(0);

      // Rejects missing admin credentials.
      const missingAdmin = Bun.spawn(['sh', renderer], {
        env: {
          PATH: Bun.env.PATH || '/usr/bin:/bin',
          SEAWEEDFS_CONFIG_DIR: dir,
          SEAWEEDFS_VALIDATE_ONLY: 'true',
          STORAGE_S3_BUCKET: 'superbased-storage',
          STORAGE_S3_ACCESS_KEY: 'app_key',
          STORAGE_S3_SECRET_KEY: 'app_secret',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await missingAdmin.exited).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('E2 rebuild_deploy_docker.sh profile inference and conflict guards', () => {
  async function runRebuild(envProd: string, extraEnv: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'tower-rebuild-provider-'));
    try {
      mkdirSync(join(dir, 'docker'));
      mkdirSync(join(dir, 'bin'));
      copyFileSync(join(root, 'docker/compose-fips-options.sh'), join(dir, 'docker/compose-fips-options.sh'));
      copyFileSync(join(root, 'rebuild_deploy_docker.sh'), join(dir, 'deploy.sh'));
      writeFileSync(join(dir, '.env.prod'), envProd);
      writeFileSync(join(dir, 'docker-compose.prod.yml'), 'services: {}\n');
      writeFileSync(join(dir, 'docker-compose.fips.yml'), 'services: {}\n');
      writeFileSync(
        join(dir, '.env.fips'),
        'TOWER_FIPS_ENABLED=true\nTOWER_FIPS_NODE_NPUB=test-node\nTOWER_FIPS_MESH_ADDRESS=fd00::1\nTOWER_FIPS_PORT=43100\n',
      );
      writeFileSync(join(dir, 'docker/ensure-bun-base.sh'), '#!/usr/bin/env bash\nprintf "test-bun-base\\n"\n', {
        mode: 0o755,
      });
      const log = join(dir, 'log');
      for (const cmd of ['docker', 'bun', 'curl']) {
        writeFileSync(
          join(dir, 'bin', cmd),
          `#!/usr/bin/env bash\nprintf '%s [PROFILES=%s TOWER_ENV=%s] %s\\n' '${cmd}' "\${COMPOSE_PROFILES:-}" "\${TOWER_ENV_FILE:-}" "$*" >> "$LOG"\n`,
          { mode: 0o755 },
        );
      }
      const p = Bun.spawn(['bash', 'deploy.sh'], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...Bun.env,
          COMPOSE_PROFILES: '',
          STORAGE_PROVIDER: '',
          STORAGE_S3_ENDPOINT: '',
          STORAGE_S3_ACCESS_KEY: '',
          STORAGE_S3_SECRET_KEY: '',
          SEAWEEDFS_ACCESS_KEY: '',
          SEAWEEDFS_SECRET_KEY: '',
          SEAWEEDFS_IMAGE: '',
          PATH: `${join(dir, 'bin')}:${Bun.env.PATH}`,
          ENV_FILE: '.env.prod',
          COMPOSE_FILE: 'docker-compose.prod.yml',
          FIPS_ENV_FILE: '.env.fips',
          FIPS_COMPOSE_FILE: 'docker-compose.fips.yml',
          LOG: log,
          ...extraEnv,
        },
      });
      const [code, stdout, stderr] = await Promise.all([
        p.exited,
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      const calls = (() => {
        try {
          return readFileSync(log, 'utf8');
        } catch {
          return '';
        }
      })();
      return { code, stdout, stderr, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('existing MinIO env infers minio; external S3 infers no profile; migrated SeaweedFS never revives minio; honors exported env precedence and overlap credential guard', async () => {
    const minio = await runRebuild('TOWER_HOST_PORT=3100\nSTORAGE_S3_ENDPOINT=http://minio:9000\n');
    expect(minio.code).toBe(0);
    expect(minio.calls).toContain('[PROFILES=minio TOWER_ENV=.env.prod] compose');

    const ext = await runRebuild('TOWER_HOST_PORT=3100\nSTORAGE_S3_ENDPOINT=https://s3.external.invalid # comment\n');
    expect(ext.code).toBe(0);
    expect(ext.calls).toContain('[PROFILES= TOWER_ENV=.env.prod] compose');

    const sfsImage = `sha256:${'d'.repeat(64)}`;
    const sfs = await runRebuild(
      `TOWER_HOST_PORT=3100\nSTORAGE_PROVIDER=seaweedfs # active\nSTORAGE_S3_ENDPOINT=http://seaweedfs:8333\nSEAWEEDFS_IMAGE=${sfsImage}\n`,
    );
    expect(sfs.code).toBe(0);
    expect(sfs.calls).toContain('[PROFILES=seaweedfs TOWER_ENV=.env.prod] compose');
    expect(sfs.calls).toContain(`bun [PROFILES=seaweedfs TOWER_ENV=.env.prod] scripts/nstack-seaweedfs-image.ts verify ${sfsImage}`);
    expect(sfs.calls).not.toContain('PROFILES=minio');

    // The seaweedfs profile never falls back to a stock or unrecorded image.
    const sfsNoImage = await runRebuild('TOWER_HOST_PORT=3100\nSTORAGE_PROVIDER=seaweedfs\nSTORAGE_S3_ENDPOINT=http://seaweedfs:8333\n');
    expect(sfsNoImage.code).not.toBe(0);
    expect(sfsNoImage.stderr).toContain('requires SEAWEEDFS_IMAGE');
    expect(sfsNoImage.calls).not.toContain('build tower');
    expect(sfsNoImage.calls).not.toContain(' up -d');

    // Exported STORAGE_PROVIDER + STORAGE_S3_ENDPOINT override ENV_FILE (Compose precedence).
    const exportedOverride = await runRebuild(
      'TOWER_HOST_PORT=3100\nSTORAGE_S3_ENDPOINT=http://minio:9000\n',
      { STORAGE_PROVIDER: 'seaweedfs', STORAGE_S3_ENDPOINT: 'http://seaweedfs:8333', SEAWEEDFS_IMAGE: sfsImage },
    );
    expect(exportedOverride.code).toBe(0);
    expect(exportedOverride.calls).toContain(`scripts/nstack-seaweedfs-image.ts verify ${sfsImage}`);
    expect(exportedOverride.calls).toContain('[PROFILES=seaweedfs TOWER_ENV=.env.prod] compose');

    // Exported STORAGE_PROVIDER=seaweedfs alone over MinIO endpoint fails closed (does not bypass conflict check).
    const exportedConflict = await runRebuild(
      'TOWER_HOST_PORT=3100\nSTORAGE_S3_ENDPOINT=http://minio:9000\n',
      { STORAGE_PROVIDER: 'seaweedfs' },
    );
    expect(exportedConflict.code).not.toBe(0);
    expect(exportedConflict.stderr).toContain('conflicts');

    // Overlap COMPOSE_PROFILES=minio,seaweedfs requires explicit distinct SEAWEEDFS_ACCESS_KEY/SECRET_KEY.
    const overlapMissingKey = await runRebuild(
      'TOWER_HOST_PORT=3100\nSTORAGE_PROVIDER=minio\nSTORAGE_S3_ENDPOINT=http://minio:9000\nSTORAGE_S3_ACCESS_KEY=minio_k\n',
      { COMPOSE_PROFILES: 'minio,seaweedfs' },
    );
    expect(overlapMissingKey.code).not.toBe(0);
    expect(overlapMissingKey.stderr).toContain('SEAWEEDFS_ACCESS_KEY');

    const overlapSameKey = await runRebuild(
      'TOWER_HOST_PORT=3100\nSTORAGE_PROVIDER=minio\nSTORAGE_S3_ENDPOINT=http://minio:9000\nSTORAGE_S3_ACCESS_KEY=minio_k\nSEAWEEDFS_ACCESS_KEY=minio_k\nSEAWEEDFS_SECRET_KEY=sfs_s\n',
      { COMPOSE_PROFILES: 'minio,seaweedfs' },
    );
    expect(overlapSameKey.code).not.toBe(0);
    expect(overlapSameKey.stderr).toContain('distinct');

    const conflict = await runRebuild(
      'TOWER_HOST_PORT=3100\nSTORAGE_PROVIDER=seaweedfs\nSTORAGE_S3_ENDPOINT=http://minio:9000\n',
    );
    expect(conflict.code).not.toBe(0);
    expect(conflict.stderr).toContain('conflicts');
  });
});

describe('E2 nstack-remove SeaweedFS and retained cold volume reporting', () => {
  test('treats seaweedfs as no-force datastore and reports retained cold storage volumes even with stopped MinIO container', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nstack-rm-sfs-'));
    const oldHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const P = 'com.docker.compose.project';
      const snap: Snapshot = {
        daemon: 'daemon',
        containers: [
          {
            Id: 'sfs-id',
            Name: '/mig-seaweedfs-1',
            State: { Running: true, Status: 'running' },
            Config: {
              Labels: {
                [P]: 'mig',
                'com.docker.compose.service': 'seaweedfs',
                'com.docker.compose.project.config_files': '/repo/docker-compose.setup.yml',
              },
            },
            Mounts: [{ Type: 'volume', Name: 'mig_storage-seaweedfs', Destination: '/data' }],
            NetworkSettings: { Networks: { default: { NetworkID: 'mig-net' } } },
          },
          {
            Id: 'minio-stopped-id',
            Name: '/mig-minio-1',
            State: { Running: false, Status: 'exited' },
            Config: {
              Labels: {
                [P]: 'mig',
                'com.docker.compose.service': 'minio',
                'com.docker.compose.project.config_files': '/repo/docker-compose.setup.yml',
              },
            },
            Mounts: [{ Type: 'volume', Name: 'mig_storage', Destination: '/data' }],
            NetworkSettings: { Networks: { default: { NetworkID: 'mig-net' } } },
          },
        ],
        volumes: [
          {
            Name: 'mig_storage-seaweedfs',
            CreatedAt: '2026-11-27T00:00:00Z',
            Driver: 'local',
            Labels: { [P]: 'mig', 'com.docker.compose.volume': 'storage-seaweedfs' },
          },
          {
            Name: 'mig_storage',
            CreatedAt: '2026-11-18T00:00:00Z',
            Driver: 'local',
            Labels: { [P]: 'mig', 'com.docker.compose.volume': 'storage' },
          },
        ],
        networks: [
          {
            Id: 'mig-net',
            Name: 'mig_default',
            Labels: { [P]: 'mig', 'com.docker.compose.network': 'default' },
            Containers: { 'sfs-id': {} },
          },
        ],
      };
      const exec: Run = async (a) => {
        if (a[0] === 'sh') return 'absent';
        if (a[0] === 'systemctl') return 'LoadState=not-found\nActiveState=inactive\nMainPID=0';
        if (a[1] === 'info') return 'daemon';
        if (a[1] === 'ps') return snap.containers.map((c) => c.Id).join('\n');
        if (a[1] === 'inspect') return JSON.stringify(snap.containers);
        if (a[2] === 'ls') return (a[1] === 'volume' ? snap.volumes.map((v) => v.Name) : snap.networks.map((n) => n.Id)).join('\n');
        if (a[2] === 'inspect') return JSON.stringify(a[1] === 'volume' ? snap.volumes : snap.networks);
        throw new Error('unexpected ' + a.join(' '));
      };
      const preview = await removeInstallation({ project: 'mig', purge: false, dryRun: true }, dir, exec);
      expect(preview.containers[0]!.stop_timeout_seconds).toBe(-1);
      expect(preview.containers[1]!.stop_timeout_seconds).toBe(-1);
      expect(preview.retained_cold_volumes).toEqual(['mig_storage']);
      expect(preview.delete_volumes).toEqual([]);
      expect(preview.preserve_volumes).toEqual(['mig_storage', 'mig_storage-seaweedfs']);
    } finally {
      process.env.HOME = oldHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
