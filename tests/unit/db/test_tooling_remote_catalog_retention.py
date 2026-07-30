"""G014 normalized remote Tooling lifecycle, recovery, alias, and retention tests."""

from __future__ import annotations

import json
from pathlib import Path

import aiosqlite
import pytest

from app.services.db.manager import DatabaseManager
from app.services.db.service import _protected_authority_write_error
from app.shared.contracts.models.db import (
    DBAppendToolingRemoteCatalogPageRequest,
    DBCommitToolingRemoteCatalogSyncRequest,
    DBFinalizeToolingRemoteCatalogPolicyRequest,
    DBGetToolingRemoteCatalogRequest,
    DBPruneToolingRemoteCatalogRetentionRequest,
    DBRecoverToolingRemoteCatalogsRequest,
    DBResolveToolingRemoteToolAliasesRequest,
    DBSetToolingRemoteProviderAvailabilityRequest,
)
from app.shared.contracts.models.tooling import ToolingProjectionRetirement
from tests.unit.db.test_tooling_remote_catalog_merge import (
    PROVIDER_SERVICE_INSTANCE_ID,
    _begin,
    _manager,
    _page,
    _tool,
)


async def _commit(
    manager: DatabaseManager,
    sync_id: str,
    tools,
    *,
    base: int,
    revision: str,
    retirements: list[ToolingProjectionRetirement] | None = None,
    defer_policy: bool = False,
):
    page = _page(tools, retirements=retirements, revision=revision)
    assert (await _begin(manager, sync_id, page, base=base)).ok
    assert (
        await manager.append_tooling_remote_catalog_page(
            DBAppendToolingRemoteCatalogPageRequest(sync_id=sync_id, page=page)
        )
    ).ok
    return await manager.commit_tooling_remote_catalog_sync(
        DBCommitToolingRemoteCatalogSyncRequest(
            sync_id=sync_id,
            expected_base_generation=base,
            defer_activation_for_policy_reconciliation=defer_policy,
            correlation_id=f"commit-{revision}",
        )
    )


@pytest.mark.asyncio
async def test_deferred_policy_commit_survives_restart_nonactive_until_finalize(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "policy-pending.db")
    committed = await _commit(
        manager,
        "sync-policy-pending-0001",
        [_tool("alpha")],
        base=0,
        revision="policy-v1",
        defer_policy=True,
    )
    assert committed.ok
    assert committed.header.availability == "stale"
    assert committed.header.last_error_reason == "policy_reconciliation_pending"
    assert committed.tools[0].availability == "stale"
    assert committed.tools[0].reason_code == "policy_reconciliation_pending"
    assert committed.tools[0].active_generation is None
    assert (
        await manager.get_tooling_remote_catalog(
            DBGetToolingRemoteCatalogRequest(include_inactive=False)
        )
    ).tools == []

    restarted = DatabaseManager(manager.db_path)
    await restarted.initialize()
    after_restart = await restarted.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=False)
    )
    assert after_restart.headers[0].availability == "stale"
    assert after_restart.headers[0].last_error_reason == "policy_reconciliation_pending"
    assert after_restart.tools == []

    conflict = await restarted.finalize_tooling_remote_catalog_policy(
        DBFinalizeToolingRemoteCatalogPolicyRequest(
            peer_id="peer-a",
            provider_id="provider-a",
            expected_generation=1,
            expected_projection_revision="wrong-revision",
        )
    )
    assert not conflict.ok
    assert conflict.error == "remote_catalog_policy_finalize_conflict"
    assert (
        await restarted.get_tooling_remote_catalog(
            DBGetToolingRemoteCatalogRequest(include_inactive=False)
        )
    ).tools == []

    finalized = await restarted.finalize_tooling_remote_catalog_policy(
        DBFinalizeToolingRemoteCatalogPolicyRequest(
            peer_id="peer-a",
            provider_id="provider-a",
            expected_generation=1,
            expected_projection_revision="policy-v1",
        )
    )
    assert finalized.ok and finalized.header.availability == "active"
    active = await restarted.get_tooling_remote_catalog(
        DBGetToolingRemoteCatalogRequest(include_inactive=False)
    )
    assert active.headers[0].availability == "active"
    assert active.tools[0].availability == "active"
    assert active.tools[0].active_generation == 1


@pytest.mark.asyncio
async def test_migration_016_tables_are_protected(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "migration-016.db")
    async with aiosqlite.connect(manager.db_path) as db:
        tables = {
            row[0]
            for row in await (
                await db.execute("SELECT name FROM sqlite_master WHERE type='table'")
            ).fetchall()
        }
    assert {
        "tooling_remote_tool_aliases",
        "tooling_remote_tool_identity_conflicts",
        "tooling_remote_catalog_retention_tombstones",
    } <= tables
    for table in (
        "tooling_remote_tool_aliases",
        "tooling_remote_tool_identity_conflicts",
        "tooling_remote_catalog_retention_tombstones",
    ):
        assert _protected_authority_write_error(f"DELETE FROM {table}") is not None


