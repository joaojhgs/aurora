#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARTIFACT_DIR="${AURORA_HOSTED_PEER_ARTIFACT_DIR:-${AURORA_HOSTED_THIN_ARTIFACT_DIR:-$ROOT/reports/hosted-peer}}"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aurora-hosted-peer.XXXXXX")"
CONFIG_PATH="$RUNTIME_DIR/config.json"
DATA_DIR="$RUNTIME_DIR/data"
PYTHON_LOG="$ARTIFACT_DIR/python-service.log"
WEB_LOG="$ARTIFACT_DIR/web-ui.log"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aurora-hosted-peer-e2e}"
GATEWAY_PORT="${AURORA_HOSTED_PEER_GATEWAY_PORT:-${AURORA_HOSTED_THIN_GATEWAY_PORT:-$(python - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)}}"
WEB_PORT="${AURORA_HOSTED_PEER_WEB_PORT:-${AURORA_HOSTED_THIN_WEB_PORT:-$(python - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)}}"
BROKER_URL="${AURORA_HOSTED_PEER_BROKER_URL:-${AURORA_HOSTED_THIN_BROKER_URL:-ws://127.0.0.1:9001/mqtt}}"
MANAGE_INTEROP_SERVICES="${AURORA_HOSTED_PEER_MANAGE_INTEROP_SERVICES:-}"
if [[ -z "$MANAGE_INTEROP_SERVICES" ]]; then
  case "$BROKER_URL" in
    ws://127.0.0.1:9001/*|ws://localhost:9001/*)
      MANAGE_INTEROP_SERVICES=1
      ;;
    *)
      MANAGE_INTEROP_SERVICES=0
      ;;
  esac
fi
if [[ "$MANAGE_INTEROP_SERVICES" != "0" && "$MANAGE_INTEROP_SERVICES" != "1" ]]; then
  echo "AURORA_HOSTED_PEER_MANAGE_INTEROP_SERVICES must be '0' or '1'" >&2
  exit 64
fi
API_KEY="${AURORA_HOSTED_PEER_GATEWAY_API_KEY:-${AURORA_HOSTED_THIN_GATEWAY_API_KEY:-$(python - <<'PY'
import secrets
print("hosted-peer." + secrets.token_urlsafe(24))
PY
)}}"
TOKEN_SECRET="$(python - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"
ROOM_SECRET="$(python - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"
APP_ID="aurora-hosted-peer-$(python - <<'PY'
import secrets
print(secrets.token_hex(8))
PY
)"
ROOM="hosted-peer-room-$(python - <<'PY'
import secrets
print(secrets.token_hex(8))
PY
)"
PYTHON_PID=""
WEB_PID=""
HTTP_READY_TIMEOUT_SECONDS="${AURORA_LIVE_HTTP_READY_TIMEOUT_SECONDS:-180}"

mkdir -p "$ARTIFACT_DIR" "$DATA_DIR"

pnpm --filter @aurora/voice-web build
pnpm --filter @aurora/client build
NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK=1 \
  pnpm --filter @aurora/web build
WEB_STANDALONE_DIR="$ROOT/apps/aurora-web/.next/standalone/apps/aurora-web"
mkdir -p "$WEB_STANDALONE_DIR/.next/static" "$WEB_STANDALONE_DIR/public"
cp -R "$ROOT/apps/aurora-web/.next/static/." "$WEB_STANDALONE_DIR/.next/static/"
cp -R "$ROOT/apps/aurora-web/public/." "$WEB_STANDALONE_DIR/public/"

