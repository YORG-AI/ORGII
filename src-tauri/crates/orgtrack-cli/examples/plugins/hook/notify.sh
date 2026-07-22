#!/usr/bin/env bash
# Reference orgtrack action hook. Reads the firings JSON on stdin.
#   { "firings": [ { trigger, severity, scope, scopeKey, actual, limit, message }, ... ] }
# Runs with a scrubbed env (PATH/HOME only), CWD = this dir, no DB handle,
# and is killed if it exceeds --timeout.
set -euo pipefail
payload="$(cat)"
count="$(printf '%s' "$payload" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["firings"]))')"
# Replace this with your real action (curl a Slack webhook, notify-send, etc.):
echo "orgtrack: ${count} trigger(s) fired" >&2
# e.g. curl -sf -X POST -H 'Content-Type: application/json' \
#   -d "$payload" "$SLACK_WEBHOOK_URL"
