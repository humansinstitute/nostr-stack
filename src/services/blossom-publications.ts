import { getDb } from '../db';
import { verifyStorageIdentity, storageObjectsByHash, prepareStorageObjectForAuthorizedOwner } from './storage';
import { resolveFlightDeckPgFileVersion } from './flightdeck-pg-api';
import { authorizeFlightDeckPgStorageAttach, authorizeFlightDeckPgStorageRead, hasFlightDeckPgStorageAuthority } from './flightdeck-pg-storage-access';
import { authorizeFlightDeckPgOperation } from './flightdeck-pg-authorization';
import { resolveWsKeyNpub } from './user-workspace-keys';
import { isFlightDeckPgThreadParticipant } from './flightdeck-pg-api';
import type { PrepareStorageInput, V4StorageObject, WorkspaceAppStorageBlossomStatus } from '../types';

type DbClient = ReturnType<typeof getDb>;
export class BlossomPublicationError extends Error {
  constructor(public code: string, public status: 400 | 404 | 409, message: string) { super(message); }
}

/** Public authority is a separate, version/hash-pinned reference; storage ACLs stay private. */
export async function hasBlossomPublication(storageObjectId: string, hash: string, sql: DbClient = getDb()) {
  const [row] = await sql`
    SELECT 1 FROM flightdeck_pg_blossom_publications p
    JOIN flightdeck_pg_files f ON f.workspace_id=p.workspace_id AND f.id=p.file_id
    JOIN flightdeck_pg_file_versions v ON v.workspace_id=p.workspace_id AND v.id=p.version_id AND v.file_id=p.file_id AND v.storage_object_id=p.storage_object_id
    WHERE p.storage_object_id=${storageObjectId} AND p.sha256_hex=${hash}
      AND p.revoked_at IS NULL AND f.deleted_at IS NULL AND v.operation <> 'deleted'
    LIMIT 1
  `;
  if (row) return true;
  const refs = await sql`
    SELECT p.*, m.channel_id, m.thread_id, a.npub, a.kind, w.app_npub
    FROM flightdeck_pg_blossom_message_publications p
    JOIN flightdeck_pg_storage_links l ON l.id=p.link_id AND l.workspace_id=p.workspace_id
      AND l.entity_type='message' AND l.entity_id=p.message_id AND l.storage_object_id=p.storage_object_id AND l.deleted_at IS NULL
    JOIN flightdeck_pg_messages m ON m.workspace_id=p.workspace_id AND m.id=p.message_id
      AND m.channel_id=l.channel_id AND m.scope_id=l.scope_id AND m.deleted_at IS NULL
    JOIN flightdeck_pg_workspaces w ON w.id=p.workspace_id
    JOIN v4_storage_objects s ON s.id=p.storage_object_id AND s.owner_npub=w.workspace_owner_npub
    JOIN flightdeck_pg_actors a ON a.id=p.actor_id
    WHERE p.storage_object_id=${storageObjectId} AND p.sha256_hex=${hash} AND p.revoked_at IS NULL
      AND (m.thread_id IS NULL OR EXISTS (SELECT 1 FROM flightdeck_pg_threads t
        WHERE t.workspace_id=m.workspace_id AND t.id=m.thread_id AND t.channel_id=m.channel_id AND t.scope_id=m.scope_id AND t.deleted_at IS NULL))
  `;
  for (const ref of refs) {
    const access = await authorizeFlightDeckPgStorageAttach({ actorNpub: ref.npub, appNpub: ref.app_npub,
      workspaceId: ref.workspace_id, entityType: 'message', channelId: ref.channel_id }, sql);
    if (!access.allowed || !(await authorizeFlightDeckPgStorageRead({ actorNpub: ref.npub, appNpub: ref.app_npub,
      workspaceId: ref.workspace_id, entityType: 'message', channelId: ref.channel_id }, sql)).allowed) continue;
    if (ref.kind !== 'human' && ref.thread_id && !await isFlightDeckPgThreadParticipant({
      workspaceId: ref.workspace_id, threadId: ref.thread_id, actorId: ref.actor_id, actorNpub: ref.npub }, sql)) continue;
    return true;
  }
  return hasAppBlossomPublication(storageObjectId, hash, sql);
}

/** Any current public authority for these exact bytes, including independently published copies. */
async function hashIsPublic(hash: string, sql: DbClient) {
  for (const candidate of await storageObjectsByHash(hash)) {
    if (!candidate.is_public && !await hasBlossomPublication(candidate.id, hash, sql)) continue;
    if ((await verifyStorageIdentity(candidate))?.sha256_hex === hash) return true;
  }
  return false;
}

