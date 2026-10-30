import { reconcileFlightDeckPgDmDefaults } from './flightdeck-pg-dm-defaults';
import { nip19 } from 'nostr-tools';
import { getDb } from '../db';
import type { FlightDeckPgPersonKind } from '../types';
import type { FlightDeckPgActor } from './flightdeck-pg-authorization';
import type { FlightDeckPgGroupMemberRow } from './flightdeck-pg-api';

type DbClient = ReturnType<typeof getDb>;

export class FlightDeckPgEnrollmentError extends Error {
  constructor(public readonly code: 'group_not_found' | 'actor_kind_conflict', message: string) {
    super(message);
  }
}

export function isEnrollmentNpub(value: unknown): value is string {
  if (typeof value !== 'string' || !/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(value)) return false;
  try { return nip19.decode(value).type === 'npub'; } catch { return false; }
}

/** Caller must authorize workspace.manage and supply one transaction for this and audit writes. */
export async function enrollFlightDeckPgGroupMember(input: {
  workspaceId: string;
  groupId: string;
  memberNpub: string;
  kind: FlightDeckPgPersonKind;
  createdByActorId: string;
}, sql: DbClient) {
  // Keep the target alive through enrollment; a missing/cross-workspace group cannot enroll anyone.
  const [group] = await sql`
    SELECT id FROM flightdeck_pg_groups
    WHERE workspace_id = ${input.workspaceId} AND id = ${input.groupId}
    FOR KEY SHARE
  `;
  if (!group) throw new FlightDeckPgEnrollmentError('group_not_found', 'Flight Deck PG group not found');

  // DO NOTHING followed by a fresh statement sees a concurrent winner without rewriting its kind.
  await sql`
    INSERT INTO flightdeck_pg_actors (npub, kind)
    VALUES (${input.memberNpub}, ${input.kind})
    ON CONFLICT (npub) DO NOTHING
  `;
  const [actor] = await sql<FlightDeckPgActor[]>`
    SELECT id, npub, kind, display_name FROM flightdeck_pg_actors
    WHERE npub = ${input.memberNpub} FOR UPDATE
  `;
  if (actor.kind !== 'human' && actor.kind !== 'agent') {
    throw new FlightDeckPgEnrollmentError('actor_kind_conflict', 'Workspace person enrollment requires an existing human or agent actor');
  }

  // Never call the role-changing workspace member helper on this path.
  // The existing AFTER INSERT trigger adds new members to the default Workspace group atomically.
  // A retired identity can return only through this explicit, authorized action;
  // bootstrap and subscription paths cannot satisfy the exact actor marker.
  await sql`SELECT set_config('tower.explicit_member_enrollment', ${`${input.workspaceId}:${actor.id}`}, true)`;
  const inserted = await sql`
    INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
    VALUES (${input.workspaceId}, ${actor.id}, 'member', ${input.createdByActorId})
    ON CONFLICT (workspace_id, actor_id) DO NOTHING
    RETURNING actor_id
  `;
  // Hold membership against deletion; do not update its existing role or attribution.
  await sql`
    SELECT actor_id FROM flightdeck_pg_workspace_memberships
    WHERE workspace_id = ${input.workspaceId} AND actor_id = ${actor.id} FOR KEY SHARE
  `;
  const added = await sql<FlightDeckPgGroupMemberRow[]>`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    VALUES (${input.workspaceId}, ${input.groupId}, ${actor.id}, ${input.createdByActorId})
    ON CONFLICT (workspace_id, group_id, actor_id) DO NOTHING
    RETURNING *
  `;
  const [membership] = added.length ? added : await sql<FlightDeckPgGroupMemberRow[]>`
    SELECT * FROM flightdeck_pg_group_memberships
    WHERE workspace_id = ${input.workspaceId} AND group_id = ${input.groupId} AND actor_id = ${actor.id}
  `;
  await reconcileFlightDeckPgDmDefaults(sql, input.workspaceId);
  return { actor, membership, workspaceMemberCreated: inserted.length > 0, groupMemberCreated: added.length > 0 };
}

/** Directory-safe invalidation: no workspace role, private group id, or group roster in the payload. */
export async function createFlightDeckPgEnrollmentOutbox(input: {
  workspaceId: string; actorId: string; changedActorId: string;
}, sql: DbClient) {
  await sql`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id, actor_id, event_type, entity_type, entity_id, operation, payload
    ) VALUES (
      ${input.workspaceId}, ${input.actorId}, 'workspace.membership.changed', 'actor',
      ${input.changedActorId}, 'updated', ${sql.json({ actor_id: input.changedActorId })}
    )
  `;
}
