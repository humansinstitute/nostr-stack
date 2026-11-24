const amount = { type: 'string', pattern: '^-?[0-9]+$', description: 'Exact tariff units. 144000000000 units = 1 USD; 1 unit = 1 byte-hour.' };
const decimal = { type: 'string', description: 'USD display decimal; exact amount remains in units.' };
const uuid = { type: 'string', format: 'uuid' };
const dateTime = { type: 'string', format: 'date-time' };
const nullableUuid = { type: ['string','null'], format: 'uuid' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, optional: string[] = []) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties).filter(key => !optional.includes(key)), properties });
const stripe = object({ configured: { type: 'boolean' }, mode: { type: 'string' }, live_rollout_blocked: { const: true } });
const workspaceMeasurement = { workspace_id: uuid, hour: dateTime, status: { enum: ['charged','unavailable','missed','partial_hour'] }, bytes: { type: ['string','null'] }, debit_units: amount };
const listResponse = (entry: string, account: boolean) => object({ workspace_id: uuid, ...(account ? { account_id: uuid } : {}), entries: { type: 'array', items: ref(entry) } });
export const hostingSchemas = {
  HostingAccountBillingStatus: { type: 'object', additionalProperties: false, required: ['version','billing_mode','workspace_id','stripe','account_id','currency','tariff','balance_units','balance_usd','promo_units','promo_usd','paid_usd','promo_expires_at','billing_state','depleted_at','grace_ends_at','hourly_burn_usd','estimated_runout_at','coverage','measurements'], properties: {
    can_top_up: { type: 'boolean' }, version: { const: 1 }, billing_mode: { const: 'usd_prepaid' }, workspace_id: uuid, account_id: uuid, currency: { const: 'USD' },
    tariff: { type: 'object', properties: { usd_per_gb_month: { const: '5' }, gb_bytes: { const: 1000000000 }, month_hours: { const: 720 }, units_per_usd: { const: '144000000000' } } },
    balance_units: amount, balance_usd: decimal, promo_units: amount, promo_usd: decimal, paid_usd: decimal,
    promo_expires_at: { type: 'string', format: 'date-time' }, depleted_at: { type: ['string','null'], format: 'date-time' }, grace_ends_at: { type: ['string','null'], format: 'date-time' },
    billing_state: { enum: ['active','read_only_grace','measurement_pending'] }, hourly_burn_usd: { type: ['string','null'] }, estimated_runout_at: { type: ['string','null'], format: 'date-time' },
    coverage: { const: 'objects_and_logical_pg_rows' }, measurements: { type: 'array', items: { $ref: '#/components/schemas/HostingAccountUsageMeasurement' } },
    stripe: { type: 'object', properties: { configured: { type: 'boolean' }, mode: { enum: ['test','live'] }, live_rollout_blocked: { const: true } } },
  } },
  HostingWorkspaceUsageMeasurement: object(workspaceMeasurement),
  HostingAccountUsageMeasurement: object({ ...workspaceMeasurement, evidence: { type: 'object' } }),
  HostingUsageHour: object({ ...workspaceMeasurement, account_id: uuid, evidence: { type: 'object' }, collected_at: dateTime }),
  HostingWorkspaceLedgerEntry: object({ id: uuid, workspace_id: uuid, kind: { enum: ['usage','workspace_usage'] }, amount_units: amount, created_at: dateTime }),
  HostingAccountLedgerEntry: object({ id: uuid, account_id: uuid, workspace_id: { type: ['string','null'], format: 'uuid' }, balance_scope: { enum: ['account','workspace'] }, kind: { enum: ['welcome','usage','admin','stripe','promo_expiry','workspace_allocation','workspace_usage','storage_peak','agent_usage'] }, amount_units: amount, paid_after_units: amount, promo_after_units: amount, idempotency_key: { type: 'string' }, reason: { type: 'string' }, actor_npub: { type: ['string','null'] }, created_at: dateTime, metadata: { type: 'object' }, snapshot_id: nullableUuid, rate_id: nullableUuid, duration_seconds: { type: ['integer','null'] } }),
  HostingLedgerEntry: { oneOf: [ref('HostingAccountLedgerEntry'), ref('HostingWorkspaceLedgerEntry')] },
  HostingWorkspaceBillingStatus: object({ can_top_up: { type: 'boolean' }, version: { const: 1 }, billing_mode: { const: 'usd_prepaid' }, workspace_id: uuid, financial_scope: { const: 'workspace' }, currency: { const: 'USD' }, measurements: { type: 'array', items: ref('HostingWorkspaceUsageMeasurement') }, stripe }, ['can_top_up']),
  HostingUnlinkedBillingStatus: object({ can_top_up: { type: 'boolean' }, version: { const: 1 }, billing_mode: { const: 'legacy_unlinked' }, workspace_id: uuid, stripe }, ['can_top_up']),
  HostingBillingStatus: { oneOf: [ref('HostingAccountBillingStatus'), ref('HostingWorkspaceBillingStatus'), ref('HostingUnlinkedBillingStatus')] },
  HostingLedgerResponse: { oneOf: [listResponse('HostingAccountLedgerEntry', true), listResponse('HostingWorkspaceLedgerEntry', false)] },
  HostingUsageResponse: { oneOf: [listResponse('HostingUsageHour', true), listResponse('HostingWorkspaceUsageMeasurement', false)] },
  HostingCheckoutRequest: { type: 'object', additionalProperties: false, required: ['amount_cents','idempotency_key','return_url'], properties: { amount_cents: { enum: [500,1000,2500,5000,10000] }, idempotency_key: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' }, return_url: { type: 'string', format: 'uri', description: 'Exact server allowlist member.' } } },
  HostingAdminGrantRequest: { type: 'object', additionalProperties: false, required: ['amount_cents','idempotency_key','reason'], properties: { amount_cents: { type: 'integer', minimum: 1, maximum: 1000000 }, idempotency_key: { type: 'string', minLength: 1, maxLength: 100 }, reason: { type: 'string', minLength: 1, maxLength: 1000 } } },
};
const response = (schema: any) => ({ description: 'Authenticated billing result', content: { 'application/json': { schema } } });
const errors = { '400': { description: 'Invalid input or Stripe signature' }, '401': { description: 'NIP-98 authentication required' }, '403': { description: 'Owner/manager or platform-admin authority required' }, '404': { description: 'Workspace not found' }, '409': { description: 'Billing unlinked or idempotency conflict' }, '503': { description: 'Stripe unconfigured, wrong mode, or live rollout blocked' } };
export const hostingPaths: Record<string, any> = Object.fromEntries(['status','usage','ledger','checkout','grant'].map(op => {
  const write=['checkout','grant'].includes(op);
  const schema=op==='status'?{ $ref: '#/components/schemas/HostingBillingStatus' }:op==='usage'||op==='ledger'?ref(op==='usage'?'HostingUsageResponse':'HostingLedgerResponse'):op==='checkout'?{type:'object',properties:{order_id:uuid,checkout_url:{type:['string','null'],format:'uri'},mode:{const:'test'},amount_cents:{type:'integer'}}}:{type:'object',properties:{entry:{$ref:'#/components/schemas/HostingLedgerEntry'}}};
  return [`/api/v4/hosting-billing/workspaces/{workspaceId}/${op}`, { [write?'post':'get']: {
    tags:['Billing'], summary:`USD hosting ${op}`, security:[{nip98:[]}],
    description: write?'Strict NIP-98 binds exact URL, method and body SHA256. Checkout requires customer owner; grant requires ADMIN_NPUB, never workspace admin. Stripe test-mode only.':'Account owner or workspace.manage access. Account owners see shared account balance; managers see workspace status and narrow workspace ledger entries only, with no shared balances or after-balances. Manager ledger contains usage/workspace_usage charges only, excluding funding and expiry. Manager status measurements and usage project workspace_id, hour, status, bytes and debit_units only, without account identifiers or nested evidence; this includes former owners with workspace.manage.',
    parameters:[{name:'workspaceId',in:'path',required:true,schema:uuid},...(!write&&op!=='status'?[{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:200,default:50}}]:[])],
    ...(write?{requestBody:{required:true,content:{'application/json':{schema:{$ref:`#/components/schemas/${op==='checkout'?'HostingCheckoutRequest':'HostingAdminGrantRequest'}`}}}}}:{}),
    responses:{[op==='checkout'?'201':'200']:response(schema),...errors},
  } }];
}));
hostingPaths['/api/v4/hosting-billing/stripe/webhook']={post:{tags:['Billing'],summary:'Stripe raw-body verified fulfillment',description:'Stripe-Signature verification with SDK and server retrieval. Paid USD account-bound test checkout grants once per PaymentIntent. Success redirects and unpaid events never credit. Also reconciles checkout.session.expired, charge.refunded, refund.* and charge.dispute.* events from retrieved authoritative provider state (idempotent, order-independent, ledger-backed reversals). Live mode remains blocked pending provider acceptance.',requestBody:{required:true,content:{'application/json':{schema:{type:'object'}}}},parameters:[{name:'Stripe-Signature',in:'header',required:true,schema:{type:'string'}}],responses:{'200':{description:'Verified event acknowledged'},'400':{description:'Invalid signature or binding'},'503':{description:'Unconfigured or blocked'}}}};

hostingPaths['/api/v4/hosting-billing/workspaces/{workspaceId}/metering'] = { get: {
  tags: ['Billing'], summary: 'Stored hourly workspace storage evidence', security: [{ nip98: [] }],
  description: 'Account owner or effective workspace.manage. Reads persisted snapshots only, including exact captured/period timestamps and freshness. Never collects, enrolls, grants or charges. Ledger-backed costs are queried separately from the workspace costs API. Cadence is hourly; no automatic activation.',
  parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: uuid }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }],
  responses: { '200': response({ type: 'object', required: ['version','workspace_id','as_of','cadence_seconds','next_measurement_at','freshness','snapshots','settlement'], properties: {
    version: { const: 1 }, workspace_id: uuid, as_of: { type: 'string', format: 'date-time' }, cadence_seconds: { const: 3600 }, next_measurement_at: { type: ['string','null'], format: 'date-time' },
    freshness: { enum: ['current','stale','unavailable'] }, settlement: { type: 'object', properties: { status: { const: 'separate_costs_api' }, reason: { type: 'string' } } },
    snapshots: { type: 'array', maxItems: 200, items: { type: 'object', properties: {
      scope: { const: 'workspace' }, coverage: { const: 'partial_attributed' }, id: uuid, workspace_id: uuid,
      period_start: { type: 'string', format: 'date-time' }, period_end: { type: 'string', format: 'date-time' }, captured_at: { type: ['string','null'], format: 'date-time' }, recorded_at: { type: 'string', format: 'date-time' },
      measurement_version: { const: 'stored-columns-accounting-excluded-v1' }, status: { enum: ['measured','unavailable','missed','partial_hour'] }, covered_bytes: { type: ['string','null'], pattern: '^[0-9]+$' },
      evidence: { type: ['object','null'], description: 'Persisted workspace-storage-v1 envelope; retains its actual captured as_of, partial coverage and exclusions.' }, reason: { type: ['string','null'] },
    } } },
  } }), ...errors },
} };

