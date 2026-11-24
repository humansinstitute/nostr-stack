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

**Unmetered categories (reported, never counted as zero):** Git/Forgejo repository bytes (no
repository-to-workspace byte provider), Graph (owner-npub attribution only), legacy encrypted
records and WApp namespaces. The owner summary lists them under `coverage.unmetered` and marks
the runway an upper bound (`runway.upper_bound`). Required categories (PostgreSQL and objects)
failing to measure leaves hours **pending** (never zero, never substituted by today's bytes) and
makes the reserve fail closed.

## Durable hourly peak

Sampling once an hour cannot see a delete that follows an increase, so peak capture is part
of the customer write itself, in the same transaction:

1. **Journal.** Statement triggers (`AFTER INSERT/UPDATE/DELETE`, transition tables) on every
   billable table append the net signed byte change per workspace to `hosting_storage_deltas`.
   `v4_storage_objects` and managed objects have dedicated object-aware triggers (dedupe by path,
   size changes on completion, deletes). Triggers fire for any code path, route, job, FK cascade
   or SQL console, and roll back with the transaction. They do nothing for workspaces without an
   enrollment, and are not installed at all until `ONBOARDING_ENABLED=true` or an enrollment exists.
2. **Pre-image.** Before recording any *decrease*, the trigger stores the estimated total before
   the statement (`latest anchor + deltas that anchor did not see`, an MVCC snapshot test) in
   `hosting_storage_observations`. A delete therefore cannot erase the peak it removes from.
3. **Anchors.** Each hour the runner measures the workspace exactly (REPEATABLE READ) and stores the
   level with its `pg_snapshot`. A UTC **boundary total** is the first anchor taken at/after the
   boundary minus the journaled deltas after the boundary that the anchor saw; boundaries are immutable.
4. **Peak.** `peak(hour) = max(total at hour start, total at hour end, every pre-image inside the hour)`.
   Between decreases the total only rises, so this is the true maximum of the stored total.
5. **Settlement.** An hour settles five minutes after it closes, in one transaction: lock the
   account row, recompute from the immutable evidence, insert the unique `storage_peak` ledger
   entry (`storage-peak:<workspace>:<hour>`), update balances and write `hosting_storage_hours`
   (primary key workspace+hour). Concurrent workers, retries and restarts therefore debit once.
   Missed ticks are recovered from the journal and a later anchor; nothing is back-filled from
   current bytes without that evidence.

Evidence retained per hour: start/end boundary totals, observed pre-image peak, peak,
billable bytes, due/charged/uncollected units and the basis version. Redundant journal rows
(already seen by the latest anchor and older than the latest boundary) and settled pre-images are pruned.

### Write and delete path inventory

| Path | Captured by |
| --- | --- |
| Any INSERT/UPDATE/DELETE on a billable table (HTTP routes, jobs, FK cascades, admin SQL) | statement triggers |
| Object prepare/complete/size change/delete (`v4_storage_objects`, `pg_workspace_id`) | object triggers |
| Managed object completion and `physical_absent` after confirmed S3 delete | managed-object trigger |
| Objects attributed only by reference (no `pg_workspace_id`) | **anchors only** (hourly); an in-hour create/delete is not seen |
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
