"""
High-level cron service interface for Aurora.
Provides easy-to-use functions for scheduling tasks.
"""

from typing import Any, Callable, Optional, Union

from app.services.db.models import CronJob
from app.helpers.aurora_logger import log_error, log_info, log_warning
from app.messaging import MessageBus
from .scheduler_manager import SchedulerManager


class CronService:
    """High-level service for managing cron jobs"""

    def __init__(self, scheduler_manager: SchedulerManager = None, bus: MessageBus | None = None):
        self.bus = bus  # Store bus to pass to scheduler_manager
        if scheduler_manager:
            self.scheduler_manager = scheduler_manager
        else:
            # Create scheduler_manager with bus
            self.scheduler_manager = SchedulerManager(bus=bus)
        self._initialized = False

    async def initialize(self):
        """Initialize the cron service"""
        if not self._initialized:
            await self.scheduler_manager.initialize()
            await self.scheduler_manager.start()
            self._initialized = True
            log_info("Cron service initialized")

    async def schedule_absolute(
        self,
        name: str,
        absolute_time: str,
        callback: Union[Callable, str],
        callback_args: Optional[dict[str, Any]] = None,
        **kwargs,
    ) -> Optional[str]:
        """
        Schedule a job with absolute time.

        Args:
            name: Job name
            absolute_time: Time like "2025-05-28 15:00", "12/25/2025 09:00"
            callback: Function to call or module.function string
            callback_args: Arguments to pass to callback
            **kwargs: Additional job options

        Returns:
            Job ID if successful, None otherwise

        Examples:
            await cron_service.schedule_absolute("meeting", "2025-05-28 15:00", meeting_reminder)
            await cron_service.schedule_absolute("report", "12/31/2025 23:59", generate_report)
        """
        return await self._schedule_job_async(
            self.scheduler_manager.create_absolute_job,
            name=name,
            absolute_time=absolute_time,
            callback=callback,
            callback_args=callback_args,
            **kwargs,
        )

    async def schedule_cron(
        self,
        name: str,
        cron_expression: str,
        callback: Union[Callable, str],
        callback_args: Optional[dict[str, Any]] = None,
        **kwargs,
    ) -> Optional[str]:
        """
        Schedule a job with cron expression.

        Args:
            name: Job name
            cron_expression: Standard cron expression like "0 9 * * 1-5"
            callback: Function to call or module.function string
            callback_args: Arguments to pass to callback
            **kwargs: Additional job options

        Returns:
            Job ID if successful, None otherwise

        Examples:
            # Daily at 9 AM on weekdays
            await cron_service.schedule_cron("daily_report", "0 9 * * 1-5", generate_report)

            # Every 30 minutes
            await cron_service.schedule_cron("health_check", "*/30 * * * *", check_system)
        """
        return await self._schedule_job_async(
            self.scheduler_manager.create_cron_job,
            name=name,
            cron_expression=cron_expression,
            callback=callback,
            callback_args=callback_args,
            **kwargs,
        )

    async def _schedule_job_async(self, scheduler_method, callback, **kwargs) -> Optional[str]:
        """Helper to schedule jobs asynchronously"""
        if not self._initialized:
            log_warning("Warning: CronService not initialized. Call initialize() first.")
            return None

        try:
            # Parse callback
            callback_module, callback_function = self._parse_callback(callback)

            # Call the scheduler manager method directly
            job_id = await scheduler_method(callback_module=callback_module, callback_function=callback_function, **kwargs)

            return job_id

        except Exception as e:
            log_error(f"Error scheduling job: {e}")
            return None

    def _parse_callback(self, callback) -> tuple[str, str]:
        """Parse callback into module and function name"""
        if isinstance(callback, str):
            # String format: "module.function"
            if "." in callback:
                parts = callback.rsplit(".", 1)
                return parts[0], parts[1]
            else:
                return "__main__", callback
        elif callable(callback):
            # Function object
            module = callback.__module__
            function = callback.__name__
            return module, function
        else:
            raise ValueError("Callback must be a function or string in format 'module.function'")

    async def get_job(self, job_id: str) -> Optional[CronJob]:
        """Get job by ID asynchronously"""
        if not self._initialized:
            return None

        return await self.scheduler_manager.get_job(job_id)

    async def get_all_jobs(self) -> list[CronJob]:
        """Get all jobs asynchronously"""
        if not self._initialized:
            return []

        return await self.scheduler_manager.get_all_jobs()

    async def cancel_job(self, job_id: str) -> bool:
        """Cancel a job by ID"""
        if not self._initialized:
            return False

        return await self.scheduler_manager.delete_job(job_id)

    async def pause_job(self, job_id: str) -> bool:
        """Pause a job (deactivate without deleting)"""
        if not self._initialized:
            return False

        return await self.scheduler_manager.deactivate_job(job_id)

    async def get_job_status(self, job_id: str) -> Optional[dict[str, Any]]:
        """Get detailed job status"""
        job = await self.get_job(job_id)
        if not job:
            return None

        return {
            "id": job.id,
            "name": job.name,
            "status": job.status.value,
            "is_active": job.is_active,
            "next_run_time": job.next_run_time.isoformat() if job.next_run_time else None,
            "last_run_time": job.last_run_time.isoformat() if job.last_run_time else None,
            "last_run_result": job.last_run_result,
            "retry_count": job.retry_count,
            "max_retries": job.max_retries,
            "schedule_type": job.schedule_type.value,
            "schedule_value": job.schedule_value,
        }

    async def shutdown(self):
        """Shutdown the cron service"""
        if self.scheduler_manager:
            await self.scheduler_manager.stop()
            # Ensure executor and other resources are properly cleaned up
            if hasattr(self.scheduler_manager, "shutdown"):
                self.scheduler_manager.shutdown()
        log_info("Cron service shutdown")

    async def schedule_from_text(
        self,
        name: str,
        schedule_text: str,
        callback: Union[Callable, str],
        callback_args: Optional[dict[str, Any]] = None,
        **kwargs,
    ) -> Optional[str]:
        """
        Schedule a job using either absolute time or cron expression format.

        This method only accepts:
        - Absolute time: "YYYY-MM-DD HH:MM" or "DD/MM/YYYY HH:MM" (e.g., "2025-10-31 15:30" or "31/10/2025 15:30")
        - Cron expression: Standard 5-field cron format "minute hour day month weekday" (e.g., "0 9 * * *" for daily at 9am)

        Args:
            name: Job name
            schedule_text: Either absolute time or cron expression (see examples)
            callback: Function to call or module.function string
            callback_args: Arguments to pass to callback
            **kwargs: Additional job options

        Returns:
            Job ID if successful, None otherwise

        Examples:
            # Absolute time (one-time execution)
            await cron.schedule_from_text("meeting", "2025-10-31 15:30", meeting_reminder)
            await cron.schedule_from_text("call", "31/10/2025 14:00", call_reminder)

            # Cron expressions (recurring)
            await cron.schedule_from_text("daily", "0 9 * * *", daily_task)  # Daily at 9am
            await cron.schedule_from_text("weekly", "0 8 * * 1", weekly_report)  # Every Monday at 8am
            await cron.schedule_from_text("hourly", "0 * * * *", hourly_check)  # Every hour
            await cron.schedule_from_text("weekdays", "0 9 * * 1-5", weekday_task)  # Weekdays at 9am
        """
        try:
            # Check if it's a cron expression (5 parts separated by spaces)
            if self._is_cron_expression(schedule_text):
                return await self.schedule_cron(
                    name=name,
                    cron_expression=schedule_text,
                    callback=callback,
                    callback_args=callback_args,
                    **kwargs,
                )
            else:
                # Assume absolute time format
                return await self.schedule_absolute(
                    name=name,
                    absolute_time=schedule_text,
                    callback=callback,
                    callback_args=callback_args,
                    **kwargs,
                )

        except Exception as e:
            log_error(f"Error scheduling job '{name}' with schedule '{schedule_text}': {e}")
            return None

    def _is_cron_expression(self, text: str) -> bool:
        """Check if text looks like a cron expression (5 fields: minute hour day month weekday)"""
        parts = text.split()
        # Basic cron has 5 parts: minute hour day month weekday
        if len(parts) != 5:
            return False
        # Check if each part contains valid cron characters (digits, *, /, -, ,)
        for part in parts:
            # Remove valid cron characters and check if remainder is empty or digits
            cleaned = part.replace("*", "").replace("/", "").replace("-", "").replace(",", "")
            if cleaned and not cleaned.isdigit():
                return False
        return True


