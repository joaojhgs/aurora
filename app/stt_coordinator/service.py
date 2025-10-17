"""STT Coordinator Service for Aurora.

This service coordinates the workflow between wake word detection and transcription,
providing the classic voice assistant experience:

1. Listen for wake word ("Jarvis")
2. When detected, activate transcription
3. Capture user's speech
4. Send to orchestrator for processing
5. Handle timeouts and multi-turn conversations

This service is OPTIONAL - you can use WakeWord and Transcription services
independently without coordination.
"""

from __future__ import annotations

import asyncio
import logging
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import Field

from app.config.config_manager import config_manager
from app.messaging import (
    Command,
    Envelope,
    Event,
    MessageBus,
    TranscriptionControl,
    TranscriptionResult,
    TranscriptionTopics,
    WakeWordTopics
)

logger = logging.getLogger(__name__)


# States for the coordinator state machine
class STTState(str, Enum):
    """States for STT coordinator state machine."""
    
    IDLE = "idle"              # Waiting for wake word
    LISTENING = "listening"    # Actively listening for user speech
    PROCESSING = "processing"  # Processing transcription result
    TIMEOUT = "timeout"        # Timed out waiting for speech


# Events emitted by coordinator
class STTSessionStarted(Event):
    """Event emitted when STT session starts (wake word detected)."""
    
    wake_word: str = Field(description="Wake word that triggered session")
    session_id: str = Field(description="Unique session ID")
    timestamp: datetime = Field(default_factory=datetime.now)


class STTSessionEnded(Event):
    """Event emitted when STT session ends."""
    
    session_id: str = Field(description="Session ID that ended")
    reason: str = Field(description="Reason for ending: 'complete', 'timeout', 'manual'")
    transcription: Optional[str] = Field(default=None, description="Final transcription if available")
    timestamp: datetime = Field(default_factory=datetime.now)


class STTUserSpeechCaptured(Event):
    """Event emitted when user speech is captured and transcribed."""
    
    session_id: str = Field(description="Session ID")
    text: str = Field(description="Transcribed text")
    confidence: Optional[float] = Field(default=None, description="Confidence score")
    is_final: bool = Field(default=True, description="Whether this is final transcription")
    timestamp: datetime = Field(default_factory=datetime.now)


# Control commands
class STTCoordinatorControl(Command):
    """Command to control STT coordinator."""
    
    action: str = Field(
        description="Action: 'start_session', 'end_session', 'reset'"
    )
    session_id: Optional[str] = Field(default=None, description="Session ID for specific actions")


# Topics
class STTCoordinatorTopics:
    """Standard topics for STT coordinator events."""
    
    SESSION_STARTED = "STT.Session.Started"
    SESSION_ENDED = "STT.Session.Ended"
    USER_SPEECH_CAPTURED = "STT.UserSpeechCaptured"  # Fixed to match Orchestrator subscription
    CONTROL = "STT.Coordinator.Control"


