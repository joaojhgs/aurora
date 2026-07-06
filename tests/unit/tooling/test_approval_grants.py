"""Unit tests for durable Tooling approval requests and grants."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import Envelope, QueryResult
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.db import DBMethods
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.tooling import (
    ToolingApprovalGrant,
    ToolingConfirmExecutionRequest,
    ToolingCreateApprovalGrantRequest,
    ToolingEvaluateApprovalGrantRequest,
    ToolingExecuteToolRequest,
    ToolingGetToolCatalogRequest,
    ToolingListApprovalGrantsRequest,
    ToolingMethods,
    ToolingPolicyDecision,
    ToolingPrepareExecutionResponse,
    ToolingRemoteCatalogAnnounced,
    ToolingRemoteCatalogDeltaAnnounced,
    ToolingRemoteCatalogRemoved,
    ToolingRequestApprovalRequest,
    ToolingResourceSelector,
    ToolingRevokeApprovalGrantRequest,
    ToolingToolInfo,
    ToolingToolProvenance,
)


def _approval_required_tool() -> Mock:
    """Return a local tool that requires approval but has no schema constraints."""

    tool = Mock()
    tool.name = "restart_sensitive_tool"
    tool.description = "Sensitive tool used by approval durability tests"
    tool.args_schema = {"type": "object", "properties": {}}
    tool.safety_class = "sensitive"
    tool.confirmation_required = True
    tool.required_permissions = []
    tool.operation_class = "read"
    tool.source = "core"
    tool.toolkit_name = "durability-tests"
    return tool


def _remote_tool_info(name: str, schema_hash_suffix: str = "v1") -> ToolingToolInfo:
    """Return a normalized remote mesh tool for catalog-staleness tests."""

    return ToolingToolInfo(
        name=f"raspi_lab_{name}",
        local_name=name,
        global_tool_id=f"raspi-lab:remote:raspi-lab:Tooling:tool:{name}:{schema_hash_suffix}",
        provider_peer_id="raspi-lab",
        provider_service_instance_id="remote:raspi-lab:Tooling",
        namespace="raspi_lab",
        display_name=f"raspi_lab.{name}",
        description=f"Remote {name} tool",
        args_schema={"type": "object", "properties": {}},
        schema={"type": "object", "properties": {}},
        source_type="mesh_peer",
        source="mesh_peer",
        trust_tier="untrusted",
        execution_location="remote",
        safety_class="standard",
        provenance=ToolingToolProvenance(
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            provider_kind="mesh_peer",
            source="unknown",
            advertised_name=name,
        ),
    )


def _local_prepared(*, source: str, global_tool_id: str, local_name: str) -> ToolingPrepareExecutionResponse:
    """Build a prepared local execution binding for source-scope grant tests."""

    return ToolingPrepareExecutionResponse(
        ok=True,
        policy_decision=ToolingPolicyDecision(
            allowed=True,
            share=True,
            approval_required=False,
            approval_mode="approve_all_local_safe",
            decision_id="decision-local",
        ),
        args_hash="args-local",
        resource_selector_hash="resource-local",
        route_decision_id="route-local",
        correlation_id="corr-local-prepared",
        provider_peer_id="local",
        provider_service_instance_id="local:Tooling",
        global_tool_id=global_tool_id,
        local_tool_name=local_name,
        args_schema_hash="schema-local",
        source=source,
        trust_tier="untrusted",
        capability_class="read",
        resource_scope=[],
        display_args_preview={},
        argument_visibility={},
        secrets_redacted=True,
    )


def _execute_request(**overrides) -> ToolingExecuteToolRequest:
    """Build the exact execution request shared by approval/grant tests."""

    values = {
        "tool_name": "restart_sensitive_tool",
        "arguments": {"target": "calendar"},
        "resource_selector": ToolingResourceSelector(
            resource_namespace="calendar", resource_id="primary"
        ),
        "correlation_id": "corr-durable-approval",
        "caller_peer_id": "peer-a",
        "caller_principal_id": "principal-a",
        "caller_device_id": "device-a",
    }
    values.update(overrides)
    return ToolingExecuteToolRequest(**values)


def _remote_prepared(tool: ToolingToolInfo) -> ToolingPrepareExecutionResponse:
    """Build a prepared remote execution binding for direct grant-match assertions."""

    return ToolingPrepareExecutionResponse(
        ok=True,
        policy_decision=ToolingPolicyDecision(
            allowed=True,
            share=True,
            approval_required=False,
            approval_mode="approve_all_for_peer",
            decision_id="decision-remote",
        ),
        args_hash="args-remote",
        resource_selector_hash="resource-remote",
        route_decision_id="route-remote",
        correlation_id="corr-remote-prepared",
        provider_peer_id=tool.provider_peer_id,
        provider_service_instance_id=tool.provider_service_instance_id,
        global_tool_id=tool.global_tool_id,
        local_tool_name=tool.local_name or tool.name,
        args_schema_hash="schema-remote",
        source="mesh_peer",
        trust_tier="untrusted",
        capability_class="read",
        resource_scope=[],
        display_args_preview={},
        argument_visibility={},
        secrets_redacted=True,
    )


class _SqliteToolingBus:
    """Small bus test double that persists DB.ExecuteSQL to one SQLite file."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.subscribe = Mock()
        self.publish = AsyncMock()
        self.request = AsyncMock(side_effect=self._request)
        self.audit_events: list[object] = []

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

        return QueryResult(ok=False, error=f"unexpected request topic: {topic}")


