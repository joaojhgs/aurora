import os

from langchain_openai import ChatOpenAI
from modules.langgraph.state import State
from modules.langgraph.tools.tools import tools

"""
The voice_assistant agent is a secondary agent whose purpose is to solely convert the result of the chatbot and tool calling into a voice friendly response.
"""

# Init LLM
llm = ChatOpenAI(model="gpt-3.5-turbo", api_key=os.environ['OPENAI_API_KEY'])

# Def the chatbot node
def voice_assistant(state: State):
    return {
        "messages": [
            llm.invoke([
                {
                    "role": "system",
                    "content": (
                        "You are a voice assistant converter agent called Jarvis. "
                        "Your sole purpose is to convert the final result of the assistant called Jarvis into a voice friendly text response. "
                        "Remove all markdown and links from the final text."
                    )
                },
                state["messages"][-1]
            ])
        ]
    }