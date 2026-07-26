#!/usr/bin/env python3
"""Start a Python RTCClient for the live browser interop harness.

This process intentionally does not create GatewayService/FastAPI/Uvicorn.  The
report exposes that proof while the current RTCClient/RPCHandler/DataChannel
stack handles MQTT signaling and JSON-RPC over WebRTC.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import os
import re
import socket
import sys
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.messaging.bus import QueryResult  # noqa: E402
from app.services.gateway.config import (  # noqa: E402
    APISettings,
    MQTTSettings,
    PermissionSettings,
    Settings,
    WebRTCSettings,
)
from app.services.gateway.webrtc.rtc_client import RTCClient  # noqa: E402
from app.shared.auth.identity import build_identity  # noqa: E402
from app.shared.contracts.models.auth import (  # noqa: E402
    AuthMethods,
    build_mesh_reconnect_proof_message,
)
from app.shared.contracts.models.config import ConfigMethods  # noqa: E402
from app.shared.contracts.models.gateway import (  # noqa: E402
    GatewayMethods,
    GetRegistryResponse,
    MethodInfo,
    ModuleRegistryInfo,
    ServiceAnnouncement,
)
from app.shared.contracts.models.orchestrator import OrchestratorMethods  # noqa: E402
from app.shared.contracts.models.tts import TTSMethods  # noqa: E402
from app.shared.models.db import Token  # noqa: E402

SAFE_EVENT_TOPIC = ConfigMethods.UPDATED
TTS_EVENT_TOPIC = TTSMethods.AUDIO_CHUNK
ASSISTANT_EVENT_TOPIC = OrchestratorMethods.RESPONSE
MUTATE_TOPIC = "G009Interop.Mutate"
MUTATION_COUNT_TOPIC = "G009Interop.MutationCount"
REVOKE_TOPIC = "G009Interop.RevokeCredential"
MUTATION_STARTED_TOPIC = "G009Interop.MutationStarted"


def now() -> str:
    return datetime.now(UTC).isoformat()


class InteropRegistry:
    def __init__(self) -> None:
        self._services: dict[str, ServiceAnnouncement] = {}
        self._install()

    def _install(self) -> None:
        self._services["Auth"] = ServiceAnnouncement(
            module="Auth",
            version="interop",
            methods=[
                MethodInfo(
                    name="PairingStart",
                    bus_topic=AuthMethods.PAIRING_START,
                    exposure="internal",
                    method_type="use",
                ),
                MethodInfo(
                    name="PairingConnect",
                    bus_topic=AuthMethods.PAIRING_CONNECT,
                    exposure="internal",
                    method_type="use",
                ),
                MethodInfo(
                    name="PairingExchange",
                    bus_topic=AuthMethods.PAIRING_EXCHANGE,
                    exposure="internal",
                    method_type="use",
                ),
                MethodInfo(
                    name="Login",
                    bus_topic=AuthMethods.LOGIN,
                    exposure="internal",
                    method_type="use",
                ),
            ],
        )
        self._services["Gateway"] = ServiceAnnouncement(
            module="Gateway",
            version="interop",
            methods=[
                MethodInfo(
                    name="GetRegistry",
                    bus_topic=GatewayMethods.GET_REGISTRY,
                    exposure="both",
                    method_type="use",
                    required_perms=["Gateway.use"],
                ),
            ],
        )
        self._services["Config"] = ServiceAnnouncement(
            module="Config",
            version="interop",
            methods=[
                MethodInfo(
                    name="Updated",
                    bus_topic=ConfigMethods.UPDATED,
                    exposure="both",
                    method_type="use",
                    required_perms=["Config.use"],
                ),
            ],
        )
        self._services["TTS"] = ServiceAnnouncement(
            module="TTS",
            version="interop",
            methods=[
                MethodInfo(
                    name="AudioChunk",
                    bus_topic=TTS_EVENT_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=["TTS.use"],
                )
            ],
        )
        self._services["Orchestrator"] = ServiceAnnouncement(
            module="Orchestrator",
            version="interop",
            methods=[
                MethodInfo(
                    name="Response",
                    bus_topic=ASSISTANT_EVENT_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=["Orchestrator.use"],
                )
            ],
        )
        self._services["G009Interop"] = ServiceAnnouncement(
            module="G009Interop",
            version="interop",
            methods=[
                MethodInfo(
                    name="Mutate",
                    bus_topic=MUTATE_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=["G009Interop.use"],
                ),
                MethodInfo(
                    name="MutationCount",
                    bus_topic=MUTATION_COUNT_TOPIC,
                    exposure="both",
                    method_type="query",
                    required_perms=["G009Interop.use"],
                ),
                MethodInfo(
                    name="MutationStarted",
                    bus_topic=MUTATION_STARTED_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=["G009Interop.use"],
                ),
                MethodInfo(
                    name="RevokeCredential",
                    bus_topic=REVOKE_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=["G009Interop.use"],
                ),
            ],
        )

    async def start(self) -> None:
        return None

    def on_registry_change(self, _callback: Any) -> None:
        return None

    async def get_service(self, module: str) -> ServiceAnnouncement | None:
        return self._services.get(module)

    def registry_response(self) -> GetRegistryResponse:
        modules = [
            ModuleRegistryInfo(
                module=svc.module,
                version=svc.version,
                summary=svc.summary,
                capabilities=svc.capabilities,
                methods=svc.methods,
            )
            for svc in sorted(self._services.values(), key=lambda item: item.module)
        ]
        digest_source = json.dumps(
            [module.model_dump(mode="json") for module in modules], sort_keys=True
        )
        return GetRegistryResponse(
            modules=modules, digest=hashlib.sha256(digest_source.encode()).hexdigest()
        )


class InteropBus:
    def __init__(self, registry: InteropRegistry, token_value: str) -> None:
        self.registry = registry
        self.token_value = token_value
        self.requests: list[dict[str, Any]] = []
        self.pairing: dict[str, dict[str, Any]] = {}
        self.publish_records: list[dict[str, Any]] = []
        self.mutation_counts: dict[str, int] = {}
        self.mutation_records: dict[str, dict[str, Any]] = {}
        self.mutation_started: dict[str, dict[str, Any]] = {}
        self.mutation_releases: dict[str, asyncio.Event] = {}
        self.on_mutation_started: Any | None = None
        self.revoked = False

    async def request(self, topic: str, payload: Any = None, **kwargs: Any) -> QueryResult:
        params = (
            payload.model_dump(mode="json")
            if hasattr(payload, "model_dump")
            else payload
            if isinstance(payload, dict)
            else {}
        )
        self.requests.append(
            {
                "topic": topic,
                "origin": kwargs.get("origin"),
                "correlation_id": kwargs.get("correlation_id"),
            }
        )
        if topic == GatewayMethods.GET_REGISTRY:
            return QueryResult(ok=True, data=self.registry.registry_response())
        if topic == AuthMethods.PAIRING_START:
            session_id = str(params.get("pairing_session_id") or "")
            code = f"interop-handle-{len(self.pairing) + 1}"
            self.pairing[code] = {**params, "status": "approved", "pairing_session_id": session_id}
            return QueryResult(
                ok=True,
                data={
                    "status": "pending",
                    "code": code,
                    "pairing_session_id": session_id,
                    "verification_code": params.get("verification_code"),
                },
            )
        if topic == AuthMethods.PAIRING_CONNECT:
            code = str(params.get("code") or "")
            item = self.pairing.get(code) or {}
            return QueryResult(
                ok=True,
                data={
                    "status": "approved",
                    "code": code,
                    "pairing_session_id": item.get("pairing_session_id")
                    or params.get("pairing_session_id"),
                    "verification_code": item.get("verification_code"),
                },
            )
        if topic == MUTATE_TOPIC:
            mutation_id = str(params.get("mutation_id") or "default")
            started_at = time.monotonic()
            self.mutation_counts[mutation_id] = self.mutation_counts.get(mutation_id, 0) + 1
            release = asyncio.Event()
            self.mutation_releases[mutation_id] = release
            started_record = {
                "mutation_id": mutation_id,
                "request_correlation_id": kwargs.get("correlation_id"),
                "started_at_monotonic_ms": int(started_at * 1000),
                "execution_count": self.mutation_counts[mutation_id],
            }
            self.mutation_started[mutation_id] = started_record
            if self.on_mutation_started is not None:
                await self.on_mutation_started(started_record)
            await release.wait()
            await asyncio.sleep(float(params.get("delay_seconds") or 0))
            completed_at = time.monotonic()
            self.mutation_records[mutation_id] = {
                "mutation_id": mutation_id,
                "request_correlation_id": kwargs.get("correlation_id"),
                "started_to_completed_ms": int((completed_at - started_at) * 1000),
                "execution_count": self.mutation_counts[mutation_id],
                "response_category": "delayed_after_started_ack",
            }
            return QueryResult(
                ok=True,
                data={
                    "mutation_id": mutation_id,
                    "execution_count": self.mutation_counts[mutation_id],
                    "accepted": True,
                },
            )
        if topic == MUTATION_COUNT_TOPIC:
            mutation_id = str(params.get("mutation_id") or "default")
            return QueryResult(
                ok=True,
                data={
                    "mutation_id": mutation_id,
                    "execution_count": self.mutation_counts.get(mutation_id, 0),
                },
            )
        if topic == REVOKE_TOPIC:
            self.revoked = True
            return QueryResult(ok=True, data={"revoked": True, "route": "datachannel"})
        if topic == AuthMethods.PAIRING_EXCHANGE:
            code = str(params.get("code") or "")
            return QueryResult(
                ok=True,
                data={
                    "token": self.token_value,
                    "token_id": "interop-token-row",
                    "peer_id": "python-gateway-g009",
                    "node_name": "G009 Python Gateway",
                },
            )
        return QueryResult(ok=False, error=f"Unhandled interop bus topic {topic}")

    async def publish(self, topic: str, payload: Any = None, **kwargs: Any) -> None:
        self.publish_records.append(
            {
                "topic": topic,
                "event": kwargs.get("event"),
                "origin": kwargs.get("origin"),
                "correlation_id": kwargs.get("correlation_id"),
            }
        )


class InteropAuth:
    def __init__(self, token_value: str, bus: InteropBus) -> None:
        self.token_value = token_value
        self.bus = bus
        self.db_manager = None

    async def get_system_token(self) -> str:
        return "interop-system-token-redacted"

    async def validate_mesh_pairing_token(self, **kwargs: Any) -> Token | None:
        token_str = str(kwargs.get("token_str") or "")
        if token_str != self.token_value:
            return None
        return Token(
            id="interop-token-row",
            token_hash="redacted",
            prefix="interop",
            user_id="interop-principal",
            device_id="browser-device",
            scopes=["*"],
        )

    async def authenticate_token(self, token_str: str) -> Token | None:
        if token_str != self.token_value:
            return None
        return Token(
            id="interop-token-row",
            token_hash="redacted",
            prefix="interop",
            user_id="interop-principal",
            device_id="browser-device",
            scopes=["*"],
        )

    async def verify_mesh_reconnect_proof(self, **kwargs: Any) -> Token | None:
        if self.bus.revoked:
            return None
        token_id = str(kwargs.get("token_id") or "")
        if token_id != "interop-token-row":
            return None
        message = build_mesh_reconnect_proof_message(
            token_id=token_id,
            challenge=str(kwargs.get("challenge") or ""),
            channel_binding=str(kwargs.get("channel_binding") or ""),
            claimant_peer_id=str(kwargs.get("claimant_peer_id") or ""),
            verifier_peer_id=str(kwargs.get("verifier_peer_id") or ""),
            room_name=str(kwargs.get("room_name") or ""),
        )
        key = hashlib.sha256(self.token_value.encode("utf-8")).digest()
        expected = hmac.new(key, message, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, str(kwargs.get("proof") or "")):
            return None
        return Token(
            id="interop-token-row",
            token_hash="redacted",
            prefix="interop",
            user_id="interop-principal",
            device_id="browser-device",
            scopes=["*"],
        )

    async def build_identity_from_token(self, token: Token, source: str = "webrtc_peer"):
        return build_identity(
            user_id=token.user_id or "interop-principal",
            username="G009 browser peer",
            user_permissions=["*"],
            user_is_admin=True,
            token_scopes=token.scopes or ["*"],
            device_id=token.device_id,
            source=source,
        )


def can_connect(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def non_host_ice_candidate(candidate_sdp: str) -> bool:
    """Force the STUN harness lane to signal only reflexive ICE candidates."""
    return re.search(r"\btyp\s+host\b", candidate_sdp, flags=re.IGNORECASE) is None


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane", required=True, choices=["direct", "stun", "turn"])
    parser.add_argument("--ready", required=True)
    parser.add_argument("--done", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--broker", default="ws://127.0.0.1:9001")
    parser.add_argument("--room-secret", default=os.environ.get("WEBRTC_INTEROP_ROOM_SECRET", ""))
    parser.add_argument("--app-id", default="aurora-g009-interop")
    parser.add_argument("--room", default="g009-live-interop")
    parser.add_argument("--stun", action="append", default=[])
    parser.add_argument("--turn", action="append", default=[])
    parser.add_argument("--timeout", type=float, default=45.0)
    args = parser.parse_args()

    if not args.room_secret:
        raise SystemExit("WEBRTC_INTEROP_ROOM_SECRET is required")

    ready_path = Path(args.ready)
    done_path = Path(args.done)
    report_path = Path(args.report)
    token_value = os.environ.get("WEBRTC_INTEROP_TOKEN", "interop-browser-token-value-not-written")
    registry = InteropRegistry()
    bus = InteropBus(registry, token_value)
    auth = InteropAuth(token_value, bus)
    settings = Settings(
        api=APISettings(enabled=False, host="127.0.0.1", port=0, auth_enabled=False),
        webrtc=WebRTCSettings(
            enabled=True,
            strategy="mqtt",
            app_id=args.app_id,
            room=args.room,
            password=args.room_secret,
            encrypt_signaling=True,
            enable_app_layer_e2ee=True,
            stun_servers=args.stun,
            turn_servers=args.turn,
            turn_username="interop" if args.turn else None,
            turn_password="interop" if args.turn else None,
        ),
        signaling_mqtt=MQTTSettings(brokers=[args.broker], topic_root="aurora"),
        permissions=PermissionSettings(
            enabled=True,
            default_pairing_permissions=["*"],
            webrtc_auth_timeout_seconds=10.0,
            webrtc_pairing_timeout_seconds=max(30.0, args.timeout),
        ),
    )
    allowed_event_topics = {
        SAFE_EVENT_TOPIC,
        TTS_EVENT_TOPIC,
        ASSISTANT_EVENT_TOPIC,
        MUTATION_STARTED_TOPIC,
    }
    rtc = RTCClient(
        settings=settings,
        bus=bus,
        registry=registry,
        auth_service=auth,
        require_auth=True,
        event_topic_authorizer=lambda _peer, topic, _identity: topic in allowed_event_topics,
        outbound_ice_candidate_allowed=non_host_ice_candidate if args.lane == "stun" else None,
    )
    rtc.set_mesh_identity("python-gateway-g009", "G009 Python Gateway")

    async def _send_mutation_started(started: dict[str, Any]) -> None:
        mutation_id = str(started.get("mutation_id") or "")
        if not mutation_id:
            return
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            sent = 0
            for peer in rtc.get_connected_peers():
                stable = str(peer.get("stable_peer_id") or "")
                if stable and rtc.event_subscriptions.is_interested(  # noqa: SIM102
                    stable, MUTATION_STARTED_TOPIC, mutation_id
                ):
                    if await rtc.send_to_peer_async(
                        stable,
                        json.dumps(
                            {
                                "type": "event",
                                "topic": MUTATION_STARTED_TOPIC,
                                "params": {
                                    "kind": "mutation.started",
                                    "mutation_id": mutation_id,
                                    "request_id": started.get("request_correlation_id"),
                                    "timing_category": "started_before_response_delay",
                                    "execution_count": started.get("execution_count"),
                                    "correlation_id": mutation_id,
                                },
                                "correlation_id": mutation_id,
                            }
                        ),
                    ):
                        sent += 1
            if sent > 0:
                release = bus.mutation_releases.get(mutation_id)
                if release is not None:
                    release.set()
                bus.mutation_started.pop(mutation_id, None)
                return
            await asyncio.sleep(0.05)
        release = bus.mutation_releases.get(mutation_id)
        if release is not None:
            release.set()

    bus.on_mutation_started = _send_mutation_started
    started_at = time.monotonic()
    await rtc.start(join_room=True)

    write_json(
        ready_path,
        {
            "lane": args.lane,
            "appId": args.app_id,
            "room": args.room,
            "brokerUrl": args.broker,
            "expectedStablePeerId": "python-gateway-g009",
            "localStablePeerId": "browser-g009",
            "nodeName": "G009 Python Gateway",
            "stunServers": args.stun,
            "turnServers": args.turn,
            "turnUsername": "interop" if args.turn else None,
            "turnCredential": "interop" if args.turn else None,
            "forceRelay": args.lane == "turn",
            "suppressHostCandidates": args.lane == "stun",
            "eventTopic": SAFE_EVENT_TOPIC,
            "eventCorrelationId": f"g009-corr-{args.lane}",
            "ttsEventTopic": TTS_EVENT_TOPIC,
            "ttsCorrelationId": f"g009-tts-{args.lane}",
            "wrongCorrelationId": f"g009-wrong-{args.lane}",
            "mutationTopic": MUTATE_TOPIC,
            "mutationCountTopic": MUTATION_COUNT_TOPIC,
            "mutationStartedTopic": MUTATION_STARTED_TOPIC,
            "revokeTopic": REVOKE_TOPIC,
            "timeoutMs": int(args.timeout * 1000),
            "gatewayHttpApiEnabled": False,
            "gatewayHttpReachable": can_connect("127.0.0.1", 8000),
            "readyAt": now(),
        },
    )

    event_sent = False
    tts_event_sent = False
    wrong_corr_interest = False
    wildcard_interest = False
    revoked_reconnect_failures = 0
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline and not done_path.exists():
        for error in rtc.get_diagnostics().recent_errors:
            if error.code == "reconnect_auth_failed":
                revoked_reconnect_failures += 1
        for peer in rtc.get_connected_peers():
            stable = str(peer.get("stable_peer_id") or "")
            if stable == "browser-g009" and peer.get("connection_state") == "connected":
                if not event_sent and rtc.event_subscriptions.is_interested(
                    stable, SAFE_EVENT_TOPIC, f"g009-corr-{args.lane}"
                ):
                    await rtc.send_to_peer_async(
                        stable,
                        json.dumps(
                            {
                                "type": "event",
                                "topic": SAFE_EVENT_TOPIC,
                                "params": {
                                    "kind": "config.updated",
                                    "key": "interop.probe",
                                    "value": "redacted",
                                    "correlation_id": f"g009-corr-{args.lane}",
                                },
                                "correlation_id": f"g009-corr-{args.lane}",
                            }
                        ),
                    )
                    event_sent = True
                wrong_corr_interest = rtc.event_subscriptions.is_interested(
                    stable, TTS_EVENT_TOPIC, f"g009-wrong-{args.lane}", sensitive=True
                )
                wildcard_interest = rtc.event_subscriptions.is_interested(
                    stable, "TTS.*", f"g009-tts-{args.lane}", sensitive=True
                )
                if not tts_event_sent and rtc.event_subscriptions.is_interested(
                    stable, TTS_EVENT_TOPIC, f"g009-tts-{args.lane}", sensitive=True
                ):
                    await rtc.send_to_peer_async(
                        stable,
                        json.dumps(
                            {
                                "type": "event",
                                "topic": TTS_EVENT_TOPIC,
                                "params": {
                                    "kind": "tts.chunk",
                                    "chunk_id": "redacted",
                                    "byte_count": 128,
                                    "media_redacted": True,
                                    "correlation_id": f"g009-tts-{args.lane}",
                                },
                                "correlation_id": f"g009-tts-{args.lane}",
                            }
                        ),
                    )
                    tts_event_sent = True
        await asyncio.sleep(0.1)

    diagnostics = rtc.get_diagnostics().model_dump(mode="json")
    write_json(
        report_path,
        {
            "lane": args.lane,
            "startedAt": now(),
            "durationMs": round((time.monotonic() - started_at) * 1000),
            "gatewayHttpApiEnabled": False,
            "gatewayHttpReachable": can_connect("127.0.0.1", 8000),
            "rtcStarted": diagnostics.get("started"),
            "localSignalingPeerIdPresent": bool(diagnostics.get("local_signaling_peer_id")),
            "localMeshPeerId": diagnostics.get("local_mesh_peer_id"),
            "connectedPeerCount": diagnostics.get("connected_peer_count"),
            "authenticatedPeerCount": diagnostics.get("authenticated_peer_count"),
            "eventSent": event_sent,
            "ttsEventSent": tts_event_sent,
            "scopedEventEvidence": {
                "wrongCorrelationInterested": wrong_corr_interest,
                "wildcardInterested": wildcard_interest,
            },
            "mutationCounts": bus.mutation_counts,
            "mutationRecords": bus.mutation_records,
            "revoked": bus.revoked,
            "reconnectEvidence": {"revokedReconnectFailuresObserved": revoked_reconnect_failures},
            "requests": bus.requests,
            "publishes": bus.publish_records,
            "diagnostics": diagnostics,
            "secretsRedacted": True,
        },
    )
    await rtc.close()
    return 0 if done_path.exists() else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