@pytest.mark.asyncio
async def test_startup_recovery_aborts_orphan_and_preserves_schema_cause(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "orphan.db")
    assert (
        await _commit(manager, "sync-recovery-0001", [_tool("alpha")], base=0, revision="v1")
    ).ok
    assert (
        await _commit(
            manager,
            "sync-recovery-0002",
            [_tool("alpha", schema_version=2)],
            base=1,
            revision="v2",
        )
    ).ok
    page = _page([_tool("alpha", schema_version=2)], revision="v3")
    assert (await _begin(manager, "sync-recovery-0003", page, base=2)).ok

    recovered = await manager.recover_tooling_remote_catalogs(
        DBRecoverToolingRemoteCatalogsRequest(
            now=1000,
            orphan_staging_ttl_seconds=60,
            correlation_id="startup-recovery",
        )
    )
    assert recovered.recovered_sync_ids == ["sync-recovery-0003"]
    assert recovered.providers_needing_sync == ["peer-a"]
    catalog = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert catalog.headers[0].sync_state == "failed"
    assert catalog.headers[0].availability == "stale"
    assert catalog.tools[0].availability == "schema_changed"
    assert catalog.tools[0].review_required
    async with aiosqlite.connect(manager.db_path) as db:
        assert (
            await (
                await db.execute(
                    "SELECT COUNT(*) FROM tooling_remote_catalog_syncs WHERE sync_id=?",
                    ("sync-recovery-0003",),
                )
            ).fetchone()
        )[0] == 0
        audit = await (
            await db.execute(
                "SELECT action, detail_reason FROM tooling_remote_catalog_audit WHERE action='orphan_sync_recovered'"
            )
        ).fetchone()
    assert audit == ("orphan_sync_recovered", "startup_sweep=all_staging")


@pytest.mark.asyncio
async def test_periodic_recovery_still_honors_orphan_ttl(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "orphan-periodic.db")
    page = _page([_tool("alpha")], revision="v1")
    assert (await _begin(manager, "sync-periodic-0001", page, base=0)).ok

    recent = await manager.recover_tooling_remote_catalogs(
        DBRecoverToolingRemoteCatalogsRequest(
            recover_all_staging=False,
            now=1000,
            orphan_staging_ttl_seconds=60,
        )
    )
    assert recent.recovered_sync_count == 0
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute(
            "UPDATE tooling_remote_catalog_syncs SET updated_at=900 WHERE sync_id=?",
            ("sync-periodic-0001",),
        )
        await db.commit()
    expired = await manager.recover_tooling_remote_catalogs(
        DBRecoverToolingRemoteCatalogsRequest(
            recover_all_staging=False,
            now=1000,
            orphan_staging_ttl_seconds=60,
        )
    )
    assert expired.recovered_sync_ids == ["sync-periodic-0001"]


@pytest.mark.asyncio
async def test_provider_unavailable_is_header_only_and_cas_guarded(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "availability.db")
    assert (
        await _commit(manager, "sync-available-0001", [_tool("alpha")], base=0, revision="v1")
    ).ok
    assert (
        await _commit(
            manager,
            "sync-available-0002",
            [_tool("alpha", schema_version=2)],
            base=1,
            revision="v2",
        )
    ).ok
    conflict = await manager.set_tooling_remote_provider_availability(
        DBSetToolingRemoteProviderAvailabilityRequest(
            peer_id="peer-a",
            provider_id="provider-a",
            availability="provider_unavailable",
            reason_code="route_lost",
            expected_generation=1,
        )
    )
    assert not conflict.ok and conflict.error == "remote_catalog_availability_conflict"
    changed = await manager.set_tooling_remote_provider_availability(
        DBSetToolingRemoteProviderAvailabilityRequest(
            peer_id="peer-a",
            provider_id="provider-a",
            availability="provider_unavailable",
            reason_code="route_lost",
            expected_generation=2,
            expected_projection_revision="v2",
        )
    )
    assert changed.ok and changed.header.availability == "provider_unavailable"
    inactive = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert inactive.tools[0].availability == "schema_changed"
    assert (
        await manager.get_tooling_remote_catalog(
            DBGetToolingRemoteCatalogRequest(include_inactive=False)
        )
    ).tools == []


