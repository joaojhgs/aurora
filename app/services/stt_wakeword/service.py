# filepath: app/stt_wakeword/service.py
"""Wake Word Detection Service for Aurora.

This service listens for audio chunks on the message bus and detects wake words
using either OpenWakeWord or Porcupine backends.

Features:
- Subscribes to audio stream channels
- Processes audio chunks for wake word detection
- Emits WakeWordDetected events when wake word is found
- Supports multiple wake word backends (OpenWakeWord, Porcupine)
- Independent from transcription service
"""

from __future__ import annotations

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import (
    AudioChunk,
    AudioFormat,
    AudioTopics,
    Envelope,
    MessageBus,
)
from app.messaging.priority_helpers import get_interactive_priority
from app.services.stt_wakeword.backends import (
    OpenWakeWordBackend,
    PorcupineBackend,
    WakeWordBackend,
)
from app.shared.config.interface import ConfigAPI
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.stt import (
    STTAudioChunk,
    WakewordControl,
    WakeWordMethods,
    WakeWordModule,
)
from app.shared.contracts.registry import method_contract
from app.shared.messaging.models.stt_wakeword_models import (
    WakeWordBackendType,
    WakeWordControl as WakeWordControlEvent,  # Rename to avoid conflict
    WakeWordDetected,
    WakeWordTimeout,
)
from app.shared.services.base_service import BaseService

config_api = ConfigAPI()


