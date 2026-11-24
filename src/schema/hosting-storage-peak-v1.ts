import { createHash } from 'node:crypto';
import { BILLABLE_STORAGE_TABLES } from '../services/hosting-storage-classification';

/** Peak-storage meter v1 (approved onboarding policy only; legacy accounts are never enrolled).
 *
 * Durable peak capture: PostgreSQL statement triggers on every billable table (and objects) append signed byte deltas to
 * `hosting_storage_deltas`, and every DECREASING statement first records the pre-image total in `hosting_storage_observations`.
 * Hourly anchors (exact measurements with their MVCC snapshot) fix absolute levels; boundary totals are anchor minus the deltas
 * committed after the boundary. Hour peak = max(start boundary, end boundary, pre-images inside the hour), so a delete can never erase
 * a peak and a restart loses nothing: all of it is committed in the same transaction as the customer write. */
export const hostingStoragePeakV1Sql = `
CREATE TABLE IF NOT EXISTS hosting_storage_enrollments (
 workspace_id UUID PRIMARY KEY REFERENCES flightdeck_pg_workspaces(id),
 account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 policy TEXT NOT NULL DEFAULT 'peak-v1' CHECK(policy='peak-v1'),
 origin_intent_id UUID, -- onboarding_intents.id; deliberately unenforced so legacy billing fixtures can replay this additive schema
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 activated_at TIMESTAMPTZ, intro_ends_at TIMESTAMPTZ,
 CHECK((activated_at IS NULL)=(intro_ends_at IS NULL))
);
CREATE TABLE IF NOT EXISTS hosting_storage_deltas (
 id BIGSERIAL PRIMARY KEY,
 workspace_id UUID NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('postgres','objects')),
 delta_bytes BIGINT NOT NULL CHECK(delta_bytes<>0),
 xid XID8 NOT NULL DEFAULT pg_current_xact_id(),
 at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hosting_storage_deltas_xid ON hosting_storage_deltas(workspace_id,xid);
CREATE INDEX IF NOT EXISTS hosting_storage_deltas_at ON hosting_storage_deltas(workspace_id,at);
CREATE TABLE IF NOT EXISTS hosting_storage_anchors (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id UUID NOT NULL REFERENCES hosting_storage_enrollments(workspace_id),
 taken_at TIMESTAMPTZ NOT NULL,
 snapshot PG_SNAPSHOT NOT NULL,
 postgres_bytes NUMERIC(40,0) NOT NULL CHECK(postgres_bytes>=0),
 object_bytes NUMERIC(40,0) NOT NULL CHECK(object_bytes>=0),
 total_bytes NUMERIC(40,0) NOT NULL CHECK(total_bytes=postgres_bytes+object_bytes),
 evidence JSONB NOT NULL,
 UNIQUE(workspace_id,taken_at)
);
CREATE TABLE IF NOT EXISTS hosting_storage_boundaries (
 workspace_id UUID NOT NULL REFERENCES hosting_storage_enrollments(workspace_id),
 boundary TIMESTAMPTZ NOT NULL,
 total_bytes NUMERIC(40,0) NOT NULL CHECK(total_bytes>=0),
 anchor_id UUID NOT NULL REFERENCES hosting_storage_anchors(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,boundary),
 CHECK(date_trunc('hour',boundary AT TIME ZONE 'UTC')=boundary AT TIME ZONE 'UTC')
);
CREATE TABLE IF NOT EXISTS hosting_storage_observations (
 id BIGSERIAL PRIMARY KEY,
 workspace_id UUID NOT NULL,
 at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 bytes NUMERIC(40,0) NOT NULL CHECK(bytes>=0),
 source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hosting_storage_observations_at ON hosting_storage_observations(workspace_id,at);
CREATE TABLE IF NOT EXISTS hosting_storage_hours (
 workspace_id UUID NOT NULL REFERENCES hosting_storage_enrollments(workspace_id),
 hour TIMESTAMPTZ NOT NULL,
 account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 status TEXT NOT NULL CHECK(status IN ('charged','underfunded')),
 intro BOOLEAN NOT NULL,
 start_bytes NUMERIC(40,0) NOT NULL CHECK(start_bytes>=0),
 end_bytes NUMERIC(40,0) NOT NULL CHECK(end_bytes>=0),
 observed_peak_bytes NUMERIC(40,0) CHECK(observed_peak_bytes IS NULL OR observed_peak_bytes>=0),
 peak_bytes NUMERIC(40,0) NOT NULL CHECK(peak_bytes>=0),
 billable_bytes NUMERIC(40,0) NOT NULL CHECK(billable_bytes>=0),
 due_units NUMERIC(40,0) NOT NULL CHECK(due_units>=0),
 charged_units NUMERIC(40,0) NOT NULL CHECK(charged_units>=0 AND charged_units<=due_units),
 uncollected_units NUMERIC(40,0) NOT NULL CHECK(uncollected_units=due_units-charged_units),
 ledger_id UUID UNIQUE REFERENCES hosting_ledger(id),
 basis TEXT NOT NULL, evidence JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,hour),
 CHECK(date_trunc('hour',hour AT TIME ZONE 'UTC')=hour AT TIME ZONE 'UTC'),
 CHECK((charged_units>0)=(ledger_id IS NOT NULL))
);
ALTER TABLE hosting_ledger DROP CONSTRAINT IF EXISTS hosting_ledger_kind_check;
ALTER TABLE hosting_ledger ADD CONSTRAINT hosting_ledger_kind_check CHECK(kind IN ('welcome','usage','admin','stripe','promo_expiry','workspace_allocation','workspace_usage','lightning','refund','dispute','storage_peak'));
DROP TRIGGER IF EXISTS hosting_storage_boundary_immutable ON hosting_storage_boundaries;
CREATE TRIGGER hosting_storage_boundary_immutable BEFORE UPDATE OR DELETE ON hosting_storage_boundaries FOR EACH ROW EXECUTE FUNCTION hosting_storage_snapshot_immutable();
DROP TRIGGER IF EXISTS hosting_storage_anchor_immutable ON hosting_storage_anchors;
CREATE TRIGGER hosting_storage_anchor_immutable BEFORE UPDATE OR DELETE ON hosting_storage_anchors FOR EACH ROW EXECUTE FUNCTION hosting_storage_snapshot_immutable();
DROP TRIGGER IF EXISTS hosting_storage_hours_immutable ON hosting_storage_hours;
CREATE TRIGGER hosting_storage_hours_immutable BEFORE UPDATE OR DELETE ON hosting_storage_hours FOR EACH ROW EXECUTE FUNCTION hosting_storage_snapshot_immutable();

-- The legacy hourly audit may never charge a peak-enrolled workspace: the same cutover fence, extended to enrollment.
CREATE OR REPLACE FUNCTION hosting_v1_cutover_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM hosting_accounts WHERE id=NEW.account_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM hosting_workspace_wallets WHERE workspace_id=NEW.workspace_id AND NEW.hour>=enabled_at)
   OR EXISTS(SELECT 1 FROM hosting_storage_enrollments WHERE workspace_id=NEW.workspace_id) THEN
   RAISE EXCEPTION 'hosting_v1_workspace_cutover' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

-- Current total = latest anchor + deltas it did not see (MVCC snapshot test), clamped at zero by callers. NULL without an anchor.
CREATE OR REPLACE FUNCTION hosting_storage_estimate(ws UUID) RETURNS NUMERIC LANGUAGE sql STABLE AS $$
 SELECT a.total_bytes+COALESCE((SELECT sum(d.delta_bytes) FROM hosting_storage_deltas d
   WHERE d.workspace_id=ws AND d.xid>=pg_snapshot_xmin(a.snapshot) AND NOT pg_visible_in_snapshot(d.xid,a.snapshot)),0)
 FROM hosting_storage_anchors a WHERE a.workspace_id=ws ORDER BY a.taken_at DESC LIMIT 1
$$;
CREATE OR REPLACE FUNCTION hosting_storage_record(ws UUID, cat TEXT, delta BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE est NUMERIC;
BEGIN
 IF ws IS NULL OR delta=0 OR NOT EXISTS(SELECT 1 FROM hosting_storage_enrollments WHERE workspace_id=ws) THEN RETURN; END IF;
 -- Pre-image BEFORE the delta exists: the state this decrease is about to remove from.
 IF delta<0 THEN
  est:=hosting_storage_estimate(ws);
  IF est IS NOT NULL THEN INSERT INTO hosting_storage_observations(workspace_id,bytes,source) VALUES(ws,GREATEST(est,0),cat); END IF;
 END IF;
 INSERT INTO hosting_storage_deltas(workspace_id,category,delta_bytes) VALUES(ws,cat,delta);
END;
$$;
CREATE OR REPLACE FUNCTION hosting_storage_object_net(ws UUID, old_rows JSONB, new_ids UUID[], paths TEXT[]) RETURNS BIGINT LANGUAGE sql AS $$
 SELECT COALESCE(sum(COALESCE(a.sz,0)-COALESCE(b.sz,0)),0)::bigint
 FROM unnest(paths) AS p(path)
 LEFT JOIN LATERAL (SELECT min(o.size_bytes) AS sz FROM v4_storage_objects o
   WHERE o.pg_workspace_id=ws AND o.completed_at IS NOT NULL AND o.storage_path=p.path) a ON true
 LEFT JOIN LATERAL (SELECT min(u.sz) AS sz FROM (
   SELECT o.size_bytes AS sz FROM v4_storage_objects o
    WHERE o.pg_workspace_id=ws AND o.completed_at IS NOT NULL AND o.storage_path=p.path AND NOT (o.id=ANY(new_ids))
   UNION ALL SELECT (e->>'size')::bigint FROM jsonb_array_elements(old_rows) e WHERE e->>'path'=p.path) u) b ON true
$$;
`;

