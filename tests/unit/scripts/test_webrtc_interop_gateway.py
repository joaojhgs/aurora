"""Focused tests for deterministic pieces of the live WebRTC interop peer."""

from __future__ import annotations

import hashlib
import hmac
import json
import socket

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.mesh.models import PeerState, ProviderLeaseState
from app.services.gateway.mesh.provider_export import (
    LEGACY_MANIFEST_PROTOCOL,
    SUPPORTED_PROTOCOLS,
    GrantEvidence,
    PolicySnapshot,
    ProtocolEvidence,
    RecipientEvidence,
    ServiceExportPolicy,
    project_provider_export,
)
from app.shared.contracts.models.auth import (
    AuthMethods,
    build_mesh_reconnect_proof_message,
)
from app.shared.contracts.models.gateway import GatewayMethods
from app.shared.contracts.models.tooling import ToolingMethods
from scripts.webrtc_interop_gateway import (
    AC18_FORGED_FRAME_PEER_ID,
    AC18_GLOBAL_TOOL_ID,
    AC18_PROVIDER_SERVICE_INSTANCE_ID,
    AC18_SHARED_HARNESS_PERMISSIONS,
    BROWSER_MESH_PEER_ID,
    MUTATE_TOPIC,
    MUTATION_COUNT_TOPIC,
    PYTHON_MESH_PEER_ID,
    REVOKE_TOPIC,
    InteropAuth,
    InteropBus,
    InteropRegistry,
    build_ac18_mesh_config,
    build_gateway_report,
    build_ready_payload,
    can_connect,
    install_ac18_authority_refresh,
    non_host_ice_candidate,
    reserve_gateway_http_probe_port,
    run_ac18_reverse_browser_tool_probe,
)

TOKEN = "g009.test-token-that-must-never-be-reported"


def make_bus() -> InteropBus:
    return InteropBus(InteropRegistry(), TOKEN)


def test_gateway_http_probe_reserves_a_non_listening_port() -> None:
    reservation, port = reserve_gateway_http_probe_port()
    try:
        assert port > 0
        assert can_connect("127.0.0.1", port, timeout=0.05) is False
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as contender, pytest.raises(OSError):
            contender.bind(("127.0.0.1", port))
    finally:
        reservation.close()


def test_registry_response_is_sorted_and_digest_is_stable() -> None:
    registry = InteropRegistry()

    first = registry.registry_response()
    second = registry.registry_response()
    modules = [module.module for module in first.modules]

    assert modules == sorted(modules)
    assert modules == ["Auth", "Config", "G009Interop", "Gateway", "Orchestrator", "TTS"]
    assert first.digest == second.digest
    assert len(first.digest) == 64


def test_registry_snapshot_is_projection_ready_and_matches_harness_policy() -> None:
    registry = InteropRegistry()
    snapshot = registry.snapshot_registry()
    mesh_config = build_ac18_mesh_config(timeout_seconds=12.5)
    policy = PolicySnapshot(
        revision="interop-policy",
        services=tuple(
            ServiceExportPolicy(
                service_id=module,
                share=service_policy.export.share,
                unshared_feature_ids=service_policy.export.unshared_feature_ids,
                unshared_method_ids=service_policy.export.unshared_method_ids,
                max_concurrent=service_policy.export.max_concurrent,
            )
            for module, service_policy in mesh_config.services.items()
        ),
    )
    recipient = RecipientEvidence(
        peer_id=BROWSER_MESH_PEER_ID,
        revision=1,
        grants=tuple(GrantEvidence(permission) for permission in AC18_SHARED_HARNESS_PERMISSIONS),
        state="active",
    )

    projection = project_provider_export(
        provider_peer_id=PYTHON_MESH_PEER_ID,
        registry=snapshot,
        policy=policy,
        recipient=recipient,
        protocol=ProtocolEvidence(),
    )

    assert snapshot.revision.startswith("interop:")
    assert [service.service_id for service in snapshot.services] == [
        "Auth",
        "Config",
        "G009Interop",
        "Gateway",
        "Orchestrator",
        "TTS",
    ]
    auth = next(service for service in snapshot.services if service.service_id == "Auth")
    assert all(method.public_infrastructure for method in auth.methods)
    assert all(
        method.method_type in {"use", "manage"}
        for service in snapshot.services
        for method in service.methods
    )
    assert projection.readiness == "ready"
    assert projection.routable is True
    assert [service.service_id for service in projection.services] == [
        "Config",
        "G009Interop",
        "Gateway",
        "Orchestrator",
        "TTS",
    ]


def test_harness_manifest_declares_the_canonical_legacy_protocol() -> None:
    manifest = InteropRegistry().legacy_manifest(
        "python-gateway-g009",
        "G009 Python Gateway",
    )

    assert manifest["type"] == "manifest"
    assert manifest["active_protocol"] == LEGACY_MANIFEST_PROTOCOL
    assert manifest["active_version"] == "v0"
    assert manifest["active_tier"] == "legacy"
    assert manifest["supported_protocols"] == list(SUPPORTED_PROTOCOLS)
    assert manifest["projection_supported"] is True
    assert manifest["projection_active"] is False
    assert manifest["recipient_projection_evidence"] is None


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
    assert auth.reconnect_proof_results == ["accepted", "proof_mismatch", "revoked"]


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


