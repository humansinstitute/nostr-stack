# Optional modules in progressive NStack setup

The setup controller can create, configure, probe, stop, re-enable and replace
four optional services independently of the local Tower UI. All are off by
default. This is an additive fresh-install lifecycle; it does not adopt the
production Compose services or attach their existing volumes. Updating this
source does not activate any service.

The host controller owns `createModuleRuntime({project})`; Tower must never
receive its Docker socket. Public settings pass through
`validateModuleSettings()` and contain only the full typed configuration below:

```typescript
{
  graph: { enabled: false },
  relay: { enabled: false, origin: '', publishers: [] },
  blossom: { enabled: false, origin: '', publisher: '' },
  git: {
    enabled: false, origin: '', members: [], maintainers: [],
    repository_readers: {}
  }
}
```

Identities are lowercase 64-character hex Nostr public keys. A private Git
repository reader map uses canonical `npub/repository` coordinates and hex reader
keys; every coordinate must include its owner, and every reader and maintainer
must already be a service member. This narrows membership and never grants Git
write authority. Empty configuration cannot be enabled. Unknown properties,
secrets, env maps, commands, paths, mounts and image selections are rejected.
Settings edits do not rotate graph credentials or any service identity.

## Controller integration

`MODULE_CATALOGUE` exports the fixed image, internal port, loopback port,
protocol and root path. `moduleEnvironment(settings)` supplies public discovery
environment only. `defaultModuleSettings()` creates independent defaults.

`runtime.apply(previous, desired)` reconciles affected services and returns
`committed`, `rolled_back` or `recovery_required`, with a safe error code when
applicable. The caller must inspect this result. The controller must serialize
operations in its durable settings/operation ledger. `runtime.verify(settings)`
returns a boolean; `runtime.status(settings)` reports desired/configured/runtime
separately and converts unavailable Docker into explicit per-module status.
Module failures must not prevent serving the local installation UI.

After successful module apply, call `runtime.connectTower(settings)` to attach
only the unique current container with the exact installation project and
`com.docker.compose.service=tower` labels. This method validates every network's
module/project ownership; it never accepts a caller-selected container/network.
It disconnects disabled module networks without touching other networks. Call
it again after Tower container recreation and after a controller-level rollback.

For enabled graph, the controller calls `runtime.graphEnvironment()` and stores
its returned graph-only credentials in protected local state (0600), excluded
from settings APIs, public status and operation journals. Tower must load this
before config evaluation and run its existing graph migrations. Only the
controller obtains these credentials; sidecars receive no Tower bootstrap
credentials, signing keys or storage keys. The graph database's own readiness
is distinct from successful Tower graph schema migration. The controller must
verify Tower graph integration separately before claiming that feature ready.

| Module | Container port | Host loopback port | Protocol and path |
| --- | --- | --- | --- |
| graph | 5432 | none | private PostgreSQL, internal network |
| relay | 8080 | 17777 | HTTP NIP-11 + WebSocket at `/` |
| blossom | 3000 | 13002 | full Blossom HTTP origin at `/` |
| private Git | 7334 | 17334 | NIP-11/WebSocket + Git smart HTTP at root |

Network names are `<project>-module-<name>-network`; DNS aliases are
`nstack-module-<name>`. Graph uses an internal Docker network and publishes no
host port. Module ingress bindings are fixed to `127.0.0.1`. Host ingress/FIPS
integration belongs to the controller and must forward the correct service
port, preserve WebSocket upgrades and the canonical Host/authentication URL,
and leave private database/admin ports unexposed.

## Endpoint-scoped transport

Relay origins use `wss://`; Git and Blossom use `https://`. Loopback development
supports `ws://`/`http://`. FIPS-only service origins may instead use
`ws://<canonical-checksummed-npub>.fips:<port>` or
`http://<canonical-checksummed-npub>.fips:<port>` with an explicit service port.
Invalid peers and arbitrary cleartext remote hosts are rejected. Each service
has its own root origin, including when several ports share the same FIPS peer.
The client pins that endpoint's peer through universal `window.fipsTransport`;
a failed selected FIPS endpoint does not trigger implicit HTTPS fallback.
Local module probes do not attest remote HTTPS/FIPS reachability or ownership.