export const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export const bytesOf = (alias: string, columns: string[]) => columns.map(c => `COALESCE(pg_column_size(${alias}.${quote(c)}),0)::bigint`).join('+');

function trackerFunction(table: string, op: 'i' | 'd' | 'u', columns: string[], marker: string) {
  const parts: string[] = [];
  if (op !== 'd') parts.push(`SELECT n.workspace_id AS ws,${bytesOf('n', columns)} AS b FROM new_rows n`);
  if (op !== 'i') parts.push(`SELECT o.workspace_id AS ws,-(${bytesOf('o', columns)}) AS b FROM old_rows o`);
  const extra: string[] = [];
  if (table === 'managed_app_storage_objects' && ['state', 'size_bytes', 'physical_absent'].every(c => columns.includes(c))) {
    // S3 bytes of a verified managed object are billable until physical deletion is confirmed.
    const obj = (a: string) => `CASE WHEN ${a}.state='complete' AND NOT ${a}.physical_absent THEN ${a}.size_bytes ELSE 0 END`;
    if (op !== 'd') extra.push(`SELECT n.workspace_id AS ws,${obj('n')}::bigint AS b FROM new_rows n`);
    if (op !== 'i') extra.push(`SELECT o.workspace_id AS ws,-(${obj('o')})::bigint AS b FROM old_rows o`);
  }
  const loop = (selects: string[], category: string) => `
  FOR r IN SELECT x.ws,sum(x.b)::bigint AS net FROM (${selects.join(' UNION ALL ')}) x GROUP BY x.ws HAVING sum(x.b)<>0 LOOP
   PERFORM hosting_storage_record(r.ws,'${category}',r.net);
  END LOOP;`;
  return `CREATE OR REPLACE FUNCTION hst_${table}_${op}() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE r RECORD;
BEGIN
 -- ${marker}
 IF NOT EXISTS(SELECT 1 FROM hosting_storage_enrollments) THEN RETURN NULL; END IF;${loop(parts, 'postgres')}${extra.length ? loop(extra, 'objects') : ''}
 RETURN NULL;
END;
$fn$;`;
}

