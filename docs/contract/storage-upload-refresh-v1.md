# Same-object upload URL recovery

`POST /api/v4/storage/{objectId}/upload-url` renews the upload descriptor of an existing object. It never allocates an object, changes its path, ACL, owner, content type, size or checksum, or completes it. The request uses ordinary body-bound NIP-98 authentication (`{}` is a suitable body). The response is not cacheable.

The original uploader (including existing workspace-key resolution) must still have bound workspace membership, legacy owning-group upload authority where applicable, and current linked-resource read access. Read access alone, workspace ownership alone, and public visibility confer no upload authority. This matches the existing uploader lifecycle; it does not introduce a new channel-write permission model for unlinked prepares. Linking/posting still uses its existing independent write authorization. Registered application storage and generic objects protected by an active native app content fence cannot use this route. Hosting/credit write blocks apply before issuing an unfinished object's descriptor.

A successful response contains:

- `object_id`: the same UUID supplied in the path.
- `upload_url`: a fresh short-lived presigned HTTPS PUT URL for an unfinished object, or the existing signed API PUT route when presigning is not configured. The existing API upload size limits in each client still apply.
- `completed_at`, `size_bytes`, `sha256_hex`: lifecycle metadata. For completed objects `upload_url` is null; callers must validate integrity and reuse them without a PUT.

The server rechecks completion/lifecycle and native fences after URL generation; a lifecycle refusal cannot be converted into an API fallback. Existing presigned bearer URLs retain their provider-controlled expiry, just as prepare-issued URLs do; this route does not revoke earlier URLs or promise atomic S3 upload/completion. It issues no new write URL for an object observed completed. Existing completion integrity verification is unchanged.

Responses: 401 for missing/invalid authentication, 404 for missing or unauthorized/fenced objects, 402 for blocked storage writes, 409 for a lifecycle change that prevents safe renewal. Clients retain the original snapshot and IDs on every failure. An absent endpoint on an older server is a retryable delivery failure, never permission to call prepare again.

In Dialogue (native Android and iOS) uses this primitive for explicit same-snapshot retries. Other independent consumers include browser file uploads and CLI attachment uploads interrupted beyond their initial URL lifetime. Existing prepare/PUT/complete/read contracts and their consumers remain unchanged; adoption of this additive route is optional. No schema migration is introduced. Activate the reviewed NStack source through the normal service release procedure before rolling out clients, then verify authorized unfinished refresh, completed reuse, denial and exact-byte content readback against that runtime.
