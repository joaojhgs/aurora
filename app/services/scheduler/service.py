"""Scheduler Service for Aurora's parallel architecture.

This service:
- Manages scheduled jobs and timers using CronService
- Processes scheduling commands
- Emits job fired events
- Handles cron job execution
"""

from __future__ import annotations

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import Command, Envelope, Event, MessageBus, SchedulerTopics
from app.messaging.priority_helpers import get_system_priority
from app.scheduler import get_cron_service

# Global scheduler service instance for callback access
_scheduler_service_instance: SchedulerService | None = None


# Message definitions
class ScheduleJob(Command):
    """Command to schedule a job."""

    name: str
    schedule: str  # Cron expression
    action: str
    enabled: bool = True


class CancelJob(Command):
    """Command to cancel a scheduled job."""

    job_id: int


class PauseJob(Command):
    """Command to pause a scheduled job."""

    job_id: int


class ResumeJob(Command):
    """Command to resume a paused job."""

    job_id: int


class SchedulerJobFired(Event):
    """Event emitted when a scheduled job fires."""

    job_id: str
    job_name: str
    action: str
    scheduled_time: str


class SchedulerJobCompleted(Event):
    """Event emitted when a scheduled job completes."""

    job_id: str
    job_name: str
    success: bool
    error: str | None = None


