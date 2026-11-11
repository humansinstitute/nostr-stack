import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
// Legacy fixture without the runtime schema and without agent classifications: explicit, test-only ceiling provider.
import { unclassifiedFixtureCeiling } from '../src/services/agent-notifications';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { createFlightDeckPgWorkspaceMember } from '../src/services/flightdeck-pg-api';
import { setupFlightDeckPgDevWorkspace } from '../src/services/flightdeck-pg-setup';

// Scoped per-app namespace registration under typed PG authority (Alexandria-style apps that need their own
// private app rows without an Ambulando channel or the legacy owner-only /workspaces/:owner/apps route).

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_flightdeck_pg_app_namespace_registration';

const managerSecret = new Uint8Array(32).fill(91);
const memberSecret = new Uint8Array(32).fill(92);
const outsiderSecret = new Uint8Array(32).fill(93);
const MANAGER = nip19.npubEncode(getPublicKey(managerSecret));
const MEMBER = nip19.npubEncode(getPublicKey(memberSecret));

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
let workspaceA: Awaited<ReturnType<typeof setupFlightDeckPgDevWorkspace>>;
let workspaceB: Awaited<ReturnType<typeof setupFlightDeckPgDevWorkspace>>;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function testNpub(label: string): string {
  return nip19.npubEncode(sha256Hex(label));
}

