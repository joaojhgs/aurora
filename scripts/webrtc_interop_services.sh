#!/usr/bin/env bash
set -euo pipefail
ACTION="${1:-up}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aurora-webrtc-interop}"
COMPOSE=(docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.webrtc-interop.yml)

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
  "${COMPOSE[@]}" logs --no-color "$name" >&2 || true
  return 1
}

case "$ACTION" in
  up)
    if ! command -v docker >/dev/null; then echo "docker is required for live WebRTC interop services" >&2; exit 127; fi
    if ! command -v python >/dev/null; then echo "python is required for live WebRTC interop readiness checks" >&2; exit 127; fi
    "${COMPOSE[@]}" up -d webrtc-interop-mqtt webrtc-interop-turn
    wait_for_tcp webrtc-interop-mqtt 9001
    wait_for_tcp webrtc-interop-turn 3478
    ;;
  down)
    "${COMPOSE[@]}" down -v --remove-orphans
    ;;
  logs)
    "${COMPOSE[@]}" logs --no-color webrtc-interop-mqtt webrtc-interop-turn
    ;;
  *) echo "usage: $0 {up|down|logs}" >&2; exit 64 ;;
esac
