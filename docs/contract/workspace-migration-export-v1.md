# Workspace migration export v1 (read-only; not a backup)

A bounded, paged, read-only export of what the signed-in workspace member can currently read, for the 30-day free read-only
migration window. It is **not** an owner-wide dump, an offline recovery copy or a restore path. It fails rather than reporting a
partial export as complete.

All routes are under `/api/v4/hosting-billing/workspaces/{workspaceId}/migration-export` (registered outside the Flight Deck PG
write boundary, so they work while the workspace is read-only for insufficient funds). Mutations need a direct user signature.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `` | Open a session (any member). Pins the committed record clock (position, epoch, access revision). Max 3 open per member and workspace; expires after 7 days. |
| GET | `/{exportId}` | Progress; once finalized, the stored outcome (manifest). Only the session's member. |
| GET | `/{exportId}/page?section=&cursor=&limit=` | One page of `records`, then `content`, then `history`, then `assets`. |
| POST | `/{exportId}/finalize` | Close the session. `200 {manifest}` only when complete, otherwise `409 export_incomplete` with the same manifest. Idempotent. |

## Authority

Every page first takes the workspace clock share lock and fails `409 export_invalidated` (before reading data) if the
workspace authority (epoch or access revision) changed since the session opened; replay of an earlier page is no capability.
It also re-checks current membership and uses the existing record-sync visibility rules (channel/doc/file/task grants, personal
rows only for their owner) for each record. History rows are those of an exported parent and carry the parent's authority. Asset
bytes must be readable by the same member under the existing storage contract
(`resolveReadablePrivateStorageObject`, the gate of `GET /api/v4/storage/{id}/content`). Hidden rows are never counted or hinted.
Billing-account ownership confers nothing here: an owner exports what the owner can read.

## Sections

1. `records` — the 22 record-sync families plus personal pins, as `{kind:'record', family, id, position, row}` from the current
   projection, keyset-ordered by `(family,id)`. Deleted rows are not present (tombstones are not exported).
