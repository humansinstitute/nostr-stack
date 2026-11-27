# NStack SeaweedFS image

NStack runs SeaweedFS 4.55 with one compatibility patch. This directory is the complete,
reproducible recipe; the stock upstream image is never pulled or substituted.

## Why the patch exists

SeaweedFS stores an S3 object's `Content-Type` in the filer entry. The filer store wrapper
(`weed/filer/filerstore_wrapper.go`, `normalizeEntryMimeForStore`) blanks an explicit
`application/octet-stream`, and S3 GET/HEAD (`weed/s3api/s3api_object_handlers.go`,
`setResponseHeaders`) then guess a type from the key extension. A generic-binary upload named
`index.html` is therefore served as `text/html; charset=utf-8` (likewise `.svg`, `.json`, `.js`,
…), which breaks exact metadata parity with MinIO and lets browsers render user files inline.

`patches/0001-s3-serve-octet-stream-for-empty-mime.patch` makes S3 GET/HEAD serve
`application/octet-stream` when the stored type is empty. It only changes the read path:
stored data and metadata are unchanged, explicitly stored types are served as before, and signed
`response-*` overrides still apply. The patch adds `TestSetResponseHeadersServesOctetStreamForEmptyMime`,
which fails on unpatched upstream.

## Provenance (all pinned)

| Input | Pin |
|---|---|
| Upstream image (base layers, Rust binaries, entrypoint) | `chrislusf/seaweedfs@sha256:7ca46aeae2f223b37e5d91593c17ab37738eec6df6ab69b48a0487f7643342b9` (tag 4.55) |
| Upstream source | commit `a98c9e27185cf1003eca095761a39973c60734db` (tag 4.55), codeload archive sha256 `8434a362a0e2224c10bed92553218635d3d93ece3c7f1e8111537d58c69b4a2a` |
| Go toolchain | `golang@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab` (go1.26.11, as in the upstream binary) |
| Go modules | upstream `go.sum` only (`-mod=readonly`, `GOTOOLCHAIN=local`) |

The resulting image is the upstream layer set plus one layer replacing `/usr/bin/weed`, built
with upstream's flags. The build runs the patched and upstream `TestSetResponseHeaders*` tests.

## Build, verify, save, load

```sh
bun scripts/nstack-seaweedfs-image.ts build          # prints the image ID (sha256:…)
bun scripts/nstack-seaweedfs-image.ts verify sha256:…
bun scripts/nstack-seaweedfs-image.ts save sha256:… <dir>   # tar + sha256 + provenance manifest
bun scripts/nstack-seaweedfs-image.ts load <dir>            # refuses a changed or corrupt archive
```

Installations reference the image by its **image ID** (`SEAWEEDFS_IMAGE=sha256:…`). Unlike a tag
or local RepoDigest, the ID survives `docker save`/`docker load` on containerd and classic image
stores, and Compose runs it with `pull_policy: never`.

## How installations use it

- **Migration (production Compose):** `nstack-migrate-storage-host.sh target-init` records the
  image ID and saves a validated artifact under the migration state directory before starting
  SeaweedFS; every start, publish and the cutover gate re-check the recorded ID and artifact. The
  config switch writes `SEAWEEDFS_IMAGE=<ID>` into the env file.
- **Updates:** `rebuild_deploy_docker.sh` refuses the `seaweedfs` profile unless `SEAWEEDFS_IMAGE`
  names a present, verified NStack image. It never builds or reassigns one silently.
- **Setup installations:** `nstack:setup` builds the image on first install, records its ID and a
  saved artifact under `.runtime/installations/<name>/`, and afterwards reuses exactly that image
  or fails closed.
- **Backups:** SeaweedFS backup sets (`scripts/tower-backup.sh`) include the exact image
  (`seaweedfs-image.tar.age`, ID in the manifest); restore loads it when absent.

## Upgrades and removal gate

Changing SeaweedFS (a new upstream release or patch) is an explicit change: update the pins,
rebuild, re-run the MIME, security (E1) and migration qualification, and record the new image ID
in each installation. Drop the patch when upstream serves `application/octet-stream` for a stored
generic-binary object (the patch's test passes on unpatched upstream source); then rebase the
`FROM` pin and re-qualify the same way.
