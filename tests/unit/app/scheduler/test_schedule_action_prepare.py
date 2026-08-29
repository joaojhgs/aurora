"""ScheduleAction prepare-time validation tests."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging import Envelope, QueryResult
from app.services.scheduler.service import SchedulerService
from app.shared.contracts.models.scheduler import (
    SchedulerMethods,
    SchedulerScheduleActionRequest,
    SchedulerToolBinding,
    SchedulerToolExecuteAction,
)
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.messaging.bus_init import set_bus


def make_service() -> SchedulerService:
    bus = AsyncMock()
    bus.request = AsyncMock()
    bus.publish = AsyncMock()
    set_bus(bus)
    service = SchedulerService()
    service.cron_service = MagicMock()
    service.cron_service.schedule_from_text = AsyncMock(return_value="job-1")
    return service


def prepare_response(**overrides):
    data = {
        "ok": True,
        "policy_decision": {
            "allowed": True,
            "share": True,
            "approval_required": False,
            "approval_mode": "approve_all_local_safe",
            "decision_id": "decision-1",
        },
        "args_hash": "args-hash",
        "resource_selector_hash": "resource-hash",
        "route_decision_id": "route-1",
        "correlation_id": "corr-1",
        "provider_peer_id": "local",
        "provider_service_instance_id": "local:Tooling",
        "global_tool_id": "local:local_Tooling:tool:switch_on",
        "local_tool_name": "switch_on",
        "args_schema_hash": "schema-hash-1",
    }
    data.update(overrides)
    return QueryResult(ok=True, data=data)


@pytest.mark.asyncio
async def test_schedule_action_prepares_and_persists_normalized_binding():
    service = make_service()
    service.bus.request = AsyncMock(return_value=prepare_response())

    response = await service.schedule_action(
        SchedulerScheduleActionRequest(
            name="turn on lamp",
            schedule="*/5 * * * *",
            enabled=False,
            action_spec=SchedulerToolExecuteAction(
                binding=SchedulerToolBinding(
                    tool_name="switch_on",
                    args_schema_hash="schema-hash-1",
                ),
                arguments={"target": "lamp"},
                correlation_id="corr-1",
            ),
            correlation_id="corr-1",
        )
    )

    assert response.ok is True
    assert response.prepared_tool.global_tool_id == "local:local_Tooling:tool:switch_on"
    assert response.prepared_tool.args_schema_hash == "schema-hash-1"
    prepare_call = next(
        call
        for call in service.bus.request.await_args_list
        if call.args[0] == ToolingMethods.PREPARE_EXECUTION
    )
    request = prepare_call.args[1]
    assert request.expected_args_schema_hash == "schema-hash-1"
    schedule_kwargs = service.cron_service.schedule_from_text.await_args.kwargs
    assert schedule_kwargs["callback"] == "__typed_action__.execute_action_spec"
    assert schedule_kwargs["action_kind"] == "tooling.execute"
    assert schedule_kwargs["action_spec"]["binding"]["args_schema_hash"] == "schema-hash-1"
    assert schedule_kwargs["is_active"] is False


@pytest.mark.asyncio
async def test_schedule_action_delegates_permissions_to_tooling_prepare_and_job_context():
    service = make_service()
    service.bus.request = AsyncMock(return_value=prepare_response())

    response = await service.schedule_action(
        SchedulerScheduleActionRequest(
            name="turn on restricted lamp",
            schedule="*/5 * * * *",
            delegated_permissions=["Device.Control"],
            action_spec=SchedulerToolExecuteAction(
                binding=SchedulerToolBinding(tool_name="switch_on"),
                arguments={"target": "lamp"},
            ),
        )
    )

    assert response.ok is True
    prepare_call = next(
        call
        for call in service.bus.request.await_args_list
        if call.args[0] == ToolingMethods.PREPARE_EXECUTION
    )
    prepare_request = prepare_call.args[1]
    assert prepare_request.caller_permissions == ["Device.Control"]
    schedule_kwargs = service.cron_service.schedule_from_text.await_args.kwargs
    context = schedule_kwargs["callback_args"]["scheduler_context"]
    assert context["delegated_permissions"] == ["Device.Control"]


@pytest.mark.asyncio
async def test_schedule_action_rejects_prepare_validation_failure_before_persist():
    service = make_service()
    service.bus.request = AsyncMock(
        return_value=prepare_response(
            ok=False,
            policy_decision={
                "allowed": False,
                "share": False,
                "approval_required": False,
                "approval_mode": "approve_all_local_safe",
                "decision_id": "decision-1",
                "reason": "missing_required_argument: target",
            },
            error="missing_required_argument: target",
        )
    )

    response = await service.schedule_action(
        SchedulerScheduleActionRequest(
            name="bad tool",
            schedule="*/5 * * * *",
            action_spec=SchedulerToolExecuteAction(
                binding=SchedulerToolBinding(tool_name="switch_on"),
                arguments={},
            ),
        )
    )

    assert response.ok is False
    assert response.status == "invalid"
    assert "missing_required_argument" in response.reason
    service.cron_service.schedule_from_text.assert_not_awaited()


@pytest.mark.asyncio
async def test_schedule_action_rejects_approval_required_without_durable_grant():
    service = make_service()
    service.bus.request = AsyncMock(
        side_effect=[
            prepare_response(
                policy_decision={
                    "allowed": True,
                    "share": True,
                    "approval_required": True,
                    "approval_mode": "ask_each_time",
                    "decision_id": "decision-1",
                }
            ),
            QueryResult(ok=True, data={"ok": False, "error": "approval_required"}),
        ]
    )

    response = await service.schedule_action(
        SchedulerScheduleActionRequest(
            name="needs approval",
            schedule="*/5 * * * *",
            action_spec=SchedulerToolExecuteAction(
                binding=SchedulerToolBinding(tool_name="switch_on"),
                arguments={"target": "lamp"},
            ),
        )
    )

    assert response.ok is False
    assert response.status == "invalid"
    assert response.reason == "approval-required scheduled tool action needs a durable grant"
    service.cron_service.schedule_from_text.assert_not_awaited()


@pytest.mark.asyncio
async def test_schedule_action_uses_envelope_identity_over_spoofed_payload():
    service = make_service()
    service.bus.request = AsyncMock(return_value=prepare_response())

    response = await service.schedule_action(
        SchedulerScheduleActionRequest(
            name="secure tool",
            schedule="*/5 * * * *",
            action_spec=SchedulerToolExecuteAction(
                binding=SchedulerToolBinding(tool_name="switch_on"),
                arguments={"target": "lamp"},
                caller_peer_id="spoof-peer",
                caller_principal_id="spoof-user",
            ),
            caller_peer_id="spoof-peer",
            caller_principal_id="spoof-user",
            correlation_id="payload-corr",
        ),
        envelope=Envelope(
            type=SchedulerMethods.SCHEDULE_ACTION,
            payload={},
            origin="external",
            identity_source="webrtc_rpc",
            principal_id="real-user",
            caller_peer_id="real-peer",
            correlation_id="env-corr",
        ),
    )

    assert response.ok is True
    prepare_call = next(
        call
        for call in service.bus.request.await_args_list
        if call.args[0] == ToolingMethods.PREPARE_EXECUTION
    )
    prepare_request = prepare_call.args[1]
    assert prepare_request.caller_peer_id == "real-peer"
    assert prepare_request.caller_principal_id == "real-user"
    assert prepare_request.caller_permissions == []
    schedule_kwargs = service.cron_service.schedule_from_text.await_args.kwargs
    context = schedule_kwargs["callback_args"]["scheduler_context"]
    assert context["owner_peer_id"] == "real-peer"
    assert context["owner_principal_id"] == "real-user"
    assert context["caller_peer_id"] == "real-peer"
    assert context["caller_principal_id"] == "real-user"
    assert schedule_kwargs["action_spec"]["caller_peer_id"] == "real-peer"
    assert schedule_kwargs["action_spec"]["caller_principal_id"] == "real-user"


@pytest.mark.asyncio
async def test_schedule_action_uses_envelope_permissions_over_spoofed_delegation():
    service = make_service()
    service.bus.request = AsyncMock(return_value=prepare_response())

    response = await service.schedule_action(
        SchedulerScheduleActionRequest(
            name="secure tool",
            schedule="*/5 * * * *",
            delegated_permissions=["*"],
            action_spec=SchedulerToolExecuteAction(
                binding=SchedulerToolBinding(tool_name="switch_on"),
                arguments={"target": "lamp"},
            ),
        ),
        envelope=Envelope(
            type=SchedulerMethods.SCHEDULE_ACTION,
            payload={},
            origin="external",
            identity_source="gateway_http",
            principal_id="real-user",
            caller_peer_id="real-peer",
            effective_perms=["Device.Control"],
        ),
    )

    assert response.ok is True
    prepare_call = next(
        call
        for call in service.bus.request.await_args_list
        if call.args[0] == ToolingMethods.PREPARE_EXECUTION
    )
    prepare_request = prepare_call.args[1]
    assert prepare_request.caller_permissions == ["Device.Control"]
    schedule_kwargs = service.cron_service.schedule_from_text.await_args.kwargs
    context = schedule_kwargs["callback_args"]["scheduler_context"]
    assert context["delegated_permissions"] == ["Device.Control"]


@pytest.mark.asyncio
async def test_schedule_action_denies_external_owner_spoofing():
    service = make_service()
    service.bus.request = AsyncMock(return_value=prepare_response())

    response = await service.schedule_action(
        SchedulerScheduleActionRequest(
            name="spoof owner",
            schedule="*/5 * * * *",
            owner_peer_id="victim-peer",
            owner_principal_id="victim-user",
            action_spec=SchedulerToolExecuteAction(
                binding=SchedulerToolBinding(tool_name="switch_on"),
                arguments={"target": "lamp"},
            ),
        ),
        envelope=Envelope(
            type=SchedulerMethods.SCHEDULE_ACTION,
            payload={},
            origin="external",
            identity_source="gateway_http",
            principal_id="real-user",
            correlation_id="env-corr",
        ),
    )

    assert response.ok is False
    assert response.status == "denied"
    assert response.reason == "owner_scope_mismatch"
    service.bus.request.assert_not_awaited()
    service.cron_service.schedule_from_text.assert_not_awaited()
