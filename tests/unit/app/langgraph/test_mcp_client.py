"""
Tests for MCP (Model Context Protocol) integration.

This module tests the MCP client functionality including:
- Client initialization and configuration
- Tool loading from MCP servers
- Integration with Aurora's tool system
- Error handling and edge cases
"""

import os
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

    # @pytest.mark.asyncio
    # async def test_initialize_with_import_error(self, mcp_manager, config_manager):
    #     """Test handling of import errors when MCP dependencies are missing."""
    #     servers_config = {"math": {"command": "python", "args": ["/path/to/math_server.py"], "transport": "stdio", "enabled": True}}

    #     config_manager.get.side_effect = lambda key, default=None: {"mcp.enabled": True, "mcp.servers": servers_config}.get(key, default)

    #     with (
    #         patch("app.tooling.mcp.mcp_client.config_manager", config_manager),
    #         patch("builtins.__import__", side_effect=ImportError("langchain-mcp-adapters not found")),
    #     ):

    #         await mcp_manager.initialize()

    #     assert not mcp_manager.is_initialized
    #     assert len(mcp_manager.get_tools()) == 0

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

    # @pytest.mark.asyncio
    # async def test_reload_tools(self, mcp_manager, config_manager):
    #     """Test reloading tools from MCP servers."""
    #     servers_config = {"math": {"command": "python", "args": ["/path/to/math_server.py"], "transport": "stdio", "enabled": True}}

    #     config_manager.get.side_effect = lambda key, default=None: {"mcp.enabled": True, "mcp.servers": servers_config}.get(key, default)

    #     mock_client = AsyncMock()
    #     mock_tools = [Mock(name="add", description="Add two numbers")]
    #     mock_client.get_tools.return_value = mock_tools

    #     with (
    #         patch("app.tooling.mcp.mcp_client.config_manager", config_manager),
    #         patch("langchain_mcp_adapters.client.MultiServerMCPClient", return_value=mock_client),
    #     ):

    #         # Initial load
    #         await mcp_manager.initialize()
    #         assert len(mcp_manager.get_tools()) == 1

    #         # Reload
    #         await mcp_manager.reload_tools()
    #         assert len(mcp_manager.get_tools()) == 1

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

    @pytest.mark.asyncio
    async def test_reload_tools(self, mcp_manager):
        """Test reloading tools from MCP servers."""
        with patch.object(mcp_manager, "close") as mock_close, patch.object(mcp_manager, "initialize") as mock_init:

            await mcp_manager.reload_tools()

            mock_close.assert_called_once()
            mock_init.assert_called_once()

    def test_prepare_stdio_server_config(self, mcp_manager):
        """Test preparing stdio server configuration."""
        server_config = {"command": "python", "args": ["/path/to/server.py"], "transport": "stdio"}

        result = mcp_manager._prepare_server_config(server_config)

        expected = {"transport": "stdio", "command": "python", "args": ["/path/to/server.py"]}
        assert result == expected

    def test_prepare_http_server_config(self, mcp_manager):
        """Test preparing HTTP server configuration."""
        server_config = {"url": "http://localhost:8000/mcp/", "transport": "streamable_http", "headers": {"Authorization": "Bearer token"}}

        result = mcp_manager._prepare_server_config(server_config)

        expected = {"transport": "streamable_http", "url": "http://localhost:8000/mcp/", "headers": {"Authorization": "Bearer token"}}
        assert result == expected

    @pytest.mark.asyncio
    async def test_initialize_with_import_error(self, mcp_manager, config_manager):
        """Test initialization when MCP dependencies are not available."""
        config_manager.get.side_effect = lambda key, default=None: {"mcp.enabled": True, "mcp.servers": {"test": {"enabled": True}}}.get(key, default)

        with patch("app.tooling.mcp.mcp_client.config_manager", config_manager), patch("builtins.__import__", side_effect=ImportError("No module")):

            await mcp_manager.initialize()

        assert not mcp_manager.is_initialized
        assert len(mcp_manager.get_tools()) == 0

    @pytest.mark.asyncio
    async def test_load_tools_failure(self, mcp_manager, config_manager):
        """Test handling of tool loading failures."""
        config_manager.get.side_effect = lambda key, default=None: {
            "mcp.enabled": True,
            "mcp.servers": {"test": {"enabled": True, "transport": "stdio", "command": "test-command"}},
        }.get(key, default)

        mock_client = AsyncMock()
        mock_client.get_tools.side_effect = Exception("Tool loading failed")

        with (
            patch("app.tooling.mcp.mcp_client.config_manager", config_manager),
            patch("langchain_mcp_adapters.client.MultiServerMCPClient", return_value=mock_client),
        ):

            await mcp_manager.initialize()

        assert mcp_manager.is_initialized  # Client initialized but tools failed
        assert len(mcp_manager.get_tools()) == 0


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


@pytest.mark.integration
class TestMCPIntegration:
    """Integration tests for MCP with Aurora's tool system."""

    # NOTE: MCP tool loading integration tests have been removed because
    # load_mcp_tools_async() is now deprecated. MCP tools are loaded by
    # ToolingService instead. See app/services/tooling_service.py and
    # app/tooling/tools_manager.py for the new implementation.
    # Integration tests for the new system should be added in
    # tests/integration/test_tooling_service.py

    pass


class TestMCPConfigurationValidation:
    """Test MCP configuration validation."""

    def test_valid_stdio_configuration(self):
        """Test validation of valid stdio configuration."""

        config = {"mcp": {"enabled": True, "servers": {"math": {"transport": "stdio", "command": "python", "args": ["/path/to/server.py"]}}}}

        # This would normally be tested with the actual config validation
        # For now, we just ensure the structure is correct
        assert config["mcp"]["enabled"] is True
        assert "math" in config["mcp"]["servers"]
        assert config["mcp"]["servers"]["math"]["transport"] == "stdio"

    def test_valid_http_configuration(self):
        """Test validation of valid HTTP configuration."""
        config = {
            "mcp": {
                "enabled": True,
                "servers": {
                    "weather": {"transport": "streamable_http", "url": "http://localhost:8000/mcp/", "headers": {"Authorization": "Bearer token"}}
                },
            }
        }

        assert config["mcp"]["enabled"] is True
        assert "weather" in config["mcp"]["servers"]
        assert config["mcp"]["servers"]["weather"]["transport"] == "streamable_http"
        assert "headers" in config["mcp"]["servers"]["weather"]


@pytest.mark.e2e
class TestMCPEndToEnd:
    """End-to-end tests for MCP integration (requires actual MCP servers)."""

    @pytest.mark.skip(reason="Requires actual MCP server running")
    @pytest.mark.asyncio
    async def test_connect_to_real_math_server(self):
        """Test connecting to a real math MCP server."""
        # This test would start the example math server and connect to it
        # Skipped by default as it requires external processes
        pass

    @pytest.mark.skip(reason="Requires actual MCP server running")
    @pytest.mark.asyncio
    async def test_connect_to_real_weather_server(self):
        """Test connecting to a real weather HTTP MCP server."""
        # This test would start the example weather server and connect to it
        # Skipped by default as it requires external processes
        pass
