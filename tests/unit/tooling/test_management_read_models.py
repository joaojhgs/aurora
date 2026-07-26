"""Tooling management read-model contract tests."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import Envelope, QueryResult
from app.services.db.manager import DatabaseManager
from app.services.orchestrator.tool_bindings import build_tool_bindings
from app.services.tooling.service import ToolingService
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.db import DBMethods
from app.shared.contracts.models.mesh import MeshPeerListResponse
from app.shared.contracts.models.tooling import (
    ToolingAcceptRemoteToolSchemaRequest,
    ToolingClearSourcePolicyRequest,
    ToolingClearToolPolicyOverrideRequest,
    ToolingCreateApprovalGrantRequest,
    ToolingCreateMCPSourceRequest,
    ToolingCreatePluginSourceRequest,
    ToolingGetOnboardingStatusRequest,
    ToolingGetPolicySummaryRequest,
    ToolingGetToolCatalogRequest,
    ToolingGetToolCatalogResponse,
    ToolingGetToolSourceDetailRequest,
    ToolingListPendingApprovalsRequest,
    ToolingListPolicyAuditEventsRequest,
    ToolingListToolSourcesRequest,
    ToolingMethods,
    ToolingRemoteCatalogAnnounced,
    ToolingRemoteCatalogDeltaAnnounced,
    ToolingRequestApprovalRequest,
    ToolingSetPolicyModeRequest,
    ToolingTestMCPSourceRequest,
    ToolingTestPluginSourceRequest,
    ToolingToolInfo,
    ToolingToolProvenance,
    ToolingUpsertSourcePolicyRequest,
    ToolingUpsertToolPolicyOverrideRequest,
)


class _SqliteAuditBus:
    """DB/config/audit bus double for Tooling management read models."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.subscribe = Mock()
        self.publish = AsyncMock()
        self.audit_events: list[object] = []
        self.mesh_peers: list[dict[str, object]] = []
        self.report_sql_errors = False
        self.request = AsyncMock(side_effect=self._request)
        self.db_manager = DatabaseManager(str(db_path))
        self._db_ready = False

    async def _request(self, topic: str, payload, **kwargs) -> QueryResult:
        if topic in {
            DBMethods.ALLOCATE_TOOL_IDENTITY,
            DBMethods.RECONCILE_TOOL_IDENTITY,
            DBMethods.RESOLVE_TOOL_IDENTITY_ALIASES,
        }:
            if not self._db_ready:
                await self.db_manager.initialize()
                self._db_ready = True
            if topic == DBMethods.ALLOCATE_TOOL_IDENTITY:
                response = await self.db_manager.allocate_tool_identity(payload)
            elif topic == DBMethods.RECONCILE_TOOL_IDENTITY:
                response = await self.db_manager.reconcile_tool_identity(payload)
            else:
                response = await self.db_manager.resolve_tool_identity_aliases(
                    payload.global_tool_ids, stable_peer_id=payload.stable_peer_id
                )
            return QueryResult(ok=True, data=response)
        if topic == DBMethods.EXECUTE_SQL:
            try:
                with sqlite3.connect(self.db_path) as connection:
                    connection.row_factory = sqlite3.Row
                    cursor = connection.execute(payload.sql, payload.params or [])
                    rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
                    connection.commit()
                return QueryResult(ok=True, data={"rows": rows, "success": True})
            except sqlite3.DatabaseError as error:
                if not self.report_sql_errors:
                    raise
                return QueryResult(
                    ok=True,
                    data={"rows": [], "rowcount": 0, "success": False, "error": str(error)},
                )
        if topic == AuthMethods.STORE_AUDIT_EVENT:
            self.audit_events.append(payload)
            return QueryResult(ok=True, data={"stored": True})
        if topic == AuthMethods.AUDIT_LOG:
            events = [
                {
                    "event": event.event,
                    "principal_id": event.principal_id,
                    "details": event.details,
                    "created_at": "2026-07-06T00:00:00Z",
                }
                for event in self.audit_events
            ]
            return QueryResult(ok=True, data={"events": events, "total": len(events)})
        if topic == AuthMethods.MESH_LIST_PEERS:
            return QueryResult(
                ok=True,
                data=MeshPeerListResponse.model_validate(
                    {"peers": self.mesh_peers, "total": len(self.mesh_peers)}
                ),
            )
        if topic == ConfigMethods.SET:
            return QueryResult(ok=True, data={"success": True})
        return QueryResult(ok=False, error=f"unexpected topic {topic}")


def _tool(name: str, *, source: str = "core", secret_schema: bool = False) -> Mock:
    tool = Mock()
    tool.name = name
    tool.description = f"{name} test tool"
    properties = {"query": {"type": "string"}}
    if secret_schema:
        properties["api_key"] = {"type": "string"}
    tool.args_schema = {"type": "object", "properties": properties}
    tool.safety_class = "standard"
    tool.source = source
    tool.operation_class = "read"
    tool.capability_class = "read"
    tool.confirmation_required = False
    tool.required_permissions = []
    tool.ainvoke = AsyncMock(return_value={"ok": True})
    if source == "mcp":
        tool._is_mcp_tool = True
        tool.mcp_server_name = "search"
    else:
        tool.__module__ = (
            "app.services.tooling.tools.test_tool"
            if source == "core"
            else f"community.{source}.tool"
        )
        if source == "plugin":
            tool.plugin_name = "lookup"
    return tool


def _normalized_remote_tool(peer_id: str, availability: str) -> dict[str, object]:
    tool = ToolingToolInfo(
        name="remote_schedule",
        local_name="schedule",
        global_tool_id=f"aurora-tool:v1:{peer_id}:Tooling:schedule",
        tool_id_scheme="aurora-tool",
        tool_id_version=1,
        tool_contract_id="schedule",
        provider_peer_id=peer_id,
        provider_service_instance_id="remote:Tooling",
        namespace="remote",
        display_name="schedule",
        description="Schedule work",
        source_type="mesh_peer",
        source="mesh_peer",
        execution_location="remote",
        provenance=ToolingToolProvenance(
            provider_peer_id=peer_id,
            provider_service_instance_id="remote:Tooling",
            provider_kind="mesh_peer",
            source="core",
            advertised_name="schedule",
        ),
    )
    revision = {
        "catalog_revision": 1,
        "export_policy_revision": 1,
        "auth_grant_revision": 1,
        "manifest_revision": 1,
        "switch_revision": 1,
        "protocol_revision": 1,
    }
    return {
        "peer_id": peer_id,
        "provider_id": peer_id,
        "tool": tool.model_dump(mode="python"),
        "schema_hash": "b" * 64,
        "accepted_schema_hash": "a" * 64 if availability == "schema_changed" else "b" * 64,
        "availability": availability,
        "reason_code": availability,
        "active_generation": None,
        "projection_revision": "projection-2",
        "authority_revision": revision,
        "review_required": availability == "schema_changed",
        "first_seen_at": 10.0,
        "last_seen_at": 20.0,
        "updated_at": 30.0,
    }


def _announced_remote_tool(
    name: str = "remote_status",
    *,
    required_permissions: list[str] | None = None,
) -> ToolingToolInfo:
    """Build a provider-local tool ready for remote catalog normalization."""

    return ToolingToolInfo(
        name=name,
        local_name=name,
        global_tool_id=f"local:local_Tooling:tool:{name}",
        provider_peer_id="local",
        provider_service_instance_id="local:Tooling",
        namespace="local",
        display_name=name,
        description=f"{name} remote test tool",
        source_type="local",
        source="core",
        source_id="local:core",
        trust_tier="trusted",
        execution_location="local",
        required_permissions=required_permissions or [ToolingMethods.EXECUTE_TOOL],
        provenance=ToolingToolProvenance(
            provider_peer_id="local",
            provider_service_instance_id="local:Tooling",
            provider_kind="local",
            source="core",
            advertised_name=name,
        ),
    )


