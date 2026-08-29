"""Unit tests for Gateway mesh diagnostics."""

from collections import deque
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.gateway.acl.identity import Identity
from app.services.gateway.config import MeshConfig, Settings
from app.services.gateway.mesh.models import (
    ManifestAck,
    ManifestServiceCompatibility,
    PeerManifest,
    PeerServiceInfo,
)
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable
from app.services.gateway.service import GatewayService, _exact_service_routing_summary
from app.services.gateway.webrtc.rtc_client import RTCClient
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.gateway import MethodInfo, WebRTCDiagnosticError
from tests.unit.gateway.mesh_policy_helpers import mesh_policy
from tests.unit.gateway.verified_manifest_helpers import verified_peer_manifest


def _service_with_settings(settings: Settings) -> GatewayService:
    service = GatewayService()
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._mesh_policy_store.replace(settings.mesh)
    return service


def _peer_service(module: str, version: str = "1.2.0", max_concurrent: int = 4):
    return PeerServiceInfo(
        module=module,
        version=version,
        capabilities=["tools", "basic"],
        available_feature_ids=["basic_feature"],
        methods=[
            MethodInfo(
                name="Execute",
                summary="execute",
                bus_topic=f"{module}.Execute",
                exposure="external",
                required_perms=[f"{module}.Execute"],
            )
        ],
        max_concurrent=max_concurrent,
        digest=f"digest-{module}",
    )


def test_routing_summary_aggregates_every_real_exact_method_without_fabrication():
    mesh_config = MeshConfig(services={"Tooling": mesh_policy(prefer="network")})
    policy_service = _peer_service("Tooling")
    policy_service.methods.append(
        MethodInfo(
            name="List",
            bus_topic="Tooling.List",
            exposure="external",
            required_perms=["Tooling.GetTools"],
        )
    )
    peer = SimpleNamespace(
        peer_id="peer-a",
        manifest=PeerManifest(peer_id="peer-a", shared_services=[policy_service]),
    )
    registry = SimpleNamespace(
        get_all_peers=lambda: [peer],
        evaluate_provider_for_topic=lambda **kwargs: SimpleNamespace(
            eligible=kwargs["topic"] == "Tooling.List",
            reason_code=("eligible" if kwargs["topic"] == "Tooling.List" else "permission_denied"),
        ),
    )
    service = _service_with_settings(Settings(mesh=mesh_config))

    summary = _exact_service_routing_summary(
        module="Tooling",
        mesh_config=mesh_config,
        registry=registry,
        policy_snapshot=service._mesh_policy_store.current(),
    )

    assert summary.eligible_provider_ids == ["peer-a"]
    assert summary.ineligible_provider_ids == []
    assert summary.reason_codes == ["permission_denied"]


@pytest.mark.asyncio
async def test_mesh_status_reports_disabled_state_without_components():
    service = _service_with_settings(Settings(mesh=MeshConfig(enabled=False, node_name="local")))

    response = await service.get_mesh_status(EmptyInput())

    assert response.local.mesh_enabled is False
    assert response.local.mesh_started is False
    assert response.local.webrtc_started is False
    assert response.local.node_name == "local"
    assert response.peers == []
    assert response.routes == []
    assert response.secrets_redacted is True


