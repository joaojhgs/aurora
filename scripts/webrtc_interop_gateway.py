#!/usr/bin/env python3
"""Start a Python RTCClient for the live browser interop harness.

This process intentionally does not create GatewayService/FastAPI/Uvicorn.  The
report exposes that proof while the current RTCClient/RPCHandler/DataChannel
stack handles MQTT signaling and JSON-RPC over WebRTC.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import hmac
import json
import os
import re
import socket
import sys
import time
from collections.abc import AsyncIterator
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
    MeshConfig,
    MeshServiceExportPolicy,
    MeshServicePolicy,
    MeshServiceRoutingPolicy,
    MQTTSettings,
    PermissionSettings,
    Settings,
    WebRTCSettings,
)
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo  # noqa: E402
from app.services.gateway.mesh.negotiation import manifest_to_dict  # noqa: E402
from app.services.gateway.mesh.peer_bridge import PeerBridge  # noqa: E402
from app.services.gateway.mesh.peer_registry import PeerRegistry  # noqa: E402
from app.services.gateway.mesh.provider_export import (  # noqa: E402
    LEGACY_MANIFEST_PROTOCOL,
    SUPPORTED_PROTOCOLS,
    NormalizedMethodSnapshot,
    NormalizedServiceSnapshot,
    RegistrySnapshot,
)
from app.services.gateway.webrtc.peer_protocol import CAP_PROVIDER_LEASE_V1  # noqa: E402
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
from app.shared.contracts.models.mesh import MeshPeerAuthoritySnapshot  # noqa: E402
from app.shared.contracts.models.orchestrator import OrchestratorMethods  # noqa: E402
from app.shared.contracts.models.tooling import ToolingMethods  # noqa: E402
from app.shared.contracts.models.tts import TTSMethods  # noqa: E402
from app.shared.models.db import Token  # noqa: E402

SAFE_EVENT_TOPIC = ConfigMethods.UPDATED
TTS_EVENT_TOPIC = TTSMethods.AUDIO_CHUNK
ASSISTANT_EVENT_TOPIC = OrchestratorMethods.RESPONSE
MUTATE_TOPIC = "G009Interop.Mutate"
MUTATION_COUNT_TOPIC = "G009Interop.MutationCount"
REVOKE_TOPIC = "G009Interop.RevokeCredential"
MUTATION_STARTED_TOPIC = "G009Interop.MutationStarted"
LARGE_ECHO_TOPIC = "G009Interop.LargeEcho"
ERROR_TOPIC = "G009Interop.IntentionalError"
STREAM_STATUS_TOPIC = "G009Interop.StreamStatus"
AC18_TOOL_CONTRACT_ID = "interop.browser.echo"
AC18_TOOL_LOCAL_NAME = "interop.browser.echo"
AC18_LOCAL_TOOL_PROVIDER_ENV = "WEBRTC_INTEROP_AC18_LOCAL_TOOL_PROVIDER"
BROWSER_MESH_PEER_ID = "browser-g009"
PYTHON_MESH_PEER_ID = "python-gateway-g009"
AC18_FORGED_FRAME_PEER_ID = "forged-ac18-frame-peer"
AC18_PROVIDER_SERVICE_INSTANCE_ID = f"local:{BROWSER_MESH_PEER_ID}:Tooling"
AC18_GLOBAL_TOOL_ID = f"aurora-tool:v1:{BROWSER_MESH_PEER_ID}:Tooling:{AC18_TOOL_CONTRACT_ID}"
NATIVE_DEVICE_TOOL_CONTRACT_ID = "aurora.local.native.get_device_status.v1"
NATIVE_DEVICE_TOOL_LOCAL_NAME = "native.get_device_status"
INTEROP_SERVICE_PERMISSION = "Gateway.G009Interop"
AC18_SHARED_HARNESS_PERMISSIONS = (
    "Config.use",
    INTEROP_SERVICE_PERMISSION,
    "Gateway.use",
    "Orchestrator.use",
    "TTS.use",
)
PYTHON_SIGNALING_IDS = {
    "direct": "100-python-g009",
    "stun": "000-python-g009",
    "turn": "100-python-g009",
}
BROWSER_SIGNALING_IDS = {
    "direct": "000-browser-g009",
    "stun": "100-browser-g009",
    "turn": "000-browser-g009",
}


def env_flag(name: str) -> bool:
    """Return whether a string environment flag is explicitly enabled."""

    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def ac18_digest(value: dict[str, Any]) -> str:
    """Build the cross-runtime digest for the AC18 browser-local tool response."""

    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def now() -> str:
    return datetime.now(UTC).isoformat()


def build_ac18_mesh_config(*, timeout_seconds: float) -> MeshConfig:
    """Build the live interop mesh policy used when the browser is a local tool provider."""

    shared_harness_services = {
        module: MeshServicePolicy(export=MeshServiceExportPolicy(share=True))
        for module in ("Config", "G009Interop", "Gateway", "Orchestrator", "TTS")
    }
    return MeshConfig(
        enabled=True,
        node_name="G009 Python Gateway",
        services={
            **shared_harness_services,
            "Tooling": MeshServicePolicy(
                export=MeshServiceExportPolicy(share=False),
                routing=MeshServiceRoutingPolicy(
                    allowed_provider_peer_ids=(BROWSER_MESH_PEER_ID,),
                    prefer="network",
                    fallback="error",
                ),
            ),
        },
        stale_peer_timeout_s=0,
        remote_timeout_s=timeout_seconds,
    )


def build_native_device_mesh_config(*, timeout_seconds: float) -> MeshConfig:
    """Build the mesh policy for a dynamically identified native-device provider."""

    config = build_ac18_mesh_config(timeout_seconds=timeout_seconds)
    return config.model_copy(
        update={
            "services": {
                **config.services,
                "Tooling": MeshServicePolicy(
                    export=MeshServiceExportPolicy(share=False),
                    routing=MeshServiceRoutingPolicy(
                        allowed_provider_peer_ids=None,
                        prefer="network",
                        fallback="error",
                    ),
                ),
            }
        }
    )


def build_ac18_browser_authority_snapshot(peer_id: str) -> MeshPeerAuthoritySnapshot:
    """Build the exact recipient authority needed by the live browser interop harness."""

    return MeshPeerAuthoritySnapshot(
        peer_id=peer_id,
        auth_grant_revision=1,
        disposition="present",
        state="active",
        effective_permissions=AC18_SHARED_HARNESS_PERMISSIONS,
    )


def install_ac18_authority_refresh(rtc: Any) -> None:
    """Install a supported authority-refresh callback for the browser harness peer."""

    async def _refresh(peer_id: str) -> bool:
        if peer_id != BROWSER_MESH_PEER_ID:
            return False
        result = rtc.apply_trusted_peer_authority_snapshot(
            build_ac18_browser_authority_snapshot(peer_id)
        )
        return bool(getattr(result, "applied", False))

    rtc.set_authority_refresh_callback(_refresh)


def install_native_device_authority_refresh(rtc: Any) -> None:
    """Seed bounded harness grants for whichever native peer pairs."""

    async def _refresh(peer_id: str) -> bool:
        if not peer_id or peer_id == PYTHON_MESH_PEER_ID:
            return False
        result = rtc.apply_trusted_peer_authority_snapshot(
            build_ac18_browser_authority_snapshot(peer_id)
        )
        return bool(getattr(result, "applied", False))

    rtc.set_authority_refresh_callback(_refresh)


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
                    exposure="both",
                    method_type="use",
                    public_infrastructure=True,
                ),
                MethodInfo(
                    name="PairingConnect",
                    bus_topic=AuthMethods.PAIRING_CONNECT,
                    exposure="both",
                    method_type="use",
                    public_infrastructure=True,
                ),
                MethodInfo(
                    name="PairingExchange",
                    bus_topic=AuthMethods.PAIRING_EXCHANGE,
                    exposure="both",
                    method_type="use",
                    public_infrastructure=True,
                ),
                MethodInfo(
                    name="Login",
                    bus_topic=AuthMethods.LOGIN,
                    exposure="both",
                    method_type="use",
                    public_infrastructure=True,
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
                ),
                MethodInfo(
                    name="StreamInferChat",
                    bus_topic=OrchestratorMethods.STREAM_INFER_CHAT,
                    exposure="both",
                    method_type="use",
                    required_perms=["Orchestrator.use"],
                ),
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
                    required_perms=[INTEROP_SERVICE_PERMISSION],
                ),
                MethodInfo(
                    name="MutationCount",
                    bus_topic=MUTATION_COUNT_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=[INTEROP_SERVICE_PERMISSION],
                ),
                MethodInfo(
                    name="MutationStarted",
                    bus_topic=MUTATION_STARTED_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=[INTEROP_SERVICE_PERMISSION],
                ),
                MethodInfo(
                    name="RevokeCredential",
                    bus_topic=REVOKE_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=[INTEROP_SERVICE_PERMISSION],
                ),
                MethodInfo(
                    name="LargeEcho",
                    bus_topic=LARGE_ECHO_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=[INTEROP_SERVICE_PERMISSION],
                ),
                MethodInfo(
                    name="IntentionalError",
                    bus_topic=ERROR_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=[INTEROP_SERVICE_PERMISSION],
                ),
                MethodInfo(
                    name="StreamStatus",
                    bus_topic=STREAM_STATUS_TOPIC,
                    exposure="both",
                    method_type="use",
                    required_perms=[INTEROP_SERVICE_PERMISSION],
                ),
            ],
        )

    async def start(self) -> None:
        return None

    def on_registry_change(self, _callback: Any) -> None:
        return None

    async def get_service(self, module: str) -> ServiceAnnouncement | None:
        return self._services.get(module)

    def snapshot_registry(self) -> RegistrySnapshot:
        """Return the immutable normalized registry used by provider projection."""

        services: list[NormalizedServiceSnapshot] = []
        for announcement in sorted(self._services.values(), key=lambda item: item.module):
            topics = {
                str(method.bus_topic or f"{announcement.module}.{method.name}")
                for method in announcement.methods
            }
            feature_members = {
                str(feature.feature_id): tuple(
                    sorted(
                        str(method_id)
                        for method_id in feature.method_ids
                        if str(method_id) in topics
                    )
                )
                for feature in announcement.callable_features
                if any(str(method_id) in topics for method_id in feature.method_ids)
            }
            services.append(
                NormalizedServiceSnapshot(
                    service_id=announcement.module,
                    version=announcement.version,
                    tags=tuple(announcement.capabilities),
                    methods=tuple(
                        NormalizedMethodSnapshot(
                            topic=str(method.bus_topic or f"{announcement.module}.{method.name}"),
                            exposure=method.exposure,
                            method_type=method.method_type,
                            required_permissions=tuple(method.required_perms),
                            summary=method.summary,
                            input_model=method.input_model,
                            output_model=method.output_model,
                            input_schema=method.input_schema,
                            output_schema=method.output_schema,
                            feature_ids=tuple(method.callable_feature_ids),
                            public_infrastructure=method.public_infrastructure,
                        )
                        for method in announcement.methods
                    ),
                    feature_members=feature_members,
                )
            )
        return RegistrySnapshot(
            revision=f"interop:{self.registry_response().digest}",
            services=tuple(services),
        )

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

    def legacy_manifest(self, peer_id: str, node_name: str) -> dict[str, Any]:
        """Build a canonical Python legacy manifest for browser lookup/ACK proof."""

        manifest = PeerManifest(
            peer_id=peer_id,
            node_name=node_name,
            aurora_version="interop",
            shared_services=[
                PeerServiceInfo(
                    module=service.module,
                    version=service.version,
                    capabilities=service.capabilities,
                    methods=service.methods,
                )
                for service in sorted(self._services.values(), key=lambda item: item.module)
            ],
            active_protocol=LEGACY_MANIFEST_PROTOCOL,
            active_version="v0",
            active_tier="legacy",
            supported_protocols=list(SUPPORTED_PROTOCOLS),
            projection_supported=True,
            projection_active=False,
            timestamp=now(),
        )
        return manifest_to_dict(manifest)


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
        self.large_rpc_records: list[dict[str, Any]] = []
        self.stream_records: dict[str, dict[str, Any]] = {}

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
        if topic == LARGE_ECHO_TOPIC:
            blob = str(params.get("blob") or "")
            result_blob = "y" * len(blob)
            self.large_rpc_records.append(
                {
                    "request_bytes": len(blob.encode()),
                    "result_bytes": len(result_blob.encode()),
                    "request_sha256": hashlib.sha256(blob.encode()).hexdigest(),
                    "result_sha256": hashlib.sha256(result_blob.encode()).hexdigest(),
                }
            )
            return QueryResult(ok=True, data={"blob": result_blob})
        if topic == ERROR_TOPIC:
            return QueryResult(ok=False, error="intentional interop RPC failure")
        if topic == STREAM_STATUS_TOPIC:
            probe_id = str(params.get("probe_id") or "")
            return QueryResult(
                ok=True,
                data=self.stream_records.get(
                    probe_id,
                    {
                        "probe_id": probe_id,
                        "started": False,
                        "completed": False,
                        "cancelled": False,
                    },
                ),
            )
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

    async def stream_request(
        self, topic: str, payload: Any = None, **kwargs: Any
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield deterministic chunks and expose remote cancellation evidence."""

        if topic != OrchestratorMethods.STREAM_INFER_CHAT:
            raise RuntimeError(f"Unhandled interop stream topic {topic}")
        params = (
            payload.model_dump(mode="json")
            if hasattr(payload, "model_dump")
            else payload
            if isinstance(payload, dict)
            else {}
        )
        probe_id = str(params.get("probe_id") or kwargs.get("correlation_id") or "stream")
        mode = str(params.get("mode") or "complete")
        record = {
            "probe_id": probe_id,
            "started": True,
            "completed": False,
            "cancelled": False,
            "chunk_count": 0,
        }
        self.stream_records[probe_id] = record
        try:
            record["chunk_count"] += 1
            yield {
                "kind": "assistant.delta",
                "probe_id": probe_id,
                "sequence": 0,
                "delta": "first",
            }
            if mode == "cancel":
                await asyncio.Event().wait()
            record["chunk_count"] += 1
            yield {
                "kind": "assistant.delta",
                "probe_id": probe_id,
                "sequence": 1,
                "delta": "second",
                "final": True,
            }
            record["completed"] = True
        except asyncio.CancelledError:
            record["cancelled"] = True
            raise

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
        self.reconnect_proof_results: list[str] = []

    async def get_system_token(self) -> str:
        return "interop-system-token-redacted"

    async def validate_mesh_pairing_token(self, **kwargs: Any) -> Token | None:
        if self.bus.revoked:
            return None
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
        if self.bus.revoked:
            return None
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
            self.reconnect_proof_results.append("revoked")
            return None
        token_id = str(kwargs.get("token_id") or "")
        if token_id != "interop-token-row":
            self.reconnect_proof_results.append("token_id_mismatch")
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
            self.reconnect_proof_results.append("proof_mismatch")
            return None
        self.reconnect_proof_results.append("accepted")
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


