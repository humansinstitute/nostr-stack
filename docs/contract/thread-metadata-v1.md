# Canonical thread metadata updates v1

`PATCH /api/v4/flightdeck-pg/workspaces/:workspaceId/threads/:threadId`
accepts optional `title` and/or `metadata`. At least one is required. Existing
rename callers retain their response shape, optional row-version behavior,
whitespace normalization and 120-character title limit. Omitted title and
metadata are preserved independently.

```json
{"row_version":7,"metadata":{"review_app":{"checklist":["Check sources"]}}}
```

Metadata is **full replacement**, not a merge or JSON Patch. `{}` clears it.
A metadata write, including a combined title/metadata write, requires a JSON
number `row_version`: integer 1–2147483647 matching the canonical thread row.
Strings, booleans, null, fractions and missing versions are rejected with 400.
Metadata must be a JSON object, at most 65536 bytes in its compact UTF-8 JSON
encoding, nesting depth at most 32 (root depth zero), and at most 8192 values
including the root and containers. Arrays may be nested but cannot be the root.
Null root, malformed JSON, non-finite numbers, invalid Unicode, NUL characters, and operations
without supported changes are rejected. Nested null is allowed. Unknown request
fields are ignored and never copied to the thread row.

The SQL update checks workspace, native thread ID, non-deleted state and expected
row version atomically. Competing writes based on one version have one winner;
the loser receives `409 stale_row_version`, with no audit or outbox entry.
Title-only writes without CAS remain supported and preserve current metadata;
clients should provide a version for conflict-sensitive renames too.

Authorization is unchanged: active workspace membership, `channel.write` on the
thread's actual channel, and for non-human actors thread participation by message
authorship or canonical mention. Cross-workspace thread IDs return 404. Metadata
keys are descriptive application data, not canonical ACL, identity, membership,
lineage, lifecycle, latest-message, activity or attention fields. References
supply no read/write grant to the referenced resource; each application resolves
and authorizes that resource separately. Thread metadata is visible to thread
readers and must not hold secrets intended for a narrower audience.

## Application boundary

Apps own their key names, format versions, resource-reference/checklist schemas,
limits below this ceiling and user experience. For example, a document application
can keep native resource IDs under its own key, and an independent review client
can keep a bounded checklist under another key. Neither requires a new NStack
schema, route, table or deployment for each app format. This primitive updates an
existing shared canonical row; it does not provide arbitrary SQL or a catalogue.

Existing namespaced app DB/JSON rows, org-data, napplet collections and storage
remain available for app-owned domain data. App DB SQL requires the registered app
signer and app-side participant authorization; membership-aware app rows still
own separate rows. Org-data has dedicated grants/revisions; napplet collections
have their own audience, grants and revisions; storage owns blobs and versions.
None exposes an end-user mutation of the existing canonical thread with its
channel ACL, participant rule and sync identity. Moving thread state to those
stores or migrating clients is outside this additive extension.

Current source audit finds no backend interpretation of thread metadata for
permission, routing or activity. The workroom start path writes descriptive
`kind`/`workroom_id` labels; workroom routing uses its own row's `thread_id` and
`metadata.announcement_thread_id`. Message metadata has separate semantics and is
not changed here. Future server-interpreted thread keys require an explicit
protected-key contract before introduction.

## Audit, events and hydration

Success returns existing `{identity,thread,audit,outbox}`. Each write advances
thread `row_version`, `updated_at`, and `updated_by_actor_id`. It preserves
`latest`, `activity_version`, `attention`, source/branch IDs and canonical ACLs;
it creates no chat message or unread activity. Updated timestamps can change
views that deliberately sort by modification time; they are not chat activity.

The row update, audit, canonical record journal and outbox commit together.
Metadata/combined updates audit `thread.update`, recording changed field names
and new row version, without copying metadata into audit. They emit:

- `event_type: flightdeck_pg.thread.updated`
- `entity_type: thread`, `entity_id: <native thread UUID>`
- `operation: updated`, `entity_row_version: <new thread row_version>`
- `payload: {thread_id,title,thread:<existing serialized canonical thread>}`

Title-only writes retain audit `thread.rename`, event operation `renamed` and
payload `{thread_id,title}`. They use the same thread.updated event family.

`outbox.row_version` is the existing workspace event-stream sequence, distinct
from the entity's `row_version` and from opaque record-sync cursors/checkpoints.
Consumers process committed events through their existing authorized event/SSE
and recovery path. Metadata-aware clients materialize the canonical thread or
refetch GET thread on invalidation; they must not drop an update merely because
its chat activity version is unchanged. Existing record-sync triggers also
journal the raw canonical thread row with metadata and a new record position.
Android/Mac can consume that row through their existing raw-row hydration path.
Do not advance a record-sync completeness checkpoint from a PATCH response or an
outbox cursor; continue ordinary record-sync paging/acknowledgement.

## Conflicts and uncertain responses

Read canonical thread metadata and its actual `row_version`, apply only the
user's intended change to the app-owned key, preserve all other keys, and PATCH
that full object with the base version. On 409, refetch, reapply the same add/remove
or checklist intent to current state, and retry with the new version. Bound
retries and expose pending/error state; never overwrite with the stale object.

If the connection fails after submission, do not assume failure or success.
Read back the canonical row and evaluate whether the intended change is present.
If already satisfied, use that acknowledged canonical state. Otherwise reconcile
against the latest version and retry only the remaining intent. A retry with the
old version after a successful commit returns 409 and cannot overwrite newer
state. This route does not provide an idempotency key or exactly-once audit
semantics; blindly retrying with a newly fetched version can create extra writes.
Concurrent later reversal can make historical success unknowable from readback;
report uncertainty rather than claiming a confirmed save.

## Validation and activation

`THREAD_METADATA_TEST_PORT=<task-owned disposable PG port> bun test
./tests/flightdeck-pg-thread-metadata.test.ts` exercises signed in-process HTTP,
real SQL CAS competition, authorization, journal/outbox/audit and forced rollback.
Load only `.env.example` for public test configuration. The test creates/drops its
own database and generates disposable identities; it does not use legacy nsec
fixtures. Use PostgreSQL 16 with user/password `postgres` on loopback, never the
shared runtime database. Without explicit port opt-in, database tests are skipped.

Source/disposable checks do not activate the running service. After accepting
the candidate and coordinating workers, the manager must run the repository's
`./rebuild_deploy_docker.sh`, verify `curl http://127.0.0.1:3100/health`, and perform
authorized live rename, metadata-only/combined, stale-version, denial and
cross-client sync/readback checks. The implementation worker must not restart
shared NStack, Autopilot or another managed runtime.
