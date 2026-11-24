import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { HostingError } from './hosting-billing';
import { recordVisibility, type RecordEntry } from './flightdeck-record-visibility';
import { resolveReadablePrivateStorageObject } from './flightdeck-pg-storage-access';
import { getStorageObject, hashStorageBytes, statStorageBytes } from './storage';
import { exportCoverage } from './workspace-export-coverage';

type Db = ReturnType<typeof getDb>;
export const EXPORT_PAGE_ITEMS = 200;
export const EXPORT_PAGE_BYTES = 1_048_576;
export const EXPORT_ITEM_MAX_BYTES = 8_388_608;
export const EXPORT_ASSET_PAGE = 25;
export const EXPORT_MAX_OPEN_SESSIONS = 3;
/** Objects larger than this cannot be re-hashed inside a request; they are reported `unverified`, never assumed intact. */
export const EXPORT_ASSET_HASH_MAX_BYTES = 256 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECTIONS = ['records', 'history', 'assets'] as const;
const DONE = 'x-section-complete';
export type ExportSection = typeof SECTIONS[number];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const chainNext = (previous: string, pageDigest: string) => sha(`${previous}\n${pageDigest}`);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode<T>(cursor: string | null | undefined, check: (v: unknown) => v is T): T | null {
  if (!cursor) return null;
  try { const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); if (check(value)) return value; } catch { /* fall through */ }
  throw new HostingError(400, 'invalid_cursor');
}

type SectionState = { through: string | null; prev: string | null; items: number; bytes: number; chain: string; done: boolean };
type ExportState = { section: ExportSection | 'complete'; sections: Record<ExportSection, SectionState>; families: Record<string, number>; assetIssues: Record<string, number> };
const emptySection = (): SectionState => ({ through: null, prev: null, items: 0, bytes: 0, chain: sha('nstack-export-v1'), done: false });
const initialState = (): ExportState => ({ section: 'records', sections: { records: emptySection(), history: emptySection(), assets: emptySection() }, families: {}, assetIssues: {} });

/** Member viewer or a neutral refusal. The export only ever contains what this actor can currently read. */
async function viewerFor(workspaceId: string, actorNpub: string, sql: Db) {
  if (!UUID.test(workspaceId)) throw new HostingError(404, 'workspace_not_found');
  const [workspace] = await sql`SELECT id,app_npub,workspace_owner_npub FROM flightdeck_pg_workspaces WHERE id=${workspaceId}`;
  if (!workspace) throw new HostingError(404, 'workspace_not_found');
  const [viewer] = await sql`SELECT a.id AS actor_id,a.npub FROM flightdeck_pg_workspace_memberships m JOIN flightdeck_pg_actors a ON a.id=m.actor_id WHERE m.workspace_id=${workspaceId} AND a.npub=${actorNpub}`;
  if (!viewer) throw new HostingError(403, 'workspace_membership_required');
  return { workspace, actorId: viewer.actor_id as string, npub: viewer.npub as string };
}
async function clockOf(workspaceId: string, sql: Db) {
  const [clock] = await sql`INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(${workspaceId}) ON CONFLICT(workspace_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id
    RETURNING position::text,epoch,access_revision::text`;
  return clock!;
}
const progressView = (row: any) => ({
  export_id: row.id as string, workspace_id: row.workspace_id as string, section: (row.state as ExportState).section,
  as_of: { position: String(row.clock_position), epoch: row.clock_epoch as string, access_revision: String(row.access_revision) },
  started_at: new Date(row.started_at).toISOString(), expires_at: new Date(row.expires_at).toISOString(), finalized: row.finalized_at !== null,
  sections: Object.fromEntries(SECTIONS.map(s => [s, { items: (row.state as ExportState).sections[s].items, done: (row.state as ExportState).sections[s].done }])),
});

