import { readWorkspaceStorage } from '../src/services/flightdeck-pg-workspace-storage';
import { readFlightDeckPgWorkspaceReport, parseWorkspaceReportQuery, reportCount, workspaceReportTaskStates } from '../src/services/flightdeck-pg-workspace-report';
import { readFlightDeckPgMessageActivity, parseMessageActivityRange } from '../src/services/flightdeck-pg-message-activity';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import {
  authorizeFlightDeckPgOperation,
  createFlightDeckPgNestedGroupEdge,
  getEffectiveFlightDeckPgGroupIds,
  isFlightDeckPgSetupActorDisplayName,
  resolveOrCreateFlightDeckPgActor,
} from '../src/services/flightdeck-pg-authorization';
import {
  authorizeFlightDeckPgStorageAttach,
  createFlightDeckPgStorageLink,
  resolveReadableFlightDeckPgStorageObject,
} from '../src/services/flightdeck-pg-storage-access';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_flightdeck_pg_authorization';

let sql: ReturnType<typeof postgres>;

function testNpub(label: string): string {
  return nip19.npubEncode(createHash('sha256').update(label, 'utf8').digest('hex'));
}

function splitSqlStatements(migration: string): string[] {
  const statements: string[] = [];
  let current = '';
  let dollarQuote: string | null = null;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;

  for (let i = 0; i < migration.length; i += 1) {
    const char = migration[i];
    const next = migration[i + 1];

    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        current += char;
      }
      continue;
    }

    if (!singleQuoted && !doubleQuoted && !dollarQuote && char === '-' && next === '-') {
      lineComment = true;
      i += 1;
      continue;
    }

    if (!singleQuoted && !doubleQuoted && char === '$') {
      const match = migration.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        const tag = match[0];
        if (dollarQuote === tag) {
          dollarQuote = null;
        } else if (!dollarQuote) {
          dollarQuote = tag;
        }
        current += tag;
        i += tag.length - 1;
        continue;
      }
    }

    current += char;

    if (dollarQuote) continue;

    if (!doubleQuoted && char === "'" && migration[i - 1] !== '\\') {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && char === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === ';') {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = '';
    }
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

beforeAll(async () => {
  const adminOpts: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
  };
  if (process.env.DB_USER) adminOpts.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) adminOpts.password = process.env.DB_PASSWORD;

  const admin = postgres(adminOpts);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  const testOpts: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: TEST_DB,
  };
  if (process.env.DB_USER) testOpts.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) testOpts.password = process.env.DB_PASSWORD;

  sql = postgres(testOpts);
  setDb(sql);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  const statements = splitSqlStatements(migration);

  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
});

afterAll(async () => {
  await closeDb();
});

describe('Flight Deck PG actor identity resolution', () => {
  test('workspace setup placeholders cannot rename or reclassify an existing agent', async () => {
    const npub = testNpub('fdpg-auth-existing-agent-setup-placeholder');
    const original = await resolveOrCreateFlightDeckPgActor(npub, 'agent', {
      displayName: 'Workspace Member',
      sql,
    });

    expect(isFlightDeckPgSetupActorDisplayName('Workspace Creator')).toBe(true);

    const resolved = await resolveOrCreateFlightDeckPgActor(npub, 'human', {
      displayName: 'Workspace Creator',
      sql,
    });

    expect(resolved.id).toBe(original.id);
    expect(resolved.npub).toBe(npub);
    expect(resolved.kind).toBe('agent');
    expect(resolved.display_name).toBe('Workspace Member');
  });
});

type AuthorizationFixture = {
  workspaceId: string;
  appNpub: string;
  actors: {
    direct: { id: string; npub: string };
    group: { id: string; npub: string };
    nested: { id: string; npub: string };
    workspaceOnly: { id: string; npub: string };
  };
  groups: {
    parent: string;
    child: string;
  };
  scopes: {
    primary: string;
    sibling: string;
  };
  channels: {
    primary: string;
    sibling: string;
  };
};

async function expectSqlFailure(action: () => Promise<unknown>, code?: string) {
  try {
    await action();
  } catch (error) {
    if (code) {
      expect((error as { code?: string }).code).toBe(code);
    }
    return;
  }
  throw new Error('Expected SQL statement to fail');
}

