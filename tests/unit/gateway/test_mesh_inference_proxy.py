from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.messaging import QueryResult
from app.services.gateway.service import GatewayService
from app.shared.contracts.models.gateway import (
    GatewayCancelMeshInferChatStreamRequest,
    GatewayMeshInferChatChunkEvent,
    GatewayMeshInferChatRequest,
    GatewayStreamMeshInferChatStartRequest,
)
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import (
    OrchestratorChatMessage,
    OrchestratorInferChatChunk,
    OrchestratorInferChatRequest,
    OrchestratorInferChatResponse,
    OrchestratorMethods,
)
from app.shared.messaging.bus_init import set_bus


class _EventBus:
    def __init__(self) -> None:
        self.published: list[tuple[str, Any, dict[str, Any]]] = []

    async def publish(self, topic, message, **kwargs):
        self.published.append((topic, message, kwargs))


class _MeshBus:
    def __init__(self) -> None:
        self.requests: list[tuple[str, Any, dict[str, Any]]] = []
        self.streams: list[tuple[str, Any, dict[str, Any]]] = []

    async def request(self, topic, payload, **kwargs):
        self.requests.append((topic, payload, kwargs))
        return QueryResult(ok=True, data=OrchestratorInferChatResponse(text="remote ok"))

    async def stream_request(self, topic, payload, **kwargs):
        self.streams.append((topic, payload, kwargs))
        yield OrchestratorInferChatChunk(delta="mesh ", sequence=0)
        yield OrchestratorInferChatChunk(delta="stream", sequence=1, is_final=True)


class _BlockingMeshBus(_MeshBus):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def stream_request(self, topic, payload, **kwargs):
        self.streams.append((topic, payload, kwargs))
        self.started.set()
        await self.release.wait()
        yield OrchestratorInferChatChunk(delta="done", sequence=0, is_final=True)


@pytest.mark.asyncio
async def test_gateway_mesh_infer_chat_forwards_through_mesh_bus_not_service_bus():
    service = GatewayService()
    event_bus = _EventBus()
    set_bus(event_bus)  # type: ignore[arg-type]
    mesh_bus = _MeshBus()
    service._mesh_bus = mesh_bus
    selector = MeshAddressSelector(peer_id="remote-peer", resource_namespace="inference")

    response = await service.mesh_infer_chat(
        GatewayMeshInferChatRequest(
            mesh_selector=selector,
            principal_id="principal-a",
            effective_perms=["Gateway.use", "Orchestrator.use"],
            identity_source="gateway_http",
            method_type="use",
            caller_peer_id="caller-peer",
            origin="external",
            request=OrchestratorInferChatRequest(
                messages=[OrchestratorChatMessage(role="user", content="hi")],
                mesh_selector=selector,
            ),
        )
    )

    assert response.response.text == "remote ok"
    assert len(mesh_bus.requests) == 1
    topic, payload, kwargs = mesh_bus.requests[0]
    assert topic == OrchestratorMethods.INFER_CHAT
    assert payload.mesh_selector == selector
    assert payload.selector == selector
    assert kwargs["origin"] == "external"
    assert kwargs["principal_id"] == "principal-a"
    assert kwargs["effective_perms"] == ["Gateway.use", "Orchestrator.use"]
    assert kwargs["identity_source"] == "gateway_http"
    assert kwargs["method_type"] == "use"
    assert kwargs["caller_peer_id"] == "caller-peer"
    assert event_bus.published == []


