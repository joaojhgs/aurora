"""Unit tests for GraphOrchestrator."""

import asyncio
import json
import sqlite3
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.messaging import MessageBus
from app.services.orchestrator.graph import (
    _CURRENT_RUN_CONTEXT,
    _CURRENT_STREAM_EMITTER,
    GraphOrchestrator,
)
from app.services.orchestrator.state import State
from app.shared.contracts.models.orchestrator import (
    AssistantStreamEvent,
    AssistantToolStreamState,
)


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.request = AsyncMock()
    bus.publish = AsyncMock()
    return bus


@pytest.fixture
def graph_orchestrator(mock_bus):
    """Create a GraphOrchestrator instance."""
    with (
        patch("app.services.orchestrator.graph.chatbot") as mock_chatbot,
        patch("app.services.orchestrator.graph.StateGraph"),
        patch("app.services.orchestrator.graph.MemorySaver"),
    ):
        mock_chatbot.return_value = {"messages": []}

        orchestrator = GraphOrchestrator(bus=mock_bus)
        return orchestrator


def _committed_approval_snapshot(pending, *, placeholder_id: str | None = None):
    """Build checkpoint state where an AI tool call owns its approval placeholder."""
    from langchain_core.messages import AIMessage, ToolMessage

    resolved_placeholder_id = placeholder_id or pending.metadata.get(
        "approval_placeholder_message_id"
    )
    return MagicMock(
        values={
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": pending.tool_name,
                            "args": {},
                            "id": pending.tool_call_id,
                        }
                    ],
                ),
                ToolMessage(
                    content=json.dumps({"type": "tool_approval_request", "status": "requested"}),
                    tool_call_id=pending.tool_call_id,
                    name=pending.tool_name,
                    id=resolved_placeholder_id,
                ),
            ]
        }
    )


class TestGraphOrchestratorInitialization:
    """Test GraphOrchestrator initialization."""

    def test_init(self, mock_bus):
        """Test orchestrator initialization."""
        with (
            patch("app.services.orchestrator.graph.chatbot"),
            patch("app.services.orchestrator.graph.StateGraph"),
            patch("app.services.orchestrator.graph.MemorySaver"),
            patch("app.services.orchestrator.graph.GraphOrchestrator._save_graph_visualization"),
        ):
            orchestrator = GraphOrchestrator(bus=mock_bus)
            assert orchestrator.bus == mock_bus

    def test_graph_compilation(self, mock_bus):
        """Test graph compilation."""
        with (
            patch("app.services.orchestrator.graph.chatbot"),
            patch("app.services.orchestrator.graph.StateGraph") as mock_graph_builder,
            patch("app.services.orchestrator.graph.MemorySaver"),
            patch("app.services.orchestrator.graph.GraphOrchestrator._save_graph_visualization"),
        ):
            mock_graph = MagicMock()
            mock_graph_builder_instance = MagicMock()
            mock_graph_builder_instance.add_node = Mock()
            mock_graph_builder_instance.add_conditional_edges = Mock()
            mock_graph_builder_instance.set_entry_point = Mock()
            mock_graph_builder_instance.compile.return_value = mock_graph
            mock_graph_builder.return_value = mock_graph_builder_instance

            orchestrator = GraphOrchestrator(bus=mock_bus)

            # Verify initialization completed
            assert orchestrator.graph is not None

    def test_graph_compiles_without_store(self, mock_bus):
        """Test graph compiles without store parameter."""
        with (
            patch("app.services.orchestrator.graph.chatbot"),
            patch("app.services.orchestrator.graph.StateGraph") as mock_graph_builder,
            patch("app.services.orchestrator.graph.MemorySaver"),
            patch("app.services.orchestrator.graph.GraphOrchestrator._save_graph_visualization"),
        ):
            mock_graph = MagicMock()
            mock_graph_builder_instance = MagicMock()
            mock_graph_builder_instance.add_node = Mock()
            mock_graph_builder_instance.add_conditional_edges = Mock()
            mock_graph_builder_instance.set_entry_point = Mock()
            mock_graph_builder_instance.compile.return_value = mock_graph
            mock_graph_builder.return_value = mock_graph_builder_instance

            orchestrator = GraphOrchestrator(bus=mock_bus)

            # Verify graph exists
            assert orchestrator.graph is not None


