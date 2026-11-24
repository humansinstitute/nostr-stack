import { getDb } from '../db';
import { HostingError, lockedAccount, USD_UNITS, unitsUsd } from './hosting-billing';
import { fundingReserveSource, registerFundingReserve } from './hosting-funding';
import { BILLABLE_STORAGE_TABLES, REQUIRED_STORAGE_CATEGORIES, STORAGE_BASIS_VERSION, UNMETERED_STORAGE_CATEGORIES } from './hosting-storage-classification';
import { billableColumns, bytesOf, missingStorageTracking, quote } from '../schema/hosting-storage-peak-v1';

type Db = ReturnType<typeof getDb>;
const HOUR = 3_600_000;
const hourMs = (date: Date) => Math.floor(date.getTime() / HOUR) * HOUR;
const ceilHourMs = (date: Date) => Math.ceil(date.getTime() / HOUR) * HOUR;
/** Decimal gigabyte. $5/GB-month over 720 hours is exactly one tariff unit per byte-hour (144e9 units per USD). */
export const GB = 1_000_000_000n;
export const MONTH_HOURS = 720;
export const INTRO_HOURS = 720;
const ROW_LIMIT = 1_000_000;
const OBJECT_LIMIT = 100_000;
const SETTLE_BATCH = 744;
const LOCK_KEY = 1440000723;
/** While an hour is blocked by an in-flight transaction the runner takes a fresh anchor at most this often. */
const RETRY_ANCHOR_MS = 30_000;

/** Exact billing of one hour: ordinary hours pay for max(1GB, peak); introductory hours waive the 1GB base only. */
export function hourlyCharge(peakBytes: bigint, intro: boolean) {
  if (peakBytes < 0n) throw new HostingError(500, 'invalid_peak');
  const billable = intro ? (peakBytes > GB ? peakBytes - GB : 0n) : (peakBytes > GB ? peakBytes : GB);
  return { billable_bytes: billable, due_units: billable };
}

/** Introductory status of an hour: hour-start before the intro end. The leading partial hour is unbilled, so any
 * provisioning instant yields exactly 720 introductory hours. */
export const isIntroHour = (hour: Date, introEndsAt: Date) => hour.getTime() < introEndsAt.getTime();

// ---- Coverage policy -----------------------------------------------------------------------------------------------

/** A category counts as metered only through a real provider. Registering a name alone proves nothing, so the hook demands a byte
 * provider (added to every anchor) and a declaration that the provider's own write path journals changes via
 * `hosting_storage_record(workspace,'external',delta)`. Absent a provider the category stays missing and everything fails closed. */
export type ExternalStorageProvider = { id: 'git'; journal: 'write_path'; bytes: (workspaceId: string, db: Db) => Promise<bigint> };
const providers = new Map<string, ExternalStorageProvider>();
export const missingStorageCategories = () => REQUIRED_STORAGE_CATEGORIES.filter(id => id !== 'postgres' && id !== 'objects' && !providers.has(id));
export function registerMeteredStorageCategory(provider: ExternalStorageProvider) {
  if (!provider || provider.id !== 'git' || provider.journal !== 'write_path' || typeof provider.bytes !== 'function' || providers.has(provider.id)) throw new HostingError(500, 'storage_category_invalid');
  providers.set(provider.id, provider);
  return () => { if (providers.get(provider.id) === provider) providers.delete(provider.id); };
}

// ---- Measurement ---------------------------------------------------------------------------------------------------

export type StorageMeasurement = { postgres_bytes: bigint; object_bytes: bigint; external_bytes: bigint; reference_only_bytes: bigint; snapshot: string; taken_at: Date; evidence: Record<string, unknown> };

