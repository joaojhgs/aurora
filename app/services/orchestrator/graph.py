"""LangGraph orchestration for Aurora voice assistant.

This module manages the conversational flow using LangGraph, coordinating
between the chatbot agent and tool execution via the message bus.
"""

from typing import Any, Literal, Union

from langchain_core.messages import AnyMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import tools_condition
from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import MessageBus
from app.messaging.priority_helpers import get_interactive_priority
from app.services.orchestrator.agents.chatbot import chatbot
from app.services.orchestrator.state import State
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.contracts.models.tts import TTSMethods
from app.shared.messaging.models.tooling_models import ExecuteToolCommand
from app.shared.messaging.models.tts_models import TTSRequest


class GraphOrchestrator:
    """Graph orchestrator using message bus for tool execution and TTS."""

    def __init__(self, bus: MessageBus):
        """Initialize the graph orchestrator.

        Args:
            bus: MessageBus instance (injected as dependency)
        """
        log_debug("Initializing GraphOrchestrator...")

        self.bus = bus
        self.graph_builder = StateGraph(State)

        # Create a wrapper function to pass bus to chatbot
        async def chatbot_wrapper(state: State):
            return await chatbot(state, bus=self.bus)

        # Add nodes
        self.graph_builder.add_node("chatbot", chatbot_wrapper)
        self.graph_builder.add_node("tools", self._execute_tools_via_bus)

        # Connect chatbot to tools or end
        self.graph_builder.add_conditional_edges(
            "chatbot",
            tools_condition,
        )

        # Connect tools back to chatbot or end
        self.graph_builder.add_conditional_edges("tools", self._tools_end_condition, {"END": END, "chatbot": "chatbot"})

        # Set entry point
        self.graph_builder.set_entry_point("chatbot")

        # Initialize memory - store is no longer needed as RAG is handled via bus
        self.memory = MemorySaver()

        # Compile graph without store (RAG operations go through bus)
        self.graph = self.graph_builder.compile(checkpointer=self.memory)

        # Save visualization
        self._save_graph_visualization()

        log_info("GraphOrchestrator initialized successfully")

    def _save_graph_visualization(self):
        """Save graph visualization to PNG file."""
        try:
            with open("./assets/graph.png", "wb") as f:
                f.write(self.graph.get_graph().draw_mermaid_png())
            log_debug("Graph visualization saved to ./assets/graph.png")
        except Exception as e:
            log_debug(f"Could not save graph visualization: {e}")

    async def _execute_tools_via_bus(self, state: State) -> dict[str, list[ToolMessage]]:
        """Execute tools via message bus.

        This node intercepts tool calls from the chatbot and executes them
        via the message bus instead of calling them directly.

        Args:
            state: Current graph state containing messages

        Returns:
            Updated state with tool execution results
        """
        messages = state["messages"]
        last_message = messages[-1]

        # Check if last message has tool calls
        if not hasattr(last_message, "tool_calls") or not last_message.tool_calls:
            log_debug("No tool calls found in last message")
            return {"messages": []}

        tool_messages = []

        # Execute each tool call via bus
        for tool_call in last_message.tool_calls:
            tool_name = tool_call["name"]
            tool_args = tool_call.get("args", {})
            tool_id = tool_call.get("id", "")

            log_debug(f"Executing tool via bus: {tool_name} with args: {tool_args}")

            try:
                # Send tool execution command via bus and wait for response
                result = await self.bus.request(
                    ToolingMethods.EXECUTE_TOOL,
                    ExecuteToolCommand(tool_name=tool_name, arguments=tool_args),
                    timeout=30.0,  # 30 second timeout for tool execution
                    priority=get_interactive_priority(),
                )

                if result.ok:
                    log_debug(f"Tool {tool_name} executed successfully")
                    tool_messages.append(
                        ToolMessage(
                            content=str(result.data),
                            tool_call_id=tool_id,
                            name=tool_name,
                        )
                    )
                else:
                    error_msg = result.error or "Unknown error"
                    log_error(f"Tool {tool_name} execution failed: {error_msg}")
                    tool_messages.append(
                        ToolMessage(
                            content=f"Error: {error_msg}",
                            tool_call_id=tool_id,
                            name=tool_name,
                        )
                    )

            except Exception as e:
                error_msg = f"Failed to execute tool via bus: {str(e)}"
                log_error(error_msg, exc_info=True)
                tool_messages.append(
                    ToolMessage(
                        content=f"Error: {error_msg}",
                        tool_call_id=tool_id,
                        name=tool_name,
                    )
                )

        return {"messages": tool_messages}

    def _tools_end_condition(
        self,
        state: Union[list[AnyMessage], dict[str, Any], BaseModel],
        messages_key: str = "messages",
    ) -> Literal["tools", "chatbot", "END"]:
        """Determine next step after tool execution.

        Args:
            state: Current graph state
            messages_key: Key to access messages in state

        Returns:
            Next node to execute ("chatbot" or "END")
        """
        if isinstance(state, list):
            ai_message = state[-1]
        elif isinstance(state, dict) and (messages := state.get(messages_key, [])):
            ai_message = messages[-1]
        elif messages := getattr(state, messages_key, []):
            ai_message = messages[-1]
        else:
            raise ValueError(f"No messages found in input state to tool_edge: {state}")

        if hasattr(ai_message, "content") and ai_message.content == "END":
            return "END"

        return "chatbot"

    async def _send_tts_via_bus(self, text: str, interrupt: bool = False):
        """Send TTS request via message bus.

        Args:
            text: Text to convert to speech
            interrupt: Whether to interrupt current playback
        """
        try:
            log_debug(f"Sending TTS request via bus: {text[:50]}...")
            await self.bus.publish(
                TTSMethods.REQUEST,
                TTSRequest(text=text, interrupt=interrupt),
                event=False,
                priority=get_interactive_priority(),
                origin="internal",
            )
        except Exception as e:
            log_error(f"Failed to send TTS request via bus: {e}", exc_info=True)

    async def stream_graph_updates(self, user_input: str, tts_result: bool = True) -> str:
        """Process user input through the graph with optional TTS output.

        Args:
            user_input: User's text input or custom message object
            tts_result: Whether to play result through TTS

        Returns:
            Assistant's response text
        """
        # Handle custom UIMessage objects
        input_content = user_input
        if hasattr(user_input, "text"):
            input_content = user_input.text
            log_debug(f"Graph: Processing input from custom object: {input_content[:30]}...")
        else:
            log_debug(f"Graph: Processing input: {str(user_input)[:30]}...")

        # Invoke the graph
        response = await self.graph.ainvoke(
            input={"messages": [{"role": "user", "content": input_content}]},
            config={"configurable": {"thread_id": "1"}},
            stream_mode="values",
        )

        # Get the LLM response text
        text = response["messages"][-1].content

        if text != "END":
            log_info(f"Jarvis: {text[:100]}...")
            # Send to TTS via bus if requested
            if tts_result:
                await self._send_tts_via_bus(text)
        else:
            log_debug("Graph: Response was END, not sending to TTS")

        return text

    async def process_text_input(self, user_input: str) -> str:
        """Process text input from UI without using TTS.

        Args:
            user_input: User's text input or custom message object

        Returns:
            Assistant's response text
        """
        # Handle custom UIMessage objects
        input_content = user_input
        if hasattr(user_input, "text"):
            input_content = user_input.text
            log_debug(f"Graph: Processing UI text input from object: {input_content[:30]}...")
        else:
            log_debug(f"Graph: Processing UI text input: {str(user_input)[:30]}...")

        # Invoke the graph
        response = await self.graph.ainvoke(
            input={"messages": [{"role": "user", "content": input_content}]},
            config={"configurable": {"thread_id": "1"}},
            stream_mode="values",
        )

        # Get the LLM response text
        text = response["messages"][-1].content

        if text != "END":
            log_info(f"Jarvis (UI text response): {text[:100]}...")
        else:
            log_debug("Graph: Response was END, not processing further")

        return text


