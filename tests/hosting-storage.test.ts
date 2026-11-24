import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { installStorageTracking, missingStorageTracking } from '../src/schema/hosting-storage-peak-v1';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { BILLABLE_STORAGE_TABLES, EXCLUDED_STORAGE_TABLES, STORAGE_CLASSIFIED_TABLES } from '../src/services/hosting-storage-classification';
import { USD_UNITS, auditHostingHour, grantHostingCredit, hostingWriteBlock, runHostingBillingTick, unitsUsd } from '../src/services/hosting-billing';
import { availableRefundableUnits, registerFundingReserve } from '../src/services/hosting-funding';
import { enrollWorkspaceBilling } from '../src/services/hosting-workspace-billing';
import {
  GB, accountStorageSummary, activatePeakStorage, enrollPeakStorage, ensureBoundary, forwardWindowUnits, hourEvidence, hourlyCharge, isIntroHour, measureStorage,
  missingStorageCategories, registerMeteredStorageCategory, registerStorageProtectionReserve, runStoragePeakTick, runwayHours, settleStorageHours, storageProtectedUnits, takeStorageAnchor,
} from '../src/services/hosting-storage';
import { openOwnerAccount } from '../src/services/onboarding';

const HOUR = 3_600_000;

describe('exact hourly charge', () => {
  test('ordinary hours charge max(1GB, peak): minimum, fractional and proportional above 1GB', () => {
    expect(hourlyCharge(0n, false).due_units).toBe(GB);
    expect(hourlyCharge(1n, false).due_units).toBe(GB);
    expect(hourlyCharge(GB, false).due_units).toBe(GB);
    expect(hourlyCharge(GB + 1n, false).due_units).toBe(GB + 1n);
    expect(hourlyCharge(1_500_000_001n, false).due_units).toBe(1_500_000_001n);
    // 720 minimum hours are exactly $5.
    expect(unitsUsd(GB * 720n)).toBe('5.000000000000');
    // 2.5GB for 720 hours is exactly $12.50: no rounding anywhere in the tariff.
    expect(unitsUsd(hourlyCharge(2_500_000_000n, false).due_units * 720n)).toBe('12.500000000000');
  });
  test('introductory hours waive the 1GB base only: excess is charged byte for byte', () => {
    expect(hourlyCharge(0n, true).due_units).toBe(0n);
    expect(hourlyCharge(GB, true).due_units).toBe(0n);
    expect(hourlyCharge(GB - 1n, true).due_units).toBe(0n);
    expect(hourlyCharge(GB + 1n, true).due_units).toBe(1n);
    expect(hourlyCharge(3_700_000_000n, true).due_units).toBe(2_700_000_000n);
    expect(() => hourlyCharge(-1n, false)).toThrow();
  });
  test('introduction is exactly 720 hours for any provisioning instant, with an exact boundary', () => {
    for (const offset of [0, 1, 1_800_000, 3_599_999]) {
      const activated = Date.UTC(2026, 10, 24, 10) + offset, ends = new Date(activated + 720 * HOUR);
      let intro = 0;
      for (let hour = Math.ceil(activated / HOUR) * HOUR; ; hour += HOUR) { if (!isIntroHour(new Date(hour), ends)) break; intro++; }
      expect(intro).toBe(720);
    }
    const ends = new Date(Date.UTC(2026, 10, 24, 10) + 720 * HOUR);
    expect(isIntroHour(new Date(ends.getTime() - HOUR), ends)).toBe(true);
    expect(isIntroHour(ends, ends)).toBe(false);
  });
  test('forward 720-hour reserve honours the remaining introduction and never becomes zero for a free base', () => {
    const now = new Date(Date.UTC(2026, 11, 1, 5, 30));
    const ordinary = forwardWindowUnits(500_000_000n, null, now);
    expect(ordinary).toBe(GB * 720n);
    // 100 introductory hours remain: only the excess is free for those hours, the rest is the normal minimum.
    const introEnds = new Date(Date.UTC(2026, 11, 1, 5) + 100 * HOUR);
    expect(forwardWindowUnits(500_000_000n, introEnds, now)).toBe(GB * 620n);
    expect(forwardWindowUnits(3_000_000_000n, introEnds, now)).toBe(2_000_000_000n * 100n + 3_000_000_000n * 620n);
    expect(forwardWindowUnits(500_000_000n, new Date(Date.UTC(2026, 11, 1, 5)), now)).toBe(ordinary);
  });
  test('runway is exact across the end of the introduction', () => {
    const now = new Date(Date.UTC(2026, 11, 1, 5, 30));
    const introEnds = new Date(Date.UTC(2026, 11, 1, 5) + 10 * HOUR);
    const ws = [{ bytes: 500_000_000n, intro_ends_at: introEnds }];
    // Ten free hours, then 1e9 units per hour.
    expect(runwayHours(5_000_000_000n, ws, now)).toBe(15n);
    expect(runwayHours(4_999_999_999n, ws, now)).toBe(14n);
    expect(runwayHours(0n, ws, now)).toBe(10n);
    expect(runwayHours(10n * GB, [{ bytes: 500_000_000n, intro_ends_at: null }], now)).toBe(10n);
    expect(runwayHours(1n, [], now)).toBeNull();
    // Two workspaces with different introductions aggregate piecewise.
    const second = new Date(Date.UTC(2026, 11, 1, 5) + 20 * HOUR);
    expect(runwayHours(30n * GB, [{ bytes: 0n, intro_ends_at: introEnds }, { bytes: 0n, intro_ends_at: second }], now)).toBe(30n); // 10 free hours, 10 hours at 1GB, then 10 hours at 2GB
  });
});