for (const [op, summary, properties] of [
  ['enroll','Explicit owner workspace billing enrollment',{confirm_v1_transition:{type:'boolean'}}],
  ['allocate','Allocate existing owner credit to this workspace',{amount_units:{type:'string',pattern:'^[0-9]{1,30}$'},idempotency_key:{type:'string',minLength:8,maxLength:100}}],
  ['rate','Append a future-hour immutable storage rate (platform administrator)',{version:{type:'string'},effective_at:{type:'string',format:'date-time'},numerator:{type:'string',pattern:'^[0-9]{1,30}$'},denominator:{type:'string',pattern:'^[0-9]{1,30}$'}}],
] as const) {
  hostingPaths[`/api/v4/hosting-billing/workspaces/{workspaceId}/${op}`]={post:{tags:['Billing'],summary,security:[{nip98:[]}],
    description:'Disabled unless HOSTING_WORKSPACE_BILLING_ENABLED=true and legacy credit billing is disabled. Strict NIP-98 URL/method/body proof. Enrollment and allocation require the current workspace owner; rate changes require platform administrator. No implicit account creation, conversion or grant. Exact existing USD tariff units; no default rate.',
    parameters:[{name:'workspaceId',in:'path',required:true,schema:uuid}],requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,required:Object.keys(properties),properties}}}},responses:{[op==='rate'?'201':'200']:response({type:'object'}),...errors}}};
}
hostingPaths['/api/v4/hosting-billing/workspaces/{workspaceId}/costs']={get:{tags:['Billing'],summary:'Persisted workspace costs and configured rate facts',security:[{nip98:[]}],description:'Account owner or workspace.manage; ledger-backed exact workspace settlements and immutable configured rate facts. Only current owner sees the matching workspace allocation balance; managers never receive owner account or wallet balances. GET cannot enroll, collect, process expiry or charge. Monetary fields and rate numerator/denominator are exact strings. Missing pricing/measurement is unbilled, never zero-cost inference.',parameters:[{name:'workspaceId',in:'path',required:true,schema:uuid},{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:200,default:50}}],responses:{'200':response({type:'object',properties:{version:{const:2},workspace_id:uuid,units_per_usd:{const:'144000000000'},as_of:{type:'string',format:'date-time'},wallet:{type:['object','null']},entries:{type:'array',items:{type:'object'}},rates:{type:'array',items:{type:'object'}}}}),...errors}}};

