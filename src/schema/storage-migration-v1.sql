-- Durable storage migration journal (E3/E4).
-- Instance-scoped operational state; intentionally has no workspace_id column.

CREATE TABLE IF NOT EXISTS storage_migration_runs (
  run_id UUID PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase IN (
    'planned',
    'precopied',
    'source_fenced',
    'backed_up',
    'synced',
    'verified',
    'switch_prepared',
    'db_switched',
    'config_switched',
    'start_intent',
    'started',
    'committed',
    'rolling_back',
    'rolled_back',
    'source_retired',
    'aborted_restore'
  )),
  fingerprint TEXT NOT NULL,
  fingerprint_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_provider TEXT NOT NULL CHECK (source_provider IN ('minio', 'seaweedfs', 'external-s3')),
  target_provider TEXT NOT NULL CHECK (target_provider IN ('minio', 'seaweedfs')),
  target_sentinel_id TEXT,
  source_boot_id TEXT,
  target_boot_id TEXT,
  -- Host container identities recorded at the source fence (snapshot validity check, retire-source).
  fence_identity JSONB,
  old_config_digest TEXT,
  new_config_digest TEXT,
  verified_backup_dir TEXT,
  backup_manifest_sha256 TEXT,
  -- Phase the run was in when rollback began; selects RB1 (before start_intent) or RB2.
  rollback_from_phase TEXT,
  smoke_evidence JSONB,
  smoke_passed_at TIMESTAMPTZ,
  last_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_fenced_at TIMESTAMPTZ,
  backed_up_at TIMESTAMPTZ,
  start_intent_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ,
  rolling_back_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  source_retired_at TIMESTAMPTZ,
  aborted_restore_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(fingerprint_details) = 'object'),
  CHECK (jsonb_typeof(last_evidence) = 'object'),
  CHECK (fence_identity IS NULL OR jsonb_typeof(fence_identity) = 'object'),
  CHECK (smoke_evidence IS NULL OR jsonb_typeof(smoke_evidence) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_migration_runs_single_active
  ON storage_migration_runs ((1))
  WHERE phase NOT IN ('committed', 'rolled_back', 'source_retired', 'aborted_restore');

CREATE INDEX IF NOT EXISTS idx_storage_migration_runs_created
  ON storage_migration_runs (created_at DESC, run_id DESC);

CREATE TABLE IF NOT EXISTS storage_migration_objects (
  run_id UUID NOT NULL REFERENCES storage_migration_runs(run_id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('v4', 'managed')),
  object_id UUID NOT NULL,
  -- Measured bytes copied to the target.
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256_hex TEXT NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  -- Exact DB identity at the last quiesced evaluation; restored verbatim by rollback.
  original_sha256_hex TEXT,
  original_size_bytes BIGINT NOT NULL CHECK (original_size_bytes >= 0),
  original_verified_etag TEXT,
  original_completed BOOLEAN NOT NULL DEFAULT false,
  content_type TEXT,
  -- Preserved object headers and x-amz-meta-* (normalized, lower-case keys).
  object_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  src_etag TEXT,
  dst_etag TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'copied',
    'verified',
    'deleted_ineligible',
    'switched',
    'reverted',
    'missing_source',
    'integrity_mismatch'
  )),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, storage_key),
  CHECK (jsonb_typeof(object_headers) = 'object'),
  CHECK (jsonb_typeof(custom_metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_storage_migration_objects_state
  ON storage_migration_objects (run_id, state);

CREATE INDEX IF NOT EXISTS idx_storage_migration_objects_object
  ON storage_migration_objects (run_id, kind, object_id);

CREATE TABLE IF NOT EXISTS storage_migration_probes (
  run_id UUID NOT NULL REFERENCES storage_migration_runs(run_id) ON DELETE CASCADE,
  probe_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('v4', 'managed', 'workspace', 'object')),
  row_id UUID,
  storage_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleaned_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, probe_id)
);

CREATE INDEX IF NOT EXISTS idx_storage_migration_probes_uncleaned
  ON storage_migration_probes (run_id)
  WHERE cleaned_at IS NULL;
