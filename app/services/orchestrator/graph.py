"""LangGraph orchestration for Aurora voice assistant.

This module manages the conversational flow using LangGraph, coordinating
between the chatbot agent and tool execution via the message bus.
"""

import asyncio
import contextlib
import contextvars
import json
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Literal, Union
from uuid import uuid4

from langchain_core.messages import AIMessage, AnyMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import tools_condition
from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import MessageBus
from app.messaging.priority_helpers import get_interactive_priority, get_system_priority
from app.services.orchestrator.agents.chatbot import chatbot
from app.services.orchestrator.state import State
from app.shared.contracts.models.db import DBExecuteSQLRequest, DBMethods
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import (
    AssistantStreamEvent,
    AssistantStreamEventKind,
    AssistantToolStreamState,
    OrchestratorPendingToolApproval,
)
from app.shared.contracts.models.tooling import (
    ToolingConfirmExecutionRequest,
    ToolingExecuteToolRequest,
    ToolingMethods,
    ToolingRequestApprovalRequest,
)
from app.shared.contracts.models.tts import TTSMethods
from app.shared.messaging.models.tts_models import TTSRequest

AssistantStreamEmitter = Callable[[AssistantStreamEvent], Awaitable[None]]
_CURRENT_STREAM_EMITTER: contextvars.ContextVar[AssistantStreamEmitter | None] = (
    contextvars.ContextVar("aurora_assistant_stream_emitter", default=None)
)
_CURRENT_RUN_CONTEXT: contextvars.ContextVar[dict[str, str] | None] = contextvars.ContextVar(
    "aurora_assistant_run_context", default=None
)

_SECRET_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "auth",
    "bearer",
    "cookie",
    "credential",
    "password",
    "secret",
    "signature",
    "token",
}
_PREVIEW_MAX_CHARS = 240
_SECRET_VALUE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)bearer\s+[a-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[^'\"\s]+"),
    re.compile(r"\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b"),
)


def _safe_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).replace("\n", " ").strip()
    if not text:
        return None
    return _redact_secret_value(text)[:_PREVIEW_MAX_CHARS]


def _is_secret_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(marker in normalized for marker in _SECRET_KEYS)


def _redact_secret_value(value: str) -> str:
    """Redact credential-looking strings even when their object key is benign."""

    text = value
    for pattern in _SECRET_VALUE_PATTERNS:
        text = pattern.sub("<redacted>", text)
    return text


def _redacted_preview(value: Any, *, depth: int = 0) -> Any:
    """Return a capped, credential-safe preview for stream event payloads."""

    if depth > 3:
        return "<truncated>"
    if isinstance(value, dict):
        preview: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 12:
                preview["…"] = "<truncated>"
                break
            key_text = str(key)
            preview[key_text] = (
                "<redacted>"
                if _is_secret_key(key_text)
                else _redacted_preview(item, depth=depth + 1)
            )
        return preview
    if isinstance(value, list | tuple):
        items = [_redacted_preview(item, depth=depth + 1) for item in list(value)[:8]]
        if len(value) > 8:
            items.append("<truncated>")
        return items
    if isinstance(value, str):
        text = _redact_secret_value(value)
        return text if len(text) <= _PREVIEW_MAX_CHARS else f"{text[:_PREVIEW_MAX_CHARS]}…"
    if isinstance(value, int | float | bool) or value is None:
        return value
    return _safe_string(value)


def _safe_result_preview(value: Any) -> dict[str, Any] | str | None:
    if value is None:
        return None
    preview = _redacted_preview(value)
    if isinstance(preview, dict | str):
        return preview
    return str(preview)[:_PREVIEW_MAX_CHARS]


