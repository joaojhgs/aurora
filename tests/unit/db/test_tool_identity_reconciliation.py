"""Durable immutable Tooling identity migration and transaction tests."""

from __future__ import annotations

import json
from pathlib import Path

import aiosqlite
import pytest
from pydantic import ValidationError

from app.services.db.manager import DatabaseManager
from app.shared.contracts.models.db import (
    DBAllocateToolIdentityRequest,
    DBReconcileToolIdentityRequest,
)


def identity_request(
    contract_id: str = "core.scheduler.list",
    *,
    legacy_ids: list[str] | None = None,
    provider_tool_id: str = "list_scheduled_tasks_tool",
    current_local_name: str = "List scheduled tasks",
) -> DBReconcileToolIdentityRequest:
    peer_id = "peer-stable-a"
    return DBReconcileToolIdentityRequest(
        canonical_global_tool_id=f"aurora-tool:v1:{peer_id}:Tooling:{contract_id}",
        stable_peer_id=peer_id,
        tool_contract_id=contract_id,
        source_kind="core",
        stable_source_id="core:scheduler",
        provider_tool_id=provider_tool_id,
        share_group_id="core:scheduler",
        share_group_label="Scheduler",
        current_local_name=current_local_name,
        legacy_global_tool_ids=legacy_ids or ["local:local_Tooling:tool:list_scheduled_tasks_tool"],
    )


def test_identity_request_uses_canonical_percent_encoded_formula() -> None:
    request = DBReconcileToolIdentityRequest(
        canonical_global_tool_id="aurora-tool:v1:peer%3Aone:Tooling:mcp.server%2Flist",
        stable_peer_id="peer:one",
        tool_contract_id="mcp.server/list",
        source_kind="mcp",
        stable_source_id="server-one",
        provider_tool_id="list",
        share_group_id="mcp:server-one",
        share_group_label="Server one",
        current_local_name="List",
    )
    assert request.stable_peer_id == "peer:one"
    with pytest.raises(ValidationError):
        DBReconcileToolIdentityRequest.model_validate(
            {
                **request.model_dump(),
                "canonical_global_tool_id": "aurora-tool:v1:peer:one:Tooling:mcp.server/list",
            }
        )