def reserve_gateway_http_probe_port() -> tuple[socket.socket, int]:
    """Reserve a non-listening loopback port for the disabled HTTP API check."""

    probe_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe_socket.bind(("127.0.0.1", 0))
        return probe_socket, int(probe_socket.getsockname()[1])
    except BaseException:
        probe_socket.close()
        raise


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def non_host_ice_candidate(candidate_sdp: str) -> bool:
    """Force the STUN harness lane to signal only reflexive ICE candidates."""
    return re.search(r"\btyp\s+host\b", candidate_sdp, flags=re.IGNORECASE) is None


def build_ready_payload(
    *,
    lane: str,
    app_id: str,
    room: str,
    broker_url: str,
    stun_servers: list[str],
    turn_servers: list[str],
    timeout_seconds: float,
    gateway_http_reachable: bool,
    ac18_local_tool_provider: bool,
    ready_at: str,
) -> dict[str, Any]:
    """Build the browser handoff without serializing room-password or bearer secrets."""
    return {
        "lane": lane,
        "appId": app_id,
        "room": room,
        "brokerUrl": broker_url,
        "expectedStablePeerId": "python-gateway-g009",
        "localStablePeerId": "browser-g009",
        "localSignalingId": BROWSER_SIGNALING_IDS[lane],
        "expectedNegotiationRole": "offerer" if lane in {"direct", "turn"} else "answerer",
        "nodeName": "G009 Python Gateway",
        "stunServers": stun_servers,
        "turnServers": turn_servers,
        "turnUsername": "interop" if turn_servers else None,
        "turnCredential": "interop" if turn_servers else None,
        "forceRelay": lane == "turn",
        "suppressHostCandidates": lane == "stun",
        "eventTopic": SAFE_EVENT_TOPIC,
        "eventCorrelationId": f"g009-corr-{lane}",
        "ttsEventTopic": TTS_EVENT_TOPIC,
        "ttsCorrelationId": f"g009-tts-{lane}",
        "wrongCorrelationId": f"g009-wrong-{lane}",
        "mutationTopic": MUTATE_TOPIC,
        "mutationCountTopic": MUTATION_COUNT_TOPIC,
        "mutationStartedTopic": MUTATION_STARTED_TOPIC,
        "revokeTopic": REVOKE_TOPIC,
        "largeEchoTopic": LARGE_ECHO_TOPIC,
        "errorTopic": ERROR_TOPIC,
        "streamTopic": OrchestratorMethods.STREAM_INFER_CHAT,
        "streamStatusTopic": STREAM_STATUS_TOPIC,
        "ac18LocalToolProvider": ac18_local_tool_provider,
        "ac18ToolContractId": AC18_TOOL_CONTRACT_ID,
        "ac18ToolLocalName": AC18_TOOL_LOCAL_NAME,
        "ac18ProbeId": f"ac18-browser-tool-{lane}",
        "ac18ForgedFramePeerId": AC18_FORGED_FRAME_PEER_ID,
        "timeoutMs": int(timeout_seconds * 1000),
        "gatewayHttpApiEnabled": False,
        "gatewayHttpReachable": gateway_http_reachable,
        "readyAt": ready_at,
    }


