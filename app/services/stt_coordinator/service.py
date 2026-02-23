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
import threading
import uuid
from datetime import datetime
from enum import Enum

import pyaudio
from pydantic import Field

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
)
from app.messaging.priority_helpers import get_interactive_priority, get_system_priority
from app.shared.config.interface import ConfigAPI
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.stt import (
    STTAudioChunk,
    STTCoordinatorControl,
    STTListenRequest,
    STTMethods,
    STTModule,
    STTStopListeningRequest,
    TranscriptionMethods,
    WakeWordMethods,
)
from app.shared.contracts.registry import method_contract
from app.shared.messaging.models.stt_coordinator_models import (
    STTSessionEnded,
    STTSessionStarted,
    STTState,
    STTUserSpeechCaptured,
)
from app.shared.services.base_service import BaseService

config_api = ConfigAPI()


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

        # PyAudio resources
        self._pyaudio: pyaudio.PyAudio | None = None
        self._stream: pyaudio.Stream | None = None
        self._capture_thread: threading.Thread | None = None

        # Audio capture state
        self._capturing = False
        self._paused = False
        self._running = False  # Service running state

        # Audio configuration
        self._sample_rate = 16000
        self._channels = 1
        self._chunk_size = 1024  # Frames per buffer
        self._format = pyaudio.paInt16
        self._device_index: int | None = None

        # Stream tracking
        self._stream_id: str | None = None
        self._sequence = 0
        self._total_chunks = 0
        self._stream_start_time: datetime | None = None

        # Event loop for async operations
        self._loop: asyncio.AbstractEventLoop | None = None

        # Coordinator configuration
        self._listen_timeout_seconds = 10.0
        self._multi_turn_enabled = False
        self._pause_tts_on_listening = True
        self._ambient_transcription_enabled = False

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

        # Initialize PyAudio
        self._initialize_pyaudio()

        # Set initial state
        await self._transition_to(STTState.IDLE)

        # Auto-start audio capture if configured
        auto_start = await config_api.aget("general.speech_to_text.audio_input.auto_start", True)
        if auto_start:
            await self._start_audio_capture()

        # Subscribe to wake word detection events
        self.bus.subscribe(WakeWordMethods.DETECTED, self._on_wake_word_detected)

        # Subscribe to transcription result events
        self.bus.subscribe(TranscriptionMethods.RESULT, self._on_transcription_result)

        log_info("STT coordinator started with audio capture")
        log_info(f"   Audio: {self._sample_rate}Hz, {self._channels}ch, {self._chunk_size} frames")
        log_info(f"   Device: {self._device_index or 'default'}")
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

        # Stop audio capture if active
        if self._capturing:
            await self._stop_audio_capture()

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

        # If STT or audio config changed, reload
        if (
            config_section is None
            or config_section == "general"
            or config_section == "speech_to_text"
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
        """Load configuration from config manager."""
        # Audio configuration
        self._sample_rate = await config_api.aget(
            "general.speech_to_text.audio_input.sample_rate", 16000
        )
        self._channels = await config_api.aget("general.speech_to_text.audio_input.channels", 1)
        self._chunk_size = await config_api.aget(
            "general.speech_to_text.audio_input.chunk_size", 1024
        )
        self._device_index = await config_api.aget(
            "general.speech_to_text.audio_input.device_index", None
        )

        # Coordinator configuration
        self._listen_timeout_seconds = await config_api.aget(
            "general.speech_to_text.coordinator.session_timeout_s", 10.0
        )
        self._multi_turn_enabled = await config_api.aget(
            "general.speech_to_text.coordinator.multi_turn_enabled", False
        )
        self._pause_tts_on_listening = await config_api.aget(
            "general.speech_to_text.coordinator.pause_tts_on_listen", True
        )
        self._ambient_transcription_enabled = await config_api.aget(
            "general.speech_to_text.ambient_transcription.enable", False
        )

    def _initialize_pyaudio(self) -> None:
        """Initialize PyAudio and enumerate devices."""
        try:
            self._pyaudio = pyaudio.PyAudio()

            # Log available devices
            log_debug("Available audio input devices:")
            for i in range(self._pyaudio.get_device_count()):
                try:
                    info = self._pyaudio.get_device_info_by_index(i)
                    if info.get("maxInputChannels", 0) > 0:
                        log_debug(
                            f"  [{i}] {info.get('name')} "
                            f"(channels: {info.get('maxInputChannels')}, "
                            f"rate: {info.get('defaultSampleRate')})"
                        )
                except Exception as e:
                    log_debug(f"Could not get info for device {i}: {e}")

            # If no device index specified, use default
            if self._device_index is None:
                default_device = self._pyaudio.get_default_input_device_info()
                self._device_index = default_device["index"]
                log_debug(f"Using default input device: {default_device['name']}")

        except Exception as e:
            log_error(f"Failed to initialize PyAudio: {e}", exc_info=True)
            raise

    async def _start_audio_capture(self) -> None:
        """Start audio capture from microphone."""
        if self._capturing:
            log_warning("Audio capture already active")
            return

        log_info("Starting audio capture...")

        try:
            # Generate new stream ID
            self._stream_id = str(uuid.uuid4())
            self._sequence = 0
            self._total_chunks = 0
            self._stream_start_time = datetime.utcnow()

            # Create audio format descriptor
            audio_format = AudioFormat(
                sample_rate=self._sample_rate,
                channels=self._channels,
                encoding=AudioEncoding.PCM_S16LE,
                bits_per_sample=16,
                chunk_duration_ms=(self._chunk_size / self._sample_rate) * 1000,
            )

            # Emit stream started event
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

            # Open PyAudio stream
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

            # Start capture thread
            self._capture_thread = threading.Thread(
                target=self._capture_loop, daemon=True, name="AudioCapture"
            )
            self._capture_thread.start()

            log_info(f"Audio capture started (stream_id: {self._stream_id})")

        except Exception as e:
            log_error(f"Failed to start audio capture: {e}", exc_info=True)
            raise

    async def _stop_audio_capture(self, reason: str = "user_request") -> None:
        """Stop audio capture.

        Args:
            reason: Reason for stopping
        """
        if not self._capturing:
            return

        log_info(f"Stopping audio capture (reason: {reason})...")

        self._capturing = False

        # Wait for capture thread to finish
        if self._capture_thread and self._capture_thread.is_alive():
            self._capture_thread.join(timeout=5.0)

        # Close PyAudio stream
        if self._stream:
            try:
                self._stream.stop_stream()
                self._stream.close()
            except Exception as e:
                log_error(f"Error closing audio stream: {e}")
            self._stream = None

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

                    # Create audio chunk
                    chunk = AudioChunk(
                        data=audio_data,
                        source="microphone",
                        stream_id=self._stream_id,
                        sequence=self._sequence,
                        # Only send format with first chunk
                        format=(
                            None
                            if self._sequence > 0
                            else AudioFormat(
                                sample_rate=self._sample_rate,
                                channels=self._channels,
                                encoding=AudioEncoding.PCM_S16LE,
                                bits_per_sample=16,
                                chunk_duration_ms=(self._chunk_size / self._sample_rate) * 1000,
                            )
                        ),
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

    async def _on_wake_word_detected(self, envelope: Envelope) -> None:
        """Handle wake word detection event.

        Args:
            envelope: Message envelope containing WakeWordDetected
        """
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

    async def _start_session(self, wake_word: str) -> None:
        """Start a new STT listening session.

        Args:
            wake_word: Wake word that triggered the session
        """
        # Generate session ID
        session_id = f"stt-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}"
        self._current_session_id = session_id
        self._session_start_time = datetime.now()
        self._accumulated_transcription = ""
        self._sessions_started += 1

        log_info(f"Starting STT session: {session_id}")

        # Transition to LISTENING state
        await self._transition_to(STTState.LISTENING)

        # Pause TTS if configured
        if self._pause_tts_on_listening:
            log_debug("Pausing TTS playback")
            try:
                from app.shared.contracts.models.tts import TTSMethods
                from app.shared.messaging.models.tts_models import TTSPause

                await self.bus.publish(
                    TTSMethods.PAUSE, TTSPause(), event=False, priority=get_interactive_priority()
                )
            except Exception as e:
                log_warning(f"Failed to pause TTS: {e}")

        # Enable transcription (unpause if paused)
        try:
            await self.bus.publish(
                TranscriptionMethods.CONTROL, TranscriptionControl(action="resume"), event=False
            )
        except Exception as e:
            log_warning(f"Failed to enable transcription: {e}")

        # Start timeout timer
        self._timeout_task = asyncio.create_task(self._timeout_handler())

        # Emit session started event
        await self.bus.publish(
            STTMethods.SESSION_STARTED,
            STTSessionStarted(wake_word=wake_word, session_id=session_id),
            event=True,
            mesh=True,
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

            # Handle timeout outside the lock to avoid deadlock
            if should_timeout:
                await self._transition_to(STTState.TIMEOUT)
                await self._end_session("timeout")

        except asyncio.CancelledError:
            # Timeout was cancelled (normal - speech was captured)
            pass

    async def _on_transcription_result(self, envelope: Envelope) -> None:
        """Handle transcription result event.

        Args:
            envelope: Message envelope containing TranscriptionResult
        """
        result: TranscriptionResult = envelope.payload
        text = result.text.strip()

        if not text:
            log_debug("Empty transcription, ignoring")
            return

        async with self._state_lock:
            if self._state != STTState.LISTENING:
                log_debug(f"Ignoring transcription (state: {self._state.value})")
                return

        log_info(f"Transcription captured: '{text}'")

        # Cancel timeout
        if self._timeout_task and not self._timeout_task.done():
            self._timeout_task.cancel()

        # Accumulate transcription
        if self._accumulated_transcription:
            self._accumulated_transcription += " " + text
        else:
            self._accumulated_transcription = text

        # Transition to PROCESSING state
        await self._transition_to(STTState.PROCESSING)

        # Emit user speech captured event
        speech_event = STTUserSpeechCaptured(
            session_id=self._current_session_id or "unknown",
            text=text,
            confidence=result.confidence,
            is_final=True,
        )

        log_debug(f"Publishing STTUserSpeechCaptured to topic: {STTMethods.USER_SPEECH_CAPTURED}")
        await self.bus.publish(
            STTMethods.USER_SPEECH_CAPTURED,
            speech_event,
            event=True,
            mesh=True,
            origin="internal",
        )

        # Check if we should continue listening (multi-turn)
        if self._multi_turn_enabled:
            log_debug("Multi-turn enabled, continuing to listen...")
            await self._transition_to(STTState.LISTENING)
            self._timeout_task = asyncio.create_task(self._timeout_handler())
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
            mesh=True,
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
        if self._pause_tts_on_listening:
            log_debug("Resuming TTS playback")
            try:
                from app.shared.contracts.models.tts import TTSMethods
                from app.shared.messaging.models.tts_models import TTSResume

                await self.bus.publish(TTSMethods.RESUME, TTSResume(), event=False)
            except Exception as e:
                log_warning(f"Failed to resume TTS: {e}")

        # Reset session state
        self._current_session_id = None
        self._session_start_time = None
        self._accumulated_transcription = ""

        # Return to IDLE state
        await self._transition_to(STTState.IDLE)

    @method_contract(
        method_id=STTMethods.LISTEN,
        summary="Start listening for speech (server microphone)",
        input_model=STTListenRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def _on_listen(self, request: STTListenRequest) -> EmptyOutput:
        """Handle listen command."""
        log_info(f"Received listen request (session_id={request.session_id})")

        # Start listening logic...
        # For now, just acknowledge
        await self.bus.publish(
            STTMethods.SESSION_STARTED,
            STTSessionStarted(session_id=request.session_id or "manual", wake_word="manual"),
            event=True,
            mesh=True,
            origin="internal",
        )

        return EmptyOutput()

    @method_contract(
        method_id=STTMethods.STOP_LISTENING,
        summary="Stop listening for speech (server microphone)",
        input_model=STTStopListeningRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def _on_stop_listening(self, request: STTStopListeningRequest) -> EmptyOutput:
        """Handle stop listening command."""
        log_info("Received stop listening request")

        # Stop listening logic...

        return EmptyOutput()

    @method_contract(
        method_id=STTMethods.AUDIO,
        summary="Process raw audio chunk",
        input_model=STTAudioChunk,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def _on_audio_chunk(self, data: STTAudioChunk) -> None:
        """Handle audio chunk."""
        # Processing logic...
        pass

    @method_contract(
        method_id=STTMethods.CONTROL,
        summary="Handle STT coordinator control commands",
        input_model=STTCoordinatorControl,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="manage",
    )
    async def _on_control(self, data: STTCoordinatorControl) -> None:
        """Handle control commands.

        Args:
            data: Validated STTCoordinatorControl payload
        """
        action = data.action

        log_info(f"Control command: {action}")

        if action == "start_session":
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


# Export service and types
__all__ = [
    "STTCoordinatorService",
    "STTState",
    "STTSessionStarted",
    "STTSessionEnded",
    "STTUserSpeechCaptured",
    "STTCoordinatorControl",
]
