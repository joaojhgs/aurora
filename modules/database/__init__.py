"""
Aurora Database Module

Provides database functionality for message history persistence and other data storage needs.
Uses aiosqlite for async SQLite operations with migrations support.
"""

from .database_manager import DatabaseManager
from .models import Message, MessageType
from .migration_manager import MigrationManager
from .message_history_service import MessageHistoryService, get_message_history_service

__all__ = [
    'DatabaseManager', 
    'Message', 
    'MessageType', 
    'MigrationManager',
    'MessageHistoryService',
    'get_message_history_service'
]
