"""Config service contract models."""

from typing import Any

from app.shared.contracts.registry import IOModel


# Module identifiers
class ConfigModule:
    """Module identifier for Config service."""

    NAME = "Config"


# Method identifiers
class ConfigMethods:
    """Full method identifiers for Config service."""

    GET = f"{ConfigModule.NAME}.Get"
    SET = f"{ConfigModule.NAME}.Set"
    UPDATED = f"{ConfigModule.NAME}.Updated"
    ERROR = f"{ConfigModule.NAME}.Error"
    # Additional methods used in interface
    SET_PLUGIN = f"{ConfigModule.NAME}.SetPlugin"
    GET_PLUGIN = f"{ConfigModule.NAME}.GetPlugin"
    VALIDATE = f"{ConfigModule.NAME}.Validate"
    RELOAD_SERVICE = f"{ConfigModule.NAME}.ReloadService"


class ConfigGetRequest(IOModel):
    """Request to get a configuration value."""

    key: str
    default: Any = None


class ConfigGetResponse(IOModel):
    """Response with configuration value."""

    value: Any
    exists: bool = True


class ConfigSetRequest(IOModel):
    """Request to set a configuration value."""

    key: str
    value: Any


class ConfigSetResponse(IOModel):
    """Response after setting configuration."""

    success: bool
    previous_value: Any = None
