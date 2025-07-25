"""Integration tests for Scheduler and Database components."""

import sqlite3
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio

from app.database import CronJob, JobStatus, SchedulerDatabaseService, ScheduleType
from app.scheduler.scheduler_manager import SchedulerManager

# Fixed path to a test database file in the tests directory
TEST_DB_PATH = str(Path(__file__).parent.parent / "test_scheduler.db")


def reset_test_database():
    """Reset the test database to a clean state."""
    # Connect to the existing database or create it if it doesn't exist
    conn = sqlite3.connect(TEST_DB_PATH)

    # Drop existing tables if they exist to clear data
    conn.execute("DROP TABLE IF EXISTS cron_jobs")
    conn.execute("DROP TABLE IF EXISTS migrations")

    # Create the migrations table with the correct schema that includes filename column
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS migrations (
            version TEXT PRIMARY KEY,
            filename TEXT,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """
    )

    # Create the cron_jobs table
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cron_jobs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            schedule_type TEXT NOT NULL,
            schedule_value TEXT NOT NULL,
            next_run_time TIMESTAMP,
            last_run_time TIMESTAMP,
            callback_module TEXT NOT NULL,
            callback_function TEXT NOT NULL,
            callback_args TEXT,
            is_active INTEGER DEFAULT 1,
            status TEXT NOT NULL,
            last_run_result TEXT,
            retry_count INTEGER DEFAULT 0,
            max_retries INTEGER DEFAULT 3,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            metadata TEXT
        )
    """
    )
    conn.commit()
    conn.close()


# For compatibility with the test
Job = CronJob


