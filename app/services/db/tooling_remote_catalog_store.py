"""Typed transactional store for recipient-specific remote Tooling projections."""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any
from uuid import uuid4

import aiosqlite
from pydantic import ValidationError

from app.shared.contracts.models.db import (
    DBAbortToolingRemoteCatalogSyncRequest,
    DBAbortToolingRemoteCatalogSyncResponse,
    DBAcceptToolingRemoteToolSchemaRequest,
    DBAcceptToolingRemoteToolSchemaResponse,
    DBAppendToolingRemoteCatalogPageRequest,
    DBAppendToolingRemoteCatalogPageResponse,
    DBBeginToolingRemoteCatalogSyncRequest,
    DBBeginToolingRemoteCatalogSyncResponse,
    DBCommitToolingRemoteCatalogSyncRequest,
    DBCommitToolingRemoteCatalogSyncResponse,
    DBFinalizeToolingRemoteCatalogPolicyRequest,
    DBFinalizeToolingRemoteCatalogPolicyResponse,
    DBGetToolingRemoteCatalogRequest,
    DBGetToolingRemoteCatalogResponse,
    DBImportLegacyToolingRemoteCatalogsRequest,
    DBImportLegacyToolingRemoteCatalogsResponse,
    DBPruneToolingRemoteCatalogRetentionRequest,
    DBPruneToolingRemoteCatalogRetentionResponse,
    DBRecoverToolingRemoteCatalogsRequest,
    DBRecoverToolingRemoteCatalogsResponse,
    DBResolveToolingRemoteToolAliasesRequest,
    DBResolveToolingRemoteToolAliasesResponse,
    DBSetToolingRemoteProviderAvailabilityRequest,
    DBSetToolingRemoteProviderAvailabilityResponse,
    DBToolingRemoteCatalogHeader,
    DBToolingRemoteCatalogTombstone,
    DBToolingRemoteCatalogTool,
    DBToolingRemoteRetentionProviderSummary,
)
from app.shared.contracts.models.tooling import (
    ToolingGetExportCatalogResponse,
    ToolingProjectionAuthorityRevision,
    ToolingProjectionBlockedTool,
    ToolingProjectionRetirement,
    ToolingToolInfo,
)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_tool_schema_hash(tool: ToolingToolInfo) -> str:
    """Hash only the callable schema whose change requires policy review."""

    return hashlib.sha256(
        _canonical_json(
            {
                "args_schema": tool.args_schema,
                "schema": tool.schema,
                "argument_visibility": tool.argument_visibility,
            }
        ).encode()
    ).hexdigest()


def compute_projection_page_hash(page: ToolingGetExportCatalogResponse) -> str:
    """Canonical hash for one bound page, excluding opaque cursor bytes."""

    payload = {
        "provider_peer_id": page.provider_peer_id,
        "service_instance_id": page.service_instance_id,
        "selected_protocol_tier": page.selected_protocol_tier,
        "authority_revision": page.authority_revision.model_dump(mode="json"),
        "projection_revision": page.projection_revision,
        "projection_digest": page.projection_digest,
        "page_index": page.page_index,
        "page_size": page.page_size,
        "tools": [tool.model_dump(mode="json") for tool in page.tools],
        "blocked_tools": [item.model_dump(mode="json") for item in page.blocked_tools],
        "retirements": [item.model_dump(mode="json") for item in page.retirements],
        "complete": page.complete,
        "total_count": page.total_count,
        "final_checksum": page.final_checksum,
    }
    return hashlib.sha256(_canonical_json(payload).encode()).hexdigest()


def compute_projection_checksum(
    tools: list[ToolingToolInfo],
    retirements: list[ToolingProjectionRetirement],
    blocked_tools: list[ToolingProjectionBlockedTool] | None = None,
) -> str:
    """Order-independent checksum for one complete normalized projection."""

    payload = {
        "tools": [
            tool.model_dump(mode="json")
            for tool in sorted(tools, key=lambda item: item.global_tool_id)
        ],
        "blocked_tools": [
            item.model_dump(mode="json")
            for item in sorted(blocked_tools or [], key=lambda item: item.tool.global_tool_id)
        ],
        "retirements": [
            item.model_dump(mode="json")
            for item in sorted(retirements, key=lambda item: item.global_tool_id)
        ],
    }
    return hashlib.sha256(_canonical_json(payload).encode()).hexdigest()


async def _connect(db_path: str) -> aiosqlite.Connection:
    db = await aiosqlite.connect(db_path)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA foreign_keys = ON")
    return db


def _authority(row: aiosqlite.Row) -> ToolingProjectionAuthorityRevision:
    return ToolingProjectionAuthorityRevision(
        catalog_revision=int(row["catalog_revision"]),
        export_policy_revision=int(row["export_policy_revision"]),
        auth_grant_revision=int(row["auth_grant_revision"]),
        manifest_revision=int(row["manifest_revision"]),
        switch_revision=int(row["switch_revision"]),
        protocol_revision=int(row["protocol_revision"]),
    )


def _header(row: aiosqlite.Row) -> DBToolingRemoteCatalogHeader:
    return DBToolingRemoteCatalogHeader(
        peer_id=str(row["peer_id"]),
        provider_id=str(row["provider_id"]),
        service_instance_id=str(row["service_instance_id"]),
        protocol_tier=str(row["protocol_tier"]),
        projection_revision=row["projection_revision"],
        projection_digest=row["projection_digest"],
        authority_revision=_authority(row),
        current_generation=int(row["current_generation"]),
        sync_state=str(row["sync_state"]),
        availability=str(row["availability"]),
        last_error_reason=row["last_error_reason"],
        committed_at=row["committed_at"],
        updated_at=float(row["updated_at"]),
    )


def _tool(row: aiosqlite.Row) -> DBToolingRemoteCatalogTool:
    return DBToolingRemoteCatalogTool(
        peer_id=str(row["peer_id"]),
        provider_id=str(row["provider_id"]),
        tool=ToolingToolInfo.model_validate_json(str(row["metadata_json"])),
        schema_hash=str(row["schema_hash"]),
        accepted_schema_hash=str(row["accepted_schema_hash"]),
        availability=str(row["availability"]),
        reason_code=str(row["reason_code"]),
        missing_permissions=json.loads(str(row["missing_permissions_json"])),
        active_generation=row["active_generation"],
        projection_revision=row["projection_revision"],
        authority_revision=_authority(row),
        review_required=bool(row["review_required"]),
        first_seen_at=float(row["first_seen_at"]),
        last_seen_at=float(row["last_seen_at"]),
        updated_at=float(row["updated_at"]),
    )


def _tombstone(row: aiosqlite.Row) -> DBToolingRemoteCatalogTombstone:
    return DBToolingRemoteCatalogTombstone(
        peer_id=str(row["peer_id"]),
        provider_id=str(row["provider_id"]),
        global_tool_id=str(row["global_tool_id"]),
        management_metadata=json.loads(str(row["management_metadata_json"])),
        accepted_schema_hash=str(row["accepted_schema_hash"]),
        availability=str(row["last_availability"]),
        reason_code=str(row["reason_code"]),
        compacted_at=float(row["compacted_at"]),
    )


def _management_tombstone_metadata(tool: ToolingToolInfo) -> dict[str, Any]:
    """Retain labels/provenance needed by local management, never callable schema."""

    return {
        key: value
        for key, value in {
            "global_tool_id": tool.global_tool_id,
            "local_name": tool.local_name,
            "name": tool.name,
            "display_name": tool.display_name,
            "provider_label": tool.provider_label,
            "source_type": tool.source_type,
            "source": tool.source,
            "source_id": tool.source_id,
            "share_group_id": tool.share_group_id,
            "share_group_label": tool.share_group_label,
            "advertised_name": tool.provenance.advertised_name,
            "stable_source_id": tool.provenance.stable_source_id,
            "provider_tool_id": tool.provenance.provider_tool_id,
        }.items()
        if value not in (None, "", [])
    }


def _authority_tuple(revision: ToolingProjectionAuthorityRevision) -> tuple[int, ...]:
    return (
        revision.catalog_revision,
        revision.export_policy_revision,
        revision.auth_grant_revision,
        revision.manifest_revision,
        revision.switch_revision,
        revision.protocol_revision,
    )


def _row_authority_tuple(row: aiosqlite.Row) -> tuple[int, ...]:
    return (
        int(row["catalog_revision"]),
        int(row["export_policy_revision"]),
        int(row["auth_grant_revision"]),
        int(row["manifest_revision"]),
        int(row["switch_revision"]),
        int(row["protocol_revision"]),
    )


def _replace_identity(value: Any, aliases: set[str], canonical: str) -> Any:
    if isinstance(value, str):
        return canonical if value in aliases else value
    if isinstance(value, list):
        return [_replace_identity(item, aliases, canonical) for item in value]
    if isinstance(value, dict):
        return {key: _replace_identity(item, aliases, canonical) for key, item in value.items()}
    return value


