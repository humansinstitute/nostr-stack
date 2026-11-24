// Offline recovery SEAM (additive). Records sealed copies made by a trusted vault and the isolated restore tests that prove (or disprove) them.
// Nothing here copies, moves or deletes live data, holds key material, or is reachable by a route. No vault is configured by default.
export const hostingRecoveryV1Sql = `
CREATE TABLE IF NOT EXISTS hosting_recovery_copies (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id),
 account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 state TEXT NOT NULL CHECK(state IN ('sealed','restore_verified','expired','failed')),
 provenance TEXT NOT NULL CHECK(provenance IN ('production','test')),
 manifest JSONB NOT NULL, manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 plaintext_sha256 TEXT NOT NULL CHECK(plaintext_sha256 ~ '^[0-9a-f]{64}$'), plaintext_bytes BIGINT NOT NULL CHECK(plaintext_bytes>=0),
 object_ref TEXT NOT NULL CHECK(char_length(object_ref) BETWEEN 1 AND 500), key_ref TEXT NOT NULL CHECK(char_length(key_ref) BETWEEN 1 AND 500),
 ciphertext_sha256 TEXT NOT NULL CHECK(ciphertext_sha256 ~ '^[0-9a-f]{64}$'), ciphertext_bytes BIGINT NOT NULL CHECK(ciphertext_bytes>0),
 sealed_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL CHECK(expires_at>sealed_at),
 restore_verified_at TIMESTAMPTZ, restore_evidence JSONB, expired_at TIMESTAMPTZ, failure TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(state<>'restore_verified' OR restore_verified_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS hosting_recovery_copies_workspace ON hosting_recovery_copies(workspace_id,sealed_at DESC);
CREATE TABLE IF NOT EXISTS hosting_recovery_events (
 id BIGSERIAL PRIMARY KEY, copy_id UUID NOT NULL REFERENCES hosting_recovery_copies(id), kind TEXT NOT NULL CHECK(kind IN ('sealed','restore_verified','restore_failed','expired','destroy_failed')),
 detail JSONB NOT NULL DEFAULT '{}', at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS hosting_recovery_events_immutable ON hosting_recovery_events;
CREATE TRIGGER hosting_recovery_events_immutable BEFORE UPDATE OR DELETE ON hosting_recovery_events FOR EACH ROW EXECUTE FUNCTION hosting_funding_append_only();
CREATE OR REPLACE FUNCTION hosting_recovery_copy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'recovery copies are never deleted'; END IF;
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.account_id<>OLD.account_id OR NEW.manifest_sha256<>OLD.manifest_sha256 OR NEW.plaintext_sha256<>OLD.plaintext_sha256 OR NEW.object_ref<>OLD.object_ref OR NEW.ciphertext_sha256<>OLD.ciphertext_sha256
   OR NEW.sealed_at<>OLD.sealed_at OR NEW.expires_at<>OLD.expires_at OR NEW.provenance<>OLD.provenance THEN RAISE EXCEPTION 'recovery copy identity is immutable'; END IF;
 IF OLD.state IN ('expired','failed') AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'recovery copy state is final'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS hosting_recovery_copy_guard ON hosting_recovery_copies;
CREATE TRIGGER hosting_recovery_copy_guard BEFORE UPDATE OR DELETE ON hosting_recovery_copies FOR EACH ROW EXECUTE FUNCTION hosting_recovery_copy_guard();
`;
