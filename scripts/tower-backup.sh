#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_VERSION="2"
readonly MAIN_CONTAINER="${TOWER_BACKUP_MAIN_CONTAINER:-wingman-tower-postgres}"
readonly GRAPH_CONTAINER="${TOWER_BACKUP_GRAPH_CONTAINER:-wingman-tower-graph-postgres}"
readonly MINIO_CONTAINER="${TOWER_BACKUP_MINIO_CONTAINER:-wingman-tower-minio}"
readonly SEAWEEDFS_CONTAINER="${TOWER_BACKUP_SEAWEEDFS_CONTAINER:-wingman-tower-seaweedfs}"
readonly SEAWEEDFS_VOLUME_OVERRIDE="${TOWER_BACKUP_SEAWEEDFS_VOLUME:-}"
readonly APP_CONTAINER="${TOWER_BACKUP_APP_CONTAINER:-wingman-tower-b3}"
STORAGE_PROVIDER="${TOWER_BACKUP_STORAGE_PROVIDER:-minio}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
state() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || printf 'missing'; }
is_stopped_state() {
  case "$(state "$1")" in
    exited|created|dead|missing) return 0 ;;
    *) return 1 ;;
  esac
}
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
size() { wc -c < "$1" | tr -d ' '; }

usage() {
  cat <<'EOF'
Encrypted NStack backup sets (manifest v2; supports v1 and v2 verify/restore)

  scripts/tower-backup.sh backup --output DIR --recipient AGE_RECIPIENT --quiesced \
    [--storage-provider minio|seaweedfs]
  scripts/tower-backup.sh verify --backup DIR --identity AGE_IDENTITY_FILE
  scripts/tower-backup.sh restore --backup DIR --identity AGE_IDENTITY_FILE \
    --target tower-restore-NAME --confirm tower-restore-NAME

Environment overrides:
  TOWER_BACKUP_STORAGE_PROVIDER=minio|seaweedfs (default: minio)
  TOWER_BACKUP_APP_CONTAINER, TOWER_BACKUP_MAIN_CONTAINER,
  TOWER_BACKUP_GRAPH_CONTAINER, TOWER_BACKUP_MINIO_CONTAINER,
  TOWER_BACKUP_SEAWEEDFS_CONTAINER, TOWER_BACKUP_SEAWEEDFS_VOLUME

Consistency guarantees:
  - Both providers require the NStack API container stopped and --quiesced attestation.
  - MinIO backups stream /data from the quiesced MinIO container (legacy compatible).
  - SeaweedFS stores live LevelDB filer metadata, so backup requires the SeaweedFS
    container gracefully STOPPED first, then archives its verified /data named volume
    read-only via a disposable helper container so LevelDB state is crash-free and
    consistent. Restart SeaweedFS after backup finishes.

restore only creates new disposable Docker containers and volumes whose names
start with tower-restore-. It refuses existing targets and known live names,
and marks restored storage_migration_runs rows aborted_restore in the restored
database clone only so restored clones boot safely.
EOF
}

parse() {
  while (($#)); do
    case "$1" in
      --output) OUTPUT=${2:?}; shift 2 ;;
      --recipient) RECIPIENT=${2:?}; shift 2 ;;
      --quiesced) QUIESCED=1; shift ;;
      --storage-provider) STORAGE_PROVIDER=${2:?}; shift 2 ;;
      --backup) BACKUP=${2:?}; shift 2 ;;
      --identity) IDENTITY=${2:?}; shift 2 ;;
      --target) TARGET=${2:?}; shift 2 ;;
      --confirm) CONFIRM=${2:?}; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
}

decrypt_manifest() {
  age --decrypt --identity "$IDENTITY" "$BACKUP/manifest.json.age"
}

validate_provider() {
  case "$1" in
    minio|seaweedfs) ;;
    *) die "unsupported storage provider: $1 (expected minio or seaweedfs)" ;;
  esac
}

