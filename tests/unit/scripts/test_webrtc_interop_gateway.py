"""Focused tests for deterministic pieces of the live WebRTC interop peer."""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest

from app.shared.contracts.models.auth import (
    AuthMethods,
    build_mesh_reconnect_proof_message,
)
from app.shared.contracts.models.gateway import GatewayMethods
from scripts.webrtc_interop_gateway import (
    MUTATE_TOPIC,
    MUTATION_COUNT_TOPIC,
    REVOKE_TOPIC,
    InteropAuth,
    InteropBus,
    InteropRegistry,
    build_gateway_report,
    build_ready_payload,
    non_host_ice_candidate,
)

TOKEN = "g009.test-token-that-must-never-be-reported"


def make_bus() -> InteropBus:
    return InteropBus(InteropRegistry(), TOKEN)


def test_registry_response_is_sorted_and_digest_is_stable() -> None:
    registry = InteropRegistry()

    first = registry.registry_response()
    second = registry.registry_response()
    modules = [module.module for module in first.modules]

    assert modules == sorted(modules)
    assert modules == ["Auth", "Config", "G009Interop", "Gateway", "Orchestrator", "TTS"]
    assert first.digest == second.digest
    assert len(first.digest) == 64


@pytest.mark.asyncio
async def test_bus_registry_and_pairing_round_trip() -> None:
    bus = make_bus()

    registry_result = await bus.request(
        GatewayMethods.GET_REGISTRY,
        correlation_id="registry-correlation",
    )
    start = await bus.request(
        AuthMethods.PAIRING_START,
        {
            "pairing_session_id": "pairing-session",
            "verification_code": "123456",
        },
    )
    connect = await bus.request(
        AuthMethods.PAIRING_CONNECT,
        {
            "code": start.data["code"],
            "pairing_session_id": "pairing-session",
        },
    )
    exchange = await bus.request(
        AuthMethods.PAIRING_EXCHANGE,
        {"code": start.data["code"]},
    )

    assert registry_result.ok is True
    assert registry_result.data.digest
    assert start.data == {
        "status": "pending",
        "code": "interop-handle-1",
        "pairing_session_id": "pairing-session",
        "verification_code": "123456",
    }
    assert connect.data["status"] == "approved"
    assert connect.data["verification_code"] == "123456"
    assert exchange.data["token"] == TOKEN
    assert bus.requests[0] == {
        "topic": GatewayMethods.GET_REGISTRY,
        "origin": None,
        "correlation_id": "registry-correlation",
    }


@pytest.mark.asyncio
async def test_bus_mutation_is_counted_once_and_released_after_started_ack() -> None:
    bus = make_bus()
    started: list[dict[str, object]] = []

    async def release_after_started(record: dict[str, object]) -> None:
        started.append(record)
        bus.mutation_releases[str(record["mutation_id"])].set()

    bus.on_mutation_started = release_after_started
    result = await bus.request(
        MUTATE_TOPIC,
        {"mutation_id": "mutation-1", "delay_seconds": 0},
        correlation_id="request-1",
    )
    count = await bus.request(MUTATION_COUNT_TOPIC, {"mutation_id": "mutation-1"})

    assert result.ok is True
    assert result.data["execution_count"] == 1
    assert count.data == {"mutation_id": "mutation-1", "execution_count": 1}
    assert started[0]["request_correlation_id"] == "request-1"
    assert bus.mutation_records["mutation-1"]["response_category"] == ("delayed_after_started_ack")


@pytest.mark.asyncio
async def test_auth_accepts_canonical_reconnect_proof_and_fails_closed_after_revocation() -> None:
    bus = make_bus()
    auth = InteropAuth(TOKEN, bus)
    proof_fields = {
        "token_id": "interop-token-row",
        "challenge": "challenge",
        "channel_binding": "channel-binding",
        "claimant_peer_id": "browser-g009",
        "verifier_peer_id": "python-gateway-g009",
        "room_name": "interop-room",
    }
    message = build_mesh_reconnect_proof_message(**proof_fields)
    key = hashlib.sha256(TOKEN.encode("utf-8")).digest()
    proof = hmac.new(key, message, hashlib.sha256).hexdigest()

    token = await auth.verify_mesh_reconnect_proof(**proof_fields, proof=proof)
    tampered = await auth.verify_mesh_reconnect_proof(
        **proof_fields,
        proof=f"{proof[:-1]}{'0' if proof[-1] != '0' else '1'}",
    )
    await bus.request(REVOKE_TOPIC)
    revoked = await auth.verify_mesh_reconnect_proof(**proof_fields, proof=proof)

    assert token is not None
    assert token.id == "interop-token-row"
    assert tampered is None
    assert revoked is None


