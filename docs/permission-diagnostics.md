# Read-only permission diagnostics

`GET /api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/permission-diagnostics?target_npub={npub}&case_id={case}` explains the exact target actor's channel authorization using the production authorization function. Sign the entire exact URL and GET method with NIP-98. Optional `x-flightdeck-pg-app-npub` must match the workspace app. Both the resolved caller and target must be workspace members. Archived channels are excluded.

Existing `channel.grants.read` permits channel ACL evidence. Parent scope evidence separately requires `scope.manage`. Target group provenance requires explicit operator support. An actor's kind, owner label, transport access or agent status grants no authority. Redacted collections are empty with their access flag false. Parent scope permissions stay distinct from channel permissions.

The response includes canonical active and revoked grant IDs, exact principal IDs and actor npubs, permission and timestamps; sanitized existing grant-save audit operation/time/actor and permission/principal changes; target-only direct and recursive parent group edges reaching principals in these exact grants, plus explicit reachability for granted groups; actual permission decisions with reason and matching canonical source IDs; and available build provenance. It returns no message/document/file bodies, arbitrary metadata, keys, group rosters, grants on sibling channels or other workspaces. Historical audit changes describe requests at the time, not a reconstructed before/after diff; a missing old event is not proof no save happened. Missing build values mean provenance was not configured.

`limit` defaults to 100 (1–100); `offset` defaults to 0 (0–10000). Grants, audit and group provenance and grant-group reachability each have independent `items`, `limit`, `offset`, `truncated` and `next_offset`. Continue while the relevant collection is truncated. Grant ordering is created time/ID ascending; audit is descending; group provenance uses source/group/child. A response is one repeatable-read database snapshot, but subsequent pages can see changes. The fixed decision list and matching sources are not paginated. Audit permissions accept only known permission names and at most 64 entries, with explicit truncation. Unknown query fields and repeated query parameters are rejected.

Every successful read persists a `permission_diagnostic.read` audit receipt before response emission; audit failure prevents the report. The receipt contains only case, actual signer, resolved user, target actor, access mode and pagination. Responses use `Cache-Control: private, no-store`.

## Temporary operator support delegation

Support is disabled by default. No HTTP field can enable it. An authorized operator may provision the fixed file `config/permission-diagnostics.json` relative to the Tower service working directory (Docker: `/app/config/permission-diagnostics.json`). The file is Git-ignored and must never be committed or copied from unrelated local configuration. Provision it only in the explicitly authorized isolated deployment stage or read-only mount.

```json
{
  "version": 1,
  "authorizations": [{
    "case_id": "support-case-example",
    "signer_npub": "<actual NIP-98 signing npub>",
    "target_actor_npub": "<diagnostic target npub>",
    "tower_service_npub": "<expected workspace Tower service npub>",
    "app_npub": "<expected workspace app npub>",
    "workspace_id": "<exact workspace UUID>",
    "scope_id": "<expected parent scope UUID>",
    "channel_id": "<exact channel UUID>",
    "issued_at": "2026-01-01T00:00:00.000Z",
    "expires_at": "2026-01-01T01:00:00.000Z"
  }]
}
```

Use real checksum-valid lowercase npubs, canonical lowercase UUIDs, and exact ISO UTC timestamps with milliseconds. Every binding is mandatory; unknown fields or malformed entries invalidate the whole support configuration. Maximum 20 entries, 32 KiB file, 24-hour lifetime per entry; choose a much shorter incident window. Future-issued or expired entries cannot authorize. Case IDs use letters, digits, period, underscore and hyphen, maximum 80 characters, starting alphanumeric. The actual signer must match, even when a workspace key resolves to a different user. Workspace membership and active resource checks still apply. Moving the channel to another scope invalidates support access.

The file is reloaded on every request. Support grants read of only the exact channel ACL metadata, its bound parent scope ACL metadata, and only the named target's group paths reaching these grant principals. It confers no content access, normal grant-read authority or write authority on any other endpoint.

Deploy committed source using the verified deployment broker and an isolated release stage. Add only the reviewed incident file to that stage; preserve remote environment, database and volumes. Do not use an environment-replacing deployment payload to append settings. Record source commit/build provenance through existing supported deployment metadata. Review the stage contents before deployment. Sign the diagnostic request as the authorized signer; check receipt and all truncation fields before drawing a conclusion.

Remove the file after the case, or replace it with an empty authorizations list and deploy the same reviewed source without delegation. A mounted file can be removed without a restart. For an image-baked file, expiry closes access even before the cleanup deployment; remove it from subsequent images/stages and restrict retained release archives. Verify the diagnostic now denies the support-only caller and ordinary content/write/grant endpoints remain unchanged. Deployment authority and application read authority remain separate.
