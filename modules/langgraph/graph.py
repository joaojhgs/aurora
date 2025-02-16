from langgraph.graph import StateGraph, END
from modules.langgraph.state import State
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.checkpoint.memory import MemorySaver
from modules.langgraph.agents.chatbot import chatbot
from modules.langgraph.agents.voice_assistant import voice_assistant
from modules.langgraph.tools.tools import tools

from modules.langgraph.memory_store import store
from modules.text_to_speech.tts import play
from langchain_core.messages.ai import AIMessageChunk

graph_builder = StateGraph(State)

# Init tools node
tool_node = ToolNode(tools=tools)
graph_builder.add_node("tools", tool_node)

# Add the chatbot agent node
graph_builder.add_node("chatbot", chatbot)

# Add the voice assistant agent node
# graph_builder.add_node("voice_assistant", voice_assistant)

# def custom_router(state: State):
#     if(tools_condition(state) == 'tools'):
#         return "tools"
#     return "voice_assistant"

# Connect the chatbot agent and the tool nodes
graph_builder.add_conditional_edges(
    "chatbot",
    tools_condition,
)

# Add an edge from the tools node to the chatbot node
graph_builder.add_edge("tools", "chatbot")

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
    def generate_response(user_input: str):
        for message in graph.stream(
            input={"messages": [{"role": "user", "content": user_input}]},
            # Hard coded thread id, it will keep all interactions saved in memory in the same thread
            config={"configurable": {"thread_id": "1"}},
            stream_mode="messages"
        ):
            if isinstance(message[0], AIMessageChunk):
                
                yield message[0].content
    response = ''.join(chunk for chunk in generate_response(user_input))
    
    print("Jarvis:", response)
    play(response)
    