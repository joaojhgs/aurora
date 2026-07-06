"""Bypass policy regressions for Tooling execution."""

from __future__ import annotations

import pytest

from app.shared.contracts.models.tooling import (
    ToolingCreateApprovalGrantRequest,
    ToolingExecuteToolRequest,
    ToolingSetSharingPolicyRequest,
    ToolingSharingPolicy,
)
from tests.unit.tooling.test_tool_source_trust import _tool

pytest_plugins = ("tests.unit.tooling.test_tool_source_trust",)


@pytest.mark.asyncio
async def test_unrestricted_except_blocked_bypasses_approval_but_not_blocks(make_service):
    """Bypass mode allows non-blocked untrusted tools while explicit blocks still win."""

    tool = _tool("community_search", source="plugin")
    service = make_service(tool)
    await service._on_set_sharing_policy(
        ToolingSetSharingPolicyRequest(
            actor_principal_id="admin",
            policy=ToolingSharingPolicy(policy_mode="unrestricted_except_blocked"),
            confirmation_text="ALLOW NON-BLOCKED TOOLS",
        )
    )

    allowed = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="community_search", arguments={})
    )
    assert allowed.ok is True

    block = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="deny_always",
            grant_type="trust",
            local_tool_name="community_search",
            provider_peer_id="local",
            trust_tier="blocked",
            created_by="admin",
        )
    )
    assert block.ok is True

    denied = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="community_search", arguments={})
    )
    assert denied.ok is False
    assert denied.error_code == "tool_blocked"
    assert tool.ainvoke.await_count == 1
