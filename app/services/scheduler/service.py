"""Scheduler Service for Aurora's parallel architecture.

This service:
- Manages scheduled jobs and timers using CronService
- Processes scheduling commands
- Emits job fired events
- Handles cron job execution
"""

from __future__ import annotations

import json
from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import Envelope
from app.messaging.priority_helpers import get_system_priority
from app.services.scheduler.cron_service import get_cron_service
from app.shared.contracts.models.auth import AuthMethods, StoreAuditEventRequest
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.scheduler import (
    SchedulerActionResponse,
    SchedulerActionSupport,
    SchedulerCancelJobRequest,
    SchedulerJobCompletedEvent,
    SchedulerJobFiredEvent,
    SchedulerJobInfo,
    SchedulerListJobsRequest,
    SchedulerListJobsResponse,
    SchedulerMethods,
    SchedulerModule,
    SchedulerPauseJobRequest,
    SchedulerResumeJobRequest,
    SchedulerScheduleJobRequest,
)
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService

# Global scheduler service instance for callback access
_scheduler_service_instance: SchedulerService | None = None

DEFAULT_SCHEDULER_NAMESPACE = "local"
DEFAULT_SCHEDULER_OWNER_PEER = "local"
DEFAULT_SCHEDULER_OWNER_PRINCIPAL = "system"
DEFAULT_SCHEDULER_PRIVACY_CLASS = "sensitive"
PAUSE_RESUME_UNSUPPORTED_REASON = "scheduler_pause_resume_unsupported"
DELEGATED_APPROVAL_REQUIRED_REASON = "delegated_approval_token_required"
DELEGATED_ORCHESTRATOR_EXECUTION_UNSUPPORTED_REASON = (
    "delegated_orchestrator_execution_boundary_unsupported"
)


