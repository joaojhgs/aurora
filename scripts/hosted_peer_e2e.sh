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
LIVE_SHELL_ACCEPTANCE="${AURORA_HOSTED_PEER_LIVE_SHELL_ACCEPTANCE:-0}"
LLAMA_CPP_MODEL_PATH="${AURORA_HOSTED_PEER_LLAMA_CPP_MODEL_PATH:-${AURORA_LLAMA_CPP_MODEL_PATH:-}}"
TEST_CONTROL_PORT="${AURORA_HOSTED_PEER_TEST_CONTROL_PORT:-}"
TEST_HOOK_DIR="$RUNTIME_DIR/test-hooks"

if [[ "$LIVE_SHELL_ACCEPTANCE" != "0" && "$LIVE_SHELL_ACCEPTANCE" != "1" ]]; then
  echo "AURORA_HOSTED_PEER_LIVE_SHELL_ACCEPTANCE must be '0' or '1'" >&2
  exit 64
fi
if [[ "$LIVE_SHELL_ACCEPTANCE" == "1" ]]; then
  if [[ -z "$LLAMA_CPP_MODEL_PATH" ]]; then
    echo "Set AURORA_HOSTED_PEER_LLAMA_CPP_MODEL_PATH=/absolute/path/to/local.gguf before running PER-278 live shell acceptance." >&2
    echo "The opt-in live-shell lane starts the real OrchestratorService with llama.cpp; it does not use a mock assistant." >&2
    exit 64
  fi
  if [[ ! -f "$LLAMA_CPP_MODEL_PATH" ]]; then
    echo "AURORA_HOSTED_PEER_LLAMA_CPP_MODEL_PATH does not point to a readable GGUF file: $LLAMA_CPP_MODEL_PATH" >&2
    exit 64
  fi
  if [[ -z "$TEST_CONTROL_PORT" ]]; then
    TEST_CONTROL_PORT="$(python - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
  fi
fi

mkdir -p "$ARTIFACT_DIR" "$DATA_DIR"

pnpm --filter @aurora/voice-web build
pnpm --filter @aurora/client build
NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK=1 \
NEXT_PUBLIC_AURORA_HOSTED_PEER_TEST=1 \
  pnpm --filter @aurora/web exec next build --webpack
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
  # Keep the Python/Web service output in the parent harness log as well as
  # the artifact files, because the temporary runtime and its logs are often
  # collected only through this script's stdout.
  if [[ -f "$PYTHON_LOG" ]]; then
    echo "hosted peer python service log retained: path=$PYTHON_LOG bytes=$(wc -c <"$PYTHON_LOG")"
  fi
  if [[ -f "$WEB_LOG" ]]; then
    echo "hosted peer web service log retained: path=$WEB_LOG bytes=$(wc -c <"$WEB_LOG")"
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
  local dump_signal="${5:-}"
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
  if [[ -r "/proc/$process_pid/wchan" ]]; then
    echo "${label} process wait channel: $(cat "/proc/$process_pid/wchan")" >&2
  fi
  if [[ -L "/proc/$process_pid/cwd" ]]; then
    echo "${label} process cwd: $(readlink "/proc/$process_pid/cwd")" >&2
  fi
  if [[ "$dump_signal" == "USR1" ]]; then
    echo "Requesting Python thread dump from $label process pid=$process_pid" >&2
    if kill -USR1 "$process_pid" 2>/dev/null; then
      sleep 1
    fi
  fi
  cat "$process_log" >&2
  return 1
}

python - "$CONFIG_PATH" "$GATEWAY_PORT" "$APP_ID" "$ROOM" "$BROKER_URL" "$LIVE_SHELL_ACCEPTANCE" "$LLAMA_CPP_MODEL_PATH" <<'PY'
import json
import sys
from pathlib import Path