def _provider_candidate(peer_id: str, granted_permissions: list[str]) -> SimpleNamespace:
    return SimpleNamespace(
        peer=SimpleNamespace(peer_id=peer_id, node_name=peer_id, last_manifest=1.0),
        service=SimpleNamespace(module="Tooling"),
        eligible=True,
        reason_code="eligible",
        reason="eligible provider",
        decision=SimpleNamespace(granted_permissions=tuple(granted_permissions)),
    )


@pytest.fixture
def management_service(tmp_path: Path):
    """Create a ToolingService with core, MCP, and plugin tools."""

    bus = _SqliteAuditBus(tmp_path / "tooling-management.db")
    tools = [
        _tool("core_status", source="core"),
        _tool("mcp_secret_search", source="mcp", secret_schema=True),
        _tool("plugin_lookup", source="plugin"),
    ]
    patchers = [
        patch("app.services.tooling.service.ToolsManager"),
        patch("app.services.tooling.service.set_tools_manager"),
        patch("app.shared.services.base_service.get_bus_singleton", return_value=bus),
    ]
    mock_tools_manager_cls = patchers[0].start()
    for patcher in patchers[1:]:
        patcher.start()

    manager = Mock()
    manager.initialize = AsyncMock()
    manager.get_stats = Mock(return_value={"total_tools": len(tools), "mcp_tools_loaded": True})
    manager.get_tools = Mock(return_value=tools)
    manager.get_tool_by_name = Mock(
        side_effect=lambda name: next((t for t in tools if t.name == name), None)
    )
    manager.get_all_tool_names = Mock(return_value=[tool.name for tool in tools])
    manager.get_mcp_status = Mock(
        return_value={
            "servers": [
                {
                    "name": "search",
                    "enabled": True,
                    "headers": {"Authorization": "Bearer super-secret-token"},
                }
            ],
            "total_servers": 1,
            "active_servers": 1,
        }
    )
    mock_tools_manager_cls.return_value = manager
    service = ToolingService()
    service.tools_manager = manager
    service._config.aupdate_config = AsyncMock(return_value=True)

    yield service, bus

    for patcher in reversed(patchers):
        patcher.stop()


def test_management_read_model_contracts_are_external_manage_methods():
    """Management read models are typed, Gateway-safe, and permission-gated."""

    for method in [
        ToolingService._on_get_policy_summary,
        ToolingService._on_list_tool_sources,
        ToolingService._on_get_tool_source_detail,
        ToolingService._on_accept_remote_tool_schema,
        ToolingService._on_list_pending_approvals,
        ToolingService._on_list_policy_audit_events,
        ToolingService._on_get_onboarding_status,
        ToolingService._on_set_policy_mode,
        ToolingService._on_upsert_source_policy,
        ToolingService._on_upsert_tool_policy_override,
        ToolingService._on_test_mcp_source,
        ToolingService._on_create_mcp_source,
        ToolingService._on_test_plugin_source,
        ToolingService._on_create_plugin_source,
    ]:
        metadata = getattr(method, "_contract_metadata", {})
        assert metadata.get("exposure") == "both"
        assert metadata.get("method_type") == "manage"
        assert metadata.get("required_perms") == ["Tooling.manage"]

    assert ToolingMethods.GET_POLICY_SUMMARY == "Tooling.GetPolicySummary"
    assert ToolingMethods.LIST_TOOL_SOURCES == "Tooling.ListToolSources"
    assert ToolingMethods.GET_TOOL_SOURCE_DETAIL == "Tooling.GetToolSourceDetail"
    assert ToolingMethods.ACCEPT_REMOTE_TOOL_SCHEMA == "Tooling.AcceptRemoteToolSchema"
    assert ToolingMethods.LIST_PENDING_APPROVALS == "Tooling.ListPendingApprovals"
    assert ToolingMethods.LIST_POLICY_AUDIT_EVENTS == "Tooling.ListPolicyAuditEvents"
    assert ToolingMethods.GET_ONBOARDING_STATUS == "Tooling.GetOnboardingStatus"
    assert ToolingMethods.SET_POLICY_MODE == "Tooling.SetPolicyMode"
    assert ToolingMethods.UPSERT_SOURCE_POLICY == "Tooling.UpsertSourcePolicy"
    assert ToolingMethods.UPSERT_TOOL_POLICY_OVERRIDE == "Tooling.UpsertToolPolicyOverride"
    assert ToolingMethods.TEST_MCP_SOURCE == "Tooling.TestMCPSource"
    assert ToolingMethods.CREATE_MCP_SOURCE == "Tooling.CreateMCPSource"
    assert ToolingMethods.TEST_PLUGIN_SOURCE == "Tooling.TestPluginSource"
    assert ToolingMethods.CREATE_PLUGIN_SOURCE == "Tooling.CreatePluginSource"


@pytest.mark.asyncio
async def test_policy_summary_sources_and_detail_include_counts_and_grants(management_service):
    """Policy/source read models summarize catalog groups without UI inference."""

    service, _bus = management_service
    grant = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="trust",
            local_tool_name="mcp_secret_search",
            provider_peer_id="local",
            trust_tier="trusted",
            created_by="admin",
            reason="operator reviewed MCP source",
        )
    )
    assert grant.ok is True

    sources = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    source_ids = {source.source_id for source in sources.sources}
    assert {"local:core", "local:mcp:search", "local:plugin:lookup"}.issubset(source_ids)
    mcp_source = next(
        source for source in sources.sources if source.source_id == "local:mcp:search"
    )
    assert mcp_source.tool_count == 1
    assert mcp_source.active_grant_count == 1

    detail = await service._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id="local:mcp:search")
    )
    assert detail.found is True
    assert [tool.name for tool in detail.tools] == ["mcp_secret_search"]
    assert [grant.local_tool_name for grant in detail.grants] == ["mcp_secret_search"]

    summary = await service._on_get_policy_summary(ToolingGetPolicySummaryRequest())
    assert summary.policy_mode == "enforce"
    assert summary.active_grant_count == 1
    assert summary.source_count >= 3
    assert summary.tool_count == 3


