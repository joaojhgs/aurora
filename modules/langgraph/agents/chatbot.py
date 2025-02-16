import os

from langchain_openai import ChatOpenAI
from langgraph.store.base import BaseStore
from modules.langgraph.state import State
from modules.langgraph.tools.tools import tools

"""
The chatbot agent is the main agent coordinator in the graph.
"""

# Init LLM
llm = ChatOpenAI(model="gpt-3.5-turbo", api_key=os.environ['OPENAI_API_KEY'])

# Bind tools to the LLM
llm_with_tools = llm.bind_tools(tools)

# Def the chatbot node
def chatbot(state: State, store: BaseStore):
    # Vector search for the history of memories
    
    items = store.search(
        ("main", "memories"), query=state["messages"][-1].content, limit=3
    )
    memories = "\n".join(f"{item.value['text']} (score: {item.score})" for item in items)
    memories = f"## Similar memories\n{memories}" if memories else ""
    
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
                        )
                    },
                    *state["messages"]
                ])
            ]
        }