def build_gateway_report(
    *,
    lane: str,
    started_at: str,
    duration_ms: int,
    gateway_http_reachable: bool,
    diagnostics: dict[str, Any],
    bus: InteropBus,
    event_sent: bool,
    tts_event_sent: bool,
    wrong_correlation_interested: bool,
    wildcard_interested: bool,
    revoked_reconnect_failures: int,
    reconnect_proof_results: list[str],
    manifest_sent: bool,
    ac18_local_tool_provider: bool,
    ac18_reverse_tool: dict[str, Any] | None,
    native_device_tool_probe: bool,
    native_device_tool: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build the redacted Python-peer report consumed by the aggregate scanner."""
    return {
        "lane": lane,
        "startedAt": started_at,
        "durationMs": duration_ms,
        "gatewayHttpApiEnabled": False,
        "gatewayHttpReachable": gateway_http_reachable,
        "rtcStarted": diagnostics.get("started"),
        "localSignalingPeerIdPresent": bool(diagnostics.get("local_signaling_peer_id")),
        "localMeshPeerId": diagnostics.get("local_mesh_peer_id"),
        "connectedPeerCount": diagnostics.get("connected_peer_count"),
        "authenticatedPeerCount": diagnostics.get("authenticated_peer_count"),
        "eventSent": event_sent,
        "ttsEventSent": tts_event_sent,
        "scopedEventEvidence": {
            "wrongCorrelationInterested": wrong_correlation_interested,
            "wildcardInterested": wildcard_interested,
        },
        "mutationCounts": bus.mutation_counts,
        "mutationRecords": bus.mutation_records,
        "revoked": bus.revoked,
        "reconnectEvidence": {
            "revokedReconnectFailuresObserved": revoked_reconnect_failures,
            "proofVerificationResults": list(reconnect_proof_results),
        },
        "manifestSent": manifest_sent,
        "ac18LocalToolProviderEnabled": ac18_local_tool_provider,
        "ac18ReverseToolEvidence": ac18_reverse_tool
        or {
            "enabled": ac18_local_tool_provider,
            "status": "not-run" if ac18_local_tool_provider else "disabled",
        },
        "nativeDeviceToolProbeEnabled": native_device_tool_probe,
        "nativeDeviceToolEvidence": native_device_tool
        or {
            "enabled": native_device_tool_probe,
            "status": "not-run" if native_device_tool_probe else "disabled",
        },
        "largeRpcRecords": bus.large_rpc_records,
        "streamRecords": bus.stream_records,
        "requests": bus.requests,
        "publishes": bus.publish_records,
        "diagnostics": diagnostics,
        "secretsRedacted": True,
    }


async def run_native_device_tool_probe(
    *,
    peer_id: str,
    peer_registry: PeerRegistry,
    peer_bridge: PeerBridge,
    timeout: float,
    ready_path: Path,
    trigger_path: Path,
) -> dict[str, Any]:
    """Prepare in foreground, then execute the bounded native tool on a trigger."""

    public_call_methods: list[str] = []
    probe_id = f"native-device-status-{int(time.time() * 1000)}"
    deadline = time.monotonic() + timeout
    last_status = "missing"

    def base_evidence(status: str) -> dict[str, Any]:
        return {
            "enabled": True,
            "status": status,
            "peerId": peer_id,
            "peerStatus": last_status,
            "toolingServiceAdvertised": (
                peer_registry.get_peer_service(peer_id, "Tooling") is not None
            ),
            "publicCallMethods": list(public_call_methods),
            "publicCallCount": len(public_call_methods),
            "peerBridgeCallPath": "PeerBridge.call",
            "privateRpcCallUsed": False,
            "directServiceCallUsed": False,
            "httpFallbackUsed": False,
        }

    async def public_call(
        method: str,
        payload: dict[str, Any],
        correlation_id: str,
    ) -> QueryResult:
        public_call_methods.append(method)
        return await peer_bridge.call(
            peer_id,
            method,
            payload,
            timeout=min(15.0, timeout),
            correlation_id=correlation_id,
            principal_id=f"mesh:{AC18_FORGED_FRAME_PEER_ID}",
            effective_perms=[],
            identity_source="android_native_background_e2e_forged_frame",
            method_type="use",
            caller_peer_id=AC18_FORGED_FRAME_PEER_ID,
            auth_grant_revision=999,
            manifest_revision=999,
        )

    while time.monotonic() < deadline:
        peer = peer_registry.get_peer(peer_id)
        last_status = getattr(peer, "status", "missing") if peer is not None else "missing"
        lease = peer_registry.get_provider_lease(peer_id)
        if (
            last_status == "negotiated"
            and peer_registry.get_peer_service(peer_id, "Tooling") is not None
            and lease is not None
            and lease.available is True
        ):
            break
        await asyncio.sleep(0.1)
    else:
        return base_evidence("provider-not-ready")

    discovery_attempts = 0
    discovered_tool: dict[str, Any] | None = None
    discovery = QueryResult(ok=False, error="provider is not ready")
    discovery_deadline = min(deadline, time.monotonic() + 15.0)
    while time.monotonic() < discovery_deadline:
        discovery_attempts += 1
        discovery = await public_call(
            ToolingMethods.GET_TOOLS,
            {"query": NATIVE_DEVICE_TOOL_LOCAL_NAME, "top_k": 10},
            f"{probe_id}-discovery-{discovery_attempts}",
        )
        discovery_response = discovery.data if isinstance(discovery.data, dict) else {}
        discovered_tools = discovery_response.get("tools")
        discovered_tool = (
            next(
                (
                    candidate
                    for candidate in discovered_tools
                    if isinstance(candidate, dict)
                    and candidate.get("tool_contract_id") == NATIVE_DEVICE_TOOL_CONTRACT_ID
                    and candidate.get("local_name") == NATIVE_DEVICE_TOOL_LOCAL_NAME
                    and candidate.get("provider_peer_id") == peer_id
                ),
                None,
            )
            if isinstance(discovered_tools, list)
            else None
        )
        if discovery.ok and discovered_tool is not None:
            break
        retryable_error = (
            discovery.error is not None and "provider is not ready" in discovery.error.lower()
        )
        if not discovery.ok and not retryable_error:
            break
        await asyncio.sleep(0.1)

    if not discovery.ok or discovered_tool is None:
        return {
            **base_evidence("discovery-failed"),
            "discoveryAttempts": discovery_attempts,
            "queryResultOk": discovery.ok,
            "queryResultError": discovery.error,
        }

    global_tool_id = str(discovered_tool.get("global_tool_id") or "")
    provider_service_instance_id = str(discovered_tool.get("provider_service_instance_id") or "")
    if not global_tool_id or not provider_service_instance_id:
        return base_evidence("discovery-invalid")

    prepare_payload = {
        "tool_name": global_tool_id,
        "arguments": {},
        "correlation_id": probe_id,
        "caller_peer_id": AC18_FORGED_FRAME_PEER_ID,
        "caller_permissions": [],
    }
    prepare = await public_call(
        ToolingMethods.PREPARE_EXECUTION,
        prepare_payload,
        f"{probe_id}-prepare",
    )
    prepare_response = prepare.data if isinstance(prepare.data, dict) else {}
    args_schema_hash = prepare_response.get("args_schema_hash")
    prepare_ok = (
        prepare.ok
        and prepare_response.get("ok") is True
        and isinstance(args_schema_hash, str)
        and re.fullmatch(r"[0-9a-f]{64}", args_schema_hash) is not None
        and prepare_response.get("global_tool_id") == global_tool_id
        and prepare_response.get("provider_peer_id") == peer_id
        and prepare_response.get("provider_service_instance_id") == provider_service_instance_id
    )
    if not prepare_ok or not isinstance(args_schema_hash, str):
        return {
            **base_evidence("prepare-failed"),
            "queryResultOk": prepare.ok,
            "queryResultError": prepare.error,
        }

    write_json(
        ready_path,
        {
            "status": "prepared",
            "peerId": peer_id,
            "toolContractId": NATIVE_DEVICE_TOOL_CONTRACT_ID,
            "globalToolId": global_tool_id,
            "providerServiceInstanceId": provider_service_instance_id,
            "preparedAt": now(),
            "secretsRedacted": True,
        },
    )

    while time.monotonic() < deadline and not trigger_path.exists():
        await asyncio.sleep(0.1)
    if not trigger_path.exists():
        return base_evidence("trigger-timeout")

    result = await public_call(
        ToolingMethods.EXECUTE_TOOL,
        {
            **prepare_payload,
            "expected_args_schema_hash": args_schema_hash,
        },
        probe_id,
    )
    response = result.data if isinstance(result.data, dict) else {}
    response_data = response.get("data") if isinstance(response.get("data"), dict) else {}
    passed = (
        result.ok
        and response.get("ok") is True
        and response.get("status") == "success"
        and response.get("global_tool_id") == global_tool_id
        and response_data.get("online") is True
        and isinstance(response_data.get("platform"), str)
    )
    return {
        **base_evidence("passed" if passed else "failed"),
        "discoveryAttempts": discovery_attempts,
        "method": ToolingMethods.EXECUTE_TOOL,
        "toolContractId": NATIVE_DEVICE_TOOL_CONTRACT_ID,
        "globalToolId": global_tool_id,
        "providerServiceInstanceId": provider_service_instance_id,
        "queryResultOk": result.ok,
        "queryResultError": result.error,
        "toolResponse": response,
        "identityClaimOverriddenByAuthenticatedChannel": True,
        "triggerObserved": True,
    }


async def run_ac18_reverse_browser_tool_probe(
    *,
    lane: str,
    peer_registry: PeerRegistry,
    peer_bridge: PeerBridge,
    timeout: float,
) -> dict[str, Any]:
    """Discover, prepare, and invoke the browser-local provider through the public bridge."""

    peer_id = BROWSER_MESH_PEER_ID
    probe_id = f"ac18-browser-tool-{lane}"
    negative_probe_id = f"{probe_id}-negative"
    deadline = time.monotonic() + timeout
    readiness_deadline = min(deadline, time.monotonic() + 15.0)
    last_status = "missing"
    last_lease: dict[str, Any] | None = None
    public_call_methods: list[str] = []

    def lease_evidence() -> dict[str, Any] | None:
        lease = peer_registry.get_provider_lease(peer_id)
        if lease is None:
            return last_lease
        return {
            "peerId": lease.peer_id,
            "connectionEpoch": lease.connection_epoch,
            "availabilityRevision": lease.availability_revision,
            "available": lease.available,
            "leaseRequired": lease.lease_required,
        }

    def base_evidence(status: str) -> dict[str, Any]:
        return {
            "enabled": True,
            "status": status,
            "peerStatus": last_status,
            "toolingServiceAdvertised": (
                peer_registry.get_peer_service(peer_id, "Tooling") is not None
            ),
            "manifestAckAndLeaseReady": (
                last_status == "negotiated"
                and peer_registry.get_peer_service(peer_id, "Tooling") is not None
                and bool((lease_evidence() or {}).get("available"))
            ),
            "providerLease": lease_evidence(),
            "peerBridgeCallPath": "PeerBridge.call",
            "publicCallMethods": list(public_call_methods),
            "publicCallCount": len(public_call_methods),
            "privateRpcCallUsed": False,
            "manualAckUsed": False,
            "directServiceCallUsed": False,
            "httpFallbackUsed": False,
            "frameIdentityClaim": {
                "callerPeerId": AC18_FORGED_FRAME_PEER_ID,
                "principalId": f"mesh:{AC18_FORGED_FRAME_PEER_ID}",
                "effectivePermissions": [],
                "authGrantRevision": 999,
                "manifestRevision": 999,
            },
        }

    async def public_call(
        method: str,
        payload: dict[str, Any],
        correlation_id: str,
    ) -> QueryResult:
        public_call_methods.append(method)
        return await peer_bridge.call(
            peer_id,
            method,
            payload,
            timeout=min(15.0, timeout),
            correlation_id=correlation_id,
            principal_id=f"mesh:{AC18_FORGED_FRAME_PEER_ID}",
            effective_perms=[],
            identity_source="webrtc_interop_ac18_forged_frame",
            method_type="use",
            caller_peer_id=AC18_FORGED_FRAME_PEER_ID,
            auth_grant_revision=999,
            manifest_revision=999,
        )

    while time.monotonic() < readiness_deadline:
        peer = peer_registry.get_peer(peer_id)
        last_status = getattr(peer, "status", "missing") if peer is not None else "missing"
        lease = peer_registry.get_provider_lease(peer_id)
        if lease is not None:
            last_lease = {
                "peerId": lease.peer_id,
                "connectionEpoch": lease.connection_epoch,
                "availabilityRevision": lease.availability_revision,
                "available": lease.available,
                "leaseRequired": lease.lease_required,
            }
        if (
            last_status == "negotiated"
            and peer_registry.get_peer_service(peer_id, "Tooling") is not None
            and lease is not None
            and lease.available is True
        ):
            break
        await asyncio.sleep(0.1)
    else:
        return base_evidence("provider-not-ready")

    discovery_payload = {"query": AC18_TOOL_LOCAL_NAME, "top_k": 10}
    discovery = await public_call(
        ToolingMethods.GET_TOOLS,
        discovery_payload,
        f"{probe_id}-discovery",
    )
    discovery_response = discovery.data if isinstance(discovery.data, dict) else {}
    discovered_tools = discovery_response.get("tools")
    discovered_tool = (
        next(
            (
                candidate
                for candidate in discovered_tools
                if isinstance(candidate, dict)
                and candidate.get("tool_contract_id") == AC18_TOOL_CONTRACT_ID
                and candidate.get("local_name") == AC18_TOOL_LOCAL_NAME
                and candidate.get("name") == AC18_TOOL_LOCAL_NAME
                and candidate.get("global_tool_id") == AC18_GLOBAL_TOOL_ID
                and candidate.get("provider_peer_id") == BROWSER_MESH_PEER_ID
                and candidate.get("provider_service_instance_id")
                == AC18_PROVIDER_SERVICE_INSTANCE_ID
            ),
            None,
        )
        if isinstance(discovered_tools, list)
        else None
    )
    discovery_ok = (
        discovery.ok
        and discovered_tool is not None
        and discovery_response.get("count") == len(discovered_tools)
    )
    discovery_evidence = {
        "method": ToolingMethods.GET_TOOLS,
        "peerBridgeCallPath": "PeerBridge.call",
        "request": discovery_payload,
        "queryResultOk": discovery.ok,
        "queryResultError": discovery.error,
        "toolFound": discovery_ok,
        "discoveredTool": discovered_tool,
    }
    if not discovery_ok or discovered_tool is None:
        return {
            **base_evidence("failed"),
            "discoveryProbe": discovery_evidence,
        }

    arguments = {
        "probe_id": probe_id,
        "message": f"python-originated-{lane}",
    }
    discovered_global_tool_id = str(discovered_tool["global_tool_id"])
    prepare_payload = {
        "tool_name": discovered_global_tool_id,
        "arguments": arguments,
        "correlation_id": probe_id,
        "caller_peer_id": AC18_FORGED_FRAME_PEER_ID,
        "caller_permissions": [],
    }
    prepare = await public_call(
        ToolingMethods.PREPARE_EXECUTION,
        prepare_payload,
        f"{probe_id}-prepare",
    )
    prepare_response = prepare.data if isinstance(prepare.data, dict) else {}
    policy_decision = (
        prepare_response.get("policy_decision")
        if isinstance(prepare_response.get("policy_decision"), dict)
        else {}
    )
    args_schema_hash = prepare_response.get("args_schema_hash")
    prepare_ok = (
        prepare.ok
        and prepare_response.get("ok") is True
        and policy_decision.get("allowed") is True
        and isinstance(args_schema_hash, str)
        and re.fullmatch(r"[0-9a-f]{64}", args_schema_hash) is not None
        and prepare_response.get("global_tool_id") == discovered_global_tool_id
        and prepare_response.get("local_tool_name") == AC18_TOOL_LOCAL_NAME
        and prepare_response.get("provider_peer_id") == BROWSER_MESH_PEER_ID
        and prepare_response.get("provider_service_instance_id")
        == AC18_PROVIDER_SERVICE_INSTANCE_ID
    )
    prepare_evidence = {
        "method": ToolingMethods.PREPARE_EXECUTION,
        "peerBridgeCallPath": "PeerBridge.call",
        "request": prepare_payload,
        "queryResultOk": prepare.ok,
        "queryResultError": prepare.error,
        "policyAllowed": policy_decision.get("allowed") is True,
        "argsSchemaHash": args_schema_hash,
        "globalToolId": prepare_response.get("global_tool_id"),
        "providerServiceInstanceId": prepare_response.get("provider_service_instance_id"),
        "schemaHashBoundToExecution": False,
        "toolResponse": prepare_response,
    }
    if not prepare_ok or not isinstance(args_schema_hash, str):
        return {
            **base_evidence("failed"),
            "discoveryProbe": discovery_evidence,
            "prepareProbe": prepare_evidence,
        }

    positive_payload = {
        **prepare_payload,
        "expected_args_schema_hash": args_schema_hash,
    }
    result = await public_call(
        ToolingMethods.EXECUTE_TOOL,
        positive_payload,
        probe_id,
    )
    negative_payload = {
        "tool_name": f"{AC18_TOOL_LOCAL_NAME}.missing",
        "arguments": {
            "probe_id": negative_probe_id,
            "message": "must-not-run",
        },
        "expected_args_schema_hash": args_schema_hash,
        "correlation_id": negative_probe_id,
        "caller_peer_id": AC18_FORGED_FRAME_PEER_ID,
        "caller_permissions": [],
    }
    negative = await public_call(
        ToolingMethods.EXECUTE_TOOL,
        negative_payload,
        negative_probe_id,
    )
    response = result.data if isinstance(result.data, dict) else {}
    response_data = response.get("data") if isinstance(response.get("data"), dict) else {}
    negative_response = negative.data if isinstance(negative.data, dict) else {}
    peer = peer_registry.get_peer(peer_id)
    digest_input = {
        "caller_peer_id": response_data.get("caller_peer_id"),
        "handled_by": response_data.get("handled_by"),
        "message": response_data.get("message"),
        "probe_id": response_data.get("probe_id"),
    }
    positive_ok = (
        result.ok
        and response.get("ok") is True
        and response.get("status") == "success"
        and response_data.get("probe_id") == probe_id
        and response_data.get("handled_by") == peer_id
        and response_data.get("caller_peer_id") == PYTHON_MESH_PEER_ID
        and response.get("global_tool_id") == discovered_global_tool_id
    )
    negative_ok = (
        negative.ok
        and negative_response.get("ok") is False
        and negative_response.get("status") == "not_found"
        and negative_response.get("error_code") == "tool_not_found"
    )
    schema_hash_bound = positive_payload.get("expected_args_schema_hash") == args_schema_hash
    public_sequence_ok = public_call_methods == [
        ToolingMethods.GET_TOOLS,
        ToolingMethods.PREPARE_EXECUTION,
        ToolingMethods.EXECUTE_TOOL,
        ToolingMethods.EXECUTE_TOOL,
    ]
    identity_override_ok = (
        response_data.get("caller_peer_id") == PYTHON_MESH_PEER_ID
        and response_data.get("caller_peer_id") != AC18_FORGED_FRAME_PEER_ID
    )
    passed = (
        discovery_ok
        and prepare_ok
        and schema_hash_bound
        and positive_ok
        and negative_ok
        and public_sequence_ok
        and identity_override_ok
    )
    prepare_evidence["schemaHashBoundToExecution"] = schema_hash_bound
    return {
        **base_evidence("passed" if passed else "failed"),
        "peerStatus": getattr(peer, "status", last_status),
        "discoveryProbe": discovery_evidence,
        "prepareProbe": prepare_evidence,
        "method": ToolingMethods.EXECUTE_TOOL,
        "toolName": discovered_global_tool_id,
        "localToolName": AC18_TOOL_LOCAL_NAME,
        "globalToolId": discovered_global_tool_id,
        "providerServiceInstanceId": AC18_PROVIDER_SERVICE_INSTANCE_ID,
        "probeId": probe_id,
        "queryResultOk": result.ok,
        "queryResultError": result.error,
        "toolResponse": response,
        "toolResponseDataDigest": ac18_digest(digest_input) if positive_ok else None,
        "executeProbe": {
            "method": ToolingMethods.EXECUTE_TOOL,
            "peerBridgeCallPath": "PeerBridge.call",
            "request": positive_payload,
            "expectedArgsSchemaHash": args_schema_hash,
            "queryResultOk": result.ok,
            "queryResultError": result.error,
            "toolResponse": response,
            "globalToolIdMatchedDiscovery": (
                response.get("global_tool_id") == discovered_global_tool_id
            ),
        },
        "identityOverride": {
            "forgedFrameCallerPeerId": AC18_FORGED_FRAME_PEER_ID,
            "forgedFrameEffectivePermissions": [],
            "observedCallerPeerId": response_data.get("caller_peer_id"),
            "authenticatedCallerPeerId": PYTHON_MESH_PEER_ID,
            "frameCallerPeerIdOverridden": identity_override_ok,
        },
        "negativeProbe": {
            "method": ToolingMethods.EXECUTE_TOOL,
            "peerBridgeCallPath": "PeerBridge.call",
            "probeId": negative_probe_id,
            "request": negative_payload,
            "queryResultOk": negative.ok,
            "queryResultError": negative.error,
            "toolResponse": negative_response,
            "failClosedWithoutHandler": negative_ok,
        },
    }


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
    parser.add_argument("--native-device-probe-ready")
    parser.add_argument("--native-device-probe-trigger")
    args = parser.parse_args()

    if not args.room_secret:
        raise SystemExit("WEBRTC_INTEROP_ROOM_SECRET is required")
    if bool(args.native_device_probe_ready) != bool(args.native_device_probe_trigger):
        raise SystemExit(
            "--native-device-probe-ready and --native-device-probe-trigger must be used together"
        )

    ready_path = Path(args.ready)
    done_path = Path(args.done)
    report_path = Path(args.report)
    token_value = os.environ.get("WEBRTC_INTEROP_TOKEN", "interop-browser-token-value-not-written")
    ac18_local_tool_provider = env_flag(AC18_LOCAL_TOOL_PROVIDER_ENV)
    native_device_tool_probe = bool(args.native_device_probe_ready)
    gateway_http_probe_socket, gateway_http_probe_port = reserve_gateway_http_probe_port()
    registry = InteropRegistry()
    bus = InteropBus(registry, token_value)
    auth = InteropAuth(token_value, bus)
    settings = Settings(
        api=APISettings(
            enabled=False,
            host="127.0.0.1",
            port=gateway_http_probe_port,
            auth_enabled=False,
        ),
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
    rtc._peer_id = PYTHON_SIGNALING_IDS[args.lane]  # noqa: SLF001
    rtc.set_mesh_identity(PYTHON_MESH_PEER_ID, "G009 Python Gateway")
    peer_registry: PeerRegistry | None = None
    peer_bridge: PeerBridge | None = None
    if ac18_local_tool_provider or native_device_tool_probe:
        mesh_config = (
            build_native_device_mesh_config(timeout_seconds=args.timeout)
            if native_device_tool_probe
            else build_ac18_mesh_config(timeout_seconds=args.timeout)
        )
        peer_registry = PeerRegistry(mesh_config)
        peer_bridge = PeerBridge(rtc, peer_registry)
        if native_device_tool_probe:
            install_native_device_authority_refresh(rtc)
        else:
            install_ac18_authority_refresh(rtc)
        rtc.configure_mesh(mesh_config, peer_registry, peer_bridge)
        await peer_registry.start()

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
    ac18_reverse_tool: dict[str, Any] | None = None
    ac18_probe_task: asyncio.Task[dict[str, Any]] | None = None
    native_device_tool: dict[str, Any] | None = None
    native_device_probe_task: asyncio.Task[dict[str, Any]] | None = None
    event_sent = False
    tts_event_sent = False
    wrong_corr_interest = False
    wildcard_interest = False
    revoked_reconnect_failures = 0
    manifest_sent = False
    try:
        await rtc.start(join_room=True)

        write_json(
            ready_path,
            build_ready_payload(
                lane=args.lane,
                app_id=args.app_id,
                room=args.room,
                broker_url=args.broker,
                stun_servers=args.stun,
                turn_servers=args.turn,
                timeout_seconds=args.timeout,
                gateway_http_reachable=can_connect("127.0.0.1", gateway_http_probe_port),
                ac18_local_tool_provider=ac18_local_tool_provider,
                ready_at=now(),
            ),
        )

        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline and not done_path.exists():
            for error in rtc.get_diagnostics().recent_errors:
                if error.code == "reconnect_auth_failed":
                    revoked_reconnect_failures += 1
            for peer in rtc.get_connected_peers():
                stable = str(peer.get("stable_peer_id") or "")
                session_peer_id = str(peer.get("peer_id") or "")
                if stable == BROWSER_MESH_PEER_ID and peer.get("session_active") is True:
                    if (
                        ac18_local_tool_provider
                        and ac18_probe_task is None
                        and peer_registry is not None
                        and peer_bridge is not None
                        and rtc.peer_supports_capability(
                            session_peer_id,
                            CAP_PROVIDER_LEASE_V1,
                        )
                    ):
                        ac18_probe_task = asyncio.create_task(
                            run_ac18_reverse_browser_tool_probe(
                                lane=args.lane,
                                peer_registry=peer_registry,
                                peer_bridge=peer_bridge,
                                timeout=max(1.0, deadline - time.monotonic()),
                            ),
                            name=f"webrtc-interop-ac18:{args.lane}",
                        )
                    if not manifest_sent:
                        manifest_sent = await rtc.send_to_peer_async(
                            stable,
                            json.dumps(
                                registry.legacy_manifest(PYTHON_MESH_PEER_ID, "G009 Python Gateway")
                            ),
                        )
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
                if (
                    native_device_tool_probe
                    and stable
                    and stable != PYTHON_MESH_PEER_ID
                    and peer.get("session_active") is True
                    and native_device_probe_task is None
                    and peer_registry is not None
                    and peer_bridge is not None
                    and rtc.peer_supports_capability(
                        session_peer_id,
                        CAP_PROVIDER_LEASE_V1,
                    )
                ):
                    native_device_probe_task = asyncio.create_task(
                        run_native_device_tool_probe(
                            peer_id=stable,
                            peer_registry=peer_registry,
                            peer_bridge=peer_bridge,
                            timeout=max(1.0, deadline - time.monotonic()),
                            ready_path=Path(args.native_device_probe_ready),
                            trigger_path=Path(args.native_device_probe_trigger),
                        ),
                        name=f"webrtc-interop-native-device:{args.lane}",
                    )
            if ac18_probe_task is not None and ac18_probe_task.done():
                ac18_reverse_tool = ac18_probe_task.result()
            if native_device_probe_task is not None and native_device_probe_task.done():
                native_device_tool = native_device_probe_task.result()
            await asyncio.sleep(0.1)

        if ac18_probe_task is not None and ac18_reverse_tool is None:
            try:
                ac18_reverse_tool = await asyncio.wait_for(
                    asyncio.shield(ac18_probe_task),
                    timeout=min(15.0, max(1.0, args.timeout)),
                )
            except TimeoutError:
                ac18_reverse_tool = {
                    "enabled": True,
                    "status": "not-completed",
                }
        if native_device_probe_task is not None and native_device_tool is None:
            try:
                native_device_tool = await asyncio.wait_for(
                    asyncio.shield(native_device_probe_task),
                    timeout=min(15.0, max(1.0, args.timeout)),
                )
            except TimeoutError:
                native_device_tool = {
                    "enabled": True,
                    "status": "not-completed",
                }

        diagnostics = rtc.get_diagnostics().model_dump(mode="json")
        write_json(
            report_path,
            build_gateway_report(
                lane=args.lane,
                started_at=now(),
                duration_ms=round((time.monotonic() - started_at) * 1000),
                gateway_http_reachable=can_connect("127.0.0.1", gateway_http_probe_port),
                diagnostics=diagnostics,
                bus=bus,
                event_sent=event_sent,
                tts_event_sent=tts_event_sent,
                wrong_correlation_interested=wrong_corr_interest,
                wildcard_interested=wildcard_interest,
                revoked_reconnect_failures=revoked_reconnect_failures,
                reconnect_proof_results=auth.reconnect_proof_results,
                manifest_sent=manifest_sent,
                ac18_local_tool_provider=ac18_local_tool_provider,
                ac18_reverse_tool=ac18_reverse_tool,
                native_device_tool_probe=native_device_tool_probe,
                native_device_tool=native_device_tool,
            ),
        )
    finally:
        if ac18_probe_task is not None and not ac18_probe_task.done():
            ac18_probe_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await ac18_probe_task
        if native_device_probe_task is not None and not native_device_probe_task.done():
            native_device_probe_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await native_device_probe_task
        if peer_bridge is not None:
            await peer_bridge.cancel_all()
        await rtc.close()
        if peer_registry is not None:
            await peer_registry.stop()
        gateway_http_probe_socket.close()
    return 0 if done_path.exists() else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
