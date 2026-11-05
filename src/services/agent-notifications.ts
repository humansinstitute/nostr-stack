import type { AgentNotificationContextChannel } from '../types';
import { createHash } from 'node:crypto';
import { nip19, verifyEvent } from 'nostr-tools';
import { getDb } from '../db';
import { getEffectiveRequestUrl } from '../auth';
import { type Sql, isUuid, signCursor, verifyCursor, NotificationError } from './notification-core';
import { resolveWsKeyNpub } from './user-workspace-keys';
import { normalizeFlightDeckPgChannelMetadata } from './flightdeck-pg-agent-direct';
import { flightDeckPgCanonicalDocVersionId, listEffectiveFlightDeckPgThreadMessages, serializeFlightDeckPgDocVersionIdentity } from './flightdeck-pg-api';
import { getStorageObjectContent } from './storage';

/**
 * Strict agent notification inbox (contract: docs/contract/agent-notifications-v1.md).
 *
 * Boundary: a notification-only bot receives only rows addressed to its verified identity plus explicitly authorized,
 * recipient-bound context. Every request is a fresh exact-request NIP-98 event (u, method, nonce, payload on bodies,
 * <=60s) consumed once. The recipient is always the verified signer: there is no audience parameter and no fallback to
 * the workspace visibility feed, including on errors.
 */

export const AGENT_NOTIFICATION_POLICY_VERSION = 1;
export const AGENT_NOTIFICATION_CAPABILITY = 'agent_notifications.v1';
export const AGENT_NOTIFICATION_FLOOR_SECONDS = 24 * 3600;
export const AGENT_NOTIFICATION_PAGE_MAX = 100;
export const AGENT_NOTIFICATION_STREAM_MAX_SECONDS = 600;
const STRICT_MAX_AGE_SECONDS = 60;
const CURSOR_ROUTE = 'agent_notifications';
export const WINDOW_MESSAGES = 20;
export const WINDOW_BYTES = 32 * 1024;
const TRANSCRIPT_SCAN_PAGES = 20;
const DOC_BODY_MAX_BYTES = 2 * 1024 * 1024;
const SERIALIZATION_RETRIES = 5;
const ACK_OUTCOMES = ['handled', 'suppressed', 'source_gone', 'failed_permanent'] as const;
export type AckOutcome = typeof ACK_OUTCOMES[number];
export type ContextPolicy = 'bounded_transcript' | 'trigger_only';

export function agentNotificationApiEnabled() {
  return (Bun.env.AGENT_NOTIF_API ?? 'on').toLowerCase() !== 'off';
}
/** Default: bounded effective transcript (inherited lineage, 20 messages / 32 KiB). trigger_only is the stricter option. */
export function agentNotificationContextPolicy(): ContextPolicy {
  return (Bun.env.AGENT_NOTIF_CONTEXT_POLICY ?? '').toLowerCase() === 'trigger_only' ? 'trigger_only' : 'bounded_transcript';
}

export class AgentNotificationError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 500 | 503, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message ?? code);
  }
}
export const fail = (status: AgentNotificationError['status'], code: string, message?: string, extra?: Record<string, unknown>) => new AgentNotificationError(status, code, message, extra);
/** Unknown, foreign and other-recipient ids are byte-identical (no existence oracle). */
const notFound = () => fail(404, 'notification_not_found', 'Notification not found');

