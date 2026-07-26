"""Atomic durable Tooling identity reconciliation.

This module is owned by the DB service because identity migration spans Tooling
authority and catalog tables.  It must never be composed from independent
``DB.ExecuteSQL`` calls.
"""

from __future__ import annotations

import contextlib
import json
from typing import Any
from uuid import uuid4

import aiosqlite

from app.helpers.aurora_logger import log_error
from app.shared.contracts.models.db import (
    DBAllocateToolIdentityRequest,
    DBAllocateToolIdentityResponse,
    DBReconcileToolIdentityRequest,
    DBReconcileToolIdentityResponse,
    DBResolveToolIdentityAliasesResponse,
    DBToolIdentityRekeyCounts,
)


def _canonical_id(stable_peer_id: str, tool_contract_id: str) -> str:
    from urllib.parse import quote

    return (
        f"aurora-tool:v1:{quote(stable_peer_id, safe='-._~')}:Tooling:"
        f"{quote(tool_contract_id, safe='-._~')}"
    )


class ToolIdentityCollisionError(ValueError):
    """A canonical identity or legacy alias claimed conflicting authority."""

    def __init__(
        self,
        reason_code: str,
        *,
        existing_canonical_global_tool_id: str | None = None,
        conflicting_legacy_global_tool_id: str | None = None,
    ) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.existing_canonical_global_tool_id = existing_canonical_global_tool_id
        self.conflicting_legacy_global_tool_id = conflicting_legacy_global_tool_id


async def _connect(db_path: str) -> aiosqlite.Connection:
    db = await aiosqlite.connect(db_path)
    await db.execute("PRAGMA foreign_keys = ON")
    db.row_factory = aiosqlite.Row
    return db


def _rekey_json(
    value: object,
    aliases: set[str],
    canonical_global_tool_id: str,
    *,
    parent_key: str | None = None,
) -> tuple[object, bool]:
    """Rewrite only authority-bearing tool ID fields, never arbitrary strings."""

    scalar_keys = {"global_tool_id", "canonical_global_tool_id"}
    list_keys = {"reviewed_global_tool_ids", "removed_global_tool_ids"}
    if isinstance(value, dict):
        changed = False
        rewritten: dict[object, object] = {}
        for key, child in value.items():
            key_text = str(key)
            if key_text in scalar_keys and isinstance(child, str) and child in aliases:
                rewritten[key] = canonical_global_tool_id
                changed = True
                continue
            next_child, child_changed = _rekey_json(
                child,
                aliases,
                canonical_global_tool_id,
                parent_key=key_text,
            )
            rewritten[key] = next_child
            changed = changed or child_changed
        return rewritten, changed
    if isinstance(value, list):
        changed = False
        rewritten_list: list[object] = []
        for child in value:
            if parent_key in list_keys and isinstance(child, str) and child in aliases:
                rewritten_list.append(canonical_global_tool_id)
                changed = True
                continue
            next_child, child_changed = _rekey_json(
                child,
                aliases,
                canonical_global_tool_id,
                parent_key=parent_key,
            )
            rewritten_list.append(next_child)
            changed = changed or child_changed
        if parent_key in list_keys:
            deduplicated: list[object] = []
            for child in rewritten_list:
                if child not in deduplicated:
                    deduplicated.append(child)
            changed = changed or deduplicated != rewritten_list
            rewritten_list = deduplicated
        return rewritten_list, changed
    return value, False


_JSON_COLUMNS = {
    ("tooling_approval_grants", ("grant_id",), "metadata_json"),
    ("tooling_approval_requests", ("approval_request_id",), "request_json"),
    ("tooling_approval_requests", ("approval_request_id",), "prepared_json"),
    ("tooling_approval_tokens", ("token_hash",), "claims_json"),
    (
        "tooling_remote_catalog_snapshots",
        ("peer_id", "service_instance_id"),
        "tools_json",
    ),
}


