# Workspace member authority v1

`GET /api/v4/flightdeck-pg/workspaces/{workspaceId}/members` adds a server-computed authority projection to every listed directory entry:

```json
{
  "actor": { "actor_id": "…", "id": "…", "npub": "npub1…", "kind": "agent", "display_name": "Ops Agent" },
  "authority": { "can_manage_workspace": true }
}
```

## Meaning

- `authority.can_manage_workspace` is the listed actor's **current** effective `workspace.manage` permission. It is computed by the same grant rules as request authorization: a current workspace membership plus an unrevoked workspace-level grant held directly or through an effective (nested) group.
- Role, display name, npub and other labels are never consulted. An `owner` or `admin` role without a matching grant reports `false`; an `agent` with a delegated grant reports `true`.
- It is not a historical or cryptographic write-time attestation. A record authored by an actor who later loses authority will then show `false`. Applications that need historical provenance must record it themselves.
- The projection grants no capability and cannot be set by any request. NStack owns the authority; the application decides what an approval or assignment means.

## Access and privacy

- Callers still need `workspace.read`. Outsiders, foreign-workspace members and members without `workspace.read` get the existing 403; unknown workspaces get 404.
- Ordinary readers receive only `actor` and `authority`. Roles, group identities and grant details are not disclosed. Callers with `workspace.manage` additionally receive `membership` as before.
- Only current members of this workspace are listed. Removed or foreign actors are absent, so their authority cannot be enumerated.
- The server computes the booleans for the whole directory in one bounded query; there is no per-actor request fanout.

## Compatibility

Older servers omit `authority`. Clients must then treat delegated-manager provenance as unverified (fail closed). They may still recognise the workspace owner by the verified workspace owner identity.

## Acceptance

`tests/workspace-member-authority.test.ts` covers: a `workspace.read`-only viewer sees actors with correct booleans and no protected fields; direct and nested-group `workspace.manage` delegations to `agent` members report `true`; `member`, privileged-looking labels, `workspace.invite`-only and grantless `admin` report `false`; revoking a grant, removing a group edge or removing membership fail closed; outsiders, foreign members, members without `workspace.read`, unknown workspaces and mismatched apps cannot enumerate authority; manager callers keep the membership shape; query parameters cannot spoof the value; every boolean matches the per-actor authorization engine.
