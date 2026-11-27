#!/usr/bin/env bash
#
# rebuild_deploy_docker.sh
#
# Rebuild and (re)deploy the NStack prod Docker stack:
#   - wingman-tower-postgres
#   - wingman-tower-graph-postgres
#   - active storage profile (seaweedfs or legacy minio; none for external-s3)
#   - wingman-tower-b3
#
# Uses .env.prod as the env file for docker compose and docker-compose.prod.yml
# as the stack definition. Override either with ENV_FILE / COMPOSE_FILE.
# Always includes the required .env.fips and docker-compose.fips.yml settings.
#
# Usage:
#   ./rebuild_deploy_docker.sh              # rebuild + up -d
#   ./rebuild_deploy_docker.sh --no-cache   # force a clean image rebuild
#   ./rebuild_deploy_docker.sh --refresh-bun-base # refresh the cached Bun runtime
#   ./rebuild_deploy_docker.sh --down       # bring the stack down first
#   ENV_FILE=.env.prod.staging ./rebuild_deploy_docker.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="${ENV_FILE:-.env.prod}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

NO_CACHE=0
DOWN_FIRST=0
REFRESH_BUN_BASE=0
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE=1 ;;
    --down)     DOWN_FIRST=1 ;;
    --refresh-bun-base) REFRESH_BUN_BASE=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file '$ENV_FILE' not found in $SCRIPT_DIR" >&2
  echo "Copy .env.prod.example to .env.prod and fill in the secrets." >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: compose file '$COMPOSE_FILE' not found in $SCRIPT_DIR" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required to verify Tower HTTP and FIPS health" >&2
  exit 1
fi

# Pick `docker compose` (plugin) or legacy `docker-compose`.
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "ERROR: neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

# Read selected non-secret storage provider settings from ENV_FILE (never print secrets).
# Handles leading/trailing whitespace, quotes, and inline `#` comments outside quotes.
env_value() {
  local key="$1"
  awk -F= -v k="$key" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      lhs = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", lhs)
      if (lhs == k) {
        val = substr($0, index($0, "=") + 1)
        gsub(/^[[:space:]]+|\r$/, "", val)
        if (val ~ /^".*"/) {
          sub(/^"/, "", val); sub(/".*$/, "", val)
        } else if (val ~ /^'\''.*'\''/) {
          sub(/^'\''/, "", val); sub(/'\''.*$/, "", val)
        } else {
          sub(/[[:space:]]+#.*$/, "", val)
          gsub(/[[:space:]]+$/, "", val)
        }
      }
    }
    END { print val }
  ' "$ENV_FILE"
}

ENV_STORAGE_PROVIDER="$(env_value STORAGE_PROVIDER | tr '[:upper:]' '[:lower:]')"
ENV_STORAGE_ENDPOINT="$(env_value STORAGE_S3_ENDPOINT)"
ENV_COMPOSE_PROFILES="$(env_value COMPOSE_PROFILES)"
ENV_MINIO_IMAGE="$(env_value MINIO_IMAGE)"
ENV_TOWER_HOST_PORT="$(env_value TOWER_HOST_PORT)"
ENV_SFS_ACCESS_KEY="$(env_value SEAWEEDFS_ACCESS_KEY)"
ENV_SFS_SECRET_KEY="$(env_value SEAWEEDFS_SECRET_KEY)"
ENV_S3_ACCESS_KEY="$(env_value STORAGE_S3_ACCESS_KEY)"
MINIO_DEFAULT_PIN="minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e"

# Match Docker Compose precedence: exported shell environment overrides ENV_FILE.
EFFECTIVE_STORAGE_PROVIDER="$(printf '%s' "${STORAGE_PROVIDER:-$ENV_STORAGE_PROVIDER}" | tr '[:upper:]' '[:lower:]')"
EFFECTIVE_STORAGE_ENDPOINT="${STORAGE_S3_ENDPOINT:-$ENV_STORAGE_ENDPOINT}"
EFFECTIVE_MINIO_IMAGE="${MINIO_IMAGE:-$ENV_MINIO_IMAGE}"
EFFECTIVE_TOWER_HOST_PORT="${TOWER_HOST_PORT:-$ENV_TOWER_HOST_PORT}"
EFFECTIVE_SFS_ACCESS_KEY="${SEAWEEDFS_ACCESS_KEY:-$ENV_SFS_ACCESS_KEY}"
EFFECTIVE_SFS_SECRET_KEY="${SEAWEEDFS_SECRET_KEY:-$ENV_SFS_SECRET_KEY}"
EFFECTIVE_S3_ACCESS_KEY="${STORAGE_S3_ACCESS_KEY:-$ENV_S3_ACCESS_KEY}"

endpoint_host() {
  local ep="$1"
  printf '%s' "$ep" | sed -E 's#^[a-zA-Z]+://([^/:]+).*#\1#' | tr '[:upper:]' '[:lower:]'
}