@pytest.mark.asyncio
async def test_mesh_status_reports_route_provider_capacity_and_compatibility():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={
            "Tooling": mesh_policy(
                share=True,
                prefer="network",
                fallback="local",
                min_version="1.0.0",
                required_capabilities=["tools"],
            ),
            "DB": mesh_policy(prefer="network_only", fallback="error"),
        },
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)

    await registry.register_peer("peer-old", "old-node")
    await registry.update_manifest(
        "peer-old",
        verified_peer_manifest(
            "peer-old",
            [_peer_service("Tooling", version="0.9.0")],
            node_name="old-node",
        ),
    )
    await registry.update_latency("peer-old", 10.0)

    await registry.register_peer("peer-good", "good-node")
    await registry.update_manifest(
        "peer-good",
        verified_peer_manifest(
            "peer-good",
            [_peer_service("Tooling", version="1.2.0", max_concurrent=4)],
            node_name="good-node",
        ),
    )
    await registry.update_latency("peer-good", 25.0)
    await registry.increment_active_calls("peer-good")
    await registry.update_manifest_ack(
        "peer-good",
        ManifestAck(
            incompatible_services=["DB"],
            compatible_services=["Tooling"],
            active_protocol="projection-v1",
            active_version="v1",
            active_tier="projection",
            protocol_revision="v1",
            registry_revision="registry-remote",
            export_policy_revision="export-remote",
            auth_grant_revision=3,
            services=[
                ManifestServiceCompatibility(
                    service_id="DB",
                    status="incompatible",
                    reason_codes=["permission_denied"],
                    reason="",
                ),
                ManifestServiceCompatibility(
                    service_id="Tooling",
                    status="compatible",
                    reason_codes=[],
                ),
            ],
        ),
    )

    service = _service_with_settings(Settings(mesh=mesh_config))
    service._mesh_peer_registry = registry
    service._mesh_routing_table = routing_table
    service._mesh_bus = object()
    service._rtc_client = object()
    service._mesh_peer_id = "local-peer"

    response = await service.get_mesh_status(EmptyInput())

    assert response.local.mesh_enabled is True
    assert response.local.mesh_started is True
    assert response.local.webrtc_started is True
    assert response.local.peer_id == "local-peer"
    assert response.local.shared_modules == ["Tooling"]
    assert response.local.routed_modules == ["DB", "Tooling"]
    exports = {item.service_id: item for item in response.export_summaries}
    assert exports["Tooling"].shared is True
    assert exports["DB"].reason_codes == ["service_not_shared"]
    routing = {item.service_id: item for item in response.routing_summaries}
    assert routing["Tooling"].eligible_provider_ids == ["peer-good"]
    assert "incompatible_version" in routing["Tooling"].reason_codes

    tooling_route = next(route for route in response.routes if route.module == "Tooling")
    assert tooling_route.decision_target == "remote"
    assert tooling_route.decision_peer_id == "peer-good"
    assert tooling_route.reason == "selected peer peer-good using lowest_latency policy"

    providers = {provider.peer_id: provider for provider in tooling_route.providers}
    assert providers["peer-good"].eligible is True
    assert providers["peer-good"].reason_code == "eligible"
    assert providers["peer-good"].active_calls == 1
    assert providers["peer-good"].max_concurrent == 4
    assert providers["peer-old"].eligible is False
    assert providers["peer-old"].reason_code == "incompatible_version"
    assert "does not satisfy" in providers["peer-old"].reason

    good_peer = next(peer for peer in response.peers if peer.peer_id == "peer-good")
    tooling = next(svc for svc in good_peer.services if svc.module == "Tooling")
    assert tooling.available_capacity == 3
    assert tooling.active_calls == 1
    assert tooling.method_names == ["Execute"]
    assert good_peer.compatibility.remote_incompatible == ["DB"]
    assert good_peer.compatibility.local_revision.protocol_revision == "v1"
    assert good_peer.compatibility.remote_revision.export_policy_revision == "export-remote"
    remote_db = next(
        item for item in good_peer.compatibility.remote_services if item.service_id == "DB"
    )
    assert remote_db.reason_codes == ["permission_denied"]
    assert remote_db.reason == "service is ineligible: permission_denied"

    failures = {
        (failure.peer_id, failure.module, failure.direction)
        for failure in response.compatibility_failures
    }
    assert ("peer-old", "Tooling", "local_view_of_remote") in failures
    assert ("peer-good", "DB", "remote_view_of_local") in failures
    remote_failure = next(
        failure
        for failure in response.compatibility_failures
        if failure.peer_id == "peer-good" and failure.module == "DB"
    )
    assert remote_failure.reason_code == "permission_denied"


@pytest.mark.asyncio
async def test_mesh_status_reports_transient_provider_unavailability():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={"Tooling": mesh_policy(prefer="network", fallback="local")},
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)
    await registry.register_peer("peer-mobile", "mobile-node")
    await registry.update_manifest(
        "peer-mobile",
        verified_peer_manifest(
            "peer-mobile",
            [_peer_service("Tooling")],
            node_name="mobile-node",
        ),
    )
    registry.get_peer("peer-mobile").status = "provider_unavailable"

    service = _service_with_settings(Settings(mesh=mesh_config))
    service._mesh_peer_registry = registry
    service._mesh_routing_table = routing_table
    service._mesh_bus = object()
    service._rtc_client = object()
    service._mesh_peer_id = "local-peer"

    response = await service.get_mesh_status(EmptyInput())

    routing = {item.service_id: item for item in response.routing_summaries}
    assert routing["Tooling"].eligible_provider_ids == []
    assert routing["Tooling"].ineligible_provider_ids == ["peer-mobile"]
    assert routing["Tooling"].reason_codes == ["provider_unavailable"]