/** Absolute billable bytes inside one REPEATABLE READ snapshot. Fails (never zero) when a bound is exceeded. */
export async function measureStorage(workspaceId: string, db: Db): Promise<StorageMeasurement> {
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    await sql`SELECT set_config('statement_timeout','20000',true)`;
    const [clock] = await sql`SELECT pg_current_snapshot()::text AS snapshot, clock_timestamp() AS taken_at`;
    const tables = await billableColumns(sql as any);
    if (!tables.size) throw new HostingError(503, 'storage_measurement_unavailable');
    const counts = await sql.unsafe(`SELECT count(*)::text AS rows FROM (${[...tables.keys()].map(t => `SELECT 1 FROM public.${quote(t)} WHERE workspace_id=$1::uuid`).join(' UNION ALL ')} LIMIT ${ROW_LIMIT + 1}) bounded`, [workspaceId]);
    if (Number(counts[0]!.rows) > ROW_LIMIT) throw new HostingError(503, 'storage_measurement_too_large');
    const sums = await sql.unsafe([...tables].map(([t, shape]) => `SELECT '${t}' AS table_name,COALESCE(sum(${bytesOf('r', shape.columns)}),0)::text AS bytes FROM public.${quote(t)} r WHERE r.workspace_id=$1::uuid`).join(' UNION ALL '), [workspaceId]);
    const postgres_bytes = sums.reduce((s: bigint, r: any) => s + BigInt(r.bytes), 0n);
    // Objects: completed v4 metadata, one count per storage path. Objects owned by pg_workspace_id are tracked by the write-path journal;
    // objects counted only because a billable row references them are not, so they are measured separately and flagged.
    const [bound] = await sql`SELECT count(*)::text AS n FROM (SELECT 1 FROM v4_storage_objects WHERE pg_workspace_id=${workspaceId} LIMIT ${OBJECT_LIMIT + 1}) bounded`;
    if (Number(bound!.n) > OBJECT_LIMIT) throw new HostingError(503, 'storage_measurement_too_large');
    const refs = await sql.unsafe(`SELECT c.relname AS table_name,a.attname AS column_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]) AND a.attname IN ('storage_object_id','head_storage_object_id') AND a.atttypid='uuid'::regtype AND NOT a.attisdropped`, [BILLABLE_STORAGE_TABLES as unknown as string[]]);
    const refSelects = refs.map((r: any) => ` UNION SELECT ${quote(r.column_name)} AS id FROM public.${quote(r.table_name)} WHERE workspace_id=$1::uuid`).join('');
    const [objects] = await sql.unsafe(`WITH attributed AS MATERIALIZED (
        SELECT storage_path,min(size_bytes) AS bytes,count(DISTINCT size_bytes) AS sizes FROM v4_storage_objects
        WHERE pg_workspace_id=$1::uuid AND completed_at IS NOT NULL GROUP BY storage_path
      ), refs AS MATERIALIZED (SELECT NULL::uuid AS id WHERE false${refSelects}),
      referenced AS (
        SELECT o.storage_path,min(o.size_bytes) AS bytes,count(DISTINCT o.size_bytes) AS sizes FROM v4_storage_objects o JOIN refs r ON r.id=o.id
        WHERE o.completed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM attributed a WHERE a.storage_path=o.storage_path) GROUP BY o.storage_path
      )
      SELECT ((SELECT count(*) FROM attributed)+(SELECT count(*) FROM referenced))::text AS paths,
        COALESCE((SELECT sum(bytes) FROM attributed),0)::text AS attributed_bytes,
        COALESCE((SELECT sum(bytes) FROM referenced),0)::text AS reference_only_bytes,
        ((SELECT count(*) FROM attributed WHERE sizes<>1 OR bytes<0)+(SELECT count(*) FROM referenced WHERE sizes<>1 OR bytes<0))::text AS conflicts`, [workspaceId]);
    if (Number(objects!.paths) > OBJECT_LIMIT) throw new HostingError(503, 'storage_measurement_too_large');
    let managed = 0n;
    if (tables.has('managed_app_storage_objects')) {
      const [m] = await sql`SELECT COALESCE(sum(size_bytes),0)::text AS bytes FROM managed_app_storage_objects WHERE workspace_id=${workspaceId} AND state='complete' AND NOT physical_absent`;
      managed = BigInt(m!.bytes);
    }
    let external = 0n;
    for (const provider of providers.values()) external += await provider.bytes(workspaceId, sql);
    const attributed = BigInt(objects!.attributed_bytes), referenceOnly = BigInt(objects!.reference_only_bytes);
    return {
      postgres_bytes, object_bytes: attributed + referenceOnly + managed, external_bytes: external, reference_only_bytes: referenceOnly,
      snapshot: clock!.snapshot as string, taken_at: clock!.taken_at as Date,
      evidence: {
        basis: STORAGE_BASIS_VERSION, tables_measured: tables.size, object_paths: Number(objects!.paths), object_size_conflicts: Number(objects!.conflicts),
        attributed_object_bytes: attributed.toString(), reference_only_object_bytes: referenceOnly.toString(), managed_object_bytes: managed.toString(),
        categories: { postgres: 'measured', objects: referenceOnly > 0n ? 'measured_reference_only_untracked' : 'measured', ...Object.fromEntries(UNMETERED_STORAGE_CATEGORIES.map(c => [c.id, 'unmetered'])) },
      },
    };
  });
}