cleanup() {
  local status=$?
  if [[ -n "$WEB_PID" ]]; then
    kill -TERM -- "-$WEB_PID" 2>/dev/null || kill -TERM "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
  fi
  if [[ -n "$PYTHON_PID" ]]; then
    kill -TERM -- "-$PYTHON_PID" 2>/dev/null || kill -TERM "$PYTHON_PID" 2>/dev/null || true
    wait "$PYTHON_PID" 2>/dev/null || true
  fi
  if [[ "$MANAGE_INTEROP_SERVICES" == "1" ]]; then
    scripts/webrtc_interop_services.sh down >/dev/null 2>&1 || true
  fi
  python - "$RUNTIME_DIR" <<'PY'
import shutil
import sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PY
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_for_http() {
  local url="$1"
  local process_pid="$2"
  local process_log="$3"
  local label="$4"
  local deadline=$((SECONDS + HTTP_READY_TIMEOUT_SECONDS))

  while ((SECONDS < deadline)); do
    if curl --connect-timeout 1 --max-time 5 -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$process_pid" 2>/dev/null; then
      cat "$process_log" >&2
      wait "$process_pid"
      return 1
    fi
    sleep 0.5
  done

  echo "Timed out waiting for $label at $url" >&2
  cat "$process_log" >&2
  return 1
}

python - "$CONFIG_PATH" "$GATEWAY_PORT" "$APP_ID" "$ROOM" "$BROKER_URL" <<'PY'
import json
import sys
from pathlib import Path

config_path, gateway_port, app_id, room, broker = sys.argv[1:]
root = Path.cwd()
config = json.loads(
    (root / "app/services/config/config_defaults.json").read_text(encoding="utf-8")
)
services = config["services"]
config["ui"]["activate"] = False
services["auth"]["enabled"] = True
services["auth"]["webrtc_auth_timeout_seconds"] = 30.0
services["auth"]["webrtc_pairing_timeout_seconds"] = 120.0
services["db"]["enabled"] = True
services["db"]["embeddings"]["use_local"] = False
services["orchestrator"]["enabled"] = False
services["tooling"]["enabled"] = False
services["scheduler"]["enabled"] = False
gateway = services["gateway"]
gateway["enabled"] = True
gateway["api"]["host"] = "127.0.0.1"
gateway["api"]["port"] = int(gateway_port)
gateway["mesh_network"]["enabled"] = True
gateway["mesh_network"]["node_name"] = "Hosted Peer E2E Python"
gateway["webrtc"].update(
    {
        "enabled": True,
        "strategy": "mqtt",
        "app_id": app_id,
        "room": room,
        "encrypt_signaling": True,
        "enable_app_layer_e2ee": True,
        "legacy_event_broadcast": False,
        "stun_servers": [],
        "turn_servers": [],
    }
)
gateway["signaling_mqtt"]["brokers"] = [broker]
gateway["signaling_mqtt"]["topic_root"] = "aurora"
Path(config_path).write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
PY

if [[ "$MANAGE_INTEROP_SERVICES" == "1" ]]; then
  scripts/webrtc_interop_services.sh up
fi

setsid env \
  AURORA_ARCHITECTURE_MODE=threads \
  AURORA_CONFIG_FILE="$CONFIG_PATH" \
  AURORA_DATA_DIR="$DATA_DIR" \
  AURORA_TOKEN_SECRET="$TOKEN_SECRET" \
  AURORA_WEBRTC_PASSWORD="$ROOM_SECRET" \
  AURORA_GATEWAY_API_KEYS="$API_KEY" \
  AURORA_UI_ACTIVATE=false \
  PYTHONUNBUFFERED=1 \
  uv run python main.py >"$PYTHON_LOG" 2>&1 &
PYTHON_PID=$!

wait_for_http \
  "http://127.0.0.1:$GATEWAY_PORT/api/health" \
  "$PYTHON_PID" \
  "$PYTHON_LOG" \
  "Python gateway"

setsid env \
  NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK=1 \
  HOSTNAME=127.0.0.1 \
  PORT="$WEB_PORT" \
  node "$WEB_STANDALONE_DIR/server.js" >"$WEB_LOG" 2>&1 &
WEB_PID=$!

wait_for_http \
  "http://127.0.0.1:$WEB_PORT/" \
  "$WEB_PID" \
  "$WEB_LOG" \
  "hosted web UI"

AURORA_HOSTED_PEER_BASE_URL="http://127.0.0.1:$WEB_PORT" \
AURORA_HOSTED_PEER_GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT" \
AURORA_HOSTED_PEER_GATEWAY_API_KEY="$API_KEY" \
AURORA_HOSTED_PEER_BROKER_URL="$BROKER_URL" \
AURORA_HOSTED_PEER_EXPECTED_NODE="Hosted Peer E2E Python" \
AURORA_HOSTED_PEER_ARTIFACT_DIR="$ARTIFACT_DIR" \
  pnpm exec playwright test \
    --config tests/e2e/hosted_peer/playwright.config.ts \
    --project chromium
