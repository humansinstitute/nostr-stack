import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { resolveFlightDeckPgRequestContext } from './flightdeck-pg-api';
import { authorizeFlightDeckPgOperation } from './flightdeck-pg-authorization';
import { evaluateWappManagement } from './wapp-management';
import { validateRuntimeManifest, accessExpansion, validateJson, canonical, parseRuntimeManifest } from './napplet-protocol.js';
import type { NappletBundle, NappletManifest } from '../types';

type Db = ReturnType<typeof getDb>;
type Row = Record<string, any>;
export class NappletError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
function fail(code: string, status = 400, message = code): never { throw new NappletError(code, status, message); }
export function nappletUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail('invalid_uuid');
  return value.toLowerCase();
}
function object(v: unknown): Row {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('json_object_required');
  return v as Row;
}
export function exact(v: unknown, keys: string[]): Row {
  const o = object(v);
  if (Object.keys(o).some(k => !keys.includes(k))) fail('unknown_field');
  return o;
}
function integer(v: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(v) || Number(v) < minimum || Number(v) > 2147483646) fail('invalid_revision_or_schema');
  return Number(v);
}
function revision(row: Row | undefined, expected: unknown) {
  if ((row?.revision ?? 0) !== integer(expected, 0)) fail('revision_conflict', 409);
}
function name(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v)) fail('invalid_name');
  return v;
}
function label(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 300) fail('invalid_label');
  return v.trim();
}
function strings(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 200 || v.some(x => typeof x !== 'string' || !x || x.length > 200)) fail('invalid_grants');
  return [...new Set(v)].sort();
}
export function normalizeNappletManifest(value: unknown): NappletManifest {
  try { return validateRuntimeManifest(value) as NappletManifest; }
  catch { return fail('invalid_manifest'); }
}
export function nappletReleaseExpands(previous: NappletManifest, next: NappletManifest): boolean {
  return accessExpansion(previous, next).length > 0;
}
function stableName(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(v)) fail('invalid_napplet_or_collection_name');
  return v;
}
function jsonData(v: unknown): Row {
  const o = object(v);
  try { validateJson(o); } catch { fail('invalid_json_value'); }
  if (Buffer.byteLength(JSON.stringify(o)) > 256 * 1024) fail('record_too_large', 413);
  return o;
}
export function nappletPage(options: Row = {}) {
  const limit = options.limit === undefined ? 50 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('invalid_limit');
  return { limit, after: options.after === undefined ? '' : String(options.after) };
}
function page(rows: Row[], limit: number, field: string, envelope: string) {
  return { [envelope]: rows.slice(0, limit), next_cursor: rows.length > limit ? String(rows[limit - 1][field]) : null };
}
export function verifyNappletBundle(bytes: Uint8Array, installation: { bundle: NappletBundle; manifest: NappletManifest }) {
  if (bytes.byteLength > 2 * 1024 * 1024) fail('bundle_too_large', 413);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== installation.bundle.sha256_hex) fail('bundle_integrity_mismatch', 409);
  let parsed;
  try { parsed = parseRuntimeManifest(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('invalid_bundle_manifest', 409); }
  if (canonical(parsed) !== canonical(installation.manifest)) fail('bundle_manifest_mismatch', 409);
  return digest;
}

export type NappletRequest = { workspaceId: string; appNpub: string; actorNpub: string; nappletId?: string };

