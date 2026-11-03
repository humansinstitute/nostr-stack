import { type Sql, isUuid } from './notification-core';

/**
 * Origins and version-bound work-output receipts for strict agent identities.
 *
 * An ORIGIN is a live, non-self notification of the acting identity at a channel (SQL `flightdeck_pg_agent_origin_live`).
 * A client names it explicitly with `origin_notification_id`; Tower never infers one.
 * - On a create (doc/task/file/audio note) a receipt is minted in the create transaction. It grants the creating bot
 *   access to the version IT wrote, never later human edits, comments or newer versions.
 * - On a message carrying a structured self-mention it makes the message eligible for a `self_mention` notification.
 */

export type ReceiptEntityType = 'doc' | 'task' | 'file' | 'audio_note';
export type WorkReceipt = {
  workspace_id: string; recipient_actor_id: string; entity_type: ReceiptEntityType; entity_id: string; channel_id: string;
  origin_notification_id: string; receipt_row_version: string | number; receipt_version_id: string | null; body_sha256_hex: string | null;
};

export const ORIGIN_INVALID = {
  error: 'origin_notification_invalid', code: 'origin_notification_invalid', retryable: false,
  message: 'origin_notification_id must name a live notification of this identity at this location',
} as const;
export const WORK_OUTPUT_CHANGED = { error: 'work_output_changed', code: 'work_output_changed', retryable: false } as const;
/** Same body as the ceiling's refusal: a receipt that is no longer live grants nothing. */
export const RECEIPT_NOT_LIVE = {
  error: 'agent_notification_upgrade_required', code: 'agent_notification_upgrade_required', retryable: false,
  message: 'This identity is a notification-only agent here. Use the agent-notifications API (capability agent_notifications.v1).',
  required_capability: 'agent_notifications.v1',
} as const;

export class WorkReceiptRefusal extends Error {
  constructor(readonly status: 403 | 409, readonly body: Record<string, unknown>) {
    super(String(body.code));
  }
}

/** `origin_notification_id` from a JSON body: undefined when absent, null when present but not a UUID. */
export function parseOriginNotificationId(body: Record<string, unknown> | null | undefined): string | null | undefined {
  if (!body || body.origin_notification_id === undefined || body.origin_notification_id === null) return undefined;
  const value = body.origin_notification_id;
  return typeof value === 'string' && isUuid(value) ? value.toLowerCase() : null;
}

export const originValidationError = { path: 'origin_notification_id', code: 'invalid', message: 'origin_notification_id must be a notification UUID' };

/**
 * Whether `notificationId` is a live origin of `actorId` at `channelId`. With `threadId` (a message location) the
 * origin must also be a message notification in that same thread. `lock` holds the origin row FOR SHARE until commit.
 */
