"""In-process G013 recipient-specific Tooling projection integration proof."""

from __future__ import annotations

import json
import sqlite3
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import QueryResult
from app.services.db.manager import DatabaseManager
from app.services.db.tooling_remote_catalog_store import (
    compute_projection_checksum,
    compute_projection_page_hash,
)
from app.services.gateway.mesh.tooling_projection_transport import select_tooling_protocol
from app.services.orchestrator.tool_bindings import build_tool_bindings
from app.services.tooling.projection import ProjectionContext, build_recipient_projection
from app.services.tooling.projection_cursor import (
    ProjectionCursor,
    ProjectionCursorCodec,
    ProjectionCursorError,
)
from app.services.tooling.service import ToolingService
from app.shared.contracts.models.db import (
    DBAcceptToolingRemoteToolSchemaRequest,
    DBAppendToolingRemoteCatalogPageRequest,
    DBBeginToolingRemoteCatalogSyncRequest,
    DBCommitToolingRemoteCatalogSyncRequest,
    DBGetToolingRemoteCatalogRequest,
    DBMethods,
    DBPruneToolingRemoteCatalogRetentionRequest,
    DBSetToolingRemoteProviderAvailabilityRequest,
)
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.tooling import (
    ToolingExecuteToolRequest,
    ToolingExportPolicy,
    ToolingExportRule,
    ToolingGetExportCatalogResponse,
    ToolingGetToolByNameRequest,
    ToolingGetToolCatalogResponse,
    ToolingGetToolSourceDetailRequest,
    ToolingListToolSourcesRequest,
    ToolingMeshKillSwitches,
    ToolingPolicyDecision,
    ToolingPrepareExecutionRequest,
    ToolingPrepareExecutionResponse,
    ToolingProjectionAuthorityRevision,
    ToolingProjectionRetirement,
    ToolingRemoteCatalogAnnounced,
    ToolingToolInfo,
    ToolingToolProvenance,
)

AUTHORITY = ToolingProjectionAuthorityRevision(
    catalog_revision=1,
    export_policy_revision=2,
    auth_grant_revision=3,
    manifest_revision=4,
    switch_revision=5,
)


def _tool(name: str, *, permission: str = "Tooling.ExecuteTool") -> ToolingToolInfo:
    return ToolingToolInfo(
        name=name,
        local_name=name,
        global_tool_id=f"aurora-tool:v1:provider:Tooling:{name}",
        tool_id_scheme="aurora-tool",
        tool_id_version=1,
        tool_contract_id=name,
        share_group_id="core:test",
        share_group_label="Test",
        exportable=True,
        provider_peer_id="provider",
        provider_service_instance_id="local:Tooling",
        namespace="local",
        display_name=name,
        source_type="local",
        source="core",
        execution_location="local",
        required_permissions=[permission],
        provenance=ToolingToolProvenance(
            provider_peer_id="provider",
            provider_service_instance_id="local:Tooling",
            provider_kind="local",
            source="core",
            advertised_name=name,
        ),
    )


def _page(
    tools: list[ToolingToolInfo],
    *,
    retirements: list[ToolingProjectionRetirement] | None = None,
    revision: str = "revision-1",
) -> ToolingGetExportCatalogResponse:
    retirements = retirements or []
    service_instance_id = "remote:provider:Tooling"
    tools = [
        tool.model_copy(
            update={
                "provider_service_instance_id": service_instance_id,
                "provenance": tool.provenance.model_copy(
                    update={"provider_service_instance_id": service_instance_id}
                ),
            }
        )
        for tool in tools
    ]
    checksum = compute_projection_checksum(tools, retirements)
    page = ToolingGetExportCatalogResponse(
        provider_peer_id="provider",
        service_instance_id=service_instance_id,
        authority_revision=AUTHORITY,
        projection_revision=revision,
        projection_digest=checksum,
        page_index=0,
        page_size=10,
        page_hash="0" * 64,
        tools=tools,
        retirements=retirements,
        complete=True,
        total_count=len(tools),
        final_checksum=checksum,
    )
    return page.model_copy(update={"page_hash": compute_projection_page_hash(page)})


