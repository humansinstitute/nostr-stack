// Method-neutral funding evidence (Stripe and Lightning) and negative-event history.
// Additive over the shared USD ledger: every credit and every reversal is a ledger row; these tables bind it to provider evidence.
export const hostingFundingV1Sql = `
ALTER TABLE hosting_ledger DROP CONSTRAINT IF EXISTS hosting_ledger_kind_check;
ALTER TABLE hosting_ledger ADD CONSTRAINT hosting_ledger_kind_check CHECK(kind IN ('welcome','usage','admin','stripe','promo_expiry','workspace_allocation','workspace_usage','lightning','refund','dispute'));
CREATE TABLE IF NOT EXISTS hosting_funding_settlements (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 method TEXT NOT NULL CHECK(method IN ('stripe','lightning')),
 provider_ref TEXT NOT NULL CHECK(length(provider_ref) BETWEEN 1 AND 300),
 order_id UUID NOT NULL,
 intent_id UUID REFERENCES onboarding_intents(id),
 currency TEXT NOT NULL CHECK(currency='USD'),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 amount_units NUMERIC(40,0) NOT NULL CHECK(amount_units>0),
 ledger_key TEXT NOT NULL,
 evidence JSONB NOT NULL DEFAULT '{}',
 settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(method,provider_ref), UNIQUE(method,order_id), UNIQUE(account_id,ledger_key)
);
CREATE INDEX IF NOT EXISTS hosting_funding_settlements_account ON hosting_funding_settlements(account_id,settled_at DESC);
CREATE TABLE IF NOT EXISTS hosting_funding_adjustments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 settlement_id UUID NOT NULL REFERENCES hosting_funding_settlements(id),
 account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 kind TEXT NOT NULL CHECK(kind IN ('refund','dispute')),
 provider_ref TEXT NOT NULL CHECK(length(provider_ref) BETWEEN 1 AND 300),
 request_id UUID UNIQUE,
 request_key TEXT,
 state TEXT NOT NULL CHECK(state IN ('requested','pending','succeeded','failed','canceled','needs_response','under_review','won','lost','inactive')),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 effective_cents INTEGER NOT NULL DEFAULT 0 CHECK(effective_cents>=0),
 applied_units NUMERIC(40,0) NOT NULL DEFAULT 0 CHECK(applied_units>=0),
 uncovered_units NUMERIC(40,0) NOT NULL DEFAULT 0 CHECK(uncovered_units>=0),
 seq INTEGER NOT NULL DEFAULT 0,
 reason TEXT,
 actor_npub TEXT,
 evidence JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(settlement_id,kind,provider_ref),
 UNIQUE(account_id,request_key)
);
CREATE TABLE IF NOT EXISTS hosting_funding_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 method TEXT NOT NULL CHECK(method IN ('stripe','lightning')),
 provider_event_id TEXT NOT NULL,
 event_type TEXT NOT NULL,
 settlement_id UUID REFERENCES hosting_funding_settlements(id),
 outcome TEXT NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(method,provider_event_id)
);
CREATE OR REPLACE FUNCTION hosting_funding_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'hosting funding evidence is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS hosting_funding_settlements_immutable ON hosting_funding_settlements;
CREATE TRIGGER hosting_funding_settlements_immutable BEFORE UPDATE OR DELETE ON hosting_funding_settlements FOR EACH ROW EXECUTE FUNCTION hosting_funding_append_only();
DROP TRIGGER IF EXISTS hosting_funding_events_immutable ON hosting_funding_events;
CREATE TRIGGER hosting_funding_events_immutable BEFORE UPDATE OR DELETE ON hosting_funding_events FOR EACH ROW EXECUTE FUNCTION hosting_funding_append_only();
DROP TRIGGER IF EXISTS hosting_funding_adjustments_no_delete ON hosting_funding_adjustments;
CREATE TRIGGER hosting_funding_adjustments_no_delete BEFORE DELETE ON hosting_funding_adjustments FOR EACH ROW EXECUTE FUNCTION hosting_funding_append_only();
-- Lightning quotes: server-issued by a trusted configured provider adapter, bound to the account, intent, USD amount, sat amount,
-- rate evidence, payee identity and a unique payment hash. Credit is created only from provider-verified settlement.
CREATE TABLE IF NOT EXISTS hosting_lightning_quotes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 intent_id UUID NOT NULL REFERENCES onboarding_intents(id),
 idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 provider TEXT, payee_ref TEXT, invoice TEXT, payment_hash TEXT UNIQUE CHECK(payment_hash IS NULL OR payment_hash ~ '^[0-9a-f]{64}$'),
 amount_sats BIGINT CHECK(amount_sats IS NULL OR amount_sats>0),
 rate_source TEXT, rate_ref TEXT, rate_quoted_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ,
 state TEXT NOT NULL DEFAULT 'issuing' CHECK(state IN ('issuing','open','settled','expired','cancelled','late_payment','mismatch')),
 settled_at TIMESTAMPTZ, evidence JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(account_id,idempotency_key),
 CHECK(state='issuing' OR (invoice IS NOT NULL AND payment_hash IS NOT NULL AND amount_sats IS NOT NULL AND expires_at IS NOT NULL AND payee_ref IS NOT NULL AND rate_source IS NOT NULL AND rate_quoted_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS hosting_lightning_quotes_intent ON hosting_lightning_quotes(intent_id);
ALTER TABLE onboarding_intents ADD COLUMN IF NOT EXISTS funded_settlement_id UUID REFERENCES hosting_funding_settlements(id);
ALTER TABLE hosting_checkout_orders ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ;
ALTER TABLE hosting_checkout_orders ADD COLUMN IF NOT EXISTS terminal_reason TEXT CHECK(terminal_reason IS NULL OR terminal_reason IN ('expired'));
-- Credits written before this slice are bound retroactively from their fulfilled order and ledger row.
INSERT INTO hosting_funding_settlements(account_id,method,provider_ref,order_id,intent_id,currency,amount_cents,amount_units,ledger_key,evidence,settled_at)
 SELECT o.account_id,'stripe',o.payment_intent,o.id,o.intent_id,'USD',o.amount_cents,l.amount_units,l.idempotency_key,jsonb_build_object('session_id',o.session_id,'backfilled',true),o.fulfilled_at
 FROM hosting_checkout_orders o JOIN hosting_ledger l ON l.account_id=o.account_id AND l.idempotency_key='stripe:'||o.payment_intent
 WHERE o.fulfilled_at IS NOT NULL AND o.payment_intent IS NOT NULL AND l.amount_units>0
 ON CONFLICT DO NOTHING;
UPDATE onboarding_intents i SET funded_settlement_id=s.id FROM hosting_funding_settlements s WHERE i.funded_order_id=s.order_id AND s.method='stripe' AND i.funded_settlement_id IS NULL;
`;
