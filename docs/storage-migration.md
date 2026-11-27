# NStack Object Storage Migration (MinIO → SeaweedFS)

NStack defaults new installations to **SeaweedFS 4.55** (pinned multi-arch OCI digest) while preserving existing **MinIO** and **external-S3** deployments across code updates until an operator runs the explicit migration workflow.

## Provider Selection & Update Compatibility

### Fresh setup installations (`docker-compose.setup.yml`, `bun run nstack:setup`)

- Fresh installations default to `seaweedfs` without building MinIO from source (`Dockerfile.setup-storage` is only invoked for existing legacy MinIO installations).
- Durable provider selection is written once to `storage-provider.json` (`{"version":1,"provider":"seaweedfs"|"minio"|"external-s3"}`) in the `bootstrap` volume alongside `bootstrap.json`.
- Separate least-privilege credentials are generated:
  - Tower app RW+List credentials (bucket-scoped) live in `storage-seaweedfs-app.json` inside `bootstrap` so rotated post-migration credentials persist across future setup updates without modifying `bootstrap.json`.
  - Init/admin credentials live **exclusively** in the `storage-credentials` volume (`storage-admin.json`), which is mounted only by `bootstrap`, `seaweedfs`, and `seaweedfs-init` — never by the API container.
- Existing MinIO setup installations (which have `bootstrap.json` and the legacy `storage` volume without `storage-provider.json`) resolve cleanly to `minio` on update. Ambiguous volume layouts or conflicting overrides fail closed without regenerating `bootstrap.json`, service identity, or claim codes.

### Production installations (`docker-compose.prod.yml`, `./rebuild_deploy_docker.sh`)

- `STORAGE_PROVIDER` maps to Docker Compose profiles (`seaweedfs`, `minio`, or empty for `external-s3`).
- **Backwards-compatible inference when `STORAGE_PROVIDER` is unset:**
  - If `STORAGE_S3_ENDPOINT` is unset or names the bundled `minio` service, NStack infers `minio`.
  - Otherwise, NStack infers `external-s3` passthrough (no bundled storage container started; configured endpoint used unchanged).
- Startup fails closed only when an **explicit** `STORAGE_PROVIDER` conflicts with `STORAGE_S3_ENDPOINT` or `COMPOSE_PROFILES`.
- `tower` no longer hard-depends on `minio-init`. Instead, `src/index.ts` enforces:
  1. The **storage migration startup guard** (blocking unintended starts during quiesced or intermediate switch phases `source_fenced` through `config_switched`, permitting `start_intent` only via `cutover --resume` with `NSTACK_MIGRATION_START_RUN_ID`, and ignoring `aborted_restore` so restored backup clones boot cleanly).
  2. **Authenticated storage readiness** (`HeadBucket` + `.nstack-storage-sentinel.json` provider/bucket/ID validation).

### Justified implementation adjustments vs. initial planning draft

