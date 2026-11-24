import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { HostingError, lockedAccount } from './hosting-billing';
import { registerFundingReserve } from './hosting-funding';
import { accountStorageSummary } from './hosting-storage';

type Db = ReturnType<typeof getDb>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALL = /^[A-Za-z0-9_.:-]{1,128}$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const MAX_RATE = 10n ** 18n, MAX_TOKENS = 10n ** 12n, MAX_UNITS = 10n ** 18n;
const OPEN = ['held', 'dispatched', 'pending_reconcile'];
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const bad = (code: string) => new HostingError(400, code);

export const agentHoldsEnabled = () => process.env.HOSTING_AGENT_HOLDS_ENABLED === 'true';
function requireEnabled() { if (!agentHoldsEnabled()) throw new HostingError(503, 'agent_holds_disabled'); }
const list = (name: string) => new Set(String(process.env[name] ?? '').split(',').map(s => s.trim()).filter(Boolean));
export const agentHoldServices = () => list('HOSTING_AGENT_HOLD_SERVICES');
const rejectionAllowlist = () => list('HOSTING_AGENT_REJECTION_ALLOWLIST');
const reconcileDays = () => { const n = Number(process.env.HOSTING_AGENT_RECONCILE_DAYS); return Number.isInteger(n) && n > 0 && n <= 365 ? n : 7; };

/** Exact pico-USD to ledger units: 144e9 units/USD over 1e12 pico/USD is 18/125; always rounded up. */
export const picoToUnits = (pico: bigint) => (pico * 18n + 124n) / 125n;

function exact(body: any, required: string[], optional: string[] = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('invalid_body');
  for (const k of Object.keys(body)) if (!required.includes(k) && !optional.includes(k)) throw bad('invalid_body');
  for (const k of required) if (!(k in body)) throw bad('invalid_body');
}
function dec(v: unknown, max: bigint, code: string, min = 0n) {
  if (typeof v !== 'string' || !DEC.test(v) || v.length > 40) throw bad(code);
  const n = BigInt(v);
  if (n > max || n < min) throw bad(code);
  return n;
}
function str(v: unknown, max: number, code: string, re?: RegExp) {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || (re && !re.test(v))) throw bad(code);
  return v;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as any).sort().map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const day = (d: Date) => d.toISOString().slice(0, 10);
const NPUB = /^npub1[02-9ac-hj-np-z]{58}$/;

