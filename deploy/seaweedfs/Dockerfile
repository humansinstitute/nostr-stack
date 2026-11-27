# NStack SeaweedFS image: the pinned upstream SeaweedFS 4.55 image with only /usr/bin/weed
# rebuilt from the exact upstream source plus the compatibility patches in ./patches.
# Every other file (Alpine userland, Rust volume/worker/vector binaries, entrypoint) is the
# unchanged upstream layer set. See README.md for provenance, rationale and the removal gate.

# Upstream SeaweedFS 4.55 multi-arch image index (tag 4.55 = commit below).
ARG SEAWEEDFS_UPSTREAM_IMAGE=chrislusf/seaweedfs@sha256:7ca46aeae2f223b37e5d91593c17ab37738eec6df6ab69b48a0487f7643342b9
# Go toolchain matching the upstream binary (weed 4.55 reports go1.26.11): golang:1.26.11-alpine index.
ARG GO_BUILDER_IMAGE=golang@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab

FROM --platform=$BUILDPLATFORM ${GO_BUILDER_IMAGE} AS builder
ARG SEAWEEDFS_COMMIT=a98c9e27185cf1003eca095761a39973c60734db
ARG SEAWEEDFS_SOURCE_SHA256=8434a362a0e2224c10bed92553218635d3d93ece3c7f1e8111537d58c69b4a2a
ENV GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=0
WORKDIR /go/src/github.com/seaweedfs/seaweedfs
RUN wget -q -O /tmp/seaweedfs.tar.gz "https://codeload.github.com/seaweedfs/seaweedfs/tar.gz/${SEAWEEDFS_COMMIT}" \
 && echo "${SEAWEEDFS_SOURCE_SHA256}  /tmp/seaweedfs.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/seaweedfs.tar.gz --strip-components=1 \
 && rm /tmp/seaweedfs.tar.gz
COPY patches/ /patches/
# GNU patch is a build-time tool only; --forward and exit status make a non-applying patch fail the build.
RUN apk add --no-cache patch \
 && for p in /patches/*.patch; do patch -p1 --forward < "$p" || exit 1; done
# Module versions come only from the upstream go.sum (-mod=readonly); nothing is upgraded.
RUN go mod download
# The patched response-header behaviour and upstream's own response-header tests gate the build.
RUN go test -count=1 -run 'TestSetResponseHeaders' ./weed/s3api/
ARG TARGETOS TARGETARCH
# Same flags as upstream docker/Dockerfile.go_build (default tags, static, short commit).
RUN cd weed && GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -ldflags "-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=$(echo "$SEAWEEDFS_COMMIT" | cut -c1-9)" -o /out/weed .

FROM ${SEAWEEDFS_UPSTREAM_IMAGE}
ARG SEAWEEDFS_COMMIT=a98c9e27185cf1003eca095761a39973c60734db
COPY --from=builder /out/weed /usr/bin/weed
LABEL org.opencontainers.image.title="nstack-seaweedfs" \
      org.opencontainers.image.version="4.55-nstack.1" \
      org.opencontainers.image.revision="${SEAWEEDFS_COMMIT}" \
      org.opencontainers.image.base.name="chrislusf/seaweedfs:4.55" \
      io.nstack.seaweedfs.patches="0001-s3-serve-octet-stream-for-empty-mime"
