import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { hostingWriteBlock } from '../src/services/hosting-billing';
import { GB, enrollPeakStorage, takeStorageAnchor } from '../src/services/hosting-storage';
import { accountLifecycle, acknowledgeLifecycleNotice, evaluateAllLifecycleNotices, evaluateLifecycleNotices, listLifecycleNotices, READ_ONLY_DAYS } from '../src/services/hosting-lifecycle';
import { openOwnerAccount } from '../src/services/onboarding';
import { buildOpenApiDocument } from '../src/openapi';

// Runs only against a dedicated disposable PostgreSQL: LIFECYCLE_TEST_PORT=<free port>.
const port = Number(process.env.LIFECYCLE_TEST_PORT);
const HOUR = 3_600_000, DAY = 24 * HOUR;
const keys = [randomBytes(32), randomBytes(32), randomBytes(32)] as const;
const [ownerKey, otherKey, strangerKey] = keys;
const [owner, other] = [ownerKey, otherKey].map(k => nip19.npubEncode(getPublicKey(k))) as [string, string];
const app = createApp();

describe.skipIf(!port || port === 5432)('read-only lifecycle state and notices on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_lifecycle_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  const state: Record<string, { account: string; workspace: string }> = {};

  /** An account with one activated, measured workspace whose introduction is over, so each hour costs exactly 1GB units (the minimum). */
  async function fixture(npub: string, label: string) {
    const [actor] = await db`SELECT id FROM flightdeck_pg_actors WHERE npub=${npub}` as any;
    const account = (await openOwnerAccount(npub, db as any)).account_id;
    const ws = randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${ws},'tower',${ws},${npub},'lifecycle-fixture',${label})`;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${ws},${actor.id},'owner')`;
    await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${ws},${account})`;
    await enrollPeakStorage(db as any, ws, account, null);
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    await db`UPDATE hosting_storage_enrollments SET activated_at=${new Date(hour - 40 * DAY)},intro_ends_at=${new Date(hour - 10 * DAY)} WHERE workspace_id=${ws}`;
    await takeStorageAnchor(ws, db as any);
    state[label] = { account, workspace: ws };
    return { account, ws };
  }
  /** Spendable balance worth exactly `hours` of minimum-rate storage. */
  const runwayOf = (account: string, hours: number) => db`UPDATE hosting_accounts SET paid_units=${(BigInt(hours) * GB + 1n).toString()},promo_units='0',depleted_at=NULL WHERE id=${account}`;
  const kinds = async (account: string) => (await listLifecycleNotices(db as any, account)).map(n => n.kind).sort();
  async function call(method: 'GET' | 'POST', path: string, key: Uint8Array, body?: unknown) {
    const url = `http://localhost/api/v4/onboarding${path}`;
    const raw = method === 'POST' ? JSON.stringify(body ?? {}) : undefined;
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(), tags: [['u', url], ['method', method], ...(raw ? [['payload', createHash('sha256').update(raw).digest('hex')]] : [])] }, key);
    const response = await app.request(url, { method, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` }, body: raw });
    return { status: response.status, json: (await response.json().catch(() => ({}))) as any };
  }

  beforeAll(async () => {
    process.env.ONBOARDING_ENABLED = 'true';
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    for (const npub of [owner, other]) await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human')`;
  });
  afterAll(async () => { delete process.env.ONBOARDING_ENABLED; await closeDb(); const root = postgres({ ...conn, database: 'postgres' }); await root.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await root.end(); });

  test('runway warnings: one notice per threshold and funding cycle, most urgent only, concurrency-safe, restarted by a top-up', async () => {
    const { account } = await fixture(owner, 'Warn');
    await runwayOf(account, 100 * 24);
    expect((await accountLifecycle(db as any, account)).state).toBe('active');
    expect((await evaluateLifecycleNotices(db as any, account)).created).toEqual([]);
    await runwayOf(account, 29 * 24);
    expect((await accountLifecycle(db as any, account)).state).toBe('warning');
    const results = await Promise.all(Array.from({ length: 8 }, () => evaluateLifecycleNotices(db as any, account)));
    expect(results.flatMap(r => r.created)).toEqual(['runway_30d']);
    await evaluateAllLifecycleNotices(db as any); await evaluateAllLifecycleNotices(db as any);
    expect(await kinds(account)).toEqual(['runway_30d']);
    await runwayOf(account, 5 * 24);
    expect((await evaluateLifecycleNotices(db as any, account)).created).toEqual(['runway_7d']);
    await runwayOf(account, 12);
    expect((await evaluateLifecycleNotices(db as any, account)).created).toEqual(['runway_1d']);
    expect(await kinds(account)).toEqual(['runway_1d', 'runway_30d', 'runway_7d']);
    // A top-up is a new funding cycle: the same threshold warns again later, never twice in one cycle.
    await db`INSERT INTO hosting_ledger(account_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason) VALUES(${account},'admin',${GB.toString()},0,0,${randomUUID()},'fixture top-up')`;
    await runwayOf(account, 20 * 24);
    expect((await evaluateLifecycleNotices(db as any, account)).created).toEqual(['runway_30d']);
    await evaluateLifecycleNotices(db as any, account);
    expect((await kinds(account)).filter(k => k === 'runway_30d').length).toBe(2);
    // Evaluation only records notices: balances are untouched.
    const [after] = await db`SELECT paid_units FROM hosting_accounts WHERE id=${account}`;
    expect(BigInt(after!.paid_units)).toBe(20n * 24n * GB + 1n);
  });

  test('read-only: exact deadline, free export, no debt or back-charge, immediate notice; nothing is deleted', async () => {
    const { account, ws } = await fixture(other, 'ReadOnly');
    await db`UPDATE hosting_accounts SET paid_units='0',promo_units='0',depleted_at=${new Date(Date.now() - 3 * DAY)} WHERE id=${account}`;
    const view = await accountLifecycle(db as any, account);
    expect(view.state).toBe('read_only');
    expect(view.read_only).toMatchObject({ writes_blocked: true, export_available: true, billing: { new_debt: false, exit_fee: false, back_charge_on_top_up: false }, resume: { by: 'top_up', charging: 'prospective_only' } });
    expect(view.read_only!.days_remaining).toBe(READ_ONLY_DAYS - 3);
    expect(new Date(view.read_only!.ends_at).getTime() - new Date(view.read_only!.entered_at).getTime()).toBe(READ_ONLY_DAYS * DAY);
    expect(view.removal).toMatchObject({ due: false, automatic_deletion: false, live_removal_performed: false });
    expect(view.offline_recovery).toMatchObject({ available: false, verified: false, promised: false });
    expect(view.export_complete).toBe(false);
    expect((await evaluateLifecycleNotices(db as any, account)).created).toEqual(['read_only_entered']);
    expect(await evaluateLifecycleNotices(db as any, account).then(r => r.created)).toEqual([]);
    expect(await hostingWriteBlock(ws, db as any)).toMatchObject({ status: 402, automatic_deletion: false });
    // After the free period the state says removal is due but performs nothing and keeps the workspace readable data intact.
    await db`UPDATE hosting_accounts SET depleted_at=${new Date(Date.now() - 31 * DAY)} WHERE id=${account}`;
    const due = await accountLifecycle(db as any, account);
    expect(due.state).toBe('removal_due');
    expect(due.removal).toMatchObject({ due: true, automatic_deletion: false, live_removal_performed: false });
    expect((await evaluateLifecycleNotices(db as any, account)).created.sort()).toEqual(['read_only_entered', 'removal_due']);
    expect((await db`SELECT 1 FROM flightdeck_pg_workspaces WHERE id=${ws}`).length).toBe(1);
    // A top-up resumes the account: writes are unblocked and a later depletion is a new cycle with a fresh notice.
    await runwayOf(account, 100 * 24);
    expect((await accountLifecycle(db as any, account)).state).toBe('active');
    expect(await hostingWriteBlock(ws, db as any)).toBeNull();
    await db`UPDATE hosting_accounts SET paid_units='0',promo_units='0',depleted_at=now() WHERE id=${account}`;
    expect((await evaluateLifecycleNotices(db as any, account)).created).toEqual(['read_only_entered']);
  });

  test('notices are owner-only, acknowledgeable once and visible over HTTP with the read-only state', async () => {
    expect((await call('GET', '/lifecycle', strangerKey)).status).toBe(404);
    const mine = await call('GET', '/lifecycle', ownerKey);
    expect(mine.status).toBe(200);
    expect(mine.json.lifecycle).toMatchObject({ account_id: state.Warn!.account, version: 1 });
    expect(mine.json.notices.length).toBeGreaterThan(0);
    expect(mine.json.notices.every((n: any) => n.acknowledged_at === null)).toBe(true);
    expect((await call('GET', '/account', ownerKey)).json.lifecycle.account_id).toBe(state.Warn!.account);
    const id = mine.json.notices[0].id;
    expect((await call('POST', `/lifecycle/notices/${id}/acknowledge`, otherKey)).status).toBe(404);
    const ack = await call('POST', `/lifecycle/notices/${id}/acknowledge`, ownerKey);
    expect(ack.status).toBe(200);
    const again = await call('POST', `/lifecycle/notices/${id}/acknowledge`, ownerKey);
    expect(again.json.notice.acknowledged_at).toBe(ack.json.notice.acknowledged_at);
    await expect(acknowledgeLifecycleNotice(db as any, state.ReadOnly!.account, id)).rejects.toMatchObject({ code: 'notice_not_found' });
    const paths = buildOpenApiDocument().paths as any;
    for (const p of ['/api/v4/onboarding/lifecycle', '/api/v4/onboarding/lifecycle/notices/{id}/acknowledge']) expect(paths[p]).toBeDefined();
  });
});