/** Pins the committed record clock and opens a bounded read-only session. No data is copied and nothing is written outside the session. */
export async function startWorkspaceExport(workspaceId: string, actorNpub: string, db: Db = getDb()) {
  return db.begin(async transaction => {
    const sql = transaction as unknown as Db;
    const viewer = await viewerFor(workspaceId, actorNpub, sql);
    await sql`DELETE FROM workspace_exports WHERE expires_at<now()`;
    await sql`SELECT id FROM flightdeck_pg_actors WHERE id=${viewer.actorId} FOR UPDATE`;
    const [{ open }] = await sql`SELECT count(*)::int AS open FROM workspace_exports WHERE workspace_id=${workspaceId} AND actor_id=${viewer.actorId} AND finalized_at IS NULL`;
    if (open >= EXPORT_MAX_OPEN_SESSIONS) throw new HostingError(429, 'too_many_open_exports');
    const clock = await clockOf(workspaceId, sql);
    const [row] = await sql`INSERT INTO workspace_exports(workspace_id,actor_id,clock_position,clock_epoch,access_revision,state)
      VALUES(${workspaceId},${viewer.actorId},${clock.position},${clock.epoch},${clock.access_revision},${sql.json(initialState() as any)}) RETURNING *`;
    return { ...progressView(row), scope: 'actor_visible' as const, bounds: { max_items: EXPORT_PAGE_ITEMS, max_bytes: EXPORT_PAGE_BYTES }, coverage: exportCoverage() };
  });
}

async function ownedSession(exportId: string, workspaceId: string, actorNpub: string, sql: Db, lock: boolean) {
  if (!UUID.test(exportId)) throw new HostingError(404, 'export_not_found');
  const [row] = lock
    ? await sql`SELECT e.* FROM workspace_exports e JOIN flightdeck_pg_actors a ON a.id=e.actor_id WHERE e.id=${exportId} AND e.workspace_id=${workspaceId} AND a.npub=${actorNpub} FOR UPDATE OF e`
    : await sql`SELECT e.* FROM workspace_exports e JOIN flightdeck_pg_actors a ON a.id=e.actor_id WHERE e.id=${exportId} AND e.workspace_id=${workspaceId} AND a.npub=${actorNpub}`;
  if (!row) throw new HostingError(404, 'export_not_found');
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new HostingError(410, 'export_expired');
  return row;
}
export async function readWorkspaceExportStatus(workspaceId: string, exportId: string, actorNpub: string, db: Db = getDb()) {
  await viewerFor(workspaceId, actorNpub, db);
  const row = await ownedSession(exportId, workspaceId, actorNpub, db, false);
  return { ...progressView(row), outcome: row.outcome ?? null };
}

type Page = { items: unknown[]; identities: string[]; bytes: number; next: string | null; keys: { family: string; id: string }[]; assets: { object_id: string; family: string; id: string; role: string }[];
  families?: Record<string, number>; assetIssues?: Record<string, number> };

const objectRefs = (family: string, id: string, row: any) => {
  const out: Page['assets'] = [];
  for (const role of ['storage_object_id', 'head_storage_object_id']) if (typeof row?.[role] === 'string' && UUID.test(row[role])) out.push({ object_id: row[role].toLowerCase(), family, id, role });
  if (Array.isArray(row?.metadata?.attachments)) for (const a of row.metadata.attachments) if (typeof a?.storage_object_id === 'string' && UUID.test(a.storage_object_id)) out.push({ object_id: a.storage_object_id.toLowerCase(), family, id, role: 'attachment' });
  return out;
};

async function recordsPage(exportId: string, workspaceId: string, viewer: Awaited<ReturnType<typeof viewerFor>>, cursor: string | null, limit: number, sql: Db): Promise<Page> {
  const at = decode(cursor, (v): v is [string, string] => Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'string')) ?? ['', ''];
  const scanned = await sql<(RecordEntry & { context: any })[]>`SELECT family,id,position::text,bytes,context AS row FROM flightdeck_pg_record_current
    WHERE workspace_id=${workspaceId} AND (family,id)>(${at[0]},${at[1]}) ORDER BY family,id LIMIT ${limit + 1}`;
  const visible = recordVisibility(workspaceId, viewer.actorId, { npub: viewer.npub, app_npub: viewer.workspace.app_npub }, sql);
  const page: Page = { items: [], identities: [], bytes: 0, next: null, keys: [], assets: [], families: {} };
  const window = scanned.slice(0, limit);
  let last: [string, string] | null = null, processed = 0;
  for (const entry of window) {
    if (await visible({ ...entry, operation: 'upsert' })) {
      if (entry.bytes > EXPORT_ITEM_MAX_BYTES) throw new HostingError(413, 'export_item_too_large');
      if (page.items.length && page.bytes + entry.bytes > EXPORT_PAGE_BYTES) break;
      const [payload] = await sql`SELECT row FROM flightdeck_pg_record_current WHERE workspace_id=${workspaceId} AND family=${entry.family} AND id=${entry.id}`;
      if (payload) { // a row deleted since the scan is not delivered; the clock comparison at finalize reports the write
        page.items.push({ kind: 'record', family: entry.family, id: entry.id, position: entry.position, row: payload.row });
        page.identities.push(`record:${entry.family}:${entry.id}:${entry.position}`);
        page.bytes += entry.bytes; page.keys.push({ family: entry.family, id: entry.id });
        page.families![entry.family] = (page.families![entry.family] ?? 0) + 1;
        page.assets.push(...objectRefs(entry.family, entry.id, payload.row));
      }
    }
    processed++; last = [entry.family, entry.id];
  }
  page.next = scanned.length <= limit && processed === window.length ? null : encode(last);
  return page;
}

