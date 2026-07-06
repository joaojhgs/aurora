"""Contract verification for the source-first Tooling page read/write surface."""

from __future__ import annotations

from pydantic import SecretStr

from app.shared.contracts.models import tooling as tooling_models


def test_tooling_page_contract_methods_are_declared_with_typed_topic_constants():
    """Tooling page reads and mutations use typed ToolingMethods constants."""

    expected = {
        "GET_POLICY_SUMMARY": "Tooling.GetPolicySummary",
        "LIST_TOOL_SOURCES": "Tooling.ListToolSources",
        "GET_TOOL_SOURCE_DETAIL": "Tooling.GetToolSourceDetail",
        "SET_POLICY_MODE": "Tooling.SetPolicyMode",
        "UPSERT_SOURCE_POLICY": "Tooling.UpsertSourcePolicy",
        "UPSERT_TOOL_POLICY_OVERRIDE": "Tooling.UpsertToolPolicyOverride",
        "LIST_PENDING_APPROVALS": "Tooling.ListPendingApprovals",
        "LIST_POLICY_AUDIT_EVENTS": "Tooling.ListPolicyAuditEvents",
        "TEST_MCP_SOURCE": "Tooling.TestMCPSource",
        "CREATE_MCP_SOURCE": "Tooling.CreateMCPSource",
        "TEST_PLUGIN_SOURCE": "Tooling.TestPluginSource",
        "CREATE_PLUGIN_SOURCE": "Tooling.CreatePluginSource",
    }

    for attr, topic in expected.items():
        assert getattr(tooling_models.ToolingMethods, attr, None) == topic


def test_tooling_page_read_models_preserve_policy_source_mesh_and_grant_state():
    """Source-first UI models expose policy/grants/mesh staleness without frontend inference."""

    required_models = [
        "ToolingGetPolicySummaryResponse",
        "ToolingListToolSourcesResponse",
        "ToolingGetToolSourceDetailResponse",
        "ToolingSourceSummary",
        "ToolingToolPolicyOverride",
        "ToolingPendingApproval",
        "ToolingPolicyAuditEvent",
        "ToolingSchedulerDependency",
    ]
    for model_name in required_models:
        assert hasattr(tooling_models, model_name), f"missing {model_name}"

    source = tooling_models.ToolingSourceSummary(
        source_id="mesh:raspi-lab",
        source_type="mesh_peer",
        display_name="Raspberry Pi lab",
        trust_tier="untrusted",
        tool_count=3,
        blocked_count=1,
        new_child_count=1,
        stale_grant_count=2,
        catalog_cache_state="stale",
        catalog_epoch=42,
        catalog_hash="hash-redacted",
        last_announcement_at="2026-07-06T00:00:00Z",
        include_future_tools=False,
        secrets_redacted=True,
    )

    assert source.catalog_cache_state == "stale"
    assert source.include_future_tools is False
    assert source.stale_grant_count == 2
    assert source.secrets_redacted is True


def test_tooling_page_mutation_models_require_actor_reason_and_redacted_secrets():
    """Policy/source/onboarding mutations are auditable and do not stringify raw secrets."""

    required_models = [
        "ToolingSetPolicyModeRequest",
        "ToolingUpsertSourcePolicyRequest",
        "ToolingUpsertToolPolicyOverrideRequest",
        "ToolingTestMCPSourceRequest",
        "ToolingCreateMCPSourceRequest",
        "ToolingCreatePluginSourceRequest",
    ]
    for model_name in required_models:
        assert hasattr(tooling_models, model_name), f"missing {model_name}"

    draft = tooling_models.ToolingTestMCPSourceRequest(
        actor_principal_id="principal-admin",
        source_id="mcp:slack",
        transport="stdio",
        command="npx slack-mcp",
        env={"SLACK_TOKEN": SecretStr("sk-live-secret-token")},
        reason="validate source before onboarding",
    )

    serialized = draft.model_dump_json()
    assert "sk-live-secret-token" not in serialized
    assert "**********" in serialized or "[REDACTED]" in serialized
