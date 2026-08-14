"""Gateway Service for Aurora.

Provides an HTTP/WebSocket gateway to the Aurora message bus using FastAPI and Uvicorn.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import math
import os
import re
import secrets
import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging.audio_messages import AudioTopics
from app.messaging.bus import Envelope
from app.messaging.priority_helpers import get_interactive_priority
from app.services.gateway.admin_action import AdminActionManager
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import (
    Auth as AuthConfigModel,
    Gateway as GatewayConfigModel,
    MeshRouting,
    MeshSharing,
)
from app.shared.contracts.models.aurora import AuroraMethods
from app.shared.contracts.models.auth import (
    AuditLogRequest,
    AuthMethods,
    StoreAuditEventRequest,
)
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.db import (
    DBActivateToolingMeshEnforcementRequest,
    DBMethods,
    DBToolingMeshActivationComponentVersions,
)
from app.shared.contracts.models.gateway import (
    AdminActionConfirmRequest,
    AdminActionConfirmResponse,
    AdminActionDraftRequest,
    AdminActionDraftResponse,
    BusHealth,
    CapabilityCatalogRequest,
    CapabilityCatalogResponse,
    CapabilityCatalogSummary,
    CapabilityGraph,
    ContainerTopologyHints,
    DeploymentTopologyResponse,
    GatewayCancelMeshInferChatStreamRequest,
    GatewayCancelMeshInferChatStreamResponse,
    GatewayEventStreamEvent,
    GatewayFetchToolingExportCatalogPageRequest,
    GatewayFetchToolingExportCatalogPageResponse,
    GatewayListEventsRequest,
    GatewayListEventsResponse,
    GatewayMeshInferChatChunkEvent,
    GatewayMeshInferChatRequest,
    GatewayMeshInferChatResponse,
    GatewayMethods,
    GatewayStreamMeshInferChatStartRequest,
    GatewayStreamMeshInferChatStartResponse,
    GatewaySupportBundleRequest,
    GatewaySupportBundleResponse,
    GetMeshInviteConfigResponse,
    GetMeshStatusResponse,
    GetRegistryResponse,
    GetServiceHealthRequest,
    GetServiceHealthResponse,
    GetServicesResponse,
    MeshCompatibilityFailure,
    MeshLocalStatus,
    MeshPeerCompatibilityDiagnostic,
    MeshPeerDiagnostic,
    MeshPeerServiceDiagnostic,
    MeshRevisionDiagnostic,
    MeshRolloutMetricsSnapshot,
    MeshRouteDiagnostic,
    MeshRouteProviderDiagnostic,
    MeshServiceCompatibilityDiagnostic,
    MeshServiceExportSummary,
    MeshServiceRoutingSummary,
    RouteExplainRequest,
    RouteExplainResponse,
    ServiceInfo,
    ServiceProcessTopology,
    SupportBundleDiagnosticItem,
    SupportBundleRedactionInfo,
    WebRTCDiagnosticsResponse,
)
from app.shared.contracts.models.mesh import (
    MeshEvents,
    MeshPeerAuthorityChangedEvent,
    MeshPeerAuthoritySnapshot,
    MeshPeerAuthoritySnapshotRequest,
    MeshPeerAuthoritySnapshotResponse,
)
from app.shared.contracts.models.orchestrator import (
    OrchestratorInferChatChunk,
    OrchestratorInferChatResponse,
    OrchestratorMethods,
)
from app.shared.contracts.models.scheduler import SchedulerMethods
from app.shared.contracts.models.stt import STTMethods, TranscriptionMethods, WakeWordMethods
from app.shared.contracts.models.tooling import (
    ToolingGetExportCatalogResponse,
    ToolingGetToolExportPolicyRequest,
    ToolingGetToolExportPolicyResponse,
    ToolingMeshEnforcementActivated,
    ToolingMeshProjectionReadiness,
    ToolingMethods,
    ToolingProjectionInvalidated,
    ToolingProjectionSyncRequested,
)
from app.shared.contracts.models.tts import TTSMethods
from app.shared.contracts.registry import method_contract
from app.shared.mesh.observability import (
    MeshRolloutMetrics,
    canonical_mesh_rollout_reason,
)
from app.shared.mesh.tracing import get_payload_correlation_id
from app.shared.services.base_service import BaseService

_EVENT_STREAM_MAXLEN = 500
_DIAGNOSTIC_REDACT_KEY_PARTS = (
    "api_key",
    "apikey",
    "args",
    "argument",
    "audio",
    "auth",
    "bearer",
    "clone",
    "content",
    "cookie",
    "credential",
    "data",
    "directory",
    "file",
    "input",
    "jwt",
    "key",
    "message",
    "model",
    "output",
    "password",
    "path",
    "prompt",
    "profile_state",
    "query",
    "rag",
    "redis_url",
    "reference",
    "response",
    "result",
    "safetensors",
    "sample",
    "secret",
    "speech",
    "text",
    "token",
    "transcript",
    "url",
)
_SUPPORT_BUNDLE_OMITTED_PAYLOADS = (
    "raw audio",
    "unredacted tool arguments",
    "RAG contents",
    "tokens and credentials",
    "raw catalog schemas and projection cursors",
    "newly hidden tool names",
    "signaling room credentials",
    "migration backup contents and host paths",
    "downloaded speech files and cache paths",
    "voice clone state files and private samples",
)
_LIVE_SECRET_VALUE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)bearer\s+[a-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[^'\"\s]+"),
    re.compile(r"\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b"),
)
_MESH_START_RETRY_INITIAL_DELAY_S = 1.0
_MESH_START_RETRY_MAX_DELAY_S = 30.0


class _MeshStartOutcome(Enum):
    STARTED = "started"
    SKIPPED = "skipped"
    RETRY = "retry"


def _mesh_connection_status(registry_status: str) -> str:
    """Translate internal peer-registry states to the persisted connection contract."""
    return (
        "connected"
        if registry_status in {"authenticated", "negotiated", "provider_unavailable"}
        else "disconnected"
    )


def _tooling_service_instance_ids(stable_peer_id: str) -> frozenset[str]:
    """Return the exact service identities one authenticated Tooling peer may claim."""

    return frozenset(
        {
            f"remote:{stable_peer_id}:Tooling",
            f"local:{quote(stable_peer_id, safe='-._~')}:Tooling",
        }
    )


@dataclass(frozen=True, slots=True)
class _MeshAuthorityReconcileResult:
    success: bool
    reannounce_peers: tuple[str, ...] = ()

    def __bool__(self) -> bool:
        return self.success


def _config_secret_plain(val: Any) -> Any:
    if val is None:
        return None
    if hasattr(val, "get_secret_value"):
        return val.get_secret_value()
    return val


def _redact_url(url: str | None) -> str | None:
    """Redact credentials and host detail from a dependency URL."""
    if not url:
        return None
    try:
        parsed = urlsplit(url)
    except Exception:
        return "redacted://<invalid>"
    scheme = parsed.scheme or "redis"
    host_hint = parsed.hostname or "configured-host"
    port = f":{parsed.port}" if parsed.port else ""
    path = parsed.path if parsed.path not in {"", "/"} else ""
    return urlunsplit((scheme, f"<redacted>@{host_hint}{port}", path, "", ""))


def _bus_backend_name(bus: Any) -> str:
    inner = getattr(bus, "_inner", None)
    if inner is not None:
        return f"{bus.__class__.__name__}({inner.__class__.__name__})"
    return bus.__class__.__name__


def _bus_health_target(bus: Any) -> Any:
    return getattr(bus, "_inner", bus)


def _compose_service_hint(module: str) -> str | None:
    """Map public service modules to sanitized Compose service names."""
    return {
        "Auth": "auth-service",
        "Backup": "backup-service",
        "Config": "config-service",
        "DB": "db-service",
        "Gateway": "gateway-service",
        "Orchestrator": "orchestrator-service",
        "Scheduler": "scheduler-service",
        "STTCoordinator": "stt-coordinator-service",
        "TTS": "tts-service",
        "Tooling": "tooling-service",
        "Transcription": "stt-transcription-service",
        "WakeWord": "stt-wakeword-service",
    }.get(module)


def _finite_float(value: float | None) -> float | None:
    if value is None:
        return None
    if not math.isfinite(value):
        return None
    return float(value)


def _age_seconds(now: float, timestamp: float | None) -> float | None:
    if not timestamp or timestamp <= 0:
        return None
    return max(now - timestamp, 0.0)


def _policy_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    return tuple(str(item) for item in value)


def _policy_tuple_or_none(value: Any) -> tuple[str, ...] | None:
    if value is None:
        return None
    return _policy_tuple(value)


def _raw_child(raw_services: dict[str, Any], path: tuple[str, ...]) -> dict[str, Any] | None:
    value: Any = raw_services
    for part in path:
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value if isinstance(value, dict) else None


def _raw_contains_key(raw_services: dict[str, Any], path: tuple[str, ...], key: str) -> bool:
    service = _raw_child(raw_services, path)
    return isinstance(service, dict) and key in service


def _mesh_service_policy_from_raw(
    *,
    sharing_raw: dict[str, Any] | None,
    routing_raw: dict[str, Any] | None,
    routing_present: bool,
) -> Any:
    from app.services.gateway.config import (
        MeshServiceExportPolicy,
        MeshServicePolicy,
        MeshServiceRoutingPolicy,
    )

    sharing_model = MeshSharing.model_validate(sharing_raw or {})
    sharing_data = sharing_model.model_dump(mode="python")
    export = MeshServiceExportPolicy(
        share=bool(sharing_data.get("share") or False),
        max_concurrent=int(sharing_data.get("max_concurrent") or 0),
        unshared_feature_ids=_policy_tuple(sharing_data.get("unshared_feature_ids")),
        unshared_method_ids=_policy_tuple(sharing_data.get("unshared_method_ids")),
    )
    legacy_inbound = _policy_tuple_or_none(sharing_data.get("allowed_peers"))

    if routing_present and routing_raw is not None:
        routing_data = MeshRouting.model_validate(routing_raw).model_dump(mode="python")
    else:
        routing_data = {
            "allowed_provider_peer_ids": sharing_data.get("allowed_peers"),
            "prefer": sharing_data.get("prefer"),
            "fallback": sharing_data.get("fallback"),
            "min_version": sharing_data.get("min_version"),
            "required_provider_feature_ids": [],
            "required_provider_capability_tags": sharing_data.get("required_capabilities"),
            "require_explicit_selector": sharing_data.get("require_explicit_selector"),
        }

    routing = MeshServiceRoutingPolicy(
        allowed_provider_peer_ids=_policy_tuple_or_none(
            routing_data.get("allowed_provider_peer_ids")
        ),
        prefer=str(routing_data.get("prefer") or "local"),
        fallback=str(routing_data.get("fallback") or "local"),
        min_version=routing_data.get("min_version"),
        required_provider_feature_ids=_policy_tuple(
            routing_data.get("required_provider_feature_ids")
        ),
        required_provider_capability_tags=_policy_tuple(
            routing_data.get("required_provider_capability_tags")
        ),
        require_explicit_selector=bool(routing_data.get("require_explicit_selector") or False),
    )
    return MeshServicePolicy(
        export=export,
        routing=routing,
        legacy_inbound_allowed_peer_ids=legacy_inbound,
    )


def _peer_service(peer: Any, module: str) -> Any | None:
    manifest = getattr(peer, "manifest", None)
    if not manifest:
        return None
    for svc in manifest.shared_services:
        if svc.module == module:
            return svc
    return None


def _first_advertised_topic(registry: Any, module: str) -> str | None:
    if not registry:
        return None
    for peer in registry.get_all_peers():
        service = _peer_service(peer, module)
        if not service:
            continue
        for method in service.methods:
            if method.bus_topic:
                return method.bus_topic
    return None


def _route_reason(
    *,
    module: str,
    config: Any | None,
    decision_target: str,
    providers: list[MeshRouteProviderDiagnostic],
    selected_peer_id: str | None,
    peer_selection: str,
) -> str:
    if config is None:
        return "no mesh routing config; local delivery is used"
    routing = config.routing
    if routing.prefer == "local_only":
        return "configured local_only"
    if routing.prefer == "local":
        return "configured local preference"
    if decision_target == "remote" and selected_peer_id:
        return f"selected peer {selected_peer_id} using {peer_selection} policy"
    if decision_target == "local":
        if not providers:
            return f"no peer advertises {module}; fallback={routing.fallback} selected local"
        rejected = [p.reason for p in providers if not p.eligible]
        detail = "; ".join(sorted(set(rejected))) if rejected else "no eligible remote provider"
        return f"{detail}; fallback={routing.fallback} selected local"
    if decision_target == "error":
        return "no eligible remote provider and fallback=error"
    if decision_target == "none":
        return "no eligible remote provider and local fallback is disabled"
    return f"route target is {decision_target}"


def _exact_service_routing_summary(
    *,
    module: str,
    mesh_config: Any,
    registry: Any,
    policy_snapshot: Any,
) -> MeshServiceRoutingSummary:
    """Aggregate G008 exact-topic decisions without inventing a diagnostic topic."""

    config = mesh_config.services.get(module)
    eligible_provider_ids: list[str] = []
    ineligible_provider_ids: list[str] = []
    denial_reasons: set[str] = set()
    if registry is not None:
        captured_at = time.monotonic()
        for peer in sorted(registry.get_all_peers(), key=lambda item: item.peer_id):
            service = _peer_service(peer, module)
            if service is None:
                continue
            topics = sorted({method.bus_topic for method in service.methods if method.bus_topic})
            decisions = [
                registry.evaluate_provider_for_topic(
                    peer=peer,
                    module=module,
                    topic=topic,
                    routing_config=config,
                    policy_snapshot=policy_snapshot,
                    version_policy=mesh_config.version_policy,
                    captured_at=captured_at,
                )
                for topic in topics
            ]
            if any(decision.eligible for decision in decisions):
                eligible_provider_ids.append(peer.peer_id)
            else:
                ineligible_provider_ids.append(peer.peer_id)
            denial_reasons.update(
                decision.reason_code for decision in decisions if not decision.eligible
            )
            if not decisions:
                denial_reasons.add("method_not_advertised")

    return MeshServiceRoutingSummary(
        service_id=module,
        configured=config is not None,
        prefer=config.routing.prefer if config else "",
        fallback=config.routing.fallback if config else "",
        policy_revision=policy_snapshot.revision,
        eligible_provider_ids=eligible_provider_ids,
        ineligible_provider_ids=ineligible_provider_ids,
        reason_codes=sorted(denial_reasons),
    )


def _mesh_revision_from_ack(ack: Any | None) -> MeshRevisionDiagnostic:
    if ack is None:
        return MeshRevisionDiagnostic()
    return MeshRevisionDiagnostic(
        active_protocol=ack.active_protocol or "",
        active_version=ack.active_version or "",
        active_tier=ack.active_tier or "",
        protocol_revision=ack.protocol_revision,
        registry_revision=ack.registry_revision or "",
        export_policy_revision=ack.export_policy_revision or "",
        auth_grant_revision=ack.auth_grant_revision,
        projection_digest=ack.projection_digest or "",
    )


def _mesh_service_compatibility_from_ack(
    ack: Any | None,
) -> list[MeshServiceCompatibilityDiagnostic]:
    if ack is None:
        return []
    return [
        MeshServiceCompatibilityDiagnostic(
            service_id=item.service_id,
            service_label="",
            status=item.status,
            reason_codes=list(item.reason_codes),
            reason=_safe_compatibility_reason(item.status, list(item.reason_codes)),
        )
        for item in ack.services
    ]


def _safe_compatibility_reason(status: str, reason_codes: list[str]) -> str:
    if status == "compatible":
        return "service has an eligible advertised method"
    if status == "unused":
        return "service is not enabled for outbound routing"
    if reason_codes:
        return f"service is ineligible: {', '.join(reason_codes)}"
    return "service is ineligible"


def _compatibility_failures_for_peer(
    peer_id: str,
    services: list[MeshServiceCompatibilityDiagnostic],
    legacy_incompatible: list[str],
    direction: str,
) -> list[MeshCompatibilityFailure]:
    failures: list[MeshCompatibilityFailure] = []
    structured_ids = {service.service_id for service in services}
    for service in services:
        if service.status != "incompatible":
            continue
        reason_codes = service.reason_codes or ["legacy_unverifiable"]
        failures.extend(
            MeshCompatibilityFailure(
                peer_id=peer_id,
                module=service.service_id,
                direction=direction,
                reason_code=reason_code,
                reason=service.reason or reason_code,
            )
            for reason_code in reason_codes
        )
    failures.extend(
        MeshCompatibilityFailure(
            peer_id=peer_id,
            module=service_id,
            direction=direction,
            reason_code="legacy_unverifiable",
            reason="legacy manifest ACK did not include a structured compatibility reason",
        )
        for service_id in legacy_incompatible
        if service_id not in structured_ids
    )
    return failures


def _event_from_envelope(envelope: Envelope) -> GatewayEventStreamEvent:
    payload = _payload_dict(envelope.payload)
    redacted_payload = _diagnostic_redacted_copy(payload)
    correlation_id = (
        envelope.correlation_id
        or get_payload_correlation_id(envelope.payload)
        or _string_value(payload, "correlation_id")
    )
    return GatewayEventStreamEvent(
        event_id=str(uuid.uuid4()),
        topic=envelope.type,
        kind=_event_kind(envelope.type, payload),
        category=_event_category(envelope.type, payload),
        action=_event_action(envelope.type, payload),
        status=_event_status(envelope.type, payload),
        severity=_event_severity(envelope.type, payload),
        timestamp=envelope.timestamp.isoformat(),
        correlation_id=correlation_id,
        source_peer_id=_first_string(
            payload,
            "source_peer_id",
            "caller_peer_id",
            "peer_id",
            "owner_peer_id",
        ),
        target_peer_id=_first_string(
            payload,
            "target_peer_id",
            "provider_peer_id",
            "target_peer",
        ),
        provider_id=_first_string(
            payload,
            "provider_id",
            "provider_service_instance_id",
            "service_instance_id",
        ),
        tool_id=_first_string(payload, "global_tool_id", "tool_id", "tool_name"),
        resource_id=_first_string(payload, "resource_id", "resource_namespace", "namespace"),
        route=_first_string(payload, "route", "route_target", "selected_target"),
        policy_decision_id=_first_string(payload, "policy_decision_id", "decision_id"),
        principal_id=envelope.principal_id
        or _first_string(payload, "principal_id", "caller_principal_id", "owner_principal_id"),
        redacted_payload=redacted_payload if isinstance(redacted_payload, dict) else {},
        payload_sha256=_payload_hash(redacted_payload),
    )


def _live_display_payload(topic: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Return a minimal live-only payload for interactive UI projection.

    Gateway history and support bundles keep using ``redacted_payload``. This
    live payload is only put on the in-process ``Aurora.EventStream`` broadcast
    so local/web SDK subscribers can render chat transcripts and assistant
    replies. Never include raw audio, credentials, tool arguments, file content,
    or broad arbitrary payloads here.
    """
    if topic == OrchestratorMethods.RESPONSE:
        result: dict[str, Any] = {}
        _copy_string(payload, result, "kind")
        _copy_string(payload, result, "text")
        _copy_string(payload, result, "delta")
        _copy_string(payload, result, "session_id")
        _copy_string(payload, result, "request_id")
        _copy_string(payload, result, "correlation_id")
        _copy_string(payload, result, "message_id")
        _copy_bool(payload, result, "is_final")
        sequence = payload.get("sequence")
        if isinstance(sequence, int) and sequence >= 0:
            result["sequence"] = sequence
        metadata = _safe_live_metadata(payload.get("metadata"))
        if metadata:
            result["metadata"] = metadata
        tool = _safe_live_tool(payload.get("tool"))
        if tool:
            result["tool"] = tool
        return result or None
    if topic == TTSMethods.AUDIO_CHUNK:
        result = {}
        _copy_string(payload, result, "stream_id")
        _copy_string(payload, result, "format")
        _copy_string(payload, result, "reason")
        _copy_string(payload, result, "correlation_id")
        _copy_bool(payload, result, "is_final")
        for key in ("sequence", "sample_rate", "channels", "source_sequence"):
            value = payload.get(key)
            if isinstance(value, int) and value >= 0:
                result[key] = value
        _copy_float(payload, result, "duration_ms")
        return result or None
    if topic in {
        STTMethods.USER_SPEECH_CAPTURED,
        STTMethods.FINAL,
        STTMethods.PARTIAL,
        TranscriptionMethods.RESULT,
    }:
        result = {}
        _copy_string(payload, result, "session_id")
        _copy_string(payload, result, "stream_id")
        _copy_string(payload, result, "text")
        _copy_string(payload, result, "transcript")
        _copy_string(payload, result, "transcription")
        _copy_string(payload, result, "transcription_type")
        _copy_string(payload, result, "source")
        _copy_string(payload, result, "timestamp")
        _copy_bool(payload, result, "is_final")
        _copy_float(payload, result, "confidence")
        return result or None
    if topic == WakeWordMethods.DETECTED:
        result = {}
        _copy_string(payload, result, "wake_word")
        _copy_string(payload, result, "wakeWord")
        _copy_string(payload, result, "timestamp")
        _copy_float(payload, result, "confidence")
        return result or None
    if topic == STTMethods.SESSION_STARTED:
        result = {}
        _copy_string(payload, result, "session_id")
        _copy_string(payload, result, "source")
        _copy_string(payload, result, "wake_word")
        _copy_string(payload, result, "wakeWord")
        return result or None
    if topic == STTMethods.AUDIO_LEVEL:
        result = {}
        _copy_string(payload, result, "session_id")
        _copy_string(payload, result, "stream_id")
        _copy_float(payload, result, "level")
        _copy_float(payload, result, "peak")
        _copy_bool(payload, result, "redacted")
        bars = payload.get("bars")
        if isinstance(bars, list):
            safe_bars = [
                float(item)
                for item in bars
                if isinstance(item, int | float) and math.isfinite(float(item))
            ]
            if safe_bars:
                result["bars"] = safe_bars[:96]
        return result or None
    return None


