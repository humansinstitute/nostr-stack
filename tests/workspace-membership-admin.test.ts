import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { authorizeFlightDeckPgOperation } from '../src/services/flightdeck-pg-authorization';

// Every request is independently NIP-98 signed by a deterministic, test-only
// principal. The fixture database is disposable and never uses a real identity.
const TEST_DB = 'coworker_v4_test_workspace_membership_admin';
const APP = 'npub1membershipadmincontracttest';
const ownerKey = new Uint8Array(32).fill(101);
const managerKey = new Uint8Array(32).fill(102);
const stableKey = new Uint8Array(32).fill(103);
const retiredKey = new Uint8Array(32).fill(104);
const peerKey = new Uint8Array(32).fill(105);
const ownerNpub = nip19.npubEncode(getPublicKey(ownerKey));
const managerNpub = nip19.npubEncode(getPublicKey(managerKey));
const stableNpub = nip19.npubEncode(getPublicKey(stableKey));
const retiredNpub = nip19.npubEncode(getPublicKey(retiredKey));
const peerNpub = nip19.npubEncode(getPublicKey(peerKey));
let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
const actors = new Map<string, string>();
const actor = (npub: string) => actors.get(npub)!;

async function request(path: string, method: string, key: Uint8Array, body?: unknown) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  const tags = [['u', `http://localhost${path}`], ['method', method]];
  if (encoded !== undefined) tags.push(['payload', createHash('sha256').update(encoded).digest('hex')]);
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, key);
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
      ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: encoded,
  });
  const json = await res.json();
  return { res, json };
}

async function grant(workspaceId: string, actorId: string, permission: string, scopeId?: string, channelId?: string) {
  await sql`INSERT INTO flightdeck_pg_permission_grants
    (workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,resource_channel_id,permission,created_by_actor_id)
    VALUES(${workspaceId},'actor',${actorId},${channelId ? 'channel' : scopeId ? 'scope' : 'workspace'},${channelId ? null : scopeId ?? null},${channelId ?? null},${permission},${actor(ownerNpub)})
    ON CONFLICT DO NOTHING`;
}

async function resources(workspaceId: string, name = 'Restricted') {
  const [scope] = await sql`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind)
    VALUES(${workspaceId},${name},'project') RETURNING id`;
  const [channel] = await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name)
    VALUES(${workspaceId},${scope.id},${name}) RETURNING id`;
  return { scopeId: scope.id as string, channelId: channel.id as string };
}

async function fixture() {
  const [w] = await sql`INSERT INTO flightdeck_pg_workspaces
    (tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
    VALUES('npub1membershipadmintower',${`membership-admin-${randomUUID()}`},${ownerNpub},${APP},'Membership administration',${actor(ownerNpub)}) RETURNING id`;
  const workspaceId = w.id as string;
  for (const [npub, role] of [[ownerNpub, 'owner'], [managerNpub, 'admin'], [stableNpub, 'agent'], [retiredNpub, 'agent'], [peerNpub, 'member']]) {
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role,created_by_actor_id)
      VALUES(${workspaceId},${actor(npub)},${role},${actor(ownerNpub)})`;
    await grant(workspaceId, actor(npub), 'workspace.read');
  }
  for (const permission of ['workspace.invite', 'workspace.manage', 'event_subscription.manage', 'scope.create']) {
    await grant(workspaceId, actor(ownerNpub), permission);
    await grant(workspaceId, actor(managerNpub), permission);
  }
  const ids = await resources(workspaceId);
  const base = `/api/v4/flightdeck-pg/workspaces/${workspaceId}`;
  return { workspaceId, base, ...ids };
}

function memberPath(base: string, npub = stableNpub) { return `${base}/members/${actor(npub)}`; }
async function setManager(base: string, enabled: boolean, npub = stableNpub, key = ownerKey) {
  return request(`${memberPath(base, npub)}/agent-manager`, 'PUT', key, { enabled, confirm_npub: npub });
}
async function permission(workspaceId: string, npub: string, name: string, resource: any) {
  return authorizeFlightDeckPgOperation({ actorNpub: npub, appNpub: APP, workspaceId, permission: name, resource }, sql);
}

