"""
Aurora Database Module

Provides database functionality for message history persistence and scheduler data storage.
Uses aiosqlite for async SQLite operations with migrations support.
"""

from .database_manager import DatabaseManager
from .models import Message, MessageType, CronJob, ScheduleType, JobStatus
from .migration_manager import MigrationManager
from .message_history_service import MessageHistoryService, get_message_history_service
from .scheduler_service import SchedulerDatabaseService

__all__ = [
    'DatabaseManager', 
    'Message', 
    'MessageType',
    'CronJob',
    'ScheduleType', 
    'JobStatus',
    'MigrationManager',
    'MessageHistoryService',
    'get_message_history_service',
    'SchedulerDatabaseService'
]