/* ------------------------------------------------------------------ tariffs (operator) */
export async function appendAgentTariff(admin: string, body: any, db: Db = getDb()) {
  requireEnabled();
  exact(body, ['version', 'models']);
  const version = str(body.version, 64, 'invalid_tariff', /^[A-Za-z0-9._-]+$/);
  if (!Array.isArray(body.models) || body.models.length < 1 || body.models.length > 100) throw bad('invalid_tariff');
  const models = body.models.map((m: any) => {
    exact(m, ['model', 'input_pico_per_token', 'output_pico_per_token', 'max_input_tokens', 'max_output_tokens'], ['cached_input_pico_per_token', 'cached_input_semantics', 'request_pico']);
    if (('cached_input_pico_per_token' in m) !== ('cached_input_semantics' in m)) throw bad('invalid_tariff');
    if ('cached_input_semantics' in m && !['subset', 'additional'].includes(m.cached_input_semantics)) throw bad('invalid_tariff');
    return {
      model: str(m.model, 200, 'invalid_tariff'), input: dec(m.input_pico_per_token, MAX_RATE, 'invalid_tariff'), output: dec(m.output_pico_per_token, MAX_RATE, 'invalid_tariff'),
      cached: 'cached_input_pico_per_token' in m ? dec(m.cached_input_pico_per_token, MAX_RATE, 'invalid_tariff') : null,
      semantics: (m.cached_input_semantics as string | undefined) ?? null, request: 'request_pico' in m ? dec(m.request_pico, MAX_RATE, 'invalid_tariff') : 0n,
      maxIn: dec(m.max_input_tokens, MAX_TOKENS, 'invalid_tariff', 1n), maxOut: dec(m.max_output_tokens, MAX_TOKENS, 'invalid_tariff', 1n),
    };
  });
  if (new Set(models.map((m: any) => m.model)).size !== models.length) throw bad('invalid_tariff');
  const digest = sha(canonical({ version, models: models.map((m: any) => ({ ...m, input: String(m.input), output: String(m.output), cached: m.cached === null ? null : String(m.cached), request: String(m.request), maxIn: String(m.maxIn), maxOut: String(m.maxOut) })).sort((a: any, b: any) => a.model < b.model ? -1 : 1) }));
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    await sql`SELECT pg_advisory_xact_lock(hashtext('hosting-agent-tariffs'))`;
    const [prior] = await sql`SELECT * FROM hosting_agent_tariffs WHERE version=${version}`;
    if (prior) { if (prior.content_sha256 !== digest) throw new HostingError(409, 'tariff_conflict'); return { version, content_sha256: digest, created: false }; }
    await sql`INSERT INTO hosting_agent_tariffs(version,content_sha256,created_by) VALUES(${version},${digest},${admin})`;
    for (const m of models) await sql`INSERT INTO hosting_agent_tariff_models(version,model,input_pico,output_pico,cached_input_pico,cached_input_semantics,request_pico,max_input_tokens,max_output_tokens)
      VALUES(${version},${m.model},${m.input.toString()},${m.output.toString()},${m.cached === null ? null : m.cached.toString()},${m.semantics},${m.request.toString()},${m.maxIn.toString()},${m.maxOut.toString()})`;
    return { version, content_sha256: digest, created: true };
  });
}
export async function listAgentTariffs(db: Db = getDb()) {
  const rows = await db`SELECT t.version,t.content_sha256,t.created_at,m.* FROM hosting_agent_tariffs t JOIN hosting_agent_tariff_models m USING(version) ORDER BY t.created_at,m.model`;
  const out = new Map<string, any>();
  for (const r of rows) {
    const t = out.get(r.version as string) ?? { version: r.version, content_sha256: r.content_sha256, created_at: r.created_at, models: [] as any[] };
    t.models.push({ model: r.model, input_pico_per_token: String(r.input_pico), output_pico_per_token: String(r.output_pico), cached_input_pico_per_token: r.cached_input_pico === null ? null : String(r.cached_input_pico),
      cached_input_semantics: r.cached_input_semantics, request_pico: String(r.request_pico), max_input_tokens: String(r.max_input_tokens), max_output_tokens: String(r.max_output_tokens) });
    out.set(r.version as string, t);
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ grants (payer) */
const grantView = (g: any, used?: bigint) => ({
  id: g.id as string, account_id: g.account_id as string, workspace_id: g.workspace_id as string, agent_npub: g.agent_npub as string, service_npub: g.service_npub as string,
  model: g.model as string, tariff_version: g.tariff_version as string, daily_cap_units: String(g.daily_cap_units), expires_at: new Date(g.expires_at).toISOString(),
  revoked_at: g.revoked_at ? new Date(g.revoked_at).toISOString() : null, created_at: new Date(g.created_at).toISOString(),
  ...(used === undefined ? {} : { day_used_units: used.toString() }),
});
async function dayUsed(sql: Db, grantId: string, d: string): Promise<bigint> {
  const [r] = await sql`SELECT COALESCE(sum(CASE state WHEN 'settled' THEN settled_units WHEN 'released' THEN 0 ELSE reserved_units END),0)::text AS used FROM hosting_agent_holds WHERE grant_id=${grantId} AND reserve_day=${d}`;
  return BigInt(r!.used as string);
}
async function payerAccount(sql: Db, payerNpub: string) {
  const [row] = await sql`SELECT a.* FROM hosting_accounts a JOIN flightdeck_pg_actors p ON p.id=a.owner_actor_id WHERE p.npub=${payerNpub}`;
  if (!row) throw new HostingError(403, 'agent_grant_forbidden');
  return row;
}
export async function createAgentGrant(payerNpub: string, body: any, clock: () => Date = () => new Date(), db: Db = getDb()) {
  requireEnabled();
  exact(body, ['idempotency_key', 'workspace_id', 'agent_npub', 'service_npub', 'model', 'tariff_version', 'daily_cap_units', 'expires_at']);
  const key = str(body.idempotency_key, 100, 'invalid_idempotency_key', /^[A-Za-z0-9_.:-]+$/);
  if (typeof body.workspace_id !== 'string' || !UUID.test(body.workspace_id)) throw bad('invalid_workspace');
  const agent = str(body.agent_npub, 70, 'invalid_agent', NPUB), service = str(body.service_npub, 70, 'invalid_service', NPUB);
  const model = str(body.model, 200, 'invalid_model'), tariff = str(body.tariff_version, 64, 'invalid_tariff');
  const cap = dec(body.daily_cap_units, MAX_UNITS, 'invalid_daily_cap', 1n);
  const expires = new Date(String(body.expires_at));
  const now = clock();
  if (typeof body.expires_at !== 'string' || Number.isNaN(expires.getTime()) || expires <= now || expires.getTime() - now.getTime() > 366 * 86_400_000) throw bad('invalid_expiry');
  const digest = sha(canonical({ w: body.workspace_id, agent, service, model, tariff, cap: cap.toString(), exp: expires.toISOString() }));
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    const account = await payerAccount(sql, payerNpub);
    await lockedAccount(account.id, sql, now);
    const [prior] = await sql`SELECT * FROM hosting_agent_grants WHERE account_id=${account.id} AND idempotency_key=${key}`;
    if (prior) { if (prior.request_sha256 !== digest) throw new HostingError(409, 'idempotency_conflict'); return { grant: grantView(prior), replayed: true }; }
    if (!agentHoldServices().has(service)) throw new HostingError(403, 'agent_service_not_allowed');
    const [ws] = await sql`SELECT w.workspace_owner_npub FROM hosting_storage_enrollments e JOIN flightdeck_pg_workspaces w ON w.id=e.workspace_id WHERE e.workspace_id=${body.workspace_id} AND e.account_id=${account.id} AND e.activated_at IS NOT NULL`;
    if (!ws || ws.workspace_owner_npub !== payerNpub) throw new HostingError(403, 'agent_grant_forbidden');
    const [member] = await sql`SELECT 1 FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id=a.id WHERE a.npub=${agent} AND a.kind='agent' AND m.workspace_id=${body.workspace_id}`;
    if (!member) throw new HostingError(422, 'agent_not_in_workspace');
    const [priced] = await sql`SELECT 1 FROM hosting_agent_tariff_models WHERE version=${tariff} AND model=${model}`;
    if (!priced) throw new HostingError(422, 'model_not_priced');
    const [row] = await sql`INSERT INTO hosting_agent_grants(account_id,workspace_id,payer_npub,agent_npub,service_npub,model,tariff_version,daily_cap_units,expires_at,idempotency_key,request_sha256)
      VALUES(${account.id},${body.workspace_id},${payerNpub},${agent},${service},${model},${tariff},${cap.toString()},${expires},${key},${digest}) RETURNING *`;
    return { grant: grantView(row!), replayed: false };
  });
}
export async function revokeAgentGrant(payerNpub: string, grantId: string, db: Db = getDb()) {
  requireEnabled();
  if (!UUID.test(grantId)) throw new HostingError(404, 'grant_not_found');
  const [row] = await db`UPDATE hosting_agent_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${grantId} AND payer_npub=${payerNpub} RETURNING *`;
  if (!row) throw new HostingError(404, 'grant_not_found');
  return { grant: grantView(row) };
}
export async function listAgentGrants(payerNpub: string, clock: () => Date = () => new Date(), db: Db = getDb()) {
  requireEnabled();
  const rows = await db`SELECT * FROM hosting_agent_grants WHERE payer_npub=${payerNpub} ORDER BY created_at DESC LIMIT 100`;
  const d = day(clock());
  return Promise.all(rows.map(async g => grantView(g, await dayUsed(db, g.id as string, d))));
}

