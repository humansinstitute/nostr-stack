import type { Sql } from './notification-core';
import { isUuid } from './notification-core';
import {
  WINDOW_BYTES, WINDOW_MESSAGES, agentNotificationContextPolicy, boundWindow, boundedTranscript, contextIn, docBody, fail,
  loadOwnNotification, lockChannels, lockPrincipalAccess, serializeMessage, withAuthorizedSnapshot, type Recipient,
} from './agent-notifications';

/**
 * Reference reads for a notification-only agent (contract: docs/contract/agent-notifications-v1.md, "Referenced records").
 *
 * A human who writes a reference token (`@[label](mention:chat:<channel>#<thread>)`, `mention:doc:<id>`,
 * `mention:task:<id>`) in the notification's trigger or its bounded transcript delegates read access to that exact
 * record. The read is served only while the notification is live for the recipient AND the human who wrote the token
 * currently holds record access to the target in the same workspace. Every refusal is the same 404, so the route is no
 * existence oracle for unreferenced, foreign-workspace, deleted or inaccessible records.
 */
export type ReferenceTarget = { type: 'thread'; channelId: string; threadId: string } | { type: 'doc'; id: string } | { type: 'task'; id: string };

const TOKEN = /mention:(chat|doc|document|task):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?/gi;
const refNotFound = () => fail(404, 'reference_not_found', 'Reference not found');

/** Canonical key of a token or target; null for a chat link that names no thread. */
const referenceKey = (kind: string, id: string, threadId?: string | null) => {
  const type = kind.toLowerCase();
  if (type === 'chat') return threadId ? `thread:${id.toLowerCase()}:${threadId.toLowerCase()}` : null;
  return `${type === 'task' ? 'task' : 'doc'}:${id.toLowerCase()}`;
};
const targetKey = (target: ReferenceTarget) => target.type === 'thread' ? `thread:${target.channelId.toLowerCase()}:${target.threadId.toLowerCase()}` : `${target.type}:${target.id.toLowerCase()}`;

export function referenceKeysIn(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    const key = referenceKey(match[1]!, match[2]!, match[3]);
    if (key) keys.add(key);
  }
  return keys;
}

type TextSource = { actorId: string | null | undefined; text: string };

type AuthoredTable = 'flightdeck_pg_tasks' | 'flightdeck_pg_docs' | 'flightdeck_pg_task_comments' | 'flightdeck_pg_doc_comments' | 'flightdeck_pg_invocations';

/**
 * Actor who wrote the current text of each row. Only rows whose creator is also their last updater are attributable: once
 * anyone else has touched the row the text may carry their edit, so it names no writer and delegates nothing.
 */
async function soleWriters(t: Sql, w: string, table: AuthoredTable, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && isUuid(id)))];
  if (!wanted.length) return new Map();
  const rows = table === 'flightdeck_pg_invocations'
    ? await t<{ id: string; actor: string }[]>`SELECT id, created_by_actor_id AS actor FROM flightdeck_pg_invocations WHERE workspace_id = ${w} AND id = ANY(${wanted}::uuid[])`
    : await t<{ id: string; actor: string }[]>`SELECT id, created_by_actor_id AS actor FROM ${t(table)} WHERE workspace_id = ${w} AND id = ANY(${wanted}::uuid[]) AND created_by_actor_id = updated_by_actor_id`;
  return new Map(rows.map((row) => [row.id, row.actor]));
}

