// Bounded read-only migration export sessions (additive). A session pins the committed record clock, tracks per-section progress and
// the keys it has delivered so completeness and relationship checks are derived from what was actually exported. Rows are transient:
// they are removed with the session and carry no customer content beyond identifiers.
export const workspaceExportV1Sql = `
CREATE TABLE IF NOT EXISTS workspace_exports (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
 clock_position BIGINT NOT NULL, clock_epoch UUID NOT NULL, access_revision BIGINT NOT NULL,
 state JSONB NOT NULL,
 outcome JSONB, finalized_at TIMESTAMPTZ,
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS workspace_exports_actor ON workspace_exports(workspace_id,actor_id,started_at DESC);
CREATE TABLE IF NOT EXISTS workspace_export_keys (
 export_id UUID NOT NULL REFERENCES workspace_exports(id) ON DELETE CASCADE,
 workspace_id UUID NOT NULL,
 family TEXT NOT NULL, id TEXT NOT NULL,
 PRIMARY KEY(export_id,family,id)
);
CREATE TABLE IF NOT EXISTS workspace_export_assets (
 export_id UUID NOT NULL REFERENCES workspace_exports(id) ON DELETE CASCADE,
 workspace_id UUID NOT NULL,
 object_id UUID NOT NULL, ref_family TEXT NOT NULL, ref_id TEXT NOT NULL, role TEXT NOT NULL,
 PRIMARY KEY(export_id,object_id,ref_family,ref_id,role)
);
`;
