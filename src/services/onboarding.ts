import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config';
import { getDb } from '../db';
import { resolveOrCreateFlightDeckPgActor } from './flightdeck-pg-authorization';
import { generatedFlightDeckPgWorkspaceServiceNpub, setupFlightDeckPgDevWorkspace } from './flightdeck-pg-setup';
import { HostingError, unitsUsd } from './hosting-billing';

type Db = ReturnType<typeof getDb>;
export const ONBOARDING_MIN_FUNDING_CENTS = 2100;
export const ONBOARDING_MAX_FUNDING_CENTS = 1_000_000;
/** Included introductory storage period: 720 hours from successful paid provisioning. */
export const ONBOARDING_INTRO_HOURS = 720;
const MAX_OPEN_INTENTS = 10;
/** Release gate: intent/checkout/provision stay disabled until the manager's reviewed activation sets ONBOARDING_ENABLED=true. */
export const onboardingEnabled = () => process.env.ONBOARDING_ENABLED === 'true';
export function requireOnboardingEnabled() { if (!onboardingEnabled()) throw new HostingError(503, 'onboarding_rollout_disabled'); }
const KEY = /^[a-zA-Z0-9_-]{8,100}$/;
const RETURN_STATE = /^[A-Za-z0-9._~:@\/=+-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const nameKey = (name: string) => name.normalize('NFKC').toLocaleLowerCase('en-US');
const bad = (code: string) => new HostingError(400, code);
const exact = (body: any, required: string[], optional: string[] = []) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('invalid_body');
  const keys = Object.keys(body);
  if (required.some(k => !keys.includes(k)) || keys.some(k => ![...required, ...optional].includes(k))) throw bad('invalid_body');
};

// ---- Owner billing account (independent of any workspace) -------------------------------------------------------

/** Opens the authenticated owner's shared USD account with NO welcome or promotional credit. An existing account
 * (including legacy accounts that received the old welcome grant) is returned untouched. */
export async function ensureOwnerAccount(ownerNpub: string, db: Db = getDb()) {
  const owner = await resolveOrCreateFlightDeckPgActor(ownerNpub, 'human', { sql: db as any });
  const [account] = await db`INSERT INTO hosting_accounts(owner_actor_id,promo_units,promo_expires_at,opened_by) VALUES(${owner.id},0,now(),'onboarding')
    ON CONFLICT(owner_actor_id) DO UPDATE SET owner_actor_id=EXCLUDED.owner_actor_id RETURNING *`;
  return { owner, account: account! };
}
export async function openOwnerAccount(ownerNpub: string, db: Db = getDb()) {
  return db.begin(async tx => ownerAccountView((await ensureOwnerAccount(ownerNpub, tx as unknown as Db)).account));
}
export async function readOwnerAccount(ownerNpub: string, db: Db = getDb()) {
  const [account] = await db`SELECT a.* FROM hosting_accounts a JOIN flightdeck_pg_actors o ON o.id=a.owner_actor_id WHERE o.npub=${ownerNpub}`;
  return account ? ownerAccountView(account) : null;
}
function ownerAccountView(a: any) {
  const promo = new Date(a.promo_expires_at) > new Date() ? BigInt(a.promo_units) : 0n;
  const balance = BigInt(a.paid_units) + promo;
  return { account_id: a.id as string, currency: 'USD' as const, balance_units: balance.toString(), balance_usd: unitsUsd(balance), paid_usd: unitsUsd(a.paid_units), promo_usd: unitsUsd(promo), created_at: a.created_at as string };
}

// ---- Capped group invitations ------------------------------------------------------------------------------------

