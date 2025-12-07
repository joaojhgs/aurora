import uuid
from typing import Annotated, Optional

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedStore
from langgraph.store.base import BaseStore

from app.shared.contracts.models.db import DBMethods, DBRAGStoreRequest


@tool
async def upsert_memory_tool(
    content: str,
    bus,
    *,
    memory_id: uuid.UUID | None = None,
    store: Annotated[BaseStore, InjectedStore],
):
    """
    Upsert a memory in the database if the LLM deems the user input being important information.
    If the memory_id is not provided, a new memory will be created.
    If the LLM has been feeded memories, it can use this tool to update them with their ID if it deems the user changed it.

    Args:
        content: The memory content to store
        bus: MessageBus instance for communication (injected by ToolingService)
        memory_id: Optional existing memory ID to update
        store: LangGraph store for persistence (kept for backward compatibility, but not used)
    """
    # The LLM can use this tool to store a new memory via bus
    mem_id = memory_id or uuid.uuid4()

    # Store via bus instead of direct store access
    await bus.publish(
        DBMethods.RAG_STORE,
        DBRAGStoreRequest(
            namespace="main.memories",
            key=str(mem_id),
            value={"text": content},
            index=True,
        ),
        event=False,
    )
    return f"Stored memory {mem_id}"
