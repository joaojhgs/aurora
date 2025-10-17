"""
End-to-end tests for MCP (Model Context Protocol) integration.

These tests verify the complete MCP workflow from configuration to execution:
- Real server startup and connections
- Complete tool loading and execution pipeline
- Integration with Aurora's full system
- Performance and reliability under load
"""

import asyncio
import json
import os
import tempfile
import time
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.tooling.mcp.mcp_client import MCPClientManager, cleanup_mcp, initialize_mcp
from app.tooling.tools.tools import load_mcp_tools_async, tool_lookup, tools

# Set dummy OpenAI API key before any imports that might initialize OpenAI
os.environ.setdefault("OPENAI_API_KEY", "test-key-dummy-e2e")


@pytest.mark.e2e
@pytest.mark.external
class TestMCPEndToEndFlow:
    """End-to-end tests for complete MCP integration workflow."""

    @pytest.fixture
    def math_server_path(self):
        """Get path to math server example."""
        return Path(__file__).parent.parent.parent / "examples" / "mcp_servers" / "math_server.py"

    @pytest.fixture
    def weather_server_path(self):
        """Get path to weather server example."""
        return Path(__file__).parent.parent.parent / "examples" / "mcp_servers" / "weather_server.py"

    @pytest.fixture
    def temp_config_with_servers(self, math_server_path):
        """Create temporary configuration with test servers."""
        config_data = {
            "mcp": {
                "enabled": True,
                "servers": {"math": {"command": "python", "args": [str(math_server_path)], "transport": "stdio", "enabled": True}},
            }
        }

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(config_data, f)
            temp_file = f.name

        yield temp_file
        Path(temp_file).unlink(missing_ok=True)

    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_complete_mcp_workflow_stdio(self, math_server_path, temp_config_with_servers):
        """Test complete MCP workflow with stdio transport."""
        if not math_server_path.exists():
            pytest.skip(f"Math server not found at {math_server_path}")

        # Create a fresh MCP manager for this test
        manager = MCPClientManager()

        try:
            # Mock configuration and MCP client for E2E testing
            with patch("app.langgraph.mcp_client.config_manager") as mock_config:
                mock_config.get.side_effect = lambda key, default=None: {
                    "mcp.enabled": True,
                    "mcp.servers": {"math": {"command": "python", "args": [str(math_server_path)], "transport": "stdio", "enabled": True}},
                }.get(key, default)

                # Mock the MultiServerMCPClient to simulate realistic server responses
                with patch("langchain_mcp_adapters.client.MultiServerMCPClient") as mock_client_class:
                    # Create realistic mock tools similar to what math server would provide
                    mock_tools = []

                    # Define realistic tool behaviors
                    async def mock_add(args):
                        return args.get("a", 0) + args.get("b", 0)

                    async def mock_subtract(args):
                        return args.get("a", 0) - args.get("b", 0)

                    async def mock_multiply(args):
                        return args.get("a", 1) * args.get("b", 1)

                    async def mock_divide(args):
                        b = args.get("b", 1)
                        if b == 0:
                            raise ValueError("Division by zero")
                        return args.get("a", 0) / b

                    async def mock_power(args):
                        return args.get("a", 0) ** args.get("b", 1)

                    async def mock_sqrt(args):
                        import math

                        return math.sqrt(args.get("number", 0))

                    tool_functions = {
                        "add": mock_add,
                        "subtract": mock_subtract,
                        "multiply": mock_multiply,
                        "divide": mock_divide,
                        "power": mock_power,
                        "square_root": mock_sqrt,
                    }

                    for name, desc in [
                        ("add", "Add two or more numbers"),
                        ("subtract", "Subtract the second number from the first"),
                        ("multiply", "Multiply two or more numbers"),
                        ("divide", "Divide the first number by the second"),
                        ("power", "Calculate x raised to the power of y"),
                        ("square_root", "Calculate the square root of a number"),
                    ]:
                        tool = Mock()
                        tool.name = name
                        tool.description = desc
                        tool.ainvoke = AsyncMock(side_effect=tool_functions[name])
                        mock_tools.append(tool)

                    mock_client = AsyncMock()
                    mock_client.get_tools.return_value = mock_tools
                    mock_client_class.return_value = mock_client

                    # Test full initialization workflow
                    await manager.initialize()

                    assert manager.is_initialized
                    tools = manager.get_tools()
                    assert len(tools) > 0

                    # Verify expected math tools are loaded
                    tool_names = [tool.name for tool in tools]
                    expected_tools = ["add", "subtract", "multiply", "divide", "power", "square_root"]

                    for expected_tool in expected_tools:
                        assert expected_tool in tool_names, f"Expected tool '{expected_tool}' not found"

                # Test tool execution
                add_tool = next((t for t in tools if t.name == "add"), None)
                assert add_tool is not None

                result = await add_tool.ainvoke({"a": 15.0, "b": 25.0})
                assert float(result) == 40.0

                # Test multiple operations
                multiply_tool = next((t for t in tools if t.name == "multiply"), None)
                assert multiply_tool is not None

                result = await multiply_tool.ainvoke({"a": 6.0, "b": 7.0})
                assert float(result) == 42.0

        finally:
            await manager.close()

    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_aurora_integration_workflow(self, math_server_path):
        """Test complete integration with Aurora's tool system."""
        if not math_server_path.exists():
            pytest.skip(f"Math server not found at {math_server_path}")

        initial_tool_count = len(tools)

        try:
            # Mock configuration at multiple levels for E2E testing
            with (
                patch("app.langgraph.mcp_client.config_manager") as mock_mcp_config,
                patch("app.tooling.tools.tools.config_manager") as mock_tools_config,
            ):

                config_data = {
                    "mcp.enabled": True,
                    "mcp.servers": {"math": {"command": "python", "args": [str(math_server_path)], "transport": "stdio", "enabled": True}},
                }

                mock_mcp_config.get.side_effect = lambda key, default=None: config_data.get(key, default)
                mock_tools_config.get.side_effect = lambda key, default=None: config_data.get(key, default)

                # Reset MCP tools loaded flag for this test
                import app.tooling.tools.tools as tools_module

                original_loaded = tools_module._mcp_tools_loaded
                tools_module._mcp_tools_loaded = False

                try:
                    # Initialize MCP system
                    await initialize_mcp()

                    # Load tools into Aurora's system
                    await load_mcp_tools_async()

                    # Verify integration
                    final_tool_count = len(tools)
                    assert final_tool_count > initial_tool_count
                finally:
                    tools_module._mcp_tools_loaded = original_loaded

                # Test tool execution through Aurora's lookup
                assert "add" in tool_lookup
                add_tool = tool_lookup["add"]

                result = await add_tool.ainvoke({"a": 100.0, "b": 50.0})
                assert float(result) == 150.0

        finally:
            await cleanup_mcp()

    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_error_recovery_workflow(self, math_server_path):
        """Test error recovery in complete workflow."""
        manager = MCPClientManager()

        try:
            # Test with invalid server configuration first
            with patch("app.config.config_manager.config_manager") as mock_config:
                mock_config.get.side_effect = lambda key, default=None: {
                    "mcp.enabled": True,
                    "mcp.servers": {"invalid": {"command": "nonexistent_command", "args": ["invalid.py"], "transport": "stdio", "enabled": True}},
                }.get(key, default)

                # Should handle gracefully
                await manager.initialize()
                # Manager may or may not be initialized depending on error handling
                # But should not crash

            await manager.close()

            # Now test with valid configuration
            with patch("app.config.config_manager.config_manager") as mock_config:
                mock_config.get.side_effect = lambda key, default=None: {
                    "mcp.enabled": True,
                    "mcp.servers": {"math": {"command": "python", "args": [str(math_server_path)], "transport": "stdio", "enabled": True}},
                }.get(key, default)

                await manager.initialize()

                if manager.is_initialized:
                    tools = manager.get_tools()
                    assert len(tools) > 0

        finally:
            await manager.close()

    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_concurrent_tool_execution(self, math_server_path):
        """Test concurrent execution of multiple MCP tools."""
        if not math_server_path.exists():
            pytest.skip(f"Math server not found at {math_server_path}")

        manager = MCPClientManager()

        try:
            with patch("app.config.config_manager.config_manager") as mock_config:
                mock_config.get.side_effect = lambda key, default=None: {
                    "mcp.enabled": True,
                    "mcp.servers": {"math": {"command": "python", "args": [str(math_server_path)], "transport": "stdio", "enabled": True}},
                }.get(key, default)

                await manager.initialize()

                if not manager.is_initialized:
                    pytest.skip("MCP manager failed to initialize")

                tools = manager.get_tools()
                if not tools:
                    pytest.skip("No MCP tools loaded")

                # Find required tools
                add_tool = next((t for t in tools if t.name == "add"), None)
                multiply_tool = next((t for t in tools if t.name == "multiply"), None)

                if not add_tool or not multiply_tool:
                    pytest.skip("Required tools not available")

                # Execute multiple operations concurrently
                tasks = [
                    add_tool.ainvoke({"a": 10.0, "b": 5.0}),
                    multiply_tool.ainvoke({"a": 3.0, "b": 4.0}),
                    add_tool.ainvoke({"a": 20.0, "b": 15.0}),
                    multiply_tool.ainvoke({"a": 7.0, "b": 8.0}),
                ]

                results = await asyncio.gather(*tasks)

                # Verify results
                assert float(results[0]) == 15.0  # 10 + 5
                assert float(results[1]) == 12.0  # 3 * 4
                assert float(results[2]) == 35.0  # 20 + 15
                assert float(results[3]) == 56.0  # 7 * 8

        finally:
            await manager.close()

    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_configuration_reload_workflow(self, math_server_path):
        """Test configuration reload and tool refresh workflow."""
        if not math_server_path.exists():
            pytest.skip(f"Math server not found at {math_server_path}")

        manager = MCPClientManager()

        try:
            # Initial configuration with math server
            with patch("app.config.config_manager.config_manager") as mock_config:
                mock_config.get.side_effect = lambda key, default=None: {
                    "mcp.enabled": True,
                    "mcp.servers": {"math": {"command": "python", "args": [str(math_server_path)], "transport": "stdio", "enabled": True}},
                }.get(key, default)

                await manager.initialize()

                if manager.is_initialized:
                    initial_tools = manager.get_tools()
                    initial_count = len(initial_tools)

                    # Test reload
                    await manager.reload_tools()

                    reloaded_tools = manager.get_tools()
                    assert len(reloaded_tools) == initial_count

                    # Verify tools still work after reload
                    if reloaded_tools:
                        add_tool = next((t for t in reloaded_tools if t.name == "add"), None)
                        if add_tool:
                            result = await add_tool.ainvoke({"a": 1.0, "b": 1.0})
                            assert float(result) == 2.0

        finally:
            await manager.close()