export const inviteTokenHash = (code: string) => sha(code);
export async function createInvite(input: { max_admissions: unknown; label?: unknown }, actorNpub: string, db: Db = getDb()) {
  if (!config.adminNpub || actorNpub !== config.adminNpub) throw new HostingError(403, 'platform_admin_required');
  const max = input.max_admissions;
  if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > 100000) throw bad('invalid_max_admissions');
  const label = input.label === undefined || input.label === null ? null : input.label;
  if (label !== null && (typeof label !== 'string' || label.length > 120)) throw bad('invalid_label');
  const code = `inv_${randomBytes(24).toString('base64url')}`;
  const [row] = await db`INSERT INTO onboarding_invites(token_sha256,label,max_admissions,created_by_npub) VALUES(${sha(code)},${label},${max as number},${actorNpub}) RETURNING id,max_admissions,label,created_at`;
  // The plaintext code is returned exactly once; only its digest is stored.
  return { id: row!.id as string, code, max_admissions: row!.max_admissions as number, label: row!.label as string | null, created_at: row!.created_at as string };
}
export async function listInvites(actorNpub: string, db: Db = getDb()) {
  if (!config.adminNpub || actorNpub !== config.adminNpub) throw new HostingError(403, 'platform_admin_required');
  return db`SELECT i.id,i.label,i.max_admissions,i.revoked_at,i.created_at,
    count(*) FILTER (WHERE s.status='reserved')::int AS reserved,count(*) FILTER (WHERE s.status='redeemed')::int AS redeemed,count(*) FILTER (WHERE s.status='released')::int AS released
    FROM onboarding_invites i LEFT JOIN onboarding_invite_seats s ON s.invite_id=i.id GROUP BY i.id ORDER BY i.created_at DESC LIMIT 200`;
}
export async function revokeInvite(id: string, actorNpub: string, db: Db = getDb()) {
  if (!config.adminNpub || actorNpub !== config.adminNpub) throw new HostingError(403, 'platform_admin_required');
  if (!UUID.test(id)) throw new HostingError(404, 'invite_not_found');
  const [row] = await db`UPDATE onboarding_invites SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${id} RETURNING id,revoked_at`;
  if (!row) throw new HostingError(404, 'invite_not_found');
  return row; // Existing seats stay valid; revocation only stops new admissions.
}
/** Administrative release of an unredeemed seat (for example, an abandoned claimant). */
export async function releaseInviteSeat(inviteId: string, ownerNpub: string, actorNpub: string, db: Db = getDb()) {
  if (!config.adminNpub || actorNpub !== config.adminNpub) throw new HostingError(403, 'platform_admin_required');
  if (!UUID.test(inviteId)) throw new HostingError(404, 'invite_not_found');
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    const [invite] = await sql`SELECT id FROM onboarding_invites WHERE id=${inviteId} FOR UPDATE`;
    if (!invite) throw new HostingError(404, 'invite_not_found');
    const [seat] = await sql`SELECT s.* FROM onboarding_invite_seats s JOIN flightdeck_pg_actors a ON a.id=s.owner_actor_id WHERE s.invite_id=${inviteId} AND a.npub=${ownerNpub} FOR UPDATE OF s`;
    if (!seat) throw new HostingError(404, 'seat_not_found');
    if (seat.status === 'redeemed') throw new HostingError(409, 'seat_redeemed');
    // Intents are locked after invite and seat (same order as cancel/claim) and re-read, so funding cannot interleave.
    const intents = await sql`SELECT id,status FROM onboarding_intents WHERE invite_id=${inviteId} AND owner_actor_id=${seat.owner_actor_id} FOR UPDATE`;
    if (intents.some(i => ['funded', 'provisioning', 'provisioned'].includes(i.status))) throw new HostingError(409, 'seat_has_funded_intent');
    if (await hasOutstandingCheckout(intents.map(i => i.id as string), sql)) throw new HostingError(409, 'checkout_outstanding');
    await sql`UPDATE onboarding_invite_seats SET status='released',released_at=COALESCE(released_at,now()),released_reason='admin_release' WHERE invite_id=${inviteId} AND owner_actor_id=${seat.owner_actor_id}`;
    return { invite_id: inviteId, status: 'released' as const };
  });
}
/** Public, minimal: whether a new admission is currently possible. Never discloses counts. */
export async function inviteAvailability(code: string, db: Db = getDb()) {
  if (typeof code !== 'string' || code.length < 8 || code.length > 200) return { available: false };
  const [row] = await db`SELECT i.max_admissions,i.revoked_at,(SELECT count(*)::int FROM onboarding_invite_seats s WHERE s.invite_id=i.id AND s.status<>'released') AS taken FROM onboarding_invites i WHERE i.token_sha256=${sha(code)}`;
  return { available: Boolean(row && !row.revoked_at && row.taken < row.max_admissions) };
}
/** Reserves one seat for this identity. Idempotent per identity: retries, replays and further intents never consume more. */
async function reserveSeat(code: string, ownerId: string, sql: Db) {
  if (typeof code !== 'string' || code.length < 8 || code.length > 200) throw new HostingError(404, 'invite_not_found');
  const [invite] = await sql`SELECT * FROM onboarding_invites WHERE token_sha256=${sha(code)} FOR UPDATE`;
  if (!invite) throw new HostingError(404, 'invite_not_found');
  const [seat] = await sql`SELECT status FROM onboarding_invite_seats WHERE invite_id=${invite.id} AND owner_actor_id=${ownerId} FOR UPDATE`;
  if (seat && seat.status !== 'released') return invite.id as string;
  if (invite.revoked_at) throw new HostingError(410, 'invite_revoked');
  const [{ taken }] = await sql`SELECT count(*)::int AS taken FROM onboarding_invite_seats WHERE invite_id=${invite.id} AND status<>'released'`;
  if (taken >= invite.max_admissions) throw new HostingError(409, 'invite_full');
  await sql`INSERT INTO onboarding_invite_seats(invite_id,owner_actor_id,status) VALUES(${invite.id},${ownerId},'reserved')
    ON CONFLICT(invite_id,owner_actor_id) DO UPDATE SET status='reserved',reserved_at=now(),released_at=NULL,released_reason=NULL`;
  return invite.id as string;
}

