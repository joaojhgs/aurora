"""Typed scheduler fire-time execution tests."""

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.messaging import QueryResult
from app.services.db.models import CronJob, JobStatus, ScheduleType
from app.services.scheduler.scheduler_manager import SchedulerManager
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.scheduler import (
    SchedulerOrchestratorUserInputAction,
    SchedulerToolBinding,
    SchedulerToolExecuteAction,
    SchedulerTtsSpeakAction,
)
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.contracts.models.tts import TTSMethods


def typed_job(
    action: dict,
    *,
    job_id: str = "typed-job",
    scheduler_context: dict | None = None,
) -> CronJob:
    now = datetime.now()
    return CronJob(
        id=job_id,
        name=job_id,
        schedule_type=ScheduleType.ABSOLUTE,
        schedule_value=(now - timedelta(minutes=1)).isoformat(),
        next_run_time=now - timedelta(minutes=1),
        callback_module="__typed_action__",
        callback_function="execute_action_spec",
        callback_args={"scheduler_context": scheduler_context} if scheduler_context else {},
        action_kind=action["kind"],
        action_spec=action,
        status=JobStatus.PENDING,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.asyncio
async def test_typed_tool_fire_uses_tooling_bus_and_schema_hash():
    manager = SchedulerManager()
    manager.db_service = MagicMock()
    manager.db_service.update_job = AsyncMock(return_value=True)
    manager.bus = AsyncMock()
    manager.bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"ok": True}))
    action = SchedulerToolExecuteAction(
        binding=SchedulerToolBinding(
            tool_name="switch_on",
            local_tool_name="switch_on",
            args_schema_hash="schema-hash-1",
        ),
        arguments={"target": "lamp"},
        mesh_selector=MeshAddressSelector(peer_id="peer-1"),
    ).model_dump(mode="json")

    with patch.object(manager, "_call_job_callback", side_effect=AssertionError):
        await manager._execute_job(typed_job(action))

    topic, request = manager.bus.request.await_args.args[:2]
    assert topic == ToolingMethods.EXECUTE_TOOL
    assert request.tool_name == "switch_on"
    assert request.expected_args_schema_hash == "schema-hash-1"
    assert request.mesh_selector.peer_id == "peer-1"
    fired_event = manager.bus.publish.await_args_list[0].args[1]
    completed_event = manager.bus.publish.await_args_list[-1].args[1]
    assert fired_event.action_kind == "tooling.execute"
    assert completed_event.action_kind == "tooling.execute"
    assert completed_event.success is True


@pytest.mark.asyncio
async def test_typed_tool_fire_forwards_delegated_permissions_to_tooling():
    manager = SchedulerManager()
    manager.db_service = MagicMock()
    manager.db_service.update_job = AsyncMock(return_value=True)
    manager.bus = AsyncMock()
    manager.bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"ok": True}))
    action = SchedulerToolExecuteAction(
        binding=SchedulerToolBinding(tool_name="switch_on"),
        arguments={"target": "lamp"},
    ).model_dump(mode="json")

    await manager._execute_job(
        typed_job(action, scheduler_context={"delegated_permissions": ["Device.Control"]})
    )

    topic, request = manager.bus.request.await_args.args[:2]
    assert topic == ToolingMethods.EXECUTE_TOOL
    assert request.caller_permissions == ["Device.Control"]


@pytest.mark.asyncio
async def test_typed_tool_fire_policy_denial_marks_job_failed():
    manager = SchedulerManager()
    manager.db_service = MagicMock()
    manager.db_service.update_job = AsyncMock(return_value=True)
    manager.bus = AsyncMock()
    manager.bus.request = AsyncMock(return_value=QueryResult(ok=False, error="policy_denied"))
    action = SchedulerToolExecuteAction(
        binding=SchedulerToolBinding(tool_name="switch_on"),
        arguments={"target": "lamp"},
    ).model_dump(mode="json")
    job = typed_job(action)
    job.max_retries = 0

    await manager._execute_job(job)

    assert job.status == JobStatus.FAILED
    assert job.is_active is False
    assert "policy_denied" in (job.last_run_result or "")
    completed_event = manager.bus.publish.await_args_list[-1].args[1]
    assert completed_event.success is False
    assert completed_event.error == "policy_denied"


@pytest.mark.asyncio
async def test_typed_tool_fire_reports_expired_scheduled_execution_grant():
    """Fire-time Tooling grant denial is preserved for recurring scheduled approvals."""
    manager = SchedulerManager()
    manager.db_service = MagicMock()
    manager.db_service.update_job = AsyncMock(return_value=True)
    manager.bus = AsyncMock()
    manager.bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data={
                "ok": False,
                "status": "denied",
                "error_code": "approval_expired",
                "error": "scheduled execution grant expired",
            },
        )
    )
    action = SchedulerToolExecuteAction(
        binding=SchedulerToolBinding(tool_name="switch_on", local_tool_name="switch_on"),
        arguments={"target": "lamp"},
        schedule_id="schedule-1",
        scheduled_action_hash="hash-schedule-1",
    ).model_dump(mode="json")
    job = typed_job(action, job_id="schedule-1")
    job.max_retries = 0

    await manager._execute_job(job)

    topic, request = manager.bus.request.await_args.args[:2]
    assert topic == ToolingMethods.EXECUTE_TOOL
    assert request.schedule_id == "schedule-1"
    assert request.scheduled_action_hash == "hash-schedule-1"
    assert job.status == JobStatus.FAILED
    assert job.is_active is False
    assert job.last_run_result == "approval_expired"
    completed_event = manager.bus.publish.await_args_list[-1].args[1]
    assert completed_event.success is False
    assert completed_event.error == "approval_expired"


@pytest.mark.asyncio
async def test_typed_tts_and_orchestrator_actions_publish_bus_events():
    manager = SchedulerManager()
    manager.db_service = MagicMock()
    manager.db_service.update_job = AsyncMock(return_value=True)
    manager.bus = AsyncMock()
    manager.bus.publish = AsyncMock()

    await manager._execute_action_spec(
        typed_job(SchedulerTtsSpeakAction(text="hello", interrupt=True).model_dump(mode="json"))
    )
    assert manager.bus.publish.await_args_list[-1].args[0] == TTSMethods.REQUEST

    await manager._execute_action_spec(
        typed_job(
            SchedulerOrchestratorUserInputAction(text="hello").model_dump(mode="json"),
            job_id="orchestrator-job",
        )
    )
    assert manager.bus.publish.await_args_list[-1].args[0] == "Orchestrator.UserInput"