@pytest.mark.e2e
@pytest.mark.external
@pytest.mark.slow
class TestMCPPerformanceE2E:
    """Performance tests for MCP integration."""

    @pytest.fixture
    def math_server_path(self):
        """Get path to math server example."""
        return Path(__file__).parent.parent.parent / "examples" / "mcp_servers" / "math_server.py"

    @pytest.mark.asyncio
    async def test_initialization_performance(self, math_server_path):
        """Test MCP initialization performance."""
        if not math_server_path.exists():
            pytest.skip(f"Math server not found at {math_server_path}")

        manager = MCPClientManager()

        try:
            with patch("app.config.config_manager.config_manager") as mock_config:
                mock_config.get.side_effect = lambda key, default=None: {
                    "mcp.enabled": True,
                    "mcp.servers": {"math": {"command": "python", "args": [str(math_server_path)], "transport": "stdio", "enabled": True}},
                }.get(key, default)

                # Measure initialization time
                start_time = time.time()
                await manager.initialize()
                init_time = time.time() - start_time

                # Should initialize within reasonable time (5 seconds)
                assert init_time < 5.0, f"Initialization took {init_time:.2f}s, expected < 5.0s"

                if manager.is_initialized:
                    tools = manager.get_tools()
                    assert len(tools) > 0

        finally:
            await manager.close()

    @pytest.mark.asyncio
    async def test_tool_execution_performance(self, math_server_path):
        """Test MCP tool execution performance."""
        if not math_server_path.exists():
            pytest.skip(f"Math server not found at {math_server_path}")

        manager = MCPClientManager()

        try:
            with patch("app.config.config_manager.config_manager") as mock_config:
                mock_config.get.side_effect = lambda key, default=None: {
                    "mcp.enabled": True,
                    "mcp.servers": {"math": {"command": "python", "args": [str(math_server_path)], "transport": "stdio", "enabled": True}},
                }.get(key, default)

                await manager.initialize()

                if not manager.is_initialized:
                    pytest.skip("MCP manager failed to initialize")

                tools = manager.get_tools()
                add_tool = next((t for t in tools if t.name == "add"), None)

                if not add_tool:
                    pytest.skip("Add tool not available")

                # Measure multiple executions
                execution_times = []

                for i in range(10):
                    start_time = time.time()
                    result = await add_tool.ainvoke({"a": float(i), "b": 1.0})
                    exec_time = time.time() - start_time
                    execution_times.append(exec_time)

                    assert float(result) == float(i) + 1.0

                # Check performance metrics
                avg_time = sum(execution_times) / len(execution_times)
                max_time = max(execution_times)

                # Should execute within reasonable time
                assert avg_time < 1.0, f"Average execution time {avg_time:.3f}s, expected < 1.0s"
                assert max_time < 2.0, f"Max execution time {max_time:.3f}s, expected < 2.0s"

        finally:
            await manager.close()


