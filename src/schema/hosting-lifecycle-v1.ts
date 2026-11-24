// Durable owner-facing lifecycle notices (additive). One row per account, kind and funding cycle, so repeated evaluation, concurrent
// runners and restarts can never repeat a notice; a top-up or a new depletion starts a new cycle. Notices carry no deletion capability.
export const hostingLifecycleV1Sql = `
CREATE TABLE IF NOT EXISTS hosting_lifecycle_notices (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 kind TEXT NOT NULL CHECK(kind IN ('runway_30d','runway_7d','runway_1d','read_only_entered','removal_due')),
 cycle_key TEXT NOT NULL,
 payload JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 acknowledged_at TIMESTAMPTZ,
 UNIQUE(account_id,kind,cycle_key)
);
CREATE INDEX IF NOT EXISTS hosting_lifecycle_notices_account ON hosting_lifecycle_notices(account_id,created_at DESC);
`;
