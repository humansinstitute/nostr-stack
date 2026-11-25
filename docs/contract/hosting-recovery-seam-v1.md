# Offline recovery seam v1 (inert, fail-closed)

Approved policy: 30 days read-only after funds run out, then live removal **only** with a 30-day encrypted offline copy, support restore, and
expiry. This slice builds the verification state machine and the activation gate. **It builds no backup, no encryption, no restore tool and
removes nothing.** Nothing may be described as recoverable until the gates below are met in a real environment.

## What exists

- `hosting_recovery_copies` / `hosting_recovery_events` (additive, append-only events, copy identity immutable, rows never deleted). A copy
  records the workspace/account, a producer-stated manifest (`includes`/`excludes`, stored verbatim and never treated as proof), the plaintext
  sha256/size, opaque `object_ref`/`key_ref` from the vault, the ciphertext identity, `sealed_at`, `expires_at = sealed_at + 30 days`, and the
  isolated-restore evidence. States: `sealed → restore_verified`, `→ failed`, `→ expired` (final).
- `RecoveryVault` port (`src/services/hosting-recovery.ts`): `seal(plaintext) → {objectRef, keyRef, ciphertext identity}`,
  `restoreIdentity(objectRef)` (decrypt in an isolated target, never into live tables, and report the identity recovered) and
  `destroy(objectRef)`. NStack holds **no key material**. `provenance` is `production` or `test`. No vault is configured by default and no route,
  environment value or request can configure one (`configureRecoveryVault` is a trusted startup hook).
- `sealRecoveryCopy`, `verifyRecoveryRestore` (a copy is `restore_verified` only when the vault recovers exactly the sealed identity; a mismatch
  marks it `failed`; an unreachable vault changes nothing), `expireRecoveryCopies` (destroys the sealed copy, retries on failure), and
  `accountRecoveryState` which feeds `lifecycle.offline_recovery`: `promised` is always false for now.
- `removalGate(workspaceId)`: the check any future removal tool must call. It **currently never allows**: besides the ended read-only period and a
  restore-verified, unexpired, production-vault copy of that workspace, it always reports `recovery_snapshot_unverified`, because byte identity of
  an arbitrary blob (even with an empty or self-serving manifest) is not proof of a complete workspace snapshot. Only a separately implemented,
  trusted full-workspace capture + isolated restore verifier, binding its attestation to the workspace and snapshot version and proving rows,
  history, objects, relationships and real Git/archive/managed coverage, may lift that reason. No flag, name or provenance label bypasses it.
  `promised` is likewise false until then. A restore test racing expiry can never record `restore_verified`/`restore_failed` on an expired copy.

## Not built (activation requirements)

1. A snapshot producer that exports **one workspace** (not whole-instance `scripts/tower-backup.sh`, which is instance-scope, quiesced and age-encrypted)
   with its full customer content, including families the member-ACL export deliberately omits (managed-app ciphertext, Git, owner-only data). The
   migration export is an ACL-scoped exit tool, not this.
2. A production vault: encryption with externally held keys, isolated storage, a real isolated restore harness, 30-day destruction.
3. An isolated restore test run against real data volumes, with its evidence retained, before any recoverability is stated to customers.
4. Support restore procedure and tooling, and the explicit operator removal tool that calls `removalGate`.
5. Decision on key custody/escrow and who may trigger a restore.

Until 1–4 exist, `offline_recovery` stays `available:false, verified:false, promised:false` and the lifecycle copy must not say recoverable.

## Tests

`tests/hosting-recovery.test.ts` (disposable PostgreSQL, in-memory test vault only; no keys, no live data). Run with `RECOVERY_TEST_PORT`.

See `hosting-feed-runner-and-age-vault-v1.md` for the encrypt-only `age` vault adapter (provenance `test`, never promises) and the feed runner.
