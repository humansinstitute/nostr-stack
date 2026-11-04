import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { type Sql, MAX_INTAKE_ATTEMPTS, isUuid } from './notification-core';
import { AGENT_ORIGIN_METADATA_KEY, storedSignatureBindsRevision } from './flightdeck-pg-message-signatures';
import { liveOrigin } from './agent-work-receipts';

/**
 * Strict agent notification projection (addressed-only).
 *
 * Addressing comes ONLY from the same-transaction outbox payload of the exact source revision (canonical structured
 * mentions, explicit recipients, DM participants, assignments). There is no channel-reader broadcast, no text-name
 * matching, and a later revision never re-addresses an older event. Recipients are eligible human/agent identities (or explicitly
 * classified app/service identities), active members, not the author (except a verified deliberate self-address, see
 * selfAddress), and currently hold the record-access key.
 *
 * Sequencing: the per-recipient counter row lock is held until commit, so per-recipient seq order equals commit order.
 */

export const AGENT_NOTIFICATION_KINDS = [
  'chat_mention', 'direct_message', 'agent_direct_recipient', 'task_assigned', 'task_mention', 'task_comment_mention',
  'document_mention', 'document_comment_mention', 'invocation', 'document_review',
] as const;
export type AgentNotificationKind = typeof AGENT_NOTIFICATION_KINDS[number];
export type AgentNotificationSourceType = 'message' | 'task' | 'task_comment' | 'doc' | 'doc_comment' | 'invocation';

type IntakeRow = { id: string; workspace_id: string; outbox_event_id: string; attempt_count: number; addressing_snapshot?: AddressingSnapshot | null };
type AddressingSnapshot = { message_row_version?: number; agent_direct_recipient_npub?: string | null; channel_kind?: string; dm_participant_npubs?: string[] };
type OutboxRow = {
  id: string; workspace_id: string; scope_id: string | null; channel_id: string | null; actor_id: string | null;
  event_type: string; entity_type: string; entity_id: string | null; entity_row_version: number | null;
  payload: Record<string, any>; created_at: Date;
};

export type AgentAddress = { npub?: string | null; actorId?: string | null; kind: AgentNotificationKind; reason: string; originNotificationId?: string | null };
export type AgentSource = {
  type: AgentNotificationSourceType; id: string; version: number | null; scopeId: string | null; channelId: string;
  threadId: string | null; taskId: string | null; docId: string | null; authorActorId: string | null;
  aclFamily: string; dedupeBase: string;
};
export type Derivation = { skip: string } | { source: AgentSource; addresses: AgentAddress[] };

export function agentProjectorEnabled() {
  return (Bun.env.AGENT_NOTIF_PROJECTOR ?? 'on').toLowerCase() !== 'off';
}

/** Canonical mention entries -> {actorId|npub}. Visible body text is never consulted. */
export function canonicalMentionRefs(value: unknown): Array<{ actorId: string | null; npub: string | null }> {
  const list = Array.isArray(value) ? value : Array.isArray((value as any)?.current) ? (value as any).current : [];
  const out: Array<{ actorId: string | null; npub: string | null }> = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const actorId = isUuid((entry as any).actor_id) ? (entry as any).actor_id as string : null;
    const npub = typeof (entry as any).npub === 'string' && (entry as any).npub.startsWith('npub1') ? (entry as any).npub as string : null;
    if (actorId || npub) out.push({ actorId, npub });
  }
  return out;
}

const mentionAddresses = (value: unknown, kind: AgentNotificationKind, reason: string): AgentAddress[] =>
  canonicalMentionRefs(value).map((ref) => ({ actorId: ref.actorId, npub: ref.npub, kind, reason }));

