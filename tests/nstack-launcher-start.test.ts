import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Exercise the real launcher orchestration without starting shared services.
async function launch(
  fail: string,
  opts: { extraEnv?: Record<string, string>; volumes?: string[]; providerFileContent?: string | null } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'nstack-start-'));
  try {
    const docker = join(dir, 'docker');
    const log = join(dir, 'calls');
    const volumeNames = opts.volumes ?? [];
    const volumeInspectJson = JSON.stringify(
      volumeNames.map((v) => ({
        Name: `retry-fixture_${v}`,
        Labels: {
          'com.docker.compose.project': 'retry-fixture',
          'com.docker.compose.volume': v,
        },
      })),
    );
    const providerReply =
      opts.providerFileContent === undefined || opts.providerFileContent === null
        ? '__NSTACK_MISSING__'
        : opts.providerFileContent;
    await writeFile(
      docker,
      `#!/bin/sh
echo "$*" >> "$CALLS"
case "$*" in
 'info') [ "$FAIL" != daemon ];;
 'compose version') [ "$FAIL" != compose ];;
 'volume ls '*)
   printf '%s\n' ${volumeNames.map((v) => `'retry-fixture_${v}'`).join(' ') || "''"}
   exit 0
   ;;
 'volume inspect '*)
   printf '%s\n' '${volumeInspectJson}'
   exit 0
   ;;
 'run --rm --network none -v '*'storage-provider.json'*)
   printf '%s' "$PROVIDER_REPLY"
   exit 0
   ;;
 'image inspect --format {{.Id}} nstack-seaweedfs'*)
   printf '%s\n' 'sha256:${'e'.repeat(64)}'
   ;;
 'image inspect --format {{.Id}} {{json .Config.Labels}} sha256:'*)
   printf '%s\n' 'sha256:${'e'.repeat(64)} {"org.opencontainers.image.title":"nstack-seaweedfs","org.opencontainers.image.version":"4.55-nstack.1","org.opencontainers.image.revision":"a98c9e27185cf1003eca095761a39973c60734db","io.nstack.seaweedfs.patches":"0001-s3-serve-octet-stream-for-empty-mime"}'
   ;;
 'image save --output '*) : > "$4";;
 'image inspect nstack-seaweedfs'*) [ "$FAIL" != image ];;
 'build -t nstack-seaweedfs'*) exit 1;;
 'image inspect '*) exit 0;;
 'run --rm --entrypoint bun '*) echo 1.4.4;;
 'pull '*) exit 1;;
 'compose '*'pull postgres'*) exit 0;;
 'compose '*'build bootstrap'*) [ "$FAIL" != build ];;
 'compose '*' up -d '*) exit 1;;
 *) exit 0;;
esac
`,
    );
    await chmod(docker, 0o755);
    const p = Bun.spawn([process.execPath, resolve(import.meta.dir, '../scripts/nstack-start.ts'), 'retry-fixture'], {
      env: {
        ...process.env,
        PATH: dir + ':/usr/bin:/bin',
        CALLS: log,
        NSTACK_INSTALLATIONS_DIR: join(dir, 'installations'),
        FAIL: fail,
        PROVIDER_REPLY: providerReply,
        ...(opts.extraEnv || {}),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, text: out + err, calls: await readFile(log, 'utf8') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('unreachable Docker fails before downloads and explains same-name retry', async () => {
  const r = await launch('daemon');
  expect(r.code).not.toBe(0);
  expect(r.calls.trim()).toBe('info');
  expect(r.text).toContain('Start Docker Desktop');
  expect(r.text).toContain('same installation name');
});

test('missing Compose fails before downloading or changing containers', async () => {
  const r = await launch('compose');
  expect(r.code).not.toBe(0);
  expect(r.calls.trim()).toBe('info\ncompose version');
  expect(r.text).toContain('Compose plugin is unavailable');
});

test('fresh install defaults to SeaweedFS: pulls only postgres (never stock SeaweedFS) and skips Go minio build', async () => {
  const r = await launch('build');
  expect(r.code).not.toBe(0);
  expect(r.calls).toContain('pull postgres');
  expect(r.calls).not.toContain('pull postgres seaweedfs');
  expect(r.calls).toContain('build bootstrap');
  expect(r.calls).not.toContain('build bootstrap minio');
  expect(r.calls).not.toContain(' up ');
  expect(r.calls).not.toContain('pull controller');
  expect(r.text).toContain('existing volumes, credentials and identity are preserved');
});

test('fresh SeaweedFS install builds the NStack SeaweedFS image and fails closed before startup when that build fails', async () => {
  const r = await launch('image');
  expect(r.code).not.toBe(0);
  expect(r.calls).toContain('build bootstrap');
  expect(r.calls).toContain('build -t nstack-seaweedfs:4.55-nstack.1');
  expect(r.calls).not.toContain(' up ');
  expect(r.calls).not.toMatch(/pull [^\n]*seaweedfs/);
  expect(r.text).toContain('SeaweedFS image build failed');
});

test('existing MinIO setup project preserves minio build path without switching to SeaweedFS', async () => {
  const r = await launch('build', { volumes: ['bootstrap', 'storage'] });
  expect(r.code).not.toBe(0);
  expect(r.calls).toContain('pull postgres');
  expect(r.calls).not.toContain('pull postgres seaweedfs');
  expect(r.calls).toContain('build bootstrap minio');
});

test('ambiguous legacy+seaweedfs volumes without storage-provider.json fail closed before build/up', async () => {
  const r = await launch('none', { volumes: ['bootstrap', 'storage', 'storage-seaweedfs'] });
  expect(r.code).not.toBe(0);
  expect(r.text).toContain('Ambiguous installation state');
  expect(r.calls).not.toContain('build ');
  expect(r.calls).not.toContain(' up ');
});

test('corrupted 0-byte storage-provider.json fails closed instead of treating marker as absent', async () => {
  const r = await launch('none', {
    volumes: ['bootstrap', 'storage-seaweedfs'],
    providerFileContent: '',
  });
  expect(r.code).not.toBe(0);
  expect(r.text).toContain('Invalid storage-provider.json');
  expect(r.calls).not.toContain('build ');
});

test('readiness failure exits without printing claim or registering helper', async () => {
  const r = await launch('ready');
  expect(r.code).not.toBe(0);
  const build = r.calls.indexOf('build bootstrap');
  const up = r.calls.indexOf('up -d --no-build --pull never --wait --wait-timeout 240');
  expect(build).toBeGreaterThan(0);
  expect(up).toBeGreaterThan(build);
  expect(r.calls).not.toContain('exec -T tower');
  expect(r.text).not.toContain('Open http://');
  expect(r.text).not.toContain('state":"registered');
  expect(r.text).toContain('Installation did not become ready');
});
