"""
Unit tests for the Scheduler module.
"""

import uuid
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from app.db.models import CronJob as Job
from app.db.models import JobStatus, ScheduleType
from app.scheduler.scheduler_manager import SchedulerManager


class TestSchedulerManager:
    """Tests for the SchedulerManager class."""

    # Config manager is not needed, scheduler doesn't use it

    @pytest.fixture
    def mock_db_manager(self):
        """Mock the SchedulerDatabaseService."""
        mock = MagicMock()
        # Mock all the async methods we need
        mock.initialize = AsyncMock()
        mock.add_job = AsyncMock(return_value=True)
        mock.update_job = AsyncMock(return_value=True)
        mock.get_job = AsyncMock(return_value=None)
        mock.get_all_jobs = AsyncMock(return_value=[])
        mock.get_active_jobs = AsyncMock(return_value=[])
        mock.get_ready_jobs = AsyncMock(return_value=[])
        mock.delete_job = AsyncMock(return_value=True)
        mock.deactivate_job = AsyncMock(return_value=True)
        mock.get_job_history = AsyncMock(return_value=[])
        mock.cleanup_old_jobs = AsyncMock(return_value=0)
        return mock

    @pytest_asyncio.fixture
    async def scheduler_manager(self, mock_db_manager):
        """Create a SchedulerManager instance with mocked dependencies."""
        manager = SchedulerManager()

        # Mock the database service with our mock
        manager.db_service = mock_db_manager

        # Set running state for testing
        manager._running = True

        # Initialize the manager
        await manager.initialize()
        yield manager

        # Clean up
        manager._running = False

    @pytest.mark.asyncio
    async def test_initialization(self, scheduler_manager, mock_db_manager):
        """Test scheduler manager initialization."""
        assert scheduler_manager._running is True
        # Check the mocks were properly set up
        assert scheduler_manager.db_service == mock_db_manager

    @pytest.mark.asyncio
    async def test_create_cron_job(self, scheduler_manager, mock_db_manager):
        """Test creating a cron job."""
        # Set up mocks
        mock_db_manager.add_job = AsyncMock(return_value=True)

        # Schedule the job using the create_cron_job method
        name = "test_cron_job"
        cron_expression = "0 0 * * *"  # Run at midnight
        callback_module = "test.module"
        callback_function = "test_function"
        callback_args = {"command": "echo 'test'"}

        await scheduler_manager.create_cron_job(
            name=name,
            cron_expression=cron_expression,
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args,
        )

        # Check that the job was added to the database
        assert mock_db_manager.add_job.called

        # Verify the job had all the correct attributes
        called_job = mock_db_manager.add_job.call_args[0][0]
        assert called_job.name == name
        assert called_job.schedule_type == ScheduleType.CRON
        assert called_job.schedule_value == cron_expression
        assert called_job.callback_module == callback_module
        assert called_job.callback_function == callback_function
        assert called_job.callback_args == callback_args

    @pytest.mark.asyncio
    async def test_create_absolute_job(self, scheduler_manager, mock_db_manager):
        """Test creating an absolute time job."""
        # Set execution time 1 hour from now
        execution_time = datetime.now() + timedelta(hours=1)

        # Set up mock
        mock_db_manager.add_job = AsyncMock(return_value=True)

        # Schedule the job using create_absolute_job
        name = "absolute_time_job"
        callback_module = "test.module"
        callback_function = "test_function"
        callback_args = {"command": "echo 'absolute time'"}

        await scheduler_manager.create_absolute_job(
            name=name,
            absolute_time=execution_time.isoformat(),
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args,
        )

        # Check that the job was added to the database
        assert mock_db_manager.add_job.called

        # Verify the job had all the correct attributes
        called_job = mock_db_manager.add_job.call_args[0][0]
        assert called_job.name == name
        assert called_job.schedule_type == ScheduleType.ABSOLUTE
        assert called_job.schedule_value == execution_time.isoformat()
        assert called_job.callback_module == callback_module
        assert called_job.callback_function == callback_function
        assert called_job.callback_args == callback_args

    @pytest.mark.asyncio
    async def test_check_jobs(self, mock_db_manager):
        """Test checking for pending jobs."""
        # Create job objects with the new structure
        now = datetime.now()
        job1_id = "job1"
        job2_id = "job2"

        # Mock ready jobs
        ready_jobs = [
            Job(
                id=job1_id,
                name="test_job_1",
                schedule_type=ScheduleType.CRON,
                schedule_value="0 0 * * *",
                next_run_time=now - timedelta(minutes=5),
                callback_module="test.module",
                callback_function="test_function",
                status=JobStatus.PENDING,
                created_at=now,
                updated_at=now,
                metadata={"command": "echo 'test 1'"},
            ),
            Job(
                id=job2_id,
                name="test_job_2",
                schedule_type=ScheduleType.ABSOLUTE,
                schedule_value=(now - timedelta(minutes=5)).isoformat(),
                next_run_time=now - timedelta(minutes=5),
                callback_module="test.module",
                callback_function="test_function",
                status=JobStatus.PENDING,
                created_at=now,
                updated_at=now,
                metadata={"command": "echo 'test 2'"},
            ),
        ]

        # Set up the mock to return our test jobs
        mock_db_manager.get_ready_jobs = AsyncMock(return_value=ready_jobs)
        mock_db_manager.update_job = AsyncMock(return_value=True)

        # Create the scheduler manager
        with patch("app.scheduler.scheduler_manager.asyncio.create_subprocess_shell") as mock_subprocess:
            # Mock the subprocess creation
            mock_process = MagicMock()
            mock_process.communicate = AsyncMock(return_value=(b"output", b""))
            mock_process.returncode = 0
            mock_subprocess.return_value = mock_process

            # Create and initialize the scheduler manager
            manager = SchedulerManager()
            manager.db_service = mock_db_manager
            manager._running = True
            await manager.initialize()

            # Mock _call_job_callback to call subprocess
            with patch.object(manager, "_call_job_callback", side_effect=lambda job: {"success": True}):
                # Simulate the scheduler loop iteration by executing ready jobs
                for job in ready_jobs:
                    await manager._execute_job(job)

                # Verify that jobs were executed and updated
                assert mock_db_manager.update_job.call_count >= 2

    @pytest.mark.asyncio
    async def test_deactivate_job(self, scheduler_manager, mock_db_manager):
        """Test deactivating a job."""
        job_id = str(uuid.uuid4())

        # Set up mocks
        mock_db_manager.deactivate_job = AsyncMock(return_value=True)

        # Deactivate the job
        result = await scheduler_manager.deactivate_job(job_id)

        # Verify the job was deactivated correctly
        assert result is True
        mock_db_manager.deactivate_job.assert_called_once_with(job_id)

    @pytest.mark.asyncio
    async def test_job_execution_error_handling(self, mock_db_manager):
        """Test error handling during job execution."""
        # Create a job that will fail
        now = datetime.now()
        job_id = "error_job_id"
        failing_job = Job(
            id=job_id,
            name="error_job",
            schedule_type=ScheduleType.ABSOLUTE,
            schedule_value=(now - timedelta(minutes=1)).isoformat(),
            next_run_time=now - timedelta(minutes=1),
            callback_module="test.module",
            callback_function="test_function",
            status=JobStatus.PENDING,
            retry_count=0,
            max_retries=3,
            created_at=now,
            updated_at=now,
            metadata={"command": "invalid_command_that_should_fail"},
        )

        # Add the update_status method to our job
        def update_status(status, result=None):
            failing_job.status = status
            failing_job.last_run_time = datetime.now()
            failing_job.last_run_result = result
            failing_job.updated_at = datetime.now()
            if status == JobStatus.FAILED:
                failing_job.retry_count += 1

        failing_job.update_status = update_status

        # Set up the mock to update the job correctly
        mock_db_manager.update_job = AsyncMock(return_value=True)

        # Create the scheduler manager
        manager = SchedulerManager()
        manager.db_service = mock_db_manager
        manager._running = True
        await manager.initialize()

        # Mock the _call_job_callback method to raise an exception
        with patch.object(manager, "_call_job_callback", side_effect=Exception("Command execution failed")):
            # Execute the failing job
            await manager._execute_job(failing_job)

            # Verify the retry count was incremented
            assert failing_job.retry_count == 1, "Retry count was not incremented"
            assert failing_job.last_run_result is not None, "Last run result was not updated"

            # For jobs with retries available, the status is set back to PENDING for retry
            # When retry_count < max_retries
            assert failing_job.status == JobStatus.PENDING, "Job status was not set to PENDING for retry"

            # Verify the job was passed to update_job method at least once
            assert mock_db_manager.update_job.called, "update_job was not called"
