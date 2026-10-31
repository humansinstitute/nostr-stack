# Concurrent document editor sessions v1

Any authorized document writer, human or bot, can opt into concurrent local editing and publish the next canonical version with the existing compare-and-swap (CAS) body contract. A peer's successful save never revokes another concurrent session or changes its local draft. Tower does not merge bodies; clients explicitly review or merge against the latest canonical base.

## Negotiation

Inspect `GET /api/v4/flightdeck-pg/workspaces/:workspaceId/edit-leases?entity_type=document&entity_id=:docId`. Require `document_edit_protocols` to contain `document_concurrent_edit_v1`. The existing singular `document_edit_protocol: "document_edit_session_v1"` remains for legacy clients. Inspection acquires nothing, exposes no token or editor session ID, and its singular `lease` is one active lease, not an editor roster.

Acquire with the existing endpoint:

```json
{
  "entity_type": "document",
  "entity_id": "<document UUID>",
  "document_edit_protocol": "document_concurrent_edit_v1",
  "editor_session_id": "<fresh UUID for this local editor>",
  "ttl_seconds": 120
}
```

A successful 201 must echo `document_edit_protocol: "document_concurrent_edit_v1"` before the client treats its token as concurrent authority. The response contains the existing `lease` (including its token and own session ID), coherent latest `doc`, `canonical_version`, and `taken_over: false`. Acquisition neither increments `row_version` nor writes a canonical history snapshot, audit takeover or updated event. A bot uses exactly this negotiation and the same writer permissions as a human; actor kind grants no additional authority.

A distinct session can acquire while concurrent sessions are active, including another editor belonging to the same actor. Retrying acquisition with the same active actor/session returns `409 edit_lease_held`, rather than rotating its token. Tokens are stored as hashes; a lost response cannot be used to recover the raw token. Preserve the draft and wait for expiry or release a known token. Expired intact sessions may reacquire; superseded session identities retain the existing durable fence.

## Saving and reconciliation

Use the existing document PATCH with `lease_token`, captured `row_version`, `base_body_sha256_hex`, optional `base_version_id`, and new `storage_object_id`. Never relabel an old divergent draft with a fresh base without explicit reconciliation. The exact actor-bound token and current permission checks still apply. Missing or inaccessible canonical authority cannot publish a head.

Tower serializes canonical writes and acquisition on the document row. Matching base identity advances canonical history once. A stale body produces the existing idempotent `409 document_recovery_created` with the submitted body and metadata preserved outside the head. Concurrent tokens remain active after either outcome. Metadata-only writes still require current `row_version` and a valid token; archive-only writes retain their existing version-checked lease exemption. Recovery promotion retains its existing CAS and history rules.

For local v6 edits while another editor publishes v7 and v8: preserve the v6 draft, fetch and compare v8, explicitly accept v8 locally or merge using the common base, then submit the merged body against v8 to create v9. If another save wins during review, the stale submission becomes a recovery rather than overwriting that new head. Accepting latest requires no canonical write. Preserve work through failure, uncertain delivery and cancellation.

Renew through the existing lease renewal endpoint with the exact token. Renewal echoes the selected concurrent protocol. Save and renewal do not affect peer tokens. Release targets only that actor's exact lease/token; release is idempotent. TTL remains 30–600 seconds. Expired or released authority cannot renew or publish canonical saves, and another actor cannot reuse its token.

## Interoperability

Active exclusive and concurrent leases never overlap on one document:

| Requested mode | Active mode | Result |
| --- | --- | --- |
| Concurrent | Concurrent, distinct editor | Acquire without revoking peers or changing head |
| Concurrent | Legacy or exclusive v1 | `409 edit_lease_held` |
| Legacy or exclusive v1, including takeover | Concurrent | `409 document_edit_protocol_conflict` |
| Legacy or exclusive v1 | Legacy or exclusive v1 | Existing exclusive conflict/takeover behavior |
| Either | No active leases | Acquire requested mode |

Concurrent requests cannot use `takeover: true` or `expected_lease_id` (400). Legacy takeover cannot silently supersede active concurrent tokens or insert an authority-barrier version. Release or expiry of **all** active sessions allows switching modes. Pre-migration rows without a protocol marker remain exclusive. Existing exclusive v1 takeover, version barriers and durable supersession remain documented in [exclusive sessions](document-edit-session-v1.md); task and scope behavior is unchanged.

This is additive opt-in functionality, with no client-specific body schema and no shared draft family. Clients must inspect capabilities and verify the acquisition echo; an older server may ignore unknown fields. Do not silently downgrade a concurrent editing workflow to exclusive takeover. Preserve local work and present the incompatibility or unavailable capability.

## Validation and activation

`tests/document-edit-session.test.ts` uses an explicitly selected disposable PostgreSQL port (`DOCUMENT_EDIT_TEST_PORT`, never 5432), synthetic documents and signed route requests. It checks legacy behavior, concurrent acquisition/save races, body reconciliation, recovery idempotency and promotion, permissions including agents/revocation, token ownership, mixed-mode fencing, expiry/release and canonical history/events.

Schema installation adds nullable `flightdeck_pg_edit_leases.document_edit_protocol`; existing rows need no rewrite. Bootstrap and runtime migration both support it. Deploy schema and server code together; old server binaries must not serve against concurrent sessions because they do not implement the mode fence. Source validation is separate from managed runtime activation. Rebuild/restart and authenticated live smoke checks remain the supervising manager's responsibility when authorized; capability inspection is the client activation gate.
