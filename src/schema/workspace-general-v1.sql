-- Explicitly enrolled canonical General; no tenant backfill.
CREATE TABLE IF NOT EXISTS flightdeck_pg_workspace_general (
  workspace_id UUID PRIMARY KEY REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  group_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, scope_id) REFERENCES flightdeck_pg_scopes(workspace_id,id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES flightdeck_pg_channels(workspace_id,id),
  FOREIGN KEY (workspace_id, group_id) REFERENCES flightdeck_pg_groups(workspace_id,id)
);

-- General membership follows authority, including enrollment paths other than invites.
CREATE OR REPLACE FUNCTION flightdeck_pg_general_member_join() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id,created_by_actor_id)
    SELECT NEW.workspace_id,g.group_id,NEW.actor_id,NEW.created_by_actor_id
    FROM flightdeck_pg_workspace_general g WHERE g.workspace_id=NEW.workspace_id
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS flightdeck_pg_general_member_join ON flightdeck_pg_workspace_memberships;
CREATE TRIGGER flightdeck_pg_general_member_join AFTER INSERT ON flightdeck_pg_workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_general_member_join();

CREATE OR REPLACE FUNCTION flightdeck_pg_general_member_keep() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM flightdeck_pg_workspaces w JOIN flightdeck_pg_workspace_general g ON g.workspace_id=w.id
    JOIN flightdeck_pg_workspace_memberships m ON m.workspace_id=g.workspace_id AND m.actor_id=OLD.actor_id
    WHERE g.workspace_id=OLD.workspace_id AND g.group_id=OLD.group_id) THEN
    RAISE EXCEPTION 'General includes every current workspace member; remove workspace membership instead';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS flightdeck_pg_general_member_keep ON flightdeck_pg_group_memberships;
CREATE TRIGGER flightdeck_pg_general_member_keep BEFORE DELETE OR UPDATE OF group_id,actor_id,workspace_id
  ON flightdeck_pg_group_memberships FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_general_member_keep();

-- An all-member channel cannot silently become a restricted private channel.
CREATE OR REPLACE FUNCTION flightdeck_pg_general_grant_keep() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND EXISTS (
    SELECT 1 FROM flightdeck_pg_workspaces w JOIN flightdeck_pg_workspace_general g ON g.workspace_id=w.id
    WHERE g.workspace_id=OLD.workspace_id AND g.group_id=OLD.principal_group_id
      AND ((OLD.resource_channel_id=g.channel_id AND OLD.permission IN ('channel.read','task.read','doc.read','file.read','audio_note.read','channel.write','task.create','task.update','task.comment','comment.create','doc.write','file.write','audio_note.write')) OR
           (OLD.resource_scope_id=g.scope_id AND OLD.permission='scope.read'))
  ) THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'General all-member policy grants cannot be removed';
    END IF;
    IF NEW.revoked_at IS NOT NULL OR
      (NEW.workspace_id,NEW.principal_type,NEW.principal_group_id,NEW.resource_type,NEW.resource_scope_id,NEW.resource_channel_id,NEW.permission)
        IS DISTINCT FROM
      (OLD.workspace_id,OLD.principal_type,OLD.principal_group_id,OLD.resource_type,OLD.resource_scope_id,OLD.resource_channel_id,OLD.permission) THEN
      RAISE EXCEPTION 'General all-member policy grants cannot be narrowed';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS flightdeck_pg_general_grant_keep ON flightdeck_pg_permission_grants;
CREATE TRIGGER flightdeck_pg_general_grant_keep BEFORE DELETE OR UPDATE ON flightdeck_pg_permission_grants
  FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_general_grant_keep();
