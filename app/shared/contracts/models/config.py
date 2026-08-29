"""Config service contract models."""

from typing import Any

from pydantic import Field, field_validator, model_validator

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
    COMMIT_CHANGE_SET = f"{ConfigModule.NAME}.CommitChangeSet"
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

    @field_validator("key_path")
    @classmethod
    def validate_key_path(cls, value: str) -> str:
        if not value or not value.strip() or any(part == "" for part in value.split(".")):
            raise ValueError("key_path must not be blank")
        return value


class ConfigDiffPreviewRequest(IOModel):
    """Request a dry-run diff preview for configuration changes."""

    changes: list[ConfigChange]

    @model_validator(mode="after")
    def validate_changes(self) -> "ConfigDiffPreviewRequest":
        _validate_distinct_changes(self.changes)
        return self


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
    base_revision: int | None = None
    preview_token: str | None = None
    changed_paths: list[str] = Field(default_factory=list)


class ConfigCommitChangeSetRequest(IOModel):
    """Commit a previously previewed config change set."""

    changes: list[ConfigChange]
    base_revision: int
    preview_token: str

    @model_validator(mode="after")
    def validate_changes(self) -> "ConfigCommitChangeSetRequest":
        _validate_distinct_changes(self.changes)
        return self


class ConfigCommitChangeSetResponse(IOModel):
    """Response after committing a config change set."""

    success: bool
    revision: int | None = None
    version_id: str | None = None
    changed_paths: list[str] = Field(default_factory=list)
    transaction_id: str | None = None
    error: str | None = None
    error_code: str | None = None
    diff: ConfigDiffPreviewResponse | None = None


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
    changed_paths: list[str] = Field(default_factory=list)
    transaction_kind: str | None = None
    actor: str | None = None


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

    @field_validator("key_paths")
    @classmethod
    def validate_key_paths(cls, value: list[str]) -> list[str]:
        seen: set[str] = set()
        for key_path in value:
            if (
                not key_path
                or not key_path.strip()
                or any(part == "" for part in key_path.split("."))
            ):
                raise ValueError("key_paths must not contain blank paths")
            if key_path in seen:
                raise ValueError(f"duplicate key_path: {key_path}")
            seen.add(key_path)
        return value

    @model_validator(mode="after")
    def validate_changes(self) -> "ConfigReloadImpactRequest":
        _validate_distinct_changes(self.changes, allow_empty=True)
        return self


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


def _validate_distinct_changes(changes: list[ConfigChange], *, allow_empty: bool = False) -> None:
    if not allow_empty and not changes:
        raise ValueError("changes must not be empty")
    seen: set[str] = set()
    for change in changes:
        if change.key_path in seen:
            raise ValueError(f"duplicate change path: {change.key_path}")
        seen.add(change.key_path)