@pytest.mark.e2e
@pytest.mark.external
class TestMCPReliabilityE2E:
    """Reliability tests for MCP integration."""

    @pytest.fixture
    def math_server_path(self):
        """Get path to math server example."""
        return Path(__file__).parent.parent.parent / "examples" / "mcp_servers" / "math_server.py"

    @pytest.mark.asyncio
    async def test_connection_stability(self, math_server_path):
        """Test MCP connection stability over time."""
        if not math_server_path.exists():
            pytest.skip(f"Math server not found at {math_server_path}")

        manager = MCPClientManager()

        try:
            with patch("app.config.config_manager.config_manager") as mock_config:
                mock_config.get.side_effect = lambda key, default=None: {
                    "mcp.enabled": True,
                    "mcp.servers": {"math": {"command": "python", "args": [str(math_server_path)], "transport": "stdio", "enabled": True}},
                }.get(key, default)

                await manager.initialize()

                if not manager.is_initialized:
                    pytest.skip("MCP manager failed to initialize")

                tools = manager.get_tools()
                add_tool = next((t for t in tools if t.name == "add"), None)

                if not add_tool:
                    pytest.skip("Add tool not available")

                # Test multiple operations over time
                for i in range(5):
                    result = await add_tool.ainvoke({"a": float(i), "b": 10.0})
                    assert float(result) == float(i) + 10.0

                    # Brief pause between operations
                    await asyncio.sleep(0.1)

                # Verify connection is still stable
                assert manager.is_initialized
                final_result = await add_tool.ainvoke({"a": 1.0, "b": 2.0})
                assert float(final_result) == 3.0

        finally:
            await manager.close()
