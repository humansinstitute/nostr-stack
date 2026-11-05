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

Workspace members labelled human or agent may use the inbox and self-restrict without changing their label. Signed identity, membership and live grants remain mandatory. App/service identities are not implicitly admitted: only a pre-existing explicit notification-only profile preserves their prior inbox eligibility (`403 notification_identity_ineligible` otherwise). This does not confer execution authority.

## Routes

All routes are under `/api/v4/flightdeck-pg/workspaces/{ws}/agent-notifications`.

| Route | Purpose |
|---|---|
| `POST /subscriptions {consumer_id}` | Create or recover (idempotent per workspace, recipient and consumer). Tower fixes `floor_at = now − 24h` at creation. Recovery returns a cursor at `acked_through_seq`. If retention removed rows after that, it also returns `gap`. |
| `GET /?cursor&limit≤100` | Page of envelopes and tombstones. |
| `GET /stream?cursor` | SSE, using the same service function as polling. Frames: `ready`, `page` (identical to the poll response), `session_expired` (at most 10 min; reconnect with a fresh signature), `error` (terminal, then close). |
| `GET /{id}/context` | Bounded, revalidated context. |
| `GET /{id}/references/threads/{channel_id}/{thread_id}`, `…/references/docs/{id}`, `…/references/tasks/{id}` | A record a human referenced in the notified text (see Referenced records). |
| `GET /{id}/attachments/{storage_object_id}` | Bytes of a trigger or transcript attachment. Never a URL. |
| `POST /{id}/ack {subscription_id, outcome, code?}` | Outcome: `handled`, `suppressed`, `source_gone` or `failed_permanent`. Idempotent per (notification, subscription). `source_gone` is accepted only when Tower confirms it (`409 source_present` otherwise). |
| `GET/PUT/DELETE /access-profile` | Notification-only classification (delivery profile; never an API ceiling). |

## Envelope (exact key set)

```json
{ "id": "…", "seq": 42, "kind": "chat_mention", "reason": "canonical_mention", "state": "active",
  "source": { "type": "message", "id": "…", "version": 1, "channel_id": "…", "thread_id": "…", "task_id": null, "doc_id": null },
  "author_npub": "npub1…", "occurred_at": "…", "origin_notification_id": null }
```

`origin_notification_id` is non-null only for `reason: "self_mention"` (see Deliberate self-address).

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

- be an eligible member identity (human/agent label independent, or an already classified app/service);
- be an active member;
- not be the author, except a verified deliberate self-address (below);
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

## Notification-only classification (`access-profile`)

A classification row is per (workspace, actor). There is no identity-wide or global scope in v1.

| Action | Who may do it |
|---|---|
| Set | The eligible member itself, or a `workspace.manage` holder for another eligible member in that workspace |
| Lift | A `workspace.manage` holder who is not restricted in that workspace; never the bot itself |

Classification is a **delivery profile**, not an API ceiling. It decides what Tower pushes to the identity:

- the identity receives notifications only through this addressed-only inbox;
- it never joins a legacy visibility audience (see below) and is excluded from human inbox projection;
- an audience member classified while a manager event stream is open is reported as rejected and drops out of that stream.

It never refuses a request. Every API, CLI or Blossom request signed by the identity is authorized by the route's ordinary ACL for the verified signer (workspace membership, groups, grants, record access), exactly like any other agent identity. Unauthorized and cross-workspace requests are refused by those same ACL checks. Signing restrictions live with the signer (Autopilot's per-bot signing policy); exact-request NIP-98 binding (URL, method, payload hash, freshness, single use on inbox routes) is unchanged.

The classification provider reads rows on every lookup (no cache) and fails closed for audience decisions: a lookup error never adds a classified identity to an audience. Test fixtures without the runtime schema inject `unclassifiedFixtureCeiling` explicitly.

## Deliberate self-address

A structured mention of the author in their own message is projected to the author (kind `chat_mention`, reason `self_mention`) only when ALL hold:

1. The source is a channel message, and this exact revision is still the stored one (a later edit makes the event ineligible).
2. Its structured mentions name the author (not body text, DM participation, assignments or invocations).
3. The STORED kind-33358 instruction signature verifies against this revision: signer is the author (messages are signed by the acting npub itself, so workspace-key-signed self-address is not supported), body and location tags match, and a `mentions_sha256` tag binds the saved mentions. The tag is the lowercase hex SHA-256 of the UTF-8 bytes of `JSON.stringify([{type, npub}, …])`, with lowercase values, deduped, sorted by `npub` then `type` (empty list: `"[]"`). A present tag that does not match is refused at write (400). Without the tag nothing is projected; ordinary messages are unaffected.
4. The message names `origin_notification_id`: the author's own live non-self notification in the same channel and thread (inside an active floor, current ACL, relationship `ok`). It is validated at write (403 `origin_notification_invalid`) and again at projection. The client never sets it through `metadata`.

Such a row:

- stays eligible only while its origin is (the relationship oracle checks the origin, so it is revoked with it), and only while its trigger is still the projected revision last updated by the bot (an edit after projection revokes it);
- binds no write by itself;
- gets a context that never exceeds the ORIGIN's: the window is exactly what the origin's own context authorizes now (its trigger and bounded transcript, current versions, by the origin's policy), plus later messages the bot both wrote and last updated. On the trigger and those own messages only attachments the bot linked itself are listed or downloadable. Thread and channel descriptors are the same current values the origin context shows.

Autopilot still decides whether to execute it (instructor grant). A notification never authorizes execution.

## Work receipts

A create of a doc, task, file or audio note that names `origin_notification_id` mints a receipt in the same transaction. The origin must be the caller's live notification in that channel, otherwise the create is refused (403) and nothing is written. The 201 response adds:

```json
"work_receipt": { "entity_type": "doc", "entity_id": "…", "receipt_row_version": 3, "origin_notification_id": "…", "body_sha256_hex": "…", "version_id": null }
```

The key is absent without an origin. A task create replayed with the same `client_request_id` returns the original receipt.

A receipt is provenance for the bot's own output. It grants nothing: reads and updates of the entity are authorized by the route's ordinary ACL. For a caller holding its own receipt, the receipt follows an update only when it still matched the replaced version; otherwise `work_receipt` is absent.

## Legacy visibility audience (transition)

`PUT event-subscription-agents` reconciles idempotently per (manager, workspace):

- The manager's existing registrations in that workspace, sent unchanged or as a subset, are kept without new consent. Existing Autopilots therefore reconnect unharmed after a Tower restart.
- Any addition (a new agent, a re-added agent, or any agent for a manager with no existing grant) requires `legacy_broad_feed_consent: true` in the payload-signed request. Without it the entry is rejected with `legacy_consent_required`.
- Notification-only agents are always rejected (`notification_only_agent`), even when previously registered and even with consent.
- There is no switch that disables this.

Unclassified legacy bots remain an acknowledged exposure during the staged transition.

## Not in v1

- Delegated manager fan-in. There is no delegation route, so classified bots cannot be delegated.
- Approval and flow-step notifications. They have no PG outbox events.
- Any identity-wide (global) classification.

### Exact DM activation facts

The bounded context channel includes `participant_npubs`, read from the current channel in the same locked, relationship-revalidated snapshot. Consumers may activate an unmentioned DM only when `kind` is `dm` and exactly two distinct participants are the current addressed bot and the verified message author. Historical keys, instance identities, channel names and labels never substitute for either participant. Missing or malformed facts fail closed. This adds no ordinary channel-read permission; instruction signatures and instructor authorization remain mandatory. A handled inbox acknowledgement records processing, not an answered message; suppressed dispatch outcomes remain distinct.
