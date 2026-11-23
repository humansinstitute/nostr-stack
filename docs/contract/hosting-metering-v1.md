# Stored workspace metering and allocated billing

NStack persists hourly workspace storage evidence, charges explicitly allocated
owner-funded workspace credits at a recorded rate, and exposes stored usage and
ledger-backed costs. This is prepared source, disabled by default. Installing the
schema does not enroll any workspace, insert a rate, grant credit or transfer funds.
The superseded report API activation does not authorize this feature's activation.

## Boundaries and activation

`HOSTING_WORKSPACE_BILLING_ENABLED=true` gates all new financial mutations and the
embedded minute runner. Legacy `SUPERBASED_BILLING_MODE` must be disabled; the
service refuses new mutations in the older credit mode. No currency conversion
exists. Exact existing USD units remain: 144000000000 units per USD. There is no
new payment processor, default tariff, promotional grant or automatic enrollment.
Stripe and old account payment behavior remain unchanged.

The current workspace owner explicitly enrolls using an existing hosting account.
If the workspace already has a v1 account link, enrollment requires
`confirm_v1_transition:true`. Enrollment atomically creates the v2 workspace wallet
and schedule, taking effect at the next full UTC hour; the old link and all history
remain. Wallet presence plus enabled_at is the durable v2 mode boundary. Both the
v1 runner query and its account-locked audit exclude v2 hours. Enrollment takes
the same account lock. A database BEFORE INSERT/UPDATE trigger on
`hosting_usage_hours` rejects audit rows at or after the enrolled cutover with
`hosting_v1_workspace_cutover` (SQLSTATE 23514). The unchanged pre-cutover v1
transaction writes that row after its account and ledger updates; rejection rolls
back the entire transaction. The trigger takes the account lock and then reads the
committed wallet boundary, including when an old transaction waited behind enrollment.
An old runner may abort its tick on this error; draining old runners remains advised
for progress, but is not the double-charge safety guarantee. Earlier v1 hours and
unenrolled workspaces retain v1 behavior. A transaction failure leaves the prior mode.
Enrollment recomputes the next full UTC hour after account/ownership locks; rate
append validates the future effective hour after its serialization lock. Production
uses a fresh wall-clock read there, not a timestamp captured before the wait.
Allocation samples decision time after both account and wallet locks, before either
promo expiry is processed. Settlement samples after its workspace/wallet locks;
the same instant governs promo eligibility, current UTC hour and depletion. Runners
pass a clock rather than freezing tick-start time for financial decisions. Legacy
account expiry and settlement follow the same post-lock rule. Explicit Date
overrides remain supported for historical fixtures.
Disabling the rollout flag stops v2 processing and mutations; it never resumes v1
charges for a transitioned wallet, deletes evidence or converts money.

Funding explicitly moves an exact positive amount from the owner's existing pool
to this workspace allocation. It locks account then wallet, checks current ownership,
requires sufficient net source credit, and persists two matching scoped ledger
entries atomically. No other workspace allocation can be spent. Identical retries
return the original funding result; changed amounts conflict. There is no automatic
sweep or conversion of existing pooled/legacy credit. Initial enrollment is zero
funded; unavailable measurement alone does not mark exhaustion.

Promotional funds transfer first, then paid funds. The original promo expiration
follows the allocation: it cannot become paid credit or receive a new expiry.
Expired pool/wallet promo is audited on mutations, while GET merely calculates its
current display availability. Paid credit does not expire. Workspace samples spend
promo then paid; unfunded valid charges may make the workspace paid balance negative.
Exhaustion blocks that workspace's writes at the existing shared routing boundary,
with an informational 21-day grace and no automatic deletion. Explicit funding
restores writes when the allocation becomes positive. Other workspace allocations
are unaffected. The account-wide existing payment/grant APIs can fund the owner
pool; a separate explicit allocation is required to fund a workspace.

## Stored measurement policy

Every immutable snapshot retains workspace scope, partial-attributed coverage,
period start/end, actual capture time, recording time, measurement version, status
and evidence. Internally it also records owner actor and matching existing account;
these financial identities are excluded from all public workspace snapshot reads.
Owner/account association reflects identity observed during collection, never an
invented historical payer. Owner changes fence allocation and settlement. They do
not assign former-owner money to the new owner: reconciliation/re-enrollment is an
explicit follow-up, and former-owner account access is fenced on workspace routes.
Historical workspace costs remain workspace facts, subject to current workspace ACL.

`stored-columns-accounting-excluded-v1` reuses the bounded repeatable-read read-only
collector from [workspace storage v1](workspace-storage-v1.md), excluding `hosting_*`,
`workspace_credit_*` and `workspace_usage_hourly_audits` tables to prevent accounting
feedback. The subtotal adds stored PostgreSQL column bytes and completed object
metadata bytes with integer arithmetic. Metadata/history metrics are subsets,
not extra bytes. Shared object paths count once in **each retaining workspace**,
including workspaces with the same payer. This is partial attributable storage,
not physical disk usage or provider billing. All collector budgets/exclusions remain.

This policy differs from v1's logical JSON billing basis. Existing customers retain
v1 unless explicitly transitioned. No query substitutes new measurements for old
accepted usage or reprices historical charges.