@pytest.mark.asyncio
async def test_alias_rekey_is_provider_scoped_and_durable(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "alias.db")
    old = _tool("alpha")
    assert (await _commit(manager, "sync-alias-000001", [old], base=0, revision="v1")).ok
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute(
            """INSERT INTO tooling_approval_grants (
                   grant_id, grant_scope, grant_type, active, provider_peer_id,
                   provider_service_instance_id, global_tool_id, created_at, metadata_json
               ) VALUES ('grant-a', 'always', 'allow', 1, 'peer-a', ?, ?, 1, ?)""",
            (
                PROVIDER_SERVICE_INSTANCE_ID,
                old.global_tool_id,
                json.dumps({"reviewed_global_tool_ids": [old.global_tool_id]}),
            ),
        )
        await db.execute(
            """INSERT INTO tooling_approval_grants (
                   grant_id, grant_scope, grant_type, active, provider_peer_id,
                   provider_service_instance_id, global_tool_id, created_at, metadata_json
               ) VALUES ('grant-b', 'always', 'allow', 1, 'peer-b', 'svc-b', ?, 1, ?)""",
            (old.global_tool_id, json.dumps({"reviewed_global_tool_ids": [old.global_tool_id]})),
        )
        await db.execute(
            """INSERT INTO tooling_approval_grants (
                   grant_id, grant_scope, grant_type, active, provider_peer_id,
                   provider_service_instance_id, global_tool_id, created_at, metadata_json
               ) VALUES ('grant-c', 'always', 'allow', 1, 'peer-a', 'svc-other', ?, 1, ?)""",
            (old.global_tool_id, json.dumps({"reviewed_global_tool_ids": [old.global_tool_id]})),
        )
        for suffix, peer, provider, service in (
            ("a", "peer-a", "provider-a", PROVIDER_SERVICE_INSTANCE_ID),
            ("b", "peer-b", "provider-b", "svc-b"),
            ("c", "peer-a", "provider-a", "svc-other"),
        ):
            prepared = {
                "provider_peer_id": peer,
                "provider_id": provider,
                "provider_service_instance_id": service,
                "global_tool_id": old.global_tool_id,
            }
            await db.execute(
                """INSERT INTO tooling_approval_requests (
                       approval_request_id, request_json, prepared_json, expires_at, created_at
                   ) VALUES (?, ?, ?, 100, 1)""",
                (
                    f"request-{suffix}",
                    json.dumps({"global_tool_id": old.global_tool_id}),
                    json.dumps(prepared),
                ),
            )
            await db.execute(
                """INSERT INTO tooling_approval_tokens (
                       token_hash, claims_json, expires_at, created_at
                   ) VALUES (?, ?, 100, 1)""",
                (f"token-{suffix}", json.dumps(prepared)),
            )
        await db.execute(
            """INSERT INTO tooling_remote_catalog_headers (
                   peer_id, provider_id, service_instance_id, protocol_tier, updated_at
               ) VALUES ('peer-b', 'provider-b', 'svc-b', 'projection_v1', 1)"""
        )
        await db.execute(
            """INSERT INTO tooling_remote_tool_aliases (
                   peer_id, provider_id, legacy_global_tool_id,
                   canonical_global_tool_id, first_seen_at, last_seen_at
               ) VALUES ('peer-b', 'provider-b', ?, 'provider-b-canonical', 1, 1)""",
            (old.global_tool_id,),
        )
        await db.execute(
            """INSERT INTO tooling_remote_catalog_headers (
                   peer_id, provider_id, service_instance_id, protocol_tier, updated_at
               ) VALUES ('peer-a', 'provider-other', 'svc-other', 'projection_v1', 1)"""
        )
        await db.execute(
            """INSERT INTO tooling_remote_tool_aliases (
                   peer_id, provider_id, legacy_global_tool_id,
                   canonical_global_tool_id, first_seen_at, last_seen_at
               ) VALUES ('peer-a', 'provider-other', ?, 'same-peer-other-service', 1, 1)""",
            (old.global_tool_id,),
        )
        await db.commit()
    renamed = _tool("renamed").model_copy(update={"legacy_global_tool_ids": [old.global_tool_id]})
    result = await _commit(manager, "sync-alias-000002", [renamed], base=1, revision="v2")
    assert result.ok
    resolved = await manager.resolve_tooling_remote_tool_aliases(
        DBResolveToolingRemoteToolAliasesRequest(
            peer_id="peer-a",
            provider_id="provider-a",
            global_tool_ids=[old.global_tool_id, renamed.global_tool_id, "unknown"],
        )
    )
    assert resolved.canonical_by_requested_id == {
        old.global_tool_id: renamed.global_tool_id,
        renamed.global_tool_id: renamed.global_tool_id,
    }
    async with aiosqlite.connect(manager.db_path) as db:
        grants = await (
            await db.execute(
                "SELECT grant_id, global_tool_id, metadata_json FROM tooling_approval_grants ORDER BY grant_id"
            )
        ).fetchall()
        requests = await (
            await db.execute(
                """SELECT approval_request_id, request_json, prepared_json
                   FROM tooling_approval_requests ORDER BY approval_request_id"""
            )
        ).fetchall()
        tokens = await (
            await db.execute(
                "SELECT token_hash, claims_json FROM tooling_approval_tokens ORDER BY token_hash"
            )
        ).fetchall()
        aliases = await (
            await db.execute(
                """SELECT peer_id, provider_id, legacy_global_tool_id, canonical_global_tool_id
                   FROM tooling_remote_tool_aliases ORDER BY peer_id, provider_id"""
            )
        ).fetchall()
        rows = await (
            await db.execute(
                "SELECT global_tool_id FROM tooling_remote_catalog_tools WHERE peer_id='peer-a'"
            )
        ).fetchall()
    assert grants[0][1] == renamed.global_tool_id
    assert json.loads(grants[0][2])["reviewed_global_tool_ids"] == [renamed.global_tool_id]
    assert grants[1][1] == old.global_tool_id
    assert json.loads(grants[1][2])["reviewed_global_tool_ids"] == [old.global_tool_id]
    assert grants[2][1] == old.global_tool_id
    assert json.loads(grants[2][2])["reviewed_global_tool_ids"] == [old.global_tool_id]
    assert json.loads(requests[0][1])["global_tool_id"] == renamed.global_tool_id
    assert json.loads(requests[0][2])["global_tool_id"] == renamed.global_tool_id
    assert json.loads(requests[1][1])["global_tool_id"] == old.global_tool_id
    assert json.loads(requests[1][2])["global_tool_id"] == old.global_tool_id
    assert json.loads(requests[2][1])["global_tool_id"] == old.global_tool_id
    assert json.loads(requests[2][2])["global_tool_id"] == old.global_tool_id
    assert json.loads(tokens[0][1])["global_tool_id"] == renamed.global_tool_id
    assert json.loads(tokens[1][1])["global_tool_id"] == old.global_tool_id
    assert json.loads(tokens[2][1])["global_tool_id"] == old.global_tool_id
    assert aliases == [
        ("peer-a", "provider-a", old.global_tool_id, renamed.global_tool_id),
        ("peer-a", "provider-other", old.global_tool_id, "same-peer-other-service"),
        ("peer-b", "provider-b", old.global_tool_id, "provider-b-canonical"),
    ]
    assert [row[0] for row in rows] == [renamed.global_tool_id]


