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

Setup saves this file as soon as the running Tower can read its durable bootstrap
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
