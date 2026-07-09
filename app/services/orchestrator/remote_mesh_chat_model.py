"""LangChain-compatible chat adapter for remote mesh inference providers."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import BaseModel, ConfigDict, Field

from app.messaging import MessageBus, QueryResult
from app.messaging.mesh_bus import MeshBus
from app.messaging.priority_helpers import get_interactive_priority
from app.services.orchestrator.chat_llama_cpp import (
    _convert_delta_to_message_chunk,
    _convert_dict_to_message,
    _convert_message_to_dict,
)
from app.shared.contracts.models.gateway import (
    GatewayCancelMeshInferChatStreamRequest,
    GatewayMeshInferChatChunkEvent,
    GatewayMeshInferChatRequest,
    GatewayMeshInferChatResponse,
    GatewayMethods,
    GatewayStreamMeshInferChatStartRequest,
    GatewayStreamMeshInferChatStartResponse,
)
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import (
    OrchestratorInferChatChunk,
    OrchestratorInferChatRequest,
    OrchestratorInferChatResponse,
    OrchestratorMethods,
)

_GATEWAY_STREAM_QUEUE_MAXSIZE = 128


class RemoteMeshChatModel(BaseModel):
    """Small LangChain-style adapter that routes chat inference over Aurora's bus.

    The adapter intentionally implements only the methods used by
    ``agents/chatbot.py``: ``bind_tools``, ``ainvoke``, and ``astream``. It sends a
    typed Pydantic payload carrying ``mesh_selector`` so ``MeshBus`` can resolve
    the remote inference provider, then maps OpenAI-style response dictionaries
    back into LangChain ``AIMessage`` / ``AIMessageChunk`` objects.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    bus: MessageBus
    mesh_selector: MeshAddressSelector
    timeout: float = 60.0
    topic: str | None = None
    stream_topic: str | None = None
    tools: list[dict[str, Any]] = Field(default_factory=list)
    tool_choice: dict[str, Any] | str | bool | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    provider_id: str | None = None
    model_id: str | None = None

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type[BaseModel] | BaseTool | Any],
        *,
        tool_choice: dict[str, Any] | str | bool | None = None,
        **kwargs: Any,
    ) -> RemoteMeshChatModel:
        """Return a copy with OpenAI-compatible tool schemas bound."""

        formatted_tools = [convert_to_openai_tool(tool) for tool in tools]
        return self.model_copy(
            update={
                "tools": formatted_tools,
                "tool_choice": tool_choice,
                "params": {**self.params, **kwargs},
            }
        )

    async def ainvoke(
        self,
        input: Sequence[BaseMessage | dict[str, Any]],
        config: Any | None = None,
        **kwargs: Any,
    ) -> AIMessage:
        """Invoke remote chat inference once and return an ``AIMessage``."""

        del config
        result = await self._request(input, stream=False, params=kwargs)
        return self._message_from_data(result.data)

    async def astream(
        self,
        input: Sequence[BaseMessage | dict[str, Any]],
        config: Any | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[AIMessageChunk]:
        """Stream remote chat chunks as LangChain ``AIMessageChunk`` objects."""

        del config
        request = self._build_request(input, stream=True, params=kwargs)
        stream_request = getattr(self.bus, "stream_request", None)
        if self._uses_direct_mesh_bus() and callable(stream_request):
            async for item in stream_request(
                self._stream_topic,
                request,
                priority=get_interactive_priority(),
                timeout=self.timeout,
            ):
                yield self._chunk_from_data(item)
            return

        async for item in self._gateway_stream(request):
            yield self._chunk_from_data(item)

    def _build_request(
        self,
        input: Sequence[BaseMessage | dict[str, Any]],
        *,
        stream: bool,
        params: dict[str, Any] | None = None,
    ) -> OrchestratorInferChatRequest:
        return OrchestratorInferChatRequest(
            messages=[self._message_to_dict(message) for message in input],
            stream=stream,
            tools=self.tools,
            tool_choice=self.tool_choice,
            provider_id=self.provider_id,
            model_id=self.model_id,
            mesh_selector=self.mesh_selector,
            selector=self.mesh_selector,
            params={**self.params, **(params or {})},
        )

    async def _request(
        self,
        input: Sequence[BaseMessage | dict[str, Any]],
        *,
        stream: bool,
        params: dict[str, Any] | None = None,
    ) -> QueryResult:
        request = self._build_request(input, stream=stream, params=params)
        result = await self.bus.request(
            self._topic,
            request
            if self._uses_direct_mesh_bus()
            else GatewayMeshInferChatRequest(request=request, mesh_selector=self.mesh_selector),
            priority=get_interactive_priority(),
            timeout=self.timeout,
        )
        if not result.ok:
            raise RuntimeError(result.error or "Remote mesh inference failed")
        if not self._uses_direct_mesh_bus():
            return QueryResult(ok=True, data=self._unwrap_gateway_response(result.data))
        return result

    @property
    def _topic(self) -> str:
        if self.topic:
            return self.topic
        return (
            OrchestratorMethods.INFER_CHAT
            if self._uses_direct_mesh_bus()
            else GatewayMethods.MESH_INFER_CHAT
        )

    @property
    def _stream_topic(self) -> str:
        if self.stream_topic:
            return self.stream_topic
        return (
            OrchestratorMethods.STREAM_INFER_CHAT
            if self._uses_direct_mesh_bus()
            else GatewayMethods.STREAM_MESH_INFER_CHAT
        )

    def _uses_direct_mesh_bus(self) -> bool:
        return isinstance(self.bus, MeshBus)

    async def _gateway_stream(
        self,
        request: OrchestratorInferChatRequest,
    ) -> AsyncIterator[Any]:
        stream_id = request.correlation_id or uuid.uuid4().hex
        queue: asyncio.Queue[GatewayMeshInferChatChunkEvent] = asyncio.Queue(
            maxsize=_GATEWAY_STREAM_QUEUE_MAXSIZE
        )
        completed = False
        started = False

        async def _on_chunk(event: Any) -> None:
            payload = getattr(event, "payload", event)
            try:
                chunk_event = (
                    payload
                    if isinstance(payload, GatewayMeshInferChatChunkEvent)
                    else GatewayMeshInferChatChunkEvent.model_validate(payload)
                )
            except Exception:
                return
            if chunk_event.stream_id == stream_id:
                self._enqueue_gateway_stream_event(queue, chunk_event)

        self.bus.subscribe(GatewayMethods.MESH_INFER_CHAT_CHUNK, _on_chunk)
        try:
            result = await self.bus.request(
                self._stream_topic,
                GatewayStreamMeshInferChatStartRequest(
                    stream_id=stream_id,
                    request=request,
                    mesh_selector=self.mesh_selector,
                ),
                priority=get_interactive_priority(),
                timeout=self.timeout,
            )
            if not result.ok:
                raise RuntimeError(result.error or "Remote mesh inference stream failed")
            start = self._unwrap_gateway_stream_start(result.data)
            if not start.accepted:
                raise RuntimeError("Gateway rejected remote mesh inference stream")
            started = True

            while True:
                event = await asyncio.wait_for(queue.get(), timeout=self.timeout)
                if event.error:
                    raise RuntimeError(event.error)
                if event.chunk is not None:
                    yield event.chunk
                if event.is_final:
                    completed = True
                    return
        finally:
            self.bus.unsubscribe(GatewayMethods.MESH_INFER_CHAT_CHUNK, _on_chunk)
            if started and not completed:
                await self._cancel_gateway_stream(stream_id)

    async def _cancel_gateway_stream(self, stream_id: str) -> None:
        try:
            await self.bus.request(
                GatewayMethods.CANCEL_MESH_INFER_CHAT_STREAM,
                GatewayCancelMeshInferChatStreamRequest(stream_id=stream_id),
                priority=get_interactive_priority(),
                timeout=min(self.timeout, 10.0),
            )
        except Exception:
            return

    @staticmethod
    def _enqueue_gateway_stream_event(
        queue: asyncio.Queue[GatewayMeshInferChatChunkEvent],
        event: GatewayMeshInferChatChunkEvent,
    ) -> None:
        try:
            queue.put_nowait(event)
            return
        except asyncio.QueueFull:
            pass
        try:
            while True:
                queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        queue.put_nowait(
            GatewayMeshInferChatChunkEvent(
                stream_id=event.stream_id,
                is_final=True,
                error="Gateway mesh inference stream queue overflow",
                correlation_id=event.correlation_id,
                sequence=event.sequence,
            )
        )

    @staticmethod
    def _unwrap_gateway_response(data: Any) -> Any:
        if isinstance(data, GatewayMeshInferChatResponse):
            return data.response
        if isinstance(data, dict) and "response" in data:
            return GatewayMeshInferChatResponse.model_validate(data).response
        return data

    @staticmethod
    def _unwrap_gateway_stream_start(data: Any) -> GatewayStreamMeshInferChatStartResponse:
        if isinstance(data, GatewayStreamMeshInferChatStartResponse):
            return data
        if isinstance(data, dict):
            return GatewayStreamMeshInferChatStartResponse.model_validate(data)
        raise RuntimeError("Gateway returned invalid mesh stream start response")

    @staticmethod
    def _message_to_dict(message: BaseMessage | dict[str, Any]) -> dict[str, Any]:
        if isinstance(message, dict):
            return dict(message)
        return _convert_message_to_dict(message)

    @staticmethod
    def _message_from_data(data: Any) -> AIMessage:
        if isinstance(data, AIMessage):
            return data
        if isinstance(data, AIMessageChunk):
            return AIMessage(
                content=data.content,
                additional_kwargs=dict(data.additional_kwargs),
                response_metadata=dict(data.response_metadata),
                id=data.id,
                tool_calls=list(data.tool_calls),
                invalid_tool_calls=list(data.invalid_tool_calls),
            )
        if isinstance(data, OrchestratorInferChatResponse):
            return AIMessage(
                content=data.text,
                additional_kwargs={
                    "tool_calls": data.message.tool_calls if data.message else [],
                },
                response_metadata={"finish_reason": data.finish_reason},
            )
        if isinstance(data, dict):
            if "text" in data and "message" in data:
                try:
                    return RemoteMeshChatModel._message_from_data(
                        OrchestratorInferChatResponse.model_validate(data)
                    )
                except Exception:
                    pass
            message_dict = _extract_openai_message_dict(data)
            message = _convert_dict_to_message(message_dict)
            if isinstance(message, AIMessage):
                return message
            return AIMessage(content=str(getattr(message, "content", "") or ""))
        return AIMessage(content="" if data is None else str(data))

    @staticmethod
    def _chunk_from_data(data: Any) -> AIMessageChunk:
        if isinstance(data, AIMessageChunk):
            return data
        if isinstance(data, AIMessage):
            return AIMessageChunk(
                content=data.content,
                additional_kwargs=dict(data.additional_kwargs),
                response_metadata=dict(data.response_metadata),
                id=data.id,
                tool_call_chunks=[
                    {
                        "name": call.get("name"),
                        "args": call.get("args"),
                        "id": call.get("id"),
                        "index": index,
                    }
                    for index, call in enumerate(data.tool_calls)
                ],
            )
        if isinstance(data, OrchestratorInferChatChunk):
            return AIMessageChunk(
                content=data.delta,
                response_metadata={"finish_reason": data.finish_reason},
                tool_call_chunks=[
                    {
                        "name": call.get("name"),
                        "args": call.get("args"),
                        "id": call.get("id"),
                        "index": call.get("index", index),
                    }
                    for index, call in enumerate(data.tool_call_chunks)
                ],
            )
        if isinstance(data, dict):
            if any(key in data for key in ("delta", "text", "is_final")):
                try:
                    return RemoteMeshChatModel._chunk_from_data(
                        OrchestratorInferChatChunk.model_validate(data)
                    )
                except Exception:
                    pass
            delta = _extract_openai_delta_dict(data)
            chunk = _convert_delta_to_message_chunk(delta, AIMessageChunk)
            if isinstance(chunk, AIMessageChunk):
                return chunk
            return AIMessageChunk(content=str(getattr(chunk, "content", "") or ""))
        return AIMessageChunk(content="" if data is None else str(data))


def _extract_openai_message_dict(data: dict[str, Any]) -> dict[str, Any]:
    if isinstance(data.get("message"), dict):
        message = dict(data["message"])
        message.setdefault("role", "assistant")
        return message
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0]
        if isinstance(choice, dict):
            if isinstance(choice.get("message"), dict):
                message = dict(choice["message"])
                message.setdefault("role", "assistant")
                return message
            if isinstance(choice.get("delta"), dict):
                return {"role": "assistant", **choice["delta"]}
    if "role" in data or "tool_calls" in data:
        return {"role": "assistant", **data}
    return {
        "role": "assistant",
        "content": data.get("content") or data.get("text") or data.get("delta") or "",
        **({"tool_calls": data["tool_calls"]} if "tool_calls" in data else {}),
    }


def _extract_openai_delta_dict(data: dict[str, Any]) -> dict[str, Any]:
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0]
        if isinstance(choice, dict):
            if isinstance(choice.get("delta"), dict):
                return choice["delta"]
            if isinstance(choice.get("message"), dict):
                message = dict(choice["message"])
                message.setdefault("role", "assistant")
                return message
    if isinstance(data.get("delta"), dict):
        return data["delta"]
    if "role" in data or "tool_calls" in data:
        return {"role": "assistant", **data}
    return {
        "role": "assistant",
        "content": data.get("delta") or data.get("content") or data.get("text") or "",
        **({"tool_calls": data["tool_calls"]} if "tool_calls" in data else {}),
    }
