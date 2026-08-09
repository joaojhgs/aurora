"""RPC Handler for WebRTC DataChannels.

Handles JSON-RPC calls over DataChannels by forwarding them to the message bus
after validating permissions against the aggregated registry and the peer's
:class:`Identity`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from app.helpers.aurora_logger import log_debug, log_error, log_warning
from app.services.gateway.mesh.tooling_projection_transport import (
    TOOLING_PROJECTION_INVALIDATED_TOPIC,
    bind_invalidation_to_authenticated_provider,
)
from app.services.gateway.orchestrator_runtime_policy import remote_data_movement_denial_reason
from app.services.gateway.webrtc.event_subscriptions import (
    MeshEventSubscriptionRegistry,
    RejectedSubscriptionTopic,
    SubscribeResult,
)
from app.services.gateway.webrtc.peer_protocol import CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1
from app.shared.auth.permissions import check_access
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.gateway import GatewayMethods
from app.shared.contracts.models.orchestrator import (
    OrchestratorInferChatChunk,
    OrchestratorInferChatResponse,
    OrchestratorMethods,
)
from app.shared.contracts.models.scheduler import SchedulerMethods
from app.shared.contracts.models.speech import (
    SpeechMethodConstraints,
    SpeechRouteBinding,
    compute_speech_projection_binding_revision,
)
from app.shared.contracts.models.stt import (
    AudioSessionMethods,
    TranscriptionMethods,
    WakeWordMethods,
)
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.contracts.models.tts import TTSMethods
from app.shared.contracts.speech_routing import compute_speech_route_requirement_digest_for_payload
from app.shared.mesh.tracing import (
    audit_details_hash,
    ensure_correlation_id,
    redacted_copy,
)


class WebRTCFrameParseError(ValueError):
    """Raised when an inbound WebRTC JSON frame violates protocol limits."""


@dataclass(frozen=True, slots=True)
class WebRTCParserLimits:
    max_string_length: int = 256 * 1024
    max_array_length: int = 4096
    max_object_keys: int = 128
    max_depth: int = 16
    max_topic_length: int = 256
    max_topics: int = 64
    max_ttl_seconds: int = 300


DEFAULT_WEBRTC_PARSER_LIMITS = WebRTCParserLimits()
WEBRTC_MAX_FRAME_TEXT_BYTES = DEFAULT_WEBRTC_PARSER_LIMITS.max_string_length
_TYPE_MAX = 64
_ID_MAX = 128
_METHOD_MAX = 256
_TOPIC_RE = re.compile(r"^[A-Za-z0-9_.:/-]+$")
_HEX_64_RE = re.compile(r"^[0-9a-f]{64}$")
_DOWNSTREAM_VALIDATED_TYPES = frozenset(
    {
        "auth",
        "reauth",
        "manifest",
        "manifest_request",
        "ping",
        "pong",
        "mesh_event",
        "protocol_hello",
        "fragment",
        "capacity_update",
        "provider_lease",
        "provider_unavailable",
        "manifest_ack",
    }
)
_PAIRING_V2_TYPES = frozenset(
    {
        "pairing_v2_commit",
        "pairing_v2_reveal",
        "pairing_v2_terminal",
    }
)


def _utf8_byte_length(value: str) -> int:
    return len(value.encode("utf-8"))


def parse_webrtc_json_frame(
    text: str,
    *,
    limits: WebRTCParserLimits = DEFAULT_WEBRTC_PARSER_LIMITS,
) -> dict[str, Any]:
    """Parse one inbound WebRTC JSON frame with SDK-equivalent structural limits."""

    if not isinstance(text, str) or _utf8_byte_length(text) > limits.max_string_length:
        raise WebRTCFrameParseError("frame JSON must be a bounded string")
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError as exc:
        raise WebRTCFrameParseError("frame JSON is invalid") from exc
    return parse_webrtc_frame(decoded, limits=limits)


def parse_webrtc_frame(
    frame: Any,
    *,
    limits: WebRTCParserLimits = DEFAULT_WEBRTC_PARSER_LIMITS,
) -> dict[str, Any]:
    obj = _require_plain_record(frame, "frame")
    _validate_json_tree(obj, limits)
    frame_type = _require_string(obj.get("type"), "type", _TYPE_MAX)
    if frame_type == "call":
        return _parse_call(obj)
    if frame_type == "result":
        out = {"type": frame_type, "id": _require_id(obj.get("id"))}
        if "result" in obj:
            out["result"] = obj["result"]
        return out
    if frame_type == "error":
        error = _require_plain_record(obj.get("error"), "error")
        out = {
            "type": frame_type,
            "id": _require_id(obj.get("id")),
            "error": {
                "code": _require_integer(error.get("code"), "error.code", 0, 9999),
                "message": _require_string(error.get("message"), "error.message", 4096),
            },
        }
        if "correlation_id" in obj:
            out["correlation_id"] = _require_id(obj.get("correlation_id"))
        return out
    if frame_type == "chunk":
        out = {"type": frame_type, "id": _require_id(obj.get("id"))}
        if "data" in obj:
            out["data"] = obj["data"]
        return out
    if frame_type == "eof":
        out = {"type": frame_type, "id": _require_id(obj.get("id"))}
        if "cancelled" in obj:
            out["cancelled"] = _require_bool(obj.get("cancelled"), "cancelled")
        return out
    if frame_type == "cancel":
        return {"type": frame_type, "id": _require_id(obj.get("id"))}
    if frame_type == "event":
        out = {"type": frame_type, "topic": _require_topic(obj.get("topic"), limits)}
        if "params" in obj:
            out["params"] = obj["params"]
        if "correlation_id" in obj:
            out["correlation_id"] = _require_id(obj.get("correlation_id"))
        return out
    if frame_type == "subscribe":
        out = {
            "type": frame_type,
            "id": _require_id(obj.get("id")),
            "topics": _normalize_topics(
                _require_string_array(
                    obj.get("topics"), "topics", limits.max_topics, limits.max_topic_length
                ),
                limits,
            ),
        }
        if "correlation_ids" in obj:
            out["correlation_ids"] = _normalize_ids(
                _require_string_array(
                    obj.get("correlation_ids"),
                    "correlation_ids",
                    limits.max_array_length,
                    _ID_MAX,
                )
            )
        if "ttl_seconds" in obj:
            out["ttl_seconds"] = _require_positive_number(
                obj.get("ttl_seconds"), "ttl_seconds", limits.max_ttl_seconds
            )
        return out
    if frame_type == "subscribed":
        return _parse_subscribed(obj, limits)
    if frame_type == "subscribe_rejected":
        return _parse_subscribe_rejected(obj, limits)
    if frame_type == "unsubscribe":
        return {"type": frame_type, "id": _require_id(obj.get("id"))}
    if frame_type == "unsubscribed":
        return _parse_unsubscribed(obj)
    if frame_type == "mesh_auth_challenge_v1":
        return _parse_mesh_auth_challenge(obj)
    if frame_type == "mesh_auth_proof_v1":
        return _parse_mesh_auth_proof(obj)
    if frame_type in _DOWNSTREAM_VALIDATED_TYPES or frame_type in _PAIRING_V2_TYPES:
        # These authenticated/control frames are immediately parsed by existing
        # specialized handlers before side effects that depend on their fields.
        return obj
    raise WebRTCFrameParseError(f"unsupported frame type: {frame_type}")


def _parse_call(obj: dict[str, Any]) -> dict[str, Any]:
    out = {
        "type": "call",
        "id": _require_id(obj.get("id")),
        "method": _require_string(obj.get("method"), "method", _METHOD_MAX),
    }
    if "params" in obj:
        out["params"] = obj["params"]
    if "correlation_id" in obj:
        out["correlation_id"] = _require_id(obj.get("correlation_id"))
    if "identity" in obj:
        out["identity"] = obj["identity"]
    return out


def _require_plain_record(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WebRTCFrameParseError(f"{field} must be a plain object")
    return value


def _parse_subscribed(obj: dict[str, Any], limits: WebRTCParserLimits) -> dict[str, Any]:
    if "expires_at" in obj:
        raise WebRTCFrameParseError("subscribed uses ttl_seconds, not expires_at")
    return {
        "type": "subscribed",
        "id": _require_id(obj.get("id")),
        "subscription_id": _require_id(obj.get("subscription_id")),
        "accepted": _require_bool(obj.get("accepted"), "accepted"),
        "accepted_topics": _normalize_topics(
            _require_string_array(
                obj.get("accepted_topics"),
                "accepted_topics",
                limits.max_topics,
                limits.max_topic_length,
            ),
            limits,
        ),
        "rejected_topics": _parse_rejected_topics(obj.get("rejected_topics"), limits),
        "correlation_ids": _normalize_ids(
            _require_string_array(
                obj.get("correlation_ids"),
                "correlation_ids",
                limits.max_array_length,
                _ID_MAX,
            )
        ),
        "ttl_seconds": _require_positive_number(
            obj.get("ttl_seconds"), "ttl_seconds", limits.max_ttl_seconds
        ),
        "reason": None
        if obj.get("reason") is None
        else _require_string(obj.get("reason"), "reason", 4096),
        "idempotent": _require_bool(obj.get("idempotent"), "idempotent"),
    }


def _parse_subscribe_rejected(obj: dict[str, Any], limits: WebRTCParserLimits) -> dict[str, Any]:
    out: dict[str, Any] = {
        "type": "subscribe_rejected",
        "id": _require_id(obj.get("id")),
        "reason": _require_string(obj.get("reason"), "reason", 4096),
    }
    if "rejected_topics" in obj:
        out["rejected_topics"] = _normalize_topics(
            _require_string_array(
                obj.get("rejected_topics"),
                "rejected_topics",
                limits.max_topics,
                limits.max_topic_length,
            ),
            limits,
        )
    return out


def _parse_unsubscribed(obj: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "unsubscribed", "id": _require_id(obj.get("id"))}
    if "subscription_id" in obj:
        out["subscription_id"] = _require_id(obj.get("subscription_id"))
    if "removed" in obj:
        out["removed"] = _require_bool(obj.get("removed"), "removed")
    return out


def _parse_mesh_auth_challenge(obj: dict[str, Any]) -> dict[str, Any]:
    if "token_id" in obj:
        raise WebRTCFrameParseError("mesh_auth_challenge_v1 must not include token_id")
    if "proof" in obj or "proof_hmac_sha256" in obj:
        raise WebRTCFrameParseError("mesh_auth_challenge_v1 must not include proof")
    return _parse_mesh_auth_bindings(obj, "mesh_auth_challenge_v1")


def _parse_mesh_auth_proof(obj: dict[str, Any]) -> dict[str, Any]:
    if "proof_hmac_sha256" in obj:
        raise WebRTCFrameParseError("mesh_auth_proof_v1 uses proof, not proof_hmac_sha256")
    out = _parse_mesh_auth_bindings(obj, "mesh_auth_proof_v1")
    out["token_id"] = _require_string(obj.get("token_id"), "token_id", _ID_MAX)
    out["proof"] = _require_hex64(obj.get("proof"), "proof")
    return out


def _parse_mesh_auth_bindings(obj: dict[str, Any], frame_type: str) -> dict[str, Any]:
    return {
        "type": frame_type,
        "challenge": _require_hex64(obj.get("challenge"), "challenge"),
        "channel_binding": _require_hex64(obj.get("channel_binding"), "channel_binding"),
        "claimant_peer_id": _require_id(obj.get("claimant_peer_id")),
        "verifier_peer_id": _require_id(obj.get("verifier_peer_id")),
        "claimant_signaling_peer_id": _require_id(obj.get("claimant_signaling_peer_id")),
        "verifier_signaling_peer_id": _require_id(obj.get("verifier_signaling_peer_id")),
        "room_name": _require_string(obj.get("room_name"), "room_name", _ID_MAX),
    }


def _parse_rejected_topics(value: Any, limits: WebRTCParserLimits) -> list[str | dict[str, str]]:
    if not isinstance(value, list) or len(value) > limits.max_topics:
        raise WebRTCFrameParseError("rejected_topics must be a bounded array")
    out: list[str | dict[str, str]] = []
    for item in value:
        if isinstance(item, str):
            out.append(_require_topic(item, limits))
            continue
        topic_obj = _require_plain_record(item, "rejected_topic")
        parsed: dict[str, str] = {"topic": _require_topic(topic_obj.get("topic"), limits)}
        if "reason" in topic_obj:
            parsed["reason"] = _require_string(topic_obj.get("reason"), "reason", 4096)
        out.append(parsed)
    return out


def _validate_json_tree(value: Any, limits: WebRTCParserLimits, depth: int = 0) -> None:
    if depth > limits.max_depth:
        raise WebRTCFrameParseError("frame exceeds maximum nesting depth")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int | float):
        if not math.isfinite(float(value)):
            raise WebRTCFrameParseError("frame contains non-finite number")
        return
    if isinstance(value, str):
        if _utf8_byte_length(value) > limits.max_string_length:
            raise WebRTCFrameParseError("frame contains oversized string")
        return
    if isinstance(value, list):
        if len(value) > limits.max_array_length:
            raise WebRTCFrameParseError("frame contains oversized array")
        for item in value:
            _validate_json_tree(item, limits, depth + 1)
        return
    obj = _require_plain_record(value, "frame")
    if len(obj) > limits.max_object_keys:
        raise WebRTCFrameParseError("frame contains too many fields")
    for item in obj.values():
        _validate_json_tree(item, limits, depth + 1)


def _require_string(value: Any, field: str, max_length: int) -> str:
    if not isinstance(value, str) or not value or _utf8_byte_length(value) > max_length:
        raise WebRTCFrameParseError(f"{field} must be a bounded string")
    return value


def _require_id(value: Any) -> str:
    return _require_string(value, "id", _ID_MAX)


def _require_bool(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise WebRTCFrameParseError(f"{field} must be boolean")
    return value


def _require_integer(value: Any, field: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        raise WebRTCFrameParseError(f"{field} must be a bounded integer")
    return value


def _require_positive_number(value: Any, field: str, maximum: int) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise WebRTCFrameParseError(f"{field} must be a positive finite number")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0 or parsed > maximum:
        raise WebRTCFrameParseError(f"{field} must be a positive finite number")
    return parsed


def _require_string_array(value: Any, field: str, max_count: int, max_length: int) -> list[str]:
    if not isinstance(value, list) or len(value) > max_count:
        raise WebRTCFrameParseError(f"{field} must be a bounded array")
    return [_require_string(item, field, max_length) for item in value]


def _normalize_ids(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        parsed = _require_id(value)
        if parsed not in seen:
            seen.add(parsed)
            out.append(parsed)
    return out


def _normalize_topics(topics: list[str], limits: WebRTCParserLimits) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for topic in topics:
        parsed = _require_topic(topic, limits)
        if parsed not in seen:
            seen.add(parsed)
            out.append(parsed)
    if not out:
        raise WebRTCFrameParseError("topics must be non-empty")
    return out


def _require_topic(value: Any, limits: WebRTCParserLimits) -> str:
    topic = _require_string(value, "topic", limits.max_topic_length)
    if not _TOPIC_RE.fullmatch(topic) or "*" in topic or "+" in topic:
        raise WebRTCFrameParseError("topic must be an exact typed topic")
    return topic


def _require_hex64(value: Any, field: str) -> str:
    parsed = _require_string(value, field, 64)
    if not _HEX_64_RE.fullmatch(parsed):
        raise WebRTCFrameParseError(f"{field} must be lowercase sha256 hex")
    return parsed


def _json_default(obj: object) -> str:
    """Fallback serializer for :func:`json.dumps`.

    Handles ``datetime`` objects (→ ISO-8601 string) so that RPC responses
    containing raw dicts with date/time values don't crash the channel.
    """
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def _is_streaming_transport_unavailable(exc: Exception) -> bool:
    message = str(exc)
    return (
        "does not support native stream_request" in message
        or "Streaming RPC transport unavailable" in message
    )


if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
    from app.services.gateway.acl.identity import Identity
    from app.services.gateway.mesh.provider_export import ProjectionResult
    from app.services.gateway.registry_aggregator import RegistryAggregator
    from app.shared.contracts.models.gateway import MethodInfo

    from .rtc_client import RTCClient


class RPCHandler:
    _UNTRUSTED_TOOLING_PROVIDER_AUTHORITY_FIELDS = frozenset(
        {
            "granted_permissions",
            "provider_granted_permissions",
            "provider_permissions",
            "provider_available",
            "provider_authorized",
        }
    )
    # RPC methods that ANONYMOUS peers may call (pairing + login flow)
    _ANON_ALLOWED_METHODS = {
        AuthMethods.PAIRING_START,
        AuthMethods.PAIRING_CONNECT,
        AuthMethods.PAIRING_EXCHANGE,
        AuthMethods.LOGIN,
    }
    # A thin client needs a small, redacted control-plane view before it can
    # choose any ordinary shared-service route. Gateway itself is not an
    # operator-configurable mesh provider, so these authenticated read methods
    # deliberately bypass service export/projection checks while retaining
    # normal contract exposure and RBAC enforcement.
    _AUTHENTICATED_BOOTSTRAP_METHODS = {
        AuthMethods.WHO_AM_I,
        AuthMethods.MESH_LIST_PEERS,
        AuthMethods.MESH_GET_PEER,
        AuthMethods.LIST_PENDING_PAIRINGS,
        GatewayMethods.GET_REGISTRY,
        GatewayMethods.GET_SERVICES,
        GatewayMethods.GET_SERVICE_HEALTH,
        GatewayMethods.GET_DEPLOYMENT_TOPOLOGY,
        GatewayMethods.GET_MESH_STATUS,
        GatewayMethods.GET_WEBRTC_DIAGNOSTICS,
        GatewayMethods.GET_CAPABILITY_GRAPH,
        GatewayMethods.GET_CAPABILITY_CATALOG,
        GatewayMethods.EXPLAIN_ROUTE,
    }
    # Pairing infrastructure is intentionally reachable by its full
    # service-qualified RPC name even when the service contract is
    # internal-only. Authenticated bootstrap reads are separate: they bypass
    # mesh export projection only and still require external/both exposure.
    _INFRASTRUCTURE_RPC_METHODS = _ANON_ALLOWED_METHODS
    _PROJECTION_BYPASS_METHODS = _INFRASTRUCTURE_RPC_METHODS | _AUTHENTICATED_BOOTSTRAP_METHODS
    # G013 intentionally has no legacy full-catalog event fallback.  The sole
    # Tooling event crossing RTC is metadata-only and targeted by PeerBridge.
    _SAFE_FORWARDED_EVENT_TOPICS = {TOOLING_PROJECTION_INVALIDATED_TOPIC}
    _ASSISTANT_SCOPED_EVENT_TOPICS = {
        OrchestratorMethods.RESPONSE,
        TTSMethods.AUDIO_CHUNK,
    }

    def __init__(
        self,
        bus: MessageBus,
        registry: RegistryAggregator,
        send_fn: Callable[[str], None],
        acl_provider: Callable[[], Identity],
        audit_fn: Callable[..., Any] | None = None,
        mesh_config: Any | None = None,
        peer_id: str | None = None,
        stable_peer_id_provider: Callable[[], str | None] | None = None,
        capacity_notify_fn: Callable[[str, int, int], None] | None = None,
        pairing_notify_fn: Callable[[str], None] | None = None,
        pairing_denied_fn: Callable[[str], None] | None = None,
        pairing_context_provider: Callable[[], dict[str, str] | None] | None = None,
        policy_provider: Callable[[], Any] | None = None,
        active_projection_provider: Callable[[], ProjectionResult | None] | None = None,
        authenticated_peer_validator: Callable[[], bool] | None = None,
        tooling_authority_revision_provider: Callable[[], tuple[int, int] | None] | None = None,
        event_subscription_registry: MeshEventSubscriptionRegistry | None = None,
        peer_supports_capability: Callable[[str], bool] | None = None,
        local_peer_role_provider: Callable[[], str] | None = None,
        event_topic_authorizer: Callable[[str, str, Identity], bool | Any] | None = None,
        provider_readiness_provider: Callable[[str], bool] | None = None,
        provider_binding_state_provider: Callable[[], tuple[Any, int] | None] | None = None,
    ):
        self._bus = bus
        self._registry = registry
        self._send = send_fn
        self._acl_provider = acl_provider
        self._audit_fn = audit_fn
        self._mesh_config = mesh_config
        self._peer_id = peer_id
        self._stable_peer_id_provider = stable_peer_id_provider
        self._capacity_notify_fn = capacity_notify_fn
        self._pairing_notify_fn = pairing_notify_fn
        self._pairing_denied_fn = pairing_denied_fn
        self._pairing_context_provider = pairing_context_provider
        self._policy_provider = policy_provider
        self._active_projection_provider = active_projection_provider
        self._authenticated_peer_validator = authenticated_peer_validator
        self._tooling_authority_revision_provider = tooling_authority_revision_provider
        self._event_subscription_registry = event_subscription_registry
        self._peer_supports_capability = peer_supports_capability
        self._local_peer_role_provider = local_peer_role_provider
        self._event_topic_authorizer = event_topic_authorizer
        self._provider_readiness_provider = provider_readiness_provider
        self._provider_binding_state_provider = provider_binding_state_provider
        # Track active remote calls per module for capacity limiting
        self._active_remote_calls: dict[str, int] = {}
        self._active_rpc_tasks: dict[str, asyncio.Task[Any]] = {}

    def set_bus(self, bus: MessageBus) -> None:
        """Update the bus used for inbound RPC dispatch.

        Gateway starts WebRTC before mesh in process mode, so handlers may be
        constructed while ``self._bus`` is still the raw process bus. Once the
        Gateway-owned MeshBus exists, callers update handlers through this
        method so streaming RPCs use MeshBus.stream_request instead of falling
        through to process-bus serialization.
        """
        self._bus = bus

    def set_mesh_policy_provider(self, policy_provider: Callable[[], Any] | None) -> None:
        """Update the live mesh policy provider used by future RPC calls."""

        self._policy_provider = policy_provider

    def _current_mesh_config(self) -> Any | None:
        if self._policy_provider is not None:
            return self._policy_provider().mesh_config
        return self._mesh_config

    def _is_mesh_transport_context(self) -> bool:
        return self._mesh_config is not None or self._policy_provider is not None

    async def _enforce_forwarded_service_event_policy(
        self,
        topic: str,
        params: dict[str, Any],
        mesh_config: Any | None,
    ) -> bool:
        """Return True when a forwarded service event may be published locally."""

        if topic not in self._SAFE_FORWARDED_EVENT_TOPICS:
            await self._audit_rpc_event(
                "access.denied.event",
                method_name=topic,
                correlation_id=str(params.get("correlation_id") or ""),
                status="denied",
                reason="method_not_shared",
                details={"topic": topic, "params": params},
            )
            return False
        if mesh_config is None:
            if self._is_mesh_transport_context():
                await self._audit_rpc_event(
                    "access.denied.event",
                    method_name=topic,
                    correlation_id=str(params.get("correlation_id") or ""),
                    status="denied",
                    reason="authority_unknown",
                    details={"topic": topic, "params": params},
                )
                return False
            return True
        if not mesh_config.enabled:
            await self._audit_rpc_event(
                "access.denied.event",
                method_name=topic,
                correlation_id=str(params.get("correlation_id") or ""),
                status="denied",
                reason="mesh_disabled",
                details={"params": params},
            )
            return False

        module_name = topic.split(".", 1)[0]
        sharing = mesh_config.services.get(module_name)
        if not sharing or not sharing.export.share:
            await self._audit_rpc_event(
                "access.denied.event",
                method_name=topic,
                correlation_id=str(params.get("correlation_id") or ""),
                status="denied",
                reason="service_not_shared",
                details={"module": module_name, "params": params},
            )
            return False

        return True

    async def _handle_cancel(self, msg: dict[str, Any]) -> None:
        req_id = msg.get("id")
        if not req_id:
            return
        task = self._active_rpc_tasks.get(str(req_id))
        if task is not None and not task.done():
            task.cancel()

    def cancel_active_work(self, request_id: str | None = None) -> None:
        """Cancel retained inbound RPC work, optionally scoped to one request."""

        if request_id is None:
            tasks = list(self._active_rpc_tasks.values())
        else:
            task = self._active_rpc_tasks.get(str(request_id))
            tasks = [task] if task is not None else []
        current = asyncio.current_task()
        for task in tasks:
            if task is not None and task is not current and not task.done():
                task.cancel()

    async def on_message(self, text: str) -> None:
        try:
            msg = parse_webrtc_json_frame(text)
        except WebRTCFrameParseError as exc:
            log_error(f"RPCHandler: Received invalid WebRTC frame: {exc}")
            return
        await self.on_parsed_message(msg)

    async def on_parsed_message(self, msg: dict[str, Any]) -> None:
        """Dispatch an already parsed and validated WebRTC frame."""

        msg_type = msg.get("type")
        if msg_type == "call":
            req_id = str(msg.get("id") or "")
            existing_task = self._active_rpc_tasks.get(req_id) if req_id else None
            if existing_task is not None:
                if not existing_task.done():
                    self._send_error(
                        req_id,
                        409,
                        "Duplicate active request id",
                        correlation_id=str(msg.get("correlation_id") or req_id),
                    )
                    return
                self._active_rpc_tasks.pop(req_id, None)
            task = asyncio.create_task(self._handle_call(msg))
            if req_id:
                self._active_rpc_tasks[req_id] = task
            try:
                await task
            except asyncio.CancelledError:
                if not task.done():
                    task.cancel()
                raise
            finally:
                if req_id and self._active_rpc_tasks.get(req_id) is task:
                    self._active_rpc_tasks.pop(req_id, None)
        elif msg_type == "cancel":
            await self._handle_cancel(msg)
        elif msg_type == "event":
            await self._handle_event(msg)
        elif msg_type == "subscribe":
            await self._handle_subscribe(msg)
        elif msg_type == "unsubscribe":
            await self._handle_unsubscribe(msg)
        else:
            log_debug(f"RPCHandler: Ignoring message type: {msg_type}")

    def _normalize_forwarded_tooling_catalog_event(
        self, topic: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        """Bind forwarded Tooling catalog events to the authenticated source peer.

        Providers announce their local catalog with local sentinel ids. Once the
        event crosses the mesh boundary, the receiver must key the snapshot by
        the authenticated remote peer instead of trusting the payload's claimed
        provider identity.
        """

        if topic != TOOLING_PROJECTION_INVALIDATED_TOPIC or not isinstance(params, dict):
            return params

        source_peer_id = (
            self._stable_authenticated_peer_id()
            or self._authenticated_peer_id()
            or str(params.get("peer_id") or "unknown-peer")
        )
        return bind_invalidation_to_authenticated_provider(
            params,
            stable_peer_id=source_peer_id,
        )

    def _authenticated_peer_id(self) -> str | None:
        """Return peer attribution, preferring the durable authenticated identity."""

        if self._stable_peer_id_provider is not None:
            try:
                stable_peer_id = self._stable_peer_id_provider()
            except Exception as error:
                log_warning(f"RPCHandler: Failed to resolve stable peer identity: {error}")
            else:
                if stable_peer_id:
                    return stable_peer_id
        return self._peer_id

    def _stable_authenticated_peer_id(self) -> str | None:
        """Return only the durable authenticated peer identity used for policy."""

        if self._stable_peer_id_provider is None:
            return None
        try:
            stable_peer_id = self._stable_peer_id_provider()
        except Exception as error:
            log_warning(f"RPCHandler: Failed to resolve stable peer identity: {error}")
            return None
        return stable_peer_id or None

    def _supports_scoped_event_subscriptions(self) -> bool:
        """Return whether this authenticated DataChannel negotiated scoped events."""

        if self._peer_supports_capability is None:
            return False
        try:
            return bool(self._peer_supports_capability(CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1))
        except Exception as error:
            log_warning(f"RPCHandler: Failed to check scoped event capability: {error}")
            return False

    def _local_peer_role(self) -> str:
        if self._local_peer_role_provider is None:
            return "hybrid"
        try:
            role = self._local_peer_role_provider()
        except Exception as error:
            log_warning(f"RPCHandler: Failed to resolve local peer role: {error}")
            return "hybrid"
        return role if role in {"provider", "consumer", "hybrid"} else "hybrid"

    def _local_provider_ready(self, service_id: str) -> bool:
        if self._provider_readiness_provider is None:
            return True
        try:
            return bool(self._provider_readiness_provider(service_id))
        except Exception as error:
            log_warning(f"RPCHandler: Failed to resolve provider readiness: {error}")
            return False

    def _local_provider_binding_state(self) -> tuple[Any, int] | None:
        if self._provider_binding_state_provider is None:
            return None
        try:
            return self._provider_binding_state_provider()
        except Exception as error:
            log_warning(f"RPCHandler: Failed to resolve provider binding state: {error}")
            return None

    async def _authorized_event_topics(
        self, requested_topics: tuple[str, ...], identity: Identity
    ) -> set[str]:
        """Return exact requested event topics authorized for this peer.

        The default path intentionally fails closed unless the aggregated typed
        registry exposes the exact topic and current mesh export policy shares
        that module. Tests and later policy layers may inject a stricter
        authorizer; requested peer IDs are never trusted.
        """

        allowed: set[str] = set()
        for topic in requested_topics:
            if self._event_topic_authorizer is not None:
                verdict = self._event_topic_authorizer(
                    self._stable_authenticated_peer_id() or "", topic, identity
                )
                if hasattr(verdict, "__await__"):
                    verdict = await verdict
                if verdict and self._local_provider_ready(topic.split(".")[0]):
                    allowed.add(topic)
                continue

            if topic in self._ASSISTANT_SCOPED_EVENT_TOPICS:
                stable_peer_id = self._stable_authenticated_peer_id()
                if (
                    not stable_peer_id
                    or identity.principal_id == "anonymous"
                    or getattr(identity, "source", None) != "webrtc_peer"
                    or (
                        self._authenticated_peer_validator is not None
                        and not self._authenticated_peer_validator()
                    )
                ):
                    continue
                if not check_access(
                    set(identity.effective_perms),
                    ["Orchestrator.use"],
                    method_type="use",
                ):
                    continue
                mesh_config = self._current_mesh_config()
                if mesh_config is None or not getattr(mesh_config, "enabled", False):
                    continue
                svc_name = topic.split(".")[0]
                sharing = getattr(mesh_config, "services", {}).get(svc_name)
                if not sharing or not getattr(getattr(sharing, "export", None), "share", False):
                    continue
                if not self._local_provider_ready(svc_name):
                    continue
                allowed.add(topic)
                continue

            result = await self._find_method(topic)
            if not result:
                continue
            svc_name, meta = result
            if getattr(meta, "exposure", "internal") not in {"external", "both"}:
                continue
            perms_needed = list(getattr(meta, "required_perms", None) or [])
            if perms_needed and not check_access(
                set(identity.effective_perms),
                perms_needed,
                method_type=getattr(meta, "method_type", "use"),
            ):
                continue
            mesh_config = self._current_mesh_config()
            if mesh_config is None:
                if self._is_mesh_transport_context():
                    continue
                allowed.add(topic)
                continue
            if not getattr(mesh_config, "enabled", False):
                continue
            sharing = getattr(mesh_config, "services", {}).get(svc_name)
            if not sharing or not getattr(getattr(sharing, "export", None), "share", False):
                continue
            if not self._local_provider_ready(svc_name):
                continue
            allowed.add(topic)
        return allowed

    @staticmethod
    def _subscription_rejections_to_wire(
        rejected: tuple[RejectedSubscriptionTopic, ...],
    ) -> list[dict[str, str]]:
        return [{"topic": item.topic, "reason": item.reason} for item in rejected]

    def _send_subscribe_ack(self, req_id: Any, result: SubscribeResult) -> None:
        self._send(
            json.dumps(
                {
                    "type": "subscribed" if result.accepted else "subscribe_rejected",
                    "id": req_id,
                    "subscription_id": result.subscription_id,
                    "accepted": result.accepted,
                    "accepted_topics": list(result.accepted_topics),
                    "rejected_topics": self._subscription_rejections_to_wire(
                        result.rejected_topics
                    ),
                    "correlation_ids": list(result.correlation_ids),
                    "ttl_seconds": (
                        round(result.ttl_seconds, 3) if result.ttl_seconds is not None else None
                    ),
                    "reason": result.reason,
                    "idempotent": result.idempotent,
                },
                default=_json_default,
            )
        )

    async def _handle_subscribe(self, msg: dict[str, Any]) -> None:
        req_id = msg.get("id")
        if self._event_subscription_registry is None:
            self._send_error(req_id, 501, "Scoped event subscriptions unavailable")
            return
        if not self._supports_scoped_event_subscriptions():
            self._send_error(req_id, 426, "Scoped event subscriptions not negotiated")
            return
        identity: Identity = self._acl_provider()
        stable_peer_id = self._stable_authenticated_peer_id()
        if (
            not stable_peer_id
            or identity.principal_id == "anonymous"
            or getattr(identity, "source", None) != "webrtc_peer"
            or (
                self._authenticated_peer_validator is not None
                and not self._authenticated_peer_validator()
            )
        ):
            self._send_error(req_id, 401, "Authentication required")
            return
        params = msg.get("params") if isinstance(msg.get("params"), dict) else msg
        subscription_id = str(params.get("subscription_id") or req_id or "")
        topics_value = params.get("topics") or params.get("requested_topics") or []
        if not isinstance(topics_value, list | tuple):
            topics_value = []
        requested_topics = tuple(str(topic) for topic in topics_value)
        correlation_value = params.get("correlation_ids") or []
        if not isinstance(correlation_value, list | tuple):
            correlation_value = []
        correlation_ids = tuple(str(value) for value in correlation_value)
        allowed_topics = await self._authorized_event_topics(requested_topics, identity)
        result = self._event_subscription_registry.subscribe(
            peer_id=stable_peer_id,
            subscription_id=subscription_id,
            requested_topics=requested_topics,
            allowed_topics=allowed_topics,
            correlation_ids=correlation_ids,
            ttl_seconds=params.get("ttl_seconds"),
        )
        self._send_subscribe_ack(req_id, result)

    async def _handle_unsubscribe(self, msg: dict[str, Any]) -> None:
        req_id = msg.get("id")
        if self._event_subscription_registry is None:
            self._send_error(req_id, 501, "Scoped event subscriptions unavailable")
            return
        if not self._supports_scoped_event_subscriptions():
            self._send_error(req_id, 426, "Scoped event subscriptions not negotiated")
            return
        identity: Identity = self._acl_provider()
        stable_peer_id = self._stable_authenticated_peer_id()
        if (
            not stable_peer_id
            or identity.principal_id == "anonymous"
            or getattr(identity, "source", None) != "webrtc_peer"
        ):
            self._send_error(req_id, 401, "Authentication required")
            return
        params = msg.get("params") if isinstance(msg.get("params"), dict) else msg
        subscription_id = str(params.get("subscription_id") or req_id or "")
        result = self._event_subscription_registry.unsubscribe(
            peer_id=stable_peer_id, subscription_id=subscription_id
        )
        self._send(
            json.dumps(
                {
                    "type": "unsubscribed",
                    "id": req_id,
                    "subscription_id": result.subscription_id,
                    "removed": result.removed,
                }
            )
        )

    async def _handle_event(self, msg: dict[str, Any]) -> None:
        """Handle a forwarded event from a remote peer.

        Publishes the event on the local bus so local services react
        to remote lifecycle events (e.g., TTS.Started from a remote TTS).
        Events are fire-and-forget — no response is sent back.

        We attempt to reconstruct the original Pydantic model so that
        subscribers receive a typed payload instead of a raw dict.
        """
        topic = msg.get("topic")
        params = msg.get("params") or {}
        correlation_id = msg.get("correlation_id")

        if not topic:
            log_debug("RPCHandler: Received event with no topic")
            return
        operation_mesh_config = self._current_mesh_config()

        # Gap 2B: Block events from ANONYMOUS peers
        identity: Identity = self._acl_provider()
        if identity.principal_id == "anonymous":
            log_warning(f"RPCHandler: Blocked event {topic} from ANONYMOUS peer")
            return
        if topic == TOOLING_PROJECTION_INVALIDATED_TOPIC and (
            not self._stable_authenticated_peer_id()
            or (
                self._authenticated_peer_validator is not None
                and not self._authenticated_peer_validator()
            )
        ):
            log_warning("RPCHandler: Blocked Tooling invalidation without stable RTC authority")
            return

        if not await self._enforce_forwarded_service_event_policy(
            topic,
            params if isinstance(params, dict) else {},
            operation_mesh_config,
        ):
            log_warning(f"RPCHandler: Blocked forwarded event {topic} by mesh policy")
            return

        log_debug(
            f"RPCHandler: Received forwarded event {topic} correlation_id={correlation_id or 'n/a'}"
        )
        try:
            if isinstance(params, dict):
                params = self._normalize_forwarded_tooling_catalog_event(topic, params)
            payload: Any = params
            if isinstance(params, dict) and self._registry:
                payload = await self._reconstruct_event_model(topic, params)

            await self._bus.publish(
                topic,
                payload,
                event=True,
                origin="mesh_forwarded",
                principal_id=identity.principal_id,
                identity_source="mesh_peer",
                caller_peer_id=self._authenticated_peer_id(),
                correlation_id=correlation_id,
            )
        except Exception as e:
            log_error(f"RPCHandler: Error publishing forwarded event {topic}: {e}")

    async def _reconstruct_event_model(self, topic: str, params: dict) -> Any:
        """Try to reconstruct a Pydantic model from a forwarded event dict.

        The registry stores ``input_model`` as a *string* name (e.g.
        ``"TTSStarted"``), not an actual Python class.  Since we cannot
        resolve the class from a bare name without an import registry, we
        simply pass the raw dict through. The local bus and subscribers
        already handle dict payloads gracefully.
        """
        return params

    async def _handle_call(self, msg: dict[str, Any]) -> None:
        method_name = msg.get("method")
        params = msg.get("params") or {}
        identity_meta = msg.get("identity") if isinstance(msg.get("identity"), dict) else {}
        speech_route_binding = self._parse_speech_route_binding(identity_meta)
        if isinstance(params, dict):
            params = dict(params)
            params.pop("speech_route_binding", None)
            params.pop("route_binding", None)
        req_id = msg.get("id")
        correlation_id = ensure_correlation_id(
            params,
            msg.get("correlation_id") or (str(req_id) if req_id is not None else None),
        )

        if not method_name:
            self._send_error(req_id, 400, "Missing method", correlation_id=correlation_id)
            return

        canonical_method = method_name

        # Mesh-v2 pairing metadata is derived locally from the exact WebRTC
        # commit/reveal transcript. Never let an anonymous caller choose or
        # replace the verification value that the local UI will display.
        if canonical_method == AuthMethods.PAIRING_START:
            pairing_context = (
                self._pairing_context_provider()
                if self._pairing_context_provider is not None
                else None
            )
            if not pairing_context:
                self._send_error(
                    req_id,
                    409,
                    "Pairing verification handshake is not ready",
                    correlation_id=correlation_id,
                )
                return
            if not isinstance(params, dict):
                self._send_error(
                    req_id,
                    400,
                    "Invalid pairing request",
                    correlation_id=correlation_id,
                )
                return
            for field in (
                "pairing_session_id",
                "verification_code",
                "device_name",
                "remote_peer_id",
                "remote_node_name",
                "room_name",
            ):
                claimed = str(params.get(field) or "")
                expected = str(pairing_context.get(field) or "")
                if not expected:
                    self._send_error(
                        req_id,
                        409,
                        "Pairing verification context is incomplete",
                        correlation_id=correlation_id,
                    )
                    return
                if claimed and not secrets.compare_digest(claimed, expected):
                    self._send_error(
                        req_id,
                        409,
                        "Pairing transcript mismatch",
                        correlation_id=correlation_id,
                    )
                    return
            params = {**params, **pairing_context}

        bypasses_mesh_projection = canonical_method in self._PROJECTION_BYPASS_METHODS
        operation_mesh_config = self._current_mesh_config()

        if "/" in method_name:
            self._send_error(req_id, 404, "Method not found", correlation_id=correlation_id)
            return

        result = await self._find_method(canonical_method)
        if not result:
            self._send_error(req_id, 404, "Method not found", correlation_id=correlation_id)
            return

        svc_name, meta = result

        # Permission check via Identity
        perms_needed = meta.required_perms or []
        identity: Identity = self._acl_provider()

        if (
            identity.principal_id == "anonymous"
            and canonical_method not in self._ANON_ALLOWED_METHODS
        ):
            log_warning(f"RPCHandler: Blocked call to {method_name} from ANONYMOUS peer")
            await self._audit_rpc_event(
                "access.denied.rpc",
                method_name=method_name,
                correlation_id=correlation_id,
                status="denied",
                reason="authentication_required",
                principal_id=identity.principal_id,
                details={"params": params},
            )
            self._send_error(
                req_id,
                401,
                "Authentication required",
                correlation_id=correlation_id,
            )
            return

        if (
            self._local_peer_role() == "consumer"
            and canonical_method not in self._ANON_ALLOWED_METHODS
        ):
            await self._deny_rpc(
                req_id,
                method_name,
                correlation_id,
                "consumer_only_peer",
                405,
                "Local peer is consumer-only",
                params=params,
                principal_id=identity.principal_id,
            )
            return

        active_projection = None
        projected_service = None
        projected_method = None
        max_concurrent = 0
        if not bypasses_mesh_projection and (
            operation_mesh_config is not None or self._is_mesh_transport_context()
        ):
            if operation_mesh_config is None:
                await self._deny_rpc(
                    req_id,
                    method_name,
                    correlation_id,
                    "authority_unknown",
                    403,
                    "Authority is not available",
                    params=params,
                    principal_id=identity.principal_id,
                )
                return
            if not operation_mesh_config.enabled:
                await self._deny_rpc(
                    req_id,
                    method_name,
                    correlation_id,
                    "mesh_disabled",
                    403,
                    "Mesh policy is disabled",
                    params=params,
                    principal_id=identity.principal_id,
                )
                return
            if self._active_projection_provider is None:
                await self._deny_rpc(
                    req_id,
                    method_name,
                    correlation_id,
                    "authority_unknown",
                    403,
                    "Authority is not available",
                    params=params,
                    principal_id=identity.principal_id,
                )
                return
            else:
                stable_peer_id = self._stable_authenticated_peer_id()
                if (
                    not stable_peer_id
                    or identity.principal_id == "anonymous"
                    or getattr(identity, "source", None) != "webrtc_peer"
                    or (
                        self._authenticated_peer_validator is not None
                        and not self._authenticated_peer_validator()
                    )
                ):
                    await self._deny_rpc(
                        req_id,
                        method_name,
                        correlation_id,
                        "authentication_required",
                        401,
                        "Authentication required",
                        params=params,
                        principal_id=identity.principal_id,
                    )
                    return
                active_projection = self._active_projection_provider()
                authority_reason = self._projection_denial_reason(active_projection)
                if authority_reason is not None:
                    await self._deny_rpc(
                        req_id,
                        method_name,
                        correlation_id,
                        authority_reason,
                        403,
                        "Authority is not available",
                        params=params,
                        principal_id=identity.principal_id,
                    )
                    return
                if active_projection.cache_key.recipient_peer_id != stable_peer_id:
                    await self._deny_rpc(
                        req_id,
                        method_name,
                        correlation_id,
                        "authority_unknown",
                        403,
                        "Authority is not available",
                        params=params,
                        principal_id=identity.principal_id,
                    )
                    return
                sharing = operation_mesh_config.services.get(svc_name)
                if not sharing or not sharing.export.share:
                    await self._deny_rpc(
                        req_id,
                        method_name,
                        correlation_id,
                        "service_not_shared",
                        403,
                        f"Service {svc_name} is not shared",
                        params=params,
                        principal_id=identity.principal_id,
                    )
                    return
                projected_service = next(
                    (
                        service
                        for service in active_projection.services
                        if service.service_id == svc_name
                    ),
                    None,
                )
                if projected_service is None:
                    reason = (
                        "method_not_shared"
                        if sharing is not None and sharing.export.share
                        else "service_not_shared"
                    )
                    await self._deny_rpc(
                        req_id,
                        method_name,
                        correlation_id,
                        reason,
                        403,
                        "Service or method is not shared",
                        params=params,
                        principal_id=identity.principal_id,
                    )
                    return
                topic_for_projection = meta.bus_topic or f"{svc_name}.{meta.name}"
                if topic_for_projection != canonical_method:
                    await self._deny_rpc(
                        req_id,
                        method_name,
                        correlation_id,
                        "method_not_shared",
                        403,
                        "Method is not shared",
                        params=params,
                        principal_id=identity.principal_id,
                    )
                    return
                projected_method = next(
                    (
                        method
                        for method in projected_service.methods
                        if method.topic == topic_for_projection
                    ),
                    None,
                )
                if projected_method is None:
                    await self._deny_rpc(
                        req_id,
                        method_name,
                        correlation_id,
                        "method_not_shared",
                        403,
                        "Method is not shared",
                        params=params,
                        principal_id=identity.principal_id,
                    )
                    return
                if not self._local_provider_ready(svc_name):
                    await self._deny_rpc(
                        req_id,
                        method_name,
                        correlation_id,
                        "provider_not_ready",
                        425,
                        "Provider is not ready",
                        params=params,
                        principal_id=identity.principal_id,
                    )
                    return

        if (
            getattr(meta, "exposure", "internal") not in {"external", "both"}
            and canonical_method not in self._INFRASTRUCTURE_RPC_METHODS
        ):
            log_warning(
                f"RPCHandler: Blocked non-external RPC call to {method_name} "
                f"from {identity.principal_name}"
            )
            await self._audit_rpc_event(
                "access.denied.rpc",
                method_name=method_name,
                correlation_id=correlation_id,
                status="denied",
                reason="method_not_exposed",
                principal_id=identity.principal_id,
                details={
                    "exposure": getattr(meta, "exposure", "internal"),
                    "params": params,
                },
            )
            self._send_error(
                req_id,
                403,
                "Method is not exposed for WebRTC RPC",
                correlation_id=correlation_id,
            )
            return

        if projected_method is not None:
            projected_perms = projected_method.required_permissions
            if projected_perms is None:
                await self._deny_rpc(
                    req_id,
                    method_name,
                    correlation_id,
                    "authority_unknown",
                    403,
                    "Authority is not available",
                    params=params,
                    principal_id=identity.principal_id,
                )
                return
            perms_needed = list(projected_perms)

        if perms_needed and not check_access(
            set(identity.effective_perms),
            list(perms_needed),
            method_type=meta.method_type,
        ):
            log_warning(
                f"RPCHandler: Forbidden call to {method_name} from "
                f"{identity.principal_name} (need {perms_needed}, "
                f"have {list(identity.effective_perms)})"
            )

            await self._audit_rpc_event(
                "access.denied.rpc",
                method_name=method_name,
                correlation_id=correlation_id,
                status="denied",
                reason="permission_denied",
                principal_id=identity.principal_id,
                details={
                    "required": perms_needed,
                    "effective": list(identity.effective_perms),
                    "params": params,
                },
            )

            self._send_error(req_id, 403, "Forbidden", correlation_id=correlation_id)
            return

        topic = meta.bus_topic or f"{svc_name}.{meta.name}"
        remote_data_reason = remote_data_movement_denial_reason(
            topic, params, identity.effective_perms
        )
        if remote_data_reason:
            log_warning(
                f"RPCHandler: Forbidden runtime data-movement override for {method_name} "
                f"from {identity.principal_name}: {remote_data_reason}"
            )
            await self._audit_rpc_event(
                "access.denied.rpc",
                method_name=method_name,
                correlation_id=correlation_id,
                status="denied",
                reason="runtime_data_movement_permission_denied",
                principal_id=identity.principal_id,
                details={"params": params, "required_policy": remote_data_reason},
            )
            self._send_error(req_id, 403, remote_data_reason, correlation_id=correlation_id)
            return

        # Track active remote calls for capacity limiting
        module_for_capacity = svc_name
        capacity_acquired = False
        try:
            typed_params = params
            if isinstance(params, dict):
                if topic.startswith("Tooling."):
                    params = self._bind_tooling_request_identity(
                        topic,
                        params,
                        identity.principal_id,
                        correlation_id,
                    )
                    typed_params = params
                elif (
                    topic
                    in {
                        AudioSessionMethods.PREPARE,
                        TranscriptionMethods.PROCESS_AUDIO,
                        WakeWordMethods.PROCESS_AUDIO,
                    }
                    or topic == ToolingMethods.EXECUTE_TOOL
                ):
                    params = {
                        **params,
                        "caller_peer_id": self._stable_authenticated_peer_id() or self._peer_id,
                        "caller_principal_id": identity.principal_id,
                        "correlation_id": correlation_id,
                    }
                    typed_params = params
                elif topic in {
                    SchedulerMethods.SCHEDULE,
                    SchedulerMethods.SCHEDULE_ACTION,
                    SchedulerMethods.CANCEL,
                    SchedulerMethods.PAUSE,
                    SchedulerMethods.RESUME,
                    SchedulerMethods.LIST_JOBS,
                }:
                    params = {
                        **params,
                        "caller_peer_id": self._stable_authenticated_peer_id() or self._peer_id,
                        "caller_principal_id": identity.principal_id,
                    }
                    if topic in {SchedulerMethods.SCHEDULE, SchedulerMethods.SCHEDULE_ACTION}:
                        params["correlation_id"] = correlation_id
                    typed_params = params
            if meta.input_model and isinstance(params, dict) and callable(meta.input_model):
                try:
                    typed_params = meta.input_model(**params)
                except Exception as exc:
                    log_warning(
                        f"RPCHandler: Failed to construct {meta.input_model!r} "
                        f"for {method_name}: {exc}"
                    )
                    self._send_error(
                        req_id,
                        400,
                        "Invalid request payload",
                        correlation_id=correlation_id,
                    )
                    return
            if not self._validate_speech_route_binding(
                topic=topic,
                typed_params=typed_params,
                binding=speech_route_binding,
                active_projection=active_projection,
                projected_service=projected_service,
                projected_method=projected_method,
            ):
                await self._send_capability_changed(
                    req_id=req_id,
                    method_name=method_name,
                    correlation_id=correlation_id,
                    params=params,
                    principal_id=identity.principal_id,
                )
                return

            if active_projection is not None and projected_service is not None:
                capacity = dict(projected_service.capacity or {})
                max_concurrent = int(capacity.get("max_concurrent") or 0)
                if max_concurrent > 0:
                    active = self._active_remote_calls.get(module_for_capacity, 0)
                    if active >= max_concurrent:
                        await self._deny_rpc(
                            req_id,
                            method_name,
                            correlation_id,
                            "service_at_capacity",
                            429,
                            f"Service {module_for_capacity} at capacity",
                            params=params,
                            principal_id=identity.principal_id,
                            details={"module": module_for_capacity, "active": active},
                        )
                        return
                self._active_remote_calls[module_for_capacity] = (
                    self._active_remote_calls.get(module_for_capacity, 0) + 1
                )
                capacity_acquired = True
                self._notify_capacity_change(module_for_capacity, max_concurrent)

            log_debug(f"RPCHandler: Executing {topic} via bus correlation_id={correlation_id}")
            is_streaming_method = topic == OrchestratorMethods.STREAM_INFER_CHAT
            stream_request = getattr(self._bus, "stream_request", None)
            if is_streaming_method and not callable(stream_request):
                await self._stream_infer_via_non_streaming_fallback(
                    req_id=req_id,
                    typed_params=typed_params,
                    identity=identity,
                    meta=meta,
                    correlation_id=correlation_id,
                )
                return

            if is_streaming_method and callable(stream_request):
                try:
                    async for chunk in stream_request(
                        topic,
                        typed_params,
                        timeout=30.0,
                        origin="external",
                        principal_id=identity.principal_id,
                        effective_perms=list(identity.effective_perms),
                        identity_source="webrtc_rpc",
                        method_type=meta.method_type or "use",
                        caller_peer_id=self._stable_authenticated_peer_id() or self._peer_id,
                        **_speech_route_binding_kwarg(speech_route_binding),
                        correlation_id=correlation_id,
                    ):
                        self._send_chunk(req_id, chunk)
                    self._send(json.dumps({"type": "eof", "id": req_id}))
                    return
                except asyncio.CancelledError:
                    self._send(json.dumps({"type": "eof", "id": req_id, "cancelled": True}))
                    return
                except Exception as e:
                    if _is_streaming_transport_unavailable(e):
                        await self._stream_infer_via_non_streaming_fallback(
                            req_id=req_id,
                            typed_params=typed_params,
                            identity=identity,
                            meta=meta,
                            correlation_id=correlation_id,
                        )
                        return
                    log_error(f"RPCHandler: Error during stream of {method_name}: {e}")
                    self._send_error(
                        req_id,
                        500,
                        f"Stream error: {e}",
                        correlation_id=correlation_id,
                    )
                    return

            auth_grant_revision = None
            manifest_revision = None
            projected_service_id = None
            projected_method_id = None
            if canonical_method in {
                ToolingMethods.GET_TOOLS,
                ToolingMethods.GET_TOOL_BY_NAME,
                ToolingMethods.GET_EXPORT_CATALOG,
                ToolingMethods.PREPARE_EXECUTION,
                ToolingMethods.EXECUTE_TOOL,
                ToolingMethods.REQUEST_APPROVAL,
            }:
                revisions = (
                    self._tooling_authority_revision_provider()
                    if self._tooling_authority_revision_provider is not None
                    else None
                )
                if revisions is None:
                    await self._deny_rpc(
                        req_id,
                        method_name,
                        correlation_id,
                        "authority_unknown",
                        403,
                        "Authority is not available",
                        params=params,
                        principal_id=identity.principal_id,
                    )
                    return
                auth_grant_revision, manifest_revision = revisions
                # These values come from the authenticated active projection
                # selected above, never from caller parameters. Tooling can
                # therefore prove the exact service and method were shared.
                projected_service_id = projected_service.service_id
                projected_method_id = projected_method.topic

            projection_evidence: dict[str, Any] = {}
            if projected_service_id is not None and projected_method_id is not None:
                projected_method_topics = sorted(
                    str(method.topic) for method in projected_service.methods
                )
                projection_evidence = {
                    "projected_service_id": projected_service_id,
                    "projected_method_id": projected_method_id,
                    "projected_method_topics": projected_method_topics,
                    "projected_method_set_digest": hashlib.sha256(
                        json.dumps(
                            projected_method_topics,
                            separators=(",", ":"),
                        ).encode()
                    ).hexdigest(),
                }
            res = await self._bus.request(
                topic,
                typed_params,  # type: ignore[arg-type]
                timeout=30.0,
                origin="external",
                principal_id=identity.principal_id,
                effective_perms=list(identity.effective_perms),
                identity_source="webrtc_rpc",
                method_type=meta.method_type or "use",
                caller_peer_id=self._stable_authenticated_peer_id() or self._peer_id,
                auth_grant_revision=auth_grant_revision,
                manifest_revision=manifest_revision,
                **projection_evidence,
                **_speech_route_binding_kwarg(speech_route_binding),
                correlation_id=correlation_id,
            )

            if not res.ok and res.error == "capability_changed":
                await self._send_capability_changed(
                    req_id=req_id,
                    method_name=method_name,
                    correlation_id=correlation_id,
                    params=params,
                    principal_id=identity.principal_id,
                )
                return

            contract_result = (
                isinstance(res.data, dict)
                and "ok" in res.data
                and bool(set(res.data) - {"ok", "data", "error"})
            )
            if res.ok or contract_result:
                # Notify RTCClient only after a real request handle was created.
                # A bus-level success can still contain a contract error dict.
                if canonical_method == AuthMethods.PAIRING_START and self._pairing_notify_fn:
                    pairing_data = (
                        res.data.model_dump() if hasattr(res.data, "model_dump") else res.data
                    )
                    if isinstance(pairing_data, dict) and pairing_data.get("code"):
                        self._pairing_notify_fn(self._peer_id or "")

                if hasattr(res.data, "__aiter__"):
                    try:
                        async for chunk in res.data:
                            self._send_chunk(req_id, chunk)
                        self._send(json.dumps({"type": "eof", "id": req_id}))
                    except Exception as e:
                        log_error(f"RPCHandler: Error during stream of {method_name}: {e}")
                        self._send_error(
                            req_id,
                            500,
                            f"Stream error: {e}",
                            correlation_id=correlation_id,
                        )
                else:
                    result_data = res.data
                    if hasattr(res.data, "model_dump"):
                        result_data = res.data.model_dump()
                    pairing_was_denied = bool(
                        canonical_method == AuthMethods.PAIRING_START
                        and isinstance(result_data, dict)
                        and result_data.get("status") == "denied"
                    )
                    try:
                        self._send(
                            json.dumps(
                                {"type": "result", "id": req_id, "result": result_data},
                                default=_json_default,
                            )
                        )
                    finally:
                        # A best-effort terminal frame from the requesting peer
                        # may be dropped when it immediately closes SCTP. Record
                        # the exact local transport denial independently so the
                        # deterministic offer owner cannot reconnect forever.
                        if pairing_was_denied and self._pairing_denied_fn:
                            self._pairing_denied_fn(self._peer_id or "")
            else:
                await self._audit_rpc_event(
                    "mesh.rpc.error",
                    method_name=method_name,
                    correlation_id=correlation_id,
                    status="error",
                    principal_id=identity.principal_id,
                    details={"error": res.error, "params": params},
                )
                self._send_error(
                    req_id,
                    500,
                    res.error or "Service request failed",
                    correlation_id=correlation_id,
                )

        except TimeoutError:
            await self._audit_rpc_event(
                "mesh.rpc.timeout",
                method_name=method_name,
                correlation_id=correlation_id,
                status="timeout",
                principal_id=identity.principal_id,
                details={"params": params},
            )
            self._send_error(
                req_id,
                504,
                "Service request timed out",
                correlation_id=correlation_id,
            )
        except Exception as e:
            log_error(
                f"RPCHandler: Error executing RPC {method_name}: {e} "
                f"correlation_id={correlation_id}"
            )
            await self._audit_rpc_event(
                "mesh.rpc.error",
                method_name=method_name,
                correlation_id=correlation_id,
                status="exception",
                principal_id=identity.principal_id,
                details={"error": str(e), "params": params},
            )
            self._send_error(req_id, 500, str(e), correlation_id=correlation_id)
        finally:
            # Decrement active remote call count for capacity tracking
            if capacity_acquired:
                count = self._active_remote_calls.get(module_for_capacity, 0)
                if count > 0:
                    self._active_remote_calls[module_for_capacity] = count - 1
                # Notify peers of capacity change
                if self._capacity_notify_fn and max_concurrent > 0:
                    self._notify_capacity_change(module_for_capacity, max_concurrent)

    def _notify_capacity_change(self, module: str, max_concurrent: int) -> None:
        """Best-effort capacity notification that cannot affect RPC completion."""

        if self._capacity_notify_fn is None or max_concurrent <= 0:
            return
        active = self._active_remote_calls.get(module, 0)
        try:
            self._capacity_notify_fn(module, max_concurrent - active, max_concurrent)
        except Exception as error:
            log_warning(f"RPCHandler: Capacity notification failed for {module}: {error}")

    def _send_chunk(self, req_id: Any, chunk: Any) -> None:
        """Send one stream chunk over the DataChannel in JSON-serializable form."""

        data = chunk
        if isinstance(chunk, bytes):
            data = chunk.decode(errors="ignore")
        elif hasattr(chunk, "model_dump"):
            data = chunk.model_dump(mode="json")

        self._send(
            json.dumps(
                {"type": "chunk", "id": req_id, "data": data},
                default=_json_default,
            )
        )

    async def _stream_infer_via_non_streaming_fallback(
        self,
        *,
        req_id: str,
        typed_params: Any,
        identity: Any,
        meta: Any,
        correlation_id: str,
    ) -> None:
        """Degrade process-mode stream RPC to a single non-streaming chunk.

        Process-mode Gateway receives WebRTC, while Orchestrator may live behind
        BullMQ. Until BullMQ exposes a native streaming protocol, this preserves a
        correct RPC response instead of failing the stream transport.
        """

        payload = typed_params
        if hasattr(payload, "model_copy"):
            payload = payload.model_copy(update={"stream": False})
        elif isinstance(payload, dict):
            payload = {**payload, "stream": False}
        result = await self._bus.request(
            OrchestratorMethods.INFER_CHAT,
            payload,
            timeout=30.0,
            origin="external",
            principal_id=identity.principal_id,
            effective_perms=list(identity.effective_perms),
            identity_source="webrtc_rpc",
            method_type=meta.method_type or "use",
            caller_peer_id=self._stable_authenticated_peer_id() or self._peer_id,
            correlation_id=correlation_id,
        )
        if not result.ok:
            self._send_error(
                req_id,
                500,
                result.error or "Streaming fallback inference failed",
                correlation_id=correlation_id,
            )
            return
        response = (
            result.data
            if isinstance(result.data, OrchestratorInferChatResponse)
            else OrchestratorInferChatResponse.model_validate(result.data)
            if isinstance(result.data, dict)
            else OrchestratorInferChatResponse(text="" if result.data is None else str(result.data))
        )
        self._send_chunk(
            req_id,
            OrchestratorInferChatChunk(
                delta=response.text,
                text=response.text,
                is_final=True,
                finish_reason=response.finish_reason or "stop",
                model_id=response.model_id,
                provider_id=response.provider_id,
                correlation_id=response.correlation_id or correlation_id,
            ),
        )
        self._send(json.dumps({"type": "eof", "id": req_id}))

    def _bind_tooling_request_identity(
        self,
        topic: str,
        params: dict[str, Any],
        principal_id: str,
        correlation_id: str,
    ) -> dict[str, Any]:
        stable_peer_id = self._stable_authenticated_peer_id() or self._peer_id or "unknown-peer"
        normalized = dict(params)
        for field in (
            "peer_id",
            "provider_id",
            "provider_peer_id",
            "provider_peer_ids",
            "remote_peer_id",
            "mesh_peer_id",
            "target_peer_id",
            "service_instance_id",
            "source_service_instance_id",
            "caller_peer_id",
            "source_peer_id",
            "principal_id",
            "caller_principal_id",
            "provider_principal_id",
            "actor_principal_id",
            "requested_by_principal_id",
            "approver_principal_id",
            "created_by",
            "revoked_by",
            "policy_peer_id",
            "approval_peer_id",
        ):
            normalized.pop(field, None)
        normalized["caller_peer_id"] = stable_peer_id
        normalized["caller_principal_id"] = principal_id
        normalized["correlation_id"] = correlation_id
        actor_fields_by_topic = {
            ToolingMethods.SET_SHARING_POLICY: ("actor_principal_id",),
            ToolingMethods.REQUEST_APPROVAL: ("requested_by_principal_id",),
            ToolingMethods.CONFIRM_EXECUTION: ("approver_principal_id",),
            ToolingMethods.CREATE_APPROVAL_GRANT: ("created_by",),
            ToolingMethods.REVOKE_APPROVAL_GRANT: ("revoked_by",),
            ToolingMethods.SET_POLICY_MODE: ("actor_principal_id",),
            ToolingMethods.UPSERT_SOURCE_POLICY: ("actor_principal_id",),
            ToolingMethods.UPSERT_TOOL_POLICY_OVERRIDE: ("actor_principal_id",),
        }
        for field in actor_fields_by_topic.get(topic, ()):
            normalized[field] = principal_id
        if topic in {
            ToolingMethods.REMOTE_CATALOG_ANNOUNCED,
            ToolingMethods.REMOTE_CATALOG_DELTA_ANNOUNCED,
            ToolingMethods.REMOTE_CATALOG_REMOVED,
        }:
            normalized["peer_id"] = stable_peer_id
            normalized["provider_id"] = stable_peer_id
            normalized["service_instance_id"] = f"remote:{stable_peer_id}:Tooling"
        return normalized

    async def _find_method(self, method_name: str) -> tuple[str, MethodInfo] | None:
        if "." not in method_name:
            return None
        svc, _cmd = method_name.split(".", 1)
        if not svc:
            return None
        announcement = await self._registry.get_service(svc)
        if not announcement:
            return None
        for method_info in announcement.methods:
            topic = method_info.bus_topic or f"{svc}.{method_info.name}"
            if topic == method_name:
                return svc, method_info

        return None

    @staticmethod
    def _projection_denial_reason(projection: ProjectionResult | None) -> str | None:
        if projection is None:
            return "authority_unknown"
        if projection.readiness == "pending":
            return "authority_pending"
        if projection.readiness == "revoked":
            return "authority_revoked"
        if projection.readiness != "ready" or not projection.routable:
            return "authority_unknown"
        return None

    @staticmethod
    def _parse_speech_route_binding(identity_meta: dict[str, Any]) -> SpeechRouteBinding | None:
        raw = identity_meta.get("speech_route_binding")
        if raw is None:
            return None
        try:
            return SpeechRouteBinding.model_validate(raw)
        except Exception:
            return None

    def _validate_speech_route_binding(
        self,
        *,
        topic: str,
        typed_params: Any,
        binding: SpeechRouteBinding | None,
        active_projection: ProjectionResult | None,
        projected_service: Any | None,
        projected_method: Any | None,
    ) -> bool:
        constraints_value = getattr(projected_method, "speech_constraints", None)
        if constraints_value is None:
            return binding is None
        try:
            constraints = SpeechMethodConstraints.model_validate(constraints_value)
        except Exception:
            return False
        if binding is None or active_projection is None or projected_service is None:
            return False

        provider_peer_id = active_projection.cache_key.provider_peer_id
        service_id = str(getattr(projected_service, "service_id", "") or "")
        expected_service_instance_id = f"remote:{provider_peer_id}:{service_id}"
        if binding.service_instance_id != expected_service_instance_id:
            return False

        provider_state = self._local_provider_binding_state()
        if provider_state is None:
            return False
        readiness, availability_revision = provider_state
        cache_key = active_projection.cache_key
        if (
            str(getattr(readiness, "registry_revision", "") or "") != cache_key.registry_revision
            or str(getattr(readiness, "export_policy_revision", "") or "")
            != cache_key.policy_revision
            or int(getattr(readiness, "auth_grant_revision", 0) or 0)
            != cache_key.authority_revision
        ):
            return False
        if service_id not in tuple(getattr(readiness, "compatible_services", ()) or ()):
            return False
        if binding.provider_lease_epoch != getattr(readiness, "connection_epoch", ""):
            return False
        if binding.provider_lease_revision != availability_revision:
            return False
        projection_digest = str(getattr(readiness, "projection_digest", "") or "")
        if binding.projection_digest != projection_digest:
            return False
        expected_projection_revision = compute_speech_projection_binding_revision(
            projection_digest=projection_digest,
            registry_revision=str(getattr(readiness, "registry_revision", "") or ""),
            policy_revision=str(getattr(readiness, "export_policy_revision", "") or ""),
            auth_grant_revision=int(getattr(readiness, "auth_grant_revision", 0) or 0),
        )
        if binding.projection_revision != expected_projection_revision:
            return False
        if binding.speech_capability_revision != constraints.speech_capability_revision:
            return False
        return binding.requirement_digest == compute_speech_route_requirement_digest_for_payload(
            topic,
            typed_params,
        )

    async def _send_capability_changed(
        self,
        *,
        req_id: Any,
        method_name: str,
        correlation_id: str,
        params: Any,
        principal_id: str | None,
    ) -> None:
        await self._audit_rpc_event(
            "access.denied.rpc",
            method_name=method_name,
            correlation_id=correlation_id,
            status="denied",
            reason="capability_changed",
            principal_id=principal_id,
            details={"params": params},
        )
        self._send(
            json.dumps(
                {
                    "type": "result",
                    "id": req_id,
                    "correlation_id": correlation_id,
                    "result": {
                        "accepted": False,
                        "reason_code": "capability_changed",
                        "error": "capability_changed",
                    },
                }
            )
        )

    async def _deny_rpc(
        self,
        req_id: Any,
        method_name: str,
        correlation_id: str,
        reason: str,
        code: int,
        message: str,
        *,
        params: Any,
        principal_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        audit_details = {"params": params}
        if details:
            audit_details.update(details)
        await self._audit_rpc_event(
            "access.denied.rpc",
            method_name=method_name,
            correlation_id=correlation_id,
            status="denied",
            reason=reason,
            principal_id=principal_id,
            details=audit_details,
        )
        self._send_error(req_id, code, message, correlation_id=correlation_id)

    async def _audit_rpc_event(
        self,
        event: str,
        *,
        method_name: str,
        correlation_id: str,
        status: str,
        reason: str | None = None,
        principal_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        if not self._audit_fn:
            return
        import contextlib

        safe_details = redacted_copy(details or {})
        audit_details = {
            "method": method_name,
            "peer_id": self._peer_id,
            "correlation_id": correlation_id,
            "status": status,
            "reason": reason,
            "details": safe_details,
            "details_sha256": audit_details_hash(safe_details),
        }
        with contextlib.suppress(Exception):
            await self._audit_fn(event, principal_id, audit_details)

    def _send_error(
        self,
        req_id: Any,
        code: int,
        message: str,
        *,
        correlation_id: str | None = None,
    ) -> bool:
        """Send an RPC error when the transport is still available.

        Error frames are terminal, best-effort responses. A peer can close the
        DataChannel while its request is still executing, so failure to send
        the response must not escape as an unhandled task exception.
        """

        frame = json.dumps(
            {
                "type": "error",
                "id": req_id,
                "correlation_id": correlation_id,
                "error": {"code": code, "message": message},
            }
        )
        try:
            self._send(frame)
        except Exception:
            log_warning(
                f"RPCHandler: Dropped RPC error response after transport loss (code={code})"
            )
            return False
        return True


def _speech_route_binding_kwarg(
    binding: SpeechRouteBinding | None,
) -> dict[str, SpeechRouteBinding]:
    return {"speech_route_binding": binding} if binding is not None else {}
