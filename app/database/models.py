"""
Database models for Aurora message storage and other entities.
"""

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Optional


class MessageType(Enum):
    """Message types supported by the system"""

    USER_TEXT = "user_text"
    USER_VOICE = "user_voice"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class ScheduleType(Enum):
    """Types of scheduling supported"""

    RELATIVE = "relative"  # e.g., "in 5 minutes", "every 1 hour"
    ABSOLUTE = "absolute"  # e.g., "2025-05-28 15:00", cron expressions
    CRON = "cron"  # Standard cron expressions like "0 9 * * 1-5"


class JobStatus(Enum):
    """Job execution status"""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Message:
    """Message model for database storage"""

    id: str
    content: str
    message_type: MessageType
    timestamp: datetime
    session_id: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    source_type: Optional[str] = None  # "Text", "STT", etc.

    @classmethod
    def create_user_text_message(cls, content: str, session_id: Optional[str] = None) -> "Message":
        """Create a new user text message"""
        return cls(
            id=str(uuid.uuid4()),
            content=content,
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
            session_id=session_id,
            source_type="Text",
        )

    @classmethod
    def create_user_voice_message(cls, content: str, session_id: Optional[str] = None) -> "Message":
        """Create a new user voice message"""
        return cls(
            id=str(uuid.uuid4()),
            content=content,
            message_type=MessageType.USER_VOICE,
            timestamp=datetime.now(),
            session_id=session_id,
            source_type="STT",
        )

    @classmethod
    def create_assistant_message(cls, content: str, session_id: Optional[str] = None) -> "Message":
        """Create a new assistant message"""
        return cls(
            id=str(uuid.uuid4()),
            content=content,
            message_type=MessageType.ASSISTANT,
            timestamp=datetime.now(),
            session_id=session_id,
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert message to dictionary for database storage"""
        return {
            "id": self.id,
            "content": self.content,
            "message_type": self.message_type.value,
            "timestamp": self.timestamp.isoformat(),
            "session_id": self.session_id,
            "metadata": self.metadata,
            "source_type": self.source_type,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Message":
        """Create message from dictionary (database row)"""
        return cls(
            id=data["id"],
            content=data["content"],
            message_type=MessageType(data["message_type"]),
            timestamp=datetime.fromisoformat(data["timestamp"]),
            session_id=data["session_id"],
            metadata=data["metadata"],
            source_type=data["source_type"],
        )

    def is_user_message(self) -> bool:
        """Check if this is a user message"""
        return self.message_type in [MessageType.USER_TEXT, MessageType.USER_VOICE]

    def get_ui_source_type(self) -> Optional[str]:
        """Get the source type for UI display"""
        if self.message_type == MessageType.USER_TEXT:
            return "Text"
        elif self.message_type == MessageType.USER_VOICE:
            return "STT"
        return None


@dataclass
class CronJob:
    """Model for cron job storage and execution"""

    id: str
    name: str
    schedule_type: ScheduleType
    schedule_value: str  # The actual schedule (relative time, absolute time, or cron)
    next_run_time: Optional[datetime]
    callback_module: str  # Module path for the callback function
    callback_function: str  # Function name to call
    callback_args: Optional[dict[str, Any]] = None  # Arguments to pass to callback
    is_active: bool = True
    status: JobStatus = JobStatus.PENDING
    last_run_time: Optional[datetime] = None
    last_run_result: Optional[str] = None
    retry_count: int = 0
    max_retries: int = 3
    created_at: datetime = None
    updated_at: datetime = None
    metadata: Optional[dict[str, Any]] = None

    def __post_init__(self):
        """Initialize timestamps if not provided"""
        if self.created_at is None:
            self.created_at = datetime.now()
        if self.updated_at is None:
            self.updated_at = datetime.now()

    @classmethod
    def create_relative_job(
        cls,
        name: str,
        relative_time: str,
        callback_module: str,
        callback_function: str,
        callback_args: Optional[dict[str, Any]] = None,
        **kwargs,
    ) -> "CronJob":
        """Create a relative time job (e.g., 'in 5 minutes', 'every 1 hour')"""
        return cls(
            id=str(uuid.uuid4()),
            name=name,
            schedule_type=ScheduleType.RELATIVE,
            schedule_value=relative_time,
            next_run_time=None,  # Will be calculated by scheduler
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args,
            **kwargs,
        )

    @classmethod
    def create_absolute_job(
        cls,
        name: str,
        absolute_time: str,
        callback_module: str,
        callback_function: str,
        callback_args: Optional[dict[str, Any]] = None,
        **kwargs,
    ) -> "CronJob":
        """Create an absolute time job (e.g., '2025-05-28 15:00')"""
        return cls(
            id=str(uuid.uuid4()),
            name=name,
            schedule_type=ScheduleType.ABSOLUTE,
            schedule_value=absolute_time,
            next_run_time=None,  # Will be parsed by scheduler
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args,
            **kwargs,
        )

    @classmethod
    def create_cron_job(
        cls,
        name: str,
        cron_expression: str,
        callback_module: str,
        callback_function: str,
        callback_args: Optional[dict[str, Any]] = None,
        **kwargs,
    ) -> "CronJob":
        """Create a cron expression job (e.g., '0 9 * * 1-5')"""
        return cls(
            id=str(uuid.uuid4()),
            name=name,
            schedule_type=ScheduleType.CRON,
            schedule_value=cron_expression,
            next_run_time=None,  # Will be calculated by scheduler
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args,
            **kwargs,
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert job to dictionary for database storage"""
        return {
            "id": self.id,
            "name": self.name,
            "schedule_type": self.schedule_type.value,
            "schedule_value": self.schedule_value,
            "next_run_time": self.next_run_time.isoformat() if self.next_run_time else None,
            "callback_module": self.callback_module,
            "callback_function": self.callback_function,
            "callback_args": json.dumps(self.callback_args) if self.callback_args else None,
            "is_active": self.is_active,
            "status": self.status.value,
            "last_run_time": self.last_run_time.isoformat() if self.last_run_time else None,
            "last_run_result": self.last_run_result,
            "retry_count": self.retry_count,
            "max_retries": self.max_retries,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "metadata": json.dumps(self.metadata) if self.metadata else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CronJob":
        """Create job from dictionary (database row)"""
        return cls(
            id=data["id"],
            name=data["name"],
            schedule_type=ScheduleType(data["schedule_type"]),
            schedule_value=data["schedule_value"],
            next_run_time=(datetime.fromisoformat(data["next_run_time"]) if data["next_run_time"] else None),
            callback_module=data["callback_module"],
            callback_function=data["callback_function"],
            callback_args=json.loads(data["callback_args"]) if data["callback_args"] else None,
            is_active=data["is_active"],
            status=JobStatus(data["status"]),
            last_run_time=(datetime.fromisoformat(data["last_run_time"]) if data["last_run_time"] else None),
            last_run_result=data["last_run_result"],
            retry_count=data["retry_count"],
            max_retries=data["max_retries"],
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
            metadata=json.loads(data["metadata"]) if data["metadata"] else None,
        )

    def update_status(self, status: JobStatus, result: Optional[str] = None):
        """Update job status and last run information"""
        self.status = status
        self.last_run_time = datetime.now()
        self.last_run_result = result
        self.updated_at = datetime.now()

        if status == JobStatus.FAILED:
            self.retry_count += 1

    def can_retry(self) -> bool:
        """Check if job can be retried"""
        return self.retry_count < self.max_retries and self.status == JobStatus.FAILED

    def is_ready_to_run(self) -> bool:
        """Check if job is ready to run"""
        if not self.is_active or not self.next_run_time:
            return False

        return (
            self.status in [JobStatus.PENDING, JobStatus.FAILED]
            and datetime.now() >= self.next_run_time
            and (self.status != JobStatus.FAILED or self.can_retry())
        )



