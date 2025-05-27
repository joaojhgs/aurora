"""
Database models for Aurora message storage and other entities.
"""

import uuid
from datetime import datetime
from enum import Enum
from typing import Optional, Dict, Any
from dataclasses import dataclass


class MessageType(Enum):
    """Message types supported by the system"""
    USER_TEXT = "user_text"
    USER_VOICE = "user_voice"
    ASSISTANT = "assistant"
    SYSTEM = "system"


@dataclass
class Message:
    """Message model for database storage"""
    id: str
    content: str
    message_type: MessageType
    timestamp: datetime
    session_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    source_type: Optional[str] = None  # "Text", "STT", etc.
    
    @classmethod
    def create_user_text_message(cls, content: str, session_id: Optional[str] = None) -> 'Message':
        """Create a new user text message"""
        return cls(
            id=str(uuid.uuid4()),
            content=content,
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
            session_id=session_id,
            source_type="Text"
        )
    
    @classmethod
    def create_user_voice_message(cls, content: str, session_id: Optional[str] = None) -> 'Message':
        """Create a new user voice message"""
        return cls(
            id=str(uuid.uuid4()),
            content=content,
            message_type=MessageType.USER_VOICE,
            timestamp=datetime.now(),
            session_id=session_id,
            source_type="STT"
        )
    
    @classmethod
    def create_assistant_message(cls, content: str, session_id: Optional[str] = None) -> 'Message':
        """Create a new assistant message"""
        return cls(
            id=str(uuid.uuid4()),
            content=content,
            message_type=MessageType.ASSISTANT,
            timestamp=datetime.now(),
            session_id=session_id
        )
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert message to dictionary for database storage"""
        return {
            'id': self.id,
            'content': self.content,
            'message_type': self.message_type.value,
            'timestamp': self.timestamp.isoformat(),
            'session_id': self.session_id,
            'metadata': self.metadata,
            'source_type': self.source_type
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Message':
        """Create message from dictionary (database row)"""
        return cls(
            id=data['id'],
            content=data['content'],
            message_type=MessageType(data['message_type']),
            timestamp=datetime.fromisoformat(data['timestamp']),
            session_id=data['session_id'],
            metadata=data['metadata'],
            source_type=data['source_type']
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
