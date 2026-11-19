# Registered app private storage v1

An owner-approved, enabled `workspace_apps` registration authorizes its exact raw
NIP-98 app signer to store private files in that owner/app namespace without
workspace membership. App backends enforce their own participant/resource ACLs.
This does not change the existing user-signed app Files/Alexandria APIs.

Base: `/api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/storage`.
Every operation requires a NIP-98 signature for the exact URL and method, and
mutations require the exact JSON payload hash. Workspace session aliases are not
substitutes for the app signer. Every request rechecks enabled registration.

| Method | Suffix | Body / response |
| --- | --- | --- |
| GET | `/descriptor` | Protocol, owner/app, `max_object_bytes:8388608`, `private_only:true`, operations `prepare,upload,complete,metadata,content,head` |
| POST | `/prepare` | `{idempotency_key:UUID,file_name,content_type,size_bytes,sha256_hex}`; returns metadata, HTTP 201 including replays |
| PUT | `/objects/:objectId` | `{base64_data}` in canonical padded base64; returns metadata |
| POST | `/objects/:objectId/complete` | `{size_bytes,sha256_hex}`; verifies stored bytes and returns metadata |
| GET | `/objects/:objectId` | Metadata |
| GET / HEAD | `/objects/:objectId/content` | Verified bytes / headers, after completion |

Metadata has exactly `protocol:"registered-app-storage-v1"`,
`workspace_owner_npub`, `app_npub`, `object_id`, `file_name`, `content_type`,
`size_bytes` (JSON integer), `sha256_hex` (lowercase), `is_public:false`,
`completed_at` (null until verified, then ISO timestamp). No provider URLs,
credentials, publication capability or read bearer tickets are returned.

Objects contain 1–8,388,608 bytes inclusive (maximum 8 MiB).
The JSON envelope has a hard 12 MiB bound, including chunked requests, before
signature verification. Body admission has a 15 second deadline and follows request
abort; interrupted reads return 408. GET/HEAD bodies are rejected. Unknown JSON fields are rejected; caller-selected
owner/group/public authority is forbidden. Filenames are nonempty, at most 255
characters, without control characters. Content types are MIME type/subtype
without parameters. Hashes accept 64 hex characters and normalize to lowercase.

Exact prepare replays reuse the same object. A changed name, type, size or hash
with the same owner/app/idempotency key returns 409. Upload validates size/hash
before S3 writes. Completed objects reject every further PUT. Completion requires
both declared and stored identity, and exact repeated completion is idempotent.
Incomplete content or identity mismatch returns 409. Wrong raw signer returns
403; disabled/unregistered apps and foreign objects return 404. Invalid input
returns 400; excessive envelopes return 413. Existing credit/hosting exhaustion
blocks prepare, upload and completion with 402 while reads remain available.

The owner namespace resolves to its canonical `v4_workspaces` record. Where only
a PG workspace exists, exactly one matching owner binding is required; ambiguous
PG-only owners fail with `workspace_binding_ambiguous` (409). No facade is picked
by timestamp or app name. The durable object records the exact owner, app,
creator, prepared identity, idempotency key and, for PG-only workspaces, UUID.

Registration share locks serialize revocation with admitted operations; object
row locks serialize content/write/completion, and per-idempotency locks serialize
prepare replays. A disable completed before admission revokes app access at every
stage. In-flight operations admitted before disable may finish before it commits.
No changes to registration, enrollment, signer custody or existing objects are
performed by this API. Generic storage endpoints deny app-principal writes and
app/peer reads, even if the app later gains membership. Current canonical human
owner recovery through generic signed reads is deliberately retained, including
after app disable. App objects do not inherit public, uploader or group access.

Content is private/no-store, uses the declared MIME type, and includes sandbox
CSP, nosniff and no-referrer headers. Only recognized raster image MIME types
are inline; other types use attachment disposition. Generic owner recovery reads
also sandbox app-principal content. Bytes use the existing private S3 adapter;
reads are bounded and buffered (at most 8 MiB), with stored hash verification.
Public sharing remains a separate explicit opt-in protocol; this API exposes none.

Bootstrap and runtime upgrade both install `registered-app-storage-v1.sql`'s
additive metadata. No historical user objects are migrated. Activation requires
an authorized Tower source rebuild/restart and combined broker/consumer smoke
checks; source tests do not prove deployed availability.

## Isolated validation

`tests/registered-app-storage.test.ts` requires an explicit `TEST_DATABASE_URL`
whose database starts with `tower_app_files_test`. Point it only at a disposable
Postgres fixture. It bootstraps schema there and tests signed HTTP lifecycle,
isolation, revocation, canonical binding, billing, concurrent replays, immutable
completion, malformed bodies, size/hash bounds and content security headers.
By default it uses the existing in-memory byte adapter. Set
`APP_STORAGE_TEST_S3=1` and explicit `STORAGE_S3_*` variables for a disposable
MinIO/S3 bucket to exercise real byte transport. Existing storage and app
publication suites also run against disposable database fixtures, never a shared
service database. Do not restart a shared service to run isolated source tests.
