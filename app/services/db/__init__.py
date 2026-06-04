"""Database service module for Aurora.

This module handles all database operations including:
- Message storage and retrieval
- Conversation history
- Vector search
- Database management
- Scheduler job persistence
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.services.db.manager import DatabaseManager
from app.services.db.models import CronJob, JobStatus, Message, ScheduleType
from app.services.db.scheduler_db_service import SchedulerDatabaseService

if TYPE_CHECKING:
    from app.services.db.service import DBService

__all__ = [
    "DBService",
    "DatabaseManager",
    "Message",
    "CronJob",
    "JobStatus",
    "ScheduleType",
    "SchedulerDatabaseService",
]


def __getattr__(name: str):
    """Lazy-load DBService so imports of scheduler_db_service avoid RAG/langchain stack."""
    if name == "DBService":
        from app.services.db.service import DBService as _DBService

        return _DBService
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
