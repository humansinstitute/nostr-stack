# Peak storage meter v1 (approved invited-onboarding policy)

Source of truth for how a customer workspace created by invited onboarding is charged for
storage and how that storage is protected from refunds and agent spending. Legacy
workspaces keep the hourly-sample meter in [hosting-billing-usd-v1.md](hosting-billing-usd-v1.md)
unchanged; nothing is re-priced, back-charged or re-enrolled.

## Tariff (exact integers)

- One decimal GB is 1,000,000,000 bytes. One month is 720 hours. US$5 per GB-month is
  **one tariff unit per byte-hour** (144,000,000,000 units per USD), so every hourly
  charge is an exact integer: there is no rounding and no carried remainder.
- Per UTC hour with `peak` bytes:
  - ordinary hour: `due = max(1 GB, peak)` units (US$5/720 minimum, proportional above 1 GB);
  - introductory hour: `due = max(0, peak - 1 GB)` units. The waiver is for the base only;
    excess above 1 GB is charged in full.
- Introduction: starts at successful paid provisioning (`provisioned_at`, the same
  transaction that marks the intent provisioned); `intro_ends_at = provisioned_at + 720 h`.
  The leading partial UTC hour is unbilled; an hour is introductory iff its start is before
  `intro_ends_at`, which yields exactly 720 introductory hours for any provisioning instant.
  Failed or incomplete setup never activates it. It is consumed once; replay is idempotent.
- No floating point anywhere (`NUMERIC(40,0)` / `bigint`); USD strings are display only.

## What is billable (basis `peak-v1`)

One explainable meter: **PostgreSQL workspace rows + object bytes**, deduplicated, per
workspace UUID.

| Category | Counted | Not counted |
| --- | --- | --- |
| PostgreSQL | stored column size (`pg_column_size` per column, so compressed/TOAST size) of every row of the billable tables in `src/services/hosting-storage-classification.ts`, including retained history/versions, soft-deleted and archived rows | indexes, WAL, free space, replicas, backups |
| Objects (S3) | completed `v4_storage_objects` attributed by `pg_workspace_id` or referenced from a billable table (including retained versions), **one count per storage path**; verified `managed_app_storage_objects` bytes until physical deletion is confirmed (`physical_absent`) | pending/incomplete uploads, provider versions, multipart debris, DR copies |
| Excluded tables | explicit, with reasons: accounting evidence, `service_replica` (record_current/heads/journal: trigger-maintained JSON copies of the entity tables, which the earlier collector counted twice), ephemeral cursors/tokens/previews, delivery queues and idempotency ledgers, operational logs | |

Every public table with a UUID `workspace_id` must be classified exactly once; a test fails when
a new table is added unclassified, so the meter cannot silently grow or shrink.

