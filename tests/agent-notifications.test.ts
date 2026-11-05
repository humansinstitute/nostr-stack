import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { processAgentIntakeBatch } from '../src/services/agent-notification-projector';
import { processIntakeBatch } from '../src/services/notification-projector';
import { databaseCeilingProvider, invalidateCeilingCache, unclassifiedFixtureCeiling } from '../src/services/agent-notifications';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';

// Strict agent notification inbox. Disposable Postgres only:
//   RECORD_TEST_PORT=<free port> bun test tests/agent-notifications.test.ts
const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('strict agent notification inbox against disposable Postgres', () => {
  const database = `agent_notif_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  // 0 human owner H, 1 bot A, 2 bot B, 3 human C, 4 owner of W2
  const secrets = [401, 402, 403, 404, 405].map((n) => new Uint8Array(32).fill(n));
  const npubs = secrets.map((s) => nip19.npubEncode(getPublicKey(s)));
  const [H, A, B, C, H2] = [0, 1, 2, 3, 4];
  const SENTINEL = {
    unrelated: 'SENTINEL-UNRELATED-7f3a', root: 'SENTINEL-THREAD-ROOT-a1a1', removed: 'SENTINEL-REMOVED-MENTION-ee01', mentionA: 'SENTINEL-FOR-A-19bd', prompt: 'SENTINEL-PROMPT-c0de', task: 'SENTINEL-TASK-TITLE-55aa',
    sibling: 'SENTINEL-SIBLING-THREAD-0b0e', otherBot: 'SENTINEL-FOR-B-4242', dm: 'SENTINEL-DM-9911', w2: 'SENTINEL-W2-dd01',
  };
  let db: ReturnType<typeof postgres>;
  let app: ReturnType<typeof createApp>;
  const actors: string[] = [];
  let w1: string, w2: string, scope: string, ch1: string, ch2: string, dm: string, w2scope: string, w2ch: string;
  const allBytes: string[] = []; // every response body seen by bot B (cross-bot leakage audit)

  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  function auth(path: string, method: string, actor: number, data = '', extraTags: string[][] | null = null, nonce: string | null = randomBytes(16).toString('hex')) {
    const tags = extraTags ?? [['u', `http://localhost${path}`], ['method', method], ['payload', sha(data)], ...(nonce ? [['nonce', nonce]] : [])];
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags }, secrets[actor]!);
    return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
  }
  async function call(path: string, method = 'GET', actor = H, body?: unknown, header?: string) {
    const data = body === undefined ? '' : JSON.stringify(body);
    const response = await app.request(path, {
      method, body: body === undefined ? undefined : data,
      headers: { Authorization: header ?? auth(path, method, actor, data), 'Content-Type': 'application/json' },
    });
    const text = await response.text();
    if (actor === B) allBytes.push(text);
    let json: any = {};
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: response.status, body: json, text };
  }
  // Ordinary (non-strict) NIP-98 used by the existing write routes.
  async function legacy(path: string, method = 'GET', actor = H, body?: unknown, record = true) {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const event = finalizeEvent({
      kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
      tags: [['u', `http://localhost${path}`], ['method', method], ...(data ? [['payload', sha(data)]] : [])],
    }, secrets[actor]!);
    const response = await app.request(path, { method, body: data, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'Content-Type': 'application/json' } });
    const text = await response.text();
    if (actor === B && record) allBytes.push(text);
    let json: any = {};
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: response.status, body: json };
  }
  function messageSignature(input: { body: string; actor: number; workspaceId: string; channelId: string; threadId?: string | null }) {
    const tags = [['protocol', 'flightdeck_pg_message_instruction'], ['body_sha256', sha(input.body)], ['workspace_id', input.workspaceId], ['channel_id', input.channelId]];
    if (input.threadId) tags.push(['thread_id', input.threadId]);
    const event = finalizeEvent({ kind: 33358, created_at: Math.floor(Date.now() / 1000), tags, content: input.body }, secrets[input.actor]!);
    return { version: 1, signer_npub: npubs[input.actor], body_sha256: sha(input.body), nostr_event: event };
  }
  function revision(body: string, messageId: string, rev: number, mentions: number[], thread: string | null) {
    const tags = [['protocol', 'flightdeck_pg_message_instruction'], ['body_sha256', sha(body)], ['workspace_id', w1], ['channel_id', ch1], ...(thread ? [['thread_id', thread]] : []), ['message_id', messageId], ['revision', String(rev)]];
    const event = finalizeEvent({ kind: 33358, created_at: Math.floor(Date.now() / 1000), content: body, tags }, secrets[H]!);
    return {
      body, row_version: rev - 1, mentions: mentions.map((i) => ({ type: 'agent', npub: npubs[i], label: `Bot${i}` })),
      message_signature: { version: 1, signer_npub: npubs[H], body_sha256: sha(body), nostr_event: event },
    };
  }
  async function post(channel: string, body: string, opts: { actor?: number; mentions?: number[]; threadId?: string; createThread?: boolean; workspace?: string; metadata?: Record<string, unknown> } = {}) {
    const actor = opts.actor ?? H;
    const workspace = opts.workspace ?? w1;
    const result = await legacy(`/api/v4/flightdeck-pg/workspaces/${workspace}/channels/${channel}/messages`, 'POST', actor, {
      body, ...(opts.threadId ? { thread_id: opts.threadId } : {}), ...(opts.createThread ? { create_thread: true, thread_title: 'Thread' } : {}),
      ...(opts.mentions ? { mentions: opts.mentions.map((i) => ({ type: 'agent', npub: npubs[i], label: `Bot${i}` })) } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      message_signature: messageSignature({ body, actor, workspaceId: workspace, channelId: channel, threadId: opts.threadId }),
    });
    expect(result.status).toBe(201);
    return result.body;
  }
  const drain = async () => { for (let i = 0; i < 30; i++) if ((await processAgentIntakeBatch({ sql: db, limit: 50 })).claimed === 0) return; };
  const base = (w = w1) => `/api/v4/flightdeck-pg/workspaces/${w}/agent-notifications`;
  const subscribe = async (actor: number, consumer = `consumer-${actor}`, w = w1) => call(`${base(w)}/subscriptions`, 'POST', actor, { consumer_id: consumer });
  const page = async (actor: number, cursor: string, w = w1) => call(`${base(w)}?cursor=${encodeURIComponent(cursor)}&limit=100`, 'GET', actor);
  const all = async (actor: number, consumer = `consumer-${actor}`, w = w1) => {
    const sub = await subscribe(actor, consumer, w);
    expect([200, 201]).toContain(sub.status);
    const out = await page(actor, sub.body.cursor, w);
    expect(out.status).toBe(200);
    return { sub: sub.body, ...out.body };
  };
  const grant = (w: string, actor: string, channel: string, permission: string) =>
    db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${actor},'channel',${channel},${permission}) RETURNING id`;

  beforeAll(async () => {
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database, max: 20 });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    for (const [i, kind] of ['human', 'agent', 'agent', 'human', 'human'].entries()) {
      actors.push((await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${npubs[i]!},${kind},${`Actor${i}`}) RETURNING id`)[0]!.id);
    }
    w1 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-an','service-an',${npubs[H]!},'app','W1') RETURNING id`)[0]!.id;
    w2 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-an','service-an2',${npubs[H2]!},'app','W2') RETURNING id`)[0]!.id;
    for (const [i, role] of [[H, 'owner'], [A, 'member'], [B, 'member'], [C, 'member']] as const) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w1},${actors[i]!},${role})`;
    for (const [i, role] of [[H2, 'owner'], [A, 'member']] as const) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w2},${actors[i]!},${role})`;
    scope = (await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w1},'Main','project') RETURNING id`)[0]!.id;
    ch1 = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'General') RETURNING id`)[0]!.id;
    ch2 = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'Sibling') RETURNING id`)[0]!.id;
    dm = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind,participant_npubs) VALUES(${w1},${scope},'dm-h-a','dm',${[npubs[H]!, npubs[A]!]}) RETURNING id`)[0]!.id;
    w2scope = (await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w2},'Main','project') RETURNING id`)[0]!.id;
    w2ch = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w2},${w2scope},'General') RETURNING id`)[0]!.id;
    for (const i of [H, A, B, C]) for (const ch of [ch1, ch2]) for (const p of ['channel.read', 'channel.write', 'task.read', 'task.create', 'task.update', 'task.comment', 'doc.read']) await grant(w1, actors[i]!, ch, p);
    for (const i of [H, A]) for (const p of ['channel.read', 'channel.write']) await grant(w1, actors[i]!, dm, p);
    for (const i of [H2, A]) for (const p of ['channel.read', 'channel.write']) await grant(w2, actors[i]!, w2ch, p);
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${w1},'actor',${actors[H]!},'workspace','workspace.manage')`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${w1},'actor',${actors[H]!},'workspace','event_subscription.manage')`;
    setDb(db); clearWsKeyCacheForTests?.(); invalidateCeilingCache(); app = createApp();
  });
  afterAll(async () => {
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end();
  });

  // --------------------------------------------------------------------------------------------------- derivation
  let mentionMessageId: string, threadId: string, siblingThreadId: string, aNotificationId: string, boundTaskId: string, otherTaskId: string;
  const envelopeKeys = ['author_npub', 'id', 'kind', 'occurred_at', 'origin_notification_id', 'reason', 'seq', 'source', 'state'];
  test('addressed-only: canonical mention reaches only the mentioned bot; plain text and unaddressed traffic reach nobody', async () => {
    await post(ch1, `${SENTINEL.unrelated} general chatter`);
    await post(ch1, `@Bot1 ${SENTINEL.unrelated} plain-text name only`);
    const root = await post(ch1, `Kickoff ${SENTINEL.root}`, { createThread: true });
    threadId = root.thread.id;
    const sibling = await post(ch1, `${SENTINEL.sibling} sibling thread`, { createThread: true });
    siblingThreadId = sibling.thread.id;
    await post(ch1, `${SENTINEL.sibling} more sibling`, { threadId: siblingThreadId });
    const mention = await post(ch1, `@Bot1 please look ${SENTINEL.mentionA}`, { mentions: [A], threadId });
    mentionMessageId = mention.message.id;
    await post(ch2, `${SENTINEL.sibling} sibling channel`, { createThread: true });
    await drain();
    const a = await all(A);
    expect(a.notifications).toHaveLength(1);
    const [n] = a.notifications;
    aNotificationId = n.id;
    expect(n.kind).toBe('chat_mention');
    expect(n.source).toEqual({ type: 'message', id: mentionMessageId, version: 1, channel_id: ch1, thread_id: threadId, task_id: null, doc_id: null });
    expect(Object.keys(n).sort()).toEqual(envelopeKeys); // no bodies, titles, prompts, names, URLs or other recipients
    expect((await all(B)).notifications).toHaveLength(0);
    const h = await subscribe(H);
    expect([200, 201]).toContain(h.status);
  });

  test('human-labelled member can self-restrict and receive bounded work without relabeling; authority boundaries remain', async () => {
    const path = `${base()}/access-profile`;
    expect((await call(path, 'GET', C)).status).toBe(200);
    const unclassified = await subscribe(C, 'human-before-classification');
    expect([200, 201]).toContain(unclassified.status);
    const before = await post(ch1, 'human-labelled member addressed before classification', { mentions: [C], createThread: true });
    await drain();
    const beforePage = await page(C, unclassified.body.cursor);
    expect(beforePage.body.notifications.some((n: any) => n.source?.id === before.message.id)).toBe(true);
    expect((await db`SELECT kind FROM flightdeck_pg_actors WHERE id = ${actors[C]!}`)[0]!.kind).toBe('human');
    expect((await call(path, 'PUT', C, { actor_npub: npubs[A] })).status).toBe(403);
    expect((await call(path, 'PUT', H2, {})).body.code).toBe('workspace_membership_required');
    expect((await call(path, 'PUT', H, { actor_npub: npubs[H2] })).body.code).toBe('actor_not_found');
    expect((await subscribe(C, 'human-member', w2)).body.code).toBe('workspace_membership_required');
    expect((await call(path, 'PUT', C, {})).status).toBe(200);
    try {
      const sub = await subscribe(C, 'human-member');
      expect([200, 201]).toContain(sub.status);
      const message = await post(ch1, 'bounded work for human-labelled identity', { mentions: [C], createThread: true });
      await drain();
      const delivered = await page(C, sub.body.cursor);
      const notification = delivered.body.notifications.find((n: any) => n.source?.id === message.message.id);
      expect(notification).toBeDefined();
      const context = await call(`${base()}/${notification.id}/context`, 'GET', C);
      expect(context.status).toBe(200);
      expect(context.body.trigger.message.body).toBe('bounded work for human-labelled identity');
      expect((await call(`${base()}?cursor=${encodeURIComponent(sub.body.cursor)}`, 'GET', A)).status).toBe(400);
      // Classification is delivery-only: ordinary reads stay authorized by the member's ACL.
      expect((await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/sync`, 'GET', C, undefined, false)).status).toBe(200);
      expect((await call(path, 'DELETE', C)).body.code).toBe('ceiling_lift_forbidden');
      expect((await db`SELECT kind FROM flightdeck_pg_actors WHERE id = ${actors[C]!}`)[0]!.kind).toBe('human');
    } finally {
      expect((await call(`${path}?actor_npub=${npubs[C]}`, 'DELETE', H)).status).toBe(200);
    }
    // Managers can restrict another member regardless of human/agent label, but no new app/service admission.
    expect((await call(path, 'PUT', H, { actor_npub: npubs[C] })).status).toBe(200);
    expect((await call(`${path}?actor_npub=${npubs[C]}`, 'DELETE', H)).status).toBe(200);
    for (const kind of ['app', 'service']) {
      await db`UPDATE flightdeck_pg_actors SET kind = ${kind} WHERE id = ${actors[C]!}`;
      try {
        expect((await subscribe(C, `not-${kind}`)).body.code).toBe('notification_identity_ineligible');
        expect((await call(path, 'PUT', C, {})).body.code).toBe('notification_identity_ineligible');
        expect((await call(path, 'PUT', H, { actor_npub: npubs[C] })).body.code).toBe('notification_identity_ineligible');
      } finally { await db`UPDATE flightdeck_pg_actors SET kind = 'human' WHERE id = ${actors[C]!}`; }
    }
  });

  test('context default = bounded effective transcript of the same thread lineage; sibling threads absent; foreign ids byte-identical 404', async () => {
    const ctx = await call(`${base()}/${aNotificationId}/context`, 'GET', A);
    expect(ctx.status).toBe(200);
    expect(ctx.body.policy.context).toBe('bounded_transcript');
    expect(ctx.body.trigger.message.body).toContain(SENTINEL.mentionA);
    expect(ctx.body.trigger.message.agent_instruction_signature?.nostr_event?.kind).toBe(33358);
    // Effective-transcript compatible shape; metadata reduced to routing/authorization facts; no URLs anywhere.
    expect(ctx.body.trigger.message.created_by_actor_npub).toBe(npubs[H]);
    expect(Object.keys(ctx.body.trigger.message.metadata).sort()).toEqual(['agent_instruction_signature', 'attachments', 'mentions']);
    expect(ctx.text).not.toMatch(/https?:\/\/|content_url|download_url/);
    expect(ctx.body.thread.id).toBe(threadId);
    expect(ctx.body.window.messages.map((m: any) => m.body)).toEqual([`Kickoff ${SENTINEL.root}`]);
    expect(ctx.text).not.toContain(SENTINEL.sibling);
    const other = await call(`${base()}/${aNotificationId}/context`, 'GET', B);
    const random = await call(`${base()}/${randomUUID()}/context`, 'GET', B);
    expect(other.status).toBe(404);
    expect(other.text).toBe(random.text);
  });

  test('trigger_only policy is the stricter opt-in', async () => {
    Bun.env.AGENT_NOTIF_CONTEXT_POLICY = 'trigger_only';
    try {
      const ctx = await call(`${base()}/${aNotificationId}/context`, 'GET', A);
      expect(ctx.body.policy.context).toBe('trigger_only');
      expect(ctx.body.window.messages).toEqual([]);
      expect(ctx.text).not.toContain(SENTINEL.root);
    } finally { delete Bun.env.AGENT_NOTIF_CONTEXT_POLICY; }
  });

  test('inherited branch context: a branch thread transcript includes the parent range up to the branch point only', async () => {
    const branch = await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/channels/${ch1}/threads/${threadId}/branches`, 'POST', H, { branch_point_message_id: mentionMessageId, client_request_id: randomUUID(), title: 'Branch' });
    expect(branch.status).toBe(201);
    const branchThreadId = branch.body.thread.id;
    const msg = await post(ch1, 'continue on branch', { threadId: branchThreadId, metadata: { agent_direct_recipient_npub: npubs[A] } });
    await drain();
    const a = await all(A, 'branch-consumer');
    const n = a.notifications.find((x: any) => x.source.id === msg.message.id);
    expect(n.kind).toBe('agent_direct_recipient');
    const ctx = await call(`${base()}/${n.id}/context`, 'GET', A);
    const bodies = ctx.body.window.messages.map((m: any) => [m.body, m.inherited]);
    expect(bodies).toContainEqual([`Kickoff ${SENTINEL.root}`, true]);
    expect(JSON.stringify(ctx.body)).not.toContain(SENTINEL.sibling);
  });

  test('DMs, explicit Agent Direct recipients (snapshotted in the source transaction), revisions and self-authored messages', async () => {
    await post(dm, `${SENTINEL.dm} hello bot`);
    await post(ch1, 'branch follow-up without mention', { metadata: { agent_direct_recipient_npub: npubs[A] } });
    await post(ch1, `@Bot1 self mention ${SENTINEL.unrelated}`, { actor: A, mentions: [A] });
    const revised = `@Bot1 @Bot2 please look ${SENTINEL.mentionA}`;
    const patch = await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/messages/${mentionMessageId}`, 'PATCH', H, revision(revised, mentionMessageId, 2, [A, B], threadId));
    expect(patch.status).toBe(200);
    await drain();
    const [snap] = await db`SELECT addressing_snapshot FROM flightdeck_pg_agent_notification_intake i JOIN flightdeck_pg_outbox_events o ON o.id = i.outbox_event_id
      WHERE o.event_type = 'flightdeck_pg.message.created' AND o.payload->>'channel_id' = ${dm}`;
    expect(snap!.addressing_snapshot.channel_kind).toBe('dm');
    const a = await all(A);
    expect(a.notifications.map((n: any) => n.kind)).toEqual(expect.arrayContaining(['chat_mention', 'direct_message', 'agent_direct_recipient']));
    const b = await all(B);
    expect(b.notifications.map((n: any) => [n.kind, n.source.id])).toEqual([['chat_mention', mentionMessageId]]);
    // Human event envelopes are unchanged: no strict-inbox addressing fields leak into /events payloads.
    const events = await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/events`, 'GET', H);
    expect(JSON.stringify(events.body.events.map((e: any) => e.payload))).not.toContain('agent_direct_recipient_npub');
  });

  test('DM context carries exact current participants and refuses foreign or removed recipients', async () => {
    const dmNotifications = (await all(A)).notifications.filter((n: any) => n.kind === 'direct_message' && n.source.channel_id === dm);
    expect(dmNotifications.length).toBeGreaterThan(0);
    const notification = dmNotifications[0];
    const context = await call(`${base()}/${notification.id}/context`, 'GET', A);
    expect(context.status).toBe(200);
    expect(context.body.channel.participant_npubs).toEqual([npubs[H], npubs[A]]);
    expect(context.body.channel.kind).toBe('dm');
    expect(context.body.trigger.message.mentions).toEqual([]);
    expect(context.body.trigger.message.agent_instruction_signature.nostr_event.pubkey).toBe(getPublicKey(secrets[H]!));
    expect((await call(`${base()}/${notification.id}/context`, 'GET', B)).status).toBe(404);
    await db`UPDATE flightdeck_pg_channels SET participant_npubs = ${[npubs[H]!, npubs[B]!]} WHERE id = ${dm}`;
    try {
      const removed = await call(`${base()}/${notification.id}/context`, 'GET', A);
      expect([removed.status, removed.body.code]).toEqual([403, 'relationship_removed']);
      expect(removed.text).not.toContain(SENTINEL.dm);
    } finally {
      await db`UPDATE flightdeck_pg_channels SET participant_npubs = ${[npubs[H]!, npubs[A]!]} WHERE id = ${dm}`;
    }
  });

  test('tasks and invocations: assignment, comment mentions, prompt never in the envelope', async () => {
    const task = await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/channels/${ch1}/tasks`, 'POST', H, { title: SENTINEL.task });
    expect(task.status).toBe(201);
    boundTaskId = task.body.task.id;
    otherTaskId = (await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/channels/${ch1}/tasks`, 'POST', H, { title: `${SENTINEL.unrelated} other task` })).body.task.id;
    expect((await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/tasks/${boundTaskId}/assignments`, 'POST', H, { actor_id: actors[A] })).status).toBeLessThan(300);
    const comment = await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/tasks/${boundTaskId}/comments`, 'POST', H, {
      body: '@Bot2 can you review', mentions: [{ type: 'agent', npub: npubs[B], label: 'Bot2' }],
    });
    expect(comment.status).toBe(201);
    const inv = await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/invocations`, 'POST', H, {
      scope_id: scope, channel_id: ch1, prompt: SENTINEL.prompt, recipients: [{ type: 'agent', npub: npubs[A] }], targets: [{ type: 'task', id: boundTaskId }],
    });
    expect(inv.status).toBe(201);
    await drain();
    const a = await all(A);
    const kinds = a.notifications.map((n: any) => n.kind);
    expect(kinds.filter((k: string) => k === 'task_assigned')).toHaveLength(1);
    expect(kinds).toContain('invocation');
    expect(JSON.stringify(a)).not.toContain(SENTINEL.prompt);
    expect(JSON.stringify(a)).not.toContain(SENTINEL.task);
    const invocation = a.notifications.find((n: any) => n.kind === 'invocation');
    const ctx = await call(`${base()}/${invocation.id}/context`, 'GET', A);
    expect(ctx.body.trigger.invocation.prompt).toBe(SENTINEL.prompt);
    expect(ctx.body.trigger.task.title).toBe(SENTINEL.task);
    expect((await all(B)).notifications.map((n: any) => n.kind)).toEqual(['chat_mention', 'task_comment_mention']);
  });

  test('canonical relationship revalidation: removed mention, reassigned task and closed invocation become minimal tombstones', async () => {
    const msg = await post(ch1, `@Bot1 ${SENTINEL.removed}`, { mentions: [A], threadId });
    await drain();
    const before = await all(A, 'relation-consumer');
    const mentionRow = before.notifications.find((n: any) => n.source.id === msg.message.id);
    expect(mentionRow.state).toBe('active');
    // Revision removes A's mention: the old inbox id must not hydrate the new content.
    const withoutA = `edited ${SENTINEL.removed}`;
    expect((await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/messages/${msg.message.id}`, 'PATCH', H, revision(withoutA, msg.message.id, 2, [], threadId))).status).toBe(200);
    // Task unassigned from A; invocation closed.
    expect((await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/tasks/${boundTaskId}/assignments/${actors[A]}`, 'DELETE', H)).status).toBeLessThan(300);
    await db`UPDATE flightdeck_pg_invocations SET status = 'closed', closed_at = NOW() WHERE workspace_id = ${w1}`;
    const after = await page(A, before.sub.cursor);
    const byId = new Map(after.body.notifications.map((n: any) => [n.id, n]));
    for (const kind of ['chat_mention', 'task_assigned', 'invocation']) {
      const original = before.notifications.find((n: any) => (kind === 'chat_mention' ? n.source.id === msg.message.id : n.kind === kind));
      const now: any = byId.get(original.id);
      expect([kind, now]).toEqual([kind, { id: original.id, seq: original.seq, state: 'revoked' }]); // no routing metadata
      const ctx = await call(`${base()}/${original.id}/context`, 'GET', A);
      expect([kind, ctx.status, ctx.body.code]).toEqual([kind, 403, 'relationship_removed']);
      expect(ctx.text).not.toContain(SENTINEL.removed);
    }
  });

  // --------------------------------------------------------------------------------------------------- auth
  test('strict exact-request NIP-98: replay, nonce, payload on bodies, query token, tampered URL, cross-recipient cursor', async () => {
    const sub = await subscribe(A);
    const path = `${base()}?cursor=${encodeURIComponent(sub.body.cursor)}`;
    const header = auth(path, 'GET', A);
    expect((await call(path, 'GET', A, undefined, header)).status).toBe(200);
    const replay = await call(path, 'GET', A, undefined, header);
    expect([replay.status, replay.body.code]).toEqual([401, 'nip98_replayed']);
    expect((await call(path, 'GET', A, undefined, auth(path, 'GET', A, '', null, null))).body.code).toBe('nip98_nonce_required');
    // Bodyless GET may omit payload (broker-compatible); a wrong payload is still rejected.
    expect((await call(path, 'GET', A, undefined, auth(path, 'GET', A, '', [['u', `http://localhost${path}`], ['method', 'GET'], ['nonce', randomBytes(16).toString('hex')]]))).status).toBe(200);
    expect((await call(path, 'GET', A, undefined, auth(path, 'GET', A, '', [['u', `http://localhost${path}`], ['method', 'GET'], ['payload', sha('x')], ['nonce', randomBytes(16).toString('hex')]]))).body.code).toBe('nip98_payload_mismatch');
    const subPath = `${base()}/subscriptions`;
    const unbound = await call(subPath, 'POST', A, { consumer_id: 'x' }, auth(subPath, 'POST', A, '', [['u', `http://localhost${subPath}`], ['method', 'POST'], ['nonce', randomBytes(16).toString('hex')]]));
    expect(unbound.status).toBe(401); // refused by the hosted write boundary and by strict auth
    expect((await call(`${path}&limit=5`, 'GET', A, undefined, auth(path, 'GET', A))).body.code).toBe('nip98_url_mismatch');
    expect((await call(`${path}&token=abc`, 'GET', A)).body.code).toBe('nip98_header_required');
    const bSub = await subscribe(B);
    expect((await page(A, bSub.body.cursor)).body.code).toBe('invalid_cursor');
    const [id, token] = String(sub.body.cursor).split('~');
    const forged = `${id}~${Buffer.from(JSON.stringify({ v: 1, s: 0 })).toString('base64url')}.${token!.split('.')[1]}`;
    expect((await page(A, forged)).body.code).toBe('invalid_cursor');
    expect((await page(A, sub.body.cursor, w2)).body.code).toBe('invalid_cursor');
  });

  // --------------------------------------------------------------------------------------------------- floor
  test('fixed 24h floor on every selection; scanned old rows still advance the cursor; no cursor-zero replay', async () => {
    await post(ch1, '@Bot1 old work', { mentions: [A] });
    await post(ch1, '@Bot1 recent work', { mentions: [A] });
    await drain();
    const [oldRow] = await db`SELECT id FROM flightdeck_pg_agent_notifications WHERE recipient_actor_id = ${actors[A]!} ORDER BY seq DESC OFFSET 1 LIMIT 1`;
    await db`UPDATE flightdeck_pg_agent_notifications SET source_created_at = NOW() - INTERVAL '25 hours' WHERE id = ${oldRow!.id}`;
    const fresh = await all(A, 'fresh-consumer');
    expect(fresh.notifications.map((n: any) => n.id)).not.toContain(oldRow!.id);
    expect(fresh.has_more).toBe(false);
    const again = await subscribe(A, 'fresh-consumer');
    expect(again.status).toBe(200);
    expect(again.body.subscription.floor_at).toBe(fresh.sub.subscription.floor_at);
    expect((await page(A, again.body.cursor)).body.notifications.map((n: any) => n.id)).not.toContain(oldRow!.id);
    await db`UPDATE flightdeck_pg_agent_notifications SET source_created_at = NOW() - INTERVAL '30 days' WHERE id = ${oldRow!.id}`;
    expect((await call(`${base()}/${oldRow!.id}/context`, 'GET', A)).status).toBe(404);
  });

  test('late source commit: intake is claimed regardless of outbox row_version commit order', async () => {
    const reserved = await db.reserve();
    await reserved`BEGIN`;
    const [late] = await reserved`INSERT INTO flightdeck_pg_outbox_events (workspace_id, scope_id, channel_id, actor_id, event_type, entity_type, entity_id, operation, entity_row_version, payload)
      VALUES (${w1}, ${scope}, ${ch1}, ${actors[H]!}, 'flightdeck_pg.invocation.created', 'invocation', ${randomUUID()}, 'created', 1, '{}'::jsonb) RETURNING id`;
    await post(ch1, '@Bot1 committed first', { mentions: [A] });
    await drain();
    expect((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_agent_notification_intake WHERE outbox_event_id = ${late!.id}`)[0]!.n).toBe(0);
    await reserved`COMMIT`;
    reserved.release();
    expect((await db`SELECT state FROM flightdeck_pg_agent_notification_intake WHERE outbox_event_id = ${late!.id}`)[0]!.state).toBe('pending');
    await drain();
    const [done] = await db`SELECT state, outcome FROM flightdeck_pg_agent_notification_intake WHERE outbox_event_id = ${late!.id}`;
    expect([done!.state, done!.outcome]).toEqual(['done', 'source_deleted']);
  });

  test('per-recipient sequence is commit ordered: a second projector blocks on the counter lock', async () => {
    const first = await db.reserve();
    await first`BEGIN`;
    await first`SELECT flightdeck_pg_agent_notification_next_seq(${w1}::uuid, ${actors[B]!}::uuid)`;
    const second = db.begin(async (tx) => (await tx`SELECT flightdeck_pg_agent_notification_next_seq(${w1}::uuid, ${actors[B]!}::uuid) AS s`)[0]!.s);
    let settled = false;
    void second.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    const [mine] = await first`SELECT last_seq FROM flightdeck_pg_agent_notification_counters WHERE workspace_id = ${w1} AND recipient_actor_id = ${actors[B]!}`;
    await first`COMMIT`;
    first.release();
    expect(Number(await second)).toBe(Number(mine!.last_seq) + 1);
  });

  // --------------------------------------------------------------------------------------------------- ack / recovery
  test('ack: idempotent, contiguous position, recovery resumes at the ack boundary; source_gone needs Tower confirmation', async () => {
    const start = await all(A, 'ack-consumer');
    const subscriptionId = start.sub.subscription.id;
    const [first, second] = start.notifications.filter((n: any) => n.state === 'active');
    expect((await call(`${base()}/${first.id}/ack`, 'POST', A, { subscription_id: subscriptionId, outcome: 'source_gone' })).body.code).toBe('source_present');
    const seqs = start.notifications.map((n: any) => n.seq);
    for (const n of start.notifications) if (n.id !== first.id) await call(`${base()}/${n.id}/ack`, 'POST', A, { subscription_id: subscriptionId, outcome: n.state === 'active' ? 'handled' : 'suppressed' });
    const ack1 = await call(`${base()}/${first.id}/ack`, 'POST', A, { subscription_id: subscriptionId, outcome: 'handled' });
    expect(ack1.body.acked_through_seq).toBe(Math.max(...seqs));
    const replay = await call(`${base()}/${first.id}/ack`, 'POST', A, { subscription_id: subscriptionId, outcome: 'suppressed' });
    expect([replay.body.outcome, replay.body.replayed]).toEqual(['handled', true]);
    const bSub = await subscribe(B);
    expect((await call(`${base()}/${second.id}/ack`, 'POST', B, { subscription_id: bSub.body.subscription.id, outcome: 'handled' })).status).toBe(404);
    const recovered = await subscribe(A, 'ack-consumer');
    const rest = await page(A, recovered.body.cursor);
    expect(rest.body.notifications).toEqual([]);
  });

  test('deleted/moved sources: tombstone + context 410 source_gone, ack source_gone accepted (audited), deleted thread stays deleted', async () => {
    const msg = await post(ch1, '@Bot1 to be deleted', { mentions: [A] });
    await drain();
    const start = await all(A, 'gone-consumer');
    const target = start.notifications.find((n: any) => n.source?.id === msg.message.id);
    expect((await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/messages/${msg.message.id}`, 'DELETE', H)).status).toBe(200);
    const ctx = await call(`${base()}/${target.id}/context`, 'GET', A);
    expect([ctx.status, ctx.body.code]).toEqual([410, 'source_gone']);
    expect((await call(`${base()}/${target.id}/ack`, 'POST', A, { subscription_id: start.sub.subscription.id, outcome: 'source_gone', code: 'message_deleted' })).status).toBe(200);
    expect((await db`SELECT 1 FROM flightdeck_pg_agent_notification_audit WHERE action = 'ack.source_gone'`).length).toBe(1);
    await db`UPDATE flightdeck_pg_threads SET deleted_at = NOW() WHERE id = ${siblingThreadId}`;
    const inSibling = await post(ch1, 'placeholder', { createThread: true });
    void inSibling;
    const threaded = await call(`${base()}/${aNotificationId}/context`, 'GET', A);
    expect(threaded.status).toBe(200); // a different (sibling) thread's deletion does not affect this notification
    await db`UPDATE flightdeck_pg_threads SET deleted_at = NOW() WHERE id = ${threadId}`;
    expect((await call(`${base()}/${aNotificationId}/context`, 'GET', A)).body.code).toBe('source_gone');
    const [still] = await db`SELECT deleted_at FROM flightdeck_pg_threads WHERE id = ${threadId}`;
    expect(still!.deleted_at).toBeTruthy(); // never resurrected by the inbox
    await db`UPDATE flightdeck_pg_threads SET deleted_at = NULL WHERE id IN (${threadId}, ${siblingThreadId})`;
  });

  // --------------------------------------------------------------------------------------------------- revocation
  test('revocation: lost channel ACL => minimal tombstone and 403 context; removed membership => 403', async () => {
    const grants = await db`SELECT id FROM flightdeck_pg_permission_grants WHERE principal_actor_id = ${actors[A]!} AND resource_channel_id = ${ch1} AND permission = 'channel.read'`;
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at = NOW() WHERE id = ANY(${grants.map((g) => g.id)}::uuid[])`;
    const listed = await all(A, 'revoked-consumer');
    const live = listed.notifications.filter((n: any) => n.state === 'active');
    expect(live.every((n: any) => n.source.channel_id !== ch1)).toBe(true);
    const revoked = listed.notifications.filter((n: any) => n.state === 'revoked');
    expect(revoked.length).toBeGreaterThan(0);
    for (const n of revoked) expect(Object.keys(n).sort()).toEqual(['id', 'seq', 'state']);
    const ctx = await call(`${base()}/${revoked[0].id}/context`, 'GET', A);
    expect([ctx.status, ctx.body.code]).toEqual([403, 'access_revoked']);
    const before = Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_agent_notifications WHERE recipient_actor_id = ${actors[A]!}`)[0]!.n);
    await post(ch1, '@Bot1 while revoked', { mentions: [B] });
    await drain();
    expect(Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_agent_notifications WHERE recipient_actor_id = ${actors[A]!}`)[0]!.n)).toBe(before);
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at = NULL WHERE id = ANY(${grants.map((g) => g.id)}::uuid[])`;
  });

  test('revocation linearization: a read blocks behind an uncommitted grant revocation, then observes it (no stale snapshot)', async () => {
    const sub = await subscribe(A, 'linearize-consumer');
    const grants = await db`SELECT id FROM flightdeck_pg_permission_grants WHERE principal_actor_id = ${actors[A]!} AND resource_channel_id = ${ch1} AND permission = 'channel.read'`;
    const revoker = await db.reserve();
    await revoker`BEGIN`;
    await revoker`UPDATE flightdeck_pg_permission_grants SET revoked_at = NOW() WHERE id = ANY(${grants.map((g) => g.id)}::uuid[])`;
    let settled = false;
    const read = page(A, sub.body.cursor).then((r) => { settled = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false); // FOR SHARE on the live grant blocks until the revocation commits
    await revoker`COMMIT`;
    revoker.release();
    const result = await read;
    expect(result.status).toBe(200);
    expect(result.body.notifications.filter((n: any) => n.state === 'active' && n.source.channel_id === ch1)).toEqual([]);
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at = NULL WHERE id = ANY(${grants.map((g) => g.id)}::uuid[])`;
  });

  // --------------------------------------------------------------------------------------------------- tenancy
  test('two workspaces: W2 notifications and W1 notifications never cross', async () => {
    await post(w2ch, `@Bot1 ${SENTINEL.w2}`, { actor: H2, mentions: [A], workspace: w2 });
    await drain();
    const inW2 = await all(A, 'w2-consumer', w2);
    expect(inW2.notifications).toHaveLength(1);
    expect(inW2.notifications[0].source.channel_id).toBe(w2ch);
    expect(JSON.stringify(await all(A, 'w1-only'))).not.toContain(w2ch);
    expect((await call(`${base()}/${inW2.notifications[0].id}/context`, 'GET', A)).status).toBe(404);
  });

  // --------------------------------------------------------------------------------------------------- SSE parity
  test('SSE stream uses the same filtering and envelope as polling and rejects query tokens', async () => {
    const sub = await subscribe(B, 'sse-consumer');
    const path = `${base()}/stream?cursor=${encodeURIComponent(sub.body.cursor)}`;
    Bun.env.AGENT_NOTIF_STREAM_MAX_SECONDS = '1';
    try {
      const response = await app.request(path, { headers: { Authorization: auth(path, 'GET', B) } });
      expect(response.status).toBe(200);
      const text = await response.text();
      allBytes.push(text);
      expect(text).toContain('event: ready');
      expect(text).toContain('event: page');
      expect(text).toContain('event: session_expired');
      const pageFrame = text.split('\n\n').find((frame) => frame.includes('event: page'))!;
      const data = JSON.parse(pageFrame.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
      expect(data.notifications).toEqual((await page(B, sub.body.cursor)).body.notifications);
    } finally { delete Bun.env.AGENT_NOTIF_STREAM_MAX_SECONDS; }
    expect((await app.request(`${path}&token=${encodeURIComponent(auth(path, 'GET', B).slice(6))}`)).status).toBe(401);
  });

  // --------------------------------------------------------------------------------------------------- legacy onboarding
  test('legacy audience reconciliation: existing manager reconnect (unchanged/subset) needs no new consent; additions and new managers do; classified stays blocked', async () => {
    const path = `/api/v4/flightdeck-pg/workspaces/${w1}/event-subscription-agents`;
    // Pre-existing grant for manager H covering A and B (as created before this Tower version).
    await db`DELETE FROM flightdeck_pg_event_subscription_agents WHERE workspace_id = ${w1}`;
    for (const i of [A, B]) {
      await db`INSERT INTO flightdeck_pg_event_subscription_agents (workspace_id, manager_actor_id, agent_actor_id, authorized_by_actor_id) VALUES (${w1}, ${actors[H]!}, ${actors[i]!}, ${actors[H]!})`;
    }
    // Old Autopilot reconnect: same manager, same workspace, unchanged audience, no consent field => preserved.
    const unchanged = await legacy(path, 'PUT', H, { agent_npubs: [npubs[A], npubs[B]] });
    expect([unchanged.status, unchanged.body.audience_npubs, unchanged.body.rejected_audience]).toEqual([200, [npubs[A], npubs[B]].sort(), []]);
    // Repeated reconnects stay idempotent.
    expect((await legacy(path, 'PUT', H, { agent_npubs: [npubs[A], npubs[B]] })).body.audience_npubs).toEqual([npubs[A], npubs[B]].sort());
    // /events with the reconciled audience still works for the manager.
    expect((await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/events?audience_npub=${encodeURIComponent(npubs[A]!)}`, 'GET', H)).status).toBe(200);
    // Subset: kept without consent (the omitted one is dropped; re-adding it is an addition).
    const subset = await legacy(path, 'PUT', H, { agent_npubs: [npubs[A]] });
    expect([subset.body.audience_npubs, subset.body.rejected_audience]).toEqual([[npubs[A]], []]);
    const readd = await legacy(path, 'PUT', H, { agent_npubs: [npubs[A], npubs[B]] });
    expect([readd.body.audience_npubs, readd.body.rejected_audience]).toEqual([[npubs[A]], [{ npub: npubs[B], code: 'legacy_consent_required' }]]);
    // Addition with explicit consent in the payload-signed request.
    expect((await legacy(path, 'PUT', H, { agent_npubs: [npubs[A], npubs[B]], legacy_broad_feed_consent: true })).body.audience_npubs).toEqual([npubs[A], npubs[B]].sort());
    // A different manager in the same workspace has no existing grant: everything is an addition.
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${w1},'actor',${actors[C]!},'workspace','event_subscription.manage')`;
    const otherManager = await legacy(path, 'PUT', C, { agent_npubs: [npubs[A]] });
    expect([otherManager.status, otherManager.body.audience_npubs, otherManager.body.rejected_audience]).toEqual([200, [], [{ npub: npubs[A], code: 'legacy_consent_required' }]]);
    // H's grants are untouched by C's reconciliation.
    expect((await legacy(path, 'GET', H)).body.audience_npubs).toEqual([npubs[A], npubs[B]].sort());
    // Classified recipients are always rejected, even when previously registered and even with consent.
    await db`INSERT INTO flightdeck_pg_agent_access_profiles (workspace_id, actor_id, profile) VALUES (${w1}, ${actors[B]!}, 'notification_only')`;
    expect((await legacy(path, 'GET', H)).body.audience_npubs).toEqual([npubs[A]]);
    const classified = await legacy(path, 'PUT', H, { agent_npubs: [npubs[A], npubs[B]], legacy_broad_feed_consent: true });
    expect([classified.body.audience_npubs, classified.body.rejected_audience]).toEqual([[npubs[A]], [{ npub: npubs[B], code: 'notification_only_agent' }]]);
    const events = await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/events?audience_npub=${encodeURIComponent(npubs[B]!)}`, 'GET', H);
    expect(events.body.rejected_audience_npubs).toEqual([npubs[B]]);
    await db`DELETE FROM flightdeck_pg_agent_access_profiles WHERE actor_id = ${actors[B]!} AND workspace_id = ${w1}`;
    await db`DELETE FROM flightdeck_pg_permission_grants WHERE principal_actor_id = ${actors[C]!} AND permission = 'event_subscription.manage'`;
    await db`DELETE FROM flightdeck_pg_event_subscription_agents WHERE workspace_id = ${w1}`;
    // Restore the state later tests expect (A registered for H via consent).
    expect((await legacy(path, 'PUT', H, { agent_npubs: [npubs[A]], legacy_broad_feed_consent: true })).body.audience_npubs).toEqual([npubs[A]]);
  });

  test('a W1 classification never affects W2: W2 legacy audience (existing + consented) and W2 human inbox stay intact; W1 rejects', async () => {
    const w2path = `/api/v4/flightdeck-pg/workspaces/${w2}/event-subscription-agents`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${w2},'actor',${actors[H2]!},'workspace','event_subscription.manage')`;
    await db`INSERT INTO flightdeck_pg_event_subscription_agents (workspace_id, manager_actor_id, agent_actor_id, authorized_by_actor_id) VALUES (${w2}, ${actors[H2]!}, ${actors[A]!}, ${actors[H2]!})`;
    await db`INSERT INTO flightdeck_pg_agent_access_profiles (workspace_id, actor_id, profile) VALUES (${w1}, ${actors[A]!}, 'notification_only')`;
    try {
      // W2: the existing registration survives the reconnect, the list keeps it, and /events still serves it.
      expect((await legacy(w2path, 'GET', H2)).body.audience_npubs).toEqual([npubs[A]]);
      expect((await legacy(w2path, 'PUT', H2, { agent_npubs: [npubs[A]] })).body.audience_npubs).toEqual([npubs[A]]);
      const w2events = await legacy(`/api/v4/flightdeck-pg/workspaces/${w2}/events?audience_npub=${encodeURIComponent(npubs[A]!)}`, 'GET', H2);
      expect([w2events.status, w2events.body.rejected_audience_npubs]).toEqual([200, []]);
      // W2: a fresh consented registration also works.
      await db`DELETE FROM flightdeck_pg_event_subscription_agents WHERE workspace_id = ${w2}`;
      expect((await legacy(w2path, 'PUT', H2, { agent_npubs: [npubs[A]], legacy_broad_feed_consent: true })).body.audience_npubs).toEqual([npubs[A]]);
      // W1: rejected even with consent.
      const w1put = await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/event-subscription-agents`, 'PUT', H, { agent_npubs: [npubs[A]], legacy_broad_feed_consent: true });
      expect(w1put.body.rejected_audience).toEqual([{ npub: npubs[A], code: 'notification_only_agent' }]);
      // W2 human inbox projection still includes A (classified only in W1).
      const before = Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_notification_items WHERE recipient_actor_id = ${actors[A]!} AND workspace_id = ${w2}`)[0]!.n);
      await post(w2ch, 'w2 human chatter', { actor: H2, workspace: w2, createThread: true });
      for (let i = 0; i < 20; i++) if ((await processIntakeBatch({ sql: db, limit: 50 })).claimed === 0) break;
      expect(Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_notification_items WHERE recipient_actor_id = ${actors[A]!} AND workspace_id = ${w2}`)[0]!.n)).toBeGreaterThan(before);
    } finally {
      await db`DELETE FROM flightdeck_pg_agent_access_profiles WHERE workspace_id = ${w1} AND actor_id = ${actors[A]!}`;
      await db`DELETE FROM flightdeck_pg_event_subscription_agents WHERE workspace_id = ${w2}`;
    }
  });

  // --------------------------------------------------------------------------------------------------- ceiling
  test('classification is per workspace and delivery-only: W1 drops the legacy audience; API access stays ACL-authorized everywhere; no global scope', async () => {
    const w1path = `${base()}/access-profile`;
    expect((await call(w1path, 'PUT', H, { actor_npub: npubs[A], scope: 'global' })).body.code).toBe('validation_error');
    expect((await call(w1path, 'PUT', H, { actor_npub: npubs[A] })).status).toBe(200);
    invalidateCeilingCache();
    expect((await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/sync`, 'GET', A, undefined, false)).status).toBe(200);
    expect((await legacy(`/api/v4/flightdeck-pg/workspaces/${w2}/channels/${w2ch}/messages`, 'GET', A, undefined, false)).status).toBe(200);
    expect((await legacy('/api/v4/flightdeck-pg/workspaces', 'GET', A, undefined, false)).status).toBe(200);
    // Classified A was removed from the legacy audience it had in W1.
    expect((await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/event-subscription-agents`, 'GET', H)).body.audience_npubs).toEqual([]);
    expect((await call(`${w1path}?actor_npub=${npubs[A]}`, 'DELETE', A)).body.code).toBe('ceiling_lift_forbidden');
    expect((await call(`${w1path}?actor_npub=${npubs[A]}`, 'DELETE', H)).status).toBe(200);
    invalidateCeilingCache();
    expect((await legacy(`/api/v4/flightdeck-pg/workspaces/${w1}/channels/${ch1}/messages?thread_id=${threadId}`, 'GET', A, undefined, false)).status).toBe(200);
  });

  test('the classification provider is never on the request path: an unavailable provider refuses nothing the ACL authorizes', async () => {
    const path = `/api/v4/flightdeck-pg/workspaces/${w1}/channels/${ch1}/messages?thread_id=${threadId}`;
    const request = (target: ReturnType<typeof createApp>, actor: number) => {
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', `http://localhost${path}`], ['method', 'GET']] }, secrets[actor]!);
      return target.request(path, { headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` } });
    };
    const failing = createApp({ agentCeiling: { profileFor: async () => { throw new Error('db down'); } } });
    for (const actor of [H, B]) expect([actor, (await request(failing, actor)).status]).toEqual([actor, 200]);
    expect((await request(createApp({ agentCeiling: unclassifiedFixtureCeiling }), H)).status).toBe(200);
    // Still ACL-checked: a non-member is refused regardless of classification state.
    expect((await request(failing, H2)).status).toBe(403);
  });

  test('a classified bot reads and writes outside its notifications by its ACL; ungranted, DM and cross-workspace stay refused', async () => {
    expect((await call(`${base()}/access-profile`, 'PUT', B, {})).status).toBe(200);
    invalidateCeilingCache();
    // ACL reads and writes are not inbox delivery: excluded from the inbox leakage audit below.
    const write = async (path: string, body: Record<string, unknown>) => legacy(path, 'POST', B, body, false);
    const read = async (path: string) => legacy(path, 'GET', B, undefined, false);
    const msgPath = `/api/v4/flightdeck-pg/workspaces/${w1}/channels/${ch1}/messages`;
    const reply = (channel: string, thread: string | null, text: string) => ({ body: text, ...(thread ? { thread_id: thread } : {}), message_signature: messageSignature({ body: text, actor: B, workspaceId: w1, channelId: channel, threadId: thread }) });
    expect((await write(msgPath, reply(ch1, siblingThreadId, 'B into sibling'))).status).toBe(201);
    expect((await write(`/api/v4/flightdeck-pg/workspaces/${w1}/channels/${ch2}/messages`, reply(ch2, null, 'B top level elsewhere'))).status).toBe(201);
    expect((await write(`/api/v4/flightdeck-pg/workspaces/${w1}/tasks/${otherTaskId}/comments`, { body: 'B on other task' })).status).toBe(201);
    expect((await write(`/api/v4/flightdeck-pg/workspaces/${w1}/channels/${ch2}/tasks`, { title: 'B elsewhere' })).status).toBe(201);
    for (const path of [`/api/v4/flightdeck-pg/workspaces/${w1}/sync`, `/api/v4/flightdeck-pg/workspaces/${w1}/events`,
      `/api/v4/flightdeck-pg/workspaces/${w1}/tasks/${otherTaskId}`, `${msgPath}?thread_id=${siblingThreadId}`, '/api/v4/flightdeck-pg/workspaces']) {
      expect([path, (await read(path)).status]).toEqual([path, 200]);
    }
    // ACL refusals are unchanged: the H/A DM, W2 (not a member), a nonexistent task, another creator's storage object.
    expect((await read(`/api/v4/flightdeck-pg/workspaces/${w1}/me`)).status).toBe(403); // no workspace.read grant
    const dmRead = await read(`/api/v4/flightdeck-pg/workspaces/${w1}/channels/${dm}/messages`);
    expect(dmRead.status).toBe(403);
    expect(JSON.stringify(dmRead.body)).not.toContain(SENTINEL.dm);
    expect((await read(`/api/v4/flightdeck-pg/workspaces/${w2}/channels/${w2ch}/messages`)).status).toBe(403);
    expect((await write(`/api/v4/flightdeck-pg/workspaces/${w2}/channels/${w2ch}/tasks`, { title: 'cross workspace' })).status).toBe(403);
    expect((await write(`/api/v4/flightdeck-pg/workspaces/${w1}/tasks/${randomUUID()}/comments`, { body: 'ghost' })).status).toBe(404);
    const [foreign] = await db`INSERT INTO v4_storage_objects (owner_npub, created_by_npub, content_type, storage_path) VALUES (${npubs[H]!}, ${npubs[H]!}, 'text/plain', 'x/foreign') RETURNING id`;
    expect((await legacy(`/api/v4/storage/${foreign!.id}/complete`, 'POST', B, {}, false)).status).toBe(404); // storage ACL: no oracle
    // The bot still cannot lift its own classification.
    expect((await call(`${base()}/access-profile?actor_npub=${npubs[B]}`, 'DELETE', B)).body.code).toBe('ceiling_lift_forbidden');
  });

  test('classified bots are excluded from human inbox projection', async () => {
    for (let i = 0; i < 20; i++) if ((await processIntakeBatch({ sql: db, limit: 50 })).claimed === 0) break;
    const count = async (actor: number) => Number((await db`SELECT COUNT(*)::int AS n FROM flightdeck_pg_notification_items WHERE recipient_actor_id = ${actors[actor]!}`)[0]!.n);
    const [bBefore, cBefore] = [await count(B), await count(C)];
    await post(ch1, 'human chatter for readers', { createThread: true });
    for (let i = 0; i < 20; i++) if ((await processIntakeBatch({ sql: db, limit: 50 })).claimed === 0) break;
    expect(await count(B)).toBe(bBefore);
    expect(await count(C)).toBeGreaterThan(cBefore);
  });

  test('inbox leakage audit: no inbox byte seen by B carries A-only, DM, prompt, W2, removed-mention or task sentinels', async () => {
    const seen = allBytes.join('\n');
    for (const key of ['dm', 'prompt', 'w2', 'mentionA', 'removed', 'sibling'] as const) expect([key, seen.includes(SENTINEL[key])]).toEqual([key, false]);
  });
});