def _copy_string(source: dict[str, Any], target: dict[str, Any], key: str) -> None:
    value = source.get(key)
    if isinstance(value, str) and value.strip():
        target[key] = value


def _copy_bool(source: dict[str, Any], target: dict[str, Any], key: str) -> None:
    value = source.get(key)
    if isinstance(value, bool):
        target[key] = value


def _copy_float(source: dict[str, Any], target: dict[str, Any], key: str) -> None:
    value = source.get(key)
    if isinstance(value, int | float) and math.isfinite(float(value)):
        target[key] = float(value)


def _safe_live_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    safe_keys = {
        "source",
        "stream",
        "model",
        "provider",
        "provider_label",
        "route",
        "route_label",
        "tts_status",
        "tts_stream_id",
        "tool_name",
        "tool_status",
    }
    result: dict[str, Any] = {}
    for key in safe_keys:
        item = value.get(key)
        if isinstance(item, str | bool) or (
            isinstance(item, int | float) and math.isfinite(float(item))
        ):
            result[key] = item
    return result


def _safe_live_string(value: Any, *, limit: int = 500) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.replace("\n", " ").strip()
    for pattern in _LIVE_SECRET_VALUE_PATTERNS:
        text = pattern.sub("<redacted>", text)
    return text[:limit] if text else None


_LIVE_PREVIEW_SECRET_KEY_PARTS = (
    "api_key",
    "apikey",
    "auth",
    "bearer",
    "cookie",
    "credential",
    "jwt",
    "password",
    "redis_url",
    "secret",
    "signature",
    "token",
)


def _is_live_preview_secret_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in _LIVE_PREVIEW_SECRET_KEY_PARTS)


def _safe_live_preview_copy(value: Any, *, key: str = "", depth: int = 0) -> Any:
    """Copy already-sanitized live tool previews without diagnostic over-redaction.

    Diagnostics intentionally hash broad keys such as ``query`` and ``result``.
    Assistant tool rows need the backend-redacted preview that Orchestrator
    already produced, while still guarding obvious credential keys and values.
    """

    if depth > 4:
        return "<truncated>"
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="python")
    if _is_binary_summary(value):
        return value
    if _is_live_preview_secret_key(key):
        digest = hashlib.sha256(repr(value).encode("utf-8", errors="replace")).hexdigest()
        return {"redacted": True, "sha256": digest}
    if isinstance(value, dict):
        preview: dict[str, Any] = {}
        for index, (nested_key, nested) in enumerate(value.items()):
            if index >= 16:
                preview["…"] = "<truncated>"
                break
            preview[str(nested_key)] = _safe_live_preview_copy(
                nested, key=str(nested_key), depth=depth + 1
            )
        return preview
    if isinstance(value, list | tuple | set):
        items = [
            _safe_live_preview_copy(item, key=key, depth=depth + 1) for item in list(value)[:12]
        ]
        if len(value) > 12:
            items.append("<truncated>")
        return items
    if isinstance(value, str):
        return _safe_live_string(value, limit=1_000)
    if isinstance(value, int | float):
        return value if math.isfinite(float(value)) else None
    if isinstance(value, bool) or value is None:
        return value
    return _safe_live_string(value, limit=500)


def _safe_live_tool(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="python")
    if not isinstance(value, dict):
        return {}
    safe: dict[str, Any] = {}
    for key in (
        "tool_call_id",
        "tool_name",
        "display_name",
        "status",
        "summary",
        "risk_class",
        "target",
        "provider_id",
        "policy_decision_id",
        "pending_id",
        "approval_request_id",
        "error",
    ):
        item = _safe_live_string(value.get(key))
        if item:
            safe[key] = item
    data_leaves = value.get("data_leaves_device")
    if isinstance(data_leaves, bool):
        safe["data_leaves_device"] = data_leaves
    approval_expires_at = value.get("approval_expires_at")
    if isinstance(approval_expires_at, int | float) and math.isfinite(float(approval_expires_at)):
        safe["approval_expires_at"] = float(approval_expires_at)
    for key in ("redacted_args_preview", "result_preview", "error_details"):
        item = value.get(key)
        safe_item = _safe_live_preview_copy(item, key=key)
        if safe_item not in (None, "", {}, []):
            safe[key] = safe_item
    return safe


def _event_category(topic: str, payload: dict[str, Any]) -> str:
    if topic in {
        GatewayMethods.SERVICE_ANNOUNCE,
        GatewayMethods.SERVICE_DEPART,
        GatewayMethods.SERVICE_HEARTBEAT,
    }:
        return "service"
    if topic in {
        GatewayMethods.GET_CAPABILITY_GRAPH,
        GatewayMethods.GET_CAPABILITY_CATALOG,
    }:
        return "capability"
    if topic in {GatewayMethods.EXPLAIN_ROUTE}:
        return "route"
    if topic == OrchestratorMethods.RESPONSE:
        return "assistant"
    if topic in {
        AuthMethods.PAIRING_REQUESTED,
        AuthMethods.PAIRING_APPROVED,
        AuthMethods.PAIRING_DENIED,
        AuthMethods.PAIRING_EXPIRED,
        AuthMethods.PAIRING_EXCHANGED,
    }:
        return "pairing"
    if topic.startswith("Mesh."):
        return "peer"
    if topic in {ConfigMethods.UPDATED, ConfigMethods.ERROR}:
        return "config"
    if topic in {
        ToolingMethods.PREPARE_EXECUTION,
        ToolingMethods.REQUEST_APPROVAL,
        ToolingMethods.CONFIRM_EXECUTION,
    }:
        return "tool_approval"
    if topic in {ToolingMethods.EXECUTE_TOOL}:
        return "tool_execution"
    if (
        topic.startswith("Audio.")
        or topic.startswith("AudioSession.")
        or topic.startswith("STTCoordinator.")
        or topic.startswith("Transcription.")
        or topic.startswith("WakeWord.")
        or topic.startswith("TTS.")
    ):
        return "audio"
    if topic.startswith("DB.RAG") or payload.get("namespace") or payload.get("data_scope"):
        return "data"
    if topic in {SchedulerMethods.JOB_FIRED, SchedulerMethods.JOB_COMPLETED}:
        return "scheduler"
    if topic == AuthMethods.STORE_AUDIT_EVENT:
        return "audit"
    return "unknown"


def _event_kind(topic: str, payload: dict[str, Any]) -> str:
    explicit = _first_string(payload, "kind", "event_kind", "eventKind", "type")
    if explicit:
        return explicit
    if topic == WakeWordMethods.DETECTED:
        return "voice.wakeword.detected"
    if topic == STTMethods.SESSION_STARTED:
        return "voice.session.started"
    if topic == STTMethods.SESSION_ENDED:
        return "voice.session.ended"
    if topic == STTMethods.AUDIO_LEVEL:
        return "voice.audio.level"
    transcription_type = _first_string(payload, "transcription_type", "type")
    if topic in {STTMethods.PARTIAL} or (
        topic == TranscriptionMethods.RESULT
        and transcription_type
        and transcription_type.lower() in {"partial", "realtime"}
    ):
        return "voice.transcription.partial"
    if topic in {STTMethods.USER_SPEECH_CAPTURED, STTMethods.FINAL, TranscriptionMethods.RESULT}:
        return "voice.transcription.final"
    if topic == STTMethods.TIMEOUT:
        return "voice.timeout"
    if topic in {STTMethods.ERROR, TranscriptionMethods.ERROR}:
        return "voice.error"
    if topic == TTSMethods.STARTED:
        return "tts.started"
    if topic == TTSMethods.STOPPED:
        return "tts.stopped"
    if topic == TTSMethods.PAUSED:
        return "tts.paused"
    if topic == TTSMethods.RESUMED:
        return "tts.resumed"
    if topic == TTSMethods.ERROR:
        return "tts.error"
    if topic == TTSMethods.AUDIO_CHUNK:
        return "tts.audio_chunk"
    category = _event_category(topic, payload)
    status = _event_status(topic, payload)
    action = _event_action(topic, payload)
    if topic == OrchestratorMethods.RESPONSE:
        return "assistant.failed" if status == "failed" else "assistant.completed"
    if category == "tool_approval":
        return f"tool.{status or action or 'requested'}"
    if category == "tool_execution":
        return f"tool.{status or action or 'completed'}"
    if category == "config":
        return "config.updated" if status != "failed" else "config.validation_failed"
    if category == "service":
        return f"service.{status or action or 'updated'}"
    return f"{category}.{action}" if category != "unknown" and action else category


def _event_action(topic: str, payload: dict[str, Any]) -> str:
    if payload.get("action"):
        return str(payload["action"])
    if payload.get("event_type"):
        return str(payload["event_type"])
    return topic.split(".", 1)[1] if "." in topic else topic


def _event_status(topic: str, payload: dict[str, Any]) -> str:
    if payload.get("status"):
        return str(payload["status"])
    if payload.get("success") is True or payload.get("ok") is True:
        return "success"
    if payload.get("success") is False or payload.get("ok") is False:
        return "failed"
    if topic == GatewayMethods.SERVICE_DEPART:
        return "disconnected"
    if topic == GatewayMethods.SERVICE_ANNOUNCE:
        return "connected"
    metadata = payload.get("metadata")
    if (
        topic == OrchestratorMethods.RESPONSE
        and isinstance(metadata, dict)
        and metadata.get("error")
    ):
        return "failed"
    if topic == OrchestratorMethods.RESPONSE:
        return "completed"
    if payload.get("approved") is True:
        return "approved"
    if payload.get("approved") is False:
        return "denied"
    return ""


def _event_severity(topic: str, payload: dict[str, Any]) -> str:
    status = _event_status(topic, payload)
    if status in {"failed", "denied", "expired"} or payload.get("error"):
        return "error"
    if "stale" in status or "fallback" in status:
        return "warning"
    return "info"


def _payload_dict(payload: Any) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        value = _json_safe_value(payload.model_dump(mode="python"))
    elif isinstance(payload, dict):
        value = _json_safe_value(payload)
    else:
        value = {"value": _json_safe_value(payload)}
    return value if isinstance(value, dict) else {"value": value}


def _model_dump(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return _json_safe_value(value.model_dump(mode="python"))
    return _json_safe_value(value)


def _json_safe_value(value: Any) -> Any:
    """Return a JSON-safe value without exposing raw binary payloads.

    Event-stream diagnostics intentionally never include raw audio, tokens, or file
    contents. Pydantic's JSON mode attempts to UTF-8 decode bytes, which is both
    unsafe for raw PCM and can crash on arbitrary binary audio frames. Summarize
    bytes with length and digest so support bundles remain correlatable without
    leaking microphone data.
    """
    if isinstance(value, bytes | bytearray | memoryview):
        raw = bytes(value)
        return {
            "redacted": True,
            "kind": "binary",
            "byte_length": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): _json_safe_value(nested) for key, nested in value.items()}
    if isinstance(value, list | tuple | set):
        return [_json_safe_value(item) for item in value]
    return value


def _details_dict(details: Any) -> dict[str, Any]:
    if isinstance(details, str):
        try:
            details = json.loads(details)
        except json.JSONDecodeError:
            return {}
    return details if isinstance(details, dict) else {}


def _diagnostic_redacted_copy(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        value = _json_safe_value(value.model_dump(mode="python"))
    else:
        value = _json_safe_value(value)
    if isinstance(value, dict):
        return {
            str(key): _diagnostic_redacted_value(str(key), nested) for key, nested in value.items()
        }
    if isinstance(value, list | tuple):
        return [_diagnostic_redacted_copy(item) for item in value]
    return value


def _diagnostic_redacted_value(key: str, value: Any) -> Any:
    if key == "details" and isinstance(value, str):
        details = _details_dict(value)
        if details:
            return _diagnostic_redacted_copy(details)
    if _is_binary_summary(value):
        return value
    if _is_diagnostic_secret_key(key):
        digest = hashlib.sha256(repr(value).encode("utf-8", errors="replace")).hexdigest()
        return {"redacted": True, "sha256": digest}
    return _diagnostic_redacted_copy(value)


def _is_binary_summary(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("redacted") is True
        and value.get("kind") == "binary"
        and isinstance(value.get("byte_length"), int)
        and isinstance(value.get("sha256"), str)
    )


def _is_diagnostic_secret_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in _DIAGNOSTIC_REDACT_KEY_PARTS)