// ---- Agent offers (versioned references; empty catalogue means agents fail closed) -------------------------------

export async function createAgentOffer(input: any, actorNpub: string, db: Db = getDb()) {
  if (!config.adminNpub || actorNpub !== config.adminNpub) throw new HostingError(403, 'platform_admin_required');
  exact(input, ['template', 'model_ref', 'rate_version', 'default_daily_cap_cents', 'max_daily_cap_cents']);
  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= max;
  const cents = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 1_000_000;
  if (!text(input.template, 100) || !text(input.model_ref, 200) || !text(input.rate_version, 100) || !cents(input.default_daily_cap_cents) || !cents(input.max_daily_cap_cents) || input.max_daily_cap_cents < input.default_daily_cap_cents) throw bad('invalid_agent_offer');
  const [row] = await db`INSERT INTO onboarding_agent_offers(template,model_ref,rate_version,default_daily_cap_cents,max_daily_cap_cents,created_by_npub)
    VALUES(${input.template},${input.model_ref},${input.rate_version},${input.default_daily_cap_cents},${input.max_daily_cap_cents},${actorNpub})
    ON CONFLICT(template,model_ref,rate_version) DO UPDATE SET active=true RETURNING *`;
  if (row!.default_daily_cap_cents !== input.default_daily_cap_cents || row!.max_daily_cap_cents !== input.max_daily_cap_cents) throw new HostingError(409, 'agent_offer_conflict');
  return offerView(row);
}
export async function listAgentOffers(db: Db = getDb()) {
  return (await db`SELECT * FROM onboarding_agent_offers WHERE active ORDER BY template,model_ref,rate_version`).map(offerView);
}
const offerView = (o: any) => ({ id: o.id as string, template: o.template as string, model_ref: o.model_ref as string, rate_version: o.rate_version as string, default_daily_cap_cents: o.default_daily_cap_cents as number, max_daily_cap_cents: o.max_daily_cap_cents as number });

/** Stage 1 cannot verify a provider session's terminal state, so any unfulfilled attached order is treated as outstanding:
 * its seat may not be released or reused because a late verified payment must still find its guaranteed seat. */
async function hasOutstandingCheckout(intentIds: string[], sql: Db) {
  if (!intentIds.length) return false;
  const [row] = await sql`SELECT 1 FROM hosting_checkout_orders WHERE intent_id=ANY(${intentIds}::uuid[]) AND fulfilled_at IS NULL LIMIT 1`;
  return Boolean(row);
}

// ---- Intents -----------------------------------------------------------------------------------------------------

