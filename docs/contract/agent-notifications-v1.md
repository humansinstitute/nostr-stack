# Strict agent notification inbox v1

Capability: `agent_notifications.v1` in `/.well-known/nstack.json`, and `agent_notifications_v1` in `/api/v4/flightdeck-pg/descriptor`. It is absent when `AGENT_NOTIF_API=off`; the routes then return 404.

## Boundary

A notification-only bot receives only rows **addressed** to its verified identity, plus explicitly authorized, recipient-bound context for those rows. These never substitute for addressing:

- channel membership;
- record visibility;
- a client-supplied npub;
- an owner assertion.

Tower enforces this before serializing any response. Local suppression in Autopilot is defense in depth only.

Identity proof, workspace permission and execution authority are separate. A notification never authorizes execution. Consumers keep verifying `agent_instruction_signature` on the trigger message; context returns it unchanged.

## Authentication (every route)

Strict exact-request NIP-98 (kind 27235), in the `Authorization` header only. A `token` query parameter returns `401 nip98_header_required`. Human EventSource `?token` behaviour on other routes is unchanged.

Required tags:

- `u`: the exact URL, including the query string;
- `method`;
- `nonce`: 16–128 chars, unique per request;
- `payload`: sha256 of the exact body. It is required on body-bearing requests. Bodyless GET/HEAD/DELETE may omit it; if present it must match the empty body.

The event must be no older than 60 s. Each event id is consumed once (`401 nip98_replayed`). Transport retries re-sign.

The recipient is always the verified signer, or the agent a workspace key resolves to. There is no audience parameter, and no fallback to `/events` visibility mode, including on errors.

Only agent actors (`kind='agent'`) and classified identities may use the inbox (`403 agent_identity_required`).

## Routes

All routes are under `/api/v4/flightdeck-pg/workspaces/{ws}/agent-notifications`.

| Route | Purpose |
|---|---|
| `POST /subscriptions {consumer_id}` | Create or recover (idempotent per workspace, recipient and consumer). Tower fixes `floor_at = now − 24h` at creation. Recovery returns a cursor at `acked_through_seq`. If retention removed rows after that, it also returns `gap`. |
| `GET /?cursor&limit≤100` | Page of envelopes and tombstones. |
| `GET /stream?cursor` | SSE, using the same service function as polling. Frames: `ready`, `page` (identical to the poll response), `session_expired` (at most 10 min; reconnect with a fresh signature), `error` (terminal, then close). |
| `GET /{id}/context` | Bounded, revalidated context. |
| `GET /{id}/attachments/{storage_object_id}` | Bytes of a trigger or transcript attachment. Never a URL. |
| `POST /{id}/ack {subscription_id, outcome, code?}` | Outcome: `handled`, `suppressed`, `source_gone` or `failed_permanent`. Idempotent per (notification, subscription). `source_gone` is accepted only when Tower confirms it (`409 source_present` otherwise). |
| `GET/PUT/DELETE /access-profile` | Notification-only classification (the authorization ceiling). |

## Envelope (exact key set)

```json
{ "id": "…", "seq": 42, "kind": "chat_mention", "reason": "canonical_mention", "state": "active",
  "source": { "type": "message", "id": "…", "version": 1, "channel_id": "…", "thread_id": "…", "task_id": null, "doc_id": null },
  "author_npub": "npub1…", "occurred_at": "…" }
```

When the recipient lost the source ACL, or the canonical relationship is gone, the row is delivered as a **minimal tombstone**: `{ "id", "seq", "state": "revoked" }`. It carries no routing metadata. Consumers ack it as `suppressed`.

## Addressing (revision-bound)

Addressing comes only from facts written in the source transaction:

| Fact | Kind |
|---|---|
| Outbox payload of the exact revision: `message.created` canonical `mentions` | `chat_mention` |
| `message.revised` `newly_added_mentions` (a recipient is never re-notified for the same message) | `chat_mention` |
| Task/doc comment `mentions` | `task_comment_mention` / `document_comment_mention` (one per comment) |
| `task_assignment.assigned` and task create/update assignment changes | `task_assigned` (one per assignment epoch) |
| Task create/update added mentions | `task_mention` |
| `document_mention_added` | `document_mention` |
| `invocation.created` agent recipients | `invocation`, or `document_review` for `full_document_review_requested` |
| Intake trigger snapshot taken inside the source transaction: `metadata.agent_direct_recipient_npub` (Agent Direct branch threads) | `agent_direct_recipient` |
| Intake trigger snapshot: DM channel participants | `direct_message` |