/* ------------------------------------------------------------------ holds (runtime service) */
function requireService(signer: string) {
  requireEnabled();
  if (!agentHoldServices().has(signer)) throw new HostingError(403, 'agent_service_not_allowed');
}
const holdView = (h: any) => ({
  hold_id: h.id as string, account_id: h.account_id as string, call_id: h.call_id as string, grant_id: h.grant_id as string, state: h.state as string,
  model: h.model as string, tariff_version: h.tariff_version as string, reserved_units: String(h.reserved_units), reserved_at: new Date(h.reserved_at).toISOString(),
  reconcile_by: new Date(h.reconcile_by).toISOString(), day: typeof h.reserve_day === 'string' ? h.reserve_day : new Date(h.reserve_day).toISOString().slice(0, 10),
  settled_units: h.settled_units === null ? null : String(h.settled_units), overrun_units: String(h.overrun_units),
  release_basis: (h.release_basis as string | null) ?? null, pending_reason: (h.pending_reason as string | null) ?? null,
});
async function lockedHold(sql: Db, signer: string, body: any) {
  const accountId = body.account_id;
  if (typeof accountId !== 'string' || !UUID.test(accountId)) throw bad('invalid_account');
  let hold: any;
  if (typeof body.hold_id === 'string') {
    if (!UUID.test(body.hold_id)) throw new HostingError(404, 'hold_not_found');
    [hold] = await sql`SELECT * FROM hosting_agent_holds WHERE id=${body.hold_id} AND account_id=${accountId}`;
  } else {
    str(body.call_id, 128, 'invalid_call_id', CALL);
    [hold] = await sql`SELECT * FROM hosting_agent_holds WHERE account_id=${accountId} AND call_id=${body.call_id}`;
  }
  // Another runtime's hold is indistinguishable from a missing one.
  if (!hold || hold.service_npub !== signer) throw new HostingError(404, 'hold_not_found');
  return hold;
}
const identity = ['account_id', 'call_id'];
const accountOf = (body: any) => { if (typeof body.account_id !== 'string' || !UUID.test(body.account_id)) throw bad('invalid_account'); return body.account_id as string; };