async def _commit_page(
    manager: DatabaseManager,
    page: ToolingGetExportCatalogResponse,
    *,
    sync_id: str,
    base_generation: int,
) -> None:
    begun = await manager.begin_tooling_remote_catalog_sync(
        DBBeginToolingRemoteCatalogSyncRequest(
            sync_id=sync_id,
            peer_id="provider",
            provider_id="provider",
            service_instance_id="remote:provider:Tooling",
            projection_revision=page.projection_revision,
            projection_digest=page.projection_digest,
            authority_revision=page.authority_revision,
            page_size=page.page_size,
            expected_base_generation=base_generation,
        )
    )
    assert begun.ok
    appended = await manager.append_tooling_remote_catalog_page(
        DBAppendToolingRemoteCatalogPageRequest(sync_id=sync_id, page=page)
    )
    assert appended.ok
    committed = await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id=sync_id,
            expected_base_generation=base_generation,
        )
    )
    assert committed.ok, committed.error


def _insert_lifecycle_grants(db_path: str, global_tool_id: str) -> None:
    now = time.time()
    rows = [
        (
            "grant-allow-a",
            "always",
            "approval",
            1,
            "principal-a",
            "trusted",
            json.dumps({}),
        ),
        (
            "grant-deny-b",
            "deny_always",
            "trust",
            1,
            "principal-b",
            "blocked",
            json.dumps({}),
        ),
        (
            "grant-consumed-once",
            "once",
            "approval",
            0,
            "principal-c",
            "trusted",
            json.dumps({"consumed": True}),
        ),
    ]
    with sqlite3.connect(db_path) as connection:
        connection.executemany(
            """
            INSERT INTO tooling_approval_grants (
                grant_id, grant_scope, grant_type, active, principal_id,
                provider_peer_id, provider_service_instance_id, global_tool_id,
                local_tool_name, trust_tier, include_future_tools, created_by,
                created_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, 'provider', 'remote:provider:Tooling', ?,
                      'alpha', ?, 0, 'admin', ?, ?)
            """,
            [(*row[:5], global_tool_id, row[5], now, row[6]) for row in rows],
        )
        connection.commit()


def _read_lifecycle_grants(db_path: str) -> dict[str, dict[str, object]]:
    with sqlite3.connect(db_path) as connection:
        connection.row_factory = sqlite3.Row
        return {
            str(row["grant_id"]): dict(row)
            for row in connection.execute(
                "SELECT * FROM tooling_approval_grants ORDER BY grant_id"
            ).fetchall()
        }


def _prepared_remote(tool: ToolingToolInfo) -> ToolingPrepareExecutionResponse:
    return ToolingPrepareExecutionResponse(
        ok=True,
        policy_decision=ToolingPolicyDecision(
            allowed=True,
            share=True,
            approval_required=False,
            approval_mode="approve_all_for_peer",
            decision_id="g014-integration",
        ),
        args_hash="args",
        resource_selector_hash="resource",
        route_decision_id="route",
        correlation_id="g014-integration",
        provider_peer_id="provider",
        provider_service_instance_id="remote:provider:Tooling",
        global_tool_id=tool.global_tool_id,
        local_tool_name=tool.local_name,
        args_schema_hash="schema",
        source="mesh_peer",
        trust_tier="untrusted",
        capability_class="read",
        resource_scope=[],
        display_args_preview={},
        argument_visibility={},
    )