@pytest.fixture
def sqlite_tooling_bus(tmp_path: Path) -> _SqliteToolingBus:
    """Create an isolated persistent SQLite-backed bus double."""

    return _SqliteToolingBus(tmp_path / "tooling-approval.db")


@pytest.fixture
def make_tooling_service(sqlite_tooling_bus: _SqliteToolingBus):
    """Create fresh ToolingService instances sharing the same test DB/bus."""

    patchers = [
        patch("app.services.tooling.service.ToolsManager"),
        patch("app.services.tooling.service.set_tools_manager"),
        patch(
            "app.shared.services.base_service.get_bus_singleton",
            return_value=sqlite_tooling_bus,
        ),
    ]
    mock_tools_mgr = patchers[0].start()
    for patcher in patchers[1:]:
        patcher.start()

    def _make():
        from app.services.tooling.service import ToolingService

        manager = Mock()
        manager.initialize = AsyncMock()
        manager.get_stats = Mock(return_value={"total_tools": 1, "mcp_tools_loaded": False})
        manager.get_tools = Mock(return_value=[_approval_required_tool()])
        manager.get_tool_by_name = Mock(return_value=_approval_required_tool())
        manager.get_all_tool_names = Mock(return_value=["restart_sensitive_tool"])
        mock_tools_mgr.return_value = manager

        service = ToolingService()
        service.tools_manager = manager
        return service

    yield _make

    for patcher in reversed(patchers):
        patcher.stop()


@pytest.mark.asyncio
async def test_confirm_execution_loads_persisted_approval_request_after_restart(
    make_tooling_service,
):
    """Confirm execution loads an unused persisted approval request after restart."""

    service_before_restart = make_tooling_service()
    request = ToolingRequestApprovalRequest(**_execute_request().model_dump())

    approval = await service_before_restart._on_request_approval(request)

    assert approval.ok is True
    assert approval.approval_request_id is not None
    assert approval.policy_decision.approval_required is True

    service_after_restart = make_tooling_service()
    confirmation = await service_after_restart._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            grant_scope="once",
            correlation_id="corr-confirm",
        )
    )

    assert confirmation.ok is True
    assert confirmation.approval_token is not None


@pytest.mark.asyncio
async def test_confirm_execution_persists_used_mark_to_block_replay_after_restart(
    make_tooling_service,
):
    """Confirm execution persists the used flag so restart replay is rejected."""

    service_before_restart = make_tooling_service()
    approval = await service_before_restart._on_request_approval(
        ToolingRequestApprovalRequest(**_execute_request().model_dump())
    )
    assert approval.approval_request_id is not None

    service_after_restart = make_tooling_service()
    first_confirmation = await service_after_restart._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            grant_scope="once",
        )
    )
    assert first_confirmation.ok is True

    service_after_second_restart = make_tooling_service()
    replay = await service_after_second_restart._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            grant_scope="once",
        )
    )

    assert replay.ok is False
    assert replay.error == "approval_request_replayed"


@pytest.mark.asyncio
async def test_external_confirm_execution_uses_envelope_actor_for_grant_and_audit(
    make_tooling_service,
    sqlite_tooling_bus,
):
    """Gateway/mesh callers cannot spoof the approving principal in payload fields."""

    service = make_tooling_service()
    approval = await service._on_request_approval(
        ToolingRequestApprovalRequest(**_execute_request().model_dump())
    )
    assert approval.approval_request_id is not None

    confirmation = await service._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="spoof-admin",
            grant_scope="always",
            correlation_id="corr-confirm-external",
        ),
        envelope=Envelope(
            type=ToolingMethods.CONFIRM_EXECUTION,
            payload={},
            origin="external",
            identity_source="gateway_http",
            principal_id="real-admin",
        ),
    )

    assert confirmation.ok is True
    grants = await service._on_list_approval_grants(ToolingListApprovalGrantsRequest())
    assert grants.grants[0].created_by == "real-admin"
    assert any(
        event.event == "tooling.approval.approved" and event.principal_id == "real-admin"
        for event in sqlite_tooling_bus.audit_events
    )


@pytest.mark.asyncio
async def test_deny_always_confirmation_persists_blocking_grant(make_tooling_service):
    """Denying an inline approval with deny_always creates an enforced blocking grant."""

    service = make_tooling_service()
    execution_request = _execute_request(correlation_id="corr-deny-always")
    approval = await service._on_request_approval(
        ToolingRequestApprovalRequest(**execution_request.model_dump())
    )
    assert approval.approval_request_id is not None

    denial = await service._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            approve=False,
            grant_scope="deny_always",
            reason="operator denied permanently",
        )
    )
    blocked = await service._on_evaluate_approval_grant(
        ToolingEvaluateApprovalGrantRequest(**execution_request.model_dump())
    )

    assert denial.ok is False
    assert denial.error == "approval_denied"
    assert blocked.ok is False
    assert blocked.reason == "tool_blocked"
    assert blocked.grant is not None
    assert blocked.grant.grant_scope == "deny_always"


@pytest.mark.asyncio
async def test_deny_once_blocks_only_one_matching_execution(make_tooling_service):
    """Deny-once grants are consumed after blocking one exact future call."""

    service = make_tooling_service()
    execution_request = _execute_request(correlation_id="corr-deny-once")
    approval = await service._on_request_approval(
        ToolingRequestApprovalRequest(**execution_request.model_dump())
    )
    assert approval.approval_request_id is not None
    await service._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            approve=False,
            grant_scope="deny_once",
            reason="operator denied once",
        )
    )

    prepared = await service._on_prepare_execution(execution_request)
    first_block = await service._find_matching_blocking_grant(execution_request, prepared)
    assert first_block is not None
    await service._consume_deny_once_grant(
        first_block,
        principal_id=execution_request.caller_principal_id,
        correlation_id=execution_request.correlation_id,
    )
    second_block = await service._find_matching_blocking_grant(execution_request, prepared)

    assert second_block is None


