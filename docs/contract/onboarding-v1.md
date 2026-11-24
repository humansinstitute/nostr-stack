# Invited onboarding and shared funding v1

NStack owns the owner billing account, durable onboarding intent, capped group
invitations, funding binding and provisioning state. Native clients (Ambulando) own
identity UX, encrypted-backup handling, checkout hand-off and sync. Agents own
ephemeral execution. Everything reuses the shared USD ledger in
[hosting-billing-usd-v1.md](hosting-billing-usd-v1.md); there is no separate
wallet, catalogue or billing database. All routes are under `/api/v4/onboarding`,
human direct-signature NIP-98 only (strict URL/method/body hash; delegated signers
are refused on mutations). None are agent routes.

## Account before workspace

`POST /account` opens the authenticated owner's account independent of any
workspace, idempotently, with **no welcome or promotional credit**. An existing
account (including legacy accounts that received the old welcome grant) is returned
unchanged; there is no back-charge, conversion or wallet migration. Ordinary hosted
signup and legacy billing are unchanged.

## Intent

`POST /intents` creates or replays a durable intent keyed by
`(owner, client_request_key)`; a different body under the same key is
`idempotency_conflict`. It preserves workspace name, optional agent offer reference
with daily cap, `funding_cents` (US$21 = 2100 minimum and default; presets 2100,
5000, 10000, or custom up to 1,000,000) and an opaque safe `return_state`
(`[A-Za-z0-9._~:@/=+-]`, ≤256, no `//`; never a redirect authority — the Stripe
return allowlist alone governs redirects). `GET /intents` and `GET /intents/{id}`
resume it. `POST /intents/{id}/options` applies a revisioned update while `open`
(or `funded`, excluding the amount). Another identity gets 404.

Agent selection references versioned `onboarding_agent_offers`
(template, model_ref, rate_version, default/max daily cap) configured by the
platform administrator. The catalogue is **empty by default and agent selection
fails closed** (`agent_offer_unavailable`). This API stores references only; no
prices, markup or model defaults exist here. They remain measured release gates.

## Capped group invitations

An administrator creates a link with `max_admissions` (for example 21 or 256). The
plaintext code is returned once; only its SHA-256 digest is stored. There is no
automatic expiry. Capacity is counted in per-identity **seats**:

- **Reserved** on the identity's first successful intent creation (the claim). The
  cap is therefore a real guarantee even before payment.
- Idempotent per identity: retries, replays, concurrent calls and further intents by
  the same identity never consume more capacity (row lock on the invite).
- **Redeemed** at successful provisioning.
- **Released** only when the owner cancels their last unfunded intent, or an
  administrator releases an unredeemed seat that has no funded/provisioning intent.
  **Either release is refused (`checkout_outstanding`) while any attached checkout or
  Lightning quote is not provider-verified terminal.** Cancel/release first ask the
  provider to settle the hold (credit a paid session, expire an open one, cancel or
  observe an expired invoice); only a verified `expired`/`cancelled` provider state,
  bound to the order, frees the seat. A late verified payment must still find its seat. Checkout
  creation locks the intent and requires `open`; cancel, release and claim lock
  invite → seat → intent in that order, and fulfilment locks the intent when it funds
  it, so funding and release cannot interleave.
- Revocation stops new admissions only; existing seats remain valid.

`GET /invites/{code}` is public and returns only `{available}`.

Product tradeoff recorded for review: reserving at claim means abandoned unpaid
claimants hold seats until cancelled/released; consuming only at provisioning would
allow more paid claimants than the cap.

## Funding gate

Funding is only established by the existing verified Stripe path: a server-retrieved
paid, test-mode Checkout Session bound to the order, owner account, exact amount and
unique PaymentIntent credits the ledger once (`stripe:<payment_intent>`). Intent
checkout (`POST /intents/{id}/checkout`) uses the intent's server-held amount and
marks the intent `funded` in the same transaction as the credit. Redirects, unpaid
events and client flags cannot fund; provisioning also re-derives the evidence from
the immutable settlement, net of provider reversals (`402 funding_reversed` when a
refund or lost dispute leaves less than the chosen amount; completed provisioning is
never undone). There is no credit-mint API. Live Stripe stays blocked
(`stripe_live_rollout_blocked`). Lightning, refunds, disputes and checkout terminal
state: [funding-reversals-v1.md](funding-reversals-v1.md). Credit above or beyond an
intent (for example a payment landing after cancellation) remains in the account.

## Provisioning

`POST /intents/{id}/provision` requires verified funding (`402 funding_required`).
It runs durable steps, each in its own transaction and recorded in `steps`:
`workspace` (deterministic service identity from the intent id, so creation is
idempotent; no welcome credit) and `billing_link`. Concurrent callers serialize on
the intent row; a recorded step never repeats. A failed step keeps credit and
completed steps, records `last_error` (`<step>:<code>`) and is retried by calling
again. Only then the status becomes `provisioned`, `provisioned_at` is set and the
seat is redeemed. General and each selected agent's DM/resources are later steps of
this same registry; they are not yet implemented.