function validateName(name: unknown) {
  if (typeof name !== 'string' || name !== name.trim() || name.length < 1 || name.length > 80) throw bad('invalid_workspace_name');
  return name;
}
function validateFunding(v: unknown) {
  if (!Number.isSafeInteger(v) || (v as number) < ONBOARDING_MIN_FUNDING_CENTS || (v as number) > ONBOARDING_MAX_FUNDING_CENTS) throw bad('invalid_funding_amount');
  return v as number;
}
function validateReturnState(v: unknown) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !RETURN_STATE.test(v) || v.includes('//')) throw bad('invalid_return_state');
  return v;
}
async function resolveAgent(offerId: unknown, cap: unknown, sql: Db) {
  if (offerId === undefined || offerId === null) {
    if (cap !== undefined && cap !== null) throw bad('agent_cap_without_offer');
    return { offer: null, cap: null };
  }
  if (typeof offerId !== 'string' || !UUID.test(offerId)) throw bad('invalid_agent_offer_id');
  const [offer] = await sql`SELECT * FROM onboarding_agent_offers WHERE id=${offerId} AND active`;
  if (!offer) throw new HostingError(409, 'agent_offer_unavailable');
  const chosen = cap === undefined || cap === null ? offer.default_daily_cap_cents : cap;
  if (!Number.isSafeInteger(chosen) || (chosen as number) < 1 || (chosen as number) > offer.max_daily_cap_cents) throw bad('invalid_agent_daily_cap');
  return { offer, cap: chosen as number };
}
async function assertNameFree(ownerNpub: string, ownerId: string, key: string, sql: Db, exceptIntent?: string) {
  const rows = await sql`SELECT name FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${ownerNpub} AND app_npub=${config.flightDeck.appNpub}`;
  if (rows.some(r => nameKey(String(r.name)) === key)) throw new HostingError(409, 'workspace_name_taken');
  const [other] = await sql`SELECT 1 FROM onboarding_intents WHERE owner_actor_id=${ownerId} AND workspace_name_key=${key} AND status IN ('open','funded','provisioning') AND (${exceptIntent ?? null}::uuid IS NULL OR id<>${exceptIntent ?? null}::uuid)`;
  if (other) throw new HostingError(409, 'workspace_name_taken');
}
async function view(row: any, sql: Db) {
  let agent = null;
  if (row.agent_offer_id) {
    const [o] = await sql`SELECT * FROM onboarding_agent_offers WHERE id=${row.agent_offer_id}`;
    agent = { ...offerView(o), daily_cap_cents: row.agent_daily_cap_cents as number };
  }
  return {
    version: 1 as const, id: row.id as string, account_id: row.account_id as string, status: row.status as string, revision: row.revision as number,
    workspace_name: row.workspace_name as string, agent,
    // Selecting an agent does not provision one: a later stage adds an 'agent' step. Workspace readiness never implies an agent exists.
    agent_state: (row.agent_offer_id ? (row.steps.agent ? 'provisioned' : 'selected_not_provisioned') : 'none') as 'none' | 'selected_not_provisioned' | 'provisioned',
    funding_cents: row.funding_cents as number, return_state: row.return_state as string | null,
    funded: row.funded_at !== null, funded_at: row.funded_at as string | null,
    steps: Object.fromEntries(Object.entries(row.steps as Record<string, any>).map(([k, v]) => [k, { completed_at: v.completed_at as string }])),
    last_error: row.last_error as string | null, workspace_id: row.workspace_id as string | null,
    provisioned_at: row.provisioned_at as string | null, intro_ends_at: row.intro_ends_at as string | null,
    created_at: row.created_at as string, updated_at: row.updated_at as string,
  };
}
export type OnboardingIntentView = Awaited<ReturnType<typeof view>>;

