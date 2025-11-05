"""STT Wake Word service module for Aurora.

This module handles wake word detection including:
- Multiple backend support (OpenWakeWord, Porcupine)
- Audio processing
- Wake word event emission
"""

from app.services.stt_wakeword.backends import (
    DetectionResult,
    OpenWakeWordBackend,
    PorcupineBackend,
    WakeWordBackend,
)
from app.shared.messaging.models.stt_wakeword_models import (
    WakeWordBackendType,
    WakeWordControl,
    WakeWordDetected,
    WakeWordTimeout,
)
from app.services.stt_wakeword.service import WakeWordService

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