/** Text the notification itself carries, each piece attributed to the actor who actually wrote it (never the notifier). */
async function referenceSources(t: Sql, w: string, context: any): Promise<TextSource[]> {
  const trigger = context.trigger ?? {};
  const sources: TextSource[] = [];
  const message = trigger.message;
  const sole = (m: any) => (m?.created_by_actor_id && m.created_by_actor_id === m.updated_by_actor_id ? m.created_by_actor_id : null);
  if (message) sources.push({ actorId: sole(message), text: String(message.body ?? '') });
  for (const earlier of context.window?.messages ?? []) sources.push({ actorId: sole(earlier), text: String(earlier.body ?? '') });
  const windowComments: any[] = context.window?.comments ?? [];
  const commentTable: AuthoredTable = trigger.type === 'doc_comment' ? 'flightdeck_pg_doc_comments' : 'flightdeck_pg_task_comments';
  const [tasks, docs, comments, windowAuthors, invocations] = await Promise.all([
    soleWriters(t, w, 'flightdeck_pg_tasks', [trigger.task?.id]),
    soleWriters(t, w, 'flightdeck_pg_docs', [trigger.document?.id]),
    soleWriters(t, w, commentTable, [trigger.comment?.id]),
    soleWriters(t, w, 'flightdeck_pg_task_comments', windowComments.map((c) => c.id)),
    soleWriters(t, w, 'flightdeck_pg_invocations', [trigger.invocation?.id]),
  ]);
  if (trigger.task) sources.push({ actorId: tasks.get(trigger.task.id), text: `${trigger.task.title ?? ''}\n${trigger.task.description ?? ''}` });
  if (trigger.comment) sources.push({ actorId: comments.get(trigger.comment.id), text: String(trigger.comment.body ?? '') });
  for (const c of windowComments) sources.push({ actorId: windowAuthors.get(c.id), text: String(c.body ?? '') });
  if (trigger.invocation) sources.push({ actorId: invocations.get(trigger.invocation.id), text: String(trigger.invocation.prompt ?? '') });
  const body = trigger.document?.body;
  if (body?.base64_data) sources.push({ actorId: docs.get(trigger.document.id), text: Buffer.from(String(body.base64_data), 'base64').toString('utf8') });
  return sources;
}

type Resolved = { channelId: string; aclFamily: string; payload: () => Promise<Record<string, unknown>> };

async function resolveTarget(t: Sql, w: string, target: ReferenceTarget): Promise<Resolved | null> {
  if (target.type === 'thread') {
    const [thread] = await t<{ id: string; title: string; source_message_id: string | null; parent_thread_id: string | null; branch_point_message_id: string | null }[]>`
      SELECT th.id, th.title, th.source_message_id, th.parent_thread_id, th.branch_point_message_id FROM flightdeck_pg_threads th
      JOIN flightdeck_pg_channels c ON c.workspace_id = th.workspace_id AND c.id = th.channel_id AND c.archived_at IS NULL
      WHERE th.workspace_id = ${w} AND th.channel_id = ${target.channelId} AND th.id = ${target.threadId} AND th.deleted_at IS NULL`;
    if (!thread) return null;
    return {
      channelId: target.channelId, aclFamily: 'message',
      payload: async () => {
        const transcript = await boundedTranscript(t, w, { channel_id: target.channelId, thread_id: target.threadId, created_at: new Date(0), id: '' }, null);
        return {
          thread, channel_id: target.channelId, thread_id: target.threadId, effective_transcript: true,
          messages: transcript.rows.map((m) => serializeMessage(m, [])), truncated: transcript.truncated,
        };
      },
    };
  }
  if (target.type === 'doc') {
    const [doc] = await t<{ channel_id: string }[]>`
      SELECT d.channel_id FROM flightdeck_pg_docs d JOIN flightdeck_pg_channels c ON c.workspace_id = d.workspace_id AND c.id = d.channel_id AND c.archived_at IS NULL
      WHERE d.workspace_id = ${w} AND d.id = ${target.id} AND d.deleted_at IS NULL`;
    if (!doc) return null;
    return {
      channelId: doc.channel_id, aclFamily: 'doc',
      payload: async () => {
        const document = await docBody(t, w, target.id);
        if (!document) throw refNotFound();
        return { document };
      },
    };
  }
  const [task] = await t<{ id: string; scope_id: string; channel_id: string; title: string; description: string | null; state: string; priority: string | null; metadata: any; row_version: number }[]>`
    SELECT k.id, k.scope_id, k.channel_id, k.title, k.description, k.state, k.priority, k.metadata, k.row_version FROM flightdeck_pg_tasks k
    JOIN flightdeck_pg_channels c ON c.workspace_id = k.workspace_id AND c.id = k.channel_id AND c.archived_at IS NULL
    WHERE k.workspace_id = ${w} AND k.id = ${target.id} AND k.deleted_at IS NULL`;
  if (!task) return null;
  return {
    channelId: task.channel_id, aclFamily: 'task',
    payload: async () => {
      const rows = await t<{ id: string; body: string; author_npub: string; created_at: Date }[]>`
        SELECT c.id, c.body, a.npub AS author_npub, c.created_at FROM flightdeck_pg_task_comments c JOIN flightdeck_pg_actors a ON a.id = c.created_by_actor_id
        WHERE c.workspace_id = ${w} AND c.task_id = ${task.id} AND c.deleted_at IS NULL ORDER BY c.created_at DESC, c.id DESC LIMIT ${WINDOW_MESSAGES + 1}`;
      const bounded = boundWindow(rows, WINDOW_MESSAGES, WINDOW_BYTES);
      return {
        task: { id: task.id, workspace_id: w, channel_id: task.channel_id, scope_id: task.scope_id, title: task.title, description: task.description, state: task.state,
          priority: task.priority, assigned_to_npub: task.metadata?.assigned_to_npub ?? null, row_version: task.row_version },
        comments: bounded.rows.map((c) => ({ id: c.id, body: c.body, author_npub: c.author_npub, created_at: new Date(c.created_at).toISOString() })),
        truncated: bounded.truncated,
      };
    },
  };
}

