import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const compose = readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8');
const runtimeConfig = readFileSync(join(root, 'src/config.ts'), 'utf8');

function composeService(name: string, nextName: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  const end = compose.indexOf(`\n  ${nextName}:\n`, start + 1);
  return compose.slice(start, end);
}

describe('production deployment security contract', () => {
  test('requires database and object-storage credentials', () => {
    for (const name of [
      'DB_USER',
      'DB_PASSWORD',
      'GRAPH_DB_ADMIN_USER',
      'GRAPH_DB_ADMIN_PASSWORD',
      'GRAPH_DB_APP_USER',
      'GRAPH_DB_APP_PASSWORD',
      'STORAGE_S3_ACCESS_KEY',
      'STORAGE_S3_SECRET_KEY',
    ]) {
      expect(compose).toContain(`\${${name}:?set ${name}}`);
    }

    expect(runtimeConfig).toContain("user: requiredEnv('DB_USER')");
    expect(runtimeConfig).toContain("password: requiredEnv('DB_PASSWORD')");
    // Graph credentials are mandatory whenever the graph is enabled and never fall back to a built-in value when it is not
    // (progressive setup lets a graph-less installation start). The production compose file above still requires all of them.
    const graphEnabled = "/^(1|true|yes)$/i.test(process.env.GRAPH_ENABLED || '')";
    for (const [field, name] of [['adminUser', 'GRAPH_DB_ADMIN_USER'], ['adminPassword', 'GRAPH_DB_ADMIN_PASSWORD'], ['appUser', 'GRAPH_DB_APP_USER'], ['appPassword', 'GRAPH_DB_APP_PASSWORD']]) {
      expect(runtimeConfig).toContain(`${field}: (${graphEnabled} ? requiredEnv('${name}') : String(process.env.${name} || ''))`);
    }
  });

  test('binds host-published Tower, MinIO, and SeaweedFS ports to loopback by default and pins storage images', () => {
    expect(compose).toContain('${TOWER_HOST_BIND_ADDRESS:-127.0.0.1}:${TOWER_HOST_PORT:-3100}:3100');
    expect(compose).toContain('${MINIO_HOST_BIND_ADDRESS:-127.0.0.1}:${MINIO_API_HOST_PORT:-9000}:9000');
    expect(compose).toContain('${MINIO_HOST_BIND_ADDRESS:-127.0.0.1}:${MINIO_CONSOLE_HOST_PORT:-9001}:9001');
    expect(compose).toContain('${SEAWEEDFS_HOST_BIND_ADDRESS:-127.0.0.1}:${SEAWEEDFS_API_HOST_PORT:-8333}:8333');
    expect(compose).toContain('STORAGE_S3_DEFAULT_MINIO_ENDPOINT: http://minio:9000');
    expect(compose).toContain('STORAGE_S3_ENDPOINT: ${STORAGE_S3_ENDPOINT:-}');
    // SeaweedFS is the NStack build, never pulled; the recipe pins upstream and toolchain by digest.
    expect(compose).toContain('image: ${SEAWEEDFS_IMAGE:-nstack-seaweedfs:4.55-nstack.1}');
    expect(compose).not.toContain('chrislusf/seaweedfs');
    const recipe = readFileSync(join(import.meta.dir, '../deploy/seaweedfs/Dockerfile'), 'utf8');
    expect(recipe).toContain('chrislusf/seaweedfs@sha256:7ca46aeae2f223b37e5d91593c17ab37738eec6df6ab69b48a0487f7643342b9');
    expect(recipe).toMatch(/golang@sha256:[0-9a-f]{64}/);
    expect(recipe).toMatch(/SEAWEEDFS_SOURCE_SHA256=[0-9a-f]{64}/);
    expect(compose).not.toContain('minio/minio:latest');
    expect(compose).not.toContain('minio/mc:latest');
    expect(compose).toContain('storage-internal:');
    expect(compose).toContain('tower-seaweedfs-data:');
  });

  test('scrubs SeaweedFS admin and gRPC JWT secrets from Tower runtime container', () => {
    const towerSection = compose.slice(compose.indexOf('\n  tower:\n'));
    for (const secretVar of [
      'SEAWEEDFS_ADMIN_ACCESS_KEY: ""',
      'SEAWEEDFS_ADMIN_SECRET_KEY: ""',
      'SEAWEEDFS_ACCESS_KEY: ""',
      'SEAWEEDFS_SECRET_KEY: ""',
      'SEAWEEDFS_JWT_SECRET: ""',
      'SEAWEEDFS_JWT_READ_SECRET: ""',
      'SEAWEEDFS_JWT_FILER_SECRET: ""',
      'SEAWEEDFS_JWT_FILER_READ_SECRET: ""',
      'SEAWEEDFS_JWT_FILER_SUBSCRIBE_SECRET: ""',
    ]) {
      expect(towerSection).toContain(secretVar);
    }
  });

  test('does not ship Forgejo, OIDC secrets or a Git proxy in the production runtime',()=>{
    for(const removed of ['\n  forgejo:\n','\n  git-gateway:\n','GIT_OIDC_','tower-git-secrets','FORGEJO__']) expect(compose).not.toContain(removed);
    expect(runtimeConfig).not.toContain('oidcClientSecret');
  });
});
