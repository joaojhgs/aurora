"""STT (Speech-to-Text) and audio session contract models."""

from typing import Any, Literal

from pydantic import Field, field_validator, model_validator

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.speech import (
    MAX_JS_SAFE_INTEGER,
    SpeechLanguageTag,
    normalize_speech_language,
    normalize_speech_language_candidates,
)
from app.shared.contracts.registry import IOModel

MAX_AUDIO_SAMPLE_RATE = 192_000
MAX_AUDIO_CHANNELS = 8
MAX_AUDIO_SAMPLE_WIDTH = 8


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


class AudioSessionModule:
    """Module identifier for audio session consent contracts."""

    NAME = "AudioSession"


# Method identifiers
class STTMethods:
    """Full method identifiers for STT Coordinator service."""

    SESSION_STARTED = f"{STTModule.NAME}.SessionStarted"
    SESSION_ENDED = f"{STTModule.NAME}.SessionEnded"
    USER_SPEECH_CAPTURED = f"{STTModule.NAME}.UserSpeechCaptured"
    LISTEN = f"{STTModule.NAME}.Listen"
    STOP_LISTENING = f"{STTModule.NAME}.StopListening"
    CAPTURE_PREPARE = f"{STTModule.NAME}.CapturePrepare"
    CAPTURE_RELEASE = f"{STTModule.NAME}.CaptureRelease"
    CAPTURE_STATUS = f"{STTModule.NAME}.CaptureStatus"
    AUDIO_LEVEL = f"{STTModule.NAME}.AudioLevel"
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


class AudioSessionMethods:
    """Full method identifiers for cross-peer audio session lifecycle."""

    PREPARE = f"{AudioSessionModule.NAME}.Prepare"
    REQUEST_CONSENT = f"{AudioSessionModule.NAME}.RequestConsent"
    START = f"{AudioSessionModule.NAME}.Start"
    STOP = f"{AudioSessionModule.NAME}.Stop"
    STATUS = f"{AudioSessionModule.NAME}.Status"
    EVENTS = f"{AudioSessionModule.NAME}.Events"
    LIST_EVENTS = f"{AudioSessionModule.NAME}.ListEvents"


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


class STTListenResponse(IOModel):
    """Response for listen requests.

    Listen is idempotent: if a wakeword or another client already has the
    coordinator in a non-idle session, the active session is returned instead
    of attempting to start a duplicate session.
    """

    success: bool = True
    status: str = "listening"
    session_id: str | None = None
    current_state: str = "idle"
    source: str = "push_to_talk"
    message: str | None = None


class STTAudioLevel(IOModel):
    """Redacted microphone level telemetry for UI visualizers.

    This intentionally contains only derived amplitude values, never raw audio
    samples or encoded audio bytes.
    """

    session_id: str | None = None
    stream_id: str | None = None
    sequence: int
    level: float = Field(ge=0.0, le=100.0)
    peak: float = Field(ge=0.0, le=100.0)
    bars: list[float] = Field(default_factory=list)
    privacy_class: str = "raw-audio"
    redacted: bool = True


class STTStopListeningRequest(IOModel):
    """Request to stop listening."""

    reason: str | None = None


class STTCapturePrepareRequest(IOModel):
    """Request exclusive native ownership of the local microphone."""

    owner: Literal["native"] = "native"
    owner_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.:-]+$")
    lease_id: str | None = Field(default=None, min_length=1, max_length=128)
    reason: str = Field(default="native_voice_runtime", max_length=80)
    requested_ttl_s: int = Field(default=300, gt=0, le=3600)
    correlation_id: str | None = Field(default=None, max_length=128)


class STTCapturePrepareResponse(IOModel):
    """Redacted capture-owner grant response."""

    granted: bool
    status: Literal["granted", "already_owned", "unavailable"]
    lease_id: str | None = Field(default=None, min_length=1, max_length=128)
    generation: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    owner: Literal["none", "python", "native"]
    python_capture_active: bool
    stopped_python_capture: bool = False
    message: str | None = Field(default=None, max_length=80)
    redacted: bool = True


