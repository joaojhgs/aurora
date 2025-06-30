"""
Unit tests for the scheduler models.
"""

import uuid
from datetime import datetime, timedelta

import pytest

from app.scheduler.models import CronJob, JobStatus, ScheduleType


@pytest.mark.unit
class TestSchedulerModels:
    """Tests for the scheduler model classes and enums."""

    def test_schedule_type_enum(self):
        """Test the ScheduleType enum."""
        # Verify enum values
        assert ScheduleType.ABSOLUTE.value == "absolute"
        assert ScheduleType.CRON.value == "cron"
        assert ScheduleType.RELATIVE.value == "relative"

        # Convert from string
        assert ScheduleType("absolute") == ScheduleType.ABSOLUTE
        assert ScheduleType("cron") == ScheduleType.CRON
        assert ScheduleType("relative") == ScheduleType.RELATIVE

    def test_job_status_enum(self):
        """Test the JobStatus enum."""
        # Verify enum values
        assert JobStatus.PENDING.value == "pending"
        assert JobStatus.RUNNING.value == "running"
        assert JobStatus.COMPLETED.value == "completed"
        assert JobStatus.FAILED.value == "failed"
        assert JobStatus.CANCELLED.value == "cancelled"

        # Convert from string
        assert JobStatus("pending") == JobStatus.PENDING
        assert JobStatus("running") == JobStatus.RUNNING
        assert JobStatus("completed") == JobStatus.COMPLETED
        assert JobStatus("failed") == JobStatus.FAILED
        assert JobStatus("cancelled") == JobStatus.CANCELLED

    def test_cron_job_creation(self):
        """Test creating a CronJob instance."""
        job_id = str(uuid.uuid4())
        now = datetime.now()

        # Create a cron job with minimal required fields
        cron_job = CronJob(
            id=job_id,
            name="test_cron_job",
            schedule_type=ScheduleType.CRON,
            schedule_value="0 9 * * *",  # 9 AM daily
            next_run_time=now + timedelta(days=1),
            callback_module="test_module",
            callback_function="test_function",
        )

        # Verify job attributes
        assert cron_job.id == job_id
        assert cron_job.name == "test_cron_job"
        assert cron_job.schedule_type == ScheduleType.CRON
        assert cron_job.schedule_value == "0 9 * * *"
        assert cron_job.callback_module == "test_module"
        assert cron_job.callback_function == "test_function"
        assert cron_job.status == JobStatus.PENDING  # Default status

    def test_cron_job_with_args(self):
        """Test creating a CronJob with arguments."""
        job_id = str(uuid.uuid4())
        now = datetime.now()

        # Test with callback args
        cron_job_with_args = CronJob(
            id=str(uuid.uuid4()),
            name="test_cron_job_with_args",
            schedule_type=ScheduleType.RELATIVE,
            schedule_value="600",  # 10 minutes
            next_run_time=now + timedelta(minutes=10),
            callback_module="test_module",
            callback_function="test_function",
            callback_args={"arg1": "value1", "arg2": "value2"},
        )

        # Verify callback args
        assert cron_job_with_args.callback_args == {"arg1": "value1", "arg2": "value2"}

    def test_cron_job_with_all_fields(self):
        """Test creating a CronJob with all fields."""
        job_id = str(uuid.uuid4())
        now = datetime.now()

        # Create a cron job with all fields
        cron_job = CronJob(
            id=job_id,
            name="test_cron_job_complete",
            schedule_type=ScheduleType.CRON,
            schedule_value="0 * * * *",  # Every hour
            next_run_time=now + timedelta(hours=1),
            callback_module="test_module",
            callback_function="test_function",
            callback_args={"param": "value"},
            is_active=True,
            status=JobStatus.RUNNING,
            last_run_time=now - timedelta(hours=1),
            last_run_result="Success",
            retry_count=1,
            max_retries=3,
            created_at=now,
            updated_at=now,
            metadata={"test": True},
        )

        # Verify all fields
        assert cron_job.status == JobStatus.RUNNING
        assert cron_job.last_run_time == now - timedelta(hours=1)
        assert cron_job.last_run_result == "Success"
        assert cron_job.retry_count == 1
        assert cron_job.max_retries == 3
        assert cron_job.metadata == {"test": True}
