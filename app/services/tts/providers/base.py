"""Provider-neutral text-to-speech interfaces."""

from __future__ import annotations

import math
from collections.abc import AsyncIterator
from dataclasses import dataclass
from enum import Enum
from typing import Literal, Protocol, runtime_checkable

AudioFormat = Literal["raw", "wav"]
MAX_TTS_REQUEST_TEXT_CHARS = 10_000
MIN_TTS_SAMPLE_RATE = 8_000
MAX_TTS_SAMPLE_RATE = 192_000
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
    supports_inflight_cancel: bool = False
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


def validate_synthesis_request(
    request: TTSSynthesisRequest,
    *,
    supported_formats: tuple[AudioFormat, ...],
    supported_sample_rate: int | None = None,
) -> None:
    """Reject unsupported provider requests before model entry.

    Text is capped at ``MAX_TTS_REQUEST_TEXT_CHARS`` so providers never receive
    unbounded user input. Current local providers support only normal speed
    playback and optionally one concrete output sample rate.
    """
    if not isinstance(request.text, str):
        raise TTSProviderError("invalid_audio", "TTS request text is unavailable")
    if not request.text.strip():
        raise TTSProviderError("invalid_audio", "TTS request text is unavailable")
    if len(request.text) > MAX_TTS_REQUEST_TEXT_CHARS:
        raise TTSProviderError("resource_exhausted", "TTS request text is too long")
    if request.audio_format not in supported_formats:
        raise TTSProviderError("invalid_audio", "Requested audio format is unavailable")
    sample_rate = request.sample_rate
    if sample_rate is not None and (
        isinstance(sample_rate, bool)
        or not isinstance(sample_rate, int)
        or sample_rate < MIN_TTS_SAMPLE_RATE
        or sample_rate > MAX_TTS_SAMPLE_RATE
    ):
        raise TTSProviderError("invalid_audio", "Requested sample rate is unavailable")
    if supported_sample_rate is not None and (
        isinstance(supported_sample_rate, bool)
        or not isinstance(supported_sample_rate, int)
        or supported_sample_rate < MIN_TTS_SAMPLE_RATE
        or supported_sample_rate > MAX_TTS_SAMPLE_RATE
    ):
        raise TTSProviderError("invalid_audio", "Requested sample rate is unavailable")
    if (
        supported_sample_rate is not None
        and sample_rate is not None
        and sample_rate != supported_sample_rate
    ):
        raise TTSProviderError("invalid_audio", "Requested sample rate is unavailable")
    if (
        isinstance(request.speed, bool)
        or not isinstance(request.speed, (int, float))
        or not math.isfinite(request.speed)
    ):
        raise TTSProviderError("invalid_audio", "Requested speech speed is unavailable")
    if request.speed != 1.0:
        raise TTSProviderError("invalid_audio", "Requested speech speed is unavailable")


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
