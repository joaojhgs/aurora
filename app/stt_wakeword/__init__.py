"""STT Wake Word service module for Aurora.

This module handles wake word detection including:
- Multiple backend support (OpenWakeWord, Porcupine)
- Audio processing
- Wake word event emission
"""

from app.stt_wakeword.backends import (
    DetectionResult,
    OpenWakeWordBackend,
    PorcupineBackend,
    WakeWordBackend,
)
from app.stt_wakeword.messages import (
    WakeWordBackendType,
    WakeWordControl,
    WakeWordDetected,
    WakeWordTimeout,
)
from app.stt_wakeword.service import WakeWordService

__all__ = [
    "WakeWordService",
    "WakeWordDetected",
    "WakeWordTimeout",
    "WakeWordControl",
    "WakeWordBackendType",
    "WakeWordBackend",
    "OpenWakeWordBackend",
    "PorcupineBackend",
    "DetectionResult",
]
