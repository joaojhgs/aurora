"""G012 shared Tooling export protocol contract characterization."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.shared.contracts.models.tooling import (
    TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
    ToolingClearToolExportOverrideRequest,
    ToolingExportDecision,
    ToolingExportPrerequisiteEvidence,
    ToolingExportPrerequisites,
    ToolingMethods,
    ToolingRemoteCatalogAnnounced,
    ToolingSetToolExportDefaultRequest,
)


def test_export_method_ids_are_distinct_from_legacy_sharing_policy() -> None:
    assert {
        ToolingMethods.GET_TOOL_EXPORT_POLICY,
        ToolingMethods.SET_TOOL_EXPORT_DEFAULT,
        ToolingMethods.UPSERT_TOOL_GROUP_EXPORT_POLICY,
        ToolingMethods.UPSERT_TOOL_EXPORT_OVERRIDE,
        ToolingMethods.CLEAR_TOOL_EXPORT_OVERRIDE,
        ToolingMethods.PREVIEW_TOOL_EXPORT_DECISION,
    } == {
        "Tooling.GetToolExportPolicy",
        "Tooling.SetToolExportDefault",
        "Tooling.UpsertToolGroupExportPolicy",
        "Tooling.UpsertToolExportOverride",
        "Tooling.ClearToolExportOverride",
        "Tooling.PreviewToolExportDecision",
    }
    assert ToolingMethods.GET_SHARING_POLICY not in {
        ToolingMethods.GET_TOOL_EXPORT_POLICY,
        ToolingMethods.SET_TOOL_EXPORT_DEFAULT,
    }


def test_mutation_contract_requires_optimistic_revision_and_nonblank_reason() -> None:
    request = ToolingSetToolExportDefaultRequest(
        state="unshared",
        expected_revision=3,
        actor_principal_id="admin",
        reason="Disable default export",
        confirmation_text=TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
    )
    assert request.expected_revision == 3
    with pytest.raises(ValidationError):
        request.model_copy(update={"reason": " "}).__class__.model_validate(
            {**request.model_dump(), "reason": " "}
        )


def test_clear_restores_inheritance_without_accepting_a_state() -> None:
    request = ToolingClearToolExportOverrideRequest(
        scope_type="tool",
        scope_id="aurora-tool:v1:peer:Tooling:core.scheduler.list",
        expected_revision=4,
        actor_principal_id="admin",
        reason="Restore inherited policy",
        confirmation_text=TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
    )
    assert "state" not in request.model_dump()


def test_preview_decision_carries_inactive_g012_enforcement_and_protocol_evidence() -> None:
    decision = ToolingExportDecision(
        effective_state="unshared",
        inherited_from="global_group",
        global_tool_id="aurora-tool:v1:peer:Tooling:core.scheduler.list",
        share_group_id="core:scheduler",
        exportable=True,
        prerequisites=ToolingExportPrerequisites(
            local_exportable=True,
            enforcement_active=False,
        ),
        policy_revision=7,
        reason_code="export_policy_unshared",
    )
    assert decision.prerequisites.enforcement_active is False
    assert decision.policy_revision == 7


def test_export_prerequisite_evidence_preserves_blocked_unknown_and_permission_detail() -> None:
    prerequisites = ToolingExportPrerequisites(
        local_exportable=True,
        provider_mesh_tooling_enabled=True,
        service_shared=False,
        peer_execute_rbac=None,
        evidence=[
            ToolingExportPrerequisiteEvidence(
                key="service_shared",
                state="blocked",
                source="mesh_policy",
                reason_code="tooling_service_not_shared",
            ),
            ToolingExportPrerequisiteEvidence(
                key="peer_execute_rbac",
                state="unknown",
                source="peer_authority",
                reason_code="peer_scope_required",
                required_permissions=[ToolingMethods.EXECUTE_TOOL],
            ),
        ],
    )

    restored = ToolingExportPrerequisites.model_validate(prerequisites.model_dump(mode="json"))
    assert restored.service_shared is False
    assert restored.peer_execute_rbac is None
    assert restored.evidence[0].state == "blocked"
    assert restored.evidence[1].required_permissions == [ToolingMethods.EXECUTE_TOOL]


def test_legacy_catalog_absence_classifies_as_unsupported_until_g013_negotiates() -> None:
    legacy = ToolingRemoteCatalogAnnounced(
        peer_id="peer-a",
        service_instance_id="instance-a",
        provider_id="peer-a",
        catalog_epoch=1,
        generated_at="2026-07-14T00:00:00Z",
        full_schema_hash="hash-a",
    )
    assert legacy.supported_protocol_tiers == ["legacy_unsupported"]
    assert legacy.selected_protocol_tier == "legacy_unsupported"
    assert legacy.export_policy_revision is None

    negotiated = legacy.model_copy(
        update={
            "supported_protocol_tiers": ["projection_v1", "projection_v1_delta"],
            "selected_protocol_tier": "projection_v1",
            "export_policy_revision": 8,
        }
    )
    assert negotiated.selected_protocol_tier == "projection_v1"
    assert negotiated.export_policy_revision == 8
