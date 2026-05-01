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
import io
import os
import subprocess
import tempfile
import wave

from RealtimeTTS import PiperVoice, TextToAudioStream

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import Envelope, MessageBus
from app.services.tts.piper_engine import PiperEngine
from app.shared.config.interface import ConfigAPI
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import Tts
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.tts import (
    TTSControl,
    TTSError,
    TTSMethods,
    TTSModule,
    TTSRequest,
    TTSStatus,
    TTSSynthesizeRequest,
    TTSSynthesizeResponse,
)
from app.shared.contracts.registry import method_contract
from app.shared.messaging.models.tts_models import (
    TTSError as TTSErrorEvent,
    TTSEvent,
    TTSPaused,
    TTSResumed,
    TTSStarted,
    TTSStopped,
)
from app.shared.path_utils import resolve_path
from app.shared.services.base_service import BaseService

config_api = ConfigAPI()


# TODO: Implement volume control functions
def reduce_volume_except_current():
    """Placeholder for reducing system volume during TTS."""
    pass


def restore_volume_except_current():
    """Placeholder for restoring system volume after TTS."""
    pass


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
        self.stream = None  # Will be initialized in on_start()

    async def _get_model_paths(self):
        """Get model paths from env vars or config."""
        # Check environment variables first
        model_file_env = os.getenv("AURORA_TTS_MODEL_FILE_PATH")
        config_file_env = os.getenv("AURORA_TTS_MODEL_CONFIG_FILE_PATH")

        # Fall back to config if env vars not set
        if model_file_env is None:
            tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
            config_path = tts_cfg.model_file_path or "voice_models/en_US-lessac-medium.onnx"
            model_file = resolve_path(config_path)
        else:
            model_file = resolve_path(model_file_env)

        if config_file_env is None:
            tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
            config_path = (
                tts_cfg.model_config_file_path or "voice_models/en_US-lessac-medium.onnx.txt"
            )
            config_file = resolve_path(config_path) if config_path else None
        else:
            config_file = resolve_path(config_file_env) if config_file_env else None

        return str(model_file), str(config_file) if config_file else None

    async def _initialize_engine(self) -> None:
        """Initialize the RealtimeTTS engine with Piper voice."""
        try:
            # Get voice model paths from env vars or config
            model_file, config_file = await self._get_model_paths()

            # Get sample rate for caching
            tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
            sample_rate = (
                tts_cfg.model_sample_rate if tts_cfg.model_sample_rate is not None else 22050
            )

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
                    mesh=True,
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
        if (
            config_section is None
            or config_section == "services"
            or config_section == "services.tts"
        ):
            log_info("TTS configuration changed, reinitializing engine...")
            try:
                # Stop current playback if active
                if self._playing and hasattr(self, "stream"):
                    self.stream.stop()
                    self._playing = False

                # Reinitialize engine with new config
                await self._initialize_engine()
                log_info("TTS engine reinitialized successfully")
            except Exception as e:
                log_error(f"Failed to reinitialize TTS engine: {e}", exc_info=True)
        else:
            log_debug(f"TTS service reloaded for section: {config_section}")

    @method_contract(
        method_id=TTSMethods.REQUEST,
        summary="Process text-to-speech request (plays on server)",
        input_model=TTSRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def _on_tts_request(self, request: TTSRequest) -> EmptyOutput:
        """Handle TTS request command.

        Args:
            request: TTSRequest command (payload already extracted by base_service wrapper)

        Returns:
            EmptyOutput on success
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

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error handling TTS request: {e}", exc_info=True)
            import uuid

            request_id = str(uuid.uuid4())
            await self.bus.publish(
                TTSMethods.ERROR,
                TTSError(request_id=request_id, error=str(e)),
                event=True,
                mesh=True,
                origin="internal",
            )
            return EmptyOutput()

    @method_contract(
        method_id=TTSMethods.STOP,
        summary="Stop current TTS playback (server audio)",
        input_model=EmptyInput,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
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
        method_id=TTSMethods.PAUSE,
        summary="Pause current TTS playback",
        input_model=EmptyInput,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
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
                    mesh=True,
                    origin="internal",
                )
            return EmptyOutput()
        except Exception as e:
            log_error(f"Error pausing TTS: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=TTSMethods.RESUME,
        summary="Resume paused TTS playback",
        input_model=EmptyInput,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
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
                    mesh=True,
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
                mesh=True,
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
                mesh=True,
                origin="internal",
            )
            log_info(f"TTS playback stopped: {reason}")

    async def _synthesize_to_bytes(self, text: str) -> tuple[bytes, int]:
        """Synthesize text to audio bytes without playing.

        Args:
            text: Text to synthesize

        Returns:
            Tuple of (audio_bytes, sample_rate)
        """
        if not hasattr(self, "engine") or self.engine is None:
            raise RuntimeError("TTS engine not initialized")

        # Get voice model paths
        model_file, config_file = await self._get_model_paths()

        # Build the piper command
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_wav_file:
            output_wav_path = tmp_wav_file.name

        try:
            # Use absolute paths
            model_file_abs = (
                os.path.abspath(model_file) if not os.path.isabs(model_file) else model_file
            )

            cmd_list = [self.engine.piper_path, "-m", model_file_abs, "-f", output_wav_path]

            # Add config file if available
            if config_file:
                config_file_abs = (
                    os.path.abspath(config_file) if not os.path.isabs(config_file) else config_file
                )
                if os.path.exists(config_file_abs):
                    cmd_list.extend(["-c", config_file_abs])

            # Add CUDA if configured
            if hasattr(self.engine, "_use_cuda") and self.engine._use_cuda == "cuda":
                cmd_list.extend(["--cuda"])

            log_debug(f"Synthesizing with piper: {cmd_list}")

            # Run piper
            subprocess.run(
                cmd_list,
                input=text.encode("utf-8"),
                capture_output=True,
                check=True,
                shell=False,
            )

            # Read the synthesized WAV file
            with wave.open(output_wav_path, "rb") as wf:
                sample_rate = wf.getframerate()
                audio_data = wf.readframes(wf.getnframes())

            return audio_data, sample_rate

        finally:
            # Clean up temp file
            if os.path.isfile(output_wav_path):
                os.remove(output_wav_path)

    @method_contract(
        method_id=TTSMethods.SYNTHESIZE,
        summary="Synthesize text to audio and return audio data",
        input_model=TTSSynthesizeRequest,
        output_model=TTSSynthesizeResponse,
        exposure="both",
        method_type="use",
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
            log_info(f"TTS synthesize request: '{request.text[:50]}...' format={request.format}")

            # Synthesize audio
            audio_bytes, sample_rate = await self._synthesize_to_bytes(request.text)

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

        except subprocess.CalledProcessError as e:
            error_msg = f"Piper synthesis failed: {e.stderr.decode('utf-8', errors='replace')}"
            log_error(error_msg)
            raise RuntimeError(error_msg) from e
        except Exception as e:
            log_error(f"Error in TTS synthesis: {e}", exc_info=True)
            raise
