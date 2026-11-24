import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { buildOpenApiDocument } from '../src/openapi';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { availableRefundableUnits } from '../src/services/hosting-funding';
import { grantHostingCredit } from '../src/services/hosting-billing';
import { accountStorageSummary, enrollPeakStorage, registerMeteredStorageCategory, registerStorageProtectionReserve, takeStorageAnchor } from '../src/services/hosting-storage';
import { openOwnerAccount } from '../src/services/onboarding';
import {
  appendAgentTariff, clearAgentSpendBlock, createAgentGrant, dispatchAgentHold, listAgentGrants, markAgentHoldPending, picoToUnits, readAgentHold, registerAgentHoldsReserve,
  releaseAgentHold, reserveAgentHold, revokeAgentGrant, settleAgentHold,
} from '../src/services/hosting-agent-holds';

// Runs only against a dedicated disposable PostgreSQL: HOLDS_TEST_PORT=<free port>.
const port = Number(process.env.HOLDS_TEST_PORT);
const HOUR = 3_600_000;
const key = (n: number) => new Uint8Array(32).fill(n);
const npub = (k: Uint8Array) => nip19.npubEncode(getPublicKey(k));
const [ownerKey, otherKey, agentKey, serviceAKey, serviceBKey, rogueKey, adminKey, agent2Key] = [201, 202, 203, 204, 205, 206, 207, 208].map(key) as Uint8Array[];
const [owner, other, agent, serviceA, serviceB, rogue, admin, agent2] = [ownerKey, otherKey, agentKey, serviceAKey, serviceBKey, rogueKey, adminKey, agent2Key].map(npub) as string[];
const app = createApp();
const gitStandIn = () => ({ id: 'git' as const, journal: 'write_path' as const, bytes: async () => 0n });

describe('unit conversion', () => {
  test('ceil(pico*18/125) is exact and always rounds up', () => {
    expect(picoToUnits(0n)).toBe(0n);
    expect(picoToUnits(1n)).toBe(1n);
    expect(picoToUnits(125n)).toBe(18n);
    expect(picoToUnits(126n)).toBe(19n);
    expect(picoToUnits(10n ** 12n)).toBe(144_000_000_000n);
    expect(picoToUnits(400_000_000n)).toBe(57_600_000n);
    expect(picoToUnits(10n ** 30n + 1n)).toBe(144n * 10n ** 27n + 1n);
  });
});

