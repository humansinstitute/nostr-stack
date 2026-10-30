import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { nip19 } from 'nostr-tools';
import { getDb } from '../db';
import { getTowerBuildInfo } from '../build-info';
import { flightDeckPgPermissions, type PermissionDiagnosticAuthorization, type PermissionDiagnosticRequest } from '../types';
import { authorizeFlightDeckPgOperation, resolveFlightDeckPgActorByNpub, resolveFlightDeckPgWorkspace, getFlightDeckPgWorkspaceMembership } from './flightdeck-pg-authorization';

type Db = ReturnType<typeof getDb>;
export const diagnosticUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const casePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
export class PermissionDiagnosticError extends Error {
  constructor(public status: 400 | 403 | 404, public code: string) { super(code); }
}
export function diagnosticNpub(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 63 || value !== value.toLowerCase()) return false;
  try { return nip19.decode(value).type === 'npub'; } catch { return false; }
}
const fields = ['case_id','signer_npub','workspace_id','channel_id','target_actor_npub','issued_at','expires_at','tower_service_npub','app_npub','scope_id'];
/** Invalid configuration disables ALL support delegations. Normal ACL authority is unaffected. */
export function parseDiagnosticAuthorizations(raw: unknown): PermissionDiagnosticAuthorization[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(k => !['version','authorizations'].includes(k)) || value.version !== 1 || !Array.isArray(value.authorizations) || value.authorizations.length > 20) return [];
  for (const item of value.authorizations) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== fields.length || Object.keys(item).some(k => !fields.includes(k))) return [];
    if (typeof item.case_id !== 'string' || !casePattern.test(item.case_id) || !diagnosticNpub(item.signer_npub) || !diagnosticNpub(item.target_actor_npub)
      || !diagnosticNpub(item.tower_service_npub) || !diagnosticNpub(item.app_npub) || typeof item.scope_id !== 'string' || !diagnosticUuid.test(item.scope_id)
      || typeof item.workspace_id !== 'string' || !diagnosticUuid.test(item.workspace_id) || typeof item.channel_id !== 'string' || !diagnosticUuid.test(item.channel_id)) return [];
    const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
    if (!date(item.issued_at) || !date(item.expires_at)) return [];
    const lifetime = Date.parse(item.expires_at) - Date.parse(item.issued_at);
    if (lifetime <= 0 || lifetime > 24 * 60 * 60 * 1000) return [];
  }
  return value.authorizations as PermissionDiagnosticAuthorization[];
}
function operatorAuthorizations() {
  try {
    // Fixed deployment-owned path. Never accept a path or authorization from HTTP input.
    const path = join(process.cwd(), 'config/permission-diagnostics.json');
    if (statSync(path).size > 32768) return [];
    const raw = readFileSync(path);
    if (raw.byteLength > 32768) return [];
    return parseDiagnosticAuthorizations(JSON.parse(raw.toString('utf8')));
  } catch { return []; }
}
export function matchDiagnosticAuthorization(entries: PermissionDiagnosticAuthorization[], input: PermissionDiagnosticRequest, now = Date.now()) {
  return entries.find(a => a.case_id === input.caseId && a.signer_npub === input.signerNpub && a.workspace_id === input.workspaceId
    && a.channel_id === input.channelId && a.target_actor_npub === input.targetNpub && a.app_npub === input.appNpub && Date.parse(a.issued_at) <= now && now < Date.parse(a.expires_at));
}
export function validateDiagnosticRequest(input: PermissionDiagnosticRequest) {
  if (!diagnosticUuid.test(input.workspaceId) || !diagnosticUuid.test(input.channelId) || !diagnosticNpub(input.targetNpub)
    || !diagnosticNpub(input.signerNpub) || !diagnosticNpub(input.userNpub) || !casePattern.test(input.caseId) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || !Number.isInteger(input.offset) || input.offset < 0 || input.offset > 10000) throw new PermissionDiagnosticError(400, 'invalid_diagnostic_request');
}
export function sanitizeDiagnosticAudit(raw: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  if (typeof raw.principal_type === 'string' && ['actor','group'].includes(raw.principal_type)) result.principal_type = raw.principal_type;
  if (typeof raw.principal_id === 'string' && diagnosticUuid.test(raw.principal_id)) result.principal_id = raw.principal_id;
  if (typeof raw.access_level === 'string' && ['view','contribute','manage','custom'].includes(raw.access_level)) result.access_level = raw.access_level;
  if (typeof raw.role === 'string' && ['context_editor','scope_manager'].includes(raw.role)) result.role = raw.role;
  if (Array.isArray(raw.permissions)) {
    result.permissions = raw.permissions.slice(0, 64).filter(p => typeof p === 'string' && (flightDeckPgPermissions as readonly string[]).includes(p));
    result.permissions_truncated = raw.permissions.length > 64 || raw.permissions_truncated === true;
  }
  return result;
}
function page<T>(rows: T[], input: PermissionDiagnosticRequest) {
  const truncated = rows.length > input.limit;
  return { items: rows.slice(0, input.limit), limit: input.limit, offset: input.offset, truncated, next_offset: truncated ? input.offset + input.limit : null };
}
/** Only application mutation is an audit receipt. No grant or authorization predicate is changed. */
export async function readPermissionDiagnostics(input: PermissionDiagnosticRequest, db: Db = getDb()) {
  validateDiagnosticRequest(input);
  const candidate = matchDiagnosticAuthorization(operatorAuthorizations(), input);
  return db.begin('isolation level repeatable read', async tx => {
    const sql = tx as unknown as Db;
    const workspace = await resolveFlightDeckPgWorkspace(input.workspaceId, sql);
    const signer = await resolveFlightDeckPgActorByNpub(input.userNpub, sql);
    if (!workspace || workspace.app_npub !== input.appNpub || !signer || !await getFlightDeckPgWorkspaceMembership(input.workspaceId, signer.id, sql)) throw new PermissionDiagnosticError(403, 'diagnostic_access_denied');
    const base = { workspaceId: input.workspaceId, appNpub: input.appNpub, actorNpub: input.userNpub };
    const reader = await authorizeFlightDeckPgOperation({...base,permission:'channel.grants.read',resource:{type:'channel',channelId:input.channelId}},sql);
    const eligibleSupport = candidate && candidate.tower_service_npub === workspace.tower_service_npub;
    if (!eligibleSupport && !reader.allowed) throw new PermissionDiagnosticError(403, 'diagnostic_access_denied');
    const [channel] = await sql`SELECT id,scope_id,archived_at FROM flightdeck_pg_channels WHERE workspace_id=${input.workspaceId} AND id=${input.channelId} AND archived_at IS NULL`;
    const support = eligibleSupport && channel && candidate.scope_id === channel.scope_id ? candidate : undefined;
    if (!support && !reader.allowed) throw new PermissionDiagnosticError(403, 'diagnostic_access_denied');
    const target = await resolveFlightDeckPgActorByNpub(input.targetNpub,sql);
    const membership = target && await getFlightDeckPgWorkspaceMembership(input.workspaceId,target.id,sql);
    if (!channel || !target || !membership) throw new PermissionDiagnosticError(404, 'diagnostic_target_not_found');
    // Recheck time after authorization/database work; never extend configured lifetime.
    if (support && !matchDiagnosticAuthorization([support], input)) throw new PermissionDiagnosticError(403, 'diagnostic_access_denied');
    const scopeManager = await authorizeFlightDeckPgOperation({...base,permission:'scope.manage',resource:{type:'scope',scopeId:channel.scope_id}},sql);
    const includeScope = !!support || scopeManager.allowed;
    const grants = await sql`SELECT g.id,g.resource_type,g.resource_scope_id,g.resource_channel_id,g.principal_type,g.principal_actor_id,g.principal_group_id,
      a.npub AS principal_actor_npub,g.permission,g.created_at,g.revoked_at,g.created_by_actor_id
      FROM flightdeck_pg_permission_grants g LEFT JOIN flightdeck_pg_actors a ON a.id=g.principal_actor_id
      WHERE g.workspace_id=${input.workspaceId} AND ((g.resource_type='channel' AND g.resource_channel_id=${input.channelId})
        OR (${includeScope} AND g.resource_type='scope' AND g.resource_scope_id=${channel.scope_id} AND g.resource_channel_id IS NULL))
      ORDER BY g.created_at,g.id LIMIT ${input.limit+1} OFFSET ${input.offset}`;
    const reachability = support ? await sql`WITH RECURSIVE effective(group_id) AS (
      SELECT group_id FROM flightdeck_pg_group_memberships WHERE workspace_id=${input.workspaceId} AND actor_id=${target.id}
      UNION SELECT e.parent_group_id FROM flightdeck_pg_group_edges e JOIN effective x ON x.group_id=e.child_group_id WHERE e.workspace_id=${input.workspaceId}
    ) SELECT DISTINCT g.principal_group_id AS group_id,EXISTS(SELECT 1 FROM effective x WHERE x.group_id=g.principal_group_id) AS target_reaches_group
      FROM flightdeck_pg_permission_grants g WHERE g.workspace_id=${input.workspaceId} AND g.principal_type='group' AND
      ((g.resource_type='channel' AND g.resource_channel_id=${input.channelId}) OR (${includeScope} AND g.resource_type='scope' AND g.resource_scope_id=${channel.scope_id} AND g.resource_channel_id IS NULL))
      ORDER BY g.principal_group_id LIMIT ${input.limit+1} OFFSET ${input.offset}` : [];
    const audit = await sql`SELECT id,actor_id,action,resource_type,resource_id,created_at,
      jsonb_build_object('principal_type',CASE WHEN metadata->>'principal_type' IN ('actor','group') THEN metadata->'principal_type' END,
        'principal_id',CASE WHEN jsonb_typeof(metadata->'principal_id')='string' AND length(metadata->>'principal_id')=36 THEN metadata->'principal_id' END,
        'access_level',CASE WHEN metadata->>'access_level' IN ('view','contribute','manage','custom') THEN metadata->'access_level' END,
        'role',CASE WHEN metadata->>'role' IN ('context_editor','scope_manager') THEN metadata->'role' END,
        'permissions',CASE WHEN jsonb_typeof(metadata->'permissions')='array' THEN (SELECT jsonb_agg(p.value ORDER BY p.ordinality) FROM jsonb_array_elements(metadata->'permissions') WITH ORDINALITY p(value,ordinality) WHERE p.ordinality<=64 AND jsonb_typeof(p.value)='string' AND length(p.value#>>'{}')<=64) END,
        'permissions_truncated',CASE WHEN jsonb_typeof(metadata->'permissions')='array' THEN jsonb_array_length(metadata->'permissions')>64 ELSE false END) AS changes
      FROM flightdeck_pg_audit_events WHERE workspace_id=${input.workspaceId} AND
      ((resource_type='channel' AND resource_id=${input.channelId} AND action IN ('channel_grant.create','channel_grant.update','channel_grant.revoke','channel_grant.delete'))
        OR (${includeScope} AND resource_type='scope' AND resource_id=${channel.scope_id} AND action IN ('scope_grant.create','scope_grant.revoke')))
      ORDER BY created_at DESC,id DESC LIMIT ${input.limit+1} OFFSET ${input.offset}`;
    // UNION terminates even for corrupt cyclic edges. Only target actor's effective chain, never rosters.
    const includePaths = !!support;
    const paths = includePaths ? await sql`WITH RECURSIVE effective(group_id) AS (
      SELECT group_id FROM flightdeck_pg_group_memberships WHERE workspace_id=${input.workspaceId} AND actor_id=${target.id}
      UNION SELECT e.parent_group_id FROM flightdeck_pg_group_edges e JOIN effective x ON x.group_id=e.child_group_id WHERE e.workspace_id=${input.workspaceId}
    ), relevant(group_id) AS (
      SELECT principal_group_id FROM flightdeck_pg_permission_grants WHERE workspace_id=${input.workspaceId} AND principal_type='group'
        AND ((resource_type='channel' AND resource_channel_id=${input.channelId}) OR (${includeScope} AND resource_type='scope' AND resource_scope_id=${channel.scope_id} AND resource_channel_id IS NULL))
      UNION SELECT e.child_group_id FROM flightdeck_pg_group_edges e JOIN relevant r ON r.group_id=e.parent_group_id WHERE e.workspace_id=${input.workspaceId}
    ), provenance AS (
      SELECT 'direct'::text AS source,group_id,NULL::uuid AS child_group_id,created_at FROM flightdeck_pg_group_memberships WHERE workspace_id=${input.workspaceId} AND actor_id=${target.id} AND group_id IN (SELECT group_id FROM relevant)
      UNION ALL SELECT 'parent',e.parent_group_id,e.child_group_id,e.created_at FROM flightdeck_pg_group_edges e JOIN effective x ON x.group_id=e.child_group_id WHERE e.workspace_id=${input.workspaceId} AND e.parent_group_id IN (SELECT group_id FROM relevant) AND e.child_group_id IN (SELECT group_id FROM relevant)
    ) SELECT source,group_id,child_group_id,created_at FROM provenance ORDER BY source,group_id,child_group_id LIMIT ${input.limit+1} OFFSET ${input.offset}` : [];
    const decisions = [];
    for (const permission of ['channel.read','channel.write','channel.manage','channel.grants.read','channel.grants.manage','doc.write','task.create','task.comment'] as const) {
      const d = await authorizeFlightDeckPgOperation({...base,actorNpub:target.npub,permission,resource:{type:'channel',channelId:channel.id}},sql);
      decisions.push({permission,resource_type:'channel',resource_id:channel.id,allowed:d.allowed,reason:d.reason,grant_id:d.allowed?d.grantId:null});
    }
    if (includeScope) for (const permission of ['scope.manage','context.edit','channel.create'] as const) {
      const d = await authorizeFlightDeckPgOperation({...base,actorNpub:target.npub,permission,resource:{type:'scope',scopeId:channel.scope_id}},sql);
      decisions.push({permission,resource_type:'scope',resource_id:channel.scope_id,allowed:d.allowed,reason:d.reason,grant_id:d.allowed?d.grantId:null});
    }
    // Matching sources remain available even when the grant listing page excludes them.
    const sourceIds = decisions.flatMap(d=>d.grant_id?[d.grant_id]:[]);
    const sources = sourceIds.length ? await sql`SELECT id,principal_type,principal_actor_id,principal_group_id,resource_type,resource_scope_id,resource_channel_id,permission FROM flightdeck_pg_permission_grants WHERE workspace_id=${input.workspaceId} AND id IN ${sql(sourceIds)}` : [];
    if (support && !matchDiagnosticAuthorization([support], input)) throw new PermissionDiagnosticError(403, 'diagnostic_access_denied');
    const [receipt] = await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,actor_id,action,resource_type,resource_id,metadata)
      VALUES(${input.workspaceId},${signer.id},'permission_diagnostic.read','channel',${channel.id},${sql.json({case_id:input.caseId,signer_npub:input.signerNpub,resolved_user_npub:input.userNpub,target_actor_id:target.id,access:support?'operator_support':'existing_acl',limit:input.limit,offset:input.offset})}) RETURNING id`;
    if (support && !matchDiagnosticAuthorization([support], input)) throw new PermissionDiagnosticError(403, 'diagnostic_access_denied');
    return { version:1, case_id:input.caseId, generated_at:new Date().toISOString(), build:getTowerBuildInfo(),
      access:{mode:support?'operator_support':'existing_acl',expires_at:support?.expires_at??null,scope_metadata:includeScope,group_provenance:includePaths,signer_npub:input.signerNpub,resolved_user_npub:input.userNpub},
      workspace_id:workspace.id, channel:{id:channel.id,scope_id:channel.scope_id}, target:{id:target.id,npub:target.npub,kind:target.kind,membership_role:membership.role},
      grants:page(grants,input), audit:page(audit.map(a=>({...a,changes:sanitizeDiagnosticAudit(a.changes)})),input), group_provenance:page(paths,input),
      group_reachability:page(reachability,input), decisions, matching_sources:sources, audit_receipt_id:receipt!.id };
  });
}
