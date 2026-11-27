#!/bin/sh
set -eu

# Render hardened SeaweedFS 4.55 runtime configuration (security.toml + s3.json)
# from environment variables or /run/nstack-storage/runtime.env (setup mode).
# Never logs credentials. Runs non-root as uid/gid 1000 (seaweed) when started
# with user: "1000:1000" and read-only rootfs.

if [ -n "${SEAWEEDFS_ENV_FILE:-}" ] && [ -f "$SEAWEEDFS_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SEAWEEDFS_ENV_FILE"
  set +a
fi

CONFIG_DIR="${SEAWEEDFS_CONFIG_DIR:-/tmp/seaweedfs-config}"
DATA_DIR="${SEAWEEDFS_DATA_DIR:-/data}"
BUCKET="${STORAGE_S3_BUCKET:-superbased-storage}"
APP_ACCESS_KEY="${STORAGE_S3_ACCESS_KEY:-}"
APP_SECRET_KEY="${STORAGE_S3_SECRET_KEY:-}"
ADMIN_ACCESS_KEY="${SEAWEEDFS_ADMIN_ACCESS_KEY:-${SEAWEEDFS_ADMIN_ACCESS_KEY_OVERRIDE:-}}"
ADMIN_SECRET_KEY="${SEAWEEDFS_ADMIN_SECRET_KEY:-${SEAWEEDFS_ADMIN_SECRET_KEY_OVERRIDE:-}}"
JWT_SECRET="${SEAWEEDFS_JWT_SECRET:-${SEAWEEDFS_JWT_SECRET_OVERRIDE:-}}"
JWT_READ_SECRET="${SEAWEEDFS_JWT_READ_SECRET:-${SEAWEEDFS_JWT_READ_SECRET_OVERRIDE:-}}"
JWT_FILER_SECRET="${SEAWEEDFS_JWT_FILER_SECRET:-${SEAWEEDFS_JWT_FILER_SECRET_OVERRIDE:-}}"
JWT_FILER_READ_SECRET="${SEAWEEDFS_JWT_FILER_READ_SECRET:-${SEAWEEDFS_JWT_FILER_READ_SECRET_OVERRIDE:-}}"
JWT_FILER_SUBSCRIBE_SECRET="${SEAWEEDFS_JWT_FILER_SUBSCRIBE_SECRET:-${SEAWEEDFS_JWT_FILER_SUBSCRIBE_SECRET_OVERRIDE:-}}"
ALLOWED_ORIGINS="${SEAWEEDFS_ALLOWED_ORIGINS:-*}"
EXTERNAL_URL="${SEAWEEDFS_EXTERNAL_URL:-}"
MIN_FREE_SPACE="${SEAWEEDFS_MIN_FREE_SPACE:-10}"
VOLUME_SIZE_LIMIT_MB="${SEAWEEDFS_VOLUME_SIZE_LIMIT_MB:-1024}"
VALIDATE_ONLY="${SEAWEEDFS_VALIDATE_ONLY:-false}"
ACTIVE_PROVIDER="${SEAWEEDFS_ACTIVE_PROVIDER:-}"
EXPLICIT_SFS_ACCESS_KEY="${SEAWEEDFS_EXPLICIT_ACCESS_KEY:-}"
EXPLICIT_SFS_SECRET_KEY="${SEAWEEDFS_EXPLICIT_SECRET_KEY:-}"

NL=$(printf '\nx')
NL=${NL%x}
CR=$(printf '\r')

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_nonempty() {
  name="$1"
  val="$2"
  [ -n "$val" ] || fail "$name must be set"
}

require_safe_token() {
  name="$1"
  val="$2"
  require_nonempty "$name" "$val"
  case "$val" in
    *\"*|*\\*|*"$NL"*|*"$CR"*)
      fail "$name contains unsupported characters (quotes, backslashes, or newlines)"
      ;;
  esac
}

require_safe_token "SEAWEEDFS_DATA_DIR" "$DATA_DIR"
require_safe_token "STORAGE_S3_BUCKET" "$BUCKET"
require_safe_token "STORAGE_S3_ACCESS_KEY" "$APP_ACCESS_KEY"
require_safe_token "STORAGE_S3_SECRET_KEY" "$APP_SECRET_KEY"
require_safe_token "SEAWEEDFS_ADMIN_ACCESS_KEY" "$ADMIN_ACCESS_KEY"
require_safe_token "SEAWEEDFS_ADMIN_SECRET_KEY" "$ADMIN_SECRET_KEY"

# During migration overlap (while active provider is still minio), refuse silent fallback to MinIO root keys.
if [ -n "$ACTIVE_PROVIDER" ] && [ "$ACTIVE_PROVIDER" != "seaweedfs" ]; then
  if [ -z "$EXPLICIT_SFS_ACCESS_KEY" ] || [ -z "$EXPLICIT_SFS_SECRET_KEY" ]; then
    fail "SEAWEEDFS_ACCESS_KEY and SEAWEEDFS_SECRET_KEY must be explicitly set (distinct from MinIO keys) while STORAGE_PROVIDER=$ACTIVE_PROVIDER"
  fi
fi

if [ "$APP_ACCESS_KEY" = "$ADMIN_ACCESS_KEY" ]; then
  fail "SEAWEEDFS_ADMIN_ACCESS_KEY must be distinct from STORAGE_S3_ACCESS_KEY"
fi

# Derive per-boot strong ephemeral JWT secrets when not pinned externally;
# all components run in one single-node process, and internal RPCs are loopback-bound.
gen_secret() {
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
}

[ -n "$JWT_SECRET" ] || JWT_SECRET="$(gen_secret)"
[ -n "$JWT_READ_SECRET" ] || JWT_READ_SECRET="$(gen_secret)"
[ -n "$JWT_FILER_SECRET" ] || JWT_FILER_SECRET="$(gen_secret)"
[ -n "$JWT_FILER_READ_SECRET" ] || JWT_FILER_READ_SECRET="$(gen_secret)"
[ -n "$JWT_FILER_SUBSCRIBE_SECRET" ] || JWT_FILER_SUBSCRIBE_SECRET="$(gen_secret)"

require_safe_token "SEAWEEDFS_JWT_SECRET" "$JWT_SECRET"
require_safe_token "SEAWEEDFS_JWT_READ_SECRET" "$JWT_READ_SECRET"
require_safe_token "SEAWEEDFS_JWT_FILER_SECRET" "$JWT_FILER_SECRET"
require_safe_token "SEAWEEDFS_JWT_FILER_READ_SECRET" "$JWT_FILER_READ_SECRET"
require_safe_token "SEAWEEDFS_JWT_FILER_SUBSCRIBE_SECRET" "$JWT_FILER_SUBSCRIBE_SECRET"
require_safe_token "SEAWEEDFS_ALLOWED_ORIGINS" "$ALLOWED_ORIGINS"
if [ -n "$EXTERNAL_URL" ]; then
  require_safe_token "SEAWEEDFS_EXTERNAL_URL" "$EXTERNAL_URL"
fi

umask 077
mkdir -p "$CONFIG_DIR"

SECURITY_TOML="$CONFIG_DIR/security.toml"
S3_JSON="$CONFIG_DIR/s3.json"
FILER_TOML="$CONFIG_DIR/filer.toml"

cat > "$SECURITY_TOML" <<EOF
[cors.allowed_origins]
values = "$ALLOWED_ORIGINS"

[access]
ui = false

[filer.expose_directory_metadata]
enabled = false

[jwt.signing]
key = "$JWT_SECRET"
expires_after_seconds = 10

[jwt.signing.read]
key = "$JWT_READ_SECRET"
expires_after_seconds = 10

[jwt.filer_signing]
key = "$JWT_FILER_SECRET"
expires_after_seconds = 10

[jwt.filer_signing.read]
key = "$JWT_FILER_READ_SECRET"
expires_after_seconds = 10

[jwt.filer_signing.subscribe]
key = "$JWT_FILER_SUBSCRIBE_SECRET"

[guard]
white_list = "127.0.0.1,@"
EOF

# Separate least-privilege Tower RW+List identity scoped to the configured bucket
# and a distinct init/admin identity for bucket creation and sentinel setup.
# No anonymous identity is declared.
cat > "$S3_JSON" <<EOF
{
  "identities": [
    {
      "name": "nstack_admin",
      "credentials": [
        {
          "accessKey": "$ADMIN_ACCESS_KEY",
          "secretKey": "$ADMIN_SECRET_KEY"
        }
      ],
      "actions": [
        "Admin",
        "Read",
        "List",
        "Tagging",
        "Write"
      ]
    },
    {
      "name": "nstack_app",
      "credentials": [
        {
          "accessKey": "$APP_ACCESS_KEY",
          "secretKey": "$APP_SECRET_KEY"
        }
      ],
      "actions": [
        "Read:$BUCKET",
        "List:$BUCKET",
        "Tagging:$BUCKET",
        "Write:$BUCKET"
      ]
    }
  ]
}
EOF

cat > "$FILER_TOML" <<EOF
[leveldb2]
enabled = true
dir = "$DATA_DIR/filerldb2"
EOF

chmod 0600 "$SECURITY_TOML" "$S3_JSON" "$FILER_TOML"

if [ "$VALIDATE_ONLY" = "true" ]; then
  echo "SeaweedFS config validated"
  exit 0
fi

mkdir -p "$DATA_DIR/filerldb2"
cd "$CONFIG_DIR"

# Export WEED_JWT_* so every sub-server inside `weed server` sees the exact signing keys
# regardless of config search path precedence.
export WEED_JWT_SIGNING_KEY="$JWT_SECRET"
export WEED_JWT_SIGNING_READ_KEY="$JWT_READ_SECRET"
export WEED_JWT_FILER_SIGNING_KEY="$JWT_FILER_SECRET"
export WEED_JWT_FILER_SIGNING_READ_KEY="$JWT_FILER_READ_SECRET"
export WEED_JWT_FILER_SIGNING_SUBSCRIBE_KEY="$JWT_FILER_SUBSCRIBE_SECRET"
export GODEBUG="${GODEBUG:+$GODEBUG,}fips140=on"

set -- \
  -logtostderr=true \
  server \
  -dir="$DATA_DIR" \
  -ip=127.0.0.1 \
  -ip.bind=127.0.0.1 \
  -master.telemetry=false \
  -master.volumeSizeLimitMB="$VOLUME_SIZE_LIMIT_MB" \
  -volume.max=0 \
  -volume.minFreeSpace="$MIN_FREE_SPACE" \
  -filer=true \
  -filer.disableHttp=true \
  -filer.exposeDirectoryData=false \
  -filer.disableDirListing=true \
  -s3=true \
  -s3.ip.bind=0.0.0.0 \
  -s3.port=8333 \
  -s3.config="$S3_JSON" \
  -s3.allowedOrigins="$ALLOWED_ORIGINS" \
  -s3.autoCreateBucket=false \
  -s3.iam=false \
  -s3.iam.readOnly=true \
  -s3.iam.selfServiceRequiresGrant=true \
  -s3.port.iceberg=0 \
  -s3.port.lance=0

if [ -n "$EXTERNAL_URL" ]; then
  set -- "$@" -s3.externalUrl="$EXTERNAL_URL"
fi

exec /usr/bin/weed "$@"
