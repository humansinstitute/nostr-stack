export const hostingWorkspaceBillingV2Sql = `
CREATE TABLE IF NOT EXISTS hosting_storage_rates (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 version TEXT NOT NULL UNIQUE CHECK(length(version) BETWEEN 1 AND 100),
 effective_at TIMESTAMPTZ NOT NULL UNIQUE,
 measurement_version TEXT NOT NULL CHECK(measurement_version='stored-columns-accounting-excluded-v1'),
 numerator NUMERIC(40,0) NOT NULL CHECK(numerator>=0),
 denominator NUMERIC(40,0) NOT NULL CHECK(denominator>0),
 actor_npub TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(date_trunc('hour',effective_at AT TIME ZONE 'UTC')=effective_at AT TIME ZONE 'UTC')
);
CREATE TABLE IF NOT EXISTS hosting_workspace_wallets (
 workspace_id UUID PRIMARY KEY REFERENCES flightdeck_pg_workspaces(id),
 account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 owner_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 enabled_at TIMESTAMPTZ NOT NULL,
 paid_units NUMERIC(40,0) NOT NULL DEFAULT 0,
 promo_units NUMERIC(40,0) NOT NULL DEFAULT 0 CHECK(promo_units>=0),
 promo_expires_at TIMESTAMPTZ, depleted_at TIMESTAMPTZ,
 CHECK(promo_units=0 OR promo_expires_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS hosting_workspace_rate_carry (
 workspace_id UUID NOT NULL REFERENCES hosting_workspace_wallets(workspace_id),
 rate_id UUID NOT NULL REFERENCES hosting_storage_rates(id),
 remainder NUMERIC(40,0) NOT NULL DEFAULT 0 CHECK(remainder>=0),
 PRIMARY KEY(workspace_id,rate_id)
);
ALTER TABLE hosting_ledger ADD COLUMN IF NOT EXISTS balance_scope TEXT NOT NULL DEFAULT 'account' CHECK(balance_scope IN ('account','workspace'));
ALTER TABLE hosting_ledger ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES hosting_storage_snapshots(id);
ALTER TABLE hosting_ledger ADD COLUMN IF NOT EXISTS rate_id UUID REFERENCES hosting_storage_rates(id);
ALTER TABLE hosting_ledger ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
ALTER TABLE hosting_ledger DROP CONSTRAINT IF EXISTS hosting_ledger_kind_check;
ALTER TABLE hosting_ledger ADD CONSTRAINT hosting_ledger_kind_check CHECK(kind IN ('welcome','usage','admin','stripe','promo_expiry','workspace_allocation','workspace_usage'));
CREATE UNIQUE INDEX IF NOT EXISTS hosting_unique_snapshot_debit ON hosting_ledger(snapshot_id) WHERE snapshot_id IS NOT NULL;
DROP TRIGGER IF EXISTS hosting_ledger_immutable ON hosting_ledger;
CREATE TRIGGER hosting_ledger_immutable BEFORE UPDATE OR DELETE ON hosting_ledger FOR EACH ROW EXECUTE FUNCTION hosting_storage_snapshot_immutable();
CREATE TABLE IF NOT EXISTS hosting_workspace_settlements (
 snapshot_id UUID PRIMARY KEY REFERENCES hosting_storage_snapshots(id),
 workspace_id UUID NOT NULL REFERENCES hosting_workspace_wallets(workspace_id),
 period_start TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('charged','unavailable','missed','partial_hour','no_rate','owner_changed')),
 rate_id UUID REFERENCES hosting_storage_rates(id), duration_seconds INTEGER NOT NULL CHECK(duration_seconds=3600),
 debit_units NUMERIC(40,0), carry_before NUMERIC(40,0), carry_after NUMERIC(40,0),
 ledger_id UUID UNIQUE REFERENCES hosting_ledger(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,period_start),
 CHECK((status='charged' AND debit_units>=0 AND debit_units IS NOT NULL AND rate_id IS NOT NULL AND ledger_id IS NOT NULL AND carry_before IS NOT NULL AND carry_after IS NOT NULL)
   OR (status<>'charged' AND debit_units IS NULL AND ledger_id IS NULL))
);
DROP TRIGGER IF EXISTS hosting_rate_immutable ON hosting_storage_rates;
CREATE TRIGGER hosting_rate_immutable BEFORE UPDATE OR DELETE ON hosting_storage_rates FOR EACH ROW EXECUTE FUNCTION hosting_storage_snapshot_immutable();
DROP TRIGGER IF EXISTS hosting_settlement_immutable ON hosting_workspace_settlements;
CREATE TRIGGER hosting_settlement_immutable BEFORE UPDATE OR DELETE ON hosting_workspace_settlements FOR EACH ROW EXECUTE FUNCTION hosting_storage_snapshot_immutable();

-- Old auditHostingHour updates the pool before inserting this audit row. Raising
-- here aborts that entire transaction, including its ledger and pool writes.
-- Take the same account lock as enrollment; the volatile trigger query observes
-- the committed cutover even when the old transaction started before enrollment.
CREATE OR REPLACE FUNCTION hosting_v1_cutover_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM hosting_accounts WHERE id=NEW.account_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM hosting_workspace_wallets WHERE workspace_id=NEW.workspace_id AND NEW.hour>=enabled_at) THEN
   RAISE EXCEPTION 'hosting_v1_workspace_cutover' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS hosting_v1_cutover_fence ON hosting_usage_hours;
CREATE TRIGGER hosting_v1_cutover_fence BEFORE INSERT OR UPDATE ON hosting_usage_hours
 FOR EACH ROW EXECUTE FUNCTION hosting_v1_cutover_fence();
`;
