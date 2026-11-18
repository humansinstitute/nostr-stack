# Self-contained host launcher

The release packager creates a versioned `.tar.gz` containing the Bun executable,
dependency-free host JavaScript, FIPS installer scripts, and committed source for
the Compose build. Operators do not install Bun, Node, Git or npm packages on the
host. Docker with Compose remains the preinstalled application runtime requirement;
normal macOS/Linux shell utilities and user-service facilities must be available.
Container images/dependencies still need network access on a cold installation.

Candidates support **macOS arm64** and **Linux arm64 (glibc)** only. A Linux
archive checked in Docker is not acceptance on a fresh Linux desktop, systemd user
session, reboot or remote device. Other platforms fail closed; a matching pinned
runtime and separate validation are required before adding them.

After obtaining a reviewed archive and checksum through the release owner's
trusted distribution channel, compare SHA256 before extraction:

```sh
shasum -a 256 nstack-launcher-<version>-darwin-arm64.tar.gz
tar -xzf nstack-launcher-<version>-darwin-arm64.tar.gz
cd nstack-launcher-<version>-darwin-arm64
./nstack verify
./nstack setup my-installation
```

Linux can use `sha256sum`. Keep the same installation project name on later
starts. No env editing is required. The launcher saves the local URL and unused claim code in a private text file,
starts Compose and registers its persistent OS user helper. The helper uses the
bundled runtime's absolute path and a hash-named script/assets snapshot.
**Keep the extracted folder at its selected location** while registered; moving
or removing it breaks the runtime path. Stop/uninstall before moving, then install
from the new location. Closing the terminal does not stop the helper.

```sh
./nstack host status
./nstack service status my-installation
./nstack service start my-installation
./nstack service stop my-installation
./nstack service uninstall my-installation
./nstack service install my-installation
```

Stop/uninstall affects only that project helper, retaining data and the shared
FIPS daemon. A fresh host FIPS install requires an administrator's signed UI action
and normal OS authorization. Docker does not silently install host software.
Existing daemon identity/control-access failures remain repair cases. User agents
resume on login; Linux before-login operation requires the operator's explicit
linger policy. See [setup](nstack-setup.md) for claim and transport rules.

## Integrity and signing status

These archives are **unsigned release candidates**: no archive signature,
Developer ID launcher signature, notarization or Gatekeeper acceptance is claimed.
The copied macOS Bun executable retains its upstream signature; that does not
sign this launcher or archive. Gatekeeper/quarantine and OS security prompts still
apply. Use normal OS review/authorization; the launcher never disables quarantine,
bypasses Gatekeeper or requests unattended privilege escalation.

`bundle.json` records source commit, runtime version/SHA/provenance, signing status
and each payload file's SHA256. The shell pins the runtime, verifier and manifest
hashes before executing Bun; JavaScript checks source/assets before launching
any operation. The separately distributed archive checksum covers the shell too.
Checksums detect corruption relative to the reviewed archive, not publisher
identity. Obtain the archive/checksum from a trusted release channel.

## Build a candidate (release builder only)

The builder needs Git, Bun, installed locked dependencies and a clean committed
checkout. It never downloads a runtime. Supply an explicit reviewed public runtime
executable, matching platform, expected SHA256, exact version and provenance:

```sh
bun scripts/package-nstack-launcher.ts \
  --version 0.1.0-rc.1 --platform darwin-arm64 \
  --runtime /reviewed/path/bun --runtime-version 1.4.4 \
  --runtime-license /reviewed/path/Bun-LICENSE.md \
  --runtime-sha256 <reviewed-64-character-sha256> \
  --runtime-provenance 'Bun upstream release; reviewed signature and executable hash' \
  --out /private/review-output
```

