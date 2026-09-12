"""G012 Tooling export-policy storage and contract tests."""

from __future__ import annotations

from pathlib import Path

import aiosqlite
import pytest

from app.services.db.manager import DatabaseManager
from app.services.db.service import _protected_authority_write_error
from app.shared.contracts.models.db import (
    DBGetToolingExportPolicySnapshotRequest,
    DBMutateToolingExportPolicyRequest,
    DBSetToolingMeshSwitchesRequest,
    DBToolingExportRuleSeed,
)


async def _manager(tmp_path: Path, name: str = "export.db") -> DatabaseManager:
    manager = DatabaseManager(str(tmp_path / name))
    await manager.initialize()
    return manager


@pytest.mark.asyncio
async def test_migration_014_fresh_and_idempotent(tmp_path: Path) -> None:
    manager = await _manager(tmp_path)
    await manager.initialize()
    async with aiosqlite.connect(manager.db_path) as db:
        tables = {
            row[0]
            for row in await (
                await db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tooling_%'"
                )
            ).fetchall()
        }
        assert {
            "tooling_export_policy",
            "tooling_export_rules",
            "tooling_export_policy_audit",
            "tooling_mesh_switches",
            "tooling_mesh_switch_audit",
        } <= tables
        assert await (
            await db.execute("SELECT COUNT(*) FROM migrations WHERE version='014'")
        ).fetchone() == (1,)
        assert await (
            await db.execute("SELECT default_state, revision FROM tooling_export_policy")
        ).fetchone() == ("shared", 0)


@pytest.mark.asyncio
async def test_migration_014_upgrades_existing_013_database(tmp_path: Path) -> None:
    manager = DatabaseManager(str(tmp_path / "upgrade.db"))
    await manager.migration_manager.initialize_migration_table()
    for version, filename in manager.migration_manager.get_migration_files():
        if int(version) > 13:
            break
        await manager.migration_manager.apply_migration(version, filename)
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute(
            "INSERT INTO tooling_tool_identities (canonical_global_tool_id, stable_peer_id, identity_version, tool_contract_id, source_kind, stable_source_id, provider_tool_id, share_group_id, share_group_label, current_local_name) VALUES ('aurora-tool:v1:p:Tooling:t', 'p', 1, 't', 'core', 'core:g', 't', 'core:g', 'G', 'T')"
        )
        await db.commit()
    await manager.initialize()
    async with aiosqlite.connect(manager.db_path) as db:
        assert await (
            await db.execute("SELECT COUNT(*) FROM tooling_tool_identities")
        ).fetchone() == (1,)
        assert await (
            await db.execute("SELECT COUNT(*) FROM migrations WHERE version='014'")
        ).fetchone() == (1,)


@pytest.mark.asyncio
async def test_global_and_peer_rule_uniqueness_are_independent(tmp_path: Path) -> None:
    manager = await _manager(tmp_path)
    async with aiosqlite.connect(manager.db_path) as db:
        base = ("tool", "tool-a", "shared", "admin", "reason", 1.0, 1.0)
        await db.execute(
            "INSERT INTO tooling_export_rules (rule_id, peer_id, scope_type, scope_id, state, actor_principal_id, reason, created_at, updated_at) VALUES ('global', NULL, ?, ?, ?, ?, ?, ?, ?)",
            base,
        )
        await db.execute(
            "INSERT INTO tooling_export_rules (rule_id, peer_id, scope_type, scope_id, state, actor_principal_id, reason, created_at, updated_at) VALUES ('peer-a', 'peer-a', ?, ?, ?, ?, ?, ?, ?)",
            base,
        )
        with pytest.raises(aiosqlite.IntegrityError):
            await db.execute(
                "INSERT INTO tooling_export_rules (rule_id, peer_id, scope_type, scope_id, state, actor_principal_id, reason, created_at, updated_at) VALUES ('global-2', NULL, ?, ?, ?, ?, ?, ?, ?)",
                base,
            )
        await db.rollback()
        # The global and peer indexes are separate; duplicate peer scope fails too.
        await db.execute(
            "INSERT INTO tooling_export_rules (rule_id, peer_id, scope_type, scope_id, state, actor_principal_id, reason, created_at, updated_at) VALUES ('peer-a', 'peer-a', ?, ?, ?, ?, ?, ?, ?)",
            base,
        )
        with pytest.raises(aiosqlite.IntegrityError):
            await db.execute(
                "INSERT INTO tooling_export_rules (rule_id, peer_id, scope_type, scope_id, state, actor_principal_id, reason, created_at, updated_at) VALUES ('peer-a-2', 'peer-a', ?, ?, ?, ?, ?, ?, ?)",
                base,
            )


