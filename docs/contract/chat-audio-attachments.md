# Chat audio attachments

Audio uses the existing private storage and Flight Deck PG message contracts.
Tower does not decode audio during upload; media validity is a client concern.

For a new recording:

1. Prepare, upload and complete a private workspace storage object.
2. Send `POST /api/v4/flightdeck-pg/workspaces/:workspaceId/channels/:channelId/messages`
   with its object ID in `metadata.attachments`, a durable `client_request_id`,
   and the required message instruction signature.
3. For a new conversation use `create_thread: true` without `thread_id`.
   For an existing thread use its `thread_id` without `create_thread`.
4. Retry the same frozen request after an uncertain response. A successful
   replay returns HTTP 200, `replayed: true`, and the original message/thread IDs.

Do not register the same object as a channel File before attaching it to a
message. A storage object has one active Flight Deck PG entity association.
The message route returns HTTP 409, `code: message_attachment_conflict`, when
another active association exists. Message/thread creation rolls back together;
that rejected transaction does not reserve the client request ID.

A recording already registered as a channel File can remain that File. Once the
client verifies the File, completed object, and original channel/account binding,
it can send a body link such as `[voice.m4a](storage://<object-id>)` without putting
that object in `metadata.attachments`. This retains the existing association and
bytes. This is a deliberate recovery request, not permission to rewrite any
uncertain request: first reconcile whether the original message was committed.
Do not delete the File, reupload the recording, or retarget to current navigation
as an automatic recovery step. The client must retain its recording, typed draft,
and durable outbox until the appropriate acknowledgement/recovery transition.

HTTP 409 is not an acknowledgement. In particular, `idempotency_conflict` means
an accepted request ID was reused with materially different input. The message
hash includes channel ID, requested thread ID, `create_thread`, trimmed body,
and ordered attachment object IDs. Retrying with a newly generated signature
does not change these values. Changed body or attachment ownership requires
explicit recovery and reconciliation, not treating the conflict as success.

Workspace/channel authorization, private storage access, NIP-98 authentication,
and message instruction signatures continue to apply to all paths. A storage
link in prose does not grant access to the underlying bytes.

The regression in `tests/flightdeck-pg-api.test.ts` named
`audio File registration conflicts atomically, while new DM attachment and link-only recovery replay safely`
uses actual Tower routes, signed requests, PostgreSQL transactions, and an
in-memory blob backend. It covers dual-association rejection, rollback,
File-backed recovery, new DM attachment sends, lost-response replay,
materially changed retries, recipient byte access, and outsider denial. It is
contract coverage, not a device recording/playback or deployed-runtime test.
