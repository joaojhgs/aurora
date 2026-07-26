"""Typed, transaction-owned persistence for Tooling export authority.

This state is security-sensitive and intentionally unavailable to public raw
SQL writes.  Export policy and approval policy are separate authority domains.
"""

from __future__ import annotations

import time
from uuid import uuid4

import aiosqlite

from app.shared.contracts.models.db import (
    DBGetToolingExportPolicySnapshotRequest,
    DBGetToolingExportPolicySnapshotResponse,
    DBMutateToolingExportPolicyRequest,
    DBMutateToolingExportPolicyResponse,
    DBSetToolingMeshSwitchesRequest,
    DBSetToolingMeshSwitchesResponse,
    DBToolingExportRecipientScope,
)
from app.shared.contracts.models.tooling import (
    ToolingExportPolicy,
    ToolingExportRule,
    ToolingMeshKillSwitches,
)


async def _connect(db_path: str) -> aiosqlite.Connection:
    db = await aiosqlite.connect(db_path)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA foreign_keys = ON")
    return db


def _policy(row: aiosqlite.Row) -> ToolingExportPolicy:
    return ToolingExportPolicy(
        default_state=row["default_state"],
        revision=int(row["revision"]),
        initialized=bool(row["initialized"]),
        migrated_from_legacy=bool(row["migrated_from_legacy"]),
        updated_at=float(row["updated_at"]),
    )


def _rule(row: aiosqlite.Row) -> ToolingExportRule:
    return ToolingExportRule(
        rule_id=row["rule_id"],
        peer_id=row["peer_id"],
        scope_type=row["scope_type"],
        scope_id=row["scope_id"],
        state=row["state"],
        actor_principal_id=row["actor_principal_id"],
        reason=row["reason"],
        created_at=float(row["created_at"]),
        updated_at=float(row["updated_at"]),
    )


def _switches(row: aiosqlite.Row) -> ToolingMeshKillSwitches:
    return ToolingMeshKillSwitches(
        provider_mesh_tooling_enabled=bool(row["provider_mesh_tooling_enabled"]),
        consumer_mesh_tooling_enabled=bool(row["consumer_mesh_tooling_enabled"]),
        revision=int(row["revision"]),
        updated_at=float(row["updated_at"]),
        enforcement_active=False,
    )


async def get_tooling_export_policy_snapshot(
    db_path: str,
    request: DBGetToolingExportPolicySnapshotRequest,
) -> DBGetToolingExportPolicySnapshotResponse:
    """Read policy, deterministic rules, stale IDs, and switches consistently."""

    db = await _connect(db_path)
    try:
        await db.execute("BEGIN")
        policy_row = await (
            await db.execute("SELECT * FROM tooling_export_policy WHERE singleton_id=1")
        ).fetchone()
        switch_row = await (
            await db.execute("SELECT * FROM tooling_mesh_switches WHERE singleton_id=1")
        ).fetchone()
        if policy_row is None or switch_row is None:
            raise RuntimeError("Tooling export migration 014 is incomplete")

        rules: list[ToolingExportRule] = []
        if request.include_rules:
            if request.peer_id is None:
                cursor = await db.execute(
                    """
                    SELECT * FROM tooling_export_rules
                    WHERE peer_id IS NULL
                    ORDER BY scope_type, scope_id, rule_id
                    """
                )
            else:
                cursor = await db.execute(
                    """
                    SELECT * FROM tooling_export_rules
                    WHERE peer_id IS NULL OR peer_id = ?
                    ORDER BY CASE WHEN peer_id IS NULL THEN 1 ELSE 0 END,
                             scope_type, scope_id, rule_id
                    """,
                    (request.peer_id,),
                )
            rules = [_rule(row) for row in await cursor.fetchall()]

        scope_cursor = await db.execute(
            """
            SELECT peer_id, COUNT(*) AS rule_count, MAX(updated_at) AS last_rule_updated_at
            FROM tooling_export_rules
            WHERE peer_id IS NOT NULL
            GROUP BY peer_id
            ORDER BY peer_id
            """
        )
        recipient_scopes = [
            DBToolingExportRecipientScope(
                peer_id=row["peer_id"],
                rule_count=int(row["rule_count"]),
                last_rule_updated_at=float(row["last_rule_updated_at"]),
            )
            for row in await scope_cursor.fetchall()
        ]

        stale_tools: list[str] = []
        stale_groups: list[str] = []
        if request.include_stale:
            known_tools = set(request.known_global_tool_ids)
            known_groups = set(request.known_share_group_ids)
            stale_tools = sorted(
                {rule.scope_id for rule in rules if rule.scope_type == "tool"} - known_tools
            )
            stale_groups = sorted(
                {rule.scope_id for rule in rules if rule.scope_type == "group"} - known_groups
            )
        await db.commit()
        return DBGetToolingExportPolicySnapshotResponse(
            policy=_policy(policy_row),
            rules=rules,
            stale_tool_ids=stale_tools,
            stale_group_ids=stale_groups,
            recipient_scopes=recipient_scopes,
            mesh_switches=_switches(switch_row),
            secrets_redacted=True,
        )
    finally:
        await db.close()