async def seed_tooling_dependents(db_path: Path, legacy_id: str) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO tooling_approval_grants (
                grant_id, grant_scope, grant_type, global_tool_id,
                created_at, metadata_json
            ) VALUES ('grant-1', 'always', 'allow', ?, 1.0, ?)
            """,
            (
                legacy_id,
                json.dumps(
                    {
                        "global_tool_id": legacy_id,
                        "reviewed_global_tool_ids": [legacy_id, legacy_id],
                        "unrelated": legacy_id,
                    }
                ),
            ),
        )
        await db.execute(
            """
            INSERT INTO tooling_approval_requests (
                approval_request_id, request_json, prepared_json,
                expires_at, created_at
            ) VALUES ('approval-1', ?, ?, 100.0, 1.0)
            """,
            (
                json.dumps({"global_tool_id": legacy_id}),
                json.dumps({"global_tool_id": legacy_id, "nested": {"global_tool_id": legacy_id}}),
            ),
        )
        await db.execute(
            """
            INSERT INTO tooling_approval_tokens (
                token_hash, claims_json, expires_at, created_at
            ) VALUES ('token-1', ?, 100.0, 1.0)
            """,
            (json.dumps({"global_tool_id": legacy_id}),),
        )
        await db.execute(
            """
            INSERT INTO tooling_remote_catalog_snapshots (
                peer_id, service_instance_id, provider_id, catalog_epoch,
                generated_at, full_schema_hash, tools_json, updated_at
            ) VALUES ('peer-stable-a', 'boot-instance', 'provider-a', 1,
                      '2026-01-01T00:00:00Z', 'hash', ?, 1.0)
            """,
            (json.dumps([{"global_tool_id": legacy_id, "name": "remote"}]),),
        )
        await db.execute(
            """
            INSERT INTO tooling_remote_catalog_tombstones (
                global_tool_id, peer_id, service_instance_id, reason, removed_at
            ) VALUES (?, 'peer-stable-a', 'boot-instance', 'removed', 1.0)
            """,
            (legacy_id,),
        )
        await db.commit()


@pytest.mark.asyncio
async def test_migration_012_is_idempotent_and_creates_identity_constraints(tmp_path: Path) -> None:
    db_path = tmp_path / "tool-identities.db"
    manager = DatabaseManager(str(db_path))

    await manager.initialize()
    await manager.initialize()

    async with aiosqlite.connect(db_path) as db:
        tables = {
            row[0]
            for row in await (
                await db.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tooling_%'"
                )
            ).fetchall()
        }
        assert {
            "tooling_tool_identities",
            "tooling_tool_identity_aliases",
            "tooling_tool_identity_allocations",
            "tooling_tool_identity_conflicts",
            "tooling_approval_grants",
            "tooling_approval_requests",
            "tooling_approval_tokens",
            "tooling_remote_catalog_snapshots",
            "tooling_remote_catalog_tombstones",
        }.issubset(tables)
        migration_count = await (
            await db.execute("SELECT COUNT(*) FROM migrations WHERE version IN ('012', '013')")
        ).fetchone()
        assert migration_count == (2,)


@pytest.mark.asyncio
async def test_migration_013_upgrades_applied_012_and_preserves_aliases(tmp_path: Path) -> None:
    db_path = tmp_path / "tool-identities-upgrade.db"
    manager = DatabaseManager(str(db_path))
    await manager.migration_manager.initialize_migration_table()
    for version, filename in manager.migration_manager.get_migration_files():
        if int(version) > 12:
            break
        await manager.migration_manager.apply_migration(version, filename)

    first = identity_request()
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO tooling_tool_identities (
                canonical_global_tool_id, stable_peer_id, identity_version,
                tool_contract_id, source_kind, stable_source_id, provider_tool_id,
                share_group_id, share_group_label, current_local_name
            ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                first.canonical_global_tool_id,
                first.stable_peer_id,
                first.tool_contract_id,
                first.source_kind,
                first.stable_source_id,
                first.provider_tool_id,
                first.share_group_id,
                first.share_group_label,
                first.current_local_name,
            ),
        )
        await db.execute(
            """
            INSERT INTO tooling_tool_identity_aliases (
                legacy_global_tool_id, canonical_global_tool_id
            ) VALUES (?, ?)
            """,
            (first.legacy_global_tool_ids[0], first.canonical_global_tool_id),
        )
        await db.commit()

    await manager.initialize()

    async with aiosqlite.connect(db_path) as db:
        columns = {
            row[1]
            for row in await (
                await db.execute("PRAGMA table_info(tooling_tool_identity_aliases)")
            ).fetchall()
        }
        alias = await (
            await db.execute(
                """
                SELECT stable_peer_id, legacy_global_tool_id,
                       canonical_global_tool_id
                FROM tooling_tool_identity_aliases
                """
            )
        ).fetchone()
    assert "stable_peer_id" in columns
    assert alias == (
        first.stable_peer_id,
        first.legacy_global_tool_ids[0],
        first.canonical_global_tool_id,
    )


def allocation_request(
    *,
    peer_id: str = "peer-stable-a",
    locator: str = "legacy:local:list-schedules",
    source_kind: str = "unknown",
    source_id: str = "legacy:local",
    provider_tool_id: str = "list_schedules",
) -> DBAllocateToolIdentityRequest:
    return DBAllocateToolIdentityRequest(
        stable_peer_id=peer_id,
        legacy_identity_locator=locator,
        source_kind=source_kind,
        stable_source_id=source_id,
        provider_tool_id=provider_tool_id,
        share_group_id=f"legacy:{source_id}",
        share_group_label="Legacy tools",
        current_local_name="List schedules",
    )


@pytest.mark.asyncio
async def test_allocated_name_only_identity_survives_restart_and_rename(tmp_path: Path) -> None:
    db_path = tmp_path / "allocated-identity.db"
    manager = DatabaseManager(str(db_path))
    await manager.initialize()
    request = allocation_request()

    first = await manager.allocate_tool_identity(request)
    assert first.success is True
    assert first.created is True
    assert first.canonical_global_tool_id.startswith("aurora-tool:v1:peer-stable-a:Tooling:legacy.")

    restarted = DatabaseManager(str(db_path))
    renamed = request.model_copy(
        update={
            "current_local_name": "Schedules on this device",
            "legacy_global_tool_ids": ["legacy:local:schedules-renamed"],
        }
    )
    replay = await restarted.allocate_tool_identity(renamed)
    assert replay.success is True
    assert replay.created is False
    assert replay.allocated_tool_contract_id == first.allocated_tool_contract_id
    assert replay.canonical_global_tool_id == first.canonical_global_tool_id

    resolved = await restarted.resolve_tool_identity_aliases(
        [
            request.legacy_identity_locator,
            "legacy:local:schedules-renamed",
            first.canonical_global_tool_id,
            "unknown",
        ]
    )
    assert resolved.resolved == {
        request.legacy_identity_locator: first.canonical_global_tool_id,
        "legacy:local:schedules-renamed": first.canonical_global_tool_id,
        first.canonical_global_tool_id: first.canonical_global_tool_id,
    }


@pytest.mark.asyncio
async def test_legacy_remote_allocation_is_scoped_to_authenticated_peer(tmp_path: Path) -> None:
    db_path = tmp_path / "remote-legacy.db"
    manager = DatabaseManager(str(db_path))
    await manager.initialize()
    request = allocation_request(
        peer_id="remote-peer-a",
        locator="legacy:remote:calendar.list",
        source_kind="mesh_peer",
        source_id="remote-peer-a",
        provider_tool_id="calendar.list",
    )

    peer_a = await manager.allocate_tool_identity(request)
    peer_b = await manager.allocate_tool_identity(
        request.model_copy(
            update={"stable_peer_id": "remote-peer-b", "stable_source_id": "remote-peer-b"}
        )
    )

    assert peer_a.success is True
    assert peer_b.success is True
    assert peer_a.canonical_global_tool_id != peer_b.canonical_global_tool_id
    assert ":remote-peer-a:Tooling:" in peer_a.canonical_global_tool_id
    assert ":remote-peer-b:Tooling:" in peer_b.canonical_global_tool_id
    resolved_a = await manager.resolve_tool_identity_aliases(
        [request.legacy_identity_locator], stable_peer_id="remote-peer-a"
    )
    resolved_b = await manager.resolve_tool_identity_aliases(
        [request.legacy_identity_locator], stable_peer_id="remote-peer-b"
    )
    assert resolved_a.resolved[request.legacy_identity_locator] == peer_a.canonical_global_tool_id
    assert resolved_b.resolved[request.legacy_identity_locator] == peer_b.canonical_global_tool_id
    ambiguous = await manager.resolve_tool_identity_aliases([request.legacy_identity_locator])
    assert ambiguous.resolved == {}


@pytest.mark.asyncio
async def test_allocation_locator_collision_fails_closed_without_rebinding(tmp_path: Path) -> None:
    db_path = tmp_path / "allocation-collision.db"
    manager = DatabaseManager(str(db_path))
    await manager.initialize()
    original = allocation_request()
    first = await manager.allocate_tool_identity(original)
    assert first.success is True

    conflicting = original.model_copy(update={"provider_tool_id": "delete_everything"})
    rejected = await manager.allocate_tool_identity(conflicting)
    assert rejected.success is False
    assert rejected.error_code == "legacy_identity_locator_collision"
    assert rejected.allocated_tool_contract_id == first.allocated_tool_contract_id

    replay = await manager.allocate_tool_identity(original)
    assert replay.success is True
    assert replay.canonical_global_tool_id == first.canonical_global_tool_id
    async with aiosqlite.connect(db_path) as db:
        allocation_count = await (
            await db.execute("SELECT COUNT(*) FROM tooling_tool_identity_allocations")
        ).fetchone()
        identity_count = await (
            await db.execute("SELECT COUNT(*) FROM tooling_tool_identities")
        ).fetchone()
    assert allocation_count == (1,)
    assert identity_count == (1,)


@pytest.mark.asyncio
async def test_reconcile_rekeys_all_authority_and_cache_state_and_replays_idempotently(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "tool-rekey.db"
    manager = DatabaseManager(str(db_path))
    await manager.initialize()
    request = identity_request()
    legacy_id = request.legacy_global_tool_ids[0]
    canonical_id = request.canonical_global_tool_id
    await seed_tooling_dependents(db_path, legacy_id)

    result = await manager.reconcile_tool_identity(request)

    assert result.success is True
    assert result.created is True
    assert result.idempotent is False
    assert result.rekeyed.model_dump() == {
        "approval_grants": 1,
        "approval_grant_metadata": 1,
        "approval_requests": 1,
        "approval_tokens": 1,
        "remote_catalog_snapshots": 1,
        "remote_catalog_tombstones": 1,
    }
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        identity = await (await db.execute("SELECT * FROM tooling_tool_identities")).fetchone()
        assert identity["canonical_global_tool_id"] == canonical_id
        assert identity["identity_status"] == "canonical"
        alias = await (await db.execute("SELECT * FROM tooling_tool_identity_aliases")).fetchone()
        assert alias["legacy_global_tool_id"] == legacy_id
        assert alias["canonical_global_tool_id"] == canonical_id
        grant = await (
            await db.execute("SELECT global_tool_id, metadata_json FROM tooling_approval_grants")
        ).fetchone()
        assert grant["global_tool_id"] == canonical_id
        grant_metadata = json.loads(grant["metadata_json"])
        assert grant_metadata["global_tool_id"] == canonical_id
        assert grant_metadata["reviewed_global_tool_ids"] == [canonical_id]
        assert grant_metadata["unrelated"] == legacy_id
        approval = await (
            await db.execute("SELECT request_json, prepared_json FROM tooling_approval_requests")
        ).fetchone()
        assert json.loads(approval["request_json"])["global_tool_id"] == canonical_id
        assert json.loads(approval["prepared_json"])["nested"]["global_tool_id"] == canonical_id
        token = await (
            await db.execute("SELECT claims_json FROM tooling_approval_tokens")
        ).fetchone()
        assert json.loads(token["claims_json"])["global_tool_id"] == canonical_id
        snapshot = await (
            await db.execute("SELECT tools_json, stale FROM tooling_remote_catalog_snapshots")
        ).fetchone()
        assert json.loads(snapshot["tools_json"])[0]["global_tool_id"] == canonical_id
        assert snapshot["stale"] == 1
        tombstone = await (
            await db.execute("SELECT global_tool_id FROM tooling_remote_catalog_tombstones")
        ).fetchone()
        assert tombstone["global_tool_id"] == canonical_id

    replay = await manager.reconcile_tool_identity(request)
    assert replay.success is True
    assert replay.created is False
    assert replay.idempotent is True
    assert sum(replay.rekeyed.model_dump().values()) == 0


@pytest.mark.asyncio
async def test_alias_collision_rolls_back_claim_and_quarantines_existing_identity(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "tool-collision.db"
    manager = DatabaseManager(str(db_path))
    await manager.initialize()
    shared_alias = "peer:boot:tool:same-name"
    existing_other_alias = "peer:old-boot:tool:first-name"
    requested_other_alias = "peer:new-boot:tool:second-name"
    first = identity_request(legacy_ids=[shared_alias, existing_other_alias])
    assert (await manager.reconcile_tool_identity(first)).success is True
    await seed_tooling_dependents(db_path, shared_alias)
    async with aiosqlite.connect(db_path) as db:
        await db.executemany(
            """
            INSERT INTO tooling_approval_grants (
                grant_id, grant_scope, grant_type, global_tool_id,
                created_at, metadata_json
            ) VALUES (?, 'always', 'allow', ?, 1.0, '{}')
            """,
            [
                ("grant-existing-other", existing_other_alias),
                ("grant-requested-other", requested_other_alias),
            ],
        )
        await db.commit()
    second = identity_request(
        "plugin.other.same-name",
        legacy_ids=[shared_alias, requested_other_alias],
        provider_tool_id="plugin_same_name",
    ).model_copy(
        update={
            "source_kind": "plugin",
            "stable_source_id": "plugin:other",
            "share_group_id": "plugin:other",
            "share_group_label": "Other plugin",
        }
    )

    result = await manager.reconcile_tool_identity(second)

    assert result.success is False
    assert result.error_code == "legacy_alias_collision"
    assert result.conflict_id
    async with aiosqlite.connect(db_path) as db:
        existing = await (
            await db.execute(
                """
                SELECT identity_status FROM tooling_tool_identities
                WHERE canonical_global_tool_id = ?
                """,
                (first.canonical_global_tool_id,),
            )
        ).fetchone()
        assert existing == ("collision",)
        requested = await (
            await db.execute(
                """
                SELECT 1 FROM tooling_tool_identities
                WHERE canonical_global_tool_id = ?
                """,
                (second.canonical_global_tool_id,),
            )
        ).fetchone()
        assert requested is None
        alias = await (
            await db.execute(
                """
                SELECT canonical_global_tool_id FROM tooling_tool_identity_aliases
                WHERE legacy_global_tool_id = ?
                """,
                (shared_alias,),
            )
        ).fetchone()
        assert alias == (first.canonical_global_tool_id,)
        grants = await (
            await db.execute(
                "SELECT global_tool_id, active FROM tooling_approval_grants ORDER BY grant_id"
            )
        ).fetchall()
        assert grants == [
            (shared_alias, 0),
            (existing_other_alias, 0),
            (requested_other_alias, 0),
        ]
        snapshot = await (
            await db.execute("SELECT tools_json, stale FROM tooling_remote_catalog_snapshots")
        ).fetchone()
        assert json.loads(snapshot[0])[0]["global_tool_id"] == shared_alias
        assert snapshot[1] == 1
        conflict = await (
            await db.execute(
                """
                SELECT reason_code, review_status FROM tooling_tool_identity_conflicts
                WHERE conflict_id = ?
                """,
                (result.conflict_id,),
            )
        ).fetchone()
        assert conflict == ("legacy_alias_collision", "pending")


@pytest.mark.asyncio
async def test_mid_transaction_failure_rolls_back_identity_alias_authority_and_cache(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "tool-rollback.db"
    manager = DatabaseManager(str(db_path))
    await manager.initialize()
    request = identity_request()
    legacy_id = request.legacy_global_tool_ids[0]
    await seed_tooling_dependents(db_path, legacy_id)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            CREATE TRIGGER reject_tool_token_rekey
            BEFORE UPDATE OF claims_json ON tooling_approval_tokens
            BEGIN
                SELECT RAISE(ABORT, 'injected token rekey failure');
            END
            """
        )
        await db.commit()

    result = await manager.reconcile_tool_identity(request)

    assert result.success is False
    assert result.error_code == "tool_identity_storage_error"
    assert "injected token rekey failure" in (result.error or "")
    async with aiosqlite.connect(db_path) as db:
        assert await (await db.execute("SELECT 1 FROM tooling_tool_identities")).fetchone() is None
        assert (
            await (await db.execute("SELECT 1 FROM tooling_tool_identity_aliases")).fetchone()
            is None
        )
        assert (
            await (await db.execute("SELECT 1 FROM tooling_tool_identity_conflicts")).fetchone()
            is None
        )
        grant = await (
            await db.execute("SELECT global_tool_id, metadata_json FROM tooling_approval_grants")
        ).fetchone()
        assert grant[0] == legacy_id
        assert json.loads(grant[1])["global_tool_id"] == legacy_id
        approval = await (
            await db.execute("SELECT request_json FROM tooling_approval_requests")
        ).fetchone()
        assert json.loads(approval[0])["global_tool_id"] == legacy_id
        snapshot = await (
            await db.execute("SELECT tools_json FROM tooling_remote_catalog_snapshots")
        ).fetchone()
        assert json.loads(snapshot[0])[0]["global_tool_id"] == legacy_id
        tombstone = await (
            await db.execute("SELECT global_tool_id FROM tooling_remote_catalog_tombstones")
        ).fetchone()
        assert tombstone == (legacy_id,)
