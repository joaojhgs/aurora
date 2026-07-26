"""Pure Tooling export-policy evaluation.

G012 uses this module for management previews only.  Runtime discovery and
execution continue to use the legacy sharing guard until G013 activates the
same decision at every Tooling authority boundary.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.shared.contracts.models.tooling import (
    ToolingExportDecision,
    ToolingExportDecisionSource,
    ToolingExportPolicy,
    ToolingExportPrerequisites,
    ToolingExportRule,
)


class ToolingExportPolicyConflictError(ValueError):
    """Raised when a snapshot contains two rules for one authority key."""


def evaluate_tool_export_policy(
    *,
    policy: ToolingExportPolicy,
    rules: Iterable[ToolingExportRule],
    peer_id: str | None,
    global_tool_id: str,
    share_group_id: str,
    exportable: bool,
    prerequisites: ToolingExportPrerequisites | None = None,
    stale_tool_id: bool = False,
    stale_group_id: bool = False,
) -> ToolingExportDecision:
    """Evaluate the deterministic recipient-specific export precedence.

    The rule index is deliberately order-independent.  Duplicate keys indicate
    corrupt authority state and fail closed rather than choosing an arbitrary
    row.  Prerequisites are explanatory in G012 and do not activate discovery
    or execution enforcement.
    """

    normalized_peer = peer_id.strip() if peer_id else None
    normalized_tool = global_tool_id.strip()
    normalized_group = share_group_id.strip()
    if not normalized_tool:
        raise ValueError("global_tool_id is required")
    if not normalized_group:
        raise ValueError("share_group_id is required")

    by_key: dict[tuple[str | None, str, str], ToolingExportRule] = {}
    for rule in rules:
        key = (rule.peer_id, rule.scope_type, rule.scope_id)
        if key in by_key:
            raise ToolingExportPolicyConflictError(
                "duplicate Tooling export rule for "
                f"peer={rule.peer_id!r} scope={rule.scope_type}:{rule.scope_id}"
            )
        by_key[key] = rule

    candidates: tuple[tuple[ToolingExportDecisionSource, tuple[str | None, str, str]], ...] = (
        ("peer_tool", (normalized_peer, "tool", normalized_tool)),
        ("global_tool", (None, "tool", normalized_tool)),
        ("peer_group", (normalized_peer, "group", normalized_group)),
        ("global_group", (None, "group", normalized_group)),
    )

    matched: ToolingExportRule | None = None
    source: ToolingExportDecisionSource = "global_default"
    if normalized_peer is not None:
        for candidate_source, key in candidates:
            matched = by_key.get(key)
            if matched is not None:
                source = candidate_source
                break
    else:
        for candidate_source, key in candidates:
            if candidate_source.startswith("peer_"):
                continue
            matched = by_key.get(key)
            if matched is not None:
                source = candidate_source
                break

    state = matched.state if matched is not None else policy.default_state
    reason_code = "policy_shared" if state == "shared" else "policy_unshared"
    if not exportable:
        state = "unshared"
        reason_code = "tool_not_exportable"
    elif stale_tool_id:
        state = "unshared"
        reason_code = "stale_tool_id"
    elif stale_group_id:
        state = "unshared"
        reason_code = "stale_group_id"

    return ToolingExportDecision(
        effective_state=state,
        inherited_from=source,
        matched_rule_id=matched.rule_id if matched is not None else None,
        peer_id=normalized_peer,
        global_tool_id=normalized_tool,
        share_group_id=normalized_group,
        exportable=exportable,
        stale_tool_id=stale_tool_id,
        stale_group_id=stale_group_id,
        prerequisites=prerequisites or ToolingExportPrerequisites(local_exportable=exportable),
        policy_revision=policy.revision,
        reason_code=reason_code,
    )