/** Records an absolute level with its MVCC snapshot. Idempotent per (workspace, instant). */
export async function takeStorageAnchor(workspaceId: string, db: Db = getDb(), measure: typeof measureStorage = measureStorage) {
  const m = await measure(workspaceId, db);
  const total = m.postgres_bytes + m.object_bytes + m.external_bytes;
  const [row] = await db`INSERT INTO hosting_storage_anchors(workspace_id,taken_at,snapshot,watermark_xid,postgres_bytes,object_bytes,external_bytes,total_bytes,reference_only_bytes,evidence)
    VALUES(${workspaceId},${m.taken_at},${m.snapshot}::pg_snapshot,pg_current_xact_id(),${m.postgres_bytes.toString()},${m.object_bytes.toString()},${m.external_bytes.toString()},${total.toString()},${m.reference_only_bytes.toString()},${db.json(JSON.parse(JSON.stringify(m.evidence)))})
    ON CONFLICT(workspace_id,taken_at) DO NOTHING RETURNING *`;
  return row ?? null;
}

// ---- Enrollment ----------------------------------------------------------------------------------------------------

/** Created by onboarding's billing step. Pre-activation enrollment journals bytes but never charges nor consumes the introduction. */
export async function enrollPeakStorage(sql: Db, workspaceId: string, accountId: string, intentId: string | null) {
  const missing = await missingStorageTracking(sql as any);
  if (missing.length) throw new HostingError(503, 'storage_tracking_unavailable');
  await sql`INSERT INTO hosting_storage_enrollments(workspace_id,account_id,origin_intent_id) VALUES(${workspaceId},${accountId},${intentId}) ON CONFLICT(workspace_id) DO NOTHING`;
  const [row] = await sql`SELECT * FROM hosting_storage_enrollments WHERE workspace_id=${workspaceId}`;
  if (row!.account_id !== accountId) throw new HostingError(409, 'billing_owner_conflict');
  return row!;
}

/** Called in the same transaction that marks the intent provisioned: the introduction starts at that instant, exactly once. */
export async function activatePeakStorage(sql: Db, workspaceId: string) {
  const [row] = await sql`UPDATE hosting_storage_enrollments SET activated_at=now(),intro_ends_at=now()+make_interval(hours=>${INTRO_HOURS}) WHERE workspace_id=${workspaceId} AND activated_at IS NULL RETURNING *`;
  if (row) return row;
  const [existing] = await sql`SELECT * FROM hosting_storage_enrollments WHERE workspace_id=${workspaceId}`;
  if (!existing) throw new HostingError(409, 'storage_enrollment_required');
  return existing;
}

// ---- Boundaries, peaks and settlement ------------------------------------------------------------------------------

export type Boundary =
  | { state: 'ok'; total: bigint; anchorId: string }
  | { state: 'inconsistent'; reconstructed: bigint; anchorId: string }
  | { state: 'pending'; reason: 'no_anchor' | 'in_flight_transactions' };

/** Total at a UTC hour boundary B.
 *
 * Completeness watermark: let A1 be the first anchor taken at/after B and W its `watermark_xid` (the next xid when it was recorded; a snapshot's
 * own xmax is NOT such a bound because running transactions above the latest completed xid are unlisted). Every transaction that wrote a
 * journal row stamped before B was assigned its xid before A1's snapshot, so xid < W. The boundary is only fixed by an anchor whose snapshot xmin >= W,
 * i.e. when all of those transactions have finished; until then it stays pending (fail closed), however long that takes.
 * total = anchor total - committed deltas stamped after B that the anchor saw. A negative result is journal/measurement disagreement:
 * it is recorded as `inconsistent`, never clamped to zero. */
