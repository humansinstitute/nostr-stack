CREATE TABLE IF NOT EXISTS flightdeck_pg_file_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  file_id UUID NOT NULL,
  file_version_id UUID NOT NULL,
  parent_comment_id UUID,
  body TEXT NOT NULL,
  comment_status TEXT NOT NULL DEFAULT 'open',
  anchor JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_request_id TEXT,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (length(trim(body)) > 0),
  CHECK (comment_status IN ('open', 'resolved')),
  CHECK (row_version >= 1),
  CHECK (parent_comment_id IS NULL OR parent_comment_id <> id),
  UNIQUE (workspace_id, file_id, id),
  FOREIGN KEY (workspace_id, scope_id, channel_id, file_id)
    REFERENCES flightdeck_pg_files(workspace_id, scope_id, channel_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, file_version_id)
    REFERENCES flightdeck_pg_file_versions(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_file_comments_parent_fkey
    FOREIGN KEY (workspace_id, file_id, parent_comment_id)
    REFERENCES flightdeck_pg_file_comments(workspace_id, file_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_file_comments_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_file_comments_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_file_comments_file_created
  ON flightdeck_pg_file_comments(workspace_id, file_id, created_at, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_file_comments_version_created
  ON flightdeck_pg_file_comments(workspace_id, file_id, file_version_id, created_at, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_file_comments_parent_created
  ON flightdeck_pg_file_comments(workspace_id, parent_comment_id, created_at, id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_file_comments_idempotency
  ON flightdeck_pg_file_comments(workspace_id, file_id, created_by_actor_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
