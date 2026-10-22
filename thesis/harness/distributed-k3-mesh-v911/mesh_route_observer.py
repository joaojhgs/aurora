"""Passive, redacted selected-ICE-route observation for an owned mesh call.

This module is intended for a private harness bootstrap to install around the
existing ``PeerBridge.call`` method. It is not product instrumentation. It
uses the installed aiortc/aioice nominated-pair internals because aiortc's
public ``RTCPeerConnection.getStats`` reports RTP sender/receiver stats only.
The only emitted route details are candidate types, transport protocol,
component, exact-peer/session/connection hashes, request correlation and the
process monotonic clock. Candidate addresses, foundations, SDP, payloads and
exception text are never emitted.
"""
from __future__ import annotations

import hashlib
import os
import time
from collections.abc import Callable, Sequence
from typing import Any

_SAFE_CANDIDATE_TYPES = frozenset({"host", "srflx", "prflx", "relay"})
_SAFE_PROTOCOLS = frozenset({"udp", "tcp", "tcp-so"})
_PC_ATTR = "_RTCPeerConnection__iceTransports"


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "strict")).hexdigest()


def _candidate_type(candidate: Any) -> str | None:
    value = getattr(candidate, "type", None)
    return value if isinstance(value, str) and value in _SAFE_CANDIDATE_TYPES else None


def _protocol(candidate: Any) -> str | None:
    value = getattr(candidate, "transport", None)
    return value if isinstance(value, str) and value in _SAFE_PROTOCOLS else None


def _selected_pairs(pc: Any) -> tuple[str, list[dict[str, Any]]]:
    ice_transports = getattr(pc, _PC_ATTR, None)
    if not isinstance(ice_transports, (set, list, tuple)):
        return "ice_transport_collection_unavailable", []

    rows: list[dict[str, Any]] = []
    ordered_transports = sorted(ice_transports, key=id)
    for transport_ordinal, ice_transport in enumerate(ordered_transports, start=1):
        connection = getattr(ice_transport, "_connection", None)
        nominated = getattr(connection, "_nominated", None)
        if not isinstance(nominated, dict):
            return "nominated_pair_map_unavailable", []
        for component, pair in sorted(nominated.items(), key=lambda item: str(item[0])):
            if type(component) is not int or component < 1:
                return "nominated_pair_component_invalid", []
            protocol = getattr(pair, "protocol", None)
            local = getattr(protocol, "local_candidate", None)
            remote = getattr(pair, "remote_candidate", None)
            local_type = _candidate_type(local)
            remote_type = _candidate_type(remote)
            local_protocol = _protocol(local)
            remote_protocol = _protocol(remote)
            state = getattr(getattr(pair, "state", None), "name", None)
            nominated_flag = getattr(pair, "nominated", None)
            if nominated_flag is not True:
                return "nominated_map_pair_not_marked_nominated", []
            if state != "SUCCEEDED":
                return "nominated_pair_not_succeeded", []
            if None in (local_type, remote_type, local_protocol, remote_protocol):
                return "nominated_pair_fields_unavailable", []
            path_class = "relay" if "relay" in (local_type, remote_type) else "direct"
            rows.append({
                "component": component,
                "ice_transport_ordinal": transport_ordinal,
                "pair_state": state.lower(),
                "nominated": True,
                "local_candidate_type": local_type,
                "remote_candidate_type": remote_type,
                "local_protocol": local_protocol,
                "remote_protocol": remote_protocol,
                "path_class": path_class,
            })
    if not rows:
        return "no_nominated_pair", []
    return "selected_nominated_pair_observed", rows


def sample_peer_route(rtc_client: Any, peer_id: str) -> dict[str, Any]:
    """Read the currently nominated pair(s) for one exact stable peer.

    The caller must associate this observation with the real mesh request
    correlation. Missing internal mappings are represented as finite statuses;
    this function never falls back to another peer or transport.
    """
    sampled_at = time.monotonic_ns()
    pid = os.getpid()
    base: dict[str, Any] = {
        "sampled_monotonic_ns": sampled_at,
        "clock_domain": f"python.monotonic_ns:pid:{pid}",
        "pid": pid,
        "peer_id_sha256": _digest(peer_id) if isinstance(peer_id, str) and peer_id else None,
        "session_peer_id_sha256": None,
        "peer_connection_instance_sha256": None,
    }
    session_resolver = getattr(rtc_client, "_session_for_peer_id", None)
    connections = getattr(rtc_client, "_pcs", None)
    if not isinstance(peer_id, str) or not peer_id or not callable(session_resolver):
        base["status"] = "exact_peer_session_lookup_unavailable"
        return base
    if not isinstance(connections, dict):
        base["status"] = "peer_connection_registry_unavailable"
        return base
    try:
        session_peer_id = session_resolver(peer_id)
    except Exception:
        base["status"] = "exact_peer_session_lookup_failed"
        return base
    if not isinstance(session_peer_id, str) or not session_peer_id:
        base["status"] = "exact_peer_session_missing"
        return base
    base["session_peer_id_sha256"] = _digest(session_peer_id)
    pc = connections.get(session_peer_id)
    if pc is None:
        base["status"] = "exact_peer_connection_missing"
        return base
    base["peer_connection_instance_sha256"] = _digest(f"{pid}:{id(pc)}")
    status, pairs = _selected_pairs(pc)
    base["status"] = status
    base["selected_pairs"] = pairs
    return base


