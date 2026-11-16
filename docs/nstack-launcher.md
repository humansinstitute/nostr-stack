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
starts. No env editing is required. The launcher prints the local claim code,
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
and every shipped file's SHA256. The shell checks platform and runtime SHA before
executing Bun; JavaScript checks source/assets before launching any operation.
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