class STTCaptureReleaseRequest(IOModel):
    """Release a native microphone ownership lease."""

    owner: Literal["native"] = "native"
    owner_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.:-]+$")
    lease_id: str = Field(min_length=1, max_length=128)
    generation: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    reason: str = Field(default="native_release", max_length=80)
    restart_python_capture: bool = True
    correlation_id: str | None = Field(default=None, max_length=128)


class STTCaptureReleaseResponse(IOModel):
    """Redacted native capture release response."""

    released: bool
    status: Literal["released", "already_released", "rejected", "python_unavailable"]
    generation: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    owner: Literal["none", "python", "native"]
    python_capture_active: bool
    restarted_python_capture: bool = False
    message: str | None = Field(default=None, max_length=80)
    redacted: bool = True


class STTCaptureStatusRequest(IOModel):
    """Request redacted capture-owner status."""

    include_inactive: bool = True


class STTCaptureStatusResponse(IOModel):
    """Redacted microphone ownership status."""

    owner: Literal["none", "python", "native"]
    generation: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    native_lease_active: bool = False
    lease_expires_at: str | None = Field(default=None, max_length=64)
    python_capture_active: bool
    service_running: bool
    audio_input_available: bool
    can_restart_python_capture: bool
    redacted: bool = True


class STTAudioChunk(IOModel):
    """Audio chunk for processing."""

    data: bytes
    sample_rate: int = Field(gt=0, le=MAX_AUDIO_SAMPLE_RATE)
    channels: int = Field(ge=1, le=MAX_AUDIO_CHANNELS)
    format: str = "pcm_s16le"
    sample_width: int | None = Field(default=None, ge=1, le=MAX_AUDIO_SAMPLE_WIDTH)
    mesh_selector: MeshAddressSelector | None = None
    session_id: str | None = None
    consent_token: str | None = None
    caller_principal_id: str | None = None
    caller_peer_id: str | None = None
    caller_device_id: str | None = None
    target_peer_id: str | None = None
    target_device_id: str | None = None
    privacy_class: str = "microphone"
    privacy_indicator_state: str = "required"
    correlation_id: str | None = None


class AudioSessionSampleLimits(IOModel):
    """Runtime limits for streaming audio sessions."""

    min_sample_rate: int = 8000
    max_sample_rate: int = 48000
    max_channels: int = 2
    allowed_formats: list[str] = Field(default_factory=lambda: ["pcm_s16le", "raw", "wav"])
    max_chunk_bytes: int = 262144


class AudioSessionPrepareRequest(IOModel):
    """Prepare a target-scoped audio streaming session."""

    operation: str
    mesh_selector: MeshAddressSelector
    caller_principal_id: str | None = None
    caller_peer_id: str | None = None
    caller_device_id: str | None = None
    target_peer_id: str | None = None
    target_device_id: str | None = None
    privacy_class: str = "microphone"
    privacy_indicator_state: str = "required"
    sample_rate: int = 16000
    channels: int = 1
    format: str = "pcm_s16le"
    estimated_bandwidth_bps: int | None = None
    requested_ttl_s: int = Field(default=300, gt=0, le=3600)
    correlation_id: str | None = None


class AudioSessionPrepareResponse(IOModel):
    """Prepared audio session policy response."""

    session_id: str
    status: str = "prepared"
    consent_required: bool = True
    privacy_indicator_required: bool = True
    bandwidth_check_required: bool = True
    sample_limits: AudioSessionSampleLimits = Field(default_factory=AudioSessionSampleLimits)
    expires_at: str
    correlation_id: str


class AudioSessionConsentRequest(IOModel):
    """Request or record user/device consent for a prepared audio session."""

    session_id: str
    approved: bool = True
    approver_principal_id: str | None = None
    approver_device_id: str | None = None
    expires_in_s: int | None = Field(default=None, gt=0, le=3600)
    reason: str | None = None


