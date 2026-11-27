import { nip19 } from 'nostr-tools';
import { getDb } from '../db';
import type { NamespaceAppPermission } from '../types';

type Sql = ReturnType<typeof getDb>;
export class NamespacePermissionError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 = 400) { super(message); }
}
const fail = (message: string, status: 400 | 403 | 404 | 409 = 400): never => { throw new NamespacePermissionError(message, status); };
export function namespaceNpub(value: unknown): string {
  if (typeof value !== 'string') return fail('A public npub identity is required');
  try { const key = nip19.decode(value); if (key.type === 'npub' && nip19.npubEncode(key.data) === value) return value; } catch {}
  return fail('Enter a valid canonical public npub identity');
}
export function permissionUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return fail('A UUID idempotency key or permission ID is required');
  return value;
}
function exact(body: any, fields: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length || fields.some(f => !(f in body))) fail('Unexpected or missing permission fields');
}
// The namespace address is a service identity for encrypted workspaces; its creator
// is the human owner. Typed namespaces use the human owner address directly.
export async function namespaceOwner(owner: string, signer: string, sql: Sql = getDb()) {
  namespaceNpub(owner);
  const [legacy] = await sql`SELECT creator_npub FROM v4_workspaces WHERE workspace_owner_npub=${owner} FOR SHARE`;
  if (legacy) return signer === owner || signer === legacy.creator_npub;
  const [typed] = await sql`SELECT id FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${owner} LIMIT 1 FOR SHARE`;
  return !!typed && signer === owner;
}
async function requireOwner(owner: string, signer: string, sql: Sql) {
  if (!await namespaceOwner(owner, signer, sql)) fail('Only the namespace owner may view, grant or revoke agent app permissions', 403);
}
const serialize = (row: any): NamespaceAppPermission => ({ ...row, created_at: new Date(row.created_at).toISOString(), expires_at: new Date(row.expires_at).toISOString(), revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null });
export async function listNamespacePermissions(owner: string, signer: string, before?: string) {
  if (before) permissionUuid(before);
  return getDb().begin(async transaction => {
    const sql = transaction as unknown as Sql;
    await requireOwner(owner, signer, sql);
    const rows = await sql`SELECT * FROM namespace_app_permissions WHERE workspace_owner_npub=${owner} AND (${before || null}::uuid IS NULL OR (created_at,id) < (SELECT created_at,id FROM namespace_app_permissions WHERE workspace_owner_npub=${owner} AND id=${before || null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT 201`;
    return { grants: rows.slice(0, 200).map(serialize), truncated: rows.length > 200, next_cursor: rows.length > 200 ? rows[199].id : null };
  });
}
export async function grantNamespacePermission(owner: string, signer: string, body: any) {
  exact(body, ['idempotency_key', 'agent_npub', 'app_npub', 'permission', 'expires_at']);
  const id = permissionUuid(body.idempotency_key), agent = namespaceNpub(body.agent_npub), app = namespaceNpub(body.app_npub);
  const expiry = new Date(body.expires_at);
  if (body.permission !== 'namespace.manage' || typeof body.expires_at !== 'string' || !Number.isFinite(expiry.getTime()) || expiry.getTime() > Date.now() + 366 * 86400000) fail('Use namespace.manage and an expiry within 366 days');
  return getDb().begin(async transaction => {
    const sql = transaction as unknown as Sql;
    await requireOwner(owner, signer, sql);
    // Idempotent retries retain even a revoked grant; they never reactivate it.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${"namespace-permissions:" + owner}, 0))`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
    const [prior] = await sql`SELECT * FROM namespace_app_permissions WHERE id=${id}`;
    if (prior) {
      if (prior.workspace_owner_npub !== owner || prior.agent_npub !== agent || prior.app_npub !== app || prior.created_by_npub !== signer || new Date(prior.expires_at).getTime() !== expiry.getTime()) fail('Permission idempotency key conflicts with an earlier request', 409);
      return serialize(prior);
    }
    if (expiry.getTime() <= Date.now()) fail('Permission expiry must be in the future');
    const [{ count }] = await sql`SELECT count(*)::int count FROM namespace_app_permissions WHERE workspace_owner_npub=${owner} AND revoked_at IS NULL AND expires_at>clock_timestamp()`;
    if (count >= 1000) fail('Revoke unused permissions before adding more', 409);
    const [row] = await sql`INSERT INTO namespace_app_permissions(id,workspace_owner_npub,app_npub,agent_npub,permission,expires_at,created_by_npub) VALUES(${id},${owner},${app},${agent},'namespace.manage',${expiry},${signer}) RETURNING *`;
    return serialize(row);
  });
}
export async function revokeNamespacePermission(owner: string, id: string, signer: string, body: any) {
  permissionUuid(id); exact(body, ['expected_revision']);
  if (!Number.isInteger(body.expected_revision) || body.expected_revision < 1) fail('A current expected_revision is required');
  return getDb().begin(async transaction => {
    const sql = transaction as unknown as Sql;
    await requireOwner(owner, signer, sql);
    const [row] = await sql`SELECT * FROM namespace_app_permissions WHERE workspace_owner_npub=${owner} AND id=${id} FOR UPDATE`;
    if (!row) fail('Permission not found', 404);
    // A retry of this exact successful revoke returns the confirmed result.
    if (row.revoked_at && row.revision === body.expected_revision + 1 && row.revoked_by_npub === signer) return serialize(row);
    if (row.revision !== body.expected_revision) fail('Permission changed. Refresh and review its current revision', 409);
    if (row.revoked_at) return serialize(row);
    const [updated] = await sql`UPDATE namespace_app_permissions SET revoked_at=clock_timestamp(),revoked_by_npub=${signer},revision=revision+1 WHERE id=${id} RETURNING *`;
    return serialize(updated);
  });
}
// Hold the permission share lock through the namespace mutation. A revoke waits
// for admitted operations and all requests begun after its commit are denied.
export async function requireNamespacePermission(owner: string, app: string, signer: string, sql: Sql) {
  namespaceNpub(owner); namespaceNpub(app);
  const rows = await sql`SELECT * FROM namespace_app_permissions WHERE workspace_owner_npub=${owner} AND app_npub=${app} AND agent_npub=${signer} AND permission='namespace.manage' AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY id FOR SHARE`;
  for (const row of rows) if (await namespaceOwner(owner, row.created_by_npub, sql)) return;
  fail('An active owner-approved permission for this exact agent and app is required', 403);
}