const HISTORY = [
  { kind: 'doc_version', table: 'flightdeck_pg_doc_versions', parent: 'doc', parentKey: 'doc_id', order: 'v.doc_id::text, v.row_version', keyset: 'v.doc_id::text, v.row_version', key: (r: any) => [String(r.doc_id), String(r.row_version)] },
  { kind: 'doc_recovery_version', table: 'flightdeck_pg_doc_recovery_versions', parent: 'doc', parentKey: 'doc_id', order: 'v.id::text', keyset: 'v.id::text, 0', key: (r: any) => [String(r.id), '0'] },
  { kind: 'file_version', table: 'flightdeck_pg_file_versions', parent: 'file', parentKey: 'file_id', order: 'v.file_id::text, v.version_number', keyset: 'v.file_id::text, v.version_number', key: (r: any) => [String(r.file_id), String(r.version_number)] },
  { kind: 'daily_note_version', table: 'flightdeck_pg_daily_note_versions', parent: 'daily_note', parentKey: 'daily_note_id', order: 'v.daily_note_id::text, v.row_version', keyset: 'v.daily_note_id::text, v.row_version', key: (r: any) => [String(r.daily_note_id), String(r.row_version)] },
];
/** Retained history of every exported parent, with the parent's own authority (the parent was filtered in the records section). */
async function historyPage(exportId: string, workspaceId: string, viewer: Awaited<ReturnType<typeof viewerFor>>, cursor: string | null, limit: number, sql: Db): Promise<Page> {
  let [t, a, b] = decode(cursor, (v): v is [number, string, string] => Array.isArray(v) && v.length === 3 && Number.isInteger(v[0]) && v[0] >= 0 && v[0] < HISTORY.length && typeof v[1] === 'string' && typeof v[2] === 'string') ?? [0, '', '-1'];
  const visible = recordVisibility(workspaceId, viewer.actorId, { npub: viewer.npub, app_npub: viewer.workspace.app_npub }, sql);
  for (; t < HISTORY.length; t++, a = '', b = '-1') {
    const h = HISTORY[t]!;
    const rows = await sql.unsafe(`SELECT to_jsonb(v) AS row, octet_length(to_jsonb(v)::text) AS bytes FROM ${h.table} v
      JOIN workspace_export_keys k ON k.export_id=$1 AND k.family=$2 AND k.id=v.${h.parentKey}::text
      WHERE v.workspace_id=$3 AND (${h.keyset}) > ($4::text, $5::int) ORDER BY ${h.order} LIMIT ${limit + 1}`, [exportId, h.parent, workspaceId, a, Number(b)]) as { row: any; bytes: number }[];
    if (!rows.length) continue;
    // The keys prove the parent was readable earlier. Authority is re-evaluated for every parent on every page, so history of a
    // resource the member can no longer read (or that no longer exists) is never delivered.
    const window = rows.slice(0, limit);
    const parentIds = [...new Set(window.map(r => String(r.row[h.parentKey])))];
    const parents = await sql<(RecordEntry & { id: string })[]>`SELECT family,id,position::text,bytes,context AS row FROM flightdeck_pg_record_current
      WHERE workspace_id=${workspaceId} AND family=${h.parent} AND id=ANY(${parentIds}::text[])`;
    const allowed = new Set<string>();
    for (const p of parents) if (await visible({ ...p, operation: 'upsert' })) allowed.add(p.id);
    const page: Page = { items: [], identities: [], bytes: 0, next: null, keys: [], assets: [] };
    let last: string[] | null = null, processed = 0;
    for (const r of window) {
      const key = h.key(r.row);
      if (allowed.has(String(r.row[h.parentKey]))) {
        if (Number(r.bytes) > EXPORT_ITEM_MAX_BYTES) throw new HostingError(413, 'export_item_too_large');
        if (page.items.length && page.bytes + Number(r.bytes) > EXPORT_PAGE_BYTES) break;
        page.items.push({ kind: h.kind, row: r.row });
        page.identities.push(`${h.kind}:${key.join(':')}`);
        page.bytes += Number(r.bytes);
        page.assets.push(...objectRefs(h.kind, key.join(':'), r.row));
      }
      processed++; last = key;
    }
    page.next = rows.length > processed ? encode([t, ...last!]) : t < HISTORY.length - 1 ? encode([t + 1, '', '-1']) : null;
    return page;
  }
  return { items: [], identities: [], bytes: 0, next: null, keys: [], assets: [] };
}

