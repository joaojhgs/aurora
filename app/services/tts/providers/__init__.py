"""TTS provider implementations."""

from app.services.tts.providers.base import (
    TTSProvider,
    TTSProviderCapabilities,
    TTSProviderError,
    TTSProviderHealth,
    TTSStreamChunk,
    TTSSynthesisRequest,
    TTSSynthesisResult,
    TTSVoiceInfo,
    VoiceSelectionMode,
)
from app.services.tts.providers.piper import (
    PiperTTSProvider,
    PiperVoiceConfig,
    pcm_to_wav_bytes,
    synthesize_piper_cli,
)

__all__ = [
    "PiperTTSProvider",
    "PiperVoiceConfig",
    "TTSProvider",
    "TTSProviderCapabilities",
    "TTSProviderError",
    "TTSProviderHealth",
    "TTSSynthesisRequest",
    "TTSSynthesisResult",
    "TTSStreamChunk",
    "TTSVoiceInfo",
    "VoiceSelectionMode",
    "pcm_to_wav_bytes",
    "synthesize_piper_cli",
]