resolve_seaweedfs_data_volume() {
  local vol=""
  if [[ -n "$SEAWEEDFS_VOLUME_OVERRIDE" ]]; then
    vol="$SEAWEEDFS_VOLUME_OVERRIDE"
  else
    vol=$(docker inspect -f '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' "$SEAWEEDFS_CONTAINER" 2>/dev/null || true)
  fi
  [[ -n "$vol" ]] || die "could not resolve named /data volume for $SEAWEEDFS_CONTAINER (set TOWER_BACKUP_SEAWEEDFS_VOLUME if needed)"
  docker volume inspect "$vol" >/dev/null 2>&1 || die "SeaweedFS data volume does not exist: $vol"
  # Ensure NO running, restarting, or paused container currently holds this volume mounted
  # (prevents live LevelDB mutation or mid-backup restart during tar).
  local active_holders
  active_holders=$(docker ps -a \
    --filter "volume=$vol" \
    --filter "status=running" \
    --filter "status=restarting" \
    --filter "status=paused" \
    --format '{{.Names}}({{.State}})' 2>/dev/null || true)
  [[ -z "$active_holders" ]] || die "SeaweedFS volume $vol is held by active/restarting/paused container(s): $active_holders; stop SeaweedFS gracefully before backing up LevelDB metadata"
  printf '%s' "$vol"
}

validate_manifest_components() {
  local manifest="$1" version="$2" provider="$3"
  local expected_storage_file="${provider}-data.tar.age"
  # SeaweedFS sets also carry the exact NStack SeaweedFS image, so restore never rebuilds or substitutes it.
  local expected_count=3 extra_name=""
  if [[ $provider == seaweedfs ]]; then expected_count=4; extra_name="seaweedfs-image"; fi
  local comp_count
  comp_count=$(jq -er '.components | length' <<<"$manifest")
  [[ "$comp_count" == "$expected_count" ]] || die "manifest must contain exactly $expected_count components (main-postgres, graph-postgres, $provider${extra_name:+, $extra_name}); found $comp_count"

  local unique_names
  unique_names=$(jq -r '[.components[].name] | unique | sort | join(",")' <<<"$manifest")
  local expected_names
  expected_names=$(printf 'graph-postgres\nmain-postgres\n%s\n%s' "$provider" "$extra_name" | sed '/^$/d' | LC_ALL=C sort | paste -sd, -)
  [[ "$unique_names" == "$expected_names" ]] || die "manifest components mismatch: expected [$expected_names], found [$unique_names]"

  local expected_pair
  for expected_pair in \
    "main-postgres:main-postgres.dump.age:pg_dump-custom" \
    "graph-postgres:graph-postgres.dump.age:pg_dump-custom" \
    "${provider}:${expected_storage_file}:tar" \
    ${extra_name:+"seaweedfs-image:seaweedfs-image.tar.age:docker-image-archive"}; do
    local e_name e_file e_fmt found
    IFS=: read -r e_name e_file e_fmt <<<"$expected_pair"
    found=$(jq -r --arg n "$e_name" --arg f "$e_file" --arg t "$e_fmt" \
      '[.components[] | select(.name == $n and .file == $f and .format == $t)] | length' <<<"$manifest")
    [[ "$found" == "1" ]] || die "manifest missing required component $e_name ($e_file, $e_fmt)"
  done
  if [[ -n $extra_name ]]; then
    jq -er '.components[] | select(.name == "seaweedfs-image") | (.image_id | test("^sha256:[0-9a-f]{64}$")) and (.image_ref == .image_id)' <<<"$manifest" \
      | grep -qx true || die "manifest seaweedfs-image component lacks a valid image_ref/image_id"
  fi
}

