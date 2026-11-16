#!/bin/sh
set -eu
# Separate protected volume. Never reuse Tower bootstrap identity or DB secrets.
umask 077
mkdir -p /run/module-state
chmod 700 /run/module-state
if [ -f /var/lib/postgresql/data/PG_VERSION ] && { [ ! -f /run/module-state/admin-password ] || [ ! -f /run/module-state/app-password ]; }; then
  echo "Protected graph credentials are missing for existing data; restore state backup, do not rotate" >&2
  exit 1
fi
for name in admin-password app-password; do
  if [ ! -e "/run/module-state/$name" ]; then
    # PostgreSQL base image includes openssl; output is SQL/shell-safe hex only.
    openssl rand -hex 32 > "/run/module-state/$name.tmp"
    mv "/run/module-state/$name.tmp" "/run/module-state/$name"
  fi
  chmod 600 "/run/module-state/$name"
  test "$(wc -c < "/run/module-state/$name")" -eq 65
  grep -Eq '^[0-9a-f]{64}$' "/run/module-state/$name"
done
export POSTGRES_USER=nstack_graph_admin POSTGRES_DB=tower_graph
export POSTGRES_PASSWORD="$(cat /run/module-state/admin-password)"
exec /usr/local/bin/docker-entrypoint.sh "$@"