@pytest.mark.asyncio
async def test_authentication_builds_an_admin_webrtc_identity_without_exposing_token() -> None:
    bus = make_bus()
    auth = InteropAuth(TOKEN, bus)

    assert await auth.authenticate_token("wrong") is None
    token = await auth.authenticate_token(TOKEN)
    assert token is not None

    identity = await auth.build_identity_from_token(token)
    serialized = repr(identity)

    assert identity.principal_id == "interop-principal"
    assert identity.device_id == "browser-device"
    assert identity.source == "webrtc_peer"
    assert identity.is_admin is True
    assert TOKEN not in serialized


@pytest.mark.parametrize(
    ("candidate", "allowed"),
    [
        ("candidate:1 1 UDP 1 192.0.2.2 5000 typ host", False),
        ("candidate:2 1 UDP 1 198.51.100.2 5001 typ srflx", True),
        ("candidate:3 1 UDP 1 203.0.113.2 5002 typ relay", True),
        ("", True),
    ],
)
def test_non_host_candidate_filter(candidate: str, allowed: bool) -> None:
    assert non_host_ice_candidate(candidate) is allowed


def test_ready_payload_is_lane_specific_and_never_serializes_session_secrets() -> None:
    payload = build_ready_payload(
        lane="turn",
        app_id="aurora-interop",
        room="room-name",
        broker_url="ws://127.0.0.1:9001/mqtt",
        stun_servers=[],
        turn_servers=["turn:127.0.0.1:3478"],
        timeout_seconds=12.5,
        gateway_http_reachable=False,
        ready_at="2026-07-26T00:00:00+00:00",
    )
    serialized = json.dumps(payload, sort_keys=True)

    assert payload["forceRelay"] is True
    assert payload["suppressHostCandidates"] is False
    assert payload["timeoutMs"] == 12500
    assert payload["gatewayHttpApiEnabled"] is False
    assert "roomSecret" not in payload
    assert "token" not in serialized.lower()
    assert TOKEN not in serialized


def test_gateway_report_preserves_evidence_and_redacts_credentials() -> None:
    bus = make_bus()
    bus.mutation_counts["mutation-1"] = 1
    bus.mutation_records["mutation-1"] = {"execution_count": 1}
    bus.revoked = True
    bus.requests.append(
        {
            "topic": GatewayMethods.GET_REGISTRY,
            "origin": "browser-g009",
            "correlation_id": "registry-1",
        }
    )
    diagnostics = {
        "started": True,
        "local_signaling_peer_id": "signaling-peer",
        "local_mesh_peer_id": "python-gateway-g009",
        "connected_peer_count": 1,
        "authenticated_peer_count": 1,
        "recent_errors": [],
    }

    report = build_gateway_report(
        lane="direct",
        started_at="2026-07-26T00:00:00+00:00",
        duration_ms=321,
        gateway_http_reachable=False,
        diagnostics=diagnostics,
        bus=bus,
        event_sent=True,
        tts_event_sent=True,
        wrong_correlation_interested=False,
        wildcard_interested=False,
        revoked_reconnect_failures=1,
    )
    serialized = json.dumps(report, sort_keys=True)

    assert report["rtcStarted"] is True
    assert report["authenticatedPeerCount"] == 1
    assert report["mutationCounts"] == {"mutation-1": 1}
    assert report["reconnectEvidence"]["revokedReconnectFailuresObserved"] == 1
    assert report["scopedEventEvidence"] == {
        "wrongCorrelationInterested": False,
        "wildcardInterested": False,
    }
    assert report["secretsRedacted"] is True
    assert TOKEN not in serialized
