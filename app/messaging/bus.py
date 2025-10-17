"""Message Bus abstraction for Aurora's messaging system.

This module defines the core messaging abstractions including:
- MessageBus Protocol for pluggable transport implementations
- Envelope for transport-agnostic message wrapping
- Base message types (Event, Command, Query, QueryResult)
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable
from datetime import datetime
from typing import Any, Callable, Optional, Protocol

from pydantic import BaseModel, Field


class Envelope(BaseModel):
    """Transport envelope for all messages.

    Attributes:
        id: Unique message identifier
        type: Message type (e.g., "TTS.Request", "STT.TranscriptionDetected")
        payload: The actual message content (must be a BaseModel)
        reply_to: Optional topic/queue for replies
        correlation_id: For request/response correlation
        timestamp: Message creation timestamp
        origin: Message origin ("internal" | "external" | "system")
        priority: Message priority (0=highest, 99=lowest)
        deadline_ms: Optional deadline in milliseconds
        attempts: Number of delivery attempts
        max_attempts: Maximum retry attempts before dead-letter
    """

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    type: str
    payload: BaseModel
    reply_to: str | None = None
    correlation_id: str | None = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    origin: str = "internal"
    priority: int = 50
    deadline_ms: int | None = None
    attempts: int = 0
    max_attempts: int = 3

    class Config:
        arbitrary_types_allowed = True


class Event(BaseModel):
    """Base class for event messages (broadcast, best-effort)."""

    pass


class Command(BaseModel):
    """Base class for command messages (point-to-point, reliable)."""

    pass


class Query(BaseModel):
    """Base class for query messages (request/response)."""

    pass


class QueryResult(BaseModel):
    """Standard query response wrapper.

    Attributes:
        ok: Whether the query succeeded
        data: Query result data
        error: Error message if query failed
    """

    ok: bool
    data: Any = None
    error: str | None = None


# Type alias for message handlers
Handler = Callable[[Envelope], Awaitable[None]]


class MessageBus(Protocol):
    """Protocol defining the MessageBus interface.

    Implementations:
    - LocalBus: In-process asyncio-based bus for thread mode
    - BullMQBus: Redis-backed bus for process/microservices mode
    """

    async def start(self) -> None:
        """Start the message bus and any background workers."""
        ...

    async def stop(self) -> None:
        """Stop the message bus and cleanup resources."""
        ...

    async def publish(
        self,
        topic: str,
        message: BaseModel,
        *,
        event: bool = True,
        priority: int = 50,
        origin: str = "internal",
        reliable: bool = True,
        ttl_ms: int | None = None,
        max_attempts: int = 3,
    ) -> None:
        """Publish a message to a topic.

        Args:
            topic: Topic name (e.g., "TTS.Request", "STT.TranscriptionDetected")
            message: Message payload (must be a BaseModel)
            event: True for broadcast events, False for point-to-point commands
            priority: Message priority (0=highest, 99=lowest)
            origin: Message origin ("internal" | "external" | "system")
            reliable: Whether to guarantee delivery (with retries)
            ttl_ms: Time-to-live in milliseconds
            max_attempts: Maximum retry attempts
        """
        ...

    async def request(
        self,
        topic: str,
        message: BaseModel,
        *,
        priority: int = 50,
        origin: str = "internal",
        timeout: float = 5.0,
        ttl_ms: int | None = None,
        max_attempts: int = 3,
    ) -> QueryResult:
        """Send a request and wait for a response.

        Args:
            topic: Topic name for the request
            message: Request payload (must be a BaseModel)
            priority: Message priority (0=highest, 99=lowest)
            origin: Message origin ("internal" | "external" | "system")
            timeout: Response timeout in seconds
            ttl_ms: Time-to-live in milliseconds
            max_attempts: Maximum retry attempts

        Returns:
            QueryResult containing the response data or error
        """
        ...

    def subscribe(self, topic: str, handler: Handler) -> None:
        """Subscribe to a topic with a handler.

        Args:
            topic: Topic pattern (supports wildcards, e.g., "TTS.*")
            handler: Async function to handle messages
        """
        ...
