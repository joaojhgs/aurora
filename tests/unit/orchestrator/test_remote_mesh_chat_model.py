from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import StructuredTool

from app.messaging import QueryResult
from app.services.orchestrator.remote_mesh_chat_model import RemoteMeshChatModel
from app.shared.contracts.models.gateway import (
    GatewayMeshInferChatChunkEvent,
    GatewayMeshInferChatResponse,
    GatewayMethods,
    GatewayStreamMeshInferChatStartResponse,
)
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import (
    OrchestratorInferChatChunk,
    OrchestratorInferChatRequest,
    OrchestratorInferChatResponse,
    OrchestratorMethods,
)


@pytest.fixture
def mesh_selector() -> MeshAddressSelector:
    return MeshAddressSelector(peer_id="llm-peer", resource_namespace="inference")


@pytest.fixture
def bus() -> AsyncMock:
    mock_bus = AsyncMock()
    mock_bus.request = AsyncMock()
    return mock_bus


@pytest.mark.asyncio
async def test_ainvoke_sends_infer_chat_request_and_maps_tool_calls(bus, mesh_selector):
    bus.request.return_value = QueryResult(
        ok=True,
        data={
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {"name": "weather", "arguments": '{"city":"Paris"}'},
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        },
    )
    model = RemoteMeshChatModel(bus=bus, mesh_selector=mesh_selector, timeout=12.0)

    response = await model.ainvoke([HumanMessage(content="weather in Paris?")])

    assert isinstance(response, AIMessage)
    assert response.tool_calls == [
        {"name": "weather", "args": {"city": "Paris"}, "id": "call_1", "type": "tool_call"}
    ]
    topic, wrapper = bus.request.await_args.args[:2]
    assert topic == GatewayMethods.MESH_INFER_CHAT
    payload = wrapper.request
    assert isinstance(payload, OrchestratorInferChatRequest)
    assert wrapper.mesh_selector == mesh_selector
    assert [msg.model_dump(exclude_defaults=True) for msg in payload.messages] == [
        {"content": "weather in Paris?"}
    ]
    assert payload.stream is False
    assert payload.mesh_selector == mesh_selector
    assert bus.request.await_args.kwargs["timeout"] == 12.0


@pytest.mark.asyncio
async def test_bind_tools_formats_tools_and_preserves_original(bus, mesh_selector):
    def lookup(query: str) -> str:
        """Lookup a query."""
        return query

    tool = StructuredTool.from_function(lookup)
    model = RemoteMeshChatModel(bus=bus, mesh_selector=mesh_selector)
    bound = model.bind_tools([tool], tool_choice="auto", temperature=0.1)
    bus.request.return_value = QueryResult(ok=True, data={"message": {"content": "ok"}})

    await bound.ainvoke([{"role": "user", "content": "hello"}])

    assert model.tools == []
    assert bound.tool_choice == "auto"
    assert bound.params == {"temperature": 0.1}
    payload = bus.request.await_args.args[1].request
    assert payload.tools[0]["type"] == "function"
    assert payload.tools[0]["function"]["name"] == "lookup"
    assert payload.tool_choice == "auto"
    assert payload.params == {"temperature": 0.1}


@pytest.mark.asyncio
async def test_astream_maps_openai_chunks_for_chatbot_accumulation(bus, mesh_selector):
    handlers = {}

    def subscribe(topic, handler):
        handlers[topic] = handler

    async def request(topic, payload, **kwargs):
        assert topic == GatewayMethods.STREAM_MESH_INFER_CHAT
        await handlers[GatewayMethods.MESH_INFER_CHAT_CHUNK](
            GatewayMeshInferChatChunkEvent(
                stream_id=payload.stream_id,
                chunk=OrchestratorInferChatChunk(delta="Hel"),
            )
        )
        await handlers[GatewayMethods.MESH_INFER_CHAT_CHUNK](
            GatewayMeshInferChatChunkEvent(
                stream_id=payload.stream_id,
                chunk=OrchestratorInferChatChunk(delta="lo", finish_reason="stop"),
                is_final=True,
            )
        )
        return QueryResult(
            ok=True,
            data=GatewayStreamMeshInferChatStartResponse(stream_id=payload.stream_id),
        )

    bus.subscribe = Mock(side_effect=subscribe)
    bus.unsubscribe = Mock()
    bus.request.side_effect = request
    model = RemoteMeshChatModel(bus=bus, mesh_selector=mesh_selector)

    chunks = [chunk async for chunk in model.astream([HumanMessage(content="hi")])]
    combined = chunks[0] + chunks[1]

    assert combined.content == "Hello"
    topic, wrapper = bus.request.await_args.args[:2]
    assert topic == GatewayMethods.STREAM_MESH_INFER_CHAT
    assert wrapper.request.stream is True
    assert wrapper.mesh_selector == mesh_selector


@pytest.mark.asyncio
async def test_ainvoke_raises_remote_error(bus, mesh_selector):
    bus.request.return_value = QueryResult(ok=False, error="provider offline")
    model = RemoteMeshChatModel(bus=bus, mesh_selector=mesh_selector)

    with pytest.raises(RuntimeError, match="provider offline"):
        await model.ainvoke([HumanMessage(content="hi")])