export async function reserveAgentHold(signer: string, body: any, clock: () => Date = () => new Date(), db: Db = getDb()) {
  requireService(signer);
  exact(body, ['account_id', 'call_id', 'grant_id', 'workspace_id', 'agent_npub', 'model', 'tariff_version', 'max_input_tokens', 'max_output_tokens'], ['max_cached_input_tokens', 'run_id']);
  if (typeof body.account_id !== 'string' || !UUID.test(body.account_id)) throw bad('invalid_account');
  if (typeof body.grant_id !== 'string' || !UUID.test(body.grant_id)) throw bad('invalid_grant');
  if (typeof body.workspace_id !== 'string' || !UUID.test(body.workspace_id)) throw bad('invalid_workspace');
  const callId = str(body.call_id, 128, 'invalid_call_id', CALL), model = str(body.model, 200, 'invalid_model'), tariff = str(body.tariff_version, 64, 'invalid_tariff');
  const agent = str(body.agent_npub, 70, 'invalid_agent', NPUB);
  const maxIn = dec(body.max_input_tokens, MAX_TOKENS, 'invalid_tokens'), maxOut = dec(body.max_output_tokens, MAX_TOKENS, 'invalid_tokens');
  const maxCached = 'max_cached_input_tokens' in body ? dec(body.max_cached_input_tokens, MAX_TOKENS, 'invalid_tokens') : 0n;
  const runId = 'run_id' in body ? str(body.run_id, 128, 'invalid_run_id') : null;
  const digest = sha(canonical({ a: body.account_id, c: callId, g: body.grant_id, w: body.workspace_id, ag: agent, m: model, t: tariff, i: maxIn.toString(), o: maxOut.toString(), ci: maxCached.toString(), r: runId }));
  const now = clock();
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    await lockedAccount(body.account_id, sql, now);
    const [prior] = await sql`SELECT * FROM hosting_agent_holds WHERE account_id=${body.account_id} AND call_id=${callId}`;
    if (prior) {
      if (prior.request_sha256 !== digest || prior.service_npub !== signer) throw new HostingError(409, 'idempotency_conflict');
      return { hold: holdView(prior), replayed: true };
    }
    const [grant] = await sql`SELECT * FROM hosting_agent_grants WHERE id=${body.grant_id}`;
    if (!grant || grant.account_id !== body.account_id || grant.service_npub !== signer || grant.revoked_at || new Date(grant.expires_at) <= now
      || grant.workspace_id !== body.workspace_id || grant.agent_npub !== agent || grant.model !== model || grant.tariff_version !== tariff) throw new HostingError(403, 'agent_grant_required');
    if (!agentHoldServices().has(grant.service_npub as string)) throw new HostingError(403, 'agent_service_not_allowed');
    // Authority is re-derived from current ownership: a transferred or deactivated workspace stops spending immediately.
    const [ws] = await sql`SELECT w.workspace_owner_npub FROM hosting_storage_enrollments e JOIN flightdeck_pg_workspaces w ON w.id=e.workspace_id WHERE e.workspace_id=${grant.workspace_id} AND e.account_id=${body.account_id} AND e.activated_at IS NOT NULL`;
    if (!ws || ws.workspace_owner_npub !== grant.payer_npub) throw new HostingError(403, 'agent_grant_required');
    const [block] = await sql`SELECT 1 FROM hosting_agent_spend_blocks WHERE account_id=${body.account_id} AND cleared_at IS NULL LIMIT 1`;
    if (block) throw new HostingError(409, 'agent_spend_blocked');
    const [rate] = await sql`SELECT * FROM hosting_agent_tariff_models WHERE version=${tariff} AND model=${model}`;
    if (!rate) throw new HostingError(422, 'model_not_priced');
    if (maxIn > BigInt(rate.max_input_tokens) || maxOut > BigInt(rate.max_output_tokens) || maxCached > (rate.cached_input_semantics === 'additional' ? BigInt(rate.max_input_tokens) : maxIn)) throw new HostingError(422, 'token_bound_exceeded');
    if (maxCached > 0n && rate.cached_input_pico === null) throw new HostingError(422, 'cached_rate_unsupported');
    // Worst case: every input token at the dearer applicable rate; `additional` cached tokens come on top of input.
    const inR = BigInt(rate.input_pico), cR = rate.cached_input_pico === null ? 0n : BigInt(rate.cached_input_pico);
    const inputPico = rate.cached_input_semantics === 'additional' ? maxIn * inR + maxCached * cR : maxIn * (inR > cR ? inR : cR);
    const reserve = picoToUnits(inputPico + maxOut * BigInt(rate.output_pico) + BigInt(rate.request_pico));
    if (reserve <= 0n) throw new HostingError(422, 'model_not_priced');
    const summary = await accountStorageSummary(sql, body.account_id, now);
    if (!summary.admission.agent_spend_allowed) {
      const r = summary.admission.reason;
      throw r === 'storage_coverage_incomplete' ? new HostingError(503, 'storage_coverage_incomplete')
        : r === 'storage_measurement_unavailable' ? new HostingError(503, 'storage_reserve_unavailable') : new HostingError(402, 'agent_funds_insufficient');
    }
    // Admission must not depend on the reserve source being registered: when it is not, open holds are subtracted here.
    const held = await agentHoldUnits(sql, body.account_id);
    const available = BigInt(summary.balances.agent_available_units);
    const net = summary.balances.agent_holds.registered ? available : available > held ? available - held : 0n;
    if (net < reserve) throw new HostingError(402, 'agent_funds_insufficient');
    const d = day(now);
    if (await dayUsed(sql, grant.id as string, d) + reserve > BigInt(grant.daily_cap_units)) throw new HostingError(409, 'daily_cap_exceeded');
    const reconcileBy = new Date(now.getTime() + reconcileDays() * 86_400_000);
    const [row] = await sql`INSERT INTO hosting_agent_holds(account_id,call_id,grant_id,workspace_id,agent_npub,service_npub,model,tariff_version,run_id,request_sha256,state,reserved_units,reserve_day,reserved_at,reconcile_by)
      VALUES(${body.account_id},${callId},${grant.id},${grant.workspace_id},${agent},${signer},${model},${tariff},${runId},${digest},'held',${reserve.toString()},${d},${now},${reconcileBy}) RETURNING *`;
    return { hold: holdView(row!), replayed: false };
  });
}