async def _create_scheduled_execution_grant(service):
    """Create an exact scheduled-execution grant and return its binding details."""

    execution_request = _execute_request(correlation_id="corr-grant-evaluate").model_copy(
        update={"schedule_id": "schedule-123", "scheduled_action_hash": "action-hash-123"}
    )
    prepared = await service._on_prepare_execution(execution_request)
    assert prepared.ok is True
    assert prepared.policy_decision.approval_required is True

    create_response = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="scheduled_execution",
            grant_type="scheduled_execution",
            principal_id=execution_request.caller_principal_id,
            caller_device_id=execution_request.caller_device_id,
            caller_peer_id=execution_request.caller_peer_id,
            provider_peer_id=prepared.provider_peer_id,
            provider_service_instance_id=prepared.provider_service_instance_id,
            global_tool_id=prepared.global_tool_id,
            local_tool_name=prepared.local_tool_name,
            args_hash=prepared.args_hash,
            resource_selector_hash=prepared.resource_selector_hash,
            route_decision_id=prepared.route_decision_id,
            schedule_id="schedule-123",
            created_by="approver-a",
            expires_at=time.time() + 3600,
            reason="scheduler approval",
            metadata={"source": "unit-test", "scheduled_action_hash": "action-hash-123"},
            correlation_id="corr-create-grant",
        )
    )
    assert create_response.ok is True
    assert create_response.grant is not None
    return execution_request, prepared, create_response.grant.grant_id


@pytest.mark.asyncio
async def test_list_approval_grants_loads_created_grant_after_restart(make_tooling_service):
    """List approval grants loads a created grant from durable storage after restart."""

    service_before_restart = make_tooling_service()
    execution_request, prepared, grant_id = await _create_scheduled_execution_grant(
        service_before_restart
    )

    service_after_restart = make_tooling_service()
    list_response = await service_after_restart._on_list_approval_grants(
        ToolingListApprovalGrantsRequest(
            principal_id=execution_request.caller_principal_id,
            global_tool_id=prepared.global_tool_id,
        )
    )

    assert list_response.count == 1
    assert list_response.grants[0].grant_id == grant_id
    assert list_response.grants[0].grant_scope == "scheduled_execution"
    assert list_response.grants[0].metadata == {
        "source": "unit-test",
        "scheduled_action_hash": "action-hash-123",
    }


@pytest.mark.asyncio
async def test_external_grant_manage_endpoints_use_envelope_actor(
    make_tooling_service,
    sqlite_tooling_bus,
):
    """External grant creation/revocation use authenticated actor, not spoofed payload."""

    service = make_tooling_service()
    create_response = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="trust",
            local_tool_name="restart_sensitive_tool",
            created_by="spoof-admin",
            reason="trust test",
        ),
        envelope=Envelope(
            type=ToolingMethods.CREATE_APPROVAL_GRANT,
            payload={},
            origin="external",
            identity_source="gateway_http",
            principal_id="real-admin",
        ),
    )

    assert create_response.ok is True
    assert create_response.grant is not None
    assert create_response.grant.created_by == "real-admin"

    revoke_response = await service._on_revoke_approval_grant(
        ToolingRevokeApprovalGrantRequest(
            grant_id=create_response.grant.grant_id,
            revoked_by="spoof-admin",
            reason="revoke test",
        ),
        envelope=Envelope(
            type=ToolingMethods.REVOKE_APPROVAL_GRANT,
            payload={},
            origin="external",
            identity_source="gateway_http",
            principal_id="real-revoker",
        ),
    )

    assert revoke_response.ok is True
    assert any(
        event.event == "tooling.approval.grant_revoked"
        and event.principal_id == "real-revoker"
        for event in sqlite_tooling_bus.audit_events
    )


@pytest.mark.asyncio
async def test_evaluate_approval_grant_accepts_matching_grant_after_restart(
    make_tooling_service,
):
    """Evaluate approval grant accepts an exact matching durable grant after restart."""

    service_before_restart = make_tooling_service()
    execution_request, _, grant_id = await _create_scheduled_execution_grant(service_before_restart)

    service_after_restart = make_tooling_service()
    evaluate_response = await service_after_restart._on_evaluate_approval_grant(
        ToolingEvaluateApprovalGrantRequest(**execution_request.model_dump())
    )

    assert evaluate_response.ok is True
    assert evaluate_response.grant is not None
    assert evaluate_response.grant.grant_id == grant_id


@pytest.mark.asyncio
async def test_evaluate_approval_grant_rejects_schedule_binding_mismatch(
    make_tooling_service,
):
    """Scheduled-execution grants are bound to the prepared schedule/action pair."""

    service_before_restart = make_tooling_service()
    execution_request, _, _ = await _create_scheduled_execution_grant(service_before_restart)

    service_after_restart = make_tooling_service()
    wrong_schedule = await service_after_restart._on_evaluate_approval_grant(
        ToolingEvaluateApprovalGrantRequest(
            **execution_request.model_copy(update={"schedule_id": "other-schedule"}).model_dump()
        )
    )
    wrong_action = await service_after_restart._on_evaluate_approval_grant(
        ToolingEvaluateApprovalGrantRequest(
            **execution_request.model_copy(
                update={"scheduled_action_hash": "other-action"}
            ).model_dump()
        )
    )

    assert wrong_schedule.ok is False
    assert wrong_schedule.reason == "approval_required"
    assert wrong_action.ok is False
    assert wrong_action.reason == "approval_required"


