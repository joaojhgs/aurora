"""STT Coordinator service module for Aurora.

This module coordinates the workflow between wake word detection and transcription,
providing the classic voice assistant experience.
"""

from app.stt_coordinator.service import (
    STTCoordinatorService,
    STTState,
    STTUserSpeechCaptured,
)

__all__ = [
    "STTCoordinatorService",
    "STTState",
    "STTUserSpeechCaptured",
]
