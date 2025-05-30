import uuid
from typing import Optional

from langchain.chat_models import init_chat_model
from langgraph.prebuilt import InjectedStore
from langgraph.store.base import BaseStore
from typing_extensions import Annotated
from langchain_core.tools import tool

@tool
def upsert_memory_tool(
    content: str,
    *,
    memory_id: Optional[uuid.UUID] = None,
    store: Annotated[BaseStore, InjectedStore],
):
    """
    Upsert a memory in the database if the LLM deems the user input being important information.
    If the memory_id is not provided, a new memory will be created.
    If the LLM has been feeded memories, it can use this tool to update them with their ID if it deems the user changed it.
    """
    # The LLM can use this tool to store a new memory
    mem_id = memory_id or uuid.uuid4()
    store.put(
        ("main", "memories"),
        key=str(mem_id),
        value={"text": content},
    )
    return f"Stored memory {mem_id}"