export type Delegation = { learner_npub: string; grantee_npub: string; can_read: boolean; can_write: boolean; revoked_at: string | null };

export function selectLearner(actor: string, hasOwnProfile: boolean, grants: Delegation[], write: boolean): string | null | 'ambiguous' {
  if (hasOwnProfile) return actor;
  const learners = [...new Set(grants.filter(g => g.grantee_npub === actor && !g.revoked_at && g.can_read && (!write || g.can_write)).map(g => g.learner_npub))];
  if (learners.length > 1) return 'ambiguous';
  return learners[0] ?? null;
}

export function mayReviewEvidence(reviewerNpub: string, submittedByNpub: string): boolean {
  return reviewerNpub !== submittedByNpub;
}

/**
 * Whether `grantId` is an active delegation held by `actor` for this action, read exactly as the learning routes read
 * it: under the learning RLS role with the actor set, and through the same `selectLearner` predicate (grantee = actor,
 * not revoked, can_read, and can_write for writes).
 */
export async function explicitGrantAllows(db: any, actor: string, grantId: string, write: boolean): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(grantId)) return false;
  return db.begin(async (sql: any) => {
    await sql`SET LOCAL ROLE tower_learning_rls_v1`;
    await sql`SELECT set_config('row_security', 'on', true)`;
    await sql`SELECT set_config('app.learning_actor_npub', ${actor}, true)`;
    await sql`SELECT set_config('app.learning_learner_npub', '', true)`;
    const grants = await sql`SELECT learner_npub, grantee_npub, can_read, can_write, revoked_at
      FROM learning_delegations WHERE id = ${grantId} AND grantee_npub = ${actor}`;
    const learner = selectLearner(actor, false, grants, write);
    return Boolean(learner) && learner !== 'ambiguous';
  });
}
