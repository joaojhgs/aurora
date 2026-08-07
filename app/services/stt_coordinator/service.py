"""STT Coordinator Service for Aurora.

This service coordinates the complete STT workflow including:
- Audio capture from microphone (PyAudio)
- Wake word detection integration
- Transcription coordination
- Session management with timeouts
- Multi-turn conversation support

This service combines the former AudioInputService and STTCoordinatorService
into a single cohesive internal service.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import threading
import uuid
from datetime import datetime, timedelta
from enum import Enum
from typing import Any

from app.shared.config.keys import ConfigKeys

try:
    import pyaudio
except ImportError:
    pyaudio = None  # type: ignore[misc, assignment]

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import (
    AudioChunk,
    AudioEncoding,
    AudioFormat,
    AudioStreamStarted,
    AudioStreamStopped,
    AudioTopics,
    Command,
    Envelope,
    MessageBus,
    TranscriptionControl,
    TranscriptionResult,
    TranscriptionType,
)
from app.messaging.priority_helpers import get_interactive_priority, get_system_priority
from app.shared.config.interface import ConfigAPI
from app.shared.config.models import AmbientTranscription, AudioInput, Coordinator, System
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.stt import (
    STTAudioChunk,
    STTAudioLevel,
    STTCapturePrepareRequest,
    STTCapturePrepareResponse,
    STTCaptureReleaseRequest,
    STTCaptureReleaseResponse,
    STTCaptureStatusRequest,
    STTCaptureStatusResponse,
    STTCoordinatorControl,
    STTListenRequest,
    STTListenResponse,
    STTMethods,
    STTModule,
    STTStopListeningRequest,
    TranscriptionMethods,
    WakeWordMethods,
)
from app.shared.contracts.models.tts import TTSMethods
from app.shared.contracts.registry import method_contract
from app.shared.messaging.models.stt_coordinator_models import (
    STTSessionEnded,
    STTSessionStarted,
    STTState,
    STTUserSpeechCaptured,
)
from app.shared.services.base_service import BaseService
from app.shared.speech_language_policy import resolve_speech_language_policy

config_api = ConfigAPI()

_TRANSCRIPT_WORD_RE = re.compile(r"\S+")
_TRANSCRIPT_KEY_RE = re.compile(r"[^\w]+", re.UNICODE)


def _transcript_word_key(word: str) -> str:
    """Return a comparison key for one transcript word."""
    return _TRANSCRIPT_KEY_RE.sub("", word).casefold()


def _transcript_words(text: str) -> list[str]:
    """Split transcript text into display-preserving word tokens."""
    return _TRANSCRIPT_WORD_RE.findall(" ".join(text.split()))


def merge_transcript_text(previous: str, incoming: str, *, append_on_miss: bool) -> str:
    """Merge rolling STT updates without losing earlier utterance text.

    Faster realtime/accurate STT calls can return a sliding tail of the active
    utterance. If we simply replace the text, long voice prompts lose their
    beginning before they reach the UI and LLM. This keeps the prefix from the
    best overlapping previous text while letting the newer incoming tail correct
    its own wording.
    """
    previous = " ".join(previous.split())
    incoming = " ".join(incoming.split())
    if not previous:
        return incoming
    if not incoming:
        return previous

    previous_words = _transcript_words(previous)
    incoming_words = _transcript_words(incoming)
    previous_keys = [_transcript_word_key(word) for word in previous_words]
    incoming_keys = [_transcript_word_key(word) for word in incoming_words]
    if not previous_keys:
        return incoming
    if not incoming_keys:
        return previous

    if incoming_keys[: len(previous_keys)] == previous_keys:
        return incoming
    if previous_keys == incoming_keys:
        return incoming

    # Prefer a match at the start of the incoming text. That is the common shape
    # of Whisper rolling-window updates: the incoming text is a tail beginning
    # somewhere inside the previous preview.
    best_previous_index = -1
    best_length = 0
    for previous_index in range(len(previous_keys)):
        length = 0
        while (
            previous_index + length < len(previous_keys)
            and length < len(incoming_keys)
            and previous_keys[previous_index + length] == incoming_keys[length]
        ):
            length += 1
        if length > best_length:
            best_previous_index = previous_index
            best_length = length

    # Two-word overlaps are useful for short prompts; three words avoids most
    # accidental joins in longer dictation.
    min_overlap = 2 if min(len(previous_keys), len(incoming_keys)) <= 5 else 3
    if best_previous_index >= 0 and best_length >= min_overlap:
        merged_words = previous_words[:best_previous_index] + incoming_words
        return " ".join(merged_words)

    if append_on_miss:
        return f"{previous} {incoming}"
    return incoming


@contextlib.contextmanager
def _native_audio_probe_stderr(enabled: bool):
    """Temporarily silence PortAudio/ALSA/JACK probe spam when using Pulse/PipeWire.

    PyAudio reports real initialization failures through Python exceptions, which
    are logged by the caller. The native probe can still print dozens of ALSA
    and JACK fallback errors to stderr even when Pulse/PipeWire capture succeeds.
    """
    if not enabled:
        yield
        return
    saved_stderr_fd: int | None = None
    devnull_fd: int | None = None
    try:
        saved_stderr_fd = os.dup(2)
        devnull_fd = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull_fd, 2)
        yield
    finally:
        if saved_stderr_fd is not None:
            with contextlib.suppress(OSError):
                os.dup2(saved_stderr_fd, 2)
            with contextlib.suppress(OSError):
                os.close(saved_stderr_fd)
        if devnull_fd is not None:
            with contextlib.suppress(OSError):
                os.close(devnull_fd)


class STTCoordinatorService(BaseService):
    """STT Coordinator service with integrated audio capture.

    Responsibilities:
    - Capture audio from microphone using PyAudio
    - Coordinate wake word detection and transcription
    - Manage conversation sessions
    - Handle timeouts and multi-turn conversations
    - Stream audio chunks to wake word and transcription services
    """

    def __init__(self):
        """Initialize STT coordinator with audio capture."""
        super().__init__(
            module=STTModule.NAME,
            summary="STT coordination service with integrated audio capture",
            capabilities=["audio_capture", "session_management", "stt_coordination"],
        )
        # State machine
        self._state = STTState.IDLE
        self._state_lock = asyncio.Lock()

        # Session management
        self._current_session_id: str | None = None
        self._session_start_time: datetime | None = None
        self._accumulated_transcription: str = ""
        self._partial_transcription_preview: str = ""

        # PyAudio resources (Any: optional dependency; types are pyaudio.PyAudio / Stream when installed)
        self._pyaudio: Any = None
        self._stream: Any = None
        self._capture_thread: threading.Thread | None = None

        # Audio capture state
        self._capturing = False
        self._paused = False
        self._running = False  # Service running state
        self._capture_owner: str = "none"
        self._capture_generation = 0
        self._capture_lease_id: str | None = None
        self._capture_owner_id: str | None = None
        self._capture_lease_expires_at: datetime | None = None
        self._capture_lease_expiry_task: asyncio.Task | None = None
        self._last_released_capture_lease: tuple[str, int, str] | None = None
        self._capture_owner_lock = asyncio.Lock()

        # Audio configuration
        self._sample_rate = 16000
        self._channels = 1
        self._chunk_size = 1024  # Frames per buffer
        # pyaudio.paInt16 == 8; keep numeric constant when PyAudio is not installed (unit tests / minimal env)
        self._format = pyaudio.paInt16 if pyaudio is not None else 8
        self._device_index: int | None = None
        self._audio_input_available: bool = False
        self._audio_source: str = ""

        # Stream tracking
        self._stream_id: str | None = None
        self._sequence = 0
        self._total_chunks = 0
        self._stream_start_time: datetime | None = None

        # Event loop for async operations
        self._loop: asyncio.AbstractEventLoop | None = None

        # Coordinator configuration
        self._listen_timeout_seconds = 30.0
        self._multi_turn_enabled = False
        self._pause_tts_on_listening = True
        self._ambient_transcription_enabled = False
        self._tts_playing = False
        self._tts_interrupted_for_session = False
        self._language_policy = resolve_speech_language_policy("en", "auto")

        # Timeout task
        self._timeout_task: asyncio.Task | None = None

        # Statistics
        self._sessions_started = 0
        self._sessions_completed = 0
        self._sessions_timeout = 0

    async def on_start(self) -> None:
        """Start the STT coordinator service with audio capture."""
        if self._running:
            log_warning("STT coordinator already running")
            return

        log_info("Starting STT coordinator service...")
        self._running = True

        # Load configuration
        await self._load_config()

        # Store event loop
        self._loop = asyncio.get_event_loop()

        # Initialize PyAudio (optional in Docker without /dev/snd unless AURORA_STT_REQUIRE_MICROPHONE=1)
        self._initialize_pyaudio()

        # Set initial state
        await self._transition_to(STTState.IDLE)

        # Auto-start audio capture if configured and hardware is available
        # Schema has no audio_input.auto_start; default matches prior missing-key behavior.
        auto_start = True
        if auto_start and self._audio_input_available:
            await self._start_audio_capture()
        elif auto_start and not self._audio_input_available:
            log_warning(
                "Audio auto_start skipped: no microphone / PyAudio input (STT bus events still work)"
            )

        # Subscribe to wake word detection events
        await self.bus.subscribe_event(WakeWordMethods.DETECTED, self._on_wake_word_detected)

        # Subscribe to transcription result events
        await self.bus.subscribe_event(
            TranscriptionMethods.RESULT, self._on_transcription_result
        )
        await self.bus.subscribe_event(TTSMethods.STARTED, self._on_tts_lifecycle_event)
        await self.bus.subscribe_event(TTSMethods.STOPPED, self._on_tts_lifecycle_event)
        await self.bus.subscribe_event(TTSMethods.PAUSED, self._on_tts_lifecycle_event)
        await self.bus.subscribe_event(TTSMethods.RESUMED, self._on_tts_lifecycle_event)
        await self.bus.subscribe_event(TTSMethods.ERROR, self._on_tts_lifecycle_event)

        if not self._ambient_transcription_enabled:
            try:
                await self.bus.publish(
                    TranscriptionMethods.CONTROL,
                    TranscriptionControl(action="pause"),
                    event=False,
                )
                log_debug("Transcription paused at coordinator startup (ambient mode disabled)")
            except Exception as e:
                log_warning(f"Failed to pause transcription at startup: {e}")

        log_info("STT coordinator started with audio capture")
        log_info(f"   Audio: {self._sample_rate}Hz, {self._channels}ch, {self._chunk_size} frames")
        log_info(
            f"   Device: {self._device_index if self._audio_input_available else 'unavailable'}"
        )
        log_info(f"   Listen timeout: {self._listen_timeout_seconds}s")
        log_info(f"   Multi-turn: {'enabled' if self._multi_turn_enabled else 'disabled'}")
        log_info(f"   Pause TTS: {'yes' if self._pause_tts_on_listening else 'no'}")
        log_info(
            f"   Ambient transcription: {'enabled' if self._ambient_transcription_enabled else 'disabled'}"
        )

    async def on_stop(self) -> None:
        """Stop the STT coordinator service."""
        if not self._running:
            return

        log_info("Stopping STT coordinator service...")
        self._running = False

        self.bus.unsubscribe(WakeWordMethods.DETECTED, self._on_wake_word_detected)
        self.bus.unsubscribe(TranscriptionMethods.RESULT, self._on_transcription_result)
        self.bus.unsubscribe(TTSMethods.STARTED, self._on_tts_lifecycle_event)
        self.bus.unsubscribe(TTSMethods.STOPPED, self._on_tts_lifecycle_event)
        self.bus.unsubscribe(TTSMethods.PAUSED, self._on_tts_lifecycle_event)
        self.bus.unsubscribe(TTSMethods.RESUMED, self._on_tts_lifecycle_event)
        self.bus.unsubscribe(TTSMethods.ERROR, self._on_tts_lifecycle_event)

        # Stop audio capture if active
        if self._capturing:
            await self._stop_audio_capture()
        lease_task_to_drain = None
        async with self._capture_owner_lock:
            if self._capture_owner == "native":
                lease_task_to_drain = self._clear_native_capture_owner_locked()
                self._capture_generation += 1
        await self._drain_cancelled_capture_lease_task(lease_task_to_drain)

        # Cancel any pending timeout
        if self._timeout_task and not self._timeout_task.done():
            self._timeout_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._timeout_task

        # End current session if active
        if self._current_session_id:
            await self._end_session("manual")

        # Cleanup PyAudio resources
        if self._pyaudio:
            self._pyaudio.terminate()
            self._pyaudio = None

        log_info("STT coordinator service stopped")

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading STT coordinator configuration (section: {config_section})")

        if config_section == "system":
            self._language_policy = await self._read_language_policy()
            log_info("STT coordinator language policy reloaded")
            return

        # If STT or audio config changed, reload
        if (
            config_section is None
            or config_section == "services"
            or config_section == "services.stt"
        ):
            log_info("STT coordinator configuration changed, reloading...")
            was_capturing = self._capturing

            # Stop capturing if active
            if was_capturing:
                await self._stop_audio_capture()

            # Reload configuration
            await self._load_config()

            # Restart capturing if it was active before
            if was_capturing:
                await self._start_audio_capture()

            log_info("STT coordinator configuration reloaded")
        else:
            log_debug(f"STT coordinator reloaded for section: {config_section}")

    async def _load_config(self) -> None:
        """Load configuration from configuration service."""
        coord_config = await config_api.aget(ConfigKeys.services.stt.coordinator, Coordinator)
        self._language_policy = await self._read_language_policy()

        # Audio configuration
        audio_input = coord_config.audio_input or AudioInput()
        self._sample_rate = (
            audio_input.sample_rate if audio_input.sample_rate is not None else 16000
        )
        self._channels = audio_input.channels if audio_input.channels is not None else 1
        self._chunk_size = audio_input.chunk_size if audio_input.chunk_size is not None else 1024
        self._device_index = audio_input.device_index
        self._audio_source = os.environ.get("AURORA_STT_AUDIO_SOURCE", "").strip().lower()

        # Coordinator configuration
        self._listen_timeout_seconds = (
            coord_config.session_timeout_s if coord_config.session_timeout_s is not None else 30.0
        )
        self._multi_turn_enabled = (
            coord_config.multi_turn_enabled
            if coord_config.multi_turn_enabled is not None
            else False
        )
        # Not present in schema; kept for compatibility with any future use.
        self._multi_turn_timeout = 10.0

        self._pause_tts_on_listening = (
            coord_config.pause_tts_on_listen
            if coord_config.pause_tts_on_listen is not None
            else True
        )

        ambient = coord_config.ambient_transcription or AmbientTranscription()
        self._ambient_transcription_enabled = (
            ambient.enable if ambient.enable is not None else False
        )

    async def _read_language_policy(self):
        """Read canonical speech language policy without mutating other coordinator state."""

        system_config = await config_api.aget(ConfigKeys.system, System)
        if not isinstance(system_config, System):
            system_config = System()
        return resolve_speech_language_policy(
            system_config.primary_language,
            system_config.voice_language,
        )

    def _initialize_pyaudio(self) -> None:
        """Initialize PyAudio and enumerate devices."""
        self._audio_input_available = False
        if pyaudio is None:
            require = os.environ.get("AURORA_STT_REQUIRE_MICROPHONE", "").lower() in (
                "1",
                "true",
                "yes",
            )
            if require:
                raise RuntimeError(
                    "PyAudio is required (AURORA_STT_REQUIRE_MICROPHONE=1) but the module is not installed"
                )
            log_warning(
                "PyAudio is not installed; STT coordinator will run without microphone capture"
            )
            self._pyaudio = None
            self._device_index = None
            return
        try:
            input_devices: list[dict[str, Any]] = []
            suppress_probe_stderr = self._audio_source in {"pulse", "pipewire"}
            with _native_audio_probe_stderr(suppress_probe_stderr):
                self._pyaudio = pyaudio.PyAudio()

                # Log available devices
                log_debug("Available audio input devices:")
                for i in range(self._pyaudio.get_device_count()):
                    try:
                        info = self._pyaudio.get_device_info_by_index(i)
                        if info.get("maxInputChannels", 0) > 0:
                            input_devices.append(dict(info))
                            log_debug(
                                f"  [{i}] {info.get('name')} "
                                f"(channels: {info.get('maxInputChannels')}, "
                                f"rate: {info.get('defaultSampleRate')})"
                            )
                    except Exception as e:
                        log_debug(f"Could not get info for device {i}: {e}")

                # If no device index specified, use default or the requested audio source.
                if self._device_index is None:
                    preferred_device = self._preferred_input_device(input_devices)
                    if preferred_device is None:
                        preferred_device = self._pyaudio.get_default_input_device_info()
                    self._device_index = int(preferred_device["index"])
                    log_debug(f"Using input device: {preferred_device['name']}")

            self._audio_input_available = True

        except Exception as e:
            log_error(f"Failed to initialize PyAudio: {e}", exc_info=True)
            require = os.environ.get("AURORA_STT_REQUIRE_MICROPHONE", "").lower() in (
                "1",
                "true",
                "yes",
            )
            if require:
                raise
            self._pyaudio = None
            self._device_index = None
            self._audio_input_available = False
            log_warning(
                "STT coordinator running without local microphone capture "
                "(set AURORA_STT_REQUIRE_MICROPHONE=1 to fail fast in production)"
            )

    def _preferred_input_device(self, devices: list[dict[str, Any]]) -> dict[str, Any] | None:
        """Return the preferred PyAudio input device for the configured source."""
        if not devices or self._audio_source not in {"pulse", "pipewire"}:
            return None
        preferred_names = ("pulse", "pipewire", "default")
        for preferred_name in preferred_names:
            for device in devices:
                name = str(device.get("name", "")).lower()
                if name == preferred_name or preferred_name in name:
                    return device
        return None

    async def _start_audio_capture(self) -> None:
        """Start audio capture from microphone."""
        if self._capturing:
            log_warning("Audio capture already active")
            return

        if self._capture_owner == "native":
            log_warning("Audio capture start skipped: native runtime owns the microphone")
            return

        if not self._audio_input_available or self._pyaudio is None:
            log_warning("Audio capture skipped: no PyAudio input device")
            return

        log_info("Starting audio capture...")

        try:
            # Generate new stream ID
            self._stream_id = str(uuid.uuid4())
            self._sequence = 0
            self._total_chunks = 0
            self._stream_start_time = datetime.utcnow()

            # Open PyAudio stream before bus events so we never emit STARTED then fail to open
            self._stream = self._pyaudio.open(
                format=self._format,
                channels=self._channels,
                rate=self._sample_rate,
                input=True,
                input_device_index=self._device_index,
                frames_per_buffer=self._chunk_size,
                stream_callback=None,  # We'll use blocking read
            )

            self._capturing = True
            self._paused = False
            self._capture_owner = "python"
            self._capture_lease_id = None
            self._capture_owner_id = None

            # Create audio format descriptor
            audio_format = AudioFormat(
                sample_rate=self._sample_rate,
                channels=self._channels,
                encoding=AudioEncoding.PCM_S16LE,
                bits_per_sample=16,
                chunk_duration_ms=(self._chunk_size / self._sample_rate) * 1000,
            )

            await self.bus.publish(
                AudioTopics.STARTED,
                AudioStreamStarted(
                    stream_id=self._stream_id,
                    source="microphone",
                    format=audio_format,
                ),
                event=True,
                priority=get_interactive_priority(),
            )

            # Start capture thread
            self._capture_thread = threading.Thread(
                target=self._capture_loop, daemon=True, name="AudioCapture"
            )
            self._capture_thread.start()

            log_info(f"Audio capture started (stream_id: {self._stream_id})")

        except Exception as e:
            log_error(f"Failed to start audio capture: {e}", exc_info=True)
            self._capturing = False
            if self._capture_owner == "python":
                self._capture_owner = "none"
            self._capture_thread = None
            if self._stream is not None:
                with contextlib.suppress(Exception):
                    self._stream.stop_stream()
                with contextlib.suppress(Exception):
                    self._stream.close()
                self._stream = None
            require = os.environ.get("AURORA_STT_REQUIRE_MICROPHONE", "").lower() in (
                "1",
                "true",
                "yes",
            )
            if require:
                raise
            self._audio_input_available = False
            log_warning(
                "STT coordinator continuing without microphone capture after stream failure "
                "(set AURORA_STT_REQUIRE_MICROPHONE=1 to fail fast)"
            )

    async def _stop_audio_capture(self, reason: str = "user_request") -> None:
        """Stop audio capture.

        Args:
            reason: Reason for stopping
        """
        capture_thread_alive = bool(
            self._capture_thread and self._capture_thread.is_alive()
        )
        if not self._capturing and not capture_thread_alive and self._stream is None:
            return

        log_info(f"Stopping audio capture (reason: {reason})...")

        self._capturing = False

        # Stop the stream before joining so a blocking read can return.
        if self._stream:
            try:
                await asyncio.to_thread(self._stream.stop_stream)
            except Exception as e:
                log_error(f"Error stopping audio stream: {e}")
                self._capturing = True
                raise RuntimeError("audio_stream_stop_failed") from e

        if self._capture_thread and self._capture_thread.is_alive():
            await asyncio.to_thread(self._capture_thread.join, 5.0)
            if self._capture_thread.is_alive():
                self._capturing = True
                raise RuntimeError("audio_capture_thread_still_alive")
        self._capture_thread = None

        if self._stream:
            try:
                await asyncio.to_thread(self._stream.close)
            except Exception as e:
                log_error(f"Error closing audio stream: {e}")
                self._capturing = True
                raise RuntimeError("audio_stream_close_failed") from e
            self._stream = None
        if self._capture_owner == "python":
            self._capture_owner = "none"

        # Calculate total duration
        total_duration_ms = 0.0
        if self._stream_start_time:
            duration = datetime.utcnow() - self._stream_start_time
            total_duration_ms = duration.total_seconds() * 1000

        # Emit stream stopped event
        if self._loop and self._stream_id:
            asyncio.run_coroutine_threadsafe(
                self.bus.publish(
                    AudioTopics.STOPPED,
                    AudioStreamStopped(
                        stream_id=self._stream_id,
                        source="microphone",
                        total_chunks=self._total_chunks,
                        total_duration_ms=total_duration_ms,
                        reason=reason,
                    ),
                    event=True,
                    priority=get_interactive_priority(),
                ),
                self._loop,
            )

        log_info(f"Audio capture stopped ({self._total_chunks} chunks)")

    def _capture_loop(self) -> None:
        """Capture loop running in separate thread."""
        log_info("Audio capture loop started")

        try:
            while self._capturing:
                if self._paused:
                    # Sleep briefly when paused
                    threading.Event().wait(0.1)
                    continue

                try:
                    # Read audio data from stream
                    audio_data = self._stream.read(self._chunk_size, exception_on_overflow=False)

                    audio_format = AudioFormat(
                        sample_rate=self._sample_rate,
                        channels=self._channels,
                        encoding=AudioEncoding.PCM_S16LE,
                        bits_per_sample=16,
                        chunk_duration_ms=(self._chunk_size / self._sample_rate) * 1000,
                    )

                    # Create audio chunk. Include format while a session is
                    # active so Transcription can recover after being paused at
                    # startup and still run VAD/end-of-speech correctly.
                    chunk = AudioChunk(
                        data=audio_data,
                        source="microphone",
                        stream_id=self._stream_id,
                        sequence=self._sequence,
                        format=audio_format
                        if self._sequence == 0 or self._current_session_id
                        else None,
                    )

                    # Publish chunk to message bus
                    if self._loop and self._loop.is_running():
                        asyncio.run_coroutine_threadsafe(
                            self.bus.publish(
                                AudioTopics.STREAM_MICROPHONE,
                                chunk,
                                event=True,
                                priority=get_system_priority(),
                            ),
                            self._loop,
                        )
                        if self._current_session_id and self._sequence % 3 == 0:
                            audio_level = self._audio_level_event(audio_data)
                            if audio_level is not None:
                                asyncio.run_coroutine_threadsafe(
                                    self.bus.publish(
                                        STTMethods.AUDIO_LEVEL,
                                        audio_level,
                                        event=True,
                                        mesh=False,
                                        origin="internal",
                                        priority=get_interactive_priority(),
                                    ),
                                    self._loop,
                                )

                    self._sequence += 1
                    self._total_chunks += 1

                except Exception as e:
                    if self._capturing:
                        log_error(f"Error reading audio: {e}", exc_info=True)
                    break

        except Exception as e:
            log_error(f"Fatal error in capture loop: {e}", exc_info=True)

        finally:
            log_info("Audio capture loop ended")

    def _audio_level_event(self, audio_data: bytes) -> STTAudioLevel | None:
        """Build redacted audio level telemetry for UI waveform displays."""
        sample_count = len(audio_data) // 2
        if sample_count <= 0:
            return None
        samples = memoryview(audio_data[: sample_count * 2]).cast("h")
        if not samples:
            return None
        sum_squares = 0
        peak_sample = 0
        for sample in samples:
            absolute = abs(int(sample))
            peak_sample = max(peak_sample, absolute)
            sum_squares += absolute * absolute
        rms = (sum_squares / len(samples)) ** 0.5
        level = min(100.0, (rms / 32768.0) * 100.0)
        peak = min(100.0, (peak_sample / 32768.0) * 100.0)
        return STTAudioLevel(
            session_id=self._current_session_id,
            stream_id=self._stream_id,
            sequence=self._sequence,
            level=round(level, 2),
            peak=round(peak, 2),
            bars=self._audio_level_bars(samples),
        )

    def _audio_level_bars(self, samples: memoryview[int], bar_count: int = 24) -> list[float]:
        """Summarize a live PCM chunk into waveform bars without exposing samples."""
        if len(samples) == 0 or bar_count <= 0:
            return []
        segment_size = max(1, len(samples) // bar_count)
        bars: list[float] = []
        for bar_index in range(bar_count):
            start = bar_index * segment_size
            end = (
                len(samples)
                if bar_index == bar_count - 1
                else min(len(samples), start + segment_size)
            )
            if start >= end:
                bars.append(0.0)
                continue
            sum_squares = 0
            peak = 0
            for sample in samples[start:end]:
                absolute = abs(int(sample))
                peak = max(peak, absolute)
                sum_squares += absolute * absolute
            rms = (sum_squares / (end - start)) ** 0.5
            # Blend RMS and local peak so quiet speech still moves while sharp
            # consonants show as taller bars. Values are derived amplitude only.
            percent = min(100.0, ((rms / 32768.0) * 72.0) + ((peak / 32768.0) * 28.0))
            bars.append(round(percent, 2))
        return bars

    async def _transition_to(self, new_state: STTState) -> None:
        """Transition to a new state.

        Args:
            new_state: State to transition to
        """
        async with self._state_lock:
            old_state = self._state
            self._state = new_state

            if old_state != new_state:
                log_info(f"State transition: {old_state.value} → {new_state.value}")

    async def _on_tts_lifecycle_event(self, envelope: Envelope) -> None:
        """Track TTS playback so wakeword does not self-trigger from Aurora speech."""
        if envelope.type == TTSMethods.STARTED or envelope.type == TTSMethods.RESUMED:
            self._tts_playing = True
            return
        if envelope.type in {TTSMethods.STOPPED, TTSMethods.PAUSED, TTSMethods.ERROR}:
            self._tts_playing = False

    async def _on_wake_word_detected(self, envelope: Envelope) -> None:
        """Handle wake word detection event.

        Args:
            envelope: Message envelope containing WakeWordDetected
        """
        async with self._capture_owner_lock:
            if self._capture_owner == "native":
                log_debug("Ignoring wake word while native capture owns the microphone")
                return

            wake_word_event = envelope.payload
            wake_word = wake_word_event.wake_word

            log_info(f"Wake word detected: '{wake_word}'")

            # Only start new session if in IDLE state
            async with self._state_lock:
                if self._state != STTState.IDLE:
                    log_debug(f"Ignoring wake word (state: {self._state.value})")
                    return

            # Start new listening session
            await self._start_session(wake_word)

    async def _start_session(self, wake_word: str, session_id: str | None = None) -> None:
        """Start a new STT listening session.

        Args:
            wake_word: Wake word that triggered the session
        """
        # Generate session ID
        session_id = session_id or f"stt-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}"
        self._current_session_id = session_id
        self._session_start_time = datetime.now()
        self._accumulated_transcription = ""
        self._partial_transcription_preview = ""
        self._sessions_started += 1

        log_info(f"Starting STT session: {session_id}")

        # Transition to LISTENING state
        await self._transition_to(STTState.LISTENING)

        # Interrupt any active TTS playback before listening so the user can
        # barge in with the wakeword and the microphone does not transcribe
        # Aurora's own output. Non-playing/paused TTS keeps the older pause/
        # resume behavior for compatibility.
        if self._pause_tts_on_listening:
            if self._tts_playing:
                log_info("Interrupting TTS playback for wakeword/listen session")
                self._tts_interrupted_for_session = True
                try:
                    stop_result = await self.bus.request(
                        TTSMethods.STOP,
                        EmptyInput(),
                        timeout=2.0,
                        priority=get_interactive_priority(),
                    )
                    if not stop_result.ok:
                        log_warning(
                            f"TTS stop request failed before listening: {stop_result.error}"
                        )
                except Exception as e:
                    log_warning(f"Failed to stop TTS before listening: {e}")
            else:
                self._tts_interrupted_for_session = False
                log_debug("Pausing TTS playback")
                try:
                    from app.shared.messaging.models.tts_models import TTSPause

                    await self.bus.publish(
                        TTSMethods.PAUSE,
                        TTSPause(),
                        event=False,
                        priority=get_interactive_priority(),
                    )
                except Exception as e:
                    log_warning(f"Failed to pause TTS: {e}")

        # Enable transcription (unpause if paused)
        try:
            await self.bus.publish(
                TranscriptionMethods.CONTROL,
                TranscriptionControl(
                    action="set_language",
                    language=self._language_policy.stt_language,
                ),
                event=False,
            )
            await self.bus.publish(
                TranscriptionMethods.CONTROL, TranscriptionControl(action="resume"), event=False
            )
        except Exception as e:
            log_warning(f"Failed to enable transcription: {e}")

        # Start timeout timer. It is refreshed by realtime/partial speech so
        # long utterances are not cut off by a fixed wall-clock timeout.
        self._restart_timeout_timer()

        # Emit session started event
        await self.bus.publish(
            STTMethods.SESSION_STARTED,
            STTSessionStarted(wake_word=wake_word, session_id=session_id),
            event=True,
            mesh=False,
            origin="internal",
        )

    async def _timeout_handler(self) -> None:
        """Handle session timeout."""
        try:
            await asyncio.sleep(self._listen_timeout_seconds)

            # Timeout reached
            log_warning(f"Session timeout ({self._listen_timeout_seconds}s)")

            # Check state and mark for timeout handling
            should_timeout = False
            async with self._state_lock:
                if self._state == STTState.LISTENING:
                    should_timeout = True
                    self._sessions_timeout += 1

            # Handle timeout outside the lock to avoid deadlock. Flush first so
            # a long utterance still gets a final transcript/assistant response
            # instead of silently ending the UI in a stuck listening state.
            if should_timeout:
                await self._transition_to(STTState.PROCESSING)
                flush_result = await self.bus.request(
                    TranscriptionMethods.CONTROL,
                    TranscriptionControl(action="flush"),
                    timeout=12.0,
                    priority=get_interactive_priority(),
                )
                if not flush_result.ok:
                    log_warning(f"Failed to flush transcription on timeout: {flush_result.error}")
                    await self._transition_to(STTState.TIMEOUT)
                    await self._end_session("timeout")
                else:
                    self._timeout_task = asyncio.create_task(self._flush_timeout_handler())

        except asyncio.CancelledError:
            # Timeout was cancelled (normal - speech was captured)
            pass

    def _restart_timeout_timer(self) -> None:
        """Restart the listening timeout from the latest observed speech activity."""
        if self._timeout_task and not self._timeout_task.done():
            self._timeout_task.cancel()
        self._timeout_task = asyncio.create_task(self._timeout_handler())

    async def _flush_timeout_handler(self) -> None:
        """End a manual recording session if no transcription arrives after stop."""
        try:
            # Accurate Whisper transcription for longer utterances can exceed the
            # old six-second guard, which made the UI look stuck or randomly cut
            # off speech even though the backend was still processing. Keep the
            # stop flush bounded, but align it with the configured listen window.
            await asyncio.sleep(max(12.0, min(self._listen_timeout_seconds, 30.0)))
            should_end = False
            async with self._state_lock:
                should_end = (
                    self._state == STTState.PROCESSING and self._current_session_id is not None
                )
            if should_end:
                log_warning("No transcription received after manual stop; ending voice session")
                await self._end_session("no_speech")
        except asyncio.CancelledError:
            pass

    async def _on_transcription_result(self, envelope: Envelope) -> None:
        """Handle transcription result event.

        Args:
            envelope: Message envelope containing TranscriptionResult
        """
        async with self._capture_owner_lock:
            if self._capture_owner == "native":
                log_debug("Ignoring transcription while native capture owns the microphone")
                return

            result: TranscriptionResult = envelope.payload
            text = result.text.strip()

            if not text:
                log_debug("Empty transcription, ignoring")
                return

            if result.transcription_type in {TranscriptionType.REALTIME, TranscriptionType.PARTIAL}:
                async with self._state_lock:
                    should_refresh_timeout = self._state == STTState.LISTENING
                if should_refresh_timeout:
                    self._restart_timeout_timer()
                self._partial_transcription_preview = merge_transcript_text(
                    self._partial_transcription_preview,
                    text,
                    append_on_miss=False,
                )
                await self.bus.publish(
                    STTMethods.PARTIAL,
                    STTUserSpeechCaptured(
                        session_id=self._current_session_id or result.stream_id or "unknown",
                        text=self._partial_transcription_preview,
                        confidence=result.confidence,
                        is_final=False,
                    ),
                    event=True,
                    mesh=False,
                    origin="internal",
                    priority=get_interactive_priority(),
                )
                return

            async with self._state_lock:
                if self._state not in {STTState.LISTENING, STTState.PROCESSING}:
                    log_debug(f"Ignoring transcription (state: {self._state.value})")
                    return

            base_transcription = (
                self._accumulated_transcription or self._partial_transcription_preview
            )
            final_text = merge_transcript_text(
                base_transcription,
                text,
                append_on_miss=bool(self._accumulated_transcription),
            )

            log_info(f"Transcription captured: '{final_text}'")

            # Cancel timeout
            if self._timeout_task and not self._timeout_task.done():
                self._timeout_task.cancel()

            self._accumulated_transcription = final_text
            self._partial_transcription_preview = final_text

            # Transition to PROCESSING state
            await self._transition_to(STTState.PROCESSING)

            # Emit user speech captured event
            speech_event = STTUserSpeechCaptured(
                session_id=self._current_session_id or "unknown",
                text=final_text,
                confidence=result.confidence,
                is_final=True,
            )

            log_debug(
                f"Publishing STTUserSpeechCaptured to topic: {STTMethods.USER_SPEECH_CAPTURED}"
            )
            await self.bus.publish(
                STTMethods.USER_SPEECH_CAPTURED,
                speech_event,
                event=True,
                mesh=False,
                origin="internal",
            )

            # Check if we should continue listening (multi-turn)
            if self._multi_turn_enabled:
                log_debug("Multi-turn enabled, continuing to listen...")
                await self._transition_to(STTState.LISTENING)
                self._restart_timeout_timer()
            else:
                # Single turn - end session
                await self._end_session("complete")

    async def _end_session(self, reason: str) -> None:
        """End the current STT session.

        Args:
            reason: Reason for ending: 'complete', 'timeout', 'manual'
        """
        if not self._current_session_id:
            return

        session_id = self._current_session_id
        transcription = self._accumulated_transcription

        log_info(f"Ending session {session_id} (reason: {reason})")

        if self._timeout_task and not self._timeout_task.done():
            self._timeout_task.cancel()
        self._timeout_task = None

        if reason == "complete":
            self._sessions_completed += 1

        # Emit session ended event
        await self.bus.publish(
            STTMethods.SESSION_ENDED,
            STTSessionEnded(
                session_id=session_id,
                reason=reason,
                transcription=transcription if transcription else None,
            ),
            event=True,
            mesh=False,
            origin="internal",
        )

        # Pause transcription to save resources (ONLY if ambient transcription is disabled)
        if not self._ambient_transcription_enabled:
            try:
                await self.bus.publish(
                    TranscriptionMethods.CONTROL, TranscriptionControl(action="pause"), event=False
                )
                log_debug("Transcription paused (ambient mode disabled)")
            except Exception as e:
                log_warning(f"Failed to pause transcription: {e}")
        else:
            log_debug("Transcription kept running (ambient mode enabled)")

        # Resume TTS if it was paused
        if self._pause_tts_on_listening and not self._tts_interrupted_for_session:
            log_debug("Resuming TTS playback")
            try:
                from app.shared.messaging.models.tts_models import TTSResume

                await self.bus.publish(TTSMethods.RESUME, TTSResume(), event=False)
            except Exception as e:
                log_warning(f"Failed to resume TTS: {e}")
        elif self._tts_interrupted_for_session:
            log_debug("Not resuming TTS because playback was interrupted for this session")

        # Reset session state
        self._current_session_id = None
        self._session_start_time = None
        self._accumulated_transcription = ""
        self._partial_transcription_preview = ""
        self._tts_interrupted_for_session = False

        # Return to IDLE state
        await self._transition_to(STTState.IDLE)

    @method_contract(
        method_id=STTMethods.LISTEN,
        summary="Start listening for speech (server microphone)",
        input_model=STTListenRequest,
        output_model=STTListenResponse,
        exposure="both",
        method_type="use",
        required_perms=["STTCoordinator.use"],
        callable_feature_ids=["listening_session_control"],
    )
    async def _on_listen(self, request: STTListenRequest) -> STTListenResponse:
        """Handle listen command idempotently for UI push-to-talk and wakeword races."""
        log_info(f"Received listen request (session_id={request.session_id})")

        async with self._capture_owner_lock:
            if self._capture_owner == "native":
                return STTListenResponse(
                    success=False,
                    status="unavailable",
                    session_id=request.session_id,
                    current_state=self._state.value,
                    source="push_to_talk",
                    message="native_capture_active",
                )

            async with self._state_lock:
                state = self._state
                current_session_id = self._current_session_id
            if state == STTState.IDLE:
                session_id = request.session_id
                await self._start_session("manual", session_id=session_id)
                return STTListenResponse(
                    success=True,
                    status="listening",
                    session_id=session_id or self._current_session_id,
                    current_state=STTState.LISTENING.value,
                    source="push_to_talk",
                    message="listening_started",
                )

            log_info(
                "Listen request joined active STT session "
                f"(state={state.value}, session_id={current_session_id})"
            )
            return STTListenResponse(
                success=True,
                status="listening" if state == STTState.LISTENING else state.value,
                session_id=current_session_id or request.session_id,
                current_state=state.value,
                source="sdk",
                message="already_listening",
            )

    @method_contract(
        method_id=STTMethods.STOP_LISTENING,
        summary="Stop listening for speech (server microphone)",
        input_model=STTStopListeningRequest,
        output_model=EmptyOutput,
        exposure="both",
        method_type="use",
        required_perms=["STTCoordinator.use"],
        callable_feature_ids=["listening_session_control"],
    )
    async def _on_stop_listening(self, request: STTStopListeningRequest) -> EmptyOutput:
        """Handle stop listening command."""
        log_info("Received stop listening request")

        if self._current_session_id:
            if self._timeout_task and not self._timeout_task.done():
                self._timeout_task.cancel()
            await self._transition_to(STTState.PROCESSING)
            flush_result = await self.bus.request(
                TranscriptionMethods.CONTROL,
                TranscriptionControl(action="flush"),
                timeout=8.0,
                priority=get_interactive_priority(),
            )
            if not flush_result.ok:
                log_warning(f"Failed to flush transcription before stop: {flush_result.error}")
                await self._end_session(request.reason or "manual")
            else:
                self._timeout_task = asyncio.create_task(self._flush_timeout_handler())
        else:
            async with self._state_lock:
                needs_idle = self._state != STTState.IDLE
            if needs_idle:
                await self._transition_to(STTState.IDLE)

        return EmptyOutput()

    def _can_restart_python_capture(self) -> bool:
        """Return whether Python capture may be restarted after native release."""
        return bool(
            self._running
            and self._audio_input_available
            and self._pyaudio is not None
            and self._capture_owner != "native"
        )

    def _schedule_native_capture_lease_expiry_locked(
        self,
        *,
        lease_id: str,
        generation: int,
        owner_id: str,
        ttl_s: int,
    ) -> asyncio.Task | None:
        """Schedule or renew native capture lease expiry while owner lock is held."""
        task_to_drain = None
        current_task = asyncio.current_task()
        if (
            self._capture_lease_expiry_task
            and self._capture_lease_expiry_task is not current_task
            and not self._capture_lease_expiry_task.done()
        ):
            self._capture_lease_expiry_task.cancel()
            task_to_drain = self._capture_lease_expiry_task

        self._capture_lease_expires_at = datetime.utcnow() + timedelta(seconds=ttl_s)
        self._capture_lease_expiry_task = asyncio.create_task(
            self._native_capture_lease_expiry(
                lease_id,
                generation,
                owner_id,
                ttl_s,
            )
        )
        return task_to_drain

    async def _drain_cancelled_capture_lease_task(self, task: asyncio.Task | None) -> None:
        """Drain a canceled lease-expiry task after releasing the owner lock."""
        if task is None or task is asyncio.current_task():
            return
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def _quiesce_python_voice_for_native_prepare_locked(self) -> None:
        """End active Python listening work before granting native microphone ownership."""
        if self._current_session_id:
            await self._end_session("manual")
        else:
            if self._timeout_task and not self._timeout_task.done():
                self._timeout_task.cancel()
            self._timeout_task = None
            self._accumulated_transcription = ""
            self._partial_transcription_preview = ""

            async with self._state_lock:
                needs_idle = self._state != STTState.IDLE
            if needs_idle:
                await self._transition_to(STTState.IDLE)

        try:
            await self.bus.publish(
                TranscriptionMethods.CONTROL,
                TranscriptionControl(action="pause"),
                event=False,
            )
        except Exception as e:
            log_warning(f"Failed to pause transcription for native capture: {e}")

    def _clear_native_capture_owner_locked(self) -> asyncio.Task | None:
        """Clear native capture lease state while the owner lock is held."""
        self._capture_owner = "none"
        self._capture_owner_id = None
        self._capture_lease_id = None
        self._capture_lease_expires_at = None
        task_to_drain = None
        current_task = asyncio.current_task()
        if (
            self._capture_lease_expiry_task
            and self._capture_lease_expiry_task is not current_task
            and not self._capture_lease_expiry_task.done()
        ):
            self._capture_lease_expiry_task.cancel()
            task_to_drain = self._capture_lease_expiry_task
        if self._capture_lease_expiry_task is not current_task:
            self._capture_lease_expiry_task = None
        return task_to_drain

    async def _restart_python_capture_after_native_release_locked(self) -> bool:
        """Restart Python capture after native release without leaking failures."""
        if not self._can_restart_python_capture():
            return False
        try:
            await self._start_audio_capture()
        except Exception:
            log_error("Failed to restart Python capture after native release", exc_info=True)
            self._capture_owner = "none"
            self._capturing = False
            return False
        return self._capturing and self._capture_owner == "python"

    async def _native_capture_lease_expiry(
        self,
        lease_id: str,
        generation: int,
        owner_id: str,
        ttl_s: int,
    ) -> None:
        """Expire stale native microphone ownership and restore Python when allowed."""
        try:
            await asyncio.sleep(ttl_s)
            async with self._capture_owner_lock:
                if (
                    self._capture_owner != "native"
                    or self._capture_lease_id != lease_id
                    or self._capture_generation != generation
                    or self._capture_owner_id != owner_id
                ):
                    return
                self._last_released_capture_lease = (lease_id, generation, owner_id)
                self._clear_native_capture_owner_locked()
                self._capture_generation += 1
                await self._restart_python_capture_after_native_release_locked()
                if self._capture_lease_expiry_task is asyncio.current_task():
                    self._capture_lease_expiry_task = None
        except asyncio.CancelledError:
            pass

    def _capture_status_response(self) -> STTCaptureStatusResponse:
        """Build redacted capture-owner status without device details."""
        return STTCaptureStatusResponse(
            owner=self._capture_owner,  # type: ignore[arg-type]
            generation=self._capture_generation,
            native_lease_active=self._capture_owner == "native",
            lease_expires_at=self._capture_lease_expires_at.isoformat()
            if self._capture_lease_expires_at and self._capture_owner == "native"
            else None,
            python_capture_active=self._capturing and self._capture_owner == "python",
            service_running=self._running,
            audio_input_available=self._audio_input_available,
            can_restart_python_capture=self._can_restart_python_capture(),
        )

    @method_contract(
        method_id=STTMethods.CAPTURE_PREPARE,
        summary="Prepare native microphone ownership",
        input_model=STTCapturePrepareRequest,
        output_model=STTCapturePrepareResponse,
        exposure="both",
        method_type="manage",
        required_perms=["STTCoordinator.manage"],
        callable_feature_ids=["listening_session_control"],
    )
    async def _on_capture_prepare(
        self, request: STTCapturePrepareRequest
    ) -> STTCapturePrepareResponse:
        """Stop Python capture and grant a generation-bound native microphone lease."""
        lease_task_to_drain = None
        async with self._capture_owner_lock:
            if self._capture_owner == "native":
                if (
                    self._capture_owner_id == request.owner_id
                    and self._capture_lease_id
                    and request.lease_id == self._capture_lease_id
                ):
                    lease_task_to_drain = self._schedule_native_capture_lease_expiry_locked(
                        lease_id=self._capture_lease_id,
                        generation=self._capture_generation,
                        owner_id=request.owner_id,
                        ttl_s=request.requested_ttl_s,
                    )
                    response = STTCapturePrepareResponse(
                        granted=True,
                        status="already_owned",
                        lease_id=self._capture_lease_id,
                        generation=self._capture_generation,
                        owner="native",
                        python_capture_active=False,
                        message="already_owned",
                    )
                else:
                    response = STTCapturePrepareResponse(
                        granted=False,
                        status="unavailable",
                        generation=self._capture_generation,
                        owner="native",
                        python_capture_active=False,
                        message="capture_owned",
                    )
            else:
                stopped_python_capture = False
                if self._capturing:
                    try:
                        await self._stop_audio_capture("native_handoff_prepare")
                    except Exception:
                        log_error(
                            "Failed to stop Python capture before native handoff",
                            exc_info=True,
                        )
                        return STTCapturePrepareResponse(
                            granted=False,
                            status="unavailable",
                            generation=self._capture_generation,
                            owner="python",
                            python_capture_active=self._capturing,
                            stopped_python_capture=False,
                            message="python_release_failed",
                        )
                    stopped_python_capture = True

                if self._capturing or self._stream is not None:
                    return STTCapturePrepareResponse(
                        granted=False,
                        status="unavailable",
                        generation=self._capture_generation,
                        owner="python",
                        python_capture_active=self._capturing,
                        stopped_python_capture=stopped_python_capture,
                        message="python_capture_active",
                    )

                await self._quiesce_python_voice_for_native_prepare_locked()

                self._capture_generation += 1
                self._capture_owner = "native"
                self._capture_owner_id = request.owner_id
                self._capture_lease_id = str(uuid.uuid4())
                self._last_released_capture_lease = None
                lease_task_to_drain = self._schedule_native_capture_lease_expiry_locked(
                    lease_id=self._capture_lease_id,
                    generation=self._capture_generation,
                    owner_id=request.owner_id,
                    ttl_s=request.requested_ttl_s,
                )
                response = STTCapturePrepareResponse(
                    granted=True,
                    status="granted",
                    lease_id=self._capture_lease_id,
                    generation=self._capture_generation,
                    owner="native",
                    python_capture_active=False,
                    stopped_python_capture=stopped_python_capture,
                    message="granted",
                )
        await self._drain_cancelled_capture_lease_task(lease_task_to_drain)
        return response

    @method_contract(
        method_id=STTMethods.CAPTURE_RELEASE,
        summary="Release native microphone ownership",
        input_model=STTCaptureReleaseRequest,
        output_model=STTCaptureReleaseResponse,
        exposure="both",
        method_type="manage",
        required_perms=["STTCoordinator.manage"],
        callable_feature_ids=["listening_session_control"],
    )
    async def _on_capture_release(
        self, request: STTCaptureReleaseRequest
    ) -> STTCaptureReleaseResponse:
        """Release a native lease and restart Python capture only when allowed."""
        lease_task_to_drain = None
        async with self._capture_owner_lock:
            release_identity = (request.lease_id, request.generation, request.owner_id)
            if (
                self._capture_owner != "native"
                and self._last_released_capture_lease == release_identity
            ):
                return STTCaptureReleaseResponse(
                    released=True,
                    status="already_released",
                    generation=self._capture_generation,
                    owner=self._capture_owner,  # type: ignore[arg-type]
                    python_capture_active=self._capturing,
                    restarted_python_capture=False,
                    message="already_released",
                )

            if (
                self._capture_owner != "native"
                or self._capture_lease_id != request.lease_id
                or self._capture_generation != request.generation
                or self._capture_owner_id != request.owner_id
            ):
                return STTCaptureReleaseResponse(
                    released=False,
                    status="rejected",
                    generation=self._capture_generation,
                    owner=self._capture_owner,  # type: ignore[arg-type]
                    python_capture_active=self._capturing,
                    message="stale_or_foreign_lease",
                )

            lease_task_to_drain = self._clear_native_capture_owner_locked()
            self._capture_generation += 1
            self._last_released_capture_lease = release_identity

            restarted = (
                await self._restart_python_capture_after_native_release_locked()
                if request.restart_python_capture
                else False
            )

            if request.restart_python_capture and not restarted:
                status = "python_unavailable"
            else:
                status = "released"
            response = STTCaptureReleaseResponse(
                released=True,
                status=status,  # type: ignore[arg-type]
                generation=self._capture_generation,
                owner=self._capture_owner,  # type: ignore[arg-type]
                python_capture_active=self._capturing and self._capture_owner == "python",
                restarted_python_capture=restarted,
                message=status,
            )
        await self._drain_cancelled_capture_lease_task(lease_task_to_drain)
        return response

    @method_contract(
        method_id=STTMethods.CAPTURE_STATUS,
        summary="Get redacted microphone ownership status",
        input_model=STTCaptureStatusRequest,
        output_model=STTCaptureStatusResponse,
        exposure="both",
        method_type="manage",
        required_perms=["STTCoordinator.manage"],
        callable_feature_ids=["listening_session_control"],
    )
    async def _on_capture_status(
        self, request: STTCaptureStatusRequest
    ) -> STTCaptureStatusResponse:
        """Return redacted capture ownership state for native handoff clients."""
        del request
        async with self._capture_owner_lock:
            return self._capture_status_response()

    @method_contract(
        method_id=STTMethods.AUDIO,
        summary="Process raw audio chunk",
        input_model=STTAudioChunk,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def _on_audio_chunk(self, data: STTAudioChunk) -> EmptyOutput:
        """Handle audio chunk."""
        return EmptyOutput()

    @method_contract(
        method_id=STTMethods.CONTROL,
        summary="Handle STT coordinator control commands",
        input_model=STTCoordinatorControl,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="manage",
    )
    async def _on_control(self, data: STTCoordinatorControl) -> EmptyOutput:
        """Handle control commands.

        Args:
            data: Validated STTCoordinatorControl payload
        """
        action = data.action

        log_info(f"Control command: {action}")

        if action == "start_session":
            async with self._capture_owner_lock:
                if self._capture_owner == "native":
                    log_debug("Ignoring start_session while native capture owns the microphone")
                    return EmptyOutput()
                if self._state == STTState.IDLE:
                    await self._start_session("manual")
                else:
                    log_warning(f"Cannot start session in state: {self._state.value}")

        elif action == "end_session":
            if self._current_session_id:
                await self._end_session("manual")
            else:
                log_warning("No active session to end")

        elif action == "reset":
            log_info("Resetting coordinator")
            if self._current_session_id:
                await self._end_session("manual")
            await self._transition_to(STTState.IDLE)

        return EmptyOutput()


# Export service and types
__all__ = [
    "STTCoordinatorService",
    "STTState",
    "STTSessionStarted",
    "STTSessionEnded",
    "STTUserSpeechCaptured",
    "STTCoordinatorControl",
]