@pytest.mark.asyncio
async def test_whole_snapshot_alias_collision_rejects_before_promotion(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "alias-collision.db")
    baseline = _tool("baseline")
    assert (await _commit(manager, "sync-collision-001", [baseline], base=0, revision="v1")).ok
    shared_alias = "legacy:shared-name"
    alpha = _tool("alpha").model_copy(update={"legacy_global_tool_ids": [shared_alias]})
    beta = _tool("beta").model_copy(update={"legacy_global_tool_ids": [shared_alias]})
    rejected = await _commit(manager, "sync-collision-002", [alpha, beta], base=1, revision="v2")
    assert not rejected.ok and rejected.error == "remote_catalog_alias_owner_collision"
    catalog = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert catalog.headers[0].current_generation == 1
    assert [item.tool.local_name for item in catalog.tools] == ["baseline"]
    async with aiosqlite.connect(manager.db_path) as db:
        conflict = await (
            await db.execute(
                """SELECT legacy_global_tool_id, reason_code, review_status
                   FROM tooling_remote_tool_identity_conflicts"""
            )
        ).fetchone()
    assert conflict == (shared_alias, "remote_catalog_alias_owner_collision", "pending")


@pytest.mark.asyncio
async def test_schema_change_marks_positive_grants_only_in_same_commit(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "grant-review.db")
    tool = _tool("alpha")
    assert (await _commit(manager, "sync-grant-000001", [tool], base=0, revision="v1")).ok
    async with aiosqlite.connect(manager.db_path) as db:
        for grant_id, scope, trust in (
            ("allow", "always", "trusted"),
            ("deny", "deny_always", "blocked"),
        ):
            await db.execute(
                """INSERT INTO tooling_approval_grants (
                       grant_id, grant_scope, grant_type, active, provider_peer_id,
                       global_tool_id, trust_tier, created_at, metadata_json
                   ) VALUES (?, ?, 'policy', 1, 'peer-a', ?, ?, 1, '{}')""",
                (grant_id, scope, tool.global_tool_id, trust),
            )
        await db.commit()
    changed = await _commit(
        manager,
        "sync-grant-000002",
        [_tool("alpha", schema_version=2)],
        base=1,
        revision="v2",
    )
    assert changed.ok and changed.tools[0].availability == "schema_changed"
    async with aiosqlite.connect(manager.db_path) as db:
        rows = await (
            await db.execute(
                "SELECT grant_id, metadata_json FROM tooling_approval_grants ORDER BY grant_id"
            )
        ).fetchall()
    metadata = {row[0]: json.loads(row[1]) for row in rows}
    assert metadata["allow"]["needs_review"] is True
    assert metadata["allow"]["expected_schema_hash"] != metadata["allow"]["current_schema_hash"]
    assert metadata["deny"] == {}


