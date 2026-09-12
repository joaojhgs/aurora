"""Tool source, trust tier, and bypass policy regression tests."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import QueryResult
from app.services.tooling.service import ToolingService
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.db import DBMethods
from app.shared.contracts.models.tooling import (
    ToolingCreateApprovalGrantRequest,
    ToolingExecuteToolRequest,
    ToolingResourceSelector,
    ToolingSetSharingPolicyRequest,
    ToolingSharingPolicy,
)


class _SqliteBus:
    """Small DB/audit bus double for Tooling policy tests."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.subscribe = Mock()
        self.publish = AsyncMock()
        self.request = AsyncMock(side_effect=self._request)

    async def _request(self, topic: str, payload, **kwargs) -> QueryResult:
        if topic == DBMethods.EXECUTE_SQL:
            with sqlite3.connect(self.db_path) as connection:
                connection.row_factory = sqlite3.Row
                cursor = connection.execute(payload.sql, payload.params or [])
                rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
                connection.commit()
            return QueryResult(ok=True, data={"rows": rows})
        if topic == AuthMethods.STORE_AUDIT_EVENT:
            return QueryResult(ok=True, data={"stored": True})
        if topic == ConfigMethods.SET:
            return QueryResult(ok=True, data={"success": True})
        return QueryResult(ok=False, error=f"unexpected topic {topic}")


def _tool(
    name: str,
    *,
    source: str = "core",
    trust_tier: str | None = None,
    capability_class: str = "read",
    operation_class: str = "read",
    confirmation_required: bool = False,
) -> Mock:
    tool = Mock()
    tool.name = name
    tool.description = f"{name} test tool"
    tool.args_schema = {"type": "object", "properties": {}}
    tool.safety_class = "standard"
    tool.source = source
    tool.operation_class = operation_class
    tool.capability_class = capability_class
    tool.confirmation_required = confirmation_required
    tool.required_permissions = []
    tool.ainvoke = AsyncMock(return_value={"ok": True})
    if source == "mcp":
        tool._is_mcp_tool = True
    else:
        tool.__module__ = (
            "app.services.tooling.tools.test_tool"
            if source == "core"
            else f"community.{source}.tool"
        )
    if trust_tier is not None:
        tool.trust_tier = trust_tier
    return tool


@pytest.fixture
def make_service(tmp_path: Path):
    """Create a ToolingService with a single installed tool."""

    bus = _SqliteBus(tmp_path / "tooling-policy.db")
    patchers = [
        patch("app.services.tooling.service.ToolsManager"),
        patch("app.services.tooling.service.set_tools_manager"),
        patch("app.shared.services.base_service.get_bus_singleton", return_value=bus),
    ]
    mock_tools_manager_cls = patchers[0].start()
    for patcher in patchers[1:]:
        patcher.start()

    def _make(tool: Mock) -> ToolingService:
        manager = Mock()
        manager.initialize = AsyncMock()
        manager.get_stats = Mock(return_value={"total_tools": 1, "mcp_tools_loaded": False})
        manager.get_tools = Mock(return_value=[tool])
        manager.get_tool_by_name = Mock(return_value=tool)
        manager.get_all_tool_names = Mock(return_value=[tool.name])
        mock_tools_manager_cls.return_value = manager
        service = ToolingService()
        service.tools_manager = manager
        service._config.aupdate_config = AsyncMock(return_value=True)
        return service

    yield _make

    for patcher in reversed(patchers):
        patcher.stop()