beforeAll(async () => {
  const options = {
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres',
  };
  const admin = postgres({ ...options, database: 'postgres' });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally { await admin.end(); }
  sql = postgres({ ...options, database: TEST_DB });
  setDb(sql);
  const migration = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8');
  for (const statement of splitSqlStatements(migration)) await sql.unsafe(statement);
  for (const [npub, kind, label] of [
    [ownerNpub, 'human', 'Owner'], [managerNpub, 'human', 'Existing administrator'],
    [stableNpub, 'agent', 'Rick'], [retiredNpub, 'agent', 'OLD RICK'], [peerNpub, 'human', 'Peer'],
  ]) {
    const [a] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${npub},${kind},${label}) RETURNING id`;
    actors.set(npub, a.id);
  }
  await sql`INSERT INTO user_profiles(user_npub,display_name) VALUES(${retiredNpub},'Rick'),(${stableNpub},'OLD RICK')`;
  app = createApp();
}, 30000);

afterAll(async () => { await closeDb(); });

describe('workspace membership administration authorization and identity', () => {
  test('scope management and ordinary workspace management do not silently inherit channel access or agent-manager role', async () => {
    const f = await fixture();
    await grant(f.workspaceId, actor(stableNpub), 'scope.manage', f.scopeId);
    expect((await permission(f.workspaceId, stableNpub, 'scope.manage', { type: 'scope', scopeId: f.scopeId })).allowed).toBe(true);
    expect((await permission(f.workspaceId, stableNpub, 'channel.read', { type: 'channel', channelId: f.channelId })).allowed).toBe(false);
    expect((await permission(f.workspaceId, managerNpub, 'channel.read', { type: 'channel', channelId: f.channelId })).allowed).toBe(false);
    const inspect = await request(`${memberPath(f.base)}/access`, 'GET', managerKey);
    expect(inspect.res.status).toBe(200);
    expect(inspect.json.agent_manager).toBe(false);
    expect(inspect.json.can_administer).toBe(false);
    const scope = inspect.json.coverage.scopes.find((s: any) => s.id === f.scopeId);
    expect(scope.permissions.find((p: any) => p.permission === 'scope.manage').allowed).toBe(true);
    const channel = inspect.json.coverage.channels.find((c: any) => c.id === f.channelId);
    expect(channel.permissions.find((p: any) => p.permission === 'channel.read').allowed).toBe(false);
  });

  test('inspection keeps canonical identity labels despite conflicting profile names and limits other-member inspection', async () => {
    const f = await fixture();
    const retired = await request(`${memberPath(f.base, retiredNpub)}/access`, 'GET', ownerKey);
    const stable = await request(`${memberPath(f.base)}/access`, 'GET', ownerKey);
    expect(retired.res.status).toBe(200);
    expect(retired.json.actor).toMatchObject({ npub: retiredNpub, display_name: 'OLD RICK' });
    expect(stable.json.actor).toMatchObject({ npub: stableNpub, display_name: 'Rick' });
    expect((await request(`${memberPath(f.base)}/access`, 'GET', peerKey)).res.status).toBe(403);
    expect((await request(`${memberPath(f.base)}/access`, 'GET', stableKey)).res.status).toBe(403);
  });

  test('existing admin/workspace.manage cannot assign role, remove peers, or manufacture an owner through enrollment', async () => {
    const f = await fixture();
    expect((await setManager(f.base, true, stableNpub, managerKey)).res.status).toBe(403);
    expect((await setManager(f.base, true, managerNpub, managerKey)).res.status).toBe(403);
    expect((await request(`${memberPath(f.base, retiredNpub)}/removal-preview`, 'POST', managerKey, {})).res.status).toBe(403);
    for (const path of ['members', 'invites']) {
      const escalation = await request(`${f.base}/${path}`, 'POST', managerKey, { member_npub: managerNpub, role: 'owner', kind: 'human' });
      expect(escalation.res.status).toBe(403);
    }
    const [membership] = await sql`SELECT role FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(managerNpub)}`;
    expect(membership.role).toBe('admin');
    expect((await sql`SELECT 1 FROM flightdeck_pg_workspace_agent_managers WHERE workspace_id=${f.workspaceId}`).length).toBe(0);
  });

  test('role requires exact npub confirmation and a person target; invalid actor ids are validated', async () => {
    const f = await fixture();
    const wrong = await request(`${memberPath(f.base)}/agent-manager`, 'PUT', ownerKey, { enabled: true, confirm_npub: retiredNpub });
    expect(wrong.res.status).toBe(400);
    const appNpub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(106)));
    const [application] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${appNpub},'app') ON CONFLICT(npub) DO UPDATE SET kind='app' RETURNING id`;
    actors.set(appNpub, application.id);
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${f.workspaceId},${application.id},'app')`;
    expect((await setManager(f.base, true, appNpub)).res.status).toBe(400);
    expect((await request(`${f.base}/members/not-a-uuid/access`, 'GET', ownerKey)).res.status).toBe(400);
    const other = await fixture();
    const [outside] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${`npub1outside${randomUUID()}`},'agent') RETURNING id`;
    expect((await request(`${other.base}/members/${outside.id}/access`, 'GET', ownerKey)).res.status).toBe(404);
  });
});

