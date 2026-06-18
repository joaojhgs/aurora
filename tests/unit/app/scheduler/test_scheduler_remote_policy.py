"""Scheduler namespace and delegated-action policy tests."""

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.scheduler.service import SchedulerService
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.scheduler import (
    SchedulerCancelJobRequest,
    SchedulerListJobsRequest,
    SchedulerMethods,
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


def make_job(
    job_id: str,
    *,
    namespace: str,
    owner_peer_id: str,
    owner_principal_id: str = "principal-1",
) -> CronJob:
    now = datetime.now()
    return CronJob(
        id=job_id,
        name=f"job-{job_id}",
        schedule_type=ScheduleType.CRON,
        schedule_value="*/5 * * * *",
        next_run_time=now + timedelta(minutes=5),
        callback_module="app.services.scheduler.service",
        callback_function="fire_scheduled_job",
        callback_args={
            "action": "orchestrator:hello",
            "scheduler_context": {
                "namespace": namespace,
                "owner_peer_id": owner_peer_id,
                "owner_principal_id": owner_principal_id,
                "target_peer_id": "provider-peer",
                "target_resource_namespace": namespace,
                "delegated_permissions": ["Tooling.ExecuteTool"],
                "policy_decision_id": "policy-1",
                "correlation_id": "corr-1",
            },
        },
        status=JobStatus.PENDING,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.asyncio
async def test_schedule_job_stores_namespace_and_delegated_context():
    service = make_service()
    service.cron_service.schedule_from_text = AsyncMock(return_value="job-1")

    await service.schedule_job(
        SchedulerScheduleJobRequest(
            name="remote tool",
            schedule="*/5 * * * *",
            action="tooling:switch_on",
            namespace="lab",
            target_selector=MeshAddressSelector(peer_id="provider-peer", resource_namespace="lab"),
            delegated_permissions=["Tooling.ExecuteTool"],
            policy_decision_id="policy-1",
            correlation_id="corr-1",
            caller_peer_id="owner-peer",
            caller_principal_id="principal-1",
        )
    )

    callback_args = service.cron_service.schedule_from_text.call_args.kwargs["callback_args"]
    context = callback_args["scheduler_context"]

    assert context["namespace"] == "lab"
    assert context["owner_peer_id"] == "owner-peer"
    assert context["owner_principal_id"] == "principal-1"
    assert context["target_peer_id"] == "provider-peer"
    assert context["delegated_permissions"] == ["Tooling.ExecuteTool"]
    assert context["policy_decision_id"] == "policy-1"
    assert context["correlation_id"] == "corr-1"
    service.bus.request.assert_awaited()


@pytest.mark.asyncio
async def test_remote_list_jobs_is_filtered_to_caller_scope():
    service = make_service()
    service.cron_service.get_all_jobs = AsyncMock(
        return_value=[
            make_job("owned", namespace="lab", owner_peer_id="owner-peer"),
            make_job("other", namespace="lab", owner_peer_id="other-peer"),
            make_job("different-namespace", namespace="kitchen", owner_peer_id="owner-peer"),
        ]
    )

    response = await service.list_jobs(
        SchedulerListJobsRequest(
            namespace="lab",
            caller_peer_id="owner-peer",
            caller_principal_id="principal-1",
        )
    )

    assert response.total == 1
    assert [job.job_id for job in response.jobs] == ["owned"]
    assert response.jobs[0].namespace == "lab"
    assert response.jobs[0].owner_peer_id == "owner-peer"
    assert response.jobs[0].delegated_permissions == ["Tooling.ExecuteTool"]


@pytest.mark.asyncio
async def test_remote_cancel_denies_jobs_outside_owner_scope():
    service = make_service()
    service.cron_service.get_job = AsyncMock(
        return_value=make_job("job-1", namespace="lab", owner_peer_id="owner-peer")
    )
    service.cron_service.cancel_job = AsyncMock(return_value=True)

    await service.cancel_job(
        SchedulerCancelJobRequest(
            job_id="job-1",
            namespace="lab",
            caller_peer_id="other-peer",
            caller_principal_id="principal-1",
        )
    )

    service.cron_service.cancel_job.assert_not_awaited()
    audit_request = service.bus.request.call_args.args[1]
    assert audit_request.event == "scheduler.cancel.denied"
    assert "owner_scope_mismatch" in audit_request.details


@pytest.mark.asyncio
async def test_fire_job_emits_delegated_context_on_events():
    service = make_service()
    context = {
        "namespace": "lab",
        "owner_peer_id": "owner-peer",
        "owner_principal_id": "principal-1",
        "target_peer_id": "provider-peer",
        "target_resource_namespace": "lab",
        "delegated_permissions": ["Tooling.ExecuteTool"],
        "policy_decision_id": "policy-1",
        "correlation_id": "corr-1",
    }

    await service.fire_job(
        "job-1",
        "remote tool",
        "noop",
        scheduler_context=context,
    )

    fired_topic, fired_event = service.bus.publish.await_args_list[0].args[:2]
    completed_topic, completed_event = service.bus.publish.await_args_list[-1].args[:2]

    assert fired_topic == SchedulerMethods.JOB_FIRED
    assert fired_event.namespace == "lab"
    assert fired_event.owner_peer_id == "owner-peer"
    assert fired_event.target_peer_id == "provider-peer"
    assert fired_event.delegated_permissions == ["Tooling.ExecuteTool"]
    assert fired_event.policy_decision_id == "policy-1"
    assert completed_topic == SchedulerMethods.JOB_COMPLETED
    assert completed_event.delegated_permissions == ["Tooling.ExecuteTool"]
    assert completed_event.correlation_id == "corr-1"