def _matches_remote_provider_payload(
    value: Any,
    *,
    peer_id: str,
    provider_id: str,
    service_instance_id: str,
) -> bool:
    """Require explicit peer plus provider/service ownership before JSON re-keying."""

    if not isinstance(value, dict) or value.get("provider_peer_id") != peer_id:
        return False
    payload_provider_id = value.get("provider_id")
    payload_service_instance_id = value.get("provider_service_instance_id")
    if payload_provider_id is not None and payload_provider_id != provider_id:
        return False
    if payload_service_instance_id is not None:
        return payload_service_instance_id == service_instance_id
    return payload_provider_id == provider_id


async def _rekey_remote_dependents(
    db: aiosqlite.Connection,
    *,
    peer_id: str,
    provider_id: str,
    service_instance_id: str,
    aliases: set[str],
    canonical: str,
) -> None:
    """Re-key exact durable references without matching display names."""

    if not aliases:
        return
    placeholders = ",".join("?" for _ in aliases)
    await db.execute(
        f"""UPDATE tooling_approval_grants SET global_tool_id=?
            WHERE provider_peer_id=? AND provider_service_instance_id=?
              AND global_tool_id IN ({placeholders})""",
        (canonical, peer_id, service_instance_id, *sorted(aliases)),
    )
    await db.execute(
        f"""UPDATE tooling_remote_catalog_tombstones SET global_tool_id=?
            WHERE peer_id=? AND service_instance_id=?
              AND global_tool_id IN ({placeholders})""",
        (canonical, peer_id, service_instance_id, *sorted(aliases)),
    )
    await db.execute(
        f"""UPDATE tooling_remote_catalog_retention_tombstones SET global_tool_id=?
            WHERE peer_id=? AND provider_id=?
              AND global_tool_id IN ({placeholders})""",
        (canonical, peer_id, provider_id, *sorted(aliases)),
    )

    grant_rows = await (
        await db.execute(
            """SELECT grant_id, metadata_json FROM tooling_approval_grants
               WHERE provider_peer_id=? AND provider_service_instance_id=?""",
            (peer_id, service_instance_id),
        )
    ).fetchall()
    for row in grant_rows:
        raw = row["metadata_json"]
        if not raw:
            continue
        try:
            parsed = json.loads(str(raw))
        except (TypeError, ValueError):
            continue
        replaced = _replace_identity(parsed, aliases, canonical)
        if replaced != parsed:
            await db.execute(
                "UPDATE tooling_approval_grants SET metadata_json=? WHERE grant_id=?",
                (_canonical_json(replaced), row["grant_id"]),
            )

    request_rows = await (
        await db.execute(
            """SELECT approval_request_id, request_json, prepared_json
               FROM tooling_approval_requests"""
        )
    ).fetchall()
    for row in request_rows:
        try:
            prepared = json.loads(str(row["prepared_json"]))
        except (TypeError, ValueError):
            continue
        if not _matches_remote_provider_payload(
            prepared,
            peer_id=peer_id,
            provider_id=provider_id,
            service_instance_id=service_instance_id,
        ):
            continue
        updates: dict[str, str] = {}
        for column in ("request_json", "prepared_json"):
            try:
                parsed = json.loads(str(row[column]))
            except (TypeError, ValueError):
                continue
            replaced = _replace_identity(parsed, aliases, canonical)
            if replaced != parsed:
                updates[column] = _canonical_json(replaced)
        if updates:
            assignments = ", ".join(f"{column}=?" for column in updates)
            await db.execute(
                f"UPDATE tooling_approval_requests SET {assignments} WHERE approval_request_id=?",
                (*updates.values(), row["approval_request_id"]),
            )

    token_rows = await (
        await db.execute("SELECT token_hash, claims_json FROM tooling_approval_tokens")
    ).fetchall()
    for row in token_rows:
        try:
            claims = json.loads(str(row["claims_json"]))
        except (TypeError, ValueError):
            continue
        if not _matches_remote_provider_payload(
            claims,
            peer_id=peer_id,
            provider_id=provider_id,
            service_instance_id=service_instance_id,
        ):
            continue
        replaced = _replace_identity(claims, aliases, canonical)
        if replaced != claims:
            await db.execute(
                "UPDATE tooling_approval_tokens SET claims_json=? WHERE token_hash=?",
                (_canonical_json(replaced), row["token_hash"]),
            )


async def _mark_positive_grants_for_schema_review(
    db: aiosqlite.Connection,
    *,
    peer_id: str,
    provider_id: str,
    global_tool_id: str,
    aliases: set[str],
    accepted_schema_hash: str,
    current_schema_hash: str,
) -> None:
    rows = await (
        await db.execute(
            """SELECT * FROM tooling_approval_grants
               WHERE active=1 AND (provider_peer_id=? OR provider_peer_id IS NULL)""",
            (peer_id,),
        )
    ).fetchall()
    identities = aliases | {global_tool_id}
    for row in rows:
        if (
            str(row["grant_scope"] or "") in {"deny_once", "deny_always"}
            or str(row["trust_tier"] or "") == "blocked"
        ):
            continue
        metadata: dict[str, Any]
        try:
            metadata = json.loads(str(row["metadata_json"] or "{}"))
        except (TypeError, ValueError):
            metadata = {}
        reviewed = set(metadata.get("reviewed_global_tool_ids") or [])
        matches = (
            str(row["global_tool_id"] or "") in identities
            or (bool(row["include_future_tools"]) and row["provider_peer_id"] == peer_id)
            or bool(reviewed & identities)
        )
        if not matches:
            continue
        metadata.update(
            {
                "needs_review": True,
                "review_reason": "remote_tool_schema_changed",
                "expected_schema_hash": accepted_schema_hash,
                "current_schema_hash": current_schema_hash,
                "provider_id": provider_id,
                "global_tool_id": global_tool_id,
            }
        )
        await db.execute(
            "UPDATE tooling_approval_grants SET metadata_json=? WHERE grant_id=?",
            (_canonical_json(metadata), row["grant_id"]),
        )


async def _reject_alias_conflict(
    db: aiosqlite.Connection,
    sync: aiosqlite.Row,
    reason: str,
    correlation_id: str | None,
    *,
    alias: str | None = None,
    requested_canonical: str | None = None,
    existing_canonical: str | None = None,
) -> DBCommitToolingRemoteCatalogSyncResponse:
    await db.execute(
        """INSERT INTO tooling_remote_tool_identity_conflicts (
               conflict_id, peer_id, provider_id, sync_id, legacy_global_tool_id,
               requested_canonical_global_tool_id, existing_canonical_global_tool_id,
               reason_code, projection_revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            f"toolidentityconflict_{uuid4().hex}",
            sync["peer_id"],
            sync["provider_id"],
            sync["sync_id"],
            alias,
            requested_canonical,
            existing_canonical,
            reason,
            sync["projection_revision"],
            time.time(),
        ),
    )
    return await _reject_staged_sync(db, sync, reason, correlation_id)


async def begin_tooling_remote_catalog_sync(
    db_path: str, request: DBBeginToolingRemoteCatalogSyncRequest
) -> DBBeginToolingRemoteCatalogSyncResponse:
    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        now = time.time()
        row = await (
            await db.execute(
                """SELECT * FROM tooling_remote_catalog_headers
                   WHERE peer_id=? AND provider_id=?""",
                (request.peer_id, request.provider_id),
            )
        ).fetchone()
        base_generation = int(row["current_generation"]) if row is not None else 0
        if base_generation != request.expected_base_generation:
            await db.rollback()
            return DBBeginToolingRemoteCatalogSyncResponse(
                ok=False,
                sync_id=request.sync_id,
                base_generation=base_generation,
                error="remote_catalog_generation_conflict",
            )
        if row is None:
            await db.execute(
                """INSERT INTO tooling_remote_catalog_headers (
                       peer_id, provider_id, service_instance_id, protocol_tier,
                       current_generation, sync_state, availability, updated_at
                   ) VALUES (?, ?, ?, 'legacy_unsupported', 0, 'idle', 'stale', ?)""",
                (request.peer_id, request.provider_id, request.service_instance_id, now),
            )
        await db.execute(
            """INSERT INTO tooling_remote_catalog_syncs (
                   sync_id, peer_id, provider_id, service_instance_id, protocol_tier,
                   projection_revision, projection_digest, catalog_revision,
                   export_policy_revision, auth_grant_revision, manifest_revision,
                   switch_revision, protocol_revision, page_size,
                   expected_base_generation, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                request.sync_id,
                request.peer_id,
                request.provider_id,
                request.service_instance_id,
                request.protocol_tier,
                request.projection_revision,
                request.projection_digest,
                *_authority_tuple(request.authority_revision),
                request.page_size,
                request.expected_base_generation,
                now,
                now,
            ),
        )
        await db.execute(
            """UPDATE tooling_remote_catalog_headers
               SET sync_state='syncing', last_error_reason=NULL, updated_at=?
               WHERE peer_id=? AND provider_id=?""",
            (now, request.peer_id, request.provider_id),
        )
        await db.commit()
        return DBBeginToolingRemoteCatalogSyncResponse(
            ok=True, sync_id=request.sync_id, base_generation=base_generation
        )
    finally:
        await db.close()


