"""
Main scheduler manager for Aurora cron jobs.
Handles job execution, timing, and persistence using the database module.
Runs in the main event loop - no separate thread needed.
"""

import asyncio
import contextlib
from datetime import datetime, timedelta
from typing import Any, Optional

from croniter import croniter
from pydantic import TypeAdapter

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import MessageBus
from app.messaging.priority_helpers import get_system_priority
from app.services.db.scheduler_db_service import SchedulerDatabaseService
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.scheduler import (
    SchedulerActionSpec,
    SchedulerJobCompletedEvent,
    SchedulerJobFiredEvent,
    SchedulerMethods,
    SchedulerOrchestratorUserInputAction,
    SchedulerToolBinding,
    SchedulerToolExecuteAction,
    SchedulerTtsSpeakAction,
)
from app.shared.contracts.models.tooling import ToolingExecuteToolRequest, ToolingMethods
from app.shared.contracts.models.tts import TTSMethods
from app.shared.messaging.models.orchestrator_models import UserInput
from app.shared.messaging.models.tts_models import TTSRequest
from app.shared.models.db import CronJob, JobStatus, ScheduleType

LEGACY_TOOLING_MODULE_PREFIX = ".".join(["app", "tooling", "tools"])
CURRENT_TOOLING_MODULE_PREFIX = "app.services.tooling.tools"