@pytest.mark.asyncio
async def test_gateway_stream_mesh_infer_chat_publishes_serializable_chunk_events():
    service = GatewayService()
    event_bus = _EventBus()
    set_bus(event_bus)  # type: ignore[arg-type]
    mesh_bus = _MeshBus()
    service._mesh_bus = mesh_bus
    selector = MeshAddressSelector(peer_id="remote-peer", resource_namespace="inference")

    start = await service.stream_mesh_infer_chat(
        GatewayStreamMeshInferChatStartRequest(
            stream_id="stream-1",
            mesh_selector=selector,
            principal_id="principal-a",
            identity_source="gateway_http",
            origin="external",
            request=OrchestratorInferChatRequest(
                messages=[OrchestratorChatMessage(role="user", content="hi")],
                stream=True,
                mesh_selector=selector,
            ),
        )
    )

    assert start.accepted is True
    await asyncio.gather(*list(service._mesh_infer_stream_tasks))

    assert len(mesh_bus.streams) == 1
    topic, payload, kwargs = mesh_bus.streams[0]
    assert topic == OrchestratorMethods.STREAM_INFER_CHAT
    assert payload.mesh_selector == selector
    assert kwargs["origin"] == "external"
    assert kwargs["principal_id"] == "principal-a"
    assert kwargs["identity_source"] == "gateway_http"
    events = [message for _, message, _ in event_bus.published]
    assert all(isinstance(event, GatewayMeshInferChatChunkEvent) for event in events)
    assert [event.stream_id for event in events] == ["stream-1", "stream-1", "stream-1"]
    assert [event.chunk.delta if event.chunk else "" for event in events] == [
        "mesh ",
        "stream",
        "",
    ]
    assert events[-1].is_final is True


@pytest.mark.asyncio
async def test_gateway_stream_mesh_infer_chat_rejects_duplicate_active_stream_id():
    service = GatewayService()
    set_bus(_EventBus())  # type: ignore[arg-type]
    mesh_bus = _BlockingMeshBus()
    service._mesh_bus = mesh_bus
    selector = MeshAddressSelector(peer_id="remote-peer", resource_namespace="inference")
    request = GatewayStreamMeshInferChatStartRequest(
        stream_id="stream-dup",
        mesh_selector=selector,
        principal_id="principal-a",
        identity_source="gateway_http",
        origin="external",
        request=OrchestratorInferChatRequest(
            messages=[OrchestratorChatMessage(role="user", content="hi")],
            stream=True,
            mesh_selector=selector,
        ),
    )

    await service.stream_mesh_infer_chat(request)

    with pytest.raises(ValueError, match="already active"):
        await service.stream_mesh_infer_chat(request)

    mesh_bus.release.set()
    await asyncio.gather(*list(service._mesh_infer_stream_tasks), return_exceptions=True)


@pytest.mark.asyncio
async def test_gateway_cancel_mesh_infer_chat_stream_requires_matching_owner_context():
    service = GatewayService()
    set_bus(_EventBus())  # type: ignore[arg-type]
    mesh_bus = _BlockingMeshBus()
    service._mesh_bus = mesh_bus
    selector = MeshAddressSelector(peer_id="remote-peer", resource_namespace="inference")

    await service.stream_mesh_infer_chat(
        GatewayStreamMeshInferChatStartRequest(
            stream_id="stream-owned",
            mesh_selector=selector,
            principal_id="principal-owner",
            identity_source="gateway_http",
            origin="external",
            request=OrchestratorInferChatRequest(
                messages=[OrchestratorChatMessage(role="user", content="hi")],
                stream=True,
                mesh_selector=selector,
            ),
        )
    )

    wrong_owner = await service.cancel_mesh_infer_chat_stream(
        GatewayCancelMeshInferChatStreamRequest(
            stream_id="stream-owned",
            principal_id="principal-other",
            identity_source="gateway_http",
            origin="external",
        )
    )
    assert wrong_owner.cancelled is False
    assert "stream-owned" in service._mesh_infer_stream_tasks_by_id

    right_owner = await service.cancel_mesh_infer_chat_stream(
        GatewayCancelMeshInferChatStreamRequest(
            stream_id="stream-owned",
            principal_id="principal-owner",
            identity_source="gateway_http",
            origin="external",
        )
    )
    assert right_owner.cancelled is True
    assert "stream-owned" not in service._mesh_infer_stream_tasks_by_id