class WakeWordService(BaseService):
    """Wake Word Detection service.

    Responsibilities:
    - Listen to audio stream events
    - Process audio chunks for wake word detection
    - Emit WakeWordDetected events
    - Support multiple backends (OpenWakeWord, Porcupine)
    - Handle wake word timeout logic
    """

    def __init__(self):
        """Initialize wake word service."""
        super().__init__(
            module=WakeWordModule.NAME,
            summary="Wake word detection service",
            capabilities=["wake_word_detection", "openwakeword", "porcupine"],
        )
        self._running = False
        self._running = False
        self._enabled = False
        self._backend: WakeWordBackend | None = None
        self._backend_type: WakeWordBackendType | None = None

        # Configuration
        self._wake_words: list[str] = []
        self._sensitivity = 0.5
        self._model_paths: list[str] = []

        # State tracking
        self._current_stream_id: str | None = None
        self._current_source: str | None = None
        self._audio_format: AudioFormat | None = None

        log_info("WakeWordService initialized")

    async def on_start(self) -> None:
        """Start the wake word service."""
        log_info("Starting WakeWordService...")

        # Load configuration
        await self._load_config()

        # Initialize wake word backend
        await self._initialize_backend()

        # Subscribe to audio stream (subscribe is not async)
        self.bus.subscribe(AudioTopics.STREAM_MICROPHONE, self._on_audio_chunk)

        self._running = True
        self._enabled = True

        log_info(f"WakeWordService started (backend: {self._backend_type.value})")

    async def on_stop(self) -> None:
        """Stop the wake word service."""
        log_info("Stopping WakeWordService...")

        self._running = False
        self._enabled = False

        # Cleanup backend resources
        if self._backend:
            await self._backend.cleanup()
            self._backend = None

        log_info("WakeWordService stopped")

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading WakeWordService configuration: section={config_section}")
        # Reload wake word backend if config changed
        if config_section is None or config_section in ["speech_to_text", "general"]:
            log_info("Reloading wake word backend due to config change...")
            if self._backend:
                await self._backend.cleanup()
                self._backend = None
            await self._load_config()
            await self._initialize_backend()
        log_info("WakeWordService configuration reloaded")

    async def _load_config(self) -> None:
        """Load configuration from config manager."""
        import os

        # Backend configuration
        backend_str = await config_api.aget("general.speech_to_text.wake_word.backend", "oww")
        self._backend_type = WakeWordBackendType(backend_str)

        # Wake word configuration
        self._sensitivity = await config_api.aget("general.speech_to_text.wake_word.threshold", 0.5)

        # Check environment variable first
        model_path = os.getenv("AURORA_WAKE_WORD_MODEL_PATH")

        # Fall back to config if env var not set
        if model_path is None:
            model_path = await config_api.aget(
                "general.speech_to_text.wake_word.model_path", "voice_models/jarvis.onnx"
            )

        # Convert model path to list if it's a string or None
        # Support comma-separated paths from env var
        if model_path is None:
            self._model_paths = ["voice_models/jarvis.onnx"]
        elif isinstance(model_path, str):
            # Split by comma if multiple paths provided
            if "," in model_path:
                self._model_paths = [p.strip() for p in model_path.split(",")]
            else:
                self._model_paths = [model_path]
        else:
            self._model_paths = model_path

        # Extract wake word names from model paths
        self._wake_words = []
        for path in self._model_paths:
            # Extract filename without extension as wake word name
            name = path.split("/")[-1].replace(".onnx", "").replace(".ppn", "")
            self._wake_words.append(name)

        log_info("Wake word configuration loaded:")
        log_info(f"  Backend: {self._backend_type.value}")
        log_info(f"  Wake words: {self._wake_words}")
        log_info(f"  Sensitivity: {self._sensitivity}")

    async def _initialize_backend(self) -> None:
        """Initialize the wake word detection backend."""
        log_info(f"Initializing wake word backend: {self._backend_type.value}")

        if self._backend_type == WakeWordBackendType.OPENWAKEWORD:
            self._backend = OpenWakeWordBackend(
                model_paths=self._model_paths,
                sensitivity=self._sensitivity,
                wake_words=self._wake_words,
            )
        elif self._backend_type == WakeWordBackendType.PORCUPINE:
            self._backend = PorcupineBackend(
                model_paths=self._model_paths,
                sensitivity=self._sensitivity,
                wake_words=self._wake_words,
            )
        else:
            raise ValueError(f"Unknown wake word backend: {self._backend_type}")

        await self._backend.initialize()
        log_info("Wake word backend initialized")

    async def _process_audio_data(
        self,
        data: bytes,
        stream_id: str = "default",
        source: str = "unknown",
        timestamp: float | None = None,
    ) -> None:
        """Process raw audio data for wake word detection.

        Args:
            data: Raw audio bytes
            stream_id: ID of the audio stream
            source: Source of the audio (e.g. "microphone")
            timestamp: Timestamp of the audio chunk
        """
        if not self._enabled or not self._backend:
            return

        try:
            # Run detection
            result = await self._backend.detect(data)

            if result.detected:
                log_info(
                    f"Wake word detected! (index: {result.wake_word_index}, conf: {result.confidence:.2f})"
                )

                # Emit event
                event = WakeWordDetected(
                    wake_word=(
                        self._wake_words[result.wake_word_index]
                        if result.wake_word_index >= 0
                        and result.wake_word_index < len(self._wake_words)
                        else "unknown"
                    ),
                    confidence=result.confidence,
                    source=source,
                    stream_id=stream_id,
                    timestamp=timestamp or 0.0,
                    backend=self._backend_type,
                    metadata={
                        "model": (
                            self._model_paths[result.wake_word_index]
                            if result.wake_word_index >= 0
                            and result.wake_word_index < len(self._model_paths)
                            else "unknown"
                        )
                    },
                )

                await self.bus.publish(WakeWordMethods.DETECTED, event)

        except Exception as e:
            log_error(f"Error in wake word detection: {e}", exc_info=True)

    async def _on_audio_chunk(self, env: Envelope) -> None:
        """Handle incoming audio chunks from internal bus.

        Args:
            env: Message envelope containing AudioChunk
        """
        chunk: AudioChunk = env.payload
        await self._process_audio_data(
            chunk.data, stream_id=chunk.stream_id, source=chunk.source, timestamp=chunk.timestamp
        )

    @method_contract(
        method_id=WakeWordMethods.PROCESS_AUDIO,
        summary="Process external audio chunk for wake word detection",
        input_model=STTAudioChunk,
        output_model=EmptyOutput,
        exposure="external",
    )
    async def _on_external_audio(self, envelope: Envelope) -> None:
        """Handle audio chunks from external API/WebRTC calls.

        Args:
            envelope: Message envelope containing STTAudioChunk
        """
        chunk: STTAudioChunk = envelope.payload
        import time

        await self._process_audio_data(
            chunk.data,
            stream_id="external",
            source="external",
            timestamp=time.time(),  # TODO: Should come from envelope or chunk?
        )

    async def _process_audio_chunk(self, chunk: AudioChunk) -> None:
        """Process an audio chunk for wake word detection.

        Args:
            chunk: AudioChunk containing audio data
        """
        try:
            # Detect wake word using configured backend
            detection_result = await self._backend.detect(chunk.data)

            # If wake word detected, emit event
            if detection_result.detected:
                wake_word = self._wake_words[detection_result.wake_word_index]

                await self.bus.publish(
                    WakeWordMethods.DETECTED,
                    WakeWordDetected(
                        wake_word=wake_word,
                        confidence=detection_result.confidence,
                        source=chunk.source,
                        stream_id=chunk.stream_id,
                        backend=self._backend_type,
                    ),
                    event=True,
                    priority=get_interactive_priority(),  # High priority for wake word detection
                )

        except Exception as e:
            log_error(f"Error detecting wake word: {e}", exc_info=True)

    @method_contract(
        method_id=WakeWordMethods.CONTROL,
        summary="Handle wake word control commands",
        input_model=WakewordControl,
        output_model=EmptyOutput,
        exposure="internal",
    )
    async def _on_control(self, env: Envelope) -> None:
        """Handle wake word control commands.

        Args:
            env: Message envelope containing WakeWordControl
        """
        try:
            cmd: WakewordControl = env.payload
            action = cmd.action.lower()

            if action == "start":
                self._enabled = True
                log_info("Wake word detection started")

            elif action == "stop":
                self._enabled = False
                log_info("Wake word detection stopped")

            elif action == "pause":
                self._enabled = False
                log_info("Wake word detection paused")

            elif action == "resume":
                self._enabled = True
                log_info("Wake word detection resumed")

            else:
                log_warning(f"Unknown wake word control action: {action}")

        except Exception as e:
            log_error(f"Error handling control command: {e}", exc_info=True)