export async function ensureBoundary(sql: Db, workspaceId: string, boundary: Date): Promise<Boundary> {
  const [prior] = await sql`SELECT status,total_bytes::text AS total,reconstructed_bytes::text AS reconstructed,anchor_id FROM hosting_storage_boundaries WHERE workspace_id=${workspaceId} AND boundary=${boundary}`;
  if (prior) return prior.status === 'ok' ? { state: 'ok', total: BigInt(prior.total), anchorId: prior.anchor_id } : { state: 'inconsistent', reconstructed: BigInt(prior.reconstructed), anchorId: prior.anchor_id };
  const [first] = await sql`SELECT id FROM hosting_storage_anchors WHERE workspace_id=${workspaceId} AND taken_at>=${boundary} ORDER BY taken_at LIMIT 1`;
  if (!first) return { state: 'pending', reason: 'no_anchor' };
  const [row] = await sql`SELECT a.id,a.total_bytes::text AS total,
      COALESCE((SELECT sum(d.delta_bytes) FROM hosting_storage_deltas d WHERE d.workspace_id=a.workspace_id AND d.at>${boundary} AND pg_visible_in_snapshot(d.xid,a.snapshot)),0)::text AS later
    FROM hosting_storage_anchors a WHERE a.workspace_id=${workspaceId} AND a.taken_at>=${boundary}
      AND pg_snapshot_xmin(a.snapshot)>=(SELECT f.watermark_xid FROM hosting_storage_anchors f WHERE f.id=${first.id})
    ORDER BY a.taken_at LIMIT 1`;
  if (!row) return { state: 'pending', reason: 'in_flight_transactions' };
  const reconstructed = BigInt(row.total) - BigInt(row.later);
  if (reconstructed < 0n) {
    await sql`INSERT INTO hosting_storage_boundaries(workspace_id,boundary,status,total_bytes,reconstructed_bytes,anchor_id) VALUES(${workspaceId},${boundary},'inconsistent',NULL,${reconstructed.toString()},${row.id}) ON CONFLICT DO NOTHING`;
  } else {
    await sql`INSERT INTO hosting_storage_boundaries(workspace_id,boundary,status,total_bytes,reconstructed_bytes,anchor_id) VALUES(${workspaceId},${boundary},'ok',${reconstructed.toString()},${reconstructed.toString()},${row.id}) ON CONFLICT DO NOTHING`;
  }
  return ensureBoundary(sql, workspaceId, boundary);
}

type HourEvidence =
  | { state: 'pending'; reason: string }
  | { state: 'unavailable'; reason: string; evidence: Record<string, unknown> }
  | { state: 'ready'; start: bigint; end: bigint; intrahour: bigint; peak: bigint; drift: bigint; evidence: Record<string, unknown> };

/** Replays the hour from the committed journal in statement-time order, starting at the start boundary. Combined across every
 * category and every transaction, so the peak is the maximum of the simultaneous total, never a sum of separate category peaks. */
export async function hourEvidence(sql: Db, workspaceId: string, hour: Date): Promise<HourEvidence> {
  const next = new Date(hour.getTime() + HOUR);
  const start = await ensureBoundary(sql, workspaceId, hour);
  const end = await ensureBoundary(sql, workspaceId, next);
  if (start.state === 'pending') return { state: 'pending', reason: start.reason };
  if (end.state === 'pending') return { state: 'pending', reason: end.reason };
  if (start.state === 'inconsistent' || end.state === 'inconsistent') {
    return { state: 'unavailable', reason: 'inconsistent_boundary', evidence: { start: start.state, end: end.state, note: 'journal and measurement disagree; no charge is fabricated' } };
  }
  const [replay] = await sql`SELECT count(*)::text AS n,COALESCE(max(run),0)::text AS high,COALESCE(min(run),0)::text AS low,COALESCE(sum(delta_bytes),0)::text AS net FROM (
      SELECT d.at,d.id,d.delta_bytes,sum(d.delta_bytes) OVER (ORDER BY d.at,d.id) AS run FROM hosting_storage_deltas d JOIN hosting_storage_anchors a ON a.id=${end.anchorId}
      WHERE d.workspace_id=${workspaceId} AND d.at>${hour} AND d.at<=${next} AND pg_visible_in_snapshot(d.xid,a.snapshot)) x`;
  // A committed row stamped inside the hour that the closing anchor did not see would mean the watermark was violated.
  const [late] = await sql`SELECT count(*)::text AS n FROM hosting_storage_deltas d JOIN hosting_storage_anchors a ON a.id=${end.anchorId}
    WHERE d.workspace_id=${workspaceId} AND d.at>${hour} AND d.at<=${next} AND NOT pg_visible_in_snapshot(d.xid,a.snapshot)`;
  if (Number(late!.n) > 0) return { state: 'unavailable', reason: 'journal_incomplete', evidence: { unseen_rows: Number(late!.n) } };
  const high = BigInt(replay!.high), low = BigInt(replay!.low), net = BigInt(replay!.net);
  const rows = Number(replay!.n);
  if (rows > 0 && start.total + low < 0n) return { state: 'unavailable', reason: 'negative_running_total', evidence: { start: start.total.toString(), lowest_running_delta: low.toString() } };
  const intrahour = rows > 0 && high > 0n ? start.total + high : start.total;
  // The journal must explain the measured change exactly. Any difference (a write path the journal missed, a classification or
  // TOAST-size disagreement, an unjournaled category) is not billed from a guess: the hour is unavailable.
  const drift = end.total - (start.total + net);
  if (drift !== 0n) return { state: 'unavailable', reason: 'journal_drift', evidence: { start: start.total.toString(), end: end.total.toString(), journaled_net: net.toString(), drift_bytes: drift.toString(), journal_rows: rows } };
  let peak = intrahour;
  if (end.total > peak) peak = end.total;
  return { state: 'ready', start: start.total, end: end.total, intrahour, peak, drift, evidence: { journal_rows: rows } };
}

