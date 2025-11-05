"""
Main scheduler manager for Aurora cron jobs.
Handles job execution, timing, and persistence using the database module.
Runs in the main event loop - no separate thread needed.
"""

import asyncio
import importlib
from datetime import datetime, timedelta
from typing import Any, Optional

from croniter import croniter

from app.services.db.models import CronJob, JobStatus, ScheduleType
from app.services.db.scheduler_db_service import SchedulerDatabaseService
from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import MessageBus


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
            try:
                await self._scheduler_task
            except asyncio.CancelledError:
                pass

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

    async def _execute_job(self, job: CronJob):
        """Execute a single job"""
        log_debug(f"Executing job: {job.name} ({job.id})")

        try:
            # Update status to running
            job.update_status(JobStatus.RUNNING)
            await self.db_service.update_job(job)

            # Import and execute the callback
            result = await self._call_job_callback(job)

            # Update status based on result
            if result is not None and result.get("success", True):
                job.update_status(JobStatus.COMPLETED, str(result.get("message", "Success")))

                # Calculate next run time for recurring jobs
                if job.schedule_type == ScheduleType.CRON:
                    job.next_run_time = self._calculate_next_run_time(job)
                else:
                    # One-time absolute job - deactivate
                    job.is_active = False

            else:
                error_msg = result.get("error", "Unknown error") if result else "No result returned"
                job.update_status(JobStatus.FAILED, error_msg)

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

    async def _call_job_callback(self, job: CronJob) -> Optional[dict[str, Any]]:
        """Call the job's callback function.

        Injects the bus instance into callback arguments (like tool manager does).
        """
        try:
            # Import the module
            module = importlib.import_module(job.callback_module)

            # Get the function
            callback_func = getattr(module, job.callback_function)

            # Prepare arguments - create a copy to avoid modifying the original job.callback_args
            # (which could contain non-serializable objects like bus if it was stored)
            args = dict(job.callback_args) if job.callback_args else {}
            args["job_id"] = job.id
            args["job_name"] = job.name

            # Inject bus instance if available (like tool manager does)
            # This is added at runtime and never stored in the database
            if self.bus:
                args["bus"] = self.bus

            # Call the function
            if asyncio.iscoroutinefunction(callback_func):
                result = await callback_func(**args)
            else:
                result = callback_func(**args)

            return result if isinstance(result, dict) else {"success": True, "message": str(result)}

        except Exception as e:
            return {"success": False, "error": str(e)}

    def _calculate_next_run_time(self, job: CronJob) -> Optional[datetime]:
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

    def _parse_absolute_time(self, absolute_time: str) -> Optional[datetime]:
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

        except Exception:
            raise ValueError(f"Invalid absolute time format: {absolute_time}")

    # Public API methods
    async def create_absolute_job(
        self,
        name: str,
        absolute_time: str,
        callback_module: str,
        callback_function: str,
        callback_args: Optional[dict[str, Any]] = None,
    ) -> Optional[str]:
        """Create an absolute time job and return its ID"""
        job = CronJob.create_absolute_job(
            name=name,
            absolute_time=absolute_time,
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args,
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
        callback_args: Optional[dict[str, Any]] = None,
    ) -> Optional[str]:
        """Create a cron expression job and return its ID"""
        job = CronJob.create_cron_job(
            name=name,
            cron_expression=cron_expression,
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args,
        )

        # Calculate initial next run time
        job.next_run_time = self._calculate_next_run_time(job)

        if await self.db_service.add_job(job):
            # Add to cache if active
            if job.is_active:
                self._jobs_cache[job.id] = job
            return job.id
        return None

    async def get_job(self, job_id: str) -> Optional[CronJob]:
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