2. `content` — customer content that is not a record-sync family, as `{kind:'table_row', table, key, row}`, each table filtered by
   the rule of its own existing read route (`src/services/workspace-export-adapters.ts`): `reactions` (channel.read of the
   reaction's channel), `task_watchers` (task.read), `workrooms` and their `workroom_participants`/`workroom_events`/`workroom_links`
   (channel.read of the workroom's channel), `approvals` (a workroom approval with that channel; any other target needs
   workspace.manage), `invocations` (channel.read, or the creator, or a named recipient), `agent_activities` (lease internals
   omitted) and their commentary (channel.read), and `canvases`, `canvas_elements`, `canvas_naplets` (the canvas visibility rule:
   workspace mode, listed principals, creator or workspace.manage, exactly as `GET /canvases`) plus the member's own
   `canvas_orders`, and `org_data_types`/`org_data_records` read through the org-data service itself (permission grants, the type's
   members/admins access and reference redaction; a member without `org_data.read` receives nothing). Soft-deleted rows are not delivered. Each row's parent references are recorded so a child whose parent was not
   delivered is reported as a broken relationship.
3. `history` — `doc_version`, `doc_recovery_version`, `file_version`, `daily_note_version` rows of every exported parent
   (`{kind, row}`); parents deleted or not delivered contribute nothing, matching the existing ACL for retained versions.
4. `assets` — every distinct storage object referenced by an exported row (`storage_object_id`, `head_storage_object_id`,
   `metadata.attachments[].storage_object_id`), with up to 20 references and a verified `status`: `verified`, `missing_metadata`,
   `workspace_mismatch`, `upload_incomplete`, `not_readable`, `missing_bytes`, `size_mismatch`, `hash_mismatch`, `unverified`
   (too large to re-hash in a request). `verified` means the stored bytes exist, match the recorded size and SHA-256 and are readable
   by this member; bytes are then fetched from `content_path`. Nothing is written while verifying.

Pages hold at most 200 items and 1 MiB (one record may be up to 8 MiB; larger fails `413 export_item_too_large`).

## Cursors, replay and completeness chain

Progress is server-held. Send the previous page's `next_cursor` to advance (omit it for the first page). Re-sending the cursor of
the page just delivered replays it; any other cursor is `409 cursor_invalid`; a later section before the earlier one is done is
`409 section_out_of_order`. `page.digest` is `sha256` of the page's item identities joined by `\n`:
`record:{family}:{id}:{position}`, `table_row:{table}:{key}`, `doc_version:{doc_id}:{row_version}`, `file_version:{file_id}:{version_number}`,
`doc_recovery_version:{id}:0`, `daily_note_version:{note_id}:{row_version}`, `asset:{object_id}:{status}:{sha256_or_empty}`.
`progress.chain` starts at `sha256("nstack-export-v1")` and is `sha256(previous + "\n" + page.digest)`. A client that recomputes the
chain over what it received and matches `manifest.sections.*.chain` and `items` has provably received every item the server counted.

## Manifest

`version`, `scope:'actor_visible'`, `as_of` (pinned clock), per-section `items/bytes/chain`, `record_families` and `content_tables` counts, and:

- `integrity.consistent` — the committed record clock (position, epoch, access revision) at finalize equals the pinned one. A write
  during the export reports `writes_during_export`; retry (or export during the read-only window, where writes are blocked).
- `integrity.dangling_relationships` — exported rows whose parent (channel, scope, thread, task, doc, folder) was not readable and
  so not delivered (count and up to 5 child ids per edge).
- `integrity.asset_issues` — counts of non-`verified` asset statuses.
- `coverage` — `record_families`, `history_tables`, `uncovered` (every billable customer table the export does not deliver, with a
  category) and `uncovered_required`. Categories `content`, `app_data` and `git` are customer content; `derived` tables come back
  as asset references; `access` and `settings` are authority and preference state, deliberately outside a content export.
  `src/services/workspace-export-coverage.ts` classifies every billable table and a test fails on an unclassified new table.
- `status` is `complete` only when no reason applies; `incomplete_reasons` ⊆ `writes_during_export`, `dangling_relationships`,
  `asset_issues`, `uncovered_content`. `integrity.exported_scope_complete` is true when the only reason is `uncovered_content`.

**Registry, drive and app adapters (content section, each under its own route's read rule):**

| Table(s) | Rule |
| --- | --- |
| `napplets`, `napplet_releases` | The registry list rule: owner, publisher or audience member; removed installations are not delivered. Bundle bytes are not re-exported through the napplet route: they arrive via the file records only when the member can read that file. |
| `napplet_collections`, `napplet_records`, `napplet_record_versions` | The collection rule (owner, `read_npubs` or `write_npubs`) on an open installation; records only when the manifest declares `list` for that collection, their versions only when it also declares `get`; deleted records are not delivered. (These two child tables carry no `workspace_id`, so the billable-table classifier cannot see them; they are listed under `content_tables`.) |
| `napplet_installations`, `napplet_bundles` (org-data napplets) | The org-data catalogue: installed bundles with their html for any `org_data.read` member; bundle version metadata only for `napplet.install`/`napplet.publish` holders. The html of a published but uninstalled version has no read route and is not delivered. |
| `drive_shares` | The discovery rule (`GET /drive/shares`): enabled shares whose owner is still a member; `workspace` audience for everyone, `private` only for its owner. Query parity is tested against `discoverDriveShares`. |
| `app_storage_objects` | Registered-app private objects are readable only through generic canonical-owner recovery: the workspace owner receives completed objects (with bytes verified in `assets`); every other member receives nothing. |

**Known gap:** managed-app storage (`managed_*`: ciphertext chunks readable only by the delegated app's own signer, no member or owner
read route) and Git repositories (Forgejo owns them; no workspace attribution or byte/archive provider exists, see
`hosting-storage-peak-v1.md`) are still not exported, so every manifest is currently `incomplete` with `uncovered_content`; each is
listed in `coverage.uncovered_required` with its reason. `response_activities` (transient status), `channel_move_receipts` and
`agent_work_receipts` (receipts) are classified `operational`, not content: a reclassification is a one-line change. Until the
required list is empty no client may present this export as a complete exit or backup. Offline recovery (30-day encrypted copy,
support restore, expiry) is a separate, unbuilt capability; see `hosting-recovery-seam-v1.md`.

## Validation

```sh
set -a; . ./.env.example; set +a
EXPORT_TEST_PORT=<free-disposable-port> bun test ./tests/workspace-export.test.ts
```

Use a fresh throwaway PostgreSQL on a free port. Source tests prove code behaviour with in-memory object bytes; no real object
store, large-object throughput, or live workspace was exercised.
