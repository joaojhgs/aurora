"""Product-level Aurora event stream contract models."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from app.shared.contracts.registry import IOModel


class AuroraModule:
    """Module identifier for cross-service Aurora contracts."""

    NAME = "Aurora"


class AuroraMethods:
    """Full method identifiers for product-level Aurora contracts."""

    EVENT_STREAM = f"{AuroraModule.NAME}.EventStream"


AuroraEventCategory = Literal[
    "assistant",
    "capability",
    "peer",
    "pairing",
    "route",
    "tool_progress",
    "tool_approval",
    "tool_execution",
    "data",
    "audio",
    "scheduler",
    "admin_action",
    "audit",
    "service",
    "config",
    "unknown",
]


class AuroraEventStreamEvent(IOModel):
    """Normalized event visible to SDK/UI event subscribers.

    ``redacted_payload`` is the only payload persisted in Gateway history and
    support bundles. ``payload`` is optional and is only populated for live,
    interactive streams that need display text (for example assistant chat and
    STT transcript projection); it must never carry raw audio, credentials, or
    tool arguments.
    """

    event_id: str
    topic: str
    kind: str = ""
    category: AuroraEventCategory = "unknown"
    action: str = ""
    status: str = ""
    severity: Literal["info", "warning", "error"] = "info"
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    correlation_id: str | None = None
    source_peer_id: str | None = None
    target_peer_id: str | None = None
    provider_id: str | None = None
    tool_id: str | None = None
    resource_id: str | None = None
    route: str | None = None
    policy_decision_id: str | None = None
    principal_id: str | None = None
    payload: dict[str, Any] | None = None
    redacted_payload: dict[str, Any] = Field(default_factory=dict)
    payload_sha256: str = ""
