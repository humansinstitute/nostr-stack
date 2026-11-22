import { getDb } from '../db';
import type { FlightDeckPgWorkspaceReportResponse, FlightDeckPgWorkspaceReportRange } from '../types';

type Db = ReturnType<typeof getDb>;
export const workspaceReportTaskStates = ['new', 'ready', 'in_progress', 'review', 'done', 'archive', 'backlog', 'blocked', 'archived'] as const;
export class WorkspaceReportError extends Error {
  constructor(public code: 'report_too_large' | 'report_unavailable') { super('Workspace report unavailable'); }
}
export function parseWorkspaceReportQuery(params: URLSearchParams): { range: FlightDeckPgWorkspaceReportRange; topN: number } | null {
  if ([...params.keys()].some(key => !['range', 'top_n', 'app_npub'].includes(key)) ||
      [...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) return null;
  const range = params.get('range');
  if (range !== '7d' && range !== '30d' && range !== '90d' && range !== 'all') return null;
  const top = params.get('top_n') ?? '10';
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(top)) return null;
  return { range, topN: Number(top) };
}
export function reportCount(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^(0|[1-9][0-9]*)$/.test(String(value))) throw new WorkspaceReportError('report_unavailable');
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new WorkspaceReportError('report_unavailable');
  return count;
}
function add(a: number, b: number) { return reportCount(a + b); }

