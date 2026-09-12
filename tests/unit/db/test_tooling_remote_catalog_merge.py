"""G013 normalized Tooling projection staging and atomic promotion tests."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import aiosqlite
import pytest

from app.services.db.manager import DatabaseManager
from app.services.db.service import _protected_authority_write_error
from app.services.db.tooling_remote_catalog_store import (
    compute_projection_checksum,
    compute_projection_page_hash,
)
from app.shared.contracts.models.db import (
    DBAcceptToolingRemoteToolSchemaRequest,
    DBActivateToolingMeshEnforcementRequest,
    DBAppendToolingRemoteCatalogPageRequest,
    DBBeginToolingRemoteCatalogSyncRequest,
    DBCommitToolingRemoteCatalogSyncRequest,
    DBGetToolingExposureLedgerRequest,
    DBGetToolingRemoteCatalogRequest,
    DBImportLegacyToolingRemoteCatalogsRequest,
    DBRecordToolingExposuresRequest,
    DBSetToolingRemoteProviderAvailabilityRequest,
    DBToolingExposureLedgerEntry,
    DBToolingMeshActivationComponentVersions,
)
from app.shared.contracts.models.tooling import (
    ToolingGetExportCatalogResponse,
    ToolingProjectionAuthorityRevision,
    ToolingProjectionBlockedTool,
    ToolingProjectionRetirement,
    ToolingToolInfo,
    ToolingToolProvenance,
)

AUTHORITY = ToolingProjectionAuthorityRevision(
    catalog_revision=11,
    export_policy_revision=12,
    auth_grant_revision=13,
    manifest_revision=14,
    switch_revision=15,
)

ACTIVATION_COMPONENTS = DBToolingMeshActivationComponentVersions(
    projection_transport=2,
    targeted_invalidation=2,
    normalized_catalog=2,
    consumer_binding=2,
    provider_discovery=2,
    prepare_enforcement=2,
    execute_enforcement=2,
    typed_exposure_ledger=1,
    inbound_sync_bridge=1,
    execution_rpc_evidence=1,
    exact_method_set=1,
    mutation_invalidation=1,
    conditional_legacy_retirement=1,
    startup_downgrade_guard=1,
)
PROVIDER_PEER_ID = "peer-a"
PROVIDER_SERVICE_INSTANCE_ID = "local:peer-a:Tooling"


async def _manager(tmp_path: Path, name: str = "projection.db") -> DatabaseManager:
    manager = DatabaseManager(str(tmp_path / name))
    await manager.initialize()
    return manager


def _tool(name: str, *, schema_version: int = 1) -> ToolingToolInfo:
    peer = PROVIDER_PEER_ID
    service = PROVIDER_SERVICE_INSTANCE_ID
    return ToolingToolInfo(
        name=name,
        local_name=name,
        global_tool_id=f"aurora-tool:v1:{peer}:Tooling:{name}",
        tool_id_scheme="aurora-tool",
        tool_id_version=1,
        tool_contract_id=name,
        share_group_id="core:test",
        share_group_label="Test",
        exportable=True,
        provider_peer_id=peer,
        provider_service_instance_id=service,
        namespace="peer_a",
        display_name=f"peer-a.{name}",
        args_schema={"type": "object", "properties": {"v": {"const": schema_version}}},
        schema={"type": "object", "properties": {"v": {"const": schema_version}}},
        source_type="local",
        source="core",
        execution_location="local",
        provenance=ToolingToolProvenance(
            provider_peer_id=peer,
            provider_service_instance_id=service,
            provider_kind="local",
            source="core",
            advertised_name=name,
        ),
    )


def _page(
    tools: list[ToolingToolInfo],
    *,
    blocked_tools: list[ToolingProjectionBlockedTool] | None = None,
    retirements: list[ToolingProjectionRetirement] | None = None,
    page_index: int = 0,
    complete: bool = True,
    next_cursor: str | None = None,
    revision: str = "revision-1",
) -> ToolingGetExportCatalogResponse:
    blocked_tools = blocked_tools or []
    retirements = retirements or []
    checksum = compute_projection_checksum(tools, retirements, blocked_tools)
    page = ToolingGetExportCatalogResponse(
        provider_peer_id=PROVIDER_PEER_ID,
        service_instance_id=PROVIDER_SERVICE_INSTANCE_ID,
        authority_revision=AUTHORITY,
        projection_revision=revision,
        projection_digest=checksum,
        page_index=page_index,
        page_size=2,
        page_hash="0" * 64,
        tools=tools,
        blocked_tools=blocked_tools,
        retirements=retirements,
        next_cursor=next_cursor,
        complete=complete,
        total_count=(len(tools) + len(blocked_tools)) if complete else None,
        final_checksum=checksum if complete else None,
    )
    return page.model_copy(update={"page_hash": compute_projection_page_hash(page)})


async def _begin(
    manager: DatabaseManager, sync_id: str, page: ToolingGetExportCatalogResponse, base: int = 0
):
    return await manager.begin_tooling_remote_catalog_sync(
        DBBeginToolingRemoteCatalogSyncRequest(
            sync_id=sync_id,
            peer_id=PROVIDER_PEER_ID,
            provider_id="provider-a",
            service_instance_id=PROVIDER_SERVICE_INSTANCE_ID,
            projection_revision=page.projection_revision,
            projection_digest=page.projection_digest,
            authority_revision=AUTHORITY,
            page_size=page.page_size,
            expected_base_generation=base,
        )
    )


@pytest.mark.asyncio
async def test_migration_015_and_raw_sql_protection(tmp_path: Path) -> None:
    manager = await _manager(tmp_path)
    async with aiosqlite.connect(manager.db_path) as db:
        tables = {
            row[0]
            for row in await (
                await db.execute("SELECT name FROM sqlite_master WHERE type='table'")
            ).fetchall()
        }
    assert {
        "tooling_remote_catalog_headers",
        "tooling_remote_catalog_tools",
        "tooling_remote_catalog_syncs",
        "tooling_remote_catalog_stage_pages",
        "tooling_remote_catalog_stage_tools",
        "tooling_remote_catalog_stage_retirements",
        "tooling_tool_exposure_ledger",
        "tooling_remote_catalog_audit",
        "tooling_mesh_activation_state",
        "tooling_mesh_activation_audit",
    } <= tables
    protected = {
        "tooling_remote_catalog_headers",
        "tooling_remote_catalog_tools",
        "tooling_remote_catalog_syncs",
        "tooling_remote_catalog_stage_pages",
        "tooling_remote_catalog_stage_tools",
        "tooling_remote_catalog_stage_retirements",
        "tooling_remote_catalog_audit",
        "tooling_tool_exposure_ledger",
        "tooling_mesh_activation_state",
        "tooling_mesh_activation_audit",
    }
    for table in sorted(protected):
        assert _protected_authority_write_error(f"DELETE FROM {table}") is not None


@pytest.mark.asyncio
async def test_migration_018_quarantines_unsafe_legacy_authority_revisions(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "unsafe-legacy-revision.db")
    committed_page = _page([_tool("legacy-unsafe")], revision="legacy-unsafe")
    assert (await _begin(manager, "sync-legacy-committed", committed_page)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(
                sync_id="sync-legacy-committed",
                page=committed_page,
            )
        )
    ).ok
    assert (
        await manager.commit_tooling_remote_catalog_sync(
            DBCommitToolingRemoteCatalogSyncRequest(
                sync_id="sync-legacy-committed",
                expected_base_generation=0,
            )
        )
    ).ok

    staged_page = _page(
        [_tool("legacy-staged")],
        complete=False,
        next_cursor="next-page",
        revision="legacy-staged",
    )
    assert (await _begin(manager, "sync-legacy-staged", staged_page, base=1)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(
                sync_id="sync-legacy-staged",
                page=staged_page,
            )
        )
    ).ok

    unsafe_revision = 1_103_051_928_452_846_181
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute("DELETE FROM migrations WHERE version='018'")
        await db.execute(
            """UPDATE tooling_remote_catalog_headers
               SET catalog_revision=?
               WHERE peer_id=? AND provider_id='provider-a'""",
            (unsafe_revision, PROVIDER_PEER_ID),
        )
        await db.execute(
            """UPDATE tooling_remote_catalog_tools
               SET catalog_revision=?
               WHERE peer_id=? AND provider_id='provider-a'""",
            (unsafe_revision, PROVIDER_PEER_ID),
        )
        await db.execute(
            "UPDATE tooling_remote_catalog_syncs SET catalog_revision=? WHERE sync_id=?",
            (unsafe_revision, "sync-legacy-staged"),
        )
        await db.commit()

    restarted = DatabaseManager(manager.db_path)
    await restarted.initialize()
    retained = await restarted.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=True)
    )
    assert retained.headers[0].authority_revision.catalog_revision == 0
    assert retained.headers[0].current_generation == 0
    assert retained.headers[0].sync_state == "failed"
    assert retained.headers[0].availability == "stale"
    assert retained.headers[0].last_error_reason == "unsafe_legacy_authority_revision"
    assert retained.tools[0].authority_revision.catalog_revision == 0
    assert retained.tools[0].availability == "stale"
    assert retained.tools[0].active_generation is None
    assert retained.tools[0].reason_code == "unsafe_legacy_authority_revision"
    assert retained.tools[0].review_required
    active = await restarted.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=False)
    )
    assert active.tools == []

    async with aiosqlite.connect(manager.db_path) as db:
        assert (
            await (
                await db.execute(
                    "SELECT COUNT(*) FROM tooling_remote_catalog_syncs WHERE sync_id=?",
                    ("sync-legacy-staged",),
                )
            ).fetchone()
        )[0] == 0
        for table in (
            "tooling_remote_catalog_stage_pages",
            "tooling_remote_catalog_stage_tools",
            "tooling_remote_catalog_stage_retirements",
        ):
            assert (
                await (
                    await db.execute(
                        f"SELECT COUNT(*) FROM {table} WHERE sync_id=?",
                        ("sync-legacy-staged",),
                    )
                ).fetchone()
            )[0] == 0


@pytest.mark.asyncio
async def test_first_sync_retains_permission_blocked_definition_without_binding(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "first-sync-blocked.db")
    blocked_tool = _tool("speak")
    page = _page(
        [],
        blocked_tools=[
            ToolingProjectionBlockedTool(
                tool=blocked_tool,
                reason_code="recipient_missing_tool_permissions",
                missing_permissions=["TTS.Request"],
            )
        ],
    )
    assert (await _begin(manager, "sync-first-blocked-0001", page)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(
                sync_id="sync-first-blocked-0001",
                page=page,
            )
        )
    ).ok
    committed = await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id="sync-first-blocked-0001",
            expected_base_generation=0,
        )
    )
    assert committed.ok
    assert committed.tools[0].availability == "permission_blocked"
    assert committed.tools[0].missing_permissions == ["TTS.Request"]
    assert (
        await manager.get_tooling_remote_catalog(
            DBGetToolingRemoteCatalogRequest(include_inactive=False)
        )
    ).tools == []


@pytest.mark.asyncio
async def test_typed_exposure_ledger_persists_upserts_and_isolates_recipients(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "exposure-ledger.db")
    first_hash = "a" * 64
    updated_hash = "b" * 64
    tool_id = "aurora-tool:v1:provider:Tooling:list_tasks"

    recorded = await manager.record_tooling_exposures(
        DBRecordToolingExposuresRequest(
            recipient_peer_id="peer-a",
            provider_id="provider",
            entries=[
                DBToolingExposureLedgerEntry(
                    global_tool_id=tool_id,
                    last_schema_hash=first_hash,
                )
            ],
        )
    )
    assert recorded.recorded_count == 1
    await manager.record_tooling_exposures(
        DBRecordToolingExposuresRequest(
            recipient_peer_id="peer-a",
            provider_id="provider",
            entries=[
                DBToolingExposureLedgerEntry(
                    global_tool_id=tool_id,
                    last_schema_hash=updated_hash,
                )
            ],
        )
    )

    ledger = await manager.get_tooling_exposure_ledger(
        DBGetToolingExposureLedgerRequest(
            recipient_peer_id="peer-a",
            provider_id="provider",
        )
    )
    assert [(entry.global_tool_id, entry.last_schema_hash) for entry in ledger.entries] == [
        (tool_id, updated_hash)
    ]
    other = await manager.get_tooling_exposure_ledger(
        DBGetToolingExposureLedgerRequest(
            recipient_peer_id="peer-b",
            provider_id="provider",
        )
    )
    assert other.entries == []


@pytest.mark.asyncio
async def test_tooling_mesh_activation_is_durable_idempotent_and_audited_once(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "activation.db")
    initial = (await manager.get_tooling_mesh_activation_state()).state
    assert not initial.active and not initial.legacy_guard_retired and initial.revision == 0

    request = DBActivateToolingMeshEnforcementRequest(
        expected_revision=0,
        component_schema_versions=ACTIVATION_COMPONENTS,
        actor_principal_id="system:g013-activation",
        reason="all G013 enforcement components verified",
        correlation_id="activate-g013",
    )
    activated = await manager.activate_tooling_mesh_enforcement(request)
    assert activated.ok and activated.changed and activated.revision == 1
    assert activated.state.active and activated.state.legacy_guard_retired
    assert activated.state.audit_id and activated.state.activated_at

    repeated = await manager.activate_tooling_mesh_enforcement(request)
    assert (
        repeated.ok and not repeated.changed and repeated.state.audit_id == activated.state.audit_id
    )

    restarted = DatabaseManager(manager.db_path)
    await restarted.initialize()
    durable = (await restarted.get_tooling_mesh_activation_state()).state
    assert durable == activated.state
    async with aiosqlite.connect(manager.db_path) as db:
        audit_count = (
            await (
                await db.execute("SELECT COUNT(*) FROM tooling_mesh_activation_audit")
            ).fetchone()
        )[0]
    assert audit_count == 1


@pytest.mark.asyncio
async def test_tooling_mesh_activation_fails_closed_on_partial_or_stale_readiness(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "activation-not-ready.db")
    partial = ACTIVATION_COMPONENTS.model_copy(update={"execute_enforcement": 0})
    rejected = await manager.activate_tooling_mesh_enforcement(
        DBActivateToolingMeshEnforcementRequest(
            expected_revision=0,
            component_schema_versions=partial,
            actor_principal_id="system:g013-activation",
            reason="partial readiness must not activate",
        )
    )
    assert not rejected.ok and rejected.error == "tooling_mesh_activation_components_not_ready"
    assert not rejected.state.active and not rejected.state.legacy_guard_retired

    stale = await manager.activate_tooling_mesh_enforcement(
        DBActivateToolingMeshEnforcementRequest(
            expected_revision=1,
            component_schema_versions=ACTIVATION_COMPONENTS,
            actor_principal_id="system:g013-activation",
            reason="stale CAS must not activate",
        )
    )
    assert not stale.ok and stale.error == "tooling_mesh_activation_revision_conflict"
    assert (await manager.get_tooling_mesh_activation_state()).state.revision == 0


@pytest.mark.asyncio
async def test_tooling_mesh_activation_rolls_back_audit_when_singleton_update_fails(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "activation-rollback.db")
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute(
            """CREATE TRIGGER fail_tooling_mesh_activation
               BEFORE UPDATE ON tooling_mesh_activation_state
               BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END"""
        )
        await db.commit()
    with pytest.raises(aiosqlite.DatabaseError, match="injected activation failure"):
        await manager.activate_tooling_mesh_enforcement(
            DBActivateToolingMeshEnforcementRequest(
                expected_revision=0,
                component_schema_versions=ACTIVATION_COMPONENTS,
                actor_principal_id="system:g013-activation",
                reason="rollback injection",
            )
        )
    state = (await manager.get_tooling_mesh_activation_state()).state
    assert not state.active and state.revision == 0 and state.audit_id is None
    async with aiosqlite.connect(manager.db_path) as db:
        assert (
            await (
                await db.execute("SELECT COUNT(*) FROM tooling_mesh_activation_audit")
            ).fetchone()
        )[0] == 0


@pytest.mark.asyncio
async def test_staged_page_is_non_bindable_and_complete_snapshot_promotes_atomically(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path)
    page = _page([_tool("alpha"), _tool("beta")])
    assert (await _begin(manager, "sync-000000000001", page)).ok
    appended = await manager.append_tooling_remote_catalog_page(
        DBAppendToolingRemoteCatalogPageRequest(sync_id="sync-000000000001", page=page)
    )
    assert appended.ok and appended.complete
    before = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert before.tools == []
    committed = await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id="sync-000000000001", expected_base_generation=0
        )
    )
    assert committed.ok and committed.generation == 1
    assert {item.tool.local_name for item in committed.tools if item.availability == "active"} == {
        "alpha",
        "beta",
    }


@pytest.mark.asyncio
async def test_optimistic_generation_race_rejects_older_commit(tmp_path: Path) -> None:
    manager = await _manager(tmp_path)
    fast = _page([_tool("fast")], revision="revision-fast")
    slow = _page([_tool("slow")], revision="revision-slow")
    assert (await _begin(manager, "sync-fast-0000001", fast)).ok
    assert (await _begin(manager, "sync-slow-0000001", slow)).ok
    for sync_id, page in (("sync-fast-0000001", fast), ("sync-slow-0000001", slow)):
        assert (
            await manager.append_tooling_remote_catalog_page(
                DBAppendToolingRemoteCatalogPageRequest(sync_id=sync_id, page=page)
            )
        ).ok
    assert (
        await manager.commit_tooling_remote_catalog_sync(
            DBCommitToolingRemoteCatalogSyncRequest(
                sync_id="sync-fast-0000001", expected_base_generation=0
            )
        )
    ).ok
    stale = await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id="sync-slow-0000001", expected_base_generation=0
        )
    )
    assert not stale.ok and stale.error == "remote_catalog_generation_conflict"
    active = await manager.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=False)
    )
    assert [item.tool.local_name for item in active.tools] == ["fast"]


@pytest.mark.asyncio
async def test_availability_retirements_omissions_and_schema_change_are_distinct(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path)
    first = _page([_tool("keep"), _tool("deny"), _tool("omit"), _tool("schema")])
    assert (await _begin(manager, "sync-first-000001", first)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(sync_id="sync-first-000001", page=first)
        )
    ).ok
    assert (
        await manager.commit_tooling_remote_catalog_sync(
            DBCommitToolingRemoteCatalogSyncRequest(
                sync_id="sync-first-000001", expected_base_generation=0
            )
        )
    ).ok

    retire = ToolingProjectionRetirement(
        global_tool_id=_tool("deny").global_tool_id,
        availability="permission_blocked",
        reason_code="rbac_revoked",
    )
    second = _page(
        [_tool("keep"), _tool("schema", schema_version=2)],
        retirements=[retire],
        revision="revision-2",
    )
    assert (await _begin(manager, "sync-second-00001", second, 1)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(sync_id="sync-second-00001", page=second)
        )
    ).ok
    committed = await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id="sync-second-00001", expected_base_generation=1
        )
    )
    states = {item.tool.local_name: item.availability for item in committed.tools}
    assert states == {
        "deny": "permission_blocked",
        "keep": "active",
        "omit": "stale",
        "schema": "schema_changed",
    }
    schema_row = next(item for item in committed.tools if item.tool.local_name == "schema")
    assert schema_row.review_required and schema_row.active_generation is None

    # Seeing the same unreviewed schema in another verified generation must not
    # self-clear review_required merely because metadata_json was updated.
    third = _page(
        [_tool("keep"), _tool("schema", schema_version=2)],
        revision="revision-3",
    )
    assert (await _begin(manager, "sync-third-000001", third, 2)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(sync_id="sync-third-000001", page=third)
        )
    ).ok
    recommitted = await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id="sync-third-000001", expected_base_generation=2
        )
    )
    schema_row = next(item for item in recommitted.tools if item.tool.local_name == "schema")
    assert schema_row.availability == "schema_changed" and schema_row.review_required
    assert schema_row.accepted_schema_hash != schema_row.schema_hash

    conflict = await manager.accept_tooling_remote_tool_schema(
        DBAcceptToolingRemoteToolSchemaRequest(
            peer_id="peer-a",
            provider_id="provider-a",
            global_tool_id=schema_row.tool.global_tool_id,
            expected_projection_revision="revision-2",
            expected_schema_hash=schema_row.schema_hash,
            actor_principal_id="admin",
            reason="reviewed current remote schema",
        )
    )
    assert not conflict.ok and conflict.error == "remote_catalog_schema_acceptance_conflict"
    accepted = await manager.accept_tooling_remote_tool_schema(
        DBAcceptToolingRemoteToolSchemaRequest(
            peer_id="peer-a",
            provider_id="provider-a",
            global_tool_id=schema_row.tool.global_tool_id,
            expected_projection_revision="revision-3",
            expected_schema_hash=schema_row.schema_hash,
            actor_principal_id="admin",
            reason="reviewed current remote schema",
            correlation_id="schema-review",
        )
    )
    assert accepted.ok and accepted.changed and accepted.audit_id
    assert accepted.tool and accepted.tool.availability == "active"
    assert not accepted.tool.review_required
    assert accepted.tool.accepted_schema_hash == accepted.tool.schema_hash

    unavailable = await manager.set_tooling_remote_provider_availability(
        DBSetToolingRemoteProviderAvailabilityRequest(
            peer_id="peer-a",
            provider_id="provider-a",
            availability="provider_unavailable",
            reason_code="route_down",
        )
    )
    assert unavailable.ok and unavailable.header.availability == "provider_unavailable"
    assert not (
        await manager.get_tooling_remote_catalog(
            DBGetToolingRemoteCatalogRequest(include_inactive=False)
        )
    ).tools


@pytest.mark.asyncio
async def test_staged_pages_require_exact_cursor_chain_hash(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "cursor-chain.db")
    alpha, beta = _tool("alpha"), _tool("beta")
    checksum = compute_projection_checksum([alpha, beta], [])
    cursor = "opaque-cursor-from-provider"
    first = ToolingGetExportCatalogResponse(
        provider_peer_id=PROVIDER_PEER_ID,
        service_instance_id=PROVIDER_SERVICE_INSTANCE_ID,
        authority_revision=AUTHORITY,
        projection_revision="cursor-revision",
        projection_digest=checksum,
        page_index=0,
        page_size=1,
        page_hash="0" * 64,
        tools=[alpha],
        next_cursor=cursor,
    )
    first = first.model_copy(update={"page_hash": compute_projection_page_hash(first)})
    second = ToolingGetExportCatalogResponse(
        provider_peer_id=PROVIDER_PEER_ID,
        service_instance_id=PROVIDER_SERVICE_INSTANCE_ID,
        authority_revision=AUTHORITY,
        projection_revision="cursor-revision",
        projection_digest=checksum,
        page_index=1,
        page_size=1,
        page_hash="0" * 64,
        tools=[beta],
        complete=True,
        total_count=2,
        final_checksum=checksum,
    )
    second = second.model_copy(update={"page_hash": compute_projection_page_hash(second)})
    assert (await _begin(manager, "sync-cursor-chain-1", first)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(sync_id="sync-cursor-chain-1", page=first)
        )
    ).ok
    missing = await manager.append_tooling_remote_catalog_page(
        DBAppendToolingRemoteCatalogPageRequest(sync_id="sync-cursor-chain-1", page=second)
    )
    assert not missing.ok and missing.error == "remote_catalog_cursor_chain_mismatch"
    wrong = await manager.append_tooling_remote_catalog_page(
        DBAppendToolingRemoteCatalogPageRequest(
            sync_id="sync-cursor-chain-1", page=second, used_cursor_hash="0" * 64
        )
    )
    assert not wrong.ok and wrong.error == "remote_catalog_cursor_chain_mismatch"
    used_hash = hashlib.sha256(cursor.encode()).hexdigest()
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(
                sync_id="sync-cursor-chain-1", page=second, used_cursor_hash=used_hash
            )
        )
    ).ok
    committed = await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id="sync-cursor-chain-1", expected_base_generation=0
        )
    )
    assert committed.ok and {tool.tool.local_name for tool in committed.tools} == {
        "alpha",
        "beta",
    }


@pytest.mark.asyncio
async def test_unknown_retirement_and_checksum_failure_leave_old_generation_unchanged(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path)
    first = _page([_tool("known")])
    assert (await _begin(manager, "sync-known-000001", first)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(sync_id="sync-known-000001", page=first)
        )
    ).ok
    assert (
        await manager.commit_tooling_remote_catalog_sync(
            DBCommitToolingRemoteCatalogSyncRequest(
                sync_id="sync-known-000001", expected_base_generation=0
            )
        )
    ).ok
    retirement = ToolingProjectionRetirement(
        global_tool_id="never-exposed", availability="removed", reason_code="removed"
    )
    bad = _page([], retirements=[retirement], revision="revision-bad")
    assert (await _begin(manager, "sync-bad-00000001", bad, 1)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(sync_id="sync-bad-00000001", page=bad)
        )
    ).ok
    rejected = await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id="sync-bad-00000001", expected_base_generation=1
        )
    )
    assert not rejected.ok and rejected.error == "remote_catalog_unknown_retirement"
    active = await manager.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=False)
    )
    assert [item.tool.local_name for item in active.tools] == ["known"]
    assert active.headers[0].current_generation == 1


@pytest.mark.asyncio
async def test_legacy_json_import_is_stale_and_never_active(tmp_path: Path) -> None:
    manager = await _manager(tmp_path)
    legacy = _tool("legacy").model_copy(
        update={"exportable": False, "source_type": "mesh_peer", "execution_location": "remote"}
    )
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute(
            """INSERT INTO tooling_remote_catalog_snapshots (
                   peer_id, service_instance_id, provider_id, catalog_epoch,
                   generated_at, full_schema_hash, tools_json, updated_at
               ) VALUES (?, ?, ?, 1, 'now', ?, ?, 1.0)""",
            (
                "legacy-peer",
                "legacy-svc",
                "legacy-provider",
                "legacy-hash",
                json.dumps([legacy.model_dump(mode="json")]),
            ),
        )
        await db.commit()
    imported = await manager.import_legacy_tooling_remote_catalogs(
        DBImportLegacyToolingRemoteCatalogsRequest()
    )
    assert imported.imported_headers == imported.imported_tools == 1
    result = await manager.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(peer_id="legacy-peer")
    )
    assert result.headers[0].sync_state == "legacy_stale"
    assert result.headers[0].current_generation == 0
    assert result.tools[0].availability == "stale"
    assert (
        await manager.get_tooling_remote_catalog(
            DBGetToolingRemoteCatalogRequest(peer_id="legacy-peer", include_inactive=False)
        )
    ).tools == []


@pytest.mark.asyncio
async def test_mid_promotion_database_failure_rolls_back_header_and_all_tools(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path)
    page = _page([_tool("alpha"), _tool("beta")])
    assert (await _begin(manager, "sync-failure-0001", page)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(sync_id="sync-failure-0001", page=page)
        )
    ).ok
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute(
            """CREATE TRIGGER fail_beta_promotion
               BEFORE INSERT ON tooling_remote_catalog_tools
               WHEN NEW.global_tool_id LIKE '%:beta'
               BEGIN SELECT RAISE(ABORT, 'injected promotion failure'); END"""
        )
        await db.commit()
    with pytest.raises(aiosqlite.IntegrityError, match="injected promotion failure"):
        await manager.commit_tooling_remote_catalog_sync(
            DBCommitToolingRemoteCatalogSyncRequest(
                sync_id="sync-failure-0001", expected_base_generation=0
            )
        )
    result = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert result.tools == []
    assert result.headers[0].current_generation == 0
    assert result.headers[0].availability == "stale"
