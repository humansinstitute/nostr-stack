import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { processAgentIntakeBatch } from '../src/services/agent-notification-projector';
import { canonicalMentionsSha256 } from '../src/services/flightdeck-pg-message-signatures';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest, writeStorageObject, completeStorageObject } from '../src/services/storage';

// Deliberate self-address (reason self_mention), work-output receipt provenance, and ordinary ACL access for
// notification-only bots (classification is a delivery profile, never an API ceiling).
// Disposable Postgres only:
//   RECORD_TEST_PORT=<free port> bun test tests/agent-self-address-receipts.test.ts
const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('self-address and work receipts against disposable Postgres', () => {
  const database = `agent_receipts_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  // 0 human owner H, 1 classified bot A, 2 bot B, 3 human C, 4 owner of W2
  const secrets = [601, 602, 603, 604, 605].map((n) => new Uint8Array(32).fill(n));
  const npubs = secrets.map((s) => nip19.npubEncode(getPublicKey(s)));
  const [H, A, B, C, H2] = [0, 1, 2, 3, 4];
  let db: ReturnType<typeof postgres>;
  let app: ReturnType<typeof createApp>;
  const actors: string[] = [];
  let w1: string, w2: string, ch1: string, ch2: string, w2ch: string;

  const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const header = (path: string, method: string, actor: number, data: string, strict: boolean) => {
    const tags = [['u', `http://localhost${path}`], ['method', method], ...(data || strict ? [['payload', sha(data)]] : []), ...(strict ? [['nonce', randomBytes(16).toString('hex')]] : [])];
    return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags }, secrets[actor]!))).toString('base64')}`;
  };
  async function request(path: string, method: string, actor: number, body?: unknown, strict = false) {
    const data = body === undefined ? '' : JSON.stringify(body);
    const response = await app.request(path, { method, body: body === undefined ? undefined : data, headers: { Authorization: header(path, method, actor, data, strict), 'Content-Type': 'application/json' } });
    const text = await response.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: response.status, body: json, text };
  }
  const fd = (w: string, rest: string) => `/api/v4/flightdeck-pg/workspaces/${w}${rest}`;
  const inbox = (w = w1) => fd(w, '/agent-notifications');
  const drain = async () => { for (let i = 0; i < 30; i++) if ((await processAgentIntakeBatch({ sql: db, limit: 50 })).claimed === 0) return; };
  async function notifications(actor: number, w = w1) {
    const sub = await request(`${inbox(w)}/subscriptions`, 'POST', actor, { consumer_id: `consumer-${actor}` }, true);
    expect([200, 201]).toContain(sub.status);
    const page = await request(`${inbox(w)}?cursor=${encodeURIComponent(sub.body.cursor)}&limit=100`, 'GET', actor, undefined, true);
    expect(page.status).toBe(200);
    return page.body.notifications as any[];
  }
  type PostOptions = { actor?: number; mentions?: number[]; threadId?: string; createThread?: boolean; origin?: string; mentionsTag?: 'canonical' | 'none' | 'wrong'; workspace?: string };
  function signature(body: string, actor: number, w: string, channel: string, threadId: string | undefined, mentions: Array<{ type: string; npub: string }>, tag: PostOptions['mentionsTag'], extra: string[][] = []) {
    const tags = [['protocol', 'flightdeck_pg_message_instruction'], ['body_sha256', sha(body)], ['workspace_id', w], ['channel_id', channel], ...(threadId ? [['thread_id', threadId]] : []), ...extra];
    if (tag === 'canonical') tags.push(['mentions_sha256', canonicalMentionsSha256(mentions)]);
    if (tag === 'wrong') tags.push(['mentions_sha256', canonicalMentionsSha256([])]);
    const event = finalizeEvent({ kind: 33358, created_at: Math.floor(Date.now() / 1000), tags, content: body }, secrets[actor]!);
    return { version: 1, signer_npub: npubs[actor], body_sha256: sha(body), nostr_event: event };
  }
  async function post(channel: string, body: string, opts: PostOptions = {}) {
    const actor = opts.actor ?? H;
    const w = opts.workspace ?? w1;
    const mentions = (opts.mentions ?? []).map((i) => ({ type: 'agent', npub: npubs[i]!, label: `Bot${i}` }));
    return request(fd(w, `/channels/${channel}/messages`), 'POST', actor, {
      body, ...(opts.threadId ? { thread_id: opts.threadId } : {}), ...(opts.createThread ? { create_thread: true, thread_title: 'Thread' } : {}),
      ...(mentions.length ? { mentions } : {}), ...(opts.origin ? { origin_notification_id: opts.origin } : {}),
      message_signature: signature(body, actor, w, channel, opts.threadId, mentions, opts.mentionsTag ?? 'none'),
    });
  }
  const classify = (target: number) => db`INSERT INTO flightdeck_pg_agent_access_profiles (workspace_id, actor_id, profile) VALUES (${w1}, ${actors[target]!}, 'notification_only') ON CONFLICT DO NOTHING`;
  // A completed private storage object uploaded by `actor`.
  async function blob(actor: number, content: string, type = 'text/markdown', owner = H) {
    const [row] = await db<{ id: string }[]>`
      INSERT INTO v4_storage_objects (owner_npub, created_by_npub, storage_path, content_type, is_public)
      VALUES (${npubs[owner]!}, ${npubs[actor]!}, ${`receipts-${randomUUID()}`}, ${type}, false) RETURNING id`;
    expect(await writeStorageObject(row!.id, new TextEncoder().encode(content), npubs[actor]!)).toBeTruthy();
    expect(await completeStorageObject(row!.id, {}, npubs[actor]!)).toBeTruthy();
    return row!.id;
  }

  // Origin: a human mention of A in a thread of ch1. Returns the thread and A's notification id.
  async function origin(label: string, channel = ch1) {
    const root = await post(channel, `root ${label}`, { createThread: true });
    expect(root.status).toBe(201);
    const threadId = root.body.message.thread_id as string;
    const mention = await post(channel, `please handle ${label}`, { threadId, mentions: [A] });
    expect(mention.status).toBe(201);
    await drain();
    const n = (await notifications(A)).find((x) => x.source?.id === mention.body.message.id);
    expect(n?.reason).toBe('canonical_mention');
    return { threadId, notificationId: n.id as string, messageId: mention.body.message.id as string };
  }

  beforeAll(async () => {
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database, max: 20 });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    for (const [i, kind] of ['human', 'agent', 'agent', 'human', 'human'].entries()) {
      actors.push((await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${npubs[i]!},${kind},${`Actor${i}`}) RETURNING id`)[0]!.id);
    }
    w1 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-rc','service-rc',${npubs[H]!},'app','W1') RETURNING id`)[0]!.id;
    w2 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-rc','service-rc2',${npubs[H2]!},'app','W2') RETURNING id`)[0]!.id;
    for (const [i, role] of [[H, 'owner'], [A, 'member'], [B, 'member'], [C, 'member']] as const) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w1},${actors[i]!},${role})`;
    for (const [i, role] of [[H2, 'owner'], [A, 'member']] as const) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w2},${actors[i]!},${role})`;
    const scope = (await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w1},'Main','project') RETURNING id`)[0]!.id;
    ch1 = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'General') RETURNING id`)[0]!.id;
    ch2 = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'Other') RETURNING id`)[0]!.id;
    const w2scope = (await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w2},'Main','project') RETURNING id`)[0]!.id;
    w2ch = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w2},${w2scope},'General') RETURNING id`)[0]!.id;
    const grant = (w: string, actor: string, channel: string, permission: string) =>
      db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${actor},'channel',${channel},${permission})`;
    const perms = ['channel.read', 'channel.write', 'task.read', 'task.create', 'task.update', 'task.comment', 'doc.read', 'doc.write', 'file.read', 'file.write', 'audio_note.read', 'audio_note.write'];
    for (const i of [H, A, B, C]) for (const ch of [ch1, ch2]) for (const p of perms) await grant(w1, actors[i]!, ch, p);
    for (const i of [H2, A]) for (const p of perms) await grant(w2, actors[i]!, w2ch, p);
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${w1},'actor',${actors[H]!},'workspace','workspace.manage')`;
    enableInMemoryStorageForTest();
    setDb(db); clearWsKeyCacheForTests(); app = createApp();
    await classify(A);
  });
  afterEach(async () => {
    // A stays classified; B is classified only where a test says so.
    await db`DELETE FROM flightdeck_pg_agent_access_profiles WHERE actor_id = ${actors[B]!}`;
  });
  afterAll(async () => {
    resetInMemoryStorageForTest();
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end();
  });

  // ------------------------------------------------------------------------------------------------ self-address
  test('verified self-address: projected with its origin; context stops at the origin plus own messages; no extra human content', async () => {
    const o = await origin('self-1');
    const ownReply = await post(ch1, 'own progress reply', { actor: A, threadId: o.threadId });
    expect(ownReply.status).toBe(201);
    const humanAfter = await post(ch1, 'SENTINEL-UNADDRESSED-HUMAN-AFTER-ORIGIN', { threadId: o.threadId });
    expect(humanAfter.status).toBe(201);
    const self = await post(ch1, 'continue with the next step', { actor: A, threadId: o.threadId, mentions: [A], origin: o.notificationId, mentionsTag: 'canonical' });
    expect(self.status).toBe(201);
    await drain();
    const all = await notifications(A);
    const n = all.find((x) => x.source?.id === self.body.message.id);
    expect(n).toBeTruthy();
    expect([n.kind, n.reason, n.origin_notification_id, n.author_npub]).toEqual(['chat_mention', 'self_mention', o.notificationId, npubs[A]]);
    // Ordinary own output is never projected.
    expect(all.some((x) => x.source?.id === ownReply.body.message.id)).toBe(false);
    const context = await request(`${inbox()}/${n.id}/context`, 'GET', A, undefined, true);
    expect(context.status).toBe(200);
    const ids = context.body.window.messages.map((m: any) => m.id);
    expect(ids).toContain(o.messageId);
    expect(ids).toContain(ownReply.body.message.id);
    expect(context.text).not.toContain('SENTINEL-UNADDRESSED-HUMAN-AFTER-ORIGIN');
    // The origin's own context (human-addressed) is unchanged by the self-address.
    const originContext = await request(`${inbox()}/${o.notificationId}/context`, 'GET', A, undefined, true);
    expect(originContext.status).toBe(200);
  });

  test('self-address eligibility fails closed: no mentions_sha256, no origin, unrelated origin, or a revision after the event', async () => {
    const o = await origin('self-2');
    const noTag = await post(ch1, 'self without tag', { actor: A, threadId: o.threadId, mentions: [A], origin: o.notificationId, mentionsTag: 'none' });
    const noOrigin = await post(ch1, 'self without origin', { actor: A, threadId: o.threadId, mentions: [A], mentionsTag: 'canonical' });
    expect([noTag.status, noOrigin.status]).toEqual([201, 201]);
    // A tag that does not bind the saved mentions is refused at write.
    const wrongTag = await post(ch1, 'self with wrong tag', { actor: A, threadId: o.threadId, mentions: [A], origin: o.notificationId, mentionsTag: 'wrong' });
    expect(wrongTag.status).toBe(400);
    // An origin from another thread, or another bot's notification, is refused at write.
    const other = await origin('self-2b');
    const crossThread = await post(ch1, 'self with foreign-thread origin', { actor: A, threadId: o.threadId, mentions: [A], origin: other.notificationId, mentionsTag: 'canonical' });
    expect(crossThread.status).toBe(403);
    const invented = await post(ch1, 'self with invented origin', { actor: A, threadId: o.threadId, mentions: [A], origin: randomUUID(), mentionsTag: 'canonical' });
    expect(invented.status).toBe(403);
    // Revised before projection: the event's revision is no longer the stored one, so it is not projected.
    const revisedLater = await post(ch1, 'self then edited', { actor: A, threadId: o.threadId, mentions: [A], origin: o.notificationId, mentionsTag: 'canonical' });
    expect(revisedLater.status).toBe(201);
    // (A classified bot cannot PATCH messages at all; any later revision of the row has the same effect.)
    await db`UPDATE flightdeck_pg_messages SET body = body || ' (v2)', row_version = row_version + 1 WHERE id = ${revisedLater.body.message.id}`;
    // Origin live at write but withdrawn before projection: the projector re-checks it.
    const late = await origin('self-2c');
    const beforeWithdraw = await post(ch1, 'self, origin withdrawn before projection', { actor: A, threadId: late.threadId, mentions: [A], origin: late.notificationId, mentionsTag: 'canonical' });
    expect(beforeWithdraw.status).toBe(201);
    await db`UPDATE flightdeck_pg_messages SET metadata = metadata || '{"mentions": []}'::jsonb WHERE id = ${late.messageId}`;
    await drain();
    const all = await notifications(A);
    for (const message of [noTag, noOrigin, revisedLater, beforeWithdraw]) {
      expect(all.some((x) => x.source?.id === message.body.message.id)).toBe(false);
      // Not merely hidden: no row is projected at all.
      expect(Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_agent_notifications WHERE source_id = ${message.body.message.id}`)[0]!.n)).toBe(0);
    }
  });

  test('a self_mention is revoked with its origin; the bot keeps writing by its ordinary ACL', async () => {
    const o = await origin('self-3');
    const self = await post(ch1, 'self before withdrawal', { actor: A, threadId: o.threadId, mentions: [A], origin: o.notificationId, mentionsTag: 'canonical' });
    expect(self.status).toBe(201);
    await drain();
    const selfRow = (await notifications(A)).find((x) => x.source?.id === self.body.message.id);
    expect([selfRow?.state, selfRow?.reason]).toEqual(['active', 'self_mention']);
    // The human withdraws the mention that was the origin.
    const original = await db<{ row_version: number }[]>`SELECT row_version FROM flightdeck_pg_messages WHERE id = ${o.messageId}`;
    const body = 'please handle self-3';
    const withdraw = await request(fd(w1, `/messages/${o.messageId}`), 'PATCH', H, {
      body, row_version: original[0]!.row_version, mentions: [],
      message_signature: signature(body, H, w1, ch1, o.threadId, [], 'none', [['message_id', o.messageId], ['revision', String(Number(original[0]!.row_version) + 1)]]),
    });
    expect(withdraw.status).toBe(200);
    const after = await notifications(A);
    expect(after.find((x) => x.id === o.notificationId)?.state).toBe('revoked');
    // The self-address depends on its origin: it is revoked with it.
    expect(after.find((x) => x.id === selfRow.id)).toEqual({ id: selfRow.id, seq: selfRow.seq, state: 'revoked' });
    // Writing is not a notification binding: the bot still writes where its ACL allows.
    expect((await post(ch1, 'still here?', { actor: A, threadId: o.threadId })).status).toBe(201);
  });

  // ------------------------------------------------------------------------------------------------ receipts
  async function createDoc(actor: number, title: string, originId?: string, channel = ch1, w = w1) {
    const objectId = await blob(actor, `# ${title}\nbot output`);
    return request(fd(w, `/channels/${channel}/docs`), 'POST', actor, { title, storage_object_id: objectId, ...(originId ? { origin_notification_id: originId } : {}) });
  }
  async function lease(actor: number, docId: string) {
    const res = await request(fd(w1, '/edit-leases/acquire'), 'POST', actor, { entity_type: 'document', entity_id: docId, ttl_seconds: 60 });
    return res;
  }
  async function patchTitle(actor: number, docId: string, title: string, rowVersion: number) {
    const held = await lease(actor, docId);
    if (held.status !== 201) return held;
    const res = await request(fd(w1, `/docs/${docId}`), 'PATCH', actor, { title, row_version: rowVersion, lease_token: held.body.lease.lease_token });
    await request(fd(w1, `/edit-leases/${held.body.lease.id}/release`), 'POST', actor, { lease_token: held.body.lease.lease_token });
    return res;
  }

  test('origins are exact: invented, foreign-bot, other-channel and cross-workspace ids mint nothing', async () => {
    const receiptsBefore = Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_agent_work_receipts`)[0]!.n);
    const o = await origin('receipt-origins');
    expect((await createDoc(A, 'invented', randomUUID())).status).toBe(403);
    expect((await createDoc(A, 'other channel', o.notificationId, ch2)).status).toBe(403);
    // Another bot's notification.
    const forB = await post(ch1, 'B please look', { threadId: o.threadId, mentions: [B] });
    expect(forB.status).toBe(201);
    await drain();
    const bNotification = (await notifications(B)).find((x) => x.source?.id === forB.body.message.id)!;
    expect((await createDoc(A, 'foreign bot origin', bNotification.id)).status).toBe(403);
    // Handler-side check too: an unclassified bot cannot borrow A's origin.
    const borrowed = await createDoc(B, 'borrowed origin', o.notificationId);
    expect([borrowed.status, borrowed.body.code]).toEqual([403, 'origin_notification_invalid']);
    expect(Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_agent_work_receipts WHERE recipient_actor_id = ${actors[B]!}`)[0]!.n)).toBe(0);
    // Cross workspace: a W2 notification as the origin of a W1 create.
    const w2root = await post(w2ch, 'w2 root', { actor: H2, workspace: w2, createThread: true });
    const w2mention = await post(w2ch, 'w2 for A', { actor: H2, workspace: w2, threadId: w2root.body.message.thread_id, mentions: [A] });
    await drain();
    const w2n = (await notifications(A, w2)).find((x) => x.source?.id === w2mention.body.message.id)!;
    expect(w2n).toBeTruthy();
    expect((await createDoc(A, 'cross workspace', w2n.id)).status).toBe(403);
    // Nothing was minted for any refused create.
    expect(Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_agent_work_receipts`)[0]!.n)).toBe(receiptsBefore);
  });

  test('a classified bot uses its ordinary ACL: it creates a doc and reads and edits it later, outside any notification', async () => {
    const o = await origin('acl-doc');
    const created = await createDoc(A, 'Bot report', o.notificationId);
    expect(created.status).toBe(201);
    const docId = created.body.doc.id as string;
    expect(created.body.work_receipt).toMatchObject({ entity_type: 'doc', entity_id: docId, origin_notification_id: o.notificationId });
    // The origin is withdrawn: the receipt is provenance only, so the bot's ACL still decides.
    const [row] = await db<{ row_version: number }[]>`SELECT row_version FROM flightdeck_pg_messages WHERE id = ${o.messageId}`;
    const body = 'please handle acl-doc';
    expect((await request(fd(w1, `/messages/${o.messageId}`), 'PATCH', H, {
      body, row_version: row!.row_version, mentions: [],
      message_signature: signature(body, H, w1, ch1, o.threadId, [], 'none', [['message_id', o.messageId], ['revision', String(Number(row!.row_version) + 1)]]),
    })).status).toBe(200);
    const read = await request(fd(w1, `/docs/${docId}/body`), 'GET', A);
    expect(read.status).toBe(200);
    const human = await createDoc(H, 'Human doc');
    expect((await patchTitle(A, human.body.doc.id, 'Edited by bot', Number(human.body.doc.row_version))).status).toBe(200);
    expect((await request(fd(w1, `/docs/${human.body.doc.id}`), 'GET', A)).body.doc.title).toBe('Edited by bot');
    // Out-of-trigger chat, task and document work in another granted channel, with no notification there.
    const thread = await post(ch2, 'bot starts its own thread', { actor: A, createThread: true });
    expect(thread.status).toBe(201);
    expect((await request(fd(w1, `/channels/${ch2}/messages?thread_id=${thread.body.message.thread_id}`), 'GET', A)).status).toBe(200);
    const task = await request(fd(w1, `/channels/${ch2}/tasks`), 'POST', A, { title: 'bot task' });
    expect(task.status).toBe(201);
    expect((await request(fd(w1, `/tasks/${task.body.task.id}/comments`), 'POST', A, { body: 'bot comment' })).status).toBe(201);
    expect((await request(fd(w1, `/tasks/${task.body.task.id}`), 'GET', A)).status).toBe(200);
    expect((await request(fd(w1, '/sync'), 'GET', A)).status).toBe(200);
    expect((await createDoc(A, 'Second bot doc', undefined, ch2)).status).toBe(201);
  });

  test('a classified bot is still refused where its ACL does not reach: ungranted channels and other workspaces', async () => {
    const scope = (await db`SELECT scope_id FROM flightdeck_pg_channels WHERE id = ${ch1}`)[0]!.scope_id;
    const closed = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'Closed') RETURNING id`)[0]!.id;
    for (const p of ['channel.read', 'channel.write', 'task.read', 'task.create', 'doc.read', 'doc.write']) {
      await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w1},'actor',${actors[H]!},'channel',${closed},${p})`;
    }
    const secret = await post(closed, 'SENTINEL-CLOSED-CHANNEL', { createThread: true });
    expect(secret.status).toBe(201);
    const peek = await request(fd(w1, `/channels/${closed}/messages?thread_id=${secret.body.message.thread_id}`), 'GET', A);
    expect(peek.status).toBe(403);
    expect(peek.text).not.toContain('SENTINEL-CLOSED-CHANNEL');
    expect((await request(fd(w1, `/channels/${closed}/tasks`), 'POST', A, { title: 'not here' })).status).toBe(403);
    expect((await post(closed, 'not here either', { actor: A })).status).toBe(403);
    // B is not a W2 member: cross-workspace reads and writes stay refused, classified or not.
    await db`INSERT INTO flightdeck_pg_agent_access_profiles (workspace_id, actor_id, profile) VALUES (${w1}, ${actors[B]!}, 'notification_only')`;
    expect((await request(fd(w2, `/channels/${w2ch}/messages`), 'GET', B)).status).toBe(403);
    expect((await request(fd(w2, `/channels/${w2ch}/tasks`), 'POST', B, { title: 'cross workspace' })).status).toBe(403);
  });

  test('self context is a subset of the origin context plus verified bot-own messages; human edits/links on bot messages stay out', async () => {
    const o = await origin('self-subset');
    const botLater = await post(ch1, 'bot later message', { actor: A, threadId: o.threadId });
    const botEdited = await post(ch1, 'bot message a human will edit', { actor: A, threadId: o.threadId });
    expect([botLater.status, botEdited.status]).toEqual([201, 201]);
    // A human edit of a bot message after the origin, and a human-linked attachment on another bot message.
    await db`UPDATE flightdeck_pg_messages SET body = 'SENTINEL-HUMAN-EDIT-OF-BOT-MESSAGE', updated_by_actor_id = ${actors[H]!}, row_version = row_version + 1 WHERE id = ${botEdited.body.message.id}`;
    const humanObject = await blob(H, 'SENTINEL-HUMAN-LINKED-BYTES', 'text/plain');
    await db`INSERT INTO flightdeck_pg_storage_links (workspace_id, scope_id, channel_id, entity_type, entity_id, storage_object_id, created_by_actor_id)
      SELECT ${w1}, scope_id, id, 'message', ${botLater.body.message.id}, ${humanObject}, ${actors[H]!} FROM flightdeck_pg_channels WHERE id = ${ch1}`;
    const self = await post(ch1, 'self after edits', { actor: A, threadId: o.threadId, mentions: [A], origin: o.notificationId, mentionsTag: 'canonical' });
    expect(self.status).toBe(201);
    await drain();
    const n = (await notifications(A)).find((x) => x.source?.id === self.body.message.id)!;
    const selfContext = await request(`${inbox()}/${n.id}/context`, 'GET', A, undefined, true);
    const originContext = await request(`${inbox()}/${o.notificationId}/context`, 'GET', A, undefined, true);
    expect([selfContext.status, originContext.status]).toEqual([200, 200]);
    const originMessages = new Map<string, any>([originContext.body.trigger.message, ...originContext.body.window.messages].map((m: any) => [m.id, m]));
    for (const m of selfContext.body.window.messages) {
      if (m.id === botLater.body.message.id) continue; // verified bot-own later message
      expect(originMessages.has(m.id)).toBe(true);
      expect(m.body).toBe(originMessages.get(m.id).body);
      expect(m.attachments).toEqual(originMessages.get(m.id).attachments);
    }
    const ids = selfContext.body.window.messages.map((m: any) => m.id);
    expect(ids).toContain(botLater.body.message.id);
    expect(ids).not.toContain(botEdited.body.message.id);
    expect(selfContext.text).not.toContain('SENTINEL-HUMAN-EDIT-OF-BOT-MESSAGE');
    expect(selfContext.body.window.messages.find((m: any) => m.id === botLater.body.message.id).attachments).toEqual([]);
    const download = await request(`${inbox()}/${n.id}/attachments/${humanObject}`, 'GET', A, undefined, true);
    expect(download.status).toBe(404);
    expect(download.text).not.toContain('SENTINEL-HUMAN-LINKED-BYTES');
  });

  test('a self_mention whose trigger is edited after projection is revoked; no changed trigger is served', async () => {
    const o = await origin('self-post-edit');
    const self = await post(ch1, 'self, then edited by a human', { actor: A, threadId: o.threadId, mentions: [A], origin: o.notificationId, mentionsTag: 'canonical' });
    await drain();
    const n = (await notifications(A)).find((x) => x.source?.id === self.body.message.id)!;
    expect(n.state).toBe('active');
    await db`UPDATE flightdeck_pg_messages SET body = 'SENTINEL-HUMAN-EDITED-SELF-TRIGGER', updated_by_actor_id = ${actors[H]!}, row_version = row_version + 1 WHERE id = ${self.body.message.id}`;
    expect((await notifications(A)).find((x) => x.id === n.id)).toEqual({ id: n.id, seq: n.seq, state: 'revoked' });
    const context = await request(`${inbox()}/${n.id}/context`, 'GET', A, undefined, true);
    expect([context.status, context.body.code]).toEqual([403, 'relationship_removed']);
    expect(context.text).not.toContain('SENTINEL-HUMAN-EDITED-SELF-TRIGGER');
  });

  test('concurrent updates through one receipt serialize: exactly one wins', async () => {
    const o = await origin('receipt-race');
    const created = await createDoc(A, 'Race doc', o.notificationId);
    expect(created.status).toBe(201);
    const docId = created.body.doc.id as string;
    const version = Number(created.body.doc.row_version);
    const held = await lease(A, docId);
    expect(held.status).toBe(201);
    const send = (title: string) => request(fd(w1, `/docs/${docId}`), 'PATCH', A, { title, row_version: version, lease_token: held.body.lease.lease_token });
    const results = await Promise.all([send('race one'), send('race two')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  test('task state returns the advanced receipt; an unclassified holder keeps a receipt only while it matches', async () => {
    const o = await origin('receipt-advance');
    const task = await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', A, { title: 'Advance task', origin_notification_id: o.notificationId });
    const state = await request(fd(w1, `/tasks/${task.body.task.id}/state`), 'POST', A, { state: 'in_progress' });
    expect(state.status).toBe(200);
    expect(state.body.work_receipt.receipt_row_version).toBe(Number(state.body.task.row_version));
    // Unclassified bot B with its own origin and receipt.
    const forB = await post(ch1, 'B, a task please', { threadId: o.threadId, mentions: [B] });
    await drain();
    const bOrigin = (await notifications(B)).find((x) => x.source?.id === forB.body.message.id)!;
    const bTask = await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', B, { title: 'B task', origin_notification_id: bOrigin.id });
    expect(bTask.status).toBe(201);
    const bState = await request(fd(w1, `/tasks/${bTask.body.task.id}/state`), 'POST', B, { state: 'in_progress' });
    expect(bState.body.work_receipt?.receipt_row_version).toBe(Number(bState.body.task.row_version));
    const v = Number((await db<{ row_version: number }[]>`SELECT row_version FROM flightdeck_pg_tasks WHERE id = ${bTask.body.task.id}`)[0]!.row_version);
    expect((await request(fd(w1, `/tasks/${bTask.body.task.id}`), 'PATCH', H, { title: 'human retitle', row_version: v })).status).toBe(200);
    const after = await request(fd(w1, `/tasks/${bTask.body.task.id}/state`), 'POST', B, { state: 'done' });
    expect(after.status).toBe(200); // B is unrestricted
    expect(after.body.work_receipt).toBeUndefined(); // its receipt no longer matches and does not follow
  });

  test('mint linearizes with a concurrent subscription revocation: a revoke that commits first is observed', async () => {
    const o = await origin('receipt-revoke-race');
    let release!: () => void; let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const isLocked = new Promise<void>((r) => { locked = r; });
    const revoke = db.begin(async (tx) => {
      await tx`UPDATE flightdeck_pg_agent_notification_subscriptions SET revoked_at = NOW() WHERE workspace_id = ${w1} AND recipient_actor_id = ${actors[A]!} AND revoked_at IS NULL`;
      locked();
      await released;
    });
    await isLocked;
    try {
      const pending = createDoc(A, 'raced doc', o.notificationId);
      // A row-lock wait is a wait on the revoking transaction (locktype transactionid), seen as a Lock wait event.
      const waiting = async () => Number((await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n);
      for (let i = 0; i < 60 && await waiting() === 0; i++) await Bun.sleep(50);
      expect(await waiting()).toBeGreaterThan(0);
      release();
      await revoke;
      expect((await pending).status).toBe(403);
    } finally {
      release();
      await revoke.catch(() => {});
      await db`UPDATE flightdeck_pg_agent_notification_subscriptions SET revoked_at = NULL WHERE workspace_id = ${w1} AND recipient_actor_id = ${actors[A]!}`;
    }
  });

  // ------------------------------------------------------------------------------------------------ idempotent replays
  // ------------------------------------------------------------------------------------------------ storage adoption
  // ------------------------------------------------------------------------------------------------ reviewer F4-F6
  test('a bot classified in W1 keeps unrestricted behaviour in W2 (audio targets, lease inspection, mention errors)', async () => {
    const root = await post(w2ch, 'w2 threaded root', { actor: H2, workspace: w2, createThread: true });
    expect(root.status).toBe(201);
    // Audio note targeting a threaded W2 message without naming the thread: allowed as for anyone unrestricted.
    const note = await request(fd(w2, `/channels/${w2ch}/audio-notes`), 'POST', A, { storage_object_id: await blob(A, 'w2 audio', 'audio/webm', H2), mime_type: 'audio/webm', target_type: 'message', target_id: root.body.message.id });
    expect(note.status).toBe(201);
    expect(note.body.audio_note.thread_id).toBe(root.body.message.thread_id);
    // Lease inspection shows another editor's lease, as for any unrestricted caller.
    const doc = await request(fd(w2, `/channels/${w2ch}/docs`), 'POST', H2, { title: 'W2 doc', storage_object_id: await blob(H2, 'w2 doc', 'text/markdown', H2) });
    expect(doc.status).toBe(201);
    const held = await request(fd(w2, '/edit-leases/acquire'), 'POST', H2, { entity_type: 'document', entity_id: doc.body.doc.id, ttl_seconds: 60 });
    expect(held.status).toBe(201);
    const inspected = await request(fd(w2, `/edit-leases?entity_type=document&entity_id=${doc.body.doc.id}`), 'GET', A);
    expect([inspected.status, inspected.body.lease?.holder_actor_npub]).toEqual([200, npubs[H2]]);
    // Mention errors keep their specific codes.
    const body = 'mention in w2';
    const mentions = [{ type: 'agent', npub: nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(251))) }];
    const mention = await request(fd(w2, `/channels/${w2ch}/messages`), 'POST', A, { body, thread_id: root.body.message.thread_id, mentions, message_signature: signature(body, A, w2, w2ch, root.body.message.thread_id, mentions, 'none') });
    expect([mention.status, mention.body.details?.fields?.[0]?.code]).toEqual([400, 'unknown_actor']);
  });
});