Human `/events` payloads are unchanged. Rows created by the one-shot activation backfill have no snapshot; for those, the current row is used only while it is still at the event's revision.

There is no channel-reader broadcast, no text-name matching and no thread follow-up broadcast. This matches current Autopilot Agent Direct eligibility.

A recipient must:

- be an agent or a classified identity;
- be an active member;
- not be the author;
- hold `channel:<id>:<family>` in `flightdeck_pg_record_access` at projection.

## Canonical relationship revalidation

`flightdeck_pg_agent_notification_relation(id)` is evaluated at delivery, context and attachment time. It also confirms `source_gone` acks:

| Result | Meaning |
|---|---|
| `ok` | The relationship still holds. |
| `source_gone` | The source was deleted or moved: deleted message, thread or comment; channel/thread pair mismatch; archived channel; deleted task or doc. |
| `relationship_removed` | The mention was removed by a later revision, the task was unassigned, the comment mention was removed, the invocation was closed or withdrawn, or the DM participant was removed. |

An old inbox id therefore never hydrates content the recipient is no longer addressed by.

## Ordering, floor and recovery

- **Discovery:** an intake row is written by trigger in the source transaction and claimed with `SKIP LOCKED`, then projected in intake order. Discovery is independent of outbox `row_version` commit order.
- **Sequencing:** `seq` is allocated under the per-recipient counter row lock, which is held to commit. Commit order therefore equals seq order, and readers never see a gap that later fills.
- **Floor:** `source_created_at >= floor_at` is applied on every selection. Scanned rows below the floor still advance the cursor. Cursor 0, forged cursors, other subscriptions' cursors and other workspaces' cursors cannot widen the window (`400 invalid_cursor`). Context for a pre-floor id is a 404.
- **Delivery:** at least once. Consumers dedupe by notification id. `acked_through_seq` is contiguous.
- **Retention:** rows are kept for 7 days. Only the contiguous seq prefix of expired rows is removed per recipient, so a late-committed lower seq is never skipped. A cursor below the retention floor gets `409 cursor_gap` with `recovery_cursor`. There is never a silent reset.
- **First activation:** a one-shot backfill enqueues the previous 24 hours of addressing-bearing outbox events (idempotent). `CREATE TRIGGER` locking leaves no boundary hole.

## Revocation linearization

Every page, context, attachment and ack runs in one REPEATABLE READ transaction that share-locks the rows granting access:

- the membership row (`FOR KEY SHARE`; membership removal is a DELETE);
- the actor row (`FOR SHARE`, which detects identity rotation);
- effective group memberships and edges (`FOR KEY SHARE`);
- every live grant (`FOR SHARE`);
- the channel and scope rows of the served notifications (`FOR SHARE`, which catches archival).

Attachment bytes are read inside the same locked transaction.

The ordering follows from those locks:

- A revocation already in progress blocks the read until it commits; the read then retries on a fresh snapshot (serialization failure 40001 retried, 503 `authorization_contention` after 5 attempts) and observes it.
- A revocation that starts later blocks until the read commits. Those bytes are in flight and cannot be recalled.
- The SSE stream repeats this per tick, and closes with a terminal `error` frame on any auth-class failure.

## Context

The default policy is `bounded_transcript`. For chat triggers it returns the effective transcript of the trigger's thread lineage (including the inherited parent range up to the branch point) strictly before the trigger:

- newest 20 messages or 32 KiB, returned oldest-first;
- `truncated` flag;
- no sibling threads or channels.

For task triggers it returns the 20 newest other comments. `AGENT_NOTIF_CONTEXT_POLICY=trigger_only` returns the trigger entity only.

Messages use the effective-transcript message shape, with metadata reduced to:

- `mentions`;
- `agent_instruction_signature`;
- `agent_direct_recipient_npub`;
- `attachments`: authoritative `{storage_object_id, file_name, content_type, size_bytes}` descriptors from the storage links table.

No URL is ever included. Document triggers include `body` in the `GET docs/{id}/body` shape (exact bytes, base64). A body over 2 MiB returns `body_too_large: true` and is never partial.

Status codes:

- `410 source_gone`: terminal.
- `403 access_revoked` or `403 relationship_removed`: authorization. These are never acked past as handled.
- Unknown and foreign ids return a byte-identical `404 notification_not_found`.

## Authorization ceiling (`access-profile`)

A classification row is per (workspace, agent). There is no identity-wide or global scope in v1.

| Action | Who may do it |
|---|---|
| Set | The bot itself, or a `workspace.manage` holder for a member agent in that workspace |
| Lift | A `workspace.manage` holder who is not restricted in that workspace; never the bot itself |

For a classified identity the ceiling is **default deny**. In order:

1. Only canonical paths are considered. Any `%` encoding, empty segment (`//`), dot segment or backslash is refused, so the ceiling and the router always see the same path.
2. The agent inbox routes are allowed; they self-enforce strict recipient auth.
3. Requests attributable only to workspaces where the identity is not classified are allowed, so another tenant's admin can never take away the bot's access to its own workspace.
4. Requests touching a classified workspace are allowed only when notification-bound.
5. Everything not attributable to a workspace is refused, for example group keys, graph, user routes, multi-workspace lists, unlinked storage objects, `/api/v4/records` without an owner, and blobs that resolve nowhere.

A request is attributed to its workspace by:

- the FD/WApp path workspace;
- `/api/v4/storage/{id}` via the object's links and owner;
- a Blossom blob via the object's sha256;
- `/api/v4/workspaces/{owner}`;
- the `/api/v4/records` owner or workspace-service parameters.

**Fail closed.** The ceiling reads classifications through an injected provider. The production provider (`databaseCeilingProvider`) refuses any authenticated request whose classification cannot be determined: a database error or a missing table returns `503 authorization_unavailable`. It never treats an error as "unclassified", and only successful lookups are cached (2 s, per process; Tower runs one process per instance, so a classification change is visible everywhere within 2 s). Production constructs the app with this provider explicitly and serves traffic only after the runtime schema is ensured. Test fixtures without the runtime schema inject `unclassifiedFixtureCeiling` explicitly.

A bound request returns `403 agent_notification_upgrade_required` (`retryable:false`) before any handler runs, unless it is one of:

- this inbox;
- a write bound to a **live** notification of the bot (current access and canonical relationship `ok`).

Bound writes (each still subject to its normal route ACL):

| Write | Bound when |
|---|---|
| `POST channels/{ch}/messages` | A message-sourced notification exists in that channel/thread. `create_thread` is refused. |
| `PUT agent-activities/{id}` | The body's channel/thread matches a bound message notification. |
| `POST response-activities` | The target is a bound thread, task, doc or source. |
| `POST tasks/{id}/comments`, `POST tasks/{id}/state` | The task is bound. |
| `POST docs/{id}/comments`, `PATCH docs/{id}` | The doc is bound. |
| `POST edit-leases/acquire`, `POST edit-leases/{id}/renew\|release` | The bound task/doc, and the bot's own lease. |
| `POST channels/{ch}/(docs\|tasks\|files\|audio-notes)` | Requested work products, created only in a channel where the bot holds a live notification. |
| `POST storage/prepare` | Only while the bot holds a live notification in the workspace. |
| `PUT /api/v4/storage/{id}`, `POST /api/v4/storage/{id}/complete` | Only the bot's own uncompleted upload. |

Bytes become visible only by linking them to a bound write, such as a reply's attachments, a channel file or a document body.

Unbound and nonexistent ids get byte-identical refusals, so there is no existence or readback oracle.

Other effects of classification:

- The bot is removed from this workspace's visibility audiences, and audience registration rejects it (`notification_only_agent`).
- Classified identities receive no human inbox items in that workspace.
- Every classification change is audited in `flightdeck_pg_agent_notification_audit`.

Residual: an allowed write's response echoes the bound record written (for example, the created message and its thread descriptor).

## Legacy visibility audience (transition)

New registrations through `PUT event-subscription-agents` require `legacy_broad_feed_consent: true`; rejected entries get `legacy_consent_required`. Existing registrations are kept. `AGENT_LEGACY_AUDIENCE_CONSENT=off` restores the old behaviour.

Unclassified legacy bots remain an acknowledged exposure during the staged transition.

## Not in v1

- Delegated manager fan-in. There is no delegation route, so classified bots cannot be delegated.
- Approval and flow-step notifications. They have no PG outbox events.
- Reactions and generic storage reads by classified bots.
- Any identity-wide (global) ceiling.
