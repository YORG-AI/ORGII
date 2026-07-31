#!/usr/bin/env bash
set -euo pipefail
SRC=/mnt/panshuainan/org2-journey-context-viz-20260729
DEPS=/mnt/panshuainan/org2-unified-20260724/node_modules
OUT="$SRC/.ash-reports/build-journey-superset-20260730"
TARGET="$OUT/target"
LOG="$OUT/build.log"
STATUS="$OUT/build.status"
mkdir -p "$OUT" "$TARGET"
STARTED=$(date -Is)
COMMIT=$(git -C "$SRC" rev-parse HEAD)
write_failure() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'result=failed\nfailed=%s\nexit_code=%s\ncommit=%s\nmode=docker-safe-6g-1job\n' \
      "$(date -Is)" "$rc" "$COMMIT" > "$STATUS"
  fi
}
trap write_failure EXIT
printf 'result=running\nstarted=%s\nsource=%s\ncommit=%s\nmode=docker-safe-6g-1job\nmem_limit=6g\nmem_swap_limit=8g\ncargo_jobs=1\ncpus=2\n' \
  "$STARTED" "$SRC" "$COMMIT" > "$STATUS"
exec > >(tee -a "$LOG") 2>&1
echo "started=$STARTED commit=$COMMIT"
MEM_AVAIL_KB=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
SWAP_FREE_KB=$(awk '/SwapFree:/ {print $2}' /proc/meminfo)
echo "preflight MemAvailable_kB=$MEM_AVAIL_KB SwapFree_kB=$SWAP_FREE_KB"
[ "$MEM_AVAIL_KB" -ge 5242880 ]
[ "$SWAP_FREE_KB" -ge 1048576 ]
grep -q 'layoutStoryline' "$SRC/src/modules/ProjectManager/JourneyGraph/timelineLayout.ts"
grep -q 'session-journey' "$SRC/src/store/workstation/tabs/factories/project.ts"
grep -q 'journeyStationSelectionAtom' "$SRC/src/store/ui/journeyStationAtom.ts"
grep -q 'workstation/journey' "$SRC/src/router/routes/routeGroups.tsx"
CONTAINER="org2-journey-build-$(date +%Y%m%d-%H%M%S)"
docker run --rm --name "$CONTAINER" \
  --memory=6g --memory-swap=8g --memory-swappiness=10 --cpus=2 \
  -e CI=true \
  -e NODE_OPTIONS='--max-old-space-size=4096' \
  -e CARGO_BUILD_JOBS=1 -e CARGO_INCREMENTAL=0 -e CARGO_TARGET_DIR=/out/target \
  -e CARGO_PROFILE_RELEASE_LTO=false -e CARGO_PROFILE_RELEASE_CODEGEN_UNITS=64 \
  -e CARGO_PROFILE_RELEASE_OPT_LEVEL=2 -e CARGO_PROFILE_RELEASE_STRIP=true \
  -e CARGO_PROFILE_RELEASE_DEBUG=false -e RUSTFLAGS='-C debuginfo=0' \
  -v "$SRC:/work" -v "$DEPS:/work/node_modules" -v "$TARGET:/out/target" \
  -w /work org2-build:22.04-xdg \
  bash -lc '
    set -euo pipefail
    export PATH="/root/.cargo/bin:$PATH"
    echo "[1/4] focused journey tests (P1/P2/D3 + D1/D2)"
    node_modules/.bin/vitest run \
      src/modules/ProjectManager/JourneyGraph/__tests__/journeyGraph.test.ts \
      src/modules/ProjectManager/JourneyGraph/__tests__/viewModel.p2.test.ts \
      src/modules/ProjectManager/JourneyGraph/__tests__/components.p2.test.ts \
      src/modules/ProjectManager/JourneyGraph/__tests__/timelineLayout.test.ts \
      src/store/workstation/tabs/__tests__/sessionJourneyTab.test.ts \
      src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/menuSelection.test.ts
    echo "[2/4] frontend production rebuild"
    rm -rf build node_modules/.cache
    node_modules/.bin/webpack --mode production
    test -f build/index.html
    for marker in journey-station session-journey storyline-curve workstation/journey; do
      grep -R -q "$marker" build --include="*.js"; echo "marker-ok=$marker"
    done
    echo "[3/4] force application package rebuild"
    cd src-tauri && cargo clean -p org2 --release && cd ..
    echo "[4/4] Tauri production custom-protocol build"
    node_modules/.bin/tauri build --no-bundle --ci \
      --config "{\"build\":{\"beforeBuildCommand\":\"\"},\"bundle\":{\"active\":false,\"createUpdaterArtifacts\":false}}"
    test -x /out/target/release/org2
    ls -lah /out/target/release/org2
  '
BIN="$TARGET/release/org2"
python3 - "$TARGET" <<'PY'
from pathlib import Path
import json, sys
root=Path(sys.argv[1])/'release'/'.fingerprint'
found=[]
for p in root.glob('tauri-*/*.json'):
    try: d=json.loads(p.read_text())
    except Exception: continue
    if 'custom-protocol' in (d.get('features') or []): found.append(str(p))
if not found: raise SystemExit('custom-protocol missing')
print('custom-protocol-ok',len(found))
PY
if ldd "$BIN" | grep -F 'not found'; then echo 'unresolved dynamic libraries' >&2; exit 9; fi
if strings "$BIN" | grep -q 'http://localhost:1998/index.html'; then echo 'ERROR: dev webview binary' >&2; exit 8; fi
SHA=$(sha256sum "$BIN" | awk '{print $1}')
printf 'result=success\nfinished=%s\ncommit=%s\nsha256=%s\nartifact=%s\nmode=docker-safe-6g-1job\n' \
  "$(date -Is)" "$COMMIT" "$SHA" "$BIN" > "$STATUS"
echo "SUCCESS sha256=$SHA artifact=$BIN"
trap - EXIT
