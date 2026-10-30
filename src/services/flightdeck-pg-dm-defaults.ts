import { getDb } from '../db';

type DbClient = ReturnType<typeof getDb>;

/** DMs is workspace navigation, not a conversation ACL. Every current member
 * gets scope.read through Workspace; historical revocations of this one default
 * must not strand existing members or future joins. Never grant channel access
 * here, and leave every other revoked permission authoritative. */
export async function reconcileFlightDeckPgDmDefaults(
  sql: DbClient = getDb(),
  workspaceId: string | null = null,
): Promise<void> {
  await sql`
    INSERT INTO flightdeck_pg_scopes (workspace_id, name, description, kind, created_by_actor_id)
    SELECT w.id, 'DMs', 'Direct message conversations', 'dm', w.created_by_actor_id
    FROM flightdeck_pg_workspaces w
    WHERE (${workspaceId}::uuid IS NULL OR w.id = ${workspaceId}::uuid)
    ON CONFLICT (workspace_id, name) DO NOTHING
  `;
  // The active-grant unique index arbitrates concurrent joins/reconciliation.
  // Emit visibility invalidation only for newly repaired defaults, so a repeat
  // pass neither duplicates grants nor produces an endless refresh stream.
  await sql`
    WITH repaired AS (
      INSERT INTO flightdeck_pg_permission_grants (
        workspace_id, principal_type, principal_group_id, resource_type,
        resource_scope_id, permission, created_by_actor_id
      )
      SELECT s.workspace_id, 'group', g.id, 'scope', s.id, 'scope.read',
        COALESCE(w.created_by_actor_id, s.created_by_actor_id)
      FROM flightdeck_pg_scopes s
      JOIN flightdeck_pg_workspaces w ON w.id = s.workspace_id
      JOIN flightdeck_pg_groups g ON g.workspace_id = s.workspace_id AND g.name = 'Workspace'
      WHERE s.kind = 'dm' AND s.name = 'DMs' AND s.archived_at IS NULL
        AND (${workspaceId}::uuid IS NULL OR s.workspace_id = ${workspaceId}::uuid)
      ON CONFLICT (
        workspace_id, principal_type,
        COALESCE(principal_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
        resource_type,
        COALESCE(resource_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(resource_channel_id, '00000000-0000-0000-0000-000000000000'::uuid),
        permission
      ) WHERE revoked_at IS NULL DO NOTHING
      RETURNING workspace_id, resource_scope_id, created_by_actor_id
    )
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id, scope_id, actor_id, event_type, entity_type, entity_id, operation, payload
    )
    SELECT workspace_id, resource_scope_id, created_by_actor_id,
      'scope.access_updated', 'scope', resource_scope_id, 'updated',
      jsonb_build_object('scope_id', resource_scope_id, 'access_changed', true)
    FROM repaired
  `;
}
