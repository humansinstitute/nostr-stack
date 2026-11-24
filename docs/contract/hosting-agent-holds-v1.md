# Paid agent holds v1

Source contract for the hosted agent runtime (`wmcloud`) to reserve, dispatch, settle and release paid model
calls against an NStack hosting account. Disabled by default. No tariff, model or rate is approved or inserted
by this software; with no operator-appended tariff every reserve is refused.

## Principles

- **Reserve before inference.** No upstream call without an admitted hold.
- **Payer authority, not membership.** A hold is admitted only under an explicit grant signed directly by the
  paying account owner, bound to the exact `payer / account / workspace / agent / runtime service / model /
  tariff version`. A globally allowlisted runtime host cannot spend another host's grant.
- **No client dollar amounts.** The runtime sends token counts and bounds; NStack computes units from the frozen
  tariff version named in the grant.
- **Unknown is not free.** Only `never_dispatched` (NStack has no dispatch record) or an allowlisted explicit
  provider rejection may release. Everything else stays held as `pending_reconcile` until a settlement with
  host-observed usage arrives. There is no timeout release.
- **Storage first.** Admission uses `agent_available_units` from the account storage summary (spendable funds
  above the next-720-hour storage protection, minus every open hold). Incomplete storage coverage (today: Git)
  means every reserve is refused (`storage_coverage_incomplete`). Nothing fakes coverage.

## Units

- 1 USD = `144_000_000_000` units (NStack ledger) = `10^12` pico-USD (runtime). Conversion is exact rational:
  `units = ceil(pico * 18 / 125)` (144e9/1e12 = 18/125). Reserve and settlement both round **up**.
- Every amount, token count and rate on the wire is a **decimal string of a non-negative integer** (no floats,
  no JSON numbers for money or tokens). Bounds: ≤ 10^18 per rate, ≤ 10^12 per token count.

## Configuration (trusted operator, never request-supplied)

| Variable | Meaning |
| --- | --- |
| `HOSTING_AGENT_HOLDS_ENABLED=true` | Enables every route below; otherwise `503 agent_holds_disabled`. |
| `HOSTING_AGENT_HOLD_SERVICES` | Comma list of runtime service npubs allowed to call service routes. Empty = none. |
| `HOSTING_AGENT_REJECTION_ALLOWLIST` | Comma list `provider:http_status:error_code` accepted as proof that a provider rejected before any accepted work. Empty (default) = none; releases after dispatch are then impossible. |
| `HOSTING_AGENT_RECONCILE_DAYS` | Label only (default 7). `reconcile_by` is a reminder, never an expiry or release. |

## Authentication

- Service routes (`/holds/*`): strict NIP-98 (`verifyStrictNip98Mutation`: exact URL, method, `payload` = sha256
  of the exact raw body, ≤ 60 s). Signer must equal a configured service npub **directly** (no workspace-key
  delegation) Replays inside the NIP-98 window are harmless because every mutation is idempotent on `(account_id, call_id)`. The hold's grant `service_npub` must equal
  the signer. GET lookups use the same allowlist with ordinary NIP-98.
- Payer routes (`/grants*`): strict NIP-98 signed directly by the account owner (`userNpub === signerNpub`).
- Admin routes (`/tariffs`, `/blocks/.../clear`): direct signature by `ADMIN_NPUB`.
- No agent/bot binding can reach these routes.

## Tariff (operator, immutable, append-only)

`POST /api/v4/agent-holds/tariffs` (admin)

```json
{ "version": "2026-12-a",
  "models": [ { "model": "vendor/model", "input_pico_per_token": "100000", "output_pico_per_token": "600000",
                "cached_input_pico_per_token": "10000", "cached_input_semantics": "subset",
                "request_pico": "0", "max_input_tokens": "200000", "max_output_tokens": "32000" } ] }
```

`cached_input_*` are optional together. `subset`: cached tokens are part of `input_tokens`. `additional`: cached
tokens are reported separately and not included in `input_tokens`. A version replay with identical content is
idempotent; a conflicting version is `409 tariff_conflict`. Rows are never updated or deleted. `max_*_tokens` are
configured bounds; a reserve above them is refused (`422 token_bound_exceeded`).

Cost of an observation (pico, then ceil to units):
- `subset`:     `(input - cached) * input_rate + cached * cached_rate + output * output_rate + request_pico`
- `additional`: `input * input_rate + cached * cached_rate + output * output_rate + request_pico`
- No cached rate on the model and `cached_input_tokens > 0` → `422 cached_rate_unsupported` (never guessed).

## Grants (payer)

`POST /api/v4/agent-holds/grants`

```json
{ "idempotency_key": "…", "workspace_id": "uuid", "agent_npub": "npub1…", "service_npub": "npub1…",
  "model": "vendor/model", "tariff_version": "2026-12-a", "daily_cap_units": "720000000000",
  "expires_at": "2027-01-01T00:00:00Z" }
```

Requires: payer owns an activated hosting account linked to `workspace_id` and is that workspace's owner;
`agent_npub` is an agent member of the workspace; `service_npub` is currently allowlisted; tariff version and model
exist. `daily_cap_units` is the cap per **UTC day** on held + settled units for this grant. `201 { grant }`;
same key + body replays, different body `409 idempotency_conflict`.
`POST /grants/{grant_id}/revoke` `{}` (payer) stops new reserves (open holds continue to settle).
`GET /grants` (payer) lists the payer's grants with `day_used_units` (UTC today).

