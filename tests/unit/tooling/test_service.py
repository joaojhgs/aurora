"""Unit tests for ToolingService."""

import json
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import Envelope, MessageBus
from app.services.tooling.service import ToolingService
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.tooling import (
    ToolingGetToolsResponse,
    ToolingMethods,
    ToolingToolInfo,
    ToolingToolProvenance,
)
from app.shared.messaging.models.tooling_models import (
    ToolsInitialized,
)


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.subscribe = Mock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock()
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


def _tool_info(
    *,
    name: str,
    local_name: str,
    provider_peer_id: str = "local",
    provider_service_instance_id: str = "local:Tooling",
    namespace: str = "local",
    source_type: str = "local",
    execution_location: str = "local",
    safety_class: str = "standard",
    confirmation_required: bool = False,
    required_permissions: list[str] | None = None,
) -> ToolingToolInfo:
    return ToolingToolInfo(
        name=name,
        local_name=local_name,
        global_tool_id=f"{provider_peer_id}:{provider_service_instance_id}:tool:{local_name}",
        provider_peer_id=provider_peer_id,
        provider_service_instance_id=provider_service_instance_id,
        namespace=namespace,
        display_name=f"{namespace}.{local_name}" if namespace != "local" else local_name,
        description="Test tool",
        args_schema={"type": "object", "properties": {}},
        schema={"type": "object", "properties": {}},
        source_type=source_type,
        execution_location=execution_location,
        safety_class=safety_class,
        required_permissions=required_permissions or [],
        confirmation_required=confirmation_required,
        provenance=ToolingToolProvenance(
            provider_peer_id=provider_peer_id,
            provider_service_instance_id=provider_service_instance_id,
            provider_kind=source_type,
            source="core",
            advertised_name=local_name,
        ),
    )


