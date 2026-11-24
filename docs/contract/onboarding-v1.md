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
the fulfilled order and ledger credit. There is no credit-mint API. Live Stripe stays
blocked (`stripe_live_rollout_blocked`); Lightning, refunds and disputes are the
payments slice. Credit above or beyond an intent (for example a payment landing
after cancellation) remains in the account.

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

Interim storage boundary: `billing_link` sets the legacy hourly meter start to
`provisioned + 720 hours` (`intro_ends_at`), so no storage is charged during the
introductory period. Hourly peak accounting, the 1 GB waiver and the US$5/720h
minimum replace this in the storage slice; until then excess above 1 GB in the
introductory period is not charged.

## Validation

```sh
set -a; . ./.env.example; set +a
ONBOARDING_TEST_PORT=<free-disposable-port> bun test ./tests/onboarding.test.ts
```

Use a fresh throwaway PostgreSQL on a free port. Source tests prove code behavior
only; local NStack must be rebuilt (`./rebuild_deploy_docker.sh`, a live deploy) by
the manager before any runtime or live validation.
