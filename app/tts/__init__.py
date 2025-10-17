"""TTS service module for Aurora.

This module handles text-to-speech synthesis including:
- Multiple engine support
- Voice selection
- Audio playback
"""

from app.tts.service import (
    TTSService,
    TTSStarted,
    TTSRequest,
    TTSStop,
    TTSStopped,
    TTSPause,
    TTSResume,
    TTSError
)

__all__ = [
    "TTSService",
    "TTSStarted",
    "TTSRequest",
    "TTSStop",
    "TTSStopped",
    "TTSPause",
    "TTSResume",
    "TTSError"
]