@pytest.mark.asyncio
async def test_remote_local_core_source_is_grouped_under_mesh_peer(management_service):
    """A peer's local source sentinel must not inflate this node's Core group."""

    service, bus = management_service
    peer_id = "aurora-da2c3842004492c887b3ce878c8eb0cb"
    peer_name = "Aurora 2"
    service_instance_id = f"remote:{peer_id}:Tooling"
    mesh_source_id = f"mesh:{peer_id}:remote_{peer_id}_Tooling"
    bus.mesh_peers = [
        {
            "id": "mesh-row-1",
            "peer_id": peer_id,
            "node_name": peer_name,
            "room_name": "stable-room",
        }
    ]
    announced_tool = ToolingToolInfo(
        name="remote_status",
        local_name="remote_status",
        global_tool_id="local:local_Tooling:tool:remote_status",
        provider_peer_id="local",
        provider_service_instance_id="local:Tooling",
        namespace="local",
        display_name="remote_status",
        description="Remote status tool",
        source_type="local",
        source="core",
        source_id="local:core",
        trust_tier="trusted",
        execution_location="local",
        provenance=ToolingToolProvenance(
            provider_peer_id="local",
            provider_service_instance_id="local:Tooling",
            provider_kind="local",
            source="core",
            advertised_name="remote_status",
        ),
    )

    await service._on_remote_catalog_announced(
        ToolingRemoteCatalogAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=7,
            generated_at="2026-07-10T00:00:00Z",
            full_schema_hash="remote-hash",
            tools=[announced_tool],
            shared_by_policy=True,
        )
    )

    normalized_tool = service._remote_catalog_snapshots[(peer_id, service_instance_id)][0].tools[0]
    assert normalized_tool.source_id == mesh_source_id
    assert normalized_tool.name == "Aurora_2_remote_status"
    assert normalized_tool.display_name == "Aurora 2.remote_status"
    assert normalized_tool.provider_label == peer_name
    assert normalized_tool.provider_peer_id == peer_id
    assert normalized_tool.global_tool_id.startswith(f"aurora-tool:v1:{peer_id}:Tooling:legacy.")
    assert f"{peer_id}:remote_{peer_id}_Tooling:tool:remote_status" in (
        normalized_tool.legacy_global_tool_ids
    )

    sources = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    core_source = next(source for source in sources.sources if source.source_id == "local:core")
    peer_source = next(source for source in sources.sources if source.source_id == mesh_source_id)
    assert core_source.tool_count == 1
    assert peer_source.tool_count == 1
    assert peer_source.blocked_tool_count == 1
    assert peer_source.status == "blocked"
    assert peer_source.reason_code == "legacy_unverifiable"
    assert peer_source.provider_peer_id == peer_id
    assert peer_source.provider_service_instance_id == service_instance_id
    assert peer_source.provider_kind == "mesh_peer"
    assert peer_source.source == "mesh_peer"
    assert peer_source.display_name == peer_name
    assert peer_source.provider_label == peer_name

    core_detail = await service._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id="local:core")
    )
    assert [tool.name for tool in core_detail.tools] == ["core_status"]

    peer_detail = await service._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id=mesh_source_id)
    )
    assert peer_detail.found is True
    assert peer_detail.source is not None
    assert peer_detail.source.source_id == mesh_source_id
    assert peer_detail.source.provider_peer_id == peer_id
    assert peer_detail.source.provider_service_instance_id == service_instance_id
    assert peer_detail.source.provider_kind == "mesh_peer"
    assert peer_detail.tools == []
    assert len(peer_detail.blocked_tools) == 1
    blocked_tool = peer_detail.blocked_tools[0]
    assert blocked_tool.reason_code == "legacy_unverifiable"
    assert blocked_tool.tool.local_name == "remote_status"
    assert blocked_tool.tool.source_id == mesh_source_id
    assert blocked_tool.tool.provider_peer_id == peer_id
    assert blocked_tool.tool.provider_service_instance_id == service_instance_id
    assert blocked_tool.tool.source_type == "mesh_peer"
    assert blocked_tool.tool.execution_location == "remote"


@pytest.mark.asyncio
@pytest.mark.parametrize("grant_scope", ["always", "deny_always"])
async def test_remote_permission_delta_preserves_catalog_and_approval_policy(
    management_service,
    grant_scope: str,
):
    """Permission changes retain durable allow and deny policy state."""

    service, _bus = management_service
    peer_id = "aurora-stable-permission-peer"
    service_instance_id = f"remote:{peer_id}:Tooling"
    permission = ToolingMethods.EXECUTE_TOOL
    await service._on_remote_catalog_announced(
        ToolingRemoteCatalogAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=1,
            generated_at="2026-07-10T00:00:00Z",
            full_schema_hash="stable-permission-hash",
            tools=[_announced_remote_tool(required_permissions=[permission])],
            shared_by_policy=True,
            granted_permissions=[permission],
        )
    )
    stable_tool_id = (
        service._remote_catalog_snapshots[(peer_id, service_instance_id)][0].tools[0].global_tool_id
    )
    policy_metadata = {
        "operator_policy": grant_scope,
        "policy_note": "must survive remote permission changes",
    }
    created = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope=grant_scope,
            grant_type="approval",
            provider_peer_id=peer_id,
            provider_service_instance_id=service_instance_id,
            global_tool_id=stable_tool_id,
            local_tool_name="remote_status",
            trust_tier="trusted",
            created_by="admin",
            reason="operator approved this stable remote tool",
            metadata=policy_metadata,
        )
    )
    assert created.ok is True
    assert created.grant is not None
    grant_id = created.grant.grant_id

    await service._on_remote_catalog_delta_announced(
        ToolingRemoteCatalogDeltaAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=2,
            generated_at="2026-07-10T00:01:00Z",
            full_schema_hash="stable-permission-hash",
            granted_permissions=[permission],
            provider_available=True,
        )
    )
    with patch.object(
        service,
        "_remote_tooling_candidates",
        Mock(return_value=[_provider_candidate(peer_id, [permission])]),
    ):
        initially_callable = await service._on_get_tool_catalog(
            ToolingGetToolCatalogRequest(caller_permissions=["*"])
        )
    assert stable_tool_id not in {tool.global_tool_id for tool in initially_callable.tools}
    assert (
        next(
            blocked
            for blocked in initially_callable.blocked_tools
            if blocked.tool.global_tool_id == stable_tool_id
        ).reason_code
        == "legacy_unverifiable"
    )

    await service._on_remote_catalog_delta_announced(
        ToolingRemoteCatalogDeltaAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=3,
            generated_at="2026-07-10T00:02:00Z",
            full_schema_hash="stable-permission-hash",
            granted_permissions=[],
            provider_available=True,
        )
    )
    with patch.object(
        service,
        "_remote_tooling_candidates",
        Mock(return_value=[_provider_candidate(peer_id, [])]),
    ):
        revoked_catalog = await service._on_get_tool_catalog(
            ToolingGetToolCatalogRequest(caller_permissions=["*"])
        )
    assert stable_tool_id not in {tool.global_tool_id for tool in revoked_catalog.tools}
    revoked_tool = next(
        blocked
        for blocked in revoked_catalog.blocked_tools
        if blocked.tool.global_tool_id == stable_tool_id
    )
    assert revoked_tool.reason_code == "legacy_unverifiable"
    assert revoked_tool.missing_permissions == []
    with patch.object(
        service,
        "_remote_tooling_candidates",
        Mock(return_value=[_provider_candidate(peer_id, [])]),
    ):
        revoked_sources = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    revoked_source = next(
        source
        for source in revoked_sources.sources
        if source.provider_peer_id == peer_id
        and source.provider_service_instance_id == service_instance_id
    )
    assert revoked_source.status == "blocked"
    assert revoked_source.tool_count == 1
    assert revoked_source.blocked_tool_count == 1
    assert revoked_source.reason_code == "legacy_unverifiable"
    assert revoked_source.reason == revoked_tool.reason

    snapshot_rows = await service._db_sql(
        """
        SELECT peer_id, service_instance_id, tools_json, stale, removed_at
        FROM tooling_remote_catalog_snapshots
        WHERE peer_id = ? AND service_instance_id = ?
        """,
        [peer_id, service_instance_id],
    )
    assert len(snapshot_rows) == 1
    assert snapshot_rows[0]["stale"] == 0
    assert snapshot_rows[0]["removed_at"] is None
    assert [tool["global_tool_id"] for tool in json.loads(snapshot_rows[0]["tools_json"])] == [
        stable_tool_id
    ]
    grant_rows = await service._db_sql(
        """
        SELECT grant_id, active, revoked_at, global_tool_id, metadata_json
        FROM tooling_approval_grants
        WHERE grant_id = ?
        """,
        [grant_id],
    )
    assert grant_rows == [
        {
            "grant_id": grant_id,
            "active": 1,
            "revoked_at": None,
            "global_tool_id": stable_tool_id,
            "metadata_json": json.dumps(policy_metadata, sort_keys=True),
        }
    ]

    await service._on_remote_catalog_delta_announced(
        ToolingRemoteCatalogDeltaAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=4,
            generated_at="2026-07-10T00:03:00Z",
            full_schema_hash="stable-permission-hash",
            granted_permissions=[permission],
            provider_available=True,
        )
    )
    with patch.object(
        service,
        "_remote_tooling_candidates",
        Mock(return_value=[_provider_candidate(peer_id, [permission])]),
    ):
        restored_catalog = await service._on_get_tool_catalog(
            ToolingGetToolCatalogRequest(caller_permissions=["*"])
        )
    assert stable_tool_id not in {tool.global_tool_id for tool in restored_catalog.tools}
    assert (
        next(
            blocked
            for blocked in restored_catalog.blocked_tools
            if blocked.tool.global_tool_id == stable_tool_id
        ).reason_code
        == "legacy_unverifiable"
    )
    with patch.object(
        service,
        "_remote_tooling_candidates",
        Mock(return_value=[_provider_candidate(peer_id, [permission])]),
    ):
        restored_sources = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    restored_source = next(
        source
        for source in restored_sources.sources
        if source.provider_peer_id == peer_id
        and source.provider_service_instance_id == service_instance_id
    )
    assert restored_source.status == "blocked"
    assert restored_source.reason_code == "legacy_unverifiable"

    restored_snapshot_rows = await service._db_sql(
        """
        SELECT tools_json, stale, removed_at
        FROM tooling_remote_catalog_snapshots
        WHERE peer_id = ? AND service_instance_id = ?
        """,
        [peer_id, service_instance_id],
    )
    assert len(restored_snapshot_rows) == 1
    assert restored_snapshot_rows[0]["stale"] == 0
    assert restored_snapshot_rows[0]["removed_at"] is None
    assert [
        tool["global_tool_id"] for tool in json.loads(restored_snapshot_rows[0]["tools_json"])
    ] == [stable_tool_id]
    restored_grant_rows = await service._db_sql(
        """
        SELECT active, revoked_at, metadata_json
        FROM tooling_approval_grants
        WHERE grant_id = ?
        """,
        [grant_id],
    )
    assert restored_grant_rows == [
        {
            "active": 1,
            "revoked_at": None,
            "metadata_json": json.dumps(policy_metadata, sort_keys=True),
        }
    ]
    tombstone_rows = await service._db_sql(
        """
        SELECT global_tool_id
        FROM tooling_remote_catalog_tombstones
        WHERE peer_id = ? AND service_instance_id = ?
        """,
        [peer_id, service_instance_id],
    )
    assert tombstone_rows == []