@pytest.mark.asyncio
async def test_revoke_approval_grant_blocks_matching_grant_after_restart(make_tooling_service):
    """Revoking an approval grant prevents it from authorizing after restart."""

    service_before_restart = make_tooling_service()
    execution_request, prepared, grant_id = await _create_scheduled_execution_grant(
        service_before_restart
    )

    revoke_response = await service_before_restart._on_revoke_approval_grant(
        ToolingRevokeApprovalGrantRequest(
            grant_id=grant_id,
            revoked_by="approver-a",
            reason="schedule deleted",
            correlation_id="corr-revoke-grant",
        )
    )
    assert revoke_response.ok is True

    service_after_restart = make_tooling_service()
    evaluate_after_revoke = await service_after_restart._on_evaluate_approval_grant(
        ToolingEvaluateApprovalGrantRequest(**execution_request.model_dump())
    )
    assert evaluate_after_revoke.ok is False
    assert evaluate_after_revoke.reason == "approval_required"

    include_revoked = await service_after_restart._on_list_approval_grants(
        ToolingListApprovalGrantsRequest(
            principal_id=execution_request.caller_principal_id,
            global_tool_id=prepared.global_tool_id,
            include_revoked=True,
        )
    )
    assert include_revoked.count == 1
    assert include_revoked.grants[0].active is False
    assert include_revoked.grants[0].revoked_at is not None
    assert include_revoked.grants[0].reason == "schedule deleted"


@pytest.mark.asyncio
async def test_list_approval_grants_expires_active_grants_and_audits(
    make_tooling_service, sqlite_tooling_bus
):
    """Listing grants cleans up expired active grants and exposes them only when requested."""

    service = make_tooling_service()
    execution_request = _execute_request(correlation_id="corr-expired-list")
    prepared = await service._on_prepare_execution(execution_request)

    create_response = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="until_expiry",
            principal_id=execution_request.caller_principal_id,
            provider_peer_id=prepared.provider_peer_id,
            global_tool_id=prepared.global_tool_id,
            local_tool_name=prepared.local_tool_name,
            args_hash=prepared.args_hash,
            resource_selector_hash=prepared.resource_selector_hash,
            route_decision_id=prepared.route_decision_id,
            created_by="approver-a",
            expires_at=time.time() - 1,
        )
    )
    assert create_response.ok is True

    active = await service._on_list_approval_grants(
        ToolingListApprovalGrantsRequest(
            principal_id=execution_request.caller_principal_id,
            global_tool_id=prepared.global_tool_id,
        )
    )
    include_revoked = await service._on_list_approval_grants(
        ToolingListApprovalGrantsRequest(
            principal_id=execution_request.caller_principal_id,
            global_tool_id=prepared.global_tool_id,
            include_revoked=True,
        )
    )

    assert active.count == 0
    assert include_revoked.count == 1
    assert include_revoked.grants[0].active is False
    assert include_revoked.grants[0].metadata["expired"] is True
    assert any(event.event == "tooling.approval.grant_expired" for event in sqlite_tooling_bus.audit_events)


@pytest.mark.asyncio
async def test_expired_grant_is_not_accepted_after_restart(make_tooling_service):
    """Expired durable grants do not authorize execution after restart."""

    service = make_tooling_service()
    execution_request = _execute_request(correlation_id="corr-expired-grant")
    prepared = await service._on_prepare_execution(execution_request)

    create_response = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="until_expiry",
            principal_id=execution_request.caller_principal_id,
            provider_peer_id=prepared.provider_peer_id,
            global_tool_id=prepared.global_tool_id,
            local_tool_name=prepared.local_tool_name,
            args_hash=prepared.args_hash,
            resource_selector_hash=prepared.resource_selector_hash,
            route_decision_id=prepared.route_decision_id,
            created_by="approver-a",
            expires_at=time.time() - 1,
        )
    )
    assert create_response.ok is True

    service_after_restart = make_tooling_service()
    evaluate_response = await service_after_restart._on_evaluate_approval_grant(
        ToolingEvaluateApprovalGrantRequest(**execution_request.model_dump())
    )

    assert evaluate_response.ok is False
    assert evaluate_response.reason == "approval_required"


@pytest.mark.asyncio
async def test_broad_grant_without_future_tools_only_matches_reviewed_catalog_snapshot(
    make_tooling_service,
):
    """Mass grants do not silently approve tools added after the reviewed snapshot."""

    service = make_tooling_service()
    existing_request = _execute_request(correlation_id="corr-existing-broad")
    existing_prepared = await service._on_prepare_execution(existing_request)

    create_response = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            principal_id=existing_request.caller_principal_id,
            caller_peer_id=existing_request.caller_peer_id,
            provider_peer_id=existing_prepared.provider_peer_id,
            provider_service_instance_id=existing_prepared.provider_service_instance_id,
            include_future_tools=False,
            created_by="approver-a",
            reason="trust currently reviewed local catalog",
        )
    )
    assert create_response.ok is True
    assert create_response.grant is not None
    assert create_response.grant.metadata["reviewed_global_tool_ids"] == [
        existing_prepared.global_tool_id
    ]

    existing_evaluation = await service._on_evaluate_approval_grant(
        ToolingEvaluateApprovalGrantRequest(**existing_request.model_dump())
    )
    assert existing_evaluation.ok is True

    service.tools_manager.get_all_tool_names = Mock(
        return_value=["restart_sensitive_tool", "future_sensitive_tool"]
    )
    service.tools_manager.get_tool_by_name = Mock(return_value=_approval_required_tool())
    future_request = _execute_request(
        tool_name="future_sensitive_tool",
        correlation_id="corr-future-broad",
    )
    future_evaluation = await service._on_evaluate_approval_grant(
        ToolingEvaluateApprovalGrantRequest(**future_request.model_dump())
    )
    assert future_evaluation.ok is False
    assert future_evaluation.reason == "approval_required"


