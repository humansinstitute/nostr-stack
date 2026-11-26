import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { USD_UNITS } from '../src/services/hosting-billing';
import { openOwnerAccount } from '../src/services/onboarding';
import { setupFlightDeckPgDevWorkspace } from '../src/services/flightdeck-pg-setup';
import { buildOpenApiDocument } from '../src/openapi';

// Runs only against a dedicated disposable PostgreSQL: ONBOARDING_TEST_PORT=<free port>.
const port = Number(process.env.ONBOARDING_TEST_PORT);
const keys = Array.from({ length: 5 }, (_, i) => new Uint8Array(32).fill(150 + i));
const [adminKey, aliceKey, bobKey, carolKey, outsiderKey] = keys as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
const npub = (k: Uint8Array) => nip19.npubEncode(getPublicKey(k));
const [admin, alice, bob, carol] = [adminKey, aliceKey, bobKey, carolKey].map(npub) as [string, string, string, string];
const app = createApp();

describe.skipIf(!port || port === 5432)('admin hosting-account projection on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_acctview_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  const saved = { admin: config.adminNpub, service: config.service.npub };

  async function get(path: string, signer?: Uint8Array) {
    const url = `http://localhost${path}`;
    const headers: Record<string, string> = {};
    if (signer) {
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(), tags: [['u', url], ['method', 'GET']] }, signer);
      headers.Authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
    }
    const response = await app.request(url, { headers });
    return { status: response.status, headers: response.headers, json: (await response.json().catch(() => ({}))) as any };
  }
  const snapshot = async () => ({
    accounts: await db`SELECT id,paid_units,promo_units,promo_expires_at FROM hosting_accounts ORDER BY id`,
    ledger: (await db`SELECT count(*)::int AS n FROM hosting_ledger`)[0]!.n,
  });

  beforeAll(async () => {
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    config.adminNpub = admin;
    config.service.npub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(86)));
  });
  afterAll(async () => { config.adminNpub = saved.admin; config.service.npub = saved.service; await closeDb(); });

  test('requires NIP-98 (401) and the configured administrator (403)', async () => {
    expect((await get('/api/v4/admin/hosting-accounts')).status).toBe(401);
    for (const key of [aliceKey, outsiderKey]) {
      const denied = await get('/api/v4/admin/hosting-accounts', key);
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.json)).not.toContain('accounts');
    }
    const ok = await get('/api/v4/admin/hosting-accounts', adminKey);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
  });

  test('empty deployment: honest empty page, no fabricated rows', async () => {
    const page = (await get('/api/v4/admin/hosting-accounts', adminKey)).json;
    expect(page).toMatchObject({ version: 1, total: 0, offset: 0, has_more: false, accounts: [] });
    expect(page.providers.onboarding_enabled).toBe(false);
    expect(page.providers.card.available).toBe(false);
    expect(page.providers.lightning.available).toBe(false);
    expect(Date.parse(page.refreshed_at)).not.toBeNaN();
    expect(page.build).toHaveProperty('git_commit');
  });

  test('projects zero, legacy-promo, debt and expired-promo accounts truthfully without writing', async () => {
    // alice: onboarding account, zero balance. bob: legacy hosted account linked to a workspace (welcome promo).
    await openOwnerAccount(alice, db as any);
    await db`UPDATE flightdeck_pg_actors SET display_name=${'Alice <img src=x onerror=alert(1)>'} WHERE npub=${alice}`;
    await setupFlightDeckPgDevWorkspace({
      towerServiceNpub: config.service.npub, workspaceServiceNpub: npub(new Uint8Array(32).fill(90)), workspaceOwnerNpub: bob,
      appNpub: npub(new Uint8Array(32).fill(91)), creatorNpub: bob, workspaceName: 'Bob Legacy Space', towerBaseUrl: 'http://localhost', hostedBilling: true,
    }, db as any);
    // carol: onboarding account with a reversal shortfall and an already-expired promo balance that has not been swept.
    await openOwnerAccount(carol, db as any);
    await db`UPDATE hosting_accounts SET paid_units=${(-3n * USD_UNITS).toString()}, promo_units=${(2n * USD_UNITS).toString()}, promo_expires_at=now()-interval '1 day'
      WHERE owner_actor_id=(SELECT id FROM flightdeck_pg_actors WHERE npub=${carol})`;
    const [carolAcct] = await db`SELECT id FROM hosting_accounts WHERE owner_actor_id=(SELECT id FROM flightdeck_pg_actors WHERE npub=${carol})`;
    await db`INSERT INTO onboarding_intents(owner_actor_id,account_id,client_request_key,request_sha256,workspace_name,workspace_name_key,funding_cents,status,last_error)
      VALUES((SELECT id FROM flightdeck_pg_actors WHERE npub=${carol}),${carolAcct!.id},'req-acctview-1','x','Carol Space','carol space',2100,'funded','workspace:storage_unavailable')`;
    const before = await snapshot();

    const page = (await get('/api/v4/admin/hosting-accounts', adminKey)).json;
    expect(page.total).toBe(3);
    const by = (n: string) => page.accounts.find((a: any) => a.owner_npub === n);
    expect(by(alice)).toMatchObject({ opened_by: 'onboarding', purchased_units: '0', promo_units: '0', reversal_debt_units: '0', balance_units: '0', workspaces: { count: 0, names: [] }, latest_onboarding: null });
    expect(by(alice).owner_label).toBe('Alice <img src=x onerror=alert(1)>'); // raw data; the UI renders it as text
    expect(by(bob)).toMatchObject({ opened_by: 'legacy', purchased_units: '0', promo_units: '720000000000', workspaces: { count: 1, names: ['Bob Legacy Space'] } });
    expect(by(bob).balance_usd).toBe('5.000000000000');
    expect(by(carol)).toMatchObject({ purchased_units: '0', promo_units: '0', promo_usd: '0.000000000000', reversal_debt_units: (3n * USD_UNITS).toString(), balance_units: (-3n * USD_UNITS).toString(), balance_usd: '-3.000000000000' });
    expect(by(carol).latest_onboarding).toMatchObject({ status: 'funded', funding_cents: 2100, provisioned_at: null, last_error: 'workspace:storage_unavailable' });

    // Pure read: no promo-expiry ledger entry or balance change, even for the expired promo.
    expect(await snapshot()).toEqual(before);

    // Explicit projection only: no secrets, invoices, ledger reasons or provider configuration anywhere in the payload.
    const text = JSON.stringify(page);
    for (const forbidden of ['idempotency', 'reason', 'actor_npub', 'invoice', 'session', 'ncryptsec', 'password', 'replay', 'secret', 'return_urls', 'request_sha256']) expect(text).not.toContain(forbidden);
    expect(Object.keys(by(alice)).sort()).toEqual(['account_id', 'balance_units', 'balance_usd', 'created_at', 'latest_onboarding', 'opened_by', 'owner_label', 'owner_npub', 'promo_expires_at', 'promo_units', 'promo_usd', 'purchased_units', 'purchased_usd', 'reversal_debt_units', 'reversal_debt_usd', 'workspaces']);
  });

  test('pages in a stable newest-first order and bounds its parameters', async () => {
    const all = (await get('/api/v4/admin/hosting-accounts?limit=100', adminKey)).json.accounts.map((a: any) => a.account_id);
    const created = (await get('/api/v4/admin/hosting-accounts?limit=100', adminKey)).json.accounts.map((a: any) => Date.parse(a.created_at));
    expect([...created].sort((x, y) => y - x)).toEqual(created);
    const first = (await get('/api/v4/admin/hosting-accounts?limit=2&offset=0', adminKey)).json;
    const second = (await get('/api/v4/admin/hosting-accounts?limit=2&offset=2', adminKey)).json;
    expect(first).toMatchObject({ limit: 2, offset: 0, has_more: true, total: 3 });
    expect(second).toMatchObject({ limit: 2, offset: 2, has_more: false });
    expect([...first.accounts, ...second.accounts].map((a: any) => a.account_id)).toEqual(all);
    expect((await get('/api/v4/admin/hosting-accounts?limit=2&offset=50', adminKey)).json).toMatchObject({ accounts: [], has_more: false, total: 3 });
    for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'limit=-1', 'limit=1.5', 'offset=-1', 'offset=100001', 'offset=x']) {
      const response = await get(`/api/v4/admin/hosting-accounts?${bad}`, adminKey);
      expect([response.status, response.json.code]).toEqual([400, bad.startsWith('limit') ? 'invalid_limit' : 'invalid_offset']);
    }
  });

  test('the raw table viewer does not expose hosting tables as a bypass, and the route is in OpenAPI', async () => {
    const tables = (await get('/api/v4/admin/tables', adminKey)).json.tables.map((t: any) => t.table) as string[];
    expect(tables.length).toBeGreaterThan(5);
    expect(tables.filter(t => t.startsWith('hosting_') || t.startsWith('onboarding_'))).toEqual([]);
    const doc = buildOpenApiDocument('http://localhost') as any;
    expect(doc.paths['/api/v4/admin/hosting-accounts'].get.responses['403']).toBeDefined();
    expect(doc.components.schemas.AdminHostingAccount.required).toContain('reversal_debt_units');
  });
});