export async function liveOrigin(sql: Sql, input: {
  workspaceId: string; actorId: string; notificationId: string; channelId: string; threadId?: string | null; lock?: boolean;
}): Promise<boolean> {
  if (!isUuid(input.notificationId) || !isUuid(input.channelId)) return false;
  if (input.lock) {
    // Hold everything the origin's liveness reads, so a concurrent revocation (subscription revoke, grant change on
    // the channel, mention removal on the source message) either committed before this check or waits for our commit.
    const [origin] = await sql<{ source_type: string; source_id: string }[]>`
      SELECT source_type, source_id FROM flightdeck_pg_agent_notifications WHERE id = ${input.notificationId} AND workspace_id = ${input.workspaceId}
        AND recipient_actor_id = ${input.actorId} FOR SHARE`;
    if (!origin) return false;
    await sql`SELECT 1 FROM flightdeck_pg_agent_notification_subscriptions WHERE workspace_id = ${input.workspaceId}
      AND recipient_actor_id = ${input.actorId} AND revoked_at IS NULL ORDER BY id FOR SHARE`;
    const [channel] = await sql<{ scope_id: string }[]>`
      SELECT scope_id FROM flightdeck_pg_channels WHERE workspace_id = ${input.workspaceId} AND id = ${input.channelId} FOR SHARE`;
    if (channel) await sql`SELECT 1 FROM flightdeck_pg_scopes WHERE workspace_id = ${input.workspaceId} AND id = ${channel.scope_id} FOR SHARE`;
    if (origin.source_type === 'message') {
      await sql`SELECT 1 FROM flightdeck_pg_messages WHERE workspace_id = ${input.workspaceId} AND id = ${origin.source_id} FOR SHARE`;
    }
  }
  const threadScoped = input.threadId !== undefined;
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT flightdeck_pg_agent_origin_live(${input.notificationId}::uuid, ${input.workspaceId}::uuid, ${input.actorId}::uuid, ${input.channelId}::uuid)
      AND (NOT ${threadScoped}::boolean OR EXISTS (SELECT 1 FROM flightdeck_pg_agent_notifications o WHERE o.id = ${input.notificationId}::uuid
        AND o.source_type = 'message' AND o.thread_id IS NOT DISTINCT FROM ${input.threadId ?? null}::uuid)) AS ok`;
  return Boolean(row?.ok);
}

export function serializeWorkReceipt(r: WorkReceipt) {
  return {
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    receipt_row_version: Number(r.receipt_row_version),
    origin_notification_id: r.origin_notification_id,
    body_sha256_hex: r.body_sha256_hex ?? null,
    version_id: r.receipt_version_id ?? null,
  };
}

/** Mint a receipt inside the create transaction. Throws 403 origin_notification_invalid unless the origin is live. */
export async function mintWorkReceipt(tx: Sql, input: {
  workspaceId: string; actorId: string; originNotificationId: string; channelId: string; entityType: ReceiptEntityType; entityId: string;
  rowVersion: number; versionId?: string | null; bodySha256Hex?: string | null;
}) {
  if (!await liveOrigin(tx, { workspaceId: input.workspaceId, actorId: input.actorId, notificationId: input.originNotificationId, channelId: input.channelId, lock: true })) {
    throw new WorkReceiptRefusal(403, ORIGIN_INVALID);
  }
  const [receipt] = await tx<WorkReceipt[]>`
    INSERT INTO flightdeck_pg_agent_work_receipts (workspace_id, recipient_actor_id, entity_type, entity_id, channel_id, origin_notification_id,
      receipt_row_version, receipt_version_id, body_sha256_hex)
    VALUES (${input.workspaceId}, ${input.actorId}, ${input.entityType}, ${input.entityId}, ${input.channelId}, ${input.originNotificationId},
      ${input.rowVersion}, ${input.versionId ?? null}, ${input.bodySha256Hex ?? null})
    RETURNING *`;
  return serializeWorkReceipt(receipt!);
}

/** The actor's receipt for an entity while its origin is live (ceiling and handler use the same predicate). */
export async function activeWorkReceipt(sql: Sql, input: { workspaceId: string; actorId: string; entityType: ReceiptEntityType; entityId: string; lock?: boolean }) {
  if (!isUuid(input.entityId)) return null;
  const [receipt] = input.lock
    ? await sql<WorkReceipt[]>`
      SELECT r.* FROM flightdeck_pg_agent_work_receipts r
      WHERE r.workspace_id = ${input.workspaceId} AND r.recipient_actor_id = ${input.actorId} AND r.entity_type = ${input.entityType} AND r.entity_id = ${input.entityId}
      FOR UPDATE`
    : await sql<WorkReceipt[]>`
      SELECT r.* FROM flightdeck_pg_agent_work_receipts r
      WHERE r.workspace_id = ${input.workspaceId} AND r.recipient_actor_id = ${input.actorId} AND r.entity_type = ${input.entityType} AND r.entity_id = ${input.entityId}`;
  if (!receipt) return null;
  const live = await liveOrigin(sql, { workspaceId: input.workspaceId, actorId: input.actorId, notificationId: receipt.origin_notification_id, channelId: receipt.channel_id, lock: input.lock });
  return live ? receipt : null;
}

// The ceiling records which receipt admitted a request; handlers then apply the version guard to that request only.
// A request admitted through an ordinary notification binding carries no receipt and keeps the existing policy.
const admissions = new WeakMap<Request, WorkReceipt>();

export function rememberReceiptAdmission(request: Request, receipt: WorkReceipt) {
  admissions.set(request, receipt);
}

export function receiptAdmission(request: Request, entityType: ReceiptEntityType, entityId: string): WorkReceipt | null {
  const receipt = admissions.get(request);
  return receipt && receipt.entity_type === entityType && receipt.entity_id === entityId ? receipt : null;
}

/**
 * Read guard: the version the handler LOADED must be the receipted one, and the receipt must still be live. Compared
 * against the loaded row, so a concurrent human edit can never be served through the receipt.
 */
export async function assertReceiptedVersion(sql: Sql, admitted: WorkReceipt, loaded: { rowVersion?: number; versionId?: string | null; bodySha256Hex?: string | null }) {
  const current = await activeWorkReceipt(sql, { workspaceId: admitted.workspace_id, actorId: admitted.recipient_actor_id, entityType: admitted.entity_type, entityId: admitted.entity_id });
  if (!current) throw new WorkReceiptRefusal(403, RECEIPT_NOT_LIVE);
  if (loaded.rowVersion !== undefined && Number(current.receipt_row_version) !== Number(loaded.rowVersion)) throw new WorkReceiptRefusal(409, WORK_OUTPUT_CHANGED);
  if (loaded.versionId !== undefined && current.receipt_version_id !== loaded.versionId) throw new WorkReceiptRefusal(409, WORK_OUTPUT_CHANGED);
  // Content identity too: a body or object swapped without a row_version change is still a different version.
  if (loaded.bodySha256Hex !== undefined && current.body_sha256_hex && current.body_sha256_hex !== loaded.bodySha256Hex) throw new WorkReceiptRefusal(409, WORK_OUTPUT_CHANGED);
  return current;
}

/**
 * Update guard, inside the handler transaction: lock the receipt and require the current entity version (and the
 * request's base, when given) to equal it. Concurrent updates serialize on the receipt row.
 */
export async function lockReceiptForUpdate(tx: Sql, admitted: WorkReceipt, current: { rowVersion: number; baseRowVersion?: number | null; bodySha256Hex?: string | null }) {
  const receipt = await activeWorkReceipt(tx, { workspaceId: admitted.workspace_id, actorId: admitted.recipient_actor_id, entityType: admitted.entity_type, entityId: admitted.entity_id, lock: true });
  if (!receipt) throw new WorkReceiptRefusal(403, RECEIPT_NOT_LIVE);
  if (!receiptMatches(receipt, current)) throw new WorkReceiptRefusal(409, WORK_OUTPUT_CHANGED);
  return receipt;
}

function receiptMatches(receipt: WorkReceipt, current: { rowVersion: number; baseRowVersion?: number | null; bodySha256Hex?: string | null }) {
  const version = Number(receipt.receipt_row_version);
  if (version !== Number(current.rowVersion)) return false;
  if (current.baseRowVersion != null && Number(current.baseRowVersion) !== version) return false;
  return !(current.bodySha256Hex !== undefined && receipt.body_sha256_hex && receipt.body_sha256_hex !== current.bodySha256Hex);
}

/**
 * An update by a caller the ceiling did NOT route through a receipt (an unrestricted identity): its own receipt for the
 * entity, locked, when it still matches the version being replaced. It then follows the update; otherwise it is left
 * unchanged (it never grants anything to an unrestricted identity, which keeps its normal access).
 */
export async function matchingOwnReceipt(tx: Sql, input: { workspaceId: string; actorId: string; entityType: ReceiptEntityType; entityId: string }, current: { rowVersion: number; baseRowVersion?: number | null; bodySha256Hex?: string | null }) {
  const receipt = await activeWorkReceipt(tx, { ...input, lock: true });
  return receipt && receiptMatches(receipt, current) ? receipt : null;
}

/**
 * After the bot's own successful update: the receipt follows the version it just wrote (same transaction, compare and
 * set on the locked version). A receipt that did not advance fails the whole update with 409.
 */
export async function advanceWorkReceipt(tx: Sql, receipt: WorkReceipt, next: { rowVersion: number; bodySha256Hex?: string | null; versionId?: string | null }) {
  const [advanced] = await tx<WorkReceipt[]>`
    UPDATE flightdeck_pg_agent_work_receipts SET receipt_row_version = ${next.rowVersion},
      body_sha256_hex = COALESCE(${next.bodySha256Hex ?? null}, body_sha256_hex),
      receipt_version_id = COALESCE(${next.versionId ?? null}::uuid, receipt_version_id), updated_at = NOW()
    WHERE workspace_id = ${receipt.workspace_id} AND recipient_actor_id = ${receipt.recipient_actor_id}
      AND entity_type = ${receipt.entity_type} AND entity_id = ${receipt.entity_id} AND receipt_row_version = ${receipt.receipt_row_version}
    RETURNING *`;
  if (!advanced) throw new WorkReceiptRefusal(409, WORK_OUTPUT_CHANGED);
  return serializeWorkReceipt(advanced);
}