The embedded producer holds a reserved-connection singleton Postgres advisory lock
across collection/persistence. At most 64 due workspace schedules and 24 hours per
workspace are processed each tick; current completed schedules cannot starve other
workspaces. Unique workspace/hour slots and immutable triggers preserve terminal
outcomes. A crash before insert can recollect only the still-current hour. Past hours
become missed, never current-byte backfills. A collection crossing its UTC hour,
query failure, missing measurement, unsupported coverage or bound failure records
unavailable with null bytes. Initial partial hours are unbilled. Failed terminal
slots cannot later be replaced with a fabricated zero or later evidence.

## Rates and settlement

Only platform `ADMIN_NPUB` may append rate facts. A rate names a unique version,
measurement policy, future full UTC effective hour and exact numerator/denominator
in existing units per covered byte-hour. Both precision integers are at most 10^18;
no floating point arithmetic is used. Changes must append after the latest configured
rate. Identical version replays are safe, conflicting content fails, and rows cannot
be updated/deleted. No rate is automatically inserted. The former coded tariff is
an existing v1 fact, not authorization to insert a new v2 rate.

Each full UTC period uses one contemporaneous sample for 3600 seconds. It is hourly
sample billing, not time-integrated occupancy. Charge is
`floor((covered_bytes * numerator + prior_remainder) / denominator)`.
The exact residual is retained per workspace/rate version, bounded below that rate's
denominator. A new version starts its own carry; old residuals remain auditable and
are never silently converted or retrospectively rounded into a debit.

Settlement locks the workspace wallet and atomically persists the wallet update,
carry, ledger row and immutable settlement referencing snapshot UUID, rate UUID and
3600-second duration. Unique snapshot debit and workspace/hour constraints plus
idempotent lookup prevent double charges across replicas/restarts/retries. The
ledger's `balance_scope` distinguishes existing owner-pool entries from workspace
allocation entries; amount and after-balances always apply to that scope. Existing
rows default to account scope. A funding transfer is debit in account scope and
credit in workspace scope, not two storage charges. The ledger itself is append-only.

No contemporaneous measurement, missing rate, initial partial hour, prior-hour late
settlement, owner mismatch or unavailable evidence means no debit and null cost.
These outcomes are retained, not invented zero-cost samples. A real measured charge
can round to zero whole units while retaining its exact fractional carry. Old valid
unsettled evidence is not backcharged later; delayed settlement records missed.

## Authenticated API

All endpoints are under `/api/v4/hosting-billing/workspaces/{workspaceId}`.

| Method/path | Result and authority |
| --- | --- |
| GET `/metering?limit=50` | Stored snapshots, read as_of, freshness and next_measurement_at; existing account owner/current workspace manage |
| GET `/costs?limit=50` | Exact ledger-backed workspace settlements, rate versions and configured rate facts; same workspace authorization |
| POST `/enroll` | Current workspace owner; `{confirm_v1_transition:boolean}`; explicit next-hour enrollment, no grant |
| POST `/allocate` | Current workspace owner; `{amount_units:string,idempotency_key:string}`; explicit existing-credit funding |
| POST `/rate` | Platform administrator only; `{version,effective_at,numerator,denominator}`; future immutable rate fact |

Mutations require strict NIP-98 exact URL, method and raw-body SHA256. Body shapes
are closed. Amounts and rational terms are decimal strings. Costs retain status,
snapshot ID, period, duration, exact rate version and ledger reference. All GETs use
SELECTs only, never scans, account creation, expiry writes, enrollment or charges.
`as_of` means read time; `captured_at` and evidence `as_of` retain actual metered time.
`next_measurement_at` is a schedule target, not a guarantee; null means unscheduled.
Freshness is current only for a successful current UTC-hour measurement.

Only the current matching owner sees the workspace wallet balance on `/costs`.
Managers/agents see usage and costs, no wallet balance, owner pool identity,
pooled balance or other-workspace samples. Workspace `/status` and `/ledger` also
narrow manager fields, omitting account after-balances, personal expiry, shared burn,
runout, reasons and actor identities. Manager `/ledger` includes only v1 `usage`
and v2 `workspace_usage`, never allocation receipts or promo-expiry movements.
Manager `/usage` explicitly projects workspace_id, hour, status, bytes and debit_units;
it never forwards account identifiers or arbitrary nested evidence. These restrictions
also apply to delegated agents and former owners who retain workspace.manage. Owners retain existing account-scope ledger views (workspace-scope rows are excluded from that legacy account ledger response); new
workspace cost information comes from `/costs`. Role grants remain server-side;
ambient napplet visibility is not billing mutation authority.

No napplet adapter or metric carrier timestamps change here. A later adapter should
reuse the generic metric envelope after agreeing capture/read time representation,
label display precision and exclude all global balances. A host build is not required
merely for new compatible metric IDs.

## Validation and rollout limits

Synthetic disposable PostgreSQL tests cover migration replay, singleton work,
immutable slots, accounting exclusions, concurrent allocation and settlement,
old/new charge exclusion, ledger conservation, injected rollback, rate history,
carry versioning, promo expiry, ownership/agent permissions, exhaustion and stored
reads while source tables are exclusively locked. No production evidence is exported.
Shared-runtime rebuild/smoke and activation remain the supervising manager's review
and current approval responsibility. Snapshot retention intentionally prevents
workspace hard deletion until an explicit financial-evidence retention policy exists.

Manager legacy status measurements use only workspace_id, hour, status, bytes and
debit_units, matching manager usage. Raw legacy evidence is never forwarded in
manager status, including delegated agents and former owners with workspace.manage.