describe.skipIf(!port || port === 5432)('paid agent holds on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_holds_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  let account: string, workspace: string, ownerActor: string, grantId: string, offGit: () => void, offHolds: () => void;
  const saved = { admin: config.adminNpub };
  const base = new Date('2026-12-01T10:00:00Z');
  let now = base;
  const clock = () => now;
  const reserveBody = (over: Record<string, unknown> = {}) => ({ account_id: account, call_id: `c-${randomUUID()}`, grant_id: grantId, workspace_id: workspace, agent_npub: agent, model: 'm/plain', tariff_version: 't1', max_input_tokens: '1000', max_output_tokens: '500', ...over });
  const obs = (over: Record<string, unknown> = {}) => ({ input_tokens: '1000', output_tokens: '500', generation_id: 'gen-1', observed_at: base.toISOString(), ...over });
  const paidUnits = async () => BigInt((await db`SELECT paid_units FROM hosting_accounts WHERE id=${account}`)[0]!.paid_units);
  const reserve = (signer: string, over: Record<string, unknown> = {}) => reserveAgentHold(signer, reserveBody(over), clock, db as any);
  async function grant(over: Record<string, unknown> = {}, payer = owner) {
    return createAgentGrant(payer, { idempotency_key: `g-${randomUUID().slice(0, 12)}`, workspace_id: workspace, agent_npub: agent, service_npub: serviceA, model: 'm/plain', tariff_version: 't1', daily_cap_units: '100000000000', expires_at: new Date(base.getTime() + 30 * 86_400_000).toISOString(), ...over }, clock, db as any);
  }
  async function call(method: 'GET' | 'POST', path: string, signer: Uint8Array | null, body?: unknown) {
    const url = `http://localhost/api/v4/agent-holds${path}`;
    const raw = body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (signer) {
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(), tags: [['u', url], ['method', method], ...(raw ? [['payload', createHash('sha256').update(raw).digest('hex')]] : [])] }, signer);
      headers.Authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
    }
    const response = await app.request(url, { method, headers, body: raw });
    return { status: response.status, json: (await response.json().catch(() => ({}))) as any };
  }
  async function dispatched(over: Record<string, unknown> = {}) {
    const { hold } = await reserve(serviceA, over);
    await dispatchAgentHold(serviceA, { account_id: account, call_id: hold.call_id }, clock, db as any);
    return hold;
  }
  const settle = (hold: { call_id: string }, o: Record<string, unknown> = obs(), signer = serviceA) => settleAgentHold(signer, { account_id: account, call_id: hold.call_id, observation: o }, clock, db as any);

  beforeAll(async () => {
    process.env.ONBOARDING_ENABLED = 'true';
    process.env.HOSTING_AGENT_HOLDS_ENABLED = 'true';
    process.env.HOSTING_AGENT_HOLD_SERVICES = `${serviceA},${serviceB}`;
    process.env.HOSTING_AGENT_REJECTION_ALLOWLIST = 'openrouter:401:invalid_api_key';
    (config as any).adminNpub = admin;
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    [{ id: ownerActor }] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${owner},'human') RETURNING id` as any;
    const [{ id: agentActor }] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${agent},'agent') RETURNING id` as any;
    const [{ id: agent2Actor }] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${agent2},'agent') RETURNING id` as any;
    account = (await openOwnerAccount(owner, db as any)).account_id;
    await grantHostingCredit(account, 10_000, 'holds-fixture', 'Holds fixture credit', owner, db as any); // $100
    workspace = randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${workspace},'tower',${workspace},${owner},'holds-fixture','Holds')`;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace},${ownerActor},'owner'),(${workspace},${agentActor},'agent'),(${workspace},${agent2Actor},'agent')`;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${workspace},${account})`;
    await enrollPeakStorage(db as any, workspace, account, null);
    const h = Math.floor(Date.now() / HOUR) * HOUR;
    await db`UPDATE hosting_storage_enrollments SET activated_at=${new Date(h - 30 * 60_000)},intro_ends_at=${new Date(h - HOUR)} WHERE workspace_id=${workspace}`;
    await takeStorageAnchor(workspace, db as any);
    registerStorageProtectionReserve();
    offGit = registerMeteredStorageCategory(gitStandIn()); // stand-in for the Git slice, this suite only
    offHolds = registerAgentHoldsReserve();
  });
  afterAll(async () => {
    offHolds?.(); offGit?.(); (config as any).adminNpub = saved.admin;
    for (const k of ['HOSTING_AGENT_HOLDS_ENABLED', 'HOSTING_AGENT_HOLD_SERVICES', 'HOSTING_AGENT_REJECTION_ALLOWLIST']) delete process.env[k];
    await closeDb(); const root = postgres({ ...conn, database: 'postgres' }); await root.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await root.end();
  });

  test('no tariff, no grant, no service allowlist: every path refuses before inference', async () => {
    await expect(reserveAgentHold(serviceA, reserveBody({ grant_id: randomUUID() }), clock, db as any)).rejects.toMatchObject({ code: 'agent_grant_required', status: 403 });
    await expect(grant()).rejects.toMatchObject({ code: 'model_not_priced', status: 422 });
    await expect(appendAgentTariff(admin, { version: 'bad', models: [{ model: 'x', input_pico_per_token: '1', output_pico_per_token: '1', max_input_tokens: '1', max_output_tokens: '1', cached_input_pico_per_token: '1' }] }, db as any)).rejects.toMatchObject({ code: 'invalid_tariff' });
    const r = await appendAgentTariff(admin, { version: 't1', models: [
      { model: 'm/plain', input_pico_per_token: '100000', output_pico_per_token: '600000', max_input_tokens: '200000', max_output_tokens: '32000' },
      { model: 'm/sub', input_pico_per_token: '100000', output_pico_per_token: '600000', cached_input_pico_per_token: '10000', cached_input_semantics: 'subset', max_input_tokens: '200000', max_output_tokens: '32000' },
      { model: 'm/add', input_pico_per_token: '100000', output_pico_per_token: '600000', cached_input_pico_per_token: '10000', cached_input_semantics: 'additional', request_pico: '1000', max_input_tokens: '200000', max_output_tokens: '32000' },
    ] }, db as any);
    expect(r.created).toBe(true);
    // Identical replay is idempotent; a changed rate under the same version conflicts; rows are immutable at the database.
    expect((await appendAgentTariff(admin, { version: 't1', models: [
      { model: 'm/add', input_pico_per_token: '100000', output_pico_per_token: '600000', cached_input_pico_per_token: '10000', cached_input_semantics: 'additional', request_pico: '1000', max_input_tokens: '200000', max_output_tokens: '32000' },
      { model: 'm/sub', input_pico_per_token: '100000', output_pico_per_token: '600000', cached_input_pico_per_token: '10000', cached_input_semantics: 'subset', max_input_tokens: '200000', max_output_tokens: '32000' },
      { model: 'm/plain', input_pico_per_token: '100000', output_pico_per_token: '600000', max_input_tokens: '200000', max_output_tokens: '32000' },
    ] }, db as any)).created).toBe(false);
    await expect(appendAgentTariff(admin, { version: 't1', models: [{ model: 'm/plain', input_pico_per_token: '1', output_pico_per_token: '1', max_input_tokens: '1', max_output_tokens: '1' }] }, db as any)).rejects.toMatchObject({ code: 'tariff_conflict', status: 409 });
    await expect(db`UPDATE hosting_agent_tariff_models SET input_pico=1 WHERE version='t1'`).rejects.toThrow();
    await expect(db`DELETE FROM hosting_agent_tariffs WHERE version='t1'`).rejects.toThrow();
    // Grants: only the owning payer, only an allowlisted service, only an agent that is a member.
    await expect(grant({}, other)).rejects.toMatchObject({ code: 'agent_grant_forbidden', status: 403 });
    await expect(grant({ service_npub: rogue })).rejects.toMatchObject({ code: 'agent_service_not_allowed', status: 403 });
    await expect(grant({ agent_npub: other })).rejects.toMatchObject({ code: 'agent_not_in_workspace', status: 422 });
    await expect(grant({ model: 'm/unknown' })).rejects.toMatchObject({ code: 'model_not_priced' });
    await expect(grant({ expires_at: new Date(base.getTime() - 1000).toISOString() })).rejects.toMatchObject({ code: 'invalid_expiry' });
    await expect(grant({ extra: 1 })).rejects.toMatchObject({ code: 'invalid_body' });
    const body = { idempotency_key: 'g-replay-0001', workspace_id: workspace, agent_npub: agent, service_npub: serviceA, model: 'm/plain', tariff_version: 't1', daily_cap_units: '100000000000', expires_at: new Date(base.getTime() + 30 * 86_400_000).toISOString() };
    const first = await createAgentGrant(owner, body, clock, db as any);
    expect(first.replayed).toBe(false);
    expect((await createAgentGrant(owner, body, clock, db as any)).replayed).toBe(true);
    await expect(createAgentGrant(owner, { ...body, daily_cap_units: '5' }, clock, db as any)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    grantId = first.grant.id;
  });

  test('reserve computes units from the frozen tariff, is idempotent per call, and binds every grant field', async () => {
    const body = reserveBody({ call_id: 'idem-1' });
    const a = await reserveAgentHold(serviceA, body, clock, db as any);
    // 1000*1e5 + 500*6e5 = 4e8 pico -> 57,600,000 units, exactly.
    expect(a.hold).toMatchObject({ state: 'held', reserved_units: '57600000', day: '2026-12-01' });
    expect(new Date(a.hold.reconcile_by).getTime()).toBe(base.getTime() + 7 * 86_400_000);
    const b = await reserveAgentHold(serviceA, body, clock, db as any);
    expect(b.replayed).toBe(true); expect(b.hold.hold_id).toBe(a.hold.hold_id);
    await expect(reserveAgentHold(serviceA, { ...body, max_output_tokens: '501' }, clock, db as any)).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
    expect((await db`SELECT 1 FROM hosting_agent_holds WHERE call_id='idem-1'`).length).toBe(1);
    // Another allowlisted host cannot spend this host's grant, nor see its hold; an unlisted host is refused outright.
    await expect(reserve(serviceB)).rejects.toMatchObject({ code: 'agent_grant_required', status: 403 });
    await expect(reserve(rogue)).rejects.toMatchObject({ code: 'agent_service_not_allowed', status: 403 });
    await expect(reserveAgentHold(serviceB, body, clock, db as any)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(readAgentHold(serviceB, { account_id: account, call_id: 'idem-1' }, db as any)).rejects.toMatchObject({ status: 404 });
    expect((await readAgentHold(serviceA, { account_id: account, hold_id: a.hold.hold_id }, db as any)).hold.state).toBe('held');
    // Each bound field is checked against the grant, never trusted from the request.
    for (const over of [{ agent_npub: other }, { workspace_id: randomUUID() }, { model: 'm/sub' }, { tariff_version: 't2' }, { account_id: randomUUID() }])
      await expect(reserve(serviceA, over)).rejects.toThrow();
    // Bounds and unsupported cached rates refuse before any hold exists.
    await expect(reserve(serviceA, { max_output_tokens: '32001' })).rejects.toMatchObject({ code: 'token_bound_exceeded', status: 422 });
    await expect(reserve(serviceA, { max_cached_input_tokens: '1' })).rejects.toMatchObject({ code: 'cached_rate_unsupported', status: 422 });
    await expect(reserve(serviceA, { max_input_tokens: '1.5' })).rejects.toMatchObject({ code: 'invalid_tokens' });
    await expect(reserve(serviceA, { max_input_tokens: 1000 })).rejects.toMatchObject({ code: 'invalid_tokens' });
    await expect(reserve(serviceA, { call_id: 'bad id!' })).rejects.toMatchObject({ code: 'invalid_call_id' });
    await expect(reserve(serviceA, { client_dollars: '5' })).rejects.toMatchObject({ code: 'invalid_body' });
  });

  test('revoked and expired grants stop new reserves; ownership change stops them immediately', async () => {
    const g = await grant();
    const mine = (over: Record<string, unknown> = {}) => reserve(serviceA, { grant_id: g.grant.id, ...over });
    await mine();
    await revokeAgentGrant(owner, g.grant.id, db as any);
    await expect(mine()).rejects.toMatchObject({ code: 'agent_grant_required' });
    await expect(revokeAgentGrant(other, g.grant.id, db as any)).rejects.toMatchObject({ status: 404 });
    const e = await grant();
    now = new Date(base.getTime() + 31 * 86_400_000);
    try { await expect(reserve(serviceA, { grant_id: e.grant.id })).rejects.toMatchObject({ code: 'agent_grant_required' }); } finally { now = base; }
    const t = await grant();
    await db`UPDATE flightdeck_pg_workspaces SET workspace_owner_npub=${other} WHERE id=${workspace}`;
    try { await expect(reserve(serviceA, { grant_id: t.grant.id })).rejects.toMatchObject({ code: 'agent_grant_required' }); }
    finally { await db`UPDATE flightdeck_pg_workspaces SET workspace_owner_npub=${owner} WHERE id=${workspace}`; }
    await reserve(serviceA, { grant_id: t.grant.id });
    // A replacement grant for the same agent/service/model supersedes the old one under the account lock.
    expect((await db`SELECT revoked_at FROM hosting_agent_grants WHERE id=${g.grant.id}`)[0]!.revoked_at).not.toBeNull();
    expect((await db`SELECT revoked_at FROM hosting_agent_grants WHERE id=${e.grant.id}`)[0]!.revoked_at).not.toBeNull();
    grantId = t.grant.id;
  });

  test('settlement is computed from the tariff once, ledger-backed and replay-safe; settle needs a recorded dispatch', async () => {
    const held = (await reserve(serviceA)).hold;
    await expect(settle(held)).rejects.toMatchObject({ code: 'hold_not_dispatched', status: 409 });
    await dispatchAgentHold(serviceA, { account_id: account, call_id: held.call_id }, clock, db as any);
    const before = await paidUnits();
    const first = await settle(held, obs({ input_tokens: '800', output_tokens: '100' }));
    // 800*1e5 + 100*6e5 = 1.4e8 pico -> 20,160,000 units.
    expect(first.hold).toMatchObject({ state: 'settled', settled_units: '20160000', overrun_units: '0' });
    expect(before - (await paidUnits())).toBe(20_160_000n);
    const [entry] = await db`SELECT * FROM hosting_ledger WHERE idempotency_key=${`agent_hold:${held.hold_id}`}`;
    expect(entry).toMatchObject({ kind: 'agent_usage', amount_units: '-20160000', workspace_id: workspace });
    const replay = await settle(held, obs({ input_tokens: '800', output_tokens: '100' }));
    expect(replay.replayed).toBe(true);
    expect(before - (await paidUnits())).toBe(20_160_000n);
    await expect(settle(held, obs({ input_tokens: '801', output_tokens: '100' }))).rejects.toMatchObject({ code: 'settlement_conflict' });
    await expect(settle(held, obs(), serviceB)).rejects.toMatchObject({ status: 404 });
    await expect(releaseAgentHold(serviceA, { account_id: account, call_id: held.call_id, basis: 'never_dispatched' }, clock, db as any)).rejects.toMatchObject({ code: 'hold_final' });
    await expect(db`UPDATE hosting_agent_holds SET state='held' WHERE id=${held.hold_id}`).rejects.toThrow();
    await expect(db`DELETE FROM hosting_agent_holds WHERE id=${held.hold_id}`).rejects.toThrow();
    // Zero-usage settlement is valid and charges nothing.
    const zero = await dispatched();
    expect((await settle(zero, obs({ input_tokens: '0', output_tokens: '0' }))).hold).toMatchObject({ state: 'settled', settled_units: '0' });
    expect((await db`SELECT 1 FROM hosting_ledger WHERE idempotency_key=${`agent_hold:${zero.hold_id}`}`).length).toBe(0);
  });

  test('cached input: subset vs additional are distinct, and an unsupported rate refuses', async () => {
    const g = await grant({ model: 'm/sub' }), g2 = await grant({ model: 'm/add' });
    const sub = (await dispatched({ grant_id: g.grant.id, model: 'm/sub', max_cached_input_tokens: '1000' }));
    // subset: (1000-400)*1e5 + 400*1e4 + 100*6e5 = 6e7+4e6+6e7 = 1.24e8 pico -> 17,856,000
    expect((await settle(sub, obs({ input_tokens: '1000', cached_input_tokens: '400', output_tokens: '100' }))).hold.settled_units).toBe('17856000');
    const bad = await dispatched({ grant_id: g.grant.id, model: 'm/sub' });
    await expect(settle(bad, obs({ input_tokens: '10', cached_input_tokens: '11' }))).rejects.toMatchObject({ code: 'invalid_observation' });
    const add = await dispatched({ grant_id: g2.grant.id, model: 'm/add', max_cached_input_tokens: '1000' });
    // additional: 1000*1e5 + 400*1e4 + 100*6e5 + 1000 = 1.64e8+1000 pico -> ceil(164001000*18/125)=23,616,144
    expect((await settle(add, obs({ input_tokens: '1000', cached_input_tokens: '400', output_tokens: '100' }))).hold.settled_units).toBe('23616144');
    const plain = await dispatched();
    await expect(settle(plain, obs({ cached_input_tokens: '1' }))).rejects.toMatchObject({ code: 'cached_rate_unsupported', status: 422 });
    expect((await readAgentHold(serviceA, { account_id: account, call_id: plain.call_id }, db as any)).hold.state).toBe('dispatched');
  });

  test('release only on proof: never-dispatched or an allowlisted explicit rejection; everything uncertain stays held', async () => {
    const free = (await reserve(serviceA)).hold;
    const heldBefore = BigInt((await accountStorageSummary(db as any, account, now)).balances.agent_holds.units!);
    expect((await releaseAgentHold(serviceA, { account_id: account, call_id: free.call_id, basis: 'never_dispatched' }, clock, db as any)).hold.state).toBe('released');
    expect(BigInt((await accountStorageSummary(db as any, account, now)).balances.agent_holds.units!)).toBe(heldBefore - BigInt(free.reserved_units));
    expect((await releaseAgentHold(serviceA, { account_id: account, call_id: free.call_id, basis: 'never_dispatched' }, clock, db as any)).hold.state).toBe('released');
    await expect(settle(free)).rejects.toMatchObject({ code: 'hold_final' });
    // After dispatch a "never dispatched" claim is not accepted.
    const sent = await dispatched();
    await expect(releaseAgentHold(serviceA, { account_id: account, call_id: sent.call_id, basis: 'never_dispatched' }, clock, db as any)).rejects.toMatchObject({ code: 'release_not_proven' });
    // Generic 4xx/5xx and unknown codes are not proof of no billable work.
    for (const ev of [{ provider: 'openrouter', http_status: '500', error_code: 'internal' }, { provider: 'openrouter', http_status: '400', error_code: 'bad' }, { provider: 'openrouter', http_status: '401', error_code: 'other' }, { provider: 'other', http_status: '401', error_code: 'invalid_api_key' }])
      await expect(releaseAgentHold(serviceA, { account_id: account, call_id: sent.call_id, basis: 'provider_rejection', evidence: ev }, clock, db as any)).rejects.toMatchObject({ code: 'release_not_proven' });
    await expect(releaseAgentHold(serviceA, { account_id: account, call_id: sent.call_id, basis: 'provider_rejection' } as any, clock, db as any)).rejects.toMatchObject({ status: 400 });
    // Provider rejection evidence on a hold that was never dispatched is also refused.
    const undispatched = (await reserve(serviceA)).hold;
    await expect(releaseAgentHold(serviceA, { account_id: account, call_id: undispatched.call_id, basis: 'provider_rejection', evidence: { provider: 'openrouter', http_status: '401', error_code: 'invalid_api_key' } }, clock, db as any)).rejects.toMatchObject({ code: 'release_not_proven' });
    const ok = await releaseAgentHold(serviceA, { account_id: account, call_id: sent.call_id, basis: 'provider_rejection', evidence: { provider: 'openrouter', http_status: 401, error_code: 'invalid_api_key', request_id: 'r1' } }, clock, db as any);
    expect(ok.hold).toMatchObject({ state: 'released', release_basis: 'provider_rejection' });
    // Uncertain outcomes persist as held with no timeout release, long past reconcile_by.
    const unsure = await dispatched();
    expect((await markAgentHoldPending(serviceA, { account_id: account, call_id: unsure.call_id, reason: 'worker restarted mid-call' }, clock, db as any)).hold.state).toBe('pending_reconcile');
    now = new Date(base.getTime() + 400 * 86_400_000);
    try {
      expect((await readAgentHold(serviceA, { account_id: account, call_id: unsure.call_id }, db as any)).hold.state).toBe('pending_reconcile');
      expect(BigInt((await accountStorageSummary(db as any, account, now)).balances.agent_holds.units!)).toBeGreaterThanOrEqual(BigInt(unsure.reserved_units));
    } finally { now = base; }
    await expect(releaseAgentHold(serviceA, { account_id: account, call_id: unsure.call_id, basis: 'never_dispatched' }, clock, db as any)).rejects.toMatchObject({ code: 'release_not_proven' });
    expect((await settle(unsure)).hold.state).toBe('settled');
  });

  test('true-cost overrun settles in full, flags it, and blocks later admission until an admin clears it', async () => {
    const g = await grant(); grantId = g.grant.id;
    const h = await dispatched({ grant_id: g.grant.id, max_input_tokens: '10', max_output_tokens: '10' });
    const r = await settle(h, obs({ input_tokens: '1000', output_tokens: '500' }));
    expect(r.hold.settled_units).toBe('57600000');
    expect(BigInt(r.hold.overrun_units)).toBe(57_600_000n - BigInt(h.reserved_units));
    await expect(reserve(serviceA, { grant_id: g.grant.id })).rejects.toMatchObject({ code: 'agent_spend_blocked', status: 409 });
    await expect(reserve(serviceA)).rejects.toMatchObject({ code: 'agent_spend_blocked' });
    expect(await clearAgentSpendBlock(admin, account, db as any)).toEqual({ cleared: 1 });
    await reserve(serviceA);
  });

  test('daily cap counts held plus settled per UTC day and resets on the next day', async () => {
    const g = await grant({ agent_npub: agent2, daily_cap_units: '100000000' }); // two reserves of 57.6M do not fit
    const mine = (o: Record<string, unknown> = {}) => reserve(serviceA, { grant_id: g.grant.id, agent_npub: agent2, ...o });
    const a = (await mine()).hold;
    await expect(mine()).rejects.toMatchObject({ code: 'daily_cap_exceeded', status: 409 });
    await dispatchAgentHold(serviceA, { account_id: account, call_id: a.call_id }, clock, db as any);
    await settle(a, obs({ input_tokens: '100', output_tokens: '100' })); // settled 1.0e7*... now far under the reserve: usage = settled units
    const small = (await mine({ max_input_tokens: '1', max_output_tokens: '1' })).hold; // still fits
    expect(BigInt(small.reserved_units)).toBeGreaterThan(0n);
    await mine(); // 57.6M + settled(100*1e5+100*6e5=7e7 pico -> 10.08M) + small < 100M
    await expect(mine()).rejects.toMatchObject({ code: 'daily_cap_exceeded' });
    now = new Date('2026-12-02T00:00:01Z');
    try { expect((await mine()).hold.day).toBe('2026-12-02'); } finally { now = base; }
    expect((await call('GET', '/grants', ownerKey)).json.grants.find((x: any) => x.id === g.grant.id).day_used_units).toBeDefined();
  });

  test('concurrent reserves cannot over-admit: held units come off agent-available funds', async () => {
    const [acct2] = await db`INSERT INTO hosting_accounts(owner_actor_id,opened_by,promo_units,paid_units) VALUES(${(await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${other},'human') RETURNING id`)[0]!.id},'onboarding',0,0) RETURNING id`;
    const ws2 = randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${ws2},'tower',${ws2},${other},'holds-fixture','Holds2')`;
    const agentActor = (await db`SELECT id FROM flightdeck_pg_actors WHERE npub=${agent}`)[0]!.id;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${ws2},${agentActor},'agent')`;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${ws2},${acct2!.id})`;
    await enrollPeakStorage(db as any, ws2, acct2!.id, null);
    const h = Math.floor(Date.now() / HOUR) * HOUR;
    await db`UPDATE hosting_storage_enrollments SET activated_at=${new Date(h - 30 * 60_000)},intro_ends_at=${new Date(h - HOUR)} WHERE workspace_id=${ws2}`;
    await takeStorageAnchor(ws2, db as any);
    const protectedUnits = BigInt((await accountStorageSummary(db as any, acct2!.id, now)).balances.protected_storage_units);
    const R = 57_600_000n;
    await db`UPDATE hosting_accounts SET paid_units=${(protectedUnits + R * 5n / 2n).toString()} WHERE id=${acct2!.id}`; // room for exactly two holds
    const g2 = await createAgentGrant(other, { idempotency_key: 'g-conc-0001', workspace_id: ws2, agent_npub: agent, service_npub: serviceA, model: 'm/plain', tariff_version: 't1', daily_cap_units: '100000000000', expires_at: new Date(base.getTime() + 86_400_000).toISOString() }, clock, db as any);
    const tries = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => reserveAgentHold(serviceA, { ...reserveBody({ account_id: acct2!.id, workspace_id: ws2, grant_id: g2.grant.id, call_id: `conc-${i}` }) }, clock, db as any)));
    expect(tries.filter(t => t.status === 'fulfilled').length).toBe(2);
    expect(tries.filter(t => t.status === 'rejected').every(t => (t as PromiseRejectedResult).reason.code === 'agent_funds_insufficient')).toBe(true);
    const s = await accountStorageSummary(db as any, acct2!.id, now);
    expect(s.balances.agent_holds).toEqual({ registered: true, units: (R * 2n).toString() });
    expect(BigInt(s.balances.agent_available_units)).toBe(R / 2n);
  });

  test('storage coverage gates admission; the agent_holds reserve source is real and gates refunds', async () => {
    expect(registerAgentHoldsReserve()).toBe(offHolds);
    {
      const s = await accountStorageSummary(db as any, account, now);
      expect(s.balances.agent_holds.registered).toBe(true);
      const open = (await db`SELECT COALESCE(sum(reserved_units),0)::text AS u FROM hosting_agent_holds WHERE account_id=${account} AND state IN ('held','dispatched','pending_reconcile')`)[0]!.u as string;
      expect(s.balances.agent_holds.units).toBe(open);
      const paid = await paidUnits();
      expect(await availableRefundableUnits(db as any, account)).toBe(paid - BigInt(s.balances.protected_storage_units) - BigInt(open));
    }
    // Without Git coverage (the real production state today) every reserve is refused: no fake registration.
    offGit();
    try { await expect(reserve(serviceA)).rejects.toMatchObject({ code: 'storage_coverage_incomplete', status: 503 }); }
    finally { offGit = registerMeteredStorageCategory(gitStandIn()); }
    // Insufficient funds are refused with the same closed error, not a partial hold.
    const before = (await db`SELECT count(*)::int AS n FROM hosting_agent_holds`)[0]!.n;
    await db`UPDATE hosting_accounts SET paid_units=1000 WHERE id=${account}`;
    try { await expect(reserve(serviceA)).rejects.toMatchObject({ code: 'agent_funds_insufficient', status: 402 }); }
    finally { await grantHostingCredit(account, 10_000, `top-${randomUUID().slice(0, 8)}`, 'Holds fixture top-up', owner, db as any); }
    expect((await db`SELECT count(*)::int AS n FROM hosting_agent_holds`)[0]!.n).toBe(before);
  });

  test('re-granting cannot reset the day: usage is summed per agent across grants; removed agents cannot spend', async () => {
    const before = await grant({ agent_npub: agent2, daily_cap_units: '100000000' });
    const used = BigInt((await listAgentGrants(owner, clock, db as any)).find(x => x.id === before.grant.id)!.day_used_units);
    expect(used).toBeGreaterThan(0n); // earlier holds of the same agent count toward the new grant
    await expect(reserve(serviceA, { grant_id: before.grant.id, agent_npub: agent2 })).rejects.toMatchObject({ code: 'daily_cap_exceeded' });
    // A larger replacement cap is the payer's explicit choice; usage still carries over rather than restarting from zero.
    const bigger = await grant({ agent_npub: agent2, daily_cap_units: String(used + 60_000_000n) });
    expect((await reserve(serviceA, { grant_id: bigger.grant.id, agent_npub: agent2 })).hold.state).toBe('held');
    await expect(reserve(serviceA, { grant_id: bigger.grant.id, agent_npub: agent2 })).rejects.toMatchObject({ code: 'daily_cap_exceeded' });
    // Authority is re-derived from current membership at reserve time.
    const actor = (await db`SELECT id FROM flightdeck_pg_actors WHERE npub=${agent2}`)[0]!.id;
    await db`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspace} AND actor_id=${actor}`;
    try { await expect(reserve(serviceA, { grant_id: bigger.grant.id, agent_npub: agent2 })).rejects.toMatchObject({ code: 'agent_grant_required', status: 403 }); }
    finally { await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace},${actor},'agent')`; }
  });

  test('revoke takes the account lock: it serialises with reserve and nothing is admitted after it', async () => {
    const g = await grant({ agent_npub: agent });
    grantId = g.grant.id;
    let release!: () => void, locked!: () => void;
    const lockHeld = new Promise<void>(r => { locked = r; });
    const holder = db.begin(async tx => { await tx`SELECT id FROM hosting_accounts WHERE id=${account} FOR UPDATE`; locked(); await new Promise<void>(r => { release = r; }); });
    await lockHeld;
    let revoked = false, reserved: 'pending' | 'ok' | 'refused' = 'pending';
    const rev = revokeAgentGrant(owner, g.grant.id, db as any).then(() => { revoked = true; });
    await new Promise(r => setTimeout(r, 150));
    const res = reserve(serviceA, { grant_id: g.grant.id }).then(() => { reserved = 'ok'; }, () => { reserved = 'refused'; });
    await new Promise(r => setTimeout(r, 300));
    expect(revoked).toBe(false); expect(reserved).toBe('pending'); // both are waiting on the account lock the holder owns
    release(); await holder; await rev; await res;
    expect(revoked).toBe(true); expect(reserved).toBe('refused'); // queued behind the revoke, the reserve saw it
    // And a burst of reserves racing a revoke never admits one after the revoke row is committed.
    const g2 = await grant({ agent_npub: agent }); grantId = g2.grant.id;
    const burst = Array.from({ length: 6 }, () => reserve(serviceA, { grant_id: g2.grant.id }).then(() => 'ok', () => 'no'));
    await revokeAgentGrant(owner, g2.grant.id, db as any);
    await Promise.all(burst);
    await expect(reserve(serviceA, { grant_id: g2.grant.id })).rejects.toMatchObject({ code: 'agent_grant_required' });
    grantId = (await grant({ agent_npub: agent })).grant.id;
  });

  test('disabling the feature closes admission but never traps held funds; an unknown holds source fails closed', async () => {
    const h = await dispatched();
    const pendingOne = (await reserve(serviceA)).hold;
    process.env.HOSTING_AGENT_HOLDS_ENABLED = 'false';
    try {
      await expect(reserve(serviceA)).rejects.toMatchObject({ code: 'agent_holds_disabled', status: 503 });
      await expect(grant()).rejects.toMatchObject({ code: 'agent_holds_disabled' });
      expect((await readAgentHold(serviceA, { account_id: account, call_id: h.call_id }, db as any)).hold.state).toBe('dispatched');
      expect((await settle(h)).hold.state).toBe('settled');
      expect((await releaseAgentHold(serviceA, { account_id: account, call_id: pendingOne.call_id, basis: 'never_dispatched' }, clock, db as any)).hold.state).toBe('released');
      await expect(settle(h, obs(), rogue)).rejects.toMatchObject({ code: 'agent_service_not_allowed' }); // still allowlist-gated
      expect((await call('GET', '/grants', ownerKey)).status).toBe(200);
      await revokeAgentGrant(owner, grantId, db as any); // a payer can always stop spend
      grantId = '00000000-0000-4000-8000-000000000000';
    } finally { process.env.HOSTING_AGENT_HOLDS_ENABLED = 'true'; }
    grantId = (await grant()).grant.id;
    // Without a registered agent_holds source the held amount is unknown: no admission, explicit reason, no hold written.
    offHolds();
    try {
      const n = (await db`SELECT count(*)::int AS n FROM hosting_agent_holds`)[0]!.n;
      await expect(reserve(serviceA)).rejects.toMatchObject({ code: 'agent_holds_unavailable', status: 503 });
      expect((await accountStorageSummary(db as any, account, now)).admission).toEqual({ agent_spend_allowed: false, reason: 'agent_holds_unavailable' });
      expect((await db`SELECT count(*)::int AS n FROM hosting_agent_holds`)[0]!.n).toBe(n);
    } finally { offHolds = registerAgentHoldsReserve(); }
    await reserve(serviceA);
  });

  test('request bodies are bounded while streaming: oversized, endless and chunked bodies are cut off, not buffered', async () => {
    const url = 'http://localhost/api/v4/agent-holds/holds/reserve';
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024).fill(97)); if (pulled > 5000) c.close(); } });
    const r = await app.request(url, { method: 'POST', body: endless, duplex: 'half' } as any);
    expect(r.status).toBe(413); expect((await r.json()).code).toBe('body_too_large');
    expect(pulled).toBeLessThan(40); // ~8 KiB ceiling, never the whole 5 MB
    const declared = await app.request(url, { method: 'POST', headers: { 'content-length': '999999' }, body: '{}' });
    expect(declared.status).toBe(413);
    // The tariff route has its own, larger ceiling; hosted-backup PUT is 1 KiB.
    pulled = 0;
    const big = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(4096).fill(97)); if (pulled > 5000) c.close(); } });
    expect((await app.request('http://localhost/api/v4/identity-backup/someone', { method: 'PUT', body: big, duplex: 'half' } as any)).status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  test('HTTP: strict direct signatures, closed by default, exact bodies and OpenAPI', async () => {
    const b = reserveBody({ call_id: `http-${randomUUID().slice(0, 8)}` });
    expect((await call('POST', '/holds/reserve', null, b)).status).toBe(401);
    const created = await call('POST', '/holds/reserve', serviceAKey, b);
    expect(created.status).toBe(201); expect(created.json.reserved_units).toBe('57600000');
    expect((await call('POST', '/holds/reserve', serviceAKey, b)).status).toBe(200);
    expect((await call('POST', '/holds/reserve', rogueKey, b)).json.code).toBe('agent_service_not_allowed');
    expect((await call('POST', '/holds/reserve', serviceBKey, reserveBody())).json.code).toBe('agent_grant_required');
    expect((await call('POST', '/holds/dispatch', serviceAKey, { account_id: account, call_id: b.call_id })).json.state).toBe('dispatched');
    expect((await call('GET', `/holds?account_id=${account}&call_id=${b.call_id}`, serviceAKey)).json.state).toBe('dispatched');
    expect((await call('GET', `/holds?account_id=${account}&call_id=${b.call_id}`, serviceBKey)).status).toBe(404);
    expect((await call('GET', `/holds?account_id=${account}&call_id=${b.call_id}`, ownerKey)).status).toBe(403);
    expect((await call('POST', '/holds/settle', serviceAKey, { account_id: account, call_id: b.call_id, observation: obs() })).json.state).toBe('settled');
    // Payer routes need the owner's own signature; the runtime service cannot create its own grant.
    expect((await call('POST', '/grants', serviceAKey, { idempotency_key: 'g-svc-00001', workspace_id: workspace, agent_npub: agent, service_npub: serviceA, model: 'm/plain', tariff_version: 't1', daily_cap_units: '5', expires_at: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(403);
    expect((await call('GET', '/grants', ownerKey)).status).toBe(200);
    // Tariff and block clearing are platform-admin only.
    expect((await call('POST', '/tariffs', ownerKey, { version: 'x', models: [] })).status).toBe(403);
    expect((await call('POST', `/blocks/${account}/clear`, ownerKey, {})).status).toBe(403);
    expect((await call('POST', `/blocks/${account}/clear`, adminKey, {})).status).toBe(200);
    // Disabled by default.
    process.env.HOSTING_AGENT_HOLDS_ENABLED = 'false';
    try { const r = await call('POST', '/holds/reserve', serviceAKey, reserveBody()); expect(r.status).toBe(503); expect(r.json.code).toBe('agent_holds_disabled'); }
    finally { process.env.HOSTING_AGENT_HOLDS_ENABLED = 'true'; }
    const paths = Object.keys((buildOpenApiDocument('http://localhost') as any).paths);
    for (const p of ['/api/v4/agent-holds/holds/reserve', '/api/v4/agent-holds/holds/dispatch', '/api/v4/agent-holds/holds/release', '/api/v4/agent-holds/holds/settle', '/api/v4/agent-holds/grants']) expect(paths).toContain(p);
  });
});
