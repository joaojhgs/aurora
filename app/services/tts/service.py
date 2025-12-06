"""Text-to-Speech Service for Aurora's parallel architecture.

This service:
- Processes TTS requests
- Manages audio playback with RealtimeTTS
- Emits TTS lifecycle events
- Handles interruptions and queue management
"""

from __future__ import annotations

import asyncio
import os

from RealtimeTTS import PiperVoice, TextToAudioStream

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import Envelope, MessageBus
from app.services.tts.piper_engine import PiperEngine
from app.shared.config.interface import ConfigAPI
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.tts import (
    TTSControl,
    TTSError,
    TTSMethods,
    TTSModule,
    TTSRequest,
    TTSStatus,
)
from app.shared.contracts.registry import method_contract
from app.shared.messaging.models.tts_models import TTSError as TTSErrorEvent
from app.shared.messaging.models.tts_models import (
    TTSEvent,
    TTSPaused,
    TTSResumed,
    TTSStarted,
    TTSStopped,
)
from app.shared.services.base_service import BaseService

config_api = ConfigAPI()


# TODO: Implement volume control functions
def reduce_volume_except_current():
    """Placeholder for reducing system volume during TTS."""
    pass


def restore_volume_except_current():
    """Placeholder for restoring system volume after TTS."""
    pass


