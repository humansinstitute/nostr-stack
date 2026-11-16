# Progressive NStack installation v1

Tower remains the shared data/authentication authority. Installation lifecycle is
an additive host-owned Compose bundle, separate from Autopilot's agents/apps.
The backend never receives a Docker socket, arbitrary command runner, mount path,
or image selection capability. Existing production Compose remains unchanged.

## Bootstrap and claim

Before dependencies start, the local launcher creates protected durable bootstrap
state (0700 directory, 0600 files) containing unique database/storage credentials,
Tower identity and a random local claim code. Repeated launch reuses state.
The claim code is read only through local installation output, never a public API.
The API verifies NIP-98 including exact URL, method and payload hash, then uses an
exclusive durable claim file to select one administrator. Failed or replayed
claims cannot overwrite it. Explicit env-admin deployments disable claiming.
Claimed ownership is loaded before serving requests after recreation. Claiming
instance administration does not grant workspace membership or app consent.

## Controller boundary

Configure → validate → apply → verify → commit, with previous working settings
retained. A host controller accepts a fixed catalogue of components and typed
settings, never shell fragments, paths, environment maps or Compose arguments.
Only affected services may be recreated. A durable journal tracks pending,
applying, verifying, committed, rolled-back and recovery-required operations.
Database/storage credentials and service identities are bootstrap state, excluded
from normal settings and never rotated by editing a form. Env overrides are
visible and locked. Optional dependencies cannot block the core UI.

Readiness reports configuration, runtime health and local/FIPS/HTTPS reachability
separately. FIPS desired-enabled defaults true; missing daemon/permissions/peer
remain explicit unmet requirements, not installed/ready. Linux/macOS adapters
reuse existing native daemon identity. No second bridge: consumers use universal
endpoint-scoped `window.fipsTransport`, pin the advertised peer, and fail closed
when the selected FIPS service is unavailable. Internal DB/admin ports stay private.

## Workspace connection v3 (separate from legacy v2)

`nstack:workspace:v3:<base64url UTF-8 JSON signed Nostr event>`, at most 8192 bytes.
Event kind 30383, tag `["d","nstack-workspace-connection-v3"]`, service-key signed.
Content is JSON: `type: "nstack-workspace"`, `version: 3`, `service_npub`,
`workspace_id` (exact UUID), `workspace_service_npub`, optional `name`,
`transports: { https?: { url }, fips?: { peer_npub, host, port } }`,
`policy: { preferred: "https" | "fips", fallback: "none" }`.
At least one transport is required. HTTPS is a credential-free HTTPS origin;
FIPS host MUST equal the canonical checksummed `peer_npub` followed by `.fips`;
peer/host mismatches are rejected. Port is 1–65535.
No app namespace, access token, private key, membership grant or decrypted key.
Legacy v2 parsers and generation retain their existing semantics.

Event and content JSON must be compact canonical `JSON.stringify` output: duplicate
fields, unknown keys, whitespace variations and noncanonical base64url are rejected.
Event keys are kind, created_at, tags, content, pubkey, id, sig (order retained by
the signer). No signature expiry is implied: stale routes must fail identity checks.
QR display is separately capped at 2200 ASCII bytes and must pass the encoder;
copy/paste accepts up to 8192. Oversized QR returns `qr_payload_too_large`.

Verify signature and strict shape locally before presenting confirmation. The
signature binds metadata to the stated key; initial trust comes from the QR
source or an existing pin. On the selected transport perform an authenticated
identity challenge and exact authorized workspace UUID/authority check. A health
string alone is not proof. Reject mismatches and denial without workspace/server
substitution; proceed through the consuming app's existing namespace/consent
flow. Copy and QR carry identical bytes. Discovery or HTTPS resolution is never
needed to decode FIPS-only metadata. No automatic fallback after FIPS selection.

Architecture basis: Wingman Suite Architecture local v7: Flight Deck coordinates,
Autopilot runs work, Tower mediates shared state; universal browser FIPS transport
consumers share the same pinned native capability above which auth remains separate.

## Authenticated identity challenge

GET `/api/v4/flightdeck-pg/workspaces/:workspaceId/connection-proof?nonce=<nonce>`
uses normal user NIP-98 and workspace.read permission, independent of consumer
app registration. Nonce is 32 random bytes as 64 lowercase hex characters,
generated afresh by the consumer. Response `{ proof: <Nostr event> }` has kind
30384, sole tag `["d","nstack-connection-challenge-v1"]`, and content JSON
`{ nonce, service_npub, workspace_id, workspace_service_npub, request_url,
expires_at }`. Service signs after exact workspace authorization. `request_url`
is the effective full URL signed by NIP-98; expiry is current time +60 seconds.
Consumer verifies signature, expected service key, fresh nonce, exact URL, expiry
and the QR's exact UUID/authority. Never reuse a challenge nonce or accept a
proof for another endpoint/workspace. Denial never triggers workspace creation.

Generation: GET `/api/v4/flightdeck-pg/workspaces/:workspaceId/connection-envelope`
requires workspace.manage. Uses only configured public transport metadata and
returns `{ envelope, qr_available }`. No advertised route yields 409
`connection_transport_unavailable`; local HTTP is deliberately not put into a
public connection QR. Consumer app identity is not embedded.

Legacy v2 generation returns `409 legacy_connection_requires_https` on a FIPS-only
installation instead of emitting an invalid empty-HTTPS token. Configured legacy
installations retain their existing v2 bytes and app namespace semantics.

`workspace_service_npub` is the exact durable authority identifier from the
workspace record. Historical Tower workspaces derive its 32 bytes from a hash;
it need not lift to a secp256k1 curve point. Consumers validate canonical
NIP-19 checksum/encoding and exactly 32 bytes for this field, then compare it
unchanged in proof and authorized workspace records. Do not replace it with a
new signing key or reject existing workspaces for lacking a curve point.
`service_npub` and FIPS `peer_npub` remain actual cryptographic identities;
service signatures, peer pinning, and all nonce/UUID/authority equality checks
remain mandatory.
