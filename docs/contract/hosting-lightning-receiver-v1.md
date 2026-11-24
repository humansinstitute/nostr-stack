# Mint-backed Lightning receiver integration v1

NStack side of the isolated Cashu receiver (`cashu-wallet/server/receiver`, read against HEAD `5e6f765`). It plugs into the
existing Lightning funding port as a second evidence kind. **Source only: no provider is registered, no FX source, mint,
custody or TLS configuration exists, and `HOSTING_LIGHTNING_ENABLED` stays off.** End-to-end settlement (a real mint pays, the real
receiver redeems, NStack credits) is **not validated**.

## Registration (trusted code only)

`createReceiverLightningProvider(createReceiverClient({origin, caPem, serviceNsec}), {mint, treasuryFingerprint})` yields a provider with
`evidenceKind:'mint_redemption'`, `payeeRef = cashu:<mint>#<fingerprint>` and **no `payouts`** (the receiver has no payout, so Lightning
refunds remain `503 lightning_refund_unavailable`). It is registered like any provider, by a reviewed startup module calling
`configureLightningProvider`. No route, environment value or request registers it, and nothing reads the environment here. The expected
`mint` and `treasuryFingerprint` come from that trusted call and are compared against every binding and evidence record.

## Private transport (responses are unsigned)

The receiver signs nothing it returns, so authenticity is the channel's job. The client fails closed:

- one operator-configured `https://host[:port]` origin (no userinfo, path, query or fragment); never a caller-supplied URL;
- the server certificate must verify against the **pinned PEM** (certificate or private CA) only; the system trust store is not used,
  `rejectUnauthorized` is always true, TLS ≥ 1.2, no agent/proxy reuse;
- one **absolute wall-clock deadline** (default 10 s) covers connect, TLS, headers and the whole body and is cleared on every terminal path, so a
  slow-drip response cannot outlive it; in-flight (8) and waiting (32) requests are bounded, excess is an immediate `receiver_busy`;
- redirects are never followed (a 3xx is a failure), non-JSON, oversize (256 KiB) and slow (10 s) responses are failures, 5xx/429 are
  `receiver_unavailable`, other non-2xx `receiver_rejected`; no response text is surfaced;
- every request is NIP-98 signed with Tower's own service key: exact `u` (origin + path + query), `method`, `payload` = sha256 of the exact
  body (absent for empty bodies), random `content` ≤ 64 chars, single use. The receiver must list Tower's service pubkey as a caller.

Residual: the pin protects against DNS/route redirection and MITM, not against a compromised receiver host.

## Wire use

| Port step | Receiver call |
| --- | --- |
| `issueInvoice({orderRef: quoteId, amountCents})` | `PUT /v1/orders/{quoteId}` `{"currency":"USD","amountMinor":cents}` → `OrderInvoice{…, lockPubkey, binding}` |
| settlement poll (user refresh, admin reconcile) | `POST /v1/orders/{quoteId}/settle` (one pass) → evidence view |
| completeness feed | `GET /v1/bindings?after=N&limit≤500` |

Quote `expires_at = min(invoice expiresAt, rate.validUntil)`; rate seconds map to ISO times.

## Durable binding before display

`hosting_lightning_bindings(treasury_fingerprint, seq, quote_id UNIQUE, digest, record)` is append-only. `completeIssuance` verifies the
returned binding (digest recomputed over canonical JSON without `digest`; `orderRef`, USD, cents, mint, fingerprint, payment hash, invoice,
sats, lock key and expiry window all equal the issued invoice, the quote and trusted configuration; still payable) and then, **in one
transaction**, inserts it and flips the quote `issuing → open`. The invoice is only visible through the `open` row, so an unbacked invoice can
never be shown. A replay of the same order (including after a crash between the receiver's PUT and our store) returns the identical record and
is idempotent; any different record for the same quote or `(fingerprint, seq)` is `409 binding_conflict` and the quote stays `issuing`.

## Evidence verification (`verifyMintView`)

Credit requires **all** of: `status:'settled'`, `creditable:true`; `evidence.v===1`, `kind==='mint_redemption'`; `evidenceDigest` equals the
sha256 of the canonical evidence; `orderRef`, `paymentHash`, `quoteId`, `mint`, `lockPubkey`, `keyNamespace`, `keyEpoch`, `derivationIndex`,
`amountSats`, `expiresAt` and `rate` equal our stored quote **and** stored binding; `payeeRef` equals both the quote's and
`cashu:<configured mint>#<configured fingerprint>`; `mintChecked===true`, `proofsHeld==='local_ready_unreserved'`, `proofCount≥1`, digest and
operation fields well formed; `late===false`; `settledAt ≥ binding.issuedAt`; and `(paidAt ?? settledAt) ≤ quote.expires_at` (the stricter of
the receiver's `late` and our own expiry). Then the shared `recordSettlement` (provider_ref = payment hash, order id = quote id) credits once;
the unique `(method, provider_ref)` / `(method, order_id)` barrier and the quote row lock keep concurrent polls to one credit. Client-supplied
evidence and `PAID`/`ISSUED` strings are never read.

Outcomes: `pending` leaves the quote `open`; `late_payment` (receiver or our expiry) → `late_payment`, never credited; `rejected`, `unknown`,
a missing stored binding or **any** field mismatch → `mismatch` with a reason, never credited; receiver unreachable → the call fails and the
quote stays `open`. A quote's evidence kind is fixed at issuance (`evidence_kind`); a preimage can never settle a mint quote and a mint
provider never settles a preimage quote.

An unpaid mint quote **stays `open` after expiry**: the receiver has no cancel, so NStack does not guess that a later payment cannot arrive.
This keeps the intent's hold unresolved until the receiver reports a terminal state; support resolves it.

## Binding completeness feed

`POST /api/v4/onboarding/admin/lightning/receiver/bindings/reconcile` (platform administrator, strict signature) walks `GET /v1/bindings`
from the stored watermark, checks fingerprint, each digest and a gap-free `prevSeq` chain, stores unknown records in
`hosting_lightning_binding_orphans` (never creditable), flags digest conflicts and lists open mint quotes lacking a stored binding. It is a
completeness check, not a credit path. `GET` consistency (`head` vs page snapshot) is not assumed.

## Not done / residual

Real FX, mint, custody, TLS material and activation; refunds; an automatic periodic feed runner; handling of receiver recovery mode beyond
treating `pending{recovering}` as pending; cross-repo changes (the receiver is untouched and could additionally sign evidence digests).