const nullableExact = { type: ['string','null'], pattern: '^-?[0-9]+$' };
const timestamp = { type: 'string', format: 'date-time' };
const nullableTimestamp = { type: ['string','null'], format: 'date-time' };
Object.assign(hostingSchemas, { HostingWorkspaceCosts: {
  type: 'object', required: ['version','workspace_id','currency','units_per_usd','as_of','billing_mode','wallet','entries','rates','summary','coverage','cost_precision'],
  properties: {
    version: { const: 2 }, workspace_id: uuid, currency: { const: 'USD' }, units_per_usd: { const: '144000000000' }, as_of: timestamp,
    billing_mode: { enum: ['workspace_allocated','not_enrolled'] }, coverage: { const: 'partial_attributed' }, cost_precision: { type: 'string' },
    wallet: { type: ['object','null'], description: 'Visible only to the current matching owner. Workspace allocation, never pooled account balance.', properties: { enabled_at: timestamp, balance_units: amount, paid_units: amount, promo_units: amount, promo_expires_at: nullableTimestamp, depleted_at: nullableTimestamp } },
    summary: { type: 'object', properties: { total_debit_units: nullableExact, charged_periods: { type: 'string', pattern: '^[0-9]+$' }, unbilled_periods: { type: 'string', pattern: '^[0-9]+$' } } },
    entries: { type: 'array', maxItems: 200, items: { type: 'object', properties: {
      snapshot_id: uuid, period_start: timestamp, status: { enum: ['charged','unavailable','missed','partial_hour','no_rate','owner_changed'] }, duration_seconds: { const: 3600 },
      debit_units: nullableExact, carry_before: nullableExact, carry_after: nullableExact, rate_version: { type: ['string','null'] }, numerator: nullableExact, denominator: nullableExact,
      ledger_id: { type: ['string','null'], format: 'uuid' }, amount_units: nullableExact,
    } } },
    rates: { type: 'array', maxItems: 200, items: { type: 'object', properties: { version: { type: 'string' }, effective_at: timestamp, measurement_version: { const: 'stored-columns-accounting-excluded-v1' }, numerator: amount, denominator: amount } } },
  },
} });
hostingPaths['/api/v4/hosting-billing/workspaces/{workspaceId}/costs'].get.responses['200'] = response({ $ref: '#/components/schemas/HostingWorkspaceCosts' });

