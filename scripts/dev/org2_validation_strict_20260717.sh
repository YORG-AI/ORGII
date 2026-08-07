#!/usr/bin/env bash
set -euo pipefail
ROOT=/mnt/panshuainan/org2-merge-official-20260717
LOG=/mnt/panshuainan/clawd/clawd_ash-main/logs/org2-validate-20260717-strict.log
IMAGE=org2-integration-validate:20260715
mkdir -p "$(dirname "$LOG")"
: > "$LOG"
run_step() {
  local name="$1"; shift
  echo "[$(date '+%F %T')] STEP START: $name" | tee -a "$LOG"
  "$@" >> "$LOG" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[$(date '+%F %T')] STEP FAIL: $name rc=$rc" | tee -a "$LOG"
    return "$rc"
  fi
  echo "[$(date '+%F %T')] STEP PASS: $name" | tee -a "$LOG"
}
cd "$ROOT"
run_step "git diff --check" git diff --check
run_step "docker tsc" docker run --rm -e CI=1 -e NO_AT_BRIDGE=1 -e NODE_OPTIONS=--max-old-space-size=8192 -v "$ROOT:/work" -w /work "$IMAGE" bash -lc 'set -euo pipefail; test -d node_modules || pnpm install --no-frozen-lockfile; pnpm exec tsc --noEmit'
run_step "docker cargo test slash" docker run --rm -e CI=1 -e NO_AT_BRIDGE=1 -v "$ROOT:/work" -w /work/src-tauri "$IMAGE" bash -lc 'set -euo pipefail; cargo test -p agent_core channel_handler::slash --lib'
run_step "docker cargo check agent_core" docker run --rm -e CI=1 -e NO_AT_BRIDGE=1 -v "$ROOT:/work" -w /work/src-tauri "$IMAGE" bash -lc 'set -euo pipefail; cargo check -p agent_core'
echo "[$(date '+%F %T')] STRICT VALIDATION PASSED" | tee -a "$LOG"
