# Channel artefacts v1

Rich channel artefacts reuse ordinary Files and their immutable versions. Written documents remain Docs. A Canvas is an optional reference/view of the same source, never an access grant or a second copy. This contract introduces no catalogue table, no new record family and no destructive migration.

## Identity and classification

The stable rich artefact identifier is `file.id`; channel, scope and workspace come from the File. Content revision is `current_version_id` and immutable version UUIDs. Metadata edits use File `row_version`; content edits use `base_version_id`. These clocks are separate.

New builtin rich Files should carry this descriptive metadata:

```json
{
  "artefact": {
    "schema_version": 1,
    "type": "excalidraw",
    "format_version": 1,
    "editor_id": "builtin.excalidraw",
    "template_id": "blank",
    "style_id": "default"
  }
}
```

`type` is `html` or `excalidraw`; the matching editor is `builtin.html` or `builtin.excalidraw`. Template/style IDs are optional. Registry ownership and editor/template/style approval belong to the application. NStack preserves metadata as JSON; it does not load plugins, fetch editor URLs, validate application templates, or grant execution from metadata. Unsupported future schema/format/editor IDs must not activate arbitrary code. Presentations and spreadsheets are deferred until working approved editors exist.

The current stored object's media type is authoritative for the server's `artefact_type`: `text/html` or `application/xhtml+xml` maps to `html`, and `application/vnd.excalidraw+json` maps to `excalidraw`. Comparisons ignore case and MIME parameters. Other media types map to null. This keeps existing Files discoverable without metadata rewrites. Clients may recognize existing descriptive markers for legacy navigation, but must validate the actual format before editing/execution. A metadata/MIME mismatch never grants executable authority.

## Discovery and direct reads

All paths below are under `/api/v4/flightdeck-pg/workspaces/{workspaceId}` and require existing NIP-98 workspace/app context.

- `GET /channels/{channelId}/files` adds per-File `content_type` and `artefact_type`. Optional `?artefact_type=html|excalidraw` filters in the database before `limit`. Invalid filters return 400. Existing archived and text attachment lineage filters compose with it. Requires existing `file.read` or `channel.read`. This existing limited list still returns `next_cursor:null`; it is not a new paginated catalogue.
- `GET /files/{fileId}` adds `file.content_type`, `file.artefact_type`, and `file.can_write`. Existing current storage-link authorization remains. `can_write` is a current-viewer hint, false on archived Files; every mutation independently rechecks authorization.
- `GET /files/{fileId}/versions` remains the immutable revision metadata list.
- `GET /files/{fileId}/versions/{versionId}/object` remains the authenticated exact-version bytes route, with workspace partition, File/version ownership and digest verification. Private responses are not anonymously publishable.
- `GET /files/{fileId}/html?version_id={optionalVersionId}` exposes the existing Canvas HTML resolver independently of Canvas membership. The path ID must be a File UUID, not a legacy version UUID. It requires channel `file.read` before version/byte projection and returns one neutral `404 file_html_unavailable` for denied, missing, invalid, archived, non-HTML or foreign sources. `version_id` must belong to that same File. Omission follows current content; browsing does not change saved state. The response is private/no-store.

Direct HTML response matches the Canvas HTML response without `naplet_id`:

```text
{ identity, workspace_id, title,
  source: { type: "html", id: fileId, version_id: null },
  content: { html, version, digest, file_id, version_id, version_number,
    current_version_id, current_version_number, follows_latest,
    assets, manifest_error },
  versions: [{ id, version_number, created_at, created_by_actor_npub,
    content_type, size_bytes }] }
```

`versions` contains at most 200 newest retained non-deleted versions. `content.follows_latest` describes the source policy; explicit historical browsing can return an older `content.version_id` while the source policy still follows latest.

HTML and its optional `wingman-artifact-assets` manifest use the existing limits and validation in `flightdeck-pg-html-artifacts.ts`. Every asset names an exact File/version/SHA-256 and is independently reauthorized. A denied asset is only `{name,status:"unavailable"}`. No host fetch, signer, credential, same-origin privilege, anonymous URL, or data bridge is supplied. Clients must render in a sandbox permitting only intended interaction and must not grant same-origin access. Canvas and direct views use the same resolver and private byte routes.

## Create, revise and recover

Use existing storage prepare/upload/complete and `POST /channels/{channelId}/files` to create a rich File, including descriptive metadata. Store Excalidraw source JSON with its canonical MIME type and HTML source as HTML. Assets are ordinary Files addressed by immutable versions. Keep Docs on their established create/edit routes.

Use `POST /files/{fileId}/versions` with `{storage_object_id,base_version_id,summary?}` to save. Under the existing File row lock, only a matching current base creates a revision. A stale base returns `409 stale_base_version` with current metadata; clients must show a conflict and preserve the unsaved edit, never silently overwrite. Historical bytes remain available for revision browsing and recovery; restoring old bytes creates a new version against the current base. Existing File metadata PATCH uses `row_version` and preserves unrelated metadata. Content and metadata edits do not replace each other's clocks.

AI helpers should use the same storage/File routes, read exact source bytes plus the current base before editing, retain the File identity on updates, and obey the same conflict and permission rules. Creating or editing a Canvas is not required to author a File.

## Personal pin and open semantics

`PUT /me/pins/file/{fileId}` extends the existing private CAS pin contract:

```json
{"pinned":true,"expected_row_version":0,"mutation_id":"<uuid>"}
```

A new pin requires channel `file.read` on an active, unarchived File in this workspace. The canonical pin has `resource_type:"file"`, `resource_id:fileId`, `root_record_id:fileId`, `thread_id:null`, and the source's `channel_id`/`scope_id`. Normal pin errors, immutable retry receipts, conflict protection, actor-only SSE and `personal_pin` delta recovery apply. `file` is also accepted by the existing private pin-order route. Unpin remains possible after a target becomes unavailable; a pin never grants read permission or publishes content.

Opening a File pin, chat File link, channel entry or Canvas source resolves the same File UUID through its normal read route. Historical viewing selects a version locally and does not mutate the pin. Shared Doc pins continue to use `document`. Existing thread/task/document/channel pins and import behavior remain unchanged.

## Compatibility and validation

The additive `file-pins-v1.sql` widens the existing personal pin check constraint. Bootstrap and runtime schema paths both apply it; historical rows, receipts and journal entries are retained. No object, File, Doc, Canvas or pin IDs are migrated.

Regression coverage must exercise legacy MIME discovery, filter-before-limit, denied reads, independently denied HTML assets, direct historical reads and foreign-version rejection, stale content writes, private File pin recovery, pin CAS races and unavailable unpin. Rebuild the local NStack runtime before running repository validation, then verify live health/source build separately from in-process disposable-database suites.
