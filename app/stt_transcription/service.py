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
import logging
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
import struct
import threading
import time
from collections import deque
from datetime import datetime
from enum import Enum
from typing import Deque, Optional

import numpy as np
import torch
import webrtcvad
from faster_whisper import WhisperModel
from pydantic import Field

from app.config.config_manager import config_manager
from app.helpers.getUseHardwareAcceleration import getUseHardwareAcceleration
from app.messaging import (
    AudioChunk,
    AudioFormat,
    AudioTopics,
    Envelope,
    MessageBus,
    TranscriptionControl,
    TranscriptionError,
    TranscriptionResult,
    TranscriptionTopics,
    TranscriptionType,
)

logger = logging.getLogger(__name__)


class VADMode(Enum):
    """Voice Activity Detection aggressiveness modes."""
    QUALITY = 0  # Least aggressive (best quality, may include more silence)
    LOW = 1      # Low aggressiveness
    MEDIUM = 2   # Medium aggressiveness  
    AGGRESSIVE = 3  # Most aggressive (best latency, may cut off speech)


class TranscriptionService:
    """Transcription service for speech-to-text.
    
    Responsibilities:
    - Subscribe to audio stream topics
    - Buffer and process audio chunks
    - Detect speech using VAD
    - Transcribe speech segments using Faster Whisper
    - Support both realtime (fast) and accurate (slow) models
    - Emit TranscriptionResult events
    """
    
    def __init__(self, bus: MessageBus):
        """Initialize transcription service.
        
        Args:
            bus: MessageBus instance for communication
        """
        self.bus = bus
        self._running = False
        self._transcribing = False
        self._paused = False
        
        # Models
        self._realtime_model: Optional[WhisperModel] = None
        self._accurate_model: Optional[WhisperModel] = None
        self._model_lock = threading.Lock()
        
        # Audio buffering
        self._audio_buffer: Deque[bytes] = deque(maxlen=1000)  # ~10 seconds at 16kHz
        self._audio_format: Optional[AudioFormat] = None
        self._buffer_lock = threading.Lock()
        
        # Track current audio source and stream
        self._current_source: str = "microphone"  # Default to microphone
        self._current_stream_id: str = "default"  # Default stream ID
        
        # VAD for speech detection
        self._vad: Optional[webrtcvad.Vad] = None
        self._vad_mode = VADMode.MEDIUM
        self._speech_segments: Deque[bytes] = deque(maxlen=100)
        self._in_speech = False
        self._silence_chunks = 0
        self._min_silence_chunks = 10  # ~200ms of silence to end segment
        
        # Configuration
        self._language = config_manager.get("general.speech_to_text.language", "")
        self._realtime_enabled = config_manager.get("general.speech_to_text.transcription.realtime_model.enabled", True)
        self._accurate_enabled = config_manager.get("general.speech_to_text.transcription.accurate_model.enabled", True)
        self._min_audio_length_ms = 500  # Minimum audio length to transcribe
        
        # Processing thread
        self._process_thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        
        # Statistics
        self._chunks_received = 0
        self._transcriptions_done = 0
        
    async def start(self) -> None:
        """Start the transcription service."""
        if self._running:
            log_warning("Transcription service already running")
            return
            
        log_info("Starting transcription service...")
        self._running = True
        
        # Store event loop for callbacks
        self._loop = asyncio.get_event_loop()
        
        # Initialize VAD
        self._initialize_vad()
        
        # Load models
        await self._load_models()
        
        # Subscribe to audio streams and control commands
        self.bus.subscribe(AudioTopics.STREAM_MICROPHONE, self._on_audio_chunk)
        self.bus.subscribe(AudioTopics.STREAM_WEBSOCKET, self._on_audio_chunk)
        self.bus.subscribe(AudioTopics.STREAM_FILE, self._on_audio_chunk)
        self.bus.subscribe(AudioTopics.STREAM_GENERIC, self._on_audio_chunk)
        self.bus.subscribe(TranscriptionTopics.CONTROL, self._on_control)
        
        # Start processing thread
        self._start_processing_thread()
        
        log_info("✅ Transcription service started")
        
    async def stop(self) -> None:
        """Stop the transcription service."""
        if not self._running:
            return
            
        log_info("Stopping transcription service...")
        self._running = False
        self._transcribing = False
        
        # Wait for processing thread to finish
        if self._process_thread and self._process_thread.is_alive():
            self._process_thread.join(timeout=5.0)
            
        log_info("✅ Transcription service stopped")
        
    def _initialize_vad(self) -> None:
        """Initialize Voice Activity Detection."""
        try:
            self._vad = webrtcvad.Vad(self._vad_mode.value)
            log_info(f"✅ VAD initialized (mode: {self._vad_mode.name})")
        except Exception as e:
            log_error(f"❌ Failed to initialize VAD: {e}")
            self._vad = None
            
    async def _load_models(self) -> None:
        """Load Faster Whisper models."""
        log_info("Loading transcription models...")
        
        try:
            # Get model configuration
            accurate_model_size = config_manager.get("general.speech_to_text.transcription.accurate_model.model_size", "base")
            realtime_model_size = config_manager.get("general.speech_to_text.transcription.realtime_model.model_size", "tiny")
            # Use device from new config structure, with fallback to legacy hardware_acceleration
            realtime_device = config_manager.get("general.speech_to_text.transcription.realtime_model.device", None)
            accurate_device = config_manager.get("general.speech_to_text.transcription.accurate_model.device", None)
            if realtime_device is None or accurate_device is None:
                # Fallback to legacy hardware_acceleration setting
                legacy_device = getUseHardwareAcceleration("stt")
                realtime_device = realtime_device or legacy_device
                accurate_device = accurate_device or legacy_device
            accurate_compute_type = config_manager.get("general.speech_to_text.transcription.accurate_model.compute_type", "int8")
            realtime_compute_type = config_manager.get("general.speech_to_text.transcription.realtime_model.compute_type", "int8")
            download_root = "chat_models"  # Default download location
            
            # Load realtime model (fast, lower accuracy)
            if self._realtime_enabled:
                log_info(f"Loading realtime model ({realtime_model_size}) on {realtime_device}...")
                self._realtime_model = WhisperModel(
                    realtime_model_size,
                    device=realtime_device,
                    compute_type=realtime_compute_type,
                    download_root=download_root
                )
                log_info(f"✅ Realtime model loaded ({realtime_model_size})")
                
            # Load accurate model (slower, higher accuracy)
            if self._accurate_enabled:
                log_info(f"Loading accurate model ({accurate_model_size}) on {accurate_device}...")
                self._accurate_model = WhisperModel(
                    accurate_model_size,
                    device=accurate_device,
                    compute_type=accurate_compute_type,
                    download_root=download_root
                )
                log_info(f"✅ Accurate model loaded ({accurate_model_size})")
                
        except Exception as e:
            log_error(f"❌ Failed to load models: {e}", exc_info=True)
            raise
            
    def _start_processing_thread(self) -> None:
        """Start the audio processing thread."""
        self._transcribing = True
        self._process_thread = threading.Thread(
            target=self._processing_loop,
            daemon=False,
            name="Transcription-Processor"
        )
        self._process_thread.start()
        log_info("✅ Processing thread started")
        
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
            audio_data = self._audio_buffer.popleft()
            
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
            frame = audio_data[:frame_size * 2]
            
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
            
        log_info(f"📝 Transcribing segment ({duration_ms:.0f}ms, {len(segment_data)} bytes)")
        
        # Convert to float32 numpy array
        audio_np = self._bytes_to_numpy(segment_data)
        
        # Transcribe with realtime model (fast)
        if self._realtime_enabled and self._realtime_model:
            self._transcribe_with_model(
                audio_np,
                self._realtime_model,
                TranscriptionType.REALTIME,
                duration_ms
            )
            
        # Transcribe with accurate model (slow)
        if self._accurate_enabled and self._accurate_model:
            self._transcribe_with_model(
                audio_np,
                self._accurate_model,
                TranscriptionType.ACCURATE,
                duration_ms
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
        duration_ms: float
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
            log_info(f"✅ {transcription_type.value.capitalize()} transcription: '{text}' ({elapsed_ms:.0f}ms)")
            
            # Emit result
            self._emit_result(
                text=text,
                transcription_type=transcription_type,
                confidence=None,  # Faster Whisper doesn't provide per-segment confidence
                language=info.language if hasattr(info, 'language') else None,
                duration_ms=duration_ms,
                model=f"faster-whisper-{model.model.model_type if hasattr(model.model, 'model_type') else 'unknown'}"
            )
            
            self._transcriptions_done += 1
            
        except Exception as e:
            log_error(f"❌ Transcription error ({transcription_type.value}): {e}", exc_info=True)
            self._emit_error(
                error_message=str(e),
                error_type="transcription_failed"
            )
            
    def _emit_result(
        self,
        text: str,
        transcription_type: TranscriptionType,
        confidence: Optional[float],
        language: Optional[str],
        duration_ms: float,
        model: str
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
            model=model
        )
        
        # Emit to general result topic
        asyncio.run_coroutine_threadsafe(
            self.bus.publish(TranscriptionTopics.RESULT, result),
            self._loop
        )
        
        # Emit to specific topic based on type
        if transcription_type == TranscriptionType.REALTIME:
            topic = TranscriptionTopics.RESULT_REALTIME
        elif transcription_type == TranscriptionType.ACCURATE:
            topic = TranscriptionTopics.RESULT_ACCURATE
        else:
            topic = TranscriptionTopics.RESULT_FINAL
            
        asyncio.run_coroutine_threadsafe(
            self.bus.publish(topic, result),
            self._loop
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
            timestamp=datetime.now()
        )
        
        asyncio.run_coroutine_threadsafe(
            self.bus.publish(TranscriptionTopics.ERROR, error),
            self._loop
        )
        
    def _reset_speech_state(self) -> None:
        """Reset speech detection state after transcribing segment."""
        self._speech_segments.clear()
        self._in_speech = False
        self._silence_chunks = 0
        
    async def _on_audio_chunk(self, envelope: Envelope) -> None:
        """Handle incoming audio chunks.
        
        Args:
            envelope: Message envelope containing AudioChunk
        """
        if self._paused:
            return
            
        chunk: AudioChunk = envelope.payload
        
        # Track current audio source and stream ID
        self._current_source = chunk.source
        self._current_stream_id = chunk.stream_id
        
        # Store audio format if first chunk
        if self._audio_format is None:
            self._audio_format = chunk.format
            log_info(f"Audio format: {chunk.format.sample_rate}Hz, {chunk.format.channels}ch, {chunk.format.encoding.value}")
            log_info(f"Audio source: {self._current_source}, stream_id: {self._current_stream_id}")
            
        # Add to buffer
        with self._buffer_lock:
            self._audio_buffer.append(chunk.data)
            
        self._chunks_received += 1
        
        if self._chunks_received % 100 == 0:
            log_debug(f"Received {self._chunks_received} audio chunks, transcribed {self._transcriptions_done} segments")
            
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
        elif action == "enable_realtime":
            if control.enabled is not None:
                self._realtime_enabled = control.enabled
                log_info(f"Realtime transcription: {'enabled' if control.enabled else 'disabled'}")
        elif action == "enable_accurate":
            if control.enabled is not None:
                self._accurate_enabled = control.enabled
                log_info(f"Accurate transcription: {'enabled' if control.enabled else 'disabled'}")


# Export service
__all__ = ["TranscriptionService"]