// ------------------------------------------------------------------------------------------------------------------
// Strict exact-request NIP-98 with atomic replay detection.
// ------------------------------------------------------------------------------------------------------------------
export type StrictAuth = { signerNpub: string; userNpub: string; eventId: string };

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export async function verifyAgentNotificationRequest(request: Request, rawBody: string, route: string, sql: Sql = getDb()): Promise<StrictAuth> {
  const url = getEffectiveRequestUrl(request);
  if (url.searchParams.has('token')) throw fail(401, 'nip98_header_required', 'Agent notification routes accept NIP-98 only in the Authorization header');
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Nostr ')) throw fail(401, 'nip98_auth_required', 'NIP-98 authorization required');
  let event: any;
  try { event = JSON.parse(Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')); } catch { throw fail(401, 'nip98_invalid_encoding'); }
  let valid = false;
  try { valid = verifyEvent(event); } catch { valid = false; }
  if (!valid || event.kind !== 27235) throw fail(401, 'nip98_invalid_event');
  const tags: string[][] = Array.isArray(event.tags) ? event.tags : [];
  const values = (name: string) => tags.filter((t) => Array.isArray(t) && t[0] === name);
  const single = (name: string) => {
    const found = values(name);
    return found.length === 1 && typeof found[0]![1] === 'string' ? found[0]![1] : null;
  };
  const u = single('u');
  try { if (!u || new URL(u).toString() !== url.toString()) throw new Error('mismatch'); } catch { throw fail(401, 'nip98_url_mismatch'); }
  if ((single('method') ?? '').toUpperCase() !== request.method.toUpperCase()) throw fail(401, 'nip98_method_mismatch');
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(event.created_at) || Math.abs(now - event.created_at) > STRICT_MAX_AGE_SECONDS) throw fail(401, 'nip98_stale_event');
  // Body-bearing requests must bind the exact body. Bodyless GET/HEAD/DELETE may omit the tag; if present it must match.
  const bodyless = ['GET', 'HEAD', 'DELETE'].includes(request.method.toUpperCase()) && rawBody === '';
  const payloadTags = values('payload');
  const payload = payloadTags.length === 1 && typeof payloadTags[0]![1] === 'string' ? payloadTags[0]![1].toLowerCase() : null;
  if ((!bodyless || payloadTags.length) && (payloadTags.length !== 1 || payload !== sha256Hex(rawBody))) {
    throw fail(401, 'nip98_payload_mismatch', 'A payload tag binding the exact body is required');
  }
  const nonce = single('nonce');
  if (!nonce || nonce.length < 16 || nonce.length > 128) throw fail(401, 'nip98_nonce_required', 'A unique nonce tag (16-128 chars) is required');
  const signerNpub = nip19.npubEncode(event.pubkey);
  const consumed = await sql`
    INSERT INTO flightdeck_pg_nip98_consumed_events (event_id, signer_npub, route) VALUES (${String(event.id)}, ${signerNpub}, ${route})
    ON CONFLICT (event_id) DO NOTHING RETURNING event_id`;
  if (!consumed.length) throw fail(401, 'nip98_replayed', 'This signed request was already used');
  const userNpub = (await resolveWsKeyNpub(signerNpub)) ?? signerNpub;
  return { signerNpub, userNpub, eventId: String(event.id) };
}

// ------------------------------------------------------------------------------------------------------------------
// Recipient context.
// ------------------------------------------------------------------------------------------------------------------
export type Recipient = { workspaceId: string; actorId: string; npub: string; kind: string; classified: boolean; appNpub: string };

export async function resolveRecipient(sql: Sql, workspaceId: string, npub: string): Promise<Recipient> {
  if (!isUuid(workspaceId)) throw fail(404, 'workspace_not_found', 'Workspace not found');
  const [row] = await sql<{ workspace_id: string; app_npub: string; actor_id: string | null; kind: string | null; member: boolean; classified: boolean }[]>`
    SELECT w.id AS workspace_id, w.app_npub, a.id AS actor_id, a.kind,
      (m.actor_id IS NOT NULL) AS member,
      EXISTS (SELECT 1 FROM flightdeck_pg_agent_access_profiles p WHERE p.actor_id = a.id AND p.workspace_id = w.id) AS classified
    FROM flightdeck_pg_workspaces w
    LEFT JOIN flightdeck_pg_actors a ON a.npub = ${npub}
    LEFT JOIN flightdeck_pg_workspace_memberships m ON m.workspace_id = w.id AND m.actor_id = a.id
    WHERE w.id = ${workspaceId}`;
  if (!row) throw fail(404, 'workspace_not_found', 'Workspace not found');
  if (!row.actor_id || !row.member) throw fail(403, 'workspace_membership_required', 'Actor is not a member of this workspace');
  if (!isNotificationIdentity(row)) throw fail(403, 'notification_identity_ineligible', 'App and service identities require an existing explicit notification-only profile');
  return { workspaceId: row.workspace_id, actorId: row.actor_id, npub, kind: row.kind!, classified: row.classified, appNpub: row.app_npub };
}

/** Share-locks the rows that grant a principal access (see withAuthorizedSnapshot); throws if membership or identity changed. */
export async function lockPrincipalAccess(t: Sql, r: Pick<Recipient, 'workspaceId' | 'actorId' | 'npub'>) {
  const [member] = await t`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId} FOR KEY SHARE`;
  if (!member) throw fail(403, 'workspace_membership_required', 'Actor is not a member of this workspace');
  const [actor] = await t<{ npub: string }[]>`SELECT npub FROM flightdeck_pg_actors WHERE id = ${r.actorId} FOR SHARE`;
  if (actor?.npub !== r.npub) throw fail(403, 'identity_rotated', 'The recipient identity was rotated; re-authenticate');
  await t`
    WITH RECURSIVE groups(id) AS (
      SELECT group_id FROM flightdeck_pg_group_memberships WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}
      UNION SELECT e.parent_group_id FROM flightdeck_pg_group_edges e JOIN groups g ON g.id = e.child_group_id WHERE e.workspace_id = ${r.workspaceId}
    )
    SELECT 1 FROM flightdeck_pg_group_memberships gm
    WHERE gm.workspace_id = ${r.workspaceId} AND gm.actor_id = ${r.actorId} FOR KEY SHARE`;
  await t`
    WITH RECURSIVE groups(id) AS (
      SELECT group_id FROM flightdeck_pg_group_memberships WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}
      UNION SELECT e.parent_group_id FROM flightdeck_pg_group_edges e JOIN groups g ON g.id = e.child_group_id WHERE e.workspace_id = ${r.workspaceId}
    )
    SELECT 1 FROM flightdeck_pg_group_edges e WHERE e.workspace_id = ${r.workspaceId} AND e.child_group_id IN (SELECT id FROM groups) FOR KEY SHARE`;
  await t`
    WITH RECURSIVE groups(id) AS (
      SELECT group_id FROM flightdeck_pg_group_memberships WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}
      UNION SELECT e.parent_group_id FROM flightdeck_pg_group_edges e JOIN groups g ON g.id = e.child_group_id WHERE e.workspace_id = ${r.workspaceId}
    )
    SELECT 1 FROM flightdeck_pg_permission_grants g
    WHERE g.workspace_id = ${r.workspaceId} AND g.revoked_at IS NULL
      AND ((g.principal_type = 'actor' AND g.principal_actor_id = ${r.actorId}) OR (g.principal_type = 'group' AND g.principal_group_id IN (SELECT id FROM groups)))
    FOR SHARE`;
}

/**
 * Linearizes authorization with revocation: inside a REPEATABLE READ transaction, share-lock the rows that grant the
 * recipient access (membership, actor identity, effective group memberships/edges and live grants). A revocation that
 * commits after our snapshot conflicts with these locks (40001) and the whole read retries on a fresh snapshot; one
 * that starts later blocks until our serialization commits (bytes "in flight"). A stale snapshot is never the proof.
 */
export async function withAuthorizedSnapshot<T>(sql: Sql, r: Recipient, work: (tx: Sql) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sql.begin('ISOLATION LEVEL REPEATABLE READ', async (tx) => {
        const t = tx as unknown as Sql;
        await lockPrincipalAccess(t, r);
        return work(t);
      });
    } catch (error: any) {
      if (error?.code === '40001' && attempt < SERIALIZATION_RETRIES) continue;
      if (error?.code === '40001') throw fail(503, 'authorization_contention', 'Authorization changed concurrently; retry');
      throw error;
    }
  }
}

/**
 * Channel archival and scope archival change record-access keys: share-lock the channel and scope rows a response
 * depends on, so such a change committing after our snapshot forces a retry (40001) instead of serving stale access.
 */
