// Opaque hosted copy of a new on-device key: NIP-49 ciphertext only, one immutable username and one owner key per row.
export const hostedIdentityBackupV1Sql = `
CREATE TABLE IF NOT EXISTS hosted_identity_backups (
 username TEXT PRIMARY KEY CHECK(username ~ '^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$'),
 owner_npub TEXT NOT NULL UNIQUE CHECK(owner_npub ~ '^npub1[02-9ac-hj-np-z]{58}$'),
 ncryptsec TEXT NOT NULL CHECK(char_length(ncryptsec)=162 AND ncryptsec ~ '^ncryptsec1[02-9ac-hj-np-z]+$'),
 logn SMALLINT NOT NULL CHECK(logn BETWEEN 16 AND 18),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Client-declared guardrail only: the server cannot attest where a key came from. Existing intents default to 'existing' and are never gated.
ALTER TABLE onboarding_intents ADD COLUMN IF NOT EXISTS identity_origin TEXT NOT NULL DEFAULT 'existing' CHECK(identity_origin IN ('new','existing'));
CREATE OR REPLACE FUNCTION hosted_identity_backup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'hosted identity backups are never deleted'; END IF;
 IF NEW.username<>OLD.username OR NEW.owner_npub<>OLD.owner_npub OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'hosted identity backup ownership is immutable'; END IF;
 IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'hosted identity backup revision must advance by one'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS hosted_identity_backup_guard ON hosted_identity_backups;
CREATE TRIGGER hosted_identity_backup_guard BEFORE UPDATE OR DELETE ON hosted_identity_backups FOR EACH ROW EXECUTE FUNCTION hosted_identity_backup_guard();
`;
