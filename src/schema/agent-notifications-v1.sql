-- Strict agent notification inbox v1 (org.wingman.nstack.agent-notifications). Idempotent and additive.
-- A notification-only bot receives only rows ADDRESSED to its verified identity. Rows carry no content; context is a
-- separate, recipient-bound, revalidated read. Human notification tables, /events and /sync are untouched.

-- Durable projection queue, written in the SAME transaction as the source outbox row. Claimed with SKIP LOCKED, so
-- discovery never depends on outbox row_version commit order.
CREATE TABLE IF NOT EXISTS flightdeck_pg_agent_notification_intake (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL,
  outbox_event_id UUID NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'done', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  outcome TEXT,
  last_error TEXT,
  -- Addressing facts that are not in the outbox payload, captured by the intake trigger INSIDE the source
  -- transaction (exact revision): Agent Direct branch recipient and DM participants. NULL for backfilled rows.
  addressing_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at TIMESTAMPTZ
);
ALTER TABLE flightdeck_pg_agent_notification_intake ADD COLUMN IF NOT EXISTS addressing_snapshot JSONB;
CREATE INDEX IF NOT EXISTS idx_fd_agent_notification_intake_due ON flightdeck_pg_agent_notification_intake (next_attempt_at)
  WHERE state IN ('pending', 'leased');