# Global service instance
_cron_service: Optional[CronService] = None


def get_cron_service(bus: MessageBus | None = None) -> CronService:
    """Get the global cron service instance.

    Args:
        bus: Optional MessageBus instance to inject into callbacks
    """
    global _cron_service

    if _cron_service is None:
        _cron_service = CronService(bus=bus)
    elif bus and _cron_service.scheduler_manager.bus is None:
        # Update bus if it wasn't set before
        _cron_service.bus = bus
        _cron_service.scheduler_manager.bus = bus

    return _cron_service


# Convenience functions for the main module
def schedule_task(
    name: str,
    when: str,
    callback: Union[Callable, str],
    callback_args: Optional[dict[str, Any]] = None,
    **kwargs,
) -> Optional[str]:
    """
    Schedule a task using either absolute time or cron expression format.

    Args:
        name: Task name
        when: When to run - either absolute time ("YYYY-MM-DD HH:MM" or "DD/MM/YYYY HH:MM") or cron expression ("minute hour day month weekday")
        callback: Function to call or module.function string
        callback_args: Arguments to pass to callback
        **kwargs: Additional options

    Returns:
        Job ID if successful, None otherwise

    Examples:
        # Absolute time (one-time execution)
        schedule_task("meeting", "2025-10-31 15:30", meeting_alert)
        schedule_task("call", "31/10/2025 14:00", call_reminder)

        # Cron expression (recurring)
        schedule_task("daily_task", "0 9 * * *", daily_function)  # Daily at 9am
        schedule_task("hourly_check", "0 * * * *", hourly_function)  # Every hour
        schedule_task("weekdays", "0 9 * * 1-5", weekday_function)  # Weekdays at 9am
    """
    service = get_cron_service()

    # Use schedule_from_text which handles both formats
    import asyncio

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # If we're in an async context, we need to schedule it differently
            # For sync convenience function, we'll create a new event loop
            import threading

            result = [None]

            def run_async():
                result[0] = asyncio.run(service.schedule_from_text(name, when, callback, callback_args, **kwargs))

            thread = threading.Thread(target=run_async)
            thread.start()
            thread.join()
            return result[0]
        else:
            return loop.run_until_complete(service.schedule_from_text(name, when, callback, callback_args, **kwargs))
    except RuntimeError:
        # No event loop, create a new one
        return asyncio.run(service.schedule_from_text(name, when, callback, callback_args, **kwargs))
