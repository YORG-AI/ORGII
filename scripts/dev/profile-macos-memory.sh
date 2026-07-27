#!/bin/bash

set -euo pipefail

readonly DEFAULT_DURATION="2m"
readonly DEFAULT_TEMPLATE="Allocations"
readonly DEFAULT_OUTPUT_DIR="${TMPDIR:-/tmp}/orgii-instruments"

TARGET_PID="${ORGII_INSTRUMENTS_PID:-}"
DURATION="${ORGII_INSTRUMENTS_DURATION:-${DEFAULT_DURATION}}"
TEMPLATE="${ORGII_INSTRUMENTS_TEMPLATE:-${DEFAULT_TEMPLATE}}"
OUTPUT_PATH="${ORGII_INSTRUMENTS_OUTPUT:-}"

show_help() {
    cat <<'EOF'
Profile the native ORGII backend with macOS Instruments.

Start ORGII normally first, then run:
  ./scripts/dev/profile-macos-memory.sh

Options:
  --pid PID                 Attach to this org2 process instead of auto-detecting.
  --duration TIME           Recording limit, such as 30s, 2m, or 1h (default: 2m).
  --template NAME           Allocations or Leaks (default: Allocations).
  --output PATH.trace       Explicit trace output path.
  --help, -h                Show this help.

Environment equivalents:
  ORGII_INSTRUMENTS_PID
  ORGII_INSTRUMENTS_DURATION
  ORGII_INSTRUMENTS_TEMPLATE
  ORGII_INSTRUMENTS_OUTPUT
EOF
}

fail() {
    echo "Error: $*" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pid)
            [[ $# -ge 2 ]] || fail "--pid requires a value"
            TARGET_PID="$2"
            shift 2
            ;;
        --duration)
            [[ $# -ge 2 ]] || fail "--duration requires a value"
            DURATION="$2"
            shift 2
            ;;
        --template)
            [[ $# -ge 2 ]] || fail "--template requires a value"
            TEMPLATE="$2"
            shift 2
            ;;
        --output)
            [[ $# -ge 2 ]] || fail "--output requires a value"
            OUTPUT_PATH="$2"
            shift 2
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            fail "unknown option: $1 (run with --help for usage)"
            ;;
    esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail "this profiler requires macOS"
command -v xcrun >/dev/null 2>&1 || fail "xcrun was not found; install Xcode command-line tools"
[[ "${DURATION}" =~ ^[1-9][0-9]*(ms|s|m|h)$ ]] \
    || fail "duration must be a positive value with ms, s, m, or h suffix"

case "${TEMPLATE}" in
    Allocations)
        TEMPLATE_SLUG="allocations"
        ;;
    Leaks)
        TEMPLATE_SLUG="leaks"
        ;;
    *) fail "template must be Allocations or Leaks" ;;
esac

if [[ -z "${TARGET_PID}" ]]; then
    MATCHING_PIDS=()
    while IFS= read -r matching_pid; do
        MATCHING_PIDS+=("${matching_pid}")
    done < <(
        {
            pgrep -x org2 2>/dev/null || true
            pgrep -x ORG2 2>/dev/null || true
        } | sort -nu
    )

    case "${#MATCHING_PIDS[@]}" in
        0)
            fail "no running ORGII backend found; start ORGII normally, then rerun this script"
            ;;
        1)
            TARGET_PID="${MATCHING_PIDS[0]}"
            ;;
        *)
            echo "Multiple ORGII backend processes are running:" >&2
            ps -p "$(IFS=,; echo "${MATCHING_PIDS[*]}")" -o pid=,etime=,command= >&2 || true
            fail "choose one explicitly with --pid PID"
            ;;
    esac
fi

[[ "${TARGET_PID}" =~ ^[1-9][0-9]*$ ]] || fail "PID must be a positive integer"
kill -0 "${TARGET_PID}" 2>/dev/null || fail "PID ${TARGET_PID} is not running or is not accessible"

if [[ -z "${OUTPUT_PATH}" ]]; then
    readonly OUTPUT_DIR="${ORGII_INSTRUMENTS_DIR:-${DEFAULT_OUTPUT_DIR}}"
    mkdir -p "${OUTPUT_DIR}"
    OUTPUT_PATH="${OUTPUT_DIR}/orgii-${TEMPLATE_SLUG}-$(date '+%Y%m%d-%H%M%S')-${TARGET_PID}.trace"
else
    [[ "${OUTPUT_PATH}" == *.trace ]] || fail "output path must end in .trace"
    mkdir -p "$(dirname -- "${OUTPUT_PATH}")"
fi

[[ ! -e "${OUTPUT_PATH}" ]] || fail "output already exists: ${OUTPUT_PATH}"

echo "Recording ORGII native memory with Instruments..."
echo "  PID:      ${TARGET_PID}"
echo "  Template: ${TEMPLATE}"
echo "  Duration: ${DURATION}"
echo "  Output:   ${OUTPUT_PATH}"
echo "Exercise one controlled workload in ORGII now. The app remains running when recording ends."

if ! xcrun xctrace record \
    --template "${TEMPLATE}" \
    --attach "${TARGET_PID}" \
    --time-limit "${DURATION}" \
    --output "${OUTPUT_PATH}"; then
    echo "Instruments could not attach to PID ${TARGET_PID}." >&2
    echo "Enable your terminal in System Settings → Privacy & Security → Developer Tools, restart the terminal, and retry." >&2
    exit 1
fi

[[ -e "${OUTPUT_PATH}" ]] || fail "Instruments finished without creating ${OUTPUT_PATH}"

echo "Instruments trace saved: ${OUTPUT_PATH}"
echo "Open it with: open \"${OUTPUT_PATH}\""
