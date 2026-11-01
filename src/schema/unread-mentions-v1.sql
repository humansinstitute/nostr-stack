-- Exact mention positions share the resource read sequence; ordinary activity remains intact.
ALTER TABLE flightdeck_pg_threads ADD COLUMN IF NOT EXISTS attention JSONB NOT NULL DEFAULT '{"policy_version":1,"mention_activity_versions":{}}'::jsonb;
ALTER TABLE flightdeck_pg_messages ADD COLUMN IF NOT EXISTS mention_activity_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE flightdeck_pg_messages ADD COLUMN IF NOT EXISTS mention_positions JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Recover only unrevised historical messages with exact event associations.
-- Old revisions have no resource event position; do not attribute their later mentions to creation.
UPDATE flightdeck_pg_messages m SET mention_activity_version=p.version FROM (
 SELECT m.id,MAX((e.payload->>'activity_version')::bigint) AS version
 FROM flightdeck_pg_messages m JOIN flightdeck_pg_outbox_events e ON e.workspace_id=m.workspace_id
 AND e.entity_id=m.thread_id AND e.event_type IN ('flightdeck_pg.thread.created','flightdeck_pg.thread.updated')
 AND (e.payload->>'unarchived_by_message_id'=m.id::text OR (e.event_type='flightdeck_pg.thread.created' AND e.payload->>'source_message_id'=m.id::text))
 WHERE m.mention_activity_version=0 AND m.row_version=1 AND jsonb_array_length(CASE WHEN jsonb_typeof(m.metadata->'mentions')='array' THEN m.metadata->'mentions' ELSE '[]'::jsonb END)>0
 AND e.payload->>'activity_version' ~ '^[0-9]+$' GROUP BY m.id
) p WHERE m.id=p.id AND m.mention_activity_version=0;
CREATE OR REPLACE FUNCTION flightdeck_pg_stamp_message_mentions() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 SELECT COALESCE(jsonb_object_agg(a.id::text,CASE WHEN TG_OP='UPDATE' AND OLD.mention_activity_version>0 AND OLD.mention_positions ? a.id::text AND NEW.mention_positions ? a.id::text THEN (OLD.mention_positions->>a.id::text)::bigint ELSE NEW.mention_activity_version END),'{}'::jsonb)
 INTO NEW.mention_positions
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.metadata->'mentions')='array' THEN NEW.metadata->'mentions' ELSE '[]'::jsonb END) m
 JOIN flightdeck_pg_actors a ON (m->>'actor_id'=a.id::text OR (m->>'actor_id' IS NULL AND m->>'npub'=a.npub))
 WHERE a.kind='human' AND m->>'type' IN ('person','human','agent') AND a.id<>NEW.created_by_actor_id;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fd_stamp_message_mentions ON flightdeck_pg_messages;
CREATE TRIGGER fd_stamp_message_mentions BEFORE INSERT OR UPDATE OF metadata,mention_activity_version ON flightdeck_pg_messages FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_stamp_message_mentions();
UPDATE flightdeck_pg_messages SET mention_activity_version=mention_activity_version WHERE mention_positions='{}'::jsonb AND mention_activity_version>0;
CREATE OR REPLACE FUNCTION flightdeck_pg_refresh_thread_mentions(w UUID,target UUID) RETURNS VOID LANGUAGE sql AS $$
 WITH projection AS (SELECT jsonb_build_object('policy_version',1,'mention_activity_versions',COALESCE((
 SELECT jsonb_object_agg(actor_id,version) FROM (
 SELECT a.id::text AS actor_id,MAX(COALESCE((m.mention_positions->>a.id::text)::bigint,0)) AS version
 FROM flightdeck_pg_messages m CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.metadata->'mentions')='array' THEN m.metadata->'mentions' ELSE '[]'::jsonb END) mention
 JOIN flightdeck_pg_actors a ON (mention->>'actor_id'=a.id::text OR (mention->>'actor_id' IS NULL AND mention->>'npub'=a.npub))
 JOIN flightdeck_pg_workspace_memberships wm ON wm.workspace_id=w AND wm.actor_id=a.id
 WHERE m.workspace_id=w AND m.thread_id=target AND m.deleted_at IS NULL AND m.created_by_actor_id<>a.id
 AND a.kind='human' AND mention->>'type' IN ('person','human','agent') GROUP BY a.id
 ) positions),'{}'::jsonb)) AS value)
 UPDATE flightdeck_pg_threads t SET attention=p.value FROM projection p WHERE t.workspace_id=w AND t.id=target AND t.attention IS DISTINCT FROM p.value;
