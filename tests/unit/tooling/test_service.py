"""Unit tests for ToolingService."""

from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import Envelope, MessageBus, ToolingTopics
from app.tooling.service import (
    ExecuteToolCommand,
    ExecuteToolResponse,
    GetToolByNameQuery,
    GetToolsQuery,
    GetToolStatsQuery,
    ToolingService,
    ToolsInitialized,
)


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.subscribe = Mock()
    bus.publish = AsyncMock()
    return bus


@pytest.fixture
def tooling_service(mock_bus):
    """Create a ToolingService instance."""
    with patch("app.tooling.service.ToolsManager") as mock_tools_mgr:
        with patch("app.tooling.service.set_tools_manager"):
            mock_manager = Mock()
            mock_manager.initialize = AsyncMock()
            mock_manager.get_stats = Mock(return_value={"total_tools": 5, "mcp_tools_loaded": False})
            mock_manager.get_tools = Mock(return_value=[])
            mock_manager.get_tool_by_name = Mock(return_value=None)
            mock_tools_mgr.return_value = mock_manager

            service = ToolingService(bus=mock_bus)
            service.tools_manager = mock_manager
            return service


class TestToolingServiceInitialization:
    """Test ToolingService initialization."""

    def test_init(self, mock_bus):
        """Test service initialization."""
        with patch("app.tooling.service.ToolsManager"):
            service = ToolingService(bus=mock_bus)
            assert service.bus == mock_bus

    @pytest.mark.asyncio
    async def test_start(self, tooling_service, mock_bus):
        """Test service start."""
        await tooling_service.start()

        # Verify subscriptions were made
        assert mock_bus.subscribe.call_count == 5

        # Verify correct topics subscribed
        subscribed_topics = [call[0][0] for call in mock_bus.subscribe.call_args_list]
        assert ToolingTopics.GET_TOOLS in subscribed_topics
        assert ToolingTopics.GET_TOOL_BY_NAME in subscribed_topics
        assert ToolingTopics.GET_STATS in subscribed_topics
        assert ToolingTopics.RELOAD_MCP_TOOLS in subscribed_topics
        assert ToolingTopics.EXECUTE_TOOL in subscribed_topics

        # Verify tools were initialized
        tooling_service.tools_manager.initialize.assert_called_once()

        # Verify initialization event was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        assert call_args[0][0] == ToolingTopics.TOOLS_INITIALIZED
        assert isinstance(call_args[0][1], ToolsInitialized)

    @pytest.mark.asyncio
    async def test_stop(self, tooling_service):
        """Test service stop."""
        await tooling_service.stop()
        assert tooling_service._started is False


class TestToolingServiceQueries:
    """Test ToolingService query handling."""

    @pytest.mark.asyncio
    async def test_get_tools_no_query(self, tooling_service, mock_bus):
        """Test get tools query without query string."""
        query = GetToolsQuery(query=None, top_k=10)
        env = Envelope(type=ToolingTopics.GET_TOOLS, payload=query, reply_to="test.reply")

        tooling_service.tools_manager.get_tools = Mock(return_value=[])

        await tooling_service._on_get_tools(env)

        # Verify response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        assert call_args[0][0] == "test.reply"

    @pytest.mark.asyncio
    async def test_get_tools_with_query(self, tooling_service, mock_bus):
        """Test get tools query with query string via RAG on bus."""
        query = GetToolsQuery(query="test", top_k=5)
        env = Envelope(type=ToolingTopics.GET_TOOLS, payload=query, reply_to="test.reply")

        # Mock bus.request to return search results
        from app.messaging import QueryResult

        mock_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"items": [{"key": "test_tool"}]}))

        # Mock tools_manager to map name -> tool
        from langchain_core.tools import tool

        @tool
        def test_tool(input: str):
            """Test tool."""
            return input

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=test_tool)

        await tooling_service._on_get_tools(env)

        # Verify bus.request was used for RAG query
        mock_bus.request.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_tool_by_name(self, tooling_service, mock_bus):
        """Test get tool by name query."""
        from langchain_core.tools import tool

        @tool
        def test_tool(input: str):
            """Test tool."""
            return input

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=test_tool)

        query = GetToolByNameQuery(name="test_tool")
        env = Envelope(type=ToolingTopics.GET_TOOL_BY_NAME, payload=query, reply_to="test.reply")

        await tooling_service._on_get_tool_by_name(env)

        # Verify response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        assert call_args[0][0] == "test.reply"

    @pytest.mark.asyncio
    async def test_get_tool_by_name_not_found(self, tooling_service, mock_bus):
        """Test get tool by name when tool not found."""
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=None)

        query = GetToolByNameQuery(name="non_existent_tool")
        env = Envelope(type=ToolingTopics.GET_TOOL_BY_NAME, payload=query, reply_to="test.reply")

        await tooling_service._on_get_tool_by_name(env)

        # Verify error response was published
        mock_bus.publish.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_stats(self, tooling_service, mock_bus):
        """Test get stats query."""
        tooling_service.tools_manager.get_stats = Mock(return_value={"total_tools": 10, "mcp_tools_loaded": True})

        query = GetToolStatsQuery()
        env = Envelope(type=ToolingTopics.GET_STATS, payload=query, reply_to="test.reply")

        await tooling_service._on_get_stats(env)

        # Verify response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        result = call_args[0][1]
        # Accept dict or QueryResult depending on serialization
        if hasattr(result, "ok"):
            assert result.ok is True
            data = result.data
        else:
            data = result
        assert data["total_tools"] == 10