@pytest.mark.asyncio
async def test_mcp_tool_defaults_to_untrusted_and_requires_approval(make_service):
    """MCP/community tools must not auto-run under local-safe defaults."""

    tool = _tool("mcp_search", source="mcp")
    service = make_service(tool)

    prepared = await service._on_prepare_execution(
        ToolingExecuteToolRequest(tool_name="mcp_search", arguments={})
    )
    executed = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="mcp_search", arguments={})
    )

    assert prepared.source == "mcp"
    assert prepared.trust_tier == "untrusted"
    assert prepared.capability_class == "read"
    assert prepared.policy_decision.approval_required is True
    assert prepared.policy_decision.reason == "approval_required_by_untrusted_source"
    assert executed.ok is False
    assert executed.error_code == "approval_token_required"
    tool.ainvoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_core_write_tool_requires_scoped_capability_grant(make_service):
    """Trusted native write tools still need an explicit matching resource scope."""

    tool = _tool(
        "write_file",
        source="core",
        capability_class="write",
        operation_class="write",
    )
    service = make_service(tool)
    request = ToolingExecuteToolRequest(
        tool_name="write_file",
        arguments={},
        resource_selector=ToolingResourceSelector(
            resource_namespace="filesystem",
            resource_id="/safe/path/note.md",
        ),
    )
    prepared = await service._on_prepare_execution(request)

    assert prepared.trust_tier == "trusted"
    assert prepared.capability_class == "write"
    assert prepared.policy_decision.approval_required is True
    assert prepared.policy_decision.reason == "approval_required_by_capability"

    denied_out_of_scope = await service._on_execute_tool(request)
    assert denied_out_of_scope.ok is False
    assert denied_out_of_scope.error_code == "approval_token_required"

    grant_response = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="capability",
            local_tool_name="write_file",
            provider_peer_id=prepared.provider_peer_id,
            capability_class="write",
            resource_scope=["/safe/path"],
            created_by="admin",
        )
    )
    assert grant_response.ok is True

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


@pytest.mark.asyncio
async def test_unrestricted_except_blocked_executes_untrusted_but_not_blocked(make_service):
    """Bypass mode executes non-blocked tools but explicit blocked tools still lose."""

    tool = _tool("community_search", source="plugin")
    service = make_service(tool)
    rejected = await service._on_set_sharing_policy(
        ToolingSetSharingPolicyRequest(
            actor_principal_id="admin",
            policy=ToolingSharingPolicy(policy_mode="unrestricted_except_blocked"),
        )
    )
    assert rejected.ok is False
    assert rejected.error == "confirmation_required"

    await service._on_set_sharing_policy(
        ToolingSetSharingPolicyRequest(
            actor_principal_id="admin",
            policy=ToolingSharingPolicy(policy_mode="unrestricted_except_blocked"),
            confirmation_text="ALLOW NON-BLOCKED TOOLS",
        )
    )

    executed = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="community_search", arguments={})
    )

    assert executed.ok is True
    assert tool.ainvoke.await_count == 1

    blocking_grant = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="deny_always",
            grant_type="trust",
            local_tool_name="community_search",
            provider_peer_id="local",
            trust_tier="blocked",
            created_by="admin",
        )
    )
    assert blocking_grant.ok is True

    blocked = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="community_search", arguments={})
    )
    assert blocked.ok is False
    assert blocked.error_code == "tool_blocked"
    assert tool.ainvoke.await_count == 1


@pytest.mark.asyncio
async def test_mcp_tool_cannot_self_declare_core_or_trusted(make_service):
    """MCP/plugin metadata cannot elevate itself into trusted core execution."""

    tool = _tool("mcp_claims_core", source="mcp", trust_tier="trusted")
    tool.source = "core"
    service = make_service(tool)

    prepared = await service._on_prepare_execution(
        ToolingExecuteToolRequest(tool_name="mcp_claims_core", arguments={})
    )
    executed = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="mcp_claims_core", arguments={})
    )

    assert prepared.source == "mcp"
    assert prepared.trust_tier == "untrusted"
    assert prepared.policy_decision.approval_required is True
    assert executed.ok is False
    assert executed.error_code == "approval_token_required"


@pytest.mark.asyncio
async def test_untrusted_trust_grant_does_not_authorize_execution(make_service):
    """Reset/approval-required grants are metadata, not durable authorization."""

    tool = _tool("mcp_search", source="mcp")
    service = make_service(tool)
    prepared = await service._on_prepare_execution(
        ToolingExecuteToolRequest(tool_name="mcp_search", arguments={})
    )
    reset_grant = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="trust",
            local_tool_name="mcp_search",
            provider_peer_id=prepared.provider_peer_id,
            trust_tier="untrusted",
            created_by="admin",
        )
    )

    executed = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="mcp_search", arguments={})
    )

    assert reset_grant.ok is True
    assert executed.ok is False
    assert executed.error_code == "approval_token_required"
    tool.ainvoke.assert_not_awaited()
