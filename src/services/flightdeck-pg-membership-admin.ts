import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { authorizeFlightDeckPgOperation, getEffectiveFlightDeckPgGroupIds, resolveFlightDeckPgActorByNpub, resolveFlightDeckPgWorkspace } from './flightdeck-pg-authorization';
import { flightDeckPgPermissions } from '../types';

type DbClient = ReturnType<typeof getDb>;
export class MembershipAdminError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message = code) { super(message); }
}
export async function requireMembershipOwner(workspaceId: string, requesterNpub: string, sql: DbClient) {
  const workspace = await resolveFlightDeckPgWorkspace(workspaceId, sql);
  const requester = await resolveFlightDeckPgActorByNpub(requesterNpub, sql);
  const [member] = requester ? await sql`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId} AND actor_id=${requester.id}` : [];
  if (!workspace || !requester || !member || workspace.workspace_owner_npub !== requesterNpub) {
    throw new MembershipAdminError(403, 'workspace_owner_required');
  }
  return { workspace, requester };
}
async function memberState(workspaceId: string, actorId: string, sql: DbClient) {
  const [actor] = await sql`SELECT id,npub,kind,display_name FROM flightdeck_pg_actors WHERE id=${actorId}`;
  const [membership] = await sql`SELECT workspace_id,actor_id,role,created_at FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId} AND actor_id=${actorId}`;
  if (!actor || !membership) throw new MembershipAdminError(404, 'workspace_member_not_found');
  const groups = await sql`SELECT g.id,g.name,g.kind,m.created_at FROM flightdeck_pg_group_memberships m JOIN flightdeck_pg_groups g ON g.workspace_id=m.workspace_id AND g.id=m.group_id WHERE m.workspace_id=${workspaceId} AND m.actor_id=${actorId} ORDER BY g.id`;
  const direct_grants = await sql`SELECT id,permission,resource_type,resource_scope_id,resource_channel_id,workspace_role FROM flightdeck_pg_permission_grants WHERE workspace_id=${workspaceId} AND principal_actor_id=${actorId} AND revoked_at IS NULL ORDER BY id`;
  const [role] = await sql`SELECT created_at FROM flightdeck_pg_workspace_agent_managers WHERE workspace_id=${workspaceId} AND actor_id=${actorId}`;
  const subscriptions = await sql`SELECT manager_actor_id,agent_actor_id FROM flightdeck_pg_event_subscription_agents WHERE workspace_id=${workspaceId} AND (manager_actor_id=${actorId} OR agent_actor_id=${actorId}) ORDER BY manager_actor_id,agent_actor_id`;
  const effectiveGroupIds = await getEffectiveFlightDeckPgGroupIds(workspaceId,actorId,sql);
  const inherited_grants = effectiveGroupIds.length ? await sql`SELECT id,permission,resource_type,resource_scope_id,resource_channel_id,principal_group_id FROM flightdeck_pg_permission_grants WHERE workspace_id=${workspaceId} AND principal_group_id IN ${sql(effectiveGroupIds)} AND revoked_at IS NULL ORDER BY id` : [];
  return { actor, membership, groups, direct_grants, inherited_grants, effective_group_ids:effectiveGroupIds, agent_manager: Boolean(role), subscriptions };
}
const stateHash = (state: unknown) => createHash('sha256').update(JSON.stringify(state)).digest('hex');
function blockedReason(state: Awaited<ReturnType<typeof memberState>>, requesterId: string, ownerNpub: string) {
  if (state.actor.id === requesterId) return 'cannot_remove_self';
  if (state.membership.role === 'owner' || state.actor.npub === ownerNpub) return 'cannot_remove_owner';
  return null;
}
export async function previewWorkspaceMemberRemoval(workspaceId: string, actorId: string, requesterNpub: string, sql: DbClient = getDb()) {
  const { workspace, requester } = await requireMembershipOwner(workspaceId, requesterNpub, sql);
  const state = await memberState(workspaceId, actorId, sql);
  const blocked_reason = blockedReason(state, requester.id, workspace.workspace_owner_npub);
  const [preview] = blocked_reason ? [] : await sql`INSERT INTO flightdeck_pg_member_removal_previews(workspace_id,actor_id,requester_actor_id,state_hash) VALUES(${workspaceId},${actorId},${requester.id},${stateHash(state)}) RETURNING token`;
  return { ...state, blocked_reason, confirmation_token: preview?.token ?? null, consequences: [
    'Revoke this exact identity’s workspace membership, direct grants, group access, agent-manager role and subscription authority.',
    'Keep historical messages, documents, authorship and audit records linked to the same actor and npub. No identity or signing key is deleted.',
    'Other workspaces are unchanged. Re-adding requires explicit enrollment and does not restore old grants, groups or roles.',
    'Existing task assignments and agent installation records remain historical references; they do not grant workspace access.',
    'Previously downloaded data cannot be recalled. Private signed Tower downloads are denied after removal; pre-release object-store URLs must expire before retirement is considered fully effective.',
  ] };
}
async function lockMembershipAdministration(sql: DbClient) {
  // Serialize grant/group/role/enrollment changes with confirmation and deletion.
  await sql.unsafe('LOCK TABLE flightdeck_pg_workspaces,flightdeck_pg_workspace_memberships,flightdeck_pg_group_memberships,flightdeck_pg_group_edges,flightdeck_pg_groups,flightdeck_pg_scopes,flightdeck_pg_channels,flightdeck_pg_permission_grants,flightdeck_pg_workspace_agent_managers,flightdeck_pg_event_subscription_agents IN SHARE ROW EXCLUSIVE MODE');
}
async function audit(sql: DbClient, workspaceId: string, requesterId: string, actorId: string, action: string, metadata: unknown) {
  const [event] = await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,actor_id,action,resource_type,resource_id,metadata) VALUES(${workspaceId},${requesterId},${action},'actor',${actorId},${sql.json(metadata as any)}) RETURNING id`;
  await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,actor_id,event_type,entity_type,entity_id,operation,payload) VALUES(${workspaceId},${requesterId},'workspace.membership.changed','actor',${actorId},'updated',${sql.json({actor_id:actorId})})`;
  return { event_id: event.id, operation: action };
}
export async function removeWorkspaceMember(workspaceId: string, actorId: string, requesterNpub: string, body: {confirmation_token?: unknown; confirm_npub?: unknown}) {
  return getDb().begin(async tx => {
    const sql = tx as unknown as DbClient;
    await lockMembershipAdministration(sql);
    await sql`SELECT id FROM flightdeck_pg_actors WHERE id=${actorId} FOR UPDATE`;
    const { workspace, requester } = await requireMembershipOwner(workspaceId, requesterNpub, sql);
    const state = await memberState(workspaceId, actorId, sql);
    const blocked = blockedReason(state, requester.id, workspace.workspace_owner_npub);
    if (blocked) throw new MembershipAdminError(403, blocked);
    if (body.confirm_npub !== state.actor.npub) throw new MembershipAdminError(400, 'exact_npub_confirmation_required');
    if (typeof body.confirmation_token !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.confirmation_token)) throw new MembershipAdminError(400,'removal_preview_required');
    const [preview] = await sql`DELETE FROM flightdeck_pg_member_removal_previews WHERE token=${body.confirmation_token} AND workspace_id=${workspaceId} AND actor_id=${actorId} AND requester_actor_id=${requester.id} AND expires_at>NOW() RETURNING state_hash`;
    if (!preview || preview.state_hash !== stateHash(state)) throw new MembershipAdminError(409,'removal_preview_stale');
    await sql`INSERT INTO flightdeck_pg_workspace_member_removals(workspace_id,actor_id,removed_by_actor_id) VALUES(${workspaceId},${actorId},${requester.id}) ON CONFLICT(workspace_id,actor_id) DO UPDATE SET removed_at=NOW(),removed_by_actor_id=EXCLUDED.removed_by_actor_id`;
    // Historical publication records remain; their opt-in public authority ends.
    await sql`UPDATE flightdeck_pg_blossom_publications SET revoked_at=NOW() WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND revoked_at IS NULL`;
    await sql`UPDATE flightdeck_pg_blossom_message_publications SET revoked_at=NOW() WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND revoked_at IS NULL`;
    const event = await audit(sql,workspaceId,requester.id,actorId,'workspace_member.remove',state);
    await sql`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId} AND actor_id=${actorId}`;
    return { removed: true, actor: state.actor, audit: event };
  });
}
export async function setWorkspaceAgentManager(workspaceId: string, actorId: string, requesterNpub: string, body: {enabled?: unknown; confirm_npub?: unknown}) {
  return getDb().begin(async tx => {
    const sql = tx as unknown as DbClient;
    await lockMembershipAdministration(sql);
    await sql`SELECT id FROM flightdeck_pg_actors WHERE id=${actorId} FOR UPDATE`;
    const { requester } = await requireMembershipOwner(workspaceId,requesterNpub,sql);
    const state = await memberState(workspaceId,actorId,sql);
    if (typeof body.enabled !== 'boolean') throw new MembershipAdminError(400,'enabled_boolean_required');
    if (body.confirm_npub !== state.actor.npub) throw new MembershipAdminError(400,'exact_npub_confirmation_required');
    if (!['agent','human'].includes(state.actor.kind)) throw new MembershipAdminError(400,'person_identity_required');
    if (body.enabled) {
      await sql`INSERT INTO flightdeck_pg_workspace_agent_managers(workspace_id,actor_id,created_by_actor_id) VALUES(${workspaceId},${actorId},${requester.id}) ON CONFLICT DO NOTHING`;
      await sql`SELECT flightdeck_pg_agent_manager_grants(${workspaceId}::uuid,${actorId}::uuid,${requester.id}::uuid)`;
    } else {
      await sql`DELETE FROM flightdeck_pg_workspace_agent_managers WHERE workspace_id=${workspaceId} AND actor_id=${actorId}`;
      await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NOW() WHERE workspace_id=${workspaceId} AND principal_actor_id=${actorId} AND workspace_role='agent-manager' AND revoked_at IS NULL`;
    }
    return { agent_manager: body.enabled, actor: state.actor, audit: await audit(sql,workspaceId,requester.id,actorId,'workspace_agent_manager.set',{enabled:body.enabled,npub:state.actor.npub}) };
  });
}
export async function inspectWorkspaceMemberAccess(workspaceId: string, actorId: string, requesterNpub: string, sql: DbClient = getDb()) {
  const workspace = await resolveFlightDeckPgWorkspace(workspaceId,sql);
  const requester = await resolveFlightDeckPgActorByNpub(requesterNpub,sql);
  if (!workspace || !requester) throw new MembershipAdminError(404,'workspace_member_not_found');
  const management = await authorizeFlightDeckPgOperation({actorNpub:requesterNpub,appNpub:workspace.app_npub,workspaceId,permission:'workspace.manage',resource:{type:'workspace'}},sql);
  if (!management.allowed) throw new MembershipAdminError(403,'workspace_manage_required');
  const state = await memberState(workspaceId,actorId,sql);
  const definitions = await sql`SELECT permission,resource_type FROM flightdeck_pg_permission_definitions ORDER BY permission`;
  const permissions = async (resource: any) => {
    const result = [];
    for (const d of definitions.filter(d=>d.resource_type===resource.type && (flightDeckPgPermissions as readonly string[]).includes(d.permission))) {
      const decision = await authorizeFlightDeckPgOperation({actorNpub:state.actor.npub,appNpub:workspace.app_npub,workspaceId,permission:d.permission,resource},sql);
      result.push({permission:d.permission,allowed:decision.allowed});
    }
    return result;
  };
  const scopes = await sql`SELECT id,name FROM flightdeck_pg_scopes WHERE workspace_id=${workspaceId} AND archived_at IS NULL ORDER BY id`;
  const channels = await sql`SELECT id,name,scope_id FROM flightdeck_pg_channels WHERE workspace_id=${workspaceId} AND archived_at IS NULL ORDER BY id`;
  const coverage = { workspace: await permissions({type:'workspace'}), scopes: [] as any[], channels: [] as any[] };
  for (const s of scopes) coverage.scopes.push({...s,permissions:await permissions({type:'scope',scopeId:s.id})});
  for (const c of channels) coverage.channels.push({...c,permissions:await permissions({type:'channel',channelId:c.id})});
  return {actor:state.actor,membership:state.membership,agent_manager:state.agent_manager,can_administer:workspace.workspace_owner_npub===requesterNpub,coverage};
}
