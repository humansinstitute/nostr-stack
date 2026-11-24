/** Customer-facing storage meter (peak-v1): which workspace-UUID PostgreSQL tables are billable.
 *
 * Every public base table with a UUID `workspace_id` column must appear in exactly one list; a test fails when a new table is added
 * unclassified, so the meter never silently grows or shrinks. Excluded tables are service-operated state, not customer content.
 * Billable bytes are the same stored-column sizes the metering collector uses (sum of pg_column_size per column), so the periodic
 * measurement and the write-path delta journal agree on units. */

export const STORAGE_BASIS_VERSION = 'peak-v1';

/** Customer content and retained customer history (versions, comments, messages, files metadata, settings). */
export const BILLABLE_STORAGE_TABLES = [
  'flightdeck_pg_agent_access_profiles', 'flightdeck_pg_agent_activities', 'flightdeck_pg_agent_activity_commentary',
  'flightdeck_pg_agent_notification_subscriptions', 'flightdeck_pg_agent_work_receipts', 'flightdeck_pg_app_blossom_publications',
  'flightdeck_pg_app_storage_objects', 'flightdeck_pg_approvals', 'flightdeck_pg_audio_notes', 'flightdeck_pg_autopilot_connections',
  'flightdeck_pg_blossom_message_publications', 'flightdeck_pg_blossom_publications', 'flightdeck_pg_canvas_elements',
  'flightdeck_pg_canvas_naplets', 'flightdeck_pg_canvas_orders', 'flightdeck_pg_canvas_visibility_principals', 'flightdeck_pg_canvases',
  'flightdeck_pg_channel_move_receipts', 'flightdeck_pg_channels', 'flightdeck_pg_context_components', 'flightdeck_pg_context_references',
  'flightdeck_pg_daily_note_versions', 'flightdeck_pg_daily_notes', 'flightdeck_pg_daily_scope_agent_access', 'flightdeck_pg_doc_comments',
  'flightdeck_pg_doc_recovery_versions', 'flightdeck_pg_doc_versions', 'flightdeck_pg_docs', 'flightdeck_pg_drive_shares',
  'flightdeck_pg_event_subscription_agents', 'flightdeck_pg_feed_item_states', 'flightdeck_pg_feed_subscriptions',
  'flightdeck_pg_file_folders', 'flightdeck_pg_file_versions', 'flightdeck_pg_files', 'flightdeck_pg_group_edges',
  'flightdeck_pg_group_memberships', 'flightdeck_pg_groups', 'flightdeck_pg_invocations', 'flightdeck_pg_messages',
  'flightdeck_pg_napplet_bundles', 'flightdeck_pg_napplet_collections', 'flightdeck_pg_napplet_installations',
  'flightdeck_pg_napplet_releases', 'flightdeck_pg_napplets', 'flightdeck_pg_notification_categories',
  'flightdeck_pg_notification_channel_preferences', 'flightdeck_pg_notification_preferences', 'flightdeck_pg_notification_rules',
  'flightdeck_pg_notification_sources', 'flightdeck_pg_org_data_records', 'flightdeck_pg_org_data_types', 'flightdeck_pg_permission_grants',
  'flightdeck_pg_personal_agent_settings', 'flightdeck_pg_personal_wapps', 'flightdeck_pg_private_preferences', 'flightdeck_pg_reactions',
  'flightdeck_pg_resource_view_states', 'flightdeck_pg_response_activities', 'flightdeck_pg_scope_orders', 'flightdeck_pg_scopes',
  'flightdeck_pg_storage_links', 'flightdeck_pg_task_assignments', 'flightdeck_pg_task_comments', 'flightdeck_pg_task_watchers',
  'flightdeck_pg_tasks', 'flightdeck_pg_thread_pins', 'flightdeck_pg_threads', 'flightdeck_pg_wapp_activity_mutes',
  'flightdeck_pg_wapp_activity_user_state', 'flightdeck_pg_wapp_delegations', 'flightdeck_pg_wapp_publishing_destinations',
  'flightdeck_pg_wapp_publishing_grants', 'flightdeck_pg_workroom_events', 'flightdeck_pg_workroom_links',
  'flightdeck_pg_workroom_participants', 'flightdeck_pg_workrooms', 'flightdeck_pg_workspace_agent_managers',
  'flightdeck_pg_workspace_agents', 'flightdeck_pg_workspace_general', 'flightdeck_pg_workspace_member_removals',
  'flightdeck_pg_workspace_memberships',
  'git_branch_policies', 'git_forgejo_repository_bindings', 'git_forgejo_workspace_bindings', 'git_repositories',
  'git_repository_grants', 'git_workspace_namespaces',
  'managed_app_storage_objects', 'managed_storage_graph', 'managed_storage_refs', 'managed_storage_set_pages', 'managed_storage_sets',
] as const;