class TestGraphOrchestratorToolExecution:
    """Test GraphOrchestrator tool execution via bus."""

    @pytest.mark.asyncio
    async def test_execute_tools_via_bus(self, graph_orchestrator, mock_bus):
        """Test tool execution via bus."""
        from langchain_core.messages import AIMessage, ToolMessage

        from app.messaging import QueryResult

        # Mock successful tool execution response

        mock_bus.request.return_value = QueryResult(ok=True, data="Tool result")

        # Create state with tool calls
        ai_message = AIMessage(
            content="",
            tool_calls=[{"name": "test_tool", "args": {"input": "test"}, "id": "tool_123"}],
        )

        state = State(messages=[ai_message])

        result = await graph_orchestrator._execute_tools_via_bus(state)

        # Verify tool was executed via bus
        mock_bus.request.assert_called_once()
        request = mock_bus.request.await_args.args[1]
        assert request.tool_name == "test_tool"
        assert request.mesh_selector is None

        # Verify result contains tool messages
        assert "messages" in result
        assert len(result["messages"]) == 1
        assert isinstance(result["messages"][0], ToolMessage)

    @pytest.mark.asyncio
    async def test_execute_remote_tool_uses_hidden_provider_binding(
        self, graph_orchestrator, mock_bus
    ):
        """Remote tool selections execute with global ID and mesh selector."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult

        mock_bus.request.return_value = QueryResult(ok=True, data="remote result")

        ai_message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "raspi-lab_switch_on",
                    "args": {"target": "lamp"},
                    "id": "tool_remote",
                }
            ],
        )
        state = State(
            messages=[ai_message],
            tool_bindings={
                "raspi-lab_switch_on": {
                    "tool_name": "raspi-lab:remote_raspi-lab_Tooling:tool:switch_on",
                    "global_tool_id": "raspi-lab:remote_raspi-lab_Tooling:tool:switch_on",
                    "mesh_selector": {
                        "peer_id": "raspi-lab",
                        "provider_id": "raspi-lab",
                        "service_instance_id": "remote:raspi-lab:Tooling",
                        "tool_id": "raspi-lab:remote_raspi-lab_Tooling:tool:switch_on",
                    },
                }
            },
        )

        result = await graph_orchestrator._execute_tools_via_bus(state)

        mock_bus.request.assert_called_once()
        request = mock_bus.request.await_args.args[1]
        assert request.tool_name == "raspi-lab:remote_raspi-lab_Tooling:tool:switch_on"
        assert request.mesh_selector.peer_id == "raspi-lab"
        assert request.mesh_selector.service_instance_id == "remote:raspi-lab:Tooling"
        assert request.mesh_selector.tool_id == request.tool_name
        assert result["messages"][0].content == "remote result"

    @pytest.mark.asyncio
    async def test_catalog_binding_executes_after_policy_says_approval_not_required(
        self, graph_orchestrator, mock_bus
    ):
        """Bindable catalog tools precheck policy, then run only when approval is not required."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingMethods

        mock_bus.request.side_effect = [
            QueryResult(
                ok=True,
                data={
                    "ok": True,
                    "approval_request_id": None,
                    "correlation_id": "policy-ok",
                    "policy_decision": {
                        "decision_id": "decision-ok",
                        "approval_required": False,
                    },
                },
            ),
            QueryResult(ok=True, data="tool ran"),
        ]

        ai_message = AIMessage(
            content="",
            tool_calls=[{"name": "search", "args": {"query": "aurora"}, "id": "tool-search"}],
        )
        state = State(
            messages=[ai_message],
            tool_bindings={
                "search": {
                    "tool_name": "search",
                    "display_name": "Search",
                    "execution_location": "local",
                    "source_type": "local",
                    "safety_class": "standard",
                    "trust_tier": "trusted",
                    "capability_class": "read",
                    "confirmation_required": False,
                }
            },
        )

        result = await graph_orchestrator._execute_tools_via_bus(state)

        assert mock_bus.request.await_args_list[0].args[0] == ToolingMethods.REQUEST_APPROVAL
        assert mock_bus.request.await_args_list[1].args[0] == ToolingMethods.EXECUTE_TOOL
        assert result["messages"][0].content == "tool ran"
        assert result["approval_pending"] is False

    @pytest.mark.asyncio
    async def test_approval_required_remote_tool_requests_approval(
        self, graph_orchestrator, mock_bus
    ):
        """Blocked remote tool selections create approval interrupts."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingMethods

        mock_bus.request.return_value = QueryResult(
            ok=True,
            data={
                "ok": True,
                "approval_request_id": "approval-123",
                "expires_at": 12345.0,
                "correlation_id": "corr-123",
                "policy_decision": {
                    "decision_id": "decision-123",
                    "approval_mode": "ask_each_time",
                },
            },
        )

        ai_message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "raspi-lab_unlock_door",
                    "args": {"door": "front"},
                    "id": "tool_approval",
                }
            ],
        )
        state = State(
            messages=[ai_message],
            approval_candidates={
                "raspi-lab_unlock_door": {
                    "tool_name": "raspi-lab:remote_raspi-lab_Tooling:tool:unlock_door",
                    "global_tool_id": "raspi-lab:remote_raspi-lab_Tooling:tool:unlock_door",
                    "provider_peer_id": "raspi-lab",
                    "provider_label": "Raspberry Pi Lab",
                    "provider_service_instance_id": "remote:raspi-lab:Tooling",
                    "display_name": "raspi-lab.unlock_door",
                    "description": "Unlock a door.",
                    "args_schema": {"type": "object", "properties": {}},
                    "execution_location": "remote",
                    "safety_class": "dangerous",
                    "required_permissions": ["Tooling.ExecuteTool"],
                    "reason_code": "confirmation_required",
                    "reason": "approval required",
                    "mesh_selector": {
                        "peer_id": "raspi-lab",
                        "provider_id": "raspi-lab",
                        "service_instance_id": "remote:raspi-lab:Tooling",
                        "tool_id": "raspi-lab:remote_raspi-lab_Tooling:tool:unlock_door",
                    },
                }
            },
        )

        result = await graph_orchestrator._execute_tools_via_bus(state)

        mock_bus.request.assert_called_once()
        assert mock_bus.request.await_args.args[0] == ToolingMethods.REQUEST_APPROVAL
        request = mock_bus.request.await_args.args[1]
        assert request.tool_name == "raspi-lab:remote_raspi-lab_Tooling:tool:unlock_door"
        assert request.arguments == {"door": "front"}
        assert request.mesh_selector.peer_id == "raspi-lab"
        payload = json.loads(result["messages"][0].content)
        assert payload["type"] == "tool_approval_request"
        assert payload["status"] == "requested"
        assert payload["approval_request_id"] == "approval-123"
        assert payload["policy_decision_id"] == "decision-123"
        assert payload["provider_peer_id"] == "raspi-lab"
        assert payload["global_tool_id"] == request.tool_name
        assert result["approval_pending"] is True
        assert graph_orchestrator._tools_end_condition(result) == "END"
        pending = next(iter(graph_orchestrator.pending_tool_approvals.values()))
        assert pending.approval_request_id == "approval-123"
        assert pending.tool_call_id == "tool_approval"
        assert pending.status == "pending"
        assert pending.metadata["provider_peer_id"] == "raspi-lab"
        assert pending.metadata["provider_label"] == "Raspberry Pi Lab"
        placeholder = result["messages"][0]
        assert placeholder.id
        assert pending.metadata["approval_placeholder_message_id"] == placeholder.id

    @pytest.mark.asyncio
    async def test_approval_candidate_with_binding_requests_approval_before_running(
        self, graph_orchestrator, mock_bus
    ):
        """Model-visible risky bindings must pause for approval before execution starts."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingMethods

        mock_bus.request.return_value = QueryResult(
            ok=True,
            data={
                "ok": True,
                "approval_request_id": "approval-before-run",
                "expires_at": 12345.0,
                "correlation_id": "corr-before-run",
                "policy_decision": {
                    "decision_id": "decision-before-run",
                    "approval_mode": "ask_each_time",
                },
            },
        )
        ai_message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "send_email",
                    "args": {"to": "a@example.com"},
                    "id": "tool-email",
                }
            ],
        )
        state = State(
            messages=[ai_message],
            tool_bindings={
                "send_email": {
                    "tool_name": "send_email",
                    "global_tool_id": "local:Tooling:tool:send_email",
                    "provider_peer_id": "local",
                    "provider_service_instance_id": "local:Tooling",
                    "execution_location": "local",
                    "safety_class": "dangerous",
                }
            },
            approval_candidates={
                "send_email": {
                    "tool_name": "send_email",
                    "display_name": "Send email",
                    "reason_code": "approval_required",
                    "reason": "approval required",
                }
            },
        )

        result = await graph_orchestrator._execute_tools_via_bus(state)

        mock_bus.request.assert_called_once()
        assert mock_bus.request.await_args.args[0] == ToolingMethods.REQUEST_APPROVAL
        payload = json.loads(result["messages"][0].content)
        assert payload["status"] == "requested"
        assert payload["approval_request_id"] == "approval-before-run"
        assert result["approval_pending"] is True

    @pytest.mark.asyncio
    async def test_approval_payload_redacts_secret_arguments_in_tool_message(
        self, graph_orchestrator, mock_bus
    ):
        """Approval ToolMessages should not leak raw secret arguments into graph state."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult

        mock_bus.request.return_value = QueryResult(
            ok=True,
            data={
                "ok": True,
                "approval_request_id": "approval-secret",
                "expires_at": 123.0,
                "correlation_id": "corr-secret",
                "policy_decision": {
                    "decision_id": "decision-secret",
                    "approval_mode": "ask_each_time",
                },
            },
        )
        ai_message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "send_secret",
                    "args": {"api_key": "sk-super-secret", "query": "weather"},
                    "id": "tool_secret",
                }
            ],
        )
        result = await graph_orchestrator._execute_tools_via_bus(
            State(
                messages=[ai_message],
                approval_candidates={
                    "send_secret": {
                        "tool_name": "send_secret",
                        "display_name": "send_secret",
                        "args_schema": {"type": "object", "properties": {}},
                    }
                },
            )
        )

        payload_text = result["messages"][0].content
        assert "sk-super-secret" not in payload_text
        payload = json.loads(payload_text)
        assert payload["arguments"]["api_key"] == "<redacted>"
        assert payload["arguments_redacted"] is True

    @pytest.mark.asyncio
    async def test_approval_payload_redacts_secret_failure_reason(
        self, graph_orchestrator, mock_bus
    ):
        """Approval failure strings are graph-state data and must be redacted too."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult

        mock_bus.request.return_value = QueryResult(
            ok=False,
            error="provider rejected token=sk-super-secret",
        )
        ai_message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "send_secret",
                    "args": {"query": "weather"},
                    "id": "tool_secret_reason",
                }
            ],
        )

        result = await graph_orchestrator._execute_tools_via_bus(
            State(
                messages=[ai_message],
                approval_candidates={
                    "send_secret": {
                        "tool_name": "send_secret",
                        "display_name": "send_secret",
                        "reason": "token=sk-super-secret",
                    }
                },
            )
        )

        payload_text = result["messages"][0].content
        assert "sk-super-secret" not in payload_text
        payload = json.loads(payload_text)
        assert payload["status"] == "failed"
        assert payload["reason"] == "provider rejected <redacted>"

    @pytest.mark.asyncio
    async def test_failed_approval_request_does_not_emit_actionable_card(
        self, graph_orchestrator, mock_bus
    ):
        """UI approval cards are emitted only after Tooling creates a pending approval."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult

        emitted = []

        async def capture(event):
            emitted.append(event)

        mock_bus.request.return_value = QueryResult(
            ok=False,
            error="approval backend rejected request",
        )
        ai_message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "send_email",
                    "args": {"to": "a@example.com"},
                    "id": "tool_email",
                }
            ],
        )
        token = _CURRENT_STREAM_EMITTER.set(capture)
        try:
            result = await graph_orchestrator._execute_tools_via_bus(
                State(
                    messages=[ai_message],
                    approval_candidates={
                        "send_email": {
                            "tool_name": "send_email",
                            "display_name": "Send email",
                            "reason": "approval required",
                        }
                    },
                )
            )
        finally:
            _CURRENT_STREAM_EMITTER.reset(token)

        assert emitted == []
        assert result["approval_pending"] is False
        payload = json.loads(result["messages"][0].content)
        assert payload["status"] == "failed"
        assert payload["reason"] == "approval backend rejected request"

    @pytest.mark.asyncio
    async def test_pending_approval_resume_confirms_and_executes_exact_tool(
        self, graph_orchestrator, mock_bus
    ):
        """Backend resume path confirms approval then executes the saved exact request."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval
        from app.shared.contracts.models.tooling import (
            ToolingMethods,
            ToolingRequestApprovalRequest,
        )

        pending = OrchestratorPendingToolApproval(
            pending_id="thread-1:tool-1",
            approval_request_id="approval-1",
            run_id="thread-1",
            thread_id="thread-1",
            message_id="message-1",
            tool_call_id="tool-1",
            tool_name="delete_file",
            arguments_preview={"path": "/tmp/example"},
            created_at=1.0,
            metadata={"approval_placeholder_message_id": "approval-placeholder:thread-1:tool-1"},
        )
        request = ToolingRequestApprovalRequest(
            tool_name="delete_file",
            arguments={"path": "/tmp/example"},
            caller_principal_id="principal-1",
        )
        graph_orchestrator.pending_tool_approvals[pending.pending_id] = pending
        graph_orchestrator._pending_tool_requests[pending.pending_id] = request
        graph_orchestrator._pending_tool_call_ids_by_approval_id["approval-1"] = pending.pending_id
        resolution_future = asyncio.get_running_loop().create_future()
        graph_orchestrator._pending_tool_resolution_futures[pending.pending_id] = resolution_future
        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"approval_token": "token-1"}),
            QueryResult(
                ok=True,
                data={"ok": True, "status": "success", "data": "deleted"},
            ),
        ]
        graph_orchestrator.graph.ainvoke = AsyncMock(
            return_value={"messages": [AIMessage(content="Deleted the requested file.")]}
        )
        graph_orchestrator.graph.aget_state = AsyncMock(
            return_value=_committed_approval_snapshot(pending)
        )

        (
            resolved,
            tool_result,
            assistant_text,
            error,
        ) = await graph_orchestrator.resolve_pending_tool_approval(
            pending_id=None,
            approval_request_id="approval-1",
            approve=True,
            grant_scope="session",
            approver_principal_id="admin",
            expires_at=None,
            include_future_tools=False,
            reason=None,
            correlation_id="corr-1",
        )

        assert error is None
        assert resolved.status == "executed"
        assert tool_result["status"] == "success"
        assert assistant_text == "Deleted the requested file."
        assert mock_bus.request.await_args_list[0].args[0] == ToolingMethods.CONFIRM_EXECUTION
        assert mock_bus.request.await_args_list[1].args[0] == ToolingMethods.EXECUTE_TOOL
        execute_request = mock_bus.request.await_args_list[1].args[1]
        assert execute_request.tool_name == "delete_file"
        assert execute_request.arguments == {"path": "/tmp/example"}
        assert execute_request.approval_token == "token-1"

        stream_events = [
            event
            async for event in graph_orchestrator._wait_for_tool_approval_resolution(
                futures=[resolution_future]
            )
        ]
        assert [event.kind for event in stream_events] == [
            "tool.running",
            "tool.completed",
            "assistant.delta",
        ]
        assert stream_events[0].tool is not None
        assert stream_events[0].tool.tool_call_id == "tool-1"
        assert stream_events[1].tool is not None
        assert stream_events[1].tool.tool_call_id == "tool-1"
        assert stream_events[1].tool.result_preview == {
            "ok": True,
            "status": "success",
            "data": "deleted",
        }
        assert stream_events[2].text == "Deleted the requested file."

    @pytest.mark.asyncio
    async def test_approved_tool_emits_running_before_execution_finishes(
        self, graph_orchestrator, mock_bus
    ):
        """The approval card must become running while the remote call is in flight."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval
        from app.shared.contracts.models.tooling import (
            ToolingMethods,
            ToolingRequestApprovalRequest,
        )

        pending = OrchestratorPendingToolApproval(
            pending_id="thread-live:tool-live",
            approval_request_id="approval-live",
            run_id="thread-live",
            thread_id="thread-live",
            message_id="message-live",
            tool_call_id="tool-live",
            tool_name="aurora-2_list_scheduled_tasks_tool",
            display_name="aurora-2.list_scheduled_tasks_tool",
            arguments_preview={},
            created_at=1.0,
            metadata={
                "approval_placeholder_message_id": ("approval-placeholder:thread-live:tool-live")
            },
        )
        request = ToolingRequestApprovalRequest(
            tool_name="stable-peer:remote_tooling:tool:list_scheduled_tasks_tool",
            arguments={},
            caller_principal_id="principal-1",
        )
        graph_orchestrator.pending_tool_approvals[pending.pending_id] = pending
        graph_orchestrator._pending_tool_requests[pending.pending_id] = request
        resolution_future = asyncio.get_running_loop().create_future()
        graph_orchestrator._pending_tool_resolution_futures[pending.pending_id] = resolution_future

        execution_entered = asyncio.Event()
        release_execution = asyncio.Event()
        model_entered = asyncio.Event()
        release_model = asyncio.Event()

        async def request_handler(method, request_payload, **kwargs):
            if method == ToolingMethods.CONFIRM_EXECUTION:
                return QueryResult(ok=True, data={"approval_token": "token-live"})
            assert method == ToolingMethods.EXECUTE_TOOL
            execution_entered.set()
            await release_execution.wait()
            return QueryResult(ok=True, data={"status": "success", "data": "No tasks."})

        mock_bus.request.side_effect = request_handler

        async def resume_graph(*args, **kwargs):
            model_entered.set()
            await release_model.wait()
            return {"messages": [AIMessage(content="There are no scheduled tasks.")]}

        graph_orchestrator.graph.ainvoke = AsyncMock(side_effect=resume_graph)
        graph_orchestrator.graph.aget_state = AsyncMock(
            return_value=_committed_approval_snapshot(pending)
        )

        stream = graph_orchestrator._wait_for_tool_approval_resolution(
            futures=[resolution_future]
        ).__aiter__()
        resolve_task = asyncio.create_task(
            graph_orchestrator.resolve_pending_tool_approval(
                pending_id=pending.pending_id,
                approval_request_id=None,
                approve=True,
                grant_scope="session",
                approver_principal_id="admin",
                expires_at=None,
                include_future_tools=False,
                reason=None,
                correlation_id="corr-live",
            )
        )

        await asyncio.wait_for(execution_entered.wait(), timeout=1.0)
        running = await asyncio.wait_for(stream.__anext__(), timeout=1.0)
        assert running.kind == "tool.running"
        assert resolve_task.done() is False

        release_execution.set()
        await asyncio.wait_for(model_entered.wait(), timeout=1.0)
        completed = await asyncio.wait_for(stream.__anext__(), timeout=1.0)
        assert completed.kind == "tool.completed"
        assert resolve_task.done() is False

        release_model.set()
        resolved_text = await asyncio.wait_for(stream.__anext__(), timeout=1.0)
        result = await asyncio.wait_for(resolve_task, timeout=1.0)

        assert resolved_text.kind == "assistant.delta"
        assert resolved_text.text == "There are no scheduled tasks."
        assert result[3] is None

    @pytest.mark.asyncio
    async def test_concurrent_approval_resolution_executes_tool_once(
        self, graph_orchestrator, mock_bus
    ):
        """A double-click must not confirm, execute, or resume the same tool twice."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval
        from app.shared.contracts.models.tooling import (
            ToolingMethods,
            ToolingRequestApprovalRequest,
        )

        pending = OrchestratorPendingToolApproval(
            pending_id="thread-double:tool-double",
            approval_request_id="approval-double",
            run_id="thread-double",
            thread_id="thread-double",
            message_id="message-double",
            tool_call_id="tool-double",
            tool_name="remote_schedule_tool",
            arguments_preview={},
            created_at=1.0,
            metadata={
                "approval_placeholder_message_id": (
                    "approval-placeholder:thread-double:tool-double"
                )
            },
        )
        graph_orchestrator.pending_tool_approvals[pending.pending_id] = pending
        graph_orchestrator._pending_tool_requests[pending.pending_id] = (
            ToolingRequestApprovalRequest(
                tool_name="stable-peer:remote_tooling:tool:schedule",
                arguments={},
                caller_principal_id="principal-1",
            )
        )
        graph_orchestrator._pending_tool_resolution_futures[pending.pending_id] = (
            asyncio.get_running_loop().create_future()
        )

        confirmation_entered = asyncio.Event()
        release_confirmation = asyncio.Event()

        async def request_handler(method, request_payload, **kwargs):
            if method == ToolingMethods.CONFIRM_EXECUTION:
                confirmation_entered.set()
                await release_confirmation.wait()
                return QueryResult(ok=True, data={"approval_token": "token-double"})
            assert method == ToolingMethods.EXECUTE_TOOL
            return QueryResult(ok=True, data={"status": "success", "data": "scheduled"})

        mock_bus.request.side_effect = request_handler
        graph_orchestrator.graph.ainvoke = AsyncMock(
            return_value={"messages": [AIMessage(content="Scheduled once.")]}
        )
        graph_orchestrator.graph.aget_state = AsyncMock(
            return_value=_committed_approval_snapshot(pending)
        )
        resolution_kwargs = {
            "pending_id": pending.pending_id,
            "approval_request_id": None,
            "approve": True,
            "grant_scope": "session",
            "approver_principal_id": "admin",
            "expires_at": None,
            "include_future_tools": False,
            "reason": None,
            "correlation_id": "corr-double",
        }

        first_resolution = asyncio.create_task(
            graph_orchestrator.resolve_pending_tool_approval(**resolution_kwargs)
        )
        await asyncio.wait_for(confirmation_entered.wait(), timeout=1.0)
        second_result = await graph_orchestrator.resolve_pending_tool_approval(**resolution_kwargs)

        assert second_result[3] == "pending_approval_already_resolving"
        release_confirmation.set()
        first_result = await asyncio.wait_for(first_resolution, timeout=1.0)

        assert first_result[3] is None
        assert [call.args[0] for call in mock_bus.request.await_args_list] == [
            ToolingMethods.CONFIRM_EXECUTION,
            ToolingMethods.EXECUTE_TOOL,
        ]
        graph_orchestrator.graph.ainvoke.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_successful_approved_tool_has_visible_fallback_when_llm_resume_fails(
        self, graph_orchestrator, mock_bus
    ):
        """A provider failure after execution must not erase the successful result."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval
        from app.shared.contracts.models.tooling import ToolingRequestApprovalRequest

        pending = OrchestratorPendingToolApproval(
            pending_id="thread-remote:tool-remote",
            approval_request_id="approval-remote",
            run_id="thread-remote",
            thread_id="thread-remote",
            message_id="message-remote",
            tool_call_id="tool-remote",
            tool_name="aurora-2_list_scheduled_tasks_tool",
            display_name="aurora-2.list_scheduled_tasks_tool",
            arguments_preview={},
            metadata={
                "provider_peer_id": "stable-peer",
                "provider_label": "aurora-2",
                "approval_placeholder_message_id": (
                    "approval-placeholder:thread-remote:tool-remote"
                ),
            },
            created_at=1.0,
        )
        request = ToolingRequestApprovalRequest(
            tool_name="stable-peer:remote_stable-peer_Tooling:tool:list_scheduled_tasks_tool",
            arguments={},
            caller_principal_id="principal-1",
        )
        graph_orchestrator.pending_tool_approvals[pending.pending_id] = pending
        graph_orchestrator._pending_tool_requests[pending.pending_id] = request
        graph_orchestrator._pending_tool_call_ids_by_approval_id["approval-remote"] = (
            pending.pending_id
        )
        resolution_future = asyncio.get_running_loop().create_future()
        graph_orchestrator._pending_tool_resolution_futures[pending.pending_id] = resolution_future
        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"approval_token": "token-remote"}),
            QueryResult(
                ok=True,
                data={"ok": True, "status": "success", "data": "No active tasks."},
            ),
        ]
        graph_orchestrator.graph.ainvoke = AsyncMock(
            side_effect=RuntimeError("provider rejected historical tool name")
        )
        graph_orchestrator.graph.aget_state = AsyncMock(
            return_value=_committed_approval_snapshot(pending)
        )

        (
            resolved,
            tool_result,
            assistant_text,
            error,
        ) = await graph_orchestrator.resolve_pending_tool_approval(
            pending_id=pending.pending_id,
            approval_request_id=None,
            approve=True,
            grant_scope="session",
            approver_principal_id="admin",
            expires_at=None,
            include_future_tools=False,
            reason=None,
            correlation_id="corr-remote",
        )

        assert error is None
        assert resolved is not None
        assert resolved.status == "executed"
        assert tool_result == {
            "ok": True,
            "status": "success",
            "data": "No active tasks.",
        }
        assert assistant_text
        assert "completed" in assistant_text.lower()
        assert "No active tasks" in assistant_text
        stream_events = [
            event
            async for event in graph_orchestrator._wait_for_tool_approval_resolution(
                futures=[resolution_future]
            )
        ]
        assert [event.kind for event in stream_events] == [
            "tool.running",
            "tool.completed",
            "assistant.delta",
        ]
        assert stream_events[1].tool is not None
        assert stream_events[1].tool.result_preview == tool_result
        assert stream_events[1].tool.target == "aurora-2"
        assert stream_events[1].tool.provider_id == "stable-peer"

    @pytest.mark.asyncio
    async def test_approved_result_replaces_checkpoint_approval_placeholder(
        self, graph_orchestrator
    ):
        """Resuming uses the placeholder ID so add_messages replaces rather than appends."""
        from langchain_core.messages import AIMessage, ToolMessage
        from langgraph.graph.message import add_messages

        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval

        placeholder_id = "approval-placeholder:thread-1:tool-1"
        pending = OrchestratorPendingToolApproval(
            pending_id="thread-1:tool-1",
            approval_request_id="approval-1",
            status="executed",
            run_id="thread-1",
            thread_id="thread-1",
            message_id="message-1",
            tool_call_id="tool-1",
            tool_name="delete_file",
            arguments_preview={"path": "/tmp/example"},
            created_at=1.0,
            metadata={"approval_placeholder_message_id": placeholder_id},
        )
        graph_orchestrator.graph.ainvoke = AsyncMock(
            return_value={"messages": [AIMessage(content="Deleted the file.")]}
        )
        graph_orchestrator.graph.aget_state = AsyncMock(
            return_value=_committed_approval_snapshot(pending)
        )

        assistant_text = await graph_orchestrator._resume_graph_after_tool_result(
            pending=pending,
            tool_name="delete_file",
            tool_result={"ok": True, "status": "success", "data": "deleted"},
        )

        assert assistant_text == "Deleted the file."
        resume_message = graph_orchestrator.graph.ainvoke.await_args.args[0]["messages"][0]
        assert resume_message.id == placeholder_id
        placeholder = ToolMessage(
            content=json.dumps({"type": "tool_approval_request", "status": "requested"}),
            tool_call_id="tool-1",
            name="delete_file",
            id=placeholder_id,
        )
        merged = add_messages([placeholder], [resume_message])
        assert len(merged) == 1
        assert merged[0].id == placeholder_id
        assert "deleted" in str(merged[0].content)
        graph_orchestrator.graph.aget_state.assert_awaited_once_with(
            {"configurable": {"thread_id": "thread-1"}}
        )

    @pytest.mark.asyncio
    async def test_recorded_placeholder_polls_until_active_checkpoint_commits(
        self, graph_orchestrator
    ):
        """A fast approval waits briefly for the active graph turn to commit its pause."""
        from langchain_core.messages import AIMessage

        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval

        pending = OrchestratorPendingToolApproval(
            pending_id="thread-fast:tool-fast",
            approval_request_id="approval-fast",
            status="executed",
            run_id="thread-fast",
            thread_id="thread-fast",
            message_id="message-fast",
            tool_call_id="tool-fast",
            tool_name="fast_tool",
            arguments_preview={},
            created_at=1.0,
            metadata={
                "approval_placeholder_message_id": ("approval-placeholder:thread-fast:tool-fast")
            },
        )
        graph_orchestrator._pending_tool_resolution_futures[pending.pending_id] = (
            asyncio.get_running_loop().create_future()
        )
        graph_orchestrator.graph.aget_state = AsyncMock(
            side_effect=[
                MagicMock(values={"messages": []}),
                _committed_approval_snapshot(pending),
            ]
        )
        graph_orchestrator.graph.ainvoke = AsyncMock(
            return_value={"messages": [AIMessage(content="Fast tool completed.")]}
        )

        with patch.object(asyncio, "sleep", new=AsyncMock()) as mock_sleep:
            assistant_text = await graph_orchestrator._resume_graph_after_tool_result(
                pending=pending,
                tool_name="fast_tool",
                tool_result={"ok": True, "status": "success"},
            )

        assert assistant_text == "Fast tool completed."
        assert graph_orchestrator.graph.aget_state.await_count == 2
        mock_sleep.assert_awaited_once()
        graph_orchestrator.graph.ainvoke.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_recorded_placeholder_missing_from_restored_checkpoint_fails_closed(
        self, graph_orchestrator
    ):
        """A durable pending record with an empty MemorySaver cannot append a result."""
        from langchain_core.messages import AIMessage

        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval

        pending = OrchestratorPendingToolApproval(
            pending_id="thread-restored:tool-restored",
            approval_request_id="approval-restored",
            status="executed",
            run_id="thread-restored",
            thread_id="thread-restored",
            message_id="message-restored",
            tool_call_id="tool-restored",
            tool_name="restored_tool",
            arguments_preview={},
            created_at=1.0,
            metadata={
                "approval_placeholder_message_id": (
                    "approval-placeholder:thread-restored:tool-restored"
                )
            },
        )
        graph_orchestrator.graph.aget_state = AsyncMock(
            return_value=MagicMock(values={"messages": []})
        )
        graph_orchestrator.graph.ainvoke = AsyncMock(
            return_value={"messages": [AIMessage(content="must not run")]}
        )

        assistant_text = await graph_orchestrator._resume_graph_after_tool_result(
            pending=pending,
            tool_name="restored_tool",
            tool_result={"ok": True, "status": "success", "data": "restored"},
        )

        assert "completed" in assistant_text.lower()
        graph_orchestrator.graph.aget_state.assert_awaited_once()
        graph_orchestrator.graph.ainvoke.assert_not_awaited()
        assert pending.metadata["assistant_text_fallback"] == "placeholder_not_found"

    @pytest.mark.asyncio
    async def test_recorded_placeholder_without_owning_ai_tool_call_fails_closed(
        self, graph_orchestrator
    ):
        """A placeholder is valid only when the matching assistant tool call owns it."""
        from langchain_core.messages import ToolMessage

        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval

        placeholder_id = "approval-placeholder:thread-unowned:tool-unowned"
        pending = OrchestratorPendingToolApproval(
            pending_id="thread-unowned:tool-unowned",
            approval_request_id="approval-unowned",
            status="executed",
            run_id="thread-unowned",
            thread_id="thread-unowned",
            message_id="message-unowned",
            tool_call_id="tool-unowned",
            tool_name="unowned_tool",
            arguments_preview={},
            created_at=1.0,
            metadata={"approval_placeholder_message_id": placeholder_id},
        )
        graph_orchestrator.graph.aget_state = AsyncMock(
            return_value=MagicMock(
                values={
                    "messages": [
                        ToolMessage(
                            content=json.dumps(
                                {
                                    "type": "tool_approval_request",
                                    "status": "requested",
                                }
                            ),
                            tool_call_id="tool-unowned",
                            name="unowned_tool",
                            id=placeholder_id,
                        )
                    ]
                }
            )
        )
        graph_orchestrator.graph.ainvoke = AsyncMock()

        assistant_text = await graph_orchestrator._resume_graph_after_tool_result(
            pending=pending,
            tool_name="unowned_tool",
            tool_result={"ok": True, "status": "success"},
        )

        assert "completed" in assistant_text.lower()
        graph_orchestrator.graph.ainvoke.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_approved_result_recovers_legacy_placeholder_id_from_checkpoint(
        self, graph_orchestrator
    ):
        """Pending records created before placeholder metadata recover the checkpoint ID."""
        from langchain_core.messages import AIMessage, ToolMessage

        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval

        pending = OrchestratorPendingToolApproval(
            pending_id="thread-legacy:tool-legacy",
            approval_request_id="approval-legacy",
            status="executed",
            run_id="thread-legacy",
            thread_id="thread-legacy",
            message_id="message-legacy",
            tool_call_id="tool-legacy",
            tool_name="legacy_tool",
            arguments_preview={},
            created_at=1.0,
        )
        graph_orchestrator.graph.aget_state = AsyncMock(
            return_value=_committed_approval_snapshot(
                pending,
                placeholder_id="checkpoint-placeholder-legacy",
            )
        )
        graph_orchestrator.graph.ainvoke = AsyncMock(
            return_value={"messages": [AIMessage(content="Legacy tool completed.")]}
        )

        assistant_text = await graph_orchestrator._resume_graph_after_tool_result(
            pending=pending,
            tool_name="legacy_tool",
            tool_result={"ok": True, "status": "success"},
        )

        assert assistant_text == "Legacy tool completed."
        graph_orchestrator.graph.aget_state.assert_awaited_once_with(
            {"configurable": {"thread_id": "thread-legacy"}}
        )
        resume_message = graph_orchestrator.graph.ainvoke.await_args.args[0]["messages"][0]
        assert resume_message.id == "checkpoint-placeholder-legacy"
        assert (
            pending.metadata["approval_placeholder_message_id"] == "checkpoint-placeholder-legacy"
        )

    @pytest.mark.asyncio
    async def test_pending_approval_denial_resumes_same_graph_thread(
        self, graph_orchestrator, mock_bus
    ):
        """Denying an inline approval feeds a denial ToolMessage back into the same turn."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval
        from app.shared.contracts.models.tooling import (
            ToolingMethods,
            ToolingRequestApprovalRequest,
        )

        pending = OrchestratorPendingToolApproval(
            pending_id="thread-1:tool-1",
            approval_request_id="approval-1",
            run_id="thread-1",
            thread_id="thread-1",
            message_id="message-1",
            tool_call_id="tool-1",
            tool_name="delete_file",
            arguments_preview={"path": "/tmp/example"},
            created_at=1.0,
            metadata={"approval_placeholder_message_id": "approval-placeholder:thread-1:tool-1"},
        )
        request = ToolingRequestApprovalRequest(
            tool_name="delete_file",
            arguments={"path": "/tmp/example"},
            caller_principal_id="principal-1",
        )
        graph_orchestrator.pending_tool_approvals[pending.pending_id] = pending
        graph_orchestrator._pending_tool_requests[pending.pending_id] = request
        graph_orchestrator._pending_tool_call_ids_by_approval_id["approval-1"] = pending.pending_id
        mock_bus.request.return_value = QueryResult(ok=False, error="approval_denied")
        graph_orchestrator.graph.ainvoke = AsyncMock(
            return_value={
                "messages": [
                    AIMessage(content="I did not run that tool because you denied approval.")
                ]
            }
        )
        graph_orchestrator.graph.aget_state = AsyncMock(
            return_value=_committed_approval_snapshot(pending)
        )

        (
            resolved,
            tool_result,
            assistant_text,
            error,
        ) = await graph_orchestrator.resolve_pending_tool_approval(
            pending_id=None,
            approval_request_id="approval-1",
            approve=False,
            grant_scope="deny_once",
            approver_principal_id="admin",
            expires_at=None,
            include_future_tools=False,
            reason="User denied destructive file access.",
            correlation_id="corr-1",
        )

        assert error is None
        assert resolved.status == "denied"
        assert tool_result is None
        assert assistant_text == "I did not run that tool because you denied approval."
        mock_bus.request.assert_awaited_once()
        assert mock_bus.request.await_args.args[0] == ToolingMethods.CONFIRM_EXECUTION
        graph_orchestrator.graph.ainvoke.assert_awaited_once()
        resume_payload = graph_orchestrator.graph.ainvoke.await_args.args[0]
        resume_config = graph_orchestrator.graph.ainvoke.await_args.kwargs["config"]
        tool_message = resume_payload["messages"][0]
        assert tool_message.tool_call_id == "tool-1"
        assert "approval_denied" in tool_message.content
        assert "User denied destructive file access." in tool_message.content
        assert resume_config == {"configurable": {"thread_id": "thread-1"}}

    def test_tool_approval_request_binds_current_run_owner(self):
        """Assistant-created approval requests carry owner identity into Tooling grants."""

        token = _CURRENT_RUN_CONTEXT.set(
            {
                "run_id": "run-1",
                "thread_id": "thread-1",
                "session_id": "session-1",
                "owner_principal_id": "principal-a",
                "owner_peer_id": "peer-a",
                "owner_device_id": "device-a",
            }
        )
        try:
            request = GraphOrchestrator._tool_approval_request(
                "restart_sensitive_tool",
                {"target": "calendar"},
                {"tool_name": "restart_sensitive_tool"},
            )
        finally:
            _CURRENT_RUN_CONTEXT.reset(token)

        assert request.caller_principal_id == "principal-a"
        assert request.caller_peer_id == "peer-a"
        assert request.caller_device_id == "device-a"
        assert request.requested_by_principal_id == "principal-a"

    @pytest.mark.asyncio
    async def test_approval_required_local_tool_requests_approval(
        self, graph_orchestrator, mock_bus
    ):
        """Local approval-required tools use the same interrupt path."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingMethods

        mock_bus.request.return_value = QueryResult(
            ok=True,
            data={
                "ok": True,
                "approval_request_id": "local-approval",
                "correlation_id": "local-corr",
                "policy_decision": {
                    "decision_id": "local-decision",
                    "approval_mode": "allow_once",
                },
            },
        )

        ai_message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "delete_file",
                    "args": {"path": "/tmp/example"},
                    "id": "tool_local_approval",
                }
            ],
        )
        state = State(
            messages=[ai_message],
            approval_candidates={
                "delete_file": {
                    "tool_name": "delete_file",
                    "global_tool_id": "local:Tooling:tool:delete_file",
                    "provider_peer_id": "local",
                    "provider_service_instance_id": "local:Tooling",
                    "display_name": "delete_file",
                    "execution_location": "local",
                    "safety_class": "dangerous",
                    "reason_code": "confirmation_required",
                    "reason": "approval required",
                }
            },
        )

        result = await graph_orchestrator._execute_tools_via_bus(state)

        mock_bus.request.assert_called_once()
        assert mock_bus.request.await_args.args[0] == ToolingMethods.REQUEST_APPROVAL
        request = mock_bus.request.await_args.args[1]
        assert request.tool_name == "delete_file"
        assert request.mesh_selector is None
        payload = json.loads(result["messages"][0].content)
        assert payload["approval_request_id"] == "local-approval"
        assert payload["execution_location"] == "local"

    @pytest.mark.asyncio
    async def test_bindable_tool_policy_precheck_requests_runtime_approval(
        self, graph_orchestrator, mock_bus
    ):
        """Model-visible tools ask Tooling policy for approval before running."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingMethods

        mock_bus.request.return_value = QueryResult(
            ok=True,
            data={
                "ok": True,
                "approval_request_id": "runtime-approval",
                "correlation_id": "runtime-corr",
                "policy_decision": {
                    "decision_id": "runtime-decision",
                    "approval_mode": "ask_each_time",
                },
            },
        )

        ai_message = AIMessage(
            content="",
            tool_calls=[
                {"name": "send_email", "args": {"to": "a@example.com"}, "id": "tool-email"}
            ],
        )
        state = State(
            messages=[ai_message],
            tool_bindings={
                "send_email": {
                    "tool_name": "send_email",
                    "global_tool_id": "local:Tooling:tool:send_email",
                    "provider_peer_id": "local",
                    "provider_service_instance_id": "local:Tooling",
                    "display_name": "Send email",
                    "execution_location": "local",
                    "safety_class": "dangerous",
                    "confirmation_required": True,
                }
            },
        )

        result = await graph_orchestrator._execute_tools_via_bus(state)

        mock_bus.request.assert_called_once()
        assert mock_bus.request.await_args.args[0] == ToolingMethods.REQUEST_APPROVAL
        approval_request = mock_bus.request.await_args.args[1]
        assert approval_request.tool_name == "send_email"
        assert approval_request.arguments == {"to": "a@example.com"}
        payload = json.loads(result["messages"][0].content)
        assert payload["status"] == "requested"
        assert payload["approval_request_id"] == "runtime-approval"

    @pytest.mark.asyncio
    async def test_non_actionable_approval_response_does_not_create_pending_json_card(
        self, graph_orchestrator, mock_bus
    ):
        """Approval responses without an approval_request_id become normal tool errors."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingMethods

        mock_bus.request.side_effect = [
            QueryResult(
                ok=False,
                error="approval_token_required",
                data={
                    "error_code": "approval_token_required",
                    "status": "requires_action",
                    "policy_decision": {"approval_required": True},
                },
            ),
            QueryResult(
                ok=True,
                data={
                    "ok": True,
                    "approval_request_id": None,
                    "correlation_id": "runtime-corr",
                    "policy_decision": {
                        "decision_id": "runtime-decision",
                        "approval_mode": None,
                        "approval_required": False,
                    },
                },
            ),
        ]

        ai_message = AIMessage(
            content="",
            tool_calls=[{"name": "search", "args": {"query": "news"}, "id": "tool-search"}],
        )
        state = State(
            messages=[ai_message],
            tool_bindings={"search": {"tool_name": "search", "display_name": "Search"}},
        )

        result = await graph_orchestrator._execute_tools_via_bus(state)

        assert mock_bus.request.await_args_list[0].args[0] == ToolingMethods.EXECUTE_TOOL
        assert mock_bus.request.await_args_list[1].args[0] == ToolingMethods.REQUEST_APPROVAL
        assert result["approval_pending"] is False
        assert graph_orchestrator.pending_tool_approvals == {}
        content = result["messages"][0].content
        assert content.startswith("Error: ")
        assert "tool_approval_request" not in content
        assert graph_orchestrator._tools_end_condition(result) == "chatbot"

    @pytest.mark.asyncio
    async def test_pending_approval_state_persists_and_reloads(
        self,
        mock_bus,
        tmp_path: Path,
    ):
        """Orchestrator approval/resume state survives service restart via DB bus."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.db import DBMethods
        from app.shared.contracts.models.tooling import ToolingMethods

        db_path = tmp_path / "orchestrator-pending.db"

        async def request_side_effect(topic, payload, **kwargs):
            if topic == DBMethods.EXECUTE_SQL:
                with sqlite3.connect(db_path) as connection:
                    connection.row_factory = sqlite3.Row
                    cursor = connection.execute(payload.sql, payload.params or [])
                    rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
                    connection.commit()
                return QueryResult(ok=True, data={"rows": rows})
            if topic == ToolingMethods.REQUEST_APPROVAL:
                return QueryResult(
                    ok=True,
                    data={
                        "ok": True,
                        "approval_request_id": "persisted-approval",
                        "correlation_id": "persisted-corr",
                        "policy_decision": {
                            "decision_id": "persisted-decision",
                            "approval_mode": "ask_each_time",
                        },
                    },
                )
            return QueryResult(ok=False, error=f"unexpected topic: {topic}")

        mock_bus.request = AsyncMock(side_effect=request_side_effect)

        with (
            patch("app.services.orchestrator.graph.chatbot"),
            patch("app.services.orchestrator.graph.StateGraph"),
            patch("app.services.orchestrator.graph.MemorySaver"),
        ):
            first = GraphOrchestrator(bus=mock_bus)
            await first.initialize_durable_pending_approvals()
            await first._request_tool_approval(
                tool_name="delete_file",
                tool_args={"path": "/tmp/example"},
                tool_call_id="tool-persisted",
                candidate={
                    "tool_name": "delete_file",
                    "display_name": "Delete file",
                    "global_tool_id": "local:Tooling:tool:delete_file",
                    "provider_peer_id": "local",
                    "provider_service_instance_id": "local:Tooling",
                },
            )

            second = GraphOrchestrator(bus=mock_bus)
            await second.initialize_durable_pending_approvals()

        pending = next(iter(second.pending_tool_approvals.values()))
        assert pending.approval_request_id == "persisted-approval"
        assert pending.tool_name == "delete_file"
        assert second._pending_tool_requests[pending.pending_id].arguments == {
            "path": "/tmp/example"
        }

    @pytest.mark.asyncio
    async def test_execute_tools_no_tool_calls(self, graph_orchestrator):
        """Test execute tools with no tool calls."""
        from langchain_core.messages import AIMessage

        ai_message = AIMessage(content="Hello")
        state = State(messages=[ai_message])

        result = await graph_orchestrator._execute_tools_via_bus(state)

        assert "messages" in result
        assert result["messages"] == []

    @pytest.mark.asyncio
    async def test_execute_tools_with_error(self, graph_orchestrator, mock_bus):
        """Test tool execution with error."""
        from langchain_core.messages import AIMessage

        # Mock failed tool execution
        from app.messaging import QueryResult

        mock_bus.request.return_value = QueryResult(ok=False, error="Tool execution failed")

        ai_message = AIMessage(
            content="",
            tool_calls=[{"name": "failing_tool", "args": {}, "id": "tool_456"}],
        )

        state = State(messages=[ai_message])

        result = await graph_orchestrator._execute_tools_via_bus(state)

        # Verify error message was created
        assert "messages" in result
        assert len(result["messages"]) == 1
        assert "Error" in result["messages"][0].content


