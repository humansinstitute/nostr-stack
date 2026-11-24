import type { Adapter } from './workspace-export-adapters';
import { OrgDataError, orgOperation } from './org-data';

/** Additional customer-content adapters. Each reads exactly what the existing route for that data lets the exporting member read, and nothing the
 * route would hide: rows a viewer cannot read are never delivered, counted or hinted. Registered-app and drive data stay owner-scoped. */
type Ctx = Parameters<NonNullable<Adapter['fetch']>>[0];
type Out = { k: string; row: any }[];
const SEP = '\u0001';
const pad = (n: unknown) => String(n).padStart(10, '0');

/** The napplet registry's list rule (owner, publisher or audience member; removed installations are not listed). Bound parameters: workspace, app, npub. */
const OPEN_INSTALLATION = `n.removed=false AND (n.owner_npub=$3 OR n.publisher_npub=$3 OR n.audience_npubs ? $3)`;
const JOIN_INSTALLATION = (alias: string) => `JOIN flightdeck_pg_napplets n ON n.workspace_id=${alias}.workspace_id AND n.app_npub=${alias}.app_npub AND n.napplet_id=${alias}.napplet_id`;
/** Collection rule: the owner, or a named reader or writer. */
const OPEN_COLLECTION = `(c.owner_npub=$3 OR c.read_npubs ? $3 OR c.write_npubs ? $3)`;
/** Record operations must be declared by the installation's manifest for that collection (the same gate the records/history routes apply). */
const DECLARES = (op: string) => `(n.manifest->'collections'->c.name->'operations') ? '${op}' AND n.manifest->'collections'->c.name->>'scope'=c.scope`;
const run = (ctx: Ctx, sql: string, params: unknown[]) => ctx.sql.unsafe(sql, params as any[]) as unknown as Promise<any[]>;
/** Keyset pages over a computed key: the inner query yields (k,row); ordering and the cursor comparison use byte order so cursors are stable. */
const keyed = (inner: string) => `SELECT q.k, q.row FROM (${inner}) q WHERE q.k COLLATE "C" > $4 COLLATE "C" ORDER BY q.k COLLATE "C" LIMIT $5`;
const base = (ctx: Ctx) => [ctx.viewer.workspaceId, ctx.viewer.appNpub, ctx.viewer.npub];

async function orgCatalogue(ctx: Ctx): Promise<any> {
  const [m] = await ctx.sql`SELECT role FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${ctx.viewer.workspaceId} AND actor_id=${ctx.viewer.actorId}`;
  try { return await orgOperation({ workspaceId: ctx.viewer.workspaceId, actorId: ctx.viewer.actorId, actorNpub: ctx.viewer.npub, appNpub: ctx.viewer.appNpub, role: String(m?.role ?? '') } as any, 'catalogue'); }
  catch (e) { if (e instanceof OrgDataError && [403, 404].includes(e.status)) return { bundles: [], installations: [] }; throw e; }
}