RESOLVED_PROVIDER=""
if [[ -z "$EFFECTIVE_STORAGE_PROVIDER" ]]; then
  if [[ -z "$EFFECTIVE_STORAGE_ENDPOINT" ]]; then
    RESOLVED_PROVIDER="minio"
  else
    ep_host="$(endpoint_host "$EFFECTIVE_STORAGE_ENDPOINT")"
    if [[ "$ep_host" == "minio" || "$ep_host" == "wingman-tower-minio" ]]; then
      RESOLVED_PROVIDER="minio"
    else
      RESOLVED_PROVIDER="external-s3"
    fi
  fi
else
  case "$EFFECTIVE_STORAGE_PROVIDER" in
    seaweedfs|minio|external-s3)
      RESOLVED_PROVIDER="$EFFECTIVE_STORAGE_PROVIDER"
      ;;
    *)
      echo "ERROR: invalid STORAGE_PROVIDER='$EFFECTIVE_STORAGE_PROVIDER' (expected seaweedfs, minio, or external-s3)" >&2
      exit 1
      ;;
  esac
  if [[ -n "$EFFECTIVE_STORAGE_ENDPOINT" ]]; then
    ep_host="$(endpoint_host "$EFFECTIVE_STORAGE_ENDPOINT")"
    if [[ "$RESOLVED_PROVIDER" == "seaweedfs" && ( "$ep_host" == "minio" || "$ep_host" == "wingman-tower-minio" ) ]]; then
      echo "ERROR: STORAGE_PROVIDER=seaweedfs conflicts with STORAGE_S3_ENDPOINT=$EFFECTIVE_STORAGE_ENDPOINT" >&2
      exit 1
    fi
    if [[ "$RESOLVED_PROVIDER" == "minio" && ( "$ep_host" == "seaweedfs" || "$ep_host" == "wingman-tower-seaweedfs" ) ]]; then
      echo "ERROR: STORAGE_PROVIDER=minio conflicts with STORAGE_S3_ENDPOINT=$EFFECTIVE_STORAGE_ENDPOINT" >&2
      exit 1
    fi
    if [[ "$RESOLVED_PROVIDER" == "external-s3" && ( "$ep_host" == "minio" || "$ep_host" == "wingman-tower-minio" || "$ep_host" == "seaweedfs" || "$ep_host" == "wingman-tower-seaweedfs" ) ]]; then
      echo "ERROR: STORAGE_PROVIDER=external-s3 conflicts with bundled endpoint STORAGE_S3_ENDPOINT=$EFFECTIVE_STORAGE_ENDPOINT" >&2
      exit 1
    fi
  elif [[ "$RESOLVED_PROVIDER" == "external-s3" ]]; then
    echo "ERROR: STORAGE_S3_ENDPOINT must be set when STORAGE_PROVIDER=external-s3" >&2
    exit 1
  fi
fi

EFFECTIVE_PROFILES="${COMPOSE_PROFILES:-$ENV_COMPOSE_PROFILES}"
if [[ -z "$EFFECTIVE_PROFILES" ]]; then
  case "$RESOLVED_PROVIDER" in
    seaweedfs) EFFECTIVE_PROFILES="seaweedfs" ;;
    minio)     EFFECTIVE_PROFILES="minio" ;;
    external-s3) EFFECTIVE_PROFILES="" ;;
  esac
else
  if [[ "$RESOLVED_PROVIDER" == "seaweedfs" && ",$EFFECTIVE_PROFILES," == *",minio,"* && ",$EFFECTIVE_PROFILES," != *",seaweedfs,"* ]]; then
    echo "ERROR: COMPOSE_PROFILES=$EFFECTIVE_PROFILES enables minio without seaweedfs while STORAGE_PROVIDER=seaweedfs" >&2
    exit 1
  fi
  if [[ "$RESOLVED_PROVIDER" == "minio" && ",$EFFECTIVE_PROFILES," == *",seaweedfs,"* && ",$EFFECTIVE_PROFILES," != *",minio,"* ]]; then
    echo "ERROR: COMPOSE_PROFILES=$EFFECTIVE_PROFILES enables seaweedfs without minio while STORAGE_PROVIDER=minio" >&2
    exit 1
  fi
fi

# When both minio and seaweedfs profiles are active (migration overlap), require explicit
# distinct SeaweedFS app credentials so MinIO root keys are never reused.
if [[ ",$EFFECTIVE_PROFILES," == *",minio,"* && ",$EFFECTIVE_PROFILES," == *",seaweedfs,"* ]]; then
  if [[ -z "$EFFECTIVE_SFS_ACCESS_KEY" || -z "$EFFECTIVE_SFS_SECRET_KEY" ]]; then
    echo "ERROR: COMPOSE_PROFILES=$EFFECTIVE_PROFILES requires explicit SEAWEEDFS_ACCESS_KEY and SEAWEEDFS_SECRET_KEY distinct from MinIO credentials." >&2
    exit 1
  fi
  if [[ -n "$EFFECTIVE_S3_ACCESS_KEY" && "$EFFECTIVE_SFS_ACCESS_KEY" == "$EFFECTIVE_S3_ACCESS_KEY" ]]; then
    echo "ERROR: SEAWEEDFS_ACCESS_KEY must be distinct from MinIO STORAGE_S3_ACCESS_KEY during migration overlap." >&2
    exit 1
  fi
