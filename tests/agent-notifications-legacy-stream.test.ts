import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { invalidateCeilingCache } from '../src/services/agent-notifications';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';
import { sseHub } from '../src/sse-hub';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest, writeStorageObject, completeStorageObject } from '../src/services/storage';

// Notification-only classification on legacy event streams: a delivery profile. Classified audience members drop out of
// visibility audiences; a classified caller keeps whatever its own ACL authorizes.
// Disposable Postgres only:
//   RECORD_TEST_PORT=<free port> bun test tests/agent-notifications-legacy-stream.test.ts
const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('legacy event streams under notification-only classification', () => {
  const database = `agent_stream_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  // 0 human owner H, 1 bot A, 2 bot M (manager bot), 3 human C, 4 owner of W2, 5 bot D (audience member)
  // 6 is K, a workspace key (alias) of bot A, not an actor.
  const secrets = [501, 502, 503, 504, 505, 506, 507].map((n) => new Uint8Array(32).fill(n));
  const npubs = secrets.map((s) => nip19.npubEncode(getPublicKey(s)));
  const [H, A, M, C, H2, D, K] = [0, 1, 2, 3, 4, 5, 6];
  let db: ReturnType<typeof postgres>;
  let app: ReturnType<typeof createApp>;
  const actors: string[] = [];
  let w1: string, w2: string, w3: string, scope: string, ch1: string, chD: string, w2ch: string;

  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const sign = (tags: string[][], actor: number) =>
    `Nostr ${Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags }, secrets[actor]!))).toString('base64')}`;
  // Ordinary NIP-98 (legacy routes).
  async function legacy(path: string, method: string, actor: number, body?: unknown) {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const response = await app.request(path, {
      method, body: data,
      headers: { Authorization: sign([['u', `http://localhost${path}`], ['method', method], ...(data ? [['payload', sha(data)]] : [])], actor), 'Content-Type': 'application/json' },
    });
    const text = await response.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: response.status, body: json };
  }
  // Strict exact-request NIP-98 (agent-notifications routes), the production classification path.
  async function classify(workspace: string, manager: number, target: number) {
    const path = `/api/v4/flightdeck-pg/workspaces/${workspace}/agent-notifications/access-profile`;
    const data = JSON.stringify({ actor_npub: npubs[target] });
    const response = await app.request(path, {
      method: 'PUT', body: data,
      headers: { Authorization: sign([['u', `http://localhost${path}`], ['method', 'PUT'], ['payload', sha(data)], ['nonce', randomBytes(16).toString('hex')]], manager), 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    invalidateCeilingCache();
  }
  // Pre-existing audience registrations: bot manager M and human manager H both watch bot D.
  const registerAudience = async () => {
    for (const manager of [M, H]) await db`INSERT INTO flightdeck_pg_event_subscription_agents (workspace_id, manager_actor_id, agent_actor_id, authorized_by_actor_id)
      SELECT ${w1}, ${actors[manager]!}, ${actors[D]!}, ${actors[manager]!}
      WHERE NOT EXISTS (SELECT 1 FROM flightdeck_pg_event_subscription_agents WHERE workspace_id = ${w1} AND manager_actor_id = ${actors[manager]!} AND agent_actor_id = ${actors[D]!})`;
  };
  const unclassify = async () => { await db`DELETE FROM flightdeck_pg_agent_access_profiles`; invalidateCeilingCache(); };
  async function post(workspace: string, channel: string, body: string, actor = H) {
    const tags = [['protocol', 'flightdeck_pg_message_instruction'], ['body_sha256', sha(body)], ['workspace_id', workspace], ['channel_id', channel]];
    const event = finalizeEvent({ kind: 33358, created_at: Math.floor(Date.now() / 1000), tags, content: body }, secrets[actor]!);
    const result = await legacy(`/api/v4/flightdeck-pg/workspaces/${workspace}/channels/${channel}/messages`, 'POST', actor, {
      body, create_thread: true, thread_title: 'Thread',
      message_signature: { version: 1, signer_npub: npubs[actor], body_sha256: sha(body), nostr_event: event },
    });
    expect(result.status).toBe(201);
    // Message events carry ids only; a thread rename event carries its title. That title is the readable sentinel.
    const threadId = result.body.thread?.id ?? result.body.message?.thread_id;
    expect(typeof threadId).toBe('string');
    const renamed = await legacy(`/api/v4/flightdeck-pg/workspaces/${workspace}/threads/${threadId}`, 'PATCH', actor, { title: body });
    expect(renamed.status).toBe(200);
    return result.body;
  }
  const headCursor = async (workspace: string) => {
    const [row] = await db<{ v: number }[]>`SELECT COALESCE(MAX(row_version), 0)::int AS v FROM flightdeck_pg_outbox_events WHERE workspace_id = ${workspace}`;
    return Buffer.from(JSON.stringify({ version: 1, rowVersion: row!.v }), 'utf8').toString('base64url');
  };

  type OpenStream = { status: number; text: () => string; until: (pred: (text: string) => boolean, ms?: number) => Promise<boolean>; ended: () => boolean; cancel: () => Promise<void> };
  const open: OpenStream[] = [];
  async function openStream(workspace: string, actor: number, audience: number[] = []): Promise<OpenStream> {
    const query = [`cursor=${encodeURIComponent(await headCursor(workspace))}`, ...audience.map((i) => `audience_npub=${encodeURIComponent(npubs[i]!)}`)].join('&');
    const path = `/api/v4/flightdeck-pg/workspaces/${workspace}/events/stream?${query}`;
    return readStream(await app.request(path, { headers: { Authorization: sign([['u', `http://localhost${path}`], ['method', 'GET']], actor) } }));
  }
  // Owner-scoped advisory record stream (NIP-98 in the token query parameter).
  // Only `token` is excluded from the signed URL; last_event_id is signed.
  const ownerStreamUrl = (actor: number, lastEventId?: number) => {
    const path = `/api/v4/workspaces/${npubs[actor]}/stream${lastEventId === undefined ? '' : `?last_event_id=${lastEventId}`}`;
    const token = sign([['u', `http://localhost${path}`], ['method', 'GET']], actor).slice(6);
    return `${path}${lastEventId === undefined ? '?' : '&'}token=${encodeURIComponent(token)}`;
  };
  async function openOwnerStream(actor: number, lastEventId?: number): Promise<OpenStream> {
    return readStream(await app.request(ownerStreamUrl(actor, lastEventId)));
  }
  function readStream(response: Response): OpenStream {
    let buffer = '';
    let done = false;
    const reader = response.body ? response.body.getReader() : null;
    const decoder = new TextDecoder();
    const pump = (async () => {
      if (!reader) { done = true; return; }
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
        }
      } catch { /* cancelled */ }
      done = true;
    })();
    const stream: OpenStream = {
      status: response.status,
      text: () => buffer,
      ended: () => done,
      until: async (pred, ms = 6_000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (pred(buffer)) return true;
          if (done) return pred(buffer);
          await Bun.sleep(50);
        }
        return pred(buffer);
      },
      cancel: async () => { await reader?.cancel().catch(() => {}); await pump; },
    };
    if (response.status === 200) open.push(stream);
    return stream;
  }
  // Every frame received after `marker` (the stream text from the classification point onwards).
  const after = (stream: OpenStream, offset: number) => stream.text().slice(offset);

  beforeAll(async () => {
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database, max: 20 });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    for (const [i, kind] of ['human', 'agent', 'agent', 'human', 'human', 'agent'].entries()) {
      actors.push((await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${npubs[i]!},${kind},${`Actor${i}`}) RETURNING id`)[0]!.id);
    }
    w1 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-ls','service-ls',${npubs[H]!},'app','W1') RETURNING id`)[0]!.id;
    w2 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-ls','service-ls2',${npubs[H2]!},'app','W2') RETURNING id`)[0]!.id;
    for (const [i, role] of [[H, 'owner'], [A, 'member'], [M, 'member'], [C, 'member'], [D, 'member']] as const) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w1},${actors[i]!},${role})`;
    for (const [i, role] of [[H2, 'owner'], [A, 'member']] as const) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w2},${actors[i]!},${role})`;
    scope = (await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w1},'Main','project') RETURNING id`)[0]!.id;
    ch1 = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'General') RETURNING id`)[0]!.id;
    chD = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'D only') RETURNING id`)[0]!.id;
    const w2scope = (await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w2},'Main','project') RETURNING id`)[0]!.id;
    w2ch = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w2},${w2scope},'General') RETURNING id`)[0]!.id;
    const grant = (w: string, actor: string, channel: string, permission: string) =>
      db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${actor},'channel',${channel},${permission})`;
    for (const i of [H, A, M, C, D]) for (const p of ['channel.read', 'channel.write']) await grant(w1, actors[i]!, ch1, p);
    for (const i of [H, D]) for (const p of ['channel.read', 'channel.write']) await grant(w1, actors[i]!, chD, p);
    for (const i of [H2, A]) for (const p of ['channel.read', 'channel.write']) await grant(w2, actors[i]!, w2ch, p);
    for (const p of ['workspace.manage', 'event_subscription.manage']) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${w1},'actor',${actors[H]!},'workspace',${p})`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${w1},'actor',${actors[M]!},'workspace','event_subscription.manage')`;
    await registerAudience();
    // W3: a workspace owned by bot A, so A's owner-scoped advisory stream (/api/v4/workspaces/:A/stream) maps to W3.
    w3 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-ls','service-ls3',${npubs[A]!},'app','W3') RETURNING id`)[0]!.id;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w3},${actors[A]!},'owner')`;
    enableInMemoryStorageForTest();
    setDb(db); clearWsKeyCacheForTests?.(); invalidateCeilingCache(); app = createApp();
  });
  afterEach(async () => {
    for (const stream of open.splice(0)) await stream.cancel();
    await unclassify();
    await registerAudience(); // classifying D deletes its registrations
  });
  afterAll(async () => {
    resetInMemoryStorageForTest();
    for (const stream of open) await stream.cancel();
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end();
  });

  test('a classified manager bot keeps its own ACL-authorized stream (classification is delivery-only)', async () => {
    const managerBot = await openStream(w1, M, [D]);
    expect(managerBot.status).toBe(200);
    await managerBot.until((t) => t.includes('event: connected'));
    const markBot = managerBot.text().length;
    await classify(w1, H, M);
    await post(w1, ch1, 'SENTINEL-MANAGER-OWN-ACL-55ee');
    expect(await managerBot.until((t) => t.slice(markBot).includes('SENTINEL-MANAGER-OWN-ACL-55ee'))).toBe(true);
    expect(after(managerBot, markBot)).not.toContain('agent_notification_upgrade_required');
    expect(managerBot.ended()).toBe(false);
    await unclassify();
  });

  test('manager-audience stream: a classified audience member drops out of a human manager stream', async () => {
    const managerHuman = await openStream(w1, H, [D]);
    expect(managerHuman.status).toBe(200);
    await post(w1, chD, 'SENTINEL-AUDIENCE-PRE-44dd');
    expect(await managerHuman.until((t) => t.includes('SENTINEL-AUDIENCE-PRE-44dd'))).toBe(true);
    const markHuman = managerHuman.text().length;
    await classify(w1, H, D);
    expect(await managerHuman.until((t) => t.slice(markHuman).includes('flightdeck_pg.audience_changed'))).toBe(true);
    const [dOnly] = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM flightdeck_pg_event_subscription_agents WHERE workspace_id = ${w1} AND agent_actor_id = ${actors[D]!}`;
    expect(dOnly!.n).toBe(0);
    await post(w1, ch1, 'SENTINEL-HUMAN-VISIBLE-66ff');
    await Bun.sleep(2_500);
    expect(managerHuman.ended()).toBe(false);
    expect(managerHuman.text().slice(markHuman)).not.toContain('agent_notification_upgrade_required');
    await unclassify();
  });

  test('ordinary membership revocation still closes an unclassified bot stream with workspace_access_revoked', async () => {
    const bot = await openStream(w1, A);
    expect(bot.status).toBe(200);
    await post(w1, ch1, 'SENTINEL-MEMBER-PRE-77aa');
    expect(await bot.until((t) => t.includes('SENTINEL-MEMBER-PRE-77aa'))).toBe(true);
    await db`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id = ${w1} AND actor_id = ${actors[A]!}`;
    await post(w1, ch1, 'SENTINEL-MEMBER-POST-88bb');
    expect(await bot.until((t) => t.includes('workspace_access_revoked'))).toBe(true);
    expect(bot.text()).not.toContain('SENTINEL-MEMBER-POST-88bb');
    expect(bot.text()).not.toContain('agent_notification_upgrade_required');
    expect(await bot.until(() => bot.ended(), 3_000)).toBe(true);
    // Restore A (its channel grants cascaded with the membership).
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w1},${actors[A]!},'member')`;
    for (const p of ['channel.read', 'channel.write']) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w1},'actor',${actors[A]!},'channel',${ch1},${p})`;
  });

  // A classification that commits while a batch is loading: the poll passed its first check, then blocks reading the
  // outbox. The sentinel event and the classification both commit before the read completes.
  async function classifyMidLoad(stream: OpenStream, target: number, channel: string, sentinel: string) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.begin(async (tx) => {
      await tx`LOCK TABLE flightdeck_pg_outbox_events IN ACCESS EXCLUSIVE MODE`;
      await tx`INSERT INTO flightdeck_pg_outbox_events (workspace_id, scope_id, channel_id, actor_id, event_type, entity_type, entity_id, operation, payload)
        VALUES (${w1}, ${scope}, ${channel}, ${actors[H]!}, 'flightdeck_pg.thread.updated', 'thread', gen_random_uuid(), 'renamed', ${tx.json({ title: sentinel })})`;
      locked();
      await released;
    });
    await isLocked;
    const blocked = async () => Number((await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM pg_locks WHERE relation = 'flightdeck_pg_outbox_events'::regclass AND NOT granted`)[0]!.n);
    for (let i = 0; i < 60 && await blocked() === 0; i++) await Bun.sleep(50);
    expect(await blocked()).toBeGreaterThan(0);
    const mark = stream.text().length;
    await classify(w1, H, target);
    release();
    await holder;
    return mark;
  }

  test('mid-load classification of an audience member: the batch carrying its private events is dropped', async () => {
    const manager = await openStream(w1, H, [D]);
    expect(manager.status).toBe(200);
    await manager.until((t) => t.includes('event: connected'));
    expect(manager.text()).toContain(npubs[D]!); // D is a live audience member before the mid-load classification
    await post(w1, chD, 'SENTINEL-MIDLOAD-AUDIENCE-PRE-5678'); // control: D-only events reach the manager
    expect(await manager.until((t) => t.includes('SENTINEL-MIDLOAD-AUDIENCE-PRE-5678'))).toBe(true);
    const mark = await classifyMidLoad(manager, D, chD, 'SENTINEL-MIDLOAD-AUDIENCE-aabb');
    expect(await manager.until((t) => t.slice(mark).includes('flightdeck_pg.audience_changed'))).toBe(true);
    await Bun.sleep(1_500);
    expect(after(manager, mark)).not.toContain('SENTINEL-MIDLOAD-AUDIENCE-aabb');
    expect(manager.ended()).toBe(false);
  });

});
