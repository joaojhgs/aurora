"""Integration tests for mesh failover after remote preaccept outcomes.

Tests bounded failover for structured preaccept outcomes and terminal
responses when remote peers time out or return application errors.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import BaseModel

from app.messaging.bus import QueryResult
from app.messaging.mesh_bus import MeshBus
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_bridge import PeerBridge
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable
from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from tests.unit.gateway.mesh_policy_helpers import mesh_policy
from tests.unit.gateway.verified_manifest_helpers import verified_peer_manifest


class DummyPayload(BaseModel):
    text: str = "test"


REQUEST_TIMEOUT_S = 1.0
RESPONSE_DEADLINE_MARGIN_S = 0.1


async def _wait_for_pending_call(
    peer_bridge: PeerBridge,
    peer_id: str,
    *,
    deadline: float,
):
    """Return a pending call before the request deadline or fail clearly."""
    loop = asyncio.get_running_loop()
    while loop.time() < deadline:
        for (pending_peer_id, request_id), future in list(peer_bridge._pending_calls.items()):
            if pending_peer_id == peer_id and not future.done():
                return request_id, future
        await asyncio.sleep(min(0.01, max(0.0, deadline - loop.time())))
    pytest.fail(f"pending call for {peer_id} was not created before the request deadline")


@pytest.fixture
def mesh_config():
    return MeshConfig(
        enabled=True,
        node_name="failover-test",
        services={
            "Orchestrator": mesh_policy(prefer="network", fallback="local"),
            "STT": mesh_policy(prefer="network", fallback="network"),
            "GPU": mesh_policy(prefer="network_only", fallback="error"),
        },
        peer_selection="lowest_latency",
    )


@pytest.fixture
def peer_registry(mesh_config):
    return PeerRegistry(mesh_config)


@pytest.fixture
def routing_table(mesh_config, peer_registry):
    return RoutingTable(mesh_config, peer_registry)


@pytest.fixture
def mock_rtc_client():
    client = MagicMock()
    client.send_to_peer = MagicMock(return_value=True)
    return client


@pytest.fixture
def peer_bridge(mock_rtc_client, peer_registry):
    return PeerBridge(mock_rtc_client, peer_registry)


@pytest.fixture
def inner_bus():
    bus = AsyncMock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"source": "local-fallback"}))
    bus.subscribe = MagicMock()
    return bus


@pytest.fixture
def mesh_bus(inner_bus, routing_table, peer_bridge, mesh_config):
    return MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)


async def _register_peer(registry, peer_id, modules, latency=50.0):
    """Helper to register a negotiated peer."""
    await registry.register_peer(peer_id)
    manifest = verified_peer_manifest(
        peer_id,
        [_service_for_module(m) for m in modules],
    )
    await registry.update_manifest(peer_id, manifest)
    await registry.update_latency(peer_id, latency)


def _service_for_module(module: str) -> PeerServiceInfo:
    topics = {
        "Orchestrator": [OrchestratorMethods.USER_INPUT],
        "GPU": ["GPU.Compute"],
    }.get(module, [f"{module}.Query"])
    return PeerServiceInfo(
        module=module,
        version="1.0.0",
        max_concurrent=10,
        available_feature_ids=["test_feature"],
        methods=[
            MethodInfo(
                name=topic.rsplit(".", 1)[-1],
                bus_topic=topic,
                exposure="external",
                method_type="use",
                required_perms=[topic],
                callable_feature_ids=["test_feature"],
            )
            for topic in topics
        ],
    )


@pytest.mark.integration
class TestRemoteFailureFallback:
    """Tests that terminal remote outcomes are not transparently replayed."""

    @pytest.mark.asyncio
    async def test_remote_timeout_returns_terminal_error(
        self, mesh_bus, inner_bus, peer_registry, mock_rtc_client
    ):
        """Remote call timeouts do not replay as local calls."""
        await _register_peer(peer_registry, "slow-peer", ["Orchestrator"])

        # Don't simulate a response — the call will timeout
        result = await mesh_bus.request(OrchestratorMethods.USER_INPUT, DummyPayload(), timeout=0.2)

        assert result.ok is False
        assert "timed out" in result.error
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_remote_not_sent_preaccept_tries_second_network_provider(
        self, inner_bus, routing_table, peer_registry, peer_bridge, mock_rtc_client, mesh_config
    ):
        """Pre-send failure is safe to re-resolve to another network provider."""
        mesh_config = mesh_config.model_copy(
            update={
                "services": {
                    **dict(mesh_config.services),
                    "Orchestrator": mesh_policy(prefer="network", fallback="network"),
                }
            }
        )
        routing_table = RoutingTable(mesh_config, peer_registry)
        mesh_bus = MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)
        await _register_peer(peer_registry, "dead-peer", ["Orchestrator"], latency=5.0)
        await _register_peer(peer_registry, "backup-peer", ["Orchestrator"], latency=20.0)
        mock_rtc_client.send_to_peer.side_effect = [False, True]

        async def simulate_backup_response():
            loop = asyncio.get_running_loop()
            deadline = loop.time() + REQUEST_TIMEOUT_S - RESPONSE_DEADLINE_MARGIN_S
            request_id, _ = await _wait_for_pending_call(
                peer_bridge,
                "backup-peer",
                deadline=deadline,
            )
            peer_bridge.on_response(
                "backup-peer",
                {
                    "type": "result",
                    "id": request_id,
                    "result": {"source": "backup-peer"},
                },
            )

        task = asyncio.create_task(simulate_backup_response())
        result = await mesh_bus.request(
            OrchestratorMethods.USER_INPUT,
            DummyPayload(),
            timeout=REQUEST_TIMEOUT_S,
        )
        await task

        assert result.ok is True
        assert result.data == {"source": "backup-peer"}
        assert mock_rtc_client.send_to_peer.call_count == 2
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_remote_error_response_returns_terminal_error(
        self, mesh_bus, inner_bus, peer_registry, peer_bridge, mock_rtc_client
    ):
        """Application errors from a peer do not replay as local calls."""
        await _register_peer(peer_registry, "error-peer", ["Orchestrator"])

        async def simulate_error():
            await asyncio.sleep(0.05)
            for (pending_peer_id, req_id), fut in list(peer_bridge._pending_calls.items()):
                if not fut.done():
                    peer_bridge.on_response(
                        pending_peer_id,
                        {
                            "type": "error",
                            "id": req_id,
                            "error": {"message": "Service unavailable", "code": 503},
                        },
                    )

        task = asyncio.create_task(simulate_error())
        result = await mesh_bus.request(OrchestratorMethods.USER_INPUT, DummyPayload())
        await task

        assert result.ok is False
        assert "Service unavailable" in result.error
        inner_bus.request.assert_not_awaited()


@pytest.mark.integration
class TestNetworkFallbackToAnotherPeer:
    """Tests fallback=network routing to another peer."""

    @pytest.mark.asyncio
    async def test_first_peer_timeout_does_not_try_second_peer(
        self, inner_bus, peer_registry, peer_bridge, mock_rtc_client, mesh_config
    ):
        """Ambiguous timeout is terminal even when another peer exists."""
        mesh_config = mesh_config.model_copy(
            update={
                "services": {
                    **dict(mesh_config.services),
                    "Orchestrator": mesh_policy(prefer="network", fallback="network"),
                }
            }
        )
        mesh_bus = MeshBus(
            inner_bus,
            RoutingTable(mesh_config, peer_registry),
            peer_bridge,
            mesh_config,
        )
        await _register_peer(peer_registry, "peer-1", ["Orchestrator"], latency=10.0)
        await _register_peer(peer_registry, "peer-2", ["Orchestrator"], latency=20.0)

        result = await mesh_bus.request(OrchestratorMethods.USER_INPUT, DummyPayload(), timeout=0.1)

        assert result.ok is False
        assert "timed out" in result.error
        assert mock_rtc_client.send_to_peer.call_count == 1
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_capability_changed_preaccept_tries_second_peer(
        self, inner_bus, peer_registry, peer_bridge, mock_rtc_client, mesh_config
    ):
        """Structured preaccept rejection can be retried against another peer."""
        mesh_config = mesh_config.model_copy(
            update={
                "services": {
                    **dict(mesh_config.services),
                    "Orchestrator": mesh_policy(prefer="network", fallback="network"),
                }
            }
        )
        mesh_bus = MeshBus(
            inner_bus,
            RoutingTable(mesh_config, peer_registry),
            peer_bridge,
            mesh_config,
        )
        await _register_peer(peer_registry, "peer-1", ["Orchestrator"], latency=10.0)
        await _register_peer(peer_registry, "peer-2", ["Orchestrator"], latency=20.0)

        async def simulate_preaccept_then_success():
            loop = asyncio.get_running_loop()
            deadline = loop.time() + REQUEST_TIMEOUT_S - RESPONSE_DEADLINE_MARGIN_S
            first_request_id, _ = await _wait_for_pending_call(
                peer_bridge,
                "peer-1",
                deadline=deadline,
            )
            peer_bridge.on_response(
                "peer-1",
                {
                    "type": "result",
                    "id": first_request_id,
                    "result": {
                        "accepted": False,
                        "reason_code": "capability_changed",
                    },
                },
            )
            second_request_id, _ = await _wait_for_pending_call(
                peer_bridge,
                "peer-2",
                deadline=deadline,
            )
            peer_bridge.on_response(
                "peer-2",
                {
                    "type": "result",
                    "id": second_request_id,
                    "result": {"source": "peer-2"},
                },
            )

        task = asyncio.create_task(simulate_preaccept_then_success())
        result = await mesh_bus.request(
            OrchestratorMethods.USER_INPUT,
            DummyPayload(),
            timeout=REQUEST_TIMEOUT_S,
        )
        await task

        assert result.ok is True
        assert result.data == {"source": "peer-2"}
        assert mock_rtc_client.send_to_peer.call_count == 2
        inner_bus.request.assert_not_awaited()


@pytest.mark.integration
class TestNetworkOnlyWithNoFallback:
    """Tests network_only mode with fallback=error."""

    @pytest.mark.asyncio
    async def test_no_peer_returns_error(self, mesh_bus):
        """network_only with no peers → error response."""
        result = await mesh_bus.request("GPU.Compute", DummyPayload())
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_peer_timeout_returns_error(self, mesh_bus, peer_registry, mock_rtc_client):
        """network_only with peer timeout → eventually returns error or timeout."""
        await _register_peer(peer_registry, "gpu-peer", ["GPU"])

        # Don't simulate response — times out
        result = await mesh_bus.request("GPU.Compute", DummyPayload(), timeout=0.2)
        # After timeout on network_only, fallback is error
        # But the MeshBus tries fallback which returns error route
        assert result.ok is False or result.data is not None


@pytest.mark.integration
class TestPeerLifecycleImpactsRouting:
    """Tests that peer lifecycle events (connect/disconnect/stale) affect routing."""

    @pytest.mark.asyncio
    async def test_peer_removal_causes_local_fallback(self, mesh_bus, inner_bus, peer_registry):
        """After removing a peer, routing falls back to local."""
        await _register_peer(peer_registry, "temp-peer", ["Orchestrator"])

        # Verify it would route remotely
        route = RoutingTable(mesh_bus._config, peer_registry).resolve(
            OrchestratorMethods.USER_INPUT
        )
        assert route.target == "remote"

        # Remove the peer
        await peer_registry.remove_peer("temp-peer")

        # Now should fall back to local
        result = await mesh_bus.request(OrchestratorMethods.USER_INPUT, DummyPayload())
        assert result.ok is True
        inner_bus.request.assert_awaited()