# Service implementation
class SchedulerService(BaseService):
    """Scheduler service.

    Responsibilities:
    - Manage scheduled jobs and timers
    - Execute jobs at scheduled times
    - Emit job lifecycle events
    - Handle scheduling commands
    """

    def __init__(self):
        """Initialize scheduler service with CronService."""
        global _scheduler_service_instance
        super().__init__(
            module=SchedulerModule.NAME,
            summary="Manages scheduled jobs and timers",
            capabilities=["cron_scheduling", "job_execution"],
        )
        # Pass bus to cron service so it can inject it into callbacks
        self.cron_service = get_cron_service(bus=self.bus)
        self._jobs: dict = {}
        # Store instance globally for callback access
        _scheduler_service_instance = self

    def _target_peer_id(self, selector: MeshAddressSelector | None) -> str | None:
        if selector is None:
            return None
        return selector.peer_id or selector.provider_id or selector.service_instance_id

    def _target_resource_namespace(self, selector: MeshAddressSelector | None) -> str | None:
        if selector is None:
            return None
        return selector.resource_namespace or selector.data_scope or selector.hardware_target

    def _selector_to_dict(self, selector: MeshAddressSelector | None) -> dict[str, Any] | None:
        if selector is None:
            return None
        if hasattr(selector, "model_dump"):
            return selector.model_dump(exclude_none=True)
        return selector.dict(exclude_none=True)

    def _is_remote_delegated_context(self, context: dict[str, Any]) -> bool:
        return bool(
            context.get("caller_peer_id")
            or context.get("target_peer_id")
            or context.get("owner_peer_id") != DEFAULT_SCHEDULER_OWNER_PEER
        )

    def _action_requires_delegated_approval(self, action: str, context: dict[str, Any]) -> bool:
        if not self._is_remote_delegated_context(context):
            return False

        normalized = action.strip().lower()
        return normalized.startswith(("tooling:", "tool:", "orchestrator:")) or normalized in {
            "tooling.executetool",
            "orchestrator.userinput",
            "orchestrator.externaluserinput",
        }

    def _delegated_approval_context_valid(
        self, action: str, context: dict[str, Any]
    ) -> tuple[bool, str | None]:
        if not self._action_requires_delegated_approval(action, context):
            return True, None
        if not context.get("policy_decision_id"):
            return False, "policy_decision_id_required"
        if not context.get("delegated_approval_token"):
            return False, DELEGATED_APPROVAL_REQUIRED_REASON
        return True, None

    def _scheduler_context_from_schedule(self, cmd: SchedulerScheduleJobRequest) -> dict[str, Any]:
        namespace = (
            cmd.namespace
            or self._target_resource_namespace(cmd.target_selector)
            or DEFAULT_SCHEDULER_NAMESPACE
        )
        owner_peer_id = cmd.owner_peer_id or cmd.caller_peer_id or DEFAULT_SCHEDULER_OWNER_PEER
        owner_principal_id = (
            cmd.owner_principal_id or cmd.caller_principal_id or DEFAULT_SCHEDULER_OWNER_PRINCIPAL
        )
        return {
            "namespace": namespace,
            "owner_peer_id": owner_peer_id,
            "owner_principal_id": owner_principal_id,
            "target_selector": self._selector_to_dict(cmd.target_selector),
            "target_peer_id": self._target_peer_id(cmd.target_selector),
            "target_resource_namespace": self._target_resource_namespace(cmd.target_selector),
            "delegated_permissions": list(cmd.delegated_permissions or []),
            "policy_decision_id": cmd.policy_decision_id,
            "delegated_approval_token": cmd.delegated_approval_token,
            "correlation_id": cmd.correlation_id,
            "caller_peer_id": cmd.caller_peer_id,
            "caller_principal_id": cmd.caller_principal_id,
            "timezone": cmd.timezone,
            "source": cmd.source or "scheduler",
            "privacy_class": cmd.privacy_class or DEFAULT_SCHEDULER_PRIVACY_CLASS,
            "blocked_reason": None,
        }

    def _request_scope(
        self,
        cmd: (
            SchedulerCancelJobRequest
            | SchedulerListJobsRequest
            | SchedulerPauseJobRequest
            | SchedulerResumeJobRequest
        ),
    ) -> dict[str, Any]:
        return {
            "namespace": cmd.namespace,
            "owner_peer_id": cmd.owner_peer_id or cmd.caller_peer_id,
            "owner_principal_id": cmd.owner_principal_id or cmd.caller_principal_id,
            "caller_peer_id": cmd.caller_peer_id,
            "caller_principal_id": cmd.caller_principal_id,
        }

    def _job_context(self, job: Any) -> dict[str, Any]:
        callback_args = getattr(job, "callback_args", None) or {}
        context = callback_args.get("scheduler_context") or {}
        return {
            "namespace": context.get("namespace", DEFAULT_SCHEDULER_NAMESPACE),
            "owner_peer_id": context.get("owner_peer_id", DEFAULT_SCHEDULER_OWNER_PEER),
            "owner_principal_id": context.get(
                "owner_principal_id", DEFAULT_SCHEDULER_OWNER_PRINCIPAL
            ),
            "target_selector": context.get("target_selector"),
            "target_peer_id": context.get("target_peer_id"),
            "target_resource_namespace": context.get("target_resource_namespace"),
            "delegated_permissions": context.get("delegated_permissions") or [],
            "policy_decision_id": context.get("policy_decision_id"),
            "delegated_approval_token": context.get("delegated_approval_token"),
            "correlation_id": context.get("correlation_id"),
            "caller_peer_id": context.get("caller_peer_id"),
            "caller_principal_id": context.get("caller_principal_id"),
            "timezone": context.get("timezone"),
            "source": context.get("source") or "scheduler",
            "privacy_class": context.get("privacy_class") or DEFAULT_SCHEDULER_PRIVACY_CLASS,
            "blocked_reason": context.get("blocked_reason"),
        }

    def _remote_scope_requested(self, scope: dict[str, Any]) -> bool:
        return bool(scope.get("caller_peer_id") or scope.get("caller_principal_id"))

    def _scope_allows_job(self, job_context: dict[str, Any], scope: dict[str, Any]) -> bool:
        if self._remote_scope_requested(scope):
            if (
                scope.get("caller_peer_id")
                and job_context["owner_peer_id"] != scope["caller_peer_id"]
            ):
                return False
            if (
                scope.get("caller_principal_id")
                and job_context["owner_principal_id"] != scope["caller_principal_id"]
            ):
                return False

        if scope.get("namespace") and job_context["namespace"] != scope["namespace"]:
            return False
        if scope.get("owner_peer_id") and job_context["owner_peer_id"] != scope["owner_peer_id"]:
            return False
        return not (
            scope.get("owner_principal_id")
            and job_context["owner_principal_id"] != scope["owner_principal_id"]
        )

    def _scope_allows_schedule(self, context: dict[str, Any]) -> bool:
        caller_peer_id = context.get("caller_peer_id")
        caller_principal_id = context.get("caller_principal_id")
        if caller_peer_id and context["owner_peer_id"] != caller_peer_id:
            return False
        return not (caller_principal_id and context["owner_principal_id"] != caller_principal_id)

    async def _audit_scheduler_event(
        self,
        event: str,
        context: dict[str, Any],
        *,
        status: str,
        job_id: str | None = None,
        reason: str | None = None,
    ) -> None:
        details = {
            "status": status,
            "job_id": job_id,
            "namespace": context.get("namespace"),
            "owner_peer_id": context.get("owner_peer_id"),
            "owner_principal_id": context.get("owner_principal_id"),
            "target_peer_id": context.get("target_peer_id"),
            "target_resource_namespace": context.get("target_resource_namespace"),
            "policy_decision_id": context.get("policy_decision_id"),
            "correlation_id": context.get("correlation_id"),
            "delegated_permissions": context.get("delegated_permissions") or [],
            "timezone": context.get("timezone"),
            "source": context.get("source"),
            "privacy_class": context.get("privacy_class") or DEFAULT_SCHEDULER_PRIVACY_CLASS,
            "delegated_approval_token_present": bool(context.get("delegated_approval_token")),
            "reason": reason,
        }
        try:
            await self.bus.request(
                AuthMethods.STORE_AUDIT_EVENT,
                StoreAuditEventRequest(
                    event=event,
                    principal_id=context.get("owner_principal_id"),
                    details=json.dumps(details, sort_keys=True),
                ),
                timeout=5.0,
            )
        except Exception as exc:
            log_warning(f"Failed to write scheduler audit event {event}: {exc}")

    def _action_support(self, job: Any) -> list[SchedulerActionSupport]:
        """Return UI-visible action capability states for a scheduler job."""
        actions = [SchedulerActionSupport(action="cancel", supported=True)]
        if getattr(job, "is_active", False):
            actions.extend(
                [
                    SchedulerActionSupport(
                        action="pause",
                        supported=False,
                        status="unsupported",
                        reason=PAUSE_RESUME_UNSUPPORTED_REASON,
                    ),
                    SchedulerActionSupport(
                        action="resume",
                        supported=False,
                        status="unsupported",
                        reason=PAUSE_RESUME_UNSUPPORTED_REASON,
                    ),
                ]
            )
        return actions

    async def on_start(self) -> None:
        """Start the scheduler service."""
        log_info("Starting Scheduler service...")

        # Initialize cron service (this will start the scheduler loop in the main event loop)
        await self.cron_service.initialize()

    async def on_stop(self) -> None:
        """Stop the scheduler service."""
        log_info("Stopping Scheduler service...")

        # Stop cron service
        await self.cron_service.shutdown()

        log_info("Scheduler service stopped")

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading Scheduler service configuration (section: {config_section})")

        # For scheduler service, most config changes don't require action
        # Schedule changes would require reloading jobs, but that's handled by commands
        # Just log the reload event
        log_debug(f"Scheduler service reloaded for section: {config_section}")

    @method_contract(
        method_id=SchedulerMethods.SCHEDULE,
        summary="Schedule a new job",
        input_model=SchedulerScheduleJobRequest,
        output_model=EmptyOutput,
        exposure="both",
        method_type="manage",
        required_perms=[SchedulerMethods.SCHEDULE],
    )
    async def schedule_job(self, cmd: SchedulerScheduleJobRequest) -> EmptyOutput:
        """Handle schedule job command."""
        try:
            scheduler_context = self._scheduler_context_from_schedule(cmd)
            if not self._scope_allows_schedule(scheduler_context):
                log_warning(f"Denied schedule for job '{cmd.name}' outside caller ownership scope")
                await self._audit_scheduler_event(
                    "scheduler.schedule.denied",
                    scheduler_context,
                    status="denied",
                    reason="owner_scope_mismatch",
                )
                return EmptyOutput()

            delegated_ok, delegated_reason = self._delegated_approval_context_valid(
                cmd.action,
                scheduler_context,
            )
            if not delegated_ok:
                scheduler_context["blocked_reason"] = delegated_reason
                log_warning(f"Denied delegated schedule for job '{cmd.name}': {delegated_reason}")
                await self._audit_scheduler_event(
                    "scheduler.schedule.denied",
                    scheduler_context,
                    status="denied",
                    reason=delegated_reason,
                )
                return EmptyOutput()

            log_info(
                f"Scheduling job: {cmd.name} ({cmd.schedule}) "
                f"namespace={scheduler_context['namespace']}"
            )

            # Schedule using CronService with a proper callback function
            # The callback will be called by scheduler_manager with job_id, job_name from callback_args
            job_id = await self.cron_service.schedule_from_text(
                text=cmd.schedule,
                callback="app.scheduler.service.fire_scheduled_job",  # Module.function string
                job_name=cmd.name,
                callback_args={
                    "job_name": cmd.name,
                    "action": cmd.action,
                    "scheduler_context": scheduler_context,
                },
            )

            if job_id:
                # Store job for tracking
                self._jobs[job_id] = cmd
                log_debug(f"Job '{cmd.name}' scheduled successfully with ID: {job_id}")
                await self._audit_scheduler_event(
                    "scheduler.schedule.created",
                    scheduler_context,
                    status="allowed",
                    job_id=str(job_id),
                )

                # Store in database via DBService
                from app.shared.contracts.models.db import DBMethods, DBStoreCronJobRequest

                await self.bus.publish(
                    DBMethods.SAVE_CRON_JOB,
                    DBStoreCronJobRequest(
                        name=cmd.name, schedule=cmd.schedule, action=cmd.action, enabled=cmd.enabled
                    ),
                    event=False,  # Command
                    origin="internal",
                )
            else:
                log_warning(f"Failed to schedule job '{cmd.name}'")
                await self._audit_scheduler_event(
                    "scheduler.schedule.denied",
                    scheduler_context,
                    status="failed",
                    reason="scheduler_create_failed",
                )

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error scheduling job: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=SchedulerMethods.CANCEL,
        summary="Cancel a scheduled job",
        input_model=SchedulerCancelJobRequest,
        output_model=EmptyOutput,
        exposure="both",
        method_type="manage",
        required_perms=[SchedulerMethods.CANCEL],
    )
    async def cancel_job(self, cmd: SchedulerCancelJobRequest) -> EmptyOutput:
        """Handle cancel job command."""
        try:
            log_info(f"Canceling job: {cmd.job_id}")

            # Cancel job via CronService
            job_id_str = str(cmd.job_id)
            job = await self.cron_service.get_job(job_id_str)
            context = self._job_context(job) if job else self._request_scope(cmd)
            scope = self._request_scope(cmd)
            if job and not self._scope_allows_job(context, scope):
                log_warning(f"Denied cancel for job {cmd.job_id} outside caller ownership scope")
                await self._audit_scheduler_event(
                    "scheduler.cancel.denied",
                    context,
                    status="denied",
                    job_id=job_id_str,
                    reason="owner_scope_mismatch",
                )
                return EmptyOutput()

            success = await self.cron_service.cancel_job(job_id_str)

            if success:
                # Remove from local tracking
                self._jobs.pop(job_id_str, None)
                log_debug(f"Job {cmd.job_id} canceled successfully")
                await self._audit_scheduler_event(
                    "scheduler.cancel.allowed",
                    context,
                    status="allowed",
                    job_id=job_id_str,
                )

                # Delete from database
                from app.shared.contracts.models.db import DBDeleteCronJobRequest, DBMethods

                await self.bus.publish(
                    DBMethods.DELETE_CRON_JOB,
                    DBDeleteCronJobRequest(job_id=str(cmd.job_id)),
                    event=False,
                    origin="internal",
                )  # Command
            else:
                log_warning(f"Failed to cancel job {cmd.job_id}")
                await self._audit_scheduler_event(
                    "scheduler.cancel.denied",
                    context,
                    status="failed",
                    job_id=job_id_str,
                    reason="job_not_found_or_cancel_failed",
                )

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error canceling job: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=SchedulerMethods.PAUSE,
        summary="Pause a scheduled job",
        input_model=SchedulerPauseJobRequest,
        output_model=SchedulerActionResponse,
        exposure="both",
        method_type="manage",
        required_perms=[SchedulerMethods.PAUSE],
    )
    async def pause_job(self, cmd: SchedulerPauseJobRequest) -> SchedulerActionResponse:
        """Return an audited unsupported response for pause semantics."""
        job_id_str = str(cmd.job_id)
        try:
            log_info(f"Pause requested for job: {cmd.job_id}")
            job = await self.cron_service.get_job(job_id_str)
            context = self._job_context(job) if job else self._request_scope(cmd)
            scope = self._request_scope(cmd)
            if job and not self._scope_allows_job(context, scope):
                await self._audit_scheduler_event(
                    "scheduler.pause.denied",
                    context,
                    status="denied",
                    job_id=job_id_str,
                    reason="owner_scope_mismatch",
                )
                return SchedulerActionResponse(
                    ok=False,
                    status="denied",
                    job_id=job_id_str,
                    action="pause",
                    reason="owner_scope_mismatch",
                    audit_event="scheduler.pause.denied",
                )

            reason = "job_not_found" if job is None else PAUSE_RESUME_UNSUPPORTED_REASON
            event = "scheduler.pause.denied" if job is None else "scheduler.pause.unsupported"
            await self._audit_scheduler_event(
                event,
                context,
                status="unsupported" if job else "denied",
                job_id=job_id_str,
                reason=reason,
            )
            return SchedulerActionResponse(
                ok=False,
                status="unsupported" if job else "not_found",
                job_id=job_id_str,
                action="pause",
                reason=reason,
                audit_event=event,
            )

        except Exception as e:
            log_error(f"Error pausing job: {e}", exc_info=True)
            return SchedulerActionResponse(
                ok=False,
                status="failed",
                job_id=job_id_str,
                action="pause",
                reason=str(e),
            )

    @method_contract(
        method_id=SchedulerMethods.RESUME,
        summary="Resume a paused job",
        input_model=SchedulerResumeJobRequest,
        output_model=SchedulerActionResponse,
        exposure="both",
        method_type="manage",
        required_perms=[SchedulerMethods.RESUME],
    )
    async def resume_job(self, cmd: SchedulerResumeJobRequest) -> SchedulerActionResponse:
        """Return an audited unsupported response for resume semantics."""
        job_id_str = str(cmd.job_id)
        try:
            log_info(f"Resume requested for job: {cmd.job_id}")
            job = await self.cron_service.get_job(job_id_str)
            context = self._job_context(job) if job else self._request_scope(cmd)
            scope = self._request_scope(cmd)
            if job and not self._scope_allows_job(context, scope):
                await self._audit_scheduler_event(
                    "scheduler.resume.denied",
                    context,
                    status="denied",
                    job_id=job_id_str,
                    reason="owner_scope_mismatch",
                )
                return SchedulerActionResponse(
                    ok=False,
                    status="denied",
                    job_id=job_id_str,
                    action="resume",
                    reason="owner_scope_mismatch",
                    audit_event="scheduler.resume.denied",
                )

            reason = "job_not_found" if job is None else PAUSE_RESUME_UNSUPPORTED_REASON
            event = "scheduler.resume.denied" if job is None else "scheduler.resume.unsupported"
            await self._audit_scheduler_event(
                event,
                context,
                status="unsupported" if job else "denied",
                job_id=job_id_str,
                reason=reason,
            )
            return SchedulerActionResponse(
                ok=False,
                status="unsupported" if job else "not_found",
                job_id=job_id_str,
                action="resume",
                reason=reason,
                audit_event=event,
            )

        except Exception as e:
            log_error(f"Error resuming job: {e}", exc_info=True)
            return SchedulerActionResponse(
                ok=False,
                status="failed",
                job_id=job_id_str,
                action="resume",
                reason=str(e),
            )

    @method_contract(
        method_id=SchedulerMethods.LIST_JOBS,
        summary="List scheduled jobs",
        input_model=SchedulerListJobsRequest,
        output_model=SchedulerListJobsResponse,
        exposure="both",
        method_type="use",
        required_perms=[SchedulerMethods.LIST_JOBS],
    )
    async def list_jobs(self, query: SchedulerListJobsRequest) -> SchedulerListJobsResponse:
        """List all scheduled jobs.

        Args:
            query: Request with optional filters (enabled_only, limit, offset)

        Returns:
            Response with list of scheduled jobs
        """
        try:
            log_debug(
                f"Listing scheduled jobs (enabled_only={query.enabled_only}, "
                f"limit={query.limit}, offset={query.offset})"
            )

            # Get jobs from cron service
            all_jobs = await self.cron_service.get_all_jobs()
            scope = self._request_scope(query)
            all_jobs = [
                job for job in all_jobs if self._scope_allows_job(self._job_context(job), scope)
            ]

            # Filter by enabled if requested
            if query.enabled_only:
                all_jobs = [j for j in all_jobs if j.is_active]

            # Apply offset and limit
            total = len(all_jobs)
            paginated_jobs = all_jobs[query.offset : query.offset + query.limit]

            # Convert CronJob objects to response format
            job_infos = []
            for job in paginated_jobs:
                context = self._job_context(job)
                job_info = SchedulerJobInfo(
                    job_id=str(job.id),
                    name=job.name,
                    schedule=job.schedule_value,
                    action=(job.callback_args or {}).get("action", job.callback_function),
                    enabled=job.is_active,
                    next_run=job.next_run_time.isoformat() if job.next_run_time else None,
                    last_run=job.last_run_time.isoformat() if job.last_run_time else None,
                    status=job.status.value if hasattr(job.status, "value") else str(job.status),
                    namespace=context["namespace"],
                    owner_peer_id=context["owner_peer_id"],
                    owner_principal_id=context["owner_principal_id"],
                    target_peer_id=context["target_peer_id"],
                    target_resource_namespace=context["target_resource_namespace"],
                    delegated_permissions=context["delegated_permissions"],
                    policy_decision_id=context["policy_decision_id"],
                    delegated_approval_token_present=bool(context.get("delegated_approval_token")),
                    correlation_id=context["correlation_id"],
                    blocked_reason=context.get("blocked_reason"),
                    timezone=context.get("timezone"),
                    source=context.get("source") or job.callback_module or "scheduler",
                    failure_count=getattr(job, "retry_count", 0) or 0,
                    privacy_class=context.get("privacy_class") or DEFAULT_SCHEDULER_PRIVACY_CLASS,
                    last_error=(
                        job.last_run_result
                        if (
                            (hasattr(job.status, "value") and job.status.value == "failed")
                            or str(job.status) == "failed"
                        )
                        else None
                    ),
                    action_support=self._action_support(job),
                )
                job_infos.append(job_info)

            log_debug(f"Found {total} scheduled jobs, returning {len(job_infos)}")
            if self._remote_scope_requested(scope):
                await self._audit_scheduler_event(
                    "scheduler.list.allowed",
                    {
                        **scope,
                        "target_peer_id": None,
                        "target_resource_namespace": None,
                        "delegated_permissions": [],
                        "policy_decision_id": None,
                        "delegated_approval_token": None,
                        "correlation_id": None,
                    },
                    status="allowed",
                    reason=f"returned={len(job_infos)} total={total}",
                )
            return SchedulerListJobsResponse(jobs=job_infos, total=total)

        except Exception as e:
            log_error(f"Error listing jobs: {e}", exc_info=True)
            return SchedulerListJobsResponse(jobs=[], total=0)

    async def fire_job(
        self,
        job_id: str,
        job_name: str,
        action: str,
        scheduler_context: dict[str, Any] | None = None,
    ) -> None:
        """Fire a scheduled job.

        This is called by the scheduler when a job's time arrives.

        Args:
            job_id: Job identifier (UUID string)
            job_name: Job name
            action: Action to execute
        """
        try:
            from datetime import datetime

            context = {
                "namespace": DEFAULT_SCHEDULER_NAMESPACE,
                "owner_peer_id": DEFAULT_SCHEDULER_OWNER_PEER,
                "owner_principal_id": DEFAULT_SCHEDULER_OWNER_PRINCIPAL,
                "target_peer_id": None,
                "target_resource_namespace": None,
                "delegated_permissions": [],
                "policy_decision_id": None,
                "delegated_approval_token": None,
                "correlation_id": None,
                **(scheduler_context or {}),
            }

            log_info(f"Firing scheduled job: {job_name} namespace={context['namespace']}")
            await self._audit_scheduler_event(
                "scheduler.execution.started",
                context,
                status="started",
                job_id=job_id,
            )

            # Emit job fired event
            await self.bus.publish(
                SchedulerMethods.JOB_FIRED,
                SchedulerJobFiredEvent(
                    job_id=job_id,
                    job_name=job_name,
                    action=action,
                    scheduled_time=datetime.utcnow().isoformat(),
                    namespace=context["namespace"],
                    owner_peer_id=context["owner_peer_id"],
                    owner_principal_id=context["owner_principal_id"],
                    target_peer_id=context.get("target_peer_id"),
                    delegated_permissions=context["delegated_permissions"],
                    policy_decision_id=context.get("policy_decision_id"),
                    delegated_approval_token_present=bool(context.get("delegated_approval_token")),
                    correlation_id=context.get("correlation_id"),
                ),
                priority=get_system_priority(),  # System priority
                origin="system",
            )

            # Execute the action - delegate to appropriate service via message bus
            # The action string can be:
            # - A topic to publish to (e.g., "Orchestrator.UserInput")
            # - A command with parameters (e.g., "tts:speak:Hello")
            # - A tool name to execute

            try:
                if ":" in action:
                    # Parse structured action command
                    parts = action.split(":", 1)
                    service = parts[0].lower()
                    command = parts[1] if len(parts) > 1 else ""

                    if service == "tts" and command.startswith("speak:"):
                        # TTS speak command
                        text = command[6:]  # Remove "speak:" prefix
                        from app.shared.contracts.models.tts import TTSMethods
                        from app.shared.messaging.models.tts_models import TTSRequest

                        await self.bus.publish(
                            TTSMethods.REQUEST,
                            TTSRequest(text=text, interrupt=False),
                            event=False,
                            origin="system",
                        )
                    elif service == "orchestrator":
                        if self._is_remote_delegated_context(context):
                            reason = DELEGATED_ORCHESTRATOR_EXECUTION_UNSUPPORTED_REASON
                            context["blocked_reason"] = reason
                            log_warning(
                                f"Blocked delegated orchestrator schedule for job "
                                f"{job_id}: {reason}"
                            )
                            await self.bus.publish(
                                SchedulerMethods.JOB_COMPLETED,
                                SchedulerJobCompletedEvent(
                                    job_id=job_id,
                                    job_name=job_name,
                                    success=False,
                                    error=reason,
                                    namespace=context["namespace"],
                                    owner_peer_id=context["owner_peer_id"],
                                    owner_principal_id=context["owner_principal_id"],
                                    target_peer_id=context.get("target_peer_id"),
                                    delegated_permissions=context["delegated_permissions"],
                                    policy_decision_id=context.get("policy_decision_id"),
                                    delegated_approval_token_present=bool(
                                        context.get("delegated_approval_token")
                                    ),
                                    correlation_id=context.get("correlation_id"),
                                ),
                                priority=get_system_priority(),
                                origin="system",
                            )
                            await self._audit_scheduler_event(
                                "scheduler.execution.blocked",
                                context,
                                status="blocked",
                                job_id=job_id,
                                reason=reason,
                            )
                            return

                        # Send to orchestrator as user input
                        from app.shared.contracts.models.orchestrator import OrchestratorMethods
                        from app.shared.messaging.models.orchestrator_models import UserInput

                        await self.bus.publish(
                            OrchestratorMethods.USER_INPUT,
                            UserInput(text=command, source="scheduler"),
                            event=False,
                            origin="system",
                        )
                    else:
                        log_warning(f"Unknown action service: {service}")
                else:
                    # Treat as a topic to publish to or a simple message
                    # For now, log it - in future could be enhanced to publish to arbitrary topics
                    log_debug(f"Scheduled action executed: {action}")

            except Exception as action_error:
                log_error(f"Error executing scheduled action '{action}': {action_error}")
                raise  # Re-raise to mark job as failed

            # Emit completion event
            await self.bus.publish(
                SchedulerMethods.JOB_COMPLETED,
                SchedulerJobCompletedEvent(
                    job_id=job_id,
                    job_name=job_name,
                    success=True,
                    namespace=context["namespace"],
                    owner_peer_id=context["owner_peer_id"],
                    owner_principal_id=context["owner_principal_id"],
                    target_peer_id=context.get("target_peer_id"),
                    delegated_permissions=context["delegated_permissions"],
                    policy_decision_id=context.get("policy_decision_id"),
                    delegated_approval_token_present=bool(context.get("delegated_approval_token")),
                    correlation_id=context.get("correlation_id"),
                ),
                priority=get_system_priority(),
                origin="system",
            )
            await self._audit_scheduler_event(
                "scheduler.execution.completed",
                context,
                status="success",
                job_id=job_id,
            )

        except Exception as e:
            log_error(f"Error firing job {job_name}: {e}", exc_info=True)
            context = scheduler_context or {}

            # Emit failure event
            await self.bus.publish(
                SchedulerMethods.JOB_COMPLETED,
                SchedulerJobCompletedEvent(
                    job_id=job_id,
                    job_name=job_name,
                    success=False,
                    error=str(e),
                    namespace=context.get("namespace", DEFAULT_SCHEDULER_NAMESPACE),
                    owner_peer_id=context.get("owner_peer_id", DEFAULT_SCHEDULER_OWNER_PEER),
                    owner_principal_id=context.get(
                        "owner_principal_id", DEFAULT_SCHEDULER_OWNER_PRINCIPAL
                    ),
                    target_peer_id=context.get("target_peer_id"),
                    delegated_permissions=context.get("delegated_permissions") or [],
                    policy_decision_id=context.get("policy_decision_id"),
                    delegated_approval_token_present=bool(context.get("delegated_approval_token")),
                    correlation_id=context.get("correlation_id"),
                ),
                priority=get_system_priority(),
                origin="system",
            )
            await self._audit_scheduler_event(
                "scheduler.execution.completed",
                {
                    "namespace": context.get("namespace", DEFAULT_SCHEDULER_NAMESPACE),
                    "owner_peer_id": context.get("owner_peer_id", DEFAULT_SCHEDULER_OWNER_PEER),
                    "owner_principal_id": context.get(
                        "owner_principal_id", DEFAULT_SCHEDULER_OWNER_PRINCIPAL
                    ),
                    "target_peer_id": context.get("target_peer_id"),
                    "target_resource_namespace": context.get("target_resource_namespace"),
                    "delegated_permissions": context.get("delegated_permissions") or [],
                    "policy_decision_id": context.get("policy_decision_id"),
                    "delegated_approval_token": context.get("delegated_approval_token"),
                    "correlation_id": context.get("correlation_id"),
                },
                status="failed",
                job_id=job_id,
                reason=str(e),
            )