@pytest.mark.asyncio
async def test_schema_grant_reconciliation_failure_rolls_back_generation(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "grant-review-rollback.db")
    tool = _tool("alpha")
    assert (await _commit(manager, "sync-rollback-001", [tool], base=0, revision="v1")).ok
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute(
            """INSERT INTO tooling_approval_grants (
                   grant_id, grant_scope, grant_type, active, provider_peer_id,
                   global_tool_id, created_at, metadata_json
               ) VALUES ('allow', 'always', 'policy', 1, 'peer-a', ?, 1, '{}')""",
            (tool.global_tool_id,),
        )
        await db.execute(
            """CREATE TRIGGER fail_grant_reconcile BEFORE UPDATE ON tooling_approval_grants
               BEGIN SELECT RAISE(ABORT, 'injected grant reconciliation failure'); END"""
        )
        await db.commit()
    with pytest.raises(aiosqlite.DatabaseError, match="injected grant reconciliation failure"):
        await _commit(
            manager,
            "sync-rollback-002",
            [_tool("alpha", schema_version=2)],
            base=1,
            revision="v2",
        )
    catalog = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert catalog.headers[0].current_generation == 1
    assert catalog.headers[0].projection_revision == "v1"
    assert catalog.tools[0].availability == "active"
    async with aiosqlite.connect(manager.db_path) as db:
        metadata = (
            await (
                await db.execute(
                    "SELECT metadata_json FROM tooling_approval_grants WHERE grant_id='allow'"
                )
            ).fetchone()
        )[0]
    assert json.loads(metadata) == {}


@pytest.mark.asyncio
async def test_retention_prune_is_bounded_audited_and_atomic(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "retention.db")
    core = _tool("alpha")
    plugin = _tool("beta").model_copy(
        update={
            "source": "plugin",
            "source_id": "plugin:calendar",
            "provenance": _tool("beta").provenance.model_copy(
                update={"source": "plugin", "stable_source_id": "plugin:calendar"}
            ),
        }
    )
    mcp = _tool("protected").model_copy(
        update={
            "source": "mcp",
            "source_id": "mcp:documents",
            "provenance": _tool("protected").provenance.model_copy(
                update={"source": "mcp", "provider_tool_id": "documents/search"}
            ),
        }
    )
    tools = [core, plugin, mcp]
    assert (await _commit(manager, "sync-prune-000001", tools, base=0, revision="v1")).ok
    retirements = [
        ToolingProjectionRetirement(
            global_tool_id=tool.global_tool_id,
            availability="removed",
            reason_code="provider_tool_removed",
        )
        for tool in tools
    ]
    assert (
        await _commit(
            manager,
            "sync-prune-000002",
            [],
            retirements=retirements,
            base=1,
            revision="v2",
        )
    ).ok
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute("UPDATE tooling_remote_catalog_tools SET updated_at=0")
        await db.execute(
            """INSERT INTO tooling_approval_grants (
                   grant_id, grant_scope, grant_type, active, provider_peer_id,
                   global_tool_id, created_at, metadata_json
               ) VALUES ('protected-grant', 'always', 'allow', 1, 'peer-a', ?, 1, '{}')""",
            (tools[2].global_tool_id,),
        )
        await db.commit()
    pruned = await manager.prune_tooling_remote_catalog_retention(
        DBPruneToolingRemoteCatalogRetentionRequest(
            now=10000,
            removed_stale_ttl_seconds=3600,
            max_retained_per_provider=16,
            max_audit_rows_per_provider=32,
            correlation_id="prune-1",
        )
    )
    assert pruned.compacted_tool_count == 3
    restarted = DatabaseManager(manager.db_path)
    await restarted.initialize()
    catalog = await restarted.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert catalog.tools == []
    assert len(catalog.retained_tombstones) == 3
    protected = next(
        item
        for item in catalog.retained_tombstones
        if item.global_tool_id == tools[2].global_tool_id
    )
    assert protected.management_metadata["local_name"] == "protected"
    assert protected.management_metadata["display_name"] == "peer-a.protected"
    assert protected.management_metadata["share_group_id"] == "core:test"
    assert protected.management_metadata["source"] == "mcp"
    assert protected.management_metadata["source_id"] == "mcp:documents"
    assert protected.management_metadata["provider_tool_id"] == "documents/search"
    assert "args_schema" not in protected.management_metadata
    assert "schema" not in protected.management_metadata
    by_name = {
        item.management_metadata["local_name"]: item.management_metadata
        for item in catalog.retained_tombstones
    }
    assert by_name["alpha"]["source"] == "core"
    assert by_name["beta"]["source"] == "plugin"
    assert by_name["beta"]["stable_source_id"] == "plugin:calendar"
    async with aiosqlite.connect(manager.db_path) as db:
        tombstones = await (
            await db.execute(
                "SELECT global_tool_id FROM tooling_remote_catalog_retention_tombstones ORDER BY global_tool_id"
            )
        ).fetchall()
        audit = await (
            await db.execute(
                "SELECT detail_reason FROM tooling_remote_catalog_audit WHERE action='retention_pruned'"
            )
        ).fetchone()
        grant = await (
            await db.execute(
                "SELECT grant_scope, global_tool_id FROM tooling_approval_grants WHERE grant_id='protected-grant'"
            )
        ).fetchone()
    assert len(tombstones) == 3
    assert grant == ("always", tools[2].global_tool_id)
    assert "compacted=3" in audit[0] and "max_tools=16" in audit[0]
    repeated = await restarted.prune_tooling_remote_catalog_retention(
        DBPruneToolingRemoteCatalogRetentionRequest(
            now=10000,
            removed_stale_ttl_seconds=3600,
            max_retained_per_provider=16,
            max_audit_rows_per_provider=32,
            correlation_id="prune-2",
        )
    )
    assert repeated.compacted_tool_count == 0
    assert repeated.pruned_audit_count == 0
    assert repeated.providers == []


