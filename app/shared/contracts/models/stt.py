"""STT (Speech-to-Text) service contract models."""

from app.shared.contracts.registry import IOModel


# Module identifiers
class STTModule:
    """Module identifier for STT Coordinator service."""

    NAME = "STTCoordinator"


class WakeWordModule:
    """Module identifier for WakeWord service."""

    NAME = "WakeWord"


class TranscriptionModule:
    """Module identifier for Transcription service."""

    NAME = "Transcription"


# Method identifiers
class STTMethods:
    """Full method identifiers for STT Coordinator service."""

    SESSION_STARTED = f"{STTModule.NAME}.SessionStarted"
    SESSION_ENDED = f"{STTModule.NAME}.SessionEnded"
    USER_SPEECH_CAPTURED = f"{STTModule.NAME}.UserSpeechCaptured"
    LISTEN = f"{STTModule.NAME}.Listen"
    STOP_LISTENING = f"{STTModule.NAME}.StopListening"
    AUDIO = f"{STTModule.NAME}.Audio"
    CONTROL = f"{STTModule.NAME}.Control"
    # Additional methods/events
    DETECTED = f"{STTModule.NAME}.Detected"
    PARTIAL = f"{STTModule.NAME}.Partial"
    FINAL = f"{STTModule.NAME}.Final"
    ERROR = f"{STTModule.NAME}.Error"
    TIMEOUT = f"{STTModule.NAME}.Timeout"
    HEALTH_CHECK = f"{STTModule.NAME}.HealthCheck"


class WakeWordMethods:
    """Full method identifiers for WakeWord service."""

    DETECTED = f"{WakeWordModule.NAME}.Detected"
    CONTROL = f"{WakeWordModule.NAME}.Control"
    PROCESS_AUDIO = f"{WakeWordModule.NAME}.ProcessAudio"
    HEALTH_CHECK = f"{WakeWordModule.NAME}.HealthCheck"


class TranscriptionMethods:
    """Full method identifiers for Transcription service."""

    RESULT = f"{TranscriptionModule.NAME}.Result"
    CONTROL = f"{TranscriptionModule.NAME}.Control"
    PROCESS_AUDIO = f"{TranscriptionModule.NAME}.ProcessAudio"
    HEALTH_CHECK = f"{TranscriptionModule.NAME}.HealthCheck"
    ERROR = f"{TranscriptionModule.NAME}.Error"


class STTTranscriptionRequest(IOModel):
    """Request to transcribe audio."""

    text: str | None = None  # For file-based transcription
    stream_id: str | None = None


class STTTranscriptionResult(IOModel):
    """Transcription result from STT."""

    text: str
    confidence: float | None = None
    language: str | None = None


class STTControl(IOModel):
    """Control STT services (transcription, wakeword)."""

    action: str  # "pause" | "resume" | "start" | "stop"
    enabled: bool | None = None
    language: str | None = None


class STTCoordinatorControl(IOModel):
    """Control STT coordinator."""

    action: str  # "start" | "stop" | "reset"


class WakewordControl(IOModel):
    """Control wake word detection."""

    action: str  # "start" | "stop" | "pause" | "resume"


class STTError(IOModel):
    """STT error event."""

    error: str
    stage: str | None = None  # "wakeword" | "transcription" | "coordinator"


class STTListenRequest(IOModel):
    """Request to start listening."""

    session_id: str | None = None


class STTStopListeningRequest(IOModel):
    """Request to stop listening."""

    reason: str | None = None


class STTAudioChunk(IOModel):
    """Audio chunk for processing."""

    data: bytes
    sample_rate: int
    channels: int
    format: str = "pcm_s16le"