describe('explicit agent-manager coverage', () => {
  test('legacy human-kind stable agent identity can receive the explicit role without rewriting its global kind', async () => {
    const f = await fixture();
    await sql`UPDATE flightdeck_pg_actors SET kind='human' WHERE id=${actor(stableNpub)}`;
    try {
      const assigned = await setManager(f.base, true);
      expect(assigned.res.status).toBe(200);
      expect(assigned.json.actor).toMatchObject({ npub: stableNpub, kind: 'human', display_name: 'Rick' });
      expect((await permission(f.workspaceId, stableNpub, 'channel.write', { type: 'channel', channelId: f.channelId })).allowed).toBe(true);
      const [sameIdentity] = await sql`SELECT npub,kind FROM flightdeck_pg_actors WHERE id=${actor(stableNpub)}`;
      expect(sameIdentity).toMatchObject({ npub: stableNpub, kind: 'human' });
      expect((await setManager(f.base, false)).res.status).toBe(200);
    } finally { await sql`UPDATE flightdeck_pg_actors SET kind='agent' WHERE id=${actor(stableNpub)}`; }
  });

  test('role holder can create scopes and channels without generated-grant collisions', async () => {
    const f = await fixture();
    expect((await setManager(f.base, true)).res.status).toBe(200);
    const scope = await request(`${f.base}/scopes`, 'POST', stableKey, { name: 'Agent-created project', kind: 'project' });
    expect(scope.res.status).toBe(201);
    const scopeId = scope.json.scope.id ?? scope.json.scope.scope_id;
    const channel = await request(`${f.base}/scopes/${scopeId}/channels`, 'POST', stableKey, { name: 'Agent-created channel' });
    expect(channel.res.status).toBe(201);
    const channelId = channel.json.channel.id ?? channel.json.channel.channel_id;
    expect((await permission(f.workspaceId, stableNpub, 'channel.write', { type: 'channel', channelId })).allowed).toBe(true);
  });

  test('owner assigns existing and future scope/channel grants only in selected workspace and can revoke role grants', async () => {
    const f = await fixture();
    const other = await fixture();
    // An existing independent grant must survive role revocation.
    await grant(f.workspaceId, actor(stableNpub), 'doc.read', f.scopeId, f.channelId);
    const enabled = await setManager(f.base, true);
    expect(enabled.res.status).toBe(200);
    expect(enabled.json.agent_manager).toBe(true);
    for (const name of ['channel.read', 'channel.write', 'channel.manage', 'task.update', 'doc.write', 'file.read']) {
      expect((await permission(f.workspaceId, stableNpub, name, { type: 'channel', channelId: f.channelId })).allowed).toBe(true);
    }
    const future = await resources(f.workspaceId, 'Future private scope');
    expect((await permission(f.workspaceId, stableNpub, 'scope.manage', { type: 'scope', scopeId: future.scopeId })).allowed).toBe(true);
    expect((await permission(f.workspaceId, stableNpub, 'channel.write', { type: 'channel', channelId: future.channelId })).allowed).toBe(true);
    expect((await permission(other.workspaceId, stableNpub, 'channel.read', { type: 'channel', channelId: other.channelId })).allowed).toBe(false);
    for (const name of ['daily_note.read', 'daily_note.write', 'org_data.read', 'org_data.write', 'napplet.install']) {
      expect((await permission(f.workspaceId, stableNpub, name, { type: 'workspace' })).allowed).toBe(false);
    }
    // Exercise signed route/list behavior, rather than only the authorization helper.
    const channels = await request(`${f.base}/scopes/${future.scopeId}/channels`, 'GET', stableKey);
    expect(channels.res.status).toBe(200);
    expect(channels.json.channels.some((c: any) => c.id === future.channelId || c.channel_id === future.channelId)).toBe(true);
    const inspection = await request(`${memberPath(f.base)}/access`, 'GET', ownerKey);
    expect(inspection.res.status).toBe(200);
    expect(inspection.json.agent_manager).toBe(true);
    expect(inspection.json.coverage.channels.length).toBe(2);
    expect(inspection.json.coverage.channels.every((c: any) => c.permissions.every((p: any) => p.allowed))).toBe(true);
    const disabled = await setManager(f.base, false);
    expect(disabled.res.status).toBe(200);
    expect(disabled.json.agent_manager).toBe(false);
    expect((await permission(f.workspaceId, stableNpub, 'channel.write', { type: 'channel', channelId: future.channelId })).allowed).toBe(false);
    expect((await permission(f.workspaceId, stableNpub, 'doc.read', { type: 'channel', channelId: f.channelId })).allowed).toBe(true);
    const later = await resources(f.workspaceId, 'After revocation');
    expect((await permission(f.workspaceId, stableNpub, 'channel.read', { type: 'channel', channelId: later.channelId })).allowed).toBe(false);
  });
});