@pytest.mark.asyncio
async def test_remote_catalog_schema_and_grant_invalidation_roll_back_together(
    management_service,
):
    """A failed dependent-grant update cannot commit a changed catalog schema."""

    service, bus = management_service
    peer_id = "aurora-atomic-catalog-peer"
    service_instance_id = f"remote:{peer_id}:Tooling"
    key = (peer_id, service_instance_id)
    initial_tool = _announced_remote_tool(required_permissions=[ToolingMethods.EXECUTE_TOOL])
    await service._on_remote_catalog_announced(
        ToolingRemoteCatalogAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=1,
            generated_at="2026-07-10T00:00:00Z",
            full_schema_hash="peer-hash-v1",
            tools=[initial_tool],
            shared_by_policy=True,
        )
    )
    initial_memory = service._remote_catalog_snapshots[key]
    initial_snapshot = initial_memory[0]
    policy_metadata = {
        "operator_policy": "always",
        "policy_note": "must survive a failed schema transaction",
    }
    created = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="approval",
            provider_peer_id=peer_id,
            provider_service_instance_id=service_instance_id,
            global_tool_id=initial_snapshot.tools[0].global_tool_id,
            local_tool_name="remote_status",
            trust_tier="trusted",
            created_by="admin",
            metadata=policy_metadata,
        )
    )
    assert created.ok is True
    assert created.grant is not None

    # This simulates a storage-level failure while the catalog UPSERT's own
    # trigger is marking dependent grants. SQLite must roll the UPSERT back.
    await service._db_sql(
        """
        CREATE TRIGGER force_remote_grant_invalidation_failure
        BEFORE UPDATE OF metadata_json ON tooling_approval_grants
        BEGIN
            SELECT RAISE(ABORT, 'forced grant invalidation failure');
        END
        """
    )
    bus.report_sql_errors = True
    changed_tool = _announced_remote_tool(
        required_permissions=[ToolingMethods.EXECUTE_TOOL, "TTS.Request"]
    )
    with pytest.raises(RuntimeError, match="forced grant invalidation failure"):
        await service._on_remote_catalog_announced(
            ToolingRemoteCatalogAnnounced(
                peer_id=peer_id,
                service_instance_id=service_instance_id,
                provider_id=peer_id,
                catalog_epoch=2,
                generated_at="2026-07-10T00:01:00Z",
                full_schema_hash="peer-hash-v2",
                tools=[changed_tool],
                shared_by_policy=True,
            )
        )

    # The durable registry, dependent policy, and in-memory cache all remain
    # on the last fully committed schema.
    assert service._remote_catalog_snapshots[key] == initial_memory
    snapshot_rows = await service._db_sql(
        """
        SELECT catalog_epoch, full_schema_hash, tools_json
        FROM tooling_remote_catalog_snapshots
        WHERE peer_id = ? AND service_instance_id = ?
        """,
        [peer_id, service_instance_id],
    )
    assert snapshot_rows[0]["catalog_epoch"] == 1
    assert snapshot_rows[0]["full_schema_hash"] == initial_snapshot.full_schema_hash
    persisted_tools = json.loads(snapshot_rows[0]["tools_json"])
    assert persisted_tools[0]["required_permissions"] == [ToolingMethods.EXECUTE_TOOL]
    grant_rows = await service._db_sql(
        """
        SELECT active, revoked_at, metadata_json
        FROM tooling_approval_grants
        WHERE grant_id = ?
        """,
        [created.grant.grant_id],
    )
    assert grant_rows == [
        {
            "active": 1,
            "revoked_at": None,
            "metadata_json": json.dumps(policy_metadata, sort_keys=True),
        }
    ]