fi

export COMPOSE_PROFILES="$EFFECTIVE_PROFILES"
export TOWER_ENV_FILE="$ENV_FILE"

# Fail clearly if legacy minio profile is active and its pinned cached image is absent locally
# (Docker Hub removed minio/minio:latest; never force pull an unpinned latest tag).
if [[ ",$COMPOSE_PROFILES," == *",minio,"* ]]; then
  PINNED_MINIO="${EFFECTIVE_MINIO_IMAGE:-$MINIO_DEFAULT_PIN}"
  if ! docker image inspect "$PINNED_MINIO" >/dev/null 2>&1; then
    echo "ERROR: legacy minio profile requires local cached image '$PINNED_MINIO' which is absent." >&2
    echo "Set MINIO_IMAGE to your cached/mirrored digest or complete explicit migration to SeaweedFS." >&2
    exit 1
  fi
fi

# Read-only APNs/FCM key directories mounted into Tower; empty (no key) is a valid, healthy state.
mkdir -p "$SCRIPT_DIR/.runtime/tower-apns-secrets" "$SCRIPT_DIR/.runtime/tower-fcm-secrets"

COMPOSE=("${DC[@]}" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
source "$SCRIPT_DIR/docker/compose-fips-options.sh"
append_tower_fips_options
"${COMPOSE[@]}" config --quiet
# Validate the public native gateway settings before changing containers.
bun scripts/fips-host-launchd.ts "${FIPS_ENV_FILE:-.env.fips}" > /dev/null

if [[ "$REFRESH_BUN_BASE" -eq 1 ]]; then
  TOWER_BUN_IMAGE="$(./docker/ensure-bun-base.sh --refresh)"
else
  TOWER_BUN_IMAGE="$(./docker/ensure-bun-base.sh)"
fi
export TOWER_BUN_IMAGE
export TOWER_GIT_COMMIT="$(git rev-parse HEAD)"
export TOWER_GIT_BRANCH="$(git branch --show-current)"
export TOWER_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "==> Using env file : $ENV_FILE"
echo "==> Using compose  : $COMPOSE_FILE"
echo "==> Storage profile: provider=$RESOLVED_PROVIDER profiles=${COMPOSE_PROFILES:-<none>}"
echo "==> Using Bun base : $TOWER_BUN_IMAGE"
echo "==> Compose command: ${COMPOSE[*]}"

if [[ "$DOWN_FIRST" -eq 1 ]]; then
  echo "==> Bringing stack down first"
  "${COMPOSE[@]}" down
fi

if [[ "$NO_CACHE" -eq 1 ]]; then
  echo "==> Building Tower image with --no-cache"
  "${COMPOSE[@]}" build --no-cache tower
  echo "==> Starting stack"
  "${COMPOSE[@]}" up -d
else
  echo "==> Building Tower image"
  "${COMPOSE[@]}" build tower
  echo "==> Starting stack"
  "${COMPOSE[@]}" up -d
fi

echo "==> Current stack status"
"${COMPOSE[@]}" ps

# Both ordinary HTTP and native FIPS health must pass.
TOWER_HOST_PORT="${EFFECTIVE_TOWER_HOST_PORT:-3100}"

echo "==> Probing http://127.0.0.1:${TOWER_HOST_PORT}/health"
curl --noproxy '*' --fail --silent --show-error --max-time 5 \
  --retry 30 --retry-delay 1 --retry-all-errors \
  "http://127.0.0.1:${TOWER_HOST_PORT}/health"
echo

# FIPS success is required; ordinary HTTP health alone cannot accept a deploy.
FIPS_SETTINGS_FILE="${FIPS_ENV_FILE:-.env.fips}"
FIPS_NODE_NPUB="$(awk -F= '$1 == "TOWER_FIPS_NODE_NPUB" { print $2 }' "$FIPS_SETTINGS_FILE" | tr -d '\r')"
FIPS_MESH_ADDRESS="$(awk -F= '$1 == "TOWER_FIPS_MESH_ADDRESS" { print $2 }' "$FIPS_SETTINGS_FILE" | tr -d '\r')"
FIPS_PORT="$(awk -F= '$1 == "TOWER_FIPS_PORT" { print $2 }' "$FIPS_SETTINGS_FILE" | tr -d '\r')"
echo "==> Verifying Tower through its native FIPS gateway"
curl --noproxy '*' --fail --silent --show-error --max-time 5 \
  --retry 30 --retry-delay 1 --retry-all-errors \
  -H "Host: ${FIPS_NODE_NPUB}.fips:${FIPS_PORT}" \
  "http://[${FIPS_MESH_ADDRESS}]:${FIPS_PORT}/health"
echo

echo "==> Done"