@pytest.mark.asyncio
async def test_retention_audit_failure_rolls_back_full_row_and_tombstone(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "retention-rollback.db")
    tool = _tool("protected")
    assert (await _commit(manager, "sync-prune-rollback-01", [tool], base=0, revision="v1")).ok
    assert (
        await _commit(
            manager,
            "sync-prune-rollback-02",
            [],
            retirements=[
                ToolingProjectionRetirement(
                    global_tool_id=tool.global_tool_id,
                    availability="removed",
                    reason_code="provider_tool_removed",
                )
            ],
            base=1,
            revision="v2",
        )
    ).ok
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute("UPDATE tooling_remote_catalog_tools SET updated_at=0")
        await db.execute(
            """CREATE TRIGGER fail_retention_audit BEFORE INSERT ON tooling_remote_catalog_audit
               WHEN NEW.action='retention_pruned'
               BEGIN SELECT RAISE(ABORT, 'injected retention audit failure'); END"""
        )
        await db.commit()
    with pytest.raises(aiosqlite.DatabaseError, match="injected retention audit failure"):
        await manager.prune_tooling_remote_catalog_retention(
            DBPruneToolingRemoteCatalogRetentionRequest(
                now=10000,
                removed_stale_ttl_seconds=3600,
            )
        )
    remaining = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert [item.tool.local_name for item in remaining.tools] == ["protected"]
    assert remaining.retained_tombstones == []


