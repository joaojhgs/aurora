import os

from langchain_openai import ChatOpenAI
from langgraph.store.base import BaseStore
from modules.langgraph.ChatLlamaCpp import ChatLlamaCpp
from modules.langgraph.state import State
from modules.langgraph.tools.tools import get_tools

"""
The chatbot agent is the main agent coordinator in the graph.
"""

# Init LLM
llm = None

if os.environ.get('OPENAI_CHAT_MODEL'):
    llm = ChatOpenAI(
        model=os.environ['OPENAI_CHAT_MODEL'],
        api_key=os.environ['OPENAI_API_KEY']
    )
elif os.environ.get('LLAMMA_CPP_MODEL_PATH'):
    llm = ChatLlamaCpp(
        chat_format="chatml-function-calling",
        min_p=0.0,
        top_p=0.95,
        temperature=1.0,
        top_k=64,
        repeat_penalty=1.0,
        model_path=os.environ.get('LLAMMA_CPP_MODEL_PATH'),
        n_ctx=2048,
        n_gpu_layers=0,
        n_batch=1000,  # Should be between 1 and n_ctx, consider the amount of VRAM in your GPU.
        max_tokens=256*2,
        disable_streaming=True,
    )

# Def the chatbot node
def chatbot(state: State, store: BaseStore):
    # Check if llm is initialized
    if llm is None:
        raise ValueError("The language model (llm) is not initialized.")

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
                            "Alway respond in the language of the user"
                            f"{memories}"
                            f"\nCurrent time: {os.popen('date').read().strip()}"
                        )
                    },
                    *state["messages"],
                ])
            ]
        }