"""UI Bridge Service for Aurora's parallel architecture.

This service:
- Connects PyQt6 UI with the message bus
- Translates Qt signals to bus messages
- Translates bus events to Qt signals
- Handles thread-safe communication between async and Qt
"""

from __future__ import annotations

import asyncio

from PyQt6.QtCore import QObject, pyqtSignal

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import (
    Envelope,
    MessageBus,
)
from app.messaging.priority_helpers import get_interactive_priority
from app.orchestrator import UserInput
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.db import DBMethods
from app.shared.contracts.models.gateway import GatewayMethods
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.stt import STTMethods
from app.shared.contracts.models.tts import TTSMethods
from app.ui.mesh_diagnostics import build_mesh_diagnostics_surface
from app.ui.sdk import normalize_capability_graph, normalize_mesh_status


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
    mesh_diagnostics_updated = pyqtSignal(dict)  # Mesh diagnostics/status surface

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
        self.bus.subscribe(STTMethods.USER_SPEECH_CAPTURED, self._on_transcription)
        self.bus.subscribe(STTMethods.SESSION_STARTED, self._on_stt_session_started)

        # Subscribe to orchestrator and TTS events
        self.bus.subscribe(OrchestratorMethods.RESPONSE, self._on_llm_response)
        self.bus.subscribe(TTSMethods.STARTED, self._on_tts_started)
        self.bus.subscribe(TTSMethods.STOPPED, self._on_tts_stopped)

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

        if hasattr(self.ui_window, "request_mesh_diagnostics_signal"):
            self.ui_window.request_mesh_diagnostics_signal.connect(
                self._on_mesh_diagnostics_request
            )
        self.ui_window._refresh_mesh_diagnostics_callback = self._on_mesh_diagnostics_request

    async def _load_today_messages(self):
        """Load today's messages from database via bus.request()."""
        try:
            from app.shared.contracts.models.db import DBGetMessagesForDateRequest

            log_info("UI Bridge: Requesting today's messages from database...")

            # Use bus.request() to get a direct response from DBService
            result = await self.bus.request(
                DBMethods.GET_MESSAGES_FOR_DATE,
                DBGetMessagesForDateRequest(date=None),
                timeout=10.0,
            )

            if result and result.ok and result.data:
                # Extract messages from the response
                if hasattr(result.data, "messages"):
                    messages = result.data.messages
                elif isinstance(result.data, dict):
                    messages = result.data.get("messages", [])
                else:
                    messages = []

                log_info(f"UI Bridge: Received {len(messages)} historical messages")

                # Add each message to UI using the UI's built-in signals (thread-safe)
                if hasattr(self.ui_window, "signals"):
                    for msg in messages:
                        is_user = msg["role"] == "user"
                        # Determine source type from metadata if available
                        source_type = None
                        if is_user and msg.get("metadata"):
                            source_type = msg["metadata"].get("source_type")

                        self.ui_window.signals.message_received.emit(
                            msg["content"], is_user, source_type
                        )

                    log_debug(f"UI Bridge: Emitted {len(messages)} messages to UI")
                else:
                    log_error("UI window does not have signals!")
            else:
                log_info("UI Bridge: No messages returned from database")

        except Exception as e:
            log_error(f"Error loading today's messages: {e}", exc_info=True)

    def _on_ui_message(self, text: str):
        """Handle user message from UI.

        Args:
            text: User message text
        """
        log_debug(f"UI message: {text}")

        # Publish to bus as UserInput command with high priority
        asyncio.run_coroutine_threadsafe(
            self.bus.publish(
                OrchestratorMethods.USER_INPUT,
                UserInput(text=text, source="ui"),
                event=False,  # Command
                priority=get_interactive_priority(),
                origin="internal",
            ),
            self._loop,
        )

    def _on_stop_tts_request(self):
        """Handle stop TTS request from UI button."""
        log_info("UI Bridge: Stop TTS button pressed - sending stop command")

        # Publish TTS stop command to message bus
        from app.shared.messaging.models.tts_models import TTSStop

        asyncio.run_coroutine_threadsafe(
            self.bus.publish(
                TTSMethods.STOP,
                TTSStop(),
                event=False,
                priority=get_interactive_priority(),
                origin="internal",
            ),
            self._loop,  # Command  # High priority
        )

    def _on_mesh_diagnostics_request(self):
        """Handle UI request for the read-only mesh diagnostics surface."""

        asyncio.run_coroutine_threadsafe(self.refresh_mesh_diagnostics(), self._loop)

    async def refresh_mesh_diagnostics(self) -> dict:
        """Fetch Gateway mesh diagnostics and emit a UI-safe status surface."""

        try:
            mesh_result = await self.bus.request(
                GatewayMethods.GET_MESH_STATUS,
                EmptyInput(),
                timeout=10.0,
            )
            graph_result = await self.bus.request(
                GatewayMethods.GET_CAPABILITY_GRAPH,
                EmptyInput(),
                timeout=10.0,
            )

            mesh_view = (
                normalize_mesh_status(mesh_result.data)
                if mesh_result and mesh_result.ok and mesh_result.data
                else None
            )
            graph_view = (
                normalize_capability_graph(graph_result.data)
                if graph_result and graph_result.ok and graph_result.data
                else None
            )
            surface = build_mesh_diagnostics_surface(mesh_view, graph_view)
            payload = surface.model_dump()
            self.mesh_diagnostics_updated.emit(payload)
            if hasattr(self.ui_window, "signals") and hasattr(
                self.ui_window.signals, "mesh_diagnostics_updated"
            ):
                self.ui_window.signals.mesh_diagnostics_updated.emit(payload)
            return payload
        except Exception as e:
            log_error(f"Error refreshing mesh diagnostics: {e}", exc_info=True)
            surface = build_mesh_diagnostics_surface(None)
            payload = surface.model_dump()
            self.mesh_diagnostics_updated.emit(payload)
            return payload

    async def _on_llm_response(self, env: Envelope) -> None:
        """Handle LLM response event.

        Args:
            env: Message envelope containing LLMResponseReady event
        """
        try:
            from app.orchestrator import LLMResponseReady

            response = LLMResponseReady.model_validate(env.payload)
            log_info(f"UI Bridge: Received LLM response: {response.text[:50]}...")

            # Update UI status to idle (processing complete)
            if hasattr(self.ui_window, "signals"):
                self.ui_window.signals.status_changed.emit("idle")

            # Use the UI's built-in signals to add message (thread-safe)
            if hasattr(self.ui_window, "signals"):
                log_info("UI Bridge: Adding assistant message to UI via signal")
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
                log_info(f"UI Bridge: Received transcription: {transcription.text}")

                # Update UI status to processing (transcription captured, now processing with LLM)
                if hasattr(self.ui_window, "signals"):
                    self.ui_window.signals.status_changed.emit("processing")

                # Use the UI's built-in signals to add message (thread-safe)
                if hasattr(self.ui_window, "signals"):
                    log_info("UI Bridge: Adding user message (STT) to UI via signal")
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
            log_info("UI Bridge: STT session started - updating status to 'listening'")

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
            log_info("UI Bridge: TTS started - updating status to 'speaking'")

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
            log_info("UI Bridge: TTS stopped - updating status to 'idle'")

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