export async function fileBlossomPublications(input: {
  workspaceId: string; fileId: string; actorId: string; origin: string;
}, sql: DbClient = getDb()) {
  const rows = await sql`
    SELECT v.id AS version_id, v.version_number, v.storage_object_id, s.sha256_hex,
      s.is_public, s.completed_at, v.operation,
      EXISTS (SELECT 1 FROM flightdeck_pg_blossom_publications p WHERE p.workspace_id=v.workspace_id
        AND p.version_id=v.id AND p.actor_id=${input.actorId} AND p.revoked_at IS NULL) AS published_by_you,
      (SELECT COUNT(*)::integer FROM flightdeck_pg_blossom_publications p WHERE p.workspace_id=v.workspace_id
        AND p.version_id=v.id AND p.revoked_at IS NULL) AS publication_count
    FROM flightdeck_pg_file_versions v
    JOIN v4_storage_objects s ON s.id=v.storage_object_id
    WHERE v.workspace_id=${input.workspaceId} AND v.file_id=${input.fileId}
    ORDER BY v.version_number DESC
  `;
  const versions = [];
  for (const row of rows) {
    const [object] = await sql<V4StorageObject[]>`SELECT * FROM v4_storage_objects WHERE id=${row.storage_object_id}`;
    const verified = row.operation !== 'deleted' && object ? await verifyStorageIdentity(object) : null;
    // A hash URL is shared by identical bytes, including independently published copies.
    const isPublic = verified ? await hashIsPublic(verified.sha256_hex!, sql) : false;
    versions.push({ ...row, sha256_hex: verified?.sha256_hex ?? null,
      available: !!verified, public: isPublic,
      blossom_url: isPublic ? `${input.origin}/${verified!.sha256_hex}` : null });
  }
  return { file_id: input.fileId, versions };
}

export async function mutateBlossomPublication(input: {
  workspaceId: string; fileId: string; versionId: string; actorId: string;
  workspaceOwnerNpub: string; publish: boolean;
}, sql: DbClient) {
  // Serialize publication with file replacement/deletion and repeated operations.
  const [locked] = await sql`SELECT id FROM flightdeck_pg_files WHERE workspace_id=${input.workspaceId} AND id=${input.fileId} AND deleted_at IS NULL FOR UPDATE`;
  if (!locked) throw new BlossomPublicationError('file_not_found', 404, 'File is missing or deleted');
  const version = await resolveFlightDeckPgFileVersion({ workspaceId: input.workspaceId, versionId: input.versionId }, sql);
  if (!version || version.file_id !== input.fileId || version.operation === 'deleted')
    throw new BlossomPublicationError('file_version_not_found', 404, 'Selected file version is missing or deleted');
  if (!input.publish) {
    const changed = await sql`UPDATE flightdeck_pg_blossom_publications SET revoked_at=NOW()
      WHERE workspace_id=${input.workspaceId} AND version_id=${input.versionId} AND actor_id=${input.actorId} AND revoked_at IS NULL RETURNING version_id`;
    return changed.length > 0;
  }
  const [object] = await sql<V4StorageObject[]>`SELECT * FROM v4_storage_objects WHERE id=${version.storage_object_id}`;
  if (!object || object.owner_npub !== input.workspaceOwnerNpub)
    throw new BlossomPublicationError('storage_object_not_found', 404, 'Selected storage object is unavailable in this workspace');
  if (!object.completed_at) throw new BlossomPublicationError('storage_incomplete', 409, 'File upload is not complete');
  const verified = await verifyStorageIdentity(object);
  if (!verified) throw new BlossomPublicationError('storage_unavailable', 409, 'Stored bytes are missing or could not be verified');
  const [existing] = await sql`SELECT sha256_hex, revoked_at FROM flightdeck_pg_blossom_publications
    WHERE workspace_id=${input.workspaceId} AND version_id=${input.versionId} AND actor_id=${input.actorId}`;
  if (existing && existing.sha256_hex !== verified.sha256_hex)
    throw new BlossomPublicationError('publication_hash_changed', 409, 'Published immutable bytes changed; upload a new file version');
  if (existing && !existing.revoked_at) return false;
  await sql`INSERT INTO flightdeck_pg_blossom_publications (workspace_id,file_id,version_id,actor_id,storage_object_id,sha256_hex)
    VALUES (${input.workspaceId},${input.fileId},${input.versionId},${input.actorId},${object.id},${verified.sha256_hex!})
    ON CONFLICT (workspace_id,version_id,actor_id) DO UPDATE SET revoked_at=NULL,published_at=NOW()`;
  return true;
}