export const MORE_ADAPTERS: Adapter[] = [
  { table: 'flightdeck_pg_napplets', from: '', key: '', rule: 'custom', refs: () => [],
    fetch: async (ctx, last, limit): Promise<Out> => (await run(ctx, `SELECT n.napplet_id AS k, to_jsonb(n) AS row FROM flightdeck_pg_napplets n WHERE n.workspace_id=$1 AND n.app_npub=$2 AND ${OPEN_INSTALLATION} AND n.napplet_id COLLATE "C" > $4 COLLATE "C" ORDER BY n.napplet_id COLLATE "C" LIMIT $5`, [...base(ctx), last, limit])).map(r => ({ k: r.k, row: r.row })) },
  { table: 'flightdeck_pg_napplet_releases', from: '', key: '', rule: 'custom', refs: r => [{ f: 'table:flightdeck_pg_napplets', i: String(r.napplet_id) }],
    fetch: async (ctx, last, limit): Promise<Out> => (await run(ctx, keyed(`SELECT (r.napplet_id || chr(1) || lpad(r.revision::text,10,'0')) AS k, to_jsonb(r) AS row FROM flightdeck_pg_napplet_releases r ${JOIN_INSTALLATION('r')}
      WHERE r.workspace_id=$1 AND r.app_npub=$2 AND ${OPEN_INSTALLATION}`), [...base(ctx), last, limit])).map(r => ({ k: r.k, row: r.row })) },
  { table: 'flightdeck_pg_napplet_collections', from: '', key: '', rule: 'custom', refs: r => [{ f: 'table:flightdeck_pg_napplets', i: String(r.napplet_id) }],
    fetch: async (ctx, last, limit): Promise<Out> => (await run(ctx, `SELECT c.id::text AS k, to_jsonb(c) AS row FROM flightdeck_pg_napplet_collections c ${JOIN_INSTALLATION('c')}
      WHERE c.workspace_id=$1 AND c.app_npub=$2 AND ${OPEN_INSTALLATION} AND ${OPEN_COLLECTION} AND c.id::text > $4 ORDER BY c.id::text LIMIT $5`, [...base(ctx), last, limit])).map(r => ({ k: r.k, row: r.row })) },
  { table: 'flightdeck_pg_napplet_records', from: '', key: '', rule: 'custom', refs: r => [{ f: 'table:flightdeck_pg_napplet_collections', i: String(r.collection_id) }],
    fetch: async (ctx, last, limit): Promise<Out> => (await run(ctx, keyed(`SELECT (x.collection_id::text || chr(1) || x.id) AS k, to_jsonb(x) AS row FROM flightdeck_pg_napplet_records x
      JOIN flightdeck_pg_napplet_collections c ON c.id=x.collection_id ${JOIN_INSTALLATION('c')}
      WHERE c.workspace_id=$1 AND c.app_npub=$2 AND ${OPEN_INSTALLATION} AND ${OPEN_COLLECTION} AND ${DECLARES('list')} AND x.deleted=false`), [...base(ctx), last, limit])).map(r => ({ k: r.k, row: r.row })) },
  { table: 'flightdeck_pg_napplet_record_versions', from: '', key: '', rule: 'custom', refs: r => [{ f: 'table:flightdeck_pg_napplet_records', i: `${r.collection_id}${SEP}${r.id}` }],
    fetch: async (ctx, last, limit): Promise<Out> => (await run(ctx, keyed(`SELECT (v.collection_id::text || chr(1) || v.id || chr(1) || lpad(v.revision::text,10,'0')) AS k, to_jsonb(v) AS row FROM flightdeck_pg_napplet_record_versions v
      JOIN flightdeck_pg_napplet_records x ON x.collection_id=v.collection_id AND x.id=v.id AND x.deleted=false
      JOIN flightdeck_pg_napplet_collections c ON c.id=v.collection_id ${JOIN_INSTALLATION('c')}
      WHERE c.workspace_id=$1 AND c.app_npub=$2 AND ${OPEN_INSTALLATION} AND ${OPEN_COLLECTION} AND ${DECLARES('list')} AND ${DECLARES('get')}`), [...base(ctx), last, limit])).map(r => ({ k: r.k, row: r.row })) },
  // Organisation-data napplets are read through the org-data catalogue: installed bundles with their html for any org_data.read member, version metadata
  // for publishers and installers only. A published-but-uninstalled version's html has no read route, so it is not delivered.
  { table: 'flightdeck_pg_napplet_installations', from: '', key: '', rule: 'custom', refs: () => [],
    fetch: async (ctx, last, limit): Promise<Out> => ((await orgCatalogue(ctx)).installations as any[]).map(i => ({ k: String(i.key), row: i })).filter(r => r.k > last).sort((a, b) => (a.k < b.k ? -1 : 1)).slice(0, limit) },
  { table: 'flightdeck_pg_napplet_bundles', from: '', key: '', rule: 'custom', refs: () => [],
    fetch: async (ctx, last, limit): Promise<Out> => ((await orgCatalogue(ctx)).bundles as any[]).map(b => ({ k: `${b.key}${SEP}${pad(b.version)}`, row: b })).filter(r => r.k > last).sort((a, b) => (a.k < b.k ? -1 : 1)).slice(0, limit) },
  // The drive discovery rule (GET /drive/shares): enabled shares of current members, workspace-audience ones for everyone and private ones only for their owner.
  { table: 'flightdeck_pg_drive_shares', from: '', key: '', rule: 'custom', refs: () => [],
    fetch: async (ctx, last, limit): Promise<Out> => (await ctx.sql`SELECT s.id::text AS k, to_jsonb(s) || jsonb_build_object('owner_npub',a.npub) AS row FROM flightdeck_pg_drive_shares s
      JOIN flightdeck_pg_actors a ON a.id=s.owner_actor_id
      JOIN flightdeck_pg_workspace_memberships m ON m.workspace_id=s.workspace_id AND m.actor_id=s.owner_actor_id
      WHERE s.workspace_id=${ctx.viewer.workspaceId} AND s.enabled AND (s.audience='workspace' OR s.owner_actor_id=${ctx.viewer.actorId}) AND s.id::text > ${last} ORDER BY s.id::text LIMIT ${limit}`).map(r => ({ k: r.k as string, row: r.row })) },
  // Registered-app private objects are readable only through generic owner recovery (docs/contract/registered-app-storage-v1.md): the canonical
  // workspace owner receives completed objects; every other member receives nothing. Bytes are fetched, hashed and verified in the assets section.
  { table: 'flightdeck_pg_app_storage_objects', from: '', key: '', rule: 'custom', refs: () => [],
    fetch: async (ctx, last, limit): Promise<Out> => (await ctx.sql`SELECT t.storage_object_id::text AS k, to_jsonb(t) || jsonb_build_object('file_name',o.file_name,'content_type',o.content_type,'size_bytes',o.size_bytes,'sha256_hex',o.sha256_hex) AS row
      FROM flightdeck_pg_app_storage_objects t JOIN v4_storage_objects o ON o.id=t.storage_object_id JOIN flightdeck_pg_workspaces w ON w.id=t.workspace_id
      WHERE t.workspace_id=${ctx.viewer.workspaceId} AND w.workspace_owner_npub=${ctx.viewer.npub} AND o.completed_at IS NOT NULL AND o.owner_npub=w.workspace_owner_npub AND t.storage_object_id::text > ${last}
      ORDER BY t.storage_object_id::text LIMIT ${limit}`).map(r => ({ k: r.k as string, row: r.row })) },
];
