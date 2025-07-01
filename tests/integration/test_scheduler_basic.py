"""
Integration tests for Scheduler components.
"""

import uuid
from datetime import datetime, timedelta
from unittest.mock import MagicMock

import pytest
import pytest_asyncio

from app.scheduler.models import CronJob, JobStatus, ScheduleType


class MockDatabase:
    """Mock database for scheduler tests."""

    def __init__(self):
        self.jobs = {}

    async def store_job(self, job):
        """Store a job in the mock database."""
        self.jobs[job.id] = job
        return True

    async def get_job_by_id(self, job_id):
        """Get a job by ID from the mock database."""
        return self.jobs.get(job_id)

    async def update_job(self, job):
        """Update a job in the mock database."""
        if job.id in self.jobs:
            self.jobs[job.id] = job
            return True
        return False

    async def list_jobs(self, limit=100):
        """List all jobs in the mock database."""
        return list(self.jobs.values())

    async def delete_job(self, job_id):
        """Delete a job from the mock database."""
        if job_id in self.jobs:
            del self.jobs[job_id]
            return True
        return False


@pytest.mark.integration
class TestSchedulerBasic:
    """Basic integration tests for Scheduler components."""

    @pytest_asyncio.fixture
    async def mock_db_manager(self):
        """Create a mock database manager."""
        db = MockDatabase()
        yield db

    @pytest.fixture
    def mock_config_manager(self):
        """Create a mock config manager."""
        config = MagicMock()
        config.get.return_value = {"scheduler": {"enabled": True}}
        return config

    def test_scheduler_models(self):
        """Test creation and handling of scheduler model objects."""
        # Create a test job
        job_id = str(uuid.uuid4())
        now = datetime.now()

        job = CronJob(
            id=job_id,
            name="test_job",
            schedule_type=ScheduleType.ABSOLUTE,
            schedule_value=(now + timedelta(minutes=30)).isoformat(),
            next_run_time=now + timedelta(minutes=30),
            callback_module="test_module",
            callback_function="test_function",
        )

        # Verify job properties
        assert job.id == job_id
        assert job.name == "test_job"
        assert job.schedule_type == ScheduleType.ABSOLUTE
        assert job.status == JobStatus.PENDING
        assert job.next_run_time > now

        # Test JobStatus enum
        assert JobStatus.PENDING.value == "pending"
        assert JobStatus.COMPLETED.value == "completed"
        assert JobStatus.FAILED.value == "failed"

        # Test ScheduleType enum
        assert ScheduleType.ABSOLUTE.value == "absolute"
        assert ScheduleType.CRON.value == "cron"
        assert ScheduleType.RELATIVE.value == "relative"

    @pytest.mark.asyncio
    async def test_job_crud_operations(self, mock_db_manager):
        """Test CRUD operations for jobs."""
        # Create a test job
        job_id = str(uuid.uuid4())
        now = datetime.now()

        job = CronJob(
            id=job_id,
            name="crud_test_job",
            schedule_type=ScheduleType.ABSOLUTE,
            schedule_value=(now + timedelta(minutes=30)).isoformat(),
            next_run_time=now + timedelta(minutes=30),
            callback_module="test_module",
            callback_function="test_function",
        )

        # Create (store) job
        await mock_db_manager.store_job(job)

        # Read job
        retrieved_job = await mock_db_manager.get_job_by_id(job_id)
        assert retrieved_job is not None
        assert retrieved_job.id == job_id
        assert retrieved_job.name == "crud_test_job"

        # Update job
        retrieved_job.status = JobStatus.RUNNING
        await mock_db_manager.update_job(retrieved_job)

        # Verify update
        updated_job = await mock_db_manager.get_job_by_id(job_id)
        assert updated_job.status == JobStatus.RUNNING

        # List jobs
        job_list = await mock_db_manager.list_jobs()
        assert len(job_list) == 1
        assert job_list[0].id == job_id

        # Delete job
        result = await mock_db_manager.delete_job(job_id)
        assert result is True

        # Verify deletion
        deleted_job = await mock_db_manager.get_job_by_id(job_id)
        assert deleted_job is None