describe('removal confirmation and history preservation', () => {
  test('self and owner members are protected before mutation', async () => {
    const f = await fixture();
    const preview = await request(`${memberPath(f.base, ownerNpub)}/removal-preview`, 'POST', ownerKey, {});
    expect(preview.res.status).toBe(200);
    expect(preview.json.preview.blocked_reason).toBeTruthy();
    const attempt = await request(`${memberPath(f.base, ownerNpub)}/remove`, 'POST', ownerKey, {
      confirmation_token: preview.json.preview.confirmation_token, confirm_npub: ownerNpub,
    });
    expect([400, 403, 409]).toContain(attempt.res.status);
    await sql`UPDATE flightdeck_pg_workspace_memberships SET role='owner' WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(peerNpub)}`;
    const otherOwner = await request(`${memberPath(f.base, peerNpub)}/removal-preview`, 'POST', ownerKey, {});
    expect(otherOwner.res.status).toBe(200);
    expect(otherOwner.json.preview.blocked_reason).toBeTruthy();
    expect((await sql`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${f.workspaceId} AND role='owner'`).length).toBe(2);
  });

  test('confirmation cannot target another identity, another workspace, changed grants, or another incarnation', async () => {
    const f = await fixture();
    const other = await fixture();
    const initial = await request(`${memberPath(f.base, retiredNpub)}/removal-preview`, 'POST', ownerKey, {});
    expect(initial.res.status).toBe(200);
    const token = initial.json.preview.confirmation_token;
    expect(typeof token).toBe('string');
    expect((await request(`${memberPath(f.base, retiredNpub)}/remove`, 'POST', ownerKey, { confirmation_token: token, confirm_npub: stableNpub })).res.status).toBe(400);
    expect((await request(`${memberPath(f.base)}/remove`, 'POST', ownerKey, { confirmation_token: token, confirm_npub: stableNpub })).res.status).toBe(409);
    expect((await request(`${memberPath(other.base, retiredNpub)}/remove`, 'POST', ownerKey, { confirmation_token: token, confirm_npub: retiredNpub })).res.status).toBe(409);
    await grant(f.workspaceId, actor(retiredNpub), 'channel.read', f.scopeId, f.channelId);
    expect((await request(`${memberPath(f.base, retiredNpub)}/remove`, 'POST', ownerKey, { confirmation_token: token, confirm_npub: retiredNpub })).res.status).toBe(409);
    expect((await sql`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(retiredNpub)}`).length).toBe(1);
  });

  test('expired previews cannot authorize removal', async () => {
    const f = await fixture();
    const preview = await request(`${memberPath(f.base, retiredNpub)}/removal-preview`, 'POST', ownerKey, {});
    expect(preview.res.status).toBe(200);
    await sql`UPDATE flightdeck_pg_member_removal_previews SET expires_at=NOW()-INTERVAL '1 second' WHERE token=${preview.json.preview.confirmation_token}`;
    const expired = await request(`${memberPath(f.base, retiredNpub)}/remove`, 'POST', ownerKey, {
      confirmation_token: preview.json.preview.confirmation_token, confirm_npub: retiredNpub,
    });
    expect(expired.res.status).toBe(409);
    expect((await sql`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(retiredNpub)}`).length).toBe(1);
  });

  test('preview expires when inherited group authority changes', async () => {
    const f = await fixture();
    const [group] = await sql`INSERT INTO flightdeck_pg_groups(workspace_id,name,kind) VALUES(${f.workspaceId},'Inherited rights','custom') RETURNING id`;
    await sql`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${f.workspaceId},${group.id},${actor(retiredNpub)})`;
    const preview = await request(`${memberPath(f.base, retiredNpub)}/removal-preview`, 'POST', ownerKey, {});
    expect(preview.res.status).toBe(200);
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,resource_channel_id,permission)
      VALUES(${f.workspaceId},'group',${group.id},'channel',${f.channelId},'channel.read')`;
    const stale = await request(`${memberPath(f.base, retiredNpub)}/remove`, 'POST', ownerKey, {
      confirmation_token: preview.json.preview.confirmation_token, confirm_npub: retiredNpub,
    });
    expect(stale.res.status).toBe(409);
    expect((await sql`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(retiredNpub)}`).length).toBe(1);
  });

  test('an already-open signed event stream closes after confirmed removal', async () => {
    const f = await fixture();
    const path = `${f.base}/events/stream`;
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000),
      tags: [['u', `http://localhost${path}`], ['method', 'GET']], content: '' }, retiredKey);
    const stream = await app.request(path, { headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` } });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    try {
      const preview = await request(`${memberPath(f.base, retiredNpub)}/removal-preview`, 'POST', ownerKey, {});
      expect(preview.res.status).toBe(200);
      const removed = await request(`${memberPath(f.base, retiredNpub)}/remove`, 'POST', ownerKey, {
        confirmation_token: preview.json.preview.confirmation_token, confirm_npub: retiredNpub,
      });
      expect(removed.res.status).toBe(200);
      let text = '';
      while (!text.includes('workspace_access_revoked')) {
        const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Event stream revocation timed out')), 3000))]);
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain('workspace_access_revoked');
      expect((await reader.read()).done).toBe(true);
      expect((await request(`${f.base}/events`, 'GET', retiredKey)).res.status).toBe(403);
    } finally { await reader.cancel().catch(() => {}); }
  }, 10000);

  test('retirement revokes direct/group/role/subscription access but preserves exact authorship, audit and other workspace', async () => {
    const f = await fixture();
    const other = await fixture();
    expect((await setManager(f.base, true, retiredNpub)).res.status).toBe(200);
    await grant(other.workspaceId, actor(retiredNpub), 'channel.read', other.scopeId, other.channelId);
    const [group] = await sql`INSERT INTO flightdeck_pg_groups(workspace_id,name,kind) VALUES(${f.workspaceId},'Retired custom grants','custom') RETURNING id`;
    await sql`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${f.workspaceId},${group.id},${actor(retiredNpub)})`;
    await sql`INSERT INTO flightdeck_pg_event_subscription_agents(workspace_id,manager_actor_id,agent_actor_id,authorized_by_actor_id)
      VALUES(${f.workspaceId},${actor(retiredNpub)},${actor(stableNpub)},${actor(ownerNpub)}),(${f.workspaceId},${actor(ownerNpub)},${actor(retiredNpub)},${actor(ownerNpub)})`;
    const [thread] = await sql`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id)
      VALUES(${f.workspaceId},${f.scopeId},${f.channelId},'Historical thread',${actor(retiredNpub)},${actor(retiredNpub)}) RETURNING id`;
    const [message] = await sql`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id)
      VALUES(${f.workspaceId},${f.scopeId},${f.channelId},${thread.id},'Historical message from OLD RICK',${actor(retiredNpub)},${actor(retiredNpub)}) RETURNING id`;
    const [audit] = await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,actor_id,action,resource_type,resource_id)
      VALUES(${f.workspaceId},${actor(retiredNpub)},'message.create','message',${message.id}) RETURNING id`;
    const preview = await request(`${memberPath(f.base, retiredNpub)}/removal-preview`, 'POST', ownerKey, {});
    expect(preview.res.status).toBe(200);
    expect(preview.json.preview.actor).toMatchObject({ npub: retiredNpub, display_name: 'OLD RICK' });
    expect(preview.json.preview.agent_manager).toBe(true);
    expect(preview.json.preview.groups.some((g: any) => g.id === group.id || g.group_id === group.id)).toBe(true);
    expect(preview.json.preview.direct_grants.length).toBeGreaterThan(0);
    const removed = await request(`${memberPath(f.base, retiredNpub)}/remove`, 'POST', ownerKey, {
      confirmation_token: preview.json.preview.confirmation_token, confirm_npub: retiredNpub,
    });
    expect(removed.res.status).toBe(200);
    expect(removed.json.removed).toBe(true);
    for (const table of ['flightdeck_pg_workspace_memberships', 'flightdeck_pg_group_memberships', 'flightdeck_pg_workspace_agent_managers']) {
      expect((await sql.unsafe(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND actor_id=$2`, [f.workspaceId, actor(retiredNpub)])).length).toBe(0);
    }
    expect((await sql`SELECT 1 FROM flightdeck_pg_permission_grants WHERE workspace_id=${f.workspaceId} AND principal_actor_id=${actor(retiredNpub)} AND revoked_at IS NULL`).length).toBe(0);
    expect((await sql`SELECT 1 FROM flightdeck_pg_event_subscription_agents WHERE workspace_id=${f.workspaceId} AND (manager_actor_id=${actor(retiredNpub)} OR agent_actor_id=${actor(retiredNpub)})`).length).toBe(0);
    expect((await sql`SELECT 1 FROM flightdeck_pg_workspace_member_removals WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(retiredNpub)}`).length).toBe(1);
    const [history] = await sql`SELECT body,created_by_actor_id FROM flightdeck_pg_messages WHERE id=${message.id}`;
    expect(history).toMatchObject({ body: 'Historical message from OLD RICK', created_by_actor_id: actor(retiredNpub) });
    expect((await sql`SELECT 1 FROM flightdeck_pg_threads WHERE id=${thread.id} AND created_by_actor_id=${actor(retiredNpub)}`).length).toBe(1);
    expect((await sql`SELECT 1 FROM flightdeck_pg_audit_events WHERE id=${audit.id} AND actor_id=${actor(retiredNpub)}`).length).toBe(1);
    expect((await sql`SELECT 1 FROM flightdeck_pg_actors WHERE id=${actor(retiredNpub)} AND npub=${retiredNpub}`).length).toBe(1);
    expect((await request(`${f.base}/me`, 'GET', retiredKey)).res.status).toBe(403);
    expect((await request(`${f.base}/channels/${f.channelId}/messages`, 'GET', retiredKey)).res.status).toBe(403);
    expect((await request(`${other.base}/me`, 'GET', retiredKey)).res.status).toBe(200);
    expect((await permission(other.workspaceId, retiredNpub, 'channel.read', { type: 'channel', channelId: other.channelId })).allowed).toBe(true);
    expect((await request(`${f.base}/me`, 'GET', stableKey)).res.status).toBe(200);

    const readd = await request(`${f.base}/members`, 'POST', ownerKey, { member_npub: retiredNpub, role: 'agent', kind: 'agent' });
    expect(readd.res.status).toBe(201);
    expect((await permission(f.workspaceId, retiredNpub, 'channel.read', { type: 'channel', channelId: f.channelId })).allowed).toBe(false);
    expect((await sql`SELECT 1 FROM flightdeck_pg_group_memberships WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(retiredNpub)} AND group_id=${group.id}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM flightdeck_pg_workspace_agent_managers WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(retiredNpub)}`).length).toBe(0);
    expect((await request(`${memberPath(f.base, retiredNpub)}/remove`, 'POST', ownerKey, {
      confirmation_token: preview.json.preview.confirmation_token, confirm_npub: retiredNpub,
    })).res.status).toBe(409);
  });
});

describe('membership administration upgrade safety', () => {
  test('repeated migration preserves explicit/manual authority and retirement history while converting legacy authored membership references', async () => {
    const f = await fixture();
    await grant(f.workspaceId, actor(stableNpub), 'doc.read', f.scopeId, f.channelId);
    expect((await setManager(f.base, true)).res.status).toBe(200);
    // Preserve a real pre-upgrade retirement record alongside active members.
    const peerPreview = await request(`${memberPath(f.base, peerNpub)}/removal-preview`, 'POST', ownerKey, {});
    expect(peerPreview.res.status).toBe(200);
    expect((await request(`${memberPath(f.base, peerNpub)}/remove`, 'POST', ownerKey, {
      confirmation_token: peerPreview.json.preview.confirmation_token, confirm_npub: peerNpub,
    })).res.status).toBe(200);
    const [removalBefore] = await sql`SELECT * FROM flightdeck_pg_workspace_member_removals WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(peerNpub)}`;
    const [roleBefore] = await sql`SELECT * FROM flightdeck_pg_workspace_agent_managers WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(stableNpub)}`;
    const grantsBefore = await sql`SELECT id,permission,workspace_role,revoked_at FROM flightdeck_pg_permission_grants WHERE workspace_id=${f.workspaceId} ORDER BY id`;

    // Model an authored table from the old schema. The old composite FK made
    // removing its author impossible even though the historical row must stay.
    await sql.unsafe(`CREATE TABLE membership_admin_legacy_authorship (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id),
      created_by_actor_id UUID NOT NULL,
      body TEXT NOT NULL,
      CONSTRAINT membership_admin_legacy_author_fkey
        FOREIGN KEY(workspace_id,created_by_actor_id)
        REFERENCES flightdeck_pg_workspace_memberships(workspace_id,actor_id) ON DELETE RESTRICT
    )`);
    const [legacy] = await sql`INSERT INTO membership_admin_legacy_authorship(workspace_id,created_by_actor_id,body)
      VALUES(${f.workspaceId},${actor(retiredNpub)},'Historical author is retained') RETURNING id`;
    const [beforeConstraint] = await sql`SELECT confrelid::regclass::text AS referenced_table FROM pg_constraint
      WHERE conname='membership_admin_legacy_author_fkey'`;
    expect(beforeConstraint.referenced_table).toBe('flightdeck_pg_workspace_memberships');

    const migration = readFileSync(new URL('../src/schema/workspace-membership-admin-v1.sql', import.meta.url), 'utf8');
    await sql.unsafe(migration);
    await sql.unsafe(migration);

    const [afterConstraint] = await sql`SELECT confrelid::regclass::text AS referenced_table FROM pg_constraint
      WHERE conname='membership_admin_legacy_author_fkey'`;
    expect(afterConstraint.referenced_table).toBe('flightdeck_pg_actors');
    const [removalAfter] = await sql`SELECT * FROM flightdeck_pg_workspace_member_removals WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(peerNpub)}`;
    const [roleAfter] = await sql`SELECT * FROM flightdeck_pg_workspace_agent_managers WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(stableNpub)}`;
    expect(removalAfter).toEqual(removalBefore);
    expect(roleAfter).toEqual(roleBefore);
    expect(Array.from(await sql`SELECT id,permission,workspace_role,revoked_at FROM flightdeck_pg_permission_grants WHERE workspace_id=${f.workspaceId} ORDER BY id`)).toEqual(Array.from(grantsBefore));
    const roles = await sql`SELECT actor_id FROM flightdeck_pg_workspace_agent_managers WHERE workspace_id=${f.workspaceId}`;
    expect(roles.map(r => r.actor_id)).toEqual([actor(stableNpub)]);
    expect((await sql`SELECT 1 FROM flightdeck_pg_workspace_agent_managers WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(managerNpub)}`).length).toBe(0);

    const future = await resources(f.workspaceId, 'Created after repeated upgrade');
    expect((await permission(f.workspaceId, stableNpub, 'channel.write', { type: 'channel', channelId: future.channelId })).allowed).toBe(true);
    expect((await permission(f.workspaceId, managerNpub, 'channel.read', { type: 'channel', channelId: future.channelId })).allowed).toBe(false);
    const retiredPreview = await request(`${memberPath(f.base, retiredNpub)}/removal-preview`, 'POST', ownerKey, {});
    expect(retiredPreview.res.status).toBe(200);
    expect((await request(`${memberPath(f.base, retiredNpub)}/remove`, 'POST', ownerKey, {
      confirmation_token: retiredPreview.json.preview.confirmation_token, confirm_npub: retiredNpub,
    })).res.status).toBe(200);
    const [retained] = await sql`SELECT created_by_actor_id,body FROM membership_admin_legacy_authorship WHERE id=${legacy.id}`;
    expect(retained).toMatchObject({ created_by_actor_id: actor(retiredNpub), body: 'Historical author is retained' });
    expect((await sql`SELECT 1 FROM flightdeck_pg_actors WHERE id=${actor(retiredNpub)} AND npub=${retiredNpub}`).length).toBe(1);
    expect((await sql`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${f.workspaceId} AND actor_id=${actor(retiredNpub)}`).length).toBe(0);
  });
});