def install_peer_bridge_observer(
    peer_bridge_type: type,
    writer: Callable[[dict[str, Any]], None],
    *,
    topic_filter: str | Sequence[str],
) -> None:
    """Wrap selected existing PeerBridge topics without changing semantics.

    ``topic_filter`` is the tuple of typed STT/Assistant/TTS method constants
    supplied by the private bootstrap. The original call is awaited exactly once and its
    result/exception is preserved. Observation write failures are ignored so
    telemetry cannot change service behavior.
    """
    if isinstance(topic_filter, str):
        topics = frozenset((topic_filter,))
    elif isinstance(topic_filter, Sequence) and not isinstance(topic_filter, (bytes, bytearray)):
        topics = frozenset(value for value in topic_filter if isinstance(value, str) and value)
    else:
        topics = frozenset()
    if not topics:
        raise ValueError("typed_mesh_topics_required")
    original = getattr(peer_bridge_type, "call", None)
    if not callable(original):
        raise TypeError("peer_bridge_call_unavailable")
    if getattr(original, "_aurora_route_observer_v894", False):
        return

    async def observed_call(self: Any, peer_id: str, topic: str, payload: Any, *args: Any, **kwargs: Any) -> Any:
        if topic not in topics:
            return await original(self, peer_id, topic, payload, *args, **kwargs)
        correlation_id = kwargs.get("correlation_id")
        if correlation_id is None and len(args) > 1:
            correlation_id = args[1]
        start_sample = _safe_sample(self._rtc_client, peer_id)
        call_start = time.monotonic_ns()
        outcome = "raised"
        try:
            result = await original(self, peer_id, topic, payload, *args, **kwargs)
        except BaseException:
            call_end = time.monotonic_ns()
            end_sample = _safe_sample(self._rtc_client, peer_id)
            _emit(writer, _row(topic, correlation_id, call_start, call_end, outcome, start_sample, end_sample))
            raise
        call_end = time.monotonic_ns()
        outcome = "ok" if getattr(result, "ok", False) is True else "failed"
        end_sample = _safe_sample(self._rtc_client, peer_id)
        _emit(writer, _row(topic, correlation_id, call_start, call_end, outcome, start_sample, end_sample))
        return result

    observed_call._aurora_route_observer_v894 = True  # type: ignore[attr-defined]
    peer_bridge_type.call = observed_call


def _row(
    topic: str,
    correlation_id: Any,
    call_start: int,
    call_end: int,
    outcome: str,
    before: dict[str, Any],
    after: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema": "aurora.mesh_route_observation.v1",
        "topic": topic,
        "correlation_id": correlation_id if isinstance(correlation_id, str) else None,
        "request_outcome": outcome,
        "request_monotonic_start_ns": call_start,
        "request_monotonic_end_ns": call_end,
        "requester_pid": os.getpid(),
        "before": before,
        "after": after,
        "address_data_redacted": True,
    }


def _emit(writer: Callable[[dict[str, Any]], None], row: dict[str, Any]) -> None:
    try:
        writer(row)
    except BaseException:
        # A telemetry sink must not alter real request results or exceptions.
        return


def _safe_sample(rtc_client: Any, peer_id: str) -> dict[str, Any]:
    try:
        return sample_peer_route(rtc_client, peer_id)
    except BaseException:
        return {
            "sampled_monotonic_ns": time.monotonic_ns(),
            "clock_domain": f"python.monotonic_ns:pid:{os.getpid()}",
            "pid": os.getpid(),
            "peer_id_sha256": _digest(peer_id) if isinstance(peer_id, str) and peer_id else None,
            "session_peer_id_sha256": None,
            "peer_connection_instance_sha256": None,
            "status": "observer_failed",
        }