def _first_string(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = _string_value(payload, key)
        if value:
            return value
    return None


def _string_value(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    return str(value)


def _payload_hash(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _rtc_requires_auth(settings: Any) -> bool:
    """Keep peer authentication independent from local HTTP API authentication."""
    return settings.mesh.enabled is True or settings.permissions.enabled is True


def _rtc_transport_config_fingerprint(settings: Any) -> str:
    """Return a non-reversible fingerprint for settings that require an RTC restart."""
    webrtc = settings.webrtc
    mqtt = settings.signaling_mqtt
    payload = {
        "mesh_enabled": settings.mesh.enabled is True,
        "require_auth": _rtc_requires_auth(settings),
        "webrtc": {
            "strategy": webrtc.strategy,
            "app_id": webrtc.app_id,
            "room": webrtc.room,
            "password_sha256": hashlib.sha256(
                str(webrtc.password or "").encode("utf-8")
            ).hexdigest(),
            "encrypt_signaling": webrtc.encrypt_signaling,
            "enable_app_layer_e2ee": webrtc.enable_app_layer_e2ee,
            "stun_servers": webrtc.stun_servers,
            "turn_servers": webrtc.turn_servers,
            "turn_username": webrtc.turn_username,
            "turn_password_sha256": hashlib.sha256(
                str(webrtc.turn_password or "").encode("utf-8")
            ).hexdigest(),
        },
        "mqtt": {
            "brokers": mqtt.brokers,
            "username": mqtt.username,
            "password_sha256": hashlib.sha256(str(mqtt.password or "").encode("utf-8")).hexdigest(),
            "topic_root": mqtt.topic_root,
        },
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _catalog_summary(catalog: CapabilityCatalogResponse) -> CapabilityCatalogSummary:
    modules = sorted({provider.module for provider in catalog.providers})
    blocked_actions = sum(1 for action in catalog.actions if action.route_blockers)
    return CapabilityCatalogSummary(
        providers=len(catalog.providers),
        actions=len(catalog.actions),
        resources=len(catalog.resources),
        modules=modules,
        blocked_actions=blocked_actions,
    )


class GatewayService(BaseService):
    """Gateway Service for Aurora.

    Provides an HTTP API for external access to Aurora services.
    """

    def __init__(self):
        """Initialize the gateway service."""
        from app.services.gateway.audio_session import AudioSessionService

        super().__init__(
            module="Gateway",
            summary="HTTP API Gateway for Aurora services",
            capabilities=["http_api", "service_discovery", "websocket"],
        )
        self._gateway_enabled = False
        self._gateway_app = None
        self._gateway_server = None
        self._gateway_task = None
        self._registry_aggregator = None
        self._rtc_client = None
        self._rtc_transport_fingerprint: str | None = None
        self._rtc_start_lock = asyncio.Lock()
        self._mode = os.getenv("AURORA_ARCHITECTURE_MODE", "threads").lower()

        # Mesh P2P components
        self._mesh_peer_registry = None
        self._mesh_routing_table = None
        self._mesh_peer_bridge = None
        self._mesh_latency_monitor = None
        self._mesh_announcer = None
        self._mesh_bus = None
        self._mesh_peer_id = None
        from app.services.gateway.mesh.policy_store import MeshPolicyStore

        self._mesh_policy_store = MeshPolicyStore()
        self._mesh_policy_provider = self._mesh_policy_store.provider()
        self._mesh_policy_retry_task: asyncio.Task[None] | None = None
        self._mesh_policy_retry_revision: int | None = None
        self._mesh_start_lock = asyncio.Lock()
        self._mesh_start_retry_task: asyncio.Task[None] | None = None
        self._runtime_config_lock = asyncio.Lock()
        self._audio_session_service = AudioSessionService()
        self._event_stream: deque[GatewayEventStreamEvent] = deque(maxlen=_EVENT_STREAM_MAXLEN)
        self._event_stream_subscription_topic = "*"
        self._mesh_authority_lock = asyncio.Lock()
        self._mesh_authority_event_topic = MeshEvents.PEER_AUTHORITY_CHANGED
        self._tooling_projection_invalidation_topic = ToolingMethods.PROJECTION_INVALIDATED
        self._tooling_projection_readiness_topic = ToolingMethods.MESH_PROJECTION_READINESS_CHANGED
        self._tooling_invalidation_subscription_ready = False
        self._tooling_mesh_activation_task: asyncio.Task[None] | None = None
        self._admin_action_manager = AdminActionManager()
        self._mesh_infer_stream_tasks: set[asyncio.Task[None]] = set()
        self._mesh_infer_stream_tasks_by_id: dict[str, asyncio.Task[None]] = {}
        self._mesh_infer_stream_owners_by_id: dict[str, tuple[str | None, ...]] = {}
        self._mesh_rollout_metrics = MeshRolloutMetrics()

    async def _is_runtime_enabled(self) -> bool:
        """Keep the Rust-managed desktop loopback gateway active."""
        if os.environ.get("AURORA_TAURI_MANAGED_SIDECAR") == "1":
            return True
        return await super()._is_runtime_enabled()

    async def on_start(self) -> None:
        """Service-specific startup logic."""
        await self.bus.subscribe_event(
            self._event_stream_subscription_topic, self._capture_gateway_event
        )
        await self.bus.subscribe_event(
            self._mesh_authority_event_topic,
            self._handle_mesh_peer_authority_changed,
        )
        await self.bus.subscribe_event(
            self._tooling_projection_invalidation_topic,
            self._handle_tooling_projection_invalidated,
        )
        self._tooling_invalidation_subscription_ready = True
        await self.bus.subscribe_event(
            self._tooling_projection_readiness_topic,
            self._handle_tooling_projection_readiness_changed,
        )
        self._audio_session_service._bus = self.bus
        await self._audio_session_service.start()
        await self._start_gateway()
        await self._start_webrtc()
        await self._start_mesh()
        self._schedule_tooling_mesh_activation()

    async def on_stop(self) -> None:
        """Service-specific shutdown logic."""
        with contextlib.suppress(Exception):
            self.bus.unsubscribe(
                self._event_stream_subscription_topic,
                self._capture_gateway_event,
            )
        with contextlib.suppress(Exception):
            self.bus.unsubscribe(
                self._mesh_authority_event_topic,
                self._handle_mesh_peer_authority_changed,
            )
        with contextlib.suppress(Exception):
            self.bus.unsubscribe(
                self._tooling_projection_invalidation_topic,
                self._handle_tooling_projection_invalidated,
            )
        self._tooling_invalidation_subscription_ready = False
        with contextlib.suppress(Exception):
            self.bus.unsubscribe(
                self._tooling_projection_readiness_topic,
                self._handle_tooling_projection_readiness_changed,
            )
        tooling_activation_task = self._tooling_mesh_activation_task
        self._tooling_mesh_activation_task = None
        if (
            tooling_activation_task is not None
            and tooling_activation_task is not asyncio.current_task()
            and not tooling_activation_task.done()
        ):
            tooling_activation_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await tooling_activation_task
        for task in list(self._mesh_infer_stream_tasks):
            task.cancel()
        if self._mesh_infer_stream_tasks:
            await asyncio.gather(*self._mesh_infer_stream_tasks, return_exceptions=True)
            self._mesh_infer_stream_tasks.clear()
            self._mesh_infer_stream_tasks_by_id.clear()
            self._mesh_infer_stream_owners_by_id.clear()
        policy_retry = self._cancel_mesh_policy_retry()
        if policy_retry and policy_retry is not asyncio.current_task():
            with contextlib.suppress(asyncio.CancelledError):
                await policy_retry
        await self._stop_mesh()
        await self._stop_webrtc()
        await self._stop_gateway()
        await self._audio_session_service.stop()
        # Ensure registry aggregator is stopped if it was created
        if self._registry_aggregator:
            await self._registry_aggregator.stop()
            self._registry_aggregator = None

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration."""
        if config_section in (None, "services", "gateway", "auth"):
            async with self._runtime_config_lock:
                await self._reload_gateway_config()
                await self._reload_auth_config()
                await self._reload_mesh_config()

    async def reload_config(self, event) -> None:
        """Reload Gateway only for Gateway/Auth config changes."""
        key_path = getattr(event, "key_path", "") or ""
        affected_sections = getattr(event, "affected_sections", []) or []
        changed_paths = getattr(event, "changed_paths", None) or []

        def _is_mesh_policy_path(value: Any) -> bool:
            path = str(value)
            return path.startswith("services.") and (
                ".mesh_sharing" in path or ".mesh_routing" in path
            )

        paths = [key_path, *affected_sections, *changed_paths]

        relevant = any(
            str(path).startswith(("services.gateway", "services.auth"))
            or _is_mesh_policy_path(path)
            for path in paths
        )
        if not relevant:
            log_debug(f"Ignoring unrelated config change for Gateway: {key_path}")
            return
        async with self._runtime_config_lock:
            await self._reload_gateway_config()
            await self._reload_auth_config()
            await self._reload_mesh_config(source_revision=getattr(event, "config_revision", None))

    @method_contract(
        method_id=GatewayMethods.ADMIN_ACTION_DRAFT,
        name="AdminActionDraft",
        summary="Draft a high-risk admin action before confirmation",
        input_model=AdminActionDraftRequest,
        output_model=AdminActionDraftResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Gateway.manage"],
    )
    async def admin_action_draft(
        self,
        data: AdminActionDraftRequest,
        envelope: Envelope,
    ) -> AdminActionDraftResponse:
        """Return a short-lived nonce and digest for a high-risk admin action."""
        return self._admin_action_manager.draft(
            data,
            principal_id=envelope.principal_id,
        )

    @method_contract(
        method_id=GatewayMethods.ADMIN_ACTION_CONFIRM,
        name="AdminActionConfirm",
        summary="Confirm a drafted admin action and issue a route submission token",
        input_model=AdminActionConfirmRequest,
        output_model=AdminActionConfirmResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Gateway.manage"],
    )
    async def admin_action_confirm(
        self,
        data: AdminActionConfirmRequest,
        envelope: Envelope,
    ) -> AdminActionConfirmResponse:
        """Validate reauth/reason/phrase and return a single-use confirmation token."""
        return self._admin_action_manager.confirm(
            data,
            principal_id=envelope.principal_id,
        )

    @method_contract(
        method_id=GatewayMethods.GET_REGISTRY,
        name="GetRegistry",
        summary="Get the aggregated service contract registry",
        input_model=EmptyInput,
        output_model=GetRegistryResponse,
        exposure="external",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def get_registry(self, data: EmptyInput) -> GetRegistryResponse:
        """Return the current Gateway registry export."""
        return await self._get_registry_export()

    @method_contract(
        method_id=GatewayMethods.GET_SERVICES,
        name="GetServices",
        summary="Get known Gateway services and health states",
        input_model=EmptyInput,
        output_model=GetServicesResponse,
        exposure="external",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def get_services(self, data: EmptyInput) -> GetServicesResponse:
        """Return known services from the Gateway registry aggregator."""
        services = await self._get_services_snapshot()
        return GetServicesResponse(services=services, mode=self._mode)

    @method_contract(
        method_id=GatewayMethods.MESH_INFER_CHAT,
        name="MeshInferChat",
        summary="Proxy a fixed Orchestrator.InferChat call through Gateway-owned mesh",
        input_model=GatewayMeshInferChatRequest,
        output_model=GatewayMeshInferChatResponse,
        exposure="internal",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def mesh_infer_chat(
        self,
        data: GatewayMeshInferChatRequest,
        envelope: Envelope | None = None,
    ) -> GatewayMeshInferChatResponse:
        """Forward inference through Gateway's MeshBus/PeerBridge, not the service bus."""
        mesh_bus = self._require_mesh_bus()
        request = self._mesh_proxy_request(data.request, data.mesh_selector)
        context = self._mesh_proxy_context(data, envelope=envelope)
        result = await mesh_bus.request(
            OrchestratorMethods.INFER_CHAT,
            request,
            priority=get_interactive_priority(),
            timeout=60.0,
            origin=context["origin"],
            correlation_id=request.correlation_id,
            principal_id=context["principal_id"],
            effective_perms=context["effective_perms"],
            identity_source=context["identity_source"],
            method_type=context["method_type"],
            caller_peer_id=context["caller_peer_id"],
        )
        if not result.ok:
            raise RuntimeError(result.error or "Gateway mesh inference failed")
        response = self._coerce_infer_response(result.data)
        return GatewayMeshInferChatResponse(response=response)

    @method_contract(
        method_id=GatewayMethods.STREAM_MESH_INFER_CHAT,
        name="StreamMeshInferChat",
        summary="Start a Gateway-owned Orchestrator.StreamInferChat mesh proxy",
        input_model=GatewayStreamMeshInferChatStartRequest,
        output_model=GatewayStreamMeshInferChatStartResponse,
        exposure="internal",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def stream_mesh_infer_chat(
        self,
        data: GatewayStreamMeshInferChatStartRequest,
        envelope: Envelope | None = None,
    ) -> GatewayStreamMeshInferChatStartResponse:
        """Start a background stream proxy and publish typed chunk events."""
        self._require_mesh_bus()
        context = self._mesh_proxy_context(data, envelope=envelope)
        owner_key = self._mesh_stream_owner_key(context)
        if not any(owner_key):
            raise PermissionError("Gateway mesh stream requires caller ownership context")
        existing = self._mesh_infer_stream_tasks_by_id.get(data.stream_id)
        if existing is not None and not existing.done():
            raise ValueError(f"Gateway mesh inference stream already active: {data.stream_id}")
        self._mesh_infer_stream_tasks_by_id.pop(data.stream_id, None)
        self._mesh_infer_stream_owners_by_id.pop(data.stream_id, None)
        request = self._mesh_proxy_request(data.request, data.mesh_selector)
        task = asyncio.create_task(
            self._run_mesh_infer_stream_proxy(data.stream_id, request, context),
            name=f"gateway-mesh-infer-stream-{data.stream_id}",
        )
        self._mesh_infer_stream_tasks.add(task)
        self._mesh_infer_stream_tasks_by_id[data.stream_id] = task
        self._mesh_infer_stream_owners_by_id[data.stream_id] = owner_key

        def _forget_stream_task(done_task: asyncio.Task, stream_id: str = data.stream_id) -> None:
            self._mesh_infer_stream_tasks.discard(done_task)
            self._mesh_infer_stream_tasks_by_id.pop(stream_id, None)
            self._mesh_infer_stream_owners_by_id.pop(stream_id, None)

        task.add_done_callback(_forget_stream_task)
        return GatewayStreamMeshInferChatStartResponse(
            stream_id=data.stream_id,
            accepted=True,
            correlation_id=request.correlation_id,
        )

    @method_contract(
        method_id=GatewayMethods.CANCEL_MESH_INFER_CHAT_STREAM,
        name="CancelMeshInferChatStream",
        summary="Cancel a Gateway-owned remote mesh inference stream proxy",
        input_model=GatewayCancelMeshInferChatStreamRequest,
        output_model=GatewayCancelMeshInferChatStreamResponse,
        exposure="internal",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def cancel_mesh_infer_chat_stream(
        self,
        data: GatewayCancelMeshInferChatStreamRequest,
        envelope: Envelope | None = None,
    ) -> GatewayCancelMeshInferChatStreamResponse:
        """Cancel a background stream proxy if it is still active."""
        task = self._mesh_infer_stream_tasks_by_id.get(data.stream_id)
        if task is None or task.done():
            self._mesh_infer_stream_tasks_by_id.pop(data.stream_id, None)
            self._mesh_infer_stream_owners_by_id.pop(data.stream_id, None)
            return GatewayCancelMeshInferChatStreamResponse(
                stream_id=data.stream_id, cancelled=False
            )
        expected_owner = self._mesh_infer_stream_owners_by_id.get(data.stream_id)
        context = self._mesh_proxy_context(data, envelope=envelope)
        if expected_owner != self._mesh_stream_owner_key(context):
            return GatewayCancelMeshInferChatStreamResponse(
                stream_id=data.stream_id, cancelled=False
            )
        self._mesh_infer_stream_tasks_by_id.pop(data.stream_id, None)
        self._mesh_infer_stream_owners_by_id.pop(data.stream_id, None)
        self._mesh_infer_stream_tasks.discard(task)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return GatewayCancelMeshInferChatStreamResponse(stream_id=data.stream_id, cancelled=True)

    @method_contract(
        method_id=GatewayMethods.GET_SERVICE_HEALTH,
        name="GetServiceHealth",
        summary="Get a single service health summary",
        input_model=GetServiceHealthRequest,
        output_model=GetServiceHealthResponse,
        exposure="external",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def get_service_health(
        self,
        data: GetServiceHealthRequest,
    ) -> GetServiceHealthResponse:
        """Return a service health summary without probing service internals."""
        services = await self._get_services_snapshot()
        for service in services:
            if service.module == data.module:
                return self._service_health_response(service)
        return GetServiceHealthResponse(
            module=data.module,
            status="unknown",
            checks={"registry": "missing"},
            timestamp=datetime.now(UTC).isoformat(),
            error="service is not present in Gateway registry",
        )

    @method_contract(
        method_id=GatewayMethods.GET_DEPLOYMENT_TOPOLOGY,
        name="GetDeploymentTopology",
        summary="Get sanitized deployment topology and message bus health",
        input_model=EmptyInput,
        output_model=DeploymentTopologyResponse,
        exposure="external",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def get_deployment_topology(
        self,
        data: EmptyInput,
    ) -> DeploymentTopologyResponse:
        """Return architecture mode, bus health, and sanitized process topology."""
        services = await self._get_services_snapshot()
        bus_health = await self._build_bus_health()
        mesh_status = await self.get_mesh_status(EmptyInput())
        mode = self._mode

        degradations = list(bus_health.degraded_reasons)
        if mode == "threads":
            degradations.append("thread_mode_no_process_controls")
        if mode == "processes" and any(service.status != "healthy" for service in services):
            degradations.append("process_registry_stale")
        if mesh_status.peers:
            degradations.append("mesh_peer_topology_untrusted")

        runtime_mode = "process-server" if mode == "processes" else "thread-local"
        if mesh_status.local.mesh_enabled:
            runtime_mode = f"{runtime_mode}+mesh"

        return DeploymentTopologyResponse(
            architecture_mode=mode,
            runtime_mode=runtime_mode,
            bus_backend=_bus_backend_name(self.bus),
            redis_url_redacted=bus_health.redis_url_redacted,
            redis_reachable=bus_health.redis_reachable,
            bullmq_queue_health=bus_health,
            service_process_topology=self._build_service_process_topology(services),
            container_topology_hints=self._container_topology_hints(),
            mode_capability_degradations=sorted(set(degradations)),
            mesh_peer_topology_trusted=False if mesh_status.peers else None,
            generated_at=datetime.now(UTC).isoformat(),
            secrets_redacted=True,
        )

    @method_contract(
        method_id=GatewayMethods.GET_MESH_STATUS,
        summary="Get read-only mesh status and routing diagnostics",
        input_model=EmptyInput,
        output_model=GetMeshStatusResponse,
        exposure="external",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def get_mesh_status(self, data: EmptyInput) -> GetMeshStatusResponse:
        """Return a redacted diagnostic snapshot of mesh state and routing."""
        policy_snapshot = self._mesh_policy_provider()
        mesh_config = policy_snapshot.mesh_config
        registry = self._mesh_peer_registry
        routing_table = self._mesh_routing_table

        shared_modules = sorted(
            module for module, service in mesh_config.services.items() if service.export.share
        )
        routed_modules = sorted(
            module
            for module, service in mesh_config.services.items()
            if service.routing.prefer not in ("local", "local_only")
        )

        peers = registry.get_all_peers() if registry else []
        local = MeshLocalStatus(
            mesh_enabled=mesh_config.enabled,
            mesh_started=self._mesh_bus is not None,
            webrtc_started=self._rtc_client is not None,
            peer_id=self._mesh_peer_id,
            node_name=mesh_config.node_name,
            peer_selection=mesh_config.peer_selection,
            version_policy=mesh_config.version_policy,
            shared_modules=shared_modules,
            routed_modules=routed_modules,
        )

        peer_diagnostics = [
            self._build_peer_diagnostic(peer, mesh_config)
            for peer in sorted(peers, key=lambda p: p.peer_id)
        ]

        route_modules = set(mesh_config.services.keys())
        for peer in peers:
            if peer.manifest:
                route_modules.update(svc.module for svc in peer.manifest.shared_services)

        route_diagnostics = [
            self._build_route_diagnostic(
                module,
                mesh_config,
                registry,
                routing_table,
                policy_snapshot,
            )
            for module in sorted(route_modules)
        ]

        export_summaries = [
            MeshServiceExportSummary(
                service_id=module,
                shared=bool(service.export.share),
                policy_revision=policy_snapshot.revision,
                reason_codes=(
                    ["service_not_shared"]
                    if not service.export.share
                    else (
                        ["method_not_shared"]
                        if service.export.unshared_method_ids or service.export.unshared_feature_ids
                        else []
                    )
                ),
                excluded_method_count=len(service.export.unshared_method_ids),
                excluded_feature_count=len(service.export.unshared_feature_ids),
            )
            for module, service in sorted(mesh_config.services.items())
        ]
        routing_summaries = [
            _exact_service_routing_summary(
                module=module,
                mesh_config=mesh_config,
                registry=registry,
                policy_snapshot=policy_snapshot,
            )
            for module in sorted(route_modules)
        ]

        compatibility_failures: list[MeshCompatibilityFailure] = []
        for peer in peer_diagnostics:
            compatibility_failures.extend(
                _compatibility_failures_for_peer(
                    peer.peer_id,
                    peer.compatibility.local_services,
                    peer.compatibility.local_incompatible,
                    "local_view_of_remote",
                )
            )
            compatibility_failures.extend(
                _compatibility_failures_for_peer(
                    peer.peer_id,
                    peer.compatibility.remote_services,
                    peer.compatibility.remote_incompatible,
                    "remote_view_of_local",
                )
            )

        return GetMeshStatusResponse(
            local=local,
            peers=peer_diagnostics,
            routes=route_diagnostics,
            export_summaries=export_summaries,
            routing_summaries=routing_summaries,
            compatibility_failures=compatibility_failures,
            secrets_redacted=True,
        )

    @method_contract(
        method_id=GatewayMethods.GET_MESH_INVITE_CONFIG,
        summary="Get the signaling credentials required to create a mesh invite",
        input_model=EmptyInput,
        output_model=GetMeshInviteConfigResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Gateway.manage"],
    )
    async def get_mesh_invite_config(self, data: EmptyInput) -> GetMeshInviteConfigResponse:
        """Return only the admin-gated signaling material embedded in an invite."""
        settings = await self._get_gateway_config()
        return GetMeshInviteConfigResponse(
            app_id=str(settings.webrtc.app_id or ""),
            room=str(settings.webrtc.room or ""),
            room_password=str(settings.webrtc.password or ""),
        )

    @method_contract(
        method_id=GatewayMethods.GET_WEBRTC_DIAGNOSTICS,
        summary="Get read-only WebRTC, ICE, and DataChannel diagnostics",
        input_model=EmptyInput,
        output_model=WebRTCDiagnosticsResponse,
        exposure="external",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def get_webrtc_diagnostics(self, data: EmptyInput) -> WebRTCDiagnosticsResponse:
        """Return a redacted diagnostic snapshot of WebRTC transport state."""
        settings = await self._get_gateway_config()
        if self._rtc_client is not None:
            return self._rtc_client.get_diagnostics()
        return WebRTCDiagnosticsResponse(
            enabled=bool(settings.webrtc.enabled),
            started=False,
            mesh_enabled=bool(settings.mesh.enabled),
            local_mesh_peer_id=self._mesh_peer_id,
            local_node_name=settings.mesh.node_name,
            require_auth=bool(settings.api.auth_enabled),
            auth_timeout_seconds=settings.permissions.webrtc_auth_timeout_seconds,
            pairing_timeout_seconds=settings.permissions.webrtc_pairing_timeout_seconds,
            app_layer_e2ee_enabled=bool(settings.webrtc.enable_app_layer_e2ee),
            secrets_redacted=True,
        )

    @method_contract(
        method_id=GatewayMethods.GET_CAPABILITY_GRAPH,
        summary="Get a redacted mesh capability graph",
        input_model=EmptyInput,
        output_model=CapabilityGraph,
        exposure="external",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def get_capability_graph(self, data: EmptyInput) -> CapabilityGraph:
        """Return a first-class capability graph without credential-bearing fields."""
        from app.services.gateway.mesh.capability_graph import build_capability_graph

        policy_snapshot = self._mesh_policy_provider()
        mesh_config = policy_snapshot.mesh_config
        local_services = {}
        if self._registry_aggregator:
            local_services = self._registry_aggregator.snapshot_services()

        return build_capability_graph(
            mesh_config=mesh_config,
            local_services=local_services,
            registry=self._mesh_peer_registry,
            policy_snapshot=policy_snapshot,
            local_peer_id=self._mesh_peer_id,
        )

    @method_contract(
        method_id=GatewayMethods.GET_CAPABILITY_CATALOG,
        summary="Get canonical executable capability catalog",
        input_model=CapabilityCatalogRequest,
        output_model=CapabilityCatalogResponse,
        exposure="external",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def get_capability_catalog(
        self,
        data: CapabilityCatalogRequest,
    ) -> CapabilityCatalogResponse:
        """Return a product-facing local + remote capability catalog."""
        from app.services.gateway.mesh.capability_catalog import build_capability_catalog

        policy_snapshot = self._mesh_policy_provider()
        mesh_config = policy_snapshot.mesh_config
        local_services = {}
        if self._registry_aggregator:
            local_services = self._registry_aggregator.snapshot_services()

        return build_capability_catalog(
            request=data,
            mesh_config=mesh_config,
            local_services=local_services,
            registry=self._mesh_peer_registry,
            policy_snapshot=policy_snapshot,
            local_peer_id=self._mesh_peer_id,
        )

    @method_contract(
        method_id=GatewayMethods.EXPLAIN_ROUTE,
        summary="Explain mesh route selection and provider eligibility",
        input_model=RouteExplainRequest,
        output_model=RouteExplainResponse,
        exposure="external",
        method_type="use",
        required_perms=["Gateway.use"],
    )
    async def explain_route(self, data: RouteExplainRequest) -> RouteExplainResponse:
        """Return selected target, candidates, and route blockers for a selector."""
        from app.services.gateway.mesh.capability_catalog import explain_route

        policy_snapshot = self._mesh_policy_provider()
        mesh_config = policy_snapshot.mesh_config
        local_services = {}
        if self._registry_aggregator:
            local_services = self._registry_aggregator.snapshot_services()

        response = explain_route(
            request=data,
            mesh_config=mesh_config,
            local_services=local_services,
            registry=self._mesh_peer_registry,
            routing_table=self._mesh_routing_table,
            policy_snapshot=policy_snapshot,
            local_peer_id=self._mesh_peer_id,
        )
        denied: list[tuple[str, str]] = []
        for candidate in response.candidates:
            reason = canonical_mesh_rollout_reason(candidate.reason_code)
            if not candidate.included and reason:
                denied.append((candidate.peer_id, reason))
                self._mesh_rollout_metrics.record(
                    "route_candidate_denied",
                    peer_id=candidate.peer_id,
                    reason_code=reason,
                )
        if denied:
            await self._audit_mesh_rollout_event(
                "mesh.route_candidate.denied",
                correlation_id=None,
                details={
                    "module": response.module,
                    "topic": response.topic,
                    "denials": [
                        {"peer_id": peer_id, "reason_code": reason} for peer_id, reason in denied
                    ],
                },
            )
        return response

    @method_contract(
        method_id=GatewayMethods.LIST_EVENTS,
        summary="List recent normalized Gateway event stream entries",
        input_model=GatewayListEventsRequest,
        output_model=GatewayListEventsResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Gateway.manage"],
    )
    async def list_events(self, data: GatewayListEventsRequest) -> GatewayListEventsResponse:
        """Return recent redacted event stream entries for UI/SDK backfill."""
        events = self._filter_events(data)
        return GatewayListEventsResponse(
            events=events[: data.limit],
            total=len(events),
            subscription_topic=AuroraMethods.EVENT_STREAM,
            secrets_redacted=True,
        )

    @method_contract(
        method_id=GatewayMethods.GET_SUPPORT_BUNDLE,
        summary="Get a redacted Gateway and mesh support bundle",
        input_model=GatewaySupportBundleRequest,
        output_model=GatewaySupportBundleResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Gateway.manage"],
    )
    async def get_support_bundle(
        self,
        data: GatewaySupportBundleRequest,
    ) -> GatewaySupportBundleResponse:
        """Return redacted diagnostics for route, mesh, audit, and config debugging."""
        registry_export = await self._get_registry_export()
        services = await self._get_services_snapshot()
        service_health = [self._service_health_response(service) for service in services]
        mesh_status = await self.get_mesh_status(EmptyInput())
        webrtc_diagnostics = await self.get_webrtc_diagnostics(EmptyInput())
        catalog_summary = CapabilityCatalogSummary()
        if data.include_capability_catalog:
            catalog = await self.get_capability_catalog(
                CapabilityCatalogRequest(include_schemas=False)
            )
            catalog_summary = _catalog_summary(catalog)

        event_request = GatewayListEventsRequest(
            correlation_id=data.correlation_id,
            limit=max(data.event_limit, 1) if data.event_limit else 1,
        )
        recent_events = (
            [] if data.event_limit == 0 else self._filter_events(event_request)[: data.event_limit]
        )
        recent_audit_events = [
            _diagnostic_redacted_copy(event) for event in await self._get_recent_audit_events(data)
        ]
        settings = await self._get_gateway_config()
        rollout_snapshot = await self._mesh_rollout_support_snapshot()

        correlation_ids = {event.correlation_id for event in recent_events if event.correlation_id}
        for audit_event in recent_audit_events:
            details = _details_dict(audit_event.get("details"))
            correlation_id = details.get("correlation_id")
            if correlation_id:
                correlation_ids.add(str(correlation_id))

        audit_receipt, audit_error = await self._audit_support_bundle_export(
            correlation_id=data.correlation_id,
            registry=registry_export,
            services=services,
            event_count=len(recent_events),
            audit_event_count=len(recent_audit_events),
        )

        return GatewaySupportBundleResponse(
            generated_at=datetime.now(UTC).isoformat(),
            correlation_id=data.correlation_id,
            registry=registry_export,
            services=services,
            service_health=service_health,
            mesh_status=mesh_status,
            webrtc_diagnostics=webrtc_diagnostics,
            route_diagnostics=mesh_status.routes,
            capability_catalog_summary=catalog_summary,
            recent_events=recent_events,
            recent_audit_events=recent_audit_events,
            native_capabilities=self._native_capability_diagnostics(
                registry=registry_export,
                services=services,
            ),
            sidecar_logs=self._sidecar_log_diagnostics(),
            mesh_rollout=rollout_snapshot,
            config_shape=_diagnostic_redacted_copy(_model_dump(settings)),
            correlation_ids=sorted(correlation_ids),
            audit_receipt=audit_receipt,
            audit_error=audit_error,
            redaction=SupportBundleRedactionInfo(
                secrets_redacted=True,
                redacted_fields=list(_DIAGNOSTIC_REDACT_KEY_PARTS),
                omitted_payloads=list(_SUPPORT_BUNDLE_OMITTED_PAYLOADS),
            ),
            secrets_redacted=True,
        )

    def _build_peer_diagnostic(self, peer: Any, mesh_config: Any) -> MeshPeerDiagnostic:
        """Serialize peer state without credential-bearing fields."""
        from app.services.gateway.mesh.negotiation import generate_manifest_ack

        now = time.monotonic()
        manifest = peer.manifest
        local_ack = generate_manifest_ack(manifest, mesh_config) if manifest else None
        remote_ack = peer.remote_manifest_ack

        services: list[MeshPeerServiceDiagnostic] = []
        if manifest:
            for svc in manifest.shared_services:
                available_capacity = None
                if svc.max_concurrent > 0:
                    available_capacity = max(svc.max_concurrent - peer.active_calls, 0)
                services.append(
                    MeshPeerServiceDiagnostic(
                        module=svc.module,
                        version=svc.version,
                        capabilities=list(svc.capabilities),
                        method_names=sorted(m.name for m in svc.methods),
                        max_concurrent=svc.max_concurrent,
                        active_calls=peer.active_calls,
                        available_capacity=available_capacity,
                        digest=svc.digest,
                    )
                )

        return MeshPeerDiagnostic(
            peer_id=peer.peer_id,
            node_name=peer.node_name,
            status=peer.status,
            latency_ms=_finite_float(peer.latency_ms),
            last_ping_age_s=_age_seconds(now, peer.last_ping),
            last_manifest_age_s=_age_seconds(now, peer.last_manifest),
            active_calls=peer.active_calls,
            services=services,
            compatibility=MeshPeerCompatibilityDiagnostic(
                local_compatible=list(local_ack.compatible_services) if local_ack else [],
                local_incompatible=list(local_ack.incompatible_services) if local_ack else [],
                local_unused=list(local_ack.unused_services) if local_ack else [],
                remote_compatible=list(peer.remote_compatible),
                remote_incompatible=list(peer.remote_incompatible),
                remote_unused=list(peer.remote_unused),
                local_revision=_mesh_revision_from_ack(local_ack),
                remote_revision=_mesh_revision_from_ack(remote_ack),
                local_services=_mesh_service_compatibility_from_ack(local_ack),
                remote_services=_mesh_service_compatibility_from_ack(remote_ack),
            ),
        )

    def _build_route_diagnostic(
        self,
        module: str,
        mesh_config: Any,
        registry: Any,
        routing_table: Any,
        policy_snapshot: Any,
    ) -> MeshRouteDiagnostic:
        """Explain the current route decision and peer eligibility for a module."""
        config = mesh_config.services.get(module)
        route = None
        diagnostic_topic = _first_advertised_topic(registry, module)
        if routing_table and diagnostic_topic:
            route = routing_table.resolve(
                diagnostic_topic,
                routing_config=config,
                mesh_config=mesh_config,
                policy_snapshot=policy_snapshot,
            )

        providers: list[MeshRouteProviderDiagnostic] = []
        if registry:
            candidates = registry.get_provider_candidates(
                module=module,
                topic=diagnostic_topic,
                routing_config=config,
                version_policy=mesh_config.version_policy,
                include_ineligible=True,
                policy_snapshot=policy_snapshot,
            )
            for candidate in sorted(candidates, key=lambda c: c.peer.peer_id):
                service = candidate.service
                providers.append(
                    MeshRouteProviderDiagnostic(
                        peer_id=candidate.peer.peer_id,
                        node_name=candidate.peer.node_name,
                        status=candidate.peer.status,
                        version=service.version if service else "",
                        latency_ms=_finite_float(candidate.peer.latency_ms),
                        active_calls=candidate.peer.active_calls,
                        max_concurrent=service.max_concurrent if service else 0,
                        eligible=candidate.eligible,
                        reason_code=candidate.reason_code,
                        reason=candidate.reason,
                    )
                )

        decision_target = route.target if route else "local"
        reason = _route_reason(
            module=module,
            config=config,
            decision_target=decision_target,
            providers=providers,
            selected_peer_id=route.peer_id if route else None,
            peer_selection=mesh_config.peer_selection,
        )

        return MeshRouteDiagnostic(
            module=module,
            configured=config is not None,
            share=bool(config.export.share) if config else False,
            prefer=config.routing.prefer if config else "",
            fallback=config.routing.fallback if config else "",
            min_version=config.routing.min_version if config else None,
            required_capabilities=list(config.routing.required_provider_capability_tags)
            if config
            else [],
            decision_target=decision_target,
            decision_peer_id=route.peer_id if route else None,
            decision_version=route.version if route else "",
            decision_latency_ms=_finite_float(route.latency_ms) if route else None,
            reason=reason,
            providers=providers,
        )

    async def _capture_gateway_event(self, envelope: Envelope) -> None:
        """Capture bus events into a redacted normalized stream."""
        if (
            envelope.reply_to is not None
            or envelope.type
            in {
                AuroraMethods.EVENT_STREAM,
                AudioTopics.STREAM_MICROPHONE,
            }
            or envelope.type.startswith("reply.")
        ):
            return
        payload = _payload_dict(envelope.payload)
        event = _event_from_envelope(envelope)
        self._event_stream.appendleft(event)
        live_payload = _live_display_payload(envelope.type, payload)
        live_event = event.model_copy(update={"payload": live_payload}) if live_payload else event
        with contextlib.suppress(Exception):
            await self.bus.publish(
                AuroraMethods.EVENT_STREAM,
                live_event,
                event=True,
                mesh=False,
                origin="internal",
                correlation_id=event.correlation_id,
            )

    @staticmethod
    def _strict_authority_permissions(raw_permissions: Any) -> tuple[str, ...]:
        if not isinstance(raw_permissions, (list, tuple)):
            raise ValueError("permissions must be a list")
        if not all(isinstance(permission, str) for permission in raw_permissions):
            raise ValueError("permissions must be strings")
        permissions = tuple(raw_permissions)
        if any(not permission.strip() for permission in permissions):
            raise ValueError("permissions must be nonblank")
        if tuple(sorted(set(permissions))) != permissions:
            raise ValueError("permissions must be sorted and unique")
        return permissions

    @staticmethod
    def _strict_authority_peer_id(raw_peer_id: Any) -> str:
        if (
            not isinstance(raw_peer_id, str)
            or not raw_peer_id
            or raw_peer_id != raw_peer_id.strip()
        ):
            raise ValueError("authority peer_id must be canonical")
        return raw_peer_id

    @classmethod
    def _validate_authority_row(cls, row: Any, *, event: bool) -> Any:
        peer_id = cls._strict_authority_peer_id(getattr(row, "peer_id", ""))
        revision = int(getattr(row, "auth_grant_revision", -1))
        disposition = str(getattr(row, "disposition", "") or "")
        state = str(getattr(row, "state", "") or "")
        permissions = cls._strict_authority_permissions(getattr(row, "effective_permissions", ()))
        if not peer_id:
            raise ValueError("authority peer_id is required")
        if revision < (1 if event else 0):
            raise ValueError("authority revision is invalid")
        if revision == 0 and permissions:
            raise ValueError("revision zero cannot grant authority")
        if disposition == "removed" and (state != "revoked" or permissions):
            raise ValueError("removed authority must be revoked with empty permissions")
        if state != "active" and permissions:
            raise ValueError("non-active authority must have empty permissions")
        if state == "active" and disposition != "present":
            raise ValueError("active authority must be present")
        return row

    @staticmethod
    def _authority_response_data(response: Any) -> Any:
        if not (hasattr(response, "ok") and response.ok is True):
            raise RuntimeError("authority snapshot query failed")
        return response.data

    @staticmethod
    def _authority_response_contains_supplied_authorities(raw: Any) -> bool:
        if isinstance(raw, dict):
            return "authorities" in raw
        fields_set = getattr(raw, "model_fields_set", None)
        if fields_set is None:
            fields_set = getattr(raw, "__fields_set__", None)
        return isinstance(raw, MeshPeerAuthoritySnapshotResponse) and "authorities" in fields_set

    async def _read_mesh_authority_snapshot(
        self,
        *,
        stable_peer_id: str | None = None,
    ) -> tuple[MeshPeerAuthoritySnapshot, ...]:
        response = await self.bus.request(
            AuthMethods.MESH_GET_AUTHORITY_SNAPSHOT,
            MeshPeerAuthoritySnapshotRequest(peer_id=stable_peer_id),
            timeout=5.0,
        )
        raw = self._authority_response_data(response)
        if isinstance(raw, dict):
            if "authorities" not in raw:
                raise RuntimeError("authority snapshot response omitted authorities")
            raw_authorities = raw["authorities"]
        elif self._authority_response_contains_supplied_authorities(raw):
            raw_authorities = raw.authorities
        else:
            raise RuntimeError("authority snapshot response malformed")
        if not isinstance(raw_authorities, (list, tuple)):
            raise RuntimeError("authority snapshot rows malformed")
        rows = tuple(
            self._validate_authority_row(
                row
                if isinstance(row, MeshPeerAuthoritySnapshot)
                else MeshPeerAuthoritySnapshot.model_validate(row),
                event=False,
            )
            for row in raw_authorities
        )
        if stable_peer_id is not None:
            target = self._strict_authority_peer_id(stable_peer_id)
            if len(rows) > 1 or any(row.peer_id != target for row in rows):
                raise RuntimeError("targeted authority snapshot did not match peer")
        else:
            peer_ids = tuple(row.peer_id for row in rows)
            if tuple(sorted(peer_ids)) != peer_ids or len(set(peer_ids)) != len(peer_ids):
                raise RuntimeError("full authority snapshot rows not canonical")
        return rows

    async def _reconcile_mesh_authority_snapshot(
        self,
        *,
        stable_peer_id: str | None = None,
        complete: bool,
    ) -> _MeshAuthorityReconcileResult:
        rtc_client = self._rtc_client
        if rtc_client is None:
            return _MeshAuthorityReconcileResult(False)
        try:
            target = (
                self._strict_authority_peer_id(stable_peer_id)
                if stable_peer_id is not None
                else None
            )
        except Exception:
            return _MeshAuthorityReconcileResult(False)
        try:
            rows = await self._read_mesh_authority_snapshot(stable_peer_id=target)
        except Exception as exc:
            log_warning(f"Gateway: Durable mesh authority snapshot unavailable: {exc}")
            return _MeshAuthorityReconcileResult(False)
        seen: set[str] = set()
        rows_to_apply: list[MeshPeerAuthoritySnapshot] = []
        absences_to_apply: list[str] = []
        for row in rows:
            seen.add(row.peer_id)
            result = rtc_client.preflight_trusted_peer_authority_snapshot(row)
            if result.status.name not in {"APPLIED", "DUPLICATE", "ABSENT"}:
                rtc_client.apply_trusted_peer_authority_snapshot(row)
                return _MeshAuthorityReconcileResult(False)
            rows_to_apply.append(row)
        if target is not None and not rows:
            result = rtc_client.preflight_trusted_peer_authority_absence(target)
            if result.status.name != "ABSENT":
                return _MeshAuthorityReconcileResult(False)
            absences_to_apply.append(target)
        elif complete:
            known_peers = set(getattr(rtc_client, "_provider_export_authority", {}).keys())
            known_peers.update(getattr(rtc_client, "_provider_export_authority_pending", set()))
            known_peers.update(getattr(rtc_client, "_provider_export_authority_absent", {}).keys())
            for missing_peer in sorted(known_peers - seen):
                result = rtc_client.preflight_trusted_peer_authority_absence(missing_peer)
                if result.status.name != "ABSENT":
                    return _MeshAuthorityReconcileResult(False)
                absences_to_apply.append(missing_peer)
        reannounce: set[str] = set()
        for row in rows_to_apply:
            result = rtc_client.apply_trusted_peer_authority_snapshot(row)
            if result.status.name not in {"APPLIED", "DUPLICATE", "ABSENT"}:
                return _MeshAuthorityReconcileResult(False)
            if self._mesh_peer_registry is not None:
                self._mesh_peer_registry.apply_local_peer_authority(row)
            if result.reannounce and result.peer_id:
                reannounce.add(result.peer_id)
        for missing_peer in absences_to_apply:
            result = rtc_client.apply_trusted_peer_authority_absence(missing_peer)
            if result.status.name != "ABSENT":
                return _MeshAuthorityReconcileResult(False)
            if self._mesh_peer_registry is not None:
                self._mesh_peer_registry.mark_local_peer_authority_absent(missing_peer)
            if result.reannounce and result.peer_id:
                reannounce.add(result.peer_id)
        return _MeshAuthorityReconcileResult(True, tuple(sorted(reannounce)))

    async def _refresh_mesh_authority_for_peer(self, stable_peer_id: str) -> bool:
        async with self._mesh_authority_lock:
            result = await self._reconcile_mesh_authority_snapshot(
                stable_peer_id=stable_peer_id,
                complete=False,
            )
            return result.success

    async def _handle_mesh_peer_authority_changed(self, envelope: Envelope) -> None:
        """Apply trusted canonical durable authority events to RTC shadow state."""

        if (
            envelope.type != MeshEvents.PEER_AUTHORITY_CHANGED
            or envelope.origin != "internal"
            or envelope.caller_peer_id is not None
            or envelope.identity_source is not None
            or envelope.principal_id is not None
            or envelope.effective_perms is not None
            or getattr(envelope, "method_type", None) is not None
        ):
            log_warning("Gateway: Ignored untrusted mesh authority event")
            return
        try:
            event = self._validate_authority_row(
                MeshPeerAuthorityChangedEvent.model_validate(envelope.payload),
                event=True,
            )
        except Exception:
            log_warning("Gateway: Ignored malformed mesh authority event")
            return
        rtc_client = self._rtc_client
        if rtc_client is None:
            return
        reannounce_peers: tuple[str, ...] = ()
        disconnect_peer_id: str | None = None
        async with self._mesh_authority_lock:
            result = rtc_client.apply_peer_authority_changed_detailed(event)
            if result.status.name in {"GAP", "CONFLICT"} and result.peer_id:
                reconcile = await self._reconcile_mesh_authority_snapshot(
                    stable_peer_id=result.peer_id,
                    complete=False,
                )
                if reconcile.success:
                    reannounce_peers = reconcile.reannounce_peers
            elif (
                result.status.name in {"APPLIED", "DUPLICATE"}
                and result.peer_id
                and event.state != "active"
            ):
                if self._mesh_peer_registry is not None:
                    self._mesh_peer_registry.apply_local_peer_authority(
                        MeshPeerAuthoritySnapshot.model_validate(event.model_dump())
                    )
                disconnect_peer_id = result.peer_id
            elif result.reannounce and result.peer_id:
                if self._mesh_peer_registry is not None:
                    self._mesh_peer_registry.apply_local_peer_authority(
                        MeshPeerAuthoritySnapshot.model_validate(event.model_dump())
                    )
                reannounce_peers = (result.peer_id,)
            elif result.status.name in {"APPLIED", "DUPLICATE"} and result.peer_id:
                if self._mesh_peer_registry is not None:
                    self._mesh_peer_registry.apply_local_peer_authority(
                        MeshPeerAuthoritySnapshot.model_validate(event.model_dump())
                    )
        if disconnect_peer_id:
            await rtc_client.disconnect_peer(disconnect_peer_id)
            return
        for peer_id in reannounce_peers:
            await rtc_client.reannounce_manifest_for_peer(peer_id)

    def _filter_events(
        self,
        request: GatewayListEventsRequest,
    ) -> list[GatewayEventStreamEvent]:
        topics = set(request.topics or [])
        categories = set(request.categories or [])
        kinds = set(request.kinds or [])
        events: list[GatewayEventStreamEvent] = []
        for event in list(self._event_stream):
            if request.last_event_id and event.event_id == request.last_event_id:
                break
            if request.replay_from and event.timestamp < request.replay_from:
                continue
            if topics and event.topic not in topics:
                continue
            if categories and event.category not in categories:
                continue
            if kinds and event.kind not in kinds and event.category not in kinds:
                continue
            if request.action and event.action != request.action:
                continue
            if request.status and event.status != request.status:
                continue
            if request.correlation_id and event.correlation_id != request.correlation_id:
                continue
            if request.provider_id and event.provider_id != request.provider_id:
                continue
            if request.tool_id and event.tool_id != request.tool_id:
                continue
            if request.route and event.route != request.route:
                continue
            if (
                request.policy_decision_id
                and event.policy_decision_id != request.policy_decision_id
            ):
                continue
            if request.peer_id and request.peer_id not in {
                event.source_peer_id,
                event.target_peer_id,
            }:
                continue
            events.append(event)
        return events

    def _require_mesh_bus(self) -> Any:
        """Return Gateway's MeshBus or fail before touching the plain service bus."""
        if self._mesh_bus is None:
            raise RuntimeError("Gateway mesh bus is not started")
        return self._mesh_bus

    @staticmethod
    def _mesh_proxy_request(
        request: Any,
        mesh_selector: Any | None,
    ) -> Any:
        """Copy an Orchestrator inference request with an explicit mesh selector."""
        selector = (
            mesh_selector
            or getattr(request, "mesh_selector", None)
            or getattr(request, "selector", None)
        )
        if hasattr(request, "model_copy"):
            return request.model_copy(
                update={
                    "stream": bool(getattr(request, "stream", False)),
                    "mesh_selector": selector,
                    "selector": selector,
                }
            )
        return request

    @staticmethod
    def _mesh_proxy_context(data: Any, *, envelope: Envelope | None) -> dict[str, Any]:
        """Resolve caller identity from the bus envelope, falling back to proxy metadata."""
        effective_perms = (
            list(envelope.effective_perms)
            if envelope is not None and envelope.effective_perms is not None
            else getattr(data, "effective_perms", None)
        )
        if effective_perms is not None:
            effective_perms = list(effective_perms)
        return {
            "origin": (
                envelope.origin
                if envelope is not None and envelope.origin
                else getattr(data, "origin", None) or "internal"
            ),
            "principal_id": (
                envelope.principal_id
                if envelope is not None and envelope.principal_id is not None
                else getattr(data, "principal_id", None)
            ),
            "effective_perms": effective_perms,
            "identity_source": (
                envelope.identity_source
                if envelope is not None and envelope.identity_source is not None
                else getattr(data, "identity_source", None)
            ),
            "method_type": (
                envelope.method_type
                if envelope is not None and envelope.method_type is not None
                else getattr(data, "method_type", None) or "use"
            ),
            "caller_peer_id": (
                envelope.caller_peer_id
                if envelope is not None and envelope.caller_peer_id is not None
                else getattr(data, "caller_peer_id", None)
            ),
        }

    @staticmethod
    def _mesh_stream_owner_key(context: dict[str, Any]) -> tuple[str | None, ...]:
        """Build the immutable ownership key used for stream cancellation."""
        return (
            context.get("principal_id"),
            context.get("identity_source"),
            context.get("caller_peer_id"),
            context.get("origin"),
        )

    @staticmethod
    def _coerce_infer_response(data: Any) -> OrchestratorInferChatResponse:
        if isinstance(data, OrchestratorInferChatResponse):
            return data
        if isinstance(data, dict):
            return OrchestratorInferChatResponse.model_validate(data)
        return OrchestratorInferChatResponse(text="" if data is None else str(data))

    @staticmethod
    def _coerce_infer_chunk(data: Any, *, sequence: int) -> OrchestratorInferChatChunk:
        if isinstance(data, OrchestratorInferChatChunk):
            return data
        if isinstance(data, dict):
            return OrchestratorInferChatChunk.model_validate({"sequence": sequence, **data})
        return OrchestratorInferChatChunk(
            delta="" if data is None else str(data), sequence=sequence
        )

    async def _run_mesh_infer_stream_proxy(
        self,
        stream_id: str,
        request: Any,
        context: dict[str, Any],
    ) -> None:
        """Own the WebRTC streaming hop and publish serializable chunk events."""
        sequence = 0
        try:
            async for item in self._require_mesh_bus().stream_request(
                OrchestratorMethods.STREAM_INFER_CHAT,
                request,
                priority=get_interactive_priority(),
                timeout=60.0,
                origin=context["origin"],
                correlation_id=getattr(request, "correlation_id", None),
                principal_id=context["principal_id"],
                effective_perms=context["effective_perms"],
                identity_source=context["identity_source"],
                method_type=context["method_type"],
                caller_peer_id=context["caller_peer_id"],
            ):
                chunk = self._coerce_infer_chunk(item, sequence=sequence)
                if not chunk.correlation_id:
                    chunk = chunk.model_copy(
                        update={"correlation_id": getattr(request, "correlation_id", None)}
                    )
                await self.bus.publish(
                    GatewayMethods.MESH_INFER_CHAT_CHUNK,
                    GatewayMeshInferChatChunkEvent(
                        stream_id=stream_id,
                        chunk=chunk,
                        is_final=bool(chunk.is_final),
                        correlation_id=chunk.correlation_id,
                        sequence=sequence,
                    ),
                    event=True,
                    mesh=False,
                    origin="internal",
                    correlation_id=chunk.correlation_id,
                )
                sequence += 1
            await self.bus.publish(
                GatewayMethods.MESH_INFER_CHAT_CHUNK,
                GatewayMeshInferChatChunkEvent(
                    stream_id=stream_id,
                    is_final=True,
                    correlation_id=getattr(request, "correlation_id", None),
                    sequence=sequence,
                ),
                event=True,
                mesh=False,
                origin="internal",
                correlation_id=getattr(request, "correlation_id", None),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log_warning(f"Gateway mesh inference stream {stream_id} failed: {exc}")
            await self.bus.publish(
                GatewayMethods.MESH_INFER_CHAT_CHUNK,
                GatewayMeshInferChatChunkEvent(
                    stream_id=stream_id,
                    is_final=True,
                    error=str(exc),
                    correlation_id=getattr(request, "correlation_id", None),
                    sequence=sequence,
                ),
                event=True,
                mesh=False,
                origin="internal",
                correlation_id=getattr(request, "correlation_id", None),
            )

    async def _get_recent_audit_events(
        self,
        request: GatewaySupportBundleRequest,
    ) -> list[dict[str, Any]]:
        if request.audit_limit <= 0:
            return []
        try:
            result = await self.bus.request(
                AuthMethods.AUDIT_LOG,
                AuditLogRequest(
                    limit=request.audit_limit,
                    correlation_id=request.correlation_id,
                ),
                timeout=5.0,
                origin="internal",
            )
        except Exception as exc:
            log_warning(f"Support bundle audit fetch failed: {exc}")
            return []
        if not result.ok or not result.data:
            return []
        data = result.data
        if hasattr(data, "events"):
            events = data.events
        elif isinstance(data, dict):
            events = data.get("events", [])
        else:
            events = []
        return [_diagnostic_redacted_copy(event) for event in events]

    async def _mesh_rollout_support_snapshot(self) -> MeshRolloutMetricsSnapshot:
        """Build bounded rollout diagnostics without querying or exporting tool metadata."""

        snapshot = self._mesh_rollout_metrics.snapshot()
        try:
            result = await self.bus.request(
                ToolingMethods.GET_TOOL_EXPORT_POLICY,
                ToolingGetToolExportPolicyRequest(include_stale=False),
                timeout=5.0,
                origin="internal",
            )
            if result.ok and result.data is not None:
                policy = ToolingGetToolExportPolicyResponse.model_validate(result.data)
                snapshot["provider_mesh_tooling_enabled"] = (
                    policy.mesh_switches.provider_mesh_tooling_enabled
                )
                snapshot["consumer_mesh_tooling_enabled"] = (
                    policy.mesh_switches.consumer_mesh_tooling_enabled
                )
        except Exception as exc:
            log_debug(f"Tooling rollout switch diagnostics unavailable: {type(exc).__name__}")
        try:
            from app.services.config.mesh_policy_migration import load_rbac_preflight_report

            report, _ = load_rbac_preflight_report(os.getenv("AURORA_CONFIG_FILE", "config.json"))
            if isinstance(report, dict):
                snapshot["rbac_preflight_release_blocking"] = bool(report.get("release_blocking"))
        except Exception as exc:
            log_debug(f"RBAC rollout diagnostics unavailable: {type(exc).__name__}")
        snapshot["downgrade_status"] = self._tooling_downgrade_status()
        return MeshRolloutMetricsSnapshot.model_validate(snapshot)

    @staticmethod
    def _tooling_downgrade_status() -> str:
        """Report verified downgrade evidence without inferring success from target mode."""
        if os.getenv("AURORA_TOOLING_TARGET_MODE", "projection").lower() != "legacy":
            return "not_applicable"
        snapshot_file = os.getenv("AURORA_TOOLING_EXPORT_SNAPSHOT")
        if not snapshot_file:
            return "verification_unavailable"
        try:
            from app.services.config.mesh_policy_migration import (
                preflight_tooling_downgrade_start,
            )

            config_file = os.getenv("AURORA_CONFIG_FILE", "config.json")
            output_config = json.loads(Path(config_file).read_text())
            tooling_export_snapshot = json.loads(Path(snapshot_file).read_text())
            result = preflight_tooling_downgrade_start(
                output_config=output_config,
                output_file=config_file,
                tooling_export_snapshot=tooling_export_snapshot,
            )
        except Exception as exc:
            log_debug(f"Downgrade receipt diagnostics unavailable: {type(exc).__name__}")
            return "verification_unavailable"
        return result.reason

    async def _audit_mesh_rollout_event(
        self,
        event: str,
        *,
        correlation_id: str | None,
        details: dict[str, Any],
    ) -> None:
        """Persist fixed-shape rollout metadata without affecting routing decisions."""

        try:
            await self.bus.request(
                AuthMethods.STORE_AUDIT_EVENT,
                StoreAuditEventRequest(
                    event=event,
                    principal_id=None,
                    details=json.dumps({**details, "secrets_redacted": True}, sort_keys=True),
                ),
                timeout=5.0,
                origin="internal",
                correlation_id=correlation_id,
            )
        except Exception as exc:
            log_debug(f"Mesh rollout audit unavailable for {event}: {type(exc).__name__}")

    async def _handle_tooling_projection_invalidated(
        self,
        envelope: Envelope,
    ) -> None:
        """Fan out only metadata hints; RTC supplies recipient authority revisions."""

        if envelope.type != ToolingMethods.PROJECTION_INVALIDATED:
            return
        try:
            invalidation = ToolingProjectionInvalidated.model_validate(envelope.payload)
        except Exception:
            return
        rtc_client = self._rtc_client
        if envelope.origin == "mesh_forwarded":
            authenticated_provider = envelope.caller_peer_id
            if (
                rtc_client is None
                or not authenticated_provider
                or invalidation.provider_peer_id != authenticated_provider
                or not rtc_client._has_authenticated_stable_peer(authenticated_provider)
            ):
                return
            await self.bus.publish(
                ToolingMethods.PROJECTION_SYNC_REQUESTED,
                ToolingProjectionSyncRequested(
                    provider_peer_id=authenticated_provider,
                    service_instance_id=f"remote:{authenticated_provider}:Tooling",
                    reason_code=invalidation.reason_code,
                    force_full_snapshot=True,
                ),
                event=True,
                mesh=False,
                origin="internal",
            )
            return
        if envelope.origin != "internal" or envelope.caller_peer_id is not None:
            return
        if rtc_client is None or invalidation.provider_peer_id != self._mesh_peer_id:
            return
        rtc_client.remember_tooling_projection_invalidation(invalidation)
        recipients = rtc_client.tooling_projection_invalidation_recipients()
        if invalidation.affected_peer_ids is not None:
            affected = set(invalidation.affected_peer_ids)
            recipients = [peer_id for peer_id in recipients if peer_id in affected]
        for peer_id in recipients:
            if not rtc_client.send_tooling_projection_invalidation(peer_id, invalidation):
                rtc_client.schedule_tooling_projection_invalidation_retry(peer_id)

    async def _handle_tooling_projection_readiness_changed(self, envelope: Envelope) -> None:
        if (
            envelope.type != ToolingMethods.MESH_PROJECTION_READINESS_CHANGED
            or envelope.origin != "internal"
            or envelope.caller_peer_id is not None
        ):
            return
        self._schedule_tooling_mesh_activation()

    def _schedule_tooling_mesh_activation(self) -> None:
        """Start one bounded background activation loop without delaying startup."""

        task = self._tooling_mesh_activation_task
        if task is not None and not task.done():
            return
        self._tooling_mesh_activation_task = asyncio.create_task(
            self._run_tooling_mesh_activation_attempts()
        )

    async def _run_tooling_mesh_activation_attempts(self) -> None:
        """Retry fail-closed Tooling activation while startup settles."""

        try:
            for attempt in range(5):
                if await self._coordinate_tooling_mesh_activation():
                    return
                if attempt < 4:
                    await asyncio.sleep(min(0.25 * (2**attempt), 2.0))
        except asyncio.CancelledError:
            raise
        finally:
            if self._tooling_mesh_activation_task is asyncio.current_task():
                self._tooling_mesh_activation_task = None

    async def _coordinate_tooling_mesh_activation(self) -> bool:
        """Activate only after concrete Gateway and Tooling readiness evidence."""

        gateway_ready = all(
            (
                self._tooling_invalidation_subscription_ready,
                callable(getattr(self, "_handle_tooling_projection_invalidated", None)),
                callable(getattr(self, "_fetch_tooling_export_catalog_page", None)),
                "projected_service_id" in Envelope.model_fields,
                "projected_method_id" in Envelope.model_fields,
            )
        )
        if not gateway_ready:
            return False
        try:
            result = await self.bus.request(
                ToolingMethods.GET_MESH_PROJECTION_READINESS,
                EmptyInput(),
                origin="internal",
                timeout=35.0,
            )
            if not result.ok or result.data is None:
                return False
            readiness = ToolingMeshProjectionReadiness.model_validate(result.data)
            if not readiness.ready:
                return False
            activation = await self.bus.request(
                DBMethods.ACTIVATE_TOOLING_MESH_ENFORCEMENT,
                DBActivateToolingMeshEnforcementRequest(
                    expected_revision=readiness.durable_revision,
                    component_schema_versions=DBToolingMeshActivationComponentVersions(
                        projection_transport=2,
                        targeted_invalidation=2,
                        normalized_catalog=2,
                        consumer_binding=2,
                        provider_discovery=2,
                        prepare_enforcement=2,
                        execute_enforcement=2,
                        typed_exposure_ledger=1,
                        inbound_sync_bridge=1,
                        execution_rpc_evidence=1,
                        exact_method_set=1,
                        mutation_invalidation=1,
                        conditional_legacy_retirement=1,
                        startup_downgrade_guard=1,
                    ),
                    actor_principal_id="gateway-tooling-mesh-coordinator",
                    reason="concrete_gateway_and_tooling_readiness_attested",
                ),
                origin="internal",
                timeout=35.0,
            )
            if not activation.ok or activation.data is None:
                return False
            activation_data = (
                activation.data.model_dump(mode="python")
                if hasattr(activation.data, "model_dump")
                else activation.data
            )
            state = activation_data.get("state", activation_data)
            if not state.get("active") or not state.get("legacy_guard_retired"):
                return False
            await self.bus.publish(
                ToolingMethods.MESH_ENFORCEMENT_ACTIVATED,
                ToolingMeshEnforcementActivated(revision=int(state["revision"])),
                event=True,
                mesh=False,
                origin="internal",
            )
            return True
        except Exception as exc:
            log_warning(f"Tooling mesh activation remains fail-closed: {exc}")
            return False

    @method_contract(
        method_id=GatewayMethods.FETCH_TOOLING_EXPORT_CATALOG_PAGE,
        summary="Fetch one authenticated recipient-specific Tooling projection page",
        input_model=GatewayFetchToolingExportCatalogPageRequest,
        output_model=GatewayFetchToolingExportCatalogPageResponse,
        exposure="internal",
        method_type="use",
    )
    async def _fetch_tooling_export_catalog_page(
        self,
        request: GatewayFetchToolingExportCatalogPageRequest,
    ) -> GatewayFetchToolingExportCatalogPageResponse:
        """Proxy a page over the exact authenticated stable-peer RTC route."""

        rtc_client = self._rtc_client
        bridge = self._mesh_peer_bridge
        local_peer_id = self._mesh_peer_id
        if rtc_client is None or bridge is None or not local_peer_id:
            return GatewayFetchToolingExportCatalogPageResponse(
                ok=False,
                reason_code="mesh_transport_unavailable",
            )
        revisions = rtc_client.remote_tooling_authority_revisions(request.provider_peer_id)
        granted_permissions = rtc_client.remote_tooling_authority_grants(request.provider_peer_id)
        if revisions is None or granted_permissions is None:
            return GatewayFetchToolingExportCatalogPageResponse(
                ok=False,
                reason_code="authenticated_provider_unavailable",
            )
        auth_grant_revision, manifest_revision = revisions
        result = await bridge.call(
            request.provider_peer_id,
            ToolingMethods.GET_EXPORT_CATALOG,
            request.request,
            timeout=30.0,
            principal_id=f"mesh:{local_peer_id}",
            effective_perms=["Tooling.use"],
            identity_source="gateway_tooling_projection_proxy",
            method_type="use",
            caller_peer_id=local_peer_id,
            auth_grant_revision=auth_grant_revision,
            manifest_revision=manifest_revision,
        )
        if not result.ok or result.data is None:
            log_warning(f"Tooling projection page fetch failed for {request.provider_peer_id}")
            return GatewayFetchToolingExportCatalogPageResponse(
                ok=False,
                reason_code="projection_fetch_failed",
            )
        try:
            page = (
                result.data
                if isinstance(result.data, ToolingGetExportCatalogResponse)
                else ToolingGetExportCatalogResponse.model_validate(result.data)
            )
        except Exception:
            return GatewayFetchToolingExportCatalogPageResponse(
                ok=False,
                reason_code="projection_response_invalid",
            )
        if (
            page.provider_peer_id != request.provider_peer_id
            or page.service_instance_id
            not in _tooling_service_instance_ids(request.provider_peer_id)
            or page.selected_protocol_tier != "projection_v1"
        ):
            return GatewayFetchToolingExportCatalogPageResponse(
                ok=False,
                reason_code="projection_provider_mismatch",
            )
        return GatewayFetchToolingExportCatalogPageResponse(
            page=page,
            granted_permissions=list(granted_permissions),
        )

    async def _get_registry_export(self) -> GetRegistryResponse:
        """Return registry export, or an empty typed response when unavailable."""
        if not self._registry_aggregator:
            return GetRegistryResponse()
        try:
            export = await self._registry_aggregator.get_registry_export()
        except Exception as exc:
            log_warning(f"Support bundle registry export failed: {exc}")
            return GetRegistryResponse()
        return GetRegistryResponse.model_validate(export)

    async def _get_services_snapshot(self) -> list[ServiceInfo]:
        """Return known services from the registry aggregator."""
        if not self._registry_aggregator:
            return []
        try:
            return await self._registry_aggregator.get_services()
        except Exception as exc:
            log_warning(f"Support bundle service snapshot failed: {exc}")
            return []

    def _service_health_response(self, service: ServiceInfo) -> GetServiceHealthResponse:
        """Convert registry service status into the support-bundle health shape."""
        return GetServiceHealthResponse(
            module=service.module,
            status=service.status,
            checks={
                "registry": "present",
                "heartbeat": service.status,
                "contracts": "present" if service.method_count else "empty",
            },
            timestamp=datetime.now(UTC).isoformat(),
        )

    async def _build_bus_health(self) -> BusHealth:
        """Build a non-mutating bus health snapshot."""
        bus = _bus_health_target(self.bus)
        backend = bus.__class__.__name__
        stats = bus.get_stats() if hasattr(bus, "get_stats") else {}
        degraded_reasons: list[str] = []

        if backend == "LocalBus":
            return BusHealth(
                backend=backend,
                redis_url_redacted=None,
                redis_reachable=None,
                bullmq_available=None,
                queue_lag_known=True,
                published=stats.get("published"),
                delivered=stats.get("delivered"),
                retries=stats.get("retries"),
                dead_letters=stats.get("dead_letters"),
                status="healthy",
                degraded_reasons=[],
            )

        redis_url = getattr(bus, "redis_url", os.getenv("REDIS_URL"))
        bullmq_available = getattr(bus, "_available", None)
        redis_reachable: bool | None = None
        error: str | None = None

        if hasattr(bus, "_get_redis"):
            try:
                redis = await bus._get_redis()
                redis_reachable = bool(await asyncio.wait_for(redis.ping(), timeout=1.0))
            except Exception as exc:
                redis_reachable = False
                error = str(exc)
                degraded_reasons.append("redis_unreachable")

        queue_lag_known = False
        queue_depth = None
        degraded_reasons.append("bullmq_queue_lag_unknown")
        if bullmq_available is False:
            degraded_reasons.append("bullmq_unavailable")

        dead_letters = stats.get("dead_letters")
        if dead_letters:
            degraded_reasons.append("bullmq_dead_letters_present")

        status = "healthy"
        if redis_reachable is False or bullmq_available is False:
            status = "unhealthy"
        elif degraded_reasons:
            status = "degraded"

        return BusHealth(
            backend=backend,
            redis_url_redacted=_redact_url(redis_url),
            redis_reachable=redis_reachable,
            bullmq_available=bullmq_available,
            queue_lag_known=queue_lag_known,
            queue_depth=queue_depth,
            published=stats.get("published"),
            delivered=stats.get("delivered"),
            retries=stats.get("retries"),
            dead_letters=dead_letters,
            status=status,
            degraded_reasons=sorted(set(degraded_reasons)),
            error=error,
        )

    def _build_service_process_topology(
        self,
        services: list[ServiceInfo],
    ) -> list[ServiceProcessTopology]:
        """Convert registry services into a sanitized topology list."""
        if self._mode == "threads":
            return [
                ServiceProcessTopology(
                    module=service.module,
                    status=service.status,
                    topology="thread",
                    instance_id=service.instance_id,
                    process_hint="single-process",
                    last_seen=service.last_seen,
                    stale=False,
                )
                for service in sorted(services, key=lambda item: item.module)
            ]

        return [
            ServiceProcessTopology(
                module=service.module,
                status=service.status,
                topology="process",
                instance_id=service.instance_id,
                container_hint=_compose_service_hint(service.module),
                process_hint="separate-service-process",
                last_seen=service.last_seen,
                stale=service.status in {"degraded", "unhealthy", "unknown"},
            )
            for service in sorted(services, key=lambda item: item.module)
        ]

    def _container_topology_hints(self) -> ContainerTopologyHints:
        """Return static, non-secret topology hints for UI copy and diagnostics."""
        if self._mode == "processes":
            return ContainerTopologyHints(
                orchestrator="docker-compose",
                compose_file="docker-compose.process.yml",
                redis_service="redis",
                gateway_service="gateway-service",
                config_service="config-service",
                notes=[
                    "process mode is orchestrated by Docker Compose or equivalent service runners",
                    "Redis/BullMQ is required for cross-process bus delivery",
                ],
            )
        return ContainerTopologyHints(
            orchestrator="in-process-supervisor",
            notes=[
                "thread mode runs services in one Python process",
                "process controls and per-container health are unsupported in thread mode",
            ],
        )

    def _native_capability_diagnostics(
        self,
        *,
        registry: GetRegistryResponse,
        services: list[ServiceInfo],
    ) -> list[SupportBundleDiagnosticItem]:
        """Expose speech readiness from registered services without payload data."""
        topics_by_module = {
            module.module: {method.bus_topic for method in module.methods if method.bus_topic}
            for module in registry.modules
        }
        states_by_module: dict[str, set[str]] = {}
        for service in services:
            states_by_module.setdefault(service.module, set()).add(service.status)
        checks: tuple[tuple[str, str, tuple[str, ...]], ...] = (
            (
                "Listening readiness",
                "STTCoordinator",
                (
                    STTMethods.LISTEN,
                    STTMethods.STOP_LISTENING,
                    STTMethods.CAPTURE_PREPARE,
                    STTMethods.CAPTURE_RELEASE,
                ),
            ),
            (
                "Wake phrase readiness",
                "WakeWord",
                (
                    WakeWordMethods.CONTROL,
                    WakeWordMethods.PROCESS_AUDIO,
                    WakeWordMethods.DETECT,
                ),
            ),
            (
                "Speech recognition readiness",
                "Transcription",
                (
                    TranscriptionMethods.CONTROL,
                    TranscriptionMethods.PROCESS_AUDIO,
                    TranscriptionMethods.TRANSCRIBE,
                ),
            ),
            (
                "Speech playback readiness",
                "TTS",
                (
                    TTSMethods.REQUEST,
                    TTSMethods.SYNTHESIZE,
                    TTSMethods.LIST_LANGUAGE_PACKS,
                    TTSMethods.INSTALL_VOICE_PROFILE,
                    TTSMethods.SET_DEFAULT_VOICE,
                ),
            ),
        )

        diagnostics: list[SupportBundleDiagnosticItem] = []
        for name, module, required_topics in checks:
            module_topics = topics_by_module.get(module, set())
            present = sum(1 for topic in required_topics if topic in module_topics)
            missing = len(required_topics) - present
            service_states = states_by_module.get(module, set())
            if "healthy" in service_states and missing == 0:
                readiness = "ready"
            elif service_states.intersection({"healthy", "degraded"}) or present:
                readiness = "degraded"
            else:
                readiness = "unavailable"
            diagnostics.append(
                SupportBundleDiagnosticItem(
                    name=name,
                    status=readiness,
                    source="Aurora service list",
                    details={
                        "available": readiness == "ready",
                        "available_actions": present,
                        "expected_actions": len(required_topics),
                        "missing_actions": missing,
                    },
                )
            )
        return diagnostics

    def _sidecar_log_diagnostics(self) -> list[SupportBundleDiagnosticItem]:
        """Expose sidecar log availability without reading local files or secrets."""
        return [
            SupportBundleDiagnosticItem(
                name="gateway_sidecar_logs",
                status="metadata_only",
                source="gateway runtime",
                details={
                    "reason": "no sidecar log collector is registered; raw logs are omitted",
                    "omitted_payloads": ["host paths", "tokens", "raw audio", "personal content"],
                },
            )
        ]

    async def _audit_support_bundle_export(
        self,
        *,
        correlation_id: str | None,
        registry: GetRegistryResponse,
        services: list[ServiceInfo],
        event_count: int,
        audit_event_count: int,
    ) -> tuple[str | None, str | None]:
        """Store a redacted audit event for diagnostics bundle generation."""
        receipt = f"support_bundle:{uuid.uuid4()}"
        details = {
            "audit_receipt": receipt,
            "correlation_id": correlation_id,
            "registry_digest": registry.digest,
            "service_count": len(services),
            "method_count": registry.method_count,
            "event_count": event_count,
            "audit_event_count": audit_event_count,
            "secrets_redacted": True,
            "omitted_payloads": list(_SUPPORT_BUNDLE_OMITTED_PAYLOADS),
        }
        try:
            result = await self.bus.request(
                AuthMethods.STORE_AUDIT_EVENT,
                StoreAuditEventRequest(
                    event="diagnostics.support_bundle.exported",
                    principal_id=None,
                    details=json.dumps(details, sort_keys=True),
                ),
                timeout=5.0,
                origin="internal",
                correlation_id=correlation_id,
            )
        except Exception as exc:
            log_warning(f"Support bundle audit storage failed: {exc}")
            return None, str(exc)
        if hasattr(result, "ok") and not result.ok:
            error = result.error or "audit storage failed"
            log_warning(f"Support bundle audit storage failed: {error}")
            return None, error
        data = getattr(result, "data", None)
        if hasattr(data, "success") and not data.success:
            error = getattr(data, "message", None) or "audit storage failed"
            log_warning(f"Support bundle audit storage failed: {error}")
            return None, error
        return receipt, None

    async def _get_gateway_config(self) -> Any:
        """Get gateway configuration from ConfigService.

        Returns:
            Gateway configuration object
        """
        try:
            from app.services.gateway.config import (
                APISettings,
                MeshConfig,
                MQTTSettings,
                PermissionSettings,
                Settings,
                WebRTCSettings,
            )
            from app.shared.config.interface import ConfigAPI

            config_api = ConfigAPI()

            gw_conf = await config_api.aget(
                ConfigKeys.services.gateway,
                GatewayConfigModel,
                config_timeout=20.0,
            )
            auth_conf = await config_api.aget(
                ConfigKeys.services.auth,
                AuthConfigModel,
                config_timeout=20.0,
            )

            gw_d = gw_conf.model_dump(mode="python")
            auth_d = auth_conf.model_dump(mode="python")

            api_d = dict(gw_d.get("api") or {})
            if os.environ.get("AURORA_TAURI_MANAGED_SIDECAR") == "1":
                gateway_for_api_enabled = True
                api_d["host"] = os.environ.get(
                    "AURORA_GATEWAY_HOST", api_d.get("host", "127.0.0.1")
                )
                if os.environ.get("AURORA_GATEWAY_PORT"):
                    api_d["port"] = int(os.environ["AURORA_GATEWAY_PORT"])
            else:
                gateway_for_api_enabled = bool(gw_d.get("enabled", True))
            if "token_secret" in api_d:
                api_d["token_secret"] = _config_secret_plain(api_d.get("token_secret"))

            gateway_for_api = {k: v for k, v in gw_d.items() if k != "api"}
            gateway_for_api["enabled"] = gateway_for_api_enabled
            gateway_for_api.update(api_d)
            gateway_for_api["auth"] = dict(auth_d)
            if (
                os.environ.get("AURORA_TAURI_MANAGED_SIDECAR") == "1"
                and os.environ.get("AURORA_TAURI_DISABLE_GATEWAY_AUTH", "1") == "1"
            ):
                gateway_for_api["auth"]["enabled"] = False
            raw_keys = gateway_for_api["auth"].get("api_keys")
            if raw_keys:
                gateway_for_api["auth"]["api_keys"] = [_config_secret_plain(x) for x in raw_keys]

            mesh = dict(gw_d.get("mesh_network") or {})

            service_paths: dict[str, tuple[str, ...]] = {
                "STTCoordinator": ("stt", "coordinator"),
                "WakeWord": ("stt", "wakeword"),
                "Transcription": ("stt", "transcription"),
                "DB": ("db",),
                "TTS": ("tts",),
                "Tooling": ("tooling",),
                "Scheduler": ("scheduler",),
                "Orchestrator": ("orchestrator",),
            }
            raw_services = await config_api.aget(
                ConfigKeys.services,
                default={},
                config_timeout=20.0,
            )
            if not isinstance(raw_services, dict) or not raw_services:
                raw_services = {}

            async def _fallback_service_raw(
                sharing_key: str,
                routing_key: str,
            ) -> tuple[dict[str, Any], dict[str, Any] | None, bool]:
                sharing = await config_api.aget(sharing_key, MeshSharing, config_timeout=20.0)
                routing = await config_api.aget(
                    routing_key,
                    default=None,
                    config_timeout=20.0,
                )
                return (
                    sharing.model_dump(mode="python"),
                    routing if isinstance(routing, dict) else None,
                    routing is not None,
                )

            fallback_keys: dict[str, tuple[str, str]] = {
                "STTCoordinator": (
                    ConfigKeys.services.stt.coordinator.mesh_sharing,
                    ConfigKeys.services.stt.coordinator.mesh_routing,
                ),
                "WakeWord": (
                    ConfigKeys.services.stt.wakeword.mesh_sharing,
                    ConfigKeys.services.stt.wakeword.mesh_routing,
                ),
                "Transcription": (
                    ConfigKeys.services.stt.transcription.mesh_sharing,
                    ConfigKeys.services.stt.transcription.mesh_routing,
                ),
                "DB": (ConfigKeys.services.db.mesh_sharing, ConfigKeys.services.db.mesh_routing),
                "TTS": (
                    ConfigKeys.services.tts.mesh_sharing,
                    ConfigKeys.services.tts.mesh_routing,
                ),
                "Tooling": (
                    ConfigKeys.services.tooling.mesh_sharing,
                    ConfigKeys.services.tooling.mesh_routing,
                ),
                "Scheduler": (
                    ConfigKeys.services.scheduler.mesh_sharing,
                    ConfigKeys.services.scheduler.mesh_routing,
                ),
                "Orchestrator": (
                    ConfigKeys.services.orchestrator.mesh_sharing,
                    ConfigKeys.services.orchestrator.mesh_routing,
                ),
            }

            services: dict[str, Any] = {}
            for module_name, raw_path in service_paths.items():
                service_raw = _raw_child(raw_services, raw_path)
                if service_raw is not None:
                    sharing_raw = service_raw.get("mesh_sharing")
                    routing_raw = service_raw.get("mesh_routing")
                    routing_present = "mesh_routing" in service_raw
                else:
                    sharing_key, routing_key = fallback_keys[module_name]
                    sharing_raw, routing_raw, routing_present = await _fallback_service_raw(
                        sharing_key,
                        routing_key,
                    )
                services[module_name] = _mesh_service_policy_from_raw(
                    sharing_raw=sharing_raw if isinstance(sharing_raw, dict) else {},
                    routing_raw=routing_raw if isinstance(routing_raw, dict) else None,
                    routing_present=routing_present,
                )

            mesh["services"] = services

            webrtc_d = dict(gw_d.get("webrtc") or {})
            if webrtc_d:
                webrtc_d["password"] = _config_secret_plain(webrtc_d.get("password")) or ""

            mqtt_d = dict(gw_d.get("signaling_mqtt") or {})

            return Settings(
                api=APISettings.from_gateway_dict(gateway_for_api),
                webrtc=WebRTCSettings.model_validate(webrtc_d) if webrtc_d else WebRTCSettings(),
                signaling_mqtt=MQTTSettings.model_validate(mqtt_d) if mqtt_d else MQTTSettings(),
                permissions=PermissionSettings.model_validate(auth_d)
                if auth_d
                else PermissionSettings(),
                mesh=MeshConfig.model_validate(mesh) if mesh else MeshConfig(),
            )

        except Exception as e:
            from app.helpers.aurora_logger import log_warning

            log_warning(f"Failed to get gateway config, using defaults: {e}")
            from app.services.gateway.config import Settings

            return Settings()

    async def _start_gateway(self) -> None:
        """Start the FastAPI gateway if enabled."""
        settings = await self._get_gateway_config()
        config = settings.api

        if not config.enabled:
            log_info("Gateway disabled in configuration")
            return

        # Persist token_secret to .env when auth is enabled and it was auto-generated
        # (required for JWT signing and mesh inbound token encryption at rest)
        if config.auth_enabled:
            try:
                from dotenv import set_key

                from app.shared.config.interface import ConfigAPI

                cfg_api = ConfigAPI()
                has_env = bool(os.environ.get("AURORA_TOKEN_SECRET"))
                existing_secret = await cfg_api.aget(
                    ConfigKeys.services.gateway.api.token_secret,
                    default="",
                    config_timeout=20.0,
                )
                plain_secret = _config_secret_plain(existing_secret)
                has_config = bool(str(plain_secret).strip()) if plain_secret is not None else False
                if not has_env and not has_config:
                    env_path = os.environ.get("AURORA_ENV_FILE", ".env")
                    Path(env_path).parent.mkdir(parents=True, exist_ok=True)
                    if not os.path.exists(env_path):
                        open(env_path, "a").close()
                    set_key(env_path, "AURORA_TOKEN_SECRET", config.token_secret)
                    os.environ["AURORA_TOKEN_SECRET"] = config.token_secret
                    persisted = await cfg_api.aupdate_config(
                        ConfigKeys.services.gateway.api.token_secret,
                        config.token_secret,
                        timeout=20.0,
                    )
                    if not persisted:
                        log_warning(
                            "token_secret written to .env but Config.Set failed — "
                            "other services may not see services.gateway.api.token_secret until config is updated"
                        )
                    log_info(
                        "Auto-generated token_secret (JWT / mesh crypto): .env + ConfigService."
                    )
            except Exception as e:
                log_warning(f"Could not persist token_secret to .env: {e}")

        try:
            from app.services.gateway.fastapi_app import create_gateway_app
            from app.services.gateway.registry_aggregator import RegistryAggregator

            if not self._registry_aggregator:
                self._registry_aggregator = RegistryAggregator(
                    bus=self.bus,
                    mode=self._mode,
                )

            host = config.host
            port = config.port
            request_timeout = config.request_timeout
            cors_origins = config.cors_origins
            cors_allow_credentials = config.cors_allow_credentials

            auth_enabled = config.auth_enabled
            auth_api_keys = config.api_keys

            self._gateway_app = create_gateway_app(
                bus=self.bus,
                registry=self._registry_aggregator,
                cors_origins=cors_origins,
                cors_allow_credentials=cors_allow_credentials,
                auth_enabled=auth_enabled,
                auth_api_keys=auth_api_keys,
                request_timeout=request_timeout,
                admin_action_manager=self._admin_action_manager,
            )

            import uvicorn

            uvicorn_config = uvicorn.Config(
                self._gateway_app,
                host=host,
                port=port,
                log_level="info",
                access_log=True,
            )
            self._gateway_server = uvicorn.Server(uvicorn_config)
            self._gateway_task = asyncio.create_task(self._run_gateway_server())

            self._gateway_enabled = True
            log_info(f"Gateway started at http://{host}:{port}")
            log_info(f"  API docs: http://{host}:{port}/api/docs")

        except ImportError as e:
            log_warning(
                f"Gateway dependencies not installed. Install with: pip install 'aurora[gateway]'. Error: {e}"
            )
        except Exception as e:
            log_error(f"Failed to start gateway: {e}", exc_info=True)

    async def _run_gateway_server(self) -> None:
        """Run the uvicorn server (background task)."""
        server = self._gateway_server
        if not server:
            return
        try:
            await server.serve()
        except asyncio.CancelledError:
            log_debug("Gateway server task cancelled")
        except Exception as e:
            log_error(f"Gateway server error: {e}", exc_info=True)

    async def _persist_webrtc_credentials(
        self,
        settings: Any,
        *,
        provision_app_id: bool,
    ) -> bool:
        """Persist non-placeholder signaling credentials before RTC can start.

        Mesh instances also receive a unique application id. Standalone WebRTC keeps
        an explicitly configured application id for backwards compatibility, while
        still requiring a random room and password.
        """
        from app.shared.config.interface import ConfigAPI

        updates: list[tuple[str, str, str]] = []
        if provision_app_id and str(settings.webrtc.app_id or "").strip().lower() in {
            "",
            "aurora",
        }:
            updates.append(
                (
                    ConfigKeys.services.gateway.webrtc.app_id,
                    f"aurora-app-{secrets.token_hex(8)}",
                    "app_id",
                )
            )
        if str(settings.webrtc.room or "").strip().lower() in {"", "default"}:
            updates.append(
                (
                    ConfigKeys.services.gateway.webrtc.room,
                    f"aurora-room-{secrets.token_hex(8)}",
                    "room",
                )
            )
        if not str(settings.webrtc.password or "").strip():
            updates.append(
                (
                    ConfigKeys.services.gateway.webrtc.password,
                    secrets.token_urlsafe(32),
                    "password",
                )
            )

        if not updates:
            return True

        config_api = ConfigAPI()
        for key_path, value, attribute in updates:
            try:
                persisted = await config_api.aupdate_config(key_path, value, timeout=20.0)
            except Exception as exc:
                log_error(f"Could not persist secure WebRTC {attribute}: {exc}")
                return False
            if not persisted:
                log_error(
                    f"Could not persist secure WebRTC {attribute}; refusing to start transport"
                )
                return False
            setattr(settings.webrtc, attribute, value)

        log_info("Secure WebRTC signaling credentials generated and persisted")
        return True

    async def _wait_for_auth_pairing_service(self) -> bool:
        """Wait until Auth pairing contracts are subscribed without touching storage."""
        last_failure: dict[str, str] = {"category": "not_ready", "reason": "no_response"}
        for attempt in range(10):
            try:
                response = await self.bus.request(
                    AuthMethods.PAIRING_READY,
                    EmptyInput(),
                    timeout=1.0,
                    origin="internal",
                )
                if getattr(response, "ok", False) and bool(
                    getattr(getattr(response, "data", None), "success", False)
                    or (
                        isinstance(getattr(response, "data", None), dict)
                        and response.data.get("success") is True
                    )
                ):
                    return True
                last_failure = {
                    "category": "not_ready",
                    "reason": "unsuccessful_response",
                }
            except Exception as exc:
                last_failure = {
                    "category": "bus_exception",
                    "reason": type(exc).__name__,
                }
            if attempt < 9:
                await asyncio.sleep(0.25)
        log_debug(
            "Auth pairing readiness terminal diagnostic; "
            f"category={last_failure['category']} reason={last_failure['reason']}"
        )
        log_warning(
            "Auth pairing contracts unavailable; "
            f"category={last_failure['category']} reason={last_failure['reason']} "
            "mesh_transport=stopped"
        )
        log_error("Auth pairing contracts did not become ready; mesh transport will stay stopped")
        return False

    async def _ensure_mesh_prerequisites(self, settings: Any) -> bool:
        """Provision the secure, persistent services required by an enabled mesh."""
        if settings.mesh.enabled is not True:
            return True

        from app.shared.config.interface import ConfigAPI

        config_api = ConfigAPI()
        if not str(settings.mesh.node_name or "").strip():
            generated_node_name = f"aurora-node-{secrets.token_hex(4)}"
            try:
                persisted = await config_api.aupdate_config(
                    ConfigKeys.services.gateway.mesh_network.node_name,
                    generated_node_name,
                    timeout=20.0,
                )
            except Exception as exc:
                log_error(f"Could not persist the generated mesh node name: {exc}")
                return False
            if not persisted:
                log_error("Could not persist the generated mesh node name")
                return False
            settings.mesh = settings.mesh.model_copy(update={"node_name": generated_node_name})
            log_info("Generated and persisted a stable mesh node name")

        try:
            configured_token_secret = await config_api.aget(
                ConfigKeys.services.gateway.api.token_secret,
                default="",
                config_timeout=20.0,
            )
            if not str(_config_secret_plain(configured_token_secret) or "").strip():
                persisted = await config_api.aupdate_config(
                    ConfigKeys.services.gateway.api.token_secret,
                    settings.api.token_secret,
                    timeout=20.0,
                )
                if not persisted:
                    log_error("Could not persist the mesh token-encryption secret")
                    return False
        except Exception as exc:
            log_error(f"Could not provision the mesh token-encryption secret: {exc}")
            return False

        if settings.permissions.enabled is not True:
            try:
                persisted = await config_api.aupdate_config(
                    ConfigKeys.services.auth.enabled,
                    True,
                    timeout=20.0,
                )
            except Exception as exc:
                log_error(f"Could not enable Auth for mesh pairing: {exc}")
                return False
            if not persisted:
                log_error("Could not enable Auth for mesh pairing; refusing to start mesh")
                return False
            settings.permissions.enabled = True

        if not await self._persist_webrtc_credentials(settings, provision_app_id=True):
            return False

        if settings.webrtc.enabled is not True:
            try:
                persisted = await config_api.aupdate_config(
                    ConfigKeys.services.gateway.webrtc.enabled,
                    True,
                    timeout=20.0,
                )
            except Exception as exc:
                log_error(f"Could not enable WebRTC for mesh: {exc}")
                return False
            if not persisted:
                log_error("Could not enable WebRTC for mesh; refusing to start mesh")
                return False
            settings.webrtc.enabled = True

        if not await self._wait_for_auth_pairing_service():
            return False

        log_info("Secure mesh prerequisites are active")
        return True

    async def _start_webrtc(self, settings: Any | None = None) -> bool:
        """Serialize RTC startup so mesh recovery cannot create duplicate clients."""
        async with self._rtc_start_lock:
            return await self._start_webrtc_once(settings)

    async def _start_webrtc_once(self, settings: Any | None = None) -> bool:
        """Start the WebRTC client if enabled and secure credentials are persisted."""
        rtc_client = None
        try:
            if self._rtc_client:
                log_debug("WebRTC client already initialized - skipping duplicate start")
                return True

            settings = settings or await self._get_gateway_config()

            if settings.mesh.enabled is True and not await self._ensure_mesh_prerequisites(
                settings
            ):
                return False
            if not settings.webrtc.enabled:
                log_info("WebRTC disabled in configuration")
                return False
            if settings.mesh.enabled is not True and not await self._persist_webrtc_credentials(
                settings,
                provision_app_id=False,
            ):
                return False

            if not self._registry_aggregator:
                from app.services.gateway.registry_aggregator import RegistryAggregator

                self._registry_aggregator = RegistryAggregator(
                    bus=self.bus,
                    mode=self._mode,
                )

            await self._registry_aggregator.start()

            from app.services.gateway.auth_proxy import BusAuthProxy
            from app.services.gateway.dependencies import set_rtc_client
            from app.services.gateway.webrtc.rtc_client import RTCClient

            auth_proxy = BusAuthProxy(self.bus)

            rtc_client = RTCClient(
                settings=settings,
                bus=self.bus,
                registry=self._registry_aggregator,
                auth_service=auth_proxy,
                require_auth=_rtc_requires_auth(settings),
                rollout_metrics=self._mesh_rollout_metrics,
            )
            rtc_client._pairing_timeout = settings.permissions.webrtc_pairing_timeout_seconds
            # A mesh client must not publish presence until its durable identity,
            # saved credentials, callbacks, and registry are installed.  A
            # retained ephemeral presence can otherwise start a pairing session
            # that persists the wrong node identity during startup.
            await rtc_client.start(join_room=settings.mesh.enabled is not True)
            transport_fingerprint = _rtc_transport_config_fingerprint(settings)
            set_rtc_client(rtc_client)
            self._rtc_client = rtc_client
            self._rtc_transport_fingerprint = transport_fingerprint
            log_info("WebRTC client started")
            return True

        except asyncio.CancelledError:
            if rtc_client is not None:
                with contextlib.suppress(Exception):
                    await rtc_client.close()
            raise
        except ImportError as e:
            log_warning(f"WebRTC dependencies not installed: {e}")
            return False
        except Exception as e:
            if rtc_client is not None:
                try:
                    await rtc_client.close()
                except Exception as close_exc:
                    log_warning(f"Could not close partially started WebRTC client: {close_exc}")
            log_error(f"Failed to start WebRTC client: {e}", exc_info=True)
            return False

    async def _stop_webrtc(self) -> None:
        """Stop the WebRTC client."""
        if self._rtc_client:
            from app.services.gateway.dependencies import set_rtc_client

            log_info("Stopping WebRTC client...")
            await self._rtc_client.close()
            self._rtc_client = None
            set_rtc_client(None)
            log_info("WebRTC client stopped")
        self._rtc_transport_fingerprint = None

    async def _stop_gateway(self) -> None:
        """Stop the FastAPI gateway."""
        if not self._gateway_enabled:
            return

        log_info("Stopping gateway...")

        try:
            if self._gateway_server:
                self._gateway_server.should_exit = True

            if self._gateway_task and not self._gateway_task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(self._gateway_task), timeout=5.0)
                except TimeoutError:
                    self._gateway_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await self._gateway_task

            if self._registry_aggregator:
                await self._registry_aggregator.stop()

            self._gateway_enabled = False
            log_info("Gateway stopped")

        except Exception as e:
            log_error(f"Error stopping gateway: {e}")

    async def _reload_auth_config(self) -> None:
        """Reload WebRTC auth/permission settings from config."""
        try:
            settings = await self._get_gateway_config()
            perm_settings = settings.permissions

            if self._rtc_client:
                self._rtc_client._auth_timeout = perm_settings.webrtc_auth_timeout_seconds
                self._rtc_client._pairing_timeout = perm_settings.webrtc_pairing_timeout_seconds
                self._rtc_client._require_auth = _rtc_requires_auth(settings)

            from app.services.gateway.auth_proxy import BusAuthProxy
            from app.services.gateway.dependencies import get_gateway_auth

            gateway_auth = get_gateway_auth()
            gateway_auth._auth_service = BusAuthProxy(self.bus)
            gateway_auth._api_keys = set(settings.api.api_keys or [])
            gateway_auth.set_enabled(settings.api.auth_enabled)

            log_debug(
                f"WebRTC auth config reloaded: webrtc_auth_timeout={perm_settings.webrtc_auth_timeout_seconds}s, "
                f"pairing_timeout={perm_settings.webrtc_pairing_timeout_seconds}s, "
                f"peer_auth_enabled={_rtc_requires_auth(settings)}, "
                f"api_auth_enabled={settings.api.auth_enabled}"
            )
        except Exception as e:
            log_error(f"Error reloading auth config: {e}")

    async def _reload_gateway_config(self) -> None:
        """Reload gateway configuration dynamically."""
        try:
            settings = await self._get_gateway_config()

            if settings.api.enabled and not self._gateway_enabled:
                log_info("Gateway enabled via config - starting gateway")
                await self._start_gateway()
            elif not settings.api.enabled and self._gateway_enabled:
                log_info("Gateway disabled via config - stopping gateway")
                await self._stop_gateway()

            if settings.mesh.enabled is True and not await self._ensure_mesh_prerequisites(
                settings
            ):
                await self._stop_mesh()
                await self._stop_webrtc()
                log_error("Mesh prerequisites are not secure and persistent; transport stopped")
                return

            if settings.webrtc.enabled and not self._rtc_client:
                log_info("WebRTC enabled via config - starting WebRTC client")
                await self._start_webrtc(settings)
            elif not settings.webrtc.enabled and self._rtc_client:
                log_info("WebRTC disabled via config - stopping WebRTC client")
                await self._stop_mesh()
                await self._stop_webrtc()
            elif settings.webrtc.enabled and self._rtc_client:
                desired_fingerprint = _rtc_transport_config_fingerprint(settings)
                if self._rtc_transport_fingerprint is None:
                    self._rtc_transport_fingerprint = desired_fingerprint
                elif desired_fingerprint != self._rtc_transport_fingerprint:
                    log_info("WebRTC signaling configuration changed - restarting transport")
                    await self._stop_mesh()
                    await self._stop_webrtc()
                    await self._start_webrtc(settings)

            log_info("Gateway config reloaded")

        except Exception as e:
            log_error(f"Error reloading gateway config: {e}")

    # ── Mesh P2P lifecycle ───────────────────────────────────────────────

    async def _load_mesh_inbound_credentials(self, room_name: str) -> None:
        """Load canonical peer-scoped credentials or fail before joining the room."""
        try:
            from app.shared.contracts.models.mesh import MeshPeerLoadInboundRequest

            response = await self.bus.request(
                AuthMethods.MESH_LOAD_INBOUND_CREDENTIALS,
                MeshPeerLoadInboundRequest(room_name=room_name),
                timeout=5.0,
            )

            if hasattr(response, "ok") and not response.ok:
                raise RuntimeError(getattr(response, "error", None) or "credential load failed")
            if isinstance(response, dict) and "ok" in response:
                if response.get("ok") is not True:
                    raise RuntimeError(str(response.get("error") or "credential load failed"))
                data = response.get("data")
            else:
                data = response.data if hasattr(response, "data") else response

            credentials = (
                data.get("credentials")
                if isinstance(data, dict)
                else getattr(data, "credentials", None)
            )
            if not isinstance(credentials, dict):
                raise RuntimeError("credential load returned an invalid response")

            if credentials:
                self._rtc_client.set_saved_peer_tokens(credentials)
                log_info(f"Loaded {len(credentials)} inbound credential(s) for room '{room_name}'")
            else:
                log_debug(f"No inbound credentials for room '{room_name}'; pairing is required")
        except Exception as exc:
            log_error(f"Could not load mesh credentials: {exc}")
            raise RuntimeError("Could not load mesh credentials") from exc

    async def _persist_mesh_inbound_credential(
        self,
        *,
        bus: Any,
        room_name: str,
        token: str,
        token_id: str,
        remote_peer_id: str | None,
        remote_device_id: str | None = None,
        remote_user_id: str | None = None,
        remote_node_name: str | None = None,
        permissions: list[str] | None = None,
    ) -> None:
        """Persist an inbound token only under its canonical peer identity."""
        if not remote_peer_id:
            raise ValueError("Cannot persist a mesh pairing token without a remote peer id")

        try:
            from app.shared.contracts.models.mesh import (
                MeshPeerSaveInboundRequest,
                MeshPeerUpsertRequest,
            )

            upsert_response = await bus.request(
                AuthMethods.MESH_UPSERT_PEER,
                MeshPeerUpsertRequest(
                    peer_id=remote_peer_id,
                    room_name=room_name,
                    node_name=remote_node_name or "",
                ),
                timeout=5.0,
            )
            self._require_mesh_persistence_success(upsert_response, "mesh peer upsert")

            save_response = await bus.request(
                AuthMethods.MESH_SAVE_INBOUND_CREDENTIAL,
                MeshPeerSaveInboundRequest(
                    remote_peer_id=remote_peer_id,
                    room_name=room_name,
                    token=token,
                    token_id=token_id,
                    permissions=permissions or [],
                    remote_device_id=remote_device_id,
                    remote_user_id=remote_user_id,
                    remote_node_name=remote_node_name,
                ),
                timeout=5.0,
            )
            self._require_mesh_persistence_success(save_response, "inbound credential save")
        except Exception as exc:
            log_error(f"Failed to persist mesh pairing token: {exc}")
            raise RuntimeError("Failed to persist mesh pairing token") from exc

    @staticmethod
    def _require_mesh_persistence_success(response: Any, operation: str) -> None:
        """Raise unless a mesh persistence contract explicitly confirms success."""
        if hasattr(response, "ok") and not response.ok:
            raise RuntimeError(getattr(response, "error", None) or f"{operation} failed")
        if isinstance(response, dict) and "ok" in response and response.get("ok") is not True:
            raise RuntimeError(str(response.get("error") or f"{operation} failed"))

        data = response.data if hasattr(response, "data") else response
        if isinstance(response, dict) and "data" in response and "ok" in response:
            data = response.get("data")
        success = data.get("success") if isinstance(data, dict) else getattr(data, "success", None)
        if success is not True:
            message = (
                data.get("message") if isinstance(data, dict) else getattr(data, "message", None)
            )
            raise RuntimeError(str(message or f"{operation} was not durably confirmed"))

    def _rewire_gateway_app_bus(self, bus: Any) -> None:
        """Point existing gateway HTTP route handlers at the current bus."""
        if not self._gateway_app:
            return
        self._gateway_app.state.bus = bus
        route_generator = getattr(self._gateway_app.state, "route_generator", None)
        if route_generator and hasattr(route_generator, "set_bus"):
            route_generator.set_bus(bus)

    async def _rollback_failed_mesh_start(
        self,
        *,
        inner_bus: Any | None,
        presence_attempted: bool,
    ) -> None:
        """Undo a partial mesh bootstrap so a later start can retry cleanly."""
        rtc_client = self._rtc_client
        if presence_attempted and rtc_client:
            adapter = getattr(rtc_client, "_adapter", None)
            if adapter:
                try:
                    await adapter.leave()
                except Exception as exc:
                    log_warning(f"Could not retract failed mesh presence: {exc}")

        failed_mesh_bus = self._mesh_bus
        if inner_bus is None and failed_mesh_bus is not None:
            inner_bus = getattr(failed_mesh_bus, "_inner", None)
        await self._stop_mesh_once(inner_bus=inner_bus)

    def _cancel_mesh_start_retry(self) -> asyncio.Task[None] | None:
        """Detach and cancel the one background mesh-start retry task."""
        task = self._mesh_start_retry_task
        self._mesh_start_retry_task = None
        if task and task is not asyncio.current_task() and not task.done():
            task.cancel()
        return task

    def _schedule_mesh_start_retry(self) -> None:
        """Schedule one bounded-backoff retry loop without spawning duplicates."""
        task = self._mesh_start_retry_task
        if self._mesh_bus is not None or (task is not None and not task.done()):
            return
        self._mesh_start_retry_task = asyncio.create_task(
            self._mesh_start_retry_loop(),
            name="gateway-mesh-start-retry",
        )
        log_info("Scheduled background mesh startup retry")

    async def _mesh_start_retry_loop(self) -> None:
        """Retry transient mesh bootstrap failures with one capped backoff loop."""
        delay = _MESH_START_RETRY_INITIAL_DELAY_S
        attempt = 0
        try:
            while self._mesh_bus is None:
                await asyncio.sleep(delay)
                try:
                    settings = await self._get_gateway_config()
                except Exception as exc:
                    log_warning(f"Mesh retry could not read configuration: {exc}")
                    delay = min(delay * 2, _MESH_START_RETRY_MAX_DELAY_S)
                    continue

                if settings.mesh.enabled is not True:
                    return

                if self._rtc_client is None and not await self._start_webrtc(settings):
                    log_warning("Mesh retry could not start the WebRTC transport")
                    delay = min(delay * 2, _MESH_START_RETRY_MAX_DELAY_S)
                    continue

                attempt += 1
                log_info(f"Retrying mesh startup in background (attempt {attempt})")
                try:
                    outcome = await self._start_mesh()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    log_warning(f"Unexpected mesh startup retry failure: {exc}")
                    outcome = _MeshStartOutcome.RETRY
                if outcome is not _MeshStartOutcome.RETRY:
                    return
                delay = min(delay * 2, _MESH_START_RETRY_MAX_DELAY_S)
        except asyncio.CancelledError:
            raise
        finally:
            if self._mesh_start_retry_task is asyncio.current_task():
                self._mesh_start_retry_task = None

    async def _start_mesh(self) -> _MeshStartOutcome:
        """Serialize mesh bootstrap and maintain its single background retry loop."""
        async with self._mesh_start_lock:
            outcome = await self._start_mesh_once()
            if outcome is _MeshStartOutcome.STARTED:
                self._cancel_mesh_start_retry()
            elif outcome is _MeshStartOutcome.RETRY:
                self._schedule_mesh_start_retry()
            return outcome

    async def _start_mesh_once(self) -> _MeshStartOutcome:
        """Initialize and start mesh P2P components if enabled.

        Creates PeerRegistry, RoutingTable, PeerBridge, LatencyMonitor,
        and MeshBus. Configures the RTCClient for mesh and replaces
        the global bus singleton.
        """
        inner_bus: Any | None = None
        presence_attempted = False
        try:
            if self._mesh_bus:
                log_debug("Mesh P2P already initialized — skipping duplicate start")
                return _MeshStartOutcome.STARTED

            settings = await self._get_gateway_config()
            mesh_config = settings.mesh
            mesh_config = self._mesh_policy_store.replace(mesh_config).mesh_config

            if not mesh_config.enabled:
                log_debug("Mesh P2P disabled in configuration")
                return _MeshStartOutcome.SKIPPED

            if not self._rtc_client:
                log_warning("Mesh P2P requires WebRTC — scheduling transport recovery")
                return _MeshStartOutcome.RETRY

            if not await self._wait_for_auth_pairing_service():
                log_error("Mesh P2P requires an active Auth pairing service — skipping mesh init")
                return _MeshStartOutcome.RETRY

            from app.messaging.bus_runtime import set_bus
            from app.messaging.mesh_bus import MeshBus
            from app.services.gateway.mesh.announcer import MeshAnnouncer
            from app.services.gateway.mesh.latency import LatencyMonitor
            from app.services.gateway.mesh.peer_bridge import PeerBridge
            from app.services.gateway.mesh.peer_registry import PeerRegistry
            from app.services.gateway.mesh.routing_table import RoutingTable

            # ── Fix 1: Stable peer_id from DB ────────────────────────────
            try:
                peer_id = await self._get_or_create_peer_id(mesh_config)
            except Exception as exc:
                self._mesh_peer_id = None
                log_error(f"Mesh P2P requires a durable stable identity — aborting start: {exc}")
                return _MeshStartOutcome.RETRY
            self._mesh_peer_id = peer_id

            # Create mesh components
            self._mesh_peer_registry = PeerRegistry(mesh_config, self._mesh_policy_provider)
            self._mesh_routing_table = RoutingTable(
                mesh_config,
                self._mesh_peer_registry,
                policy_provider=self._mesh_policy_provider,
                local_peer_id=peer_id,
            )
            self._mesh_peer_bridge = PeerBridge(
                self._rtc_client,
                self._mesh_peer_registry,
                legacy_event_broadcast=getattr(
                    settings.webrtc,
                    "legacy_event_broadcast",
                    True,
                ),
            )

            self._mesh_latency_monitor = LatencyMonitor(
                self._rtc_client,
                self._mesh_peer_registry,
                interval_s=mesh_config.ping_interval_s,
            )
            self._mesh_peer_bridge.set_latency_monitor(self._mesh_latency_monitor)

            # ── Fix 2: Wire DB persistence callbacks on PeerRegistry ─────
            room_name_for_callbacks = settings.webrtc.room or "default"
            bus_for_callbacks = self.bus

            async def _on_peer_registered(p_id: str, p_name: str, p_status: str) -> None:
                from app.shared.contracts.models.mesh import (
                    MeshPeerUpdateConnectionRequest,
                    MeshPeerUpsertRequest,
                )

                registry = self._mesh_peer_registry
                current = registry.get_peer(p_id) if registry is not None else None
                if current is None:
                    log_debug(f"Skipping stale peer registration callback for {p_id}")
                    return
                await bus_for_callbacks.request(
                    AuthMethods.MESH_UPSERT_PEER,
                    MeshPeerUpsertRequest(
                        peer_id=p_id,
                        room_name=room_name_for_callbacks,
                        node_name=current.node_name or p_name,
                    ),
                    timeout=5.0,
                )
                await bus_for_callbacks.request(
                    AuthMethods.MESH_UPDATE_PEER_CONNECTION,
                    MeshPeerUpdateConnectionRequest(
                        peer_id=p_id,
                        connection_status=_mesh_connection_status(current.status),
                    ),
                    timeout=5.0,
                )

            async def _on_peer_removed(p_id: str, p_name: str, p_status: str) -> None:
                from app.services.gateway.mesh.tooling_projection_transport import (
                    TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC,
                )
                from app.shared.contracts.models.mesh import (
                    MeshPeerUpdateConnectionRequest,
                )
                from app.shared.contracts.models.tooling import ToolingProjectionSyncRequested

                registry = self._mesh_peer_registry
                if registry is not None and registry.get_peer(p_id) is not None:
                    log_debug(f"Skipping stale peer removal callback for {p_id}")
                    return
                await bus_for_callbacks.request(
                    AuthMethods.MESH_UPDATE_PEER_CONNECTION,
                    MeshPeerUpdateConnectionRequest(
                        peer_id=p_id,
                        connection_status=_mesh_connection_status(p_status),
                    ),
                    timeout=5.0,
                )
                await bus_for_callbacks.publish(
                    TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC,
                    ToolingProjectionSyncRequested(
                        provider_peer_id=p_id,
                        service_instance_id=f"remote:{p_id}:Tooling",
                        reason_code="provider_disconnected",
                        force_full_snapshot=True,
                    ),
                    event=True,
                    mesh=False,
                    origin="internal",
                )

            async def _on_peer_status_changed(p_id: str, p_name: str, p_status: str) -> None:
                from app.services.gateway.mesh.tooling_projection_transport import (
                    TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC,
                )
                from app.shared.contracts.models.mesh import (
                    MeshPeerUpdateConnectionRequest,
                )
                from app.shared.contracts.models.tooling import ToolingProjectionSyncRequested

                registry = self._mesh_peer_registry
                current = registry.get_peer(p_id) if registry is not None else None
                if current is None or current.status != p_status:
                    log_debug(f"Skipping stale peer status callback for {p_id}: {p_status}")
                    return
                await bus_for_callbacks.request(
                    AuthMethods.MESH_UPDATE_PEER_CONNECTION,
                    MeshPeerUpdateConnectionRequest(
                        peer_id=p_id,
                        connection_status=_mesh_connection_status(p_status),
                    ),
                    timeout=5.0,
                )
                # Status transitions never restore an old projection. Tooling
                # retains metadata but must wait for a fresh verified baseline.
                await bus_for_callbacks.publish(
                    TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC,
                    ToolingProjectionSyncRequested(
                        provider_peer_id=p_id,
                        service_instance_id=f"remote:{p_id}:Tooling",
                        reason_code=f"provider_status_{p_status}",
                        force_full_snapshot=True,
                    ),
                    event=True,
                    mesh=False,
                    origin="internal",
                )
                if p_status == "negotiated" and self._rtc_client is not None:
                    self._rtc_client._request_manifest(  # noqa: SLF001
                        p_id,
                        reason="peer_status_transition",
                    )

            self._mesh_peer_registry.on_peer_registered = _on_peer_registered
            self._mesh_peer_registry.on_peer_removed = _on_peer_removed
            self._mesh_peer_registry.on_peer_status_changed = _on_peer_status_changed

            # Configure RTCClient for mesh
            self._rtc_client.set_mesh_identity(
                peer_id=peer_id,
                node_name=mesh_config.node_name or "",
            )
            self._rtc_client.set_authority_refresh_callback(self._refresh_mesh_authority_for_peer)
            async with self._mesh_authority_lock:
                if not await self._reconcile_mesh_authority_snapshot(complete=True):
                    log_warning("Mesh P2P authority snapshot failed — scheduling start retry")
                    await self._rollback_failed_mesh_start(
                        inner_bus=inner_bus,
                        presence_attempted=presence_attempted,
                    )
                    return _MeshStartOutcome.RETRY

            self._rtc_client.configure_mesh(
                mesh_config=mesh_config,
                peer_registry=self._mesh_peer_registry,
                peer_bridge=self._mesh_peer_bridge,
                policy_provider=self._mesh_policy_provider,
            )

            # Load peer-scoped inbound credentials. An empty mapping means
            # the device has not paired yet; there is no room-wide fallback.
            room_name = settings.webrtc.room or "default"
            await self._load_mesh_inbound_credentials(room_name)

            # ── Fix 3: Per-peer persist callback ─────────────────────────
            bus_ref = self.bus  # capture for closure

            async def _persist_token(
                token_str: str,
                token_id: str = "",
                remote_device_id: str | None = None,
                remote_user_id: str | None = None,
                remote_peer_id: str | None = None,
                remote_node_name: str | None = None,
                permissions: list[str] | None = None,
            ) -> None:
                """Persist an inbound token from a remote peer."""
                await self._persist_mesh_inbound_credential(
                    bus=bus_ref,
                    room_name=room_name,
                    token=token_str,
                    token_id=token_id,
                    remote_peer_id=remote_peer_id,
                    remote_device_id=remote_device_id,
                    remote_user_id=remote_user_id,
                    remote_node_name=remote_node_name,
                    permissions=permissions,
                )

            self._rtc_client.set_on_token_saved(_persist_token)

            # Create MeshBus wrapping the current service bus. In process mode the
            # legacy bus_runtime singleton is not initialized, but BaseService.bus
            # already points at this service's active BullMQ bus.
            inner_bus = self.bus
            self._mesh_bus = MeshBus(
                inner_bus=inner_bus,
                routing_table=self._mesh_routing_table,
                peer_bridge=self._mesh_peer_bridge,
                mesh_config=mesh_config,
                policy_provider=self._mesh_policy_provider,
            )
            self._rtc_client.set_rpc_bus(self._mesh_bus)
            self._rewire_gateway_app_bus(self._mesh_bus)

            # Replace the global bus singleton with MeshBus
            # Update BOTH singletons so all code paths see the MeshBus
            set_bus(self._mesh_bus)
            from app.shared.messaging.bus_init import set_bus as set_shared_bus

            set_shared_bus(self._mesh_bus)

            # Start background tasks
            await self._mesh_peer_registry.start()
            await self._mesh_latency_monitor.start()

            # Start periodic manifest re-announcer
            self._mesh_announcer = MeshAnnouncer(
                self._rtc_client,
                interval_s=mesh_config.registry_announce_interval_s,
            )
            await self._mesh_announcer.start()

            # Joining is deliberately last: every retained presence now carries
            # the stable identity and reconnect proof material is already loaded.
            presence_attempted = True
            await self._rtc_client.refresh_presence()

            node_name = mesh_config.node_name or "unnamed"
            shared = [m for m, s in mesh_config.services.items() if s.export.share]
            routed = [m for m, s in mesh_config.services.items() if s.routing.prefer != "local"]
            log_info(
                f"Mesh P2P started — node='{node_name}', peer_id='{peer_id}', "
                f"sharing={shared}, routed={routed}"
            )
            return _MeshStartOutcome.STARTED

        except asyncio.CancelledError:
            await self._rollback_failed_mesh_start(
                inner_bus=inner_bus,
                presence_attempted=presence_attempted,
            )
            raise
        except ImportError as e:
            await self._rollback_failed_mesh_start(
                inner_bus=inner_bus,
                presence_attempted=presence_attempted,
            )
            log_warning(f"Mesh dependencies not available: {e}")
            return _MeshStartOutcome.SKIPPED
        except Exception as e:
            await self._rollback_failed_mesh_start(
                inner_bus=inner_bus,
                presence_attempted=presence_attempted,
            )
            log_error(f"Failed to start mesh P2P: {e}", exc_info=True)
            return _MeshStartOutcome.RETRY

    async def _get_or_create_peer_id(self, mesh_config: Any) -> str:
        """Load a stable peer_id from the DB, or generate and persist one.

        This ensures the same Aurora instance always announces the same
        ``peer_id`` across restarts, which is critical for bilateral peer
        approval and token mapping.

        Args:
            mesh_config: The current mesh configuration object.

        Returns:
            The stable peer_id string.
        """
        try:
            from app.shared.contracts.models.mesh import (
                MeshIdentityLoadRequest,
                MeshIdentitySaveRequest,
            )

            resp = await self.bus.request(
                AuthMethods.LOAD_MESH_IDENTITY,
                MeshIdentityLoadRequest(),
                timeout=40.0,
            )
            if hasattr(resp, "ok") and not resp.ok:
                raise RuntimeError(getattr(resp, "error", None) or "identity load failed")
            if isinstance(resp, dict) and "ok" in resp and resp.get("ok") is not True:
                raise RuntimeError(str(resp.get("error") or "identity load failed"))
            data = resp.data if hasattr(resp, "data") else resp
            if isinstance(data, dict):
                saved_peer_id = data.get("peer_id")
            elif hasattr(data, "peer_id"):
                saved_peer_id = getattr(data, "peer_id", None)
            else:
                raise RuntimeError("identity load returned an invalid response")

            node_name = getattr(mesh_config, "node_name", "") or ""

            if saved_peer_id is not None:
                if not isinstance(saved_peer_id, str) or not saved_peer_id.strip():
                    raise RuntimeError("identity load returned an invalid peer ID")
                log_info(f"Loaded stable mesh peer_id from DB: {saved_peer_id}")
                # Update node_name if changed
                save_resp = await self.bus.request(
                    AuthMethods.SAVE_MESH_IDENTITY,
                    MeshIdentitySaveRequest(peer_id=saved_peer_id, node_name=node_name),
                    timeout=5.0,
                )
                self._require_durable_mesh_identity_save(save_resp)
                return saved_peer_id

            # Generate new peer_id
            new_peer_id = f"aurora-{secrets.token_hex(16)}"
            save_resp = await self.bus.request(
                AuthMethods.SAVE_MESH_IDENTITY,
                MeshIdentitySaveRequest(peer_id=new_peer_id, node_name=node_name),
                timeout=5.0,
            )
            self._require_durable_mesh_identity_save(save_resp)
            log_info(f"Generated and saved new mesh peer_id: {new_peer_id}")
            return new_peer_id

        except Exception as e:
            log_error(f"Could not establish durable mesh identity: {e}")
            raise RuntimeError("Could not establish durable mesh identity") from e

    @staticmethod
    def _require_durable_mesh_identity_save(response: Any) -> None:
        """Raise unless Auth confirms an exact, durable identity write."""
        if hasattr(response, "ok") and not response.ok:
            raise RuntimeError(getattr(response, "error", None) or "identity save failed")
        if isinstance(response, dict) and "ok" in response and response.get("ok") is not True:
            raise RuntimeError(str(response.get("error") or "identity save failed"))

        data = response.data if hasattr(response, "data") else response
        success = data.get("success") if isinstance(data, dict) else getattr(data, "success", None)
        if success is not True:
            raise RuntimeError("identity save was not durably confirmed")

    async def _stop_mesh(self) -> None:
        """Cancel pending retries and serialize shutdown against mesh bootstrap."""
        policy_retry = self._cancel_mesh_policy_retry()
        if policy_retry and policy_retry is not asyncio.current_task():
            with contextlib.suppress(asyncio.CancelledError):
                await policy_retry
        retry_task = self._cancel_mesh_start_retry()
        if retry_task and retry_task is not asyncio.current_task():
            with contextlib.suppress(asyncio.CancelledError):
                await retry_task
        async with self._mesh_start_lock:
            await self._stop_mesh_once()

    def _publish_disabled_mesh_policy(self) -> None:
        current = self._mesh_policy_store.current().mesh_config
        if current.enabled:
            self._mesh_policy_store.replace(current.model_copy(update={"enabled": False}))

    async def _stop_mesh_once(self, *, inner_bus: Any | None = None) -> None:
        """Stop mesh P2P components and restore original bus."""
        mesh_bus = self._mesh_bus
        if inner_bus is None and mesh_bus is not None:
            inner_bus = getattr(mesh_bus, "_inner", None)

        log_info("Stopping mesh P2P...")
        self._publish_disabled_mesh_policy()

        if inner_bus is not None:
            try:
                from app.messaging.bus_runtime import set_bus
                from app.shared.messaging.bus_init import set_bus as set_shared_bus

                set_bus(inner_bus)
                set_shared_bus(inner_bus)
                self._rewire_gateway_app_bus(inner_bus)
            except Exception as exc:
                log_warning(f"Could not restore inner bus while stopping mesh: {exc}")

        self._mesh_bus = None
        self._mesh_peer_id = None

        components = (
            ("_mesh_announcer", "stop"),
            ("_mesh_latency_monitor", "stop"),
            ("_mesh_peer_registry", "stop"),
            ("_mesh_peer_bridge", "cancel_all"),
        )
        for attribute, method_name in components:
            component = getattr(self, attribute)
            setattr(self, attribute, None)
            if component is None:
                continue
            try:
                await getattr(component, method_name)()
            except Exception as exc:
                log_warning(f"Could not clean up {attribute.removeprefix('_mesh_')}: {exc}")

        self._mesh_routing_table = None

        if self._rtc_client:
            if inner_bus is not None:
                try:
                    self._rtc_client.set_rpc_bus(inner_bus)
                except Exception as exc:
                    log_warning(f"Could not restore RTC bus while stopping mesh: {exc}")
            try:
                self._rtc_client.set_on_token_saved(None)
            except Exception as exc:
                log_warning(f"Could not clear RTC token callback while stopping mesh: {exc}")
            try:
                self._rtc_client.set_authority_refresh_callback(None)
            except Exception as exc:
                log_warning(f"Could not clear RTC authority callback while stopping mesh: {exc}")
            try:
                self._rtc_client.disable_mesh(policy_provider=self._mesh_policy_provider)
            except Exception as exc:
                log_warning(f"Could not disable RTC mesh runtime while stopping mesh: {exc}")

        log_info("Mesh P2P stopped")

    def _cancel_mesh_policy_retry(self) -> asyncio.Task[None] | None:
        task = self._mesh_policy_retry_task
        self._mesh_policy_retry_task = None
        self._mesh_policy_retry_revision = None
        if task and not task.done():
            task.cancel()
        return task

    def _schedule_mesh_policy_retry(self, revision: int) -> None:
        self._mesh_policy_retry_revision = revision
        task = self._mesh_policy_retry_task
        if task and not task.done():
            return
        self._mesh_policy_retry_task = asyncio.create_task(self._mesh_policy_retry_loop())

    async def _mesh_policy_retry_loop(self) -> None:
        delay = _MESH_START_RETRY_INITIAL_DELAY_S
        try:
            while self._mesh_policy_retry_revision is not None:
                target_revision = self._mesh_policy_retry_revision
                await asyncio.sleep(delay)
                if self._mesh_policy_retry_revision != target_revision:
                    delay = _MESH_START_RETRY_INITIAL_DELAY_S
                    continue
                rtc_client = self._rtc_client
                if rtc_client is None:
                    self._mesh_policy_retry_revision = None
                    return
                try:
                    reannounced = await rtc_client.reannounce_manifest()
                except Exception as exc:
                    log_warning(f"Mesh policy reannounce retry failed: {exc}")
                    delay = min(delay * 2, _MESH_START_RETRY_MAX_DELAY_S)
                    continue
                if not reannounced:
                    log_warning("Mesh policy reannounce retry did not reach every peer")
                    delay = min(delay * 2, _MESH_START_RETRY_MAX_DELAY_S)
                    continue
                if self._mesh_policy_retry_revision == target_revision:
                    self._mesh_policy_retry_revision = None
                    return
                delay = _MESH_START_RETRY_INITIAL_DELAY_S
        except asyncio.CancelledError:
            raise
        finally:
            if self._mesh_policy_retry_task is asyncio.current_task():
                self._mesh_policy_retry_task = None

    async def _reload_mesh_config(self, *, source_revision: int | None = None) -> None:
        """Reload mesh configuration dynamically."""
        try:
            settings = await self._get_gateway_config()
            mesh_config = settings.mesh
            if self._mesh_peer_bridge:
                self._mesh_peer_bridge.set_legacy_event_broadcast(
                    getattr(
                        settings.webrtc,
                        "legacy_event_broadcast",
                        True,
                    )
                )
            previous_snapshot = self._mesh_policy_store.current()
            snapshot = self._mesh_policy_store.replace(
                mesh_config,
                source_revision=source_revision,
            )
            policy_changed = snapshot.revision != previous_snapshot.revision
            live_mesh_config = snapshot.mesh_config

            if live_mesh_config.enabled and not self._mesh_bus:
                log_info("Mesh enabled via config — starting mesh P2P")
                await self._start_mesh()
            elif not live_mesh_config.enabled:
                if self._mesh_bus:
                    log_info("Mesh disabled via config — stopping mesh P2P")
                await self._stop_mesh()
            elif live_mesh_config.enabled and self._mesh_bus:
                if self._rtc_client:
                    self._rtc_client.update_mesh_config(
                        live_mesh_config,
                        policy_provider=self._mesh_policy_provider,
                    )
                    if policy_changed:
                        try:
                            reannounced = await self._rtc_client.reannounce_manifest()
                        except Exception as exc:
                            log_warning(f"Mesh policy reannounce failed after swap: {exc}")
                            self._schedule_mesh_policy_retry(snapshot.revision)
                        else:
                            if reannounced:
                                self._cancel_mesh_policy_retry()
                            else:
                                log_warning("Mesh policy reannounce did not reach every peer")
                                self._schedule_mesh_policy_retry(snapshot.revision)
                if policy_changed:
                    log_info("Mesh config reloaded")
                else:
                    log_debug("Mesh config reload was a policy no-op")

        except Exception as e:
            log_error(f"Error reloading mesh config: {e}")