@pytest.mark.asyncio
async def test_broad_grant_with_future_tools_matches_catalog_additions(make_tooling_service):
    """Explicit include_future_tools grants cover future catalog children."""

    service = make_tooling_service()
    service.tools_manager.get_all_tool_names = Mock(return_value=["restart_sensitive_tool"])
    service.tools_manager.get_tool_by_name = Mock(return_value=_approval_required_tool())
    existing_request = _execute_request(correlation_id="corr-existing-future-enabled")
    existing_prepared = await service._on_prepare_execution(existing_request)

    create_response = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            principal_id=existing_request.caller_principal_id,
            caller_peer_id=existing_request.caller_peer_id,
            provider_peer_id=existing_prepared.provider_peer_id,
            provider_service_instance_id=existing_prepared.provider_service_instance_id,
            include_future_tools=True,
            created_by="approver-a",
            reason="trust this provider including future tools",
        )
    )
    assert create_response.ok is True

    service.tools_manager.get_all_tool_names = Mock(
        return_value=["restart_sensitive_tool", "future_sensitive_tool"]
    )
    service.tools_manager.get_tool_by_name = Mock(return_value=_approval_required_tool())
    future_request = _execute_request(
        tool_name="future_sensitive_tool",
        correlation_id="corr-future-enabled",
    )
    future_evaluation = await service._on_evaluate_approval_grant(
        ToolingEvaluateApprovalGrantRequest(**future_request.model_dump())
    )

    assert future_evaluation.ok is True
    assert future_evaluation.grant is not None
    assert future_evaluation.grant.include_future_tools is True


@pytest.mark.asyncio
async def test_remote_catalog_change_marks_dependent_grants_needing_review(
    make_tooling_service,
):
    """Remote catalog re-announcement invalidates existing remote trust grants for review."""

    service = make_tooling_service()
    await service._persist_remote_catalog_snapshot(
        ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash-v1",
            tools=[_remote_tool_info("switch_light", "v1")],
        )
    )

    create_response = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="trust",
            principal_id="principal-a",
            caller_peer_id="peer-a",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            include_future_tools=True,
            created_by="approver-a",
            reason="trust remote provider after review",
        )
    )
    assert create_response.ok is True

    await service._persist_remote_catalog_snapshot(
        ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=2,
            generated_at="2026-07-05T00:01:00Z",
            full_schema_hash="hash-v2",
            tools=[_remote_tool_info("switch_light", "v2")],
        )
    )

    grants = await service._on_list_approval_grants(
        ToolingListApprovalGrantsRequest(
            principal_id="principal-a",
            provider_peer_id="raspi-lab",
        )
    )

    assert grants.count == 1
    assert grants.grants[0].metadata["needs_review"] is True
    assert grants.grants[0].metadata["stale_reason"] == "remote_catalog_schema_changed"


@pytest.mark.asyncio
async def test_remote_catalog_change_after_restart_marks_dependent_grants_stale(
    make_tooling_service,
):
    """Durable remote snapshot diffs still stale dependent grants after service restart."""

    before = make_tooling_service()
    await before._persist_remote_catalog_snapshot(
        ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash-v1",
            tools=[_remote_tool_info("switch_light", "v1")],
        )
    )
    created = await before._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="trust",
            principal_id="principal-a",
            caller_peer_id="peer-a",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            include_future_tools=True,
            created_by="approver-a",
        )
    )
    assert created.ok is True

    after = make_tooling_service()
    await after._persist_remote_catalog_snapshot(
        ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=2,
            generated_at="2026-07-05T00:01:00Z",
            full_schema_hash="hash-v2",
            tools=[_remote_tool_info("switch_light", "v2")],
        )
    )
    grants = await after._on_list_approval_grants(
        ToolingListApprovalGrantsRequest(principal_id="principal-a", provider_peer_id="raspi-lab")
    )

    assert grants.count == 1
    assert grants.grants[0].metadata["needs_review"] is True
    assert grants.grants[0].metadata["stale_reason"] == "remote_catalog_schema_changed"




@pytest.mark.asyncio
async def test_remote_catalog_removed_marks_dependent_grants_stale(make_tooling_service):
    """Remote catalog removal marks dependent grants stale and non-matching."""

    service = make_tooling_service()
    remote_tool = _remote_tool_info("switch_light", "v1")
    await service._persist_remote_catalog_snapshot(
        ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash-v1",
            tools=[remote_tool],
            shared_by_policy=True,
        )
    )
    created = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="trust",
            principal_id="principal-a",
            caller_peer_id="peer-a",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            include_future_tools=True,
            created_by="approver-a",
        )
    )
    assert created.ok is True

    await service._on_remote_catalog_removed(
        ToolingRemoteCatalogRemoved(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            reason="peer_disconnected",
        )
    )
    grants = await service._on_list_approval_grants(
        ToolingListApprovalGrantsRequest(principal_id="principal-a", provider_peer_id="raspi-lab")
    )
    prepared = _remote_prepared(remote_tool)
    matching = await service._find_matching_grant(
        _execute_request(
            tool_name=remote_tool.name,
            mesh_selector=MeshAddressSelector(peer_id="raspi-lab"),
            correlation_id="corr-removed-match",
        ),
        prepared,
    )

    assert grants.count == 1
    assert grants.grants[0].metadata["needs_review"] is True
    assert grants.grants[0].metadata["stale_reason"] == "remote_catalog_removed"
    assert matching is None