backup() {
  parse "$@"
  need age; need docker; need jq; need shasum
  [[ -n ${OUTPUT:-} && -n ${RECIPIENT:-} ]] || die "--output and --recipient are required"
  [[ ${QUIESCED:-0} == 1 ]] || die "--quiesced is required; see docs/backup-and-restore.md"
  validate_provider "$STORAGE_PROVIDER"

  is_stopped_state "$APP_CONTAINER" || die "$APP_CONTAINER is not stopped (state=$(state "$APP_CONTAINER")); stop NStack and quiesce external writes first"
  [[ $(state "$MAIN_CONTAINER") == running ]] || die "$MAIN_CONTAINER is not running"
  [[ $(state "$GRAPH_CONTAINER") == running ]] || die "$GRAPH_CONTAINER is not running"
  [[ ! -e $OUTPUT ]] || die "output already exists: $OUTPUT"

  local storage_file seaweedfs_volume="" seaweedfs_image_ref="" seaweedfs_image_id=""
  if [[ $STORAGE_PROVIDER == seaweedfs ]]; then
    storage_file="seaweedfs-data.tar.age"
    is_stopped_state "$SEAWEEDFS_CONTAINER" || die "$SEAWEEDFS_CONTAINER is not stopped (state=$(state "$SEAWEEDFS_CONTAINER")); gracefully stop SeaweedFS before backup so LevelDB metadata is consistent"
    seaweedfs_volume="$(resolve_seaweedfs_data_volume)"
    seaweedfs_image_ref=$(docker inspect -f '{{.Config.Image}}' "$SEAWEEDFS_CONTAINER")
    seaweedfs_image_id=$(docker inspect -f '{{.Image}}' "$SEAWEEDFS_CONTAINER")
    [[ $seaweedfs_image_ref =~ ^sha256:[0-9a-f]{64}$ ]] || die "$SEAWEEDFS_CONTAINER runs $seaweedfs_image_ref, not an NStack SeaweedFS image ID reference"
    [[ $(docker image inspect -f '{{.Id}}' "$seaweedfs_image_ref") == "$seaweedfs_image_id" ]] || die "SeaweedFS image $seaweedfs_image_ref no longer resolves to the running container's image"
  else
    storage_file="minio-data.tar.age"
    [[ $(state "$MINIO_CONTAINER") == running ]] || die "$MINIO_CONTAINER is not running"
  fi

  umask 077
  local parent staging created completed
  parent=$(dirname "$OUTPUT")
  mkdir -p "$parent"
  staging=$(mktemp -d "$parent/.tower-backup-staging.XXXXXXXX")
  completed=0
  trap 'if [[ $completed != 1 ]]; then rm -rf -- "$staging"; fi' EXIT

  created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  docker exec "$MAIN_CONTAINER" sh -ceu 'exec pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' \
    | age --encrypt --recipient "$RECIPIENT" --output "$staging/main-postgres.dump.age"
  docker exec "$GRAPH_CONTAINER" sh -ceu 'exec pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' \
    | age --encrypt --recipient "$RECIPIENT" --output "$staging/graph-postgres.dump.age"

  if [[ $STORAGE_PROVIDER == seaweedfs ]]; then
    # Archive the stopped SeaweedFS volume read-only using the guaranteed postgres:16-alpine image
    # so LevelDB metadata and volume files are consistent with UID/GID 1000:1000 preserved.
    docker run --rm --network none -v "${seaweedfs_volume}:/data:ro" postgres:16-alpine tar -C /data -cf - . \
      | age --encrypt --recipient "$RECIPIENT" --output "$staging/$storage_file"
    docker image save "$seaweedfs_image_ref" | age --encrypt --recipient "$RECIPIENT" --output "$staging/seaweedfs-image.tar.age"
  else
    # The pinned MinIO image ships no tar; read its /data volume through a read-only helper.
    local minio_volume
    minio_volume=$(docker inspect -f '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' "$MINIO_CONTAINER" 2>/dev/null || true)
    [[ -n "$minio_volume" ]] || die "could not resolve the named /data volume of $MINIO_CONTAINER"
    docker run --rm --network none -v "${minio_volume}:/data:ro" postgres:16-alpine tar -C /data -cf - . \
      | age --encrypt --recipient "$RECIPIENT" --output "$staging/$storage_file"
  fi

  local main_sha graph_sha storage_sha main_size graph_size storage_size
  main_sha=$(sha "$staging/main-postgres.dump.age"); main_size=$(size "$staging/main-postgres.dump.age")
  graph_sha=$(sha "$staging/graph-postgres.dump.age"); graph_size=$(size "$staging/graph-postgres.dump.age")
  storage_sha=$(sha "$staging/$storage_file"); storage_size=$(size "$staging/$storage_file")
  local image_component='[]'
  if [[ $STORAGE_PROVIDER == seaweedfs ]]; then
    image_component=$(jq -n -c --arg sha "$(sha "$staging/seaweedfs-image.tar.age")" --argjson bytes "$(size "$staging/seaweedfs-image.tar.age")" \
      --arg ref "$seaweedfs_image_ref" --arg id "$seaweedfs_image_id" \
      '[{name:"seaweedfs-image",file:"seaweedfs-image.tar.age",sha256:$sha,encrypted_bytes:$bytes,format:"docker-image-archive",image_ref:$ref,image_id:$id}]')
  fi
  jq -n -c \
    --argjson image_component "$image_component" \
    --argjson version "$SCRIPT_VERSION" --arg created_at "$created" \
    --arg storage_provider "$STORAGE_PROVIDER" --arg storage_file "$storage_file" \
    --arg main_sha "$main_sha" --arg graph_sha "$graph_sha" --arg storage_sha "$storage_sha" \
    --argjson main_size "$main_size" --argjson graph_size "$graph_size" --argjson storage_size "$storage_size" \
    '{format:"wingman-tower-backup",version:$version,storage_provider:$storage_provider,created_at:$created_at,consistency:"operator-quiesced",components:([
      {name:"main-postgres",file:"main-postgres.dump.age",sha256:$main_sha,encrypted_bytes:$main_size,format:"pg_dump-custom"},
      {name:"graph-postgres",file:"graph-postgres.dump.age",sha256:$graph_sha,encrypted_bytes:$graph_size,format:"pg_dump-custom"},
      {name:$storage_provider,file:$storage_file,sha256:$storage_sha,encrypted_bytes:$storage_size,format:"tar"}
    ] + $image_component)}' | age --encrypt --recipient "$RECIPIENT" --output "$staging/manifest.json.age"

  mv "$staging" "$OUTPUT"
  completed=1
  trap - EXIT
  printf 'Created encrypted backup set (v%s, provider=%s): %s\n' "$SCRIPT_VERSION" "$STORAGE_PROVIDER" "$OUTPUT"
  printf 'Run verify before copying or pruning backups.\n'
}