@pytest.mark.asyncio
async def test_revocation_rejects_pairing_and_bearer_authentication_fallbacks() -> None:
    bus = make_bus()
    auth = InteropAuth(TOKEN, bus)

    await bus.request(REVOKE_TOPIC)

    assert await auth.validate_mesh_pairing_token(token_str=TOKEN) is None
    assert await auth.authenticate_token(TOKEN) is None


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
        ac18_local_tool_provider=True,
        ready_at="2026-07-26T00:00:00+00:00",
    )
    serialized = json.dumps(payload, sort_keys=True)

    assert payload["forceRelay"] is True
    assert payload["suppressHostCandidates"] is False
    assert payload["timeoutMs"] == 12500
    assert payload["gatewayHttpApiEnabled"] is False
    assert payload["ac18LocalToolProvider"] is True
    assert payload["ac18ToolContractId"] == "interop.browser.echo"
    assert payload["ac18ForgedFramePeerId"] == AC18_FORGED_FRAME_PEER_ID
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
        reconnect_proof_results=["accepted", "revoked"],
        manifest_sent=True,
        ac18_local_tool_provider=False,
        ac18_reverse_tool=None,
    )
    serialized = json.dumps(report, sort_keys=True)

    assert report["rtcStarted"] is True
    assert report["authenticatedPeerCount"] == 1
    assert report["mutationCounts"] == {"mutation-1": 1}
    assert report["reconnectEvidence"]["revokedReconnectFailuresObserved"] == 1
    assert report["reconnectEvidence"]["proofVerificationResults"] == [
        "accepted",
        "revoked",
    ]
    assert report["scopedEventEvidence"] == {
        "wrongCorrelationInterested": False,
        "wildcardInterested": False,
    }
    assert report["ac18LocalToolProviderEnabled"] is False
    assert report["ac18ReverseToolEvidence"] == {"enabled": False, "status": "disabled"}
    assert report["secretsRedacted"] is True
    assert TOKEN not in serialized


def test_ac18_mesh_config_shares_harness_services_and_routes_tooling_to_browser() -> None:
    mesh_config = build_ac18_mesh_config(timeout_seconds=12.5)

    assert mesh_config.enabled is True
    assert mesh_config.node_name == "G009 Python Gateway"
    assert mesh_config.stale_peer_timeout_s == 0
    assert mesh_config.remote_timeout_s == 12.5
    assert set(mesh_config.services) == {
        "Config",
        "G009Interop",
        "Gateway",
        "Orchestrator",
        "Tooling",
        "TTS",
    }
    for module in ("Config", "G009Interop", "Gateway", "Orchestrator", "TTS"):
        policy = mesh_config.services[module]
        assert policy.export.share is True
        assert policy.export.unshared_method_ids == ()
        assert policy.routing.prefer == "local"

    tooling_policy = mesh_config.services["Tooling"]
    assert tooling_policy.export.share is False
    assert tooling_policy.routing.prefer == "network"
    assert tooling_policy.routing.fallback == "error"
    assert tooling_policy.routing.allowed_provider_peer_ids == (BROWSER_MESH_PEER_ID,)


@pytest.mark.asyncio
async def test_ac18_authority_refresh_seeds_exact_grants_through_public_rtc_api() -> None:
    class _ApplyResult:
        applied = True

    class _PublicRtcOnly:
        def __init__(self) -> None:
            self.callback = None
            self.applied_events: list[object] = []

        def set_authority_refresh_callback(self, callback):
            self.callback = callback

        def apply_trusted_peer_authority_snapshot(self, snapshot):
            self.applied_events.append(snapshot)
            return _ApplyResult()

    rtc = _PublicRtcOnly()

    install_ac18_authority_refresh(rtc)

    assert rtc.callback is not None
    assert await rtc.callback(BROWSER_MESH_PEER_ID) is True
    assert await rtc.callback(BROWSER_MESH_PEER_ID) is True
    assert await rtc.callback("unrelated-peer") is False
    authority_snapshot = rtc.applied_events[0]
    assert len(rtc.applied_events) == 2
    assert authority_snapshot.peer_id == BROWSER_MESH_PEER_ID
    assert authority_snapshot.auth_grant_revision == 1
    assert authority_snapshot.disposition == "present"
    assert authority_snapshot.state == "active"
    assert authority_snapshot.effective_permissions == AC18_SHARED_HARNESS_PERMISSIONS


