"""Deterministic mesh chaos/failure-mode coverage.

These tests exercise degraded distributed-system behavior with local fakes:
no MQTT broker, WebRTC transport, Redis, Docker, or live peers are required.
"""

from __future__ import annotations

import json
from collections import deque
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import BaseModel

from app.messaging.bus import QueryResult
from app.messaging.mesh_bus import MeshBus
from app.services.gateway.acl.identity import Identity
from app.services.gateway.config import MeshConfig, MeshServiceConfig
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable
from app.services.gateway.webrtc.rpc import RPCHandler
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.contracts.models.tts import TTSMethods


class ChaosPayload(BaseModel):
    text: str = "chaos"
    mesh_selector: MeshAddressSelector | None = None


class ScriptedPeerBridge:
    """PeerBridge-compatible fake with deterministic per-call outcomes."""

    def __init__(self, outcomes: dict[str, list[Any]] | None = None) -> None:
        self._outcomes = {
            peer_id: deque(peer_outcomes) for peer_id, peer_outcomes in (outcomes or {}).items()
        }
        self.calls: list[tuple[str, str, str | None]] = []
        self.forwarded_events: list[tuple[str, str, str | None]] = []

    async def call(
        self,
        peer_id: str,
        method: str,
        params: BaseModel,
        *,
        timeout: float,
        correlation_id: str | None = None,
    ) -> QueryResult:
        self.calls.append((peer_id, method, correlation_id))
        outcomes = self._outcomes.get(peer_id)
        outcome = outcomes.popleft() if outcomes else QueryResult(ok=True, data={"peer": peer_id})
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def fire_event(
        self,
        peer_id: str,
        topic: str,
        payload: BaseModel,
        *,
        correlation_id: str | None = None,
    ) -> None:
        self.forwarded_events.append((peer_id, topic, correlation_id))


@pytest.fixture
def mesh_config() -> MeshConfig:
    return MeshConfig(
        enabled=True,
        node_name="chaos-local",
        services={
            "Orchestrator": MeshServiceConfig(prefer="network", fallback="local"),
            "STT": MeshServiceConfig(prefer="network", fallback="network"),
            "Tooling": MeshServiceConfig(prefer="network_only", fallback="error"),
            "TTS": MeshServiceConfig(share=True, prefer="local", fallback="local"),
        },
        peer_selection="lowest_latency",
        stale_peer_timeout_s=120.0,
    )


@pytest.fixture
def peer_registry(mesh_config: MeshConfig) -> PeerRegistry:
    return PeerRegistry(mesh_config)


@pytest.fixture
def routing_table(mesh_config: MeshConfig, peer_registry: PeerRegistry) -> RoutingTable:
    return RoutingTable(mesh_config, peer_registry)


@pytest.fixture
def inner_bus() -> AsyncMock:
    bus = AsyncMock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"source": "local"}))
    bus.subscribe = MagicMock()
    bus.start = AsyncMock()
    bus.stop = AsyncMock()
    return bus


async def _register_peer(
    registry: PeerRegistry,
    peer_id: str,
    modules: list[str],
    *,
    latency_ms: float = 50.0,
    max_concurrent: int = 10,
    node_name: str | None = None,
) -> None:
    await registry.register_peer(peer_id, node_name or peer_id)
    await registry.update_manifest(
        peer_id,
        PeerManifest(
            peer_id=peer_id,
            node_name=node_name or peer_id,
            shared_services=[
                PeerServiceInfo(
                    module=module,
                    version="1.0.0",
                    max_concurrent=max_concurrent,
                )
                for module in modules
            ],
        ),
    )
    await registry.update_latency(peer_id, latency_ms)