verify() {
  parse "$@"
  need age; need docker; need jq; need shasum
  [[ -d ${BACKUP:-} && -f ${IDENTITY:-} ]] || die "--backup DIR and --identity FILE are required"
  local manifest format version provider
  manifest=$(decrypt_manifest) || die "manifest decryption failed"
  format=$(jq -er '.format' <<<"$manifest")
  version=$(jq -er '.version' <<<"$manifest")
  [[ $format == wingman-tower-backup ]] || die "unsupported backup format: $format"
  case "$version" in
    1) provider="minio" ;;
    2)
      provider=$(jq -er '.storage_provider' <<<"$manifest")
      validate_provider "$provider"
      ;;
    *) die "unsupported backup version: $version" ;;
  esac

  validate_manifest_components "$manifest" "$version" "$provider"

  local name file expected comp_format actual
  while IFS=$'\t' read -r name file expected comp_format; do
    [[ $file =~ ^[a-z0-9.-]+\.age$ && -f $BACKUP/$file ]] || die "missing or unsafe component filename: $file"
    actual=$(sha "$BACKUP/$file")
    [[ $actual == "$expected" ]] || die "checksum mismatch: $file"
    case "$comp_format" in
      pg_dump-custom)
        # pg_restore --list reads only the table of contents and exits; store the whole stream first
        # so a large dump is fully decrypted and age never dies of SIGPIPE under pipefail.
        age --decrypt --identity "$IDENTITY" "$BACKUP/$file" \
          | docker run --rm -i postgres:16-alpine sh -ec 'cat > /tmp/dump && pg_restore --list /tmp/dump >/dev/null'
        ;;
      tar|docker-image-archive)
        age --decrypt --identity "$IDENTITY" "$BACKUP/$file" | tar -tf - >/dev/null
        ;;
      *)
        die "unsupported component format: $comp_format ($name)"
        ;;
    esac
  done < <(jq -r '.components[] | [.name,.file,.sha256,.format] | @tsv' <<<"$manifest")

  printf 'Verified backup set (v%s, provider=%s): %s (%s)\n' "$version" "$provider" "$BACKUP" "$(jq -r '.created_at' <<<"$manifest")"
}

