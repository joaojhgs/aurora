"""Tooling policy default and explainability tests."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import QueryResult
from app.services.tooling.service import ToolingService
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.tooling import (
    ToolingExecuteToolRequest,
    ToolingPrepareExecutionRequest,
    ToolingSetSharingPolicyRequest,
    ToolingSharingPolicy,
    ToolingSharingPolicyRule,
)


@pytest.fixture
def mock_bus():
    """Create a bus double that accepts audit requests."""

    bus = Mock()
    bus.subscribe = Mock()
    bus.publish = AsyncMock()

    async def _request(topic, payload, **kwargs):
        if topic == AuthMethods.STORE_AUDIT_EVENT:
            return QueryResult(ok=True, data={"stored": True})
        if topic == ConfigMethods.SET:
            return QueryResult(ok=True, data={"success": True})
        return QueryResult(ok=True, data={})

    bus.request = AsyncMock(side_effect=_request)
    return bus


@pytest.fixture
def tooling_service(mock_bus):
    """Create a ToolingService with mocked tool manager."""

    with (
        patch("app.services.tooling.service.ToolsManager") as mock_tools_mgr,
        patch("app.services.tooling.service.set_tools_manager"),
        patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
    ):
        manager = Mock()
        manager.initialize = AsyncMock()
        manager.get_stats = Mock(return_value={"total_tools": 1, "mcp_tools_loaded": False})
        manager.get_tools = Mock(return_value=[])
        manager.get_tool_by_name = Mock(return_value=None)
        manager.get_all_tool_names = Mock(return_value=[])
        mock_tools_mgr.return_value = manager

        service = ToolingService()
        service.tools_manager = manager
        service._config.aupdate_config = AsyncMock(return_value=True)
        return service


def _tool(*, safety_class: str = "standard", confirmation_required: bool = False) -> Mock:
    tool = Mock()
    tool.name = "safe_tool"
    tool.args_schema = {"type": "object", "properties": {}}
    tool.safety_class = safety_class
    tool.confirmation_required = confirmation_required
    tool.operation_class = "read"
    tool.source = "core"
    tool.ainvoke = AsyncMock(return_value={"ok": True})
    return tool


def _install_tool(service: ToolingService, tool: Mock) -> None:
    service.tools_manager.get_all_tool_names = Mock(return_value=[tool.name])
    service.tools_manager.get_tool_by_name = Mock(return_value=tool)


async def _set_policy(
    service: ToolingService,
    *,
    default_approval_mode: str = "approve_all_local_safe",
    rule: ToolingSharingPolicyRule | None = None,
    policy_mode: str = "enforce",
) -> None:
    await service._on_set_sharing_policy(
        ToolingSetSharingPolicyRequest(
            actor_principal_id="admin",
            policy=ToolingSharingPolicy(
                default_approval_mode=default_approval_mode,
                policy_mode=policy_mode,
                rules=[rule] if rule else [],
            ),
        )
    )


def test_tooling_policy_defaults_are_aligned():
    """Schema, generated config defaults, and contract model agree on local-safe default."""

    schema = json.loads(Path("app/services/config/config_schema.json").read_text())
    defaults = json.loads(Path("app/services/config/config_defaults.json").read_text())

    assert ToolingSharingPolicy().default_approval_mode == "approve_all_local_safe"
    assert (
        schema["$defs"]["tooling_approval_policy"]["properties"]["default_approval_mode"][
            "default"
        ]
        == "approve_all_local_safe"
    )
    assert (
        defaults["services"]["tooling"]["approval_policy"]["default_approval_mode"]
        == "approve_all_local_safe"
    )


@pytest.mark.asyncio
async def test_safe_local_standard_tool_auto_approves_with_backend_explanation(tooling_service):
    """Default local-safe policy executes standard local tools without approval."""

    tool = _tool()
    _install_tool(tooling_service, tool)

    prepared = await tooling_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(tool_name="safe_tool", arguments={})
    )
    executed = await tooling_service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="safe_tool", arguments={})
    )

    assert prepared.ok is True
    assert prepared.policy_decision.allowed is True
    assert prepared.policy_decision.approval_required is False
    assert prepared.policy_decision.effective_default == "approve_all_local_safe"
    assert prepared.policy_decision.auto_approved_reason == "local_safe_tool"
    assert executed.ok is True
    tool.ainvoke.assert_awaited_once()


@pytest.mark.asyncio
async def test_matching_ask_each_time_rule_prompts_even_for_safe_tool(tooling_service):
    """Scoped ask_each_time rules override local-safe default."""

    tool = _tool()
    _install_tool(tooling_service, tool)
    await _set_policy(
        tooling_service,
        rule=ToolingSharingPolicyRule(
            rule_id="ask-safe-tool",
            tool_name="safe_tool",
            approval_mode="ask_each_time",
        ),
    )

    prepared = await tooling_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(tool_name="safe_tool", arguments={})
    )
    executed = await tooling_service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="safe_tool", arguments={})
    )

    assert prepared.policy_decision.approval_required is True
    assert prepared.policy_decision.policy_rule_id == "ask-safe-tool"
    assert prepared.policy_decision.reason == "approval_required_by_policy"
    assert executed.ok is False
    assert executed.error_code == "approval_token_required"
    tool.ainvoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_confirmation_required_tool_prompts_under_local_safe_default(tooling_service):
    """Sensitive or confirmation-required tools still require approval by default."""

    tool = _tool(safety_class="sensitive", confirmation_required=True)
    _install_tool(tooling_service, tool)

    prepared = await tooling_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(tool_name="safe_tool", arguments={})
    )

    assert prepared.policy_decision.allowed is True
    assert prepared.policy_decision.approval_required is True
    assert prepared.policy_decision.reason == "approval_required_by_tool"
    assert prepared.policy_decision.auto_approved_reason is None


@pytest.mark.asyncio
async def test_deny_all_blocks_prepare_and_execute(tooling_service):
    """deny_all is explicit and blocks prepare plus real execution."""

    tool = _tool()
    _install_tool(tooling_service, tool)
    await _set_policy(tooling_service, default_approval_mode="deny_all")

    prepared = await tooling_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(tool_name="safe_tool", arguments={})
    )
    executed = await tooling_service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="safe_tool", arguments={})
    )

    assert prepared.ok is False
    assert prepared.policy_decision.allowed is False
    assert prepared.policy_decision.reason == "policy_denied"
    assert executed.ok is False
    assert executed.error_code == "policy_denied"
    tool.ainvoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_dry_run_only_allows_dry_run_and_blocks_real_execute(tooling_service):
    """dry_run_only exposes safe dry-run behavior while blocking actual invocation."""

    tool = _tool()
    _install_tool(tooling_service, tool)
    await _set_policy(tooling_service, default_approval_mode="dry_run_only")

    blocked = await tooling_service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="safe_tool", arguments={})
    )
    dry_run = await tooling_service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="safe_tool", arguments={}, dry_run=True)
    )

    assert blocked.ok is False
    assert blocked.error_code == "dry_run_only"
    assert dry_run.ok is True
    assert dry_run.status == "dry_run"
    tool.ainvoke.assert_not_awaited()