config_path, gateway_port, app_id, room, broker, live_shell_acceptance, llama_model_path = sys.argv[1:]
enable_orchestrator = live_shell_acceptance == "1"
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
services["orchestrator"]["enabled"] = enable_orchestrator
if enable_orchestrator:
    # The hosted browser is a remote consumer of this real assistant.  Keep
    # the provider export enabled so its Orchestrator.Response subscription and
    # inference route are authorized by the same mesh projection.
    services["orchestrator"]["mesh_sharing"]["share"] = True
    services["orchestrator"]["llm"]["provider"] = "llama_cpp"
    services["orchestrator"]["llm"].setdefault("local", {})
    services["orchestrator"]["llm"]["local"].setdefault("llama_cpp", {})
    services["orchestrator"]["llm"]["local"]["llama_cpp"]["options"] = {
        "model_path": llama_model_path,
        "temperature": 0.0,
        "max_tokens": 16,
        "n_ctx": 4096,
        "n_gpu_layers": 0,
        "n_batch": 64,
        "top_p": 1.0,
        "top_k": 1,
        "repeat_penalty": 1.0,
        "min_p": 0.0,
        "chat_format": "chatml-function-calling",
    }
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

if [[ "$LIVE_SHELL_ACCEPTANCE" == "1" ]]; then
  mkdir -p "$TEST_HOOK_DIR"
  cat >"$TEST_HOOK_DIR/sitecustomize.py" <<'PY'
from __future__ import annotations

import asyncio
import faulthandler
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from app.services.gateway.webrtc import peer_protocol
from app.services.gateway.webrtc.peer_protocol import (
    CAP_GATEWAY_STATUS_EVENTS_V1,
    CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
    DEFAULT_PEER_CAPABILITIES,
)
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.gateway import GatewayMethods

LIVE_TOPICS = {"Gateway.StatusChanged"}
SNAPSHOT_RPC_METHODS = {"Gateway.GetCapabilityGraph", "Gateway.GetServiceHealth", "Gateway.GetRegistry"}
STATE = {"enabled": False, "subscriptions": {}, "drop_count": 0, "rpc_calls": []}
LOCK = threading.RLock()
REQUIRED_BROWSER_CAPABILITIES = frozenset(
    {CAP_GATEWAY_STATUS_EVENTS_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1}
)
PROVENANCE_PRINTED = False
NEGOTIATION_DIAGNOSTIC_PRINTED = False
CASE1_DIAGNOSTIC_COUNTS: dict[str, int] = {}
CASE1_DIAGNOSTIC_MAX_OCCURRENCES = 8
CASE1_CONFIG_EVENT_CAPTURED = False
CASE1_STATUS_DIAGNOSTIC_ARMED = False
CASE1_RECIPIENT_DIAGNOSTIC_ARMED = False


def _print_json_diagnostic(kind: str, **fields: Any) -> None:
    print(
        json.dumps(
            {"kind": kind, **fields},
            sort_keys=True,
            separators=(",", ":"),
        ),
        flush=True,
    )


def _print_case1_diagnostic(kind: str, **fields: Any) -> None:
    with LOCK:
        occurrence = CASE1_DIAGNOSTIC_COUNTS.get(kind, 0)
        if occurrence >= CASE1_DIAGNOSTIC_MAX_OCCURRENCES:
            return
        CASE1_DIAGNOSTIC_COUNTS[kind] = occurrence + 1
    diagnostic_fields = {
        "occurrence": occurrence + 1,
        "captured": False,
        "projected": False,
        "eligible": False,
        "sent": False,
    }
    diagnostic_fields.update(fields)
    _print_json_diagnostic(
        kind,
        **diagnostic_fields,
    )