@pytest.mark.asyncio
async def test_remote_catalog_unshare_marks_grants_stale_and_denies_match(
    make_tooling_service,
):
    """Remote policy unsharing invalidates broad grants even when schema is unchanged."""

    service = make_tooling_service()
    remote_tool = _remote_tool_info("switch_light", "v1")
    await service._persist_remote_catalog_snapshot(
        ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash-v1",
            tools=[remote_tool],
            shared_by_policy=True,
        )
    )

    create_response = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="trust",
            principal_id="principal-a",
            caller_peer_id="peer-a",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            include_future_tools=True,
            created_by="approver-a",
            reason="trust remote provider after review",
        )
    )
    assert create_response.ok is True

    await service._persist_remote_catalog_snapshot(
        ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=2,
            generated_at="2026-07-05T00:01:00Z",
            full_schema_hash="hash-v1",
            tools=[remote_tool],
            shared_by_policy=False,
        )
    )

    grants = await service._on_list_approval_grants(
        ToolingListApprovalGrantsRequest(
            principal_id="principal-a",
            provider_peer_id="raspi-lab",
        )
    )
    assert grants.count == 1
    grant = grants.grants[0]
    assert grant.metadata["needs_review"] is True
    assert grant.metadata["stale_reason"] == "remote_catalog_unshared_by_policy"

    request = _execute_request(
        tool_name=remote_tool.global_tool_id,
        correlation_id="corr-remote-unshared",
    )
    prepared = _remote_prepared(remote_tool)
    assert service._grant_matches_prepared(grant, request, prepared) is False


@pytest.mark.asyncio
async def test_remote_catalog_delta_preserves_and_applies_shared_by_policy(
    make_tooling_service,
):
    """Delta updates must not accidentally re-share an unshared peer catalog."""

    service = make_tooling_service()
    remote_tool = _remote_tool_info("switch_light", "v1")
    await service._persist_remote_catalog_snapshot(
        ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash-v1",
            tools=[remote_tool],
            shared_by_policy=False,
        )
    )

    await service._on_remote_catalog_delta_announced(
        ToolingRemoteCatalogDeltaAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=2,
            generated_at="2026-07-05T00:01:00Z",
            upserted_tools=[_remote_tool_info("dim_light", "v1")],
            full_schema_hash="hash-v2",
        )
    )
    snapshot = service._remote_catalog_snapshots[("raspi-lab", "remote:raspi-lab:Tooling")][0]
    assert snapshot.shared_by_policy is False

    await service._on_remote_catalog_delta_announced(
        ToolingRemoteCatalogDeltaAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=3,
            generated_at="2026-07-05T00:02:00Z",
            full_schema_hash="hash-v3",
            shared_by_policy=True,
        )
    )
    snapshot = service._remote_catalog_snapshots[("raspi-lab", "remote:raspi-lab:Tooling")][0]
    assert snapshot.shared_by_policy is True


@pytest.mark.asyncio
async def test_remote_catalog_delta_after_restart_preserves_durable_unshared_policy(
    make_tooling_service,
):
    """A post-restart delta without policy metadata must not re-share a remote catalog."""

    before_restart = make_tooling_service()
    remote_tool = _remote_tool_info("switch_light", "v1")
    await before_restart._persist_remote_catalog_snapshot(
        ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash-v1",
            tools=[remote_tool],
            shared_by_policy=False,
        )
    )

    after_restart = make_tooling_service()
    await after_restart._on_remote_catalog_delta_announced(
        ToolingRemoteCatalogDeltaAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=2,
            generated_at="2026-07-05T00:01:00Z",
            upserted_tools=[_remote_tool_info("dim_light", "v1")],
            full_schema_hash="hash-v2",
        )
    )

    snapshot = after_restart._remote_catalog_snapshots[("raspi-lab", "remote:raspi-lab:Tooling")][0]
    assert snapshot.shared_by_policy is False


