#!/usr/bin/env bash
set -euo pipefail
source /home/algo/org2-container-env.sh
export PATH="/home/algo/.nvm/versions/node/v22.22.0/bin:$HOME/.cargo/bin:$PATH"
WORKDIR="${ORGII_WORKDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export DISPLAY="${DISPLAY:-:99}"
export GDK_BACKEND="${GDK_BACKEND:-x11}"
export NO_AT_BRIDGE="${NO_AT_BRIDGE:-1}"
export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-root}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  # Clean stale X lock/socket left over from a previous container run:
  # Xvfb refuses to start if the lock exists even when no server is alive.
  if ! pgrep -x Xvfb >/dev/null; then
    DNUM="${DISPLAY#:}"
    rm -f "/tmp/.X${DNUM}-lock" "/tmp/.X11-unix/X${DNUM}"
  fi
  Xvfb "$DISPLAY" -screen 0 1680x1050x24 >/tmp/xvfb.log 2>&1 &
  sleep 3
fi

start_vnc_stack() {
  if ! pgrep -fa "x11vnc .*${DISPLAY}" >/dev/null; then
    setsid nohup x11vnc -display "$DISPLAY" -forever -shared -nopw -listen 0.0.0.0 -rfbport 5900 -xkb >/tmp/x11vnc.log 2>&1 < /dev/null &
  fi
  if ! pgrep -fa "websockify .*6080" >/dev/null; then
    setsid nohup websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 >/tmp/websockify.log 2>&1 < /dev/null &
  fi
}
start_vnc_stack
cd "$WORKDIR"
ORGII_LIGHT_DEV=true FAST_DEV=true DEV_SOURCEMAPS=false node scripts/dev/webpack-server.js >/tmp/devserver.log 2>&1 &
for i in $(seq 1 80); do
  curl -sf http://localhost:1998/ >/dev/null 2>&1 && { echo 'dev server UP'; break; }
  sleep 3
done
tail -20 /tmp/devserver.log || true
cd "$WORKDIR/src-tauri"
if [ ! -x ./target/debug/org2 ]; then
  echo 'building org2 binary'
  cargo build -p org2
fi
source /home/algo/org2-container-env.sh
export PATH="/home/algo/.nvm/versions/node/v22.22.0/bin:$HOME/.cargo/bin:$PATH"
WORKDIR="${ORGII_WORKDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export DISPLAY="${DISPLAY:-:99}"
export GDK_BACKEND="${GDK_BACKEND:-x11}"
export NO_AT_BRIDGE="${NO_AT_BRIDGE:-1}"
export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-root}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
start_backend() {
  setsid nohup ./target/debug/org2 >/tmp/org2.log 2>&1 < /dev/null &
  echo "org2_pid=$!"
}
start_backend
for i in $(seq 1 120); do
  curl -sf http://127.0.0.1:13847/agent/health >/dev/null 2>&1 && { echo agent API UP; break; }
  sleep 3
done
tail -120 /tmp/org2.log || true
while true; do
  start_vnc_stack
  if ! curl -sf http://127.0.0.1:13847/agent/health >/dev/null 2>&1; then
    echo "agent API DOWN; restarting org2"
    pkill -f "$WORKDIR/src-tauri/target/debug/org2" 2>/dev/null || true
    start_backend
    sleep 10
  fi
  sleep 15
done
