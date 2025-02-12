from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END
from typing import Annotated
from typing_extensions import TypedDict
from langgraph.graph.message import add_messages
import os

# New messages from both the user and the assistant are persisted in the state
class State(TypedDict):
    # Messages have the type "list". The `add_messages` function
    # in the annotation defines how this state key should be updated
    # (in this case, it appends messages to the list, rather than overwriting them)
    messages: Annotated[list, add_messages]

graph_builder = StateGraph(State)

llm = ChatOpenAI(model="gpt-3.5-turbo", api_key=os.environ['OPEN_API_KEY'])

def chatbot(state: State):
    return {"messages": [llm.invoke(state["messages"])]}
# Add the chatbot node to the graph, connecting it to the START and END nodes, meaning the start of interaction and the end of interaction will be controlled by the chatbot node.
graph_builder.add_node("chatbot", chatbot)
graph_builder.add_edge(START, "chatbot")
graph_builder.add_edge("chatbot", END)

# Compile the graph
graph = graph_builder.compile()

# The `stream_graph_updates` function takes user input and streams it through the graph, printing the assistant's responses
def stream_graph_updates(user_input: str):
    for event in graph.stream({"messages": [{"role": "user", "content": user_input}]}):
        for value in event.values():
            print("Assistant:", value["messages"][-1].content)