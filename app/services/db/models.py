"""
Database models for Aurora message storage and other entities.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any


class MessageType(Enum):
    USER_TEXT = "user_text"
    USER_VOICE = "user_voice"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class ScheduleType(Enum):
    RELATIVE = "relative"
    ABSOLUTE = "absolute"
    CRON = "cron"


class JobStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Message:
    id: str
    content: str
    message_type: MessageType
    timestamp: datetime
    session_id: str | None = None
    metadata: dict[str, Any] | None = None
    source_type: str | None = None

    @classmethod
    def create_user_text_message(cls, content: str, session_id: str | None = None) -> Message:
        return cls(
            id=str(uuid.uuid4()),
            content=content,
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
            session_id=session_id,
            source_type="Text",
        )

    @classmethod
    def create_user_voice_message(cls, content: str, session_id: str | None = None) -> Message:
        return cls(
            id=str(uuid.uuid4()),
            content=content,
            message_type=MessageType.USER_VOICE,
            timestamp=datetime.now(),
            session_id=session_id,
            source_type="STT",
        )

    @classmethod
    def create_assistant_message(cls, content: str, session_id: str | None = None) -> Message:
        return cls(
            id=str(uuid.uuid4()),
            content=content,
            message_type=MessageType.ASSISTANT,
            timestamp=datetime.now(),
            session_id=session_id,
        )

    def to_dict(self) -> dict[str, Any]:
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
    def from_dict(cls, data: dict[str, Any]) -> Message:
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
        return self.message_type in [MessageType.USER_TEXT, MessageType.USER_VOICE]

    def get_ui_source_type(self) -> str | None:
        if self.message_type == MessageType.USER_TEXT:
            return "Text"
        elif self.message_type == MessageType.USER_VOICE:
            return "STT"
        return None


@dataclass
class User:
    id: str
    username: str
    password_hash: str
    role: str = "admin"  # Deprecated — kept for backward compat; use permissions + is_admin
    permissions: list[str] | None = None
    is_admin: bool = False
    created_at: datetime | None = None

    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now()
        if self.permissions is None:
            self.permissions = []

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "username": self.username,
            "password_hash": self.password_hash,
            "role": self.role,
            "permissions": json.dumps(self.permissions),
            "is_admin": self.is_admin,
            "created_at": self.created_at.isoformat()
            if self.created_at
            else datetime.now().isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> User:
        # Parse permissions from JSON string if present
        raw_perms = data.get("permissions", "[]")
        if isinstance(raw_perms, str):
            permissions = json.loads(raw_perms) if raw_perms else []
        elif isinstance(raw_perms, list):
            permissions = raw_perms
        else:
            permissions = []

        return cls(
            id=data["id"],
            username=data["username"],
            password_hash=data["password_hash"],
            role=data.get("role", "admin"),
            permissions=permissions,
            is_admin=bool(data.get("is_admin", False)),
            created_at=datetime.fromisoformat(data["created_at"]) if data.get("created_at") else None,
        )


@dataclass
class Device:
    id: str
    user_id: str
    name: str
    public_key: str | None = None
    is_trusted: bool = False
    last_seen: datetime | None = None
    created_at: datetime | None = None

    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now()
        if self.last_seen is None:
            self.last_seen = datetime.now()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "name": self.name,
            "public_key": self.public_key,
            "is_trusted": self.is_trusted,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
            "created_at": self.created_at.isoformat()
            if self.created_at
            else datetime.now().isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Device:
        return cls(
            id=data["id"],
            user_id=data["user_id"],
            name=data["name"],
            public_key=data["public_key"],
            is_trusted=bool(data["is_trusted"]),
            last_seen=datetime.fromisoformat(data["last_seen"]) if data["last_seen"] else None,
            created_at=datetime.fromisoformat(data["created_at"]),
        )


@dataclass
class Token:
    id: str
    token_hash: str
    prefix: str
    device_id: str | None = None
    user_id: str | None = None
    scopes: list[str] | None = None
    expires_at: datetime | None = None
    created_at: datetime | None = None

    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now()
        if self.scopes is None:
            self.scopes = []

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "device_id": self.device_id,
            "user_id": self.user_id,
            "token_hash": self.token_hash,
            "prefix": self.prefix,
            "scopes": json.dumps(self.scopes),
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "created_at": self.created_at.isoformat()
            if self.created_at
            else datetime.now().isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Token:
        scopes_data = data["scopes"]
        scopes = json.loads(scopes_data) if isinstance(scopes_data, str) else scopes_data or []

        return cls(
            id=data["id"],
            device_id=data["device_id"],
            user_id=data["user_id"],
            token_hash=data["token_hash"],
            prefix=data["prefix"],
            scopes=scopes,
            expires_at=datetime.fromisoformat(data["expires_at"]) if data["expires_at"] else None,
            created_at=datetime.fromisoformat(data["created_at"]),
        )


@dataclass
class CronJob:
    id: str
    name: str
    schedule_type: ScheduleType
    schedule_value: str
    next_run_time: datetime | None
    callback_module: str
    callback_function: str
    callback_args: dict[str, Any] | None = None
    is_active: bool = True
    status: JobStatus = JobStatus.PENDING
    last_run_time: datetime | None = None
    last_run_result: str | None = None
    retry_count: int = 0
    max_retries: int = 3
    created_at: datetime | None = None
    updated_at: datetime | None = None
    metadata: dict[str, Any] | None = None

    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now()
        if self.updated_at is None:
            self.updated_at = datetime.now()

    @classmethod
    def create_absolute_job(
        cls,
        name: str,
        absolute_time: str,
        callback_module: str,
        callback_function: str,
        callback_args: dict[str, Any] | None = None,
        **kwargs,
    ) -> CronJob:
        return cls(
            id=str(uuid.uuid4()),
            name=name,
            schedule_type=ScheduleType.ABSOLUTE,
            schedule_value=absolute_time,
            next_run_time=None,
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
        callback_args: dict[str, Any] | None = None,
        **kwargs,
    ) -> CronJob:
        return cls(
            id=str(uuid.uuid4()),
            name=name,
            schedule_type=ScheduleType.CRON,
            schedule_value=cron_expression,
            next_run_time=None,
            callback_module=callback_module,
            callback_function=callback_function,
            callback_args=callback_args,
            **kwargs,
        )

    def to_dict(self) -> dict[str, Any]:
        callback_args_safe = None
        if self.callback_args:
            try:
                callback_args_safe = json.dumps(self.callback_args)
            except (TypeError, ValueError):
                safe_args = {}
                for k, v in self.callback_args.items():
                    if k in ["bus", "store"]:
                        continue
                    try:
                        json.dumps(v)
                        safe_args[k] = v
                    except (TypeError, ValueError):
                        continue
                callback_args_safe = json.dumps(safe_args) if safe_args else None

        return {
            "id": self.id,
            "name": self.name,
            "schedule_type": self.schedule_type.value,
            "schedule_value": self.schedule_value,
            "next_run_time": self.next_run_time.isoformat() if self.next_run_time else None,
            "callback_module": self.callback_module,
            "callback_function": self.callback_function,
            "callback_args": callback_args_safe,
            "is_active": self.is_active,
            "status": self.status.value,
            "last_run_time": self.last_run_time.isoformat() if self.last_run_time else None,
            "last_run_result": self.last_run_result,
            "retry_count": self.retry_count,
            "max_retries": self.max_retries,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "metadata": json.dumps(self.metadata) if self.metadata else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CronJob:
        return cls(
            id=data["id"],
            name=data["name"],
            schedule_type=ScheduleType(data["schedule_type"]),
            schedule_value=data["schedule_value"],
            next_run_time=(
                datetime.fromisoformat(data["next_run_time"]) if data["next_run_time"] else None
            ),
            callback_module=data["callback_module"],
            callback_function=data["callback_function"],
            callback_args=json.loads(data["callback_args"]) if data["callback_args"] else None,
            is_active=data["is_active"],
            status=JobStatus(data["status"]),
            last_run_time=(
                datetime.fromisoformat(data["last_run_time"]) if data["last_run_time"] else None
            ),
            last_run_result=data["last_run_result"],
            retry_count=data["retry_count"],
            max_retries=data["max_retries"],
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
            metadata=json.loads(data["metadata"]) if data["metadata"] else None,
        )

    def update_status(self, status: JobStatus, result: str | None = None):
        self.status = status
        self.last_run_time = datetime.now()
        self.last_run_result = result
        self.updated_at = datetime.now()

        if status == JobStatus.FAILED:
            self.retry_count += 1

    def can_retry(self) -> bool:
        return self.retry_count < self.max_retries and self.status == JobStatus.FAILED

    def is_ready_to_run(self) -> bool:
        if not self.is_active or not self.next_run_time:
            return False

        return (
            self.status in [JobStatus.PENDING, JobStatus.FAILED]
            and datetime.now() >= self.next_run_time
            and (self.status != JobStatus.FAILED or self.can_retry())
        )
