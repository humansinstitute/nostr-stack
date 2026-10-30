# Default DMs navigation

Every current workspace member must be able to read the canonical `DMs` scope
(`kind: dm`). This is a navigation default, not permission to read its channels.
Tower grants only `scope.read` to the workspace's `Workspace` group. Conversation
read/write/manage grants remain independent and participant-specific.

`reconcileFlightDeckPgDmDefaults` runs during runtime schema reconciliation,
workspace setup, ordinary member provisioning and atomic group enrollment.
Invitation acceptance uses ordinary member provisioning. Membership administration
removes members or manages the agent-manager role; it does not implicitly enroll
members. Existing membership/retirement guards remain authoritative.

The reconciler restores this one default even when an older grant was revoked.
Other scope, channel and workspace revocations remain authoritative. The active
grant unique index makes repeated and concurrent reconciliation idempotent.
A new grant emits the existing `scope.access_updated` scope event; repeat passes
emit nothing. The canonical access revision drives historic scope catchup through
record sync. Web's fallback event handling and the native structure event reducer
refresh navigation; this requires no new client contract.

Normal scope access editing owns only `context.edit` and `scope.manage`, so it
cannot revoke the navigation grant. Scope archival already excludes `dm`, and
scope updates cannot rename it away from its canonical navigation identity.
This does not make private messages available to the Workspace group, restore a
retired member, or confer permissions in another workspace. Direct database
administration can still violate invariants until the next reconciliation.

`tests/flightdeck-pg-setup.test.ts` exercises actual startup, provisioning,
concurrent joins, enrollment, authenticated navigation/message API reads and
writes, incremental access catchup, repeat reconciliation and privacy denials
against disposable Postgres. Live device sessions remain a separate check.