class SchedulerManager:
    """Main scheduler that manages and executes cron jobs.

    Runs in the main event loop - no separate thread needed.
    All operations are async and use the BUS for communication.
    """

    def __init__(self, db_path: str = None, bus: MessageBus | None = None):
        self.db_service = SchedulerDatabaseService(db_path)
        self.bus = bus  # Bus instance for injecting into callbacks
        self._running = False
        self._scheduler_task: asyncio.Task | None = None
        self._jobs_cache: dict[str, CronJob] = {}

    async def initialize(self):
        """Initialize the scheduler database and load jobs"""
        await self.db_service.initialize()
        await self._repair_legacy_tooling_callback_jobs()
        await self._load_jobs()
        log_info("Scheduler initialization completed")

    async def start(self):
        """Start the scheduler loop in the current event loop"""
        if self._running:
            log_info("Scheduler is already running")
            return

        self._running = True
        # Start scheduler loop as background task
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())
        log_info("Scheduler started in main event loop")

    async def stop(self):
        """Stop the scheduler"""
        if not self._running:
            return

        self._running = False

        # Cancel the scheduler task if it's running
        if self._scheduler_task and not self._scheduler_task.done():
            self._scheduler_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._scheduler_task

        log_info("Scheduler stopped")

    async def _scheduler_loop(self):
        """Main async scheduler loop - runs in main event loop"""
        while self._running:
            try:
                # Check for jobs that need to run
                ready_jobs = await self.db_service.get_ready_jobs()

                if ready_jobs:
                    for job in ready_jobs:
                        log_info(f"Executing scheduled job: {job.name}")
                        # Execute job in background task
                        asyncio.create_task(self._execute_job(job))

                # Sleep for a short interval before checking again
                await asyncio.sleep(1)  # Check every second

            except asyncio.CancelledError:
                log_info("Scheduler loop cancelled")
                break
            except Exception as e:
                log_error(f"Error in scheduler loop: {e}", exc_info=True)
                await asyncio.sleep(5)  # Wait longer on errors

    async def _load_jobs(self):
        """Load all active jobs from database"""
        try:
            active_jobs = await self.db_service.get_active_jobs()

            self._jobs_cache.clear()
            for job in active_jobs:
                # Calculate next run time if not set
                if job.next_run_time is None:
                    job.next_run_time = self._calculate_next_run_time(job)
                    await self.db_service.update_job(job)

                self._jobs_cache[job.id] = job

            log_info(f"Loaded {len(self._jobs_cache)} active jobs")

        except Exception as e:
            log_error(f"Error loading jobs: {e}")

    def _legacy_tooling_callback_to_action_spec(self, job: CronJob) -> dict[str, Any] | None:
        """Translate known stale Tooling callback rows into typed scheduler actions."""

        module = (job.callback_module or "").strip()
        function = (job.callback_function or "").strip()
        if module not in {
            f"{LEGACY_TOOLING_MODULE_PREFIX}.scheduler_tool",
            f"{LEGACY_TOOLING_MODULE_PREFIX}.pomodoro_tool",
            f"{CURRENT_TOOLING_MODULE_PREFIX}.scheduler_tool",
            f"{CURRENT_TOOLING_MODULE_PREFIX}.pomodoro_tool",
        }:
            return None

        args = job.callback_args or {}
        message = args.get("message") or args.get("text")
        if module.endswith("scheduler_tool"):
            if function == "speak_reminder":
                action = SchedulerTtsSpeakAction(text=message or "Scheduled reminder")
            else:
                tool_by_function = {
                    "daily_greeting": "scheduler_daily_greeting_tool",
                    "break_reminder": "scheduler_break_reminder_tool",
                    "water_reminder": "scheduler_water_reminder_tool",
                    "motivational_message": "scheduler_motivational_message_tool",
                    "hourly_time_announcement": "scheduler_hourly_time_announcement_tool",
                }
                tool_name = tool_by_function.get(function)
                if not tool_name:
                    return None
                tool_args = {"message": message} if message else {}
                action = SchedulerToolExecuteAction(
                    binding=SchedulerToolBinding(tool_name=tool_name),
                    arguments=tool_args,
                )
            return action.model_dump(mode="json")

        if module.endswith("pomodoro_tool"):
            transition_by_function = {
                "work_session_end": "work_session_end",
                "break_session_end": "break_session_end",
            }
            transition = transition_by_function.get(function)
            if not transition:
                return None
            action = SchedulerToolExecuteAction(
                binding=SchedulerToolBinding(tool_name="pomodoro_transition_tool"),
                arguments={"transition": transition},
            )
            return action.model_dump(mode="json")

        return None

    async def _repair_legacy_tooling_callback_jobs(self) -> None:
        """Repair known stale Tooling callback rows before the scheduler loop fires them.

        Unknown stale Tooling callback imports are quarantined instead of imported at
        fire time. Legacy callbacks outside the known stale Tooling namespaces are
        left alone for the compatibility fallback.
        """

        try:
            jobs = await self.db_service.get_all_jobs()
        except Exception as error:
            log_warning(f"Scheduler legacy repair skipped: {error}")
            return

        for job in jobs:
            if job.action_spec:
                continue
            module = (job.callback_module or "").strip()
            if not module.startswith(
                (f"{LEGACY_TOOLING_MODULE_PREFIX}.", f"{CURRENT_TOOLING_MODULE_PREFIX}.")
            ):
                continue

            action_spec = self._legacy_tooling_callback_to_action_spec(job)
            if action_spec:
                old_callback = f"{module}.{job.callback_function}"
                job.callback_module = "__typed_action__"
                job.callback_function = "execute_action_spec"
                job.action_kind = action_spec.get("kind")
                job.action_spec = action_spec
                job.prepared_binding = (
                    action_spec.get("binding")
                    if action_spec.get("kind") == "tooling.execute"
                    else None
                )
                job.last_run_result = f"legacy callback repaired from {old_callback}"
                await self.db_service.update_job(job)
                log_info(f"Repaired legacy scheduler callback job {job.id}: {job.name}")
                continue

            job.is_active = False
            job.status = JobStatus.FAILED
            job.last_run_result = f"legacy callback quarantined: {module}.{job.callback_function}"
            await self.db_service.update_job(job)
            log_warning(f"Quarantined unknown legacy scheduler callback job {job.id}: {job.name}")

    def _job_scheduler_context(self, job: CronJob) -> dict[str, Any]:
        """Return persisted scheduler context for typed job events/audit."""

        context = {}
        if isinstance(job.callback_args, dict):
            raw_context = job.callback_args.get("scheduler_context")
            if isinstance(raw_context, dict):
                context.update(raw_context)
        binding = job.prepared_binding or {}
        if isinstance(binding, dict):
            context.setdefault("provider_peer_id", binding.get("provider_peer_id"))
            context.setdefault(
                "provider_service_instance_id", binding.get("provider_service_instance_id")
            )
            context.setdefault("global_tool_id", binding.get("global_tool_id"))
        context.setdefault("namespace", "local")
        context.setdefault("owner_peer_id", "local")
        context.setdefault("owner_principal_id", "system")
        context.setdefault("target_peer_id", None)
        context.setdefault("delegated_permissions", [])
        context.setdefault("policy_decision_id", job.policy_decision_id)
        context.setdefault("delegated_approval_token", None)
        context.setdefault("correlation_id", None)
        context.setdefault("action_kind", job.action_kind)
        return context

    def _job_action_label(self, job: CronJob) -> str:
        if job.action_spec and job.action_kind:
            return job.action_kind
        return f"{job.callback_module}.{job.callback_function}"

    async def _publish_job_fired_event(self, job: CronJob) -> None:
        if not self.bus:
            return
        context = self._job_scheduler_context(job)
        await self.bus.publish(
            SchedulerMethods.JOB_FIRED,
            SchedulerJobFiredEvent(
                job_id=job.id,
                job_name=job.name,
                action=self._job_action_label(job),
                scheduled_time=datetime.utcnow().isoformat(),
                action_kind=job.action_kind,
                provider_peer_id=context.get("provider_peer_id"),
                provider_service_instance_id=context.get("provider_service_instance_id"),
                global_tool_id=context.get("global_tool_id"),
                namespace=context["namespace"],
                owner_peer_id=context["owner_peer_id"],
                owner_principal_id=context["owner_principal_id"],
                target_peer_id=context.get("target_peer_id"),
                delegated_permissions=context.get("delegated_permissions") or [],
                policy_decision_id=context.get("policy_decision_id"),
                delegated_approval_token_present=bool(context.get("delegated_approval_token")),
                correlation_id=context.get("correlation_id"),
            ),
            priority=get_system_priority(),
            origin="system",
        )

    async def _publish_job_completed_event(
        self,
        job: CronJob,
        *,
        success: bool,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        if not self.bus:
            return
        context = self._job_scheduler_context(job)
        result = result or {}
        summary = str(result.get("message") or error or result.get("error") or "completed")
        await self.bus.publish(
            SchedulerMethods.JOB_COMPLETED,
            SchedulerJobCompletedEvent(
                job_id=job.id,
                job_name=job.name,
                success=success,
                error=error or (None if success else str(result.get("error") or "failed")),
                action_kind=job.action_kind,
                provider_peer_id=context.get("provider_peer_id"),
                provider_service_instance_id=context.get("provider_service_instance_id"),
                global_tool_id=context.get("global_tool_id"),
                result_summary=summary,
                namespace=context["namespace"],
                owner_peer_id=context["owner_peer_id"],
                owner_principal_id=context["owner_principal_id"],
                target_peer_id=context.get("target_peer_id"),
                delegated_permissions=context.get("delegated_permissions") or [],
                policy_decision_id=context.get("policy_decision_id"),
                delegated_approval_token_present=bool(context.get("delegated_approval_token")),
                correlation_id=context.get("correlation_id"),
            ),
            priority=get_system_priority(),
            origin="system",
        )

    async def _execute_job(self, job: CronJob):
        """Execute a single job"""
        log_debug(f"Executing job: {job.name} ({job.id})")

        try:
            # Update status to running
            job.update_status(JobStatus.RUNNING)
            await self.db_service.update_job(job)
            await self._publish_job_fired_event(job)

            if job.action_spec:
                result = await self._execute_action_spec(job)
            else:
                # Legacy fallback only. New scheduler-created jobs persist action_spec.
                result = await self._call_job_callback(job)

            # Update status based on result
            if result is not None and result.get("success", True):
                job.update_status(JobStatus.COMPLETED, str(result.get("message", "Success")))
                await self._publish_job_completed_event(job, success=True, result=result)

                # Calculate next run time for recurring jobs
                if job.schedule_type == ScheduleType.CRON:
                    job.next_run_time = self._calculate_next_run_time(job)
                else:
                    # One-time absolute job - deactivate
                    job.is_active = False

            else:
                error_msg = result.get("error", "Unknown error") if result else "No result returned"
                job.update_status(JobStatus.FAILED, error_msg)
                await self._publish_job_completed_event(
                    job, success=False, result=result, error=error_msg
                )

                # For failed jobs, calculate retry time
                if job.can_retry():
                    job.next_run_time = datetime.now() + timedelta(minutes=5 * job.retry_count)
                    job.status = JobStatus.PENDING
                else:
                    job.is_active = False  # Max retries reached

        except Exception as e:
            error_msg = f"Execution error: {str(e)}"
            log_error(f"Job execution failed: {error_msg}")
            job.update_status(JobStatus.FAILED, error_msg)
            await self._publish_job_completed_event(job, success=False, error=error_msg)

            if job.can_retry():
                job.next_run_time = datetime.now() + timedelta(minutes=5 * job.retry_count)
                job.status = JobStatus.PENDING
            else:
                job.is_active = False

        # Save job state
        await self.db_service.update_job(job)

        # Update cache
        if job.is_active:
            self._jobs_cache[job.id] = job
        else:
            self._jobs_cache.pop(job.id, None)

    async def _execute_action_spec(self, job: CronJob) -> dict[str, Any]:
        """Execute a typed scheduled action through the bus."""
        if not self.bus:
            return {"success": False, "error": "scheduler_bus_unavailable"}

        try:
            action = TypeAdapter(SchedulerActionSpec).validate_python(job.action_spec)
        except Exception as error:
            return {"success": False, "error": f"invalid_action_spec: {error}"}

        try:
            if isinstance(action, SchedulerTtsSpeakAction):
                await self.bus.publish(
                    TTSMethods.REQUEST,
                    TTSRequest(text=action.text, interrupt=action.interrupt),
                    event=False,
                    priority=get_system_priority(),
                    origin="system",
                )
                return {"success": True, "message": "tts action dispatched"}

            if isinstance(action, SchedulerOrchestratorUserInputAction):
                await self.bus.publish(
                    OrchestratorMethods.USER_INPUT,
                    UserInput(text=action.text, source=action.source),
                    event=False,
                    priority=get_system_priority(),
                    origin="system",
                )
                return {"success": True, "message": "orchestrator action dispatched"}

            if isinstance(action, SchedulerToolExecuteAction):
                context = self._job_scheduler_context(job)
                tool_name = (
                    action.binding.local_tool_name
                    or action.binding.global_tool_id
                    or action.binding.tool_name
                )
                result = await self.bus.request(
                    ToolingMethods.EXECUTE_TOOL,
                    ToolingExecuteToolRequest(
                        tool_name=tool_name,
                        arguments=action.arguments,
                        expected_args_schema_hash=action.binding.args_schema_hash,
                        mesh_selector=action.mesh_selector,
                        resource_selector=action.resource_selector,
                        confirmed=action.confirmed,
                        approval_token=action.approval_token,
                        correlation_id=action.correlation_id,
                        caller_peer_id=action.caller_peer_id,
                        caller_principal_id=action.caller_principal_id,
                        caller_permissions=context.get("delegated_permissions") or [],
                        schedule_id=action.schedule_id or job.id,
                        scheduled_action_hash=action.scheduled_action_hash,
                    ),
                    priority=get_system_priority(),
                    origin="system",
                    timeout=30.0,
                    correlation_id=action.correlation_id,
                )
                if not result.ok:
                    return {"success": False, "error": result.error or "tool_execution_failed"}
                data = result.data or {}
                if isinstance(data, dict) and data.get("ok") is False:
                    return {
                        "success": False,
                        "error": (
                            data.get("error_code")
                            or data.get("error")
                            or data.get("status")
                            or "tool_execution_failed"
                        ),
                    }
                return {"success": True, "message": "tool action executed", "data": data}

            return {
                "success": False,
                "error": f"unsupported_action_kind: {getattr(action, 'kind', None)}",
            }
        except Exception as error:
            return {"success": False, "error": str(error)}

    async def _call_job_callback(self, job: CronJob) -> dict[str, Any] | None:
        """Reject non-typed legacy callbacks instead of importing arbitrary code.

        Known stale Tooling callbacks are repaired during ``initialize()`` by
        ``_repair_legacy_tooling_callback_jobs``. Remaining non-typed callbacks
        are intentionally quarantined at fire time so persisted scheduler rows
        cannot dynamically import and execute arbitrary Python modules.
        """

        callback = f"{job.callback_module}.{job.callback_function}"
        log_warning(
            "Rejected non-typed scheduler callback import for job "
            f"{job.id} ({job.name}): {callback}"
        )
        return {
            "success": False,
            "error": f"legacy_callback_unsupported: {callback}",
        }

    def _calculate_next_run_time(self, job: CronJob) -> datetime | None:
        """Calculate the next run time for a job"""
        try:
            if job.schedule_type == ScheduleType.CRON:
                # Standard cron expression
                cron = croniter(job.schedule_value, datetime.now())
                return cron.get_next(datetime)

            elif job.schedule_type == ScheduleType.ABSOLUTE:
                return self._parse_absolute_time(job.schedule_value)

            # RELATIVE type is no longer supported - should use cron expressions instead
            else:
                raise ValueError(f"Unsupported schedule type: {job.schedule_type}")

        except Exception as e:
            log_error(f"Error calculating next run time for job {job.name}: {e}")
            return None

    def _parse_absolute_time(self, absolute_time: str) -> datetime | None:
        """Parse absolute time expressions like '2025-05-28 15:00' or '28/05/2025 15:00'"""
        try:
            # Try various datetime formats (including Portuguese/Brazilian DD/MM/YYYY format)
            formats = [
                "%Y-%m-%d %H:%M:%S",  # ISO format with time
                "%Y-%m-%d %H:%M",  # ISO format without seconds
                "%Y-%m-%d",  # ISO date only
                "%d/%m/%Y %H:%M:%S",  # Portuguese/Brazilian format with time
                "%d/%m/%Y %H:%M",  # Portuguese/Brazilian format without seconds
                "%d/%m/%Y",  # Portuguese/Brazilian date only
                "%m/%d/%Y %H:%M:%S",  # US format with time
                "%m/%d/%Y %H:%M",  # US format without seconds
                "%m/%d/%Y",  # US date only
            ]

            for fmt in formats:
                try:
                    return datetime.strptime(absolute_time, fmt)
                except ValueError:
                    continue

            # If no format worked, try parsing ISO format
            return datetime.fromisoformat(absolute_time)

        except Exception as e:
            raise ValueError(f"Invalid absolute time format: {absolute_time}") from e

    # Public API methods
    async def create_absolute_job(
        self,
        name: str,
        absolute_time: str,
        callback_module: str,
        callback_function: str,
        callback_args: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> str | None:
        """Create an absolute time job and return its ID.

        Compatibility-only callback-shaped creation surface. Scheduler fire
        paths no longer import these callback strings; new service callers
        should persist typed ``action_spec`` jobs instead.
        """
        job = CronJob.create_absolute_job(
            name=name,
            absolute_time=absolute_time,
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args,
            **kwargs,
        )

        # Calculate initial next run time
        job.next_run_time = self._calculate_next_run_time(job)

        if await self.db_service.add_job(job):
            # Add to cache if active
            if job.is_active:
                self._jobs_cache[job.id] = job
            return job.id
        return None

    async def create_cron_job(
        self,
        name: str,
        cron_expression: str,
        callback_module: str,
        callback_function: str,
        callback_args: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> str | None:
        """Create a cron expression job and return its ID.

        Compatibility-only callback-shaped creation surface. Scheduler fire
        paths no longer import these callback strings; new service callers
        should persist typed ``action_spec`` jobs instead.
        """
        job = CronJob.create_cron_job(
            name=name,
            cron_expression=cron_expression,
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args,
            **kwargs,
        )

        # Calculate initial next run time
        job.next_run_time = self._calculate_next_run_time(job)

        if await self.db_service.add_job(job):
            # Add to cache if active
            if job.is_active:
                self._jobs_cache[job.id] = job
            return job.id
        return None

    async def get_job(self, job_id: str) -> CronJob | None:
        """Get a job by ID"""
        return await self.db_service.get_job(job_id)

    async def get_all_jobs(self) -> list[CronJob]:
        """Get all jobs"""
        return await self.db_service.get_all_jobs()

    async def delete_job(self, job_id: str) -> bool:
        """Delete a job"""
        result = await self.db_service.delete_job(job_id)
        if result:
            self._jobs_cache.pop(job_id, None)
        return result

    async def deactivate_job(self, job_id: str) -> bool:
        """Deactivate a job"""
        result = await self.db_service.deactivate_job(job_id)
        if result:
            self._jobs_cache.pop(job_id, None)
        return result