The packager takes source from `git archive HEAD`, bundles host dependencies at
build time, removes its temporary dependency link, excludes operational state,
and writes an archive plus `.sha256`. Output must be outside tracked source or
ignored. It rejects dirty/untracked source, invalid runtime hashes, wrong binary
architecture, symlinks and unsupported platforms. It never reads private runtime
state, signs, uploads, publishes or activates services. Runtime version is checked
when the bundle runs; cross-platform candidates need a matching execution check
before review. Include upstream license notices in the release distribution
(Bun: https://github.com/oven-sh/bun/blob/main/LICENSE.md).

Verification covers packaged paths without host Bun/Git/node_modules, source
mutation and runtime corruption rejection, and exact user-service snapshots.
Cold registry downloads, fresh host FIPS installation, Linux service persistence,
reboot, Gatekeeper and remote/mobile acceptance are separate release gates.

## Cold builds and retry safety

Setup checks Docker/Compose before touching the installation, downloads the external
Postgres runtime, and builds the application and storage images before starting
services. Controller and storage initialization use those local images with pulls
disabled. A failed download/build exits with the original dependency error; retry
`./nstack setup <same-name>` after connectivity returns. Keep the same project name:
its named volumes retain generated credentials, service identity, claim and data.
Setup never runs `down -v`, prunes Docker caches, or adopts other projects' volumes.

MinIO CE's Docker Hub images are no longer available, and the checked Quay releases
deny anonymous pulls. The setup bundle therefore builds **unmodified official
sources**, rather than requiring a registry account or substituting another storage
engine. `docker/Dockerfile.setup-storage` pins the server release
`RELEASE.2025-10-15T17-29-55Z` (commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`)
and client release `RELEASE.2025-08-13T08-35-41Z`
(commit `7394ce0dd2a80935aded936b09fa12cbb3cb8096`) with archive SHA256 checks.
The image retains both corresponding source archives and AGPL license notices in
`/usr/share/nstack-storage/`. Existing MinIO volume layout and bucket privacy are
retained. Source and build instructions: [server](https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a),
[client](https://github.com/minio/mc/tree/7394ce0dd2a80935aded936b09fa12cbb3cb8096).
MinIO CE is now unmaintained; this pinned compatibility build is not a promise of
ongoing upstream security support.

A cold setup needs access to Docker Hub (Bun, Postgres, Go and Alpine), GitHub source
archives, the Go module proxy/checksum service, and the locked Bun package registry.
The first storage compile can take several minutes and more memory than subsequent
starts. Go and build tools run inside Docker; no extra host tools or manual pulls
are required. Network or registry failures are reported as failures, never success.

## Recover after closing Terminal (rc.6 and later)

From the extracted install folder, run:

```sh
./nstack recovery my-installation
```

This prints the actual local setup URL and the location of
`nstack-my-installation-setup.txt` in that folder. Open the text file to get the
unused first-administrator claim code. The file is written atomically with mode
`0600` (your OS user only). Each project has its own file, bound to its durable
service identity; recovery refuses symlinks, hardlinks and unrelated preexisting
files instead of overwriting them. Keep the folder and file private.

Setup saves this file as soon as the running NStack can read its durable bootstrap
state, while Compose may still be waiting for readiness, and refreshes it before
registering the host helper or printing success. The file records readiness at the
last check. If Terminal closes or Ctrl-C interrupts startup before this point, no
success or saved file is promised. Run recovery to check; if the installation is
stopped or absent, rerun `./nstack setup my-installation` with the **same name**.
This reuses credentials, identity, claims and volumes. Recovery itself only reads
Docker installation state and writes the local text file: it does not start,
build, pull images, reset credentials or change administrators. Docker must be
available. An unhealthy/starting container is reported as not ready, with its
known URL rather than a guessed default port.

For an already successful rc.5 installation whose terminal output was lost,
extract rc.6 into its own folder and run `./nstack recovery <existing-project>`
against the same Docker context. No setup rerun, network access or rebuild is
needed while that installation is running. The recovery file is written into the
rc.6 folder. Keep the rc.5 folder in place if its host helper is still registered;
recovery does not migrate that helper. Updating an existing archive in place is
not required. Setup reruns preserve a known existing local port unless you
explicitly set `NSTACK_LOCAL_PORT`; recovery always reports the actual binding.

The server enforces the claim's single use. After a successful claim, any copy of
the old code is rejected, and administration requires the existing administrator's
Nostr identity. The text file is **not monitored or automatically erased when the
claim occurs**. The next setup/recovery rewrites it with the URL and “already
claimed” status, omitting the code. Copies and backups may retain the now-useless
old code. Recovery never issues a replacement code or reopens administrator setup.

## Test from one Git clone

For source testing, install **Git, host Bun 1.4.4 and Docker with Compose** first
(on macOS, start Docker Desktop). Host Bun is an explicit source-development
prerequisite; release archives include their own runtime. No Node, authored env
file, manual image pulls or manual Docker commands are needed. Cold builds still
need the network services listed above.

Clone the public repository once, into a permanent folder:

```sh
git clone https://github.com/humansinstitute/nostr-stack.git
cd nostr-stack
bun install --frozen-lockfile
bun run nstack:setup my-nstack
```

For an existing rc.5/rc.6 installation, replace `my-nstack` with its **exact existing
project name**, use the same Docker context, and retain the old extracted folder
until the clone setup has succeeded and you have checked the installation. Setup
reuses that project's volumes, generated credentials, service identity, claimed
administrator and data, and preserves its known local port. It rebuilds the local
application and rebinds that project's OS helper to the clone's absolute Bun path
and versioned script snapshot. It never resets the administrator or issues a new
claim code after claiming. Keep host Bun and this clone at their selected paths.

To recover the URL/code from an already running installation before adopting it:

```sh
bun run nstack:recovery my-nstack
```

Recovery does not rebuild or rebind the helper. Until explicit setup from the
clone succeeds, the existing archive helper still references its old folder and
bundled runtime: keep that folder. Recovery saves the same private setup text file
in the clone; refresh after claiming to omit the old, now-invalid code.

For each subsequent update, from that same clone:

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run nstack:setup my-nstack
bun run nstack:recovery my-nstack
```

Run these commands in order, continuing only when each succeeds. If Git reports
local changes or a divergent branch, resolve those before installing/running;
never force-reset your checkout to update. If setup fails, keep both folders and
retry setup with the same name after addressing the reported error. Setup restarts
only that installation as needed, so existing connections may briefly disconnect.
Verify the reported URL, sign in with the existing administrator, and check your
workspace/files before removing the old archive folder. Pulling alone does not
activate new server code or move the helper. Archives remain available for users
who prefer a bundled runtime; no new archive download is required for this flow.

The first-admin page now displays signer connection/signing progress and asks you
to review the public identity **in the page** before signing. Cancel before sending
leaves the installation unclaimed; dismiss any pending external signer prompt
before retrying. After a send with an uncertain response, check status before
retrying. The server remains the authority for the one-time claim.

## Remove an old test installation

From your Git clone, use the **exact project name** supplied to setup:

```sh
bun run nstack:rm my-test --dry-run
bun run nstack:rm my-test
```

There is no default project. A project name identifies **one durable installation
across all source versions and folders**. If an old archive and your clone both
used `my-test`, removing it removes that installation, including the currently
running version. It does not select an old source version.

Default removal stops services (controller first) before removing containers.
Application containers get a 20-second Docker stop period; Docker may terminate
unresponsive application processes after that period, including old Bun PID1
runtimes. Optional relay, Blossom and Git modules may require crash recovery on
restart. Postgres, object storage and the graph database never receive automatic
forced termination: if they cannot stop gracefully within the bounded client
wait, removal fails with partial status and preserves remaining resources.
Running containers are never force-removed. The command uninstalls
that project's OS user helper, removes its
verified containers (including Compose orphans and controller-managed optional
modules) and networks, and preserves volumes, credentials, identity, private
files and recovery files. Run `bun run nstack:setup my-test` to recreate services
using the retained data and administrator identity.

For permanent deletion, preview first:

```sh
bun run nstack:rm my-test --purge --dry-run
bun run nstack:rm my-test --purge
```

**`--purge` permanently destroys verified exclusive installation volumes,
credentials, identity and data, plus matching private recovery files in the clone
and the verified helper's old archive folder (when still bound there).** The flag
is explicit deletion intent; no additional confirmation is requested. A subsequent
setup with that name creates a new identity and empty installation.

Dry run only inspects and prints exact resources; it never stops helpers or
writes files. Removal requires Docker inspection and user-service access, even
for an apparently absent installation. Shared volumes, foreign mounts/networks,
unknown helper bindings, unsafe symlinks and unowned or non-private recovery files
cause refusal. Recovery deletion verifies the public service identity from the
selected NStack (including stopped containers), or the Docker daemon and durable
bootstrap-volume generation binding written by current setup/recovery. A legacy
recovery file whose NStack container is already gone cannot be verified: run
setup/recovery with the same name on the intended Docker context first, then
retry purge. A file from a different context/identity is never deleted.
Resolve the reported attachment or file issue explicitly, then
rerun the same command. If a step fails after others completed, output identifies
the failed step and completed actions; a repeated removal safely handles what
remains. Stop other setup/controller operations before removal to avoid races.

Source/extracted folders, helper snapshots/logs, images, build cache, the shared
FIPS daemon and Autopilot are retained. Old recovery files in folders no longer
bound to the helper are retained; inspect and manage those private copies yourself.
The command never prunes Docker or traverses arbitrary folders to find old files.
