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

- be an agent or a classified identity;
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

**Fail closed.** The ceiling reads classifications through an injected provider. The production provider (`databaseCeilingProvider`) refuses any authenticated request whose classification cannot be determined: a database error or a missing table returns `503 authorization_unavailable`. It never treats an error as "unclassified". There is no classification cache: every authenticated request reads the small, indexed classification rows, so a committed classification applies to the very next request on every Tower process. Workspace-key aliases resolve through the same resolver the routes use, so the ceiling and the handler always agree on the acting identity. Production constructs the app with this provider explicitly and serves traffic only after the runtime schema is ensured. Test fixtures without the runtime schema inject `unclassifiedFixtureCeiling` explicitly.

**Open connections.** The ceiling also holds for the lifetime of a connection it admitted. Before delivering anything further, a long-lived read re-runs the same ceiling decision. It uses the original request's route and workspace attribution and the identity bound when the route authenticated the connection: the verified signer and the identity it resolved to. NIP-98 is not re-verified. Both identities are checked, so removing or rotating a workspace-key alias after connect never turns a classified agent into an unrestricted one. The check uses the same provider, so it also fails closed (`authorization_unavailable`). A connection stops exactly when a new one would be refused. The first re-check runs after the route's own awaited setup, as the last read before the stream starts, so a classification committed during setup gets the ceiling's refusal (`403`/`503`, same body) instead of a `connected` frame, audience metadata or advisory replay:

| Connection | Re-decided | On refusal |
|---|---|---|
| `GET /api/v4/flightdeck-pg/workspaces/{id}/events/stream` | before each poll, and again as the last read before a loaded batch is emitted | one `flightdeck_pg.error` frame `{error, code, retryable, required_capability?}`, then close |
| the same stream with `audience_npub` | additionally, an audience member classified while a batch loads drops that batch without advancing the cursor; the next poll re-resolves the audience without it. `flightdeck_pg.audience_changed` is emitted only together with a batch that passed the final check | `flightdeck_pg.audience_changed` on a later poll |
| `GET /api/v4/workspaces/{owner}/stream` (advisory) | before each delivery; events queued during a check share the next check | one `event: error` frame `{error, code}`, then close |
| Blossom `GET /{sha256}` (authenticated, private) | before each further chunk, together with the storage ACL | the body errors with `storage_access_revoked` |

In-flight bound: emission after the final check is synchronous, but the check does not share a lock with the classification write. After a classification commits, a connection can therefore still deliver at most the one batch (event stream), queued batch (advisory stream) or chunk (Blossom) whose check read state before the commit. Nothing checked afterwards is sent, and bytes already handed to the client cannot be recalled. Unclassified identities (every human) see no new frames or behaviour. `/api/v4/storage/{id}/content` returns its whole body in one buffered response, so there is no later chunk to withhold.

A bound request returns `403 agent_notification_upgrade_required` (`retryable:false`) before any handler runs, unless it is one of:

- this inbox;
- a write bound to a **live** notification of the bot: current access, canonical relationship `ok`, and inside an active subscription's 24h floor (the same eligibility as reads, so retained pre-floor rows bind nothing).

Bound writes (each still subject to its normal route ACL):

