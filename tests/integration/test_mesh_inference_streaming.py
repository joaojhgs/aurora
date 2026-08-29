from __future__ import annotations

import json
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest

from app.messaging.local_bus import LocalBus
from app.messaging.mesh_bus import MeshBus
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.peer_bridge import PeerBridge
from app.services.gateway.service import GatewayService
from app.services.gateway.webrtc.rpc import RPCHandler
from app.services.orchestrator.remote_mesh_chat_model import RemoteMeshChatModel
from app.services.orchestrator.service import OrchestratorService
from app.shared.auth.identity import Identity
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import (
    OrchestratorInferChatRequest,
    OrchestratorMethods,
)
from app.shared.contracts.registry import clear_registry
from app.shared.messaging.bus_init import set_bus
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


@dataclass
class _Route:
    target: str
    peer_id: str | None = None
    module: str = "Orchestrator"
    error_message: str | None = None


class _RoutingTable:
    def resolve(
        self,
        topic: str,
        *,
        routing_config: Any | None = None,
        mesh_config: Any | None = None,
        selector: MeshAddressSelector | None = None,
        policy_snapshot: Any | None = None,
        speech_constraints: Any | None = None,
    ) -> _Route:
        assert topic == OrchestratorMethods.STREAM_INFER_CHAT
        _ = routing_config, mesh_config, policy_snapshot, speech_constraints
        assert selector is not None
        return _Route(target="remote", peer_id=selector.peer_id)

    def resolve_fallback(
        self,
        topic: str,
        *,
        failed_peer_id: str,
        routing_config: Any | None = None,
        mesh_config: Any | None = None,
        selector: MeshAddressSelector | None = None,
        policy_snapshot: Any | None = None,
        speech_constraints: Any | None = None,
    ) -> _Route:
        _ = routing_config, mesh_config, selector, policy_snapshot, speech_constraints
        return _Route(target="error", peer_id=failed_peer_id, error_message="no fallback")

    def get_negotiated_peers(self) -> list[Any]:
        return []


class _MeshConfig:
    services: dict[str, Any] = {}
    remote_timeout_s = 5.0


class _PeerRegistry:
    def __init__(self) -> None:
        self.active = 0

    async def increment_active_calls(self, peer_id: str) -> None:
        assert peer_id == "remote-peer"
        self.active += 1

    async def decrement_active_calls(self, peer_id: str) -> None:
        assert peer_id == "remote-peer"
        self.active -= 1


class _Registry:
    async def get_service(self, service: str) -> ServiceAnnouncement:
        assert service == "Orchestrator"
        return ServiceAnnouncement(
            module="Orchestrator",
            version="1.0",
            methods=[
                MethodInfo(
                    name="StreamInferChat",
                    bus_topic=OrchestratorMethods.STREAM_INFER_CHAT,
                    exposure="external",
                    required_perms=["Orchestrator.use"],
                    method_type="use",
                )
            ],
        )

    async def get_external_methods(self) -> list[Any]:
        return []


class _RTC:
    def __init__(self) -> None:
        self.remote_handler: RPCHandler | None = None

    def send_to_peer(self, peer_id: str, payload: str) -> bool:
        assert peer_id == "remote-peer"
        assert self.remote_handler is not None
        # Simulate DataChannel delivery to the remote RPC handler.
        import asyncio

        asyncio.create_task(self.remote_handler.on_message(payload))
        return True


def _remote_orchestrator_authority(peer_id: str = "local-peer") -> dict[str, Any]:
    return {
        "mesh_config": MeshConfig(
            enabled=True,
            services={"Orchestrator": mesh_policy(share=True)},
        ),
        "stable_peer_id_provider": lambda: peer_id,
        "active_projection_provider": lambda: SimpleNamespace(
            cache_key=SimpleNamespace(recipient_peer_id=peer_id, provider_peer_id="remote-peer"),
            readiness="ready",
            routable=True,
            services=[
                SimpleNamespace(
                    service_id="Orchestrator",
                    capacity={"max_concurrent": 0},
                    methods=[
                        SimpleNamespace(
                            topic=OrchestratorMethods.STREAM_INFER_CHAT,
                            required_permissions=("Orchestrator.use",),
                            method_type="use",
                        )
                    ],
                )
            ],
        ),
    }


