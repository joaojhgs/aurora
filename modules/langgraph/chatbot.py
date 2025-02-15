from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph
import os

from modules.langgraph.tools.brave_search import search_brave_tool
from modules.langgraph.tools.upsert_memory import upsert_memory_tool
from modules.langgraph.state import State
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.base import BaseStore
from modules.langgraph.memory_store import store
from modules.tts import play
from langchain_core.messages.ai import AIMessageChunk

graph_builder = StateGraph(State)

# Init tools
tools = [search_brave_tool, upsert_memory_tool]

# Init LLM
llm = ChatOpenAI(model="gpt-3.5-turbo", api_key=os.environ['OPENAI_API_KEY'])

# Bind tools to the LLM
llm_with_tools = llm.bind_tools(tools)

# Init tools node
tool_node = ToolNode(tools=tools)
graph_builder.add_node("tools", tool_node)

# Def the chatbot node
def chatbot(state: State, store: BaseStore):
    # Vector search for the history of memories
    
    items = store.search(
        ("main", "memories"), query=state["messages"][-1].content, limit=3
    )
    print("memory items", items)
    memories = "\n".join(f"{item.value['text']} (score: {item.score})" for item in items)
    memories = f"## Similar memories\n{memories}" if memories else ""
    
    return {
            "messages": [
                llm_with_tools.invoke([
                    {"role": "system", "content": f"You are a helpful assistant called Jarvis.\n{memories}"},
                    *state["messages"]
                ])
            ]
        }

graph_builder.add_node("chatbot", chatbot)

graph_builder.add_conditional_edges(
    "chatbot",
    tools_condition,
)

# Add an edge from the tools node to the chatbot node
graph_builder.add_edge("tools", "chatbot")

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
    def generate_responses(user_input: str):
        for message in graph.stream(
            input={"messages": [{"role": "user", "content": user_input}]},
            # Hard coded thread id, it will keep all interactions saved in memory in the same thread
            config={"configurable": {"thread_id": "1"}},
            stream_mode="messages"
        ):
            if isinstance(message[0], AIMessageChunk):
                print(message[0].content)
                yield message[0].content
    # generate_responses(user_input)
    play(generate_responses(user_input))
    