@pytest.mark.asyncio
async def test_mesh_status_output_does_not_include_secret_field_names():
    mesh_config = MeshConfig(enabled=True, node_name="local")
    service = _service_with_settings(Settings(mesh=mesh_config))

    response = await service.get_mesh_status(EmptyInput())
    payload = response.model_dump_json().lower()

    assert "password" not in payload
    assert "token" not in payload
    assert "api_key" not in payload
    assert response.secrets_redacted is True


@pytest.mark.asyncio
async def test_webrtc_diagnostics_reports_disabled_state_without_client():
    settings = Settings(mesh=MeshConfig(enabled=True, node_name="local-node"))
    settings.webrtc.enabled = False
    settings.api.auth_enabled = True
    service = _service_with_settings(settings)
    service._mesh_peer_id = "local-peer"

    response = await service.get_webrtc_diagnostics(EmptyInput())

    assert response.enabled is False
    assert response.started is False
    assert response.mesh_enabled is True
    assert response.local_mesh_peer_id == "local-peer"
    assert response.local_node_name == "local-node"
    assert response.require_auth is True
    assert response.peers == []
    assert response.secrets_redacted is True


@pytest.mark.asyncio
async def test_rtc_client_diagnostics_reports_ice_channel_auth_and_redacts_errors():
    settings = Settings(mesh=MeshConfig(enabled=True, node_name="local-node"))
    settings.webrtc.enabled = True
    settings.webrtc.enable_app_layer_e2ee = True
    settings.signaling_mqtt.brokers = ["wss://broker.emqx.io:8084/mqtt"]
    registry = PeerRegistry(settings.mesh)
    await registry.register_peer("stable-peer", "remote-node")
    await registry.update_latency("stable-peer", 42.5)

    client = RTCClient.__new__(RTCClient)
    client._settings = settings
    client._require_auth = True
    client._peer_id = "signaling-local"
    client._mesh_peer_id = "local-peer"
    client._mesh_node_name = "local-node"
    client._adapter = object()
    client._pcs = {
        "session-peer": SimpleNamespace(
            connectionState="connected",
            iceConnectionState="completed",
            iceGatheringState="complete",
            signalingState="stable",
        )
    }
    identity = Identity(
        principal_id="principal-1",
        principal_name="remote",
        is_admin=False,
        permissions=frozenset({"Gateway.manage"}),
        effective_perms=frozenset({"Gateway.manage"}),
        source="webrtc_peer",
    )
    client._peer_acl = {"session-peer": identity, "stable-peer": identity}
    client._peer_tokens = {}
    client._peer_timeout_tasks = {"session-peer": object()}
    client._auth_timeout = 10.0
    client._peer_pairing_active = {"session-peer"}
    client._pairing_timeout = 300.0
    client._saved_auth_tokens = {"stable-peer": "secret-token"}
    client._on_token_saved = None
    client._pending_rpc = {"rpc-1": object()}
    client._pairing_tasks = {"session-peer": object()}
    client._mesh_enabled = True
    client._mesh_config = settings.mesh
    client._peer_registry = registry
    client._peer_bridge = None
    client._peer_send_fns = {"session-peer": lambda text: None}
    client._peer_data_channels = {
        "session-peer": SimpleNamespace(readyState="open", label="aurora-rpc")
    }
    client._peer_stable_ids = {"session-peer": "stable-peer"}
    client._stable_peer_sessions = {"stable-peer": "session-peer"}
    client._peer_names = {"stable-peer": "remote-node"}
    client._peer_claimed_stable_ids = {}
    client._peer_claimed_names = {}
    client._pairing_results = {}
    client._diagnostic_errors = deque(
        [
            WebRTCDiagnosticError(
                timestamp=datetime.now(timezone.utc).isoformat(),
                code="auth_failed",
                message="redacted diagnostic event",
                peer_id="session-peer",
            )
        ],
        maxlen=50,
    )

    response = client.get_diagnostics()
    payload = response.model_dump_json()

    assert response.enabled is True
    assert response.started is True
    assert response.mesh_enabled is True
    assert response.local_signaling_peer_id == "signaling-local"
    assert response.local_mesh_peer_id == "local-peer"
    assert response.app_layer_e2ee_enabled is True
    assert response.signaling.connected is True
    assert response.signaling.public_broker_warning is True
    assert response.connected_peer_count == 1
    assert response.authenticated_peer_count == 1
    assert response.pairing_peer_count == 1
    assert response.pending_rpc_count == 1

    peer = response.peers[0]
    assert peer.signaling_peer_id == "session-peer"
    assert peer.stable_peer_id == "stable-peer"
    assert peer.connection_state == "connected"
    assert peer.ice_connection_state == "completed"
    assert peer.ice_gathering_state == "complete"
    assert peer.signaling_state == "stable"
    assert peer.data_channel_state == "open"
    assert peer.has_send_channel is True
    assert peer.rtt_ms == 42.5
    assert peer.auth_state == "authenticated"
    assert peer.effective_permission_count == 1
    assert peer.pairing_active is True
    assert peer.auth_timeout_pending is True
    assert peer.pending_pairing_task is True

    assert "secret-token" not in payload
    assert "password" not in payload.lower()
    assert response.secrets_redacted is True

    assert client._has_authenticated_stable_peer("stable-peer") is True
    client._peer_data_channels["session-peer"].readyState = "closed"
    stale_response = client.get_diagnostics()
    assert len(stale_response.peers) == 1
    assert stale_response.peers[0].connection_state == "connected"
    assert stale_response.peers[0].data_channel_state == "closed"
    assert stale_response.connected_peer_count == 0
    assert stale_response.authenticated_peer_count == 0
    assert client._has_authenticated_stable_peer("stable-peer") is False