function objectTrackerFunction(op: 'i' | 'd' | 'u', marker: string) {
  const paths: string[] = [];
  const done = `o.completed_at IS NOT NULL AND o.pg_workspace_id IS NOT NULL`;
  if (op !== 'd') paths.push(`SELECT o.pg_workspace_id AS ws,o.storage_path AS path FROM new_rows o WHERE ${done}`);
  if (op !== 'i') paths.push(`SELECT o.pg_workspace_id AS ws,o.storage_path AS path FROM old_rows o WHERE ${done}`);
  const oldRows = op === 'i' ? `'[]'::jsonb` : `(SELECT COALESCE(jsonb_agg(jsonb_build_object('path',o.storage_path,'size',o.size_bytes)),'[]'::jsonb) FROM old_rows o WHERE o.pg_workspace_id=r.ws AND o.completed_at IS NOT NULL)`;
  const newIds = op === 'd' ? `'{}'::uuid[]` : `(SELECT COALESCE(array_agg(o.id),'{}'::uuid[]) FROM new_rows o WHERE o.pg_workspace_id=r.ws)`;
  return `CREATE OR REPLACE FUNCTION hst_v4_storage_objects_${op}() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE r RECORD; net BIGINT;
BEGIN
 -- ${marker}
 IF NOT EXISTS(SELECT 1 FROM hosting_storage_enrollments) THEN RETURN NULL; END IF;
 FOR r IN SELECT x.ws,array_agg(DISTINCT x.path) AS paths FROM (${paths.join(' UNION ALL ')}) x GROUP BY x.ws LOOP
  net:=hosting_storage_object_net(r.ws,${oldRows},${newIds},r.paths);
  PERFORM hosting_storage_record(r.ws,'objects',net);
 END LOOP;
 RETURN NULL;
END;
$fn$;`;
}

