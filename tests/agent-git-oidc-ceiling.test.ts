import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';

// Forgejo OIDC sign-in completion for notification-only identities: the exact completion step only, still fully proven.
// Disposable Postgres only:
//   RECORD_TEST_PORT=<free port> bun test tests/agent-git-oidc-ceiling.test.ts
const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('git OIDC completion under the notification-only ceiling', () => {
  const database = `agent_oidc_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const origin = 'https://tower.example.test';
  const issuer = `${origin}/api/v4/git/oidc`;
  const redirectUri = 'https://forgejo.example.test/user/oauth2/tower/callback';
  // 0 human H (allowed), 1 classified bot P (allowed), 2 classified bot X (not allowed)
  const secrets = [801, 802, 803].map((n) => new Uint8Array(32).fill(n));
  const npubs = secrets.map((s) => nip19.npubEncode(getPublicKey(s)));
  const [H, P, X] = [0, 1, 2];
  let db: ReturnType<typeof postgres>;
  let app: any;
  let runtime: any;
  let previous: any;

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signingKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    runtime = (await import('../src/config')).config.git;
    previous = { ...runtime };
    Object.assign(runtime, { oidcIssuer: issuer, oidcClientId: 'forgejo', oidcClientSecret: 's'.repeat(40), oidcRedirectUri: redirectUri, oidcSigningKey: signingKey, oidcAllowedNpubs: [npubs[H], npubs[P]] });
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database, max: 5 });
    const { splitSqlStatements } = await import('../src/schema/sql-statements');
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await (await import('../src/schema/ensure-runtime-schema')).ensureRuntimeSchema(db);
    const actors: string[] = [];
    for (const [i, kind] of ['human', 'agent', 'agent'].entries()) actors.push((await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${npubs[i]!},${kind},${`Actor${i}`}) RETURNING id`)[0]!.id);
    const [w] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-oi','service-oi',${npubs[H]!},'app','W1') RETURNING id`;
    for (const i of [P, X]) {
      await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w!.id},${actors[i]!},'member')`;
      await db`INSERT INTO flightdeck_pg_agent_access_profiles (workspace_id, actor_id, profile) VALUES (${w!.id}, ${actors[i]!}, 'notification_only')`;
    }
    (await import('../src/db')).setDb(db);
    app = (await import('../src/server')).createApp();
  });
  afterAll(async () => {
    if (runtime) Object.assign(runtime, previous);
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end();
  });

  async function challenge() {
    const url = new URL(`${issuer}/authorize`);
    url.search = new URLSearchParams({ client_id: 'forgejo', redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile', state: 'opaque-state' }).toString();
    const res = await app.request(url, { headers: { accept: 'application/json' } });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ request_id: string; expires_at: number }>;
  }
  async function complete(actor: number, tamper: 'none' | 'nonce' | 'aud' = 'none') {
    const { request_id, expires_at } = await challenge();
    const body = JSON.stringify({ request_id });
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [
      ['u', `${issuer}/authorize/complete`], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')],
      ['nonce', tamper === 'nonce' ? 'x'.repeat(43) : request_id], ['aud', tamper === 'aud' ? 'other-client' : 'forgejo'], ['expiration', String(expires_at)],
    ] }, secrets[actor]!);
    const res = await app.request(`${issuer}/authorize/complete`, { method: 'POST', body, headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'content-type': 'application/json' } });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  }

  test('a classified, allowed bot completes Forgejo sign-in; the route still verifies the full proof and allow list', async () => {
    const ok = await complete(P);
    expect(ok.status).toBe(200);
    expect(new URL(ok.body.redirect_to).searchParams.get('state')).toBe('opaque-state');
    // Invalid proofs reach the route's own checks (not admitted by the ceiling as a bypass, not refused by it either).
    for (const tamper of ['nonce', 'aud'] as const) {
      const bad = await complete(P, tamper);
      expect([tamper, bad.status, bad.body.error]).toEqual([tamper, 401, 'access_denied']);
    }
    // A classified identity that Forgejo does not allow is refused by the route.
    const denied = await complete(X);
    expect([denied.status, denied.body.error]).toEqual([403, 'access_denied']);
    // Humans are unchanged.
    expect((await complete(H)).status).toBe(200);
  });

  test('no other git route is admitted for a classified signer', async () => {
    for (const [method, path] of [['GET', '/userinfo'], ['POST', '/token'], ['POST', '/authorize/complete/'], ['GET', '/authorize/complete']] as const) {
      const url = `${issuer}${path}`;
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', url], ['method', method]] }, secrets[P]!);
      const res = await app.request(url, { method, headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` } });
      const body = await res.json().catch(() => ({})) as any;
      expect([method, path, res.status, body.code]).toEqual([method, path, 403, 'agent_notification_upgrade_required']);
    }
  });
});
