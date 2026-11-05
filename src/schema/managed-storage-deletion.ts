// Additive: immutable publisher objects/receipts remain as chain and accounting evidence.
export const managedStorageDeletionSql = `
ALTER TABLE managed_app_storage_objects ADD COLUMN IF NOT EXISTS deletion_job UUID;
ALTER TABLE managed_app_storage_objects ADD COLUMN IF NOT EXISTS physical_absent BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS managed_storage_graph (
 workspace_id UUID NOT NULL, delegation_id UUID NOT NULL, revision BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,delegation_id));
CREATE TABLE IF NOT EXISTS managed_storage_sets (
 workspace_id UUID NOT NULL, delegation_id UUID NOT NULL, id UUID NOT NULL,
 metadata JSONB NOT NULL, membership_digest TEXT NOT NULL, total_count INTEGER NOT NULL CHECK(total_count BETWEEN 1 AND 100000),
 state TEXT NOT NULL CHECK(state IN ('draft','sealed','aborted','deleted')),
 metadata_bytes BIGINT NOT NULL, PRIMARY KEY(workspace_id,delegation_id,id));
CREATE TABLE IF NOT EXISTS managed_storage_set_pages (
 workspace_id UUID NOT NULL, delegation_id UUID NOT NULL, set_id UUID NOT NULL,
 page INTEGER NOT NULL CHECK(page BETWEEN 0 AND 1999), refs JSONB NOT NULL,
 PRIMARY KEY(workspace_id,delegation_id,set_id,page));
CREATE TABLE IF NOT EXISTS managed_storage_refs (
 workspace_id UUID NOT NULL, delegation_id UUID NOT NULL, set_id UUID NOT NULL,
 object_id UUID NOT NULL, role TEXT NOT NULL CHECK(role IN ('anchor','payload')),
 PRIMARY KEY(workspace_id,delegation_id,set_id,object_id));
CREATE INDEX IF NOT EXISTS managed_storage_refs_object ON managed_storage_refs(object_id);
CREATE TABLE IF NOT EXISTS managed_storage_previews (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, delegation_id UUID NOT NULL,
 set_id UUID NOT NULL, snapshot JSONB NOT NULL, digest TEXT NOT NULL, graph_revision TEXT NOT NULL,
 grant_revision TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 token_digest TEXT, token_expires_at TIMESTAMPTZ, state TEXT NOT NULL DEFAULT 'preview',
 confirmation_receipt JSONB, metadata_bytes BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_storage_delete_items (
 job_id UUID NOT NULL REFERENCES managed_storage_previews(id), object_id UUID NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','physical_absent')),
 PRIMARY KEY(job_id,object_id));
`;