const triggerSql = (table: string) => [
  `CREATE OR REPLACE TRIGGER hosting_storage_track_i AFTER INSERT ON public.${quote(table)} REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION hst_${table}_i();`,
  `CREATE OR REPLACE TRIGGER hosting_storage_track_u AFTER UPDATE ON public.${quote(table)} REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION hst_${table}_u();`,
  `CREATE OR REPLACE TRIGGER hosting_storage_track_d AFTER DELETE ON public.${quote(table)} REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION hst_${table}_d();`,
].join('\n');

export type SqlLike = { unsafe: (query: string, params?: any[]) => PromiseLike<any[]> };
const OBJECT_MARKER = 'v4_storage_objects:peak-v1';
const colsMarker = (columns: string[]) => `cols:${createHash('sha256').update(columns.join(',')).digest('hex').slice(0, 16)}`;

export async function billableColumns(sql: SqlLike): Promise<Map<string, string[]>> {
  const rows = await sql.unsafe(`SELECT c.relname AS name,
     ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relispartition AND c.relname = ANY($1::text[])
     AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND a.atttypid='uuid'::regtype AND NOT a.attisdropped)`,
    [BILLABLE_STORAGE_TABLES as unknown as string[]]);
  return new Map(rows.map((r: any) => [r.name as string, r.columns as string[]]));
}

/** Installs the statement triggers. Rollout gate: only when the approved onboarding policy is enabled or an enrollment already
 * exists, so a deployment with the policy closed pays no write-path cost. Idempotent; regenerated on every start so a later
 * column addition is picked up. */
export async function installStorageTracking(sql: SqlLike, options: { force?: boolean } = {}) {
  const [{ enrolled }] = await sql.unsafe(`SELECT EXISTS(SELECT 1 FROM hosting_storage_enrollments) AS enrolled`) as any[];
  if (!options.force && process.env.ONBOARDING_ENABLED !== 'true' && !enrolled) return { installed: 0, skipped: true as const };
  const tables = await billableColumns(sql);
  let installed = 0;
  for (const [table, columns] of tables) {
    const marker = colsMarker(columns);
    await sql.unsafe([...(['i', 'u', 'd'] as const).map(op => trackerFunction(table, op, columns, marker)), triggerSql(table)].join('\n'));
    installed++;
  }
    await sql.unsafe([...(['i', 'u', 'd'] as const).map(op => objectTrackerFunction(op, OBJECT_MARKER)), triggerSql('v4_storage_objects')].join('\n'));
  return { installed: installed + 1, skipped: false as const };
}

/** Provisioning fails closed unless every billable table that exists carries current triggers. */
export async function missingStorageTracking(sql: SqlLike): Promise<string[]> {
  const tables = await billableColumns(sql);
  const have = await sql.unsafe(`SELECT c.relname AS name,array_agg(DISTINCT t.tgname) AS triggers,array_agg(p.prosrc) AS sources
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE NOT t.tgisinternal AND t.tgname LIKE 'hosting_storage_track_%' GROUP BY c.relname`) as any[];
  const byTable = new Map<string, { triggers: string[]; sources: string[] }>(have.map(r => [r.name, r]));
  const missing: string[] = [];
  const expected: [string, string][] = [...tables].map(([table, columns]) => [table, colsMarker(columns)]);
  expected.push(['v4_storage_objects', OBJECT_MARKER]);
  for (const [table, marker] of expected) {
    const row = byTable.get(table);
    if (!row || row.triggers.length !== 3 || row.sources.length !== 3 || !row.sources.every(s => s.includes(marker))) missing.push(table);
  }
  return missing;
}
