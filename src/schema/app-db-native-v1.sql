-- Generic app namespace policy, transaction recovery and managed source fences.
CREATE TABLE IF NOT EXISTS app_db_native_policies (
 workspace_owner_npub text NOT NULL, app_npub text NOT NULL, table_name text NOT NULL,
 workspace_id uuid NOT NULL REFERENCES flightdeck_pg_workspaces(id),
 definition jsonb NOT NULL, generation bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_owner_npub,app_npub,table_name,workspace_id),
 FOREIGN KEY(workspace_owner_npub,app_npub) REFERENCES workspace_app_db_namespaces(workspace_owner_npub,app_npub)
);
CREATE TABLE IF NOT EXISTS app_db_native_receipts (
 workspace_owner_npub text NOT NULL, app_npub text NOT NULL, workspace_id uuid NOT NULL,
 channel_id uuid NOT NULL, actor_npub text NOT NULL, operation_id uuid NOT NULL,
 digest text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_owner_npub,app_npub,workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS app_db_content_fences (
 workspace_id uuid NOT NULL REFERENCES flightdeck_pg_workspaces(id), channel_id uuid NOT NULL,
 content_type text NOT NULL, revision bigint NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(workspace_id,channel_id,content_type)
);
-- Table locking during fence activation waits for all in-flight File writes.
-- Enforce below every typed/legacy File path, including old clients and app signers.
CREATE OR REPLACE FUNCTION app_db_check_content_fence() RETURNS trigger AS $$
DECLARE item record; channel uuid; head_object uuid;
BEGIN
 FOR item IN SELECT v.* FROM (SELECT CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END AS data
   UNION ALL SELECT CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END) v WHERE v.data IS NOT NULL
 LOOP
  IF TG_TABLE_NAME='flightdeck_pg_files' THEN channel:=(item.data->>'channel_id')::uuid;
  ELSE SELECT channel_id,storage_object_id INTO channel,head_object FROM flightdeck_pg_files WHERE workspace_id=(item.data->>'workspace_id')::uuid AND id=(item.data->>'file_id')::uuid; END IF;
  IF EXISTS(SELECT 1 FROM app_db_content_fences f JOIN v4_storage_objects o ON o.content_type=f.content_type
    WHERE f.workspace_id=(item.data->>'workspace_id')::uuid AND f.channel_id=channel AND f.active AND o.id IN ((item.data->>'storage_object_id')::uuid,head_object)) THEN
   RAISE EXCEPTION 'managed_content_fenced' USING ERRCODE='P0001';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_db_content_fence ON flightdeck_pg_files;
CREATE TRIGGER app_db_content_fence BEFORE INSERT OR UPDATE OR DELETE ON flightdeck_pg_files FOR EACH ROW EXECUTE FUNCTION app_db_check_content_fence();
DROP TRIGGER IF EXISTS app_db_content_fence ON flightdeck_pg_file_versions;
CREATE TRIGGER app_db_content_fence BEFORE INSERT OR UPDATE OR DELETE ON flightdeck_pg_file_versions FOR EACH ROW EXECUTE FUNCTION app_db_check_content_fence();
CREATE OR REPLACE FUNCTION app_db_native_write_guard() RETURNS trigger AS $$
BEGIN
 IF current_setting('nstack.native_write',true) IS DISTINCT FROM 'on' THEN
  RAISE EXCEPTION 'native_policy_required' USING ERRCODE='P0001';
 END IF;
 IF TG_OP IN ('UPDATE','DELETE') AND EXISTS(
   SELECT 1 FROM app_db_native_policies p JOIN workspace_app_db_namespaces n USING(workspace_owner_npub,app_npub)
   WHERE n.schema_name=TG_TABLE_SCHEMA AND p.table_name=TG_TABLE_NAME AND p.workspace_id=OLD.workspace_id AND p.definition->>'append_only'='true'
 ) THEN RAISE EXCEPTION 'append_only' USING ERRCODE='P0001'; END IF;
 IF TG_OP='UPDATE' AND (OLD.id IS DISTINCT FROM NEW.id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.channel_id IS DISTINCT FROM NEW.channel_id) THEN
  RAISE EXCEPTION 'immutable_scope' USING ERRCODE='P0001';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TABLE IF NOT EXISTS app_db_native_authorities (
 workspace_owner_npub text NOT NULL, app_npub text NOT NULL, workspace_id uuid NOT NULL,
 channel_id uuid NOT NULL, content_type text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('staging','active','frozen')), revision bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_owner_npub,app_npub,workspace_id,channel_id,content_type),
 FOREIGN KEY(workspace_owner_npub,app_npub) REFERENCES workspace_app_db_namespaces(workspace_owner_npub,app_npub)
);

CREATE OR REPLACE FUNCTION app_db_check_fenced_object() RETURNS trigger AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM app_db_content_fences fence JOIN flightdeck_pg_files f ON f.workspace_id=fence.workspace_id AND f.channel_id=fence.channel_id
   WHERE fence.active AND fence.content_type=OLD.content_type AND (f.storage_object_id=OLD.id OR EXISTS (
     SELECT 1 FROM flightdeck_pg_file_versions v WHERE v.workspace_id=f.workspace_id AND v.file_id=f.id AND v.storage_object_id=OLD.id))) THEN
  RAISE EXCEPTION 'managed_content_fenced' USING ERRCODE='P0001';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_db_fenced_object ON v4_storage_objects;
CREATE TRIGGER app_db_fenced_object BEFORE UPDATE OR DELETE ON v4_storage_objects FOR EACH ROW EXECUTE FUNCTION app_db_check_fenced_object();
