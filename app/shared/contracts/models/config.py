"""Config service contract models."""

from typing import Any

from pydantic import Field

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
    GET_SCHEMA_METADATA = f"{ConfigModule.NAME}.GetSchemaMetadata"
    PREVIEW_DIFF = f"{ConfigModule.NAME}.PreviewDiff"
    GET_VERSION_HISTORY = f"{ConfigModule.NAME}.GetVersionHistory"
    ROLLBACK = f"{ConfigModule.NAME}.Rollback"
    PREVIEW_RELOAD_IMPACT = f"{ConfigModule.NAME}.PreviewReloadImpact"
    RELOAD_SERVICE = f"{ConfigModule.NAME}.ReloadService"
    HEALTH_CHECK = f"{ConfigModule.NAME}.HealthCheck"


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


class ConfigSchemaMetadataRequest(IOModel):
    """Request UI-readable configuration schema metadata."""

    section: str | None = None
    include_values: bool = True


class ConfigFieldMetadata(IOModel):
    """UI-readable metadata for one configuration field."""

    key_path: str
    title: str | None = None
    description: str = ""
    type: str = "string"
    default: Any = None
    current_value: Any = None
    source_layer: str = "default"
    secret: bool = False
    reload_required: bool = True
    restart_required: bool = False
    affected_services: list[str] = Field(default_factory=list)
    constraints: dict[str, Any] = Field(default_factory=dict)
    choices: list[Any] | None = None


class ConfigSchemaMetadataResponse(IOModel):
    """Response containing UI-readable configuration field metadata."""

    fields: list[ConfigFieldMetadata] = Field(default_factory=list)
    secrets_redacted: bool = True


class ConfigChange(IOModel):
    """One proposed configuration change."""

    key_path: str
    value: Any


class ConfigDiffPreviewRequest(IOModel):
    """Request a dry-run diff preview for configuration changes."""

    changes: list[ConfigChange]


class ConfigDiffEntry(IOModel):
    """One redacted configuration diff entry."""

    key_path: str
    old_value: Any = None
    new_value: Any = None
    changed: bool = False
    source_layer: str = "default"
    secret: bool = False
    reload_required: bool = True
    restart_required: bool = False
    affected_services: list[str] = Field(default_factory=list)


class ConfigDiffPreviewResponse(IOModel):
    """Response containing a dry-run config diff and validation result."""

    valid: bool
    diffs: list[ConfigDiffEntry] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    secrets_redacted: bool = True


class ConfigVersionHistoryRequest(IOModel):
    """Request recent configuration version history."""

    key_path: str | None = None
    limit: int = 20


class ConfigVersionEntry(IOModel):
    """One redacted configuration version entry."""

    version_id: str
    timestamp: str
    key_path: str
    old_value: Any = None
    new_value: Any = None
    affected_sections: list[str] = Field(default_factory=list)
    secret: bool = False


class ConfigVersionHistoryResponse(IOModel):
    """Response containing recent configuration version entries."""

    versions: list[ConfigVersionEntry] = Field(default_factory=list)
    secrets_redacted: bool = True


class ConfigRollbackRequest(IOModel):
    """Request rollback to the previous value captured by a version entry."""

    version_id: str


class ConfigRollbackResponse(IOModel):
    """Response after rolling back a configuration version."""

    success: bool
    version_id: str | None = None
    key_path: str | None = None
    rolled_back_to: Any = None
    affected_sections: list[str] = Field(default_factory=list)
    error: str | None = None
    secrets_redacted: bool = True


class ConfigReloadImpactRequest(IOModel):
    """Request reload/restart impact for paths or pending changes."""

    key_paths: list[str] = Field(default_factory=list)
    changes: list[ConfigChange] = Field(default_factory=list)


class ConfigReloadImpactEntry(IOModel):
    """Reload/restart impact for one configuration path."""

    key_path: str
    reload_required: bool = True
    restart_required: bool = False
    affected_services: list[str] = Field(default_factory=list)
    reason: str = ""


class ConfigReloadImpactResponse(IOModel):
    """Response containing reload/restart impact entries."""

    impacts: list[ConfigReloadImpactEntry] = Field(default_factory=list)
