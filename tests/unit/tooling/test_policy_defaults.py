"""Tooling policy default and explainability tests."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import QueryResult
from app.services.tooling.service import (
    TOOLING_AUDIT_REQUEST_TIMEOUT_SECONDS,
    ToolingService,
)
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.tooling import (
    ToolingExecuteToolRequest,
    ToolingGetToolCatalogRequest,
    ToolingGetToolsRequest,
    ToolingMethods,
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


def _tool(
    *,
    name: str = "safe_tool",
    safety_class: str = "standard",
    confirmation_required: bool = False,
    trust_tier: str | None = None,
    operation_class: str = "read",
    source: str = "core",
) -> Mock:
    tool = Mock()
    tool.name = name
    tool.description = f"{name} test tool"
    tool.args_schema = {"type": "object", "properties": {}}
    tool.safety_class = safety_class
    tool.confirmation_required = confirmation_required
    tool.operation_class = operation_class
    tool.source = source
    tool.required_permissions = []
    if trust_tier is not None:
        tool.trust_tier = trust_tier
    tool.ainvoke = AsyncMock(return_value={"ok": True})
    return tool


def _install_tool(service: ToolingService, tool: Mock) -> None:
    service.tools_manager.get_all_tool_names = Mock(return_value=[tool.name])
    service.tools_manager.get_tool_by_name = Mock(return_value=tool)
    service.tools_manager.get_tools = Mock(return_value=[tool])


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
        schema["$defs"]["tooling_approval_policy"]["properties"]["default_approval_mode"]["default"]
        == "approve_all_local_safe"
    )
    assert (
        defaults["services"]["tooling"]["approval_policy"]["default_approval_mode"]
        == "approve_all_local_safe"
    )


@pytest.mark.asyncio
async def test_share_false_core_search_tool_stays_discoverable_but_execution_is_denied(
    tooling_service,
):
    """Policy sharing controls execution, not LLM discovery/model binding."""

    tool = _tool(name="search")
    _install_tool(tooling_service, tool)
    await _set_policy(
        tooling_service,
        rule=ToolingSharingPolicyRule(
            rule_id="hide-no-longer",
            tool_name="search",
            share=False,
            approval_mode="ask_each_time",
        ),
    )

    discovered = await tooling_service._on_get_tools(ToolingGetToolsRequest())
    catalog = await tooling_service._on_get_tool_catalog(
        ToolingGetToolCatalogRequest(caller_permissions=["*"])
    )
    executed = await tooling_service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name="search", arguments={})
    )

    assert [item.local_name for item in discovered.tools] == ["search"]
    assert [item.local_name for item in catalog.tools] == ["search"]
    assert executed.ok is False
    assert executed.error_code == "tool_not_shared"
    tool.ainvoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_explicitly_blocked_tool_is_hidden_from_discovery(tooling_service):
    """Only explicit trust_tier=blocked removes a tool from LLM discovery."""

    tool = _tool(trust_tier="blocked")
    _install_tool(tooling_service, tool)

    discovered = await tooling_service._on_get_tools(ToolingGetToolsRequest())
    catalog = await tooling_service._on_get_tool_catalog(
        ToolingGetToolCatalogRequest(caller_permissions=["*"])
    )

    assert discovered.tools == []
    assert catalog.tools == []


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
async def test_trusted_core_duckduckgo_search_auto_approves_and_fails_normally(
    tooling_service,
    mock_bus,
):
    """Trusted built-in search is not approval-gated; backend failures are tool errors."""

    tool = _tool(
        name="duckduckgo_results_json",
        operation_class="external",
    )
    tool.description = "Duck Duck Go Search for latest news and current events"
    tool.ainvoke = AsyncMock(side_effect=RuntimeError("search backend unconfigured"))
    _install_tool(tooling_service, tool)

    prepared = await tooling_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(
            tool_name="duckduckgo_results_json",
            arguments={"query": "latest aurora news"},
        )
    )
    executed = await tooling_service._on_execute_tool(
        ToolingExecuteToolRequest(
            tool_name="duckduckgo_results_json",
            arguments={"query": "latest aurora news"},
        )
    )

    assert prepared.ok is True
    assert prepared.capability_class == "network"
    assert prepared.policy_decision.approval_required is False
    assert prepared.policy_decision.auto_approved_reason == "trusted_core_web_search"
    assert executed.ok is False
    assert executed.status == "failed"
    assert executed.error_code == "tool_execution_failed"
    assert "search backend unconfigured" in (executed.error or "")
    tool.ainvoke.assert_awaited_once()
    assert all(call.args[0] != ToolingMethods.REQUEST_APPROVAL for call in mock_bus.request.await_args_list)


@pytest.mark.asyncio
async def test_tooling_audit_uses_short_bounded_store_audit_timeout(tooling_service, mock_bus):
    """Tooling audit calls are best-effort and bounded below the old 5s timeout."""

    request = ToolingExecuteToolRequest(tool_name="safe_tool", arguments={})

    with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
        await tooling_service._audit_tooling_event(
            "tooling.test",
            principal_id="principal",
            details={"ok": True},
        )
        await tooling_service._audit_tool_execution(
            request,
            local_tool_name="safe_tool",
            global_tool_id="local:Tooling:tool:safe_tool",
            provider_peer_id="local",
            safety_class="standard",
            status="success",
        )

    audit_calls = [
        call
        for call in mock_bus.request.await_args_list
        if call.args and call.args[0] == AuthMethods.STORE_AUDIT_EVENT
    ]
    assert len(audit_calls) >= 2
    assert all(
        call.kwargs["timeout"] == TOOLING_AUDIT_REQUEST_TIMEOUT_SECONDS
        for call in audit_calls[-2:]
    )
    assert TOOLING_AUDIT_REQUEST_TIMEOUT_SECONDS <= 0.5


@pytest.mark.asyncio
async def test_matching_ask_each_time_rule_prompts_even_for_trusted_core_search(
    tooling_service,
):
    """Explicit ask_each_time rules override built-in search auto-approval."""

    tool = _tool(
        name="duckduckgo_results_json",
        operation_class="external",
    )
    tool.description = "Duck Duck Go Search for latest news and current events"
    _install_tool(tooling_service, tool)
    await _set_policy(
        tooling_service,
        rule=ToolingSharingPolicyRule(
            rule_id="ask-search",
            tool_name="duckduckgo_results_json",
            approval_mode="ask_each_time",
        ),
    )

    prepared = await tooling_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(
            tool_name="duckduckgo_results_json",
            arguments={"query": "latest aurora news"},
        )
    )
    executed = await tooling_service._on_execute_tool(
        ToolingExecuteToolRequest(
            tool_name="duckduckgo_results_json",
            arguments={"query": "latest aurora news"},
        )
    )

    assert prepared.policy_decision.approval_required is True
    assert prepared.policy_decision.policy_rule_id == "ask-search"
    assert prepared.policy_decision.reason == "approval_required_by_policy"
    assert executed.ok is False
    assert executed.error_code == "approval_token_required"
    tool.ainvoke.assert_not_awaited()


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
