"""Immutable provider-local Tooling identity primitives.

This module deliberately excludes persistence and export-policy decisions.  It
defines the canonical wire key and the loader stamp consumed by later G011
slices.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote, unquote

TOOL_ID_SCHEME = "aurora-tool"
TOOL_ID_VERSION = 1
TOOL_CONTRACT_NAMESPACE = "Tooling"
MAX_ID_COMPONENT_LENGTH = 160
MAX_GROUP_LABEL_LENGTH = 120
MAX_LEGACY_ALIASES = 16
MAX_LEGACY_ALIAS_LENGTH = 512


class ToolIdentityError(ValueError):
    """Raised when an authority-bearing Tooling identity is malformed."""


class ToolIdentityCollisionError(ToolIdentityError):
    """Raised when two loaded tools claim one canonical contract identity."""


def _validate_component(
    value: str, label: str, *, max_length: int = MAX_ID_COMPONENT_LENGTH
) -> str:
    if not isinstance(value, str) or value != value.strip() or not value:
        raise ToolIdentityError(f"{label} must be a non-empty trimmed string")
    if len(value) > max_length:
        raise ToolIdentityError(f"{label} exceeds {max_length} characters")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise ToolIdentityError(f"{label} contains control characters")
    return value


def _encode_component(value: str, label: str) -> str:
    return quote(_validate_component(value, label), safe="-._~")


def canonical_tool_global_id(stable_peer_id: str, tool_contract_id: str) -> str:
    """Build the sole canonical durable Tooling global ID."""

    return (
        f"{TOOL_ID_SCHEME}:v{TOOL_ID_VERSION}:"
        f"{_encode_component(stable_peer_id, 'stable_peer_id')}:"
        f"{TOOL_CONTRACT_NAMESPACE}:"
        f"{_encode_component(tool_contract_id, 'tool_contract_id')}"
    )


def parse_canonical_tool_global_id(value: str) -> tuple[str, str]:
    """Parse and canonicalize a v1 Tooling global ID."""

    parts = value.split(":")
    if len(parts) != 5 or parts[:2] != [TOOL_ID_SCHEME, f"v{TOOL_ID_VERSION}"]:
        raise ToolIdentityError("unsupported Tooling identity scheme or version")
    if parts[3] != TOOL_CONTRACT_NAMESPACE:
        raise ToolIdentityError("invalid Tooling contract namespace")
    try:
        stable_peer_id = unquote(parts[2], errors="strict")
        tool_contract_id = unquote(parts[4], errors="strict")
    except UnicodeDecodeError as error:
        raise ToolIdentityError("invalid percent-encoded Tooling identity") from error
    if canonical_tool_global_id(stable_peer_id, tool_contract_id) != value:
        raise ToolIdentityError("Tooling identity is not canonically encoded")
    return stable_peer_id, tool_contract_id


def normalize_legacy_aliases(
    aliases: list[str] | tuple[str, ...], *, canonical_id: str | None = None
) -> tuple[str, ...]:
    """Return a bounded, deterministic compatibility alias set."""

    normalized = sorted(
        {
            _validate_component(alias, "legacy_global_tool_id", max_length=MAX_LEGACY_ALIAS_LENGTH)
            for alias in aliases
            if alias != canonical_id
        }
    )
    if len(normalized) > MAX_LEGACY_ALIASES:
        raise ToolIdentityError(f"legacy alias count exceeds {MAX_LEGACY_ALIASES}")
    return tuple(normalized)


@dataclass(frozen=True, slots=True)
class LoadedToolIdentity:
    """Immutable identity metadata stamped at the loader trust boundary."""

    tool_contract_id: str
    stable_source_id: str
    provider_tool_id: str
    share_group_id: str
    share_group_label: str
    source_kind: Literal["core", "plugin", "mcp", "toolkit", "mesh_peer", "unknown"]
    exportable: bool = True
    tool_id_scheme: Literal["aurora-tool"] = TOOL_ID_SCHEME
    tool_id_version: Literal[1] = TOOL_ID_VERSION

    def __post_init__(self) -> None:
        _validate_component(self.tool_contract_id, "tool_contract_id")
        _validate_component(self.stable_source_id, "stable_source_id")
        _validate_component(self.provider_tool_id, "provider_tool_id")
        _validate_component(self.share_group_id, "share_group_id")
        _validate_component(
            self.share_group_label, "share_group_label", max_length=MAX_GROUP_LABEL_LENGTH
        )
        if self.source_kind == "mesh_peer" and self.exportable:
            object.__setattr__(self, "exportable", False)


CORE_TOOL_IDENTITIES: dict[str, tuple[str, str, str]] = {
    "upsert_memory_tool": ("core.memory.upsert", "core:memory", "Memory"),
    "resume_tts_tool": ("core.tts.resume", "core:tts", "Text to speech"),
    "stop_tts_tool": ("core.tts.stop", "core:tts", "Text to speech"),
    "schedule_task_tool": ("core.scheduler.schedule", "core:scheduler", "Scheduler"),
    "list_scheduled_tasks_tool": ("core.scheduler.list", "core:scheduler", "Scheduler"),
    "cancel_scheduled_task_tool": ("core.scheduler.cancel", "core:scheduler", "Scheduler"),
    "scheduler_daily_greeting_tool": (
        "core.scheduler.daily-greeting",
        "core:scheduler",
        "Scheduler",
    ),
    "scheduler_break_reminder_tool": (
        "core.scheduler.break-reminder",
        "core:scheduler",
        "Scheduler",
    ),
    "scheduler_water_reminder_tool": (
        "core.scheduler.water-reminder",
        "core:scheduler",
        "Scheduler",
    ),
    "scheduler_motivational_message_tool": (
        "core.scheduler.motivational-message",
        "core:scheduler",
        "Scheduler",
    ),
    "scheduler_hourly_time_announcement_tool": (
        "core.scheduler.hourly-time-announcement",
        "core:scheduler",
        "Scheduler",
    ),
    "start_pomodoro_tool": ("core.pomodoro.start", "core:pomodoro", "Pomodoro"),
    "stop_pomodoro_tool": ("core.pomodoro.stop", "core:pomodoro", "Pomodoro"),
    "pomodoro_status_tool": ("core.pomodoro.status", "core:pomodoro", "Pomodoro"),
    "pomodoro_transition_tool": ("core.pomodoro.transition", "core:pomodoro", "Pomodoro"),
    "duckduckgo_results_json": ("core.web-search.duckduckgo", "core:web-search", "Web search"),
    "brave_search": ("core.web-search.brave", "core:web-search", "Web search"),
}


def core_tool_identity(tool_name: str) -> LoadedToolIdentity:
    """Return the explicitly registered identity for a built-in tool."""

    try:
        contract_id, group_id, group_label = CORE_TOOL_IDENTITIES[tool_name]
    except KeyError as error:
        raise ToolIdentityError(f"core tool lacks an explicit identity: {tool_name}") from error
    return LoadedToolIdentity(
        tool_contract_id=contract_id,
        stable_source_id="core",
        provider_tool_id=tool_name,
        share_group_id=group_id,
        share_group_label=group_label,
        source_kind="core",
    )


def source_tool_identity(
    *,
    source_kind: Literal["plugin", "mcp", "toolkit", "mesh_peer", "unknown"],
    stable_source_id: str,
    provider_tool_id: str,
    share_group_id: str,
    share_group_label: str,
    exportable: bool = True,
) -> LoadedToolIdentity:
    """Derive a source-scoped contract ID from immutable provider metadata."""

    source = _validate_component(stable_source_id, "stable_source_id")
    provider = _validate_component(provider_tool_id, "provider_tool_id")
    # Encode each provider-owned component independently.  A dotted join is
    # ambiguous (``mail.primary`` + ``search`` collides with ``mail`` +
    # ``primary.search``), while colon-delimited percent-encoded components
    # preserve the tuple boundary and remain deterministic across restarts.
    contract_id = (
        f"{source_kind}:"
        f"{_encode_component(source, 'stable_source_id')}:"
        f"{_encode_component(provider, 'provider_tool_id')}"
    )
    return LoadedToolIdentity(
        tool_contract_id=contract_id,
        stable_source_id=source,
        provider_tool_id=provider,
        share_group_id=share_group_id,
        share_group_label=share_group_label,
        source_kind=source_kind,
        exportable=exportable,
    )


def stamp_tool(tool: object, identity: LoadedToolIdentity) -> None:
    """Attach one immutable loader identity, rejecting conflicting restamps."""

    existing = vars(tool).get("_aurora_tool_identity")
    if existing is not None and existing != identity:
        raise ToolIdentityCollisionError("tool object was restamped with a different identity")
    object.__setattr__(tool, "_aurora_tool_identity", identity)
