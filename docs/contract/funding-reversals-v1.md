# Shared funding, settlement and reversals v1

Stage 2 of invited onboarding. Everything credits and debits the one shared USD ledger
([hosting-billing-usd-v1.md](hosting-billing-usd-v1.md)); there is no separate wallet.
Source-built tests only: no real credentials, payment, provider or deployment has been
exercised, and every provider live gate below stays closed until reviewed acceptance.

## Method-neutral settlement

Every credit, whatever the method, is exactly one immutable row in
`hosting_funding_settlements` plus one ledger entry written in the same transaction:
`(method, provider_ref)` and `(method, order_id)` are each unique, so one provider
payment can never credit twice and one order can never be credited by two payments.
A settlement fixes account, intent (if any), `USD` amount in integer cents and exact
tariff units, and the provider evidence. Settlements, observed provider events
(`hosting_funding_events`) and the ledger are append-only (DB triggers). Legacy Stripe
credits are bound retroactively from their fulfilled order and ledger row. Clients,
redirects and "paid" flags never create settlements.

An onboarding intent is funded from a settlement (`funded_settlement_id`);
`funded_order_id` is set only for Stripe checkout orders.

## Stripe

Existing Checkout fulfilment (server-retrieved paid, test-mode session fully bound to the
order) now records a settlement. The webhook additionally handles:

| Event | Effect |
| --- | --- |
| `checkout.session.expired` | Retrieves the session; releases the order only if it is the order's own recorded session with the **full binding** (id, `client_reference_id`, `hosting_order_id`, account, USD, amount, test mode) and is `expired` and unpaid. A paid one is credited instead. Any other session (spoofed metadata, other amount/account/currency, livemode) releases nothing. |
| `charge.refunded`, `charge.refund.updated`, `refund.created/updated/failed` | Reconcile the PaymentIntent (below). |
| `charge.dispute.created/updated/closed/funds_withdrawn/funds_reinstated` | Reconcile the PaymentIntent (below). |

Reconciliation ignores the event payload's state: it retrieves every refund and dispute
of the PaymentIntent from Stripe and converges the ledger onto that current truth, so
delivery order, duplicates and replays cannot change the result. A reversal delivered before
its payment settles the payment first (from the verified paid session); reversals of payments
this service never settled are ignored. Effects:

- Refund `pending`/`requires_action`/`succeeded` withhold the refunded amount; `failed`/`canceled` release it.
- Dispute `needs_response`/`under_review`/`lost` withhold the disputed amount; `won`, warning inquiries and `prevented` withhold nothing.
- Each change is an explicit `refund`/`dispute` ledger entry (`adj:<adjustment>:<n>`) written once under the account lock, with the adjustment row keeping state, effect and `uncovered_units`. Negative-event history is never deleted.
- Reversed funds leave `paid_units` immediately, so they cannot be spent. If they were already spent the balance goes negative: the shortfall is recorded as `uncovered_units` (debt), `depleted_at` is set and the existing 402 write block applies. Nothing is dropped silently. A later release repays debt first.
- A funded intent whose settlement is reversed below its chosen amount cannot provision (`402 funding_reversed`); `funding_reversed` is exposed on the intent. A provisioned workspace, intent and seat are retained, and the account carries the debt.
- Refund and dispute against the same payment are both withheld (conservative; no cap).

## Checkout terminal state and seat holds

An unfulfilled order or Lightning quote holds its invitation seat until the provider verifies a
terminal state (never a local guess). `cancel`/`release-seat` first ask the provider, outside any
DB lock: a paid session is credited (so cancel then fails with `intent_not_cancellable`, nothing lost);
an open session is expired at Stripe and recorded `terminal_at/expired` only once Stripe confirms
`expired`; a session with no recorded id is idempotently created then expired. Pending async payment,
provider errors, an unconfigured provider or a session that does not match the order's binding leave
the hold in place (`checkout_outstanding`). An expired session cannot be paid later.

## Lightning (provider-neutral port, no production adapter)

