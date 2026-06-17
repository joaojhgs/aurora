"""Unit tests for ToolingService."""

import json
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import Envelope, MessageBus
from app.services.tooling.service import ToolingService
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.messaging.models.tooling_models import (
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
        mock_manager.get_all_tool_names = Mock(return_value=[])
        mock_tools_mgr.return_value = mock_manager

        service = ToolingService()
        service.tools_manager = mock_manager
        yield service


def _mock_call_text(*mocks: Mock) -> str:
    """Flatten mock calls so tests can assert logs omit sensitive values."""

    return "\n".join(str(call) for mock in mocks for call in mock.call_args_list)


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

        # Verify initialization event was published (may also include service announcement)
        assert mock_bus.publish.call_count >= 1
        # Find the ToolsInitialized publish call
        tools_init_calls = [
            call
            for call in mock_bus.publish.call_args_list
            if call[0][0] == ToolingMethods.TOOLS_INITIALIZED
        ]
        assert len(tools_init_calls) == 1
        assert isinstance(tools_init_calls[0][0][1], ToolsInitialized)

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
        assert hasattr(response, "tools")

    @pytest.mark.asyncio
    async def test_get_tools_preserves_local_tool_name_with_metadata(self, tooling_service):
        """Test local discovery remains backward compatible while adding metadata."""
        from langchain_core.tools import tool

        from app.shared.contracts.models.tooling import ToolingGetToolsRequest, ToolingToolInfo

        @tool
        def test_tool(input: str):
            """Test tool."""
            return input

        tooling_service.tools_manager.get_tools = Mock(return_value=[test_tool])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query=None, top_k=10)
        )

        assert response.count == 1
        tool_info = response.tools[0]
        assert isinstance(tool_info, ToolingToolInfo)
        assert tool_info.name == "test_tool"
        assert tool_info.local_name == "test_tool"
        assert tool_info.provider_peer_id == "local"
        assert tool_info.source_type == "local"
        assert tool_info.execution_location == "local"
        assert tool_info.global_tool_id == "local:local_Tooling:tool:test_tool"
        assert tool_info.provenance.advertised_name == "test_tool"
        assert "input" in tool_info.args_schema["properties"]

    @pytest.mark.asyncio
    async def test_get_tools_namespaces_remote_provider_collisions(self, tooling_service):
        """Test remote providers with colliding local tool names get distinct IDs."""
        from langchain_core.tools import tool

        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        @tool
        def switch_on(target: str):
            """Switch on a target."""
            return target

        tooling_service.tools_manager.get_tools = Mock(return_value=[switch_on])

        lab_response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(
                query=None,
                top_k=10,
                mesh_selector=MeshAddressSelector(
                    peer_id="raspi-lab",
                    service_instance_id="remote:raspi-lab:Tooling",
                ),
            )
        )
        workstation_response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(
                query=None,
                top_k=10,
                mesh_selector=MeshAddressSelector(
                    peer_id="workstation",
                    service_instance_id="remote:workstation:Tooling",
                ),
            )
        )

        lab_tool = lab_response.tools[0]
        workstation_tool = workstation_response.tools[0]

        assert lab_tool.local_name == workstation_tool.local_name == "switch_on"
        assert lab_tool.name == "raspi-lab_switch_on"
        assert workstation_tool.name == "workstation_switch_on"
        assert lab_tool.name != workstation_tool.name
        assert lab_tool.display_name == "raspi-lab.switch_on"
        assert workstation_tool.display_name == "workstation.switch_on"
        assert lab_tool.global_tool_id != workstation_tool.global_tool_id
        assert lab_tool.provider_peer_id == "raspi-lab"
        assert workstation_tool.provider_peer_id == "workstation"
        assert lab_tool.source_type == "mesh_peer"
        assert lab_tool.execution_location == "remote"

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
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingExecuteToolResponse,
        )

        # Create a mock tool that can accept ainvoke
        mock_tool = Mock()
        mock_tool.ainvoke = AsyncMock(return_value="Result: test")

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["test_tool"])

        # Contract methods receive the request model directly
        request = ToolingExecuteToolRequest(tool_name="test_tool", arguments={"input": "test"})

        response = await tooling_service._on_execute_tool(request)

        # Verify response was returned
        assert response is not None
        assert isinstance(response, ToolingExecuteToolResponse)
        assert response.ok is True
        assert response.status == "success"

    @pytest.mark.asyncio
    async def test_remote_dangerous_tool_requires_resource_before_invocation(
        self, tooling_service, mock_bus
    ):
        """Remote dangerous tools are denied before invocation without a resource."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_bus.request = AsyncMock()
        mock_tool = Mock()
        mock_tool.safety_class = "dangerous"
        mock_tool.confirmation_required = False
        mock_tool.ainvoke = AsyncMock(return_value="should-not-run")

        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        request = ToolingExecuteToolRequest(
            tool_name="switch_on",
            arguments={"target": "lamp"},
            mesh_selector=MeshAddressSelector(peer_id="raspi-lab"),
            confirmed=True,
            caller_peer_id="workstation",
            caller_principal_id="peer-principal",
            correlation_id="rpc-123",
        )

        response = await tooling_service._on_execute_tool(request)

        assert response.ok is False
        assert response.status == "denied"
        assert response.error_code == "resource_selector_required"
        mock_tool.ainvoke.assert_not_called()
        assert mock_bus.request.await_args.args[0] == AuthMethods.STORE_AUDIT_EVENT
        audit_request = mock_bus.request.await_args.args[1]
        details = json.loads(audit_request.details)
        assert details["caller_peer_id"] == "workstation"
        assert details["caller_principal_id"] == "peer-principal"
        assert details["target_peer_id"] == "raspi-lab"
        assert details["status"] == "denied"
        assert details["error_code"] == "resource_selector_required"

    @pytest.mark.asyncio
    async def test_remote_sensitive_tool_dry_run_audits_without_invocation(
        self, tooling_service, mock_bus
    ):
        """Dry-run remote execution records intent without invoking the tool."""
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingResourceSelector,
        )

        mock_bus.request = AsyncMock()
        mock_tool = Mock()
        mock_tool.safety_class = "sensitive"
        mock_tool.confirmation_required = True
        mock_tool.ainvoke = AsyncMock(return_value="should-not-run")

        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        request = ToolingExecuteToolRequest(
            tool_name="switch_on",
            arguments={"target": "lamp"},
            mesh_selector=MeshAddressSelector(peer_id="raspi-lab"),
            resource_selector=ToolingResourceSelector(hardware_target="lamp"),
            dry_run=True,
            caller_peer_id="workstation",
            caller_principal_id="peer-principal",
        )

        response = await tooling_service._on_execute_tool(request)

        assert response.ok is True
        assert response.status == "dry_run"
        assert response.data["dry_run"] is True
        mock_tool.ainvoke.assert_not_called()
        audit_request = mock_bus.request.await_args.args[1]
        details = json.loads(audit_request.details)
        assert details["status"] == "dry_run"
        assert details["resource_selector"]["hardware_target"] == "lamp"

    @pytest.mark.asyncio
    async def test_execute_tool_audit_redacts_argument_values(self, tooling_service, mock_bus):
        """Audit records carry argument hashes without raw secret values."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_bus.request = AsyncMock()
        mock_tool = Mock()
        mock_tool.ainvoke = AsyncMock(return_value="ok")

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["test_tool"])

        request = ToolingExecuteToolRequest(
            tool_name="test_tool",
            arguments={"input": "hello", "api_key": "super-secret"},
            caller_peer_id="workstation",
            caller_principal_id="peer-principal",
        )

        response = await tooling_service._on_execute_tool(request)

        assert response.ok is True
        audit_request = mock_bus.request.await_args.args[1]
        details_text = audit_request.details
        details = json.loads(details_text)
        assert "super-secret" not in details_text
        assert details["argument_hash"]
        assert details["status"] == "success"

    @pytest.mark.asyncio
    async def test_execute_tool_success_logs_redacted_context(self, tooling_service, mock_bus):
        """Success execution logs omit raw arguments and raw result values."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_tool = Mock()
        mock_tool.ainvoke = AsyncMock(return_value={"token": "secret-result-value"})

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["test_tool"])

        request = ToolingExecuteToolRequest(
            tool_name="test_tool",
            arguments={"api_key": "super-secret-argument", "input": "hello"},
            caller_peer_id="workstation",
            caller_principal_id="peer-principal",
            correlation_id="corr-success",
        )

        with (
            patch("app.services.tooling.service.log_debug") as log_debug,
            patch("app.services.tooling.service.log_error") as log_error,
        ):
            response = await tooling_service._on_execute_tool(request)

        assert response.ok is True
        logged_text = _mock_call_text(log_debug, log_error)
        assert "super-secret-argument" not in logged_text
        assert "secret-result-value" not in logged_text
        assert "argument_hash" in logged_text
        assert "corr-success" in logged_text

    @pytest.mark.asyncio
    async def test_policy_denial_logs_do_not_include_secret_arguments(
        self, tooling_service, mock_bus
    ):
        """Policy denial logs omit raw secret-like argument values."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_bus.request = AsyncMock()
        mock_tool = Mock()
        mock_tool.safety_class = "dangerous"
        mock_tool.confirmation_required = False
        mock_tool.ainvoke = AsyncMock(return_value="should-not-run")

        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        request = ToolingExecuteToolRequest(
            tool_name="switch_on",
            arguments={"api_key": "denied-secret-argument", "target": "lamp"},
            mesh_selector=MeshAddressSelector(peer_id="raspi-lab"),
            confirmed=True,
            caller_peer_id="workstation",
            caller_principal_id="peer-principal",
            correlation_id="corr-denied",
        )

        with (
            patch("app.services.tooling.service.log_debug") as log_debug,
            patch("app.services.tooling.service.log_error") as log_error,
        ):
            response = await tooling_service._on_execute_tool(request)

        assert response.ok is False
        assert response.status == "denied"
        mock_tool.ainvoke.assert_not_called()
        logged_text = _mock_call_text(log_debug, log_error)
        assert "denied-secret-argument" not in logged_text
        assert "argument_hash" in logged_text
        assert "corr-denied" in logged_text

    @pytest.mark.asyncio
    async def test_execute_tool_failure_logs_type_without_secret_values(
        self, tooling_service, mock_bus
    ):
        """Execution failure logs omit raw args and exception text that may echo args."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_tool = Mock()
        mock_tool.ainvoke = AsyncMock(
            side_effect=ValueError("failure echoed failure-secret-argument")
        )

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["failing_tool"])

        request = ToolingExecuteToolRequest(
            tool_name="failing_tool",
            arguments={"api_key": "failure-secret-argument", "input": "hello"},
            caller_peer_id="workstation",
            caller_principal_id="peer-principal",
            correlation_id="corr-failed",
        )

        with (
            patch("app.services.tooling.service.log_debug") as log_debug,
            patch("app.services.tooling.service.log_error") as log_error,
        ):
            response = await tooling_service._on_execute_tool(request)

        assert response.ok is False
        assert response.status == "failed"
        assert response.error == "Tool execution failed: ValueError"
        assert "failure-secret-argument" not in response.error
        logged_text = _mock_call_text(log_debug, log_error)
        assert "failure-secret-argument" not in logged_text
        assert "argument_hash" in logged_text
        assert "ValueError" in logged_text
        assert "corr-failed" in logged_text

    @pytest.mark.asyncio
    async def test_execute_tool_accepts_remote_namespaced_discovery_name(
        self, tooling_service, mock_bus
    ):
        """Test namespaced discovery names resolve to provider-local tool names."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_tool = Mock()
        mock_tool.ainvoke = AsyncMock(return_value="ok")

        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        request = ToolingExecuteToolRequest(
            tool_name="raspi-lab_switch_on",
            arguments={"target": "lamp"},
            mesh_selector=MeshAddressSelector(
                peer_id="raspi-lab",
                service_instance_id="remote:raspi-lab:Tooling",
            ),
        )

        response = await tooling_service._on_execute_tool(request)

        assert response.ok is True
        tooling_service.tools_manager.get_tool_by_name.assert_called_once_with("switch_on")

    @pytest.mark.asyncio
    async def test_execute_tool_accepts_global_tool_id(self, tooling_service, mock_bus):
        """Test stable global tool IDs resolve to provider-local tool names."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_tool = Mock()
        mock_tool.ainvoke = AsyncMock(return_value="ok")

        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        request = ToolingExecuteToolRequest(
            tool_name="raspi-lab:remote_raspi-lab_Tooling:tool:switch_on",
            arguments={"target": "lamp"},
            mesh_selector=MeshAddressSelector(
                peer_id="raspi-lab",
                service_instance_id="remote:raspi-lab:Tooling",
            ),
        )

        response = await tooling_service._on_execute_tool(request)

        assert response.ok is True
        tooling_service.tools_manager.get_tool_by_name.assert_called_once_with("switch_on")

    @pytest.mark.asyncio
    async def test_execute_tool_not_found(self, tooling_service, mock_bus):
        """Test tool execution when tool not found."""
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingExecuteToolResponse,
        )

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
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingExecuteToolResponse,
        )

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
