import { Hono, type Context } from 'hono';
import { getDb } from '../db';
import type { Sql } from '../services/notification-core';
import { authorizeFlightDeckPgOperation } from '../services/flightdeck-pg-authorization';
import {
  AGENT_NOTIFICATION_STREAM_MAX_SECONDS, AgentNotificationError, acknowledge, agentNotificationApiEnabled, buildContext,
  clearAccessProfile, createOrRecoverSubscription, isClassifiedOrAgent, listInboxPage, readAccessProfile, readAttachment,
  resolveRecipient, setAccessProfile, verifyAgentNotificationRequest, type StrictAuth,
} from '../services/agent-notifications';

/**
 * Strict agent notification inbox routes (docs/contract/agent-notifications-v1.md). Every route verifies a fresh,
 * single-use exact-request NIP-98 event from the Authorization header. The recipient is always the verified signer.
 */
export const agentNotificationsRouter = new Hono();
const BASE = '/workspaces/:workspaceId/agent-notifications';

const sqlOf = () => getDb() as unknown as Sql;

function errorResponse(c: Context, error: unknown) {
  if (error instanceof AgentNotificationError) {
    return c.json({ error: error.code, code: error.code, message: error.message, ...error.extra }, error.status);
  }
  console.error('[agent-notifications] request failed:', error instanceof Error ? error.message : String(error));
  return c.json({ error: 'internal_error', code: 'internal_error', message: 'Agent notification request failed' }, 500);
}

async function strict(c: Context, route: string): Promise<{ auth: StrictAuth; rawBody: string }> {
  if (!agentNotificationApiEnabled()) throw new AgentNotificationError(404, 'not_found', 'Not found');
  const rawBody = ['GET', 'HEAD', 'DELETE'].includes(c.req.method) ? '' : await c.req.text();
  const auth = await verifyAgentNotificationRequest(c.req.raw, rawBody, route, sqlOf());
  return { auth, rawBody };
}

const parseJson = (raw: string) => {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new AgentNotificationError(400, 'validation_error', 'Body must be JSON'); }
};

agentNotificationsRouter.post(`${BASE}/subscriptions`, async (c) => {
  try {
    const { auth, rawBody } = await strict(c, 'subscriptions.create');
    const recipient = await resolveRecipient(sqlOf(), c.req.param('workspaceId'), auth.userNpub);
    const result = await createOrRecoverSubscription(sqlOf(), recipient, parseJson(rawBody).consumer_id);
    return c.json({ recipient_npub: recipient.npub, ...result }, result.created ? 201 : 200);
  } catch (error) { return errorResponse(c, error); }
});

agentNotificationsRouter.get(BASE, async (c) => {
  try {
    const { auth } = await strict(c, 'list');
    const recipient = await resolveRecipient(sqlOf(), c.req.param('workspaceId'), auth.userNpub);
    return c.json(await listInboxPage(sqlOf(), recipient, c.req.query('cursor'), c.req.query('limit')));
  } catch (error) { return errorResponse(c, error); }
});

