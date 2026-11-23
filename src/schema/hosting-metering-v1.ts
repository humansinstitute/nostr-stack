/** Additive evidence store only. No customer enrollment, grants or charges. */
export const hostingMeteringV1Sql = `
CREATE TABLE IF NOT EXISTS hosting_metering_workspaces (
 workspace_id UUID PRIMARY KEY REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 enabled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hosting_storage_snapshots (
 id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id),
 owner_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 account_id UUID REFERENCES hosting_accounts(id),
 scope TEXT NOT NULL DEFAULT 'workspace' CHECK(scope='workspace'),
 coverage TEXT NOT NULL DEFAULT 'partial_attributed' CHECK(coverage='partial_attributed'),
 period_start TIMESTAMPTZ NOT NULL,
 period_end TIMESTAMPTZ NOT NULL CHECK(period_end=period_start+interval '1 hour'),
 captured_at TIMESTAMPTZ,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 measurement_version TEXT NOT NULL CHECK(measurement_version='stored-columns-accounting-excluded-v1'),
 status TEXT NOT NULL CHECK(status IN ('measured','unavailable','missed','partial_hour')),
 covered_bytes NUMERIC(40,0) CHECK(covered_bytes>=0),
 evidence JSONB,
 reason TEXT,
 PRIMARY KEY(workspace_id,period_start),
 CHECK(date_trunc('hour',period_start AT TIME ZONE 'UTC')=period_start AT TIME ZONE 'UTC'),
 CHECK((status='measured' AND covered_bytes IS NOT NULL AND captured_at IS NOT NULL AND captured_at>=period_start AND captured_at<period_end AND evidence IS NOT NULL)
    OR (status<>'measured' AND covered_bytes IS NULL AND evidence IS NULL AND captured_at IS NULL))
);
CREATE OR REPLACE FUNCTION hosting_storage_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Storage snapshots are immutable'; END;
$$;
DROP TRIGGER IF EXISTS hosting_storage_snapshot_immutable ON hosting_storage_snapshots;
CREATE TRIGGER hosting_storage_snapshot_immutable BEFORE UPDATE OR DELETE ON hosting_storage_snapshots
 FOR EACH ROW EXECUTE FUNCTION hosting_storage_snapshot_immutable();
`;