@pytest.mark.integration
def test_recipient_specific_membership_digest_and_cursor_authority() -> None:
    tools = [_tool("shared"), _tool("network", permission="Network.Use")]
    policy = ToolingExportPolicy(default_state="shared", revision=7, initialized=True)
    peer_b_rule = ToolingExportRule(
        rule_id="deny-network-for-b",
        peer_id="peer-b",
        scope_type="tool",
        scope_id=tools[1].global_tool_id,
        state="unshared",
        actor_principal_id="admin",
        reason="recipient-specific restriction",
        created_at=1,
        updated_at=1,
    )
    a, digest_a = build_recipient_projection(
        tools,
        context=ProjectionContext(
            recipient_peer_id="peer-a",
            recipient_permissions=("*",),
            authority_revision=AUTHORITY,
            provider_enabled=True,
            service_exported=True,
            discovery_exported=True,
            execution_exported=True,
        ),
        policy=policy,
        rules=[],
    )
    b, digest_b = build_recipient_projection(
        tools,
        context=ProjectionContext(
            recipient_peer_id="peer-b",
            recipient_permissions=("*",),
            authority_revision=AUTHORITY,
            provider_enabled=True,
            service_exported=True,
            discovery_exported=True,
            execution_exported=True,
        ),
        policy=policy,
        rules=[peer_b_rule],
    )
    assert {tool.local_name for tool in a} == {"shared", "network"}
    assert {tool.local_name for tool in b} == {"shared"}
    assert digest_a != digest_b

    codec = ProjectionCursorCodec(secret=b"a" * 32)
    token = codec.encode(
        ProjectionCursor(
            recipient_peer_id="peer-a",
            provider_peer_id="provider",
            protocol_tier="projection_v1",
            projection_revision="revision-1",
            projection_digest=digest_a,
            page_size=1,
            next_offset=1,
            page_index=1,
            expires_at=int(time.time()) + 60,
            nonce="nonce",
        )
    )
    cursor = codec.decode(token)
    assert (cursor.recipient_peer_id, cursor.projection_digest) == ("peer-a", digest_a)
    assert (cursor.recipient_peer_id, cursor.projection_digest) != ("peer-b", digest_b)
    with pytest.raises(ProjectionCursorError):
        ProjectionCursorCodec(secret=b"b" * 32).decode(token)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_staging_never_binds_commit_promotes_and_restart_retains(tmp_path) -> None:
    db_path = str(tmp_path / "g013.db")
    manager = DatabaseManager(db_path)
    await manager.initialize()
    page = _page([_tool("alpha")])
    sync_id = "integration-sync-0001"
    begun = await manager.begin_tooling_remote_catalog_sync(
        DBBeginToolingRemoteCatalogSyncRequest(
            sync_id=sync_id,
            peer_id="provider",
            provider_id="provider",
            service_instance_id="remote:provider:Tooling",
            projection_revision=page.projection_revision,
            projection_digest=page.projection_digest,
            authority_revision=AUTHORITY,
            page_size=page.page_size,
            expected_base_generation=0,
        )
    )
    assert begun.ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(sync_id=sync_id, page=page)
        )
    ).ok
    assert (
        await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    ).tools == []
    committed = await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id=sync_id,
            expected_base_generation=0,
        )
    )
    assert committed.ok
    assert [row.tool.local_name for row in committed.tools if row.availability == "active"] == [
        "alpha"
    ]

    restarted = DatabaseManager(db_path)
    await restarted.initialize()
    retained = await restarted.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=False)
    )
    assert [row.tool.local_name for row in retained.tools] == ["alpha"]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_two_restart_unshare_reshare_preserves_allow_refusal_and_consumption(
    tmp_path,
) -> None:
    """H1: stable policy survives two restarts while inactive rows never bind."""

    db_path = str(tmp_path / "g014-h1.db")
    manager = DatabaseManager(db_path)
    await manager.initialize()
    tool = _tool("alpha")
    await _commit_page(
        manager,
        _page([tool], revision="revision-h1-1"),
        sync_id="h1-initial-sync-0001",
        base_generation=0,
    )
    _insert_lifecycle_grants(db_path, tool.global_tool_id)

    await _commit_page(
        manager,
        _page(
            [],
            retirements=[
                ToolingProjectionRetirement(
                    global_tool_id=tool.global_tool_id,
                    availability="unshared",
                    reason_code="provider_policy_unshared",
                )
            ],
            revision="revision-h1-2",
        ),
        sync_id="h1-unshare-sync-0002",
        base_generation=1,
    )

    after_first_restart = DatabaseManager(db_path)
    await after_first_restart.initialize()
    inactive = await after_first_restart.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=True)
    )
    assert [(row.tool.global_tool_id, row.availability) for row in inactive.tools] == [
        (tool.global_tool_id, "unshared")
    ]
    active = await after_first_restart.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=False)
    )
    assert active.tools == []
    grants = _read_lifecycle_grants(db_path)
    assert grants["grant-allow-a"]["active"] == 1
    assert grants["grant-deny-b"]["active"] == 1
    assert grants["grant-consumed-once"]["active"] == 0
    execution_service = _service_for_remote_denial(tool)
    execution_service._load_normalized_bindable_remote_catalogs = AsyncMock(return_value=[])
    denied_while_unshared = await execution_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(
            tool_name=tool.global_tool_id,
            arguments={},
            caller_principal_id="principal-a",
            mesh_selector=MeshAddressSelector(
                peer_id="provider",
                service_instance_id="remote:provider:Tooling",
            ),
        )
    )
    assert not denied_while_unshared.ok
    execution_service._remote_catalog_snapshots = {
        key: (snapshot.model_copy(update={"shared_by_policy": False}), updated_at)
        for key, (snapshot, updated_at) in execution_service._remote_catalog_snapshots.items()
    }
    prepared = _prepared_remote(tool)
    allow = execution_service._grant_from_row(grants["grant-allow-a"])
    deny = execution_service._grant_from_row(grants["grant-deny-b"])
    consumed = execution_service._grant_from_row(grants["grant-consumed-once"])
    assert execution_service._grant_matches_prepared(
        allow,
        ToolingExecuteToolRequest(
            tool_name=tool.global_tool_id,
            arguments={},
            caller_principal_id="principal-a",
        ),
        prepared,
    )
    assert execution_service._grant_matches_prepared(
        deny,
        ToolingExecuteToolRequest(
            tool_name=tool.global_tool_id,
            arguments={},
            caller_principal_id="principal-b",
        ),
        prepared,
        allow_blocked=True,
    )
    assert not execution_service._grant_matches_prepared(
        consumed,
        ToolingExecuteToolRequest(
            tool_name=tool.global_tool_id,
            arguments={},
            caller_principal_id="principal-c",
        ),
        prepared,
    )

    await _commit_page(
        after_first_restart,
        _page([tool], revision="revision-h1-3"),
        sync_id="h1-reshare-sync-0003",
        base_generation=2,
    )
    after_second_restart = DatabaseManager(db_path)
    await after_second_restart.initialize()
    restored = await after_second_restart.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=False)
    )
    assert [row.tool.global_tool_id for row in restored.tools] == [tool.global_tool_id]
    grants = _read_lifecycle_grants(db_path)
    assert grants["grant-allow-a"]["global_tool_id"] == tool.global_tool_id
    assert grants["grant-deny-b"]["global_tool_id"] == tool.global_tool_id
    assert grants["grant-allow-a"]["active"] == 1
    assert grants["grant-deny-b"]["active"] == 1
    assert grants["grant-consumed-once"]["active"] == 0


