"""Deterministic recipient-specific Tooling export projections.

This module is deliberately transport-free.  Provider discovery, pagination,
prepare and execute can therefore share the same authority decision rather
than reconstructing subtly different policy checks.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass

from app.services.tooling.export_policy import evaluate_tool_export_policy
from app.shared.auth.permissions import has_permission
from app.shared.contracts.models.tooling import (
    ToolingExportPolicy,
    ToolingExportPrerequisites,
    ToolingExportRule,
    ToolingProjectionAuthorityRevision,
    ToolingProjectionBlockedTool,
    ToolingToolInfo,
)
from app.shared.contracts.registry import all_contracts


def permission_satisfies(required: str, grants: Iterable[str]) -> bool:
    """Apply registry-aware canonical permission semantics, fail closed unknown."""

    contract = all_contracts().get(required)
    method_type = contract.method_type if contract is not None else None
    return has_permission(required, set(grants), method_type=method_type)


@dataclass(frozen=True)
class ProjectionContext:
    recipient_peer_id: str
    recipient_permissions: tuple[str, ...]
    authority_revision: ToolingProjectionAuthorityRevision
    provider_enabled: bool = False
    service_exported: bool = False
    discovery_exported: bool = False
    execution_exported: bool = False


def canonical_projection_payload(tools: Iterable[ToolingToolInfo]) -> list[dict]:
    """Return stable JSON-ready membership without relying on registry order."""

    return [
        tool.model_dump(mode="json", exclude_none=True)
        for tool in sorted(tools, key=lambda item: item.global_tool_id)
    ]


def projection_digest(
    tools: Iterable[ToolingToolInfo],
    *,
    recipient_peer_id: str,
    authority_revision: ToolingProjectionAuthorityRevision,
) -> str:
    payload = {
        "recipient_peer_id": recipient_peer_id,
        "authority_revision": authority_revision.model_dump(mode="json"),
        "tools": canonical_projection_payload(tools),
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def build_recipient_projection(
    candidates: Iterable[ToolingToolInfo],
    *,
    context: ProjectionContext,
    policy: ToolingExportPolicy,
    rules: Iterable[ToolingExportRule],
    stale_tool_ids: Iterable[str] = (),
    stale_group_ids: Iterable[str] = (),
) -> tuple[list[ToolingToolInfo], str]:
    """Filter a local snapshot before search/count/hash serialization.

    Remote tools and malformed/unreconciled local identities disappear without
    a retirement or error oracle.  Missing authority fails closed.
    """

    if not all(
        (
            context.provider_enabled,
            context.service_exported,
            context.discovery_exported,
            context.execution_exported,
            bool(context.recipient_peer_id),
        )
    ):
        visible: list[ToolingToolInfo] = []
    else:
        grants = context.recipient_permissions
        stale_tools = set(stale_tool_ids)
        stale_groups = set(stale_group_ids)
        visible = []
        for tool in candidates:
            if (
                tool.source_type != "local"
                or tool.execution_location != "local"
                or not tool.exportable
                or tool.provider_peer_id == context.recipient_peer_id
                or not tool.global_tool_id
                or not tool.share_group_id
            ):
                continue
            required = ("Tooling.GetTools", "Tooling.ExecuteTool", *tool.required_permissions)
            if not all(permission_satisfies(item, grants) for item in required):
                continue
            decision = evaluate_tool_export_policy(
                policy=policy,
                rules=rules,
                peer_id=context.recipient_peer_id,
                global_tool_id=tool.global_tool_id,
                share_group_id=tool.share_group_id,
                exportable=tool.exportable,
                stale_tool_id=tool.global_tool_id in stale_tools,
                stale_group_id=tool.share_group_id in stale_groups,
                prerequisites=ToolingExportPrerequisites(
                    service_shared=context.service_exported,
                    discovery_method_shared=context.discovery_exported,
                    execute_method_shared=context.execution_exported,
                    peer_discovery_rbac=True,
                    peer_execute_rbac=True,
                    tool_required_permissions_granted=True,
                    local_exportable=True,
                    enforcement_active=True,
                ),
            )
            if decision.effective_state == "shared":
                visible.append(tool)
    visible.sort(key=lambda item: item.global_tool_id)
    return visible, projection_digest(
        visible,
        recipient_peer_id=context.recipient_peer_id,
        authority_revision=context.authority_revision,
    )


def build_recipient_blocked_inventory(
    candidates: Iterable[ToolingToolInfo],
    *,
    context: ProjectionContext,
    policy: ToolingExportPolicy,
    rules: Iterable[ToolingExportRule],
    stale_tool_ids: Iterable[str] = (),
    stale_group_ids: Iterable[str] = (),
) -> list[ToolingProjectionBlockedTool]:
    """Return policy-shared definitions blocked only by tool-specific RBAC.

    This inventory is management-only. It deliberately requires the peer's
    Tooling discovery and execution authority before disclosing definitions,
    and it does not reveal tools hidden by provider export policy.
    """

    if not all(
        (
            context.provider_enabled,
            context.service_exported,
            context.discovery_exported,
            context.execution_exported,
            bool(context.recipient_peer_id),
            permission_satisfies("Tooling.GetTools", context.recipient_permissions),
            permission_satisfies("Tooling.ExecuteTool", context.recipient_permissions),
        )
    ):
        return []

    stale_tools = set(stale_tool_ids)
    stale_groups = set(stale_group_ids)
    blocked: list[ToolingProjectionBlockedTool] = []
    for tool in candidates:
        if (
            tool.source_type != "local"
            or tool.execution_location != "local"
            or not tool.exportable
            or tool.provider_peer_id == context.recipient_peer_id
            or not tool.global_tool_id
            or not tool.share_group_id
        ):
            continue
        missing = sorted(
            {
                required
                for required in tool.required_permissions
                if not permission_satisfies(required, context.recipient_permissions)
            }
        )
        if not missing:
            continue
        decision = evaluate_tool_export_policy(
            policy=policy,
            rules=rules,
            peer_id=context.recipient_peer_id,
            global_tool_id=tool.global_tool_id,
            share_group_id=tool.share_group_id,
            exportable=tool.exportable,
            stale_tool_id=tool.global_tool_id in stale_tools,
            stale_group_id=tool.share_group_id in stale_groups,
            prerequisites=ToolingExportPrerequisites(
                service_shared=context.service_exported,
                discovery_method_shared=context.discovery_exported,
                execute_method_shared=context.execution_exported,
                peer_discovery_rbac=True,
                peer_execute_rbac=True,
                tool_required_permissions_granted=True,
                local_exportable=True,
                enforcement_active=True,
            ),
        )
        if decision.effective_state == "shared":
            blocked.append(
                ToolingProjectionBlockedTool(
                    tool=tool,
                    reason_code="recipient_missing_tool_permissions",
                    missing_permissions=missing,
                )
            )
    return sorted(blocked, key=lambda item: item.tool.global_tool_id)