restore() {
  parse "$@"
  need age; need docker; need jq
  [[ -d ${BACKUP:-} && -f ${IDENTITY:-} ]] || die "--backup DIR and --identity FILE are required"
  [[ ${TARGET:-} =~ ^tower-restore-[a-z0-9][a-z0-9-]{2,40}$ ]] || die "--target must match tower-restore-[a-z0-9][a-z0-9-]{2,40}"
  [[ ${CONFIRM:-} == "$TARGET" ]] || die "--confirm must exactly match --target"
  case "$TARGET" in wingman-tower*|*postgres-data|*graph-postgres-data|*minio-data|*seaweedfs-data) die "target resembles a live NStack resource";; esac

  verify --backup "$BACKUP" --identity "$IDENTITY"
  local manifest version provider storage_file
  manifest=$(decrypt_manifest)
  version=$(jq -er '.version' <<<"$manifest")
  if [[ $version == 1 ]]; then
    provider="minio"
    storage_file="minio-data.tar.age"
  else
    provider=$(jq -er '.storage_provider' <<<"$manifest")
    validate_provider "$provider"
    storage_file="${provider}-data.tar.age"
  fi
  [[ $storage_file =~ ^[a-z0-9.-]+\.age$ && -f $BACKUP/$storage_file ]] || die "missing storage archive: $storage_file"

  local main_volume="${TARGET}-main-data" graph_volume="${TARGET}-graph-data" storage_volume="${TARGET}-${provider}-data"
  local main_container="${TARGET}-main" graph_container="${TARGET}-graph"
  local name
  for name in "$main_volume" "$graph_volume" "$storage_volume"; do
    ! docker volume inspect "$name" >/dev/null 2>&1 || die "target volume already exists: $name"
  done
  for name in "$main_container" "$graph_container"; do
    ! docker container inspect "$name" >/dev/null 2>&1 || die "target container already exists: $name"
  done

  docker volume create "$main_volume" >/dev/null
  docker volume create "$graph_volume" >/dev/null
  docker volume create "$storage_volume" >/dev/null
  docker run -d --name "$main_container" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=restore_main \
    -v "$main_volume:/var/lib/postgresql/data" postgres:16-alpine >/dev/null
  docker run -d --name "$graph_container" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=restore_graph \
    -v "$graph_volume:/var/lib/postgresql/data" apache/age:release_PG16_1.6.0 >/dev/null
  local tries
  # Readiness over TCP: the image entrypoint's temporary init server listens on the socket only.
  # The restore databases are then recreated from template0, because image init scripts (the
  # AGE image runs CREATE EXTENSION age) would otherwise collide with objects in the dump.
  for name in "$main_container" "$graph_container"; do
    for tries in {1..90}; do docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
    docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 || die "restore target did not become ready: $name"
  done
  docker exec "$main_container" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres \
    -c 'DROP DATABASE restore_main' -c 'CREATE DATABASE restore_main TEMPLATE template0' >/dev/null
  docker exec "$graph_container" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres \
    -c 'DROP DATABASE restore_graph' -c 'CREATE DATABASE restore_graph TEMPLATE template0' >/dev/null
  age --decrypt --identity "$IDENTITY" "$BACKUP/main-postgres.dump.age" \
    | docker exec -i "$main_container" pg_restore --exit-on-error --no-owner --no-acl -U postgres -d restore_main

  # §7.6: Mark any restored migration journal runs aborted_restore in the restored clone ONLY
  # so a window backup (captured at source_fenced) boots cleanly without bypassing the live guard.
  docker exec "$main_container" psql -v ON_ERROR_STOP=1 -U postgres -d restore_main -c "
    DO \$\$
    BEGIN
      IF to_regclass('public.storage_migration_runs') IS NOT NULL THEN
        UPDATE storage_migration_runs
        SET phase = 'aborted_restore',
            aborted_restore_at = COALESCE(aborted_restore_at, NOW()),
            updated_at = NOW()
        WHERE phase <> 'aborted_restore';
      END IF;
    END \$\$;
  " >/dev/null

  age --decrypt --identity "$IDENTITY" "$BACKUP/graph-postgres.dump.age" \
    | docker exec -i "$graph_container" pg_restore --exit-on-error --no-owner --no-acl -U postgres -d restore_graph
  # Apache AGE keys each graph by its schema OID (ag_graph.graphid, ag_label.graph). pg_restore
  # recreates the schema with a new OID, so remap the catalog in this fresh clone or every
  # restored graph is unusable ("graph with oid N does not exist").
  docker exec -i "$graph_container" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d restore_graph >/dev/null <<'SQL'