/** Pure-ish derivation: reads only the outbox payload plus the minimal source rows needed to bind ids. */
export async function deriveAgentNotifications(tx: Sql, ob: OutboxRow, snapshot: AddressingSnapshot | null = null): Promise<Derivation> {
  const w = ob.workspace_id;
  const payload = ob.payload ?? {};
  const type = ob.event_type.replace(/^flightdeck_pg\./, '');

  if (type === 'message.created' || type === 'message.revised') {
    if (!isUuid(ob.entity_id)) return { skip: 'no_entity' };
    const [message] = await tx<{ id: string; thread_id: string | null; channel_id: string; scope_id: string; created_by_actor_id: string; row_version: number; metadata: any }[]>`
      SELECT id, thread_id, channel_id, scope_id, created_by_actor_id, row_version, metadata FROM flightdeck_pg_messages
      WHERE workspace_id = ${w} AND id = ${ob.entity_id} AND deleted_at IS NULL`;
    if (!message) return { skip: 'source_deleted' };
    const [channel] = await tx<{ kind: string; participant_npubs: string[] | null; archived_at: Date | null }[]>`
      SELECT kind, participant_npubs, archived_at FROM flightdeck_pg_channels WHERE workspace_id = ${w} AND id = ${message.channel_id}`;
    if (!channel || channel.archived_at) return { skip: 'channel_unavailable' };
    const revised = type === 'message.revised';
    const addresses: AgentAddress[] = mentionAddresses(revised ? payload.newly_added_mentions : payload.mentions, 'chat_mention', 'canonical_mention');
    const self = await selfAddress(tx, w, ob, message, revised);
    if (self) addresses.unshift(self);
    if (!revised) {
      // Explicit Agent Direct branch recipient and DM participants come from the snapshot taken in the source
      // transaction. Backfilled rows have no snapshot: the current row is used only while it is still at the event's
      // revision, otherwise these addresses are dropped (fail closed).
      const atRevision = Number(message.row_version) === Number(ob.entity_row_version ?? -1);
      const facts = snapshot ?? (atRevision
        ? { agent_direct_recipient_npub: message.metadata?.agent_direct_recipient_npub ?? null, channel_kind: channel.kind, dm_participant_npubs: channel.participant_npubs ?? [] }
        : null);
      const explicit = facts?.agent_direct_recipient_npub;
      if (typeof explicit === 'string' && explicit.startsWith('npub1')) addresses.push({ npub: explicit.trim(), kind: 'agent_direct_recipient', reason: 'explicit_recipient' });
      if (facts?.channel_kind === 'dm') for (const npub of facts.dm_participant_npubs ?? []) addresses.push({ npub, kind: 'direct_message', reason: 'dm_participant' });
    }
    return {
      source: {
        type: 'message', id: message.id, version: ob.entity_row_version ?? message.row_version, scopeId: message.scope_id, channelId: message.channel_id,
        threadId: message.thread_id, taskId: null, docId: null, authorActorId: message.created_by_actor_id, aclFamily: 'message',
        dedupeBase: `message:${message.id}`,
      },
      addresses,
    };
  }

  if (type === 'task_comment.created') {
    const [row] = await tx<{ id: string; task_id: string; channel_id: string; scope_id: string; created_by_actor_id: string; row_version: number }[]>`
      SELECT c.id, c.task_id, c.channel_id, c.scope_id, c.created_by_actor_id, c.row_version
      FROM flightdeck_pg_task_comments c JOIN flightdeck_pg_tasks t ON t.workspace_id = c.workspace_id AND t.id = c.task_id AND t.deleted_at IS NULL
      WHERE c.workspace_id = ${w} AND c.id = ${ob.entity_id} AND c.deleted_at IS NULL`;
    if (!row) return { skip: 'source_deleted' };
    return {
      source: { type: 'task_comment', id: row.id, version: ob.entity_row_version ?? row.row_version, scopeId: row.scope_id, channelId: row.channel_id, threadId: null, taskId: row.task_id, docId: null, authorActorId: row.created_by_actor_id, aclFamily: 'task_comment', dedupeBase: `task_comment:${row.id}` },
      addresses: mentionAddresses(payload.mentions, 'task_comment_mention', 'canonical_mention'),
    };
  }

  if (type === 'doc_comment.created' || type === 'document_comment_mention_added') {
    const commentId = type === 'doc_comment.created' ? ob.entity_id : [payload.comment_id].find(isUuid) ?? null;
    if (!isUuid(commentId)) return { skip: 'no_entity' };
    const [row] = await tx<{ id: string; doc_id: string; channel_id: string; scope_id: string; created_by_actor_id: string; row_version: number }[]>`
      SELECT c.id, c.doc_id, c.channel_id, c.scope_id, c.created_by_actor_id, c.row_version
      FROM flightdeck_pg_doc_comments c JOIN flightdeck_pg_docs d ON d.workspace_id = c.workspace_id AND d.id = c.doc_id AND d.deleted_at IS NULL
      WHERE c.workspace_id = ${w} AND c.id = ${commentId} AND c.deleted_at IS NULL`;
    if (!row) return { skip: 'source_deleted' };
    // Both events announce the same comment; the shared dedupe base delivers it once.
    return {
      source: { type: 'doc_comment', id: row.id, version: row.row_version, scopeId: row.scope_id, channelId: row.channel_id, threadId: null, taskId: null, docId: row.doc_id, authorActorId: row.created_by_actor_id, aclFamily: 'doc_comment', dedupeBase: `doc_comment:${row.id}` },
      addresses: mentionAddresses(type === 'doc_comment.created' ? payload.mentions : payload.added_mentions, 'document_comment_mention', 'canonical_mention'),
    };
  }

  if (type === 'document_mention_added') {
    const docId = [payload.doc_id, payload.document_id, ob.entity_id].find(isUuid) ?? null;
    if (!docId) return { skip: 'no_entity' };
    const [doc] = await tx<{ id: string; channel_id: string; scope_id: string; row_version: number }[]>`
      SELECT id, channel_id, scope_id, row_version FROM flightdeck_pg_docs WHERE workspace_id = ${w} AND id = ${docId} AND deleted_at IS NULL`;
    if (!doc) return { skip: 'source_deleted' };
    return {
      source: { type: 'doc', id: doc.id, version: Number(payload.document_row_version ?? ob.entity_row_version ?? doc.row_version), scopeId: doc.scope_id, channelId: doc.channel_id, threadId: null, taskId: null, docId: doc.id, authorActorId: ob.actor_id, aclFamily: 'doc', dedupeBase: `document_mention:${doc.id}:${ob.id}` },
      addresses: mentionAddresses(payload.added_mentions, 'document_mention', 'canonical_mention'),
    };
  }

  if (type === 'task_assignment.assigned' || type === 'task.created' || type === 'task.updated') {
    const taskId = [payload.task_id, ob.entity_id].find(isUuid) ?? null;
    if (!taskId) return { skip: 'no_entity' };
    const [task] = await tx<{ id: string; channel_id: string; scope_id: string; row_version: number }[]>`
      SELECT id, channel_id, scope_id, row_version FROM flightdeck_pg_tasks WHERE workspace_id = ${w} AND id = ${taskId} AND deleted_at IS NULL`;
    if (!task) return { skip: 'source_deleted' };
    const addresses: AgentAddress[] = [];
    let assignee: { actorId?: string | null; npub?: string | null } | null = null;
    if (type === 'task_assignment.assigned') {
      const actorId = [payload.assignee_actor_id, payload.actor_id].find(isUuid) ?? null;
      const npub = typeof payload.assignee_npub === 'string' ? payload.assignee_npub : null;
      if (actorId || npub) assignee = { actorId, npub };
    } else if (type === 'task.created') {
      const npub = typeof payload.task?.assigned_to_npub === 'string' && payload.task.assigned_to_npub ? payload.task.assigned_to_npub : null;
      if (npub) assignee = { npub };
      addresses.push(...mentionAddresses(payload.mentions, 'task_mention', 'canonical_mention'));
    } else {
      const change = payload.assignment;
      if (change && typeof change.current_npub === 'string' && change.current_npub && change.current_npub !== change.previous_npub) assignee = { npub: change.current_npub };
      const previous = new Set(canonicalMentionRefs(payload.mentions?.previous).map((m) => m.actorId ?? m.npub));
      const added = canonicalMentionRefs(payload.mentions?.current).filter((m) => !previous.has(m.actorId ?? m.npub));
      addresses.push(...added.map((m) => ({ actorId: m.actorId, npub: m.npub, kind: 'task_mention' as const, reason: 'canonical_mention' })));
    }
    if (assignee) addresses.push({ ...assignee, kind: 'task_assigned', reason: 'assignee' });
    // Assignment epoch: the explicit assignment route and task metadata may both announce one assignment. Counting
    // the unassignments that committed before this event keys one notification per assignment, re-notifying only
    // after a real unassign/reassign.
    const epoch = assignee ? await assignmentEpoch(tx, w, task.id, ob.created_at) : 0;
    return {
      source: { type: 'task', id: task.id, version: Number(payload.activity_version ?? ob.entity_row_version ?? task.row_version), scopeId: task.scope_id, channelId: task.channel_id, threadId: null, taskId: task.id, docId: null, authorActorId: ob.actor_id, aclFamily: 'task', dedupeBase: `task:${task.id}:${ob.id}` },
      addresses: addresses.map((a) => a.kind === 'task_assigned' ? { ...a, reason: `assignee:e${epoch}` } : a),
    };
  }

  if (type === 'invocation.created') {
    const invocationId = [payload.invocation_id, ob.entity_id].find(isUuid) ?? null;
    if (!invocationId) return { skip: 'no_entity' };
    const [invocation] = await tx<{ id: string; channel_id: string; scope_id: string; created_by_actor_id: string; row_version: number; metadata: any; targets: any }[]>`
      SELECT id, channel_id, scope_id, created_by_actor_id, row_version, metadata, targets FROM flightdeck_pg_invocations WHERE workspace_id = ${w} AND id = ${invocationId}`;
    if (!invocation) return { skip: 'source_deleted' };
    const review = invocation.metadata?.trigger === 'full_document_review_requested';
    const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
    const targets = Array.isArray(invocation.targets) ? invocation.targets : [];
    const docTarget = targets.find((t: any) => (t?.type === 'document' || t?.type === 'doc') && isUuid(t?.id));
    const taskTarget = targets.find((t: any) => t?.type === 'task' && isUuid(t?.id));
    return {
      source: {
        type: 'invocation', id: invocation.id, version: invocation.row_version, scopeId: invocation.scope_id, channelId: invocation.channel_id, threadId: null,
        taskId: taskTarget?.id ?? null, docId: docTarget?.id ?? null, authorActorId: invocation.created_by_actor_id,
        aclFamily: docTarget ? 'doc' : taskTarget ? 'task' : 'channel', dedupeBase: `invocation:${invocation.id}`,
      },
      addresses: recipients
        .filter((r: any) => r && r.type === 'agent')
        .map((r: any) => ({ actorId: isUuid(r.actor_id) ? r.actor_id : null, npub: typeof r.npub === 'string' ? r.npub : null, kind: review ? 'document_review' as const : 'invocation' as const, reason: 'invocation_recipient' })),
    };
  }

  return { skip: 'unsupported_event_type' };
}