1. **Provider-neutral Bun/AWS S3 initializer replaces `minio/mc:latest`:** Upstream Docker Hub removed both `minio/minio:latest` and `minio/mc:latest` (returning HTTP 401). Legacy `minio` in `docker-compose.prod.yml` is pinned to the verified cached digest (`MINIO_IMAGE` override, `pull_policy: never`, failing clearly if absent rather than pulling `:latest`), and both `minio-init` and `seaweedfs-init` run `src/scripts/storage-init.ts` on the built Tower image. For MinIO it performs the explicit `mc anonymous set none` equivalent (`DeleteBucketPolicy` when a policy exists) and verifies anonymous `GET /<bucket>` returns `401`/`403`.
2. **Consistent SeaweedFS backups stop SeaweedFS before archiving `/data`:** Because SeaweedFS stores live LevelDB filer metadata under `/data/filerldb2`, `scripts/tower-backup.sh backup --storage-provider seaweedfs --quiesced` requires the SeaweedFS container to be gracefully stopped first (rejecting `running`, `restarting`, and `paused` states) and archives its verified `/data` named volume read-only through the guaranteed `postgres:16-alpine` image (`--network none`), preserving UID/GID `1000:1000`.
3. **Unacknowledged incomplete v4 upload declared-size boundary:** Local preflight observed incomplete v4 rows (`completed_at IS NULL`) whose unacknowledged S3 object byte length differs from the client-declared `v4_storage_objects.size_bytes` sent at `prepare` time. Because these rows were never acknowledged/completed, migration preserves their exact source bytes + metadata and leaves the DB row completely unchanged (`size_bytes`, `sha256_hex`, `completed_at` untouched). The journal records the DB declared size separately (`original_size_bytes`) from the measured source snapshot size (`size_bytes`), verifies target bytes against the immutable source snapshot, and enforces strict DB hash/size identity (exit `13` on mismatch) exclusively on acknowledged completed rows (`completed_at IS NOT NULL` / managed `state = 'complete'`).
4. **SeaweedFS admin & gRPC JWT isolation in production:** Production Compose supports a separate mode-`0600` `.env.seaweedfs-admin` file (`SEAWEEDFS_ADMIN_ENV_FILE`) loaded only by `seaweedfs` and `seaweedfs-init`, and explicitly scrubs all `SEAWEEDFS_ADMIN_*`, `SEAWEEDFS_JWT_*`, and `SEAWEEDFS_ACCESS_KEY`/`SEAWEEDFS_SECRET_KEY` values from `tower` runtime environment. The migration orchestrator writes the admin file to the path the selected env file resolves: the default `.env.prod` may use the default `.env.seaweedfs-admin`; any other `--env-file` (a rehearsal lab or second installation) must set `SEAWEEDFS_ADMIN_ENV_FILE` to its own absolute path and is refused otherwise. An existing admin file is never overwritten; one holding a different identity blocks preflight.

## Architecture & Security Isolation (SeaweedFS 4.55)

- Image: the NStack build of SeaweedFS 4.55 (`deploy/seaweedfs`): the pinned upstream image `chrislusf/seaweedfs@sha256:7ca46aeae2f223b37e5d91593c17ab37738eec6df6ab69b48a0487f7643342b9` with `/usr/bin/weed` rebuilt from the pinned source plus a compatibility patch that serves stored generic-binary objects as `application/octet-stream` instead of guessing a type from the key extension. Installations reference it by image ID (`SEAWEEDFS_IMAGE=sha256:…`); the stock image is never pulled. See `deploy/seaweedfs/README.md`.
- Dedicated volume (`tower-seaweedfs-data` in prod, `storage-seaweedfs` in setup). **Never mount a MinIO data volume in SeaweedFS.**
- Rendered by `deploy/nstack/render-seaweedfs-config.sh`:
  - Runs non-root (`1000:1000`), `read_only: true`, `cap_drop: ["ALL"]`, `no-new-privileges:true`, `/tmp` tmpfs.
  - Binds master (`9333`/`19333`), volume (`8080`/`18080`), and filer (`8888`/`18888`) strictly to `127.0.0.1` with `-filer.disableHttp=true`, `-master.telemetry=false`, `-volume.minFreeSpace=10`.
  - Disables Iceberg (`-s3.port.iceberg=0`), Lance (`-s3.port.lance=0`), embedded IAM (`-s3.iam=false`), and auto bucket creation (`-s3.autoCreateBucket=false`).
  - Sets `security.toml` JWT signing keys (`signing`, `signing.read`, `filer_signing`, `filer_signing.read`, `filer_signing.subscribe`) and `[guard] white_list = "127.0.0.1,@"`, authenticating S3 gRPC (`18333`) and closing unauthenticated `PutIdentity`/`RemoveIdentity`/`LifecycleDelete` calls (`grpc-status: 16`).
  - Isolates `seaweedfs` from non-NStack sidecars (`nostr-relay`, `blossom`, Postgres) via dedicated `storage-internal` (`internal: true`) + `storage-host` networks.
  - Supports `-s3.externalUrl` and `-s3.allowedOrigins=*` for public presigned upload/download CORS parity behind reverse proxies/tunnels.

## Split Authority: Host Orchestration vs. Data CLI

- **Data CLI (`bun run nstack:migrate-storage <cmd>` / `src/scripts/migrate-storage.ts`):** Runs inside a labelled one-off Tower container (`nstack.migration=1`, `nstack.migration.fingerprint=<fp>`, `nstack.migration.run=<run_id>`) with DB and internal storage network access **only** — no Docker socket, no host mounts, no CapRover credentials. Holds a session-level `pg_advisory_lock`.
- **Host wrapper (`scripts/nstack-migrate-storage-host.sh`):** Owns Docker/Compose operations, internal-only MinIO fencing, `tower-backup.sh`, atomic `.env.prod` updates, scoped container cleanup, SeaweedFS restart, Tower start/health (HTTP + FIPS), stopping MinIO immediately after commit, and explicit post-retention `retire-source`.

