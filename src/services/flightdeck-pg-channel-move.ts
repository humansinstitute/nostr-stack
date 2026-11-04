import { createHash } from 'node:crypto';
import { getDb } from '../db';
import type { FlightDeckPgChannelMovePreview, FlightDeckPgChannelMoveGrant, FlightDeckPgChannelMoveAccessActor } from '../types';
import { authorizeFlightDeckPgOperation, getEffectiveFlightDeckPgGroupIds, resolveFlightDeckPgActorByNpub } from './flightdeck-pg-authorization';
import { serializeFlightDeckPgChannel, createFlightDeckPgChannelOutboxEvent, type FlightDeckPgChannelRow } from './flightdeck-pg-api';

type Db = ReturnType<typeof getDb>;
export class ChannelMoveError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message: string) { super(message); }
}
export type ChannelMoveInput = { workspaceId: string; appNpub: string; actorNpub: string; channelId: string; destinationScopeId: string; confirmationToken?: string; mutationId?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code: string, message: string): never => { throw new ChannelMoveError(409, code, message); };

/** Both endpoints use the same locking/authorization boundary. Scope locks match
 * create/reorder; channel FOR UPDATE conflicts with immediate child FK checks.
 * Old-location writes either finish before relocation or fail their FK safely.
 */
export async function runFlightDeckPgChannelMove(input: ChannelMoveInput, move = false, db: Db = getDb()) {
  for (const [key, value] of Object.entries({ workspace_id: input.workspaceId, channel_id: input.channelId, destination_scope_id: input.destinationScopeId,
    ...(move ? { confirmation_token: input.confirmationToken, mutation_id: input.mutationId } : {}) })) {
    if (typeof value !== 'string' || !uuid.test(value)) throw new ChannelMoveError(400, 'validation_error', `${key} must be a UUID`);
  }
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    // Freeze access state through permission checks, preview fingerprint and commit.
    // SHARE also covers absent grants/memberships; row locks alone cannot do that.
    await sql.unsafe(`LOCK TABLE flightdeck_pg_permission_grants,flightdeck_pg_group_memberships,
      flightdeck_pg_group_edges,flightdeck_pg_workspace_memberships,flightdeck_pg_actors,
      flightdeck_pg_groups,flightdeck_pg_permission_definitions IN SHARE ROW EXCLUSIVE MODE`);
    const actor = await resolveFlightDeckPgActorByNpub(input.actorNpub, sql);
    if (!actor) throw new ChannelMoveError(403, 'permission_denied', 'Workspace actor required');
    // Serialize mutation IDs even if two competing requests target different channels.
    if (move) await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.workspaceId + ':' + input.mutationId},0))`;
    const [receipt] = move ? await sql`SELECT * FROM flightdeck_pg_channel_move_receipts WHERE workspace_id=${input.workspaceId} AND mutation_id=${input.mutationId!}` : [];
    if (receipt && (receipt.actor_id !== actor.id || receipt.channel_id !== input.channelId || receipt.destination_scope_id !== input.destinationScopeId || receipt.confirmation_token !== input.confirmationToken)) fail('mutation_conflict', 'mutation_id was already used for a different move request');
    const [initial] = await sql`SELECT *,xmin::text AS move_revision FROM flightdeck_pg_channels WHERE workspace_id=${input.workspaceId} AND id=${input.channelId}`;
    if (!initial) throw new ChannelMoveError(404, 'channel_not_found', 'Channel not found in this workspace');
    const scopes = await sql`SELECT *,xmin::text AS move_revision FROM flightdeck_pg_scopes WHERE workspace_id=${input.workspaceId} AND id IN (${initial.scope_id},${input.destinationScopeId}) ORDER BY id FOR UPDATE`;
    const source = scopes.find(s => s.id === initial.scope_id), destination = scopes.find(s => s.id === input.destinationScopeId);
    if (!destination || !source) throw new ChannelMoveError(404, 'scope_not_found', 'Destination scope not found in this workspace');
    const [channel] = await sql`SELECT *,xmin::text AS move_revision FROM flightdeck_pg_channels WHERE workspace_id=${input.workspaceId} AND id=${input.channelId} FOR UPDATE`;
    if (channel.scope_id !== initial.scope_id) fail('stale_preview', 'Channel location changed; preview again');
    // Retry still requires current authority. Receipt is an exact historical result,
    // not permission to see a channel after access has been revoked.
    for (const resource of [{type:'channel' as const,channelId:channel.id}, {type:'scope' as const,scopeId:source.id}, {type:'scope' as const,scopeId:destination.id}]) {
      const permission = resource.type === 'channel' ? 'channel.manage' : 'scope.manage';
      const decision = await authorizeFlightDeckPgOperation({...input,permission,resource},sql,{archivedLifecycle:true});
      if (!decision.allowed) throw new ChannelMoveError(403,'permission_denied',`${permission} required on source channel and both scopes`);
    }
    if (channel.archived_at) fail('unsupported_channel_move','Archived channels cannot be moved');
    const grantRead = await authorizeFlightDeckPgOperation({...input,permission:'channel.grants.read',resource:{type:'channel',channelId:channel.id}},sql);
    if (!grantRead.allowed) throw new ChannelMoveError(403,'permission_denied','channel.grants.read required to review access changes');
    if (receipt) {
      // Also require authority on the original source, which may differ on retry.
      const savedSource = receipt.result.move.source_scope_id;
      const decision = await authorizeFlightDeckPgOperation({...input,permission:'scope.manage',resource:{type:'scope',scopeId:savedSource}},sql);
      if (!decision.allowed) throw new ChannelMoveError(403,'permission_denied','scope.manage required on original source');
      if (channel.scope_id !== receipt.destination_scope_id) fail('move_superseded','Channel has moved again; reload its current location');
      return {...receipt.result,channel:serializeFlightDeckPgChannel(channel as FlightDeckPgChannelRow)};
    }
    if (channel.archived_at || source.archived_at || destination.archived_at || channel.kind !== 'channel' || source.kind === 'dm' || destination.kind === 'dm'
      || source.default_channel_id === channel.id || destination.default_channel_id === channel.id || channel.participant_npubs?.length || String(channel.metadata?.system_key || '')) fail('unsupported_channel_move','Archived, default, DM and system channels or special scopes cannot be moved');
    if (source.id === destination.id) fail('same_destination','Channel already belongs to this scope');
    const [duplicate] = await sql`SELECT id FROM flightdeck_pg_channels WHERE workspace_id=${input.workspaceId} AND scope_id=${destination.id} AND name=${channel.name}`;
    if (duplicate) fail('duplicate_channel','A channel with this name already exists in the destination scope');
    const grants = await sql`SELECT * FROM flightdeck_pg_permission_grants WHERE workspace_id=${input.workspaceId} ORDER BY id`;
    const members = await sql`SELECT a.*,m.role AS membership_role FROM flightdeck_pg_workspace_memberships m JOIN flightdeck_pg_actors a ON a.id=m.actor_id WHERE m.workspace_id=${input.workspaceId} ORDER BY a.id`;
    const groupMemberships = await sql`SELECT * FROM flightdeck_pg_group_memberships WHERE workspace_id=${input.workspaceId} ORDER BY group_id,actor_id`;
    const edges = await sql`SELECT * FROM flightdeck_pg_group_edges WHERE workspace_id=${input.workspaceId} ORDER BY parent_group_id,child_group_id`;
    const fingerprint = createHash('sha256').update(JSON.stringify({channel,source,destination,grants,members,groupMemberships,edges,requester:actor.id})).digest('hex');
    if (!move) {
      const active = grants.filter(g => !g.revoked_at);
      const direct = active.filter(g => g.resource_type === 'channel' && g.resource_channel_id === channel.id);
      const access = {retained:[] as FlightDeckPgChannelMoveAccessActor[],source:[] as FlightDeckPgChannelMoveAccessActor[],destination:[] as FlightDeckPgChannelMoveAccessActor[]};
      for (const m of members) {
        const groups = await getEffectiveFlightDeckPgGroupIds(input.workspaceId,m.id,sql);
        const mine = (g: any) => g.principal_actor_id === m.id || groups.includes(g.principal_group_id);
        for (const [key, rows] of [['retained',direct],['source',active.filter(g => g.resource_type==='scope' && g.resource_scope_id===source.id)],['destination',active.filter(g => g.resource_type==='scope' && g.resource_scope_id===destination.id)]] as const) {
          const permissions = [...new Set(rows.filter(mine).map(g => String(g.permission)))].sort();
          if (permissions.length) access[key].push({actor_id:m.id,npub:m.npub,label:m.display_name || m.npub,permissions});
        }
      }
      const [token] = await sql`INSERT INTO flightdeck_pg_channel_move_previews(workspace_id,channel_id,actor_id,source_scope_id,destination_scope_id,fingerprint)
        VALUES(${input.workspaceId},${channel.id},${actor.id},${source.id},${destination.id},${fingerprint}) RETURNING token`;
      const preview: FlightDeckPgChannelMovePreview = {channel_id:channel.id,source_scope_id:source.id,destination_scope_id:destination.id,confirmation_token:token.token,
        access_changes:{gained:[],lost:[],retained:access.retained,direct_grants_preserved:true,direct_grant_count:direct.length,
          unchanged_direct_grants:direct.map(g => ({id:g.id,principal_type:g.principal_type,principal_id:g.principal_actor_id || g.principal_group_id,permission:g.permission}) as FlightDeckPgChannelMoveGrant),
          source_scope_access:access.source,destination_scope_access:access.destination},
        warnings:['Scope grants control scope discovery and management; they do not grant inherited channel content access. Explicit channel grants, including group grants, remain unchanged.','The channel will appear under the destination scope. Existing links and content IDs remain unchanged.']};
      return {preview};
    }
    const [preview] = await sql`SELECT * FROM flightdeck_pg_channel_move_previews WHERE token=${input.confirmationToken!} AND workspace_id=${input.workspaceId} AND channel_id=${channel.id} AND actor_id=${actor.id} AND destination_scope_id=${destination.id} AND expires_at>now()`;
    if (!preview || preview.fingerprint !== fingerprint) fail('stale_preview','Channel or access changed, or preview expired; preview again before confirming');
    await sql.unsafe('SET CONSTRAINTS ALL DEFERRED');
    const [position] = await sql`SELECT COALESCE(max(position),0)+1 AS next FROM flightdeck_pg_channels WHERE workspace_id=${input.workspaceId} AND scope_id=${destination.id} AND archived_at IS NULL`;
    const [moved] = await sql`UPDATE flightdeck_pg_channels SET scope_id=${destination.id},position=${position.next},updated_at=clock_timestamp() WHERE workspace_id=${input.workspaceId} AND id=${channel.id} RETURNING *`;
    // Every typed channel-bound family has the same denormalized location. Use
    // catalog identifiers (never request strings) so newly installed families are
    // included. History payloads/content stay byte-for-byte; only location moves.
    const tables = await sql`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND starts_with(table_name,'flightdeck_pg_') AND column_name IN ('workspace_id','channel_id','scope_id') GROUP BY table_name HAVING count(*)=3 ORDER BY table_name`;
    for (const {table_name} of tables) {
      if (table_name === 'flightdeck_pg_channel_move_previews') continue;
      await sql`UPDATE ${sql(table_name)} SET scope_id=${destination.id} WHERE workspace_id=${input.workspaceId} AND channel_id=${channel.id} AND scope_id IS DISTINCT FROM ${destination.id}::uuid`;
    }
    await sql`UPDATE flightdeck_pg_permission_grants SET resource_scope_id=${destination.id} WHERE workspace_id=${input.workspaceId} AND resource_type='channel' AND resource_channel_id=${channel.id} AND resource_scope_id IS NOT NULL`;
    // Validate all relationships before writing receipts/events. No partially
    // relocated channel can be committed, even when an unknown family is added.
    await sql.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
    const movement = {source_scope_id:source.id,destination_scope_id:destination.id,mutation_id:input.mutationId!};
    const [audit] = await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,actor_id,action,resource_type,resource_id,metadata)
      VALUES(${input.workspaceId},${actor.id},'channel.move','channel',${channel.id},${sql.json(movement)}) RETURNING id`;
    const auditId = audit.id;
    // Direct channel readers discover their containing scope through channel ACL.
    // Reproject both scope rows, keeping retained-cache semantics for old access.
    await sql`SELECT flightdeck_pg_record_emit(${input.workspaceId},'scope',to_jsonb(s),'upsert') FROM flightdeck_pg_scopes s
      WHERE workspace_id=${input.workspaceId} AND id IN (${source.id},${destination.id}) ORDER BY id`;
    await sql`UPDATE flightdeck_pg_record_clock SET access_revision=access_revision+1 WHERE workspace_id=${input.workspaceId}`;
    const outbox = await createFlightDeckPgChannelOutboxEvent({workspaceId:input.workspaceId,scopeId:destination.id,channelId:channel.id,actorId:actor.id,eventType:'channel.moved',entityId:channel.id,operation:'updated',payload:{...movement,channel_id:channel.id}},sql);
    // Scope-only readers get an invalidation with no channel ID or content.
    await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${input.workspaceId},${source.id},${actor.id},'scope.channels_changed','scope',${source.id},'updated',${sql.json({scope_id:source.id,invalidate:true})})`;
    const result = {channel:serializeFlightDeckPgChannel(moved as FlightDeckPgChannelRow),move:movement,audit:{event_id:auditId,operation:'channel.move',actor_npub:input.actorNpub},outbox};
    await sql`INSERT INTO flightdeck_pg_channel_move_receipts(workspace_id,mutation_id,actor_id,channel_id,destination_scope_id,confirmation_token,result)
      VALUES(${input.workspaceId},${input.mutationId!},${actor.id},${channel.id},${destination.id},${input.confirmationToken!},${sql.json(result as any)})`;
    return result;
  });
}