@pytest.mark.integration
@pytest.mark.asyncio
async def test_schema_review_survives_offline_restart_and_requires_fresh_projection(
    tmp_path,
) -> None:
    """H2: schema drift reviews metadata without reviving positive authority."""

    db_path = str(tmp_path / "g014-h2.db")
    manager = DatabaseManager(db_path)
    await manager.initialize()
    v1 = _tool("alpha").model_copy(
        update={
            "args_schema": {"type": "object", "properties": {"v": {"const": 1}}},
            "schema": {"type": "object", "properties": {"v": {"const": 1}}},
        }
    )
    await _commit_page(
        manager,
        _page([v1], revision="revision-h2-1"),
        sync_id="h2-initial-sync-0001",
        base_generation=0,
    )
    _insert_lifecycle_grants(db_path, v1.global_tool_id)
    v2 = v1.model_copy(
        update={
            "args_schema": {"type": "object", "properties": {"v": {"const": 2}}},
            "schema": {"type": "object", "properties": {"v": {"const": 2}}},
        }
    )
    await _commit_page(
        manager,
        _page([v2], revision="revision-h2-2"),
        sync_id="h2-schema-sync-0002",
        base_generation=1,
    )
    changed = await manager.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=True)
    )
    changed_tool = changed.tools[0]
    assert changed_tool.availability == "schema_changed"
    assert changed_tool.review_required is True
    assert changed_tool.schema_hash != changed_tool.accepted_schema_hash
    grants = _read_lifecycle_grants(db_path)
    assert json.loads(str(grants["grant-allow-a"]["metadata_json"]))["needs_review"] is True
    assert json.loads(str(grants["grant-deny-b"]["metadata_json"])).get("needs_review") is not True
    execution_service = _service_for_remote_denial(v2)
    prepared = _prepared_remote(v2)
    assert not execution_service._grant_matches_prepared(
        execution_service._grant_from_row(grants["grant-allow-a"]),
        ToolingExecuteToolRequest(
            tool_name=v2.global_tool_id,
            arguments={},
            caller_principal_id="principal-a",
        ),
        prepared,
    )
    assert execution_service._grant_matches_prepared(
        execution_service._grant_from_row(grants["grant-deny-b"]),
        ToolingExecuteToolRequest(
            tool_name=v2.global_tool_id,
            arguments={},
            caller_principal_id="principal-b",
        ),
        prepared,
        allow_blocked=True,
    )

    accepted = await manager.accept_tooling_remote_tool_schema(
        DBAcceptToolingRemoteToolSchemaRequest(
            peer_id="provider",
            provider_id="provider",
            global_tool_id=v2.global_tool_id,
            expected_projection_revision="revision-h2-2",
            expected_schema_hash=changed_tool.schema_hash,
            actor_principal_id="admin",
            reason="Reviewed exact v2 schema",
        )
    )
    assert accepted.ok and accepted.changed
    unavailable = await manager.set_tooling_remote_provider_availability(
        DBSetToolingRemoteProviderAvailabilityRequest(
            peer_id="provider",
            provider_id="provider",
            availability="provider_unavailable",
            reason_code="provider_disconnected",
            expected_generation=2,
            expected_projection_revision="revision-h2-2",
        )
    )
    assert unavailable.ok

    restarted = DatabaseManager(db_path)
    await restarted.initialize()
    offline = await restarted.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=True)
    )
    assert offline.headers[0].availability == "provider_unavailable"
    assert offline.tools[0].accepted_schema_hash == offline.tools[0].schema_hash
    assert (
        await restarted.get_tooling_remote_catalog(
            DBGetToolingRemoteCatalogRequest(include_inactive=False)
        )
    ).tools == []
    consumer = _service_for_remote_denial(v2)
    consumer._load_normalized_bindable_remote_catalogs = (
        ToolingService._load_normalized_bindable_remote_catalogs.__get__(consumer, ToolingService)
    )
    consumer._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            mesh_switches=ToolingMeshKillSwitches(consumer_mesh_tooling_enabled=True)
        )
    )

    async def db_request(topic, payload, **kwargs):
        if topic == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(
                ok=True,
                data=await restarted.get_tooling_remote_catalog(payload),
            )
        return QueryResult(ok=False, error=topic)

    consumer.bus.request = AsyncMock(side_effect=db_request)
    assert await consumer._load_normalized_bindable_remote_catalogs() == []

    await _commit_page(
        restarted,
        _page([v2], revision="revision-h2-3"),
        sync_id="h2-restore-sync-0003",
        base_generation=2,
    )
    restored = await restarted.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=False)
    )
    assert [row.tool.global_tool_id for row in restored.tools] == [v2.global_tool_id]
    bindable = await consumer._load_normalized_bindable_remote_catalogs()
    assert [tool.global_tool_id for snapshot in bindable for tool in snapshot.tools] == [
        v2.global_tool_id
    ]
    grants = _read_lifecycle_grants(db_path)
    assert json.loads(str(grants["grant-allow-a"]["metadata_json"]))["needs_review"] is True
    assert grants["grant-deny-b"]["active"] == 1
    assert grants["grant-consumed-once"]["active"] == 0