class TestToolingServiceToolExecution:
    """Test ToolingService tool execution."""

    @pytest.mark.asyncio
    async def test_execute_tool_success(self, tooling_service, mock_bus):
        """Test successful tool execution."""
        from langchain_core.tools import tool

        @tool
        async def test_tool(input: str, bus):
            """Test tool."""
            return f"Result: {input}"

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=test_tool)

        cmd = ExecuteToolCommand(tool_name="test_tool", arguments={"input": "test"})
        env = Envelope(type=ToolingTopics.EXECUTE_TOOL, payload=cmd, reply_to="test.reply")

        await tooling_service._on_execute_tool(env)

        # Verify response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        assert call_args[0][0] == "test.reply"
        response = call_args[0][1]
        assert isinstance(response, ExecuteToolResponse)
        assert response.ok is True

    @pytest.mark.asyncio
    async def test_execute_tool_not_found(self, tooling_service, mock_bus):
        """Test tool execution when tool not found."""
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=None)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["tool1", "tool2"])

        cmd = ExecuteToolCommand(tool_name="non_existent", arguments={})
        env = Envelope(type=ToolingTopics.EXECUTE_TOOL, payload=cmd, reply_to="test.reply")

        await tooling_service._on_execute_tool(env)

        # Verify error response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        response = call_args[0][1]
        assert isinstance(response, ExecuteToolResponse)
        assert response.ok is False

    @pytest.mark.asyncio
    async def test_execute_tool_with_error(self, tooling_service, mock_bus):
        """Test tool execution with error."""
        from langchain_core.tools import tool

        @tool
        async def failing_tool(input: str, bus):
            """Failing tool."""
            raise ValueError("Tool execution error")

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=failing_tool)

        cmd = ExecuteToolCommand(tool_name="failing_tool", arguments={"input": "test"})
        env = Envelope(type=ToolingTopics.EXECUTE_TOOL, payload=cmd, reply_to="test.reply")

        await tooling_service._on_execute_tool(env)

        # Verify error response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        response = call_args[0][1]
        assert isinstance(response, ExecuteToolResponse)
        assert response.ok is False
        assert "error" in response.error.lower()


class TestToolingServiceMCPReload:
    """Test ToolingService MCP reload."""

    @pytest.mark.asyncio
    async def test_reload_mcp_tools(self, tooling_service, mock_bus):
        """Test reload MCP tools command."""
        tooling_service.tools_manager.reload_mcp_tools = AsyncMock()

        from app.tooling.service import ReloadMCPToolsCommand

        cmd = ReloadMCPToolsCommand()
        env = Envelope(type=ToolingTopics.RELOAD_MCP_TOOLS, payload=cmd, reply_to="test.reply")

        await tooling_service._on_reload_mcp(env)

        # Verify reload was called
        tooling_service.tools_manager.reload_mcp_tools.assert_called_once()

        # Verify event was published
        mock_bus.publish.assert_called_once()
