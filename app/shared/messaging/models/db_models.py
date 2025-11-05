"""Database service message models."""

from __future__ import annotations

from pydantic import BaseModel

from app.messaging import Command, Query


class StoreMessage(Command):
    """Command to store a message in history."""

    role: str
    content: str
    session_id: str | None = None
    metadata: dict = {}


class GetRecentMessages(Query):
    """Query to retrieve recent messages."""

    limit: int = 10
    session_id: str | None = None


class GetMessagesForDate(Query):
    """Query to retrieve messages for a specific date."""

    date: str | None = None  # ISO format date string (YYYY-MM-DD), None = today


class MessagesResponse(BaseModel):
    """Response containing a list of messages."""

    messages: list[dict]  # List of message dictionaries


class StoreCronJob(Command):
    """Command to store a cron job."""

    name: str
    schedule: str
    action: str
    enabled: bool = True


class GetCronJobs(Query):
    """Query to retrieve all cron jobs."""

    enabled_only: bool = False


class DeleteCronJob(Command):
    """Command to delete a cron job."""

    job_id: int


# RAG Message definitions
class RAGStoreCommand(Command):
    """Command to store an item in RAG vector store."""

    namespace: tuple[str, ...]
    key: str
    value: dict
    index: list[str] | None = None


class RAGDeleteCommand(Command):
    """Command to delete an item from RAG vector store."""

    namespace: tuple[str, ...]
    key: str


class RAGSearchQuery(Query):
    """Query to search items in RAG vector store."""

    namespace: tuple[str, ...]
    query: str
    limit: int = 10
    offset: int = 0


class RAGGetQuery(Query):
    """Query to get an item from RAG vector store."""

    namespace: tuple[str, ...]
    key: str


class RAGListQuery(Query):
    """Query to list items in RAG vector store."""

    namespace: tuple[str, ...]
    limit: int = 100
    offset: int = 0


class RAGItemResponse(BaseModel):
    """Response containing a RAG item."""

    namespace: tuple[str, ...]
    key: str
    value: dict | None = None
    search_score: float | None = None


class RAGListResponse(BaseModel):
    """Response containing a list of RAG items."""

    items: list[RAGItemResponse]