@pytest.mark.asyncio
async def test_negotiated_remote_catalog_cache_delta_removal_and_grant_staleness(
    make_tooling_service,
    sqlite_tooling_bus: _SqliteToolingBus,
):
    """One peer lifecycle uses negotiated cache only and stales grants on catalog drift/removal."""

    service = make_tooling_service()
    remote_switch = _remote_tool_info("switch_light", "v1")
    await service._on_remote_catalog_announced(
        ToolingRemoteCatalogAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=1,
            generated_at="2026-07-05T00:00:00Z",
            full_schema_hash="hash-v1",
            tools=[remote_switch],
            shared_by_policy=True,
        )
    )
    remote_switch = service._remote_catalog_snapshots[
        ("raspi-lab", "remote:raspi-lab:Tooling")
    ][0].tools[0]

    created = await service._on_create_approval_grant(
        ToolingCreateApprovalGrantRequest(
            grant_scope="always",
            grant_type="trust",
            principal_id="principal-a",
            caller_peer_id="peer-a",
            provider_peer_id="raspi-lab",
            provider_service_instance_id="remote:raspi-lab:Tooling",
            include_future_tools=False,
            created_by="approver-a",
            reason="trust reviewed raspi-lab catalog only",
        )
    )
    assert created.ok is True
    assert created.grant is not None
    assert created.grant.metadata["reviewed_global_tool_ids"] == [remote_switch.global_tool_id]

    sqlite_tooling_bus.request.reset_mock()
    catalog = await service._on_get_tool_catalog(ToolingGetToolCatalogRequest())
    requested_topics = [call.args[0] for call in sqlite_tooling_bus.request.call_args_list]
    assert all(topic in {DBMethods.EXECUTE_SQL, AuthMethods.STORE_AUDIT_EVENT} for topic in requested_topics)
    assert [tool.name for tool in catalog.tools if tool.provider_peer_id == "raspi-lab"] == [
        remote_switch.name
    ]
    assert catalog.providers[1].provider_peer_id == "raspi-lab"
    assert catalog.providers[1].cache_status == "hit"

    remote_dimmer = _remote_tool_info("dim_light", "v1")
    await service._on_remote_catalog_delta_announced(
        ToolingRemoteCatalogDeltaAnnounced(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            provider_id="raspi-lab",
            catalog_epoch=2,
            generated_at="2026-07-05T00:01:00Z",
            removed_global_tool_ids=[remote_switch.global_tool_id],
            upserted_tools=[remote_dimmer],
            full_schema_hash="hash-v2",
            shared_by_policy=True,
        )
    )

    changed_catalog = await service._on_get_tool_catalog(ToolingGetToolCatalogRequest())
    changed_remote_tool_infos = [
        tool for tool in changed_catalog.tools if tool.provider_peer_id == "raspi-lab"
    ]
    changed_remote_tools = [tool.local_name for tool in changed_remote_tool_infos]
    assert remote_switch.local_name not in changed_remote_tools
    assert remote_dimmer.local_name in changed_remote_tools
    remote_dimmer = changed_remote_tool_infos[0]
    grants = await service._on_list_approval_grants(
        ToolingListApprovalGrantsRequest(principal_id="principal-a", provider_peer_id="raspi-lab")
    )
    assert grants.count == 1
    assert grants.grants[0].metadata["needs_review"] is True
    assert grants.grants[0].metadata["stale_reason"] in {
        "remote_catalog_tool_removed",
        "remote_catalog_schema_changed",
    }

    matching_future_tool = await service._find_matching_grant(
        _execute_request(
            tool_name=remote_dimmer.name,
            mesh_selector=MeshAddressSelector(peer_id="raspi-lab"),
            correlation_id="corr-new-tool-defaults-untrusted",
        ),
        _remote_prepared(remote_dimmer),
    )
    assert matching_future_tool is None

    await service._on_remote_catalog_removed(
        ToolingRemoteCatalogRemoved(
            peer_id="raspi-lab",
            service_instance_id="remote:raspi-lab:Tooling",
            reason="peer_disconnected",
        )
    )
    removed_catalog = await service._on_get_tool_catalog(ToolingGetToolCatalogRequest())
    assert all(provider.provider_peer_id != "raspi-lab" for provider in removed_catalog.providers)
    assert all(tool.provider_peer_id != "raspi-lab" for tool in removed_catalog.tools)


@pytest.mark.asyncio
async def test_approval_token_is_marked_used_and_replay_is_rejected(make_tooling_service):
    """A one-shot approval token is marked used after validation and rejects replay."""

    service = make_tooling_service()
    execution_request = _execute_request(correlation_id="corr-token-replay")
    approval = await service._on_request_approval(
        ToolingRequestApprovalRequest(**execution_request.model_dump())
    )
    assert approval.approval_request_id is not None
    confirmation = await service._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            grant_scope="once",
        )
    )
    assert confirmation.approval_token is not None

    prepared = await service._on_prepare_execution(execution_request)
    token_request = execution_request.model_copy(
        update={"approval_token": confirmation.approval_token}
    )

    first_ok, first_error = await service._validate_approval_token(token_request, prepared=prepared)
    second_ok, second_error = await service._validate_approval_token(
        token_request, prepared=prepared
    )

    assert (first_ok, first_error) == (True, None)
    assert (second_ok, second_error) == (False, "approval_token_replayed")


@pytest.mark.asyncio
async def test_approval_token_rejects_changed_secret_argument_values(make_tooling_service):
    """Approval tokens bind raw secret argument values, not only redacted previews."""

    service = make_tooling_service()
    original_request = _execute_request(
        correlation_id="corr-token-secret-a",
        arguments={"target": "calendar", "api_key": "secret-a"},
    )
    changed_request = _execute_request(
        correlation_id="corr-token-secret-a",
        arguments={"target": "calendar", "api_key": "secret-b"},
    )
    assert service._arguments_fingerprint(
        original_request.arguments
    ) != service._arguments_fingerprint(changed_request.arguments)

    approval = await service._on_request_approval(
        ToolingRequestApprovalRequest(**original_request.model_dump())
    )
    assert approval.approval_request_id is not None
    confirmation = await service._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            grant_scope="once",
        )
    )
    assert confirmation.approval_token is not None

    prepared_changed = await service._on_prepare_execution(changed_request)
    ok, error = await service._validate_approval_token(
        changed_request.model_copy(update={"approval_token": confirmation.approval_token}),
        prepared=prepared_changed,
    )

    assert ok is False
    assert error == "approval_token_args_hash_mismatch"