/** All auth context and queries must share the caller's READ ONLY REPEATABLE READ transaction. */
export async function readFlightDeckPgWorkspaceReport(input: {
  workspaceId: string; actorId: string; groupIds: string[]; range: FlightDeckPgWorkspaceReportRange; topN: number;
}, sql: Db): Promise<Omit<FlightDeckPgWorkspaceReportResponse, 'identity'>> {
  const [window] = await sql<{ as_of: Date; from: Date | null }[]>`
    SELECT date_trunc('milliseconds', transaction_timestamp()) AS as_of,
      CASE WHEN ${input.range} = 'all' THEN NULL ELSE date_trunc('milliseconds', transaction_timestamp()) -
        make_interval(hours => ${input.range === '7d' ? 168 : input.range === '90d' ? 2160 : 720}) END AS "from"
  `;
  const groups = input.groupIds.length ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  // The bounded universe is resolved BEFORE scanning history. Grant EXISTS avoids
  // duplicate actor/group grants multiplying either rows or aggregate counts.
  const channels = await sql<{ id: string; scope_id: string; name: string; scope_name: string; tasks_read: boolean }[]>`
    WITH grants AS MATERIALIZED (
      SELECT pg.resource_channel_id, pg.permission FROM flightdeck_pg_permission_grants pg
      JOIN flightdeck_pg_permission_definitions pd ON pd.permission=pg.permission AND pd.resource_type='channel'
      WHERE pg.workspace_id=${input.workspaceId} AND pg.resource_type='channel' AND pg.revoked_at IS NULL
        AND ((pg.principal_type='actor' AND pg.principal_actor_id=${input.actorId})
          OR (pg.principal_type='group' AND pg.principal_group_id IN ${sql(groups)}))
        AND EXISTS(SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId})
    )
    SELECT c.id,c.scope_id,c.name,s.name AS scope_name,
      EXISTS(SELECT 1 FROM grants g WHERE g.resource_channel_id=c.id AND g.permission='task.read') AS tasks_read
    FROM flightdeck_pg_channels c JOIN flightdeck_pg_scopes s ON s.workspace_id=c.workspace_id AND s.id=c.scope_id
    WHERE c.workspace_id=${input.workspaceId} AND c.kind='channel' AND c.archived_at IS NULL AND s.archived_at IS NULL
      AND EXISTS(SELECT 1 FROM grants g WHERE g.resource_channel_id=c.id AND g.permission='channel.read')
    ORDER BY c.id LIMIT 2001
  `;
  if (channels.length > 2000) throw new WorkspaceReportError('report_too_large');
  for (const c of channels) if (typeof c.name !== 'string' || typeof c.scope_name !== 'string' ||
      c.name.length > 300 || c.scope_name.length > 300) throw new WorkspaceReportError('report_unavailable');
  const ids = channels.map(c => c.id);
  const taskIds = channels.filter(c => c.tasks_read).map(c => c.id);
  type Counts = { channel_id: string; messages: string; conversations: string; threads: string; documents: string; files: string; states: Record<string, string> };
  const rows = ids.length ? await sql<Counts[]>`
    SELECT c.id AS channel_id, activity.messages,activity.conversations,
      (SELECT count(*)::text FROM flightdeck_pg_threads t WHERE t.workspace_id=c.workspace_id AND t.channel_id=c.id AND t.deleted_at IS NULL AND t.archived_at IS NULL) AS threads,
      (SELECT count(*)::text FROM flightdeck_pg_docs d WHERE d.workspace_id=c.workspace_id AND d.channel_id=c.id AND d.deleted_at IS NULL AND d.archived_at IS NULL) AS documents,
      (SELECT count(*)::text FROM flightdeck_pg_files f WHERE f.workspace_id=c.workspace_id AND f.channel_id=c.id AND f.deleted_at IS NULL AND f.archived_at IS NULL) AS files,
      COALESCE((SELECT jsonb_object_agg(state,n) FROM (
        SELECT t.state,count(*)::text AS n FROM flightdeck_pg_tasks t
        WHERE t.workspace_id=c.workspace_id AND t.channel_id=c.id AND t.deleted_at IS NULL
          AND t.channel_id IN ${sql(taskIds.length ? taskIds : ['00000000-0000-0000-0000-000000000000'])}
        GROUP BY t.state
      ) states),'{}'::jsonb) AS states
    FROM flightdeck_pg_channels c
    CROSS JOIN LATERAL (
      SELECT count(*)::text AS messages, count(DISTINCT t.id)::text AS conversations
      FROM flightdeck_pg_messages m
      LEFT JOIN flightdeck_pg_threads t ON t.workspace_id=m.workspace_id AND t.channel_id=m.channel_id AND t.id=m.thread_id AND t.deleted_at IS NULL
      WHERE m.workspace_id=c.workspace_id AND m.channel_id=c.id AND m.deleted_at IS NULL
        AND (${window.from}::timestamptz IS NULL OR m.created_at >= ${window.from}) AND m.created_at < ${window.as_of}
    ) activity
    WHERE c.workspace_id=${input.workspaceId} AND c.id IN ${sql(ids)}
  ` : [];
  if (rows.length !== channels.length || new Set(rows.map(r => r.channel_id)).size !== channels.length) throw new WorkspaceReportError('report_unavailable');
  const activity = { messages: 0, conversations: 0 };
  const tasks = { total: 0, open: 0, completed: 0, archived: 0,
    by_state: Object.fromEntries(workspaceReportTaskStates.map(state => [state, 0])) as Record<typeof workspaceReportTaskStates[number], number> };
  const inventory = { channels: channels.length, conversations: 0, tasks, documents: 0, files: 0 };
  const labels = new Map(channels.map(c => [c.id, c]));
  const rankingRows = rows.map(row => {
    const label = labels.get(row.channel_id);
    if (!label) throw new WorkspaceReportError('report_unavailable');
    const messages = reportCount(row.messages), conversations = reportCount(row.conversations);
    if (conversations > messages) throw new WorkspaceReportError('report_unavailable');
    activity.messages = add(activity.messages, messages); activity.conversations = add(activity.conversations, conversations);
    inventory.conversations = add(inventory.conversations, reportCount(row.threads));
    inventory.documents = add(inventory.documents, reportCount(row.documents)); inventory.files = add(inventory.files, reportCount(row.files));
    for (const [state, value] of Object.entries(row.states)) {
      if (!workspaceReportTaskStates.includes(state as any)) throw new WorkspaceReportError('report_unavailable');
      const key = state as typeof workspaceReportTaskStates[number], count = reportCount(value);
      tasks.by_state[key] = add(tasks.by_state[key], count); tasks.total = add(tasks.total, count);
      const bucket = key === 'done' ? 'completed' : key === 'archive' || key === 'archived' ? 'archived' : 'open';
      tasks[bucket] = add(tasks[bucket], count);
    }
    return { channel_id: row.channel_id, scope_id: label.scope_id, name: label.name, scope_name: label.scope_name, messages, conversations };
  }).sort((a,b) => b.messages - a.messages || (a.channel_id < b.channel_id ? -1 : a.channel_id > b.channel_id ? 1 : 0));
  const shown = rankingRows.slice(0,input.topN), other = rankingRows.slice(input.topN);
  const asOf = window.as_of.toISOString();
  const result: Omit<FlightDeckPgWorkspaceReportResponse, 'identity'> = {
    format: 'workspace-report-v1', workspace_id: input.workspaceId, range: input.range,
    from: window.from?.toISOString() ?? null, to: asOf, as_of: asOf, timezone: 'UTC', complete: true,
    channel_policy: 'active-project-channels', activity, inventory, channels: shown,
    ranking: { total_channels: channels.length, returned_channels: shown.length, has_more: other.length > 0,
      other_messages: other.reduce((n,r) => add(n,r.messages),0), other_conversations: other.reduce((n,r) => add(n,r.conversations),0) },
    coverage: { tasks_channels: taskIds.length, documents_channels: channels.length, files_channels: channels.length },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new WorkspaceReportError('report_too_large');
  return result;
}