/** Settles one closed hour atomically: peak, ledger debit, balances and evidence commit together or not at all. */
async function chargeHour(db: Db, enrollment: any, hour: Date, clock: () => Date) {
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    const now = clock();
    await sql`SELECT 1 FROM hosting_storage_enrollments WHERE workspace_id=${enrollment.workspace_id} FOR SHARE`;
    const account = await lockedAccount(enrollment.account_id, sql, now);
    const [prior] = await sql`SELECT * FROM hosting_storage_hours WHERE workspace_id=${enrollment.workspace_id} AND hour=${hour}`;
    if (prior) return { row: prior, pending: null as string | null };
    const intro = isIntroHour(hour, new Date(enrollment.intro_ends_at));
    const ev = await hourEvidence(sql, enrollment.workspace_id, hour);
    if (ev.state === 'pending') return { row: null, pending: ev.reason };
    const meta = { intro_ends_at: new Date(enrollment.intro_ends_at).toISOString() };
    if (ev.state === 'unavailable') {
      const [row] = await sql`INSERT INTO hosting_storage_hours(workspace_id,hour,account_id,status,intro,reason,basis,evidence)
        VALUES(${enrollment.workspace_id},${hour},${account.id},'unavailable',${intro},${ev.reason},${STORAGE_BASIS_VERSION},${sql.json({ ...meta, ...ev.evidence } as any)}) RETURNING *`;
      return { row: row!, pending: null };
    }
    const { billable_bytes, due_units } = hourlyCharge(ev.peak, intro);
    const promo = BigInt(account.promo_units), paid = BigInt(account.paid_units);
    const spendable = promo + (paid > 0n ? paid : 0n);
    const charged = due_units < spendable ? due_units : spendable;
    const fromPromo = promo < charged ? promo : charged, fromPaid = charged - fromPromo;
    const nextPromo = promo - fromPromo, nextPaid = paid - fromPaid;
    let ledgerId: string | null = null;
    if (charged > 0n) {
      const [entry] = await sql`INSERT INTO hosting_ledger(account_id,workspace_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason,metadata)
        VALUES(${account.id},${enrollment.workspace_id},'storage_peak',${(-charged).toString()},${nextPaid.toString()},${nextPromo.toString()},${`storage-peak:${enrollment.workspace_id}:${hour.toISOString()}`},
          ${intro ? 'Introductory hour: 1GB base waived; excess at $5/GB-month' : 'Hourly peak storage, 1GB minimum, $5/GB-month'},
          ${sql.json({ hour: hour.toISOString(), peak_bytes: ev.peak.toString(), billable_bytes: billable_bytes.toString(), intro, basis: STORAGE_BASIS_VERSION })}) RETURNING id`;
      ledgerId = entry!.id;
    }
    if (due_units > 0n) {
      await sql`UPDATE hosting_accounts SET paid_units=${nextPaid.toString()},promo_units=${nextPromo.toString()},
        depleted_at=CASE WHEN ${nextPromo.toString()}::numeric+${nextPaid.toString()}::numeric<=0 THEN COALESCE(depleted_at,${now}) ELSE depleted_at END WHERE id=${account.id}`;
    }
    const [row] = await sql`INSERT INTO hosting_storage_hours(workspace_id,hour,account_id,status,intro,start_bytes,end_bytes,intrahour_peak_bytes,drift_bytes,peak_bytes,billable_bytes,due_units,charged_units,uncollected_units,ledger_id,basis,evidence)
      VALUES(${enrollment.workspace_id},${hour},${account.id},${charged === due_units ? 'charged' : 'underfunded'},${intro},${ev.start.toString()},${ev.end.toString()},${ev.intrahour.toString()},${ev.drift.toString()},${ev.peak.toString()},
        ${billable_bytes.toString()},${due_units.toString()},${charged.toString()},${(due_units - charged).toString()},${ledgerId},${STORAGE_BASIS_VERSION},
        ${sql.json({ ...meta, ...ev.evidence, debt: 'none: shortfall is recorded as uncollected, never as negative balance' } as any)}) RETURNING *`;
    return { row: row!, pending: null };
  });
}

