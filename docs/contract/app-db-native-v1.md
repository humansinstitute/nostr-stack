# Registered native relational app tables v1

Source candidate; activation requires rebuilding NStack and installing runtime SQL.
This generic interface serves normalized application tables (for example goals and
checkpoints, or inventory orders and order lines). NStack owns scope, access,
concurrency and recovery; applications own SQL, known columns and domain validation.

All requests use NIP-98 under the caller's own identity. Base:
`/api/v4/workspaces/{ownerNpub}/apps/{appNpub}/db/native-v1/{workspaceId}`.
POST operations:

- `/deployment`: `{app_slug?, migrations?:[{version,checksum,sql}]}`. Requires
  verified workspace.manage and exact owner/app/workspace binding. Uses existing
  checksum-versioned transactional DDL. No keys exported. Existing registration
  must be enabled. Foreign-key REFERENCES must be qualified with the allocated schema; checksum the
  exact rendered SQL. Schema evolution after policy installation is intentionally
  rejected pending a separately reviewed freeze/evolution contract.
- `/policy`: `{table,policy:{version:1,columns:[...],parent?:{table,column},append_only?:true,manager_only_writes?:true,managed_content_type?:string}}`.
  Requires workspace.manage. Identical retry succeeds; changing policy conflicts.
  `columns` lists writable app columns, excluding id/workspace_id/channel_id/revision.
- `/batch`: `{version:1,operation_id:UUID,channel_id:UUID,staging?:true,operations:[...]}`.
  Maximum 3000 operations / 4 MB JSON. Each operation:
  `{kind:'insert'|'update'|'delete',table,id,data?,expected_revision?}`.
  `manager_only_writes` tables additionally require workspace.manage for every
  mutation (for example import provenance and authority evidence).
  Insert starts revision 1; update/delete require positive expected_revision.
  All changes and receipt commit atomically. Child mutations require a matching
  parent insert/update CAS in the same batch. Append-only tables reject updates/deletes.
  Response `{version:1,operation_id,generation:string,results:[{table,kind,row}]}`.
  Identical operation ID/body/actor retries return the committed result; changed
  bodies or actors conflict. Access is rechecked before receipt replay.
- `/query`: `{version:1,table,channel_id,limit:1..200,after?:string,generation?:string}`.
  Response `{version:1,generation:string,rows,has_more,next_after}`.
  First read obtains a workspace-wide namespace generation. Supply it for **every**
  subsequent table/page and a final verification query; any mutation returns
  `409 snapshot_changed`. Discard partial snapshot and restart. Keyset order uses
  text ID with C collation; after requires generation. No offset/join/raw SQL.
- `/read`: `{version:1,table,id,staging?:true}` resolves a stable row ID using
  its stored channel, with the same policy/authority checks. Returns
  `{version:1,generation,channel_id,row}`; missing=404, unauthorized=403.
  This supports stable references without requiring an old source File row.
- `/fence`: `{channel_id,content_type,active:boolean,expected_revision:number}`.
  Requires workspace.manage plus channel write. Initial expected_revision=0.
  Response `{version:1,fence:{...,revision}}`. Database triggers reject File
  creation, mutation, archive/deletion and version writes for the exact channel
  and MIME, including legacy/app-signed routes. Other Files remain usable.
- `/authority`: `{channel_id,content_type,mode:'staging'|'active'|'frozen',expected_revision:number,expected_generation?:string,expected_fence_revision?:string}`
  requires workspace.manage and channel write; active requires an acknowledged
  active source fence plus exact expected_generation and expected_fence_revision.
  They are checked while namespace and source File writes are locked. Initial revision=0. GET-like POST `/status` with
  `{channel_id,content_type}` returns current authority (or null), current fence (or null), namespace generation
  and limits.
  Managed policies permit regular batches/queries only when active. Manager-only
  staging batches/queries use `staging:true` while mode=staging. Manager recovery
  queries also use `staging:true` while frozen; frozen rejects every write.

Table shape: `id text PRIMARY KEY`, `workspace_id uuid NOT NULL`,
`channel_id uuid NOT NULL`, `revision bigint NOT NULL`, app columns. IDs may be
UUID strings or deterministic child strings. A parent needs
`UNIQUE(id,workspace_id,channel_id)`; children need a non-deferrable composite FK
`FOREIGN KEY(parent_id,workspace_id,channel_id) REFERENCES parent(id,workspace_id,channel_id)`.
Add `(workspace_id,channel_id,id COLLATE "C")` indexes in app SQL. Parent keys are
immutable. NStack injects scope; client scope/revision fields in data are rejected.
Policies register parent before children. Every table change advances all table
generations in that workspace/namespace. The existing app-signed CRUD API is
closed for registered tables, with a database trigger guarding bypass/races.

Access uses verified `file.read` and `file.write` grants, including explicit agent
grants, rather than membership alone. Revocation fails closed, including receipts.
Owner/app/workspace mismatches fail before table access. Idempotency does not
substitute for permissions. Unknown app extensions may be JSON columns; known
facts remain normalized columns/children. No generic JSON canonical aggregate.

Migration: deploy schema, register policies, establish staging authority, stage
exact-version provenance and normalized rows as manager, fence source creates and
mutations, re-inventory exact source heads/grants, reconcile, activate authority,
then enable client writes. Source content/history stays retained. Freeze SQL before
recovery; export complete normalized state before a reviewed reverse transition.
The backend does not claim app source equivalence or perform that migration itself.

Requests have a 4 MB transport limit (413). Namespace operations serialize under
an advisory lock; ACL tables are held in SHARE mode through authorization/commit
to prevent revocation races. This is deliberately conservative; large batches are
bounded to 30 seconds and can briefly delay grant/membership changes.

Run isolated validation with fixture configuration only. Start a task-owned
PostgreSQL 16 instance; set `NATIVE_FIXTURE_DATABASE_URL` to its localhost URL
containing `native_fixture`, and set the usual NStack config to fixture values.
Run `bun test ./tests/app-db-native.test.ts ./tests/app-db.test.ts` (the leading
`./` selects exact files). The native suite creates and removes its own database;
it skips when no explicit fixture URL is supplied and rejects unsafe supplied URLs.
The existing app-db suite uses DB_HOST/DB_PORT/DB_USER/DB_PASSWORD and its separate
disposable database, which must also target that fixture service. Remove the
fixture container/anonymous volume after testing. Never use production credentials.

Rows are converted to JSON by PostgreSQL: SQL date remains YYYY-MM-DD; timestamps
remain ISO strings, and revision is explicitly a decimal string. Query responses
are capped at 4 MB and may be shorter than limit; follow has_more/next_after. Batch
results/receipts cap at 8 MB; an oversized result rolls back the entire transaction.

The native protocol preserves unknown JSON numeric values using Bun raw JSON
lexemes and PostgreSQL JSONB text reads, including receipt replay; existing APIs
keep their parsers. JSONB can normalize lexical spelling (for example exponent
notation) while preserving numeric value. Clients must also use lossless JSON
handling when decoding/re-encoding unknown extension values.

An optional `NATIVE_CONSUMER_MODULE` points to an app-owned deployment module
exporting migration(schema), policies(), and importBatch(); the opt-in consumer
fixture applies its exact DDL/policies and import using signed native HTTP calls.

Post-edit recovery retains frozen SQL, complete verified normalized revision exports
and original File history/provenance for reviewed SQL-native restore or forward
repair. A reverse File-authority transition is not provided by this protocol; do
not release source fences onto stale legacy heads.
