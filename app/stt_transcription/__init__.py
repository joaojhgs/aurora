"""STT Transcription service module for Aurora.

This module handles speech-to-text transcription including:
- Real-time transcription
- Streaming support
- Multiple backend support
"""

from app.stt_transcription.service import TranscriptionService

__all__ = ["TranscriptionService"]