export async function createIntent(ownerNpub: string, body: any, db: Db = getDb()) {
  requireOnboardingEnabled();
  exact(body, ['client_request_key', 'invite_code', 'workspace_name', 'funding_cents'], ['agent_offer_id', 'agent_daily_cap_cents', 'return_state']);
  if (typeof body.client_request_key !== 'string' || !KEY.test(body.client_request_key)) throw bad('invalid_client_request_key');
  const workspaceName = validateName(body.workspace_name), funding = validateFunding(body.funding_cents), returnState = validateReturnState(body.return_state);
  const digest = sha(JSON.stringify([body.invite_code, workspaceName, funding, body.agent_offer_id ?? null, body.agent_daily_cap_cents ?? null, returnState]));
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    const { owner, account } = await ensureOwnerAccount(ownerNpub, sql);
    const [prior] = await sql`SELECT * FROM onboarding_intents WHERE owner_actor_id=${owner.id} AND client_request_key=${body.client_request_key} FOR UPDATE`;
    if (prior) {
      if (prior.request_sha256 !== digest) throw new HostingError(409, 'idempotency_conflict');
      return { intent: await view(prior, sql), replayed: true };
    }
    const key = nameKey(workspaceName);
    await assertNameFree(ownerNpub, owner.id, key, sql);
    const [{ open }] = await sql`SELECT count(*)::int AS open FROM onboarding_intents WHERE owner_actor_id=${owner.id} AND status IN ('open','funded','provisioning')`;
    if (open >= MAX_OPEN_INTENTS) throw new HostingError(429, 'too_many_open_intents');
    const { offer, cap } = await resolveAgent(body.agent_offer_id, body.agent_daily_cap_cents, sql);
    const inviteId = await reserveSeat(body.invite_code, owner.id, sql);
    const [row] = await sql`INSERT INTO onboarding_intents(owner_actor_id,account_id,client_request_key,request_sha256,invite_id,workspace_name,workspace_name_key,agent_offer_id,agent_daily_cap_cents,funding_cents,return_state)
      VALUES(${owner.id},${account.id},${body.client_request_key},${digest},${inviteId},${workspaceName},${key},${offer?.id ?? null},${cap},${funding},${returnState}) RETURNING *`;
    return { intent: await view(row, sql), replayed: false };
  });
}
async function ownedIntent(id: string, ownerNpub: string, sql: Db, lock = false) {
  if (!UUID.test(id)) throw new HostingError(404, 'intent_not_found');
  const [row] = lock
    ? await sql`SELECT i.* FROM onboarding_intents i JOIN flightdeck_pg_actors a ON a.id=i.owner_actor_id WHERE i.id=${id} AND a.npub=${ownerNpub} FOR UPDATE OF i`
    : await sql`SELECT i.* FROM onboarding_intents i JOIN flightdeck_pg_actors a ON a.id=i.owner_actor_id WHERE i.id=${id} AND a.npub=${ownerNpub}`;
  // Other identities receive the same neutral result as a missing intent.
  if (!row) throw new HostingError(404, 'intent_not_found');
  return row;
}
export async function readIntent(id: string, ownerNpub: string, db: Db = getDb()) { return view(await ownedIntent(id, ownerNpub, db), db); }
export async function listIntents(ownerNpub: string, db: Db = getDb()) {
  const rows = await db`SELECT i.* FROM onboarding_intents i JOIN flightdeck_pg_actors a ON a.id=i.owner_actor_id WHERE a.npub=${ownerNpub} ORDER BY i.created_at DESC LIMIT 50`;
  return Promise.all(rows.map(r => view(r, db)));
}
export async function updateIntent(id: string, ownerNpub: string, body: any, db: Db = getDb()) {
  requireOnboardingEnabled();
  exact(body, ['expected_revision'], ['workspace_name', 'funding_cents', 'agent_offer_id', 'agent_daily_cap_cents', 'return_state']);
  if (!Number.isSafeInteger(body.expected_revision)) throw bad('invalid_expected_revision');
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    const row = await ownedIntent(id, ownerNpub, sql, true);
    if (row.revision !== body.expected_revision) throw new HostingError(409, 'stale_revision');
    if (!['open', 'funded'].includes(row.status)) throw new HostingError(409, 'intent_not_editable');
    if ('funding_cents' in body && row.status !== 'open') throw new HostingError(409, 'funding_locked');
    const name = 'workspace_name' in body ? validateName(body.workspace_name) : row.workspace_name;
    const funding = 'funding_cents' in body ? validateFunding(body.funding_cents) : row.funding_cents;
    const returnState = 'return_state' in body ? validateReturnState(body.return_state) : row.return_state;
    if (nameKey(name) !== row.workspace_name_key) await assertNameFree(ownerNpub, row.owner_actor_id, nameKey(name), sql, row.id);
    const touchesAgent = 'agent_offer_id' in body || 'agent_daily_cap_cents' in body;
    const agent = touchesAgent
      ? await resolveAgent('agent_offer_id' in body ? body.agent_offer_id : row.agent_offer_id, 'agent_offer_id' in body ? body.agent_daily_cap_cents : (body.agent_daily_cap_cents ?? row.agent_daily_cap_cents), sql)
      : { offer: row.agent_offer_id ? { id: row.agent_offer_id } : null, cap: row.agent_daily_cap_cents };
    const [updated] = await sql`UPDATE onboarding_intents SET workspace_name=${name},workspace_name_key=${nameKey(name)},funding_cents=${funding},return_state=${returnState},
      agent_offer_id=${agent.offer?.id ?? null},agent_daily_cap_cents=${agent.cap},revision=revision+1,updated_at=now() WHERE id=${row.id} RETURNING *`;
    return view(updated, sql);
  });
}
/** Owner cancels before any verified funding. Releases the invitation seat; credit already paid is never touched. */
export async function cancelIntent(id: string, ownerNpub: string, db: Db = getDb()) {
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    const peek = await ownedIntent(id, ownerNpub, sql);
    // Lock order invite -> seat -> intent matches claim and administrative release.
    await sql`SELECT id FROM onboarding_invites WHERE id=${peek.invite_id} FOR UPDATE`;
    await sql`SELECT 1 FROM onboarding_invite_seats WHERE invite_id=${peek.invite_id} AND owner_actor_id=${peek.owner_actor_id} FOR UPDATE`;
    const row = await ownedIntent(id, ownerNpub, sql, true);
    if (row.status === 'cancelled') return view(row, sql);
    if (row.status !== 'open') throw new HostingError(409, 'intent_not_cancellable');
    // A checkout may already exist and still be paid later; keep the intent and its seat until stage 2 can verify terminal state.
    if (await hasOutstandingCheckout([row.id], sql)) throw new HostingError(409, 'checkout_outstanding');
    const [updated] = await sql`UPDATE onboarding_intents SET status='cancelled',revision=revision+1,updated_at=now() WHERE id=${row.id} RETURNING *`;
    const [still] = await sql`SELECT 1 FROM onboarding_intents WHERE invite_id=${row.invite_id} AND owner_actor_id=${row.owner_actor_id} AND status IN ('open','funded','provisioning','provisioned')`;
    if (!still) await sql`UPDATE onboarding_invite_seats SET status='released',released_at=now(),released_reason='intent_cancelled' WHERE invite_id=${row.invite_id} AND owner_actor_id=${row.owner_actor_id} AND status='reserved'`;
    return view(updated, sql);
  });
}
/** Verified-payment binding point. Called only inside the fulfilment transaction after the ledger credit is written. */
export async function markOnboardingFunded(order: { id: string; intent_id: string; account_id: string; amount_cents: number }, sql: Db) {
  const [intent] = await sql`SELECT * FROM onboarding_intents WHERE id=${order.intent_id} FOR UPDATE`;
  if (!intent || intent.account_id !== order.account_id) throw new HostingError(400, 'stripe_binding_mismatch');
  if (intent.status !== 'open' || order.amount_cents < intent.funding_cents) return false; // credit stays in the account either way
  await sql`UPDATE onboarding_intents SET status='funded',funded_order_id=${order.id},funded_at=now(),last_error=NULL,revision=revision+1,updated_at=now() WHERE id=${intent.id}`;
  return true;
}
export async function intentForCheckout(id: string, ownerNpub: string, db: Db = getDb()) {
  requireOnboardingEnabled();
  const row = await ownedIntent(id, ownerNpub, db);
  if (row.status !== 'open') throw new HostingError(409, 'intent_not_open');
  return { accountId: row.account_id as string, amountCents: row.funding_cents as number, intentId: row.id as string };
}

