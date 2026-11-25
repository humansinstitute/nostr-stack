# Receiver feed runner and age recovery vault v1 (inert, trusted-startup only)

Nothing here starts, configures or runs by default. No route, environment value or request can enable either piece.

## Periodic receiver binding completeness runner

`src/services/hosting-lightning-feed-runner.ts` — `createFeedRunner({ enabled, provider, intervalMs?, batch?, maxPages?, timeoutMs?, onReport? })`.

- Calls the existing `reconcileBindingFeed` (gap-free `prevSeq` chain, orphans, digest conflicts, quotes without bindings). It never settles,
  credits, refunds, sweeps or messages anyone, and never interprets an order reference such as `PAID`. A report is an operator alert, not evidence.
- Requires `enabled: true` and a trusted, already-built mint-backed provider with `bindingsPage` and `mintBacked`; otherwise `disabled` / `unconfigured`.
- Hard bounds: interval 30 s–1 h, batch ≤ 200, pages ≤ 20, timeout 1–120 s. Failures back off ×2 up to ×8 and reset on success.
- No overlap: one in-flight pass per runner, held until the underlying call really settles (a timeout reports `timeout` and sets an abort flag
  that stops further page fetches, but the slot is not freed while a wedged call is outstanding); a session advisory lock on a dedicated
  connection stops other processes (`locked`) and is released after every pass.
- Restart-safe: the watermark and orphans live in `hosting_lightning_binding_feed` / `_orphans`; a new runner resumes from the persisted watermark and a
  repeat pass is idempotent.
- Errors are reduced to a short stable code; provider text is never retained.

Activation (operator startup module, after review): build the receiver transport and provider, call `configureLightningProvider(provider)`, then
`createFeedRunner({ enabled: true, provider, onReport }).start()`; call `stop()` on shutdown. `attention` lists `gap | conflicts | orphans | behind |
quotes_without_binding` for alerting. Orphans are expected for orders with no local quote and are retained for support.

## age filesystem RecoveryVault adapter

`src/services/hosting-recovery-age-vault.ts` — `openAgeRecoveryVault({ rootDir, recipient, ageBin, forbiddenRoots?, isolatedRestore?, … })`.

- Encryption is the established `age` format via the `age` CLI at an absolute operator-supplied path (no PATH lookup, minimal child environment).
  No homegrown cryptography. Only a PUBLIC `age1…` recipient is accepted; a private identity string is refused. NStack never reads or searches for keys.
- `rootDir` must be an existing real directory (no symlinks in the path), owned by this user, mode without group/other access, and neither inside nor
  containing the working directory or any `forbiddenRoots` (agent/runtime data).
- Layout: `<uuid>.age` and `<uuid>.manifest.json`, mode 0400, written via temp file + fsync + hard link (never replaces), read back and re-verified
  (digest, length, age header, no plaintext in ciphertext). Opaque ids (`agevault:<uuid>`); strict ref parsing; reads use `O_NOFOLLOW`; `destroy` never
  follows or removes a symlink/directory and is idempotent. Bounded plaintext bytes (≤ 1 GiB hard, default 256 MiB), object count, and child timeout.
- **Encrypt-only by itself.** `restoreIdentity` first verifies the stored ciphertext against its manifest, then needs an `isolatedRestore` decrypt
  port (e.g. `ageIdentityRestore`, intended for an isolated host that holds the identity). With none configured it fails closed and a copy cannot become `restore_verified`.
- **It proves encrypted-byte integrity only and does not upgrade that claim.** The seam now keeps `promised` false and the gate closed (`recovery_snapshot_unverified`) for every vault.
- **Provenance is permanently `test`.** A public recipient and a byte roundtrip do not prove that a complete workspace can be restored, so this
  adapter can never make `accountRecoveryState().promised` true or `removalGate()` allow.
- `expireRecoveryCopies` now also destroys the sealed bytes of `failed` copies at their 30-day expiry (state stays `failed`; one `expired` event).

## Remaining recovery gap (unchanged by this slice)

User export is actor-visible, not a privileged full-workspace backup. No per-workspace complete-snapshot producer (Git mapping/bytes, managed ciphertext,
owner-only data), no production offline storage/isolation, no operator recipient/identity custody decision, no authenticated complete-snapshot +
isolated-restore attestation under the gate, no support restore tool and no removal tool. Policy remains 30 days free read-only/export, then 30 days
offline recovery and expiry; recoverability must not be stated to customers.
