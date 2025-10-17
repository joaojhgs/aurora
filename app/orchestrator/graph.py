from typing import Any, Literal, Union

from langchain_core.messages import AnyMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_info
from app.orchestrator.agents.chatbot import chatbot
from app.orchestrator.memory_store import get_combined_store
from app.orchestrator.state import State
from app.tts.tts_engine import play

# Lazy initialization to avoid premature tool loading
_graph = None
_graph_builder = None
_memory = None
_store = None


def _build_graph_if_needed():
    """Build the graph lazily on first use.

    This ensures tools are only loaded when actually needed,
    preventing double initialization issues.
    """
    global _graph, _graph_builder, _memory, _store

    if _graph is not None:
        return _graph

    log_debug("Building LangGraph (lazy initialization)...")

    # Import tools lazily to avoid premature initialization
    from app.tooling.tools.tools import tools

    log_debug("Loaded tools from app.tooling.tools")

    _graph_builder = StateGraph(State)

    # Init tools node
    tool_node = ToolNode(tools=tools)
    _graph_builder.add_node("tools", tool_node)

    # Add the chatbot agent node
    _graph_builder.add_node("chatbot", chatbot)

    # Connect the chatbot agent and the tool nodes
    _graph_builder.add_conditional_edges(
        "chatbot",
        tools_condition,
    )

    def tools_end_condition(
        state: Union[list[AnyMessage], dict[str, Any], BaseModel],
        messages_key: str = "messages",
    ) -> Literal["tools", "__end__"]:
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

    _graph_builder.add_conditional_edges("tools", tools_end_condition, {"END": END, "chatbot": "chatbot"})

    # Set the entry point to the chatbot
    _graph_builder.set_entry_point("chatbot")

    _memory = MemorySaver()
    _store = get_combined_store()

    # Compile the graph
    _graph = _graph_builder.compile(checkpointer=_memory, store=_store)

    # Save the graph visualization
    try:
        with open("./assets/graph.png", "wb") as f:
            f.write(_graph.get_graph().draw_mermaid_png())
    except Exception:
        # This requires some extra dependencies and is optional
        pass

    log_info("LangGraph built successfully")
    return _graph


def get_graph():
    """Get the compiled graph, building it lazily if needed."""
    return _build_graph_if_needed()


def get_graph_builder():
    """Get the graph builder, building it lazily if needed."""
    _build_graph_if_needed()
    return _graph_builder


# The `stream_graph_updates` function takes user input and streams it
# through the graph, printing the assistant's responses
async def stream_graph_updates(user_input: str, ttsResult: bool = True):
    # Handle custom UIMessage objects
    input_content = user_input

    if hasattr(user_input, "text"):
        input_content = user_input.text
        log_debug(f"Graph: Processing input from custom object: {input_content[:30]}...")
    else:
        log_debug(f"Graph: Processing input: {str(user_input)[:30]}...")

    # Get the lazily-built graph
    graph_instance = get_graph()

    # Invoke the graph with the user input
    response = await graph_instance.ainvoke(
        input={"messages": [{"role": "user", "content": input_content}]},
        # Hard coded thread id, it will keep all interactions saved in memory in the same thread
        config={"configurable": {"thread_id": "1"}},
        stream_mode="values",
    )

    # Get the LLM response text
    text = response["messages"][-1].content

    if text != "END":
        log_info(f"Jarvis: {text}...")
        # Play the text through TTS - this is used for STT messages that need speech output
        if ttsResult:
            play(text)
    else:
        log_debug("Graph: Response was END, not sending to TTS")

    return text


# New function for text input that doesn't use TTS
async def process_text_input(user_input: str):
    """Process text input from UI without using TTS"""
    # Handle custom UIMessage objects
    input_content = user_input
    if hasattr(user_input, "text"):
        input_content = user_input.text
        log_debug(f"Graph: Processing UI text input from object: {input_content[:30]}...")
    else:
        log_debug(f"Graph: Processing UI text input: {str(user_input)[:30]}...")

    # Get the lazily-built graph
    graph_instance = get_graph()

    # Invoke the graph with the user input
    response = await graph_instance.ainvoke(
        input={"messages": [{"role": "user", "content": input_content}]},
        # Hard coded thread id, it will keep all interactions saved in memory in the same thread
        config={"configurable": {"thread_id": "1"}},
        stream_mode="values",
    )

    # Get the LLM response text
    text = response["messages"][-1].content

    if text != "END":
        log_info(f"Jarvis (UI text response): {text[:100]}...")
        # No TTS for UI text input
    else:
        log_debug("Graph: Response was END, not processing further")

    return text
