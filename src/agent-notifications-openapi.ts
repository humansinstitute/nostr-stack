/** OpenAPI fragments for the strict agent notification inbox. Wire contract: docs/contract/agent-notifications-v1.md */
const uuid = { type: 'string', format: 'uuid' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const err = (description: string) => json(ref('AgentNotificationError'), description);
const workspaceParam = { name: 'workspaceId', in: 'path', required: true, schema: uuid };
const notificationParam = { name: 'notificationId', in: 'path', required: true, schema: uuid };
const tags = ['Agent notifications'];
const security = [{ nip98: [] }];
const strictNote = 'Strict exact-request NIP-98 in the Authorization header only (`?token` is rejected): tags `u` (exact URL with query), `method`, '
  + '`payload` (sha256 of the exact body; optional on bodyless GET/DELETE) and a unique `nonce` (16-128 chars); age <= 60s; '
  + 'each signed event is accepted once (`nip98_replayed`). The recipient is always the verified signer. Human/agent labels do not gate member inbox admission or self-restriction; app/service identities require an existing explicit notification-only profile.';
const op = (summary: string, extra: Record<string, unknown> = {}) => ({
  tags, security, summary, description: [extra.description, strictNote].filter(Boolean).join('\n\n'),
  parameters: [workspaceParam, ...((extra.parameters as unknown[]) ?? [])],
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'parameters' && key !== 'description')),
});
const authErrors = {
  '401': err('nip98_auth_required | nip98_header_required | nip98_invalid_event | nip98_url_mismatch | nip98_method_mismatch | nip98_stale_event | nip98_payload_mismatch | nip98_nonce_required | nip98_replayed'),
  '403': err('workspace_membership_required | notification_identity_ineligible | identity_rotated | subscription_revoked'),
};

