"""Audio Input Service for Aurora.

This service captures audio from the microphone and streams it through
the message bus as AudioChunk events.

Features:
- PyAudio microphone capture
- Device enumeration and selection
- Configurable sample rate and chunk size
- Publishes AudioChunk events to Audio.Stream.Microphone topic
- Supports start/stop/pause/resume control
"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from datetime import datetime

import pyaudio
from pydantic import Field

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import (
    AudioChunk,
    AudioEncoding,
    AudioFormat,
    AudioInputTopics,
    AudioStreamStarted,
    AudioStreamStopped,
    AudioTopics,
    Command,
    Envelope,
    MessageBus,
)

logger = logging.getLogger(__name__)


# Control messages
class AudioInputControl(Command):
    """Command to control audio input."""

    action: str = Field(description="Action to perform: 'start', 'stop', 'pause', 'resume'")
    device_index: int | None = Field(default=None, description="Specific audio device index to use (None for default)")


class AudioInputService:
    """Audio Input service for microphone capture.

    Responsibilities:
    - Capture audio from microphone using PyAudio
    - Stream audio chunks to message bus
    - Handle device selection and configuration
    - Manage audio input lifecycle (start/stop/pause/resume)
    """

    def __init__(self, bus: MessageBus):
        """Initialize audio input service.

        Args:
            bus: MessageBus instance for communication
        """
        self.bus = bus
        self._running = False
        self._capturing = False
        self._paused = False

        # PyAudio resources
        self._pyaudio: pyaudio.PyAudio | None = None
        self._stream: pyaudio.Stream | None = None
        self._capture_thread: threading.Thread | None = None

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

        log_info("AudioInputService initialized")

    async def start(self) -> None:
        """Start the audio input service."""
        log_info("Starting AudioInputService...")

        # Load configuration
        self._load_config()

        # Store event loop
        self._loop = asyncio.get_event_loop()

        # Initialize PyAudio
        self._initialize_pyaudio()

        # Subscribe to control commands using typed topics
        self.bus.subscribe(AudioInputTopics.CONTROL, self._on_control)

        self._running = True

        # Automatically start capturing if configured
        # Note: auto_start_audio is not in new config schema, defaulting to True
        if config_manager.get("general.speech_to_text.audio_input.auto_start", True):
            await self._start_capture()

        log_info("✅ AudioInputService started")

    async def stop(self) -> None:
        """Stop the audio input service."""
        log_info("Stopping AudioInputService...")

        # Stop capturing if active
        if self._capturing:
            await self._stop_capture()

        self._running = False

        # Cleanup PyAudio resources
        if self._pyaudio:
            self._pyaudio.terminate()
            self._pyaudio = None

        log_info("✅ AudioInputService stopped")

    def _load_config(self) -> None:
        """Load configuration from config manager."""
        self._sample_rate = config_manager.get("general.speech_to_text.audio_input.sample_rate", 16000)
        self._channels = config_manager.get("general.speech_to_text.audio_input.channels", 1)
        self._chunk_size = config_manager.get("general.speech_to_text.audio_input.chunk_size", 1024)
        self._device_index = config_manager.get("general.speech_to_text.audio_input.device_index", None)

        log_info("Audio input configuration:")
        log_info(f"  Sample rate: {self._sample_rate} Hz")
        log_info(f"  Channels: {self._channels}")
        log_info(f"  Chunk size: {self._chunk_size} frames")
        log_info(f"  Device index: {self._device_index or 'default'}")

    def _initialize_pyaudio(self) -> None:
        """Initialize PyAudio and enumerate devices."""
        try:
            self._pyaudio = pyaudio.PyAudio()

            # Log available devices
            log_info("Available audio input devices:")
            for i in range(self._pyaudio.get_device_count()):
                try:
                    info = self._pyaudio.get_device_info_by_index(i)
                    if info.get("maxInputChannels", 0) > 0:
                        log_info(
                            f"  [{i}] {info.get('name')} " f"(channels: {info.get('maxInputChannels')}, " f"rate: {info.get('defaultSampleRate')})"
                        )
                except Exception as e:
                    log_debug(f"Could not get info for device {i}: {e}")

            # If no device index specified, use default
            if self._device_index is None:
                default_device = self._pyaudio.get_default_input_device_info()
                self._device_index = default_device["index"]
                log_info(f"Using default input device: {default_device['name']}")

        except Exception as e:
            log_error(f"Failed to initialize PyAudio: {e}", exc_info=True)
            raise

    async def _start_capture(self) -> None:
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
                priority=10,
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
            self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True, name="AudioCapture")
            self._capture_thread.start()

            log_info(f"✅ Audio capture started (stream_id: {self._stream_id})")

        except Exception as e:
            log_error(f"Failed to start audio capture: {e}", exc_info=True)
            raise

    async def _stop_capture(self, reason: str = "user_request") -> None:
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
                    priority=10,
                ),
                self._loop,
            )

        log_info(f"✅ Audio capture stopped ({self._total_chunks} chunks)")

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
                                priority=20,  # Medium priority
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

    async def _on_control(self, env: Envelope) -> None:
        """Handle audio input control commands.

        Args:
            env: Message envelope containing AudioInputControl
        """
        try:
            cmd: AudioInputControl = env.payload
            action = cmd.action.lower()

            if action == "start":
                if cmd.device_index is not None:
                    self._device_index = cmd.device_index
                await self._start_capture()

            elif action == "stop":
                await self._stop_capture(reason="control_command")

            elif action == "pause":
                self._paused = True
                log_info("Audio capture paused")

            elif action == "resume":
                self._paused = False
                log_info("Audio capture resumed")

            else:
                log_warning(f"Unknown audio input control action: {action}")

        except Exception as e:
            log_error(f"Error handling control command: {e}", exc_info=True)