async def mutate_tooling_export_policy(
    db_path: str,
    request: DBMutateToolingExportPolicyRequest,
) -> DBMutateToolingExportPolicyResponse:
    """Compare-and-swap one logical export change and its audit row."""

    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        policy_row = await (
            await db.execute("SELECT * FROM tooling_export_policy WHERE singleton_id=1")
        ).fetchone()
        if policy_row is None:
            raise RuntimeError("Tooling export migration 014 is incomplete")
        previous_revision = int(policy_row["revision"])
        if previous_revision != request.expected_revision:
            await db.rollback()
            policy = _policy(policy_row)
            return DBMutateToolingExportPolicyResponse(
                ok=False,
                policy=policy,
                previous_revision=previous_revision,
                revision=previous_revision,
                error="export_policy_revision_conflict",
                correlation_id=request.correlation_id,
            )

        now = time.time()
        if request.action == "initialize_legacy":
            if bool(policy_row["initialized"]):
                await db.commit()
                return DBMutateToolingExportPolicyResponse(
                    ok=True,
                    policy=_policy(policy_row),
                    changed=False,
                    previous_revision=previous_revision,
                    revision=previous_revision,
                    correlation_id=request.correlation_id,
                )
            existing_rule_count = int(
                (await (await db.execute("SELECT COUNT(*) FROM tooling_export_rules")).fetchone())[
                    0
                ]
            )
            if existing_rule_count:
                raise RuntimeError("uninitialized Tooling export policy already has rules")
            revision = previous_revision + 1
            audit_id = f"toolexportaudit_{uuid4().hex}"
            for seed in request.initial_rules:
                await db.execute(
                    """
                    INSERT INTO tooling_export_rules (
                        rule_id, peer_id, scope_type, scope_id, state,
                        actor_principal_id, reason, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        seed.rule_id,
                        seed.peer_id,
                        seed.scope_type,
                        seed.scope_id,
                        seed.state,
                        seed.actor_principal_id,
                        seed.reason,
                        now,
                        now,
                    ),
                )
            await db.execute(
                """
                UPDATE tooling_export_policy SET
                    default_state=?, revision=?, initialized=1,
                    migrated_from_legacy=?, updated_at=?
                WHERE singleton_id=1
                """,
                (request.state, revision, request.migrated_from_legacy, now),
            )
            await db.execute(
                """
                INSERT INTO tooling_export_policy_audit (
                    audit_id, revision, action, previous_state, new_state,
                    actor_principal_id, reason, correlation_id, created_at
                ) VALUES (?, ?, 'initialize_legacy', ?, ?, ?, ?, ?, ?)
                """,
                (
                    audit_id,
                    revision,
                    policy_row["default_state"],
                    request.state,
                    request.actor_principal_id,
                    request.reason,
                    request.correlation_id,
                    now,
                ),
            )
            await db.commit()
            initialized_row = await (
                await db.execute("SELECT * FROM tooling_export_policy WHERE singleton_id=1")
            ).fetchone()
            return DBMutateToolingExportPolicyResponse(
                ok=True,
                policy=_policy(initialized_row),
                changed=True,
                audit_id=audit_id,
                previous_revision=previous_revision,
                revision=revision,
                correlation_id=request.correlation_id,
            )

        changed = False
        cleared = False
        result_rule: ToolingExportRule | None = None
        rule_id: str | None = None
        previous_state: str | None = None

        if request.action == "set_default":
            previous_state = str(policy_row["default_state"])
            changed = previous_state != request.state or not bool(policy_row["initialized"])
        else:
            existing = await (
                await db.execute(
                    """
                    SELECT * FROM tooling_export_rules
                    WHERE peer_id IS ? AND scope_type = ? AND scope_id = ?
                    """,
                    (request.peer_id, request.scope_type, request.scope_id),
                )
            ).fetchone()
            previous_state = str(existing["state"]) if existing is not None else None
            if request.action == "upsert_rule":
                changed = existing is None or previous_state != request.state
                rule_id = (
                    str(existing["rule_id"])
                    if existing is not None
                    else f"toolexport_{uuid4().hex}"
                )
            else:
                changed = existing is not None
                cleared = changed
                rule_id = str(existing["rule_id"]) if existing is not None else None

        if not changed:
            await db.commit()
            return DBMutateToolingExportPolicyResponse(
                ok=True,
                policy=_policy(policy_row),
                rule=_rule(existing)
                if request.action == "upsert_rule" and existing is not None
                else None,
                cleared=False,
                changed=False,
                previous_revision=previous_revision,
                revision=previous_revision,
                correlation_id=request.correlation_id,
            )

        revision = previous_revision + 1
        if request.action == "set_default":
            await db.execute(
                """
                UPDATE tooling_export_policy
                SET default_state=?, revision=?, initialized=1, updated_at=?
                WHERE singleton_id=1
                """,
                (request.state, revision, now),
            )
        elif request.action == "upsert_rule":
            assert rule_id is not None
            if existing is None:
                await db.execute(
                    """
                    INSERT INTO tooling_export_rules (
                        rule_id, peer_id, scope_type, scope_id, state,
                        actor_principal_id, reason, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rule_id,
                        request.peer_id,
                        request.scope_type,
                        request.scope_id,
                        request.state,
                        request.actor_principal_id,
                        request.reason,
                        now,
                        now,
                    ),
                )
            else:
                await db.execute(
                    """
                    UPDATE tooling_export_rules SET state=?, actor_principal_id=?,
                        reason=?, updated_at=? WHERE rule_id=?
                    """,
                    (
                        request.state,
                        request.actor_principal_id,
                        request.reason,
                        now,
                        rule_id,
                    ),
                )
            result_row = await (
                await db.execute("SELECT * FROM tooling_export_rules WHERE rule_id=?", (rule_id,))
            ).fetchone()
            result_rule = _rule(result_row)
        else:
            await db.execute("DELETE FROM tooling_export_rules WHERE rule_id=?", (rule_id,))

        audit_id = f"toolexportaudit_{uuid4().hex}"
        await db.execute(
            """
            UPDATE tooling_export_policy
            SET revision=?, initialized=1, updated_at=? WHERE singleton_id=1
            """,
            (revision, now),
        )
        await db.execute(
            """
            INSERT INTO tooling_export_policy_audit (
                audit_id, revision, action, rule_id, peer_id, scope_type,
                scope_id, previous_state, new_state, actor_principal_id,
                reason, correlation_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                audit_id,
                revision,
                request.action,
                rule_id,
                request.peer_id,
                request.scope_type,
                request.scope_id,
                previous_state,
                request.state,
                request.actor_principal_id,
                request.reason,
                request.correlation_id,
                now,
            ),
        )
        await db.commit()
        updated_policy_row = await (
            await db.execute("SELECT * FROM tooling_export_policy WHERE singleton_id=1")
        ).fetchone()
        return DBMutateToolingExportPolicyResponse(
            ok=True,
            policy=_policy(updated_policy_row),
            rule=result_rule,
            cleared=cleared,
            changed=True,
            audit_id=audit_id,
            previous_revision=previous_revision,
            revision=revision,
            correlation_id=request.correlation_id,
        )
    except Exception:
        await db.rollback()
        raise
    finally:
        await db.close()


async def get_tooling_mesh_switches(db_path: str) -> ToolingMeshKillSwitches:
    """Read directional switches without activating either one in G012."""

    db = await _connect(db_path)
    try:
        row = await (
            await db.execute("SELECT * FROM tooling_mesh_switches WHERE singleton_id=1")
        ).fetchone()
        if row is None:
            raise RuntimeError("Tooling export migration 014 is incomplete")
        return _switches(row)
    finally:
        await db.close()


async def set_tooling_mesh_switches(
    db_path: str,
    request: DBSetToolingMeshSwitchesRequest,
) -> DBSetToolingMeshSwitchesResponse:
    """Optimistically persist both directional controls and one audit record."""

    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        row = await (
            await db.execute("SELECT * FROM tooling_mesh_switches WHERE singleton_id=1")
        ).fetchone()
        if row is None:
            raise RuntimeError("Tooling export migration 014 is incomplete")
        previous_revision = int(row["revision"])
        current = _switches(row)
        if previous_revision != request.expected_revision:
            await db.rollback()
            return DBSetToolingMeshSwitchesResponse(
                ok=False,
                switches=current,
                previous_revision=previous_revision,
                revision=previous_revision,
                error="mesh_tooling_switch_revision_conflict",
                correlation_id=request.correlation_id,
            )
        changed = (
            current.provider_mesh_tooling_enabled != request.provider_mesh_tooling_enabled
            or current.consumer_mesh_tooling_enabled != request.consumer_mesh_tooling_enabled
        )
        if not changed:
            await db.commit()
            return DBSetToolingMeshSwitchesResponse(
                ok=True,
                switches=current,
                previous_revision=previous_revision,
                revision=previous_revision,
                changed=False,
                correlation_id=request.correlation_id,
            )
        revision = previous_revision + 1
        now = time.time()
        await db.execute(
            """
            UPDATE tooling_mesh_switches SET
                provider_mesh_tooling_enabled=?, consumer_mesh_tooling_enabled=?,
                revision=?, updated_at=? WHERE singleton_id=1
            """,
            (
                request.provider_mesh_tooling_enabled,
                request.consumer_mesh_tooling_enabled,
                revision,
                now,
            ),
        )
        await db.execute(
            """
            INSERT INTO tooling_mesh_switch_audit (
                audit_id, revision, provider_mesh_tooling_enabled,
                consumer_mesh_tooling_enabled, actor_principal_id, reason,
                correlation_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"toolmeshswitch_{uuid4().hex}",
                revision,
                request.provider_mesh_tooling_enabled,
                request.consumer_mesh_tooling_enabled,
                request.actor_principal_id,
                request.reason,
                request.correlation_id,
                now,
            ),
        )
        await db.commit()
        updated = await (
            await db.execute("SELECT * FROM tooling_mesh_switches WHERE singleton_id=1")
        ).fetchone()
        return DBSetToolingMeshSwitchesResponse(
            ok=True,
            switches=_switches(updated),
            previous_revision=previous_revision,
            revision=revision,
            changed=True,
            correlation_id=request.correlation_id,
        )
    except Exception:
        await db.rollback()
        raise
    finally:
        await db.close()
