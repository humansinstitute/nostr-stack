-- Exact signer authority for owner-address app registration, independent of typed installations.
CREATE TABLE IF NOT EXISTS namespace_app_permissions (
  id UUID PRIMARY KEY,
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  agent_npub TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission = 'namespace.manage'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_npub TEXT NOT NULL,
  revoked_by_npub TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS namespace_app_permissions_scope ON namespace_app_permissions(workspace_owner_npub, agent_npub, app_npub);
