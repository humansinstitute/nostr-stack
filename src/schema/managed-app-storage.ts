import { managedStorageDeletionSql } from './managed-storage-deletion';
export const managedAppStorageSql = `
CREATE TABLE IF NOT EXISTS managed_app_storage_objects (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  delegation_id UUID NOT NULL,
  installation_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  idempotency_key UUID NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  sha256_hex TEXT NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  publisher_receipt JSONB NOT NULL,
  receipt_bytes INTEGER NOT NULL CHECK (receipt_bytes BETWEEN 1 AND 6144),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','uploaded','complete')),
  upload_digest TEXT,
  upload_expires_at TIMESTAMPTZ,
  upload_revision TEXT,
  download_digest TEXT,
  download_expires_at TIMESTAMPTZ,
  download_revision TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, delegation_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS managed_app_storage_budget ON managed_app_storage_objects(workspace_id, delegation_id);
CREATE INDEX IF NOT EXISTS managed_app_storage_recovery ON managed_app_storage_objects(workspace_id,delegation_id,state,created_at,id);
CREATE OR REPLACE FUNCTION managed_app_storage_immutable() RETURNS trigger AS $fn$
BEGIN
  IF (NEW.workspace_id,NEW.delegation_id,NEW.installation_id,NEW.app_id,NEW.app_npub,NEW.idempotency_key,NEW.size_bytes,NEW.sha256_hex,NEW.publisher_receipt,NEW.receipt_bytes,NEW.created_at)
    IS DISTINCT FROM (OLD.workspace_id,OLD.delegation_id,OLD.installation_id,OLD.app_id,OLD.app_npub,OLD.idempotency_key,OLD.size_bytes,OLD.sha256_hex,OLD.publisher_receipt,OLD.receipt_bytes,OLD.created_at)
    THEN RAISE EXCEPTION 'managed storage identity and receipt are immutable'; END IF;
  IF OLD.state='complete' AND NEW.state<>'complete' THEN RAISE EXCEPTION 'managed storage completion is immutable'; END IF;
  RETURN NEW;
END; $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS managed_app_storage_immutable ON managed_app_storage_objects;
CREATE TRIGGER managed_app_storage_immutable BEFORE UPDATE ON managed_app_storage_objects FOR EACH ROW EXECUTE FUNCTION managed_app_storage_immutable();
` + managedStorageDeletionSql;