def _chunk_text(chunk: Any) -> str:
    content = getattr(chunk, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                value = item.get("text") or item.get("content")
                if isinstance(value, str):
                    parts.append(value)
        return "".join(parts)
    return ""


class GraphOrchestrator:
    """Graph orchestrator using message bus for tool execution and TTS."""

    def __init__(self, bus: MessageBus):
        """Initialize the graph orchestrator.

        Args:
            bus: MessageBus instance (injected as dependency)
        """
        log_debug("Initializing GraphOrchestrator...")

        self.bus = bus
        self.pending_tool_approvals: dict[str, OrchestratorPendingToolApproval] = {}
        self._pending_tool_requests: dict[str, ToolingRequestApprovalRequest] = {}
        self._pending_tool_call_ids_by_approval_id: dict[str, str] = {}
        self._durable_pending_approvals_ready = False
        self.graph_builder = StateGraph(State)

        # Create a wrapper function to pass bus to chatbot
        async def chatbot_wrapper(state: State):
            return await chatbot(state, bus=self.bus)

        # Add nodes
        self.graph_builder.add_node("chatbot", chatbot_wrapper)
        self.graph_builder.add_node("tools", self._execute_tools_via_bus)

        # Connect chatbot to tools or end
        self.graph_builder.add_conditional_edges(
            "chatbot",
            tools_condition,
        )

        # Connect tools back to chatbot or end
        self.graph_builder.add_conditional_edges(
            "tools", self._tools_end_condition, {"END": END, "chatbot": "chatbot"}
        )

        # Set entry point
        self.graph_builder.set_entry_point("chatbot")

        # Initialize memory - store is no longer needed as RAG is handled via bus
        self.memory = MemorySaver()

        # Compile graph without store (RAG operations go through bus)
        self.graph = self.graph_builder.compile(checkpointer=self.memory)

        # Save visualization
        self._save_graph_visualization()

        log_info("GraphOrchestrator initialized successfully")

    def _save_graph_visualization(self):
        """Save graph visualization to PNG file."""
        try:
            with open("./assets/graph.png", "wb") as f:
                f.write(self.graph.get_graph().draw_mermaid_png())
            log_debug("Graph visualization saved to ./assets/graph.png")
        except Exception as e:
            log_debug(f"Could not save graph visualization: {e}")

    async def _execute_tools_via_bus(self, state: State) -> dict[str, Any]:
        """Execute tools via message bus.

        This node intercepts tool calls from the chatbot and executes them
        via the message bus instead of calling them directly.

        Args:
            state: Current graph state containing messages

        Returns:
            Updated state with tool execution results
        """
        messages = state["messages"]
        last_message = messages[-1]

        # Check if last message has tool calls
        if not hasattr(last_message, "tool_calls") or not last_message.tool_calls:
            log_debug("No tool calls found in last message")
            return {"messages": [], "approval_pending": False}

        tool_messages = []
        tool_bindings = state.get("tool_bindings", {})
        approval_candidates = state.get("approval_candidates", {})
        approval_pending = False

        # Execute each tool call via bus
        for tool_call in last_message.tool_calls:
            tool_name = tool_call["name"]
            tool_args = tool_call.get("args", {})
            tool_id = tool_call.get("id", "")
            binding = tool_bindings.get(tool_name, {}) if isinstance(tool_bindings, dict) else {}
            candidate = (
                approval_candidates.get(tool_name, {})
                if isinstance(approval_candidates, dict)
                else {}
            )
            if candidate and not binding:
                approval_pending = True
                await self._emit_tool_stream_event(
                    kind="tool.requires_action",
                    tool_call_id=tool_id,
                    tool_name=tool_name,
                    status="requires_action",
                    tool_args=tool_args,
                    candidate=candidate,
                    summary="Tool requires operator approval before execution.",
                )
                tool_messages.append(
                    await self._request_tool_approval(
                        tool_name=tool_name,
                        tool_args=tool_args,
                        tool_call_id=tool_id,
                        candidate=candidate,
                    )
                )
                continue

            request = self._tool_execution_request(tool_name, tool_args, binding)

            log_debug(
                f"Executing tool via bus: {tool_name} with args_preview: "
                f"{_redacted_preview(tool_args)}"
            )

            try:
                await self._emit_tool_stream_event(
                    kind="tool.requested",
                    tool_call_id=tool_id,
                    tool_name=tool_name,
                    status="requested",
                    tool_args=tool_args,
                    binding=binding,
                    summary="Tool call requested by assistant.",
                )
                await self._emit_tool_stream_event(
                    kind="tool.running",
                    tool_call_id=tool_id,
                    tool_name=tool_name,
                    status="running",
                    tool_args=tool_args,
                    binding=binding,
                    summary="Tool execution is running.",
                )
                # Send tool execution command via bus and wait for response
                result = await self.bus.request(
                    ToolingMethods.EXECUTE_TOOL,
                    request,
                    timeout=30.0,  # 30 second timeout for tool execution
                    priority=get_interactive_priority(),
                )

                if result.ok:
                    log_debug(f"Tool {tool_name} executed successfully")
                    await self._emit_tool_stream_event(
                        kind="tool.completed",
                        tool_call_id=tool_id,
                        tool_name=tool_name,
                        status="completed",
                        tool_args=tool_args,
                        binding=binding,
                        result_data=result.data,
                        summary="Tool execution completed.",
                    )
                    tool_messages.append(
                        ToolMessage(
                            content=str(result.data),
                            tool_call_id=tool_id,
                            name=tool_name,
                        )
                    )
                else:
                    error_msg = result.error or "Unknown error"
                    if self._execution_denial_requires_approval(result.data, error_msg):
                        approval_pending = True
                        await self._emit_tool_stream_event(
                            kind="tool.requires_action",
                            tool_call_id=tool_id,
                            tool_name=tool_name,
                            status="requires_action",
                            tool_args=tool_args,
                            candidate=binding,
                            summary="Tool requires operator approval before execution.",
                        )
                        tool_messages.append(
                            await self._request_tool_approval(
                                tool_name=tool_name,
                                tool_args=tool_args,
                                tool_call_id=tool_id,
                                candidate=binding,
                            )
                        )
                        continue
                    redacted_error_msg = _safe_string(error_msg) or "Unknown error"
                    log_error(f"Tool {tool_name} execution failed: {redacted_error_msg}")
                    await self._emit_tool_stream_event(
                        kind="tool.failed",
                        tool_call_id=tool_id,
                        tool_name=tool_name,
                        status="failed",
                        tool_args=tool_args,
                        binding=binding,
                        result_data=result.data,
                        error_details=result.data,
                        error=redacted_error_msg,
                        summary="Tool execution failed.",
                    )
                    tool_messages.append(
                        ToolMessage(
                            content=f"Error: {redacted_error_msg}",
                            tool_call_id=tool_id,
                            name=tool_name,
                        )
                    )

            except Exception as e:
                error_msg = f"Failed to execute tool via bus: {str(e)}"
                redacted_error_msg = _safe_string(error_msg) or "Failed to execute tool via bus"
                log_error(redacted_error_msg, exc_info=True)
                await self._emit_tool_stream_event(
                    kind="tool.failed",
                    tool_call_id=tool_id,
                    tool_name=tool_name,
                    status="failed",
                    tool_args=tool_args,
                    binding=binding,
                    error_details={
                        "error_type": type(e).__name__,
                        "message": _safe_string(str(e)) or type(e).__name__,
                    },
                    error=redacted_error_msg,
                    summary="Tool execution failed.",
                )
                tool_messages.append(
                    ToolMessage(
                        content=f"Error: {redacted_error_msg}",
                        tool_call_id=tool_id,
                        name=tool_name,
                    )
                )

        return {"messages": tool_messages, "approval_pending": approval_pending}

    async def _request_tool_approval(
        self,
        *,
        tool_name: str,
        tool_args: dict[str, Any],
        tool_call_id: str,
        candidate: dict[str, Any],
    ) -> ToolMessage:
        """Create an approval request instead of executing a blocked tool."""

        request = self._tool_approval_request(tool_name, tool_args, candidate)
        log_debug(f"Requesting tool approval via bus: {tool_name}")

        try:
            result = await self.bus.request(
                ToolingMethods.REQUEST_APPROVAL,
                request,
                timeout=10.0,
                priority=get_interactive_priority(),
            )
        except Exception as e:
            error_msg = f"Failed to request tool approval via bus: {str(e)}"
            redacted_error_msg = (
                _safe_string(error_msg) or "Failed to request tool approval via bus"
            )
            log_error(redacted_error_msg, exc_info=True)
            return ToolMessage(
                content=json.dumps(
                    {
                        "type": "tool_approval_request",
                        "status": "failed",
                        "tool_name": tool_name,
                        "error": redacted_error_msg,
                    },
                    sort_keys=True,
                ),
                tool_call_id=tool_call_id,
                name=tool_name,
            )

        approval_payload = self._approval_payload(
            tool_name=tool_name,
            tool_args=tool_args,
            candidate=candidate,
            result_data=result.data if result.ok else None,
            error=result.error if not result.ok else None,
        )
        if approval_payload.get("status") == "requested":
            pending = await self._record_pending_tool_approval(
                tool_name=tool_name,
                tool_args=tool_args,
                tool_call_id=tool_call_id,
                candidate=candidate,
                request=request,
                approval_payload=approval_payload,
            )
            stream_candidate = {
                **candidate,
                "pending_id": pending.pending_id,
                "approval_request_id": pending.approval_request_id,
                "expires_at": pending.expires_at,
                "policy_decision_id": pending.policy_decision_id,
            }
            await self._emit_tool_stream_event(
                kind="tool.requires_action",
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                status="requires_action",
                tool_args=tool_args,
                candidate=stream_candidate,
                summary="Tool requires operator approval before execution.",
            )
        return ToolMessage(
            content=json.dumps(approval_payload, sort_keys=True),
            tool_call_id=tool_call_id,
            name=tool_name,
        )

    async def _record_pending_tool_approval(
        self,
        *,
        tool_name: str,
        tool_args: dict[str, Any],
        tool_call_id: str,
        candidate: dict[str, Any],
        request: ToolingRequestApprovalRequest,
        approval_payload: dict[str, Any],
    ) -> OrchestratorPendingToolApproval:
        """Track exact assistant tool call state for backend approval/resume contracts."""

        run_context = _CURRENT_RUN_CONTEXT.get() or {}
        run_id = run_context.get("run_id") or f"run-{uuid4().hex[:12]}"
        thread_id = run_context.get("thread_id") or run_id
        message_id = run_context.get("message_id") or f"msg-{uuid4().hex[:12]}"
        pending_id = f"{thread_id}:{tool_call_id or uuid4().hex[:12]}"
        approval_request_id = approval_payload.get("approval_request_id")
        pending = OrchestratorPendingToolApproval(
            pending_id=pending_id,
            approval_request_id=approval_request_id,
            status="pending",
            run_id=run_id,
            thread_id=thread_id,
            session_id=run_context.get("session_id") or thread_id,
            owner_principal_id=run_context.get("owner_principal_id"),
            owner_peer_id=run_context.get("owner_peer_id"),
            message_id=message_id,
            tool_call_id=tool_call_id or pending_id,
            tool_name=tool_name,
            display_name=str(candidate.get("display_name") or tool_name),
            arguments_preview=_redacted_preview(tool_args),
            policy_decision_id=approval_payload.get("policy_decision_id"),
            correlation_id=approval_payload.get("correlation_id"),
            created_at=time.time(),
            expires_at=approval_payload.get("expires_at"),
            metadata={
                "provider_peer_id": candidate.get("provider_peer_id"),
                "provider_service_instance_id": candidate.get("provider_service_instance_id"),
                "global_tool_id": candidate.get("global_tool_id"),
                "mesh_selector": candidate.get("mesh_selector"),
            },
        )
        self.pending_tool_approvals[pending_id] = pending
        self._pending_tool_requests[pending_id] = request
        if approval_request_id:
            self._pending_tool_call_ids_by_approval_id[approval_request_id] = pending_id
        await self._persist_pending_tool_approval(pending, request)
        return pending

    async def resolve_pending_tool_approval(
        self,
        *,
        pending_id: str | None,
        approval_request_id: str | None,
        approve: bool,
        grant_scope: str,
        approver_principal_id: str | None,
        expires_at: float | None,
        include_future_tools: bool,
        reason: str | None,
        correlation_id: str | None,
    ) -> tuple[OrchestratorPendingToolApproval | None, Any | None, str | None, str | None]:
        """Resolve a pending approval and execute the exact tool call if approved."""

        resolved_id = pending_id
        if not resolved_id and approval_request_id:
            resolved_id = self._pending_tool_call_ids_by_approval_id.get(approval_request_id)
        if not resolved_id:
            return None, None, None, "pending_approval_not_found"
        pending = self.pending_tool_approvals.get(resolved_id)
        request = self._pending_tool_requests.get(resolved_id)
        if not pending or not request:
            return None, None, None, "pending_approval_not_found"
        if pending.status not in {"pending", "failed"}:
            return pending, None, None, f"pending_approval_already_{pending.status}"
        if not approve:
            if pending.approval_request_id or approval_request_id:
                await self.bus.request(
                    ToolingMethods.CONFIRM_EXECUTION,
                    ToolingConfirmExecutionRequest(
                        approval_request_id=pending.approval_request_id
                        or approval_request_id
                        or "",
                        approver_principal_id=approver_principal_id or "system",
                        approve=False,
                        grant_scope=grant_scope,  # type: ignore[arg-type]
                        expires_at=expires_at,
                        include_future_tools=include_future_tools,
                        reason=reason,
                        correlation_id=correlation_id or pending.correlation_id,
                    ),
                    timeout=10.0,
                    priority=get_interactive_priority(),
                )
            pending.status = "denied"
            await self._update_pending_tool_approval_status(pending)
            denial_result = {
                "ok": False,
                "status": "denied",
                "error_code": "approval_denied",
                "message": reason or "Tool execution was denied by the user.",
                "approval_request_id": pending.approval_request_id or approval_request_id,
                "policy_decision_id": pending.policy_decision_id,
            }
            assistant_text = await self._resume_graph_after_tool_result(
                pending=pending,
                tool_name=pending.tool_name,
                tool_result=denial_result,
            )
            return pending, None, assistant_text, None

        confirmation = await self.bus.request(
            ToolingMethods.CONFIRM_EXECUTION,
            ToolingConfirmExecutionRequest(
                approval_request_id=pending.approval_request_id or approval_request_id or "",
                approver_principal_id=approver_principal_id or "system",
                approve=True,
                grant_scope=grant_scope,  # type: ignore[arg-type]
                expires_at=expires_at,
                include_future_tools=include_future_tools,
                reason=reason,
                correlation_id=correlation_id or pending.correlation_id,
            ),
            timeout=10.0,
            priority=get_interactive_priority(),
        )
        if not confirmation.ok:
            pending.status = "failed"
            await self._update_pending_tool_approval_status(pending)
            return pending, None, None, confirmation.error or "approval_confirmation_failed"
        confirmation_data = confirmation.data or {}
        token = (
            confirmation_data.get("approval_token")
            if isinstance(confirmation_data, dict)
            else getattr(confirmation_data, "approval_token", None)
        )
        if not token:
            pending.status = "failed"
            await self._update_pending_tool_approval_status(pending)
            return pending, None, None, "approval_token_missing"

        execution = await self.bus.request(
            ToolingMethods.EXECUTE_TOOL,
            request.model_copy(update={"approval_token": token, "confirmed": True}),
            timeout=30.0,
            priority=get_interactive_priority(),
        )
        if not execution.ok:
            pending.status = "failed"
            await self._update_pending_tool_approval_status(pending)
            return pending, None, None, execution.error or "tool_execution_failed"
        pending.status = "executed"
        await self._update_pending_tool_approval_status(pending)
        assistant_text = await self._resume_graph_after_tool_result(
            pending=pending,
            tool_name=pending.tool_name,
            tool_result=execution.data,
        )
        return pending, execution.data, assistant_text, None

    def get_pending_tool_approval(
        self,
        *,
        pending_id: str | None = None,
        approval_request_id: str | None = None,
    ) -> OrchestratorPendingToolApproval | None:
        """Return an in-memory pending approval by either public identifier."""

        resolved_id = pending_id
        if not resolved_id and approval_request_id:
            resolved_id = self._pending_tool_call_ids_by_approval_id.get(approval_request_id)
        if not resolved_id:
            return None
        return self.pending_tool_approvals.get(resolved_id)

    async def _resume_graph_after_tool_result(
        self,
        *,
        pending: OrchestratorPendingToolApproval,
        tool_name: str,
        tool_result: Any,
    ) -> str | None:
        """Continue the same LangGraph thread with the approved tool result."""

        try:
            result = await self.graph.ainvoke(
                {
                    "messages": [
                        ToolMessage(
                            content=str(tool_result),
                            tool_call_id=pending.tool_call_id,
                            name=tool_name,
                        )
                    ]
                },
                config={"configurable": {"thread_id": pending.thread_id}},
            )
        except Exception as error:
            log_error(
                f"Failed to resume assistant after tool approval: {_safe_string(str(error))}",
                exc_info=True,
            )
            pending.metadata["resume_error"] = type(error).__name__
            await self._update_pending_tool_approval_status(pending)
            return None

        messages: list[AnyMessage] = []
        if isinstance(result, dict):
            raw_messages = result.get("messages")
            if isinstance(raw_messages, list):
                messages = raw_messages
        elif hasattr(result, "messages") and isinstance(result.messages, list):
            messages = result.messages
        for message in reversed(messages):
            if isinstance(message, AIMessage) and message.content:
                content = message.content
                if isinstance(content, str):
                    pending.metadata["assistant_text"] = content
                    await self._update_pending_tool_approval_status(pending)
                    return content
                if isinstance(content, list):
                    text = "".join(
                        part.get("text", "")
                        for part in content
                        if isinstance(part, dict) and isinstance(part.get("text"), str)
                    ).strip()
                    if text:
                        pending.metadata["assistant_text"] = text
                        await self._update_pending_tool_approval_status(pending)
                        return text
        return None

    @staticmethod
    def _execution_denial_requires_approval(result_data: Any, error_msg: str) -> bool:
        """Return whether a Tooling.ExecuteTool denial should become approval UI."""

        data = result_data.model_dump() if hasattr(result_data, "model_dump") else result_data
        if not isinstance(data, dict):
            return "approval" in (error_msg or "").lower()
        error_code = str(data.get("error_code") or "")
        status = str(data.get("status") or "")
        policy_decision = data.get("policy_decision") or {}
        return (
            error_code.startswith("approval_token")
            or error_code == "approval_required"
            or status == "requires_action"
            or bool(isinstance(policy_decision, dict) and policy_decision.get("approval_required"))
        )

    async def initialize_durable_pending_approvals(self) -> None:
        """Load pending approval continuation state from durable DB storage."""

        try:
            await self._ensure_pending_approval_table()
            rows = await self._db_sql(
                """
                SELECT pending_json, request_json FROM orchestrator_pending_tool_approvals
                WHERE status IN ('pending', 'failed')
                  AND (expires_at IS NULL OR expires_at > ?)
                ORDER BY created_at ASC
                """,
                [time.time()],
            )
            for row in rows:
                pending = OrchestratorPendingToolApproval.model_validate(
                    json.loads(row["pending_json"])
                )
                request = ToolingRequestApprovalRequest.model_validate(
                    json.loads(row["request_json"])
                )
                self.pending_tool_approvals[pending.pending_id] = pending
                self._pending_tool_requests[pending.pending_id] = request
                if pending.approval_request_id:
                    self._pending_tool_call_ids_by_approval_id[pending.approval_request_id] = (
                        pending.pending_id
                    )
            self._durable_pending_approvals_ready = True
        except Exception as error:
            log_debug(f"Durable pending approval storage unavailable: {error}")
            self._durable_pending_approvals_ready = False

    async def _ensure_pending_approval_table(self) -> None:
        await self._db_sql(
            """
            CREATE TABLE IF NOT EXISTS orchestrator_pending_tool_approvals (
                pending_id TEXT PRIMARY KEY,
                approval_request_id TEXT,
                status TEXT NOT NULL,
                pending_json TEXT NOT NULL,
                request_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                expires_at REAL
            )
            """
        )

    async def _db_sql(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        result = await self.bus.request(
            DBMethods.EXECUTE_SQL,
            DBExecuteSQLRequest(sql=sql, params=params or []),
            timeout=10.0,
            priority=get_system_priority(),
        )
        if not result.ok:
            raise RuntimeError(result.error or "DB.ExecuteSQL failed")
        data = result.data
        if hasattr(data, "rows"):
            return list(data.rows)
        if isinstance(data, dict):
            return list(data.get("rows") or [])
        return []

    async def _persist_pending_tool_approval(
        self,
        pending: OrchestratorPendingToolApproval,
        request: ToolingRequestApprovalRequest,
    ) -> None:
        if not self._durable_pending_approvals_ready:
            return
        try:
            await self._db_sql(
                """
                INSERT OR REPLACE INTO orchestrator_pending_tool_approvals (
                    pending_id, approval_request_id, status, pending_json, request_json,
                    created_at, updated_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    pending.pending_id,
                    pending.approval_request_id,
                    pending.status,
                    json.dumps(pending.model_dump(mode="json"), sort_keys=True, default=str),
                    json.dumps(request.model_dump(mode="json"), sort_keys=True, default=str),
                    pending.created_at,
                    time.time(),
                    pending.expires_at,
                ],
            )
        except Exception as error:
            log_debug(f"Failed to persist pending tool approval: {error}")

    async def _update_pending_tool_approval_status(
        self, pending: OrchestratorPendingToolApproval
    ) -> None:
        if not self._durable_pending_approvals_ready:
            return
        try:
            await self._db_sql(
                """
                UPDATE orchestrator_pending_tool_approvals
                SET status = ?, pending_json = ?, updated_at = ?
                WHERE pending_id = ?
                """,
                [
                    pending.status,
                    json.dumps(pending.model_dump(mode="json"), sort_keys=True, default=str),
                    time.time(),
                    pending.pending_id,
                ],
            )
        except Exception as error:
            log_debug(f"Failed to update pending tool approval status: {error}")

    async def _emit_tool_stream_event(
        self,
        *,
        kind: AssistantStreamEventKind,
        tool_call_id: str,
        tool_name: str,
        status: Literal["requested", "running", "completed", "failed", "requires_action"],
        tool_args: dict[str, Any],
        binding: dict[str, Any] | None = None,
        candidate: dict[str, Any] | None = None,
        result_data: Any | None = None,
        error: str | None = None,
        error_details: Any | None = None,
        summary: str = "",
    ) -> None:
        """Emit a redacted tool stream event if a stream sink is active."""

        emitter = _CURRENT_STREAM_EMITTER.get()
        if emitter is None:
            return

        binding = binding if isinstance(binding, dict) else {}
        candidate = candidate if isinstance(candidate, dict) else {}
        tool_state = AssistantToolStreamState(
            tool_call_id=tool_call_id or tool_name,
            tool_name=tool_name,
            display_name=str(
                binding.get("display_name")
                or candidate.get("display_name")
                or candidate.get("name")
                or tool_name
            ),
            status=status,
            summary=summary,
            risk_class=_safe_string(binding.get("risk_class") or candidate.get("risk_class")),
            target=_safe_string(binding.get("target") or candidate.get("target")),
            provider_id=_safe_string(binding.get("provider_id") or candidate.get("provider_id")),
            data_leaves_device=bool(
                binding.get("data_leaves_device") or candidate.get("data_leaves_device") or False
            ),
            redacted_args_preview=_redacted_preview(tool_args),
            result_preview=_safe_result_preview(result_data),
            error=_safe_string(error),
            error_details=_safe_result_preview(error_details),
            policy_decision_id=_safe_string(
                candidate.get("policy_decision_id") or binding.get("policy_decision_id")
            ),
            pending_id=_safe_string(candidate.get("pending_id") or binding.get("pending_id")),
            approval_request_id=_safe_string(
                candidate.get("approval_request_id") or binding.get("approval_request_id")
            ),
            approval_expires_at=candidate.get("expires_at")
            if isinstance(candidate.get("expires_at"), (int, float))
            else None,
        )
        await emitter(
            AssistantStreamEvent(
                kind=kind,
                tool=tool_state,
                metadata={
                    "tool_name": tool_name,
                    "tool_status": status,
                    "pending_id": tool_state.pending_id,
                    "approval_request_id": tool_state.approval_request_id,
                    "approval_expires_at": tool_state.approval_expires_at,
                },
            )
        )

    @staticmethod
    def _tool_execution_request(
        tool_name: str, tool_args: dict[str, Any], binding: dict[str, Any]
    ) -> ToolingExecuteToolRequest:
        """Build a Tooling execution request from hidden binding metadata."""

        request_tool_name = binding.get("tool_name") or tool_name
        run_context = _CURRENT_RUN_CONTEXT.get() or {}
        mesh_selector_data = binding.get("mesh_selector")
        mesh_selector = None
        if isinstance(mesh_selector_data, dict):
            mesh_selector = MeshAddressSelector(
                **{key: value for key, value in mesh_selector_data.items() if value is not None}
            )

        return ToolingExecuteToolRequest(
            tool_name=request_tool_name,
            arguments=tool_args,
            mesh_selector=mesh_selector,
            caller_principal_id=binding.get("caller_principal_id")
            or run_context.get("owner_principal_id"),
            caller_peer_id=binding.get("caller_peer_id") or run_context.get("owner_peer_id"),
            caller_device_id=binding.get("caller_device_id") or run_context.get("owner_device_id"),
        )

    @classmethod
    def _tool_approval_request(
        cls, tool_name: str, tool_args: dict[str, Any], candidate: dict[str, Any]
    ) -> ToolingRequestApprovalRequest:
        """Build a Tooling approval request from hidden candidate metadata."""

        execution_request = cls._tool_execution_request(tool_name, tool_args, candidate)
        run_context = _CURRENT_RUN_CONTEXT.get() or {}
        return ToolingRequestApprovalRequest(
            **execution_request.model_dump(),
            requested_by_principal_id=(
                candidate.get("requested_by_principal_id") or run_context.get("owner_principal_id")
            ),
        )

    @staticmethod
    def _approval_payload(
        *,
        tool_name: str,
        tool_args: dict[str, Any],
        candidate: dict[str, Any],
        result_data: Any,
        error: str | None,
    ) -> dict[str, Any]:
        """Return a structured UI/session approval card payload."""

        if hasattr(result_data, "model_dump"):
            data = result_data.model_dump()
        elif isinstance(result_data, dict):
            data = result_data
        else:
            data = {}

        policy_decision = data.get("policy_decision") or {}
        return {
            "type": "tool_approval_request",
            "status": "requested" if data.get("ok") else "failed",
            "tool_name": tool_name,
            "display_name": candidate.get("display_name") or tool_name,
            "description": candidate.get("description") or "",
            "arguments": _redacted_preview(tool_args),
            "arguments_redacted": True,
            "args_schema": candidate.get("args_schema") or {},
            "approval_request_id": data.get("approval_request_id"),
            "expires_at": data.get("expires_at"),
            "correlation_id": data.get("correlation_id"),
            "policy_decision_id": policy_decision.get("decision_id"),
            "approval_mode": policy_decision.get("approval_mode"),
            "reason_code": candidate.get("reason_code"),
            "reason": _safe_string(error or data.get("error") or candidate.get("reason")),
            "provider_peer_id": candidate.get("provider_peer_id"),
            "provider_service_instance_id": candidate.get("provider_service_instance_id"),
            "global_tool_id": candidate.get("global_tool_id"),
            "mesh_selector": candidate.get("mesh_selector"),
            "safety_class": candidate.get("safety_class"),
            "execution_location": candidate.get("execution_location"),
            "required_permissions": candidate.get("required_permissions") or [],
        }

    def _tools_end_condition(
        self,
        state: list[AnyMessage] | dict[str, Any] | BaseModel,
        messages_key: str = "messages",
    ) -> Literal["tools", "chatbot", "END"]:
        """Determine next step after tool execution.

        Args:
            state: Current graph state
            messages_key: Key to access messages in state

        Returns:
            Next node to execute ("chatbot" or "END")
        """
        if isinstance(state, list):
            ai_message = state[-1]
        elif (
            isinstance(state, dict)
            and (messages := state.get(messages_key, []))
            or (messages := getattr(state, messages_key, []))
        ):
            ai_message = messages[-1]
        else:
            raise ValueError(f"No messages found in input state to tool_edge: {state}")

        if isinstance(state, dict) and state.get("approval_pending"):
            return "END"

        if hasattr(ai_message, "content") and ai_message.content == "END":
            return "END"

        if isinstance(ai_message, ToolMessage):
            try:
                payload = json.loads(ai_message.content) if isinstance(ai_message.content, str) else {}
            except json.JSONDecodeError:
                payload = {}
            if (
                isinstance(payload, dict)
                and payload.get("type") == "tool_approval_request"
                and payload.get("status") == "requested"
            ):
                return "END"

        return "chatbot"

    @staticmethod
    def _checkpoint_thread_id(thread_id: str | None = None) -> str:
        """Return a stable LangGraph checkpoint thread id for a session/request."""

        if thread_id:
            if thread_id.startswith(("aurora-session-", "aurora-request-")):
                return thread_id
            safe = "".join(
                char if char.isalnum() or char in {"-", "_", ":"} else "_" for char in thread_id
            )
            return f"aurora-session-{safe}"
        return f"aurora-request-{uuid4()}"

    async def _send_tts_via_bus(self, text: str, interrupt: bool = False):
        """Send TTS request via message bus.

        Args:
            text: Text to convert to speech
            interrupt: Whether to interrupt current playback
        """
        try:
            log_debug(f"Sending TTS request via bus: {text[:50]}...")
            await self.bus.publish(
                TTSMethods.REQUEST,
                TTSRequest(text=text, interrupt=interrupt),
                event=False,
                priority=get_interactive_priority(),
                origin="internal",
            )
        except Exception as e:
            log_error(f"Failed to send TTS request via bus: {e}", exc_info=True)

    async def stream_graph_events(
        self,
        user_input: str,
        *,
        thread_id: str | None = None,
        session_id: str | None = None,
        owner_principal_id: str | None = None,
        owner_peer_id: str | None = None,
    ) -> AsyncIterator[AssistantStreamEvent]:
        """Process user input and yield normalized assistant stream events.

        LangGraph/LangChain streaming is normalized here so every transport
        sees the same typed assistant delta/tool/completion contract. Providers
        without token streaming still complete through ``stream_graph_updates``.
        """

        input_content = user_input.text if hasattr(user_input, "text") else user_input
        thread_id = self._checkpoint_thread_id(thread_id)
        config = {"configurable": {"thread_id": thread_id}}
        event_queue: asyncio.Queue[AssistantStreamEvent | BaseException | None] = asyncio.Queue()
        final_text = ""
        saw_delta = False

        async def emit(event: AssistantStreamEvent) -> None:
            # Tool execution happens inside graph nodes and can block the next
            # LangGraph callback. Queue directly so UI/SSE subscribers see
            # requested/running/failed/completed states immediately instead of
            # only after the tool call or full graph finishes.
            await event_queue.put(event)

        async def produce_graph_events() -> None:
            nonlocal final_text, saw_delta
            token = _CURRENT_STREAM_EMITTER.set(emit)
            run_token = _CURRENT_RUN_CONTEXT.set(
                {
                    "run_id": thread_id,
                    "thread_id": thread_id,
                    "session_id": session_id or thread_id,
                    "owner_principal_id": owner_principal_id,
                    "owner_peer_id": owner_peer_id,
                    "message_id": f"msg-{uuid4().hex[:12]}",
                }
            )
            try:
                log_debug(f"Graph: Streaming input: {str(input_content)[:30]}...")
                async for raw_event in self.graph.astream_events(
                    input={"messages": [{"role": "user", "content": input_content}]},
                    config=config,
                    version="v2",
                ):
                    event_name = raw_event.get("event")
                    data = raw_event.get("data") if isinstance(raw_event, dict) else {}
                    data = data if isinstance(data, dict) else {}
                    if event_name == "on_chat_model_stream":
                        delta = _chunk_text(data.get("chunk"))
                        if delta:
                            saw_delta = True
                            final_text += delta
                            await event_queue.put(
                                AssistantStreamEvent(
                                    kind="assistant.delta", delta=delta, text=final_text
                                )
                            )
                    elif event_name == "on_chat_model_end" and not saw_delta:
                        output = data.get("output")
                        text = _chunk_text(output)
                        if text:
                            final_text = text
                            saw_delta = True
                            await event_queue.put(
                                AssistantStreamEvent(
                                    kind="assistant.delta",
                                    delta=text,
                                    text=final_text,
                                )
                            )
            except (AttributeError, NotImplementedError) as e:
                log_info(f"Graph streaming unavailable; falling back to final response: {e}")
                final_text = await self.stream_graph_updates(
                    str(input_content),
                    tts_result=False,
                    thread_id=thread_id,
                    session_id=session_id,
                    owner_principal_id=owner_principal_id,
                    owner_peer_id=owner_peer_id,
                )
                if final_text and final_text != "END":
                    await event_queue.put(
                        AssistantStreamEvent(
                            kind="assistant.delta", delta=final_text, text=final_text
                        )
                    )
            except BaseException as e:
                await event_queue.put(e)
            finally:
                _CURRENT_RUN_CONTEXT.reset(run_token)
                _CURRENT_STREAM_EMITTER.reset(token)
                await event_queue.put(None)

        producer = asyncio.create_task(produce_graph_events())
        try:
            while True:
                queued = await event_queue.get()
                if queued is None:
                    break
                if isinstance(queued, BaseException):
                    raise queued
                yield queued
            await producer
        finally:
            if not producer.done():
                producer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await producer

        if not final_text:
            try:
                snapshot = await self.graph.aget_state(config)
                messages = (snapshot.values or {}).get("messages", [])
                if messages:
                    final_text = str(getattr(messages[-1], "content", "") or "")
            except Exception as e:
                log_debug(f"Could not recover final graph state after streaming: {e}")

        if final_text != "END":
            log_info(f"Jarvis stream complete: {final_text[:100]}...")

    async def stream_graph_updates(
        self,
        user_input: str,
        tts_result: bool = True,
        *,
        thread_id: str | None = None,
        session_id: str | None = None,
        owner_principal_id: str | None = None,
        owner_peer_id: str | None = None,
    ) -> str:
        """Process user input through the graph with optional TTS output.

        Args:
            user_input: User's text input or custom message object
            tts_result: Whether to play result through TTS

        Returns:
            Assistant's response text
        """
        # Handle custom UIMessage objects
        input_content = user_input
        if hasattr(user_input, "text"):
            input_content = user_input.text
            log_debug(f"Graph: Processing input from custom object: {input_content[:30]}...")
        else:
            log_debug(f"Graph: Processing input: {str(user_input)[:30]}...")

        # Invoke the graph
        thread_id = self._checkpoint_thread_id(thread_id)
        token = _CURRENT_RUN_CONTEXT.set(
            {
                "run_id": thread_id,
                "thread_id": thread_id,
                "session_id": session_id or thread_id,
                "owner_principal_id": owner_principal_id,
                "owner_peer_id": owner_peer_id,
                "message_id": f"msg-{uuid4().hex[:12]}",
            }
        )
        try:
            response = await self.graph.ainvoke(
                input={"messages": [{"role": "user", "content": input_content}]},
                config={"configurable": {"thread_id": thread_id}},
                stream_mode="values",
            )
        finally:
            _CURRENT_RUN_CONTEXT.reset(token)

        # Get the LLM response text
        text = response["messages"][-1].content

        if text != "END":
            log_info(f"Jarvis: {text[:100]}...")
            # Send to TTS via bus if requested
            if tts_result:
                await self._send_tts_via_bus(text)
        else:
            log_debug("Graph: Response was END, not sending to TTS")

        return text

    async def process_text_input(
        self,
        user_input: str,
        *,
        thread_id: str | None = None,
        session_id: str | None = None,
        owner_principal_id: str | None = None,
        owner_peer_id: str | None = None,
    ) -> str:
        """Process text input from UI without using TTS.

        Args:
            user_input: User's text input or custom message object

        Returns:
            Assistant's response text
        """
        # Handle custom UIMessage objects
        input_content = user_input
        if hasattr(user_input, "text"):
            input_content = user_input.text
            log_debug(f"Graph: Processing UI text input from object: {input_content[:30]}...")
        else:
            log_debug(f"Graph: Processing UI text input: {str(user_input)[:30]}...")

        # Invoke the graph
        thread_id = self._checkpoint_thread_id(thread_id)
        token = _CURRENT_RUN_CONTEXT.set(
            {
                "run_id": thread_id,
                "thread_id": thread_id,
                "session_id": session_id or thread_id,
                "owner_principal_id": owner_principal_id,
                "owner_peer_id": owner_peer_id,
                "message_id": f"msg-{uuid4().hex[:12]}",
            }
        )
        try:
            response = await self.graph.ainvoke(
                input={"messages": [{"role": "user", "content": input_content}]},
                config={"configurable": {"thread_id": thread_id}},
                stream_mode="values",
            )
        finally:
            _CURRENT_RUN_CONTEXT.reset(token)

        # Get the LLM response text
        text = response["messages"][-1].content

        if text != "END":
            log_info(f"Jarvis (UI text response): {text[:100]}...")
        else:
            log_debug("Graph: Response was END, not processing further")

        return text


# Global orchestrator instance (managed by OrchestratorService)
_orchestrator: GraphOrchestrator | None = None


def set_orchestrator(orchestrator: GraphOrchestrator) -> None:
    """Set the global orchestrator instance.

    This is called by OrchestratorService during initialization.

    Args:
        orchestrator: GraphOrchestrator instance
    """
    global _orchestrator
    _orchestrator = orchestrator


def get_orchestrator() -> GraphOrchestrator:
    """Get the global graph orchestrator instance.

    Returns:
        GraphOrchestrator instance

    Raises:
        RuntimeError: If called before orchestrator is initialized
    """
    if _orchestrator is None:
        raise RuntimeError("Orchestrator not initialized. Call OrchestratorService.start() first.")

    return _orchestrator


# Backward-compatible API
async def stream_graph_updates(user_input: str, tts_result: bool = True) -> str:
    """Process user input through the graph with optional TTS output.

    This is a backward-compatible wrapper around GraphOrchestrator.

    Args:
        user_input: User's text input
        tts_result: Whether to play result through TTS

    Returns:
        Assistant's response text
    """
    orchestrator = get_orchestrator()
    return await orchestrator.stream_graph_updates(user_input, tts_result)


async def process_text_input(user_input: str) -> str:
    """Process text input from UI without using TTS.

    This is a backward-compatible wrapper around GraphOrchestrator.

    Args:
        user_input: User's text input

    Returns:
        Assistant's response text
    """
    orchestrator = get_orchestrator()
    return await orchestrator.process_text_input(user_input)
