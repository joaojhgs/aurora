"""STT Coordinator service message models."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import Field

from app.messaging import Command, Event


class STTState(StrEnum):
    """States for STT coordinator state machine."""

    IDLE = "idle"  # Waiting for wake word
    LISTENING = "listening"  # Actively listening for user speech
    PROCESSING = "processing"  # Processing transcription result
    TIMEOUT = "timeout"  # Timed out waiting for speech


class STTSessionStarted(Event):
    """Event emitted when STT session starts (wake word detected)."""

    wake_word: str = Field(description="Wake word that triggered session")
    session_id: str = Field(description="Unique session ID")
    timestamp: datetime = Field(default_factory=datetime.now)


class STTSessionEnded(Event):
    """Event emitted when STT session ends."""

    session_id: str = Field(description="Session ID that ended")
    reason: str = Field(description="Reason for ending: 'complete', 'timeout', 'manual'")
    transcription: str | None = Field(default=None, description="Final transcription if available")
    timestamp: datetime = Field(default_factory=datetime.now)


class STTUserSpeechCaptured(Event):
    """Event emitted when user speech is captured and transcribed."""

    session_id: str = Field(description="Session ID")
    text: str = Field(description="Transcribed text")
    confidence: float | None = Field(default=None, description="Confidence score")
    is_final: bool = Field(default=True, description="Whether this is final transcription")
    timestamp: datetime = Field(default_factory=datetime.now)


class STTCoordinatorControl(Command):
    """Command to control STT coordinator."""

    action: str = Field(description="Action: 'start_session', 'end_session', 'reset'")
    session_id: str | None = Field(default=None, description="Session ID for specific actions")