@pytest.mark.integration
@pytest.mark.asyncio
async def test_pruned_tombstone_remains_management_visible_and_never_binds(tmp_path) -> None:
    """H3: compacted last-known metadata is management-only across restart."""

    db_path = str(tmp_path / "g014-tombstone.db")
    manager = DatabaseManager(db_path)
    await manager.initialize()
    tool = _tool("retained").model_copy(
        update={
            "share_group_id": "core:retained",
            "share_group_label": "Retained tools",
            "source": "mcp",
            "source_id": "mcp:documents",
            "provenance": _tool("retained").provenance.model_copy(
                update={
                    "source": "mcp",
                    "stable_source_id": "mcp:documents",
                    "provider_tool_id": "documents/search",
                }
            ),
        }
    )
    await _commit_page(
        manager,
        _page([tool], revision="revision-tombstone-1"),
        sync_id="tombstone-sync-0001",
        base_generation=0,
    )
    await _commit_page(
        manager,
        _page(
            [],
            retirements=[
                ToolingProjectionRetirement(
                    global_tool_id=tool.global_tool_id,
                    availability="removed",
                    reason_code="provider_tool_removed",
                )
            ],
            revision="revision-tombstone-2",
        ),
        sync_id="tombstone-sync-0002",
        base_generation=1,
    )
    with sqlite3.connect(db_path) as connection:
        connection.execute("UPDATE tooling_remote_catalog_tools SET updated_at=0")
        connection.commit()
    pruned = await manager.prune_tooling_remote_catalog_retention(
        DBPruneToolingRemoteCatalogRetentionRequest(
            now=10000,
            removed_stale_ttl_seconds=3600,
            max_retained_per_provider=16,
            max_audit_rows_per_provider=32,
        )
    )
    assert pruned.compacted_tool_count == 1

    restarted = DatabaseManager(db_path)
    await restarted.initialize()
    catalog = await restarted.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=True)
    )
    assert catalog.tools == []
    assert len(catalog.retained_tombstones) == 1
    tombstone = catalog.retained_tombstones[0]
    assert tombstone.global_tool_id == tool.global_tool_id
    assert tombstone.management_metadata["local_name"] == "retained"
    assert "args_schema" not in tombstone.management_metadata

    service = _service_for_remote_denial(tool)
    service._load_normalized_bindable_remote_catalogs = (
        ToolingService._load_normalized_bindable_remote_catalogs.__get__(service, ToolingService)
    )
    service._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            mesh_switches=ToolingMeshKillSwitches(consumer_mesh_tooling_enabled=True)
        )
    )

    async def db_request(topic, payload, **kwargs):
        if topic == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(
                ok=True,
                data=await restarted.get_tooling_remote_catalog(payload),
            )
        return QueryResult(ok=False, error=topic)

    service.bus.request = AsyncMock(side_effect=db_request)
    service._refresh_peer_display_names = AsyncMock()
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
    service._active_grants_for_read_models = AsyncMock(return_value=[])
    service._pending_approvals_for_read_models = AsyncMock(return_value=[])

    bindable = await service._load_normalized_bindable_remote_catalogs()
    assert [tool for snapshot in bindable for tool in snapshot.tools] == []
    sources = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    source = next(item for item in sources.sources if item.provider_peer_id == "provider")
    assert source.tool_count == 0
    assert source.retained_tool_count == 1
    assert source.availability_counts == {"removed": 1}
    detail = await service._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id=source.source_id)
    )
    assert detail.tools == []
    assert detail.blocked_tools == []
    assert len(detail.retained_tools) == 1
    retained = detail.retained_tools[0]
    assert retained.tool is None
    assert retained.global_tool_id == tool.global_tool_id
    assert retained.local_tool_name == "retained"
    assert retained.share_group_id == "core:retained"
    assert retained.retained_source_id == "mcp:documents"
    assert retained.provider_tool_id == "documents/search"
    llm_tools, bindings = build_tool_bindings(
        [item.tool.model_dump(mode="python") for item in detail.retained_tools if item.tool]
    )
    assert llm_tools == []
    assert bindings == {}


