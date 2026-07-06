"""Legacy scheduler callback repair tests."""

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.db.models import CronJob, JobStatus, ScheduleType
from app.services.scheduler.scheduler_manager import (
    LEGACY_TOOLING_MODULE_PREFIX,
    SchedulerManager,
)


def legacy_job(function: str, *, module: str = f"{LEGACY_TOOLING_MODULE_PREFIX}.scheduler_tool") -> CronJob:
    now = datetime.now()
    return CronJob(
        id=f"job-{function}",
        name=function,
        schedule_type=ScheduleType.ABSOLUTE,
        schedule_value=(now + timedelta(minutes=1)).isoformat(),
        next_run_time=now + timedelta(minutes=1),
        callback_module=module,
        callback_function=function,
        callback_args={"message": "drink water"},
        status=JobStatus.PENDING,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.asyncio
async def test_known_stale_tooling_callback_is_repaired_to_typed_action():
    manager = SchedulerManager()
    job = legacy_job("water_reminder")
    manager.db_service = MagicMock()
    manager.db_service.get_all_jobs = AsyncMock(return_value=[job])
    manager.db_service.update_job = AsyncMock(return_value=True)

    await manager._repair_legacy_tooling_callback_jobs()

    manager.db_service.update_job.assert_awaited_once_with(job)
    assert job.callback_module == "__typed_action__"
    assert job.callback_function == "execute_action_spec"
    assert job.action_kind == "tooling.execute"
    assert job.action_spec["binding"]["tool_name"] == "scheduler_water_reminder_tool"
    assert job.action_spec["arguments"] == {"message": "drink water"}


@pytest.mark.asyncio
async def test_known_stale_pomodoro_callback_is_repaired_to_transition_tool():
    manager = SchedulerManager()
    job = legacy_job("work_session_end", module=f"{LEGACY_TOOLING_MODULE_PREFIX}.pomodoro_tool")
    manager.db_service = MagicMock()
    manager.db_service.get_all_jobs = AsyncMock(return_value=[job])
    manager.db_service.update_job = AsyncMock(return_value=True)

    await manager._repair_legacy_tooling_callback_jobs()

    assert job.action_kind == "tooling.execute"
    assert job.action_spec["binding"]["tool_name"] == "pomodoro_transition_tool"
    assert job.action_spec["arguments"] == {"transition": "work_session_end"}


@pytest.mark.asyncio
async def test_unknown_stale_tooling_callback_is_quarantined():
    manager = SchedulerManager()
    job = legacy_job("unknown_fireback")
    manager.db_service = MagicMock()
    manager.db_service.get_all_jobs = AsyncMock(return_value=[job])
    manager.db_service.update_job = AsyncMock(return_value=True)

    await manager._repair_legacy_tooling_callback_jobs()

    assert job.is_active is False
    assert job.status == JobStatus.FAILED
    assert "quarantined" in (job.last_run_result or "")
    assert job.action_spec is None


@pytest.mark.asyncio
async def test_unknown_legacy_callback_is_rejected_without_importing():
    """Scheduler fire paths must not import arbitrary legacy callback strings."""

    manager = SchedulerManager()
    job = legacy_job(
        "dangerous_function",
        module="arbitrary.module.path",
    )

    result = await manager._call_job_callback(job)

    assert result == {
        "success": False,
        "error": "legacy_callback_unsupported: arbitrary.module.path.dangerous_function",
    }


@pytest.mark.asyncio
async def test_untyped_legacy_job_fails_closed_at_fire_time():
    """Untyped legacy rows are failed/deactivated instead of executed dynamically."""

    manager = SchedulerManager()
    manager.db_service = MagicMock()
    manager.db_service.update_job = AsyncMock(return_value=True)
    manager._publish_job_fired_event = AsyncMock()
    manager._publish_job_completed_event = AsyncMock()
    job = legacy_job(
        "dangerous_function",
        module="arbitrary.module.path",
    )
    job.max_retries = 0

    await manager._execute_job(job)

    assert job.status == JobStatus.FAILED
    assert job.is_active is False
    assert "legacy_callback_unsupported" in (job.last_run_result or "")
    manager._publish_job_completed_event.assert_awaited()