const units = { type: 'string', pattern: '^[0-9]+$', description: 'Exact tariff units (144000000000 per USD; one unit per byte-hour).' };
Object.assign(hostingSchemas, {
  HostingStorageSummary: { type: 'object', required: ['version','account_id','currency','units_per_usd','as_of','basis','balances','runway','admission','coverage','workspaces'], properties: {
    version: { const: 1 }, account_id: uuid, currency: { const: 'USD' }, units_per_usd: { const: '144000000000' }, as_of: timestamp, basis: { const: 'peak-v1' }, workspace_id: uuid,
    balances: { type: 'object', description: 'Authoritative balances. protected_storage_units is the exact next-720-hour storage charge across every activated linked workspace; agent_available_units is spendable funds above it. agent_holds is not integrated yet and is reported unregistered, never as zero.', properties: {
      purchased_units: units, purchased_usd: decimal, promo_units: units, spendable_units: units, spendable_usd: decimal, reversal_debt_units: units, reversal_debt_usd: decimal,
      protected_storage_units: units, protected_storage_usd: decimal, protected_is_lower_bound: { type: 'boolean' }, agent_available_units: units, agent_available_usd: decimal,
      agent_holds: { type: 'object', properties: { registered: { const: false }, units: { type: ['string','null'] } } },
    } },
    runway: { type: 'object', description: 'Whole funded hours from the current UTC hour at the current measured size, honouring the remaining introduction. An upper bound: unmetered categories are excluded.', properties: {
      state: { enum: ['projected','unbounded','depleted','no_billed_workspace','measurement_unavailable'] }, hours: { type: ['string','null'] }, funded_until: nullableTimestamp, warning_days: { enum: [30, 7, 1, null] },
      assumes: { type: 'string' }, upper_bound: { type: 'boolean' }, unmetered_categories_excluded: { type: 'array', items: { type: 'string' } },
    } },
    admission: { type: 'object', properties: { agent_spend_allowed: { type: 'boolean' }, reason: { enum: ['storage_coverage_incomplete','storage_measurement_unavailable','reversal_debt','storage_reserve_not_covered', null] } } },
    coverage: { type: 'object', description: 'complete is false while any required category (Git) is unmetered or objects are counted without journal coverage; agent spend and refunds then stay closed.', properties: { complete: { type: 'boolean' }, required: { type: 'array', items: { type: 'string' } }, missing: { type: 'array', items: { type: 'string' } }, workspaces_with_reference_only_objects: { type: 'array', items: uuid }, metered: { type: 'array', items: { enum: ['postgres','objects'] } }, unmetered: { type: 'array', items: { type: 'object' } }, workspaces_unmeasured: { type: 'array', items: uuid } } },
    workspaces: { type: 'array', items: { type: 'object', properties: { workspace_id: uuid, activated: { type: 'boolean' }, activated_at: nullableTimestamp, intro_ends_at: nullableTimestamp, current_bytes: { type: ['string','null'] }, next_720_hours_units: { type: ['string','null'] } } } },
    hours: { type: 'array', maxItems: 200, items: { type: 'object' } },
  } },
  HostingWorkspaceStorageScope: object({ version: { const: 1 }, workspace_id: uuid, financial_scope: { const: 'workspace' }, activated_at: nullableTimestamp, intro_ends_at: nullableTimestamp, hours: { type: 'array', items: { type: 'object' } } }),
});
hostingPaths['/api/v4/hosting-billing/workspaces/{workspaceId}/storage'] = { get: {
  tags: ['Billing'], summary: 'Peak storage balances, protection and runway', security: [{ nip98: [] }],
  description: 'Peak-metered workspaces only (approved onboarding policy). The shared account owner (or platform administrator) receives the account-level purchased balance, protected storage, agent-available funds and runway with coverage gaps listed. Workspace membership or workspace.manage receives workspace scope only. Hours are peak-per-UTC-hour with exact integer units: ordinary hours bill max(1GB, peak); introductory hours waive only the first 1GB. Funded growth is never blocked by the reserve; it lowers runway and agent admission.',
  parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: uuid }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }],
  responses: { '200': response({ oneOf: [ref('HostingStorageSummary'), ref('HostingWorkspaceStorageScope')] }), ...errors },
} };

