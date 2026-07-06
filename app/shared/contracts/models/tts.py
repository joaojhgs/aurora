"""TTS (Text-to-Speech) service contract models."""

from pydantic import Field

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.registry import IOModel


# Module identifier
class TTSModule:
    """Module identifier for TTS service."""

    NAME = "TTS"


# Method identifiers
class TTSMethods:
    """Full method identifiers for TTS service."""

    REQUEST = f"{TTSModule.NAME}.Request"
    SYNTHESIZE = f"{TTSModule.NAME}.Synthesize"  # External: returns audio data
    STREAM_START = f"{TTSModule.NAME}.StreamStart"
    STREAM_CHUNK = f"{TTSModule.NAME}.StreamChunk"
    STREAM_END = f"{TTSModule.NAME}.StreamEnd"
    AUDIO_CHUNK = f"{TTSModule.NAME}.AudioChunk"
    STOP = f"{TTSModule.NAME}.Stop"
    PAUSE = f"{TTSModule.NAME}.Pause"
    RESUME = f"{TTSModule.NAME}.Resume"
    STARTED = f"{TTSModule.NAME}.Started"
    STOPPED = f"{TTSModule.NAME}.Stopped"
    PAUSED = f"{TTSModule.NAME}.Paused"
    RESUMED = f"{TTSModule.NAME}.Resumed"
    ERROR = f"{TTSModule.NAME}.Error"
    HEALTH_CHECK = f"{TTSModule.NAME}.HealthCheck"


class TTSRequest(IOModel):
    """Request to synthesize and play speech."""

    text: str
    voice: str | None = None
    speed: float = 1.0
    interrupt: bool = True  # Interrupt current playback
    mesh_selector: MeshAddressSelector | None = None


class TTSSynthesizeRequest(IOModel):
    """Request to synthesize speech and return audio data (for external API)."""

    text: str
    voice: str | None = None
    speed: float = 1.0
    format: str = "wav"  # "wav" | "raw"
    sample_rate: int | None = None  # None = use model default
    mesh_selector: MeshAddressSelector | None = None


class TTSSynthesizeResponse(IOModel):
    """Synthesized audio response."""

    audio_data: str  # Base64-encoded audio
    format: str
    sample_rate: int
    channels: int
    duration_ms: float
    text: str


class TTSStreamStartRequest(IOModel):
    """Start an ordered text-to-speech streaming session.

    Stream sessions accept text fragments through ``TTSStreamChunkRequest`` and
    publish synthesized audio fragments as ``TTSAudioChunkEvent`` events.
    """

    stream_id: str
    voice: str | None = None
    speed: float = 1.0
    format: str = "wav"  # "wav" | "raw"
    sample_rate: int | None = None  # None = use model default
    interrupt: bool = True  # Stop current server playback/streams before starting
    play_on_server: bool = True  # Also play chunks through local server audio output
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = None


class TTSStreamChunkRequest(IOModel):
    """Ordered text chunk for an active TTS streaming session."""

    stream_id: str
    sequence: int = Field(ge=0)
    text: str
    is_final: bool = False
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = None


class TTSStreamEndRequest(IOModel):
    """End an ordered TTS streaming session."""

    stream_id: str
    final_sequence: int | None = Field(default=None, ge=0)
    reason: str = "completed"
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = None


class TTSAudioChunkEvent(IOModel):
    """Synthesized audio chunk emitted for a TTS streaming session."""

    stream_id: str
    sequence: int = Field(ge=0)
    audio_data: str  # Base64-encoded audio
    format: str
    sample_rate: int
    channels: int = 1
    duration_ms: float = Field(ge=0)
    text: str | None = None
    source_sequence: int | None = Field(default=None, ge=0)
    is_final: bool = False
    reason: str | None = None
    correlation_id: str | None = None


class TTSControl(IOModel):
    """Control TTS playback (stop, pause, resume)."""

    action: str  # "stop" | "pause" | "resume"
    mesh_selector: MeshAddressSelector | None = None


class TTSStatus(IOModel):
    """TTS playback status."""

    state: str  # "idle" | "playing" | "paused"
    current_text: str | None = None


class TTSError(IOModel):
    """TTS error event."""

    error: str
    text: str | None = None