/** Settles every closed hour whose evidence is complete, in order; stops at the first hour that is not (never guesses). */
export async function settleStorageHours(workspaceId: string, db: Db = getDb(), clock: () => Date = () => new Date()) {
  const now = clock();
  const [enrollment] = await db`SELECT * FROM hosting_storage_enrollments WHERE workspace_id=${workspaceId} AND activated_at IS NOT NULL`;
  if (!enrollment) return { settled: 0, pending: null as string | null };
  const limit = hourMs(now);
  const [last] = await db`SELECT max(hour) AS hour FROM hosting_storage_hours WHERE workspace_id=${workspaceId}`;
  let next = last?.hour ? new Date(last.hour).getTime() + HOUR : ceilHourMs(new Date(enrollment.activated_at));
  let settled = 0, pending: string | null = null;
  for (let n = 0; n < SETTLE_BATCH && next + HOUR <= limit; n++, next += HOUR) {
    const result = await chargeHour(db, enrollment, new Date(next), clock);
    if (!result.row) { pending = result.pending; break; }
    settled++;
  }
  return { settled, pending };
}

/** Compacts evidence the settled history no longer needs: journal rows an anchor has seen and that precede the last settled boundary. */
export async function pruneStorageEvidence(workspaceId: string, db: Db = getDb()) {
  const [settled] = await db`SELECT max(hour) AS hour FROM hosting_storage_hours WHERE workspace_id=${workspaceId}`;
  const [anchor] = await db`SELECT snapshot::text AS snapshot FROM hosting_storage_anchors WHERE workspace_id=${workspaceId} ORDER BY taken_at DESC LIMIT 1`;
  if (!settled?.hour || !anchor) return;
  const through = new Date(new Date(settled.hour).getTime() + HOUR);
  await db`DELETE FROM hosting_storage_deltas d WHERE d.workspace_id=${workspaceId} AND d.at<=${through} AND pg_visible_in_snapshot(d.xid,${anchor.snapshot}::pg_snapshot)`;
}

export async function runStoragePeakTick(db: Db = getDb(), clock: () => Date = () => new Date(), measure: typeof measureStorage = measureStorage) {
  const connection = await db.reserve();
  let locked = false;
  try {
    const [lock] = await connection`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS acquired`;
    if (!lock?.acquired) return { workspaces: 0 };
    locked = true;
    const enrollments = await db`SELECT workspace_id FROM hosting_storage_enrollments WHERE activated_at IS NOT NULL ORDER BY workspace_id LIMIT 256`;
    let workspaces = 0;
    for (const e of enrollments) {
      try {
        const latest = async () => { const [a] = await db`SELECT max(taken_at) AS taken_at FROM hosting_storage_anchors WHERE workspace_id=${e.workspace_id}`; return a?.taken_at ? new Date(a.taken_at).getTime() : 0; };
        if (await latest() < hourMs(clock())) await takeStorageAnchor(e.workspace_id, db, measure).catch(() => null);
        let result = await settleStorageHours(e.workspace_id, db, clock);
        // An in-flight transaction (or a missing closing anchor) holds the hour open: look again with a fresh anchor, never settle on a guess.
        if (result.pending && clock().getTime() - await latest() >= RETRY_ANCHOR_MS) {
          await takeStorageAnchor(e.workspace_id, db, measure).catch(() => null);
          result = await settleStorageHours(e.workspace_id, db, clock);
        }
        await pruneStorageEvidence(e.workspace_id, db);
        workspaces++;
      } catch { /* One workspace failing never blocks the others; the next tick resumes. */ }
    }
    return { workspaces };
  } finally {
    try { if (locked) await connection`SELECT pg_advisory_unlock(${LOCK_KEY})`; } finally { connection.release(); }
  }
}

export function startStoragePeakRunner() {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await runStoragePeakTick(); } catch { console.error('[storage-peak] tick failed; retry next minute'); } finally { running = false; } };
  void tick();
  const timer = setInterval(() => void tick(), 60_000); timer.unref();
  return () => clearInterval(timer);
}

// ---- Reserve, runway and owner summary -----------------------------------------------------------------------------

/** Exact charge of the next 720 hours at a constant measured size, honouring the remaining introduction. */
export function forwardWindowUnits(bytes: bigint, introEndsAt: Date | null, now: Date, hours = MONTH_HOURS): bigint {
  const first = hourMs(now);
  const introHours = introEndsAt && introEndsAt.getTime() > first ? Math.min(hours, Math.ceil((introEndsAt.getTime() - first) / HOUR)) : 0;
  return BigInt(introHours) * hourlyCharge(bytes, true).due_units + BigInt(hours - introHours) * hourlyCharge(bytes, false).due_units;
}

