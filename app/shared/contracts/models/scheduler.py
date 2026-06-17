from __future__ import annotations

from pydantic import Field

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.registry import IOModel


# Module identifier
class SchedulerModule:
    """Module identifier for Scheduler service."""

    NAME = "Scheduler"


# Method identifiers
class SchedulerMethods:
    """Full method identifiers for Scheduler service."""

    SCHEDULE = f"{SchedulerModule.NAME}.Schedule"
    CANCEL = f"{SchedulerModule.NAME}.Cancel"
    PAUSE = f"{SchedulerModule.NAME}.Pause"
    RESUME = f"{SchedulerModule.NAME}.Resume"
    LIST_JOBS = f"{SchedulerModule.NAME}.ListJobs"  # List scheduled jobs
    JOB_FIRED = f"{SchedulerModule.NAME}.JobFired"
    JOB_COMPLETED = f"{SchedulerModule.NAME}.JobCompleted"
    HEALTH_CHECK = f"{SchedulerModule.NAME}.HealthCheck"


class SchedulerScheduleJobRequest(IOModel):
    """Request to schedule a job."""

    name: str
    schedule: str  # Cron expression
    action: str
    enabled: bool = True
    namespace: str | None = None
    owner_peer_id: str | None = None
    owner_principal_id: str | None = None
    target_selector: MeshAddressSelector | None = None
    delegated_permissions: list[str] = Field(default_factory=list)
    policy_decision_id: str | None = None
    correlation_id: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None


class SchedulerCancelJobRequest(IOModel):
    """Request to cancel a scheduled job."""

    job_id: int | str
    namespace: str | None = None
    owner_peer_id: str | None = None
    owner_principal_id: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None


class SchedulerPauseJobRequest(IOModel):
    """Request to pause a scheduled job."""

    job_id: int | str


class SchedulerResumeJobRequest(IOModel):
    """Request to resume a paused job."""

    job_id: int | str


class SchedulerListJobsRequest(IOModel):
    """Request to list scheduled jobs."""

    enabled_only: bool = False
    limit: int = 100
    offset: int = 0
    namespace: str | None = None
    owner_peer_id: str | None = None
    owner_principal_id: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None


class SchedulerJobInfo(IOModel):
    """Information about a scheduled job."""

    job_id: str
    name: str
    schedule: str
    action: str
    enabled: bool
    next_run: str | None = None
    last_run: str | None = None
    status: str | None = None  # "pending" | "running" | "completed" | "failed"
    namespace: str = "local"
    owner_peer_id: str = "local"
    owner_principal_id: str = "system"
    target_peer_id: str | None = None
    target_resource_namespace: str | None = None
    delegated_permissions: list[str] = Field(default_factory=list)
    policy_decision_id: str | None = None
    correlation_id: str | None = None


class SchedulerListJobsResponse(IOModel):
    """Response with list of scheduled jobs."""

    jobs: list[SchedulerJobInfo]
    total: int


class SchedulerJobFiredEvent(IOModel):
    """Event emitted when a scheduled job fires."""

    job_id: str
    job_name: str
    action: str
    scheduled_time: str
    namespace: str = "local"
    owner_peer_id: str = "local"
    owner_principal_id: str = "system"
    target_peer_id: str | None = None
    delegated_permissions: list[str] = Field(default_factory=list)
    policy_decision_id: str | None = None
    correlation_id: str | None = None


class SchedulerJobCompletedEvent(IOModel):
    """Event emitted when a scheduled job completes."""

    job_id: str
    job_name: str
    success: bool
    error: str | None = None
    namespace: str = "local"
    owner_peer_id: str = "local"
    owner_principal_id: str = "system"
    target_peer_id: str | None = None
    delegated_permissions: list[str] = Field(default_factory=list)
    policy_decision_id: str | None = None
    correlation_id: str | None = None
