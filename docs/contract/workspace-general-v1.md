# Canonical workspace General v1

Tower owns the shared all-member channel. Clients opt in explicitly; installing this migration does not create channels or change access in existing workspaces.

## Ensure

`POST /api/v4/flightdeck-pg/workspaces/{workspaceId}/general/ensure`

Send an empty JSON object `{}` with the current canonical owner's NIP-98 authentication and existing Ambulando app namespace. The owner must be an active member with effective `workspace.manage`. Other members, admins and agent-managers cannot create or repair this policy on the owner's behalf merely through their management permission.

The response is `{identity, scope, channel, reused, policy}`. Scope and channel use the existing serialized typed PG shapes (`id`, `workspace_id`, channel `scope_id`, etc.). `policy` is `{version:1, kind:"all_workspace_members", group_id:<UUID>, access_level:"contribute"}`. First creation returns 201 and `reused:false`; subsequent calls return 200 and `reused:true`. There is no purchase ID or billing proof: Tower does not own agent purchase fulfillment.

A transaction serializes by workspace and persists one workspace-to-scope/channel/group mapping. Names are mutable presentation; retries never match by name or adopt existing private content. If a scope called General already exists, the new scope uses an available numbered name. A renamed canonical channel retains its ID. Archived, moved or incompatible canonical resources fail closed with 409 `general_resource_unavailable`; ensure does not silently revive, replace or merge them. A missing Workspace default group returns 409 `workspace_group_required`. Nonempty/invalid body returns 400; missing authentication 401; unauthorized signer 403.

## Membership lifecycle

General uses the existing Workspace group's `scope.read` and channel `contribute` permission bundle. Ensure repairs current member group edges; a database trigger adds every future workspace membership to the persisted group ID in the same transaction, including enrollment paths other than invites. A group rename does not change that identity. Workspace membership deletion cascades access-bearing group membership; normal current-membership authorization and stream checks deny removed actors.

The all-member group edge cannot be removed while its workspace member remains active. The policy's scope-read and channel-contribute grants cannot be deleted, reassigned or revoked independently. Extra separately granted management rights remain revocable. Whole-workspace deletion still cascades normally. These guards apply only to explicitly opted-in canonical General mappings. General membership confers no Autopilot command rights, no agent-manager role and no additional private-channel grants. Historical/downloaded content follows the existing retention/revocation contract.

There is no per-channel participant list for General. Its effective audience is the current workspace membership through the policy group. Clients must use the returned canonical IDs and policy, not compare DM-style `participant_npubs` or infer identity from labels.

## Agent onboarding with existing routes

1. Owner calls `POST .../workspaces/{w}/invites` with `{invitee_npub:<agent>,kind:"agent",role:"member",display_name:<label>}`. The 201 response includes `invite.status:"membership_recorded"`, actor and membership. This immediately creates active membership; no invite acceptance is required. Retry converges the workspace/actor membership but may update its role and creates another audit; preserve existing privileged roles rather than blindly downgrading.
2. Owner ensures General using this endpoint.
3. Resolve the existing DMs scope, then call `POST .../workspaces/{w}/scopes/{dmScope}/channels` with `{name:<label>,kind:"dm",participant_npubs:[owner,agent]}` and no broad group grants. Existing exact unordered participant-pair logic ensures/reuses one active DM across names/scopes (200 reused, 201 created). Both identities must already be members. Other General members gain no DM access.
4. Read back authoritative records; allow TowerSyncService to hydrate/materialize into Dexie and drive liveQuery/UI. Use existing `/sync`, `/events` and `/events/stream`; no new subscription or local row shape is introduced.

The wmcloud signer/connection policy separately determines owner-only command authority. A General grant is not command approval.

## Activation and verification

Bootstrap and runtime install the same idempotent `workspace-general-v1.sql`; no backfill runs. The manager must activate Tower before a client depends on this route and verify health/OpenAPI plus signed isolated smoke tests. An older server must be reported as unsupported, without a fallback that adopts a channel by name or broadens a private DM. Exact-pair DM support requires the existing `fix(flightdeck-pg): key DMs by exact participant pair, not channel name` change as well.

`tests/workspace-general.test.ts` uses a disposable database and signed in-process routes to cover concurrent ensure, existing private name collisions, renaming, repeated migration, current/future enrollment, group rename, owner authorization, cross-workspace rejection, policy narrowing rejection, normal workspace removal and deletion, and exact-pair DM privacy/reuse.