Evidence for a real provider is **unresolved**: the only Lightning code in this repository is the
historical Mginx MB-hour adapter (`src/services/mginx.ts`; fixed sats per product unit, no USD or FX
quote, no webhook, no refund or payer binding documented; its server source is not available locally).
It is deliberately not used. NStack defines the port it requires (`LightningProvider` in
`src/services/hosting-lightning.ts`); a real provider is added later as a trusted, server-configured
module once its invoice, FX-quote and settlement contract is verified. No route, environment value or
request can register a provider, and `HOSTING_LIGHTNING_ENABLED=true` plus a configured provider is
required (`503 lightning_unavailable` otherwise). Tests use a fixture provider only.

- **Quote** (`POST /intents/{id}/lightning/quote`): USD is the intent's server-held `funding_cents`
  (never caller input). The provider converts to sats and returns invoice, payment hash, sats, expiry,
  our payee identity and rate source/time/ref. All are stored, bound to account + intent and a unique
  payment hash; replays are idempotent; malformed provider output is refused.
- **Settlement** only from provider-verified state, fetched by the server
  (`POST /intents/{id}/lightning/quotes/{quoteId}/refresh`, admin reconcile, or a future runner): same
  payment hash and payee identity, `sats_received >= quote`, a preimage whose SHA-256 equals the payment
  hash, settled before expiry. Then one settlement, one `lightning` ledger credit of exactly the quoted
  USD (overpayment recorded as evidence, not credited), intent funded. A preimage alone is never
  permission to credit; the caller supplies no evidence.
- Inconsistent evidence (`mismatch`) and payment after expiry (`late_payment`) are recorded for support,
  not credited, and keep the seat. `expired`/`cancelled` are verified terminal states; cancel asks the provider
  to cancel a pending invoice first.

## Support-assisted refunds (platform administrator)

`POST /api/v4/onboarding/admin/refunds` (Stripe) and `/admin/lightning-refunds` (verified customer
invoice). Unused, unreserved **purchased** credit only (promotional credit is never refundable): bounded by
the settlement's remaining refundable amount and `paid_units` minus every registered reserve. Funds are
withheld from the account first (explicit `refund` ledger entry), then the provider is called with a
deterministic idempotency key. A definite provider rejection releases the funds; an ambiguous outcome keeps
them withheld (`502 refund_outcome_unknown`) and the same request replays safely. Stripe's own refund event
matches the request by metadata and never debits twice. Lightning refunds additionally require the provider
payout capability (`503 lightning_refund_unavailable`), `customer_verified: true`, an invoice whose sats do
not exceed the provider's current conversion of the refunded USD, one-time use of each invoice, and a payment
preimage hashing to the invoice's payment hash before success is recorded.

## Release gates still closed

- **Refund routes are gated** (`503 refund_reserves_unregistered`) until at least one real reserve source
  (storage runway, agent holds) is registered through `registerFundingReserve`. An empty registry is not proof
  that funds are unreserved. No source registers one yet.
- Live Stripe (`stripe_live_rollout_blocked`); real Stripe test-mode round trip with authorized credentials,
  including refund and dispute behaviour, has not been performed.
- No real Lightning provider, FX source, periodic settlement runner or provider-authenticated notification
  exists. Quote TTL/rate-freshness policy and tax/payment review are provider decisions.
- Runtime validation requires `./rebuild_deploy_docker.sh` (a live deploy) under manager approval.
- `ONBOARDING_ENABLED` stays unset until reviewed activation.

## Validation

```sh
set -a; . ./.env.example; set +a
FUNDING_TEST_PORT=<port> bun test ./tests/hosting-funding.test.ts
LIGHTNING_TEST_PORT=<port> bun test ./tests/hosting-lightning.test.ts
ONBOARDING_TEST_PORT=<port> bun test ./tests/onboarding.test.ts
```

Use a fresh throwaway PostgreSQL per run (explicit tracked test paths; ignored `tmp/` copies also match
broad filters). Stripe fixtures follow the SDK's documented Refund, Dispute and Checkout Session shapes and
are signed with the SDK's own test header generator.
