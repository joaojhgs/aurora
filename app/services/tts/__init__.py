"""TTS service module for Aurora.

This module handles text-to-speech synthesis including:
- Multiple engine support
- Voice selection
- Audio playback
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.shared.messaging.models.tts_models import (
    TTSError,
    TTSPause,
    TTSRequest,
    TTSResume,
    TTSStarted,
    TTSStop,
    TTSStopped,
)

if TYPE_CHECKING:
    from app.services.tts.service import TTSService

__all__ = [
    "TTSService",
    "TTSStarted",
    "TTSRequest",
    "TTSStop",
    "TTSStopped",
    "TTSPause",
    "TTSResume",
    "TTSError",
]


def __getattr__(name: str):
    if name == "TTSService":
        from app.services.tts.service import TTSService as _TTSService

        return _TTSService
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
