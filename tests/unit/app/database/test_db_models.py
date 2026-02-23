"""
Unit tests for the database models.
"""

import uuid
from datetime import datetime

from app.services.db.models import MeshCredential, Message, MessageType
from app.services.scheduler.models import CronJob, JobStatus, ScheduleType


class TestModels:
    """Tests for the database model classes."""

    def test_message_creation(self):
        """Test creating a Message object."""
        message_id = str(uuid.uuid4())
        timestamp = datetime.now()
        message = Message(
            id=message_id,
            content="Test content",
            message_type=MessageType.USER_TEXT,
            timestamp=timestamp,
            metadata={"test": True},
        )

        assert message.content == "Test content"
        assert message.id == message_id
        assert message.message_type == MessageType.USER_TEXT
        assert message.metadata == {"test": True}
        assert message.timestamp == timestamp

    def test_message_to_dict(self):
        """Test converting a Message to a dictionary."""
        message_id = str(uuid.uuid4())
        timestamp = datetime.now()
        message = Message(
            id=message_id,
            content="Test content",
            message_type=MessageType.USER_TEXT,
            timestamp=timestamp,
            metadata={"test": True},
        )

        message_dict = message.to_dict()

        assert message_dict["id"] == message_id
        assert message_dict["content"] == "Test content"
        assert message_dict["message_type"] == MessageType.USER_TEXT.value
        assert message_dict["timestamp"] == timestamp.isoformat()
        assert message_dict["metadata"] == {"test": True}

    def test_message_from_dict(self):
        """Test creating a Message from a dictionary."""
        message_id = str(uuid.uuid4())
        timestamp = datetime.now()
        data = {
            "id": message_id,
            "content": "Test content",
            "message_type": MessageType.USER_TEXT.value,
            "timestamp": timestamp.isoformat(),
            "metadata": {"test": True},
            "session_id": None,
            "source_type": None,
        }

        message = Message.from_dict(data)

        assert message.id == message_id
        assert message.content == "Test content"
        assert message.message_type == MessageType.USER_TEXT
        assert message.timestamp.isoformat() == timestamp.isoformat()
        assert message.metadata == {"test": True}

    def test_message_type_enum(self):
        """Test the MessageType enum values."""
        assert MessageType.USER_TEXT.value == "user_text"
        assert MessageType.USER_VOICE.value == "user_voice"
        assert MessageType.ASSISTANT.value == "assistant"
        assert MessageType.SYSTEM.value == "system"

    def test_message_factory_methods(self):
        """Test message factory methods."""
        # Test create_user_text_message
        user_text = Message.create_user_text_message("Hello")
        assert user_text.content == "Hello"
        assert user_text.message_type == MessageType.USER_TEXT
        assert user_text.source_type == "Text"

        # Test create_user_voice_message
        user_voice = Message.create_user_voice_message("Hello")
        assert user_voice.content == "Hello"
        assert user_voice.message_type == MessageType.USER_VOICE
        assert user_voice.source_type == "STT"

        # Test create_assistant_message
        assistant = Message.create_assistant_message("Hello back")
        assert assistant.content == "Hello back"
        assert assistant.message_type == MessageType.ASSISTANT

    def test_is_user_message(self):
        """Test is_user_message helper method."""
        user_text = Message.create_user_text_message("Hello")
        assert user_text.is_user_message()

        assistant = Message.create_assistant_message("Hello back")
        assert assistant.is_user_message() is False

    def test_cron_job_creation(self):
        """Test creating a CronJob object."""
        job_id = str(uuid.uuid4())
        now = datetime.now()
        job = CronJob(
            id=job_id,
            name="Test Job",
            schedule_type=ScheduleType.CRON,
            schedule_value="0 0 * * *",  # Daily at midnight
            next_run_time=now,
            callback_module="test.module",
            callback_function="test_function",
            callback_args={"param": "value"},
            is_active=True,
            status=JobStatus.PENDING,
            metadata={"test": True},
        )

        assert job.id == job_id
        assert job.name == "Test Job"
        assert job.schedule_type == ScheduleType.CRON
        assert job.schedule_value == "0 0 * * *"
        assert job.next_run_time == now
        assert job.callback_module == "test.module"
        assert job.callback_function == "test_function"
        assert job.callback_args == {"param": "value"}
        assert job.is_active
        assert job.status == JobStatus.PENDING
        assert job.metadata == {"test": True}

    def test_schedule_type_enum(self):
        """Test the ScheduleType enum values."""
        assert ScheduleType.RELATIVE.value == "relative"
        assert ScheduleType.ABSOLUTE.value == "absolute"
        assert ScheduleType.CRON.value == "cron"

    def test_job_status_enum(self):
        """Test the JobStatus enum values."""
        assert JobStatus.PENDING.value == "pending"
        assert JobStatus.RUNNING.value == "running"
        assert JobStatus.COMPLETED.value == "completed"
        assert JobStatus.FAILED.value == "failed"
        assert JobStatus.CANCELLED.value == "cancelled"

    def test_mesh_credential_creation(self):
        """Test creating a MeshCredential object."""
        cred_id = str(uuid.uuid4())
        cred = MeshCredential(
            id=cred_id,
            room_name="test-room",
            token="plaintext-token",
            remote_device_id="dev-1",
            remote_user_id="user-1",
        )
        assert cred.id == cred_id
        assert cred.room_name == "test-room"
        assert cred.token == "plaintext-token"
        assert cred.remote_device_id == "dev-1"
        assert cred.remote_user_id == "user-1"
        assert cred.created_at is not None
        assert cred.updated_at is not None

    def test_mesh_credential_to_dict(self):
        """Test converting a MeshCredential to dict."""
        cred = MeshCredential(
            id="cred-1",
            room_name="room-1",
            token="tok-abc",
        )
        d = cred.to_dict()
        assert d["id"] == "cred-1"
        assert d["room_name"] == "room-1"
        assert d["token"] == "tok-abc"
        assert d["remote_device_id"] is None
        assert "created_at" in d
        assert "updated_at" in d

    def test_mesh_credential_from_dict(self):
        """Test creating a MeshCredential from dict."""
        now = datetime.now()
        data = {
            "id": "cred-2",
            "room_name": "room-2",
            "token": "tok-xyz",
            "remote_device_id": "dev-2",
            "remote_user_id": "usr-2",
            "created_at": now.isoformat(),
            "updated_at": now.isoformat(),
        }
        cred = MeshCredential.from_dict(data)
        assert cred.id == "cred-2"
        assert cred.room_name == "room-2"
        assert cred.token == "tok-xyz"
        assert cred.remote_device_id == "dev-2"
        assert cred.remote_user_id == "usr-2"