/** Resolve the actual active source, including channel/scope consistency. */
export async function messageAttachmentSource(input: { workspaceId: string; messageId: string; storageObjectId: string }, sql: DbClient = getDb()) {
  const [source] = await sql`
    SELECT l.id AS link_id, m.channel_id, m.thread_id FROM flightdeck_pg_storage_links l
    JOIN flightdeck_pg_messages m ON m.workspace_id=l.workspace_id AND m.id=l.entity_id
      AND m.channel_id=l.channel_id AND m.scope_id=l.scope_id AND m.deleted_at IS NULL
    WHERE l.workspace_id=${input.workspaceId} AND l.entity_type='message' AND l.entity_id=${input.messageId}
      AND l.storage_object_id=${input.storageObjectId} AND l.deleted_at IS NULL
      AND (m.thread_id IS NULL OR EXISTS (SELECT 1 FROM flightdeck_pg_threads t
        WHERE t.workspace_id=m.workspace_id AND t.id=m.thread_id AND t.channel_id=m.channel_id AND t.scope_id=m.scope_id AND t.deleted_at IS NULL))
  `;
  return source ?? null;
}

export async function messageAttachmentBlossom(input: {
  workspaceId: string; messageId: string; storageObjectId: string; actorId: string;
  workspaceOwnerNpub: string; origin: string;
}, sql: DbClient = getDb()) {
  const source = await messageAttachmentSource(input, sql);
  if (!source) throw new BlossomPublicationError('attachment_not_found', 404, 'Message attachment is missing or removed');
  const [object] = await sql<V4StorageObject[]>`SELECT * FROM v4_storage_objects WHERE id=${input.storageObjectId} AND owner_npub=${input.workspaceOwnerNpub}`;
  if (!object) throw new BlossomPublicationError('storage_object_not_found', 404, 'Attachment is unavailable in this workspace');
  const verified = await verifyStorageIdentity(object);
  const [refs] = await sql`SELECT COUNT(*)::integer AS publication_count,
    COALESCE(BOOL_OR(actor_id=${input.actorId}),false) AS published_by_you
    FROM flightdeck_pg_blossom_message_publications WHERE workspace_id=${input.workspaceId}
      AND link_id=${source.link_id} AND revoked_at IS NULL`;
  const isPublic = verified ? await hashIsPublic(verified.sha256_hex!, sql) : false;
  return { message_id: input.messageId, attachment: {
    storage_object_id: input.storageObjectId, link_id: source.link_id,
    sha256_hex: verified?.sha256_hex ?? null, available: !!verified,
    ...refs, public: isPublic, blossom_url: isPublic ? `${input.origin}/${verified!.sha256_hex}` : null,
  } };
}

export async function mutateMessageAttachmentBlossom(input: {
  workspaceId: string; messageId: string; storageObjectId: string; actorId: string;
  workspaceOwnerNpub: string; publish: boolean; expectedLinkId?: string; expectedSha256?: string;
}, sql: DbClient) {
  // Message edits/deletion lock this same row. Pin consent to the existing link lifetime.
  const [message] = await sql`SELECT id FROM flightdeck_pg_messages
    WHERE workspace_id=${input.workspaceId} AND id=${input.messageId} AND deleted_at IS NULL FOR UPDATE`;
  const source = message && await messageAttachmentSource(input, sql);
  if (!source) throw new BlossomPublicationError('attachment_not_found', 404, 'Message attachment is missing or removed');
  if (input.expectedLinkId && source.link_id !== input.expectedLinkId)
    throw new BlossomPublicationError('attachment_source_changed', 409, 'Attachment source changed; refresh publication status');
  if (!input.publish) {
    const changed = await sql`UPDATE flightdeck_pg_blossom_message_publications SET revoked_at=NOW()
      WHERE workspace_id=${input.workspaceId} AND link_id=${source.link_id} AND actor_id=${input.actorId} AND revoked_at IS NULL RETURNING link_id`;
    return changed.length > 0;
  }
  const [object] = await sql<V4StorageObject[]>`SELECT * FROM v4_storage_objects WHERE id=${input.storageObjectId} AND owner_npub=${input.workspaceOwnerNpub}`;
  if (!object) throw new BlossomPublicationError('storage_object_not_found', 404, 'Attachment is unavailable in this workspace');
  if (!object.completed_at) throw new BlossomPublicationError('storage_incomplete', 409, 'Attachment upload is not complete');
  const verified = await verifyStorageIdentity(object);
  if (!verified) throw new BlossomPublicationError('storage_unavailable', 409, 'Stored bytes are missing or could not be verified');
  const prior = await sql`SELECT sha256_hex FROM flightdeck_pg_blossom_message_publications
    WHERE workspace_id=${input.workspaceId} AND link_id=${source.link_id}`;
  if (verified.sha256_hex !== input.expectedSha256 || prior.some(p => p.sha256_hex !== verified.sha256_hex))
    throw new BlossomPublicationError('publication_hash_changed', 409, 'Attachment bytes changed; refresh or attach a new object');
  const changed = await sql`INSERT INTO flightdeck_pg_blossom_message_publications
    (workspace_id,message_id,link_id,actor_id,storage_object_id,sha256_hex)
    VALUES (${input.workspaceId},${input.messageId},${source.link_id},${input.actorId},${input.storageObjectId},${verified.sha256_hex!})
    ON CONFLICT (workspace_id,link_id,actor_id) DO UPDATE SET revoked_at=NULL,published_at=NOW()
      WHERE flightdeck_pg_blossom_message_publications.revoked_at IS NOT NULL RETURNING link_id`;
  return changed.length > 0;
}

