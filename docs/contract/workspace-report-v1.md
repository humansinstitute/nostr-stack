# Workspace Report v1

`GET /api/v4/flightdeck-pg/workspaces/:workspaceId/workspace-report`
returns authorized aggregate activity and current inventory without content bodies.
NIP-98 resolved identity, workspace membership, app identity and effective nested
group grants apply in one read-only repeatable-read transaction. No analytics
owner/admin bypass or new permission exists. Session-key resolution uses the
normal authentication path; it does not substitute another actor's grants.

Required `range`: `7d`, `30d`, `90d`, `all`. Optional `top_n`: canonical decimal
integer 1..50, default 10. The optional existing `app_npub` must match, as must
`x-flightdeck-pg-app-npub` if supplied. Unknown/duplicate query keys are rejected.
The host fixes top_n=10; the frame supplies range only.

The response is `FlightDeckPgWorkspaceReportResponse` in `src/types.ts`:

- `identity`, `format: workspace-report-v1`, `workspace_id`, `range`, `from`,
  `to`, `as_of`, `timezone: UTC`, `complete: true`,
  `channel_policy: active-project-channels`.
- `activity: {messages, conversations}`: complete window totals.
- `inventory: {channels, conversations, tasks, documents, files}`: current totals.
  Tasks: `{total, open, completed, archived, by_state}`; by_state always includes
  new, ready, in_progress, review, done, archive, backlog, blocked, archived.
- `channels`: at most top_n rows `{channel_id, scope_id, name, scope_name,
  messages, conversations}`, ordered messages descending then channel UUID ascending.
- `ranking: {total_channels, returned_channels, has_more, other_messages,
  other_conversations}` explicitly describes ranking truncation. Shown + other
  equals complete activity. Zero channels participate in ranking.
- `coverage: {tasks_channels, documents_channels, files_channels}` counts eligible
  channels contributing readable inventory, not channels with nonzero inventory.

Universe: kind=channel, unarchived channel and scope, current channel.read grant.
Any active scope kind participates. DM/system channels are excluded. At most
2000 authorized channels; 2001 fails neutrally before history scans. Hidden
channels do not contribute totals, ranking, coverage, names or bound metadata.
Task.read is independently required. Documents and Files use existing doc.read
OR channel.read and file.read OR channel.read policy, so both coverage values
currently equal inventory.channels. The PG grant model has channel-level family
permissions, no individual task/document/File grant table. WApp-management or
support delegations grant no report authority. No resource-specific permission
is widened into channel authority. Counts are from canonical source tables,
never v4 records, record-journal windows or client materialization.

Window is rolling 168/720/2160 hours ending at millisecond server transaction
start, `[from,to)`; all has null from. to=as_of. Messages count nondeleted actual
channel rows once (including replies/unthreaded); inherited transcript history
is never duplicated. Thread archive does not remove activity. Activity
conversations are distinct actual nondeleted thread IDs among included messages,
including archived threads. Messages whose thread is deleted still count as
canonical message activity; their deleted thread does not count as a conversation.
Inventory conversations counts current nondeleted, unarchived threads independent
of window. Tasks count nondeleted logical rows including archive and archived:
completed=done, archived=archive+archived, open=all remaining states,
total=sum(by_state)=open+completed+archived. No completed-during-window inference.
Documents/Files count nondeleted unarchived logical rows once; no versions,
folders, storage objects or body hydration.

All counts and sums are nonnegative safe integers. Unknown task states,
overflow, overlong labels (>300 UTF-16 units), statement timeouts, oversized
responses (>64 KiB excluding fixed identity), and invalid source results return
neutral 503 report_unavailable/report_too_large with no partial payload.
Responses use Cache-Control: no-store. Ten-second statement budget bounds scans;
clients must treat failure as unavailable, never partial success. No database
schema or migration changes. Activation and live smoke remain a separate gate.
