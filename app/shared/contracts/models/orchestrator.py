from __future__ import annotations

from typing import Any, Dict, Optional

from app.shared.contracts.registry import IOModel


# Module identifier
class OrchestratorModule:
    """Module identifier for Orchestrator service."""

    NAME = "Orchestrator"


# Method identifiers
class OrchestratorMethods:
    """Full method identifiers for Orchestrator service."""

    USER_INPUT = f"{OrchestratorModule.NAME}.UserInput"
    EXTERNAL_USER_INPUT = f"{OrchestratorModule.NAME}.ExternalUserInput"
    TOOL_RESULT = f"{OrchestratorModule.NAME}.ToolResult"
    RESPONSE = f"{OrchestratorModule.NAME}.Response"


class OrchestratorProcessRequest(IOModel):
    """Request to process user input."""

    text: str
    source: str = "external"
    session_id: str | None = None


class OrchestratorResponse(IOModel):
    """Response from orchestrator."""

    text: str
    session_id: str | None = None
    metadata: dict[str, Any] = {}


class OrchestratorToolResultRequest(IOModel):
    """Request to process a tool result."""

    request_id: str
    result: Any
    error: str | None = None
