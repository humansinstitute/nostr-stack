#!/usr/bin/env bash
set -euo pipefail
# Build from public pinned upstream source plus the tracked, reviewed ACL patch.
mode=${1:?use prepare|test|image UPSTREAM_CHECKOUT STAGE IMAGE}
upstream=${2:?set upstream checkout}
stage=${3:?set new ignored staging directory}
image=${4:-nstack-grasp:3.0.1-access}
root=$(cd "$(dirname "$0")/../.." && pwd)
patch="$root/deploy/nstack/grasp/patches/repository-readers.patch"
revision=b990d2189ba494944f8e6c875d52056421c061c2
case "$mode" in prepare|test|image) ;; *) exit 64 ;; esac
if [ ! -d "$stage" ]; then
  git -C "$root" check-ignore --quiet "$stage"
  if [ -n "$(git -C "$root" ls-files -- "$stage")" ]; then echo 'Stage must be untracked' >&2; exit 1; fi
  mkdir -p "$stage"
  git -C "$upstream" archive "$revision" | tar -x -C "$stage"
  git -C "$stage" init --quiet
  git -C "$stage" apply --check "$patch"
  git -C "$stage" apply "$patch"
else
  # Do not silently build a stale or concurrently edited stage.
  git -C "$stage" apply --reverse --check "$patch"
fi
if [ "$mode" = prepare ]; then exit 0; fi
if [ "$mode" = test ]; then
  mkdir -p "$stage/test-tmp"
  canonical_stage=$(cd "$stage" && pwd -P)
  export TMPDIR="$canonical_stage/test-tmp"
  cargo test --locked --manifest-path "$stage/Cargo.toml" --lib private::
  cargo test --locked --manifest-path "$stage/Cargo.toml" --test private_mode
else
  docker build --build-arg NGIT_BUILD_REVISION=nstack-repository-access-v1 \
    --build-arg NGIT_IMAGE_REVISION=nstack-repository-access-v1 \
    --build-arg NGIT_IMAGE_VERSION=3.0.1-nstack-access -t "$image" "$stage"
fi