// ---- Read-only migration export (docs/contract/workspace-migration-export-v1.md) -------------------------------------------
const exportParams = [{ name: 'workspaceId', in: 'path', required: true, schema: uuid }, { name: 'exportId', in: 'path', required: true, schema: uuid }];
const exportErrors = { ...errors, '410': { description: 'Export session expired' }, '413': { description: 'A single item exceeds the export item limit; the export fails closed' }, '429': { description: 'Too many open export sessions' } };
const exportSections = { type: 'object', additionalProperties: object({ items: { type: 'integer' }, done: { type: 'boolean' } }) };
const exportProgress = object({ export_id: uuid, workspace_id: uuid, section: { enum: ['records', 'history', 'assets', 'complete'] }, as_of: object({ position: { type: 'string' }, epoch: uuid, access_revision: { type: 'string' } }),
  started_at: dateTime, expires_at: dateTime, finalized: { type: 'boolean' }, sections: exportSections });
const exportManifest = { type: 'object', description: 'Completeness manifest. `status` is complete only when nothing is missing, inconsistent or unexported; incomplete_reasons lists access_changed, writes_during_export, dangling_relationships, asset_issues and uncovered_content.', required: ['version', 'export_id', 'workspace_id', 'scope', 'status', 'incomplete_reasons', 'sections', 'integrity', 'coverage'], properties: {
  version: { const: 1 }, export_id: uuid, workspace_id: uuid, scope: { const: 'actor_visible' }, as_of: { type: 'object' }, finalized_at: dateTime,
  sections: { type: 'object', additionalProperties: object({ items: { type: 'integer' }, bytes: { type: 'integer' }, chain: { type: 'string', pattern: '^[0-9a-f]{64}$' } }) },
  record_families: { type: 'object', additionalProperties: { type: 'integer' } },
  integrity: { type: 'object', properties: { consistent: { type: 'boolean' }, dangling_relationships: { type: 'array', items: { type: 'object' } }, asset_issues: { type: 'object', additionalProperties: { type: 'integer' } }, exported_scope_complete: { type: 'boolean' } } },
  coverage: { type: 'object', properties: { record_families: { type: 'array', items: { type: 'string' } }, content_tables: { type: 'array', items: { type: 'string' } }, history_tables: { type: 'array', items: { type: 'string' } }, uncovered: { type: 'array', items: { type: 'object' } }, uncovered_required: { type: 'array', items: { type: 'object' } } } },
  status: { enum: ['complete', 'incomplete'] }, incomplete_reasons: { type: 'array', items: { enum: ['access_changed', 'writes_during_export', 'dangling_relationships', 'asset_issues', 'uncovered_content'] } } } };