## Holds (runtime service)

States: `held → dispatched → settled`; `held → released` (never dispatched); `dispatched → released`
(allowlisted rejection); `held|dispatched → pending_reconcile → settled`. `settled` and `released` are final.
`held`, `dispatched`, `pending_reconcile` all count as held units.

Identity: `(account_id, call_id)`; `call_id` matches `[A-Za-z0-9_.:-]{1,128}` and is the stable idempotency key
(reuse the same value for every retry of the same logical call). `account_id` is **required** on every request.
An opaque `hold_id` is returned; mutations are addressed by the `(account_id, call_id)` pair, and `GET /holds` also accepts `account_id`+`hold_id`.

### POST /api/v4/agent-holds/holds/reserve

```json
{ "account_id": "uuid", "call_id": "run42:turn3:req1", "grant_id": "uuid", "workspace_id": "uuid",
  "agent_npub": "npub1…", "model": "vendor/model", "tariff_version": "2026-12-a",
  "max_input_tokens": "120000", "max_output_tokens": "8000", "max_cached_input_tokens": "0",
  "run_id": "optional string ≤128" }
```

Checks, all under the account row lock: feature enabled; signer allowlisted and equals the grant's `service_npub`;
grant active/unexpired and every bound field equal to the request; account has no spend block; tariff/model exist
and unchanged; token bounds; storage coverage complete and `agent_available_units ≥ reserve`; UTC-day cap.
`reserve_units = ceil(worst_case_pico * 18 / 125)` with the model's highest applicable input rate.
Success `201` (replay `200`, identical response and request hash):

```json
{ "hold_id": "uuid", "account_id": "uuid", "call_id": "…", "state": "held", "reserved_units": "123456",
  "tariff_version": "…", "model": "…", "reserved_at": "ISO", "reconcile_by": "ISO", "day": "2026-12-01" }
```

Refusals (no hold created, no inference allowed): `402 agent_funds_insufficient`, `403 agent_grant_required`
(none/revoked/expired/mismatch), `403 agent_service_not_allowed`, `409 agent_spend_blocked` (prior overrun),
`409 daily_cap_exceeded`, `409 idempotency_conflict`, `422 token_bound_exceeded`, `422 model_not_priced`,
`503 storage_coverage_incomplete | storage_reserve_unavailable`, `503 agent_holds_disabled`.

### POST …/holds/dispatch `{account_id, call_id}`
Must be persisted **before** the upstream request. `held → dispatched`; replay on `dispatched|pending_reconcile`
is a no-op `200`; from `released|settled` `409 hold_final`.

### POST …/holds/release
`{account_id, call_id, basis:"never_dispatched"}` valid only while `state=held` (NStack has no dispatch
record) → `released`. `{account_id, call_id, basis:"provider_rejection", evidence:{provider, http_status, error_code,
request_id}}` valid from `dispatched` only when `provider:http_status:error_code` is in the allowlist. Anything else
`409 release_not_proven`. A generic 4xx/5xx, timeout, disconnect or restart is **not** proof.

### POST …/holds/pending `{account_id, call_id, reason}`
Outcome uncertain → `pending_reconcile` (from `held|dispatched`). Funds stay held. Idempotent.

### POST …/holds/settle

```json
{ "account_id": "uuid", "call_id": "…", "observation": { "input_tokens": "1000", "output_tokens": "200",
  "cached_input_tokens": "0", "generation_id": "…", "provider_request_id": "…", "observed_at": "ISO" } }
```

Allowed from `held`? **No**: `409 hold_not_dispatched` (a call that was never marked dispatched cannot be
billed). From `dispatched|pending_reconcile`: units computed from the frozen tariff, ledger entry kind
`agent_usage` key `agent_hold:<hold_id>` (promo then paid), hold → `settled`, once. Replay with the same observation
returns the same result; a different observation `409 settlement_conflict`. If `settled_units > reserved_units` the
true cost is still settled (the account may go negative like any reversal debt), the hold is flagged
`overrun_units`, and an **account spend block** is written: later reserves are `409 agent_spend_blocked` until an
admin clears it. No silent budget overrun. Zero-usage settlement (`0` tokens, request_pico 0) is valid and charges 0.
Response: `{hold_id, state:"settled", reserved_units, settled_units, overrun_units, ledger_key}`.

### GET …/holds?account_id=…&call_id=… (or `?hold_id=`)
Service lookup of the stored hold (state, units, grant, timestamps). Never returns other accounts' holds: the grant's
`service_npub` must equal the signer.

## Reserve source

`registerAgentHoldsReserve()` (trusted startup) registers `agent_holds` for refund gating:
sum of `reserved_units` of all open holds. `agent_available_units` in the account storage summary subtracts it, and
`balances.agent_holds` becomes `{registered:true, units}`.

## Out of scope / residual

- No approved tariff, model, markup or rate; operator appends it. Nothing is estimated from public prices.
- Real Git storage coverage is absent, so production admission is closed (`storage_coverage_incomplete`) until the
  Git provider seam in `hosting-storage-peak-v1.md` is built.
- No automatic expiry/release of uncertain holds; reconciliation is by explicit settlement.
- Caps are UTC days only.
