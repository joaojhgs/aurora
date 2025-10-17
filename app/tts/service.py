"""Text-to-Speech Service for Aurora's parallel architecture.

This service:
- Processes TTS requests
- Manages audio playback with RealtimeTTS
- Emits TTS lifecycle events
- Handles interruptions and queue management
"""

from __future__ import annotations

import asyncio
import logging
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
import os
from typing import Any, Optional

from pydantic import BaseModel
from RealtimeTTS import PiperVoice, TextToAudioStream

from app.config.config_manager import config_manager
from app.messaging import Command, Envelope, Event, MessageBus, TTSTopics
from app.tts.piper_engine import PiperEngine

# TODO: Implement volume control functions
def reduce_volume_except_current():
    """Placeholder for reducing system volume during TTS."""
    pass

def restore_volume_except_current():
    """Placeholder for restoring system volume after TTS."""
    pass

logger = logging.getLogger(__name__)

file_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# Message definitions
class TTSRequest(Command):
    """Command to play text-to-speech audio."""

    text: str
    interrupt: bool = False
    voice: Optional[str] = None
    speed: float = 1.0


class TTSStop(Command):
    """Command to stop TTS playback."""

    pass


class TTSPause(Command):
    """Command to pause TTS playback."""

    pass


class TTSResume(Command):
    """Command to resume TTS playback."""

    pass


class TTSEvent(Event):
    """Base event for TTS lifecycle."""

    request_id: Optional[str] = None


class TTSStarted(TTSEvent):
    """Event emitted when TTS playback starts."""

    text: str


class TTSStopped(TTSEvent):
    """Event emitted when TTS playback stops."""

    reason: str = "completed"  # "completed", "interrupted", "error"


class TTSPaused(TTSEvent):
    """Event emitted when TTS playback is paused."""

    pass


class TTSResumed(TTSEvent):
    """Event emitted when TTS playback is resumed."""

    pass


class TTSError(TTSEvent):
    """Event emitted when TTS encounters an error."""

    error: str


