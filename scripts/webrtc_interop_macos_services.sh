#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-up}"
RUNTIME_DIR="${WEBRTC_INTEROP_MACOS_RUNTIME_DIR:-${TMPDIR:-/tmp}/aurora-webrtc-interop-macos}"
MOSQUITTO_CONF="$RUNTIME_DIR/mosquitto.conf"
MOSQUITTO_LOG="$RUNTIME_DIR/mosquitto.log"
MOSQUITTO_PID="$RUNTIME_DIR/mosquitto.pid"
TURN_CONF="$RUNTIME_DIR/turnserver.conf"
TURN_LOG="$RUNTIME_DIR/turnserver.log"
TURN_PID="$RUNTIME_DIR/turnserver.pid"

wait_for_tcp() {
  local name="$1"
  local port="$2"
  local attempts="${3:-100}"
  for _ in $(seq 1 "$attempts"); do
    if python - "$port" <<'PY'
import socket
import sys

with socket.socket() as sock:
    sock.settimeout(0.2)
    raise SystemExit(sock.connect_ex(("127.0.0.1", int(sys.argv[1]))) != 0)
PY
    then
      return 0
    fi
    sleep 0.1
  done
  echo "$name did not become ready on 127.0.0.1:$port" >&2
  return 1
}

stop_pid() {
  local file="$1"
  if [[ -s "$file" ]]; then
    local pid
    pid="$(cat "$file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  fi
}

case "$ACTION" in
  up)
    command -v python >/dev/null || { echo "python is required for readiness checks" >&2; exit 127; }
    command -v mosquitto >/dev/null || { echo "mosquitto is required; install it with brew install mosquitto" >&2; exit 127; }
    command -v turnserver >/dev/null || { echo "turnserver is required; install coturn with brew install coturn" >&2; exit 127; }
    "$0" down >/dev/null 2>&1 || true
    mkdir -p "$RUNTIME_DIR"
    cat > "$MOSQUITTO_CONF" <<'MOSQ'
per_listener_settings false
allow_anonymous true
listener 1883 127.0.0.1
protocol mqtt
listener 9001 127.0.0.1
protocol websockets
MOSQ
    cat > "$TURN_CONF" <<'TURN'
listening-port=3478
listening-ip=0.0.0.0
fingerprint
lt-cred-mech
user=interop:interop
realm=aurora-interop.test
no-tls
no-dtls
verbose
TURN
    mosquitto -c "$MOSQUITTO_CONF" >"$MOSQUITTO_LOG" 2>&1 &
    echo "$!" > "$MOSQUITTO_PID"
    turnserver -c "$TURN_CONF" >"$TURN_LOG" 2>&1 &
    echo "$!" > "$TURN_PID"
    wait_for_tcp webrtc-interop-mqtt 9001
    wait_for_tcp webrtc-interop-turn 3478
    ;;
  down)
    stop_pid "$MOSQUITTO_PID"
    stop_pid "$TURN_PID"
    rm -f "$MOSQUITTO_PID" "$TURN_PID"
    ;;
  logs)
    [[ -f "$MOSQUITTO_LOG" ]] && cat "$MOSQUITTO_LOG"
    [[ -f "$TURN_LOG" ]] && cat "$TURN_LOG"
    ;;
  *) echo "usage: $0 {up|down|logs}" >&2; exit 64 ;;
esac
