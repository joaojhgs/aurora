"""
Main scheduler manager for Aurora cron jobs.
Handles job execution, timing, and persistence using the database module.
"""

import asyncio
import threading
import time
import importlib
import re
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any, Callable
from croniter import croniter
from pathlib import Path

from ..database import SchedulerDatabaseService, CronJob, ScheduleType, JobStatus
from ..helpers.aurora_logger import log_info, log_debug, log_error, log_warning


class SchedulerManager:
    """Main scheduler that manages and executes cron jobs"""
    
    def __init__(self, db_path: str = None):
        self.db_service = SchedulerDatabaseService(db_path)
        self._running = False
        self._thread = None
        self._loop = None
        self._jobs_cache: Dict[str, CronJob] = {}
        self._lock = threading.Lock()
    
    async def initialize(self):
        """Initialize the scheduler database and load jobs"""
        await self.db_service.initialize()
        await self._load_jobs()
        log_info("Scheduler initialization completed")
    
    def start(self):
        """Start the scheduler in a separate thread"""
        if self._running:
            log_info("Scheduler is already running")
            return
        
        self._running = True
        self._thread = threading.Thread(target=self._run_scheduler, daemon=True)
        self._thread.start()
        log_info("Scheduler started in background thread")
    
    def stop(self):
        """Stop the scheduler"""
        if not self._running:
            return
        
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)
        log_info("Scheduler stopped")
    
    def _run_scheduler(self):
        """Main scheduler loop running in separate thread"""
        # Create a new event loop for this thread
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        
        try:
            self._loop.run_until_complete(self._scheduler_loop())
        except Exception as e:
            log_error(f"Scheduler error: {e}")
        finally:
            self._loop.close()
    
    async def _scheduler_loop(self):
        """Main async scheduler loop"""
        while self._running:
            try:
                # Check for jobs that need to run
                ready_jobs = await self.db_service.get_ready_jobs()
                
                for job in ready_jobs:
                    # Execute job in background task
                    asyncio.create_task(self._execute_job(job))
                
                # Sleep for a short interval before checking again
                await asyncio.sleep(1)  # Check every second
                
            except Exception as e:
                log_error(f"Error in scheduler loop: {e}")
                await asyncio.sleep(5)  # Wait longer on errors
    
    async def _load_jobs(self):
        """Load all active jobs from database"""
        try:
            active_jobs = await self.db_service.get_active_jobs()
            
            with self._lock:
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
            if result is not None and result.get('success', True):
                job.update_status(JobStatus.COMPLETED, str(result.get('message', 'Success')))
                
                # Calculate next run time for recurring jobs
                if job.schedule_type in [ScheduleType.RELATIVE, ScheduleType.CRON]:
                    job.next_run_time = self._calculate_next_run_time(job)
                else:
                    # One-time absolute job - deactivate
                    job.is_active = False
                
            else:
                error_msg = result.get('error', 'Unknown error') if result else 'No result returned'
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
        with self._lock:
            if job.is_active:
                self._jobs_cache[job.id] = job
            else:
                self._jobs_cache.pop(job.id, None)
    
    async def _call_job_callback(self, job: CronJob) -> Optional[Dict[str, Any]]:
        """Call the job's callback function"""
        try:
            # Import the module
            module = importlib.import_module(job.callback_module)
            
            # Get the function
            callback_func = getattr(module, job.callback_function)
            
            # Prepare arguments
            args = job.callback_args or {}
            args['job_id'] = job.id
            args['job_name'] = job.name
            
            # Call the function
            if asyncio.iscoroutinefunction(callback_func):
                result = await callback_func(**args)
            else:
                result = callback_func(**args)
            
            return result if isinstance(result, dict) else {'success': True, 'message': str(result)}
            
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    def _calculate_next_run_time(self, job: CronJob) -> Optional[datetime]:
        """Calculate the next run time for a job"""
        try:
            if job.schedule_type == ScheduleType.CRON:
                # Standard cron expression
                cron = croniter(job.schedule_value, datetime.now())
                return cron.get_next(datetime)
            
            elif job.schedule_type == ScheduleType.RELATIVE:
                return self._parse_relative_time(job.schedule_value)
            
            elif job.schedule_type == ScheduleType.ABSOLUTE:
                return self._parse_absolute_time(job.schedule_value)
            
        except Exception as e:
            log_error(f"Error calculating next run time for job {job.name}: {e}")
            return None
    
    def _parse_relative_time(self, relative_time: str) -> Optional[datetime]:
        """Parse relative time expressions like 'in 5 minutes', 'every 1 hour'"""
        relative_time = relative_time.lower().strip()
        
        # Pattern for "in X time" (one-time)
        in_pattern = r'^in\s+(\d+)\s+(second|minute|hour|day)s?$'
        match = re.match(in_pattern, relative_time)
        if match:
            amount = int(match.group(1))
            unit = match.group(2)
            
            if unit == 'second':
                return datetime.now() + timedelta(seconds=amount)
            elif unit == 'minute':
                return datetime.now() + timedelta(minutes=amount)
            elif unit == 'hour':
                return datetime.now() + timedelta(hours=amount)
            elif unit == 'day':
                return datetime.now() + timedelta(days=amount)
        
        # Pattern for "every X time" (recurring)
        every_pattern = r'^every\s+(\d+)\s+(second|minute|hour|day)s?$'
        match = re.match(every_pattern, relative_time)
        if match:
            amount = int(match.group(1))
            unit = match.group(2)
            
            if unit == 'second':
                return datetime.now() + timedelta(seconds=amount)
            elif unit == 'minute':
                return datetime.now() + timedelta(minutes=amount)
            elif unit == 'hour':
                return datetime.now() + timedelta(hours=amount)
            elif unit == 'day':
                return datetime.now() + timedelta(days=amount)
        
        raise ValueError(f"Invalid relative time format: {relative_time}")
    
    def _parse_absolute_time(self, absolute_time: str) -> Optional[datetime]:
        """Parse absolute time expressions like '2025-05-28 15:00'"""
        try:
            # Try various datetime formats
            formats = [
                '%Y-%m-%d %H:%M:%S',
                '%Y-%m-%d %H:%M',
                '%Y-%m-%d',
                '%m/%d/%Y %H:%M:%S',
                '%m/%d/%Y %H:%M',
                '%m/%d/%Y'
            ]
            
            for fmt in formats:
                try:
                    return datetime.strptime(absolute_time, fmt)
                except ValueError:
                    continue
            
            # If no format worked, try parsing ISO format
            return datetime.fromisoformat(absolute_time)
            
        except Exception as e:
            raise ValueError(f"Invalid absolute time format: {absolute_time}")
    
    # Public API methods
    async def create_relative_job(
        self, 
        name: str, 
        relative_time: str,
        callback_module: str,
        callback_function: str,
        callback_args: Optional[Dict[str, Any]] = None
    ) -> Optional[str]:
        """Create a relative time job and return its ID"""
        job = CronJob.create_relative_job(
            name=name,
            relative_time=relative_time,
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args
        )
        
        # Calculate initial next run time
        job.next_run_time = self._calculate_next_run_time(job)
        
        if await self.db_service.add_job(job):
            # Add to cache if active
            if job.is_active:
                with self._lock:
                    self._jobs_cache[job.id] = job
            return job.id
        return None
    
    async def create_absolute_job(
        self,
        name: str,
        absolute_time: str,
        callback_module: str,
        callback_function: str,
        callback_args: Optional[Dict[str, Any]] = None
    ) -> Optional[str]:
        """Create an absolute time job and return its ID"""
        job = CronJob.create_absolute_job(
            name=name,
            absolute_time=absolute_time,
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args
        )
        
        # Calculate initial next run time
        job.next_run_time = self._calculate_next_run_time(job)
        
        if await self.db_service.add_job(job):
            # Add to cache if active
            if job.is_active:
                with self._lock:
                    self._jobs_cache[job.id] = job
            return job.id
        return None
    
    async def create_cron_job(
        self,
        name: str,
        cron_expression: str,
        callback_module: str,
        callback_function: str,
        callback_args: Optional[Dict[str, Any]] = None
    ) -> Optional[str]:
        """Create a cron expression job and return its ID"""
        job = CronJob.create_cron_job(
            name=name,
            cron_expression=cron_expression,
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args
        )
        
        # Calculate initial next run time
        job.next_run_time = self._calculate_next_run_time(job)
        
        if await self.db_service.add_job(job):
            # Add to cache if active
            if job.is_active:
                with self._lock:
                    self._jobs_cache[job.id] = job
            return job.id
        return None
    
    async def get_job(self, job_id: str) -> Optional[CronJob]:
        """Get a job by ID"""
        return await self.db_service.get_job(job_id)
    
    async def get_all_jobs(self) -> List[CronJob]:
        """Get all jobs"""
        return await self.db_service.get_all_jobs()
    
    async def delete_job(self, job_id: str) -> bool:
        """Delete a job"""
        result = await self.db_service.delete_job(job_id)
        if result:
            with self._lock:
                self._jobs_cache.pop(job_id, None)
        return result
    
    async def deactivate_job(self, job_id: str) -> bool:
        """Deactivate a job"""
        result = await self.db_service.deactivate_job(job_id)
        if result:
            with self._lock:
                self._jobs_cache.pop(job_id, None)
        return result