# Service implementation
class TTSService:
    """Text-to-Speech service.
    
    Responsibilities:
    - Process TTS requests
    - Manage audio synthesis and playback
    - Handle interruptions and queue
    - Emit lifecycle events
    """

    def __init__(self, bus: MessageBus):
        """Initialize TTS service with RealtimeTTS engine.
        
        Args:
            bus: MessageBus instance
        """
        self.bus = bus
        self._playing = False
        self._paused = False
        self._current_text: Optional[str] = None
        self._current_request_id: Optional[str] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        
        # Initialize TTS engine
        self._initialize_engine()
    
    def _initialize_engine(self) -> None:
        """Initialize the RealtimeTTS engine with Piper voice."""
        try:
            # Get voice model paths from config
            model_file = file_root + config_manager.get(
                "general.text_to_speech.model_file_path", 
                "/voice_models/en_US-lessac-medium.onnx"
            )
            config_file = file_root + config_manager.get(
                "general.text_to_speech.model_config_file_path", 
                "/voice_models/en_US-lessac-medium.onnx.txt"
            )
            
            # Create Piper voice
            voice = PiperVoice(model_file=model_file, config_file=config_file)
            
            # Create Piper engine
            engine = PiperEngine(piper_path="piper", voice=voice)
            
            # Create audio stream with callbacks
            self.stream = TextToAudioStream(
                engine,
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
        log_debug("🔊 Audio stream started")
    
    def _on_audio_stop(self):
        """Called when audio stream stops playing."""
        restore_volume_except_current()
        log_info("🔊 Audio stream stopped - emitting TTS stopped event")
        
        # Emit stopped event when audio finishes
        if self._loop and self._playing:
            request_id = self._current_request_id
            self._playing = False
            self._current_text = None
            self._current_request_id = None
            
            asyncio.run_coroutine_threadsafe(
                self.bus.publish(
                    TTSTopics.STOPPED,
                    TTSStopped(request_id=request_id, reason="completed"),
                    event=True,
                    origin="internal",
                ),
                self._loop
            )

    async def start(self) -> None:
        """Start the TTS service and subscribe to commands."""
        log_info("Starting TTS service...")
        
        # Store event loop for callbacks
        self._loop = asyncio.get_event_loop()
        
        # Subscribe to commands using typed topics
        self.bus.subscribe(TTSTopics.REQUEST, self._on_tts_request)
        self.bus.subscribe(TTSTopics.STOP, self._on_stop)
        self.bus.subscribe(TTSTopics.PAUSE, self._on_pause)
        self.bus.subscribe(TTSTopics.RESUME, self._on_resume)
        
        log_info("TTS service started")

    async def stop(self) -> None:
        """Stop the TTS service."""
        log_info("Stopping TTS service...")
        self._playing = False
        
        # Stop any ongoing playback
        if hasattr(self, 'stream'):
            self.stream.stop()
        
        log_info("TTS service stopped")

    async def _on_tts_request(self, env: Envelope) -> None:
        """Handle TTS request command.
        
        Args:
            env: Message envelope containing TTSRequest command
        """
        try:
            request = TTSRequest.model_validate(env.payload)
            log_info(f"TTS request: '{request.text}' (interrupt={request.interrupt})")
            
            # Handle interruption
            if request.interrupt and self._playing:
                log_info("Interrupting current TTS playback")
                await self._stop_playback("interrupted")
            
            # Start playback
            await self._play_text(request.text, env.id)
            
        except Exception as e:
            log_error(f"Error handling TTS request: {e}", exc_info=True)
            await self.bus.publish(
                TTSTopics.ERROR,
                TTSError(request_id=env.id, error=str(e)),
                event=True,
                origin="internal",
            )

    async def _on_stop(self, env: Envelope) -> None:
        """Handle TTS stop command.
        
        Args:
            env: Message envelope containing TTSStop command
        """
        try:
            log_info("TTS stop requested")
            await self._stop_playback("stopped")
        except Exception as e:
            log_error(f"Error stopping TTS: {e}", exc_info=True)

    async def _on_pause(self, env: Envelope) -> None:
        """Handle TTS pause command.
        
        Args:
            env: Message envelope containing TTSPause command
        """
        try:
            if self._playing and not self._paused:
                log_info("Pausing TTS playback")
                self._paused = True
                
                # Pause audio playback
                self.stream.pause()
                
                await self.bus.publish(
                    TTSTopics.PAUSED,
                    TTSPaused(request_id=env.id),
                    event=True,
                    origin="internal",
                )
        except Exception as e:
            log_error(f"Error pausing TTS: {e}", exc_info=True)

    async def _on_resume(self, env: Envelope) -> None:
        """Handle TTS resume command.
        
        Args:
            env: Message envelope containing TTSResume command
        """
        try:
            if self._playing and self._paused:
                log_info("Resuming TTS playback")
                self._paused = False
                
                # Resume audio playback
                self.stream.resume()
                
                await self.bus.publish(
                    TTSTopics.RESUMED,
                    TTSResumed(request_id=env.id),
                    event=True,
                    origin="internal",
                )
        except Exception as e:
            log_error(f"Error resuming TTS: {e}", exc_info=True)

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
                TTSTopics.STARTED,
                TTSStarted(request_id=request_id, text=text),
                event=True,
                origin="internal",
            )
            
            # Feed text to stream and play asynchronously
            log_info(f"🔊 Playing TTS: {text[:50]}...")
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
            # Stop audio stream
            self.stream.stop()
            
            self._playing = False
            self._paused = False
            text = self._current_text
            self._current_text = None
            
            await self.bus.publish(
                TTSTopics.STOPPED,
                TTSStopped(reason=reason),
                event=True,
                origin="internal",
            )
            log_info(f"TTS playback stopped: {reason}")
