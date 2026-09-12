"""Capability-class and resource-scope grant regressions for Tooling policy."""

from __future__ import annotations

import pytest

from app.shared.contracts.models.tooling import (
    ToolingCreateApprovalGrantRequest,
    ToolingExecuteToolRequest,
    ToolingResourceSelector,
)
from tests.unit.tooling.test_tool_source_trust import _tool

pytest_plugins = ("tests.unit.tooling.test_tool_source_trust",)


@pytest.mark.asyncio
async def test_core_write_tool_needs_matching_capability_and_resource_scope(make_service):
    """A trusted write tool runs only after a matching scoped capability grant."""

    tool = _tool("write_file", source="core", capability_class="write", operation_class="write")
    service = make_service(tool)
    request = ToolingExecuteToolRequest(
        tool_name="write_file",
        arguments={},
        resource_selector=ToolingResourceSelector(
            resource_namespace="filesystem",
            resource_id="/safe/path/note.md",
        ),
    )

    denied = await service._on_execute_tool(request)
    assert denied.ok is False
    assert denied.error_code == "approval_token_required"

    grant = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="capability",
            local_tool_name="write_file",
            provider_peer_id="local",
            capability_class="write",
            resource_scope=["/safe/path"],
            created_by="admin",
        )
    )
    assert grant.ok is True

    allowed = await service._on_execute_tool(request)
    assert allowed.ok is True

    out_of_scope = await service._on_execute_tool(
        request.model_copy(
            update={
                "resource_selector": ToolingResourceSelector(
                    resource_namespace="filesystem",
                    resource_id="/other/path/note.md",
                )
            }
        )
    )
    assert out_of_scope.ok is False
    assert out_of_scope.error_code == "approval_token_required"
