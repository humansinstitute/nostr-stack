import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';

// Learning for notification-only identities: only the reviewed route+method set, only with an explicit, signed grant.
// Disposable Postgres only:
//   RECORD_TEST_PORT=<free port> bun test tests/agent-learning-ceiling.test.ts
const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('learning grants under the notification-only ceiling', () => {
  const database = `agent_learning_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  // 0 human owner H, 1 learner R, 2 classified bot P, 3 unclassified bot Q, 4 read-only learner L, 5 revoking learner V
  const secrets = [701, 702, 703, 704, 705, 706].map((n) => new Uint8Array(32).fill(n));
  const npubs = secrets.map((s) => nip19.npubEncode(getPublicKey(s)));
  const [H, R, P, Q, L, V] = [0, 1, 2, 3, 4, 5];
  let db: ReturnType<typeof postgres>;
  let app: ReturnType<typeof createApp>;
  let w1: string;
  const grants: Record<string, string> = {};
  let concept = '';

  type Grant = { header?: string; tag?: string };
  async function learn(actor: number, method: 'GET' | 'POST', path: string, body?: unknown, grant: Grant = {}) {
    const full = `/api/v4/learning${path}`;
    const data = body === undefined ? undefined : JSON.stringify(body);
    const tags = [['u', `http://localhost${full}`], ['method', method], ...(data ? [['payload', createHash('sha256').update(data).digest('hex')]] : []),
      ...(grant.tag ? [['learning_grant_id', grant.tag]] : [])];
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags }, secrets[actor]!);
    const response = await app.request(full, { method, body: data, headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'Content-Type': 'application/json',
      ...(grant.header ? { 'x-learning-grant-id': grant.header } : {}),
    } });
    const text = await response.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: response.status, body: json };
  }
  const signed = (id: string): Grant => ({ header: id, tag: id });
  const refused = (res: { status: number; body: any }) => res.status === 403 && res.body.code === 'agent_notification_upgrade_required';

  beforeAll(async () => {
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database, max: 10 });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    const actors: string[] = [];
    for (const [i, kind] of ['human', 'human', 'agent', 'agent', 'human', 'human'].entries()) {
      actors.push((await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${npubs[i]!},${kind},${`Actor${i}`}) RETURNING id`)[0]!.id);
    }
    w1 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-lg','service-lg',${npubs[H]!},'app','W1') RETURNING id`)[0]!.id;
    for (const [i, role] of [[H, 'owner'], [P, 'member'], [Q, 'member']] as const) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w1},${actors[i]!},${role})`;
    setDb(db); clearWsKeyCacheForTests(); app = createApp();
    // Learners and their delegations, created through the learning routes (humans are unaffected by the ceiling).
    for (const learner of [R, L, V]) expect((await learn(learner, 'POST', '/profile', {})).status).toBe(201);
    const delegate = async (learner: number, grantee: number, canWrite: boolean) => {
      const res = await learn(learner, 'POST', '/delegations', { granteeNpub: npubs[grantee], role: 'agent', canWrite });
      expect(res.status).toBe(201);
      return res.body.delegation.id as string;
    };
    grants.rickToPiper = await delegate(R, P, true);
    grants.rickToQ = await delegate(R, Q, true);
    grants.readOnlyToPiper = await delegate(L, P, false);
    grants.revokedToPiper = await delegate(V, P, true);
    expect((await learn(V, 'POST', `/delegations/${grants.revokedToPiper}/revoke`, {})).status).toBe(200);
    // P is notification-only in W1.
    await db`INSERT INTO flightdeck_pg_agent_access_profiles (workspace_id, actor_id, profile) VALUES (${w1}, ${actors[P]!}, 'notification_only')`;
    const curriculum = await learn(R, 'GET', '/curriculum');
    expect(curriculum.status).toBe(200);
    concept = curriculum.body.concepts[0].id;
  });
  afterAll(async () => {
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end();
  });

  test('a classified bot with an explicit signed grant uses exactly the reviewed routes', async () => {
    const g = signed(grants.rickToPiper!);
    expect((await learn(P, 'GET', '/curriculum', undefined, g)).status).toBe(200);
    expect((await learn(P, 'GET', `/curriculum/traverse?goal=${encodeURIComponent(concept)}`, undefined, g)).status).toBe(200);
    expect((await learn(P, 'GET', '/mastery', undefined, g)).status).toBe(200);
    expect((await learn(P, 'GET', '/recall/due', undefined, g)).status).toBe(200);
    expect((await learn(P, 'POST', '/plans', { goal: concept }, g)).status).toBe(201);
    expect((await learn(P, 'POST', '/lessons', { concept }, g)).status).toBe(201);
    const attempt = await learn(P, 'POST', '/assessments', { concept }, g);
    expect(attempt.status).toBe(201);
    // Recall passes the ceiling; the route then applies its own rule (not due yet).
    const recall = await learn(P, 'POST', '/recall', { concept }, g);
    expect(refused(recall)).toBe(false);
    // The work landed on Rick, the grant's learner.
    expect(Number((await db`SELECT COUNT(*)::int AS n FROM learning_plans WHERE learner_npub = ${npubs[R]!}`)[0]!.n)).toBeGreaterThan(0);
    // Every other learning route stays refused even with the grant: profile, delegations, history, evidence, research.
    for (const [method, path, body] of [
      ['POST', '/profile', {}], ['POST', '/delegations', { granteeNpub: npubs[Q], role: 'agent', canWrite: true }], ['GET', '/plans/current'],
      ['GET', `/lessons/${attempt.body.attempt.id}`], ['GET', '/overlay'], ['GET', '/evidence'], ['POST', '/views', { id: crypto.randomUUID(), concept, kind: 'lesson' }],
      ['POST', `/assessments/${attempt.body.attempt.id}/submissions`, { answer: 'x' }], ['GET', '/research/subjects'],
    ] as Array<['GET' | 'POST', string, unknown?]>) {
      const res = await learn(P, method, path, body, g);
      expect([method, path, refused(res)]).toEqual([method, path, true]);
    }
  });

  test('no grant, an unsigned or mismatched grant, a foreign, revoked or invented grant, or a read-only grant for writes are refused', async () => {
    expect(refused(await learn(P, 'GET', '/mastery'))).toBe(true); // implicit learner selection never applies
    expect(refused(await learn(P, 'GET', '/mastery', undefined, { header: grants.rickToPiper }))).toBe(true); // header without signed tag
    expect(refused(await learn(P, 'GET', '/mastery', undefined, { header: grants.rickToPiper, tag: grants.readOnlyToPiper }))).toBe(true); // tag differs
    expect(refused(await learn(P, 'GET', '/mastery', undefined, signed(grants.rickToQ!)))).toBe(true); // another grantee's grant
    expect(refused(await learn(P, 'GET', '/mastery', undefined, signed(grants.revokedToPiper!)))).toBe(true);
    expect(refused(await learn(P, 'GET', '/mastery', undefined, signed(crypto.randomUUID())))).toBe(true);
    expect(refused(await learn(P, 'GET', '/mastery', undefined, signed('not-a-uuid')))).toBe(true);
    // Read-only: reads pass, writes do not.
    expect((await learn(P, 'GET', '/mastery', undefined, signed(grants.readOnlyToPiper!))).status).toBe(200);
    expect(refused(await learn(P, 'POST', '/plans', { goal: concept }, signed(grants.readOnlyToPiper!)))).toBe(true);
    expect(Number((await db`SELECT COUNT(*)::int AS n FROM learning_plans WHERE learner_npub = ${npubs[L]!}`)[0]!.n)).toBe(0);
  });

  test('humans and unclassified bots are unchanged: no header or tag needed, implicit selection still works', async () => {
    expect((await learn(R, 'GET', '/mastery')).status).toBe(200);
    expect((await learn(R, 'GET', '/plans/current')).status).not.toBe(403);
    expect((await learn(Q, 'GET', '/mastery')).status).toBe(200); // Q holds one grant: implicit selection
    expect((await learn(Q, 'POST', '/plans', { goal: concept }, { header: grants.rickToQ })).status).toBe(201); // header without tag is fine for Q
    expect((await learn(Q, 'GET', '/mastery', undefined, { header: grants.rickToPiper })).status).toBe(403); // the route's own grant check
  });
});
