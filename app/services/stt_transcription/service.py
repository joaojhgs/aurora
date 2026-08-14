"""Transcription Service for Aurora.

This service transcribes audio streams into text using Faster Whisper models.

Features:
- Subscribes to audio stream channels
- Processes audio chunks for transcription
- Supports realtime and accurate models
- VAD-based speech segmentation
- Emits TranscriptionResult events
- Independent from wake word detection
"""

from __future__ import annotations

import asyncio
import base64
import io
import os
import threading
import time
import wave
from collections import deque
from datetime import datetime
from enum import Enum
from typing import Any

import numpy as np

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.helpers.getUseHardwareAcceleration import get_use_hardware_acceleration
from app.messaging import (
    AudioChunk,
    AudioEncoding,
    AudioFormat,
    AudioTopics,
    Envelope,
    MessageBus,
    TranscriptionControl,
    TranscriptionError,
    TranscriptionResult,
    TranscriptionType,
)
from app.shared.config.interface import ConfigAPI
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import AccurateModel, RealtimeModel, Stt, System, Transcription
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.stt import (
    AudioSessionEvent,
    AudioSessionMethods,
    AudioSessionSampleLimits,
    AudioSessionStartRequest,
    STTAudioChunk,
    STTControl,
    TranscribeAudioRequest,
    TranscribeAudioResponse,
    TranscriptionMethods,
    TranscriptionModule,
)
from app.shared.contracts.registry import method_contract
from app.shared.path_utils import ensure_path_writable_or_tmp
from app.shared.services.base_service import BaseService
from app.shared.speech_language_policy import (
    SpeechLanguagePolicy,
    resolve_speech_language_policy,
)

config_api = ConfigAPI()


def _create_vad(mode: int) -> Any:
    """Create the optional WebRTC VAD runtime when transcription starts."""
    import webrtcvad

    return webrtcvad.Vad(mode)


def _create_whisper_model(*args: Any, **kwargs: Any) -> Any:
    """Create the optional Faster Whisper runtime when model loading starts."""
    from faster_whisper import WhisperModel

    return WhisperModel(*args, **kwargs)


class VADMode(Enum):
    """Voice Activity Detection aggressiveness modes."""

    QUALITY = 0  # Least aggressive (best quality, may include more silence)
    LOW = 1  # Low aggressiveness
    MEDIUM = 2  # Medium aggressiveness
    AGGRESSIVE = 3  # Most aggressive (best latency, may cut off speech)


