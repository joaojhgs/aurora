"""Config Service for Aurora's configuration management.

This service:
- Handles configuration queries and updates via message bus
- Manages config observers and change notifications
- Publishes config change events
- Supports config reload mechanism
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import Envelope
from app.services.config.config_manager import ConfigManager
from app.services.config.messages import (
    ConfigChangedEvent,
    GetConfigQuery,
    GetConfigResponse,
    GetPluginStatusQuery,
    GetPluginStatusResponse,
    ReloadServiceCommand,
    UpdateConfigCommand,
    UpdateConfigResponse,
    UpdatePluginStatusCommand,
    ValidateConfigQuery,
    ValidateConfigResponse,
)
from app.shared.contracts.models.auth import AuthMethods, StoreAuditEventRequest
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.config import (
    ConfigCommitChangeSetRequest,
    ConfigCommitChangeSetResponse,
    ConfigDiffPreviewRequest,
    ConfigDiffPreviewResponse,
    ConfigMethods,
    ConfigModule,
    ConfigReloadImpactRequest,
    ConfigReloadImpactResponse,
    ConfigRollbackRequest,
    ConfigRollbackResponse,
    ConfigSchemaMetadataRequest,
    ConfigSchemaMetadataResponse,
    ConfigVersionHistoryRequest,
    ConfigVersionHistoryResponse,
)
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService

AUTH_DEPENDENT_STARTUP_GRACE_SECONDS = 1.0
AUTH_DEPENDENT_STARTUP_POLL_SECONDS = 0.1
AUTH_DEPENDENT_STARTUP_POLL_ATTEMPTS = 300


class ConfigService(BaseService):
    """Config Service for managing Aurora configuration."""

    def __init__(self):
        """Initialize the config service."""
        super().__init__(
            module=ConfigModule.NAME,
            summary="Configuration management service",
            capabilities=["config_management", "plugin_management"],
        )
        self.config_manager = ConfigManager()
        self._mesh_policy_rbac_task: asyncio.Task[dict[str, Any] | None] | None = None
        self._setup_config_observers()

    def _setup_config_observers(self) -> None:
        """Set up config observers to publish change events."""

        def on_config_change(
            key_path: str,
            old_value: Any,
            new_value: Any,
            metadata: dict[str, Any] | None = None,
        ) -> None:
            """Handle config change and publish event."""
            # Determine affected sections
            affected_sections = []
            if key_path:
                parts = key_path.split(".")
                if len(parts) > 0:
                    affected_sections.append(parts[0])
                    # Add parent sections
                    for i in range(1, len(parts)):
                        affected_sections.append(".".join(parts[: i + 1]))

            # Publish config change event
            try:
                safe_old_value = self.config_manager._redact_path_value(key_path, old_value)
                safe_new_value = self.config_manager._redact_path_value(key_path, new_value)
                event = ConfigChangedEvent(
                    affected_sections=affected_sections,
                    key_path=key_path,
                    old_value=safe_old_value,
                    new_value=safe_new_value,
                    transaction_id=(metadata or {}).get("transaction_id"),
                    config_revision=(metadata or {}).get("config_revision"),
                    changed_paths=(metadata or {}).get("changed_paths"),
                    actor=(metadata or {}).get("actor"),
                )
                # Use asyncio to publish event
                import asyncio

                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        asyncio.create_task(self._publish_config_change(event))
                    else:
                        loop.run_until_complete(self._publish_config_change(event))
                except RuntimeError:
                    # No event loop, create task in background
                    asyncio.run(self._publish_config_change(event))
            except Exception as e:
                log_error(f"Failed to publish config change event: {e}")

        # Register observer with config manager
        self.config_manager.add_observer(on_config_change)

    async def _publish_config_change(self, event: ConfigChangedEvent) -> None:
        """Publish config change event to bus."""
        try:
            await self.bus.publish(ConfigMethods.UPDATED, event, event=True, mesh=False)
            log_debug(f"Published config change event: {event.key_path}")
        except Exception as e:
            log_error(f"Failed to publish config change event: {e}")

    async def _audit_mesh_config_event(
        self, event: str, *, actor: str | None, details: dict[str, Any]
    ) -> None:
        """Persist value-free mesh config audit metadata without affecting commits."""

        try:
            await self.bus.request(
                AuthMethods.STORE_AUDIT_EVENT,
                StoreAuditEventRequest(
                    event=event,
                    principal_id=actor,
                    details=json.dumps({**details, "secrets_redacted": True}, sort_keys=True),
                ),
                timeout=5.0,
                origin="internal",
            )
        except Exception as exc:
            log_error(f"Failed to audit {event}: {type(exc).__name__}")

    @method_contract(
        method_id=ConfigMethods.GET,
        summary="Get configuration value",
        input_model=GetConfigQuery,
        output_model=GetConfigResponse,
        exposure="both",
        method_type="use",
    )
    async def _handle_get_config(
        self,
        query: GetConfigQuery,
        envelope: Envelope | None = None,
    ) -> GetConfigResponse:
        """Handle GetConfig query.

        Args:
            query: GetConfigQuery (payload already extracted by base_service wrapper)

            Returns:
                GetConfigResponse (automatically published to reply_to by base_service wrapper)
        """
        section = query.section

        # Log the request with debug details (only shown when AURORA_DEBUG_LOGS=true)
        log_debug(f"[GetConfig] section='{section}'")

        if section:
            config = self.config_manager.get(section, {})
        else:
            config = self.config_manager.get_config_dict()

        identity_source = getattr(envelope, "identity_source", None)
        external_read = getattr(
            envelope, "origin", "internal"
        ) == "external" or identity_source in {
            "gateway_http",
            "webrtc_rpc",
            "mesh_peer",
            "remote_peer",
            "token",
        }
        if external_read:
            config = self.config_manager.redact_external_config(
                config,
                root_path=section or "",
            )

        return GetConfigResponse(config=config)

    @method_contract(
        method_id=ConfigMethods.SET,
        summary="Update configuration value",
        input_model=UpdateConfigCommand,
        output_model=UpdateConfigResponse,
        exposure="both",
        method_type="manage",
    )
    async def _handle_update_config(
        self,
        cmd: UpdateConfigCommand,
        envelope: Envelope | None = None,
    ) -> UpdateConfigResponse:
        """Handle UpdateConfig command."""
        try:
            metadata = self.config_manager.set(
                cmd.key_path,
                cmd.value,
                actor=self._actor_from_envelope(envelope),
            )
            log_info(f"Updated config: {cmd.key_path}")
            return UpdateConfigResponse(success=True, **metadata)
        except Exception as e:
            log_error(f"Error updating config: {e}")
            return UpdateConfigResponse(success=False, error=str(e))

    @method_contract(
        method_id=ConfigMethods.VALIDATE,
        summary="Validate current configuration",
        input_model=ValidateConfigQuery,
        output_model=ValidateConfigResponse,
        exposure="both",
        method_type="use",
    )
    async def _handle_validate_config(self, query: ValidateConfigQuery) -> ValidateConfigResponse:
        """Handle ValidateConfig query."""
        errors = self.config_manager.validate_current_config()
        log_debug(f"Handled ValidateConfig query: {len(errors)} errors")
        return ValidateConfigResponse(errors=errors)

    @method_contract(
        method_id=ConfigMethods.GET_SCHEMA_METADATA,
        summary="Get UI-readable config schema metadata",
        input_model=ConfigSchemaMetadataRequest,
        output_model=ConfigSchemaMetadataResponse,
        exposure="both",
        method_type="use",
        required_perms=[ConfigMethods.GET_SCHEMA_METADATA],
    )
    async def _handle_get_schema_metadata(
        self, query: ConfigSchemaMetadataRequest
    ) -> ConfigSchemaMetadataResponse:
        """Handle schema metadata query with secret values redacted."""
        fields = self.config_manager.get_schema_metadata(
            section=query.section,
            include_values=query.include_values,
        )
        return ConfigSchemaMetadataResponse(fields=fields, secrets_redacted=True)

    @method_contract(
        method_id=ConfigMethods.PREVIEW_DIFF,
        summary="Preview a validated config diff without writing changes",
        input_model=ConfigDiffPreviewRequest,
        output_model=ConfigDiffPreviewResponse,
        exposure="both",
        method_type="use",
        required_perms=[ConfigMethods.PREVIEW_DIFF],
    )
    async def _handle_preview_diff(
        self, query: ConfigDiffPreviewRequest, envelope: Envelope | None = None
    ) -> ConfigDiffPreviewResponse:
        """Handle dry-run config diff preview."""
        try:
            result = self.config_manager.preview_diff(
                [change.model_dump() for change in query.changes],
                actor=self._actor_from_envelope(envelope),
            )
        except ValueError as exc:
            result = {
                "valid": False,
                "diffs": [],
                "errors": [str(exc)],
                "secrets_redacted": True,
                "base_revision": self.config_manager.config_revision,
                "preview_token": None,
                "changed_paths": [],
            }
        return ConfigDiffPreviewResponse(**result)

    @method_contract(
        method_id=ConfigMethods.COMMIT_CHANGE_SET,
        summary="Commit a validated config change set atomically",
        input_model=ConfigCommitChangeSetRequest,
        output_model=ConfigCommitChangeSetResponse,
        exposure="both",
        method_type="manage",
        required_perms=[ConfigMethods.COMMIT_CHANGE_SET],
    )
    async def _handle_commit_change_set(
        self,
        cmd: ConfigCommitChangeSetRequest,
        envelope: Envelope | None = None,
    ) -> ConfigCommitChangeSetResponse:
        """Handle atomic config change-set commit."""
        try:
            result = self.config_manager.commit_change_set(
                [change.model_dump() for change in cmd.changes],
                base_revision=cmd.base_revision,
                preview_token=cmd.preview_token,
                actor=self._actor_from_envelope(envelope),
            )
            actor = self._actor_from_envelope(envelope)
            changed_paths = sorted(result.get("changed_paths", []))
            mesh_paths = [path for path in changed_paths if ".mesh_" in path]
            if mesh_paths:
                await self._audit_mesh_config_event(
                    "mesh.config.policy_committed",
                    actor=actor,
                    details={
                        "config_revision": result.get("revision"),
                        "changed_paths": mesh_paths,
                        "service_export_changed": any(".mesh_sharing" in p for p in mesh_paths),
                        "routing_policy_changed": any(".mesh_routing" in p for p in mesh_paths),
                    },
                )
            return ConfigCommitChangeSetResponse(**result)
        except ValueError as e:
            await self._audit_mesh_config_event(
                "mesh.config.commit_rejected",
                actor=self._actor_from_envelope(envelope),
                details={
                    "reason_code": "config_revision_conflict",
                    "config_revision": self.config_manager.config_revision,
                },
            )
            return ConfigCommitChangeSetResponse(
                success=False,
                error=str(e),
                error_code="config_revision_conflict",
                changed_paths=[],
                revision=self.config_manager.config_revision,
            )
        except Exception as e:
            log_error(f"Error committing config change set: {e}")
            return ConfigCommitChangeSetResponse(success=False, error=str(e))

    @method_contract(
        method_id=ConfigMethods.GET_VERSION_HISTORY,
        summary="Get recent redacted config version history",
        input_model=ConfigVersionHistoryRequest,
        output_model=ConfigVersionHistoryResponse,
        exposure="both",
        method_type="use",
        required_perms=[ConfigMethods.GET_VERSION_HISTORY],
    )
    async def _handle_get_version_history(
        self, query: ConfigVersionHistoryRequest
    ) -> ConfigVersionHistoryResponse:
        """Handle config version history query."""
        versions = self.config_manager.get_version_history(
            key_path=query.key_path,
            limit=query.limit,
        )
        return ConfigVersionHistoryResponse(versions=versions, secrets_redacted=True)

    @method_contract(
        method_id=ConfigMethods.ROLLBACK,
        summary="Rollback a config value to a previous version",
        input_model=ConfigRollbackRequest,
        output_model=ConfigRollbackResponse,
        exposure="both",
        method_type="manage",
        required_perms=[ConfigMethods.ROLLBACK],
    )
    async def _handle_rollback(
        self,
        cmd: ConfigRollbackRequest,
        envelope: Envelope | None = None,
    ) -> ConfigRollbackResponse:
        """Handle config rollback command."""
        try:
            result = self.config_manager.rollback(
                cmd.version_id,
                actor=self._actor_from_envelope(envelope),
            )
            log_info(f"Rolled back config version: {cmd.version_id}")
            return ConfigRollbackResponse(**result)
        except Exception as e:
            log_error(f"Error rolling back config version {cmd.version_id}: {e}")
            return ConfigRollbackResponse(success=False, error=str(e))

    @method_contract(
        method_id=ConfigMethods.PREVIEW_RELOAD_IMPACT,
        summary="Preview reload and restart impact for config paths",
        input_model=ConfigReloadImpactRequest,
        output_model=ConfigReloadImpactResponse,
        exposure="both",
        method_type="use",
        required_perms=[ConfigMethods.PREVIEW_RELOAD_IMPACT],
    )
    async def _handle_preview_reload_impact(
        self, query: ConfigReloadImpactRequest
    ) -> ConfigReloadImpactResponse:
        """Handle config reload/restart impact preview."""
        key_paths = list(query.key_paths)
        key_paths.extend(change.key_path for change in query.changes)
        impacts = self.config_manager.get_reload_impact(sorted(set(key_paths)))
        return ConfigReloadImpactResponse(impacts=impacts)

    @method_contract(
        method_id=ConfigMethods.GET_PLUGIN,
        summary="Get plugin status",
        input_model=GetPluginStatusQuery,
        output_model=GetPluginStatusResponse,
        exposure="both",
        method_type="use",
    )
    async def _handle_get_plugin_status(
        self, query: GetPluginStatusQuery
    ) -> GetPluginStatusResponse:
        """Handle GetPluginStatus query."""
        active = self.config_manager.get(
            f"services.tooling.plugins.{query.plugin_name}.activate", False
        )
        log_debug(f"Handled GetPluginStatus query: {query.plugin_name}={active}")
        return GetPluginStatusResponse(active=active)

    @method_contract(
        method_id=ConfigMethods.SET_PLUGIN,
        summary="Update plugin status",
        input_model=UpdatePluginStatusCommand,
        output_model=UpdateConfigResponse,
        exposure="both",
        method_type="manage",
    )
    async def _handle_update_plugin_status(
        self, cmd: UpdatePluginStatusCommand
    ) -> UpdateConfigResponse:
        """Handle UpdatePluginStatus command."""
        try:
            metadata = self.config_manager.set(
                f"services.tooling.plugins.{cmd.plugin_name}.activate", cmd.active
            )
            log_info(f"Updated plugin status: {cmd.plugin_name}={cmd.active}")
            return UpdateConfigResponse(success=True, **metadata)
        except Exception as e:
            log_error(f"Error updating plugin status: {e}")
            return UpdateConfigResponse(success=False, error=str(e))

    @method_contract(
        method_id=ConfigMethods.RELOAD_SERVICE,
        summary="Reload a service",
        input_model=ReloadServiceCommand,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="manage",
    )
    async def _handle_reload_service(self, cmd: ReloadServiceCommand) -> EmptyOutput:
        """Handle ReloadService command."""
        # Publish reload event for the service
        # In threads mode, supervisor will handle reload
        # In processes mode, service will handle its own reload
        log_info(f"Reload service requested: {cmd.service_name} (reason: {cmd.reason})")
        # The service will subscribe to Config.Changed events and reload itself
        return EmptyOutput()

    async def on_start(self) -> None:
        """Start the config service."""
        log_info("Starting ConfigService...")

        # Note: Subscriptions are now handled automatically by BaseService via @method_contract

        self._set_started(True)
        self._mesh_policy_rbac_task = asyncio.create_task(self._run_startup_mesh_policy_tasks())
        log_info("ConfigService started")

    async def _run_startup_mesh_policy_tasks(self) -> None:
        """Run Auth-dependent startup work after foundational services can subscribe."""

        auth_ready = await self._wait_for_auth_peer_inventory()
        report = (
            await self.refresh_mesh_policy_rbac_preflight()
            if auth_ready
            else self.config_manager.mesh_policy_rbac_report
        )
        if self.config_manager.mesh_policy_migration_audit:
            await self._audit_mesh_config_event(
                "mesh.config.migrated",
                actor="startup",
                details=self.config_manager.mesh_policy_migration_audit,
            )
        if isinstance(report, dict):
            await self._audit_mesh_config_event(
                "mesh.config.rbac_review",
                actor="startup",
                details={
                    "release_blocking": bool(report.get("release_blocking")),
                    "reason": report.get("reason"),
                    "affected_service_count": sum(
                        1
                        for row in report.get("services", [])
                        if row.get("severity") == "release_blocking"
                    ),
                },
            )

    async def _wait_for_auth_peer_inventory(self) -> bool:
        """Wait until the local Auth peer inventory contract can receive requests.

        LocalBus can report subscription readiness exactly. Distributed buses
        cannot observe subscribers in another process, so they retain the
        short startup grace period and rely on the existing bounded request
        retries.
        """

        has_subscribers = getattr(self.bus, "has_subscribers", None)
        if not callable(has_subscribers):
            await asyncio.sleep(AUTH_DEPENDENT_STARTUP_GRACE_SECONDS)
            return True

        for attempt in range(AUTH_DEPENDENT_STARTUP_POLL_ATTEMPTS):
            if has_subscribers(AuthMethods.MESH_LIST_PEERS):
                return True
            if attempt + 1 < AUTH_DEPENDENT_STARTUP_POLL_ATTEMPTS:
                await asyncio.sleep(AUTH_DEPENDENT_STARTUP_POLL_SECONDS)

        log_debug(
            "Skipping startup mesh policy refresh because Auth peer inventory "
            "did not become locally available"
        )
        return False

    async def refresh_mesh_policy_rbac_preflight(
        self,
        *,
        max_attempts: int = 5,
        backoff_seconds: float = 0.2,
    ) -> dict[str, Any] | None:
        """Refresh the migration RBAC preflight report if Auth is reachable."""
        last_report = self.config_manager.mesh_policy_rbac_report
        for attempt in range(1, max_attempts + 1):
            try:
                report = await self._refresh_mesh_policy_rbac_preflight_once()
                if report is not None:
                    return report
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log_error(
                    "Mesh policy RBAC preflight refresh attempt %s/%s failed: %s",
                    attempt,
                    max_attempts,
                    e,
                )
            if attempt < max_attempts:
                await asyncio.sleep(backoff_seconds)
        affected_services = [
            row["service"]
            for row in (last_report or {}).get("services", [])
            if row.get("severity") == "release_blocking"
        ]
        log_error(
            "Mesh policy RBAC preflight refresh exhausted: affected_service_count=%s affected_services=%s report_path=%s release_blocking=%s reason=%s",
            len(affected_services),
            ",".join(sorted(affected_services)),
            self.config_manager.mesh_policy_rbac_report_path,
            (last_report or {}).get("release_blocking"),
            (last_report or {}).get("reason"),
        )
        return last_report

    async def _refresh_mesh_policy_rbac_preflight_once(self) -> dict[str, Any] | None:
        """Attempt one Auth-backed RBAC preflight refresh."""
        try:
            from app.services.config.mesh_policy_migration import (
                build_rbac_preflight_report,
                persist_rbac_preflight_report,
            )
            from app.shared.contracts.models.auth import AuthMethods
            from app.shared.contracts.models.mesh import MeshPeerListRequest

            result = await self.bus.request(
                AuthMethods.MESH_LIST_PEERS,
                MeshPeerListRequest(include_disconnected=True),
                timeout=40.0,
            )
            if not getattr(result, "ok", False):
                log_error(
                    "Mesh policy RBAC preflight Auth query failed: report_path=%s",
                    self.config_manager.mesh_policy_rbac_report_path,
                )
                return None
            data = getattr(result, "data", None)
            peers = getattr(data, "peers", None)
            if peers is None and isinstance(data, dict):
                peers = data.get("peers")
            report = build_rbac_preflight_report(
                self.config_manager.get_config_dict(),
                peers=peers or [],
                inventory_complete=True,
                legacy_allowlist_evidence=(
                    self.config_manager.mesh_policy_legacy_allowlist_evidence
                ),
            )
            self.config_manager.mesh_policy_rbac_report = report
            self.config_manager.mesh_policy_rbac_report_path = str(
                persist_rbac_preflight_report(self.config_manager.config_file, report)
            )
            evidence = report.get("legacy_allowlist_evidence")
            if isinstance(evidence, dict):
                self.config_manager.mesh_policy_legacy_allowlist_evidence = evidence
            affected_services = [
                row["service"]
                for row in report.get("services", [])
                if row.get("severity") == "release_blocking"
            ]
            if report.get("release_blocking"):
                log_error(
                    "Mesh policy RBAC preflight has release-blocking findings: affected_service_count=%s affected_services=%s report_path=%s reason=%s",
                    len(affected_services),
                    ",".join(sorted(affected_services)),
                    self.config_manager.mesh_policy_rbac_report_path,
                    report.get("reason"),
                )
            else:
                log_info(
                    "Mesh policy RBAC preflight refreshed: affected_service_count=%s affected_services=%s report_path=%s release_blocking=%s reason=%s",
                    len(affected_services),
                    ",".join(sorted(affected_services)),
                    self.config_manager.mesh_policy_rbac_report_path,
                    report.get("release_blocking"),
                    report.get("reason"),
                )
            return report
        except Exception as e:
            log_error(f"Mesh policy RBAC preflight refresh failed: {e}")
            raise

    def _actor_from_envelope(self, envelope: Envelope | None) -> str:
        if envelope is None:
            return "internal"
        for attr in ("principal_id", "caller_peer_id", "identity_source"):
            value = getattr(envelope, attr, None)
            if value:
                return f"{attr}:{value}"
        return "internal"

    async def on_stop(self) -> None:
        """Stop the config service."""
        log_info("Stopping ConfigService...")
        if self._mesh_policy_rbac_task and not self._mesh_policy_rbac_task.done():
            self._mesh_policy_rbac_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._mesh_policy_rbac_task
        self._set_started(False)
        log_info("ConfigService stopped")

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_debug(f"Ignoring ConfigService self-reload request: section={config_section}")