@pytest.mark.asyncio
async def test_optimistic_mutations_increment_once_and_noop_does_not_audit(tmp_path: Path) -> None:
    manager = await _manager(tmp_path)
    request = DBMutateToolingExportPolicyRequest(
        action="upsert_rule",
        expected_revision=0,
        state="unshared",
        scope_type="group",
        scope_id="core:scheduler",
        actor_principal_id="admin",
        reason="Limit scheduler export",
        correlation_id="corr-1",
    )
    created = await manager.mutate_tooling_export_policy(request)
    assert created.ok and created.changed and created.revision == 1
    assert created.audit_id and created.audit_id.startswith("toolexportaudit_")
    assert created.rule is not None

    conflict = await manager.mutate_tooling_export_policy(request)
    assert not conflict.ok and conflict.error == "export_policy_revision_conflict"
    noop = await manager.mutate_tooling_export_policy(
        request.model_copy(update={"expected_revision": 1})
    )
    assert noop.ok and not noop.changed and noop.revision == 1
    assert noop.audit_id is None
    snapshot = await manager.get_tooling_export_policy_snapshot(
        DBGetToolingExportPolicySnapshotRequest(
            known_share_group_ids=["core:tts"], known_global_tool_ids=[]
        )
    )
    assert snapshot.stale_group_ids == ["core:scheduler"]
    async with aiosqlite.connect(manager.db_path) as db:
        assert await (
            await db.execute("SELECT COUNT(*) FROM tooling_export_policy_audit")
        ).fetchone() == (1,)


@pytest.mark.asyncio
async def test_recipient_scope_survives_restart_and_can_be_cleared_to_inherit(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path, "stale-recipient.db")
    created = await manager.mutate_tooling_export_policy(
        DBMutateToolingExportPolicyRequest(
            action="upsert_rule",
            expected_revision=0,
            state="unshared",
            peer_id="peer-removed-stable",
            scope_type="group",
            scope_id="core:scheduler",
            actor_principal_id="admin",
            reason="Retain recipient overlay",
        )
    )
    assert created.ok and created.revision == 1

    restarted = await _manager(tmp_path, "stale-recipient.db")
    snapshot = await restarted.get_tooling_export_policy_snapshot(
        DBGetToolingExportPolicySnapshotRequest()
    )
    assert snapshot.rules == []  # All-peers rules remain separate from recipient overlays.
    assert [scope.model_dump() for scope in snapshot.recipient_scopes] == [
        {
            "peer_id": "peer-removed-stable",
            "rule_count": 1,
            "last_rule_updated_at": snapshot.recipient_scopes[0].last_rule_updated_at,
        }
    ]

    cleared = await restarted.mutate_tooling_export_policy(
        DBMutateToolingExportPolicyRequest(
            action="clear_rule",
            expected_revision=1,
            peer_id="peer-removed-stable",
            scope_type="group",
            scope_id="core:scheduler",
            actor_principal_id="admin",
            reason="Clear stale recipient override to inherit",
        )
    )
    assert cleared.ok and cleared.cleared and cleared.revision == 2
    after = await restarted.get_tooling_export_policy_snapshot(
        DBGetToolingExportPolicySnapshotRequest()
    )
    assert after.recipient_scopes == []


@pytest.mark.asyncio
async def test_legacy_initialization_is_atomic_and_idempotent_for_shared_default(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path)
    initialize = DBMutateToolingExportPolicyRequest(
        action="initialize_legacy",
        expected_revision=0,
        state="shared",
        migrated_from_legacy=True,
        initial_rules=[
            DBToolingExportRuleSeed(
                rule_id="legacy-rule:export",
                scope_type="tool",
                scope_id="aurora-tool:v1:peer:Tooling:tool-a",
                state="unshared",
                actor_principal_id="migration",
                reason="Conservative legacy import",
            )
        ],
        actor_principal_id="migration",
        reason="Initialize legacy Tooling export policy",
    )
    first = await manager.mutate_tooling_export_policy(initialize)
    assert first.ok and first.changed and first.revision == 1
    assert first.audit_id and first.audit_id.startswith("toolexportaudit_")
    assert first.policy.initialized and first.policy.migrated_from_legacy
    second = await manager.mutate_tooling_export_policy(
        initialize.model_copy(update={"expected_revision": 1})
    )
    assert second.ok and not second.changed and second.revision == 1
    async with aiosqlite.connect(manager.db_path) as db:
        assert await (await db.execute("SELECT COUNT(*) FROM tooling_export_rules")).fetchone() == (
            1,
        )
        assert await (
            await db.execute("SELECT COUNT(*) FROM tooling_export_policy_audit")
        ).fetchone() == (1,)