agentNotificationsRouter.get(`${BASE}/stream`, async (c) => {
  let recipient;
  let firstCursor: string | undefined;
  try {
    const { auth } = await strict(c, 'stream');
    recipient = await resolveRecipient(sqlOf(), c.req.param('workspaceId'), auth.userNpub);
    firstCursor = c.req.query('cursor');
    // Validate the cursor before opening the stream so auth/cursor failures are ordinary HTTP errors.
    await listInboxPage(sqlOf(), recipient, firstCursor, 1);
  } catch (error) { return errorResponse(c, error); }
  const pollMs = Math.max(250, Number(Bun.env.AGENT_NOTIF_STREAM_POLL_MS) || 1000);
  const maxMs = Math.min(AGENT_NOTIFICATION_STREAM_MAX_SECONDS, Number(Bun.env.AGENT_NOTIF_STREAM_MAX_SECONDS) || AGENT_NOTIFICATION_STREAM_MAX_SECONDS) * 1000;
  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;
  const r = recipient;
  let cursor = firstCursor!;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown, id?: number) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const close = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } };
      signal?.addEventListener('abort', close);
      const startedAt = Date.now();
      let lastPing = Date.now();
      send('ready', { recipient_npub: r.npub, session_expires_at: new Date(startedAt + maxMs).toISOString() });
      while (!closed) {
        if (Date.now() - startedAt >= maxMs) {
          send('session_expired', { code: 'session_expired', message: 'Reconnect with a fresh signed request' });
          break;
        }
        try {
          // Same service function as polling: identical filtering, floor, revalidation and serialization.
          for (let page = 0; page < 10 && !closed; page += 1) {
            const result = await listInboxPage(sqlOf(), r, cursor, 100);
            const advanced = result.next_cursor !== cursor;
            cursor = result.next_cursor;
            if (result.notifications.length || advanced) send('page', result, result.notifications.at(-1)?.seq);
            if (!result.has_more) break;
          }
        } catch (error) {
          // Auth/cursor/membership failures are terminal: one error frame, then close. Never a broader fallback.
          const code = error instanceof AgentNotificationError ? error.code : 'internal_error';
          const extra = error instanceof AgentNotificationError ? error.extra : {};
          send('error', { code, ...extra });
          break;
        }
        if (Date.now() - lastPing > 15_000) {
          if (!closed) controller.enqueue(encoder.encode(': ping\n\n'));
          lastPing = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      close();
    },
    cancel() { closed = true; },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  });
});

agentNotificationsRouter.get(`${BASE}/access-profile`, async (c) => {
  try {
    const { auth } = await strict(c, 'access_profile.read');
    const { caller, target } = await accessProfileParties(c, auth, c.req.query('actor_npub'));
    if (caller.actorId !== target.actorId) await requireManage(c, auth);
    return c.json({ actor_npub: target.npub, ...(await readAccessProfile(sqlOf(), target.workspaceId, target.actorId)) });
  } catch (error) { return errorResponse(c, error); }
});

agentNotificationsRouter.put(`${BASE}/access-profile`, async (c) => {
  try {
    const { auth, rawBody } = await strict(c, 'access_profile.set');
    const body = parseJson(rawBody);
    if (body.profile !== undefined && body.profile !== 'notification_only') throw new AgentNotificationError(400, 'validation_error', 'profile must be notification_only');
    if (body.scope !== undefined && body.scope !== 'workspace') throw new AgentNotificationError(400, 'validation_error', 'only workspace scope exists');
    const { caller, target } = await accessProfileParties(c, auth, body.actor_npub);
    // A bot may restrict itself; a workspace manager may restrict a member agent IN THIS WORKSPACE only.
    if (caller.actorId !== target.actorId) await requireManage(c, auth);
    if (target.kind !== 'agent') throw new AgentNotificationError(403, 'agent_identity_required', 'Only agent identities can be classified notification-only');
    await setAccessProfile(sqlOf(), { workspaceId: target.workspaceId, targetActorId: target.actorId, byActorId: caller.actorId });
    return c.json({ actor_npub: target.npub, ...(await readAccessProfile(sqlOf(), target.workspaceId, target.actorId)) });
  } catch (error) { return errorResponse(c, error); }
});

agentNotificationsRouter.delete(`${BASE}/access-profile`, async (c) => {
  try {
    const { auth } = await strict(c, 'access_profile.clear');
    const { caller, target } = await accessProfileParties(c, auth, c.req.query('actor_npub'));
    // Lifting is an explicit manager action by an identity unrestricted in this workspace; a bot never lifts its own.
    const [callerHere] = await sqlOf()<{ bound: boolean }[]>`SELECT EXISTS (SELECT 1 FROM flightdeck_pg_agent_access_profiles WHERE actor_id = ${caller.actorId} AND workspace_id = ${target.workspaceId}) AS bound`;
    if (caller.actorId === target.actorId || callerHere?.bound) throw new AgentNotificationError(403, 'ceiling_lift_forbidden', 'A notification-only identity cannot lift a ceiling');
    await requireManage(c, auth);
    await clearAccessProfile(sqlOf(), { workspaceId: target.workspaceId, targetActorId: target.actorId, byActorId: caller.actorId });
    return c.json({ actor_npub: target.npub, ...(await readAccessProfile(sqlOf(), target.workspaceId, target.actorId)) });
  } catch (error) { return errorResponse(c, error); }
});

