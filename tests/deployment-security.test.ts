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
    expect(runtimeConfig).toContain("adminPassword: requiredEnv('GRAPH_DB_ADMIN_PASSWORD')");
    expect(runtimeConfig).toContain("appPassword: requiredEnv('GRAPH_DB_APP_PASSWORD')");
  });

  test('binds host-published Tower and MinIO ports to loopback by default', () => {
    expect(compose).toContain('${TOWER_HOST_BIND_ADDRESS:-127.0.0.1}:${TOWER_HOST_PORT:-3100}:3100');
    expect(compose).toContain('${MINIO_HOST_BIND_ADDRESS:-127.0.0.1}:${MINIO_API_HOST_PORT:-9000}:9000');
    expect(compose).toContain('${MINIO_HOST_BIND_ADDRESS:-127.0.0.1}:${MINIO_CONSOLE_HOST_PORT:-9001}:9001');
    expect(compose).toContain('STORAGE_S3_ENDPOINT: ${STORAGE_S3_ENDPOINT:-http://minio:9000}');
  });

  test('does not ship Forgejo, OIDC secrets or a Git proxy in the production runtime',()=>{
    for(const removed of ['\n  forgejo:\n','\n  git-gateway:\n','GIT_OIDC_','tower-git-secrets','FORGEJO__']) expect(compose).not.toContain(removed);
    expect(runtimeConfig).not.toContain('oidcClientSecret');
  });
});
