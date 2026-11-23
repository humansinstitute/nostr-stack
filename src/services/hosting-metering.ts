import { getDb } from '../db';
import type { FlightDeckPgWorkspaceStorage, HostingStoredMetering } from '../types';
import { readWorkspaceStorage } from './flightdeck-pg-workspace-storage';

type Db = ReturnType<typeof getDb>;
const HOUR = 3_600_000;
export const STORAGE_MEASUREMENT_VERSION = 'stored-columns-accounting-excluded-v1';
const hourOf = (date: Date) => Math.floor(date.getTime() / HOUR) * HOUR;

export function meteredCoveredBytes(evidence: FlightDeckPgWorkspaceStorage, workspaceId: string, period: Date): string {
  const captured = Date.parse(evidence.as_of);
  if (evidence.workspace_id !== workspaceId || !Number.isFinite(captured) || hourOf(new Date(captured)) !== period.getTime()) throw new Error('invalid_measurement');
  let sum = 0n;
  for (const [groupId, metricId] of [['postgres', 'column_bytes'], ['object_storage', 'bytes']]) {
    const metric = evidence.groups.find(g => g.id === groupId)?.metrics.find(m => m.id === metricId);
    if (!metric || metric.unit !== 'bytes' || metric.status === 'unavailable' || metric.value === null || !Number.isSafeInteger(metric.value) || metric.value < 0) throw new Error('incomplete_measurement');
    sum += BigInt(metric.value);
  }
  return sum.toString();
}

export async function collectMeteredStorage(workspaceId: string, db: Db): Promise<FlightDeckPgWorkspaceStorage> {
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    await sql`SELECT set_config('statement_timeout', '10000', true)`;
    const [clock] = await sql`SELECT transaction_timestamp() AS captured_at`;
    return readWorkspaceStorage(workspaceId, clock!.captured_at.toISOString(), sql, 'metering');
  });
}

/** Called only by a separately reviewed activation. Does not start automatically.
 * Session lock spans collection and insertion; terminal durable slots are never recollected.
 * Explicit schedule rows are independent of paid-account enrollment.
 */
export async function runStorageMeteringTick(db: Db = getDb(), now = new Date(), collect = collectMeteredStorage) {
  const connection = await db.reserve();
  let locked = false;
  try {
    const [lock] = await connection`SELECT pg_try_advisory_lock(1440000721) AS acquired`;
    if (!lock?.acquired) return;
    locked = true;
    const schedules = await connection`
      SELECT s.workspace_id,s.enabled_at,a.id AS owner_actor_id,linked.id AS account_id,max(h.period_start) AS last_period
      FROM hosting_metering_workspaces s
      JOIN flightdeck_pg_workspaces w ON w.id=s.workspace_id
      JOIN flightdeck_pg_actors a ON a.npub=w.workspace_owner_npub
      LEFT JOIN hosting_workspace_accounts l ON l.workspace_id=s.workspace_id
      LEFT JOIN hosting_accounts linked ON linked.id=l.account_id AND linked.owner_actor_id=a.id
      LEFT JOIN hosting_storage_snapshots h ON h.workspace_id=s.workspace_id
      GROUP BY s.workspace_id,a.id,linked.id
      HAVING s.enabled_at <= ${now} AND (max(h.period_start) IS NULL OR max(h.period_start) < ${new Date(hourOf(now))})
      ORDER BY COALESCE(max(h.period_start),s.enabled_at),s.workspace_id LIMIT 64`;
    for (const s of schedules) {
      const start = s.last_period ? new Date(s.last_period).getTime() + HOUR : hourOf(new Date(s.enabled_at));
      for (let period = start, n = 0; period <= hourOf(now) && n < 24; period += HOUR, n++) {
        let status = period < new Date(s.enabled_at).getTime() ? 'partial_hour' : period < hourOf(now) ? 'missed' : 'measured';
        let evidence: FlightDeckPgWorkspaceStorage | null = null, bytes: string | null = null;
        let reason: string | null = status === 'measured' ? null : status === 'missed' ? 'No contemporaneous sample retained' : 'Initial partial UTC hour is unbilled';
        if (status === 'measured') {
          try {
            evidence = await collect(s.workspace_id, db);
            bytes = meteredCoveredBytes(evidence, s.workspace_id, new Date(period));
          } catch {
            status = 'unavailable'; evidence = null; bytes = null;
            reason = 'Required measurement failed, exceeded bounds or crossed its UTC hour';
          }
        }
        await connection`INSERT INTO hosting_storage_snapshots(workspace_id,owner_actor_id,account_id,period_start,period_end,captured_at,measurement_version,status,covered_bytes,evidence,reason)
          VALUES(${s.workspace_id},${s.owner_actor_id},${s.account_id},${new Date(period)},${new Date(period + HOUR)},${evidence ? new Date(evidence.as_of) : null},${STORAGE_MEASUREMENT_VERSION},${status},${bytes},${evidence ? connection.json(JSON.parse(JSON.stringify(evidence))) : null},${reason})
          ON CONFLICT(workspace_id,period_start) DO NOTHING`;
      }
    }
  } finally {
    try { if (locked) await connection`SELECT pg_advisory_unlock(1440000721)`; }
    finally { connection.release(); }
  }
}

/** SELECTs only: no collector, account creation, expiry processing or charge. */
export async function readStoredMetering(workspaceId: string, limit = 50, db: Db = getDb(), now = new Date()): Promise<HostingStoredMetering> {
  const bound = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
  const rows = await db`SELECT id,workspace_id,scope,coverage,period_start,period_end,captured_at,recorded_at,measurement_version,status,covered_bytes,evidence,reason FROM hosting_storage_snapshots WHERE workspace_id=${workspaceId} ORDER BY period_start DESC LIMIT ${bound}`;
  const [schedule] = await db`SELECT enabled_at FROM hosting_metering_workspaces WHERE workspace_id=${workspaceId}`;
  const snapshots = rows.map(r => ({ ...r, period_start: r.period_start.toISOString(), period_end: r.period_end.toISOString(), captured_at: r.captured_at?.toISOString() ?? null, recorded_at: r.recorded_at.toISOString() })) as HostingStoredMetering['snapshots'];
  const latest = snapshots[0];
  const next = schedule ? Math.max(hourOf(now), latest ? Date.parse(latest.period_end) : hourOf(new Date(schedule.enabled_at))) : null;
  return {
    version: 1, workspace_id: workspaceId, as_of: now.toISOString(), cadence_seconds: 3600,
    next_measurement_at: next === null ? null : new Date(next).toISOString(),
    freshness: !latest || latest.status !== 'measured' ? 'unavailable' : Date.parse(latest.period_start) === hourOf(now) ? 'current' : 'stale',
    snapshots: snapshots as HostingStoredMetering['snapshots'],
    settlement: { status: 'separate_costs_api', reason: 'Read ledger-backed settlement via the workspace costs API; no cost is inferred directly from bytes.' },
  };
}