type Sized = { workspace_id: string; intro_ends_at: Date; bytes: bigint };
async function activatedRows(sql: Db, accountId: string) {
  return sql`SELECT e.workspace_id,e.activated_at,e.intro_ends_at,hosting_storage_estimate(e.workspace_id)::text AS bytes,
      (SELECT reference_only_bytes::text FROM hosting_storage_anchors a WHERE a.workspace_id=e.workspace_id ORDER BY a.taken_at DESC LIMIT 1) AS reference_only,
      (SELECT max(h.hour) FROM hosting_storage_hours h WHERE h.workspace_id=e.workspace_id) AS settled_hour
    FROM hosting_storage_enrollments e WHERE e.account_id=${accountId} ORDER BY e.workspace_id`;
}

/** Units of purchased credit that must stay funded for the next 30 days of storage across the whole account.
 * Fails closed (never zero) while any required category is unmetered, a workspace is unmeasured, or objects are counted without journal coverage. */
export async function storageProtectedUnits(sql: Db, accountId: string, now = new Date()): Promise<bigint> {
  const missing = missingStorageCategories();
  if (missing.length) throw new HostingError(503, 'storage_coverage_incomplete');
  let total = 0n;
  for (const r of (await activatedRows(sql, accountId)).filter(r => r.activated_at)) {
    if (r.bytes === null) throw new HostingError(503, 'storage_reserve_unavailable');
    if (r.reference_only !== null && BigInt(r.reference_only) > 0n) throw new HostingError(503, 'storage_coverage_incomplete');
    total += forwardWindowUnits(BigInt(r.bytes) < 0n ? 0n : BigInt(r.bytes), new Date(r.intro_ends_at), now);
  }
  return total;
}

let reserveRegistered = false;
/** Trusted startup hook: storage protection participates in refund gating. agent_holds is deliberately NOT registered here. */
export function registerStorageProtectionReserve() {
  if (reserveRegistered) return;
  registerFundingReserve('storage_protection', (sql, accountId) => storageProtectedUnits(sql as Db, accountId));
  reserveRegistered = true;
}

/** Whole funded hours from `now` given a constant measured size per workspace; null means the account burns nothing. */
export function runwayHours(spendable: bigint, workspaces: { bytes: bigint; intro_ends_at: Date | null }[], now: Date): bigint | null {
  const first = hourMs(now);
  const breaks = [...new Set(workspaces.map(w => w.intro_ends_at ? Math.ceil((w.intro_ends_at.getTime() - first) / HOUR) : 0).filter(h => h > 0))].sort((a, b) => a - b);
  let remaining = spendable < 0n ? 0n : spendable, elapsed = 0n, at = 0;
  const rate = (h: number) => workspaces.reduce((sum, w) => sum + hourlyCharge(w.bytes, w.intro_ends_at ? first + h * HOUR < w.intro_ends_at.getTime() : false).due_units, 0n);
  for (const bp of [...breaks, null]) {
    const r = rate(at);
    if (bp === null) return r === 0n ? null : elapsed + remaining / r;
    const length = BigInt(bp - at), cost = r * length;
    if (r > 0n && remaining < cost) return elapsed + remaining / r;
    remaining -= cost; elapsed += length; at = bp;
  }
  return null;
}