### Deterministic Exit Codes

| Exit | Meaning |
|---|---|
| `0` | Success |
| `2` | Usage error or missing `--confirm <project>` |
| `3` | Another run active, session advisory lock held, or foreign run container alive for this fingerprint |
| `4` | Current journal phase does not permit command |
| `10` | Preflight safety block (unsupported source feature/tags, low disk `< 2.5x`, missing sentinel, fingerprint mismatch) |
| `11` | Fence, boundary, backup, or window-timeout failure before authoritative switch (safe to run RB1 `rollback`) |
| `12` | Transient S3/network I/O error (safe to retry / `--resume`) |
| `13` | Integrity or verification mismatch before `switch_prepared` (exact offending IDs printed; RB1 applies) |
| `14` | Smoke failure at or after `start_intent` (RB2 rules apply) |
| `15` | Bare rollback refused at or after `start_intent` |

## Local Production Migration Runbook

All host commands default to project `wingman-tower`, `.env.prod`, the FIPS overlay and state under `.runtime/migration/<project>/`; `--target-env-file` defaults to `<state-dir>/target.env`.

1. **Deploy the update on MinIO (no provider change):**
   ```sh
   ./rebuild_deploy_docker.sh
   ```
   The changed MinIO image reference (pinned digest) recreates the MinIO container once; data stays on its volume.
