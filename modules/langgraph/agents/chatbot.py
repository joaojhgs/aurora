import os

from langchain_openai import ChatOpenAI
from langgraph.store.base import BaseStore
from modules.langgraph.state import State
from modules.langgraph.tools.tools import tools

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
                    {"role": "system", "content": f"You are a helpful assistant called Jarvis.\n{memories}"},
                    *state["messages"]
                ])
            ]
        }