def _assert_peer_protocol_provenance() -> None:
    expected_root_raw = os.environ.get("AURORA_HOSTED_PEER_EXPECTED_CHECKOUT_ROOT")
    if not expected_root_raw:
        raise RuntimeError(
            "Hosted peer preflight failed: "
            "AURORA_HOSTED_PEER_EXPECTED_CHECKOUT_ROOT is unset"
        )
    expected_root = Path(expected_root_raw).resolve()
    module_file = peer_protocol.__file__
    if not module_file:
        raise RuntimeError("Hosted peer preflight failed: peer_protocol has no source path")
    module_path = Path(module_file).resolve()
    try:
        module_path.relative_to(expected_root)
    except ValueError as exc:
        raise RuntimeError(
            "Hosted peer preflight failed: peer_protocol imported outside "
            f"requested checkout (module={module_path}, expected_root={expected_root})"
        ) from exc
    _print_json_diagnostic(
        "hosted_peer_process_fingerprint",
        peer_protocol_file=str(module_path),
        expected_checkout_root=str(expected_root),
        default_peer_capabilities=sorted(DEFAULT_PEER_CAPABILITIES),
    )


def _print_local_hello_fingerprint(hello: Any) -> None:
    global PROVENANCE_PRINTED
    if PROVENANCE_PRINTED:
        return
    capabilities = hello.get("capabilities", ()) if isinstance(hello, dict) else ()
    _print_json_diagnostic(
        "hosted_peer_local_protocol_hello",
        capabilities=sorted(str(capability) for capability in capabilities),
    )
    PROVENANCE_PRINTED = True


def _matching_topics(topics: object) -> set[str]:
    if not isinstance(topics, (list, tuple)):
        return set()
    return {str(topic) for topic in topics if str(topic) in LIVE_TOPICS}


def _record(handler: Any, peer_id: str, subscription_id: str, topics: set[str]) -> None:
    if not peer_id or not subscription_id or not topics:
        return
    with LOCK:
        STATE["subscriptions"][(peer_id, subscription_id)] = {
            "handler": handler,
            "loop": asyncio.get_running_loop(),
            "peer_id": peer_id,
            "subscription_id": subscription_id,
            "topics": tuple(sorted(topics)),
        }


def _drop(record: dict[str, Any]) -> bool:
    handler = record["handler"]
    peer_id = record["peer_id"]
    subscription_id = record["subscription_id"]
    loop = record.get("loop")

    def deliver() -> None:
        try:
            handler._send(json.dumps({"type": "eof", "id": subscription_id}))
        finally:
            registry = getattr(handler, "_event_subscription_registry", None)
            if registry is not None:
                registry.unsubscribe(peer_id=peer_id, subscription_id=subscription_id)

    try:
        if loop is not None and getattr(loop, "is_running", lambda: False)():
            loop.call_soon_threadsafe(deliver)
        else:
            deliver()
        return True
    except Exception:
        return False


def _drop_all() -> int:
    dropped = 0
    with LOCK:
        records = list(STATE["subscriptions"].values())
        STATE["subscriptions"] = {}
    for record in records:
        if _drop(record):
            dropped += 1
    with LOCK:
        STATE["drop_count"] += dropped
    return dropped