async function seedAuthorizationFixture(label: string): Promise<AuthorizationFixture> {
  const appNpub = testNpub(`fdpg-auth-app-${label}`);
  const direct = await resolveOrCreateFlightDeckPgActor(testNpub(`fdpg-auth-direct-${label}`), 'human', { sql });
  const group = await resolveOrCreateFlightDeckPgActor(testNpub(`fdpg-auth-group-${label}`), 'human', { sql });
  const nested = await resolveOrCreateFlightDeckPgActor(testNpub(`fdpg-auth-nested-${label}`), 'agent', { sql });
  const workspaceOnly = await resolveOrCreateFlightDeckPgActor(testNpub(`fdpg-auth-workspace-only-${label}`), 'human', { sql });

  const [workspace] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_workspaces (
      tower_service_npub,
      workspace_service_npub,
      workspace_owner_npub,
      app_npub,
      name,
      created_by_actor_id
    )
    VALUES (
      ${testNpub(`fdpg-auth-tower-${label}`)},
      ${testNpub(`fdpg-auth-workspace-${label}`)},
      ${testNpub(`fdpg-auth-owner-${label}`)},
      ${appNpub},
      ${`Auth ${label}`},
      ${direct.id}
    )
    RETURNING id
  `;

  for (const actor of [direct, group, nested, workspaceOnly]) {
    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${actor.id}, 'member', ${direct.id})
    `;
  }

  const [parent] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${`Managers ${label}`}, 'system', ${direct.id})
    RETURNING id
  `;
  const [child] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${`AIAgents ${label}`}, 'system', ${direct.id})
    RETURNING id
  `;

  await sql`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    VALUES
      (${workspace.id}, ${parent.id}, ${group.id}, ${direct.id}),
      (${workspace.id}, ${child.id}, ${nested.id}, ${direct.id})
  `;

  const edge = await createFlightDeckPgNestedGroupEdge(
    {
      workspaceId: workspace.id,
      parentGroupId: parent.id,
      childGroupId: child.id,
      createdByActorId: direct.id,
    },
    sql,
  );
  expect(edge.ok).toBe(true);

  const [scope] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${`Scope ${label}`}, 'project', ${direct.id})
    RETURNING id
  `;
  const [siblingScope] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${`Sibling Scope ${label}`}, 'project', ${direct.id})
    RETURNING id
  `;
  const [primaryChannel] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${scope.id}, ${`Primary ${label}`}, 'channel', ${direct.id})
    RETURNING id
  `;
  const [siblingChannel] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${scope.id}, ${`Sibling ${label}`}, 'channel', ${direct.id})
    RETURNING id
  `;

  await sql`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_actor_id,
      resource_type,
      resource_channel_id,
      permission,
      created_by_actor_id
    )
    VALUES (
      ${workspace.id},
      'actor',
      ${direct.id},
      'channel',
      ${primaryChannel.id},
      'channel.read',
      ${direct.id}
    )
  `;

  await sql`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_group_id,
      resource_type,
      resource_channel_id,
      permission,
      created_by_actor_id
    )
    VALUES
      (${workspace.id}, 'group', ${parent.id}, 'channel', ${primaryChannel.id}, 'channel.read', ${direct.id}),
      (${workspace.id}, 'group', ${parent.id}, 'channel', ${primaryChannel.id}, 'task.read', ${direct.id})
  `;

  await sql`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_actor_id,
      resource_type,
      permission,
      created_by_actor_id
    )
    VALUES (${workspace.id}, 'actor', ${workspaceOnly.id}, 'workspace', 'workspace.read', ${direct.id})
  `;

  await sql`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_actor_id,
      resource_type,
      permission,
      created_by_actor_id
    )
    VALUES (${workspace.id}, 'actor', ${direct.id}, 'workspace', 'scope.create', ${direct.id})
  `;

  await sql`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_group_id,
      resource_type,
      resource_scope_id,
      permission,
      created_by_actor_id
    )
    VALUES (${workspace.id}, 'group', ${parent.id}, 'scope', ${scope.id}, 'channel.create', ${direct.id})
  `;

  return {
    workspaceId: workspace.id,
    appNpub,
    actors: {
      direct,
      group,
      nested,
      workspaceOnly,
    },
    groups: {
      parent: parent.id,
      child: child.id,
    },
    scopes: {
      primary: scope.id,
      sibling: siblingScope.id,
    },
    channels: {
      primary: primaryChannel.id,
      sibling: siblingChannel.id,
    },
  };
}