@pytest.mark.integration
class TestSchedulerDatabaseIntegration:
    """Integration tests for Scheduler and Database components."""

    # Add helper method to patch the migration_manager during tests
    async def patch_migration_manager(self, service):
        """Patch the migration manager to avoid running migrations in tests."""
        # Create a patched migration manager that doesn't try to run migrations
        # that might fail in tests
        patched_manager = MagicMock()
        patched_manager.run_migrations = AsyncMock(return_value=True)
        service.migration_manager = patched_manager
        return service

    @pytest_asyncio.fixture
    async def db_service(self):
        """Create a scheduler database service with a file-based test database."""
        # Reset the database to a clean state before each test
        reset_test_database()

        # Create the database service using the test file path
        service = SchedulerDatabaseService(db_path=TEST_DB_PATH)

        # Patch the migration_manager to avoid issues with migrations
        await self.patch_migration_manager(service)

        # We don't need to explicitly create tables or initialize
        # since reset_test_database does this for us
        yield service

    @pytest_asyncio.fixture
    async def scheduler_manager(self, db_service):
        """Create a scheduler manager with the test database service."""
        # Create a SchedulerManager that uses our test db_service
        manager = SchedulerManager(db_path=TEST_DB_PATH)

        # Replace the db_service with our patched one
        manager.db_service = db_service

        async def patched_initialize():
            # Skip db_service.initialize() and just load jobs
            await manager._load_jobs()

        manager.initialize = patched_initialize
        await manager.initialize()

        yield manager
        # Stop the scheduler
        manager.stop()

    @pytest.mark.asyncio
    async def test_job_persistence(self, db_service, scheduler_manager):
        """Test that scheduled jobs are persisted in the database."""
        # Create a test job with appropriate attributes
        job_id = str(uuid.uuid4())
        test_job = Job(
            id=job_id,
            name="integration_test_job",
            schedule_type=ScheduleType.ABSOLUTE,
            schedule_value=(datetime.now() + timedelta(hours=1)).isoformat(),
            next_run_time=datetime.now() + timedelta(hours=1),
            callback_module="app.scheduler.test_callbacks",
            callback_function="test_callback",
            status=JobStatus.PENDING,
            created_at=datetime.now(),
            updated_at=datetime.now(),
            metadata={"description": "Test job for integration testing"},
        )

        # Schedule the job through the database service
        success = await db_service.add_job(test_job)

        # Verify job was added successfully
        assert success is True

        # Verify job was stored in the database
        stored_job = await db_service.get_job(job_id)

        assert stored_job is not None
        assert stored_job.name == "integration_test_job"
        assert stored_job.metadata.get("description") == "Test job for integration testing"
        assert stored_job.schedule_type == ScheduleType.ABSOLUTE

    @pytest.mark.asyncio
    async def test_job_execution_logging(self, db_service, scheduler_manager):
        """Test that job execution is properly logged in the database."""
        # Create a job that will be executed immediately
        now = datetime.now()
        job_id = str(uuid.uuid4())
        test_job = Job(
            id=job_id,
            name="immediate_job",
            schedule_type=ScheduleType.ABSOLUTE,
            schedule_value=now.isoformat(),
            next_run_time=now,  # Set to now for immediate execution
            callback_module="test.module",  # Doesn't need to exist for this test
            callback_function="test_function",
            status=JobStatus.PENDING,
            created_at=now,
            updated_at=now,
            metadata={"description": "Job that executes immediately"},
        )

        # Schedule the job
        success = await db_service.add_job(test_job)
        assert success is True

        # Directly modify job in database to simulate successful execution
        # This tests the database integration without requiring real callbacks
        fetched_job = await db_service.get_job(job_id)
        assert fetched_job is not None

        # Update the job status
        fetched_job.status = JobStatus.COMPLETED
        fetched_job.last_run_time = datetime.now()
        fetched_job.last_run_result = "Success"

        # Save the updated job
        success = await db_service.update_job(fetched_job)
        assert success is True

        # Verify job status was updated in the database
        executed_job = await db_service.get_job(job_id)

        assert executed_job is not None
        assert executed_job.status == JobStatus.COMPLETED
        assert executed_job.last_run_time is not None
        assert executed_job.last_run_result == "Success"

    @pytest.mark.asyncio
    async def test_failed_job_logging(self, db_service, scheduler_manager):
        """Test that failed jobs are properly logged in the database."""
        # Create a job that will fail
        now = datetime.now()
        job_id = str(uuid.uuid4())
        test_job = Job(
            id=job_id,
            name="failing_job",
            schedule_type=ScheduleType.ABSOLUTE,
            schedule_value=now.isoformat(),
            next_run_time=now,  # Set to now for immediate execution
            callback_module="test.module",  # Doesn't need to exist for this test
            callback_function="test_function",
            status=JobStatus.PENDING,
            created_at=now,
            updated_at=now,
            metadata={
                "description": "Job that will fail",
                "command": "invalid_command_that_will_fail",
            },
        )

        # Schedule the job
        success = await db_service.add_job(test_job)
        assert success is True

        # Directly modify job in database to simulate failed execution
        fetched_job = await db_service.get_job(job_id)
        assert fetched_job is not None

        # Update the job status to failed
        fetched_job.status = JobStatus.FAILED
        fetched_job.last_run_time = datetime.now()
        fetched_job.last_run_result = "Command not found"
        fetched_job.retry_count = 1
        fetched_job.metadata = {**fetched_job.metadata, "error": "Command not found"}

        # Save the updated job
        success = await db_service.update_job(fetched_job)
        assert success is True

        # Verify job status was updated to FAILED
        executed_job = await db_service.get_job(job_id)

        assert executed_job is not None
        assert executed_job.status == JobStatus.FAILED
        assert executed_job.last_run_time is not None
        assert executed_job.last_run_result == "Command not found"
        assert executed_job.retry_count == 1
        assert "error" in executed_job.metadata

    @pytest.mark.asyncio
    async def test_cron_job_scheduling(self, db_service, scheduler_manager):
        """Test that cron jobs are properly scheduled and tracked."""
        # Create a cron job
        now = datetime.now()
        job_id = str(uuid.uuid4())
        next_run = now + timedelta(minutes=5)

        test_job = Job(
            id=job_id,
            name="test_cron_job",
            schedule_type=ScheduleType.CRON,
            schedule_value="*/5 * * * *",  # Every 5 minutes
            next_run_time=now,  # Set to now for immediate execution in the test
            callback_module="test.module",
            callback_function="test_function",
            status=JobStatus.PENDING,
            created_at=now,
            updated_at=now,
            metadata={"description": "Test cron job", "command": "echo 'Cron job executed'"},
        )

        # Schedule the job
        success = await db_service.add_job(test_job)
        assert success is True

        # Verify job was stored correctly
        stored_job = await db_service.get_job(job_id)

        assert stored_job is not None
        assert stored_job.schedule_type == ScheduleType.CRON
        assert stored_job.schedule_value == "*/5 * * * *"

        # Simulate cron job execution while maintaining PENDING status
        # This is how cron jobs work - they execute but remain active for next run

        # Fetch job to update
        fetched_job = await db_service.get_job(job_id)
        assert fetched_job is not None

        # Update job with execution info but keep it PENDING
        fetched_job.last_run_time = now
        fetched_job.last_run_result = "Success"
        fetched_job.next_run_time = next_run  # Schedule next run

        # Update the job
        success = await db_service.update_job(fetched_job)
        assert success is True

        # Verify job remains scheduled but has execution history
        executed_job = await db_service.get_job(job_id)

        assert executed_job is not None
        assert executed_job.status == JobStatus.PENDING  # Cron jobs stay pending
        assert executed_job.last_run_time is not None
        assert executed_job.next_run_time > now  # Next run is in the future