async def _rekey_json_column(
    db: aiosqlite.Connection,
    *,
    table: str,
    key_columns: tuple[str, ...],
    json_column: str,
    aliases: set[str],
    canonical_global_tool_id: str,
) -> set[tuple[object, ...]]:
    """Rewrite a trusted JSON column and return changed primary keys."""

    if (table, key_columns, json_column) not in _JSON_COLUMNS:
        raise ValueError("unsupported Tooling identity JSON column")
    selected_columns = ", ".join((*key_columns, json_column))
    rows = await (await db.execute(f"SELECT {selected_columns} FROM {table}")).fetchall()
    changed_keys: set[tuple[object, ...]] = set()
    for row in rows:
        raw = row[len(key_columns)]
        if raw is None:
            continue
        try:
            decoded = json.loads(str(raw))
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError(
                f"invalid JSON in Tooling identity authority/cache column {table}.{json_column}"
            ) from error
        rewritten, changed = _rekey_json(decoded, aliases, canonical_global_tool_id)
        if not changed:
            continue
        key_values = tuple(row[index] for index in range(len(key_columns)))
        where = " AND ".join(f"{column} = ?" for column in key_columns)
        cursor = await db.execute(
            f"UPDATE {table} SET {json_column} = ? WHERE {where}",
            (
                json.dumps(rewritten, sort_keys=True, separators=(",", ":")),
                *key_values,
            ),
        )
        if cursor.rowcount != 1:
            raise ValueError(f"Tooling identity JSON row changed during update: {table}")
        changed_keys.add(key_values)
    return changed_keys


async def _record_conflict(
    db_path: str,
    request: DBReconcileToolIdentityRequest,
    collision: ToolIdentityCollisionError,
) -> str:
    """Persist review evidence after the authority transaction has rolled back."""

    conflict_id = f"toolconf_{uuid4().hex}"
    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        await db.execute(
            """
            INSERT INTO tooling_tool_identity_conflicts (
                conflict_id, requested_canonical_global_tool_id,
                existing_canonical_global_tool_id,
                conflicting_legacy_global_tool_id, reason_code,
                review_status, details_json
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
            """,
            (
                conflict_id,
                request.canonical_global_tool_id,
                collision.existing_canonical_global_tool_id,
                collision.conflicting_legacy_global_tool_id,
                collision.reason_code,
                json.dumps(
                    {
                        "source_kind": request.source_kind,
                        "stable_peer_id": request.stable_peer_id,
                        "stable_source_id": request.stable_source_id,
                        "tool_contract_id": request.tool_contract_id,
                    },
                    sort_keys=True,
                ),
            ),
        )
        affected_canonical_ids = {
            request.canonical_global_tool_id,
            collision.existing_canonical_global_tool_id,
        }
        canonical_ids = sorted(value for value in affected_canonical_ids if value)
        affected_ids = {
            *canonical_ids,
            *request.legacy_global_tool_ids,
            collision.conflicting_legacy_global_tool_id,
        }
        if canonical_ids:
            canonical_placeholders = ", ".join("?" for _ in canonical_ids)
            alias_rows = await (
                await db.execute(
                    f"""
                    SELECT legacy_global_tool_id
                    FROM tooling_tool_identity_aliases
                    WHERE canonical_global_tool_id IN ({canonical_placeholders})
                    """,
                    canonical_ids,
                )
            ).fetchall()
            affected_ids.update(str(row[0]) for row in alias_rows)
        quarantined_ids = sorted(value for value in affected_ids if value)
        for canonical_id in quarantined_ids:
            await db.execute(
                """
                UPDATE tooling_tool_identities
                SET identity_status = 'collision', updated_at = CURRENT_TIMESTAMP
                WHERE canonical_global_tool_id = ?
                """,
                (canonical_id,),
            )
        placeholders = ", ".join("?" for _ in quarantined_ids)
        await db.execute(
            f"""
            UPDATE tooling_approval_grants
            SET active = 0,
                metadata_json = json_set(
                    CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{{}}' END,
                    '$.needs_review', json('true'),
                    '$.stale_reason', 'tool_identity_collision'
                )
            WHERE global_tool_id IN ({placeholders})
            """,
            quarantined_ids,
        )
        await db.execute(
            f"""
            UPDATE tooling_approval_tokens SET used = 1
            WHERE json_extract(
                CASE WHEN json_valid(claims_json) THEN claims_json ELSE '{{}}' END,
                '$.global_tool_id'
            ) IN ({placeholders})
            """,
            quarantined_ids,
        )
        await db.execute(
            f"""
            UPDATE tooling_approval_requests SET used = 1
            WHERE json_extract(
                    CASE WHEN json_valid(request_json) THEN request_json ELSE '{{}}' END,
                    '$.global_tool_id'
                  ) IN ({placeholders})
               OR json_extract(
                    CASE WHEN json_valid(prepared_json) THEN prepared_json ELSE '{{}}' END,
                    '$.global_tool_id'
                  ) IN ({placeholders})
            """,
            (*quarantined_ids, *quarantined_ids),
        )
        await db.execute(
            f"""
            UPDATE tooling_remote_catalog_snapshots SET stale = 1
            WHERE EXISTS (
                SELECT 1
                FROM json_each(
                    CASE WHEN json_valid(tools_json) THEN tools_json ELSE '[]' END
                ) AS tool
                WHERE json_extract(tool.value, '$.global_tool_id') IN ({placeholders})
            )
            """,
            quarantined_ids,
        )
        await db.commit()
    except Exception:
        with contextlib.suppress(Exception):
            await db.rollback()
        raise
    finally:
        await db.close()
    return conflict_id


