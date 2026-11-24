import { getDb } from '../db';
import { authorizeFlightDeckPgOperation, getEffectiveFlightDeckPgGroupIds } from './flightdeck-pg-authorization';
import { listVisibleFlightDeckPgCanvases } from './flightdeck-pg-canvases';
import type { RecordEntry } from './flightdeck-record-visibility';
import { OrgDataError, orgOperation } from './org-data';

type Db = ReturnType<typeof getDb>;
export type ExportViewer = { workspaceId: string; actorId: string; npub: string; appNpub: string };
type Ref = { f: string; i: string };
type Visible = (entry: RecordEntry) => Promise<boolean>;
type Ctx = { viewer: ExportViewer; visible: Visible; sql: Db; canvasIds: () => Promise<Set<string>>; canManage: () => Promise<boolean> };

/** Customer-content tables that are not record-sync families. Each adapter reads exactly what its existing GET route allows:
 * `channel` rows need channel.read on their channel (the same active-channel gate the record families use), `task` rows task.read,
 * the rest follow their own route's rule. Rows a viewer cannot read are never delivered, counted or hinted. Soft-deleted rows are
 * not delivered (the record projection does not deliver tombstones either). */
export type Adapter = {
  table: string;
  /** Joined FROM clause; the adapter's own table is always aliased `t`. Ignored when `fetch` is set. */
  from: string;
  key: string;
  /** For tables whose read rule lives in a service rather than SQL: returns already-authorized rows after `last`, at most `limit`. */
  fetch?: (ctx: Ctx, last: string, limit: number) => Promise<{ k: string; row: any }[]>;
  where?: string;
  /** SQL expression for the channel whose ACL governs the row (when the rule is channel based). */
  channel?: string;
  rule: 'channel' | 'task' | 'custom';
  allow?: (row: any, ctx: Ctx) => Promise<boolean>;
  omit?: (column: string) => boolean;
  refs: (row: any) => Ref[];
};

const WORKROOM = 'table:flightdeck_pg_workrooms', ACTIVITY = 'table:flightdeck_pg_agent_activities', CANVAS = 'table:flightdeck_pg_canvases';
const targetFamily: Record<string, string> = { message: 'message', task: 'task', task_comment: 'task_comment', doc: 'doc', document: 'doc', file: 'file', audio_note: 'audio_note' };
const onWorkroom = (child: string) => `${child} t JOIN flightdeck_pg_workrooms w ON w.workspace_id=t.workspace_id AND w.id=t.workroom_id`;