@pytest.mark.asyncio
async def test_remote_catalog_delta_removal_commits_registry_policy_and_tombstone_together(
    management_service,
):
    """A successful removal durably updates all three dependent records."""

    service, _bus = management_service
    peer_id = "aurora-atomic-removal-peer"
    service_instance_id = f"remote:{peer_id}:Tooling"
    key = (peer_id, service_instance_id)
    await service._on_remote_catalog_announced(
        ToolingRemoteCatalogAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=1,
            generated_at="2026-07-10T00:00:00Z",
            full_schema_hash="peer-removal-v1",
            tools=[_announced_remote_tool("keep"), _announced_remote_tool("remove")],
            shared_by_policy=True,
        )
    )
    initial = service._remote_catalog_snapshots[key][0]
    removed_tool = next(tool for tool in initial.tools if tool.local_name == "remove")
    kept_tool = next(tool for tool in initial.tools if tool.local_name == "keep")
    policy_metadata = {
        "operator_policy": "always",
        "policy_note": "preserve this policy while disabling the removed tool",
    }
    created = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="approval",
            provider_peer_id=peer_id,
            provider_service_instance_id=service_instance_id,
            global_tool_id=removed_tool.global_tool_id,
            local_tool_name=removed_tool.local_name,
            trust_tier="trusted",
            created_by="admin",
            metadata=policy_metadata,
        )
    )
    assert created.ok is True
    assert created.grant is not None

    await service._on_remote_catalog_delta_announced(
        ToolingRemoteCatalogDeltaAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=2,
            generated_at="2026-07-10T00:01:00Z",
            full_schema_hash="peer-removal-v2",
            removed_global_tool_ids=[removed_tool.global_tool_id],
        )
    )

    assert [tool.global_tool_id for tool in service._remote_catalog_snapshots[key][0].tools] == [
        kept_tool.global_tool_id
    ]
    snapshot_rows = await service._db_sql(
        """
        SELECT catalog_epoch, tools_json
        FROM tooling_remote_catalog_snapshots
        WHERE peer_id = ? AND service_instance_id = ?
        """,
        [peer_id, service_instance_id],
    )
    assert snapshot_rows[0]["catalog_epoch"] == 2
    assert [tool["global_tool_id"] for tool in json.loads(snapshot_rows[0]["tools_json"])] == [
        kept_tool.global_tool_id
    ]
    tombstones = await service._db_sql(
        """
        SELECT global_tool_id, peer_id, service_instance_id, reason
        FROM tooling_remote_catalog_tombstones
        WHERE global_tool_id = ?
        """,
        [removed_tool.global_tool_id],
    )
    assert tombstones == [
        {
            "global_tool_id": removed_tool.global_tool_id,
            "peer_id": peer_id,
            "service_instance_id": service_instance_id,
            "reason": "remote_catalog_tool_removed",
        }
    ]
    grant_rows = await service._db_sql(
        """
        SELECT active, revoked_at, metadata_json
        FROM tooling_approval_grants
        WHERE grant_id = ?
        """,
        [created.grant.grant_id],
    )
    grant_metadata = json.loads(grant_rows[0]["metadata_json"])
    assert grant_rows[0]["active"] == 1
    assert grant_rows[0]["revoked_at"] is None
    assert grant_metadata["operator_policy"] == policy_metadata["operator_policy"]
    assert grant_metadata["policy_note"] == policy_metadata["policy_note"]
    assert grant_metadata["needs_review"] is True
    assert grant_metadata["stale_reason"] == "remote_catalog_tool_removed"


@pytest.mark.asyncio
async def test_remote_catalog_delta_removal_rolls_back_every_side_effect(
    management_service,
):
    """A tombstone failure retains the old catalog, policy, and empty tombstone set."""

    service, bus = management_service
    peer_id = "aurora-failed-removal-peer"
    service_instance_id = f"remote:{peer_id}:Tooling"
    key = (peer_id, service_instance_id)
    await service._on_remote_catalog_announced(
        ToolingRemoteCatalogAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=1,
            generated_at="2026-07-10T00:00:00Z",
            full_schema_hash="peer-removal-v1",
            tools=[_announced_remote_tool("remove")],
            shared_by_policy=True,
        )
    )
    initial_memory = service._remote_catalog_snapshots[key]
    removed_tool = initial_memory[0].tools[0]
    policy_metadata = {
        "operator_policy": "deny_always",
        "policy_note": "must survive failed removal",
    }
    created = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="deny_always",
            grant_type="approval",
            provider_peer_id=peer_id,
            provider_service_instance_id=service_instance_id,
            global_tool_id=removed_tool.global_tool_id,
            local_tool_name=removed_tool.local_name,
            trust_tier="trusted",
            created_by="admin",
            metadata=policy_metadata,
        )
    )
    assert created.ok is True
    assert created.grant is not None
    await service._db_sql(
        """
        CREATE TRIGGER force_remote_tombstone_failure
        BEFORE INSERT ON tooling_remote_catalog_tombstones
        BEGIN
            SELECT RAISE(ABORT, 'forced tombstone failure');
        END
        """
    )
    bus.report_sql_errors = True

    with pytest.raises(RuntimeError, match="forced tombstone failure"):
        await service._on_remote_catalog_delta_announced(
            ToolingRemoteCatalogDeltaAnnounced(
                peer_id=peer_id,
                service_instance_id=service_instance_id,
                provider_id=peer_id,
                catalog_epoch=2,
                generated_at="2026-07-10T00:01:00Z",
                full_schema_hash="peer-removal-v2",
                removed_global_tool_ids=[removed_tool.global_tool_id],
            )
        )

    assert service._remote_catalog_snapshots[key] == initial_memory
    snapshot_rows = await service._db_sql(
        """
        SELECT catalog_epoch, tools_json
        FROM tooling_remote_catalog_snapshots
        WHERE peer_id = ? AND service_instance_id = ?
        """,
        [peer_id, service_instance_id],
    )
    assert snapshot_rows[0]["catalog_epoch"] == 1
    assert [tool["global_tool_id"] for tool in json.loads(snapshot_rows[0]["tools_json"])] == [
        removed_tool.global_tool_id
    ]
    tombstones = await service._db_sql(
        "SELECT global_tool_id FROM tooling_remote_catalog_tombstones"
    )
    assert tombstones == []
    grant_rows = await service._db_sql(
        """
        SELECT active, revoked_at, metadata_json
        FROM tooling_approval_grants
        WHERE grant_id = ?
        """,
        [created.grant.grant_id],
    )
    assert grant_rows == [
        {
            "active": 1,
            "revoked_at": None,
            "metadata_json": json.dumps(policy_metadata, sort_keys=True),
        }
    ]


