import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';

// WApp publishing repair for notification-only identities: one installation's grant read and publisher rotation, only
// through an explicit owner wapp.manage delegation judged on hydrated installation facts. Disposable Postgres only:
//   RECORD_TEST_PORT=<free port> bun test tests/agent-wapp-delegation-ceiling.test.ts
const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('WApp publishing repair under the notification-only ceiling', () => {
  const database = `agent_wapp_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  // 0 human owner H, 1 classified bot R, 2 unclassified bot U, 3+ publisher keys
  const secrets = [901, 902, 903, 904, 905, 906, 907].map((n) => new Uint8Array(32).fill(n));
  const npubs = secrets.map((s) => nip19.npubEncode(getPublicKey(s)));
  const [H, R, U] = [0, 1, 2];
  let db: ReturnType<typeof postgres>;
  let app: ReturnType<typeof createApp>;
  const actors: string[] = [];
  let w: string, scope: string, ch1: string, ch2: string;

  const sha = (v: string) => createHash('sha256').update(v).digest('hex');
  async function call(actor: number, method: 'GET' | 'POST' | 'PUT', rest: string, body?: unknown) {
    const path = `/api/v4/flightdeck-pg/workspaces/${w}${rest}`;
    const data = body === undefined ? undefined : JSON.stringify(body);
    const tags = [['u', `http://localhost${path}`], ['method', method], ...(data ? [['payload', sha(data)]] : [])];
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags }, secrets[actor]!);
    const res = await app.request(path, { method, body: data, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'Content-Type': 'application/json' } });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: res.status, body: json, text };
  }
  async function installation(id: string, appId: string, publisher: number, channel: string, autopilotOrigin: string | null = null) {
    const [i] = await db`INSERT INTO flightdeck_pg_wapp_installations (wapp_installation_id, app_id, publisher_npub, owner_npub, display_name, autopilot_origin)
      VALUES (${id}, ${appId}, ${npubs[publisher]!}, ${npubs[H]!}, ${`SENTINEL-DISPLAY-${id}`}, ${autopilotOrigin}) RETURNING id`;
    const [g] = await db`INSERT INTO flightdeck_pg_wapp_publishing_grants (workspace_id, installation_id, approved_by_npub, registered_open_origins)
      VALUES (${w}, ${i!.id}, ${npubs[H]!}, ${['https://wapp.example.test']}) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_wapp_publishing_destinations (grant_id, workspace_id, scope_id, channel_id) VALUES (${g!.id}, ${w}, ${scope}, ${channel})`;
  }
  async function delegate(filters: Record<string, unknown>, opts: { revoked?: boolean; validFrom?: string; expiresAt?: string } = {}) {
    await db`INSERT INTO flightdeck_pg_wapp_delegations (workspace_id, owner_actor_id, delegate_actor_id, filters, valid_from, expires_at, revoked_at, request_hash, created_by_actor_id)
      VALUES (${w}, ${actors[H]!}, ${actors[R]!}, ${db.json(filters as any)}, ${opts.validFrom ?? new Date(Date.now() - 60_000).toISOString()},
        ${opts.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString()}, ${opts.revoked ? new Date().toISOString() : null}, ${sha(JSON.stringify(filters) + Math.random())}, ${actors[H]!})`;
  }
  const refused = (res: { status: number; body: any }) => res.status === 403 && res.body.code === 'agent_notification_upgrade_required';

  beforeAll(async () => {
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database, max: 10 });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    for (const [i, kind] of ['human', 'agent', 'agent'].entries()) actors.push((await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${npubs[i]!},${kind},${`Actor${i}`}) RETURNING id`)[0]!.id);
    w = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-wa','service-wa',${npubs[H]!},'app','W') RETURNING id`)[0]!.id;
    for (const [i, role] of [[H, 'owner'], [R, 'member'], [U, 'member']] as const) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w},${actors[i]!},${role})`;
    scope = (await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Main','project') RETURNING id`)[0]!.id;
    ch1 = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${scope},'One') RETURNING id`)[0]!.id;
    ch2 = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${scope},'Two') RETURNING id`)[0]!.id;
    // Both bots hold workspace.manage: that alone must never admit the classified one.
    for (const i of [H, R, U]) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${w},'actor',${actors[i]!},'workspace','workspace.manage')`;
    await installation('inst-one', 'app.one', 3, ch1);
    await installation('inst-two', 'app.two', 4, ch2, 'https://autopilot.example.test');
    await db`INSERT INTO flightdeck_pg_agent_access_profiles (workspace_id, actor_id, profile) VALUES (${w}, ${actors[R]!}, 'notification_only')`;
    setDb(db); clearWsKeyCacheForTests(); app = createApp();
  });
  afterAll(async () => {
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end();
  });

  test('workspace.manage alone never admits a classified bot; humans and unclassified managers are unchanged', async () => {
    expect(refused(await call(R, 'GET', '/wapp-publishing-grants/inst-one'))).toBe(true);
    expect((await call(H, 'GET', '/wapp-publishing-grants/inst-one')).status).toBe(200);
    expect((await call(U, 'GET', '/wapp-publishing-grants/inst-one')).status).toBe(200);
  });

  test('an explicit wildcard owner delegation admits exactly the grant read and rotation; nothing else', async () => {
    await delegate({ capabilities: ['activity.publish'] }); // other filters empty = explicit wildcard
    const read = await call(R, 'GET', '/wapp-publishing-grants/inst-one');
    expect(read.status).toBe(200);
    expect((await call(R, 'GET', '/wapp-publishing-grants/inst-two')).status).toBe(200);
    // Not the list, not edits.
    expect(refused(await call(R, 'GET', '/wapp-publishing-grants'))).toBe(true);
    expect(refused(await call(R, 'POST', '/wapp-publishing-grants/inst-one/disable', { disabled: true }))).toBe(true);
    expect(refused(await call(R, 'POST', '/wapp-publishing-grants/inst-one/revoke', {}))).toBe(true);
    expect(refused(await call(R, 'PUT', '/wapp-publishing-grants/inst-one', { capabilities: ['activity.publish'] }))).toBe(true);
    // Rotation keeps every existing check: a stale current key is refused by the route, a correct one rotates.
    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    const stale = await call(R, 'POST', '/wapp-publishing-grants/inst-one/rotate', { current_publisher_npub: npubs[5], new_publisher_npub: npubs[6], nonce: 'n-1', expires_at: expires });
    expect([stale.status, stale.body.code]).toEqual([409, 'stale_publisher_key']);
    const rotated = await call(R, 'POST', '/wapp-publishing-grants/inst-one/rotate', { current_publisher_npub: npubs[3], new_publisher_npub: npubs[5], nonce: 'n-2', expires_at: expires });
    expect(rotated.status).toBe(200);
    expect((await db`SELECT publisher_npub FROM flightdeck_pg_wapp_installations WHERE wapp_installation_id = 'inst-one'`)[0]!.publisher_npub).toBe(npubs[5]);
  });

  test('filters are judged on hydrated installation facts; unknown or unmatched facts and invalid delegations refuse identically', async () => {
    const outcome = async (id: string) => (await call(R, 'GET', `/wapp-publishing-grants/${id}`)).status;
    await delegate({ installation_ids: ['inst-one'] });
    expect([await outcome('inst-one'), await outcome('inst-two')]).toEqual([200, 403]);
    await delegate({ app_ids: ['app.two'] });
    expect([await outcome('inst-one'), await outcome('inst-two')]).toEqual([403, 200]);
    await delegate({ channel_ids: [ch1] });
    expect([await outcome('inst-one'), await outcome('inst-two')]).toEqual([200, 403]);
    await delegate({ scope_ids: [scope] });
    expect([await outcome('inst-one'), await outcome('inst-two')]).toEqual([200, 200]);
    await delegate({ open_origins: ['https://other.example.test'] });
    expect([await outcome('inst-one'), await outcome('inst-two')]).toEqual([403, 403]);
    // inst-one has no Autopilot origin on record: a non-empty autopilot filter fails closed for it.
    await delegate({ autopilot_origins: ['https://autopilot.example.test'] });
    expect([await outcome('inst-one'), await outcome('inst-two')]).toEqual([403, 200]);
    // Latest delegation revoked, expired or not yet valid: refused.
    await delegate({}, { revoked: true });
    expect(await outcome('inst-one')).toBe(403);
    await delegate({}, { validFrom: new Date(Date.now() + 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 7_200_000).toISOString() });
    expect(await outcome('inst-one')).toBe(403);
    // No installation-existence oracle: an unknown installation answers exactly like a filtered one.
    await delegate({ installation_ids: ['inst-one'] });
    const filtered = await call(R, 'GET', '/wapp-publishing-grants/inst-two');
    const unknown = await call(R, 'GET', '/wapp-publishing-grants/no-such-installation');
    expect(refused(filtered) && refused(unknown)).toBe(true);
    const strip = ({ identity: _i, ...rest }: any) => JSON.stringify(rest);
    expect(strip(filtered.body)).toBe(strip(unknown.body));
    expect(filtered.text).not.toContain('SENTINEL-DISPLAY');
  });
});
