import { getDb } from '../db';
import { reportCount, WorkspaceReportError } from './flightdeck-pg-workspace-report';
import type { FlightDeckPgWorkspaceStorage } from '../types';

type Db = ReturnType<typeof getDb>;
const rowLimit = 1000000; // Total retained rows across all measured tables.
const objectLimit = 100000;
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

/** Report callers require workspace.manage; the internal scheduler uses explicit schedules.
 * Both callers supply a read-only repeatable-read transaction. */
export async function readWorkspaceStorage(workspaceId: string, asOf: string, sql: Db, policy: 'report' | 'metering' = 'report'): Promise<FlightDeckPgWorkspaceStorage> {
  // Discover only public base tables with an explicit UUID workspace boundary.
  // No table names, contents, or instance-wide physical sizes leave this service.
  const tables = await sql<{ name: string; refs: string[]; columns: string[] }[]>`
    SELECT c.relname AS name,
      ARRAY(SELECT a.attname::text FROM pg_attribute a
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
      ARRAY(SELECT a.attname::text FROM pg_attribute a
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname IN ('storage_object_id','head_storage_object_id')
        AND a.atttypid='uuid'::regtype) AS refs
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relispartition
      AND (${policy} <> 'metering' OR (c.relname !~ '^hosting_' AND c.relname !~ '^workspace_credit_' AND c.relname <> 'workspace_usage_hourly_audits'))
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id'
        AND a.atttypid='uuid'::regtype AND NOT a.attisdropped)
    ORDER BY c.relname LIMIT 257
  `;
  if (!tables.length) throw new WorkspaceReportError('report_unavailable');
  if (tables.length > 256) throw new WorkspaceReportError('report_too_large');
  if (tables.some(t => !t.columns.length || t.columns.length > 256)) throw new WorkspaceReportError('report_too_large');
  // Count narrow rows first. Reject the TOTAL budget before touching payloads.
  // The caller's repeatable-read snapshot prevents count/measurement drift.
  const counts = await sql.unsafe<{ rows: string }[]>(tables.map(t =>
    `SELECT count(*)::text AS rows FROM (SELECT 1 FROM public.${quote(t.name)} WHERE workspace_id=$1::uuid LIMIT ${rowLimit + 1}) bounded`
  ).join(' UNION ALL '), [workspaceId]);
  if (counts.length !== tables.length) throw new WorkspaceReportError('report_unavailable');
  const retainedRows = counts.reduce((sum, r) => reportCount(sum + reportCount(r.rows)), 0);
  if (retainedRows > rowLimit) throw new WorkspaceReportError('report_too_large');
  // Size individual stored datums: no JSON serialization or composite detoasting.
  // pg_column_size includes compressed/external datum bytes, not container overhead.
  const parts = tables.map(t => `SELECT '${/versions|audit|outbox/.test(t.name) ? 'history' : 'current'}' AS category,
    count(*)::text AS rows, COALESCE(sum(${t.columns.map(c => `COALESCE(pg_column_size(r.${quote(c)})::bigint,0)`).join('+')}),0)::text AS row_bytes,
    ${t.columns.includes('metadata') ? 'COALESCE(sum(pg_column_size(r.metadata)::bigint),0)' : '0'}::text AS metadata_bytes
    FROM (SELECT * FROM public.${quote(t.name)} WHERE workspace_id=$1::uuid LIMIT ${rowLimit + 1}) r`);
  const rows = await sql.unsafe<{ category: string; rows: string; row_bytes: string; metadata_bytes: string }[]>(parts.join(' UNION ALL '), [workspaceId]);
  const totals = { rows: 0, column_bytes: 0, metadata_column_bytes: 0, history_rows: 0, history_column_bytes: 0 };
  for (const r of rows) {
    const count = reportCount(r.rows);
    if (count > rowLimit) throw new WorkspaceReportError('report_too_large');
    totals.rows = reportCount(totals.rows + count);
    totals.column_bytes = reportCount(totals.column_bytes + reportCount(r.row_bytes));
    totals.metadata_column_bytes = reportCount(totals.metadata_column_bytes + reportCount(r.metadata_bytes));
    if (r.category === 'history') {
      totals.history_rows = reportCount(totals.history_rows + count);
      totals.history_column_bytes = reportCount(totals.history_column_bytes + reportCount(r.row_bytes));
    }
  }
  if (rows.length !== tables.length || totals.rows !== retainedRows) throw new WorkspaceReportError('report_unavailable');
  const refs = tables.flatMap(t => t.refs.map(ref => `SELECT ${quote(ref)} AS id FROM public.${quote(t.name)} WHERE workspace_id=$1::uuid`));
  // UNION removes references repeated in heads, versions, links and publications.
  const [objects] = await sql.unsafe<{ objects: string; paths: string; bytes: string; pending: string; conflicts: string; last_completed_at: Date | null }[]>(`
    WITH refs AS MATERIALIZED (
      (SELECT id FROM v4_storage_objects WHERE pg_workspace_id=$1::uuid LIMIT ${objectLimit + 1})
      ${refs.map(r => ' UNION ' + r).join('')}
    ), objects AS MATERIALIZED (
      SELECT o.storage_path,o.size_bytes,o.completed_at FROM v4_storage_objects o JOIN refs r ON r.id=o.id LIMIT ${objectLimit + 1}
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
  if (reportCount(objects.objects) > objectLimit) throw new WorkspaceReportError('report_too_large');
  if (reportCount(objects.conflicts)) throw new WorkspaceReportError('report_unavailable');
  const metric = (id: string, value: number | null, unit: 'bytes' | 'count', method: string) => ({
    id, value, unit, method, status: value === null ? 'unavailable' as const : 'estimated' as const,
  });
  return {
    format: 'workspace-storage-v1', workspace_id: workspaceId, scope: 'current-workspace', as_of: asOf, activity_range_applies: false,
    groups: [
      { id: 'postgres', metrics: [
        metric('rows', totals.rows, 'count', 'workspace-row-count'),
        metric('column_bytes', totals.column_bytes, 'bytes', 'stored-column-size'),
        metric('metadata_column_bytes', totals.metadata_column_bytes, 'bytes', 'stored-column-size-subset'),
        metric('history_rows', totals.history_rows, 'count', 'history-table-row-count'),
        metric('history_column_bytes', totals.history_column_bytes, 'bytes', 'stored-column-size-subset'),
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
      ...(policy === 'metering' ? ['Metering policy excludes hosting, credit and usage-audit accounting tables to avoid charging for metering/financial evidence. This differs from the report inventory and is not the accepted hosting USD v1 billing basis.'] : []),
      'PostgreSQL column_bytes sums pg_column_size of individual stored fields in retained workspace rows; compressed and external datum sizes are included. Metadata and history are subsets, not additional bytes.',
      'Includes soft-deleted and archived rows and retained versions; history means tables named versions, audit or outbox. Excludes shared rows without workspace_id, legacy workspace namespaces, tuple headers/alignment, pages, indexes, TOAST container overhead, WAL, free space and backups.',
      'Object bytes are completed v4 storage metadata deduplicated by storage_path, attributed by explicit pg_workspace_id or retained workspace references (including deleted versions). Shared objects may be attributed to more than one workspace; workspace totals are not additive.',
      'Object metadata does not confirm current provider existence, lifecycle deletion, provider-only versions, multipart uploads, replication or billing. Pending uploads are excluded from bytes. Managed publisher storage and unreferenced legacy uploads without workspace attribution are excluded.',
      'Physical PostgreSQL and provider-confirmed bytes are unavailable; no instance totals, bucket listing or provider requests are performed.',
    ],
  };
}