export const agentNotificationSchemas = {
  AgentNotificationContextChannel: {
    type: 'object', required: ['id', 'workspace_id', 'kind', 'participant_npubs'],
    description: 'Current channel facts from the same locked, recipient-authorized snapshot. Exact participant identities only; no historical key aliases.',
    properties: { id: uuid, workspace_id: uuid, scope_id: { ...uuid, nullable: true }, name: { type: 'string' }, kind: { type: 'string' },
      participant_npubs: { type: 'array', items: { type: 'string' } }, metadata: { type: 'object' }, agent_chat: { type: 'object' } },
  },
  AgentNotificationError: {
    type: 'object', required: ['error', 'code'],
    properties: { error: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' }, recovery_cursor: { type: 'string' }, from_seq: { type: 'integer' }, through_seq: { type: 'integer' } },
  },
  AgentNotificationTombstone: {
    type: 'object', additionalProperties: false, required: ['id', 'seq', 'state'],
    description: 'Delivered when access or the canonical relationship is gone: no routing metadata. Ack as suppressed.',
    properties: { id: uuid, seq: { type: 'integer' }, state: { const: 'revoked' } },
  },
  AgentNotificationEnvelope: {
    type: 'object', additionalProperties: false, required: ['id', 'seq', 'kind', 'reason', 'state', 'source', 'author_npub', 'occurred_at', 'origin_notification_id'],
    description: 'Content-free envelope. Never carries bodies, titles, prompts, attachment names, URLs or other recipients.',
    properties: {
      id: uuid, seq: { type: 'integer', description: 'Recipient-local, commit-ordered sequence' },
      kind: { enum: ['chat_mention', 'direct_message', 'agent_direct_recipient', 'task_assigned', 'task_mention', 'task_comment_mention', 'document_mention', 'document_comment_mention', 'invocation', 'document_review'] },
      reason: { type: 'string', description: "Addressing rule, e.g. canonical_mention. 'self_mention' (kind chat_mention) is a verified deliberate self-address: it binds no write and its context stops at its origin" },
      state: { const: 'active' },
      source: {
        type: 'object', additionalProperties: false, required: ['type', 'id', 'version', 'channel_id', 'thread_id', 'task_id', 'doc_id'],
        properties: {
          type: { enum: ['message', 'task', 'task_comment', 'doc', 'doc_comment', 'invocation'] }, id: uuid, version: { type: ['integer', 'null'] },
          channel_id: { ...uuid, nullable: true }, thread_id: { ...uuid, nullable: true }, task_id: { ...uuid, nullable: true }, doc_id: { ...uuid, nullable: true },
        },
      },
      author_npub: { type: ['string', 'null'] }, occurred_at: { type: 'string', format: 'date-time' },
      origin_notification_id: { ...uuid, nullable: true, description: "Non-null only for reason 'self_mention': the live non-self notification it depends on" },
    },
  },
  AgentWorkReceipt: {
    type: 'object', additionalProperties: false,
    required: ['entity_type', 'entity_id', 'receipt_row_version', 'origin_notification_id', 'body_sha256_hex', 'version_id'],
    description: 'Returned as work_receipt by a docs/tasks/files/audio-notes create that named a live origin_notification_id. Grants the bot only the version it wrote; any other version answers 409 work_output_changed with no content.',
    properties: {
      entity_type: { enum: ['doc', 'task', 'file', 'audio_note'] }, entity_id: uuid, receipt_row_version: { type: 'integer' }, origin_notification_id: uuid,
      body_sha256_hex: { type: ['string', 'null'] }, version_id: { ...uuid, nullable: true, description: 'Files: the exact receipted version' },
    },
  },
  AgentNotificationSubscription: {
    type: 'object', required: ['recipient_npub', 'created', 'subscription', 'cursor'],
    properties: {
      recipient_npub: { type: 'string' }, created: { type: 'boolean' },
      subscription: {
        type: 'object', properties: {
          id: uuid, consumer_id: { type: 'string' }, floor_at: { type: 'string', format: 'date-time', description: 'Fixed by Tower at creation: now - 24h' },
          policy_version: { type: 'integer' }, acked_through_seq: { type: 'integer' }, created_at: { type: 'string', format: 'date-time' },
        },
      },
      cursor: { type: 'string', description: 'Opaque, HMAC-bound to workspace, recipient and subscription. Recovery resumes at acked_through_seq.' },
      gap: { type: 'object', description: 'Present when retention removed notifications after the acked position', properties: { code: { const: 'cursor_gap' }, from_seq: { type: 'integer' }, through_seq: { type: 'integer' }, recovery_seq: { type: 'integer' } } },
    },
  },
  AgentNotificationPage: {
    type: 'object', required: ['subscription_id', 'notifications', 'next_cursor', 'has_more'],
    properties: { subscription_id: uuid, notifications: { type: 'array', items: { oneOf: [ref('AgentNotificationEnvelope'), ref('AgentNotificationTombstone')] } }, next_cursor: { type: 'string' }, has_more: { type: 'boolean' } },
  },
  AgentNotificationAck: {
    type: 'object', additionalProperties: false, required: ['subscription_id', 'outcome'],
    properties: {
      subscription_id: uuid, outcome: { enum: ['handled', 'suppressed', 'source_gone', 'failed_permanent'] },
      code: { type: 'string', pattern: '^[a-z][a-z0-9_.:-]{0,63}$' },
    },
  },
  AgentAccessProfile: {
    type: 'object', properties: {
      actor_npub: { type: 'string' }, profile: { enum: ['notification_only', null], description: 'Classification in THIS workspace only' },
      policy_version: { type: 'integer' },
    },
  },
};

const BASE = '/api/v4/flightdeck-pg/workspaces/{workspaceId}/agent-notifications';
export const agentNotificationPaths = {
  [`${BASE}/subscriptions`]: {
    post: op('Create or recover an agent notification subscription', {
      description: 'Idempotent per (workspace, verified recipient, consumer_id). Tower fixes floor_at = now - 24h at first creation; the caller cannot widen it.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['consumer_id'], properties: { consumer_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' } } } } } },
      responses: { '200': json(ref('AgentNotificationSubscription'), 'Recovered'), '201': json(ref('AgentNotificationSubscription'), 'Created'), ...authErrors },
    }),
  },
  [BASE]: {
    get: op('List addressed notifications after a cursor', {
      description: 'Rows addressed to the signer only, seq > cursor, source_created_at >= subscription floor on every selection. Membership and source ACL are revalidated in one snapshot per page.',
      parameters: [{ name: 'cursor', in: 'query', required: true, schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }],
      responses: { '200': json(ref('AgentNotificationPage')), '400': err('invalid_cursor | validation_error'), '409': err('cursor_gap (retention); includes recovery_cursor'), ...authErrors },
    }),
  },
  [`${BASE}/stream`]: {
    get: op('Stream addressed notifications (SSE)', {
      description: 'Same service function as polling. Frames: `ready`, `page` (identical to the poll response), `session_expired` (reconnect with a fresh signature), `error` (terminal; then close). Sessions last at most 10 minutes.',
      parameters: [{ name: 'cursor', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'text/event-stream' }, '400': err('invalid_cursor'), ...authErrors },
    }),
  },
  [`${BASE}/{notificationId}/context`]: {
    get: op('Read bounded, revalidated context for one notification', {
      description: 'Recipient-bound, lock-linearized, relationship-revalidated. Default bounded_transcript (thread lineage incl. inherited range, <=20 messages / 32 KiB); AGENT_NOTIF_CONTEXT_POLICY=trigger_only for trigger only. No URLs. Unknown and foreign ids are byte-identical 404s.',
      parameters: [notificationParam],
      responses: { '200': json({ type: 'object', properties: { channel: ref('AgentNotificationContextChannel') } }), '403': err('access_revoked | relationship_removed | workspace_membership_required'), '404': err('notification_not_found'), '410': err('source_gone'), '503': err('authorization_contention'), '401': authErrors['401'] },
    }),
  },
  [`${BASE}/{notificationId}/attachments/{storageObjectId}`]: {
    get: op('Download an attachment of the notification trigger/context entity', {
      description: 'Recipient-signed every time; no bearer URL is ever issued by this flow.',
      parameters: [notificationParam, { name: 'storageObjectId', in: 'path', required: true, schema: uuid }],
      responses: { '200': { description: 'Attachment bytes' }, '403': err('access_revoked'), '404': err('attachment_not_found | notification_not_found'), '410': err('source_gone'), '401': authErrors['401'] },
    }),
  },
  [`${BASE}/{notificationId}/ack`]: {
    post: op('Acknowledge a notification outcome (idempotent)', {
      description: 'Bound to the caller\'s own subscription. source_gone is accepted only when Tower confirms the source is gone. Auth failures can never be acknowledged past.',
      parameters: [notificationParam],
      requestBody: { required: true, content: { 'application/json': { schema: ref('AgentNotificationAck') } } },
      responses: { '200': json({ type: 'object' }), '400': err('validation_error | invalid_cursor'), '404': err('notification_not_found'), '409': err('source_present'), ...authErrors },
    }),
  },
  [`${BASE}/access-profile`]: {
    get: op('Read an agent access profile (self, or any member agent with workspace.manage)', {
      parameters: [{ name: 'actor_npub', in: 'query', schema: { type: 'string' } }],
      responses: { '200': json(ref('AgentAccessProfile')), ...authErrors },
    }),
    put: op('Classify an agent notification-only in this workspace (the bot itself, or workspace.manage)', {
      description: 'Binds requests targeting this workspace\'s resources: everything except this inbox and notification-bound writes returns 403 agent_notification_upgrade_required. Never affects other workspaces. Removes the agent from this workspace\'s visibility audiences.',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { actor_npub: { type: 'string' }, profile: { const: 'notification_only' } } } } } },
      responses: { '200': json(ref('AgentAccessProfile')), ...authErrors, '403': err('agent_identity_required | permission_denied | workspace_membership_required') },
    }),
    delete: op('Lift a notification-only classification (workspace.manage, unrestricted caller, never the bot itself)', {
      parameters: [{ name: 'actor_npub', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': json(ref('AgentAccessProfile')), '403': err('ceiling_lift_forbidden | permission_denied'), '401': authErrors['401'] },
    }),
  },
};
