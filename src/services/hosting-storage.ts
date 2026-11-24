import { getDb } from '../db';
import { HostingError, lockedAccount, USD_UNITS, unitsUsd } from './hosting-billing';
import { registerFundingReserve } from './hosting-funding';
import { BILLABLE_STORAGE_TABLES, STORAGE_BASIS_VERSION, UNMETERED_STORAGE_CATEGORIES } from './hosting-storage-classification';
import { billableColumns, bytesOf, missingStorageTracking, quote } from '../schema/hosting-storage-peak-v1';

type Db = ReturnType<typeof getDb>;
const HOUR = 3_600_000;
const hourMs = (date: Date) => Math.floor(date.getTime() / HOUR) * HOUR;
const ceilHourMs = (date: Date) => Math.ceil(date.getTime() / HOUR) * HOUR;
/** Decimal gigabyte. $5/GB-month over 720 hours is exactly one tariff unit per byte-hour (144e9 units per USD). */
export const GB = 1_000_000_000n;
export const MONTH_HOURS = 720;
export const INTRO_HOURS = 720;
/** An hour settles only after this delay so transactions that straddle the boundary have committed their journal rows. */
export const SETTLE_DELAY_MS = 5 * 60_000;
const ROW_LIMIT = 1_000_000;
const OBJECT_LIMIT = 100_000;
const SETTLE_BATCH = 744;
const LOCK_KEY = 1440000723;

/** Exact billing of one hour: ordinary hours pay for max(1GB, peak); introductory hours waive the 1GB base only. */
export function hourlyCharge(peakBytes: bigint, intro: boolean) {
  if (peakBytes < 0n) throw new HostingError(500, 'invalid_peak');
  const billable = intro ? (peakBytes > GB ? peakBytes - GB : 0n) : (peakBytes > GB ? peakBytes : GB);
  return { billable_bytes: billable, due_units: billable };
}

/** Introductory status of an hour: hour-start before the intro end. The leading partial hour is unbilled, so any
 * provisioning instant yields exactly 720 introductory hours. */
export const isIntroHour = (hour: Date, introEndsAt: Date) => hour.getTime() < introEndsAt.getTime();

// ---- Measurement ---------------------------------------------------------------------------------------------------

export type StorageMeasurement = { postgres_bytes: bigint; object_bytes: bigint; snapshot: string; taken_at: Date; evidence: Record<string, unknown> };

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
    const sums = await sql.unsafe([...tables].map(([t, cols]) => `SELECT '${t}' AS table_name,COALESCE(sum(${bytesOf('r', cols)}),0)::text AS bytes FROM public.${quote(t)} r WHERE r.workspace_id=$1::uuid`).join(' UNION ALL '), [workspaceId]);
    const postgres_bytes = sums.reduce((s: bigint, r: any) => s + BigInt(r.bytes), 0n);
    // Object bytes: completed v4 metadata attributed by pg_workspace_id or referenced by a billable table, one count per storage path.
    const refs = await sql.unsafe(`SELECT c.relname AS table_name,a.attname AS column_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]) AND a.attname IN ('storage_object_id','head_storage_object_id') AND a.atttypid='uuid'::regtype AND NOT a.attisdropped`, [BILLABLE_STORAGE_TABLES as unknown as string[]]);
    const refSelects = refs.map((r: any) => ` UNION SELECT ${quote(r.column_name)} AS id FROM public.${quote(r.table_name)} WHERE workspace_id=$1::uuid`).join('');
    const [objects] = await sql.unsafe(`WITH refs AS MATERIALIZED (
        (SELECT id FROM v4_storage_objects WHERE pg_workspace_id=$1::uuid LIMIT ${OBJECT_LIMIT + 1})${refSelects}
      ), objects AS MATERIALIZED (
        SELECT o.storage_path,o.size_bytes FROM v4_storage_objects o JOIN refs r ON r.id=o.id WHERE o.completed_at IS NOT NULL LIMIT ${OBJECT_LIMIT + 1}
      ), paths AS (SELECT storage_path,min(size_bytes) AS bytes,count(DISTINCT size_bytes) AS sizes FROM objects GROUP BY storage_path)
      SELECT (SELECT count(*) FROM objects)::text AS objects,COALESCE((SELECT sum(bytes) FROM paths),0)::text AS bytes,
        (SELECT count(*) FROM paths WHERE sizes<>1 OR bytes<0)::text AS conflicts`, [workspaceId]);
    if (Number(objects!.objects) > OBJECT_LIMIT) throw new HostingError(503, 'storage_measurement_too_large');
    let managed = 0n;
    if (tables.has('managed_app_storage_objects')) {
      const [m] = await sql`SELECT COALESCE(sum(size_bytes),0)::text AS bytes FROM managed_app_storage_objects WHERE workspace_id=${workspaceId} AND state='complete' AND NOT physical_absent`;
      managed = BigInt(m!.bytes);
    }
    const v4 = BigInt(objects!.bytes);
    return {
      postgres_bytes, object_bytes: v4 + managed, snapshot: clock!.snapshot as string, taken_at: clock!.taken_at as Date,
      evidence: {
        basis: STORAGE_BASIS_VERSION, tables_measured: tables.size, object_references: Number(objects!.objects), object_size_conflicts: Number(objects!.conflicts),
        v4_object_bytes: v4.toString(), managed_object_bytes: managed.toString(),
        categories: { postgres: 'measured', objects: 'measured', ...Object.fromEntries(UNMETERED_STORAGE_CATEGORIES.map(c => [c.id, 'unmetered'])) },
      },
    };
  });
}

