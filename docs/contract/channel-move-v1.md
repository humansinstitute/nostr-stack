# Channel relocation v1

Tower relocates an ordinary channel between active scopes in one workspace without changing its ID or its contents. Clients preview the change, show the access summary and warnings, and confirm with the returned token. Clients apply authoritative record-sync updates through their normal materialization service; they must not optimistically rewrite channel or child scope IDs.

## Endpoints

Both routes require NIP-98 and the normal Flight Deck PG workspace context. The existing notification-only agent ceiling applies unchanged.

`POST /api/v4/flightdeck-pg/workspaces/:workspaceId/channels/:channelId/move-preview`

```json
{"destination_scope_id":"<uuid>"}
```

The response includes the normal `identity` envelope and:

```json
{
  "preview": {
    "channel_id": "<uuid>",
    "source_scope_id": "<uuid>",
    "destination_scope_id": "<uuid>",
    "confirmation_token": "<opaque uuid>",
    "access_changes": {
      "gained": [],
      "lost": [],
      "retained": [{"actor_id":"<uuid>","npub":"<npub>","label":"<display name>","permissions":["channel.read"]}],
      "direct_grants_preserved": true,
      "direct_grant_count": 1,
      "unchanged_direct_grants": [{"id":"<grant uuid>","principal_type":"actor","principal_id":"<actor uuid>","permission":"channel.read"}],
      "source_scope_access": [{"actor_id":"<uuid>","npub":"<npub>","label":"<display name>","permissions":["scope.manage"]}],
      "destination_scope_access": []
    },
    "warnings": ["Scope grants control scope discovery and management; they do not grant inherited channel content access. Explicit channel grants, including group grants, remain unchanged.", "The channel will appear under the destination scope. Existing links and content IDs remain unchanged."]
  }
}
```

`POST /api/v4/flightdeck-pg/workspaces/:workspaceId/channels/:channelId/move`

```json
{"destination_scope_id":"<uuid>","confirmation_token":"<preview token>","mutation_id":"<client-generated uuid>"}
```

The response contains `identity`, the normal serialized `channel`, `move: {source_scope_id,destination_scope_id,mutation_id}`, `audit: {event_id,operation:"channel.move",actor_npub}`, and `outbox: {id,row_version}`. `channel` retains its existing transport shape, including the legacy constant `row_version:1`; confirmation freshness uses the actual database row revision, not that transport constant.

## Access and confirmation

Both preview and confirmation require all of:

- `channel.manage` on the moved channel;
- `channel.grants.read` on that channel, because preview discloses access details;
- `scope.manage` on both source and destination scopes.

Permissions remain exact resource grants. Scope grants do **not** confer inherited `channel.read`, message, task, document or file access. Consequently `gained` and `lost` are empty under the current authority model. `retained` resolves existing channel permission grants for each workspace actor, including nested group membership. `source_scope_access` and `destination_scope_access` describe the scopes' distinct discovery/management access, not inherited channel content permissions. Do not translate these lists into grants on the moved channel.

`direct_grant_count` counts active grant rows (one permission per row), including group grants, rather than distinct principals. `unchanged_direct_grants` preserves each row ID, principal and permission. A grant's non-null denormalized `resource_scope_id` moves to the destination; a null field remains null. Revoked grant rows retain their revoked status.

Tokens expire after 15 minutes and bind workspace, channel, exact requester, source/destination scope state, channel revision and workspace authority state, including grants, memberships and nested group edges. A changed preview must be fetched and reviewed again. Content-only writes that preserve channel and access authority can finish before the move and are included in the transaction.

A successful move is recorded by workspace-scoped `mutation_id`. Reusing that ID with a different actor, channel, destination or confirmation token conflicts. Exact retries recheck current permissions and return the original move/audit receipt with the **current** serialized channel. If the channel has since moved elsewhere, the retry returns `409 move_superseded` with no stale channel to materialize. Expired preview tokens do not prevent an otherwise authorized exact successful retry.

## Preservation and concurrency

The migration makes scope-bearing typed foreign keys deferrable, initially immediate. Only the relocation transaction defers checks. It updates the channel and every installed `flightdeck_pg_*` base family containing `workspace_id`, `scope_id` and `channel_id`, then validates all constraints before committing its audit/event/receipt. This includes archived/deleted content and historical location columns; bodies, metadata, immutable content snapshots, timestamps, version numbers and attribution remain unchanged.

Included families cover threads and branches, messages, tasks, assignments, watchers and comments, docs and versions/recovery versions/comments, file folders and files, storage links, audio notes, daily notes and versions, personal WApps, reactions, resource-view states, invocations, agent activities/notifications, workrooms/events/links, approvals, WApp destinations/activity items, private pins, and existing outbox location columns. File versions refer to stable file IDs and need no location rewrite. Workspace canvases, naplets, Excalidraw/HTML file references and scope-owned context references keep their existing ownership and stable target IDs; moving a linked record does not move its referring canvas or context component. Storage objects and bytes are unchanged.

Authority tables are briefly locked against writes, scope rows lock in UUID order, and the channel locks `FOR UPDATE`. Ordinary writers retain immediate FK checks. A canonical location trigger also locks the channel `FOR KEY SHARE` for scope/channel rows in additive families without composite FKs. Old-location writes either commit before relocation and are included, or fail safely after it; no half relocation can commit. Row/version-bound work receipts are preserved unchanged because relocation changes location only, never the receipted content version. Other concurrent conflicts and deadlocks become retryable `409` responses.

The authority table lock serializes this rare management operation across workspaces. This favors correctness over parallel relocation throughput; it does not lock out ordinary channel reads.

## Sync and events

Normal per-family record triggers emit relocated channel and child rows. Tower also reprojects source and destination scopes and advances additive access revision without changing the authority epoch. A channel-only reader can therefore discover the newly visible containing scope on its existing cursor. Visibility loss follows the existing retained-cache policy, not synthetic content deletion.

`channel.moved` is a channel-authorized outbox/SSE event with entity type `channel`, operation `updated`, and payload `{channel_id,source_scope_id,destination_scope_id,mutation_id}`. It contains no content body. Source-scope readers receive `scope.channels_changed`, entity type `scope`, payload `{scope_id,invalidate:true}` with no channel ID or content. Existing event visibility checks continue to filter content families by their specific channel permissions. Historical event and notification payloads are preserved; canonical IDs still resolve current placement.

## Errors

| HTTP | Meaning |
| --- | --- |
| 400 | Malformed/missing UUID, malformed JSON or unexpected field |
| 401 | Invalid NIP-98 authentication |
| 403 | Required management or grant-disclosure authority missing |
| 404 | Channel or destination scope absent from this workspace |
| 409 | Stale/expired preview, superseded/reused mutation, concurrent conflict, duplicate destination name, same destination, or unsupported channel/scope |

Archived channels/scopes, default channels, kind `dm`/`system` channels, channels marked by nonempty `metadata.system_key`, participant-bound channels and scopes of kind `dm` cannot move. Other persisted scope kinds remain supported. Names are unique per scope, including archived channels. Errors include readable `error`, machine `code`, `status`, and `identity`; clients should display the reason and refresh as appropriate.

## Verification

`tests/flightdeck-pg-channel-move.test.ts` uses signed Hono API requests against a freshly migrated disposable Postgres database, plus canonical service/record-sync reads. It checks access, stale tokens, atomic rollback, concurrent writers/moves/retries, all seeded family projections and content preservation. The supervising deployment run must still rebuild/restart local Tower and run the full runtime checks under repository instructions.