@pytest.mark.asyncio
async def test_tooling_restart_ignores_persisted_provider_availability(management_service):
    """Cached peer tools fail closed until fresh live provider state arrives."""

    service, _bus = management_service
    peer_id = "aurora-stable-restart-peer"
    service_instance_id = f"remote:{peer_id}:Tooling"
    source_id = f"mesh:{peer_id}:remote_{peer_id}_Tooling"
    permission = ToolingMethods.EXECUTE_TOOL
    await service._on_remote_catalog_announced(
        ToolingRemoteCatalogAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=1,
            generated_at="2026-07-10T00:00:00Z",
            full_schema_hash="restart-cache-hash",
            tools=[_announced_remote_tool(required_permissions=[permission])],
            shared_by_policy=True,
            granted_permissions=[permission],
            provider_available=True,
        )
    )
    stable_tool_id = (
        service._remote_catalog_snapshots[(peer_id, service_instance_id)][0].tools[0].global_tool_id
    )

    persisted_rows = await service._db_sql(
        """
        SELECT tools_json
        FROM tooling_remote_catalog_snapshots
        WHERE peer_id = ? AND service_instance_id = ?
        """,
        [peer_id, service_instance_id],
    )
    persisted_tools = json.loads(persisted_rows[0]["tools_json"])
    # Simulate a row written by an older build that incorrectly persisted
    # session liveness alongside the durable tool registry.
    persisted_tools[0]["provider_available"] = True
    persisted_tools[0]["provider_granted_permissions"] = [permission]
    await service._db_sql(
        """
        UPDATE tooling_remote_catalog_snapshots
        SET tools_json = ?
        WHERE peer_id = ? AND service_instance_id = ?
        """,
        [json.dumps(persisted_tools), peer_id, service_instance_id],
    )

    restarted = ToolingService()
    restarted.tools_manager = service.tools_manager
    catalog = await restarted._on_get_tool_catalog(
        ToolingGetToolCatalogRequest(caller_permissions=["*"])
    )
    assert stable_tool_id not in {tool.global_tool_id for tool in catalog.tools}
    blocked = next(
        item for item in catalog.blocked_tools if item.tool.global_tool_id == stable_tool_id
    )
    assert blocked.reason_code == "legacy_unverifiable"
    provider = next(item for item in catalog.providers if item.provider_peer_id == peer_id)
    assert provider.eligible is False
    assert provider.reason_code == "legacy_unverifiable"
    loaded_snapshot = restarted._remote_catalog_snapshots[(peer_id, service_instance_id)][0]
    assert loaded_snapshot.provider_available is None
    assert loaded_snapshot.granted_permissions is None
    assert loaded_snapshot.tools[0].provider_available is None
    assert loaded_snapshot.tools[0].provider_granted_permissions is None

    sources = await restarted._on_list_tool_sources(ToolingListToolSourcesRequest())
    peer_source = next(item for item in sources.sources if item.source_id == source_id)
    assert peer_source.tool_count == 1
    assert peer_source.blocked_tool_count == 1
    assert peer_source.status == "blocked"
    detail = await restarted._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id=source_id)
    )
    assert detail.tools == []
    assert [item.tool.global_tool_id for item in detail.blocked_tools] == [stable_tool_id]
    assert detail.blocked_tools[0].reason_code == "legacy_unverifiable"

    await restarted._on_remote_catalog_delta_announced(
        ToolingRemoteCatalogDeltaAnnounced(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            provider_id=peer_id,
            catalog_epoch=2,
            generated_at="2026-07-10T00:01:00Z",
            full_schema_hash="restart-cache-hash",
            granted_permissions=[permission],
            provider_available=True,
        )
    )
    with patch.object(
        restarted,
        "_remote_tooling_candidates",
        Mock(return_value=[_provider_candidate(peer_id, [permission])]),
    ):
        refreshed_catalog = await restarted._on_get_tool_catalog(
            ToolingGetToolCatalogRequest(caller_permissions=["*"])
        )
    assert stable_tool_id not in {tool.global_tool_id for tool in refreshed_catalog.tools}


@pytest.mark.asyncio
async def test_remote_catalog_load_retires_ephemeral_restart_keys(management_service):
    """Old signaling UUID snapshots must not survive as duplicate mesh sources."""

    service, bus = management_service
    stable_peer_id = "aurora-stable-peer"
    signaling_peer_id = "97e7d10b-db2c-4d92-8793-86012eb5b2ba"
    with sqlite3.connect(bus.db_path) as connection:
        connection.execute("CREATE TABLE mesh_peers (peer_id TEXT NOT NULL)")
        connection.execute("INSERT INTO mesh_peers (peer_id) VALUES (?)", [stable_peer_id])

    for peer_id in (stable_peer_id, signaling_peer_id):
        await service._persist_remote_catalog_snapshot(
            ToolingRemoteCatalogAnnounced(
                peer_id=peer_id,
                service_instance_id=f"remote:{peer_id}:Tooling",
                provider_id=peer_id,
                catalog_epoch=1,
                generated_at="2026-07-10T00:00:00Z",
                full_schema_hash=f"hash-{peer_id}",
                tools=[],
                shared_by_policy=True,
            )
        )

    loaded = await service._load_remote_catalog_snapshots()

    assert [(snapshot.peer_id, snapshot.service_instance_id) for snapshot in loaded] == [
        (stable_peer_id, f"remote:{stable_peer_id}:Tooling")
    ]
    rows = await service._db_sql(
        """
        SELECT peer_id, stale, removed_at
        FROM tooling_remote_catalog_snapshots
        ORDER BY peer_id
        """
    )
    by_peer_id = {row["peer_id"]: row for row in rows}
    assert by_peer_id[stable_peer_id]["stale"] == 0
    assert by_peer_id[stable_peer_id]["removed_at"] is None
    assert by_peer_id[signaling_peer_id]["stale"] == 1
    assert by_peer_id[signaling_peer_id]["removed_at"] is not None


@pytest.mark.asyncio
async def test_mcp_and_plugin_sources_keep_distinct_policy_identity(management_service):
    """Multiple local MCP/plugin sources must not collapse into one policy bucket."""

    service, _bus = management_service
    mail_mcp = _tool("mcp_mail_search", source="mcp")
    mail_mcp.mcp_server_name = "mail"
    calendar_mcp = _tool("mcp_calendar_search", source="mcp")
    calendar_mcp.mcp_server_name = "calendar"
    weather_plugin = _tool("plugin_weather", source="plugin")
    weather_plugin.plugin_name = "weather"
    notes_plugin = _tool("plugin_notes", source="plugin")
    notes_plugin.plugin_name = "notes"
    tools = [mail_mcp, calendar_mcp, weather_plugin, notes_plugin]
    service.tools_manager.get_tools.return_value = tools
    service.tools_manager.get_tool_by_name.side_effect = lambda name: next(
        (tool for tool in tools if tool.name == name), None
    )

    sources = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    source_ids = {source.source_id for source in sources.sources}

    assert {
        "local:mcp:mail",
        "local:mcp:calendar",
        "local:plugin:weather",
        "local:plugin:notes",
    }.issubset(source_ids)
    mail_detail = await service._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id="local:mcp:mail")
    )
    calendar_detail = await service._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id="local:mcp:calendar")
    )
    assert [tool.local_name for tool in mail_detail.tools] == ["mcp_mail_search"]
    assert [tool.local_name for tool in calendar_detail.tools] == ["mcp_calendar_search"]


@pytest.mark.asyncio
async def test_pending_approvals_and_audit_history_are_redacted(management_service):
    """Pending approval and audit read models do not expose raw secret arguments."""

    service, bus = management_service
    approval = await service._on_request_approval(
        ToolingRequestApprovalRequest(
            tool_name="mcp_secret_search",
            arguments={"query": "weather", "api_key": "raw-secret-value"},
            caller_principal_id="principal-a",
            caller_peer_id="peer-a",
            requested_by_principal_id="principal-a",
            correlation_id="corr-secret",
        )
    )
    assert approval.ok is True
    assert approval.approval_request_id is not None

    pending = await service._on_list_pending_approvals(ToolingListPendingApprovalsRequest())
    dumped = json.dumps(pending.model_dump(mode="json"), sort_keys=True)
    assert pending.count == 1
    assert "raw-secret-value" not in dumped
    assert "<redacted>" in dumped
    assert pending.approvals[0].display_args_preview["api_key"] == "<redacted>"

    await service._audit_tooling_event(
        "tooling.policy.test_secret_redaction",
        principal_id="principal-a",
        details={"token": "raw-audit-secret", "correlation_id": "corr-secret"},
    )
    audit = await service._on_list_policy_audit_events(ToolingListPolicyAuditEventsRequest())
    audit_dumped = json.dumps(audit.model_dump(mode="json"), sort_keys=True)
    assert "raw-audit-secret" not in audit_dumped
    assert "[redacted]" in audit_dumped
    assert any(event.event.startswith("tooling.") for event in audit.events)
    assert bus.request.await_count > 0