class STTCoordinatorService:
    """STT Coordinator service.
    
    Responsibilities:
    - Coordinate wake word detection and transcription
    - Manage conversation sessions
    - Handle timeouts
    - Interrupt TTS when listening
    - Emit events for orchestrator integration
    """
    
    def __init__(self, bus: MessageBus):
        """Initialize STT coordinator.
        
        Args:
            bus: MessageBus instance
        """
        self.bus = bus
        self._running = False
        
        # State machine
        self._state = STTState.IDLE
        self._state_lock = asyncio.Lock()
        
        # Session management
        self._current_session_id: Optional[str] = None
        self._session_start_time: Optional[datetime] = None
        self._accumulated_transcription: str = ""
        
        # Configuration
        self._listen_timeout_seconds = config_manager.get(
            "general.speech_to_text.coordinator.session_timeout_s",
            10.0  # Default: 10 seconds
        )
        self._multi_turn_enabled = config_manager.get(
            "general.speech_to_text.coordinator.multi_turn_enabled",
            False  # Default: single turn
        )
        self._pause_tts_on_listening = config_manager.get(
            "general.speech_to_text.coordinator.pause_tts_on_listen",
            True  # Default: pause TTS
        )
        self._ambient_transcription_enabled = config_manager.get(
            "general.speech_to_text.ambient_transcription.enable",
            False  # Default: disabled
        )
        
        # Timeout task
        self._timeout_task: Optional[asyncio.Task] = None
        
        # Statistics
        self._sessions_started = 0
        self._sessions_completed = 0
        self._sessions_timeout = 0
        
    async def start(self) -> None:
        """Start the STT coordinator service."""
        if self._running:
            log_warning("STT coordinator already running")
            return
            
        log_info("Starting STT coordinator service...")
        self._running = True
        
        # Subscribe to events
        self.bus.subscribe(WakeWordTopics.DETECTED, self._on_wake_word_detected)
        self.bus.subscribe(TranscriptionTopics.RESULT_ACCURATE, self._on_transcription_result)
        self.bus.subscribe(TranscriptionTopics.RESULT_FINAL, self._on_transcription_result)
        self.bus.subscribe(STTCoordinatorTopics.CONTROL, self._on_control)
        
        # Set initial state
        await self._transition_to(STTState.IDLE)
        
        log_info("✅ STT coordinator started")
        log_info(f"   Listen timeout: {self._listen_timeout_seconds}s")
        log_info(f"   Multi-turn: {'enabled' if self._multi_turn_enabled else 'disabled'}")
        log_info(f"   Pause TTS: {'yes' if self._pause_tts_on_listening else 'no'}")
        log_info(f"   Ambient transcription: {'enabled' if self._ambient_transcription_enabled else 'disabled'}")
        
    async def stop(self) -> None:
        """Stop the STT coordinator service."""
        if not self._running:
            return
            
        log_info("Stopping STT coordinator service...")
        self._running = False
        
        # Cancel any pending timeout
        if self._timeout_task and not self._timeout_task.done():
            self._timeout_task.cancel()
            try:
                await self._timeout_task
            except asyncio.CancelledError:
                pass
                
        # End current session if active
        if self._current_session_id:
            await self._end_session("manual")
            
        log_info("✅ STT coordinator stopped")
        log_info(f"   Sessions: {self._sessions_started} started, "
                   f"{self._sessions_completed} completed, {self._sessions_timeout} timeout")
        
    async def _transition_to(self, new_state: STTState) -> None:
        """Transition to a new state.
        
        Args:
            new_state: State to transition to
        """
        async with self._state_lock:
            old_state = self._state
            self._state = new_state
            
            if old_state != new_state:
                log_info(f"🔄 State transition: {old_state.value} → {new_state.value}")
                
    async def _on_wake_word_detected(self, envelope: Envelope) -> None:
        """Handle wake word detection event.
        
        Args:
            envelope: Message envelope containing WakeWordDetected
        """
        wake_word_event = envelope.payload
        wake_word = wake_word_event.wake_word
        
        log_info(f"🎤 Wake word detected: '{wake_word}'")
        
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
        
        log_info(f"▶️  Starting STT session: {session_id}")
        
        # Transition to LISTENING state
        await self._transition_to(STTState.LISTENING)
        
        # Pause TTS if configured
        if self._pause_tts_on_listening:
            log_debug("Pausing TTS playback")
            try:
                from app.messaging import TTSTopics
                from app.tts import TTSPause
                
                await self.bus.publish(
                    TTSTopics.PAUSE,
                    TTSPause(),
                    event=False,
                    priority=10
                )
            except Exception as e:
                log_warning(f"Failed to pause TTS: {e}")
                
        # Enable transcription (unpause if paused)
        try:
            await self.bus.publish(
                TranscriptionTopics.CONTROL,
                TranscriptionControl(action="resume"),
                event=False
            )
        except Exception as e:
            log_warning(f"Failed to enable transcription: {e}")
            
        # Start timeout timer
        self._timeout_task = asyncio.create_task(self._timeout_handler())
        
        # Emit session started event
        await self.bus.publish(
            STTCoordinatorTopics.SESSION_STARTED,
            STTSessionStarted(
                wake_word=wake_word,
                session_id=session_id
            )
        )
        
    async def _timeout_handler(self) -> None:
        """Handle session timeout."""
        try:
            await asyncio.sleep(self._listen_timeout_seconds)
            
            # Timeout reached
            log_warning(f"⏱️  Session timeout ({self._listen_timeout_seconds}s)")
            
            async with self._state_lock:
                if self._state == STTState.LISTENING:
                    await self._transition_to(STTState.TIMEOUT)
                    self._sessions_timeout += 1
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
                
        log_info(f"📝 Transcription captured: '{text}'")
        
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
            is_final=True
        )
        
        log_info(f"🚀 Publishing STTUserSpeechCaptured to topic: {STTCoordinatorTopics.USER_SPEECH_CAPTURED}")
        log_info(f"   Event data: session={speech_event.session_id}, text='{speech_event.text}', is_final={speech_event.is_final}")
        
        await self.bus.publish(
            STTCoordinatorTopics.USER_SPEECH_CAPTURED,
            speech_event
        )
        
        log_info(f"✅ Successfully published STTUserSpeechCaptured event")
        
        # Check if we should continue listening (multi-turn)
        if self._multi_turn_enabled:
            log_info("💬 Multi-turn enabled, continuing to listen...")
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
        
        log_info(f"⏹️  Ending session {session_id} (reason: {reason})")
        
        if reason == "complete":
            self._sessions_completed += 1
            
        # Emit session ended event
        await self.bus.publish(
            STTCoordinatorTopics.SESSION_ENDED,
            STTSessionEnded(
                session_id=session_id,
                reason=reason,
                transcription=transcription if transcription else None
            )
        )
        
        # Pause transcription to save resources (ONLY if ambient transcription is disabled)
        if not self._ambient_transcription_enabled:
            try:
                await self.bus.publish(
                    TranscriptionTopics.CONTROL,
                    TranscriptionControl(action="pause"),
                    event=False
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
                from app.messaging import TTSTopics
                from app.tts import TTSResume
                
                await self.bus.publish(
                    TTSTopics.RESUME,
                    TTSResume(),
                    event=False
                )
            except Exception as e:
                log_warning(f"Failed to resume TTS: {e}")
                
        # Reset session state
        self._current_session_id = None
        self._session_start_time = None
        self._accumulated_transcription = ""
        
        # Return to IDLE state
        await self._transition_to(STTState.IDLE)
        
    async def _on_control(self, envelope: Envelope) -> None:
        """Handle control commands.
        
        Args:
            envelope: Message envelope containing STTCoordinatorControl
        """
        control: STTCoordinatorControl = envelope.payload
        action = control.action
        
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
    "STTCoordinatorTopics",
]
