"""TTS service message models."""

from __future__ import annotations

from app.messaging import Command, Event


class TTSRequest(Command):
    """Command to play text-to-speech audio."""

    text: str
    interrupt: bool = False
    voice: str | None = None
    speed: float = 1.0


class TTSStop(Command):
    """Command to stop TTS playback."""

    pass


class TTSPause(Command):
    """Command to pause TTS playback."""

    pass


class TTSResume(Command):
    """Command to resume TTS playback."""

    pass


class TTSEvent(Event):
    """Base event for TTS lifecycle."""

    request_id: str | None = None


class TTSStarted(TTSEvent):
    """Event emitted when TTS playback starts."""

    text: str


class TTSStopped(TTSEvent):
    """Event emitted when TTS playback stops."""

    reason: str = "completed"  # "completed", "interrupted", "error"


class TTSPaused(TTSEvent):
    """Event emitted when TTS playback is paused."""

    pass


class TTSResumed(TTSEvent):
    """Event emitted when TTS playback is resumed."""

    pass


class TTSError(TTSEvent):
    """Event emitted when TTS encounters an error."""

    error: str