# Service implementation
class SchedulerService:
    """Scheduler service.

    Responsibilities:
    - Manage scheduled jobs and timers
    - Execute jobs at scheduled times
    - Emit job lifecycle events
    - Handle scheduling commands
    """

    def __init__(self, bus: MessageBus):
        """Initialize scheduler service with CronService.

        Args:
            bus: MessageBus instance
        """
        global _scheduler_service_instance

        self.bus = bus
        # Pass bus to cron service so it can inject it into callbacks
        self.cron_service = get_cron_service(bus=bus)
        self._jobs: dict = {}
        # Store instance globally for callback access
        _scheduler_service_instance = self

    async def start(self) -> None:
        """Start the scheduler service and subscribe to commands."""
        log_info("Starting Scheduler service...")

        # Initialize cron service (this will start the scheduler loop in the main event loop)
        await self.cron_service.initialize()

        # Subscribe to commands using typed topics
        self.bus.subscribe(SchedulerTopics.SCHEDULE_JOB, self._on_schedule)
        self.bus.subscribe(SchedulerTopics.CANCEL_JOB, self._on_cancel)
        self.bus.subscribe(SchedulerTopics.PAUSE_JOB, self._on_pause)
        self.bus.subscribe(SchedulerTopics.RESUME_JOB, self._on_resume)

        log_info("Scheduler service started")

    async def stop(self) -> None:
        """Stop the scheduler service."""
        log_info("Stopping Scheduler service...")

        # Stop all running jobs via CronService
        if self.cron_service:
            await self.cron_service.shutdown()
            log_debug("All scheduled jobs stopped")

        log_info("Scheduler service stopped")

    async def _on_schedule(self, env: Envelope) -> None:
        """Handle schedule job command.

        Args:
            env: Message envelope containing ScheduleJob command
        """
        try:
            cmd = ScheduleJob.model_validate(env.payload)
            log_info(f"Scheduling job: {cmd.name} ({cmd.schedule})")

            # Schedule using CronService with a proper callback function
            # The callback will be called by scheduler_manager with job_id, job_name from callback_args
            job_id = await self.cron_service.schedule_from_text(
                text=cmd.schedule,
                callback="app.scheduler.service.fire_scheduled_job",  # Module.function string
                job_name=cmd.name,
                callback_args={
                    "job_name": cmd.name,
                    "action": cmd.action,
                },
            )

            if job_id:
                # Store job for tracking
                self._jobs[job_id] = cmd
                log_debug(f"Job '{cmd.name}' scheduled successfully with ID: {job_id}")

                # Store in database via DBService
                from app.db.service import StoreCronJob
                from app.messaging import DBTopics

                await self.bus.publish(
                    DBTopics.STORE_CRON_JOB,
                    StoreCronJob(name=cmd.name, schedule=cmd.schedule, action=cmd.action, enabled=cmd.enabled),
                    event=False,  # Command
                    origin="internal",
                )
            else:
                log_warning(f"Failed to schedule job '{cmd.name}'")

        except Exception as e:
            log_error(f"Error scheduling job: {e}", exc_info=True)

    async def _on_cancel(self, env: Envelope) -> None:
        """Handle cancel job command.

        Args:
            env: Message envelope containing CancelJob command
        """
        try:
            cmd = CancelJob.model_validate(env.payload)
            log_info(f"Canceling job: {cmd.job_id}")

            # Cancel job via CronService
            job_id_str = str(cmd.job_id)
            success = await self.cron_service.cancel_job(job_id_str)

            if success:
                # Remove from local tracking
                self._jobs.pop(job_id_str, None)
                log_debug(f"Job {cmd.job_id} canceled successfully")

                # Delete from database
                from app.db.service import DeleteCronJob
                from app.messaging import DBTopics

                await self.bus.publish(DBTopics.DELETE_CRON_JOB, DeleteCronJob(job_id=cmd.job_id), event=False, origin="internal")  # Command
            else:
                log_warning(f"Failed to cancel job {cmd.job_id}")

        except Exception as e:
            log_error(f"Error canceling job: {e}", exc_info=True)

    async def _on_pause(self, env: Envelope) -> None:
        """Handle pause job command.

        Args:
            env: Message envelope containing PauseJob command
        """
        try:
            cmd = PauseJob.model_validate(env.payload)
            log_info(f"Pausing job: {cmd.job_id}")

            # Pause job via CronService
            job_id_str = str(cmd.job_id)
            success = await self.cron_service.pause_job(job_id_str)

            if success:
                log_debug(f"Job {cmd.job_id} paused successfully")
            else:
                log_warning(f"Failed to pause job {cmd.job_id}")

        except Exception as e:
            log_error(f"Error pausing job: {e}", exc_info=True)

    async def _on_resume(self, env: Envelope) -> None:
        """Handle resume job command.

        Args:
            env: Message envelope containing ResumeJob command
        """
        try:
            cmd = ResumeJob.model_validate(env.payload)
            log_info(f"Resuming job: {cmd.job_id}")

            # Resume job via CronService (unpause)
            # Note: CronService doesn't have explicit resume, but we can
            # cancel the paused job and reschedule it
            job_id_str = str(cmd.job_id)

            # Get the job from tracking
            if job_id_str in self._jobs:
                original_cmd = self._jobs[job_id_str]

                # Cancel the paused job
                await self.cron_service.cancel_job(job_id_str)

                # Reschedule it (effectively resuming)
                new_job_id = await self.cron_service.schedule_from_text(
                    text=original_cmd.schedule,
                    callback="app.scheduler.service.fire_scheduled_job",
                    job_name=original_cmd.name,
                    callback_args={
                        "job_name": original_cmd.name,
                        "action": original_cmd.action,
                    },
                )

                if new_job_id:
                    # Update tracking with new job_id
                    self._jobs.pop(job_id_str, None)
                    self._jobs[new_job_id] = original_cmd
                    log_debug(f"Job {cmd.job_id} resumed successfully with new ID: {new_job_id}")
                else:
                    log_warning(f"Failed to resume job {cmd.job_id}")
            else:
                log_warning(f"Job {cmd.job_id} not found in tracking")

        except Exception as e:
            log_error(f"Error resuming job: {e}", exc_info=True)

    async def fire_job(self, job_id: str, job_name: str, action: str) -> None:
        """Fire a scheduled job.

        This is called by the scheduler when a job's time arrives.

        Args:
            job_id: Job identifier (UUID string)
            job_name: Job name
            action: Action to execute
        """
        try:
            from datetime import datetime

            log_info(f"Firing scheduled job: {job_name}")

            # Emit job fired event
            await self.bus.publish(
                SchedulerTopics.JOB_FIRED,
                SchedulerJobFired(
                    job_id=job_id,
                    job_name=job_name,
                    action=action,
                    scheduled_time=datetime.utcnow().isoformat(),
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
                        from app.messaging import TTSTopics
                        from app.tts import TTSRequest

                        await self.bus.publish(TTSTopics.REQUEST, TTSRequest(text=text, interrupt=False), event=False, origin="system")
                    elif service == "orchestrator":
                        # Send to orchestrator as user input
                        from app.messaging import OrchestratorTopics
                        from app.orchestrator.service import UserInput

                        await self.bus.publish(
                            OrchestratorTopics.USER_INPUT, UserInput(text=command, source="scheduler"), event=False, origin="system"
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
                SchedulerTopics.JOB_COMPLETED,
                SchedulerJobCompleted(
                    job_id=job_id,
                    job_name=job_name,
                    success=True,
                ),
                priority=get_system_priority(),
                origin="system",
            )

        except Exception as e:
            log_error(f"Error firing job {job_name}: {e}", exc_info=True)

            # Emit failure event
            await self.bus.publish(
                SchedulerTopics.JOB_COMPLETED,
                SchedulerJobCompleted(
                    job_id=job_id,
                    job_name=job_name,
                    success=False,
                    error=str(e),
                ),
                priority=get_system_priority(),
                origin="system",
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

        if not job_id:
            log_error("fire_scheduled_job called without job_id")
            return {"success": False, "error": "job_id is required"}

        # Get scheduler service instance
        if _scheduler_service_instance is None:
            log_error("Scheduler service instance not available - cannot fire job")
            return {"success": False, "error": "Scheduler service not initialized"}

        # Call fire_job directly - we're in the same event loop now
        # job_id is already a string (UUID) from the database, pass it directly
        await _scheduler_service_instance.fire_job(job_id, job_name, action)

        return {"success": True, "message": f"Job {job_name} fired successfully"}

    except Exception as e:
        log_error(f"Error in fire_scheduled_job callback: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
