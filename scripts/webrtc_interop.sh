#!/usr/bin/env bash
set -euo pipefail

LANE="${1:-direct}"
BROWSER="${WEBRTC_INTEROP_BROWSER:-chromium}"
ARTIFACT_ROOT="${WEBRTC_INTEROP_ARTIFACT_DIR:-reports/webrtc-interop/$LANE}"
mkdir -p "$ARTIFACT_ROOT"
READY="$ARTIFACT_ROOT/gateway-ready.json"
DONE="$ARTIFACT_ROOT/browser-done.json"
PY_REPORT="$ARTIFACT_ROOT/python-gateway-report.json"
BROWSER_REPORT="$ARTIFACT_ROOT/browser-report.json"
FINAL_REPORT="$ARTIFACT_ROOT/report.json"
rm -f "$READY" "$DONE" "$PY_REPORT" "$BROWSER_REPORT" "$FINAL_REPORT"

export WEBRTC_INTEROP_ROOM_SECRET="${WEBRTC_INTEROP_ROOM_SECRET:-$(python - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)}"
export WEBRTC_INTEROP_TOKEN="${WEBRTC_INTEROP_TOKEN:-$(python - <<'PY'
import secrets
print('g009.' + secrets.token_urlsafe(24))
PY
)}"

BROKER="${WEBRTC_INTEROP_BROKER:-ws://127.0.0.1:9001/mqtt}"
ROOM="${WEBRTC_INTEROP_ROOM:-g009-live-interop-$LANE-$$}"
STUN_ARGS=()
TURN_ARGS=()
interop_host_ipv4() {
  python - <<'PY'
import ipaddress
import socket

with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
    # UDP connect performs route selection without transmitting application data.
    sock.connect(("192.0.2.1", 9))
    address = sock.getsockname()[0]

parsed = ipaddress.ip_address(address)
if parsed.is_loopback or parsed.is_unspecified:
    raise SystemExit("WebRTC STUN/TURN interop requires a non-loopback host IPv4 address")
print(address)
PY
}
case "$LANE" in
  direct)
    ;;
  stun)
    if [[ -n "${WEBRTC_INTEROP_STUN:-}" ]]; then
      STUN_URL="$WEBRTC_INTEROP_STUN"
    else
      STUN_URL="stun:$(interop_host_ipv4):3478"
    fi
    STUN_ARGS+=(--stun "$STUN_URL")
    ;;
  turn)
    if [[ -n "${WEBRTC_INTEROP_TURN:-}" ]]; then
      TURN_URL="$WEBRTC_INTEROP_TURN"
    elif [[ "$BROWSER" == "firefox" ]]; then
      TURN_URL="turn:$(interop_host_ipv4):3478?transport=udp"
    else
      TURN_URL="turn:127.0.0.1:3478?transport=udp"
    fi
    TURN_ARGS+=(--turn "$TURN_URL")
    ;;
  *)
    echo "Unsupported lane: $LANE" >&2
    exit 64
    ;;
esac

if ! command -v pnpm >/dev/null; then echo "pnpm is required" >&2; exit 127; fi
if ! command -v python >/dev/null; then echo "python is required" >&2; exit 127; fi

uv run python scripts/webrtc_interop_gateway.py \
  --lane "$LANE" \
  --ready "$READY" \
  --done "$DONE" \
  --report "$PY_REPORT" \
  --broker "$BROKER" \
  --room "$ROOM" \
  "${STUN_ARGS[@]}" "${TURN_ARGS[@]}" &
PY_PID=$!
cleanup() {
  kill "$PY_PID" 2>/dev/null || true
  wait "$PY_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 200); do
  [[ -s "$READY" ]] && break
  if ! kill -0 "$PY_PID" 2>/dev/null; then wait "$PY_PID"; exit $?; fi
  sleep 0.1
done
[[ -s "$READY" ]] || { echo "Gateway readiness timed out" >&2; exit 1; }

node scripts/webrtc_interop_browser.mjs \
  --lane "$LANE" \
  --browser "$BROWSER" \
  --ready "$READY" \
  --done "$DONE" \
  --report "$BROWSER_REPORT" \
  --artifact-dir "$ARTIFACT_ROOT"

wait "$PY_PID" || PY_STATUS=$?
PY_STATUS=${PY_STATUS:-0}

python scripts/webrtc_interop_scan.py --artifact-dir "$ARTIFACT_ROOT" --python-report "$PY_REPORT" --browser-report "$BROWSER_REPORT" --out "$FINAL_REPORT" --lane "$LANE"
exit "$PY_STATUS"
