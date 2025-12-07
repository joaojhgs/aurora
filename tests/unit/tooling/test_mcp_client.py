"""
Tests for MCP (Model Context Protocol) integration (tooling module).

This module tests the MCP client functionality including:
- Client initialization and configuration
- Tool loading from MCP servers
- Integration with Aurora's tool system
- Error handling and edge cases
"""

from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.config.config_manager import ConfigManager
from app.tooling.mcp.mcp_client import MCPClientManager, get_mcp_tools, initialize_mcp


@pytest.mark.unit
class TestMCPClientManager:
    """Test the MCP client manager functionality."""

    @pytest.fixture
    def config_manager(self):
        """Mock configuration manager."""
        config = Mock(spec=ConfigManager)
        config.get.return_value = True  # MCP enabled by default
        return config

    @pytest.fixture
    def mcp_manager(self):
        """Create a fresh MCP client manager."""
        return MCPClientManager()

    @pytest.fixture
    def mock_mcp_tools(self):
        """Mock MCP tools for testing."""
        mock_tools = []
        for name, desc in [
            ("add", "Add two numbers together."),
            ("subtract", "Subtract the second number from the first."),
            ("multiply", "Multiply two numbers together."),
        ]:
            tool = Mock()
            tool.name = name
            tool.description = desc
            tool.ainvoke = AsyncMock(return_value=42.0)
            mock_tools.append(tool)
        return mock_tools

    @pytest.mark.asyncio
    async def test_initialize_with_disabled_mcp(self, mcp_manager, config_manager):
        """Test initialization when MCP is disabled."""
        config_manager.get.side_effect = lambda key, default=None: False if key == "mcp.enabled" else default

        with patch("app.tooling.mcp.mcp_client.config_manager", config_manager):
            await mcp_manager.initialize()

        assert not mcp_manager.is_initialized
        assert len(mcp_manager.get_tools()) == 0

    @pytest.mark.asyncio
    async def test_initialize_with_no_servers(self, mcp_manager, config_manager):
        """Test initialization when no servers are configured."""
        config_manager.get.side_effect = lambda key, default=None: {"mcp.enabled": True, "mcp.servers": {}}.get(key, default)

        with patch("app.tooling.mcp.mcp_client.config_manager", config_manager):
            await mcp_manager.initialize()

        assert not mcp_manager.is_initialized
        assert len(mcp_manager.get_tools()) == 0

    @pytest.mark.asyncio
    async def test_initialize_with_stdio_server(self, mcp_manager, config_manager):
        """Test initialization with a stdio server configuration."""
        servers_config = {"math": {"command": "python", "args": ["/path/to/math_server.py"], "transport": "stdio", "enabled": True}}

        config_manager.get.side_effect = lambda key, default=None: {"mcp.enabled": True, "mcp.servers": servers_config}.get(key, default)

        mock_client = AsyncMock()
        mock_tool = Mock()
        mock_tool.name = "add"
        mock_tool.description = "Add two numbers"
        mock_tools = [mock_tool]
        mock_client.get_tools.return_value = mock_tools

        with (
            patch("app.tooling.mcp.mcp_client.config_manager", config_manager),
            patch("langchain_mcp_adapters.client.MultiServerMCPClient", return_value=mock_client),
        ):

            await mcp_manager.initialize()

        assert mcp_manager.is_initialized
        assert len(mcp_manager.get_tools()) == 1
        assert mcp_manager.get_tools()[0].name == "add"

    @pytest.mark.asyncio
    async def test_initialize_with_http_server(self, mcp_manager, config_manager):
        """Test initialization with an HTTP server configuration."""
        servers_config = {
            "weather": {
                "url": "http://localhost:8000/mcp/",
                "transport": "streamable_http",
                "headers": {"Authorization": "Bearer test_token"},
                "enabled": True,
            }
        }

        config_manager.get.side_effect = lambda key, default=None: {"mcp.enabled": True, "mcp.servers": servers_config}.get(key, default)

        mock_client = AsyncMock()
        mock_tool = Mock()
        mock_tool.name = "get_weather"
        mock_tool.description = "Get weather information"
        mock_tools = [mock_tool]
        mock_client.get_tools.return_value = mock_tools

        with (
            patch("app.tooling.mcp.mcp_client.config_manager", config_manager),
            patch("langchain_mcp_adapters.client.MultiServerMCPClient", return_value=mock_client),
        ):

            await mcp_manager.initialize()

        assert mcp_manager.is_initialized
        assert len(mcp_manager.get_tools()) == 1
        assert mcp_manager.get_tools()[0].name == "get_weather"

    @pytest.mark.asyncio
    async def test_initialize_with_disabled_server(self, mcp_manager, config_manager):
        """Test that disabled servers are not loaded."""
        servers_config = {"math": {"command": "python", "args": ["/path/to/math_server.py"], "transport": "stdio", "enabled": False}}  # Disabled

        config_manager.get.side_effect = lambda key, default=None: {"mcp.enabled": True, "mcp.servers": servers_config}.get(key, default)

        with patch("app.tooling.mcp.mcp_client.config_manager", config_manager):
            await mcp_manager.initialize()

        assert not mcp_manager.is_initialized
        assert len(mcp_manager.get_tools()) == 0

    @pytest.mark.asyncio
    async def test_close(self, mcp_manager):
        """Test closing MCP client connections."""
        # Set up a mock client
        mock_client = AsyncMock()
        mcp_manager._client = mock_client
        mcp_manager._initialized = True
        mcp_manager._tools = [Mock()]

        await mcp_manager.close()

        assert mcp_manager._client is None
        assert not mcp_manager.is_initialized
        assert len(mcp_manager._tools) == 0

    @pytest.mark.asyncio
    async def test_tool_execution(self, mcp_manager, mock_mcp_tools):
        """Test executing MCP tools."""
        mcp_manager._tools = mock_mcp_tools
        mcp_manager._initialized = True

        tools = mcp_manager.get_tools()
        add_tool = next((t for t in tools if t.name == "add"), None)

        assert add_tool is not None
        result = await add_tool.ainvoke({"a": 5, "b": 3})
        assert result == 42.0
        add_tool.ainvoke.assert_called_once_with({"a": 5, "b": 3})

    @pytest.mark.asyncio
    async def test_client_close(self, mcp_manager):
        """Test closing MCP client connections."""
        mock_client = AsyncMock()
        mock_client.close = AsyncMock()

        mcp_manager._client = mock_client
        mcp_manager._initialized = True
        mcp_manager._tools = [Mock()]

        await mcp_manager.close()

        mock_client.close.assert_called_once()
        assert mcp_manager._client is None
        assert mcp_manager._tools == []
        assert not mcp_manager._initialized