class TranscriptionService(BaseService):
    """Transcription service for speech-to-text.

    Responsibilities:
    - Subscribe to audio stream topics
    - Buffer and process audio chunks
    - Detect speech using VAD
    - Transcribe speech segments using Faster Whisper
    - Support both realtime (fast) and accurate (slow) models
    - Emit TranscriptionResult events
    """

    def __init__(self) -> None:
        """Initialize transcription service."""
        super().__init__(
            module=TranscriptionModule.NAME,
            summary="Speech transcription service using Faster Whisper",
            capabilities=["audio_transcription", "vad", "whisper"],
        )
        self._running = False
        self._transcribing = False
        self._paused = False

        # Models
        self._realtime_model: Any | None = None
        self._accurate_model: Any | None = None
        self._model_lock = threading.Lock()
        self._model_cache_dir = ""
        self._model_status: dict[str, str] = {
            "realtime": "unavailable",
            "accurate": "unavailable",
        }
        self._model_status_message: dict[str, str] = {
            "realtime": "not_loaded",
            "accurate": "not_loaded",
        }

        # Audio buffering
        self._audio_buffer: deque[tuple[bytes, str, str]] = deque(
            maxlen=1000
        )  # ~10 seconds at 16kHz
        self._audio_format: AudioFormat | None = None
        self._buffer_lock = threading.Lock()

        # Track current audio source and stream
        self._current_source: str = "microphone"  # Default to microphone
        self._current_stream_id: str = "default"  # Default stream ID

        # VAD for speech detection
        self._vad: Any | None = None
        self._vad_mode = VADMode.MEDIUM
        # Active utterance audio must not be capped to a short rolling window.
        # The coordinator bounds listening with session_timeout_s, so this
        # remains memory-safe while preserving long-form requests for the
        # accurate final transcription.
        self._speech_segments: deque[bytes] = deque()
        self._in_speech = False
        self._silence_chunks = 0
        self._min_silence_chunks = 10  # ~200ms of silence to end segment
        self._last_realtime_partial_at = 0.0
        self._last_realtime_partial_text = ""
        self._partial_interval_seconds = 1.0
        self._partial_min_audio_length_ms = 700

        # Configuration (will be loaded in on_start)
        self._language = ""
        self._language_policy = resolve_speech_language_policy("en", "auto")
        self._realtime_enabled = True
        self._accurate_enabled = True
        self._min_audio_length_ms = 500  # Minimum audio length to transcribe
        self._default_sample_rate = 16000
        self._default_channels = 1

        # Processing thread
        self._process_thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

        # Statistics
        self._chunks_received = 0
        self._transcriptions_done = 0

    async def on_start(self) -> None:
        """Start the transcription service."""
        if self._running:
            log_warning("Transcription service already running")
            return

        await self._load_config()

        log_info("Starting transcription service...")
        self._running = True

        # Bind-mounted ./data is often root-owned; HF/xet need a writable cache.
        self._ensure_huggingface_cache_env()

        # Store event loop for callbacks
        self._loop = asyncio.get_event_loop()

        # Initialize VAD
        self._initialize_vad()

        # Load models. Missing optional model packages, offline first-run
        # downloads, or unavailable devices must not kill the service process.
        await self._load_models()

        # Subscribe to audio stream
        await self.bus.subscribe_event(AudioTopics.STREAM_MICROPHONE, self._on_audio_chunk)

        # Start processing thread
        self._start_processing_thread()

        self._set_started(True)
        log_info("Transcription service started")

    async def on_stop(self) -> None:
        """Stop the transcription service."""
        if not self._running:
            return

        log_info("Stopping transcription service...")
        self._running = False
        self._transcribing = False
        self.bus.unsubscribe(AudioTopics.STREAM_MICROPHONE, self._on_audio_chunk)

        # Wait for processing thread to finish
        if self._process_thread and self._process_thread.is_alive():
            self._process_thread.join(timeout=5.0)

        # Clean up models
        if self._realtime_model:
            del self._realtime_model
            self._realtime_model = None
        if self._accurate_model:
            del self._accurate_model
            self._accurate_model = None

        self._set_started(False)
        log_info("Transcription service stopped")

    def _ensure_huggingface_cache_env(self) -> None:
        """Point HF hub/xet at a writable tree (bind-mounted ./data is often root-owned)."""
        hf_home = os.environ.get("HF_HOME") or self._default_app_data_cache_dir("huggingface")
        writable = ensure_path_writable_or_tmp(hf_home, tmp_leaf="huggingface")
        os.environ["HF_HOME"] = writable
        hub = os.path.join(writable, "hub")
        os.makedirs(hub, exist_ok=True)
        os.environ["HF_HUB_CACHE"] = hub
        os.environ["HUGGINGFACE_HUB_CACHE"] = hub
        if os.path.normpath(writable) != os.path.normpath(hf_home):
            log_warning(
                "HF cache not writable at %r; using %r for HF_HOME / hub cache",
                hf_home,
                writable,
            )

    def _default_app_data_cache_dir(self, *parts: str) -> str:
        """Return a durable app-data cache path for model downloads."""
        from app.shared.path_utils import get_data_dir

        return str(get_data_dir().joinpath("models", *parts))

    def _inference_ready(self) -> bool:
        """Return true when at least one enabled transcription model is callable."""
        realtime_ready = self._realtime_enabled and self._realtime_model is not None
        accurate_ready = self._accurate_enabled and self._accurate_model is not None
        return realtime_ready or accurate_ready

    def _refresh_callable_capabilities(self) -> None:
        """Advertise model-dependent transcription only when inference is ready."""
        capabilities = ["vad"]
        if self._inference_ready():
            capabilities.extend(["audio_transcription", "whisper"])
        self._capabilities = capabilities

    async def _republish_readiness(self) -> None:
        """Refresh gateway discovery after inference readiness changes."""
        self._refresh_callable_capabilities()
        if getattr(self, "_runtime_state", None) == "active":
            await self._publish_service_announcement()

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading TranscriptionService configuration: section={config_section}")
        # Reload transcription models if config changed
        if config_section is None or config_section in ("system", "services", "services.stt"):
            log_info("Reloading transcription models due to config change...")
            (
                language,
                policy,
                transcription_cfg,
                realtime_enabled,
                accurate_enabled,
            ) = await self._read_runtime_config()
            new_realtime, new_accurate = await self._create_models(
                transcription_cfg,
                realtime_enabled=realtime_enabled,
                accurate_enabled=accurate_enabled,
            )
            old_realtime, old_accurate = self._realtime_model, self._accurate_model
            self._language = language
            self._language_policy = policy
            self._realtime_enabled = realtime_enabled
            self._accurate_enabled = accurate_enabled
            self._realtime_model = new_realtime
            self._accurate_model = new_accurate
            if old_realtime and old_realtime is not new_realtime:
                del old_realtime
            if old_accurate and old_accurate is not new_accurate:
                del old_accurate
            await self._republish_readiness()
        log_info("TranscriptionService configuration reloaded")

    async def _load_config(self) -> None:
        """Load canonical speech and STT configuration."""

        language, policy, _, realtime_enabled, accurate_enabled = await self._read_runtime_config()
        self._language = language
        self._language_policy = policy
        self._realtime_enabled = realtime_enabled
        self._accurate_enabled = accurate_enabled

    async def _read_runtime_config(
        self,
    ) -> tuple[str, SpeechLanguagePolicy, Any, bool, bool]:
        """Read runtime config without mutating live models."""

        stt_raw = await config_api.aget(ConfigKeys.services.stt, default={})
        if isinstance(stt_raw, Stt):
            stt_cfg = stt_raw
        else:
            try:
                stt_cfg = Stt.model_validate(stt_raw or {})
            except Exception:
                stt_cfg = Stt()
        system_cfg = await config_api.aget(ConfigKeys.system, System)
        if not isinstance(system_cfg, System):
            system_cfg = System()
        policy = resolve_speech_language_policy(
            system_cfg.primary_language,
            system_cfg.voice_language,
        )
        transcription_cfg = (
            stt_raw.get("transcription")
            if isinstance(stt_raw, dict) and isinstance(stt_raw.get("transcription"), dict)
            else stt_cfg.transcription or Transcription()
        )

        realtime_model = self._cfg_value(transcription_cfg, "realtime_model")
        realtime_enabled = (
            self._cfg_value(realtime_model, "enabled")
            if realtime_model is not None and self._cfg_value(realtime_model, "enabled") is not None
            else True
        )

        accurate_model = self._cfg_value(transcription_cfg, "accurate_model")
        accurate_enabled = (
            self._cfg_value(accurate_model, "enabled")
            if accurate_model is not None and self._cfg_value(accurate_model, "enabled") is not None
            else True
        )
        return (
            policy.stt_language or "",
            policy,
            transcription_cfg,
            realtime_enabled,
            accurate_enabled,
        )

    def _initialize_vad(self) -> None:
        """Initialize Voice Activity Detection."""
        try:
            self._vad = _create_vad(self._vad_mode.value)
            log_info(f"VAD initialized (mode: {self._vad_mode.name})")
        except Exception as e:
            log_error(f"Failed to initialize VAD: {e}")
            self._vad = None

    async def _load_models(self) -> None:
        """Load Faster Whisper models."""
        log_info("Loading transcription models...")

        _, _, transcription_cfg, _, _ = await self._read_runtime_config()
        new_realtime, new_accurate = await self._create_models(
            transcription_cfg or Transcription(),
            realtime_enabled=self._realtime_enabled,
            accurate_enabled=self._accurate_enabled,
        )
        self._realtime_model = new_realtime
        self._accurate_model = new_accurate
        self._refresh_callable_capabilities()

    def _set_model_status(self, model_role: str, status: str, message: str) -> None:
        """Record model readiness without exposing local paths in status messages."""
        self._model_status[model_role] = status
        self._model_status_message[model_role] = self._redact_status_message(message)

    def _redact_status_message(self, message: str) -> str:
        """Keep readiness messages bounded and free of selected model IDs/paths."""
        allowed = {
            "disabled",
            "model_ready",
            "not_loaded",
            "not_selected",
            "preparing_model",
            "previous_model_retained",
        }
        if message in allowed:
            return message
        if message.endswith("Error") or message.endswith("Exception"):
            return message
        return "model_unavailable"

    def _safe_exception_type(self, exc: BaseException) -> str:
        """Return exception class only; exception text may contain paths/model IDs."""
        return type(exc).__name__

    def _model_ready(self, model_role: str) -> bool:
        """Return whether a realtime or accurate model is loaded and ready."""
        return self._model_status.get(model_role) == "ready"

    async def _create_models(
        self,
        transcription_cfg: Any,
        *,
        realtime_enabled: bool,
        accurate_enabled: bool,
    ) -> tuple[Any | None, Any | None]:
        """Create Faster Whisper models without mutating live service state."""

        raw_realtime = self._cfg_value(transcription_cfg, "realtime_model")
        realtime_model_cfg = raw_realtime or RealtimeModel()
        accurate_model_cfg = self._cfg_value(transcription_cfg, "accurate_model") or AccurateModel()

        accurate_model_size = self._model_size_or_path(accurate_model_cfg)
        realtime_model_size = self._model_size_or_path(realtime_model_cfg)
        realtime_device = self._cfg_value(realtime_model_cfg, "device")
        accurate_device = self._cfg_value(accurate_model_cfg, "device")
        accurate_compute_type = self._cfg_value(accurate_model_cfg, "compute_type") or "int8"
        realtime_compute_type = self._cfg_value(realtime_model_cfg, "compute_type") or "int8"

        # Fallback to legacy hardware_acceleration when realtime_model block exists (matches dict truthiness)
        if raw_realtime is not None:
            legacy_device = get_use_hardware_acceleration("stt")
            realtime_device = realtime_device or legacy_device
            accurate_device = accurate_device or legacy_device
        # Never use cwd-relative paths: Tilt sets working_dir to /app/host (often not writable).
        from app.shared.path_utils import ensure_path_writable_or_tmp

        _hf = os.environ.get("HF_HOME") or self._default_app_data_cache_dir("huggingface")
        _preferred = os.environ.get("AURORA_STT_WHISPER_DOWNLOAD_ROOT") or os.path.join(
            _hf, "whisper"
        )
        download_root = ensure_path_writable_or_tmp(_preferred, tmp_leaf="faster-whisper")
        self._model_cache_dir = download_root

        realtime_model = self._load_one_model(
            role="realtime",
            enabled=realtime_enabled,
            model_size=realtime_model_size,
            device=realtime_device,
            compute_type=realtime_compute_type,
            download_root=download_root,
        )
        accurate_model = self._load_one_model(
            role="accurate",
            enabled=accurate_enabled,
            model_size=accurate_model_size,
            device=accurate_device,
            compute_type=accurate_compute_type,
            download_root=download_root,
        )
        return realtime_model, accurate_model

    def _cfg_value(self, cfg: Any, key: str) -> Any:
        """Read generated Pydantic configs or raw dict-like test/config values."""
        if isinstance(cfg, dict):
            return cfg.get(key)
        return getattr(cfg, key, None)

    def _model_size_or_path(self, cfg: Any) -> str | None:
        """Accept Faster Whisper presets, Hugging Face IDs, and local paths."""
        selected = self._cfg_value(cfg, "model_size_or_path") or self._cfg_value(cfg, "model_size")
        if not isinstance(selected, str) or not selected.strip():
            return None
        return selected.strip()

    def _load_one_model(
        self,
        *,
        role: str,
        enabled: bool,
        model_size: str | None,
        device: str | None,
        compute_type: str,
        download_root: str,
    ) -> Any | None:
        """Load one Faster Whisper model, downloading to cache when needed."""
        if not enabled:
            self._set_model_status(role, "unavailable", "disabled")
            return None
        if model_size is None:
            self._set_model_status(role, "unavailable", "not_selected")
            return None
        try:
            self._set_model_status(role, "downloading", "preparing_model")
            log_info("Loading %s transcription model on %s", role, device)
            model = _create_whisper_model(
                model_size,
                device=device,
                compute_type=compute_type,
                download_root=download_root,
            )
            self._set_model_status(role, "ready", "model_ready")
            log_info("%s transcription model ready", role.capitalize())
            return model
        except Exception as e:
            self._set_model_status(role, "unavailable", self._safe_exception_type(e))
            self._refresh_callable_capabilities()
            log_warning(
                "%s transcription model unavailable; service remains active: %s",
                role.capitalize(),
                self._safe_exception_type(e),
            )
            return None

    def _start_processing_thread(self) -> None:
        """Start the audio processing thread."""
        self._transcribing = True
        self._process_thread = threading.Thread(
            target=self._processing_loop, daemon=True, name="Transcription-Processor"
        )
        self._process_thread.start()
        log_info("Processing thread started")

    def _processing_loop(self) -> None:
        """Main processing loop (runs in thread)."""
        log_info("Processing loop started")

        while self._transcribing:
            try:
                # Process buffered audio
                self._process_audio_buffer()

                # Sleep briefly to avoid busy waiting
                time.sleep(0.02)  # 20ms

            except Exception as e:
                if self._transcribing:
                    log_error(f"Error in processing loop: {e}", exc_info=True)

        log_info("Processing loop ended")

    def _process_audio_buffer(self) -> None:
        """Process buffered audio for speech detection and transcription."""
        if self._paused or not self._audio_buffer:
            return

        with self._buffer_lock:
            if len(self._audio_buffer) == 0:
                return

            # Get next chunk
            item = self._audio_buffer.popleft()

            # Handle tuple (data, stream_id, source)
            if isinstance(item, tuple):
                audio_data, stream_id, source = item
            else:
                # Fallback for legacy bytes (should not happen with new code)
                audio_data = item
                stream_id = self._current_stream_id
                source = self._current_source

        self._process_audio_item(audio_data, stream_id, source)

    def _process_audio_item(self, audio_data: bytes, stream_id: str, source: str) -> None:
        """Process one audio item for VAD segmentation."""
        # Check for stream switch
        if stream_id != self._current_stream_id:
            # If we have pending speech, transcribe it now (flush)
            if self._speech_segments:
                log_debug(
                    f"Stream switch ({self._current_stream_id} -> {stream_id}): flushing segment"
                )
                self._transcribe_segment()
                self._reset_speech_state()

            # Update context
            self._current_stream_id = stream_id
            self._current_source = source
            log_debug(f"Switched to stream: {stream_id} ({source})")

        # Run VAD on chunk
        is_speech = self._detect_speech(audio_data)

        if is_speech:
            # Add to speech segment
            self._speech_segments.append(audio_data)
            self._in_speech = True
            self._silence_chunks = 0
            self._emit_realtime_partial_if_due()
        else:
            if self._in_speech:
                # We're in speech but this chunk is silence
                self._silence_chunks += 1
                self._speech_segments.append(audio_data)  # Include trailing silence

                # Check if we've accumulated enough silence to end segment
                if self._silence_chunks >= self._min_silence_chunks:
                    # End of speech segment
                    self._transcribe_segment()
                    self._reset_speech_state()

    def _flush_pending_audio(self) -> None:
        """Drain queued audio and force transcription of the current speech segment."""
        with self._buffer_lock:
            pending_items = list(self._audio_buffer)
            self._audio_buffer.clear()

        fallback_audio: list[bytes] = []
        fallback_peak = 0.0
        for item in pending_items:
            if isinstance(item, tuple):
                audio_data, stream_id, source = item
            else:
                audio_data = item
                stream_id = self._current_stream_id
                source = self._current_source
            fallback_audio.append(audio_data)
            fallback_peak = max(fallback_peak, self._audio_peak_percent(audio_data))
            self._process_audio_item(audio_data, stream_id, source)

        if self._speech_segments:
            log_info("Flushing pending speech segment for manual stop")
            self._transcribe_segment()
            self._reset_speech_state()
        elif fallback_audio and fallback_peak >= 1.0:
            segment_data = b"".join(fallback_audio)
            duration_ms = len(segment_data) / 32
            if duration_ms >= self._min_audio_length_ms:
                log_info(
                    "Flushing buffered audio for manual stop "
                    f"({duration_ms:.0f}ms, peak={fallback_peak:.1f}%)"
                )
                self._speech_segments.append(segment_data)
                self._transcribe_segment()
                self._reset_speech_state()

    def _audio_peak_percent(self, audio_data: bytes) -> float:
        sample_count = len(audio_data) // 2
        if sample_count <= 0:
            return 0.0
        samples = memoryview(audio_data[: sample_count * 2]).cast("h")
        if len(samples) == 0:
            return 0.0
        peak = max(abs(int(sample)) for sample in samples)
        return min(100.0, (peak / 32768.0) * 100.0)

    def _detect_speech(self, audio_data: bytes) -> bool:
        """Detect if audio chunk contains speech using VAD.

        Args:
            audio_data: Raw audio data (PCM 16-bit)

        Returns:
            True if speech detected, False otherwise
        """
        if not self._vad or not self._audio_format:
            return True  # Assume speech if VAD not available

        try:
            # VAD expects specific frame sizes
            # For 16kHz: 160, 320, or 480 samples (10ms, 20ms, 30ms)
            frame_size = 320  # 20ms at 16kHz

            if len(audio_data) < frame_size * 2:  # *2 for 16-bit samples
                return False

            # Take first frame
            frame = audio_data[: frame_size * 2]

            # Run VAD
            is_speech = self._vad.is_speech(frame, self._audio_format.sample_rate)
            return is_speech

        except Exception as e:
            log_debug(f"VAD error: {e}")
            return True  # Assume speech on error

    def _emit_realtime_partial_if_due(self) -> None:
        """Emit fast interim transcription while speech is still in progress.

        The accurate model still owns the final message after VAD/silence. This
        gives the UI live textbox updates without waiting for end-of-speech.
        """
        if not self._realtime_enabled or not self._realtime_model or not self._speech_segments:
            return
        now = time.time()
        if now - self._last_realtime_partial_at < self._partial_interval_seconds:
            return
        segment_data = b"".join(self._speech_segments)
        duration_ms = len(segment_data) / 32
        if duration_ms < self._partial_min_audio_length_ms:
            return
        self._last_realtime_partial_at = now
        audio_np = self._bytes_to_numpy(segment_data)
        self._transcribe_with_model(
            audio_np, self._realtime_model, TranscriptionType.REALTIME, duration_ms
        )

    def _transcribe_segment(self) -> None:
        """Transcribe accumulated speech segment."""
        if not self._speech_segments:
            return

        # Combine segment chunks
        segment_data = b"".join(self._speech_segments)

        # Check minimum length
        duration_ms = len(segment_data) / 32  # 16kHz, 16-bit = 32 bytes/ms
        if duration_ms < self._min_audio_length_ms:
            log_debug(f"Segment too short ({duration_ms:.0f}ms), skipping")
            return

        log_debug(f"Transcribing segment ({duration_ms:.0f}ms, {len(segment_data)} bytes)")

        # Convert to float32 numpy array
        audio_np = self._bytes_to_numpy(segment_data)

        # Transcribe with realtime model (fast)
        if self._realtime_enabled and self._realtime_model:
            self._transcribe_with_model(
                audio_np, self._realtime_model, TranscriptionType.REALTIME, duration_ms
            )

        # Transcribe with accurate model (slow)
        if self._accurate_enabled and self._accurate_model:
            self._transcribe_with_model(
                audio_np, self._accurate_model, TranscriptionType.ACCURATE, duration_ms
            )

    def _bytes_to_numpy(self, audio_data: bytes) -> np.ndarray:
        """Convert PCM bytes to float32 numpy array.

        Args:
            audio_data: Raw PCM audio data (16-bit signed little-endian)

        Returns:
            Float32 numpy array normalized to [-1.0, 1.0]
        """
        # Convert bytes to int16 array
        audio_int16 = np.frombuffer(audio_data, dtype=np.int16)

        # Convert to float32 and normalize
        audio_float32 = audio_int16.astype(np.float32) / 32768.0

        return audio_float32

    def _transcribe_with_model(
        self,
        audio: np.ndarray,
        model: Any,
        transcription_type: TranscriptionType,
        duration_ms: float,
    ) -> None:
        """Transcribe audio with specified model.

        Args:
            audio: Audio data as float32 numpy array
            model: Whisper model to use
            transcription_type: Type of transcription (realtime or accurate)
            duration_ms: Duration of audio segment
        """
        try:
            start_time = time.time()

            # Transcribe
            segments, info = model.transcribe(
                audio,
                language=self._language if self._language else None,
                beam_size=1 if transcription_type == TranscriptionType.REALTIME else 5,
                vad_filter=False,  # We already did VAD
            )

            # Combine segments into full text
            text_parts = []
            for segment in segments:
                text_parts.append(segment.text.strip())

            text = " ".join(text_parts).strip()

            if not text:
                log_debug(f"Empty transcription from {transcription_type.value} model")
                return

            elapsed_ms = (time.time() - start_time) * 1000
            log_info(
                f"{transcription_type.value.capitalize()} transcription: '{text}' ({elapsed_ms:.0f}ms)"
            )

            # Emit result
            self._emit_result(
                text=text,
                transcription_type=transcription_type,
                confidence=None,  # Faster Whisper doesn't provide per-segment confidence
                language=info.language if hasattr(info, "language") else None,
                duration_ms=duration_ms,
                model=f"faster-whisper-{model.model.model_type if hasattr(model.model, 'model_type') else 'unknown'}",
            )

            self._transcriptions_done += 1

        except Exception as e:
            log_error(
                "Transcription error (%s): %s",
                transcription_type.value,
                self._safe_exception_type(e),
                exc_info=True,
            )
            self._emit_error(
                error_message="Transcription failed",
                error_type="transcription_failed",
            )

    def _emit_result(
        self,
        text: str,
        transcription_type: TranscriptionType,
        confidence: float | None,
        language: str | None,
        duration_ms: float,
        model: str,
    ) -> None:
        """Emit transcription result event.

        Args:
            text: Transcribed text
            transcription_type: Type of transcription
            confidence: Confidence score
            language: Detected language
            duration_ms: Audio duration
            model: Model used
        """
        if not self._loop or not self._loop.is_running():
            log_error("Event loop not available for emitting result")
            return

        result = TranscriptionResult(
            text=text,
            transcription_type=transcription_type,
            confidence=confidence,
            language=language,
            source=self._current_source,
            stream_id=self._current_stream_id,
            duration_ms=duration_ms,
            timestamp=datetime.now(),
            model=model,
        )

        # Emit to general result topic
        asyncio.run_coroutine_threadsafe(
            self.bus.publish(
                TranscriptionMethods.RESULT,
                result,
                event=True,
                origin="internal",
            ),
            self._loop,
        )

    def _emit_error(self, error_message: str, error_type: str) -> None:
        """Emit transcription error event.

        Args:
            error_message: Error description
            error_type: Type of error
        """
        if not self._loop or not self._loop.is_running():
            return

        error = TranscriptionError(
            error_message=error_message,
            error_type=error_type,
            source=self._current_source,
            stream_id=self._current_stream_id,
            timestamp=datetime.now(),
        )

        asyncio.run_coroutine_threadsafe(
            self.bus.publish(
                TranscriptionMethods.ERROR,
                error,
                event=True,
                origin="internal",
            ),
            self._loop,
        )

    def _reset_speech_state(self) -> None:
        """Reset speech detection state after transcribing segment."""
        self._speech_segments.clear()
        self._in_speech = False
        self._silence_chunks = 0

    async def _process_audio_data(
        self,
        data: bytes,
        audio_format: AudioFormat | None = None,
        stream_id: str = "default",
        source: str = "unknown",
    ) -> None:
        """Process raw audio data for transcription.

        Args:
            data: Raw audio bytes
            audio_format: Optional audio format info (only needed for first chunk)
            stream_id: ID of the audio stream
            source: Source of the audio
        """
        if self._paused:
            return

        # Track current stream info
        self._current_stream_id = stream_id
        self._current_source = source

        # Store audio format if provided and not yet set. The coordinator only
        # used to send format on process-start chunk zero, which meant a paused
        # transcription service could miss it and then treat all later chunks as
        # speech forever. Infer the standard coordinator format when missing so
        # VAD can end the utterance and final transcription can run.
        if self._audio_format is None:
            self._audio_format = audio_format or AudioFormat(
                sample_rate=self._default_sample_rate,
                channels=self._default_channels,
                encoding=AudioEncoding.PCM_S16LE,
                bits_per_sample=16,
            )
            log_info(
                f"Audio format set: {self._audio_format.sample_rate}Hz, {self._audio_format.channels}ch, {self._audio_format.bits_per_sample}bits"
            )

        # Add to buffer with metadata
        with self._buffer_lock:
            self._audio_buffer.append((data, stream_id, source))

        # Update stats
        self._chunks_received += 1

    async def _on_audio_chunk(self, envelope: Envelope) -> None:
        """Handle incoming audio chunks from internal bus.

        Args:
            envelope: Message envelope containing AudioChunk
        """
        chunk: AudioChunk = envelope.payload
        await self._process_audio_data(
            chunk.data, chunk.format, stream_id=chunk.stream_id, source=chunk.source
        )

    @method_contract(
        method_id=TranscriptionMethods.PROCESS_AUDIO,
        summary="Process audio chunk for transcription",
        input_model=STTAudioChunk,
        output_model=EmptyOutput,
        exposure="both",
        method_type="use",
        required_perms=[TranscriptionMethods.PROCESS_AUDIO],
        callable_feature_ids=["audio_transcription"],
    )
    async def _on_external_audio(self, chunk: STTAudioChunk) -> EmptyOutput:
        """Handle audio chunks from external API/WebRTC calls.

        Args:
            chunk: STTAudioChunk containing audio data

        Returns:
            EmptyOutput on success
        """
        await self._validate_streaming_audio_session(chunk)
        if not self._inference_ready():
            raise RuntimeError("Transcription model unavailable")

        # Convert STT format to internal AudioFormat
        # Derive bits_per_sample and encoding from format string
        format_lower = chunk.format.lower()
        if "16" in format_lower or format_lower == "pcm_s16le":
            bits_per_sample = 16
            encoding = AudioEncoding.PCM_S16LE
        elif "24" in format_lower or format_lower == "pcm_s24le":
            bits_per_sample = 24
            encoding = AudioEncoding.PCM_S24LE
        elif "32" in format_lower or format_lower == "pcm_s32le":
            bits_per_sample = 32
            encoding = AudioEncoding.PCM_S32LE
        elif format_lower == "pcm_f32le":
            bits_per_sample = 32
            encoding = AudioEncoding.PCM_F32LE
        else:
            # Default to 16-bit PCM
            bits_per_sample = 16
            encoding = AudioEncoding.PCM_S16LE

        audio_format = AudioFormat(
            sample_rate=chunk.sample_rate,
            channels=chunk.channels,
            encoding=encoding,
            bits_per_sample=bits_per_sample,
        )

        await self._process_audio_data(
            chunk.data, audio_format, stream_id="external", source="external"
        )
        await self._publish_audio_session_event(
            chunk,
            "transcription_audio_accepted",
            status="active",
            payload={"bytes": len(chunk.data), "sample_rate": chunk.sample_rate},
        )

        return EmptyOutput()

    async def _validate_streaming_audio_session(self, chunk: STTAudioChunk) -> None:
        """Require selector and Gateway-issued consent for streaming audio."""
        if not chunk.mesh_selector or not chunk.mesh_selector.has_routing_target():
            await self._publish_audio_session_event(
                chunk,
                "stream_denied",
                status="denied",
                payload={"reason": "selector_required"},
            )
            raise PermissionError("Transcription.ProcessAudio requires an explicit mesh selector")
        if not chunk.session_id or not chunk.consent_token:
            await self._publish_audio_session_event(
                chunk,
                "stream_denied",
                status="denied",
                payload={"reason": "consent_token_required"},
            )
            raise PermissionError(
                "Transcription.ProcessAudio requires an audio session consent token"
            )

        self._validate_streaming_audio_sample(chunk)
        result = await self.bus.request(
            AudioSessionMethods.START,
            AudioSessionStartRequest(
                session_id=chunk.session_id,
                consent_token=chunk.consent_token,
            ),
            timeout=5.0,
        )
        if not result.ok:
            await self._publish_audio_session_event(
                chunk,
                "stream_denied",
                status="denied",
                payload={"reason": result.error or "audio_session_denied"},
            )
            raise PermissionError(result.error or "audio session consent denied")

    def _validate_streaming_audio_sample(self, chunk: STTAudioChunk) -> None:
        limits = AudioSessionSampleLimits()
        if chunk.sample_rate < limits.min_sample_rate or chunk.sample_rate > limits.max_sample_rate:
            raise ValueError("audio sample_rate is outside session limits")
        if chunk.channels < 1 or chunk.channels > limits.max_channels:
            raise ValueError("audio channels are outside session limits")
        if chunk.format.lower() not in limits.allowed_formats:
            raise ValueError("audio format is outside session limits")
        if len(chunk.data) > limits.max_chunk_bytes:
            raise ValueError("audio chunk exceeds session limits")

    async def _publish_audio_session_event(
        self,
        chunk: STTAudioChunk,
        event_type: str,
        *,
        status: str,
        payload: dict[str, object],
    ) -> None:
        if not chunk.session_id:
            return
        await self.bus.publish(
            AudioSessionMethods.EVENTS,
            AudioSessionEvent(
                session_id=chunk.session_id,
                event_type=event_type,
                status=status,
                source_peer_id=chunk.caller_peer_id,
                target_peer_id=chunk.target_peer_id
                or (chunk.mesh_selector.peer_id if chunk.mesh_selector else None),
                privacy_class=chunk.privacy_class,
                redacted=True,
                correlation_id=chunk.correlation_id,
                payload=payload,
            ),
            event=True,
            mesh=False,
            origin="internal",
        )

    @method_contract(
        method_id=TranscriptionMethods.CONTROL,
        summary="Handle transcription control commands",
        input_model=STTControl,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="manage",
    )
    async def _on_control(self, data: STTControl) -> EmptyOutput:
        """Handle control commands.

        Args:
            data: Validated STTControl payload
        """
        action = data.action

        log_info(f"Transcription control: {action}")

        if action == "pause":
            self._paused = True
        elif action == "flush":
            await asyncio.to_thread(self._flush_pending_audio)
        elif action == "resume":
            self._paused = False
            # Clear audio buffers when resuming to avoid processing stale audio
            with self._buffer_lock:
                self._audio_buffer.clear()
                self._speech_segments.clear()
            self._in_speech = False
            self._silence_chunks = 0
            self._last_realtime_partial_at = 0.0
            self._last_realtime_partial_text = ""
            log_info("Cleared audio buffers on resume")
        elif action == "set_language":
            if data.language:
                self._language = data.language
                log_info(f"Language set to: {self._language}")
        elif action == "enable_realtime" and data.enabled is not None:
            self._realtime_enabled = data.enabled
            await self._republish_readiness()
            log_info(f"Realtime transcription: {'enabled' if data.enabled else 'disabled'}")
        elif action == "enable_accurate" and data.enabled is not None:
            self._accurate_enabled = data.enabled
            await self._republish_readiness()
            log_info(f"Accurate transcription: {'enabled' if data.enabled else 'disabled'}")

        return EmptyOutput()

    def _decode_audio_to_numpy(
        self,
        audio_data: bytes,
        format: str,
        sample_rate: int,
        channels: int,
    ) -> np.ndarray:
        """Decode audio bytes to numpy array.

        Args:
            audio_data: Raw or encoded audio bytes
            format: Audio format ("raw", "wav", or "mp3")
            sample_rate: Expected sample rate
            channels: Expected number of channels

        Returns:
            Float32 numpy array normalized to [-1.0, 1.0]
        """
        if format == "wav":
            # Parse WAV container
            wav_buffer = io.BytesIO(audio_data)
            with wave.open(wav_buffer, "rb") as wf:
                # Verify format
                if wf.getsampwidth() != 2:
                    raise ValueError(f"Expected 16-bit audio, got {wf.getsampwidth() * 8}-bit")
                # Read PCM data
                pcm_data = wf.readframes(wf.getnframes())
                actual_rate = wf.getframerate()
                actual_channels = wf.getnchannels()

                # Convert to numpy
                audio_int16 = np.frombuffer(pcm_data, dtype=np.int16)

                # Convert stereo to mono if needed
                if actual_channels == 2:
                    audio_int16 = audio_int16.reshape(-1, 2).mean(axis=1).astype(np.int16)

                # Resample if needed (simple linear interpolation)
                if actual_rate != sample_rate:
                    # Calculate new length
                    new_length = int(len(audio_int16) * sample_rate / actual_rate)
                    indices = np.linspace(0, len(audio_int16) - 1, new_length)
                    audio_int16 = np.interp(
                        indices, np.arange(len(audio_int16)), audio_int16
                    ).astype(np.int16)

                audio_float32 = audio_int16.astype(np.float32) / 32768.0
                return audio_float32

        elif format == "raw":
            # Assume PCM 16-bit signed little-endian
            audio_int16 = np.frombuffer(audio_data, dtype=np.int16)

            # Convert stereo to mono if needed
            if channels == 2:
                audio_int16 = audio_int16.reshape(-1, 2).mean(axis=1).astype(np.int16)

            audio_float32 = audio_int16.astype(np.float32) / 32768.0
            return audio_float32

        elif format == "mp3":
            # Decode MP3 using pydub (requires ffmpeg)
            try:
                from pydub import AudioSegment
            except ImportError:
                raise ImportError(
                    "pydub is required for MP3 support. Install with: pip install pydub"
                ) from None

            # Load MP3 from bytes
            audio_segment = AudioSegment.from_mp3(io.BytesIO(audio_data))

            # Convert to mono if stereo (transcription typically works better with mono)
            if audio_segment.channels == 2:
                audio_segment = audio_segment.set_channels(1)

            # Resample to target sample rate if needed
            if audio_segment.frame_rate != sample_rate:
                audio_segment = audio_segment.set_frame_rate(sample_rate)

            # Convert to raw PCM 16-bit
            raw_audio = audio_segment.raw_data

            # Convert to numpy array
            audio_int16 = np.frombuffer(raw_audio, dtype=np.int16)

            # Convert to float32 normalized to [-1.0, 1.0]
            audio_float32 = audio_int16.astype(np.float32) / 32768.0
            return audio_float32

        else:
            raise ValueError(f"Unsupported audio format: {format}")

    @method_contract(
        method_id=TranscriptionMethods.TRANSCRIBE,
        summary="Transcribe complete audio file and return result",
        input_model=TranscribeAudioRequest,
        output_model=TranscribeAudioResponse,
        exposure="both",
        method_type="use",
        required_perms=[TranscriptionMethods.TRANSCRIBE],
        callable_feature_ids=["audio_transcription"],
    )
    async def transcribe_audio(self, request: TranscribeAudioRequest) -> TranscribeAudioResponse:
        """Transcribe complete audio and return result immediately.

        This endpoint is for external API consumers who want synchronous
        transcription of a complete audio file.

        Args:
            request: TranscribeAudioRequest with base64-encoded audio data

        Returns:
            TranscribeAudioResponse with transcription text
        """
        try:
            log_info(
                f"Transcription request: format={request.format}, "
                f"sample_rate={request.sample_rate}, model={request.model}"
            )

            # Decode base64 audio
            try:
                audio_bytes = base64.b64decode(request.audio_data)
            except Exception as e:
                raise ValueError(f"Invalid base64 audio data: {e}") from e

            log_debug(f"Decoded {len(audio_bytes)} bytes of audio")

            # Convert to numpy array
            audio_np = self._decode_audio_to_numpy(
                audio_bytes,
                request.format,
                request.sample_rate,
                request.channels,
            )

            # Calculate duration
            duration_ms = (len(audio_np) / request.sample_rate) * 1000
            log_debug(f"Audio duration: {duration_ms:.0f}ms")

            # Select model
            if request.model == "accurate":
                if not self._accurate_enabled or self._accurate_model is None:
                    raise RuntimeError(
                        "Accurate model unavailable: "
                        f"{self._model_status_message.get('accurate', 'not_loaded')}"
                    )
                model = self._accurate_model
                beam_size = 5
            else:
                if not self._realtime_enabled or self._realtime_model is None:
                    raise RuntimeError(
                        "Realtime model unavailable: "
                        f"{self._model_status_message.get('realtime', 'not_loaded')}"
                    )
                model = self._realtime_model
                beam_size = 1

            # Transcribe
            start_time = time.time()

            with self._model_lock:
                segments, info = model.transcribe(
                    audio_np,
                    language=request.language if request.language else None,
                    beam_size=beam_size,
                    vad_filter=True,  # Let Whisper do VAD for complete files
                )

                # Combine segments into full text
                text_parts = []
                for segment in segments:
                    text_parts.append(segment.text.strip())

            text = " ".join(text_parts).strip()
            elapsed_ms = (time.time() - start_time) * 1000

            log_info(
                f"Transcription complete: '{text[:50]}...' "
                f"({elapsed_ms:.0f}ms, model={request.model})"
            )

            return TranscribeAudioResponse(
                text=text,
                confidence=None,  # Whisper doesn't provide overall confidence
                language=info.language if hasattr(info, "language") else request.language,
                duration_ms=duration_ms,
                model_used=request.model,
            )

        except Exception as e:
            log_error("Transcription error: %s", self._safe_exception_type(e), exc_info=True)
            if isinstance(e, ValueError) and str(e).startswith("Invalid base64 audio data"):
                raise
            raise RuntimeError("Transcription failed") from e


# Export service
__all__ = ["TranscriptionService"]
