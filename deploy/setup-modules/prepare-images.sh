#!/bin/sh
# Fixed image preflight only. Does not start services or modify data/networks.
set -eu
if [ "$#" -ne 0 ]; then echo 'This fixed catalogue takes no arguments' >&2; exit 64; fi
docker pull apache/age:release_PG16_1.6.0@sha256:16aa423d20a31aed36a3313244bf7aa00731325862f20ed584510e381f2feaed
docker pull docker.io/scsibug/nostr-rs-relay:0.10.0@sha256:48d54c2d2781577cf3ed2951112f0953dc2c5e7c9d2ea20c64e8c0fa37d16e4d
docker pull ghcr.io/hzrd149/blossom-server:6.4.1@sha256:446fa6c4b0ca529a1fbceabf5ea75839b5b76dfb0d0e1d150f3bae5f9a52b3b8
if ! docker image inspect nstack-grasp@sha256:4aaf778f0bf938745821a146e20dadd48b6b677138bd3350384807ddb1b72194 >/dev/null 2>&1; then
  echo 'Private Git image not provisioned: import the reviewed pinned nstack-grasp build. See docs/nstack-modules.md. Public upstream is not a safe substitute.' >&2
  exit 1
fi