export async function dispatchAgentHold(signer: string, body: any, clock: () => Date = () => new Date(), db: Db = getDb()) {
  requireService(signer);
  exact(body, identity);
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    await lockedAccount(accountOf(body), sql, clock());
    const hold = await lockedHold(sql, signer, body);
    if (hold.state === 'dispatched' || hold.state === 'pending_reconcile') return { hold: holdView(hold) };
    if (hold.state !== 'held') throw new HostingError(409, 'hold_final');
    const [row] = await sql`UPDATE hosting_agent_holds SET state='dispatched',dispatched_at=${clock()} WHERE id=${hold.id} RETURNING *`;
    return { hold: holdView(row!) };
  });
}

export async function markAgentHoldPending(signer: string, body: any, clock: () => Date = () => new Date(), db: Db = getDb()) {
  requireService(signer);
  exact(body, [...identity, 'reason']);
  const reason = str(body.reason, 300, 'invalid_reason');
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    await lockedAccount(accountOf(body), sql, clock());
    const hold = await lockedHold(sql, signer, body);
    if (hold.state === 'pending_reconcile') return { hold: holdView(hold) };
    if (!['held', 'dispatched'].includes(hold.state)) throw new HostingError(409, 'hold_final');
    const [row] = await sql`UPDATE hosting_agent_holds SET state='pending_reconcile',pending_at=${clock()},pending_reason=${reason} WHERE id=${hold.id} RETURNING *`;
    return { hold: holdView(row!) };
  });
}

