import { collectionActions, collectionFields } from "./collection-routes";
const id = { type: "string", format: "uuid" },
  hash = { type: "string", pattern: "^[0-9a-f]{64}$" };
const source = {
  type: "object",
  additionalProperties: false,
  required: ["origin", "identity", "scope", "workspaceId"],
  properties: {
    origin: { type: "string", format: "uri" },
    identity: { type: "string", maxLength: 256 },
    scope: { enum: ["provider", "workspace"] },
    workspaceId: { ...id, nullable: true },
  },
};
const ref = {
  type: "object",
  additionalProperties: false,
  required: ["name", "part", "object_id", "sha256", "bytes"],
  properties: {
    name: { type: "string", maxLength: 100 },
    part: { type: "integer", minimum: 0 },
    object_id: id,
    sha256: hash,
    bytes: { type: "integer", minimum: 1, maximum: 8388608 },
  },
};
const properties: Record<string, unknown> = {
  installation_id: { type: "string" },
  app_id: { type: "string" },
  revision: { type: "string" },
  expected_service_npub: { type: "string" },
  set_id: id,
  preview_id: id,
  digest: hash,
  membership_digest: hash,
  anchor_sha256: hash,
  page: { type: "integer", minimum: 0, maximum: 4999 },
  refs: { type: "array", minItems: 1, maxItems: 50, items: ref },
  confirmation_token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
  total_count: { type: "integer", minimum: 1, maximum: 100000 },
  graph_revision: { type: "string", pattern: "^[0-9]{1,20}$" },
  snapshot_expires_at: { type: "string", format: "date-time" },
  confirmation_expires_at: { type: "string", format: "date-time" },
  metadata: {
    type: "object",
    additionalProperties: false,
    required: ["set_id", "source", "created", "anchor", "total_count"],
    properties: {
      set_id: id,
      source,
      created: { type: "string", format: "date-time" },
      anchor: {
        type: "object",
        additionalProperties: false,
        required: ["object_id", "sha256"],
        properties: { object_id: id, sha256: hash },
      },
      total_count: { type: "integer", minimum: 1, maximum: 100000 },
    },
  },
};
export const managedStorageCollectionPaths = Object.fromEntries(
  collectionActions.map((action) => {
    const keys = [
      "installation_id",
      "app_id",
      "revision",
      "expected_service_npub",
      ...collectionFields[action]!,
    ];
    return [
      `/api/v4/managed-app-storage/workspaces/{workspaceId}/delegations/{delegationId}/${action}`,
      {
        post: {
          tags: ["Managed app storage"],
          security: [{ nip98: [] }],
          summary: `Managed collection ${action}`,
          description:
            "Exact per-install app NIP-98 authority. No arbitrary object paths, URLs, headers or generic storage ACL expansion. See managed-app-storage contract for sealed membership, snapshot/confirmation and durable physical accounting.",
          parameters: [
            { name: "workspaceId", in: "path", required: true, schema: id },
            { name: "delegationId", in: "path", required: true, schema: id },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: keys,
                  properties: Object.fromEntries(
                    keys.map((k) => [k, properties[k]]),
                  ),
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Binding-checked collection, paged snapshot, single-use confirmation, or durable job state",
            },
            "403": { description: "Wrong/revoked installation authority" },
            "409": {
              description:
                "Unsafe membership, stale/replayed confirmation, or unsupported physical semantics",
            },
            "410": { description: "Tombstoned payload unavailable" },
            "503": {
              description:
                "Physical absence not confirmed; pending job stays charged",
            },
          },
        },
      },
    ];
  }),
);
