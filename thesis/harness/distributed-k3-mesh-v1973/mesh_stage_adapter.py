"""One exact-peer typed MeshBus request for K3/K3 audio stages.

Private campaign source only. It does not select an endpoint/peer, retry,
change service policy, or claim remote provider identity. The caller must pass
the independently admitted peer binding for each stage.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any, TypeVar

_T = TypeVar("_T")
_STAGES = frozenset({"stt", "assistant", "tts"})
_ROUTE_FIELDS = ("dispatch_selector", "mesh_selector", "selector")


@dataclass(frozen=True)
class AdmittedMeshPeer:
    """Exact peer ID plus its independently frozen digest."""

    peer_id: str
    sha256: str


class MeshStageError(RuntimeError):
    """Finite safe failure category; never retains bus error text."""

    def __init__(self, stage: str, category: str, *, duration_ms: float | None = None,
                 stop_campaign: bool = True, preaccept_response: dict[str, Any] | None = None):
        super().__init__(category)
        self.stage = stage
        self.category = category
        self.duration_ms = duration_ms
        self.stop_campaign = stop_campaign
        self.preaccept_response = preaccept_response


def _topic_for(stage: str) -> tuple[str, type[Any]]:
    from app.shared.contracts.models.mesh import MeshAddressSelector
    from app.shared.contracts.models.orchestrator import OrchestratorMethods
    from app.shared.contracts.models.stt import TranscriptionMethods
    from app.shared.contracts.models.tts import TTSMethods

    topics = {
        "stt": TranscriptionMethods.TRANSCRIBE,
        "assistant": OrchestratorMethods.EXTERNAL_USER_INPUT,
        "tts": TTSMethods.SYNTHESIZE,
    }
    topic = topics.get(stage)
    if topic is None:
        raise MeshStageError("unknown", "stage_not_supported")
    return topic, MeshAddressSelector


def _peer_hash(peer_id: str) -> str:
    return hashlib.sha256(peer_id.encode("utf-8", "strict")).hexdigest()


def _validate_request(stage: str, request_model: Any, peer: AdmittedMeshPeer,
                      correlation_id: str) -> tuple[str, Any]:
    topic, selector_type = _topic_for(stage)
    if (not isinstance(peer, AdmittedMeshPeer) or not isinstance(peer.peer_id, str)
            or not peer.peer_id or not isinstance(peer.sha256, str)
            or peer.sha256 != _peer_hash(peer.peer_id)):
        raise MeshStageError(stage, "admitted_peer_binding_invalid")
    if not isinstance(correlation_id, str) or not correlation_id:
        raise MeshStageError(stage, "request_correlation_missing")
    if not callable(getattr(request_model, "model_copy", None)):
        raise MeshStageError(stage, "typed_request_required")
    if not hasattr(request_model, "mesh_selector"):
        raise MeshStageError(stage, "typed_mesh_selector_not_supported")
    for field in _ROUTE_FIELDS:
        existing = getattr(request_model, field, None)
        if existing is not None:
            raise MeshStageError(stage, "conflicting_selector_present")
    request_correlation = getattr(request_model, "correlation_id", None)
    if request_correlation is not None and request_correlation != correlation_id:
        raise MeshStageError(stage, "request_correlation_mismatch")
    selector = selector_type(peer_id=peer.peer_id)
    return topic, request_model.model_copy(update={"mesh_selector": selector})


def _observed_exact_peer_call(correlation_id: str, topic: str,
                              expected_peer_hash: str) -> tuple[dict[str, Any] | None, str]:
    try:
        import bindings

        rows = bindings.mesh_call_observation(correlation_id)
    except Exception:
        return None, "peer_call_observation_unavailable"
    if not isinstance(rows, (tuple, list)):
        return None, "peer_call_observation_invalid"
    starts = [row for row in rows if isinstance(row, dict)
              and row.get("event") == "mesh_peer_call_start"
              and row.get("topic") == topic]
    ends = [row for row in rows if isinstance(row, dict)
            and row.get("event") == "mesh_peer_call_end"
            and row.get("topic") == topic]
    if len(starts) != 1 or len(ends) != 1:
        return None, "exact_peer_call_count_mismatch"
    start, end = starts[0], ends[0]
    if (start.get("correlation_id") != correlation_id
            or end.get("correlation_id") != correlation_id
            or start.get("peer_id_sha256") != expected_peer_hash
            or end.get("peer_id_sha256") != expected_peer_hash):
        return None, "exact_peer_call_binding_mismatch"
    if (type(start.get("monotonic_start_ns")) is not int
            or type(end.get("monotonic_start_ns")) is not int
            or type(end.get("monotonic_end_ns")) is not int
            or start.get("monotonic_start_ns") != end.get("monotonic_start_ns")
            or type(start.get("pid")) is not int
            or start.get("pid") != end.get("pid")
            or end["monotonic_end_ns"] < start["monotonic_start_ns"]):
        return None, "peer_call_clock_invalid"
    if end.get("outcome") != "ok":
        return end, "exact_peer_call_failed"
    return end, "observed"


async def request_mesh_stage(
    bus: Any,
    stage: str,
    request_model: Any,
    response_model: type[_T],
    peer: AdmittedMeshPeer,
    *,
    correlation_id: str,
    deadline_monotonic: float,
) -> tuple[_T, dict[str, Any]]:
    """Send one typed STT/Assistant/TTS request to one admitted mesh peer.

    The model contracts carry a ``mesh_selector`` field. MeshBus resolves that
    exact peer through its normal negotiated-peer, provider and policy checks;
    an explicit selector prevents transparent reroute and local fallback. The
    route observer must confirm the same peer/topic/correlation once. An
    uncertain request or timeout is terminal because remote work may continue.
    """
    from app.messaging.mesh_bus import MeshBus

    topic, request = _validate_request(stage, request_model, peer, correlation_id)
    return await _request_with_bus(
        bus, stage, topic, request, response_model, peer, correlation_id,
        deadline_monotonic, MeshBus,
    )
async def _request_with_bus(
    bus: Any,
    stage: str,
    topic: str,
    request: Any,
    response_model: type[_T],
    peer: AdmittedMeshPeer,
    correlation_id: str,
    deadline_monotonic: float,
    mesh_bus_type: type[Any],
) -> tuple[_T, dict[str, Any]]:
    if not isinstance(bus, mesh_bus_type):
        raise MeshStageError(stage, "mesh_bus_not_active")
    remaining = deadline_monotonic - time.monotonic()
    if remaining <= 0:
        raise MeshStageError(stage, "request_deadline_exhausted")
    started_ns = time.monotonic_ns()
    try:
        result = await asyncio.wait_for(
            bus.request(
                topic, request, origin="internal", principal_id="system",
                correlation_id=correlation_id, timeout=remaining,
            ),
            timeout=remaining,
        )
    except (asyncio.TimeoutError, TimeoutError):
        elapsed = (time.monotonic_ns() - started_ns) / 1_000_000
        raise MeshStageError(stage, "mesh_request_timeout_ambiguous",
                             duration_ms=elapsed) from None
    except Exception:
        elapsed = (time.monotonic_ns() - started_ns) / 1_000_000
        raise MeshStageError(stage, "mesh_transport_ambiguous",
                             duration_ms=elapsed) from None
    ended_ns = time.monotonic_ns()
    elapsed_ms = (ended_ns - started_ns) / 1_000_000

    # PeerBridge returns its own deadline as QueryResult(ok=False, error=...)
    # rather than raising. Match the exact production message before the
    # generic failed route-observation branch, without retaining/logging it.
    if (getattr(result, "ok", None) is False
            and getattr(result, "error", None)
                == f"Remote call to {peer.peer_id} timed out after {remaining}s"):
        raise MeshStageError(stage, "remote_peer_timeout", duration_ms=elapsed_ms)

    peer_hash = _peer_hash(peer.peer_id)
    route_row, route_status = _observed_exact_peer_call(
        correlation_id, topic, peer_hash,
    )
    data = getattr(result, "data", None)
    if (route_status == "exact_peer_call_failed"
            and getattr(result, "ok", None) is False
            and isinstance(data, dict) and data.get("accepted") is False
            and data.get("reason_code") == "capability_changed"):
        # Preserve only the real bounded response fields, not arbitrary errors
        # or payloads. The observer already bound exact peer/topic/correlation.
        response = {key: data[key] for key in ("accepted", "reason_code")}
        response.update(method_topic=topic, peer_id_sha256=peer_hash,
                        correlation_id=correlation_id, peer_call_pid=route_row["pid"])
        raise MeshStageError(stage, "preaccept_capability_changed", duration_ms=elapsed_ms,
                             stop_campaign=False, preaccept_response=response)
    if route_status != "observed":
        category = "exact_peer_call_timeout" if route_status == "exact_peer_call_failed" \
            and isinstance(route_row, dict) and route_row.get("error_class") == "TimeoutError" \
            else route_status
        raise MeshStageError(stage, category, duration_ms=elapsed_ms)
    if not getattr(result, "ok", False):
        raise MeshStageError(stage, "mesh_query_failed", duration_ms=elapsed_ms)

    raw = getattr(result, "data", None)
    try:
        response = raw if isinstance(raw, response_model) else response_model.model_validate(raw)
    except Exception:
        raise MeshStageError(stage, "typed_response_invalid", duration_ms=elapsed_ms) from None
    route_start_ns = route_row.get("monotonic_start_ns")
    route_end_ns = route_row.get("monotonic_end_ns")
    meta = {
        "stage": stage,
        "transport": "typed_gateway_mesh_peer_bridge",
        "method_topic": topic,
        "selected_peer_id_sha256": peer_hash,
        "mesh_correlation_id": correlation_id,
        "request_payload_sha256": hashlib.sha256(
            json.dumps(request.model_dump(mode="json"), sort_keys=True,
                       separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ).hexdigest(),
        "request_payload_hash_scope": "typed_requester_payload_including_exact_mesh_selector_not_augmented_model_input",
        "requester_duration_ms": elapsed_ms,
        "peer_call_duration_ms": (route_end_ns - route_start_ns) / 1_000_000,
        "peer_call_pid": route_row.get("pid"),
        "actual_peerbridge_call_observed": True,
        "selected_ice_pair": None,
        "selected_ice_pair_unavailable_reason": "not_emitted_by_peerbridge_call_observer",
    }
    return response, meta
