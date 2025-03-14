import os

from langchain_openai import ChatOpenAI
from langgraph.store.base import BaseStore
from modules.langgraph.state import State
from modules.langgraph.tools.tools import get_tools

"""
The chatbot agent is the main agent coordinator in the graph.
"""

# Init LLM
llm = ChatOpenAI(model="gpt-3.5-turbo", api_key=os.environ['OPENAI_API_KEY'])

# Def the chatbot node
def chatbot(state: State, store: BaseStore):
    # Vector search for the history of memories
    
    items = store.search(
        ("main", "memories"), query=state["messages"][-1].content, limit=3
    )
    memories = "\n".join(f"{item.value['text']} (score: {item.score})" for item in items)
    memories = f"## Similar memories\n{memories}" if memories else ""

    # RAG Search tools to bind for each chatbot call
    # Reduce the top_k parameter to reduce token usage
    # Be carefull to not reduce too much, the RAG is quite simplistic, it might miss relevant tools if top_k is too small
    # It might need adjusting depending on how much plugins you are using as well, +plugins = +tools to load
    llm_with_tools = llm.bind_tools(get_tools(state["messages"][-1].content, 8))
    
    return {
            "messages": [
                llm_with_tools.invoke([
                    {
                        "role": "system",
                        "content": (
                            "You are a helpful voice assistant called Jarvis.\n"
                            "Be as concise as possible and provide the user with the most relevant information.\n"
                            "You are a voice assistant, so make all responses voice friendly, remove markdown and links.\n"
                            "Make sure to provide the user with the most relevant information and be concise."
                            f"{memories}"
                            f"\nCurrent time: {os.popen('date').read().strip()}"
                        )
                    },
                    *state["messages"]
                ])
            ]
        }