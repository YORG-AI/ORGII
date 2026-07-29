#!/bin/bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly PROFILE_DIR="${ORGII_DHAT_DIR:-${TMPDIR:-/tmp}/orgii-dhat-profiles}"
readonly PROFILE_STAMP="$(date '+%Y%m%d-%H%M%S')"
readonly PROFILE_FILE="${ORGII_DHAT_OUTPUT:-${PROFILE_DIR}/orgii-dhat-${PROFILE_STAMP}-$$.json}"

mkdir -p "$(dirname -- "${PROFILE_FILE}")"

if [[ "${ORGII_DHAT_SKIP_FRONTEND_BUILD:-false}" != "true" ]]; then
    echo "Building the production frontend used by the optimized Tauri profile..."
    (
        cd "${REPO_ROOT}"
        pnpm run build
    )
elif [[ ! -f "${REPO_ROOT}/build/index.html" ]]; then
    echo "ORGII_DHAT_SKIP_FRONTEND_BUILD=true requires an existing build/index.html" >&2
    exit 1
fi

echo "Building and running the optimized DHAT profile..."
echo "Wait for the '[dhat] Rust heap profiling started' message before testing."
echo "Quit ORGII with Cmd+Q to finalize the heap profile; closing the window only hides it."
echo "Profile output: ${PROFILE_FILE}"

(
    cd "${REPO_ROOT}"
    ORGII_DHAT_OUTPUT="${PROFILE_FILE}" cargo run \
        --manifest-path src-tauri/Cargo.toml \
        --profile dhat \
        --features dhat-heap \
        --bin org2 \
        -- "$@"
)

if [[ -f "${PROFILE_FILE}" ]]; then
    echo "DHAT profile saved: ${PROFILE_FILE}"
else
    echo "DHAT did not write a profile. Make sure ORGII exited normally instead of being force-killed." >&2
    exit 1
fi