# Callback function that can be called by scheduler_manager
async def fire_scheduled_job(**kwargs) -> dict:
    """Callback function to fire a scheduled job.

    This function is called by the scheduler manager when a job's time arrives.
    It can be referenced as "app.scheduler.service.fire_scheduled_job" in the cron service.

    The scheduler_manager now runs in the main event loop, so we can directly call
    the scheduler service's fire_job method without cross-thread complications.

    The scheduler_manager passes:
    - job_id: Job identifier (from job.id)
    - job_name: Job name (from job.name)
    - action: Action to execute (from callback_args)
    - Other fields from callback_args

    Returns:
        Dictionary with success status
    """
    try:
        # Extract arguments from kwargs
        job_id = kwargs.get("job_id")
        job_name = kwargs.get("job_name", "")
        action = kwargs.get("action", "")
        scheduler_context = kwargs.get("scheduler_context")

        if not job_id:
            log_error("fire_scheduled_job called without job_id")
            return {"success": False, "error": "job_id is required"}

        # Get scheduler service instance
        if _scheduler_service_instance is None:
            log_error("Scheduler service instance not available - cannot fire job")
            return {"success": False, "error": "Scheduler service not initialized"}

        # Call fire_job directly - we're in the same event loop now
        # job_id is already a string (UUID) from the database, pass it directly
        await _scheduler_service_instance.fire_job(
            job_id, job_name, action, scheduler_context=scheduler_context
        )

        return {"success": True, "message": f"Job {job_name} fired successfully"}

    except Exception as e:
        log_error(f"Error in fire_scheduled_job callback: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