async function assignmentEpoch(tx: Sql, workspaceId: string, taskId: string, before: Date) {
  const [row] = await tx<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM flightdeck_pg_outbox_events
    WHERE workspace_id = ${workspaceId} AND created_at < ${before}
      AND ((event_type = 'flightdeck_pg.task_assignment.unassigned' AND (entity_id = ${taskId} OR payload->>'task_id' = ${taskId}))
        OR (event_type = 'flightdeck_pg.task.updated' AND entity_id = ${taskId} AND payload->'assignment' IS NOT NULL
            AND COALESCE(payload->'assignment'->>'previous_npub', '') <> ''
            AND COALESCE(payload->'assignment'->>'previous_npub', '') IS DISTINCT FROM COALESCE(payload->'assignment'->>'current_npub', '')))`;
  return row?.n ?? 0;
}

/**
 * Deliberate self-address: the author's own structured mention in this revision, eligible only when the STORED
 * instruction signature binds this exact revision (body, location and `mentions_sha256`) and the message names a live
 * non-self origin notification of the author in the same channel and thread. Ordinary own output never qualifies.
 */
async function selfAddress(tx: Sql, w: string, ob: OutboxRow, message: { id: string; thread_id: string | null; channel_id: string; created_by_actor_id: string; row_version: number; metadata: any; body?: string }, revised: boolean): Promise<AgentAddress | null> {
  const payload = ob.payload ?? {};
  const [author] = await tx<{ npub: string }[]>`SELECT npub FROM flightdeck_pg_actors WHERE id = ${message.created_by_actor_id}`;
  if (!author) return null;
  const mentionsSelf = canonicalMentionRefs(revised ? payload.newly_added_mentions : payload.mentions)
    .some((ref) => ref.actorId === message.created_by_actor_id || ref.npub === author.npub);
  if (!mentionsSelf) return null;
  // Only the revision this event was produced by; a later edit makes the event ineligible (fail closed).
  if (Number(message.row_version) !== Number(ob.entity_row_version ?? -1)) return null;
  const origin = message.metadata?.[AGENT_ORIGIN_METADATA_KEY];
  if (typeof origin !== 'string' || !isUuid(origin)) return null;
  const [row] = await tx<{ body: string }[]>`SELECT body FROM flightdeck_pg_messages WHERE workspace_id = ${w} AND id = ${message.id}`;
  if (!row) return null;
  const bound = storedSignatureBindsRevision({
    signature: message.metadata?.agent_instruction_signature, body: row.body, mentions: message.metadata?.mentions, authorNpub: author.npub,
    workspaceId: w, channelId: message.channel_id, threadId: message.thread_id, messageId: message.id, revision: Number(message.row_version), revised,
  });
  if (!bound) return null;
  if (!await liveOrigin(tx, { workspaceId: w, actorId: message.created_by_actor_id, notificationId: origin, channelId: message.channel_id, threadId: message.thread_id })) return null;
  return { actorId: message.created_by_actor_id, npub: author.npub, kind: 'chat_mention', reason: 'self_mention', originNotificationId: origin };
}

/** Resolve addresses to eligible recipients (human/agent label independent, member, not author unless self_mention, current ACL). */
async function resolveRecipients(tx: Sql, workspaceId: string, source: AgentSource, addresses: AgentAddress[]) {
  const npubs = [...new Set(addresses.map((a) => a.npub).filter((v): v is string => Boolean(v)))];
  const ids = [...new Set(addresses.map((a) => a.actorId).filter((v): v is string => Boolean(v)))];
  if (!npubs.length && !ids.length) return new Map<string, AgentAddress>();
  const actors = await tx<{ id: string; npub: string }[]>`
    SELECT a.id, a.npub FROM flightdeck_pg_actors a
    JOIN flightdeck_pg_workspace_memberships m ON m.workspace_id = ${workspaceId} AND m.actor_id = a.id
    WHERE (a.id = ANY(${ids}::uuid[]) OR a.npub = ANY(${npubs}::text[]))
      AND (a.kind IN ('human', 'agent') OR EXISTS (SELECT 1 FROM flightdeck_pg_agent_access_profiles p WHERE p.actor_id = a.id AND p.workspace_id = ${workspaceId}))`;
  const byNpub = new Map(actors.map((a) => [a.npub, a.id]));
  const known = new Set(actors.map((a) => a.id));
  const aclKey = `channel:${source.channelId}:${source.aclFamily}`;
  const readable = actors.length
    ? new Set((await tx<{ id: string }[]>`
        SELECT x.id FROM unnest(${actors.map((a) => a.id)}::uuid[]) AS x(id)
        WHERE flightdeck_pg_record_access(${workspaceId}::uuid, x.id) @> to_jsonb(${aclKey}::text)`).map((r) => r.id))
    : new Set<string>();
  // First address per recipient wins (explicit mention before DM participation).
  const out = new Map<string, AgentAddress>();
  for (const address of addresses) {
    const id = address.actorId && known.has(address.actorId) ? address.actorId : address.npub ? byNpub.get(address.npub) : undefined;
    if (!id || (id === source.authorActorId && address.reason !== 'self_mention') || !readable.has(id) || out.has(id)) continue;
    out.set(id, address);
  }
  return out;
}

export async function claimAgentIntake(sql: Sql, owner: string, limit: number, leaseSeconds: number): Promise<IntakeRow[]> {
  return sql<IntakeRow[]>`
    UPDATE flightdeck_pg_agent_notification_intake i
    SET state = 'leased', lease_owner = ${owner}, lease_until = NOW() + make_interval(secs => ${leaseSeconds}), attempt_count = attempt_count + 1
    WHERE i.id IN (
      SELECT id FROM flightdeck_pg_agent_notification_intake
      WHERE state IN ('pending', 'leased') AND next_attempt_at <= NOW() AND (state = 'pending' OR lease_until < NOW())
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT ${limit}
    )
    RETURNING i.id, i.workspace_id, i.outbox_event_id, i.attempt_count, i.addressing_snapshot`;
}

export async function projectAgentIntakeRow(tx: Sql, row: IntakeRow): Promise<{ outcome: string; projected: number }> {
  const [ob] = await tx<OutboxRow[]>`SELECT * FROM flightdeck_pg_outbox_events WHERE id = ${row.outbox_event_id} AND workspace_id = ${row.workspace_id}`;
  if (!ob) return { outcome: 'outbox_missing', projected: 0 };
  const derived = await deriveAgentNotifications(tx, ob, row.addressing_snapshot ?? null);
  if ('skip' in derived) return { outcome: derived.skip, projected: 0 };
  const recipients = await resolveRecipients(tx, ob.workspace_id, derived.source, derived.addresses);
  const source = derived.source;
  let projected = 0;
  // Deterministic lock order across recipients avoids deadlocks between concurrent projectors.
  for (const recipient of [...recipients.keys()].sort()) {
    const address = recipients.get(recipient)!;
    await tx`INSERT INTO flightdeck_pg_agent_notification_counters (workspace_id, recipient_actor_id) VALUES (${ob.workspace_id}, ${recipient}) ON CONFLICT DO NOTHING`;
    await tx`SELECT 1 FROM flightdeck_pg_agent_notification_counters WHERE workspace_id = ${ob.workspace_id} AND recipient_actor_id = ${recipient} FOR UPDATE`;
    const dedupeKey = address.kind === 'task_assigned' ? `task_assigned:${source.id}:${address.reason}` : source.dedupeBase;
    const [exists] = await tx`SELECT 1 FROM flightdeck_pg_agent_notifications WHERE workspace_id = ${ob.workspace_id} AND recipient_actor_id = ${recipient} AND dedupe_key = ${dedupeKey}`;
    if (exists) continue;
    const [seqRow] = await tx<{ s: string }[]>`SELECT flightdeck_pg_agent_notification_next_seq(${ob.workspace_id}::uuid, ${recipient}::uuid) AS s`;
    await tx`
      INSERT INTO flightdeck_pg_agent_notifications (
        workspace_id, recipient_actor_id, seq, kind, reason, addressing, source_outbox_event_id, source_event_type, source_created_at,
        source_type, source_id, source_version, scope_id, channel_id, thread_id, task_id, doc_id, author_actor_id, acl_key, dedupe_key,
        origin_notification_id
      ) VALUES (
        ${ob.workspace_id}, ${recipient}, ${Number(seqRow!.s)}, ${address.kind}, ${address.reason},
        ${tx.json({ rule: address.kind, via: address.reason, outbox_event_id: ob.id, source_version: source.version } as any)},
        ${ob.id}, ${ob.event_type}, ${ob.created_at}, ${source.type}, ${source.id}, ${source.version}, ${source.scopeId}, ${source.channelId},
        ${source.threadId}, ${source.taskId}, ${source.docId}, ${source.authorActorId}, ${`channel:${source.channelId}:${source.aclFamily}`}, ${dedupeKey},
        ${address.originNotificationId ?? null}
      )`;
    projected += 1;
  }
  return { outcome: projected ? 'projected' : 'no_recipients', projected };
}

export type AgentProjectionStats = { claimed: number; done: number; failed: number; dead: number };

export async function processAgentIntakeBatch(options: { sql?: Sql; owner?: string; limit?: number; leaseSeconds?: number } = {}): Promise<AgentProjectionStats> {
  const sql = options.sql ?? getDb();
  const owner = options.owner ?? `agent-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  // UPDATE ... RETURNING does not preserve the claim order; project in intake (source commit) order.
  const rows = (await claimAgentIntake(sql, owner, options.limit ?? 25, options.leaseSeconds ?? 60)).sort((a, b) => Number(a.id) - Number(b.id));
  const stats: AgentProjectionStats = { claimed: rows.length, done: 0, failed: 0, dead: 0 };
  for (const row of rows) {
    try {
      await sql.begin(async (tx) => {
        const result = await projectAgentIntakeRow(tx as unknown as Sql, row);
        await tx`UPDATE flightdeck_pg_agent_notification_intake SET state = 'done', done_at = NOW(), lease_owner = NULL, lease_until = NULL,
          outcome = ${result.outcome}, last_error = NULL WHERE id = ${row.id}`;
      });
      stats.done += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const dead = row.attempt_count >= MAX_INTAKE_ATTEMPTS;
      await sql`
        UPDATE flightdeck_pg_agent_notification_intake
        SET state = ${dead ? 'dead' : 'pending'}, lease_owner = NULL, lease_until = NULL, last_error = ${message},
            next_attempt_at = NOW() + make_interval(secs => ${Math.min(3600, 2 ** row.attempt_count * 5)})
        WHERE id = ${row.id}`;
      if (dead) {
        await sql`INSERT INTO flightdeck_pg_agent_notification_audit (workspace_id, action, detail)
          VALUES (${row.workspace_id}, 'intake.dead_lettered', ${sql.json({ intake_id: row.id, outbox_event_id: row.outbox_event_id, error: message } as any)})`;
      }
      stats[dead ? 'dead' : 'failed'] += 1;
      console.error(`[agent-notifications] projection ${dead ? 'dead-lettered' : 'failed'} intake=${row.id} attempt=${row.attempt_count}: ${message}`);
    }
  }
  return stats;
}