/** Records an absolute level with its MVCC snapshot. Idempotent per (workspace, instant). */
export async function takeStorageAnchor(workspaceId: string, db: Db = getDb(), measure: typeof measureStorage = measureStorage) {
  const m = await measure(workspaceId, db);
  const total = m.postgres_bytes + m.object_bytes;
  const [row] = await db`INSERT INTO hosting_storage_anchors(workspace_id,taken_at,snapshot,postgres_bytes,object_bytes,total_bytes,evidence)
    VALUES(${workspaceId},${m.taken_at},${m.snapshot}::pg_snapshot,${m.postgres_bytes.toString()},${m.object_bytes.toString()},${total.toString()},${db.json(JSON.parse(JSON.stringify(m.evidence)))})
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

/** Total at a UTC hour boundary: the first anchor taken at/after it minus every journaled delta after the boundary that the anchor saw. */
export async function ensureBoundary(sql: Db, workspaceId: string, boundary: Date): Promise<bigint | null> {
  const [prior] = await sql`SELECT total_bytes FROM hosting_storage_boundaries WHERE workspace_id=${workspaceId} AND boundary=${boundary}`;
  if (prior) return BigInt(prior.total_bytes);
  const [row] = await sql`SELECT a.id,a.total_bytes::text AS total,
      COALESCE((SELECT sum(d.delta_bytes) FROM hosting_storage_deltas d WHERE d.workspace_id=a.workspace_id AND d.at>${boundary} AND pg_visible_in_snapshot(d.xid,a.snapshot)),0)::text AS later
    FROM hosting_storage_anchors a WHERE a.workspace_id=${workspaceId} AND a.taken_at>=${boundary} ORDER BY a.taken_at LIMIT 1`;
  if (!row) return null;
  let total = BigInt(row.total) - BigInt(row.later);
  if (total < 0n) total = 0n;
  await sql`INSERT INTO hosting_storage_boundaries(workspace_id,boundary,total_bytes,anchor_id) VALUES(${workspaceId},${boundary},${total.toString()},${row.id}) ON CONFLICT DO NOTHING`;
  const [stored] = await sql`SELECT total_bytes FROM hosting_storage_boundaries WHERE workspace_id=${workspaceId} AND boundary=${boundary}`;
  return BigInt(stored!.total_bytes);
}

/** Settles one closed hour atomically: peak, ledger debit, balances and evidence commit together or not at all. */
async function chargeHour(db: Db, enrollment: any, hour: Date, clock: () => Date) {
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    const now = clock();
    await sql`SELECT 1 FROM hosting_storage_enrollments WHERE workspace_id=${enrollment.workspace_id} FOR SHARE`;
    const account = await lockedAccount(enrollment.account_id, sql, now);
    const [prior] = await sql`SELECT * FROM hosting_storage_hours WHERE workspace_id=${enrollment.workspace_id} AND hour=${hour}`;
    if (prior) return prior;
    const next = new Date(hour.getTime() + HOUR);
    const start = await ensureBoundary(sql, enrollment.workspace_id, hour);
    const end = await ensureBoundary(sql, enrollment.workspace_id, next);
    if (start === null || end === null) return null;
    const [obs] = await sql`SELECT max(bytes)::text AS peak,count(*)::int AS observations FROM hosting_storage_observations WHERE workspace_id=${enrollment.workspace_id} AND at>=${hour} AND at<${next}`;
    const observed = obs!.peak === null ? null : BigInt(obs!.peak);
    let peak = start > end ? start : end;
    if (observed !== null && observed > peak) peak = observed;
    const intro = isIntroHour(hour, new Date(enrollment.intro_ends_at));
    const { billable_bytes, due_units } = hourlyCharge(peak, intro);
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
          ${sql.json({ hour: hour.toISOString(), peak_bytes: peak.toString(), billable_bytes: billable_bytes.toString(), intro, basis: STORAGE_BASIS_VERSION })}) RETURNING id`;
      ledgerId = entry!.id;
    }
    if (charged > 0n || due_units > 0n) {
      await sql`UPDATE hosting_accounts SET paid_units=${nextPaid.toString()},promo_units=${nextPromo.toString()},
        depleted_at=CASE WHEN ${nextPromo.toString()}::numeric+${nextPaid.toString()}::numeric<=0 THEN COALESCE(depleted_at,${now}) ELSE depleted_at END WHERE id=${account.id}`;
    }
    const [row] = await sql`INSERT INTO hosting_storage_hours(workspace_id,hour,account_id,status,intro,start_bytes,end_bytes,observed_peak_bytes,peak_bytes,billable_bytes,due_units,charged_units,uncollected_units,ledger_id,basis,evidence)
      VALUES(${enrollment.workspace_id},${hour},${account.id},${charged === due_units ? 'charged' : 'underfunded'},${intro},${start.toString()},${end.toString()},${observed?.toString() ?? null},${peak.toString()},
        ${billable_bytes.toString()},${due_units.toString()},${charged.toString()},${(due_units - charged).toString()},${ledgerId},${STORAGE_BASIS_VERSION},
        ${sql.json({ observations: obs!.observations, intro_ends_at: new Date(enrollment.intro_ends_at).toISOString(), debt: 'none: shortfall is recorded as uncollected, never as negative balance' })}) RETURNING *`;
    return row!;
  });
}

