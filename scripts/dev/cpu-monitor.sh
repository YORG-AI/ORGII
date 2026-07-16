#!/bin/bash

###############################################################################
# ORG2 Dev CPU Monitor
#
# One-click CPU monitoring for local `pnpm run tauri:dev` sessions.
# Tracks the Rust backend (org2), webpack dev server (ORG2 Dev), and
# WebKit/WebView helper processes.
#
# Usage:
#   ./scripts/dev/cpu-monitor.sh                 # live refresh (default)
#   ./scripts/dev/cpu-monitor.sh --live
#   ./scripts/dev/cpu-monitor.sh --sample          # 10-min sample #1
#   ./scripts/dev/cpu-monitor.sh --sample 1
#   ./scripts/dev/cpu-monitor.sh --sample 2      # second 10-min sample
#   ./scripts/dev/cpu-monitor.sh --help
#
# npm:
#   pnpm run dev:cpu-monitor
#   pnpm run dev:cpu-monitor -- --sample 1
###############################################################################

set -euo pipefail

# Process name / command patterns for ORG2 dev stack (macOS Activity Monitor names).
readonly PROCESS_PATTERN='org2|ORG2 Dev|WebContent|WebKit|GPU|Network'
readonly LIVE_INTERVAL_SEC=2
readonly SAMPLE_INTERVAL_SEC=5
readonly SAMPLE_ITERATIONS=120
readonly SAMPLE_DIR="${HOME}/org2-cpu-samples"

show_help() {
    cat <<'EOF'
ORG2 Dev CPU Monitor

Monitor CPU usage for local ORG2 development processes:
  org2          Tauri/Rust backend
  ORG2 Dev      webpack dev server (port 1998)
  WebContent    WebView rendering
  WebKit/GPU/Network  WebView helpers

Modes:
  --live              Refresh every 2s (default)
  --sample [N]        10-minute sample to ~/org2-cpu-samples/sampleN-<timestamp>.log
                      (every 5s, 120 iterations). N defaults to 1; use 2 for a second run.
  --help, -h          Show this help

Examples:
  pnpm run dev:cpu-monitor
  pnpm run dev:cpu-monitor -- --sample 1
  pnpm run dev:cpu-monitor -- --sample 2

Output columns: PID  %CPU  %MEM  ELAPSED  COMMAND
EOF
}

# Collect matching processes. Writes timestamped block to stdout.
collect_snapshot() {
    local timestamp
    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "--- ${timestamp} ---"
    # shellcheck disable=SC2009
    ps -ax -o pid,%cpu,%mem,etime,command \
        | grep -E "${PROCESS_PATTERN}" \
        | grep -v grep \
        || true
}

run_live() {
    echo "ORG2 Dev CPU monitor (live, refresh every ${LIVE_INTERVAL_SEC}s). Press Ctrl+C to stop."
    echo "Matching: ${PROCESS_PATTERN}"
    echo ""

    while true; do
        clear
        echo "ORG2 Dev CPU — $(date '+%Y-%m-%d %H:%M:%S')"
        echo "PID    %CPU  %MEM  ELAPSED  COMMAND"
        echo "────────────────────────────────────────────────────────────────"
        collect_snapshot | tail -n +2
        sleep "${LIVE_INTERVAL_SEC}"
    done
}

# Print average %CPU per command from a sample log (awk one-liner style).
print_sample_summary() {
    local log_file="$1"

    echo ""
    echo "Average %CPU by process (${log_file}):"
    awk '
        /^---/ { next }
        /^[[:space:]]*[0-9]+/ {
            cpu = $2 + 0
            cmd = $5
            for (i = 6; i <= NF; i++) {
                cmd = cmd " " $i
            }
            cpu_sum[cmd] += cpu
            count[cmd]++
        }
        END {
            if (length(cpu_sum) == 0) {
                print "  (no matching processes recorded)"
                exit
            }
            n = 0
            for (cmd in cpu_sum) {
                avg[n] = cpu_sum[cmd] / count[cmd]
                names[n] = cmd
                samples[n] = count[cmd]
                n++
            }
            for (i = 0; i < n - 1; i++) {
                for (j = i + 1; j < n; j++) {
                    if (avg[j] > avg[i]) {
                        tmp = avg[i]; avg[i] = avg[j]; avg[j] = tmp
                        tmp = names[i]; names[i] = names[j]; names[j] = tmp
                        tmp = samples[i]; samples[i] = samples[j]; samples[j] = tmp
                    }
                }
            }
            for (i = 0; i < n; i++) {
                printf "  %6.1f%%  (%3d samples)  %s\n", avg[i], samples[i], names[i]
            }
        }
    ' "${log_file}"
}

run_sample() {
    local sample_num="$1"
    local out_file
    local iteration

    mkdir -p "${SAMPLE_DIR}"
    out_file="${SAMPLE_DIR}/sample${sample_num}-$(date +%Y%m%d-%H%M%S).log"

    echo "ORG2 Dev CPU sample #${sample_num}"
    echo "  Duration:   $(( SAMPLE_ITERATIONS * SAMPLE_INTERVAL_SEC / 60 )) minutes"
    echo "  Interval:   ${SAMPLE_INTERVAL_SEC}s (${SAMPLE_ITERATIONS} iterations)"
    echo "  Output:     ${out_file}"
    echo "  Matching:   ${PROCESS_PATTERN}"
    echo ""
    echo "Reproduce the workload now. Press Ctrl+C to stop early."
    echo ""

    {
        echo "# ORG2 Dev CPU sample #${sample_num}"
        echo "# Started: $(date '+%Y-%m-%d %H:%M:%S')"
        echo "# Interval: ${SAMPLE_INTERVAL_SEC}s x ${SAMPLE_ITERATIONS}"
        echo "# Columns: PID %CPU %MEM ELAPSED COMMAND"
        echo ""
    } > "${out_file}"

    for (( iteration = 1; iteration <= SAMPLE_ITERATIONS; iteration++ )); do
        collect_snapshot >> "${out_file}"
        echo "" >> "${out_file}"

        if (( iteration % 12 == 0 )); then
            echo "  … ${iteration}/${SAMPLE_ITERATIONS} ($(date '+%H:%M:%S'))"
        fi

        if (( iteration < SAMPLE_ITERATIONS )); then
            sleep "${SAMPLE_INTERVAL_SEC}"
        fi
    done

    {
        echo "# Finished: $(date '+%Y-%m-%d %H:%M:%S')"
    } >> "${out_file}"

    echo ""
    echo "Saved: ${out_file}"
    print_sample_summary "${out_file}"
}

MODE="live"
SAMPLE_NUM="1"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            show_help
            exit 0
            ;;
        --)
            # pnpm forwards a bare `--` arg separator; ignore it.
            shift
            ;;
        --live)
            MODE="live"
            shift
            ;;
        --sample)
            MODE="sample"
            if [[ "${2:-}" =~ ^[12]$ ]]; then
                SAMPLE_NUM="$2"
                shift 2
            else
                SAMPLE_NUM="1"
                shift
            fi
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Run with --help for usage." >&2
            exit 1
            ;;
    esac
done

case "${MODE}" in
    live)
        run_live
        ;;
    sample)
        run_sample "${SAMPLE_NUM}"
        ;;
esac
