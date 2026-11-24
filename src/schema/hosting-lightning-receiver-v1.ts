// Mint-backed receiver integration: durable order bindings written with the quote BEFORE its invoice is visible, and the
// completeness-feed state. Additive; nothing registers a provider.
export const hostingLightningReceiverV1Sql = `
ALTER TABLE hosting_lightning_quotes ADD COLUMN IF NOT EXISTS evidence_kind TEXT NOT NULL DEFAULT 'preimage' CHECK(evidence_kind IN ('preimage','mint_redemption'));
CREATE TABLE IF NOT EXISTS hosting_lightning_bindings (
 treasury_fingerprint TEXT NOT NULL CHECK(char_length(treasury_fingerprint) BETWEEN 1 AND 200),
 seq BIGINT NOT NULL CHECK(seq>0), quote_id UUID NOT NULL UNIQUE REFERENCES hosting_lightning_quotes(id),
 digest TEXT NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'), record JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(treasury_fingerprint,seq)
);
DROP TRIGGER IF EXISTS hosting_lightning_bindings_immutable ON hosting_lightning_bindings;
CREATE TRIGGER hosting_lightning_bindings_immutable BEFORE UPDATE OR DELETE ON hosting_lightning_bindings FOR EACH ROW EXECUTE FUNCTION hosting_funding_append_only();
-- Receiver records we never bound to a quote (or that disagree with one): never creditable, kept for support.
CREATE TABLE IF NOT EXISTS hosting_lightning_binding_orphans (
 treasury_fingerprint TEXT NOT NULL, seq BIGINT NOT NULL, order_ref TEXT NOT NULL, digest TEXT NOT NULL, record JSONB NOT NULL, reason TEXT NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(treasury_fingerprint,seq)
);
DROP TRIGGER IF EXISTS hosting_lightning_binding_orphans_immutable ON hosting_lightning_binding_orphans;
CREATE TRIGGER hosting_lightning_binding_orphans_immutable BEFORE UPDATE OR DELETE ON hosting_lightning_binding_orphans FOR EACH ROW EXECUTE FUNCTION hosting_funding_append_only();
CREATE TABLE IF NOT EXISTS hosting_lightning_binding_feed (
 treasury_fingerprint TEXT PRIMARY KEY, verified_through_seq BIGINT NOT NULL DEFAULT 0, head_seq BIGINT NOT NULL DEFAULT 0, head_count BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
