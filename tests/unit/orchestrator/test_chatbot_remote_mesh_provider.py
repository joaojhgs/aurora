from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import ToolMessage

from app.messaging import QueryResult
from app.services.orchestrator.agents import chatbot
from app.services.orchestrator.remote_mesh_chat_model import RemoteMeshChatModel
from app.shared.config.models import Orchestrator as OrchestratorConfig
from app.shared.contracts.models.gateway import (
    GatewayMeshInferChatChunkEvent,
    GatewayMethods,
    GatewayStreamMeshInferChatStartResponse,
)
from app.shared.contracts.models.orchestrator import OrchestratorInferChatChunk, OrchestratorMethods
from app.shared.messaging.bus_init import set_bus


class _StreamBus:
    def __init__(self) -> None:
        self.handlers = {}

    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def publish(self, *args, **kwargs) -> None: ...
    async def request(self, topic, payload, **kwargs):
        self.stream_topic = topic
        self.stream_payload = payload
        await self.handlers[GatewayMethods.MESH_INFER_CHAT_CHUNK](
            GatewayMeshInferChatChunkEvent(
                stream_id=payload.stream_id,
                chunk=OrchestratorInferChatChunk(delta="mesh"),
            )
        )
        await self.handlers[GatewayMethods.MESH_INFER_CHAT_CHUNK](
            GatewayMeshInferChatChunkEvent(
                stream_id=payload.stream_id,
                chunk=OrchestratorInferChatChunk(delta=" ok", is_final=True),
                is_final=True,
            )
        )
        return QueryResult(
            ok=True,
            data=GatewayStreamMeshInferChatStartResponse(stream_id=payload.stream_id),
        )

    def subscribe(self, topic, handler) -> None:
        self.handlers[topic] = handler

    def unsubscribe(self, *args, **kwargs) -> None:
        pass

    async def stream_request(self, topic, payload, **kwargs):
        raise AssertionError("plain process bus stream_request must not be used")


@pytest.mark.asyncio
async def test_remote_peer_provider_initializes_remote_mesh_chat_model_and_streams(monkeypatch):
    raw_services = {
        "orchestrator": {
            "llm": {
                "provider": "remote_peer",
                "remote_peer": {
                    "service_instance_id": "remote:llm-peer:Orchestrator",
                    "timeout_s": 9,
                },
            }
        }
    }
    bus = _StreamBus()
    set_bus(bus)  # type: ignore[arg-type]
    monkeypatch.setattr(chatbot.config_api, "aget_config", AsyncMock(return_value=raw_services))
    monkeypatch.setattr(
        chatbot.config_api,
        "aget",
        AsyncMock(return_value=OrchestratorConfig.model_validate(raw_services["orchestrator"])),
    )
    monkeypatch.setattr(chatbot, "llm", None)
    monkeypatch.setattr(chatbot, "_llm_initialized", False)

    await chatbot._initialize_llm()

    assert isinstance(chatbot.llm, RemoteMeshChatModel)
    assert chatbot.llm.mesh_selector.service_instance_id == "remote:llm-peer:Orchestrator"
    chunks = [chunk async for chunk in chatbot.llm.astream([{"role": "user", "content": "hi"}])]
    assert "".join(str(chunk.content) for chunk in chunks) == "mesh ok"
    assert bus.stream_topic == GatewayMethods.STREAM_MESH_INFER_CHAT
    assert bus.stream_topic != OrchestratorMethods.EXTERNAL_USER_INPUT
    assert (
        bus.stream_payload.request.mesh_selector.service_instance_id
        == "remote:llm-peer:Orchestrator"
    )


