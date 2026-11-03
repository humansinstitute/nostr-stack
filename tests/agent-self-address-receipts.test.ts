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

// Deliberate self-address (reason self_mention) and version-bound work-output receipts for notification-only bots.
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
  async function blob(actor: number, content: string, type = 'text/markdown') {
    const [row] = await db<{ id: string }[]>`
      INSERT INTO v4_storage_objects (owner_npub, created_by_npub, storage_path, content_type, is_public)
      VALUES (${npubs[H]!}, ${npubs[actor]!}, ${`receipts-${randomUUID()}`}, ${type}, false) RETURNING id`;
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

  test('a self_mention binds nothing by itself: once its origin is withdrawn the thread is closed to the bot', async () => {
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
    // The bot's own self_mention row does not keep the thread writable.
    expect((await post(ch1, 'still here?', { actor: A, threadId: o.threadId })).status).toBe(403);
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

  test('doc receipt: minted with the create; the bot reads and updates only the version it wrote; a human edit freezes it with no content', async () => {
    const o = await origin('receipt-doc');
    const created = await createDoc(A, 'Bot report', o.notificationId);
    expect(created.status).toBe(201);
    const docId = created.body.doc.id as string;
    expect(created.body.work_receipt).toEqual({
      entity_type: 'doc', entity_id: docId, receipt_row_version: Number(created.body.doc.row_version), origin_notification_id: o.notificationId,
      body_sha256_hex: expect.any(String), version_id: null,
    });
    expect((await request(fd(w1, `/docs/${docId}`), 'GET', A)).status).toBe(200);
    const body = await request(fd(w1, `/docs/${docId}/body`), 'GET', A);
    expect(body.status).toBe(200);
    expect(Buffer.from(body.body.body.base64_data, 'base64').toString()).toContain('bot output');
    // The bot's own update advances the receipt.
    const current = Number((await request(fd(w1, `/docs/${docId}`), 'GET', A)).body.doc.row_version);
    const own = await patchTitle(A, docId, 'Bot report v2', current);
    expect(own.status).toBe(200);
    expect((await request(fd(w1, `/docs/${docId}`), 'GET', A)).body.doc.title).toBe('Bot report v2');
    // Stale base through a receipt.
    const stale = await patchTitle(A, docId, 'Bot report stale', current);
    expect([stale.status, stale.body.code]).toEqual([409, 'work_output_changed']);
    // A human edit: frozen for the bot, with no content in the refusal.
    const humanVersion = Number((await db<{ row_version: number }[]>`SELECT row_version FROM flightdeck_pg_docs WHERE id = ${docId}`)[0]!.row_version);
    expect((await patchTitle(H, docId, 'SENTINEL-HUMAN-DOC-TITLE', humanVersion)).status).toBe(200);
    for (const path of [`/docs/${docId}`, `/docs/${docId}/body`]) {
      const frozen = await request(fd(w1, path), 'GET', A);
      expect([path, frozen.status, frozen.body.code]).toEqual([path, 409, 'work_output_changed']);
      expect(frozen.text).not.toContain('SENTINEL-HUMAN-DOC-TITLE');
      expect(Object.keys(frozen.body).sort()).toEqual(['code', 'error', 'identity', 'retryable']);
    }
    // No update or lease at the human version either.
    const blocked = await lease(A, docId);
    expect([blocked.status, blocked.body.code]).toEqual([409, 'work_output_changed']);
    expect(blocked.text).not.toContain('SENTINEL-HUMAN-DOC-TITLE');
    // Comments are never readable through a receipt.
    expect((await request(fd(w1, `/docs/${docId}/comments`), 'GET', A)).status).toBe(403);
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

  test('origins are exact: invented, foreign-bot, other-channel and cross-workspace ids mint nothing; other actors output stays closed', async () => {
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
    // A human's own document is never readable through anything A holds.
    const human = await createDoc(H, 'SENTINEL-HUMAN-OWN-DOC');
    expect(human.status).toBe(201);
    const peek = await request(fd(w1, `/docs/${human.body.doc.id}`), 'GET', A);
    expect(peek.status).toBe(403);
    expect(peek.text).not.toContain('SENTINEL-HUMAN-OWN-DOC');
    // Nothing was minted for any refused create.
    expect(Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_agent_work_receipts`)[0]!.n)).toBe(receiptsBefore);
  });

  test('a receipt lives only while its origin does: withdrawing the origin closes the bot output', async () => {
    const o = await origin('receipt-withdraw');
    const created = await createDoc(A, 'Withdrawn origin doc', o.notificationId);
    expect(created.status).toBe(201);
    expect((await request(fd(w1, `/docs/${created.body.doc.id}`), 'GET', A)).status).toBe(200);
    const [row] = await db<{ row_version: number }[]>`SELECT row_version FROM flightdeck_pg_messages WHERE id = ${o.messageId}`;
    const body = 'please handle receipt-withdraw';
    expect((await request(fd(w1, `/messages/${o.messageId}`), 'PATCH', H, {
      body, row_version: row!.row_version, mentions: [],
      message_signature: signature(body, H, w1, ch1, o.threadId, [], 'none', [['message_id', o.messageId], ['revision', String(Number(row!.row_version) + 1)]]),
    })).status).toBe(200);
    expect((await request(fd(w1, `/docs/${created.body.doc.id}`), 'GET', A)).status).toBe(403);
  });

  test('task receipt: read and state change at the bot version; a human edit freezes both', async () => {
    const o = await origin('receipt-task');
    const created = await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', A, { title: 'Bot task', origin_notification_id: o.notificationId });
    expect(created.status).toBe(201);
    const taskId = created.body.task.id as string;
    expect(created.body.work_receipt).toMatchObject({ entity_type: 'task', entity_id: taskId, origin_notification_id: o.notificationId });
    expect((await request(fd(w1, `/tasks/${taskId}`), 'GET', A)).status).toBe(200);
    expect((await request(fd(w1, `/tasks/${taskId}/state`), 'POST', A, { state: 'in_progress' })).status).toBe(200);
    expect((await request(fd(w1, `/tasks/${taskId}`), 'GET', A)).body.task.state).toBe('in_progress');
    const version = Number((await db<{ row_version: number }[]>`SELECT row_version FROM flightdeck_pg_tasks WHERE id = ${taskId}`)[0]!.row_version);
    expect((await request(fd(w1, `/tasks/${taskId}`), 'PATCH', H, { title: 'SENTINEL-HUMAN-TASK-TITLE', row_version: version })).status).toBe(200);
    const frozen = await request(fd(w1, `/tasks/${taskId}`), 'GET', A);
    expect([frozen.status, frozen.body.code]).toEqual([409, 'work_output_changed']);
    expect(frozen.text).not.toContain('SENTINEL-HUMAN-TASK-TITLE');
    const state = await request(fd(w1, `/tasks/${taskId}/state`), 'POST', A, { state: 'done' });
    expect([state.status, state.body.code]).toEqual([409, 'work_output_changed']);
    expect((await db<{ state: string }[]>`SELECT state FROM flightdeck_pg_tasks WHERE id = ${taskId}`)[0]!.state).toBe('in_progress');
  });

  test('file receipt: the exact receipted version only; a newer human version is never served through it', async () => {
    const o = await origin('receipt-file');
    const objectId = await blob(A, 'bot file bytes v1', 'text/plain');
    const created = await request(fd(w1, `/channels/${ch1}/files`), 'POST', A, { storage_object_id: objectId, display_name: 'bot.txt', origin_notification_id: o.notificationId });
    expect(created.status).toBe(201);
    const fileId = created.body.file.id as string;
    const versionId = created.body.work_receipt.version_id as string;
    expect(versionId).toBeTruthy();
    expect((await request(fd(w1, `/files/${fileId}`), 'GET', A)).status).toBe(200);
    const own = await app.request(fd(w1, `/files/${fileId}/versions/${versionId}/object`), { headers: { Authorization: header(fd(w1, `/files/${fileId}/versions/${versionId}/object`), 'GET', A, '', false) } });
    expect([own.status, await own.text()]).toEqual([200, 'bot file bytes v1']);
    // A human uploads a newer version.
    const humanObject = await blob(H, 'SENTINEL-HUMAN-FILE-V2', 'text/plain');
    const next = await request(fd(w1, `/files/${fileId}/versions`), 'POST', H, { base_version_id: versionId, storage_object_id: humanObject });
    expect(next.status).toBe(201);
    const newVersionId = (await db<{ current_version_id: string }[]>`SELECT current_version_id FROM flightdeck_pg_files WHERE id = ${fileId}`)[0]!.current_version_id;
    for (const path of [`/files/${fileId}`, `/files/${fileId}/object`, `/files/${fileId}/versions/${newVersionId}/object`]) {
      const res = await request(fd(w1, path), 'GET', A);
      expect([path, res.status, res.body.code]).toEqual([path, 409, 'work_output_changed']);
      expect(res.text).not.toContain('SENTINEL-HUMAN-FILE-V2');
    }
    // The bot's own receipted bytes remain readable.
    const stillOwn = await app.request(fd(w1, `/files/${fileId}/versions/${versionId}/object`), { headers: { Authorization: header(fd(w1, `/files/${fileId}/versions/${versionId}/object`), 'GET', A, '', false) } });
    expect(stillOwn.status).toBe(200);
  });

  test('audio note receipt: readable at the bot version', async () => {
    const o = await origin('receipt-audio');
    const objectId = await blob(A, 'audio bytes', 'audio/webm');
    const created = await request(fd(w1, `/channels/${ch1}/audio-notes`), 'POST', A, { storage_object_id: objectId, mime_type: 'audio/webm', origin_notification_id: o.notificationId });
    expect(created.status).toBe(201);
    expect(created.body.work_receipt).toMatchObject({ entity_type: 'audio_note', origin_notification_id: o.notificationId });
    expect((await request(fd(w1, `/audio-notes/${created.body.audio_note.id}`), 'GET', A)).status).toBe(200);
    expect((await request(fd(w1, `/audio-notes/${created.body.audio_note.id}/media`), 'GET', A)).status).toBe(200);
  });

  test('without an origin nothing changes: creates mint no receipt and the bot output stays closed to reads', async () => {
    await origin('receipt-none'); // a live notification in ch1, so the legacy create binding allows the create
    const created = await createDoc(A, 'no origin doc');
    expect(created.status).toBe(201);
    expect(created.body.work_receipt).toBeUndefined();
    expect((await request(fd(w1, `/docs/${created.body.doc.id}`), 'GET', A)).status).toBe(403);
    // Humans and unclassified bots are unaffected by the receipt machinery.
    expect((await request(fd(w1, `/docs/${created.body.doc.id}`), 'GET', H)).status).toBe(200);
    expect((await request(fd(w1, `/docs/${created.body.doc.id}`), 'GET', B)).status).toBe(200);
  });

  // ------------------------------------------------------------------------------------------------ review follow-ups
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

  test('doc content identity: a body swapped without a version change is refused; updates return the advanced receipt', async () => {
    const o = await origin('receipt-sha');
    const created = await createDoc(A, 'Sha doc', o.notificationId);
    const docId = created.body.doc.id as string;
    const own = await patchTitle(A, docId, 'Sha doc v2', Number(created.body.doc.row_version));
    expect(own.status).toBe(200);
    expect(own.body.work_receipt.receipt_row_version).toBeGreaterThan(created.body.work_receipt.receipt_row_version);
    expect(own.body.work_receipt.receipt_row_version).toBe(Number(own.body.doc.row_version));
    const swapped = await blob(H, 'SENTINEL-SWAPPED-BODY', 'text/markdown');
    await db`UPDATE flightdeck_pg_storage_links SET storage_object_id = ${swapped} WHERE entity_type = 'doc' AND entity_id = ${docId}`;
    await db`UPDATE flightdeck_pg_docs SET storage_object_id = ${swapped} WHERE id = ${docId}`;
    const read = await request(fd(w1, `/docs/${docId}/body`), 'GET', A);
    expect([read.status, read.body.code]).toEqual([409, 'work_output_changed']);
    expect(read.text).not.toContain('SENTINEL-SWAPPED-BODY');
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

  test('append-only own comments through a receipt; never replies, never reads, never on a changed entity', async () => {
    const o = await origin('receipt-comments');
    const task = await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', A, { title: 'Comment task', origin_notification_id: o.notificationId });
    const human = await request(fd(w1, `/tasks/${task.body.task.id}/comments`), 'POST', H, { body: 'SENTINEL-HUMAN-TASK-COMMENT' });
    expect(human.status).toBe(201);
    const own = await request(fd(w1, `/tasks/${task.body.task.id}/comments`), 'POST', A, { body: 'bot progress note' });
    expect(own.status).toBe(201);
    expect(own.text).not.toContain('SENTINEL-HUMAN-TASK-COMMENT');
    expect((await request(fd(w1, `/tasks/${task.body.task.id}/comments`), 'GET', A)).status).toBe(403);
    const doc = await createDoc(A, 'Comment doc', o.notificationId);
    const docComment = await request(fd(w1, `/docs/${doc.body.doc.id}/comments`), 'POST', A, { body: 'bot doc note' });
    expect(docComment.status).toBe(201);
    const reply = await request(fd(w1, `/docs/${doc.body.doc.id}/comments`), 'POST', A, { body: 'reply', parent_comment_id: docComment.body.comment.id });
    expect(reply.status).toBe(403);
    const v = Number((await db<{ row_version: number }[]>`SELECT row_version FROM flightdeck_pg_tasks WHERE id = ${task.body.task.id}`)[0]!.row_version);
    expect((await request(fd(w1, `/tasks/${task.body.task.id}`), 'PATCH', H, { title: 'changed by human', row_version: v })).status).toBe(200);
    const late = await request(fd(w1, `/tasks/${task.body.task.id}/comments`), 'POST', A, { body: 'too late' });
    expect([late.status, late.body.code]).toEqual([409, 'work_output_changed']);
  });

  test('a receipted task read carries no assignment data added after the receipt', async () => {
    const o = await origin('receipt-assign');
    const task = await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', A, { title: 'Assign task', origin_notification_id: o.notificationId });
    const taskId = task.body.task.id as string;
    await db`INSERT INTO flightdeck_pg_task_assignments (workspace_id, scope_id, channel_id, task_id, actor_id, created_by_actor_id, updated_by_actor_id)
      SELECT workspace_id, scope_id, channel_id, id, ${actors[C]!}, ${actors[H]!}, ${actors[H]!} FROM flightdeck_pg_tasks WHERE id = ${taskId}`;
    const read = await request(fd(w1, `/tasks/${taskId}`), 'GET', A);
    expect(read.status).toBe(200);
    expect(read.text).not.toContain(npubs[C]!);
    expect(read.text).not.toContain(actors[C]!);
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

  test('text-attachment lineage: a classified bot cannot adopt or see a human canonical file; own uploads and human lineage unchanged', async () => {
    const o = await origin('lineage'); // the bot holds a live notification in ch1
    // A human pastes text, and a human lineage file with sentinel metadata becomes the canonical file.
    const pasted = await blob(H, 'pasted original', 'text/plain');
    const body = 'see attached';
    const sent = await request(fd(w1, `/channels/${ch1}/messages`), 'POST', H, {
      body, metadata: { attachments: [{ kind: 'file', storage_object_id: pasted, filename: 'Pasted text.txt', content_type: 'text/plain' }] },
      message_signature: signature(body, H, w1, ch1, undefined, [], 'none'),
    });
    expect(sent.status).toBe(201);
    const lineage = { text_attachment_lineage: { v: 1, origin_message_id: sent.body.message.id, origin_storage_object_id: pasted, origin_filename: 'Pasted text.txt' } };
    const canonical = await request(fd(w1, `/channels/${ch1}/files`), 'POST', H, { display_name: 'SENTINEL-HUMAN-CANONICAL-FILE', storage_object_id: await blob(H, 'human edit', 'text/plain'), metadata: lineage });
    expect(canonical.status).toBe(201);
    // The classified bot's lineage create (own new upload, live channel notification): generic refusal, no metadata.
    const filesBefore = Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_files`)[0]!.n);
    for (const extra of [{}, { origin_notification_id: o.notificationId }]) {
      const adopt = await request(fd(w1, `/channels/${ch1}/files`), 'POST', A, { display_name: 'bot edit', storage_object_id: await blob(A, 'bot edit', 'text/plain'), metadata: lineage, ...extra });
      expect([adopt.status, adopt.body.code]).toEqual([403, 'agent_notification_upgrade_required']);
      expect(adopt.text).not.toContain('SENTINEL-HUMAN-CANONICAL-FILE');
      expect(adopt.text).not.toContain(canonical.body.file.id);
    }
    // Same refusal for a lineage that matches nothing (no existence oracle).
    const nothing = await request(fd(w1, `/channels/${ch1}/files`), 'POST', A, { display_name: 'x', storage_object_id: await blob(A, 'x', 'text/plain'),
      metadata: { text_attachment_lineage: { v: 1, origin_message_id: randomUUID(), origin_storage_object_id: randomUUID(), origin_filename: 'x.txt' } } });
    expect([nothing.status, nothing.body.code]).toEqual([403, 'agent_notification_upgrade_required']);
    expect(Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_files`)[0]!.n)).toBe(filesBefore);
    // The bot's ordinary own upload still works.
    expect((await request(fd(w1, `/channels/${ch1}/files`), 'POST', A, { display_name: 'bot.txt', storage_object_id: await blob(A, 'bot bytes', 'text/plain') })).status).toBe(201);
    // Human lineage behaviour is unchanged: another human is handed the canonical file.
    const human = await request(fd(w1, `/channels/${ch1}/files`), 'POST', C, { display_name: 'c edit', storage_object_id: await blob(C, 'c edit', 'text/plain'), metadata: lineage });
    expect(human.status).toBe(409);
    expect(human.body.file.id).toBe(canonical.body.file.id);
  });

  test('a later unnotified human comment is not observable through a receipt: identical reads, no counters or event sequence', async () => {
    const o = await origin('receipt-activity');
    const task = await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', A, { title: 'Activity task', origin_notification_id: o.notificationId });
    const doc = await createDoc(A, 'Activity doc', o.notificationId);
    const paths = [[`/tasks/${task.body.task.id}`, 'task'], [`/docs/${doc.body.doc.id}`, 'doc'], [`/docs/${doc.body.doc.id}/body`, 'doc']] as const;
    const read = async () => Promise.all(paths.map(async ([path]) => {
      const res = await request(fd(w1, path), 'GET', A);
      expect([path, res.status]).toEqual([path, 200]);
      const { identity: _identity, ...rest } = res.body;
      return rest;
    }));
    const versions = async () => [
      Number((await db`SELECT row_version FROM flightdeck_pg_tasks WHERE id = ${task.body.task.id}`)[0]!.row_version),
      Number((await db`SELECT row_version FROM flightdeck_pg_docs WHERE id = ${doc.body.doc.id}`)[0]!.row_version),
    ];
    const before = await read();
    const versionsBefore = await versions();
    const taskComment = await request(fd(w1, `/tasks/${task.body.task.id}/comments`), 'POST', H, { body: 'human task note' });
    const docComment = await request(fd(w1, `/docs/${doc.body.doc.id}/comments`), 'POST', H, { body: 'human doc note' });
    expect([taskComment.status, docComment.status]).toEqual([201, 201]);
    // The comments leave the parents' row_version unchanged (activity moves independently of it)...
    expect(await versions()).toEqual(versionsBefore);
    // ...and nothing observable through the receipt changed.
    const after = await read();
    expect(after).toEqual(before);
    for (const [i, [, key]] of paths.entries()) {
      expect(Object.keys(after[i]![key])).not.toContain('attention');
      expect(Object.keys(after[i]![key])).not.toContain('activity_version');
    }
    expect(JSON.stringify(after)).not.toContain(taskComment.body.comment.id);
    expect(JSON.stringify(after)).not.toContain(docComment.body.comment.id);
    // Receipted write responses carry no activity counter or workspace event sequence.
    const own = await request(fd(w1, `/tasks/${task.body.task.id}/comments`), 'POST', A, { body: 'bot note' });
    const state = await request(fd(w1, `/tasks/${task.body.task.id}/state`), 'POST', A, { state: 'in_progress' });
    expect([own.status, state.status]).toEqual([201, 200]);
    for (const res of [own, state]) for (const key of ['activity_version', 'outbox', 'view_state_outbox', 'mention_outbox']) expect(Object.keys(res.body)).not.toContain(key);
    expect(Object.keys(state.body.task)).not.toContain('activity_version');
    // Ordinary (human) responses are unchanged.
    expect(Object.keys(taskComment.body)).toEqual(expect.arrayContaining(['outbox', 'activity_version', 'view_state_outbox']));
    const human = await request(fd(w1, `/tasks/${task.body.task.id}`), 'GET', H);
    expect(Object.keys(human.body.task)).toEqual(expect.arrayContaining(['attention', 'activity_version']));
  });

  // ------------------------------------------------------------------------------------------------ idempotent replays
  test('a classified task-create replay returns only its own unchanged receipted version; after a human edit nothing leaks', async () => {
    const o = await origin('replay-task');
    const create = { title: 'Replay task', client_request_id: `replay-${randomUUID()}`, origin_notification_id: o.notificationId };
    const first = await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', A, create);
    expect(first.status).toBe(201);
    const again = await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', A, create);
    expect([again.status, again.body.replayed, again.body.task.id, again.body.work_receipt?.entity_id]).toEqual([200, true, first.body.task.id, first.body.task.id]);
    expect(Object.keys(again.body.task)).not.toContain('attention');
    const v = Number((await db<{ row_version: number }[]>`SELECT row_version FROM flightdeck_pg_tasks WHERE id = ${first.body.task.id}`)[0]!.row_version);
    expect((await request(fd(w1, `/tasks/${first.body.task.id}`), 'PATCH', H, { title: 'SENTINEL-HUMAN-REPLAY-TASK', description: 'SENTINEL-HUMAN-REPLAY-DESC', row_version: v })).status).toBe(200);
    const leaked = await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', A, create);
    expect([leaked.status, leaked.body.code]).toEqual([403, 'agent_notification_upgrade_required']);
    expect(leaked.text).not.toContain('SENTINEL-HUMAN-REPLAY');
    // A replay without any receipt (no origin) never reads the existing task either.
    const plain = { title: 'Plain replay task', client_request_id: `plain-${randomUUID()}` };
    expect((await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', A, plain)).status).toBe(201);
    expect((await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', A, plain)).status).toBe(403);
    // Ordinary (human) replay semantics are unchanged.
    const human = { title: 'Human replay task', client_request_id: `human-${randomUUID()}` };
    expect((await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', H, human)).status).toBe(201);
    const humanAgain = await request(fd(w1, `/channels/${ch1}/tasks`), 'POST', H, human);
    expect([humanAgain.status, humanAgain.body.replayed]).toEqual([200, true]);
  });

  test('a classified message replay returns only its own unedited message and no current thread descriptor', async () => {
    const o = await origin('replay-message');
    const body = 'bot reply with idempotency';
    const send = (requestId: string) => request(fd(w1, `/channels/${ch1}/messages`), 'POST', A, {
      body, thread_id: o.threadId, client_request_id: requestId, message_signature: signature(body, A, w1, ch1, o.threadId, [], 'none'),
    });
    const requestId = `msg-${randomUUID()}`;
    const first = await send(requestId);
    expect(first.status).toBe(201);
    // The human renames the thread: the bot's replay of its unchanged message carries no thread descriptor.
    await db`UPDATE flightdeck_pg_threads SET title = 'SENTINEL-HUMAN-THREAD-TITLE' WHERE id = ${o.threadId}`;
    const again = await send(requestId);
    expect([again.status, again.body.replayed, again.body.message.id]).toEqual([200, true, first.body.message.id]);
    expect(again.text).not.toContain('SENTINEL-HUMAN-THREAD-TITLE');
    // A human edit of the bot's message: the replay no longer returns it.
    await db`UPDATE flightdeck_pg_messages SET body = 'SENTINEL-HUMAN-EDITED-BOT-REPLY', updated_by_actor_id = ${actors[H]!}, row_version = row_version + 1 WHERE id = ${first.body.message.id}`;
    const leaked = await send(requestId);
    expect([leaked.status, leaked.body.code]).toEqual([403, 'agent_notification_upgrade_required']);
    expect(leaked.text).not.toContain('SENTINEL-HUMAN-EDITED-BOT-REPLY');
  });

  test('an agent-activity id collision never echoes another publisher activity to a classified bot', async () => {
    const o = await origin('activity-collision');
    const other = await origin('activity-collision-b'); // another thread; B publishes there
    const forB = await post(ch1, 'B, status please', { threadId: other.threadId, mentions: [B] });
    const activityId = randomUUID();
    const activity = (actor: number, threadId: string, trigger: string, summary: string) => ({
      channel_id: ch1, thread_id: threadId, trigger_message_id: trigger, turn_id: `turn-${actor}`, session_id: `session-${actor}`, agent_npub: npubs[actor],
      state: 'working', visibility: 'user_visible', sequence: 1, summary,
    });
    const b = await request(fd(w1, `/agent-activities/${activityId}`), 'PUT', B, activity(B, other.threadId, forB.body.message.id, 'SENTINEL-OTHER-PUBLISHER-ACTIVITY'));
    expect([200, 201]).toContain(b.status);
    const collide = await request(fd(w1, `/agent-activities/${activityId}`), 'PUT', A, activity(A, o.threadId, o.messageId, 'mine'));
    expect([collide.status, collide.body.code]).toEqual([409, 'agent_activity_turn_identity_mismatch']);
    expect(collide.body.current).toBeUndefined();
    expect(collide.text).not.toContain('SENTINEL-OTHER-PUBLISHER-ACTIVITY');
  });

  // ------------------------------------------------------------------------------------------------ storage adoption
  test('a classified bot links only its own uploads: human orphans, tombstoned attachments, other bots and unknown ids are refused identically', async () => {
    const o = await origin('storage-adoption');
    // Candidate objects the bot did not create.
    const orphan = await blob(H, 'SENTINEL-HUMAN-ORPHAN-BYTES', 'text/plain');
    const formerAttachment = await blob(H, 'SENTINEL-TOMBSTONED-ATTACHMENT-BYTES', 'text/plain');
    const body = 'human attachment';
    const sent = await request(fd(w1, `/channels/${ch1}/messages`), 'POST', H, {
      body, metadata: { attachments: [{ kind: 'file', storage_object_id: formerAttachment, filename: 'a.txt', content_type: 'text/plain' }] },
      message_signature: signature(body, H, w1, ch1, undefined, [], 'none'),
    });
    expect(sent.status).toBe(201);
    await db`UPDATE flightdeck_pg_storage_links SET deleted_at = NOW() WHERE storage_object_id = ${formerAttachment}`;
    await db`UPDATE flightdeck_pg_messages SET deleted_at = NOW() WHERE id = ${sent.body.message.id}`;
    const otherBot = await blob(B, 'SENTINEL-OTHER-BOT-BYTES', 'text/plain');
    const unknown = randomUUID();
    const before = Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_storage_links`)[0]!.n);
    const refusals: string[] = [];
    const expectRefused = (res: { status: number; text: string; body: any }) => {
      expect([res.status, res.body.code]).toEqual([403, 'agent_notification_upgrade_required']);
      expect(res.text).not.toContain('SENTINEL-');
      const { identity: _identity, ...rest } = res.body;
      refusals.push(JSON.stringify(rest));
    };
    for (const candidate of [orphan, formerAttachment, otherBot, unknown]) {
      const withOrigin = { origin_notification_id: o.notificationId };
      expectRefused(await request(fd(w1, `/channels/${ch1}/files`), 'POST', A, { storage_object_id: candidate, display_name: 'x.txt', ...withOrigin }));
      expectRefused(await request(fd(w1, `/channels/${ch1}/docs`), 'POST', A, { title: 'x', storage_object_id: candidate, ...withOrigin }));
      expectRefused(await request(fd(w1, `/channels/${ch1}/audio-notes`), 'POST', A, { storage_object_id: candidate, mime_type: 'audio/webm', ...withOrigin }));
      const reply = 'reply with attachment';
      expectRefused(await request(fd(w1, `/channels/${ch1}/messages`), 'POST', A, {
        body: reply, thread_id: o.threadId, metadata: { attachments: [{ kind: 'file', storage_object_id: candidate, filename: 'x.txt', content_type: 'text/plain' }] },
        message_signature: signature(reply, A, w1, ch1, o.threadId, [], 'none'),
      }));
    }
    // A receipted doc body swap to someone else's object is refused the same way.
    const own = await createDoc(A, 'Own doc', o.notificationId);
    expect(own.status).toBe(201);
    const held = await lease(A, own.body.doc.id);
    expectRefused(await request(fd(w1, `/docs/${own.body.doc.id}`), 'PATCH', A, {
      storage_object_id: orphan, row_version: Number(own.body.doc.row_version), base_body_sha256_hex: own.body.work_receipt.body_sha256_hex, lease_token: held.body.lease.lease_token,
    }));
    // No oracle: every refusal is byte-identical, and nothing was linked.
    expect(new Set(refusals).size).toBe(1);
    expect(Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_storage_links`)[0]!.n)).toBe(before + 1); // only the own doc
    // The bot's own uploads keep working everywhere.
    const ownReply = 'reply with own attachment';
    const ownAttachment = await blob(A, 'bot attachment', 'text/plain');
    expect((await request(fd(w1, `/channels/${ch1}/messages`), 'POST', A, {
      body: ownReply, thread_id: o.threadId, metadata: { attachments: [{ kind: 'file', storage_object_id: ownAttachment, filename: 'b.txt', content_type: 'text/plain' }] },
      message_signature: signature(ownReply, A, w1, ch1, o.threadId, [], 'none'),
    })).status).toBe(201);
    expect((await request(fd(w1, `/channels/${ch1}/files`), 'POST', A, { storage_object_id: await blob(A, 'own file', 'text/plain'), display_name: 'own.txt' })).status).toBe(201);
    // Humans are unchanged: a human may link a human object.
    expect((await request(fd(w1, `/channels/${ch1}/files`), 'POST', H, { storage_object_id: orphan, display_name: 'human.txt' })).status).toBe(201);
  });
});
