import { type Sql, CORE_SOURCE, NotificationError, lockRecipient } from './notification-core';

export type ChannelNotificationMode = 'all' | 'mentions_only';
export type ChannelNotificationPreference = { channel_id: string; mode: ChannelNotificationMode; row_version: number };
type Recipient = { workspaceId: string; actorId: string };

/** A channel mute is independent of category/app rules. Direct mentions, DMs, assignments and external apps keep their own rules. */
export function isOrdinaryChannelActivity(source: string, category: string) {
  return source === CORE_SOURCE && category === 'chat_thread';
}

/** SQL predicate for notification item alias i; use on every collection/count/change/bulk selection. */
export const channelActivityVisibleSql = (sql: Sql) => sql`NOT (
  i.source_app_id = ${CORE_SOURCE} AND i.category = 'chat_thread'
  AND EXISTS (SELECT 1 FROM flightdeck_pg_notification_channel_preferences cp
    JOIN flightdeck_pg_channels c ON c.workspace_id = cp.workspace_id AND c.id = cp.channel_id
    WHERE cp.workspace_id = i.workspace_id AND cp.actor_id = i.recipient_actor_id
      AND cp.channel_id = i.acl_channel_id AND cp.mode = 'mentions_only' AND c.kind <> 'dm')
)`;

/** Used at projection and both push delivery boundaries, never inferred from message substrings. */
export async function channelActivityAllowed(sql: Sql, r: Recipient, channelId: string | null, source: string, category: string) {
  if (!channelId || !isOrdinaryChannelActivity(source, category)) return true;
  const [muted] = await sql`SELECT 1 FROM flightdeck_pg_notification_channel_preferences cp
    JOIN flightdeck_pg_channels c ON c.workspace_id = cp.workspace_id AND c.id = cp.channel_id
    WHERE cp.workspace_id = ${r.workspaceId} AND cp.actor_id = ${r.actorId} AND cp.channel_id = ${channelId}
      AND cp.mode = 'mentions_only' AND c.kind <> 'dm'`;
  return !muted;
}

async function stateIn(sql: Sql, r: Recipient) {
  const channel_preferences = await sql<ChannelNotificationPreference[]>`
    SELECT p.channel_id, p.mode, p.row_version FROM flightdeck_pg_notification_channel_preferences p
    JOIN flightdeck_pg_channels c ON c.workspace_id = p.workspace_id AND c.id = p.channel_id
    WHERE p.workspace_id = ${r.workspaceId} AND p.actor_id = ${r.actorId} AND c.kind <> 'dm'
      AND flightdeck_pg_record_access(${r.workspaceId}::uuid, ${r.actorId}::uuid) @> to_jsonb(('channel:' || c.id::text || ':message')::text)
    ORDER BY p.channel_id`;
  const [cursor] = await sql<{ rules_revision: string }[]>`SELECT rules_revision FROM flightdeck_pg_notification_cursors
    WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
  return { channel_preferences, rules_revision: Number(cursor?.rules_revision ?? 0) };
}

export async function getChannelPreferences(sql: Sql, r: Recipient) {
  return sql.begin('isolation level repeatable read read only', tx => stateIn(tx as unknown as Sql, r));
}

/** The route checks channel.read. Under the recipient lock, stale writes fail without changing any preference. */
export async function putChannelPreference(sql: Sql, r: Recipient, channelId: string, mode: ChannelNotificationMode, expectedRowVersion: number) {
  return sql.begin(async txn => {
    const tx = txn as unknown as Sql;
    await lockRecipient(tx, r.workspaceId, r.actorId);
    const [channel] = await tx<{ kind: string }[]>`SELECT kind FROM flightdeck_pg_channels
      WHERE workspace_id = ${r.workspaceId} AND id = ${channelId}`;
    if (!channel) throw new NotificationError(404, 'channel_not_found', 'Channel not found');
    if (channel.kind === 'dm') throw new NotificationError(400, 'channel_mute_not_supported', 'Direct messages use the direct-message notification preference');
    const [current] = await tx<ChannelNotificationPreference[]>`SELECT channel_id, mode, row_version FROM flightdeck_pg_notification_channel_preferences
      WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId} AND channel_id = ${channelId}`;
    if ((current?.row_version ?? 0) !== expectedRowVersion) {
      throw new NotificationError(409, 'channel_preference_conflict', 'This channel preference changed on another device; review and try again', await stateIn(tx, r));
    }
    await tx`INSERT INTO flightdeck_pg_notification_channel_preferences (workspace_id, actor_id, channel_id, mode)
      VALUES (${r.workspaceId}, ${r.actorId}, ${channelId}, ${mode})
      ON CONFLICT (workspace_id, actor_id, channel_id) DO UPDATE SET mode = EXCLUDED.mode,
        row_version = flightdeck_pg_notification_channel_preferences.row_version + 1, updated_at = NOW()`;
    await tx`UPDATE flightdeck_pg_notification_cursors SET rules_revision = rules_revision + 1
      WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
    const [cursor] = await tx<{ last_seq: string }[]>`SELECT last_seq FROM flightdeck_pg_notification_cursors
      WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
    // Content-free recipient-private hint wakes connected clients even when item sequence did not change.
    await tx`SELECT flightdeck_pg_notification_emit_hint(${r.workspaceId}::uuid, ${r.actorId}::uuid, NULL::uuid, ${Number(cursor?.last_seq ?? 0)}::bigint, 'preferences')`;
    return stateIn(tx, r);
  });
}
