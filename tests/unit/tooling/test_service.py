"""Unit tests for ToolingService."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import Envelope, MessageBus, QueryResult
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.policy_store import MeshPolicySnapshot
from app.services.tooling.identity import (
    canonical_tool_global_id,
    source_tool_identity,
    stamp_tool,
)
from app.services.tooling.service import TOOLING_DB_REQUEST_TIMEOUT_SECONDS, ToolingService
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.db import DBMethods
from app.shared.contracts.models.mesh import (
    MeshAddressSelector,
    MeshEvents,
    MeshPeerPermissionsUpdatedEvent,
)
from app.shared.contracts.models.tooling import (
    JS_SAFE_INTEGER_MAX,
    ToolingExecuteToolRequest,
    ToolingGetToolCatalogRequest,
    ToolingGetToolsResponse,
    ToolingMeshProjectionReadiness,
    ToolingMethods,
    ToolingModule,
    ToolingPrepareExecutionRequest,
    ToolingProjectionInvalidated,
    ToolingRemoteCatalogAnnounced,
    ToolingRemoteCatalogDeltaAnnounced,
    ToolingRequestApprovalRequest,
    ToolingToolInfo,
    ToolingToolProvenance,
)
from app.shared.messaging.models.tooling_models import (
    ToolsInitialized,
)
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


class _DummyTool:
    def __init__(
        self,
        name: str,
        description: str,
        *,
        trust_tier: str | None = None,
        source: str | None = None,
        module: str | None = None,
    ) -> None:
        if module is not None:
            self.__module__ = module
        self.name = name
        self.description = description
        self.args_schema = None
        self.required_permissions = []
        self.confirmation_required = False
        if trust_tier is not None:
            self.trust_tier = trust_tier
        if source is not None:
            self.source = source


def _loaded_tools_with_duckduckgo_after_top_k(top_k: int = 10) -> list[_DummyTool]:
    return [
        _DummyTool(f"calendar_helper_{index}", "Calendar scheduling helper")
        for index in range(top_k)
    ] + [
        _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events and latest news.",
            module="langchain_community.tools.ddg_search.tool",
        )
    ]


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
        service._config.aupdate_config = AsyncMock(return_value=True)
        yield service


def _install_approved_peer_authority(mock_bus) -> AsyncMock:
    """Make remote-tool tests model the Auth authority required in production."""

    async def request(method, payload, **_kwargs):
        if method == AuthMethods.MESH_GET_PEER:
            peer_id = str(payload.peer_id)
            return QueryResult(
                ok=True,
                data={
                    "peer": {
                        "id": f"peer-row:{peer_id}",
                        "peer_id": peer_id,
                        "outbound_status": "approved",
                        "outbound_permissions": [ToolingMethods.EXECUTE_TOOL],
                    }
                },
            )
        return QueryResult(ok=True, data={"ok": True})

    request_mock = AsyncMock(side_effect=request)
    mock_bus.request = request_mock
    return request_mock


def test_remote_catalog_mutation_contracts_are_internal_only():
    """Remote catalog mutation methods are bus-internal and not externally callable."""

    methods = [
        ToolingService._on_remote_catalog_announced,
        ToolingService._on_remote_catalog_delta_announced,
        ToolingService._on_remote_catalog_removed,
        ToolingService._on_remote_catalog_refresh_requested,
    ]

    for method in methods:
        metadata = getattr(method, "_contract_metadata", {})
        assert metadata.get("exposure") == "internal"


@pytest.mark.asyncio
async def test_startup_recovery_defers_pruning_and_requests_fresh_full_sync(tooling_service):
    """Recovery stays lean while stale providers request fresh authenticated state."""

    peer_id = "stable-peer-recovery"
    tooling_service._mesh_projection_enforcement_active = True
    tooling_service._remote_tooling_candidates = Mock(
        return_value=[
            SimpleNamespace(
                peer=SimpleNamespace(peer_id=peer_id),
                eligible=True,
                decision=SimpleNamespace(granted_permissions=["Tooling.GetTools"]),
            )
        ]
    )

    async def request(topic, payload, **kwargs):
        if topic == DBMethods.RECOVER_TOOLING_REMOTE_CATALOGS:
            return QueryResult(
                ok=True,
                data={
                    "ok": True,
                    "recovered_sync_count": 1,
                    "imported_legacy_provider_count": 0,
                    "imported_legacy_tool_count": 0,
                    "providers_needing_sync": [peer_id],
                    "recovered_sync_ids": ["sync-crashed-1234"],
                },
            )
        if topic == DBMethods.PRUNE_TOOLING_REMOTE_CATALOG_RETENTION:
            return QueryResult(
                ok=True,
                data={
                    "ok": True,
                    "compacted_tool_count": 0,
                    "pruned_audit_count": 0,
                    "providers": [],
                },
            )
        if topic == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(
                ok=True,
                data={
                    "headers": [
                        {
                            "peer_id": peer_id,
                            "provider_id": peer_id,
                            "service_instance_id": "remote:stable:Tooling",
                        }
                    ],
                    "tools": [],
                },
            )
        raise AssertionError(topic)

    tooling_service.bus.request = AsyncMock(side_effect=request)
    await tooling_service._recover_normalized_remote_catalogs()

    assert tooling_service._normalized_catalog_recovery_failed is False
    published = tooling_service.bus.publish.call_args
    assert published.args[0] == ToolingMethods.PROJECTION_SYNC_REQUESTED
    assert published.args[1].provider_peer_id == peer_id
    assert published.args[1].service_instance_id == "remote:stable:Tooling"
    assert published.args[1].force_full_snapshot is True
    requested_topics = [call.args[0] for call in tooling_service.bus.request.await_args_list]
    assert DBMethods.PRUNE_TOOLING_REMOTE_CATALOG_RETENTION not in requested_topics


@pytest.mark.asyncio
async def test_startup_recovery_does_not_fetch_offline_provider(tooling_service):
    """Durable recovery never upgrades retained rows into live transport authority."""

    peer_id = "stable-peer-offline"
    tooling_service._mesh_projection_enforcement_active = True
    tooling_service._remote_tooling_candidates = Mock(return_value=[])

    async def request(topic, payload, **kwargs):
        if topic == DBMethods.RECOVER_TOOLING_REMOTE_CATALOGS:
            return QueryResult(
                ok=True,
                data={"ok": True, "providers_needing_sync": [peer_id]},
            )
        if topic == DBMethods.PRUNE_TOOLING_REMOTE_CATALOG_RETENTION:
            return QueryResult(
                ok=True,
                data={
                    "ok": True,
                    "compacted_tool_count": 0,
                    "pruned_audit_count": 0,
                    "providers": [],
                },
            )
        if topic == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(
                ok=True,
                data={
                    "headers": [
                        {
                            "peer_id": peer_id,
                            "provider_id": peer_id,
                            "service_instance_id": f"remote:{peer_id}:Tooling",
                        }
                    ]
                },
            )
        raise AssertionError(topic)

    tooling_service.bus.request = AsyncMock(side_effect=request)
    await tooling_service._recover_normalized_remote_catalogs()

    tooling_service.bus.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_startup_recovery_failure_blocks_normalized_binding(tooling_service):
    """A recovery storage failure cannot expose cached normalized definitions."""

    tooling_service._mesh_projection_enforcement_active = True
    tooling_service.bus.request = AsyncMock(
        return_value=QueryResult(ok=False, error="storage unavailable")
    )
    await tooling_service._recover_normalized_remote_catalogs()
    assert tooling_service._normalized_catalog_recovery_failed is True
    tooling_service.bus.request.reset_mock()
    assert await tooling_service._load_normalized_bindable_remote_catalogs() == []
    tooling_service.bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_local_catalog_invalidation_publishes_js_safe_deterministic_revision(
    tooling_service,
):
    tool = _DummyTool("alpha", "Local exported tool")
    stamp_tool(
        tool,
        source_tool_identity(
            source_kind="plugin",
            stable_source_id="local-suite",
            provider_tool_id=tool.name,
            share_group_id="plugin:local-suite",
            share_group_label="Local suite",
        ),
    )
    tooling_service._stable_peer_id = "provider"
    tooling_service.tools_manager.get_tools.return_value = [tool]
    tooling_service._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            policy=SimpleNamespace(revision=7),
            mesh_switches=SimpleNamespace(revision=11),
        )
    )

    await tooling_service._announce_local_tool_catalog(
        reason="reload",
        affected_peer_ids=["peer-a"],
    )
    first_call = tooling_service.bus.publish.await_args
    first = first_call.args[1]
    first_revision = first.authority_revision.catalog_revision

    await tooling_service._announce_local_tool_catalog(reason="reload")
    second = tooling_service.bus.publish.await_args.args[1]
    tool.description = "Updated local exported tool"
    await tooling_service._announce_local_tool_catalog(reason="reload")
    changed = tooling_service.bus.publish.await_args.args[1]

    assert first_call.args[0] == ToolingMethods.PROJECTION_INVALIDATED
    assert isinstance(first, ToolingProjectionInvalidated)
    assert ToolingProjectionInvalidated.model_validate(first.model_dump(mode="python"))
    assert first.provider_peer_id == "provider"
    assert first.service_instance_id == "local:Tooling"
    assert first.reason_code == "reload"
    assert first.affected_peer_ids == ["peer-a"]
    assert first.authority_revision.export_policy_revision == 7
    assert first.authority_revision.auth_grant_revision == 0
    assert first.authority_revision.manifest_revision == 0
    assert first.authority_revision.switch_revision == 11
    assert 0 <= first_revision <= JS_SAFE_INTEGER_MAX
    assert second.authority_revision.catalog_revision == first_revision
    assert changed.authority_revision.catalog_revision != first_revision
    assert first_call.kwargs["event"] is True
    assert first_call.kwargs["mesh"] is False
    assert first_call.kwargs["origin"] == "internal"


@pytest.mark.asyncio
async def test_committed_normalized_projection_is_bindable_only_after_activation(
    tooling_service,
):
    """G013 binds only active tools from the committed current generation."""

    from app.messaging import QueryResult

    peer_id = "peer-normalized"
    provider_id = peer_id
    service_instance_id = f"remote:{peer_id}:Tooling"
    active = _tool_info(
        name="peer-normalized_lookup",
        local_name="lookup",
        provider_peer_id=peer_id,
        provider_service_instance_id=service_instance_id,
        namespace=peer_id,
        source_type="mesh_peer",
        execution_location="remote",
    )
    retired = active.model_copy(
        update={
            "name": "peer-normalized_old",
            "local_name": "old",
            "global_tool_id": f"{peer_id}:{provider_id}:tool:old",
        }
    )
    authority = {
        "catalog_revision": 1,
        "export_policy_revision": 2,
        "auth_grant_revision": 3,
        "manifest_revision": 4,
        "switch_revision": 5,
        "protocol_revision": 1,
    }
    tooling_service._mesh_projection_enforcement_active = True
    tooling_service._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            mesh_switches=SimpleNamespace(consumer_mesh_tooling_enabled=True)
        )
    )
    tooling_service.bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data={
                "headers": [
                    {
                        "peer_id": peer_id,
                        "provider_id": provider_id,
                        "service_instance_id": service_instance_id,
                        "protocol_tier": "projection_v1",
                        "projection_digest": "a" * 64,
                        "authority_revision": authority,
                        "current_generation": 7,
                        "sync_state": "committed",
                        "availability": "active",
                    }
                ],
                "tools": [
                    {
                        "peer_id": peer_id,
                        "provider_id": provider_id,
                        "tool": active.model_dump(mode="python"),
                        "availability": "active",
                        "active_generation": 7,
                    },
                    {
                        "peer_id": peer_id,
                        "provider_id": provider_id,
                        "tool": retired.model_dump(mode="python"),
                        "availability": "retired",
                        "active_generation": 6,
                    },
                ],
            },
        )
    )

    snapshots = await tooling_service._load_normalized_bindable_remote_catalogs()

    assert len(snapshots) == 1
    assert snapshots[0].peer_id == peer_id
    assert [tool.global_tool_id for tool in snapshots[0].tools] == [active.global_tool_id]


def test_remote_tooling_candidates_uses_one_mesh_policy_snapshot(tooling_service):
    snapshot = MeshPolicySnapshot(
        revision=77,
        source_revision=123,
        mesh_config=MeshConfig(
            enabled=True,
            version_policy="exact",
            services={ToolingModule.NAME: mesh_policy(prefer="network")},
        ),
    )
    candidate = SimpleNamespace(peer=SimpleNamespace(peer_id="tool-peer"))
    registry = Mock()
    registry.get_provider_candidates.return_value = [candidate]
    tooling_service.bus._routing_table = SimpleNamespace(_registry=registry)
    tooling_service.bus.current_mesh_policy_snapshot = Mock(return_value=snapshot)

    candidates = tooling_service._remote_tooling_candidates()

    assert candidates == [candidate]
    tooling_service.bus.current_mesh_policy_snapshot.assert_called_once_with()
    registry.get_provider_candidates.assert_called_once_with(
        module=ToolingModule.NAME,
        topic=ToolingMethods.GET_TOOLS,
        routing_config=snapshot.mesh_config.services[ToolingModule.NAME],
        version_policy="exact",
        include_ineligible=True,
        policy_snapshot=snapshot,
    )
    assert registry.get_provider_candidates.call_args.kwargs["policy_snapshot"].revision == 77


@pytest.mark.asyncio
async def test_reload_services_uses_supported_mcp_reload_api(tooling_service):
    """Broad service config changes must not call a nonexistent manager API."""
    tooling_service._load_sharing_policy_from_config = AsyncMock()
    tooling_service._announce_local_tool_catalog = AsyncMock()
    tooling_service.tools_manager.reload_plugin_tools = AsyncMock()
    tooling_service.tools_manager.reload_mcp_tools = AsyncMock()
    tooling_service._catalog_cache["cached"] = (0.0, Mock())

    await tooling_service.reload("services")

    tooling_service.tools_manager.reload_plugin_tools.assert_awaited_once_with()
    tooling_service.tools_manager.reload_mcp_tools.assert_awaited_once_with()
    tooling_service._load_sharing_policy_from_config.assert_awaited_once_with()
    tooling_service._announce_local_tool_catalog.assert_awaited_once_with(reason="reload")
    assert tooling_service._catalog_cache == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("config_section", "expected_reload", "announcement_reason"),
    [
        ("services.tooling.mcp", "mcp", "mcp_reload"),
        ("services.tooling.plugins", "plugins", "plugin_reload"),
    ],
)
async def test_reload_tool_manager_subsections_refresh_only_the_owning_manager(
    tooling_service,
    config_section: str,
    expected_reload: str,
    announcement_reason: str,
):
    """MCP and plugin config leaves refresh their own manager and catalog."""
    tooling_service._load_sharing_policy_from_config = AsyncMock()
    tooling_service._announce_local_tool_catalog = AsyncMock()
    tooling_service.tools_manager.reload_plugin_tools = AsyncMock()
    tooling_service.tools_manager.reload_mcp_tools = AsyncMock()
    tooling_service._catalog_cache["cached"] = (0.0, Mock())

    await tooling_service.reload(config_section)

    if expected_reload == "mcp":
        tooling_service.tools_manager.reload_mcp_tools.assert_awaited_once_with()
        tooling_service.tools_manager.reload_plugin_tools.assert_not_awaited()
    else:
        tooling_service.tools_manager.reload_plugin_tools.assert_awaited_once_with()
        tooling_service.tools_manager.reload_mcp_tools.assert_not_awaited()
    tooling_service._load_sharing_policy_from_config.assert_not_awaited()
    tooling_service._announce_local_tool_catalog.assert_awaited_once_with(
        reason=announcement_reason
    )
    assert tooling_service._catalog_cache == {}


@pytest.mark.asyncio
async def test_reload_tooling_policy_keeps_manager_reload_out_of_catalog_path(tooling_service):
    """Policy-only Tooling changes must not churn plugin or MCP managers."""
    tooling_service._load_sharing_policy_from_config = AsyncMock()
    tooling_service._announce_local_tool_catalog = AsyncMock()
    tooling_service.tools_manager.reload_plugin_tools = AsyncMock()
    tooling_service.tools_manager.reload_mcp_tools = AsyncMock()

    await tooling_service.reload("services.tooling")

    tooling_service._load_sharing_policy_from_config.assert_awaited_once_with()
    tooling_service.tools_manager.reload_plugin_tools.assert_not_awaited()
    tooling_service.tools_manager.reload_mcp_tools.assert_not_awaited()
    tooling_service._announce_local_tool_catalog.assert_awaited_once_with(reason="policy_reload")


@pytest.mark.asyncio
async def test_prepare_execution_honors_explicit_internal_delegated_permissions(tooling_service):
    """System-origin scheduler calls may deliberately carry delegated caller permissions."""

    tool = Mock()
    tool.name = "restricted_switch"
    tool.description = "Restricted switch"
    tool.args_schema = {"type": "object", "properties": {"target": {"type": "string"}}}
    tool.required_permissions = ["Device.Control"]
    tool.source = "core"
    tool.safety_class = "standard"
    tool.confirmation_required = False
    tooling_service.tools_manager.get_tool_by_name = Mock(return_value=tool)

    denied = await tooling_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(
            tool_name="restricted_switch",
            arguments={"target": "lamp"},
            caller_permissions=[],
        ),
        envelope=Envelope(type=ToolingMethods.PREPARE_EXECUTION, payload={}, origin="system"),
    )
    assert denied.ok is False
    assert denied.policy_decision.reason == "permission_denied"

    allowed = await tooling_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(
            tool_name="restricted_switch",
            arguments={"target": "lamp"},
            caller_permissions=["Device.Control"],
        ),
        envelope=Envelope(type=ToolingMethods.PREPARE_EXECUTION, payload={}, origin="system"),
    )
    assert allowed.ok is True


@pytest.mark.asyncio
async def test_prepare_execution_rejects_schema_unavailable(tooling_service):
    """Scheduled prepare cannot persist an unhashable unknown tool schema."""

    tool = Mock()
    tool.name = "unknown_schema_tool"
    tool.description = "Tool without schema"
    tool.args_schema = None
    tool.required_permissions = []
    tool.source = "core"
    tool.safety_class = "standard"
    tool.confirmation_required = False
    tooling_service.tools_manager.get_tool_by_name = Mock(return_value=tool)

    response = await tooling_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(
            tool_name="unknown_schema_tool",
            arguments={"anything": "goes"},
        )
    )

    assert response.ok is False
    assert response.policy_decision.reason == "schema_unavailable"


@pytest.mark.asyncio
async def test_request_approval_allows_live_tool_without_schema(tooling_service):
    """Live operator approval must work for local core tools without args_schema metadata."""

    tool = Mock()
    tool.name = "unknown_schema_tool"
    tool.description = "Tool without schema"
    tool.args_schema = None
    tool.required_permissions = []
    tool.source = "core"
    tool.safety_class = "standard"
    tool.confirmation_required = True
    tooling_service.tools_manager.get_tool_by_name = Mock(return_value=tool)

    response = await tooling_service._on_request_approval(
        ToolingRequestApprovalRequest(
            tool_name="unknown_schema_tool",
            arguments={},
        )
    )

    assert response.ok is True
    assert response.approval_request_id
    assert response.policy_decision.approval_required is True


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
    source: str = "core",
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
        source=source,
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
    granted_permissions: list[str] | None = None,
):
    peer = Mock()
    peer.peer_id = peer_id
    peer.node_name = peer_id
    peer.last_manifest = last_manifest
    peer.manifest = Mock(
        granted_permissions=["*"] if granted_permissions is None else granted_permissions
    )
    service = Mock()
    service.module = "Tooling"
    candidate = Mock()
    candidate.peer = peer
    candidate.service = service
    candidate.eligible = eligible
    candidate.reason_code = reason_code
    candidate.reason = reason
    candidate.decision = Mock(
        granted_permissions=tuple(["*"] if granted_permissions is None else granted_permissions)
    )
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
        tooling_service._migrate_legacy_tool_export_policy = AsyncMock()
        tooling_service._activate_mesh_projection_enforcement = AsyncMock()
        tooling_service._on_get_mesh_projection_readiness = AsyncMock(
            return_value=ToolingMeshProjectionReadiness(
                projection_transport=True,
                normalized_catalog=True,
                consumer_binding=True,
                provider_discovery=True,
                prepare_enforcement=True,
                execute_enforcement=True,
                legacy_guard_active=True,
                durable_active=False,
                durable_revision=0,
            )
        )
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
        tooling_service._on_get_mesh_projection_readiness.assert_awaited_once()

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
    async def test_start_publishes_readiness_before_deferred_retention(
        self, tooling_service, mock_bus
    ):
        """Retention maintenance cannot hold Tooling readiness hostage."""

        order: list[str] = []
        retention_release = asyncio.Event()

        async def activate() -> None:
            tooling_service._mesh_projection_enforcement_active = True

        async def publish(topic, *_args, **_kwargs):
            order.append(topic)

        async def retention_loop() -> None:
            order.append("retention-started")
            await retention_release.wait()

        tooling_service._load_sharing_policy_from_config = AsyncMock()
        tooling_service._ensure_tooling_policy_tables = AsyncMock()
        tooling_service._load_stable_tooling_peer_id = AsyncMock()
        tooling_service._reconcile_local_tool_identities = AsyncMock()
        tooling_service._migrate_legacy_tool_export_policy = AsyncMock()
        tooling_service._activate_mesh_projection_enforcement = AsyncMock(side_effect=activate)
        tooling_service._recover_normalized_remote_catalogs = AsyncMock()
        tooling_service._on_get_mesh_projection_readiness = AsyncMock(
            return_value=ToolingMeshProjectionReadiness(
                projection_transport=True,
                normalized_catalog=True,
                consumer_binding=True,
                provider_discovery=True,
                prepare_enforcement=True,
                execute_enforcement=True,
                legacy_guard_active=True,
                durable_active=False,
                durable_revision=0,
            )
        )
        tooling_service._announce_local_tool_catalog = AsyncMock()
        tooling_service._remote_catalog_retention_loop = AsyncMock(side_effect=retention_loop)
        mock_bus.publish.side_effect = publish

        await asyncio.wait_for(tooling_service.on_start(), timeout=0.5)
        await asyncio.sleep(0)

        assert ToolingMethods.MESH_PROJECTION_READINESS_CHANGED in order
        assert order.index(ToolingMethods.MESH_PROJECTION_READINESS_CHANGED) < order.index(
            "retention-started"
        )

        retention_release.set()
        await tooling_service.on_stop()

    @pytest.mark.asyncio
    async def test_retention_uses_full_sqlite_busy_window_budget(self, tooling_service, mock_bus):
        mock_bus.request.return_value = QueryResult(
            ok=True,
            data={
                "ok": True,
                "compacted_tool_count": 0,
                "compacted_management_metadata_count": 0,
                "pruned_audit_count": 0,
                "providers": [],
            },
        )

        await tooling_service._prune_normalized_remote_catalog_retention()

        assert mock_bus.request.await_args.args[0] == (
            DBMethods.PRUNE_TOOLING_REMOTE_CATALOG_RETENTION
        )
        assert mock_bus.request.await_args.kwargs["timeout"] == (TOOLING_DB_REQUEST_TIMEOUT_SECONDS)

    @pytest.mark.asyncio
    async def test_startup_recovery_uses_full_sqlite_busy_window_budget(
        self, tooling_service, mock_bus
    ):
        tooling_service._mesh_projection_enforcement_active = True
        mock_bus.request.return_value = QueryResult(
            ok=True,
            data={
                "ok": True,
                "providers_needing_sync": [],
                "recovered_sync_count": 0,
                "imported_legacy_provider_count": 0,
                "imported_legacy_tool_count": 0,
                "recovered_sync_ids": [],
            },
        )

        await tooling_service._recover_normalized_remote_catalogs()

        assert mock_bus.request.await_args.args[0] == (DBMethods.RECOVER_TOOLING_REMOTE_CATALOGS)
        assert mock_bus.request.await_args.kwargs["timeout"] == (TOOLING_DB_REQUEST_TIMEOUT_SECONDS)

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
        assert tool_info.risk_class == "standard"
        assert tool_info.data_egress is False
        assert tool_info.mutating is False
        assert tool_info.external is False
        assert tool_info.admin is False
        assert tool_info.privacy_hints == []
        assert tool_info.global_tool_id == "local:local_Tooling:tool:test_tool"
        assert tool_info.provenance.advertised_name == "test_tool"
        assert "input" in tool_info.args_schema["properties"]

    @pytest.mark.asyncio
    async def test_get_tools_uses_stable_loader_identity_without_service_instance_keying(
        self, tooling_service
    ):
        """Canonical authority survives display/service-instance changes."""
        from langchain_core.tools import tool

        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingGetToolsRequest,
        )

        @tool
        def renamed_display_tool(input: str):
            """Presentation name may change independently of authority."""
            return input

        identity = source_tool_identity(
            source_kind="plugin",
            stable_source_id="calendar-plugin",
            provider_tool_id="create-event-v1",
            share_group_id="plugin:calendar-plugin",
            share_group_label="Calendar",
        )
        stamp_tool(renamed_display_tool, identity)
        tooling_service._stable_peer_id = "aurora-stable-peer"
        tooling_service.tools_manager.get_tools = Mock(return_value=[renamed_display_tool])

        response = await tooling_service._on_get_tools(ToolingGetToolsRequest(query=None, top_k=10))

        discovered = response.tools[0]
        assert discovered.global_tool_id == canonical_tool_global_id(
            "aurora-stable-peer", identity.tool_contract_id
        )
        assert discovered.provider_peer_id == "aurora-stable-peer"
        assert discovered.source_type == "local"
        assert discovered.execution_location == "local"
        assert discovered.tool_contract_id == identity.tool_contract_id
        assert discovered.share_group_id == "plugin:calendar-plugin"
        assert discovered.exportable is True
        assert "local:local_Tooling:tool:renamed_display_tool" in (
            discovered.legacy_global_tool_ids
        )
        assert "local:Tooling" not in discovered.global_tool_id

        policy_context = tooling_service._policy_context(
            ToolingExecuteToolRequest(
                tool_name="renamed_display_tool",
                arguments={"input": "value"},
            ),
            tool=renamed_display_tool,
            local_tool_name="renamed_display_tool",
            global_tool_id=discovered.global_tool_id,
            provider_peer_id="aurora-stable-peer",
            service_instance_id="local:Tooling",
        )
        assert policy_context["execution_location"] == "local"
        assert policy_context["source_type"] == "plugin"

    @pytest.mark.asyncio
    async def test_get_tools_includes_risk_and_privacy_hints(self, tooling_service):
        """Discovery exposes canonical risk, egress, mutation, external, and admin hints."""
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        risky_tool = Mock()
        risky_tool.source = "core"
        risky_tool.name = "send_admin_report"
        risky_tool.description = "Send an admin report externally"
        risky_tool.args_schema = None
        risky_tool.safety_class = "sensitive"
        risky_tool.risk_class = "dangerous"
        risky_tool.operation_class = "admin"
        risky_tool.data_egress = True
        risky_tool.external = True
        risky_tool.privacy_hints = ["contains_user_data"]

        tooling_service.tools_manager.get_tools = Mock(return_value=[risky_tool])

        response = await tooling_service._on_get_tools(ToolingGetToolsRequest(query=None, top_k=10))

        assert response.count == 1
        tool_info = response.tools[0]
        assert tool_info.risk_class == "dangerous"
        assert tool_info.safety_class == "sensitive"
        assert tool_info.data_egress is True
        assert tool_info.mutating is True
        assert tool_info.external is True
        assert tool_info.admin is True
        assert tool_info.privacy_hints == [
            "admin",
            "contains_user_data",
            "data_egress",
            "external",
            "mutating",
            "risk:sensitive",
        ]

    @pytest.mark.asyncio
    async def test_get_tool_catalog_aggregates_local_and_remote_safe_tools(
        self, tooling_service, mock_bus
    ):
        """Aggregate catalog includes local tools and cached negotiated remote tools."""
        from langchain_core.tools import tool

        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        @tool
        def local_lookup(input: str):
            """Local lookup."""
            return input

        tooling_service.tools_manager.get_tools = Mock(return_value=[local_lookup])
        remote_tool = _tool_info(
            name="raspi-lab_switch_on",
            local_name="switch_on",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            namespace="raspi-lab",
            source_type="mesh_peer",
            execution_location="remote",
        )
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash",
            tools=[remote_tool],
            shared_by_policy=True,
        )

        with (
            patch.object(
                tooling_service,
                "_load_remote_catalog_snapshots",
                AsyncMock(return_value=[snapshot]),
            ),
            patch.object(
                tooling_service,
                "_remote_tooling_candidates",
                Mock(return_value=[_provider_candidate("raspi-lab", eligible=True)]),
            ),
        ):
            response = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(query=None, top_k=10)
            )

        assert response.count == 1
        assert [tool.name for tool in response.tools] == ["local_lookup"]
        assert response.blocked_count == 1
        assert response.blocked_tools[0].reason_code == "legacy_unverifiable"
        assert response.blocked_tools[0].tool.name == "raspi-lab_switch_on"
        assert response.providers[0].provider_kind == "local"
        assert response.providers[1].provider_peer_id == "raspi-lab"
        assert response.providers[1].eligible is False
        assert response.providers[1].cache_status == "blocked"
        mock_bus.request.assert_not_called()

    @pytest.mark.asyncio
    async def test_persisted_provider_liveness_never_makes_cached_tools_callable(
        self, tooling_service
    ):
        """A restart must fail closed until Gateway supplies fresh session state."""

        remote_tool = _tool_info(
            name="raspi-lab_lookup",
            local_name="lookup",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            namespace="raspi-lab",
            source_type="mesh_peer",
            execution_location="remote",
            required_permissions=["Tooling.ExecuteTool"],
        )
        stale_snapshot = ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-10T00:00:00Z",
            full_schema_hash="hash",
            tools=[remote_tool],
            granted_permissions=["Tooling.ExecuteTool"],
            provider_available=True,
        )
        tooling_service._on_get_tools = AsyncMock(
            return_value=ToolingGetToolsResponse(tools=[], count=0)
        )

        with (
            patch.object(
                tooling_service,
                "_load_remote_catalog_snapshots",
                AsyncMock(return_value=[stale_snapshot]),
            ),
            patch.object(tooling_service, "_remote_tooling_candidates", Mock(return_value=[])),
        ):
            catalog = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(caller_permissions=["*"])
            )

        assert catalog.tools == []
        assert catalog.blocked_tools[0].reason_code == "legacy_unverifiable"
        assert catalog.blocked_tools[0].tool.global_tool_id == remote_tool.global_tool_id

    @pytest.mark.asyncio
    async def test_live_candidate_never_falls_back_to_stale_persisted_grants(self, tooling_service):
        """An authenticated provider without grant authority stays fail closed."""

        remote_tool = _tool_info(
            name="raspi-lab_lookup",
            local_name="lookup",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            namespace="raspi-lab",
            source_type="mesh_peer",
            execution_location="remote",
            required_permissions=["Tooling.ExecuteTool"],
        )
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-10T00:00:00Z",
            full_schema_hash="hash",
            tools=[remote_tool],
            granted_permissions=["*"],
            provider_available=True,
        )
        candidate = _provider_candidate("raspi-lab", eligible=True)
        candidate.decision.granted_permissions = None
        tooling_service._on_get_tools = AsyncMock(
            return_value=ToolingGetToolsResponse(tools=[], count=0)
        )

        with (
            patch.object(
                tooling_service,
                "_load_remote_catalog_snapshots",
                AsyncMock(return_value=[snapshot]),
            ),
            patch.object(
                tooling_service,
                "_remote_tooling_candidates",
                Mock(return_value=[candidate]),
            ),
        ):
            catalog = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(caller_permissions=["*"])
            )

        assert catalog.tools == []
        assert catalog.blocked_tools[0].reason_code == "legacy_unverifiable"

    @pytest.mark.asyncio
    async def test_live_permission_revoke_and_restore_preserves_remote_tool_identity(
        self, tooling_service
    ):
        """Permission changes toggle callability without deleting the cached registry."""

        peer_id = "raspi-lab"
        service_instance_id = f"remote:{peer_id}:Tooling"
        remote_tool = _tool_info(
            name="raspi-lab_lookup",
            local_name="lookup",
            provider_peer_id=peer_id,
            provider_service_instance_id=service_instance_id,
            namespace=peer_id,
            source_type="mesh_peer",
            execution_location="remote",
            required_permissions=["Tooling.ExecuteTool"],
        )
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=1,
            generated_at="2026-07-10T00:00:00Z",
            full_schema_hash="hash",
            tools=[remote_tool],
            granted_permissions=["Tooling.ExecuteTool"],
        )
        tooling_service._remote_catalog_snapshots[(peer_id, service_instance_id)] = (
            snapshot,
            0.0,
        )
        tooling_service._on_get_tools = AsyncMock(
            return_value=ToolingGetToolsResponse(tools=[], count=0)
        )
        tooling_service._persist_remote_catalog_snapshot = AsyncMock()

        async def apply_provider_state(grants: list[str]):
            await tooling_service._on_remote_catalog_delta_announced(
                ToolingRemoteCatalogDeltaAnnounced(
                    peer_id=peer_id,
                    service_instance_id=service_instance_id,
                    provider_id=peer_id,
                    catalog_epoch=2,
                    generated_at="2026-07-10T00:01:00Z",
                    granted_permissions=grants,
                    provider_available=True,
                )
            )
            with (
                patch.object(
                    tooling_service,
                    "_load_remote_catalog_snapshots",
                    AsyncMock(return_value=[snapshot]),
                ),
                patch.object(
                    tooling_service,
                    "_remote_tooling_candidates",
                    Mock(
                        return_value=[
                            _provider_candidate(peer_id, eligible=True, granted_permissions=grants)
                        ]
                    ),
                ),
            ):
                return await tooling_service._on_get_tool_catalog(
                    ToolingGetToolCatalogRequest(caller_permissions=["*"])
                )

        allowed_before = await apply_provider_state(["Tooling.ExecuteTool"])
        denied = await apply_provider_state([])
        allowed_after = await apply_provider_state(["Tooling.ExecuteTool"])

        assert allowed_before.tools == []
        assert denied.tools == []
        assert denied.blocked_tools[0].reason_code == "legacy_unverifiable"
        assert denied.blocked_tools[0].missing_permissions == []
        assert denied.blocked_tools[0].tool.global_tool_id == remote_tool.global_tool_id
        assert allowed_after.tools == []
        assert tooling_service._remote_catalog_snapshots[(peer_id, service_instance_id)][
            0
        ].tools == [remote_tool]

    @pytest.mark.asyncio
    async def test_normalized_catalog_does_not_reuse_stale_volatile_grants_after_registry_revoke(
        self, tooling_service
    ):
        """Live registry loss after permission reduction blocks cached remote tools."""

        peer_id = "raspi-lab"
        service_instance_id = f"remote:{peer_id}:Tooling"
        remote_tool = _tool_info(
            name="raspi-lab_lookup",
            local_name="lookup",
            provider_peer_id=peer_id,
            provider_service_instance_id=service_instance_id,
            namespace=peer_id,
            source_type="mesh_peer",
            execution_location="remote",
            required_permissions=["Tooling.ExecuteTool"],
        )
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=1,
            generated_at="2026-07-10T00:00:00Z",
            full_schema_hash="hash",
            tools=[remote_tool],
            granted_permissions=None,
        )
        tooling_service._remote_provider_states[(peer_id, service_instance_id)] = (
            ["Tooling.ExecuteTool"],
            True,
        )
        tooling_service._on_get_tools = AsyncMock(
            return_value=ToolingGetToolsResponse(tools=[], count=0)
        )

        with (
            patch.object(
                tooling_service,
                "_load_normalized_bindable_remote_catalogs",
                AsyncMock(return_value=[snapshot]),
            ),
            patch.object(
                tooling_service,
                "_load_remote_catalog_snapshots",
                AsyncMock(return_value=[]),
            ),
            patch.object(
                tooling_service,
                "_remote_tooling_registry_available",
                Mock(return_value=True),
            ),
            patch.object(
                tooling_service,
                "_remote_tooling_candidates",
                Mock(return_value=[]),
            ),
        ):
            catalog = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(
                    caller_permissions=["*"],
                    include_blocked_tools=True,
                )
            )

        assert catalog.tools == []
        assert catalog.blocked_tools[0].reason_code == "provider_unavailable"
        assert catalog.blocked_tools[0].tool.global_tool_id == remote_tool.global_tool_id

    @pytest.mark.asyncio
    async def test_mesh_permission_update_invalidates_catalog_without_overwriting_remote_grants(
        self, tooling_service
    ):
        """Outbound Auth changes preserve reciprocal manifest authority."""

        peer_id = "raspi-lab"
        service_instance_id = f"local:{peer_id}:Tooling"
        tooling_service._remote_provider_states[(peer_id, service_instance_id)] = (
            ["Tooling.ExecuteTool", "Native.GetDeviceStatus"],
            True,
        )
        tooling_service._catalog_cache["stale"] = (
            9999999999.0,
            ToolingGetToolsResponse(tools=[], count=0),
        )

        await tooling_service._on_mesh_peer_permissions_updated(
            Envelope(
                type=MeshEvents.PEER_PERMISSIONS_UPDATED,
                payload=MeshPeerPermissionsUpdatedEvent(
                    peer_id=peer_id,
                    permissions=["Gateway.GetMeshStatus", "Auth.WhoAmI"],
                ),
            )
        )

        assert tooling_service._remote_provider_states[(peer_id, service_instance_id)] == (
            ["Tooling.ExecuteTool", "Native.GetDeviceStatus"],
            True,
        )
        assert tooling_service._catalog_cache == {}

    @pytest.mark.asyncio
    async def test_mesh_permission_reduction_immediately_blocks_cached_remote_tools(
        self, tooling_service
    ):
        """Fresh Auth grants override stale candidate grants for cached discovery."""

        peer_id = "raspi-lab"
        service_instance_id = f"local:{peer_id}:Tooling"
        remote_tool = _tool_info(
            name="raspi-lab_device_status",
            local_name="native.get_device_status",
            provider_peer_id=peer_id,
            provider_service_instance_id=service_instance_id,
            namespace=peer_id,
            source_type="mesh_peer",
            execution_location="remote",
            required_permissions=["Native.GetDeviceStatus"],
        )
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=1,
            generated_at="2026-08-02T00:00:00Z",
            full_schema_hash="hash",
            tools=[remote_tool],
            shared_by_policy=True,
        )
        tooling_service._remote_provider_states[(peer_id, service_instance_id)] = (
            ["Native.GetDeviceStatus"],
            True,
        )
        tooling_service._on_get_tools = AsyncMock(
            return_value=ToolingGetToolsResponse(tools=[], count=0)
        )

        await tooling_service._on_mesh_peer_permissions_updated(
            Envelope(
                type=MeshEvents.PEER_PERMISSIONS_UPDATED,
                payload=MeshPeerPermissionsUpdatedEvent(
                    peer_id=peer_id,
                    permissions=["Gateway.GetMeshStatus", "Auth.WhoAmI"],
                ),
            )
        )

        tooling_service._mesh_projection_enforcement_active = True
        tooling_service.bus.request = AsyncMock(
            return_value=QueryResult(
                ok=True,
                data={
                    "peer": {
                        "id": "peer-row",
                        "peer_id": peer_id,
                        "outbound_status": "approved",
                        "outbound_permissions": [
                            "Gateway.GetMeshStatus",
                            "Auth.WhoAmI",
                        ],
                    }
                },
            )
        )

        with (
            patch.object(
                tooling_service,
                "_load_normalized_bindable_remote_catalogs",
                AsyncMock(return_value=[snapshot]),
            ),
            patch.object(
                tooling_service,
                "_load_remote_catalog_snapshots",
                AsyncMock(return_value=[]),
            ),
            patch.object(
                tooling_service,
                "_remote_tooling_candidates",
                Mock(
                    return_value=[
                        _provider_candidate(
                            peer_id,
                            eligible=True,
                            granted_permissions=[
                                ToolingMethods.GET_TOOLS,
                                "Native.GetDeviceStatus",
                            ],
                        )
                    ]
                ),
            ),
        ):
            catalog = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(
                    caller_permissions=["*"],
                    include_blocked_tools=True,
                )
            )

        assert catalog.tools == []
        assert catalog.providers[1].eligible is False
        assert catalog.providers[1].reason_code == "permission_denied"
        assert catalog.blocked_tools[0].reason_code == "permission_denied"

    @pytest.mark.asyncio
    async def test_remote_execution_rechecks_current_outbound_peer_permissions(
        self, tooling_service
    ):
        """A known remote tool ID cannot bypass a live Auth permission reduction."""

        peer_id = "raspi-lab"
        service_instance_id = f"local:{peer_id}:Tooling"
        remote_tool = _tool_info(
            name="raspi-lab_device_status",
            local_name="native.get_device_status",
            provider_peer_id=peer_id,
            provider_service_instance_id=service_instance_id,
            namespace=peer_id,
            source_type="mesh_peer",
            execution_location="remote",
        )
        tooling_service._mesh_projection_enforcement_active = False
        tooling_service.bus.request = AsyncMock(
            return_value=QueryResult(
                ok=True,
                data={
                    "peer": {
                        "id": "peer-row",
                        "peer_id": peer_id,
                        "outbound_status": "approved",
                        "outbound_permissions": ["Gateway.GetMeshStatus", "Auth.WhoAmI"],
                    }
                },
            )
        )

        with (
            patch.object(
                tooling_service,
                "_load_normalized_bindable_remote_catalogs",
                AsyncMock(
                    return_value=[
                        ToolingRemoteCatalogAnnounced(
                            peer_id=peer_id,
                            service_instance_id=service_instance_id,
                            provider_id=peer_id,
                            catalog_epoch=1,
                            generated_at="2026-08-02T00:00:00Z",
                            full_schema_hash="hash",
                            tools=[remote_tool],
                            shared_by_policy=True,
                        )
                    ]
                ),
            ),
            patch.object(
                tooling_service,
                "_remote_tooling_candidates",
                Mock(return_value=[_provider_candidate(peer_id, eligible=True)]),
            ),
        ):
            authorized = await tooling_service._consumer_mesh_execution_authorized(
                ToolingExecuteToolRequest(
                    tool_name=remote_tool.global_tool_id,
                    arguments={},
                    mesh_selector=MeshAddressSelector(
                        peer_id=peer_id,
                        service_instance_id=service_instance_id,
                        tool_id=remote_tool.global_tool_id,
                    ),
                )
            )

        assert authorized is False

    @pytest.mark.asyncio
    async def test_get_tool_catalog_reports_blocked_provider(self, tooling_service, mock_bus):
        """Cached providers that are not shared by policy are returned as ineligible."""
        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        remote_tool = _tool_info(
            name="busy-peer_hidden_tool",
            local_name="hidden_tool",
            provider_peer_id="busy-peer",
            provider_service_instance_id="remote:busy-peer:Tooling",
            namespace="busy-peer",
            source_type="mesh_peer",
            execution_location="remote",
        )
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id="busy-peer",
            service_instance_id="remote:busy-peer:Tooling",
            provider_id="busy-peer",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash",
            tools=[remote_tool],
            shared_by_policy=False,
        )

        with patch.object(
            tooling_service, "_load_remote_catalog_snapshots", AsyncMock(return_value=[snapshot])
        ):
            response = await tooling_service._on_get_tool_catalog(ToolingGetToolCatalogRequest())

        assert response.count == 0
        assert response.blocked_count == 1
        assert response.tools == []
        assert response.blocked_tools[0].reason_code == "legacy_unverifiable"
        assert response.blocked_tools[0].tool.name == "busy-peer_hidden_tool"
        assert response.providers[1].provider_peer_id == "busy-peer"
        assert response.providers[1].eligible is False
        assert response.providers[1].reason_code == "legacy_unverifiable"

    @pytest.mark.asyncio
    async def test_get_tool_catalog_excludes_removed_remote_snapshots(
        self, tooling_service, mock_bus
    ):
        """Removed remote catalogs disappear from the aggregate catalog cache."""
        from app.shared.contracts.models.tooling import (
            ToolingGetToolCatalogRequest,
            ToolingRemoteCatalogRemoved,
        )

        remote_tool = _tool_info(
            name="removed-peer_hidden_tool",
            local_name="hidden_tool",
            provider_peer_id="removed-peer",
            provider_service_instance_id="remote:removed-peer:Tooling",
            namespace="removed-peer",
            source_type="mesh_peer",
            execution_location="remote",
        )
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id="removed-peer",
            service_instance_id="remote:removed-peer:Tooling",
            provider_id="removed-peer",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash",
            tools=[remote_tool],
            shared_by_policy=True,
        )
        tooling_service._remote_catalog_snapshots[
            (snapshot.peer_id, snapshot.service_instance_id)
        ] = (
            snapshot,
            0.0,
        )
        await tooling_service._on_remote_catalog_removed(
            ToolingRemoteCatalogRemoved(
                peer_id="removed-peer",
                service_instance_id="remote:removed-peer:Tooling",
                reason="peer_disconnected",
            )
        )

        response = await tooling_service._on_get_tool_catalog(ToolingGetToolCatalogRequest())

        assert all(tool.provider_peer_id != "removed-peer" for tool in response.tools)
        assert all(provider.provider_peer_id != "removed-peer" for provider in response.providers)

    @pytest.mark.asyncio
    async def test_get_tool_catalog_exposes_unsafe_tools_for_runtime_approval(
        self, tooling_service, mock_bus
    ):
        """Local core approval tools stay in one visible group for runtime approval."""
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

        assert sorted(tool.name for tool in response.tools) == [
            "safe_lookup",
            "send_email",
            "switch_on",
        ]
        assert [tool.name for tool in response.tools[:1]] == [
            "safe_lookup",
        ]
        assert response.blocked_count == 0
        assert response.blocked_tools == []
        catalog_by_name = {tool.name: tool for tool in response.tools}
        assert catalog_by_name["switch_on"].safety_class == "dangerous"
        assert catalog_by_name["send_email"].confirmation_required is True

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
        """Remote cache failures are not live-fanned-out and do not hide local tools."""
        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        local_tool = _tool_info(name="local_lookup", local_name="local_lookup")
        tooling_service._on_get_tools = AsyncMock(
            return_value=ToolingGetToolsResponse(tools=[local_tool], count=1)
        )

        with patch.object(
            tooling_service, "_load_remote_catalog_snapshots", AsyncMock(side_effect=TimeoutError())
        ):
            response = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(provider_timeout_seconds=0.1)
            )

        assert [tool.name for tool in response.tools] == ["local_lookup"]
        assert [provider.provider_peer_id for provider in response.providers] == ["local"]
        mock_bus.request.assert_not_called()

    @pytest.mark.asyncio
    async def test_get_tool_catalog_uses_remote_cache_until_manifest_changes(
        self, tooling_service, mock_bus
    ):
        """Catalog reads use negotiated cache and never live-fanout to remote peers."""
        from app.shared.contracts.models.tooling import ToolingGetToolCatalogRequest

        remote_tool = _tool_info(
            name="raspi-lab_lookup",
            local_name="lookup",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            namespace="raspi-lab",
            source_type="mesh_peer",
            execution_location="remote",
        )
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=10,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash",
            tools=[remote_tool],
            shared_by_policy=True,
        )

        with (
            patch.object(
                tooling_service,
                "_load_remote_catalog_snapshots",
                AsyncMock(return_value=[snapshot]),
            ),
            patch.object(
                tooling_service,
                "_remote_tooling_candidates",
                Mock(return_value=[_provider_candidate("raspi-lab", eligible=True)]),
            ),
        ):
            await tooling_service._on_get_tool_catalog(ToolingGetToolCatalogRequest())
            cached_response = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest()
            )

        mock_bus.request.assert_not_called()
        assert cached_response.providers[1].cache_status == "blocked"

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
        _install_approved_peer_authority(tooling_service.bus)

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
    async def test_get_tools_search_query_binds_duckduckgo_from_rag(
        self, tooling_service, mock_bus
    ):
        """RAG-selected DuckDuckGo binds by name without web-intent fallback."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.db import DBMethods
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest
        from app.shared.messaging.models.db_models import RAGSearchQuery

        duckduckgo = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
            module="langchain_community.tools.ddg_search.tool",
        )
        mock_bus.request = AsyncMock(
            return_value=QueryResult(ok=True, data={"items": [{"key": "duckduckgo_results_json"}]})
        )
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=duckduckgo)
        tooling_service.tools_manager.get_tools = Mock(return_value=[])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="search", top_k=5)
        )

        mock_bus.request.assert_awaited_once()
        method, payload = mock_bus.request.await_args.args[:2]
        assert method == DBMethods.RAG_SEARCH
        assert isinstance(payload, RAGSearchQuery)
        assert payload.namespace == "main.tools"
        assert payload.query == "search"
        tooling_service.tools_manager.get_tool_by_name.assert_called_once_with(
            "duckduckgo_results_json"
        )
        tooling_service.tools_manager.get_tools.assert_not_called()
        assert [tool.local_name for tool in response.tools] == ["duckduckgo_results_json"]
        assert response.tools[0].source == "core"
        assert response.tools[0].trust_tier == "trusted"
        assert response.tools[0].capability_class == "network"
        assert response.tools[0].external is True

    @pytest.mark.asyncio
    async def test_get_tools_search_intent_zero_rag_uses_lexical_fallback(
        self, tooling_service, mock_bus
    ):
        """Search-tool intent can recover loaded DDG when RAG returns no hits."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        loaded_tools = _loaded_tools_with_duckduckgo_after_top_k(top_k=10)
        mock_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"items": []}))
        tooling_service.tools_manager.tools = loaded_tools
        tooling_service.tools_manager.get_tools = Mock(return_value=loaded_tools[:10])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="use the search tool", top_k=10)
        )

        assert [tool.local_name for tool in response.tools] == ["duckduckgo_results_json"]
        tooling_service.tools_manager.get_tools.assert_not_called()

    def test_loaded_tools_snapshot_bounds_concrete_manager_tools(self, tooling_service):
        """Concrete loaded-tool lists are scanned only up to the explicit cap."""

        loaded_tools = [_DummyTool(f"tool_{index}", "Loaded tool") for index in range(1200)]
        tooling_service.tools_manager.tools = loaded_tools
        tooling_service.tools_manager.get_tools = Mock(return_value=[])

        snapshot = tooling_service._loaded_tools_snapshot(top_k=2000)

        assert snapshot == loaded_tools[:1000]
        tooling_service.tools_manager.get_tools.assert_not_called()

    @pytest.mark.asyncio
    async def test_get_tools_search_intent_failed_rag_uses_lexical_fallback(
        self, tooling_service, mock_bus
    ):
        """Search-tool intent can recover loaded DDG when RAG reports ok=False."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        duckduckgo = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
            module="langchain_community.tools.ddg_search.tool",
        )
        mock_bus.request = AsyncMock(return_value=QueryResult(ok=False, error="RAG unavailable"))
        tooling_service.tools_manager.get_tools = Mock(return_value=[duckduckgo])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="use the search tool", top_k=5)
        )

        assert [tool.local_name for tool in response.tools] == ["duckduckgo_results_json"]
        tooling_service.tools_manager.get_tools.assert_called_once_with(None, 256)

    @pytest.mark.asyncio
    async def test_get_tools_latest_news_zero_rag_uses_web_intent_fallback(
        self, tooling_service, mock_bus
    ):
        """Stopword-only latest-news intent still discovers the loaded web tool."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        duckduckgo = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
            module="langchain_community.tools.ddg_search.tool",
        )
        mock_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"items": []}))
        tooling_service.tools_manager.get_tools = Mock(return_value=[duckduckgo])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="latest news", top_k=5)
        )

        assert [tool.local_name for tool in response.tools] == ["duckduckgo_results_json"]

    @pytest.mark.asyncio
    async def test_get_tools_current_events_failed_rag_uses_web_intent_fallback(
        self, tooling_service, mock_bus
    ):
        """Stopword-only current-events intent survives an unavailable RAG service."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        duckduckgo = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
            module="langchain_community.tools.ddg_search.tool",
        )
        mock_bus.request = AsyncMock(return_value=QueryResult(ok=False, error="RAG unavailable"))
        tooling_service.tools_manager.get_tools = Mock(return_value=[duckduckgo])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="current events", top_k=5)
        )

        assert [tool.local_name for tool in response.tools] == ["duckduckgo_results_json"]

    @pytest.mark.asyncio
    async def test_get_tools_internet_intent_stale_rag_uses_web_intent_fallback(
        self, tooling_service, mock_bus
    ):
        """A stale RAG name cannot suppress an explicit internet-search intent."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        duckduckgo = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
            module="langchain_community.tools.ddg_search.tool",
        )
        mock_bus.request = AsyncMock(
            return_value=QueryResult(ok=True, data={"items": [{"key": "stale_web_tool"}]})
        )
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=None)
        tooling_service.tools_manager.get_tools = Mock(return_value=[duckduckgo])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="search the internet", top_k=5)
        )

        assert [tool.local_name for tool in response.tools] == ["duckduckgo_results_json"]
        tooling_service.tools_manager.get_tool_by_name.assert_called_once_with("stale_web_tool")

    @pytest.mark.asyncio
    async def test_get_tools_current_unrelated_query_does_not_trigger_web_fallback(
        self, tooling_service, mock_bus
    ):
        """A temporal adjective alone must not broaden an unrelated query to web search."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        duckduckgo = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
            module="langchain_community.tools.ddg_search.tool",
        )
        mock_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"items": []}))
        tooling_service.tools_manager.get_tools = Mock(return_value=[duckduckgo])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="current account balance", top_k=5)
        )

        assert response.tools == []

    @pytest.mark.asyncio
    async def test_get_tools_blocked_web_tool_stays_hidden_during_lexical_fallback(
        self, tooling_service, mock_bus
    ):
        """Web-intent recovery must not weaken an explicit blocked trust tier."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        duckduckgo = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
            trust_tier="blocked",
            module="langchain_community.tools.ddg_search.tool",
        )
        mock_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"items": []}))
        tooling_service.tools_manager.get_tools = Mock(return_value=[duckduckgo])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="latest news", top_k=5)
        )

        assert response.tools == []

    @pytest.mark.asyncio
    async def test_get_tool_catalog_search_intent_zero_rag_uses_lexical_fallback(
        self, tooling_service, mock_bus
    ):
        """Catalog query mirrors local bounded lexical fallback for search-tool intent."""
        from app.messaging import QueryResult

        loaded_tools = _loaded_tools_with_duckduckgo_after_top_k(top_k=10)
        mock_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"items": []}))
        tooling_service.tools_manager.tools = loaded_tools
        tooling_service.tools_manager.get_tools = Mock(return_value=loaded_tools[:10])

        with patch.object(
            tooling_service, "_load_remote_catalog_snapshots", AsyncMock(return_value=[])
        ):
            catalog = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(
                    query="use the search tool",
                    top_k=10,
                    caller_permissions=["*"],
                )
            )

        assert "duckduckgo_results_json" in {tool.name for tool in catalog.tools}
        tooling_service.tools_manager.get_tools.assert_not_called()

    @pytest.mark.asyncio
    async def test_get_tool_catalog_query_scans_remote_snapshot_beyond_top_k(
        self, tooling_service, mock_bus
    ):
        """Remote catalog query scans beyond first top_k and returns lexical matches only."""
        from app.messaging import QueryResult

        mock_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"items": []}))
        remote_tools = [
            _tool_info(
                name=f"raspi-lab_calendar_helper_{index}",
                local_name=f"calendar_helper_{index}",
                provider_peer_id="raspi-lab",
                provider_service_instance_id="remote:raspi-lab:Tooling",
                namespace="raspi-lab",
                source_type="mesh_peer",
                execution_location="remote",
            ).model_copy(update={"description": "Calendar scheduling helper"})
            for index in range(10)
        ]
        remote_tools.append(
            _tool_info(
                name="raspi-lab_duckduckgo_results_json",
                local_name="duckduckgo_results_json",
                provider_peer_id="raspi-lab",
                provider_service_instance_id="remote:raspi-lab:Tooling",
                namespace="raspi-lab",
                source_type="mesh_peer",
                execution_location="remote",
            ).model_copy(
                update={
                    "description": (
                        "A wrapper around Duck Duck Go Search. Useful for current events."
                    )
                }
            )
        )
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash",
            tools=remote_tools,
            shared_by_policy=True,
        )

        with (
            patch.object(
                tooling_service,
                "_load_remote_catalog_snapshots",
                AsyncMock(return_value=[snapshot]),
            ),
            patch.object(
                tooling_service,
                "_remote_tooling_candidates",
                Mock(return_value=[_provider_candidate("raspi-lab", eligible=True)]),
            ),
        ):
            catalog = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(
                    query="use the search tool",
                    top_k=10,
                    caller_permissions=["*"],
                )
            )

        assert "raspi-lab_duckduckgo_results_json" not in {tool.name for tool in catalog.tools}
        assert not any(tool.name.startswith("raspi-lab_calendar_helper") for tool in catalog.tools)

    @pytest.mark.asyncio
    async def test_get_tool_catalog_query_does_not_append_unrelated_remote_tools(
        self, tooling_service, mock_bus
    ):
        """Remote catalog query with no lexical matches does not append all snapshot tools."""
        from app.messaging import QueryResult

        mock_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"items": []}))
        remote_tools = [
            _tool_info(
                name=f"raspi-lab_calendar_helper_{index}",
                local_name=f"calendar_helper_{index}",
                provider_peer_id="raspi-lab",
                provider_service_instance_id="remote:raspi-lab:Tooling",
                namespace="raspi-lab",
                source_type="mesh_peer",
                execution_location="remote",
            ).model_copy(update={"description": "Calendar scheduling helper"})
            for index in range(10)
        ]
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash",
            tools=remote_tools,
            shared_by_policy=True,
        )

        with (
            patch.object(
                tooling_service,
                "_load_remote_catalog_snapshots",
                AsyncMock(return_value=[snapshot]),
            ),
            patch.object(
                tooling_service,
                "_remote_tooling_candidates",
                Mock(return_value=[_provider_candidate("raspi-lab", eligible=True)]),
            ),
        ):
            catalog = await tooling_service._on_get_tool_catalog(
                ToolingGetToolCatalogRequest(
                    query="calculate tides",
                    top_k=10,
                    caller_permissions=["*"],
                )
            )

        assert catalog.tools == []
        assert catalog.blocked_tools == []
        assert [provider.provider_peer_id for provider in catalog.providers] == [
            "local",
            "raspi-lab",
        ]
        assert catalog.providers[1].reason_code == "legacy_unverifiable"

    @pytest.mark.asyncio
    async def test_get_tools_stale_rag_names_use_lexical_fallback(self, tooling_service, mock_bus):
        """Stale RAG hits that map to no loaded callable can recover by loaded lexical match."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        duckduckgo = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
            module="langchain_community.tools.ddg_search.tool",
        )
        mock_bus.request = AsyncMock(
            return_value=QueryResult(ok=True, data={"items": [{"key": "stale_search_name"}]})
        )
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=None)
        tooling_service.tools_manager.get_tools = Mock(return_value=[duckduckgo])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="use the search tool", top_k=5)
        )

        assert [tool.local_name for tool in response.tools] == ["duckduckgo_results_json"]
        tooling_service.tools_manager.get_tool_by_name.assert_called_once_with("stale_search_name")

    @pytest.mark.asyncio
    async def test_get_tools_arbitrary_no_match_remains_empty(self, tooling_service, mock_bus):
        """No-match RAG results stay empty instead of broadening discovery."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        duckduckgo = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
        )
        mock_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"items": []}))
        tooling_service.tools_manager.get_tools = Mock(return_value=[duckduckgo])

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="purple elephant workflow", top_k=5)
        )

        assert response.tools == []
        tooling_service.tools_manager.get_tools.assert_called_once_with(None, 256)

    @pytest.mark.asyncio
    async def test_get_tools_web_search_unknown_module_stays_untrusted(
        self, tooling_service, mock_bus
    ):
        """RAG-matched arbitrary search-looking tools are not elevated to core."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        arbitrary_search = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
        )
        mock_bus.request = AsyncMock(
            return_value=QueryResult(ok=True, data={"items": [{"key": "duckduckgo_results_json"}]})
        )
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=arbitrary_search)

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="latest news", top_k=5)
        )

        assert [tool.local_name for tool in response.tools] == ["duckduckgo_results_json"]
        assert response.tools[0].source == "unknown"
        assert response.tools[0].trust_tier == "untrusted"
        assert response.tools[0].capability_class == "network"

    @pytest.mark.asyncio
    async def test_get_tools_blocked_duckduckgo_hidden(self, tooling_service, mock_bus):
        """RAG-selected search tools still respect explicit blocked trust tier."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        duckduckgo = _DummyTool(
            "duckduckgo_results_json",
            "A wrapper around Duck Duck Go Search. Useful for current events.",
            trust_tier="blocked",
            module="langchain_community.tools.ddg_search.tool",
        )
        mock_bus.request = AsyncMock(
            return_value=QueryResult(ok=True, data={"items": [{"key": "duckduckgo_results_json"}]})
        )
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=duckduckgo)

        response = await tooling_service._on_get_tools(
            ToolingGetToolsRequest(query="latest news", top_k=5)
        )

        assert response.tools == []

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
        mock_tool.source = "core"
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
    async def test_execute_tool_enforces_tool_specific_required_permissions(self, tooling_service):
        """Runtime execution denies tools when caller lacks declared tool permissions."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_tool = Mock()
        mock_tool.source = "core"
        mock_tool.safety_class = "standard"
        mock_tool.confirmation_required = False
        mock_tool.required_permissions = ["Tooling.RestrictedUse"]
        mock_tool.ainvoke = AsyncMock(return_value="should-not-run")

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["restricted_lookup"])

        response = await tooling_service._on_execute_tool(
            ToolingExecuteToolRequest(
                tool_name="restricted_lookup",
                arguments={},
                caller_permissions=[ToolingMethods.EXECUTE_TOOL],
            )
        )

        assert response.ok is False
        assert response.status == "denied"
        assert response.error_code == "permission_denied"
        mock_tool.ainvoke.assert_not_called()

    @pytest.mark.asyncio
    async def test_prepare_execution_enforces_tool_specific_required_permissions(
        self, tooling_service
    ):
        """Prepare/approval paths fail closed for missing tool-specific permissions."""
        from app.shared.contracts.models.tooling import ToolingPrepareExecutionRequest

        mock_tool = Mock()
        mock_tool.source = "core"
        mock_tool.safety_class = "standard"
        mock_tool.confirmation_required = False
        mock_tool.required_permissions = ["Tooling.RestrictedUse"]

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["restricted_lookup"])

        response = await tooling_service._on_prepare_execution(
            ToolingPrepareExecutionRequest(
                tool_name="restricted_lookup",
                arguments={},
                caller_permissions=[ToolingMethods.EXECUTE_TOOL],
            )
        )

        assert response.ok is False
        assert response.policy_decision.reason == "permission_denied"

    @pytest.mark.asyncio
    async def test_remote_dangerous_tool_requires_resource_before_invocation(
        self, tooling_service, mock_bus
    ):
        """Remote dangerous tools are denied before invocation without a resource."""
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingSetSharingPolicyRequest,
            ToolingSharingPolicy,
        )

        _install_approved_peer_authority(mock_bus)
        mock_tool = Mock()
        mock_tool.source = "core"
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

        _install_approved_peer_authority(mock_bus)
        mock_tool = Mock()
        mock_tool.source = "core"
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
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingSetSharingPolicyRequest,
            ToolingSharingPolicy,
        )

        mock_bus.request = AsyncMock()
        mock_tool = Mock()
        mock_tool.source = "core"
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
    async def test_argument_visibility_keeps_safe_user_text_visible_and_secrets_hidden(
        self, tooling_service, mock_bus
    ):
        """Prepare/execute responses expose safe initiating-user previews without secrets."""
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingSetSharingPolicyRequest,
            ToolingSharingPolicy,
        )

        mock_bus.request = AsyncMock()
        mock_tool = Mock()
        mock_tool.source = "core"
        mock_tool.args_schema = {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "api_key": {"type": "string"},
                "raw_audio": {"type": "string", "x-aurora-visibility": "raw_never"},
            },
        }
        mock_tool.ainvoke = AsyncMock(return_value={"ok": True})

        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["search_tool"])

        request = ToolingExecuteToolRequest(
            tool_name="search_tool",
            arguments={
                "query": "latest news in Egypt",
                "api_key": "super-secret-key",
                "raw_audio": "base64-audio",
            },
            caller_peer_id="workstation",
            caller_principal_id="peer-principal",
            correlation_id="corr-visible",
        )

        prepared = await tooling_service._on_prepare_execution(request)
        response = await tooling_service._on_execute_tool(request)

        assert prepared.display_args_preview["query"] == "latest news in Egypt"
        assert prepared.display_args_preview["api_key"] == "<redacted>"
        assert prepared.display_args_preview["raw_audio"] == "<redacted>"
        assert prepared.argument_visibility["query"] == "display"
        assert prepared.argument_visibility["api_key"] == "secret"
        assert prepared.argument_visibility["raw_audio"] == "raw_never"
        assert response.ok is True
        assert response.display_args_preview == prepared.display_args_preview
        assert response.args_hash == prepared.args_hash
        assert "super-secret-key" not in json.dumps(response.model_dump(), default=str)
        assert "base64-audio" not in json.dumps(response.model_dump(), default=str)

    @pytest.mark.asyncio
    async def test_execute_tool_success_logs_redacted_context(self, tooling_service, mock_bus):
        """Success execution logs omit raw arguments and raw result values."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_tool = Mock()
        mock_tool.source = "core"
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

        _install_approved_peer_authority(mock_bus)
        mock_tool = Mock()
        mock_tool.source = "core"
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
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingSetSharingPolicyRequest,
            ToolingSharingPolicy,
        )

        mock_tool = Mock()
        mock_tool.source = "core"
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
        assert response.error == "Tool execution failed: ValueError: failure echoed <redacted>"
        assert "failure-secret-argument" not in response.error
        assert response.data["error_details"]["error_type"] == "ValueError"
        assert response.data["error_details"]["message"] == "failure echoed <redacted>"
        assert response.data["error_details"]["trace"]
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
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingSetSharingPolicyRequest,
            ToolingSharingPolicy,
        )

        mock_tool = Mock()
        mock_tool.source = "core"
        mock_tool.ainvoke = AsyncMock(return_value="ok")

        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        _install_approved_peer_authority(mock_bus)
        await tooling_service._on_set_sharing_policy(
            ToolingSetSharingPolicyRequest(
                policy=ToolingSharingPolicy(policy_mode="unrestricted_except_blocked"),
                actor_principal_id="test-admin",
                confirmation_text="ALLOW NON-BLOCKED TOOLS",
            )
        )

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
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingSetSharingPolicyRequest,
            ToolingSharingPolicy,
        )

        mock_tool = Mock()
        mock_tool.source = "core"
        mock_tool.ainvoke = AsyncMock(return_value="ok")

        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        _install_approved_peer_authority(mock_bus)
        await tooling_service._on_set_sharing_policy(
            ToolingSetSharingPolicyRequest(
                policy=ToolingSharingPolicy(policy_mode="unrestricted_except_blocked"),
                actor_principal_id="test-admin",
                confirmation_text="ALLOW NON-BLOCKED TOOLS",
            )
        )

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
        mock_tool.source = "core"
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


class TestToolingSharingPolicyAndApproval:
    """Test Tooling sharing policy and approval-token execution."""

    def _mock_tool(
        self,
        *,
        safety_class: str = "standard",
        confirmation_required: bool = False,
        result: str = "ok",
        required_permissions: list[str] | None = None,
    ) -> Mock:
        mock_tool = Mock()
        mock_tool.source = "core"
        mock_tool.safety_class = safety_class
        mock_tool.confirmation_required = confirmation_required
        mock_tool.required_permissions = required_permissions or []
        mock_tool.ainvoke = AsyncMock(return_value=result)
        return mock_tool

    @pytest.mark.asyncio
    async def test_set_sharing_policy_persists_through_config_service(self, tooling_service):
        """Policy changes must survive restart through ConfigService-backed persistence."""
        from app.shared.contracts.models.tooling import (
            ToolingSetSharingPolicyRequest,
            ToolingSharingPolicy,
        )

        tooling_service._config.aupdate_config = AsyncMock(return_value=True)
        policy = ToolingSharingPolicy(default_share=True, default_approval_mode="ask_each_time")

        response = await tooling_service._on_set_sharing_policy(
            ToolingSetSharingPolicyRequest(policy=policy, actor_principal_id="admin")
        )

        assert response.ok is True
        tooling_service._config.aupdate_config.assert_awaited_once_with(
            "services.tooling.approval_policy",
            policy.model_dump(mode="json"),
            timeout=20.0,
        )

    @pytest.mark.asyncio
    async def test_set_sharing_policy_failure_preserves_live_policy(self, tooling_service):
        """A failed durable policy write must not switch runtime enforcement."""
        from app.shared.contracts.models.tooling import (
            ToolingSetSharingPolicyRequest,
            ToolingSharingPolicy,
        )

        previous = tooling_service._sharing_policy
        tooling_service._config.aupdate_config = AsyncMock(return_value=False)
        new_policy = ToolingSharingPolicy(default_share=False, default_approval_mode="deny_all")

        response = await tooling_service._on_set_sharing_policy(
            ToolingSetSharingPolicyRequest(policy=new_policy, actor_principal_id="admin")
        )

        assert response.ok is False
        assert response.policy == previous
        assert tooling_service._sharing_policy == previous

    async def _set_single_rule_policy(
        self,
        tooling_service,
        *,
        approval_mode: str,
        tool_name: str = "safe_tool",
        share: bool = True,
        safety_class: str | None = None,
        execution_location: str | None = None,
        token_ttl_seconds: int = 300,
    ):
        from app.shared.contracts.models.tooling import (
            ToolingSetSharingPolicyRequest,
            ToolingSharingPolicy,
            ToolingSharingPolicyRule,
        )

        await tooling_service._on_set_sharing_policy(
            ToolingSetSharingPolicyRequest(
                actor_principal_id="admin",
                policy=ToolingSharingPolicy(
                    rules=[
                        ToolingSharingPolicyRule(
                            rule_id="rule-1",
                            tool_name=tool_name,
                            share=share,
                            approval_mode=approval_mode,
                            safety_class=safety_class,
                            execution_location=execution_location,
                            token_ttl_seconds=token_ttl_seconds,
                        )
                    ]
                ),
            )
        )

    async def _approved_token(self, tooling_service, request):
        from app.shared.contracts.models.tooling import ToolingConfirmExecutionRequest

        approval = await tooling_service._on_request_approval(request)
        assert approval.ok is True
        assert approval.approval_request_id
        confirmed = await tooling_service._on_confirm_execution(
            ToolingConfirmExecutionRequest(
                approval_request_id=approval.approval_request_id,
                approver_principal_id="admin",
            )
        )
        assert confirmed.ok is True
        assert confirmed.approval_token
        return confirmed.approval_token

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "approval_mode",
        ["ask_each_time", "allow_once", "allow_until_expiry"],
    )
    async def test_token_approval_modes_issue_bound_token(
        self, tooling_service, mock_bus, approval_mode
    ):
        """Approval-required modes issue a token that authorizes one matching execution."""
        from app.shared.contracts.models.tooling import ToolingRequestApprovalRequest

        mock_bus.request = AsyncMock()
        mock_tool = self._mock_tool()
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["safe_tool"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        await self._set_single_rule_policy(
            tooling_service, approval_mode=approval_mode, tool_name="safe_tool"
        )

        request = ToolingRequestApprovalRequest(
            tool_name="safe_tool",
            arguments={"value": "one"},
            caller_principal_id="principal-1",
        )
        token = await self._approved_token(tooling_service, request)
        execute_request = request.model_copy(update={"approval_token": token})

        response = await tooling_service._on_execute_tool(execute_request)

        assert response.ok is True
        assert response.status == "success"
        mock_tool.ainvoke.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_raw_confirmed_does_not_bypass_approval_token(self, tooling_service, mock_bus):
        """Raw confirmed=true is denied for approval-required remote tools."""
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingResourceSelector,
        )

        _install_approved_peer_authority(mock_bus)
        mock_tool = self._mock_tool(safety_class="dangerous", confirmation_required=True)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        request = ToolingExecuteToolRequest(
            tool_name="switch_on",
            arguments={"target": "lamp"},
            mesh_selector=MeshAddressSelector(peer_id="raspi-lab"),
            resource_selector=ToolingResourceSelector(hardware_target="lamp"),
            confirmed=True,
            caller_peer_id="workstation",
            caller_principal_id="peer-principal",
        )

        response = await tooling_service._on_execute_tool(request)

        assert response.ok is False
        assert response.status == "denied"
        assert response.error_code == "approval_token_required"
        mock_tool.ainvoke.assert_not_called()

    @pytest.mark.asyncio
    async def test_prepare_execution_rejects_missing_and_wrong_typed_arguments(
        self, tooling_service, mock_bus
    ):
        """PrepareExecution validates schema before a scheduler can persist a job."""
        from app.shared.contracts.models.tooling import ToolingPrepareExecutionRequest

        mock_bus.request = AsyncMock()
        mock_tool = self._mock_tool()
        mock_tool.args_schema = {
            "type": "object",
            "properties": {
                "target": {"type": "string"},
                "level": {"type": "integer"},
            },
            "required": ["target", "level"],
            "additionalProperties": False,
        }
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        missing = await tooling_service._on_prepare_execution(
            ToolingPrepareExecutionRequest(tool_name="switch_on", arguments={"target": "lamp"})
        )
        wrong_type = await tooling_service._on_prepare_execution(
            ToolingPrepareExecutionRequest(
                tool_name="switch_on", arguments={"target": "lamp", "level": "high"}
            )
        )
        unknown = await tooling_service._on_prepare_execution(
            ToolingPrepareExecutionRequest(
                tool_name="switch_on",
                arguments={"target": "lamp", "level": 1, "extra": "bad"},
            )
        )

        assert missing.ok is False
        assert "level" in missing.policy_decision.reason
        assert "required property" in missing.policy_decision.reason
        assert wrong_type.ok is False
        assert "level" in wrong_type.policy_decision.reason
        assert "integer" in wrong_type.policy_decision.reason
        assert unknown.ok is False
        assert "Additional properties" in unknown.policy_decision.reason

    @pytest.mark.asyncio
    async def test_prepare_execution_rejects_deep_json_schema_violations(
        self, tooling_service, mock_bus
    ):
        """PrepareExecution validates nested objects, array items, and enum constraints."""
        from app.shared.contracts.models.tooling import ToolingPrepareExecutionRequest

        mock_bus.request = AsyncMock()
        mock_tool = self._mock_tool()
        mock_tool.args_schema = {
            "type": "object",
            "properties": {
                "payload": {
                    "type": "object",
                    "properties": {
                        "mode": {"type": "string", "enum": ["append", "replace"]},
                        "items": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {"name": {"type": "string"}},
                                "required": ["name"],
                                "additionalProperties": False,
                            },
                        },
                    },
                    "required": ["mode", "items"],
                    "additionalProperties": False,
                }
            },
            "required": ["payload"],
            "additionalProperties": False,
        }
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        bad_enum = await tooling_service._on_prepare_execution(
            ToolingPrepareExecutionRequest(
                tool_name="switch_on",
                arguments={"payload": {"mode": "delete", "items": [{"name": "a"}]}},
            )
        )
        bad_nested = await tooling_service._on_prepare_execution(
            ToolingPrepareExecutionRequest(
                tool_name="switch_on",
                arguments={"payload": {"mode": "append", "items": [{"extra": "nope"}]}},
            )
        )

        assert bad_enum.ok is False
        assert "payload.mode" in bad_enum.policy_decision.reason
        assert "delete" in bad_enum.policy_decision.reason
        assert bad_nested.ok is False
        assert "payload.items.0" in bad_nested.policy_decision.reason
        assert "name" in bad_nested.policy_decision.reason

    @pytest.mark.asyncio
    async def test_prepare_and_execute_reject_schema_hash_mismatch(self, tooling_service, mock_bus):
        """Scheduler bindings fail closed when catalog schema hash drifts."""
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingPrepareExecutionRequest,
        )

        mock_bus.request = AsyncMock()
        mock_tool = self._mock_tool()
        mock_tool.args_schema = {
            "type": "object",
            "properties": {"target": {"type": "string"}},
            "required": ["target"],
        }
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        prepare = await tooling_service._on_prepare_execution(
            ToolingPrepareExecutionRequest(
                tool_name="switch_on",
                arguments={"target": "lamp"},
                expected_args_schema_hash="stale-schema-hash",
            )
        )
        execute = await tooling_service._on_execute_tool(
            ToolingExecuteToolRequest(
                tool_name="switch_on",
                arguments={"target": "lamp"},
                expected_args_schema_hash="stale-schema-hash",
            )
        )

        assert prepare.ok is False
        assert prepare.policy_decision.reason == "schema_hash_mismatch"
        assert execute.ok is False
        assert execute.error == "schema_hash_mismatch"
        mock_tool.ainvoke.assert_not_called()

    @pytest.mark.asyncio
    async def test_execute_tool_revalidates_arguments_before_invocation(
        self, tooling_service, mock_bus
    ):
        """ExecuteTool rechecks args so stale prepared payloads cannot invoke tools."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_bus.request = AsyncMock()
        mock_tool = self._mock_tool()
        mock_tool.args_schema = {
            "type": "object",
            "properties": {"target": {"type": "string"}},
            "required": ["target"],
            "additionalProperties": False,
        }
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        response = await tooling_service._on_execute_tool(
            ToolingExecuteToolRequest(tool_name="switch_on", arguments={"target": 42})
        )

        assert response.ok is False
        assert response.status == "failed"
        assert response.error_code == "invalid_arguments"
        mock_tool.ainvoke.assert_not_called()

    @pytest.mark.asyncio
    async def test_remote_dangerous_tool_executes_with_approval_token(
        self, tooling_service, mock_bus
    ):
        """Remote dangerous tools execute only with a valid bound approval token."""
        from app.shared.contracts.models.tooling import (
            ToolingRequestApprovalRequest,
            ToolingResourceSelector,
        )

        _install_approved_peer_authority(mock_bus)
        mock_tool = self._mock_tool(safety_class="dangerous", confirmation_required=True)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        request = ToolingRequestApprovalRequest(
            tool_name="switch_on",
            arguments={"target": "lamp"},
            mesh_selector=MeshAddressSelector(peer_id="raspi-lab"),
            resource_selector=ToolingResourceSelector(hardware_target="lamp"),
            caller_peer_id="workstation",
            caller_principal_id="peer-principal",
        )
        token = await self._approved_token(tooling_service, request)

        response = await tooling_service._on_execute_tool(
            request.model_copy(update={"approval_token": token})
        )

        assert response.ok is True
        assert response.status == "success"

    @pytest.mark.asyncio
    async def test_token_replay_is_denied(self, tooling_service, mock_bus):
        """Approval tokens are single use."""
        from app.shared.contracts.models.tooling import ToolingRequestApprovalRequest

        mock_bus.request = AsyncMock()
        mock_tool = self._mock_tool(confirmation_required=True)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["safe_tool"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        request = ToolingRequestApprovalRequest(
            tool_name="safe_tool",
            arguments={"value": "one"},
            caller_principal_id="principal-1",
        )
        token = await self._approved_token(tooling_service, request)
        execute_request = request.model_copy(update={"approval_token": token})

        first = await tooling_service._on_execute_tool(execute_request)
        second = await tooling_service._on_execute_tool(execute_request)

        assert first.ok is True
        assert second.ok is False
        assert second.error_code == "approval_token_replayed"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("field", "update", "expected_error"),
        [
            ("arguments", {"arguments": {"value": "two"}}, "approval_token_args_hash_mismatch"),
            (
                "caller_peer_id",
                {"caller_peer_id": "other-peer"},
                "approval_token_caller_peer_id_mismatch",
            ),
            ("tool_name", {"tool_name": "other_tool"}, "approval_token_tool_name_mismatch"),
        ],
    )
    async def test_token_binding_mismatches_are_denied(
        self, tooling_service, mock_bus, field, update, expected_error
    ):
        """Changed args, peer, or tool invalidate the approval token."""
        from app.shared.contracts.models.tooling import ToolingRequestApprovalRequest

        mock_bus.request = AsyncMock()
        mock_tool = self._mock_tool(confirmation_required=True)
        tooling_service.tools_manager.get_all_tool_names = Mock(
            return_value=["safe_tool", "other_tool"]
        )
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        request = ToolingRequestApprovalRequest(
            tool_name="safe_tool",
            arguments={"value": "one"},
            caller_peer_id="peer-1",
            caller_principal_id="principal-1",
        )
        token = await self._approved_token(tooling_service, request)

        response = await tooling_service._on_execute_tool(
            request.model_copy(update={"approval_token": token, **update})
        )

        assert field
        assert response.ok is False
        assert response.error_code == expected_error

    @pytest.mark.asyncio
    async def test_token_resource_mismatch_and_expiry_are_denied(self, tooling_service, mock_bus):
        """Resource selector changes and expired tokens fail closed."""
        from app.shared.contracts.models.tooling import (
            ToolingRequestApprovalRequest,
            ToolingResourceSelector,
        )

        mock_bus.request = AsyncMock()
        mock_tool = self._mock_tool(safety_class="dangerous", confirmation_required=True)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["switch_on"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        request = ToolingRequestApprovalRequest(
            tool_name="switch_on",
            arguments={"target": "lamp"},
            resource_selector=ToolingResourceSelector(hardware_target="lamp"),
            caller_principal_id="principal-1",
        )
        mismatch_token = await self._approved_token(tooling_service, request)
        mismatch_response = await tooling_service._on_execute_tool(
            request.model_copy(
                update={
                    "approval_token": mismatch_token,
                    "resource_selector": ToolingResourceSelector(hardware_target="fan"),
                }
            )
        )

        expiry_token = await self._approved_token(tooling_service, request)
        tooling_service._approval_tokens[expiry_token]["expires_at"] = 0
        expired_response = await tooling_service._on_execute_tool(
            request.model_copy(update={"approval_token": expiry_token})
        )

        assert mismatch_response.ok is False
        assert mismatch_response.error_code == "approval_token_resource_selector_hash_mismatch"
        assert expired_response.ok is False
        assert expired_response.error_code == "approval_token_expired"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("approval_mode", "request_kwargs", "expected_ok", "expected_status"),
        [
            ("deny_all", {}, False, "denied"),
            ("dry_run_only", {}, False, "denied"),
            ("dry_run_only", {"dry_run": True}, True, "dry_run"),
            ("approve_all_for_session", {}, True, "success"),
            ("approve_all_for_peer", {"caller_peer_id": "peer-1"}, True, "success"),
            ("approve_all_for_peer", {}, False, "denied"),
            ("approve_all_local_safe", {}, True, "success"),
        ],
    )
    async def test_approve_all_and_deny_modes(
        self,
        tooling_service,
        mock_bus,
        approval_mode,
        request_kwargs,
        expected_ok,
        expected_status,
    ):
        """Non-token approval modes are enforced and auditable."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_bus.request = AsyncMock()
        mock_tool = self._mock_tool()
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["safe_tool"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)
        await self._set_single_rule_policy(
            tooling_service, approval_mode=approval_mode, tool_name="safe_tool"
        )

        response = await tooling_service._on_execute_tool(
            ToolingExecuteToolRequest(
                tool_name="safe_tool",
                arguments={"value": "one"},
                caller_principal_id="principal-1",
                **request_kwargs,
            )
        )

        assert response.ok is expected_ok
        assert response.status == expected_status

    @pytest.mark.asyncio
    async def test_sharing_policy_does_not_hide_tools_from_discovery(
        self, tooling_service, mock_bus
    ):
        """Per-tool share=False stays model-visible; execution policy gates use."""
        from langchain_core.tools import tool

        from app.shared.contracts.models.tooling import ToolingGetToolsRequest

        @tool
        def visible_tool(value: str):
            """Visible test tool."""
            return value

        @tool
        def hidden_tool(value: str):
            """Hidden test tool."""
            return value

        tooling_service.tools_manager.get_tools = Mock(return_value=[visible_tool, hidden_tool])
        await self._set_single_rule_policy(
            tooling_service,
            approval_mode="deny_all",
            tool_name="hidden_tool",
            share=False,
        )

        response = await tooling_service._on_get_tools(ToolingGetToolsRequest())

        assert [tool_info.local_name for tool_info in response.tools] == [
            "visible_tool",
            "hidden_tool",
        ]

    @pytest.mark.asyncio
    async def test_policy_and_approval_events_are_audited(self, tooling_service, mock_bus):
        """Policy changes and approval flow emit Auth audit events."""
        from app.shared.contracts.models.tooling import ToolingRequestApprovalRequest

        mock_bus.request = AsyncMock()
        mock_tool = self._mock_tool(confirmation_required=True)
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["safe_tool"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        await self._set_single_rule_policy(
            tooling_service, approval_mode="ask_each_time", tool_name="safe_tool"
        )
        request = ToolingRequestApprovalRequest(
            tool_name="safe_tool",
            arguments={"value": "one"},
            caller_principal_id="principal-1",
        )
        token = await self._approved_token(tooling_service, request)
        await tooling_service._on_execute_tool(request.model_copy(update={"approval_token": token}))

        event_names = [
            call.args[1].event
            for call in mock_bus.request.await_args_list
            if len(call.args) > 1 and hasattr(call.args[1], "event")
        ]
        assert "tooling.policy.set" in event_names
        assert "tooling.approval.requested" in event_names
        assert "tooling.approval.approved" in event_names
        assert "tooling.execute" in event_names

    @pytest.mark.asyncio
    async def test_config_loaded_policy_enforces_peer_scoped_rule(self, tooling_service, mock_bus):
        """Schema-backed approval_policy loads into runtime sharing enforcement."""
        from app.shared.contracts.models.tooling import ToolingExecuteToolRequest

        mock_bus.request = AsyncMock()
        tooling_service._config.aget = AsyncMock(
            return_value={
                "default_share": True,
                "default_approval_mode": "approve_all_local_safe",
                "default_token_ttl_seconds": 300,
                "rules": [
                    {
                        "rule_id": "deny-untrusted-peer",
                        "caller_peer_id": "untrusted-peer",
                        "approval_mode": "deny_all",
                        "token_ttl_seconds": 120,
                    }
                ],
            }
        )
        mock_tool = self._mock_tool()
        tooling_service.tools_manager.get_all_tool_names = Mock(return_value=["safe_tool"])
        tooling_service.tools_manager.get_tool_by_name = Mock(return_value=mock_tool)

        await tooling_service._load_sharing_policy_from_config()
        response = await tooling_service._on_execute_tool(
            ToolingExecuteToolRequest(
                tool_name="safe_tool",
                arguments={},
                caller_peer_id="untrusted-peer",
            )
        )

        assert response.ok is False
        assert response.status == "denied"
        assert response.error_code == "policy_denied"
        mock_tool.ainvoke.assert_not_called()


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

        # Without Auth's stable peer identity the reload event remains local,
        # while mesh catalog publication fails closed instead of minting a
        # durable Tooling identity under the old ``local`` sentinel.
        assert mock_bus.publish.call_count == 1
        assert mock_bus.publish.call_args_list[0].args[0] == ToolingMethods.TOOLS_RELOADED


@pytest.mark.asyncio
async def test_remote_catalog_snapshot_normalizes_remote_tools_as_untrusted_mesh(tooling_service):
    """Receiver-owned catalog cache never trusts a peer's local sentinel metadata."""

    from app.messaging import QueryResult
    from app.shared.contracts.models.db import DBMethods

    announced_tool = _tool_info(
        name="lookup",
        local_name="lookup",
        provider_peer_id="local",
        provider_service_instance_id="local:Tooling",
        namespace="local",
        source_type="local",
        execution_location="local",
    ).model_copy(update={"trust_tier": "trusted", "source": "core", "source_id": "local:core"})
    snapshot = ToolingRemoteCatalogAnnounced(
        peer_id="raspi-lab",
        service_instance_id="remote:raspi-lab:Tooling",
        provider_id="raspi-lab",
        catalog_epoch=42,
        generated_at="2026-07-05T00:00:00Z",
        full_schema_hash="",
        tools=[announced_tool],
        shared_by_policy=True,
    )

    durable_row: dict[str, object] = {}

    async def identity_bus(topic, _payload, **_kwargs):
        if topic == AuthMethods.MESH_LIST_PEERS:
            return QueryResult(ok=False, error="peer labels unavailable")
        if topic == DBMethods.ALLOCATE_TOOL_IDENTITY:
            return QueryResult(
                ok=True,
                data={
                    "success": True,
                    "allocated_tool_contract_id": "legacy.persisted-lookup",
                },
            )
        return QueryResult(ok=False, error=f"unexpected topic {topic}")

    tooling_service.bus.request = AsyncMock(side_effect=identity_bus)

    async def durable_catalog_db(sql: str, params=None):
        if "INSERT INTO tooling_remote_catalog_snapshots" in sql:
            durable_row.update(
                {
                    "provider_id": params[2],
                    "catalog_epoch": params[3],
                    "generated_at": params[4],
                    "full_schema_hash": params[5],
                    "tools_json": params[6],
                    "shared_by_policy": params[7],
                    "stale": 0,
                    "removed_at": None,
                    "updated_at": params[8],
                }
            )
        if "SELECT provider_id, catalog_epoch" in sql:
            return [durable_row.copy()]
        return []

    tooling_service._tooling_policy_tables_ready = True
    with patch.object(tooling_service, "_db_sql", AsyncMock(side_effect=durable_catalog_db)):
        await tooling_service._on_remote_catalog_announced(snapshot)
    normalized_snapshot = tooling_service._remote_catalog_snapshots[
        ("raspi-lab", "remote:raspi-lab:Tooling")
    ][0]

    with (
        patch.object(
            tooling_service,
            "_load_remote_catalog_snapshots",
            AsyncMock(return_value=[normalized_snapshot]),
        ),
        patch.object(
            tooling_service,
            "_remote_tooling_candidates",
            Mock(return_value=[_provider_candidate("raspi-lab", eligible=True)]),
        ),
    ):
        catalog = await tooling_service._on_get_tool_catalog(ToolingGetToolCatalogRequest())

    assert catalog.count == 0
    assert catalog.blocked_count == 1
    assert catalog.blocked_tools[0].reason_code == "legacy_unverifiable"
    remote = catalog.blocked_tools[0].tool
    assert catalog.blocked_tools[0].tool.name == remote.name
    assert remote.name == "raspi-lab_lookup"
    assert remote.provider_peer_id == "raspi-lab"
    assert remote.provider_service_instance_id == "remote:raspi-lab:Tooling"
    assert remote.source_type == "mesh_peer"
    assert remote.source == "mesh_peer"
    assert remote.source_id == "mesh:raspi-lab:remote_raspi-lab_Tooling"
    assert remote.trust_tier == "untrusted"
    assert remote.execution_location == "remote"
    assert remote.global_tool_id == ("aurora-tool:v1:raspi-lab:Tooling:legacy.persisted-lookup")
    assert remote.tool_id_scheme == "aurora-tool"
    assert remote.tool_id_version == 1
    assert "raspi-lab:remote_raspi-lab_Tooling:tool:lookup" in (remote.legacy_global_tool_ids)


