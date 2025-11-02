# Aurora Scheduler Module

The Aurora Scheduler Module provides a comprehensive cron job system that integrates with the database module for persistence. It supports absolute time scheduling and standard cron expressions.

## Features

- **Multiple Schedule Types**: Absolute time ("2025-05-28 15:00" or "DD/MM/YYYY HH:MM") and cron expressions ("0 9 * * 1-5")
- **Database Integration**: All job data is persisted using the database module
- **Main Event Loop Execution**: Runs in the main event loop for better integration
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

# Schedule a task using cron expression (recurring)
job_id = await cron.schedule_from_text(
    name="Daily Cleanup",
    schedule_text="0 2 * * *",  # Daily at 2 AM
    callback="my_module.cleanup_function",
    callback_args={"days_to_keep": 7}
)

# Schedule a task using absolute time (one-time)
job_id = await cron.schedule_from_text(
    name="Meeting Reminder",
    schedule_text="2025-10-31 15:30",
    callback="my_module.send_reminder",
    callback_args={"message": "Team meeting starts now"}
)
```

### Using the SchedulerManager Directly

```python
from app.scheduler import SchedulerManager

scheduler = SchedulerManager()
await scheduler.initialize()
await scheduler.start()

# Create an absolute time job (one-time execution)
job_id = await scheduler.create_absolute_job(
    name="Scheduled Report",
    absolute_time="2025-05-28 09:00:00",
    callback_module="my_callbacks",
    callback_function="generate_report"
)

# Create a cron job (recurring)
job_id = await scheduler.create_cron_job(
    name="Weekly Backup",
    cron_expression="0 2 * * 0",  # Every Sunday at 2 AM
    callback_module="my_callbacks",
    callback_function="backup_data"
)
```

## Schedule Formats

### Absolute Time (One-time Execution)
- `"2025-05-28 15:30:00"` - ISO format with time
- `"2025-12-25 09:00"` - ISO format without seconds
- `"31/10/2025 14:00"` - DD/MM/YYYY format (Portuguese/Brazilian)
- `"05/28/2025 15:30"` - MM/DD/YYYY format (US)

### Cron Expressions (Recurring)
Standard 5-field cron format: `minute hour day month weekday`
- `"0 9 * * *"` - Daily at 9 AM
- `"0 9 * * 1-5"` - Weekdays (Mon-Fri) at 9 AM
- `"30 14 * * *"` - Every day at 2:30 PM
- `"0 0 1 * *"` - First day of every month at midnight
- `"*/15 * * * *"` - Every 15 minutes
- `"0 */2 * * *"` - Every 2 hours
- `"0 8 * * 1"` - Every Monday at 8 AM

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

The scheduler runs in the main event loop and is thread-safe:
- Uses async/await for all operations
- Async database operations are handled safely
- Multiple jobs can execute concurrently

## Example Use Cases

1. **Data Cleanup**: `"0 2 * * *"` - Daily cleanup at 2 AM
2. **Reports**: `"0 9 * * 1"` - Weekly reports every Monday at 9 AM
3. **Backups**: `"0 2 * * *"` - Daily backups at 2 AM
4. **Reminders**: `"2025-10-31 15:30"` - One-time reminder notifications
5. **Health Checks**: `"*/5 * * * *"` - System monitoring every 5 minutes

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