@pytest.mark.asyncio
async def test_remote_mesh_chat_model_streams_over_peer_bridge_rpc_chunks():
    clear_registry()
    remote_bus = LocalBus(validate_topics=True)
    set_bus(remote_bus)
    service = OrchestratorService()

    class _MockLLM:
        async def astream(self, messages: list[dict[str, Any]]):
            assert messages[-1]["content"] == "hi"
            yield {"content": "mesh "}
            yield {"content": "stream"}

    async def _mock_inference_llm(data: OrchestratorInferChatRequest) -> _MockLLM:
        assert data.messages[-1].content == "hi"
        return _MockLLM()

    service._inference_llm = _mock_inference_llm  # type: ignore[method-assign]
    await service._subscribe_registered_contracts()

    rtc = _RTC()
    peer_registry = _PeerRegistry()
    bridge = PeerBridge(rtc, peer_registry)  # type: ignore[arg-type]
    sent_messages: list[dict[str, Any]] = []

    def remote_send(text: str) -> None:
        message = json.loads(text)
        sent_messages.append(message)
        bridge.on_response("remote-peer", message)

    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset({"Orchestrator.use"}),
        source="webrtc_peer",
    )
    rtc.remote_handler = RPCHandler(
        remote_bus,
        _Registry(),  # type: ignore[arg-type]
        remote_send,
        lambda: identity,
        peer_id="local-peer",
        **_remote_orchestrator_authority(),
    )
    mesh_bus = MeshBus(
        inner_bus=remote_bus,  # unused for this routed call
        routing_table=_RoutingTable(),  # type: ignore[arg-type]
        peer_bridge=bridge,
        mesh_config=_MeshConfig(),
    )
    model = RemoteMeshChatModel(
        bus=mesh_bus,
        mesh_selector=MeshAddressSelector(peer_id="remote-peer", resource_namespace="inference"),
    )

    try:
        chunks = [chunk async for chunk in model.astream([{"role": "user", "content": "hi"}])]

        assert "".join(str(chunk.content) for chunk in chunks) == "mesh stream"
        assert [message["type"] for message in sent_messages] == [
            "chunk",
            "chunk",
            "chunk",
            "eof",
        ]
        assert sent_messages[0]["id"] == sent_messages[1]["id"] == sent_messages[2]["id"]
        assert peer_registry.active == 0
    finally:
        await remote_bus.stop()


@pytest.mark.asyncio
async def test_gateway_mesh_inference_proxy_streams_over_peer_bridge_rpc_chunks():
    clear_registry()
    remote_bus = LocalBus(validate_topics=True)
    set_bus(remote_bus)
    service = OrchestratorService()

    class _MockLLM:
        async def astream(self, messages: list[dict[str, Any]]):
            assert messages[-1]["content"] == "hi"
            yield {"content": "gateway "}
            yield {"content": "proxy"}

    async def _mock_inference_llm(data: OrchestratorInferChatRequest) -> _MockLLM:
        assert data.messages[-1].content == "hi"
        return _MockLLM()

    service._inference_llm = _mock_inference_llm  # type: ignore[method-assign]
    await service._subscribe_registered_contracts()

    rtc = _RTC()
    peer_registry = _PeerRegistry()
    bridge = PeerBridge(rtc, peer_registry)  # type: ignore[arg-type]
    sent_messages: list[dict[str, Any]] = []

    def remote_send(text: str) -> None:
        message = json.loads(text)
        sent_messages.append(message)
        bridge.on_response("remote-peer", message)

    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset({"Orchestrator.use"}),
        source="webrtc_peer",
    )
    rtc.remote_handler = RPCHandler(
        remote_bus,
        _Registry(),  # type: ignore[arg-type]
        remote_send,
        lambda: identity,
        peer_id="local-peer",
        **_remote_orchestrator_authority(),
    )

    gateway_bus = LocalBus(validate_topics=True)
    set_bus(gateway_bus)
    gateway = GatewayService()
    gateway._mesh_bus = MeshBus(
        inner_bus=gateway_bus,
        routing_table=_RoutingTable(),  # type: ignore[arg-type]
        peer_bridge=bridge,
        mesh_config=_MeshConfig(),
    )
    await gateway._subscribe_registered_contracts()

    model = RemoteMeshChatModel(
        bus=gateway_bus,
        mesh_selector=MeshAddressSelector(peer_id="remote-peer", resource_namespace="inference"),
    )

    try:
        chunks = [chunk async for chunk in model.astream([{"role": "user", "content": "hi"}])]

        assert "".join(str(chunk.content) for chunk in chunks) == "gateway proxy"
        assert [message["type"] for message in sent_messages] == [
            "chunk",
            "chunk",
            "chunk",
            "eof",
        ]
        assert peer_registry.active == 0
    finally:
        await gateway_bus.stop()
        await remote_bus.stop()
