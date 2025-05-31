"""
Message History Service for Aurora UI integration.
Handles message persistence and retrieval for the UI.
"""

import asyncio
import uuid
from datetime import datetime, date
from typing import List, Optional, Callable
from concurrent.futures import ThreadPoolExecutor

from app.helpers.aurora_logger import log_info, log_debug, log_error

from .database_manager import DatabaseManager
from .models import Message, MessageType


class MessageHistoryService:
    """Service for managing message history with UI integration"""
    
    def __init__(self, db_manager: DatabaseManager = None):
        self.db_manager = db_manager or DatabaseManager()
        self._initialized = False
        self._current_session_id = str(uuid.uuid4())
        self._executor = ThreadPoolExecutor(max_workers=2)
    
    async def initialize(self):
        """Initialize the service and database"""
        if not self._initialized:
            await self.db_manager.initialize()
            self._initialized = True
            log_info(f"Message history service initialized with session: {self._current_session_id}")
    
    def _run_async(self, coro):
        """Run async function in executor for UI thread compatibility"""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # We're in an existing event loop, run in executor
                future = asyncio.run_coroutine_threadsafe(coro, loop)
                return future.result(timeout=5.0)
            else:
                # No event loop running, run directly
                return loop.run_until_complete(coro)
        except Exception as e:
            log_error(f"Error running async operation: {e}")
            return None
    
    def store_user_text_message(self, content: str) -> Optional[Message]:
        """Store a user text message synchronously for UI use"""
        async def _store():
            if not self._initialized:
                await self.initialize()
            
            message = Message.create_user_text_message(content, self._current_session_id)
            success = await self.db_manager.store_message(message)
            return message if success else None
        
        return self._run_async(_store())
    
    def store_user_voice_message(self, content: str) -> Optional[Message]:
        """Store a user voice message synchronously for UI use"""
        async def _store():
            if not self._initialized:
                await self.initialize()
            
            message = Message.create_user_voice_message(content, self._current_session_id)
            success = await self.db_manager.store_message(message)
            return message if success else None
        
        return self._run_async(_store())
    
    def store_assistant_message(self, content: str) -> Optional[Message]:
        """Store an assistant message synchronously for UI use"""
        async def _store():
            if not self._initialized:
                await self.initialize()
            
            message = Message.create_assistant_message(content, self._current_session_id)
            success = await self.db_manager.store_message(message)
            return message if success else None
        
        return self._run_async(_store())
    
    def get_today_messages(self) -> List[Message]:
        """Get all messages for today synchronously for UI use"""
        async def _get():
            if not self._initialized:
                await self.initialize()
            return await self.db_manager.get_messages_for_date()
        
        result = self._run_async(_get())
        return result if result is not None else []
    
    def get_messages_for_date(self, target_date: date) -> List[Message]:
        """Get all messages for a specific date synchronously for UI use"""
        async def _get():
            if not self._initialized:
                await self.initialize()
            return await self.db_manager.get_messages_for_date(target_date)
        
        result = self._run_async(_get())
        return result if result is not None else []
    
    def get_recent_messages(self, limit: int = 50) -> List[Message]:
        """Get recent messages synchronously for UI use"""
        async def _get():
            if not self._initialized:
                await self.initialize()
            return await self.db_manager.get_recent_messages(limit)
        
        result = self._run_async(_get())
        return result if result is not None else []
    
    def get_today_message_count(self) -> int:
        """Get count of today's messages"""
        async def _count():
            if not self._initialized:
                await self.initialize()
            return await self.db_manager.get_message_count_for_date()
        
        result = self._run_async(_count())
        return result if result is not None else 0
    
    def start_new_session(self) -> str:
        """Start a new session and return the session ID"""
        self._current_session_id = str(uuid.uuid4())
        log_info(f"Started new message session: {self._current_session_id}")
        return self._current_session_id
    
    def get_current_session_id(self) -> str:
        """Get the current session ID"""
        return self._current_session_id
    
    def load_and_display_today_messages(self, add_message_callback: Callable[[str, bool, Optional[str]], None]):
        """Load today's messages and display them in the UI"""
        messages = self.get_today_messages()
        
        if not messages:
            log_debug("No messages found for today")
            return
        
        log_info(f"Loading {len(messages)} messages from today")
        
        for message in messages:
            is_user = message.is_user_message()
            source_type = message.get_ui_source_type()
            
            # Add message to UI
            add_message_callback(message.content, is_user, source_type)
        
        log_info("Today's messages loaded successfully")
    
    def cleanup_old_data(self, days_to_keep: int = 30) -> int:
        """Clean up old messages"""
        async def _cleanup():
            if not self._initialized:
                await self.initialize()
            return await self.db_manager.cleanup_old_messages(days_to_keep)
        
        result = self._run_async(_cleanup())
        return result if result is not None else 0


# Global instance for easy access
_message_history_service = None

def get_message_history_service() -> MessageHistoryService:
    """Get the global message history service instance"""
    global _message_history_service
    if _message_history_service is None:
        _message_history_service = MessageHistoryService()
    return _message_history_service
