"""Orchestrator Service for Aurora's parallel architecture.

This service:
- Consumes input messages (from STT, UI, external sources)
- Runs LangGraph agent for processing
- Produces responses and tool requests
- Coordinates with other services via message bus
- Integrates with LangGraph stream_graph_updates
"""

from __future__ import annotations

from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import (
    Envelope,
    MessageBus,
)
from app.messaging.priority_helpers import get_interactive_priority
from app.services.orchestrator.graph import GraphOrchestrator, set_orchestrator
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.orchestrator import (
    OrchestratorMethods,
    OrchestratorModule,
    OrchestratorProcessRequest,
    OrchestratorResponse,
    OrchestratorToolResultRequest,
)
from app.shared.contracts.models.stt import STTMethods
from app.shared.contracts.registry import method_contract
from app.shared.messaging.models.stt_coordinator_models import STTUserSpeechCaptured
from app.shared.services.base_service import BaseService


# Service implementation
class OrchestratorService(BaseService):
    """Orchestrator service using LangGraph.

    Responsibilities:
    - Process user inputs
    - Run LangGraph agent
    - Emit responses and tool requests
    - Coordinate with other services
    """

    def __init__(self):
        """Initialize orchestrator service with LangGraph integration."""
        super().__init__(
            module=OrchestratorModule.NAME,
            summary="Central intelligence orchestrator using LangGraph",
            capabilities=["llm_processing", "agent_execution", "tool_use"],
        )
        self.orchestrator: GraphOrchestrator | None = None

    async def on_start(self) -> None:
        """Start the orchestrator service and subscribe to inputs."""
        log_info("Starting Orchestrator service...")

        # Initialize graph orchestrator with bus dependency injection
        self.orchestrator = GraphOrchestrator(bus=self.bus)
        set_orchestrator(self.orchestrator)
        log_info("Graph orchestrator initialized with bus dependency")

        # Manually subscribe to STT events (since they don't map 1:1 to a contract request model yet)
        # Or we can define a contract for it. For now, keep manual for STT to ensure compatibility.
        # Actually, we can use a contract if we define the input model correctly.
        # STTUserSpeechCaptured is an Event, not a Request.
        # But we can treat it        # Subscribe to STT events
        self.bus.subscribe(STTMethods.USER_SPEECH_CAPTURED, self._on_transcription)

    async def on_stop(self) -> None:
        """Stop the orchestrator service."""
        log_info("Stopping Orchestrator service...")

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading OrchestratorService configuration: section={config_section}")
        # Reload orchestrator if LLM config changed
        if config_section is None or config_section in ["llm", "general"]:
            log_info("Reloading orchestrator due to LLM config change...")
            # Reinitialize orchestrator with new config
            await self.stop()
            await self.start()
        log_info("OrchestratorService configuration reloaded")

    async def _on_transcription(self, env: Envelope) -> None:
        """Handle STT transcription event.

        Args:
            env: Message envelope containing STTUserSpeechCaptured event
        """
        log_info("🎯 Orchestrator received message on STT.UserSpeechCaptured")

        try:
            event = STTUserSpeechCaptured.model_validate(env.payload)

            log_info(f"   Validated event: session={event.session_id}, text='{event.text}', is_final={event.is_final}")

            # Only process final transcriptions
            if not event.is_final:
                log_info("   Skipping non-final transcription")
                return

            log_info(f"Processing transcription: {event.text}")
            await self._process_input(event.text, source="stt", session_id=event.session_id)

        except Exception as e:
            log_error(f"Error processing transcription: {e}", exc_info=True)

    @method_contract(
        method_id=OrchestratorMethods.USER_INPUT,
        summary="Process user input",
        input_model=OrchestratorProcessRequest,
        output_model=EmptyOutput,
        exposure="internal",
    )
    async def process_user_input(self, cmd: OrchestratorProcessRequest) -> EmptyOutput:
        """Handle UI user input command."""
        try:
            log_info(f"Processing UI input: {cmd.message}")
            await self._process_input(cmd.message, source="ui", session_id=None)  # cmd doesn't have session_id in current model?
            # Wait, OrchestratorProcessRequest has session_id?
            # Let's check the model definition I created.
            # It has 'message', 'context', 'stream', 'max_tokens'.
            # It does NOT have session_id explicitly in the one I wrote in step 800?
            # Wait, step 800 content:
            # class OrchestratorProcessRequest(IOModel):
            #     message: str
            #     context: dict[str, Any] | None = None
            #     stream: bool = False
            #     max_tokens: int | None = None

            # The previous UserInput model had session_id.
            # I should probably update OrchestratorProcessRequest to include session_id if needed.
            # For now, I'll pass None or extract from context if I update the model.

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error processing UI input: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=OrchestratorMethods.EXTERNAL_USER_INPUT,
        summary="Process external user input",
        input_model=OrchestratorProcessRequest,
        output_model=EmptyOutput,
        exposure="external",
    )
    async def process_external_input(self, cmd: OrchestratorProcessRequest) -> EmptyOutput:
        """Handle external user input command."""
        try:
            log_info(f"Processing external input: {cmd.message}")
            await self._process_input(
                cmd.message,
                source="external",
                session_id=None,
            )
            return EmptyOutput()

        except Exception as e:
            log_error(f"Error processing external input: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=OrchestratorMethods.TOOL_RESULT,
        summary="Process tool execution result",
        input_model=OrchestratorToolResultRequest,
        output_model=EmptyOutput,
        exposure="internal",
    )
    async def process_tool_result(self, cmd: OrchestratorToolResultRequest) -> EmptyOutput:  # Need to check model
        """Handle tool execution result."""
        try:
            log_info(f"Tool result received: {cmd.request_id}")

            # TODO: Process tool result and continue agent execution
            # This requires the graph to be able to accept tool outputs

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error processing tool result: {e}", exc_info=True)
            return EmptyOutput()

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

            # Run LangGraph agent via orchestrator instance
            # DON'T use TTS internally - orchestrator handles TTS via message bus
            if self.orchestrator is None:
                raise RuntimeError("Orchestrator not initialized")

            response_text = await self.orchestrator.stream_graph_updates(text, tts_result=False)

            log_info(f"🤖 LLM response: {response_text[:100]}...")

            # If we got a response, emit it
            if response_text and response_text != "END":
                # Emit response event
                # We need to use the new OrchestratorResponse model if we want to be consistent,
                # but LLMResponseReady is what listeners expect currently.
                # For now, keep using LLMResponseReady for backward compatibility with UI/TTS
                from app.shared.messaging.models.orchestrator_models import LLMResponseReady

                await self.bus.publish(
                    OrchestratorMethods.RESPONSE,
                    LLMResponseReady(
                        text=response_text,
                        session_id=session_id,
                        metadata={"source": source},
                    ),
                    priority=get_interactive_priority(),  # High priority for interactive response
                    origin="internal",
                )

                # Send TTS request to speak the response
                from app.shared.contracts.models.tts import TTSMethods
                from app.shared.messaging.models.tts_models import TTSRequest

                await self.bus.publish(
                    TTSMethods.REQUEST,
                    TTSRequest(text=response_text, interrupt=True),
                    event=False,  # Command, not event
                    priority=get_interactive_priority(),
                    origin="internal",
                )

        except Exception as e:
            log_error(f"Error processing input: {e}", exc_info=True)
