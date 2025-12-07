"""DB (Database) service contract models."""

from typing import Any

from app.shared.contracts.registry import IOModel


# Module identifier
class DBModule:
    """Module identifier for DB service."""

    NAME = "DB"


# Method identifiers
class DBMethods:
    """Full method identifiers for DB service."""

    SAVE_MESSAGE = f"{DBModule.NAME}.SaveMessage"
    GET_MESSAGES = f"{DBModule.NAME}.GetMessages"
    GET_MESSAGES_FOR_DATE = f"{DBModule.NAME}.GetMessagesForDate"
    DELETE_MESSAGE = f"{DBModule.NAME}.DeleteMessage"
    UPDATE_MESSAGE = f"{DBModule.NAME}.UpdateMessage"
    RAG_SEARCH = f"{DBModule.NAME}.RAGSearch"
    RAG_STORE = f"{DBModule.NAME}.RAGStore"
    RAG_DELETE = f"{DBModule.NAME}.RAGDelete"
    RAG_GET = f"{DBModule.NAME}.RAGGet"
    RAG_LIST = f"{DBModule.NAME}.RAGList"
    SAVE_CRON_JOB = f"{DBModule.NAME}.SaveCronJob"
    GET_CRON_JOBS = f"{DBModule.NAME}.GetCronJobs"
    DELETE_CRON_JOB = f"{DBModule.NAME}.DeleteCronJob"


class DBSaveMessageRequest(IOModel):
    """Request to save a message to the database."""

    content: str
    role: str
    message_type: str = "TEXT"
    metadata: dict[str, Any] | None = None


class DBSaveMessageResponse(IOModel):
    """Response after saving a message."""

    message_id: int
    success: bool = True


class DBGetMessagesRequest(IOModel):
    """Request to retrieve messages from the database."""

    limit: int = 50
    offset: int = 0
    role: str | None = None
    message_type: str | None = None


class DBGetMessagesResponse(IOModel):
    """Response with retrieved messages."""

    messages: list[dict[str, Any]]
    total: int
    has_more: bool


class DBGetMessagesForDateRequest(IOModel):
    """Request to retrieve messages for a specific date."""

    date: str | None = None  # ISO format YYYY-MM-DD


class DBCronJob(IOModel):
    """Cron job model."""

    id: str | None = None
    name: str
    schedule: str
    action: str
    enabled: bool = True


class DBStoreCronJobRequest(IOModel):
    """Request to store a cron job."""

    name: str
    schedule: str
    action: str
    enabled: bool = True


class DBGetCronJobsRequest(IOModel):
    """Request to get cron jobs."""

    enabled_only: bool = False


class DBGetCronJobsResponse(IOModel):
    """Response with cron jobs."""

    jobs: list[dict[str, Any]]


class DBDeleteCronJobRequest(IOModel):
    """Request to delete a cron job."""

    job_id: str


class DBRAGStoreRequest(IOModel):
    """Request to store an item in RAG."""

    namespace: str
    key: str
    value: Any
    index: bool = True


class DBRAGDeleteRequest(IOModel):
    """Request to delete an item from RAG."""

    namespace: str
    key: str


class DBRAGSearchRequest(IOModel):
    """Request to search RAG."""

    namespace: str
    query: str
    limit: int = 10
    offset: int = 0


class DBRAGGetRequest(IOModel):
    """Request to get a specific RAG item."""

    namespace: str
    key: str


class DBRAGListRequest(IOModel):
    """Request to list RAG items."""

    namespace: str
    limit: int = 100
    offset: int = 0


class DBRAGItemResponse(IOModel):
    """RAG item response."""

    key: str
    value: Any
    namespace: str
    search_score: float | None = None


class DBRAGListResponse(IOModel):
    """Response for RAG list/search."""

    items: list[DBRAGItemResponse]
