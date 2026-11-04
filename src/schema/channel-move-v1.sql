-- Channel location is a composite authority key. Defer its dependent checks only
-- inside a relocation transaction; ordinary writers keep immediate FK checking.
DO $$ DECLARE c RECORD; BEGIN
 FOR c IN SELECT p.conrelid::regclass AS tab,p.conname FROM pg_constraint p
 JOIN pg_class t ON t.oid=p.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
 WHERE p.contype='f' AND n.nspname='public' AND starts_with(t.relname,'flightdeck_pg_')
 AND NOT p.condeferrable AND EXISTS (
 SELECT 1 FROM unnest(p.conkey) k JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=k WHERE a.attname='scope_id')
 LOOP EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',c.tab,c.conname); END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS flightdeck_pg_channel_move_previews (
 token UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 channel_id UUID NOT NULL, actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
 source_scope_id UUID NOT NULL, destination_scope_id UUID NOT NULL, fingerprint TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '15 minutes'
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_channel_move_receipts (
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE, mutation_id UUID NOT NULL,
 actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE, channel_id UUID NOT NULL,
 destination_scope_id UUID NOT NULL, confirmation_token UUID NOT NULL, result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,mutation_id)
);

-- Some additive families (private pins and notification records) deliberately do
-- not have composite FKs. Their writers must still serialize on channel authority.
CREATE OR REPLACE FUNCTION flightdeck_pg_channel_location_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE actual_scope UUID;
BEGIN
 IF NEW.channel_id IS NULL THEN RETURN NEW; END IF;
 SELECT scope_id INTO actual_scope FROM flightdeck_pg_channels WHERE workspace_id=NEW.workspace_id AND id=NEW.channel_id FOR KEY SHARE;
 IF NOT FOUND OR (NEW.scope_id IS NOT NULL AND NEW.scope_id IS DISTINCT FROM actual_scope) THEN
   RAISE EXCEPTION 'Channel location changed; reload the channel before writing' USING ERRCODE='23503';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t RECORD; BEGIN
 FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND starts_with(table_name,'flightdeck_pg_')
 AND column_name IN ('workspace_id','channel_id','scope_id') GROUP BY table_name HAVING count(*)=3
 LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=format('public.%I',t.table_name)::regclass AND tgname='fd_channel_location_guard') THEN
   EXECUTE format('CREATE TRIGGER fd_channel_location_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_channel_location_guard()',t.table_name);
 END IF;
 END LOOP;
END $$;