class TestGraphOrchestratorProcessing:
    """Test GraphOrchestrator processing methods."""

    @pytest.mark.asyncio
    async def test_stream_graph_updates(self, graph_orchestrator, mock_bus):
        """Test streaming graph updates."""
        from langchain_core.messages import AIMessage

        # Mock graph invocation
        mock_response = {
            "messages": [
                AIMessage(content="Test response"),
            ]
        }

        graph_orchestrator.graph = MagicMock()
        graph_orchestrator.graph.ainvoke = AsyncMock(return_value=mock_response)

        with (
            patch("app.services.orchestrator.graph.log_info") as mock_log_info,
            patch("app.services.orchestrator.graph.log_debug") as mock_log_debug,
        ):
            result = await graph_orchestrator.stream_graph_updates(
                "Hello", tts_result=False, thread_id="session-1"
            )

        assert result == "Test response"
        rendered_logs = "\n".join(str(call) for call in mock_log_info.call_args_list)
        assert "Test response" not in rendered_logs
        assert "bytes=13" in rendered_logs
        rendered_debug_logs = "\n".join(str(call) for call in mock_log_debug.call_args_list)
        assert "Hello" not in rendered_debug_logs
        assert "bytes=5" in rendered_debug_logs
        graph_orchestrator.graph.ainvoke.assert_called_once()
        assert (
            graph_orchestrator.graph.ainvoke.await_args.kwargs["config"]["configurable"][
                "thread_id"
            ]
            == "aurora-session-session-1"
        )

    @pytest.mark.asyncio
    async def test_stream_graph_events_yields_tool_events_before_next_model_chunk(
        self, graph_orchestrator
    ):
        """Tool stream updates should not wait for tool/model completion."""

        tool_event_emitted = asyncio.Event()
        continue_graph = asyncio.Event()

        class FakeGraph:
            async def astream_events(self, input=None, config=None, version=None):
                await graph_orchestrator._emit_tool_stream_event(
                    kind="tool.running",
                    tool_call_id="call-search",
                    tool_name="duckduckgo_results_json",
                    status="running",
                    tool_args={"query": "Portugal travel"},
                    binding={
                        "provider_peer_id": "stable-peer",
                        "provider_label": "aurora-2",
                    },
                    summary="Searching the web.",
                )
                tool_event_emitted.set()
                await continue_graph.wait()
                yield {
                    "event": "on_chat_model_stream",
                    "data": {"chunk": MagicMock(content="Done")},
                }

            async def aget_state(self, config):
                return MagicMock(values={"messages": []})

        graph_orchestrator.graph = FakeGraph()
        iterator = graph_orchestrator.stream_graph_events("find travel ideas")

        first = await asyncio.wait_for(iterator.__anext__(), timeout=1)

        assert tool_event_emitted.is_set()
        assert first.kind == "tool.running"
        assert first.tool is not None
        assert first.tool.tool_name == "duckduckgo_results_json"
        assert first.tool.target == "aurora-2"
        assert first.tool.provider_id == "stable-peer"
        continue_graph.set()
        second = await asyncio.wait_for(iterator.__anext__(), timeout=1)
        assert second.kind == "assistant.delta"
        assert second.delta == "Done"

    @pytest.mark.asyncio
    async def test_stream_graph_events_uses_tool_event_for_approval_pause(self, graph_orchestrator):
        """Approval pauses should render through the tool card without duplicate text deltas."""

        class FakeGraph:
            async def astream_events(self, input=None, config=None, version=None):
                await graph_orchestrator._emit_tool_stream_event(
                    kind="tool.requires_action",
                    tool_call_id="call-email",
                    tool_name="send_email",
                    status="requires_action",
                    tool_args={"to": "a@example.com"},
                    candidate={
                        "display_name": "Send email",
                        "pending_id": "pending-email",
                        "approval_request_id": "approval-email",
                    },
                    summary="Tool requires operator approval before execution.",
                )
                if False:
                    yield None

            async def aget_state(self, config):
                return MagicMock(values={"approval_pending": True, "messages": []})

        graph_orchestrator.graph = FakeGraph()
        events = [
            event
            async for event in graph_orchestrator.stream_graph_events(
                "send email", thread_id="session-approval"
            )
        ]

        assert [event.kind for event in events] == ["tool.requires_action"]
        assert events[0].tool is not None
        assert events[0].tool.status == "requires_action"
        assert events[0].tool.pending_id == "pending-email"

    @pytest.mark.asyncio
    async def test_stream_graph_events_waits_for_pending_approval_resolution(
        self, graph_orchestrator
    ):
        """Approval pauses should not finish until the approval decision resumes the turn."""
        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval

        thread_id = graph_orchestrator._checkpoint_thread_id("session-approval-wait")
        pending_id = f"{thread_id}:call-email"
        future: asyncio.Future[str | None] = asyncio.get_running_loop().create_future()
        pending = OrchestratorPendingToolApproval(
            pending_id=pending_id,
            approval_request_id="approval-email",
            status="pending",
            run_id=thread_id,
            thread_id=thread_id,
            session_id=thread_id,
            message_id="message-email",
            tool_call_id="call-email",
            tool_name="send_email",
            arguments_preview={"to": "a@example.com"},
            created_at=1.0,
        )

        class FakeGraph:
            async def astream_events(self, input=None, config=None, version=None):
                graph_orchestrator.pending_tool_approvals[pending_id] = pending
                graph_orchestrator._pending_tool_resolution_futures[pending_id] = future
                stream_turn_id = _CURRENT_RUN_CONTEXT.get()["stream_turn_id"]
                graph_orchestrator._pending_tool_stream_turn_ids[pending_id] = stream_turn_id
                await graph_orchestrator._emit_tool_stream_event(
                    kind="tool.requires_action",
                    tool_call_id="call-email",
                    tool_name="send_email",
                    status="requires_action",
                    tool_args={"to": "a@example.com"},
                    candidate={
                        "display_name": "Send email",
                        "pending_id": pending_id,
                        "approval_request_id": "approval-email",
                    },
                    summary="Tool requires operator approval before execution.",
                )
                if False:
                    yield None

            async def aget_state(self, config):
                return MagicMock(values={"approval_pending": True, "messages": []})

        graph_orchestrator.graph = FakeGraph()
        iterator = graph_orchestrator.stream_graph_events(
            "send email",
            thread_id="session-approval-wait",
        ).__aiter__()

        first = await iterator.__anext__()
        assert first.kind == "tool.requires_action"

        waiting = asyncio.create_task(iterator.__anext__())
        await asyncio.sleep(0.01)
        assert waiting.done() is False

        graph_orchestrator._finish_pending_tool_resolution(
            pending_id,
            "The approved email tool completed.",
            tool_events=[
                AssistantStreamEvent(
                    kind="tool.running",
                    tool=AssistantToolStreamState(
                        tool_call_id="call-email",
                        tool_name="send_email",
                        display_name="Send email",
                        status="running",
                    ),
                ),
                AssistantStreamEvent(
                    kind="tool.completed",
                    tool=AssistantToolStreamState(
                        tool_call_id="call-email",
                        tool_name="send_email",
                        display_name="Send email",
                        status="completed",
                        result_preview={"status": "success"},
                    ),
                ),
            ],
        )
        running = await asyncio.wait_for(waiting, timeout=1.0)
        assert running.kind == "tool.running"
        completed = await asyncio.wait_for(iterator.__anext__(), timeout=1.0)
        assert completed.kind == "tool.completed"
        assert completed.tool is not None
        assert completed.tool.result_preview == {"status": "success"}
        resolved = await asyncio.wait_for(iterator.__anext__(), timeout=1.0)
        assert resolved.kind == "assistant.delta"
        assert resolved.text == "The approved email tool completed."

        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(iterator.__anext__(), timeout=1.0)

    @pytest.mark.asyncio
    async def test_stream_graph_events_ignores_old_pending_future_from_same_thread(
        self, graph_orchestrator
    ):
        """A disconnected prior turn must not hold or consume a later turn's stream."""
        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval

        thread_id = graph_orchestrator._checkpoint_thread_id("session-reused")
        old_pending_id = f"{thread_id}:old-call"
        old_future: asyncio.Future[str | None] = asyncio.get_running_loop().create_future()
        graph_orchestrator.pending_tool_approvals[old_pending_id] = OrchestratorPendingToolApproval(
            pending_id=old_pending_id,
            approval_request_id="old-approval",
            status="pending",
            run_id=thread_id,
            thread_id=thread_id,
            session_id=thread_id,
            message_id="old-message",
            tool_call_id="old-call",
            tool_name="old_tool",
            arguments_preview={},
            created_at=1.0,
        )
        graph_orchestrator._pending_tool_resolution_futures[old_pending_id] = old_future

        class FakeGraph:
            async def astream_events(self, input=None, config=None, version=None):
                yield {
                    "event": "on_chat_model_stream",
                    "data": {"chunk": MagicMock(content="Fresh response")},
                }

            async def aget_state(self, config):
                return MagicMock(values={"messages": []})

        graph_orchestrator.graph = FakeGraph()

        async def collect_events():
            return [
                event
                async for event in graph_orchestrator.stream_graph_events(
                    "new message",
                    thread_id="session-reused",
                )
            ]

        events = await asyncio.wait_for(collect_events(), timeout=1.0)

        assert [event.text for event in events] == ["Fresh response"]
        assert old_future.done() is False
        assert graph_orchestrator._pending_tool_resolution_futures[old_pending_id] is old_future

    @pytest.mark.asyncio
    async def test_concurrent_streams_own_only_their_approval_waiter(self, graph_orchestrator):
        """Closing one overlapping stream must not release another turn's waiter."""
        from app.shared.contracts.models.orchestrator import OrchestratorPendingToolApproval

        both_started = asyncio.Event()
        started_threads: set[str] = set()
        pending_ids: dict[str, str] = {}

        class FakeGraph:
            async def astream_events(self, input=None, config=None, version=None):
                thread_id = config["configurable"]["thread_id"]
                started_threads.add(thread_id)
                if len(started_threads) == 2:
                    both_started.set()
                await both_started.wait()

                pending_id = f"{thread_id}:call"
                stream_turn_id = _CURRENT_RUN_CONTEXT.get()["stream_turn_id"]
                pending_ids[thread_id] = pending_id
                graph_orchestrator.pending_tool_approvals[pending_id] = (
                    OrchestratorPendingToolApproval(
                        pending_id=pending_id,
                        approval_request_id=f"approval-{thread_id}",
                        status="pending",
                        run_id=thread_id,
                        thread_id=thread_id,
                        session_id=thread_id,
                        message_id=f"message-{thread_id}",
                        tool_call_id=f"call-{thread_id}",
                        tool_name="remote_tool",
                        arguments_preview={},
                        created_at=1.0,
                    )
                )
                graph_orchestrator._pending_tool_resolution_futures[pending_id] = (
                    asyncio.get_running_loop().create_future()
                )
                graph_orchestrator._pending_tool_stream_turn_ids[pending_id] = stream_turn_id
                await graph_orchestrator._emit_tool_stream_event(
                    kind="tool.requires_action",
                    tool_call_id=f"call-{thread_id}",
                    tool_name="remote_tool",
                    status="requires_action",
                    tool_args={},
                    candidate={
                        "display_name": "Remote tool",
                        "pending_id": pending_id,
                        "approval_request_id": f"approval-{thread_id}",
                    },
                    summary="Tool requires operator approval before execution.",
                )
                if False:
                    yield None

            async def aget_state(self, config):
                return MagicMock(values={"approval_pending": True, "messages": []})

        graph_orchestrator.graph = FakeGraph()
        stream_one = graph_orchestrator.stream_graph_events(
            "first",
            thread_id="concurrent-one",
        )
        stream_two = graph_orchestrator.stream_graph_events(
            "second",
            thread_id="concurrent-two",
        )

        first_one, first_two = await asyncio.gather(
            asyncio.wait_for(stream_one.__anext__(), timeout=1.0),
            asyncio.wait_for(stream_two.__anext__(), timeout=1.0),
        )
        assert first_one.kind == "tool.requires_action"
        assert first_two.kind == "tool.requires_action"

        thread_one = graph_orchestrator._checkpoint_thread_id("concurrent-one")
        thread_two = graph_orchestrator._checkpoint_thread_id("concurrent-two")
        pending_one = pending_ids[thread_one]
        pending_two = pending_ids[thread_two]

        await stream_one.aclose()

        assert pending_one not in graph_orchestrator._pending_tool_resolution_futures
        assert pending_two in graph_orchestrator._pending_tool_resolution_futures
        assert pending_two in graph_orchestrator._pending_tool_stream_turn_ids

        await stream_two.aclose()

    @pytest.mark.asyncio
    async def test_stream_graph_events_forwards_inference_override_to_fallback(
        self, graph_orchestrator
    ):
        """Fallback updates must preserve inference-only routing overrides."""

        inference_override = {"provider_id": "remote:raspi-lab:Orchestrator"}

        class FakeGraph:
            async def astream_events(self, input=None, config=None, version=None):
                raise AttributeError("streaming unsupported")
                yield  # pragma: no cover

        graph_orchestrator.graph = FakeGraph()
        with patch.object(
            graph_orchestrator,
            "stream_graph_updates",
            new=AsyncMock(return_value="fallback response"),
        ) as fallback:
            events = [
                event
                async for event in graph_orchestrator.stream_graph_events(
                    "hello",
                    thread_id="session-1",
                    inference_override=inference_override,
                )
            ]

        fallback.assert_awaited_once()
        assert fallback.await_args.kwargs["inference_override"] == inference_override
        assert events[0].kind == "assistant.delta"
        assert events[0].delta == "fallback response"

    @pytest.mark.asyncio
    async def test_process_text_input(self, graph_orchestrator):
        """Test processing text input."""
        from langchain_core.messages import AIMessage

        mock_response = {
            "messages": [
                AIMessage(content="Text response"),
            ]
        }

        graph_orchestrator.graph = MagicMock()
        graph_orchestrator.graph.ainvoke = AsyncMock(return_value=mock_response)

        with (
            patch("app.services.orchestrator.graph.log_info") as mock_log_info,
            patch("app.services.orchestrator.graph.log_debug") as mock_log_debug,
        ):
            result = await graph_orchestrator.process_text_input("Hello", thread_id="chat:abc")

        assert result == "Text response"
        rendered_logs = "\n".join(str(call) for call in mock_log_info.call_args_list)
        assert "Text response" not in rendered_logs
        assert "bytes=13" in rendered_logs
        rendered_debug_logs = "\n".join(str(call) for call in mock_log_debug.call_args_list)
        assert "Hello" not in rendered_debug_logs
        assert "bytes=5" in rendered_debug_logs
        assert (
            graph_orchestrator.graph.ainvoke.await_args.kwargs["config"]["configurable"][
                "thread_id"
            ]
            == "aurora-session-chat:abc"
        )

    @pytest.mark.asyncio
    async def test_process_text_input_with_end(self, graph_orchestrator):
        """Test processing text input that returns END."""
        from langchain_core.messages import AIMessage

        mock_response = {
            "messages": [
                AIMessage(content="END"),
            ]
        }

        graph_orchestrator.graph = MagicMock()
        graph_orchestrator.graph.ainvoke = AsyncMock(return_value=mock_response)

        result = await graph_orchestrator.process_text_input("END command")

        assert result == "END"


class TestGraphOrchestratorToolEndCondition:
    """Test GraphOrchestrator tool end condition."""

    def test_tools_end_condition_chatbot(self, graph_orchestrator):
        """Test tools end condition returns chatbot."""
        from langchain_core.messages import AIMessage

        state = {"messages": [AIMessage(content="Continue")]}

        result = graph_orchestrator._tools_end_condition(state)

        assert result == "chatbot"

    def test_tools_end_condition_end(self, graph_orchestrator):
        """Test tools end condition returns END."""
        from langchain_core.messages import AIMessage

        state = {"messages": [AIMessage(content="END")]}

        result = graph_orchestrator._tools_end_condition(state)

        assert result == "END"
