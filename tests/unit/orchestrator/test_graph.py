"""Unit tests for GraphOrchestrator."""

import sys
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.messaging import MessageBus
from app.services.orchestrator.graph import GraphOrchestrator
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

        result = await graph_orchestrator.stream_graph_updates("Hello", tts_result=False)

        assert result == "Test response"
        graph_orchestrator.graph.ainvoke.assert_called_once()

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

        result = await graph_orchestrator.process_text_input("Hello")

        assert result == "Text response"

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