def test_webrtc_diagnostic_errors_redact_sdp_ice_audio_and_secret_material() -> None:
    client = RTCClient.__new__(RTCClient)
    client._diagnostic_errors = deque(maxlen=50)

    sensitive_messages = [
        "token bearer leaked",
        "room secret leaked",
        "SDP offer v=0\\r\\no=- 46117326 2 IN IP4 127.0.0.1\\r\\na=fingerprint:sha-256 AA:BB",
        "ICE candidate candidate:842163049 1 udp 1677729535 203.0.113.5 3478 typ srflx",
        "raw audio bytes UklGRg== captured",
    ]
    for index, message in enumerate(sensitive_messages):
        client._record_diagnostic_error(f"sensitive_{index}", message, "session-peer")

    payload = "\n".join(error.message.lower() for error in client._diagnostic_errors)
    assert "token" not in payload
    assert "secret" not in payload
    assert "sdp" not in payload
    assert "v=0" not in payload
    assert "fingerprint" not in payload
    assert "candidate:" not in payload
    assert "203.0.113.5" not in payload
    assert "raw audio" not in payload
    assert "uklgrg" not in payload


def test_webrtc_diagnostic_redaction_preserves_safe_state_for_embedded_json() -> None:
    client = RTCClient.__new__(RTCClient)
    client._diagnostic_errors = deque(maxlen=50)

    client._record_diagnostic_error(
        "ice_failed",
        'ICE failed state=checking payload={"state":"failed","roomToken":"abc123",'
        '"candidate":"candidate:1 1 udp 1 198.51.100.9 9 typ host",'
        '"fingerprint":"AA:BB:CC"}',
        "session-peer",
    )

    message = client._diagnostic_errors[0].message.lower()
    assert "ice failed" in message
    assert "state=checking" in message
    assert "abc123" not in message
    assert "roomtoken" not in message
    assert "candidate:" not in message
    assert "198.51.100.9" not in message
    assert "fingerprint" not in message


def test_webrtc_diagnostic_redaction_handles_mixed_case_multiline_and_bounded_output() -> None:
    client = RTCClient.__new__(RTCClient)
    client._diagnostic_errors = deque(maxlen=50)
    long_tail = " safe-state" * 2000

    client._record_diagnostic_error(
        "mixed_sensitive",
        "Connection failed STATE=FAILED\n"
        "A=FINGERPRINT:sha-256 AA:BB:CC\n"
        "a=ICE-PWD:super-secret\n"
        "RAW AUDIO BYTES UklGRg== captured\n"
        f"retryable status remains{long_tail}",
        "session-peer",
    )

    message = client._diagnostic_errors[0].message.lower()
    assert len(client._diagnostic_errors[0].message) <= 240
    assert "connection failed" in message
    assert "state=failed" in message
    assert "retryable status remains" in message
    assert "fingerprint" not in message
    assert "ice-pwd" not in message
    assert "super-secret" not in message
    assert "raw audio" not in message
    assert "uklgrg" not in message