@pytest.mark.unit
class TestMCPUtilityFunctions:
    """Test MCP utility functions."""

    @pytest.mark.asyncio
    async def test_get_mcp_tools_with_uninitialized_client(self):
        """Test get_mcp_tools when client is not initialized."""
        with patch("app.tooling.mcp.mcp_client.mcp_client_manager") as mock_manager:
            mock_manager.is_initialized = False
            mock_manager.initialize = AsyncMock()
            mock_manager.get_tools.return_value = []

            tools = await get_mcp_tools()

            mock_manager.initialize.assert_called_once()
            assert tools == []

    @pytest.mark.asyncio
    async def test_get_mcp_tools_with_initialized_client(self):
        """Test get_mcp_tools when client is already initialized."""
        mock_tools = [Mock(name="test_tool")]

        with patch("app.tooling.mcp.mcp_client.mcp_client_manager") as mock_manager:
            mock_manager.is_initialized = True
            mock_manager.initialize = AsyncMock()
            mock_manager.get_tools.return_value = mock_tools

            tools = await get_mcp_tools()

            mock_manager.initialize.assert_not_called()
            assert tools == mock_tools

    @pytest.mark.asyncio
    async def test_initialize_mcp(self):
        """Test initialize_mcp function."""
        with patch("app.tooling.mcp.mcp_client.mcp_client_manager") as mock_manager:
            mock_manager.initialize = AsyncMock()

            await initialize_mcp()

            mock_manager.initialize.assert_called_once()
