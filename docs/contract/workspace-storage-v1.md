# Workspace storage summary v1

The existing report supports an explicit administrative storage extension:

```http
GET /api/v4/flightdeck-pg/workspaces/{workspaceId}/workspace-report?range=7d&storage=workspace
```

Omitting `storage` preserves the exact `workspace-report-v1` response shape,
including strict existing native v2/v3 report callers. `range` and `top_n` retain
their existing activity meaning. Storage is the current retained workspace
inventory at the report's `as_of`, independent of activity dates or channel ACLs.
It is not historical cumulative upload traffic, nor a time series.

The authenticated identity must have current membership and an effective
`workspace.manage` grant in this exact workspace/application. Owner/admin roles,
deployment administration, signer capabilities and client claims do not bypass
this check. Explicitly delegated agents with that same permission can read the
summary. Without the opt-in, ordinary authorized activity reporting is unchanged.
Both app header and query identities must match the workspace.

The response adds `storage: FlightDeckPgWorkspaceStorage` (see `src/types.ts`)
with the same workspace UUID and `as_of` as its enclosing report. Groups and
metrics are bounded generic data, allowing a portable host to validate structural
limits without an allowlist of every metric. A host should ignore unknown metric
IDs, display units/method/status, and show unavailable values as unavailable,
never zero. Group IDs and metric IDs are unique within their containing arrays.
Limits: 8 groups, 32 metrics per group, 64 characters per ID/method, 16 caveats of
1024 characters each. Values are nonnegative safe integers or null; unavailable
means null. All numeric storage metrics in this version are conservative
`estimated` measurements of stored column data or recorded object metadata. No metric
currently asserts provider-confirmed `actual` bytes.

PostgreSQL metric IDs:

- `rows`: retained rows in public, nonpartitioned base tables with an explicit
  UUID `workspace_id` equal to the requested PG workspace UUID.
- `column_bytes` (`stored-column-size`): sum of `pg_column_size` on each
  individual nonnull stored field. This includes compressed and externally
  stored datum sizes without serializing JSON or detoasting composite rows.
  It is an attributable stored-column estimate, not physical disk usage.
- `metadata_column_bytes` (`stored-column-size-subset`): the same measurement
  on `metadata` fields only, a subset of `column_bytes`.
- `history_rows`, `history_column_bytes`: subsets for table names containing
  `versions`, `audit` or `outbox`. This naming convention is explicit; it does not
  claim semantic classification of arbitrary app payloads. History bytes use
  `stored-column-size-subset`.
- `tables_measured`: tables included in the row measurement.
- `physical_bytes`: null/unavailable. No `pg_database_size` or instance totals.

Object storage metric IDs:

- `objects`, `bytes`: completed `v4_storage_objects`, attributed through explicit
  `pg_workspace_id` or retained UUID `storage_object_id`/`head_storage_object_id`
  references on measured workspace tables. References are unioned and objects
  deduplicated by `storage_path`, not content hash. Repeated references and
  versions pointing to the same object do not multiply bytes. Different keys
  with identical hashes remain distinct objects.
- `pending_objects`: distinct incomplete metadata rows, excluded from bytes.
- `provider_actual_bytes`: null/unavailable. `provider_measured_at` is null.
  `last_object_completed_at` is the newest stored completion timestamp, not a
  provider measurement timestamp. Snapshot time is `as_of`.

Soft-deleted and archived rows, retained file/document versions, and recovery
references remain included. Metadata only describes recorded retained objects;
provider lifecycle changes, externally removed data, bucket-native historical
versions, multipart uploads, replication and billing are not measured. Shared
objects can be attributed to several workspaces, so workspace totals must not be
summed as instance physical usage. Managed publisher storage, shared rows without
workspace_id, legacy workspace namespaces and unattributed uploads are excluded.
No object paths, table names, credentials, content, or other workspace totals are
returned. No cloud credentials, listing, HEAD requests or separate catalogue are
required.

Queries run in the existing read-only repeatable-read report transaction with a
10-second per-statement timeout. Four extra SQL statements discover at most 256
tables (at most 256 live columns each), preflight narrow row counts, size columns,
and aggregate at most 100,000 attributed object metadata rows. Preflight counts
at most 1,000,001 rows per table and rejects a TOTAL exceeding 1,000,000 retained
rows before sizing payloads. Successful measurements therefore size at most one
million rows across all tables, under the same repeatable-read snapshot. This
replaces the original 100,000-row per-table cap; the timeout is unchanged. Discovery/row/object excess fails with
`503 report_too_large`; missing schema, timeout, unsafe counts or conflicting
sizes for one object key fail with neutral `503 report_unavailable`. No partial
summary or fallback zero is returned. There are no per-channel/entity/provider
queries. SQL table identifiers come only from the database catalogue and are
quoted; workspace IDs remain bound parameters.

No migration is required. Activate the backend through the normal approved
NStack source deployment; source validation does not activate the shared runtime.
Rollback is the previous backend image/source and omission of `storage` by the
client. This change performs no data writes and requires no data rollback. A
portable host capability/parser update is required before opting in from strict
existing hosts; publishing a napplet alone does not change host validation.

## Relationship to the console usage collector

The existing `/storage-usage` response and its cached collector in
`src/services/workspace-storage-usage.ts` retain their existing meaning and
behavior. That collector measures direct `flightdeck_pg_*` UUID-owned rows,
object references named `storage_object_id`, and a partial covered subtotal in
independent transactions with a 60-second cache. Its result cannot supply the
report's single-snapshot row/history breakdown or the same `as_of` timestamp.

This versioned report extension measures stored column datums in all qualifying public workspace-UUID
base tables, additionally includes `head_storage_object_id` recovery references
and explicitly workspace-attributed uploads, and fails closed on incomplete
queries. Consequently its logical row and object estimates can differ from the
console's covered subtotal. Neither is a physical disk measurement or a provider
invoice. Do not substitute this extension for hosting/billing accounting or add
its totals to console categories. No billing, console collector, or existing
storage-usage route is changed by this extension. Any future consolidation must
preserve those contracts and separately review measurement scope changes.

## Measurement revision and examples

The envelope is unchanged. Current metric IDs replace the initial unactivated
`row_json_bytes`, `metadata_json_bytes` and `history_row_json_bytes` methods;
those JSON-serialization estimates were too expensive for a real workspace.
`tests/fixtures/workspace-storage-v1.json` remains a historical generic-envelope
example. `tests/fixtures/workspace-storage-columns-v1.json` is the current,
fully synthetic stored-column example. Generic hosts accept both; cartridge
labels should call the current PostgreSQL section "Stored-column estimate".
No host metric allowlist or new host build is needed for metric ID evolution.

Stored datum bytes include PostgreSQL compression, and out-of-line values count
their represented stored size rather than only a TOAST pointer. They exclude
heap tuple headers, alignment, page slack, indexes, TOAST chunk/container overhead,
WAL, dead MVCC versions, free space and backups. These exclusions mean the sum is
neither exact physical workspace disk nor an uncompressed logical JSON size.
See PostgreSQL's [database object size functions](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE)
and [TOAST storage](https://www.postgresql.org/docs/16/storage-toast.html).