export async function releaseAgentHold(signer: string, body: any, clock: () => Date = () => new Date(), db: Db = getDb()) {
  requireService(signer);
  exact(body, [...identity, 'basis'], ['evidence']);
  if (!['never_dispatched', 'provider_rejection'].includes(body.basis)) throw bad('invalid_basis');
  let evidence: Record<string, string> | null = null;
  if (body.basis === 'provider_rejection') {
    const ev = body.evidence;
    exact(ev, ['provider', 'http_status', 'error_code'], ['request_id']);
    const status = typeof ev.http_status === 'number' ? String(ev.http_status) : ev.http_status;
    if (typeof status !== 'string' || !/^[1-5][0-9]{2}$/.test(status)) throw bad('invalid_evidence');
    evidence = { provider: str(ev.provider, 64, 'invalid_evidence', /^[A-Za-z0-9_.-]+$/), http_status: status, error_code: str(ev.error_code, 100, 'invalid_evidence', /^[A-Za-z0-9_.:-]+$/) };
    if ('request_id' in ev) evidence.request_id = str(ev.request_id, 200, 'invalid_evidence');
  } else if ('evidence' in body) throw bad('invalid_body');
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    await lockedAccount(accountOf(body), sql, clock());
    const hold = await lockedHold(sql, signer, body);
    if (hold.state === 'released') { if (hold.release_basis === body.basis) return { hold: holdView(hold) }; throw new HostingError(409, 'release_not_proven'); }
    if (hold.state === 'settled') throw new HostingError(409, 'hold_final');
    if (body.basis === 'never_dispatched') {
      if (hold.state !== 'held') throw new HostingError(409, 'release_not_proven');
    } else {
      if (hold.state !== 'dispatched' || !rejectionAllowlist().has(`${evidence!.provider}:${evidence!.http_status}:${evidence!.error_code}`)) throw new HostingError(409, 'release_not_proven');
    }
    const [row] = await sql`UPDATE hosting_agent_holds SET state='released',released_at=${clock()},release_basis=${body.basis},release_evidence=${evidence ? sql.json(evidence as any) : null} WHERE id=${hold.id} RETURNING *`;
    return { hold: holdView(row!) };
  });
}