def _page_binding_error(sync: aiosqlite.Row, page: ToolingGetExportCatalogResponse) -> str | None:
    if page.provider_peer_id != sync["peer_id"]:
        return "remote_catalog_peer_mismatch"
    if page.service_instance_id != sync["service_instance_id"]:
        return "remote_catalog_provider_mismatch"
    if page.selected_protocol_tier != sync["protocol_tier"]:
        return "remote_catalog_protocol_mismatch"
    if page.projection_revision != sync["projection_revision"]:
        return "remote_catalog_revision_mismatch"
    if page.projection_digest != sync["projection_digest"]:
        return "remote_catalog_digest_mismatch"
    if page.page_size != int(sync["page_size"]):
        return "remote_catalog_page_size_mismatch"
    if _authority_tuple(page.authority_revision) != _row_authority_tuple(sync):
        return "remote_catalog_authority_mismatch"
    if compute_projection_page_hash(page) != page.page_hash:
        return "remote_catalog_page_hash_mismatch"
    return None


async def append_tooling_remote_catalog_page(
    db_path: str, request: DBAppendToolingRemoteCatalogPageRequest
) -> DBAppendToolingRemoteCatalogPageResponse:
    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        sync = await (
            await db.execute(
                "SELECT * FROM tooling_remote_catalog_syncs WHERE sync_id=?",
                (request.sync_id,),
            )
        ).fetchone()
        if sync is None or sync["state"] != "staging":
            await db.rollback()
            return DBAppendToolingRemoteCatalogPageResponse(
                ok=False, sync_id=request.sync_id, error="remote_catalog_sync_not_found"
            )
        page = request.page
        error = _page_binding_error(sync, page)
        last_page = await (
            await db.execute(
                "SELECT MAX(page_index) AS page_index FROM tooling_remote_catalog_stage_pages WHERE sync_id=?",
                (request.sync_id,),
            )
        ).fetchone()
        expected_page_index = (
            0 if last_page["page_index"] is None else int(last_page["page_index"]) + 1
        )
        if expected_page_index == 0:
            if request.used_cursor_hash is not None:
                error = "remote_catalog_cursor_chain_mismatch"
        else:
            previous_page = await (
                await db.execute(
                    """SELECT next_cursor_hash FROM tooling_remote_catalog_stage_pages
                       WHERE sync_id=? AND page_index=?""",
                    (request.sync_id, expected_page_index - 1),
                )
            ).fetchone()
            if (
                previous_page is None
                or previous_page["next_cursor_hash"] is None
                or request.used_cursor_hash != previous_page["next_cursor_hash"]
            ):
                error = "remote_catalog_cursor_chain_mismatch"
        if error is None and page.page_index != expected_page_index:
            error = "remote_catalog_page_sequence_mismatch"
        if error is None and sync["final_page_index"] is not None:
            error = "remote_catalog_already_complete"
        if error is not None:
            await db.rollback()
            return DBAppendToolingRemoteCatalogPageResponse(
                ok=False, sync_id=request.sync_id, error=error
            )

        seen_ids: set[str] = set()
        staged_entries = [(tool, "active", "projection_active", []) for tool in page.tools] + [
            (
                item.tool,
                "permission_blocked",
                item.reason_code,
                item.missing_permissions,
            )
            for item in page.blocked_tools
        ]
        for tool, _availability, _reason_code, _missing_permissions in staged_entries:
            if tool.global_tool_id in seen_ids:
                await db.rollback()
                return DBAppendToolingRemoteCatalogPageResponse(
                    ok=False, sync_id=request.sync_id, error="remote_catalog_duplicate_tool"
                )
            seen_ids.add(tool.global_tool_id)
            if (
                tool.provider_peer_id != page.provider_peer_id
                or tool.provider_service_instance_id != page.service_instance_id
                or tool.source_type != "local"
                or not tool.exportable
            ):
                await db.rollback()
                return DBAppendToolingRemoteCatalogPageResponse(
                    ok=False, sync_id=request.sync_id, error="remote_catalog_invalid_tool_authority"
                )
        retirement_ids = {item.global_tool_id for item in page.retirements}
        if len(retirement_ids) != len(page.retirements) or seen_ids & retirement_ids:
            await db.rollback()
            return DBAppendToolingRemoteCatalogPageResponse(
                ok=False, sync_id=request.sync_id, error="remote_catalog_duplicate_identity"
            )

        now = time.time()
        await db.execute(
            """INSERT INTO tooling_remote_catalog_stage_pages (
                   sync_id, page_index, page_hash, item_count, complete,
                   next_cursor_hash, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                request.sync_id,
                page.page_index,
                page.page_hash,
                len(staged_entries) + len(page.retirements),
                page.complete,
                hashlib.sha256(page.next_cursor.encode()).hexdigest()
                if page.next_cursor is not None
                else None,
                now,
            ),
        )
        for tool, availability, reason_code, missing_permissions in staged_entries:
            await db.execute(
                """INSERT INTO tooling_remote_catalog_stage_tools (
                       sync_id, global_tool_id, page_index, metadata_json, schema_hash,
                       availability, reason_code, missing_permissions_json
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    request.sync_id,
                    tool.global_tool_id,
                    page.page_index,
                    tool.model_dump_json(),
                    compute_tool_schema_hash(tool),
                    availability,
                    reason_code,
                    _canonical_json(sorted(set(missing_permissions))),
                ),
            )
        for item in page.retirements:
            await db.execute(
                """INSERT INTO tooling_remote_catalog_stage_retirements (
                       sync_id, global_tool_id, page_index, availability,
                       reason_code, last_schema_hash
                   ) VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    request.sync_id,
                    item.global_tool_id,
                    page.page_index,
                    item.availability,
                    item.reason_code,
                    item.last_schema_hash,
                ),
            )
        if page.complete:
            await db.execute(
                """UPDATE tooling_remote_catalog_syncs
                   SET final_page_index=?, total_count=?, final_checksum=?, updated_at=?
                   WHERE sync_id=?""",
                (page.page_index, page.total_count, page.final_checksum, now, request.sync_id),
            )
        else:
            await db.execute(
                "UPDATE tooling_remote_catalog_syncs SET updated_at=? WHERE sync_id=?",
                (now, request.sync_id),
            )
        await db.commit()
        return DBAppendToolingRemoteCatalogPageResponse(
            ok=True,
            sync_id=request.sync_id,
            accepted_page_index=page.page_index,
            complete=page.complete,
        )
    except aiosqlite.IntegrityError:
        await db.rollback()
        return DBAppendToolingRemoteCatalogPageResponse(
            ok=False, sync_id=request.sync_id, error="remote_catalog_duplicate_identity"
        )
    finally:
        await db.close()


async def _reject_staged_sync(
    db: aiosqlite.Connection, sync: aiosqlite.Row, reason: str, correlation_id: str | None
) -> DBCommitToolingRemoteCatalogSyncResponse:
    now = time.time()
    generation = int(sync["expected_base_generation"])
    await db.execute("DELETE FROM tooling_remote_catalog_syncs WHERE sync_id=?", (sync["sync_id"],))
    await db.execute(
        """UPDATE tooling_remote_catalog_headers
           SET sync_state=CASE WHEN current_generation > 0 THEN 'committed' ELSE 'failed' END,
               last_error_reason=?, updated_at=?
           WHERE peer_id=? AND provider_id=?""",
        (reason, now, sync["peer_id"], sync["provider_id"]),
    )
    await db.execute(
        """INSERT INTO tooling_remote_catalog_audit (
               audit_id, peer_id, provider_id, sync_id, action,
               previous_generation, generation, projection_revision,
               reason_code, correlation_id, created_at
           ) VALUES (?, ?, ?, ?, 'sync_rejected', ?, ?, ?, ?, ?, ?)""",
        (
            f"toolcatalogaudit_{uuid4().hex}",
            sync["peer_id"],
            sync["provider_id"],
            sync["sync_id"],
            generation,
            generation,
            sync["projection_revision"],
            reason,
            correlation_id,
            now,
        ),
    )
    await db.commit()
    return DBCommitToolingRemoteCatalogSyncResponse(
        ok=False,
        previous_generation=generation,
        generation=generation,
        error=reason,
        correlation_id=correlation_id,
    )


async def commit_tooling_remote_catalog_sync(
    db_path: str, request: DBCommitToolingRemoteCatalogSyncRequest
) -> DBCommitToolingRemoteCatalogSyncResponse:
    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        sync = await (
            await db.execute(
                "SELECT * FROM tooling_remote_catalog_syncs WHERE sync_id=?",
                (request.sync_id,),
            )
        ).fetchone()
        if sync is None:
            await db.rollback()
            return DBCommitToolingRemoteCatalogSyncResponse(
                ok=False,
                previous_generation=request.expected_base_generation,
                generation=request.expected_base_generation,
                error="remote_catalog_sync_not_found",
                correlation_id=request.correlation_id,
            )
        header_row = await (
            await db.execute(
                """SELECT * FROM tooling_remote_catalog_headers
                   WHERE peer_id=? AND provider_id=?""",
                (sync["peer_id"], sync["provider_id"]),
            )
        ).fetchone()
        current_generation = int(header_row["current_generation"])
        if (
            current_generation != request.expected_base_generation
            or int(sync["expected_base_generation"]) != request.expected_base_generation
        ):
            return await _reject_staged_sync(
                db, sync, "remote_catalog_generation_conflict", request.correlation_id
            )
        if sync["final_page_index"] is None:
            return await _reject_staged_sync(
                db, sync, "remote_catalog_incomplete", request.correlation_id
            )
        pages = await (
            await db.execute(
                """SELECT * FROM tooling_remote_catalog_stage_pages
                   WHERE sync_id=? ORDER BY page_index""",
                (request.sync_id,),
            )
        ).fetchall()
        expected_indices = list(range(int(sync["final_page_index"]) + 1))
        if (
            [int(row["page_index"]) for row in pages] != expected_indices
            or sum(bool(row["complete"]) for row in pages) != 1
            or not bool(pages[-1]["complete"])
        ):
            return await _reject_staged_sync(
                db, sync, "remote_catalog_page_sequence_mismatch", request.correlation_id
            )
        staged_tool_rows = await (
            await db.execute(
                "SELECT * FROM tooling_remote_catalog_stage_tools WHERE sync_id=?",
                (request.sync_id,),
            )
        ).fetchall()
        retirement_rows = await (
            await db.execute(
                "SELECT * FROM tooling_remote_catalog_stage_retirements WHERE sync_id=?",
                (request.sync_id,),
            )
        ).fetchall()
        if len(staged_tool_rows) != int(sync["total_count"]):
            return await _reject_staged_sync(
                db, sync, "remote_catalog_count_mismatch", request.correlation_id
            )
        staged_tools = [
            ToolingToolInfo.model_validate_json(str(row["metadata_json"]))
            for row in staged_tool_rows
        ]
        blocked_tools = [
            ToolingProjectionBlockedTool(
                tool=tool,
                reason_code=str(row["reason_code"]),
                missing_permissions=json.loads(str(row["missing_permissions_json"])),
            )
            for row, tool in zip(staged_tool_rows, staged_tools, strict=True)
            if row["availability"] == "permission_blocked"
        ]
        retirements = [
            ToolingProjectionRetirement(
                global_tool_id=row["global_tool_id"],
                availability=row["availability"],
                reason_code=row["reason_code"],
                last_schema_hash=row["last_schema_hash"],
            )
            for row in retirement_rows
        ]
        active_tools = [
            tool
            for row, tool in zip(staged_tool_rows, staged_tools, strict=True)
            if row["availability"] == "active"
        ]
        checksum = compute_projection_checksum(active_tools, retirements, blocked_tools)
        if checksum != sync["final_checksum"] or checksum != sync["projection_digest"]:
            return await _reject_staged_sync(
                db, sync, "remote_catalog_checksum_mismatch", request.correlation_id
            )

        staged_canonical_ids = {tool.global_tool_id for tool in staged_tools}
        aliases_by_canonical: dict[str, set[str]] = {}
        alias_owner: dict[str, str] = {}
        for tool in staged_tools:
            aliases = {
                str(alias)
                for alias in tool.legacy_global_tool_ids
                if str(alias) and str(alias) != tool.global_tool_id
            }
            aliases_by_canonical[tool.global_tool_id] = aliases
            for alias in aliases:
                if alias in staged_canonical_ids:
                    return await _reject_alias_conflict(
                        db,
                        sync,
                        "remote_catalog_alias_canonical_collision",
                        request.correlation_id,
                        alias=alias,
                        requested_canonical=tool.global_tool_id,
                        existing_canonical=alias,
                    )
                previous_owner = alias_owner.setdefault(alias, tool.global_tool_id)
                if previous_owner != tool.global_tool_id:
                    return await _reject_alias_conflict(
                        db,
                        sync,
                        "remote_catalog_alias_owner_collision",
                        request.correlation_id,
                        alias=alias,
                        requested_canonical=tool.global_tool_id,
                        existing_canonical=previous_owner,
                    )
        existing_aliases = await (
            await db.execute(
                """SELECT legacy_global_tool_id, canonical_global_tool_id
                   FROM tooling_remote_tool_aliases WHERE peer_id=? AND provider_id=?""",
                (sync["peer_id"], sync["provider_id"]),
            )
        ).fetchall()
        for row in existing_aliases:
            alias = str(row["legacy_global_tool_id"])
            owner = alias_owner.get(alias)
            if owner is not None and owner != str(row["canonical_global_tool_id"]):
                return await _reject_alias_conflict(
                    db,
                    sync,
                    "remote_catalog_alias_reassignment",
                    request.correlation_id,
                    alias=alias,
                    requested_canonical=owner,
                    existing_canonical=str(row["canonical_global_tool_id"]),
                )

        known_ids = {
            str(row[0])
            for row in await (
                await db.execute(
                    """SELECT global_tool_id FROM tooling_remote_catalog_tools
                       WHERE peer_id=? AND provider_id=?""",
                    (sync["peer_id"], sync["provider_id"]),
                )
            ).fetchall()
        }
        known_ids.update(
            str(row[0])
            for row in await (
                await db.execute(
                    """SELECT global_tool_id
                       FROM tooling_remote_catalog_retention_tombstones
                       WHERE peer_id=? AND provider_id=?""",
                    (sync["peer_id"], sync["provider_id"]),
                )
            ).fetchall()
        )
        known_ids.update(
            str(row[0])
            for row in await (
                await db.execute(
                    """SELECT global_tool_id FROM tooling_tool_exposure_ledger
                       WHERE recipient_peer_id=? AND provider_id=?""",
                    (sync["peer_id"], sync["provider_id"]),
                )
            ).fetchall()
        )
        retirement_ids = {item.global_tool_id for item in retirements}
        if not retirement_ids <= known_ids:
            return await _reject_staged_sync(
                db, sync, "remote_catalog_unknown_retirement", request.correlation_id
            )

        now = time.time()
        generation = current_generation + 1
        new_ids: set[str] = set()
        for staged_row, tool in zip(staged_tool_rows, staged_tools, strict=True):
            aliases = aliases_by_canonical[tool.global_tool_id]
            existing_identity_rows = await (
                await db.execute(
                    f"""SELECT global_tool_id FROM tooling_remote_catalog_tools
                        WHERE peer_id=? AND provider_id=? AND global_tool_id IN ({",".join("?" for _ in aliases | {tool.global_tool_id})})""",
                    (
                        sync["peer_id"],
                        sync["provider_id"],
                        *sorted(aliases | {tool.global_tool_id}),
                    ),
                )
            ).fetchall()
            existing_identity_ids = {str(row["global_tool_id"]) for row in existing_identity_rows}
            alias_rows = existing_identity_ids & aliases
            if tool.global_tool_id in existing_identity_ids and alias_rows:
                return await _reject_alias_conflict(
                    db,
                    sync,
                    "remote_catalog_alias_existing_identity_collision",
                    request.correlation_id,
                    alias=next(iter(alias_rows)),
                    requested_canonical=tool.global_tool_id,
                    existing_canonical=tool.global_tool_id,
                )
            if len(alias_rows) > 1:
                return await _reject_alias_conflict(
                    db,
                    sync,
                    "remote_catalog_alias_multiple_identity_collision",
                    request.correlation_id,
                    alias=sorted(alias_rows)[0],
                    requested_canonical=tool.global_tool_id,
                )
            if alias_rows:
                old_identity = next(iter(alias_rows))
                await _rekey_remote_dependents(
                    db,
                    peer_id=str(sync["peer_id"]),
                    provider_id=str(sync["provider_id"]),
                    service_instance_id=str(sync["service_instance_id"]),
                    aliases={old_identity},
                    canonical=tool.global_tool_id,
                )
                await db.execute(
                    """UPDATE tooling_remote_catalog_tools SET global_tool_id=?
                       WHERE peer_id=? AND provider_id=? AND global_tool_id=?""",
                    (tool.global_tool_id, sync["peer_id"], sync["provider_id"], old_identity),
                )
            for alias in sorted(aliases):
                await db.execute(
                    """INSERT INTO tooling_remote_tool_aliases (
                           peer_id, provider_id, legacy_global_tool_id,
                           canonical_global_tool_id, first_seen_at, last_seen_at
                       ) VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(peer_id, provider_id, legacy_global_tool_id) DO UPDATE SET
                           last_seen_at=excluded.last_seen_at""",
                    (
                        sync["peer_id"],
                        sync["provider_id"],
                        alias,
                        tool.global_tool_id,
                        now,
                        now,
                    ),
                )
            new_ids.add(tool.global_tool_id)
            existing = await (
                await db.execute(
                    """SELECT * FROM tooling_remote_catalog_tools
                       WHERE peer_id=? AND provider_id=? AND global_tool_id=?""",
                    (sync["peer_id"], sync["provider_id"], tool.global_tool_id),
                )
            ).fetchone()
            retained_stub = None
            if existing is None:
                retained_stub = await (
                    await db.execute(
                        """SELECT * FROM tooling_remote_catalog_retention_tombstones
                           WHERE peer_id=? AND provider_id=? AND global_tool_id=?""",
                        (sync["peer_id"], sync["provider_id"], tool.global_tool_id),
                    )
                ).fetchone()
            accepted_schema_hash = (
                str(existing["accepted_schema_hash"])
                if existing is not None
                else (
                    str(retained_stub["accepted_schema_hash"])
                    if retained_stub is not None
                    else str(staged_row["schema_hash"])
                )
            )
            schema_changed = (
                existing is not None or retained_stub is not None
            ) and accepted_schema_hash != staged_row["schema_hash"]
            if schema_changed:
                await _mark_positive_grants_for_schema_review(
                    db,
                    peer_id=str(sync["peer_id"]),
                    provider_id=str(sync["provider_id"]),
                    global_tool_id=tool.global_tool_id,
                    aliases=aliases,
                    accepted_schema_hash=accepted_schema_hash,
                    current_schema_hash=str(staged_row["schema_hash"]),
                )
            policy_pending = request.defer_activation_for_policy_reconciliation
            permission_blocked = staged_row["availability"] == "permission_blocked"
            availability = (
                "permission_blocked"
                if permission_blocked
                else (
                    "schema_changed"
                    if schema_changed
                    else ("stale" if policy_pending else "active")
                )
            )
            reason = (
                str(staged_row["reason_code"])
                if permission_blocked
                else (
                    "remote_tool_schema_changed"
                    if schema_changed
                    else (
                        "policy_reconciliation_pending" if policy_pending else "projection_active"
                    )
                )
            )
            await db.execute(
                """INSERT INTO tooling_remote_catalog_tools (
                       peer_id, provider_id, global_tool_id, metadata_json, schema_hash,
                       accepted_schema_hash,
                       availability, reason_code, missing_permissions_json,
                       active_generation, projection_revision,
                       catalog_revision, export_policy_revision, auth_grant_revision,
                       manifest_revision, switch_revision, protocol_revision,
                       review_required, first_seen_at, last_seen_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(peer_id, provider_id, global_tool_id) DO UPDATE SET
                       metadata_json=excluded.metadata_json,
                       schema_hash=excluded.schema_hash,
                       availability=excluded.availability,
                       reason_code=excluded.reason_code,
                       missing_permissions_json=excluded.missing_permissions_json,
                       active_generation=excluded.active_generation,
                       projection_revision=excluded.projection_revision,
                       catalog_revision=excluded.catalog_revision,
                       export_policy_revision=excluded.export_policy_revision,
                       auth_grant_revision=excluded.auth_grant_revision,
                       manifest_revision=excluded.manifest_revision,
                       switch_revision=excluded.switch_revision,
                       protocol_revision=excluded.protocol_revision,
                       review_required=excluded.review_required,
                       last_seen_at=excluded.last_seen_at,
                       updated_at=excluded.updated_at""",
                (
                    sync["peer_id"],
                    sync["provider_id"],
                    tool.global_tool_id,
                    staged_row["metadata_json"],
                    staged_row["schema_hash"],
                    (accepted_schema_hash),
                    availability,
                    reason,
                    staged_row["missing_permissions_json"],
                    generation if availability == "active" else None,
                    sync["projection_revision"],
                    sync["catalog_revision"],
                    sync["export_policy_revision"],
                    sync["auth_grant_revision"],
                    sync["manifest_revision"],
                    sync["switch_revision"],
                    sync["protocol_revision"],
                    schema_changed,
                    float(existing["first_seen_at"]) if existing is not None else now,
                    now,
                    now,
                ),
            )
            await db.execute(
                """DELETE FROM tooling_remote_catalog_retention_tombstones
                   WHERE peer_id=? AND provider_id=? AND global_tool_id=?""",
                (sync["peer_id"], sync["provider_id"], tool.global_tool_id),
            )
        for item in retirements:
            await db.execute(
                """UPDATE tooling_remote_catalog_tools SET
                       availability=?, reason_code=?, active_generation=NULL,
                       projection_revision=?, catalog_revision=?, export_policy_revision=?,
                       auth_grant_revision=?, manifest_revision=?, last_seen_at=?, updated_at=?
                   WHERE peer_id=? AND provider_id=? AND global_tool_id=?""",
                (
                    item.availability,
                    item.reason_code,
                    sync["projection_revision"],
                    sync["catalog_revision"],
                    sync["export_policy_revision"],
                    sync["auth_grant_revision"],
                    sync["manifest_revision"],
                    now,
                    now,
                    sync["peer_id"],
                    sync["provider_id"],
                    item.global_tool_id,
                ),
            )
            await db.execute(
                """UPDATE tooling_remote_catalog_retention_tombstones SET
                       last_availability=?, reason_code=?, compacted_at=?
                   WHERE peer_id=? AND provider_id=? AND global_tool_id=?""",
                (
                    item.availability,
                    item.reason_code,
                    now,
                    sync["peer_id"],
                    sync["provider_id"],
                    item.global_tool_id,
                ),
            )
        unexplained = known_ids - new_ids - retirement_ids
        if unexplained:
            placeholders = ",".join("?" for _ in unexplained)
            await db.execute(
                f"""UPDATE tooling_remote_catalog_tools SET
                        availability='stale', reason_code='projection_omission',
                        active_generation=NULL, projection_revision=?, updated_at=?
                    WHERE peer_id=? AND provider_id=? AND global_tool_id IN ({placeholders})""",
                (
                    sync["projection_revision"],
                    now,
                    sync["peer_id"],
                    sync["provider_id"],
                    *sorted(unexplained),
                ),
            )
        await db.execute(
            """UPDATE tooling_remote_catalog_headers SET
                   service_instance_id=?, protocol_tier='projection_v1',
                   projection_revision=?, projection_digest=?, catalog_revision=?,
                   export_policy_revision=?, auth_grant_revision=?, manifest_revision=?,
                   switch_revision=?, protocol_revision=?, current_generation=?,
                   sync_state='committed', availability=?, last_error_reason=?,
                   committed_at=?, updated_at=?
               WHERE peer_id=? AND provider_id=?""",
            (
                sync["service_instance_id"],
                sync["projection_revision"],
                sync["projection_digest"],
                sync["catalog_revision"],
                sync["export_policy_revision"],
                sync["auth_grant_revision"],
                sync["manifest_revision"],
                sync["switch_revision"],
                sync["protocol_revision"],
                generation,
                ("stale" if request.defer_activation_for_policy_reconciliation else "active"),
                (
                    "policy_reconciliation_pending"
                    if request.defer_activation_for_policy_reconciliation
                    else None
                ),
                now,
                now,
                sync["peer_id"],
                sync["provider_id"],
            ),
        )
        await db.execute(
            """INSERT INTO tooling_remote_catalog_audit (
                   audit_id, peer_id, provider_id, sync_id, action,
                   previous_generation, generation, projection_revision,
                   reason_code, correlation_id, created_at
               ) VALUES (?, ?, ?, ?, 'snapshot_committed', ?, ?, ?, 'verified_complete', ?, ?)""",
            (
                f"toolcatalogaudit_{uuid4().hex}",
                sync["peer_id"],
                sync["provider_id"],
                sync["sync_id"],
                current_generation,
                generation,
                sync["projection_revision"],
                request.correlation_id,
                now,
            ),
        )
        await db.execute(
            "DELETE FROM tooling_remote_catalog_syncs WHERE sync_id=?", (request.sync_id,)
        )
        await db.commit()
        result = await get_tooling_remote_catalog(
            db_path,
            DBGetToolingRemoteCatalogRequest(
                peer_id=str(sync["peer_id"]), provider_id=str(sync["provider_id"])
            ),
        )
        return DBCommitToolingRemoteCatalogSyncResponse(
            ok=True,
            header=result.headers[0],
            tools=result.tools,
            previous_generation=current_generation,
            generation=generation,
            correlation_id=request.correlation_id,
        )
    finally:
        await db.close()


async def finalize_tooling_remote_catalog_policy(
    db_path: str, request: DBFinalizeToolingRemoteCatalogPolicyRequest
) -> DBFinalizeToolingRemoteCatalogPolicyResponse:
    """CAS-activate only a committed generation whose Config policy is durable."""

    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        row = await (
            await db.execute(
                "SELECT * FROM tooling_remote_catalog_headers WHERE peer_id=? AND provider_id=?",
                (request.peer_id, request.provider_id),
            )
        ).fetchone()
        if row is None:
            await db.rollback()
            return DBFinalizeToolingRemoteCatalogPolicyResponse(
                ok=False,
                error="remote_catalog_provider_not_found",
                correlation_id=request.correlation_id,
            )
        if (
            int(row["current_generation"]) != request.expected_generation
            or row["projection_revision"] != request.expected_projection_revision
            or row["sync_state"] != "committed"
            or row["availability"] != "stale"
            or row["last_error_reason"] != "policy_reconciliation_pending"
        ):
            await db.rollback()
            return DBFinalizeToolingRemoteCatalogPolicyResponse(
                ok=False,
                header=_header(row),
                error="remote_catalog_policy_finalize_conflict",
                correlation_id=request.correlation_id,
            )
        now = time.time()
        await db.execute(
            """UPDATE tooling_remote_catalog_headers SET availability='active',
                   last_error_reason=NULL, updated_at=?
               WHERE peer_id=? AND provider_id=? AND current_generation=?
                 AND projection_revision=? AND availability='stale'
                 AND last_error_reason='policy_reconciliation_pending'""",
            (
                now,
                request.peer_id,
                request.provider_id,
                request.expected_generation,
                request.expected_projection_revision,
            ),
        )
        await db.execute(
            """UPDATE tooling_remote_catalog_tools SET availability='active',
                   reason_code='projection_active', active_generation=?, updated_at=?
               WHERE peer_id=? AND provider_id=? AND projection_revision=?
                 AND availability='stale' AND reason_code='policy_reconciliation_pending'""",
            (
                request.expected_generation,
                now,
                request.peer_id,
                request.provider_id,
                request.expected_projection_revision,
            ),
        )
        await db.execute(
            """INSERT INTO tooling_remote_catalog_audit (
                   audit_id, peer_id, provider_id, action, previous_generation,
                   generation, projection_revision, reason_code, correlation_id, created_at
               ) VALUES (?, ?, ?, 'policy_reconciliation_finalized', ?, ?, ?, ?, ?, ?)""",
            (
                f"toolcatalogaudit_{uuid4().hex}",
                request.peer_id,
                request.provider_id,
                request.expected_generation,
                request.expected_generation,
                request.expected_projection_revision,
                "policy_reconciliation_persisted",
                request.correlation_id,
                now,
            ),
        )
        await db.commit()
        updated = await (
            await db.execute(
                "SELECT * FROM tooling_remote_catalog_headers WHERE peer_id=? AND provider_id=?",
                (request.peer_id, request.provider_id),
            )
        ).fetchone()
        return DBFinalizeToolingRemoteCatalogPolicyResponse(
            ok=True,
            changed=True,
            header=_header(updated),
            correlation_id=request.correlation_id,
        )
    finally:
        await db.close()


async def abort_tooling_remote_catalog_sync(
    db_path: str, request: DBAbortToolingRemoteCatalogSyncRequest
) -> DBAbortToolingRemoteCatalogSyncResponse:
    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        sync = await (
            await db.execute(
                "SELECT * FROM tooling_remote_catalog_syncs WHERE sync_id=?", (request.sync_id,)
            )
        ).fetchone()
        if sync is None:
            await db.rollback()
            return DBAbortToolingRemoteCatalogSyncResponse(ok=True, aborted=False)
        await _reject_staged_sync(db, sync, request.reason_code, request.correlation_id)
        return DBAbortToolingRemoteCatalogSyncResponse(ok=True, aborted=True)
    finally:
        await db.close()


async def get_tooling_remote_catalog(
    db_path: str, request: DBGetToolingRemoteCatalogRequest
) -> DBGetToolingRemoteCatalogResponse:
    db = await _connect(db_path)
    try:
        clauses: list[str] = []
        params: list[Any] = []
        if request.peer_id is not None:
            clauses.append("peer_id=?")
            params.append(request.peer_id)
        if request.provider_id is not None:
            clauses.append("provider_id=?")
            params.append(request.provider_id)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        headers = await (
            await db.execute(
                f"SELECT * FROM tooling_remote_catalog_headers{where} ORDER BY peer_id, provider_id",
                params,
            )
        ).fetchall()
        tool_clauses: list[str] = []
        tool_params: list[Any] = []
        if request.peer_id is not None:
            tool_clauses.append("t.peer_id=?")
            tool_params.append(request.peer_id)
        if request.provider_id is not None:
            tool_clauses.append("t.provider_id=?")
            tool_params.append(request.provider_id)
        if not request.include_inactive:
            tool_clauses.extend(
                (
                    "h.protocol_tier='projection_v1'",
                    "h.sync_state='committed'",
                    "h.availability='active'",
                    "t.availability='active'",
                    "t.active_generation=h.current_generation",
                    "t.projection_revision=h.projection_revision",
                )
            )
        tool_where = f" WHERE {' AND '.join(tool_clauses)}" if tool_clauses else ""
        tools = await (
            await db.execute(
                f"""SELECT t.* FROM tooling_remote_catalog_tools AS t
                    JOIN tooling_remote_catalog_headers AS h
                      ON h.peer_id=t.peer_id AND h.provider_id=t.provider_id
                    {tool_where}
                    ORDER BY t.peer_id, t.provider_id, t.global_tool_id""",
                tool_params,
            )
        ).fetchall()
        retained_tombstones = []
        if request.include_inactive:
            retained_tombstones = await (
                await db.execute(
                    f"""SELECT * FROM tooling_remote_catalog_retention_tombstones{where}
                        ORDER BY peer_id, provider_id, global_tool_id""",
                    params,
                )
            ).fetchall()
        return DBGetToolingRemoteCatalogResponse(
            headers=[_header(row) for row in headers],
            tools=[_tool(row) for row in tools],
            retained_tombstones=[_tombstone(row) for row in retained_tombstones],
        )
    finally:
        await db.close()


async def set_tooling_remote_provider_availability(
    db_path: str, request: DBSetToolingRemoteProviderAvailabilityRequest
) -> DBSetToolingRemoteProviderAvailabilityResponse:
    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        row = await (
            await db.execute(
                "SELECT * FROM tooling_remote_catalog_headers WHERE peer_id=? AND provider_id=?",
                (request.peer_id, request.provider_id),
            )
        ).fetchone()
        if row is None:
            await db.rollback()
            return DBSetToolingRemoteProviderAvailabilityResponse(
                ok=False,
                error="remote_catalog_provider_not_found",
                correlation_id=request.correlation_id,
            )
        if (
            request.expected_generation is not None
            and int(row["current_generation"]) != request.expected_generation
        ) or (
            request.expected_projection_revision is not None
            and row["projection_revision"] != request.expected_projection_revision
        ):
            await db.rollback()
            return DBSetToolingRemoteProviderAvailabilityResponse(
                ok=False,
                header=_header(row),
                error="remote_catalog_availability_conflict",
                correlation_id=request.correlation_id,
            )
        changed = (
            row["availability"] != request.availability
            or row["last_error_reason"] != request.reason_code
        )
        now = time.time()
        if changed:
            await db.execute(
                """UPDATE tooling_remote_catalog_headers SET availability=?, last_error_reason=?,
                       sync_state=CASE WHEN current_generation > 0 THEN 'committed' ELSE 'failed' END,
                       updated_at=? WHERE peer_id=? AND provider_id=?""",
                (
                    request.availability,
                    request.reason_code,
                    now,
                    request.peer_id,
                    request.provider_id,
                ),
            )
            # Provider reachability/protocol is catalog-level state. Preserve
            # each retained tool's causal lifecycle state (especially
            # schema_changed); active reads already require an active header.
            await db.execute(
                """INSERT INTO tooling_remote_catalog_audit (
                       audit_id, peer_id, provider_id, action, previous_generation,
                       generation, projection_revision, reason_code, correlation_id, created_at
                   ) VALUES (?, ?, ?, 'availability_changed', ?, ?, ?, ?, ?, ?)""",
                (
                    f"toolcatalogaudit_{uuid4().hex}",
                    request.peer_id,
                    request.provider_id,
                    row["current_generation"],
                    row["current_generation"],
                    row["projection_revision"],
                    request.reason_code,
                    request.correlation_id,
                    now,
                ),
            )
        await db.commit()
        updated = await (
            await db.execute(
                "SELECT * FROM tooling_remote_catalog_headers WHERE peer_id=? AND provider_id=?",
                (request.peer_id, request.provider_id),
            )
        ).fetchone()
        return DBSetToolingRemoteProviderAvailabilityResponse(
            ok=True,
            changed=changed,
            header=_header(updated),
            correlation_id=request.correlation_id,
        )
    finally:
        await db.close()


async def accept_tooling_remote_tool_schema(
    db_path: str, request: DBAcceptToolingRemoteToolSchemaRequest
) -> DBAcceptToolingRemoteToolSchemaResponse:
    """Accept only the current verified schema; stale review decisions fail closed."""

    db = await _connect(db_path)
    try:
        await db.execute("BEGIN IMMEDIATE")
        row = await (
            await db.execute(
                """SELECT t.*, h.current_generation AS header_generation,
                          h.projection_revision AS header_projection_revision,
                          h.protocol_tier AS header_protocol_tier,
                          h.sync_state AS header_sync_state,
                          h.availability AS header_availability
                   FROM tooling_remote_catalog_tools AS t
                   JOIN tooling_remote_catalog_headers AS h
                     ON h.peer_id=t.peer_id AND h.provider_id=t.provider_id
                   WHERE t.peer_id=? AND t.provider_id=? AND t.global_tool_id=?""",
                (request.peer_id, request.provider_id, request.global_tool_id),
            )
        ).fetchone()
        if row is None:
            await db.rollback()
            return DBAcceptToolingRemoteToolSchemaResponse(
                ok=False,
                error="remote_catalog_tool_not_found",
                correlation_id=request.correlation_id,
            )
        current = _tool(row)
        if (
            row["projection_revision"] != request.expected_projection_revision
            or row["header_projection_revision"] != request.expected_projection_revision
            or row["schema_hash"] != request.expected_schema_hash
        ):
            await db.rollback()
            return DBAcceptToolingRemoteToolSchemaResponse(
                ok=False,
                tool=current,
                error="remote_catalog_schema_acceptance_conflict",
                correlation_id=request.correlation_id,
            )
        if not bool(row["review_required"]):
            await db.rollback()
            return DBAcceptToolingRemoteToolSchemaResponse(
                ok=True,
                changed=False,
                tool=current,
                correlation_id=request.correlation_id,
            )

        can_activate = (
            row["header_protocol_tier"] == "projection_v1"
            and row["header_sync_state"] == "committed"
            and row["header_availability"] == "active"
        )
        now = time.time()
        audit_id = f"toolcatalogschema_{uuid4().hex}"
        await db.execute(
            """UPDATE tooling_remote_catalog_tools SET
                   accepted_schema_hash=?, review_required=0,
                   availability=CASE WHEN ? THEN 'active' ELSE availability END,
                   reason_code=CASE WHEN ? THEN 'projection_active' ELSE reason_code END,
                   active_generation=CASE WHEN ? THEN ? ELSE NULL END,
                   updated_at=?
               WHERE peer_id=? AND provider_id=? AND global_tool_id=?
                 AND projection_revision=? AND schema_hash=? AND review_required=1""",
            (
                request.expected_schema_hash,
                can_activate,
                can_activate,
                can_activate,
                int(row["header_generation"]),
                now,
                request.peer_id,
                request.provider_id,
                request.global_tool_id,
                request.expected_projection_revision,
                request.expected_schema_hash,
            ),
        )
        changed_row = await (await db.execute("SELECT changes()")).fetchone()
        if changed_row is None or int(changed_row[0]) != 1:
            await db.rollback()
            return DBAcceptToolingRemoteToolSchemaResponse(
                ok=False,
                tool=current,
                error="remote_catalog_schema_acceptance_conflict",
                correlation_id=request.correlation_id,
            )
        await db.execute(
            """INSERT INTO tooling_remote_catalog_audit (
                   audit_id, peer_id, provider_id, action, previous_generation,
                   generation, projection_revision, reason_code, correlation_id,
                   actor_principal_id, detail_reason, created_at
               ) VALUES (?, ?, ?, 'schema_accepted', ?, ?, ?, 'schema_review_accepted',
                   ?, ?, ?, ?)""",
            (
                audit_id,
                request.peer_id,
                request.provider_id,
                row["header_generation"],
                row["header_generation"],
                request.expected_projection_revision,
                request.correlation_id,
                request.actor_principal_id,
                request.reason,
                now,
            ),
        )
        await db.commit()
        updated = await (
            await db.execute(
                """SELECT * FROM tooling_remote_catalog_tools
                   WHERE peer_id=? AND provider_id=? AND global_tool_id=?""",
                (request.peer_id, request.provider_id, request.global_tool_id),
            )
        ).fetchone()
        return DBAcceptToolingRemoteToolSchemaResponse(
            ok=True,
            changed=True,
            tool=_tool(updated),
            audit_id=audit_id,
            correlation_id=request.correlation_id,
        )
    except Exception:
        await db.rollback()
        raise
    finally:
        await db.close()


async def import_legacy_tooling_remote_catalogs(
    db_path: str, request: DBImportLegacyToolingRemoteCatalogsRequest
) -> DBImportLegacyToolingRemoteCatalogsResponse:
    db = await _connect(db_path)
    imported_headers = imported_tools = skipped_rows = 0
    try:
        await db.execute("BEGIN IMMEDIATE")
        rows = await (
            await db.execute(
                "SELECT * FROM tooling_remote_catalog_snapshots ORDER BY peer_id, service_instance_id LIMIT ?",
                (request.limit,),
            )
        ).fetchall()
        now = time.time()
        for row in rows:
            provider_id = str(row["provider_id"] or row["service_instance_id"])
            exists = await (
                await db.execute(
                    "SELECT 1 FROM tooling_remote_catalog_headers WHERE peer_id=? AND provider_id=?",
                    (row["peer_id"], provider_id),
                )
            ).fetchone()
            if exists is not None:
                skipped_rows += 1
                continue
            try:
                raw_tools = json.loads(str(row["tools_json"]))
                tools = [ToolingToolInfo.model_validate(item) for item in raw_tools]
            except (json.JSONDecodeError, ValidationError, TypeError):
                skipped_rows += 1
                continue
            await db.execute(
                """INSERT INTO tooling_remote_catalog_headers (
                       peer_id, provider_id, service_instance_id, protocol_tier,
                       projection_digest, current_generation, sync_state, availability,
                       last_error_reason, updated_at
                   ) VALUES (?, ?, ?, 'legacy_unsupported', ?, 0, 'legacy_stale',
                       'protocol_unsupported', 'legacy_unverified_import', ?)""",
                (
                    row["peer_id"],
                    provider_id,
                    row["service_instance_id"],
                    row["full_schema_hash"],
                    now,
                ),
            )
            imported_headers += 1
            for tool in tools:
                # Imported definitions are management-only.  They never create
                # an active generation or a projection-v1 baseline.
                await db.execute(
                    """INSERT INTO tooling_remote_catalog_tools (
                           peer_id, provider_id, global_tool_id, metadata_json, schema_hash,
                           accepted_schema_hash,
                           availability, reason_code, active_generation, catalog_revision,
                           export_policy_revision, auth_grant_revision, manifest_revision,
                           switch_revision, protocol_revision, review_required,
                           first_seen_at, last_seen_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, ?, 'stale', 'legacy_unverified_import', NULL,
                           0, 0, 0, 0, 0, 1, 0, ?, ?, ?)""",
                    (
                        row["peer_id"],
                        provider_id,
                        tool.global_tool_id,
                        tool.model_dump_json(),
                        compute_tool_schema_hash(tool),
                        compute_tool_schema_hash(tool),
                        now,
                        now,
                        now,
                    ),
                )
                imported_tools += 1
        await db.commit()
        return DBImportLegacyToolingRemoteCatalogsResponse(
            imported_headers=imported_headers,
            imported_tools=imported_tools,
            skipped_rows=skipped_rows,
        )
    finally:
        await db.close()


async def recover_tooling_remote_catalogs(
    db_path: str, request: DBRecoverToolingRemoteCatalogsRequest
) -> DBRecoverToolingRemoteCatalogsResponse:
    """Abort expired crash-orphan staging and return providers needing refresh."""

    now = request.now if request.now is not None else time.time()
    cutoff = now - request.orphan_staging_ttl_seconds
    db = await _connect(db_path)
    recovered_ids: list[str] = []
    providers: set[str] = set()
    try:
        await db.execute("BEGIN IMMEDIATE")
        if request.recover_all_staging:
            rows = await (
                await db.execute(
                    """SELECT * FROM tooling_remote_catalog_syncs
                       ORDER BY peer_id, provider_id, sync_id"""
                )
            ).fetchall()
        else:
            rows = await (
                await db.execute(
                    """SELECT * FROM tooling_remote_catalog_syncs
                       WHERE updated_at < ? ORDER BY peer_id, provider_id, sync_id""",
                    (cutoff,),
                )
            ).fetchall()
        for row in rows:
            sync_id = str(row["sync_id"])
            peer_id = str(row["peer_id"])
            provider_id = str(row["provider_id"])
            recovered_ids.append(sync_id)
            providers.add(peer_id)
            await db.execute("DELETE FROM tooling_remote_catalog_syncs WHERE sync_id=?", (sync_id,))
            await db.execute(
                """UPDATE tooling_remote_catalog_headers SET
                       sync_state='failed', availability='stale',
                       last_error_reason='orphan_sync_recovered', updated_at=?
                   WHERE peer_id=? AND provider_id=?""",
                (now, peer_id, provider_id),
            )
            await db.execute(
                """INSERT INTO tooling_remote_catalog_audit (
                       audit_id, peer_id, provider_id, sync_id, action,
                       previous_generation, generation, projection_revision,
                       reason_code, correlation_id, actor_principal_id,
                       detail_reason, created_at
                   ) VALUES (?, ?, ?, ?, 'orphan_sync_recovered',
                       ?, ?, ?, 'staging_ttl_expired', ?, ?, ?, ?)""",
                (
                    f"toolcatalogaudit_{uuid4().hex}",
                    peer_id,
                    provider_id,
                    sync_id,
                    row["expected_base_generation"],
                    row["expected_base_generation"],
                    row["projection_revision"],
                    request.correlation_id,
                    request.actor_principal_id,
                    (
                        "startup_sweep=all_staging"
                        if request.recover_all_staging
                        else f"ttl_seconds={request.orphan_staging_ttl_seconds}"
                    ),
                    now,
                ),
            )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    finally:
        await db.close()

    imported = await import_legacy_tooling_remote_catalogs(
        db_path, DBImportLegacyToolingRemoteCatalogsRequest()
    )
    return DBRecoverToolingRemoteCatalogsResponse(
        recovered_sync_count=len(recovered_ids),
        imported_legacy_provider_count=imported.imported_headers,
        imported_legacy_tool_count=imported.imported_tools,
        providers_needing_sync=sorted(providers),
        recovered_sync_ids=recovered_ids,
    )


async def prune_tooling_remote_catalog_retention(
    db_path: str, request: DBPruneToolingRemoteCatalogRetentionRequest
) -> DBPruneToolingRemoteCatalogRetentionResponse:
    """Bound full inactive rows and rich management history, preserving identity stubs."""

    now = request.now if request.now is not None else time.time()
    cutoff = now - request.removed_stale_ttl_seconds
    management_cutoff = now - request.management_tombstone_ttl_seconds
    db = await _connect(db_path)
    summaries: list[DBToolingRemoteRetentionProviderSummary] = []
    total_compacted = 0
    total_management_compacted = 0
    total_audit_pruned = 0
    try:
        await db.execute("BEGIN IMMEDIATE")
        providers = await (
            await db.execute(
                "SELECT peer_id, provider_id FROM tooling_remote_catalog_headers ORDER BY peer_id, provider_id"
            )
        ).fetchall()
        for provider in providers:
            peer_id = str(provider["peer_id"])
            provider_id = str(provider["provider_id"])
            inactive = await (
                await db.execute(
                    """SELECT * FROM tooling_remote_catalog_tools
                       WHERE peer_id=? AND provider_id=?
                         AND availability IN ('removed', 'stale') AND review_required=0
                       ORDER BY updated_at DESC, global_tool_id ASC""",
                    (peer_id, provider_id),
                )
            ).fetchall()
            compacted = 0
            for index, row in enumerate(inactive):
                if float(row["updated_at"]) >= cutoff and index < request.max_retained_per_provider:
                    continue
                global_tool_id = str(row["global_tool_id"])
                retained_tool = ToolingToolInfo.model_validate_json(str(row["metadata_json"]))
                await db.execute(
                    """INSERT INTO tooling_remote_catalog_retention_tombstones (
                           peer_id, provider_id, global_tool_id, management_metadata_json,
                           accepted_schema_hash, last_availability, reason_code, compacted_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(peer_id, provider_id, global_tool_id) DO UPDATE SET
                           management_metadata_json=excluded.management_metadata_json,
                           accepted_schema_hash=excluded.accepted_schema_hash,
                           last_availability=excluded.last_availability,
                           reason_code=excluded.reason_code,
                           compacted_at=excluded.compacted_at""",
                    (
                        peer_id,
                        provider_id,
                        global_tool_id,
                        _canonical_json(_management_tombstone_metadata(retained_tool)),
                        row["accepted_schema_hash"],
                        row["availability"],
                        row["reason_code"],
                        now,
                    ),
                )
                await db.execute(
                    """DELETE FROM tooling_remote_catalog_tools
                       WHERE peer_id=? AND provider_id=? AND global_tool_id=?""",
                    (peer_id, provider_id, global_tool_id),
                )
                compacted += 1

            rich_tombstones = await (
                await db.execute(
                    """SELECT global_tool_id, compacted_at
                       FROM tooling_remote_catalog_retention_tombstones
                       WHERE peer_id=? AND provider_id=?
                         AND management_metadata_json != '{}'
                       ORDER BY compacted_at DESC, global_tool_id ASC""",
                    (peer_id, provider_id),
                )
            ).fetchall()
            management_compacted = 0
            for index, row in enumerate(rich_tombstones):
                if (
                    float(row["compacted_at"]) >= management_cutoff
                    and index < request.max_management_tombstones_per_provider
                ):
                    continue
                await db.execute(
                    """UPDATE tooling_remote_catalog_retention_tombstones
                       SET management_metadata_json='{}'
                       WHERE peer_id=? AND provider_id=? AND global_tool_id=?""",
                    (peer_id, provider_id, row["global_tool_id"]),
                )
                management_compacted += 1

            audit_rows = await (
                await db.execute(
                    """SELECT audit_id FROM tooling_remote_catalog_audit
                       WHERE peer_id=? AND provider_id=?
                       ORDER BY created_at DESC, audit_id DESC""",
                    (peer_id, provider_id),
                )
            ).fetchall()
            audit_compaction_needed = len(audit_rows) > request.max_audit_rows_per_provider
            if compacted or management_compacted or audit_compaction_needed:
                keep_existing = max(request.max_audit_rows_per_provider - 1, 0)
                audit_to_prune = [str(row["audit_id"]) for row in audit_rows[keep_existing:]]
            else:
                audit_to_prune = []
            for audit_id in audit_to_prune:
                await db.execute(
                    "DELETE FROM tooling_remote_catalog_audit WHERE audit_id=?", (audit_id,)
                )
            if compacted or management_compacted or audit_to_prune:
                await db.execute(
                    """INSERT INTO tooling_remote_catalog_audit (
                           audit_id, peer_id, provider_id, action, reason_code,
                           correlation_id, actor_principal_id, detail_reason, created_at
                       ) VALUES (?, ?, ?, 'retention_pruned', 'bounded_retention', ?, ?, ?, ?)""",
                    (
                        f"toolcatalogaudit_{uuid4().hex}",
                        peer_id,
                        provider_id,
                        request.correlation_id,
                        request.actor_principal_id,
                        (
                            f"compacted={compacted};audit_pruned={len(audit_to_prune)};"
                            f"cutoff={cutoff};max_tools={request.max_retained_per_provider};"
                            f"management_compacted={management_compacted};"
                            f"management_cutoff={management_cutoff};"
                            f"max_management={request.max_management_tombstones_per_provider};"
                            f"max_audit={request.max_audit_rows_per_provider}"
                        ),
                        now,
                    ),
                )
                summaries.append(
                    DBToolingRemoteRetentionProviderSummary(
                        peer_id=peer_id,
                        provider_id=provider_id,
                        compacted_tool_count=compacted,
                        compacted_management_metadata_count=management_compacted,
                        pruned_audit_count=len(audit_to_prune),
                    )
                )
                total_compacted += compacted
                total_management_compacted += management_compacted
                total_audit_pruned += len(audit_to_prune)
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    finally:
        await db.close()
    return DBPruneToolingRemoteCatalogRetentionResponse(
        compacted_tool_count=total_compacted,
        compacted_management_metadata_count=total_management_compacted,
        pruned_audit_count=total_audit_pruned,
        providers=summaries,
    )


async def resolve_tooling_remote_tool_aliases(
    db_path: str, request: DBResolveToolingRemoteToolAliasesRequest
) -> DBResolveToolingRemoteToolAliasesResponse:
    db = await _connect(db_path)
    try:
        resolved: dict[str, str] = {}
        for requested_id in request.global_tool_ids:
            alias = await (
                await db.execute(
                    """SELECT canonical_global_tool_id FROM tooling_remote_tool_aliases
                       WHERE peer_id=? AND provider_id=? AND legacy_global_tool_id=?""",
                    (request.peer_id, request.provider_id, requested_id),
                )
            ).fetchone()
            if alias is not None:
                resolved[requested_id] = str(alias["canonical_global_tool_id"])
                continue
            current = await (
                await db.execute(
                    """SELECT 1 FROM tooling_remote_catalog_tools
                       WHERE peer_id=? AND provider_id=? AND global_tool_id=?""",
                    (request.peer_id, request.provider_id, requested_id),
                )
            ).fetchone()
            if current is not None:
                resolved[requested_id] = requested_id
        return DBResolveToolingRemoteToolAliasesResponse(canonical_by_requested_id=resolved)
    finally:
        await db.close()
