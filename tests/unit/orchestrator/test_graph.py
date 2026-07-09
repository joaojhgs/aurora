"""Unit tests for GraphOrchestrator."""

import asyncio
import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.messaging import MessageBus
from app.services.orchestrator.graph import _CURRENT_RUN_CONTEXT, GraphOrchestrator
from app.services.orchestrator.state import State

# Mock problematic imports
sys.modules["app.services.orchestrator.agents.chatbot"] = MagicMock()
sys.modules["app.services.orchestrator.graph"] = MagicMock()


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

    @pytest.mark.asyncio
    async def test_approval_candidate_with_binding_executes_before_requesting_approval(
        self, graph_orchestrator, mock_bus
    ):
        """Model-visible approval candidates must still go through Tooling.ExecuteTool first."""
        from langchain_core.messages import AIMessage

        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingMethods

        mock_bus.request.return_value = QueryResult(ok=True, data="granted result")
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
        assert mock_bus.request.await_args.args[0] == ToolingMethods.EXECUTE_TOOL
        assert result["messages"][0].content == "granted result"
        assert result["approval_pending"] is False

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
        )
        request = ToolingRequestApprovalRequest(
            tool_name="delete_file",
            arguments={"path": "/tmp/example"},
            caller_principal_id="principal-1",
        )
        graph_orchestrator.pending_tool_approvals[pending.pending_id] = pending
        graph_orchestrator._pending_tool_requests[pending.pending_id] = request
        graph_orchestrator._pending_tool_call_ids_by_approval_id["approval-1"] = pending.pending_id
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
        )
        request = ToolingRequestApprovalRequest(
            tool_name="delete_file",
            arguments={"path": "/tmp/example"},
            caller_principal_id="principal-1",
        )
        graph_orchestrator.pending_tool_approvals[pending.pending_id] = pending
        graph_orchestrator._pending_tool_requests[pending.pending_id] = request
        graph_orchestrator._pending_tool_call_ids_by_approval_id["approval-1"] = pending.pending_id
        mock_bus.request.return_value = QueryResult(ok=True, data={"status": "denied"})
        graph_orchestrator.graph.ainvoke = AsyncMock(
            return_value={
                "messages": [
                    AIMessage(content="I did not run that tool because you denied approval.")
                ]
            }
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
    async def test_bindable_tool_denial_requests_runtime_approval(
        self, graph_orchestrator, mock_bus
    ):
        """Model-visible tools that Tooling denies for approval are converted to interrupts."""
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
                    "approval_request_id": "runtime-approval",
                    "correlation_id": "runtime-corr",
                    "policy_decision": {
                        "decision_id": "runtime-decision",
                        "approval_mode": "ask_each_time",
                    },
                },
            ),
        ]

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

        assert mock_bus.request.await_args_list[0].args[0] == ToolingMethods.EXECUTE_TOOL
        assert mock_bus.request.await_args_list[1].args[0] == ToolingMethods.REQUEST_APPROVAL
        approval_request = mock_bus.request.await_args_list[1].args[1]
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

        result = await graph_orchestrator.stream_graph_updates(
            "Hello", tts_result=False, thread_id="session-1"
        )

        assert result == "Test response"
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
        continue_graph.set()
        second = await asyncio.wait_for(iterator.__anext__(), timeout=1)
        assert second.kind == "assistant.delta"
        assert second.delta == "Done"

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

        result = await graph_orchestrator.process_text_input("Hello", thread_id="chat:abc")

        assert result == "Text response"
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