/** One object's verified status. Never writes; the byte identity is re-derived from the stored bytes when not already pinned. */
export async function checkExportAsset(objectId: string, workspaceOwnerNpub: string, actorNpub: string) {
  const row = await getStorageObject(objectId);
  const base = { object_id: objectId, content_path: `/api/v4/storage/${objectId}/content` };
  if (!row) return { ...base, status: 'missing_metadata', size_bytes: null, sha256_hex: null, content_type: null, file_name: null };
  const meta = { ...base, size_bytes: Number(row.size_bytes), content_type: row.content_type, file_name: row.file_name };
  if (row.owner_npub !== workspaceOwnerNpub) return { ...meta, status: 'workspace_mismatch', sha256_hex: null };
  if (!row.completed_at) return { ...meta, status: 'upload_incomplete', sha256_hex: null };
  if (!await resolveReadablePrivateStorageObject(objectId, actorNpub)) return { ...meta, status: 'not_readable', sha256_hex: null };
  const stat = await statStorageBytes(row);
  if (!stat) return { ...meta, status: 'missing_bytes', sha256_hex: null };
  if (Number(row.size_bytes) !== stat.size) return { ...meta, status: 'size_mismatch', sha256_hex: null };
  if (row.sha256_hex && row.sha256_verified_etag === stat.etag) return { ...meta, status: 'verified', sha256_hex: row.sha256_hex };
  const identity = stat.size > EXPORT_ASSET_HASH_MAX_BYTES ? null : await hashStorageBytes(row, EXPORT_ASSET_HASH_MAX_BYTES);
  if (!identity) return { ...meta, status: 'unverified', sha256_hex: null };
  if (row.sha256_hex && row.sha256_hex !== identity.sha256) return { ...meta, status: 'hash_mismatch', sha256_hex: null };
  return { ...meta, status: 'verified', sha256_hex: identity.sha256 };
}
async function assetsPage(exportId: string, viewer: Awaited<ReturnType<typeof viewerFor>>, cursor: string | null, sql: Db): Promise<Page> {
  const after = decode(cursor, (v): v is string => typeof v === 'string' && UUID.test(v)) ?? '00000000-0000-0000-0000-000000000000';
  const rows = await sql`SELECT object_id::text AS object_id,count(*)::int AS reference_count,
      (array_agg(jsonb_build_object('family',ref_family,'id',ref_id,'role',role) ORDER BY ref_family,ref_id,role))[1:20] AS references
    FROM workspace_export_assets WHERE export_id=${exportId} AND object_id>${after}::uuid GROUP BY object_id ORDER BY object_id LIMIT ${EXPORT_ASSET_PAGE + 1}`;
  const page: Page = { items: [], identities: [], bytes: 0, next: null, keys: [], assets: [], assetIssues: {} };
  for (const r of rows.slice(0, EXPORT_ASSET_PAGE)) {
    const checked = await checkExportAsset(r.object_id, viewer.workspace.workspace_owner_npub, viewer.npub);
    page.items.push({ kind: 'asset', ...checked, reference_count: r.reference_count, references: r.references });
    page.identities.push(`asset:${r.object_id}:${checked.status}:${checked.sha256_hex ?? ''}`);
    page.bytes += Number(checked.size_bytes ?? 0);
    if (checked.status !== 'verified') page.assetIssues![checked.status] = (page.assetIssues![checked.status] ?? 0) + 1;
  }
  page.next = rows.length > EXPORT_ASSET_PAGE ? encode(rows[EXPORT_ASSET_PAGE - 1]!.object_id) : null;
  return page;
}

/** Takes the workspace clock's share lock (so no authority change can commit while this page is built) and fails closed, before any
 * data is read, if the authority the session was pinned to has changed. A revoked channel or membership change therefore ends the
 * session: an earlier cursor is never a capability, replay included. */
