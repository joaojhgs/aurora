"""Transcription message types for Aurora's message bus.

This module defines message types for speech-to-text transcription:
- TranscriptionResult: Text output from transcription
- TranscriptionControl: Control messages for transcription service
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import Field

from .bus import Command, Event


class TranscriptionType(str, Enum):
    """Type of transcription result."""

    PARTIAL = "partial"  # Partial/interim result (low latency)
    FINAL = "final"  # Final result (high accuracy)
    REALTIME = "realtime"  # Realtime model output
    ACCURATE = "accurate"  # Accurate model output


class TranscriptionResult(Event):
    """Event emitted when transcription is complete.

    This event is emitted by TranscriptionService when audio has been
    transcribed to text.
    """

    text: str = Field(description="The transcribed text")

    transcription_type: TranscriptionType = Field(description="Type of transcription (partial, final, realtime, accurate)")

    confidence: float | None = Field(default=None, description="Confidence score (0.0 to 1.0) if available")

    language: str | None = Field(default=None, description="Detected or specified language code (e.g., 'en', 'es')")

    source: str = Field(description="Audio source that was transcribed (e.g., 'microphone', 'websocket')")

    stream_id: str = Field(description="ID of the audio stream")

    duration_ms: float | None = Field(default=None, description="Duration of audio segment transcribed (milliseconds)")

    timestamp: datetime = Field(default_factory=datetime.now, description="When transcription was completed")

    model: str | None = Field(default=None, description="Model used for transcription (e.g., 'faster-whisper-medium')")


class TranscriptionControl(Command):
    """Command to control transcription service.

    Allows controlling the transcription service behavior.
    """

    action: str = Field(description="Action to perform: 'start', 'stop', 'pause', 'resume', 'set_language', 'enable_realtime', 'enable_accurate'")

    language: str | None = Field(default=None, description="Language code to set (for 'set_language' action)")

    enabled: bool | None = Field(default=None, description="Enable/disable flag (for 'enable_realtime' or 'enable_accurate' actions)")

    stream_id: str | None = Field(default=None, description="Specific stream to control (None for all streams)")


class TranscriptionError(Event):
    """Event emitted when transcription fails.

    This allows other services to react to transcription errors.
    """

    error_message: str = Field(description="Error message describing what went wrong")

    error_type: str = Field(description="Type of error (e.g., 'model_loading', 'processing', 'timeout')")

    source: str = Field(description="Audio source where error occurred")

    stream_id: str = Field(description="ID of the audio stream")

    timestamp: datetime = Field(default_factory=datetime.now, description="When error occurred")


class TranscriptionTopics:
    """Standard topic names for transcription events."""

    # Results
    RESULT = "Transcription.Result"
    RESULT_PARTIAL = "Transcription.Result.Partial"
    RESULT_FINAL = "Transcription.Result.Final"
    RESULT_REALTIME = "Transcription.Result.Realtime"
    RESULT_ACCURATE = "Transcription.Result.Accurate"

    # Control
    CONTROL = "Transcription.Control"

    # Errors
    ERROR = "Transcription.Error"


# Export all message types
__all__ = [
    "TranscriptionType",
    "TranscriptionResult",
    "TranscriptionControl",
    "TranscriptionError",
    "TranscriptionTopics",
]