@pytest.mark.asyncio
async def test_astream_uses_gateway_stream_proxy_when_bus_is_not_meshbus(mesh_selector):
    class StreamBus:
        def __init__(self):
            self.handlers = {}

        async def start(self) -> None:
            pass

        async def stop(self) -> None:
            pass

        async def publish(self, *args, **kwargs) -> None:
            pass

        async def request(self, topic, payload, **kwargs):
            self.topic = topic
            self.payload = payload
            await self.handlers[GatewayMethods.MESH_INFER_CHAT_CHUNK](
                GatewayMeshInferChatChunkEvent(
                    stream_id=payload.stream_id,
                    chunk=OrchestratorInferChatChunk(delta="remote"),
                )
            )
            await self.handlers[GatewayMethods.MESH_INFER_CHAT_CHUNK](
                GatewayMeshInferChatChunkEvent(
                    stream_id=payload.stream_id,
                    chunk=OrchestratorInferChatChunk(delta=" stream", is_final=True),
                    is_final=True,
                )
            )
            return QueryResult(
                ok=True,
                data=GatewayStreamMeshInferChatStartResponse(stream_id=payload.stream_id),
            )

        def subscribe(self, *args, **kwargs) -> None:
            self.handlers[args[0]] = args[1]

        def unsubscribe(self, *args, **kwargs) -> None:
            pass

        async def stream_request(self, topic, payload, **kwargs):
            raise AssertionError("plain process bus stream_request must not be used")

    bus = StreamBus()
    model = RemoteMeshChatModel(bus=bus, mesh_selector=mesh_selector)

    chunks = [chunk async for chunk in model.astream([HumanMessage(content="hi")])]

    assert "".join(str(chunk.content) for chunk in chunks) == "remote stream"
    assert bus.topic == GatewayMethods.STREAM_MESH_INFER_CHAT
    assert bus.topic != OrchestratorMethods.EXTERNAL_USER_INPUT
    assert isinstance(bus.payload.request, OrchestratorInferChatRequest)
    assert bus.payload.request.mesh_selector == mesh_selector
    assert bus.payload.mesh_selector == mesh_selector


@pytest.mark.asyncio
async def test_astream_cancels_gateway_proxy_when_consumer_stops(mesh_selector):
    class HangingGatewayBus:
        def __init__(self):
            self.handlers = {}
            self.requests = []

        async def start(self) -> None:
            pass

        async def stop(self) -> None:
            pass

        async def publish(self, *args, **kwargs) -> None:
            pass

        async def request(self, topic, payload, **kwargs):
            self.requests.append((topic, payload, kwargs))
            if topic == GatewayMethods.STREAM_MESH_INFER_CHAT:
                return QueryResult(
                    ok=True,
                    data=GatewayStreamMeshInferChatStartResponse(stream_id=payload.stream_id),
                )
            if topic == GatewayMethods.CANCEL_MESH_INFER_CHAT_STREAM:
                return QueryResult(ok=True, data={"cancelled": True})
            raise AssertionError(topic)

        def subscribe(self, *args, **kwargs) -> None:
            self.handlers[args[0]] = args[1]

        def unsubscribe(self, *args, **kwargs) -> None:
            pass

    bus = HangingGatewayBus()
    model = RemoteMeshChatModel(bus=bus, mesh_selector=mesh_selector, timeout=5.0)
    stream = model.astream([HumanMessage(content="hi")])

    task = asyncio.create_task(stream.__anext__())
    await asyncio.sleep(0.05)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert [topic for topic, _, _ in bus.requests] == [
        GatewayMethods.STREAM_MESH_INFER_CHAT,
        GatewayMethods.CANCEL_MESH_INFER_CHAT_STREAM,
    ]


@pytest.mark.asyncio
async def test_ainvoke_uses_gateway_proxy_when_bus_is_not_meshbus(bus, mesh_selector):
    bus.request.return_value = QueryResult(
        ok=True,
        data=GatewayMeshInferChatResponse(response=OrchestratorInferChatResponse(text="proxied")),
    )
    model = RemoteMeshChatModel(bus=bus, mesh_selector=mesh_selector)

    response = await model.ainvoke([HumanMessage(content="hi")])

    assert response.content == "proxied"
    topic, wrapper = bus.request.await_args.args[:2]
    assert topic == GatewayMethods.MESH_INFER_CHAT
    assert wrapper.request.mesh_selector == mesh_selector
    assert topic != OrchestratorMethods.INFER_CHAT


@pytest.mark.asyncio
async def test_remote_peer_caller_params_are_not_forwarded_as_llm_kwargs():
    from app.services.orchestrator.service import OrchestratorService
    from app.shared.contracts.models.orchestrator import OrchestratorChatMessage

    class CapturingLLM:
        def __init__(self):
            self.ainvoke_calls = []
            self.astream_calls = []

        async def ainvoke(self, *args, **kwargs):
            self.ainvoke_calls.append((args, kwargs))
            return AIMessage(content="ok")

        async def astream(self, *args, **kwargs):
            self.astream_calls.append((args, kwargs))
            yield AIMessage(content="ok")

    llm = CapturingLLM()
    service = OrchestratorService()
    service._inference_llm = AsyncMock(return_value=llm)  # type: ignore[method-assign]
    request = OrchestratorInferChatRequest(
        messages=[OrchestratorChatMessage(role="user", content="hi")],
        params={"temperature": 0.1, "max_tokens": 8, "context_window": 1024},
    )

    await service._invoke_inference_llm(request)
    chunks = [chunk async for chunk in service._stream_inference_llm(request)]

    assert chunks[-1].metadata["caller_params_ignored"] is True
    assert llm.ainvoke_calls[0][1] == {}
    assert llm.astream_calls[0][1] == {}