@pytest.mark.asyncio
async def test_retention_count_bound_compacts_referenced_rows_without_losing_policy(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "retention-count-bound.db")
    tools = [_tool(f"tool-{index:02d}") for index in range(20)]
    assert (await _commit(manager, "sync-count-bound-01", tools, base=0, revision="v1")).ok
    retirements = [
        ToolingProjectionRetirement(
            global_tool_id=tool.global_tool_id,
            availability="removed",
            reason_code="provider_tool_removed",
        )
        for tool in tools
    ]
    assert (
        await _commit(
            manager,
            "sync-count-bound-02",
            [],
            retirements=retirements,
            base=1,
            revision="v2",
        )
    ).ok
    ids = [tool.global_tool_id for tool in tools]
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute("UPDATE tooling_remote_catalog_tools SET updated_at=10000")
        await db.executemany(
            """INSERT INTO tooling_approval_grants (
                   grant_id, grant_scope, grant_type, active, provider_peer_id,
                   global_tool_id, created_at, metadata_json
               ) VALUES (?, ?, 'policy', 1, 'peer-a', ?, 1, ?)""",
            [
                (
                    f"grant-{index:02d}",
                    "always" if index % 2 == 0 else "deny_always",
                    global_tool_id,
                    json.dumps({"reviewed_global_tool_ids": [global_tool_id]}),
                )
                for index, global_tool_id in enumerate(ids)
            ],
        )
        await db.execute(
            """INSERT INTO tooling_approval_requests (
                   approval_request_id, request_json, prepared_json, expires_at, created_at
               ) VALUES ('request-retention-bound', ?, ?, 20000, 1)""",
            (json.dumps({"global_tool_ids": ids}), json.dumps({"global_tool_ids": ids})),
        )
        await db.execute(
            """INSERT INTO tooling_approval_tokens (token_hash, claims_json, expires_at, created_at)
               VALUES ('token-retention-bound', ?, 20000, 1)""",
            (json.dumps({"global_tool_ids": ids}),),
        )
        await db.commit()

    pruned = await manager.prune_tooling_remote_catalog_retention(
        DBPruneToolingRemoteCatalogRetentionRequest(
            now=10000,
            removed_stale_ttl_seconds=3600,
            max_retained_per_provider=16,
        )
    )
    assert pruned.compacted_tool_count == 4
    catalog = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert len(catalog.tools) == 16
    assert len(catalog.retained_tombstones) == 4
    assert all(
        "args_schema" not in item.management_metadata for item in catalog.retained_tombstones
    )
    async with aiosqlite.connect(manager.db_path) as db:
        grants = await (
            await db.execute(
                "SELECT grant_id, grant_scope, global_tool_id FROM tooling_approval_grants ORDER BY grant_id"
            )
        ).fetchall()
        request_count = (
            await (
                await db.execute(
                    "SELECT COUNT(*) FROM tooling_approval_requests WHERE approval_request_id='request-retention-bound'"
                )
            ).fetchone()
        )[0]
        token_count = (
            await (
                await db.execute(
                    "SELECT COUNT(*) FROM tooling_approval_tokens WHERE token_hash='token-retention-bound'"
                )
            ).fetchone()
        )[0]
    assert len(grants) == 20
    assert {row[1] for row in grants} == {"always", "deny_always"}
    assert request_count == token_count == 1

    restored_id = catalog.retained_tombstones[0].global_tool_id
    restored_tool = next(tool for tool in tools if tool.global_tool_id == restored_id)
    restored = await _commit(
        manager,
        "sync-count-bound-03",
        [restored_tool],
        base=2,
        revision="v3",
    )
    restored_row = next(item for item in restored.tools if item.tool.global_tool_id == restored_id)
    assert restored.ok and restored_row.availability == "active"
    after_restore = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert all(item.global_tool_id != restored_id for item in after_restore.retained_tombstones)
    assert any(item.tool.global_tool_id == restored_id for item in after_restore.tools)
    async with aiosqlite.connect(manager.db_path) as db:
        assert (
            await (
                await db.execute(
                    "SELECT COUNT(*) FROM tooling_approval_grants WHERE global_tool_id=?",
                    (restored_id,),
                )
            ).fetchone()
        )[0] == 1


@pytest.mark.asyncio
async def test_rich_management_tombstone_tail_is_bounded_restart_safe_and_idempotent(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "retention-management-tail.db")
    tools = [_tool(f"history-{index:02d}") for index in range(20)]
    assert (await _commit(manager, "sync-history-tail-01", tools, base=0, revision="v1")).ok
    assert (
        await _commit(
            manager,
            "sync-history-tail-02",
            [],
            retirements=[
                ToolingProjectionRetirement(
                    global_tool_id=tool.global_tool_id,
                    availability="removed",
                    reason_code="provider_tool_removed",
                )
                for tool in tools
            ],
            base=1,
            revision="v2",
        )
    ).ok
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute("UPDATE tooling_remote_catalog_tools SET updated_at=0")
        await db.commit()

    pruned = await manager.prune_tooling_remote_catalog_retention(
        DBPruneToolingRemoteCatalogRetentionRequest(
            now=10000,
            removed_stale_ttl_seconds=3600,
            max_retained_per_provider=16,
            management_tombstone_ttl_seconds=3600,
            max_management_tombstones_per_provider=16,
            correlation_id="management-tail-1",
        )
    )
    assert pruned.compacted_tool_count == 20
    assert pruned.compacted_management_metadata_count == 4

    restarted = DatabaseManager(manager.db_path)
    await restarted.initialize()
    catalog = await restarted.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert catalog.tools == []
    assert len(catalog.retained_tombstones) == 20
    rich = [item for item in catalog.retained_tombstones if item.management_metadata]
    identity_only = [item for item in catalog.retained_tombstones if not item.management_metadata]
    assert len(rich) == 16
    assert len(identity_only) == 4
    assert all(item.accepted_schema_hash for item in identity_only)
    assert all(item.global_tool_id for item in identity_only)
    async with aiosqlite.connect(manager.db_path) as db:
        audit = await (
            await db.execute(
                """SELECT detail_reason FROM tooling_remote_catalog_audit
                   WHERE action='retention_pruned' ORDER BY created_at DESC LIMIT 1"""
            )
        ).fetchone()
    assert "management_compacted=4" in audit[0]
    assert "max_management=16" in audit[0]

    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute(
            """UPDATE tooling_remote_catalog_retention_tombstones
               SET compacted_at=0
               WHERE global_tool_id=(
                   SELECT global_tool_id FROM tooling_remote_catalog_retention_tombstones
                   WHERE management_metadata_json != '{}'
                   ORDER BY global_tool_id LIMIT 1
               )"""
        )
        await db.commit()
    aged = await restarted.prune_tooling_remote_catalog_retention(
        DBPruneToolingRemoteCatalogRetentionRequest(
            now=10000,
            removed_stale_ttl_seconds=3600,
            max_retained_per_provider=16,
            management_tombstone_ttl_seconds=3600,
            max_management_tombstones_per_provider=16,
            correlation_id="management-tail-aged",
        )
    )
    assert aged.compacted_management_metadata_count == 1
    after_age = await restarted.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert sum(bool(item.management_metadata) for item in after_age.retained_tombstones) == 15

    repeated = await restarted.prune_tooling_remote_catalog_retention(
        DBPruneToolingRemoteCatalogRetentionRequest(
            now=10000,
            removed_stale_ttl_seconds=3600,
            max_retained_per_provider=16,
            management_tombstone_ttl_seconds=3600,
            max_management_tombstones_per_provider=16,
            correlation_id="management-tail-2",
        )
    )
    assert repeated.compacted_tool_count == 0
    assert repeated.compacted_management_metadata_count == 0
    assert repeated.providers == []


