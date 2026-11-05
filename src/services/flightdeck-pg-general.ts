import type { FlightDeckPgGeneralPolicy } from '../types';
import { getDb } from '../db';
import { MembershipAdminError, requireMembershipOwner } from './flightdeck-pg-membership-admin';
import { authorizeFlightDeckPgOperation } from './flightdeck-pg-authorization';
import { createFlightDeckPgScope, createFlightDeckPgChannel, createFlightDeckPgChannelGrants,
  flightDeckPgContributePermissions, flightDeckPgManagePermissions,
  type FlightDeckPgScopeRow, type FlightDeckPgChannelRow } from './flightdeck-pg-api';

/** Explicit owner opt-in. Identity is persisted independently of mutable labels. */
export async function ensureWorkspaceGeneral(workspaceId: string, requesterNpub: string) {
  return getDb().begin(async tx => {
    const sql = tx as unknown as ReturnType<typeof getDb>;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ':canonical-general'},0))`;
    await sql`SELECT id FROM flightdeck_pg_workspaces WHERE id=${workspaceId} FOR UPDATE`;
    const {workspace,requester} = await requireMembershipOwner(workspaceId,requesterNpub,sql);
    await sql`SELECT actor_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId} AND actor_id=${requester.id} FOR KEY SHARE`;
    const decision = await authorizeFlightDeckPgOperation({actorNpub:requesterNpub,appNpub:workspace.app_npub,
      workspaceId,permission:'workspace.manage',resource:{type:'workspace'}},sql);
    if (!decision.allowed) throw new MembershipAdminError(403,'workspace_manage_required');
    const [canonical] = await sql`SELECT * FROM flightdeck_pg_workspace_general WHERE workspace_id=${workspaceId}`;
    let scope: FlightDeckPgScopeRow;
    let channel: FlightDeckPgChannelRow;
    let groupId: string;
    if (canonical) {
      const [s] = await sql<FlightDeckPgScopeRow[]>`SELECT * FROM flightdeck_pg_scopes WHERE workspace_id=${workspaceId} AND id=${canonical.scope_id} FOR UPDATE`;
      const [c] = await sql<FlightDeckPgChannelRow[]>`SELECT * FROM flightdeck_pg_channels WHERE workspace_id=${workspaceId} AND id=${canonical.channel_id} FOR UPDATE`;
      if (!s || !c || s.archived_at || c.archived_at || c.scope_id !== s.id || c.kind !== 'channel') {
        throw new MembershipAdminError(409,'general_resource_unavailable');
      }
      scope=s; channel=c; groupId=canonical.group_id;
    } else {
      const [group] = await sql`SELECT id FROM flightdeck_pg_groups WHERE workspace_id=${workspaceId} AND name='Workspace'`;
      if (!group) throw new MembershipAdminError(409,'workspace_group_required');
      groupId=group.id;
      // Never adopt similarly named user resources or expose their private content.
      const names = new Set((await sql`SELECT name FROM flightdeck_pg_scopes WHERE workspace_id=${workspaceId}`).map(r=>r.name));
      let scopeName='General';
      for(let n=2;names.has(scopeName);n++) scopeName=`General (${n})`;
      scope=await createFlightDeckPgScope({workspaceId,name:scopeName,kind:'custom',createdByActorId:requester.id},sql);
      channel=await createFlightDeckPgChannel({workspaceId,scopeId:scope.id,name:'General',kind:'channel',createdByActorId:requester.id},sql);
      await sql`INSERT INTO flightdeck_pg_workspace_general(workspace_id,scope_id,channel_id,group_id) VALUES(${workspaceId},${scope.id},${channel.id},${groupId})`;
      await sql`UPDATE flightdeck_pg_scopes SET default_channel_id=${channel.id} WHERE id=${scope.id}`;
      scope.default_channel_id=channel.id;
    }
    // Repair the existing all-member group without touching any private grants.
    await sql`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id,created_by_actor_id)
      SELECT workspace_id,${groupId},actor_id,${requester.id} FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId}
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,resource_scope_id,permission,created_by_actor_id)
      VALUES(${workspaceId},'group',${groupId},'scope',${scope.id},'scope.read',${requester.id}) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission,created_by_actor_id)
      VALUES(${workspaceId},'actor',${requester.id},'scope',${scope.id},'scope.manage',${requester.id}) ON CONFLICT DO NOTHING`;
    for (const bundle of [
      {principalType:'group' as const,principalId:groupId,permissions:flightDeckPgContributePermissions},
      {principalType:'actor' as const,principalId:requester.id,permissions:flightDeckPgManagePermissions},
    ]) {
      const active = new Set((await sql`SELECT permission FROM flightdeck_pg_permission_grants
        WHERE workspace_id=${workspaceId} AND resource_channel_id=${channel.id} AND revoked_at IS NULL
        AND principal_type=${bundle.principalType}
        AND (principal_actor_id=${bundle.principalId} OR principal_group_id=${bundle.principalId})`).map(r=>r.permission));
      await createFlightDeckPgChannelGrants({workspaceId,channel,...bundle,
        permissions:bundle.permissions.filter(p=>!active.has(p)),createdByActorId:requester.id},sql);
    }
    if (!canonical) await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,actor_id,action,resource_type,resource_id)
      VALUES(${workspaceId},${requester.id},'workspace_general.ensure','channel',${channel.id})`;
    const policy: FlightDeckPgGeneralPolicy = {version:1,kind:'all_workspace_members',group_id:groupId,access_level:'contribute'};
    return {scope,channel,reused:Boolean(canonical),policy};
  });
}