def _provider_candidate(
    peer_id: str,
    *,
    eligible: bool,
    reason_code: str = "eligible",
    reason: str = "eligible provider",
    last_manifest: float = 1.0,
):
    peer = Mock()
    peer.peer_id = peer_id
    peer.last_manifest = last_manifest
    service = Mock()
    service.module = "Tooling"
    candidate = Mock()
    candidate.peer = peer
    candidate.service = service
    candidate.eligible = eligible
    candidate.reason_code = reason_code
    candidate.reason = reason
    return candidate


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

        response = await tooling_service._on_get_tools(ToolingGetToolsRequest(query=None, top_k=10))

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
    async def test_get_tool_catalog_aggregates_local_and_remote_safe_tools(
        self, tooling_service, mock_bus
    ):
        """Aggregate catalog includes local and eligible remote safe tools."""
        from langchain_core.tools import tool

        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        @tool
        def local_lookup(input: str):
            """Local lookup."""
            return input

        tooling_service.tools_manager.get_tools = Mock(return_value=[local_lookup])
        candidate = _provider_candidate("raspi-lab", eligible=True)
        remote_tool = _tool_info(
            name="raspi-lab_switch_on",
            local_name="switch_on",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            namespace="raspi-lab",
            source_type="mesh_peer",
            execution_location="remote",
        )
        mock_bus.request = AsyncMock(
            return_value=QueryResult(
                ok=True,
                data=ToolingGetToolsResponse(tools=[remote_tool], count=1).model_dump(mode="json"),
            )
        )

        with patch.object(tooling_service, "_remote_tooling_candidates", return_value=[candidate]):
            response = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(query=None, top_k=10)
            )

        assert response.count == 2
        assert [tool.name for tool in response.tools] == ["local_lookup", "raspi-lab_switch_on"]
        assert response.providers[0].provider_kind == "local"
        assert response.providers[1].provider_peer_id == "raspi-lab"
        assert response.providers[1].eligible is True
        remote_request = mock_bus.request.await_args.args[1]
        assert remote_request.mesh_selector.peer_id == "raspi-lab"
        assert remote_request.mesh_selector.service_instance_id == "remote:raspi-lab:Tooling"

    @pytest.mark.asyncio
    async def test_get_tool_catalog_reports_blocked_provider(self, tooling_service, mock_bus):
        """Ineligible remote providers are returned with actionable reason codes."""
        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        candidate = _provider_candidate(
            "busy-peer",
            eligible=False,
            reason_code="provider_at_capacity",
            reason="provider is at capacity",
        )

        with patch.object(tooling_service, "_remote_tooling_candidates", return_value=[candidate]):
            response = await tooling_service._on_get_tool_catalog(ToolingGetToolCatalogRequest())

        assert response.count == 0
        assert response.providers[1].provider_peer_id == "busy-peer"
        assert response.providers[1].eligible is False
        assert response.providers[1].reason_code == "provider_at_capacity"
        assert response.providers[1].cache_status == "blocked"
        mock_bus.request.assert_not_called()

    @pytest.mark.asyncio
    async def test_get_tool_catalog_blocks_unsafe_tools_from_bindable_subset(
        self, tooling_service, mock_bus
    ):
        """Unsafe and approval-required tools are non-bindable catalog entries."""
        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        safe_tool = _tool_info(name="safe_lookup", local_name="safe_lookup")
        dangerous_tool = _tool_info(
            name="switch_on",
            local_name="switch_on",
            safety_class="dangerous",
        )
        confirm_tool = _tool_info(
            name="send_email",
            local_name="send_email",
            confirmation_required=True,
        )

        tooling_service._on_get_tools = AsyncMock(
            return_value=ToolingGetToolsResponse(
                tools=[safe_tool, dangerous_tool, confirm_tool],
                count=3,
            )
        )

        response = await tooling_service._on_get_tool_catalog(ToolingGetToolCatalogRequest())

        assert [tool.name for tool in response.tools] == ["safe_lookup"]
        assert response.blocked_count == 2
        assert {blocked.reason_code for blocked in response.blocked_tools} == {
            "confirmation_required",
            "unsafe_safety_class",
        }

    @pytest.mark.asyncio
    async def test_get_tool_catalog_blocks_tools_when_permissions_unknown(
        self, tooling_service, mock_bus
    ):
        """Permission-scoped tools are not advertised without caller permissions."""
        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        restricted_tool = _tool_info(
            name="restricted_lookup",
            local_name="restricted_lookup",
            required_permissions=["Tooling.RestrictedUse"],
        )
        tooling_service._on_get_tools = AsyncMock(
            return_value=ToolingGetToolsResponse(tools=[restricted_tool], count=1)
        )

        unknown_permissions = await tooling_service._on_get_tool_catalog(
            ToolingGetToolCatalogRequest()
        )
        allowed_permissions = await tooling_service._on_get_tool_catalog(
            ToolingGetToolCatalogRequest(caller_permissions=["Tooling.RestrictedUse"])
        )

        assert unknown_permissions.count == 0
        assert unknown_permissions.blocked_count == 1
        assert unknown_permissions.blocked_tools[0].reason_code == "permission_denied"
        assert [tool.name for tool in allowed_permissions.tools] == ["restricted_lookup"]

    @pytest.mark.asyncio
    async def test_get_tool_catalog_ignores_forged_payload_permissions_with_envelope(
        self, tooling_service, mock_bus
    ):
        """Authenticated bus calls derive permissions from envelope principal lookup."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        restricted_tool = _tool_info(
            name="restricted_lookup",
            local_name="restricted_lookup",
            required_permissions=["Tooling.RestrictedUse"],
        )
        request = ToolingGetToolCatalogRequest(caller_permissions=["*"])
        tooling_service._on_get_tools = AsyncMock(
            return_value=ToolingGetToolsResponse(tools=[restricted_tool], count=1)
        )
        mock_bus.request = AsyncMock(
            return_value=QueryResult(
                ok=True,
                data={
                    "id": "principal-1",
                    "username": "limited",
                    "permissions": [],
                    "is_admin": False,
                },
            )
        )

        response = await tooling_service._on_get_tool_catalog(
            request,
            envelope=Envelope(
                type=ToolingMethods.GET_TOOL_CATALOG,
                payload=request,
                principal_id="principal-1",
            ),
        )

        assert response.count == 0
        assert response.blocked_count == 1
        assert response.blocked_tools[0].reason_code == "permission_denied"

    @pytest.mark.asyncio
    async def test_get_tool_catalog_reports_remote_timeout_without_losing_local_tools(
        self, tooling_service, mock_bus
    ):
        """A slow remote provider is degraded while local catalog entries still return."""
        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        local_tool = _tool_info(name="local_lookup", local_name="local_lookup")
        tooling_service._on_get_tools = AsyncMock(
            return_value=ToolingGetToolsResponse(tools=[local_tool], count=1)
        )
        candidate = _provider_candidate("slow-peer", eligible=True)
        mock_bus.request = AsyncMock(side_effect=TimeoutError())

        with patch.object(tooling_service, "_remote_tooling_candidates", return_value=[candidate]):
            response = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(provider_timeout_seconds=0.1)
            )

        assert [tool.name for tool in response.tools] == ["local_lookup"]
        assert response.providers[1].provider_peer_id == "slow-peer"
        assert response.providers[1].eligible is False
        assert response.providers[1].reason_code == "provider_timeout"

    @pytest.mark.asyncio
    async def test_get_tool_catalog_uses_remote_cache_until_manifest_changes(
        self, tooling_service, mock_bus
    ):
        """Remote discovery is cached per peer query and invalidated by manifest timestamp."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        candidate = _provider_candidate("raspi-lab", eligible=True, last_manifest=10.0)
        remote_tool = _tool_info(
            name="raspi-lab_lookup",
            local_name="lookup",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            namespace="raspi-lab",
            source_type="mesh_peer",
            execution_location="remote",
        )
        mock_bus.request = AsyncMock(
            return_value=QueryResult(
                ok=True,
                data=ToolingGetToolsResponse(tools=[remote_tool], count=1).model_dump(mode="json"),
            )
        )

        with patch.object(tooling_service, "_remote_tooling_candidates", return_value=[candidate]):
            await tooling_service._on_get_tool_catalog(ToolingGetToolCatalogRequest())
            cached_response = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest()
            )

        assert mock_bus.request.await_count == 1
        assert cached_response.providers[1].cache_status == "hit"

        candidate.peer.last_manifest = 11.0
        with patch.object(tooling_service, "_remote_tooling_candidates", return_value=[candidate]):
            await tooling_service._on_get_tool_catalog(ToolingGetToolCatalogRequest())

        assert mock_bus.request.await_count == 2

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