@pytest.mark.integration
class TestMeshChaosFallbacks:
    @pytest.mark.asyncio
    async def test_provider_disconnect_mid_request_falls_back_to_local(
        self,
        inner_bus: AsyncMock,
        routing_table: RoutingTable,
        peer_registry: PeerRegistry,
        mesh_config: MeshConfig,
    ) -> None:
        await _register_peer(peer_registry, "orchestrator-peer", ["Orchestrator"])
        bridge = ScriptedPeerBridge({"orchestrator-peer": [ConnectionError("data channel closed")]})
        mesh_bus = MeshBus(inner_bus, routing_table, bridge, mesh_config)

        result = await mesh_bus.request(OrchestratorMethods.USER_INPUT, ChaosPayload())

        assert result.ok is True
        assert result.data == {"source": "local"}
        assert len(bridge.calls) == 1
        assert bridge.calls[0][0:2] == ("orchestrator-peer", OrchestratorMethods.USER_INPUT)
        assert bridge.calls[0][2]
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_failure_falls_back_to_second_network_provider(
        self,
        inner_bus: AsyncMock,
        routing_table: RoutingTable,
        peer_registry: PeerRegistry,
        mesh_config: MeshConfig,
    ) -> None:
        mesh_config.services["Orchestrator"].fallback = "network"
        await _register_peer(peer_registry, "orchestrator-fast", ["Orchestrator"], latency_ms=5.0)
        await _register_peer(peer_registry, "orchestrator-slow", ["Orchestrator"], latency_ms=25.0)
        bridge = ScriptedPeerBridge(
            {
                "orchestrator-fast": [QueryResult(ok=False, error="provider overloaded")],
                "orchestrator-slow": [QueryResult(ok=True, data={"source": "orchestrator-slow"})],
            }
        )
        mesh_bus = MeshBus(inner_bus, routing_table, bridge, mesh_config)

        result = await mesh_bus.request(OrchestratorMethods.USER_INPUT, ChaosPayload())

        assert result.ok is True
        assert result.data == {"source": "orchestrator-slow"}
        assert [call[0:2] for call in bridge.calls] == [
            ("orchestrator-fast", OrchestratorMethods.USER_INPUT),
            ("orchestrator-slow", OrchestratorMethods.USER_INPUT),
        ]
        assert all(call[2] for call in bridge.calls)
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_latency_change_selects_new_best_provider(
        self, routing_table: RoutingTable, peer_registry: PeerRegistry
    ) -> None:
        await _register_peer(peer_registry, "peer-a", ["Orchestrator"], latency_ms=10.0)
        await _register_peer(peer_registry, "peer-b", ["Orchestrator"], latency_ms=40.0)

        first = routing_table.resolve(OrchestratorMethods.USER_INPUT)
        await peer_registry.update_latency("peer-a", 80.0)
        await peer_registry.update_latency("peer-b", 8.0)
        second = routing_table.resolve(OrchestratorMethods.USER_INPUT)

        assert first.target == "remote"
        assert first.peer_id == "peer-a"
        assert second.target == "remote"
        assert second.peer_id == "peer-b"

    @pytest.mark.asyncio
    async def test_service_reannouncement_after_restart_restores_route(
        self, routing_table: RoutingTable, peer_registry: PeerRegistry
    ) -> None:
        await _register_peer(peer_registry, "restart-peer", ["Orchestrator"])
        assert routing_table.resolve(OrchestratorMethods.USER_INPUT).peer_id == "restart-peer"

        await peer_registry.remove_peer("restart-peer")
        removed = routing_table.resolve(OrchestratorMethods.USER_INPUT)
        await _register_peer(peer_registry, "restart-peer", ["Orchestrator"], latency_ms=7.0)
        restored = routing_table.resolve(OrchestratorMethods.USER_INPUT)

        assert removed.target == "local"
        assert restored.target == "remote"
        assert restored.peer_id == "restart-peer"


