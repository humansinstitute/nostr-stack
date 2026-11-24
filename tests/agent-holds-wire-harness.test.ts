import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { closeDb } from '../src/db';
import { buildAgentHoldsHarness } from './harness/agent-holds-wire';

// Proves the harness itself (real Hono routes, real signatures) with an in-process client; the external Rust client uses the same fixture.
const port = Number(process.env.HOLDS_TEST_PORT);
describe.skipIf(!port || port === 5432)('agent-holds wire harness', () => {
  const serviceKey = generateSecretKey(), serviceNpub = nip19.npubEncode(getPublicKey(serviceKey));
  let h: Awaited<ReturnType<typeof buildAgentHoldsHarness>>;
  beforeAll(async () => { h = await buildAgentHoldsHarness({ pgPort: port, serviceNpub }); });
  afterAll(async () => { await closeDb(); const root = postgres({ host: '127.0.0.1', port, username: 'postgres', password: 'postgres', database: 'postgres', onnotice: () => {} }); await root.unsafe(`DROP DATABASE IF EXISTS ${h.name} WITH (FORCE)`); await root.end(); });
  async function signed(method: 'GET' | 'POST', path: string, body?: unknown) {
    const url = `http://localhost/api/v4/agent-holds${path}`, raw = body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body);
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: randomUUID(), tags: [['u', url], ['method', method], ...(raw ? [['payload', createHash('sha256').update(raw).digest('hex')]] : [])] }, serviceKey);
    const r = await h.app.request(url, { method, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` }, body: raw });
    return { status: r.status, json: (await r.json()) as any };
  }
  test('the labelled fixture serves a full reserve, dispatch, settle cycle through the real routes', async () => {
    const f = h.fixture;
    expect(f.label).toBe('FIXTURE_ONLY_NOT_A_REAL_TARIFF_OR_STORAGE_PROVIDER');
    const call = `wire-${randomUUID().slice(0, 8)}`;
    const reserve = await signed('POST', '/holds/reserve', { account_id: f.account_id, call_id: call, grant_id: f.grant_id, workspace_id: f.workspace_id, agent_npub: f.agent_npub, model: f.model, tariff_version: f.tariff_version, max_input_tokens: '1000', max_output_tokens: '500' });
    expect(reserve.status).toBe(201); expect(reserve.json).toMatchObject({ state: 'held', reserved_units: '57600000' });
    expect((await signed('POST', '/holds/dispatch', { account_id: f.account_id, call_id: call })).json.state).toBe('dispatched');
    const settled = await signed('POST', '/holds/settle', { account_id: f.account_id, call_id: call, observation: { input_tokens: '800', output_tokens: '100', generation_id: 'gen-wire', observed_at: new Date().toISOString() } });
    expect(settled.json).toMatchObject({ state: 'settled', settled_units: '20160000', overrun_units: '0' });
    const wrongKey = generateSecretKey();
    const url = 'http://localhost/api/v4/agent-holds/holds/dispatch', raw = JSON.stringify({ account_id: f.account_id, call_id: call });
    const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: 'x', tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(raw).digest('hex')]] }, wrongKey);
    expect((await h.app.request(url, { method: 'POST', headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}` }, body: raw })).status).toBe(403);
  });
});