@pytest.mark.asyncio
async def test_durable_grant_rejects_changed_secret_argument_values(make_tooling_service):
    """Durable grants cannot authorize a call with different secret arguments."""

    service = make_tooling_service()
    original_request = _execute_request(
        correlation_id="corr-grant-secret-a",
        arguments={"target": "calendar", "api_key": "secret-a"},
    )
    changed_request = _execute_request(
        correlation_id="corr-grant-secret-a",
        arguments={"target": "calendar", "api_key": "secret-b"},
    )
    approval = await service._on_request_approval(
        ToolingRequestApprovalRequest(**original_request.model_dump())
    )
    assert approval.approval_request_id is not None
    confirmation = await service._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            grant_scope="session",
        )
    )
    assert confirmation.ok is True

    prepared_changed = await service._on_prepare_execution(changed_request)
    grant = await service._find_matching_grant(changed_request, prepared_changed)

    assert grant is None


@pytest.mark.asyncio
async def test_durable_grant_rejects_different_caller_principal(make_tooling_service):
    """Durable assistant approvals are bound to the approving caller identity."""

    service = make_tooling_service()
    original_request = _execute_request(correlation_id="corr-grant-principal-a")
    approval = await service._on_request_approval(
        ToolingRequestApprovalRequest(**original_request.model_dump())
    )
    assert approval.approval_request_id is not None
    confirmation = await service._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            grant_scope="session",
        )
    )
    assert confirmation.ok is True

    other_caller_request = original_request.model_copy(
        update={"caller_principal_id": "principal-b"}
    )
    prepared_other = await service._on_prepare_execution(other_caller_request)
    grant = await service._find_matching_grant(other_caller_request, prepared_other)

    assert grant is None


@pytest.mark.asyncio
async def test_durable_confirmation_requires_owner_or_schedule_binding(make_tooling_service):
    """Durable grants are rejected when the original request would create a wildcard owner."""

    service = make_tooling_service()
    unowned_request = _execute_request(
        caller_principal_id=None,
        caller_peer_id=None,
        caller_device_id=None,
        correlation_id="corr-unowned-durable",
    )
    approval = await service._on_request_approval(
        ToolingRequestApprovalRequest(**unowned_request.model_dump())
    )
    assert approval.approval_request_id is not None

    confirmation = await service._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            grant_scope="session",
        )
    )

    assert confirmation.ok is False
    assert confirmation.error == "approval_owner_required_for_durable_grant"


@pytest.mark.asyncio
async def test_expired_approval_token_is_rejected(make_tooling_service):
    """An approval token whose expiry is in the past is rejected."""

    service = make_tooling_service()
    execution_request = _execute_request(correlation_id="corr-token-expiry")
    prepared = await service._on_prepare_execution(execution_request)
    token = "expired-token"
    claims = service._approval_token_claims(
        execution_request,
        prepared=prepared,
        approver_principal_id="approver-a",
    )
    claims["expires_at"] = time.time() - 1
    service._approval_tokens[token] = claims

    ok, error = await service._validate_approval_token(
        execution_request.model_copy(update={"approval_token": token}),
        prepared=prepared,
    )

    assert ok is False
    assert error == "approval_token_expired"


@pytest.mark.asyncio
async def test_approval_token_validation_survives_restart(make_tooling_service):
    """Approval tokens should validate after restart when backed by the durable token ledger."""

    service_before_restart = make_tooling_service()
    execution_request = _execute_request(correlation_id="corr-token-restart")
    approval = await service_before_restart._on_request_approval(
        ToolingRequestApprovalRequest(**execution_request.model_dump())
    )
    assert approval.approval_request_id is not None
    confirmation = await service_before_restart._on_confirm_execution(
        ToolingConfirmExecutionRequest(
            approval_request_id=approval.approval_request_id,
            approver_principal_id="approver-a",
            grant_scope="once",
        )
    )
    assert confirmation.approval_token is not None

    service_after_restart = make_tooling_service()
    prepared: ToolingPrepareExecutionResponse = await service_after_restart._on_prepare_execution(
        execution_request
    )
    ok, error = await service_after_restart._validate_approval_token(
        execution_request.model_copy(update={"approval_token": confirmation.approval_token}),
        prepared=prepared,
    )

    assert (ok, error) == (True, None)

def test_source_scoped_grant_does_not_authorize_other_local_sources(make_tooling_service):
    """Source trust metadata must be enforced during grant matching."""

    service = make_tooling_service()
    request = _execute_request(tool_name="core_weather", caller_principal_id="principal-a")
    prepared_core = _local_prepared(
        source="core",
        global_tool_id="local:local_Tooling:tool:core_weather",
        local_name="core_weather",
    )
    grant = ToolingApprovalGrant(
        grant_id="grant-mcp-source",
        grant_scope="always",
        grant_type="trust",
        active=True,
        principal_id="principal-a",
        trust_tier="trusted",
        include_future_tools=False,
        created_at=time.time(),
        metadata={
            "source_id": "local:mcp",
            "source_type": "mcp",
            "reviewed_global_tool_ids": [prepared_core.global_tool_id],
            "secrets_redacted": True,
        },
    )

    assert service._grant_matches_prepared(grant, request, prepared_core) is False

    grant.metadata["source_id"] = "local:core"
    grant.metadata["source_type"] = "core"
    assert service._grant_matches_prepared(grant, request, prepared_core) is True

