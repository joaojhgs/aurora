"""Orchestrator Service for Aurora's parallel architecture.

This service:
- Consumes input messages (from STT, UI, external sources)
- Runs LangGraph agent for processing
- Produces responses and tool requests
- Coordinates with other services via message bus
- Integrates with LangGraph stream_graph_updates
"""

from __future__ import annotations

import logging
from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import (
    Command,
    Envelope,
    Event,
    MessageBus,
    OrchestratorTopics,
    STTCoordinatorTopics,
    TTSTopics,
)
from app.orchestrator.graph import stream_graph_updates

logger = logging.getLogger(__name__)


# Message definitions
class UserInput(Command):
    """Command representing user input for processing."""

    text: str
    source: str = "stt"  # "stt", "ui", "external"
    session_id: str | None = None


class LLMResponseReady(Event):
    """Event emitted when LLM response is ready."""

    text: str
    session_id: str | None = None
    metadata: dict = {}


class ToolRequest(Command):
    """Command to execute a tool."""

    tool_name: str
    parameters: dict
    request_id: str


class ToolResult(Event):
    """Event with tool execution result."""

    request_id: str
    result: Any
    success: bool
    error: str | None = None


# Service implementation
class OrchestratorService:
    """Orchestrator service using LangGraph.

    Responsibilities:
    - Process user inputs
    - Run LangGraph agent
    - Emit responses and tool requests
    - Coordinate with other services
    """

    def __init__(self, bus: MessageBus):
        """Initialize orchestrator service with LangGraph integration.

        Args:
            bus: MessageBus instance
        """
        self.bus = bus

    async def start(self) -> None:
        """Start the orchestrator service and subscribe to inputs."""
        log_info("Starting Orchestrator service...")

        # Subscribe to input sources using typed topics
        self.bus.subscribe(STTCoordinatorTopics.USER_SPEECH_CAPTURED, self._on_transcription)
        self.bus.subscribe(OrchestratorTopics.USER_INPUT, self._on_user_input)
        self.bus.subscribe(OrchestratorTopics.EXTERNAL_USER_INPUT, self._on_external_input)
        self.bus.subscribe(OrchestratorTopics.TOOL_RESULT, self._on_tool_result)

        log_info("Orchestrator service started")

    async def stop(self) -> None:
        """Stop the orchestrator service."""
        log_info("Stopping Orchestrator service...")
        log_info("Orchestrator service stopped")

    async def _on_transcription(self, env: Envelope) -> None:
        """Handle STT transcription event.

        Args:
            env: Message envelope containing STTUserSpeechCaptured event
        """
        log_info("🎯 Orchestrator received message on STT.UserSpeechCaptured")
        log_info(f"   Envelope type: {env.type}")
        log_info(f"   Payload type: {type(env.payload)}")
        log_info(f"   Payload: {env.payload}")

        try:
            from app.stt_coordinator import STTUserSpeechCaptured

            event = STTUserSpeechCaptured.model_validate(env.payload)

            log_info(f"   Validated event: session={event.session_id}, text='{event.text}', is_final={event.is_final}")

            # Only process final transcriptions
            if not event.is_final:
                log_info("   Skipping non-final transcription")
                return

            log_info("✅ Processing transcription: {event.text}")
            await self._process_input(event.text, source="stt")

        except Exception as e:
            log_error(f"❌ Error processing transcription: {e}", exc_info=True)

    async def _on_user_input(self, env: Envelope) -> None:
        """Handle UI user input command.

        Args:
            env: Message envelope containing UserInput command
        """
        try:
            cmd = UserInput.model_validate(env.payload)
            log_info(f"Processing UI input: {cmd.text}")
            await self._process_input(cmd.text, source="ui", session_id=cmd.session_id)

        except Exception as e:
            log_error(f"Error processing UI input: {e}", exc_info=True)

    async def _on_external_input(self, env: Envelope) -> None:
        """Handle external user input command.

        Args:
            env: Message envelope containing UserInput command from external source
        """
        try:
            cmd = UserInput.model_validate(env.payload)
            log_info(f"Processing external input: {cmd.text}")
            await self._process_input(
                cmd.text,
                source="external",
                session_id=cmd.session_id,
            )

        except Exception as e:
            log_error(f"Error processing external input: {e}", exc_info=True)

    async def _on_tool_result(self, env: Envelope) -> None:
        """Handle tool execution result.

        Args:
            env: Message envelope containing ToolResult event
        """
        try:
            result = ToolResult.model_validate(env.payload)
            log_info(f"Tool result received: {result.request_id}")

            # TODO: Process tool result and continue agent execution

        except Exception as e:
            log_error(f"Error processing tool result: {e}", exc_info=True)

    async def _process_input(
        self,
        text: str,
        source: str,
        session_id: str | None = None,
    ) -> None:
        """Process user input through LangGraph agent.

        Args:
            text: User input text
            source: Input source ("stt", "ui", "external")
            session_id: Optional session identifier
        """
        try:
            log_debug(f"Processing input from {source}: {text}")

            # Run LangGraph agent
            # stream_graph_updates returns a single result (not an async generator)
            # DON'T use TTS internally - orchestrator handles TTS via message bus
            response_text = await stream_graph_updates(text, ttsResult=False)

            log_info(f"🤖 LLM response: {response_text[:100]}...")

            # If we got a response, emit it
            if response_text and response_text != "END":
                # Emit response event
                await self.bus.publish(
                    OrchestratorTopics.LLM_RESPONSE,
                    LLMResponseReady(
                        text=response_text,
                        session_id=session_id,
                        metadata={"source": source},
                    ),
                    priority=10,  # High priority for interactive response
                    origin="internal",
                )

                # Send TTS request to speak the response
                from app.tts import TTSRequest

                await self.bus.publish(
                    TTSTopics.REQUEST,
                    TTSRequest(text=response_text, interrupt=True),
                    event=False,  # Command, not event
                    priority=10,
                    origin="internal",
                )

        except Exception as e:
            log_error(f"Error processing input: {e}", exc_info=True)