Blossom has a full dedicated root origin. It does not replace Tower's ACL blob
routes, change their authorization or publish private Tower attachments. Upload,
mirror, delete, list and media auth reuse `deploy/nstack/blossom.yml`; uploads are
restricted to the configured public publisher. Relay reuses the deployed
SQLite/allowlist/NIP-42 settings, with a setup renderer permitting validated FIPS
origins. Private GRasp uses the reviewed repository-readers patch, NIP-42 and
repository-scoped NIP-98. Public GRasp lifecycle and migration boundaries remain
unchanged; it cannot be enabled by this private Git module.

## Resources, rollback and recovery

Resource names and labels bind every container, network and volume to an exact
installation project and module. A name collision with missing/different
ownership labels fails closed. Docker list results never authorize broad
cleanup. The runtime never deletes volumes or networks, uses bind mounts, runs
Compose, removes orphans, exposes a Docker API, or pulls a caller-selected image.
It resolves the fixed digest to an immutable image ID before stopping an old
service. Missing published graph/relay/Blossom images are pulled only from the fixed digest catalogue before any existing service is stopped. Pull failure is explicit; no caller can select an image. Private Git is a separate reviewed distribution requirement.

Each module has its own durable `-data` volume. Graph additionally has a
protected `-state` volume containing distinct generated admin/app passwords.
If graph data already exists without those credentials, startup fails and
requires restoring the state backup; it never silently rotates credentials.
Config volumes use a public-configuration hash suffix so replacements cannot
overwrite the previous container's config. Back up graph data/state together;
back up Git data including its generated service identity and reader manifests.

Disable stops the existing container and retains its ID, volumes and identity.
A configuration update stages a replacement, retaining the stopped previous
container until all desired services pass probes. A failure restores prior
containers and running states. Interrupted replacements with a `-previous`
container are restored before retry. The controller's durable ledger determines
whether to retry desired settings or reapply previous settings. Failure to
restore is explicit `recovery_required`; failures to remove committed backup
containers are returned as `cleanupPending`, never hidden as deletion success.
No automated data pruning is performed.

Probes check graph authenticated SQL plus AGE availability; relay HTTP NIP-11;
Blossom root plus rejected anonymous upload; and Git NIP-11 with advertised
NIP-42. These are local readiness checks, not comprehensive protocol audits.
The disposable live test additionally verifies relay rejects non-allowlisted
signed events and private Git rejects anonymous repository reads.

## Image provisioning and validation

Lifecycle apply automatically provisions missing published graph/relay/Blossom images from the fixed digest catalogue. It streams bounded progress and refuses registry errors before interrupting an existing service. The optional operator preflight `deploy/setup-modules/prepare-images.sh` checks the same catalogue; it is not needed for ordinary UI setup.

Private Git's fixed `nstack-grasp@sha256:4aaf778f0bf938745821a146e20dadd48b6b677138bd3350384807ddb1b72194`
is a locally prepared reviewed build, not a publicly provisioned registry image.
It must be imported from the reviewed image distribution before enable. The
source catalogue is `deploy/nstack/grasp/source.json`; the upstream revision,
patch checksum and `scripts/grasp/build.sh` describe the build. A new build may
have a different image manifest digest; publishing it and updating the trusted
catalogue are release work, never a public settings form operation. Do not
substitute the unpatched upstream image. The digest and private patch label are
both checked before startup. A fresh host lacking this build reports a specific
provisioning requirement; other modules remain independent.

Blossom's pinned Deno image may download dependencies on cold startup. Its
bounded executable native-module cache mirrors the existing production config;
a network/dependency outage remains an explicit readiness failure. Host port
collisions likewise fail apply and roll back; existing listeners are untouched.

```sh
bun test tests/installation-modules.test.ts
NSTACK_MODULE_DOCKER_TEST=1 bun test tests/installation-modules.test.ts
```

The second command requires the fixed images and free loopback ports above. It
creates a unique disposable project, checks all four real services, auth denial,
stop/re-enable persistence, protected graph credential persistence, injected
replacement failure/rollback and exact Tower network attachment. Cleanup is
limited to newly created resources carrying that unique project's labels.
Tests never restart the existing Tower stack. The supervising manager must
separately rebuild/restart the authorized local Tower installation and run its
integration smoke checks before declaring shared-runtime validation complete.
