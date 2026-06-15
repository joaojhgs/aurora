"""Config service message models."""

from __future__ import annotations

from typing import Any

from app.messaging import Command, Event, Query


class GetConfigQuery(Query):
    """Query to get configuration."""

    section: str | None = None


class GetConfigResponse(Query):
    """Response containing configuration."""

    config: dict[str, Any]


class UpdateConfigCommand(Command):
    """Command to update configuration."""

    key_path: str
    value: Any


class UpdateConfigResponse(Query):
    """Response to update configuration command."""

    success: bool
    error: str | None = None
    key_path: str | None = None
    old_value: Any = None
    new_value: Any = None
    affected_sections: list[str] | None = None


class ValidateConfigQuery(Query):
    """Query to validate configuration."""

    pass


class ValidateConfigResponse(Query):
    """Response containing validation errors."""

    errors: list[str]


class GetPluginStatusQuery(Query):
    """Query to get plugin status."""

    plugin_name: str


class GetPluginStatusResponse(Query):
    """Response containing plugin status."""

    active: bool


class UpdatePluginStatusCommand(Command):
    """Command to update plugin status."""

    plugin_name: str
    active: bool


class ConfigChangedEvent(Event):
    """Event emitted when configuration changes."""

    affected_sections: list[str]
    key_path: str
    old_value: Any
    new_value: Any


class ReloadServiceCommand(Command):
    """Command to reload a specific service."""

    service_name: str
    reason: str | None = None