type AppObjectInput = {
  workspaceId: string; workspaceOwnerNpub: string; appNpub: string;
  storageObjectId: string; actorId: string; actorNpub: string;
};

async function isStorageCreator(object: V4StorageObject, actorNpub: string) {
  return ((await resolveWsKeyNpub(object.created_by_npub)) ?? object.created_by_npub) === actorNpub;
}

/** Create a private standalone object bound to one workspace, app and creating actor. */
export async function prepareAppStorageObject(input: Omit<AppObjectInput, 'storageObjectId'> & { body: PrepareStorageInput }) {
  const object = await prepareStorageObjectForAuthorizedOwner({ ...input.body,
    owner_npub: input.workspaceOwnerNpub, owner_group_id: null, access_group_ids: [], is_public: false,
  }, input.actorNpub, { workspaceId: input.workspaceId });
  await getDb()`INSERT INTO flightdeck_pg_app_storage_objects (storage_object_id,workspace_id,app_npub,actor_id)
    VALUES (${object.id},${input.workspaceId},${input.appNpub},${input.actorId})`;
  return object;
}

/** Only the creator's object, bound to this exact workspace and app, is addressable; all else is not found. */
async function appStorageObject(input: AppObjectInput, sql: DbClient, lock = false) {
  const [object] = await sql<V4StorageObject[]>`SELECT s.* FROM flightdeck_pg_app_storage_objects b
    JOIN v4_storage_objects s ON s.id=b.storage_object_id
    WHERE b.storage_object_id=${input.storageObjectId} AND b.workspace_id=${input.workspaceId}
      AND b.app_npub=${input.appNpub} AND b.actor_id=${input.actorId}
      AND s.pg_workspace_id=${input.workspaceId} AND s.owner_npub=${input.workspaceOwnerNpub}
    ${lock ? sql`FOR UPDATE OF b` : sql``}`;
  if (!object || !await isStorageCreator(object, input.actorNpub))
    throw new BlossomPublicationError('storage_object_not_found', 404, 'App storage object not found');
  return object;
}

/**
 * App publications stay effective only while the app is enabled, the publisher is a current member, the object
 * remains the publisher's unlinked app object, and the stored bytes still match the pinned hash.
 */
async function hasAppBlossomPublication(storageObjectId: string, hash: string, sql: DbClient) {
  const refs = await sql`
    SELECT a.npub, w.id AS workspace_id, w.app_npub AS workspace_app_npub, s.created_by_npub
    FROM flightdeck_pg_app_blossom_publications p
    JOIN flightdeck_pg_app_storage_objects b ON b.storage_object_id=p.storage_object_id
      AND b.actor_id=p.actor_id AND b.workspace_id=p.workspace_id
    JOIN flightdeck_pg_workspaces w ON w.id=b.workspace_id
    JOIN v4_storage_objects s ON s.id=b.storage_object_id AND s.pg_workspace_id=w.id AND s.owner_npub=w.workspace_owner_npub
    JOIN workspace_apps wa ON wa.workspace_owner_npub=w.workspace_owner_npub AND wa.app_npub=b.app_npub AND wa.enabled
    JOIN flightdeck_pg_actors a ON a.id=p.actor_id
    WHERE p.storage_object_id=${storageObjectId} AND p.sha256_hex=${hash} AND p.revoked_at IS NULL
  `;
  if (!refs.length || await hasFlightDeckPgStorageAuthority(storageObjectId, sql)) return false;
  for (const ref of refs) {
    if (((await resolveWsKeyNpub(ref.created_by_npub)) ?? ref.created_by_npub) !== ref.npub) continue;
    const decision = await authorizeFlightDeckPgOperation({ actorNpub: ref.npub, appNpub: ref.workspace_app_npub,
      workspaceId: ref.workspace_id, permission: 'workspace.read', resource: { type: 'workspace' } }, sql);
    if (decision.allowed) return true;
  }
  return false;
}

