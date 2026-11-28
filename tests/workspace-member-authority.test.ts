import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb, closeDb } from '../src/db';
import { createApp } from '../src/server';
import { buildOpenApiDocument } from '../src/openapi';
import { splitSqlStatements } from '../src/schema/sql-statements';
import {
  authorizeFlightDeckPgOperation,
  listFlightDeckPgActorsWithWorkspacePermission,
} from '../src/services/flightdeck-pg-authorization';

// Runs only against an explicitly supplied disposable loopback Postgres; never ambient DB_* config.
const port = Number(process.env.MEMBER_AUTHORITY_TEST_PORT);
const database = `tower_test_member_authority_${process.pid}_${Date.now()}`;
const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
let sql: ReturnType<typeof postgres>, app: ReturnType<typeof createApp>;

function assertFixtureDatabase(name: string) {
  if (!/^tower_test_member_authority_\d+_\d+$/.test(name)) throw new Error(`refusing non-fixture database ${name}`);
  return name;
}

describe.skipIf(!port || port === 5432)('workspace member authority on disposable PostgreSQL', () => {
  beforeAll(async () => {
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${assertFixtureDatabase(database)}`); await admin.end();
    sql = postgres({ ...connection, database }); setDb(sql);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await sql.unsafe(statement);
    for (const name of ['notifications-v1.sql', 'agent-notifications-v1.sql', 'workspace-membership-admin-v1.sql']) await sql.unsafe(readFileSync(new URL(`../src/schema/${name}`, import.meta.url), 'utf8'));
    app = createApp();
  }, 30000);
  afterAll(async () => { await closeDb(); const admin = postgres({ ...connection, database: 'postgres' }); await admin.unsafe(`DROP DATABASE IF EXISTS ${assertFixtureDatabase(database)}`); await admin.end(); });

  type Identity = { secret: Uint8Array; npub: string; id: string };

  async function identity(kind = 'human', displayName: string | null = null): Promise<Identity> {
    const secret = randomBytes(32), npub = nip19.npubEncode(getPublicKey(secret));
    const [actor] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${npub},${kind},${displayName}) RETURNING id`;
    return { secret, npub, id: actor.id };
  }

  async function workspaceFixture() {
    const owner = await identity('human', 'Owner');
    const appNpub = `test-app-${randomUUID()}`;
    const [workspace] = await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id) VALUES('test',${randomUUID()},${owner.npub},${appNpub},'Authority',${owner.id}) RETURNING *`;
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace.id},${owner.id},'owner')`;
    for (const permission of ['workspace.read', 'workspace.manage', 'workspace.invite']) await grantActor(workspace.id, owner.id, permission);
    async function join(role: string, kind = 'human', displayName: string | null = null) {
      const who = await identity(kind, displayName);
      await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace.id},${who.id},${role})`;
      await grantActor(workspace.id, who.id, 'workspace.read');
      return who;
    }
    async function directory(who: { secret: Uint8Array }, w = workspace.id, query = '') {
      const path = `/api/v4/flightdeck-pg/workspaces/${w}/members${query}`;
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', `http://localhost${path}`], ['method', 'GET']] }, who.secret);
      const r = await app.request(path, { method: 'GET', headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'x-flightdeck-pg-app-npub': appNpub } });
      return { status: r.status, body: await r.json() as any };
    }
    const engine = async (npub: string) => (await authorizeFlightDeckPgOperation({ actorNpub: npub, appNpub, workspaceId: workspace.id, permission: 'workspace.manage', resource: { type: 'workspace' } }, sql)).allowed;
    return { owner, workspace, appNpub, join, directory, engine };
  }

  async function grantActor(workspaceId: string, actorId: string, permission: string) {
    const [grant] = await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${workspaceId},'actor',${actorId},'workspace',${permission}) RETURNING id`;
    return grant.id as string;
  }

  async function group(workspaceId: string, name: string) {
    const [row] = await sql`INSERT INTO flightdeck_pg_groups(workspace_id,name,kind) VALUES(${workspaceId},${name},'custom') RETURNING id`;
    return row.id as string;
  }

  function authorityOf(body: any, npub: string) {
    return body.members.find((entry: any) => entry.actor.npub === npub)?.authority;
  }

  test('workspace.read viewer sees actors and engine-derived authority but no protected fields', async () => {
    const f = await workspaceFixture();
    const viewer = await f.join('member');
    const directAgent = await f.join('agent', 'agent', 'Ops Agent');
    await grantActor(f.workspace.id, directAgent.id, 'workspace.manage');
    const nestedAgent = await f.join('agent', 'agent');
    const parent = await group(f.workspace.id, 'Managers'), child = await group(f.workspace.id, 'Delegates');
    await sql`INSERT INTO flightdeck_pg_group_edges(workspace_id,parent_group_id,child_group_id) VALUES(${f.workspace.id},${parent},${child})`;
    await sql`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${f.workspace.id},${child},${nestedAgent.id})`;
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,permission) VALUES(${f.workspace.id},'group',${parent},'workspace','workspace.manage')`;
    // Labels that look privileged confer nothing without a grant.
    const labelled = await f.join('member', 'human', 'Workspace Owner Admin');
    const inviteOnly = await f.join('member');
    await grantActor(f.workspace.id, inviteOnly.id, 'workspace.invite');

    const result = await f.directory(viewer);
    expect(result.status).toBe(200);
    for (const entry of result.body.members) {
      expect(Object.keys(entry).sort()).toEqual(['actor', 'authority']);
      expect(Object.keys(entry.authority)).toEqual(['can_manage_workspace']);
      expect(Object.keys(entry.actor).sort()).toEqual(['actor_id', 'display_name', 'id', 'kind', 'npub']);
    }
    expect(JSON.stringify(result.body)).not.toContain(parent);
    expect(JSON.stringify(result.body)).not.toContain('"role"');
    expect(authorityOf(result.body, f.owner.npub)).toEqual({ can_manage_workspace: true });
    expect(authorityOf(result.body, directAgent.npub)).toEqual({ can_manage_workspace: true });
    expect(authorityOf(result.body, nestedAgent.npub)).toEqual({ can_manage_workspace: true });
    expect(authorityOf(result.body, viewer.npub)).toEqual({ can_manage_workspace: false });
    expect(authorityOf(result.body, labelled.npub)).toEqual({ can_manage_workspace: false });
    expect(authorityOf(result.body, inviteOnly.npub)).toEqual({ can_manage_workspace: false });
    // Batched projection matches the per-actor authorization engine for every listed member.
    for (const entry of result.body.members) expect(entry.authority.can_manage_workspace).toBe(await f.engine(entry.actor.npub));
    // Query parameters cannot spoof authority.
    const spoof = await f.directory(viewer, f.workspace.id, `?authority=true&can_manage_workspace=true&actor_id=${viewer.id}`);
    expect(spoof.status).toBe(200);
    expect(authorityOf(spoof.body, viewer.npub)).toEqual({ can_manage_workspace: false });
  });

  test('owner/admin role labels follow actual grants, not role inference', async () => {
    const f = await workspaceFixture();
    const admin = await f.join('admin');
    const list = await f.directory(f.owner);
    // An admin role label with no workspace.manage grant has no authority under the engine.
    expect(await f.engine(admin.npub)).toBe(false);
    expect(authorityOf(list.body, admin.npub)).toEqual({ can_manage_workspace: false });
    // Granting the system Admins group workspace.manage makes it true through group membership.
    const [admins] = await sql`SELECT id FROM flightdeck_pg_groups WHERE workspace_id=${f.workspace.id} AND name='Admins'`;
    await sql`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${f.workspace.id},${admins.id},${admin.id})`;
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,permission) VALUES(${f.workspace.id},'group',${admins.id},'workspace','workspace.manage')`;
    expect(authorityOf((await f.directory(f.owner)).body, admin.npub)).toEqual({ can_manage_workspace: true });
    await sql`DELETE FROM flightdeck_pg_group_memberships WHERE workspace_id=${f.workspace.id} AND group_id=${admins.id} AND actor_id=${admin.id}`;
    expect(authorityOf((await f.directory(f.owner)).body, admin.npub)).toEqual({ can_manage_workspace: false });
    // Revoking the owner's own grant removes current authority despite the owner role.
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NOW() WHERE workspace_id=${f.workspace.id} AND principal_actor_id=${f.owner.id} AND permission='workspace.manage'`;
    const viewer = await f.join('member');
    const after = await f.directory(viewer);
    expect(authorityOf(after.body, f.owner.npub)).toEqual({ can_manage_workspace: false });
    expect(await f.engine(f.owner.npub)).toBe(false);
  });

  test('revocation, removed edges and removed membership fail closed', async () => {
    const f = await workspaceFixture();
    const viewer = await f.join('member');
    const direct = await f.join('agent', 'agent');
    const directGrant = await grantActor(f.workspace.id, direct.id, 'workspace.manage');
    const nested = await f.join('agent', 'agent');
    const parent = await group(f.workspace.id, 'Managers'), child = await group(f.workspace.id, 'Delegates');
    await sql`INSERT INTO flightdeck_pg_group_edges(workspace_id,parent_group_id,child_group_id) VALUES(${f.workspace.id},${parent},${child})`;
    await sql`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${f.workspace.id},${child},${nested.id})`;
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,permission) VALUES(${f.workspace.id},'group',${parent},'workspace','workspace.manage')`;
    const removed = await f.join('agent', 'agent');
    await grantActor(f.workspace.id, removed.id, 'workspace.manage');
    expect((await f.directory(viewer)).body.members.filter((m: any) => m.authority.can_manage_workspace).length).toBe(4);

    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NOW() WHERE id=${directGrant}`;
    await sql`DELETE FROM flightdeck_pg_group_edges WHERE workspace_id=${f.workspace.id} AND parent_group_id=${parent} AND child_group_id=${child}`;
    await sql`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${f.workspace.id} AND actor_id=${removed.id}`;
    const result = await f.directory(viewer);
    expect(authorityOf(result.body, direct.npub)).toEqual({ can_manage_workspace: false });
    expect(authorityOf(result.body, nested.npub)).toEqual({ can_manage_workspace: false });
    expect(result.body.members.some((m: any) => m.actor.npub === removed.npub)).toBe(false);
    // The helper itself never reports a removed member or revoked/unlinked authority when asked by id.
    const held = await listFlightDeckPgActorsWithWorkspacePermission({ workspaceId: f.workspace.id, appNpub: f.appNpub, permission: 'workspace.manage', actorIds: [removed.id, direct.id, nested.id] }, sql);
    expect(held.size).toBe(0);
    for (const entry of result.body.members) expect(entry.authority.can_manage_workspace).toBe(await f.engine(entry.actor.npub));
  });

  test('outsiders, foreign members, wrong workspace and wrong app cannot enumerate authority', async () => {
    const f = await workspaceFixture();
    const other = await workspaceFixture();
    const foreignManager = await other.join('agent', 'agent');
    await grantActor(other.workspace.id, foreignManager.id, 'workspace.manage');
    const outsider = await identity();

    expect((await f.directory(outsider)).status).toBe(403);
    const foreign = await f.directory(foreignManager);
    expect(foreign.status).toBe(403);
    expect(JSON.stringify(foreign.body)).not.toContain('can_manage_workspace');
    expect((await f.directory(f.owner, randomUUID())).status).toBe(404);
    // A member without workspace.read is denied the directory.
    const noRead = await identity();
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${f.workspace.id},${noRead.id},'member')`;
    await grantActor(f.workspace.id, noRead.id, 'workspace.invite');
    const denied = await f.directory(noRead);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('can_manage_workspace');

    // Foreign workspace authority never leaks across the workspace boundary.
    const list = await f.directory(f.owner);
    expect(list.body.members.some((m: any) => m.actor.npub === foreignManager.npub)).toBe(false);
    const crossWorkspace = await listFlightDeckPgActorsWithWorkspacePermission({ workspaceId: f.workspace.id, appNpub: f.appNpub, permission: 'workspace.manage', actorIds: [foreignManager.id, other.owner.id] }, sql);
    expect(crossWorkspace.size).toBe(0);
    const wrongApp = await listFlightDeckPgActorsWithWorkspacePermission({ workspaceId: f.workspace.id, appNpub: other.appNpub, permission: 'workspace.manage', actorIds: [f.owner.id] }, sql);
    expect(wrongApp.size).toBe(0);
    await expect(listFlightDeckPgActorsWithWorkspacePermission({ workspaceId: f.workspace.id, appNpub: f.appNpub, permission: 'channel.manage' as any, actorIds: [f.owner.id] }, sql)).rejects.toThrow('workspace-anchored');
  });

  test('managers keep the membership directory shape plus authority', async () => {
    const f = await workspaceFixture();
    const member = await f.join('member');
    const result = await f.directory(f.owner);
    expect(result.status).toBe(200);
    expect(result.body.next_cursor).toBeNull();
    const entry = result.body.members.find((m: any) => m.actor.npub === member.npub);
    expect(Object.keys(entry).sort()).toEqual(['actor', 'authority', 'membership']);
    expect(entry.membership).toMatchObject({ workspace_id: f.workspace.id, actor_id: member.id, role: 'member' });
    expect(entry.authority).toEqual({ can_manage_workspace: false });
    expect(authorityOf(result.body, f.owner.npub)).toEqual({ can_manage_workspace: true });
  });
});

test('OpenAPI documents the directory authority boolean', () => {
  const paths = buildOpenApiDocument('https://tower.example.invalid').paths as any;
  const get = paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/members'].get;
  const item = get.responses['200'].content['application/json'].schema.properties.members.items;
  expect(item.required).toEqual(['actor', 'authority']);
  expect(item.properties.authority.properties.can_manage_workspace.type).toBe('boolean');
  expect(paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/members'].post).toBeDefined();
});
