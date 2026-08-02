"""Durable CAS boundary for atomic G013 Tooling mesh enforcement activation."""

from __future__ import annotations

import json
import time
from uuid import uuid4

import aiosqlite

from app.services.db.sqlite_connection import close_database, open_database
from app.shared.contracts.models.db import (
    DBActivateToolingMeshEnforcementRequest,
    DBActivateToolingMeshEnforcementResponse,
    DBGetToolingMeshActivationStateResponse,
    DBToolingMeshActivationComponentVersions,
    DBToolingMeshActivationState,
)

_REQUIRED_COMPONENT_SCHEMA_VERSIONS = {
    "projection_transport": 2,
    "targeted_invalidation": 2,
    "normalized_catalog": 2,
    "consumer_binding": 2,
    "provider_discovery": 2,
    "prepare_enforcement": 2,
    "execute_enforcement": 2,
    "typed_exposure_ledger": 1,
    "inbound_sync_bridge": 1,
    "execution_rpc_evidence": 1,
    "exact_method_set": 1,
    "mutation_invalidation": 1,
    "conditional_legacy_retirement": 1,
    "startup_downgrade_guard": 1,
}


def _canonical_versions(versions: DBToolingMeshActivationComponentVersions) -> str:
    return json.dumps(versions.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))


def _state(row: aiosqlite.Row) -> DBToolingMeshActivationState:
    return DBToolingMeshActivationState(
        active=bool(row["active"]),
        legacy_guard_retired=bool(row["legacy_guard_retired"]),
        revision=int(row["revision"]),
        component_schema_versions=DBToolingMeshActivationComponentVersions.model_validate_json(
            str(row["component_schema_versions_json"])
        ),
        activated_at=row["activated_at"],
        audit_id=row["audit_id"],
        updated_at=float(row["updated_at"]),
    )


async def _connect(db_path: str) -> aiosqlite.Connection:
    return await open_database(db_path, row_factory=aiosqlite.Row)


async def get_tooling_mesh_activation_state(
    db_path: str,
) -> DBGetToolingMeshActivationStateResponse:
    db = await _connect(db_path)
    try:
        row = await (
            await db.execute("SELECT * FROM tooling_mesh_activation_state WHERE singleton_id=1")
        ).fetchone()
        if row is None:
            raise RuntimeError("tooling_mesh_activation_state_missing")
        return DBGetToolingMeshActivationStateResponse(state=_state(row))
    finally:
        await close_database(db)


async def activate_tooling_mesh_enforcement(
    db_path: str, request: DBActivateToolingMeshEnforcementRequest
) -> DBActivateToolingMeshEnforcementResponse:
    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        row = await (
            await db.execute("SELECT * FROM tooling_mesh_activation_state WHERE singleton_id=1")
        ).fetchone()
        if row is None:
            raise RuntimeError("tooling_mesh_activation_state_missing")
        current = _state(row)
        requested_json = _canonical_versions(request.component_schema_versions)
        if request.component_schema_versions.model_dump() != _REQUIRED_COMPONENT_SCHEMA_VERSIONS:
            await db.rollback()
            return DBActivateToolingMeshEnforcementResponse(
                ok=False,
                state=current,
                previous_revision=current.revision,
                revision=current.revision,
                error="tooling_mesh_activation_components_not_ready",
                correlation_id=request.correlation_id,
            )
        if current.active:
            if _canonical_versions(current.component_schema_versions) == requested_json:
                await db.rollback()
                return DBActivateToolingMeshEnforcementResponse(
                    ok=True,
                    changed=False,
                    state=current,
                    previous_revision=current.revision,
                    revision=current.revision,
                    correlation_id=request.correlation_id,
                )
            await db.rollback()
            return DBActivateToolingMeshEnforcementResponse(
                ok=False,
                state=current,
                previous_revision=current.revision,
                revision=current.revision,
                error="tooling_mesh_activation_state_conflict",
                correlation_id=request.correlation_id,
            )
        if current.revision != request.expected_revision:
            await db.rollback()
            return DBActivateToolingMeshEnforcementResponse(
                ok=False,
                state=current,
                previous_revision=current.revision,
                revision=current.revision,
                error="tooling_mesh_activation_revision_conflict",
                correlation_id=request.correlation_id,
            )

        now = time.time()
        revision = current.revision + 1
        audit_id = f"toolingmeshactivation_{uuid4().hex}"
        await db.execute(
            """INSERT INTO tooling_mesh_activation_audit (
                   audit_id, previous_revision, revision, component_schema_versions_json,
                   actor_principal_id, reason, correlation_id, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                audit_id,
                current.revision,
                revision,
                requested_json,
                request.actor_principal_id,
                request.reason,
                request.correlation_id,
                now,
            ),
        )
        await db.execute(
            """UPDATE tooling_mesh_activation_state
               SET active=1, legacy_guard_retired=1, revision=?,
                   component_schema_versions_json=?, activated_at=?, audit_id=?, updated_at=?
               WHERE singleton_id=1 AND revision=? AND active=0""",
            (revision, requested_json, now, audit_id, now, current.revision),
        )
        changed = await db.execute("SELECT changes()")
        changed_row = await changed.fetchone()
        if changed_row is None or int(changed_row[0]) != 1:
            await db.rollback()
            latest = await get_tooling_mesh_activation_state(db_path)
            return DBActivateToolingMeshEnforcementResponse(
                ok=False,
                state=latest.state,
                previous_revision=latest.state.revision,
                revision=latest.state.revision,
                error="tooling_mesh_activation_revision_conflict",
                correlation_id=request.correlation_id,
            )
        await db.commit()
        updated = await (
            await db.execute("SELECT * FROM tooling_mesh_activation_state WHERE singleton_id=1")
        ).fetchone()
        state = _state(updated)
        return DBActivateToolingMeshEnforcementResponse(
            ok=True,
            changed=True,
            state=state,
            previous_revision=current.revision,
            revision=state.revision,
            correlation_id=request.correlation_id,
        )
    except Exception:
        await db.rollback()
        raise
    finally:
        await close_database(db)