/** Bounded retention: rows older than the resume window are removed and the per-recipient retention floor advances. */
export async function runAgentNotificationMaintenance(sql: Sql = getDb(), batch = 500, retentionDays = 7) {
  // Per recipient, remove only the contiguous prefix of rows older than the window (seq below the first row that is
  // still within it), so a lower-seq row committed late is never skipped; the retention floor is that prefix's end.
  await sql`
    WITH cutoff AS (SELECT NOW() - make_interval(days => ${retentionDays}) AS at),
    bounds AS (
      SELECT n.workspace_id, n.recipient_actor_id,
        COALESCE(MIN(n.seq) FILTER (WHERE n.created_at >= (SELECT at FROM cutoff)) - 1, MAX(n.seq)) AS floor_seq
      FROM flightdeck_pg_agent_notifications n
      WHERE EXISTS (SELECT 1 FROM flightdeck_pg_agent_notifications o WHERE o.workspace_id = n.workspace_id
        AND o.recipient_actor_id = n.recipient_actor_id AND o.created_at < (SELECT at FROM cutoff))
      GROUP BY n.workspace_id, n.recipient_actor_id
    ),
    gone AS (
      DELETE FROM flightdeck_pg_agent_notifications d USING bounds b
      WHERE d.id IN (
        SELECT x.id FROM flightdeck_pg_agent_notifications x JOIN bounds bb ON bb.workspace_id = x.workspace_id AND bb.recipient_actor_id = x.recipient_actor_id
        WHERE x.seq <= bb.floor_seq ORDER BY x.seq LIMIT ${batch}
      ) AND d.workspace_id = b.workspace_id AND d.recipient_actor_id = b.recipient_actor_id
      RETURNING d.workspace_id, d.recipient_actor_id, d.seq
    )
    UPDATE flightdeck_pg_agent_notification_counters c SET retention_floor_seq = GREATEST(c.retention_floor_seq, g.m)
    FROM (SELECT workspace_id, recipient_actor_id, MAX(seq) AS m FROM gone GROUP BY 1, 2) g
    WHERE c.workspace_id = g.workspace_id AND c.recipient_actor_id = g.recipient_actor_id`;
  await sql`DELETE FROM flightdeck_pg_agent_notification_intake WHERE id IN (SELECT id FROM flightdeck_pg_agent_notification_intake WHERE state = 'done' AND done_at < NOW() - INTERVAL '14 days' LIMIT ${batch})`;
  await sql`DELETE FROM flightdeck_pg_nip98_consumed_events WHERE consumed_at < NOW() - INTERVAL '15 minutes'`;
}

