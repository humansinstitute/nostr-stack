# GRasp operations and migration

GRasp owns Git storage, signed repository state and NIP-34 review events.
Tower owns shared workspace authority and safe service discovery. Autopilot
supplies stable broker signing capabilities; it must not receive exported keys.
Transport remains separate from authentication, including pinned FIPS access.

The private deployment is `docker-compose.grasp.yml`. The source pins and
reusable patches are in `deploy/nstack/grasp/source.json`. The repository reader
patch is required for installations migrating different Forgejo collaborator
sets into one private service. This source prepares the lifecycle and retirement;
it does not establish that an existing runtime has activated the changes.

## Reproduce the patched service

Use a clean checkout containing the exact public upstream commit from the source
manifest. The tracked patch includes source, configuration, Nix, documentation
and unit/subprocess tests. `scripts/grasp/build.sh` archives that commit and
applies the tracked patch into a new ignored directory, avoiding local changes:

```sh
scripts/grasp/build.sh prepare /path/to/ngit-grasp "$PWD/tmp/docs/handoffs/grasp-build"
scripts/grasp/build.sh test /path/to/ngit-grasp "$PWD/tmp/docs/handoffs/grasp-build"
scripts/grasp/build.sh image /path/to/ngit-grasp "$PWD/tmp/docs/handoffs/grasp-build" nstack-grasp:3.0.1-access
```

Use the supported Rust toolchain for the lockfile (tested with Rust 1.98).
Integration tests need a canonical temporary path; the script provides it.
Inspect the resulting image digest and set `GRASP_IMAGE` to that immutable digest.
The old unpatched image is unsuitable for repository-specific access.

The GitWorkshop managed-start patch is separately pinned in the same manifest.
It adds `start` using the existing production static server, preserving the
assigned WApp port and built assets. Apply it only to its pinned base. Validate
through that repository's required precommit workflow. On Node versions with
experimental Web Storage, the test environment may require
`NODE_OPTIONS=--no-experimental-webstorage`. An upstream write denial does not
permit an unreviewed fork; this tracked patch remains reproducible NStack source.

## Explicit access and persistence

Copy `deploy/nstack/grasp.env.example` into ignored handoff storage. Preserve the
existing volume and canonical origin; never substitute an empty volume. The
service identity is generated and retained inside its data volume. Do not read
or print its key. Keep Sync+, GRASP-06 and external discovery disabled.

`GRASP_READERS_FILE` is a JSON object mapping each exact `npub/repository`
coordinate to its approved reader npubs. Every entry includes its owner. All
readers must also be service members. Unknown coordinates deny access. There
is no implied workspace-to-repository permission expansion. Include existing
repositories with their reviewed readers before activation.

The manifest narrows both Git reads and relay delivery, including broad queries
and publication. It does not confer canonical maintainer/write authority.
NIP-34 maintainership continues to govern canonical writes. Scoped COUNT and
negentropy are disabled to avoid existence leaks; replies must carry their
repository `a`/`A` coordinate or fail closed. This limitation must be reviewed
for older clients before cutover. ACL changes currently require an approved
service recreation, terminating existing sessions. Copies already downloaded
cannot be revoked.

Review native Forgejo account IDs, immutable OIDC subjects, team membership,
collaborators and protections when constructing a manifest. Never infer an
identity from a display name, avatar or guessed Nostr profile. An unresolved
identity or a missing approval/deployment equivalent blocks consumer cutover.

Validate without mutation:

```sh
docker compose --env-file /ignored/grasp.env -f docker-compose.grasp.yml config --quiet
```

For recovery, capture a clean stopped-writer backup of the complete service
volume and reader manifest, with private permissions and checksums. It contains
opaque service identity state and must remain private. Restore only into a new
isolated volume using the same image, no published ports and `--network none`.
Compare public identity, signed repository/review events, refs and reachable
objects; run `git fsck`. Never inspect the private key. Reattach the real volume
only with the supervising owner's activation approval. A Git-only mirror does
not prove relay/identity recovery.

## Ordinary agents

Set `AUTOPILOT_REPO` to the installed checkout; use the calling session's broker
capability. The commands do not accept raw keys or tokens and do not write
credential files. Exact repository-root NIP-98 proofs stay in short-lived Git
child environments; broker credentials never enter those children. Redirects,
proxies, inherited Git helpers and hooks are disabled. Explicit rate-limit
responses receive at most three attempts within a 60-second wait budget;
permission denials and network/publication writes are never blindly retried.