2. **Create target credentials and start SeaweedFS internal-only:**
   ```sh
   scripts/nstack-migrate-storage-host.sh target-init
   ```
   Creates `target.env` (mode `0600`) with distinct generated app and admin identities if it does not exist, records the NStack SeaweedFS image ID (the env file's `SEAWEEDFS_IMAGE`, else the local build, else it builds `deploy/seaweedfs`) and saves a validated copy of that image under the state directory, starts `seaweedfs` from that image with no host ports on `storage-internal`, and runs `seaweedfs-init` (bucket, private policy check, sentinel, read/write probe). Every later start, publish and the cutover gate re-check the recorded image and saved copy; the config switch writes `SEAWEEDFS_IMAGE=<ID>` into the env file.
3. **Preflight (read-only) and online warm pre-copy (NStack keeps serving):**
   ```sh
   scripts/nstack-migrate-storage-host.sh preflight
   scripts/nstack-migrate-storage-host.sh precopy --concurrency 4
   ```
4. **Planned maintenance cutover (the NStack API is down from `stop_tower` to `start_tower`):**
   ```sh
   scripts/nstack-migrate-storage-host.sh cutover \
     --backup-recipient "$AGE_RECIPIENT" \
     --backup-identity "$AGE_IDENTITY_FILE" \
     --rehearsal-minutes "$MEASURED_REHEARSAL_MINUTES" \
     --check-public-put
   ```
   - The encrypted window backup (database, graph, MinIO `/data`, plus `config.tar.age` with the env, FIPS and target credential files) is written under the run directory and dominates the window; size the window from a rehearsal on a comparable corpus.
   - Resuming an interrupted cutover: re-run with `--resume` (automatic §7.6 snapshot validity check against the fenced MinIO and stopped NStack; re-fences steps 2–9 if invalidated).
   - A crashed or killed orchestrator leaves its lock under `~/.local/state/nstack-migration/locks/` (one file per Docker daemon and project). Every command then exits `3` naming the holder. Confirm that PID is not running and no `nstack.migration=1` container is alive, remove that exact file, then resume. Locks are never reclaimed automatically.
   - Before `start_intent`: `scripts/nstack-migrate-storage-host.sh rollback` restores MinIO losslessly (RB1).
   - At or after `start_intent`: bare `rollback` exits `15`. Fail forward on SeaweedFS (`cutover --resume`), or use `rollback --reverse-migrate` (RB2) while SeaweedFS is readable, or inspect `status` for RB2 at-risk object IDs.
5. **Post-cutover observation, first SeaweedFS backup, and explicit retirement:**
   - Observe 24–48 h with MinIO stopped (its container and volume are retained).
   - Within 24 h of commit, take the first SeaweedFS v2 backup (Tower and SeaweedFS stopped so LevelDB metadata is consistent; the set also carries the exact SeaweedFS image), verify it, then start SeaweedFS and Tower:
     ```sh
     DC="docker compose --env-file .env.prod -f docker-compose.prod.yml --env-file .env.fips -f docker-compose.fips.yml"
     COMPOSE_PROFILES=seaweedfs $DC stop tower seaweedfs
     TOWER_BACKUP_STORAGE_PROVIDER=seaweedfs scripts/tower-backup.sh backup \
       --output "/secure/backups/tower-seaweedfs-$(date -u +%Y%m%dT%H%M%SZ)" \
       --recipient "$AGE_RECIPIENT" --quiesced --storage-provider seaweedfs
     COMPOSE_PROFILES=seaweedfs $DC up -d seaweedfs tower
     scripts/tower-backup.sh verify --backup "<backup-dir>" --identity "$AGE_IDENTITY_FILE"
     ```
   - After 14 days (and explicit operator approval):
     ```sh
     scripts/nstack-migrate-storage-host.sh retire-source --confirm wingman-tower --retention-days 14
     ```

## Remote CapRover B Preflight & Migration Runbook (Prepared — Do Not Activate Until Local Soak Passes)

Remote deployments (such as `tower-stable-api` on CapRover B) share the exact same data CLI (`nstack:migrate-storage`) while host steps execute through authorized CapRover/operator actions (no container receives CapRover authority):

1. **Mandatory E0a Remote Separation Proof (Read-Only, Broker-Verified):**
   - Because remote and local instances may share `service_npub`, **never assume separation**. Record and verify remote Postgres `system_identifier` + database name, active S3 endpoint/bucket identity, corpus counts/sizes, bucket features (no versioning/lock/encryption/lifecycle/replication/tags), persistent disk headroom (`>= 2.5x` source), CPU architecture (`amd64` vs `arm64` — real `amd64` qualification is a release gate before remote `amd64` activation), routes to remote MinIO, backup mechanism, and how to run a one-off container on the internal network.
2. **Provision Remote SeaweedFS App (E0b):**
   - Deploy SeaweedFS as a separate CapRover app with persistent volume mounted at `/data`, pinned multi-arch `4.55` digest, `render-seaweedfs-config.sh` hardened flags + JWT secrets, separate app/admin identities, no public domain unless E0a confirms browser direct presigned uploads (in which case bind dedicated hostname + `-s3.externalUrl` + CORS parity). Run `storage-init.ts` + E1 negative probes against this instance.
3. **Deploy R1 Code on Existing Storage:**
   - Update `tower-stable-api` keeping its existing `STORAGE_S3_*` settings unchanged (`STORAGE_PROVIDER` unset -> `external-s3` passthrough / unchanged). Supply `STORAGE_S3_TARGET_*` via secured one-off execution env.
4. **Online Preflight & Precopy:**
   - Run `bun run nstack:migrate-storage preflight` and `precopy` in a one-off labelled container attached to the remote DB + internal S3 network.
5. **Planned Remote Maintenance Window:**
   - Scale `tower-stable-api` to `0`.
   - Fence remote MinIO: remove/disable any public domain on the remote MinIO app and restart it internal-only (`mark --phase source_fenced --source-boot-id ...`).
   - Capture and verify encrypted remote DB + MinIO backup (`mark --phase backed_up`).
   - Run `delta` (Steps 5–7), stop scoped run containers, restart remote SeaweedFS (Step 8), run `verify` (Step 9), `prepare-switch` (Step 10), `rewrite-etags` (Step 11).
   - Update CapRover app env (`STORAGE_PROVIDER=seaweedfs`, `STORAGE_REQUIRE_SENTINEL=true`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_ENDPOINT_PUBLIC`, new SeaweedFS app keys) and record `mark --phase config_switched`.
   - Record `mark --phase start_intent` **before** scaling `tower-stable-api` back to `1` (with `NSTACK_MIGRATION_START_RUN_ID=<run_id>`).
   - Verify `/health`, run `mark --phase started`, run `smoke-data`, run `commit`, then stop the remote MinIO app (retaining its stopped volume for 14–30 days per owner choice before explicit `retire-source`).
