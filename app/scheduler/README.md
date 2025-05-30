# Aurora Scheduler Module

The Aurora Scheduler Module provides a comprehensive cron job system that integrates with the database module for persistence. It supports relative time scheduling, absolute time scheduling, and standard cron expressions.

## Features

- **Multiple Schedule Types**: Relative time ("in 5 minutes", "every 1 hour"), absolute time ("2025-05-28 15:00"), and cron expressions ("0 9 * * 1-5")
- **Database Integration**: All job data is persisted using the database module
- **Separate Thread Execution**: Runs in its own thread to avoid blocking the main application
- **Retry Logic**: Failed jobs can be automatically retried with exponential backoff
- **Flexible Callbacks**: Support for both synchronous and asynchronous callback functions
- **High-level Service**: Easy-to-use `CronService` for common scheduling tasks

## Quick Start

### Using the High-Level CronService

```python
from app.scheduler import CronService, get_cron_service

# Get the singleton service
cron = get_cron_service()
await cron.initialize()

# Schedule a simple task
job_id = cron.schedule_relative(
    name="Daily Cleanup",
    relative_time="every 24 hours",
    callback="my_module.cleanup_function",
    callback_args={"days_to_keep": 7}
)
```

### Using the SchedulerManager Directly

```python
from app.scheduler import SchedulerManager

scheduler = SchedulerManager()
await scheduler.initialize()
scheduler.start()

# Create a relative time job
job_id = await scheduler.create_relative_job(
    name="Reminder Task",
    relative_time="in 30 minutes",
    callback_module="my_callbacks",
    callback_function="send_reminder",
    callback_args={"message": "Don't forget!"}
)

# Create an absolute time job
job_id = await scheduler.create_absolute_job(
    name="Scheduled Report",
    absolute_time="2025-05-28 09:00:00",
    callback_module="my_callbacks",
    callback_function="generate_report"
)

# Create a cron job
job_id = await scheduler.create_cron_job(
    name="Weekly Backup",
    cron_expression="0 2 * * 0",  # Every Sunday at 2 AM
    callback_module="my_callbacks",
    callback_function="backup_data"
)
```

## Schedule Formats

### Relative Time
- **One-time**: `"in 5 minutes"`, `"in 2 hours"`, `"in 1 day"`
- **Recurring**: `"every 30 seconds"`, `"every 1 hour"`, `"every 7 days"`

### Absolute Time
- `"2025-05-28 15:30:00"`
- `"2025-12-25 09:00"`
- `"05/28/2025 15:30"`

### Cron Expressions
Standard 5-field cron format: `minute hour day month weekday`
- `"0 9 * * 1-5"` - Weekdays at 9 AM
- `"30 14 * * *"` - Every day at 2:30 PM
- `"0 0 1 * *"` - First day of every month at midnight

## Callback Functions

Callback functions can be synchronous or asynchronous and should return a dictionary with status information:

```python
def my_task(**kwargs):
    job_id = kwargs.get('job_id')
    job_name = kwargs.get('job_name')
    
    # Your task logic here
    
    return {
        'success': True,
        'message': 'Task completed successfully'
    }

async def my_async_task(**kwargs):
    # Async task logic
    await some_async_operation()
    
    return {
        'success': True,
        'message': 'Async task completed'
    }
```

For failed tasks, return:
```python
return {
    'success': False,
    'error': 'Description of what went wrong'
}
```

## Job Management

```python
# Get all jobs
jobs = await scheduler.get_all_jobs()

# Get a specific job
job = await scheduler.get_job(job_id)

# Deactivate a job (stops future executions)
await scheduler.deactivate_job(job_id)

# Delete a job completely
await scheduler.delete_job(job_id)
```

## Error Handling and Retries

The scheduler automatically handles:
- **Failed Jobs**: Jobs that return `success: False` or raise exceptions
- **Retry Logic**: Failed jobs are retried with 5-minute intervals
- **Max Retries**: By default, jobs are retried up to 3 times
- **Deactivation**: Jobs that exceed max retries are automatically deactivated

## Database Integration

All scheduler data is stored in the main Aurora database using the database module:
- Job definitions and metadata
- Execution history and results
- Status tracking and retry counts
- Automatic migrations for schema updates

## Thread Safety

The scheduler runs in its own daemon thread and is thread-safe:
- Uses proper locking for cache operations
- Async database operations are handled safely
- Multiple jobs can execute concurrently

## Example Use Cases

1. **Data Cleanup**: `"every 24 hours"` - Clean old files and logs
2. **Reports**: `"0 9 * * 1"` - Weekly reports every Monday at 9 AM
3. **Backups**: `"0 2 * * *"` - Daily backups at 2 AM
4. **Reminders**: `"in 30 minutes"` - One-time reminder notifications
5. **Health Checks**: `"every 5 minutes"` - System monitoring tasks

## Dependencies

The scheduler module requires:
- `croniter` - For parsing cron expressions
- Database module - For persistence
- `asyncio` - For async support
- `threading` - For background execution

Install with:
```bash
pip install croniter
```
