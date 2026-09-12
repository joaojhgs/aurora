from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.tooling import ToolingResourceSelector
from app.shared.contracts.registry import IOModel


# Module identifier
class SchedulerModule:
    """Module identifier for Scheduler service."""

    NAME = "Scheduler"


# Method identifiers
class SchedulerMethods:
    """Full method identifiers for Scheduler service."""

    SCHEDULE = f"{SchedulerModule.NAME}.Schedule"
    SCHEDULE_ACTION = f"{SchedulerModule.NAME}.ScheduleAction"
    CANCEL = f"{SchedulerModule.NAME}.Cancel"
    PAUSE = f"{SchedulerModule.NAME}.Pause"
    RESUME = f"{SchedulerModule.NAME}.Resume"
    LIST_JOBS = f"{SchedulerModule.NAME}.ListJobs"  # List scheduled jobs
    JOB_FIRED = f"{SchedulerModule.NAME}.JobFired"
    JOB_COMPLETED = f"{SchedulerModule.NAME}.JobCompleted"
    HEALTH_CHECK = f"{SchedulerModule.NAME}.HealthCheck"


class SchedulerActionKind:
    """Typed scheduler action kind identifiers."""

    TOOLING_EXECUTE = "tooling.execute"
    TTS_SPEAK = "tts.speak"
    ORCHESTRATOR_USER_INPUT = "orchestrator.user_input"


class SchedulerToolBinding(IOModel):
    """Normalized Tooling provider/tool binding persisted with a scheduled job."""

    tool_name: str
    local_tool_name: str | None = None
    global_tool_id: str | None = None
    provider_peer_id: str | None = None
    provider_service_instance_id: str | None = None
    args_schema_hash: str | None = None
    catalog_generated_at: str | None = None


class SchedulerToolExecuteAction(IOModel):
    """Execute a Tooling tool through the Tooling bus contract."""

    kind: Literal["tooling.execute"] = SchedulerActionKind.TOOLING_EXECUTE
    binding: SchedulerToolBinding
    arguments: dict[str, Any] = Field(default_factory=dict)
    mesh_selector: MeshAddressSelector | None = None
    resource_selector: ToolingResourceSelector | None = None
    confirmed: bool = False
    approval_token: str | None = None
    policy_decision_id: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None
    correlation_id: str | None = None
    schedule_id: str | None = None
    scheduled_action_hash: str | None = None


class SchedulerTtsSpeakAction(IOModel):
    """Speak text through the TTS bus contract."""

    kind: Literal["tts.speak"] = SchedulerActionKind.TTS_SPEAK
    text: str
    interrupt: bool = False


class SchedulerOrchestratorUserInputAction(IOModel):
    """Send local user input to the Orchestrator bus contract."""

    kind: Literal["orchestrator.user_input"] = SchedulerActionKind.ORCHESTRATOR_USER_INPUT
    text: str
    source: str = "scheduler"


SchedulerActionSpec = Annotated[
    SchedulerToolExecuteAction | SchedulerTtsSpeakAction | SchedulerOrchestratorUserInputAction,
    Field(discriminator="kind"),
]


class SchedulerScheduleActionRequest(IOModel):
    """Typed request to schedule a bus action."""

    name: str
    schedule: str
    action_spec: SchedulerActionSpec
    enabled: bool = True
    timezone: str | None = None
    source: str | None = None
    privacy_class: str | None = None
    namespace: str | None = None
    owner_peer_id: str | None = None
    owner_principal_id: str | None = None
    target_selector: MeshAddressSelector | None = None
    delegated_permissions: list[str] = Field(default_factory=list)
    delegated_approval_token: str | None = None
    correlation_id: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None


class SchedulerScheduleActionResponse(IOModel):
    """Result of scheduling a typed bus action."""

    ok: bool
    job_id: str | None = None
    status: Literal["scheduled", "denied", "invalid", "failed"]
    reason: str | None = None
    prepared_tool: SchedulerToolBinding | None = None
    policy_decision_id: str | None = None
    correlation_id: str | None = None


class SchedulerScheduleJobRequest(IOModel):
    """Request to schedule a job."""

    name: str
    schedule: str  # Cron expression
    action: str
    enabled: bool = True
    timezone: str | None = None
    source: str | None = None
    privacy_class: str | None = None
    namespace: str | None = None
    owner_peer_id: str | None = None
    owner_principal_id: str | None = None
    target_selector: MeshAddressSelector | None = None
    delegated_permissions: list[str] = Field(default_factory=list)
    policy_decision_id: str | None = None
    delegated_approval_token: str | None = None
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
    namespace: str | None = None
    owner_peer_id: str | None = None
    owner_principal_id: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None


class SchedulerResumeJobRequest(IOModel):
    """Request to resume a paused job."""

    job_id: int | str
    namespace: str | None = None
    owner_peer_id: str | None = None
    owner_principal_id: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None


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


class SchedulerActionSupport(IOModel):
    """Capability state for one scheduler job action."""

    action: str
    supported: bool
    status: str = "supported"
    reason: str | None = None


class SchedulerActionResponse(IOModel):
    """Response for scheduler job management actions."""

    ok: bool
    status: str
    job_id: str
    action: str
    reason: str | None = None
    audit_event: str | None = None


class SchedulerJobInfo(IOModel):
    """Information about a scheduled job."""

    job_id: str
    name: str
    schedule: str
    action: str
    enabled: bool
    action_kind: str | None = None
    prepared_binding: SchedulerToolBinding | None = None
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
    delegated_approval_token_present: bool = False
    correlation_id: str | None = None
    blocked_reason: str | None = None
    timezone: str | None = None
    source: str = "scheduler"
    failure_count: int = 0
    privacy_class: str = "sensitive"
    last_error: str | None = None
    action_support: list[SchedulerActionSupport] = Field(default_factory=list)


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
    action_kind: str | None = None
    provider_peer_id: str | None = None
    provider_service_instance_id: str | None = None
    global_tool_id: str | None = None
    namespace: str = "local"
    owner_peer_id: str = "local"
    owner_principal_id: str = "system"
    target_peer_id: str | None = None
    delegated_permissions: list[str] = Field(default_factory=list)
    policy_decision_id: str | None = None
    delegated_approval_token_present: bool = False
    correlation_id: str | None = None


class SchedulerJobCompletedEvent(IOModel):
    """Event emitted when a scheduled job completes."""

    job_id: str
    job_name: str
    success: bool
    error: str | None = None
    action_kind: str | None = None
    provider_peer_id: str | None = None
    provider_service_instance_id: str | None = None
    global_tool_id: str | None = None
    result_summary: str | None = None
    namespace: str = "local"
    owner_peer_id: str = "local"
    owner_principal_id: str = "system"
    target_peer_id: str | None = None
    delegated_permissions: list[str] = Field(default_factory=list)
    policy_decision_id: str | None = None
    delegated_approval_token_present: bool = False
    correlation_id: str | None = None