export async function appObjectBlossom(input: AppObjectInput & { origin: string }, sql: DbClient = getDb()): Promise<WorkspaceAppStorageBlossomStatus> {
  const object = await appStorageObject(input, sql);
  const verified = object.completed_at ? await verifyStorageIdentity(object) : null;
  const linked = await hasFlightDeckPgStorageAuthority(object.id, sql);
  const [own] = await sql`SELECT sha256_hex, published_at FROM flightdeck_pg_app_blossom_publications
    WHERE storage_object_id=${object.id} AND actor_id=${input.actorId} AND revoked_at IS NULL`;
  const active = !!own && verified?.sha256_hex === own.sha256_hex && await hasAppBlossomPublication(object.id, own.sha256_hex, sql);
  const isPublic = verified ? await hashIsPublic(verified.sha256_hex!, sql) : false;
  return {
    app_npub: input.appNpub, storage_object_id: object.id,
    sha256_hex: verified?.sha256_hex ?? null, size_bytes: verified ? Number(verified.size_bytes) : null,
    content_type: object.content_type, completed: !!object.completed_at, available: !!verified, linked,
    published_by_you: !!own, published_sha256: own?.sha256_hex ?? null, published_at: own?.published_at ?? null,
    publication_active: active,
    // Hash URLs are shared by identical bytes: true may come from another publisher's copy.
    public: isPublic, blossom_url: isPublic ? `${input.origin}/${verified!.sha256_hex}` : null,
  };
}

export async function mutateAppObjectBlossom(input: AppObjectInput & { publish: boolean; expectedSha256?: string }, sql: DbClient) {
  // Member removal locks this actor row before revoking. Holding it until commit means a publish either commits
  // first (and is revoked by the removal) or observes the removal; then the binding row serializes repeats.
  await sql`SELECT id FROM flightdeck_pg_actors WHERE id=${input.actorId} FOR KEY SHARE`;
  const object = await appStorageObject(input, sql, true);
  if (!input.publish) {
    const changed = await sql`UPDATE flightdeck_pg_app_blossom_publications SET revoked_at=NOW()
      WHERE storage_object_id=${object.id} AND actor_id=${input.actorId} AND revoked_at IS NULL RETURNING storage_object_id`;
    return changed.length > 0;
  }
  const [workspace] = await sql`SELECT app_npub FROM flightdeck_pg_workspaces WHERE id=${input.workspaceId}`;
  const current = workspace && await authorizeFlightDeckPgOperation({ actorNpub: input.actorNpub, appNpub: workspace.app_npub,
    workspaceId: input.workspaceId, permission: 'workspace.read', resource: { type: 'workspace' } }, sql);
  if (!current || !current.allowed)
    throw new BlossomPublicationError('publisher_authority_changed', 409, 'Workspace membership changed; refresh and retry');
  if (await hasFlightDeckPgStorageAuthority(object.id, sql))
    throw new BlossomPublicationError('storage_object_linked', 409, 'Object is linked to workspace content; upload a standalone copy');
  if (!object.completed_at) throw new BlossomPublicationError('storage_incomplete', 409, 'Upload is not complete');
  const verified = await verifyStorageIdentity(object);
  if (!verified) throw new BlossomPublicationError('storage_unavailable', 409, 'Stored bytes are missing or could not be verified');
  const prior = await sql`SELECT sha256_hex FROM flightdeck_pg_app_blossom_publications WHERE storage_object_id=${object.id}`;
  if (verified.sha256_hex !== input.expectedSha256 || prior.some(p => p.sha256_hex !== verified.sha256_hex))
    throw new BlossomPublicationError('publication_hash_changed', 409, 'Stored bytes differ from the reviewed SHA-256; refresh or upload a new copy');
  const changed = await sql`INSERT INTO flightdeck_pg_app_blossom_publications (storage_object_id,actor_id,workspace_id,sha256_hex)
    VALUES (${object.id},${input.actorId},${input.workspaceId},${verified.sha256_hex!})
    ON CONFLICT (storage_object_id,actor_id) DO UPDATE SET revoked_at=NULL,published_at=NOW()
      WHERE flightdeck_pg_app_blossom_publications.revoked_at IS NOT NULL RETURNING storage_object_id`;
  return changed.length > 0;
}
