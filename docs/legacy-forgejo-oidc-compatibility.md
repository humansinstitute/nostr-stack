# Temporary Forgejo login compatibility

New installations leave `NSTACK_LEGACY_FORGEJO_OIDC_ENABLED` unset (false).
All old `/api/v4/git/*` endpoints return 410 and discovery describes GRasp.
This profile is solely for preserving login to an existing Forgejo while its
separate GRasp cutover is reviewed. It does not restore Git grants, gateways,
reconciliation, organization provisioning, or legacy containers.

For a reviewed API-only upgrade with existing Forgejo, explicitly set
`NSTACK_LEGACY_FORGEJO_OIDC_ENABLED=true` and retain the existing
`GIT_OIDC_ISSUER`, `GIT_OIDC_CLIENT_ID`, `GIT_OIDC_REDIRECT_URI`,
`GIT_OIDC_ALLOWED_NPUBS`, and client/signing secrets through their existing
`GIT_OIDC_CLIENT_SECRET[_FILE]` and `GIT_OIDC_SIGNING_KEY[_FILE]` mechanism.
Do not generate replacement secrets or change issuer, callback, subject,
client ID, or allowlist. Empty allowlist denies every login. The switch is not
exposed in installation settings or QR metadata. When disabled, secret files
are not read and no legacy configuration is required.

Only the six original OIDC routes are enabled and documented in OpenAPI.
The implementation retains live baseline 74a5c6a's exact authentication flow:
60-second single-use Nostr challenge, exact URL/body/nonce/audience/expiry,
allowlisted signer, persisted account subject and initial username, registered
HTTPS callback, confidential client, optional S256 PKCE, single-use code,
RS256 tokens and 10-minute access-token userinfo. There is no refresh-token
grant in that baseline; Forgejo obtains a new authorization session when needed.
Transient codes/tokens still expire on API restart. Existing persisted subject
rows and read-only alias lookup are retained; no Git authority is consulted.

Activation is manager-reviewed. Replace only Tower API while retaining existing
legacy services, environment, secret mounts, networks and volumes. Do not apply
current production Compose wholesale, remove orphans, or run a Git cutover as
part of this profile. A missing old secret mount makes login unavailable even
with the switch set. Check discovery, public JWK continuity, allowlisted login,
userinfo and existing Forgejo account association before accepting activation.

After separately approved Forgejo migration, disable the switch, verify 410 and
GRasp access, and then remove the temporary auth implementation in a later
reviewed change. Preserved historical identity rows are not a deletion target.

Disposable validation (never target the shared database): after rebuilding the
isolated setup stack, run `bun test ./tests/git-oidc.test.ts` inside its Tower
container with generated test keys and `NSTACK_DISPOSABLE_OIDC_TEST=1`. The
integration binds a temporary loopback HTTP server in that container and checks
real database identity persistence, complete signed login, tokens and replay.
Default retirement is covered by `tests/forgejo-native-boundary.test.ts`.

`docker-compose.legacy-oidc.yml` is a Tower-only opt-in overlay. It restores
only the old OIDC environment mappings and two exact read-only secret mounts;
missing source files fail rather than creating directories. Combine it with
the manager-reviewed existing deployment configuration for API-only activation
(`up -d --no-deps tower`), never orphan removal. Validate the merged configuration
without printing resolved secret environment. This overlay itself does not
create or inspect credentials, alter networks, or operate other services.