// ---- Provisioning (funded intents only; durable, resumable, exactly once) ----------------------------------------

type StepContext = { intent: any; ownerNpub: string; sql: Db };
const STEPS: { name: string; run: (ctx: StepContext) => Promise<Record<string, unknown> | void> }[] = [
  { name: 'workspace', run: async ({ intent, ownerNpub, sql }) => {
    // Deterministic service identity makes workspace creation idempotent for this intent.
    const serviceNpub = generatedFlightDeckPgWorkspaceServiceNpub(`onboarding:${intent.id}`);
    const clash = await sql`SELECT name FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${ownerNpub} AND app_npub=${config.flightDeck.appNpub} AND workspace_service_npub<>${serviceNpub}`;
    if (clash.some(r => nameKey(String(r.name)) === intent.workspace_name_key)) throw new HostingError(409, 'workspace_name_taken');
    const setup = await setupFlightDeckPgDevWorkspace({
      creatorNpub: ownerNpub, workspaceOwnerNpub: ownerNpub, workspaceName: intent.workspace_name, workspaceDescription: null,
      workspaceServiceNpub: serviceNpub, appNpub: config.flightDeck.appNpub,
    }, sql as any);
    await sql`UPDATE onboarding_intents SET workspace_id=${setup.workspace_id} WHERE id=${intent.id}`;
    return { workspace_id: setup.workspace_id };
  } },
  { name: 'billing_link', run: async ({ intent, sql }) => {
    const [row] = await sql`SELECT workspace_id FROM onboarding_intents WHERE id=${intent.id}`;
    // The introductory 720 hours are included; the legacy hourly meter therefore starts only after them.
    // Hourly peak / 1 GB waiver accounting replaces this interim boundary in the storage slice.
    const starts = new Date(Date.now() + ONBOARDING_INTRO_HOURS * 3_600_000);
    await sql`INSERT INTO hosting_workspace_accounts(workspace_id,account_id,enabled_at) VALUES(${row!.workspace_id},${intent.account_id},${starts}) ON CONFLICT(workspace_id) DO NOTHING`;
    const [link] = await sql`SELECT account_id,enabled_at FROM hosting_workspace_accounts WHERE workspace_id=${row!.workspace_id}`;
    if (link!.account_id !== intent.account_id) throw new HostingError(409, 'billing_owner_conflict');
    return { intro_ends_at: new Date(link!.enabled_at).toISOString() };
  } },
];
export const ONBOARDING_STEP_NAMES = STEPS.map(s => s.name);