async def reconcile_tool_identity(
    db_path: str,
    request: DBReconcileToolIdentityRequest,
) -> DBReconcileToolIdentityResponse:
    """Establish identity, claim aliases, and re-key all dependent state once."""

    db: aiosqlite.Connection | None = None
    created = False
    inserted_aliases = 0
    aliases = set(request.legacy_global_tool_ids)
    counts = DBToolIdentityRekeyCounts()
    try:
        db = await _connect(db_path)
        await db.execute("BEGIN IMMEDIATE")
        canonical_row = await (
            await db.execute(
                "SELECT * FROM tooling_tool_identities WHERE canonical_global_tool_id = ?",
                (request.canonical_global_tool_id,),
            )
        ).fetchone()
        source_row = await (
            await db.execute(
                """
                SELECT canonical_global_tool_id FROM tooling_tool_identities
                WHERE stable_peer_id = ? AND source_kind = ?
                  AND stable_source_id = ? AND provider_tool_id = ?
                """,
                (
                    request.stable_peer_id,
                    request.source_kind,
                    request.stable_source_id,
                    request.provider_tool_id,
                ),
            )
        ).fetchone()
        contract_row = await (
            await db.execute(
                """
                SELECT canonical_global_tool_id FROM tooling_tool_identities
                WHERE stable_peer_id = ? AND tool_contract_id = ?
                """,
                (request.stable_peer_id, request.tool_contract_id),
            )
        ).fetchone()
        for row, reason in (
            (source_row, "source_identity_collision"),
            (contract_row, "tool_contract_id_collision"),
        ):
            if (
                row is not None
                and row["canonical_global_tool_id"] != request.canonical_global_tool_id
            ):
                raise ToolIdentityCollisionError(
                    reason,
                    existing_canonical_global_tool_id=row["canonical_global_tool_id"],
                )

        immutable = {
            "stable_peer_id": request.stable_peer_id,
            "identity_version": request.identity_version,
            "tool_contract_id": request.tool_contract_id,
            "source_kind": request.source_kind,
            "stable_source_id": request.stable_source_id,
            "provider_tool_id": request.provider_tool_id,
            "share_group_id": request.share_group_id,
        }
        if canonical_row is not None:
            if canonical_row["identity_status"] != "canonical":
                raise ToolIdentityCollisionError(
                    "identity_under_collision_review",
                    existing_canonical_global_tool_id=request.canonical_global_tool_id,
                )
            if any(canonical_row[key] != value for key, value in immutable.items()):
                raise ToolIdentityCollisionError(
                    "canonical_identity_collision",
                    existing_canonical_global_tool_id=request.canonical_global_tool_id,
                )
            await db.execute(
                """
                UPDATE tooling_tool_identities
                SET share_group_label = ?, current_local_name = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE canonical_global_tool_id = ?
                """,
                (
                    request.share_group_label,
                    request.current_local_name,
                    request.canonical_global_tool_id,
                ),
            )
        else:
            prior_alias = await (
                await db.execute(
                    """
                    SELECT canonical_global_tool_id FROM tooling_tool_identity_aliases
                    WHERE legacy_global_tool_id = ?
                    """,
                    (request.canonical_global_tool_id,),
                )
            ).fetchone()
            if prior_alias is not None:
                raise ToolIdentityCollisionError(
                    "canonical_id_previously_claimed_as_alias",
                    existing_canonical_global_tool_id=prior_alias["canonical_global_tool_id"],
                    conflicting_legacy_global_tool_id=request.canonical_global_tool_id,
                )
            await db.execute(
                """
                INSERT INTO tooling_tool_identities (
                    canonical_global_tool_id, stable_peer_id, identity_version,
                    tool_contract_id, source_kind, stable_source_id,
                    provider_tool_id, share_group_id, share_group_label,
                    current_local_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request.canonical_global_tool_id,
                    request.stable_peer_id,
                    request.identity_version,
                    request.tool_contract_id,
                    request.source_kind,
                    request.stable_source_id,
                    request.provider_tool_id,
                    request.share_group_id,
                    request.share_group_label,
                    request.current_local_name,
                ),
            )
            created = True

        for alias in sorted(aliases):
            canonical_alias_row = await (
                await db.execute(
                    """
                    SELECT canonical_global_tool_id FROM tooling_tool_identities
                    WHERE canonical_global_tool_id = ?
                    """,
                    (alias,),
                )
            ).fetchone()
            if canonical_alias_row is not None:
                raise ToolIdentityCollisionError(
                    "legacy_alias_is_canonical_identity",
                    existing_canonical_global_tool_id=alias,
                    conflicting_legacy_global_tool_id=alias,
                )
            alias_row = await (
                await db.execute(
                    """
                    SELECT canonical_global_tool_id FROM tooling_tool_identity_aliases
                    WHERE stable_peer_id = ? AND legacy_global_tool_id = ?
                    """,
                    (request.stable_peer_id, alias),
                )
            ).fetchone()
            if alias_row is not None:
                if alias_row["canonical_global_tool_id"] != request.canonical_global_tool_id:
                    raise ToolIdentityCollisionError(
                        "legacy_alias_collision",
                        existing_canonical_global_tool_id=alias_row["canonical_global_tool_id"],
                        conflicting_legacy_global_tool_id=alias,
                    )
                continue
            await db.execute(
                """
                INSERT INTO tooling_tool_identity_aliases (
                    stable_peer_id, legacy_global_tool_id,
                    canonical_global_tool_id, alias_kind
                ) VALUES (?, ?, ?, ?)
                """,
                (
                    request.stable_peer_id,
                    alias,
                    request.canonical_global_tool_id,
                    request.alias_kind,
                ),
            )
            inserted_aliases += 1

        if aliases:
            placeholders = ", ".join("?" for _ in aliases)
            grant_cursor = await db.execute(
                f"""
                UPDATE tooling_approval_grants SET global_tool_id = ?
                WHERE global_tool_id IN ({placeholders})
                """,
                (request.canonical_global_tool_id, *sorted(aliases)),
            )
            counts.approval_grants = grant_cursor.rowcount
            grant_metadata_keys = await _rekey_json_column(
                db,
                table="tooling_approval_grants",
                key_columns=("grant_id",),
                json_column="metadata_json",
                aliases=aliases,
                canonical_global_tool_id=request.canonical_global_tool_id,
            )
            counts.approval_grant_metadata = len(grant_metadata_keys)
            request_keys = await _rekey_json_column(
                db,
                table="tooling_approval_requests",
                key_columns=("approval_request_id",),
                json_column="request_json",
                aliases=aliases,
                canonical_global_tool_id=request.canonical_global_tool_id,
            )
            prepared_keys = await _rekey_json_column(
                db,
                table="tooling_approval_requests",
                key_columns=("approval_request_id",),
                json_column="prepared_json",
                aliases=aliases,
                canonical_global_tool_id=request.canonical_global_tool_id,
            )
            counts.approval_requests = len(request_keys | prepared_keys)
            token_keys = await _rekey_json_column(
                db,
                table="tooling_approval_tokens",
                key_columns=("token_hash",),
                json_column="claims_json",
                aliases=aliases,
                canonical_global_tool_id=request.canonical_global_tool_id,
            )
            counts.approval_tokens = len(token_keys)
            snapshot_keys = await _rekey_json_column(
                db,
                table="tooling_remote_catalog_snapshots",
                key_columns=("peer_id", "service_instance_id"),
                json_column="tools_json",
                aliases=aliases,
                canonical_global_tool_id=request.canonical_global_tool_id,
            )
            counts.remote_catalog_snapshots = len(snapshot_keys)
            for peer_id, service_instance_id in snapshot_keys:
                await db.execute(
                    """
                    UPDATE tooling_remote_catalog_snapshots SET stale = 1
                    WHERE peer_id = ? AND service_instance_id = ?
                    """,
                    (peer_id, service_instance_id),
                )
            for alias in sorted(aliases):
                alias_tombstone = await (
                    await db.execute(
                        """
                        SELECT peer_id, service_instance_id, reason, removed_at
                        FROM tooling_remote_catalog_tombstones
                        WHERE global_tool_id = ?
                        """,
                        (alias,),
                    )
                ).fetchone()
                if alias_tombstone is None:
                    continue
                canonical_tombstone = await (
                    await db.execute(
                        """
                        SELECT peer_id, service_instance_id, reason, removed_at
                        FROM tooling_remote_catalog_tombstones
                        WHERE global_tool_id = ?
                        """,
                        (request.canonical_global_tool_id,),
                    )
                ).fetchone()
                if canonical_tombstone is not None:
                    if tuple(alias_tombstone) != tuple(canonical_tombstone):
                        raise ToolIdentityCollisionError(
                            "tombstone_identity_collision",
                            existing_canonical_global_tool_id=request.canonical_global_tool_id,
                            conflicting_legacy_global_tool_id=alias,
                        )
                    await db.execute(
                        "DELETE FROM tooling_remote_catalog_tombstones WHERE global_tool_id = ?",
                        (alias,),
                    )
                else:
                    await db.execute(
                        """
                        UPDATE tooling_remote_catalog_tombstones
                        SET global_tool_id = ? WHERE global_tool_id = ?
                        """,
                        (request.canonical_global_tool_id, alias),
                    )
                counts.remote_catalog_tombstones += 1

        await db.commit()
        total_rekeyed = sum(counts.model_dump().values())
        return DBReconcileToolIdentityResponse(
            success=True,
            canonical_global_tool_id=request.canonical_global_tool_id,
            aliases=sorted(aliases),
            created=created,
            idempotent=not created and inserted_aliases == 0 and total_rekeyed == 0,
            rekeyed=counts,
        )
    except ToolIdentityCollisionError as collision:
        if db is not None:
            with contextlib.suppress(Exception):
                await db.rollback()
        conflict_id = await _record_conflict(db_path, request, collision)
        return DBReconcileToolIdentityResponse(
            success=False,
            canonical_global_tool_id=request.canonical_global_tool_id,
            aliases=sorted(aliases),
            conflict_id=conflict_id,
            error_code=collision.reason_code,
            error="Tool identity collision requires review",
        )
    except Exception as error:
        if db is not None:
            with contextlib.suppress(Exception):
                await db.rollback()
        log_error(f"Atomic Tooling identity reconciliation failed: {error}")
        return DBReconcileToolIdentityResponse(
            success=False,
            canonical_global_tool_id=request.canonical_global_tool_id,
            aliases=sorted(aliases),
            error_code="tool_identity_storage_error",
            error=str(error),
        )
    finally:
        if db is not None:
            await db.close()


async def allocate_tool_identity(
    db_path: str,
    request: DBAllocateToolIdentityRequest,
) -> DBAllocateToolIdentityResponse:
    """Persist/reuse a one-time contract ID, then reconcile its authority state.

    Allocation is serialized with ``BEGIN IMMEDIATE``.  A locator can never be
    rebound to different immutable source coordinates; such attempts fail
    closed without changing either the allocation or identity registry.
    """

    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        row = await (
            await db.execute(
                """
                SELECT * FROM tooling_tool_identity_allocations
                WHERE stable_peer_id = ? AND legacy_identity_locator = ?
                """,
                (request.stable_peer_id, request.legacy_identity_locator),
            )
        ).fetchone()
        immutable = {
            "source_kind": request.source_kind,
            "stable_source_id": request.stable_source_id,
            "provider_tool_id": request.provider_tool_id,
            "share_group_id": request.share_group_id,
        }
        if row is not None:
            if any(row[key] != value for key, value in immutable.items()):
                await db.rollback()
                canonical = _canonical_id(
                    request.stable_peer_id, str(row["allocated_tool_contract_id"])
                )
                return DBAllocateToolIdentityResponse(
                    success=False,
                    canonical_global_tool_id=canonical,
                    allocated_tool_contract_id=str(row["allocated_tool_contract_id"]),
                    error_code="legacy_identity_locator_collision",
                    error="Legacy identity locator is already bound to another source",
                )
            tool_contract_id = str(row["allocated_tool_contract_id"])
        else:
            tool_contract_id = f"legacy.{uuid4().hex}"
            await db.execute(
                """
                INSERT INTO tooling_tool_identity_allocations (
                    stable_peer_id, legacy_identity_locator,
                    allocated_tool_contract_id, source_kind, stable_source_id,
                    provider_tool_id, share_group_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request.stable_peer_id,
                    request.legacy_identity_locator,
                    tool_contract_id,
                    request.source_kind,
                    request.stable_source_id,
                    request.provider_tool_id,
                    request.share_group_id,
                ),
            )
        await db.commit()
    except Exception as error:
        with contextlib.suppress(Exception):
            await db.rollback()
        log_error(f"Durable Tooling identity allocation failed: {error}")
        return DBAllocateToolIdentityResponse(
            success=False,
            canonical_global_tool_id="unallocated",
            allocated_tool_contract_id="unallocated",
            error_code="tool_identity_allocation_storage_error",
            error=str(error),
        )
    finally:
        await db.close()

    aliases = list(
        dict.fromkeys([request.legacy_identity_locator, *request.legacy_global_tool_ids])
    )
    canonical = _canonical_id(request.stable_peer_id, tool_contract_id)
    reconciled = await reconcile_tool_identity(
        db_path,
        DBReconcileToolIdentityRequest(
            canonical_global_tool_id=canonical,
            stable_peer_id=request.stable_peer_id,
            tool_contract_id=tool_contract_id,
            source_kind=request.source_kind,
            stable_source_id=request.stable_source_id,
            provider_tool_id=request.provider_tool_id,
            share_group_id=request.share_group_id,
            share_group_label=request.share_group_label,
            current_local_name=request.current_local_name,
            legacy_global_tool_ids=aliases,
            alias_kind="persisted_legacy_identity",
        ),
    )
    return DBAllocateToolIdentityResponse(
        **reconciled.model_dump(), allocated_tool_contract_id=tool_contract_id
    )