export async function settleAgentHold(signer: string, body: any, clock: () => Date = () => new Date(), db: Db = getDb()) {
  requireService(signer);
  exact(body, [...identity, 'observation']);
  const o = body.observation;
  exact(o, ['input_tokens', 'output_tokens', 'generation_id', 'observed_at'], ['cached_input_tokens', 'provider_request_id']);
  const inTok = dec(o.input_tokens, MAX_TOKENS, 'invalid_observation'), outTok = dec(o.output_tokens, MAX_TOKENS, 'invalid_observation');
  const cachedTok = 'cached_input_tokens' in o ? dec(o.cached_input_tokens, MAX_TOKENS, 'invalid_observation') : 0n;
  const observed = new Date(String(o.observed_at));
  if (typeof o.observed_at !== 'string' || Number.isNaN(observed.getTime())) throw bad('invalid_observation');
  const norm = { input_tokens: inTok.toString(), output_tokens: outTok.toString(), cached_input_tokens: cachedTok.toString(), generation_id: str(o.generation_id, 200, 'invalid_observation'),
    provider_request_id: 'provider_request_id' in o ? str(o.provider_request_id, 200, 'invalid_observation') : null, observed_at: observed.toISOString() };
  const obsSha = sha(canonical(norm));
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    const now = clock();
    const account = await lockedAccount(accountOf(body), sql, now);
    const hold = await lockedHold(sql, signer, body);
    if (hold.state === 'settled') {
      if (hold.observation_sha256 !== obsSha) throw new HostingError(409, 'settlement_conflict');
      return { hold: holdView(hold), replayed: true };
    }
    if (hold.state === 'released') throw new HostingError(409, 'hold_final');
    if (hold.state === 'held') throw new HostingError(409, 'hold_not_dispatched');
    const [rate] = await sql`SELECT * FROM hosting_agent_tariff_models WHERE version=${hold.tariff_version} AND model=${hold.model}`;
    if (!rate) throw new HostingError(409, 'settlement_conflict');
    let cost: bigint;
    const inR = BigInt(rate.input_pico), outR = BigInt(rate.output_pico);
    if (cachedTok > 0n) {
      if (rate.cached_input_pico === null) throw new HostingError(422, 'cached_rate_unsupported');
      const cR = BigInt(rate.cached_input_pico);
      if (rate.cached_input_semantics === 'subset') {
        if (cachedTok > inTok) throw new HostingError(422, 'invalid_observation');
        cost = (inTok - cachedTok) * inR + cachedTok * cR;
      } else cost = inTok * inR + cachedTok * cR;
    } else cost = inTok * inR;
    cost += outTok * outR + BigInt(rate.request_pico);
    const units = picoToUnits(cost), reserved = BigInt(hold.reserved_units);
    let ledgerId: string | null = null;
    if (units > 0n) {
      let promo = BigInt(account.promo_units), paid = BigInt(account.paid_units);
      const fromPromo = promo < units ? promo : units;
      promo -= fromPromo; paid -= units - fromPromo;
      const [entry] = await sql`INSERT INTO hosting_ledger(account_id,workspace_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason,metadata)
        VALUES(${account.id},${hold.workspace_id},'agent_usage',${(-units).toString()},${paid.toString()},${promo.toString()},${`agent_hold:${hold.id}`},'Agent model usage at the frozen tariff',
          ${sql.json({ hold_id: hold.id, call_id: hold.call_id, model: hold.model, tariff_version: hold.tariff_version, observation: norm } as any)}) RETURNING id`;
      ledgerId = entry!.id as string;
      await sql`UPDATE hosting_accounts SET paid_units=${paid.toString()},promo_units=${promo.toString()},
        depleted_at=CASE WHEN ${promo.toString()}::numeric+${paid.toString()}::numeric<=0 THEN COALESCE(depleted_at,${now}) ELSE depleted_at END WHERE id=${account.id}`;
    }
    const overrun = units > reserved ? units - reserved : 0n;
    const [row] = await sql`UPDATE hosting_agent_holds SET state='settled',settled_at=${now},settled_units=${units.toString()},overrun_units=${overrun.toString()},
      observation=${sql.json(norm as any)},observation_sha256=${obsSha},ledger_id=${ledgerId} WHERE id=${hold.id} RETURNING *`;
    if (overrun > 0n) await sql`INSERT INTO hosting_agent_spend_blocks(account_id,hold_id,reason) VALUES(${account.id},${hold.id},'settled_cost_exceeded_hold')`;
    return { hold: holdView(row!), replayed: false };
  });
}

export async function readAgentHold(signer: string, query: { account_id?: string; call_id?: string; hold_id?: string }, db: Db = getDb()) {
  requireService(signer);
  const hold = await lockedHold(db, signer, query);
  return { hold: holdView(hold) };
}

export async function clearAgentSpendBlock(admin: string, accountId: string, db: Db = getDb()) {
  requireEnabled();
  if (!UUID.test(accountId)) throw new HostingError(404, 'billing_account_not_found');
  const rows = await db`UPDATE hosting_agent_spend_blocks SET cleared_at=now(),cleared_by=${admin} WHERE account_id=${accountId} AND cleared_at IS NULL RETURNING id`;
  return { cleared: rows.length };
}

/* ------------------------------------------------------------------ reserve source */
export async function agentHoldUnits(sql: Db, accountId: string): Promise<bigint> {
  const [r] = await sql`SELECT COALESCE(sum(reserved_units),0)::text AS held FROM hosting_agent_holds WHERE account_id=${accountId} AND state IN ('held','dispatched','pending_reconcile')`;
  return BigInt(r!.held as string);
}
let unregister: (() => void) | null = null;
/** Trusted startup hook: open holds participate in refund gating and in agent admission. The query is real; zero when no holds exist. Returns the unregister function. */
export function registerAgentHoldsReserve() {
  if (!unregister) {
    const off = registerFundingReserve('agent_holds', (sql, accountId) => agentHoldUnits(sql as Db, accountId));
    unregister = () => { off(); unregister = null; };
  }
  return unregister;
}
export { OPEN as OPEN_HOLD_STATES };