@pytest.mark.asyncio
async def test_legacy_initialization_collision_rolls_back_policy_rules_and_audit(
    tmp_path: Path,
) -> None:
    manager = await _manager(tmp_path)
    duplicate_scope = [
        DBToolingExportRuleSeed(
            rule_id=f"rule-{index}",
            scope_type="group",
            scope_id="core:scheduler",
            state=state,
            actor_principal_id="migration",
            reason="Legacy import",
        )
        for index, state in enumerate(("shared", "unshared"))
    ]
    with pytest.raises(aiosqlite.IntegrityError):
        await manager.mutate_tooling_export_policy(
            DBMutateToolingExportPolicyRequest(
                action="initialize_legacy",
                expected_revision=0,
                state="shared",
                migrated_from_legacy=True,
                initial_rules=duplicate_scope,
                actor_principal_id="migration",
                reason="Initialize legacy Tooling export policy",
            )
        )
    async with aiosqlite.connect(manager.db_path) as db:
        assert await (
            await db.execute("SELECT initialized, revision FROM tooling_export_policy")
        ).fetchone() == (0, 0)
        assert await (await db.execute("SELECT COUNT(*) FROM tooling_export_rules")).fetchone() == (
            0,
        )
        assert await (
            await db.execute("SELECT COUNT(*) FROM tooling_export_policy_audit")
        ).fetchone() == (0,)


@pytest.mark.asyncio
async def test_switches_persist_independently_from_export_revision(tmp_path: Path) -> None:
    manager = await _manager(tmp_path)
    updated = await manager.set_tooling_mesh_switches(
        DBSetToolingMeshSwitchesRequest(
            provider_mesh_tooling_enabled=False,
            consumer_mesh_tooling_enabled=True,
            expected_revision=0,
            actor_principal_id="admin",
            reason="Emergency provider stop",
        )
    )
    assert updated.ok and updated.revision == 1
    assert not updated.switches.provider_mesh_tooling_enabled
    assert updated.switches.enforcement_active is False
    snapshot = await manager.get_tooling_export_policy_snapshot(
        DBGetToolingExportPolicySnapshotRequest()
    )
    assert snapshot.policy.revision == 0
    assert snapshot.mesh_switches.revision == 1


@pytest.mark.asyncio
async def test_export_and_approval_authority_are_storage_independent(tmp_path: Path) -> None:
    manager = await _manager(tmp_path)
    async with aiosqlite.connect(manager.db_path) as db:
        await db.execute(
            "INSERT INTO tooling_approval_grants "
            "(grant_id, grant_scope, grant_type, active, created_at) "
            "VALUES ('grant-a', 'always', 'approval', 1, 1.0)"
        )
        await db.commit()

    changed = await manager.mutate_tooling_export_policy(
        DBMutateToolingExportPolicyRequest(
            action="set_default",
            expected_revision=0,
            state="unshared",
            actor_principal_id="admin",
            reason="Do not export by default",
        )
    )
    assert changed.ok and changed.revision == 1
    async with aiosqlite.connect(manager.db_path) as db:
        assert await (
            await db.execute("SELECT grant_id, active FROM tooling_approval_grants")
        ).fetchall() == [("grant-a", 1)]
        await db.execute("UPDATE tooling_approval_grants SET active=0 WHERE grant_id='grant-a'")
        await db.commit()

    snapshot = await manager.get_tooling_export_policy_snapshot(
        DBGetToolingExportPolicySnapshotRequest()
    )
    assert snapshot.policy.default_state == "unshared"
    assert snapshot.policy.revision == 1


@pytest.mark.parametrize(
    "table",
    [
        "tooling_export_policy",
        "tooling_export_rules",
        "tooling_export_policy_audit",
        "tooling_mesh_switches",
        "tooling_mesh_switch_audit",
    ],
)
def test_raw_sql_cannot_write_tooling_export_authority(table: str) -> None:
    error = _protected_authority_write_error(f"DELETE FROM {table}")
    assert error is not None and "protected authority tables" in error