class AudioSessionConsentResponse(IOModel):
    """Consent result for an audio session."""

    session_id: str
    status: str
    consent_token: str | None = None
    expires_at: str | None = None
    reason: str | None = None


class AudioSessionStartRequest(IOModel):
    """Start an approved audio session."""

    session_id: str
    consent_token: str


class AudioSessionStopRequest(IOModel):
    """Stop or revoke an audio session."""

    session_id: str
    reason: str = "stopped"


class AudioSessionStatusRequest(IOModel):
    """Get one audio session status."""

    session_id: str


class AudioSessionEvent(IOModel):
    """Unified audio event stream payload for approved/denied sessions."""

    session_id: str
    event_type: str
    status: str | None = None
    source_peer_id: str | None = None
    target_peer_id: str | None = None
    privacy_class: str = "microphone"
    redacted: bool = True
    correlation_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class AudioSessionStatusResponse(IOModel):
    """Status snapshot for a streaming audio session."""

    session_id: str
    status: str
    operation: str
    caller_principal_id: str | None = None
    caller_peer_id: str | None = None
    target_peer_id: str | None = None
    target_device_id: str | None = None
    privacy_class: str = "microphone"
    privacy_indicator_state: str = "required"
    expires_at: str | None = None
    correlation_id: str | None = None
    consent_granted: bool = False


class AudioSessionEventsRequest(IOModel):
    """Return buffered audio session events for UI/API consumers."""

    session_id: str | None = None
    since_index: int = Field(default=0, ge=0)
    limit: int = Field(default=100, gt=0, le=500)


class AudioSessionEventsResponse(IOModel):
    """Buffered audio session events."""

    events: list[AudioSessionEvent] = Field(default_factory=list)
    next_index: int = 0


# ============================================================================
# External API Models (for Gateway exposure)
# ============================================================================


class TranscribeAudioRequest(IOModel):
    """Request to transcribe complete audio (for external API).

    Audio should be provided as base64-encoded data.
    """

    audio_data: str  # Base64-encoded audio
    format: str = "wav"  # "wav" | "raw" | "mp3"
    sample_rate: int = Field(
        default=16000,
        gt=0,
        le=MAX_AUDIO_SAMPLE_RATE,
        description="Sample rate in Hz (must be > 0)",
    )
    channels: int = Field(default=1, ge=1, le=MAX_AUDIO_CHANNELS)
    language: SpeechLanguageTag | None = None  # Exact product language or None for auto-detect
    auto_language_candidates: list[SpeechLanguageTag] = Field(default_factory=list, max_length=8)
    model: str = "realtime"  # "realtime" | "accurate"
    mesh_selector: MeshAddressSelector | None = None

    @field_validator("language", mode="before")
    @classmethod
    def _normalize_language(cls, value: str | None) -> str | None:
        normalized = normalize_speech_language(value, allow_auto=True)
        return None if normalized == "auto" else normalized

    @field_validator("auto_language_candidates", mode="before")
    @classmethod
    def _normalize_candidates(cls, value: list[str]) -> list[SpeechLanguageTag]:
        return normalize_speech_language_candidates(value)

    @model_validator(mode="after")
    def _validate_language_shape(self) -> "TranscribeAudioRequest":
        if self.language is not None and self.auto_language_candidates:
            raise ValueError("exact STT language cannot include auto candidates")
        return self


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
    sample_rate: int = Field(default=16000, gt=0, le=MAX_AUDIO_SAMPLE_RATE)
    channels: int = Field(default=1, ge=1, le=MAX_AUDIO_CHANNELS)
    format: str = "raw"  # "raw" (PCM 16-bit) | "wav"
    mesh_selector: MeshAddressSelector | None = None


class WakeWordDetectResponse(IOModel):
    """Wake word detection result (for external API)."""

    detected: bool
    wake_word: str | None = None
    confidence: float | None = None