describe('Flight Deck PG authorization service', () => {
  test('computes direct group membership', async () => {
    const fixture = await seedAuthorizationFixture('directgroups');
    const groups = await getEffectiveFlightDeckPgGroupIds(fixture.workspaceId, fixture.actors.group.id, sql);
    expect(groups).toContain(fixture.groups.parent);
    expect(groups).not.toContain(fixture.groups.child);
  });

  test('computes nested group membership through parent group edges', async () => {
    const fixture = await seedAuthorizationFixture('nestedgroups');
    const groups = await getEffectiveFlightDeckPgGroupIds(fixture.workspaceId, fixture.actors.nested.id, sql);
    expect(groups).toContain(fixture.groups.child);
    expect(groups).toContain(fixture.groups.parent);
  });

  test('rejects nested group cycles before mutation', async () => {
    const fixture = await seedAuthorizationFixture('cyclecheck');
    const selfEdge = await createFlightDeckPgNestedGroupEdge(
      {
        workspaceId: fixture.workspaceId,
        parentGroupId: fixture.groups.parent,
        childGroupId: fixture.groups.parent,
        createdByActorId: fixture.actors.direct.id,
      },
      sql,
    );
    expect(selfEdge.ok).toBe(false);
    if (!selfEdge.ok) {
      expect(selfEdge.decision.category).toBe('validation-error');
      expect(selfEdge.decision.reason).toBe('group-edge-self-reference');
    }

    const cycleEdge = await createFlightDeckPgNestedGroupEdge(
      {
        workspaceId: fixture.workspaceId,
        parentGroupId: fixture.groups.child,
        childGroupId: fixture.groups.parent,
        createdByActorId: fixture.actors.direct.id,
      },
      sql,
    );
    expect(cycleEdge.ok).toBe(false);
    if (!cycleEdge.ok) {
      expect(cycleEdge.decision.category).toBe('validation-error');
      expect(cycleEdge.decision.reason).toBe('group-edge-cycle');
    }
  });

  test('denies a workspace member without channel access', async () => {
    const fixture = await seedAuthorizationFixture('workspaceonly');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.workspaceOnly.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.read',
        resource: { type: 'channel', channelId: fixture.channels.primary },
      },
      sql,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.category).toBe('permission-denied');
    expect(decision.reason).toBe('permission-grant-required');
  });

  test('allows scope create before the target scope row exists with a workspace grant', async () => {
    const fixture = await seedAuthorizationFixture('scopecreate');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'scope.create',
        resource: { type: 'workspace' },
      },
      sql,
    );
    expect(decision.allowed).toBe(true);
  });

  test('denies scope create without a workspace create grant', async () => {
    const fixture = await seedAuthorizationFixture('scopecreatedeny');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.workspaceOnly.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'scope.create',
        resource: { type: 'workspace' },
      },
      sql,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.category).toBe('permission-denied');
    expect(decision.reason).toBe('permission-grant-required');
  });

  test('allows channel create before the target channel row exists with a parent scope grant', async () => {
    const fixture = await seedAuthorizationFixture('channelcreate');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.group.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.create',
        resource: { type: 'scope', scopeId: fixture.scopes.primary },
      },
      sql,
    );
    expect(decision.allowed).toBe(true);
  });

  test('denies channel create when the grant is on a sibling scope', async () => {
    const fixture = await seedAuthorizationFixture('channelcreatedeny');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.group.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.create',
        resource: { type: 'scope', scopeId: fixture.scopes.sibling },
      },
      sql,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.category).toBe('permission-denied');
    expect(decision.reason).toBe('permission-grant-required');
  });

  test('allows channel grants through a direct actor grant', async () => {
    const fixture = await seedAuthorizationFixture('directgrant');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.read',
        resource: { type: 'channel', channelId: fixture.channels.primary },
      },
      sql,
    );
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.actorId).toBe(fixture.actors.direct.id);
      expect(decision.grantId).toBeTruthy();
    }
  });

  test('allows channel grants through direct and nested group grants', async () => {
    const fixture = await seedAuthorizationFixture('groupgrant');
    const groupDecision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.group.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.read',
        resource: { type: 'channel', channelId: fixture.channels.primary },
      },
      sql,
    );
    expect(groupDecision.allowed).toBe(true);

    const nestedDecision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.nested.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'task.read',
        resource: { type: 'channel', channelId: fixture.channels.primary },
      },
      sql,
    );
    expect(nestedDecision.allowed).toBe(true);
    if (nestedDecision.allowed) {
      expect(nestedDecision.effectiveGroupIds).toContain(fixture.groups.parent);
      expect(nestedDecision.effectiveGroupIds).toContain(fixture.groups.child);
    }
  });

  test('denies sibling channel access without a matching channel grant', async () => {
    const fixture = await seedAuthorizationFixture('siblingdeny');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.group.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.read',
        resource: { type: 'channel', channelId: fixture.channels.sibling },
      },
      sql,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.category).toBe('permission-denied');
    expect(decision.reason).toBe('permission-grant-required');
  });

  test('allows a channel reader to resolve a linked PG storage object', async () => {
    const fixture = await seedAuthorizationFixture('storageread');
    const [workspace] = await sql<{ workspace_owner_npub: string }[]>`
      SELECT workspace_owner_npub
      FROM flightdeck_pg_workspaces
      WHERE id = ${fixture.workspaceId}
      LIMIT 1
    `;
    const [storageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path,
        completed_at
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        ${fixture.actors.direct.npub},
        'brief.pdf',
        'application/pdf',
        'v4/flightdeck-pg/storage-read/brief.pdf',
        NOW()
      )
      RETURNING id
    `;

    const link = await createFlightDeckPgStorageLink(
      {
        workspaceId: fixture.workspaceId,
        channelId: fixture.channels.primary,
        entityType: 'file',
        storageObjectId: storageObject.id,
        createdByActorId: fixture.actors.direct.id,
      },
      sql,
    );

    const readable = await resolveReadableFlightDeckPgStorageObject(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        storageObjectId: storageObject.id,
      },
      sql,
    );

    expect(link.channel_id).toBe(fixture.channels.primary);
    expect(readable.ok).toBe(true);
    if (readable.ok) {
      expect(readable.access.permission).toBe('channel.read');
      expect(readable.storageObject.id).toBe(storageObject.id);
    }
  });

  test('denies linked PG storage access from a sibling channel', async () => {
    const fixture = await seedAuthorizationFixture('storagesibling');
    const [workspace] = await sql<{ workspace_owner_npub: string }[]>`
      SELECT workspace_owner_npub
      FROM flightdeck_pg_workspaces
      WHERE id = ${fixture.workspaceId}
      LIMIT 1
    `;
    const [storageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path,
        completed_at
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        ${fixture.actors.direct.npub},
        'sibling.pdf',
        'application/pdf',
        'v4/flightdeck-pg/storage-sibling/sibling.pdf',
        NOW()
      )
      RETURNING id
    `;

    await createFlightDeckPgStorageLink(
      {
        workspaceId: fixture.workspaceId,
        channelId: fixture.channels.sibling,
        entityType: 'file',
        storageObjectId: storageObject.id,
        createdByActorId: fixture.actors.direct.id,
      },
      sql,
    );

    const readable = await resolveReadableFlightDeckPgStorageObject(
      {
        actorNpub: fixture.actors.group.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        storageObjectId: storageObject.id,
      },
      sql,
    );

    expect(readable.ok).toBe(false);
    if (!readable.ok) {
      expect(readable.reason).toBe('permission-denied');
      expect(readable.access?.decision.reason).toBe('permission-grant-required');
    }
  });

  test('rejects duplicate active PG storage links before read authorization can drift channels', async () => {
    const fixture = await seedAuthorizationFixture('storagedupe');
    const [workspace] = await sql<{ workspace_owner_npub: string }[]>`
      SELECT workspace_owner_npub
      FROM flightdeck_pg_workspaces
      WHERE id = ${fixture.workspaceId}
      LIMIT 1
    `;
    const [storageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path,
        completed_at
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        ${fixture.actors.direct.npub},
        'dedupe.pdf',
        'application/pdf',
        'v4/flightdeck-pg/storage-dedupe/dedupe.pdf',
        NOW()
      )
      RETURNING id
    `;

    const link = await createFlightDeckPgStorageLink(
      {
        workspaceId: fixture.workspaceId,
        channelId: fixture.channels.primary,
        entityType: 'file',
        storageObjectId: storageObject.id,
        createdByActorId: fixture.actors.direct.id,
      },
      sql,
    );

    await expectSqlFailure(
      () =>
        createFlightDeckPgStorageLink(
          {
            workspaceId: fixture.workspaceId,
            channelId: fixture.channels.sibling,
            entityType: 'file',
            storageObjectId: storageObject.id,
            createdByActorId: fixture.actors.direct.id,
          },
          sql,
        ),
      '23505',
    );

    const readable = await resolveReadableFlightDeckPgStorageObject(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        storageObjectId: storageObject.id,
      },
      sql,
    );

    expect(readable.ok).toBe(true);
    if (readable.ok) {
      expect(readable.link.id).toBe(link.id);
      expect(readable.link.channel_id).toBe(fixture.channels.primary);
      expect(readable.storageObject.id).toBe(storageObject.id);
    }
  });

  test('requires channel write or entity write before attaching PG storage', async () => {
    const fixture = await seedAuthorizationFixture('storageattach');

    const denied = await authorizeFlightDeckPgStorageAttach(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        entityType: 'file',
        channelId: fixture.channels.primary,
      },
      sql,
    );
    expect(denied.allowed).toBe(false);

    await sql`
      INSERT INTO flightdeck_pg_permission_grants (
        workspace_id,
        principal_type,
        principal_actor_id,
        resource_type,
        resource_channel_id,
        permission,
        created_by_actor_id
      )
      VALUES (
        ${fixture.workspaceId},
        'actor',
        ${fixture.actors.direct.id},
        'channel',
        ${fixture.channels.primary},
        'channel.write',
        ${fixture.actors.direct.id}
      )
    `;

    const channelWriter = await authorizeFlightDeckPgStorageAttach(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        entityType: 'file',
        channelId: fixture.channels.primary,
      },
      sql,
    );
    expect(channelWriter.allowed).toBe(true);
    if (channelWriter.allowed) expect(channelWriter.permission).toBe('channel.write');

    await sql`
      INSERT INTO flightdeck_pg_permission_grants (
        workspace_id,
        principal_type,
        principal_actor_id,
        resource_type,
        resource_channel_id,
        permission,
        created_by_actor_id
      )
      VALUES (
        ${fixture.workspaceId},
        'actor',
        ${fixture.actors.workspaceOnly.id},
        'channel',
        ${fixture.channels.primary},
        'file.write',
        ${fixture.actors.direct.id}
      )
    `;

    const entityWriter = await authorizeFlightDeckPgStorageAttach(
      {
        actorNpub: fixture.actors.workspaceOnly.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        entityType: 'file',
        channelId: fixture.channels.primary,
      },
      sql,
    );
    expect(entityWriter.allowed).toBe(true);
    if (entityWriter.allowed) expect(entityWriter.permission).toBe('file.write');
  });
});

describe('Message activity aggregation', () => {
  test('requires an explicit supported range', () => {
    for (const range of [undefined, '', '1d', 'ALL', '7d ']) expect(parseMessageActivityRange(range)).toBeNull();
    for (const range of ['7d', '30d', 'all'] as const) expect(parseMessageActivityRange(range)).toBe(range);
  });

  test('concurrent ACL revocation and deletion cannot change an established snapshot', async () => {
    const f = await seedAuthorizationFixture('message-activity-snapshot');
    await sql`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id,created_at)
      VALUES(${f.workspaceId},${f.scopes.primary},${f.channels.primary},'snapshot',${f.actors.direct.id},${f.actors.direct.id},now()-interval '1 hour')`;
    const input = { workspaceId: f.workspaceId, actorId: f.actors.direct.id, groupIds: [], range: '7d' as const };
    await sql.begin('isolation level repeatable read read only', async tx => {
      const db = tx as unknown as typeof sql;
      const before = await readFlightDeckPgMessageActivity(input, db);
      await sql.begin(async writer => {
        const writerDb = writer as unknown as typeof sql;
        await writerDb`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.workspaceId} AND resource_channel_id=${f.channels.primary}`;
        await writerDb`UPDATE flightdeck_pg_messages SET deleted_at=now() WHERE workspace_id=${f.workspaceId}`;
      });
      expect(await readFlightDeckPgMessageActivity(input, db)).toEqual(before);
      expect(before.channels[0].count).toBe(1);
    });
    await sql.begin('isolation level repeatable read read only', async tx => {
      expect((await readFlightDeckPgMessageActivity(input, tx as unknown as typeof sql)).channels).toEqual([]);
    });
  });

  test('canonical replies, boundaries, ACLs, empty channels and snapshot consistency', async () => {
    const f = await seedAuthorizationFixture('message-activity');
    await sql.begin('isolation level repeatable read', async tx => {
      const db = tx as unknown as typeof sql;
      const [clock] = await db`SELECT date_trunc('milliseconds', transaction_timestamp()) AS now`;
      const now = clock.now as Date;
      const from = new Date(now.getTime() - 7 * 86400000);
      const [thread] = await db`INSERT INTO flightdeck_pg_threads (workspace_id, scope_id, channel_id, title, created_by_actor_id, updated_by_actor_id)
        VALUES (${f.workspaceId}, ${f.scopes.primary}, ${f.channels.primary}, 'reply', ${f.actors.direct.id}, ${f.actors.direct.id}) RETURNING id`;
      for (const [at, deleted, reply] of [
        [from, false, false], [new Date(from.getTime()-1), false, false],
        [new Date(now.getTime()-1), false, true], [now, false, false],
        [new Date(now.getTime()+1), false, false], [from, true, false],
      ] as const) {
        await db`INSERT INTO flightdeck_pg_messages (workspace_id, scope_id, channel_id, thread_id, body, created_by_actor_id, updated_by_actor_id, created_at, deleted_at)
          VALUES (${f.workspaceId}, ${f.scopes.primary}, ${f.channels.primary}, ${reply ? thread.id : null}, 'synthetic', ${f.actors.direct.id}, ${f.actors.direct.id}, ${at}, ${deleted ? now : null})`;
      }
      const input = { workspaceId: f.workspaceId, actorId: f.actors.direct.id, groupIds: [], range: '7d' as const };
      const activity = await readFlightDeckPgMessageActivity(input, db);
      expect(activity).toEqual({ workspace_id: f.workspaceId, range: '7d', from: from.toISOString(), to: now.toISOString(), as_of: now.toISOString(), complete: true,
        channels: [{ channel_id: f.channels.primary, scope_id: f.scopes.primary, count: 2 }] });
      expect((await readFlightDeckPgMessageActivity({ ...input, range: 'all' }, db)).channels[0].count).toBe(3);
      expect((await readFlightDeckPgMessageActivity({ ...input, range: '30d' }, db)).channels[0].count).toBe(3);
      expect((await readFlightDeckPgMessageActivity({ ...input, actorId: f.actors.workspaceOnly.id }, db)).channels).toEqual([]);
      // Multiple matching direct/group grants do not multiply canonical rows.
      expect((await readFlightDeckPgMessageActivity({ ...input, groupIds: [f.groups.parent] }, db)).channels[0].count).toBe(2);
      await db`UPDATE flightdeck_pg_messages SET deleted_at = ${now} WHERE workspace_id = ${f.workspaceId}`;
      expect((await readFlightDeckPgMessageActivity(input, db)).channels[0].count).toBe(0);
      await db`UPDATE flightdeck_pg_channels SET archived_at = ${now} WHERE id = ${f.channels.primary}`;
      expect((await readFlightDeckPgMessageActivity(input, db)).channels).toEqual([]);
      await db`UPDATE flightdeck_pg_channels SET archived_at = NULL WHERE id = ${f.channels.primary}`;
      await db`UPDATE flightdeck_pg_scopes SET archived_at = ${now} WHERE id = ${f.scopes.primary}`;
      expect((await readFlightDeckPgMessageActivity(input, db)).channels).toEqual([]);
    });
  });
});

describe('Workspace report', () => {
  const read = async (f: AuthorizationFixture, extra: Record<string, any> = {}, db = sql) => readFlightDeckPgWorkspaceReport({
    workspaceId:f.workspaceId,actorId:f.actors.direct.id,groupIds:[],range:'7d',topN:10,...extra,
  },db);
  test('strict bounded inputs and unsafe/unknown counts fail closed', () => {
    for (const q of ['', 'range=ALL', 'range=7d&top_n=0', 'range=7d&top_n=51', 'range=7d&top_n=1.0', 'range=7d&top_n=01', 'range=7d&top_n=1e1', 'range=7d&range=all', 'range=7d&scope=x']) expect(parseWorkspaceReportQuery(new URLSearchParams(q))).toBeNull();
    expect(parseWorkspaceReportQuery(new URLSearchParams('range=90d'))).toEqual({range:'90d',topN:10});
    expect(parseWorkspaceReportQuery(new URLSearchParams('range=all&top_n=50'))).toEqual({range:'all',topN:50});
    for (const bad of ['9007199254740992', -1, 1.5, null, '', 'NaN']) expect(() => reportCount(bad)).toThrow();
  });
  test('family ACL, real inventory states, archive semantics, UTC edges and zero channels', async () => {
    const f = await seedAuthorizationFixture('report-inventory');
    await sql.begin('isolation level repeatable read', async tx => {
      const db = tx as unknown as typeof sql;
      const [clock] = await db`SELECT date_trunc('milliseconds',transaction_timestamp()) AS now`;
      const now = clock.now as Date, from = new Date(now.getTime()-7*86400000);
      const threads: string[] = [];
      for (const archived of [false,true]) {
        const [t] = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id,archived_at)
          VALUES(${f.workspaceId},${f.scopes.primary},${f.channels.primary},'private thread',${f.actors.direct.id},${f.actors.direct.id},${archived?now:null}) RETURNING id`;
        threads.push(t.id);
      }
      // Actual thread/channel IDs are counted once; branch/inherited transcripts are not read.
      for (const [at,thread,deleted] of [[from,threads[0],false],[new Date(now.getTime()-1),threads[1],false],[from,null,false],[new Date(from.getTime()-1),threads[0],false],[now,threads[0],false],[from,threads[0],true]] as const) {
        await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id,created_at,deleted_at)
          VALUES(${f.workspaceId},${f.scopes.primary},${f.channels.primary},${thread},'never return secret',${f.actors.direct.id},${f.actors.direct.id},${at},${deleted?now:null})`;
      }
      const [point] = await db`SELECT id FROM flightdeck_pg_messages WHERE workspace_id=${f.workspaceId} AND thread_id=${threads[0]} AND deleted_at IS NULL ORDER BY created_at LIMIT 1`;
      await db`UPDATE flightdeck_pg_threads SET parent_thread_id=${threads[0]},branch_point_message_id=${point.id} WHERE id=${threads[1]}`;
      for (const state of workspaceReportTaskStates) await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,state,created_by_actor_id,updated_by_actor_id)
        VALUES(${f.workspaceId},${f.scopes.primary},${f.channels.primary},'private task',${state},${f.actors.direct.id},${f.actors.direct.id})`;
      for (const table of ['flightdeck_pg_docs','flightdeck_pg_files']) for (const mode of ['live','archived','deleted']) {
      const [object] = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,file_name,content_type,storage_path) VALUES(${f.actors.direct.npub},${f.actors.direct.npub},'secret','text/plain',${`fixture/report/${table}/${mode}`}) RETURNING id`;
        const title = table.endsWith('docs') ? 'title' : 'display_name';
        await db`INSERT INTO ${db(table)}(workspace_id,scope_id,channel_id,storage_object_id,${db(title)},created_by_actor_id,updated_by_actor_id,archived_at,deleted_at)
          VALUES(${f.workspaceId},${f.scopes.primary},${f.channels.primary},${object.id},'private',${f.actors.direct.id},${f.actors.direct.id},${mode==='archived'?now:null},${mode==='deleted'?now:null})`;
      }
      await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id,created_at)
        VALUES(${f.workspaceId},${f.scopes.primary},${f.channels.sibling},'denied body',${f.actors.direct.id},${f.actors.direct.id},${from})`;
      await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,state,created_by_actor_id,updated_by_actor_id)
        VALUES(${f.workspaceId},${f.scopes.primary},${f.channels.sibling},'denied task','done',${f.actors.direct.id},${f.actors.direct.id})`;
      let report = await read(f,{},db);
      expect(report.activity).toEqual({messages:3,conversations:2});
      expect(report.from).toBe(from.toISOString()); expect(report.to).toBe(now.toISOString()); expect(report.as_of).toBe(report.to);
      expect(report.inventory).toMatchObject({channels:1,conversations:1,tasks:{total:0},documents:1,files:1});
      expect(report.coverage).toEqual({tasks_channels:0,documents_channels:1,files_channels:1});
      const groups = await getEffectiveFlightDeckPgGroupIds(f.workspaceId,f.actors.nested.id,db);
      report = await read(f,{actorId:f.actors.nested.id,groupIds:groups},db);
      expect(report.activity.messages).toBe(3);
      expect(report.inventory.tasks).toEqual({total:9,open:6,completed:1,archived:2,by_state:Object.fromEntries(workspaceReportTaskStates.map(s=>[s,1])) as typeof report.inventory.tasks.by_state});
      expect(report.coverage.tasks_channels).toBe(1);
      for (const range of ['30d','90d','all'] as const) {
        const wider=await read(f,{range},db);
        expect(wider.activity.messages).toBe(4);
        expect(wider.from).toBe(range==='all'?null:new Date(now.getTime()-(range==='30d'?30:90)*86400000).toISOString());
      }
      expect(report.channels.some(c=>c.channel_id===f.channels.sibling)).toBe(false);

      expect(JSON.stringify(report)).not.toContain('private task'); expect(JSON.stringify(report)).not.toContain('never return secret');
      expect((await read(f,{actorId:f.actors.workspaceOnly.id},db)).inventory.channels).toBe(0);
      // Resource-family grant alone never reveals a channel or its resource counts.
      await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=${now} WHERE workspace_id=${f.workspaceId} AND permission='channel.read'`;
      expect((await read(f,{actorId:f.actors.nested.id,groupIds:groups},db)).inventory.tasks.total).toBe(0);
    });
  });
  test('complete ranking and remainder; channel-kind and lifecycle exclusions', async () => {
    const f=await seedAuthorizationFixture('report-ranking');
    for(let i=0;i<13;i++) {
      const [c]=await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind) VALUES(${f.workspaceId},${f.scopes.primary},${`zero ${i}`},'channel') RETURNING id`;
      await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${f.workspaceId},'actor',${f.actors.direct.id},'channel',${c.id},'channel.read')`;
      if(i<3) await sql`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id,created_at) VALUES(${f.workspaceId},${f.scopes.primary},${c.id},'no hydrate',${f.actors.direct.id},${f.actors.direct.id},now()-interval '1 hour')`;
    }
    await sql`UPDATE flightdeck_pg_scopes SET kind='department' WHERE id=${f.scopes.primary}`;
    const report=await read(f,{topN:2});
    expect(report.inventory.channels).toBe(14); expect(report.channels.length).toBe(2);
    expect(report.activity.messages).toBe(3); expect(report.ranking).toMatchObject({total_channels:14,returned_channels:2,has_more:true,other_messages:1});
    expect(report.channels.reduce((n,r)=>n+r.messages,0)+report.ranking.other_messages).toBe(report.activity.messages);
    expect(report.channels[0].channel_id < report.channels[1].channel_id).toBe(true);
    await sql`UPDATE flightdeck_pg_channels SET kind='system' WHERE id=${f.channels.primary}`;
    expect((await read(f)).inventory.channels).toBe(13);
    await sql`UPDATE flightdeck_pg_channels SET kind='dm' WHERE id=${f.channels.primary}`;
    expect((await read(f)).inventory.channels).toBe(13);
    await sql`UPDATE flightdeck_pg_scopes SET archived_at=now() WHERE id=${f.scopes.primary}`;
    expect((await read(f)).activity).toEqual({messages:0,conversations:0});
  });
  test('snapshot retains established ACL and next snapshot loses it', async () => {
    const f=await seedAuthorizationFixture('report-snapshot');
    await sql.begin('isolation level repeatable read read only',async tx=>{
      const db=tx as unknown as typeof sql, first=await read(f,{},db);
      await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.workspaceId}`;
      expect(await read(f,{},db)).toEqual(first);
    });
    expect((await read(f)).inventory.channels).toBe(0);
  });
  test('overlong source names fail without silent truncation', async () => {
    const f=await seedAuthorizationFixture('report-label-bound');
    await sql`UPDATE flightdeck_pg_channels SET name=${'x'.repeat(301)} WHERE id=${f.channels.primary}`;
    await expect(read(f)).rejects.toMatchObject({code:'report_unavailable'});
  });
  test('unknown source states fail rather than omit data', async () => {
    const f=await seedAuthorizationFixture('report-unknown-state');
    const rollback = new Error('rollback disposable schema edit');
    try {
      await sql.begin(async tx=>{
        const db=tx as unknown as typeof sql;
        await db`ALTER TABLE flightdeck_pg_tasks DROP CONSTRAINT flightdeck_pg_tasks_state_check`;
        await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,state,created_by_actor_id,updated_by_actor_id)
          VALUES(${f.workspaceId},${f.scopes.primary},${f.channels.primary},'unknown','future_state',${f.actors.direct.id},${f.actors.direct.id})`;
        await expect(read(f,{actorId:f.actors.nested.id,groupIds:[f.groups.parent]},db)).rejects.toMatchObject({code:'report_unavailable'});
        throw rollback;
      });
    } catch(error) { if(error!==rollback) throw error; }
  });
  test('2000 authorized channels is complete; 2001 fails before content scans', async () => {
    const f=await seedAuthorizationFixture('report-bound');
    await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind)
      SELECT ${f.workspaceId},${f.scopes.primary},'bounded '||n,'channel' FROM generate_series(1,1999) n`;
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      SELECT ${f.workspaceId},'actor',${f.actors.direct.id},'channel',c.id,'channel.read' FROM flightdeck_pg_channels c WHERE c.workspace_id=${f.workspaceId} AND c.name LIKE 'bounded %'`;
    expect((await read(f)).inventory.channels).toBe(2000);
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${f.workspaceId}`;
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      VALUES(${f.workspaceId},'actor',${f.actors.direct.id},'channel',${f.channels.sibling},'channel.read')`;
    await expect(read(f)).rejects.toMatchObject({code:'report_too_large'});
  });
});