/** Authoritative account projection for the owner: purchased balance, protected storage, agent-available funds and runway. */
export async function accountStorageSummary(db: Db, accountId: string, now = new Date()) {
  const [account] = await db`SELECT * FROM hosting_accounts WHERE id=${accountId}`;
  if (!account) throw new HostingError(404, 'billing_account_not_found');
  const promo = new Date(account.promo_expires_at) > now ? BigInt(account.promo_units) : 0n;
  const paid = BigInt(account.paid_units);
  const purchased = paid > 0n ? paid : 0n, debt = paid < 0n ? -paid : 0n;
  const spendable = purchased + promo;
  const rows = await activatedRows(db, accountId);
  const active = rows.filter(r => r.activated_at);
  const unmeasured = active.filter(r => r.bytes === null).map(r => r.workspace_id as string);
  const referenceOnly = active.filter(r => r.reference_only !== null && BigInt(r.reference_only) > 0n).map(r => r.workspace_id as string);
  const sized: Sized[] = active.filter(r => r.bytes !== null).map(r => ({ workspace_id: r.workspace_id as string, intro_ends_at: new Date(r.intro_ends_at), bytes: BigInt(r.bytes) < 0n ? 0n : BigInt(r.bytes) }));
  const missing = missingStorageCategories();
  const measurable = unmeasured.length === 0;
  const complete = missing.length === 0 && measurable && referenceOnly.length === 0;
  const protectedUnits = sized.reduce((sum, w) => sum + forwardWindowUnits(w.bytes, w.intro_ends_at, now), 0n);
  const hours = measurable ? runwayHours(spendable, sized, now) : null;
  const fundedUntil = hours === null ? null : new Date(hourMs(now) + Number(hours) * HOUR).toISOString();
  const days = hours === null ? null : Number(hours) / 24;
  const warning = days === null ? null : days <= 1 ? 1 : days <= 7 ? 7 : days <= 30 ? 30 : null;
  // Incomplete coverage never unlocks agent spend: the reserve would understate what storage needs.
  // Open agent holds are already promised to admitted calls, so they come off what is spendable; unregistered means unknown, never zero.
  const holdsSource = fundingReserveSource('agent_holds');
  const heldUnits = holdsSource ? await holdsSource(db, accountId) : null;
  const agentAvailable = complete && debt === 0n && spendable > protectedUnits + (heldUnits ?? 0n) ? spendable - protectedUnits - (heldUnits ?? 0n) : 0n;
  const asUnits = (v: bigint) => v.toString();
  const reason = missing.length ? 'storage_coverage_incomplete' : !measurable ? 'storage_measurement_unavailable' : referenceOnly.length ? 'storage_coverage_incomplete' : debt > 0n ? 'reversal_debt' : agentAvailable > 0n ? null : 'storage_reserve_not_covered';
  return {
    version: 1 as const, account_id: accountId, currency: 'USD' as const, units_per_usd: USD_UNITS.toString(), as_of: now.toISOString(), basis: STORAGE_BASIS_VERSION,
    balances: {
      purchased_units: asUnits(purchased), purchased_usd: unitsUsd(purchased), promo_units: asUnits(promo), spendable_units: asUnits(spendable), spendable_usd: unitsUsd(spendable),
      reversal_debt_units: asUnits(debt), reversal_debt_usd: unitsUsd(debt),
      protected_storage_units: asUnits(protectedUnits), protected_storage_usd: unitsUsd(protectedUnits), protected_is_lower_bound: !complete,
      agent_available_units: asUnits(agentAvailable), agent_available_usd: unitsUsd(agentAvailable),
      agent_holds: { registered: heldUnits !== null, units: heldUnits === null ? null : heldUnits.toString() as string | null },
    },
    runway: {
      state: !measurable ? 'measurement_unavailable' : active.length === 0 ? 'no_billed_workspace' : hours === null ? 'unbounded' : spendable <= 0n ? 'depleted' : 'projected',
      hours: hours === null ? null : hours.toString(), funded_until: fundedUntil, warning_days: warning, assumes: 'current measured size stays constant; introductory waiver ends on schedule',
      upper_bound: !complete, unmetered_categories_excluded: missing,
    },
    admission: { agent_spend_allowed: agentAvailable > 0n, reason },
    coverage: {
      complete, required: [...REQUIRED_STORAGE_CATEGORIES], metered: ['postgres', 'objects', ...providers.keys()], missing,
      unmetered: [...UNMETERED_STORAGE_CATEGORIES], workspaces_unmeasured: unmeasured, workspaces_with_reference_only_objects: referenceOnly,
    },
    workspaces: rows.map(r => {
      const bytes = r.bytes === null ? null : (BigInt(r.bytes) < 0n ? 0n : BigInt(r.bytes));
      const closed = r.activated_at ? Math.max(0, Math.floor((hourMs(now) - (r.settled_hour ? new Date(r.settled_hour).getTime() + HOUR : ceilHourMs(new Date(r.activated_at)))) / HOUR)) : 0;
      return {
        workspace_id: r.workspace_id as string, activated: Boolean(r.activated_at), activated_at: r.activated_at ? new Date(r.activated_at).toISOString() : null,
        intro_ends_at: r.intro_ends_at ? new Date(r.intro_ends_at).toISOString() : null, current_bytes: bytes === null ? null : bytes.toString(),
        next_720_hours_units: r.activated_at && bytes !== null ? forwardWindowUnits(bytes, new Date(r.intro_ends_at), now).toString() : null,
        unsettled_closed_hours: closed,
      };
    }),
  };
}
export type AccountStorageSummary = Awaited<ReturnType<typeof accountStorageSummary>>;

/** Owner-visible per-hour evidence for one workspace. */
export async function workspaceStorageHours(db: Db, workspaceId: string, limit = 50) {
  const bound = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
  return db`SELECT hour,status,intro,start_bytes,end_bytes,intrahour_peak_bytes,drift_bytes,peak_bytes,billable_bytes,due_units,charged_units,uncollected_units,reason,basis FROM hosting_storage_hours WHERE workspace_id=${workspaceId} ORDER BY hour DESC LIMIT ${bound}`;
}
