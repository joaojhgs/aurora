"""TTS service module for Aurora.

This module handles text-to-speech synthesis including:
- Multiple engine support
- Voice selection
- Audio playback
"""

from app.services.tts.service import TTSService
from app.shared.messaging.models.tts_models import (
    TTSError,
    TTSPause,
    TTSRequest,
    TTSResume,
    TTSStarted,
    TTSStop,
    TTSStopped,
)

__all__ = ["TTSService", "TTSStarted", "TTSRequest", "TTSStop", "TTSStopped", "TTSPause", "TTSResume", "TTSError"]
