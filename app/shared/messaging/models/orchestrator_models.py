"""Orchestrator service message models."""

from __future__ import annotations

from enum import Enum
from typing import Any

from app.messaging import Command, Event


class MessageSource(Enum):
    """Message source types."""

    STT = "user"
    TEXT = "system"


class UserInput(Command):
    """Command representing user input for processing."""

    text: str
    source: str = "stt"  # "stt", "ui", "external"
    session_id: str | None = None


class LLMResponseReady(Event):
    """Event emitted when LLM response is ready."""

    text: str
    session_id: str | None = None
    metadata: dict = {}


class ToolRequest(Command):
    """Command to execute a tool."""

    tool_name: str
    parameters: dict
    request_id: str


class ToolResult(Event):
    """Event with tool execution result."""

    request_id: str
    result: Any
    success: bool
    error: str | None = None


# Legacy AuroraMessage class (for backward compatibility)
class AuroraMessage:
    """Legacy message class (for backward compatibility)."""

    def __init__(self, text, source: MessageSource = MessageSource.STT):
        """Initialize AuroraMessage.

        Args:
            text: Message text
            source: Message source
        """
        self.text = text
        self.source = source
        # Time marker used to uniquely identify this message
        from datetime import datetime

        self.timestamp = datetime.now().timestamp()

    def __str__(self):
        """Return message text."""
        return self.text
