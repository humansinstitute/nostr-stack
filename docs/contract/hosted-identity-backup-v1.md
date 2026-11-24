# Hosted identity backup v1

Mandatory hosted copy of a **new** on-device Nostr key for native clients, stored only as an opaque NIP-49
`ncryptsec` ciphertext retrievable by username. Existing-signer sign-in (extension, bunker, imported key) is
unaffected. NStack never sees a password, plaintext key or password-derived secret, and performs **no**
password-strength verification (the client chooses scrypt cost). There is no conventional password reset: losing
the password means losing the key.

Routes are always available (no feature flag) under `/api/v4/identity-backup`. Payment gating applies only to
onboarding intents that declare `identity_origin:"new"`.

## Data model

One row per owner: `username` (normalised, immutable, unique), `owner_npub` (unique, the signer of the first
claim), `ncryptsec`, `revision` (starts 1, +1 per accepted write), `logn`, `created_at`, `updated_at`.
No rename, no delete, no re-claim. A claim can never be taken over by another key; only the owner npub can write.

## Username

`NFKC` normalise then lowercase; must then match `^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$` (3–32 chars). Anything else,
including homoglyph/compat forms that normalise outside this set, is `400 invalid_username`. A small reserved set
(`admin`, `support`, `nstack`, `wingman`, `root`, `system`) is `400 invalid_username`. First claim wins; one
username per npub.

## ncryptsec validation (before any bech32 allocation)

String, exactly **162** chars, prefix `ncryptsec1`, bech32 charset only, lowercase. Then decoded and checked:
payload 91 bytes, version byte `0x02`, `logN` ∈ {16,17,18}, security byte ∈ {0,1,2}. Anything else
`400 invalid_backup`. The server cannot and does not check that it decrypts to the signer's key (it has no
password); the client must verify by decrypting before payment and after restore.

## PUT /api/v4/identity-backup/{username}  (owner-signed, create or CAS update)

Strict NIP-98 (exact URL, method, payload sha256), signed **directly** by the owner key (`userNpub===signerNpub`).

```json
{ "ncryptsec": "ncryptsec1…", "expected_revision": "0" }
```

`expected_revision` is a decimal string: `"0"` creates, otherwise must equal the stored revision.
`201 {username, revision:"1", created:true}` or `200 {username, revision:"N+1", created:false}`.
Identical body replay of the last accepted write is `200` with the same revision (no increment).
Errors (uniform JSON `{code,error}`): `400 invalid_username|invalid_backup|invalid_json|body_too_large`,
`401 nip98_*`, `403 backup_owner_mismatch` (username owned by another key), `409 username_unavailable` (create when
the name exists, whoever owns it), `409 identity_already_backed_up` (this npub already owns a different username),
`409 revision_conflict` (body also returns `current_revision`), `429 rate_limited`.

## GET /api/v4/identity-backup/{username}  (public, unauthenticated)

`200 {username, ncryptsec, revision, updated_at}` — ciphertext and revision only, **no npub**.
`404 backup_not_found`. Bounded per-IP and global throttles, `429 rate_limited` with `Retry-After`.

## GET /api/v4/identity-backup/me  (owner-signed read)

`200 {username, revision, updated_at}` or `404 backup_not_found` for the signer. Clients use this to prove a
durable hosted copy exists; it returns no ciphertext.

## Onboarding gate

`POST /api/v4/onboarding/intents` accepts optional `identity_origin: "new" | "existing"` (default `existing`,
so existing clients are unchanged). For `new`, intent **payment initiation** (card checkout and Lightning quote)
is refused with `409 identity_backup_required` until `GET …/me` would succeed for the intent owner. The server
cannot attest where a key came from; `identity_origin` is a client-declared guardrail, not proof. `existing`
intents are never gated by this.

## Residual risk (explicit)

- **Username enumeration** is possible: `GET` distinguishes existing from unknown names (bounded by throttles
  only). Uniform timing is not claimed.
- **Offline guessing:** anyone can fetch a ciphertext by username and attack the password offline; the defence is
  the client-chosen password and scrypt cost (`logN` 16–18; client defaults chosen from measured device resources).
- Throttles are in-process and per replica; they bound but do not eliminate abuse.
- Server cannot verify the ciphertext matches the owner's key; a buggy client could upload an undecryptable blob.
  Clients must decrypt-verify before enabling payment.
