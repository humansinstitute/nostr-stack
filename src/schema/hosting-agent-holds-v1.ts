// Paid agent holds: operator tariffs (immutable), payer grants, holds with an explicit lifecycle, and overrun spend blocks.
// Additive. A hold never touches the ledger until settlement; the ledger gains the 'agent_usage' kind.
export const HOSTING_LEDGER_KINDS = `'welcome','usage','admin','stripe','promo_expiry','workspace_allocation','workspace_usage','lightning','refund','dispute','storage_peak','agent_usage'`;
export const hostingAgentHoldsV1Sql = `
ALTER TABLE hosting_ledger DROP CONSTRAINT IF EXISTS hosting_ledger_kind_check;
ALTER TABLE hosting_ledger ADD CONSTRAINT hosting_ledger_kind_check CHECK(kind IN (${HOSTING_LEDGER_KINDS}));
CREATE TABLE IF NOT EXISTS hosting_agent_tariffs (
 version TEXT PRIMARY KEY CHECK(version ~ '^[A-Za-z0-9._-]{1,64}$'),
 content_sha256 TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hosting_agent_tariff_models (
 version TEXT NOT NULL REFERENCES hosting_agent_tariffs(version), model TEXT NOT NULL CHECK(char_length(model) BETWEEN 1 AND 200),
 input_pico NUMERIC(40,0) NOT NULL CHECK(input_pico>=0), output_pico NUMERIC(40,0) NOT NULL CHECK(output_pico>=0),
 cached_input_pico NUMERIC(40,0) CHECK(cached_input_pico>=0), cached_input_semantics TEXT CHECK(cached_input_semantics IN ('subset','additional')),
 request_pico NUMERIC(40,0) NOT NULL DEFAULT 0 CHECK(request_pico>=0),
 max_input_tokens NUMERIC(40,0) NOT NULL CHECK(max_input_tokens>0), max_output_tokens NUMERIC(40,0) NOT NULL CHECK(max_output_tokens>0),
 PRIMARY KEY(version,model), CHECK((cached_input_pico IS NULL)=(cached_input_semantics IS NULL))
);
CREATE TABLE IF NOT EXISTS hosting_agent_grants (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id), payer_npub TEXT NOT NULL,
 agent_npub TEXT NOT NULL, service_npub TEXT NOT NULL, model TEXT NOT NULL,
 tariff_version TEXT NOT NULL, daily_cap_units NUMERIC(40,0) NOT NULL CHECK(daily_cap_units>0), expires_at TIMESTAMPTZ NOT NULL,
 idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(account_id,idempotency_key), FOREIGN KEY(tariff_version,model) REFERENCES hosting_agent_tariff_models(version,model)
);
CREATE TABLE IF NOT EXISTS hosting_agent_holds (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES hosting_accounts(id), call_id TEXT NOT NULL,
 grant_id UUID NOT NULL REFERENCES hosting_agent_grants(id), workspace_id UUID NOT NULL, agent_npub TEXT NOT NULL, service_npub TEXT NOT NULL,
 model TEXT NOT NULL, tariff_version TEXT NOT NULL, run_id TEXT, request_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('held','dispatched','pending_reconcile','settled','released')),
 reserved_units NUMERIC(40,0) NOT NULL CHECK(reserved_units>0), reserve_day DATE NOT NULL,
 reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(), reconcile_by TIMESTAMPTZ NOT NULL,
 dispatched_at TIMESTAMPTZ, pending_at TIMESTAMPTZ, pending_reason TEXT,
 released_at TIMESTAMPTZ, release_basis TEXT CHECK(release_basis IN ('never_dispatched','provider_rejection')), release_evidence JSONB,
 settled_at TIMESTAMPTZ, settled_units NUMERIC(40,0) CHECK(settled_units>=0), overrun_units NUMERIC(40,0) NOT NULL DEFAULT 0,
 observation JSONB, observation_sha256 TEXT, ledger_id UUID REFERENCES hosting_ledger(id),
 UNIQUE(account_id,call_id),
 CHECK((state='settled')=(settled_units IS NOT NULL AND observation IS NOT NULL)),
 CHECK((state='released')=(released_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS hosting_agent_holds_open_idx ON hosting_agent_holds(account_id) WHERE state IN ('held','dispatched','pending_reconcile');
CREATE INDEX IF NOT EXISTS hosting_agent_holds_day_idx ON hosting_agent_holds(grant_id,reserve_day);
CREATE TABLE IF NOT EXISTS hosting_agent_spend_blocks (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES hosting_accounts(id), hold_id UUID NOT NULL UNIQUE REFERENCES hosting_agent_holds(id),
 reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), cleared_at TIMESTAMPTZ, cleared_by TEXT
);
CREATE OR REPLACE FUNCTION hosting_agent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'agent tariff rows are immutable'; END; $$;
DROP TRIGGER IF EXISTS hosting_agent_tariffs_immutable ON hosting_agent_tariffs;
CREATE TRIGGER hosting_agent_tariffs_immutable BEFORE UPDATE OR DELETE ON hosting_agent_tariffs FOR EACH ROW EXECUTE FUNCTION hosting_agent_immutable();
DROP TRIGGER IF EXISTS hosting_agent_tariff_models_immutable ON hosting_agent_tariff_models;
CREATE TRIGGER hosting_agent_tariff_models_immutable BEFORE UPDATE OR DELETE ON hosting_agent_tariff_models FOR EACH ROW EXECUTE FUNCTION hosting_agent_immutable();
CREATE OR REPLACE FUNCTION hosting_agent_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent holds are never deleted'; END IF;
 IF OLD.state IN ('settled','released') THEN RAISE EXCEPTION 'agent hold is final'; END IF;
 IF NEW.account_id<>OLD.account_id OR NEW.call_id<>OLD.call_id OR NEW.reserved_units<>OLD.reserved_units OR NEW.grant_id<>OLD.grant_id OR NEW.request_sha256<>OLD.request_sha256 OR NEW.model<>OLD.model OR NEW.tariff_version<>OLD.tariff_version THEN RAISE EXCEPTION 'agent hold binding is immutable'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS hosting_agent_hold_guard ON hosting_agent_holds;
CREATE TRIGGER hosting_agent_hold_guard BEFORE UPDATE OR DELETE ON hosting_agent_holds FOR EACH ROW EXECUTE FUNCTION hosting_agent_hold_guard();
`;
