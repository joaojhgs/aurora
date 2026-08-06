"""Official PocketTTS provider adapter."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import math
from collections.abc import AsyncIterator, Iterable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Literal

from app.helpers.aurora_logger import log_debug, log_warning
from app.services.tts.providers.base import (
    TTSProviderCapabilities,
    TTSProviderError,
    TTSProviderHealth,
    TTSStreamChunk,
    TTSSynthesisRequest,
    TTSSynthesisResult,
    TTSVoiceInfo,
    VoiceSelectionMode,
)
from app.services.tts.providers.piper import pcm_to_wav_bytes

PocketTTSQualityTier = Literal["compact", "quality"]

_PRODUCT_LANGUAGE_ALIASES: Mapping[str, str] = {
    "en": "english",
    "en-us": "english",
    "en-gb": "english",
    "english": "english",
    "de": "german",
    "de-de": "german",
    "german": "german",
    "pt": "portuguese",
    "pt-br": "portuguese",
    "pt-pt": "portuguese",
    "portuguese": "portuguese",
    "it": "italian",
    "it-it": "italian",
    "italian": "italian",
    "es": "spanish",
    "es-es": "spanish",
    "es-mx": "spanish",
    "spanish": "spanish",
    "fr": "french",
    "fr-fr": "french",
    "french": "french",
}


@dataclass(frozen=True)
class PocketTTSConfigInfo:
    """Pinned PocketTTS package config metadata."""

    config_id: str
    product_language: str
    quality_tier: PocketTTSQualityTier
    layer_count: int
    compatibility_only: bool = False


POCKETTTS_CONFIGS: Mapping[str, PocketTTSConfigInfo] = {
    "english": PocketTTSConfigInfo(
        config_id="english",
        product_language="english",
        quality_tier="compact",
        layer_count=6,
        compatibility_only=True,
    ),
    "english_2026-01": PocketTTSConfigInfo(
        config_id="english_2026-01",
        product_language="english",
        quality_tier="compact",
        layer_count=6,
        compatibility_only=True,
    ),
    "english_2026-04": PocketTTSConfigInfo(
        config_id="english_2026-04",
        product_language="english",
        quality_tier="compact",
        layer_count=6,
    ),
    "german": PocketTTSConfigInfo(
        config_id="german",
        product_language="german",
        quality_tier="compact",
        layer_count=6,
    ),
    "german_24l": PocketTTSConfigInfo(
        config_id="german_24l",
        product_language="german",
        quality_tier="quality",
        layer_count=24,
    ),
    "portuguese": PocketTTSConfigInfo(
        config_id="portuguese",
        product_language="portuguese",
        quality_tier="compact",
        layer_count=6,
    ),
    "portuguese_24l": PocketTTSConfigInfo(
        config_id="portuguese_24l",
        product_language="portuguese",
        quality_tier="quality",
        layer_count=24,
    ),
    "italian": PocketTTSConfigInfo(
        config_id="italian",
        product_language="italian",
        quality_tier="compact",
        layer_count=6,
    ),
    "italian_24l": PocketTTSConfigInfo(
        config_id="italian_24l",
        product_language="italian",
        quality_tier="quality",
        layer_count=24,
    ),
    "spanish": PocketTTSConfigInfo(
        config_id="spanish",
        product_language="spanish",
        quality_tier="compact",
        layer_count=6,
    ),
    "spanish_24l": PocketTTSConfigInfo(
        config_id="spanish_24l",
        product_language="spanish",
        quality_tier="quality",
        layer_count=24,
    ),
    "french_24l": PocketTTSConfigInfo(
        config_id="french_24l",
        product_language="french",
        quality_tier="quality",
        layer_count=24,
    ),
}

_CONFIG_BY_LANGUAGE_AND_TIER: Mapping[tuple[str, PocketTTSQualityTier], str] = {
    ("english", "compact"): "english_2026-04",
    ("english", "quality"): "english_2026-04",
    ("german", "compact"): "german",
    ("german", "quality"): "german_24l",
    ("portuguese", "compact"): "portuguese",
    ("portuguese", "quality"): "portuguese_24l",
    ("italian", "compact"): "italian",
    ("italian", "quality"): "italian_24l",
    ("spanish", "compact"): "spanish",
    ("spanish", "quality"): "spanish_24l",
    ("french", "quality"): "french_24l",
}

_ENGLISH_LEGACY_CONFIGS = frozenset({"english", "english_2026-01"})


@dataclass(frozen=True)
class PocketTTSVoiceStateConfig:
    """Ready logical voice state loaded under one PocketTTS base model."""

    voice_id: str
    audio_prompt: str
    display_name: str | None = None


@dataclass(frozen=True)
class PocketTTSProviderConfig:
    """Provider-private PocketTTS runtime configuration."""

    effective_language: str
    quality_tier: PocketTTSQualityTier = "compact"
    voices: tuple[PocketTTSVoiceStateConfig, ...] = (
        PocketTTSVoiceStateConfig(
            voice_id="standard:alba",
            audio_prompt="alba",
            display_name="Alba",
        ),
    )
    preload: bool = True
    quantize: bool = False
    request_timeout_s: float = 30.0
    queue_timeout_s: float = 5.0
    init_timeout_s: float = 60.0
    max_tokens: int = 120
    frames_after_eos: int = 1
    model_revision: str = "pocket-tts-2.1.0"
    config_id: str | None = None


@dataclass(frozen=True)
class _LoadedPocketTTSState:
    config: PocketTTSProviderConfig
    config_info: PocketTTSConfigInfo
    model: Any
    sample_rate: int
    voice_states: Mapping[str, Any]
    base_identity: str


def normalize_pockettts_language(language: str) -> str:
    """Normalize Aurora product language values for PocketTTS."""
    normalized = _PRODUCT_LANGUAGE_ALIASES.get(language.strip().lower().replace("_", "-"))
    if normalized is None:
        raise TTSProviderError("unsupported_voice", "PocketTTS language is unavailable")
    return normalized


def resolve_pockettts_config(
    language: str,
    quality_tier: PocketTTSQualityTier,
    *,
    config_id: str | None = None,
) -> PocketTTSConfigInfo:
    """Resolve provider-neutral language/tier settings to a pinned config."""
    if quality_tier not in ("compact", "quality"):
        raise TTSProviderError("unsupported_voice", "PocketTTS quality tier is unavailable")

    product_language = normalize_pockettts_language(language)
    if config_id is not None:
        if config_id == "french":
            raise TTSProviderError("unsupported_voice", "PocketTTS language is unavailable")
        info = POCKETTTS_CONFIGS.get(config_id)
        if info is None or info.product_language != product_language:
            raise TTSProviderError("unsupported_voice", "PocketTTS config is unavailable")
        if info.compatibility_only and config_id not in _ENGLISH_LEGACY_CONFIGS:
            raise TTSProviderError("unsupported_voice", "PocketTTS config is unavailable")
        return info

    resolved = _CONFIG_BY_LANGUAGE_AND_TIER.get((product_language, quality_tier))
    if resolved is None:
        raise TTSProviderError("unsupported_voice", "PocketTTS language tier is unavailable")
    return POCKETTTS_CONFIGS[resolved]


def _load_pockettts_model_class() -> Any:
    try:
        module = importlib.import_module("pocket_tts")
    except Exception as exc:
        raise TTSProviderError("unavailable", "PocketTTS is unavailable") from exc
    try:
        return module.TTSModel
    except AttributeError as exc:
        raise TTSProviderError("unavailable", "PocketTTS is unavailable") from exc


def _resident_identity(
    *,
    config_info: PocketTTSConfigInfo,
    model_revision: str,
    model: Any,
) -> str:
    """Build a path-free resident model identity."""
    digest = hashlib.sha256()
    digest.update(b"pockettts-provider-v1")
    digest.update(b"\0config:")
    digest.update(config_info.config_id.encode("utf-8"))
    digest.update(b"\0language:")
    digest.update(config_info.product_language.encode("utf-8"))
    digest.update(b"\0layers:")
    digest.update(str(config_info.layer_count).encode("ascii"))
    digest.update(b"\0revision:")
    digest.update(model_revision.encode("utf-8"))
    origin = getattr(model, "origin", None)
    if origin is not None:
        digest.update(b"\0origin-name:")
        digest.update(getattr(origin, "name", str(origin).split("/")[-1]).encode("utf-8"))
    return (
        f"pockettts:{config_info.product_language}:{config_info.config_id}:"
        f"layers-{config_info.layer_count}:sha256:{digest.hexdigest()[:24]}"
    )


def _flatten_audio_values(audio: Any) -> list[float]:
    """Convert common tensor/array/list audio shapes to a flat float list."""
    value = audio
    for method_name in ("detach", "cpu"):
        method = getattr(value, method_name, None)
        if callable(method):
            value = method()
    numpy_method = getattr(value, "numpy", None)
    if callable(numpy_method):
        value = numpy_method()
    tolist_method = getattr(value, "tolist", None)
    if callable(tolist_method):
        value = tolist_method()

    flattened: list[float] = []

    def append(item: Any) -> None:
        if isinstance(item, (bytes, bytearray, memoryview)):
            raise TTSProviderError("invalid_audio", "PocketTTS produced unsupported audio")
        if isinstance(item, Iterable) and not isinstance(item, (str, bytes, bytearray)):
            for child in item:
                append(child)
            return
        try:
            sample = float(item)
        except (TypeError, ValueError) as exc:
            raise TTSProviderError("invalid_audio", "PocketTTS produced unsupported audio") from exc
        if not math.isfinite(sample):
            raise TTSProviderError("invalid_audio", "PocketTTS produced invalid audio")
        flattened.append(max(-1.0, min(1.0, sample)))

    append(value)
    return flattened


def _audio_to_pcm16(audio: Any) -> bytes:
    pcm = bytearray()
    for sample in _flatten_audio_values(audio):
        integer = int(round(sample * 32767.0))
        pcm.extend(integer.to_bytes(2, byteorder="little", signed=True))
    if not pcm:
        raise TTSProviderError("invalid_audio", "PocketTTS produced empty audio")
    return bytes(pcm)


def _duration_ms(audio: bytes, sample_rate: int, channels: int = 1) -> float:
    return (len(audio) / (sample_rate * channels * 2)) * 1000


class PocketTTSProvider:
    """Provider wrapper for official PocketTTS model inference."""

    provider_id = "pockettts"

    def __init__(
        self,
        config: PocketTTSProviderConfig,
        *,
        model_class: Any | None = None,
    ) -> None:
        self._config = config
        self._model_class = model_class
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="aurora-pockettts")
        self._entry_lock = asyncio.Lock()
        self._state_lock = asyncio.Lock()
        self._loaded: _LoadedPocketTTSState | None = None
        self._started = False
        self._stopping = False
        self._queued_requests: set[str] = set()
        self._active_requests: set[str] = set()
        self._cancelled_requests: set[str] = set()
        self._last_error: str | None = None

    @property
    def capabilities(self) -> TTSProviderCapabilities:
        """Return conservative PocketTTS capabilities."""
        return TTSProviderCapabilities(
            provider_id=self.provider_id,
            voice_selection_mode=VoiceSelectionMode.SHARED_MODEL_STATE,
            max_resident_base_models=1,
            supports_finite_synthesis=True,
            supports_streaming=True,
            supports_cancel=True,
            supports_inflight_cancel=False,
            supported_formats=("raw", "wav"),
        )

    @property
    def base_identity(self) -> str | None:
        """Return the resident model identity when loaded."""
        return self._loaded.base_identity if self._loaded is not None else None

    async def start(self) -> None:
        """Load PocketTTS resources when preload is enabled."""
        if not self._config.preload:
            async with self._state_lock:
                self._started = True
                self._stopping = False
            return
        loaded = await asyncio.wait_for(
            self._build_loaded_state(self._config),
            timeout=self._config.init_timeout_s,
        )
        async with self._state_lock:
            self._loaded = loaded
            self._started = True
            self._stopping = False
            self._last_error = None

    async def reload(self, config: PocketTTSProviderConfig) -> None:
        """Atomically reload PocketTTS resources, retaining old state on failure."""
        try:
            loaded = await asyncio.wait_for(
                self._build_loaded_state(config),
                timeout=config.init_timeout_s,
            )
        except TTSProviderError as exc:
            async with self._state_lock:
                self._last_error = str(exc)
            raise
        async with self._state_lock:
            self._config = config
            self._loaded = loaded
            self._started = True
            self._last_error = None

    async def stop(self) -> None:
        """Stop accepting work and wait for active model entry to drain."""
        async with self._state_lock:
            self._started = False
            self._stopping = True
            self._cancelled_requests.update(self._queued_requests)
            self._cancelled_requests.update(self._active_requests)
        async with self._entry_lock:
            pass
        await asyncio.to_thread(self._executor.shutdown, True, cancel_futures=True)
        async with self._state_lock:
            self._loaded = None
            self._queued_requests.clear()
            self._active_requests.clear()
            self._cancelled_requests.clear()
            self._stopping = False

    async def health(self) -> TTSProviderHealth:
        """Return readiness for the loaded PocketTTS base model."""
        async with self._state_lock:
            ready = self._started and self._loaded is not None and not self._stopping
            loaded = self._loaded
            error = None if ready else self._last_error or "unavailable"
            active_voice = next(iter(loaded.voice_states), None) if loaded is not None else None
        return TTSProviderHealth(
            provider_id=self.provider_id,
            ready=ready,
            active_voice=active_voice,
            base_identity=loaded.base_identity if ready and loaded is not None else None,
            error=error,
        )

    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        """Return ready logical voice states for the resident base model."""
        async with self._state_lock:
            loaded = self._loaded
            ready = self._started and loaded is not None and not self._stopping
            config = self._config
        if loaded is None:
            return ()
        names = {voice.voice_id: voice.display_name for voice in config.voices}
        return tuple(
            TTSVoiceInfo(
                voice_id=voice_id,
                display_name=names.get(voice_id) or voice_id,
                ready=ready,
                language=loaded.config_info.product_language,
            )
            for voice_id in loaded.voice_states
        )

    async def cancel(self, request_id: str) -> None:
        """Mark queued or active work as cancelled."""
        async with self._state_lock:
            if request_id in self._queued_requests or request_id in self._active_requests:
                self._cancelled_requests.add(request_id)

    async def tracked_request_count(self) -> int:
        """Return tracked request state count for lifecycle tests."""
        async with self._state_lock:
            return (
                len(self._queued_requests)
                + len(self._active_requests)
                + len(self._cancelled_requests)
            )

    async def synthesize(self, request: TTSSynthesisRequest) -> TTSSynthesisResult:
        """Synthesize finite audio through PocketTTS without blocking the loop."""
        loaded = await self._ready_loaded_state()
        voice_id, voice_state = self._resolve_voice(loaded, request.voice)
        await self._register_request(request.request_id)
        try:
            await self._reject_if_cancelled(request.request_id)
            audio = await self._run_model_entry(
                request.request_id,
                lambda: loaded.model.generate_audio(
                    voice_state,
                    request.text,
                    max_tokens=loaded.config.max_tokens,
                    frames_after_eos=loaded.config.frames_after_eos,
                    copy_state=True,
                ),
                timeout_s=loaded.config.request_timeout_s,
                queue_timeout_s=loaded.config.queue_timeout_s,
            )
            await self._reject_if_cancelled(request.request_id)
            pcm = _audio_to_pcm16(audio)
            output = (
                pcm_to_wav_bytes(pcm, sample_rate=loaded.sample_rate)
                if request.audio_format == "wav"
                else pcm
            )
            return TTSSynthesisResult(
                audio=output,
                audio_format=request.audio_format,
                sample_rate=loaded.sample_rate,
                channels=1,
                duration_ms=_duration_ms(pcm, loaded.sample_rate),
                voice=voice_id,
            )
        finally:
            await self._cleanup_request(request.request_id)

    async def stream(self, request: TTSSynthesisRequest) -> AsyncIterator[TTSStreamChunk]:
        """Stream ordered PocketTTS chunks normalized to PCM."""
        loaded = await self._ready_loaded_state()
        _voice_id, voice_state = self._resolve_voice(loaded, request.voice)
        await self._register_request(request.request_id)
        try:
            await self._reject_if_cancelled(request.request_id)
            chunks = await self._run_model_entry(
                request.request_id,
                lambda: list(
                    loaded.model.generate_audio_stream(
                        voice_state,
                        request.text,
                        max_tokens=loaded.config.max_tokens,
                        frames_after_eos=loaded.config.frames_after_eos,
                        copy_state=True,
                    )
                ),
                timeout_s=loaded.config.request_timeout_s,
                queue_timeout_s=loaded.config.queue_timeout_s,
            )
            for sequence, chunk in enumerate(chunks):
                await self._reject_if_cancelled(request.request_id)
                pcm = _audio_to_pcm16(chunk)
                yield TTSStreamChunk(
                    sequence=sequence,
                    audio=pcm,
                    sample_rate=loaded.sample_rate,
                    channels=1,
                    duration_ms=_duration_ms(pcm, loaded.sample_rate),
                )
            yield TTSStreamChunk(
                sequence=len(chunks),
                audio=b"",
                sample_rate=loaded.sample_rate,
                channels=1,
                is_final=True,
            )
        finally:
            await self._cleanup_request(request.request_id)

    async def _ready_loaded_state(self) -> _LoadedPocketTTSState:
        async with self._state_lock:
            if not self._started or self._loaded is None or self._stopping:
                raise TTSProviderError("unavailable", "TTS provider is unavailable")
            return self._loaded

    async def _build_loaded_state(self, config: PocketTTSProviderConfig) -> _LoadedPocketTTSState:
        config_info = resolve_pockettts_config(
            config.effective_language,
            config.quality_tier,
            config_id=config.config_id,
        )

        def load() -> _LoadedPocketTTSState:
            model_class = self._model_class or _load_pockettts_model_class()
            model = model_class.load_model(language=config_info.config_id, quantize=config.quantize)
            sample_rate = int(getattr(model, "sample_rate", 24000) or 24000)
            voice_states = {
                voice.voice_id: model.get_state_for_audio_prompt(voice.audio_prompt)
                for voice in config.voices
            }
            return _LoadedPocketTTSState(
                config=config,
                config_info=config_info,
                model=model,
                sample_rate=sample_rate,
                voice_states=voice_states,
                base_identity=_resident_identity(
                    config_info=config_info,
                    model_revision=config.model_revision,
                    model=model,
                ),
            )

        return await self._run_model_entry(
            None,
            load,
            timeout_s=config.init_timeout_s,
            queue_timeout_s=config.queue_timeout_s,
        )

    def _resolve_voice(self, loaded: _LoadedPocketTTSState, voice: str | None) -> tuple[str, Any]:
        voice_id = voice or next(iter(loaded.voice_states), None)
        if voice_id is None or voice_id not in loaded.voice_states:
            raise TTSProviderError("unsupported_voice", "Requested voice is unavailable")
        return voice_id, loaded.voice_states[voice_id]

    async def _register_request(self, request_id: str | None) -> None:
        if request_id is None:
            return
        async with self._state_lock:
            self._queued_requests.add(request_id)

    async def _activate_request(self, request_id: str | None) -> None:
        if request_id is None:
            return
        async with self._state_lock:
            self._queued_requests.discard(request_id)
            self._active_requests.add(request_id)

    async def _cleanup_request(self, request_id: str | None) -> None:
        if request_id is None:
            return
        async with self._state_lock:
            self._queued_requests.discard(request_id)
            self._active_requests.discard(request_id)
            self._cancelled_requests.discard(request_id)

    async def _reject_if_cancelled(self, request_id: str | None) -> None:
        if request_id is None:
            return
        async with self._state_lock:
            if request_id in self._cancelled_requests:
                raise TTSProviderError("cancelled", "TTS request was cancelled")

    async def _run_model_entry(
        self,
        request_id: str | None,
        func: Any,
        *,
        timeout_s: float,
        queue_timeout_s: float,
    ) -> Any:
        try:
            await asyncio.wait_for(self._entry_lock.acquire(), timeout=queue_timeout_s)
        except TimeoutError as exc:
            raise TTSProviderError("resource_exhausted", "TTS provider is busy") from exc
        try:
            await self._activate_request(request_id)
            await self._reject_if_cancelled(request_id)
            loop = asyncio.get_running_loop()
            try:
                return await asyncio.wait_for(
                    loop.run_in_executor(self._executor, func),
                    timeout=timeout_s,
                )
            except TimeoutError as exc:
                log_warning("PocketTTS model entry timed out")
                raise TTSProviderError("resource_exhausted", "TTS provider is busy") from exc
            except TTSProviderError:
                raise
            except Exception as exc:
                log_debug(f"PocketTTS provider failure type={type(exc).__name__}")
                raise TTSProviderError("unavailable", "PocketTTS synthesis failed") from exc
        finally:
            self._entry_lock.release()