Storage boundary: `billing_link` links the workspace to the account and creates a
**pre-activation** peak-storage enrollment (write-path journal only; nothing is charged
and no introduction has started). The final transaction that marks the intent
`provisioned` also activates the enrollment: `provisioned_at` and the start of the 720
introductory hours are the same instant, and `intro_ends_at` is exactly
`provisioned_at + 720 hours`. A failed or incomplete setup therefore consumes nothing
and bills nothing. Billing is [hosting-storage-peak-v1.md](hosting-storage-peak-v1.md):
hourly peak, US$5/720h minimum for 1 decimal GB, base-only introductory waiver.
Provisioning fails closed (`503 storage_tracking_unavailable`) unless the write-path
triggers are installed; they install at start-up when `ONBOARDING_ENABLED=true`.

## Release gates (stage 1 is NOT production-ready)

- `ONBOARDING_ENABLED=true` is required for intent create/update, checkout and
  provision (`503 onboarding_rollout_disabled` otherwise). Account, invite
  administration and reads are unaffected. Only a reviewed activation sets it.
- `agent_state` is `none`, `selected_not_provisioned` or `provisioned`; a
  `provisioned` workspace never implies an agent, General or DM exists beyond what
  workspace setup creates. Agent resources are a later step.
- Accounts opened here carry `opened_by='onboarding'`; the legacy
  `linkHostedAccount` no longer writes a welcome ledger entry for them (it would
  be an unbacked snapshot of a zero promotional balance).
- Stripe live mode, a real Lightning provider adapter, the `agent_holds` reserve
  (the `storage_protection` source is registered) and live refund acceptance remain release gates; see
  [funding-reversals-v1.md](funding-reversals-v1.md).

## Repeat account top-ups

After the owner account backs a provisioned workspace (`hosting_workspace_accounts`), the owner can add credit
without a new intent, workspace, invitation seat or introduction. Human direct-signature routes, gated by
`ONBOARDING_ENABLED`; amounts are US$5 to US$10,000 (`amount_cents` 500..1000000):

- `GET /api/v4/onboarding/topups` — credited top-ups (settlements with no intent), open Lightning quotes, unfulfilled checkout orders.
- `POST /topups/checkout` `{idempotency_key, return_url, amount_cents}` — Stripe Checkout (test mode) bound to the account; the order carries no `intent_id`.
- `POST /topups/lightning/quote` `{idempotency_key, amount_cents}` and `POST /topups/lightning/quotes/{quoteId}/refresh` — same provider port and verification as intent quotes; the quote has `intent_id: null` (at most 5 open per account).

Credit still happens only through `recordSettlement` (one immutable settlement, one ledger credit per verified
payment, replay and concurrency safe). `404 account_not_found` / `409 account_not_provisioned` otherwise.
A top-up nets against reversal debt first and clears `depleted_at` only when the balance turns positive.

## Validation

```sh
set -a; . ./.env.example; set +a
ONBOARDING_TEST_PORT=<free-disposable-port> bun test ./tests/onboarding.test.ts
```

Use a fresh throwaway PostgreSQL on a free port. Source tests prove code behavior
only; local NStack must be rebuilt (`./rebuild_deploy_docker.sh`, a live deploy) by
the manager before any runtime or live validation.

## Read-only recovery state and notices

`GET /api/v4/onboarding/lifecycle` (owner; also `lifecycle` on `GET /account`) projects the account's lifecycle:
`active`, `warning` (30/7/1-day runway), `read_only` (funds exhausted: 30 free days from `depleted_at`, writes blocked by
the existing 402 boundary, export available, no debt, exit fee or back-charge, a top-up resumes charging prospectively),
`removal_due` (the 30 days ended), `no_billed_workspace` or `unknown`. It always reports `automatic_deletion:false`,
`live_removal_performed:false` and `offline_recovery:{available:false,verified:false,promised:false}`: no isolated encrypted
offline copy, support restore or expiry exists, so nothing may be described as recoverable. `export_complete` stays false while
the [migration export](workspace-migration-export-v1.md) manifest is incomplete.

Durable notices (`hosting_lifecycle_notices`) are recorded once per account, kind and cycle by the periodic runner
(`startLifecycleNoticeRunner`, idempotent, every 5 minutes) and on read: `runway_30d|7d|1d` (most urgent threshold only, new
cycle after each credit), `read_only_entered` (per depletion) and `removal_due`. They are polled by clients and
acknowledged with `POST /lifecycle/notices/{id}/acknowledge` (direct signature, owner only). Push or e-mail delivery of these
notices and the explicit agent-resume confirmation are not wired in this slice.