DO $$
BEGIN
  IF to_regclass('ag_catalog.ag_graph') IS NOT NULL THEN
    SET LOCAL session_replication_role = replica;
    CREATE TEMP TABLE ag_graph_remap ON COMMIT DROP AS
      SELECT graphid AS old_id, namespace::oid AS new_id FROM ag_catalog.ag_graph WHERE graphid <> namespace::oid;
    UPDATE ag_catalog.ag_label l SET graph = m.new_id FROM ag_graph_remap m WHERE l.graph = m.old_id;
    UPDATE ag_catalog.ag_graph g SET graphid = m.new_id FROM ag_graph_remap m WHERE g.graphid = m.old_id;
    IF EXISTS (SELECT 1 FROM ag_catalog.ag_label l LEFT JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.graphid IS NULL)
      OR EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE graphid <> namespace::oid) THEN
      RAISE EXCEPTION 'AGE catalog remap left inconsistent graph references';
    END IF;
  END IF;
END $$;
SQL
  age --decrypt --identity "$IDENTITY" "$BACKUP/$storage_file" \
    | docker run --rm -i --network none -v "$storage_volume:/restore" postgres:16-alpine tar -C /restore -xf -
  if [[ $provider == seaweedfs && $version == 2 ]]; then
    # Make the exact recorded SeaweedFS image available (load only when its ID is absent).
    local image_id image_ref
    image_id=$(jq -er '.components[] | select(.name == "seaweedfs-image") | .image_id' <<<"$manifest")
    image_ref=$(jq -er '.components[] | select(.name == "seaweedfs-image") | .image_ref' <<<"$manifest")
    if ! docker image inspect "$image_id" >/dev/null 2>&1; then
      age --decrypt --identity "$IDENTITY" "$BACKUP/seaweedfs-image.tar.age" | docker image load >/dev/null
    fi
    [[ $(docker image inspect -f '{{.Id}}' "$image_id" 2>/dev/null) == "$image_id" ]] || die "SeaweedFS image $image_id could not be restored from the backup"
    printf 'SeaweedFS image available: %s (recorded reference %s)\n' "$image_id" "$image_ref"
  fi
  printf 'Restored into disposable targets only (provider=%s):\n  %s\n  %s\n  %s\n' "$provider" "$main_container" "$graph_container" "$storage_volume"
  printf 'Restored storage_migration_runs rows (if any) marked aborted_restore in %s only.\n' "$main_container"
  printf 'No ports are published. Inspect, test, then explicitly remove these targets when finished.\n'
}

command_name=${1:-}
shift || true
case "$command_name" in
  backup) backup "$@" ;;
  verify) verify "$@" ;;
  restore) restore "$@" ;;
  help|-h|--help|'') usage ;;
  *) die "unknown command: $command_name" ;;
esac
