"""Tooling Service for Aurora's parallel architecture.

This service:
- Manages all tools (core, plugin, MCP)
- Handles tool initialization and lifecycle
- Exposes tool queries via message bus
- Emits events when tools change
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import re
import secrets
import time
import traceback
import uuid
from datetime import UTC, datetime, timezone
from typing import Any

from jsonschema import (
    Draft202012Validator,
    exceptions as jsonschema_exceptions,
)

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging.bus import Envelope
from app.messaging.priority_helpers import get_interactive_priority, get_system_priority
from app.services.db.sqlite_connection import SQLITE_CONNECT_TIMEOUT_SECONDS
from app.services.db.tooling_remote_catalog_store import (
    compute_projection_checksum,
    compute_projection_page_hash,
)
from app.services.tooling.export_policy import evaluate_tool_export_policy
from app.services.tooling.identity import (
    LoadedToolIdentity,
    ToolIdentityError,
    canonical_tool_global_id,
    normalize_legacy_aliases,
    parse_canonical_tool_global_id,
    stamp_tool,
)
from app.services.tooling.projection import (
    ProjectionContext,
    build_recipient_blocked_inventory,
    build_recipient_projection,
    permission_satisfies,
)
from app.services.tooling.projection_cursor import (
    ProjectionCursor,
    ProjectionCursorCodec,
    ProjectionCursorError,
)
from app.services.tooling.tools_manager import ToolsManager, set_tools_manager
from app.shared.config.interface import ConfigAPI
from app.shared.contracts.models.auth import (
    AuditLogRequest,
    AuthMethods,
    PrincipalGetRequest,
    StoreAuditEventRequest,
)
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.db import (
    DBAbortToolingRemoteCatalogSyncRequest,
    DBAcceptToolingRemoteToolSchemaRequest,
    DBAllocateToolIdentityRequest,
    DBAppendToolingRemoteCatalogPageRequest,
    DBBeginToolingRemoteCatalogSyncRequest,
    DBCommitToolingRemoteCatalogSyncRequest,
    DBExecuteSQLRequest,
    DBFinalizeToolingRemoteCatalogPolicyRequest,
    DBGetToolingExportPolicySnapshotRequest,
    DBGetToolingExportPolicySnapshotResponse,
    DBGetToolingExposureLedgerRequest,
    DBGetToolingExposureLedgerResponse,
    DBGetToolingMeshActivationStateRequest,
    DBGetToolingRemoteCatalogRequest,
    DBMethods,
    DBMutateToolingExportPolicyRequest,
    DBMutateToolingExportPolicyResponse,
    DBPruneToolingRemoteCatalogRetentionRequest,
    DBReconcileToolIdentityRequest,
    DBRecordToolingExposuresRequest,
    DBRecordToolingExposuresResponse,
    DBRecoverToolingRemoteCatalogsRequest,
    DBResolveToolIdentityAliasesRequest,
    DBResolveToolingRemoteToolAliasesRequest,
    DBSetToolingRemoteProviderAvailabilityRequest,
    DBToolingExportRuleSeed,
    DBToolingExposureLedgerEntry,
)
from app.shared.contracts.models.gateway import (
    GatewayFetchToolingExportCatalogPageRequest,
    GatewayFetchToolingExportCatalogPageResponse,
    GatewayMethods,
)
from app.shared.contracts.models.mesh import (
    MeshAddressSelector,
    MeshEvents,
    MeshIdentityLoadRequest,
    MeshPeerGetRequest,
    MeshPeerGetResponse,
    MeshPeerListRequest,
    MeshPeerPermissionsUpdatedEvent,
)
from app.shared.contracts.models.tooling import (
    JS_SAFE_INTEGER_MAX,
    TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
    ToolingAcceptRemoteToolSchemaRequest,
    ToolingAcceptRemoteToolSchemaResponse,
    ToolingApprovalGrant,
    ToolingBlockedToolInfo,
    ToolingCatalogProviderInfo,
    ToolingClearSourcePolicyRequest,
    ToolingClearSourcePolicyResponse,
    ToolingClearToolExportOverrideRequest,
    ToolingClearToolExportOverrideResponse,
    ToolingClearToolPolicyOverrideRequest,
    ToolingClearToolPolicyOverrideResponse,
    ToolingConfirmExecutionRequest,
    ToolingConfirmExecutionResponse,
    ToolingCreateApprovalGrantRequest,
    ToolingCreateApprovalGrantResponse,
    ToolingCreateMCPSourceRequest,
    ToolingCreateMCPSourceResponse,
    ToolingCreatePluginSourceRequest,
    ToolingCreatePluginSourceResponse,
    ToolingEvaluateApprovalGrantRequest,
    ToolingEvaluateApprovalGrantResponse,
    ToolingExecuteToolRequest,
    ToolingExecuteToolResponse,
    ToolingExportMutationResponse,
    ToolingExportPrerequisiteEvidence,
    ToolingExportPrerequisites,
    ToolingExportPrerequisiteSource,
    ToolingExportPrerequisiteState,
    ToolingExportRecipientScope,
    ToolingGetExportCatalogRequest,
    ToolingGetExportCatalogResponse,
    ToolingGetMCPStatusRequest,
    ToolingGetMCPStatusResponse,
    ToolingGetOnboardingStatusRequest,
    ToolingGetOnboardingStatusResponse,
    ToolingGetPolicySummaryRequest,
    ToolingGetPolicySummaryResponse,
    ToolingGetSharingPolicyRequest,
    ToolingGetSharingPolicyResponse,
    ToolingGetStatsRequest,
    ToolingGetStatsResponse,
    ToolingGetToolByNameRequest,
    ToolingGetToolByNameResponse,
    ToolingGetToolCatalogRequest,
    ToolingGetToolCatalogResponse,
    ToolingGetToolExportPolicyRequest,
    ToolingGetToolExportPolicyResponse,
    ToolingGetToolSourceDetailRequest,
    ToolingGetToolSourceDetailResponse,
    ToolingGetToolsRequest,
    ToolingGetToolsResponse,
    ToolingListApprovalGrantsRequest,
    ToolingListApprovalGrantsResponse,
    ToolingListPendingApprovalsRequest,
    ToolingListPendingApprovalsResponse,
    ToolingListPolicyAuditEventsRequest,
    ToolingListPolicyAuditEventsResponse,
    ToolingListToolSourcesRequest,
    ToolingListToolSourcesResponse,
    ToolingMeshEnforcementActivated,
    ToolingMeshProjectionReadiness,
    ToolingMethods,
    ToolingModule,
    ToolingOnboardingCapability,
    ToolingPendingApproval,
    ToolingPolicyAuditEvent,
    ToolingPolicyDecision,
    ToolingPrepareExecutionRequest,
    ToolingPrepareExecutionResponse,
    ToolingPreviewToolExportDecisionRequest,
    ToolingPreviewToolExportDecisionResponse,
    ToolingProjectionAuthorityRevision,
    ToolingProjectionInvalidated,
    ToolingProjectionRetirement,
    ToolingProjectionSyncRequested,
    ToolingRateLimitHints,
    ToolingReloadMCPRequest,
    ToolingRemoteCatalogAnnounced,
    ToolingRemoteCatalogDeltaAnnounced,
    ToolingRemoteCatalogRefreshRequested,
    ToolingRemoteCatalogRemoved,
    ToolingRequestApprovalRequest,
    ToolingRequestApprovalResponse,
    ToolingRetainedRemoteTool,
    ToolingRevokeApprovalGrantRequest,
    ToolingRevokeApprovalGrantResponse,
    ToolingSetPolicyModeRequest,
    ToolingSetPolicyModeResponse,
    ToolingSetSharingPolicyRequest,
    ToolingSetSharingPolicyResponse,
    ToolingSetToolExportDefaultRequest,
    ToolingSetToolExportDefaultResponse,
    ToolingSharingPolicy,
    ToolingSharingPolicyRule,
    ToolingTestMCPSourceRequest,
    ToolingTestMCPSourceResponse,
    ToolingTestPluginSourceRequest,
    ToolingTestPluginSourceResponse,
    ToolingTestSharingPolicyRequest,
    ToolingTestSharingPolicyResponse,
    ToolingToolInfo,
    ToolingToolProvenance,
    ToolingToolSourceSummary,
    ToolingUpsertSourcePolicyRequest,
    ToolingUpsertSourcePolicyResponse,
    ToolingUpsertToolExportOverrideRequest,
    ToolingUpsertToolExportOverrideResponse,
    ToolingUpsertToolGroupExportPolicyRequest,
    ToolingUpsertToolGroupExportPolicyResponse,
    ToolingUpsertToolPolicyOverrideRequest,
    ToolingUpsertToolPolicyOverrideResponse,
)
from app.shared.contracts.registry import IOModel, all_contracts, method_contract
from app.shared.messaging.models.tooling_models import (
    ToolsInitialized,
    ToolsReloaded,
)
from app.shared.services.base_service import BaseService


class _ProjectionFetchUnavailableError(RuntimeError):
    """Transient remote projection fetch failure that must remain fail closed."""

ToolingDiscoveryRequest = (
    ToolingGetToolsRequest | ToolingGetToolByNameRequest | ToolingExecuteToolRequest
)

_ARG_REDACT_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "password",
    "secret",
    "token",
}
_ERROR_REDACT_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)bearer\s+[a-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[^'\"\s]+"),
    re.compile(r"\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b"),
)
TOOLING_AUDIT_REQUEST_TIMEOUT_SECONDS = 0.5
TOOLING_DB_REQUEST_TIMEOUT_SECONDS = SQLITE_CONNECT_TIMEOUT_SECONDS + 5.0
REMOTE_CATALOG_RETENTION_STARTUP_DELAY_SECONDS = 30.0
REMOTE_CATALOG_RETENTION_INTERVAL_SECONDS = 6 * 60 * 60
_CATALOG_REVISION_DIGEST_BITS = 53


def _derive_js_safe_catalog_revision(catalog_material: str) -> int:
    """Return a deterministic SHA-256 revision that fits JSON safe integers."""

    digest_prefix = hashlib.sha256(catalog_material.encode()).digest()[:8]
    revision = int.from_bytes(digest_prefix, "big") >> (64 - _CATALOG_REVISION_DIGEST_BITS)
    return min(revision, JS_SAFE_INTEGER_MAX)


_TOOL_LEXICAL_STOPWORDS = {
    "use",
    "tool",
    "tools",
    "please",
    "the",
    "about",
    "latest",
    "news",
    "current",
    "events",
    "today",
    "web",
    "internet",
}
_TOOL_WEB_INTENT_TOKENS = {"web", "internet", "news"}
_TOOL_CURRENT_EVENTS_INTENT = {"current", "events"}


# Service implementation
class ToolingService(BaseService):
    """Tooling service.

    Responsibilities:
    - Initialize ToolsManager
    - Load all tools in correct order
    - Handle tool queries via message bus
    - Manage tool lifecycle
    """

    def __init__(self):
        """Initialize tooling service."""
        super().__init__(
            module=ToolingModule.NAME,
            summary="Tool management and execution service",
            capabilities=["tool_discovery", "tool_execution", "mcp_integration"],
        )
        self._config = ConfigAPI()
        self.tools_manager = ToolsManager(self.bus)
        self._catalog_cache: dict[str, tuple[float, ToolingGetToolsResponse]] = {}
        self._sharing_policy = ToolingSharingPolicy()
        self._approval_requests: dict[str, dict[str, Any]] = {}
        self._approval_tokens: dict[str, dict[str, Any]] = {}
        self._remote_catalog_snapshots: dict[
            tuple[str, str], tuple[ToolingRemoteCatalogAnnounced, float]
        ] = {}
        # Provider reachability and recipient-specific grants are negotiated
        # session state.  They must never be restored from the durable catalog
        # snapshot because doing so would make cached tools callable before a
        # peer has authenticated and re-announced its current manifest.
        self._remote_provider_states: dict[tuple[str, str], tuple[list[str] | None, bool]] = {}
        self._tooling_policy_tables_ready = False
        self._legacy_remote_catalog_cleanup_done = False
        self._peer_display_names: dict[str, str] = {}
        self._peer_export_current_ids: set[str] = set()
        self._peer_display_names_loaded_at = 0.0
        self._stable_peer_id: str | None = None
        self._projection_cursor_codec = ProjectionCursorCodec()
        self._projection_cursor_ttl_seconds = 120
        self._projection_sync_tasks: dict[str, Any] = {}
        self._projection_sync_ids: dict[str, str] = {}
        self._projection_sync_pending: dict[str, ToolingProjectionSyncRequested] = {}
        self._policy_reconciliation_inflight: set[str] = set()
        self._mesh_projection_enforcement_active = False
        self._normalized_catalog_recovery_failed = False
        self._remote_catalog_retention_task: asyncio.Task[Any] | None = None

    async def on_start(self) -> None:
        """Start the tooling service and initialize tools."""
        log_info("Starting Tooling service...")
        await self._load_sharing_policy_from_config()
        await self._ensure_tooling_policy_tables()
        await self._load_stable_tooling_peer_id()

        # Set as global instance
        set_tools_manager(self.tools_manager)

        # Initialize tools
        log_info("Initializing tools...")
        await self.tools_manager.initialize()
        await self._reconcile_local_tool_identities()
        await self._migrate_legacy_tool_export_policy()
        await self._activate_mesh_projection_enforcement()
        await self._recover_normalized_remote_catalogs()
        readiness = await self._on_get_mesh_projection_readiness(EmptyInput())
        await self.bus.publish(
            ToolingMethods.MESH_PROJECTION_READINESS_CHANGED,
            readiness,
            event=True,
            mesh=False,
            origin="internal",
        )
        if (
            self._mesh_projection_enforcement_active
            and not self._normalized_catalog_recovery_failed
        ):
            self._remote_catalog_retention_task = asyncio.create_task(
                self._remote_catalog_retention_loop()
            )

        self.bus.subscribe(
            MeshEvents.PEER_PERMISSIONS_UPDATED,
            self._on_mesh_peer_permissions_updated,
        )

        # Emit initialization event
        stats = self.tools_manager.get_stats()
        await self.bus.publish(
            ToolingMethods.TOOLS_INITIALIZED,
            ToolsInitialized(
                total_tools=stats["total_tools"], mcp_tools_loaded=stats["mcp_tools_loaded"]
            ),
            event=True,
            mesh=False,
            priority=get_system_priority(),
            origin="internal",
        )
        await self._announce_local_tool_catalog(reason="startup")

        log_info(f"Tooling service started with {stats['total_tools']} tools")

    async def _recover_normalized_remote_catalogs(self) -> None:
        """Recover crashed staging and compact safe history before any binding read."""

        self._normalized_catalog_recovery_failed = False
        if not self._mesh_projection_enforcement_active:
            return
        correlation_id = str(uuid.uuid4())
        recovered = await self.bus.request(
            DBMethods.RECOVER_TOOLING_REMOTE_CATALOGS,
            DBRecoverToolingRemoteCatalogsRequest(correlation_id=correlation_id),
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
            priority=get_system_priority(),
        )
        data = (
            recovered.data.model_dump(mode="python")
            if recovered.data is not None and hasattr(recovered.data, "model_dump")
            else recovered.data or {}
        )
        if not recovered.ok or not bool(data.get("ok")):
            self._normalized_catalog_recovery_failed = True
            self._catalog_cache.clear()
            log_error("Normalized remote Tooling catalog recovery failed closed")
            return

        providers = {
            str(peer_id)
            for peer_id in data.get("providers_needing_sync", [])
            if isinstance(peer_id, str) and peer_id
        }
        if not providers:
            return
        catalog = await self.bus.request(
            DBMethods.GET_TOOLING_REMOTE_CATALOG,
            DBGetToolingRemoteCatalogRequest(include_inactive=True),
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
        )
        catalog_data = (
            catalog.data.model_dump(mode="python")
            if catalog.data is not None and hasattr(catalog.data, "model_dump")
            else catalog.data or {}
        )
        service_by_peer: dict[str, str] = {}
        for raw in catalog_data.get("headers", []) if isinstance(catalog_data, dict) else []:
            header = raw.model_dump(mode="python") if hasattr(raw, "model_dump") else raw
            if isinstance(header, dict) and str(header.get("peer_id") or "") in providers:
                service_by_peer[str(header["peer_id"])] = str(header["service_instance_id"])
        live_candidates = {
            str(candidate.peer.peer_id): candidate
            for candidate in self._remote_tooling_candidates()
            if getattr(getattr(candidate, "peer", None), "peer_id", None)
            and bool(getattr(candidate, "eligible", False))
            and self._candidate_granted_permissions(candidate) is not None
        }
        for peer_id in sorted(providers):
            # Recovery identifies durable rows that need a new baseline; it is
            # not live transport authority. Offline peers remain retained and
            # stale. Gateway's authenticated manifest-ready path will request
            # exactly one full sync when the peer becomes eligible.
            if peer_id not in live_candidates:
                continue
            await self.bus.publish(
                ToolingMethods.PROJECTION_SYNC_REQUESTED,
                ToolingProjectionSyncRequested(
                    provider_peer_id=peer_id,
                    service_instance_id=service_by_peer.get(peer_id, f"remote:{peer_id}:Tooling"),
                    reason_code="startup_recovery",
                    force_full_snapshot=True,
                ),
                event=True,
                mesh=False,
                origin="internal",
                priority=get_system_priority(),
            )

    async def _prune_normalized_remote_catalog_retention(
        self, *, correlation_id: str | None = None
    ) -> None:
        """Run one typed, policy-preserving retention compaction."""

        pruned = await self._request_db(
            DBMethods.PRUNE_TOOLING_REMOTE_CATALOG_RETENTION,
            DBPruneToolingRemoteCatalogRetentionRequest(
                correlation_id=correlation_id,
            ),
        )
        if not pruned.ok:
            log_warning("Remote Tooling retention compaction failed; retained history preserved")

    async def _remote_catalog_retention_loop(self) -> None:
        """Bound long-running retained history without touching authority records."""

        delay_seconds = REMOTE_CATALOG_RETENTION_STARTUP_DELAY_SECONDS
        while True:
            await asyncio.sleep(delay_seconds)
            try:
                await self._prune_normalized_remote_catalog_retention(
                    correlation_id=str(uuid.uuid4())
                )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log_warning(f"Remote Tooling retention maintenance failed safely: {error}")
            delay_seconds = REMOTE_CATALOG_RETENTION_INTERVAL_SECONDS

    async def _activate_mesh_projection_enforcement(self) -> None:
        """Honor only a previously attested durable G013 activation state.

        Tooling cannot attest Gateway subscriptions, manifest evidence, the
        provider ledger, or downgrade protection by inspecting itself.  A
        coordinated readiness owner must perform the CAS; startup is read-only
        and leaves the legacy guard authoritative otherwise.
        """

        self._mesh_projection_enforcement_active = False
        try:
            read = await self.bus.request(
                DBMethods.GET_TOOLING_MESH_ACTIVATION_STATE,
                DBGetToolingMeshActivationStateRequest(),
                origin="internal",
            )
            # MessageBus mocks and unavailable DB implementations may return
            # awaitables/model doubles rather than a concrete QueryResult.
            # Never activate from ambiguous state and do not call mock
            # ``model_dump`` attributes that can create unawaited coroutines.
            if not isinstance(getattr(read, "ok", None), bool) or not read.ok:
                return
            if read.data is None:
                return
            read_data = (
                read.data.model_dump(mode="python")
                if hasattr(read.data, "model_dump")
                else read.data
            )
            state = read_data.get("state", read_data)
            if state.get("active") and state.get("legacy_guard_retired"):
                self._mesh_projection_enforcement_active = True
        except Exception as exc:
            self._mesh_projection_enforcement_active = False
            log_warning(f"Tooling mesh projection activation remains fail-closed: {exc}")

    @method_contract(
        method_id=ToolingMethods.GET_MESH_PROJECTION_READINESS,
        summary="Report concrete Tooling mesh projection activation evidence",
        input_model=EmptyInput,
        output_model=ToolingMeshProjectionReadiness,
        exposure="internal",
    )
    async def _on_get_mesh_projection_readiness(
        self, _request: EmptyInput
    ) -> ToolingMeshProjectionReadiness:
        if not self._stable_peer_id:
            await self._load_stable_tooling_peer_id()
        contracts = all_contracts()
        projection_transport = ToolingMethods.GET_EXPORT_CATALOG in contracts and callable(
            getattr(self, "_on_get_export_catalog", None)
        )
        required_tables = {
            "tooling_remote_catalog_headers",
            "tooling_remote_catalog_tools",
            "tooling_remote_catalog_syncs",
            "tooling_remote_catalog_stage_pages",
            "tooling_remote_catalog_stage_tools",
            "tooling_remote_catalog_stage_retirements",
            "tooling_mesh_activation_state",
        }
        normalized_catalog = False
        durable_active = False
        durable_revision = 0
        legacy_guard_active = True
        typed_exposure_ledger = False
        try:
            rows = await self._db_sql(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tooling_%'"
            )
            normalized_catalog = required_tables.issubset(
                {str(row.get("name") or "") for row in rows}
            )
            state_result = await self._request_db(
                DBMethods.GET_TOOLING_MESH_ACTIVATION_STATE,
                DBGetToolingMeshActivationStateRequest(),
            )
            if state_result.ok and state_result.data is not None:
                data = (
                    state_result.data.model_dump(mode="python")
                    if hasattr(state_result.data, "model_dump")
                    else state_result.data
                )
                state = data.get("state", data)
                durable_active = bool(state.get("active")) and bool(
                    state.get("legacy_guard_retired")
                )
                durable_revision = int(state.get("revision", 0))
                legacy_guard_active = not bool(state.get("legacy_guard_retired"))
            if self._stable_peer_id:
                ledger_probe = await self._request_db(
                    DBMethods.GET_TOOLING_EXPOSURE_LEDGER,
                    DBGetToolingExposureLedgerRequest(
                        recipient_peer_id=self._stable_peer_id,
                        provider_id=self._stable_peer_id,
                    ),
                )
                if ledger_probe.ok and ledger_probe.data is not None:
                    DBGetToolingExposureLedgerResponse.model_validate(ledger_probe.data)
                    typed_exposure_ledger = True
        except Exception:
            normalized_catalog = False
        return ToolingMeshProjectionReadiness(
            projection_transport=projection_transport,
            normalized_catalog=normalized_catalog,
            consumer_binding=callable(getattr(self, "_consumer_mesh_execution_authorized", None)),
            provider_discovery=callable(getattr(self, "_on_get_tool_by_name", None)),
            prepare_enforcement=callable(getattr(self, "_on_prepare_execution", None)),
            execute_enforcement=callable(getattr(self, "_on_execute_tool", None)),
            typed_exposure_ledger=typed_exposure_ledger,
            execution_rpc_evidence=all(
                field in Envelope.model_fields
                for field in (
                    "projected_service_id",
                    "projected_method_id",
                    "projected_method_topics",
                    "projected_method_set_digest",
                )
            ),
            exact_method_set=callable(getattr(self, "_valid_projected_method_evidence", None)),
            mutation_invalidation=callable(getattr(self, "_mutate_tool_export_policy", None)),
            conditional_legacy_retirement=callable(
                getattr(self, "_provider_rpc_execution_authorized", None)
            ),
            legacy_guard_active=legacy_guard_active,
            durable_active=durable_active,
            durable_revision=durable_revision,
        )

    @method_contract(
        method_id=ToolingMethods.MESH_ENFORCEMENT_ACTIVATED,
        summary="Observe the durable Tooling mesh enforcement activation CAS",
        input_model=ToolingMeshEnforcementActivated,
        output_model=EmptyOutput,
        exposure="internal",
    )
    async def _on_mesh_enforcement_activated(
        self, _event: ToolingMeshEnforcementActivated
    ) -> EmptyOutput:
        await self._activate_mesh_projection_enforcement()
        return EmptyOutput()

    async def _on_mesh_peer_permissions_updated(
        self, envelope: Envelope
    ) -> EmptyOutput:
        MeshPeerPermissionsUpdatedEvent.model_validate(envelope.payload)
        # The event carries what this Aurora granted the peer.  Do not merge it
        # into ``_remote_provider_states``: that map contains the reciprocal,
        # peer-issued grants proved by the remote manifest.  Catalog and
        # execution authorization re-read Auth's current outbound grant below.
        self._catalog_cache.clear()
        return EmptyOutput()

    async def on_stop(self) -> None:
        """Stop the tooling service."""
        log_info("Stopping Tooling service...")
        current = asyncio.current_task()
        retention_task = self._remote_catalog_retention_task
        self._remote_catalog_retention_task = None
        if (
            retention_task is not None
            and retention_task is not current
            and not retention_task.done()
        ):
            retention_task.cancel()
            await asyncio.gather(retention_task, return_exceptions=True)
        sync_tasks = {
            task
            for task in self._projection_sync_tasks.values()
            if task is not None and task is not current and not task.done()
        }
        self._projection_sync_pending.clear()
        for task in sync_tasks:
            task.cancel()
        if sync_tasks:
            await asyncio.gather(*sync_tasks, return_exceptions=True)
        self._projection_sync_tasks.clear()
        self._projection_sync_ids.clear()
        with contextlib.suppress(Exception):
            self.bus.unsubscribe(
                MeshEvents.PEER_PERMISSIONS_UPDATED,
                self._on_mesh_peer_permissions_updated,
            )

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading ToolingService configuration: section={config_section}")
        # A full reload refreshes policy plus both config-owned tool managers.
        if config_section is None or config_section in ["services"]:
            await self._load_sharing_policy_from_config()
            log_info("Reloading tools due to config change...")
            await self.tools_manager.reload_plugin_tools()
            await self.tools_manager.reload_mcp_tools()
            await self._reconcile_local_tool_identities()
            self._catalog_cache.clear()
            await self._announce_local_tool_catalog(reason="reload")
        elif config_section == "services.tooling.mcp":
            await self.tools_manager.reload_mcp_tools()
            await self._reconcile_local_tool_identities()
            self._catalog_cache.clear()
            await self._announce_local_tool_catalog(reason="mcp_reload")
        elif config_section == "services.tooling.plugins":
            await self.tools_manager.reload_plugin_tools()
            await self._reconcile_local_tool_identities()
            self._catalog_cache.clear()
            await self._announce_local_tool_catalog(reason="plugin_reload")
        elif config_section == "services.tooling":
            await self._load_sharing_policy_from_config()
            await self._announce_local_tool_catalog(reason="policy_reload")
        log_info("ToolingService configuration reloaded")

    @staticmethod
    def _tool_source(tool: Any) -> str:
        """Best-effort source classification from the loader/provider boundary.

        Do not trust tool-supplied ``source`` metadata to elevate an MCP or
        plugin tool into the core/trusted bucket. Loader markers and module
        ownership are authoritative; explicit metadata is only accepted for
        non-elevating unknown/mesh classifications.
        """

        identity = getattr(tool, "_aurora_tool_identity", None)
        if isinstance(identity, LoadedToolIdentity) and identity.source_kind in {
            "core",
            "plugin",
            "mcp",
            "unknown",
        }:
            return identity.source_kind
        if getattr(tool, "_is_mcp_tool", False) is True:
            return "mcp"
        # LangChain tool wrappers report langchain_core as their module, so the
        # loader stamps its own classification (see ToolsManager._mark_loader_source).
        loader_source = getattr(tool, "_aurora_loader_source", None)
        if loader_source in {"core", "plugin", "mcp", "unknown"}:
            return loader_source
        module_name = getattr(tool, "__module__", "") or tool.__class__.__module__
        if (
            ".plugins." in module_name
            or ".plugin." in module_name
            or module_name.endswith("_toolkit")
        ):
            return "plugin"
        if module_name.startswith("app.services.tooling.tools"):
            return "core"
        if module_name.startswith(
            "langchain_community.tools"
        ) and ToolingService._is_known_web_search_tool(tool):
            return "core"
        explicit_source = getattr(tool, "source", None)
        if explicit_source == "core" and tool.__class__.__module__ == "unittest.mock":
            # Unit tests use Mock/MagicMock tool doubles with ``source="core"``.
            # Production tools must still be classified by loader/module
            # ownership rather than self-declared trusted metadata.
            return "core"
        if explicit_source in {"plugin", "mcp", "mesh_peer", "unknown"}:
            return explicit_source
        return "unknown"

    @staticmethod
    def _safe_identifier(value: str) -> str:
        """Return a LangChain/OpenAI-friendly stable identifier segment."""

        safe = re.sub(r"[^a-zA-Z0-9_-]+", "_", value.strip())
        safe = re.sub(r"_+", "_", safe).strip("_")
        return safe or "unnamed"

    def _provider_context(self, request: ToolingDiscoveryRequest) -> tuple[str, str, str, str]:
        """Return provider peer, service instance, source type, and namespace."""

        selector = request.mesh_selector
        if selector and (selector.peer_id or selector.provider_id or selector.service_instance_id):
            provider_peer_id = selector.peer_id or selector.provider_id or "remote"
            provider_service_instance_id = (
                selector.service_instance_id or f"remote:{provider_peer_id}:Tooling"
            )
            source_type = "mesh_peer"
            namespace = self._safe_identifier(provider_peer_id)
        else:
            provider_peer_id = self._stable_peer_id or "local"
            provider_service_instance_id = "local:Tooling"
            source_type = "local"
            namespace = "local"

        return provider_peer_id, provider_service_instance_id, source_type, namespace

    def _is_local_provider(self, provider_peer_id: str | None) -> bool:
        """Return whether a provider identifier denotes this device.

        Canonical local tool IDs use the durable Auth peer ID rather than the
        historical ``local`` sentinel, so migration-safe locality checks must
        accept both representations.
        """

        return provider_peer_id in {None, "", "local", self._stable_peer_id}

    async def _load_stable_tooling_peer_id(self) -> None:
        """Load the durable Auth identity used by canonical Tooling keys.

        Local tools remain usable when Auth is unavailable, but they stay on
        the explicit legacy/non-exportable compatibility path.  Canonical
        authority is never minted with the sentinel ``local`` peer ID.
        """

        try:
            result = await self.bus.request(
                AuthMethods.LOAD_MESH_IDENTITY,
                MeshIdentityLoadRequest(),
                origin="internal",
                timeout=5.0,
                priority=get_system_priority(),
            )
            if not result.ok:
                raise RuntimeError(result.error or "identity load failed")
            data = result.data
            peer_id = (
                data.get("peer_id") if isinstance(data, dict) else getattr(data, "peer_id", None)
            )
            if not isinstance(peer_id, str) or not peer_id.strip() or peer_id == "local":
                raise RuntimeError("stable mesh peer identity is unavailable")
            self._stable_peer_id = peer_id.strip()
        except Exception as error:
            self._stable_peer_id = None
            log_warning(
                "Stable Tooling identity unavailable; local catalog remains legacy and "
                f"non-exportable until Auth recovers: {error}"
            )

    def _legacy_identity_coordinates(
        self,
        tool: Any,
        *,
        stable_peer_id: str,
        source_kind: str,
        stable_source_id: str,
    ) -> tuple[str, str]:
        """Build a rename-safe locator for genuinely name-only providers.

        Presentation names and service-instance IDs are intentionally excluded.
        Indistinguishable legacy contracts therefore collide and fail closed
        rather than silently sharing authority.
        """

        schema = (
            tool.args_schema
            if isinstance(tool, ToolingToolInfo)
            else self._serialize_tool_schema(tool)
        )
        payload = {
            "v": 1,
            "peer": stable_peer_id,
            "source_kind": source_kind,
            "stable_source_id": stable_source_id,
            "module": str(getattr(tool, "__module__", "") or tool.__class__.__module__),
            "class": tool.__class__.__qualname__,
            "description": str(getattr(tool, "description", "") or ""),
            "schema": schema,
        }
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
        ).hexdigest()
        return f"legacy-tool:v1:{digest}", f"legacy-{digest[:32]}"

    async def _allocate_legacy_identity(
        self,
        tool: Any,
        *,
        stable_peer_id: str,
        local_name: str,
        source_kind: str,
        stable_source_id: str,
        share_group_id: str,
        share_group_label: str,
        legacy_global_tool_ids: list[str],
    ) -> LoadedToolIdentity:
        locator, provider_tool_id = self._legacy_identity_coordinates(
            tool,
            stable_peer_id=stable_peer_id,
            source_kind=source_kind,
            stable_source_id=stable_source_id,
        )
        result = await self.bus.request(
            DBMethods.ALLOCATE_TOOL_IDENTITY,
            DBAllocateToolIdentityRequest(
                stable_peer_id=stable_peer_id,
                legacy_identity_locator=locator,
                source_kind=source_kind,
                stable_source_id=stable_source_id,
                provider_tool_id=provider_tool_id,
                share_group_id=share_group_id,
                share_group_label=share_group_label,
                current_local_name=local_name,
                legacy_global_tool_ids=list(normalize_legacy_aliases(legacy_global_tool_ids)),
            ),
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
            priority=get_system_priority(),
        )
        if not result.ok:
            raise RuntimeError(result.error or "legacy Tooling identity allocation failed")
        data = result.data
        success = data.get("success") if isinstance(data, dict) else getattr(data, "success", False)
        contract_id = (
            data.get("allocated_tool_contract_id")
            if isinstance(data, dict)
            else getattr(data, "allocated_tool_contract_id", None)
        )
        if not success or not isinstance(contract_id, str) or not contract_id:
            error_code = (
                data.get("error_code")
                if isinstance(data, dict)
                else getattr(data, "error_code", None)
            )
            raise RuntimeError(error_code or "legacy Tooling identity allocation failed closed")
        return LoadedToolIdentity(
            tool_contract_id=contract_id,
            stable_source_id=stable_source_id,
            provider_tool_id=provider_tool_id,
            share_group_id=share_group_id,
            share_group_label=share_group_label,
            source_kind=source_kind,
            exportable=source_kind != "mesh_peer",
        )

    async def _reconcile_local_tool_identities(self) -> None:
        """Atomically register loaded canonical identities and legacy aliases."""

        if not self._stable_peer_id:
            return
        loaded_tools = self.tools_manager.get_tools(query=None, top_k=10_000)
        name_counts: dict[str, int] = {}
        for loaded_tool in loaded_tools:
            loaded_name = str(getattr(loaded_tool, "name", "")).strip()
            if loaded_name:
                name_counts[loaded_name] = name_counts.get(loaded_name, 0) + 1
        ambiguous_names = {name for name, count in name_counts.items() if count > 1}
        for tool in loaded_tools:
            identity = getattr(tool, "_aurora_tool_identity", None)
            if not isinstance(identity, LoadedToolIdentity):
                local_name = str(getattr(tool, "name", "")).strip()
                source_kind = self._tool_source(tool)
                if not local_name or source_kind == "core":
                    raise RuntimeError(
                        f"Core/unnamed tool {local_name or '<unnamed>'} lacks an explicit "
                        "immutable identity"
                    )
                stable_source_id = self._safe_identifier(
                    str(
                        getattr(tool, "mcp_server_name", None)
                        or getattr(tool, "_aurora_mcp_server_id", None)
                        or getattr(tool, "_aurora_stable_source_id", None)
                        or getattr(tool, "plugin_name", None)
                        or getattr(tool, "_aurora_plugin_id", None)
                        or source_kind
                    )
                )[:160]
                share_group_id = f"{source_kind}:{stable_source_id}"[:160]
                legacy_ids = (
                    []
                    if local_name in ambiguous_names
                    else [
                        self._global_tool_id("local", "local:Tooling", local_name),
                        self._global_tool_id(self._stable_peer_id, "local:Tooling", local_name),
                    ]
                )
                identity = await self._allocate_legacy_identity(
                    tool,
                    stable_peer_id=self._stable_peer_id,
                    local_name=local_name,
                    source_kind=source_kind,
                    stable_source_id=stable_source_id,
                    share_group_id=share_group_id,
                    share_group_label=str(
                        getattr(tool, "mcp_server_name", None)
                        or getattr(tool, "_aurora_mcp_server_id", None)
                        or getattr(tool, "plugin_name", None)
                        or "Legacy tools"
                    )[:120],
                    legacy_global_tool_ids=legacy_ids,
                )
                stamp_tool(tool, identity)
            local_name = str(getattr(tool, "name", "")).strip()
            if not local_name:
                continue
            canonical_id = canonical_tool_global_id(self._stable_peer_id, identity.tool_contract_id)
            legacy_ids = normalize_legacy_aliases(
                (
                    []
                    if local_name in ambiguous_names
                    else [
                        self._global_tool_id("local", "local:Tooling", local_name),
                        self._global_tool_id(self._stable_peer_id, "local:Tooling", local_name),
                    ]
                ),
                canonical_id=canonical_id,
            )
            result = await self.bus.request(
                DBMethods.RECONCILE_TOOL_IDENTITY,
                DBReconcileToolIdentityRequest(
                    canonical_global_tool_id=canonical_id,
                    stable_peer_id=self._stable_peer_id,
                    tool_contract_id=identity.tool_contract_id,
                    source_kind=identity.source_kind,
                    stable_source_id=identity.stable_source_id,
                    provider_tool_id=identity.provider_tool_id,
                    share_group_id=identity.share_group_id,
                    share_group_label=identity.share_group_label,
                    current_local_name=local_name,
                    legacy_global_tool_ids=list(legacy_ids),
                ),
                origin="internal",
                timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
                priority=get_system_priority(),
            )
            if not result.ok:
                raise RuntimeError(
                    f"Tool identity reconciliation failed for {identity.tool_contract_id}: "
                    f"{result.error or 'unknown DB error'}"
                )
            data = result.data
            success = (
                data.get("success") if isinstance(data, dict) else getattr(data, "success", False)
            )
            if not success:
                error_code = (
                    data.get("error_code")
                    if isinstance(data, dict)
                    else getattr(data, "error_code", None)
                )
                raise RuntimeError(
                    f"Tool identity reconciliation failed closed for "
                    f"{identity.tool_contract_id}: {error_code or 'identity_conflict'}"
                )
        await self._migrate_policy_rule_tool_ids()

    @classmethod
    def _global_tool_id(
        cls, provider_peer_id: str, service_instance_id: str, local_name: str
    ) -> str:
        """Build a stable global tool identifier for a provider-local tool."""

        return (
            f"{cls._safe_identifier(provider_peer_id)}:"
            f"{cls._safe_identifier(service_instance_id)}:"
            f"tool:{cls._safe_identifier(local_name)}"
        )

    def _tool_identity_payload(
        self,
        tool: Any,
        *,
        provider_peer_id: str,
        service_instance_id: str,
        local_name: str,
        is_remote: bool,
    ) -> dict[str, Any]:
        """Return canonical loader identity metadata or a fail-closed legacy view."""

        legacy_id = self._global_tool_id(provider_peer_id, service_instance_id, local_name)
        legacy_ids = [legacy_id]
        if not is_remote and provider_peer_id != "local":
            legacy_ids.append(self._global_tool_id("local", "local:Tooling", local_name))
        identity = getattr(tool, "_aurora_tool_identity", None)
        canonical_peer_id = provider_peer_id if is_remote else self._stable_peer_id
        if not isinstance(identity, LoadedToolIdentity) or not canonical_peer_id:
            return {
                "global_tool_id": legacy_id,
                "tool_id_scheme": "legacy",
                "tool_id_version": 0,
                "tool_contract_id": "",
                "share_group_id": "",
                "share_group_label": "",
                "legacy_global_tool_ids": [],
                "exportable": False,
                "identity": None,
            }
        canonical_id = canonical_tool_global_id(canonical_peer_id, identity.tool_contract_id)
        return {
            "global_tool_id": canonical_id,
            "tool_id_scheme": identity.tool_id_scheme,
            "tool_id_version": identity.tool_id_version,
            "tool_contract_id": identity.tool_contract_id,
            "share_group_id": identity.share_group_id,
            "share_group_label": identity.share_group_label,
            "legacy_global_tool_ids": list(
                normalize_legacy_aliases(legacy_ids, canonical_id=canonical_id)
            ),
            "exportable": bool(identity.exportable and not is_remote),
            "identity": identity,
        }

    @classmethod
    def _namespaced_tool_name(cls, namespace: str, local_name: str) -> str:
        """Build the bindable namespaced tool name used for remote providers."""

        return f"{cls._safe_identifier(namespace)}_{cls._safe_identifier(local_name)}"

    async def _refresh_peer_display_names(self, *, force: bool = False) -> None:
        """Refresh presentation-only peer labels from Auth's stable peer registry."""

        now = time.monotonic()
        if not force and now - self._peer_display_names_loaded_at < 5.0:
            return
        try:
            result = await self.bus.request(
                AuthMethods.MESH_LIST_PEERS,
                MeshPeerListRequest(include_disconnected=True),
                origin="internal",
                timeout=5.0,
                priority=get_interactive_priority(),
            )
        except Exception as error:
            log_debug(f"Peer display-name refresh unavailable: {error}")
            self._peer_display_names_loaded_at = now
            return
        if not result.ok:
            log_debug(f"Peer display-name refresh rejected: {result.error}")
            self._peer_display_names_loaded_at = now
            return

        data = result.data
        peers = getattr(data, "peers", None)
        if peers is None and isinstance(data, dict):
            peers = data.get("peers")
        if not isinstance(peers, (list, tuple)):
            self._peer_display_names_loaded_at = now
            return
        labels: dict[str, str] = {}
        current_ids: set[str] = set()
        for peer in peers:
            peer_id = getattr(peer, "peer_id", None)
            node_name = getattr(peer, "node_name", None)
            outbound_status = getattr(peer, "outbound_status", None)
            if isinstance(peer, dict):
                peer_id = peer.get("peer_id")
                node_name = peer.get("node_name")
                outbound_status = peer.get("outbound_status")
            peer_id_text = str(peer_id or "").strip()
            node_name_text = str(node_name or "").strip()
            if peer_id_text and node_name_text:
                labels[peer_id_text] = node_name_text
            if peer_id_text and outbound_status == "approved":
                current_ids.add(peer_id_text)
        self._peer_display_names = labels
        self._peer_export_current_ids = current_ids
        self._peer_display_names_loaded_at = now

    def _peer_display_name(self, peer_id: str) -> str:
        """Return a human label while preserving the peer ID as fallback only."""

        return self._peer_display_names.get(peer_id) or peer_id

    def _serialize_tool_schema(self, tool: Any) -> dict[str, Any]:
        """Serialize the tool argument schema for LLM binding."""

        if not hasattr(tool, "args_schema") or not tool.args_schema:
            return {"type": "object", "properties": {}}

        try:
            full_schema = tool.args_schema.model_json_schema()
        except Exception as json_schema_error:
            log_debug(
                "Direct schema generation failed for "
                f"{tool.name}, attempting manual extraction: {json_schema_error}"
            )
            return self._extract_schema_manually(tool)

        if "properties" not in full_schema:
            return {"type": "object", "properties": {}}

        filtered_properties = {
            prop_name: prop_value
            for prop_name, prop_value in full_schema["properties"].items()
            if prop_name not in ["bus", "store"]
        }
        args_schema: dict[str, Any] = {
            "type": "object",
            "properties": filtered_properties,
        }

        if "required" in full_schema:
            filtered_required = [
                field for field in full_schema["required"] if field not in ["bus", "store"]
            ]
            if filtered_required:
                args_schema["required"] = filtered_required

        return args_schema

    def _serialize_tool(
        self, tool: Any, request: ToolingGetToolsRequest | ToolingGetToolByNameRequest
    ) -> ToolingToolInfo:
        """Serialize a loaded tool with stable mesh-aware discovery metadata."""

        provider_peer_id, service_instance_id, source_type, namespace = self._provider_context(
            request
        )
        local_name = tool.name
        is_remote = source_type == "mesh_peer"
        identity_payload = self._tool_identity_payload(
            tool,
            provider_peer_id=provider_peer_id,
            service_instance_id=service_instance_id,
            local_name=local_name,
            is_remote=is_remote,
        )
        global_tool_id = str(identity_payload["global_tool_id"])
        loaded_identity = identity_payload["identity"]
        bindable_name = (
            self._namespaced_tool_name(namespace, local_name) if is_remote else local_name
        )
        display_name = f"{namespace}.{local_name}" if is_remote else local_name
        args_schema = self._serialize_tool_schema(tool)
        required_permissions = self._tool_required_permissions(tool)
        safety_class = self._safe_metadata_value(
            getattr(tool, "safety_class", "standard"),
            {"standard", "sensitive", "dangerous"},
            "standard",
        )
        operation_class = self._operation_class(tool, safety_class)
        raw_source = "mesh_peer" if is_remote else self._tool_source(tool)
        source = self._safe_metadata_value(
            raw_source, {"core", "plugin", "mcp", "mesh_peer", "unknown"}, "unknown"
        )
        source_id = (
            f"mesh:{provider_peer_id}:{self._safe_identifier(service_instance_id)}"
            if is_remote
            else self._local_source_instance_id(tool, source)
        )
        trust_tier = self._tool_trust_tier(tool, source)
        capability_class = self._capability_class(tool, operation_class)

        return ToolingToolInfo(
            name=bindable_name,
            local_name=local_name,
            global_tool_id=global_tool_id,
            tool_id_scheme=identity_payload["tool_id_scheme"],
            tool_id_version=identity_payload["tool_id_version"],
            tool_contract_id=identity_payload["tool_contract_id"],
            share_group_id=identity_payload["share_group_id"],
            share_group_label=identity_payload["share_group_label"],
            legacy_global_tool_ids=identity_payload["legacy_global_tool_ids"],
            exportable=identity_payload["exportable"],
            provider_peer_id=provider_peer_id,
            provider_service_instance_id=service_instance_id,
            provider_label=None,
            namespace=namespace,
            display_name=display_name,
            aliases=[local_name] if bindable_name != local_name else [],
            description=getattr(tool, "description", "") or "",
            args_schema=args_schema,
            schema=args_schema,
            argument_visibility=self._argument_visibility(tool),
            source_type=source_type,
            source=source,
            source_id=source_id,
            trust_tier=trust_tier,
            capability_class=capability_class,
            resource_scope=self._resource_scope(tool),
            execution_location="remote" if is_remote else "local",
            safety_class=safety_class,
            risk_class=self._risk_class(tool, safety_class),
            data_egress=self._tool_data_egress(tool, operation_class),
            mutating=self._tool_mutating(tool, operation_class),
            external=self._tool_external(tool, operation_class),
            admin=self._tool_admin(tool, operation_class),
            privacy_hints=self._tool_privacy_hints(tool, safety_class, operation_class),
            required_permissions=required_permissions,
            confirmation_required=bool(getattr(tool, "confirmation_required", False)),
            rate_limit_hints=self._tool_rate_limit_hints(tool),
            provenance=ToolingToolProvenance(
                provider_peer_id=provider_peer_id,
                provider_service_instance_id=service_instance_id,
                provider_kind=source_type,
                source="unknown" if source == "mesh_peer" else source,
                advertised_name=local_name,
                stable_source_id=(
                    loaded_identity.stable_source_id
                    if isinstance(loaded_identity, LoadedToolIdentity)
                    else None
                ),
                provider_tool_id=(
                    loaded_identity.provider_tool_id
                    if isinstance(loaded_identity, LoadedToolIdentity)
                    else None
                ),
            ),
        )

    def _provider_visible_export_tools(self) -> list[ToolingToolInfo]:
        """Serialize the local catalog as it appears through mesh export authority."""

        export_service_instance_id = (
            f"remote:{self._stable_peer_id}:Tooling" if self._stable_peer_id else "local:Tooling"
        )
        all_tools = []
        for loaded_tool in self.tools_manager.get_tools(None, 10_000):
            tool = self._serialize_tool(loaded_tool, ToolingGetToolsRequest(top_k=10_000))
            if tool.source_type == "local":
                tool = tool.model_copy(
                    update={
                        "provider_peer_id": self._stable_peer_id,
                        "provider_service_instance_id": export_service_instance_id,
                        "provenance": tool.provenance.model_copy(
                            update={
                                "provider_peer_id": self._stable_peer_id,
                                "provider_service_instance_id": export_service_instance_id,
                            }
                        ),
                    }
                )
            all_tools.append(tool)
        return all_tools

    @staticmethod
    def _export_catalog_material(tools: list[ToolingToolInfo]) -> str:
        """Return the canonical material hashed for catalog authority revisions."""

        return json.dumps(
            [
                item.model_dump(mode="json")
                for item in sorted(tools, key=lambda x: x.global_tool_id)
            ],
            sort_keys=True,
            default=str,
        )

    @staticmethod
    def _safe_metadata_value(value: Any, allowed: set[str], fallback: str) -> str:
        """Return value if allowed, otherwise a stable fallback."""

        return value if isinstance(value, str) and value in allowed else fallback

    @staticmethod
    def _capability_class(tool: Any, operation_class: str) -> str:
        """Return the coarse capability class used by operator-facing policy."""

        explicit = getattr(tool, "capability_class", None)
        allowed = {"read", "write", "execute", "network", "secrets", "device", "admin"}
        if isinstance(explicit, str) and explicit in allowed:
            return explicit
        if operation_class == "admin":
            return "admin"
        if operation_class == "hardware":
            return "device"
        if operation_class == "external":
            return "network"
        if operation_class == "write":
            return "write"
        return "read"

    @staticmethod
    def _tool_trust_tier(tool: Any, source: str) -> str:
        """Return conservative effective trust for the tool catalog source."""

        trust_tier = getattr(tool, "trust_tier", None)
        if trust_tier == "blocked":
            return "blocked"
        if source == "core" and trust_tier in {"trusted", "untrusted"}:
            return trust_tier
        return "trusted" if source == "core" else "untrusted"

    @staticmethod
    def _is_known_web_search_tool(tool: Any) -> bool:
        """Return whether a loaded tool is Aurora's known DDG/Brave search tool.

        This does not honor arbitrary ``source='core'`` metadata; it recognizes
        the loader-provided LangChain DuckDuckGo/Brave tool identities and their
        stable names/descriptions.
        """

        name = str(getattr(tool, "name", "") or "").lower()
        description = str(getattr(tool, "description", "") or "").lower()
        module_name = str(getattr(tool, "__module__", "") or tool.__class__.__module__).lower()
        class_name = tool.__class__.__name__.lower()
        haystack = f"{name} {description} {module_name} {class_name}"
        mentions_duckduckgo = (
            "duckduckgo" in haystack
            or "duck duck go" in haystack
            or name == "duckduckgo_results_json"
        )
        mentions_brave = "brave" in haystack
        search_like = (
            "search" in haystack
            or "current event" in haystack
            or "latest" in haystack
            or "news" in haystack
        )
        return (mentions_duckduckgo or mentions_brave) and search_like

    @staticmethod
    def _resource_scope(tool: Any) -> list[str]:
        scope = getattr(tool, "resource_scope", None)
        if isinstance(scope, list):
            return [str(item) for item in scope]
        if isinstance(scope, tuple | set):
            return [str(item) for item in scope]
        if isinstance(scope, str) and scope:
            return [scope]
        return []

    @staticmethod
    def _request_resource_values(request: ToolingExecuteToolRequest) -> list[str]:
        """Return concrete resource selector values carried by an execution request."""

        selector = request.resource_selector
        if not selector:
            return []
        values = [
            selector.resource_namespace,
            selector.resource_id,
            selector.resource_type,
            selector.hardware_target,
            selector.data_scope,
        ]
        return [str(value) for value in values if value]

    @staticmethod
    def _resource_value_in_scope(value: str, scope: str) -> bool:
        """Return whether a concrete resource value is covered by a granted scope."""

        if scope == "*":
            return True
        if value == scope:
            return True
        normalized_scope = scope.rstrip("/")
        return bool(normalized_scope and value.startswith(f"{normalized_scope}/"))

    def _request_resources_within_grant_scope(
        self,
        request: ToolingExecuteToolRequest,
        grant: ToolingApprovalGrant,
    ) -> bool:
        """Validate request resources against a grant's capability/resource scope."""

        if not grant.resource_scope:
            return True
        requested_values = self._request_resource_values(request)
        if not requested_values:
            return False
        return any(
            any(self._resource_value_in_scope(value, scope) for scope in grant.resource_scope)
            for value in requested_values
        )

    async def _request_db(self, method: str, request: IOModel) -> Any:
        """Send one typed DB request without abandoning SQLite's lock wait."""

        return await self.bus.request(
            method,
            request,
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
            priority=get_system_priority(),
        )

    async def _db_sql(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        result = await self._request_db(
            DBMethods.EXECUTE_SQL,
            DBExecuteSQLRequest(sql=sql, params=params or []),
        )
        if not result.ok:
            raise RuntimeError(result.error or "DB.ExecuteSQL failed")
        data = result.data
        if isinstance(data, dict):
            if data.get("success", True) is False:
                raise RuntimeError(data.get("error") or "DB.ExecuteSQL statement failed")
        elif getattr(data, "success", True) is False:
            raise RuntimeError(getattr(data, "error", None) or "DB.ExecuteSQL statement failed")
        if hasattr(data, "rows"):
            return list(data.rows)
        if isinstance(data, dict):
            return list(data.get("rows") or [])
        return []

    async def _ensure_tooling_policy_tables(self) -> None:
        """Create durable Tooling policy/grant/catalog tables through DB service."""

        if self._tooling_policy_tables_ready:
            return
        statements = [
            """
            CREATE TABLE IF NOT EXISTS tooling_approval_grants (
                grant_id TEXT PRIMARY KEY,
                grant_scope TEXT NOT NULL,
                grant_type TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                principal_id TEXT,
                caller_device_id TEXT,
                caller_peer_id TEXT,
                provider_peer_id TEXT,
                provider_service_instance_id TEXT,
                global_tool_id TEXT,
                local_tool_name TEXT,
                args_hash TEXT,
                resource_selector_hash TEXT,
                route_decision_id TEXT,
                schedule_id TEXT,
                trust_tier TEXT,
                capability_class TEXT,
                resource_scope TEXT,
                include_future_tools INTEGER NOT NULL DEFAULT 0,
                created_by TEXT,
                created_at REAL NOT NULL,
                expires_at REAL,
                revoked_at REAL,
                reason TEXT,
                metadata_json TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS tooling_approval_requests (
                approval_request_id TEXT PRIMARY KEY,
                request_json TEXT NOT NULL,
                prepared_json TEXT NOT NULL,
                expires_at REAL NOT NULL,
                used INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS tooling_approval_tokens (
                token_hash TEXT PRIMARY KEY,
                claims_json TEXT NOT NULL,
                expires_at REAL NOT NULL,
                used INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS tooling_remote_catalog_snapshots (
                peer_id TEXT NOT NULL,
                service_instance_id TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                catalog_epoch INTEGER NOT NULL,
                generated_at TEXT NOT NULL,
                full_schema_hash TEXT NOT NULL,
                tools_json TEXT NOT NULL,
                shared_by_policy INTEGER NOT NULL DEFAULT 1,
                stale INTEGER NOT NULL DEFAULT 0,
                removed_at REAL,
                updated_at REAL NOT NULL,
                PRIMARY KEY(peer_id, service_instance_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS tooling_remote_catalog_tombstones (
                global_tool_id TEXT PRIMARY KEY,
                peer_id TEXT NOT NULL,
                service_instance_id TEXT,
                reason TEXT,
                removed_at REAL NOT NULL
            )
            """,
            """
            CREATE TRIGGER IF NOT EXISTS tooling_remote_catalog_review_grants_v2
            AFTER UPDATE OF full_schema_hash, shared_by_policy
            ON tooling_remote_catalog_snapshots
            WHEN OLD.full_schema_hash IS NOT NEW.full_schema_hash
              OR (OLD.shared_by_policy = 1 AND NEW.shared_by_policy = 0)
            BEGIN
                INSERT INTO tooling_remote_catalog_tombstones (
                    global_tool_id, peer_id, service_instance_id, reason, removed_at
                )
                SELECT
                    json_extract(old_tool.value, '$.global_tool_id'),
                    NEW.peer_id,
                    NEW.service_instance_id,
                    'remote_catalog_tool_removed',
                    NEW.updated_at
                FROM json_each(OLD.tools_json) AS old_tool
                WHERE json_extract(old_tool.value, '$.global_tool_id') IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM json_each(NEW.tools_json) AS new_tool
                      WHERE json_extract(new_tool.value, '$.global_tool_id') =
                            json_extract(old_tool.value, '$.global_tool_id')
                  )
                ON CONFLICT(global_tool_id) DO UPDATE SET
                    peer_id = excluded.peer_id,
                    service_instance_id = excluded.service_instance_id,
                    reason = excluded.reason,
                    removed_at = excluded.removed_at;

                UPDATE tooling_approval_grants
                SET metadata_json = json_set(
                    CASE
                        WHEN json_valid(metadata_json) THEN metadata_json
                        ELSE '{}'
                    END,
                    '$.needs_review', json('true'),
                    '$.stale_reason', CASE
                        WHEN OLD.shared_by_policy = 1 AND NEW.shared_by_policy = 0
                            THEN 'remote_catalog_unshared_by_policy'
                        WHEN EXISTS (
                            SELECT 1
                            FROM json_each(OLD.tools_json) AS old_tool
                            WHERE NOT EXISTS (
                                SELECT 1
                                FROM json_each(NEW.tools_json) AS new_tool
                                WHERE json_extract(new_tool.value, '$.global_tool_id') =
                                      json_extract(old_tool.value, '$.global_tool_id')
                            )
                        ) THEN 'remote_catalog_tool_removed'
                        ELSE 'remote_catalog_schema_changed'
                    END,
                    '$.stale_at', NEW.updated_at
                )
                WHERE active = 1
                  AND revoked_at IS NULL
                  AND provider_peer_id = NEW.peer_id
                  AND provider_service_instance_id = NEW.service_instance_id;
            END
            """,
            "DROP TRIGGER IF EXISTS tooling_remote_catalog_review_grants_v1",
        ]
        try:
            for statement in statements:
                await self._db_sql(statement)
            self._tooling_policy_tables_ready = True
        except Exception as error:
            log_warning(f"Tooling durable policy tables unavailable: {error}")

    async def _load_remote_catalog_snapshots(self) -> list[ToolingRemoteCatalogAnnounced]:
        await self._ensure_tooling_policy_tables()
        await self._refresh_peer_display_names()
        await self._prune_legacy_signaling_catalog_snapshots()
        snapshots = [snapshot for snapshot, _ in self._remote_catalog_snapshots.values()]
        if not self._tooling_policy_tables_ready:
            return snapshots

        try:
            rows = await self._db_sql(
                """
                SELECT * FROM tooling_remote_catalog_snapshots
                WHERE stale = 0 AND removed_at IS NULL
                ORDER BY peer_id, service_instance_id
                """
            )
            loaded = []
            for row in rows:
                loaded_tools = [
                    ToolingToolInfo.model_validate(tool) for tool in json.loads(row["tools_json"])
                ]
                snapshot = self._normalize_remote_catalog_snapshot(
                    ToolingRemoteCatalogAnnounced(
                        peer_id=row["peer_id"],
                        service_instance_id=row["service_instance_id"],
                        provider_id=row["provider_id"],
                        catalog_epoch=int(row["catalog_epoch"]),
                        generated_at=row["generated_at"],
                        full_schema_hash=row["full_schema_hash"],
                        tools=loaded_tools,
                        shared_by_policy=bool(row["shared_by_policy"]),
                        # Recipient grants are authenticated session state. Old
                        # rows may contain them, but a restart must never
                        # restore authority from the durable tool registry.
                        granted_permissions=None,
                        # Availability is deliberately not restored from DB.
                        # A fresh authenticated manifest must repopulate the
                        # volatile provider-state map after every restart.
                        provider_available=None,
                    )
                )
                self._remote_catalog_snapshots[(snapshot.peer_id, snapshot.service_instance_id)] = (
                    snapshot,
                    float(row.get("updated_at") or time.time()),
                )
                loaded.append(snapshot)
            return loaded
        except Exception as error:
            log_warning(f"Failed to load remote Tooling catalog cache: {error}")
            return snapshots

    def _bind_normalized_remote_tool(
        self,
        tool: ToolingToolInfo,
        *,
        peer_id: str,
        service_instance_id: str,
    ) -> ToolingToolInfo:
        """Translate stored provider-local metadata into a remote consumer view."""

        provider_label = self._peer_display_name(peer_id)
        namespace = self._safe_identifier(provider_label)
        local_name = tool.local_name or tool.name
        return tool.model_copy(
            update={
                "name": self._namespaced_tool_name(namespace, local_name),
                "local_name": local_name,
                "provider_peer_id": peer_id,
                "provider_service_instance_id": service_instance_id,
                "provider_label": provider_label,
                "provider_granted_permissions": None,
                "provider_available": None,
                "namespace": namespace,
                "display_name": f"{provider_label}.{local_name}",
                "source_type": "mesh_peer",
                "source": "mesh_peer",
                "source_id": (f"mesh:{peer_id}:{self._safe_identifier(service_instance_id)}"),
                "execution_location": "remote",
                # A received tool is callable through its provider but must
                # never be re-exported as if it were local authority.
                "exportable": False,
                "provenance": tool.provenance.model_copy(
                    update={
                        "provider_peer_id": peer_id,
                        "provider_service_instance_id": service_instance_id,
                        "provider_kind": "mesh_peer",
                        "advertised_name": local_name,
                    }
                ),
            }
        )

    async def _load_normalized_bindable_remote_catalogs(
        self,
    ) -> list[ToolingRemoteCatalogAnnounced]:
        """Load only checksum-committed active projection rows for assistant binding."""

        if not self._mesh_projection_enforcement_active or self._normalized_catalog_recovery_failed:
            return []
        policy = await self._tool_export_snapshot(include_rules=False)
        if not policy.mesh_switches.consumer_mesh_tooling_enabled:
            return []
        result = await self.bus.request(
            DBMethods.GET_TOOLING_REMOTE_CATALOG,
            DBGetToolingRemoteCatalogRequest(include_inactive=False),
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
        )
        if not result.ok or result.data is None:
            return []
        data = (
            result.data.model_dump(mode="python")
            if hasattr(result.data, "model_dump")
            else result.data
        )
        headers = data.get("headers", []) if isinstance(data, dict) else []
        rows = data.get("tools", []) if isinstance(data, dict) else []
        active_headers: dict[tuple[str, str], Any] = {}
        for raw in headers:
            header = raw.model_dump(mode="python") if hasattr(raw, "model_dump") else raw
            if not isinstance(header, dict):
                continue
            if (
                header.get("availability") != "active"
                or header.get("sync_state") != "committed"
                or header.get("protocol_tier") != "projection_v1"
                or int(header.get("current_generation", 0)) < 1
                or str(header.get("peer_id") or "") in self._policy_reconciliation_inflight
            ):
                continue
            active_headers[(str(header["peer_id"]), str(header["provider_id"]))] = header
        tools_by_header: dict[tuple[str, str], list[ToolingToolInfo]] = {
            key: [] for key in active_headers
        }
        for raw in rows:
            row = raw.model_dump(mode="python") if hasattr(raw, "model_dump") else raw
            if not isinstance(row, dict):
                continue
            key = (str(row.get("peer_id") or ""), str(row.get("provider_id") or ""))
            header = active_headers.get(key)
            if header is None or row.get("availability") != "active":
                continue
            if int(row.get("active_generation") or 0) != int(header["current_generation"]):
                continue
            tools_by_header[key].append(
                self._bind_normalized_remote_tool(
                    ToolingToolInfo.model_validate(row["tool"]),
                    peer_id=key[0],
                    service_instance_id=str(header["service_instance_id"]),
                )
            )
        return [
            ToolingRemoteCatalogAnnounced(
                peer_id=peer_id,
                provider_id=provider_id,
                service_instance_id=str(header["service_instance_id"]),
                catalog_epoch=int(header["current_generation"]),
                generated_at=datetime.now(UTC).isoformat(),
                tools=sorted(
                    tools_by_header[(peer_id, provider_id)],
                    key=lambda item: item.global_tool_id,
                ),
                full_schema_hash=str(header.get("projection_digest") or ""),
                shared_by_policy=True,
                supported_protocol_tiers=["projection_v1"],
                selected_protocol_tier="projection_v1",
                export_policy_revision=int(
                    (header.get("authority_revision") or {}).get("export_policy_revision", 0)
                ),
            )
            for (peer_id, provider_id), header in sorted(active_headers.items())
        ]

    async def _load_normalized_management_catalog(
        self,
    ) -> tuple[dict[tuple[str, str], dict[str, Any]], list[ToolingRetainedRemoteTool]]:
        """Load retained projection history for Tooling.manage surfaces only."""

        if not self._mesh_projection_enforcement_active or self._normalized_catalog_recovery_failed:
            return {}, []
        await self._refresh_peer_display_names()
        result = await self.bus.request(
            DBMethods.GET_TOOLING_REMOTE_CATALOG,
            DBGetToolingRemoteCatalogRequest(include_inactive=True),
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
        )
        if not result.ok or result.data is None:
            return {}, []
        data = (
            result.data.model_dump(mode="python")
            if hasattr(result.data, "model_dump")
            else result.data
        )
        if not isinstance(data, dict):
            return {}, []
        headers: dict[tuple[str, str], dict[str, Any]] = {}
        for raw in data.get("headers", []):
            header = raw.model_dump(mode="python") if hasattr(raw, "model_dump") else raw
            if not isinstance(header, dict):
                continue
            key = (str(header.get("peer_id") or ""), str(header.get("provider_id") or ""))
            if all(key):
                headers[key] = header

        retained: list[ToolingRetainedRemoteTool] = []
        for raw in data.get("tools", []):
            row = raw.model_dump(mode="python") if hasattr(raw, "model_dump") else raw
            if not isinstance(row, dict):
                continue
            key = (str(row.get("peer_id") or ""), str(row.get("provider_id") or ""))
            header = headers.get(key)
            if header is None or not isinstance(row.get("tool"), (dict, ToolingToolInfo)):
                continue
            peer_id, provider_id = key
            service_instance_id = str(header.get("service_instance_id") or "remote:Tooling")
            provider_label = self._peer_display_name(peer_id)
            tool = ToolingToolInfo.model_validate(row["tool"])
            local_name = tool.local_name or tool.name
            source_id = f"mesh:{peer_id}:{self._safe_identifier(service_instance_id)}"
            tool = self._bind_normalized_remote_tool(
                tool,
                peer_id=peer_id,
                service_instance_id=service_instance_id,
            )
            retained_availability = str(row.get("availability") or "stale")
            header_availability = str(header.get("availability") or "stale")
            effective_availability = (
                retained_availability
                if header_availability == "active" and header.get("sync_state") == "committed"
                else header_availability
            )
            retained.append(
                ToolingRetainedRemoteTool(
                    peer_id=peer_id,
                    provider_id=provider_id,
                    provider_label=provider_label,
                    service_instance_id=service_instance_id,
                    source_id=source_id,
                    global_tool_id=tool.global_tool_id,
                    local_tool_name=local_name,
                    display_name=tool.display_name,
                    source=tool.provenance.source,
                    retained_source_id=tool.source_id,
                    share_group_id=tool.share_group_id or None,
                    share_group_label=tool.share_group_label or None,
                    provider_tool_id=tool.provenance.provider_tool_id,
                    retained_availability=retained_availability,
                    effective_availability=effective_availability,
                    reason_code=str(row.get("reason_code") or retained_availability),
                    missing_permissions=sorted(
                        {str(permission) for permission in (row.get("missing_permissions") or [])}
                    ),
                    provider_reason_code=header.get("last_error_reason"),
                    schema_hash=str(row.get("schema_hash") or ""),
                    accepted_schema_hash=str(row.get("accepted_schema_hash") or ""),
                    review_required=bool(row.get("review_required")),
                    projection_revision=row.get("projection_revision"),
                    current_generation=int(header.get("current_generation") or 0),
                    active_generation=row.get("active_generation"),
                    first_seen_at=float(row.get("first_seen_at") or 0.0),
                    last_seen_at=float(row.get("last_seen_at") or 0.0),
                    updated_at=float(row.get("updated_at") or 0.0),
                    tool=tool,
                )
            )
        for raw in data.get("retained_tombstones", []):
            tombstone = raw.model_dump(mode="python") if hasattr(raw, "model_dump") else raw
            if not isinstance(tombstone, dict):
                continue
            key = (
                str(tombstone.get("peer_id") or ""),
                str(tombstone.get("provider_id") or ""),
            )
            header = headers.get(key)
            if header is None:
                continue
            peer_id, provider_id = key
            metadata = tombstone.get("management_metadata") or {}
            if not isinstance(metadata, dict):
                metadata = {}
            service_instance_id = str(header.get("service_instance_id") or "remote:Tooling")
            provider_label = self._peer_display_name(peer_id)
            source_id = f"mesh:{peer_id}:{self._safe_identifier(service_instance_id)}"
            local_name = str(metadata.get("local_name") or "retained tool")
            display_name = str(metadata.get("display_name") or f"{provider_label}.{local_name}")
            source = str(metadata.get("source") or "unknown")
            if source not in {"core", "plugin", "mcp", "mesh_peer", "unknown"}:
                source = "unknown"
            availability = str(tombstone.get("availability") or "stale")
            accepted_schema_hash = str(tombstone.get("accepted_schema_hash") or "")
            compacted_at = float(tombstone.get("compacted_at") or 0.0)
            retained.append(
                ToolingRetainedRemoteTool(
                    peer_id=peer_id,
                    provider_id=provider_id,
                    provider_label=provider_label,
                    service_instance_id=service_instance_id,
                    source_id=source_id,
                    global_tool_id=str(tombstone.get("global_tool_id") or ""),
                    local_tool_name=local_name,
                    display_name=display_name,
                    source=source,
                    retained_source_id=(
                        str(metadata["source_id"]) if metadata.get("source_id") else None
                    ),
                    share_group_id=(
                        str(metadata["share_group_id"]) if metadata.get("share_group_id") else None
                    ),
                    share_group_label=(
                        str(metadata["share_group_label"])
                        if metadata.get("share_group_label")
                        else None
                    ),
                    provider_tool_id=(
                        str(metadata["provider_tool_id"])
                        if metadata.get("provider_tool_id")
                        else None
                    ),
                    retained_availability=availability,
                    effective_availability=(
                        availability
                        if header.get("availability") == "active"
                        else str(header.get("availability") or "stale")
                    ),
                    reason_code=str(tombstone.get("reason_code") or availability),
                    provider_reason_code=header.get("last_error_reason"),
                    schema_hash=accepted_schema_hash,
                    accepted_schema_hash=accepted_schema_hash,
                    review_required=False,
                    projection_revision=header.get("projection_revision"),
                    current_generation=int(header.get("current_generation") or 0),
                    active_generation=None,
                    first_seen_at=compacted_at,
                    last_seen_at=compacted_at,
                    updated_at=compacted_at,
                    compacted_at=compacted_at,
                    tool=None,
                )
            )
        retained.sort(key=lambda item: (item.source_id, item.global_tool_id))
        return headers, retained

    @staticmethod
    def _is_legacy_signaling_peer_id(peer_id: str) -> bool:
        """Return whether an old catalog key is an ephemeral UUID4 session id."""

        try:
            parsed = uuid.UUID(peer_id)
        except (AttributeError, TypeError, ValueError):
            return False
        return parsed.version == 4 and str(parsed) == peer_id.lower()

    async def _prune_legacy_signaling_catalog_snapshots(self) -> None:
        """Retire catalog rows that were incorrectly keyed by WebRTC sessions.

        Stable mesh identities are persisted in ``mesh_peers``. Older builds
        rebound forwarded Tooling announcements to a UUID4 signaling session,
        so every application restart created another durable provider row.
        """

        if self._legacy_remote_catalog_cleanup_done or not self._tooling_policy_tables_ready:
            return
        try:
            stable_rows = await self._db_sql("SELECT DISTINCT peer_id FROM mesh_peers")
            active_rows = await self._db_sql(
                """
                SELECT DISTINCT peer_id FROM tooling_remote_catalog_snapshots
                WHERE stale = 0 AND removed_at IS NULL
                """
            )
        except Exception as error:
            log_debug(f"Deferred legacy Tooling catalog cleanup: {error}")
            return

        stable_peer_ids = {str(row.get("peer_id") or "") for row in stable_rows}
        legacy_peer_ids = sorted(
            {
                str(row.get("peer_id") or "")
                for row in active_rows
                if str(row.get("peer_id") or "") not in stable_peer_ids
                and self._is_legacy_signaling_peer_id(str(row.get("peer_id") or ""))
            }
        )
        now = time.time()
        for peer_id in legacy_peer_ids:
            await self._db_sql(
                """
                UPDATE tooling_remote_catalog_snapshots
                SET stale = 1, removed_at = ?, updated_at = ?
                WHERE peer_id = ? AND stale = 0 AND removed_at IS NULL
                """,
                [now, now, peer_id],
            )
            for key in [key for key in self._remote_catalog_snapshots if key[0] == peer_id]:
                self._remote_catalog_snapshots.pop(key, None)
        self._legacy_remote_catalog_cleanup_done = True
        if legacy_peer_ids:
            log_info(
                "Retired legacy Tooling catalogs keyed by ephemeral signaling sessions "
                f"(count={len(legacy_peer_ids)})"
            )

    @staticmethod
    def _canonical_remote_catalog_hash(tools: list[ToolingToolInfo]) -> str:
        """Hash locally normalized, policy-relevant remote tool metadata.

        A provider's announced hash is not authoritative: it can be stale or
        intentionally reused after changing a tool.  Presentation labels and
        negotiated session authority are excluded because they do not change
        the tool contract and must not invalidate durable approval policy.
        """

        non_contract_fields = {
            "aliases",
            "display_name",
            "name",
            "namespace",
            "provider_available",
            "provider_granted_permissions",
            "provider_label",
        }
        tools_payload = [
            tool.model_dump(mode="json", exclude=non_contract_fields) for tool in tools
        ]
        tools_payload.sort(
            key=lambda tool: (
                str(tool.get("global_tool_id") or ""),
                str(tool.get("local_name") or ""),
            )
        )
        return hashlib.sha256(
            json.dumps(tools_payload, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()

    def _normalize_remote_catalog_snapshot(
        self, snapshot: ToolingRemoteCatalogAnnounced
    ) -> ToolingRemoteCatalogAnnounced:
        """Normalize a remote peer catalog before local persistence.

        Remote providers announce tools from their own local perspective. The
        receiving node owns the negotiated cache keys and must treat every
        remote child tool as mesh-sourced/untrusted until local grants say
        otherwise.
        """

        peer_id = snapshot.peer_id
        service_instance_id = snapshot.service_instance_id
        provider_label = self._peer_display_name(peer_id)
        namespace = self._safe_identifier(provider_label)
        source_id = f"mesh:{peer_id}:{self._safe_identifier(service_instance_id)}"
        normalized_tools: list[ToolingToolInfo] = []
        for tool in snapshot.tools:
            local_name = tool.local_name or tool.name
            announced_global_id = tool.global_tool_id
            canonical_global_id: str | None = None
            if tool.tool_id_scheme == "aurora-tool" or announced_global_id.startswith(
                "aurora-tool:"
            ):
                try:
                    embedded_peer_id, embedded_contract_id = parse_canonical_tool_global_id(
                        announced_global_id
                    )
                except ToolIdentityError as error:
                    raise ValueError(
                        "remote Tooling catalog has invalid canonical identity"
                    ) from error
                if embedded_peer_id != peer_id:
                    raise ValueError(
                        "remote Tooling canonical identity does not match authenticated peer"
                    )
                if tool.tool_contract_id and tool.tool_contract_id != embedded_contract_id:
                    raise ValueError("remote Tooling contract ID does not match canonical identity")
                canonical_global_id = announced_global_id
            elif tool.tool_contract_id:
                canonical_global_id = canonical_tool_global_id(peer_id, tool.tool_contract_id)

            global_tool_id = canonical_global_id or self._global_tool_id(
                peer_id, service_instance_id, local_name
            )
            legacy_ids = list(tool.legacy_global_tool_ids)
            if announced_global_id and announced_global_id != global_tool_id:
                legacy_ids.append(announced_global_id)
            legacy_ids.append(self._global_tool_id(peer_id, service_instance_id, local_name))
            legacy_ids = list(normalize_legacy_aliases(legacy_ids, canonical_id=global_tool_id))
            bindable_name = self._namespaced_tool_name(namespace, local_name)
            provenance = tool.provenance.model_copy(
                update={
                    "provider_peer_id": peer_id,
                    "provider_service_instance_id": service_instance_id,
                    "provider_kind": "mesh_peer",
                    "source": (
                        tool.provenance.source
                        if tool.provenance.source in {"core", "plugin", "mcp", "unknown"}
                        else "unknown"
                    ),
                    "advertised_name": local_name,
                }
            )
            normalized_tools.append(
                tool.model_copy(
                    update={
                        "name": bindable_name,
                        "local_name": local_name,
                        "global_tool_id": global_tool_id,
                        "tool_id_scheme": ("aurora-tool" if canonical_global_id else "legacy"),
                        "tool_id_version": 1 if canonical_global_id else 0,
                        "tool_contract_id": (
                            tool.tool_contract_id
                            or (
                                parse_canonical_tool_global_id(canonical_global_id)[1]
                                if canonical_global_id
                                else ""
                            )
                        ),
                        "legacy_global_tool_ids": legacy_ids,
                        "exportable": False,
                        "provider_peer_id": peer_id,
                        "provider_service_instance_id": service_instance_id,
                        "provider_label": provider_label,
                        # Grants and liveness are never part of the durable
                        # tool registry. Both come from the authenticated live
                        # provider-state map or current registry manifest.
                        "provider_granted_permissions": None,
                        "provider_available": None,
                        "namespace": namespace,
                        "display_name": f"{provider_label}.{local_name}",
                        "aliases": [local_name] if bindable_name != local_name else [],
                        "source_type": "mesh_peer",
                        "source": "mesh_peer",
                        "source_id": source_id,
                        "trust_tier": "untrusted",
                        "execution_location": "remote",
                        "provenance": provenance,
                    }
                )
            )

        schema_hash = self._canonical_remote_catalog_hash(normalized_tools)
        return snapshot.model_copy(
            update={
                "provider_id": peer_id,
                "tools": normalized_tools,
                # The receiver owns this security boundary. Never let a peer
                # reuse an announced hash to hide a changed tool contract.
                "full_schema_hash": schema_hash,
            }
        )

    async def _reconcile_remote_catalog_identities(
        self, snapshot: ToolingRemoteCatalogAnnounced
    ) -> ToolingRemoteCatalogAnnounced:
        """Persist canonical/legacy remote identities under the authenticated peer."""

        reconciled_tools: list[ToolingToolInfo] = []
        legacy_locators: set[str] = set()
        for tool in snapshot.tools:
            source_id = self._safe_identifier(
                str(tool.provenance.stable_source_id or tool.tool_contract_id or "legacy")
            )[:160]
            group_id = (tool.share_group_id or f"mesh:{snapshot.peer_id}:legacy")[:160]
            group_label = (tool.share_group_label or "Peer tools")[:120]
            aliases = list(
                normalize_legacy_aliases(
                    list(tool.legacy_global_tool_ids), canonical_id=tool.global_tool_id
                )
            )
            if (
                tool.tool_id_scheme == "aurora-tool"
                and tool.tool_contract_id
                and not tool.tool_contract_id.startswith("legacy.")
            ):
                result = await self.bus.request(
                    DBMethods.RECONCILE_TOOL_IDENTITY,
                    DBReconcileToolIdentityRequest(
                        canonical_global_tool_id=tool.global_tool_id,
                        stable_peer_id=snapshot.peer_id,
                        tool_contract_id=tool.tool_contract_id,
                        source_kind="mesh_peer",
                        stable_source_id=source_id,
                        provider_tool_id=(
                            tool.provenance.provider_tool_id or tool.tool_contract_id
                        )[:160],
                        share_group_id=group_id,
                        share_group_label=group_label,
                        current_local_name=tool.local_name,
                        legacy_global_tool_ids=aliases,
                    ),
                    origin="internal",
                    timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
                    priority=get_system_priority(),
                )
                data = result.data
                success = (
                    data.get("success")
                    if isinstance(data, dict)
                    else getattr(data, "success", False)
                )
                if not result.ok or not success:
                    raise RuntimeError(
                        result.error or "remote Tooling identity reconciliation failed closed"
                    )
                reconciled_tools.append(tool)
                continue

            alias_result = await self.bus.request(
                DBMethods.RESOLVE_TOOL_IDENTITY_ALIASES,
                DBResolveToolIdentityAliasesRequest(
                    global_tool_ids=list(dict.fromkeys([tool.global_tool_id, *aliases])),
                    stable_peer_id=snapshot.peer_id,
                ),
                origin="internal",
                timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
                priority=get_system_priority(),
            )
            alias_data = alias_result.data
            alias_map = (
                alias_data.get("resolved")
                if isinstance(alias_data, dict)
                else getattr(alias_data, "resolved", {})
            )
            resolved_ids = set(alias_map.values()) if isinstance(alias_map, dict) else set()
            if alias_result.ok and len(resolved_ids) == 1:
                canonical_id = next(iter(resolved_ids))
                embedded_peer, contract_id = parse_canonical_tool_global_id(canonical_id)
                if embedded_peer != snapshot.peer_id:
                    raise RuntimeError("durable remote alias resolved across peer boundary")
                reconciled_tools.append(
                    tool.model_copy(
                        update={
                            "global_tool_id": canonical_id,
                            "tool_id_scheme": "aurora-tool",
                            "tool_id_version": 1,
                            "tool_contract_id": contract_id,
                            "share_group_id": group_id,
                            "share_group_label": group_label,
                            "legacy_global_tool_ids": list(
                                normalize_legacy_aliases(
                                    [tool.global_tool_id, *aliases], canonical_id=canonical_id
                                )
                            ),
                            "exportable": False,
                        }
                    )
                )
                continue
            if alias_result.ok and len(resolved_ids) > 1:
                raise RuntimeError("remote legacy aliases resolve to conflicting identities")

            locator, _ = self._legacy_identity_coordinates(
                tool,
                stable_peer_id=snapshot.peer_id,
                source_kind="mesh_peer",
                stable_source_id=source_id,
            )
            if locator in legacy_locators:
                raise RuntimeError(
                    "remote legacy catalog contains indistinguishable name-only tool contracts"
                )
            legacy_locators.add(locator)
            identity = await self._allocate_legacy_identity(
                tool,
                stable_peer_id=snapshot.peer_id,
                local_name=tool.local_name,
                source_kind="mesh_peer",
                stable_source_id=source_id,
                share_group_id=group_id,
                share_group_label=group_label,
                legacy_global_tool_ids=[tool.global_tool_id, *aliases],
            )
            canonical_id = canonical_tool_global_id(snapshot.peer_id, identity.tool_contract_id)
            reconciled_tools.append(
                tool.model_copy(
                    update={
                        "global_tool_id": canonical_id,
                        "tool_id_scheme": "aurora-tool",
                        "tool_id_version": 1,
                        "tool_contract_id": identity.tool_contract_id,
                        "share_group_id": identity.share_group_id,
                        "share_group_label": identity.share_group_label,
                        "legacy_global_tool_ids": list(
                            normalize_legacy_aliases(
                                [tool.global_tool_id, *aliases], canonical_id=canonical_id
                            )
                        ),
                        "exportable": False,
                    }
                )
            )
        return snapshot.model_copy(
            update={
                "tools": reconciled_tools,
                "full_schema_hash": self._canonical_remote_catalog_hash(reconciled_tools),
            }
        )

    async def _persist_remote_catalog_snapshot(
        self, snapshot: ToolingRemoteCatalogAnnounced
    ) -> None:
        await self._refresh_peer_display_names(force=True)
        key = (snapshot.peer_id, snapshot.service_instance_id)
        snapshot = snapshot.model_copy(
            update={
                # Never merge session authority into a durable snapshot.
                # Live grants and availability are tracked only in
                # ``_remote_provider_states``.
                "granted_permissions": None,
                "provider_available": None,
            }
        )
        snapshot = self._normalize_remote_catalog_snapshot(snapshot)
        snapshot = await self._reconcile_remote_catalog_identities(snapshot)
        await self._migrate_policy_rule_tool_ids()
        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            raise RuntimeError("Tooling durable policy tables unavailable")
        updated_at = time.time()
        tools_json = json.dumps([tool.model_dump(mode="json") for tool in snapshot.tools])
        await self._db_sql(
            """
            INSERT INTO tooling_remote_catalog_snapshots (
                peer_id, service_instance_id, provider_id, catalog_epoch, generated_at,
                full_schema_hash, tools_json, shared_by_policy, stale, removed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
            ON CONFLICT(peer_id, service_instance_id) DO UPDATE SET
                provider_id = excluded.provider_id,
                catalog_epoch = excluded.catalog_epoch,
                generated_at = excluded.generated_at,
                full_schema_hash = excluded.full_schema_hash,
                tools_json = excluded.tools_json,
                shared_by_policy = excluded.shared_by_policy,
                stale = 0,
                removed_at = NULL,
                updated_at = excluded.updated_at
            """,
            [
                snapshot.peer_id,
                snapshot.service_instance_id,
                snapshot.provider_id,
                snapshot.catalog_epoch,
                snapshot.generated_at,
                snapshot.full_schema_hash,
                tools_json,
                int(snapshot.shared_by_policy),
                updated_at,
            ],
        )
        durable_rows = await self._db_sql(
            """
            SELECT provider_id, catalog_epoch, generated_at, full_schema_hash, tools_json,
                   shared_by_policy, stale, removed_at, updated_at
            FROM tooling_remote_catalog_snapshots
            WHERE peer_id = ? AND service_instance_id = ?
            """,
            [snapshot.peer_id, snapshot.service_instance_id],
        )
        if len(durable_rows) != 1:
            raise RuntimeError("Remote Tooling catalog snapshot was not durably stored")
        durable = durable_rows[0]
        expected = {
            "provider_id": snapshot.provider_id,
            "catalog_epoch": snapshot.catalog_epoch,
            "generated_at": snapshot.generated_at,
            "full_schema_hash": snapshot.full_schema_hash,
            "tools_json": tools_json,
            "shared_by_policy": int(snapshot.shared_by_policy),
            "stale": 0,
            "removed_at": None,
            "updated_at": updated_at,
        }
        if any(durable.get(field) != value for field, value in expected.items()):
            raise RuntimeError("Remote Tooling catalog snapshot durability check failed")
        # In-memory state must never advance ahead of the catalog/grant
        # transaction. A failed trigger rolls back the UPSERT, and this write
        # occurs only after the durable read-back proves the commit.
        self._remote_catalog_snapshots[key] = (snapshot, updated_at)

    def _current_known_global_tool_ids(
        self, provider_peer_id: str | None, service_instance_id: str | None
    ) -> list[str]:
        """Return current reviewed global tool IDs for snapshot-scoped broad grants."""

        provider_peer_id = provider_peer_id or "local"
        service_instance_id = service_instance_id or (
            "local:Tooling" if self._is_local_provider(provider_peer_id) else None
        )
        if self._is_local_provider(provider_peer_id):
            request = ToolingGetToolsRequest(top_k=10_000)
            return sorted(
                self._serialize_tool(tool, request).global_tool_id
                for tool in self.tools_manager.get_tools(query=None, top_k=10_000)
            )
        ids: list[str] = []
        for (peer_id, snapshot_service_id), (snapshot, _) in self._remote_catalog_snapshots.items():
            if peer_id != provider_peer_id:
                continue
            if service_instance_id and snapshot_service_id != service_instance_id:
                continue
            if not snapshot.shared_by_policy:
                continue
            ids.extend(tool.global_tool_id for tool in snapshot.tools)
        return sorted(set(ids))

    def _current_known_global_tool_ids_for_source(self, source_id: str) -> list[str]:
        """Return reviewed tool IDs constrained to one management source."""

        if source_id.startswith("mesh:"):
            ids: list[str] = []
            for _, (snapshot, _) in self._remote_catalog_snapshots.items():
                if not snapshot.shared_by_policy:
                    continue
                ids.extend(
                    tool.global_tool_id
                    for tool in snapshot.tools
                    if self._source_id_for_tool(tool) == source_id
                )
            return sorted(set(ids))

        request = ToolingGetToolsRequest(top_k=10000)
        ids = []
        for tool in self.tools_manager.get_tools(query=None, top_k=10000):
            info = self._serialize_tool(tool, request)
            if self._source_id_for_tool(info) == source_id:
                ids.append(info.global_tool_id)
        return sorted(set(ids))

    def _remote_catalog_shared_by_policy(
        self, provider_peer_id: str | None, service_instance_id: str | None
    ) -> bool:
        """Return whether the current negotiated remote catalog is still shared.

        Local providers are always in-process. Remote grants must not continue to
        authorize when the negotiated Tooling catalog has been explicitly
        unshared by policy, even if an older durable grant still exists.
        """

        provider_peer_id = provider_peer_id or "local"
        if self._is_local_provider(provider_peer_id):
            return True
        for (peer_id, snapshot_service_id), (snapshot, _) in self._remote_catalog_snapshots.items():
            if peer_id != provider_peer_id:
                continue
            if service_instance_id and snapshot_service_id != service_instance_id:
                continue
            if not snapshot.shared_by_policy:
                return False
        return True

    async def _expire_approval_grants(self, *, now: float | None = None) -> None:
        """Mark expired durable approval grants inactive before management/list reads."""

        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            return
        now = now or time.time()
        rows = await self._db_sql(
            """
            SELECT grant_id, metadata_json, principal_id, expires_at
            FROM tooling_approval_grants
            WHERE active = 1
              AND revoked_at IS NULL
              AND expires_at IS NOT NULL
              AND expires_at <= ?
            """,
            [now],
        )
        for row in rows:
            metadata_raw = row.get("metadata_json") or "{}"
            try:
                metadata = json.loads(metadata_raw)
            except Exception:
                metadata = {}
            metadata.update({"expired": True, "expired_at": now})
            await self._db_sql(
                """
                UPDATE tooling_approval_grants
                SET active = 0, revoked_at = ?, metadata_json = ?
                WHERE grant_id = ?
                """,
                [now, json.dumps(metadata, sort_keys=True, default=str), row["grant_id"]],
            )
            await self._audit_tooling_event(
                "tooling.approval.grant_expired",
                principal_id=row.get("principal_id"),
                details={
                    "grant_id": row["grant_id"],
                    "expires_at": row.get("expires_at"),
                    "expired_at": now,
                },
            )

    async def _mark_remote_catalog_dependents_stale(
        self,
        *,
        peer_id: str,
        service_instance_id: str | None,
        reason: str,
        global_tool_ids: list[str] | None = None,
    ) -> None:
        """Mark grants tied to a changed/removed remote catalog as needing review."""

        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            return
        selector_clause = ""
        params: list[Any] = [peer_id]
        if service_instance_id:
            selector_clause += " AND provider_service_instance_id = ?"
            params.append(service_instance_id)
        if global_tool_ids:
            placeholders = ", ".join("?" for _ in global_tool_ids)
            selector_clause += (
                f" AND (global_tool_id IS NULL OR global_tool_id IN ({placeholders}))"
            )
            params.extend(global_tool_ids)

        rows = await self._db_sql(
            f"""
            SELECT grant_id, metadata_json
            FROM tooling_approval_grants
            WHERE active = 1
              AND revoked_at IS NULL
              AND provider_peer_id = ?
              {selector_clause}
            """,
            params,
        )
        stale_at = time.time()
        for row in rows:
            metadata_raw = row.get("metadata_json") or "{}"
            try:
                metadata = json.loads(metadata_raw)
            except Exception:
                metadata = {}
            metadata.update(
                {
                    "needs_review": True,
                    "stale_reason": reason,
                    "stale_at": stale_at,
                }
            )
            await self._db_sql(
                """
                UPDATE tooling_approval_grants
                SET metadata_json = ?
                WHERE grant_id = ?
                """,
                [json.dumps(metadata, sort_keys=True, default=str), row["grant_id"]],
            )

    async def _announce_local_tool_catalog(
        self, *, reason: str, affected_peer_ids: list[str] | None = None
    ) -> None:
        """Publish only a local metadata-free hint; Gateway targets recipients."""

        if not self._stable_peer_id:
            return
        snapshot = await self._tool_export_snapshot(include_rules=False)
        catalog_material = self._export_catalog_material(self._provider_visible_export_tools())
        await self.bus.publish(
            ToolingMethods.PROJECTION_INVALIDATED,
            ToolingProjectionInvalidated(
                provider_peer_id=self._stable_peer_id,
                service_instance_id="local:Tooling",
                authority_revision=ToolingProjectionAuthorityRevision(
                    catalog_revision=_derive_js_safe_catalog_revision(catalog_material),
                    export_policy_revision=snapshot.policy.revision,
                    auth_grant_revision=0,
                    manifest_revision=0,
                    switch_revision=snapshot.mesh_switches.revision,
                ),
                reason_code=reason,
                correlation_id=str(uuid.uuid4()),
                affected_peer_ids=affected_peer_ids,
            ),
            event=True,
            mesh=False,
            priority=get_system_priority(),
            origin="internal",
        )

    @method_contract(
        method_id=ToolingMethods.PROJECTION_SYNC_REQUESTED,
        summary="Synchronize one authenticated remote Tooling projection",
        input_model=ToolingProjectionSyncRequested,
        output_model=EmptyOutput,
        exposure="internal",
    )
    async def _on_projection_sync_requested(
        self, request: ToolingProjectionSyncRequested
    ) -> EmptyOutput:
        """Fetch all pages through Gateway and publish only after DB commit."""

        started_at = time.monotonic()
        current_task = asyncio.current_task()
        existing_task = self._projection_sync_tasks.get(request.provider_peer_id)
        if (
            existing_task is not None
            and existing_task is not current_task
            and not existing_task.done()
        ):
            # Latest-wins coalescing: never discard authority changes that race
            # a multi-page fetch. The active sync's finally block schedules it.
            self._projection_sync_pending[request.provider_peer_id] = request.model_copy(deep=True)
        elif current_task is not None:
            # Register before the first await so concurrent invalidations cannot
            # both become the active sync for the same provider.
            self._projection_sync_tasks[request.provider_peer_id] = current_task
        local_policy = await self._tool_export_snapshot(include_rules=False)
        if (
            not local_policy.mesh_switches.consumer_mesh_tooling_enabled
            and existing_task is not None
            and existing_task is not current_task
            and not existing_task.done()
        ):
            existing_task.cancel()
            existing_sync_id = self._projection_sync_ids.get(request.provider_peer_id)
            if existing_sync_id:
                await self._request_db(
                    DBMethods.ABORT_TOOLING_REMOTE_CATALOG_SYNC,
                    DBAbortToolingRemoteCatalogSyncRequest(
                        sync_id=existing_sync_id,
                        reason_code="consumer_mesh_tooling_disabled",
                    ),
                )
            self._projection_sync_pending.pop(request.provider_peer_id, None)
            existing_task = None
        if (
            existing_task is not None
            and existing_task is not current_task
            and not existing_task.done()
        ):
            return EmptyOutput()
        if current_task is not None and existing_task is None:
            self._projection_sync_tasks[request.provider_peer_id] = current_task

        if not local_policy.mesh_switches.consumer_mesh_tooling_enabled:
            self._projection_sync_pending.pop(request.provider_peer_id, None)
            await self._request_db(
                DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY,
                DBSetToolingRemoteProviderAvailabilityRequest(
                    peer_id=request.provider_peer_id,
                    provider_id=request.provider_peer_id,
                    availability="stale",
                    reason_code="consumer_mesh_tooling_disabled",
                ),
            )
            self._catalog_cache.clear()
            self._complete_projection_sync_task(request.provider_peer_id, current_task)
            return EmptyOutput()

        if request.reason_code.startswith(("provider_disconnected", "provider_status_")):
            await self._request_db(
                DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY,
                DBSetToolingRemoteProviderAvailabilityRequest(
                    peer_id=request.provider_peer_id,
                    provider_id=request.provider_peer_id,
                    availability="provider_unavailable",
                    reason_code=request.reason_code,
                ),
            )
            self._catalog_cache.clear()
            self._complete_projection_sync_task(request.provider_peer_id, current_task)
            return EmptyOutput()
        if request.reason_code in {
            "legacy_unverifiable",
            "protocol_unsupported",
            "baseline_required",
        }:
            await self._request_db(
                DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY,
                DBSetToolingRemoteProviderAvailabilityRequest(
                    peer_id=request.provider_peer_id,
                    provider_id=request.provider_peer_id,
                    availability="protocol_unsupported",
                    reason_code=request.reason_code,
                ),
            )
            self._catalog_cache.clear()
            self._complete_projection_sync_task(request.provider_peer_id, current_task)
            return EmptyOutput()

        sync_id = uuid.uuid4().hex
        self._projection_sync_ids[request.provider_peer_id] = sync_id
        begun = False
        verified_granted_permissions: tuple[str, ...] | None = None
        verified_service_instance_id: str | None = None
        try:
            existing = await self._request_db(
                DBMethods.GET_TOOLING_REMOTE_CATALOG,
                DBGetToolingRemoteCatalogRequest(
                    peer_id=request.provider_peer_id, provider_id=request.provider_peer_id
                ),
            )
            existing_data = (
                existing.data.model_dump(mode="python")
                if hasattr(existing.data, "model_dump")
                else existing.data or {}
            )
            headers = existing_data.get("headers", []) if existing.ok else []
            first_header = headers[0] if headers else {}
            if hasattr(first_header, "model_dump"):
                first_header = first_header.model_dump(mode="python")
            base_generation = int(first_header.get("current_generation", 0))
            cursor = None
            while True:
                fetched = await self.bus.request(
                    GatewayMethods.FETCH_TOOLING_EXPORT_CATALOG_PAGE,
                    GatewayFetchToolingExportCatalogPageRequest(
                        provider_peer_id=request.provider_peer_id,
                        request=ToolingGetExportCatalogRequest(cursor=cursor),
                    ),
                    origin="internal",
                    timeout=10.0,
                )
                if not fetched.ok:
                    fetched_data = (
                        fetched.data.model_dump(mode="python")
                        if hasattr(fetched.data, "model_dump")
                        else fetched.data
                    )
                    proxy_reason = (
                        fetched_data.get("reason_code") if isinstance(fetched_data, dict) else None
                    )
                    raise _ProjectionFetchUnavailableError(
                        proxy_reason or "projection_fetch_failed"
                    )
                proxy = GatewayFetchToolingExportCatalogPageResponse.model_validate(fetched.data)
                if not proxy.ok or proxy.page is None:
                    raise _ProjectionFetchUnavailableError(
                        proxy.reason_code or "projection_fetch_failed"
                    )
                page = proxy.page
                if page.provider_peer_id != request.provider_peer_id:
                    raise RuntimeError("projection_provider_mismatch")
                page_granted_permissions = tuple(sorted(set(proxy.granted_permissions)))
                if verified_granted_permissions is None:
                    verified_granted_permissions = page_granted_permissions
                    verified_service_instance_id = page.service_instance_id
                elif (
                    page_granted_permissions != verified_granted_permissions
                    or page.service_instance_id != verified_service_instance_id
                ):
                    raise RuntimeError("projection_authority_changed")
                if not begun:
                    result = await self._request_db(
                        DBMethods.BEGIN_TOOLING_REMOTE_CATALOG_SYNC,
                        DBBeginToolingRemoteCatalogSyncRequest(
                            sync_id=sync_id,
                            peer_id=request.provider_peer_id,
                            provider_id=request.provider_peer_id,
                            service_instance_id=page.service_instance_id,
                            projection_revision=page.projection_revision,
                            projection_digest=page.projection_digest,
                            authority_revision=page.authority_revision,
                            page_size=page.page_size,
                            expected_base_generation=base_generation,
                        ),
                    )
                    if not result.ok:
                        raise RuntimeError("projection_stage_failed")
                    begun = True
                appended = await self._request_db(
                    DBMethods.APPEND_TOOLING_REMOTE_CATALOG_PAGE,
                    DBAppendToolingRemoteCatalogPageRequest(
                        sync_id=sync_id,
                        page=page,
                        used_cursor_hash=(
                            hashlib.sha256(cursor.encode()).hexdigest() if cursor else None
                        ),
                    ),
                )
                if not appended.ok:
                    raise RuntimeError(appended.error or "projection_page_rejected")
                if page.complete:
                    break
                cursor = page.next_cursor
            requires_policy_reconciliation = any(
                rule.provider_peer_id == request.provider_peer_id
                and isinstance(rule.global_tool_id, str)
                and bool(rule.global_tool_id)
                for rule in self._sharing_policy.rules
            )
            if requires_policy_reconciliation:
                self._policy_reconciliation_inflight.add(request.provider_peer_id)
            committed = await self._request_db(
                DBMethods.COMMIT_TOOLING_REMOTE_CATALOG_SYNC,
                DBCommitToolingRemoteCatalogSyncRequest(
                    sync_id=sync_id,
                    expected_base_generation=base_generation,
                    defer_activation_for_policy_reconciliation=requires_policy_reconciliation,
                ),
            )
            if not committed.ok:
                raise RuntimeError("projection_commit_failed")
            committed_data = (
                committed.data.model_dump(mode="python")
                if committed.data is not None and hasattr(committed.data, "model_dump")
                else committed.data or {}
            )
            if isinstance(committed_data, dict) and committed_data.get("ok") is False:
                raise RuntimeError(str(committed_data.get("error") or "projection_commit_failed"))
            begun = False
            if verified_granted_permissions is None or verified_service_instance_id is None:
                raise RuntimeError("projection_authority_missing")
            self._update_remote_provider_state(
                peer_id=request.provider_peer_id,
                service_instance_id=verified_service_instance_id,
                granted_permissions=list(verified_granted_permissions),
                available=True,
            )
            if not requires_policy_reconciliation:
                self._catalog_cache.clear()
                await self._audit_tooling_event(
                    "tooling.catalog_projection.refetched",
                    principal_id=None,
                    details={
                        "provider_peer_id": request.provider_peer_id,
                        "reason_code": request.reason_code,
                        "sync_duration_ms": round((time.monotonic() - started_at) * 1000, 3),
                        "secrets_redacted": True,
                    },
                )
                return EmptyOutput()
            try:
                await self._migrate_remote_policy_rule_tool_ids(request.provider_peer_id)
            except Exception:
                # The catalog commit is durable, so never issue a misleading
                # abort. Keep the provider non-bindable until Config-owned
                # approval/refusal selectors can be reconciled safely.
                stale = await self._request_db(
                    DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY,
                    DBSetToolingRemoteProviderAvailabilityRequest(
                        peer_id=request.provider_peer_id,
                        provider_id=request.provider_peer_id,
                        availability="stale",
                        reason_code="policy_alias_reconciliation_failed",
                    ),
                )
                stale_data = (
                    stale.data.model_dump(mode="python")
                    if stale.data is not None and hasattr(stale.data, "model_dump")
                    else stale.data or {}
                )
                if not stale.ok or (isinstance(stale_data, dict) and stale_data.get("ok") is False):
                    log_error(
                        "Remote Tooling policy reconciliation failed and stale marking "
                        "also failed; durable pending state remains non-bindable"
                    )
                self._catalog_cache.clear()
                raise
            header = committed_data.get("header", {}) if isinstance(committed_data, dict) else {}
            if hasattr(header, "model_dump"):
                header = header.model_dump(mode="python")
            generation = int(
                (committed_data.get("generation", 0) if isinstance(committed_data, dict) else 0)
                or (header.get("current_generation", 0) if isinstance(header, dict) else 0)
            )
            projection_revision = (
                str(header.get("projection_revision") or "") if isinstance(header, dict) else ""
            )
            if generation < 1 or not projection_revision:
                raise RuntimeError("projection_commit_missing_policy_finalize_cas")
            finalized = await self._request_db(
                DBMethods.FINALIZE_TOOLING_REMOTE_CATALOG_POLICY,
                DBFinalizeToolingRemoteCatalogPolicyRequest(
                    peer_id=request.provider_peer_id,
                    provider_id=request.provider_peer_id,
                    expected_generation=generation,
                    expected_projection_revision=projection_revision,
                ),
            )
            finalized_data = (
                finalized.data.model_dump(mode="python")
                if finalized.data is not None and hasattr(finalized.data, "model_dump")
                else finalized.data or {}
            )
            if not finalized.ok or (
                isinstance(finalized_data, dict) and finalized_data.get("ok") is False
            ):
                raise RuntimeError("projection_policy_finalize_failed")
            self._catalog_cache.clear()
            await self._audit_tooling_event(
                "tooling.catalog_projection.refetched",
                principal_id=None,
                details={
                    "provider_peer_id": request.provider_peer_id,
                    "reason_code": request.reason_code,
                    "sync_duration_ms": round((time.monotonic() - started_at) * 1000, 3),
                    "secrets_redacted": True,
                },
            )
        except _ProjectionFetchUnavailableError as exc:
            if begun:
                await self._request_db(
                    DBMethods.ABORT_TOOLING_REMOTE_CATALOG_SYNC,
                    DBAbortToolingRemoteCatalogSyncRequest(
                        sync_id=sync_id, reason_code="projection_sync_failed"
                    ),
                )
            await self._request_db(
                DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY,
                DBSetToolingRemoteProviderAvailabilityRequest(
                    peer_id=request.provider_peer_id,
                    provider_id=request.provider_peer_id,
                    availability="stale",
                    reason_code="projection_fetch_failed",
                ),
            )
            self._catalog_cache.clear()
            log_warning(
                "Tooling projection refresh deferred for "
                f"{request.provider_peer_id}: {exc}"
            )
            return EmptyOutput()
        except Exception:
            if begun:
                await self._request_db(
                    DBMethods.ABORT_TOOLING_REMOTE_CATALOG_SYNC,
                    DBAbortToolingRemoteCatalogSyncRequest(
                        sync_id=sync_id, reason_code="projection_sync_failed"
                    ),
                )
            raise
        finally:
            if self._projection_sync_ids.get(request.provider_peer_id) == sync_id:
                self._projection_sync_ids.pop(request.provider_peer_id, None)
            self._policy_reconciliation_inflight.discard(request.provider_peer_id)
            self._complete_projection_sync_task(request.provider_peer_id, current_task)
        return EmptyOutput()

    def _complete_projection_sync_task(self, provider_peer_id: str, current_task: Any) -> None:
        """Clear one run and immediately reserve its latest-wins rerun slot."""

        if self._projection_sync_tasks.get(provider_peer_id) is current_task:
            self._projection_sync_tasks.pop(provider_peer_id, None)
        pending = self._projection_sync_pending.pop(provider_peer_id, None)
        if pending is not None:
            rerun = asyncio.create_task(self._on_projection_sync_requested(pending))
            self._projection_sync_tasks[provider_peer_id] = rerun

    @staticmethod
    def _redact_arguments(value: Any) -> Any:
        """Return arguments with secret-like keys replaced before hashing/auditing."""

        if isinstance(value, dict):
            redacted = {}
            for key, nested in value.items():
                if any(secret_key in str(key).lower() for secret_key in _ARG_REDACT_KEYS):
                    redacted[key] = "<redacted>"
                else:
                    redacted[key] = ToolingService._redact_arguments(nested)
            return redacted
        if isinstance(value, list):
            return [ToolingService._redact_arguments(item) for item in value]
        return value

    @staticmethod
    def _argument_visibility(tool: Any) -> dict[str, str]:
        """Return field-level display/log visibility for a tool argument schema."""

        explicit = getattr(tool, "argument_visibility", None)
        if isinstance(explicit, dict):
            return {
                str(key): str(value)
                for key, value in explicit.items()
                if value
                in {"display", "hash_only", "secret", "raw_never", "support_bundle_redacted"}
            }

        schema = getattr(tool, "args_schema", None)
        if not isinstance(schema, dict):
            schema = getattr(tool, "schema", None)
        properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
        visibility: dict[str, str] = {}
        if isinstance(properties, dict):
            for key, spec in properties.items():
                key_text = str(key)
                if any(secret_key in key_text.lower() for secret_key in _ARG_REDACT_KEYS):
                    visibility[key_text] = "secret"
                    continue
                marker = None
                if isinstance(spec, dict):
                    marker = (
                        spec.get("x-aurora-visibility")
                        or spec.get("aurora_visibility")
                        or spec.get("visibility")
                    )
                visibility[key_text] = (
                    marker
                    if marker
                    in {"display", "hash_only", "secret", "raw_never", "support_bundle_redacted"}
                    else "display"
                )
        return visibility

    @classmethod
    def _display_arguments_preview(
        cls, arguments: dict[str, Any], visibility: dict[str, str] | None = None
    ) -> dict[str, Any]:
        """Return initiating-user-safe arguments without hiding harmless text/query fields."""

        visibility = visibility or {}
        preview: dict[str, Any] = {}
        for key, value in arguments.items():
            key_text = str(key)
            field_visibility = visibility.get(key_text)
            if field_visibility in {"secret", "raw_never"} or any(
                secret_key in key_text.lower() for secret_key in _ARG_REDACT_KEYS
            ):
                preview[key_text] = "<redacted>"
            elif field_visibility in {"hash_only", "support_bundle_redacted"}:
                preview[key_text] = (
                    f"sha256:{cls._display_arguments_fingerprint({key_text: value})}"
                )
            else:
                preview[key_text] = cls._redact_arguments(value)
        return preview

    @classmethod
    def _display_arguments_fingerprint(cls, arguments: dict[str, Any]) -> str:
        """Hash redacted arguments for UI/audit display only."""

        redacted = cls._redact_arguments(arguments)
        serialized = json.dumps(redacted, sort_keys=True, default=str, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    @classmethod
    def _arguments_fingerprint(cls, arguments: dict[str, Any]) -> str:
        """Hash raw canonical arguments for security binding.

        Approval tokens and durable grants must bind the exact submitted
        argument values, including secret-like fields. Redacted fingerprints are
        only safe for display/audit correlation and must not be used for
        authorization.
        """

        serialized = json.dumps(arguments, sort_keys=True, default=str, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    @classmethod
    def _execution_log_context(
        cls,
        request: ToolingExecuteToolRequest,
        *,
        local_tool_name: str | None = None,
        global_tool_id: str | None = None,
        provider_peer_id: str | None = None,
        status: str,
        error_code: str | None = None,
        error_type: str | None = None,
        result_present: bool | None = None,
    ) -> dict[str, Any]:
        """Build privacy-preserving Tooling execution log fields."""

        sensitive_key_count = sum(
            1
            for key in request.arguments
            if any(secret_key in str(key).lower() for secret_key in _ARG_REDACT_KEYS)
        )
        return {
            "tool_name": request.tool_name,
            "local_tool_name": local_tool_name,
            "global_tool_id": global_tool_id,
            "provider_peer_id": provider_peer_id,
            "target_peer_id": cls._selector_target_peer(request) or provider_peer_id,
            "caller_peer_id": request.caller_peer_id,
            "caller_principal_id": request.caller_principal_id,
            "correlation_id": request.correlation_id,
            "status": status,
            "argument_hash": cls._arguments_fingerprint(request.arguments),
            "argument_count": len(request.arguments),
            "sensitive_argument_key_count": sensitive_key_count,
            "error_code": error_code,
            "error_type": error_type,
            "result_present": result_present,
        }

    @staticmethod
    def _safe_error_text(error: BaseException, *, limit: int = 500) -> str:
        text = str(error).replace("\n", " ").strip()
        for pattern in _ERROR_REDACT_PATTERNS:
            text = pattern.sub("<redacted>", text)
        return text[:limit] if text else type(error).__name__

    @staticmethod
    def _safe_error_trace(error: BaseException, *, limit: int = 6) -> list[str]:
        frames = traceback.extract_tb(error.__traceback__)[-limit:]
        return [
            f"{frame.filename.rsplit('/', 1)[-1]}:{frame.lineno} in {frame.name}"
            for frame in frames
        ]

    @staticmethod
    def _secret_argument_strings(arguments: Any) -> list[str]:
        values: list[str] = []
        if isinstance(arguments, dict):
            for key, nested in arguments.items():
                if any(secret_key in str(key).lower() for secret_key in _ARG_REDACT_KEYS):
                    if isinstance(nested, str) and nested:
                        values.append(nested)
                    continue
                values.extend(ToolingService._secret_argument_strings(nested))
        elif isinstance(arguments, list | tuple):
            for item in arguments:
                values.extend(ToolingService._secret_argument_strings(item))
        return values

    @staticmethod
    def _selector_target_peer(request: ToolingExecuteToolRequest) -> str | None:
        selector = request.mesh_selector
        if not selector:
            return None
        return selector.peer_id or selector.provider_id

    @staticmethod
    def _request_has_resource_selector(request: ToolingExecuteToolRequest) -> bool:
        resource_selector = request.resource_selector
        if resource_selector and resource_selector.has_resource():
            return True
        selector = request.mesh_selector
        return bool(
            selector
            and (
                selector.resource_namespace
                or selector.hardware_target
                or selector.data_scope
                or selector.tool_id
            )
        )

    @staticmethod
    def _resource_selector_fingerprint(request: ToolingExecuteToolRequest) -> str:
        resource_selector = (
            request.resource_selector.model_dump(mode="json", exclude_none=True)
            if request.resource_selector
            else {}
        )
        mesh_selector = (
            request.mesh_selector.model_dump(mode="json", exclude_none=True)
            if request.mesh_selector
            else {}
        )
        selector_fields = {
            "resource_selector": resource_selector,
            "mesh_resource_namespace": mesh_selector.get("resource_namespace"),
            "mesh_hardware_target": mesh_selector.get("hardware_target"),
            "mesh_data_scope": mesh_selector.get("data_scope"),
            "mesh_tool_id": mesh_selector.get("tool_id"),
        }
        serialized = json.dumps(selector_fields, sort_keys=True, default=str, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    @classmethod
    def _route_decision_id(
        cls,
        request: ToolingExecuteToolRequest,
        *,
        provider_peer_id: str,
        service_instance_id: str,
    ) -> str:
        route_fields = {
            "provider_peer_id": provider_peer_id,
            "service_instance_id": service_instance_id,
            "target_peer_id": cls._selector_target_peer(request),
        }
        serialized = json.dumps(route_fields, sort_keys=True, default=str)
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    def _tool_safety_class(self, tool: Any) -> str:
        return self._safe_metadata_value(
            getattr(tool, "safety_class", "standard"),
            {"standard", "sensitive", "dangerous"},
            "standard",
        )

    def _tool_requires_confirmation(self, tool: Any, safety_class: str) -> bool:
        explicit_confirmation = getattr(tool, "confirmation_required", False)
        return explicit_confirmation is True or safety_class in {"sensitive", "dangerous"}

    @staticmethod
    def _missing_required_permissions(
        required_permissions: list[str], caller_permissions: list[str] | None
    ) -> list[str]:
        """Return the exact permission subset not covered by the caller grants."""

        required = list(dict.fromkeys(str(permission) for permission in required_permissions))
        if caller_permissions is None:
            # Legacy internal callers implicitly have the baseline Tooling call
            # permission, but never acquire cross-module permissions such as TTS.
            return [
                permission for permission in required if permission != ToolingMethods.EXECUTE_TOOL
            ]

        return [
            permission
            for permission in required
            if not permission_satisfies(permission, caller_permissions)
        ]

    @classmethod
    def _has_required_permissions(
        cls, required_permissions: list[str], caller_permissions: list[str] | None
    ) -> bool:
        """Return whether caller permissions satisfy a tool's declared requirements."""

        return not cls._missing_required_permissions(required_permissions, caller_permissions)

    @staticmethod
    def _tool_required_permissions(
        tool: Any,
        arguments: dict[str, Any] | None = None,
    ) -> list[str]:
        """Return static plus argument-dependent permissions for one tool.

        LangChain tools expose ``metadata`` as a declared field, so Aurora-owned
        tools publish policy there. The direct attribute remains a compatibility
        fallback for plugin tools and existing integrations.
        """

        metadata = getattr(tool, "metadata", None)
        metadata = metadata if isinstance(metadata, dict) else {}
        raw_required_permissions = metadata.get("required_permissions")
        if not isinstance(raw_required_permissions, (list, tuple, set)):
            raw_required_permissions = getattr(tool, "required_permissions", None)
        required = (
            [str(permission) for permission in raw_required_permissions]
            if isinstance(raw_required_permissions, (list, tuple, set))
            else [ToolingMethods.EXECUTE_TOOL]
        )

        if arguments is not None:
            conditions = metadata.get("conditional_required_permissions", [])
            if isinstance(conditions, (list, tuple)):
                for condition in conditions:
                    if not isinstance(condition, dict):
                        continue
                    argument_name = condition.get("argument")
                    values = condition.get("values")
                    permissions = condition.get("permissions")
                    if not isinstance(argument_name, str) or not isinstance(
                        values, (list, tuple, set)
                    ):
                        continue
                    if not isinstance(permissions, (list, tuple, set)):
                        continue
                    argument_value = arguments.get(argument_name)
                    expected_values = list(values)
                    if condition.get("casefold") is True and isinstance(argument_value, str):
                        argument_value = argument_value.strip().casefold()
                        expected_values = [
                            value.strip().casefold() if isinstance(value, str) else value
                            for value in expected_values
                        ]
                    if argument_value in expected_values:
                        required.extend(str(permission) for permission in permissions)

            resolver = metadata.get("required_permissions_resolver")
            if resolver is None:
                resolver = getattr(tool, "required_permissions_resolver", None)
            if callable(resolver):
                dynamic = resolver(arguments)
                if isinstance(dynamic, (list, tuple, set)):
                    required.extend(str(permission) for permission in dynamic)

        return list(dict.fromkeys(required))

    @staticmethod
    def _envelope_is_externalish(envelope: Any | None) -> bool:
        if envelope is None:
            return False
        identity_source = getattr(envelope, "identity_source", None)
        origin = getattr(envelope, "origin", "internal")
        return origin == "external" or identity_source in {
            "gateway_http",
            "gateway_admin_action",
            "webrtc_rpc",
            "mesh_peer",
            "remote_peer",
            "token",
        }

    async def _execution_caller_permissions(
        self,
        request: ToolingExecuteToolRequest,
        envelope: Any | None,
    ) -> list[str] | None:
        """Resolve execution permissions without trusting external payload fields."""

        if envelope is None:
            return request.caller_permissions

        if not self._envelope_is_externalish(envelope):
            return request.caller_permissions if request.caller_permissions is not None else ["*"]

        effective = getattr(envelope, "effective_perms", None)
        if effective is None:
            return []
        return [str(permission) for permission in effective]

    def _authoritative_actor_principal(
        self,
        envelope: Any | None,
        fallback: str | None,
    ) -> str | None:
        """Resolve admin actor from authenticated transport envelope when present."""

        principal_id = getattr(envelope, "principal_id", None) if envelope is not None else None
        if principal_id and self._envelope_is_externalish(envelope):
            return str(principal_id)
        return fallback

    @staticmethod
    def _reject_remote_export_administration(envelope: Any | None) -> str | None:
        """Allow only Gateway requests carrying verified AdminAction provenance.

        The generated Gateway route stamps this source only after consuming and
        auditing an AdminAction receipt. Direct bus, mesh, token, unknown, and
        ordinary authenticated HTTP envelopes therefore fail closed.
        """

        if envelope is None or getattr(envelope, "identity_source", None) != (
            "gateway_admin_action"
        ):
            return "local_admin_action_required"
        if getattr(envelope, "caller_peer_id", None):
            return "local_admin_action_required"
        return None

    @staticmethod
    def _reject_remote_export_management_read(envelope: Any | None) -> str | None:
        """Keep export-policy inspection on the local management plane."""

        if envelope is None:
            return None
        if getattr(envelope, "caller_peer_id", None):
            return "local_management_only"
        identity_source = getattr(envelope, "identity_source", None)
        origin = getattr(envelope, "origin", "internal")
        if origin != "external":
            return None
        if identity_source in {
            "gateway_http",
            "http_bearer",
            "gateway_admin_action",
            "system",
        }:
            return None
        return "local_management_only"

    def _local_export_authority_index(self) -> dict[str, tuple[Any, LoadedToolIdentity]]:
        """Index loaded local export authority by canonical immutable tool ID."""

        if not self._stable_peer_id:
            return {}
        indexed: dict[str, tuple[Any, LoadedToolIdentity]] = {}
        for tool in self.tools_manager.get_tools(query=None, top_k=10_000):
            identity = getattr(tool, "_aurora_tool_identity", None)
            if not isinstance(identity, LoadedToolIdentity) or identity.source_kind == "mesh_peer":
                continue
            canonical_id = canonical_tool_global_id(self._stable_peer_id, identity.tool_contract_id)
            indexed[canonical_id] = (tool, identity)
        return indexed

    async def _tool_export_snapshot(
        self,
        *,
        peer_id: str | None = None,
        include_rules: bool = True,
        include_stale: bool = True,
    ) -> DBGetToolingExportPolicySnapshotResponse:
        """Read one atomic export snapshot using only the typed DB authority API."""

        indexed = self._local_export_authority_index()
        result = await self.bus.request(
            DBMethods.GET_TOOLING_EXPORT_POLICY_SNAPSHOT,
            DBGetToolingExportPolicySnapshotRequest(
                peer_id=peer_id,
                include_rules=include_rules,
                include_stale=include_stale,
                known_global_tool_ids=sorted(indexed),
                known_share_group_ids=sorted(
                    {identity.share_group_id for _, identity in indexed.values()}
                ),
            ),
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
            priority=get_interactive_priority(),
        )
        if not result.ok:
            raise RuntimeError(result.error or "Tooling export policy read failed")
        return DBGetToolingExportPolicySnapshotResponse.model_validate(result.data)

    async def _mutate_tool_export_policy(
        self,
        request: DBMutateToolingExportPolicyRequest,
    ) -> DBMutateToolingExportPolicyResponse:
        """Forward one already-authorized optimistic export mutation."""

        result = await self.bus.request(
            DBMethods.MUTATE_TOOLING_EXPORT_POLICY,
            request,
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
            priority=get_interactive_priority(),
        )
        if result.data is not None:
            try:
                mutation = DBMutateToolingExportPolicyResponse.model_validate(result.data)
                if mutation.ok and mutation.changed:
                    await self._announce_local_tool_catalog(
                        reason="export_policy_changed",
                        affected_peer_ids=[request.peer_id] if request.peer_id else None,
                    )
                return mutation
            except Exception:
                if result.ok:
                    raise
        raise RuntimeError(result.error or "Tooling export policy mutation failed")

    def _export_mutation_actor_error(
        self,
        envelope: Any | None,
        claimed_actor: str,
        confirmation_text: str,
    ) -> tuple[str | None, str | None]:
        """Validate local AdminAction provenance and return authoritative actor."""

        remote_error = self._reject_remote_export_administration(envelope)
        if remote_error:
            return None, remote_error
        if confirmation_text != TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT:
            return None, "export_policy_confirmation_required"
        actor = self._authoritative_actor_principal(envelope, claimed_actor)
        if not actor:
            return None, "authenticated_actor_required"
        if self._envelope_is_externalish(envelope) and actor != claimed_actor:
            log_warning(
                "Ignoring client-supplied Tooling export actor; using the "
                "authenticated AdminAction principal"
            )
        return actor, None

    @staticmethod
    def _export_error_response(
        response_type: type[ToolingExportMutationResponse],
        *,
        revision: int,
        error: str,
        correlation_id: str | None,
    ) -> ToolingExportMutationResponse:
        return response_type(
            ok=False,
            previous_revision=revision,
            revision=revision,
            error=error,
            correlation_id=correlation_id,
        )

    def _permission_denied_prepared_response(
        self,
        request: ToolingExecuteToolRequest,
        *,
        tool: Any,
        local_tool_name: str,
        provider_peer_id: str,
        service_instance_id: str,
        global_tool_id: str,
    ) -> ToolingPrepareExecutionResponse:
        """Return a prepare response that denies execution for missing tool permissions."""

        prepared = self._prepared_execution(
            request,
            tool=tool,
            local_tool_name=local_tool_name,
            provider_peer_id=provider_peer_id,
            service_instance_id=service_instance_id,
            global_tool_id=global_tool_id,
        )
        prepared.ok = False
        prepared.policy_decision = ToolingPolicyDecision(
            allowed=False,
            share=False,
            approval_required=False,
            approval_mode=self._sharing_policy.default_approval_mode,
            decision_id=uuid.uuid4().hex,
            reason="permission_denied",
        )
        return prepared

    def _catalog_tool_block_reason(
        self, tool: ToolingToolInfo, caller_permissions: list[str] | None
    ) -> tuple[str, str] | None:
        """Return catalog policy metadata for tools needing special handling.

        Permission-denied and explicitly blocked tools are hard blocks and must
        not be model-visible. External approval-required tools are still
        returned in the bindable catalog so the LLM can ask to use them; they
        are also included in ``blocked_tools`` as legacy/metadata for the
        approval interrupt UI. Local core tools that require confirmation or
        carry a sensitive/dangerous safety class stay only in the normal local
        catalog group; runtime Tooling policy owns the approval interrupt.
        """

        if not ToolingService._has_required_permissions(
            tool.required_permissions, caller_permissions
        ):
            return (
                "permission_denied",
                "caller principal lacks required tool permissions",
            )
        if tool.trust_tier == "blocked":
            return (
                "tool_blocked",
                "tool is explicitly blocked by local policy",
            )
        if tool.trust_tier == "untrusted" and (
            tool.source_type in {"mesh_peer", "mcp", "plugin"}
            or tool.source in {"mcp", "plugin", "mesh_peer"}
            or tool.execution_location == "remote"
        ):
            return (
                "approval_required",
                "untrusted external tools require explicit user approval before execution",
            )
        is_local_core_tool = (
            tool.source_type == "local"
            and tool.execution_location == "local"
            and self._is_local_provider(tool.provider_peer_id)
            and (tool.source == "core" or getattr(tool.provenance, "source", None) == "core")
        )
        if not is_local_core_tool and tool.safety_class in {"sensitive", "dangerous"}:
            return (
                "unsafe_safety_class",
                f"{tool.safety_class} tools require explicit selection and approval",
            )
        if not is_local_core_tool and tool.confirmation_required:
            return (
                "confirmation_required",
                "tool requires approval before execution",
            )
        return None

    async def _catalog_caller_permissions(
        self,
        request: ToolingGetToolCatalogRequest,
        envelope: Any | None,
    ) -> list[str] | None:
        """Resolve catalog permissions from authenticated bus context.

        The request field is accepted only for direct/internal calls where no
        envelope exists. External callers must not be able to grant themselves
        catalog permissions by payload.
        """

        if envelope is None:
            return request.caller_permissions

        effective_permissions = getattr(envelope, "effective_perms", None)
        if effective_permissions is not None:
            return [str(permission) for permission in effective_permissions]

        principal_id = getattr(envelope, "principal_id", None)
        if not principal_id:
            return None
        if principal_id in {"system", "open_peer"}:
            return ["*"]

        try:
            result = await self.bus.request(
                AuthMethods.GET_PRINCIPAL,
                PrincipalGetRequest(user_id=principal_id),
                timeout=3.0,
                priority=get_system_priority(),
            )
        except Exception as error:
            log_warning(f"Failed to resolve catalog caller permissions: {error}")
            return []

        if not result.ok or result.data is None:
            log_warning(f"Catalog caller principal lookup failed: {result.error}")
            return []

        data = (
            result.data.model_dump(mode="json")
            if hasattr(result.data, "model_dump")
            else result.data
        )
        if not isinstance(data, dict):
            return []
        permissions = data.get("permissions") or []
        return [str(permission) for permission in permissions]

    @staticmethod
    def _provider_service_instance_id(peer_id: str) -> str:
        return f"remote:{peer_id}:Tooling"

    def _remote_tooling_candidates(self) -> list[Any]:
        """Return all remote Tooling provider candidates when running behind MeshBus."""

        if not self._remote_tooling_registry_available():
            return []

        bus = self.bus
        routing_table = getattr(bus, "_routing_table", None)
        registry = getattr(routing_table, "_registry", None)
        current_mesh_policy_snapshot = getattr(bus, "current_mesh_policy_snapshot", None)
        policy_snapshot = current_mesh_policy_snapshot()
        routing_config = policy_snapshot.mesh_config.services.get(ToolingModule.NAME)
        version_policy = getattr(policy_snapshot.mesh_config, "version_policy", "compatible")

        try:
            return list(
                registry.get_provider_candidates(
                    module=ToolingModule.NAME,
                    topic=ToolingMethods.GET_TOOLS,
                    routing_config=routing_config,
                    version_policy=version_policy,
                    include_ineligible=True,
                    policy_snapshot=policy_snapshot,
                )
            )
        except Exception as error:
            log_warning(f"Failed to enumerate remote Tooling providers: {error}")
            return []

    def _remote_tooling_registry_available(self) -> bool:
        bus = self.bus
        routing_table = getattr(bus, "_routing_table", None)
        registry = getattr(routing_table, "_registry", None)
        current_mesh_policy_snapshot = getattr(bus, "current_mesh_policy_snapshot", None)
        return bool(registry and callable(current_mesh_policy_snapshot))

    def _update_remote_provider_state(
        self,
        *,
        peer_id: str,
        service_instance_id: str,
        granted_permissions: list[str] | None = None,
        available: bool | None = None,
    ) -> None:
        """Update volatile authority received from the local Gateway process.

        Tool definitions are durable, but provider reachability and the
        recipient-specific permission grant are session facts.  Keeping them
        in a separate in-memory map makes a Tooling restart fail closed while
        preserving the registry and all policy rows in the database.
        """

        key = (peer_id, service_instance_id)
        previous_permissions, previous_available = self._remote_provider_states.get(
            key, (None, False)
        )
        normalized_permissions = previous_permissions
        if granted_permissions is not None:
            normalized_permissions = list(
                dict.fromkeys(str(permission) for permission in granted_permissions)
            )
        self._remote_provider_states[key] = (
            normalized_permissions,
            previous_available if available is None else bool(available),
        )

    @staticmethod
    def _candidate_provider_info(
        candidate: Any, *, cache_status: str
    ) -> ToolingCatalogProviderInfo:
        peer_id = candidate.peer.peer_id
        service_instance_id = ToolingService._provider_service_instance_id(peer_id)
        return ToolingCatalogProviderInfo(
            provider_peer_id=peer_id,
            provider_service_instance_id=service_instance_id,
            provider_label=(str(getattr(candidate.peer, "node_name", "") or "").strip() or peer_id),
            provider_kind="mesh_peer",
            eligible=bool(candidate.eligible),
            reason_code=candidate.reason_code or ("eligible" if candidate.eligible else "blocked"),
            reason=candidate.reason
            or ("eligible provider" if candidate.eligible else "provider blocked"),
            cache_status=cache_status,
        )

    @staticmethod
    def _candidate_granted_permissions(candidate: Any) -> list[str] | None:
        """Return verified current grants from the exact Tooling.GetTools decision."""

        decision = getattr(candidate, "decision", None)
        granted = getattr(decision, "granted_permissions", None)
        if granted is None:
            return None
        return [str(permission) for permission in granted]

    async def _current_peer_outbound_permissions(self, peer_id: str) -> list[str] | None:
        """Read the local Auth authority that gates use of one remote provider."""

        try:
            result = await self.bus.request(
                AuthMethods.MESH_GET_PEER,
                MeshPeerGetRequest(peer_id=peer_id),
                origin="internal",
                timeout=5.0,
                priority=get_interactive_priority(),
            )
            if not result.ok or result.data is None:
                return None
            response = MeshPeerGetResponse.model_validate(result.data)
            if response.peer is None or response.peer.outbound_status != "approved":
                return []
            return list(
                dict.fromkeys(
                    str(permission) for permission in response.peer.outbound_permissions
                )
            )
        except Exception as error:
            log_debug(f"Tooling peer authority unavailable for {peer_id}: {error}")
            return None

    @staticmethod
    def _catalog_cache_key(
        *,
        peer_id: str,
        service_instance_id: str,
        query: str | None,
        top_k: int,
        last_manifest: float,
    ) -> str:
        return json.dumps(
            {
                "peer_id": peer_id,
                "service_instance_id": service_instance_id,
                "query": query,
                "top_k": top_k,
                "last_manifest": last_manifest,
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    async def _get_remote_provider_tools(
        self,
        candidate: Any,
        request: ToolingGetToolCatalogRequest,
    ) -> tuple[ToolingCatalogProviderInfo, list[ToolingToolInfo]]:
        """Fetch one eligible remote provider's tools with a short per-peer cache."""

        peer_id = candidate.peer.peer_id
        service_instance_id = self._provider_service_instance_id(peer_id)
        cache_key = self._catalog_cache_key(
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            query=request.query,
            top_k=request.top_k,
            last_manifest=getattr(candidate.peer, "last_manifest", 0.0),
        )
        now = time.monotonic()
        cached = self._catalog_cache.get(cache_key)
        if cached and cached[0] > now:
            return (
                self._candidate_provider_info(candidate, cache_status="hit"),
                list(cached[1].tools),
            )

        selector = MeshAddressSelector(
            peer_id=peer_id,
            provider_id=service_instance_id,
            service_instance_id=service_instance_id,
        )
        remote_request = ToolingGetToolsRequest(
            query=request.query,
            top_k=request.top_k,
            mesh_selector=selector,
        )
        try:
            result = await self.bus.request(
                ToolingMethods.GET_TOOLS,
                remote_request,
                timeout=max(0.1, min(request.provider_timeout_seconds, 3.0)),
                priority=get_interactive_priority(),
            )
        except TimeoutError:
            return (
                ToolingCatalogProviderInfo(
                    provider_peer_id=peer_id,
                    provider_service_instance_id=service_instance_id,
                    provider_kind="mesh_peer",
                    eligible=False,
                    reason_code="provider_timeout",
                    reason="remote Tooling.GetTools request timed out",
                    cache_status="failed",
                ),
                [],
            )
        except Exception as error:
            return (
                ToolingCatalogProviderInfo(
                    provider_peer_id=peer_id,
                    provider_service_instance_id=service_instance_id,
                    provider_kind="mesh_peer",
                    eligible=False,
                    reason_code="provider_request_failed",
                    reason=f"remote Tooling.GetTools request failed: {type(error).__name__}",
                    cache_status="failed",
                ),
                [],
            )
        if not result.ok:
            return (
                ToolingCatalogProviderInfo(
                    provider_peer_id=peer_id,
                    provider_service_instance_id=service_instance_id,
                    provider_kind="mesh_peer",
                    eligible=False,
                    reason_code="provider_request_failed",
                    reason=result.error or "remote Tooling.GetTools request failed",
                    cache_status="failed",
                ),
                [],
            )

        try:
            if isinstance(result.data, ToolingGetToolsResponse):
                response = result.data
            else:
                response = ToolingGetToolsResponse.model_validate(result.data)
        except Exception as error:
            return (
                ToolingCatalogProviderInfo(
                    provider_peer_id=peer_id,
                    provider_service_instance_id=service_instance_id,
                    provider_kind="mesh_peer",
                    eligible=False,
                    reason_code="provider_response_invalid",
                    reason=f"remote Tooling.GetTools response was invalid: {type(error).__name__}",
                    cache_status="failed",
                ),
                [],
            )

        ttl = max(0.0, request.cache_ttl_seconds)
        if ttl > 0:
            self._catalog_cache[cache_key] = (now + ttl, response)
        return self._candidate_provider_info(candidate, cache_status="miss"), list(response.tools)

    def _append_catalog_tool(
        self,
        *,
        tool: ToolingToolInfo,
        caller_permissions: list[str] | None,
        tools: list[ToolingToolInfo],
        blocked_tools: list[ToolingBlockedToolInfo],
        include_blocked_tools: bool,
    ) -> None:
        block_reason = self._catalog_tool_block_reason(tool, caller_permissions)
        if block_reason:
            if include_blocked_tools:
                missing_permissions = (
                    self._missing_required_permissions(
                        tool.required_permissions,
                        caller_permissions,
                    )
                    if block_reason[0] == "permission_denied"
                    else []
                )
                blocked_tools.append(
                    ToolingBlockedToolInfo(
                        tool=tool,
                        reason_code=block_reason[0],
                        reason=block_reason[1],
                        missing_permissions=missing_permissions,
                    )
                )
            if block_reason[0] in {"permission_denied", "tool_blocked"}:
                return
        tools.append(tool)

    @staticmethod
    def _append_unavailable_catalog_tool(
        *,
        tool: ToolingToolInfo,
        reason_code: str,
        reason: str,
        blocked_tools: list[ToolingBlockedToolInfo],
        include_blocked_tools: bool,
        missing_permissions: list[str] | None = None,
    ) -> None:
        """Retain a cached tool as blocked metadata without making it bindable."""

        if not include_blocked_tools:
            return
        blocked_tools.append(
            ToolingBlockedToolInfo(
                tool=tool,
                reason_code=reason_code,
                reason=reason,
                missing_permissions=list(missing_permissions or []),
            )
        )

    @classmethod
    def _local_source_instance_id(cls, tool: Any, source: str) -> str:
        """Return a stable local source id for per-source policy management."""

        if source == "core":
            return "local:core"
        if source == "mcp":
            raw_identifier = (
                getattr(tool, "mcp_server_name", None)
                or getattr(tool, "server_name", None)
                or getattr(tool, "toolkit_name", None)
                or getattr(getattr(tool, "provenance", None), "server_name", None)
                or getattr(getattr(tool, "provenance", None), "source_id", None)
                or getattr(getattr(tool, "provenance", None), "advertised_name", None)
                or getattr(tool, "local_name", None)
                or getattr(tool, "name", None)
                or "default"
            )
            return f"local:mcp:{cls._safe_identifier(str(raw_identifier))}"
        if source == "plugin":
            module_name = getattr(tool, "__module__", "") or tool.__class__.__module__
            plugin_marker = getattr(tool, "_aurora_plugin_id", None)
            raw_identifier = (
                (plugin_marker if isinstance(plugin_marker, str) and plugin_marker else None)
                or getattr(tool, "plugin_name", None)
                or getattr(tool, "package_name", None)
                or getattr(tool, "toolkit_name", None)
                or (module_name if module_name else None)
                or getattr(tool, "local_name", None)
                or getattr(tool, "name", None)
                or "default"
            )
            return f"local:plugin:{cls._safe_identifier(str(raw_identifier))}"
        source = source if source in {"unknown", "blocked"} else "unknown"
        return f"local:{source}"

    @classmethod
    def _source_id_for_tool(cls, tool: ToolingToolInfo | Any) -> str:
        """Return the stable management source id for a catalog tool."""

        if tool.source == "mesh_peer" or tool.source_type == "mesh_peer":
            return (
                f"mesh:{tool.provider_peer_id}:"
                f"{cls._safe_identifier(tool.provider_service_instance_id)}"
            )
        source_id = getattr(tool, "source_id", None)
        if isinstance(source_id, str) and source_id:
            return source_id
        source = tool.source if tool.source in {"core", "plugin", "mcp", "unknown"} else "unknown"
        return cls._local_source_instance_id(tool, source)

    def _source_id_for_prepared(self, prepared: ToolingPrepareExecutionResponse) -> str:
        """Return the stable management source id for a prepared execution."""

        if prepared.source_id:
            return prepared.source_id
        if prepared.source == "mesh_peer" or not self._is_local_provider(prepared.provider_peer_id):
            return (
                f"mesh:{prepared.provider_peer_id}:"
                f"{ToolingService._safe_identifier(prepared.provider_service_instance_id)}"
            )
        source = (
            prepared.source
            if prepared.source in {"core", "plugin", "mcp", "unknown"}
            else "unknown"
        )
        return f"local:{source}"

    @staticmethod
    def _canonical_source_type_from_source_id(source_id: str) -> str:
        """Return Tooling source taxonomy for a management source id."""

        if source_id.startswith("mesh:"):
            return "mesh_peer"
        if source_id.startswith("local:"):
            source = source_id.split(":", 2)[1]
            return source if source in {"core", "plugin", "mcp", "unknown"} else "unknown"
        if source_id.startswith("core:"):
            return "core"
        if source_id.startswith("mcp:"):
            return "mcp"
        if source_id.startswith("plugin:"):
            return "plugin"
        return "unknown"

    @staticmethod
    def _source_display_name(source_id: str, tool: ToolingToolInfo | None = None) -> str:
        """Return a human-friendly source label."""

        if source_id.startswith("mesh:"):
            return (
                tool.provider_label
                if tool and tool.provider_label
                else (tool.provider_peer_id if tool else source_id.split(":")[1])
            )
        labels = {
            "local:core": "Core tools",
            "local:mcp": "MCP servers",
            "local:plugin": "Plugins",
            "local:unknown": "Unknown local tools",
            "local:blocked": "Blocked tools",
        }
        if source_id.startswith("local:mcp:"):
            return f"MCP server {source_id.rsplit(':', 1)[-1]}"
        if source_id.startswith("local:plugin:"):
            return f"Plugin {source_id.rsplit(':', 1)[-1]}"
        return labels.get(source_id, source_id)

    @staticmethod
    def _source_sort_key(source: ToolingToolSourceSummary) -> tuple[int, str]:
        order = {
            "core": 0,
            "mcp": 1,
            "plugin": 2,
            "mesh_peer": 3,
            "unknown": 4,
            "blocked": 5,
        }
        return (order.get(source.source, 99), source.display_name)

    def _empty_source_summary(
        self,
        source_id: str,
        *,
        tool: ToolingToolInfo | None = None,
        provider: ToolingCatalogProviderInfo | None = None,
    ) -> ToolingToolSourceSummary:
        """Create a source summary seeded from a tool or catalog provider."""

        if tool is not None:
            source = (
                "mesh_peer"
                if tool.source == "mesh_peer" or tool.source_type == "mesh_peer"
                else tool.source
            )
            return ToolingToolSourceSummary(
                source_id=source_id,
                source=source if source in {"core", "plugin", "mcp", "mesh_peer"} else "unknown",
                display_name=self._source_display_name(source_id, tool),
                provider_peer_id=tool.provider_peer_id,
                provider_service_instance_id=tool.provider_service_instance_id,
                provider_label=tool.provider_label,
                provider_kind="mesh_peer" if tool.source_type == "mesh_peer" else "local",
                trust_tier=tool.trust_tier,
                status="blocked" if tool.trust_tier == "blocked" else "active",
                cache_status="hit" if tool.source_type == "mesh_peer" else "local",
            )
        if provider is not None:
            source = "mesh_peer" if provider.provider_kind == "mesh_peer" else "core"
            return ToolingToolSourceSummary(
                source_id=source_id,
                source=source,
                display_name=(
                    provider.provider_label or provider.provider_peer_id
                    if provider.provider_kind == "mesh_peer"
                    else "Core tools"
                ),
                provider_peer_id=provider.provider_peer_id,
                provider_service_instance_id=provider.provider_service_instance_id,
                provider_label=provider.provider_label,
                provider_kind=provider.provider_kind,
                trust_tier="untrusted" if provider.provider_kind == "mesh_peer" else "trusted",
                status="active" if provider.eligible else "blocked",
                cache_status=provider.cache_status,
                shared_by_policy=provider.eligible,
                reason_code=provider.reason_code,
                reason=provider.reason,
            )
        source = source_id.split(":", 2)[1] if source_id.startswith("local:") else source_id
        return ToolingToolSourceSummary(
            source_id=source_id,
            source=source
            if source in {"core", "plugin", "mcp", "unknown", "blocked"}
            else "unknown",
            display_name=self._source_display_name(source_id),
            trust_tier="trusted" if source_id == "local:core" else "untrusted",
            cache_status="local",
        )

    def _source_id_matches_grant(self, source_id: str, grant: ToolingApprovalGrant) -> bool:
        """Return whether a durable grant belongs to a management source id."""

        metadata_source_id = grant.metadata.get("source_id")
        if isinstance(metadata_source_id, str) and metadata_source_id:
            return metadata_source_id == source_id
        if (
            grant.global_tool_id
            and grant.global_tool_id in self._current_known_global_tool_ids_for_source(source_id)
        ):
            # Compatibility for policy grants created before provider/source
            # identity was included in Tooling.UpsertToolPolicyOverride.
            return True

        provider_peer_id = grant.provider_peer_id or "local"
        if source_id.startswith("mesh:"):
            parts = source_id.split(":", 2)
            return len(parts) == 3 and provider_peer_id == parts[1]
        if not self._is_local_provider(provider_peer_id):
            return False
        source = source_id.split(":", 2)[1] if source_id.startswith("local:") else source_id
        if source == "blocked":
            return grant.trust_tier == "blocked" or grant.grant_scope in {
                "deny_once",
                "deny_always",
            }
        if grant.local_tool_name:
            tool = self.tools_manager.get_tool_by_name(grant.local_tool_name)
            if tool is not None:
                return self._tool_source(tool) == source
        return False

    @staticmethod
    def _grant_needs_review(grant: ToolingApprovalGrant) -> bool:
        return bool(grant.metadata.get("needs_review"))

    async def _active_grants_for_read_models(
        self, *, include_revoked: bool = False
    ) -> list[ToolingApprovalGrant]:
        await self._expire_approval_grants()
        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            return []
        where = "" if include_revoked else "WHERE active = 1 AND revoked_at IS NULL"
        rows = await self._db_sql(
            f"SELECT * FROM tooling_approval_grants {where} ORDER BY created_at DESC"
        )
        return [self._grant_from_row(row) for row in rows]

    def _pending_approval_from_record(
        self,
        approval_request_id: str,
        record: dict[str, Any],
        *,
        created_at: float,
    ) -> ToolingPendingApproval:
        """Convert a persisted approval request to a secret-redacted read model."""

        request: ToolingRequestApprovalRequest = record["request"]
        prepared: ToolingPrepareExecutionResponse = record["prepared"]
        expires_at = float(record.get("expires_at") or 0)
        return ToolingPendingApproval(
            approval_request_id=approval_request_id,
            requested_by_principal_id=(
                request.requested_by_principal_id or request.caller_principal_id
            ),
            caller_peer_id=request.caller_peer_id,
            caller_device_id=request.caller_device_id,
            provider_peer_id=prepared.provider_peer_id,
            provider_service_instance_id=prepared.provider_service_instance_id,
            global_tool_id=prepared.global_tool_id,
            local_tool_name=prepared.local_tool_name,
            source=prepared.source,
            source_id=self._source_id_for_prepared(prepared),
            trust_tier=prepared.trust_tier,
            capability_class=prepared.capability_class,
            approval_mode=prepared.policy_decision.approval_mode,
            policy_decision_id=prepared.policy_decision.decision_id,
            correlation_id=prepared.correlation_id,
            args_hash=prepared.args_hash,
            display_args_preview=prepared.display_args_preview,
            resource_selector_hash=prepared.resource_selector_hash,
            created_at=created_at,
            expires_at=expires_at,
            used=bool(record.get("used")),
            expired=expires_at <= time.time(),
        )

    async def _pending_approvals_for_read_models(
        self, request: ToolingListPendingApprovalsRequest | None = None
    ) -> list[ToolingPendingApproval]:
        """Load pending approvals from memory and durable storage."""

        request = request or ToolingListPendingApprovalsRequest()
        approvals: dict[str, ToolingPendingApproval] = {}
        for approval_request_id, record in self._approval_requests.items():
            approvals[approval_request_id] = self._pending_approval_from_record(
                approval_request_id,
                record,
                created_at=float(record.get("created_at") or time.time()),
            )

        await self._ensure_tooling_policy_tables()
        if self._tooling_policy_tables_ready:
            rows = await self._db_sql(
                """
                SELECT * FROM tooling_approval_requests
                ORDER BY created_at DESC
                LIMIT ?
                """,
                [max(1, min(int(request.limit), 500))],
            )
            for row in rows:
                approval_request_id = row["approval_request_id"]
                if approval_request_id in approvals:
                    continue
                record = {
                    "request": ToolingRequestApprovalRequest.model_validate_json(
                        row["request_json"]
                    ),
                    "prepared": ToolingPrepareExecutionResponse.model_validate_json(
                        row["prepared_json"]
                    ),
                    "expires_at": row["expires_at"],
                    "used": bool(row["used"]),
                }
                approvals[approval_request_id] = self._pending_approval_from_record(
                    approval_request_id,
                    record,
                    created_at=float(row.get("created_at") or 0),
                )

        filtered = []
        for approval in approvals.values():
            if not request.include_used and approval.used:
                continue
            if not request.include_expired and approval.expired:
                continue
            if request.principal_id and approval.requested_by_principal_id != request.principal_id:
                continue
            if request.provider_peer_id and approval.provider_peer_id != request.provider_peer_id:
                continue
            if request.global_tool_id and approval.global_tool_id != request.global_tool_id:
                continue
            filtered.append(approval)
        return sorted(filtered, key=lambda item: item.created_at, reverse=True)[
            : max(1, min(int(request.limit), 500))
        ]

    @staticmethod
    def _redact_audit_value(value: Any) -> Any:
        """Redact secret-like values in audit details before returning them to UI."""

        if isinstance(value, dict):
            redacted = {}
            for key, child in value.items():
                if str(key).lower() in _ARG_REDACT_KEYS:
                    redacted[key] = "[redacted]"
                else:
                    redacted[key] = ToolingService._redact_audit_value(child)
            return redacted
        if isinstance(value, list):
            return [ToolingService._redact_audit_value(item) for item in value]
        if isinstance(value, str):
            redacted = value
            for pattern in _ERROR_REDACT_PATTERNS:
                redacted = pattern.sub("[redacted]", redacted)
            return redacted
        return value

    async def _audit_tooling_event(
        self,
        event: str,
        *,
        principal_id: str | None,
        details: dict[str, Any],
    ) -> None:
        """Persist a Tooling policy/approval audit event."""

        try:
            await self.bus.request(
                AuthMethods.STORE_AUDIT_EVENT,
                StoreAuditEventRequest(
                    event=event,
                    principal_id=principal_id,
                    details=json.dumps(details, sort_keys=True, default=str),
                ),
                timeout=TOOLING_AUDIT_REQUEST_TIMEOUT_SECONDS,
                priority=get_system_priority(),
            )
        except Exception as audit_error:
            log_warning(f"Failed to audit {event}: {audit_error}")

    def _operation_class(self, tool: Any, safety_class: str) -> str:
        operation_class = getattr(tool, "operation_class", None)
        if operation_class in {"read", "write", "external", "admin", "hardware", "data-egress"}:
            return operation_class
        if self._is_known_web_search_tool(tool):
            return "external"
        if safety_class == "dangerous":
            return "hardware"
        if safety_class == "sensitive":
            return "data-egress"
        return "read"

    def _risk_class(self, tool: Any, safety_class: str) -> str:
        return self._safe_metadata_value(
            getattr(tool, "risk_class", safety_class),
            {"standard", "sensitive", "dangerous"},
            safety_class,
        )

    @staticmethod
    def _tool_data_egress(tool: Any, operation_class: str) -> bool:
        return bool(getattr(tool, "data_egress", False)) or operation_class == "data-egress"

    @staticmethod
    def _tool_mutating(tool: Any, operation_class: str) -> bool:
        return bool(getattr(tool, "mutating", False)) or operation_class in {
            "write",
            "admin",
            "hardware",
        }

    @staticmethod
    def _tool_external(tool: Any, operation_class: str) -> bool:
        return bool(getattr(tool, "external", False)) or operation_class == "external"

    @staticmethod
    def _tool_admin(tool: Any, operation_class: str) -> bool:
        return bool(getattr(tool, "admin", False)) or operation_class == "admin"

    def _tool_privacy_hints(self, tool: Any, safety_class: str, operation_class: str) -> list[str]:
        raw_hints = getattr(tool, "privacy_hints", None)
        hints: list[str] = []
        if isinstance(raw_hints, (list, tuple, set)):
            hints.extend(str(hint) for hint in raw_hints if hint)
        if safety_class in {"sensitive", "dangerous"}:
            hints.append(f"risk:{safety_class}")
        if self._tool_data_egress(tool, operation_class):
            hints.append("data_egress")
        if self._tool_mutating(tool, operation_class):
            hints.append("mutating")
        if self._tool_external(tool, operation_class):
            hints.append("external")
        if self._tool_admin(tool, operation_class):
            hints.append("admin")
        return sorted(set(hints))

    @staticmethod
    def _tool_rate_limit_hints(tool: Any) -> Any | None:
        hints = getattr(tool, "rate_limit_hints", None)
        if hints is None or isinstance(hints, (dict, ToolingRateLimitHints)):
            return hints
        return None

    async def _load_sharing_policy_from_config(self) -> None:
        """Load the Tooling approval policy from schema-backed config if present."""

        try:
            raw_policy = await self._config.aget(
                "services.tooling.approval_policy",
                default=None,
                config_timeout=20.0,
            )
            if raw_policy is None:
                return
            policy = (
                raw_policy
                if isinstance(raw_policy, ToolingSharingPolicy)
                else ToolingSharingPolicy.model_validate(raw_policy)
            )
            self._sharing_policy = policy
            await self._audit_tooling_event(
                "tooling.policy.loaded",
                principal_id=None,
                details={
                    "default_share": policy.default_share,
                    "default_approval_mode": policy.default_approval_mode,
                    "rule_count": len(policy.rules),
                },
            )
        except Exception as error:
            log_warning(f"Failed to load Tooling approval policy from config: {error}")

    async def _persist_sharing_policy_to_config(self, policy: ToolingSharingPolicy) -> bool:
        """Persist Tooling policy through ConfigService, never direct config file IO."""

        try:
            return await self._config.aupdate_config(
                "services.tooling.approval_policy",
                policy.model_dump(mode="json"),
                timeout=20.0,
            )
        except Exception as error:
            log_warning(f"Failed to persist Tooling approval policy through ConfigService: {error}")
            return False

    async def _migrate_policy_rule_tool_ids(self) -> None:
        """Re-key Config-owned tool rules through the durable alias registry.

        DB reconciliation cannot mutate Config storage transactionally.  Until
        Config confirms persistence, both the legacy and canonical rule remain
        active in memory so a refusal can never fall through to permissive
        defaults.
        """

        scoped_ids: dict[str, set[str]] = {}
        for rule in self._sharing_policy.rules:
            if not isinstance(rule.global_tool_id, str) or not rule.global_tool_id:
                continue
            peer_id = rule.provider_peer_id or self._stable_peer_id
            if not peer_id:
                continue
            scoped_ids.setdefault(peer_id, set()).add(rule.global_tool_id)
        if not scoped_ids:
            return
        resolved: dict[tuple[str, str], str] = {}
        for peer_id, ids in scoped_ids.items():
            result = await self.bus.request(
                DBMethods.RESOLVE_TOOL_IDENTITY_ALIASES,
                DBResolveToolIdentityAliasesRequest(
                    global_tool_ids=sorted(ids), stable_peer_id=peer_id
                ),
                origin="internal",
                timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
                priority=get_system_priority(),
            )
            if not result.ok:
                raise RuntimeError(result.error or "Tooling policy alias resolution failed")
            data = result.data
            peer_resolved = (
                data.get("resolved") if isinstance(data, dict) else getattr(data, "resolved", {})
            )
            if not isinstance(peer_resolved, dict):
                raise RuntimeError("Tooling policy alias resolution returned an invalid response")
            resolved.update(
                {
                    (peer_id, old_id): canonical_id
                    for old_id, canonical_id in peer_resolved.items()
                    if isinstance(old_id, str) and isinstance(canonical_id, str)
                }
            )
        replacements = {
            scoped_old: new for scoped_old, new in resolved.items() if scoped_old[1] != new
        }
        if not replacements:
            return

        def migrated_global_tool_id(rule: ToolingSharingPolicyRule) -> str | None:
            old_id = rule.global_tool_id
            if not isinstance(old_id, str):
                return old_id
            peer_id = rule.provider_peer_id or self._stable_peer_id
            if not peer_id:
                return old_id
            return replacements.get((peer_id, old_id), old_id)

        migrated_rules = [
            rule.model_copy(update={"global_tool_id": migrated_global_tool_id(rule)})
            for rule in self._sharing_policy.rules
        ]
        migrated = self._sharing_policy.model_copy(update={"rules": migrated_rules})
        if await self._persist_sharing_policy_to_config(migrated):
            self._sharing_policy = migrated
            return

        expanded = list(self._sharing_policy.rules)
        existing = {json.dumps(rule.model_dump(mode="json"), sort_keys=True) for rule in expanded}
        for rule in migrated_rules:
            key = json.dumps(rule.model_dump(mode="json"), sort_keys=True)
            if key not in existing:
                expanded.append(rule)
                existing.add(key)
        self._sharing_policy = self._sharing_policy.model_copy(update={"rules": expanded})
        log_warning(
            "Tooling policy ID migration could not persist; legacy and canonical rules "
            "remain active in memory fail-closed"
        )

    async def _migrate_remote_policy_rule_tool_ids(self, provider_peer_id: str) -> None:
        """Re-key Config-owned rules for one committed normalized provider.

        The normalized catalog transaction owns DB-backed aliases and approval
        records, but ConfigService remains the authority for the legacy sharing
        and approval policy.  Resolve only rules explicitly scoped to this peer
        so an equal legacy identifier from another provider cannot be changed.
        If Config persistence fails, retain both selectors in memory; this keeps
        deny/refusal rules effective while the durable migration is retried.
        """

        scoped_ids = {
            rule.global_tool_id
            for rule in self._sharing_policy.rules
            if rule.provider_peer_id == provider_peer_id
            and isinstance(rule.global_tool_id, str)
            and rule.global_tool_id
        }
        if not scoped_ids:
            return
        result = await self.bus.request(
            DBMethods.RESOLVE_TOOLING_REMOTE_TOOL_ALIASES,
            DBResolveToolingRemoteToolAliasesRequest(
                peer_id=provider_peer_id,
                provider_id=provider_peer_id,
                global_tool_ids=sorted(scoped_ids),
            ),
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
            priority=get_system_priority(),
        )
        if not result.ok:
            raise RuntimeError(result.error or "Remote Tooling policy alias resolution failed")
        data = (
            result.data.model_dump(mode="python")
            if result.data is not None and hasattr(result.data, "model_dump")
            else result.data or {}
        )
        canonical_by_requested_id = (
            data.get("canonical_by_requested_id", {}) if isinstance(data, dict) else {}
        )
        if not isinstance(canonical_by_requested_id, dict):
            raise RuntimeError("Remote Tooling policy alias resolution returned invalid data")
        replacements = {
            old_id: canonical_id
            for old_id, canonical_id in canonical_by_requested_id.items()
            if isinstance(old_id, str) and isinstance(canonical_id, str) and old_id != canonical_id
        }
        if not replacements:
            return

        migrated_rules = [
            rule.model_copy(update={"global_tool_id": replacements[rule.global_tool_id]})
            if rule.provider_peer_id == provider_peer_id and rule.global_tool_id in replacements
            else rule
            for rule in self._sharing_policy.rules
        ]
        migrated = self._sharing_policy.model_copy(update={"rules": migrated_rules})
        if await self._persist_sharing_policy_to_config(migrated):
            self._sharing_policy = migrated
            return

        expanded = list(self._sharing_policy.rules)
        existing = {json.dumps(rule.model_dump(mode="json"), sort_keys=True) for rule in expanded}
        for original, rule in zip(self._sharing_policy.rules, migrated_rules, strict=True):
            # A persistence failure must never create a new positive grant in
            # volatile state. Duplicate only explicit refusals under the
            # canonical selector so permissive defaults cannot bypass them.
            if original.share and original.approval_mode != "deny_all":
                continue
            key = json.dumps(rule.model_dump(mode="json"), sort_keys=True)
            if key not in existing:
                expanded.append(rule)
                existing.add(key)
        self._sharing_policy = self._sharing_policy.model_copy(update={"rules": expanded})
        log_warning(
            "Remote Tooling policy ID migration could not persist; legacy and canonical "
            "provider-scoped rules remain active in memory fail-closed"
        )
        raise RuntimeError("Remote Tooling policy alias migration was not persisted")

    async def _migrate_legacy_tool_export_policy(self) -> None:
        """Conservatively split legacy ``share`` into independent DB authority.

        Exact canonical local-tool rules are compiled into the new precedence
        model by evaluating legacy first-match order for every known tool and
        explicitly named peer. Dynamic selectors cannot be represented safely,
        so their presence narrows the migrated export authority to deny-all.
        The legacy policy itself remains untouched and authoritative for
        execution through G012.
        """

        snapshot = await self._tool_export_snapshot(include_rules=True, include_stale=True)
        if snapshot.policy.initialized:
            return

        authority = self._local_export_authority_index()
        tool_names = {
            global_tool_id: str(getattr(tool, "name", "") or "")
            for global_tool_id, (tool, _) in authority.items()
        }
        default_state = "shared" if self._sharing_policy.default_share else "unshared"
        seeds: list[DBToolingExportRuleSeed] = []

        selector_fields = (
            "execution_location",
            "source_type",
            "toolkit_name",
            "safety_class",
            "operation_class",
            "resource_namespace",
            "hardware_target",
            "data_scope",
            "caller_principal_id",
            "caller_device_id",
            "caller_permissions",
            "provider_service_instance_id",
            "route_privacy_class",
        )
        exact_rules: list[tuple[ToolingSharingPolicyRule, str]] = []
        migration_is_representable = True
        for legacy_rule in self._sharing_policy.rules:
            global_tool_id = legacy_rule.global_tool_id
            exact_authority = authority.get(global_tool_id or "")
            provider_is_local = legacy_rule.provider_peer_id in {
                None,
                "",
                "local",
                self._stable_peer_id,
            }
            exact_name_matches = bool(
                exact_authority
                and (
                    legacy_rule.tool_name is None
                    or legacy_rule.tool_name == tool_names.get(global_tool_id or "")
                )
            )
            has_other_selector = any(
                getattr(legacy_rule, field_name) not in (None, [], "")
                for field_name in selector_fields
            )
            if (
                exact_authority is not None
                and exact_authority[1].exportable
                and provider_is_local
                and exact_name_matches
                and not has_other_selector
            ):
                exact_rules.append((legacy_rule, global_tool_id))
            else:
                migration_is_representable = False

        if migration_is_representable:
            rules_by_tool: dict[str, list[ToolingSharingPolicyRule]] = {}
            peer_ids: set[str] = set()
            for legacy_rule, global_tool_id in exact_rules:
                rules_by_tool.setdefault(global_tool_id, []).append(legacy_rule)
                if legacy_rule.caller_peer_id:
                    peer_ids.add(legacy_rule.caller_peer_id)

            compiled: list[tuple[str | None, str, str]] = []
            for global_tool_id, legacy_rules in sorted(rules_by_tool.items()):
                global_match = next(
                    (rule for rule in legacy_rules if rule.caller_peer_id is None),
                    None,
                )
                global_state = (
                    ("shared" if global_match.share else "unshared")
                    if global_match is not None
                    else default_state
                )
                if global_state != default_state:
                    compiled.append((None, global_tool_id, global_state))

                for peer_id in sorted(peer_ids):
                    peer_match = next(
                        (rule for rule in legacy_rules if rule.caller_peer_id in {None, peer_id}),
                        None,
                    )
                    peer_state = (
                        ("shared" if peer_match.share else "unshared")
                        if peer_match is not None
                        else default_state
                    )
                    if peer_state != global_state:
                        compiled.append((peer_id, global_tool_id, peer_state))

            for peer_id, global_tool_id, state in compiled:
                seed_key = json.dumps(
                    [peer_id, global_tool_id, state],
                    separators=(",", ":"),
                )
                seed_digest = hashlib.sha256(seed_key.encode()).hexdigest()[:32]
                seeds.append(
                    DBToolingExportRuleSeed(
                        rule_id=f"legacy_export_{seed_digest}",
                        peer_id=peer_id,
                        scope_type="tool",
                        scope_id=global_tool_id,
                        state=state,
                        actor_principal_id="system:tooling-export-migration",
                        reason="compiled legacy first-match share decision",
                    )
                )
        else:
            # Unknown or dynamic legacy selectors cannot be represented by
            # group/tool precedence without risking an accidental share.
            default_state = "unshared"
            seeds = []

        result = await self._mutate_tool_export_policy(
            DBMutateToolingExportPolicyRequest(
                action="initialize_legacy",
                expected_revision=snapshot.policy.revision,
                state=default_state,
                actor_principal_id="system:tooling-export-migration",
                reason="split legacy Tooling share authority",
                correlation_id="tooling-export-migration-v1",
                migrated_from_legacy=True,
                initial_rules=seeds,
            )
        )
        if not result.ok:
            raise RuntimeError(result.error or "legacy Tooling export migration failed")

    def _toolkit_name(self, tool: Any) -> str | None:
        return (
            getattr(tool, "toolkit_name", None)
            or getattr(tool, "mcp_server_name", None)
            or getattr(tool, "server_name", None)
        )

    def _policy_context(
        self,
        request: ToolingExecuteToolRequest,
        *,
        tool: Any,
        local_tool_name: str,
        global_tool_id: str,
        provider_peer_id: str,
        service_instance_id: str,
    ) -> dict[str, Any]:
        safety_class = self._tool_safety_class(tool)
        execution_location = "local" if self._is_local_provider(provider_peer_id) else "remote"
        raw_source = "mesh_peer" if execution_location == "remote" else self._tool_source(tool)
        source = self._safe_metadata_value(
            raw_source, {"core", "plugin", "mcp", "mesh_peer", "unknown"}, "unknown"
        )
        operation_class = self._operation_class(tool, safety_class)
        resource_selector = request.resource_selector
        mesh_selector = request.mesh_selector
        return {
            "tool_name": local_tool_name,
            "global_tool_id": global_tool_id,
            "execution_location": execution_location,
            "source_type": source,
            "toolkit_name": self._toolkit_name(tool),
            "safety_class": safety_class,
            "operation_class": operation_class,
            "trust_tier": self._tool_trust_tier(tool, source),
            "capability_class": self._capability_class(tool, operation_class),
            "resource_scope": self._resource_scope(tool),
            "resource_namespace": (
                (resource_selector.resource_namespace if resource_selector else None)
                or (mesh_selector.resource_namespace if mesh_selector else None)
            ),
            "hardware_target": (
                (resource_selector.hardware_target if resource_selector else None)
                or (mesh_selector.hardware_target if mesh_selector else None)
            ),
            "data_scope": (
                (resource_selector.data_scope if resource_selector else None)
                or (mesh_selector.data_scope if mesh_selector else None)
            ),
            "caller_peer_id": request.caller_peer_id,
            "caller_principal_id": request.caller_principal_id,
            "caller_device_id": request.caller_device_id,
            "provider_peer_id": provider_peer_id,
            "provider_service_instance_id": service_instance_id,
            "route_privacy_class": getattr(tool, "route_privacy_class", None),
        }

    @staticmethod
    def _policy_rule_matches(rule: ToolingSharingPolicyRule, context: dict[str, Any]) -> bool:
        rule_fields = rule.model_dump(exclude={"share", "approval_mode", "token_ttl_seconds"})
        for field_name, rule_value in rule_fields.items():
            if field_name == "rule_id" or rule_value is None:
                continue
            if context.get(field_name) != rule_value:
                return False
        return True

    def _evaluate_sharing_policy(
        self,
        request: ToolingExecuteToolRequest,
        *,
        tool: Any,
        local_tool_name: str,
        global_tool_id: str,
        provider_peer_id: str,
        service_instance_id: str,
        legacy_share_authoritative: bool = True,
    ) -> ToolingPolicyDecision:
        context = self._policy_context(
            request,
            tool=tool,
            local_tool_name=local_tool_name,
            global_tool_id=global_tool_id,
            provider_peer_id=provider_peer_id,
            service_instance_id=service_instance_id,
        )
        policy = self._sharing_policy
        matched_rule = next(
            (rule for rule in policy.rules if self._policy_rule_matches(rule, context)),
            None,
        )
        share = matched_rule.share if matched_rule else policy.default_share
        if not legacy_share_authoritative:
            share = True
        mode = matched_rule.approval_mode if matched_rule else policy.default_approval_mode
        policy_mode = getattr(policy, "policy_mode", "enforce")
        token_ttl_seconds = (
            matched_rule.token_ttl_seconds if matched_rule else policy.default_token_ttl_seconds
        )
        safety_class = context["safety_class"]
        trust_tier = context["trust_tier"]
        capability_class = context["capability_class"]
        sensitive_capability = capability_class in {
            "write",
            "execute",
            "network",
            "secrets",
            "device",
            "admin",
        }
        requires_tool_approval = self._tool_requires_confirmation(tool, safety_class)
        is_trusted_core_web_search = (
            context["execution_location"] == "local"
            and context["source_type"] == "core"
            and trust_tier == "trusted"
            and capability_class == "network"
            and safety_class == "standard"
            and not requires_tool_approval
            and not getattr(tool, "confirmation_required", False)
            and self._is_known_web_search_tool(tool)
        )
        is_local_safe = (
            context["execution_location"] == "local"
            and trust_tier == "trusted"
            and not sensitive_capability
            and safety_class == "standard"
            and not getattr(tool, "confirmation_required", False)
        )
        approval_required = (
            trust_tier != "trusted"
            or sensitive_capability
            or requires_tool_approval
            or bool(
                matched_rule
                and mode
                in {
                    "ask_each_time",
                    "allow_once",
                    "allow_until_expiry",
                    "dry_run_only",
                    "deny_all",
                }
            )
        )
        allowed = share and mode != "deny_all" and policy_mode != "deny_all"
        reason = None

        if trust_tier == "blocked":
            allowed = False
            approval_required = False
            reason = "tool_blocked"
        elif policy_mode == "deny_all":
            reason = "policy_denied"
        elif not share:
            allowed = False
            reason = "tool_not_shared"
        elif mode == "deny_all":
            reason = "policy_denied"
        elif (mode == "dry_run_only" or policy_mode == "dry_run_only") and not request.dry_run:
            allowed = False
            reason = "dry_run_only"
        elif policy_mode == "unrestricted_except_blocked":
            approval_required = False
            reason = "unrestricted_except_blocked"
        elif mode == "approve_all_for_peer" and not request.caller_peer_id:
            allowed = False
            reason = "peer_required_for_approve_all"
        elif mode == "approve_all_local_safe":
            if is_local_safe or is_trusted_core_web_search:
                approval_required = False
            elif trust_tier != "trusted" or sensitive_capability or requires_tool_approval:
                approval_required = True
            else:
                approval_required = False

        if request.dry_run and trust_tier != "blocked" and share and mode != "deny_all":
            allowed = True
            reason = None

        if mode in {"approve_all_for_session", "approve_all_for_peer"} and allowed:
            approval_required = False

        auto_approved_reason = None
        if allowed and not approval_required and not request.dry_run:
            if policy_mode == "unrestricted_except_blocked":
                auto_approved_reason = "bypass_permissions"
            elif mode == "approve_all_local_safe" and is_trusted_core_web_search:
                auto_approved_reason = "trusted_core_web_search"
            elif mode == "approve_all_local_safe" and is_local_safe:
                auto_approved_reason = "local_safe_tool"
            elif mode == "approve_all_for_session":
                auto_approved_reason = "session_policy"
            elif mode == "approve_all_for_peer":
                auto_approved_reason = "peer_policy"
            else:
                auto_approved_reason = "policy_allows_without_approval"
        if allowed and approval_required and reason is None:
            if trust_tier != "trusted":
                reason = "approval_required_by_untrusted_source"
            elif matched_rule and mode in {
                "ask_each_time",
                "allow_once",
                "allow_until_expiry",
                "dry_run_only",
            }:
                reason = "approval_required_by_policy"
            elif sensitive_capability:
                reason = "approval_required_by_capability"
            else:
                reason = (
                    "approval_required_by_tool"
                    if requires_tool_approval
                    else "approval_required_by_policy"
                )

        return ToolingPolicyDecision(
            allowed=allowed,
            share=share,
            approval_required=approval_required,
            approval_mode=mode,
            decision_id=uuid.uuid4().hex,
            policy_rule_id=matched_rule.rule_id if matched_rule else None,
            reason=reason,
            auto_approved_reason=auto_approved_reason,
            effective_default=policy.default_approval_mode,
            token_ttl_seconds=token_ttl_seconds,
        )

    def _prepared_execution(
        self,
        request: ToolingExecuteToolRequest,
        *,
        tool: Any,
        local_tool_name: str,
        provider_peer_id: str,
        service_instance_id: str,
        global_tool_id: str,
        legacy_share_authoritative: bool = True,
    ) -> ToolingPrepareExecutionResponse:
        if not request.correlation_id:
            request.correlation_id = uuid.uuid4().hex
        argument_visibility = self._argument_visibility(tool)
        display_args_preview = self._display_arguments_preview(
            request.arguments, argument_visibility
        )
        execution_location = "local" if self._is_local_provider(provider_peer_id) else "remote"
        raw_source = "mesh_peer" if execution_location == "remote" else self._tool_source(tool)
        source = self._safe_metadata_value(
            raw_source, {"core", "plugin", "mcp", "mesh_peer", "unknown"}, "unknown"
        )
        source_id = (
            f"mesh:{provider_peer_id}:{self._safe_identifier(service_instance_id)}"
            if not self._is_local_provider(provider_peer_id)
            else self._local_source_instance_id(tool, source)
        )
        safety_class = self._tool_safety_class(tool)
        operation_class = self._operation_class(tool, safety_class)
        trust_tier = self._tool_trust_tier(tool, source)
        capability_class = self._capability_class(tool, operation_class)
        resource_scope = self._resource_scope(tool)
        args_schema_hash = self._tool_args_schema_hash(tool)
        schema_payload = self._tool_args_schema_payload(tool)
        validation_error = (
            (
                "schema_unavailable"
                if type(request) is ToolingPrepareExecutionRequest and not schema_payload
                else None
            )
            or self._validate_expected_schema_hash(tool, request.expected_args_schema_hash)
            or self._validate_tool_arguments(tool, request.arguments)
        )
        if validation_error:
            decision = ToolingPolicyDecision(
                allowed=False,
                share=False,
                approval_required=False,
                approval_mode=self._sharing_policy.default_approval_mode,
                decision_id=uuid.uuid4().hex,
                reason=validation_error,
            )
            return ToolingPrepareExecutionResponse(
                ok=False,
                policy_decision=decision,
                args_hash=self._arguments_fingerprint(request.arguments),
                resource_selector_hash=self._resource_selector_fingerprint(request),
                route_decision_id=self._route_decision_id(
                    request,
                    provider_peer_id=provider_peer_id,
                    service_instance_id=service_instance_id,
                ),
                correlation_id=request.correlation_id,
                provider_peer_id=provider_peer_id,
                provider_service_instance_id=service_instance_id,
                global_tool_id=global_tool_id,
                local_tool_name=local_tool_name,
                args_schema_hash=args_schema_hash,
                source=source,
                source_id=source_id,
                trust_tier=trust_tier,
                capability_class=capability_class,
                resource_scope=resource_scope,
                display_args_preview=display_args_preview,
                argument_visibility=argument_visibility,
                secrets_redacted=True,
            )
        decision = self._evaluate_sharing_policy(
            request,
            tool=tool,
            local_tool_name=local_tool_name,
            global_tool_id=global_tool_id,
            provider_peer_id=provider_peer_id,
            service_instance_id=service_instance_id,
            legacy_share_authoritative=legacy_share_authoritative,
        )
        return ToolingPrepareExecutionResponse(
            ok=decision.allowed,
            policy_decision=decision,
            args_hash=self._arguments_fingerprint(request.arguments),
            resource_selector_hash=self._resource_selector_fingerprint(request),
            route_decision_id=self._route_decision_id(
                request,
                provider_peer_id=provider_peer_id,
                service_instance_id=service_instance_id,
            ),
            correlation_id=request.correlation_id,
            provider_peer_id=provider_peer_id,
            provider_service_instance_id=service_instance_id,
            global_tool_id=global_tool_id,
            local_tool_name=local_tool_name,
            args_schema_hash=args_schema_hash,
            source=source,
            source_id=source_id,
            trust_tier=trust_tier,
            capability_class=capability_class,
            resource_scope=resource_scope,
            display_args_preview=display_args_preview,
            argument_visibility=argument_visibility,
            secrets_redacted=True,
        )

    def _validate_tool_arguments(self, tool: Any, arguments: dict[str, Any]) -> str | None:
        """Validate user-supplied tool arguments against the tool args schema.

        Runtime-injected arguments (`bus`, `store`) are intentionally ignored here
        because Tooling adds them at execution time.
        """
        args_schema = getattr(tool, "args_schema", None)
        if not args_schema:
            return None

        safe_args = {
            key: value for key, value in (arguments or {}).items() if key not in {"bus", "store"}
        }
        try:
            if hasattr(args_schema, "model_validate"):
                args_schema.model_validate(safe_args)
                return None
            if callable(args_schema):
                args_schema(**safe_args)
                return None
        except Exception as error:
            return f"invalid_arguments: {error}"

        schema_dict = args_schema if isinstance(args_schema, dict) else None
        if not schema_dict:
            return None

        try:
            validator = Draft202012Validator(schema_dict)
            errors = sorted(validator.iter_errors(safe_args), key=lambda error: list(error.path))
        except jsonschema_exceptions.SchemaError as error:
            return f"invalid_tool_schema: {error.message}"
        except Exception as error:
            return f"invalid_arguments: {error}"
        if errors:
            error = errors[0]
            path = ".".join(str(part) for part in error.path)
            location = path or "arguments"
            return f"invalid_arguments: {location}: {error.message}"
        return None

    def _tool_args_schema_payload(self, tool: Any) -> dict[str, Any] | None:
        """Return a stable JSON-schema-like payload for a tool args schema."""

        args_schema = getattr(tool, "args_schema", None)
        if not args_schema:
            return None
        if isinstance(args_schema, dict):
            return args_schema
        schema_method = getattr(args_schema, "model_json_schema", None)
        if callable(schema_method):
            try:
                return schema_method()
            except Exception:
                return None
        schema_method = getattr(args_schema, "schema", None)
        if callable(schema_method):
            try:
                return schema_method()
            except Exception:
                return None
        return None

    def _tool_args_schema_hash(self, tool: Any) -> str | None:
        """Hash the current tool argument schema for schedule-time drift checks."""

        payload = self._tool_args_schema_payload(tool)
        if not payload:
            return None
        try:
            return hashlib.sha256(
                json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()
        except Exception:
            return None

    def _validate_expected_schema_hash(self, tool: Any, expected_hash: str | None) -> str | None:
        """Ensure callers using cached schema metadata are not scheduling stale args."""

        if not expected_hash:
            return None
        current_hash = self._tool_args_schema_hash(tool)
        if not current_hash:
            return "schema_unavailable"
        if current_hash != expected_hash:
            return "schema_hash_mismatch"
        return None

    @staticmethod
    def _json_schema_value_matches_type(value: Any, expected: Any) -> bool:
        """Small JSON Schema type checker for Tooling prepare-time validation."""

        expected_types = expected if isinstance(expected, list) else [expected]
        for schema_type in expected_types:
            if schema_type == "string" and isinstance(value, str):
                return True
            if schema_type == "integer" and isinstance(value, int) and not isinstance(value, bool):
                return True
            if (
                schema_type == "number"
                and isinstance(value, int | float)
                and not isinstance(value, bool)
            ):
                return True
            if schema_type == "boolean" and isinstance(value, bool):
                return True
            if schema_type == "object" and isinstance(value, dict):
                return True
            if schema_type == "array" and isinstance(value, list):
                return True
            if schema_type == "null" and value is None:
                return True
        return False

    async def _resolve_execution_context(
        self, request: ToolingExecuteToolRequest
    ) -> tuple[Any | None, str, str, str, str]:
        local_tool_name = await self._resolve_tool_name(request)
        provider_peer_id, service_instance_id, _, _ = self._provider_context(request)
        tool = self.tools_manager.get_tool_by_name(local_tool_name)
        identity_payload = (
            self._tool_identity_payload(
                tool,
                provider_peer_id=provider_peer_id,
                service_instance_id=service_instance_id,
                local_name=local_tool_name,
                is_remote=provider_peer_id != (self._stable_peer_id or "local"),
            )
            if tool is not None
            else None
        )
        global_tool_id = (
            str(identity_payload["global_tool_id"])
            if identity_payload is not None
            else self._global_tool_id(provider_peer_id, service_instance_id, local_tool_name)
        )
        return tool, local_tool_name, provider_peer_id, service_instance_id, global_tool_id

    def _approval_token_claims(
        self,
        request: ToolingExecuteToolRequest,
        *,
        prepared: ToolingPrepareExecutionResponse,
        approver_principal_id: str,
    ) -> dict[str, Any]:
        return {
            "caller_principal_id": request.caller_principal_id,
            "caller_peer_id": request.caller_peer_id,
            "caller_device_id": request.caller_device_id,
            "provider_peer_id": prepared.provider_peer_id,
            "provider_service_instance_id": prepared.provider_service_instance_id,
            "tool_name": prepared.local_tool_name,
            "global_tool_id": prepared.global_tool_id,
            "args_hash": prepared.args_hash,
            "resource_selector_hash": prepared.resource_selector_hash,
            "route_decision_id": prepared.route_decision_id,
            "schedule_id": request.schedule_id,
            "scheduled_action_hash": request.scheduled_action_hash,
            "expires_at": time.time() + prepared.policy_decision.token_ttl_seconds,
            "nonce": uuid.uuid4().hex,
            "approver_principal_id": approver_principal_id,
            "policy_decision_id": prepared.policy_decision.decision_id,
            "approval_mode": prepared.policy_decision.approval_mode,
            "used": False,
        }

    @staticmethod
    def _approval_token_hash(token: str) -> str:
        """Return the durable lookup hash for a short-lived approval token."""

        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    async def _persist_approval_token(self, token: str, claims: dict[str, Any]) -> None:
        """Persist a replay-protected approval token without storing the raw token."""

        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            return
        await self._db_sql(
            """
            INSERT OR REPLACE INTO tooling_approval_tokens
            (token_hash, claims_json, expires_at, used, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                self._approval_token_hash(token),
                json.dumps(claims, sort_keys=True, default=str),
                float(claims.get("expires_at") or 0),
                int(bool(claims.get("used"))),
                time.time(),
            ],
        )

    async def _load_approval_token(self, token: str) -> dict[str, Any] | None:
        """Load an approval token from memory or durable storage."""

        claims = self._approval_tokens.get(token)
        if claims is not None:
            return claims
        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            return None
        rows = await self._db_sql(
            "SELECT claims_json, expires_at, used FROM tooling_approval_tokens WHERE token_hash = ?",
            [self._approval_token_hash(token)],
        )
        if not rows:
            return None
        row = rows[0]
        claims = json.loads(row["claims_json"])
        claims["expires_at"] = float(row.get("expires_at") or claims.get("expires_at") or 0)
        claims["used"] = bool(row.get("used"))
        self._approval_tokens[token] = claims
        return claims

    async def _mark_approval_token_used(self, token: str, claims: dict[str, Any]) -> None:
        """Mark a short-lived approval token as consumed in memory and durable storage."""

        claims["used"] = True
        await self._ensure_tooling_policy_tables()
        if self._tooling_policy_tables_ready:
            await self._db_sql(
                "UPDATE tooling_approval_tokens SET used = 1 WHERE token_hash = ?",
                [self._approval_token_hash(token)],
            )

    async def _validate_approval_token(
        self,
        request: ToolingExecuteToolRequest,
        *,
        prepared: ToolingPrepareExecutionResponse,
    ) -> tuple[bool, str | None]:
        token = request.approval_token
        if not token:
            return False, "approval_token_required"
        claims = await self._load_approval_token(token)
        if not claims:
            return False, "approval_token_invalid"
        if claims.get("used"):
            return False, "approval_token_replayed"
        if float(claims.get("expires_at", 0)) <= time.time():
            return False, "approval_token_expired"

        expected = {
            "caller_principal_id": request.caller_principal_id,
            "caller_peer_id": request.caller_peer_id,
            "caller_device_id": request.caller_device_id,
            "provider_peer_id": prepared.provider_peer_id,
            "provider_service_instance_id": prepared.provider_service_instance_id,
            "tool_name": prepared.local_tool_name,
            "global_tool_id": prepared.global_tool_id,
            "args_hash": prepared.args_hash,
            "resource_selector_hash": prepared.resource_selector_hash,
            "route_decision_id": prepared.route_decision_id,
            "schedule_id": request.schedule_id,
            "scheduled_action_hash": request.scheduled_action_hash,
        }
        for field_name, expected_value in expected.items():
            if claims.get(field_name) != expected_value:
                return False, f"approval_token_{field_name}_mismatch"
        await self._mark_approval_token_used(token, claims)
        return True, None

    @staticmethod
    def _grant_from_row(row: dict[str, Any]) -> ToolingApprovalGrant:
        metadata_raw = row.get("metadata_json") or "{}"
        scope_raw = row.get("resource_scope") or "[]"
        return ToolingApprovalGrant(
            grant_id=row["grant_id"],
            grant_scope=row["grant_scope"],
            grant_type=row.get("grant_type") or "approval",
            active=bool(row.get("active", 1)) and not row.get("revoked_at"),
            principal_id=row.get("principal_id"),
            caller_device_id=row.get("caller_device_id"),
            caller_peer_id=row.get("caller_peer_id"),
            provider_peer_id=row.get("provider_peer_id"),
            provider_service_instance_id=row.get("provider_service_instance_id"),
            global_tool_id=row.get("global_tool_id"),
            local_tool_name=row.get("local_tool_name"),
            args_hash=row.get("args_hash"),
            resource_selector_hash=row.get("resource_selector_hash"),
            route_decision_id=row.get("route_decision_id"),
            schedule_id=row.get("schedule_id"),
            trust_tier=row.get("trust_tier"),
            capability_class=row.get("capability_class"),
            resource_scope=json.loads(scope_raw),
            include_future_tools=bool(row.get("include_future_tools", 0)),
            created_by=row.get("created_by"),
            created_at=float(row.get("created_at") or 0),
            expires_at=row.get("expires_at"),
            revoked_at=row.get("revoked_at"),
            reason=row.get("reason"),
            metadata=json.loads(metadata_raw),
        )

    def _grant_matches_prepared(
        self,
        grant: ToolingApprovalGrant,
        request: ToolingExecuteToolRequest,
        prepared: ToolingPrepareExecutionResponse,
        *,
        allow_blocked: bool = False,
    ) -> bool:
        if not grant.active:
            return False
        if grant.expires_at is not None and float(grant.expires_at) <= time.time():
            return False
        if grant.metadata.get("needs_review"):
            return False
        if (
            not self._mesh_projection_enforcement_active
            and not self._remote_catalog_shared_by_policy(
                prepared.provider_peer_id, prepared.provider_service_instance_id
            )
        ):
            return False
        source_id = grant.metadata.get("source_id")
        if (
            isinstance(source_id, str)
            and source_id
            and source_id != self._source_id_for_prepared(prepared)
        ):
            return False
        source_type = grant.metadata.get("source_type")
        if isinstance(source_type, str) and source_type and source_type != prepared.source:
            return False
        if (
            not grant.include_future_tools
            and grant.global_tool_id is None
            and grant.local_tool_name is None
        ):
            reviewed_ids = grant.metadata.get("reviewed_global_tool_ids")
            if not isinstance(reviewed_ids, list) or prepared.global_tool_id not in reviewed_ids:
                return False
        comparisons = {
            "principal_id": request.caller_principal_id,
            "caller_device_id": request.caller_device_id,
            "caller_peer_id": request.caller_peer_id,
            "provider_peer_id": prepared.provider_peer_id,
            "provider_service_instance_id": prepared.provider_service_instance_id,
            "global_tool_id": prepared.global_tool_id,
            "local_tool_name": prepared.local_tool_name,
            "args_hash": prepared.args_hash,
            "resource_selector_hash": prepared.resource_selector_hash,
            "route_decision_id": prepared.route_decision_id,
            "schedule_id": request.schedule_id,
        }
        for field_name, expected in comparisons.items():
            grant_value = getattr(grant, field_name)
            if grant_value is not None and grant_value != expected:
                return False
        scheduled_action_hash = grant.metadata.get("scheduled_action_hash")
        if (
            scheduled_action_hash is not None
            and scheduled_action_hash != request.scheduled_action_hash
        ):
            return False
        if grant.trust_tier == "blocked" and not allow_blocked:
            return False
        if grant.grant_type == "trust" and grant.trust_tier not in {"blocked", "trusted"}:
            return False
        if (
            grant.capability_class is not None
            and grant.capability_class != prepared.capability_class
        ):
            return False
        return self._request_resources_within_grant_scope(request, grant)

    async def _consume_deny_once_grant(
        self,
        grant: ToolingApprovalGrant,
        *,
        principal_id: str | None,
        correlation_id: str | None,
    ) -> None:
        """Consume a one-shot deny grant after it blocks exactly one matching call."""

        if grant.grant_scope != "deny_once":
            return
        await self._ensure_tooling_policy_tables()
        if self._tooling_policy_tables_ready:
            await self._db_sql(
                """
                UPDATE tooling_approval_grants
                SET active = 0, revoked_at = ?, reason = COALESCE(reason, ?)
                WHERE grant_id = ?
                """,
                [time.time(), "deny_once_consumed", grant.grant_id],
            )
        grant.active = False
        grant.revoked_at = time.time()
        await self._audit_tooling_event(
            "tooling.approval.deny_once_consumed",
            principal_id=principal_id,
            details={"grant_id": grant.grant_id, "correlation_id": correlation_id},
        )

    async def _find_matching_grant(
        self,
        request: ToolingExecuteToolRequest,
        prepared: ToolingPrepareExecutionResponse,
    ) -> ToolingApprovalGrant | None:
        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            return None
        rows = await self._db_sql(
            """
            SELECT * FROM tooling_approval_grants
            WHERE active = 1
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)
              AND grant_scope IN ('session', 'until_expiry', 'always', 'scheduled_execution')
              AND (global_tool_id IS NULL OR global_tool_id = ?)
              AND (local_tool_name IS NULL OR local_tool_name = ?)
              AND (provider_peer_id IS NULL OR provider_peer_id = ?)
            ORDER BY created_at DESC
            """,
            [
                time.time(),
                prepared.global_tool_id,
                prepared.local_tool_name,
                prepared.provider_peer_id,
            ],
        )
        for row in rows:
            grant = self._grant_from_row(row)
            if self._grant_matches_prepared(grant, request, prepared):
                return grant
        return None

    async def _find_matching_policy_grant(
        self,
        request: ToolingExecuteToolRequest,
        prepared: ToolingPrepareExecutionResponse,
    ) -> ToolingApprovalGrant | None:
        """Resolve tool override -> source policy, including untrusted policies."""

        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            return None
        rows = await self._db_sql(
            """
            SELECT * FROM tooling_approval_grants
            WHERE active = 1
              AND revoked_at IS NULL
              AND grant_type = 'trust'
              AND (expires_at IS NULL OR expires_at > ?)
              AND (global_tool_id IS NULL OR global_tool_id = ?)
              AND (local_tool_name IS NULL OR local_tool_name = ?)
              AND (provider_peer_id IS NULL OR provider_peer_id = ?)
            ORDER BY created_at DESC
            """,
            [
                time.time(),
                prepared.global_tool_id,
                prepared.local_tool_name,
                prepared.provider_peer_id,
            ],
        )
        matching: list[ToolingApprovalGrant] = []
        for row in rows:
            grant = self._grant_from_row(row)
            if grant.metadata.get("policy_scope") not in {"tool", "source"}:
                continue
            matchable = grant.model_copy(
                update={
                    # Policy authorship is audit metadata, not a caller scope.
                    "principal_id": None,
                    "trust_tier": (
                        grant.trust_tier
                        if grant.trust_tier in {"trusted", "blocked"}
                        else "trusted"
                    ),
                }
            )
            if self._grant_matches_prepared(matchable, request, prepared, allow_blocked=True):
                matching.append(grant)
        return next(
            (grant for grant in matching if grant.metadata.get("policy_scope") == "tool"),
            next(
                (grant for grant in matching if grant.metadata.get("policy_scope") == "source"),
                None,
            ),
        )

    async def _find_matching_blocking_grant(
        self,
        request: ToolingExecuteToolRequest,
        prepared: ToolingPrepareExecutionResponse,
    ) -> ToolingApprovalGrant | None:
        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            return None
        rows = await self._db_sql(
            """
            SELECT * FROM tooling_approval_grants
            WHERE active = 1
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)
              AND (grant_scope IN ('deny_once', 'deny_always') OR trust_tier = 'blocked')
              AND (global_tool_id IS NULL OR global_tool_id = ?)
              AND (local_tool_name IS NULL OR local_tool_name = ?)
              AND (provider_peer_id IS NULL OR provider_peer_id = ?)
            ORDER BY created_at DESC
            """,
            [
                time.time(),
                prepared.global_tool_id,
                prepared.local_tool_name,
                prepared.provider_peer_id,
            ],
        )
        for row in rows:
            grant = self._grant_from_row(row)
            if self._grant_matches_prepared(grant, request, prepared, allow_blocked=True):
                return grant
        return None

    async def _persist_approval_request(
        self,
        approval_request_id: str,
        request: ToolingRequestApprovalRequest,
        prepared: ToolingPrepareExecutionResponse,
        expires_at: float,
    ) -> None:
        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            return
        await self._db_sql(
            """
            INSERT OR REPLACE INTO tooling_approval_requests
            (approval_request_id, request_json, prepared_json, expires_at, used, created_at)
            VALUES (?, ?, ?, ?, 0, ?)
            """,
            [
                approval_request_id,
                request.model_dump_json(),
                prepared.model_dump_json(),
                expires_at,
                time.time(),
            ],
        )

    async def _load_approval_request(self, approval_request_id: str) -> dict[str, Any] | None:
        pending = self._approval_requests.get(approval_request_id)
        if pending:
            return pending
        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            return None
        rows = await self._db_sql(
            "SELECT * FROM tooling_approval_requests WHERE approval_request_id = ?",
            [approval_request_id],
        )
        if not rows:
            return None
        row = rows[0]
        pending = {
            "request": ToolingRequestApprovalRequest.model_validate_json(row["request_json"]),
            "prepared": ToolingPrepareExecutionResponse.model_validate_json(row["prepared_json"]),
            "expires_at": row["expires_at"],
            "used": bool(row["used"]),
        }
        self._approval_requests[approval_request_id] = pending
        return pending

    async def _mark_approval_request_used(self, approval_request_id: str) -> None:
        await self._ensure_tooling_policy_tables()
        if self._tooling_policy_tables_ready:
            await self._db_sql(
                "UPDATE tooling_approval_requests SET used = 1 WHERE approval_request_id = ?",
                [approval_request_id],
            )

    async def _create_grant_from_request(
        self,
        request: ToolingCreateApprovalGrantRequest,
    ) -> ToolingApprovalGrant:
        await self._ensure_tooling_policy_tables()
        metadata = dict(request.metadata or {})
        if (
            not request.include_future_tools
            and request.global_tool_id is None
            and request.local_tool_name is None
        ):
            source_id = metadata.get("source_id")
            reviewed_ids = (
                self._current_known_global_tool_ids_for_source(source_id)
                if isinstance(source_id, str) and source_id
                else self._current_known_global_tool_ids(
                    request.provider_peer_id,
                    request.provider_service_instance_id,
                )
            )
            metadata.setdefault("reviewed_global_tool_ids", reviewed_ids)
            metadata.setdefault("review_scope", "current_catalog_snapshot")
        grant = ToolingApprovalGrant(
            grant_id=uuid.uuid4().hex,
            grant_scope=request.grant_scope,
            grant_type=request.grant_type,
            active=True,
            principal_id=request.principal_id,
            caller_device_id=request.caller_device_id,
            caller_peer_id=request.caller_peer_id,
            provider_peer_id=request.provider_peer_id,
            provider_service_instance_id=request.provider_service_instance_id,
            global_tool_id=request.global_tool_id,
            local_tool_name=request.local_tool_name,
            args_hash=request.args_hash,
            resource_selector_hash=request.resource_selector_hash,
            route_decision_id=request.route_decision_id,
            schedule_id=request.schedule_id,
            trust_tier=request.trust_tier,
            capability_class=request.capability_class,
            resource_scope=request.resource_scope,
            include_future_tools=request.include_future_tools,
            created_by=request.created_by,
            created_at=time.time(),
            expires_at=request.expires_at,
            reason=request.reason,
            metadata=metadata,
        )
        if not self._tooling_policy_tables_ready:
            raise RuntimeError("tooling_policy_storage_unavailable")
        await self._db_sql(
            """
            INSERT INTO tooling_approval_grants (
                grant_id, grant_scope, grant_type, active, principal_id, caller_device_id,
                caller_peer_id, provider_peer_id, provider_service_instance_id, global_tool_id,
                local_tool_name, args_hash, resource_selector_hash, route_decision_id,
                schedule_id, trust_tier, capability_class, resource_scope, include_future_tools,
                created_by, created_at, expires_at, revoked_at, reason, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                grant.grant_id,
                grant.grant_scope,
                grant.grant_type,
                1,
                grant.principal_id,
                grant.caller_device_id,
                grant.caller_peer_id,
                grant.provider_peer_id,
                grant.provider_service_instance_id,
                grant.global_tool_id,
                grant.local_tool_name,
                grant.args_hash,
                grant.resource_selector_hash,
                grant.route_decision_id,
                grant.schedule_id,
                grant.trust_tier,
                grant.capability_class,
                json.dumps(grant.resource_scope),
                int(grant.include_future_tools),
                grant.created_by,
                grant.created_at,
                grant.expires_at,
                grant.revoked_at,
                grant.reason,
                json.dumps(grant.metadata, sort_keys=True, default=str),
            ],
        )
        return grant

    async def _audit_tool_execution(
        self,
        request: ToolingExecuteToolRequest,
        *,
        local_tool_name: str,
        global_tool_id: str,
        provider_peer_id: str,
        safety_class: str,
        status: str,
        error_code: str | None = None,
        denial_reason: str | None = None,
        policy_decision: ToolingPolicyDecision | None = None,
    ) -> None:
        """Persist an audit event for a Tooling execution attempt."""

        details = {
            "caller_peer_id": request.caller_peer_id,
            "caller_principal_id": request.caller_principal_id,
            "target_peer_id": self._selector_target_peer(request) or provider_peer_id,
            "provider_peer_id": provider_peer_id,
            "tool_name": request.tool_name,
            "local_tool_name": local_tool_name,
            "global_tool_id": global_tool_id,
            "resource_selector": (
                request.resource_selector.model_dump(mode="json", exclude_none=True)
                if request.resource_selector
                else None
            ),
            "mesh_selector": (
                request.mesh_selector.model_dump(mode="json", exclude_none=True)
                if request.mesh_selector
                else None
            ),
            "argument_hash": self._arguments_fingerprint(request.arguments),
            "safety_class": safety_class,
            "confirmed": request.confirmed,
            "approval_token_present": bool(request.approval_token),
            "policy_decision_id": policy_decision.decision_id if policy_decision else None,
            "approval_mode": policy_decision.approval_mode if policy_decision else None,
            "policy_reason": policy_decision.reason if policy_decision else None,
            "auto_approved_reason": (
                policy_decision.auto_approved_reason if policy_decision else None
            ),
            "dry_run": request.dry_run,
            "status": status,
            "error_code": error_code,
            "denial_reason": denial_reason,
            "correlation_id": request.correlation_id,
        }

        try:
            await self.bus.request(
                AuthMethods.STORE_AUDIT_EVENT,
                StoreAuditEventRequest(
                    event="tooling.execute",
                    principal_id=request.caller_principal_id,
                    details=json.dumps(details, sort_keys=True, default=str),
                ),
                timeout=TOOLING_AUDIT_REQUEST_TIMEOUT_SECONDS,
                priority=get_system_priority(),
            )
        except Exception as audit_error:
            log_warning(f"Failed to audit tool execution: {audit_error}")

    async def _deny_tool_execution(
        self,
        request: ToolingExecuteToolRequest,
        *,
        local_tool_name: str,
        global_tool_id: str,
        provider_peer_id: str,
        safety_class: str,
        error_code: str,
        message: str,
        policy_decision: ToolingPolicyDecision | None = None,
    ) -> ToolingExecuteToolResponse:
        log_context = self._execution_log_context(
            request,
            local_tool_name=local_tool_name,
            global_tool_id=global_tool_id,
            provider_peer_id=provider_peer_id,
            status="denied",
            error_code=error_code,
        )
        log_debug(f"Tool execution denied: {log_context}")
        await self._audit_tool_execution(
            request,
            local_tool_name=local_tool_name,
            global_tool_id=global_tool_id,
            provider_peer_id=provider_peer_id,
            safety_class=safety_class,
            status="denied",
            error_code=error_code,
            denial_reason=message,
            policy_decision=policy_decision,
        )
        return ToolingExecuteToolResponse(
            ok=False,
            data=None,
            error=message,
            status="denied",
            error_code=error_code,
            correlation_id=request.correlation_id,
            provider_peer_id=provider_peer_id,
            global_tool_id=global_tool_id,
            policy_decision_id=policy_decision.decision_id if policy_decision else None,
            display_args_preview=self._display_arguments_preview(request.arguments),
            args_hash=self._arguments_fingerprint(request.arguments),
        )

    async def _enforce_execution_policy(
        self,
        request: ToolingExecuteToolRequest,
        *,
        tool: Any,
        local_tool_name: str,
        global_tool_id: str,
        provider_peer_id: str,
        service_instance_id: str,
        envelope: Any | None = None,
    ) -> ToolingExecuteToolResponse | None:
        """Return a denial response when execution policy blocks the request."""

        safety_class = self._tool_safety_class(tool)
        prepared = self._prepared_execution(
            request,
            tool=tool,
            local_tool_name=local_tool_name,
            provider_peer_id=provider_peer_id,
            service_instance_id=service_instance_id,
            global_tool_id=global_tool_id,
            legacy_share_authoritative=not bool(
                self._mesh_projection_enforcement_active
                and getattr(envelope, "caller_peer_id", None)
            ),
        )
        decision = prepared.policy_decision
        blocking_grant = await self._find_matching_blocking_grant(request, prepared)
        if blocking_grant:
            decision.allowed = False
            decision.approval_required = False
            decision.grant_id = blocking_grant.grant_id
            decision.grant_scope = blocking_grant.grant_scope
            decision.reason = "tool_blocked"
            await self._audit_tooling_event(
                "tooling.approval.blocking_grant_applied",
                principal_id=request.caller_principal_id,
                details={
                    "correlation_id": request.correlation_id,
                    "decision_id": decision.decision_id,
                    "grant_id": blocking_grant.grant_id,
                    "global_tool_id": global_tool_id,
                    "provider_peer_id": provider_peer_id,
                },
            )
            await self._consume_deny_once_grant(
                blocking_grant,
                principal_id=request.caller_principal_id,
                correlation_id=request.correlation_id,
            )

        if not decision.allowed:
            return await self._deny_tool_execution(
                request,
                local_tool_name=local_tool_name,
                global_tool_id=global_tool_id,
                provider_peer_id=provider_peer_id,
                safety_class=safety_class,
                error_code=decision.reason or "policy_denied",
                message=decision.reason or "Tool execution denied by sharing policy",
                policy_decision=decision,
            )

        if safety_class in {"sensitive", "dangerous"} and not self._request_has_resource_selector(
            request
        ):
            return await self._deny_tool_execution(
                request,
                local_tool_name=local_tool_name,
                global_tool_id=global_tool_id,
                provider_peer_id=provider_peer_id,
                safety_class=safety_class,
                error_code="resource_selector_required",
                message=(
                    f"Remote {safety_class} tool '{local_tool_name}' requires an "
                    "explicit resource selector"
                ),
                policy_decision=decision,
            )

        if request.dry_run:
            return None

        if decision.approval_required:
            matching_grant = await self._find_matching_grant(request, prepared)
            if matching_grant:
                decision.grant_id = matching_grant.grant_id
                decision.grant_scope = matching_grant.grant_scope
                decision.auto_approved_reason = "approval_grant"
                await self._audit_tooling_event(
                    "tooling.approval.grant_accepted",
                    principal_id=request.caller_principal_id,
                    details={
                        "correlation_id": request.correlation_id,
                        "decision_id": decision.decision_id,
                        "grant_id": matching_grant.grant_id,
                        "global_tool_id": global_tool_id,
                        "provider_peer_id": provider_peer_id,
                    },
                )
                return None

            token_ok, token_error = await self._validate_approval_token(request, prepared=prepared)
            if token_ok:
                await self._audit_tooling_event(
                    "tooling.approval.token_accepted",
                    principal_id=request.caller_principal_id,
                    details={
                        "correlation_id": request.correlation_id,
                        "decision_id": decision.decision_id,
                        "global_tool_id": global_tool_id,
                        "provider_peer_id": provider_peer_id,
                    },
                )
                return None

            await self._audit_tooling_event(
                "tooling.approval.token_rejected",
                principal_id=request.caller_principal_id,
                details={
                    "correlation_id": request.correlation_id,
                    "decision_id": decision.decision_id,
                    "global_tool_id": global_tool_id,
                    "provider_peer_id": provider_peer_id,
                    "error_code": token_error,
                    "confirmed": request.confirmed,
                },
            )
            return await self._deny_tool_execution(
                request,
                local_tool_name=local_tool_name,
                global_tool_id=global_tool_id,
                provider_peer_id=provider_peer_id,
                safety_class=safety_class,
                error_code=token_error or "approval_token_required",
                message=f"Tool '{local_tool_name}' requires a valid approval token",
                policy_decision=decision,
            )

        return None

    async def _resolve_tool_name(self, request: ToolingExecuteToolRequest) -> str:
        """Resolve discovery IDs or namespaced names back to provider-local names."""

        provider_peer_id, service_instance_id, source_type, namespace = self._provider_context(
            request
        )
        requested_name = request.tool_name

        if requested_name.startswith("aurora-tool:"):
            try:
                embedded_peer_id, contract_id = parse_canonical_tool_global_id(requested_name)
            except ToolIdentityError:
                return requested_name
            if embedded_peer_id != provider_peer_id:
                return requested_name
            identity_lookup = getattr(self.tools_manager, "tool_identity_lookup", {})
            tool = identity_lookup.get(contract_id) if isinstance(identity_lookup, dict) else None
            if tool is not None:
                return str(getattr(tool, "name", requested_name))

        for local_name in self.tools_manager.get_all_tool_names():
            if requested_name == local_name:
                return local_name
            accepted_ids = {
                self._global_tool_id(provider_peer_id, service_instance_id, local_name),
                self._global_tool_id("local", "local:Tooling", local_name),
            }
            if requested_name in accepted_ids:
                return local_name
            if source_type == "mesh_peer" and requested_name == self._namespaced_tool_name(
                namespace, local_name
            ):
                return local_name

        result = await self.bus.request(
            DBMethods.RESOLVE_TOOL_IDENTITY_ALIASES,
            DBResolveToolIdentityAliasesRequest(
                global_tool_ids=[requested_name],
                stable_peer_id=provider_peer_id,
            ),
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
            priority=get_system_priority(),
        )
        if not result.ok:
            return requested_name
        data = result.data
        resolved = data.get("resolved") if isinstance(data, dict) else getattr(data, "resolved", {})
        canonical_id = resolved.get(requested_name) if isinstance(resolved, dict) else None
        if isinstance(canonical_id, str):
            try:
                embedded_peer_id, contract_id = parse_canonical_tool_global_id(canonical_id)
            except ToolIdentityError:
                return requested_name
            if embedded_peer_id != provider_peer_id:
                return requested_name
            identity_lookup = getattr(self.tools_manager, "tool_identity_lookup", {})
            tool = identity_lookup.get(contract_id) if isinstance(identity_lookup, dict) else None
            if tool is not None:
                return str(getattr(tool, "name", requested_name))

        return requested_name

    def _extract_schema_manually(self, tool: Any) -> dict[str, Any]:
        """Extract schema manually from tool, filtering out non-serializable fields.

        This helper is used when automatic schema generation fails due to non-serializable types
        (e.g., BaseStore, MessageBus) in the tool's args_schema.

        Args:
            tool: The tool object with an args_schema attribute

        Returns:
            A dictionary containing the extracted schema with type, properties, and required fields
        """
        # Try to get schema fields directly and filter out non-serializable ones
        if not hasattr(tool.args_schema, "model_fields"):
            return {"type": "object", "properties": {}}

        filtered_properties = {}
        required_fields = []

        for field_name, field_info in tool.args_schema.model_fields.items():
            # Skip runtime-injected parameters (bus, store, etc.)
            if field_name in ["bus", "store"]:
                continue

            # Skip fields with non-serializable types
            field_type = field_info.annotation

            # Handle Annotated types (e.g., Annotated[BaseStore, InjectedStore])
            if (
                hasattr(field_type, "__origin__")
                and hasattr(field_type.__origin__, "__name__")
                and field_type.__origin__.__name__ == "Annotated"
            ):
                # Extract the actual type from Annotated
                args = getattr(field_type, "__args__", [])
                if args:
                    field_type = args[0]

            # Check if it's a non-serializable type
            type_name = None
            if hasattr(field_type, "__name__"):
                type_name = field_type.__name__
            elif hasattr(field_type, "__qualname__"):
                type_name = field_type.__qualname__

            if type_name and type_name in ["BaseStore", "InjectedStore"]:
                continue

            # Try to get type info
            try:
                # Create a simple type schema
                if field_info.is_required():
                    required_fields.append(field_name)

                # Determine type from annotation
                if hasattr(field_info, "annotation"):
                    ann = field_info.annotation
                    if hasattr(ann, "__origin__"):
                        ann = ann.__origin__

                    type_str = "string"
                    if hasattr(ann, "__name__"):
                        type_name = ann.__name__
                        if type_name == "int":
                            type_str = "integer"
                        elif type_name == "float":
                            type_str = "number"
                        elif type_name == "bool":
                            type_str = "boolean"

                    filtered_properties[field_name] = {
                        "type": type_str,
                        "description": field_info.description or "",
                    }
            except Exception:
                # Skip fields we can't process
                continue

        if filtered_properties:
            return {
                "type": "object",
                "properties": filtered_properties,
                **({"required": required_fields} if required_fields else {}),
            }
        else:
            return {"type": "object", "properties": {}}

    @method_contract(
        method_id=ToolingMethods.GET_EXPORT_CATALOG,
        summary="Get an authenticated recipient-specific Tooling export projection",
        input_model=ToolingGetExportCatalogRequest,
        output_model=ToolingGetExportCatalogResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.GET_TOOLS],
        callable_feature_ids=["catalog_discovery"],
    )
    async def _on_get_export_catalog(
        self, request: ToolingGetExportCatalogRequest, envelope: Any | None = None
    ) -> ToolingGetExportCatalogResponse:
        """Build and page a projection scoped only by authenticated envelope identity."""

        recipient = getattr(envelope, "caller_peer_id", None)
        permissions = getattr(envelope, "effective_perms", None)
        auth_grant_revision = int(getattr(envelope, "auth_grant_revision", 0) or 0)
        manifest_revision = int(getattr(envelope, "manifest_revision", 0) or 0)
        projected_service_id = getattr(envelope, "projected_service_id", None)
        projected_method_id = getattr(envelope, "projected_method_id", None)
        projected_topics = getattr(envelope, "projected_method_topics", None)
        projected_digest = getattr(envelope, "projected_method_set_digest", None)
        required_projection_topics = {
            ToolingMethods.GET_TOOLS,
            ToolingMethods.GET_EXPORT_CATALOG,
            ToolingMethods.PREPARE_EXECUTION,
            ToolingMethods.EXECUTE_TOOL,
        }
        if (
            not recipient
            or not isinstance(permissions, list)
            or not self._stable_peer_id
            or auth_grant_revision < 1
            or manifest_revision < 1
            or projected_service_id != "Tooling"
            or projected_method_id != ToolingMethods.GET_EXPORT_CATALOG
            or not self._valid_projected_method_evidence(
                projected_topics,
                projected_digest,
                required_topics=required_projection_topics,
            )
        ):
            raise PermissionError("projection_authority_unknown")
        snapshot = await self._tool_export_snapshot(peer_id=recipient)
        if not snapshot.mesh_switches.provider_mesh_tooling_enabled:
            raise PermissionError("provider_mesh_tooling_disabled")

        all_tools = self._provider_visible_export_tools()
        catalog_material = self._export_catalog_material(all_tools)
        catalog_revision = _derive_js_safe_catalog_revision(catalog_material)
        authority = ToolingProjectionAuthorityRevision(
            catalog_revision=catalog_revision,
            export_policy_revision=snapshot.policy.revision,
            auth_grant_revision=auth_grant_revision,
            manifest_revision=manifest_revision,
            switch_revision=snapshot.mesh_switches.revision,
        )
        visible, digest = build_recipient_projection(
            all_tools,
            context=ProjectionContext(
                recipient_peer_id=recipient,
                recipient_permissions=tuple(permissions),
                authority_revision=authority,
                provider_enabled=True,
                service_exported=True,
                discovery_exported=True,
                execution_exported=True,
            ),
            policy=snapshot.policy,
            rules=snapshot.rules,
            stale_tool_ids=snapshot.stale_tool_ids,
            stale_group_ids=snapshot.stale_group_ids,
        )
        blocked_tools = build_recipient_blocked_inventory(
            all_tools,
            context=ProjectionContext(
                recipient_peer_id=recipient,
                recipient_permissions=tuple(permissions),
                authority_revision=authority,
                provider_enabled=True,
                service_exported=True,
                discovery_exported=True,
                execution_exported=True,
            ),
            policy=snapshot.policy,
            rules=snapshot.rules,
            stale_tool_ids=snapshot.stale_tool_ids,
            stale_group_ids=snapshot.stale_group_ids,
        )
        ledger_result = await self.bus.request(
            DBMethods.GET_TOOLING_EXPOSURE_LEDGER,
            DBGetToolingExposureLedgerRequest(
                recipient_peer_id=recipient,
                provider_id=self._stable_peer_id,
            ),
            origin="internal",
        )
        if not ledger_result.ok or ledger_result.data is None:
            raise PermissionError("projection_ledger_unavailable")
        ledger = DBGetToolingExposureLedgerResponse.model_validate(ledger_result.data)
        visible_ids = {tool.global_tool_id for tool in visible}
        blocked_ids = {item.tool.global_tool_id for item in blocked_tools}
        current_tools = {tool.global_tool_id: tool for tool in all_tools}
        retirements = sorted(
            (
                self._classify_projection_retirement(
                    row,
                    candidate=current_tools.get(row.global_tool_id),
                    recipient=recipient,
                    permissions=permissions,
                    snapshot=snapshot,
                )
                for row in ledger.entries
                if row.global_tool_id not in visible_ids and row.global_tool_id not in blocked_ids
            ),
            key=lambda item: item.global_tool_id,
        )
        digest = compute_projection_checksum(visible, retirements, blocked_tools)
        revision = hashlib.sha256(
            json.dumps(authority.model_dump(mode="json"), sort_keys=True).encode()
        ).hexdigest()
        offset = 0
        page_index = 0
        if request.cursor:
            try:
                cursor = self._projection_cursor_codec.decode(request.cursor)
            except ProjectionCursorError as exc:
                raise PermissionError(str(exc)) from exc
            expected = (
                recipient,
                self._stable_peer_id,
                request.protocol_tier,
                revision,
                digest,
                request.page_size,
            )
            actual = (
                cursor.recipient_peer_id,
                cursor.provider_peer_id,
                cursor.protocol_tier,
                cursor.projection_revision,
                cursor.projection_digest,
                cursor.page_size,
            )
            if actual != expected:
                raise PermissionError("projection_restart_required")
            offset, page_index = cursor.next_offset, cursor.page_index
        projection_entries = (
            [("tool", tool) for tool in visible]
            + [("blocked", item) for item in blocked_tools]
            + [("retirement", item) for item in retirements]
        )
        projection_entries.sort(
            key=lambda item: (
                item[1].tool.global_tool_id if item[0] == "blocked" else item[1].global_tool_id,
                item[0],
            )
        )
        page_entries = projection_entries[offset : offset + request.page_size]
        page_tools = [item for kind, item in page_entries if kind == "tool"]
        page_blocked_tools = [item for kind, item in page_entries if kind == "blocked"]
        page_retirements = [item for kind, item in page_entries if kind == "retirement"]
        next_offset = offset + len(page_entries)
        complete = next_offset >= len(projection_entries)
        next_cursor = None
        if not complete:
            next_cursor = self._projection_cursor_codec.encode(
                ProjectionCursor(
                    recipient_peer_id=recipient,
                    provider_peer_id=self._stable_peer_id,
                    protocol_tier=request.protocol_tier,
                    projection_revision=revision,
                    projection_digest=digest,
                    page_size=request.page_size,
                    next_offset=next_offset,
                    page_index=page_index + 1,
                    expires_at=int(time.time()) + self._projection_cursor_ttl_seconds,
                    nonce=secrets.token_hex(8),
                )
            )
        checksum = (
            compute_projection_checksum(visible, retirements, blocked_tools) if complete else None
        )
        response = ToolingGetExportCatalogResponse(
            provider_peer_id=self._stable_peer_id,
            service_instance_id=f"remote:{self._stable_peer_id}:Tooling",
            authority_revision=authority,
            projection_revision=revision,
            projection_digest=digest,
            page_index=page_index,
            page_size=request.page_size,
            page_hash="0" * 64,
            tools=page_tools,
            blocked_tools=page_blocked_tools,
            retirements=page_retirements,
            next_cursor=next_cursor,
            complete=complete,
            total_count=(len(visible) + len(blocked_tools)) if complete else None,
            final_checksum=checksum,
        )
        if page_tools:
            recorded = await self.bus.request(
                DBMethods.RECORD_TOOLING_EXPOSURES,
                DBRecordToolingExposuresRequest(
                    recipient_peer_id=recipient,
                    provider_id=self._stable_peer_id,
                    entries=[
                        DBToolingExposureLedgerEntry(
                            global_tool_id=tool.global_tool_id,
                            last_schema_hash=hashlib.sha256(
                                json.dumps(tool.model_dump(mode="json"), sort_keys=True).encode()
                            ).hexdigest(),
                        )
                        for tool in page_tools
                    ],
                ),
                origin="internal",
            )
            if not recorded.ok or recorded.data is None:
                raise PermissionError("projection_ledger_unavailable")
            DBRecordToolingExposuresResponse.model_validate(recorded.data)
        response = response.model_copy(update={"page_hash": compute_projection_page_hash(response)})
        await self._audit_tooling_event(
            "tooling.catalog_projection.generated",
            principal_id=None,
            details={
                "recipient_peer_id": recipient,
                "catalog_revision": catalog_revision,
                "export_policy_revision": snapshot.policy.revision,
                "auth_grant_revision": auth_grant_revision,
                "manifest_revision": manifest_revision,
                "switch_revision": snapshot.mesh_switches.revision,
                "page_index": page_index,
                "page_item_count": (
                    len(page_tools) + len(page_blocked_tools) + len(page_retirements)
                ),
                "complete": complete,
                "secrets_redacted": True,
            },
        )
        return response

    @staticmethod
    def _classify_projection_retirement(
        ledger_entry: DBToolingExposureLedgerEntry,
        *,
        candidate: ToolingToolInfo | None,
        recipient: str,
        permissions: list[str],
        snapshot: DBGetToolingExportPolicySnapshotResponse,
    ) -> ToolingProjectionRetirement:
        """Classify only tools already exposed to this recipient.

        The durable ledger is the disclosure boundary: tools absent from it
        never produce a retirement oracle. Current catalog and authority state
        then distinguish removal, RBAC loss, and provider export-policy loss.
        """

        if candidate is None or candidate.source_type != "local":
            availability = "removed"
            reason_code = "provider_tool_removed"
        elif candidate.global_tool_id in snapshot.stale_tool_ids:
            availability = "stale"
            reason_code = "provider_tool_identity_stale"
        elif candidate.share_group_id in snapshot.stale_group_ids:
            availability = "stale"
            reason_code = "provider_tool_group_stale"
        else:
            required_permissions = (
                ToolingMethods.GET_TOOLS,
                ToolingMethods.EXECUTE_TOOL,
                *candidate.required_permissions,
            )
            if not all(
                permission_satisfies(required, permissions) for required in required_permissions
            ):
                availability = "permission_blocked"
                reason_code = "recipient_permission_revoked"
            else:
                decision = evaluate_tool_export_policy(
                    policy=snapshot.policy,
                    rules=snapshot.rules,
                    peer_id=recipient,
                    global_tool_id=candidate.global_tool_id,
                    share_group_id=candidate.share_group_id,
                    exportable=candidate.exportable,
                    stale_tool_id=candidate.global_tool_id in snapshot.stale_tool_ids,
                    stale_group_id=candidate.share_group_id in snapshot.stale_group_ids,
                    prerequisites=ToolingExportPrerequisites(
                        service_shared=True,
                        discovery_method_shared=True,
                        execute_method_shared=True,
                        peer_discovery_rbac=True,
                        peer_execute_rbac=True,
                        tool_required_permissions_granted=True,
                        local_exportable=candidate.exportable,
                        enforcement_active=True,
                    ),
                )
                availability = "unshared"
                reason_code = (
                    "provider_export_policy_unshared"
                    if decision.effective_state != "shared"
                    else "provider_export_unavailable"
                )
        return ToolingProjectionRetirement(
            global_tool_id=ledger_entry.global_tool_id,
            availability=availability,
            reason_code=reason_code,
            last_schema_hash=ledger_entry.last_schema_hash,
        )

    @staticmethod
    def _valid_projected_method_evidence(
        topics: Any,
        digest: Any,
        *,
        required_topics: set[str],
    ) -> bool:
        if not isinstance(topics, list) or not all(isinstance(item, str) for item in topics):
            return False
        canonical = sorted(set(topics))
        if canonical != topics or not required_topics.issubset(canonical):
            return False
        expected = hashlib.sha256(json.dumps(canonical, separators=(",", ":")).encode()).hexdigest()
        return isinstance(digest, str) and secrets.compare_digest(expected, digest)

    async def _provider_rpc_execution_authorized(
        self,
        request: ToolingExecuteToolRequest,
        envelope: Any,
        exact_topic: str,
    ) -> bool:
        caller = getattr(envelope, "caller_peer_id", None)
        if not caller:
            return True
        # Before the durable cutover, preserve the legacy share-policy guard.
        # Exact projection evidence becomes authoritative only after activation.
        if not self._mesh_projection_enforcement_active:
            return True
        topics = getattr(envelope, "projected_method_topics", None)
        evidence_valid = bool(
            self._mesh_projection_enforcement_active
            and getattr(envelope, "origin", None) == "external"
            and int(getattr(envelope, "auth_grant_revision", 0) or 0) >= 1
            and int(getattr(envelope, "manifest_revision", 0) or 0) >= 1
            and getattr(envelope, "projected_service_id", None) == "Tooling"
            and getattr(envelope, "projected_method_id", None) == exact_topic
            and self._valid_projected_method_evidence(
                topics,
                getattr(envelope, "projected_method_set_digest", None),
                required_topics={exact_topic},
            )
        )
        if not evidence_valid:
            return False
        snapshot = await self._tool_export_snapshot(peer_id=caller)
        candidates = [
            self._serialize_tool(tool, ToolingGetToolsRequest(top_k=10_000))
            for tool in self.tools_manager.get_tools(None, 10_000)
        ]
        visible, _ = build_recipient_projection(
            candidates,
            context=ProjectionContext(
                recipient_peer_id=caller,
                recipient_permissions=tuple(getattr(envelope, "effective_perms", None) or ()),
                authority_revision=ToolingProjectionAuthorityRevision(
                    catalog_revision=0,
                    export_policy_revision=snapshot.policy.revision,
                    auth_grant_revision=int(envelope.auth_grant_revision),
                    manifest_revision=int(envelope.manifest_revision),
                    switch_revision=snapshot.mesh_switches.revision,
                ),
                provider_enabled=True,
                service_exported=True,
                discovery_exported=True,
                execution_exported=True,
            ),
            policy=snapshot.policy,
            rules=snapshot.rules,
            stale_tool_ids=snapshot.stale_tool_ids,
            stale_group_ids=snapshot.stale_group_ids,
        )
        return any(
            request.tool_name in {tool.global_tool_id, tool.name, tool.local_name}
            for tool in visible
        )

    @method_contract(
        method_id=ToolingMethods.GET_TOOLS,
        summary="Get available tools with optional RAG search",
        input_model=ToolingGetToolsRequest,
        output_model=ToolingGetToolsResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.GET_TOOLS],
        callable_feature_ids=["catalog_discovery"],
    )
    async def _on_get_tools(
        self,
        request: ToolingGetToolsRequest,
        envelope: Any | None = None,
    ) -> ToolingGetToolsResponse:
        """Handle get tools query.

        Serializes tools to send through the bus with bindable schemas,
        stable identity, and provenance metadata.
        The bus remains agnostic - it just transports the serialized data.

        Args:
            request: Request containing optional search query and top_k limit
        """
        try:
            log_debug(f"Getting tools with query: {request.query}")

            # Use RAG search via bus if query is provided
            if request.query:
                from app.shared.contracts.models.db import DBMethods
                from app.shared.messaging.models.db_models import RAGSearchQuery

                tools = []
                rag_search_failed = False
                rag_returned_no_usable_hits = False
                try:
                    result = await self.bus.request(
                        DBMethods.RAG_SEARCH,
                        RAGSearchQuery(
                            namespace="main.tools", query=request.query, limit=request.top_k
                        ),
                        timeout=5.0,
                        priority=get_interactive_priority(),
                    )
                    names: list[str] = []
                    if not getattr(result, "ok", False):
                        log_warning(
                            "RAG tool search returned unsuccessful result; "
                            f"using lexical tool search: {getattr(result, 'error', None)}"
                        )
                        rag_search_failed = True
                    elif not isinstance(result.data, dict) or not isinstance(
                        result.data.get("items"), list
                    ):
                        log_warning(
                            "RAG tool search returned invalid response; using lexical tool search"
                        )
                        rag_search_failed = True
                    else:
                        names = [
                            item.get("key")
                            for item in result.data["items"]
                            if isinstance(item, dict) and item.get("key")
                        ]
                        rag_returned_no_usable_hits = True

                    # Map names to tool callables
                    for name in names:
                        tool = self.tools_manager.get_tool_by_name(name)
                        if tool:
                            tools.append(tool)
                    if tools:
                        rag_returned_no_usable_hits = False

                except Exception as e:
                    log_warning(f"RAG tool search failed; using lexical tool search: {e}")
                    rag_search_failed = True

                # RAG remains authoritative when it yields usable loaded tools.
                # If RAG is unavailable, returns no hits, or returns stale names
                # that no longer map to loaded callables, use a bounded lexical
                # fallback over the loaded tool snapshot without broadening to
                # every tool on unrelated queries.
                if (rag_search_failed or rag_returned_no_usable_hits) and not tools:
                    tools = self._lexical_tool_matches(request.query, request.top_k)
                if not tools:
                    log_debug(f"No tools matched query: {request.query}")
            else:
                # No query, return all tools
                tools = self.tools_manager.get_tools(None, request.top_k)

            # Serialize tools to send through bus with stable identity and provenance metadata.
            serialized_tools = []
            for tool in tools:
                try:
                    tool_info = self._serialize_tool(tool, request)
                    if (
                        tool_info.source_type == "mesh_peer"
                        or tool_info.execution_location == "remote"
                    ) and not await self._consumer_mesh_execution_authorized(
                        ToolingExecuteToolRequest(
                            tool_name=tool_info.global_tool_id or tool_info.name,
                            arguments={},
                            mesh_selector=MeshAddressSelector(
                                peer_id=tool_info.provider_peer_id,
                                service_instance_id=tool_info.provider_service_instance_id,
                            ),
                        )
                    ):
                        continue
                    # Discovery/model binding is intentionally broad: only tools
                    # explicitly marked blocked are hidden. Sharing policy, default
                    # deny, untrusted sources, and confirmation requirements are
                    # enforced by prepare/execute so the LLM can still discover a
                    # tool and trigger the approval/denial path at runtime.
                    if tool_info.trust_tier != "blocked":
                        serialized_tools.append(tool_info)

                except Exception as tool_error:
                    log_warning(f"Failed to serialize tool {tool.name}: {tool_error}")
                    continue

            serialized_tools = await self._filter_provider_discovery_tools(
                serialized_tools,
                envelope,
                exact_topic=ToolingMethods.GET_TOOLS,
            )

            # Return response
            return ToolingGetToolsResponse(tools=serialized_tools, count=len(serialized_tools))

        except Exception as e:
            log_error(f"Error handling get tools query: {e}", exc_info=True)
            raise

    async def _filter_provider_discovery_tools(
        self,
        candidates: list[ToolingToolInfo],
        envelope: Any | None,
        *,
        exact_topic: str,
    ) -> list[ToolingToolInfo]:
        """Apply exact authenticated provider projection authority to discovery."""

        recipient = getattr(envelope, "caller_peer_id", None)
        if not recipient or recipient in {"local", self._stable_peer_id}:
            return candidates
        permissions = getattr(envelope, "effective_perms", None)
        auth_revision = int(getattr(envelope, "auth_grant_revision", 0) or 0)
        manifest_revision = int(getattr(envelope, "manifest_revision", 0) or 0)
        if (
            not self._mesh_projection_enforcement_active
            or getattr(envelope, "origin", None) != "external"
            or not isinstance(permissions, list)
            or auth_revision < 1
            or manifest_revision < 1
            or getattr(envelope, "projected_service_id", None) != "Tooling"
            or getattr(envelope, "projected_method_id", None) != exact_topic
            or not self._valid_projected_method_evidence(
                getattr(envelope, "projected_method_topics", None),
                getattr(envelope, "projected_method_set_digest", None),
                required_topics={exact_topic},
            )
        ):
            return []
        snapshot = await self._tool_export_snapshot(peer_id=recipient)
        if not snapshot.mesh_switches.provider_mesh_tooling_enabled:
            return []
        visible, _ = build_recipient_projection(
            candidates,
            context=ProjectionContext(
                recipient_peer_id=recipient,
                recipient_permissions=tuple(str(item) for item in permissions),
                authority_revision=ToolingProjectionAuthorityRevision(
                    catalog_revision=0,
                    export_policy_revision=snapshot.policy.revision,
                    auth_grant_revision=auth_revision,
                    manifest_revision=manifest_revision,
                    switch_revision=snapshot.mesh_switches.revision,
                ),
                provider_enabled=True,
                service_exported=True,
                discovery_exported=True,
                execution_exported=True,
            ),
            policy=snapshot.policy,
            rules=snapshot.rules,
            stale_tool_ids=snapshot.stale_tool_ids,
            stale_group_ids=snapshot.stale_group_ids,
        )
        return visible

    def _loaded_tools_snapshot(self, top_k: int) -> list[Any]:
        """Return a bounded loaded-tool snapshot for local fallback matching.

        Prefer the manager's in-memory loaded list so lexical fallback is not
        constrained by ``top_k`` ordering. Test doubles often expose arbitrary
        ``Mock`` attributes for missing fields, so only concrete list/tuple
        snapshots are treated as loaded tool collections.
        """

        scan_limit = min(max(top_k, 256), 1000)
        manager_tools = getattr(self.tools_manager, "tools", None)
        if isinstance(manager_tools, (list, tuple)):
            return list(manager_tools)[:scan_limit]

        return list(self.tools_manager.get_tools(None, scan_limit) or [])

    @staticmethod
    def _tool_lexical_terms(query: str) -> set[str]:
        """Tokenize query terms and retain a narrow web-search intent alias."""

        tokens = set(re.findall(r"[a-z0-9_]+", query.lower()))
        terms = {token for token in tokens if token not in _TOOL_LEXICAL_STOPWORDS}
        if tokens & _TOOL_WEB_INTENT_TOKENS or tokens >= _TOOL_CURRENT_EVENTS_INTENT:
            terms.add("search")
        return terms

    def _lexical_tool_matches(self, query: str, top_k: int) -> list[Any]:
        """Find loaded tools whose name or description contains query terms."""

        terms = self._tool_lexical_terms(query)
        if not terms:
            return []

        matches: list[tuple[int, int, Any]] = []
        for index, tool in enumerate(self._loaded_tools_snapshot(top_k)):
            haystack = " ".join(
                [
                    getattr(tool, "name", "") or "",
                    getattr(tool, "description", "") or "",
                ]
            ).lower()
            score = sum(1 for term in terms if term in haystack)
            if score:
                # Negative score sorts highest score first while preserving
                # loaded order for ties.
                matches.append((-score, index, tool))

        matches.sort(key=lambda item: (item[0], item[1]))
        return [tool for _, _, tool in matches[:top_k]]

    def _remote_catalog_tool_matches(
        self, tools: list[ToolingToolInfo], query: str, top_k: int
    ) -> list[ToolingToolInfo]:
        """Find remote catalog tools whose public metadata contains query terms."""

        terms = self._tool_lexical_terms(query)
        if not terms:
            return []

        scan_limit = 1000
        matches: list[tuple[int, int, ToolingToolInfo]] = []
        for index, tool in enumerate(tools[:scan_limit]):
            haystack = " ".join(
                [
                    tool.name or "",
                    tool.local_name or "",
                    tool.display_name or "",
                    tool.provider_label or "",
                    tool.description or "",
                ]
            ).lower()
            score = sum(1 for term in terms if term in haystack)
            if score:
                # Negative score sorts highest score first while preserving
                # snapshot order for ties.
                matches.append((-score, index, tool))

        matches.sort(key=lambda item: (item[0], item[1]))
        return [tool for _, _, tool in matches[:top_k]]

    @method_contract(
        method_id=ToolingMethods.GET_TOOL_CATALOG,
        summary="Get aggregate local and remote Tooling catalog",
        input_model=ToolingGetToolCatalogRequest,
        output_model=ToolingGetToolCatalogResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.GET_TOOLS],
        callable_feature_ids=["catalog_discovery"],
    )
    async def _on_get_tool_catalog(
        self, request: ToolingGetToolCatalogRequest, envelope: Any | None = None
    ) -> ToolingGetToolCatalogResponse:
        """Return a safe bindable aggregate catalog plus blocked provider/tool details."""

        tools: list[ToolingToolInfo] = []
        blocked_tools: list[ToolingBlockedToolInfo] = []
        providers: list[ToolingCatalogProviderInfo] = [
            ToolingCatalogProviderInfo(
                provider_peer_id="local",
                provider_service_instance_id="local:Tooling",
                provider_kind="local",
                eligible=True,
                reason_code="eligible",
                reason="local Tooling provider",
                cache_status="local",
            )
        ]

        try:
            caller_permissions = await self._catalog_caller_permissions(request, envelope)
            local_response = await self._on_get_tools(
                ToolingGetToolsRequest(query=request.query, top_k=request.top_k)
            )
            provider_visible_tools = await self._filter_provider_discovery_tools(
                local_response.tools,
                envelope,
                exact_topic=ToolingMethods.GET_TOOL_CATALOG,
            )
            for tool in provider_visible_tools:
                self._append_catalog_tool(
                    tool=tool,
                    caller_permissions=caller_permissions,
                    tools=tools,
                    blocked_tools=blocked_tools,
                    include_blocked_tools=request.include_blocked_tools,
                )

            remote_registry_available = self._remote_tooling_registry_available()
            candidates_by_peer = {
                str(candidate.peer.peer_id): candidate
                for candidate in self._remote_tooling_candidates()
                if getattr(getattr(candidate, "peer", None), "peer_id", None)
            }
            normalized_snapshots = await self._load_normalized_bindable_remote_catalogs()
            normalized_keys = {
                (snapshot.peer_id, snapshot.service_instance_id)
                for snapshot in normalized_snapshots
            }
            for snapshot in normalized_snapshots:
                if snapshot.peer_id == "local":
                    continue
                candidate = candidates_by_peer.get(snapshot.peer_id)
                provider_label = self._peer_display_name(snapshot.peer_id)
                granted_permissions: list[str] | None = None
                outbound_permissions = await self._current_peer_outbound_permissions(
                    snapshot.peer_id
                )
                volatile_permissions, volatile_available = self._remote_provider_states.get(
                    (snapshot.peer_id, snapshot.service_instance_id), (None, False)
                )
                if not snapshot.shared_by_policy:
                    provider_eligible = False
                    provider_reason_code = "not_shared_by_policy"
                    provider_reason = (
                        "cached negotiated Tooling catalog is not shared by policy; "
                        "execution remains gated"
                    )
                elif candidate is not None and not bool(candidate.eligible):
                    provider_eligible = False
                    provider_reason_code = candidate.reason_code or "provider_ineligible"
                    provider_reason = candidate.reason or "provider is not currently eligible"
                    candidate_label = str(
                        getattr(getattr(candidate, "peer", None), "node_name", "") or ""
                    ).strip()
                    if candidate_label:
                        provider_label = candidate_label
                elif candidate is not None:
                    candidate_permissions = self._candidate_granted_permissions(candidate)
                    granted_permissions = candidate_permissions
                    candidate_label = str(
                        getattr(getattr(candidate, "peer", None), "node_name", "") or ""
                    ).strip()
                    if candidate_label:
                        provider_label = candidate_label
                    if candidate_permissions is None:
                        provider_eligible = False
                        provider_reason_code = "permissions_unknown"
                        provider_reason = (
                            "provider permission manifest is unavailable; cached catalog "
                            "metadata was retained"
                        )
                    elif outbound_permissions is None:
                        provider_eligible = False
                        provider_reason_code = "permissions_unknown"
                        provider_reason = (
                            "current peer permissions are unavailable; cached catalog "
                            "metadata was retained"
                        )
                    elif self._missing_required_permissions(
                        [ToolingMethods.GET_TOOLS], outbound_permissions
                    ):
                        provider_eligible = False
                        provider_reason_code = "permission_denied"
                        provider_reason = (
                            "current peer permissions do not allow remote Tooling discovery"
                        )
                    else:
                        provider_eligible = True
                        provider_reason_code = "cached_negotiated_catalog"
                        provider_reason = "cached negotiated Tooling catalog"
                elif volatile_available and not remote_registry_available:
                    granted_permissions = volatile_permissions
                    if granted_permissions is None:
                        provider_eligible = False
                        provider_reason_code = "permissions_unknown"
                        provider_reason = (
                            "provider permission state is unavailable; cached catalog "
                            "metadata was retained"
                        )
                    else:
                        provider_eligible = True
                        provider_reason_code = "cached_negotiated_catalog"
                        provider_reason = "cached negotiated Tooling catalog"
                else:
                    provider_eligible = False
                    provider_reason_code = "provider_unavailable"
                    provider_reason = (
                        "cached Tooling provider is not currently negotiated; "
                        "catalog metadata was retained"
                    )

                providers.append(
                    ToolingCatalogProviderInfo(
                        provider_peer_id=snapshot.peer_id,
                        provider_service_instance_id=snapshot.service_instance_id,
                        provider_label=provider_label,
                        provider_kind="mesh_peer",
                        eligible=provider_eligible,
                        reason_code=provider_reason_code,
                        reason=provider_reason,
                        cache_status="hit",
                    )
                )
                remote_tools = (
                    self._remote_catalog_tool_matches(
                        snapshot.tools,
                        request.query,
                        request.top_k,
                    )
                    if request.query
                    else snapshot.tools[: request.top_k]
                )
                for tool in remote_tools:
                    if not provider_eligible:
                        self._append_unavailable_catalog_tool(
                            tool=tool,
                            reason_code=provider_reason_code,
                            reason=provider_reason,
                            blocked_tools=blocked_tools,
                            include_blocked_tools=request.include_blocked_tools,
                        )
                    else:
                        local_missing = self._missing_required_permissions(
                            tool.required_permissions,
                            caller_permissions,
                        )
                        provider_missing = self._missing_required_permissions(
                            tool.required_permissions,
                            granted_permissions,
                        )
                        missing_permissions = list(
                            dict.fromkeys([*local_missing, *provider_missing])
                        )
                        if missing_permissions:
                            self._append_unavailable_catalog_tool(
                                tool=tool,
                                reason_code="permission_denied",
                                reason=(
                                    "local caller or remote provider grant lacks required "
                                    "tool permissions"
                                ),
                                blocked_tools=blocked_tools,
                                include_blocked_tools=request.include_blocked_tools,
                                missing_permissions=missing_permissions,
                            )
                        else:
                            self._append_catalog_tool(
                                tool=tool,
                                caller_permissions=["*"],
                                tools=tools,
                                blocked_tools=blocked_tools,
                                include_blocked_tools=request.include_blocked_tools,
                            )

            # Retain old announcement/catalog rows for management visibility,
            # but never place them in the callable catalog. They lack an
            # authenticated recipient projection and cannot be upgraded into
            # authority by live route or permission state.
            for snapshot in await self._load_remote_catalog_snapshots():
                key = (snapshot.peer_id, snapshot.service_instance_id)
                if snapshot.peer_id == "local" or key in normalized_keys:
                    continue
                reason = (
                    "legacy Tooling catalog is retained for policy history but "
                    "is not bindable without a committed recipient projection"
                )
                providers.append(
                    ToolingCatalogProviderInfo(
                        provider_peer_id=snapshot.peer_id,
                        provider_service_instance_id=snapshot.service_instance_id,
                        provider_label=self._peer_display_name(snapshot.peer_id),
                        provider_kind="mesh_peer",
                        eligible=False,
                        reason_code="legacy_unverifiable",
                        reason=reason,
                        cache_status="blocked",
                    )
                )
                remote_tools = (
                    self._remote_catalog_tool_matches(
                        snapshot.tools,
                        request.query,
                        request.top_k,
                    )
                    if request.query
                    else snapshot.tools[: request.top_k]
                )
                for tool in remote_tools:
                    self._append_unavailable_catalog_tool(
                        tool=tool,
                        reason_code="legacy_unverifiable",
                        reason=reason,
                        blocked_tools=blocked_tools,
                        include_blocked_tools=request.include_blocked_tools,
                    )

        except Exception as error:
            log_error(f"Error handling tool catalog query: {error}", exc_info=True)

        tools = sorted(tools, key=lambda item: item.name)
        blocked_tools = sorted(blocked_tools, key=lambda item: item.tool.name)
        providers = sorted(
            providers,
            key=lambda item: (item.provider_kind != "local", item.provider_peer_id),
        )
        return ToolingGetToolCatalogResponse(
            tools=tools,
            blocked_tools=blocked_tools,
            providers=providers,
            count=len(tools),
            blocked_count=len(blocked_tools),
            generated_at=datetime.now(timezone.utc).isoformat(),  # noqa: UP017 - Python 3.10
            cache_ttl_seconds=request.cache_ttl_seconds,
        )

    @method_contract(
        method_id=ToolingMethods.REMOTE_CATALOG_ANNOUNCED,
        summary="Apply a negotiated remote Tooling catalog snapshot",
        input_model=ToolingRemoteCatalogAnnounced,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def _on_remote_catalog_announced(
        self, request: ToolingRemoteCatalogAnnounced
    ) -> EmptyOutput:
        if request.peer_id == "local":
            return EmptyOutput()
        await self._persist_remote_catalog_snapshot(request)
        self._catalog_cache.clear()
        return EmptyOutput()

    @method_contract(
        method_id=ToolingMethods.REMOTE_CATALOG_DELTA_ANNOUNCED,
        summary="Apply a negotiated remote Tooling catalog delta",
        input_model=ToolingRemoteCatalogDeltaAnnounced,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def _on_remote_catalog_delta_announced(
        self, request: ToolingRemoteCatalogDeltaAnnounced
    ) -> EmptyOutput:
        key = (request.peer_id, request.service_instance_id)
        if request.granted_permissions is not None or request.provider_available is not None:
            self._update_remote_provider_state(
                peer_id=request.peer_id,
                service_instance_id=request.service_instance_id,
                granted_permissions=request.granted_permissions,
                available=request.provider_available,
            )
        previous = self._remote_catalog_snapshots.get(key, (None, 0))[0]
        if previous is None:
            await self._load_remote_catalog_snapshots()
            previous = self._remote_catalog_snapshots.get(key, (None, 0))[0]
        tools_by_id = {
            tool.global_tool_id: tool for tool in (previous.tools if previous is not None else [])
        }
        for tool_id in request.removed_global_tool_ids:
            tools_by_id.pop(tool_id, None)
        for tool in request.upserted_tools:
            tools_by_id[tool.global_tool_id] = tool
        shared_by_policy = (
            request.shared_by_policy
            if request.shared_by_policy is not None
            else (previous.shared_by_policy if previous is not None else True)
        )
        snapshot = ToolingRemoteCatalogAnnounced(
            peer_id=request.peer_id,
            service_instance_id=request.service_instance_id,
            provider_id=request.provider_id,
            catalog_epoch=request.catalog_epoch,
            generated_at=request.generated_at,
            full_schema_hash=request.full_schema_hash
            or (previous.full_schema_hash if previous else ""),
            tools=list(tools_by_id.values()),
            shared_by_policy=shared_by_policy,
            granted_permissions=(
                request.granted_permissions
                if request.granted_permissions is not None
                else (previous.granted_permissions if previous else None)
            ),
            # Provider liveness is intentionally not persisted with the
            # durable catalog registry.
            provider_available=None,
        )
        await self._persist_remote_catalog_snapshot(snapshot)
        self._catalog_cache.clear()
        return EmptyOutput()

    @method_contract(
        method_id=ToolingMethods.REMOTE_CATALOG_REMOVED,
        summary="Mark a negotiated remote Tooling catalog unavailable",
        input_model=ToolingRemoteCatalogRemoved,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def _on_remote_catalog_removed(self, request: ToolingRemoteCatalogRemoved) -> EmptyOutput:
        for key in list(self._remote_provider_states):
            peer_id, service_instance_id = key
            if peer_id == request.peer_id and (
                request.service_instance_id is None
                or service_instance_id == request.service_instance_id
            ):
                self._remote_provider_states.pop(key, None)
        for key in list(self._remote_catalog_snapshots):
            peer_id, service_instance_id = key
            if peer_id == request.peer_id and (
                request.service_instance_id is None
                or service_instance_id == request.service_instance_id
            ):
                self._remote_catalog_snapshots.pop(key, None)
        await self._ensure_tooling_policy_tables()
        if self._tooling_policy_tables_ready:
            await self._db_sql(
                """
                UPDATE tooling_remote_catalog_snapshots
                SET stale = 1, removed_at = ?, updated_at = ?
                WHERE peer_id = ?
                  AND (? IS NULL OR service_instance_id = ?)
                """,
                [
                    time.time(),
                    time.time(),
                    request.peer_id,
                    request.service_instance_id,
                    request.service_instance_id,
                ],
            )
            await self._mark_remote_catalog_dependents_stale(
                peer_id=request.peer_id,
                service_instance_id=request.service_instance_id,
                reason="remote_catalog_removed",
            )
        self._catalog_cache.clear()
        return EmptyOutput()

    @method_contract(
        method_id=ToolingMethods.REMOTE_CATALOG_REFRESH_REQUESTED,
        summary="Request/re-announce local Tooling catalog",
        input_model=ToolingRemoteCatalogRefreshRequested,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def _on_remote_catalog_refresh_requested(
        self, request: ToolingRemoteCatalogRefreshRequested
    ) -> EmptyOutput:
        if request.peer_id in (None, "local"):
            await self._announce_local_tool_catalog(reason=request.reason or "refresh_requested")
        return EmptyOutput()

    @method_contract(
        method_id=ToolingMethods.GET_TOOL_BY_NAME,
        summary="Get a specific tool by name",
        input_model=ToolingGetToolByNameRequest,
        output_model=ToolingGetToolByNameResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.GET_TOOLS],
        callable_feature_ids=["catalog_discovery"],
    )
    async def _on_get_tool_by_name(
        self,
        request: ToolingGetToolByNameRequest,
        envelope: Any | None = None,
    ) -> ToolingGetToolByNameResponse:
        """Handle get tool by name query.

        Args:
            request: Request containing tool name
        """
        try:
            log_debug(f"Getting tool: {request.name}")

            selector = request.mesh_selector
            if selector and (selector.peer_id or selector.provider_id):
                if not await self._consumer_mesh_execution_authorized(
                    ToolingExecuteToolRequest(
                        tool_name=request.name,
                        arguments={},
                        mesh_selector=selector,
                    )
                ):
                    return ToolingGetToolByNameResponse(found=False, name="")
                provider_peer_id = selector.peer_id or selector.provider_id
                for snapshot in await self._load_normalized_bindable_remote_catalogs():
                    if snapshot.peer_id != provider_peer_id:
                        continue
                    for remote_tool in snapshot.tools:
                        if request.name in {
                            remote_tool.name,
                            remote_tool.global_tool_id,
                            remote_tool.display_name,
                        }:
                            return ToolingGetToolByNameResponse(
                                found=True,
                                name=remote_tool.name,
                                description=remote_tool.description,
                            )
                # Do not echo a never-authorized hidden name.
                return ToolingGetToolByNameResponse(found=False, name="")

            recipient = getattr(envelope, "caller_peer_id", None)
            if recipient and recipient not in {"local", self._stable_peer_id}:
                candidates = [
                    self._serialize_tool(tool, ToolingGetToolsRequest(top_k=10_000))
                    for tool in self.tools_manager.get_tools(None, 10_000)
                ]
                visible = await self._filter_provider_discovery_tools(
                    candidates,
                    envelope,
                    exact_topic=ToolingMethods.GET_TOOL_BY_NAME,
                )
                for remote_visible in visible:
                    if request.name in {
                        remote_visible.name,
                        remote_visible.global_tool_id,
                        remote_visible.display_name,
                    }:
                        return ToolingGetToolByNameResponse(
                            found=True,
                            name=remote_visible.name,
                            description=remote_visible.description,
                        )
                return ToolingGetToolByNameResponse(found=False, name="")

            tool = self.tools_manager.get_tool_by_name(request.name)

            # Return response
            if tool:
                return ToolingGetToolByNameResponse(
                    found=True, name=tool.name, description=getattr(tool, "description", "")
                )
            else:
                return ToolingGetToolByNameResponse(found=False, name=request.name)

        except Exception as e:
            log_error(f"Error handling get tool by name query: {e}", exc_info=True)
            return ToolingGetToolByNameResponse(found=False, name=request.name)

    @method_contract(
        method_id=ToolingMethods.GET_STATS,
        summary="Get tooling statistics",
        input_model=ToolingGetStatsRequest,
        output_model=ToolingGetStatsResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.GET_STATS],
        callable_feature_ids=["catalog_discovery"],
    )
    async def _on_get_stats(self, request: ToolingGetStatsRequest) -> ToolingGetStatsResponse:
        """Handle get stats query.

        Args:
            request: Empty request
        """
        try:
            stats = self.tools_manager.get_stats()
            log_debug(f"Tool stats: {stats}")

            # Return response
            return ToolingGetStatsResponse(
                total_tools=stats.get("total_tools", 0),
                mcp_tools_loaded=stats.get("mcp_tools_loaded", 0),
                core_tools=stats.get("core_tools"),
                plugin_tools=stats.get("plugin_tools"),
            )

        except Exception as e:
            log_error(f"Error handling get stats query: {e}", exc_info=True)
            return ToolingGetStatsResponse(total_tools=0, mcp_tools_loaded=0)

    @method_contract(
        method_id=ToolingMethods.GET_SHARING_POLICY,
        summary="Get Tooling sharing policy",
        input_model=ToolingGetSharingPolicyRequest,
        output_model=ToolingGetSharingPolicyResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["legacy_sharing_policy"],
    )
    async def _on_get_sharing_policy(
        self, request: ToolingGetSharingPolicyRequest
    ) -> ToolingGetSharingPolicyResponse:
        """Return the current in-memory Tooling sharing policy."""

        return ToolingGetSharingPolicyResponse(policy=self._sharing_policy)

    @method_contract(
        method_id=ToolingMethods.SET_SHARING_POLICY,
        summary="Set Tooling sharing policy",
        input_model=ToolingSetSharingPolicyRequest,
        output_model=ToolingSetSharingPolicyResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["legacy_sharing_policy"],
    )
    async def _on_set_sharing_policy(
        self, request: ToolingSetSharingPolicyRequest
    ) -> ToolingSetSharingPolicyResponse:
        """Replace and persist the current Tooling sharing policy."""

        confirmation_error = self._policy_mode_confirmation_error(
            request.policy.policy_mode, request.confirmation_text
        )
        if confirmation_error:
            return ToolingSetSharingPolicyResponse(
                ok=False,
                policy=self._sharing_policy,
                error=confirmation_error,
                correlation_id=request.correlation_id,
            )
        previous_policy = self._sharing_policy
        persisted = await self._persist_sharing_policy_to_config(request.policy)
        if persisted:
            self._sharing_policy = request.policy
        else:
            self._sharing_policy = previous_policy
        await self._audit_tooling_event(
            "tooling.policy.set",
            principal_id=request.actor_principal_id,
            details={
                "correlation_id": request.correlation_id,
                "default_share": request.policy.default_share,
                "default_approval_mode": request.policy.default_approval_mode,
                "rule_count": len(request.policy.rules),
                "persisted": persisted,
            },
        )
        return ToolingSetSharingPolicyResponse(
            ok=persisted,
            policy=self._sharing_policy,
            error=None if persisted else "persist_failed",
            correlation_id=request.correlation_id,
        )

    @method_contract(
        method_id=ToolingMethods.GET_TOOL_EXPORT_POLICY,
        summary="Get independent Tooling export policy",
        input_model=ToolingGetToolExportPolicyRequest,
        output_model=ToolingGetToolExportPolicyResponse,
        exposure="both",
        method_type="use",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["export_policy_administration"],
    )
    async def _on_get_tool_export_policy(
        self,
        request: ToolingGetToolExportPolicyRequest,
        envelope: Any | None = None,
    ) -> ToolingGetToolExportPolicyResponse:
        """Return export authority without consulting approval/grant state."""

        read_error = self._reject_remote_export_management_read(envelope)
        if read_error:
            raise PermissionError(read_error)

        snapshot = await self._tool_export_snapshot(
            peer_id=request.peer_id,
            include_rules=request.include_rules,
            include_stale=request.include_stale,
        )
        await self._refresh_peer_display_names()
        return ToolingGetToolExportPolicyResponse(
            policy=snapshot.policy,
            rules=snapshot.rules,
            stale_tool_ids=snapshot.stale_tool_ids,
            stale_group_ids=snapshot.stale_group_ids,
            recipient_scopes=[
                ToolingExportRecipientScope(
                    peer_id=scope.peer_id,
                    display_name=self._peer_display_names.get(scope.peer_id)
                    or "Previously configured peer",
                    stale=scope.peer_id not in self._peer_export_current_ids,
                    rule_count=scope.rule_count,
                    last_rule_updated_at=scope.last_rule_updated_at,
                )
                for scope in snapshot.recipient_scopes
            ],
            mesh_switches=snapshot.mesh_switches.model_copy(
                update={"enforcement_active": self._mesh_projection_enforcement_active}
            ),
            secrets_redacted=True,
        )

    async def _export_mutation_preflight(
        self,
        *,
        envelope: Any | None,
        actor_principal_id: str,
        confirmation_text: str,
        expected_revision: int,
        correlation_id: str | None,
        response_type: type[ToolingExportMutationResponse],
    ) -> tuple[str | None, ToolingExportMutationResponse | None]:
        actor, error = self._export_mutation_actor_error(
            envelope, actor_principal_id, confirmation_text
        )
        if error:
            snapshot = await self._tool_export_snapshot(include_rules=False)
            return None, self._export_error_response(
                response_type,
                revision=snapshot.policy.revision,
                error=error,
                correlation_id=correlation_id,
            )
        if expected_revision < 0:
            snapshot = await self._tool_export_snapshot(include_rules=False)
            return None, self._export_error_response(
                response_type,
                revision=snapshot.policy.revision,
                error="invalid_expected_revision",
                correlation_id=correlation_id,
            )
        return actor, None

    @method_contract(
        method_id=ToolingMethods.SET_TOOL_EXPORT_DEFAULT,
        summary="Set the global Tooling export default",
        input_model=ToolingSetToolExportDefaultRequest,
        output_model=ToolingSetToolExportDefaultResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["export_policy_administration"],
    )
    async def _on_set_tool_export_default(
        self,
        request: ToolingSetToolExportDefaultRequest,
        envelope: Any | None = None,
    ) -> ToolingSetToolExportDefaultResponse:
        actor, error = await self._export_mutation_preflight(
            envelope=envelope,
            actor_principal_id=request.actor_principal_id,
            confirmation_text=request.confirmation_text,
            expected_revision=request.expected_revision,
            correlation_id=request.correlation_id,
            response_type=ToolingSetToolExportDefaultResponse,
        )
        if error:
            return ToolingSetToolExportDefaultResponse.model_validate(error)
        result = await self._mutate_tool_export_policy(
            DBMutateToolingExportPolicyRequest(
                action="set_default",
                expected_revision=request.expected_revision,
                state=request.state,
                actor_principal_id=actor,
                reason=request.reason,
                correlation_id=request.correlation_id,
            )
        )
        return ToolingSetToolExportDefaultResponse.model_validate(result.model_dump())

    @method_contract(
        method_id=ToolingMethods.UPSERT_TOOL_GROUP_EXPORT_POLICY,
        summary="Upsert a Tooling share-group export override",
        input_model=ToolingUpsertToolGroupExportPolicyRequest,
        output_model=ToolingUpsertToolGroupExportPolicyResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["export_policy_administration"],
    )
    async def _on_upsert_tool_group_export_policy(
        self,
        request: ToolingUpsertToolGroupExportPolicyRequest,
        envelope: Any | None = None,
    ) -> ToolingUpsertToolGroupExportPolicyResponse:
        actor, error = await self._export_mutation_preflight(
            envelope=envelope,
            actor_principal_id=request.actor_principal_id,
            confirmation_text=request.confirmation_text,
            expected_revision=request.expected_revision,
            correlation_id=request.correlation_id,
            response_type=ToolingUpsertToolGroupExportPolicyResponse,
        )
        if error:
            return ToolingUpsertToolGroupExportPolicyResponse.model_validate(error)
        known_groups = {
            identity.share_group_id
            for _, identity in self._local_export_authority_index().values()
            if identity.exportable
        }
        if request.share_group_id not in known_groups:
            snapshot = await self._tool_export_snapshot(include_rules=False)
            return ToolingUpsertToolGroupExportPolicyResponse.model_validate(
                self._export_error_response(
                    ToolingUpsertToolGroupExportPolicyResponse,
                    revision=snapshot.policy.revision,
                    error="unknown_or_nonexportable_share_group",
                    correlation_id=request.correlation_id,
                )
            )
        result = await self._mutate_tool_export_policy(
            DBMutateToolingExportPolicyRequest(
                action="upsert_rule",
                expected_revision=request.expected_revision,
                state=request.state,
                peer_id=request.peer_id,
                scope_type="group",
                scope_id=request.share_group_id,
                actor_principal_id=actor,
                reason=request.reason,
                correlation_id=request.correlation_id,
            )
        )
        return ToolingUpsertToolGroupExportPolicyResponse.model_validate(result.model_dump())

    @method_contract(
        method_id=ToolingMethods.UPSERT_TOOL_EXPORT_OVERRIDE,
        summary="Upsert an exact-tool export override",
        input_model=ToolingUpsertToolExportOverrideRequest,
        output_model=ToolingUpsertToolExportOverrideResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["export_policy_administration"],
    )
    async def _on_upsert_tool_export_override(
        self,
        request: ToolingUpsertToolExportOverrideRequest,
        envelope: Any | None = None,
    ) -> ToolingUpsertToolExportOverrideResponse:
        actor, error = await self._export_mutation_preflight(
            envelope=envelope,
            actor_principal_id=request.actor_principal_id,
            confirmation_text=request.confirmation_text,
            expected_revision=request.expected_revision,
            correlation_id=request.correlation_id,
            response_type=ToolingUpsertToolExportOverrideResponse,
        )
        if error:
            return ToolingUpsertToolExportOverrideResponse.model_validate(error)
        authority = self._local_export_authority_index().get(request.global_tool_id)
        if authority is None or not authority[1].exportable:
            snapshot = await self._tool_export_snapshot(include_rules=False)
            return ToolingUpsertToolExportOverrideResponse.model_validate(
                self._export_error_response(
                    ToolingUpsertToolExportOverrideResponse,
                    revision=snapshot.policy.revision,
                    error="unknown_or_nonexportable_tool",
                    correlation_id=request.correlation_id,
                )
            )
        result = await self._mutate_tool_export_policy(
            DBMutateToolingExportPolicyRequest(
                action="upsert_rule",
                expected_revision=request.expected_revision,
                state=request.state,
                peer_id=request.peer_id,
                scope_type="tool",
                scope_id=request.global_tool_id,
                actor_principal_id=actor,
                reason=request.reason,
                correlation_id=request.correlation_id,
            )
        )
        return ToolingUpsertToolExportOverrideResponse.model_validate(result.model_dump())

    @method_contract(
        method_id=ToolingMethods.CLEAR_TOOL_EXPORT_OVERRIDE,
        summary="Clear a Tooling export override to inherit",
        input_model=ToolingClearToolExportOverrideRequest,
        output_model=ToolingClearToolExportOverrideResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["export_policy_administration"],
    )
    async def _on_clear_tool_export_override(
        self,
        request: ToolingClearToolExportOverrideRequest,
        envelope: Any | None = None,
    ) -> ToolingClearToolExportOverrideResponse:
        actor, error = await self._export_mutation_preflight(
            envelope=envelope,
            actor_principal_id=request.actor_principal_id,
            confirmation_text=request.confirmation_text,
            expected_revision=request.expected_revision,
            correlation_id=request.correlation_id,
            response_type=ToolingClearToolExportOverrideResponse,
        )
        if error:
            return ToolingClearToolExportOverrideResponse.model_validate(error)
        result = await self._mutate_tool_export_policy(
            DBMutateToolingExportPolicyRequest(
                action="clear_rule",
                expected_revision=request.expected_revision,
                peer_id=request.peer_id,
                scope_type=request.scope_type,
                scope_id=request.scope_id,
                actor_principal_id=actor,
                reason=request.reason,
                correlation_id=request.correlation_id,
            )
        )
        return ToolingClearToolExportOverrideResponse.model_validate(result.model_dump())

    @method_contract(
        method_id=ToolingMethods.PREVIEW_TOOL_EXPORT_DECISION,
        summary="Preview a Tooling export decision without enforcement",
        input_model=ToolingPreviewToolExportDecisionRequest,
        output_model=ToolingPreviewToolExportDecisionResponse,
        exposure="both",
        method_type="use",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["export_policy_administration"],
    )
    async def _on_preview_tool_export_decision(
        self,
        request: ToolingPreviewToolExportDecisionRequest,
        envelope: Any | None = None,
    ) -> ToolingPreviewToolExportDecisionResponse:
        read_error = self._reject_remote_export_management_read(envelope)
        if read_error:
            raise PermissionError(read_error)
        snapshot = await self._tool_export_snapshot(peer_id=request.peer_id)
        authority = self._local_export_authority_index().get(request.global_tool_id)
        identity = authority[1] if authority is not None else None
        share_group_id = (
            identity.share_group_id
            if identity is not None
            else request.share_group_id or "unknown:stale"
        )
        stale_tool_id = request.global_tool_id in snapshot.stale_tool_ids or authority is None
        stale_group_id = share_group_id in snapshot.stale_group_ids
        prerequisites = await self._export_preview_prerequisites(
            peer_id=request.peer_id,
            authority=authority,
            mesh_switches=snapshot.mesh_switches,
        )
        decision = evaluate_tool_export_policy(
            policy=snapshot.policy,
            rules=snapshot.rules,
            peer_id=request.peer_id,
            global_tool_id=request.global_tool_id,
            share_group_id=share_group_id,
            exportable=bool(identity and identity.exportable),
            stale_tool_id=stale_tool_id,
            stale_group_id=stale_group_id,
            prerequisites=prerequisites,
        )
        return ToolingPreviewToolExportDecisionResponse(decision=decision)

    async def _export_preview_prerequisites(
        self,
        *,
        peer_id: str | None,
        authority: tuple[Any, LoadedToolIdentity] | None,
        mesh_switches: Any,
    ) -> ToolingExportPrerequisites:
        """Build secret-free prerequisite evidence from current typed authorities."""

        evidence: list[ToolingExportPrerequisiteEvidence] = []

        def record(
            key: str,
            value: bool | None,
            *,
            source: ToolingExportPrerequisiteSource,
            true_reason: str,
            false_reason: str,
            unknown_reason: str,
            required_permissions: list[str] | None = None,
            observed_permissions: list[str] | None = None,
            not_applicable: bool = False,
        ) -> None:
            state: ToolingExportPrerequisiteState
            if not_applicable:
                state = "not_applicable"
                reason_code = unknown_reason
            elif value is True:
                state = "satisfied"
                reason_code = true_reason
            elif value is False:
                state = "blocked"
                reason_code = false_reason
            else:
                state = "unknown"
                reason_code = unknown_reason
            evidence.append(
                ToolingExportPrerequisiteEvidence(
                    key=key,
                    state=state,
                    source=source,
                    reason_code=reason_code,
                    required_permissions=required_permissions or [],
                    observed_permissions=observed_permissions or [],
                )
            )

        identity = authority[1] if authority is not None else None
        local_exportable = bool(identity and identity.exportable)
        record(
            "local_exportable",
            local_exportable,
            source="tool_identity",
            true_reason="local_tool_exportable",
            false_reason="tool_not_local_exportable",
            unknown_reason="tool_identity_unknown",
        )

        provider_enabled = bool(mesh_switches.provider_mesh_tooling_enabled)
        consumer_enabled = bool(mesh_switches.consumer_mesh_tooling_enabled)
        record(
            "provider_mesh_tooling_enabled",
            provider_enabled,
            source="mesh_switch",
            true_reason="provider_mesh_tooling_enabled",
            false_reason="provider_mesh_tooling_disabled",
            unknown_reason="provider_mesh_tooling_unknown",
        )
        record(
            "consumer_mesh_tooling_enabled",
            consumer_enabled,
            source="mesh_switch",
            true_reason="consumer_mesh_tooling_enabled",
            false_reason="consumer_mesh_tooling_disabled",
            unknown_reason="consumer_switch_not_outbound_gate",
            not_applicable=True,
        )

        service_shared: bool | None = None
        unshared_methods: set[str] = set()
        unshared_features: set[str] = set()
        policy_snapshot = None
        current_policy = getattr(self.bus, "current_mesh_policy_snapshot", None)
        if callable(current_policy):
            try:
                policy_snapshot = current_policy()
                service_policy = policy_snapshot.mesh_config.services.get(ToolingModule.NAME)
                if service_policy is None:
                    service_shared = False
                else:
                    service_shared = bool(service_policy.export.share)
                    unshared_methods = set(service_policy.export.unshared_method_ids)
                    unshared_features = set(service_policy.export.unshared_feature_ids)
            except Exception as error:
                log_debug(f"Tooling export preview mesh policy unavailable: {error}")

        record(
            "service_shared",
            service_shared,
            source="mesh_policy",
            true_reason="tooling_service_shared",
            false_reason="tooling_service_not_shared",
            unknown_reason="mesh_policy_unavailable",
        )

        def method_shared(topic: str, feature_id: str) -> bool | None:
            if service_shared is None:
                return None
            return bool(
                service_shared
                and topic not in unshared_methods
                and feature_id not in unshared_features
            )

        def method_reason(topic: str, feature_id: str) -> str:
            if service_shared is False:
                return "tooling_service_not_shared"
            if topic in unshared_methods:
                return "tooling_method_not_shared"
            if feature_id in unshared_features:
                return "tooling_feature_not_shared"
            return "tooling_method_not_shared"

        method_specs = {
            "catalog_method_shared": (
                ToolingMethods.GET_EXPORT_CATALOG,
                "catalog_discovery",
            ),
            "discovery_method_shared": (ToolingMethods.GET_TOOLS, "catalog_discovery"),
            "prepare_method_shared": (ToolingMethods.PREPARE_EXECUTION, "execution"),
            "execute_method_shared": (ToolingMethods.EXECUTE_TOOL, "execution"),
        }
        method_values: dict[str, bool | None] = {}
        for key, (topic, feature_id) in method_specs.items():
            value = method_shared(topic, feature_id)
            method_values[key] = value
            record(
                key,
                value,
                source="mesh_policy",
                true_reason="tooling_method_shared",
                false_reason=method_reason(topic, feature_id),
                unknown_reason="mesh_policy_unavailable",
            )

        peer_permissions: list[str] | None = None
        peer_approved: bool | None = None
        if peer_id is not None:
            try:
                peer_result = await self.bus.request(
                    AuthMethods.MESH_GET_PEER,
                    MeshPeerGetRequest(peer_id=peer_id),
                    origin="internal",
                    timeout=5.0,
                    priority=get_interactive_priority(),
                )
                if (
                    isinstance(getattr(peer_result, "ok", None), bool)
                    and peer_result.ok
                    and peer_result.data is not None
                ):
                    peer_response = MeshPeerGetResponse.model_validate(peer_result.data)
                    if peer_response.peer is not None:
                        peer_approved = peer_response.peer.outbound_status == "approved"
                        peer_permissions = sorted(
                            {
                                str(permission)
                                for permission in peer_response.peer.outbound_permissions
                            }
                        )
                    else:
                        peer_approved = False
                        peer_permissions = []
            except Exception as error:
                log_debug(f"Tooling export preview peer authority unavailable: {error}")

        tool_required_permissions: list[str] = []
        if authority is not None:
            tool_info = self._serialize_tool(authority[0], ToolingGetToolsRequest(top_k=1))
            tool_required_permissions = sorted(set(tool_info.required_permissions))

        rbac_specs = {
            "peer_catalog_rbac": [ToolingMethods.GET_TOOLS],
            "peer_discovery_rbac": [ToolingMethods.GET_TOOLS],
            "peer_prepare_rbac": [ToolingMethods.EXECUTE_TOOL],
            "peer_execute_rbac": [ToolingMethods.EXECUTE_TOOL],
        }
        rbac_values: dict[str, bool | None] = {}
        for key, required in rbac_specs.items():
            value = None
            if peer_id is not None and peer_approved is not None and peer_permissions is not None:
                value = bool(
                    peer_approved
                    and all(
                        permission_satisfies(permission, peer_permissions)
                        for permission in required
                    )
                )
            rbac_values[key] = value
            record(
                key,
                value,
                source="peer_authority",
                true_reason="peer_permission_granted",
                false_reason=(
                    "peer_not_approved" if peer_approved is False else "peer_permission_missing"
                ),
                unknown_reason=(
                    "peer_scope_required" if peer_id is None else "peer_authority_unavailable"
                ),
                required_permissions=required,
                observed_permissions=peer_permissions,
            )

        required_granted: bool | None = None
        if not local_exportable:
            required_granted = False
        elif peer_id is not None and peer_approved is not None and peer_permissions is not None:
            required_granted = bool(
                peer_approved
                and all(
                    permission_satisfies(permission, peer_permissions)
                    for permission in tool_required_permissions
                )
            )
        record(
            "tool_required_permissions_granted",
            required_granted,
            source="peer_authority" if local_exportable else "tool_identity",
            true_reason="tool_permissions_granted",
            false_reason=(
                "tool_not_local_exportable"
                if not local_exportable
                else ("peer_not_approved" if peer_approved is False else "tool_permission_missing")
            ),
            unknown_reason=(
                "peer_scope_required" if peer_id is None else "peer_authority_unavailable"
            ),
            required_permissions=tool_required_permissions,
            observed_permissions=peer_permissions,
        )
        record(
            "enforcement_active",
            self._mesh_projection_enforcement_active,
            source="runtime",
            true_reason="mesh_projection_enforcement_active",
            false_reason="mesh_projection_enforcement_inactive",
            unknown_reason="mesh_projection_enforcement_unknown",
        )

        return ToolingExportPrerequisites(
            local_exportable=local_exportable,
            provider_mesh_tooling_enabled=provider_enabled,
            consumer_mesh_tooling_enabled=consumer_enabled,
            service_shared=service_shared,
            catalog_method_shared=method_values["catalog_method_shared"],
            discovery_method_shared=method_values["discovery_method_shared"],
            prepare_method_shared=method_values["prepare_method_shared"],
            execute_method_shared=method_values["execute_method_shared"],
            peer_catalog_rbac=rbac_values["peer_catalog_rbac"],
            peer_discovery_rbac=rbac_values["peer_discovery_rbac"],
            peer_prepare_rbac=rbac_values["peer_prepare_rbac"],
            peer_execute_rbac=rbac_values["peer_execute_rbac"],
            tool_required_permissions_granted=required_granted,
            enforcement_active=self._mesh_projection_enforcement_active,
            evidence=evidence,
        )

    async def _prepare_execution_response(
        self,
        request: ToolingExecuteToolRequest,
        *,
        caller_permissions: list[str] | None = None,
        envelope: Any | None = None,
    ) -> ToolingPrepareExecutionResponse:
        if not await self._consumer_mesh_execution_authorized(request):
            provider_peer_id, service_instance_id, _, _ = self._provider_context(request)
            decision = ToolingPolicyDecision(
                allowed=False,
                share=False,
                approval_required=False,
                approval_mode=self._sharing_policy.default_approval_mode,
                decision_id=uuid.uuid4().hex,
                reason="permission_denied",
            )
            return ToolingPrepareExecutionResponse(
                ok=False,
                policy_decision=decision,
                args_hash=self._arguments_fingerprint(request.arguments),
                resource_selector_hash=self._resource_selector_fingerprint(request),
                route_decision_id=self._route_decision_id(
                    request,
                    provider_peer_id=provider_peer_id,
                    service_instance_id=service_instance_id,
                ),
                correlation_id=request.correlation_id or uuid.uuid4().hex,
                provider_peer_id=provider_peer_id,
                provider_service_instance_id=service_instance_id,
                global_tool_id="",
                local_tool_name="",
                display_args_preview={},
                argument_visibility={},
                secrets_redacted=True,
            )
        (
            tool,
            local_tool_name,
            provider_peer_id,
            service_instance_id,
            global_tool_id,
        ) = await self._resolve_execution_context(request)
        if not tool:
            decision = ToolingPolicyDecision(
                allowed=False,
                share=False,
                approval_required=False,
                approval_mode=self._sharing_policy.default_approval_mode,
                decision_id=uuid.uuid4().hex,
                reason="tool_not_found",
            )
            return ToolingPrepareExecutionResponse(
                ok=False,
                policy_decision=decision,
                args_hash=self._arguments_fingerprint(request.arguments),
                resource_selector_hash=self._resource_selector_fingerprint(request),
                route_decision_id=self._route_decision_id(
                    request,
                    provider_peer_id=provider_peer_id,
                    service_instance_id=service_instance_id,
                ),
                correlation_id=request.correlation_id or uuid.uuid4().hex,
                provider_peer_id=provider_peer_id,
                provider_service_instance_id=service_instance_id,
                global_tool_id=global_tool_id,
                local_tool_name=local_tool_name,
                display_args_preview=self._display_arguments_preview(request.arguments),
                argument_visibility={},
                secrets_redacted=True,
            )
        if not await self._provider_mesh_execution_authorized(tool, envelope):
            return self._permission_denied_prepared_response(
                request,
                tool=tool,
                local_tool_name=local_tool_name,
                provider_peer_id=provider_peer_id,
                service_instance_id=service_instance_id,
                global_tool_id=global_tool_id,
            )
        required_permissions = self._tool_required_permissions(tool, request.arguments)
        if not self._has_required_permissions(required_permissions, caller_permissions):
            return self._permission_denied_prepared_response(
                request,
                tool=tool,
                local_tool_name=local_tool_name,
                provider_peer_id=provider_peer_id,
                service_instance_id=service_instance_id,
                global_tool_id=global_tool_id,
            )
        return self._prepared_execution(
            request,
            tool=tool,
            local_tool_name=local_tool_name,
            provider_peer_id=provider_peer_id,
            service_instance_id=service_instance_id,
            global_tool_id=global_tool_id,
            legacy_share_authoritative=not bool(
                self._mesh_projection_enforcement_active
                and getattr(envelope, "caller_peer_id", None)
            ),
        )

    async def _consumer_mesh_execution_authorized(
        self,
        request: ToolingExecuteToolRequest,
    ) -> bool:
        """Require a current committed consumer projection for remote selectors."""

        selector = request.mesh_selector
        target_peer = self._selector_target_peer(request)
        if not selector or not target_peer or self._is_local_provider(target_peer):
            return True
        outbound_permissions = await self._current_peer_outbound_permissions(target_peer)
        if outbound_permissions is None or self._missing_required_permissions(
            [ToolingMethods.EXECUTE_TOOL], outbound_permissions
        ):
            return False
        if not self._mesh_projection_enforcement_active:
            # The legacy sharing-policy guard remains authoritative until the
            # durable cutover, but current Auth authority always applies.
            return True
        candidate = next(
            (
                item
                for item in self._remote_tooling_candidates()
                if str(getattr(getattr(item, "peer", None), "peer_id", "")) == target_peer
            ),
            None,
        )
        if (
            candidate is None
            or not bool(getattr(candidate, "eligible", False))
            or self._candidate_granted_permissions(candidate) is None
        ):
            # A retained committed row is not live authority after restart or
            # disconnect. Gateway must supply a fresh verified manifest/grant
            # projection before prepare or execute can proceed.
            return False
        for snapshot in await self._load_normalized_bindable_remote_catalogs():
            if snapshot.peer_id != target_peer:
                continue
            if (
                selector.service_instance_id
                and snapshot.service_instance_id != selector.service_instance_id
            ):
                continue
            requested_names = {request.tool_name}
            if selector.tool_id:
                requested_names.add(selector.tool_id)
            for candidate in snapshot.tools:
                if requested_names.intersection(
                    {
                        candidate.name,
                        candidate.local_name,
                        candidate.global_tool_id,
                        candidate.display_name,
                        *candidate.aliases,
                    }
                ):
                    return True
        return False

    async def _provider_mesh_execution_authorized(
        self,
        tool: Any,
        envelope: Any | None,
    ) -> bool:
        """Re-evaluate current recipient export authority before approval state."""

        recipient = getattr(envelope, "caller_peer_id", None)
        if not self._mesh_projection_enforcement_active:
            return True
        if not recipient or recipient in {"local", self._stable_peer_id}:
            return True
        permissions = getattr(envelope, "effective_perms", None)
        auth_revision = int(getattr(envelope, "auth_grant_revision", 0) or 0)
        manifest_revision = int(getattr(envelope, "manifest_revision", 0) or 0)
        if not isinstance(permissions, list) or auth_revision < 1 or manifest_revision < 1:
            return False
        snapshot = await self._tool_export_snapshot(peer_id=recipient)
        if not snapshot.mesh_switches.provider_mesh_tooling_enabled:
            return False
        candidate = self._serialize_tool(tool, ToolingGetToolsRequest(top_k=1))
        visible, _ = build_recipient_projection(
            [candidate],
            context=ProjectionContext(
                recipient_peer_id=recipient,
                recipient_permissions=tuple(str(item) for item in permissions),
                authority_revision=ToolingProjectionAuthorityRevision(
                    catalog_revision=0,
                    export_policy_revision=snapshot.policy.revision,
                    auth_grant_revision=auth_revision,
                    manifest_revision=manifest_revision,
                    switch_revision=snapshot.mesh_switches.revision,
                ),
                provider_enabled=True,
                service_exported=True,
                discovery_exported=True,
                execution_exported=True,
            ),
            policy=snapshot.policy,
            rules=snapshot.rules,
            stale_tool_ids=snapshot.stale_tool_ids,
            stale_group_ids=snapshot.stale_group_ids,
        )
        return any(item.global_tool_id == candidate.global_tool_id for item in visible)

    @method_contract(
        method_id=ToolingMethods.TEST_SHARING_POLICY,
        summary="Test Tooling sharing policy for an execution",
        input_model=ToolingTestSharingPolicyRequest,
        output_model=ToolingTestSharingPolicyResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["legacy_sharing_policy"],
    )
    async def _on_test_sharing_policy(
        self, request: ToolingTestSharingPolicyRequest, envelope: Any | None = None
    ) -> ToolingTestSharingPolicyResponse:
        """Evaluate Tooling sharing policy without creating approval state."""

        caller_permissions = await self._execution_caller_permissions(request, envelope)
        prepared = await self._prepare_execution_response(
            request, caller_permissions=caller_permissions, envelope=envelope
        )
        return ToolingTestSharingPolicyResponse(**prepared.model_dump())

    @method_contract(
        method_id=ToolingMethods.PREPARE_EXECUTION,
        summary="Prepare a Tooling execution and return policy binding",
        input_model=ToolingPrepareExecutionRequest,
        output_model=ToolingPrepareExecutionResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.EXECUTE_TOOL],
        callable_feature_ids=["execution"],
    )
    async def _on_prepare_execution(
        self, request: ToolingPrepareExecutionRequest, envelope: Any | None = None
    ) -> ToolingPrepareExecutionResponse:
        """Prepare execution and emit an audit record for the decision."""

        if not await self._provider_rpc_execution_authorized(
            request, envelope, ToolingMethods.PREPARE_EXECUTION
        ):
            return self._generic_permission_denied_prepare(request)
        caller_permissions = await self._execution_caller_permissions(request, envelope)
        prepared = await self._prepare_execution_response(
            request, caller_permissions=caller_permissions, envelope=envelope
        )
        await self._audit_tooling_event(
            "tooling.execution.prepare",
            principal_id=request.caller_principal_id,
            details={
                "correlation_id": prepared.correlation_id,
                "decision_id": prepared.policy_decision.decision_id,
                "approval_required": prepared.policy_decision.approval_required,
                "approval_mode": prepared.policy_decision.approval_mode,
                "allowed": prepared.policy_decision.allowed,
                "global_tool_id": prepared.global_tool_id,
                "provider_peer_id": prepared.provider_peer_id,
            },
        )
        return prepared

    def _generic_permission_denied_prepare(
        self, request: ToolingPrepareExecutionRequest
    ) -> ToolingPrepareExecutionResponse:
        return ToolingPrepareExecutionResponse(
            ok=False,
            policy_decision=ToolingPolicyDecision(
                allowed=False,
                share=False,
                approval_required=False,
                approval_mode=self._sharing_policy.default_approval_mode,
                decision_id=uuid.uuid4().hex,
                reason="permission_denied",
            ),
            args_hash=self._arguments_fingerprint(request.arguments),
            resource_selector_hash=self._resource_selector_fingerprint(request),
            route_decision_id="permission_denied",
            correlation_id=request.correlation_id or uuid.uuid4().hex,
            provider_peer_id="",
            provider_service_instance_id="",
            global_tool_id="",
            local_tool_name="",
            display_args_preview={},
            argument_visibility={},
        )

    @method_contract(
        method_id=ToolingMethods.REQUEST_APPROVAL,
        summary="Request Tooling execution approval",
        input_model=ToolingRequestApprovalRequest,
        output_model=ToolingRequestApprovalResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.EXECUTE_TOOL],
        callable_feature_ids=["execution"],
    )
    async def _on_request_approval(
        self, request: ToolingRequestApprovalRequest, envelope: Any | None = None
    ) -> ToolingRequestApprovalResponse:
        """Create a pending approval request for an approval-required execution."""

        if not await self._provider_rpc_execution_authorized(
            request, envelope, ToolingMethods.REQUEST_APPROVAL
        ):
            denied = self._generic_permission_denied_prepare(request)
            return ToolingRequestApprovalResponse(
                ok=False,
                policy_decision=denied.policy_decision,
                correlation_id=denied.correlation_id,
                error="permission_denied",
            )

        caller_permissions = await self._execution_caller_permissions(request, envelope)
        prepared = await self._prepare_execution_response(
            request, caller_permissions=caller_permissions, envelope=envelope
        )
        decision = prepared.policy_decision
        if not decision.allowed:
            await self._audit_tooling_event(
                "tooling.approval.denied",
                principal_id=request.caller_principal_id,
                details={
                    "correlation_id": prepared.correlation_id,
                    "decision_id": decision.decision_id,
                    "reason": decision.reason,
                    "global_tool_id": prepared.global_tool_id,
                },
            )
            return ToolingRequestApprovalResponse(
                ok=False,
                policy_decision=decision,
                correlation_id=prepared.correlation_id,
                error=decision.reason or "policy_denied",
            )
        if not decision.approval_required:
            return ToolingRequestApprovalResponse(
                ok=True,
                approval_request_id=None,
                policy_decision=decision,
                expires_at=None,
                correlation_id=prepared.correlation_id,
            )

        approval_request_id = uuid.uuid4().hex
        expires_at = time.time() + decision.token_ttl_seconds
        self._approval_requests[approval_request_id] = {
            "request": request.model_copy(deep=True),
            "prepared": prepared.model_copy(deep=True),
            "expires_at": expires_at,
            "used": False,
            "created_at": time.time(),
        }
        await self._persist_approval_request(approval_request_id, request, prepared, expires_at)
        await self._audit_tooling_event(
            "tooling.approval.requested",
            principal_id=request.caller_principal_id,
            details={
                "approval_request_id": approval_request_id,
                "correlation_id": prepared.correlation_id,
                "decision_id": decision.decision_id,
                "global_tool_id": prepared.global_tool_id,
                "provider_peer_id": prepared.provider_peer_id,
            },
        )
        return ToolingRequestApprovalResponse(
            ok=True,
            approval_request_id=approval_request_id,
            policy_decision=decision,
            expires_at=expires_at,
            correlation_id=prepared.correlation_id,
        )

    @method_contract(
        method_id=ToolingMethods.CONFIRM_EXECUTION,
        summary="Confirm Tooling execution and issue an approval token",
        input_model=ToolingConfirmExecutionRequest,
        output_model=ToolingConfirmExecutionResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["approval_administration"],
    )
    async def _on_confirm_execution(
        self, request: ToolingConfirmExecutionRequest, envelope: Any | None = None
    ) -> ToolingConfirmExecutionResponse:
        """Approve or deny a pending execution request."""

        approver_principal_id = (
            self._authoritative_actor_principal(envelope, request.approver_principal_id)
            or request.approver_principal_id
        )
        pending = await self._load_approval_request(request.approval_request_id)
        if not pending:
            return ToolingConfirmExecutionResponse(
                ok=False,
                correlation_id=request.correlation_id,
                error="approval_request_not_found",
            )
        prepared: ToolingPrepareExecutionResponse = pending["prepared"]
        original_request: ToolingExecuteToolRequest = pending["request"]
        correlation_id = request.correlation_id or prepared.correlation_id
        if pending["used"]:
            return ToolingConfirmExecutionResponse(
                ok=False,
                correlation_id=correlation_id,
                error="approval_request_replayed",
            )
        if float(pending["expires_at"]) <= time.time():
            await self._audit_tooling_event(
                "tooling.approval.expired",
                principal_id=approver_principal_id,
                details={
                    "approval_request_id": request.approval_request_id,
                    "correlation_id": correlation_id,
                    "decision_id": prepared.policy_decision.decision_id,
                },
            )
            return ToolingConfirmExecutionResponse(
                ok=False,
                correlation_id=correlation_id,
                error="approval_request_expired",
            )
        durable_scope_requested = request.grant_scope != "once"
        owner_bound = any(
            (
                original_request.caller_principal_id,
                original_request.caller_device_id,
                original_request.caller_peer_id,
            )
        )
        schedule_bound = bool(original_request.schedule_id)
        if durable_scope_requested and not owner_bound and not schedule_bound:
            return ToolingConfirmExecutionResponse(
                ok=False,
                correlation_id=correlation_id,
                policy_decision_id=prepared.policy_decision.decision_id,
                error="approval_owner_required_for_durable_grant",
            )
        pending["used"] = True
        await self._mark_approval_request_used(request.approval_request_id)
        if not request.approve:
            deny_grant: ToolingApprovalGrant | None = None
            if request.grant_scope in {"deny_once", "deny_always"}:
                deny_grant = await self._create_grant_from_request(
                    ToolingCreateApprovalGrantRequest(
                        grant_scope=request.grant_scope,
                        grant_type="trust",
                        principal_id=original_request.caller_principal_id,
                        caller_device_id=original_request.caller_device_id,
                        caller_peer_id=original_request.caller_peer_id,
                        provider_peer_id=prepared.provider_peer_id,
                        provider_service_instance_id=prepared.provider_service_instance_id,
                        global_tool_id=prepared.global_tool_id,
                        local_tool_name=prepared.local_tool_name,
                        args_hash=prepared.args_hash,
                        resource_selector_hash=prepared.resource_selector_hash,
                        route_decision_id=prepared.route_decision_id,
                        schedule_id=original_request.schedule_id,
                        trust_tier="blocked",
                        include_future_tools=request.include_future_tools,
                        created_by=approver_principal_id,
                        expires_at=request.expires_at,
                        reason=request.reason,
                        metadata={
                            "approval_request_id": request.approval_request_id,
                            "source_id": self._source_id_for_prepared(prepared),
                            "source_type": prepared.source,
                            "scheduled_action_hash": original_request.scheduled_action_hash,
                        },
                        correlation_id=correlation_id,
                    )
                )
            await self._audit_tooling_event(
                "tooling.approval.denied",
                principal_id=approver_principal_id,
                details={
                    "approval_request_id": request.approval_request_id,
                    "correlation_id": correlation_id,
                    "decision_id": prepared.policy_decision.decision_id,
                    "reason": request.reason,
                    "grant_id": deny_grant.grant_id if deny_grant else None,
                    "grant_scope": request.grant_scope,
                },
            )
            return ToolingConfirmExecutionResponse(
                ok=False,
                correlation_id=correlation_id,
                policy_decision_id=prepared.policy_decision.decision_id,
                error="approval_denied",
            )

        token = secrets.token_urlsafe(32)
        claims = self._approval_token_claims(
            original_request,
            prepared=prepared,
            approver_principal_id=approver_principal_id,
        )
        self._approval_tokens[token] = claims
        await self._persist_approval_token(token, claims)
        grant: ToolingApprovalGrant | None = None
        if request.grant_scope != "once":
            grant = await self._create_grant_from_request(
                ToolingCreateApprovalGrantRequest(
                    grant_scope=request.grant_scope,
                    grant_type=(
                        "scheduled_execution"
                        if request.grant_scope == "scheduled_execution"
                        else "approval"
                    ),
                    principal_id=original_request.caller_principal_id,
                    caller_device_id=original_request.caller_device_id,
                    caller_peer_id=original_request.caller_peer_id,
                    provider_peer_id=prepared.provider_peer_id,
                    provider_service_instance_id=prepared.provider_service_instance_id,
                    global_tool_id=prepared.global_tool_id,
                    local_tool_name=prepared.local_tool_name,
                    args_hash=prepared.args_hash,
                    resource_selector_hash=prepared.resource_selector_hash,
                    route_decision_id=prepared.route_decision_id,
                    schedule_id=original_request.schedule_id,
                    include_future_tools=request.include_future_tools,
                    created_by=approver_principal_id,
                    expires_at=request.expires_at or claims["expires_at"],
                    reason=request.reason,
                    metadata={
                        "approval_request_id": request.approval_request_id,
                        "source_id": self._source_id_for_prepared(prepared),
                        "source_type": prepared.source,
                        "scheduled_action_hash": original_request.scheduled_action_hash,
                    },
                    correlation_id=correlation_id,
                )
            )
            await self._audit_tooling_event(
                "tooling.approval.grant_created",
                principal_id=approver_principal_id,
                details={
                    "approval_request_id": request.approval_request_id,
                    "correlation_id": correlation_id,
                    "decision_id": prepared.policy_decision.decision_id,
                    "grant_id": grant.grant_id,
                    "grant_scope": grant.grant_scope,
                    "grant_type": grant.grant_type,
                    "global_tool_id": grant.global_tool_id,
                    "provider_peer_id": grant.provider_peer_id,
                },
            )
        await self._audit_tooling_event(
            "tooling.approval.approved",
            principal_id=approver_principal_id,
            details={
                "approval_request_id": request.approval_request_id,
                "correlation_id": correlation_id,
                "decision_id": prepared.policy_decision.decision_id,
                "global_tool_id": prepared.global_tool_id,
                "provider_peer_id": prepared.provider_peer_id,
                "expires_at": claims["expires_at"],
            },
        )
        return ToolingConfirmExecutionResponse(
            ok=True,
            approval_token=token,
            expires_at=claims["expires_at"],
            policy_decision_id=prepared.policy_decision.decision_id,
            correlation_id=correlation_id,
        )

    @method_contract(
        method_id=ToolingMethods.LIST_APPROVAL_GRANTS,
        summary="List durable Tooling approval grants",
        input_model=ToolingListApprovalGrantsRequest,
        output_model=ToolingListApprovalGrantsResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["approval_administration"],
    )
    async def _on_list_approval_grants(
        self, request: ToolingListApprovalGrantsRequest
    ) -> ToolingListApprovalGrantsResponse:
        await self._expire_approval_grants()
        if not self._tooling_policy_tables_ready:
            return ToolingListApprovalGrantsResponse(grants=[], count=0)
        clauses = []
        params: list[Any] = []
        if not request.include_revoked:
            clauses.append("revoked_at IS NULL")
            clauses.append("active = 1")
        if request.principal_id:
            clauses.append("(principal_id IS NULL OR principal_id = ?)")
            params.append(request.principal_id)
        if request.provider_peer_id:
            clauses.append("(provider_peer_id IS NULL OR provider_peer_id = ?)")
            params.append(request.provider_peer_id)
        if request.global_tool_id:
            clauses.append("(global_tool_id IS NULL OR global_tool_id = ?)")
            params.append(request.global_tool_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = await self._db_sql(
            f"SELECT * FROM tooling_approval_grants {where} ORDER BY created_at DESC",
            params,
        )
        grants = [self._grant_from_row(row) for row in rows]
        return ToolingListApprovalGrantsResponse(grants=grants, count=len(grants))

    @method_contract(
        method_id=ToolingMethods.CREATE_APPROVAL_GRANT,
        summary="Create a durable Tooling approval grant",
        input_model=ToolingCreateApprovalGrantRequest,
        output_model=ToolingCreateApprovalGrantResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["approval_administration"],
    )
    async def _on_create_approval_grant(
        self, request: ToolingCreateApprovalGrantRequest, envelope: Any | None = None
    ) -> ToolingCreateApprovalGrantResponse:
        try:
            created_by = self._authoritative_actor_principal(envelope, request.created_by)
            if created_by and created_by != request.created_by:
                request = request.model_copy(update={"created_by": created_by})
            grant = await self._create_grant_from_request(request)
            await self._audit_tooling_event(
                "tooling.approval.grant_created",
                principal_id=request.created_by,
                details={
                    "grant_id": grant.grant_id,
                    "grant_scope": grant.grant_scope,
                    "grant_type": grant.grant_type,
                    "global_tool_id": grant.global_tool_id,
                    "provider_peer_id": grant.provider_peer_id,
                    "correlation_id": request.correlation_id,
                },
            )
            return ToolingCreateApprovalGrantResponse(
                ok=True, grant=grant, correlation_id=request.correlation_id
            )
        except Exception as error:
            return ToolingCreateApprovalGrantResponse(
                ok=False, error=str(error), correlation_id=request.correlation_id
            )

    @method_contract(
        method_id=ToolingMethods.REVOKE_APPROVAL_GRANT,
        summary="Revoke a durable Tooling approval grant",
        input_model=ToolingRevokeApprovalGrantRequest,
        output_model=ToolingRevokeApprovalGrantResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["approval_administration"],
    )
    async def _on_revoke_approval_grant(
        self, request: ToolingRevokeApprovalGrantRequest, envelope: Any | None = None
    ) -> ToolingRevokeApprovalGrantResponse:
        try:
            revoked_by = self._authoritative_actor_principal(envelope, request.revoked_by)
            if revoked_by and revoked_by != request.revoked_by:
                request = request.model_copy(update={"revoked_by": revoked_by})
            await self._ensure_tooling_policy_tables()
            if not self._tooling_policy_tables_ready:
                raise RuntimeError("tooling_policy_storage_unavailable")
            await self._db_sql(
                """
                UPDATE tooling_approval_grants
                SET active = 0, revoked_at = ?, reason = COALESCE(?, reason)
                WHERE grant_id = ?
                """,
                [time.time(), request.reason, request.grant_id],
            )
            await self._audit_tooling_event(
                "tooling.approval.grant_revoked",
                principal_id=request.revoked_by,
                details={
                    "grant_id": request.grant_id,
                    "reason": request.reason,
                    "correlation_id": request.correlation_id,
                },
            )
            return ToolingRevokeApprovalGrantResponse(
                ok=True, grant_id=request.grant_id, correlation_id=request.correlation_id
            )
        except Exception as error:
            return ToolingRevokeApprovalGrantResponse(
                ok=False,
                grant_id=request.grant_id,
                error=str(error),
                correlation_id=request.correlation_id,
            )

    @method_contract(
        method_id=ToolingMethods.EVALUATE_APPROVAL_GRANT,
        summary="Evaluate durable Tooling approval grants for an execution",
        input_model=ToolingEvaluateApprovalGrantRequest,
        output_model=ToolingEvaluateApprovalGrantResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.EXECUTE_TOOL],
        callable_feature_ids=["execution"],
    )
    async def _on_evaluate_approval_grant(
        self, request: ToolingEvaluateApprovalGrantRequest, envelope: Any | None = None
    ) -> ToolingEvaluateApprovalGrantResponse:
        caller_permissions = await self._execution_caller_permissions(request, envelope)
        prepared = await self._prepare_execution_response(
            request, caller_permissions=caller_permissions, envelope=envelope
        )
        if not prepared.ok:
            return ToolingEvaluateApprovalGrantResponse(
                ok=False,
                policy_decision=prepared.policy_decision,
                reason=prepared.policy_decision.reason,
                correlation_id=prepared.correlation_id,
            )
        grant = await self._find_matching_grant(request, prepared)
        blocking_grant = await self._find_matching_blocking_grant(request, prepared)
        policy_grant = await self._find_matching_policy_grant(request, prepared)
        if policy_grant is not None:
            # Explicit per-tool policy wins over source policy; source policy
            # wins over the global approval default. Ordinary one-shot/session
            # grants remain independent and can satisfy an untrusted policy.
            if grant is not None and grant.metadata.get("policy_scope") in {
                "source",
                "tool",
            }:
                grant = None
            if blocking_grant is not None and blocking_grant.metadata.get("policy_scope") in {
                "source",
                "tool",
            }:
                blocking_grant = None
            if policy_grant.trust_tier == "blocked":
                blocking_grant = policy_grant
            elif policy_grant.trust_tier == "trusted":
                grant = policy_grant
        if blocking_grant:
            prepared.policy_decision.allowed = False
            prepared.policy_decision.approval_required = False
            prepared.policy_decision.grant_id = blocking_grant.grant_id
            prepared.policy_decision.grant_scope = blocking_grant.grant_scope
            prepared.policy_decision.reason = "tool_blocked"
            return ToolingEvaluateApprovalGrantResponse(
                ok=False,
                grant=blocking_grant,
                policy_decision=prepared.policy_decision,
                reason="tool_blocked",
                correlation_id=prepared.correlation_id,
            )
        if grant:
            prepared.policy_decision.grant_id = grant.grant_id
            prepared.policy_decision.grant_scope = grant.grant_scope
            prepared.policy_decision.auto_approved_reason = "approval_grant"
        return ToolingEvaluateApprovalGrantResponse(
            ok=grant is not None,
            grant=grant,
            policy_decision=prepared.policy_decision,
            reason=None if grant else "approval_required",
            correlation_id=prepared.correlation_id,
        )

    async def _tool_source_summaries(
        self, request: ToolingListToolSourcesRequest
    ) -> tuple[list[ToolingToolSourceSummary], ToolingGetToolCatalogResponse]:
        """Build source-first read models from the safe aggregate catalog."""

        catalog = await self._on_get_tool_catalog(
            ToolingGetToolCatalogRequest(
                top_k=1000,
                include_blocked_tools=request.include_blocked_tools,
                # These are Tooling.manage read models. Contract enforcement
                # already authorizes the admin caller, so inventory must show
                # every local tool while remote tools remain gated by each
                # provider's recipient-specific manifest grants.
                caller_permissions=(
                    request.caller_permissions if request.caller_permissions is not None else ["*"]
                ),
            )
        )
        normalized_headers, normalized_retained = await self._load_normalized_management_catalog()
        summaries: dict[str, ToolingToolSourceSummary] = {}
        known_tool_ids: dict[str, set[str]] = {}
        bindable_tool_ids: dict[str, set[str]] = {}
        blocking_reasons_by_source: dict[str, dict[str, str]] = {}
        for provider in catalog.providers:
            source_id = (
                f"mesh:{provider.provider_peer_id}:"
                f"{self._safe_identifier(provider.provider_service_instance_id)}"
                if provider.provider_kind == "mesh_peer"
                else "local:core"
            )
            summaries.setdefault(
                source_id, self._empty_source_summary(source_id, provider=provider)
            )

        for tool in catalog.tools:
            source_id = self._source_id_for_tool(tool)
            summary = summaries.setdefault(
                source_id, self._empty_source_summary(source_id, tool=tool)
            )
            source_tool_ids = known_tool_ids.setdefault(source_id, set())
            if tool.global_tool_id not in source_tool_ids:
                source_tool_ids.add(tool.global_tool_id)
                summary.tool_count += 1
            bindable_tool_ids.setdefault(source_id, set()).add(tool.global_tool_id)
            if tool.trust_tier == "blocked":
                summary.status = "blocked"
                summary.trust_tier = "blocked"
            elif summary.trust_tier != "blocked" and tool.trust_tier == "trusted":
                summary.trust_tier = "trusted"

        for blocked in catalog.blocked_tools:
            source_id = self._source_id_for_tool(blocked.tool)
            summary = summaries.setdefault(
                source_id, self._empty_source_summary(source_id, tool=blocked.tool)
            )
            source_tool_ids = known_tool_ids.setdefault(source_id, set())
            if blocked.tool.global_tool_id not in source_tool_ids:
                source_tool_ids.add(blocked.tool.global_tool_id)
                summary.tool_count += 1
            summary.blocked_tool_count += 1
            if blocked.reason_code == "tool_blocked":
                summary.status = "blocked"
                summary.trust_tier = "blocked"
            summary.reason_code = summary.reason_code or blocked.reason_code
            summary.reason = summary.reason or blocked.reason
            blocking_reasons_by_source.setdefault(source_id, {}).setdefault(
                blocked.reason_code, blocked.reason
            )

        normalized_source_ids = {item.source_id for item in normalized_retained} | {
            f"mesh:{peer_id}:{self._safe_identifier(str(header['service_instance_id']))}"
            for (peer_id, _provider_id), header in normalized_headers.items()
        }
        for snapshot, updated_at in self._remote_catalog_snapshots.values():
            source_id = (
                f"mesh:{snapshot.peer_id}:{self._safe_identifier(snapshot.service_instance_id)}"
            )
            if source_id in normalized_source_ids:
                continue
            summary = summaries.setdefault(
                source_id,
                ToolingToolSourceSummary(
                    source_id=source_id,
                    source="mesh_peer",
                    display_name=self._peer_display_name(snapshot.peer_id),
                    provider_peer_id=snapshot.peer_id,
                    provider_service_instance_id=snapshot.service_instance_id,
                    provider_label=self._peer_display_name(snapshot.peer_id),
                    provider_kind="mesh_peer",
                    trust_tier="untrusted",
                    cache_status="hit",
                ),
            )
            summary.catalog_epoch = snapshot.catalog_epoch
            summary.catalog_hash = snapshot.full_schema_hash
            summary.generated_at = snapshot.generated_at
            summary.updated_at = updated_at
            summary.shared_by_policy = snapshot.shared_by_policy
            if not snapshot.shared_by_policy:
                summary.status = "unshared"

        retained_by_source: dict[str, list[ToolingRetainedRemoteTool]] = {}
        for item in normalized_retained:
            retained_by_source.setdefault(item.source_id, []).append(item)
        for (peer_id, _provider_id), header in normalized_headers.items():
            service_instance_id = str(header["service_instance_id"])
            source_id = f"mesh:{peer_id}:{self._safe_identifier(service_instance_id)}"
            source_rows = retained_by_source.get(source_id, [])
            counts: dict[str, int] = {}
            for item in source_rows:
                counts[item.retained_availability] = counts.get(item.retained_availability, 0) + 1
            active_count = len(bindable_tool_ids.get(source_id, set()))
            status = "active" if active_count else str(header.get("availability") or "stale")
            if not active_count and status == "active":
                for candidate in (
                    "schema_changed",
                    "permission_blocked",
                    "unshared",
                    "removed",
                    "stale",
                    "protocol_unsupported",
                    "provider_unavailable",
                ):
                    if counts.get(candidate):
                        status = candidate
                        break
            summaries[source_id] = ToolingToolSourceSummary(
                source_id=source_id,
                source="mesh_peer",
                display_name=self._peer_display_name(peer_id),
                provider_peer_id=peer_id,
                provider_service_instance_id=service_instance_id,
                provider_label=self._peer_display_name(peer_id),
                provider_kind="mesh_peer",
                trust_tier="untrusted",
                status=status,
                tool_count=active_count,
                retained_tool_count=len(source_rows),
                inactive_tool_count=max(0, len(source_rows) - active_count),
                availability_counts=counts,
                blocked_tool_count=max(0, len(source_rows) - active_count),
                cache_status="hit",
                catalog_epoch=int(header.get("current_generation") or 0),
                catalog_hash=header.get("projection_digest"),
                updated_at=float(header.get("updated_at") or 0.0),
                shared_by_policy=not bool(counts.get("unshared")),
                reason_code=header.get("last_error_reason")
                or (None if status == "active" else status),
                reason=(None if status == "active" else "Retained remote catalog is not callable"),
            )

        for source_id, summary in summaries.items():
            if (
                summary.blocked_tool_count > 0
                and not bindable_tool_ids.get(source_id)
                and summary.status
                not in {
                    "unshared",
                    "stale",
                    "removed",
                    "permission_blocked",
                    "provider_unavailable",
                    "schema_changed",
                    "protocol_unsupported",
                }
            ):
                summary.status = "blocked"
                blocking_reasons = blocking_reasons_by_source.get(source_id, {})
                permission_reason = blocking_reasons.get("permission_denied")
                if (
                    summary.provider_kind == "mesh_peer"
                    and permission_reason is not None
                    and len(blocking_reasons) == 1
                ):
                    # An eligible provider can still have every retained tool
                    # made non-callable by its live permission manifest. In
                    # that case the per-tool reason is the authoritative source
                    # state; do not leave the management UI showing the
                    # provider's generic cached-catalog reason.
                    summary.reason_code = "permission_denied"
                    summary.reason = permission_reason

        grants = await self._active_grants_for_read_models()
        pending = await self._pending_approvals_for_read_models()
        for source_id, summary in summaries.items():
            source_grants = [
                grant for grant in grants if self._source_id_matches_grant(source_id, grant)
            ]
            source_policy_grant = next(
                (
                    grant
                    for grant in source_grants
                    if grant.grant_type == "trust"
                    and grant.metadata.get("policy_scope") == "source"
                    and grant.metadata.get("source_id") == source_id
                    and grant.trust_tier in {"trusted", "untrusted", "blocked"}
                ),
                None,
            )
            if source_policy_grant is not None:
                summary.configured_trust_tier = source_policy_grant.trust_tier
                summary.trust_tier = source_policy_grant.trust_tier
                if source_policy_grant.trust_tier == "blocked":
                    summary.status = "blocked"
            summary.active_grant_count = len(source_grants)
            summary.stale_grant_count = sum(
                1 for grant in source_grants if self._grant_needs_review(grant)
            )
            summary.include_future_tools_grants = sum(
                1 for grant in source_grants if grant.include_future_tools
            )
            summary.pending_approval_count = sum(
                1
                for approval in pending
                if (
                    f"mesh:{approval.provider_peer_id}:"
                    f"{self._safe_identifier(approval.provider_service_instance_id)}"
                    if not self._is_local_provider(approval.provider_peer_id)
                    else f"local:{approval.source}"
                )
                == source_id
            )
            reviewed_ids = {
                tool_id
                for grant in source_grants
                for tool_id in grant.metadata.get("reviewed_global_tool_ids", [])
                if isinstance(tool_id, str)
            }
            if reviewed_ids:
                source_tool_ids = {
                    tool.global_tool_id
                    for tool in catalog.tools
                    if self._source_id_for_tool(tool) == source_id
                }
                source_tool_ids.update(
                    blocked.tool.global_tool_id
                    for blocked in catalog.blocked_tools
                    if self._source_id_for_tool(blocked.tool) == source_id
                )
                summary.unreviewed_tool_count = len(source_tool_ids - reviewed_ids)

        return sorted(summaries.values(), key=self._source_sort_key), catalog

    @method_contract(
        method_id=ToolingMethods.GET_POLICY_SUMMARY,
        summary="Get Tooling policy summary",
        input_model=ToolingGetPolicySummaryRequest,
        output_model=ToolingGetPolicySummaryResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_get_policy_summary(
        self, request: ToolingGetPolicySummaryRequest
    ) -> ToolingGetPolicySummaryResponse:
        policy = self._sharing_policy
        active_grants = await self._active_grants_for_read_models()
        pending = await self._pending_approvals_for_read_models()
        sources, catalog = await self._tool_source_summaries(ToolingListToolSourcesRequest())
        return ToolingGetPolicySummaryResponse(
            policy=policy,
            policy_mode=policy.policy_mode,
            default_approval_mode=policy.default_approval_mode,
            default_share=policy.default_share,
            dry_run_only=policy.policy_mode == "dry_run_only"
            or policy.default_approval_mode == "dry_run_only",
            deny_all=policy.policy_mode == "deny_all" or policy.default_approval_mode == "deny_all",
            unrestricted_except_blocked=policy.policy_mode == "unrestricted_except_blocked",
            active_grant_count=len(active_grants) if request.include_counts else 0,
            pending_approval_count=len(pending) if request.include_counts else 0,
            blocked_source_count=sum(1 for source in sources if source.status == "blocked")
            if request.include_counts
            else 0,
            blocked_tool_count=catalog.blocked_count if request.include_counts else 0,
            source_count=len(sources) if request.include_counts else 0,
            tool_count=sum(source.tool_count for source in sources)
            if request.include_counts
            else 0,
        )

    @method_contract(
        method_id=ToolingMethods.LIST_TOOL_SOURCES,
        summary="List grouped Tooling sources",
        input_model=ToolingListToolSourcesRequest,
        output_model=ToolingListToolSourcesResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_list_tool_sources(
        self, request: ToolingListToolSourcesRequest
    ) -> ToolingListToolSourcesResponse:
        sources, _ = await self._tool_source_summaries(request)
        return ToolingListToolSourcesResponse(
            sources=sources,
            count=len(sources),
            generated_at=datetime.now(timezone.utc).isoformat(),  # noqa: UP017
        )

    @method_contract(
        method_id=ToolingMethods.LIST_PENDING_APPROVALS,
        summary="List redacted pending Tooling approvals",
        input_model=ToolingListPendingApprovalsRequest,
        output_model=ToolingListPendingApprovalsResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_list_pending_approvals(
        self, request: ToolingListPendingApprovalsRequest
    ) -> ToolingListPendingApprovalsResponse:
        approvals = await self._pending_approvals_for_read_models(request)
        return ToolingListPendingApprovalsResponse(approvals=approvals, count=len(approvals))

    @method_contract(
        method_id=ToolingMethods.GET_TOOL_SOURCE_DETAIL,
        summary="Get Tooling source detail",
        input_model=ToolingGetToolSourceDetailRequest,
        output_model=ToolingGetToolSourceDetailResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_get_tool_source_detail(
        self, request: ToolingGetToolSourceDetailRequest
    ) -> ToolingGetToolSourceDetailResponse:
        sources, catalog = await self._tool_source_summaries(
            ToolingListToolSourcesRequest(
                include_blocked_tools=request.include_blocked_tools,
                caller_permissions=request.caller_permissions,
            )
        )
        source = next((item for item in sources if item.source_id == request.source_id), None)
        if source is None:
            return ToolingGetToolSourceDetailResponse(found=False)
        tools = (
            [tool for tool in catalog.tools if self._source_id_for_tool(tool) == request.source_id]
            if request.include_tools
            else []
        )
        blocked_tools = (
            [
                blocked
                for blocked in catalog.blocked_tools
                if self._source_id_for_tool(blocked.tool) == request.source_id
            ]
            if request.include_blocked_tools
            else []
        )
        grants = (
            [
                grant
                for grant in await self._active_grants_for_read_models()
                if self._source_id_matches_grant(request.source_id, grant)
            ]
            if request.include_grants
            else []
        )
        pending = (
            [
                approval
                for approval in await self._pending_approvals_for_read_models()
                if approval.source_id == request.source_id
            ]
            if request.include_pending_approvals
            else []
        )
        _headers, retained = await self._load_normalized_management_catalog()
        retained_tools = (
            [item for item in retained if item.source_id == request.source_id]
            if request.include_tools
            else []
        )
        policy_rules = [
            rule
            for rule in self._sharing_policy.rules
            if (
                rule.source_type == source.source
                or (
                    not self._is_local_provider(source.provider_peer_id)
                    and rule.provider_peer_id == source.provider_peer_id
                )
            )
        ]
        retained_tools = [
            item.model_copy(
                update={
                    "approval_grant_ids": sorted(
                        grant.grant_id
                        for grant in grants
                        if grant.global_tool_id == item.global_tool_id
                        or item.global_tool_id in grant.metadata.get("reviewed_global_tool_ids", [])
                    ),
                    "policy_rule_ids": sorted(
                        rule.rule_id
                        for rule in policy_rules
                        if rule.global_tool_id == item.global_tool_id
                        or (rule.global_tool_id is None and rule.tool_name == item.local_tool_name)
                    ),
                }
            )
            for item in retained_tools
        ]
        return ToolingGetToolSourceDetailResponse(
            source=source,
            tools=tools,
            blocked_tools=blocked_tools,
            retained_tools=retained_tools,
            grants=grants,
            pending_approvals=pending,
            policy_rules=policy_rules,
            found=True,
        )

    @method_contract(
        method_id=ToolingMethods.ACCEPT_REMOTE_TOOL_SCHEMA,
        summary="Accept an exact changed remote tool schema",
        input_model=ToolingAcceptRemoteToolSchemaRequest,
        output_model=ToolingAcceptRemoteToolSchemaResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_accept_remote_tool_schema(
        self,
        request: ToolingAcceptRemoteToolSchemaRequest,
        envelope: Any | None = None,
    ) -> ToolingAcceptRemoteToolSchemaResponse:
        """Accept metadata only; prior positive grants remain review-required."""

        actor = self._authoritative_actor_principal(envelope, request.actor_principal_id)
        if actor and actor != request.actor_principal_id:
            request = request.model_copy(update={"actor_principal_id": actor})
        result = await self.bus.request(
            DBMethods.ACCEPT_TOOLING_REMOTE_TOOL_SCHEMA,
            DBAcceptToolingRemoteToolSchemaRequest(
                peer_id=request.peer_id,
                provider_id=request.provider_id,
                global_tool_id=request.global_tool_id,
                expected_projection_revision=request.expected_projection_revision,
                expected_schema_hash=request.expected_schema_hash,
                actor_principal_id=request.actor_principal_id,
                reason=request.reason,
                correlation_id=request.correlation_id,
            ),
            origin="internal",
            timeout=TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
            priority=get_system_priority(),
        )
        data = (
            result.data.model_dump(mode="python")
            if result.data is not None and hasattr(result.data, "model_dump")
            else result.data or {}
        )
        if not result.ok or not bool(data.get("ok")):
            return ToolingAcceptRemoteToolSchemaResponse(
                ok=False,
                error=str(data.get("error") or result.error or "schema_acceptance_failed"),
                correlation_id=request.correlation_id,
            )
        self._catalog_cache.clear()
        _headers, retained = await self._load_normalized_management_catalog()
        retained_tool = next(
            (
                item
                for item in retained
                if item.peer_id == request.peer_id
                and item.provider_id == request.provider_id
                and item.global_tool_id == request.global_tool_id
            ),
            None,
        )
        return ToolingAcceptRemoteToolSchemaResponse(
            ok=True,
            changed=bool(data.get("changed")),
            retained_tool=retained_tool,
            correlation_id=str(data.get("correlation_id") or request.correlation_id or "") or None,
        )

    @method_contract(
        method_id=ToolingMethods.SET_POLICY_MODE,
        summary="Set Tooling policy mode",
        input_model=ToolingSetPolicyModeRequest,
        output_model=ToolingSetPolicyModeResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_set_policy_mode(
        self, request: ToolingSetPolicyModeRequest
    ) -> ToolingSetPolicyModeResponse:
        confirmation_error = self._policy_mode_confirmation_error(
            request.policy_mode, request.confirmation_text
        )
        if confirmation_error:
            return ToolingSetPolicyModeResponse(
                ok=False,
                policy=self._sharing_policy,
                error=confirmation_error,
                correlation_id=request.correlation_id,
            )
        policy = self._sharing_policy.model_copy(update={"policy_mode": request.policy_mode})
        response = await self._on_set_sharing_policy(
            ToolingSetSharingPolicyRequest(
                policy=policy,
                actor_principal_id=request.actor_principal_id,
                confirmation_text=request.confirmation_text,
                correlation_id=request.correlation_id,
            )
        )
        await self._audit_tooling_event(
            "tooling.policy.mode_set",
            principal_id=request.actor_principal_id,
            details={
                "policy_mode": request.policy_mode,
                "reason": request.reason,
                "correlation_id": request.correlation_id,
            },
        )
        return ToolingSetPolicyModeResponse(
            ok=response.ok,
            policy=response.policy,
            error=getattr(response, "error", None),
            correlation_id=response.correlation_id,
        )

    @staticmethod
    def _policy_mode_confirmation_error(
        policy_mode: str, confirmation_text: str | None
    ) -> str | None:
        """Return confirmation error for dangerous policy modes."""

        required_confirmations = {
            "unrestricted_except_blocked": "ALLOW NON-BLOCKED TOOLS",
            "deny_all": "DENY ALL TOOLS",
            "dry_run_only": "DRY RUN ONLY",
        }
        required_confirmation = required_confirmations.get(policy_mode)
        if required_confirmation and confirmation_text != required_confirmation:
            return "confirmation_required"
        return None

    @method_contract(
        method_id=ToolingMethods.UPSERT_SOURCE_POLICY,
        summary="Upsert source trust policy",
        input_model=ToolingUpsertSourcePolicyRequest,
        output_model=ToolingUpsertSourcePolicyResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_upsert_source_policy(
        self, request: ToolingUpsertSourcePolicyRequest
    ) -> ToolingUpsertSourcePolicyResponse:
        source_type = self._canonical_source_type_from_source_id(request.source_id)
        grant_scope = "deny_always" if request.trust_tier == "blocked" else "always"
        grant_response = await self._on_create_approval_grant(
            ToolingCreateApprovalGrantRequest(
                grant_scope=grant_scope,
                grant_type="trust",
                principal_id=request.actor_principal_id,
                provider_peer_id=request.provider_peer_id,
                provider_service_instance_id=request.provider_service_instance_id,
                trust_tier=request.trust_tier,
                include_future_tools=request.include_future_tools,
                created_by=request.actor_principal_id,
                reason=request.reason,
                metadata={
                    "source_id": request.source_id,
                    "source_type": source_type,
                    "policy_scope": "source",
                    "secrets_redacted": True,
                },
                correlation_id=request.correlation_id,
            )
        )
        if grant_response.ok and grant_response.grant is not None:
            await self._revoke_superseded_policy_grants(
                policy_scope="source",
                keep_grant_id=grant_response.grant.grant_id,
                source_id=request.source_id,
            )
        await self._audit_tooling_event(
            "tooling.source_policy.upserted",
            principal_id=request.actor_principal_id,
            details={
                "source_id": request.source_id,
                "trust_tier": request.trust_tier,
                "include_future_tools": request.include_future_tools,
                "correlation_id": request.correlation_id,
            },
        )
        return ToolingUpsertSourcePolicyResponse(
            ok=grant_response.ok,
            grant=grant_response.grant,
            error=grant_response.error,
            correlation_id=grant_response.correlation_id,
        )

    @method_contract(
        method_id=ToolingMethods.CLEAR_SOURCE_POLICY,
        summary="Clear source trust policy to inherit the global default",
        input_model=ToolingClearSourcePolicyRequest,
        output_model=ToolingClearSourcePolicyResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_clear_source_policy(
        self, request: ToolingClearSourcePolicyRequest
    ) -> ToolingClearSourcePolicyResponse:
        try:
            revoked = await self._clear_policy_grants(
                policy_scope="source", source_id=request.source_id
            )
            await self._audit_tooling_event(
                "tooling.source_policy.cleared",
                principal_id=request.actor_principal_id,
                details={
                    "source_id": request.source_id,
                    "revoked_grant_ids": revoked,
                    "reason": request.reason,
                    "correlation_id": request.correlation_id,
                },
            )
            return ToolingClearSourcePolicyResponse(
                ok=True,
                cleared=bool(revoked),
                revoked_grant_ids=revoked,
                correlation_id=request.correlation_id,
            )
        except Exception as error:
            return ToolingClearSourcePolicyResponse(
                ok=False, error=str(error), correlation_id=request.correlation_id
            )

    @method_contract(
        method_id=ToolingMethods.UPSERT_TOOL_POLICY_OVERRIDE,
        summary="Upsert per-tool trust override",
        input_model=ToolingUpsertToolPolicyOverrideRequest,
        output_model=ToolingUpsertToolPolicyOverrideResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_upsert_tool_policy_override(
        self, request: ToolingUpsertToolPolicyOverrideRequest
    ) -> ToolingUpsertToolPolicyOverrideResponse:
        grant_scope = "deny_always" if request.trust_tier == "blocked" else "always"
        grant_response = await self._on_create_approval_grant(
            ToolingCreateApprovalGrantRequest(
                grant_scope=grant_scope,
                grant_type="trust",
                principal_id=request.actor_principal_id,
                provider_peer_id=request.provider_peer_id,
                provider_service_instance_id=request.provider_service_instance_id,
                global_tool_id=request.global_tool_id,
                local_tool_name=request.local_tool_name,
                trust_tier=request.trust_tier,
                include_future_tools=False,
                created_by=request.actor_principal_id,
                reason=request.reason,
                metadata={
                    "policy_scope": "tool",
                    "expected_schema_hash": request.expected_schema_hash,
                    "secrets_redacted": True,
                },
                correlation_id=request.correlation_id,
            )
        )
        if grant_response.ok and grant_response.grant is not None:
            await self._revoke_superseded_policy_grants(
                policy_scope="tool",
                keep_grant_id=grant_response.grant.grant_id,
                global_tool_id=request.global_tool_id,
                local_tool_name=request.local_tool_name,
            )
        await self._audit_tooling_event(
            "tooling.tool_policy_override.upserted",
            principal_id=request.actor_principal_id,
            details={
                "global_tool_id": request.global_tool_id,
                "local_tool_name": request.local_tool_name,
                "trust_tier": request.trust_tier,
                "expected_schema_hash": request.expected_schema_hash,
                "correlation_id": request.correlation_id,
            },
        )
        return ToolingUpsertToolPolicyOverrideResponse(
            ok=grant_response.ok,
            grant=grant_response.grant,
            error=grant_response.error,
            correlation_id=grant_response.correlation_id,
        )

    @method_contract(
        method_id=ToolingMethods.CLEAR_TOOL_POLICY_OVERRIDE,
        summary="Clear per-tool trust override to inherit its source policy",
        input_model=ToolingClearToolPolicyOverrideRequest,
        output_model=ToolingClearToolPolicyOverrideResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_clear_tool_policy_override(
        self, request: ToolingClearToolPolicyOverrideRequest
    ) -> ToolingClearToolPolicyOverrideResponse:
        try:
            revoked = await self._clear_policy_grants(
                policy_scope="tool",
                global_tool_id=request.global_tool_id,
                local_tool_name=request.local_tool_name,
            )
            await self._audit_tooling_event(
                "tooling.tool_policy_override.cleared",
                principal_id=request.actor_principal_id,
                details={
                    "global_tool_id": request.global_tool_id,
                    "local_tool_name": request.local_tool_name,
                    "revoked_grant_ids": revoked,
                    "reason": request.reason,
                    "correlation_id": request.correlation_id,
                },
            )
            return ToolingClearToolPolicyOverrideResponse(
                ok=True,
                cleared=bool(revoked),
                revoked_grant_ids=revoked,
                correlation_id=request.correlation_id,
            )
        except Exception as error:
            return ToolingClearToolPolicyOverrideResponse(
                ok=False, error=str(error), correlation_id=request.correlation_id
            )

    async def _clear_policy_grants(
        self,
        *,
        policy_scope: str,
        source_id: str | None = None,
        global_tool_id: str | None = None,
        local_tool_name: str | None = None,
    ) -> list[str]:
        """Deactivate explicit policy grants, making the target inherit again."""

        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            raise RuntimeError("tooling_policy_storage_unavailable")
        rows = await self._db_sql(
            """
            SELECT * FROM tooling_approval_grants
            WHERE active = 1
              AND revoked_at IS NULL
              AND grant_type = 'trust'
            ORDER BY created_at DESC
            """,
            [],
        )
        revoked_ids: list[str] = []
        for row in rows:
            grant = self._grant_from_row(row)
            if grant.metadata.get("policy_scope") != policy_scope:
                continue
            if policy_scope == "source":
                if grant.metadata.get("source_id") != source_id:
                    continue
            else:
                matches_tool = (
                    grant.global_tool_id == global_tool_id
                    if global_tool_id
                    else bool(local_tool_name) and grant.local_tool_name == local_tool_name
                )
                if not matches_tool:
                    continue
            revoked_ids.append(grant.grant_id)
        revoked_at = time.time()
        for grant_id in revoked_ids:
            await self._db_sql(
                """
                UPDATE tooling_approval_grants
                SET active = 0, revoked_at = ?, reason = 'cleared_to_inherit'
                WHERE grant_id = ?
                """,
                [revoked_at, grant_id],
            )
        return revoked_ids

    async def _revoke_superseded_policy_grants(
        self,
        *,
        policy_scope: str,
        keep_grant_id: str,
        source_id: str | None = None,
        global_tool_id: str | None = None,
        local_tool_name: str | None = None,
    ) -> None:
        """Keep one authoritative active grant for a source/tool policy control."""

        await self._ensure_tooling_policy_tables()
        if not self._tooling_policy_tables_ready:
            raise RuntimeError("tooling_policy_storage_unavailable")
        rows = await self._db_sql(
            """
            SELECT * FROM tooling_approval_grants
            WHERE active = 1
              AND revoked_at IS NULL
              AND grant_type = 'trust'
              AND grant_id != ?
            ORDER BY created_at DESC
            """,
            [keep_grant_id],
        )
        superseded_ids: list[str] = []
        for row in rows:
            grant = self._grant_from_row(row)
            if grant.metadata.get("policy_scope") != policy_scope:
                continue
            if policy_scope == "source":
                if grant.metadata.get("source_id") != source_id:
                    continue
            elif policy_scope == "tool":
                matches_tool = (
                    grant.global_tool_id == global_tool_id
                    if global_tool_id
                    else bool(local_tool_name) and grant.local_tool_name == local_tool_name
                )
                if not matches_tool:
                    continue
            superseded_ids.append(grant.grant_id)
        revoked_at = time.time()
        for grant_id in superseded_ids:
            await self._db_sql(
                """
                UPDATE tooling_approval_grants
                SET active = 0, revoked_at = ?, reason = 'superseded_by_policy_update'
                WHERE grant_id = ?
                """,
                [revoked_at, grant_id],
            )

    @method_contract(
        method_id=ToolingMethods.TEST_MCP_SOURCE,
        summary="Validate MCP source configuration",
        input_model=ToolingTestMCPSourceRequest,
        output_model=ToolingTestMCPSourceResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["source_onboarding"],
    )
    async def _on_test_mcp_source(
        self, request: ToolingTestMCPSourceRequest
    ) -> ToolingTestMCPSourceResponse:
        if not request.command and not request.url:
            return ToolingTestMCPSourceResponse(
                ok=False,
                source_id=request.source_id,
                error="command_or_url_required",
                secrets_redacted=True,
            )
        return ToolingTestMCPSourceResponse(
            ok=False,
            source_id=request.source_id,
            message="MCP source validation is redacted and requires explicit backend connector support.",
            error="unsupported_in_current_runtime",
            secrets_redacted=True,
        )

    @method_contract(
        method_id=ToolingMethods.TEST_PLUGIN_SOURCE,
        summary="Validate plugin source configuration",
        input_model=ToolingTestPluginSourceRequest,
        output_model=ToolingTestPluginSourceResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["source_onboarding"],
    )
    async def _on_test_plugin_source(
        self, request: ToolingTestPluginSourceRequest
    ) -> ToolingTestPluginSourceResponse:
        if not request.package.strip():
            return ToolingTestPluginSourceResponse(
                ok=False,
                source_id=request.source_id,
                error="package_required",
                secrets_redacted=True,
            )
        return ToolingTestPluginSourceResponse(
            ok=False,
            source_id=request.source_id,
            message="Plugin source validation is redacted and requires explicit backend installer support.",
            error="unsupported_in_current_runtime",
            secrets_redacted=True,
        )

    @method_contract(
        method_id=ToolingMethods.CREATE_MCP_SOURCE,
        summary="Create MCP source configuration",
        input_model=ToolingCreateMCPSourceRequest,
        output_model=ToolingCreateMCPSourceResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["source_onboarding"],
    )
    async def _on_create_mcp_source(
        self, request: ToolingCreateMCPSourceRequest
    ) -> ToolingCreateMCPSourceResponse:
        tested = await self._on_test_mcp_source(request)
        return ToolingCreateMCPSourceResponse(
            ok=False,
            source_id=request.source_id,
            message=tested.message,
            tool_count=tested.tool_count,
            error=tested.error or "unsupported_in_current_runtime",
            secrets_redacted=True,
            created=False,
        )

    @method_contract(
        method_id=ToolingMethods.CREATE_PLUGIN_SOURCE,
        summary="Create plugin source configuration",
        input_model=ToolingCreatePluginSourceRequest,
        output_model=ToolingCreatePluginSourceResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["source_onboarding"],
    )
    async def _on_create_plugin_source(
        self, request: ToolingCreatePluginSourceRequest
    ) -> ToolingCreatePluginSourceResponse:
        tested = await self._on_test_plugin_source(request)
        return ToolingCreatePluginSourceResponse(
            ok=False,
            source_id=request.source_id,
            message=tested.message,
            error=tested.error or "unsupported_in_current_runtime",
            secrets_redacted=True,
            created=False,
        )

    @method_contract(
        method_id=ToolingMethods.LIST_POLICY_AUDIT_EVENTS,
        summary="List redacted Tooling audit events",
        input_model=ToolingListPolicyAuditEventsRequest,
        output_model=ToolingListPolicyAuditEventsResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["policy_administration"],
    )
    async def _on_list_policy_audit_events(
        self, request: ToolingListPolicyAuditEventsRequest
    ) -> ToolingListPolicyAuditEventsResponse:
        event_filter = request.event if request.event else None
        try:
            result = await self.bus.request(
                AuthMethods.AUDIT_LOG,
                AuditLogRequest(
                    limit=request.limit,
                    offset=request.offset,
                    principal_id=request.principal_id,
                    event=event_filter,
                    correlation_id=request.correlation_id,
                    provider_id=request.provider_peer_id,
                    tool_id=request.global_tool_id,
                ),
                timeout=5.0,
                priority=get_system_priority(),
            )
        except Exception as error:
            log_warning(f"Failed to list Tooling policy audit events: {error}")
            return ToolingListPolicyAuditEventsResponse(events=[], total=0)
        if not result.ok:
            return ToolingListPolicyAuditEventsResponse(events=[], total=0)
        data = result.data
        events_raw = getattr(data, "events", None) if data is not None else None
        total = getattr(data, "total", None) if data is not None else None
        if isinstance(data, dict):
            events_raw = data.get("events", events_raw)
            total = data.get("total", total)
        events: list[ToolingPolicyAuditEvent] = []
        for row in list(events_raw or []):
            event_name = str(row.get("event") or "")
            if not request.event and not event_name.startswith("tooling."):
                continue
            raw_details = row.get("details") or {}
            if isinstance(raw_details, str):
                try:
                    raw_details = json.loads(raw_details)
                except Exception:
                    raw_details = {"message": raw_details}
            details = self._redact_audit_value(raw_details)
            events.append(
                ToolingPolicyAuditEvent(
                    event=event_name,
                    principal_id=row.get("principal_id"),
                    details=details if isinstance(details, dict) else {"value": details},
                    created_at=row.get("created_at") or row.get("timestamp"),
                    correlation_id=(
                        details.get("correlation_id") if isinstance(details, dict) else None
                    ),
                    policy_decision_id=(
                        details.get("policy_decision_id") if isinstance(details, dict) else None
                    ),
                    provider_peer_id=(
                        details.get("provider_peer_id") if isinstance(details, dict) else None
                    ),
                    global_tool_id=(
                        details.get("global_tool_id") if isinstance(details, dict) else None
                    ),
                )
            )
        return ToolingListPolicyAuditEventsResponse(events=events, total=int(total or len(events)))

    @method_contract(
        method_id=ToolingMethods.GET_ONBOARDING_STATUS,
        summary="Get Tooling source onboarding status",
        input_model=ToolingGetOnboardingStatusRequest,
        output_model=ToolingGetOnboardingStatusResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
        callable_feature_ids=["source_onboarding"],
    )
    async def _on_get_onboarding_status(
        self, request: ToolingGetOnboardingStatusRequest
    ) -> ToolingGetOnboardingStatusResponse:
        capabilities: list[ToolingOnboardingCapability] = []
        if request.include_mcp_servers:
            try:
                mcp_status = self.tools_manager.get_mcp_status()
            except Exception as error:
                log_warning(f"Failed to read MCP onboarding status: {error}")
                mcp_status = {"servers": [], "total_servers": 0, "active_servers": 0}
            servers = self._redact_audit_value(mcp_status.get("servers") or [])
            active_servers = int(mcp_status.get("active_servers") or 0)
            total_servers = int(mcp_status.get("total_servers") or 0)
            capabilities.append(
                ToolingOnboardingCapability(
                    source="mcp",
                    status="available" if total_servers or active_servers else "disabled",
                    available=True,
                    configured_count=total_servers,
                    active_count=active_servers,
                    message=(
                        "MCP servers configured" if total_servers else "No MCP servers configured"
                    ),
                    items=servers if isinstance(servers, list) else [],
                )
            )
        if request.include_plugin_sources:
            plugin_tools = [
                tool
                for tool in self.tools_manager.get_tools(None, 1000)
                if self._tool_source(tool) == "plugin"
            ]
            capabilities.append(
                ToolingOnboardingCapability(
                    source="plugin",
                    status="available",
                    available=True,
                    configured_count=len(plugin_tools),
                    active_count=len(plugin_tools),
                    message=("Plugin tools loaded" if plugin_tools else "No plugin tools loaded"),
                    items=[
                        {"name": getattr(tool, "name", "unknown"), "status": "active"}
                        for tool in plugin_tools
                    ],
                )
            )
        normalized_headers, normalized_retained = await self._load_normalized_management_catalog()
        remote_snapshots = [] if normalized_headers else await self._load_remote_catalog_snapshots()
        normalized_items = [
            {
                "peer_id": peer_id,
                "provider_id": provider_id,
                "service_instance_id": header["service_instance_id"],
                "catalog_epoch": int(header.get("current_generation") or 0),
                "catalog_hash": header.get("projection_digest"),
                "tool_count": sum(
                    1
                    for item in normalized_retained
                    if item.peer_id == peer_id
                    and item.provider_id == provider_id
                    and item.effective_availability == "active"
                ),
                "retained_tool_count": sum(
                    1
                    for item in normalized_retained
                    if item.peer_id == peer_id and item.provider_id == provider_id
                ),
                "status": header.get("availability"),
                "reason_code": header.get("last_error_reason"),
            }
            for (peer_id, provider_id), header in sorted(normalized_headers.items())
        ]
        normalized_active_count = sum(
            1
            for header in normalized_headers.values()
            if header.get("availability") == "active" and header.get("sync_state") == "committed"
        )
        capabilities.append(
            ToolingOnboardingCapability(
                source="mesh_peer",
                status="available" if normalized_headers or remote_snapshots else "unknown",
                available=True,
                configured_count=len(normalized_headers) or len(remote_snapshots),
                active_count=(
                    normalized_active_count
                    if normalized_headers
                    else sum(1 for snapshot in remote_snapshots if snapshot.shared_by_policy)
                ),
                message=(
                    "Negotiated mesh Tooling catalogs cached"
                    if normalized_headers or remote_snapshots
                    else "No negotiated mesh Tooling catalogs cached"
                ),
                items=(
                    normalized_items
                    if normalized_headers
                    else [
                        {
                            "peer_id": snapshot.peer_id,
                            "service_instance_id": snapshot.service_instance_id,
                            "catalog_epoch": snapshot.catalog_epoch,
                            "catalog_hash": snapshot.full_schema_hash,
                            "tool_count": len(snapshot.tools),
                            "shared_by_policy": snapshot.shared_by_policy,
                        }
                        for snapshot in remote_snapshots
                    ]
                ),
            )
        )
        return ToolingGetOnboardingStatusResponse(capabilities=capabilities)

    @method_contract(
        method_id=ToolingMethods.GET_MCP_STATUS,
        summary="Get MCP server status",
        input_model=ToolingGetMCPStatusRequest,
        output_model=ToolingGetMCPStatusResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.GET_MCP_STATUS],
        callable_feature_ids=["catalog_discovery"],
    )
    async def _on_get_mcp_status(
        self, request: ToolingGetMCPStatusRequest
    ) -> ToolingGetMCPStatusResponse:
        """Handle get MCP status query.

        Args:
            request: Empty request
        """
        try:
            status = self.tools_manager.get_mcp_status()
            log_debug(f"MCP status: {status}")

            # Return response
            return ToolingGetMCPStatusResponse(**status)

        except Exception as e:
            log_error(f"Error handling get MCP status query: {e}", exc_info=True)
            return ToolingGetMCPStatusResponse(servers=[], total_servers=0, active_servers=0)

    @method_contract(
        method_id=ToolingMethods.RELOAD_MCP_TOOLS,
        summary="Reload MCP tools",
        input_model=ToolingReloadMCPRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="manage",
    )
    async def _on_reload_mcp(self, request: ToolingReloadMCPRequest) -> EmptyOutput:
        """Handle reload MCP tools command.

        Args:
            request: Empty request
        """
        try:
            log_info("Reloading MCP tools...")
            await self.tools_manager.reload_mcp_tools()
            await self._reconcile_local_tool_identities()

            # Emit reloaded event
            stats = self.tools_manager.get_stats()
            await self.bus.publish(
                ToolingMethods.TOOLS_RELOADED,
                ToolsReloaded(total_tools=stats["total_tools"]),
                event=True,
                mesh=False,
                priority=get_system_priority(),
                origin="internal",
            )
            self._catalog_cache.clear()
            await self._announce_local_tool_catalog(reason="mcp_reload")

            log_info("MCP tools reloaded successfully")
            return EmptyOutput()

        except Exception as e:
            log_error(f"Error reloading MCP tools: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=ToolingMethods.EXECUTE_TOOL,
        summary="Execute a tool by name",
        input_model=ToolingExecuteToolRequest,
        output_model=ToolingExecuteToolResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.EXECUTE_TOOL],
        callable_feature_ids=["execution"],
    )
    async def _on_execute_tool(
        self, request: ToolingExecuteToolRequest, envelope: Any | None = None
    ) -> ToolingExecuteToolResponse:
        """Handle execute tool command.

        Args:
            request: Request containing tool name and arguments
        """
        try:
            if not await self._provider_rpc_execution_authorized(
                request, envelope, ToolingMethods.EXECUTE_TOOL
            ):
                return ToolingExecuteToolResponse(
                    ok=False,
                    result=None,
                    error="permission_denied",
                    error_code="permission_denied",
                    global_tool_id="",
                    local_tool_name="",
                )
            if not request.correlation_id:
                request.correlation_id = uuid.uuid4().hex

            if not await self._consumer_mesh_execution_authorized(request):
                return ToolingExecuteToolResponse(
                    ok=False,
                    error="current mesh authority denied execution",
                    status="denied",
                    error_code="permission_denied",
                    correlation_id=request.correlation_id,
                    provider_peer_id=self._selector_target_peer(request),
                    global_tool_id=None,
                    display_args_preview={},
                    args_hash=self._arguments_fingerprint(request.arguments),
                )

            # Get the tool
            (
                tool,
                local_tool_name,
                provider_peer_id,
                service_instance_id,
                global_tool_id,
            ) = await self._resolve_execution_context(request)
            log_context = self._execution_log_context(
                request,
                local_tool_name=local_tool_name,
                global_tool_id=global_tool_id,
                provider_peer_id=provider_peer_id,
                status="requested",
            )
            log_debug(f"Tool execution requested: {log_context}")
            if not tool:
                # Try to find similar tool names (case-insensitive, partial match)
                all_tool_names = self.tools_manager.get_all_tool_names()
                similar_tools = [
                    name
                    for name in all_tool_names
                    if local_tool_name.lower() in name.lower()
                    or name.lower() in local_tool_name.lower()
                ]

                error_msg = f"Tool not found: '{request.tool_name}'"
                if similar_tools:
                    error_msg += f". Similar tools found: {', '.join(similar_tools)}"
                else:
                    available = all_tool_names[:10]
                    error_msg += (
                        f". Available tools ({len(all_tool_names)} total): {', '.join(available)}"
                    )
                    if len(all_tool_names) > 10:
                        error_msg += f" ... and {len(all_tool_names) - 10} more"

                log_error(error_msg)
                log_debug(f"Tool lookup contains: {list(self.tools_manager.tool_lookup.keys())}")
                await self._audit_tool_execution(
                    request,
                    local_tool_name=local_tool_name,
                    global_tool_id=global_tool_id,
                    provider_peer_id=provider_peer_id,
                    safety_class="unknown",
                    status="not_found",
                    error_code="tool_not_found",
                    denial_reason=error_msg,
                )

                return ToolingExecuteToolResponse(
                    ok=False,
                    error=error_msg,
                    data=None,
                    status="not_found",
                    error_code="tool_not_found",
                    correlation_id=request.correlation_id,
                    provider_peer_id=provider_peer_id,
                    global_tool_id=global_tool_id,
                    display_args_preview=self._display_arguments_preview(request.arguments),
                    args_hash=self._arguments_fingerprint(request.arguments),
                )

            caller_permissions = await self._execution_caller_permissions(request, envelope)
            if not await self._provider_mesh_execution_authorized(tool, envelope):
                return await self._deny_tool_execution(
                    request,
                    local_tool_name=local_tool_name,
                    global_tool_id=global_tool_id,
                    provider_peer_id=provider_peer_id,
                    safety_class=self._tool_safety_class(tool),
                    error_code="permission_denied",
                    message="current mesh export authority denied execution",
                )
            required_permissions = self._tool_required_permissions(tool, request.arguments)
            if not self._has_required_permissions(required_permissions, caller_permissions):
                return await self._deny_tool_execution(
                    request,
                    local_tool_name=local_tool_name,
                    global_tool_id=global_tool_id,
                    provider_peer_id=provider_peer_id,
                    safety_class=self._tool_safety_class(tool),
                    error_code="permission_denied",
                    message="caller principal lacks required tool permissions",
                )

            validation_error = self._validate_expected_schema_hash(
                tool, request.expected_args_schema_hash
            ) or self._validate_tool_arguments(tool, request.arguments)
            if validation_error:
                await self._audit_tool_execution(
                    request,
                    local_tool_name=local_tool_name,
                    global_tool_id=global_tool_id,
                    provider_peer_id=provider_peer_id,
                    safety_class="unknown",
                    status="failed",
                    error_code="invalid_arguments",
                    denial_reason=validation_error,
                )
                return ToolingExecuteToolResponse(
                    ok=False,
                    error=validation_error,
                    data=None,
                    status="failed",
                    error_code="invalid_arguments",
                    correlation_id=request.correlation_id,
                    provider_peer_id=provider_peer_id,
                    global_tool_id=global_tool_id,
                    display_args_preview=self._display_arguments_preview(
                        request.arguments, self._argument_visibility(tool)
                    ),
                    args_hash=self._arguments_fingerprint(request.arguments),
                )

            denied = await self._enforce_execution_policy(
                request,
                tool=tool,
                local_tool_name=local_tool_name,
                global_tool_id=global_tool_id,
                provider_peer_id=provider_peer_id,
                service_instance_id=service_instance_id,
                envelope=envelope,
            )
            if denied:
                return denied

            safety_class = self._tool_safety_class(tool)
            prepared_for_audit = self._prepared_execution(
                request,
                tool=tool,
                local_tool_name=local_tool_name,
                provider_peer_id=provider_peer_id,
                service_instance_id=service_instance_id,
                global_tool_id=global_tool_id,
                legacy_share_authoritative=not bool(
                    self._mesh_projection_enforcement_active
                    and getattr(envelope, "caller_peer_id", None)
                ),
            )
            if request.dry_run:
                await self._audit_tool_execution(
                    request,
                    local_tool_name=local_tool_name,
                    global_tool_id=global_tool_id,
                    provider_peer_id=provider_peer_id,
                    safety_class=safety_class,
                    status="dry_run",
                    policy_decision=prepared_for_audit.policy_decision,
                )
                return ToolingExecuteToolResponse(
                    ok=True,
                    data={
                        "dry_run": True,
                        "tool_name": local_tool_name,
                        "global_tool_id": global_tool_id,
                    },
                    error=None,
                    status="dry_run",
                    correlation_id=request.correlation_id,
                    provider_peer_id=provider_peer_id,
                    global_tool_id=global_tool_id,
                    policy_decision_id=prepared_for_audit.policy_decision.decision_id,
                    display_args_preview=prepared_for_audit.display_args_preview,
                    args_hash=prepared_for_audit.args_hash,
                )

            # Execute the tool
            try:
                # Always inject the bus into tool arguments
                tool_args = request.arguments.copy()
                tool_args["bus"] = self.bus

                # Execute the tool - LangChain will handle argument validation
                # The bus parameter is injected at runtime and not in the schema
                result = (
                    await tool.ainvoke(tool_args)
                    if hasattr(tool, "ainvoke")
                    else tool.invoke(tool_args)
                )
                log_context = self._execution_log_context(
                    request,
                    local_tool_name=local_tool_name,
                    global_tool_id=global_tool_id,
                    provider_peer_id=provider_peer_id,
                    status="success",
                    result_present=result is not None,
                )
                log_debug(f"Tool execution completed: {log_context}")
                await self._audit_tool_execution(
                    request,
                    local_tool_name=local_tool_name,
                    global_tool_id=global_tool_id,
                    provider_peer_id=provider_peer_id,
                    safety_class=safety_class,
                    status="success",
                    policy_decision=prepared_for_audit.policy_decision,
                )

                # Return response
                return ToolingExecuteToolResponse(
                    ok=True,
                    data=result,
                    error=None,
                    status="success",
                    correlation_id=request.correlation_id,
                    provider_peer_id=provider_peer_id,
                    global_tool_id=global_tool_id,
                    policy_decision_id=prepared_for_audit.policy_decision.decision_id,
                    display_args_preview=prepared_for_audit.display_args_preview,
                    args_hash=prepared_for_audit.args_hash,
                )

            except Exception as tool_error:
                error_type = type(tool_error).__name__
                safe_error_message = self._safe_error_text(tool_error)
                for secret_value in self._secret_argument_strings(request.arguments):
                    safe_error_message = safe_error_message.replace(secret_value, "<redacted>")
                error_msg = (
                    f"Tool execution failed: {error_type}: {safe_error_message}"
                    if safe_error_message and safe_error_message != error_type
                    else f"Tool execution failed: {error_type}"
                )
                log_context = self._execution_log_context(
                    request,
                    local_tool_name=local_tool_name,
                    global_tool_id=global_tool_id,
                    provider_peer_id=provider_peer_id,
                    status="failed",
                    error_code="tool_execution_failed",
                    error_type=error_type,
                )
                error_details = {
                    **log_context,
                    "message": safe_error_message,
                    "trace": self._safe_error_trace(tool_error),
                }
                log_error(f"Tool execution failed: {log_context}")
                await self._audit_tool_execution(
                    request,
                    local_tool_name=local_tool_name,
                    global_tool_id=global_tool_id,
                    provider_peer_id=provider_peer_id,
                    safety_class=safety_class,
                    status="failed",
                    error_code="tool_execution_failed",
                    denial_reason=error_msg,
                    policy_decision=prepared_for_audit.policy_decision,
                )
                return ToolingExecuteToolResponse(
                    ok=False,
                    error=error_msg,
                    data={"error_details": error_details},
                    status="failed",
                    error_code="tool_execution_failed",
                    correlation_id=request.correlation_id,
                    provider_peer_id=provider_peer_id,
                    global_tool_id=global_tool_id,
                    policy_decision_id=prepared_for_audit.policy_decision.decision_id,
                    display_args_preview=prepared_for_audit.display_args_preview,
                    args_hash=prepared_for_audit.args_hash,
                )

        except Exception as e:
            log_error(f"Error handling execute tool command: {e}", exc_info=True)
            return ToolingExecuteToolResponse(
                ok=False,
                error=str(e),
                data=None,
                status="failed",
                error_code="tooling_internal_error",
                correlation_id=request.correlation_id,
                display_args_preview=self._display_arguments_preview(request.arguments),
                args_hash=self._arguments_fingerprint(request.arguments),
            )
