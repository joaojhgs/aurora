"""TTS (Text-to-Speech) service contract models."""

from app.shared.contracts.registry import IOModel


# Module identifier
class TTSModule:
    """Module identifier for TTS service."""

    NAME = "TTS"


# Method identifiers
class TTSMethods:
    """Full method identifiers for TTS service."""

    REQUEST = f"{TTSModule.NAME}.Request"
    STOP = f"{TTSModule.NAME}.Stop"
    PAUSE = f"{TTSModule.NAME}.Pause"
    RESUME = f"{TTSModule.NAME}.Resume"
    STARTED = f"{TTSModule.NAME}.Started"
    STOPPED = f"{TTSModule.NAME}.Stopped"
    PAUSED = f"{TTSModule.NAME}.Paused"
    RESUMED = f"{TTSModule.NAME}.Resumed"
    ERROR = f"{TTSModule.NAME}.Error"


class TTSRequest(IOModel):
    """Request to synthesize and play speech."""

    text: str
    voice: str | None = None
    speed: float = 1.0
    interrupt: bool = True  # Interrupt current playback


class TTSControl(IOModel):
    """Control TTS playback (stop, pause, resume)."""

    action: str  # "stop" | "pause" | "resume"


class TTSStatus(IOModel):
    """TTS playback status."""

    state: str  # "idle" | "playing" | "paused"
    current_text: str | None = None


class TTSError(IOModel):
    """TTS error event."""

    error: str
    text: str | None = None
