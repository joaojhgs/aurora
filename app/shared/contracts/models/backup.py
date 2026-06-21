"""Backup service contract models."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from app.shared.contracts.registry import IOModel


class BackupModule:
    """Module identifier for Backup service."""

    NAME = "Backup"


class BackupMethods:
    """Full method identifiers for Backup service."""

    CREATE = f"{BackupModule.NAME}.Create"
    LIST = f"{BackupModule.NAME}.List"
    VERIFY = f"{BackupModule.NAME}.Verify"
    RESTORE = f"{BackupModule.NAME}.Restore"
    ROLLBACK = f"{BackupModule.NAME}.Rollback"
    HEALTH_CHECK = f"{BackupModule.NAME}.HealthCheck"


BackupComponentName = Literal["config", "db", "rag", "models"]
BackupComponentStatus = Literal["included", "skipped", "unavailable", "unsupported"]
BackupOperationStatus = Literal["ok", "denied", "failed", "unsupported", "not_found"]
BackupStorageKind = Literal["local", "s3", "gcs", "azure", "custom"]
BackupEncryptionMode = Literal["none", "passphrase", "age", "kms", "external"]


class BackupStorageTarget(IOModel):
    """Storage target for a backup operation.

    Secret material is intentionally represented as references or fingerprints;
    raw keys, passphrases, tokens, and connection strings must not be returned.
    """

    kind: BackupStorageKind = "local"
    uri: str | None = None
    encryption: BackupEncryptionMode = "none"
    key_ref: str | None = None
    credential_ref: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class BackupComponentResult(IOModel):
    """One component's backup/restore status."""

    component: BackupComponentName
    status: BackupComponentStatus
    item_count: int | None = None
    bytes: int | None = None
    fingerprint: str | None = None
    redacted: bool = True
    message: str | None = None


class BackupServiceImpact(IOModel):
    """Service impact expected for restore or rollback."""

    service: str
    action: Literal["quiesce", "restart", "reload", "manual", "none"]
    required: bool = True
    reason: str


class BackupImpactPlan(IOModel):
    """Restore impact plan that clients must show before confirmation."""

    admin_critical: bool = True
    requires_quiesce: bool = True
    requires_restart: bool = True
    affected_services: list[BackupServiceImpact] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class BackupManifestSummary(IOModel):
    """UI-safe backup manifest summary."""

    backup_id: str
    created_at: str
    status: BackupOperationStatus
    storage: BackupStorageTarget
    components: list[BackupComponentResult] = Field(default_factory=list)
    manifest_digest: str
    schema_version: str = "aurora.backup.v1"
    encrypted: bool = False
    secrets_redacted: bool = True
    audit_receipt: str | None = None


class BackupCreateRequest(IOModel):
    """Create a backup manifest for selected backend state."""

    storage: BackupStorageTarget = Field(default_factory=BackupStorageTarget)
    components: list[BackupComponentName] = Field(
        default_factory=lambda: ["config", "db", "rag", "models"]
    )
    reason: str
    include_personal_data: bool = False
    correlation_id: str | None = None


class BackupCreateResponse(IOModel):
    """Created backup manifest response."""

    status: BackupOperationStatus
    backup: BackupManifestSummary | None = None
    audit_receipt: str
    message: str | None = None


class BackupListRequest(IOModel):
    """List known backup manifests."""

    limit: int = 50
    offset: int = 0
    include_failed: bool = True


class BackupListResponse(IOModel):
    """List of known backup manifests."""

    backups: list[BackupManifestSummary] = Field(default_factory=list)
    total: int = 0
    secrets_redacted: bool = True


class BackupVerifyRequest(IOModel):
    """Verify a backup manifest digest and component metadata."""

    backup_id: str
    storage: BackupStorageTarget | None = None


class BackupVerifyResponse(IOModel):
    """Backup verification result."""

    status: BackupOperationStatus
    backup_id: str
    verified: bool = False
    manifest_digest: str | None = None
    components: list[BackupComponentResult] = Field(default_factory=list)
    message: str | None = None


class BackupRestoreRequest(IOModel):
    """Restore or dry-run restore from a backup manifest."""

    backup_id: str
    storage: BackupStorageTarget | None = None
    components: list[BackupComponentName] | None = None
    dry_run: bool = True
    reason: str
    create_rollback: bool = True
    correlation_id: str | None = None


class BackupRestoreResponse(IOModel):
    """Restore result or dry-run impact plan."""

    status: BackupOperationStatus
    backup_id: str
    restored: bool = False
    rollback_backup_id: str | None = None
    impact_plan: BackupImpactPlan
    audit_receipt: str
    message: str | None = None


class BackupRollbackRequest(IOModel):
    """Rollback a prior restore using a rollback backup."""

    rollback_backup_id: str
    reason: str
    dry_run: bool = True
    correlation_id: str | None = None


class BackupRollbackResponse(IOModel):
    """Rollback result or dry-run impact plan."""

    status: BackupOperationStatus
    rollback_backup_id: str
    rolled_back: bool = False
    impact_plan: BackupImpactPlan
    audit_receipt: str
    message: str | None = None
