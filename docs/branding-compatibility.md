# NStack branding and compatibility

NStack (Nostr Stack) is your shared business and agent memory. It runs as a
standalone service with a browser console, Nostr authentication, workspace APIs
and file storage. Optional relay, Blossom, graph and Git modules extend it.
Existing integrations remain implemented and retain their authorization rules.

Visible product labels and the private package/build name use NStack and
`nostr-stack`. No data or identity migration accompanies that copy change.
Configured public instance names/descriptions remain operator-owned; changing
source does not overwrite a saved profile.

## Retained machine names

| Names | Reason retained |
| --- | --- |
| `SUPERBASED_*`, `TOWER_*`, `COWORKER_BE_PORT` | Existing configuration and build/operations inputs, including service identity. |
| `tower_*`, `/api/v4/admin/tower`, `TowerBuildInfo`, `TowerProfileResponse`, `UpdateTowerProfileRequest` | JSON fields, routes and OpenAPI component references consumed by existing clients. |
| `superbased_connection`, `coworker_agent_connect`, `wingman_workspace_locator`, `org.wingman.*` | Versioned token, discovery and notification wire formats. |
| `x-wingman-*`, `X-Wingman-*`, `x-superbased-*`, `wingman-artifact-assets` | Request/response headers and embedded attachment contracts. |
| `tower` discovery service ID/kind and Compose service | Discovery consumers and internal DNS/routing. |
| `wingman-tower*` containers/project/networks/cache image, `tower_*` SQL roles/settings | Existing deployment, backup, ACL and operational dependencies. |
| `coworker_v4`, `tower_graph`, `tower_memory`, `superbased-storage` | Existing database, graph and bucket defaults; changing these could select empty data stores. |
| Volume names, mount paths, `wingman-tower-backup` | Durable installation state, backup/restore compatibility and recovery checks. |
| Existing external URLs and repository/CLI paths | Working connections and operational commands; source copy is not an endpoint migration. |

Internal function/type/file names such as `buildSuperBasedConnectionToken` and
`getTowerBuildInfo` remain to keep this change limited to product presentation.
API/configuration error messages may quote retained names to tell operators
exactly which field or setting needs attention.

Flight Deck, Autopilot, Yoke, WApps and GRasp references describe implemented
client/integration contracts or operator tools, not a required product suite.
Historical design notes and versioned proposals retain their original context;
license and legal attribution are unchanged.

## Runtime migration is separate

Do not rename a running container, Compose project, database, bucket or volume as
part of a copy update. First inventory ingress targets, service DNS aliases,
network membership, mounts, backup defaults, health checks and external clients.
Plan an explicit maintenance window with verified backups and rollback. Preserve
existing volume mounts and DNS aliases while switching any routing references,
then verify authenticated API access, storage, relay/Blossom and backups. Only
remove old aliases after all consumers have moved. Activation requires separate
restart/deployment authorization.