def _patch_rpc_handler() -> None:
    from app.services.gateway import fastapi_app
    from app.services.gateway.webrtc.rpc import RPCHandler
    from app.services.gateway.webrtc.rtc_client import RTCClient
    from app.services.gateway.mesh.peer_bridge import PeerBridge
    from app.services.gateway.service import GatewayService

    if not getattr(fastapi_app.create_gateway_app, "_aurora_per278_startup_patch", False):
        original_create_gateway_app = fastapi_app.create_gateway_app

        def patched_create_gateway_app(*args: Any, **kwargs: Any) -> Any:
            _print_json_diagnostic("hosted_peer_gateway_app_factory_start")
            app = original_create_gateway_app(*args, **kwargs)
            _print_json_diagnostic("hosted_peer_gateway_app_factory_complete")
            return app

        patched_create_gateway_app._aurora_per278_startup_patch = True
        fastapi_app.create_gateway_app = patched_create_gateway_app

    if not getattr(GatewayService._start_gateway, "_aurora_per278_startup_patch", False):
        original_start_gateway = GatewayService._start_gateway

        async def patched_start_gateway(self: Any, *args: Any, **kwargs: Any) -> Any:
            _print_json_diagnostic("hosted_peer_gateway_start_begin")
            result = await original_start_gateway(self, *args, **kwargs)
            _print_json_diagnostic("hosted_peer_gateway_start_complete")
            return result

        patched_start_gateway._aurora_per278_startup_patch = True
        GatewayService._start_gateway = patched_start_gateway

    if getattr(RPCHandler, "_aurora_per278_subscription_drop_patch", False):
        return
    original = RPCHandler._handle_subscribe

    async def patched(self: Any, msg: dict[str, Any]) -> None:
        params = msg.get("params") if isinstance(msg.get("params"), dict) else msg
        requested_topics = _matching_topics(params.get("topics") or params.get("requested_topics") or [])
        subscription_id = str(params.get("subscription_id") or msg.get("id") or "")
        stable_peer_id = self._stable_authenticated_peer_id()
        await original(self, msg)
        if requested_topics and stable_peer_id and subscription_id:
            record = {
                "handler": self,
                "loop": asyncio.get_running_loop(),
                "peer_id": stable_peer_id,
                "subscription_id": subscription_id,
                "topics": tuple(sorted(requested_topics)),
            }
            _record(self, stable_peer_id, subscription_id, requested_topics)
            with LOCK:
                enabled = bool(STATE["enabled"])
                STATE["subscriptions"].pop((stable_peer_id, subscription_id), None) if enabled else None
            if enabled and _drop(record):
                with LOCK:
                    STATE["drop_count"] += 1

    original_call = RPCHandler._handle_call

    async def patched_call(self: Any, msg: dict[str, Any]) -> None:
        method = str(msg.get("method") or "")
        if method in SNAPSHOT_RPC_METHODS:
            with LOCK:
                STATE["rpc_calls"].append({
                    "monotonic_ms": int(time.monotonic() * 1000),
                    "method": method,
                    "drop_enabled": bool(STATE["enabled"]),
                })
                STATE["rpc_calls"] = STATE["rpc_calls"][-200:]
        await original_call(self, msg)

    RPCHandler._handle_subscribe = patched
    RPCHandler._handle_call = patched_call
    RPCHandler._aurora_per278_subscription_drop_patch = True

    original_client_init = RTCClient.__init__

    def patched_client_init(self: Any, *args: Any, **kwargs: Any) -> None:
        original_client_init(self, *args, **kwargs)
        _print_local_hello_fingerprint(self._local_protocol_hello)

    original_protocol_hello = RTCClient._handle_protocol_hello

    def patched_protocol_hello(self: Any, peer_id: str, frame: Any) -> None:
        original_protocol_hello(self, peer_id, frame)
        session_peer_id = self._session_for_peer_id(peer_id)
        stable_peer_id = self._stable_peer_id_for_session(session_peer_id)
        accepted_hello = self._peer_protocol_hellos.get(stable_peer_id) or self._peer_protocol_hellos.get(
            session_peer_id
        )
        if accepted_hello is None:
            return
        remote_capabilities = getattr(accepted_hello, "capabilities", frozenset())
        local_capabilities = self._local_protocol_hello.get("capabilities", ())
        local_has_required = REQUIRED_BROWSER_CAPABILITIES.issubset(local_capabilities)
        remote_supports_required = {
            capability: capability in remote_capabilities
            for capability in sorted(REQUIRED_BROWSER_CAPABILITIES)
        }
        if not local_has_required or all(remote_supports_required.values()):
            return
        global NEGOTIATION_DIAGNOSTIC_PRINTED
        with LOCK:
            if NEGOTIATION_DIAGNOSTIC_PRINTED:
                return
            NEGOTIATION_DIAGNOSTIC_PRINTED = True
        _print_json_diagnostic(
            "hosted_peer_protocol_negotiation_mismatch",
            local_has_required_capabilities=local_has_required,
            remote_supports_required_capabilities=remote_supports_required,
        )

    RTCClient.__init__ = patched_client_init
    RTCClient._handle_protocol_hello = patched_protocol_hello
    RTCClient._aurora_per278_provenance_patch = True

    original_capture_gateway_event = GatewayService._capture_gateway_event

    async def patched_capture_gateway_event(self: Any, envelope: Any) -> None:
        global CASE1_CONFIG_EVENT_CAPTURED, CASE1_STATUS_DIAGNOSTIC_ARMED
        if getattr(envelope, "type", None) == ConfigMethods.UPDATED:
            with LOCK:
                first_case1_config_event = not CASE1_CONFIG_EVENT_CAPTURED
                if first_case1_config_event:
                    CASE1_CONFIG_EVENT_CAPTURED = True
                    CASE1_STATUS_DIAGNOSTIC_ARMED = True
            if first_case1_config_event:
                _print_case1_diagnostic(
                    "hosted_peer_case1_config_capture",
                    transport="gateway-bus",
                    stable_peer_id=None,
                    captured=True,
                )
        await original_capture_gateway_event(self, envelope)

    GatewayService._capture_gateway_event = patched_capture_gateway_event

    original_status_projection = GatewayService._status_changed_event

    def patched_status_projection(topic: str, payload: dict[str, Any]) -> Any:
        projected = original_status_projection(topic, payload)
        if topic == ConfigMethods.UPDATED and CASE1_STATUS_DIAGNOSTIC_ARMED:
            _print_case1_diagnostic(
                "hosted_peer_case1_status_projection",
                transport="gateway-bus",
                stable_peer_id=None,
                projected=projected is not None,
            )
        return projected

    GatewayService._status_changed_event = staticmethod(patched_status_projection)

    original_recipient_ids = RTCClient.gateway_status_event_recipient_ids

    def patched_recipient_ids(self: Any) -> list[str]:
        global CASE1_STATUS_DIAGNOSTIC_ARMED, CASE1_RECIPIENT_DIAGNOSTIC_ARMED
        recipient_ids = list(original_recipient_ids(self))
        if not CASE1_STATUS_DIAGNOSTIC_ARMED:
            return recipient_ids
        CASE1_STATUS_DIAGNOSTIC_ARMED = False
        CASE1_RECIPIENT_DIAGNOSTIC_ARMED = bool(recipient_ids)
        if recipient_ids:
            for stable_peer_id in recipient_ids:
                _print_case1_diagnostic(
                    "hosted_peer_case1_recipient_eligibility",
                    transport="webrtc-datachannel",
                    stable_peer_id=str(stable_peer_id),
                    eligible=True,
                )
        else:
            _print_case1_diagnostic(
                "hosted_peer_case1_recipient_eligibility",
                transport="webrtc-datachannel",
                stable_peer_id=None,
                eligible=False,
            )
        return recipient_ids

    RTCClient.gateway_status_event_recipient_ids = patched_recipient_ids

    original_fire_event_async = PeerBridge.fire_event_async

    async def patched_fire_event_async(
        self: Any,
        peer_id: str,
        topic: str,
        payload: Any,
        correlation_id: str | None = None,
        *,
        target_peer_id: str | None = None,
    ) -> bool:
        if topic != GatewayMethods.STATUS_CHANGED:
            return await original_fire_event_async(
                self,
                peer_id,
                topic,
                payload,
                correlation_id=correlation_id,
                target_peer_id=target_peer_id,
            )
        global CASE1_RECIPIENT_DIAGNOSTIC_ARMED
        if not CASE1_RECIPIENT_DIAGNOSTIC_ARMED:
            return await original_fire_event_async(
                self,
                peer_id,
                topic,
                payload,
                correlation_id=correlation_id,
                target_peer_id=target_peer_id,
            )
        CASE1_RECIPIENT_DIAGNOSTIC_ARMED = False
        try:
            sent = bool(await original_fire_event_async(
                self,
                peer_id,
                topic,
                payload,
                correlation_id=correlation_id,
                target_peer_id=target_peer_id,
            ))
        except Exception:
            _print_case1_diagnostic(
                "hosted_peer_case1_event_send",
                transport="webrtc-datachannel",
                stable_peer_id=str(peer_id),
                eligible=True,
                sent=False,
            )
            raise
        _print_case1_diagnostic(
            "hosted_peer_case1_event_send",
            transport="webrtc-datachannel",
            stable_peer_id=str(peer_id),
            eligible=True,
            sent=sent,
        )
        return sent

    PeerBridge.fire_event_async = patched_fire_event_async


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/state":
            self._json(404, {"error": "not_found"})
            return
        with LOCK:
            subscriptions = [
                {
                    "peer_id": record["peer_id"],
                    "subscription_id": record["subscription_id"],
                    "topics": list(record["topics"]),
                }
                for record in STATE["subscriptions"].values()
            ]
            self._json(200, {
                "enabled": bool(STATE["enabled"]),
                "drop_count": int(STATE["drop_count"]),
                "subscriptions": subscriptions,
                "rpc_calls": list(STATE["rpc_calls"]),
                "now_monotonic_ms": int(time.monotonic() * 1000),
            })

    def do_POST(self) -> None:
        if self.path != "/drop":
            self._json(404, {"error": "not_found"})
            return
        raw = self.rfile.read(int(self.headers.get("content-length") or "0"))
        payload = json.loads(raw.decode("utf-8") or "{}")
        with LOCK:
            STATE["enabled"] = bool(payload.get("enabled"))
            STATE["rpc_calls"] = []
        dropped = _drop_all() if payload.get("flush", True) else 0
        self._json(200, {"enabled": bool(STATE["enabled"]), "dropped": dropped})


