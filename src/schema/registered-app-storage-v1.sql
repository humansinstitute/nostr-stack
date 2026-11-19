-- New app-principal objects are distinguished from historical user uploads.
ALTER TABLE v4_storage_objects ADD COLUMN IF NOT EXISTS registered_app_npub TEXT;
CREATE TABLE IF NOT EXISTS registered_app_storage_objects (
  object_id UUID PRIMARY KEY REFERENCES v4_storage_objects(id) ON DELETE RESTRICT,
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  creator_npub TEXT NOT NULL CHECK (creator_npub = app_npub),
  idempotency_key UUID NOT NULL,
  expected_size BIGINT NOT NULL CHECK (expected_size BETWEEN 1 AND 8388608),
  expected_sha256 TEXT NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  UNIQUE (workspace_owner_npub, app_npub, idempotency_key)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='v4_storage_objects'::regclass AND conname='registered_app_storage_private') THEN
    ALTER TABLE v4_storage_objects ADD CONSTRAINT registered_app_storage_private
      CHECK (registered_app_npub IS NULL OR
        (is_public=false AND owner_group_id IS NULL AND cardinality(access_group_ids)=0 AND created_by_npub=registered_app_npub));
  END IF;
END $$;
