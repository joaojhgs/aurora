"""Tooling management read-model contract tests."""

from __future__ import annotations

import json
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
    ToolingCreateMCPSourceRequest,
    ToolingCreatePluginSourceRequest,
    ToolingGetOnboardingStatusRequest,
    ToolingGetPolicySummaryRequest,
    ToolingGetToolSourceDetailRequest,
    ToolingListPendingApprovalsRequest,
    ToolingListPolicyAuditEventsRequest,
    ToolingListToolSourcesRequest,
    ToolingMethods,
    ToolingRequestApprovalRequest,
    ToolingSetPolicyModeRequest,
    ToolingTestMCPSourceRequest,
    ToolingTestPluginSourceRequest,
    ToolingUpsertSourcePolicyRequest,
    ToolingUpsertToolPolicyOverrideRequest,
)


class _SqliteAuditBus:
    """DB/config/audit bus double for Tooling management read models."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.subscribe = Mock()
        self.publish = AsyncMock()
        self.audit_events: list[object] = []
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
            self.audit_events.append(payload)
            return QueryResult(ok=True, data={"stored": True})
        if topic == AuthMethods.AUDIT_LOG:
            events = [
                {
                    "event": event.event,
                    "principal_id": event.principal_id,
                    "details": event.details,
                    "created_at": "2026-07-06T00:00:00Z",
                }
                for event in self.audit_events
            ]
            return QueryResult(ok=True, data={"events": events, "total": len(events)})
        if topic == ConfigMethods.SET:
            return QueryResult(ok=True, data={"success": True})
        return QueryResult(ok=False, error=f"unexpected topic {topic}")


def _tool(name: str, *, source: str = "core", secret_schema: bool = False) -> Mock:
    tool = Mock()
    tool.name = name
    tool.description = f"{name} test tool"
    properties = {"query": {"type": "string"}}
    if secret_schema:
        properties["api_key"] = {"type": "string"}
    tool.args_schema = {"type": "object", "properties": properties}
    tool.safety_class = "standard"
    tool.source = source
    tool.operation_class = "read"
    tool.capability_class = "read"
    tool.confirmation_required = False
    tool.required_permissions = []
    tool.ainvoke = AsyncMock(return_value={"ok": True})
    if source == "mcp":
        tool._is_mcp_tool = True
        tool.mcp_server_name = "search"
    else:
        tool.__module__ = (
            "app.services.tooling.tools.test_tool"
            if source == "core"
            else f"community.{source}.tool"
        )
        if source == "plugin":
            tool.plugin_name = "lookup"
    return tool


@pytest.fixture
def management_service(tmp_path: Path):
    """Create a ToolingService with core, MCP, and plugin tools."""

    bus = _SqliteAuditBus(tmp_path / "tooling-management.db")
    tools = [
        _tool("core_status", source="core"),
        _tool("mcp_secret_search", source="mcp", secret_schema=True),
        _tool("plugin_lookup", source="plugin"),
    ]
    patchers = [
        patch("app.services.tooling.service.ToolsManager"),
        patch("app.services.tooling.service.set_tools_manager"),
        patch("app.shared.services.base_service.get_bus_singleton", return_value=bus),
    ]
    mock_tools_manager_cls = patchers[0].start()
    for patcher in patchers[1:]:
        patcher.start()

    manager = Mock()
    manager.initialize = AsyncMock()
    manager.get_stats = Mock(return_value={"total_tools": len(tools), "mcp_tools_loaded": True})
    manager.get_tools = Mock(return_value=tools)
    manager.get_tool_by_name = Mock(
        side_effect=lambda name: next((t for t in tools if t.name == name), None)
    )
    manager.get_all_tool_names = Mock(return_value=[tool.name for tool in tools])
    manager.get_mcp_status = Mock(
        return_value={
            "servers": [
                {
                    "name": "search",
                    "enabled": True,
                    "headers": {"Authorization": "Bearer super-secret-token"},
                }
            ],
            "total_servers": 1,
            "active_servers": 1,
        }
    )
    mock_tools_manager_cls.return_value = manager
    service = ToolingService()
    service.tools_manager = manager
    service._config.aupdate_config = AsyncMock(return_value=True)

    yield service, bus

    for patcher in reversed(patchers):
        patcher.stop()


def test_management_read_model_contracts_are_external_manage_methods():
    """Management read models are typed, Gateway-safe, and permission-gated."""

    for method in [
        ToolingService._on_get_policy_summary,
        ToolingService._on_list_tool_sources,
        ToolingService._on_get_tool_source_detail,
        ToolingService._on_list_pending_approvals,
        ToolingService._on_list_policy_audit_events,
        ToolingService._on_get_onboarding_status,
        ToolingService._on_set_policy_mode,
        ToolingService._on_upsert_source_policy,
        ToolingService._on_upsert_tool_policy_override,
        ToolingService._on_test_mcp_source,
        ToolingService._on_create_mcp_source,
        ToolingService._on_test_plugin_source,
        ToolingService._on_create_plugin_source,
    ]:
        metadata = getattr(method, "_contract_metadata", {})
        assert metadata.get("exposure") == "both"
        assert metadata.get("method_type") == "manage"
        assert metadata.get("required_perms") == ["Tooling.manage"]

    assert ToolingMethods.GET_POLICY_SUMMARY == "Tooling.GetPolicySummary"
    assert ToolingMethods.LIST_TOOL_SOURCES == "Tooling.ListToolSources"
    assert ToolingMethods.GET_TOOL_SOURCE_DETAIL == "Tooling.GetToolSourceDetail"
    assert ToolingMethods.LIST_PENDING_APPROVALS == "Tooling.ListPendingApprovals"
    assert ToolingMethods.LIST_POLICY_AUDIT_EVENTS == "Tooling.ListPolicyAuditEvents"
    assert ToolingMethods.GET_ONBOARDING_STATUS == "Tooling.GetOnboardingStatus"
    assert ToolingMethods.SET_POLICY_MODE == "Tooling.SetPolicyMode"
    assert ToolingMethods.UPSERT_SOURCE_POLICY == "Tooling.UpsertSourcePolicy"
    assert ToolingMethods.UPSERT_TOOL_POLICY_OVERRIDE == "Tooling.UpsertToolPolicyOverride"
    assert ToolingMethods.TEST_MCP_SOURCE == "Tooling.TestMCPSource"
    assert ToolingMethods.CREATE_MCP_SOURCE == "Tooling.CreateMCPSource"
    assert ToolingMethods.TEST_PLUGIN_SOURCE == "Tooling.TestPluginSource"
    assert ToolingMethods.CREATE_PLUGIN_SOURCE == "Tooling.CreatePluginSource"


@pytest.mark.asyncio
async def test_policy_summary_sources_and_detail_include_counts_and_grants(management_service):
    """Policy/source read models summarize catalog groups without UI inference."""

    service, _bus = management_service
    grant = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="trust",
            local_tool_name="mcp_secret_search",
            provider_peer_id="local",
            trust_tier="trusted",
            created_by="admin",
            reason="operator reviewed MCP source",
        )
    )
    assert grant.ok is True

    sources = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    source_ids = {source.source_id for source in sources.sources}
    assert {"local:core", "local:mcp:search", "local:plugin:lookup"}.issubset(source_ids)
    mcp_source = next(
        source for source in sources.sources if source.source_id == "local:mcp:search"
    )
    assert mcp_source.tool_count == 1
    assert mcp_source.active_grant_count == 1

    detail = await service._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id="local:mcp:search")
    )
    assert detail.found is True
    assert [tool.name for tool in detail.tools] == ["mcp_secret_search"]
    assert [grant.local_tool_name for grant in detail.grants] == ["mcp_secret_search"]

    summary = await service._on_get_policy_summary(ToolingGetPolicySummaryRequest())
    assert summary.policy_mode == "enforce"
    assert summary.active_grant_count == 1
    assert summary.source_count >= 3
    assert summary.tool_count == 3


@pytest.mark.asyncio
async def test_mcp_and_plugin_sources_keep_distinct_policy_identity(management_service):
    """Multiple local MCP/plugin sources must not collapse into one policy bucket."""

    service, _bus = management_service
    mail_mcp = _tool("mcp_mail_search", source="mcp")
    mail_mcp.mcp_server_name = "mail"
    calendar_mcp = _tool("mcp_calendar_search", source="mcp")
    calendar_mcp.mcp_server_name = "calendar"
    weather_plugin = _tool("plugin_weather", source="plugin")
    weather_plugin.plugin_name = "weather"
    notes_plugin = _tool("plugin_notes", source="plugin")
    notes_plugin.plugin_name = "notes"
    tools = [mail_mcp, calendar_mcp, weather_plugin, notes_plugin]
    service.tools_manager.get_tools.return_value = tools
    service.tools_manager.get_tool_by_name.side_effect = lambda name: next(
        (tool for tool in tools if tool.name == name), None
    )

    sources = await service._on_list_tool_sources(ToolingListToolSourcesRequest())
    source_ids = {source.source_id for source in sources.sources}

    assert {
        "local:mcp:mail",
        "local:mcp:calendar",
        "local:plugin:weather",
        "local:plugin:notes",
    }.issubset(source_ids)
    mail_detail = await service._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id="local:mcp:mail")
    )
    calendar_detail = await service._on_get_tool_source_detail(
        ToolingGetToolSourceDetailRequest(source_id="local:mcp:calendar")
    )
    assert [tool.local_name for tool in mail_detail.tools] == ["mcp_mail_search"]
    assert [tool.local_name for tool in calendar_detail.tools] == ["mcp_calendar_search"]


@pytest.mark.asyncio
async def test_pending_approvals_and_audit_history_are_redacted(management_service):
    """Pending approval and audit read models do not expose raw secret arguments."""

    service, bus = management_service
    approval = await service._on_request_approval(
        ToolingRequestApprovalRequest(
            tool_name="mcp_secret_search",
            arguments={"query": "weather", "api_key": "raw-secret-value"},
            caller_principal_id="principal-a",
            caller_peer_id="peer-a",
            requested_by_principal_id="principal-a",
            correlation_id="corr-secret",
        )
    )
    assert approval.ok is True
    assert approval.approval_request_id is not None

    pending = await service._on_list_pending_approvals(ToolingListPendingApprovalsRequest())
    dumped = json.dumps(pending.model_dump(mode="json"), sort_keys=True)
    assert pending.count == 1
    assert "raw-secret-value" not in dumped
    assert "<redacted>" in dumped
    assert pending.approvals[0].display_args_preview["api_key"] == "<redacted>"

    await service._audit_tooling_event(
        "tooling.policy.test_secret_redaction",
        principal_id="principal-a",
        details={"token": "raw-audit-secret", "correlation_id": "corr-secret"},
    )
    audit = await service._on_list_policy_audit_events(ToolingListPolicyAuditEventsRequest())
    audit_dumped = json.dumps(audit.model_dump(mode="json"), sort_keys=True)
    assert "raw-audit-secret" not in audit_dumped
    assert "[redacted]" in audit_dumped
    assert any(event.event.startswith("tooling.") for event in audit.events)
    assert bus.request.await_count > 0


@pytest.mark.asyncio
async def test_onboarding_status_redacts_mcp_server_secrets(management_service):
    """Onboarding status redacts MCP headers and reports plugin/mesh capability rows."""

    service, _bus = management_service
    status = await service._on_get_onboarding_status(ToolingGetOnboardingStatusRequest())

    dumped = json.dumps(status.model_dump(mode="json"), sort_keys=True)
    assert "super-secret-token" not in dumped
    assert "[redacted]" in dumped
    assert {capability.source for capability in status.capabilities} == {
        "mcp",
        "plugin",
        "mesh_peer",
    }
    mcp = next(capability for capability in status.capabilities if capability.source == "mcp")
    assert mcp.configured_count == 1
    assert mcp.active_count == 1


@pytest.mark.asyncio
async def test_policy_mutation_contracts_persist_grants_and_require_bypass_confirmation(
    management_service,
):
    """Management mutations use typed contracts, audit, and durable grant records."""

    service, bus = management_service
    rejected = await service._on_set_policy_mode(
        ToolingSetPolicyModeRequest(
            policy_mode="unrestricted_except_blocked",
            actor_principal_id="admin",
            reason="dangerous test",
            correlation_id="corr-bypass-reject",
        )
    )
    assert rejected.ok is False
    assert rejected.error == "confirmation_required"

    dry_run_rejected = await service._on_set_policy_mode(
        ToolingSetPolicyModeRequest(
            policy_mode="dry_run_only",
            actor_principal_id="admin",
            reason="safe dry run",
            correlation_id="corr-dry-run",
        )
    )
    assert dry_run_rejected.ok is False
    assert dry_run_rejected.error == "confirmation_required"

    accepted = await service._on_set_policy_mode(
        ToolingSetPolicyModeRequest(
            policy_mode="dry_run_only",
            actor_principal_id="admin",
            reason="safe dry run",
            confirmation_text="DRY RUN ONLY",
            correlation_id="corr-dry-run",
        )
    )
    assert accepted.ok is True
    assert accepted.policy.policy_mode == "dry_run_only"

    source = await service._on_upsert_source_policy(
        ToolingUpsertSourcePolicyRequest(
            source_id="local:mcp:search",
            trust_tier="trusted",
            actor_principal_id="admin",
            reason="reviewed source",
            include_future_tools=False,
            provider_peer_id="local",
            provider_service_instance_id="mcp-search",
            correlation_id="corr-source-policy",
        )
    )
    assert source.ok is True
    assert source.grant.grant_type == "trust"
    assert source.grant.include_future_tools is False
    assert source.grant.metadata["source_id"] == "local:mcp:search"

    override = await service._on_upsert_tool_policy_override(
        ToolingUpsertToolPolicyOverrideRequest(
            local_tool_name="mcp_secret_search",
            trust_tier="blocked",
            actor_principal_id="admin",
            reason="block sensitive tool",
            expected_schema_hash="sha256:test",
            correlation_id="corr-tool-override",
        )
    )
    assert override.ok is True
    assert override.grant.grant_scope == "deny_always"
    assert override.grant.trust_tier == "blocked"
    assert override.grant.metadata["expected_schema_hash"] == "sha256:test"

    audit = await service._on_list_policy_audit_events(ToolingListPolicyAuditEventsRequest())
    assert {event.event for event in audit.events} >= {
        "tooling.policy.mode_set",
        "tooling.source_policy.upserted",
        "tooling.tool_policy_override.upserted",
    }
    assert bus.audit_events


@pytest.mark.asyncio
async def test_onboarding_mutation_contracts_are_redacted_and_explicitly_unsupported(
    management_service,
):
    """MCP/plugin onboarding contracts are UI-safe even before installers are implemented."""

    service, _bus = management_service
    mcp = await service._on_test_mcp_source(
        ToolingTestMCPSourceRequest(
            actor_principal_id="admin",
            source_id="mcp:secret",
            command="npx mcp-secret",
            env={"TOKEN": "raw-secret-token"},
            reason="test",
        )
    )
    dumped = json.dumps(mcp.model_dump(mode="json"), sort_keys=True)
    assert mcp.ok is False
    assert mcp.secrets_redacted is True
    assert "raw-secret-token" not in dumped

    created = await service._on_create_mcp_source(
        ToolingCreateMCPSourceRequest(
            actor_principal_id="admin",
            source_id="mcp:secret",
            command="npx mcp-secret",
            reason="test",
        )
    )
    assert created.created is False
    assert created.secrets_redacted is True

    plugin = await service._on_test_plugin_source(
        ToolingTestPluginSourceRequest(
            actor_principal_id="admin",
            source_id="plugin:sample",
            package="aurora-plugin-sample",
            reason="test",
        )
    )
    assert plugin.ok is False
    assert plugin.secrets_redacted is True

    plugin_created = await service._on_create_plugin_source(
        ToolingCreatePluginSourceRequest(
            actor_principal_id="admin",
            source_id="plugin:sample",
            package="aurora-plugin-sample",
            reason="test",
        )
    )
    assert plugin_created.created is False
    assert plugin_created.secrets_redacted is True