/** Service-operated state: excluded with a reason so the exclusion is explicit and reviewable. */
export const EXCLUDED_STORAGE_TABLES: Record<string, string> = {
  // Billing and onboarding evidence: charging for the meter's own evidence would make the bill self-referential.
  hosting_ledger: 'accounting', hosting_metering_workspaces: 'accounting', hosting_storage_snapshots: 'accounting',
  hosting_usage_hours: 'accounting', hosting_workspace_accounts: 'accounting', hosting_workspace_rate_carry: 'accounting',
  hosting_workspace_settlements: 'accounting', hosting_workspace_wallets: 'accounting', onboarding_intents: 'accounting',
  flightdeck_pg_hosted_signups: 'accounting',
  hosting_storage_enrollments: 'accounting', hosting_storage_deltas: 'accounting', hosting_storage_anchors: 'accounting',
  hosting_storage_boundaries: 'accounting', hosting_storage_hours: 'accounting',
  // Sync projection: trigger-maintained JSON copies of the entity tables above. Counting them would bill the same content twice.
  flightdeck_pg_record_current: 'service_replica', flightdeck_pg_record_heads: 'service_replica',
  flightdeck_pg_record_journal: 'service_replica', flightdeck_pg_record_clock: 'service_replica',
  // Protocol/session state with retention jobs.
  flightdeck_pg_record_cursors: 'ephemeral', flightdeck_pg_record_page_tokens: 'ephemeral', flightdeck_pg_record_aux_cursors: 'ephemeral',
  flightdeck_pg_record_adoptions: 'ephemeral', flightdeck_pg_record_clients: 'ephemeral', flightdeck_pg_feed_cursors: 'ephemeral',
  flightdeck_pg_notification_cursors: 'ephemeral', flightdeck_pg_edit_leases: 'ephemeral', flightdeck_pg_channel_move_previews: 'ephemeral',
  flightdeck_pg_member_removal_previews: 'ephemeral', managed_storage_previews: 'ephemeral', flightdeck_pg_wapp_install_intents: 'ephemeral',
  flightdeck_pg_resource_view_state_rollouts: 'ephemeral', git_capabilities: 'ephemeral',
  // Delivery queues and idempotency ledgers.
  flightdeck_pg_outbox_events: 'queue', flightdeck_pg_notification_alerts: 'queue', flightdeck_pg_notification_deliveries: 'queue',
  flightdeck_pg_notification_events: 'queue', flightdeck_pg_notification_intake: 'queue', flightdeck_pg_notification_items: 'queue',
  flightdeck_pg_notification_mutations: 'queue', flightdeck_pg_agent_notification_intake: 'queue',
  flightdeck_pg_agent_notifications: 'queue', flightdeck_pg_agent_notification_counters: 'queue',
  flightdeck_pg_feed_mutations: 'queue', flightdeck_pg_private_preference_mutations: 'queue', flightdeck_pg_scope_order_mutations: 'queue',
  flightdeck_pg_thread_pin_mutations: 'queue', flightdeck_pg_wapp_activity_items: 'queue',
  // Operational logs.
  flightdeck_pg_audit_events: 'operational_log', flightdeck_pg_notification_audit: 'operational_log',
  flightdeck_pg_agent_notification_audit: 'operational_log', flightdeck_pg_org_data_audit: 'operational_log',
  flightdeck_pg_wapp_publishing_audit: 'operational_log', git_audit_events: 'operational_log',
  git_credential_exchange_events: 'operational_log', git_nip98_mutation_events: 'operational_log',
};

export const STORAGE_CLASSIFIED_TABLES: ReadonlySet<string> = new Set([...BILLABLE_STORAGE_TABLES, ...Object.keys(EXCLUDED_STORAGE_TABLES)]);

/** Customer storage that the meter cannot attribute to a workspace. Reported to owners; never silently counted as zero. */
export const UNMETERED_STORAGE_CATEGORIES = [
  { id: 'git', label: 'Git / Forgejo repositories', required: true, reason: 'Forgejo owns repository bytes; no authoritative repository-to-workspace byte provider exists yet. Billable customer storage: until measured the policy is incomplete and the reserve fails closed.' },
  { id: 'graph', label: 'Graph', required: false, reason: 'Graph rows are attributed by owner npub, not workspace UUID; explicitly unsupported (not billed) in this version.' },
  { id: 'legacy_namespaces', label: 'Legacy encrypted records and WApp namespaces', required: false, reason: 'Not attributed to a workspace UUID; explicitly unsupported (not billed) in this version.' },
] as const;

/** Categories a complete customer meter must cover. Reserve, refunds and agent admission fail closed while any is unmetered. */
export const REQUIRED_STORAGE_CATEGORIES = ['postgres', 'objects', 'git'] as const;