async function rawRequest(path: string, method: 'GET' | 'POST', secret: Uint8Array, rawBody?: string, headers: Record<string, string> = {}) {
  const tags = [['u', `http://localhost${path}`], ['method', method]];
  if (rawBody !== undefined) tags.push(['payload', sha256Hex(rawBody)]);
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, secret);
  const response = await app.request(path, {
    method,
    headers: {
      ...(rawBody === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`,
      ...headers,
    },
    body: rawBody,
  });
  return { response, json: await response.json() as Record<string, any> };
}

const getJson = (path: string, secret: Uint8Array, headers?: Record<string, string>) => rawRequest(path, 'GET', secret, undefined, headers);
const postJson = (path: string, secret: Uint8Array, body: unknown, headers?: Record<string, string>) =>
  rawRequest(path, 'POST', secret, JSON.stringify(body), headers);

function registrationPath(workspaceId: string, appNpub: string, query = '') {
  return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/apps/${appNpub}/registration${query}`;
}

function rowsPath(workspaceId: string, appNpub: string) {
  return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/apps/${appNpub}/db/library-items/rows`;
}

async function storedApps(ownerNpub: string, appNpub: string) {
  return sql<{ app_name: string; enabled: boolean; capabilities: string[]; created_by_npub: string }[]>`
    SELECT app_name, enabled, capabilities, created_by_npub
    FROM workspace_apps
    WHERE workspace_owner_npub = ${ownerNpub} AND app_npub = ${appNpub}
  `;
}

beforeAll(async () => {
  const adminOptions: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: Number.parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
  };
  if (process.env.DB_USER) adminOptions.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) adminOptions.password = process.env.DB_PASSWORD;
  const admin = postgres(adminOptions);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }
  sql = postgres({ ...adminOptions, database: TEST_DB });
  setDb(sql);
  const here = dirname(fileURLToPath(import.meta.url));
  for (const statement of splitSqlStatements(readFileSync(join(here, '../src/schema/001_init.sql'), 'utf8'))) {
    await sql.unsafe(statement);
  }

  const setup = (label: string) => setupFlightDeckPgDevWorkspace({
    towerServiceNpub: testNpub(`${label}-tower`), workspaceServiceNpub: testNpub(`${label}-service`),
    workspaceOwnerNpub: testNpub(`${label}-owner`), appNpub: testNpub(`${label}-flightdeck`),
    creatorNpub: MANAGER, workspaceName: `Registration ${label}`, towerBaseUrl: 'http://localhost',
  }, sql);
  workspaceA = await setup('ns-a');
  workspaceB = await setup('ns-b');
  await createFlightDeckPgWorkspaceMember({ workspaceId: workspaceA.workspace_id, actorNpub: MEMBER,
    role: 'member', kind: 'human', createdByActorId: workspaceA.actors.creator.actor_id }, sql);

  app = createApp({ agentCeiling: unclassifiedFixtureCeiling });
});

afterAll(async () => {
  await closeDb();
});

describe('Flight Deck PG per-app namespace registration', () => {
  test('manager creates once; members read; app rows then honour declared private-only policy', async () => {
    const appNpub = testNpub('alexandria-create');
    const ownerNpub = workspaceA.descriptor.identity.workspace_owner_npub;
    const path = registrationPath(workspaceA.workspace_id, appNpub);

    const before = await getJson(path, memberSecret);
    expect(before.response.status).toBe(200);
    expect(before.response.headers.get('cache-control')).toBe('private, no-store');
    expect(before.json.registration).toEqual({ installed: false, enabled: false, app_npub: appNpub, app_name: null, capabilities: [] });
    expect(before.json.identity.workspace_id).toBe(workspaceA.workspace_id);

    const created = await postJson(path, managerSecret, { app_name: '  Alexandria ', capabilities: ['app_rows.private_only', 'app_rows.private_only'] });
    expect(created.response.status).toBe(201);
    expect(created.json.created).toBe(true);
    expect(created.json.registration).toEqual({
      installed: true, enabled: true, app_npub: appNpub, app_name: 'Alexandria', capabilities: ['app_rows.private_only'],
    });
    const stored = await storedApps(ownerNpub, appNpub);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ app_name: 'Alexandria', enabled: true, capabilities: ['app_rows.private_only'], created_by_npub: MANAGER });
    const audits = await sql`SELECT metadata FROM flightdeck_pg_audit_events
      WHERE workspace_id = ${workspaceA.workspace_id} AND action = 'workspace_app_registration.create'`;
    expect(audits.map((row) => row.metadata.app_npub)).toContain(appNpub);

    const after = await getJson(path, memberSecret);
    expect(after.json.registration).toEqual(created.json.registration);

    const privateRow = await postJson(rowsPath(workspaceA.workspace_id, appNpub), memberSecret, {
      row_id: 'book-1', visibility: 'private', data: { title: 'Meditations' },
    });
    expect(privateRow.response.status).toBe(201);
    expect(privateRow.json.workspace_owner_npub).toBe(ownerNpub);
    const shared = await postJson(rowsPath(workspaceA.workspace_id, appNpub), memberSecret, {
      row_id: 'book-2', visibility: 'workspace', data: { title: 'Shared' },
    });
    expect(shared.response.status).toBe(403);
    expect(shared.json.code).toBe('visibility_forbidden');
  });

  test('repeat and concurrent ensure calls converge on one unchanged row', async () => {
    const appNpub = testNpub('alexandria-concurrent');
    const ownerNpub = workspaceA.descriptor.identity.workspace_owner_npub;
    const path = registrationPath(workspaceA.workspace_id, appNpub);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      postJson(path, managerSecret, { app_name: `Alexandria ${index}`, capabilities: index % 2 ? ['app_rows.private_only'] : [] })));
    const statuses = results.map((result) => result.response.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(results.filter((result) => result.json.created === true)).toHaveLength(1);
    const stored = await storedApps(ownerNpub, appNpub);
    expect(stored).toHaveLength(1);
    // Every caller sees the winning row exactly as stored.
    for (const result of results) {
      expect(result.json.registration).toEqual({ installed: true, enabled: true, app_npub: appNpub,
        app_name: stored[0].app_name, capabilities: stored[0].capabilities });
    }
    const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM flightdeck_pg_audit_events
      WHERE workspace_id = ${workspaceA.workspace_id} AND action = 'workspace_app_registration.create'
        AND metadata->>'app_npub' = ${appNpub}`;
    expect(count).toBe(1);

    const repeat = await postJson(path, managerSecret, { app_name: 'Renamed', capabilities: ['storage.private'] });
    expect(repeat.response.status).toBe(200);
    expect(repeat.json.created).toBe(false);
    expect(await storedApps(ownerNpub, appNpub)).toEqual(stored);
  });

  test('existing policy is preserved and a disabled registration is never reactivated', async () => {
    const ownerNpub = workspaceA.descriptor.identity.workspace_owner_npub;
    const policyApp = testNpub('alexandria-existing-policy');
    await sql`INSERT INTO workspace_apps (workspace_owner_npub, app_npub, app_name, enabled, capabilities, created_by_npub)
      VALUES (${ownerNpub}, ${policyApp}, 'Operator name', true, ${sql.json(['storage.private'])}, ${MANAGER})`;
    const kept = await postJson(registrationPath(workspaceA.workspace_id, policyApp), managerSecret, { app_name: 'Alexandria', capabilities: ['app_rows.private_only'] });
    expect(kept.response.status).toBe(200);
    expect(kept.json.registration).toMatchObject({ app_name: 'Operator name', capabilities: ['storage.private'] });

    const disabledApp = testNpub('alexandria-disabled');
    await sql`INSERT INTO workspace_apps (workspace_owner_npub, app_npub, app_name, enabled, capabilities, created_by_npub)
      VALUES (${ownerNpub}, ${disabledApp}, 'Disabled app', false, ${sql.json([])}, ${MANAGER})`;
    const path = registrationPath(workspaceA.workspace_id, disabledApp);
    const refused = await postJson(path, managerSecret, { app_name: 'Alexandria' });
    expect(refused.response.status).toBe(409);
    expect(refused.json).toMatchObject({ code: 'workspace_app_disabled', status: 409,
      registration: { installed: true, enabled: false, app_npub: disabledApp, app_name: 'Disabled app', capabilities: [] } });
    expect((await storedApps(ownerNpub, disabledApp))[0]).toMatchObject({ enabled: false, app_name: 'Disabled app' });
    const read = await getJson(path, memberSecret);
    expect(read.json.registration).toMatchObject({ installed: true, enabled: false });
  });

  test('non-managers and non-members cannot register; unrelated workspaces stay separate', async () => {
    const appNpub = testNpub('alexandria-authority');
    const pathA = registrationPath(workspaceA.workspace_id, appNpub);
    const denied = await postJson(pathA, memberSecret, { app_name: 'Alexandria' });
    expect(denied.response.status).toBe(403);
    expect(denied.json).toMatchObject({ code: 'permission_denied', required_permission: 'workspace.manage' });
    expect(await storedApps(workspaceA.descriptor.identity.workspace_owner_npub, appNpub)).toHaveLength(0);

    for (const result of [await postJson(pathA, outsiderSecret, { app_name: 'Alexandria' }), await getJson(pathA, outsiderSecret)]) {
      expect(result.response.status).toBe(403);
      expect(result.json.code).toBe('workspace_membership_required');
    }

    // The member of A has no membership in B, even though the app npub is the same.
    const pathB = registrationPath(workspaceB.workspace_id, appNpub);
    expect((await getJson(pathB, memberSecret)).json.code).toBe('workspace_membership_required');
    expect((await postJson(pathA, managerSecret, { app_name: 'Alexandria A' })).response.status).toBe(201);
    const readB = await getJson(pathB, managerSecret);
    expect(readB.json.registration.installed).toBe(false);
    const createdB = await postJson(pathB, managerSecret, { app_name: 'Alexandria B' });
    expect(createdB.response.status).toBe(201);
    expect((await storedApps(workspaceB.descriptor.identity.workspace_owner_npub, appNpub))[0].app_name).toBe('Alexandria B');
    expect((await storedApps(workspaceA.descriptor.identity.workspace_owner_npub, appNpub))[0].app_name).toBe('Alexandria A');

    const missing = await getJson(registrationPath('00000000-0000-4000-8000-000000000000', appNpub), managerSecret);
    expect(missing.response.status).toBe(404);
    expect(missing.json.code).toBe('workspace_not_found');
  });

  test('rejects non-canonical app npubs and mismatched app/owner labels', async () => {
    const valid = testNpub('alexandria-labels');
    const hex = sha256Hex('alexandria-labels');
    for (const appNpub of ['npub1notvalid', valid.toUpperCase(), nip19.noteEncode(hex), hex]) {
      for (const result of [
        await getJson(registrationPath(workspaceA.workspace_id, appNpub), managerSecret),
        await postJson(registrationPath(workspaceA.workspace_id, appNpub), managerSecret, { app_name: 'Alexandria' }),
      ]) {
        expect(result.response.status).toBe(400);
        expect(result.json.details.fields).toEqual([expect.objectContaining({ path: 'app_npub', code: 'invalid' })]);
      }
    }

    const path = registrationPath(workspaceA.workspace_id, valid);
    const mismatched = await postJson(path, managerSecret, { app_name: 'Alexandria' }, { 'x-flightdeck-pg-app-npub': testNpub('other-app') });
    expect(mismatched.response.status).toBe(403);
    expect(mismatched.json.code).toBe('workspace_app_identity_mismatch');
    const ownerSpoof = await getJson(registrationPath(workspaceA.workspace_id, valid, `?owner_npub=${testNpub('spoof-owner')}`), managerSecret);
    expect(ownerSpoof.json.code).toBe('workspace_app_identity_mismatch');
    const queryAppSpoof = await getJson(registrationPath(workspaceA.workspace_id, valid, `?app_npub=${testNpub('spoof-app')}`), managerSecret);
    expect(queryAppSpoof.json.code).toBe('workspace_app_identity_mismatch');
    expect(await storedApps(workspaceA.descriptor.identity.workspace_owner_npub, valid)).toHaveLength(0);

    // Either the path app or the workspace's own app is an acceptable source label.
    expect((await getJson(path, managerSecret, { 'x-flightdeck-pg-app-npub': valid })).response.status).toBe(200);
    expect((await getJson(path, managerSecret, { 'x-flightdeck-pg-app-npub': workspaceA.app_npub })).response.status).toBe(200);
  });

  test('rejects malformed bodies predictably without creating a row', async () => {
    const appNpub = testNpub('alexandria-bodies');
    const path = registrationPath(workspaceA.workspace_id, appNpub);
    const cases: Array<[string, string, string]> = [
      ['{not json', 'body', 'invalid_json'],
      ['[]', 'body', 'invalid_json'],
      ['{}', 'app_name', 'required'],
      [JSON.stringify({ app_name: '   ' }), 'app_name', 'required'],
      [JSON.stringify({ app_name: 7 }), 'app_name', 'invalid'],
      [JSON.stringify({ app_name: 'x'.repeat(129) }), 'app_name', 'invalid'],
      [JSON.stringify({ app_name: 'Alexandria', capabilities: 'app_rows.private_only' }), 'capabilities', 'invalid'],
      [JSON.stringify({ app_name: 'Alexandria', capabilities: ['App_Rows'] }), 'capabilities', 'invalid'],
      [JSON.stringify({ app_name: 'Alexandria', capabilities: [1] }), 'capabilities', 'invalid'],
      [JSON.stringify({ app_name: 'Alexandria', capabilities: Array.from({ length: 33 }, (_, i) => `cap${i}`) }), 'capabilities', 'invalid'],
    ];
    for (const [body, fieldPath, code] of cases) {
      const result = await rawRequest(path, 'POST', managerSecret, body);
      expect(result.response.status).toBe(400);
      expect(result.json.code).toBe('validation_error');
      expect(result.json.details.fields).toEqual([expect.objectContaining({ path: fieldPath, code })]);
    }
    expect(await storedApps(workspaceA.descriptor.identity.workspace_owner_npub, appNpub)).toHaveLength(0);
  });

  test('existing workspace app-registration route keeps its shape', async () => {
    const result = await getJson(`/api/v4/flightdeck-pg/workspaces/${workspaceA.workspace_id}/app-registration`, memberSecret,
      { 'x-flightdeck-pg-app-npub': workspaceA.app_npub });
    expect(result.response.status).toBe(200);
    expect(Object.keys(result.json.registration).sort()).toEqual(['app_name', 'app_npub', 'enabled', 'installed']);
    expect(result.json.registration.app_npub).toBe(workspaceA.app_npub);
  });
});
