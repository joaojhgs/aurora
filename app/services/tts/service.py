"""Text-to-Speech Service for Aurora's parallel architecture.

This service:
- Processes TTS requests
- Manages audio playback with RealtimeTTS
- Emits TTS lifecycle events
- Handles interruptions and queue management
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import uuid
import wave
from collections.abc import AsyncIterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import Envelope
from app.services.tts.piper_catalog import (
    CATALOG_REVISION as PIPER_CATALOG_REVISION,
    PiperCatalogManager,
    piper_cache_dir_from_config,
)
from app.services.tts.playback import create_pcm_playback, create_realtime_piper_stream
from app.services.tts.providers.base import (
    TTSProvider,
    TTSProviderError,
    TTSStreamChunk as ProviderStreamChunk,
    TTSSynthesisRequest as ProviderSynthesisRequest,
)
from app.services.tts.providers.piper import PiperTTSProvider, PiperVoiceConfig
from app.services.tts.providers.pockettts import (
    PocketTTSProvider,
    PocketTTSProviderConfig,
    PocketTTSVoiceStateConfig,
    derive_pockettts_voice_state_artifact,
    resolve_pockettts_base_identity_spec,
)
from app.services.tts.voice_catalog import (
    VoiceCatalogError,
    VoiceCatalogInstaller,
    VoiceCatalogSourceError,
)
from app.services.tts.voice_registry import (
    ExportedCloneVoiceState,
    VoiceRegistry,
    VoiceRegistryError,
)
from app.shared.config.interface import ConfigAPI
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import System, Tts
from app.shared.contracts.models.auth import AuthMethods, StoreAuditEventRequest
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.speech import (
    SpeechStorageSummary,
    normalize_exact_speech_language,
    validate_logical_voice_id,
)
from app.shared.contracts.models.tts import (
    VOICE_IMPORT_MAX_DURATION_MS,
    VOICE_STATE_TRANSFER_MAX_BYTES,
    TTSAudioChunkEvent,
    TTSCapabilities,
    TTSCloneVoiceStateBundle,
    TTSCreateVoiceProfileRequest,
    TTSCreateVoiceProfileResponse,
    TTSDeleteVoiceProfileRequest,
    TTSDeleteVoiceProfileResponse,
    TTSExportVoiceProfileRequest,
    TTSExportVoiceProfileResponse,
    TTSGetCapabilitiesRequest,
    TTSGetCapabilitiesResponse,
    TTSGetVoiceProfileRequest,
    TTSGetVoiceProfileResponse,
    TTSImportVoiceProfileRequest,
    TTSImportVoiceProfileResponse,
    TTSInstallVoiceProfileRequest,
    TTSInstallVoiceProfileResponse,
    TTSLanguagePackDescriptor,
    TTSLanguagePackVoice,
    TTSListLanguagePacksRequest,
    TTSListLanguagePacksResponse,
    TTSListVoiceProfilesRequest,
    TTSListVoiceProfilesResponse,
    TTSListVoicesRequest,
    TTSListVoicesResponse,
    TTSMethods,
    TTSModule,
    TTSRemoveVoiceProfileRequest,
    TTSRemoveVoiceProfileResponse,
    TTSRequest,
    TTSResidentLanguagePack,
    TTSSetDefaultVoiceRequest,
    TTSSetDefaultVoiceResponse,
    TTSStopRequest,
    TTSStreamChunkRequest,
    TTSStreamEndRequest,
    TTSStreamStartRequest,
    TTSSynthesizeRequest,
    TTSSynthesizeResponse,
    TTSUpdateVoiceProfileRequest,
    TTSUpdateVoiceProfileResponse,
    TTSVoiceDescriptor,
    TTSVoiceImportAbortRequest,
    TTSVoiceImportAbortResponse,
    TTSVoiceImportChunkRequest,
    TTSVoiceImportChunkResponse,
    TTSVoiceImportEndRequest,
    TTSVoiceImportEndResponse,
    TTSVoiceImportStartRequest,
    TTSVoiceImportStartResponse,
    TTSVoiceProfileDescriptor,
)
from app.shared.contracts.registry import method_contract
from app.shared.messaging.models.tts_models import (
    TTSError as TTSErrorEvent,
    TTSPaused,
    TTSResumed,
    TTSStarted,
    TTSStopped,
)
from app.shared.path_utils import resolve_path
from app.shared.services.base_service import BaseService
from app.shared.speech_language_policy import resolve_speech_language_policy

config_api = ConfigAPI()
_GLOBAL_TTS_STREAM_CLEAR = object()
_MAX_VOICE_IMPORT_SESSIONS = 64
_MAX_VOICE_IMPORT_SESSIONS_PER_OWNER = 8


def _text_log_metadata(text: str) -> str:
    """Return bounded non-content metadata for private speech text."""
    return f"text_chars={len(text)}"


def _safe_tts_error(exc: Exception) -> str:
    """Return a stable non-sensitive error code for logs and events."""
    if isinstance(exc, TTSProviderError):
        return f"tts_provider_{exc.code}"
    if isinstance(exc, (VoiceCatalogError, VoiceRegistryError)):
        return "tts_voice_management_failed"
    return f"tts_{type(exc).__name__.lower()}"


def _safe_tts_event_error(exc: Exception) -> str:
    """Return a product-safe TTS error event message."""
    if isinstance(exc, TTSProviderError) and exc.code in {
        "unsupported_voice",
        "unavailable",
        "capability_changed",
    }:
        return "TTS voice is unavailable"
    if isinstance(exc, TTSProviderError) and exc.code == "cancelled":
        return "TTS request was cancelled"
    return "TTS request failed"


def _trusted_manifest_keys(registry_cfg: object | None) -> tuple[str, ...]:
    """Normalize generated config root models into raw public-key strings."""
    keys = getattr(registry_cfg, "trusted_manifest_public_keys", None)
    if not keys:
        return ()
    return tuple(str(getattr(key, "root", key)) for key in keys if str(getattr(key, "root", key)))


@dataclass
class _TTSStreamState:
    """Internal ordered state for a text-to-audio stream."""

    stream_id: str
    audio_format: str
    requested_sample_rate: int | None
    voice: str | None
    speed: float
    play_on_server: bool
    correlation_id: str | None = None
    caller_peer_id: str | None = None
    principal_id: str | None = None
    pending: dict[int, str] = field(default_factory=dict)
    next_text_sequence: int = 0
    next_audio_sequence: int = 0
    final_text_sequence: int | None = None
    end_reason: str = "completed"
    emitted_sample_rate: int = 0
    draining: bool = False
    provider_request_ids: set[str] = field(default_factory=set)


@dataclass
class _VoiceImportSession:
    upload_id: str
    owner: str
    operation_id: str
    expected_total_bytes: int
    expected_sha256: str
    audio_format: str
    sample_rate: int
    channels: int
    sample_width_bytes: int
    duration_ms: int | None
    expires_at: datetime
    chunks: dict[int, bytes] = field(default_factory=dict)
    sealed_ref: str | None = None


@dataclass(frozen=True)
class _LanguagePackInventory:
    packs: list[TTSLanguagePackDescriptor]
    catalog_status: Literal["available", "unavailable"]
    catalog_error_code: Literal["catalog_unavailable"] | None
    default_voice_id: str | None
    stale_default_voice_id: str | None


def _clean_envelope_string(value: object) -> str | None:
    """Return a non-empty envelope string value, if present."""
    if isinstance(value, str) and value.strip():
        return value
    return None


def _envelope_caller_peer_id(envelope: Envelope | None) -> str | None:
    """Extract the stable caller peer id from a bus envelope."""
    if envelope is None:
        return None
    return _clean_envelope_string(getattr(envelope, "caller_peer_id", None))


def _envelope_principal_id(envelope: Envelope | None) -> str | None:
    """Extract the authenticated principal id from a bus envelope."""
    if envelope is None:
        return None
    return _clean_envelope_string(getattr(envelope, "principal_id", None))


def _envelope_correlation_id(envelope: Envelope | None) -> str | None:
    """Extract the correlation id from a bus envelope."""
    if envelope is None:
        return None
    return _clean_envelope_string(getattr(envelope, "correlation_id", None))


def _stream_update_allowed(
    state: _TTSStreamState,
    envelope: Envelope | None,
    correlation_id: str | None = None,
) -> bool:
    """Return whether an incoming envelope may mutate an existing stream."""
    if _envelope_caller_peer_id(envelope) != state.caller_peer_id:
        return False
    if _envelope_principal_id(envelope) != state.principal_id:
        return False
    if state.correlation_id is None:
        return True
    return (correlation_id or _envelope_correlation_id(envelope)) == state.correlation_id


def _stream_matches_owner(
    state: _TTSStreamState,
    *,
    caller_peer_id: str | None,
    principal_id: str | None,
    correlation_id: str | None,
    stream_id: str | None = None,
    require_correlation: bool = True,
) -> bool:
    """Return whether a stream is owned by the requested scoped stop/interrupt."""
    if stream_id is not None and state.stream_id != stream_id:
        return False
    if state.caller_peer_id != caller_peer_id:
        return False
    if state.principal_id != principal_id:
        return False
    if require_correlation:
        return correlation_id is not None and state.correlation_id == correlation_id
    return True


def _close_voice_config_handles(voices: list[PocketTTSVoiceStateConfig]) -> None:
    """Close registry handles that have not yet been transferred to a provider."""
    for voice in voices:
        with contextlib.suppress(OSError):
            os.close(voice.artifact_handle.fd)


def _profile_kind(kind: str) -> str:
    return "cloned" if kind == "clone" else "standard"


def _voice_language_pack(language: str | None) -> str | None:
    if language is None:
        return None
    try:
        return normalize_exact_speech_language(language)
    except ValueError:
        return None


def _piper_voice_slug(value: str) -> str:
    slug = "".join(ch if ch.isalnum() else "-" for ch in value.strip().lower())
    slug = "-".join(part for part in slug.split("-") if part)
    return slug[:64] or "default"


def _duration_ms_from_frames(frames: int, sample_rate: int) -> int:
    return round(frames * 1000 / sample_rate)


def _validate_import_audio_payload(payload: bytes, session: _VoiceImportSession) -> None:
    _voice_import_duration_ms(payload, session)


def _voice_import_duration_ms(payload: bytes, session: _VoiceImportSession) -> int:
    frame_size = session.channels * session.sample_width_bytes
    if frame_size <= 0:
        raise ValueError("voice import audio metadata is invalid")
    if session.audio_format == "pcm_s16le":
        if session.sample_width_bytes != 2:
            raise ValueError("pcm_s16le voice import requires 16-bit samples")
        if len(payload) % frame_size != 0:
            raise ValueError("pcm_s16le voice import frame length mismatch")
        frames = len(payload) // frame_size
    elif session.audio_format == "wav":
        try:
            with wave.open(io.BytesIO(payload), "rb") as wav_file:
                if wav_file.getnchannels() != session.channels:
                    raise ValueError("wav voice import channel mismatch")
                if wav_file.getsampwidth() != session.sample_width_bytes:
                    raise ValueError("wav voice import sample width mismatch")
                if wav_file.getframerate() != session.sample_rate:
                    raise ValueError("wav voice import sample rate mismatch")
                frames = wav_file.getnframes()
                frame_bytes = wav_file.readframes(frames)
        except (EOFError, wave.Error) as exc:
            raise ValueError("wav voice import is malformed") from exc
        if len(frame_bytes) != frames * frame_size:
            raise ValueError("wav voice import frame length mismatch")
    else:
        raise ValueError("voice import format is unsupported")
    if frames <= 0:
        raise ValueError("voice import audio must contain frames")
    duration_ms = _duration_ms_from_frames(frames, session.sample_rate)
    if duration_ms > VOICE_IMPORT_MAX_DURATION_MS:
        raise ValueError("voice import duration exceeds limit")
    if session.duration_ms is not None and duration_ms != session.duration_ms:
        raise ValueError("voice import duration mismatch")
    return duration_ms


_DUCKED_SINK_INPUTS: dict[str, int] = {}
_DUCKING_UNAVAILABLE_LOGGED = False


def _run_pactl(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - executable is resolved with shutil.which.
        args,
        check=True,
        capture_output=True,
        text=True,
        timeout=1.0,
    )


def _sink_input_volume_percent(sink_input: dict[str, Any]) -> int | None:
    volume = sink_input.get("volume")
    if not isinstance(volume, dict) or not volume:
        return None
    values: list[int] = []
    for channel in volume.values():
        if isinstance(channel, dict) and isinstance(channel.get("value_percent"), str):
            with contextlib.suppress(ValueError):
                values.append(int(channel["value_percent"].rstrip("%")))
        elif isinstance(channel, dict) and isinstance(channel.get("value"), int):
            values.append(round(channel["value"] * 100 / 65536))
    if not values:
        return None
    return max(0, min(150, round(sum(values) / len(values))))


def _log_ducking_unavailable(reason: str) -> None:
    global _DUCKING_UNAVAILABLE_LOGGED
    if _DUCKING_UNAVAILABLE_LOGGED:
        return
    _DUCKING_UNAVAILABLE_LOGGED = True
    log_debug(f"TTS audio ducking unavailable: {reason}")


def reduce_volume_except_current() -> None:
    """Lower other PulseAudio/PipeWire streams while Aurora is speaking."""
    if _DUCKED_SINK_INPUTS:
        return
    if not sys.platform.startswith("linux"):
        _log_ducking_unavailable("unsupported platform")
        return
    pactl = shutil.which("pactl")
    if pactl is None:
        _log_ducking_unavailable("pactl not found")
        return

    try:
        result = _run_pactl([pactl, "--format=json", "list", "sink-inputs"])
        sink_inputs = json.loads(result.stdout or "[]")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        _log_ducking_unavailable(_safe_tts_error(exc))
        return
    if not isinstance(sink_inputs, list):
        _log_ducking_unavailable("unexpected pactl response")
        return

    own_pid = str(os.getpid())
    for sink_input in sink_inputs:
        if not isinstance(sink_input, dict):
            continue
        index = sink_input.get("index")
        properties = sink_input.get("properties")
        if index is None or not isinstance(properties, dict):
            continue
        if str(properties.get("application.process.id")) == own_pid:
            continue
        previous_volume = _sink_input_volume_percent(sink_input)
        if previous_volume is None:
            continue
        sink_input_id = str(index)
        try:
            _run_pactl([pactl, "set-sink-input-volume", sink_input_id, "35%"])
        except (OSError, subprocess.SubprocessError) as exc:
            log_debug(
                f"TTS audio ducking skipped for stream {sink_input_id}: {_safe_tts_error(exc)}"
            )
            continue
        _DUCKED_SINK_INPUTS[sink_input_id] = previous_volume


def restore_volume_except_current() -> None:
    """Restore streams lowered by reduce_volume_except_current."""
    if not _DUCKED_SINK_INPUTS:
        return
    pactl = shutil.which("pactl")
    if pactl is None:
        _DUCKED_SINK_INPUTS.clear()
        _log_ducking_unavailable("pactl not found during restore")
        return
    restored = dict(_DUCKED_SINK_INPUTS)
    _DUCKED_SINK_INPUTS.clear()
    for sink_input_id, volume_percent in restored.items():
        try:
            _run_pactl([pactl, "set-sink-input-volume", sink_input_id, f"{volume_percent}%"])
        except (OSError, subprocess.SubprocessError) as exc:
            log_debug(
                f"TTS audio ducking restore skipped for stream {sink_input_id}: {_safe_tts_error(exc)}"
            )


# Service implementation
class TTSService(BaseService):
    """Text-to-Speech service.

    Responsibilities:
    - Process TTS requests
    - Manage audio synthesis and playback
    - Handle interruptions and queue
    - Emit lifecycle events
    """

    def __init__(self):
        """Initialize TTS service with RealtimeTTS engine."""
        super().__init__(
            module=TTSModule.NAME,
            summary="Text-to-Speech synthesis and playback service",
            capabilities=["speech_synthesis", "audio_playback"],
        )
        self._playing = False
        self._paused = False
        self._current_text: str | None = None
        self._current_request_id: str | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stream_states: dict[str, _TTSStreamState] = {}
        self._stream_state_lock = asyncio.Lock()
        self._voice_management_lock = asyncio.Lock()
        self._voice_revision = 0
        self._voice_operation_results: dict[tuple[str, str, str], tuple[str, Any]] = {}
        self._voice_import_sessions: dict[str, _VoiceImportSession] = {}
        self._provider: TTSProvider | None = None
        self.engine = None
        self._playback_generation = 0
        self._current_playback_generation: int | None = None
        self._playback_started = False
        self._active_playback_provider_request_ids: set[str] = set()
        self.stream = None  # Will be initialized in on_start()

    async def _stop_provider_safely(self, provider: TTSProvider, context: str) -> None:
        """Stop a provider during cleanup without masking the original failure."""
        try:
            await provider.stop()
        except Exception as cleanup_error:
            log_error(
                f"Failed to stop TTS provider after {context}: "
                f"error={_safe_tts_error(cleanup_error)}"
            )

    async def _stop_playback_stream(self, stream: object | None) -> None:
        """Stop and close a local playback stream when supported."""
        if stream is None:
            return
        stop = getattr(stream, "stop", None)
        if callable(stop):
            await asyncio.to_thread(stop)
        close = getattr(stream, "close", None)
        if callable(close):
            await asyncio.to_thread(close)

    async def _get_model_paths(self, tts_cfg: Tts | None = None) -> tuple[str, str | None]:
        """Get legacy Piper model paths from canonical config with flat-key compatibility."""
        tts_cfg = tts_cfg or await config_api.aget(ConfigKeys.services.tts, Tts)
        piper_cfg = tts_cfg.providers.piper if tts_cfg.providers else None
        model_path = (
            piper_cfg.model_file_path
            if piper_cfg and piper_cfg.model_file_path
            else tts_cfg.model_file_path
        )
        config_path = (
            piper_cfg.model_config_file_path
            if piper_cfg and piper_cfg.model_config_file_path
            else tts_cfg.model_config_file_path
        )
        if not model_path:
            raise TTSProviderError("unsupported_voice", "TTS voice is unavailable")
        model_file = resolve_path(model_path)
        config_file = resolve_path(config_path) if config_path else None
        return str(model_file), str(config_file) if config_file else None

    def _piper_catalog_manager(self, tts_cfg: Tts) -> PiperCatalogManager:
        """Return the pinned Piper catalog manager for this TTS config."""
        return PiperCatalogManager(cache_dir=piper_cache_dir_from_config(tts_cfg))

    def _resolve_piper_executable(self, tts_cfg: Tts) -> str:
        """Resolve the Piper executable from canonical config and local PATH."""
        piper_cfg = tts_cfg.providers.piper if tts_cfg.providers else None
        configured_piper_path = (
            piper_cfg.executable_path
            if piper_cfg and piper_cfg.executable_path
            else tts_cfg.piper_path or shutil.which("piper")
        )
        venv_piper_path = resolve_path(".venv/bin/piper")
        if not configured_piper_path and venv_piper_path.exists():
            configured_piper_path = str(venv_piper_path)
        return configured_piper_path or "piper"

    async def _effective_tts_language(self) -> str:
        """Resolve provider-neutral language policy for language-bound TTS models."""
        system_cfg = await config_api.aget(ConfigKeys.system, System)
        if not isinstance(system_cfg, System):
            system_cfg = System()
        policy = resolve_speech_language_policy(
            system_cfg.primary_language,
            system_cfg.voice_language,
        )
        return policy.model_language

    async def _pockettts_voice_configs(
        self,
        tts_cfg: Tts,
        provider_config: PocketTTSProviderConfig,
    ) -> tuple[PocketTTSVoiceStateConfig, ...]:
        """Resolve ready PocketTTS voice states from the local voice registry."""
        pocket_cfg = tts_cfg.providers.pockettts if tts_cfg.providers else None
        registry_cfg = tts_cfg.voice_registry
        registry_cache_dir = (
            registry_cfg.cache_dir
            if registry_cfg and registry_cfg.cache_dir
            else "voice_models/voice-pack"
        )
        standard_enabled = (
            registry_cfg.standard_pack_enabled
            if registry_cfg and registry_cfg.standard_pack_enabled is not None
            else True
        )
        cloning_enabled = (
            registry_cfg.cloning_enabled
            if registry_cfg and registry_cfg.cloning_enabled is not None
            else True
        )
        registry = VoiceRegistry(resolve_path(registry_cache_dir))
        identity = resolve_pockettts_base_identity_spec(provider_config).voice_base_identity
        configured_voice_ids = list(pocket_cfg.preload_voice_ids or ()) if pocket_cfg else []
        requested_voice_ids = tuple(
            dict.fromkeys(
                [
                    *([tts_cfg.default_voice_id] if tts_cfg.default_voice_id else []),
                    *configured_voice_ids,
                ]
            )
        )
        resolved: list[PocketTTSVoiceStateConfig] = []
        try:

            def kind_allowed(kind: str) -> bool:
                return (kind == "standard" and standard_enabled) or (
                    kind == "clone" and cloning_enabled
                )

            if requested_voice_ids:
                catalog = await registry.catalog(identity, include_private=True)
                entries = {entry.voice_id: entry for entry in catalog if entry.ready}
                for voice_id in requested_voice_ids:
                    entry = entries.get(voice_id)
                    if entry is None or not kind_allowed(entry.kind):
                        raise TTSProviderError(
                            "unsupported_voice", "PocketTTS voice is unavailable"
                        )
                    resolved.append(
                        PocketTTSVoiceStateConfig(
                            voice_id=voice_id,
                            display_name=entry.display_name,
                            artifact_handle=await registry.resolve_voice_state_artifact(
                                voice_id, identity
                            ),
                        )
                    )
                return tuple(resolved)
            catalog = tuple(
                entry
                for entry in await registry.catalog(identity, include_private=True)
                if entry.ready and kind_allowed(entry.kind)
            )
            if not catalog:
                raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
            for entry in catalog:
                resolved.append(
                    PocketTTSVoiceStateConfig(
                        voice_id=entry.voice_id,
                        display_name=entry.display_name,
                        artifact_handle=await registry.resolve_voice_state_artifact(
                            entry.voice_id, identity
                        ),
                    )
                )
            return tuple(resolved)
        except TTSProviderError:
            _close_voice_config_handles(resolved)
            raise
        except VoiceRegistryError as exc:
            _close_voice_config_handles(resolved)
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable") from exc
        except asyncio.CancelledError:
            _close_voice_config_handles(resolved)
            raise
        except Exception as exc:
            _close_voice_config_handles(resolved)
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable") from exc

    async def _pockettts_provider_config(self, tts_cfg: Tts) -> PocketTTSProviderConfig:
        """Resolve PocketTTS config shared by runtime load and clone derivation."""
        pocket_cfg = tts_cfg.providers.pockettts if tts_cfg.providers else None
        if pocket_cfg is not None and pocket_cfg.custom_config_path:
            raise TTSProviderError("unsupported_voice", "PocketTTS custom config is unavailable")
        return PocketTTSProviderConfig(
            effective_language=await self._effective_tts_language(),
            quality_tier=(
                pocket_cfg.quality_tier if pocket_cfg and pocket_cfg.quality_tier else "compact"
            ),
            preload=(
                pocket_cfg.preload_model
                if pocket_cfg and pocket_cfg.preload_model is not None
                else False
            ),
            quantize=bool(pocket_cfg.quantize) if pocket_cfg else False,
            device=(pocket_cfg.device if pocket_cfg and pocket_cfg.device else "cpu"),
            temperature=pocket_cfg.temperature if pocket_cfg else None,
            lsd_decode_steps=pocket_cfg.lsd_decode_steps if pocket_cfg else None,
            noise_clamp=pocket_cfg.noise_clamp if pocket_cfg else None,
            eos_threshold=pocket_cfg.eos_threshold if pocket_cfg else None,
            request_timeout_s=(
                pocket_cfg.request_timeout_s
                if pocket_cfg and pocket_cfg.request_timeout_s is not None
                else 120.0
            ),
            init_timeout_s=(
                pocket_cfg.initialization_timeout_s
                if pocket_cfg and pocket_cfg.initialization_timeout_s is not None
                else 120.0
            ),
        )

    async def _build_pockettts_runtime(self, tts_cfg: Tts) -> tuple[TTSProvider, object, object]:
        """Build PocketTTS provider plus provider-neutral PCM playback."""
        provider_config = await self._pockettts_provider_config(tts_cfg)
        provider_config = replace(
            provider_config,
            voices=await self._pockettts_voice_configs(tts_cfg, provider_config),
        )
        provider = PocketTTSProvider(provider_config)
        try:
            await provider.start()
            stream = create_pcm_playback(
                on_audio_stream_start=self._on_pcm_audio_start,
                on_audio_stream_stop=self._on_pcm_audio_stop,
                on_audio_stream_error=self._on_pcm_audio_error,
            )
        except Exception:
            await self._stop_provider_safely(provider, "PocketTTS runtime construction failure")
            raise
        return provider, None, stream

    async def _build_runtime(self) -> tuple[TTSProvider, object, object]:
        """Build provider plus local playback stream without mutating current state."""
        tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
        if tts_cfg.provider == "pockettts":
            return await self._build_pockettts_runtime(tts_cfg)
        if tts_cfg.provider not in (None, "piper"):
            raise TTSProviderError("unavailable", "Configured TTS provider is unavailable")

        piper_path = self._resolve_piper_executable(tts_cfg)
        configured_voice_id = tts_cfg.default_voice_id
        if configured_voice_id and configured_voice_id != "default" and ":" in configured_voice_id:
            selected_voice = await self._piper_catalog_manager(tts_cfg).resolve_voice(
                validate_logical_voice_id(configured_voice_id)
            )
            model_file = str(selected_voice.model_file)
            config_file = str(selected_voice.config_file)
            sample_rate = selected_voice.sample_rate
            voice_id = selected_voice.voice_id
            display_name = selected_voice.display_name
            effective_language = selected_voice.language
        else:
            model_file, config_file = await self._get_model_paths(tts_cfg)
            if not Path(model_file).is_file() or not (config_file and Path(config_file).is_file()):
                raise TTSProviderError("unsupported_voice", "TTS voice is unavailable")
            piper_cfg = tts_cfg.providers.piper if tts_cfg.providers else None
            sample_rate = (
                piper_cfg.model_sample_rate
                if piper_cfg and piper_cfg.model_sample_rate is not None
                else tts_cfg.model_sample_rate
                if tts_cfg.model_sample_rate is not None
                else 22050
            )
            effective_language = _voice_language_pack(await self._effective_tts_language())
            if effective_language is None:
                raise TTSProviderError("unsupported_voice", "TTS language is unavailable")
            if (
                configured_voice_id
                and configured_voice_id != "default"
                and ":" not in configured_voice_id
            ):
                voice_id = f"standard:piper:{_piper_voice_slug(configured_voice_id)}"
            else:
                voice_id = f"standard:piper:{effective_language}"
            display_name = "Piper"
        voice_config = PiperVoiceConfig(
            voice_id=voice_id,
            model_file=model_file,
            config_file=config_file,
            display_name=display_name,
            expected_sample_rate=sample_rate,
            language=effective_language,
        )
        provider = PiperTTSProvider(
            piper_path=piper_path,
            voice=voice_config,
            use_cuda=bool(tts_cfg.hardware_acceleration),
        )
        await provider.start()
        try:
            engine, stream = create_realtime_piper_stream(
                piper_path=piper_path,
                model_file=model_file,
                config_file=config_file,
                sample_rate=sample_rate,
                on_audio_stream_start=self._on_audio_start,
                on_audio_stream_stop=self._on_audio_stop,
            )
        except Exception:
            await self._stop_provider_safely(provider, "runtime construction failure")
            raise
        return provider, engine, stream

    async def _initialize_engine(self) -> None:
        """Initialize the configured TTS provider and local playback stream."""
        try:
            provider, engine, stream = await self._build_runtime()
            old_provider = self._provider
            self._provider = provider
            self.engine = engine
            self.stream = stream
            if old_provider is not None:
                await old_provider.stop()

            log_info("TTS engine initialized successfully")

        except Exception as e:
            log_error(f"Failed to initialize TTS engine: error={_safe_tts_error(e)}")
            raise

    async def _initialize_engine_fail_soft(self, context: str) -> bool:
        """Try to initialize runtime while keeping voice management available."""
        try:
            await self._initialize_engine()
            return True
        except Exception as exc:
            self._provider = None
            self.engine = None
            self.stream = None
            log_error(
                f"TTS runtime unavailable during {context}: error={_safe_tts_error(exc)}",
            )
            return False

    def _on_audio_start(self):
        """Called when audio stream starts playing."""
        reduce_volume_except_current()
        log_debug("Audio stream started")

    def _on_audio_stop(self):
        """Called when audio stream stops playing."""
        restore_volume_except_current()
        log_info("Audio stream stopped - emitting TTS stopped event")

        # Emit stopped event when audio finishes
        if self._loop and self._playing:
            request_id = self._current_request_id
            self._playing = False
            self._current_text = None
            self._current_request_id = None

            asyncio.run_coroutine_threadsafe(
                self.bus.publish(
                    TTSMethods.STOPPED,
                    TTSStopped(request_id=request_id, reason="completed"),
                    event=True,
                    mesh=False,
                    origin="internal",
                ),
                self._loop,
            )

    def _on_pcm_audio_start(self, playback_id: int | None = None) -> None:
        """Called when tokenized PCM audio starts playing."""
        del playback_id
        self._on_audio_start()

    def _on_pcm_audio_stop(self, playback_id: int | None = None) -> None:
        """Called when tokenized PCM audio finishes normally."""
        restore_volume_except_current()
        if playback_id is None or self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(
            self._complete_pcm_playback(playback_id, "completed"),
            self._loop,
        )

    def _on_pcm_audio_error(
        self, playback_id: int | None = None, error: Exception | None = None
    ) -> None:
        """Called when tokenized PCM audio output fails."""
        restore_volume_except_current()
        if playback_id is None or self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(
            self._fail_pcm_playback(playback_id, error),
            self._loop,
        )

    async def _complete_pcm_playback(self, playback_id: int, reason: str) -> None:
        """Emit terminal playback event only for the current committed PCM playback."""
        if playback_id != self._current_playback_generation:
            return
        if not self._playing or not self._playback_started:
            return
        request_id = self._current_request_id
        self._clear_playback_state()
        await self.bus.publish(
            TTSMethods.STOPPED,
            TTSStopped(request_id=request_id, reason=reason),
            event=True,
            mesh=False,
            origin="internal",
        )

    async def _fail_pcm_playback(self, playback_id: int, error: Exception | None = None) -> None:
        """Publish playback failure for the current PCM playback."""
        if playback_id != self._current_playback_generation:
            return
        request_id = self._current_request_id
        await self.bus.publish(
            TTSMethods.ERROR,
            TTSErrorEvent(request_id=request_id or "", error="TTS audio output failed"),
            event=True,
            mesh=False,
            origin="internal",
        )
        await self._complete_pcm_playback(playback_id, "failed")

    async def on_start(self) -> None:
        """Start the TTS service."""
        log_info("Starting TTS service...")

        # Store event loop for callbacks
        self._loop = asyncio.get_event_loop()

        # Runtime may need a user-selected voice pack first; management APIs stay available.
        await self._initialize_engine_fail_soft("startup")
        self._voice_revision += 1

    async def on_stop(self) -> None:
        """Stop the TTS service."""
        log_info("Stopping TTS service...")
        await self._stop_playback("service_stopped")
        await self._clear_tts_streams("service_stopped")
        async with self._voice_management_lock:
            self._voice_import_sessions.clear()
            self._voice_operation_results.clear()

        # Stop any ongoing playback
        if hasattr(self, "stream"):
            await self._stop_playback_stream(self.stream)
        if self._provider is not None:
            await self._provider.stop()
            self._provider = None

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading TTS service configuration (section: {config_section})")

        # If TTS config changed, reinitialize the engine
        if (
            config_section is None
            or config_section == "services"
            or config_section == "services.tts"
        ):
            log_info("TTS configuration changed, reinitializing engine...")
            new_provider: TTSProvider | None = None
            new_runtime_installed = False
            try:
                new_provider, new_engine, new_stream = await self._build_runtime()
                old_provider = self._provider
                old_stream = self.stream

                await self._clear_tts_streams("config_reloaded")
                if self._playing and old_stream is not None:
                    await self._stop_playback_stream(old_stream)
                    self._playing = False
                    self._paused = False
                    self._current_text = None
                    self._current_request_id = None

                self._provider = new_provider
                self.engine = new_engine
                self.stream = new_stream
                self._voice_revision += 1
                new_runtime_installed = True
                if old_provider is not None:
                    await old_provider.stop()
                if old_stream is not None:
                    await self._stop_playback_stream(old_stream)
                log_info("TTS engine reinitialized successfully")
            except Exception as e:
                if new_provider is not None and not new_runtime_installed:
                    await self._stop_provider_safely(new_provider, "reload pre-swap failure")
                log_error(
                    f"Failed to reinitialize TTS engine: error={_safe_tts_error(e)}",
                )
        else:
            log_debug(f"TTS service reloaded for section: {config_section}")

    def _voice_revision_token(self) -> str:
        return f"voice-rev-{self._voice_revision}"

    def _caller_owner(self, envelope: Envelope | None) -> str:
        principal_id = _envelope_principal_id(envelope) or "local-principal"
        peer_id = _envelope_caller_peer_id(envelope) or "local-peer"
        return f"principal={principal_id}|peer={peer_id}"

    async def _audit_voice_management(
        self,
        event: str,
        request: object,
        response: object,
        envelope: Envelope | None,
        *,
        phase: str = "outcome",
        audit_status: str | None = None,
    ) -> None:
        status = audit_status or getattr(response, "status", None)
        details = {
            "method": event,
            "phase": phase,
            "status": status,
            "operation_id": getattr(request, "operation_id", None),
            "voice_id": getattr(request, "voice_id", None),
            "upload_present": bool(getattr(request, "upload_id", None)),
            "sequence": getattr(request, "sequence", None),
            "final_sequence": getattr(request, "final_sequence", None),
            "expected_total_bytes": getattr(request, "expected_total_bytes", None),
            "accepted_total_bytes": getattr(response, "accepted_total_bytes", None),
            "received_bytes": getattr(response, "received_bytes", None),
            "deleted_bytes": getattr(response, "deleted_bytes", None),
            "peer_id": _envelope_caller_peer_id(envelope),
            "correlation_id": _envelope_correlation_id(envelope),
            "secrets_redacted": True,
        }
        try:
            await self.bus.request(
                AuthMethods.STORE_AUDIT_EVENT,
                StoreAuditEventRequest(
                    event=f"tts.voice_management.{event}",
                    principal_id=_envelope_principal_id(envelope),
                    details=json.dumps(details, sort_keys=True),
                ),
                timeout=5.0,
                origin="internal",
                principal_id=_envelope_principal_id(envelope),
                correlation_id=_envelope_correlation_id(envelope),
            )
        except Exception as exc:
            log_error(
                f"TTS voice management audit failed: event={event} error={type(exc).__name__}"
            )
            raise

    async def _audit_voice_management_rejection(
        self, event: str, request: object, envelope: Envelope | None
    ) -> None:
        response = type("RejectedVoiceManagementResponse", (), {"status": "rejected"})()
        await self._audit_voice_management(event, request, response, envelope, phase="outcome")

    def _mutation_fingerprint(self, request: object) -> str:
        payload = request.model_dump(mode="json") if hasattr(request, "model_dump") else {}
        payload.pop("correlation_id", None)
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _mutation_key(
        self, method: str, request: object, envelope: Envelope | None
    ) -> tuple[str, str, str]:
        operation_id = getattr(request, "operation_id", "")
        return (self._caller_owner(envelope), method, str(operation_id))

    def _cached_mutation(
        self, method: str, request: object, envelope: Envelope | None
    ) -> Any | None:
        key = self._mutation_key(method, request, envelope)
        cached = self._voice_operation_results.get(key)
        if cached is None:
            return None
        fingerprint, response = cached
        if fingerprint != self._mutation_fingerprint(request):
            raise ValueError("operation_id payload mismatch")
        response_fields = getattr(type(response), "model_fields", {})
        if "idempotent" in response_fields:
            return response.model_copy(update={"idempotent": True})
        return response

    def _cache_mutation(
        self, method: str, request: object, response: Any, envelope: Envelope | None
    ) -> Any:
        if len(self._voice_operation_results) >= 256:
            self._voice_operation_results.pop(next(iter(self._voice_operation_results)))
        self._voice_operation_results[self._mutation_key(method, request, envelope)] = (
            self._mutation_fingerprint(request),
            response,
        )
        return response

    def _voice_registry(self, tts_cfg: Tts | None = None) -> VoiceRegistry:
        registry_cfg = tts_cfg.voice_registry if tts_cfg and tts_cfg.voice_registry else None
        registry_cache_dir = (
            registry_cfg.cache_dir
            if registry_cfg and registry_cfg.cache_dir
            else "voice_models/voice-pack"
        )
        max_clone_artifact_bytes = (
            registry_cfg.clone_max_wire_bytes
            if registry_cfg and registry_cfg.clone_max_wire_bytes is not None
            else VOICE_STATE_TRANSFER_MAX_BYTES
        )
        return VoiceRegistry(
            resolve_path(registry_cache_dir),
            max_clone_artifact_bytes=max_clone_artifact_bytes,
        )

    def _voice_catalog_installer(self, tts_cfg: Tts) -> VoiceCatalogInstaller:
        registry_cfg = tts_cfg.voice_registry
        cache_dir = (
            registry_cfg.cache_dir
            if registry_cfg and registry_cfg.cache_dir
            else "voice_models/voice-pack"
        )
        return VoiceCatalogInstaller(
            manifest_path=registry_cfg.manifest_path if registry_cfg else None,
            asset_base_url=registry_cfg.asset_base_url if registry_cfg else None,
            cache_dir=resolve_path(cache_dir),
            registry=self._voice_registry(tts_cfg),
            trusted_manifest_sha256=(
                registry_cfg.trusted_manifest_sha256 if registry_cfg else None
            ),
            trusted_manifest_public_keys=_trusted_manifest_keys(registry_cfg),
            trusted_manifest_signature=(
                registry_cfg.trusted_manifest_signature if registry_cfg else None
            ),
        )

    async def _current_voice_profiles_with_catalog_status(
        self, *, include_catalog: bool = True
    ) -> tuple[list[TTSVoiceProfileDescriptor], VoiceCatalogSourceError | None]:
        tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
        default_voice_id = tts_cfg.default_voice_id
        registry_entries = []
        if tts_cfg.provider == "pockettts":
            with contextlib.suppress(Exception):
                registry_entries = list(await self._voice_registry(tts_cfg).inventory())
        default_voice_id = tts_cfg.default_voice_id
        active_voice_id: str | None = None
        provider_ready = False
        if self._provider is not None:
            with contextlib.suppress(Exception):
                health = await self._provider.health()
                provider_ready = health.ready
                active_voice_id = health.active_voice
        profiles: list[TTSVoiceProfileDescriptor] = []
        catalog_error: VoiceCatalogSourceError | None = None
        if tts_cfg.provider == "piper":
            try:
                for item in await self._piper_catalog_manager(tts_cfg).list_voices():
                    if not item.installed:
                        continue
                    is_active = item.ready and provider_ready and item.voice_id == active_voice_id
                    is_default = item.ready and item.voice_id == default_voice_id
                    profiles.append(
                        TTSVoiceProfileDescriptor(
                            voice_id=item.voice_id,
                            display_name=item.display_name,
                            kind="standard",
                            installed=True,
                            ready=item.ready,
                            default=is_default,
                            active=is_active,
                            enabled=True,
                            compatible_language_pack_ids=[item.language],
                            compatible_selection_group="piper-sherpa-onnx-v1",
                            revision=item.revision,
                            retained_source=False,
                            storage=SpeechStorageSummary(artifact_count=3),
                            visibility="private",
                            allowed_peer_ids=[],
                        )
                    )
                    if len(profiles) >= 256:
                        break
            except VoiceCatalogSourceError as exc:
                catalog_error = exc
            except (VoiceCatalogError, OSError) as exc:
                catalog_error = VoiceCatalogSourceError("voice catalog is unavailable")
                catalog_error.__cause__ = exc
            if profiles or self._provider is None:
                return profiles, catalog_error
        for entry in registry_entries:
            is_ready = entry.ready_state == "ready"
            is_active = is_ready and provider_ready and entry.voice_id == active_voice_id
            is_default = is_ready and entry.voice_id == default_voice_id
            profiles.append(
                TTSVoiceProfileDescriptor(
                    voice_id=entry.voice_id,
                    display_name=entry.display_name,
                    kind=_profile_kind(entry.kind),  # type: ignore[arg-type]
                    installed=True,
                    ready=is_ready,
                    default=is_default,
                    active=is_active,
                    enabled=getattr(entry, "enabled", True),
                    compatible_language_pack_ids=[entry.language_bundle],
                    compatible_selection_group=entry.compatibility_group,
                    revision=getattr(entry, "metadata_revision", entry.artifact_revision),
                    retained_source=entry.source_retained,
                    storage=SpeechStorageSummary(artifact_count=len(entry.artifact_refs)),
                    visibility="allowed_peers"
                    if entry.visibility == "allowed_peers"
                    else "private",
                    allowed_peer_ids=list(getattr(entry, "allowed_peer_ids", ())),
                )
            )
        known_voice_ids = {profile.voice_id for profile in profiles}
        if include_catalog and tts_cfg.provider == "pockettts":
            try:
                for item in await self._voice_catalog_installer(tts_cfg).list_items():
                    if item.voice_id in known_voice_ids:
                        continue
                    profiles.append(
                        TTSVoiceProfileDescriptor(
                            voice_id=item.voice_id,
                            display_name=item.display_name,
                            kind="standard",
                            installed=False,
                            ready=False,
                            default=False,
                            active=False,
                            enabled=True,
                            compatible_language_pack_ids=[item.language_bundle],
                            compatible_selection_group=item.compatibility_group,
                            revision=item.artifact_revision,
                            retained_source=False,
                            storage=SpeechStorageSummary(),
                            visibility="private",
                            allowed_peer_ids=[],
                        )
                    )
            except VoiceCatalogSourceError as exc:
                catalog_error = exc
            except (VoiceCatalogError, VoiceRegistryError, OSError) as exc:
                catalog_error = VoiceCatalogSourceError("voice catalog is unavailable")
                catalog_error.__cause__ = exc
        if profiles or self._provider is None:
            return profiles, catalog_error
        for voice in await self._provider.list_voices():
            language = _voice_language_pack(voice.language)
            if language is None:
                continue
            is_active = voice.ready and provider_ready and voice.voice_id == active_voice_id
            is_default = voice.ready and voice.voice_id == default_voice_id
            profiles.append(
                TTSVoiceProfileDescriptor(
                    voice_id=voice.voice_id,
                    display_name=voice.display_name,
                    kind="cloned" if voice.voice_id.startswith("clone:") else "standard",
                    installed=True,
                    ready=voice.ready,
                    default=is_default,
                    active=is_active,
                    enabled=True,
                    compatible_language_pack_ids=[language],
                    revision=self._voice_revision_token(),
                )
            )
        return profiles, catalog_error

    async def _current_voice_profiles(self) -> list[TTSVoiceProfileDescriptor]:
        profiles, _catalog_error = await self._current_voice_profiles_with_catalog_status()
        return profiles

    def _language_pack_revision(
        self,
        voices: list[TTSLanguagePackVoice],
        *,
        catalog_revision: str | None = None,
    ) -> str:
        if catalog_revision is not None:
            return catalog_revision
        parts = [":".join((voice.voice_id, voice.revision)) for voice in voices]
        digest = hashlib.sha256("|".join(sorted(parts)).encode("utf-8")).hexdigest()[:16]
        return f"language-pack-rev-{digest}"

    async def _current_language_pack_inventory(self) -> _LanguagePackInventory:
        tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
        catalog_rows = []
        catalog_status = "available"
        catalog_error_code: str | None = None
        if tts_cfg.provider == "piper":
            try:
                catalog_rows = list(await self._piper_catalog_manager(tts_cfg).list_voices())
            except (VoiceCatalogError, OSError):
                catalog_status = "unavailable"
                catalog_error_code = "catalog_unavailable"
        elif tts_cfg.provider == "pockettts":
            try:
                catalog_rows = list(await self._voice_catalog_installer(tts_cfg).list_items())
            except (VoiceCatalogError, VoiceRegistryError, OSError):
                catalog_status = "unavailable"
                catalog_error_code = "catalog_unavailable"
        profiles = await self._current_voice_profiles()
        profile_by_voice_id = {profile.voice_id: profile for profile in profiles}
        grouped: dict[str, dict[str, Any]] = {}
        for item in catalog_rows:
            pack_id = _voice_language_pack(
                item.language if tts_cfg.provider == "piper" else item.language_bundle
            )
            if pack_id is None:
                continue
            row = grouped.setdefault(
                pack_id,
                {
                    "language": pack_id,
                    "display_name": pack_id,
                    "voices": {},
                },
            )
            profile = profile_by_voice_id.get(item.voice_id)
            installed = bool(profile.installed) if profile is not None else item.installed
            ready = bool(profile.ready) if profile is not None else item.ready
            revision = (
                profile.revision
                if profile is not None
                else item.revision
                if tts_cfg.provider == "piper"
                else item.artifact_revision
            )
            row["voices"][item.voice_id] = TTSLanguagePackVoice(
                voice_id=item.voice_id,
                display_name=item.display_name,
                installed=installed,
                ready=ready,
                default=bool(profile.default) if profile is not None else False,
                active=bool(profile.active) if profile is not None else False,
                revision=revision,
            )
        for profile in profiles:
            if profile.kind != "standard":
                continue
            for raw_pack_id in profile.compatible_language_pack_ids:
                pack_id = _voice_language_pack(raw_pack_id)
                if pack_id is None:
                    continue
                row = grouped.setdefault(
                    pack_id,
                    {
                        "language": pack_id,
                        "display_name": pack_id,
                        "voices": {},
                    },
                )
                row["voices"].setdefault(
                    profile.voice_id,
                    TTSLanguagePackVoice(
                        voice_id=profile.voice_id,
                        display_name=profile.display_name,
                        installed=profile.installed,
                        ready=profile.ready,
                        default=profile.default,
                        active=profile.active,
                        revision=profile.revision,
                    ),
                )
        default_voice_id = tts_cfg.default_voice_id
        default_found = False
        packs: list[TTSLanguagePackDescriptor] = []
        for pack_id, row in grouped.items():
            voices = sorted(row["voices"].values(), key=lambda voice: voice.voice_id)
            installed_count = sum(1 for voice in voices if voice.installed)
            ready_count = sum(1 for voice in voices if voice.ready)
            pack_default = any(voice.default for voice in voices)
            default_found = default_found or pack_default
            packs.append(
                TTSLanguagePackDescriptor(
                    pack_id=pack_id,
                    language=row["language"],
                    display_name=row["display_name"],
                    installed=installed_count > 0,
                    ready=ready_count > 0,
                    default=pack_default,
                    voice_count=len(voices),
                    installed_voice_count=installed_count,
                    ready_voice_count=ready_count,
                    voices=voices,
                    revision=self._language_pack_revision(
                        voices,
                        catalog_revision=PIPER_CATALOG_REVISION
                        if tts_cfg.provider == "piper"
                        else None,
                    ),
                )
            )
        return _LanguagePackInventory(
            packs=sorted(packs, key=lambda pack: pack.pack_id),
            catalog_status=catalog_status,
            catalog_error_code=catalog_error_code,
            default_voice_id=default_voice_id,
            stale_default_voice_id=default_voice_id
            if default_voice_id is not None and not default_found
            else None,
        )

    async def _list_voice_descriptors(
        self, envelope: Envelope | None = None
    ) -> list[TTSVoiceDescriptor]:
        voices = await self._provider.list_voices() if self._provider is not None else ()
        provider_caps = self._provider.capabilities if self._provider is not None else None
        effective_language = _voice_language_pack(await self._effective_tts_language())
        if effective_language is None:
            return []
        remote_caller = envelope is not None and (
            envelope.origin == "external" or _envelope_caller_peer_id(envelope) is not None
        )
        descriptors: list[TTSVoiceDescriptor] = []
        for voice in voices:
            if not voice.ready:
                continue
            is_clone = voice.voice_id.startswith("clone:")
            if remote_caller and is_clone:
                continue
            language = _voice_language_pack(voice.language)
            if language is None or language != effective_language:
                continue
            descriptors.append(
                TTSVoiceDescriptor(
                    voice_id=voice.voice_id,
                    display_name=voice.display_name,
                    kind="cloned" if is_clone else "standard",
                    compatible_language_pack_ids=[language],
                    ready=True,
                    selection_mode=provider_caps.voice_selection_mode.value
                    if provider_caps
                    else "active_only",
                    revision=self._voice_revision_token(),
                    visible_scope="local" if is_clone else "public",
                )
            )
        return descriptors

    def _expire_voice_import_sessions(self) -> None:
        now = datetime.now(UTC)
        for upload_id, session in list(self._voice_import_sessions.items()):
            if session.expires_at <= now:
                del self._voice_import_sessions[upload_id]

    @method_contract(
        method_id=TTSMethods.GET_CAPABILITIES,
        summary="Get TTS runtime capabilities",
        input_model=TTSGetCapabilitiesRequest,
        output_model=TTSGetCapabilitiesResponse,
        exposure="both",
        method_type="use",
        required_perms=["TTS.use"],
        callable_feature_ids=["speech_voice_discovery"],
    )
    async def get_capabilities(
        self, request: TTSGetCapabilitiesRequest
    ) -> TTSGetCapabilitiesResponse:
        """Return provider-neutral TTS capabilities."""
        provider = self._provider
        ready = False
        model_status = "unavailable"
        sample_rates: list[int] = []
        provider_caps = None
        if provider is not None:
            provider_caps = provider.capabilities
            health = await provider.health()
            ready = health.ready
            model_status = "ready" if health.ready else "unavailable"
            tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
            if tts_cfg.provider == "piper":
                piper_cfg = tts_cfg.providers.piper if tts_cfg.providers else None
                sample_rates = [
                    piper_cfg.model_sample_rate
                    if piper_cfg and piper_cfg.model_sample_rate is not None
                    else tts_cfg.model_sample_rate
                    if tts_cfg.model_sample_rate is not None
                    else 22050
                ]
            else:
                sample_rates = [24000]
        language = _voice_language_pack(await self._effective_tts_language())
        if language is None:
            ready = False
            model_status = "unavailable"
            sample_rates = []
            supported_pack_ids: list[str] = []
        else:
            pack_id = f"{language}-local"
            supported_pack_ids = [pack_id]
        selection_mode = (
            provider_caps.voice_selection_mode.value if provider_caps else "active_only"
        )
        capabilities = TTSCapabilities(
            ready=ready,
            model_status=model_status,  # type: ignore[arg-type]
            supported_language_pack_ids=supported_pack_ids,
            installed_language_pack_ids=[pack_id] if ready else [],
            resident_language_pack_ids=[pack_id] if ready else [],
            resident_language_packs=[
                TTSResidentLanguagePack(pack_id=pack_id, ready_languages=[language])
            ]
            if ready
            else [],
            ready_languages=[language] if ready else [],
            output_formats=list(provider_caps.supported_formats)
            if provider_caps
            else ["wav", "raw"],
            sample_rates=sample_rates if ready else [],
            streaming=bool(provider_caps.supports_streaming) if provider_caps else False,
            cancellation=bool(provider_caps.supports_cancel) if provider_caps else False,
            cloning=False,
            capability_revision=self._voice_revision,
            voice_selection_mode=selection_mode,  # type: ignore[arg-type]
            max_resident_base_models=provider_caps.max_resident_base_models if provider_caps else 1,
            resident_base_model_count=1 if ready else 0,
            requires_model_reload_for_voice_change=selection_mode == "active_only",
            voice_state_memory_class="small_state"
            if selection_mode == "shared_model_state"
            else "none",
        )
        return TTSGetCapabilitiesResponse(
            capabilities=capabilities,
            correlation_id=request.correlation_id,
        )

    @method_contract(
        method_id=TTSMethods.LIST_VOICES,
        summary="List ready TTS voices",
        input_model=TTSListVoicesRequest,
        output_model=TTSListVoicesResponse,
        exposure="both",
        method_type="use",
        required_perms=["TTS.use"],
        callable_feature_ids=["speech_voice_discovery"],
    )
    async def list_voices(
        self, request: TTSListVoicesRequest, envelope: Envelope | None = None
    ) -> TTSListVoicesResponse:
        """Return use-safe ready voices."""
        voices = await self._list_voice_descriptors(envelope)
        if request.language is not None:
            voices = [
                voice for voice in voices if request.language in voice.compatible_language_pack_ids
            ]
        return TTSListVoicesResponse(
            voices=voices,
            capability_revision=self._voice_revision,
            correlation_id=request.correlation_id,
        )

    @method_contract(
        method_id=TTSMethods.LIST_LANGUAGE_PACKS,
        summary="List managed TTS language packs",
        input_model=TTSListLanguagePacksRequest,
        output_model=TTSListLanguagePacksResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def list_language_packs(
        self, request: TTSListLanguagePacksRequest
    ) -> TTSListLanguagePacksResponse:
        """Return administrative language pack metadata without artifact locations."""
        inventory = await self._current_language_pack_inventory()
        packs = inventory.packs
        if request.language is not None:
            packs = [pack for pack in packs if pack.language == request.language]
        if not request.include_unavailable:
            packs = [pack for pack in packs if pack.installed]
        return TTSListLanguagePacksResponse(
            packs=packs,
            catalog_status=inventory.catalog_status,
            catalog_error_code=inventory.catalog_error_code,
            default_voice_id=inventory.default_voice_id,
            stale_default_voice_id=inventory.stale_default_voice_id,
            capability_revision=self._voice_revision,
            correlation_id=request.correlation_id,
        )

    @method_contract(
        method_id=TTSMethods.LIST_VOICE_PROFILES,
        summary="List managed TTS voice profiles",
        input_model=TTSListVoiceProfilesRequest,
        output_model=TTSListVoiceProfilesResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def list_voice_profiles(
        self, request: TTSListVoiceProfilesRequest
    ) -> TTSListVoiceProfilesResponse:
        """Return administrative voice profile metadata."""
        profiles, catalog_error = await self._current_voice_profiles_with_catalog_status(
            include_catalog=request.include_unavailable
        )
        if catalog_error is not None and request.include_unavailable and not profiles:
            raise catalog_error
        if not request.include_unavailable:
            profiles = [profile for profile in profiles if profile.installed]
        return TTSListVoiceProfilesResponse(
            profiles=profiles,
            capability_revision=self._voice_revision,
            correlation_id=request.correlation_id,
        )

    @method_contract(
        method_id=TTSMethods.GET_VOICE_PROFILE,
        summary="Get one managed TTS voice profile",
        input_model=TTSGetVoiceProfileRequest,
        output_model=TTSGetVoiceProfileResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def get_voice_profile(
        self, request: TTSGetVoiceProfileRequest
    ) -> TTSGetVoiceProfileResponse:
        """Return one administrative voice profile."""
        profiles, catalog_error = await self._current_voice_profiles_with_catalog_status()
        for profile in profiles:
            if profile.voice_id == request.voice_id:
                return TTSGetVoiceProfileResponse(
                    found=True,
                    profile=profile,
                    correlation_id=request.correlation_id,
                )
        if catalog_error is not None:
            raise catalog_error
        return TTSGetVoiceProfileResponse(found=False, correlation_id=request.correlation_id)

    @method_contract(
        method_id=TTSMethods.UPDATE_VOICE_PROFILE,
        summary="Update managed TTS voice profile metadata",
        input_model=TTSUpdateVoiceProfileRequest,
        output_model=TTSUpdateVoiceProfileResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def update_voice_profile(
        self, request: TTSUpdateVoiceProfileRequest, envelope: Envelope | None = None
    ) -> TTSUpdateVoiceProfileResponse:
        """Persist provider-neutral profile metadata for registry-backed voices."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("update_voice_profile", request, envelope)
            if cached is not None:
                return cached
            tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
            profile = next(
                (
                    item
                    for item in await self._current_voice_profiles()
                    if item.voice_id == request.voice_id and item.installed
                ),
                None,
            )
            if profile is None:
                response = TTSUpdateVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="not_found",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "update_voice_profile", request, response, envelope
                )
                self._cache_mutation("update_voice_profile", request, response, envelope)
                return response
            if (
                request.expected_revision is not None
                and request.expected_revision != profile.revision
            ):
                response = TTSUpdateVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="revision_conflict",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "update_voice_profile", request, response, envelope
                )
                self._cache_mutation("update_voice_profile", request, response, envelope)
                return response
            if request.enabled is False and (profile.default or profile.active):
                response = TTSUpdateVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="rejected",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "update_voice_profile", request, response, envelope
                )
                self._cache_mutation("update_voice_profile", request, response, envelope)
                return response
            next_revision = f"voice-rev-{self._voice_revision + 1}"
            planned_response = TTSUpdateVoiceProfileResponse(
                voice_id=request.voice_id,
                status="updated",
                revision=next_revision,
                correlation_id=request.correlation_id,
            )
            await self._audit_voice_management(
                "update_voice_profile",
                request,
                planned_response,
                envelope,
                phase="intent",
                audit_status="attempted",
            )
            try:
                updated = await self._voice_registry(tts_cfg).update_voice_metadata(
                    request.voice_id,
                    display_name=request.display_name,
                    enabled=request.enabled,
                    visibility=request.visibility,
                    allowed_peer_ids=tuple(request.allowed_peer_ids)
                    if request.allowed_peer_ids is not None
                    else None,
                    metadata_revision=next_revision,
                )
            except VoiceRegistryError as exc:
                log_error(f"TTS voice metadata update failed: error={_safe_tts_error(exc)}")
                response = TTSUpdateVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="rejected",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "update_voice_profile", request, response, envelope
                )
                self._cache_mutation("update_voice_profile", request, response, envelope)
                return response
            if updated is None:
                response = TTSUpdateVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="not_found",
                    correlation_id=request.correlation_id,
                )
            else:
                updated_profile, changed = updated
                if changed:
                    self._voice_revision += 1
                    if profile.active and self._provider is not None:
                        await self._initialize_engine_fail_soft("voice metadata update")
                    response = TTSUpdateVoiceProfileResponse(
                        voice_id=request.voice_id,
                        status="updated",
                        revision=updated_profile.metadata_revision,
                        correlation_id=request.correlation_id,
                    )
                else:
                    response = TTSUpdateVoiceProfileResponse(
                        voice_id=request.voice_id,
                        status="unchanged",
                        revision=updated_profile.metadata_revision,
                        correlation_id=request.correlation_id,
                    )
            await self._audit_voice_management("update_voice_profile", request, response, envelope)
            self._cache_mutation("update_voice_profile", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.INSTALL_VOICE_PROFILE,
        summary="Install a manifest-known TTS voice profile",
        input_model=TTSInstallVoiceProfileRequest,
        output_model=TTSInstallVoiceProfileResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def install_voice_profile(
        self, request: TTSInstallVoiceProfileRequest, envelope: Envelope | None = None
    ) -> TTSInstallVoiceProfileResponse:
        """Install a catalog-listed standard voice pack on demand."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("install_voice_profile", request, envelope)
            if cached is not None:
                return cached
            tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
            if tts_cfg.provider == "piper":
                manager = self._piper_catalog_manager(tts_cfg)
                try:
                    catalog_items = {item.voice_id: item for item in await manager.list_voices()}
                except VoiceCatalogSourceError as exc:
                    response = TTSInstallVoiceProfileResponse(
                        voice_id=request.voice_id,
                        status="rejected",
                        correlation_id=request.correlation_id,
                    )
                    await self._audit_voice_management(
                        "install_voice_profile", request, response, envelope
                    )
                    raise VoiceCatalogSourceError("voice catalog is unavailable") from exc
                target_item = catalog_items.get(request.voice_id)
                if target_item is None:
                    response = TTSInstallVoiceProfileResponse(
                        voice_id=request.voice_id,
                        status="not_found",
                        correlation_id=request.correlation_id,
                    )
                    await self._audit_voice_management(
                        "install_voice_profile", request, response, envelope
                    )
                    self._cache_mutation("install_voice_profile", request, response, envelope)
                    return response
                if (
                    request.expected_revision is not None
                    and request.expected_revision != target_item.revision
                ):
                    response = TTSInstallVoiceProfileResponse(
                        voice_id=request.voice_id,
                        status="revision_conflict",
                        revision=target_item.revision,
                        correlation_id=request.correlation_id,
                    )
                    await self._audit_voice_management(
                        "install_voice_profile", request, response, envelope
                    )
                    self._cache_mutation("install_voice_profile", request, response, envelope)
                    return response
                if target_item.installed and target_item.ready:
                    response = TTSInstallVoiceProfileResponse(
                        voice_id=request.voice_id,
                        status="unchanged",
                        revision=target_item.revision,
                        correlation_id=request.correlation_id,
                    )
                    await self._audit_voice_management(
                        "install_voice_profile", request, response, envelope
                    )
                    self._cache_mutation("install_voice_profile", request, response, envelope)
                    return response
                planned_response = TTSInstallVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="installed",
                    revision=target_item.revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "install_voice_profile",
                    request,
                    planned_response,
                    envelope,
                    phase="intent",
                    audit_status="attempted",
                )
                try:
                    result = await manager.install_voice(request.voice_id)
                except VoiceCatalogError as exc:
                    log_error(f"TTS voice install failed: error={_safe_tts_error(exc)}")
                    response = TTSInstallVoiceProfileResponse(
                        voice_id=request.voice_id,
                        status="rejected",
                        correlation_id=request.correlation_id,
                    )
                    await self._audit_voice_management(
                        "install_voice_profile", request, response, envelope
                    )
                    self._cache_mutation("install_voice_profile", request, response, envelope)
                    return response
                self._voice_revision += 1
                response = TTSInstallVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="installed",
                    revision=result.voice.revision,
                    correlation_id=request.correlation_id,
                )
                await self._initialize_engine_fail_soft("voice install")
                await self._audit_voice_management(
                    "install_voice_profile", request, response, envelope
                )
                self._cache_mutation("install_voice_profile", request, response, envelope)
                return response
            registry = self._voice_registry(tts_cfg)
            installer = self._voice_catalog_installer(tts_cfg)
            try:
                catalog_items = {item.voice_id: item for item in await installer.list_items()}
            except VoiceCatalogSourceError as exc:
                catalog_message = (
                    exc.args[0]
                    if exc.args and isinstance(exc.args[0], str)
                    else "voice catalog is unavailable"
                )
                response = TTSInstallVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="rejected",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "install_voice_profile", request, response, envelope
                )
                raise VoiceCatalogSourceError(catalog_message) from exc
            target_item = catalog_items.get(request.voice_id)
            if target_item is None:
                response = TTSInstallVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="not_found",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "install_voice_profile", request, response, envelope
                )
                self._cache_mutation("install_voice_profile", request, response, envelope)
                return response
            current = next(
                (item for item in await registry.inventory() if item.voice_id == request.voice_id),
                None,
            )
            if (
                current is not None
                and request.expected_revision is not None
                and request.expected_revision != current.artifact_revision
            ):
                response = TTSInstallVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="revision_conflict",
                    revision=current.artifact_revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "install_voice_profile", request, response, envelope
                )
                self._cache_mutation("install_voice_profile", request, response, envelope)
                return response
            if current is not None and current.artifact_revision == target_item.artifact_revision:
                response = TTSInstallVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="unchanged",
                    revision=current.artifact_revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "install_voice_profile", request, response, envelope
                )
                self._cache_mutation("install_voice_profile", request, response, envelope)
                return response
            planned_response = TTSInstallVoiceProfileResponse(
                voice_id=request.voice_id,
                status="installed",
                revision=target_item.artifact_revision,
                correlation_id=request.correlation_id,
            )
            await self._audit_voice_management(
                "install_voice_profile",
                request,
                planned_response,
                envelope,
                phase="intent",
                audit_status="attempted",
            )
            try:
                result = await installer.install_voice(request.voice_id)
            except (VoiceCatalogError, VoiceRegistryError) as exc:
                log_error(f"TTS voice install failed: error={_safe_tts_error(exc)}")
                response = TTSInstallVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="rejected",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "install_voice_profile", request, response, envelope
                )
                self._cache_mutation("install_voice_profile", request, response, envelope)
                return response
            self._voice_revision += 1
            response = TTSInstallVoiceProfileResponse(
                voice_id=request.voice_id,
                status="installed",
                revision=result.entry.artifact_revision,
                correlation_id=request.correlation_id,
            )
            await self._initialize_engine_fail_soft("voice install")
            await self._audit_voice_management("install_voice_profile", request, response, envelope)
            self._cache_mutation("install_voice_profile", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.REMOVE_VOICE_PROFILE,
        summary="Remove installed TTS voice profile artifacts",
        input_model=TTSRemoveVoiceProfileRequest,
        output_model=TTSRemoveVoiceProfileResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def remove_voice_profile(
        self, request: TTSRemoveVoiceProfileRequest, envelope: Envelope | None = None
    ) -> TTSRemoveVoiceProfileResponse:
        """Remove installed standard or cloned voice artifacts."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("remove_voice_profile", request, envelope)
            if cached is not None:
                return cached
            tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
            profile = next(
                (
                    item
                    for item in await self._current_voice_profiles()
                    if item.voice_id == request.voice_id and item.installed
                ),
                None,
            )
            if profile is None:
                response = TTSRemoveVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="not_found",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "remove_voice_profile", request, response, envelope
                )
                self._cache_mutation("remove_voice_profile", request, response, envelope)
                return response
            if (
                request.expected_revision is not None
                and request.expected_revision != profile.revision
            ):
                response = TTSRemoveVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="revision_conflict",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "remove_voice_profile", request, response, envelope
                )
                self._cache_mutation("remove_voice_profile", request, response, envelope)
                return response
            removing_default = tts_cfg.default_voice_id == request.voice_id
            status = "drained" if profile.active or removing_default else "removed"
            response = TTSRemoveVoiceProfileResponse(
                voice_id=request.voice_id,
                status=status,
                revision=f"voice-rev-{self._voice_revision + 1}",
                correlation_id=request.correlation_id,
            )
            await self._audit_voice_management(
                "remove_voice_profile",
                request,
                response,
                envelope,
                phase="intent",
                audit_status="attempted",
            )
            if removing_default:
                updated = await config_api.aupdate_config(
                    "services.tts.default_voice_id", None, timeout=15.0
                )
                if not updated:
                    response = TTSRemoveVoiceProfileResponse(
                        voice_id=request.voice_id,
                        status="rejected",
                        revision=profile.revision,
                        correlation_id=request.correlation_id,
                    )
                    await self._audit_voice_management(
                        "remove_voice_profile", request, response, envelope
                    )
                    self._cache_mutation("remove_voice_profile", request, response, envelope)
                    return response
            if profile.active and self._provider is not None:
                await self._stop_playback("voice_removed")
                await self._provider.stop()
                self._provider = None
                self.engine = None
                self.stream = None
            try:
                if tts_cfg.provider == "piper":
                    removed = await self._piper_catalog_manager(tts_cfg).remove_voice(
                        request.voice_id
                    )
                    if not removed:
                        raise VoiceCatalogSourceError("Piper voice is unavailable")
                else:
                    await self._voice_registry(tts_cfg).delete_voice(request.voice_id)
            except (VoiceCatalogError, VoiceRegistryError) as exc:
                log_error(f"TTS voice removal failed: error={_safe_tts_error(exc)}")
                response = TTSRemoveVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="rejected",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "remove_voice_profile", request, response, envelope
                )
                self._cache_mutation("remove_voice_profile", request, response, envelope)
                return response
            self._voice_revision += 1
            if status == "drained":
                await self._initialize_engine_fail_soft("voice removal")
            await self._audit_voice_management("remove_voice_profile", request, response, envelope)
            self._cache_mutation("remove_voice_profile", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.SET_DEFAULT_VOICE,
        summary="Set the default TTS voice",
        input_model=TTSSetDefaultVoiceRequest,
        output_model=TTSSetDefaultVoiceResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def set_default_voice(
        self, request: TTSSetDefaultVoiceRequest, envelope: Envelope | None = None
    ) -> TTSSetDefaultVoiceResponse:
        """Persist and activate the node-wide default voice."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("set_default_voice", request, envelope)
            if cached is not None:
                return cached
            profile = next(
                (
                    item
                    for item in await self._current_voice_profiles()
                    if item.voice_id == request.voice_id and item.installed
                ),
                None,
            )
            if profile is None:
                response = TTSSetDefaultVoiceResponse(
                    voice_id=request.voice_id,
                    status="not_found",
                    revision=self._voice_revision_token(),
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management("set_default_voice", request, response, envelope)
                self._cache_mutation("set_default_voice", request, response, envelope)
                return response
            if request.expected_revision != profile.revision:
                response = TTSSetDefaultVoiceResponse(
                    voice_id=request.voice_id,
                    status="revision_conflict",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management("set_default_voice", request, response, envelope)
                self._cache_mutation("set_default_voice", request, response, envelope)
                return response
            if profile.default:
                response = TTSSetDefaultVoiceResponse(
                    voice_id=request.voice_id,
                    status="activated",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management("set_default_voice", request, response, envelope)
                self._cache_mutation("set_default_voice", request, response, envelope)
                return response
            if not profile.ready:
                response = TTSSetDefaultVoiceResponse(
                    voice_id=request.voice_id,
                    status="rejected",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management("set_default_voice", request, response, envelope)
                self._cache_mutation("set_default_voice", request, response, envelope)
                return response
            response = TTSSetDefaultVoiceResponse(
                voice_id=request.voice_id,
                status="activated",
                revision=profile.revision,
                correlation_id=request.correlation_id,
            )
            await self._audit_voice_management(
                "set_default_voice",
                request,
                response,
                envelope,
                phase="intent",
                audit_status="attempted",
            )
            updated = await config_api.aupdate_config(
                "services.tts.default_voice_id", request.voice_id, timeout=15.0
            )
            if not updated:
                response = TTSSetDefaultVoiceResponse(
                    voice_id=request.voice_id,
                    status="rejected",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management("set_default_voice", request, response, envelope)
                self._cache_mutation("set_default_voice", request, response, envelope)
                return response
            self._voice_revision += 1
            await self._initialize_engine_fail_soft("default voice change")
            await self._audit_voice_management("set_default_voice", request, response, envelope)
            self._cache_mutation("set_default_voice", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.VOICE_IMPORT_START,
        summary="Start a bounded TTS voice import upload",
        input_model=TTSVoiceImportStartRequest,
        output_model=TTSVoiceImportStartResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def voice_import_start(
        self, request: TTSVoiceImportStartRequest, envelope: Envelope | None = None
    ) -> TTSVoiceImportStartResponse:
        """Create a bounded owner-scoped upload session."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("voice_import_start", request, envelope)
            if cached is not None:
                return cached
            self._expire_voice_import_sessions()
            owner = self._caller_owner(envelope)
            owner_session_count = sum(
                1 for session in self._voice_import_sessions.values() if session.owner == owner
            )
            if (
                len(self._voice_import_sessions) >= _MAX_VOICE_IMPORT_SESSIONS
                or owner_session_count >= _MAX_VOICE_IMPORT_SESSIONS_PER_OWNER
            ):
                await self._audit_voice_management_rejection(
                    "voice_import_start", request, envelope
                )
                raise ValueError("voice import session capacity reached")
            upload_id = uuid.uuid4().hex
            expires_at = datetime.now(UTC) + timedelta(minutes=15)
            session = _VoiceImportSession(
                upload_id=upload_id,
                owner=owner,
                operation_id=request.operation_id,
                expected_total_bytes=request.expected_total_bytes,
                expected_sha256=request.sha256,
                audio_format=request.format,
                sample_rate=request.sample_rate,
                channels=request.channels,
                sample_width_bytes=request.sample_width_bytes,
                duration_ms=request.duration_ms,
                expires_at=expires_at,
            )
            response = TTSVoiceImportStartResponse(
                upload_id=upload_id,
                expires_at=expires_at.isoformat(),
                accepted_total_bytes=request.expected_total_bytes,
                correlation_id=request.correlation_id,
            )
            await self._audit_voice_management(
                "voice_import_start",
                request,
                response,
                envelope,
                phase="intent",
                audit_status="attempted",
            )
            self._voice_import_sessions[upload_id] = session
            self._cache_mutation("voice_import_start", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.VOICE_IMPORT_CHUNK,
        summary="Append a bounded TTS voice import chunk",
        input_model=TTSVoiceImportChunkRequest,
        output_model=TTSVoiceImportChunkResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def voice_import_chunk(
        self, request: TTSVoiceImportChunkRequest, envelope: Envelope | None = None
    ) -> TTSVoiceImportChunkResponse:
        """Accept exactly ordered owner-scoped upload chunks."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("voice_import_chunk", request, envelope)
            if cached is not None:
                return cached
            self._expire_voice_import_sessions()
            session = self._voice_import_sessions.get(request.upload_id)
            if session is None or session.owner != self._caller_owner(envelope):
                await self._audit_voice_management_rejection(
                    "voice_import_chunk", request, envelope
                )
                raise ValueError("voice import upload is unavailable")
            if session.sealed_ref is not None:
                await self._audit_voice_management_rejection(
                    "voice_import_chunk", request, envelope
                )
                raise ValueError("voice import upload is sealed")
            chunk = base64.b64decode(request.chunk_data, validate=True)
            expected_sequence = len(session.chunks)
            if request.sequence in session.chunks:
                if session.chunks[request.sequence] != chunk:
                    await self._audit_voice_management_rejection(
                        "voice_import_chunk", request, envelope
                    )
                    raise ValueError("duplicate voice import chunk payload mismatch")
                response = TTSVoiceImportChunkResponse(
                    upload_id=request.upload_id,
                    sequence=request.sequence,
                    status="duplicate",
                    received_bytes=sum(len(item) for item in session.chunks.values()),
                    next_sequence=request.sequence + 1,
                    idempotent=True,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "voice_import_chunk", request, response, envelope
                )
                self._cache_mutation("voice_import_chunk", request, response, envelope)
            elif request.sequence != expected_sequence:
                await self._audit_voice_management_rejection(
                    "voice_import_chunk", request, envelope
                )
                raise ValueError("voice import chunks must arrive in order")
            else:
                received_bytes = sum(len(item) for item in session.chunks.values()) + len(chunk)
                if received_bytes > session.expected_total_bytes:
                    await self._audit_voice_management_rejection(
                        "voice_import_chunk", request, envelope
                    )
                    raise ValueError("voice import exceeds expected total bytes")
                response = TTSVoiceImportChunkResponse(
                    upload_id=request.upload_id,
                    sequence=request.sequence,
                    status="accepted",
                    received_bytes=received_bytes,
                    next_sequence=request.sequence + 1,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "voice_import_chunk",
                    request,
                    response,
                    envelope,
                    phase="intent",
                    audit_status="attempted",
                )
                session.chunks[request.sequence] = chunk
                self._cache_mutation("voice_import_chunk", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.VOICE_IMPORT_END,
        summary="Seal a bounded TTS voice import upload",
        input_model=TTSVoiceImportEndRequest,
        output_model=TTSVoiceImportEndResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def voice_import_end(
        self, request: TTSVoiceImportEndRequest, envelope: Envelope | None = None
    ) -> TTSVoiceImportEndResponse:
        """Seal a complete owner-scoped upload into an opaque reference."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("voice_import_end", request, envelope)
            if cached is not None:
                return cached
            self._expire_voice_import_sessions()
            session = self._voice_import_sessions.get(request.upload_id)
            if session is None or session.owner != self._caller_owner(envelope):
                await self._audit_voice_management_rejection("voice_import_end", request, envelope)
                raise ValueError("voice import upload is unavailable")
            if request.final_sequence != len(session.chunks) - 1:
                await self._audit_voice_management_rejection("voice_import_end", request, envelope)
                raise ValueError("voice import final sequence mismatch")
            payload = b"".join(session.chunks[index] for index in sorted(session.chunks))
            if len(payload) != session.expected_total_bytes:
                await self._audit_voice_management_rejection("voice_import_end", request, envelope)
                raise ValueError("voice import total bytes mismatch")
            digest = hashlib.sha256(payload).hexdigest()
            if digest != request.final_sha256 or digest != session.expected_sha256:
                await self._audit_voice_management_rejection("voice_import_end", request, envelope)
                raise ValueError("voice import digest mismatch")
            try:
                _validate_import_audio_payload(payload, session)
            except ValueError:
                await self._audit_voice_management_rejection("voice_import_end", request, envelope)
                raise
            sealed_ref = f"voice-import:{request.upload_id}"
            response = TTSVoiceImportEndResponse(
                sealed_audio_ref=sealed_ref,
                accepted_total_bytes=len(payload),
                final_sha256=digest,
                expires_at=session.expires_at.isoformat(),
                correlation_id=request.correlation_id,
            )
            await self._audit_voice_management(
                "voice_import_end",
                request,
                response,
                envelope,
                phase="intent",
                audit_status="attempted",
            )
            session.sealed_ref = sealed_ref
            self._cache_mutation("voice_import_end", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.VOICE_IMPORT_ABORT,
        summary="Abort a bounded TTS voice import upload",
        input_model=TTSVoiceImportAbortRequest,
        output_model=TTSVoiceImportAbortResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def voice_import_abort(
        self, request: TTSVoiceImportAbortRequest, envelope: Envelope | None = None
    ) -> TTSVoiceImportAbortResponse:
        """Remove a partial owner-scoped upload."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("voice_import_abort", request, envelope)
            if cached is not None:
                return cached
            self._expire_voice_import_sessions()
            session = self._voice_import_sessions.get(request.upload_id)
            if session is None or session.owner != self._caller_owner(envelope):
                response = TTSVoiceImportAbortResponse(
                    upload_id=request.upload_id,
                    status="not_found",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "voice_import_abort", request, response, envelope
                )
            else:
                deleted = sum(len(item) for item in session.chunks.values())
                response = TTSVoiceImportAbortResponse(
                    upload_id=request.upload_id,
                    status="aborted",
                    deleted_bytes=deleted,
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "voice_import_abort",
                    request,
                    response,
                    envelope,
                    phase="intent",
                    audit_status="attempted",
                )
                del self._voice_import_sessions[request.upload_id]
            self._cache_mutation("voice_import_abort", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.CREATE_VOICE_PROFILE,
        summary="Create a cloned TTS voice profile",
        input_model=TTSCreateVoiceProfileRequest,
        output_model=TTSCreateVoiceProfileResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def create_voice_profile(
        self, request: TTSCreateVoiceProfileRequest, envelope: Envelope | None = None
    ) -> TTSCreateVoiceProfileResponse:
        """Create a local cloned voice profile from a sealed owner-scoped prompt."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("create_voice_profile", request, envelope)
            if cached is not None:
                return cached
            self._expire_voice_import_sessions()
            session = next(
                (
                    item
                    for item in self._voice_import_sessions.values()
                    if item.sealed_ref == request.sealed_audio_ref
                ),
                None,
            )
            if session is None or session.owner != self._caller_owner(envelope):
                response = TTSCreateVoiceProfileResponse(
                    status="rejected",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "create_voice_profile", request, response, envelope
                )
                self._cache_mutation("create_voice_profile", request, response, envelope)
                return response
            tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
            registry_cfg = tts_cfg.voice_registry
            cloning_enabled = (
                registry_cfg.cloning_enabled
                if registry_cfg and registry_cfg.cloning_enabled is not None
                else True
            )
            if tts_cfg.provider != "pockettts" or not cloning_enabled or request.retain_source:
                response = TTSCreateVoiceProfileResponse(
                    status="unavailable"
                    if tts_cfg.provider != "pockettts" or not cloning_enabled
                    else "rejected",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "create_voice_profile", request, response, envelope
                )
                self._cache_mutation("create_voice_profile", request, response, envelope)
                return response
            payload = b"".join(session.chunks[index] for index in sorted(session.chunks))
            try:
                accepted_duration_ms = _voice_import_duration_ms(payload, session)
            except ValueError:
                response = TTSCreateVoiceProfileResponse(
                    status="rejected",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "create_voice_profile", request, response, envelope
                )
                self._cache_mutation("create_voice_profile", request, response, envelope)
                return response
            planned_response = TTSCreateVoiceProfileResponse(
                voice_id="clone:00000000-0000-4000-8000-000000000000",
                status="ready",
                accepted_duration_ms=accepted_duration_ms,
                revision=f"clone-rev-{hashlib.sha256(payload).hexdigest()[:16]}",
                correlation_id=request.correlation_id,
            )
            await self._audit_voice_management(
                "create_voice_profile",
                request,
                planned_response,
                envelope,
                phase="intent",
                audit_status="attempted",
            )
            try:
                provider_config = await self._pockettts_provider_config(tts_cfg)
                artifact_bytes, identity = await derive_pockettts_voice_state_artifact(
                    provider_config,
                    payload,
                    audio_suffix=".wav" if session.audio_format == "wav" else ".pcm",
                )
                artifact_revision = f"clone-rev-{hashlib.sha256(artifact_bytes).hexdigest()[:16]}"
                created = await self._voice_registry(tts_cfg).create_clone_profile(
                    display_name=request.display_name,
                    runtime_target=identity.runtime_target,
                    language_bundle=identity.language_bundle,
                    compatibility_group=identity.compatibility_group,
                    artifact_revision=artifact_revision,
                    artifact_bytes=artifact_bytes,
                    source_audio=None,
                    source_retention=False,
                    visibility="private",
                )
            except (TTSProviderError, VoiceRegistryError) as exc:
                log_error(f"TTS clone creation failed: error={_safe_tts_error(exc)}")
                response = TTSCreateVoiceProfileResponse(
                    status="unavailable"
                    if isinstance(exc, TTSProviderError) and exc.code == "unavailable"
                    else "rejected",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "create_voice_profile", request, response, envelope
                )
                self._cache_mutation("create_voice_profile", request, response, envelope)
                return response
            else:
                response = TTSCreateVoiceProfileResponse(
                    voice_id=created.voice_id,
                    status="ready",
                    accepted_duration_ms=accepted_duration_ms,
                    revision=created.metadata_revision,
                    correlation_id=request.correlation_id,
                )
                self._voice_revision += 1
                self._voice_import_sessions.pop(session.upload_id, None)
                await self._initialize_engine_fail_soft("voice profile creation")
            await self._audit_voice_management("create_voice_profile", request, response, envelope)
            self._cache_mutation("create_voice_profile", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.DELETE_VOICE_PROFILE,
        summary="Delete a managed cloned TTS voice profile",
        input_model=TTSDeleteVoiceProfileRequest,
        output_model=TTSDeleteVoiceProfileResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def delete_voice_profile(
        self, request: TTSDeleteVoiceProfileRequest, envelope: Envelope | None = None
    ) -> TTSDeleteVoiceProfileResponse:
        """Delete clone profiles through the local voice registry for authorized managers."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("delete_voice_profile", request, envelope)
            if cached is not None:
                return cached
            profile = next(
                (
                    item
                    for item in await self._current_voice_profiles()
                    if item.voice_id == request.voice_id
                ),
                None,
            )
            if profile is None:
                response = TTSDeleteVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="not_found",
                    correlation_id=request.correlation_id,
                )
            elif (
                request.expected_revision is not None
                and request.expected_revision != profile.revision
            ):
                response = TTSDeleteVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="revision_conflict",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
            elif profile.kind != "cloned" or profile.default or profile.active:
                response = TTSDeleteVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="rejected",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
            else:
                response = TTSDeleteVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="deleted",
                    revision=f"voice-rev-{self._voice_revision + 1}",
                    correlation_id=request.correlation_id,
                )
                await self._audit_voice_management(
                    "delete_voice_profile",
                    request,
                    response,
                    envelope,
                    phase="intent",
                    audit_status="attempted",
                )
                await self._voice_registry(
                    await config_api.aget(ConfigKeys.services.tts, Tts)
                ).delete_voice(request.voice_id)
                self._voice_revision += 1
            if response.status != "deleted":
                await self._audit_voice_management(
                    "delete_voice_profile", request, response, envelope
                )
            self._cache_mutation("delete_voice_profile", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.EXPORT_VOICE_PROFILE,
        summary="Export a managed cloned TTS voice profile",
        input_model=TTSExportVoiceProfileRequest,
        output_model=TTSExportVoiceProfileResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def export_voice_profile(
        self, request: TTSExportVoiceProfileRequest, envelope: Envelope | None = None
    ) -> TTSExportVoiceProfileResponse:
        """Export a derived cloned voice-state bundle for authorized managers."""
        async with self._voice_management_lock:
            tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
            profile = next(
                (
                    item
                    for item in await self._current_voice_profiles()
                    if item.voice_id == request.voice_id
                ),
                None,
            )
            if profile is None:
                response = TTSExportVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="not_found",
                    correlation_id=request.correlation_id,
                )
            elif (
                request.expected_revision is not None
                and request.expected_revision != profile.revision
            ):
                response = TTSExportVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="revision_conflict",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
            elif profile.kind != "cloned" or not profile.ready:
                response = TTSExportVoiceProfileResponse(
                    voice_id=request.voice_id,
                    status="rejected",
                    revision=profile.revision,
                    correlation_id=request.correlation_id,
                )
            else:
                registry_cfg = tts_cfg.voice_registry
                cloning_enabled = (
                    registry_cfg.cloning_enabled
                    if registry_cfg and registry_cfg.cloning_enabled is not None
                    else True
                )
                max_wire_bytes = (
                    registry_cfg.clone_max_wire_bytes
                    if registry_cfg and registry_cfg.clone_max_wire_bytes is not None
                    else VOICE_STATE_TRANSFER_MAX_BYTES
                )
                if tts_cfg.provider != "pockettts" or not cloning_enabled:
                    response = TTSExportVoiceProfileResponse(
                        voice_id=request.voice_id,
                        status="unavailable",
                        revision=profile.revision,
                        correlation_id=request.correlation_id,
                    )
                else:
                    planned_response = type(
                        "PlannedVoiceProfileExport",
                        (),
                        {"status": "exported"},
                    )()
                    await self._audit_voice_management(
                        "export_voice_profile",
                        request,
                        planned_response,
                        envelope,
                        phase="intent",
                        audit_status="attempted",
                    )
                    try:
                        provider_config = await self._pockettts_provider_config(tts_cfg)
                        identity = resolve_pockettts_base_identity_spec(
                            provider_config
                        ).voice_base_identity
                        exported = await self._voice_registry(tts_cfg).export_clone_voice_state(
                            request.voice_id, identity
                        )
                        if exported.size_bytes > max_wire_bytes:
                            raise VoiceRegistryError(
                                "exported voice state exceeds configured limit"
                            )
                        bundle = TTSCloneVoiceStateBundle(
                            voice_id=exported.voice_id,
                            display_name=profile.display_name,
                            runtime_target=exported.runtime_target,
                            language_bundle=exported.language_bundle,
                            compatibility_group=exported.compatibility_group,
                            artifact_revision=exported.artifact_revision,
                            artifact_format=exported.format,
                            artifact_sha256=exported.sha256,
                            artifact_size_bytes=exported.size_bytes,
                            artifact_data_base64=base64.b64encode(exported.artifact_bytes).decode(
                                "ascii"
                            ),
                        )
                        response = TTSExportVoiceProfileResponse(
                            voice_id=request.voice_id,
                            status="exported",
                            revision=profile.revision,
                            bundle=bundle,
                            correlation_id=request.correlation_id,
                        )
                    except TTSProviderError as exc:
                        response = TTSExportVoiceProfileResponse(
                            voice_id=request.voice_id,
                            status="unavailable",
                            revision=profile.revision,
                            correlation_id=request.correlation_id,
                        )
                        log_error(f"TTS clone export unavailable: error={_safe_tts_error(exc)}")
                    except VoiceRegistryError as exc:
                        response = TTSExportVoiceProfileResponse(
                            voice_id=request.voice_id,
                            status="rejected",
                            revision=profile.revision,
                            correlation_id=request.correlation_id,
                        )
                        log_error(f"TTS clone export rejected: error={_safe_tts_error(exc)}")
            await self._audit_voice_management("export_voice_profile", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.IMPORT_VOICE_PROFILE,
        summary="Import a managed cloned TTS voice profile",
        input_model=TTSImportVoiceProfileRequest,
        output_model=TTSImportVoiceProfileResponse,
        exposure="both",
        method_type="manage",
        required_perms=["TTS.manage"],
        callable_feature_ids=["speech_voice_management"],
    )
    async def import_voice_profile(
        self, request: TTSImportVoiceProfileRequest, envelope: Envelope | None = None
    ) -> TTSImportVoiceProfileResponse:
        """Import a derived cloned voice-state bundle for authorized managers."""
        async with self._voice_management_lock:
            cached = self._cached_mutation("import_voice_profile", request, envelope)
            if cached is not None:
                return cached
            tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
            registry_cfg = tts_cfg.voice_registry
            cloning_enabled = (
                registry_cfg.cloning_enabled
                if registry_cfg and registry_cfg.cloning_enabled is not None
                else True
            )
            max_wire_bytes = (
                registry_cfg.clone_max_wire_bytes
                if registry_cfg and registry_cfg.clone_max_wire_bytes is not None
                else VOICE_STATE_TRANSFER_MAX_BYTES
            )
            bundle = request.bundle
            voice_id = bundle.voice_id
            if tts_cfg.provider != "pockettts" or not cloning_enabled:
                response = TTSImportVoiceProfileResponse(
                    voice_id=voice_id,
                    status="unavailable",
                    correlation_id=request.correlation_id,
                )
            else:
                try:
                    artifact_bytes = base64.b64decode(bundle.artifact_data_base64, validate=True)
                    if len(artifact_bytes) > max_wire_bytes:
                        raise VoiceRegistryError("imported voice state exceeds configured limit")
                    provider_config = await self._pockettts_provider_config(tts_cfg)
                    identity = resolve_pockettts_base_identity_spec(
                        provider_config
                    ).voice_base_identity
                    if (
                        bundle.runtime_target,
                        bundle.language_bundle,
                        bundle.compatibility_group,
                    ) != identity.as_tuple():
                        response = TTSImportVoiceProfileResponse(
                            voice_id=voice_id,
                            status="rejected",
                            revision=bundle.artifact_revision,
                            correlation_id=request.correlation_id,
                        )
                    else:
                        planned_response = TTSImportVoiceProfileResponse(
                            voice_id=voice_id,
                            status="imported",
                            revision=bundle.artifact_revision,
                            correlation_id=request.correlation_id,
                        )
                        await self._audit_voice_management(
                            "import_voice_profile",
                            request,
                            planned_response,
                            envelope,
                            phase="intent",
                            audit_status="attempted",
                        )
                        entry, created = await self._voice_registry(
                            tts_cfg
                        ).import_clone_voice_state(
                            ExportedCloneVoiceState(
                                voice_id=voice_id,
                                runtime_target=bundle.runtime_target,
                                language_bundle=bundle.language_bundle,
                                compatibility_group=bundle.compatibility_group,
                                artifact_revision=bundle.artifact_revision,
                                sha256=bundle.artifact_sha256,
                                size_bytes=bundle.artifact_size_bytes,
                                format=bundle.artifact_format,
                                artifact_bytes=artifact_bytes,
                            ),
                            display_name=bundle.display_name,
                            visibility="private",
                        )
                        if created:
                            self._voice_revision += 1
                            await self._initialize_engine_fail_soft("voice profile import")
                        response = TTSImportVoiceProfileResponse(
                            voice_id=voice_id,
                            status="imported" if created else "unchanged",
                            revision=entry.metadata_revision,
                            idempotent=not created,
                            correlation_id=request.correlation_id,
                        )
                except TTSProviderError as exc:
                    response = TTSImportVoiceProfileResponse(
                        voice_id=voice_id,
                        status="unavailable",
                        correlation_id=request.correlation_id,
                    )
                    log_error(f"TTS clone import unavailable: error={_safe_tts_error(exc)}")
                except VoiceRegistryError as exc:
                    status = "conflict" if "conflict" in str(exc) else "rejected"
                    response = TTSImportVoiceProfileResponse(
                        voice_id=voice_id,
                        status=status,  # type: ignore[arg-type]
                        revision=bundle.artifact_revision,
                        correlation_id=request.correlation_id,
                    )
                    log_error(f"TTS clone import rejected: error={_safe_tts_error(exc)}")
            await self._audit_voice_management("import_voice_profile", request, response, envelope)
            self._cache_mutation("import_voice_profile", request, response, envelope)
        return response

    @method_contract(
        method_id=TTSMethods.REQUEST,
        summary="Process text-to-speech request (plays on server)",
        input_model=TTSRequest,
        output_model=EmptyOutput,
        exposure="both",
        method_type="use",
        required_perms=[TTSMethods.REQUEST],
        callable_feature_ids=["speech_playback"],
    )
    async def _on_tts_request(self, request: TTSRequest) -> EmptyOutput:
        """Handle TTS request command.

        Args:
            request: TTSRequest command (payload already extracted by base_service wrapper)

        Returns:
            EmptyOutput on success
        """
        try:
            log_info(
                f"TTS request: {_text_log_metadata(request.text)} interrupt={request.interrupt}"
            )

            # Handle interruption
            if request.interrupt and self._playing:
                log_info("Interrupting current TTS playback")
                await self._stop_playback("interrupted")

            # Generate unique ID for this request
            import uuid

            request_id = str(uuid.uuid4())

            # Start playback
            await self._play_text(
                request.text, request_id, voice=request.voice, speed=request.speed
            )

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error handling TTS request: error={_safe_tts_error(e)}")
            import uuid

            request_id = str(uuid.uuid4())
            await self.bus.publish(
                TTSMethods.ERROR,
                TTSErrorEvent(request_id=request_id, error=_safe_tts_event_error(e)),
                event=True,
                mesh=False,
                origin="internal",
            )
            return EmptyOutput()

    @method_contract(
        method_id=TTSMethods.STREAM_START,
        summary="Start an ordered text-to-speech audio stream",
        input_model=TTSStreamStartRequest,
        output_model=EmptyOutput,
        exposure="both",
        method_type="use",
        required_perms=[TTSMethods.STREAM_START],
        callable_feature_ids=["speech_streaming"],
    )
    async def _on_stream_start(
        self, request: TTSStreamStartRequest, envelope: Envelope | None = None
    ) -> EmptyOutput:
        """Start a streaming TTS session that emits audio chunk events."""
        try:
            log_info(
                f"TTS stream start: stream_id={request.stream_id} interrupt={request.interrupt}"
            )
            caller_peer_id = _envelope_caller_peer_id(envelope)
            principal_id = _envelope_principal_id(envelope)
            correlation_id = request.correlation_id or _envelope_correlation_id(envelope)
            async with self._stream_state_lock:
                existing = self._stream_states.get(request.stream_id)
                if existing is not None and not _stream_update_allowed(
                    existing, envelope, correlation_id
                ):
                    return EmptyOutput()

            if request.interrupt:
                if caller_peer_id is None and principal_id is None and request.play_on_server:
                    await self._stop_playback("interrupted")
                await self._clear_tts_streams(
                    "interrupted",
                    caller_peer_id=caller_peer_id,
                    principal_id=principal_id,
                    correlation_id=correlation_id,
                    require_correlation=caller_peer_id is not None or principal_id is not None,
                )

            async with self._stream_state_lock:
                existing = self._stream_states.get(request.stream_id)
                if existing is not None and not _stream_update_allowed(
                    existing, envelope, correlation_id
                ):
                    return EmptyOutput()
                self._stream_states[request.stream_id] = _TTSStreamState(
                    stream_id=request.stream_id,
                    audio_format=request.format,
                    requested_sample_rate=request.sample_rate,
                    voice=request.voice,
                    speed=request.speed,
                    play_on_server=request.play_on_server,
                    correlation_id=correlation_id,
                    caller_peer_id=caller_peer_id,
                    principal_id=principal_id,
                )
            return EmptyOutput()
        except Exception as e:
            log_error(f"Error starting TTS stream: error={_safe_tts_error(e)}")
            await self._publish_stream_error(
                request.stream_id,
                _safe_tts_event_error(e),
                request.correlation_id or _envelope_correlation_id(envelope),
                caller_peer_id=_envelope_caller_peer_id(envelope),
                principal_id=_envelope_principal_id(envelope),
            )
            return EmptyOutput()

    @method_contract(
        method_id=TTSMethods.STREAM_CHUNK,
        summary="Process an ordered text chunk for a TTS audio stream",
        input_model=TTSStreamChunkRequest,
        output_model=EmptyOutput,
        exposure="both",
        method_type="use",
        required_perms=[TTSMethods.STREAM_CHUNK],
        callable_feature_ids=["speech_streaming"],
    )
    async def _on_stream_chunk(
        self, request: TTSStreamChunkRequest, envelope: Envelope | None = None
    ) -> EmptyOutput:
        """Buffer and synthesize a text chunk once prior chunks have arrived."""
        try:
            correlation_id = request.correlation_id or _envelope_correlation_id(envelope)
            async with self._stream_state_lock:
                state = self._stream_states.get(request.stream_id)
                if state is None:
                    raise ValueError(f"Unknown TTS stream_id: {request.stream_id}")
                if not _stream_update_allowed(state, envelope, correlation_id):
                    return EmptyOutput()
                if correlation_id is not None and state.correlation_id is None:
                    state.correlation_id = correlation_id
                if request.sequence < state.next_text_sequence:
                    log_debug(
                        f"Ignoring duplicate TTS stream chunk: stream_id={request.stream_id} "
                        f"sequence={request.sequence}"
                    )
                    return EmptyOutput()
                state.pending[request.sequence] = request.text
                if request.is_final:
                    state.final_text_sequence = request.sequence
                    state.end_reason = "completed"

            await self._drain_stream(request.stream_id)
            return EmptyOutput()
        except Exception as e:
            log_error(
                f"Error processing TTS stream chunk: error={_safe_tts_error(e)}",
            )
            await self._publish_stream_error(
                request.stream_id,
                _safe_tts_event_error(e),
                request.correlation_id or _envelope_correlation_id(envelope),
                caller_peer_id=_envelope_caller_peer_id(envelope),
                principal_id=_envelope_principal_id(envelope),
            )
            return EmptyOutput()

    @method_contract(
        method_id=TTSMethods.STREAM_END,
        summary="End an ordered text-to-speech audio stream",
        input_model=TTSStreamEndRequest,
        output_model=EmptyOutput,
        exposure="both",
        method_type="use",
        required_perms=[TTSMethods.STREAM_END],
        callable_feature_ids=["speech_streaming"],
    )
    async def _on_stream_end(
        self, request: TTSStreamEndRequest, envelope: Envelope | None = None
    ) -> EmptyOutput:
        """Mark a streaming TTS session complete after all expected chunks drain."""
        try:
            correlation_id = request.correlation_id or _envelope_correlation_id(envelope)
            async with self._stream_state_lock:
                state = self._stream_states.get(request.stream_id)
                if state is None:
                    return EmptyOutput()
                if not _stream_update_allowed(state, envelope, correlation_id):
                    return EmptyOutput()
                state.final_text_sequence = (
                    request.final_sequence
                    if request.final_sequence is not None
                    else max(state.pending.keys(), default=state.next_text_sequence - 1)
                )
                state.end_reason = request.reason
                if correlation_id is not None and state.correlation_id is None:
                    state.correlation_id = correlation_id

            await self._drain_stream(request.stream_id)
            return EmptyOutput()
        except Exception as e:
            log_error(f"Error ending TTS stream: error={_safe_tts_error(e)}")
            await self._publish_stream_error(
                request.stream_id,
                _safe_tts_event_error(e),
                request.correlation_id or _envelope_correlation_id(envelope),
                caller_peer_id=_envelope_caller_peer_id(envelope),
                principal_id=_envelope_principal_id(envelope),
            )
            return EmptyOutput()

    @method_contract(
        method_id=TTSMethods.STOP,
        summary="Stop current TTS playback (server audio)",
        input_model=TTSStopRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
        required_perms=[TTSMethods.STOP],
    )
    async def _on_stop(
        self, request: TTSStopRequest | EmptyInput | None = None, envelope: Envelope | None = None
    ) -> EmptyOutput:
        """Handle TTS stop command.

        Args:
            request: Optional stop payload (empty payload remains valid for legacy callers).
        """
        try:
            log_info("TTS stop requested")
            stop_request = request if isinstance(request, TTSStopRequest) else TTSStopRequest()
            caller_peer_id = _envelope_caller_peer_id(envelope)
            principal_id = _envelope_principal_id(envelope)
            correlation_id = stop_request.correlation_id or _envelope_correlation_id(envelope)
            has_external_owner = caller_peer_id is not None or principal_id is not None
            trusted_global_stop = (
                not has_external_owner and correlation_id is None and stop_request.stream_id is None
            )

            if trusted_global_stop:
                await self._stop_playback(stop_request.reason)
                await self._clear_tts_streams(stop_request.reason)
                return EmptyOutput()

            if has_external_owner and correlation_id is None:
                log_info("Ignoring scoped TTS stop without caller correlation")
                return EmptyOutput()

            await self._clear_tts_streams(
                stop_request.reason,
                caller_peer_id=caller_peer_id,
                principal_id=principal_id,
                correlation_id=correlation_id,
                stream_id=stop_request.stream_id,
                require_correlation=True,
            )
            return EmptyOutput()
        except Exception as e:
            log_error(f"Error stopping TTS: error={_safe_tts_error(e)}")
            return EmptyOutput()

    @method_contract(
        method_id=TTSMethods.PAUSE,
        summary="Pause current TTS playback",
        input_model=EmptyInput,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
        required_perms=[TTSMethods.PAUSE],
    )
    async def _on_pause(self, request: EmptyInput) -> EmptyOutput:
        """Handle TTS pause command.

        Args:
            request: Empty input (payload already extracted by base_service wrapper)
        """
        try:
            if self._playing and not self._paused:
                log_info("Pausing TTS playback")
                self._paused = True

                # Pause audio playback
                self.stream.pause()

                await self.bus.publish(
                    TTSMethods.PAUSED,
                    TTSPaused(request_id=""),
                    event=True,
                    mesh=False,
                    origin="internal",
                )
            return EmptyOutput()
        except Exception as e:
            log_error(f"Error pausing TTS: error={_safe_tts_error(e)}")
            return EmptyOutput()

    @method_contract(
        method_id=TTSMethods.RESUME,
        summary="Resume paused TTS playback",
        input_model=EmptyInput,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
        required_perms=[TTSMethods.RESUME],
    )
    async def _on_resume(self, request: EmptyInput) -> EmptyOutput:
        """Handle TTS resume command.

        Args:
            request: Empty input (payload already extracted by base_service wrapper)
        """
        try:
            if self._playing and self._paused:
                log_info("Resuming TTS playback")
                self._paused = False

                # Resume audio playback
                self.stream.resume()

                await self.bus.publish(
                    TTSMethods.RESUMED,
                    TTSResumed(request_id=""),
                    event=True,
                    mesh=False,
                    origin="internal",
                )
            return EmptyOutput()
        except Exception as e:
            log_error(f"Error resuming TTS: error={_safe_tts_error(e)}")
            return EmptyOutput()

    async def _ensure_voice_available(self, voice: str | None) -> None:
        """Validate a logical voice against the active provider."""
        if voice is None:
            return
        if self._provider is None:
            raise TTSProviderError("unavailable", "TTS voice is unavailable")
        voices = await self._provider.list_voices()
        if not any(item.voice_id == voice and item.ready for item in voices):
            raise TTSProviderError("unsupported_voice", "TTS voice is unavailable")

    def _begin_playback_request(self, request_id: str, text: str) -> int:
        """Register a provider-backed playback request before synthesis starts."""
        self._playback_generation += 1
        self._current_playback_generation = self._playback_generation
        self._playing = True
        self._paused = False
        self._playback_started = False
        self._current_text = text
        self._current_request_id = request_id
        self._active_playback_provider_request_ids.add(request_id)
        return self._playback_generation

    def _is_current_playback(self, playback_id: int) -> bool:
        """Return whether a provider-backed playback token is still current."""
        return self._current_playback_generation == playback_id and self._playing

    def _clear_playback_state(self) -> None:
        """Clear current local playback state."""
        self._playing = False
        self._paused = False
        self._playback_started = False
        self._current_text = None
        self._current_request_id = None
        self._current_playback_generation = None
        self._active_playback_provider_request_ids.clear()

    async def _cancel_active_playback_provider_requests(self) -> None:
        """Cancel provider requests backing local playback."""
        if self._provider is None:
            self._active_playback_provider_request_ids.clear()
            return
        request_ids = tuple(self._active_playback_provider_request_ids)
        self._active_playback_provider_request_ids.clear()
        for request_id in request_ids:
            with contextlib.suppress(Exception):
                await self._provider.cancel(request_id)

    async def _play_text(
        self, text: str, request_id: str, *, voice: str | None = None, speed: float = 1.0
    ) -> None:
        """Play text-to-speech audio using the active local playback runtime.

        Args:
            text: Text to speak
            request_id: Request ID for tracking
        """
        try:
            await self._ensure_voice_available(voice)
            if getattr(self.stream, "supports_pcm", False) is True:
                playback_id = self._begin_playback_request(request_id, text)
                try:
                    audio_bytes, sample_rate = await self._synthesize_to_bytes(
                        text,
                        request_id=request_id,
                        voice=voice,
                        speed=speed,
                    )
                except Exception:
                    if not self._is_current_playback(playback_id):
                        return
                    raise
                finally:
                    self._active_playback_provider_request_ids.discard(request_id)
                if not self._is_current_playback(playback_id):
                    return
                await self._play_audio_bytes(
                    audio_bytes,
                    sample_rate,
                    request_id=request_id,
                    text=text,
                    append=False,
                    playback_id=playback_id,
                )
                return

            self._playing = True
            self._current_text = text
            self._current_request_id = request_id

            # Emit started event
            await self.bus.publish(
                TTSMethods.STARTED,
                TTSStarted(request_id=request_id, text=text),
                event=True,
                mesh=False,
                origin="internal",
            )

            # Feed text to stream and play asynchronously
            log_info(f"Playing TTS: {_text_log_metadata(text)}")
            self.stream.feed(text)
            self.stream.play_async()

            # Note: Completion event will be emitted by _on_audio_stop callback
            # when the audio stream actually finishes playing

        except Exception as e:
            log_error(f"Error playing TTS: error={_safe_tts_error(e)}")
            self._playing = False
            self._current_text = None
            self._current_request_id = None
            raise

    async def _play_audio_bytes(
        self,
        audio_bytes: bytes,
        sample_rate: int,
        *,
        request_id: str,
        text: str,
        append: bool,
        playback_id: int | None = None,
    ) -> None:
        """Queue provider-produced PCM bytes for local server playback."""
        if getattr(self.stream, "supports_pcm", False) is not True:
            raise RuntimeError("TTS playback does not accept provider audio")
        was_playing = self._playing
        previous_text = self._current_text
        previous_request_id = self._current_request_id
        previous_paused = self._paused
        if not append or not self._playing:
            if playback_id is None or not self._is_current_playback(playback_id):
                playback_id = self._begin_playback_state(request_id, text)
            await self.bus.publish(
                TTSMethods.STARTED,
                TTSStarted(request_id=request_id, text=text),
                event=True,
                mesh=False,
                origin="internal",
            )
            self._playback_started = True
            try:
                await asyncio.to_thread(
                    self.stream.play_pcm_async,
                    audio_bytes,
                    sample_rate=sample_rate,
                    playback_id=playback_id,
                )
            except Exception:
                self._playing = was_playing
                self._paused = previous_paused
                self._current_text = previous_text
                self._current_request_id = previous_request_id
                await self._publish_playback_failure(request_id, playback_id)
                return
            log_info(f"Playing TTS: {_text_log_metadata(text)}")
            return

        self._current_text = f"{self._current_text or ''}{text}"
        playback_id = self._current_playback_generation
        if playback_id is None:
            return
        try:
            await asyncio.to_thread(
                self.stream.play_pcm_async,
                audio_bytes,
                sample_rate=sample_rate,
                playback_id=playback_id,
            )
        except Exception:
            self._current_text = previous_text
            await self._publish_playback_failure(request_id, playback_id)

    def _begin_playback_state(self, request_id: str, text: str) -> int:
        """Register local playback state that is not backed by active synthesis."""
        self._playback_generation += 1
        self._current_playback_generation = self._playback_generation
        self._playing = True
        self._paused = False
        self._playback_started = False
        self._current_text = text
        self._current_request_id = request_id
        return self._playback_generation

    async def _publish_playback_failure(self, request_id: str | None, playback_id: int) -> None:
        """Publish TTS output failure and failed terminal event for current playback."""
        if playback_id != self._current_playback_generation:
            return
        await self.bus.publish(
            TTSMethods.ERROR,
            TTSErrorEvent(request_id=request_id or "", error="TTS audio output failed"),
            event=True,
            mesh=False,
            origin="internal",
        )
        await self._complete_pcm_playback(playback_id, "failed")

    async def _stop_playback(self, reason: str) -> None:
        """Stop current TTS playback.

        Args:
            reason: Reason for stopping
        """
        if self._playing:
            # Capture request_id before clearing state
            request_id = self._current_request_id
            started = self._playback_started or self._current_playback_generation is None

            await self._cancel_active_playback_provider_requests()

            # Stop audio stream
            await self._stop_playback_stream(self.stream)

            self._clear_playback_state()

            if started:
                await self.bus.publish(
                    TTSMethods.STOPPED,
                    TTSStopped(request_id=request_id, reason=reason),
                    event=True,
                    mesh=False,
                    origin="internal",
                )
            log_info(f"TTS playback stopped: {reason}")

    async def _synthesize_to_bytes(
        self,
        text: str,
        *,
        request_id: str | None = None,
        voice: str | None = None,
        audio_format: str = "raw",
        sample_rate: int | None = None,
        speed: float = 1.0,
    ) -> tuple[bytes, int]:
        """Synthesize text to audio bytes without playing.

        Args:
            text: Text to synthesize

        Returns:
            Tuple of (audio_bytes, sample_rate)
        """
        if self._provider is None:
            raise TTSProviderError("unavailable", "TTS voice is unavailable")
        try:
            result = await self._provider.synthesize(
                ProviderSynthesisRequest(
                    text=text,
                    request_id=request_id,
                    voice=voice,
                    audio_format=audio_format,  # type: ignore[arg-type]
                    sample_rate=sample_rate,
                    speed=speed,
                )
            )
        except TTSProviderError as exc:
            raise RuntimeError(_safe_tts_event_error(exc)) from exc
        return result.audio, result.sample_rate

    @method_contract(
        method_id=TTSMethods.SYNTHESIZE,
        summary="Synthesize text to audio and return audio data",
        input_model=TTSSynthesizeRequest,
        output_model=TTSSynthesizeResponse,
        exposure="both",
        method_type="use",
        required_perms=[TTSMethods.SYNTHESIZE],
        callable_feature_ids=["speech_synthesis"],
    )
    async def synthesize(self, request: TTSSynthesizeRequest) -> TTSSynthesizeResponse:
        """Synthesize text to audio and return as base64-encoded data.

        This endpoint is for external API consumers who want to receive
        the audio data rather than have it played on the server.

        Args:
            request: TTSSynthesizeRequest with text and format options

        Returns:
            TTSSynthesizeResponse with base64-encoded audio data
        """
        try:
            log_info(
                f"TTS synthesize request: {_text_log_metadata(request.text)} "
                f"format={request.format}"
            )

            # Synthesize audio
            audio_bytes, sample_rate = await self._synthesize_to_bytes(
                request.text,
                voice=request.voice,
                sample_rate=request.sample_rate,
                speed=request.speed,
            )

            # Calculate duration
            # PCM 16-bit mono: duration = num_bytes / (sample_rate * 2)
            duration_ms = (len(audio_bytes) / (sample_rate * 2)) * 1000

            # Format output based on request
            if request.format == "wav":
                # Wrap raw PCM in WAV container
                wav_buffer = io.BytesIO()
                with wave.open(wav_buffer, "wb") as wav_file:
                    wav_file.setnchannels(1)
                    wav_file.setsampwidth(2)  # 16-bit
                    wav_file.setframerate(sample_rate)
                    wav_file.writeframes(audio_bytes)
                output_bytes = wav_buffer.getvalue()
            else:
                # Return raw PCM
                output_bytes = audio_bytes

            # Encode as base64
            audio_b64 = base64.b64encode(output_bytes).decode("utf-8")

            log_info(f"TTS synthesis complete: {len(output_bytes)} bytes, {duration_ms:.0f}ms")

            return TTSSynthesizeResponse(
                audio_data=audio_b64,
                format=request.format,
                sample_rate=sample_rate,
                channels=1,
                duration_ms=duration_ms,
                text=request.text,
            )

        except Exception as e:
            log_error(f"Error in TTS synthesis: error={_safe_tts_error(e)}")
            raise

    async def _drain_stream(self, stream_id: str) -> None:
        """Synthesize all currently contiguous text chunks for a stream in order."""
        async with self._stream_state_lock:
            state = self._stream_states.get(stream_id)
            if state is None or state.draining:
                return
            state.draining = True

        try:
            while True:
                async with self._stream_state_lock:
                    state = self._stream_states.get(stream_id)
                    if state is None:
                        return

                    if state.next_text_sequence not in state.pending:
                        if self._stream_is_complete(state):
                            final_event = self._build_final_audio_chunk_event(state)
                            final_event_context = (state.caller_peer_id, state.principal_id)
                            del self._stream_states[stream_id]
                        else:
                            state.draining = False
                            final_event = None
                            final_event_context = (None, None)
                        text_sequence = None
                        text = None
                        audio_sequence = None
                        audio_format = "wav"
                        play_on_server = False
                        correlation_id = None
                        caller_peer_id = None
                        principal_id = None
                    else:
                        text_sequence = state.next_text_sequence
                        text = state.pending.pop(text_sequence)
                        audio_format = state.audio_format
                        play_on_server = state.play_on_server
                        correlation_id = state.correlation_id
                        caller_peer_id = state.caller_peer_id
                        principal_id = state.principal_id
                        stream_epoch = state
                        state.next_text_sequence += 1
                        final_event = None

                if final_event is not None:
                    await self._publish_audio_chunk(
                        final_event,
                        caller_peer_id=final_event_context[0],
                        principal_id=final_event_context[1],
                        correlation_id=final_event.correlation_id,
                    )
                    return

                if text_sequence is None or text is None:
                    return

                provider_request_id = f"{stream_id}:{text_sequence}"
                async with self._stream_state_lock:
                    state = self._stream_states.get(stream_id)
                    if state is not stream_epoch:
                        return
                    state.provider_request_ids.add(provider_request_id)
                try:
                    async for provider_chunk in self._stream_provider_audio_chunks(
                        text,
                        request_id=provider_request_id,
                        voice=stream_epoch.voice,
                        sample_rate=stream_epoch.requested_sample_rate,
                        speed=stream_epoch.speed,
                    ):
                        if provider_chunk.is_final:
                            continue
                        audio_bytes = provider_chunk.audio
                        sample_rate = provider_chunk.sample_rate
                        output_bytes, duration_ms = self._format_audio_bytes(
                            audio_bytes, sample_rate, audio_format
                        )
                        async with self._stream_state_lock:
                            state = self._stream_states.get(stream_id)
                            if state is not stream_epoch:
                                return
                            audio_sequence = state.next_audio_sequence
                            state.next_audio_sequence += 1
                            state.emitted_sample_rate = sample_rate
                        await self._publish_audio_chunk(
                            TTSAudioChunkEvent(
                                stream_id=stream_id,
                                sequence=audio_sequence,
                                audio_data=base64.b64encode(output_bytes).decode("utf-8"),
                                format=audio_format,
                                sample_rate=sample_rate,
                                channels=1,
                                duration_ms=duration_ms,
                                text=text,
                                source_sequence=text_sequence,
                                is_final=False,
                                correlation_id=correlation_id,
                            ),
                            caller_peer_id=caller_peer_id,
                            principal_id=principal_id,
                            correlation_id=correlation_id,
                        )
                        if play_on_server:
                            await self._play_stream_audio(
                                text,
                                stream_id,
                                audio_bytes,
                                sample_rate,
                                voice=stream_epoch.voice,
                                speed=stream_epoch.speed,
                            )
                except TTSProviderError as exc:
                    if exc.code == "cancelled" and await self._stream_state_was_cleared(
                        stream_id, stream_epoch
                    ):
                        return
                    raise RuntimeError(_safe_tts_event_error(exc)) from exc
                finally:
                    async with self._stream_state_lock:
                        state = self._stream_states.get(stream_id)
                        if state is stream_epoch:
                            state.provider_request_ids.discard(provider_request_id)
        finally:
            async with self._stream_state_lock:
                state = self._stream_states.get(stream_id)
                if state is not None:
                    state.draining = False

    async def _stream_provider_audio_chunks(
        self,
        text: str,
        *,
        request_id: str,
        voice: str | None,
        sample_rate: int | None,
        speed: float,
    ) -> AsyncIterator[ProviderStreamChunk]:
        """Stream provider audio chunks for a logical stream text chunk."""
        if self._provider is None:
            audio, resolved_sample_rate = await self._synthesize_to_bytes(
                text,
                request_id=request_id,
                voice=voice,
                sample_rate=sample_rate,
                speed=speed,
            )
            yield ProviderStreamChunk(
                sequence=0,
                audio=audio,
                sample_rate=resolved_sample_rate,
                channels=1,
                duration_ms=(len(audio) / (resolved_sample_rate * 2)) * 1000,
            )
            yield ProviderStreamChunk(
                sequence=1,
                audio=b"",
                sample_rate=resolved_sample_rate,
                channels=1,
                is_final=True,
            )
            return
        async for chunk in self._provider.stream(
            ProviderSynthesisRequest(
                text=text,
                request_id=request_id,
                voice=voice,
                audio_format="raw",
                sample_rate=sample_rate,
                speed=speed,
            )
        ):
            yield chunk

    async def _stream_state_was_cleared(
        self, stream_id: str, stream_epoch: _TTSStreamState
    ) -> bool:
        """Return whether a stream was removed while provider work was in flight."""
        async with self._stream_state_lock:
            return self._stream_states.get(stream_id) is not stream_epoch

    async def _play_stream_audio(
        self,
        text: str,
        stream_id: str,
        audio_bytes: bytes,
        sample_rate: int,
        *,
        voice: str | None = None,
        speed: float = 1.0,
    ) -> None:
        """Feed streamed text to the local server audio output without restarting playback."""
        if not text.strip():
            return
        await self._ensure_voice_available(voice)
        if getattr(self.stream, "supports_pcm", False) is True:
            await self._play_audio_bytes(
                audio_bytes,
                sample_rate,
                request_id=stream_id,
                text=text,
                append=True,
            )
            return
        if not self._playing:
            self._playing = True
            self._current_text = text
            self._current_request_id = stream_id
            await self.bus.publish(
                TTSMethods.STARTED,
                TTSStarted(request_id=stream_id, text=text),
                event=True,
                mesh=False,
                origin="internal",
            )
            self.stream.feed(text)
            self.stream.play_async()
            return

        self._current_text = f"{self._current_text or ''}{text}"
        self.stream.feed(text)

    def _stream_is_complete(self, state: _TTSStreamState) -> bool:
        """Return True when the stream has consumed all expected text chunks."""
        return (
            state.final_text_sequence is not None
            and state.next_text_sequence > state.final_text_sequence
        )

    def _build_final_audio_chunk_event(self, state: _TTSStreamState) -> TTSAudioChunkEvent:
        """Build the terminal empty audio chunk for a completed stream."""
        return TTSAudioChunkEvent(
            stream_id=state.stream_id,
            sequence=state.next_audio_sequence,
            audio_data="",
            format=state.audio_format,
            sample_rate=state.emitted_sample_rate or state.requested_sample_rate or 0,
            channels=1,
            duration_ms=0,
            is_final=True,
            reason=state.end_reason,
            correlation_id=state.correlation_id,
        )

    def _format_audio_bytes(
        self, audio_bytes: bytes, sample_rate: int, audio_format: str
    ) -> tuple[bytes, float]:
        """Format raw PCM audio bytes for stream events."""
        if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0:
            raise RuntimeError("TTS provider returned an invalid sample rate")
        duration_ms = (len(audio_bytes) / (sample_rate * 2)) * 1000
        if audio_format == "wav":
            wav_buffer = io.BytesIO()
            with wave.open(wav_buffer, "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(audio_bytes)
            return wav_buffer.getvalue(), duration_ms
        return audio_bytes, duration_ms

    async def _publish_audio_chunk(
        self,
        event: TTSAudioChunkEvent,
        *,
        caller_peer_id: str | None = None,
        principal_id: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Publish a TTS audio chunk event."""
        target_peer_id = caller_peer_id or None
        trace_id = correlation_id or event.correlation_id
        await self.bus.publish(
            TTSMethods.AUDIO_CHUNK,
            event,
            event=True,
            mesh=bool(target_peer_id and trace_id),
            origin="internal",
            caller_peer_id=target_peer_id,
            principal_id=principal_id,
            correlation_id=trace_id,
        )

    async def _clear_tts_streams(
        self,
        reason: str,
        *,
        caller_peer_id: str | None | object = _GLOBAL_TTS_STREAM_CLEAR,
        principal_id: str | None = None,
        correlation_id: str | None = None,
        stream_id: str | None = None,
        require_correlation: bool = False,
    ) -> None:
        """Clear active TTS stream state and emit terminal chunk events."""
        async with self._stream_state_lock:
            if caller_peer_id is _GLOBAL_TTS_STREAM_CLEAR:
                states = list(self._stream_states.values())
                self._stream_states.clear()
            else:
                states = [
                    state
                    for state in self._stream_states.values()
                    if _stream_matches_owner(
                        state,
                        caller_peer_id=caller_peer_id,
                        principal_id=principal_id,
                        correlation_id=correlation_id,
                        stream_id=stream_id,
                        require_correlation=require_correlation,
                    )
                ]
                for state in states:
                    self._stream_states.pop(state.stream_id, None)

        for state in states:
            await self._cancel_stream_provider_requests(state)
            state.end_reason = reason
            await self._publish_audio_chunk(
                self._build_final_audio_chunk_event(state),
                caller_peer_id=state.caller_peer_id,
                principal_id=state.principal_id,
                correlation_id=state.correlation_id,
            )

    async def _cancel_stream_provider_requests(self, state: _TTSStreamState) -> None:
        """Cancel provider work backing a logical stream."""
        if self._provider is None:
            state.provider_request_ids.clear()
            return
        request_ids = tuple(state.provider_request_ids)
        state.provider_request_ids.clear()
        for request_id in request_ids:
            with contextlib.suppress(Exception):
                await self._provider.cancel(request_id)

    async def _publish_stream_error(
        self,
        stream_id: str,
        error: str,
        correlation_id: str | None = None,
        *,
        caller_peer_id: str | None = None,
        principal_id: str | None = None,
    ) -> None:
        """Publish a TTS stream error event using existing TTS error topic."""
        async with self._stream_state_lock:
            state = self._stream_states.get(stream_id)
            if state is not None:
                caller_peer_id = caller_peer_id or state.caller_peer_id
                principal_id = principal_id or state.principal_id
                correlation_id = correlation_id or state.correlation_id
        await self.bus.publish(
            TTSMethods.ERROR,
            TTSErrorEvent(request_id=stream_id, error=error),
            event=True,
            mesh=False,
            origin="internal",
            caller_peer_id=caller_peer_id,
            principal_id=principal_id,
            correlation_id=correlation_id,
        )
