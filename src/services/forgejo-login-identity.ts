import { config } from '../config';
import { getDb } from '../db';

export { forgejoLoginIdentitySchema } from '../schema/forgejo-login-legacy';

/** Authentication only. No workspace membership, Git grant, provider or group queries. */
export async function resolveForgejoLoginIdentity(npub: string, sql = getDb()) {
  if (!config.git.oidcAllowedNpubs.includes(npub)) return null;
  // Preserve the previous issuer/sub pair for every existing actor. Persist the
  // first subject so later Flight Deck registration cannot change account links.
  const [identity] = await sql<{ subject: string; initial_username: string }[]>`
    INSERT INTO forgejo_login_identities (npub, subject, initial_username)
    SELECT ${npub}, COALESCE(actor.id::text, ${npub}),
      COALESCE(alias.applied_username, alias.desired_username,
        'nostr-' || substr(md5(${npub}), 1, 24))
    FROM (SELECT 1) seed
    LEFT JOIN flightdeck_pg_actors actor ON actor.npub = ${npub}
    LEFT JOIN git_forgejo_actor_aliases alias ON alias.actor_id = actor.id
    ON CONFLICT (npub) DO UPDATE SET npub = EXCLUDED.npub
    RETURNING subject, initial_username
  `;
  if (!identity) throw new Error('OIDC identity could not be resolved');
  return {
    sub: identity.subject,
    preferred_username: identity.initial_username,
    email: `${identity.subject}@users.tower.invalid`,
    email_verified: true as const,
  };
}
