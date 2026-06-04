"""STT (Speech-to-Text) service contract models."""

from pydantic import Field

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
    DETECT = f"{WakeWordModule.NAME}.Detect"  # External: returns detection result
    HEALTH_CHECK = f"{WakeWordModule.NAME}.HealthCheck"


class TranscriptionMethods:
    """Full method identifiers for Transcription service."""

    RESULT = f"{TranscriptionModule.NAME}.Result"
    CONTROL = f"{TranscriptionModule.NAME}.Control"
    PROCESS_AUDIO = f"{TranscriptionModule.NAME}.ProcessAudio"
    TRANSCRIBE = f"{TranscriptionModule.NAME}.Transcribe"  # External: synchronous transcription
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
    sample_width: int | None = None  # Bytes per sample (derived from format if not provided)


# ============================================================================
# External API Models (for Gateway exposure)
# ============================================================================


class TranscribeAudioRequest(IOModel):
    """Request to transcribe complete audio (for external API).

    Audio should be provided as base64-encoded data.
    """

    audio_data: str  # Base64-encoded audio
    format: str = "wav"  # "wav" | "raw" | "mp3"
    sample_rate: int = Field(default=16000, gt=0, description="Sample rate in Hz (must be > 0)")
    channels: int = 1
    language: str | None = None  # ISO language code or None for auto-detect
    model: str = "realtime"  # "realtime" | "accurate"


class TranscribeAudioResponse(IOModel):
    """Transcription result (for external API)."""

    text: str
    confidence: float | None = None
    language: str | None = None
    duration_ms: float
    model_used: str


class WakeWordDetectRequest(IOModel):
    """Request to check audio for wake word (for external API).

    Audio should be provided as base64-encoded data.
    """

    audio_data: str  # Base64-encoded audio chunk
    sample_rate: int = 16000
    channels: int = 1
    format: str = "raw"  # "raw" (PCM 16-bit) | "wav"


class WakeWordDetectResponse(IOModel):
    """Wake word detection result (for external API)."""

    detected: bool
    wake_word: str | None = None
    confidence: float | None = None
