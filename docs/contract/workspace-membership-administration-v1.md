# Workspace membership administration v1

Tower owns authority; Ambulando renders the administration workflow. Release activation does not change any member or role. Canonical member labels are `flightdeck_pg_actors.display_name` together with the full npub; external Nostr profiles must not replace them. Similar names never imply identity equivalence.

## Explicit workspace agent-manager

`PUT /api/v4/flightdeck-pg/workspaces/{workspaceId}/members/{actorId}/agent-manager` accepts `{enabled, confirm_npub}`. Only the **current canonical workspace owner npub**, itself an active member, can assign or revoke this role. Existing `workspace.manage`, admin membership, agent kind, owner delegation in another service, or self-assignment cannot substitute for that authority. Human-kind legacy bot records are supported without changing their global actor kind. App/service actors are excluded.

The role covers workspace read/manage/invite, event subscription management and scope creation, plus the existing scope/channel permissions for every current and future scope/channel, including private channels. It does not grant personal daily notes, org data, napplet publishing/installation, another workspace, Autopilot control or global authority. Role scope is intentionally broad and must be presented before explicit confirmation.

Role rows generate ordinary actor grants tagged `workspace_role='agent-manager'`. New scope/channel database triggers generate matching grants before resource creation commits. Existing SQL visibility, sync partition, task, document, file and event queries therefore use the same grants as signed operation authorization. No legacy grant is reinterpreted and no existing actor is automatically assigned. Revoking the role revokes tagged grants; separately assigned pre-existing grants remain and are visible in inspection. Reapplying the role repairs missing tagged coverage. Deployment runs no role backfill.

`GET .../members/{actorId}/access` requires workspace.manage, even for self. It returns exact actor identity, membership, explicit role, canonical-owner administration ability and effective permission booleans for workspace and every active scope/channel. Ordinary self-inspection is forbidden because it would disclose private scope/channel names. Use requests signed as the intended identity to verify actual operations; an administrator's inspection is not proof of which signer a separate client used.

## Retirement

1. Canonical owner requests `POST .../members/{actorId}/removal-preview` with `{}`.
2. Tower returns exact actor, membership, groups, direct/inherited grants, role, subscriptions, consequences and a ten-minute random confirmation token. Self and every owner identity are protected; ownership transfer requires a separate future flow.
3. Owner sends `POST .../members/{actorId}/remove` with `{confirmation_token, confirm_npub}` using the full target npub.
4. One transaction locks authority state, rechecks owner and target identity, consumes the requester/workspace/actor/state-bound preview, records the audit snapshot/tombstone, revokes workspace publication authority and deletes active membership. Stale/expired/replayed tokens fail closed.

Membership deletion cascades direct/group/role and subscription authority. Historical actor identity, messages, documents, tasks, authored attribution, audit events, published-history attribution and other workspaces remain. Historical/pending assignee and agent installation records confer no access and are not transferred to a similarly named actor. Existing self/owner protection prevents last-owner lockout.

A permanent workspace/actor retirement tombstone prevents bootstrap or retained subscriptions from recreating access. Only explicit authorized enrollment may re-add the identity. Enrollment sets a transaction-local marker bound to the exact workspace and actor; the database trigger rejects unmarked resurrection, including races. A new membership receives only the current default Workspace group; old grants/groups/role are gone. Bootstrap never restores historical defaults for retired identities, even after explicit re-enrollment.

## Storage and streams

New private object metadata returns a signed Tower content URL instead of a bearer object-store presign. Every new private content request checks current workspace and channel authority. Blossom private streaming rechecks authority before each emitted chunk and fails closed on revocation or authority errors. PG events recheck membership per poll and before emitting a loaded batch. Previously delivered bytes cannot be recalled; external/public copies remain outside private-access revocation.

New PG prepared uploads bind their workspace before attachment, preventing uploader fallback after removal. Linked legacy objects use their current PG link ACL. Pre-release unlinked uploads lack reliable workspace attribution; no guessed migration maps them across workspaces.

Before declaring a real retirement fully effective after deployment, wait the maximum configured **pre-release** object-store presign download TTL from the last old server issuance (default 900 seconds). Existing bearer S3 URLs cannot be retroactively invalidated by Tower alone. Explicit public publication is separately opted in; retiring its publishing member revokes that workspace publication, not unrelated publications in other workspaces.

## Migration and activation

The idempotent `workspace-membership-admin-v1.sql` is mirrored in bootstrap SQL and installed at runtime. It adds role/tombstone/preview tables, a generated-grant tag, workspace upload attribution and resource/enrollment triggers. Existing permission/member state remains unchanged. Historical restrictive membership foreign keys and attribution SET NULL keys become actor identity foreign keys so removal preserves authorship; access-bearing cascading membership keys remain intact. Message-publication attribution also becomes durable; retirement explicitly revokes its active authority.

Deploy Tower first, verify health and the OpenAPI paths, then activate the compatible Ambulando build. No remote environment replacement, key deletion, global actor migration, incident repair hook or automatic Rick permission change is part of this release. Older clients keep working; the new UI reports unsupported endpoints on older servers without destructive fallbacks. Review migration against a disposable migrated database and run signed removal/role security tests before activation. The manager owns final deployment and live verification.