/** Settles every closed, measurable hour for one workspace in order; stops at the first hour lacking a measurement (never guesses). */
export async function settleStorageHours(workspaceId: string, db: Db = getDb(), clock: () => Date = () => new Date()) {
  const now = clock();
  const [enrollment] = await db`SELECT * FROM hosting_storage_enrollments WHERE workspace_id=${workspaceId} AND activated_at IS NOT NULL`;
  if (!enrollment) return { settled: 0 };
  const limit = hourMs(new Date(now.getTime() - SETTLE_DELAY_MS));
  const [last] = await db`SELECT max(hour) AS hour FROM hosting_storage_hours WHERE workspace_id=${workspaceId}`;
  let next = last?.hour ? new Date(last.hour).getTime() + HOUR : ceilHourMs(new Date(enrollment.activated_at));
  let settled = 0;
  for (let n = 0; n < SETTLE_BATCH && next + HOUR <= limit; n++, next += HOUR) {
    const row = await chargeHour(db, enrollment, new Date(next), clock);
    if (!row) break;
    settled++;
  }
  return { settled };
}

/** Compacts evidence the settled history no longer needs. Deltas an anchor has seen and boundaries already fixed are redundant. */
export async function pruneStorageEvidence(workspaceId: string, db: Db = getDb()) {
  const [latest] = await db`SELECT max(boundary) AS boundary FROM hosting_storage_boundaries WHERE workspace_id=${workspaceId}`;
  const [anchor] = await db`SELECT snapshot::text AS snapshot FROM hosting_storage_anchors WHERE workspace_id=${workspaceId} ORDER BY taken_at DESC LIMIT 1`;
  if (!latest?.boundary || !anchor) return;
  await db`DELETE FROM hosting_storage_deltas d WHERE d.workspace_id=${workspaceId} AND d.at<=${latest.boundary} AND pg_visible_in_snapshot(d.xid,${anchor.snapshot}::pg_snapshot)`;
  const [settled] = await db`SELECT max(hour) AS hour FROM hosting_storage_hours WHERE workspace_id=${workspaceId}`;
  if (settled?.hour) await db`DELETE FROM hosting_storage_observations WHERE workspace_id=${workspaceId} AND at<${new Date(new Date(settled.hour).getTime() + HOUR)}`;
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
        const [anchor] = await db`SELECT max(taken_at) AS taken_at FROM hosting_storage_anchors WHERE workspace_id=${e.workspace_id}`;
        if (!anchor?.taken_at || new Date(anchor.taken_at).getTime() < hourMs(clock())) await takeStorageAnchor(e.workspace_id, db, measure).catch(() => null);
        await settleStorageHours(e.workspace_id, db, clock);
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

type ReserveRow = { workspace_id: string; intro_ends_at: Date; bytes: bigint };
async function activeWorkspaces(sql: Db, accountId: string): Promise<ReserveRow[]> {
  const rows = await sql`SELECT e.workspace_id,e.intro_ends_at,hosting_storage_estimate(e.workspace_id)::text AS bytes FROM hosting_storage_enrollments e WHERE e.account_id=${accountId} AND e.activated_at IS NOT NULL ORDER BY e.workspace_id`;
  // A billed workspace without a measurement can't be sized: fail closed instead of protecting zero.
  if (rows.some(r => r.bytes === null)) throw new HostingError(503, 'storage_reserve_unavailable');
  return rows.map(r => ({ workspace_id: r.workspace_id, intro_ends_at: new Date(r.intro_ends_at), bytes: BigInt(r.bytes) < 0n ? 0n : BigInt(r.bytes) }));
}

/** Units of purchased credit that must stay funded for the next 30 days of storage across the whole account. */
export async function storageProtectedUnits(sql: Db, accountId: string, now = new Date()): Promise<bigint> {
  let total = 0n;
  for (const w of await activeWorkspaces(sql, accountId)) total += forwardWindowUnits(w.bytes, w.intro_ends_at, now);
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
  const rows = await db`SELECT e.workspace_id,e.activated_at,e.intro_ends_at,hosting_storage_estimate(e.workspace_id)::text AS bytes FROM hosting_storage_enrollments e WHERE e.account_id=${accountId} ORDER BY e.workspace_id`;
  const active = rows.filter(r => r.activated_at);
  const unmeasured = active.filter(r => r.bytes === null).map(r => r.workspace_id as string);
  const sized = active.filter(r => r.bytes !== null).map(r => ({ workspace_id: r.workspace_id as string, intro_ends_at: new Date(r.intro_ends_at), bytes: BigInt(r.bytes) < 0n ? 0n : BigInt(r.bytes) }));
  const measurable = unmeasured.length === 0;
  const protectedUnits = sized.reduce((sum, w) => sum + forwardWindowUnits(w.bytes, w.intro_ends_at, now), 0n);
  const hours = measurable ? runwayHours(spendable, sized, now) : null;
  const fundedUntil = hours === null ? null : new Date(hourMs(now) + Number(hours) * HOUR).toISOString();
  const days = hours === null ? null : Number(hours) / 24;
  const warning = days === null ? null : days <= 1 ? 1 : days <= 7 ? 7 : days <= 30 ? 30 : null;
  const agentAvailable = measurable && debt === 0n && spendable > protectedUnits ? spendable - protectedUnits : 0n;
  const asUnits = (v: bigint) => v.toString();
  const unmetered = [...UNMETERED_STORAGE_CATEGORIES];
  return {
    version: 1 as const, account_id: accountId, currency: 'USD' as const, units_per_usd: USD_UNITS.toString(), as_of: now.toISOString(), basis: STORAGE_BASIS_VERSION,
    balances: {
      purchased_units: asUnits(purchased), purchased_usd: unitsUsd(purchased), promo_units: asUnits(promo), spendable_units: asUnits(spendable), spendable_usd: unitsUsd(spendable),
      reversal_debt_units: asUnits(debt), reversal_debt_usd: unitsUsd(debt),
      protected_storage_units: asUnits(protectedUnits), protected_storage_usd: unitsUsd(protectedUnits),
      agent_available_units: asUnits(agentAvailable), agent_available_usd: unitsUsd(agentAvailable),
      agent_holds: { registered: false, units: null as string | null },
    },
    runway: {
      state: !measurable ? 'measurement_unavailable' : active.length === 0 ? 'no_billed_workspace' : hours === null ? 'unbounded' : spendable <= 0n ? 'depleted' : 'projected',
      hours: hours === null ? null : hours.toString(), funded_until: fundedUntil, warning_days: warning, assumes: 'current measured size stays constant; introductory waiver ends on schedule',
      upper_bound: true, unmetered_categories_excluded: unmetered.map(c => c.id),
    },
    admission: { agent_spend_allowed: agentAvailable > 0n, reason: !measurable ? 'storage_measurement_unavailable' : debt > 0n ? 'reversal_debt' : agentAvailable > 0n ? null : 'storage_reserve_not_covered' },
    coverage: { complete: false, metered: ['postgres', 'objects'], unmetered, workspaces_unmeasured: unmeasured },
    workspaces: rows.map(r => ({
      workspace_id: r.workspace_id as string, activated: Boolean(r.activated_at), activated_at: r.activated_at ? new Date(r.activated_at).toISOString() : null,
      intro_ends_at: r.intro_ends_at ? new Date(r.intro_ends_at).toISOString() : null, current_bytes: r.bytes === null ? null : (BigInt(r.bytes) < 0n ? 0n : BigInt(r.bytes)).toString(),
      next_720_hours_units: r.activated_at && r.bytes !== null ? forwardWindowUnits(BigInt(r.bytes) < 0n ? 0n : BigInt(r.bytes), new Date(r.intro_ends_at), now).toString() : null,
    })),
  };
}
export type AccountStorageSummary = Awaited<ReturnType<typeof accountStorageSummary>>;

/** Owner-visible per-hour evidence for one workspace. */
export async function workspaceStorageHours(db: Db, workspaceId: string, limit = 50) {
  const bound = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
  return db`SELECT hour,status,intro,start_bytes,end_bytes,observed_peak_bytes,peak_bytes,billable_bytes,due_units,charged_units,uncollected_units,basis FROM hosting_storage_hours WHERE workspace_id=${workspaceId} ORDER BY hour DESC LIMIT ${bound}`;
}