| Write | Bound when |
|---|---|
| `POST channels/{ch}/messages` | A message-sourced notification exists in that channel/thread. `create_thread` is refused. |
| `PUT agent-activities/{id}` | The body's channel/thread matches a bound message notification. |
| `POST response-activities` | The target is a bound thread, task, doc or source. |
| `POST tasks/{id}/comments`, `POST tasks/{id}/state` | The task is bound. |
| `POST docs/{id}/comments`, `PATCH docs/{id}` | The doc is bound. |
| `POST edit-leases/acquire`, `POST edit-leases/{id}/renew\|release` | The bound task/doc, and the bot's own lease. |
| `POST channels/{ch}/(docs\|tasks\|files\|audio-notes)` | Requested work products, created only in a channel where the bot holds a live notification. With `origin_notification_id`, that exact origin must be live in this channel (the create then mints a work receipt). A file create carrying `metadata.text_attachment_lineage` is refused (it could adopt and return another creator's canonical file); the refusal is the generic one, before any lineage lookup. |
| Receipted reads/updates (see Work receipts) | The bot holds a receipt for that entity whose origin is live. |
| `POST storage/prepare` | Only while the bot holds a live notification in the workspace. |
| `PUT /api/v4/storage/{id}`, `POST /api/v4/storage/{id}/complete` | Only the bot's own uncompleted upload. |

Bytes become visible only by linking them to a bound write, such as a reply's attachments, a channel file or a document body. Every storage object a classified bound write references (`storage_object_id`, `metadata.attachments[*].storage_object_id`) must be the bot's OWN upload by the server-owned `created_by_npub` (signer or acting identity). Otherwise the write gets the generic refusal before any handler lookup. A human's orphaned or tombstoned object, another bot's upload or an unknown id is never adopted, and the refusal is identical for all of them.

Unbound and nonexistent ids get byte-identical refusals, so there is no existence or readback oracle.

Other effects of classification:

- The bot is removed from this workspace's visibility audiences, and audience registration rejects it (`notification_only_agent`).
- Classified identities receive no human inbox items in that workspace.
- Every classification change is audited in `flightdeck_pg_agent_notification_audit`.

Residual: an allowed write's response echoes the bound record written (for example, the created message and its thread descriptor).

Idempotent writes never grant reads of changed existing output. For a classified caller:

- a task-create replay (`client_request_id`) returns the existing task only while the caller's own live receipt covers exactly its current `row_version` (without `attention`/`activity_version`, with `work_receipt`);
- a message replay returns the caller's own message only while nobody else has edited it, and without the current thread descriptor;
- an agent-activity id collision answers 409 without the existing row (`current`).

Otherwise the replay gets the generic `403 agent_notification_upgrade_required` with no content. Human replay semantics are unchanged.

Notifications with `reason: "self_mention"` never bind a write. An `origin_notification_id` named on a message must be live in that exact thread.

## Forgejo sign-in for notification-only identities

`POST /api/v4/git/oidc/authorize/complete` (exact method and path) is admitted for a classified identity. It only proves the signer's identity to the registered OIDC client. The route itself verifies the one-time request id, nonce, `aud`, expiry, payload hash and the Forgejo allowed-login list, and Forgejo owns repository rights. Nothing else under `/api/v4/git` is admitted, and nothing that reads workspace data.

## WApp publishing repair for notification-only identities

A classified identity may use exactly `GET …/wapp-publishing-grants/{wapp_installation_id}` and `POST …/wapp-publishing-grants/{wapp_installation_id}/rotate`, and only through an explicit owner delegation:

- its latest delegation from the workspace owner is `wapp.manage`, unrevoked, and inside `valid_from`/`expires_at`;
- every non-empty filter covers the installation's real (hydrated) facts: installation id, app id, destination scopes and channels, grant capabilities, registered open origins, Autopilot origin. An empty filter keeps its explicit wildcard meaning. A filtered fact with no recorded value fails closed.

`workspace.manage` alone never admits a classified identity, at the ceiling or in the route (the route re-checks the same predicate and never takes its `workspace.manage` branch). The grant list, PUT, disable and revoke stay refused. Otherwise the request gets the generic refusal, identical for unknown installations. Rotation keeps all existing validation: the current-key match, the nonce/expiry window and stale-key protection.

## Learning for notification-only identities

Learning routes carry no workspace attribution, so a classified identity is otherwise refused there. It may use exactly:

`GET /api/v4/learning/curriculum`, `GET …/curriculum/traverse`, `GET …/mastery`, `GET …/recall/due`, `POST …/plans`, `POST …/lessons`, `POST …/assessments`, `POST …/recall`

and only when:

- the `x-learning-grant-id` header names the grant, AND the NIP-98 event carries the equal signed tag `["learning_grant_id", "<id>"]`, since the header alone is outside the signature;
- that grant is an active delegation of the acting identity (workspace-key aliases resolve as in the routes). It is read under the learning RLS role with the same predicate as the routes: grantee = actor, not revoked, `can_read`, and `can_write` for POST.

The route then applies the same grant in its own RLS transaction. Implicit learner selection never applies to a classified identity. Profile, delegations, plan/lesson history, views, overlay, evidence, submissions, reviews and `research/*` stay refused. Notifications and receipts never confer learning access. Humans and unclassified identities are unchanged: the header stays optional and no tag is needed.

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

The key is absent without an origin. A task create replayed with the same `client_request_id` returns the original receipt. Text-attachment lineage creates are refused for classified identities (see Bound writes), so no lineage file is ever adopted or minted through them.

For a classified bot a live receipt (origin still live) admits only that entity, only at the receipted version, checked in the ceiling AND in the handler transaction:

| Route | Through a receipt |
|---|---|
| `GET docs/{id}`, `GET docs/{id}/body` | the receipted `row_version` only |
| `PATCH docs/{id}` | base `row_version` = current = receipt; no channel move; never a recovery save; the receipt advances to the version written |
| `POST edit-leases/acquire` (doc/task), `renew`, `release` | at the receipted version; no takeover |
| `GET tasks/{id}`, `POST tasks/{id}/state` | the receipted `row_version` only; the read returns the task row without assignment enrichment; a state change advances the receipt |
| `POST tasks/{id}/comments`, `POST docs/{id}/comments` | append-only on the unchanged receipted entity; top-level only (no `parent_comment_id`); the response carries only the new comment |
| `GET files/{id}`, `GET files/{id}/object` | the receipted `row_version` only |
| `GET files/{id}/versions/{v}/object` | only the receipted version `v` |
| `GET audio-notes/{id}`, `GET audio-notes/{id}/media` | the receipted `row_version` only |

Docs, files and audio notes are also compared by content sha256, so a body or object swapped without a version change is a different version. Any other version answers `409 {"error":"work_output_changed","code":"work_output_changed","retryable":false}` with no content. A successful receipted update returns the advanced `work_receipt` (compare-and-set; a receipt that does not advance fails the update with 409). For an unrestricted caller holding its own receipt, the receipt follows its update only when it still matched the replaced version; otherwise `work_receipt` is absent. A human edit therefore freezes the output until a new eligible notification binds it. Updates serialize on the receipt row. Minting and receipted updates hold the origin's notification, the recipient's active subscriptions, the channel/scope and the origin source message FOR SHARE, so a concurrent revocation either commits first (and is observed) or waits. Comment reads, other entities and storage/Blossom routes are never reachable through a receipt. Through a receipt the bot observes the version it wrote and nothing that moves independently of it. Every content change bumps `row_version`, but comments and other activity do not. So `attention` (last activity actor, comment/mention activity ids) and `activity_version` are omitted from receipted doc/task reads, lease acquire and update responses. Receipted write responses (updates, own comments) also omit the activity counters and the outbox echoes (`outbox`, `mention_outbox`, `view_state_outbox`), whose `row_version` is the workspace-wide event sequence. A later unnotified human comment therefore leaves every receipted read byte-identical. Human and notification-bound responses are unchanged. Requests admitted through an ordinary notification binding keep the existing policy.

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
- Reactions and generic storage reads by classified bots.
- Any identity-wide (global) ceiling.
