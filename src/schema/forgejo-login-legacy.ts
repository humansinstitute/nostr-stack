// Historical identity preservation only. No authentication, account creation or Git authority.
export const forgejoLoginIdentitySchema = `
  CREATE TABLE IF NOT EXISTS forgejo_login_identities (
    npub TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    initial_username TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- Seed existing account subjects before a later actor deletion or identity rotation.
  -- A previously established fresh-npub subject must never become an actor UUID.
  INSERT INTO forgejo_login_identities (npub, subject, initial_username)
  SELECT actor.npub, actor.id::text,
    COALESCE(alias.applied_username, alias.desired_username,
      'nostr-' || substr(md5(actor.npub), 1, 24))
  FROM flightdeck_pg_actors actor
  LEFT JOIN git_forgejo_actor_aliases alias ON alias.actor_id = actor.id
  ON CONFLICT (npub) DO NOTHING`;