def test_remote_catalog_preserves_peer_bound_canonical_id_and_forces_nonexportable(
    tooling_service,
):
    """Authenticated peer identity is authoritative and remote tools never re-export."""

    canonical_id = canonical_tool_global_id("raspi-lab", "mcp.lights.switch-v1")
    announced = _tool_info(name="switch", local_name="switch").model_copy(
        update={
            "global_tool_id": canonical_id,
            "tool_id_scheme": "aurora-tool",
            "tool_id_version": 1,
            "tool_contract_id": "mcp.lights.switch-v1",
            "share_group_id": "mcp:lights",
            "share_group_label": "Lights",
            "exportable": True,
        }
    )
    snapshot = ToolingRemoteCatalogAnnounced(
        peer_id="raspi-lab",
        service_instance_id="remote:raspi-lab:Tooling:boot-2",
        provider_id="raspi-lab",
        catalog_epoch=1,
        generated_at="2026-07-13T00:00:00Z",
        full_schema_hash="ignored",
        tools=[announced],
    )

    normalized = tooling_service._normalize_remote_catalog_snapshot(snapshot).tools[0]

    assert normalized.global_tool_id == canonical_id
    assert normalized.provider_service_instance_id.endswith("boot-2")
    assert normalized.share_group_id == "mcp:lights"
    assert normalized.exportable is False


def test_remote_catalog_rejects_canonical_id_for_another_authenticated_peer(
    tooling_service,
):
    announced = _tool_info(name="switch", local_name="switch").model_copy(
        update={
            "global_tool_id": canonical_tool_global_id("different-peer", "mcp.lights.switch-v1"),
            "tool_id_scheme": "aurora-tool",
            "tool_id_version": 1,
            "tool_contract_id": "mcp.lights.switch-v1",
        }
    )
    snapshot = ToolingRemoteCatalogAnnounced(
        peer_id="raspi-lab",
        service_instance_id="remote:raspi-lab:Tooling",
        provider_id="raspi-lab",
        catalog_epoch=1,
        generated_at="2026-07-13T00:00:00Z",
        full_schema_hash="ignored",
        tools=[announced],
    )

    with pytest.raises(ValueError, match="authenticated peer"):
        tooling_service._normalize_remote_catalog_snapshot(snapshot)