-- Per-recipient commit-ordered sequence. The row lock is held until the projecting transaction commits, so a reader
-- can never observe seq N+1 before seq N for the same recipient.
CREATE TABLE IF NOT EXISTS flightdeck_pg_agent_notification_counters (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  recipient_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  last_seq BIGINT NOT NULL DEFAULT 0,
  retention_floor_seq BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, recipient_actor_id)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_agent_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  recipient_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'chat_mention', 'direct_message', 'agent_direct_recipient', 'task_assigned', 'task_mention', 'task_comment_mention',
    'document_mention', 'document_comment_mention', 'invocation', 'document_review'
  )),
  reason TEXT NOT NULL,
  -- Immutable addressing snapshot: derived from the same-transaction outbox payload of this exact source revision.
  addressing JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_outbox_event_id UUID NOT NULL,
  source_event_type TEXT NOT NULL,
  source_created_at TIMESTAMPTZ NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('message', 'task', 'task_comment', 'doc', 'doc_comment', 'invocation')),
  source_id UUID NOT NULL,
  source_version BIGINT,
  scope_id UUID,
  channel_id UUID,
  thread_id UUID,
  task_id UUID,
  doc_id UUID,
  author_actor_id UUID,
  -- Record-access oracle key the recipient must hold at projection, delivery and context time.
  acl_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, recipient_actor_id, seq),
  UNIQUE (workspace_id, recipient_actor_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_fd_agent_notifications_created ON flightdeck_pg_agent_notifications (created_at);

-- Consumer subscriptions. The floor is fixed by Tower at first creation and enforced on every selection.
CREATE TABLE IF NOT EXISTS flightdeck_pg_agent_notification_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  recipient_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  consumer_id TEXT NOT NULL CHECK (consumer_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  floor_at TIMESTAMPTZ NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1,
  -- Contiguous acknowledged position: every eligible notification with seq <= this value has an ack.
  acked_through_seq BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (workspace_id, recipient_actor_id, consumer_id),
  UNIQUE (workspace_id, recipient_actor_id, id)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_agent_notification_acks (
  notification_id UUID NOT NULL REFERENCES flightdeck_pg_agent_notifications(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES flightdeck_pg_agent_notification_subscriptions(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('handled', 'suppressed', 'source_gone', 'failed_permanent')),
  code TEXT CHECK (code IS NULL OR code ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  acked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id, subscription_id)
);

-- Atomic replay detection for strict exact-request NIP-98 on agent notification routes.
CREATE TABLE IF NOT EXISTS flightdeck_pg_nip98_consumed_events (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  signer_npub TEXT NOT NULL,
  route TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fd_nip98_consumed_at ON flightdeck_pg_nip98_consumed_events (consumed_at);

-- Server-enforced authorization ceiling for notification-only agents, per (workspace, agent): it binds requests that
-- target that workspace's resources. Another tenant's classification never affects this workspace.
CREATE TABLE IF NOT EXISTS flightdeck_pg_agent_access_profiles (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  profile TEXT NOT NULL CHECK (profile IN ('notification_only')),
  policy_version INTEGER NOT NULL DEFAULT 1,
  set_by_actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_fd_agent_access_profiles_actor ON flightdeck_pg_agent_access_profiles (actor_id);

-- Retained audit evidence: classification changes, poison/dead-letter outcomes, terminal acks.
CREATE TABLE IF NOT EXISTS flightdeck_pg_agent_notification_audit (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL,
  actor_id UUID,
  subject_actor_id UUID,
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fd_agent_notification_audit_ws ON flightdeck_pg_agent_notification_audit (workspace_id, created_at);

CREATE OR REPLACE FUNCTION flightdeck_pg_agent_notification_next_seq(w UUID, a UUID) RETURNS BIGINT
LANGUAGE sql AS $$
  INSERT INTO flightdeck_pg_agent_notification_counters (workspace_id, recipient_actor_id, last_seq) VALUES (w, a, 1)
  ON CONFLICT (workspace_id, recipient_actor_id) DO UPDATE SET last_seq = flightdeck_pg_agent_notification_counters.last_seq + 1
  RETURNING last_seq
$$;

-- Transactional intake: only addressing-bearing structured event types are captured. Runs in the source transaction,
-- so the snapshot reflects exactly the revision that produced this outbox row.
CREATE OR REPLACE FUNCTION flightdeck_pg_agent_notification_intake_capture() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE snap JSONB;
BEGIN
  IF NEW.event_type IN (
    'flightdeck_pg.message.created', 'flightdeck_pg.message.revised', 'flightdeck_pg.task_comment.created',
    'flightdeck_pg.doc_comment.created', 'flightdeck_pg.document_comment_mention_added', 'flightdeck_pg.task_assignment.assigned',
    'flightdeck_pg.task.created', 'flightdeck_pg.task.updated', 'flightdeck_pg.document_mention_added',
    'flightdeck_pg.invocation.created'
  ) THEN
    IF NEW.event_type IN ('flightdeck_pg.message.created', 'flightdeck_pg.message.revised') AND NEW.entity_id IS NOT NULL THEN
      SELECT jsonb_build_object(
        'message_row_version', m.row_version,
        'agent_direct_recipient_npub', m.metadata->>'agent_direct_recipient_npub',
        'channel_kind', c.kind,
        'dm_participant_npubs', COALESCE(to_jsonb(c.participant_npubs), '[]'::jsonb))
      INTO snap
      FROM flightdeck_pg_messages m JOIN flightdeck_pg_channels c ON c.workspace_id = m.workspace_id AND c.id = m.channel_id
      WHERE m.workspace_id = NEW.workspace_id AND m.id = NEW.entity_id;
    END IF;
    INSERT INTO flightdeck_pg_agent_notification_intake (workspace_id, outbox_event_id, addressing_snapshot)
    VALUES (NEW.workspace_id, NEW.id, snap)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fd_agent_notification_intake_capture ON flightdeck_pg_outbox_events;
CREATE TRIGGER fd_agent_notification_intake_capture AFTER INSERT ON flightdeck_pg_outbox_events
  FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_agent_notification_intake_capture();

-- Canonical relationship oracle, evaluated at delivery and context time (never trusted from the inbox row alone):
-- 'ok' | 'source_gone' (deleted/moved source, archived channel, deleted thread) | 'relationship_removed' (mention
-- removed, task reassigned, invocation closed/withdrawn, DM participant removed).
CREATE OR REPLACE FUNCTION flightdeck_pg_agent_mentions_contain(list JSONB, a UUID, npub TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(list) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(list) e
    WHERE e->>'actor_id' = a::text OR (npub IS NOT NULL AND e->>'npub' = npub))
$$;

CREATE OR REPLACE FUNCTION flightdeck_pg_agent_notification_relation(nid UUID) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE n RECORD; rnpub TEXT; meta JSONB; ok BOOLEAN := FALSE;
BEGIN
  SELECT * INTO n FROM flightdeck_pg_agent_notifications WHERE id = nid;
  IF NOT FOUND THEN RETURN 'source_gone'; END IF;
  SELECT npub INTO rnpub FROM flightdeck_pg_actors WHERE id = n.recipient_actor_id;
  IF NOT EXISTS (SELECT 1 FROM flightdeck_pg_channels c WHERE c.workspace_id = n.workspace_id AND c.id = n.channel_id AND c.archived_at IS NULL) THEN
    RETURN 'source_gone';
  END IF;
  IF n.source_type = 'message' THEN
    SELECT m.metadata INTO meta FROM flightdeck_pg_messages m
    WHERE m.workspace_id = n.workspace_id AND m.id = n.source_id AND m.deleted_at IS NULL
      AND m.channel_id = n.channel_id AND m.thread_id IS NOT DISTINCT FROM n.thread_id;
    IF NOT FOUND THEN RETURN 'source_gone'; END IF;
    IF n.thread_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM flightdeck_pg_threads t WHERE t.workspace_id = n.workspace_id
        AND t.id = n.thread_id AND t.deleted_at IS NULL AND t.channel_id = n.channel_id) THEN
      RETURN 'source_gone';
    END IF;
    IF n.kind = 'chat_mention' THEN ok := flightdeck_pg_agent_mentions_contain(meta->'mentions', n.recipient_actor_id, rnpub);
    ELSIF n.kind = 'agent_direct_recipient' THEN ok := meta->>'agent_direct_recipient_npub' = rnpub;
    ELSIF n.kind = 'direct_message' THEN
      ok := EXISTS (SELECT 1 FROM flightdeck_pg_channels c WHERE c.workspace_id = n.workspace_id AND c.id = n.channel_id AND rnpub = ANY(c.participant_npubs));
    END IF;
  ELSIF n.source_type IN ('task', 'task_comment') THEN
    SELECT t.metadata INTO meta FROM flightdeck_pg_tasks t WHERE t.workspace_id = n.workspace_id AND t.id = n.task_id AND t.deleted_at IS NULL AND t.channel_id = n.channel_id;
    IF NOT FOUND THEN RETURN 'source_gone'; END IF;
    IF n.kind = 'task_assigned' THEN
      ok := meta->>'assigned_to_npub' = rnpub OR EXISTS (SELECT 1 FROM flightdeck_pg_task_assignments x
        WHERE x.workspace_id = n.workspace_id AND x.task_id = n.task_id AND x.actor_id = n.recipient_actor_id AND x.deleted_at IS NULL);
    ELSIF n.kind = 'task_mention' THEN ok := flightdeck_pg_agent_mentions_contain(meta->'mentions', n.recipient_actor_id, rnpub);
    ELSIF n.kind = 'task_comment_mention' THEN
      SELECT c.metadata INTO meta FROM flightdeck_pg_task_comments c WHERE c.workspace_id = n.workspace_id AND c.id = n.source_id AND c.task_id = n.task_id AND c.deleted_at IS NULL;
      IF NOT FOUND THEN RETURN 'source_gone'; END IF;
      ok := flightdeck_pg_agent_mentions_contain(meta->'mentions', n.recipient_actor_id, rnpub);
    END IF;
  ELSIF n.source_type IN ('doc', 'doc_comment') THEN
    SELECT d.metadata INTO meta FROM flightdeck_pg_docs d WHERE d.workspace_id = n.workspace_id AND d.id = n.doc_id AND d.deleted_at IS NULL AND d.channel_id = n.channel_id;
    IF NOT FOUND THEN RETURN 'source_gone'; END IF;
    IF n.kind = 'document_mention' THEN ok := flightdeck_pg_agent_mentions_contain(meta->'mentions', n.recipient_actor_id, rnpub);
    ELSIF n.kind = 'document_comment_mention' THEN
      SELECT c.metadata INTO meta FROM flightdeck_pg_doc_comments c WHERE c.workspace_id = n.workspace_id AND c.id = n.source_id AND c.doc_id = n.doc_id AND c.deleted_at IS NULL;
      IF NOT FOUND THEN RETURN 'source_gone'; END IF;
      ok := flightdeck_pg_agent_mentions_contain(meta->'mentions', n.recipient_actor_id, rnpub);
    END IF;
  ELSIF n.source_type = 'invocation' THEN
    SELECT i.recipients, (i.status = 'open') INTO meta, ok FROM flightdeck_pg_invocations i
    WHERE i.workspace_id = n.workspace_id AND i.id = n.source_id AND i.channel_id = n.channel_id;
    IF NOT FOUND THEN RETURN 'source_gone'; END IF;
    ok := ok AND flightdeck_pg_agent_mentions_contain(meta, n.recipient_actor_id, rnpub);
  END IF;
  RETURN CASE WHEN ok THEN 'ok' ELSE 'relationship_removed' END;
END $$;

-- One-shot activation backfill: the previous 24 hours of addressing-bearing outbox events (idempotent via the intake
-- UNIQUE). CREATE TRIGGER above takes a SHARE ROW EXCLUSIVE lock on the outbox, so every insert either committed
-- before the trigger existed (covered here) or is captured by the trigger: no activation-boundary hole.
CREATE TABLE IF NOT EXISTS flightdeck_pg_agent_notification_system (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  backfilled_at TIMESTAMPTZ
);
INSERT INTO flightdeck_pg_agent_notification_system (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
WITH mark AS (
  UPDATE flightdeck_pg_agent_notification_system SET backfilled_at = NOW() WHERE singleton AND backfilled_at IS NULL RETURNING 1
)
INSERT INTO flightdeck_pg_agent_notification_intake (workspace_id, outbox_event_id)
SELECT o.workspace_id, o.id FROM flightdeck_pg_outbox_events o, mark
WHERE o.created_at >= NOW() - INTERVAL '24 hours'
  AND o.event_type IN (
    'flightdeck_pg.message.created', 'flightdeck_pg.message.revised', 'flightdeck_pg.task_comment.created',
    'flightdeck_pg.doc_comment.created', 'flightdeck_pg.document_comment_mention_added', 'flightdeck_pg.task_assignment.assigned',
    'flightdeck_pg.task.created', 'flightdeck_pg.task.updated', 'flightdeck_pg.document_mention_added',
    'flightdeck_pg.invocation.created'
  )
ON CONFLICT DO NOTHING;