export const EXPORT_ADAPTERS: Adapter[] = [
  { table: 'flightdeck_pg_reactions', from: 'flightdeck_pg_reactions t', key: 't.id::text', where: 't.deleted_at IS NULL', channel: 't.channel_id', rule: 'channel',
    refs: r => (targetFamily[r.target_type] ? [{ f: targetFamily[r.target_type]!, i: String(r.target_id) }] : []) },
  { table: 'flightdeck_pg_task_watchers', from: 'flightdeck_pg_task_watchers t', key: "t.task_id::text||':'||t.actor_id::text", where: 't.deleted_at IS NULL', channel: 't.channel_id', rule: 'task',
    refs: r => [{ f: 'task', i: String(r.task_id) }] },
  { table: 'flightdeck_pg_workrooms', from: 'flightdeck_pg_workrooms t', key: 't.id::text', where: 't.deleted_at IS NULL', channel: 't.channel_id', rule: 'channel', refs: () => [] },
  { table: 'flightdeck_pg_workroom_participants', from: onWorkroom('flightdeck_pg_workroom_participants'), key: 't.id::text', where: 'w.deleted_at IS NULL', channel: 'w.channel_id', rule: 'channel', refs: r => [{ f: WORKROOM, i: String(r.workroom_id) }] },
  { table: 'flightdeck_pg_workroom_events', from: onWorkroom('flightdeck_pg_workroom_events'), key: 't.id::text', where: 'w.deleted_at IS NULL', channel: 'w.channel_id', rule: 'channel', refs: r => [{ f: WORKROOM, i: String(r.workroom_id) }] },
  { table: 'flightdeck_pg_workroom_links', from: onWorkroom('flightdeck_pg_workroom_links'), key: 't.id::text', where: 'w.deleted_at IS NULL', channel: 'w.channel_id', rule: 'channel', refs: r => [{ f: WORKROOM, i: String(r.workroom_id) }] },
  // A workroom approval is readable with the workroom's channel; any other approval target needs workspace.manage (the GET /approvals rule).
  { table: 'flightdeck_pg_approvals', from: 'flightdeck_pg_approvals t LEFT JOIN flightdeck_pg_workrooms w ON w.workspace_id=t.workspace_id AND t.target_type=\'workroom\' AND w.id::text=t.target_id::text',
    key: 't.id::text', where: '(t.target_type<>\'workroom\' OR w.deleted_at IS NULL)', channel: 'w.channel_id', rule: 'custom',
    allow: async (row, ctx) => (row.target_type === 'workroom' ? row._channel !== null && ctx.visible({ family: 'message', id: row.id, operation: 'upsert', position: '0', bytes: 0, row: { channel_id: row._channel } }) : ctx.canManage()),
    refs: r => (r.target_type === 'workroom' ? [{ f: WORKROOM, i: String(r.target_id) }] : []) },
  // Readable with the channel, or as its creator or a named recipient (the GET /invocations rule).
  { table: 'flightdeck_pg_invocations', from: 'flightdeck_pg_invocations t', key: 't.id::text', channel: 't.channel_id', rule: 'custom',
    allow: async (row, ctx) => row.created_by_actor_id === ctx.viewer.actorId || (Array.isArray(row.recipients) && row.recipients.some((r: any) => r?.npub === ctx.viewer.npub))
      || ctx.visible({ family: 'message', id: row.id, operation: 'upsert', position: '0', bytes: 0, row: { channel_id: row._channel } }),
    refs: r => (Array.isArray(r.targets) ? r.targets.map((t: any) => ({ f: targetFamily[String(t?.type)] ?? '', i: String(t?.id ?? '') })).filter((x: Ref) => x.f && x.i) : []) },
  { table: 'flightdeck_pg_agent_activities', from: 'flightdeck_pg_agent_activities t', key: 't.id::text', channel: 't.channel_id', rule: 'channel', omit: c => c.startsWith('lease_'),
    refs: r => [{ f: 'thread', i: String(r.thread_id) }, { f: 'message', i: String(r.trigger_message_id) }] },
  { table: 'flightdeck_pg_agent_activity_commentary', from: 'flightdeck_pg_agent_activity_commentary t JOIN flightdeck_pg_agent_activities a ON a.workspace_id=t.workspace_id AND a.id=t.agent_activity_id',
    key: 't.id::text', channel: 'a.channel_id', rule: 'channel', refs: r => [{ f: ACTIVITY, i: String(r.agent_activity_id) }] },
  // Canvases use their own visibility rule (workspace mode, listed principals, creator, or workspace.manage), shared with GET /canvases.
  { table: 'flightdeck_pg_canvases', from: 'flightdeck_pg_canvases t', key: 't.id::text', where: 't.deleted_at IS NULL', rule: 'custom',
    allow: async (row, ctx) => (await ctx.canvasIds()).has(row.id), refs: () => [] },
  { table: 'flightdeck_pg_canvas_elements', from: 'flightdeck_pg_canvas_elements t JOIN flightdeck_pg_canvases c ON c.workspace_id=t.workspace_id AND c.id=t.canvas_id', key: 't.id::text', where: 't.deleted_at IS NULL AND c.deleted_at IS NULL', rule: 'custom',
    allow: async (row, ctx) => (await ctx.canvasIds()).has(row.canvas_id), refs: r => [{ f: CANVAS, i: String(r.canvas_id) }] },
  { table: 'flightdeck_pg_canvas_naplets', from: 'flightdeck_pg_canvas_naplets t JOIN flightdeck_pg_canvases c ON c.workspace_id=t.workspace_id AND c.id=t.canvas_id', key: 't.id::text', where: 't.deleted_at IS NULL AND c.deleted_at IS NULL', rule: 'custom',
    allow: async (row, ctx) => (await ctx.canvasIds()).has(row.canvas_id), refs: r => [{ f: CANVAS, i: String(r.canvas_id) }] },
  // The member's own ordering of canvases they can see.
  { table: 'flightdeck_pg_canvas_orders', from: 'flightdeck_pg_canvas_orders t', key: "t.viewer_actor_id::text||':'||t.canvas_id::text", rule: 'custom',
    allow: async (row, ctx) => row.viewer_actor_id === ctx.viewer.actorId && (await ctx.canvasIds()).has(row.canvas_id), refs: r => [{ f: CANVAS, i: String(r.canvas_id) }] },
];
const ZERO = '00000000-0000-0000-0000-000000000000';
/** Org data is read through its own service, so type access (members/admins), permission grants and reference redaction are exactly
 * those of the org-data routes. A member without org_data.read receives nothing. */