/** Funding evidence is re-derived from the fulfilled order and its ledger credit, not trusted from the intent flag alone. */
async function assertFundedEvidence(intent: any, sql: Db) {
  const [order] = await sql`SELECT o.*,l.amount_units FROM hosting_checkout_orders o LEFT JOIN hosting_ledger l ON l.account_id=o.account_id AND l.idempotency_key='stripe:'||o.payment_intent
    WHERE o.id=${intent.funded_order_id} AND o.intent_id=${intent.id} AND o.account_id=${intent.account_id} AND o.fulfilled_at IS NOT NULL`;
  if (!order || order.amount_units === null || BigInt(order.amount_units) < BigInt(intent.funding_cents) * 1_440_000_000n) throw new HostingError(402, 'funding_required');
}
export async function provisionIntent(id: string, ownerNpub: string, db: Db = getDb(), hooks: { beforeStep?: (name: string) => Promise<void> | void } = {}) {
  requireOnboardingEnabled();
  const head = await db.begin(async tx => {
    const sql = tx as unknown as Db;
    const row = await ownedIntent(id, ownerNpub, sql, true);
    if (row.status === 'provisioned') return { done: true as const, row };
    if (row.status === 'open') throw new HostingError(402, 'funding_required');
    if (row.status === 'cancelled') throw new HostingError(409, 'intent_cancelled');
    await assertFundedEvidence(row, sql);
    const [u] = await sql`UPDATE onboarding_intents SET status='provisioning',updated_at=now() WHERE id=${id} RETURNING *`;
    return { done: false as const, row: u! };
  });
  if (head.done) return view(head.row, db);
  for (const step of STEPS) {
    try {
      await db.begin(async tx => {
        const sql = tx as unknown as Db;
        // Serialize concurrent callers; a step already recorded is never repeated.
        const intent = await ownedIntent(id, ownerNpub, sql, true);
        if (intent.status === 'provisioned' || intent.steps[step.name]) return;
        await hooks.beforeStep?.(step.name);
        const detail = (await step.run({ intent, ownerNpub, sql })) ?? {};
        const steps = { ...intent.steps, [step.name]: { completed_at: new Date().toISOString(), ...detail } };
        await sql`UPDATE onboarding_intents SET steps=${sql.json(steps)},intro_ends_at=COALESCE(${(detail as any).intro_ends_at ?? null}::timestamptz,intro_ends_at),last_error=NULL,updated_at=now() WHERE id=${id}`;
      });
    } catch (e) {
      // Credit and completed steps stay; the failure is recorded for display and the same call can be retried.
      const code = e instanceof HostingError ? e.code : 'provisioning_step_failed';
      await db`UPDATE onboarding_intents SET last_error=${`${step.name}:${code}`},updated_at=now() WHERE id=${id}`;
      if (e instanceof HostingError) throw e;
      throw new HostingError(502, 'provisioning_step_failed');
    }
  }
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    const intent = await ownedIntent(id, ownerNpub, sql, true);
    if (intent.status === 'provisioned') return view(intent, sql);
    const [u] = await sql`UPDATE onboarding_intents SET status='provisioned',provisioned_at=now(),revision=revision+1,last_error=NULL,updated_at=now() WHERE id=${id} RETURNING *`;
    await sql`UPDATE onboarding_invite_seats SET status='redeemed',redeemed_at=COALESCE(redeemed_at,now()) WHERE invite_id=${intent.invite_id} AND owner_actor_id=${intent.owner_actor_id}`;
    return view(u, sql);
  });
}