agentNotificationsRouter.get(`${BASE}/:notificationId/context`, async (c) => {
  try {
    const { auth } = await strict(c, 'context');
    const recipient = await resolveRecipient(sqlOf(), c.req.param('workspaceId'), auth.userNpub);
    return c.json(await buildContext(sqlOf(), recipient, c.req.param('notificationId')));
  } catch (error) { return errorResponse(c, error); }
});

agentNotificationsRouter.get(`${BASE}/:notificationId/attachments/:storageObjectId`, async (c) => {
  try {
    const { auth } = await strict(c, 'attachment');
    const recipient = await resolveRecipient(sqlOf(), c.req.param('workspaceId'), auth.userNpub);
    const content = await readAttachment(sqlOf(), recipient, c.req.param('notificationId'), c.req.param('storageObjectId'));
    return new Response(content.bytes, {
      headers: {
        'Content-Type': content.row.content_type || 'application/octet-stream',
        'Content-Length': String(content.size),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) { return errorResponse(c, error); }
});

agentNotificationsRouter.post(`${BASE}/:notificationId/ack`, async (c) => {
  try {
    const { auth, rawBody } = await strict(c, 'ack');
    const recipient = await resolveRecipient(sqlOf(), c.req.param('workspaceId'), auth.userNpub);
    return c.json(await acknowledge(sqlOf(), recipient, c.req.param('notificationId'), parseJson(rawBody)));
  } catch (error) { return errorResponse(c, error); }
});

// ------------------------------------------------------------------------------------------------------------------
async function accessProfileParties(c: Context, auth: StrictAuth, actorNpub: unknown) {
  const sql = sqlOf();
  const workspaceId = c.req.param('workspaceId')!;
  const member = async (npub: string) => {
    const [row] = await sql<{ workspace_id: string; actor_id: string; kind: string; classified: boolean }[]>`
      SELECT m.workspace_id, a.id AS actor_id, a.kind,
        EXISTS (SELECT 1 FROM flightdeck_pg_agent_access_profiles p WHERE p.actor_id = a.id AND p.workspace_id = m.workspace_id) AS classified
      FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id = a.id AND m.workspace_id = ${workspaceId}::uuid
      WHERE a.npub = ${npub}`;
    return row ? { workspaceId: row.workspace_id, actorId: row.actor_id, kind: row.kind, classified: row.classified, npub } : null;
  };
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new AgentNotificationError(404, 'workspace_not_found', 'Workspace not found');
  const caller = await member(auth.userNpub);
  if (!caller) throw new AgentNotificationError(403, 'workspace_membership_required', 'Actor is not a member of this workspace');
  const targetNpub = typeof actorNpub === 'string' && actorNpub.trim() ? actorNpub.trim() : auth.userNpub;
  const target = targetNpub === auth.userNpub ? caller : await member(targetNpub);
  if (!target) throw new AgentNotificationError(404, 'actor_not_found', 'Target actor is not a member of this workspace');
  if (!isClassifiedOrAgent(target) && caller.actorId === target.actorId) throw new AgentNotificationError(403, 'agent_identity_required', 'Only agent identities have an access profile');
  return { caller, target };
}

async function requireManage(c: Context, auth: StrictAuth) {
  const [workspace] = await sqlOf()<{ app_npub: string }[]>`SELECT app_npub FROM flightdeck_pg_workspaces WHERE id = ${c.req.param('workspaceId')!}::uuid`;
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub, appNpub: workspace?.app_npub ?? '', workspaceId: c.req.param('workspaceId')!, permission: 'workspace.manage', resource: { type: 'workspace' },
  });
  if (!decision.allowed) throw new AgentNotificationError(403, 'permission_denied', 'workspace.manage is required', { required_permission: 'workspace.manage' });
}
