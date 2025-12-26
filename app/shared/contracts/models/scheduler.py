from __future__ import annotations

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
    JOB_FIRED = f"{SchedulerModule.NAME}.JobFired"
    JOB_COMPLETED = f"{SchedulerModule.NAME}.JobCompleted"
    HEALTH_CHECK = f"{SchedulerModule.NAME}.HealthCheck"


class SchedulerScheduleJobRequest(IOModel):
    """Request to schedule a job."""

    name: str
    schedule: str  # Cron expression
    action: str
    enabled: bool = True


class SchedulerCancelJobRequest(IOModel):
    """Request to cancel a scheduled job."""

    job_id: int | str


class SchedulerPauseJobRequest(IOModel):
    """Request to pause a scheduled job."""

    job_id: int | str


class SchedulerResumeJobRequest(IOModel):
    """Request to resume a paused job."""

    job_id: int | str


class SchedulerJobFiredEvent(IOModel):
    """Event emitted when a scheduled job fires."""

    job_id: str
    job_name: str
    action: str
    scheduled_time: str


class SchedulerJobCompletedEvent(IOModel):
    """Event emitted when a scheduled job completes."""

    job_id: str
    job_name: str
    success: bool
    error: str | None = None