@pytest.mark.integration
class TestMeshChaosSafeHardFailures:
    @pytest.mark.asyncio
    async def test_stale_explicit_selector_is_rejected_without_fallback(
        self,
        inner_bus: AsyncMock,
        routing_table: RoutingTable,
        peer_registry: PeerRegistry,
        mesh_config: MeshConfig,
    ) -> None:
        await _register_peer(peer_registry, "stale-tooling", ["Tooling"])
        peer_registry.get_peer("stale-tooling").status = "stale"
        bridge = ScriptedPeerBridge()
        mesh_bus = MeshBus(inner_bus, routing_table, bridge, mesh_config)
        payload = ChaosPayload(mesh_selector=MeshAddressSelector(peer_id="stale-tooling"))

        result = await mesh_bus.request(ToolingMethods.EXECUTE_TOOL, payload)

        assert result.ok is False
        assert "not negotiated" in result.error
        assert bridge.calls == []
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_policy_denied_explicit_selector_is_not_used_after_policy_change(
        self,
        inner_bus: AsyncMock,
        routing_table: RoutingTable,
        peer_registry: PeerRegistry,
        mesh_config: MeshConfig,
    ) -> None:
        await _register_peer(peer_registry, "tooling-peer", ["Tooling"])
        mesh_config.services["Tooling"].allowed_peers = ["other-peer"]
        bridge = ScriptedPeerBridge()
        mesh_bus = MeshBus(inner_bus, routing_table, bridge, mesh_config)
        payload = ChaosPayload(mesh_selector=MeshAddressSelector(peer_id="tooling-peer"))

        result = await mesh_bus.request(ToolingMethods.EXECUTE_TOOL, payload)

        assert result.ok is False
        assert "not allowed by policy" in result.error
        assert bridge.calls == []
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_explicit_selector_at_capacity_is_rejected_without_fallback(
        self,
        inner_bus: AsyncMock,
        routing_table: RoutingTable,
        peer_registry: PeerRegistry,
        mesh_config: MeshConfig,
    ) -> None:
        await _register_peer(
            peer_registry,
            "busy-tooling",
            ["Tooling"],
            max_concurrent=1,
        )
        await peer_registry.set_active_calls("busy-tooling", 1)
        bridge = ScriptedPeerBridge()
        mesh_bus = MeshBus(inner_bus, routing_table, bridge, mesh_config)
        payload = ChaosPayload(mesh_selector=MeshAddressSelector(peer_id="busy-tooling"))

        result = await mesh_bus.request(ToolingMethods.EXECUTE_TOOL, payload)

        assert result.ok is False
        assert "at capacity" in result.error
        assert bridge.calls == []
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_network_only_without_eligible_peer_returns_hard_failure(
        self,
        inner_bus: AsyncMock,
        routing_table: RoutingTable,
        mesh_config: MeshConfig,
    ) -> None:
        mesh_bus = MeshBus(inner_bus, routing_table, ScriptedPeerBridge(), mesh_config)

        result = await mesh_bus.request(ToolingMethods.EXECUTE_TOOL, ChaosPayload())

        assert result.ok is False
        assert "No route available" in result.error
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_expired_or_anonymous_rpc_identity_is_rejected_before_bus_dispatch(
        self,
    ) -> None:
        bus = AsyncMock()
        registry = AsyncMock()
        send = MagicMock()
        registry.get_service.return_value = ServiceAnnouncement(
            module="TTS",
            version="1.0",
            methods=[
                MethodInfo(
                    name="Request",
                    bus_topic=TTSMethods.REQUEST,
                    method_type="use",
                    required_perms=[],
                )
            ],
        )
        anonymous_identity = Identity(
            principal_id="anonymous",
            principal_name="anonymous",
            source="webrtc_peer",
        )
        mesh_config = MeshConfig(
            enabled=True,
            node_name="chaos-rpc",
            services={"TTS": MeshServiceConfig(share=True)},
        )
        handler = RPCHandler(
            bus,
            registry,
            send,
            MagicMock(return_value=anonymous_identity),
            mesh_config=mesh_config,
            peer_id="expired-peer",
        )

        await handler.on_message(
            json.dumps({"type": "call", "id": "expired", "method": TTSMethods.REQUEST})
        )

        response = json.loads(send.call_args.args[0])
        assert response["type"] == "error"
        assert response["error"]["code"] == 401
        bus.request.assert_not_called()


@pytest.mark.integration
class TestMeshChaosForwardingLoops:
    @pytest.mark.asyncio
    async def test_mesh_event_forwards_once_to_negotiated_peers(
        self,
        inner_bus: AsyncMock,
        routing_table: RoutingTable,
        peer_registry: PeerRegistry,
        mesh_config: MeshConfig,
    ) -> None:
        await _register_peer(peer_registry, "event-peer", ["TTS"])
        bridge = ScriptedPeerBridge()
        mesh_bus = MeshBus(inner_bus, routing_table, bridge, mesh_config)

        await mesh_bus.publish(
            TTSMethods.STARTED,
            ChaosPayload(),
            event=True,
            mesh=True,
            correlation_id="evt-1",
        )

        inner_bus.publish.assert_awaited_once()
        assert bridge.forwarded_events == [("event-peer", TTSMethods.STARTED, "evt-1")]

    @pytest.mark.asyncio
    async def test_forwarded_event_is_republished_locally_without_reforwarding(
        self,
        inner_bus: AsyncMock,
        routing_table: RoutingTable,
        peer_registry: PeerRegistry,
        mesh_config: MeshConfig,
    ) -> None:
        await _register_peer(peer_registry, "event-peer", ["TTS"])
        bridge = ScriptedPeerBridge()
        mesh_bus = MeshBus(inner_bus, routing_table, bridge, mesh_config)
        send = MagicMock()
        identity = Identity(
            principal_id="remote-peer",
            principal_name="remote-peer",
            effective_perms=frozenset(["TTS.*"]),
            source="webrtc_peer",
        )
        handler = RPCHandler(
            mesh_bus,
            AsyncMock(),
            send,
            MagicMock(return_value=identity),
            mesh_config=mesh_config,
            peer_id="event-peer",
        )

        await handler.on_message(
            json.dumps(
                {
                    "type": "event",
                    "topic": TTSMethods.STARTED,
                    "params": {"text": "remote started"},
                    "correlation_id": "evt-forwarded",
                }
            )
        )

        inner_bus.publish.assert_awaited_once()
        assert inner_bus.publish.call_args.kwargs["origin"] == "mesh_forwarded"
        assert inner_bus.publish.call_args.kwargs["correlation_id"] == "evt-forwarded"
        assert bridge.forwarded_events == []