hostingPaths['/api/v4/hosting-billing/workspaces/{workspaceId}/migration-export'] = { post: {
  tags: ['Billing'], summary: 'Open a bounded read-only migration export session', security: [{ nip98: [] }],
  description: 'Any workspace member, with a direct user signature. Pins the committed record clock. The export contains only what the member can currently read under the existing channel/Docs/Files ACL and is NOT a backup or an owner-wide dump. Available while the workspace is read-only for insufficient funds. At most 3 open sessions per member and workspace; sessions expire after 7 days.',
  parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: uuid }],
  responses: { '201': response({ type: 'object', properties: { export_id: uuid, scope: { const: 'actor_visible' }, coverage: { type: 'object' }, bounds: { type: 'object' } } }), ...(exportErrors as any) },
} };
hostingPaths['/api/v4/hosting-billing/workspaces/{workspaceId}/migration-export/{exportId}'] = { get: {
  tags: ['Billing'], summary: 'Export session progress and, once finalized, its outcome', security: [{ nip98: [] }], parameters: exportParams,
  responses: { '200': response({ allOf: [exportProgress, { type: 'object', properties: { outcome: { oneOf: [{ type: 'null' }, exportManifest] } } }] }), ...(exportErrors as any) },
} };
hostingPaths['/api/v4/hosting-billing/workspaces/{workspaceId}/migration-export/{exportId}/page'] = { get: {
  tags: ['Billing'], summary: 'One page of an export section (records, then content, then history, then assets)', security: [{ nip98: [] }],
  description: 'Sections are traversed in order with server-held progress. Send the previous page\'s next_cursor to advance; resending the cursor of the page just delivered replays it; anything else is 409 cursor_invalid. Pages carry at most 200 items and 1 MiB (a single record up to 8 MiB). page.digest is sha256 of the page\'s item identities joined by newline (record:family:id:position, table_row:table:key, doc_version:doc:row_version, file_version:file:version, doc_recovery_version:id:0, daily_note_version:note:row_version, asset:object:status:sha256) and progress.chain chains page digests from sha256("nstack-export-v1"). Assets report verified, missing_metadata, workspace_mismatch, upload_incomplete, not_readable, missing_bytes, size_mismatch, hash_mismatch or unverified; bytes are fetched from the item\'s content_path under the existing storage ACL.',
  parameters: [...exportParams, { name: 'section', in: 'query', required: true, schema: { enum: ['records', 'content', 'history', 'assets'] } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }],
  responses: { '200': response({ type: 'object', properties: { export_id: uuid, section: { type: 'string' }, items: { type: 'array', items: { type: 'object' } }, next_cursor: { type: ['string', 'null'] }, section_complete: { type: 'boolean' }, page: object({ count: { type: 'integer' }, digest: { type: 'string' } }), progress: object({ items: { type: 'integer' }, chain: { type: 'string' } }) } }), ...(exportErrors as any) },
} };
hostingPaths['/api/v4/hosting-billing/workspaces/{workspaceId}/migration-export/{exportId}/finalize'] = { post: {
  tags: ['Billing'], summary: 'Close the session and return the completeness manifest', security: [{ nip98: [] }], parameters: exportParams,
  description: '200 only when the manifest status is complete. Otherwise 409 export_incomplete carries the same manifest: missing or altered assets, writes during the export, relationships whose parent was not readable, and customer content families the export does not yet deliver all fail the export rather than producing a partial backup. Idempotent.',
  responses: { '200': response({ type: 'object', properties: { manifest: exportManifest } }), ...(exportErrors as any) },
} };
