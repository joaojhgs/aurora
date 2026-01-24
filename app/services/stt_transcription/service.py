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
import threading
import time
import wave
from collections import deque
from datetime import datetime
from enum import Enum

import numpy as np
import webrtcvad
from faster_whisper import WhisperModel

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
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.stt import (
    STTAudioChunk,
    STTControl,
    TranscribeAudioRequest,
    TranscribeAudioResponse,
    TranscriptionMethods,
    TranscriptionModule,
)
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService

config_api = ConfigAPI()


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

    def __init__(self):
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
        self._realtime_model: WhisperModel | None = None
        self._accurate_model: WhisperModel | None = None
        self._model_lock = threading.Lock()

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
        self._vad: webrtcvad.Vad | None = None
        self._vad_mode = VADMode.MEDIUM
        self._speech_segments: deque[bytes] = deque(maxlen=100)
        self._in_speech = False
        self._silence_chunks = 0
        self._min_silence_chunks = 10  # ~200ms of silence to end segment

        # Configuration (will be loaded in on_start)
        self._language = ""
        self._realtime_enabled = True
        self._accurate_enabled = True
        self._min_audio_length_ms = 500  # Minimum audio length to transcribe

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

        # Load configuration (async)
        self._language = await config_api.aget("general.speech_to_text.language", "")
        self._realtime_enabled = await config_api.aget(
            "general.speech_to_text.transcription.realtime_model.enabled", True
        )
        self._accurate_enabled = await config_api.aget(
            "general.speech_to_text.transcription.accurate_model.enabled", True
        )

        log_info("Starting transcription service...")
        self._running = True

        # Store event loop for callbacks
        self._loop = asyncio.get_event_loop()

        # Initialize VAD
        self._initialize_vad()

        # Load models
        await self._load_models()

        # Subscribe to audio stream
        self.bus.subscribe(AudioTopics.STREAM_MICROPHONE, self._on_audio_chunk)

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

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading TranscriptionService configuration: section={config_section}")
        # Reload transcription models if config changed
        if config_section is None or config_section in ["speech_to_text", "general"]:
            log_info("Reloading transcription models due to config change...")
            if self._realtime_model:
                del self._realtime_model
                self._realtime_model = None
            if self._accurate_model:
                del self._accurate_model
                self._accurate_model = None
            # Reload config and models
            self._language = await config_api.aget("general.speech_to_text.language", "")
            self._realtime_enabled = await config_api.aget(
                "general.speech_to_text.transcription.realtime_model.enabled", True
            )
            self._accurate_enabled = await config_api.aget(
                "general.speech_to_text.transcription.accurate_model.enabled", True
            )
            await self._load_models()
        log_info("TranscriptionService configuration reloaded")

    def _initialize_vad(self) -> None:
        """Initialize Voice Activity Detection."""
        try:
            self._vad = webrtcvad.Vad(self._vad_mode.value)
            log_info(f"VAD initialized (mode: {self._vad_mode.name})")
        except Exception as e:
            log_error(f"Failed to initialize VAD: {e}")
            self._vad = None

    async def _load_models(self) -> None:
        """Load Faster Whisper models."""
        log_info("Loading transcription models...")

        try:
            # Get model configuration
            accurate_model_size = await config_api.aget(
                "general.speech_to_text.transcription.accurate_model.model_size", "base"
            )
            realtime_model_size = await config_api.aget(
                "general.speech_to_text.transcription.realtime_model.model_size", "tiny"
            )
            # Use device from new config structure, with fallback to legacy hardware_acceleration
            realtime_device = await config_api.aget(
                "general.speech_to_text.transcription.realtime_model.device", None
            )
            accurate_device = await config_api.aget(
                "general.speech_to_text.transcription.accurate_model.device", None
            )
            if realtime_device is None or accurate_device is None:
                # Fallback to legacy hardware_acceleration setting
                legacy_device = get_use_hardware_acceleration("stt")
                realtime_device = realtime_device or legacy_device
                accurate_device = accurate_device or legacy_device
            accurate_compute_type = await config_api.aget(
                "general.speech_to_text.transcription.accurate_model.compute_type", "int8"
            )
            realtime_compute_type = await config_api.aget(
                "general.speech_to_text.transcription.realtime_model.compute_type", "int8"
            )
            download_root = "chat_models"  # Default download location

            # Load realtime model (fast, lower accuracy)
            if self._realtime_enabled:
                log_info(f"Loading realtime model ({realtime_model_size}) on {realtime_device}...")
                self._realtime_model = WhisperModel(
                    realtime_model_size,
                    device=realtime_device,
                    compute_type=realtime_compute_type,
                    download_root=download_root,
                )
                log_info(f"Realtime model loaded ({realtime_model_size})")

            # Load accurate model (slower, higher accuracy)
            if self._accurate_enabled:
                log_info(f"Loading accurate model ({accurate_model_size}) on {accurate_device}...")
                self._accurate_model = WhisperModel(
                    accurate_model_size,
                    device=accurate_device,
                    compute_type=accurate_compute_type,
                    download_root=download_root,
                )
                log_info(f"Accurate model loaded ({accurate_model_size})")

        except Exception as e:
            log_error(f"Failed to load models: {e}", exc_info=True)
            raise

    def _start_processing_thread(self) -> None:
        """Start the audio processing thread."""
        self._transcribing = True
        self._process_thread = threading.Thread(
            target=self._processing_loop, daemon=False, name="Transcription-Processor"
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
        model: WhisperModel,
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
            log_error(f"Transcription error ({transcription_type.value}): {e}", exc_info=True)
            self._emit_error(error_message=str(e), error_type="transcription_failed")

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
            self.bus.publish(TranscriptionMethods.RESULT, result), self._loop
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
            self.bus.publish(TranscriptionMethods.ERROR, error), self._loop
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

        # Store audio format if provided and not yet set
        if audio_format and self._audio_format is None:
            self._audio_format = audio_format
            log_info(
                f"Audio format set: {audio_format.sample_rate}Hz, {audio_format.channels}ch, {audio_format.bits_per_sample}bits"
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
    )
    async def _on_external_audio(self, chunk: STTAudioChunk) -> EmptyOutput:
        """Handle audio chunks from external API/WebRTC calls.

        Args:
            chunk: STTAudioChunk containing audio data

        Returns:
            EmptyOutput on success
        """
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

        return EmptyOutput()

    @method_contract(
        method_id=TranscriptionMethods.CONTROL,
        summary="Handle transcription control commands",
        input_model=STTControl,
        output_model=EmptyOutput,
        exposure="internal",
    )
    async def _on_control(self, envelope: Envelope) -> None:
        """Handle control commands.

        Args:
            envelope: Message envelope containing TranscriptionControl
        """
        control: TranscriptionControl = envelope.payload
        action = control.action

        log_info(f"Transcription control: {action}")

        if action == "pause":
            self._paused = True
        elif action == "resume":
            self._paused = False
            # Clear audio buffers when resuming to avoid processing stale audio
            with self._buffer_lock:
                self._audio_buffer.clear()
                self._speech_segments.clear()
            self._in_speech = False
            self._silence_chunks = 0
            log_info("Cleared audio buffers on resume")
        elif action == "set_language":
            if control.language:
                self._language = control.language
                log_info(f"Language set to: {self._language}")
        elif action == "enable_realtime" and control.enabled is not None:
            self._realtime_enabled = control.enabled
            log_info(f"Realtime transcription: {'enabled' if control.enabled else 'disabled'}")
        elif action == "enable_accurate" and control.enabled is not None:
            self._accurate_enabled = control.enabled
            log_info(f"Accurate transcription: {'enabled' if control.enabled else 'disabled'}")

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
                if self._accurate_model is None:
                    raise RuntimeError("Accurate model not loaded")
                model = self._accurate_model
                beam_size = 5
            else:
                if self._realtime_model is None:
                    raise RuntimeError("Realtime model not loaded")
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
            log_error(f"Transcription error: {e}", exc_info=True)
            raise


# Export service
__all__ = ["TranscriptionService"]
