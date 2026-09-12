from __future__ import annotations

import pytest

from app.services.tooling.export_policy import (
    ToolingExportPolicyConflictError,
    evaluate_tool_export_policy,
)
from app.shared.contracts.models.tooling import ToolingExportPolicy, ToolingExportRule


def _rule(
    rule_id: str,
    *,
    peer_id: str | None,
    scope_type: str,
    scope_id: str,
    state: str,
) -> ToolingExportRule:
    return ToolingExportRule(
        rule_id=rule_id,
        peer_id=peer_id,
        scope_type=scope_type,
        scope_id=scope_id,
        state=state,
        actor_principal_id="admin",
        reason="test policy",
        created_at=1.0,
        updated_at=1.0,
    )


def test_export_policy_uses_all_five_precedence_levels_independent_of_order() -> None:
    policy = ToolingExportPolicy(default_state="unshared", revision=9, initialized=True)
    rules = [
        _rule(
            "peer-group", peer_id="peer-a", scope_type="group", scope_id="core:x", state="shared"
        ),
        _rule("global-tool", peer_id=None, scope_type="tool", scope_id="tool:x", state="unshared"),
        _rule("global-group", peer_id=None, scope_type="group", scope_id="core:x", state="shared"),
        _rule("peer-tool", peer_id="peer-a", scope_type="tool", scope_id="tool:x", state="shared"),
    ]

    peer_tool = evaluate_tool_export_policy(
        policy=policy,
        rules=reversed(rules),
        peer_id="peer-a",
        global_tool_id="tool:x",
        share_group_id="core:x",
        exportable=True,
    )
    assert (peer_tool.effective_state, peer_tool.inherited_from) == ("shared", "peer_tool")

    global_tool = evaluate_tool_export_policy(
        policy=policy,
        rules=rules[0:3],
        peer_id="peer-a",
        global_tool_id="tool:x",
        share_group_id="core:x",
        exportable=True,
    )
    assert (global_tool.effective_state, global_tool.inherited_from) == (
        "unshared",
        "global_tool",
    )

    peer_group = evaluate_tool_export_policy(
        policy=policy,
        rules=[rules[0], rules[2]],
        peer_id="peer-a",
        global_tool_id="tool:y",
        share_group_id="core:x",
        exportable=True,
    )
    assert (peer_group.effective_state, peer_group.inherited_from) == ("shared", "peer_group")

    global_group = evaluate_tool_export_policy(
        policy=policy,
        rules=[rules[2]],
        peer_id="peer-b",
        global_tool_id="tool:y",
        share_group_id="core:x",
        exportable=True,
    )
    assert (global_group.effective_state, global_group.inherited_from) == (
        "shared",
        "global_group",
    )

    default = evaluate_tool_export_policy(
        policy=policy,
        rules=[],
        peer_id="peer-b",
        global_tool_id="tool:y",
        share_group_id="core:y",
        exportable=True,
    )
    assert (default.effective_state, default.inherited_from) == ("unshared", "global_default")


def test_global_tool_deny_beats_peer_group_share() -> None:
    decision = evaluate_tool_export_policy(
        policy=ToolingExportPolicy(default_state="shared", revision=2),
        rules=[
            _rule(
                "peer-group",
                peer_id="peer-a",
                scope_type="group",
                scope_id="core:x",
                state="shared",
            ),
            _rule(
                "global-tool", peer_id=None, scope_type="tool", scope_id="tool:x", state="unshared"
            ),
        ],
        peer_id="peer-a",
        global_tool_id="tool:x",
        share_group_id="core:x",
        exportable=True,
    )
    assert decision.effective_state == "unshared"
    assert decision.inherited_from == "global_tool"


def test_nonexportable_and_stale_tools_fail_closed_without_runtime_enforcement() -> None:
    decision = evaluate_tool_export_policy(
        policy=ToolingExportPolicy(default_state="shared", revision=2),
        rules=[],
        peer_id="peer-a",
        global_tool_id="mesh:peer:tool",
        share_group_id="mesh:peer",
        exportable=False,
    )
    assert decision.effective_state == "unshared"
    assert decision.reason_code == "tool_not_exportable"
    assert decision.prerequisites.enforcement_active is False


def test_duplicate_authority_key_fails_closed() -> None:
    duplicate = _rule(
        "duplicate", peer_id=None, scope_type="tool", scope_id="tool:x", state="shared"
    )
    with pytest.raises(ToolingExportPolicyConflictError):
        evaluate_tool_export_policy(
            policy=ToolingExportPolicy(),
            rules=[duplicate, duplicate.model_copy(update={"rule_id": "duplicate-2"})],
            peer_id="peer-a",
            global_tool_id="tool:x",
            share_group_id="core:x",
            exportable=True,
        )