export async function readReference(sql: Sql, r: Recipient, notificationId: string, target: ReferenceTarget) {
  const ids = [target.type === 'thread' ? target.channelId : target.id, ...(target.type === 'thread' ? [target.threadId] : [])];
  if (!ids.every(isUuid)) throw refNotFound();
  const n = await loadOwnNotification(sql, r, notificationId);
  if (n.reason === 'self_mention') throw refNotFound();
  return withAuthorizedSnapshot(sql, r, async (t) => {
    const w = r.workspaceId;
    // Same liveness, access and relationship checks as the notification's own context.
    const context = await contextIn(t, r, n, agentNotificationContextPolicy());
    const wanted = targetKey(target);
    // Only actors who actually wrote linked text can delegate; never the notifier, never the recipient, never inferred.
    const writers = [...new Set((await referenceSources(t, w, context))
      .filter((source) => source.actorId && source.actorId !== r.actorId && referenceKeysIn(source.text).has(wanted)).map((source) => source.actorId!))];
    if (!writers.length) throw refNotFound();
    const resolved = await resolveTarget(t, w, target);
    if (!resolved) throw refNotFound();
    await lockChannels(t, w, [resolved.channelId]);
    // Delegators are authorizing principals: serialize their membership/grant/group revocation like the recipient's.
    const humans = await t<{ id: string; npub: string }[]>`
      SELECT a.id, a.npub FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.workspace_id = ${w} AND m.actor_id = a.id
      WHERE a.id = ANY(${writers}::uuid[]) AND a.kind = 'human' ORDER BY a.id`;
    for (const human of humans) await lockPrincipalAccess(t, { workspaceId: w, actorId: human.id, npub: human.npub });
    // At least one delegating human must be able to read the target now.
    const [delegation] = await t<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM unnest(${humans.map((h) => h.id)}::uuid[]) AS h(id)
        WHERE flightdeck_pg_record_access(${w}::uuid, h.id) @> to_jsonb(${`channel:${resolved.channelId}:${resolved.aclFamily}`}::text)
      ) AS ok`;
    if (!delegation?.ok) throw refNotFound();
    return { ok: true, referenced: true, notification_id: n.id, reference: { type: target.type, ...(target.type === 'thread' ? { channel_id: target.channelId, thread_id: target.threadId } : { id: target.id }) },
      ...(await resolved.payload()) };
  });
}