$$;
CREATE OR REPLACE FUNCTION flightdeck_pg_message_mentions_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 PERFORM flightdeck_pg_refresh_thread_mentions(NEW.workspace_id,NEW.thread_id); RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fd_message_mention_positions ON flightdeck_pg_messages;
CREATE TRIGGER fd_message_mention_positions AFTER INSERT OR UPDATE ON flightdeck_pg_messages FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_message_mentions_changed();
-- A historical revision has no recorded resource version. Never attribute an edit-added
-- recipient to the message's creation position (also repairs an early local projection).
WITH repaired AS (
 SELECT m.id,COALESCE((SELECT jsonb_object_agg(p.key,p.value) FROM jsonb_each(m.mention_positions) p
 WHERE (p.value::text)::bigint<>m.mention_activity_version OR EXISTS (
 SELECT 1 FROM flightdeck_pg_outbox_events original
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(original.payload->'mentions')='array' THEN original.payload->'mentions' ELSE '[]'::jsonb END) mention
 WHERE original.workspace_id=m.workspace_id AND original.entity_id=m.id AND original.event_type='flightdeck_pg.message.created'
 AND (mention->>'actor_id'=p.key OR (mention->>'actor_id' IS NULL AND mention->>'npub'=(SELECT npub FROM flightdeck_pg_actors WHERE id=p.key::uuid)))
 )), '{}'::jsonb) AS positions
 FROM flightdeck_pg_messages m WHERE m.row_version>1 AND m.mention_positions<>'{}'::jsonb AND EXISTS (
 SELECT 1 FROM flightdeck_pg_outbox_events e WHERE e.workspace_id=m.workspace_id AND e.entity_id=m.thread_id
 AND e.event_type IN ('flightdeck_pg.thread.created','flightdeck_pg.thread.updated')
 AND (e.payload->>'unarchived_by_message_id'=m.id::text OR (e.event_type='flightdeck_pg.thread.created' AND e.payload->>'source_message_id'=m.id::text))
 AND e.payload->>'activity_version'=m.mention_activity_version::text)
)
UPDATE flightdeck_pg_messages m SET mention_positions=r.positions FROM repaired r WHERE m.id=r.id AND m.mention_positions IS DISTINCT FROM r.positions;
SELECT flightdeck_pg_refresh_thread_mentions(workspace_id,id) FROM flightdeck_pg_threads;
CREATE OR REPLACE FUNCTION flightdeck_pg_mention_version(w UUID,kind TEXT,target UUID,viewer UUID) RETURNS BIGINT LANGUAGE sql STABLE AS $$
 SELECT COALESCE(MAX(version),0) FROM (
 SELECT COALESCE((attention->'mention_activity_versions'->>viewer::text)::bigint,0) AS version FROM flightdeck_pg_threads WHERE kind='thread' AND workspace_id=w AND id=target AND deleted_at IS NULL AND archived_at IS NULL
 UNION ALL
 SELECT COALESCE((attention->'mention_activity_versions'->>viewer::text)::bigint,0) FROM flightdeck_pg_tasks WHERE kind='task' AND workspace_id=w AND id=target AND deleted_at IS NULL
 UNION ALL
 SELECT GREATEST(COALESCE((attention->'mention_activity_versions'->>viewer::text)::bigint,0),CASE WHEN attention->>'body_actor_id' IS DISTINCT FROM viewer::text AND EXISTS (
 SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(metadata->'mentions')='array' THEN metadata->'mentions' ELSE '[]'::jsonb END) m WHERE m->>'type' IN ('person','human','agent') AND (m->>'actor_id'=viewer::text OR (m->>'actor_id' IS NULL AND m->>'npub'=(SELECT npub FROM flightdeck_pg_actors WHERE id=viewer)))) THEN COALESCE((attention->>'body_activity_version')::bigint,0) ELSE 0 END)
 FROM flightdeck_pg_docs WHERE kind='document' AND workspace_id=w AND id=target AND deleted_at IS NULL AND archived_at IS NULL
 ) versions WHERE EXISTS(SELECT 1 FROM flightdeck_pg_actors WHERE id=viewer AND kind='human')
$$;