@pytest.mark.asyncio
async def test_pruned_identity_stub_prevents_schema_self_approval(tmp_path: Path) -> None:
    manager = await _manager(tmp_path, "retention-schema.db")
    original = _tool("alpha")
    assert (await _commit(manager, "sync-stub-000001", [original], base=0, revision="v1")).ok
    retirement = ToolingProjectionRetirement(
        global_tool_id=original.global_tool_id,
        availability="removed",
        reason_code="provider_tool_removed",
    )
    assert (
        await _commit(
            manager,
            "sync-stub-000002",
            [],
            retirements=[retirement],
            base=1,
            revision="v2",
        )
    ).ok
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute("UPDATE tooling_remote_catalog_tools SET updated_at=0")
        await db.commit()
    assert (
        await manager.prune_tooling_remote_catalog_retention(
            DBPruneToolingRemoteCatalogRetentionRequest(
                now=10000,
                removed_stale_ttl_seconds=3600,
            )
        )
    ).compacted_tool_count == 1
    restored = await _commit(
        manager,
        "sync-stub-000003",
        [_tool("alpha", schema_version=2)],
        base=2,
        revision="v3",
    )
    assert restored.ok
    assert restored.tools[0].availability == "schema_changed"
    assert restored.tools[0].review_required
    assert restored.tools[0].accepted_schema_hash != restored.tools[0].schema_hash


@pytest.mark.asyncio
async def test_pruned_retirement_can_repeat_but_never_shared_id_is_rejected(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "retirement-ledger.db")
    tool = _tool("alpha")
    retirement = ToolingProjectionRetirement(
        global_tool_id=tool.global_tool_id,
        availability="removed",
        reason_code="provider_tool_removed",
    )
    assert (await _commit(manager, "sync-retire-repeat-01", [tool], base=0, revision="v1")).ok
    assert (
        await _commit(
            manager,
            "sync-retire-repeat-02",
            [],
            retirements=[retirement],
            base=1,
            revision="v2",
        )
    ).ok
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute("UPDATE tooling_remote_catalog_tools SET updated_at=0")
        await db.commit()
    assert (
        await manager.prune_tooling_remote_catalog_retention(
            DBPruneToolingRemoteCatalogRetentionRequest(now=10000, removed_stale_ttl_seconds=3600)
        )
    ).compacted_tool_count == 1

    repeated = await _commit(
        manager,
        "sync-retire-repeat-03",
        [],
        retirements=[retirement.model_copy(update={"reason_code": "still_removed"})],
        base=2,
        revision="v3",
    )
    assert repeated.ok and repeated.generation == 3
    catalog = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert catalog.tools == []
    assert catalog.retained_tombstones[0].reason_code == "still_removed"

    hidden = "aurora-tool:v1:peer-a:Tooling:never-shared-secret"
    rejected = await _commit(
        manager,
        "sync-retire-repeat-04",
        [],
        retirements=[
            ToolingProjectionRetirement(
                global_tool_id=hidden,
                availability="removed",
                reason_code="provider_tool_removed",
            )
        ],
        base=3,
        revision="v4",
    )
    assert not rejected.ok and rejected.error == "remote_catalog_unknown_retirement"
    unchanged = await manager.get_tooling_remote_catalog(DBGetToolingRemoteCatalogRequest())
    assert unchanged.headers[0].current_generation == 3
    assert all(item.global_tool_id != hidden for item in unchanged.retained_tombstones)
