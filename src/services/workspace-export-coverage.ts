import { recordFamilies } from './flightdeck-record-families';
import { BILLABLE_STORAGE_TABLES } from './hosting-storage-classification';

/** What the migration export delivers, table by table. Every billable (customer) table must be either covered or declared uncovered
 * with a category; a test fails when a new table is added unclassified, so the manifest can never silently claim more than it exports. */
export const EXPORT_RECORD_TABLES: string[] = Object.values(recordFamilies).map(suffix => `flightdeck_pg_${suffix}`);
/** Retained history delivered as versions of an exported parent, with the parent's authority. */
export const EXPORT_HISTORY_TABLES = ['flightdeck_pg_doc_versions', 'flightdeck_pg_doc_recovery_versions', 'flightdeck_pg_file_versions', 'flightdeck_pg_daily_note_versions'] as const;
export const EXPORT_COVERED_TABLES: ReadonlySet<string> = new Set([...EXPORT_RECORD_TABLES, ...EXPORT_HISTORY_TABLES]);

export type UncoveredCategory = 'content' | 'app_data' | 'git' | 'derived' | 'access' | 'settings';
/** `content`, `app_data` and `git` are customer content: while any is unexported the manifest status is `incomplete`.
 * `derived` tables are reconstructed from exported rows (storage links come back as asset references). `access` and `settings`
 * are authority and preference state, deliberately not part of a content export. */
export const EXPORT_REQUIRED_CATEGORIES: ReadonlySet<UncoveredCategory> = new Set(['content', 'app_data', 'git']);

const list = (category: UncoveredCategory, ...tables: string[]) => tables.map(t => [`flightdeck_pg_${t}`, category] as const);
export const EXPORT_UNCOVERED: Record<string, UncoveredCategory> = Object.fromEntries([
  ...list('content', 'canvases', 'canvas_elements', 'canvas_naplets', 'canvas_orders', 'canvas_visibility_principals', 'org_data_records', 'org_data_types', 'approvals',
    'workrooms', 'workroom_events', 'workroom_links', 'workroom_participants', 'reactions', 'task_watchers', 'drive_shares', 'agent_activities', 'agent_activity_commentary',
    'agent_work_receipts', 'response_activities', 'invocations', 'napplets', 'napplet_bundles', 'napplet_collections', 'napplet_releases', 'channel_move_receipts'),
  ...list('app_data', 'app_storage_objects'),
  ['managed_app_storage_objects', 'app_data'], ['managed_storage_graph', 'app_data'], ['managed_storage_refs', 'app_data'], ['managed_storage_set_pages', 'app_data'], ['managed_storage_sets', 'app_data'],
  ['git_branch_policies', 'git'], ['git_forgejo_repository_bindings', 'git'], ['git_forgejo_workspace_bindings', 'git'], ['git_repositories', 'git'], ['git_repository_grants', 'git'], ['git_workspace_namespaces', 'git'],
  ...list('derived', 'storage_links'),
  ...list('access', 'permission_grants', 'groups', 'group_edges', 'group_memberships', 'workspace_memberships', 'workspace_member_removals', 'workspace_agent_managers', 'wapp_delegations',
    'wapp_publishing_destinations', 'wapp_publishing_grants', 'agent_access_profiles', 'daily_scope_agent_access'),
  ...list('settings', 'workspace_general', 'notification_categories', 'notification_channel_preferences', 'notification_preferences', 'notification_rules', 'notification_sources',
    'agent_notification_subscriptions', 'private_preferences', 'personal_agent_settings', 'event_subscription_agents', 'wapp_activity_mutes', 'wapp_activity_user_state',
    'napplet_installations', 'app_blossom_publications', 'blossom_message_publications', 'blossom_publications'),
]);

/** Billable tables the export does not deliver, with the reason class. Computed from the classification, not hand-maintained. */
export function exportCoverage() {
  const uncovered = BILLABLE_STORAGE_TABLES.filter(t => !EXPORT_COVERED_TABLES.has(t)).map(table => ({ table, category: EXPORT_UNCOVERED[table] ?? 'content' as UncoveredCategory }));
  return {
    record_families: Object.keys(recordFamilies),
    history_tables: [...EXPORT_HISTORY_TABLES] as string[],
    uncovered,
    uncovered_required: uncovered.filter(u => EXPORT_REQUIRED_CATEGORIES.has(u.category)),
  };
}
