#!/usr/bin/env bash
set -euo pipefail

# Validate ORG2 in a reproducible Linux container so fresh clones do not rely
# on host-installed pnpm/cargo or machine-local macOS Cargo paths.
#
# Usage:
#   scripts/dev/orgii_docker_validate.sh [image_tag]
#
# Optional env:
#   ORGII_DOCKER_IMAGE=org2-build:local
#   ORGII_SKIP_DOCKER_BUILD=1   # reuse an existing image

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${1:-${ORGII_DOCKER_IMAGE:-org2-build:local}}"

cd "$ROOT"

if [[ "${ORGII_SKIP_DOCKER_BUILD:-0}" != "1" ]]; then
  docker build -f Dockerfile.build -t "$IMAGE" .
fi

INSTALL_CMD="pnpm install --no-frozen-lockfile"
if [[ "${ORGII_SKIP_PNPM_INSTALL:-0}" == "1" ]]; then
  INSTALL_CMD="test -d node_modules"
fi

docker run --rm \
  -e CI=1 \
  -e NO_AT_BRIDGE=1 \
  -v "$ROOT:/work" \
  -w /work \
  "$IMAGE" \
  bash -lc "
    set -euo pipefail
    ${INSTALL_CMD}
    pnpm exec tsc --noEmit
    cd src-tauri
    cargo test -p agent_core channel_handler::slash --lib
    cargo check -p agent_core
  "
