import { recordFamilies } from './flightdeck-record-families';
import { BILLABLE_STORAGE_TABLES } from './hosting-storage-classification';
import { EXPORT_ADAPTER_TABLES } from './workspace-export-adapters';

/** What the migration export delivers, table by table. Every billable (customer) table must be either covered or declared uncovered
 * with a category; a test fails when a new table is added unclassified, so the manifest can never silently claim more than it exports. */
export const EXPORT_RECORD_TABLES: string[] = Object.values(recordFamilies).map(suffix => `flightdeck_pg_${suffix}`);
/** Retained history delivered as versions of an exported parent, with the parent's authority. */
export const EXPORT_HISTORY_TABLES = ['flightdeck_pg_doc_versions', 'flightdeck_pg_doc_recovery_versions', 'flightdeck_pg_file_versions', 'flightdeck_pg_daily_note_versions'] as const;
/** Non-record-sync content delivered by per-table adapters under the read rule of each table's existing route. */
export const EXPORT_CONTENT_TABLES: string[] = EXPORT_ADAPTER_TABLES;
export const EXPORT_COVERED_TABLES: ReadonlySet<string> = new Set([...EXPORT_RECORD_TABLES, ...EXPORT_HISTORY_TABLES, ...EXPORT_CONTENT_TABLES]);

export type UncoveredCategory = 'content' | 'app_data' | 'git' | 'derived' | 'access' | 'settings' | 'operational';
/** `content`, `app_data` and `git` are customer content: while any is unexported the manifest status is `incomplete`.
 * `derived` tables are reconstructed from exported rows (storage links come back as asset references). `access` and `settings`
 * are authority and preference state, deliberately not part of a content export. `operational` rows are transient or receipt state
 * of the service itself (see UNCOVERED_REASON); reclassifying one as content is a one-line change. */
export const EXPORT_REQUIRED_CATEGORIES: ReadonlySet<UncoveredCategory> = new Set(['content', 'app_data', 'git']);

const list = (category: UncoveredCategory, ...tables: string[]) => tables.map(t => [`flightdeck_pg_${t}`, category] as const);
export const EXPORT_UNCOVERED: Record<string, UncoveredCategory> = Object.fromEntries([
  ...list('content', 'drive_shares', 'napplets', 'napplet_bundles', 'napplet_collections', 'napplet_releases'),
  ...list('operational', 'response_activities', 'channel_move_receipts', 'agent_work_receipts'),
  ...list('app_data', 'app_storage_objects'),
  ['managed_app_storage_objects', 'app_data'], ['managed_storage_graph', 'app_data'], ['managed_storage_refs', 'app_data'], ['managed_storage_set_pages', 'app_data'], ['managed_storage_sets', 'app_data'],
  ['git_branch_policies', 'git'], ['git_forgejo_repository_bindings', 'git'], ['git_forgejo_workspace_bindings', 'git'], ['git_repositories', 'git'], ['git_repository_grants', 'git'], ['git_workspace_namespaces', 'git'],
  ...list('derived', 'storage_links'),
  ...list('access', 'permission_grants', 'groups', 'group_edges', 'group_memberships', 'workspace_memberships', 'workspace_member_removals', 'workspace_agent_managers', 'wapp_delegations',
    'wapp_publishing_destinations', 'wapp_publishing_grants', 'agent_access_profiles', 'daily_scope_agent_access', 'canvas_visibility_principals'),
  ...list('settings', 'workspace_general', 'notification_categories', 'notification_channel_preferences', 'notification_preferences', 'notification_rules', 'notification_sources',
    'agent_notification_subscriptions', 'private_preferences', 'personal_agent_settings', 'event_subscription_agents', 'wapp_activity_mutes', 'wapp_activity_user_state',
    'napplet_installations', 'app_blossom_publications', 'blossom_message_publications', 'blossom_publications'),
]);
/** Why a table is not delivered yet, for tables where the reason is not obvious from the category. */
export const UNCOVERED_REASON: Record<string, string> = {
  flightdeck_pg_napplet_bundles: 'Needs the napplet registry capability model (org-data napplet routes).', flightdeck_pg_napplets: 'Needs the napplet registry capability model.',
  flightdeck_pg_napplet_collections: 'Needs the napplet registry capability model.', flightdeck_pg_napplet_releases: 'Needs the napplet registry capability model.',
  flightdeck_pg_drive_shares: 'Owner-private share descriptors with host endpoints; needs an owner-only adapter and a decision on exporting endpoints.',
  flightdeck_pg_app_storage_objects: 'Registered-app data is governed by app delegation (docs/contract/registered-app-storage-v1.md), not by member ACL.',
  flightdeck_pg_response_activities: 'Transient response-status rows (queued/thinking/cleared, with expiry); not retained customer content.',
  flightdeck_pg_channel_move_receipts: 'Idempotency receipts of channel moves; the moved records themselves are exported.',
  flightdeck_pg_agent_work_receipts: 'Delivery receipts of the agent notification pipeline; the underlying records are exported.',
  flightdeck_pg_canvas_visibility_principals: 'Sharing topology of a canvas; its content is exported under the canvas visibility rule.',
  git_repositories: 'Forgejo owns repositories natively; no workspace attribution or byte/archive provider exists in Tower (docs/contract/hosting-storage-peak-v1.md).',
};
for (const table of Object.keys(EXPORT_UNCOVERED)) if (table.startsWith('git_') || table.startsWith('managed_')) UNCOVERED_REASON[table] ??= table.startsWith('git_') ? UNCOVERED_REASON.git_repositories! : 'Registered-app data is governed by app delegation (docs/contract/managed-app-storage.md), not by member ACL.';

/** Billable tables the export does not deliver, with the reason class. Computed from the classification, not hand-maintained. */
export function exportCoverage() {
  const uncovered = BILLABLE_STORAGE_TABLES.filter(t => !EXPORT_COVERED_TABLES.has(t)).map(table => ({ table, category: EXPORT_UNCOVERED[table] ?? 'content' as UncoveredCategory, reason: UNCOVERED_REASON[table] ?? null }));
  return {
    record_families: Object.keys(recordFamilies),
    content_tables: [...EXPORT_CONTENT_TABLES],
    history_tables: [...EXPORT_HISTORY_TABLES] as string[],
    uncovered,
    uncovered_required: uncovered.filter(u => EXPORT_REQUIRED_CATEGORIES.has(u.category)),
  };
}
