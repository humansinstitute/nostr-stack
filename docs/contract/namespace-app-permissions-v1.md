# Owner-controlled agent namespace permissions v1

Owners can approve one exact agent signer to register, rename, enable or disable
one exact app namespace. This reusable registration capability supports independent
apps such as notes tools and hosted websites without granting workspace admin.
It does not authorize database provisioning, migrations, data reads/writes,
installation management, billing, permission records or onward delegation.

The scope is the existing `workspace_owner_npub` address plus `app_npub`, not a
typed workspace UUID. Registrations can span typed workspaces with the same owner.
`wapp.manage` continues to govern typed-workspace installations independently.
Encrypted workspace service addresses accept their exact creator signer or service
signer as owner. Typed namespace addresses require the exact owner signer. A
resolved workspace key, group administrator or delegate cannot grant permissions.

Sign each request with NIP-98 for the exact URL/method/body. Under
`/api/v4/workspaces/:workspaceOwnerNpub`:

- `GET /app-permissions`: owner-only list, at most 200 entries; follow
  `next_cursor` as `before` until null. Responses use private/no-store caching.
- `POST /app-permissions`: exact fields `idempotency_key` (UUID), `agent_npub`,
  `app_npub`, `permission: "namespace.manage"`, `expires_at` (future, within 366
  days). The response contains `grant`. At most 1000 active grants per namespace.
  Reusing an idempotency key with different scope conflicts; retrying the same
  request reads its original result, including revocation, without reactivation.
- `POST /app-permissions/:id/revoke`: owner-only, requires integer
  `expected_revision`. A stale revision returns 409. An exact successful retry
  returns the revoked grant. Records retain grantor, revoker and timestamps.
- Existing `POST /apps` also accepts an active exact-signer/app grant. Existing
  owner/admin behavior is retained. `GET /apps?app_npub=:exactApp` permits a
  delegated signer to inspect only that registration. Delegates cannot list all
  apps, all grants or another agent's grants.

Authorization uses DB time and holds a permission share lock through registration.
Revocation takes an exclusive row lock, waits for admitted operations, and denies
requests admitted after its commit. Expired, revoked or former-owner grants deny.
No permission is automatically granted during migration or console login.

In `/ui`, choose a workspace and **Agent app permissions**. Compare the displayed
namespace address, full agent and app identities, and expiry; review before signing.
The console reloads the server list after granting/revoking. Switching workspace
or signer invalidates pending mutations, including signer approvals still waiting.
Typed-workspace membership does not prove owner-address permission authority.

Tests use disposable owner signatures and isolated schemas; no real owner grant is
issued. Runtime activation and human signer acceptance must be reported separately.