@pytest.mark.asyncio
async def test_runtime_inference_selector_uses_remote_model_without_dispatch(monkeypatch):
    from langchain_core.messages import AIMessage

    from app.messaging.bus import QueryResult
    from app.services.orchestrator.agents import chatbot as chatbot_module
    from app.shared.contracts.models.mesh import MeshAddressSelector
    from app.shared.contracts.models.tooling import ToolingMethods

    class FakeRemote:
        def __init__(self, **kwargs):
            created.append(kwargs)

        async def astream(self, messages):
            yield AIMessage(content="remote answer")

    created = []
    bus = AsyncMock()

    async def request(topic, payload, **kwargs):
        if topic == ToolingMethods.GET_TOOL_CATALOG:
            return QueryResult(ok=True, data={"tools": [], "blocked_tools": []})
        return QueryResult(ok=True, data={"items": []})

    bus.request.side_effect = request
    monkeypatch.setattr(chatbot_module, "_llm_initialized", True)
    monkeypatch.setattr(chatbot_module, "llm", object())
    monkeypatch.setattr(chatbot_module, "RemoteMeshChatModel", FakeRemote)

    selector = MeshAddressSelector(peer_id="assistant-peer", resource_namespace="inference")
    msg = type(
        "Msg",
        (),
        {
            "content": "hello",
            "additional_kwargs": {
                "aurora_inference_override": {
                    "inference_selector": selector,
                    "inference_provider": "remote_peer",
                    "inference_provider_id": "llama_cpp",
                    "inference_model_id": "remote-model.gguf",
                }
            },
        },
    )()
    result = await chatbot_module.chatbot({"messages": [msg]}, bus=bus)

    assert result["messages"][0].content == "remote answer"
    assert created[0]["mesh_selector"] == selector
    assert created[0]["provider_id"] == "llama_cpp"
    assert created[0]["model_id"] == "remote-model.gguf"
    assert all(
        getattr(call.args[1], "inference_selector", None) is None
        for call in bus.request.await_args_list
    )


@pytest.mark.asyncio
async def test_runtime_local_cloud_override_uses_configured_provider_llm(monkeypatch):
    from app.services.orchestrator import service as service_module

    global_llm = None
    selected_llm = object()
    provider_factory = AsyncMock(return_value=selected_llm)
    monkeypatch.setattr(chatbot, "llm", global_llm)
    monkeypatch.setattr(
        service_module,
        "configured_provider_inference_llm",
        provider_factory,
    )

    msg = type(
        "Msg",
        (),
        {
            "additional_kwargs": {
                "aurora_inference_override": {
                    "inference_provider": "configured",
                    "inference_provider_id": "openai",
                    "inference_model_id": "gpt-4o",
                    "inference_timeout_s": 1,
                    "params": {"temperature": 99},
                }
            }
        },
    )()

    active_llm = await chatbot._chat_llm_for_state({"messages": [msg]}, bus=AsyncMock())

    assert active_llm is selected_llm
    assert active_llm is not global_llm
    provider_factory.assert_awaited_once_with("openai", "gpt-4o")


@pytest.mark.asyncio
async def test_state_level_inference_override_survives_tool_loop(monkeypatch):
    """After a tool call, the last message is a ToolMessage but routing must persist."""

    created = []

    class FakeRemote:
        def __init__(self, **kwargs):
            created.append(kwargs)

    monkeypatch.setattr(chatbot, "llm", object())
    monkeypatch.setattr(chatbot, "RemoteMeshChatModel", FakeRemote)
    selector = {
        "peer_id": "assistant-peer",
        "resource_namespace": "inference",
    }

    active_llm = await chatbot._chat_llm_for_state(
        {
            "messages": [ToolMessage(content="tool result", tool_call_id="call-1")],
            "inference_override": {
                "inference_selector": selector,
                "inference_provider": "remote_peer",
                "inference_provider_id": "openai",
                "inference_model_id": "gpt-4o",
            },
        },
        bus=AsyncMock(),
    )

    assert active_llm is not None
    assert created[0]["provider_id"] == "openai"
    assert created[0]["model_id"] == "gpt-4o"
    assert created[0]["mesh_selector"].peer_id == "assistant-peer"
