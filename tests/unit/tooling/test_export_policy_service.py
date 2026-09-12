"""G012 Tooling service export-policy boundary tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import Envelope, MessageBus, QueryResult
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.policy_store import MeshPolicySnapshot
from app.services.tooling.identity import canonical_tool_global_id, source_tool_identity, stamp_tool
from app.services.tooling.service import ToolingService
from app.shared.contracts.models.db import (
    DBGetToolingExportPolicySnapshotResponse,
    DBMutateToolingExportPolicyRequest,
    DBMutateToolingExportPolicyResponse,
    DBToolingExportRecipientScope,
)
from app.shared.contracts.models.tooling import (
    TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
    ToolingExportPolicy,
    ToolingGetToolExportPolicyRequest,
    ToolingMeshKillSwitches,
    ToolingMethods,
    ToolingPreviewToolExportDecisionRequest,
    ToolingSetToolExportDefaultRequest,
    ToolingSharingPolicy,
    ToolingSharingPolicyRule,
    ToolingUpsertToolExportOverrideRequest,
    ToolingUpsertToolGroupExportPolicyRequest,
)
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


class _Tool:
    name = "calendar_list"
    description = "List calendar events"
    args_schema = None
    required_permissions: list[str] = []
    confirmation_required = False
    source = "plugin"


@pytest.fixture
def export_service() -> tuple[ToolingService, _Tool, str]:
    bus = Mock(spec=MessageBus)
    bus.subscribe = Mock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock()
    tool = _Tool()
    identity = source_tool_identity(
        source_kind="plugin",
        stable_source_id="calendar-plugin",
        provider_tool_id="list",
        share_group_id="plugin:calendar",
        share_group_label="Calendar",
    )
    stamp_tool(tool, identity)
    with (
        patch("app.services.tooling.service.ToolsManager") as manager_type,
        patch("app.services.tooling.service.set_tools_manager"),
        patch("app.shared.services.base_service.get_bus_singleton", return_value=bus),
    ):
        manager = Mock()
        manager.get_tools = Mock(return_value=[tool])
        manager.get_tool_by_name = Mock(return_value=tool)
        manager_type.return_value = manager
        service = ToolingService()
        service.tools_manager = manager
    service._stable_peer_id = "local-stable-peer"
    global_tool_id = canonical_tool_global_id(service._stable_peer_id, identity.tool_contract_id)
    return service, tool, global_tool_id


def _snapshot(*, initialized: bool = True, revision: int = 4):
    return DBGetToolingExportPolicySnapshotResponse(
        policy=ToolingExportPolicy(
            default_state="shared",
            revision=revision,
            initialized=initialized,
            migrated_from_legacy=initialized,
        ),
        rules=[],
        mesh_switches=ToolingMeshKillSwitches(),
    )


def _changed(revision: int = 5) -> DBMutateToolingExportPolicyResponse:
    return DBMutateToolingExportPolicyResponse(
        ok=True,
        policy=ToolingExportPolicy(
            default_state="unshared",
            revision=revision,
            initialized=True,
            migrated_from_legacy=True,
        ),
        changed=True,
        audit_id="toolexportaudit_test",
        previous_revision=revision - 1,
        revision=revision,
    )


def test_export_contracts_separate_reads_from_adminaction_writes() -> None:
    reads = (
        ToolingService._on_get_tool_export_policy,
        ToolingService._on_preview_tool_export_decision,
    )
    writes = (
        ToolingService._on_set_tool_export_default,
        ToolingService._on_upsert_tool_group_export_policy,
        ToolingService._on_upsert_tool_export_override,
        ToolingService._on_clear_tool_export_override,
    )
    for handler in reads:
        metadata = handler._contract_metadata
        assert metadata["method_type"] == "use"
        assert metadata["required_perms"] == ["Tooling.manage"]
        assert metadata["callable_feature_ids"] == ["export_policy_administration"]
    for handler in writes:
        metadata = handler._contract_metadata
        assert metadata["method_type"] == "manage"
        assert metadata["required_perms"] == ["Tooling.manage"]
        assert metadata["callable_feature_ids"] == ["export_policy_administration"]


@pytest.mark.asyncio
async def test_changed_export_mutation_invalidates_only_affected_peer_and_noop_is_silent(
    export_service,
) -> None:
    service, _tool, _global_tool_id = export_service
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot(revision=5))
    request = DBMutateToolingExportPolicyRequest(
        action="upsert_rule",
        expected_revision=4,
        state="unshared",
        peer_id="peer-a",
        scope_type="group",
        scope_id="plugin:calendar",
        actor_principal_id="admin",
        reason="limit one recipient",
    )
    bus = Mock(spec=MessageBus)
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data=_changed().model_dump()))
    bus.publish = AsyncMock()

    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        await service._mutate_tool_export_policy(request)

    invalidation = bus.publish.await_args.args[1]
    assert invalidation.reason_code == "export_policy_changed"
    assert invalidation.affected_peer_ids == ["peer-a"]

    bus.publish.reset_mock()
    unchanged = _changed().model_copy(update={"changed": False})
    bus.request.return_value = QueryResult(ok=True, data=unchanged.model_dump())
    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        await service._mutate_tool_export_policy(request)
    bus.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_preview_uses_stable_identity_group_and_g012_is_not_enforcing(
    export_service,
) -> None:
    service, _tool, global_tool_id = export_service
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot())

    response = await service._on_preview_tool_export_decision(
        ToolingPreviewToolExportDecisionRequest(
            global_tool_id=global_tool_id,
            share_group_id="spoofed:group",
            peer_id="peer-a",
        )
    )

    assert response.decision.global_tool_id == global_tool_id
    assert response.decision.share_group_id == "plugin:calendar"
    assert response.decision.effective_state == "shared"
    assert response.decision.prerequisites.enforcement_active is False


@pytest.mark.asyncio
async def test_named_peer_preview_reports_exact_mesh_and_rbac_prerequisites(
    export_service,
) -> None:
    service, tool, global_tool_id = export_service
    tool.required_permissions = ["Scheduler.ReadPrivate"]
    service._mesh_projection_enforcement_active = True
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot())
    service.bus.current_mesh_policy_snapshot = Mock(
        return_value=MeshPolicySnapshot(
            revision=3,
            source_revision=3,
            mesh_config=MeshConfig(
                enabled=True,
                services={
                    "Tooling": mesh_policy(
                        share=True,
                        unshared_method_ids=[ToolingMethods.PREPARE_EXECUTION],
                    )
                },
            ),
        )
    )
    service.bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data={
                "peer": {
                    "id": "peer-row-a",
                    "peer_id": "peer-a",
                    "outbound_status": "approved",
                    "outbound_permissions": [ToolingMethods.GET_TOOLS],
                }
            },
        )
    )

    response = await service._on_preview_tool_export_decision(
        ToolingPreviewToolExportDecisionRequest(
            global_tool_id=global_tool_id,
            peer_id="peer-a",
        )
    )
    prerequisites = response.decision.prerequisites

    assert prerequisites.provider_mesh_tooling_enabled is True
    assert prerequisites.consumer_mesh_tooling_enabled is True
    assert prerequisites.service_shared is True
    assert prerequisites.catalog_method_shared is True
    assert prerequisites.discovery_method_shared is True
    assert prerequisites.prepare_method_shared is False
    assert prerequisites.execute_method_shared is True
    assert prerequisites.peer_catalog_rbac is True
    assert prerequisites.peer_discovery_rbac is True
    assert prerequisites.peer_prepare_rbac is False
    assert prerequisites.peer_execute_rbac is False
    assert prerequisites.tool_required_permissions_granted is False
    assert prerequisites.local_exportable is True
    assert prerequisites.enforcement_active is True
    evidence = {item.key: item for item in prerequisites.evidence}
    assert evidence["prepare_method_shared"].reason_code == "tooling_method_not_shared"
    assert evidence["peer_execute_rbac"].required_permissions == [ToolingMethods.EXECUTE_TOOL]
    assert evidence["peer_execute_rbac"].state == "blocked"
    assert evidence["tool_required_permissions_granted"].required_permissions == [
        "Scheduler.ReadPrivate"
    ]
    assert evidence["consumer_mesh_tooling_enabled"].state == "not_applicable"


@pytest.mark.asyncio
async def test_preview_reports_provider_switch_and_missing_mesh_policy_fail_closed(
    export_service,
) -> None:
    service, _tool, global_tool_id = export_service
    snapshot = _snapshot().model_copy(
        update={
            "mesh_switches": ToolingMeshKillSwitches(
                provider_mesh_tooling_enabled=False,
                consumer_mesh_tooling_enabled=True,
                enforcement_active=True,
            )
        }
    )
    service._tool_export_snapshot = AsyncMock(return_value=snapshot)
    service.bus.current_mesh_policy_snapshot = Mock(side_effect=RuntimeError("unavailable"))
    service.bus.request = AsyncMock(side_effect=RuntimeError("auth unavailable"))

    response = await service._on_preview_tool_export_decision(
        ToolingPreviewToolExportDecisionRequest(
            global_tool_id=global_tool_id,
            peer_id="peer-a",
        )
    )
    prerequisites = response.decision.prerequisites
    evidence = {item.key: item for item in prerequisites.evidence}

    assert prerequisites.provider_mesh_tooling_enabled is False
    assert evidence["provider_mesh_tooling_enabled"].state == "blocked"
    assert evidence["provider_mesh_tooling_enabled"].reason_code == (
        "provider_mesh_tooling_disabled"
    )
    assert prerequisites.service_shared is None
    assert prerequisites.catalog_method_shared is None
    assert prerequisites.discovery_method_shared is None
    assert prerequisites.prepare_method_shared is None
    assert prerequisites.execute_method_shared is None
    assert evidence["service_shared"].reason_code == "mesh_policy_unavailable"
    assert prerequisites.peer_discovery_rbac is None
    assert prerequisites.tool_required_permissions_granted is None
    assert evidence["peer_discovery_rbac"].reason_code == "peer_authority_unavailable"


@pytest.mark.asyncio
async def test_preview_distinguishes_missing_or_denied_peer_from_unknown_authority(
    export_service,
) -> None:
    service, _tool, global_tool_id = export_service
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot())
    service.bus.current_mesh_policy_snapshot = Mock(
        return_value=MeshPolicySnapshot(
            revision=1,
            source_revision=1,
            mesh_config=MeshConfig(
                enabled=True,
                services={"Tooling": mesh_policy(share=True)},
            ),
        )
    )
    service.bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"peer": None}))

    missing = await service._on_preview_tool_export_decision(
        ToolingPreviewToolExportDecisionRequest(
            global_tool_id=global_tool_id,
            peer_id="missing-peer",
        )
    )
    missing_evidence = {item.key: item for item in missing.decision.prerequisites.evidence}
    assert missing.decision.prerequisites.peer_execute_rbac is False
    assert missing.decision.prerequisites.tool_required_permissions_granted is False
    assert missing_evidence["peer_execute_rbac"].reason_code == "peer_not_approved"

    service.bus.request.return_value = QueryResult(
        ok=True,
        data={
            "peer": {
                "id": "peer-row-a",
                "peer_id": "peer-a",
                "outbound_status": "denied",
                "outbound_permissions": ["*"],
            }
        },
    )
    denied = await service._on_preview_tool_export_decision(
        ToolingPreviewToolExportDecisionRequest(
            global_tool_id=global_tool_id,
            peer_id="peer-a",
        )
    )
    denied_evidence = {item.key: item for item in denied.decision.prerequisites.evidence}
    assert denied.decision.prerequisites.peer_discovery_rbac is False
    assert denied.decision.prerequisites.peer_execute_rbac is False
    assert denied_evidence["peer_discovery_rbac"].reason_code == "peer_not_approved"


@pytest.mark.asyncio
async def test_all_peers_preview_keeps_peer_specific_evidence_unknown(export_service) -> None:
    service, _tool, global_tool_id = export_service
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot())
    service.bus.current_mesh_policy_snapshot = Mock(
        return_value=MeshPolicySnapshot(
            revision=1,
            source_revision=1,
            mesh_config=MeshConfig(
                enabled=True,
                services={"Tooling": mesh_policy(share=True)},
            ),
        )
    )
    service.bus.request = AsyncMock()

    response = await service._on_preview_tool_export_decision(
        ToolingPreviewToolExportDecisionRequest(global_tool_id=global_tool_id)
    )
    prerequisites = response.decision.prerequisites

    assert prerequisites.service_shared is True
    assert prerequisites.peer_catalog_rbac is None
    assert prerequisites.peer_discovery_rbac is None
    assert prerequisites.peer_prepare_rbac is None
    assert prerequisites.peer_execute_rbac is None
    assert prerequisites.tool_required_permissions_granted is None
    evidence = {item.key: item for item in prerequisites.evidence}
    assert evidence["peer_catalog_rbac"].state == "unknown"
    assert evidence["peer_catalog_rbac"].reason_code == "peer_scope_required"
    service.bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_unknown_or_remote_tool_preview_fails_closed_without_metadata_disclosure(
    export_service,
) -> None:
    service, _tool, _global_tool_id = export_service
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot())
    service.bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data={
                "peer": {
                    "id": "peer-row-a",
                    "peer_id": "peer-a",
                    "outbound_status": "approved",
                    "outbound_permissions": ["*"],
                }
            },
        )
    )
    remote_id = "aurora-tool:v1:remote-peer:Tooling:private.secret"

    response = await service._on_preview_tool_export_decision(
        ToolingPreviewToolExportDecisionRequest(
            global_tool_id=remote_id,
            share_group_id="caller-supplied",
            peer_id="peer-a",
        )
    )

    assert response.decision.effective_state == "unshared"
    assert response.decision.reason_code == "tool_not_exportable"
    assert response.decision.exportable is False
    assert response.decision.prerequisites.local_exportable is False
    assert response.decision.prerequisites.tool_required_permissions_granted is False
    payload = response.model_dump(mode="json")
    assert "description" not in str(payload)
    assert "private.secret" in response.decision.global_tool_id


@pytest.mark.asyncio
async def test_export_management_reads_are_local_only(export_service) -> None:
    service, _tool, _global_tool_id = export_service
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot())
    request = ToolingGetToolExportPolicyRequest()

    with pytest.raises(PermissionError, match="local_management_only"):
        await service._on_get_tool_export_policy(
            request,
            Envelope(
                type=ToolingMethods.GET_TOOL_EXPORT_POLICY,
                payload={},
                origin="external",
                identity_source="webrtc_rpc",
                principal_id="peer-admin",
                caller_peer_id="peer-a",
            ),
        )

    response = await service._on_get_tool_export_policy(
        request,
        Envelope(
            type=ToolingMethods.GET_TOOL_EXPORT_POLICY,
            payload={},
            origin="external",
            identity_source="http_bearer",
            principal_id="local-admin",
        ),
    )
    assert response.policy.revision == 4

    local_system_response = await service._on_get_tool_export_policy(
        request,
        Envelope(
            type=ToolingMethods.GET_TOOL_EXPORT_POLICY,
            payload={},
            origin="external",
            identity_source="system",
            principal_id="system",
        ),
    )
    assert local_system_response.policy.revision == 4


@pytest.mark.asyncio
async def test_export_read_lists_stale_recipient_scopes_without_tool_membership(
    export_service,
) -> None:
    service, _tool, _global_tool_id = export_service
    snapshot = _snapshot().model_copy(
        update={
            "recipient_scopes": [
                DBToolingExportRecipientScope(
                    peer_id="peer-removed-stable",
                    rule_count=2,
                    last_rule_updated_at=42.0,
                ),
                DBToolingExportRecipientScope(
                    peer_id="peer-known-stable",
                    rule_count=1,
                    last_rule_updated_at=43.0,
                ),
            ]
        }
    )
    service._tool_export_snapshot = AsyncMock(return_value=snapshot)
    service._refresh_peer_display_names = AsyncMock()
    service._peer_display_names = {"peer-known-stable": "Kitchen Aurora"}
    service._peer_export_current_ids = {"peer-known-stable"}

    response = await service._on_get_tool_export_policy(ToolingGetToolExportPolicyRequest())

    assert [scope.model_dump() for scope in response.recipient_scopes] == [
        {
            "peer_id": "peer-removed-stable",
            "display_name": "Previously configured peer",
            "stale": True,
            "rule_count": 2,
            "last_rule_updated_at": 42.0,
        },
        {
            "peer_id": "peer-known-stable",
            "display_name": "Kitchen Aurora",
            "stale": False,
            "rule_count": 1,
            "last_rule_updated_at": 43.0,
        },
    ]
    payload = response.model_dump(mode="json")
    assert "tools" not in payload
    assert "scope_id" not in str(payload["recipient_scopes"])


@pytest.mark.asyncio
async def test_mesh_cannot_mutate_and_claimed_actor_cannot_spoof_export_audit(
    export_service,
) -> None:
    service, _tool, global_tool_id = export_service
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot())
    service._mutate_tool_export_policy = AsyncMock(return_value=_changed())
    request = ToolingUpsertToolExportOverrideRequest(
        state="unshared",
        expected_revision=4,
        actor_principal_id="admin-a",
        reason="Restrict calendar",
        confirmation_text=TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
        global_tool_id=global_tool_id,
        peer_id="peer-a",
    )

    denied_envelopes = [
        None,
        Envelope(
            type=ToolingMethods.UPSERT_TOOL_EXPORT_OVERRIDE,
            payload={},
            origin="external",
            identity_source="webrtc_rpc",
            principal_id="admin-a",
            caller_peer_id="peer-a",
        ),
        Envelope(
            type=ToolingMethods.UPSERT_TOOL_EXPORT_OVERRIDE,
            payload={},
            origin="external",
            identity_source="http_bearer",
            principal_id="admin-a",
        ),
        Envelope(
            type=ToolingMethods.UPSERT_TOOL_EXPORT_OVERRIDE,
            payload={},
            origin="internal",
            principal_id="admin-a",
        ),
    ]
    for denied_envelope in denied_envelopes:
        denied = await service._on_upsert_tool_export_override(request, denied_envelope)
        assert denied.ok is False and denied.error == "local_admin_action_required"

    authoritative = await service._on_upsert_tool_export_override(
        request,
        Envelope(
            type=ToolingMethods.UPSERT_TOOL_EXPORT_OVERRIDE,
            payload={},
            origin="external",
            identity_source="gateway_admin_action",
            principal_id="admin-b",
        ),
    )
    assert authoritative.ok is True
    mutation = service._mutate_tool_export_policy.await_args.args[0]
    assert mutation.actor_principal_id == "admin-b"
    assert mutation.actor_principal_id != request.actor_principal_id


@pytest.mark.asyncio
async def test_gateway_admin_actor_and_stable_tool_group_flow_to_typed_db(export_service) -> None:
    service, _tool, global_tool_id = export_service
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot())
    service._mutate_tool_export_policy = AsyncMock(return_value=_changed())
    envelope = Envelope(
        type=ToolingMethods.UPSERT_TOOL_EXPORT_OVERRIDE,
        payload={},
        origin="external",
        identity_source="gateway_admin_action",
        principal_id="admin-a",
    )

    tool_response = await service._on_upsert_tool_export_override(
        ToolingUpsertToolExportOverrideRequest(
            state="unshared",
            expected_revision=4,
            actor_principal_id="admin-a",
            reason="Restrict calendar",
            confirmation_text=TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
            global_tool_id=global_tool_id,
            peer_id="peer-a",
        ),
        envelope,
    )
    assert tool_response.ok is True
    assert tool_response.changed is True
    assert tool_response.audit_id == "toolexportaudit_test"
    tool_mutation = service._mutate_tool_export_policy.await_args.args[0]
    assert tool_mutation.scope_type == "tool"
    assert tool_mutation.scope_id == global_tool_id
    assert tool_mutation.actor_principal_id == "admin-a"

    service._mutate_tool_export_policy.reset_mock()
    group_response = await service._on_upsert_tool_group_export_policy(
        ToolingUpsertToolGroupExportPolicyRequest(
            state="shared",
            expected_revision=4,
            actor_principal_id="admin-a",
            reason="Share calendar",
            confirmation_text=TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
            share_group_id="plugin:calendar",
        ),
        envelope,
    )
    assert group_response.ok is True
    assert service._mutate_tool_export_policy.await_args.args[0].scope_type == "group"


@pytest.mark.asyncio
async def test_legacy_split_preserves_exact_denial_and_fails_dynamic_denial_closed(
    export_service,
) -> None:
    service, _tool, global_tool_id = export_service
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot(initialized=False, revision=0))
    service._mutate_tool_export_policy = AsyncMock(return_value=_changed(revision=1))
    service._sharing_policy = ToolingSharingPolicy(
        default_share=True,
        rules=[
            ToolingSharingPolicyRule(
                rule_id="exact-deny",
                share=False,
                global_tool_id=global_tool_id,
                caller_peer_id="peer-a",
            )
        ],
    )

    await service._migrate_legacy_tool_export_policy()
    exact = service._mutate_tool_export_policy.await_args.args[0]
    assert exact.action == "initialize_legacy"
    assert exact.state == "shared"
    assert [(seed.peer_id, seed.scope_id, seed.state) for seed in exact.initial_rules] == [
        ("peer-a", global_tool_id, "unshared")
    ]

    service._mutate_tool_export_policy.reset_mock()
    service._sharing_policy = ToolingSharingPolicy(
        default_share=True,
        rules=[
            ToolingSharingPolicyRule(
                rule_id="dynamic-deny",
                share=False,
                resource_namespace="calendar/private",
            )
        ],
    )
    await service._migrate_legacy_tool_export_policy()
    dynamic = service._mutate_tool_export_policy.await_args.args[0]
    assert dynamic.state == "unshared"
    assert dynamic.initial_rules == []


@pytest.mark.asyncio
async def test_legacy_split_compiles_exact_allow_and_first_match_order(export_service) -> None:
    service, _tool, global_tool_id = export_service
    service._tool_export_snapshot = AsyncMock(return_value=_snapshot(initialized=False, revision=0))
    service._mutate_tool_export_policy = AsyncMock(return_value=_changed(revision=1))
    service._sharing_policy = ToolingSharingPolicy(
        default_share=False,
        rules=[
            ToolingSharingPolicyRule(
                rule_id="peer-allow-first",
                share=True,
                global_tool_id=global_tool_id,
                caller_peer_id="peer-a",
            ),
            ToolingSharingPolicyRule(
                rule_id="global-deny-second",
                share=False,
                global_tool_id=global_tool_id,
            ),
            ToolingSharingPolicyRule(
                rule_id="duplicate-peer-deny-ignored",
                share=False,
                global_tool_id=global_tool_id,
                caller_peer_id="peer-a",
            ),
        ],
    )

    await service._migrate_legacy_tool_export_policy()

    compiled = service._mutate_tool_export_policy.await_args.args[0]
    assert compiled.state == "unshared"
    assert [(seed.peer_id, seed.scope_id, seed.state) for seed in compiled.initial_rules] == [
        ("peer-a", global_tool_id, "shared")
    ]


@pytest.mark.asyncio
async def test_export_mutation_does_not_change_legacy_execution_or_approval_state(
    export_service,
) -> None:
    service, tool, global_tool_id = export_service
    service._sharing_policy = ToolingSharingPolicy(
        default_share=True,
        rules=[
            ToolingSharingPolicyRule(
                rule_id="legacy-deny",
                share=False,
                global_tool_id=global_tool_id,
            )
        ],
    )
    service._approval_requests["pending"] = {"unchanged": True}
    before_policy = service._sharing_policy.model_dump(mode="json")
    before_approvals = dict(service._approval_requests)
    before = service._evaluate_sharing_policy(
        Mock(
            caller_peer_id="peer-a",
            caller_principal_id="user-a",
            caller_device_id=None,
            resource_selector=None,
            mesh_selector=None,
        ),
        tool=tool,
        local_tool_name=tool.name,
        global_tool_id=global_tool_id,
        provider_peer_id="local-stable-peer",
        service_instance_id="local:Tooling",
    )
    service._mutate_tool_export_policy = AsyncMock(return_value=_changed())

    response = await service._on_set_tool_export_default(
        ToolingSetToolExportDefaultRequest(
            state="unshared",
            expected_revision=4,
            actor_principal_id="system-admin",
            reason="Change export only",
            confirmation_text=TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
        ),
        Envelope(
            type=ToolingMethods.SET_TOOL_EXPORT_DEFAULT,
            payload={},
            origin="external",
            identity_source="gateway_admin_action",
            principal_id="system-admin",
        ),
    )
    after = service._evaluate_sharing_policy(
        Mock(
            caller_peer_id="peer-a",
            caller_principal_id="user-a",
            caller_device_id=None,
            resource_selector=None,
            mesh_selector=None,
        ),
        tool=tool,
        local_tool_name=tool.name,
        global_tool_id=global_tool_id,
        provider_peer_id="local-stable-peer",
        service_instance_id="local:Tooling",
    )

    assert response.ok is True
    assert before.share is False and before.allowed is False
    assert after.share is False and after.allowed is False
    assert service._sharing_policy.model_dump(mode="json") == before_policy
    assert service._approval_requests == before_approvals