# Calculate project root: go up from app/services/tts/service.py -> app/services/tts -> app/services -> app -> project root
file_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


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
            module=TTSModule.NAME, summary="Text-to-Speech synthesis and playback service", capabilities=["speech_synthesis", "audio_playback"]
        )
        self._playing = False
        self._paused = False
        self._current_text: str | None = None
        self._current_request_id: str | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.stream = None  # Will be initialized in on_start()

    async def _get_model_paths(self):
        """Get model paths from env vars or config."""
        # Check environment variables first
        model_file = os.getenv("AURORA_TTS_MODEL_FILE_PATH")
        config_file = os.getenv("AURORA_TTS_MODEL_CONFIG_FILE_PATH")

        # Fall back to config if env vars not set
        if model_file is None:
            config_path = await config_api.aget("general.text_to_speech.model_file_path", "/voice_models/en_US-lessac-medium.onnx")
            # Ensure absolute path
            if os.path.isabs(config_path):
                model_file = config_path
            else:
                model_file = os.path.join(file_root, config_path.lstrip("/"))
        if config_file is None:
            config_path = await config_api.aget("general.text_to_speech.model_config_file_path", "/voice_models/en_US-lessac-medium.onnx.txt")
            # Ensure absolute path
            if os.path.isabs(config_path):
                config_file = config_path
            else:
                config_file = os.path.join(file_root, config_path.lstrip("/"))

        # Normalize paths to absolute
        model_file = os.path.abspath(model_file)
        if config_file:
            config_file = os.path.abspath(config_file)

        return model_file, config_file

    async def _initialize_engine(self) -> None:
        """Initialize the RealtimeTTS engine with Piper voice."""
        try:
            # Get voice model paths from env vars or config
            model_file, config_file = await self._get_model_paths()

            # Get sample rate for caching
            sample_rate = await config_api.aget("general.text_to_speech.model_sample_rate", 24000)

            # Create Piper voice
            voice = PiperVoice(model_file=model_file, config_file=config_file)

            # Create Piper engine with cached sample rate
            self.engine = PiperEngine(piper_path="piper", voice=voice, sample_rate=sample_rate)

            # Create audio stream with callbacks
            self.stream = TextToAudioStream(
                self.engine,
                frames_per_buffer=256,
                on_audio_stream_start=self._on_audio_start,
                on_audio_stream_stop=self._on_audio_stop,
            )

            log_info("TTS engine initialized successfully")

        except Exception as e:
            log_error(f"Failed to initialize TTS engine: {e}", exc_info=True)
            raise

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
                    origin="internal",
                ),
                self._loop,
            )

    async def on_start(self) -> None:
        """Start the TTS service."""
        log_info("Starting TTS service...")

        # Store event loop for callbacks
        self._loop = asyncio.get_event_loop()

        # Initialize TTS engine (needs async config access)
        await self._initialize_engine()

    async def on_stop(self) -> None:
        """Stop the TTS service."""
        log_info("Stopping TTS service...")
        self._playing = False

        # Stop any ongoing playback
        if hasattr(self, "stream"):
            self.stream.stop()

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading TTS service configuration (section: {config_section})")

        # If TTS config changed, reinitialize the engine
        if config_section is None or config_section == "general" or config_section == "text_to_speech":
            log_info("TTS configuration changed, reinitializing engine...")
            try:
                # Stop current playback if active
                if self._playing and hasattr(self, "stream"):
                    self.stream.stop()
                    self._playing = False

                # Reinitialize engine with new config
                self._initialize_engine()
                log_info("TTS engine reinitialized successfully")
            except Exception as e:
                log_error(f"Failed to reinitialize TTS engine: {e}", exc_info=True)
        else:
            log_debug(f"TTS service reloaded for section: {config_section}")

    @method_contract(
        method_id=TTSMethods.REQUEST, summary="Process text-to-speech request", input_model=TTSRequest, output_model=EmptyOutput, exposure="both"
    )
    async def _on_tts_request(self, request: TTSRequest) -> None:
        """Handle TTS request command.

        Args:
            request: TTSRequest command (payload already extracted by base_service wrapper)
        """
        try:
            log_info(f"TTS request: '{request.text}' (interrupt={request.interrupt})")

            # Handle interruption
            if request.interrupt and self._playing:
                log_info("Interrupting current TTS playback")
                await self._stop_playback("interrupted")

            # Generate unique ID for this request
            import uuid

            request_id = str(uuid.uuid4())

            # Start playback
            await self._play_text(request.text, request_id)

        except Exception as e:
            log_error(f"Error handling TTS request: {e}", exc_info=True)
            import uuid

            request_id = str(uuid.uuid4())
            await self.bus.publish(
                TTSMethods.ERROR,
                TTSError(request_id=request_id, error=str(e)),
                event=True,
                origin="internal",
            )

    @method_contract(
        method_id=TTSMethods.STOP, summary="Stop current TTS playback", input_model=EmptyInput, output_model=EmptyOutput, exposure="both"
    )
    async def _on_stop(self, request: EmptyInput) -> EmptyOutput:
        """Handle TTS stop command.

        Args:
            request: Empty input (payload already extracted by base_service wrapper)
        """
        try:
            log_info("TTS stop requested")
            await self._stop_playback("stopped")
            return EmptyOutput()
        except Exception as e:
            log_error(f"Error stopping TTS: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=TTSMethods.PAUSE, summary="Pause current TTS playback", input_model=EmptyInput, output_model=EmptyOutput, exposure="internal"
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
                    origin="internal",
                )
            return EmptyOutput()
        except Exception as e:
            log_error(f"Error pausing TTS: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=TTSMethods.RESUME, summary="Resume paused TTS playback", input_model=EmptyInput, output_model=EmptyOutput, exposure="internal"
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
                    origin="internal",
                )
            return EmptyOutput()
        except Exception as e:
            log_error(f"Error resuming TTS: {e}", exc_info=True)
            return EmptyOutput()

    async def _play_text(self, text: str, request_id: str) -> None:
        """Play text-to-speech audio using RealtimeTTS.

        Args:
            text: Text to speak
            request_id: Request ID for tracking
        """
        try:
            self._playing = True
            self._current_text = text
            self._current_request_id = request_id

            # Emit started event
            await self.bus.publish(
                TTSMethods.STARTED,
                TTSStarted(request_id=request_id, text=text),
                event=True,
                origin="internal",
            )

            # Feed text to stream and play asynchronously
            log_info(f"Playing TTS: {text[:50]}...")
            self.stream.feed(text)
            self.stream.play_async()

            # Note: Completion event will be emitted by _on_audio_stop callback
            # when the audio stream actually finishes playing

        except Exception as e:
            log_error(f"Error playing TTS: {e}", exc_info=True)
            self._playing = False
            self._current_text = None
            self._current_request_id = None
            raise

    async def _stop_playback(self, reason: str) -> None:
        """Stop current TTS playback.

        Args:
            reason: Reason for stopping
        """
        if self._playing:
            # Capture request_id before clearing state
            request_id = self._current_request_id

            # Stop audio stream
            self.stream.stop()

            self._playing = False
            self._paused = False
            self._current_text = None
            self._current_request_id = None

            await self.bus.publish(
                TTSMethods.STOPPED,
                TTSStopped(request_id=request_id, reason=reason),
                event=True,
                origin="internal",
            )
            log_info(f"TTS playback stopped: {reason}")