async def resolve_tool_identity_aliases(
    db_path: str,
    global_tool_ids: list[str],
    *,
    stable_peer_id: str | None = None,
) -> DBResolveToolIdentityAliasesResponse:
    """Resolve aliases durably while omitting unknown or quarantined identities."""

    if not global_tool_ids:
        return DBResolveToolIdentityAliasesResponse()
    unique_ids = list(dict.fromkeys(global_tool_ids))
    placeholders = ", ".join("?" for _ in unique_ids)
    db = await _connect(db_path)
    try:
        peer_predicate = "AND alias.stable_peer_id = ?" if stable_peer_id else ""
        parameters: tuple[object, ...] = (*unique_ids, *unique_ids)
        if stable_peer_id:
            parameters = (*parameters, stable_peer_id)
        rows = await (
            await db.execute(
                f"""
                SELECT requested_id, canonical_global_tool_id
                FROM (
                    SELECT canonical_global_tool_id AS requested_id,
                           canonical_global_tool_id
                    FROM tooling_tool_identities
                    WHERE canonical_global_tool_id IN ({placeholders})
                      AND identity_status = 'canonical'
                    UNION ALL
                    SELECT alias.legacy_global_tool_id AS requested_id,
                           alias.canonical_global_tool_id
                    FROM tooling_tool_identity_aliases AS alias
                    JOIN tooling_tool_identities AS identity
                      ON identity.canonical_global_tool_id = alias.canonical_global_tool_id
                    WHERE alias.legacy_global_tool_id IN ({placeholders})
                      AND identity.identity_status = 'canonical'
                      {peer_predicate}
                )
                """,
                parameters,
            )
        ).fetchall()
        candidates: dict[str, set[str]] = {}
        for row in rows:
            candidates.setdefault(str(row["requested_id"]), set()).add(
                str(row["canonical_global_tool_id"])
            )
        return DBResolveToolIdentityAliasesResponse(
            resolved={
                requested_id: next(iter(canonical_ids))
                for requested_id, canonical_ids in candidates.items()
                if len(canonical_ids) == 1
            }
        )
    finally:
        await db.close()