async function assertAuthorityUnchanged(session: any, workspaceId: string, sql: Db) {
  const [clock] = await sql`SELECT epoch,access_revision::text AS access_revision FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId} FOR SHARE`;
  if (!clock || clock.epoch !== session.clock_epoch || String(clock.access_revision) !== String(session.access_revision)) throw new HostingError(409, 'export_invalidated');
}
export async function readWorkspaceExportPage(workspaceId: string, exportId: string, actorNpub: string, input: { section: unknown; cursor?: string | null; limit?: unknown }, db: Db = getDb()) {
  if (typeof input.section !== 'string' || !(SECTIONS as readonly string[]).includes(input.section)) throw new HostingError(400, 'invalid_section');
  const section = input.section as ExportSection;
  const limit = input.limit === undefined || input.limit === null ? EXPORT_PAGE_ITEMS : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_PAGE_ITEMS) throw new HostingError(400, 'invalid_limit');
  const cursor = input.cursor ? String(input.cursor) : null;
  return db.begin(async transaction => {
    const sql = transaction as unknown as Db;
    const viewer = await viewerFor(workspaceId, actorNpub, sql);
    const row = await ownedSession(exportId, workspaceId, actorNpub, sql, true);
    if (row.finalized_at) throw new HostingError(409, 'export_finalized');
    await assertAuthorityUnchanged(row, workspaceId, sql);
    const state = row.state as ExportState;
    const mine = state.sections[section];
    const firstOpen = SECTIONS.findIndex(s => !state.sections[s].done);
    if (SECTIONS.indexOf(section) > (firstOpen === -1 ? SECTIONS.length : firstOpen)) throw new HostingError(409, 'section_out_of_order');
    if (mine.done && cursor === mine.through) throw new HostingError(409, 'section_complete');
    const advancing = cursor === mine.through;
    const replaying = !advancing && mine.through !== null && cursor === mine.prev;
    if (!advancing && !replaying) throw new HostingError(409, 'cursor_invalid');
    const page = section === 'records' ? await recordsPage(exportId, workspaceId, viewer, cursor, limit, sql)
      : section === 'history' ? await historyPage(exportId, workspaceId, viewer, cursor, limit, sql)
      : await assetsPage(exportId, viewer, cursor, sql);
    if (page.keys.length) await sql`INSERT INTO workspace_export_keys(export_id,workspace_id,family,id) SELECT ${exportId},${workspaceId},f,i FROM unnest(${page.keys.map(k => k.family)}::text[],${page.keys.map(k => k.id)}::text[]) AS t(f,i) ON CONFLICT DO NOTHING`;
    if (page.assets.length) await sql`INSERT INTO workspace_export_assets(export_id,workspace_id,object_id,ref_family,ref_id,role)
      SELECT ${exportId},${workspaceId},o,f,i,r FROM unnest(${page.assets.map(a => a.object_id)}::uuid[],${page.assets.map(a => a.family)}::text[],${page.assets.map(a => a.id)}::text[],${page.assets.map(a => a.role)}::text[]) AS t(o,f,i,r) ON CONFLICT DO NOTHING`;
    const pageDigest = sha(page.identities.join('\n'));
    if (advancing) {
      // `through` is the cursor that fetches the next page; `prev` the one just delivered (replayable). A finished section has no next cursor.
      state.sections[section] = { through: page.next ?? DONE, prev: cursor, items: mine.items + page.items.length, bytes: mine.bytes + page.bytes, chain: chainNext(mine.chain, pageDigest), done: page.next === null };
      for (const [family, n] of Object.entries(page.families ?? {})) state.families[family] = (state.families[family] ?? 0) + n;
      for (const [status, n] of Object.entries(page.assetIssues ?? {})) state.assetIssues[status] = (state.assetIssues[status] ?? 0) + n;
      state.section = SECTIONS.find(s => !state.sections[s].done) ?? 'complete';
      await sql`UPDATE workspace_exports SET state=${sql.json(state as any)} WHERE id=${exportId}`;
    }
    const now = state.sections[section];
    return { export_id: exportId, section, items: page.items, next_cursor: page.next, section_complete: page.next === null,
      page: { count: page.items.length, digest: pageDigest }, progress: { items: now.items, chain: now.chain } };
  });
}