async function orgCtx(ctx: Ctx) {
  const [m] = await ctx.sql`SELECT role FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${ctx.viewer.workspaceId} AND actor_id=${ctx.viewer.actorId}`;
  return { workspaceId: ctx.viewer.workspaceId, actorId: ctx.viewer.actorId, actorNpub: ctx.viewer.npub, appNpub: ctx.viewer.appNpub, role: String(m?.role ?? '') };
}
async function orgReadable<T>(ctx: Ctx, run: () => Promise<T>, empty: T): Promise<T> {
  try { return await run(); } catch (e) { if (e instanceof OrgDataError && [403, 404].includes(e.status)) return empty; throw e; }
}
EXPORT_ADAPTERS.push(
  { table: 'flightdeck_pg_org_data_types', from: '', key: '', rule: 'custom', refs: () => [],
    fetch: async (ctx, last, limit) => {
      const catalogue: any = await orgReadable(ctx, async () => orgOperation(await orgCtx(ctx), 'catalogue'), { types: [] });
      return (catalogue.types as any[]).map(t => ({ k: String(t.key), row: { key: t.key, label: t.label, fields: t.fields, access: t.access, revision: t.revision } }))
        .filter(r => r.k > last).sort((a, b) => (a.k < b.k ? -1 : 1)).slice(0, limit);
    } },
  { table: 'flightdeck_pg_org_data_records', from: '', key: '', rule: 'custom', refs: r => [{ f: 'table:flightdeck_pg_org_data_types', i: String(r.type_key) }],
    fetch: async (ctx, last, limit) => {
      const base = await orgCtx(ctx);
      const catalogue: any = await orgReadable(ctx, () => orgOperation(base, 'catalogue'), { types: [] });
      const [lastType, lastId] = last ? last.split('\u0001') as [string, string] : ['', ZERO];
      const out: { k: string; row: any }[] = [];
      for (const type of (catalogue.types as any[]).map(t => String(t.key)).sort().filter(k => k >= lastType)) {
        let cursor = type === lastType ? lastId! : ZERO;
        while (out.length < limit) {
          const page: any = await orgReadable(ctx, () => orgOperation(base, 'list', type, undefined, { cursor, limit: Math.min(500, limit - out.length) }), { records: [], has_more: false });
          for (const r of page.records as any[]) out.push({ k: `${type}\u0001${r.id}`, row: { ...r, type_key: type } });
          if (!page.has_more) break;
          cursor = page.next_cursor;
        }
        if (out.length >= limit) break;
      }
      return out;
    } },
);
export const EXPORT_ADAPTER_TABLES: string[] = EXPORT_ADAPTERS.map(a => a.table);
export const keyFamily = (table: string) => `table:${table}`;

export function adapterContext(viewer: ExportViewer, visible: Visible, sql: Db): Ctx {
  let canvases: Promise<Set<string>> | null = null, manage: Promise<boolean> | null = null;
  const canManage = () => manage ??= authorizeFlightDeckPgOperation({ actorNpub: viewer.npub, appNpub: viewer.appNpub, workspaceId: viewer.workspaceId, permission: 'workspace.manage', resource: { type: 'workspace' } }, sql).then(d => d.allowed);
  return {
    viewer, visible, sql, canManage,
    canvasIds: () => canvases ??= (async () => {
      const [membership] = await sql`SELECT role FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${viewer.workspaceId} AND actor_id=${viewer.actorId}`;
      if (!membership) return new Set<string>();
      const groupIds = await getEffectiveFlightDeckPgGroupIds(viewer.workspaceId, viewer.actorId, sql);
      const list = await listVisibleFlightDeckPgCanvases({ workspaceId: viewer.workspaceId, actorId: viewer.actorId, groupIds, workspaceRole: membership.role, canManageWorkspace: await canManage() }, sql);
      return new Set(list.map(c => c.id));
    })(),
  };
}

/** Channel/task rule via the shared record visibility (active channel and scope, then the channel or task grant). */
export async function adapterAllows(a: Adapter, row: any, ctx: Ctx): Promise<boolean> {
  if (a.rule === 'custom') return a.allow!(row, ctx);
  if (!row._channel) return false;
  return a.rule === 'task'
    ? ctx.visible({ family: 'task_assignment', id: String(row.task_id), operation: 'upsert', position: '0', bytes: 0, row: { task_id: row.task_id, channel_id: row._channel } })
    : ctx.visible({ family: 'message', id: String(row.id ?? row.canvas_id ?? ''), operation: 'upsert', position: '0', bytes: 0, row: { channel_id: row._channel } });
}