describe('Workspace storage retained metadata', () => {
  test('counts retained deleted versions once per object path, excludes other workspace, and uses bounded aggregate queries', async () => {
    const f=await seedAuthorizationFixture('storage-retained');
    const other=await seedAuthorizationFixture('storage-other');
    const object=async (path:string, bytes:number, complete=true, workspace=f.workspaceId) => {
      const [o]=await sql`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,storage_path,completed_at,pg_workspace_id)
        VALUES('synthetic-owner','synthetic-author','text/plain',${bytes},${path},${complete?new Date():null},${workspace}) RETURNING id`;
      return o.id as string;
    };
    const head=await object('synthetic/head',20), history=await object('synthetic/retained',30);
    await object('synthetic/head',20); // Same physical key, independent metadata row.
    await object('synthetic/pending',900,false);
    await object('synthetic/other',700,true,other.workspaceId);
    const [file]=await sql`INSERT INTO flightdeck_pg_files(workspace_id,scope_id,channel_id,storage_object_id,created_by_actor_id,updated_by_actor_id,deleted_at)
      VALUES(${f.workspaceId},${f.scopes.primary},${f.channels.primary},${head},${f.actors.direct.id},${f.actors.direct.id},now()) RETURNING id`;
    await sql`INSERT INTO flightdeck_pg_file_versions(workspace_id,file_id,version_number,storage_object_id,created_by_actor_id)
      VALUES(${f.workspaceId},${file.id},1,${history},${f.actors.direct.id}),(${f.workspaceId},${file.id},2,${head},${f.actors.direct.id})`;
    // Older upload with no explicit workspace owner is recovered through retained version reference.
    await sql`UPDATE v4_storage_objects SET pg_workspace_id=NULL WHERE id=${history}`;
    let calls=0;
    const counted=new Proxy(sql,{apply(target,thisArg,args){calls++; return Reflect.apply(target,thisArg,args);},
      get(target,prop){if(prop==='unsafe') return (...args: any[])=>{calls++;return (target.unsafe as any)(...args);};return Reflect.get(target,prop);}});
    const report=await readWorkspaceStorage(f.workspaceId,'2026-01-01T00:00:00.000Z',counted);
    const metrics=(group:string)=>Object.fromEntries(report.groups.find(g=>g.id===group)!.metrics.map(m=>[m.id,m]));
    expect(metrics('object_storage').bytes.value).toBe(50);
    expect(metrics('object_storage').objects.value).toBe(2);
    expect(metrics('object_storage').pending_objects.value).toBe(1);
    expect(metrics('object_storage').provider_actual_bytes).toMatchObject({value:null,status:'unavailable'});
    expect(metrics('postgres').physical_bytes).toMatchObject({value:null,status:'unavailable'});
    expect(metrics('postgres').history_rows.value).toBeGreaterThanOrEqual(2);
    expect(metrics('postgres').row_json_bytes.value).toBeGreaterThan(0);
    expect(calls).toBe(3);
    expect(JSON.stringify(report)).not.toContain('synthetic/');
    await sql`UPDATE flightdeck_pg_scopes SET description=repeat('x',10000) WHERE workspace_id=${other.workspaceId}`;
    const isolated=await readWorkspaceStorage(f.workspaceId,report.as_of,sql);
    expect(isolated.groups).toEqual(report.groups);
    await object('synthetic/head',21);
    await expect(readWorkspaceStorage(f.workspaceId,report.as_of,sql)).rejects.toThrow('Workspace report unavailable');
  });
  test('row budget fails closed rather than reporting truncated or zero usage', async () => {
    const f=await seedAuthorizationFixture('storage-limit');
    await sql`CREATE TABLE usage_test_rows(workspace_id uuid, body text)`;
    try {
      await sql`INSERT INTO usage_test_rows SELECT ${f.workspaceId}::uuid,'synthetic' FROM generate_series(1,100001)`;
      await expect(readWorkspaceStorage(f.workspaceId,'2026-01-01T00:00:00.000Z',sql)).rejects.toMatchObject({code:'report_too_large'});
    } finally {await sql`DROP TABLE usage_test_rows`;}
  });
});
