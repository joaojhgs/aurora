"""Backup service for admin backup/restore contract surfaces."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.shared.contracts.models.backup import (
    BackupComponentName,
    BackupComponentResult,
    BackupCreateRequest,
    BackupCreateResponse,
    BackupImpactPlan,
    BackupListRequest,
    BackupListResponse,
    BackupManifestSummary,
    BackupMethods,
    BackupModule,
    BackupOperationStatus,
    BackupRestoreRequest,
    BackupRestoreResponse,
    BackupRollbackRequest,
    BackupRollbackResponse,
    BackupServiceImpact,
    BackupStorageTarget,
    BackupVerifyRequest,
    BackupVerifyResponse,
)
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.db import (
    DBMethods,
    DBRAGExportNamespaceRequest,
    DBRAGListNamespacesRequest,
)
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService


class BackupService(BaseService):
    """Admin backup/restore contract service."""

    def __init__(self, backup_dir: str | Path | None = None):
        super().__init__(
            module=BackupModule.NAME,
            summary="Admin backup and restore contract service",
            capabilities=["backup_restore", "admin_backups"],
        )
        root = backup_dir or os.getenv("AURORA_BACKUP_DIR") or ".aurora/backups"
        self._backup_dir = Path(root)

    async def on_start(self) -> None:
        await asyncio.to_thread(self._backup_dir.mkdir, parents=True, exist_ok=True)
        self._set_started(True)
        log_info("BackupService started")

    async def on_stop(self) -> None:
        self._set_started(False)
        log_info("BackupService stopped")

    async def reload(self, config_section: str | None = None) -> None:
        log_debug(f"BackupService reload requested for section={config_section}")

    @method_contract(
        method_id=BackupMethods.CREATE,
        summary="Create a backup manifest for config, DB/RAG, and model state",
        input_model=BackupCreateRequest,
        output_model=BackupCreateResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Backup.manage"],
    )
    async def create_backup(self, data: BackupCreateRequest) -> BackupCreateResponse:
        backup_id = f"backup-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{uuid4().hex[:8]}"
        audit_receipt = self._audit_receipt("create", backup_id)
        try:
            components = await self._collect_components(data.components, data.include_personal_data)
            manifest = self._build_manifest(
                backup_id=backup_id,
                storage=data.storage,
                components=components,
                audit_receipt=audit_receipt,
                status="ok",
            )
            await asyncio.to_thread(self._write_manifest, manifest)
            return BackupCreateResponse(
                status="ok",
                backup=manifest,
                audit_receipt=audit_receipt,
                message="Backup manifest created; component payloads remain service-owned.",
            )
        except Exception as e:
            log_error(f"Failed to create backup manifest: {e}", exc_info=True)
            return BackupCreateResponse(
                status="failed",
                backup=None,
                audit_receipt=audit_receipt,
                message=str(e),
            )

    @method_contract(
        method_id=BackupMethods.LIST,
        summary="List known backup manifests",
        input_model=BackupListRequest,
        output_model=BackupListResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Backup.manage"],
    )
    async def list_backups(self, data: BackupListRequest) -> BackupListResponse:
        manifests = await asyncio.to_thread(self._read_manifests)
        if not data.include_failed:
            manifests = [manifest for manifest in manifests if manifest.status != "failed"]
        total = len(manifests)
        window = manifests[data.offset : data.offset + data.limit]
        return BackupListResponse(backups=window, total=total, secrets_redacted=True)

    @method_contract(
        method_id=BackupMethods.VERIFY,
        summary="Verify a backup manifest digest and component metadata",
        input_model=BackupVerifyRequest,
        output_model=BackupVerifyResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Backup.manage"],
    )
    async def verify_backup(self, data: BackupVerifyRequest) -> BackupVerifyResponse:
        manifest = await asyncio.to_thread(self._read_manifest, data.backup_id)
        if manifest is None:
            return BackupVerifyResponse(
                status="not_found",
                backup_id=data.backup_id,
                verified=False,
                message="Backup manifest was not found",
            )
        expected = self._manifest_digest(manifest.model_dump(exclude={"manifest_digest"}))
        verified = expected == manifest.manifest_digest
        return BackupVerifyResponse(
            status="ok" if verified else "failed",
            backup_id=data.backup_id,
            verified=verified,
            manifest_digest=manifest.manifest_digest,
            components=manifest.components,
            message=None if verified else "Backup manifest digest mismatch",
        )

    @method_contract(
        method_id=BackupMethods.RESTORE,
        summary="Dry-run or restore a backup with service quiesce/restart impact plan",
        input_model=BackupRestoreRequest,
        output_model=BackupRestoreResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Backup.manage"],
    )
    async def restore_backup(self, data: BackupRestoreRequest) -> BackupRestoreResponse:
        audit_receipt = self._audit_receipt("restore", data.backup_id)
        manifest = await asyncio.to_thread(self._read_manifest, data.backup_id)
        impact = self._restore_impact_plan(data.components or None)
        if manifest is None:
            return BackupRestoreResponse(
                status="not_found",
                backup_id=data.backup_id,
                restored=False,
                impact_plan=impact,
                audit_receipt=audit_receipt,
                message="Backup manifest was not found",
            )
        if data.dry_run:
            return BackupRestoreResponse(
                status="ok",
                backup_id=data.backup_id,
                restored=False,
                rollback_backup_id=None,
                impact_plan=impact,
                audit_receipt=audit_receipt,
                message="Restore dry-run only; no state was changed.",
            )
        return BackupRestoreResponse(
            status="unsupported",
            backup_id=data.backup_id,
            restored=False,
            rollback_backup_id=None,
            impact_plan=impact,
            audit_receipt=audit_receipt,
            message=(
                "Destructive restore requires a service quiesce/restart executor and is not "
                "enabled by this contract slice."
            ),
        )

    @method_contract(
        method_id=BackupMethods.ROLLBACK,
        summary="Dry-run or rollback a restore using a rollback backup",
        input_model=BackupRollbackRequest,
        output_model=BackupRollbackResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Backup.manage"],
    )
    async def rollback_restore(self, data: BackupRollbackRequest) -> BackupRollbackResponse:
        audit_receipt = self._audit_receipt("rollback", data.rollback_backup_id)
        impact = self._restore_impact_plan(None)
        manifest = await asyncio.to_thread(self._read_manifest, data.rollback_backup_id)
        if manifest is None:
            return BackupRollbackResponse(
                status="not_found",
                rollback_backup_id=data.rollback_backup_id,
                rolled_back=False,
                impact_plan=impact,
                audit_receipt=audit_receipt,
                message="Rollback backup manifest was not found",
            )
        if data.dry_run:
            return BackupRollbackResponse(
                status="ok",
                rollback_backup_id=data.rollback_backup_id,
                rolled_back=False,
                impact_plan=impact,
                audit_receipt=audit_receipt,
                message="Rollback dry-run only; no state was changed.",
            )
        return BackupRollbackResponse(
            status="unsupported",
            rollback_backup_id=data.rollback_backup_id,
            rolled_back=False,
            impact_plan=impact,
            audit_receipt=audit_receipt,
            message=(
                "Destructive rollback requires the same service quiesce/restart executor as "
                "restore and is not enabled by this contract slice."
            ),
        )

    async def _collect_components(
        self,
        requested: list[BackupComponentName],
        include_personal_data: bool,
    ) -> list[BackupComponentResult]:
        components: list[BackupComponentResult] = []
        for component in requested:
            if component == "config":
                components.append(await self._config_component())
            elif component == "rag":
                components.append(await self._rag_component(include_personal_data))
            elif component == "db":
                components.append(
                    BackupComponentResult(
                        component="db",
                        status="unsupported",
                        redacted=True,
                        message=(
                            "Full database payload export is intentionally unavailable in this "
                            "contract slice; service-owned DB/RAG exports remain typed."
                        ),
                    )
                )
            elif component == "models":
                components.append(
                    BackupComponentResult(
                        component="models",
                        status="unsupported",
                        redacted=True,
                        message=(
                            "Model binary backup is planned until model runtime catalog/import "
                            "contracts land."
                        ),
                    )
                )
        return components

    async def _config_component(self) -> BackupComponentResult:
        try:
            result = await self.bus.request(ConfigMethods.GET, {"section": None}, timeout=10.0)
            if not getattr(result, "ok", False):
                return BackupComponentResult(
                    component="config",
                    status="unavailable",
                    redacted=True,
                    message=getattr(result, "error", None) or "Config.Get failed",
                )
            raw = self._result_data(result)
            config = raw.get("config", raw) if isinstance(raw, dict) else {}
            safe_config = self._redact(config)
            encoded = json.dumps(safe_config, sort_keys=True, default=str).encode("utf-8")
            return BackupComponentResult(
                component="config",
                status="included",
                item_count=len(safe_config) if isinstance(safe_config, dict) else None,
                bytes=len(encoded),
                fingerprint=hashlib.sha256(encoded).hexdigest(),
                redacted=True,
                message="Config snapshot metadata captured with secrets redacted.",
            )
        except Exception as e:
            log_warning(f"Config backup component unavailable: {e}")
            return BackupComponentResult(
                component="config",
                status="unavailable",
                redacted=True,
                message="Config service unavailable",
            )

    async def _rag_component(self, include_personal_data: bool) -> BackupComponentResult:
        try:
            result = await self.bus.request(
                DBMethods.RAG_LIST_NAMESPACES,
                DBRAGListNamespacesRequest(include_remote=False, include_unavailable=True),
                timeout=10.0,
            )
            if not getattr(result, "ok", False):
                return BackupComponentResult(
                    component="rag",
                    status="unavailable",
                    redacted=True,
                    message=getattr(result, "error", None) or "DB.RAGListNamespaces failed",
                )
            raw = self._result_data(result)
            namespaces = raw.get("namespaces", []) if isinstance(raw, dict) else []
            exportable = []
            for namespace in namespaces:
                if hasattr(namespace, "model_dump"):
                    namespace = namespace.model_dump()
                policy = namespace.get("policy", {}) if isinstance(namespace, dict) else {}
                if policy.get("export_supported"):
                    exportable.append(namespace.get("namespace"))
            if include_personal_data and exportable:
                await self.bus.request(
                    DBMethods.RAG_EXPORT_NAMESPACE,
                    DBRAGExportNamespaceRequest(namespace=exportable[0], limit=1),
                    timeout=10.0,
                )
            fingerprint_source = json.dumps(exportable, sort_keys=True).encode("utf-8")
            return BackupComponentResult(
                component="rag",
                status="included" if exportable else "unavailable",
                item_count=len(exportable),
                bytes=len(fingerprint_source),
                fingerprint=hashlib.sha256(fingerprint_source).hexdigest(),
                redacted=True,
                message="RAG namespace backup metadata captured; record payloads remain redacted.",
            )
        except Exception as e:
            log_warning(f"RAG backup component unavailable: {e}")
            return BackupComponentResult(
                component="rag",
                status="unavailable",
                redacted=True,
                message="DB/RAG service unavailable",
            )

    def _build_manifest(
        self,
        *,
        backup_id: str,
        storage: BackupStorageTarget,
        components: list[BackupComponentResult],
        audit_receipt: str,
        status: BackupOperationStatus,
    ) -> BackupManifestSummary:
        manifest = BackupManifestSummary(
            backup_id=backup_id,
            created_at=datetime.now(UTC).isoformat(),
            status=status,
            storage=self._safe_storage(storage),
            components=components,
            manifest_digest="",
            encrypted=storage.encryption != "none",
            audit_receipt=audit_receipt,
        )
        manifest.manifest_digest = self._manifest_digest(
            manifest.model_dump(exclude={"manifest_digest"})
        )
        return manifest

    def _manifest_digest(self, payload: dict[str, Any]) -> str:
        normalized = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def _write_manifest(self, manifest: BackupManifestSummary) -> None:
        self._backup_dir.mkdir(parents=True, exist_ok=True)
        self._manifest_path(manifest.backup_id).write_text(
            manifest.model_dump_json(indent=2), encoding="utf-8"
        )

    def _read_manifest(self, backup_id: str) -> BackupManifestSummary | None:
        path = self._manifest_path(backup_id)
        if not path.exists():
            return None
        return BackupManifestSummary.model_validate_json(path.read_text(encoding="utf-8"))

    def _read_manifests(self) -> list[BackupManifestSummary]:
        if not self._backup_dir.exists():
            return []
        manifests = []
        for path in sorted(self._backup_dir.glob("*.json"), reverse=True):
            try:
                manifests.append(
                    BackupManifestSummary.model_validate_json(path.read_text(encoding="utf-8"))
                )
            except Exception as e:
                log_warning(f"Skipping invalid backup manifest {path}: {e}")
        return manifests

    def _manifest_path(self, backup_id: str) -> Path:
        safe_id = backup_id.replace("/", "_").replace("\\", "_")
        return self._backup_dir / f"{safe_id}.json"

    def _restore_impact_plan(
        self,
        components: list[BackupComponentName] | None,
    ) -> BackupImpactPlan:
        selected = set(components or ["config", "db", "rag", "models"])
        impacts: list[BackupServiceImpact] = []
        if "config" in selected:
            impacts.extend(
                [
                    BackupServiceImpact(
                        service="ConfigService",
                        action="quiesce",
                        reason="Prevent config writes while restoring configuration state.",
                    ),
                    BackupServiceImpact(
                        service="GatewayService",
                        action="restart",
                        reason="Reload Gateway/Auth policy after configuration restore.",
                    ),
                ]
            )
        if {"db", "rag"} & selected:
            impacts.append(
                BackupServiceImpact(
                    service="DBService",
                    action="quiesce",
                    reason="Prevent writes while restoring DB/RAG state.",
                )
            )
        if "models" in selected:
            impacts.append(
                BackupServiceImpact(
                    service="OrchestratorService",
                    action="restart",
                    reason="Reload model runtime state after model asset restore.",
                )
            )
        return BackupImpactPlan(
            affected_services=impacts,
            warnings=[
                "Restore and rollback are admin-critical.",
                "Destructive execution is disabled until service quiesce/restart orchestration lands.",
            ],
        )

    def _safe_storage(self, storage: BackupStorageTarget) -> BackupStorageTarget:
        metadata = self._redact(storage.metadata)
        return storage.model_copy(update={"credential_ref": None, "metadata": metadata})

    def _redact(self, value: Any) -> Any:
        if isinstance(value, dict):
            redacted: dict[str, Any] = {}
            for key, child in value.items():
                lowered = key.lower()
                if any(
                    token in lowered
                    for token in ("secret", "token", "password", "credential", "api_key", "key")
                ):
                    redacted[key] = "[redacted]"
                else:
                    redacted[key] = self._redact(child)
            return redacted
        if isinstance(value, list):
            return [self._redact(item) for item in value]
        return value

    def _audit_receipt(self, operation: str, target_id: str) -> str:
        digest = hashlib.sha256(f"{operation}:{target_id}:{uuid4()}".encode("utf-8")).hexdigest()
        return f"bar_{digest[:24]}"

    def _result_data(self, result: Any) -> Any:
        data = getattr(result, "data", None)
        if hasattr(data, "model_dump"):
            return data.model_dump()
        return data