def _start_server() -> None:
    port = int(os.environ.get("AURORA_HOSTED_PEER_TEST_CONTROL_PORT") or "0")
    if port <= 0:
        return
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, name="per278-test-control", daemon=True)
    thread.start()


faulthandler.register(signal.SIGUSR1, file=sys.stderr, all_threads=True)
_assert_peer_protocol_provenance()
_patch_rpc_handler()
_start_server()
PY
fi

# Put the requested checkout ahead of editable/site-package imports before
# Python initializes sitecustomize; keep the temporary hook discoverable
# immediately after it so its diagnostics patch the intended source tree.
setsid env \
  AURORA_ARCHITECTURE_MODE=threads \
  AURORA_CONFIG_FILE="$CONFIG_PATH" \
  AURORA_DATA_DIR="$DATA_DIR" \
  AURORA_TOKEN_SECRET="$TOKEN_SECRET" \
  AURORA_WEBRTC_PASSWORD="$ROOM_SECRET" \
  AURORA_GATEWAY_API_KEYS="$API_KEY" \
  AURORA_UI_ACTIVATE=false \
  AURORA_LLAMA_CPP_MODEL_PATH="$LLAMA_CPP_MODEL_PATH" \
  AURORA_HOSTED_PEER_TEST_CONTROL_PORT="$TEST_CONTROL_PORT" \
  AURORA_HOSTED_PEER_EXPECTED_CHECKOUT_ROOT="$ROOT" \
  PYTHONPATH="$ROOT:$TEST_HOOK_DIR${PYTHONPATH:+:$PYTHONPATH}" \
  PYTHONUNBUFFERED=1 \
  "$ROOT/.venv/bin/python" main.py >"$PYTHON_LOG" 2>&1 &
PYTHON_PID=$!
echo "hosted peer python process launched: pid=$PYTHON_PID" >&2

wait_for_http \
  "http://127.0.0.1:$GATEWAY_PORT/api/health" \
  "$PYTHON_PID" \
  "$PYTHON_LOG" \
  "Python gateway" \
  "USR1"

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
AURORA_HOSTED_PEER_ENABLE_ORCHESTRATOR="$LIVE_SHELL_ACCEPTANCE" \
AURORA_HOSTED_PEER_LIVE_SHELL_ACCEPTANCE="$LIVE_SHELL_ACCEPTANCE" \
AURORA_HOSTED_PEER_TEST_CONTROL_URL="http://127.0.0.1:$TEST_CONTROL_PORT" \
  node "$ROOT/node_modules/.pnpm/@playwright+test@1.61.1/node_modules/@playwright/test/cli.js" test \
    --config tests/e2e/hosted_peer/playwright.config.ts \
    --project chromium