@pytest.mark.asyncio
async def test_onboarding_status_redacts_mcp_server_secrets(management_service):
    """Onboarding status redacts MCP headers and reports plugin/mesh capability rows."""

    service, _bus = management_service
    status = await service._on_get_onboarding_status(ToolingGetOnboardingStatusRequest())

    dumped = json.dumps(status.model_dump(mode="json"), sort_keys=True)
    assert "super-secret-token" not in dumped
    assert "[redacted]" in dumped
    assert {capability.source for capability in status.capabilities} == {
        "mcp",
        "plugin",
        "mesh_peer",
    }
    mcp = next(capability for capability in status.capabilities if capability.source == "mcp")
    assert mcp.configured_count == 1
    assert mcp.active_count == 1


@pytest.mark.asyncio
async def test_policy_mutation_contracts_persist_grants_and_require_bypass_confirmation(
    management_service,
):
    """Management mutations use typed contracts, audit, and durable grant records."""

    service, bus = management_service
    rejected = await service._on_set_policy_mode(
        ToolingSetPolicyModeRequest(
            policy_mode="unrestricted_except_blocked",
            actor_principal_id="admin",
            reason="dangerous test",
            correlation_id="corr-bypass-reject",
        )
    )
    assert rejected.ok is False
    assert rejected.error == "confirmation_required"

    dry_run_rejected = await service._on_set_policy_mode(
        ToolingSetPolicyModeRequest(
            policy_mode="dry_run_only",
            actor_principal_id="admin",
            reason="safe dry run",
            correlation_id="corr-dry-run",
        )
    )
    assert dry_run_rejected.ok is False
    assert dry_run_rejected.error == "confirmation_required"

    accepted = await service._on_set_policy_mode(
        ToolingSetPolicyModeRequest(
            policy_mode="dry_run_only",
            actor_principal_id="admin",
            reason="safe dry run",
            confirmation_text="DRY RUN ONLY",
            correlation_id="corr-dry-run",
        )
    )
    assert accepted.ok is True
    assert accepted.policy.policy_mode == "dry_run_only"

    source = await service._on_upsert_source_policy(
        ToolingUpsertSourcePolicyRequest(
            source_id="local:mcp:search",
            trust_tier="trusted",
            actor_principal_id="admin",
            reason="reviewed source",
            include_future_tools=False,
            provider_peer_id="local",
            provider_service_instance_id="mcp-search",
            correlation_id="corr-source-policy",
        )
    )
    assert source.ok is True
    assert source.grant.grant_type == "trust"
    assert source.grant.include_future_tools is False
    assert source.grant.metadata["source_id"] == "local:mcp:search"

    blocked_source = await service._on_upsert_source_policy(
        ToolingUpsertSourcePolicyRequest(
            source_id="local:mcp:search",
            trust_tier="blocked",
            actor_principal_id="admin",
            reason="temporarily block source",
            include_future_tools=True,
            provider_peer_id="local",
            provider_service_instance_id="mcp-search",
            correlation_id="corr-source-policy-blocked",
        )
    )
    assert blocked_source.ok is True
    restored_source = await service._on_upsert_source_policy(
        ToolingUpsertSourcePolicyRequest(
            source_id="local:mcp:search",
            trust_tier="trusted",
            actor_principal_id="admin",
            reason="restore reviewed source",
            include_future_tools=True,
            provider_peer_id="local",
            provider_service_instance_id="mcp-search",
            correlation_id="corr-source-policy-restored",
        )
    )
    assert restored_source.ok is True
    source_summary = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    mcp_source = next(
        item for item in source_summary.sources if item.source_id == "local:mcp:search"
    )
    assert mcp_source.trust_tier == "trusted"
    assert mcp_source.configured_trust_tier == "trusted"
    active_source_policy_grants = [
        grant
        for grant in (await service._active_grants_for_read_models())
        if grant.metadata.get("policy_scope") == "source"
        and grant.metadata.get("source_id") == "local:mcp:search"
    ]
    assert [grant.grant_id for grant in active_source_policy_grants] == [
        restored_source.grant.grant_id
    ]

    override = await service._on_upsert_tool_policy_override(
        ToolingUpsertToolPolicyOverrideRequest(
            global_tool_id="tool:mcp:secret-search",
            local_tool_name="mcp_secret_search",
            trust_tier="blocked",
            actor_principal_id="admin",
            reason="block sensitive tool",
            expected_schema_hash="sha256:test",
            correlation_id="corr-tool-override",
        )
    )
    assert override.ok is True
    assert override.grant.grant_scope == "deny_always"
    assert override.grant.trust_tier == "blocked"
    assert override.grant.metadata["expected_schema_hash"] == "sha256:test"
    sibling_override = await service._on_upsert_tool_policy_override(
        ToolingUpsertToolPolicyOverrideRequest(
            global_tool_id="tool:other:secret-search",
            local_tool_name="mcp_secret_search",
            trust_tier="trusted",
            actor_principal_id="admin",
            reason="same local name on another stable tool",
            correlation_id="corr-tool-sibling",
        )
    )

    cleared_tool = await service._on_clear_tool_policy_override(
        ToolingClearToolPolicyOverrideRequest(
            global_tool_id="tool:mcp:secret-search",
            local_tool_name="mcp_secret_search",
            actor_principal_id="admin",
            reason="inherit source policy",
            correlation_id="corr-tool-clear",
        )
    )
    assert cleared_tool.ok is True
    assert cleared_tool.cleared is True
    assert cleared_tool.revoked_grant_ids == [override.grant.grant_id]
    assert sibling_override.grant.grant_id in {
        grant.grant_id for grant in await service._active_grants_for_read_models()
    }
    await service._on_clear_tool_policy_override(
        ToolingClearToolPolicyOverrideRequest(
            global_tool_id="tool:other:secret-search",
            actor_principal_id="admin",
            reason="clean sibling test override",
        )
    )

    cleared_source = await service._on_clear_source_policy(
        ToolingClearSourcePolicyRequest(
            source_id="local:mcp:search",
            actor_principal_id="admin",
            reason="inherit global policy",
            correlation_id="corr-source-clear",
        )
    )
    assert cleared_source.ok is True
    assert cleared_source.cleared is True
    assert cleared_source.revoked_grant_ids == [restored_source.grant.grant_id]
    inherited_summary = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    inherited_mcp = next(
        item for item in inherited_summary.sources if item.source_id == "local:mcp:search"
    )
    assert inherited_mcp.configured_trust_tier is None
    assert all(
        grant.metadata.get("policy_scope") not in {"source", "tool"}
        for grant in await service._active_grants_for_read_models()
    )

    audit = await service._on_list_policy_audit_events(ToolingListPolicyAuditEventsRequest())
    assert {event.event for event in audit.events} >= {
        "tooling.policy.mode_set",
        "tooling.source_policy.upserted",
        "tooling.tool_policy_override.upserted",
        "tooling.source_policy.cleared",
        "tooling.tool_policy_override.cleared",
    }
    assert bus.audit_events


