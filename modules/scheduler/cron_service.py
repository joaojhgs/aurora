"""
High-level cron service interface for Aurora.
Provides easy-to-use functions for scheduling tasks.
"""

import asyncio
import re
from typing import Optional, Dict, Any, Callable, Union
from datetime import datetime, timedelta
import threading

from .scheduler_manager import SchedulerManager
from ..database import CronJob, ScheduleType


class CronService:
    """High-level service for managing cron jobs"""
    
    def __init__(self, scheduler_manager: SchedulerManager = None):
        self.scheduler_manager = scheduler_manager or SchedulerManager()
        self._initialized = False
        self._lock = threading.Lock()
    
    async def initialize(self):
        """Initialize the cron service"""
        if not self._initialized:
            await self.scheduler_manager.initialize()
            self.scheduler_manager.start()
            self._initialized = True
            print("Cron service initialized")
    
    async def schedule_relative(
        self,
        name: str,
        relative_time: str,
        callback: Union[Callable, str],
        callback_args: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> Optional[str]:
        """
        Schedule a job with relative time.
        
        Args:
            name: Job name
            relative_time: Time expression like "in 5 minutes", "every 1 hour"
            callback: Function to call or module.function string
            callback_args: Arguments to pass to callback
            **kwargs: Additional job options
        
        Returns:
            Job ID if successful, None otherwise
        
        Examples:
            # One-time jobs
            await cron_service.schedule_relative("reminder", "in 30 minutes", my_function)
            await cron_service.schedule_relative("cleanup", "in 1 hour", "mymodule.cleanup_function")
            
            # Recurring jobs
            await cron_service.schedule_relative("backup", "every 6 hours", backup_function)
        """
        return await self._schedule_job_async(
            self.scheduler_manager.create_relative_job,
            name=name,
            relative_time=relative_time,
            callback=callback,
            callback_args=callback_args,
            **kwargs
        )
    
    async def schedule_absolute(
        self,
        name: str,
        absolute_time: str,
        callback: Union[Callable, str],
        callback_args: Optional[Dict[str, Any]] = None,
        **kwargs
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
            **kwargs
        )
    
    async def schedule_cron(
        self,
        name: str,
        cron_expression: str,
        callback: Union[Callable, str],
        callback_args: Optional[Dict[str, Any]] = None,
        **kwargs
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
            **kwargs
        )
    
    async def _schedule_job_async(self, scheduler_method, callback, **kwargs) -> Optional[str]:
        """Helper to schedule jobs asynchronously"""
        if not self._initialized:
            print("Warning: CronService not initialized. Call initialize() first.")
            return None
        
        try:
            # Parse callback
            callback_module, callback_function = self._parse_callback(callback)
            
            # Call the scheduler manager method directly
            job_id = await scheduler_method(
                callback_module=callback_module,
                callback_function=callback_function,
                **kwargs
            )
            
            return job_id
            
        except Exception as e:
            print(f"Error scheduling job: {e}")
            return None
    
    def _parse_callback(self, callback) -> tuple[str, str]:
        """Parse callback into module and function name"""
        if isinstance(callback, str):
            # String format: "module.function"
            if '.' in callback:
                parts = callback.rsplit('.', 1)
                return parts[0], parts[1]
            else:
                return '__main__', callback
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
    
    def cancel_job(self, job_id: str) -> bool:
        """Cancel a job by ID"""
        if not self._initialized:
            return False
        
        return self._run_async(self.scheduler_manager.delete_job(job_id))
    
    def pause_job(self, job_id: str) -> bool:
        """Pause a job (deactivate without deleting)"""
        if not self._initialized:
            return False
        
        return self._run_async(self.scheduler_manager.deactivate_job(job_id))
    
    def get_job_status(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Get detailed job status"""
        job = self.get_job(job_id)
        if not job:
            return None
        
        return {
            'id': job.id,
            'name': job.name,
            'status': job.status.value,
            'is_active': job.is_active,
            'next_run_time': job.next_run_time.isoformat() if job.next_run_time else None,
            'last_run_time': job.last_run_time.isoformat() if job.last_run_time else None,
            'last_run_result': job.last_run_result,
            'retry_count': job.retry_count,
            'max_retries': job.max_retries,
            'schedule_type': job.schedule_type.value,
            'schedule_value': job.schedule_value
        }
    
    def shutdown(self):
        """Shutdown the cron service"""
        if self.scheduler_manager:
            self.scheduler_manager.stop()
        self._executor.shutdown(wait=True)
        print("Cron service shutdown")
    
    async def schedule_from_text(
        self,
        name: str,
        schedule_text: str,
        callback: Union[Callable, str],
        callback_args: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> Optional[str]:
        """
        Parse natural language text and schedule accordingly.
        
        Args:
            name: Job name
            schedule_text: Natural language like "in 5 minutes", "tomorrow at 3pm", "every day at 9am"
            callback: Function to call or module.function string
            callback_args: Arguments to pass to callback
            **kwargs: Additional job options
            
        Returns:
            Job ID if successful, None otherwise
            
        Examples:
            # Relative scheduling
            await cron.schedule_from_text("reminder", "in 30 minutes", play_reminder)
            await cron.schedule_from_text("backup", "in 2 hours", backup_data)
            await cron.schedule_from_text("check", "every 15 minutes", health_check)
            
            # Absolute scheduling
            await cron.schedule_from_text("meeting", "tomorrow at 3pm", meeting_reminder)
            await cron.schedule_from_text("call", "next monday at 10am", call_reminder)
            
            # Cron-like scheduling
            await cron.schedule_from_text("daily", "every day at 9am", daily_task)
            await cron.schedule_from_text("weekly", "every monday at 8am", weekly_report)
        """
        try:
            # Parse the schedule text to determine type and format
            schedule_type, schedule_value = self._parse_schedule_text(schedule_text)
            
            # Route to appropriate scheduling method
            if schedule_type == ScheduleType.RELATIVE:
                return await self.schedule_relative(
                    name=name,
                    relative_time=schedule_value,
                    callback=callback,
                    callback_args=callback_args,
                    **kwargs
                )
            elif schedule_type == ScheduleType.ABSOLUTE:
                return await self.schedule_absolute(
                    name=name,
                    absolute_time=schedule_value,
                    callback=callback,
                    callback_args=callback_args,
                    **kwargs
                )
            elif schedule_type == ScheduleType.CRON:
                return await self.schedule_cron(
                    name=name,
                    cron_expression=schedule_value,
                    callback=callback,
                    callback_args=callback_args,
                    **kwargs
                )
            else:
                print(f"Could not parse schedule text: {schedule_text}")
                return None
                
        except Exception as e:
            print(f"Error parsing schedule text '{schedule_text}': {e}")
            return None
    
    def _parse_schedule_text(self, text: str) -> tuple[ScheduleType, str]:
        """
        Parse natural language schedule text into type and value.
        
        Returns:
            Tuple of (ScheduleType, schedule_value)
        """
        text = text.lower().strip()
        
        # Relative time patterns
        relative_patterns = [
            # "in X minutes/hours/days"
            r'^in\s+(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days)$',
            # "every X minutes/hours/days"
            r'^every\s+(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days)$',
            # "every minute/hour/day"
            r'^every\s+(second|minute|hour|day)$',
        ]
        
        for pattern in relative_patterns:
            match = re.match(pattern, text)
            if match:
                return ScheduleType.RELATIVE, text
        
        # Cron-like patterns for recurring tasks
        cron_patterns = [
            # "every day at HH:MM"
            (r'^every\s+day\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$', self._convert_daily_to_cron),
            # "every monday/tuesday/etc at HH:MM"
            (r'^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$', self._convert_weekly_to_cron),
            # "every weekday at HH:MM"
            (r'^every\s+weekday\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$', self._convert_weekday_to_cron),
            # "every weekend at HH:MM"
            (r'^every\s+weekend\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$', self._convert_weekend_to_cron),
        ]
        
        for pattern, converter in cron_patterns:
            match = re.match(pattern, text)
            if match:
                cron_expr = converter(match)
                return ScheduleType.CRON, cron_expr
        
        # Absolute time patterns
        absolute_patterns = [
            # "tomorrow at HH:MM"
            r'^tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$',
            # "next monday/tuesday/etc at HH:MM"
            r'^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$',
            # "today at HH:MM"
            r'^today\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$',
            # "YYYY-MM-DD HH:MM" or "DD/MM/YYYY HH:MM"
            r'^(\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}):(\d{2})$',
        ]
        
        for pattern in absolute_patterns:
            match = re.match(pattern, text)
            if match:
                absolute_time = self._convert_to_absolute_time(text, match)
                return ScheduleType.ABSOLUTE, absolute_time
        
        # If nothing matches, try to detect if it's a cron expression
        if self._is_cron_expression(text):
            return ScheduleType.CRON, text
        
        # Default to treating as relative time
        return ScheduleType.RELATIVE, text
    
    def _convert_daily_to_cron(self, match) -> str:
        """Convert 'every day at HH:MM' to cron expression"""
        hour = int(match.group(1))
        minute = int(match.group(2)) if match.group(2) else 0
        am_pm = match.group(3)
        
        if am_pm == 'pm' and hour != 12:
            hour += 12
        elif am_pm == 'am' and hour == 12:
            hour = 0
            
        return f"{minute} {hour} * * *"
    
    def _convert_weekly_to_cron(self, match) -> str:
        """Convert 'every monday at HH:MM' to cron expression"""
        day_map = {
            'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
            'thursday': 4, 'friday': 5, 'saturday': 6
        }
        
        day = day_map[match.group(1)]
        hour = int(match.group(2))
        minute = int(match.group(3)) if match.group(3) else 0
        am_pm = match.group(4)
        
        if am_pm == 'pm' and hour != 12:
            hour += 12
        elif am_pm == 'am' and hour == 12:
            hour = 0
            
        return f"{minute} {hour} * * {day}"
    
    def _convert_weekday_to_cron(self, match) -> str:
        """Convert 'every weekday at HH:MM' to cron expression"""
        hour = int(match.group(1))
        minute = int(match.group(2)) if match.group(2) else 0
        am_pm = match.group(3)
        
        if am_pm == 'pm' and hour != 12:
            hour += 12
        elif am_pm == 'am' and hour == 12:
            hour = 0
            
        return f"{minute} {hour} * * 1-5"  # Monday to Friday
    
    def _convert_weekend_to_cron(self, match) -> str:
        """Convert 'every weekend at HH:MM' to cron expression"""
        hour = int(match.group(1))
        minute = int(match.group(2)) if match.group(2) else 0
        am_pm = match.group(3)
        
        if am_pm == 'pm' and hour != 12:
            hour += 12
        elif am_pm == 'am' and hour == 12:
            hour = 0
            
        return f"{minute} {hour} * * 0,6"  # Sunday and Saturday
    
    def _convert_to_absolute_time(self, text: str, match) -> str:
        """Convert absolute time expressions to datetime string"""
        now = datetime.now()
        
        if text.startswith('today'):
            hour = int(match.group(1))
            minute = int(match.group(2)) if match.group(2) else 0
            am_pm = match.group(3)
            
            if am_pm == 'pm' and hour != 12:
                hour += 12
            elif am_pm == 'am' and hour == 12:
                hour = 0
                
            target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            return target.strftime("%Y-%m-%d %H:%M:%S")
            
        elif text.startswith('tomorrow'):
            hour = int(match.group(1))
            minute = int(match.group(2)) if match.group(2) else 0
            am_pm = match.group(3)
            
            if am_pm == 'pm' and hour != 12:
                hour += 12
            elif am_pm == 'am' and hour == 12:
                hour = 0
                
            target = now + timedelta(days=1)
            target = target.replace(hour=hour, minute=minute, second=0, microsecond=0)
            return target.strftime("%Y-%m-%d %H:%M:%S")
            
        elif text.startswith('next'):
            day_map = {
                'monday': 0, 'tuesday': 1, 'wednesday': 2, 'thursday': 3,
                'friday': 4, 'saturday': 5, 'sunday': 6
            }
            
            target_day = day_map[match.group(1)]
            hour = int(match.group(2))
            minute = int(match.group(3)) if match.group(3) else 0
            am_pm = match.group(4)
            
            if am_pm == 'pm' and hour != 12:
                hour += 12
            elif am_pm == 'am' and hour == 12:
                hour = 0
            
            # Calculate days until next occurrence of target day
            current_day = now.weekday()
            days_ahead = target_day - current_day
            if days_ahead <= 0:  # Target day already happened this week
                days_ahead += 7
                
            target = now + timedelta(days=days_ahead)
            target = target.replace(hour=hour, minute=minute, second=0, microsecond=0)
            return target.strftime("%Y-%m-%d %H:%M:%S")
        
        # For explicit date/time formats, return as-is (validation happens in scheduler)
        return text
    
    def _is_cron_expression(self, text: str) -> bool:
        """Check if text looks like a cron expression"""
        parts = text.split()
        # Basic cron has 5 parts: minute hour day month weekday
        return len(parts) == 5 and all(
            part.replace('*', '').replace('/', '').replace('-', '').replace(',', '').isdigit() or part == '*'
            for part in parts
        )


# Global service instance
_cron_service: Optional[CronService] = None
_service_lock = threading.Lock()


def get_cron_service() -> CronService:
    """Get the global cron service instance"""
    global _cron_service
    
    if _cron_service is None:
        with _service_lock:
            if _cron_service is None:
                _cron_service = CronService()
    
    return _cron_service


# Convenience functions for the main module
def schedule_task(
    name: str,
    when: str,
    callback: Union[Callable, str],
    callback_args: Optional[Dict[str, Any]] = None,
    **kwargs
) -> Optional[str]:
    """
    Main function to schedule a task - automatically detects time format.
    
    Args:
        name: Task name
        when: When to run - supports relative, absolute, or cron formats
        callback: Function to call or module.function string
        callback_args: Arguments to pass to callback
        **kwargs: Additional options
    
    Returns:
        Job ID if successful, None otherwise
    
    Examples:
        # Relative time
        schedule_task("backup", "in 1 hour", backup_function)
        schedule_task("reminder", "every 30 minutes", remind_user)
        
        # Absolute time
        schedule_task("meeting", "2025-05-28 15:00", meeting_alert)
        
        # Cron expression
        schedule_task("daily_task", "0 9 * * *", daily_function)
    """
    service = get_cron_service()
    when = when.lower().strip()
    
    # Detect format and delegate to appropriate method
    if when.startswith(('in ', 'every ')):
        return service.schedule_relative(name, when, callback, callback_args, **kwargs)
    elif any(char in when for char in ['*', '/', '-']) and len(when.split()) == 5:
        # Looks like cron expression (5 parts with cron chars)
        return service.schedule_cron(name, when, callback, callback_args, **kwargs)
    else:
        # Assume absolute time
        return service.schedule_absolute(name, when, callback, callback_args, **kwargs)
