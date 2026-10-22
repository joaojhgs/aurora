"""One exact-peer typed TTS request over Aurora's production MeshBus."""
from __future__ import annotations

import hashlib
import time
from typing import Any


class RemoteMeshTtsCallError(RuntimeError):
    """Finite failure category; never retain QueryResult error text."""

    def __init__(self, category: str):
        super().__init__(category)
        self.category = category


async def synthesize_mesh_tts(
    bus: Any, text: str, deadline_monotonic: float, *,
    correlation_id: str, selected_peer_id: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Call TTS.SYNTHESIZE through MeshBus with a binding exact peer selector.

    MeshBus consumes ``mesh_selector`` to resolve the authorized peer and the
    PeerBridge call carries this request correlation to the receiver. The
    selector is intentionally not forwarded to the receiver service. No local
    fallback or retry is performed here; any uncertain result is terminal.
    """
    from app.messaging.mesh_bus import MeshBus
    from app.shared.contracts.models.mesh import MeshAddressSelector
    from app.shared.contracts.models.tts import TTSMethods, TTSSynthesizeRequest

    if not isinstance(bus, MeshBus):
        raise RemoteMeshTtsCallError("mesh_bus_not_active")
    if not isinstance(text, str) or not text.strip():
        raise RemoteMeshTtsCallError("assistant_text_missing")
    if not correlation_id or not selected_peer_id:
        raise RemoteMeshTtsCallError("exact_peer_or_correlation_missing")
    remaining = deadline_monotonic - time.monotonic()
    if remaining <= 0:
        raise RemoteMeshTtsCallError("request_deadline_exhausted")

    request = TTSSynthesizeRequest(
        text=text,
        format="wav",
        mesh_selector=MeshAddressSelector(peer_id=selected_peer_id),
    )
    started = time.monotonic_ns()
    try:
        result = await bus.request(
            TTSMethods.SYNTHESIZE,
            request,
            origin="internal",
            principal_id="system",
            correlation_id=correlation_id,
            timeout=remaining,
        )
    except Exception as exc:
        # A transport exception can occur after remote acceptance; do not retry.
        raise RemoteMeshTtsCallError(f"mesh_call_{type(exc).__name__}") from None
    ended = time.monotonic_ns()
    # PeerBridge converts its wait_for deadline into a failed QueryResult
    # instead of raising. Recognize only its exact finite message for this
    # selected peer and timeout before checking the generic failed route row.
    if (getattr(result, "ok", None) is False
            and getattr(result, "error", None)
                == f"Remote call to {selected_peer_id} timed out after {remaining}s"):
        raise RemoteMeshTtsCallError("remote_peer_timeout")
    import bindings
    route_rows = bindings.mesh_call_observation(correlation_id)
    route_starts = [row for row in route_rows if row.get("event") == "mesh_peer_call_start"]
    route_ends = [row for row in route_rows if row.get("event") == "mesh_peer_call_end"]
    expected_peer_hash = hashlib.sha256(selected_peer_id.encode()).hexdigest()
    if (len(route_starts) != 1 or len(route_ends) != 1
            or route_starts[0].get("peer_id_sha256") != expected_peer_hash
            or route_ends[0].get("peer_id_sha256") != expected_peer_hash
            or route_starts[0].get("topic") != TTSMethods.SYNTHESIZE
            or route_ends[0].get("topic") != TTSMethods.SYNTHESIZE
            or route_ends[0].get("outcome") != "ok"):
        raise RemoteMeshTtsCallError("exact_remote_peer_call_not_confirmed")
    if not getattr(result, "ok", False):
        raise RemoteMeshTtsCallError("mesh_query_failed")
    data = getattr(result, "data", None)
    if hasattr(data, "model_dump"):
        data = data.model_dump(mode="json")
    if not isinstance(data, dict):
        raise RemoteMeshTtsCallError("mesh_response_shape_invalid")
    metadata = {
        "transport": "typed_gateway_mesh_peer_bridge",
        "selected_peer_id_sha256": hashlib.sha256(selected_peer_id.encode()).hexdigest(),
        "mesh_correlation_id": correlation_id,
        "actual_peerbridge_call_observed": True,
        "requester_duration_ms": (ended - started) / 1_000_000,
        "response_fields": sorted(data.keys()),
    }
    return data, metadata
