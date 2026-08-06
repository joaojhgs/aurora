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
import shutil
import wave
from dataclasses import dataclass, field

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import Envelope
from app.services.tts.playback import create_realtime_piper_stream
from app.services.tts.providers.base import (
    TTSProvider,
    TTSProviderError,
    TTSSynthesisRequest as ProviderSynthesisRequest,
)
from app.services.tts.providers.piper import PiperTTSProvider, PiperVoiceConfig
from app.shared.config.interface import ConfigAPI
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import Tts
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.tts import (
    TTSAudioChunkEvent,
    TTSMethods,
    TTSModule,
    TTSRequest,
    TTSStopRequest,
    TTSStreamChunkRequest,
    TTSStreamEndRequest,
    TTSStreamStartRequest,
    TTSSynthesizeRequest,
    TTSSynthesizeResponse,
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

config_api = ConfigAPI()
_GLOBAL_TTS_STREAM_CLEAR = object()


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
        self._stream_states: dict[str, _TTSStreamState] = {}
        self._stream_state_lock = asyncio.Lock()
        self._provider: TTSProvider | None = None
        self.stream = None  # Will be initialized in on_start()

    async def _stop_provider_safely(self, provider: TTSProvider, context: str) -> None:
        """Stop a provider during cleanup without masking the original failure."""
        try:
            await provider.stop()
        except Exception as cleanup_error:
            log_error(
                f"Failed to stop TTS provider after {context}: {cleanup_error}", exc_info=True
            )

    async def _get_model_paths(self, tts_cfg: Tts | None = None) -> tuple[str, str | None]:
        """Get Piper model paths from canonical config with flat-key compatibility."""
        tts_cfg = tts_cfg or await config_api.aget(ConfigKeys.services.tts, Tts)
        piper_cfg = tts_cfg.providers.piper if tts_cfg.providers else None
        model_path = (
            piper_cfg.model_file_path
            if piper_cfg and piper_cfg.model_file_path
            else tts_cfg.model_file_path or "voice_models/en_US-lessac-medium.onnx"
        )
        config_path = (
            piper_cfg.model_config_file_path
            if piper_cfg and piper_cfg.model_config_file_path
            else tts_cfg.model_config_file_path or "voice_models/en_US-lessac-medium.onnx.txt"
        )
        model_file = resolve_path(model_path)
        config_file = resolve_path(config_path) if config_path else None
        return str(model_file), str(config_file) if config_file else None

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

    async def _build_runtime(self) -> tuple[TTSProvider, object, object]:
        """Build provider plus local playback stream without mutating current state."""
        tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
        if tts_cfg.provider not in (None, "piper"):
            raise TTSProviderError("unavailable", "Configured TTS provider is unavailable")

        model_file, config_file = await self._get_model_paths(tts_cfg)
        piper_path = self._resolve_piper_executable(tts_cfg)
        piper_cfg = tts_cfg.providers.piper if tts_cfg.providers else None
        sample_rate = (
            piper_cfg.model_sample_rate
            if piper_cfg and piper_cfg.model_sample_rate is not None
            else tts_cfg.model_sample_rate
            if tts_cfg.model_sample_rate is not None
            else 22050
        )
        voice_id = tts_cfg.default_voice_id or "default"
        voice_config = PiperVoiceConfig(
            voice_id=voice_id,
            model_file=model_file,
            config_file=config_file,
            display_name="Piper",
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
                    mesh=False,
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
        await self._clear_tts_streams("service_stopped")

        # Stop any ongoing playback
        if hasattr(self, "stream"):
            self.stream.stop()
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
                    old_stream.stop()
                    self._playing = False
                    self._paused = False
                    self._current_text = None
                    self._current_request_id = None

                self._provider = new_provider
                self.engine = new_engine
                self.stream = new_stream
                new_runtime_installed = True
                if old_provider is not None:
                    await old_provider.stop()
                log_info("TTS engine reinitialized successfully")
            except Exception as e:
                if new_provider is not None and not new_runtime_installed:
                    await self._stop_provider_safely(new_provider, "reload pre-swap failure")
                log_error(f"Failed to reinitialize TTS engine: {e}", exc_info=True)
        else:
            log_debug(f"TTS service reloaded for section: {config_section}")

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
            log_info(f"TTS request: '{request.text}' (interrupt={request.interrupt})")

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
            log_error(f"Error handling TTS request: {e}", exc_info=True)
            import uuid

            request_id = str(uuid.uuid4())
            await self.bus.publish(
                TTSMethods.ERROR,
                TTSErrorEvent(request_id=request_id, error=str(e)),
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
            log_error(f"Error starting TTS stream: {e}", exc_info=True)
            await self._publish_stream_error(
                request.stream_id,
                str(e),
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
            log_error(f"Error processing TTS stream chunk: {e}", exc_info=True)
            await self._publish_stream_error(
                request.stream_id,
                str(e),
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
            log_error(f"Error ending TTS stream: {e}", exc_info=True)
            await self._publish_stream_error(
                request.stream_id,
                str(e),
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
            log_error(f"Error stopping TTS: {e}", exc_info=True)
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
            log_error(f"Error pausing TTS: {e}", exc_info=True)
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
            log_error(f"Error resuming TTS: {e}", exc_info=True)
            return EmptyOutput()

    async def _ensure_voice_available(self, voice: str | None) -> None:
        """Validate a logical voice against the active provider."""
        if voice is None:
            return
        if self._provider is None:
            raise RuntimeError("TTS provider not initialized")
        voices = await self._provider.list_voices()
        if not any(item.voice_id == voice and item.ready for item in voices):
            raise RuntimeError("Requested voice is unavailable")

    async def _play_text(
        self, text: str, request_id: str, *, voice: str | None = None, speed: float = 1.0
    ) -> None:
        """Play text-to-speech audio using RealtimeTTS.

        Args:
            text: Text to speak
            request_id: Request ID for tracking
        """
        try:
            await self._ensure_voice_available(voice)
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
            raise RuntimeError("TTS provider not initialized")
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
            raise RuntimeError(str(exc)) from exc
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
            log_info(f"TTS synthesize request: '{request.text[:50]}...' format={request.format}")

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
            log_error(f"Error in TTS synthesis: {e}", exc_info=True)
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
                        audio_sequence = state.next_audio_sequence
                        audio_format = state.audio_format
                        play_on_server = state.play_on_server
                        correlation_id = state.correlation_id
                        caller_peer_id = state.caller_peer_id
                        principal_id = state.principal_id
                        stream_epoch = state
                        state.next_text_sequence += 1
                        state.next_audio_sequence += 1
                        final_event = None

                if final_event is not None:
                    await self._publish_audio_chunk(
                        final_event,
                        caller_peer_id=final_event_context[0],
                        principal_id=final_event_context[1],
                        correlation_id=final_event.correlation_id,
                    )
                    return

                if text_sequence is None or text is None or audio_sequence is None:
                    return

                audio_bytes, sample_rate = await self._synthesize_to_bytes(
                    text,
                    request_id=f"{stream_id}:{text_sequence}",
                    voice=stream_epoch.voice,
                    sample_rate=stream_epoch.requested_sample_rate,
                    speed=stream_epoch.speed,
                )
                output_bytes, duration_ms = self._format_audio_bytes(
                    audio_bytes, sample_rate, audio_format
                )
                async with self._stream_state_lock:
                    state = self._stream_states.get(stream_id)
                    if state is not stream_epoch:
                        return
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
                    await self._play_stream_text(
                        text, stream_id, voice=stream_epoch.voice, speed=stream_epoch.speed
                    )
        finally:
            async with self._stream_state_lock:
                state = self._stream_states.get(stream_id)
                if state is not None:
                    state.draining = False

    async def _play_stream_text(
        self, text: str, stream_id: str, *, voice: str | None = None, speed: float = 1.0
    ) -> None:
        """Feed streamed text to the local server audio output without restarting playback."""
        if not text.strip():
            return
        await self._ensure_voice_available(voice)
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
            state.end_reason = reason
            await self._publish_audio_chunk(
                self._build_final_audio_chunk_event(state),
                caller_peer_id=state.caller_peer_id,
                principal_id=state.principal_id,
                correlation_id=state.correlation_id,
            )

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