**Git is required billable customer storage and is not yet metered.** Until a real provider is
registered (`registerMeteredStorageCategory('git')`) the policy is **incomplete**: the
`storage_protection` source throws `503 storage_coverage_incomplete` (refunds fail closed), the owner
summary reports `coverage.complete=false`, `protected_is_lower_bound`, `runway.upper_bound`, and
`agent_available_units` is `0` with `admission.reason=storage_coverage_incomplete`. Graph and legacy
encrypted-record/WApp namespaces are explicitly unsupported (not billed) in this version and listed
under `coverage.unmetered` with `required:false`. Required categories (PostgreSQL and objects)
failing to measure leaves hours **pending** (never zero, never substituted by today's bytes) and
makes the reserve fail closed.

## Durable hourly peak

Sampling once an hour cannot see a delete that follows an increase, so peak capture is part
of the customer write itself, in the same transaction:

1. **Journal.** Statement triggers (`AFTER INSERT/UPDATE/DELETE`, transition tables) on every
   billable table append the net signed byte change per workspace to `hosting_storage_deltas`
   (stamped with statement time and the writer's xid). New rows are re-read from the stored heap row
   by primary key, because a transition table carries the pre-TOAST tuple (a 300 KB compressible
   value would otherwise be journaled at 300 KB while it is stored at 2 KB); old rows and the
   measurement use stored sizes. `v4_storage_objects` and managed objects have object-aware triggers
   (dedupe by path, size on completion, deletes). Triggers fire for any code path, route, job, FK
   cascade or SQL console, roll back with the transaction, are independent of the writer's isolation
   level, and do nothing for workspaces without an enrollment. They are not installed at all until
   `ONBOARDING_ENABLED=true` or an enrollment exists.
2. **Anchors.** Each hour the runner measures the workspace exactly (REPEATABLE READ) and stores the
   level with its `pg_snapshot` and a `watermark_xid` (next xid when recorded; a snapshot's own xmax is
   not such a bound).
3. **Boundary total** at a UTC hour boundary B: the first anchor A1 taken at/after B names W =
   `A1.watermark_xid`. Every transaction that journaled a row stamped before B has xid < W. The boundary
   is fixed only by an anchor whose snapshot `xmin >= W`, i.e. once all of those transactions finished;
   until then the hour is **pending** (fail closed, a fresh anchor is retried every 30 s) however long a
   straddling transaction lasts. total = anchor total minus journaled deltas stamped after B that the
   anchor saw. A negative reconstruction is journal/measurement disagreement: it is stored as
   `inconsistent` and the hour is recorded `unavailable` (no charge, reason shown), never clamped.
4. **Peak.** The hour is replayed from the committed journal in statement-time order, starting at the
   start boundary, over all categories and all transactions together: `peak = max(start, end, start +
   every running total)`. This is the simultaneous maximum, never a sum of separately peaked categories.
   A negative running total or a committed in-hour row the closing anchor did not see makes the hour
   `unavailable` (`negative_running_total` / `journal_incomplete`); the end-vs-replay `drift_bytes` is recorded.
   There is no estimate taken at write time, so a REPEATABLE READ or concurrent writer cannot under-record.
5. **Settlement.** One transaction per hour: lock the account row, recompute from the immutable
   evidence, insert the unique `storage_peak` ledger entry (`storage-peak:<workspace>:<hour>`), update
   balances and write `hosting_storage_hours` (primary key workspace+hour). Concurrent workers, retries
   and restarts debit once. Missed ticks are recovered from the journal and a later anchor.

Evidence retained per hour: start/end boundary totals, intra-hour peak, drift, peak, billable bytes,
due/charged/uncollected units and the basis version. Journal rows already seen by the latest anchor and
older than the last settled boundary are pruned.

### Write and delete path inventory

| Path | Captured by |
| --- | --- |
| Any INSERT/UPDATE/DELETE on a billable table (HTTP routes, jobs, FK cascades, admin SQL) | statement triggers |
| Object prepare/complete/size change/delete (`v4_storage_objects`, `pg_workspace_id`) | object triggers |
| Managed object completion and `physical_absent` after confirmed S3 delete | managed-object trigger |
| Objects counted only because a billable row references them (no `pg_workspace_id`) | **anchors only**; measured separately (`reference_only_bytes`) and the policy is flagged incomplete (reserve fails closed, agent spend blocked) while any exists. Modern workspace uploads always set `pg_workspace_id` |
| S3 provider-side deletion/lifecycle with no metadata change | not observable (metadata is the meter) |
| `TRUNCATE`, `session_replication_role=replica` bulk loads | not journaled; the next anchor corrects the level but not an unseen intra-hour peak |
| Git/Forgejo, Graph, legacy namespaces | unmetered (see above) |

## Exhaustion, no debt, read-only

- A debit is capped at spendable funds (promotional first, then positive purchased credit). A
  shortfall is stored as `uncollected_units` and the hour is `underfunded`; the balance never goes
  negative and **no storage debt accrues**. Negative purchased balance is explicit reversal debt and
  is not spendable.
- Funds at zero set `depleted_at`; peak-metered workspaces are then read-only through the shared
  write gate (`402 hosting_balance_exhausted`, `grace_ends_at = depleted_at + 30 days`,
  `automatic_deletion:false`). Reads, billing, checkout and exports stay available. A paid credit
  clears `depleted_at`; charging resumes prospectively with the next hour (earlier underfunded
  hours are not back-charged). Nothing is deleted automatically.

## Protection, refunds and runway

- `storage_protection` (registered at start-up in `src/index.ts`) returns, for an account, the
  **exact next-720-hour charge** at each activated workspace's current measured size, honouring the
  remaining introductory hours, summed across every linked workspace. It is therefore never zero
  merely because the base is free during the introduction. Refund routes subtract it (plus
  `agent_holds`, still unregistered, so refunds remain gated) from purchased credit.
- A workspace without a measurement makes the source throw `503 storage_reserve_unavailable`: refunds
  fail closed instead of protecting zero.
- Funded growth is never blocked to preserve the reserve. It raises the reserve and shortens the
  runway; agent admission (`admission.agent_spend_allowed`) turns false when spendable funds do not
  exceed the reserve.

## Owner API

`GET /api/v4/hosting-billing/workspaces/{id}/storage` and the `storage` field of
`GET /api/v4/onboarding/account` return exact-unit strings:

- `balances`: `purchased_units`, `promo_units`, `spendable_units`, `reversal_debt_units`,
  `protected_storage_units`, `agent_available_units` (= spendable above the reserve, 0 when in debt
  or unmeasured), `agent_holds` (`registered:false`, never presented as zero).
- `runway`: whole funded hours from the current UTC hour at the current size, `funded_until`,
  `warning_days` (30/7/1), state, `upper_bound:true`, excluded unmetered categories.
- `coverage`, per-workspace current bytes and next-720-hour units, and recent settled hours.

The shared account owner (or platform administrator) sees account balances. Workspace membership or
`workspace.manage` receives workspace scope only (no balances); billing control is never inferred
from membership.

## Gates and gaps

Git is unmetered, so reserve/refunds/agent spend stay closed by design; this task is NOT complete.

Source and disposable-database tests only; live rollout is closed (`ONBOARDING_ENABLED`, no restart,
no deployment performed). Open before launch: complete export of records, files and retained history
for the 30-day read-only window and a verified offline recovery copy/expiry are **not** part of this
slice; Git/Graph metering; peak capture of reference-only objects; production-scale trigger
overhead and anchor cost measurement; `agent_holds`.

## Validation

```sh
set -a; . ./.env.example; set +a
STORAGE_TEST_PORT=<free-disposable-port> DB_PORT=<same> DB_PASSWORD=postgres bun test ./tests/hosting-storage.test.ts
```

Use a fresh throwaway PostgreSQL; never a managed or production database.
