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

    event_id: str = Field(min_length=1, max_length=256)
    topic: str = Field(min_length=1, max_length=256)
    kind: str = Field(default="", max_length=128)
    category: AuroraEventCategory = "unknown"
    action: str = Field(default="", max_length=128)
    status: str = Field(default="", max_length=128)
    severity: Literal["info", "warning", "error"] = "info"
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat(), max_length=64)
    correlation_id: str | None = Field(default=None, min_length=1, max_length=256)
    source_peer_id: str | None = Field(default=None, min_length=1, max_length=256)
    target_peer_id: str | None = Field(default=None, min_length=1, max_length=256)
    provider_id: str | None = Field(default=None, min_length=1, max_length=256)
    tool_id: str | None = Field(default=None, min_length=1, max_length=256)
    resource_id: str | None = Field(default=None, min_length=1, max_length=256)
    route: str | None = Field(default=None, min_length=1, max_length=256)
    policy_decision_id: str | None = Field(default=None, min_length=1, max_length=256)
    principal_id: str | None = Field(default=None, min_length=1, max_length=256)
    payload: dict[str, Any] | None = Field(default=None, max_length=64)
    redacted_payload: dict[str, Any] = Field(default_factory=dict, max_length=64)
    payload_sha256: str = Field(default="", max_length=64)
