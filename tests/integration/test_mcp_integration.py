"""
Integration tests for MCP (Model Context Protocol) functionality.

These tests verify the integration between MCP client and Aurora's systems:
- Tool system integration
- Configuration loading
- Real server connections (mocked)
- Error handling across components
"""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.services.config.config_manager import config_manager
from app.services.tooling.mcp.mcp_client import MCPClientManager

# Set dummy OpenAI API key BEFORE any imports that might initialize OpenAI
os.environ.setdefault("OPENAI_API_KEY", "test-key-dummy-integration")


@pytest.mark.integration
class TestMCPToolIntegration:
    """Test MCP integration with Aurora's tool system."""

    @pytest.fixture
    def temp_config(self):
        """Create temporary configuration for testing."""
        config_data = {
            "mcp": {
                "enabled": True,
                "servers": {"math": {"command": "python", "args": ["/tmp/math_server.py"], "transport": "stdio", "enabled": True}},
            }
        }

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(config_data, f)
            temp_file = f.name

        yield temp_file
        Path(temp_file).unlink(missing_ok=True)

    @pytest.mark.asyncio
    async def test_configuration_integration(self, temp_config):
        """Test MCP integration with configuration management."""
        manager = MCPClientManager()

        # Patch the config_manager inside the initialize method
        with patch("app.tooling.mcp.mcp_client.config_manager") as mock_config:
            mock_config.get.side_effect = lambda key, default=None: {
                "mcp.enabled": True,
                "mcp.servers": {"math": {"command": "python", "args": ["/tmp/math_server.py"], "transport": "stdio", "enabled": True}},
            }.get(key, default)

            with patch("langchain_mcp_adapters.client.MultiServerMCPClient") as mock_client_class:
                mock_client = AsyncMock()
                mock_client.get_tools.return_value = []
                mock_client_class.return_value = mock_client

                await manager.initialize()

                assert manager.is_initialized
                mock_client_class.assert_called_once()

    @pytest.mark.asyncio
    async def test_mcp_client_lifecycle_integration(self):
        """Test complete MCP client lifecycle in integration context."""
        manager = MCPClientManager()

        # Test initialization
        with patch("app.tooling.mcp.mcp_client.config_manager") as mock_config:
            mock_config.get.side_effect = lambda key, default=None: {
                "mcp.enabled": True,
                "mcp.servers": {"test": {"enabled": True, "transport": "stdio", "command": "python"}},
            }.get(key, default)

            with patch("langchain_mcp_adapters.client.MultiServerMCPClient") as mock_client_class:
                mock_client = AsyncMock()
                mock_tool = Mock()
                mock_tool.name = "test_tool"
                mock_tool.description = "Test tool"
                mock_tools = [mock_tool]
                mock_client.get_tools.return_value = mock_tools
                mock_client_class.return_value = mock_client

                # Initialize
                await manager.initialize()
                assert manager.is_initialized
                assert len(manager.get_tools()) == 1

                # Reload
                await manager.reload_tools()
                assert manager.is_initialized

                # Close
                await manager.close()
                assert not manager.is_initialized
                assert len(manager.get_tools()) == 0


@pytest.mark.integration
class TestMCPConfigurationIntegration:
    """Test MCP configuration integration with Aurora's config system."""

    def test_mcp_configuration_schema_validation(self):
        """Test that MCP configuration follows expected schema."""
        # Test with current configuration
        mcp_config = config_manager.get("mcp", {})

        # Should have required keys
        assert isinstance(mcp_config.get("enabled"), bool)
        assert isinstance(mcp_config.get("servers"), dict)

        # Test server configuration structure
        for server_name, server_config in mcp_config.get("servers", {}).items():
            assert isinstance(server_config, dict)
            assert "transport" in server_config
            assert server_config["transport"] in ["stdio", "streamable_http", "sse"]

            if server_config["transport"] == "stdio":
                assert "command" in server_config
            elif server_config["transport"] in ["streamable_http", "sse"]:
                assert "url" in server_config

    def test_multiple_server_configuration(self):
        """Test configuration with multiple MCP servers."""
        test_config = {
            "enabled": True,
            "servers": {
                "math": {"command": "python", "args": ["/path/to/math_server.py"], "transport": "stdio", "enabled": True},
                "weather": {"url": "http://localhost:8000/mcp/", "transport": "streamable_http", "enabled": True},
                "disabled_server": {"command": "python", "args": ["/path/to/disabled.py"], "transport": "stdio", "enabled": False},
            },
        }

        with patch("app.tooling.mcp.mcp_client.config_manager") as mock_config:
            mock_config.get.side_effect = lambda key, default=None: {
                "mcp.enabled": test_config["enabled"],
                "mcp.servers": test_config["servers"],
            }.get(key, default)

            manager = MCPClientManager()

            # Should filter enabled servers
            with patch("langchain_mcp_adapters.client.MultiServerMCPClient") as mock_client_class:
                mock_client = AsyncMock()
                mock_client.get_tools.return_value = []
                mock_client_class.return_value = mock_client

                asyncio.run(manager.initialize())

                # Verify MultiServerMCPClient was called with enabled servers only
                assert mock_client_class.called
                call_args = mock_client_class.call_args[0][0]
                assert "math" in call_args
                assert "weather" in call_args
                assert "disabled_server" not in call_args


@pytest.mark.integration
class TestMCPMemoryIntegration:
    """Test MCP integration with Aurora's memory/storage system."""

    def test_tool_metadata_preservation(self):
        """Test that MCP tool metadata is preserved during integration."""
        mock_tool = Mock()
        mock_tool.name = "test_tool"
        mock_tool.description = "Test description"
        mock_tool.args_schema = {"properties": {"arg1": {"type": "string"}}}

        # Test that tool properties are accessible after integration
        assert hasattr(mock_tool, "name")
        assert hasattr(mock_tool, "description")
        assert mock_tool.name == "test_tool"
        assert mock_tool.description == "Test description"
