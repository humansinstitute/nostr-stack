# NStack backup and restore

NStack needs one backup set containing the main PostgreSQL database, graph
PostgreSQL database, and active object storage data (SeaweedFS or legacy MinIO).
A repository copy is not a data backup.

`scripts/tower-backup.sh` streams every component directly through `age` using
manifest **version 2** (`storage_provider: "minio" | "seaweedfs"`), while
retaining full `verify` and `restore` compatibility for legacy **version 1**
MinIO backups. Plaintext dumps are never written to disk. The encrypted manifest
records the format version, storage provider, UTC creation time, consistency
mode, component formats, sizes, and SHA-256 checksums of the encrypted payloads.
`verify` and `restore` require all three exact components (`main-postgres`,
`graph-postgres`, and the selected storage provider) and reject missing,
duplicate, or empty component lists.

## Prerequisites

- Docker, `age`, `jq`, `shasum`, and `tar`.
- An age recipient whose identity is held somewhere other than the NStack host.
- Enough encrypted backup storage for both databases and all object storage data.

Generate and securely escrow an identity once (do not put it in this repo):

```sh
age-keygen -o /secure/off-host/tower-backup.agekey
age-keygen -y /secure/off-host/tower-backup.agekey
```

## Create a coherent backup

The three stores have no shared transaction manager. A coherent set therefore
requires a write-quiescence window. Stop the NStack API container and quiesce
external writes (including presigned uploads). Leave both PostgreSQL containers
running.

- **SeaweedFS (`--storage-provider seaweedfs` or `TOWER_BACKUP_STORAGE_PROVIDER=seaweedfs`):**
  SeaweedFS keeps live LevelDB filer metadata under `/data/filerldb2`. Gracefully
  **stop the SeaweedFS container first** so LevelDB flushes and closes cleanly.
  The backup script verifies SeaweedFS and all other containers mounting its `/data`
  named volume are stopped, then archives that verified named volume read-only
  through an isolated `alpine:3.20` (`--network none`) helper. Restart SeaweedFS
  and NStack afterwards.
- **Legacy MinIO (`--storage-provider minio`, default):**
  Leave the quiesced MinIO container running (or internal-only during migration
  cutover).

The script checks that the local NStack API container is not running (and for
SeaweedFS, that the SeaweedFS container is stopped). The `--quiesced` flag is an
operator attestation for external conditions that a local script cannot prove.

```sh
RECIPIENT='age1...'
# SeaweedFS backup (after stopping tower and seaweedfs):
scripts/tower-backup.sh backup \
  --output "/secure/backups/tower-$(date -u +%Y%m%dT%H%M%SZ)" \
  --recipient "$RECIPIENT" \
  --storage-provider seaweedfs \
  --quiesced

# Legacy MinIO backup (tower stopped, minio quiesced):
scripts/tower-backup.sh backup \
  --output "/secure/backups/tower-$(date -u +%Y%m%dT%H%M%SZ)" \
  --recipient "$RECIPIENT" \
  --storage-provider minio \
  --quiesced
```

Restarting NStack (and SeaweedFS) is a separate operator action. The backup
command never starts, restarts, or modifies a running service or volume.

## Verify without restoring

Verification checks the encrypted manifest, every ciphertext checksum, both
PostgreSQL archive catalogs, and the MinIO tar catalog. It does not create a
database or write to a volume.

```sh
scripts/tower-backup.sh verify \
  --backup /secure/backups/tower-YYYYMMDDTHHMMSSZ \
  --identity /secure/off-host/tower-backup.agekey
```

Run verification immediately after creation and again after copying off-host.

## Restore rehearsal into disposable targets

Restore refuses arbitrary or existing names. The target must start with
`tower-restore-`, and the exact name must be repeated in `--confirm`. It creates
new Docker volumes and two unexposed database containers; it never attaches to
the Compose volumes or live containers.

```sh
scripts/tower-backup.sh restore \
  --backup /secure/backups/tower-YYYYMMDDTHHMMSSZ \
  --identity /secure/off-host/tower-backup.agekey \
  --target tower-restore-quarterly-test \
  --confirm tower-restore-quarterly-test
```

The restored databases have no published ports. Object storage data is restored
into `tower-restore-quarterly-test-<provider>-data` (`minio` or `seaweedfs`).
Any restored `storage_migration_runs` rows are marked `aborted_restore` inside
the restored database clone ONLY (the live database is never touched), so a
window backup captured at `source_fenced` boots cleanly through the migration
startup guard without permitting `--resume` on a clone. The restore databases
are created from `template0` in the new containers, so image init scripts (the
graph image creates the Apache AGE extension) cannot collide with the dump, and
restored AGE graphs are re-keyed to their new schema OIDs so Cypher reads and
writes work in the clone. SeaweedFS sets also contain the exact NStack SeaweedFS image
(`seaweedfs-image.tar.age`, image ID in the manifest); restore loads it when that image ID is
absent and fails if the loaded image differs. Start an isolated,
unexposed storage container against the restored volume only if application-level
object tests are required. Cleanup is deliberately manual so a failed rehearsal
remains inspectable.

## Operations policy

- Suggested RPO: daily for ordinary use; hourly if losing a working day is not
  acceptable. The quiescence window determines which schedule is practical.
- Keep 7 daily, 5 weekly, and 12 monthly sets as a starting retention policy.
- Keep at least one encrypted copy off-host and one offline or immutable copy.
- Store the age identity separately from all backup copies and test recovery by
  two authorized operators.
- Verify every set automatically and perform a disposable restore rehearsal at
  least quarterly and before a storage/schema migration.
- Alert on missed schedules, failed verification, unexpected size collapse,
  and insufficient destination capacity.
- Never publish, commit, or place decrypted dumps in support bundles.

For a near-zero-downtime deployment, use infrastructure snapshots that provide
a coordinated storage freeze across both PostgreSQL volumes and MinIO. Do not
label three independent online copies coherent merely because they share a
timestamp.
