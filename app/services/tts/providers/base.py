"""Provider-neutral text-to-speech interfaces."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from enum import Enum
from typing import Literal, Protocol, runtime_checkable

AudioFormat = Literal["raw", "wav"]
ProviderErrorCode = Literal[
    "unavailable",
    "unsupported_voice",
    "invalid_audio",
    "cancelled",
    "resource_exhausted",
    "capability_changed",
]


class VoiceSelectionMode(str, Enum):
    """How a provider can select a voice for normal synthesis."""

    ACTIVE_ONLY = "active_only"
    IN_MODEL_SPEAKER = "in_model_speaker"
    SHARED_MODEL_STATE = "shared_model_state"


@dataclass(frozen=True)
class TTSProviderCapabilities:
    """Stable provider capabilities used by service routing."""

    provider_id: str
    voice_selection_mode: VoiceSelectionMode
    max_resident_base_models: int = 1
    supports_finite_synthesis: bool = True
    supports_streaming: bool = True
    supports_cancel: bool = True
    supported_formats: tuple[AudioFormat, ...] = ("raw", "wav")


@dataclass(frozen=True)
class TTSProviderHealth:
    """Provider health without leaking implementation details."""

    provider_id: str
    ready: bool
    active_voice: str | None
    base_identity: str | None
    error: str | None = None


@dataclass(frozen=True)
class TTSVoiceInfo:
    """Use-safe voice details exposed to synthesis callers."""

    voice_id: str
    display_name: str
    ready: bool
    language: str | None = None


@dataclass(frozen=True)
class TTSSynthesisRequest:
    """Provider-neutral finite synthesis request."""

    text: str
    request_id: str | None = None
    voice: str | None = None
    audio_format: AudioFormat = "raw"
    sample_rate: int | None = None
    speed: float = 1.0


@dataclass(frozen=True)
class TTSSynthesisResult:
    """Provider-neutral finite synthesis result."""

    audio: bytes
    audio_format: AudioFormat
    sample_rate: int
    channels: int
    duration_ms: float
    voice: str | None = None


@dataclass(frozen=True)
class TTSStreamChunk:
    """Provider-neutral streamed synthesis chunk."""

    sequence: int
    audio: bytes
    sample_rate: int
    channels: int
    is_final: bool = False
    duration_ms: float | None = None


class TTSProviderError(RuntimeError):
    """Sanitized provider error suitable for mapping to service errors."""

    def __init__(self, code: ProviderErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@runtime_checkable
class TTSProvider(Protocol):
    """Async provider boundary for TTS engines."""

    @property
    def capabilities(self) -> TTSProviderCapabilities:
        """Return immutable provider capabilities."""

    async def start(self) -> None:
        """Load provider resources."""

    async def stop(self) -> None:
        """Release provider resources."""

    async def health(self) -> TTSProviderHealth:
        """Return current provider health."""

    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        """Return use-safe ready voices."""

    async def synthesize(self, request: TTSSynthesisRequest) -> TTSSynthesisResult:
        """Synthesize finite audio."""

    def stream(self, request: TTSSynthesisRequest) -> AsyncIterator[TTSStreamChunk]:
        """Stream synthesized audio chunks."""

    async def cancel(self, request_id: str) -> None:
        """Cancel a request by id when possible."""
