/**
 * TEST-ONLY wire-contract harness for the agent-holds routes.
 *
 * Builds the REAL NStack Hono app (actual routes, auth, schema, services) on a fresh database inside a disposable PostgreSQL the caller provides,
 * seeds clearly labelled FIXTURE state (a fixture tariff, a fixture Git storage-coverage stand-in, a funded synthetic account, one payer grant for the
 * runtime's service key) and returns the app. `serve()` exposes it on a loopback port for an external client (for example the Rust runtime's
 * exact signed requests); it is only invoked by `bun tests/harness/agent-holds-wire.ts` and is never imported by the product.
 *
 *   HARNESS_PG_PORT=<disposable postgres port> HARNESS_SERVICE_NPUB=<runtime service npub> [HARNESS_PORT=<free loopback port>] bun tests/harness/agent-holds-wire.ts
 *
 * Production gates are untouched: nothing here is imported by src/, no tariff, model or storage coverage exists outside this process.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../../src/config';
import { setDb } from '../../src/db';
import { createApp } from '../../src/server';
import { ensureRuntimeSchema } from '../../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../../src/schema/sql-statements';
import { grantHostingCredit } from '../../src/services/hosting-billing';
import { appendAgentTariff, createAgentGrant, registerAgentHoldsReserve } from '../../src/services/hosting-agent-holds';
import { enrollPeakStorage, registerMeteredStorageCategory, registerStorageProtectionReserve, takeStorageAnchor } from '../../src/services/hosting-storage';
import { openOwnerAccount } from '../../src/services/onboarding';

export interface HarnessFixture {
  label: 'FIXTURE_ONLY_NOT_A_REAL_TARIFF_OR_STORAGE_PROVIDER';
  account_id: string; workspace_id: string; agent_npub: string; service_npub: string; grant_id: string; tariff_version: string; model: string;
  pico_per_input_token: string; pico_per_output_token: string; max_input_tokens: string; max_output_tokens: string; daily_cap_units: string; funded_usd: number;
}
const key = () => generateSecretKey();
const npubOf = (k: Uint8Array) => nip19.npubEncode(getPublicKey(k));

export async function buildAgentHoldsHarness(o: { pgPort: number; serviceNpub: string; databaseName?: string }) {
  const conn = { host: '127.0.0.1', port: o.pgPort, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = o.databaseName ?? `tower_holds_wire_${process.pid}_${Date.now()}`;
  const root = postgres({ ...conn, database: 'postgres' });
  await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
  const db = postgres({ ...conn, database: name }); setDb(db);
  process.env.ONBOARDING_ENABLED = 'true';
  process.env.HOSTING_AGENT_HOLDS_ENABLED = 'true';
  process.env.HOSTING_AGENT_HOLD_SERVICES = o.serviceNpub;
  for (const statement of splitSqlStatements(readFileSync(new URL('../../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
  await ensureRuntimeSchema(db);
  const adminKey = key(), payerKey = key(), agentKey = key();
  const admin = npubOf(adminKey), payer = npubOf(payerKey), agent = npubOf(agentKey);
  (config as any).adminNpub = admin;
  const [{ id: payerActor }] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${payer},'human') RETURNING id` as any;
  const [{ id: agentActor }] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${agent},'agent') RETURNING id` as any;
  const account = (await openOwnerAccount(payer, db as any)).account_id;
  await grantHostingCredit(account, 10_000, 'wire-harness-fixture', 'FIXTURE credit for the wire harness', payer, db as any);
  const workspace = randomUUID();
  await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${workspace},'tower',${workspace},${payer},'wire-harness','Wire harness')`;
  await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace},${payerActor},'owner'),(${workspace},${agentActor},'agent')`;
  await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${workspace},${account})`;
  await enrollPeakStorage(db as any, workspace, account, null);
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  await db`UPDATE hosting_storage_enrollments SET activated_at=${new Date(hour - 1_800_000)},intro_ends_at=${new Date(hour - 3_600_000)} WHERE workspace_id=${workspace}`;
  await takeStorageAnchor(workspace, db as any);
  registerStorageProtectionReserve();
  registerMeteredStorageCategory({ id: 'git', journal: 'write_path', bytes: async () => 0n }); // FIXTURE: stands in for the absent Git provider
  registerAgentHoldsReserve();
  const model = 'fixture/model', tariff = 'fixture-t1';
  await appendAgentTariff(admin, { version: tariff, models: [{ model, input_pico_per_token: '100000', output_pico_per_token: '600000', max_input_tokens: '200000', max_output_tokens: '32000' }] }, db as any);
  const cap = '100000000000';
  const g = await createAgentGrant(payer, { idempotency_key: 'wire-harness-grant', workspace_id: workspace, agent_npub: agent, service_npub: o.serviceNpub, model, tariff_version: tariff, daily_cap_units: cap, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() }, undefined, db as any);
  const fixture: HarnessFixture = {
    label: 'FIXTURE_ONLY_NOT_A_REAL_TARIFF_OR_STORAGE_PROVIDER', account_id: account, workspace_id: workspace, agent_npub: agent, service_npub: o.serviceNpub, grant_id: g.grant.id, tariff_version: tariff, model,
    pico_per_input_token: '100000', pico_per_output_token: '600000', max_input_tokens: '200000', max_output_tokens: '32000', daily_cap_units: cap, funded_usd: 100,
  };
  return { app: createApp(), fixture, db, name, close: async () => { await db.end(); } };
}

if (import.meta.main) {
  const pgPort = Number(process.env.HARNESS_PG_PORT), serviceNpub = String(process.env.HARNESS_SERVICE_NPUB ?? ''), port = Number(process.env.HARNESS_PORT ?? 0);
  if (!pgPort || pgPort === 5432 || !/^npub1[02-9ac-hj-np-z]{58}$/.test(serviceNpub)) { console.error('set HARNESS_PG_PORT (disposable postgres, not 5432) and HARNESS_SERVICE_NPUB'); process.exit(2); }
  const h = await buildAgentHoldsHarness({ pgPort, serviceNpub });
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: (req, srv) => h.app.fetch(req, srv) });
  console.log(JSON.stringify({ base_url: `http://127.0.0.1:${server.port}`, database: h.name, fixture: h.fixture }));
  process.on('SIGTERM', async () => { server.stop(true); await h.close(); process.exit(0); });
  process.on('SIGINT', async () => { server.stop(true); await h.close(); process.exit(0); });
}
