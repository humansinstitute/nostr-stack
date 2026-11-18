# NStack (Nostr Stack)

Your shared business and agent memory.

NStack is a standalone Nostr-authenticated service for people, agents and apps to
share workspace data. It provides identities and access control, typed workspace
APIs, compatibility record sync, file storage and optional graph capabilities.
The browser console at `/ui` supports workspace administration; `/admin` and
`/table-viewer` provide operator tools. Agents and applications use the same
access-controlled APIs without requiring a companion suite.

This repository contains the Bun API service, Postgres schemas, storage
integration, OpenAPI contract, browser console and administration tools.
NStack stores shared data and enforces permissions; agent process supervision
and application-specific interfaces belong to clients.

## Runtime notes

The portable Docker bundle provides NStack, Postgres, MinIO, a persistent Nostr
relay and a full Blossom server. GRasp is the Git/review component, with a
separate private lifecycle in `docker-compose.grasp.yml`. It authenticates
members with NIP-42 and repository-scoped NIP-98; NStack publishes explicit
service discovery metadata. See [GRasp operations](docs/grasp.md) for the pinned
source patch/build, broker agent commands, access controls and migration gates.

Forgejo OIDC, proxy and runtime configuration are retired from the new source.
Existing installations must finish the documented migration and activation
gates before deploying this removal. Source and volume backups remain available
for rollback; updating source does not retire a running service.

Nostr Browser and other consent boundaries can inspect the safe public service
catalogue at `/.well-known/nstack.json`. See
[NStack services](docs/nstack-services.md) for the relay/Blossom boundary,
protocol surface, routing and activation checks.

## Protocol Docs

The current V4 compatibility protocol drafts live in:

- `SBIPS/`

These proposals formalize the implemented NStack contract for auth, workspaces,
groups, record sync, storage, service discovery, and connection/bootstrap packaging.

[NBrowser workspace backup v1](docs/contract/nbrowser-workspace-backup-v1.md)
defines the selected-workspace private ciphertext and per-user recovery-pointer
contract for NBrowser, including owner-managed namespace registration.

## Progressive new installation

