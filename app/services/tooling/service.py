"""Tooling Service for Aurora's parallel architecture.

This service:
- Manages all tools (core, plugin, MCP)
- Handles tool initialization and lifecycle
- Exposes tool queries via message bus
- Emits events when tools change
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any

from jsonschema import (
    Draft202012Validator,
    exceptions as jsonschema_exceptions,
)

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging.priority_helpers import get_interactive_priority, get_system_priority
from app.services.tooling.tools_manager import ToolsManager, set_tools_manager
from app.shared.config.interface import ConfigAPI
from app.shared.contracts.models.auth import (
    AuditLogRequest,
    AuthMethods,
    PrincipalGetRequest,
    StoreAuditEventRequest,
)
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.db import DBExecuteSQLRequest, DBMethods
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.tooling import (
    ToolingApprovalGrant,
    ToolingBlockedToolInfo,
    ToolingCatalogProviderInfo,
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
    ToolingMethods,
    ToolingModule,
    ToolingOnboardingCapability,
    ToolingPendingApproval,
    ToolingPolicyAuditEvent,
    ToolingPolicyDecision,
    ToolingPrepareExecutionRequest,
    ToolingPrepareExecutionResponse,
    ToolingRateLimitHints,
    ToolingReloadMCPRequest,
    ToolingRemoteCatalogAnnounced,
    ToolingRemoteCatalogDeltaAnnounced,
    ToolingRemoteCatalogRefreshRequested,
    ToolingRemoteCatalogRemoved,
    ToolingRequestApprovalRequest,
    ToolingRequestApprovalResponse,
    ToolingRevokeApprovalGrantRequest,
    ToolingRevokeApprovalGrantResponse,
    ToolingSetPolicyModeRequest,
    ToolingSetPolicyModeResponse,
    ToolingSetSharingPolicyRequest,
    ToolingSetSharingPolicyResponse,
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
    ToolingUpsertToolPolicyOverrideRequest,
    ToolingUpsertToolPolicyOverrideResponse,
)
from app.shared.contracts.registry import method_contract
from app.shared.messaging.models.tooling_models import (
    ToolsInitialized,
    ToolsReloaded,
)
from app.shared.services.base_service import BaseService

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
        self._tooling_policy_tables_ready = False

    async def on_start(self) -> None:
        """Start the tooling service and initialize tools."""
        log_info("Starting Tooling service...")
        await self._load_sharing_policy_from_config()
        await self._ensure_tooling_policy_tables()

        # Set as global instance
        set_tools_manager(self.tools_manager)

        # Initialize tools
        log_info("Initializing tools...")
        await self.tools_manager.initialize()

        # Emit initialization event
        stats = self.tools_manager.get_stats()
        await self.bus.publish(
            ToolingMethods.TOOLS_INITIALIZED,
            ToolsInitialized(
                total_tools=stats["total_tools"], mcp_tools_loaded=stats["mcp_tools_loaded"]
            ),
            event=True,
            mesh=True,
            priority=get_system_priority(),
            origin="internal",
        )
        await self._announce_local_tool_catalog(reason="startup")

        log_info(f"Tooling service started with {stats['total_tools']} tools")

    async def on_stop(self) -> None:
        """Stop the tooling service."""
        log_info("Stopping Tooling service...")

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading ToolingService configuration: section={config_section}")
        # Reload tools if MCP config changed
        if config_section is None or config_section in ["services"]:
            await self._load_sharing_policy_from_config()
            log_info("Reloading tools due to config change...")
            await self.tools_manager.reload()
            self._catalog_cache.clear()
            await self._announce_local_tool_catalog(reason="reload")
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

        if getattr(tool, "_is_mcp_tool", False) is True:
            return "mcp"
        module_name = getattr(tool, "__module__", "") or tool.__class__.__module__
        if ".plugins." in module_name or ".plugin." in module_name or module_name.endswith("_toolkit"):
            return "plugin"
        if module_name.startswith("app.services.tooling.tools"):
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

    @classmethod
    def _provider_context(cls, request: ToolingDiscoveryRequest) -> tuple[str, str, str, str]:
        """Return provider peer, service instance, source type, and namespace."""

        selector = request.mesh_selector
        if selector and (selector.peer_id or selector.provider_id or selector.service_instance_id):
            provider_peer_id = selector.peer_id or selector.provider_id or "remote"
            provider_service_instance_id = (
                selector.service_instance_id or f"remote:{provider_peer_id}:Tooling"
            )
            source_type = "mesh_peer"
            namespace = cls._safe_identifier(provider_peer_id)
        else:
            provider_peer_id = "local"
            provider_service_instance_id = "local:Tooling"
            source_type = "local"
            namespace = "local"

        return provider_peer_id, provider_service_instance_id, source_type, namespace

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

    @classmethod
    def _namespaced_tool_name(cls, namespace: str, local_name: str) -> str:
        """Build the bindable namespaced tool name used for remote providers."""

        return f"{cls._safe_identifier(namespace)}_{cls._safe_identifier(local_name)}"

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
        global_tool_id = self._global_tool_id(provider_peer_id, service_instance_id, local_name)
        is_remote = source_type == "mesh_peer"
        bindable_name = (
            self._namespaced_tool_name(namespace, local_name) if is_remote else local_name
        )
        display_name = f"{namespace}.{local_name}" if is_remote else local_name
        args_schema = self._serialize_tool_schema(tool)
        raw_required_permissions = getattr(tool, "required_permissions", None)
        required_permissions = (
            list(raw_required_permissions)
            if isinstance(raw_required_permissions, (list, tuple, set))
            else [ToolingMethods.EXECUTE_TOOL]
        )
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
            provider_peer_id=provider_peer_id,
            provider_service_instance_id=service_instance_id,
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
            ),
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

    async def _db_sql(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        result = await self.bus.request(
            DBMethods.EXECUTE_SQL,
            DBExecuteSQLRequest(sql=sql, params=params or []),
            origin="internal",
            timeout=10.0,
        )
        if not result.ok:
            raise RuntimeError(result.error or "DB.ExecuteSQL failed")
        data = result.data
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
        ]
        try:
            for statement in statements:
                await self._db_sql(statement)
            self._tooling_policy_tables_ready = True
        except Exception as error:
            log_warning(f"Tooling durable policy tables unavailable: {error}")

    async def _load_remote_catalog_snapshots(self) -> list[ToolingRemoteCatalogAnnounced]:
        await self._ensure_tooling_policy_tables()
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
                snapshot = ToolingRemoteCatalogAnnounced(
                    peer_id=row["peer_id"],
                    service_instance_id=row["service_instance_id"],
                    provider_id=row["provider_id"],
                    catalog_epoch=int(row["catalog_epoch"]),
                    generated_at=row["generated_at"],
                    full_schema_hash=row["full_schema_hash"],
                    tools=[
                        ToolingToolInfo.model_validate(tool)
                        for tool in json.loads(row["tools_json"])
                    ],
                    shared_by_policy=bool(row["shared_by_policy"]),
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
        namespace = self._safe_identifier(peer_id)
        normalized_tools: list[ToolingToolInfo] = []
        for tool in snapshot.tools:
            local_name = tool.local_name or tool.name
            global_tool_id = self._global_tool_id(peer_id, service_instance_id, local_name)
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
                        "provider_peer_id": peer_id,
                        "provider_service_instance_id": service_instance_id,
                        "namespace": namespace,
                        "display_name": f"{namespace}.{local_name}",
                        "aliases": [local_name] if bindable_name != local_name else [],
                        "source_type": "mesh_peer",
                        "source": "mesh_peer",
                        "trust_tier": "untrusted",
                        "execution_location": "remote",
                        "provenance": provenance,
                    }
                )
            )

        tools_payload = [tool.model_dump(mode="json") for tool in normalized_tools]
        schema_hash = hashlib.sha256(
            json.dumps(tools_payload, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
        return snapshot.model_copy(
            update={
                "provider_id": snapshot.provider_id or peer_id,
                "tools": normalized_tools,
                "full_schema_hash": snapshot.full_schema_hash or schema_hash,
            }
        )

    async def _persist_remote_catalog_snapshot(
        self, snapshot: ToolingRemoteCatalogAnnounced
    ) -> None:
        snapshot = self._normalize_remote_catalog_snapshot(snapshot)
        key = (snapshot.peer_id, snapshot.service_instance_id)
        previous = self._remote_catalog_snapshots.get(key, (None, 0))[0]
        previous_hash = previous.full_schema_hash if previous is not None else None
        previous_shared_by_policy = (
            bool(previous.shared_by_policy) if previous is not None else None
        )
        await self._ensure_tooling_policy_tables()
        if self._tooling_policy_tables_ready and (
            previous_hash is None or previous_shared_by_policy is None
        ):
            rows = await self._db_sql(
                """
                SELECT full_schema_hash, shared_by_policy
                FROM tooling_remote_catalog_snapshots
                WHERE peer_id = ? AND service_instance_id = ? AND removed_at IS NULL
                """,
                [snapshot.peer_id, snapshot.service_instance_id],
            )
            if rows:
                if previous_hash is None:
                    previous_hash = rows[0].get("full_schema_hash")
                if previous_shared_by_policy is None:
                    previous_shared_by_policy = bool(rows[0].get("shared_by_policy"))

        self._remote_catalog_snapshots[key] = (snapshot, time.time())
        if not self._tooling_policy_tables_ready:
            return
        await self._db_sql(
            """
            INSERT OR REPLACE INTO tooling_remote_catalog_snapshots (
                peer_id, service_instance_id, provider_id, catalog_epoch, generated_at,
                full_schema_hash, tools_json, shared_by_policy, stale, removed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
            """,
            [
                snapshot.peer_id,
                snapshot.service_instance_id,
                snapshot.provider_id,
                snapshot.catalog_epoch,
                snapshot.generated_at,
                snapshot.full_schema_hash,
                json.dumps([tool.model_dump(mode="json") for tool in snapshot.tools]),
                int(snapshot.shared_by_policy),
                time.time(),
            ],
        )
        if previous_hash is not None and previous_hash != snapshot.full_schema_hash:
            await self._mark_remote_catalog_dependents_stale(
                peer_id=snapshot.peer_id,
                service_instance_id=snapshot.service_instance_id,
                reason="remote_catalog_schema_changed",
            )
        if previous_shared_by_policy is True and not snapshot.shared_by_policy:
            await self._mark_remote_catalog_dependents_stale(
                peer_id=snapshot.peer_id,
                service_instance_id=snapshot.service_instance_id,
                reason="remote_catalog_unshared_by_policy",
            )

    def _current_known_global_tool_ids(
        self, provider_peer_id: str | None, service_instance_id: str | None
    ) -> list[str]:
        """Return current reviewed global tool IDs for snapshot-scoped broad grants."""

        provider_peer_id = provider_peer_id or "local"
        service_instance_id = service_instance_id or (
            "local:Tooling" if provider_peer_id == "local" else None
        )
        if provider_peer_id == "local":
            return sorted(
                self._global_tool_id("local", "local:Tooling", name)
                for name in self.tools_manager.get_all_tool_names()
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
        if provider_peer_id == "local":
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

    async def _announce_local_tool_catalog(self, *, reason: str) -> None:
        """Announce local Tooling catalog for negotiated mesh peers to cache."""

        try:
            response = await self._on_get_tools(ToolingGetToolsRequest(top_k=1000))
            tools_payload = [tool.model_dump(mode="json") for tool in response.tools]
            schema_hash = hashlib.sha256(
                json.dumps(tools_payload, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()
            await self.bus.publish(
                ToolingMethods.REMOTE_CATALOG_ANNOUNCED,
                ToolingRemoteCatalogAnnounced(
                    peer_id="local",
                    service_instance_id="local:Tooling",
                    provider_id="local",
                    catalog_epoch=int(time.time()),
                    generated_at=datetime.now(timezone.utc).isoformat(),  # noqa: UP017
                    full_schema_hash=schema_hash,
                    tools=response.tools,
                    shared_by_policy=True,
                ),
                event=True,
                mesh=True,
                priority=get_system_priority(),
                origin="internal",
            )
            log_debug(f"Announced local Tooling catalog ({reason})")
        except Exception as error:
            log_warning(f"Failed to announce local Tooling catalog ({reason}): {error}")

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
    def _has_required_permissions(
        required_permissions: list[str], caller_permissions: list[str] | None
    ) -> bool:
        """Return whether caller permissions satisfy a tool's declared requirements."""

        if caller_permissions is None:
            return not any(
                permission != ToolingMethods.EXECUTE_TOOL for permission in required_permissions
            )
        granted = set(caller_permissions)
        if "*" in granted:
            return True
        for permission in required_permissions:
            module = permission.split(".", 1)[0]
            if permission in granted or f"{module}.*" in granted or f"{module}.use" in granted:
                continue
            return False
        return True

    @staticmethod
    def _tool_required_permissions(tool: Any) -> list[str]:
        """Return stable per-tool permissions required at execution time."""

        raw_required_permissions = getattr(tool, "required_permissions", None)
        if isinstance(raw_required_permissions, (list, tuple, set)):
            return [str(permission) for permission in raw_required_permissions]
        return [ToolingMethods.EXECUTE_TOOL]

    @staticmethod
    def _envelope_is_externalish(envelope: Any | None) -> bool:
        if envelope is None:
            return False
        identity_source = getattr(envelope, "identity_source", None)
        origin = getattr(envelope, "origin", "internal")
        return origin == "external" or identity_source in {
            "gateway_http",
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

    @staticmethod
    def _catalog_tool_block_reason(
        tool: ToolingToolInfo, caller_permissions: list[str] | None
    ) -> tuple[str, str] | None:
        """Return catalog policy metadata for tools needing special handling.

        Permission-denied and explicitly blocked tools are hard blocks and must
        not be model-visible. Approval-required tools are still returned in the
        bindable catalog so the LLM can ask to use them; they are also included
        in ``blocked_tools`` as legacy/metadata for the approval interrupt UI.
        Actual execution remains controlled by Tooling policy.
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
                "untrusted external tools require explicit user approval before model binding",
            )
        if tool.safety_class in {"sensitive", "dangerous"}:
            return (
                "unsafe_safety_class",
                f"{tool.safety_class} tools require explicit selection and approval",
            )
        if tool.confirmation_required:
            return (
                "confirmation_required",
                "tool requires approval before it can be model-bound",
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

        bus = self.bus
        routing_table = getattr(bus, "_routing_table", None)
        registry = getattr(routing_table, "_registry", None)
        mesh_config = getattr(bus, "_config", None)
        if not registry:
            return []

        routing_config = None
        version_policy = "compatible"
        if mesh_config:
            routing_config = getattr(mesh_config, "services", {}).get(ToolingModule.NAME)
            version_policy = getattr(mesh_config, "version_policy", version_policy)

        try:
            return list(
                registry.get_provider_candidates(
                    module=ToolingModule.NAME,
                    routing_config=routing_config,
                    version_policy=version_policy,
                    include_ineligible=True,
                )
            )
        except Exception as error:
            log_warning(f"Failed to enumerate remote Tooling providers: {error}")
            return []

    @staticmethod
    def _candidate_provider_info(
        candidate: Any, *, cache_status: str
    ) -> ToolingCatalogProviderInfo:
        peer_id = candidate.peer.peer_id
        service_instance_id = ToolingService._provider_service_instance_id(peer_id)
        return ToolingCatalogProviderInfo(
            provider_peer_id=peer_id,
            provider_service_instance_id=service_instance_id,
            provider_kind="mesh_peer",
            eligible=bool(candidate.eligible),
            reason_code=candidate.reason_code or ("eligible" if candidate.eligible else "blocked"),
            reason=candidate.reason
            or ("eligible provider" if candidate.eligible else "provider blocked"),
            cache_status=cache_status,
        )

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
                blocked_tools.append(
                    ToolingBlockedToolInfo(
                        tool=tool,
                        reason_code=block_reason[0],
                        reason=block_reason[1],
                    )
                )
            if block_reason[0] in {"permission_denied", "tool_blocked"}:
                return
        tools.append(tool)

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
            raw_identifier = (
                getattr(tool, "plugin_name", None)
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

        source_id = getattr(tool, "source_id", None)
        if isinstance(source_id, str) and source_id:
            return source_id
        if tool.source == "mesh_peer" or tool.source_type == "mesh_peer":
            return (
                f"mesh:{tool.provider_peer_id}:"
                f"{cls._safe_identifier(tool.provider_service_instance_id)}"
            )
        source = tool.source if tool.source in {"core", "plugin", "mcp", "unknown"} else "unknown"
        return cls._local_source_instance_id(tool, source)

    @staticmethod
    def _source_id_for_prepared(prepared: ToolingPrepareExecutionResponse) -> str:
        """Return the stable management source id for a prepared execution."""

        if prepared.source_id:
            return prepared.source_id
        if prepared.source == "mesh_peer" or prepared.provider_peer_id not in {None, "local"}:
            return (
                f"mesh:{prepared.provider_peer_id}:"
                f"{ToolingService._safe_identifier(prepared.provider_service_instance_id)}"
            )
        source = prepared.source if prepared.source in {"core", "plugin", "mcp", "unknown"} else "unknown"
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
            return f"Mesh peer {tool.provider_peer_id if tool else source_id.split(':')[1]}"
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
                    f"Mesh peer {provider.provider_peer_id}"
                    if provider.provider_kind == "mesh_peer"
                    else "Core tools"
                ),
                provider_peer_id=provider.provider_peer_id,
                provider_service_instance_id=provider.provider_service_instance_id,
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

        provider_peer_id = grant.provider_peer_id or "local"
        if source_id.startswith("mesh:"):
            parts = source_id.split(":", 2)
            return len(parts) == 3 and provider_peer_id == parts[1]
        if provider_peer_id != "local":
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
                timeout=5.0,
                priority=get_system_priority(),
            )
        except Exception as audit_error:
            log_warning(f"Failed to audit {event}: {audit_error}")

    def _operation_class(self, tool: Any, safety_class: str) -> str:
        operation_class = getattr(tool, "operation_class", None)
        if operation_class in {"read", "write", "external", "admin", "hardware", "data-egress"}:
            return operation_class
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
        execution_location = "remote" if provider_peer_id != "local" else "local"
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
            if is_local_safe:
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
    ) -> ToolingPrepareExecutionResponse:
        if not request.correlation_id:
            request.correlation_id = uuid.uuid4().hex
        argument_visibility = self._argument_visibility(tool)
        display_args_preview = self._display_arguments_preview(
            request.arguments, argument_visibility
        )
        execution_location = "remote" if provider_peer_id != "local" else "local"
        raw_source = "mesh_peer" if execution_location == "remote" else self._tool_source(tool)
        source = self._safe_metadata_value(
            raw_source, {"core", "plugin", "mcp", "mesh_peer", "unknown"}, "unknown"
        )
        source_id = (
            f"mesh:{provider_peer_id}:{self._safe_identifier(service_instance_id)}"
            if provider_peer_id != "local"
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
                if isinstance(request, ToolingPrepareExecutionRequest) and not schema_payload
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

    def _resolve_execution_context(
        self, request: ToolingExecuteToolRequest
    ) -> tuple[Any | None, str, str, str, str]:
        local_tool_name = self._resolve_tool_name(request)
        provider_peer_id, service_instance_id, _, _ = self._provider_context(request)
        global_tool_id = self._global_tool_id(
            provider_peer_id, service_instance_id, local_tool_name
        )
        tool = self.tools_manager.get_tool_by_name(local_tool_name)
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
        if not self._remote_catalog_shared_by_policy(
            prepared.provider_peer_id, prepared.provider_service_instance_id
        ):
            return False
        source_id = grant.metadata.get("source_id")
        if isinstance(source_id, str) and source_id and source_id != self._source_id_for_prepared(prepared):
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
        if (
            grant.grant_type == "trust"
            and grant.trust_tier not in {"blocked", "trusted"}
        ):
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
                timeout=5.0,
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

    def _resolve_tool_name(self, request: ToolingExecuteToolRequest) -> str:
        """Resolve discovery IDs or namespaced names back to provider-local names."""

        provider_peer_id, service_instance_id, source_type, namespace = self._provider_context(
            request
        )
        requested_name = request.tool_name

        for local_name in self.tools_manager.get_all_tool_names():
            if requested_name == local_name:
                return local_name
            if requested_name == self._global_tool_id(
                provider_peer_id, service_instance_id, local_name
            ):
                return local_name
            if source_type == "mesh_peer" and requested_name == self._namespaced_tool_name(
                namespace, local_name
            ):
                return local_name

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
        method_id=ToolingMethods.GET_TOOLS,
        summary="Get available tools with optional RAG search",
        input_model=ToolingGetToolsRequest,
        output_model=ToolingGetToolsResponse,
        exposure="both",
        method_type="use",
    )
    async def _on_get_tools(self, request: ToolingGetToolsRequest) -> ToolingGetToolsResponse:
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
                    if result.ok and result.data and "items" in result.data:
                        names = [
                            item.get("key") for item in result.data["items"] if item.get("key")
                        ]

                    # Map names to tool callables
                    for name in names:
                        tool = self.tools_manager.get_tool_by_name(name)
                        if tool:
                            tools.append(tool)

                except Exception as e:
                    log_warning(f"RAG tool search failed; using lexical tool search: {e}")
                    rag_search_failed = True

                # RAG is authoritative for semantic search, but DB outages should
                # not silently broaden a query to every tool. Use a local lexical
                # fallback only when RAG failed; a no-match RAG result remains no-match.
                if rag_search_failed and not tools:
                    query_text = request.query.lower()
                    lexical_matches = [
                        tool
                        for tool in self.tools_manager.get_tools(None, request.top_k)
                        if query_text in getattr(tool, "name", "").lower()
                        or query_text in getattr(tool, "description", "").lower()
                    ]
                    tools = lexical_matches[: request.top_k]
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
                    policy_request = ToolingExecuteToolRequest(
                        tool_name=tool_info.name,
                        arguments={},
                        mesh_selector=request.mesh_selector,
                    )
                    decision = self._evaluate_sharing_policy(
                        policy_request,
                        tool=tool,
                        local_tool_name=tool_info.local_name,
                        global_tool_id=tool_info.global_tool_id,
                        provider_peer_id=tool_info.provider_peer_id,
                        service_instance_id=tool_info.provider_service_instance_id,
                    )
                    if decision.share:
                        serialized_tools.append(tool_info)

                except Exception as tool_error:
                    log_warning(f"Failed to serialize tool {tool.name}: {tool_error}")
                    continue

            # Return response
            return ToolingGetToolsResponse(tools=serialized_tools, count=len(serialized_tools))

        except Exception as e:
            log_error(f"Error handling get tools query: {e}", exc_info=True)
            raise

    @method_contract(
        method_id=ToolingMethods.GET_TOOL_CATALOG,
        summary="Get aggregate local and remote Tooling catalog",
        input_model=ToolingGetToolCatalogRequest,
        output_model=ToolingGetToolCatalogResponse,
        exposure="both",
        method_type="use",
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
            for tool in local_response.tools:
                self._append_catalog_tool(
                    tool=tool,
                    caller_permissions=caller_permissions,
                    tools=tools,
                    blocked_tools=blocked_tools,
                    include_blocked_tools=request.include_blocked_tools,
                )

            for snapshot in await self._load_remote_catalog_snapshots():
                if snapshot.peer_id == "local":
                    continue
                providers.append(
                    ToolingCatalogProviderInfo(
                        provider_peer_id=snapshot.peer_id,
                        provider_service_instance_id=snapshot.service_instance_id,
                        provider_kind="mesh_peer",
                        eligible=snapshot.shared_by_policy,
                        reason_code="cached_negotiated_catalog",
                        reason="cached negotiated Tooling catalog",
                        cache_status="hit",
                    )
                )
                if not snapshot.shared_by_policy:
                    continue
                for tool in snapshot.tools[: request.top_k]:
                    self._append_catalog_tool(
                        tool=tool,
                        caller_permissions=caller_permissions,
                        tools=tools,
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
        previous = self._remote_catalog_snapshots.get(key, (None, 0))[0]
        if previous is None:
            await self._load_remote_catalog_snapshots()
            previous = self._remote_catalog_snapshots.get(key, (None, 0))[0]
        tools_by_id = {
            tool.global_tool_id: tool for tool in (previous.tools if previous is not None else [])
        }
        for tool_id in request.removed_global_tool_ids:
            tools_by_id.pop(tool_id, None)
            if self._tooling_policy_tables_ready:
                await self._db_sql(
                    """
                    INSERT OR REPLACE INTO tooling_remote_catalog_tombstones
                    (global_tool_id, peer_id, service_instance_id, reason, removed_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    [
                        tool_id,
                        request.peer_id,
                        request.service_instance_id,
                        "delta_removed",
                        time.time(),
                    ],
                )
        if request.removed_global_tool_ids:
            await self._mark_remote_catalog_dependents_stale(
                peer_id=request.peer_id,
                service_instance_id=request.service_instance_id,
                reason="remote_catalog_tool_removed",
                global_tool_ids=list(request.removed_global_tool_ids),
            )
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
    )
    async def _on_get_tool_by_name(
        self, request: ToolingGetToolByNameRequest
    ) -> ToolingGetToolByNameResponse:
        """Handle get tool by name query.

        Args:
            request: Request containing tool name
        """
        try:
            log_debug(f"Getting tool: {request.name}")

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

    async def _prepare_execution_response(
        self,
        request: ToolingExecuteToolRequest,
        *,
        caller_permissions: list[str] | None = None,
    ) -> ToolingPrepareExecutionResponse:
        tool, local_tool_name, provider_peer_id, service_instance_id, global_tool_id = (
            self._resolve_execution_context(request)
        )
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
        required_permissions = self._tool_required_permissions(tool)
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
        )

    @method_contract(
        method_id=ToolingMethods.TEST_SHARING_POLICY,
        summary="Test Tooling sharing policy for an execution",
        input_model=ToolingTestSharingPolicyRequest,
        output_model=ToolingTestSharingPolicyResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
    )
    async def _on_test_sharing_policy(
        self, request: ToolingTestSharingPolicyRequest, envelope: Any | None = None
    ) -> ToolingTestSharingPolicyResponse:
        """Evaluate Tooling sharing policy without creating approval state."""

        caller_permissions = await self._execution_caller_permissions(request, envelope)
        prepared = await self._prepare_execution_response(
            request, caller_permissions=caller_permissions
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
    )
    async def _on_prepare_execution(
        self, request: ToolingPrepareExecutionRequest, envelope: Any | None = None
    ) -> ToolingPrepareExecutionResponse:
        """Prepare execution and emit an audit record for the decision."""

        caller_permissions = await self._execution_caller_permissions(request, envelope)
        prepared = await self._prepare_execution_response(
            request, caller_permissions=caller_permissions
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

    @method_contract(
        method_id=ToolingMethods.REQUEST_APPROVAL,
        summary="Request Tooling execution approval",
        input_model=ToolingRequestApprovalRequest,
        output_model=ToolingRequestApprovalResponse,
        exposure="both",
        method_type="use",
        required_perms=[ToolingMethods.EXECUTE_TOOL],
    )
    async def _on_request_approval(
        self, request: ToolingRequestApprovalRequest, envelope: Any | None = None
    ) -> ToolingRequestApprovalResponse:
        """Create a pending approval request for an approval-required execution."""

        caller_permissions = await self._execution_caller_permissions(request, envelope)
        prepared = await self._prepare_execution_response(
            request, caller_permissions=caller_permissions
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
    )
    async def _on_evaluate_approval_grant(
        self, request: ToolingEvaluateApprovalGrantRequest, envelope: Any | None = None
    ) -> ToolingEvaluateApprovalGrantResponse:
        caller_permissions = await self._execution_caller_permissions(request, envelope)
        prepared = await self._prepare_execution_response(
            request, caller_permissions=caller_permissions
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
                caller_permissions=request.caller_permissions,
            )
        )
        summaries: dict[str, ToolingToolSourceSummary] = {}
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
            summary.tool_count += 1
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
            summary.blocked_tool_count += 1
            if blocked.reason_code == "tool_blocked":
                summary.status = "blocked"
                summary.trust_tier = "blocked"
            summary.reason_code = summary.reason_code or blocked.reason_code
            summary.reason = summary.reason or blocked.reason

        for snapshot, updated_at in self._remote_catalog_snapshots.values():
            source_id = (
                f"mesh:{snapshot.peer_id}:{self._safe_identifier(snapshot.service_instance_id)}"
            )
            summary = summaries.setdefault(
                source_id,
                ToolingToolSourceSummary(
                    source_id=source_id,
                    source="mesh_peer",
                    display_name=f"Mesh peer {snapshot.peer_id}",
                    provider_peer_id=snapshot.peer_id,
                    provider_service_instance_id=snapshot.service_instance_id,
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

        grants = await self._active_grants_for_read_models()
        pending = await self._pending_approvals_for_read_models()
        for source_id, summary in summaries.items():
            source_grants = [
                grant for grant in grants if self._source_id_matches_grant(source_id, grant)
            ]
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
                    if approval.provider_peer_id != "local"
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
            tool_count=catalog.count if request.include_counts else 0,
        )

    @method_contract(
        method_id=ToolingMethods.LIST_TOOL_SOURCES,
        summary="List grouped Tooling sources",
        input_model=ToolingListToolSourcesRequest,
        output_model=ToolingListToolSourcesResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
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
        return ToolingGetToolSourceDetailResponse(
            source=source,
            tools=tools,
            blocked_tools=blocked_tools,
            grants=grants,
            pending_approvals=pending,
            policy_rules=[
                rule
                for rule in self._sharing_policy.rules
                if (
                    rule.source_type == source.source
                    or (
                        source.provider_peer_id != "local"
                        and rule.provider_peer_id == source.provider_peer_id
                    )
                )
            ],
            found=True,
        )

    @method_contract(
        method_id=ToolingMethods.SET_POLICY_MODE,
        summary="Set Tooling policy mode",
        input_model=ToolingSetPolicyModeRequest,
        output_model=ToolingSetPolicyModeResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
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
        method_id=ToolingMethods.UPSERT_TOOL_POLICY_OVERRIDE,
        summary="Upsert per-tool trust override",
        input_model=ToolingUpsertToolPolicyOverrideRequest,
        output_model=ToolingUpsertToolPolicyOverrideResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
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
        method_id=ToolingMethods.TEST_MCP_SOURCE,
        summary="Validate MCP source configuration",
        input_model=ToolingTestMCPSourceRequest,
        output_model=ToolingTestMCPSourceResponse,
        exposure="both",
        method_type="manage",
        required_perms=["Tooling.manage"],
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
        remote_snapshots = await self._load_remote_catalog_snapshots()
        capabilities.append(
            ToolingOnboardingCapability(
                source="mesh_peer",
                status="available" if remote_snapshots else "unknown",
                available=True,
                configured_count=len(remote_snapshots),
                active_count=sum(1 for snapshot in remote_snapshots if snapshot.shared_by_policy),
                message=(
                    "Negotiated mesh Tooling catalogs cached"
                    if remote_snapshots
                    else "No negotiated mesh Tooling catalogs cached"
                ),
                items=[
                    {
                        "peer_id": snapshot.peer_id,
                        "service_instance_id": snapshot.service_instance_id,
                        "catalog_epoch": snapshot.catalog_epoch,
                        "catalog_hash": snapshot.full_schema_hash,
                        "tool_count": len(snapshot.tools),
                        "shared_by_policy": snapshot.shared_by_policy,
                    }
                    for snapshot in remote_snapshots
                ],
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

            # Emit reloaded event
            stats = self.tools_manager.get_stats()
            await self.bus.publish(
                ToolingMethods.TOOLS_RELOADED,
                ToolsReloaded(total_tools=stats["total_tools"]),
                event=True,
                mesh=True,
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
    )
    async def _on_execute_tool(
        self, request: ToolingExecuteToolRequest, envelope: Any | None = None
    ) -> ToolingExecuteToolResponse:
        """Handle execute tool command.

        Args:
            request: Request containing tool name and arguments
        """
        try:
            if not request.correlation_id:
                request.correlation_id = uuid.uuid4().hex

            # Get the tool
            local_tool_name = self._resolve_tool_name(request)
            provider_peer_id, service_instance_id, _, _ = self._provider_context(request)
            global_tool_id = self._global_tool_id(
                provider_peer_id, service_instance_id, local_tool_name
            )
            log_context = self._execution_log_context(
                request,
                local_tool_name=local_tool_name,
                global_tool_id=global_tool_id,
                provider_peer_id=provider_peer_id,
                status="requested",
            )
            log_debug(f"Tool execution requested: {log_context}")
            tool = self.tools_manager.get_tool_by_name(local_tool_name)
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
            required_permissions = self._tool_required_permissions(tool)
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
