import { getDb } from '../db';
import type { FlightDeckPgFile } from '../types';
import { resolveFlightDeckPgFileVersion } from './flightdeck-pg-api';

type DbClient = ReturnType<typeof getDb>;
type DbJsonValue = Parameters<DbClient['json']>[0];

function asDbJson(value: Record<string, unknown>): DbJsonValue {
  return value as DbJsonValue;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

const SPOOFED_AUTHOR_FIELDS = [
  'created_by_actor_id',
  'created_by_actor_npub',
  'updated_by_actor_id',
  'updated_by_actor_npub',
  'author',
  'author_id',
  'author_npub',
  'actor_id',
  'actor_npub',
  'sender_npub',
] as const;

export type FileCommentStatus = 'open' | 'resolved';

export type FileCommentAnchor = {
  kind: 'html_element' | 'document';
  element_id?: string;
  selector?: string;
  dom_path?: number[];
  tag_name?: string;
  text_quote?: string;
  text_prefix?: string;
  text_suffix?: string;
  attr_fingerprint?: string;
  file_version_id?: string;
  file_version_number?: number;
  version_digest?: string;
};

export type FlightDeckPgFileCommentRow = {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  file_id: string;
  file_version_id: string;
  file_version_number?: number | null;
  parent_comment_id: string | null;
  body: string;
  comment_status: FileCommentStatus;
  anchor: Record<string, unknown>;
  metadata: Record<string, unknown>;
  client_request_id: string | null;
  created_by_actor_id: string;
  created_by_actor_npub?: string | null;
  updated_by_actor_id: string;
  updated_by_actor_npub?: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type FileCommentViewerCapabilities = {
  actorId: string;
  canComment: boolean;
  canEditSource: boolean;
  canModerate: boolean;
};

export type ValidationFieldError = { path: string; code: string; message: string };

export function findSpoofedFileCommentAuthorFields(body: Record<string, unknown>): ValidationFieldError[] {
  const errors: ValidationFieldError[] = [];
  for (const key of SPOOFED_AUTHOR_FIELDS) {
    if (body[key] !== undefined) {
      errors.push({
        path: key,
        code: 'forbidden_author_field',
        message: `${key} is derived from the verified NIP-98 signer and cannot be supplied by the client`,
      });
    }
  }
  return errors;
}

function boundedOptionalString(
  obj: Record<string, unknown>,
  key: string,
  maxLen: number,
  errors: ValidationFieldError[],
): string | undefined {
  const raw = obj[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    errors.push({ path: `anchor.${key}`, code: 'invalid', message: `anchor.${key} must be a string` });
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLen) {
    errors.push({ path: `anchor.${key}`, code: 'too_long', message: `anchor.${key} must be at most ${maxLen} characters` });
    return undefined;
  }
  return trimmed;
}

export function validateFileCommentAnchor(
  raw: unknown,
  version: { id: string; versionNumber: number },
): { anchor: FileCommentAnchor; errors: ValidationFieldError[] } {
  const errors: ValidationFieldError[] = [];
  if (raw === undefined || raw === null) {
    return {
      anchor: {
        kind: 'document',
        file_version_id: version.id,
        file_version_number: version.versionNumber,
      },
      errors,
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      anchor: { kind: 'document', file_version_id: version.id, file_version_number: version.versionNumber },
      errors: [{ path: 'anchor', code: 'invalid', message: 'anchor must be an object when provided' }],
    };
  }
  const obj = raw as Record<string, unknown>;
  const rawKind = obj.kind === undefined ? 'html_element' : String(obj.kind).trim();
  if (rawKind !== 'html_element' && rawKind !== 'document') {
    errors.push({ path: 'anchor.kind', code: 'invalid', message: 'anchor.kind must be html_element or document' });
  }
  const elementId = boundedOptionalString(obj, 'element_id', 256, errors);
  const selector = boundedOptionalString(obj, 'selector', 1024, errors);
  const tagName = boundedOptionalString(obj, 'tag_name', 64, errors)?.toLowerCase();
  const textQuote = boundedOptionalString(obj, 'text_quote', 240, errors);
  const textPrefix = boundedOptionalString(obj, 'text_prefix', 120, errors);
  const textSuffix = boundedOptionalString(obj, 'text_suffix', 120, errors);
  const attrFingerprint = boundedOptionalString(obj, 'attr_fingerprint', 256, errors);
  const versionDigest = boundedOptionalString(obj, 'version_digest', 64, errors)?.toLowerCase();
  if (versionDigest && !SHA256_RE.test(versionDigest)) {
    errors.push({ path: 'anchor.version_digest', code: 'invalid', message: 'anchor.version_digest must be a 64-char sha256 hex string' });
  }

  let domPath: number[] | undefined;
  if (obj.dom_path !== undefined && obj.dom_path !== null) {
    if (!Array.isArray(obj.dom_path) || obj.dom_path.length > 64) {
      errors.push({ path: 'anchor.dom_path', code: 'invalid', message: 'anchor.dom_path must be an array of up to 64 non-negative integers' });
    } else {
      const parsed: number[] = [];
      for (const item of obj.dom_path) {
        if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 100000) {
          errors.push({ path: 'anchor.dom_path', code: 'invalid', message: 'anchor.dom_path entries must be non-negative integers' });
          break;
        }
        parsed.push(item);
      }
      if (parsed.length > 0) domPath = parsed;
    }
  }

  if (obj.file_version_id !== undefined && obj.file_version_id !== null) {
    const supplied = String(obj.file_version_id).trim().toLowerCase();
    if (!UUID_RE.test(supplied) || supplied !== version.id.toLowerCase()) {
      errors.push({ path: 'anchor.file_version_id', code: 'mismatch', message: 'anchor.file_version_id must match the target file_version_id' });
    }
  }

  if (rawKind === 'html_element' && !elementId && !selector && (!domPath || domPath.length === 0)) {
    errors.push({ path: 'anchor', code: 'missing_target', message: 'html_element anchor requires element_id, selector, or dom_path' });
  }

  const anchor: FileCommentAnchor = {
    kind: rawKind === 'document' ? 'document' : 'html_element',
    ...(elementId ? { element_id: elementId } : {}),
    ...(selector ? { selector } : {}),
    ...(domPath ? { dom_path: domPath } : {}),
    ...(tagName ? { tag_name: tagName } : {}),
    ...(textQuote ? { text_quote: textQuote } : {}),
    ...(textPrefix ? { text_prefix: textPrefix } : {}),
    ...(textSuffix ? { text_suffix: textSuffix } : {}),
    ...(attrFingerprint ? { attr_fingerprint: attrFingerprint } : {}),
    file_version_id: version.id,
    file_version_number: version.versionNumber,
    ...(versionDigest ? { version_digest: versionDigest } : {}),
  };

  return { anchor, errors };
}

export function serializeFlightDeckPgFileComment(
  comment: FlightDeckPgFileCommentRow,
  viewer?: FileCommentViewerCapabilities,
) {
  const isAuthor = viewer ? comment.created_by_actor_id === viewer.actorId : false;
  const isRoot = comment.parent_comment_id === null;
  const canEdit = viewer ? viewer.canComment && (isAuthor || viewer.canModerate) : undefined;
  const canResolve = viewer
    ? isRoot && viewer.canComment && (isAuthor || viewer.canEditSource || viewer.canModerate)
    : undefined;
  const canDelete = viewer ? viewer.canComment && (isAuthor || viewer.canModerate) : undefined;

  return {
    id: comment.id,
    workspace_id: comment.workspace_id,
    scope_id: comment.scope_id,
    channel_id: comment.channel_id,
    file_id: comment.file_id,
    file_version_id: comment.file_version_id,
    file_version_number: comment.file_version_number === undefined || comment.file_version_number === null
      ? null
      : Number(comment.file_version_number),
    parent_comment_id: comment.parent_comment_id,
    body: comment.body,
    comment_status: comment.comment_status,
    anchor: comment.anchor ?? {},
    metadata: comment.metadata ?? {},
    client_request_id: comment.client_request_id ?? null,
    record_state: comment.deleted_at ? 'deleted' : 'active',
    deleted_at: comment.deleted_at,
    row_version: Number(comment.row_version),
    created_by_actor_id: comment.created_by_actor_id,
    created_by_actor_npub: comment.created_by_actor_npub ?? null,
    sender_npub: comment.created_by_actor_npub ?? null,
    updated_by_actor_id: comment.updated_by_actor_id,
    updated_by_actor_npub: comment.updated_by_actor_npub ?? null,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    ...(viewer ? { can_edit: canEdit, can_resolve: canResolve, can_delete: canDelete } : {}),
  };
}

export async function listFlightDeckPgFileComments(
  input: {
    workspaceId: string;
    fileId: string;
    versionId?: string | null;
    status?: FileCommentStatus | null;
    limit: number;
    afterCreatedAt?: Date | string | null;
    afterId?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileCommentRow[]> {
  const versionFilter = input.versionId ? sql`AND c.file_version_id = ${input.versionId}` : sql``;
  // Filter by the discussion root's status so resolved roots never leave orphaned open replies.
  const statusFilter = input.status
    ? sql`AND COALESCE(root.comment_status, c.comment_status) = ${input.status}`
    : sql``;
  const cursorFilter = input.afterCreatedAt && input.afterId
    ? sql`AND (c.created_at, c.id) > (${input.afterCreatedAt}, ${input.afterId})`
    : sql``;

  return sql<FlightDeckPgFileCommentRow[]>`
    SELECT
      c.*,
      v.version_number AS file_version_number,
      ca.npub AS created_by_actor_npub,
      ua.npub AS updated_by_actor_npub
    FROM flightdeck_pg_file_comments c
    LEFT JOIN flightdeck_pg_file_comments root
      ON root.workspace_id = c.workspace_id AND root.file_id = c.file_id AND root.id = c.parent_comment_id
    LEFT JOIN flightdeck_pg_file_versions v
      ON v.workspace_id = c.workspace_id AND v.id = c.file_version_id
    LEFT JOIN flightdeck_pg_actors ca ON ca.id = c.created_by_actor_id
    LEFT JOIN flightdeck_pg_actors ua ON ua.id = c.updated_by_actor_id
    WHERE c.workspace_id = ${input.workspaceId}
      AND c.file_id = ${input.fileId}
      AND c.deleted_at IS NULL
      AND (c.parent_comment_id IS NULL OR (root.id IS NOT NULL AND root.deleted_at IS NULL))
      ${versionFilter}
      ${statusFilter}
      ${cursorFilter}
    ORDER BY c.created_at ASC, c.id ASC
    LIMIT ${input.limit}
  `;
}

export async function resolveFlightDeckPgFileComment(
  workspaceId: string,
  fileId: string,
  commentId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileCommentRow | null> {
  if (!UUID_RE.test(commentId)) return null;
  const [row] = await sql<FlightDeckPgFileCommentRow[]>`
    SELECT
      c.*,
      v.version_number AS file_version_number,
      ca.npub AS created_by_actor_npub,
      ua.npub AS updated_by_actor_npub
    FROM flightdeck_pg_file_comments c
    LEFT JOIN flightdeck_pg_file_versions v
      ON v.workspace_id = c.workspace_id AND v.id = c.file_version_id
    LEFT JOIN flightdeck_pg_actors ca ON ca.id = c.created_by_actor_id
    LEFT JOIN flightdeck_pg_actors ua ON ua.id = c.updated_by_actor_id
    WHERE c.workspace_id = ${workspaceId}
      AND c.file_id = ${fileId}
      AND c.id = ${commentId}
      AND c.deleted_at IS NULL
    LIMIT 1
  `;
  return row ?? null;
}

export async function findFlightDeckPgFileCommentByClientRequestId(
  input: { workspaceId: string; fileId: string; actorId: string; clientRequestId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileCommentRow | null> {
  const [row] = await sql<FlightDeckPgFileCommentRow[]>`
    SELECT
      c.*,
      v.version_number AS file_version_number,
      ca.npub AS created_by_actor_npub,
      ua.npub AS updated_by_actor_npub
    FROM flightdeck_pg_file_comments c
    LEFT JOIN flightdeck_pg_file_versions v
      ON v.workspace_id = c.workspace_id AND v.id = c.file_version_id
    LEFT JOIN flightdeck_pg_actors ca ON ca.id = c.created_by_actor_id
    LEFT JOIN flightdeck_pg_actors ua ON ua.id = c.updated_by_actor_id
    WHERE c.workspace_id = ${input.workspaceId}
      AND c.file_id = ${input.fileId}
      AND c.created_by_actor_id = ${input.actorId}
      AND c.client_request_id = ${input.clientRequestId}
    LIMIT 1
  `;
  return row ?? null;
}

function replayPayloadMatches(
  existing: FlightDeckPgFileCommentRow,
  candidate: { body: string; parentCommentId: string | null; fileVersionId: string },
): boolean {
  return existing.body === candidate.body
    && (existing.parent_comment_id ?? null) === (candidate.parentCommentId ?? null)
    && existing.file_version_id === candidate.fileVersionId;
}

export type CreateFileCommentResult =
  | { status: 'created'; comment: FlightDeckPgFileCommentRow; replayed: boolean }
  | { status: 'idempotency_conflict' }
  | { status: 'parent_not_found' }
  | { status: 'nested_reply_not_allowed' }
  | { status: 'version_not_found' }
  | { status: 'validation_error'; fields: ValidationFieldError[] };

export async function createFlightDeckPgFileComment(
  input: {
    workspaceId: string;
    file: FlightDeckPgFile;
    fileVersionId?: string | null;
    parentCommentId?: string | null;
    body: string;
    anchor?: unknown;
    metadata?: Record<string, unknown>;
    clientRequestId?: string | null;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<CreateFileCommentResult> {
  let resolvedVersionId: string;
  let resolvedAnchor: Record<string, unknown>;

  if (input.parentCommentId) {
    const parent = await resolveFlightDeckPgFileComment(input.workspaceId, input.file.id, input.parentCommentId, sql);
    if (!parent) return { status: 'parent_not_found' };
    if (parent.parent_comment_id !== null) return { status: 'nested_reply_not_allowed' };
    // Reply always inherits its root comment's immutable file_version_id and anchor.
    resolvedVersionId = parent.file_version_id;
    resolvedAnchor = parent.anchor && typeof parent.anchor === 'object' ? parent.anchor : {};
  } else {
    const targetVersionId = input.fileVersionId || input.file.current_version_id;
    if (!targetVersionId || !UUID_RE.test(targetVersionId)) return { status: 'version_not_found' };
    const version = await resolveFlightDeckPgFileVersion({
      workspaceId: input.workspaceId,
      versionId: targetVersionId,
    }, sql);
    if (!version || version.file_id !== input.file.id || version.operation === 'deleted') {
      return { status: 'version_not_found' };
    }
    const validated = validateFileCommentAnchor(input.anchor, {
      id: version.id,
      versionNumber: Number(version.version_number),
    });
    if (validated.errors.length) {
      return { status: 'validation_error', fields: validated.errors };
    }
    resolvedVersionId = version.id;
    resolvedAnchor = validated.anchor;
  }

  // Atomic idempotent insert: simultaneous retries with the same client_request_id never abort the transaction.
  const [inserted] = await sql<FlightDeckPgFileCommentRow[]>`
    INSERT INTO flightdeck_pg_file_comments (
      workspace_id,
      scope_id,
      channel_id,
      file_id,
      file_version_id,
      parent_comment_id,
      body,
      comment_status,
      anchor,
      metadata,
      client_request_id,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.file.scope_id},
      ${input.file.channel_id},
      ${input.file.id},
      ${resolvedVersionId},
      ${input.parentCommentId ?? null},
      ${input.body},
      'open',
      ${sql.json(asDbJson(resolvedAnchor))},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.clientRequestId ?? null},
      ${input.actorId},
      ${input.actorId}
    )
    ON CONFLICT (workspace_id, file_id, created_by_actor_id, client_request_id)
      WHERE client_request_id IS NOT NULL
      DO NOTHING
    RETURNING *
  `;

  if (!inserted && input.clientRequestId) {
    const existing = await findFlightDeckPgFileCommentByClientRequestId({
      workspaceId: input.workspaceId,
      fileId: input.file.id,
      actorId: input.actorId,
      clientRequestId: input.clientRequestId,
    }, sql);
    if (existing) {
      if (!replayPayloadMatches(existing, {
        body: input.body,
        parentCommentId: input.parentCommentId ?? null,
        fileVersionId: resolvedVersionId,
      })) {
        return { status: 'idempotency_conflict' };
      }
      return { status: 'created', comment: existing, replayed: true };
    }
  }

  const hydrated = await resolveFlightDeckPgFileComment(input.workspaceId, input.file.id, inserted!.id, sql);
  return { status: 'created', comment: hydrated ?? inserted!, replayed: false };
}

export async function updateFlightDeckPgFileComment(
  input: {
    workspaceId: string;
    fileId: string;
    commentId: string;
    actorId: string;
    rowVersion: number;
    body?: string;
    commentStatus?: FileCommentStatus;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileCommentRow | null> {
  const [updated] = await sql<FlightDeckPgFileCommentRow[]>`
    UPDATE flightdeck_pg_file_comments
    SET
      body = COALESCE(${input.body ?? null}, body),
      comment_status = COALESCE(${input.commentStatus ?? null}, comment_status),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND file_id = ${input.fileId}
      AND id = ${input.commentId}
      AND deleted_at IS NULL
      AND row_version = ${input.rowVersion}
    RETURNING *
  `;
  if (!updated) return null;
  return (await resolveFlightDeckPgFileComment(input.workspaceId, input.fileId, updated.id, sql)) ?? updated;
}

export async function deleteFlightDeckPgFileComment(
  input: {
    workspaceId: string;
    fileId: string;
    commentId: string;
    actorId: string;
    rowVersion: number;
  },
  sql: DbClient = getDb(),
): Promise<{ comment: FlightDeckPgFileCommentRow; cascadedReplyCount: number } | null> {
  const [deleted] = await sql<FlightDeckPgFileCommentRow[]>`
    UPDATE flightdeck_pg_file_comments
    SET
      deleted_at = NOW(),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND file_id = ${input.fileId}
      AND id = ${input.commentId}
      AND deleted_at IS NULL
      AND row_version = ${input.rowVersion}
    RETURNING *
  `;
  if (!deleted) return null;
  let cascadedReplyCount = 0;
  if (deleted.parent_comment_id === null) {
    // Cascade soft-delete thread replies so no reply is stranded with an invisible parent.
    const cascaded = await sql<{ id: string }[]>`
      UPDATE flightdeck_pg_file_comments
      SET
        deleted_at = NOW(),
        updated_by_actor_id = ${input.actorId},
        row_version = row_version + 1,
        updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId}
        AND file_id = ${input.fileId}
        AND parent_comment_id = ${deleted.id}
        AND deleted_at IS NULL
      RETURNING id
    `;
    cascadedReplyCount = cascaded.length;
  }
  return { comment: deleted, cascadedReplyCount };
}