export async function lockChannels(t: Sql, workspaceId: string, channelIds: Array<string | null>) {
  const ids = [...new Set(channelIds.filter((id): id is string => Boolean(id)))].sort();
  if (!ids.length) return;
  const rows = await t<{ scope_id: string }[]>`
    SELECT scope_id FROM flightdeck_pg_channels WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
  const scopes = [...new Set(rows.map((row) => row.scope_id))].sort();
  if (scopes.length) await t`SELECT 1 FROM flightdeck_pg_scopes WHERE workspace_id = ${workspaceId} AND id = ANY(${scopes}::uuid[]) ORDER BY id FOR SHARE`;
}

// ------------------------------------------------------------------------------------------------------------------
// Notification-only classification (per workspace + principal). Delivery profile only: never an API ceiling.
// ------------------------------------------------------------------------------------------------------------------
type CeilingProfile = { actorId: string; workspaces: Set<string> };

/**
 * Classification source for delivery audiences. Production uses the database provider, which FAILS CLOSED: any lookup error
 * (including a missing table / schema not ready) refuses the request instead of treating the identity as unrestricted.
 * Legacy test fixtures without the runtime schema must inject `unclassifiedFixtureCeiling` explicitly.
 */
export interface AgentCeilingProvider {
  /** Returns the identity's classification (null = unclassified). Throws when classification cannot be determined. */
  profileFor(signerNpub: string): Promise<CeilingProfile | null>;
}

export class CeilingUnavailableError extends Error {}

/**
 * No classification cache: every authenticated request reads the (small, indexed) classification rows, so a change
 * committed on any Tower process applies to the very next request everywhere. Kept as a no-op for call sites.
 */
export function invalidateCeilingCache() {}

async function lookupProfile(sql: Sql, npub: string): Promise<CeilingProfile | null> {
  const rows = await sql<{ actor_id: string; workspace_id: string }[]>`
    SELECT p.actor_id, p.workspace_id FROM flightdeck_pg_agent_access_profiles p JOIN flightdeck_pg_actors a ON a.id = p.actor_id WHERE a.npub = ${npub}`;
  return rows.length ? { actorId: rows[0]!.actor_id, workspaces: new Set(rows.map((row) => row.workspace_id)) } : null;
}

export function databaseCeilingProvider(sql: () => Sql = () => getDb()): AgentCeilingProvider {
  return {
    async profileFor(signerNpub) {
      try {
        const direct = await lookupProfile(sql(), signerNpub);
        if (direct) return direct;
        // Same resolver the routes use (resolveNip98Signer): classification and the handler always agree on the acting
        // identity, so a workspace-key alias can never act as a classified agent while escaping its classification.
        const user = await resolveWsKeyNpub(signerNpub);
        return user && user !== signerNpub ? await lookupProfile(sql(), user) : null;
      } catch (error) {
        throw new CeilingUnavailableError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** TEST FIXTURES ONLY: suites whose databases do not carry the runtime schema and contain no agent classification. */
export const unclassifiedFixtureCeiling: AgentCeilingProvider = { profileFor: async () => null };

// ------------------------------------------------------------------------------------------------------------------
// Classification provider association. Classification governs delivery only (visibility audiences, human inbox
// projection, the strict inbox); it never refuses an API request the route's own ACL authorizes.
// ------------------------------------------------------------------------------------------------------------------
const providerOf = new WeakMap<Request, AgentCeilingProvider>();

/** Called by the app middleware: the injected classification provider answers audience checks for this request. */
export function rememberCeilingAdmission(request: Request, provider: AgentCeilingProvider) {
  providerOf.set(request, provider);
}

/** Whether `npub` is notification-only in `workspaceId` (delivery audiences only), from the request's provider (fails by throwing). */
export async function classifiedInWorkspace(request: Request, npub: string, workspaceId: string) {
  const provider = providerOf.get(request) ?? databaseCeilingProvider();
  return Boolean((await provider.profileFor(npub))?.workspaces.has(workspaceId));
}

// ------------------------------------------------------------------------------------------------------------------
// Subscriptions and cursors.
// ------------------------------------------------------------------------------------------------------------------
type SubscriptionRow = { id: string; consumer_id: string; floor_at: Date; policy_version: number; acked_through_seq: string; revoked_at: Date | null; created_at: Date };
type CursorPosition = { s: number; pv: number };

const binding = (r: Recipient, subscriptionId: string) => ({ w: r.workspaceId, a: r.actorId, r: CURSOR_ROUTE, f: subscriptionId });
const encodeAgentCursor = (sql: Sql, r: Recipient, subscriptionId: string, seq: number) =>
  signCursor(binding(r, subscriptionId), { s: seq, pv: AGENT_NOTIFICATION_POLICY_VERSION } satisfies CursorPosition, sql);
const cursorString = async (sql: Sql, r: Recipient, subscriptionId: string, seq: number) => `${subscriptionId}~${await encodeAgentCursor(sql, r, subscriptionId, seq)}`;

function serializeSubscription(row: SubscriptionRow) {
  return {
    id: row.id, consumer_id: row.consumer_id, floor_at: new Date(row.floor_at).toISOString(), policy_version: row.policy_version,
    acked_through_seq: Number(row.acked_through_seq), created_at: new Date(row.created_at).toISOString(),
  };
}

async function retentionFloor(sql: Sql, r: Recipient) {
  const [row] = await sql<{ f: string }[]>`SELECT retention_floor_seq AS f FROM flightdeck_pg_agent_notification_counters WHERE workspace_id = ${r.workspaceId} AND recipient_actor_id = ${r.actorId}`;
  return row ? Number(row.f) : 0;
}

/** Idempotent create/recover. The 24h floor is fixed by Tower at first creation; the caller cannot choose it. */
export async function createOrRecoverSubscription(sql: Sql, r: Recipient, consumerId: unknown) {
  if (typeof consumerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(consumerId)) throw fail(400, 'validation_error', 'consumer_id must be 1-128 chars of [A-Za-z0-9_.:-]');
  const [row] = await sql<(SubscriptionRow & { inserted: boolean })[]>`
    INSERT INTO flightdeck_pg_agent_notification_subscriptions (workspace_id, recipient_actor_id, consumer_id, floor_at, policy_version)
    VALUES (${r.workspaceId}, ${r.actorId}, ${consumerId}, NOW() - make_interval(secs => ${AGENT_NOTIFICATION_FLOOR_SECONDS}), ${AGENT_NOTIFICATION_POLICY_VERSION})
    ON CONFLICT (workspace_id, recipient_actor_id, consumer_id) DO UPDATE SET updated_at = NOW()
    RETURNING id, consumer_id, floor_at, policy_version, acked_through_seq, revoked_at, created_at, (xmax = 0) AS inserted`;
  if (row!.revoked_at) throw fail(403, 'subscription_revoked', 'This subscription was revoked');
  const floorSeq = await retentionFloor(sql, r);
  const acked = Number(row!.acked_through_seq);
  const gap = !row!.inserted && acked < floorSeq ? { code: 'cursor_gap', from_seq: acked + 1, through_seq: floorSeq, recovery_seq: floorSeq } : null;
  const start = row!.inserted || gap ? Math.max(acked, floorSeq) : acked;
  return {
    created: row!.inserted,
    subscription: serializeSubscription(row!),
    cursor: await cursorString(sql, r, row!.id, start),
    ...(gap ? { gap } : {}),
  };
}

async function loadSubscription(sql: Sql, r: Recipient, subscriptionId: string): Promise<SubscriptionRow> {
  if (!isUuid(subscriptionId)) throw fail(400, 'invalid_cursor', 'Cursor is invalid for this request');
  const [row] = await sql<SubscriptionRow[]>`
    SELECT id, consumer_id, floor_at, policy_version, acked_through_seq, revoked_at, created_at FROM flightdeck_pg_agent_notification_subscriptions
    WHERE id = ${subscriptionId} AND workspace_id = ${r.workspaceId} AND recipient_actor_id = ${r.actorId}`;
  if (!row) throw fail(400, 'invalid_cursor', 'Cursor is invalid for this request');
  if (row.revoked_at) throw fail(403, 'subscription_revoked', 'This subscription was revoked');
  return row;
}

/** Cursor tokens are `<subscription_id>~<hmac token>`; the HMAC binds workspace, recipient, route and subscription. */
async function decodeAgentCursor(sql: Sql, r: Recipient, raw: unknown) {
  if (typeof raw !== 'string' || !raw.includes('~')) throw fail(400, 'invalid_cursor', 'Cursor is invalid for this request');
  const [subscriptionId, token] = raw.split('~', 2) as [string, string];
  const subscription = await loadSubscription(sql, r, subscriptionId);
  let position: CursorPosition;
  try {
    position = await verifyCursor<CursorPosition>(token, binding(r, subscription.id), sql);
  } catch (error) {
    if (error instanceof NotificationError) throw fail(400, 'invalid_cursor', 'Cursor is invalid for this request');
    throw error;
  }
  if (!Number.isSafeInteger(position?.s) || position.s < 0 || position.pv !== AGENT_NOTIFICATION_POLICY_VERSION) throw fail(400, 'invalid_cursor', 'Cursor is invalid for this request');
  return { subscription, seq: position.s };
}

// ------------------------------------------------------------------------------------------------------------------
// Inbox page (shared by poll and SSE).
// ------------------------------------------------------------------------------------------------------------------
type NotificationRow = {
  id: string; seq: string; kind: string; reason: string; source_type: string; source_id: string; source_version: string | null;
  source_created_at: Date; channel_id: string | null; thread_id: string | null; task_id: string | null; doc_id: string | null;
  acl_key: string; author_npub: string | null; created_at: Date; origin_notification_id: string | null;
};

function serializeEnvelope(row: NotificationRow) {
  return {
    id: row.id,
    seq: Number(row.seq),
    kind: row.kind,
    reason: row.reason,
    state: 'active' as const,
    source: {
      type: row.source_type, id: row.source_id, version: row.source_version == null ? null : Number(row.source_version),
      channel_id: row.channel_id, thread_id: row.thread_id, task_id: row.task_id, doc_id: row.doc_id,
    },
    author_npub: row.author_npub,
    occurred_at: new Date(row.source_created_at).toISOString(),
    // Non-null only for reason 'self_mention': the live non-self notification this self-address depends on.
    origin_notification_id: row.origin_notification_id ?? null,
  };
}
/** Minimal tombstone: no routing metadata once access or the canonical relationship is gone. */
const tombstone = (row: NotificationRow) => ({ id: row.id, seq: Number(row.seq), state: 'revoked' as const });

export async function listInboxPage(sql: Sql, r: Recipient, rawCursor: unknown, rawLimit: unknown) {
  const limit = rawLimit == null || rawLimit === '' ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > AGENT_NOTIFICATION_PAGE_MAX) throw fail(400, 'validation_error', `limit must be 1-${AGENT_NOTIFICATION_PAGE_MAX}`);
  const { subscription, seq } = await decodeAgentCursor(sql, r, rawCursor);
  return withAuthorizedSnapshot(sql, r, async (t) => {
    const floorSeq = await retentionFloor(t, r);
    if (seq < floorSeq) {
      throw fail(409, 'cursor_gap', 'Notifications after this cursor were removed by retention', {
        from_seq: seq + 1, through_seq: floorSeq, recovery_cursor: await cursorString(t, r, subscription.id, floorSeq),
      });
    }
    const rows = await t<(NotificationRow & { readable: boolean; relation: string })[]>`
      SELECT n.id, n.seq, n.kind, n.reason, n.source_type, n.source_id, n.source_version, n.source_created_at, n.channel_id, n.thread_id,
        n.task_id, n.doc_id, n.acl_key, author.npub AS author_npub, n.created_at, n.origin_notification_id,
        (access.keys @> to_jsonb(n.acl_key)) AS readable,
        flightdeck_pg_agent_notification_relation(n.id) AS relation
      FROM flightdeck_pg_agent_notifications n
      LEFT JOIN flightdeck_pg_actors author ON author.id = n.author_actor_id
      CROSS JOIN (SELECT flightdeck_pg_record_access(${r.workspaceId}::uuid, ${r.actorId}::uuid) AS keys) access
      WHERE n.workspace_id = ${r.workspaceId} AND n.recipient_actor_id = ${r.actorId} AND n.seq > ${seq}
      ORDER BY n.seq ASC LIMIT ${limit}`;
    await lockChannels(t, r.workspaceId, rows.map((row) => row.channel_id));
    const floor = new Date(subscription.floor_at).getTime();
    // The floor is enforced on EVERY selection (fan-out can commit old sources late); scanned rows still advance.
    const notifications = rows
      .filter((row) => new Date(row.source_created_at).getTime() >= floor)
      .map((row) => (row.readable && row.relation === 'ok' ? serializeEnvelope(row) : tombstone(row)));
    const through = rows.length ? Number(rows.at(-1)!.seq) : seq;
    return {
      subscription_id: subscription.id,
      notifications,
      next_cursor: await cursorString(t, r, subscription.id, through),
      has_more: rows.length === limit,
    };
  });
}

// ------------------------------------------------------------------------------------------------------------------
// Context, attachments and ack: recipient-bound, revalidated per request.
// ------------------------------------------------------------------------------------------------------------------
export type FullNotification = NotificationRow & { workspace_id: string; recipient_actor_id: string; scope_id: string | null };

export async function loadOwnNotification(sql: Sql, r: Recipient, notificationId: string): Promise<FullNotification> {
  if (!isUuid(notificationId)) throw notFound();
  // Only notifications inside some subscription's floor are reachable: an id never confers pre-floor history.
  const [row] = await sql<FullNotification[]>`
    SELECT n.*, author.npub AS author_npub FROM flightdeck_pg_agent_notifications n
    LEFT JOIN flightdeck_pg_actors author ON author.id = n.author_actor_id
    WHERE n.id = ${notificationId} AND n.workspace_id = ${r.workspaceId} AND n.recipient_actor_id = ${r.actorId}
      AND EXISTS (SELECT 1 FROM flightdeck_pg_agent_notification_subscriptions s WHERE s.workspace_id = n.workspace_id
        AND s.recipient_actor_id = n.recipient_actor_id AND s.revoked_at IS NULL AND s.floor_at <= n.source_created_at)`;
  if (!row) throw notFound();
  return row;
}

/** Access + canonical relationship, in the locked snapshot. source_gone is terminal; the others are authorization. */
async function assertNotificationLive(t: Sql, r: Recipient, n: FullNotification) {
  const [row] = await t<{ readable: boolean; relation: string }[]>`
    SELECT flightdeck_pg_record_access(${r.workspaceId}::uuid, ${r.actorId}::uuid) @> to_jsonb(${n.acl_key}::text) AS readable,
      flightdeck_pg_agent_notification_relation(${n.id}::uuid) AS relation`;
  if (!row?.readable) throw fail(403, 'access_revoked', 'The recipient no longer has access to this notification source');
  if (row.relation === 'source_gone') throw fail(410, 'source_gone', 'The notification source no longer exists at its notified location');
  if (row.relation !== 'ok') throw fail(403, 'relationship_removed', 'The recipient is no longer addressed by this source');
}

export type MessageRow = {
  id: string; workspace_id: string; scope_id: string; channel_id: string; thread_id: string | null; body: string; metadata: any; row_version: number;
  created_at: Date; updated_at: Date; created_by_actor_id: string; updated_by_actor_id: string; author_npub: string; author_label: string | null;
  thread_source_message_id?: string | null; inherited?: boolean; owning_thread_id?: string | null; effective_thread_id?: string | null;
};

async function attachmentDescriptors(tx: Sql, workspaceId: string, entityType: string, entityIds: string[], linkedBy?: { actorId: string; entityIds: Set<string> }) {
  if (!entityIds.length) return new Map<string, any[]>();
  const rows = await tx<{ entity_id: string; storage_object_id: string; file_name: string | null; content_type: string | null; size_bytes: string | null; created_by_actor_id: string | null }[]>`
    SELECT l.entity_id, l.storage_object_id, o.file_name, o.content_type, o.size_bytes, l.created_by_actor_id
    FROM flightdeck_pg_storage_links l JOIN v4_storage_objects o ON o.id = l.storage_object_id
    WHERE l.workspace_id = ${workspaceId} AND l.entity_type = ${entityType} AND l.entity_id = ANY(${entityIds}::uuid[]) AND l.deleted_at IS NULL
    ORDER BY l.created_at, l.storage_object_id`;
  const out = new Map<string, any[]>();
  for (const row of rows) {
    // On restricted entities only attachments that `linkedBy.actorId` linked itself are disclosed.
    if (linkedBy?.entityIds.has(row.entity_id) && row.created_by_actor_id !== linkedBy.actorId) continue;
    (out.get(row.entity_id) ?? out.set(row.entity_id, []).get(row.entity_id)!).push({
      storage_object_id: row.storage_object_id, file_name: row.file_name, content_type: row.content_type, size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
    });
  }
  return out;
}

/**
 * Same field shape as the effective-transcript message serializer that agents already parse, with metadata reduced to
 * routing/authorization facts and attachments replaced by authoritative, URL-free descriptors (download through the
 * notification attachment route only).
 */
export function serializeMessage(m: MessageRow, attachments: any[]) {
  const source = m.metadata ?? {};
  const mentions = Array.isArray(source.mentions) ? source.mentions : [];
  const metadata: Record<string, unknown> = { mentions, attachments };
  if (source.agent_instruction_signature) metadata.agent_instruction_signature = source.agent_instruction_signature;
  if (typeof source.agent_direct_recipient_npub === 'string') metadata.agent_direct_recipient_npub = source.agent_direct_recipient_npub;
  const inherited = Boolean(m.inherited);
  return {
    id: m.id, workspace_id: m.workspace_id, scope_id: m.scope_id, channel_id: m.channel_id, thread_id: m.thread_id,
    thread_source_message_id: m.thread_source_message_id ?? null, body: m.body, mentions, attachments, metadata,
    record_state: 'active', row_version: m.row_version,
    created_by_actor_id: m.created_by_actor_id, created_by_actor_npub: m.author_npub, created_by_actor_label: m.author_label, sender_npub: m.author_npub,
    updated_by_actor_id: m.updated_by_actor_id, created_at: new Date(m.created_at).toISOString(), updated_at: new Date(m.updated_at).toISOString(),
    owning_thread_id: m.owning_thread_id ?? m.thread_id, effective_thread_id: m.effective_thread_id ?? m.thread_id, inherited, read_only: inherited,
    // Convenience aliases kept for the inbox contract.
    agent_instruction_signature: source.agent_instruction_signature ?? null,
    agent_direct_recipient_npub: typeof source.agent_direct_recipient_npub === 'string' ? source.agent_direct_recipient_npub : null,
  };
}

async function loadMessage(tx: Sql, workspaceId: string, id: string) {
  const [row] = await tx<MessageRow[]>`
    SELECT m.id, m.workspace_id, m.scope_id, m.channel_id, m.thread_id, m.body, m.metadata, m.row_version, m.created_at, m.updated_at,
      m.created_by_actor_id, m.updated_by_actor_id, a.npub AS author_npub, a.display_name AS author_label, t.source_message_id AS thread_source_message_id
    FROM flightdeck_pg_messages m JOIN flightdeck_pg_actors a ON a.id = m.created_by_actor_id
    LEFT JOIN flightdeck_pg_threads t ON t.workspace_id = m.workspace_id AND t.id = m.thread_id
    WHERE m.workspace_id = ${workspaceId} AND m.id = ${id} AND m.deleted_at IS NULL`;
  return row ?? null;
}

/** Newest-first bounded window (count and bytes), returned oldest-first. */
export function boundWindow<T extends { body: string }>(newestFirst: T[], maxCount: number, maxBytes: number) {
  const kept: T[] = [];
  let bytes = 0;
  for (const row of newestFirst) {
    const size = Buffer.byteLength(row.body ?? '', 'utf8');
    if (kept.length >= maxCount || bytes + size > maxBytes) return { rows: kept.reverse(), truncated: true };
    bytes += size;
    kept.push(row);
  }
  return { rows: kept.reverse(), truncated: false };
}

/** Effective transcript (thread lineage incl. inherited parent ranges) strictly before the trigger, bounded. */
export async function boundedTranscript(t: Sql, w: string, trigger: Pick<MessageRow, 'channel_id' | 'thread_id'> & { created_at: Date; id: string },
  cutoff: { created_at: Date; id: string } | null = trigger) {
  const before = (row: { created_at: Date; id: string }) => {
    if (!cutoff) return true;
    const a = new Date(row.created_at).getTime();
    const b = new Date(cutoff.created_at).getTime();
    return a < b || (a === b && row.id < cutoff.id);
  };
  const window: MessageRow[] = [];
  let afterCreatedAt: string | null = null;
  let afterId: string | null = null;
  let complete = false;
  for (let page = 0; page < TRANSCRIPT_SCAN_PAGES; page += 1) {
    const rows: any[] = await listEffectiveFlightDeckPgThreadMessages({ workspaceId: w, channelId: trigger.channel_id, threadId: trigger.thread_id!, limit: 201, afterCreatedAt, afterId }, t as any);
    for (const row of rows) {
      if (!before(row)) { complete = true; break; }
      if (row.deleted_at) continue;
      window.push({
        id: row.id, workspace_id: row.workspace_id, scope_id: row.scope_id, channel_id: row.channel_id, thread_id: row.thread_id, body: row.body, metadata: row.metadata,
        row_version: row.row_version, created_at: row.created_at, updated_at: row.updated_at, created_by_actor_id: row.created_by_actor_id,
        updated_by_actor_id: row.updated_by_actor_id, author_npub: row.created_by_actor_npub, author_label: row.created_by_actor_label ?? null,
        thread_source_message_id: row.thread_source_message_id ?? null, inherited: row.inherited, owning_thread_id: row.owning_thread_id, effective_thread_id: row.effective_thread_id,
      });
      if (window.length > WINDOW_MESSAGES * 4) window.splice(0, window.length - WINDOW_MESSAGES * 2);
    }
    if (complete || rows.length < 201) { complete = true; break; }
    const last = rows.at(-1);
    afterCreatedAt = last.cursor_created_at;
    afterId = last.id;
  }
  const bounded = boundWindow([...window].reverse(), WINDOW_MESSAGES, WINDOW_BYTES);
  return { rows: bounded.rows, truncated: bounded.truncated || !complete };
}

/** Document body in the same shape as GET docs/:id/body (exact bytes, base64); never partial. */
export async function docBody(tx: Sql, workspaceId: string, docId: string) {
  const [doc] = await tx<{ id: string; title: string; row_version: number; channel_id: string; storage_object_id: string | null; deleted_at: Date | null }[]>`
    SELECT id, title, row_version, channel_id, storage_object_id, deleted_at FROM flightdeck_pg_docs WHERE workspace_id = ${workspaceId} AND id = ${docId}`;
  if (!doc || doc.deleted_at) return null;
  let body: Record<string, unknown> | null = null;
  let tooLarge = false;
  if (doc.storage_object_id) {
    const [link] = await tx`SELECT 1 FROM flightdeck_pg_storage_links WHERE workspace_id = ${workspaceId} AND storage_object_id = ${doc.storage_object_id}
      AND entity_type = 'doc' AND entity_id = ${doc.id} AND channel_id = ${doc.channel_id} AND deleted_at IS NULL`;
    const content = link ? await getStorageObjectContent(doc.storage_object_id) : null;
    if (content && content.bytes.byteLength > DOC_BODY_MAX_BYTES) tooLarge = true;
    else if (content) {
      body = {
        content_type: content.row.content_type ?? null, size_bytes: content.size, sha256_hex: content.row.sha256_hex ?? null,
        encoding: 'base64', base64_data: Buffer.from(content.bytes).toString('base64'),
      };
    }
  }
  const canonical = body && doc.storage_object_id
    ? serializeFlightDeckPgDocVersionIdentity({
      version_id: flightDeckPgCanonicalDocVersionId(doc.id, doc.row_version), row_version: doc.row_version, storage_object_id: doc.storage_object_id,
      body_sha256_hex: (body.sha256_hex as string | null) ?? null, size_bytes: Number(body.size_bytes),
    } as any)
    : null;
  return { id: doc.id, title: doc.title, row_version: doc.row_version, channel_id: doc.channel_id, body, body_too_large: tooLarge, canonical_version: canonical };
}

/**
 * Context of a deliberate self-address: never more than the ORIGIN's own context authorizes right now (its trigger and
 * bounded transcript, built by the origin's policy), plus the bot's later messages that it both wrote and last
 * updated. The trigger (verified bot revision) and those own messages expose only attachments the bot linked itself.
 */
async function selfAddressWindow(t: Sql, r: Recipient, n: FullNotification, trigger: MessageRow, policy: ContextPolicy) {
  const ownIds = new Set<string>([trigger.id]);
  const [origin] = await t<FullNotification[]>`
    SELECT * FROM flightdeck_pg_agent_notifications WHERE id = ${n.origin_notification_id} AND workspace_id = ${r.workspaceId}
      AND recipient_actor_id = ${r.actorId} AND source_type = 'message' AND reason <> 'self_mention'`;
  const originMessage = origin ? await loadMessage(t, r.workspaceId, origin.source_id) : null;
  if (!originMessage) return { rows: [] as MessageRow[], truncated: false, ownIds };
  const originWindow = policy === 'bounded_transcript' && originMessage.thread_id
    ? await boundedTranscript(t, r.workspaceId, originMessage)
    : { rows: [] as MessageRow[], truncated: false };
  const at = (row: { created_at: Date; id: string }) => [new Date(row.created_at).getTime(), row.id] as const;
  const after = (row: MessageRow, pivot: MessageRow) => { const [a, ai] = at(row); const [b, bi] = at(pivot); return a > b || (a === b && ai > bi); };
  const own = trigger.thread_id
    ? (await boundedTranscript(t, r.workspaceId, trigger)).rows
      .filter((row) => after(row, originMessage) && row.created_by_actor_id === r.actorId && row.updated_by_actor_id === r.actorId)
    : [];
  for (const row of own) ownIds.add(row.id);
  const byId = new Map<string, MessageRow>();
  for (const row of [...originWindow.rows, originMessage, ...own]) if (row.id !== trigger.id) byId.set(row.id, row);
  const rows = [...byId.values()].sort((x, y) => { const [a, ai] = at(x); const [b, bi] = at(y); return a - b || (ai < bi ? -1 : ai > bi ? 1 : 0); });
  return { rows, truncated: originWindow.truncated, ownIds };
}

export async function buildContext(sql: Sql, r: Recipient, notificationId: string) {
  return buildContextThen(sql, r, notificationId, async (context) => context);
}

/** Builds the context and runs `then` inside the SAME locked snapshot (attachment bytes are served before commit). */
async function buildContextThen<T>(sql: Sql, r: Recipient, notificationId: string, then: (context: any, t: Sql) => Promise<T>): Promise<T> {
  const n = await loadOwnNotification(sql, r, notificationId);
  const policy = agentNotificationContextPolicy();
  return withAuthorizedSnapshot(sql, r, async (t) => then(await contextIn(t, r, n, policy), t));
}

export async function contextIn(t: Sql, r: Recipient, n: FullNotification, policy: ContextPolicy): Promise<any> {
  {
    await lockChannels(t, r.workspaceId, [n.channel_id]);
    await assertNotificationLive(t, r, n);
    const w = r.workspaceId;
    const gone = () => fail(410, 'source_gone', 'The notification source no longer exists at its notified location');
    const [channel] = await t<{ id: string; scope_id: string; name: string; kind: string; participant_npubs: string[] | null; metadata: any }[]>`
      SELECT id, scope_id, name, kind, participant_npubs, metadata FROM flightdeck_pg_channels WHERE workspace_id = ${w} AND id = ${n.channel_id} AND archived_at IS NULL`;
    if (!channel) throw gone();
    const base = {
      notification: serializeEnvelope(n),
      policy: { context: policy, window_messages: WINDOW_MESSAGES, window_bytes: WINDOW_BYTES },
      channel: { id: channel.id, workspace_id: w, scope_id: channel.scope_id, name: channel.name, kind: channel.kind, participant_npubs: channel.participant_npubs ?? [], metadata: { agent_chat: normalizeFlightDeckPgChannelMetadata(channel.metadata).agent_chat }, agent_chat: normalizeFlightDeckPgChannelMetadata(channel.metadata).agent_chat } satisfies AgentNotificationContextChannel,
    };

    if (n.source_type === 'message') {
      const message = await loadMessage(t, w, n.source_id);
      if (!message) throw gone();
      let thread = null;
      if (message.thread_id) {
        const [row] = await t<{ id: string; title: string; source_message_id: string | null; parent_thread_id: string | null; branch_point_message_id: string | null }[]>`
          SELECT id, title, source_message_id, parent_thread_id, branch_point_message_id FROM flightdeck_pg_threads WHERE workspace_id = ${w} AND id = ${message.thread_id} AND deleted_at IS NULL`;
        if (!row) throw gone();
        thread = row;
      }
      const self = n.reason === 'self_mention' ? await selfAddressWindow(t, r, n, message, policy) : null;
      const transcript = self ?? (policy === 'bounded_transcript' && message.thread_id ? await boundedTranscript(t, w, message) : { rows: [] as MessageRow[], truncated: false });
      const attachments = await attachmentDescriptors(t, w, 'message', [message.id, ...transcript.rows.map((m) => m.id)],
        self ? { actorId: r.actorId, entityIds: self.ownIds } : undefined);
      return {
        ...base, thread,
        trigger: { type: 'message', message: serializeMessage(message, attachments.get(message.id) ?? []) },
        window: { messages: transcript.rows.map((m) => serializeMessage(m, attachments.get(m.id) ?? [])), truncated: transcript.truncated },
      };
    }

    if (n.source_type === 'task' || n.source_type === 'task_comment') {
      const [task] = await t<{ id: string; title: string; description: string | null; state: string; priority: string | null; metadata: any; row_version: number }[]>`
        SELECT id, title, description, state, priority, metadata, row_version FROM flightdeck_pg_tasks WHERE workspace_id = ${w} AND id = ${n.task_id} AND deleted_at IS NULL`;
      if (!task) throw gone();
      let comment = null;
      if (n.source_type === 'task_comment') {
        const [row] = await t<{ id: string; body: string; metadata: any; created_at: Date; author_npub: string }[]>`
          SELECT c.id, c.body, c.metadata, c.created_at, a.npub AS author_npub FROM flightdeck_pg_task_comments c
          JOIN flightdeck_pg_actors a ON a.id = c.created_by_actor_id WHERE c.workspace_id = ${w} AND c.id = ${n.source_id} AND c.deleted_at IS NULL`;
        if (!row) throw gone();
        comment = { id: row.id, body: row.body, author_npub: row.author_npub, mentions: row.metadata?.mentions ?? [], created_at: new Date(row.created_at).toISOString() };
      }
      let comments: any[] = [];
      let truncated = false;
      if (policy === 'bounded_transcript') {
        const rows = await t<{ id: string; body: string; author_npub: string; created_at: Date }[]>`
          SELECT c.id, c.body, a.npub AS author_npub, c.created_at FROM flightdeck_pg_task_comments c JOIN flightdeck_pg_actors a ON a.id = c.created_by_actor_id
          WHERE c.workspace_id = ${w} AND c.task_id = ${task.id} AND c.deleted_at IS NULL AND c.id <> ${n.source_id}
          ORDER BY c.created_at DESC, c.id DESC LIMIT ${WINDOW_MESSAGES + 1}`;
        const bounded = boundWindow(rows, WINDOW_MESSAGES, WINDOW_BYTES);
        comments = bounded.rows.map((c) => ({ id: c.id, body: c.body, author_npub: c.author_npub, created_at: new Date(c.created_at).toISOString() }));
        truncated = bounded.truncated;
      }
      return {
        ...base,
        trigger: {
          type: n.source_type,
          task: { id: task.id, workspace_id: w, channel_id: n.channel_id, scope_id: channel.scope_id, title: task.title, description: task.description, state: task.state, priority: task.priority, assigned_to_npub: task.metadata?.assigned_to_npub ?? null, row_version: task.row_version },
          comment,
        },
        window: { comments, truncated },
      };
    }

    if (n.source_type === 'doc' || n.source_type === 'doc_comment') {
      const doc = await docBody(t, w, n.doc_id!);
      if (!doc) throw gone();
      let comment = null;
      if (n.source_type === 'doc_comment') {
        const [row] = await t<{ id: string; parent_comment_id: string | null; body: string; metadata: any; created_at: Date; author_npub: string }[]>`
          SELECT c.id, c.parent_comment_id, c.body, c.metadata, c.created_at, a.npub AS author_npub FROM flightdeck_pg_doc_comments c
          JOIN flightdeck_pg_actors a ON a.id = c.created_by_actor_id WHERE c.workspace_id = ${w} AND c.id = ${n.source_id} AND c.deleted_at IS NULL`;
        if (!row) throw gone();
        comment = { id: row.id, parent_comment_id: row.parent_comment_id, body: row.body, author_npub: row.author_npub, mentions: row.metadata?.mentions ?? [], created_at: new Date(row.created_at).toISOString() };
      }
      return { ...base, trigger: { type: n.source_type, document: doc, comment } };
    }

    if (n.source_type === 'invocation') {
      const [inv] = await t<{ id: string; prompt: string; targets: any; status: string; metadata: any; created_at: Date; author_npub: string }[]>`
        SELECT i.id, i.prompt, i.targets, i.status, i.metadata, i.created_at, a.npub AS author_npub FROM flightdeck_pg_invocations i
        JOIN flightdeck_pg_actors a ON a.id = i.created_by_actor_id WHERE i.workspace_id = ${w} AND i.id = ${n.source_id}`;
      if (!inv) throw gone();
      const document = n.doc_id ? await docBody(t, w, n.doc_id) : null;
      const [task] = n.task_id
        ? await t<{ id: string; title: string; description: string | null; state: string; channel_id: string }[]>`SELECT id, title, description, state, channel_id FROM flightdeck_pg_tasks WHERE workspace_id = ${w} AND id = ${n.task_id} AND deleted_at IS NULL`
        : [];
      // Targets outside the invocation's channel are not disclosed through this context.
      return {
        ...base,
        trigger: {
          type: 'invocation',
          invocation: { id: inv.id, prompt: inv.prompt, targets: Array.isArray(inv.targets) ? inv.targets.map((x: any) => ({ type: x?.type, id: x?.id })) : [], status: inv.status, trigger: inv.metadata?.trigger ?? null, author_npub: inv.author_npub, created_at: new Date(inv.created_at).toISOString() },
          document: document && document.channel_id === n.channel_id ? document : null,
          task: task && task.channel_id === n.channel_id ? { id: task.id, title: task.title, description: task.description, state: task.state } : null,
        },
      };
    }
    throw gone();
  }
}

/** Bytes of an attachment of the trigger (or transcript window) entity only; never a bearer URL. Read under the lock. */
export async function readAttachment(sql: Sql, r: Recipient, notificationId: string, storageObjectId: string) {
  if (!isUuid(storageObjectId)) throw fail(404, 'attachment_not_found', 'Attachment not found');
  return buildContextThen(sql, r, notificationId, async (context) => {
    const allowed = new Set<string>();
    for (const message of [context.trigger?.message, ...(context.window?.messages ?? [])]) {
      for (const a of message?.attachments ?? []) allowed.add(a.storage_object_id);
    }
    if (!allowed.has(storageObjectId)) throw fail(404, 'attachment_not_found', 'Attachment not found');
    const content = await getStorageObjectContent(storageObjectId);
    if (!content || !content.row.completed_at) throw fail(404, 'attachment_not_found', 'Attachment not found');
    return content;
  });
}

export async function acknowledge(sql: Sql, r: Recipient, notificationId: string, body: any) {
  const outcome = body?.outcome;
  if (!ACK_OUTCOMES.includes(outcome)) throw fail(400, 'validation_error', `outcome must be one of ${ACK_OUTCOMES.join(', ')}`);
  const code = body?.code == null ? null : String(body.code);
  if (code !== null && !/^[a-z][a-z0-9_.:-]{0,63}$/.test(code)) throw fail(400, 'validation_error', 'code must be a short lowercase reason code');
  const subscription = await loadSubscription(sql, r, String(body?.subscription_id ?? ''));
  const n = await loadOwnNotification(sql, r, notificationId);
  return withAuthorizedSnapshot(sql, r, async (t) => {
    // An ack can never bypass authorization; source_gone needs Tower confirmation in the same locked snapshot.
    if (outcome === 'source_gone') {
      const [row] = await t<{ relation: string }[]>`SELECT flightdeck_pg_agent_notification_relation(${n.id}::uuid) AS relation`;
      if (row?.relation !== 'source_gone') throw fail(409, 'source_present', 'The notification source still exists; source_gone was not confirmed');
    }
    await t`SELECT 1 FROM flightdeck_pg_agent_notification_subscriptions WHERE id = ${subscription.id} FOR UPDATE`;
    const [inserted] = await t<{ outcome: string }[]>`
      INSERT INTO flightdeck_pg_agent_notification_acks (notification_id, subscription_id, outcome, code) VALUES (${n.id}, ${subscription.id}, ${outcome}, ${code})
      ON CONFLICT (notification_id, subscription_id) DO NOTHING RETURNING outcome`;
    const [existing] = inserted ? [inserted] : await t<{ outcome: string }[]>`SELECT outcome FROM flightdeck_pg_agent_notification_acks WHERE notification_id = ${n.id} AND subscription_id = ${subscription.id}`;
    if (inserted && (outcome === 'source_gone' || outcome === 'failed_permanent')) {
      await t`INSERT INTO flightdeck_pg_agent_notification_audit (workspace_id, actor_id, action, detail)
        VALUES (${r.workspaceId}, ${r.actorId}, ${`ack.${outcome}`}, ${t.json({ notification_id: n.id, subscription_id: subscription.id, code, source_type: n.source_type, source_id: n.source_id } as any)})`;
    }
    // Contiguous ack position: the first eligible unacked notification bounds it; otherwise the committed counter.
    const [position] = await t<{ p: string }[]>`
      SELECT COALESCE(
        (SELECT MIN(x.seq) - 1 FROM flightdeck_pg_agent_notifications x
          WHERE x.workspace_id = ${r.workspaceId} AND x.recipient_actor_id = ${r.actorId} AND x.seq > s.acked_through_seq AND x.source_created_at >= s.floor_at
            AND NOT EXISTS (SELECT 1 FROM flightdeck_pg_agent_notification_acks k WHERE k.notification_id = x.id AND k.subscription_id = s.id)),
        (SELECT last_seq FROM flightdeck_pg_agent_notification_counters c WHERE c.workspace_id = ${r.workspaceId} AND c.recipient_actor_id = ${r.actorId}),
        s.acked_through_seq) AS p
      FROM flightdeck_pg_agent_notification_subscriptions s WHERE s.id = ${subscription.id}`;
    const [updated] = await t<{ a: string }[]>`
      UPDATE flightdeck_pg_agent_notification_subscriptions SET acked_through_seq = GREATEST(acked_through_seq, ${Number(position!.p)}), updated_at = NOW()
      WHERE id = ${subscription.id} RETURNING acked_through_seq AS a`;
    return { notification_id: n.id, subscription_id: subscription.id, outcome: existing!.outcome, replayed: !inserted, acked_through_seq: Number(updated!.a) };
  });
}

// ------------------------------------------------------------------------------------------------------------------
// Access profile (delivery classification) management.
// ------------------------------------------------------------------------------------------------------------------
export async function readAccessProfile(sql: Sql, workspaceId: string, actorId: string) {
  const [here] = await sql<{ profile: string }[]>`
    SELECT profile FROM flightdeck_pg_agent_access_profiles WHERE workspace_id = ${workspaceId} AND actor_id = ${actorId}`;
  return { profile: here?.profile ?? null, policy_version: AGENT_NOTIFICATION_POLICY_VERSION };
}

export async function setAccessProfile(sql: Sql, input: { workspaceId: string; targetActorId: string; byActorId: string }) {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const [row] = await t`
      INSERT INTO flightdeck_pg_agent_access_profiles (workspace_id, actor_id, profile, policy_version, set_by_actor_id)
      VALUES (${input.workspaceId}, ${input.targetActorId}, 'notification_only', ${AGENT_NOTIFICATION_POLICY_VERSION}, ${input.byActorId})
      ON CONFLICT (workspace_id, actor_id) DO NOTHING RETURNING actor_id`;
    // A classified bot is never fanned into a manager's visibility audience in this workspace.
    await t`DELETE FROM flightdeck_pg_event_subscription_agents WHERE workspace_id = ${input.workspaceId} AND agent_actor_id = ${input.targetActorId}`;
    if (row) {
      await t`INSERT INTO flightdeck_pg_agent_notification_audit (workspace_id, actor_id, subject_actor_id, action, detail)
        VALUES (${input.workspaceId}, ${input.byActorId}, ${input.targetActorId}, 'access_profile.set', ${t.json({ profile: 'notification_only', policy_version: AGENT_NOTIFICATION_POLICY_VERSION } as any)})`;
    }
  });
  invalidateCeilingCache();
}

export async function clearAccessProfile(sql: Sql, input: { workspaceId: string; targetActorId: string; byActorId: string }) {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const [row] = await t`DELETE FROM flightdeck_pg_agent_access_profiles WHERE workspace_id = ${input.workspaceId} AND actor_id = ${input.targetActorId} RETURNING actor_id`;
    if (row) {
      await t`INSERT INTO flightdeck_pg_agent_notification_audit (workspace_id, actor_id, subject_actor_id, action, detail)
        VALUES (${input.workspaceId}, ${input.byActorId}, ${input.targetActorId}, 'access_profile.cleared', '{}'::jsonb)`;
    }
  });
  invalidateCeilingCache();
}

/** Human/agent labels do not confer inbox authority. App/service identities are not implicitly admitted. */
export function isNotificationIdentity(r: { kind: string | null; classified: boolean }) {
  return r.kind === 'human' || r.kind === 'agent' || r.classified;
}
