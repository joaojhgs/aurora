"""
Unit tests for the scheduler models.
"""

import uuid
from datetime import datetime, timedelta

import pytest
from pydantic import TypeAdapter, ValidationError

from app.services.scheduler.models import CronJob, JobStatus, ScheduleType
from app.shared.contracts.models.scheduler import (
    SchedulerActionSpec,
    SchedulerToolBinding,
    SchedulerToolExecuteAction,
)
from app.shared.models.db import (
    CronJob as SharedCronJob,
    ScheduleType as SharedScheduleType,
)


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

    def test_scheduler_action_spec_rejects_unknown_kind(self):
        """Typed scheduler actions reject unsupported discriminators."""
        with pytest.raises(ValidationError):
            TypeAdapter(SchedulerActionSpec).validate_python(
                {"kind": "python.import", "callback": "app.bad.run"}
            )

    def test_cron_job_typed_action_round_trips_without_executable_callback(self):
        """Typed jobs preserve action JSON while using only the sentinel legacy callback."""
        now = datetime.now()
        action = SchedulerToolExecuteAction(
            binding=SchedulerToolBinding(
                tool_name="switch_on",
                local_tool_name="switch_on",
                global_tool_id="local:local_Tooling:tool:switch_on",
            ),
            arguments={"target": "lamp"},
        ).model_dump(mode="json")
        cron_job = SharedCronJob(
            id=str(uuid.uuid4()),
            name="typed tool",
            schedule_type=SharedScheduleType.CRON,
            schedule_value="*/5 * * * *",
            next_run_time=now + timedelta(minutes=5),
            callback_module="__typed_action__",
            callback_function="execute_action_spec",
            action_kind="tooling.execute",
            action_spec=action,
            prepared_binding=action["binding"],
            created_at=now,
            updated_at=now,
        )

        data = cron_job.to_dict()
        round_tripped = SharedCronJob.from_dict(data)

        assert data["callback_module"] == "__typed_action__"
        assert data["callback_function"] == "execute_action_spec"
        assert not data["callback_module"].startswith("app.")
        assert round_tripped.action_kind == "tooling.execute"
        assert round_tripped.action_spec == action
        assert round_tripped.prepared_binding == action["binding"]