// All writes serialize on the installation. ACL replacement, removal and record writes cannot race.
// Reads also lock it so a response uses one authority snapshot; every request resolves membership anew.
export async function nappletOperation(request: NappletRequest, operation: string, body: Row = {}, options: Row = {}) {
  const workspaceId = nappletUuid(request.workspaceId);
  const nappletId = request.nappletId ? stableName(request.nappletId) : null;
  return getDb().begin(async tx => {
    const sql = tx as unknown as Db;
    const context = await resolveFlightDeckPgRequestContext({ workspaceId, actorNpub: request.actorNpub }, sql);
    if (!context.workspace) fail('workspace_not_found', 404);
    if (!context.actor || !context.membership) fail('workspace_membership_required', 403);
    if (context.workspace.app_npub !== request.appNpub) fail('workspace_app_mismatch', 403);
    // Membership deletion waits for this transaction; no stale member writes after revocation commits.
    const [member] = await sql`SELECT actor_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId} AND actor_id=${context.actor.id} FOR SHARE`;
    if (!member) fail('workspace_membership_required', 403);
    const actor = context.actor.npub;
    const app = request.appNpub;
    const manager = async (delegationId?: string) => {
      if (['audience', 'remove'].includes(operation) && installation?.owner_npub === actor) return;
      const permission = await authorizeFlightDeckPgOperation({ actorNpub: actor, appNpub: app, workspaceId, permission: 'napplet.install', resource: { type: 'workspace' } }, sql);
      if (permission.allowed) return;
      const [owner] = await sql<Row[]>`SELECT a.id FROM flightdeck_pg_workspace_memberships m JOIN flightdeck_pg_actors a ON a.id=m.actor_id WHERE m.workspace_id=${workspaceId} AND m.role='owner' ORDER BY a.id LIMIT 1`;
      if (!owner) fail('workspace_owner_missing', 403);
      if (owner.id === context.actor!.id) fail('napplet_install_required', 403);
      // Reuse the supported personal wapp-management delegation; bounded to this stable napplet.
      const source = body.bundle ?? installation?.bundle;
      const [file] = source ? await sql<Row[]>`SELECT scope_id,channel_id FROM flightdeck_pg_files WHERE workspace_id=${workspaceId} AND id=${nappletUuid(source.file_id)} AND deleted_at IS NULL` : [];
      // Revocation and management mutation have a defined transaction order.
      const delegations = await sql<Row[]>`SELECT filters FROM flightdeck_pg_wapp_delegations WHERE workspace_id=${workspaceId} AND delegate_actor_id=${context.actor!.id} AND owner_actor_id=${owner.id} AND (${delegationId || null}::uuid IS NULL OR id=${delegationId || null}) ORDER BY created_at DESC LIMIT 1 FOR SHARE`;
      const filters = delegations[0]?.filters;
      if (filters && ['capabilities', 'open_origins', 'autopilot_origins'].some(key => filters[key]?.length)) fail('delegation_resource_unsupported', 403);
      await evaluateWappManagement({ workspaceId, actorId: context.actor!.id, ownerActorId: owner.id,
        delegationId, request: { app_id: nappletId, wapp_installation_id: nappletId, scope_id: file?.scope_id, channel_id: file?.channel_id } }, sql);
    };
    if (operation === 'list') {
      const { limit, after } = nappletPage(options);
      if (after) stableName(after);
      const rows = await sql<Row[]>`SELECT * FROM flightdeck_pg_napplets WHERE workspace_id=${workspaceId} AND app_npub=${app}
        AND removed=false AND (${after || null}::text IS NULL OR napplet_id>${after || null}::text)
        AND (owner_npub=${actor} OR publisher_npub=${actor} OR audience_npubs ? ${actor}) ORDER BY napplet_id LIMIT ${limit + 1}`;
      return page(rows, limit, 'napplet_id', 'installations');
    }
    if (!nappletId) fail('napplet_id_required');
    // Also serializes first creation (including concurrent retries) without locking unrelated napplets.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ':' + app + ':' + nappletId},0))`;
    let [installation] = await sql<Row[]>`SELECT * FROM flightdeck_pg_napplets WHERE workspace_id=${workspaceId} AND app_npub=${app} AND napplet_id=${nappletId} FOR UPDATE`;
    const members = async (values: string[]) => {
      if (!values.length) return;
      const rows = await sql<Row[]>`SELECT a.npub FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id=a.id WHERE m.workspace_id=${workspaceId} AND a.npub IN ${sql(values)}`;
      if (rows.length !== values.length) fail('grant_member_required', 403);
    };
    const bundle = async (input: unknown): Promise<NappletBundle> => {
      const b = exact(input, ['file_id', 'file_version_id', 'sha256_hex']);
      nappletUuid(b.file_id); nappletUuid(b.file_version_id);
      if (typeof b.sha256_hex !== 'string' || !/^[a-f0-9]{64}$/.test(b.sha256_hex)) fail('invalid_digest');
      const [file] = await sql<Row[]>`SELECT f.channel_id,s.sha256_hex FROM flightdeck_pg_files f
        JOIN flightdeck_pg_file_versions v ON v.workspace_id=f.workspace_id AND v.file_id=f.id
        JOIN v4_storage_objects s ON s.id=v.storage_object_id
        WHERE f.workspace_id=${workspaceId} AND f.id=${b.file_id} AND v.id=${b.file_version_id}
        AND f.deleted_at IS NULL AND s.completed_at IS NOT NULL`;
      if (!file || file.sha256_hex !== b.sha256_hex) fail('bundle_integrity_mismatch', 409);
      const permissions = await Promise.all(['file.read', 'channel.read'].map(permission => authorizeFlightDeckPgOperation({ actorNpub: actor, appNpub: app, workspaceId, permission, resource: { type: 'channel', channelId: file.channel_id } }, sql)));
      if (!permissions.some(d => d.allowed)) fail('file_read_denied', 403);
      return b as NappletBundle;
    };
    const requirePublisher = async (publisher: string, source: NappletBundle) => {
      const decision = await authorizeFlightDeckPgOperation({ actorNpub: publisher, appNpub: app, workspaceId, permission: 'napplet.publish', resource: { type: 'workspace' } }, sql);
      if (!decision.allowed) fail('napplet_publish_required', 403);
      const [file] = await sql<Row[]>`SELECT channel_id FROM flightdeck_pg_files WHERE workspace_id=${workspaceId} AND id=${source.file_id} AND deleted_at IS NULL`;
      if (!file) fail('bundle_not_found', 404);
      const access = await Promise.all(['file.read', 'channel.read'].map(permission => authorizeFlightDeckPgOperation({ actorNpub: publisher, appNpub: app, workspaceId, permission, resource: { type: 'channel', channelId: file.channel_id } }, sql)));
      if (!access.some(d => d.allowed)) fail('publisher_source_denied', 403);
    };
    const saveInstallation = async (values: Row) => {
      const [updated] = await sql<Row[]>`UPDATE flightdeck_pg_napplets SET ${sql({ ...values, revision: installation.revision + 1, updated_at: new Date() })}
        WHERE workspace_id=${workspaceId} AND app_npub=${app} AND napplet_id=${nappletId} RETURNING *`;
      installation = updated;
      return { installation: updated };
    };
    const release = async (b: NappletBundle, manifest: NappletManifest) => {
      await sql`INSERT INTO flightdeck_pg_napplet_releases (workspace_id,app_npub,napplet_id,revision,bundle,manifest,publisher_npub)
        VALUES (${workspaceId},${app},${nappletId},${installation.revision},${sql.json(b)},${sql.json(manifest)},${installation.publisher_npub})`;
    };
    if (operation === 'install') {
      exact(body, ['expected_revision', 'requester_npub', 'publisher_npub', 'display_name', 'bundle', 'manifest', 'delegation_id']);
      await manager(body.delegation_id);
      revision(installation, body.expected_revision);
      if (installation && !installation.removed) fail('installation_exists', 409);
      await members(strings([body.requester_npub, body.publisher_npub]));
      // Existing stable namespace can only reconnect to its original owner/publisher.
      if (installation && (installation.owner_npub !== body.requester_npub || installation.publisher_npub !== body.publisher_npub)) fail('installation_identity_conflict', 409);
      const b = await bundle(body.bundle), manifest = normalizeNappletManifest(body.manifest);
      if (manifest.napplet_id !== nappletId) fail('manifest_identity_mismatch', 409);
      await requirePublisher(body.publisher_npub, b);
      if (installation) {
        const result = await saveInstallation({ removed: false, display_name: label(body.display_name), audience_npubs: sql.json([body.requester_npub]), bundle: sql.json(b), manifest: sql.json(manifest), pending_release: null });
        await release(b, manifest); return result;
      }
      [installation] = await sql<Row[]>`INSERT INTO flightdeck_pg_napplets (workspace_id,app_npub,napplet_id,owner_npub,publisher_npub,display_name,audience_npubs,bundle,manifest)
        VALUES (${workspaceId},${app},${nappletId},${body.requester_npub},${body.publisher_npub},${label(body.display_name)},${sql.json([body.requester_npub])},${sql.json(b)},${sql.json(manifest)}) RETURNING *`;
      await release(b, manifest); return { installation };
    }
    if (!installation) fail('napplet_not_found', 404);
    if (installation.removed) {
      if (operation !== 'get') fail('napplet_not_found', 404);
      if (installation.owner_npub !== actor && installation.publisher_npub !== actor) await manager();
      // Lifecycle metadata only: removed installations cannot serve bundle or collection data.
      return { installation };
    }
    const open = installation.owner_npub === actor || installation.publisher_npub === actor || installation.audience_npubs.includes(actor);
    if (operation === 'audience' || operation === 'remove' || operation === 'approve') {
      await manager(body.delegation_id);
    } else if (!open) fail('napplet_not_found', 404);
    if (operation === 'get') return { installation };
    if (operation === 'bundle') {
      const [version] = await sql<Row[]>`SELECT v.storage_object_id FROM flightdeck_pg_file_versions v JOIN flightdeck_pg_files f ON f.workspace_id=v.workspace_id AND f.id=v.file_id WHERE v.workspace_id=${workspaceId} AND v.file_id=${installation.bundle.file_id} AND v.id=${installation.bundle.file_version_id} AND f.deleted_at IS NULL`;
      if (!version) fail('bundle_not_found', 404);
      return { installation, storage_object_id: version.storage_object_id };
    }
    if (operation === 'releases') {
      const { limit, after } = nappletPage(options); const afterRevision = after ? integer(Number(after), 0) : 0;
      const rows = await sql<Row[]>`SELECT * FROM flightdeck_pg_napplet_releases WHERE workspace_id=${workspaceId} AND app_npub=${app} AND napplet_id=${nappletId} AND revision>${afterRevision} ORDER BY revision LIMIT ${limit + 1}`;
      return page(rows, limit, 'revision', 'releases');
    }
    if (operation === 'audience') {
      exact(body, ['expected_revision', 'display_name', 'audience_npubs', 'delegation_id']); revision(installation, body.expected_revision);
      const values: Row = {};
      if (body.display_name !== undefined) values.display_name = label(body.display_name);
      if (body.audience_npubs !== undefined) { const v = strings(body.audience_npubs); await members(v); values.audience_npubs = sql.json(v); }
      return saveInstallation(values);
    }
    if (operation === 'publish') {
      exact(body, ['expected_revision', 'bundle', 'manifest']); revision(installation, body.expected_revision);
      if (actor !== installation.publisher_npub) fail('publisher_required', 403);
      const b = await bundle(body.bundle), manifest = normalizeNappletManifest(body.manifest);
      if (manifest.napplet_id !== nappletId) fail('manifest_identity_mismatch', 409);
      await requirePublisher(installation.publisher_npub, b);
      if (nappletReleaseExpands(installation.manifest, manifest)) return saveInstallation({ pending_release: sql.json({ bundle: b, manifest }) });
      const result = await saveInstallation({ bundle: sql.json(b), manifest: sql.json(manifest), pending_release: null });
      await release(b, manifest); return result;
    }
    if (operation === 'approve') {
      exact(body, ['expected_revision', 'delegation_id']); revision(installation, body.expected_revision);
      if (context.actor!.kind !== 'human') fail('human_expansion_approval_required', 403);
      if (!installation.pending_release) fail('no_pending_release', 409);
      const { bundle: b, manifest } = installation.pending_release;
      await bundle(b);
      await requirePublisher(installation.publisher_npub, b);
      const result = await saveInstallation({ bundle: sql.json(b), manifest: sql.json(manifest), pending_release: null });
      await release(b, manifest); return result;
    }
    if (operation === 'remove') {
      exact(body, ['expected_revision', 'data', 'confirm_napplet_id', 'delegation_id']); revision(installation, body.expected_revision);
      if (!['keep', 'delete'].includes(body.data)) fail('removal_choice_required');
      if (body.data === 'delete') {
        if (body.confirm_napplet_id !== nappletId) fail('deletion_confirmation_required');
        const [foreign] = await sql`SELECT id FROM flightdeck_pg_napplet_collections WHERE workspace_id=${workspaceId} AND app_npub=${app} AND napplet_id=${nappletId} AND owner_npub<>${actor} LIMIT 1`;
        if (foreign) fail('collection_owner_required', 403);
        await sql`DELETE FROM flightdeck_pg_napplet_collections WHERE workspace_id=${workspaceId} AND app_npub=${app} AND napplet_id=${nappletId}`;
      }
      return saveInstallation({ removed: true, pending_release: null });
    }
    const collectionId = options.collectionId ? nappletUuid(options.collectionId) : null;
    if (operation === 'collections') {
      const { limit, after } = nappletPage(options); if (after) nappletUuid(after);
      const rows = await sql<Row[]>`SELECT * FROM flightdeck_pg_napplet_collections WHERE workspace_id=${workspaceId} AND app_npub=${app} AND napplet_id=${nappletId}
        AND (${after || null}::uuid IS NULL OR id>${after || null}::uuid) AND (owner_npub=${actor} OR read_npubs ? ${actor} OR write_npubs ? ${actor}) ORDER BY id LIMIT ${limit + 1}`;
      return page(rows, limit, 'id', 'collections');
    }
    if (operation === 'create_collection') {
      exact(body, ['name', 'scope', 'schema_version', 'read_npubs', 'write_npubs']);
      if (!['personal', 'team'].includes(body.scope)) fail('invalid_scope');
      const n = stableName(body.name), schema = integer(body.schema_version);
      if (!(installation.manifest.collections[n]?.schema_version === schema && installation.manifest.collections[n]?.scope === body.scope)) fail('undeclared_collection', 403);
      const read = strings(body.read_npubs ?? []), write = strings(body.write_npubs ?? []); await members([...new Set([...read, ...write])]);
      const [collection] = await sql<Row[]>`INSERT INTO flightdeck_pg_napplet_collections (workspace_id,app_npub,napplet_id,name,scope,owner_npub,schema_version,read_npubs,write_npubs)
        VALUES (${workspaceId},${app},${nappletId},${n},${body.scope},${actor},${schema},${sql.json(read)},${sql.json(write)}) ON CONFLICT DO NOTHING RETURNING *`;
      if (!collection) fail('collection_exists', 409);
      return { collection };
    }
    if (!collectionId) fail('collection_required');
    const [collection] = await sql<Row[]>`SELECT * FROM flightdeck_pg_napplet_collections WHERE id=${collectionId} AND workspace_id=${workspaceId} AND app_npub=${app} AND napplet_id=${nappletId} FOR UPDATE`;
    if (!collection) fail('collection_not_found', 404);
    const declaration = installation.manifest.collections[collection.name];
    const requiredOp = ({ records: 'list', record: 'get', history: 'get', delete_record: 'delete' } as Row)[operation];
    if (requiredOp && (!declaration || declaration.scope !== collection.scope || !declaration.operations.includes(requiredOp))) fail('operation_not_declared', 403);
    const own = collection.owner_npub === actor;
    const write = own || collection.write_npubs.includes(actor);
    const read = write || collection.read_npubs.includes(actor);
    if (!read) fail('collection_not_found', 404);
    if (operation === 'collection_grants') {
      exact(body, ['expected_revision', 'read_npubs', 'write_npubs']);
      if (!own) fail('collection_owner_required', 403); revision(collection, body.expected_revision);
      const r = strings(body.read_npubs ?? collection.read_npubs), w = strings(body.write_npubs ?? collection.write_npubs);
      await members([...new Set([...r, ...w])]);
      const [updated] = await sql<Row[]>`UPDATE flightdeck_pg_napplet_collections SET read_npubs=${sql.json(r)},write_npubs=${sql.json(w)},revision=revision+1,updated_at=now() WHERE id=${collectionId} RETURNING *`;
      return { collection: updated };
    }
    const snapshot = async (record: Row) => {
      await sql`INSERT INTO flightdeck_pg_napplet_record_versions SELECT collection_id,id,revision,schema_version,data,deleted,provenance,updated_by_npub,updated_at FROM flightdeck_pg_napplet_records WHERE collection_id=${record.collection_id} AND id=${record.id}`;
    };
    if (operation === 'migrate') {
      exact(body, ['expected_revision', 'from_schema_version', 'to_schema_version', 'compatible', 'source', 'records']);
      if (!own) fail('collection_owner_required', 403); revision(collection, body.expected_revision);
      if (!declaration?.operations.includes('create')) fail('operation_not_declared', 403);
      if (body.compatible !== true || collection.schema_version !== integer(body.from_schema_version)) fail('incompatible_migration', 409);
      const to = integer(body.to_schema_version);
      if (to < collection.schema_version || installation.manifest.collections[collection.name]?.schema_version !== to) fail('undeclared_schema', 409);
      const source = await bundle(body.source);
      if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 200) fail('bounded_records_required');
      const ids = new Set<string>();
      for (const input of body.records) {
        const v = exact(input, ['id', 'data']), id = name(v.id);
        if (ids.has(id)) fail('duplicate_record'); ids.add(id);
        const data = jsonData(v.data);
        const [r] = await sql<Row[]>`INSERT INTO flightdeck_pg_napplet_records (collection_id,id,revision,schema_version,data,provenance,updated_by_npub)
          VALUES (${collectionId},${id},1,${to},${sql.json(data)},${sql.json(source)},${actor}) ON CONFLICT DO NOTHING RETURNING *`;
        if (!r) fail('record_conflict', 409); await snapshot(r);
      }
      const [updated] = await sql<Row[]>`UPDATE flightdeck_pg_napplet_collections SET schema_version=${to},revision=revision+1,updated_at=now() WHERE id=${collectionId} RETURNING *`;
      return { collection: updated, imported: ids.size, source_preserved: true };
    }
    if (operation === 'records') {
      const { limit, after } = nappletPage(options); if (after) name(after);
      const rows = await sql<Row[]>`SELECT * FROM flightdeck_pg_napplet_records WHERE collection_id=${collectionId} AND id>${after} AND deleted=false ORDER BY id COLLATE "C" LIMIT ${limit + 1}`;
      return page(rows, limit, 'id', 'records');
    }
    const id = name(options.recordId);
    const [current] = await sql<Row[]>`SELECT * FROM flightdeck_pg_napplet_records WHERE collection_id=${collectionId} AND id=${id} FOR UPDATE`;
    if (operation === 'record') { if (!current) fail('record_not_found', 404); return { record: current }; }
    if (operation === 'history') {
      const { limit, after } = nappletPage(options); const afterRevision = after ? integer(Number(after), 0) : 0;
      const rows = await sql<Row[]>`SELECT * FROM flightdeck_pg_napplet_record_versions WHERE collection_id=${collectionId} AND id=${id} AND revision>${afterRevision} ORDER BY revision LIMIT ${limit + 1}`;
      return page(rows, limit, 'revision', 'versions');
    }
    if (!['put_record', 'delete_record'].includes(operation)) fail('unknown_operation');
    exact(body, operation === 'put_record' ? ['expected_revision', 'schema_version', 'data'] : ['expected_revision']);
    if (!write) fail('collection_write_denied', 403); revision(current, body.expected_revision);
    const deleted = operation === 'delete_record';
    const mutation = deleted ? 'delete' : current ? 'update' : 'create';
    if (!declaration || declaration.scope !== collection.scope || !declaration.operations.includes(mutation)) fail('operation_not_declared', 403);
    if (deleted && !current) fail('record_not_found', 404);
    const schema = deleted ? collection.schema_version : integer(body.schema_version);
    if (schema !== collection.schema_version) fail('schema_conflict', 409);
    const data = deleted ? null : jsonData(body.data);
    const [record] = await sql<Row[]>`INSERT INTO flightdeck_pg_napplet_records (collection_id,id,revision,schema_version,data,deleted,updated_by_npub)
      VALUES (${collectionId},${id},${(current?.revision ?? 0) + 1},${schema},${data === null ? null : sql.json(data)},${deleted},${actor})
      ON CONFLICT (collection_id,id) DO UPDATE SET revision=EXCLUDED.revision,schema_version=EXCLUDED.schema_version,data=EXCLUDED.data,deleted=EXCLUDED.deleted,updated_by_npub=EXCLUDED.updated_by_npub,updated_at=now() RETURNING *`;
    await snapshot(record); return { record };
  });
}
