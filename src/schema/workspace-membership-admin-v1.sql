-- Explicit opt-in only: existing workspace.manage grants do not assign this role.
CREATE TABLE IF NOT EXISTS flightdeck_pg_workspace_agent_managers (
 workspace_id UUID NOT NULL,
 actor_id UUID NOT NULL,
 created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id,actor_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_workspace_member_removals (
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 removed_by_actor_id UUID REFERENCES flightdeck_pg_actors(id),
 PRIMARY KEY(workspace_id,actor_id)
);
ALTER TABLE flightdeck_pg_permission_grants ADD COLUMN IF NOT EXISTS workspace_role TEXT;
-- Generated grants use the same authority paths as ordinary grants. A role tag
-- distinguishes them from pre-existing/manual grants when the role is revoked.
CREATE OR REPLACE FUNCTION flightdeck_pg_agent_manager_grants(w UUID,a UUID,by_actor UUID) RETURNS VOID
LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,resource_channel_id,permission,created_by_actor_id,workspace_role)
 SELECT w,'actor',a,p.resource_type,s.id,c.id,p.permission,by_actor,'agent-manager'
 FROM flightdeck_pg_permission_definitions p
 LEFT JOIN flightdeck_pg_scopes s ON p.resource_type='scope' AND s.workspace_id=w
 LEFT JOIN flightdeck_pg_channels c ON p.resource_type='channel' AND c.workspace_id=w
 WHERE (p.resource_type='workspace' AND p.permission IN('workspace.read','workspace.manage','workspace.invite','event_subscription.manage','scope.create'))
 OR (p.resource_type='scope' AND s.id IS NOT NULL)
 OR (p.resource_type='channel' AND c.id IS NOT NULL)
 ON CONFLICT DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION flightdeck_pg_agent_manager_resources() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ DECLARE m RECORD; BEGIN
 FOR m IN SELECT * FROM flightdeck_pg_workspace_agent_managers WHERE workspace_id=NEW.workspace_id LOOP
  PERFORM flightdeck_pg_agent_manager_grants(m.workspace_id,m.actor_id,m.created_by_actor_id);
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS flightdeck_pg_agent_manager_scope ON flightdeck_pg_scopes;
CREATE TRIGGER flightdeck_pg_agent_manager_scope AFTER INSERT ON flightdeck_pg_scopes FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_agent_manager_resources();
DROP TRIGGER IF EXISTS flightdeck_pg_agent_manager_channel ON flightdeck_pg_channels;
CREATE TRIGGER flightdeck_pg_agent_manager_channel AFTER INSERT ON flightdeck_pg_channels FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_agent_manager_resources();
-- Authorship is durable actor identity, not an active-access relationship.
-- Preserve restrictive historical attribution instead of preventing retirement.
DO $$ DECLARE f RECORD; actor_column TEXT; BEGIN
 FOR f IN SELECT c.conrelid,c.conname,c.conkey FROM pg_constraint c
 WHERE c.contype='f' AND c.confrelid='flightdeck_pg_workspace_memberships'::regclass
 AND (c.confdeltype='r' OR c.confdeltype='n') LOOP
  SELECT attname INTO actor_column FROM pg_attribute WHERE attrelid=f.conrelid AND attnum=f.conkey[2];
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',f.conrelid::regclass,f.conname);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT',f.conrelid::regclass,f.conname,actor_column);
 END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS flightdeck_pg_member_removal_previews (
 token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 requester_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 state_hash TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '10 minutes'
);
ALTER TABLE v4_storage_objects ADD COLUMN IF NOT EXISTS pg_workspace_id UUID REFERENCES flightdeck_pg_workspaces(id);
CREATE OR REPLACE FUNCTION flightdeck_pg_member_retirement_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM flightdeck_pg_workspace_member_removals WHERE workspace_id=NEW.workspace_id AND actor_id=NEW.actor_id)
 AND current_setting('tower.explicit_member_enrollment',true) IS DISTINCT FROM (NEW.workspace_id::text||':'||NEW.actor_id::text) THEN
  RAISE EXCEPTION 'workspace_member_explicit_reenrollment_required' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS flightdeck_pg_member_retirement_guard ON flightdeck_pg_workspace_memberships;
CREATE TRIGGER flightdeck_pg_member_retirement_guard BEFORE INSERT ON flightdeck_pg_workspace_memberships FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_member_retirement_guard();
-- Publication/audit attribution survives retirement; active authority is revoked
-- explicitly before membership removal, including historical message publications.
DO $$ DECLARE f RECORD; BEGIN
 FOR f IN SELECT conname FROM pg_constraint WHERE contype='f'
 AND conrelid='flightdeck_pg_blossom_message_publications'::regclass
 AND confrelid='flightdeck_pg_workspace_memberships'::regclass LOOP
  EXECUTE format('ALTER TABLE flightdeck_pg_blossom_message_publications DROP CONSTRAINT %I',f.conname);
  EXECUTE format('ALTER TABLE flightdeck_pg_blossom_message_publications ADD CONSTRAINT %I FOREIGN KEY(actor_id) REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT',f.conname);
 END LOOP;
END $$;