class _Ac18ReadyRegistry:
    def __init__(self) -> None:
        self.peer = PeerState(peer_id=BROWSER_MESH_PEER_ID, status="negotiated")
        self.lease = ProviderLeaseState(
            peer_id=BROWSER_MESH_PEER_ID,
            connection_epoch="epoch-1",
            availability_revision=1,
            issued_at_ms=1,
            expires_at_ms=60_000,
            available=True,
            lease_required=True,
        )

    def get_peer(self, peer_id: str) -> PeerState | None:
        return self.peer if peer_id == BROWSER_MESH_PEER_ID else None

    def get_provider_lease(self, peer_id: str) -> ProviderLeaseState | None:
        return self.lease if peer_id == BROWSER_MESH_PEER_ID else None

    def get_peer_service(self, peer_id: str, module: str) -> object | None:
        return object() if peer_id == BROWSER_MESH_PEER_ID and module == "Tooling" else None


class _RecordingPeerBridge:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, object]]] = []
        self.call_options: list[dict[str, object]] = []
        self.schema_hash = "a" * 64

    async def call(
        self,
        peer_id: str,
        topic: str,
        payload: dict[str, object],
        **options: object,
    ) -> QueryResult:
        self.calls.append((peer_id, topic, payload))
        self.call_options.append(options)
        if topic == ToolingMethods.GET_TOOLS:
            return QueryResult(
                ok=True,
                data={
                    "tools": [
                        {
                            "tool_contract_id": "interop.browser.echo",
                            "local_name": "interop.browser.echo",
                            "name": "interop.browser.echo",
                            "global_tool_id": AC18_GLOBAL_TOOL_ID,
                            "provider_peer_id": BROWSER_MESH_PEER_ID,
                            "provider_service_instance_id": (AC18_PROVIDER_SERVICE_INSTANCE_ID),
                        }
                    ],
                    "count": 1,
                },
            )
        if topic == ToolingMethods.PREPARE_EXECUTION:
            return QueryResult(
                ok=True,
                data={
                    "ok": True,
                    "policy_decision": {"allowed": True},
                    "args_schema_hash": self.schema_hash,
                    "global_tool_id": AC18_GLOBAL_TOOL_ID,
                    "local_tool_name": "interop.browser.echo",
                    "provider_peer_id": BROWSER_MESH_PEER_ID,
                    "provider_service_instance_id": (AC18_PROVIDER_SERVICE_INSTANCE_ID),
                },
            )
        if payload.get("tool_name") == "interop.browser.echo.missing":
            return QueryResult(
                ok=True,
                data={
                    "ok": False,
                    "status": "not_found",
                    "error_code": "tool_not_found",
                    "global_tool_id": payload["tool_name"],
                },
            )
        return QueryResult(
            ok=True,
            data={
                "ok": True,
                "status": "success",
                "global_tool_id": AC18_GLOBAL_TOOL_ID,
                "data": {
                    "probe_id": "ac18-browser-tool-direct",
                    "message": "python-originated-direct:browser-local",
                    "handled_by": BROWSER_MESH_PEER_ID,
                    "caller_peer_id": PYTHON_MESH_PEER_ID,
                },
            },
        )


@pytest.mark.asyncio
async def test_ac18_browser_tool_probe_discovers_prepares_executes_and_fails_closed() -> None:
    bridge = _RecordingPeerBridge()

    evidence = await run_ac18_reverse_browser_tool_probe(
        lane="direct",
        peer_registry=_Ac18ReadyRegistry(),  # type: ignore[arg-type]
        peer_bridge=bridge,  # type: ignore[arg-type]
        timeout=1,
    )

    assert evidence["status"] == "passed"
    assert [topic for _, topic, _ in bridge.calls] == [
        ToolingMethods.GET_TOOLS,
        ToolingMethods.PREPARE_EXECUTION,
        ToolingMethods.EXECUTE_TOOL,
        ToolingMethods.EXECUTE_TOOL,
    ]
    discovery_payload = bridge.calls[0][2]
    prepare_payload = bridge.calls[1][2]
    execute_payload = bridge.calls[2][2]
    assert discovery_payload == {"query": "interop.browser.echo", "top_k": 10}
    assert prepare_payload["tool_name"] == AC18_GLOBAL_TOOL_ID
    assert "expected_args_schema_hash" not in prepare_payload
    assert execute_payload["tool_name"] == AC18_GLOBAL_TOOL_ID
    assert execute_payload["expected_args_schema_hash"] == bridge.schema_hash
    assert all(
        options["caller_peer_id"] == AC18_FORGED_FRAME_PEER_ID and options["effective_perms"] == []
        for options in bridge.call_options
    )
    assert evidence["publicCallCount"] == 4
    assert evidence["publicCallMethods"] == [
        ToolingMethods.GET_TOOLS,
        ToolingMethods.PREPARE_EXECUTION,
        ToolingMethods.EXECUTE_TOOL,
        ToolingMethods.EXECUTE_TOOL,
    ]
    assert evidence["discoveryProbe"]["toolFound"] is True
    assert evidence["prepareProbe"]["schemaHashBoundToExecution"] is True
    assert evidence["executeProbe"]["expectedArgsSchemaHash"] == bridge.schema_hash
    assert evidence["identityOverride"]["frameCallerPeerIdOverridden"] is True
    assert evidence["identityOverride"]["observedCallerPeerId"] == PYTHON_MESH_PEER_ID
    assert evidence["negativeProbe"]["failClosedWithoutHandler"] is True