@pytest.mark.asyncio
async def test_onboarding_mutation_contracts_are_redacted_and_explicitly_unsupported(
    management_service,
):
    """MCP/plugin onboarding contracts are UI-safe even before installers are implemented."""

    service, _bus = management_service
    mcp = await service._on_test_mcp_source(
        ToolingTestMCPSourceRequest(
            actor_principal_id="admin",
            source_id="mcp:secret",
            command="npx mcp-secret",
            env={"TOKEN": "raw-secret-token"},
            reason="test",
        )
    )
    dumped = json.dumps(mcp.model_dump(mode="json"), sort_keys=True)
    assert mcp.ok is False
    assert mcp.secrets_redacted is True
    assert "raw-secret-token" not in dumped

    created = await service._on_create_mcp_source(
        ToolingCreateMCPSourceRequest(
            actor_principal_id="admin",
            source_id="mcp:secret",
            command="npx mcp-secret",
            reason="test",
        )
    )
    assert created.created is False
    assert created.secrets_redacted is True

    plugin = await service._on_test_plugin_source(
        ToolingTestPluginSourceRequest(
            actor_principal_id="admin",
            source_id="plugin:sample",
            package="aurora-plugin-sample",
            reason="test",
        )
    )
    assert plugin.ok is False
    assert plugin.secrets_redacted is True

    plugin_created = await service._on_create_plugin_source(
        ToolingCreatePluginSourceRequest(
            actor_principal_id="admin",
            source_id="plugin:sample",
            package="aurora-plugin-sample",
            reason="test",
        )
    )
    assert plugin_created.created is False
    assert plugin_created.secrets_redacted is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "availability",
    [
        "unshared",
        "permission_blocked",
        "provider_unavailable",
        "removed",
        "stale",
        "schema_changed",
        "protocol_unsupported",
    ],
)
async def test_normalized_inactive_history_is_management_only(
    management_service, availability: str
):
    """Every retained inactive state stays visible but never reaches LLM binding."""

    service, bus = management_service
    peer_id = "stable-peer-2"
    row = _normalized_remote_tool(peer_id, availability)
    header = {
        "peer_id": peer_id,
        "provider_id": peer_id,
        "service_instance_id": "remote:Tooling",
        "protocol_tier": "projection_v1",
        "projection_revision": "projection-2",
        "projection_digest": "d" * 64,
        "authority_revision": row["authority_revision"],
        "current_generation": 2,
        "sync_state": "committed",
        "availability": "active",
        "last_error_reason": None,
        "committed_at": 20.0,
        "updated_at": 30.0,
    }
    original_request = bus._request

    async def request(topic, payload, **kwargs):
        if topic == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(ok=True, data={"headers": [header], "tools": [row]})
        return await original_request(topic, payload, **kwargs)

    bus.request.side_effect = request
    service._mesh_projection_enforcement_active = True
    service._on_get_tool_catalog = AsyncMock(
        return_value=ToolingGetToolCatalogResponse(
            tools=[],
            blocked_tools=[],
            providers=[],
            count=0,
            blocked_count=0,
            generated_at="2026-07-14T00:00:00Z",
        )
    )

    sources = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    remote = next(source for source in sources.sources if source.provider_peer_id == peer_id)
    assert remote.tool_count == 0
    assert remote.retained_tool_count == 1
    assert remote.inactive_tool_count == 1
    assert remote.status == availability
    detail = await service._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id=remote.source_id)
    )
    assert detail.tools == []
    assert detail.blocked_tools == []
    assert len(detail.retained_tools) == 1
    retained = detail.retained_tools[0]
    assert retained.global_tool_id == f"aurora-tool:v1:{peer_id}:Tooling:schedule"
    assert retained.retained_availability == availability
    assert retained.effective_availability == availability
    assert retained.review_required is (availability == "schema_changed")
    llm_tools, bindings = build_tool_bindings(
        [tool.model_dump(mode="python") for tool in detail.tools]
    )
    assert llm_tools == []
    assert bindings == {}


@pytest.mark.asyncio
async def test_provider_unavailable_preserves_schema_review_cause(management_service):
    """Provider reachability changes effective state without erasing schema review state."""

    service, bus = management_service
    peer_id = "stable-peer-offline"
    row = _normalized_remote_tool(peer_id, "schema_changed")
    header = {
        "peer_id": peer_id,
        "provider_id": peer_id,
        "service_instance_id": "remote:Tooling",
        "protocol_tier": "projection_v1",
        "projection_revision": "projection-2",
        "projection_digest": "d" * 64,
        "authority_revision": row["authority_revision"],
        "current_generation": 2,
        "sync_state": "committed",
        "availability": "provider_unavailable",
        "last_error_reason": "provider_disconnected",
        "committed_at": 20.0,
        "updated_at": 31.0,
    }
    original_request = bus._request

    async def request(topic, payload, **kwargs):
        if topic == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(ok=True, data={"headers": [header], "tools": [row]})
        return await original_request(topic, payload, **kwargs)

    bus.request.side_effect = request
    service._mesh_projection_enforcement_active = True
    _headers, retained = await service._load_normalized_management_catalog()
    assert retained[0].retained_availability == "schema_changed"
    assert retained[0].effective_availability == "provider_unavailable"
    assert retained[0].review_required is True
    service._on_get_tool_catalog = AsyncMock(
        return_value=ToolingGetToolCatalogResponse(
            tools=[],
            blocked_tools=[],
            providers=[],
            count=0,
            blocked_count=0,
            generated_at="2026-07-14T00:00:00Z",
        )
    )
    sources = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    source = next(item for item in sources.sources if item.provider_peer_id == peer_id)
    assert source.status == "provider_unavailable"
    assert source.availability_counts == {"schema_changed": 1}


@pytest.mark.asyncio
async def test_exact_schema_review_uses_cas_and_keeps_old_positive_grants_stale(
    management_service,
):
    """Review accepts the row only; it cannot silently reactivate prior authority."""

    service, bus = management_service
    peer_id = "stable-peer-review"
    row = _normalized_remote_tool(peer_id, "active")
    header = {
        "peer_id": peer_id,
        "provider_id": peer_id,
        "service_instance_id": "remote:Tooling",
        "protocol_tier": "projection_v1",
        "projection_revision": "projection-2",
        "projection_digest": "d" * 64,
        "authority_revision": row["authority_revision"],
        "current_generation": 2,
        "sync_state": "committed",
        "availability": "active",
        "last_error_reason": None,
        "committed_at": 20.0,
        "updated_at": 31.0,
    }
    seen_request = None

    async def request(topic, payload, **kwargs):
        nonlocal seen_request
        if topic == DBMethods.ACCEPT_TOOLING_REMOTE_TOOL_SCHEMA:
            seen_request = payload
            return QueryResult(
                ok=True,
                data={"ok": True, "changed": True, "correlation_id": "review-1"},
            )
        if topic == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(ok=True, data={"headers": [header], "tools": [row]})
        return QueryResult(ok=False, error=topic)

    bus.request.side_effect = request
    service._mesh_projection_enforcement_active = True
    response = await service._on_accept_remote_tool_schema(
        ToolingAcceptRemoteToolSchemaRequest(
            peer_id=peer_id,
            provider_id=peer_id,
            global_tool_id=str(row["tool"]["global_tool_id"]),
            expected_projection_revision="projection-2",
            expected_schema_hash="b" * 64,
            actor_principal_id="spoofed",
            reason="Reviewed exact callable schema",
            correlation_id="review-1",
        ),
        envelope=Envelope(
            type=ToolingMethods.ACCEPT_REMOTE_TOOL_SCHEMA,
            payload={},
            origin="external",
            principal_id="admin-authenticated",
        ),
    )
    assert response.ok is True
    assert response.changed is True
    assert response.retained_tool is not None
    assert seen_request.actor_principal_id == "admin-authenticated"
    assert seen_request.expected_projection_revision == "projection-2"
    assert seen_request.expected_schema_hash == "b" * 64
