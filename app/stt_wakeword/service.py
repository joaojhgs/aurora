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

import asyncio
import logging
from typing import Optional

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import (
    AudioChunk,
    AudioFormat,
    AudioTopics,
    WakeWordTopics,
    Command,
    Envelope,
    Event,
    MessageBus,
)
from app.stt_wakeword.backends import (
    WakeWordBackend,
    OpenWakeWordBackend,
    PorcupineBackend,
)
from app.stt_wakeword.messages import (
    WakeWordBackendType,
    WakeWordDetected,
    WakeWordTimeout,
    WakeWordControl,
)

logger = logging.getLogger(__name__)


class WakeWordService:
    """Wake Word Detection service.
    
    Responsibilities:
    - Listen to audio stream events
    - Process audio chunks for wake word detection
    - Emit WakeWordDetected events
    - Support multiple backends (OpenWakeWord, Porcupine)
    - Handle wake word timeout logic
    """
    
    def __init__(self, bus: MessageBus):
        """Initialize wake word service.
        
        Args:
            bus: MessageBus instance for communication
        """
        self.bus = bus
        self._running = False
        self._enabled = False
        self._backend: Optional[WakeWordBackend] = None
        self._backend_type: Optional[WakeWordBackendType] = None
        
        # Configuration
        self._wake_words: list[str] = []
        self._sensitivity = 0.5
        self._model_paths: list[str] = []
        
        # State tracking
        self._current_stream_id: Optional[str] = None
        self._current_source: Optional[str] = None
        self._audio_format: Optional[AudioFormat] = None
        
        log_info("WakeWordService initialized")
    
    async def start(self) -> None:
        """Start the wake word service."""
        log_info("Starting WakeWordService...")
        
        # Load configuration
        self._load_config()
        
        # Initialize wake word backend
        await self._initialize_backend()
        
        # Subscribe to audio streams
        self.bus.subscribe(AudioTopics.STREAM_MICROPHONE, self._on_audio_chunk)
        self.bus.subscribe(AudioTopics.STREAM_GENERIC, self._on_audio_chunk)
        self.bus.subscribe(WakeWordTopics.CONTROL, self._on_control)
        
        self._running = True
        self._enabled = True
        
        log_info(f"✅ WakeWordService started (backend: {self._backend_type.value})")
    
    async def stop(self) -> None:
        """Stop the wake word service."""
        log_info("Stopping WakeWordService...")
        
        self._running = False
        self._enabled = False
        
        # Cleanup backend resources
        if self._backend:
            await self._backend.cleanup()
            self._backend = None
        
        log_info("✅ WakeWordService stopped")
    
    def _load_config(self) -> None:
        """Load configuration from config manager."""
        # Backend configuration
        backend_str = config_manager.get("general.speech_to_text.wake_word.backend", "oww")
        self._backend_type = WakeWordBackendType(backend_str)
        
        # Wake word configuration
        self._sensitivity = config_manager.get("general.speech_to_text.wake_word.threshold", 0.5)
        model_path = config_manager.get("general.speech_to_text.wake_word.model_path", "voice_models/jarvis.onnx")
        
        # Convert model path to list if it's a string or None
        if model_path is None:
            self._model_paths = ["voice_models/jarvis.onnx"]
        elif isinstance(model_path, str):
            self._model_paths = [model_path]
        else:
            self._model_paths = model_path
        
        # Extract wake word names from model paths
        self._wake_words = []
        for path in self._model_paths:
            # Extract filename without extension as wake word name
            name = path.split("/")[-1].replace(".onnx", "").replace(".ppn", "")
            self._wake_words.append(name)
        
        log_info(f"Wake word configuration loaded:")
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
        log_info(f"✅ Wake word backend initialized")
    
    async def _on_audio_chunk(self, env: Envelope) -> None:
        """Handle incoming audio chunks.
        
        Args:
            env: Message envelope containing AudioChunk
        """
        if not self._enabled or not self._backend:
            return
        
        try:
            chunk: AudioChunk = env.payload
            
            # Update current stream info
            if self._current_stream_id != chunk.stream_id:
                self._current_stream_id = chunk.stream_id
                self._current_source = chunk.source
                log_debug(f"Processing audio from new stream: {chunk.stream_id}")
            
            # Store audio format if provided
            if chunk.format:
                self._audio_format = chunk.format
            
            # Process the audio chunk for wake word detection
            await self._process_audio_chunk(chunk)
            
        except Exception as e:
            log_error(f"Error processing audio chunk: {e}", exc_info=True)
    
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
                    WakeWordTopics.DETECTED,
                    WakeWordDetected(
                        wake_word=wake_word,
                        confidence=detection_result.confidence,
                        source=chunk.source,
                        stream_id=chunk.stream_id,
                        backend=self._backend_type,
                    ),
                    event=True,
                    priority=5,  # High priority
                )
        
        except Exception as e:
            log_error(f"Error detecting wake word: {e}", exc_info=True)
    
    async def _on_control(self, env: Envelope) -> None:
        """Handle wake word control commands.
        
        Args:
            env: Message envelope containing WakeWordControl
        """
        try:
            cmd: WakeWordControl = env.payload
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
