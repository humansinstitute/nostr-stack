// Invited onboarding: owner-level intents, capped group invitations and funding binding.
// Additive over the shared USD hosting ledger; no separate wallet or catalogue database.
export const onboardingV1Sql = `
CREATE TABLE IF NOT EXISTS onboarding_invites (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 token_sha256 TEXT NOT NULL UNIQUE,
 label TEXT CHECK(label IS NULL OR length(label)<=120),
 max_admissions INTEGER NOT NULL CHECK(max_admissions BETWEEN 1 AND 100000),
 created_by_npub TEXT NOT NULL,
 revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS onboarding_invite_seats (
 invite_id UUID NOT NULL REFERENCES onboarding_invites(id),
 owner_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 status TEXT NOT NULL CHECK(status IN ('reserved','redeemed','released')),
 reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 redeemed_at TIMESTAMPTZ, released_at TIMESTAMPTZ, released_reason TEXT,
 PRIMARY KEY(invite_id,owner_actor_id)
);
CREATE TABLE IF NOT EXISTS onboarding_agent_offers (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 template TEXT NOT NULL CHECK(length(template) BETWEEN 1 AND 100),
 model_ref TEXT NOT NULL CHECK(length(model_ref) BETWEEN 1 AND 200),
 rate_version TEXT NOT NULL CHECK(length(rate_version) BETWEEN 1 AND 100),
 default_daily_cap_cents INTEGER NOT NULL CHECK(default_daily_cap_cents>0),
 max_daily_cap_cents INTEGER NOT NULL CHECK(max_daily_cap_cents>=default_daily_cap_cents),
 active BOOLEAN NOT NULL DEFAULT true,
 created_by_npub TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(template,model_ref,rate_version)
);
CREATE TABLE IF NOT EXISTS onboarding_intents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 client_request_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
 invite_id UUID REFERENCES onboarding_invites(id),
 workspace_name TEXT NOT NULL CHECK(length(workspace_name) BETWEEN 1 AND 80),
 workspace_name_key TEXT NOT NULL,
 agent_offer_id UUID REFERENCES onboarding_agent_offers(id),
 agent_daily_cap_cents INTEGER CHECK(agent_daily_cap_cents IS NULL OR agent_daily_cap_cents>0),
 funding_cents INTEGER NOT NULL CHECK(funding_cents BETWEEN 2100 AND 1000000),
 return_state TEXT CHECK(return_state IS NULL OR length(return_state)<=256),
 revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','funded','provisioning','provisioned','cancelled')),
 funded_order_id UUID REFERENCES hosting_checkout_orders(id), funded_at TIMESTAMPTZ,
 steps JSONB NOT NULL DEFAULT '{}', last_error TEXT,
 workspace_id UUID REFERENCES flightdeck_pg_workspaces(id), provisioned_at TIMESTAMPTZ,
 intro_ends_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(owner_actor_id,client_request_key),
 CHECK((agent_offer_id IS NULL)=(agent_daily_cap_cents IS NULL))
);
CREATE INDEX IF NOT EXISTS onboarding_intents_owner ON onboarding_intents(owner_actor_id,created_at DESC);
ALTER TABLE hosting_checkout_orders ADD COLUMN IF NOT EXISTS intent_id UUID REFERENCES onboarding_intents(id);
-- Onboarding funding is a custom amount (US$21 minimum) validated in code; legacy checkout keeps its code allowlist.
ALTER TABLE hosting_checkout_orders DROP CONSTRAINT IF EXISTS hosting_checkout_orders_amount_cents_check;
ALTER TABLE hosting_checkout_orders DROP CONSTRAINT IF EXISTS hosting_checkout_orders_amount_range;
ALTER TABLE hosting_checkout_orders ADD CONSTRAINT hosting_checkout_orders_amount_range CHECK(amount_cents BETWEEN 500 AND 1000000);
`;
