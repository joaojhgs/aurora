# filepath: app/stt_wakeword/messages.py
"""Message definitions for Wake Word Detection Service.

This module re-exports models from shared for backward compatibility.
"""

from app.shared.messaging.models.stt_wakeword_models import (
    WakeWordBackendType,
    WakeWordControl,
    WakeWordDetected,
    WakeWordTimeout,
)

__all__ = ["WakeWordBackendType", "WakeWordDetected", "WakeWordTimeout", "WakeWordControl"]
