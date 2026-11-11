-- Channel-free app storage objects. The app binding is recorded when the app-scoped
-- prepare route creates the object; it is never inferred for generic uploads.
CREATE TABLE IF NOT EXISTS flightdeck_pg_app_storage_objects (
  storage_object_id UUID PRIMARY KEY REFERENCES v4_storage_objects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  app_npub TEXT NOT NULL,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_storage_objects_owner
  ON flightdeck_pg_app_storage_objects(workspace_id, app_npub, actor_id);

-- Public byte consent for one app object, pinned to the reviewed hash. Storage ACLs stay private.
CREATE TABLE IF NOT EXISTS flightdeck_pg_app_blossom_publications (
  storage_object_id UUID NOT NULL REFERENCES flightdeck_pg_app_storage_objects(storage_object_id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  sha256_hex TEXT NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (storage_object_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_app_blossom_publications_object
  ON flightdeck_pg_app_blossom_publications(storage_object_id, sha256_hex) WHERE revoked_at IS NULL;