# Global orchestrator instance (managed by OrchestratorService)
_orchestrator: GraphOrchestrator | None = None


def set_orchestrator(orchestrator: GraphOrchestrator) -> None:
    """Set the global orchestrator instance.

    This is called by OrchestratorService during initialization.

    Args:
        orchestrator: GraphOrchestrator instance
    """
    global _orchestrator
    _orchestrator = orchestrator


def get_orchestrator() -> GraphOrchestrator:
    """Get the global graph orchestrator instance.

    Returns:
        GraphOrchestrator instance

    Raises:
        RuntimeError: If called before orchestrator is initialized
    """
    if _orchestrator is None:
        raise RuntimeError("Orchestrator not initialized. Call OrchestratorService.start() first.")

    return _orchestrator


# Backward-compatible API
async def stream_graph_updates(user_input: str, ttsResult: bool = True) -> str:
    """Process user input through the graph with optional TTS output.

    This is a backward-compatible wrapper around GraphOrchestrator.

    Args:
        user_input: User's text input
        ttsResult: Whether to play result through TTS

    Returns:
        Assistant's response text
    """
    orchestrator = get_orchestrator()
    return await orchestrator.stream_graph_updates(user_input, ttsResult)


async def process_text_input(user_input: str) -> str:
    """Process text input from UI without using TTS.

    This is a backward-compatible wrapper around GraphOrchestrator.

    Args:
        user_input: User's text input

    Returns:
        Assistant's response text
    """
    orchestrator = get_orchestrator()
    return await orchestrator.process_text_input(user_input)
