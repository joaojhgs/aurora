# filepath: app/stt_wakeword/messages.py
"""Message definitions for Wake Word Detection Service."""

from enum import Enum

from pydantic import BaseModel, Field

from app.messaging import Command, Event


class WakeWordBackendType(str, Enum):
    """Supported wake word detection backends."""
    
    OPENWAKEWORD = "oww"
    PORCUPINE = "pvp"


class WakeWordDetected(Event):
    """Event emitted when a wake word is detected."""
    
    wake_word: str = Field(
        description="The wake word that was detected"
    )
    confidence: float = Field(
        description="Confidence score (0.0 to 1.0)"
    )
    source: str = Field(
        description="Audio source where wake word was detected"
    )
    stream_id: str = Field(
        description="ID of the audio stream"
    )
    backend: WakeWordBackendType = Field(
        description="Backend that detected the wake word"
    )


class WakeWordTimeout(Event):
    """Event emitted when wake word detection times out."""
    
    timeout_seconds: float = Field(
        description="How long we waited for a wake word"
    )


class WakeWordControl(Command):
    """Command to control wake word detection."""
    
    action: str = Field(
        description="Action to perform: 'start', 'stop', 'pause', 'resume'"
    )
