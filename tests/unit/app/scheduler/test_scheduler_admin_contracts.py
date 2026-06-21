"""Scheduler admin contract and degraded-action tests."""

import json
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.scheduler.service import (
    PAUSE_RESUME_UNSUPPORTED_REASON,
    SchedulerService,
)
from app.shared.contracts.models.scheduler import (
    SchedulerActionResponse,
    SchedulerCancelJobRequest,
    SchedulerListJobsRequest,
    SchedulerListJobsResponse,
    SchedulerMethods,
    SchedulerPauseJobRequest,
    SchedulerResumeJobRequest,
    SchedulerScheduleJobRequest,
)
from app.shared.messaging.bus_init import set_bus
from app.shared.models.db import CronJob, JobStatus, ScheduleType


def make_service() -> SchedulerService:
    bus = AsyncMock()
    bus.request = AsyncMock()
    bus.publish = AsyncMock()
    set_bus(bus)
    service = SchedulerService()
    service.cron_service = MagicMock()
    return service


def make_job(job_id: str = "job-1", *, status: JobStatus = JobStatus.PENDING) -> CronJob:
    now = datetime.now()
    return CronJob(
        id=job_id,
        name="nightly report",
        schedule_type=ScheduleType.CRON,
        schedule_value="0 2 * * *",
        next_run_time=now + timedelta(hours=2),
        last_run_time=now - timedelta(days=1),
        last_run_result="previous failure" if status == JobStatus.FAILED else "ok",
        callback_module="app.services.scheduler.service",
        callback_function="fire_scheduled_job",
        callback_args={
            "action": "orchestrator:report",
            "scheduler_context": {
                "namespace": "ops",
                "owner_peer_id": "local",
                "owner_principal_id": "admin-1",
                "timezone": "UTC",
                "source": "admin-ui",
                "privacy_class": "private",
            },
        },
        status=status,
        retry_count=2,
        created_at=now - timedelta(days=2),
        updated_at=now,
    )


def test_scheduler_admin_method_contracts_are_explicit():
    assert SchedulerService.schedule_job._contract_metadata["required_perms"] == [
        SchedulerMethods.SCHEDULE
    ]
    assert SchedulerService.cancel_job._contract_metadata["required_perms"] == [
        SchedulerMethods.CANCEL
    ]
    assert SchedulerService.list_jobs._contract_metadata["required_perms"] == [
        SchedulerMethods.LIST_JOBS
    ]

    pause_contract = SchedulerService.pause_job._contract_metadata
    assert pause_contract["exposure"] == "both"
    assert pause_contract["method_type"] == "manage"
    assert pause_contract["required_perms"] == [SchedulerMethods.PAUSE]
    assert pause_contract["output_model"] is SchedulerActionResponse

    resume_contract = SchedulerService.resume_job._contract_metadata
    assert resume_contract["exposure"] == "both"
    assert resume_contract["method_type"] == "manage"
    assert resume_contract["required_perms"] == [SchedulerMethods.RESUME]
    assert resume_contract["output_model"] is SchedulerActionResponse


@pytest.mark.asyncio
async def test_list_jobs_includes_admin_metadata_and_degraded_action_support():
    service = make_service()
    service.cron_service.get_all_jobs = AsyncMock(return_value=[make_job(status=JobStatus.FAILED)])

    response = await service.list_jobs(SchedulerListJobsRequest(namespace="ops"))

    assert isinstance(response, SchedulerListJobsResponse)
    assert response.total == 1
    job = response.jobs[0]
    assert job.owner_principal_id == "admin-1"
    assert job.timezone == "UTC"
    assert job.source == "admin-ui"
    assert job.privacy_class == "private"
    assert job.failure_count == 2
    assert job.last_error == "previous failure"

    actions = {action.action: action for action in job.action_support}
    assert actions["cancel"].supported is True
    assert actions["pause"].supported is False
    assert actions["pause"].status == "unsupported"
    assert actions["pause"].reason == PAUSE_RESUME_UNSUPPORTED_REASON
    assert actions["resume"].supported is False
    assert actions["resume"].reason == PAUSE_RESUME_UNSUPPORTED_REASON


@pytest.mark.asyncio
async def test_pause_job_returns_unsupported_and_audits_without_mutating():
    service = make_service()
    service.cron_service.get_job = AsyncMock(return_value=make_job())
    service.cron_service.pause_job = AsyncMock(return_value=True)

    response = await service.pause_job(SchedulerPauseJobRequest(job_id="job-1"))

    assert response.ok is False
    assert response.status == "unsupported"
    assert response.reason == PAUSE_RESUME_UNSUPPORTED_REASON
    assert response.audit_event == "scheduler.pause.unsupported"
    service.cron_service.pause_job.assert_not_called()

    audit_request = service.bus.request.await_args.args[1]
    details = json.loads(audit_request.details)
    assert audit_request.event == "scheduler.pause.unsupported"
    assert details["reason"] == PAUSE_RESUME_UNSUPPORTED_REASON
    assert details["privacy_class"] == "private"


@pytest.mark.asyncio
async def test_resume_job_returns_unsupported_and_does_not_recreate_job():
    service = make_service()
    service.cron_service.get_job = AsyncMock(return_value=make_job())
    service.cron_service.cancel_job = AsyncMock(return_value=True)
    service.cron_service.schedule_from_text = AsyncMock(return_value="job-2")

    response = await service.resume_job(SchedulerResumeJobRequest(job_id="job-1"))

    assert response.ok is False
    assert response.status == "unsupported"
    assert response.reason == PAUSE_RESUME_UNSUPPORTED_REASON
    assert response.audit_event == "scheduler.resume.unsupported"
    service.cron_service.cancel_job.assert_not_called()
    service.cron_service.schedule_from_text.assert_not_called()

    audit_request = service.bus.request.await_args.args[1]
    assert audit_request.event == "scheduler.resume.unsupported"


@pytest.mark.asyncio
async def test_pause_denies_remote_scope_mismatch_before_unsupported_state():
    service = make_service()
    service.cron_service.get_job = AsyncMock(return_value=make_job())

    response = await service.pause_job(
        SchedulerPauseJobRequest(job_id="job-1", caller_peer_id="other-peer")
    )

    assert response.ok is False
    assert response.status == "denied"
    assert response.reason == "owner_scope_mismatch"
    assert response.audit_event == "scheduler.pause.denied"


def test_scheduler_manage_requests_accept_admin_context_fields():
    schedule = SchedulerScheduleJobRequest(
        name="job",
        schedule="0 2 * * *",
        action="orchestrator:report",
        timezone="UTC",
        source="admin-ui",
        privacy_class="private",
    )
    cancel = SchedulerCancelJobRequest(job_id="job-1", owner_principal_id="admin-1")
    pause = SchedulerPauseJobRequest(job_id="job-1", owner_principal_id="admin-1")
    resume = SchedulerResumeJobRequest(job_id="job-1", owner_principal_id="admin-1")

    assert schedule.timezone == "UTC"
    assert schedule.source == "admin-ui"
    assert schedule.privacy_class == "private"
    assert cancel.owner_principal_id == pause.owner_principal_id == resume.owner_principal_id
