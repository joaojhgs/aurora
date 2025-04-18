from typing import Any, Literal, Union
from langgraph.graph import StateGraph, END
from modules.langgraph.state import State
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.checkpoint.memory import MemorySaver
from modules.langgraph.agents.chatbot import chatbot
from modules.langgraph.tools.tools import tools
from pydantic import BaseModel
from langchain_core.messages import AnyMessage

from modules.langgraph.memory_store import store
from modules.text_to_speech.tts import play

graph_builder = StateGraph(State)

# Init tools node
tool_node = ToolNode(tools=tools)
graph_builder.add_node("tools", tool_node)

# Add the chatbot agent node
graph_builder.add_node("chatbot", chatbot)

# Connect the chatbot agent and the tool nodes
graph_builder.add_conditional_edges(
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

graph_builder.add_conditional_edges(
    "tools",
    tools_end_condition,
    {
        "END": END,
        "chatbot": "chatbot"
    }
)

# Add an edge from the tools node to the chatbot node
# graph_builder.add_edge("tools", "chatbot")

# # Conectar o voice_agent ao final do grafo
# graph_builder.add_edge("voice_assistant", END)

# Set the entry point to the chatbot
graph_builder.set_entry_point("chatbot")

memory = MemorySaver()

# Compile the graph
graph = graph_builder.compile(checkpointer=memory, store=store)

# Save the graph
try:
    with open("./graph.png", "wb") as f:
        f.write(graph.get_graph().draw_mermaid_png())
except Exception:
    # This requires some extra dependencies and is optional
    pass

# The `stream_graph_updates` function takes user input and streams it through the graph, printing the assistant's responses
def stream_graph_updates(user_input: str):

    response = graph.invoke(
        input={"messages": [{"role": "user", "content": user_input}]},
        # Hard coded thread id, it will keep all interactions saved in memory in the same thread
        config={"configurable": {"thread_id": "1"}},
        stream_mode="values",
    )
    print(response)
    text = response['messages'][-1].content
    if(text != "END"):
        print("\nJarvis:", response['messages'][-1].content)
        play(text)
    return text
    