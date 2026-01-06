"""Unit tests for ToolingService."""

from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import Envelope, MessageBus
from app.shared.contracts.models.tooling import ToolingMethods
from app.services.tooling.service import ToolingService
from app.shared.messaging.models.tooling_models import (
    ExecuteToolCommand,
    GetToolByNameQuery,
    GetToolsQuery,
    GetToolStatsQuery,
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
    with (
        patch("app.services.tooling.service.ToolsManager") as mock_tools_mgr,
        patch("app.services.tooling.service.set_tools_manager"),
        patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
    ):
        mock_manager = Mock()
        mock_manager.initialize = AsyncMock()
        mock_manager.get_stats = Mock(return_value={"total_tools": 5, "mcp_tools_loaded": False})
        mock_manager.get_tools = Mock(return_value=[])
        mock_manager.get_tool_by_name = Mock(return_value=None)
        mock_tools_mgr.return_value = mock_manager

        service = ToolingService()
        service.tools_manager = mock_manager
        yield service


class TestToolingServiceInitialization:
    """Test ToolingService initialization."""

    def test_init(self, mock_bus):
        """Test service initialization."""
        with (
            patch("app.services.tooling.service.ToolsManager"),
            patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
        ):
            service = ToolingService()
            assert service is not None

    @pytest.mark.asyncio
    async def test_start(self, tooling_service, mock_bus):
        """Test service start."""
        await tooling_service.start()

        # Verify subscriptions were made (count may vary based on contracts registered)
        assert mock_bus.subscribe.call_count >= 5

        # Verify correct topics subscribed
        subscribed_topics = [call[0][0] for call in mock_bus.subscribe.call_args_list]
        # Service uses auto-subscription via contracts
        # Verify using method constants
        assert ToolingMethods.GET_TOOLS in subscribed_topics or any(
            ToolingMethods.GET_TOOLS in str(call) for call in mock_bus.subscribe.call_args_list
        )
        assert ToolingMethods.GET_TOOL_BY_NAME in subscribed_topics or any(
            ToolingMethods.GET_TOOL_BY_NAME in str(call)
            for call in mock_bus.subscribe.call_args_list
        )
        assert ToolingMethods.GET_STATS in subscribed_topics or any(
            ToolingMethods.GET_STATS in str(call) for call in mock_bus.subscribe.call_args_list
        )
        assert ToolingMethods.RELOAD_MCP_TOOLS in subscribed_topics or any(
            ToolingMethods.RELOAD_MCP_TOOLS in str(call)
            for call in mock_bus.subscribe.call_args_list
        )
        assert ToolingMethods.EXECUTE_TOOL in subscribed_topics or any(
            ToolingMethods.EXECUTE_TOOL in str(call) for call in mock_bus.subscribe.call_args_list
        )

        # Verify tools were initialized
        tooling_service.tools_manager.initialize.assert_called_once()

        # Verify initialization event was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        assert call_args[0][0] == ToolingMethods.TOOLS_INITIALIZED
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
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        # Contract methods receive the request model directly (not wrapped in Envelope)
        request = ToolingGetToolsRequest(query=None, top_k=10)

        tooling_service.tools_manager.get_tools = Mock(return_value=[])

        response = await tooling_service._on_get_tools(request)

        # Verify response was returned (contract methods return directly now)
        assert response is not None
        assert hasattr(response, 'tools')

    @pytest.mark.asyncio
    async def test_get_tools_with_query(self, tooling_service, mock_bus):
        """Test get tools query with query string via RAG on bus."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        # Contract methods receive the request model directly (not wrapped in Envelope)
        request = ToolingGetToolsRequest(query="test", top_k=5)

        # Mock bus.request to return search results
        mock_bus.request = AsyncMock(
            return_value=QueryResult(ok=True, data={"items": [{"key": "test_tool"}]})
        )

        # Mock tools_manager to map name -> tool
        from langchain_core.tools import tool

        @tool
        def test_tool(input: str):
            """Test tool."""
            return input

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=test_tool)

        response = await tooling_service._on_get_tools(request)

        # Verify bus.request was used for RAG query
        mock_bus.request.assert_called_once()
        assert response is not None

    @pytest.mark.asyncio
    async def test_get_tool_by_name(self, tooling_service, mock_bus):
        """Test get tool by name query."""
        from langchain_core.tools import tool
        from app.shared.contracts.models.tooling import ToolingGetToolByNameRequest

        @tool
        def test_tool(input: str):
            """Test tool."""
            return input

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=test_tool)

        # Contract methods receive the request model directly
        request = ToolingGetToolByNameRequest(name="test_tool")

        response = await tooling_service._on_get_tool_by_name(request)

        # Verify response was returned
        assert response is not None
        assert response.found is True
        assert response.name == "test_tool"

    @pytest.mark.asyncio
    async def test_get_tool_by_name_not_found(self, tooling_service, mock_bus):
        """Test get tool by name when tool not found."""
        from app.shared.contracts.models.tooling import ToolingGetToolByNameRequest

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=None)

        # Contract methods receive the request model directly
        request = ToolingGetToolByNameRequest(name="non_existent_tool")

        response = await tooling_service._on_get_tool_by_name(request)

        # Verify not found response was returned
        assert response is not None
        assert response.found is False

    @pytest.mark.asyncio
    async def test_get_stats(self, tooling_service, mock_bus):
        """Test get stats query."""
        from app.shared.contracts.models.tooling import ToolingGetStatsRequest

        tooling_service.tools_manager.get_stats = Mock(
            return_value={"total_tools": 10, "mcp_tools_loaded": True}
        )

        # Contract methods receive the request model directly
        request = ToolingGetStatsRequest()

        response = await tooling_service._on_get_stats(request)

        # Verify response was returned
        assert response is not None
        assert response.total_tools == 10


class TestToolingServiceToolExecution:
    """Test ToolingService tool execution."""

    @pytest.mark.asyncio
    async def test_execute_tool_success(self, tooling_service, mock_bus):
        """Test successful tool execution."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest, ToolingExecuteToolResponse

        # Create a mock tool that can accept ainvoke
        mock_tool = Mock()
        mock_tool.ainvoke = AsyncMock(return_value="Result: test")
        
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        # Contract methods receive the request model directly
        request = ToolingExecuteToolRequest(tool_name="test_tool", arguments={"input": "test"})

        response = await tooling_service._on_execute_tool(request)

        # Verify response was returned
        assert response is not None
        assert isinstance(response, ToolingExecuteToolResponse)
        assert response.ok is True

    @pytest.mark.asyncio
    async def test_execute_tool_not_found(self, tooling_service, mock_bus):
        """Test tool execution when tool not found."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest, ToolingExecuteToolResponse

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=None)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["tool1", "tool2"])

        # Contract methods receive the request model directly
        request = ToolingExecuteToolRequest(tool_name="non_existent", arguments={})

        response = await tooling_service._on_execute_tool(request)

        # Verify error response was returned
        assert response is not None
        assert isinstance(response, ToolingExecuteToolResponse)
        assert response.ok is False

    @pytest.mark.asyncio
    async def test_execute_tool_with_error(self, tooling_service, mock_bus):
        """Test tool execution with error."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest, ToolingExecuteToolResponse

        # Create a mock tool that raises an error on ainvoke
        mock_tool = Mock()
        mock_tool.ainvoke = AsyncMock(side_effect=ValueError("Tool execution error"))
        
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        # Contract methods receive the request model directly
        request = ToolingExecuteToolRequest(tool_name="failing_tool", arguments={"input": "test"})

        response = await tooling_service._on_execute_tool(request)

        # Verify error response was returned
        assert response is not None
        assert isinstance(response, ToolingExecuteToolResponse)
        assert response.ok is False
        assert "error" in response.error.lower()


class TestToolingServiceMCPReload:
    """Test ToolingService MCP reload."""

    @pytest.mark.asyncio
    async def test_reload_mcp_tools(self, tooling_service, mock_bus):
        """Test reload MCP tools command."""
        tooling_service.tools_manager.reload_mcp_tools = AsyncMock()

        from app.shared.messaging.models.tooling_models import ReloadMCPToolsCommand

        cmd = ReloadMCPToolsCommand()
        env = Envelope(type=ToolingMethods.RELOAD_MCP_TOOLS, payload=cmd, reply_to="test.reply")

        await tooling_service._on_reload_mcp(env)

        # Verify reload was called
        tooling_service.tools_manager.reload_mcp_tools.assert_called_once()

        # Verify event was published
        mock_bus.publish.assert_called_once()