def _service_for_remote_denial(tool: ToolingToolInfo) -> ToolingService:
    with patch("app.services.tooling.service.ToolsManager") as manager_type:
        manager = Mock()
        manager.get_all_tool_names.return_value = [tool.local_name]
        local_tool = Mock()
        local_tool.name = tool.local_name
        local_tool.source = "core"
        local_tool.safety_class = "standard"
        local_tool.required_permissions = []
        manager.get_tool_by_name.return_value = local_tool
        manager_type.return_value = manager
        service = ToolingService()
    service.tools_manager = manager
    service.bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"resolved": {}}))
    service._mesh_projection_enforcement_active = True
    service._stable_peer_id = "consumer"
    snapshot = ToolingRemoteCatalogAnnounced(
        peer_id="provider",
        provider_id="provider",
        service_instance_id="remote:provider:Tooling",
        catalog_epoch=1,
        generated_at="2026-07-14T00:00:00Z",
        full_schema_hash="a" * 64,
        tools=[
            tool.model_copy(update={"source_type": "mesh_peer", "execution_location": "remote"})
        ],
        selected_protocol_tier="projection_v1",
    )
    service._load_normalized_bindable_remote_catalogs = AsyncMock(return_value=[snapshot])
    service._remote_tooling_candidates = Mock(return_value=[])
    service._audit_tool_execution = AsyncMock()
    return service