const port = Number(process.env.STORAGE_TEST_PORT);
const gitStandIn = (bytes = 0n) => ({ id: 'git' as const, journal: 'write_path' as const, bytes: async () => bytes });
describe.skipIf(!port || port === 5432)('peak storage meter on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_storage_${process.pid}_${Date.now()}`;
  const ownerKey = new Uint8Array(32).fill(141), managerKey = new Uint8Array(32).fill(142), strangerKey = new Uint8Array(32).fill(143);
  const owner = nip19.npubEncode(getPublicKey(ownerKey)), manager = nip19.npubEncode(getPublicKey(managerKey)), stranger = nip19.npubEncode(getPublicKey(strangerKey));
  const app = createApp();
  let db: ReturnType<typeof postgres>;
  let ownerActor: string, managerActor: string, account: string;

  async function safeHour() {
    const left = Math.floor(Date.now() / HOUR) * HOUR + HOUR - Date.now();
    if (left < 90_000) await new Promise(r => setTimeout(r, left + 1500));
    return Math.floor(Date.now() / HOUR) * HOUR;
  }
  /** A fresh enrolled, activated workspace whose first billed hour is the CURRENT real hour. */
  async function workspace(opts: { introEndsAt?: (h: number) => number; fundCents?: number; accountId?: string; activate?: boolean } = {}) {
    const h = await safeHour();
    const id = randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${id},'tower',${id},${owner},'storage-fixture','Storage')`;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${id},${ownerActor},'owner'),(${id},${managerActor},'admin')`;
    const acct = opts.accountId ?? account;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${id},${acct})`;
    await enrollPeakStorage(db as any, id, acct, null);
    if (opts.activate !== false) {
      const ends = opts.introEndsAt ? opts.introEndsAt(h) : h - HOUR;
      await db`UPDATE hosting_storage_enrollments SET activated_at=${new Date(h - 30 * 60_000)},intro_ends_at=${new Date(ends)} WHERE workspace_id=${id}`;
    }
    return { id, h };
  }
  const objectRow = (ws: string, bytes: number, path = `o/${randomUUID()}`) => db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,storage_path,pg_workspace_id,completed_at)
    VALUES(${owner},${owner},'application/octet-stream',${bytes},${path},${ws},now()) RETURNING id`;
  const setRow = (ws: string, payload = 'x', id = randomUUID()) => db`INSERT INTO managed_storage_sets(workspace_id,delegation_id,id,metadata,membership_digest,total_count,state,metadata_bytes)
    VALUES(${ws},${randomUUID()},${id},${db.json({ p: payload })},'d',1,'draft',1) RETURNING id`;
  /** Absolute level taken "just after" a boundary: real snapshot, stamped inside the requested instant. */
  const anchorAt = (ws: string, at: number) => takeStorageAnchor(ws, db as any, async (w, d) => ({ ...(await measureStorage(w, d)), taken_at: new Date(at) }));
  const real = (ws: string) => takeStorageAnchor(ws, db as any);
  const hours = (ws: string) => db`SELECT * FROM hosting_storage_hours WHERE workspace_id=${ws} ORDER BY hour`;
  const fund = (cents: number, key = randomUUID().slice(0, 12)) => grantHostingCredit(account, cents, key, 'Storage fixture credit', owner, db as any);
  const balance = async () => { const [a] = await db`SELECT paid_units,promo_units,depleted_at FROM hosting_accounts WHERE id=${account}`; return { paid: BigInt(a!.paid_units), promo: BigInt(a!.promo_units), depleted: a!.depleted_at as Date | null }; };

  beforeAll(async () => {
    process.env.ONBOARDING_ENABLED = 'true';
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    [{ id: ownerActor }] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${owner},'human') RETURNING id` as any;
    [{ id: managerActor }] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${manager},'human') RETURNING id` as any;
    account = (await openOwnerAccount(owner, db as any)).account_id;
    await fund(10_000); // $100
  });
  afterAll(async () => { await closeDb(); const root = postgres({ ...conn, database: 'postgres' }); await root.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await root.end(); });

  test('every workspace table is classified exactly once; all billable tables carry current triggers', async () => {
    const rows = await db`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relispartition
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND a.atttypid='uuid'::regtype AND NOT a.attisdropped)`;
    const present = new Set(rows.map(r => r.relname as string));
    expect([...present].filter(t => !STORAGE_CLASSIFIED_TABLES.has(t))).toEqual([]);
    expect([...STORAGE_CLASSIFIED_TABLES].filter(t => !present.has(t))).toEqual([]);
    expect(BILLABLE_STORAGE_TABLES.filter(t => t in EXCLUDED_STORAGE_TABLES)).toEqual([]);
    expect(new Set(BILLABLE_STORAGE_TABLES).size).toBe(BILLABLE_STORAGE_TABLES.length);
    expect(await missingStorageTracking(db as any)).toEqual([]);
    // Regeneration is idempotent and a missing trigger is detected.
    await db.unsafe(`DROP TRIGGER hosting_storage_track_d ON managed_storage_sets`);
    expect(await missingStorageTracking(db as any)).toEqual(['managed_storage_sets']);
    await installStorageTracking(db as any);
    expect(await missingStorageTracking(db as any)).toEqual([]);
  });

  test('every generated trigger function executes for every billable table and event', async () => {
    // Statement-level triggers fire even when no row matches, so this plans and runs each generated body (an enrollment must exist or they return early).
    await workspace();
    for (const table of BILLABLE_STORAGE_TABLES) {
      await db.unsafe(`INSERT INTO public."${table}" SELECT * FROM public."${table}" WHERE false`);
      await db.unsafe(`UPDATE public."${table}" SET workspace_id=workspace_id WHERE false`);
      await db.unsafe(`DELETE FROM public."${table}" WHERE false`);
    }
    await db.unsafe(`INSERT INTO v4_storage_objects SELECT * FROM v4_storage_objects WHERE false`);
    await db.unsafe(`UPDATE v4_storage_objects SET size_bytes=size_bytes WHERE false`);
    await db.unsafe(`DELETE FROM v4_storage_objects WHERE false`);
  });

  test('closed rollout installs nothing; unenrolled workspaces journal nothing', async () => {
    const root = postgres({ ...conn, database: 'postgres' }), scratch = `${name}_closed`;
    await root.unsafe(`CREATE DATABASE ${scratch}`); await root.end();
    const closed = postgres({ ...conn, database: scratch });
    try {
      const previous = process.env.ONBOARDING_ENABLED; process.env.ONBOARDING_ENABLED = 'false';
      for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await closed.unsafe(statement);
      await ensureRuntimeSchema(closed);
      process.env.ONBOARDING_ENABLED = previous;
      const [{ n }] = await closed`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'hosting_storage_track_%'`;
      expect(n).toBe(0);
    } finally { await closed.end(); const r = postgres({ ...conn, database: 'postgres' }); await r.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`); await r.end(); }
    // On the enabled database, a workspace without enrollment is never journaled.
    const id = randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${id},'tower',${id},${owner},'storage-fixture','Legacy')`;
    await setRow(id, 'a'.repeat(500)); await objectRow(id, 5_000_000_000);
    expect((await db`SELECT 1 FROM hosting_storage_deltas WHERE workspace_id=${id}`).length).toBe(0);
  });

  test('byte categories: classified PG bytes, deduped object paths, replicas and operational tables excluded', async () => {
    const { id } = await workspace();
    const empty = await measureStorage(id, db as any);
    await setRow(id, 'q'.repeat(300));
    const [expected] = await db`SELECT sum(COALESCE(pg_column_size(r.workspace_id),0)+COALESCE(pg_column_size(r.delegation_id),0)+COALESCE(pg_column_size(r.id),0)+COALESCE(pg_column_size(r.metadata),0)+COALESCE(pg_column_size(r.membership_digest),0)+COALESCE(pg_column_size(r.total_count),0)+COALESCE(pg_column_size(r.state),0)+COALESCE(pg_column_size(r.metadata_bytes),0))::text AS bytes FROM managed_storage_sets r WHERE workspace_id=${id}`;
    const withRow = await measureStorage(id, db as any);
    expect(withRow.postgres_bytes - empty.postgres_bytes).toBe(BigInt(expected!.bytes));
    expect(withRow.object_bytes).toBe(0n);
    // Replica and queue rows never count.
    await db`INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) VALUES(${id},'f','1',${db.json({ big: 'z'.repeat(1000) })})`;
    await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,event_type,payload) VALUES(${id},'t',${db.json({ big: 'z'.repeat(1000) })})`;
    expect((await measureStorage(id, db as any)).postgres_bytes).toBe(withRow.postgres_bytes);
    // One storage path counts once even when two metadata rows name it; a second path adds its bytes.
    await objectRow(id, 700_000_000, 'shared/path'); await objectRow(id, 700_000_000, 'shared/path'); await objectRow(id, 250, 'other/path');
    expect((await measureStorage(id, db as any)).object_bytes).toBe(700_000_250n);
    await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,storage_path,pg_workspace_id) VALUES(${owner},${owner},'x',999999999,'pending/path',${id})`;
    expect((await measureStorage(id, db as any)).object_bytes).toBe(700_000_250n);
    // Another workspace's objects are never attributed here.
    const other = await workspace(); await objectRow(other.id, 123_456_789);
    expect((await measureStorage(id, db as any)).object_bytes).toBe(700_000_250n);
    expect((await measureStorage(other.id, db as any)).object_bytes).toBe(123_456_789n);
    expect(withRow.evidence).toMatchObject({ categories: { postgres: 'measured', objects: 'measured', git: 'unmetered', graph: 'unmetered' } });
  });

  test('write-path journal equals the measurement for inserts, shrinking updates and deletes on PG rows and objects', async () => {
    const { id } = await workspace();
    await real(id);
    const before = await measureStorage(id, db as any);
    const a = await setRow(id, 'a'.repeat(600)); await setRow(id, 'b'.repeat(900));
    await db`UPDATE managed_storage_sets SET metadata=${db.json({ p: 'c' })} WHERE id=${a[0]!.id}`;
    const obj = await objectRow(id, 2_000_000_000);
    await db`UPDATE v4_storage_objects SET size_bytes=1_500_000_000 WHERE id=${obj[0]!.id}`;
    await objectRow(id, 40, 'dup'); await objectRow(id, 40, 'dup');
    const after = await measureStorage(id, db as any);
    const [{ net }] = await db`SELECT COALESCE(sum(delta_bytes),0)::text AS net FROM hosting_storage_deltas WHERE workspace_id=${id}`;
    expect(BigInt(net)).toBe(after.postgres_bytes + after.object_bytes - before.postgres_bytes - before.object_bytes);
    await db`DELETE FROM managed_storage_sets WHERE workspace_id=${id}`;
    await db`DELETE FROM v4_storage_objects WHERE pg_workspace_id=${id}`;
    const [{ net: net2 }] = await db`SELECT COALESCE(sum(delta_bytes),0)::text AS net FROM hosting_storage_deltas WHERE workspace_id=${id}`;
    const end = await measureStorage(id, db as any);
    expect(BigInt(net2)).toBe(end.postgres_bytes + end.object_bytes - before.postgres_bytes - before.object_bytes);
  });

  test('a delete inside the hour cannot erase the peak; ordinary hour is charged at the replayed peak', async () => {
    const { id, h } = await workspace();
    await real(id);
    const start = await measureStorage(id, db as any);
    const base = start.postgres_bytes + start.object_bytes;
    const big = await objectRow(id, 3_000_000_000);
    await db`DELETE FROM v4_storage_objects WHERE id=${big[0]!.id}`;
    await anchorAt(id, h + HOUR + 60_000);
    const clock = () => new Date(h + HOUR + 10 * 60_000);
    expect((await settleStorageHours(id, db as any, clock)).settled).toBe(1);
    const [row] = await hours(id);
    expect(row!.peak_bytes).toBe((base + 3_000_000_000n).toString());
    expect(row!.intrahour_peak_bytes).toBe((base + 3_000_000_000n).toString());
    expect(row!.end_bytes).toBe(base.toString());
    expect(row!.intro).toBe(false);
    expect(row!.due_units).toBe((base + 3_000_000_000n).toString());
    // The ledger carries exactly that debit.
    const [entry] = await db`SELECT amount_units FROM hosting_ledger WHERE id=${row!.ledger_id}`;
    expect(entry!.amount_units).toBe((-(base + 3_000_000_000n)).toString());
  });

  test('peak is the max across increase then decrease within the hour, not the final level', async () => {
    const { id, h } = await workspace();
    await real(id);
    const base0 = await measureStorage(id, db as any);
    const level0 = base0.postgres_bytes + base0.object_bytes;
    const one = await objectRow(id, 2_000_000_000);
    const two = await objectRow(id, 1_000_000_000);
    await db`DELETE FROM v4_storage_objects WHERE id=${two[0]!.id}`; // pre-image: +3GB
    await db`DELETE FROM v4_storage_objects WHERE id=${one[0]!.id}`; // pre-image: +2GB
    await objectRow(id, 500_000_000); // ends at +0.5GB, below the earlier peak
    await anchorAt(id, h + HOUR + 60_000);
    await settleStorageHours(id, db as any, () => new Date(h + HOUR + 10 * 60_000));
    const [row] = await hours(id);
    expect(row!.peak_bytes).toBe((level0 + 3_000_000_000n).toString());
    expect(row!.end_bytes).toBe((level0 + 500_000_000n).toString());
  });

  test('an increase with no later decrease is captured by the end boundary', async () => {
    const { id, h } = await workspace();
    await real(id);
    const b = await measureStorage(id, db as any);
    await objectRow(id, 4_000_000_000);
    await anchorAt(id, h + HOUR + 60_000);
    await settleStorageHours(id, db as any, () => new Date(h + HOUR + 10 * 60_000));
    const [row] = await hours(id);
    expect(row!.peak_bytes).toBe((b.postgres_bytes + b.object_bytes + 4_000_000_000n).toString());
    expect(row!.intrahour_peak_bytes).toBe(row!.peak_bytes);
  });

  test('the peak and the debit survive a process restart: every fact lives in committed rows', async () => {
    const { id, h } = await workspace();
    await real(id);
    const b = await measureStorage(id, db as any);
    const big = await objectRow(id, 3_500_000_000);
    await db`DELETE FROM v4_storage_objects WHERE id=${big[0]!.id}`;
    await anchorAt(id, h + HOUR + 60_000);
    // A brand-new connection stands in for a restarted process; nothing is held in memory.
    const restarted = postgres({ ...conn, database: name });
    try {
      await settleStorageHours(id, restarted as any, () => new Date(h + HOUR + 10 * 60_000));
      const [row] = await restarted`SELECT peak_bytes FROM hosting_storage_hours WHERE workspace_id=${id}`;
      expect(row!.peak_bytes).toBe((b.postgres_bytes + b.object_bytes + 3_500_000_000n).toString());
    } finally { await restarted.end(); }
  });

  test('boundary totals are fixed by the first anchor after them and never rewritten', async () => {
    const { id, h } = await workspace();
    await real(id);
    await objectRow(id, 1_000);
    const first = await anchorAt(id, h + HOUR + 1_000);
    const boundary = new Date(h + HOUR);
    const total = await ensureBoundary(db as any, id, boundary);
    expect(total).toMatchObject({ state: 'ok', total: BigInt(first!.total_bytes) });
    await objectRow(id, 777);
    await anchorAt(id, h + HOUR + 120_000);
    expect(await ensureBoundary(db as any, id, boundary)).toEqual(total);
    // No anchor yet after a later boundary: unknown, never guessed.
    expect(await ensureBoundary(db as any, id, new Date(h + 5 * HOUR))).toEqual({ state: 'pending', reason: 'no_anchor' });
  });

  test('exact intro boundary: waiver is base-only, excess is charged, and the next hour is ordinary', async () => {
    const { id, h } = await workspace({ introEndsAt: h => h + HOUR }); // hour h is introductory, h+1 is not
    await real(id);
    const b = await measureStorage(id, db as any);
    const level = b.postgres_bytes + b.object_bytes;
    await objectRow(id, 2_500_000_000);
    await anchorAt(id, h + HOUR + 30_000);
    await anchorAt(id, h + 2 * HOUR + 30_000);
    const clock = () => new Date(h + 2 * HOUR + 10 * 60_000);
    expect((await settleStorageHours(id, db as any, clock)).settled).toBe(2);
    const [intro, ordinary] = await hours(id);
    expect([intro!.intro, ordinary!.intro]).toEqual([true, false]);
    const peak = level + 2_500_000_000n;
    expect(intro!.peak_bytes).toBe(peak.toString());
    expect(intro!.billable_bytes).toBe((peak - GB).toString()); // excess above the waived 1GB, still charged
    expect(intro!.due_units).toBe((peak - GB).toString());
    expect(ordinary!.billable_bytes).toBe(peak.toString());
  });

  test('an introductory hour at or below 1GB costs nothing and writes no ledger row; an ordinary hour pays the 1GB minimum', async () => {
    const { id, h } = await workspace({ introEndsAt: h => h + HOUR });
    await real(id);
    await anchorAt(id, h + HOUR + 30_000);
    await anchorAt(id, h + 2 * HOUR + 30_000);
    const before = await balance();
    await settleStorageHours(id, db as any, () => new Date(h + 2 * HOUR + 10 * 60_000));
    const [intro, ordinary] = await hours(id);
    expect(intro!.due_units).toBe('0'); expect(intro!.ledger_id).toBeNull(); expect(intro!.status).toBe('charged');
    expect(ordinary!.billable_bytes).toBe(GB.toString()); expect(ordinary!.due_units).toBe(GB.toString());
    expect((await balance()).paid).toBe(before.paid - GB);
  });

  test('concurrent workers and retries debit each hour exactly once', async () => {
    const { id, h } = await workspace();
    await real(id);
    await objectRow(id, 1_200_000_000);
    await anchorAt(id, h + HOUR + 30_000);
    const clock = () => new Date(h + HOUR + 10 * 60_000);
    await Promise.all([...Array.from({ length: 12 }, () => settleStorageHours(id, db as any, clock)), ...Array.from({ length: 4 }, () => runStoragePeakTick(db as any, clock))]);
    await settleStorageHours(id, db as any, clock);
    const rows = await hours(id);
    expect(rows.length).toBe(1);
    expect((await db`SELECT 1 FROM hosting_ledger WHERE workspace_id=${id} AND kind='storage_peak'`).length).toBe(1);
    const [mine] = await db`SELECT amount_units FROM hosting_ledger WHERE workspace_id=${id} AND kind='storage_peak'`;
    expect(mine!.amount_units).toBe((-BigInt(rows[0]!.charged_units)).toString());
    // The balance equals the ledger, to the unit.
    const [sum] = await db`SELECT COALESCE(sum(amount_units),0)::text AS total FROM hosting_ledger WHERE account_id=${account}`;
    expect(BigInt(sum!.total)).toBe((await balance()).paid + (await balance()).promo);
  });

  test('an hour needs a closing anchor after its end; until then it stays pending and nothing is guessed', async () => {
    const { id, h } = await workspace();
    await real(id);
    const clock = () => new Date(h + 3 * HOUR);
    expect(await settleStorageHours(id, db as any, clock)).toEqual({ settled: 0, pending: 'no_anchor' });
    await anchorAt(id, h + HOUR + 30_000);
    expect(await settleStorageHours(id, db as any, clock)).toEqual({ settled: 1, pending: 'no_anchor' }); // hour h+1 still lacks its closing anchor
    expect((await hours(id)).length).toBe(1);
  });

  test('no debt: a shortfall is recorded as uncollected, balance never goes negative, read-only starts, top-up resumes prospectively', async () => {
    const acct = (await db`INSERT INTO hosting_accounts(owner_actor_id,opened_by,promo_units) VALUES(${managerActor},'onboarding',0) RETURNING id`)[0]!.id as string;
    await db`INSERT INTO hosting_ledger(account_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason) VALUES(${acct},'admin',1500000000,1500000000,0,'seed','fixture')`;
    await db`UPDATE hosting_accounts SET paid_units=1500000000 WHERE id=${acct}`;
    const { id, h } = await workspace({ accountId: acct });
    await real(id);
    for (let n = 1; n <= 3; n++) await anchorAt(id, h + n * HOUR + 30_000);
    await settleStorageHours(id, db as any, () => new Date(h + 3 * HOUR + 10 * 60_000));
    const rows = await hours(id);
    expect(rows.map(r => r.status)).toEqual(['charged', 'underfunded', 'underfunded']);
    expect(rows.map(r => r.charged_units)).toEqual([GB.toString(), '500000000', '0']);
    expect(rows.map(r => r.uncollected_units)).toEqual(['0', '500000000', GB.toString()]);
    const [a] = await db`SELECT paid_units,depleted_at FROM hosting_accounts WHERE id=${acct}`;
    expect(a!.paid_units).toBe('0'); expect(a!.depleted_at).not.toBeNull();
    expect((await db`SELECT 1 FROM hosting_ledger WHERE account_id=${acct} AND kind='storage_peak'`).length).toBe(2);
    const block = await hostingWriteBlock(id, db as any) as any;
    expect(block).toMatchObject({ code: 'hosting_balance_exhausted', status: 402, automatic_deletion: false });
    expect(Date.parse(block.grace_ends_at) - Date.parse(a!.depleted_at)).toBe(30 * 86400000);
    // Reversal debt (negative purchased balance) is explicit and non-spendable.
    await db`UPDATE hosting_accounts SET paid_units=-5 WHERE id=${acct}`;
    const unregisterGit = registerMeteredStorageCategory(gitStandIn());
    const unregisterHolds = registerFundingReserve('agent_holds', async () => 0n); // stand-in for the agent slice, this test only
    const summary = await accountStorageSummary(db as any, acct);
    unregisterHolds(); unregisterGit();
    expect(summary.balances).toMatchObject({ purchased_units: '0', reversal_debt_units: '5', spendable_units: '0', agent_available_units: '0' });
    expect(summary.admission).toMatchObject({ agent_spend_allowed: false, reason: 'reversal_debt' });
    await db`UPDATE hosting_accounts SET paid_units=10000000000,depleted_at=NULL WHERE id=${acct}`; // top-up
    await anchorAt(id, h + 4 * HOUR + 30_000);
    await settleStorageHours(id, db as any, () => new Date(h + 4 * HOUR + 10 * 60_000));
    const resumed = (await hours(id)).at(-1)!;
    expect(resumed.status).toBe('charged');
    expect((await hours(id)).length).toBe(4); // earlier unfunded hours stay unfunded: no retroactive back-charge
  });

  test('rolled-back writes leave no journal; parallel writers journal exactly what they store', async () => {
    const { id } = await workspace();
    await real(id);
    const before = await measureStorage(id, db as any);
    await expect(db.begin(async tx => {
      await tx`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,storage_path,pg_workspace_id,completed_at) VALUES(${owner},${owner},'x',9000000000,'rb/1',${id},now())`;
      await tx`DELETE FROM v4_storage_objects WHERE pg_workspace_id=${id}`;
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect((await db`SELECT 1 FROM hosting_storage_deltas WHERE workspace_id=${id}`).length).toBe(0);
    await Promise.all(Array.from({ length: 24 }, (_, i) => i % 3 === 0 ? objectRow(id, 1_000_000 + i) : setRow(id, `p${i}`.repeat(40 + i))));
    await db`DELETE FROM managed_storage_sets WHERE workspace_id=${id} AND membership_digest='d' AND metadata_bytes=1 AND total_count=1 AND id IN (SELECT id FROM managed_storage_sets WHERE workspace_id=${id} LIMIT 3)`;
    const after = await measureStorage(id, db as any);
    const [{ net }] = await db`SELECT COALESCE(sum(delta_bytes),0)::text AS net FROM hosting_storage_deltas WHERE workspace_id=${id}`;
    expect(BigInt(net)).toBe(after.postgres_bytes + after.object_bytes - before.postgres_bytes - before.object_bytes);
  });

  test('managed S3 objects are billable until physical deletion is confirmed, and the peak keeps them', async () => {
    const { id } = await workspace();
    await real(id);
    const before = await measureStorage(id, db as any);
    const objectId = randomUUID();
    await db`INSERT INTO managed_app_storage_objects(id,workspace_id,delegation_id,installation_id,app_id,app_npub,idempotency_key,size_bytes,sha256_hex,publisher_receipt,receipt_bytes,state)
      VALUES(${objectId},${id},${randomUUID()},'i','a','npub',${randomUUID()},8000000,${'a'.repeat(64)},${db.json({ r: 1 })},10,'pending')`;
    await db`UPDATE managed_app_storage_objects SET state='complete' WHERE id=${objectId}`;
    const grown = await measureStorage(id, db as any);
    expect(grown.object_bytes - before.object_bytes).toBe(8_000_000n);
    await db`UPDATE managed_app_storage_objects SET physical_absent=true WHERE id=${objectId}`;
    const shrunk = await measureStorage(id, db as any);
    expect(shrunk.object_bytes).toBe(before.object_bytes);
    const [{ net }] = await db`SELECT COALESCE(sum(delta_bytes),0)::text AS net FROM hosting_storage_deltas WHERE workspace_id=${id}`;
    expect(BigInt(net)).toBe(shrunk.postgres_bytes + shrunk.object_bytes - before.postgres_bytes - before.object_bytes);
    const h = Math.floor(Date.now() / HOUR) * HOUR;
    await anchorAt(id, h + HOUR + 60_000);
    const ev = await hourEvidence(db as any, id, new Date(h));
    expect(ev.state).toBe('ready');
    if (ev.state === 'ready') expect(ev.intrahour).toBeGreaterThanOrEqual(before.postgres_bytes + before.object_bytes + 8_000_000n);
  });

  test('a failed measurement leaves hours pending, never zero; a later anchor settles them from the journal', async () => {
    const { id, h } = await workspace();
    await real(id);
    await objectRow(id, 2_000_000_000);
    const clock = () => new Date(h + 2 * HOUR + 10 * 60_000);
    await runStoragePeakTick(db as any, clock, async () => { throw new Error('measurement unavailable'); });
    expect((await hours(id)).length).toBe(0);
    await anchorAt(id, h + 2 * HOUR + 30_000);
    await settleStorageHours(id, db as any, clock);
    const rows = await hours(id);
    expect(rows.length).toBe(2); // both closed hours are derived from the one later anchor and the retained journal
    expect(BigInt(rows[0]!.peak_bytes)).toBeGreaterThanOrEqual(2_000_000_000n);
    expect(rows[0]!.peak_bytes).toBe(rows[1]!.peak_bytes);
  });

  test('adversarial: a transaction straddling the hour boundary holds the hour open; it settles with that transaction included', async () => {
    const { id, h } = await workspace();
    await real(id);
    const base = await measureStorage(id, db as any);
    const level = base.postgres_bytes + base.object_bytes;
    const clock = () => new Date(h + 3 * HOUR);
    const other = postgres({ ...conn, database: name });
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let started!: () => void; const open = new Promise<void>(r => { started = r; });
    // Journal row written inside the hour by a transaction that commits only after the closing anchor was taken.
    const straddler = other.begin(async t => {
      await t`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,storage_path,pg_workspace_id,completed_at) VALUES(${owner},${owner},'x',5000000000,${`straddle/${randomUUID()}`},${id},now())`;
      started(); await gate;
    });
    try {
      await open;
      await anchorAt(id, h + HOUR + 30_000);
      expect(await settleStorageHours(id, db as any, clock)).toEqual({ settled: 0, pending: 'in_flight_transactions' });
      expect((await hours(id)).length).toBe(0);
      release(); await straddler;
      await anchorAt(id, h + HOUR + 60_000);
      expect((await settleStorageHours(id, db as any, clock)).settled).toBe(1);
      const [row] = await hours(id);
      expect(row!.intrahour_peak_bytes).toBe((level + 5_000_000_000n).toString());
      expect(row!.peak_bytes).toBe((level + 5_000_000_000n).toString());
    } finally { release(); await straddler.catch(() => null); await other.end(); }
  });

  test('inconsistent journal/measurement is recorded unavailable, never clamped to zero or charged', async () => {
    const { id, h } = await workspace();
    await db`INSERT INTO hosting_storage_deltas(workspace_id,category,delta_bytes,at) VALUES(${id},'objects',9000000000,${new Date(h + 1000)})`; // committed journal row no measurement ever reflects
    await real(id);
    await anchorAt(id, h + HOUR + 30_000);
    const before = await balance();
    expect((await settleStorageHours(id, db as any, () => new Date(h + 3 * HOUR))).settled).toBe(1);
    const [row] = await hours(id);
    expect(row).toMatchObject({ status: 'unavailable', reason: 'inconsistent_boundary', ledger_id: null, peak_bytes: null, due_units: null, charged_units: '0' });
    expect((await db`SELECT status,total_bytes FROM hosting_storage_boundaries WHERE workspace_id=${id} AND boundary=${new Date(h)}`)[0]).toMatchObject({ status: 'inconsistent', total_bytes: null });
    expect(await balance()).toEqual(before);
  });

  test('a decreasing statement in a REPEATABLE READ writer still sees other transactions\' committed growth (journal replay, no stale snapshot)', async () => {
    const { id, h } = await workspace();
    await real(id);
    const base = await measureStorage(id, db as any);
    const level = base.postgres_bytes + base.object_bytes;
    const old = await objectRow(id, 1_000_000_000);
    const writer = postgres({ ...conn, database: name });
    try {
      await writer.begin('isolation level repeatable read', async t => {
        await t`SELECT count(*) FROM v4_storage_objects`; // fixes the snapshot before the other writer commits
        await objectRow(id, 3_000_000_000); // committed by another connection
        await t`DELETE FROM v4_storage_objects WHERE id=${old[0]!.id}`;
      });
    } finally { await writer.end(); }
    await anchorAt(id, h + HOUR + 30_000);
    await settleStorageHours(id, db as any, () => new Date(h + 3 * HOUR));
    const [row] = await hours(id);
    // +1GB, +3GB (other connection), -1GB: simultaneous maximum is 4GB above the start, not 1GB and not the final 3GB.
    expect(row!.intrahour_peak_bytes).toBe((level + 4_000_000_000n).toString());
    expect(row!.end_bytes).toBe((level + 3_000_000_000n).toString());
  });

  test('the peak is the simultaneous maximum across categories, not a sum of separately peaked categories', async () => {
    const { id, h } = await workspace();
    await real(id);
    const base = await measureStorage(id, db as any);
    const level = base.postgres_bytes + base.object_bytes;
    const big = await objectRow(id, 3_000_000_000);
    await db`DELETE FROM v4_storage_objects WHERE id=${big[0]!.id}`;
    const managed = randomUUID();
    await db`INSERT INTO managed_app_storage_objects(id,workspace_id,delegation_id,installation_id,app_id,app_npub,idempotency_key,size_bytes,sha256_hex,publisher_receipt,receipt_bytes,state)
      VALUES(${managed},${id},${randomUUID()},'i','a','npub',${randomUUID()},8000000,${'b'.repeat(64)},${db.json({ r: 1 })},10,'complete')`;
    await db`UPDATE managed_app_storage_objects SET physical_absent=true WHERE id=${managed}`;
    await anchorAt(id, h + HOUR + 30_000);
    await settleStorageHours(id, db as any, () => new Date(h + 3 * HOUR));
    const [row] = await hours(id);
    const peak = BigInt(row!.peak_bytes);
    expect(peak).toBeGreaterThanOrEqual(level + 3_000_000_000n);
    expect(peak).toBeLessThan(level + 3_000_000_000n + 8_000_000n); // never 3GB + 8MB added together
  });

  test('stored-size accuracy: large compressible values are journaled at stored size on insert, update and delete', async () => {
    const { id } = await workspace();
    await real(id);
    const before = await measureStorage(id, db as any);
    const level = (m: { postgres_bytes: bigint; object_bytes: bigint }) => m.postgres_bytes + m.object_bytes;
    const net = async () => BigInt((await db`SELECT COALESCE(sum(delta_bytes),0)::text AS n FROM hosting_storage_deltas WHERE workspace_id=${id}`)[0]!.n);
    const row = await setRow(id, 'a'.repeat(300_000));
    let after = await measureStorage(id, db as any);
    expect(after.postgres_bytes - before.postgres_bytes).toBeLessThan(10_000n); // compressed: far below the 300KB raw tuple
    expect(await net()).toBe(level(after) - level(before));
    await db`UPDATE managed_storage_sets SET metadata=${db.json({ p: 'z'.repeat(500_000) })} WHERE id=${row[0]!.id}`;
    after = await measureStorage(id, db as any);
    expect(await net()).toBe(level(after) - level(before));
    await db`DELETE FROM managed_storage_sets WHERE id=${row[0]!.id}`;
    after = await measureStorage(id, db as any);
    expect(await net()).toBe(level(after) - level(before));
  });

  test('structural exclusion: service replicas, queues and logs carry no trigger and journal nothing', async () => {
    const excluded = Object.keys(EXCLUDED_STORAGE_TABLES);
    const triggered = await db`SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname LIKE 'hosting_storage_track_%' AND c.relname=ANY(${excluded})`;
    expect(triggered.map(r => r.relname)).toEqual([]);
    const { id } = await workspace();
    await real(id);
    await db`INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) VALUES(${id},'f','x',${db.json({ big: 'z'.repeat(5000) })})`;
    await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,event_type,payload) VALUES(${id},'t',${db.json({ big: 'z'.repeat(5000) })})`;
    await db`DELETE FROM flightdeck_pg_record_current WHERE workspace_id=${id}`;
    expect((await db`SELECT 1 FROM hosting_storage_deltas WHERE workspace_id=${id}`).length).toBe(0);
  });

  test('nonzero journal drift fails closed: an unjournaled change makes the hour unavailable, never a billed guess', async () => {
    const { id, h } = await workspace();
    await real(id);
    await db.unsafe('ALTER TABLE v4_storage_objects DISABLE TRIGGER hosting_storage_track_i'); // simulates a write path the journal missed
    try { await objectRow(id, 2_000_000_000); } finally { await db.unsafe('ALTER TABLE v4_storage_objects ENABLE TRIGGER hosting_storage_track_i'); }
    await anchorAt(id, h + HOUR + 30_000);
    const before = await balance();
    await settleStorageHours(id, db as any, () => new Date(h + 3 * HOUR));
    const [row] = await hours(id);
    expect(row).toMatchObject({ status: 'unavailable', reason: 'journal_drift', ledger_id: null, peak_bytes: null, charged_units: '0' });
    expect(await balance()).toEqual(before);
  });

  test('a category name alone never counts as metered: only a provider-backed, write-path-journaled registration, and its bytes enter every anchor', async () => {
    expect(missingStorageCategories()).toEqual(['git']);
    expect(() => registerMeteredStorageCategory('git' as any)).toThrow();
    expect(() => registerMeteredStorageCategory({ id: 'git', journal: 'sampled' as any, bytes: async () => 0n })).toThrow();
    expect(missingStorageCategories()).toEqual(['git']);
    const unregister = registerMeteredStorageCategory(gitStandIn(777n));
    try {
      expect(missingStorageCategories()).toEqual([]);
      const { id } = await workspace();
      const a = await real(id);
      expect(a!.external_bytes).toBe('777');
      expect(BigInt(a!.total_bytes)).toBe(BigInt(a!.postgres_bytes) + BigInt(a!.object_bytes) + 777n);
    } finally { unregister(); }
    expect(missingStorageCategories()).toEqual(['git']);
  });

  test('failed setup consumes nothing: a pre-activation enrollment journals bytes but never charges', async () => {
    const { id, h } = await workspace({ activate: false });
    await real(id);
    await objectRow(id, 2_000_000_000);
    await anchorAt(id, h + 3 * HOUR);
    const before = await balance();
    const result = await settleStorageHours(id, db as any, () => new Date(h + 10 * HOUR));
    await runStoragePeakTick(db as any, () => new Date(h + 10 * HOUR), async (w, d) => measureStorage(w, d));
    expect(result.settled).toBe(0);
    expect((await hours(id)).length).toBe(0);
    expect(await balance()).toEqual(before);
    expect((await db`SELECT 1 FROM hosting_storage_deltas WHERE workspace_id=${id}`).length).toBeGreaterThan(0);
    // Activation is a one-time, exact 720-hour grant.
    const first = await db.begin(tx => activatePeakStorage(tx as any, id));
    const again = await db.begin(tx => activatePeakStorage(tx as any, id));
    expect(new Date(first.intro_ends_at).getTime() - new Date(first.activated_at).getTime()).toBe(720 * HOUR);
    expect(new Date(again.activated_at).getTime()).toBe(new Date(first.activated_at).getTime());
  });

  test('legacy hourly audit never charges a peak-enrolled workspace', async () => {
    const { id, h } = await workspace();
    await db`UPDATE hosting_workspace_accounts SET enabled_at=${new Date(h)} WHERE workspace_id=${id}`;
    const sample = { workspace_id: id, collected_at: new Date(h).toISOString(), cache_ttl_seconds: 60, categories: [{ id: 'objects', label: 'o', bytes: 1, status: 'partial', measurement: 'registered_bytes', reason: 'x' }, { id: 'database', label: 'd', bytes: 1, status: 'partial', measurement: 'logical_estimate', reason: 'x' }], total_bytes: 2, coverage: 'partial', total_description: '' } as any;
    await expect(auditHostingHour(id, new Date(h), sample, db as any, new Date(h + 1000))).rejects.toThrow();
    await runHostingBillingTick(db as any, new Date(h + 5000), async () => sample);
    expect((await db`SELECT 1 FROM hosting_usage_hours WHERE workspace_id=${id}`).length).toBe(0);
    process.env.HOSTING_WORKSPACE_BILLING_ENABLED = 'true';
    try { await expect(enrollWorkspaceBilling(id, ownerActor, true, db as any)).rejects.toThrow('workspace_peak_billing_active'); } finally { delete process.env.HOSTING_WORKSPACE_BILLING_ENABLED; }
  });

  test('Git is required billable storage: incomplete coverage fails the reserve closed and never unlocks refunds or agent spend', async () => {
    const acct = (await db`INSERT INTO hosting_accounts(owner_actor_id,opened_by,promo_units,paid_units) VALUES(${(await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${stranger},'human') RETURNING id`)[0]!.id},'onboarding',0,${(100n * USD_UNITS).toString()}) RETURNING id`)[0]!.id as string;
    const now = new Date();
    const ws = await workspace({ accountId: acct });
    await real(ws.id);
    expect(missingStorageCategories()).toEqual(['git']);
    await expect(storageProtectedUnits(db as any, acct, now)).rejects.toMatchObject({ code: 'storage_coverage_incomplete', status: 503 });
    registerStorageProtectionReserve();
    const unregisterHolds = registerFundingReserve('agent_holds', async () => 0n); // stand-in for the agent slice, this test only
    try {
      await expect(availableRefundableUnits(db as any, acct)).rejects.toMatchObject({ code: 'storage_coverage_incomplete' });
    } finally { unregisterHolds(); }
    const summary = await accountStorageSummary(db as any, acct, now);
    expect(summary.coverage).toMatchObject({ complete: false, missing: ['git'] });
    expect(summary.coverage.unmetered.find((c: any) => c.id === 'git')).toMatchObject({ required: true });
    expect(summary.coverage.unmetered.find((c: any) => c.id === 'graph')).toMatchObject({ required: false });
    expect(summary.balances).toMatchObject({ agent_available_units: '0', protected_is_lower_bound: true });
    expect(BigInt(summary.balances.spendable_units)).toBeGreaterThan(0n);
    expect(summary.admission).toEqual({ agent_spend_allowed: false, reason: 'storage_coverage_incomplete' });
    expect(summary.runway.upper_bound).toBe(true);
  });

  test('storage_protection aggregates every linked workspace, protects refunds, and fails closed when unmeasured (Git metered)', async () => {
    const unregisterGit = registerMeteredStorageCategory(gitStandIn()); // stand-in for the Git slice, this test only
    try {
      const acct = (await db`INSERT INTO hosting_accounts(owner_actor_id,opened_by,promo_units) VALUES(${(await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${'npub1' + 'q'.repeat(58)},'human') RETURNING id`)[0]!.id},'onboarding',0) RETURNING id`)[0]!.id as string;
      const now = new Date();
      const first = await workspace({ accountId: acct, introEndsAt: h => h + 100 * HOUR });
      const second = await workspace({ accountId: acct, introEndsAt: h => h - HOUR });
      // Unmeasured, activated workspace: reserve cannot be sized.
      await expect(storageProtectedUnits(db as any, acct, now)).rejects.toThrow('storage_reserve_unavailable');
      await real(first.id); await real(second.id);
      await objectRow(second.id, 2_000_000_000);
      const a = BigInt((await db`SELECT hosting_storage_estimate(${first.id}) AS b`)[0]!.b), b = BigInt((await db`SELECT hosting_storage_estimate(${second.id}) AS b`)[0]!.b);
      const expected = forwardWindowUnits(a, new Date(first.h + 100 * HOUR), now) + forwardWindowUnits(b, new Date(second.h - HOUR), now);
      expect(await storageProtectedUnits(db as any, acct, now)).toBe(expected);
      // Refund gating: purchased credit minus the aggregate reserve (agent_holds stand-in registered by this test only).
      registerStorageProtectionReserve();
      const unregister = registerFundingReserve('agent_holds', async () => 0n);
      try {
        const paid = expected + 12_345n;
        await db`UPDATE hosting_accounts SET paid_units=${paid.toString()} WHERE id=${acct}`;
        expect(await availableRefundableUnits(db as any, acct)).toBe(12_345n);
        await db`UPDATE hosting_accounts SET paid_units=${(expected - 1n).toString()} WHERE id=${acct}`;
        expect(await availableRefundableUnits(db as any, acct)).toBe(0n);
      } finally { unregister(); }
      // Growth raises the protected amount immediately, from the write-path journal alone.
      await db`UPDATE hosting_accounts SET paid_units=${(expected * 2n).toString()} WHERE id=${acct}`;
      await objectRow(second.id, 1_000_000_000);
      expect(await storageProtectedUnits(db as any, acct, now)).toBe(expected + 720n * 1_000_000_000n);
      // Without a registered agent_holds source the held amount is unknown, never zero: agent spend stays closed with an explicit reason.
      const unknown = await accountStorageSummary(db as any, acct, now);
      expect(unknown.balances.agent_holds).toEqual({ registered: false, units: null });
      expect(unknown.balances.agent_available_units).toBe('0');
      expect(unknown.admission).toEqual({ agent_spend_allowed: false, reason: 'agent_holds_unavailable' });
      const offHolds = registerFundingReserve('agent_holds', async () => 0n); // stand-in for the agent slice, this test only
      const summary = await accountStorageSummary(db as any, acct, now);
      expect(summary.coverage.complete).toBe(true);
      expect(summary.balances.protected_storage_units).toBe((expected + 720n * 1_000_000_000n).toString());
      expect(BigInt(summary.balances.agent_available_units)).toBe(expected * 2n - BigInt(summary.balances.protected_storage_units));
      expect(summary.balances.agent_holds).toEqual({ registered: true, units: '0' });
      expect(summary.runway.upper_bound).toBe(false);
      // Funded growth may reduce runway and stop agent admission; the storage write itself was never blocked.
      await db`UPDATE hosting_accounts SET paid_units=${(expected / 2n).toString()} WHERE id=${acct}`;
      const tight = await accountStorageSummary(db as any, acct, now);
      expect(tight.admission).toMatchObject({ agent_spend_allowed: false, reason: 'storage_reserve_not_covered' });
      expect(tight.balances.agent_available_units).toBe('0');
      offHolds();
      // Reference-only objects are measured but not journaled: the policy is flagged incomplete instead of pretending to agree.
      const linked = await workspace({ accountId: acct });
      const loose = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,storage_path,completed_at) VALUES(${owner},${owner},'x',640,${`ref/${randomUUID()}`},now()) RETURNING id`;
      await db`INSERT INTO flightdeck_pg_storage_links(workspace_id,scope_id,channel_id,entity_type,storage_object_id) SELECT ${linked.id},gen_random_uuid(),gen_random_uuid(),'t',${loose[0]!.id} WHERE false`;
      await db`INSERT INTO flightdeck_pg_app_storage_objects(storage_object_id,workspace_id,app_npub,actor_id) VALUES(${loose[0]!.id},${linked.id},'npub-app',${ownerActor})`;
      await real(linked.id);
      const attributed = await measureStorage(linked.id, db as any);
      expect(attributed.reference_only_bytes).toBe(640n);
      expect(attributed.evidence).toMatchObject({ categories: { objects: 'measured_reference_only_untracked' } });
      await expect(storageProtectedUnits(db as any, acct, now)).rejects.toMatchObject({ code: 'storage_coverage_incomplete' });
      expect((await accountStorageSummary(db as any, acct, now)).admission.reason).toBe('storage_coverage_incomplete');
    } finally { unregisterGit(); }
  });

  test('owner routes expose balances; workspace managers see workspace scope only; strangers are refused', async () => {
    const { id } = await workspace();
    await real(id);
    const get = (op: string, key: Uint8Array) => {
      const path = `http://localhost/api/v4/hosting-billing/workspaces/${id}/${op}`;
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(), tags: [['u', path], ['method', 'GET']] }, key);
      return app.request(path, { headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` } });
    };
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${id},'actor',${managerActor},'workspace','workspace.manage')`;
    const asOwner = await get('storage', ownerKey);
    expect(asOwner.status).toBe(200);
    const body = await asOwner.json() as any;
    expect(body.balances.purchased_units).toBeDefined();
    expect(body.balances.agent_available_units).toBeDefined();
    expect(body.runway.state).toBeDefined();
    const asManager = await get('storage', managerKey);
    expect(asManager.status).toBe(200);
    const managerBody = await asManager.json() as any;
    expect(managerBody.balances).toBeUndefined();
    expect(managerBody.financial_scope).toBe('workspace');
    expect((await get('storage', strangerKey)).status).toBeGreaterThanOrEqual(403);
    // The wizard's account-level projection is owner-authenticated and workspace-independent.
    const accountPath = 'http://localhost/api/v4/onboarding/account';
    const accountEvent = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(), tags: [['u', accountPath], ['method', 'GET']] }, ownerKey);
    const wizard = await (await app.request(accountPath, { headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(accountEvent)).toString('base64')}` } })).json() as any;
    expect(wizard.storage.account_id).toBe(account);
    expect(BigInt(wizard.storage.balances.agent_available_units) + BigInt(wizard.storage.balances.protected_storage_units)).toBeLessThanOrEqual(BigInt(wizard.storage.balances.spendable_units) + BigInt(wizard.storage.balances.protected_storage_units));
    const status = await (await get('status', ownerKey)).json() as any;
    expect(status.billing_mode).toBe('usd_peak_v1');
    const managerStatus = await (await get('status', managerKey)).json() as any;
    expect(managerStatus.storage).toBeUndefined();
  });
});
