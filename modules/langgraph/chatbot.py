from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph
import os

from modules.langgraph.tools.brave_search import init_brave_search_tool
from modules.langgraph.state import State
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.checkpoint.memory import MemorySaver

graph_builder = StateGraph(State)

# Init tools
tools = [init_brave_search_tool()]

# Init LLM
llm = ChatOpenAI(model="gpt-3.5-turbo", api_key=os.environ['OPENAI_API_KEY'])

# Bind tools to the LLM
llm_with_tools = llm.bind_tools(tools)

# Init tools node
tool_node = ToolNode(tools=tools)
graph_builder.add_node("tools", tool_node)

# Def the chatbot node
def chatbot(state: State):
    return {"messages": [llm_with_tools.invoke(state["messages"])]}

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
graph = graph_builder.compile(checkpointer=memory)

# Save the graph
try:
    with open("./graph.png", "wb") as f:
        f.write(graph.get_graph().draw_mermaid_png())
except Exception:
    # This requires some extra dependencies and is optional
    pass

# The `stream_graph_updates` function takes user input and streams it through the graph, printing the assistant's responses
def stream_graph_updates(user_input: str):
    for event in graph.stream(
        {"messages": [{"role": "user", "content": user_input}]},
        # Hard coded thread id, it will keep all interactions saved in memory in the same thread
        {"configurable": {"thread_id": "1"}}
        ):
        for value in event.values():
            print("Assistant:", value["messages"][-1].content)

# def stream_graph_updates_with_text(user_input: str):
#     print("Assistant:")
#     def generator():
#         for event in graph.stream({"messages": [{"role": "user", "content": user_input}]}):
#             for value in event.values():
#                 print(value["messages"][-1].content)
#                 yield value["messages"][-1].content
    