export const agentWorkerStatus = { running: false, lastTickAt: null as string | null, lastError: null as string | null, projected: 0, failed: 0, dead: 0 };
let agentTimer: ReturnType<typeof setInterval> | null = null;
let agentBusy = false;
let agentLastMaintenance = 0;

/** Independent of the human projector: AGENT_NOTIF_PROJECTOR=off disables only the agent inbox projection. */
export function startAgentNotificationWorker(sql: Sql = getDb()) {
  if (agentTimer) return stopAgentNotificationWorker;
  if (!agentProjectorEnabled()) {
    console.log('[agent-notifications] projector disabled by AGENT_NOTIF_PROJECTOR=off');
    return stopAgentNotificationWorker;
  }
  agentWorkerStatus.running = true;
  const tick = async () => {
    if (agentBusy) return;
    agentBusy = true;
    try {
      for (let i = 0; i < 10; i += 1) {
        const stats = await processAgentIntakeBatch({ sql, limit: 25 });
        agentWorkerStatus.projected += stats.done;
        agentWorkerStatus.failed += stats.failed;
        agentWorkerStatus.dead += stats.dead;
        if (stats.claimed === 0) break;
      }
      if (Date.now() - agentLastMaintenance > 10 * 60_000) {
        agentLastMaintenance = Date.now();
        await runAgentNotificationMaintenance(sql);
      }
      agentWorkerStatus.lastTickAt = new Date().toISOString();
      agentWorkerStatus.lastError = null;
    } catch (error) {
      agentWorkerStatus.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      console.error('[agent-notifications] worker tick failed:', agentWorkerStatus.lastError);
    } finally {
      agentBusy = false;
    }
  };
  agentTimer = setInterval(tick, Math.max(250, Number(Bun.env.AGENT_NOTIF_POLL_MS) || 1000));
  void tick();
  console.log('[agent-notifications] projection worker started');
  return stopAgentNotificationWorker;
}

export function stopAgentNotificationWorker() {
  if (agentTimer) clearInterval(agentTimer);
  agentTimer = null;
  agentWorkerStatus.running = false;
}