The additive [NStack setup bundle](docs/nstack-setup.md) starts local administration
without an authored env file, generates durable credentials/identity and safely
claims the instance with Nostr. It preserves existing production deployments.
For repeated source testing, use the [clone/pull workflow](docs/nstack-launcher.md#test-from-one-git-clone) with host Bun and the same installation name.
Remove disposable installations with `bun run nstack:rm <project> --dry-run`
then `bun run nstack:rm <project>` (data retained); explicit `--purge` permanently
deletes their data and identity. See the [removal guide](docs/nstack-launcher.md#remove-an-old-test-installation).

[Optional module lifecycle](docs/nstack-modules.md) covers graph, relay, Blossom
and private Git configuration, probes and rollback. Source availability is separate
from shared-runtime activation and remote/device acceptance.

## Production

Optional, explicitly configured mesh transport is documented in
[NStack FIPS ingress](docs/fips-ingress.md). It shares the existing app/database
and leaves public HTTPS in place.

Production deployment notes and the Docker Compose stack live in:

- `docs/prod-deploy.md`
- `docs/caprover-deploy.md`
- `docs/backup-and-restore.md`
- `.env.prod.example`
- `docker-compose.prod.yml`

NStack also exposes an admin web at `/admin` for `ADMIN_NPUB` users. It can inspect workspaces, create Postgres-backed workspaces, inspect tables, manage the public NStack profile, and generate workspace connection tokens for compatible record-sync and agent clients. The older table-focused view remains available at `/table-viewer`.

## WApp feed reader state

[Implemented T1 source API](docs/contract/wapp-feed-t1-api.md) describes personal subscriptions,
flags, CAS/idempotency and PG recovery. The [proposed integration contract](docs/contract/wapp-feed-v1-proposed.md)
remains the baseline for other packages. Source implementation is not live activation;
legacy publishing remains intact.

## Opt-in device sync checkpoints

[Record device checkpoints v2](docs/contract/record-device-checkpoints-v2.md)
documents the NStack-only durable checkpoint extension, signed acknowledgements,
retention policy and separate Flight Deck integration follow-up. Existing v1
record-sync clients retain their current behavior.

## Negotiated bounded snapshots

[Bounded record snapshots v1](docs/contract/bounded-record-snapshots-v1.md) adds
opt-in v2 finite committed handover certificates and authenticated <=256 KiB
chunks for oversized canonical rows or actor sidecars. Whole JSON pages retain
the 1 MiB/200-entry limits. Existing v1, v2 and legacy sync remain compatible.

## Additive record access

[Additive record access v1](docs/contract/additive-record-access-v1.md) preserves
record cursors/checkpoints through channel and permission changes, catches up
newly readable history by partition, and retains prior downloads after access loss.

## Priority sync and compact repair

[Priority record sync and manifest repair v1](docs/contract/priority-record-sync-v1.md)
adds an independent newest-first working-set feed, authorized context closure,
stable compact repair manifests, and selective canonical body repair. These
supplements never advance the v2 completeness checkpoint or delete by omission.

[Existing-cache adoption v1](docs/contract/record-cache-adoption-v1.md) lets a
registered v2 device prove its retained cache against one captured unfiltered
manifest, selectively repair only mismatches, and atomically establish a durable
delta checkpoint without retransmitting matching canonical bodies.

## Personal attention

[Personal attention v1](docs/contract/personal-attention-v1.md) documents the
additive task/document attention metadata, persisted personalized view projections,
existing-row backfill and independent user read/device checkpoint behavior.

## Message reference lookup

[Flight Deck message references](docs/contract/flightdeck-message-reference-lookup.md)
documents the narrow authorized message/owning-thread lookup for uncached links,
its error and branch semantics, and the separate runtime activation check.

## USD hosting billing

[USD prepaid hosting v1](docs/contract/hosting-billing-usd-v1.md) describes customer/workspace linking, exact byte-hour charges, the durable NStack runtime runner, Stripe test-mode top-ups, and the explicit live rollout gate. Existing workspaces remain safely unlinked.

## Workspace membership administration

[Workspace membership administration v1](docs/contract/workspace-membership-administration-v1.md) defines explicit owner-controlled agent-manager coverage, exact-identity removal previews, durable authorship, revocable private downloads, enrollment tombstones and NStack-first activation. Installing the feature does not remove or grant access to any real identity.

[Canonical workspace General v1](docs/contract/workspace-general-v1.md) defines explicit owner opt-in, durable channel identity, automatic all-member access and reuse of existing invite/DM APIs.

## Concurrent document editing

[Concurrent document sessions v1](docs/contract/document-concurrent-edit-v1.md)
adds opt-in concurrent human/bot editors with persistent peer tokens, existing
CAS/recovery saves, capability negotiation and explicit legacy-mode fencing.

[Android FCM notifications v1](docs/contract/notifications-fcm-v1.md) defines the default
Android push transport, protected Firebase configuration and generic OS alert contract.

## Compatibility names

NStack retains existing machine names so installed clients and data continue to
work. These names identify compatibility contracts, not additional products:

- `SUPERBASED_*`, `TOWER_*` and `COWORKER_BE_PORT` environment settings remain supported.
- `tower_*` JSON fields, `/api/v4/admin/tower`, OpenAPI schema names,
  `superbased_connection`, `coworker_agent_connect`, `wingman_workspace_locator`,
  `org.wingman.*` schemas and `x-wingman-*` / `x-superbased-*` headers keep their meaning.
- Compose services/projects/containers, database names, buckets, volumes, backup
  formats and external URLs retain their existing names. Changing product copy
  does not migrate, rename or restart an installation.
- Flight Deck, WApp, Autopilot, Yoke and GRasp references in API/operations docs
  describe integrations or existing operational tools. Their implementations
  remain available; they are not prerequisites for standalone NStack onboarding.

See [branding compatibility](docs/branding-compatibility.md) for the retained-name
inventory and the separate runtime migration boundary.
