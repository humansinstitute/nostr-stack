import { createHash } from 'crypto';
import { getDb } from '../db';
import { AppDbError } from './app-db';
import { authorizeFlightDeckPgOperation, resolveFlightDeckPgWorkspace } from './flightdeck-pg-authorization';
import type { AppDbNativeBatch, AppDbNativePolicy, AppDbNativeQuery } from '../types';

type Db = ReturnType<typeof getDb>;
export type NativeContext = { owner: string; app: string; workspace: string; actor: string };
const fail = (code: string, status = 400): never => { throw new AppDbError(code, status, code); };
export function nativeIdentifier(value: string) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value) || value === 'schema_migrations') fail('bad_identifier');
  return `"${value}"`;
}
function uuid(value: string) { if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) fail('bad_uuid'); return value; }
export function nativeDigest(value: unknown): string {
  function canonical(v: any): any { return Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export async function nativeAuthority(ctx: NativeContext, channel: string | null, write: boolean, sql: Db) {
  uuid(ctx.workspace);
  const workspace = await resolveFlightDeckPgWorkspace(ctx.workspace, sql);
  if (!workspace || workspace.workspace_owner_npub !== ctx.owner || workspace.app_npub !== ctx.app) fail('workspace_binding_mismatch', 403);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: ctx.actor, appNpub: ctx.app, workspaceId: ctx.workspace,
    permission: channel === null ? 'workspace.manage' : write ? 'file.write' : 'file.read',
    resource: channel === null ? { type: 'workspace' } : { type: 'channel', channelId: uuid(channel) } }, sql);
  if (!decision.allowed) fail('permission_denied', 403);
}
async function namespace(ctx: NativeContext, sql: Db) {
  const [row] = await sql`SELECT n.schema_name FROM workspace_app_db_namespaces n JOIN workspace_apps a USING(workspace_owner_npub,app_npub)
    WHERE n.workspace_owner_npub=${ctx.owner} AND n.app_npub=${ctx.app} AND a.enabled=true`;
  if (!row) fail('namespace_not_available', 404);
  return nativeIdentifier(row.schema_name);
}
async function lock(ctx: NativeContext, sql: Db) {
  // One namespace lock orders policy deployment, batches and coherent paged reads.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.owner + ':' + ctx.app}, 0))`;
  // Revocation cannot race a permission check and commit. Same order everywhere.
  await sql.unsafe(`LOCK TABLE flightdeck_pg_workspaces, flightdeck_pg_actors, flightdeck_pg_workspace_memberships,
    flightdeck_pg_channels, flightdeck_pg_scopes, flightdeck_pg_permission_grants,
    flightdeck_pg_group_memberships, flightdeck_pg_group_edges, workspace_apps IN SHARE MODE`);
}
export async function registerNativePolicy(ctx: NativeContext, table: string, policy: AppDbNativePolicy) {
  nativeIdentifier(table);
  return getDb().begin(async tx => {
    const sql = tx as unknown as Db;
    await lock(ctx, sql); await nativeAuthority(ctx, null, true, sql);
    const schema = await namespace(ctx, sql);
    if (!policy || policy.version !== 1 || !Array.isArray(policy.columns) || policy.columns.length < 1 || policy.columns.length > 96) fail('bad_policy');
    if (Object.keys(policy).some(k=>!['version','columns','parent','append_only','manager_only_writes','managed_content_type'].includes(k)) || (policy.append_only!==undefined && typeof policy.append_only!=='boolean') || (policy.manager_only_writes!==undefined && typeof policy.manager_only_writes!=='boolean') || (policy.managed_content_type!==undefined && (typeof policy.managed_content_type!=='string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(policy.managed_content_type)))) fail('bad_policy');
    const immutable = new Set(['id','workspace_id','channel_id','revision']);
    for (const col of policy.columns) { nativeIdentifier(col); if (immutable.has(col)) fail('reserved_column'); }
    if (new Set(policy.columns).size !== policy.columns.length) fail('duplicate_column');
    const columns = await sql`SELECT column_name,data_type,is_nullable FROM information_schema.columns
      WHERE table_schema=${schema.slice(1,-1)} AND table_name=${table}`;
    for (const [name,type] of [['id','text'],['workspace_id','uuid'],['channel_id','uuid'],['revision','bigint']]) {
      if (!columns.some(c => c.column_name===name && c.data_type===type && c.is_nullable==='NO')) fail('policy_scope_columns_required');
    }
    if (policy.columns.some(name => !columns.some(c => c.column_name===name))) fail('policy_column_missing');
    const indexes = await sql`SELECT pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=${schema.slice(1,-1)} AND t.relname=${table} AND i.indisvalid AND i.indisready AND i.indpred IS NULL`;
    if (!indexes.some(i => i.definition.includes('(workspace_id, channel_id, id COLLATE "C")'))) fail('scope_keyset_index_required');
    const constraints = await sql`SELECT c.contype,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=${schema.slice(1,-1)} AND t.relname=${table}`;
    if (!constraints.some(c => c.contype==='p' && c.definition==='PRIMARY KEY (id)')) fail('id_primary_key_required');
    if (policy.parent) {
      nativeIdentifier(policy.parent.table); nativeIdentifier(policy.parent.column);
      if (!policy.columns.includes(policy.parent.column)) fail('parent_column_required');
      const [parent] = await sql`SELECT definition FROM app_db_native_policies WHERE workspace_owner_npub=${ctx.owner}
        AND app_npub=${ctx.app} AND workspace_id=${ctx.workspace} AND table_name=${policy.parent.table}`;
      if (!parent) fail('parent_policy_required');
      if (parent.definition.managed_content_type!==policy.managed_content_type) fail('parent_authority_mismatch');
      // PostgreSQL enforces child scope even for trusted app migration/admin paths.
      const expected = `FOREIGN KEY (${policy.parent.column}, workspace_id, channel_id) REFERENCES `;
      if (!constraints.some(c => c.contype==='f' && c.definition.startsWith(expected) &&
        c.definition.includes(`${schema.slice(1,-1)}.${policy.parent!.table}(id, workspace_id, channel_id)`) && !c.definition.includes('DEFERRABLE') && !/ON (DELETE|UPDATE) (CASCADE|SET)/.test(c.definition))) fail('scoped_parent_fk_required');
    }
    const [existing] = await sql`SELECT definition FROM app_db_native_policies WHERE workspace_owner_npub=${ctx.owner} AND app_npub=${ctx.app}
      AND workspace_id=${ctx.workspace} AND table_name=${table}`;
    if (existing && nativeDigest(existing.definition)!==nativeDigest(policy)) fail('policy_conflict',409);
    const [generation] = await sql`SELECT COALESCE(max(generation),0)::text AS value FROM app_db_native_policies WHERE workspace_owner_npub=${ctx.owner} AND app_npub=${ctx.app} AND workspace_id=${ctx.workspace}`;
    await sql`INSERT INTO app_db_native_policies(workspace_owner_npub,app_npub,workspace_id,table_name,definition,generation)
      VALUES(${ctx.owner},${ctx.app},${ctx.workspace},${table},${sql.json(policy as any)},${generation.value}) ON CONFLICT DO NOTHING`;
    await sql.unsafe(`DROP TRIGGER IF EXISTS nstack_native_write_guard ON ${schema}.${nativeIdentifier(table)}`);
    await sql.unsafe(`CREATE TRIGGER nstack_native_write_guard BEFORE INSERT OR UPDATE OR DELETE ON ${schema}.${nativeIdentifier(table)} FOR EACH ROW EXECUTE FUNCTION public.app_db_native_write_guard()`);
    return { version: 1, table, policy };
  });
}
async function policies(ctx: NativeContext, sql: Db) {
  return sql`SELECT table_name,definition,generation::text FROM app_db_native_policies
    WHERE workspace_owner_npub=${ctx.owner} AND app_npub=${ctx.app} AND workspace_id=${ctx.workspace} ORDER BY table_name`;
}
function allowedPolicy(rows: any[], table: string): AppDbNativePolicy {
  nativeIdentifier(table); const row = rows.find(p => p.table_name===table);
  if (!row) fail('table_policy_required',403); return row.definition;
}
function dataValues(data: Record<string, unknown>, policy: AppDbNativePolicy, sql: Db) {
  if (!data || Array.isArray(data) || typeof data!=='object' || !Object.keys(data).length) fail('bad_data');
  for (const key of Object.keys(data)) if (!policy.columns.includes(key)) fail('column_forbidden',403);
  return Object.entries(data).map(([k,v]) => [nativeIdentifier(k), v && typeof v==='object' ? sql.json(v as any) : v] as const);
}
export async function nativeBatch(ctx: NativeContext, body: AppDbNativeBatch) {
  if (!body || body.version!==1 || !Array.isArray(body.operations) || !body.operations.length || body.operations.length>3000 || JSON.stringify(body).length>4_000_000) fail('bad_batch');
  uuid(body.operation_id); uuid(body.channel_id);
  return getDb().begin(async tx => {
    const sql = tx as unknown as Db;
    await lock(ctx, sql); await nativeAuthority(ctx, body.channel_id, true, sql);
    await sql.unsafe('SET LOCAL statement_timeout = 30000');
    const schema = await namespace(ctx, sql); const ps = await policies(ctx, sql);
    if (body.staging===true) await nativeAuthority(ctx,null,true,sql);
    const digest = nativeDigest(body);
    const [receipt] = await sql`SELECT *,result::text AS result_text FROM app_db_native_receipts WHERE workspace_owner_npub=${ctx.owner} AND app_npub=${ctx.app}
      AND workspace_id=${ctx.workspace} AND operation_id=${body.operation_id}`;
    if (receipt) {
      if (receipt.actor_npub!==ctx.actor || receipt.channel_id!==body.channel_id || receipt.digest!==digest) fail('operation_conflict',409);
      return JSON.parse(receipt.result_text);
    }
    await sql`SELECT set_config('nstack.native_write','on',true)`;
    const results = [];
    let resultBytes = 0;
    for (const op of body.operations) {
      const policy = allowedPolicy(ps, op.table); const table = `${schema}.${nativeIdentifier(op.table)}`;
      if (typeof op.id!=='string' || !op.id.length || op.id.length>256) fail('bad_id');
      if (op.kind!=='insert' && op.kind!=='update' && op.kind!=='delete') fail('bad_operation');
      if (policy.manager_only_writes) await nativeAuthority(ctx,null,true,sql);
      if (policy.append_only && op.kind!=='insert') fail('append_only',403);
      await managedAuthority(ctx,body.channel_id,policy,body.staging===true,sql,true);
      if (op.kind!=='insert' && (!Number.isSafeInteger(op.expected_revision) || op.expected_revision!<1)) fail('expected_revision_required');
      let rows;
      if (policy.parent) {
        const [current] = op.kind==='insert' ? [] : await sql.unsafe(`SELECT ${nativeIdentifier(policy.parent.column)} AS parent_id FROM ${table} WHERE id=$1 AND workspace_id=$2 AND channel_id=$3`,[op.id,ctx.workspace,body.channel_id]);
        const parentId = op.kind==='insert' ? op.data?.[policy.parent.column] : current?.parent_id;
        if (!body.operations.some(p=>p.table===policy.parent!.table && p.id===parentId && (p.kind==='insert' || p.kind==='update'))) fail('parent_cas_required',409);
      }
      if (op.kind==='insert') {
        const entries = dataValues(op.data!,policy,sql);
        rows = await sql.unsafe(`INSERT INTO ${table} AS target (id,workspace_id,channel_id,revision,${entries.map(e=>e[0]).join(',')}) VALUES ($1,$2,$3,1,${entries.map((_,i)=>'$'+(i+4)).join(',')}) RETURNING (to_jsonb(target) || jsonb_build_object('revision',target.revision::text))::text AS row_json`,[op.id,ctx.workspace,body.channel_id,...entries.map(e=>e[1])] as any[]);
      } else {
        const params: any[] = [op.id,ctx.workspace,body.channel_id,op.expected_revision];
        let statement = `DELETE FROM ${table} AS target`;
        if (op.kind==='update') {
          const entries = dataValues(op.data!,policy,sql);
          if (policy.parent && Object.hasOwn(op.data!,policy.parent.column)) fail('immutable_parent',403);
          params.push(...entries.map(e=>e[1]));
          statement = `UPDATE ${table} AS target SET revision=revision+1,${entries.map((e,i)=>e[0]+'=$'+(i+5)).join(',')}`;
        }
        rows = await sql.unsafe(`${statement} WHERE id=$1 AND workspace_id=$2 AND channel_id=$3 AND revision=$4 RETURNING (to_jsonb(target) || jsonb_build_object('revision',target.revision::text))::text AS row_json`,params);
      }
      if (rows.length!==1) fail('row_conflict',409);
      const row = JSON.parse(rows[0].row_json);
      resultBytes += Buffer.byteLength(rows[0].row_json);
      if (resultBytes>8_000_000) fail('result_too_large',413);
      results.push({ table:op.table,kind:op.kind,row });
    }
    const [g] = await sql`UPDATE app_db_native_policies SET generation=generation+1 WHERE workspace_owner_npub=${ctx.owner}
      AND app_npub=${ctx.app} AND workspace_id=${ctx.workspace} RETURNING generation::text`;
    const result = { version:1,operation_id:body.operation_id,generation:g.generation,results };
    await sql`INSERT INTO app_db_native_receipts(workspace_owner_npub,app_npub,workspace_id,channel_id,actor_npub,operation_id,digest,result)
      VALUES(${ctx.owner},${ctx.app},${ctx.workspace},${body.channel_id},${ctx.actor},${body.operation_id},${digest},${sql.json(result as any)})`;
    return result;
  });
}
export async function nativeQuery(ctx: NativeContext, table: string, body: AppDbNativeQuery) {
  if (!body || body.version!==1 || !Number.isSafeInteger(body.limit) || body.limit<1 || body.limit>200) fail('bad_query');
  return getDb().begin(async tx => {
    const sql = tx as unknown as Db;
    await lock(ctx,sql); await nativeAuthority(ctx,body.channel_id,false,sql);
    const schema = await namespace(ctx,sql); const ps = await policies(ctx,sql); const policy = allowedPolicy(ps,table);
    await managedAuthority(ctx,body.channel_id,policy,body.staging===true,sql);
    const generation = ps.find(p=>p.table_name===table)!.generation;
    if (body.generation!==undefined && body.generation!==generation) fail('snapshot_changed',409);
    if (body.after!==undefined && (typeof body.after!=='string' || body.generation===undefined)) fail('generation_required');
    const rows = await sql.unsafe(`SELECT row::text AS row_json FROM (
      SELECT row,sum(octet_length(row::text)) OVER(ORDER BY (row->>'id') COLLATE "C") AS bytes FROM (
        SELECT to_jsonb(t) || jsonb_build_object('revision',t.revision::text) AS row FROM ${schema}.${nativeIdentifier(table)} t
        WHERE workspace_id=$1 AND channel_id=$2 AND id COLLATE "C">$3 ORDER BY id COLLATE "C" LIMIT $4
      ) candidate
    ) bounded WHERE bytes<=4000000 ORDER BY (row->>'id') COLLATE "C"`,[ctx.workspace,body.channel_id,body.after??'',body.limit+1]);
    const page = rows.slice(0,body.limit).map(r=>JSON.parse(r.row_json));
    let more = rows.length>body.limit;
    // Size-limited pages may be shorter than the requested count.
    if (!more) {
      const [remaining] = await sql.unsafe(`SELECT EXISTS(SELECT 1 FROM ${schema}.${nativeIdentifier(table)} WHERE workspace_id=$1 AND channel_id=$2 AND id COLLATE "C">$3) AS present`,[ctx.workspace,body.channel_id,page.at(-1)?.id??body.after??'']);
      more = remaining.present;
      if (more && !page.length) fail('row_too_large',413);
    }
    return { version:1,generation,rows:page,has_more:more,next_after:more?page.at(-1)!.id:null };
  });
}
export async function nativeFence(ctx: NativeContext, body: { channel_id:string;content_type:string;active:boolean;expected_revision:number }) {
  if (!body || typeof body.content_type!=='string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(body.content_type) || typeof body.active!=='boolean' || !Number.isSafeInteger(body.expected_revision)) fail('bad_fence');
  return getDb().begin(async tx => {
    const sql = tx as unknown as Db;
    await lock(ctx,sql); await nativeAuthority(ctx,null,true,sql); await nativeAuthority(ctx,body.channel_id,true,sql); await namespace(ctx,sql);
    await sql.unsafe('LOCK TABLE flightdeck_pg_files,flightdeck_pg_file_versions,v4_storage_objects IN SHARE ROW EXCLUSIVE MODE');
    if (!body.active) {
      const [active] = await sql`SELECT 1 FROM app_db_native_authorities WHERE workspace_id=${ctx.workspace} AND channel_id=${body.channel_id} AND content_type=${body.content_type} AND mode='active'`;
      if (active) fail('freeze_required',409);
    }
    const [old] = await sql`SELECT * FROM app_db_content_fences WHERE workspace_id=${ctx.workspace} AND channel_id=${body.channel_id} AND content_type=${body.content_type}`;
    if (Number(old?.revision??0)!==body.expected_revision) fail('fence_conflict',409);
    const [fence] = await sql`INSERT INTO app_db_content_fences(workspace_id,channel_id,content_type,active)
      VALUES(${ctx.workspace},${body.channel_id},${body.content_type},${body.active}) ON CONFLICT(workspace_id,channel_id,content_type)
      DO UPDATE SET active=EXCLUDED.active,revision=app_db_content_fences.revision+1 RETURNING *`;
    return {version:1,fence};
  });
}
async function managedAuthority(ctx: NativeContext, channel: string, policy: AppDbNativePolicy, staging: boolean, sql: Db, write = false) {
  if (staging) await nativeAuthority(ctx,null,true,sql);
  if (!policy.managed_content_type) return;
  const [row] = await sql`SELECT mode FROM app_db_native_authorities WHERE workspace_owner_npub=${ctx.owner} AND app_npub=${ctx.app}
    AND workspace_id=${ctx.workspace} AND channel_id=${channel} AND content_type=${policy.managed_content_type}`;
  if (!row || (staging ? (write ? row.mode!=='staging' : !['staging','frozen'].includes(row.mode)) : row.mode!=='active')) fail('authority_unavailable',409);
}
export async function nativeStatus(ctx: NativeContext, body: {channel_id:string;content_type:string}) {
  return getDb().begin(async tx => {
    const sql = tx as unknown as Db; await lock(ctx,sql); await nativeAuthority(ctx,body.channel_id,false,sql); await namespace(ctx,sql);
    const [authority] = await sql`SELECT content_type,mode,revision::text FROM app_db_native_authorities WHERE workspace_owner_npub=${ctx.owner} AND app_npub=${ctx.app}
      AND workspace_id=${ctx.workspace} AND channel_id=${body.channel_id} AND content_type=${body.content_type}`;
    const [fence]=await sql`SELECT content_type,active,revision::text FROM app_db_content_fences WHERE workspace_id=${ctx.workspace} AND channel_id=${body.channel_id} AND content_type=${body.content_type}`;
    const [state]=await sql`SELECT COALESCE(max(generation),0)::text AS generation FROM app_db_native_policies WHERE workspace_owner_npub=${ctx.owner} AND app_npub=${ctx.app} AND workspace_id=${ctx.workspace}`;
    return {version:1,authority:authority??null,fence:fence??null,generation:state.generation,limits:{max_operations:3000,max_bytes:4_000_000,max_query_limit:200}};
  });
}
export async function nativeSetAuthority(ctx: NativeContext, body: {channel_id:string;content_type:string;mode:string;expected_revision:number;expected_generation?:string;expected_fence_revision?:string|number}) {
  if (!body || !['staging','active','frozen'].includes(body.mode) || typeof body.content_type!=='string' || !body.content_type.length || !Number.isSafeInteger(body.expected_revision)) fail('bad_authority');
  return getDb().begin(async tx => {
    const sql = tx as unknown as Db; await lock(ctx,sql); await nativeAuthority(ctx,null,true,sql); await nativeAuthority(ctx,body.channel_id,true,sql); await namespace(ctx,sql);
    const [old] = await sql`SELECT * FROM app_db_native_authorities WHERE workspace_owner_npub=${ctx.owner} AND app_npub=${ctx.app}
      AND workspace_id=${ctx.workspace} AND channel_id=${body.channel_id} AND content_type=${body.content_type}`;
    if (Number(old?.revision??0)!==body.expected_revision) fail('authority_conflict',409);
    if (old?.mode==='active' && body.mode==='staging') fail('freeze_required',409);
    if (body.mode==='active') {
      await sql.unsafe('LOCK TABLE flightdeck_pg_files,flightdeck_pg_file_versions,v4_storage_objects IN SHARE ROW EXCLUSIVE MODE');
      const [fence] = await sql`SELECT active,revision::text FROM app_db_content_fences WHERE workspace_id=${ctx.workspace} AND channel_id=${body.channel_id} AND content_type=${body.content_type}`;
      if (!fence?.active) fail('source_fence_required',409);
      if (String(body.expected_fence_revision)!==fence.revision) fail('fence_conflict',409);
      const [state]=await sql`SELECT COALESCE(max(generation),0)::text AS generation FROM app_db_native_policies WHERE workspace_owner_npub=${ctx.owner} AND app_npub=${ctx.app} AND workspace_id=${ctx.workspace}`;
      if (body.expected_generation!==state.generation) fail('snapshot_changed',409);
    }
    const [authority] = await sql`INSERT INTO app_db_native_authorities(workspace_owner_npub,app_npub,workspace_id,channel_id,content_type,mode)
      VALUES(${ctx.owner},${ctx.app},${ctx.workspace},${body.channel_id},${body.content_type},${body.mode})
      ON CONFLICT(workspace_owner_npub,app_npub,workspace_id,channel_id,content_type) DO UPDATE SET mode=EXCLUDED.mode,revision=app_db_native_authorities.revision+1 RETURNING content_type,mode,revision::text`;
    await sql`UPDATE app_db_native_policies SET generation=generation+1 WHERE workspace_owner_npub=${ctx.owner} AND app_npub=${ctx.app} AND workspace_id=${ctx.workspace}`;
    return {version:1,authority};
  });
}

// Resolve stable app row identity without requiring a historical File projection.
// The stored channel determines authorization; no caller-supplied scope is trusted.
export async function nativeRead(ctx: NativeContext, body: {version:1;table:string;id:string;staging?:boolean}) {
  if (!body || body.version!==1 || typeof body.id!=='string' || !body.id.length || body.id.length>256) fail('bad_read');
  return getDb().begin(async tx=>{
    const sql=tx as unknown as Db;await lock(ctx,sql);
    const workspace=await resolveFlightDeckPgWorkspace(ctx.workspace,sql);
    if (!workspace || workspace.workspace_owner_npub!==ctx.owner || workspace.app_npub!==ctx.app) fail('workspace_binding_mismatch',403);
    const schema=await namespace(ctx,sql),ps=await policies(ctx,sql),policy=allowedPolicy(ps,body.table);
    const [found]=await sql.unsafe(`SELECT (to_jsonb(t)||jsonb_build_object('revision',t.revision::text))::text AS row_json FROM ${schema}.${nativeIdentifier(body.table)} t WHERE workspace_id=$1 AND id=$2`,[ctx.workspace,body.id]);
    if (!found) fail('row_not_found',404);
    found.row = JSON.parse(found.row_json);
    await nativeAuthority(ctx,found.row.channel_id,false,sql);await managedAuthority(ctx,found.row.channel_id,policy,body.staging===true,sql);
    if (Buffer.byteLength(JSON.stringify(found.row))>4_000_000) fail('row_too_large',413);
    return {version:1,generation:ps.find(p=>p.table_name===body.table)!.generation,channel_id:found.row.channel_id,row:found.row};
  });
}