```sh
bun scripts/grasp/git.ts clone ROOT /path/to/new-clone
bun scripts/grasp/git.ts fetch ROOT /path/to/clone
bun scripts/grasp/git.ts refs ROOT /path/to/clone
bun scripts/grasp/git.ts push ROOT /path/to/clone review/my-change
bun scripts/grasp/git.ts review-create ROOT /path/to/clone review/my-change main 'Title' /path/to/body.md
bun scripts/grasp/git.ts review-list ROOT /path/to/clone
```

`ROOT` is the canonical `https://host/npub/repository.git` or pinned HTTP FIPS
root. Pushes retain advertised refs and require fast-forward; no force, mirror
or deletion mode exists. Create a review branch and PR before merging protected
work. The current client does not emulate Forgejo branch approvals, status checks
or deployment hooks; those require explicit replacement verification. Ordinary
members may read and create authorized review events; only the coordinate owner
publishes canonical state through this wrapper. Other maintainer delegation
needs its own reviewed authority, not owner impersonation.

A GitWorkshop page served over HTTPS requires the host's real FIPS capability
for a selected FIPS service. A successful static page request does not prove
browser Git/auth/review operation; test the actual native host and member signer.

## Preserve and migrate

`scripts/grasp/forgejo-export.ts HTTPS_ORIGIN NEW_IGNORED_DIRECTORY owner/repo.git`
uses the native broker login in memory. It enumerates all visible repositories
with pagination, mirror-clones refs, runs integrity checks and exports issues,
PRs/comments/reviews, releases/assets, wiki when available, teams, collaborators,
protections and hook topology. Webhook credentials are deliberately omitted;
retain existing protected provider configuration for rollback/reconnection.
Unsupported endpoints are recorded as unavailable, never interpreted as empty.
LFS histories trigger an all-object export. Submodule entries and historical
`.gitmodules`/attributes are inventoried. This GRasp image has no LFS endpoint:
a repository needing it cannot cut over until a supported LFS destination passes.

Use the explicit snapshot importer with a reviewed config SHA256:

```sh
bun scripts/grasp/migrate.ts plan CONFIG SHA256
bun scripts/grasp/migrate.ts publish CONFIG SHA256
bun scripts/grasp/migrate.ts verify FRESH_VERIFY_CONFIG SHA256
```

The config binds source, destination and optional description. Unsupported
provider refs require an exact `exportedRefs` manifest and retained mirror;
branches/tags and the complete reachable object set must still match. Import
refuses existing coordinates. It signs exact announcement/state, pushes explicit
refs, freshly clones, compares refs/objects and reads back signed state. A saved
publication attempt blocks blind repetition. After inspection, `resume` permits
only matching saved signed events and destination refs; concurrent changes stop
it. `verify` requires a fresh evidence directory and changes no remote state.

`scripts/grasp/verify-private.ts CONFIG` independently verifies populated member
reads plus anonymous and disposable-nonmember read/push/relay denials. Fixture
keys remain in memory and are only rejection evidence. Reader-specific access
must also be verified on the patched deployment, not inferred from service denial.

Keep source repositories, opaque metadata backups and volumes. Recheck source
refs for concurrent changes immediately before cutover. Preserve original
remotes in the ignored rollback inventory; change consumers only after actual
destination access, Git/review and recovery checks. Stop legacy services only
after active consumers and public repositories have migrated. Never use
`docker compose down -v` or `--remove-orphans` to retire them.

## Public repositories

`docker-compose.grasp-public.yml` prepares a separate public-read service with
its own public-only volume, exact repository whitelist and independent origin.
It never mounts the private service's volume, reader manifest or membership.
Public mode permits anonymous Git reads while signed NIP-34 state governs writes.
Do not switch the private service into public mode.

Choose and provision a canonical HTTPS host/TLS route before announcement and
migration. Options are a new HTTPS hostname on the current host with the
loopback ingress, or an independent CapRover GRasp app with its own persistent
volume. The latter needs explicit hosting/deployment approval. Keeping existing
public Forgejo sources temporarily preserves access while that choice is made.
Do not silently turn public repositories private or publish private data.
