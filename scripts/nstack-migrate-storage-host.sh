#!/usr/bin/env bash
# Thin wrapper: the storage migration host orchestrator is implemented in Bun.
set -euo pipefail
exec bun "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nstack-migrate-storage-host.ts" "$@"
