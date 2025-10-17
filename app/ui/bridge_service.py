"""UI Bridge Service for Aurora's parallel architecture.

This service:
- Connects PyQt6 UI with the message bus
- Translates Qt signals to bus messages
- Translates bus events to Qt signals
- Handles thread-safe communication between async and Qt
"""

from __future__ import annotations

import asyncio
import logging

from PyQt6.QtCore import QObject, pyqtSignal

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import (
    Envelope,
    MessageBus,
    OrchestratorTopics,
    STTCoordinatorTopics,
    TTSTopics,
)
from app.orchestrator import UserInput

logger = logging.getLogger(__name__)


class UIBridge(QObject):
    """Bridge between PyQt6 UI and message bus.

    This class runs in the Qt thread and communicates with the
    async message bus via thread-safe mechanisms.
    """

    # Qt signals for UI updates
    message_received = pyqtSignal(dict)  # LLM response received
    transcription_received = pyqtSignal(str)  # STT transcription
    tts_started = pyqtSignal(str)  # TTS playback started
    tts_stopped = pyqtSignal()  # TTS playback stopped
    status_changed = pyqtSignal(str)  # General status updates

    def __init__(self, bus: MessageBus, ui_window):
        """Initialize UI bridge.

        Args:
            bus: MessageBus instance
            ui_window: AuroraUI window instance
        """
        super().__init__()
        self.bus = bus
        self.ui_window = ui_window
        self._loop: asyncio.AbstractEventLoop | None = None

    async def start(self) -> None:
        """Start the UI bridge and subscribe to events."""
        log_info("Starting UI Bridge...")

        # Store event loop for callbacks
        self._loop = asyncio.get_event_loop()

        # Subscribe to relevant events using typed topics
        # NOTE: LocalBus now delivers messages concurrently, so subscription order doesn't matter
        # USER_SPEECH_CAPTURED signals end of "listening" state → transition to "processing"
        self.bus.subscribe(STTCoordinatorTopics.USER_SPEECH_CAPTURED, self._on_transcription)
        self.bus.subscribe(STTCoordinatorTopics.SESSION_STARTED, self._on_stt_session_started)

        # Subscribe to orchestrator and TTS events
        self.bus.subscribe(OrchestratorTopics.LLM_RESPONSE, self._on_llm_response)
        self.bus.subscribe(TTSTopics.STARTED, self._on_tts_started)
        self.bus.subscribe(TTSTopics.STOPPED, self._on_tts_stopped)

        # Subscribe to database messages response
        from app.messaging import DBTopics

        self.bus.subscribe(DBTopics.MESSAGES_RESPONSE, self._on_messages_loaded)

        # Connect UI signals to bus messages
        self._connect_ui_signals()

        # Load today's messages from database
        await self._load_today_messages()

        log_info("UI Bridge started")

    def _connect_ui_signals(self):
        """Connect UI signals to message bus publications."""
        # When user sends message from UI
        if hasattr(self.ui_window, "user_message_signal"):
            self.ui_window.user_message_signal.connect(self._on_ui_message)

        # Register callback for stop TTS button
        self.ui_window._stop_tts_callback = self._on_stop_tts_request

    async def _load_today_messages(self):
        """Load today's messages from database."""
        try:
            from app.db.service import GetMessagesForDate
            from app.messaging import DBTopics

            log_info("📚 UI Bridge: Requesting today's messages from database...")

            # Request messages for today (date=None means today)
            await self.bus.publish(DBTopics.GET_MESSAGES_FOR_DATE, GetMessagesForDate(date=None), event=False, origin="internal")  # Command/Query

        except Exception as e:
            log_error(f"Error loading today's messages: {e}", exc_info=True)

    async def _on_messages_loaded(self, env: Envelope) -> None:
        """Handle messages loaded from database.

        Args:
            env: Message envelope containing MessagesResponse
        """
        try:
            from app.db.service import MessagesResponse

            response = MessagesResponse.model_validate(env.payload)
            messages = response.messages

            log_info(f"📚 UI Bridge: Received {len(messages)} historical messages")

            # Add each message to UI using the UI's built-in signals (thread-safe)
            if hasattr(self.ui_window, "signals"):
                for msg in messages:
                    is_user = msg["role"] == "user"
                    # Determine source type from metadata if available
                    source_type = None
                    if is_user and msg.get("metadata"):
                        source_type = msg["metadata"].get("source_type")

                    self.ui_window.signals.message_received.emit(msg["content"], is_user, source_type)

                log_info(f"✅ UI Bridge: Emitted {len(messages)} messages to UI")
            else:
                log_error("UI window does not have signals!")

        except Exception as e:
            log_error(f"Error handling loaded messages: {e}", exc_info=True)

    def _on_ui_message(self, text: str):
        """Handle user message from UI.

        Args:
            text: User message text
        """
        log_debug(f"UI message: {text}")

        # Publish to bus as UserInput command with high priority
        asyncio.run_coroutine_threadsafe(
            self.bus.publish(
                OrchestratorTopics.UI_USER_INPUT,
                UserInput(text=text, source="ui"),
                event=False,  # Command
                priority=10,  # Interactive priority
                origin="internal",
            ),
            self._loop,
        )

    def _on_stop_tts_request(self):
        """Handle stop TTS request from UI button."""
        log_info("🔊 UI Bridge: Stop TTS button pressed - sending stop command")

        # Publish TTS stop command to message bus
        from app.messaging import TTSTopics
        from app.tts import TTSStop

        asyncio.run_coroutine_threadsafe(
            self.bus.publish(TTSTopics.STOP, TTSStop(), event=False, priority=10, origin="internal"), self._loop  # Command  # High priority
        )

    async def _on_llm_response(self, env: Envelope) -> None:
        """Handle LLM response event.

        Args:
            env: Message envelope containing LLMResponseReady event
        """
        try:
            from app.orchestrator import LLMResponseReady

            response = LLMResponseReady.model_validate(env.payload)
            log_info(f"📨 UI Bridge: Received LLM response: {response.text[:50]}...")

            # Update UI status to idle (processing complete)
            if hasattr(self.ui_window, "signals"):
                self.ui_window.signals.status_changed.emit("idle")

            # Use the UI's built-in signals to add message (thread-safe)
            if hasattr(self.ui_window, "signals"):
                log_info("📨 UI Bridge: Adding assistant message to UI via signal")
                self.ui_window.signals.message_received.emit(response.text, False, None)
            else:
                log_error("UI window does not have signals!")

        except Exception as e:
            log_error(f"Error handling LLM response in UI: {e}", exc_info=True)

    async def _on_transcription(self, env: Envelope) -> None:
        """Handle STT transcription event.

        Args:
            env: Message envelope containing STTUserSpeechCaptured event
        """
        try:
            from app.stt_coordinator import STTUserSpeechCaptured

            transcription = STTUserSpeechCaptured.model_validate(env.payload)

            if transcription.is_final:
                log_info(f"🎤 UI Bridge: Received transcription: {transcription.text}")

                # Update UI status to processing (transcription captured, now processing with LLM)
                if hasattr(self.ui_window, "signals"):
                    self.ui_window.signals.status_changed.emit("processing")

                # Use the UI's built-in signals to add message (thread-safe)
                if hasattr(self.ui_window, "signals"):
                    log_info("🎤 UI Bridge: Adding user message (STT) to UI via signal")
                    self.ui_window.signals.message_received.emit(transcription.text, True, "STT")
                else:
                    log_error("UI window does not have signals!")

        except Exception as e:
            log_error(f"Error handling transcription in UI: {e}", exc_info=True)

    async def _on_stt_session_started(self, env: Envelope) -> None:
        """Handle STT session started event.

        Args:
            env: Message envelope containing STTSessionStarted event
        """
        try:
            log_info("🎤 UI Bridge: STT session started - updating status to 'listening'")

            # Update UI status to listening
            if hasattr(self.ui_window, "signals"):
                self.ui_window.signals.status_changed.emit("listening")

        except Exception as e:
            log_error(f"Error handling STT session started: {e}", exc_info=True)

    async def _on_tts_started(self, env: Envelope) -> None:
        """Handle TTS started event.

        Args:
            env: Message envelope containing TTSStarted event
        """
        try:
            from app.tts import TTSStarted

            event = TTSStarted.model_validate(env.payload)
            log_info("🔊 UI Bridge: TTS started - updating status to 'speaking'")

            # Emit Qt signal
            self.tts_started.emit(event.text)

            # Update UI status to speaking
            if hasattr(self.ui_window, "signals"):
                self.ui_window.signals.status_changed.emit("speaking")

        except Exception as e:
            log_error(f"Error handling TTS started in UI: {e}", exc_info=True)

    async def _on_tts_stopped(self, env: Envelope) -> None:
        """Handle TTS stopped event.

        Args:
            env: Message envelope containing TTSStopped event
        """
        try:
            log_info("🔊 UI Bridge: TTS stopped - updating status to 'idle'")

            # Emit Qt signal
            self.tts_stopped.emit()

            # Update UI status back to idle
            if hasattr(self.ui_window, "signals"):
                self.ui_window.signals.status_changed.emit("idle")

        except Exception as e:
            log_error(f"Error handling TTS stopped in UI: {e}", exc_info=True)

    async def stop(self) -> None:
        """Stop the UI bridge."""
        log_info("Stopping UI Bridge...")
        log_info("UI Bridge stopped")