/** Relationship edges between exported records: a visible child whose parent was not delivered is a broken relationship. */
const EDGES: [string, string, string][] = [
  ['channel', 'scope_id', 'scope'], ['thread', 'channel_id', 'channel'], ['message', 'channel_id', 'channel'], ['message', 'thread_id', 'thread'],
  ['task', 'channel_id', 'channel'], ['task_comment', 'task_id', 'task'], ['task_assignment', 'task_id', 'task'], ['doc', 'channel_id', 'channel'],
  ['doc_comment', 'doc_id', 'doc'], ['file', 'channel_id', 'channel'], ['file', 'folder_id', 'file_folder'], ['file_folder', 'channel_id', 'channel'],
  ['file_folder', 'parent_folder_id', 'file_folder'], ['audio_note', 'channel_id', 'channel'], ['context_component', 'scope_id', 'scope'], ['context_reference', 'scope_id', 'scope'],
];
async function danglingEdges(exportId: string, workspaceId: string, sql: Db) {
  const out: { child: string; field: string; parent: string; count: number; sample: string[] }[] = [];
  for (const [child, field, parent] of EDGES) {
    const [r] = await sql`SELECT count(*)::int AS n,(array_agg(c.id ORDER BY c.id))[1:5] AS sample FROM workspace_export_keys k
      JOIN flightdeck_pg_record_current c ON c.workspace_id=${workspaceId} AND c.family=k.family AND c.id=k.id
      WHERE k.export_id=${exportId} AND k.family=${child} AND c.row->>${field} IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM workspace_export_keys p WHERE p.export_id=k.export_id AND p.family=${parent} AND p.id=c.row->>${field})`;
    if (r!.n > 0) out.push({ child, field, parent, count: r!.n, sample: r!.sample });
  }
  return out;
}

/** Closes the session and returns the completeness manifest. 200 only when nothing is missing; otherwise 409 `export_incomplete`
 * carries the same manifest. It never reports a partial export as a backup. */
export async function finalizeWorkspaceExport(workspaceId: string, exportId: string, actorNpub: string, db: Db = getDb()) {
  return db.begin(async transaction => {
    const sql = transaction as unknown as Db;
    await viewerFor(workspaceId, actorNpub, sql);
    const row = await ownedSession(exportId, workspaceId, actorNpub, sql, true);
    if (row.finalized_at) return { manifest: row.outcome, complete: row.outcome.status === 'complete' };
    const state = row.state as ExportState;
    if (SECTIONS.some(s => !state.sections[s].done)) throw new HostingError(409, 'export_not_traversed');
    const clock = await clockOf(workspaceId, sql);
    const authorityChanged = clock.epoch !== row.clock_epoch || String(clock.access_revision) !== String(row.access_revision);
    const consistent = String(clock.position) === String(row.clock_position) && !authorityChanged;
    const dangling = await danglingEdges(exportId, workspaceId, sql);
    const coverage = exportCoverage();
    const assetIssueCount = Object.values(state.assetIssues).reduce((a, b) => a + b, 0);
    const reasons = [
      ...(authorityChanged ? ['access_changed'] : []),
      ...(consistent || authorityChanged ? [] : ['writes_during_export']),
      ...(dangling.length ? ['dangling_relationships'] : []),
      ...(assetIssueCount ? ['asset_issues'] : []),
      ...(coverage.uncovered_required.length ? ['uncovered_content'] : []),
    ];
    const manifest = {
      version: 1 as const, export_id: exportId, workspace_id: workspaceId, scope: 'actor_visible' as const,
      as_of: { position: String(row.clock_position), epoch: row.clock_epoch as string, access_revision: String(row.access_revision) },
      finalized_at: new Date().toISOString(),
      sections: Object.fromEntries(SECTIONS.map(s => [s, { items: state.sections[s].items, bytes: state.sections[s].bytes, chain: state.sections[s].chain }])),
      record_families: state.families,
      integrity: { consistent, dangling_relationships: dangling, asset_issues: state.assetIssues, exported_scope_complete: reasons.every(r => r === 'uncovered_content') },
      coverage,
      status: reasons.length ? 'incomplete' as const : 'complete' as const,
      incomplete_reasons: reasons,
    };
    await sql`UPDATE workspace_exports SET finalized_at=now(),outcome=${sql.json(manifest as any)} WHERE id=${exportId}`;
    await sql`DELETE FROM workspace_export_keys WHERE export_id=${exportId}`;
    await sql`DELETE FROM workspace_export_assets WHERE export_id=${exportId}`;
    return { manifest, complete: manifest.status === 'complete' };
  });
}