@pytest.mark.integration
@pytest.mark.asyncio
async def test_stale_cached_prepare_and_execute_require_fresh_verified_baseline() -> None:
    tool = _tool("alpha")
    service = _service_for_remote_denial(tool)
    selector = MeshAddressSelector(
        peer_id="provider",
        service_instance_id="remote:provider:Tooling",
    )
    prepared = await service._on_prepare_execution(
        ToolingPrepareExecutionRequest(tool_name="alpha", arguments={}, mesh_selector=selector)
    )
    executed = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="alpha", arguments={}, mesh_selector=selector)
    )
    assert not prepared.ok and prepared.policy_decision.reason == "permission_denied"
    assert not executed.ok and executed.error_code == "permission_denied"
    retained_after_restart = await service._on_get_tool_by_name(
        ToolingGetToolByNameRequest(name="alpha", mesh_selector=selector)
    )
    assert not retained_after_restart.found and retained_after_restart.name == ""

    service._remote_tooling_candidates = Mock(
        return_value=[
            SimpleNamespace(
                eligible=True,
                peer=SimpleNamespace(peer_id="provider"),
                decision=SimpleNamespace(granted_permissions=["*"]),
            )
        ]
    )
    assert await service._consumer_mesh_execution_authorized(
        ToolingExecuteToolRequest(tool_name="alpha", arguments={}, mesh_selector=selector)
    )

    # A live route does not resurrect a tool removed by an unshare/policy
    # projection update; prepare and execute still fail before approval state.
    service._load_normalized_bindable_remote_catalogs = AsyncMock(return_value=[])
    unshared_prepare = await service._on_prepare_execution(
        ToolingPrepareExecutionRequest(tool_name="alpha", arguments={}, mesh_selector=selector)
    )
    unshared_execute = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="alpha", arguments={}, mesh_selector=selector)
    )
    assert not unshared_prepare.ok
    assert not unshared_execute.ok and unshared_execute.error_code == "permission_denied"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_consumer_switch_and_legacy_protocol_remain_nonbindable() -> None:
    tool = _tool("alpha")
    service = _service_for_remote_denial(tool)
    service._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            mesh_switches=ToolingMeshKillSwitches(consumer_mesh_tooling_enabled=False)
        )
    )
    service._load_normalized_bindable_remote_catalogs = (
        ToolingService._load_normalized_bindable_remote_catalogs.__get__(
            service,
            ToolingService,
        )
    )
    assert await service._load_normalized_bindable_remote_catalogs() == []

    legacy = select_tooling_protocol(
        SimpleNamespace(tooling_protocol_tiers=[]),
        manifest_status="verified",
    )
    unavailable = select_tooling_protocol(
        SimpleNamespace(tooling_protocol_tiers=["projection_v1"]),
        manifest_status="unavailable",
    )
    assert legacy.status == "protocol_unsupported" and not legacy.supported
    assert unavailable.status == "legacy_unverifiable" and not unavailable.supported

    disabled, _ = build_recipient_projection(
        [tool],
        context=ProjectionContext(
            recipient_peer_id="peer-a",
            recipient_permissions=("*",),
            authority_revision=AUTHORITY,
            provider_enabled=False,
        ),
        policy=ToolingExportPolicy(default_state="shared", initialized=True),
        rules=[],
    )
    assert disabled == []


@pytest.mark.integration
@pytest.mark.parametrize(
    ("context_updates", "permissions"),
    [
        ({"provider_enabled": False}, ("*",)),
        ({"service_exported": False}, ("*",)),
        ({"discovery_exported": False}, ("*",)),
        ({"execution_exported": False}, ("*",)),
        ({}, ("Tooling.GetTools",)),
    ],
)
def test_each_provider_projection_gate_independently_fails_closed(
    context_updates: dict, permissions: tuple[str, ...]
) -> None:
    tool = _tool("five-gate")
    context = ProjectionContext(
        recipient_peer_id="peer-a",
        recipient_permissions=permissions,
        authority_revision=AUTHORITY,
        **context_updates,
    )
    visible, _ = build_recipient_projection(
        [tool],
        context=context,
        policy=ToolingExportPolicy(default_state="shared", initialized=True),
        rules=[],
    )
    assert visible == []
