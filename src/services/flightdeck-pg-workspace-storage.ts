import { getDb } from '../db';
import { reportCount, WorkspaceReportError } from './flightdeck-pg-workspace-report';
import type { FlightDeckPgWorkspaceStorage } from '../types';

type Db = ReturnType<typeof getDb>;
const rowLimit = 100000;
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

/** Call only after workspace.manage authorization, inside the report's read-only snapshot. */
export async function readWorkspaceStorage(workspaceId: string, asOf: string, sql: Db): Promise<FlightDeckPgWorkspaceStorage> {
  // Discover only public base tables with an explicit UUID workspace boundary.
  // No table names, contents, or instance-wide physical sizes leave this service.
  const tables = await sql<{ name: string; refs: string[] }[]>`
    SELECT c.relname AS name, ARRAY(SELECT a.attname::text FROM pg_attribute a
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname IN ('storage_object_id','head_storage_object_id')
        AND a.atttypid='uuid'::regtype) AS refs
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relispartition
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id'
        AND a.atttypid='uuid'::regtype AND NOT a.attisdropped)
    ORDER BY c.relname LIMIT 257
  `;
  if (!tables.length) throw new WorkspaceReportError('report_unavailable');
  if (tables.length > 256) throw new WorkspaceReportError('report_too_large');
  // One aggregate statement, independent of the number of channels/entities.
  // JSON serialization measures logical UTF-8 data, not heap/TOAST/index bytes.
  const parts = tables.map(t => `SELECT '${/versions|audit|outbox/.test(t.name) ? 'history' : 'current'}' AS category,
    count(*)::text AS rows, COALESCE(sum(octet_length(j::text)),0)::text AS row_bytes,
    COALESCE(sum(octet_length((j->'metadata')::text)),0)::text AS metadata_bytes
    FROM (SELECT to_jsonb(r) AS j FROM (SELECT * FROM public.${quote(t.name)} WHERE workspace_id=$1::uuid LIMIT ${rowLimit + 1}) r) bounded`);
  const rows = await sql.unsafe<{ category: string; rows: string; row_bytes: string; metadata_bytes: string }[]>(parts.join(' UNION ALL '), [workspaceId]);
  const totals = { rows: 0, row_json_bytes: 0, metadata_json_bytes: 0, history_rows: 0, history_row_json_bytes: 0 };
  for (const r of rows) {
    const count = reportCount(r.rows);
    if (count > rowLimit) throw new WorkspaceReportError('report_too_large');
    totals.rows = reportCount(totals.rows + count);
    totals.row_json_bytes = reportCount(totals.row_json_bytes + reportCount(r.row_bytes));
    totals.metadata_json_bytes = reportCount(totals.metadata_json_bytes + reportCount(r.metadata_bytes));
    if (r.category === 'history') {
      totals.history_rows = reportCount(totals.history_rows + count);
      totals.history_row_json_bytes = reportCount(totals.history_row_json_bytes + reportCount(r.row_bytes));
    }
  }
  const refs = tables.flatMap(t => t.refs.map(ref => `SELECT ${quote(ref)} AS id FROM public.${quote(t.name)} WHERE workspace_id=$1::uuid`));
  // UNION removes references repeated in heads, versions, links and publications.
  const [objects] = await sql.unsafe<{ objects: string; paths: string; bytes: string; pending: string; conflicts: string; last_completed_at: Date | null }[]>(`
    WITH refs AS MATERIALIZED (
      (SELECT id FROM v4_storage_objects WHERE pg_workspace_id=$1::uuid LIMIT ${rowLimit + 1})
      ${refs.map(r => ' UNION ' + r).join('')}
    ), objects AS MATERIALIZED (
      SELECT o.storage_path,o.size_bytes,o.completed_at FROM v4_storage_objects o JOIN refs r ON r.id=o.id LIMIT ${rowLimit + 1}
    ), paths AS (
      SELECT storage_path, min(size_bytes) AS bytes, count(DISTINCT size_bytes) AS sizes
      FROM objects WHERE completed_at IS NOT NULL GROUP BY storage_path
    )
    SELECT (SELECT count(*) FROM objects)::text AS objects,
      (SELECT count(*) FROM paths)::text AS paths,
      COALESCE((SELECT sum(bytes) FROM paths),0)::text AS bytes,
      (SELECT count(*) FROM objects WHERE completed_at IS NULL)::text AS pending,
      (SELECT count(*) FROM paths WHERE sizes<>1 OR bytes<0 OR storage_path='')::text AS conflicts,
      (SELECT max(completed_at) FROM objects) AS last_completed_at`, [workspaceId]);
  if (reportCount(objects.objects) > rowLimit) throw new WorkspaceReportError('report_too_large');
  if (reportCount(objects.conflicts)) throw new WorkspaceReportError('report_unavailable');
  const metric = (id: string, value: number | null, unit: 'bytes' | 'count', method: string) => ({
    id, value, unit, method, status: value === null ? 'unavailable' as const : 'estimated' as const,
  });
  return {
    format: 'workspace-storage-v1', workspace_id: workspaceId, scope: 'current-workspace', as_of: asOf, activity_range_applies: false,
    groups: [
      { id: 'postgres', metrics: [
        metric('rows', totals.rows, 'count', 'workspace-row-count'),
        metric('row_json_bytes', totals.row_json_bytes, 'bytes', 'logical-json-utf8'),
        metric('metadata_json_bytes', totals.metadata_json_bytes, 'bytes', 'logical-json-utf8-subset'),
        metric('history_rows', totals.history_rows, 'count', 'history-table-row-count'),
        metric('history_row_json_bytes', totals.history_row_json_bytes, 'bytes', 'logical-json-utf8-subset'),
        metric('tables_measured', tables.length, 'count', 'workspace-table-count'),
        metric('physical_bytes', null, 'bytes', 'not-measured'),
      ] },
      { id: 'object_storage', metrics: [
        metric('objects', reportCount(objects.paths), 'count', 'completed-metadata-distinct-paths'),
        metric('bytes', reportCount(objects.bytes), 'bytes', 'completed-metadata-distinct-paths'),
        metric('pending_objects', reportCount(objects.pending), 'count', 'incomplete-metadata-count'),
        metric('provider_actual_bytes', null, 'bytes', 'not-measured'),
      ] },
    ],
    provider_measured_at: null,
    last_object_completed_at: objects.last_completed_at?.toISOString() ?? null,
    caveats: [
      'PostgreSQL totals serialize retained rows in public base tables with an explicit UUID workspace_id; metadata and history are subsets of row_json_bytes.',
      'Includes soft-deleted and archived rows and retained versions; history means tables named versions, audit or outbox. Excludes shared rows without workspace_id, legacy workspace namespaces, indexes, TOAST overhead, WAL, free space and backups.',
      'Object bytes are completed v4 storage metadata deduplicated by storage_path, attributed by explicit pg_workspace_id or retained workspace references (including deleted versions). Shared objects may be attributed to more than one workspace; workspace totals are not additive.',
      'Object metadata does not confirm current provider existence, lifecycle deletion, provider-only versions, multipart uploads, replication or billing. Pending uploads are excluded from bytes. Managed publisher storage and unreferenced legacy uploads without workspace attribution are excluded.',
      'Physical PostgreSQL and provider-confirmed bytes are unavailable; no instance totals, bucket listing or provider requests are performed.',
    ],
  };
}
