"""Tooling Service for Aurora's parallel architecture.

This service:
- Manages all tools (core, plugin, MCP)
- Handles tool initialization and lifecycle
- Exposes tool queries via message bus
- Emits events when tools change
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import secrets
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import MessageBus
from app.messaging.priority_helpers import get_interactive_priority, get_system_priority
from app.services.tooling.tools_manager import ToolsManager, set_tools_manager
from app.shared.contracts.models.auth import (
    AuthMethods,
    PrincipalGetRequest,
    StoreAuditEventRequest,
)
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.tooling import (
    ToolingBlockedToolInfo,
    ToolingCatalogProviderInfo,
    ToolingConfirmExecutionRequest,
    ToolingConfirmExecutionResponse,
    ToolingExecuteToolRequest,
    ToolingExecuteToolResponse,
    ToolingGetMCPStatusRequest,
    ToolingGetMCPStatusResponse,
    ToolingGetSharingPolicyRequest,
    ToolingGetSharingPolicyResponse,
    ToolingGetStatsRequest,
    ToolingGetStatsResponse,
    ToolingGetToolByNameRequest,
    ToolingGetToolByNameResponse,
    ToolingGetToolCatalogRequest,
    ToolingGetToolCatalogResponse,
    ToolingGetToolsRequest,
    ToolingGetToolsResponse,
    ToolingMethods,
    ToolingModule,
    ToolingPolicyDecision,
    ToolingPrepareExecutionRequest,
    ToolingPrepareExecutionResponse,
    ToolingReloadMCPRequest,
    ToolingRequestApprovalRequest,
    ToolingRequestApprovalResponse,
    ToolingSetSharingPolicyRequest,
    ToolingSetSharingPolicyResponse,
    ToolingSharingPolicy,
    ToolingSharingPolicyRule,
    ToolingTestSharingPolicyRequest,
    ToolingTestSharingPolicyResponse,
    ToolingToolInfo,
    ToolingToolProvenance,
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
        self.tools_manager = ToolsManager(self.bus)
        self._catalog_cache: dict[str, tuple[float, ToolingGetToolsResponse]] = {}
        self._sharing_policy = ToolingSharingPolicy()
        self._approval_requests: dict[str, dict[str, Any]] = {}
        self._approval_tokens: dict[str, dict[str, Any]] = {}

    async def on_start(self) -> None:
        """Start the tooling service and initialize tools."""
        log_info("Starting Tooling service...")

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
            log_info("Reloading tools due to config change...")
            await self.tools_manager.reload()
            self._catalog_cache.clear()
        log_info("ToolingService configuration reloaded")

    @staticmethod
    def _tool_source(tool: Any) -> str:
        """Best-effort source classification for a loaded tool."""

        if getattr(tool, "_is_mcp_tool", False):
            return "mcp"
        module_name = getattr(tool, "__module__", "") or tool.__class__.__module__
        if ".plugins." in module_name or module_name.endswith("_toolkit"):
            return "plugin"
        if module_name.startswith("app.services.tooling.tools"):
            return "core"
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
        required_permissions = getattr(tool, "required_permissions", None) or [
            ToolingMethods.EXECUTE_TOOL
        ]

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
            source_type=source_type,
            execution_location="remote" if is_remote else "local",
            safety_class=self._safe_metadata_value(
                getattr(tool, "safety_class", "standard"),
                {"standard", "sensitive", "dangerous"},
                "standard",
            ),
            required_permissions=list(required_permissions),
            confirmation_required=bool(getattr(tool, "confirmation_required", False)),
            rate_limit_hints=getattr(tool, "rate_limit_hints", None),
            provenance=ToolingToolProvenance(
                provider_peer_id=provider_peer_id,
                provider_service_instance_id=service_instance_id,
                provider_kind=source_type,
                source=self._safe_metadata_value(
                    self._tool_source(tool), {"core", "plugin", "mcp", "unknown"}, "unknown"
                ),
                advertised_name=local_name,
            ),
        )

    @staticmethod
    def _safe_metadata_value(value: Any, allowed: set[str], fallback: str) -> str:
        """Return value if allowed, otherwise a stable fallback."""

        return value if isinstance(value, str) and value in allowed else fallback

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

    @classmethod
    def _arguments_fingerprint(cls, arguments: dict[str, Any]) -> str:
        """Hash redacted arguments so audit can correlate calls without leaking values."""

        redacted = cls._redact_arguments(arguments)
        serialized = json.dumps(redacted, sort_keys=True, default=str, separators=(",", ":"))
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
        serialized = json.dumps(
            selector_fields, sort_keys=True, default=str, separators=(",", ":")
        )
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
    def _catalog_tool_block_reason(
        tool: ToolingToolInfo, caller_permissions: list[str] | None
    ) -> tuple[str, str] | None:
        """Return why a discovered tool must not be bound directly to the LLM."""

        if not ToolingService._has_required_permissions(
            tool.required_permissions, caller_permissions
        ):
            return (
                "permission_denied",
                "caller principal lacks required tool permissions",
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
            return
        tools.append(tool)

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
        resource_selector = request.resource_selector
        mesh_selector = request.mesh_selector
        return {
            "tool_name": local_tool_name,
            "global_tool_id": global_tool_id,
            "execution_location": execution_location,
            "source_type": self._tool_source(tool),
            "toolkit_name": self._toolkit_name(tool),
            "safety_class": safety_class,
            "operation_class": self._operation_class(tool, safety_class),
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
        rule_fields = rule.model_dump(
            exclude={"share", "approval_mode", "token_ttl_seconds"}
        )
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
        token_ttl_seconds = (
            matched_rule.token_ttl_seconds if matched_rule else policy.default_token_ttl_seconds
        )
        safety_class = context["safety_class"]
        requires_tool_approval = self._tool_requires_confirmation(tool, safety_class)
        is_local_safe = (
            context["execution_location"] == "local"
            and safety_class == "standard"
            and not getattr(tool, "confirmation_required", False)
        )
        approval_required = requires_tool_approval or bool(
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
        allowed = share and mode != "deny_all"
        reason = None

        if not share:
            allowed = False
            reason = "tool_not_shared"
        elif mode == "deny_all":
            reason = "policy_denied"
        elif mode == "dry_run_only" and not request.dry_run:
            allowed = False
            reason = "dry_run_only"
        elif mode == "approve_all_for_peer" and not request.caller_peer_id:
            allowed = False
            reason = "peer_required_for_approve_all"
        elif mode == "approve_all_local_safe":
            if is_local_safe:
                approval_required = False
            elif requires_tool_approval:
                approval_required = True
            else:
                approval_required = False

        if request.dry_run and share and mode != "deny_all":
            allowed = True
            reason = None

        if mode in {"approve_all_for_session", "approve_all_for_peer"} and allowed:
            approval_required = False

        return ToolingPolicyDecision(
            allowed=allowed,
            share=share,
            approval_required=approval_required,
            approval_mode=mode,
            decision_id=uuid.uuid4().hex,
            policy_rule_id=matched_rule.rule_id if matched_rule else None,
            reason=reason,
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
        )

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
            "expires_at": time.time() + prepared.policy_decision.token_ttl_seconds,
            "nonce": uuid.uuid4().hex,
            "approver_principal_id": approver_principal_id,
            "policy_decision_id": prepared.policy_decision.decision_id,
            "approval_mode": prepared.policy_decision.approval_mode,
            "used": False,
        }

    def _validate_approval_token(
        self,
        request: ToolingExecuteToolRequest,
        *,
        prepared: ToolingPrepareExecutionResponse,
    ) -> tuple[bool, str | None]:
        token = request.approval_token
        if not token:
            return False, "approval_token_required"
        claims = self._approval_tokens.get(token)
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
        }
        for field_name, expected_value in expected.items():
            if claims.get(field_name) != expected_value:
                return False, f"approval_token_{field_name}_mismatch"
        claims["used"] = True
        return True, None

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
            token_ok, token_error = self._validate_approval_token(request, prepared=prepared)
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
                    log_warning(f"RAG tool search failed, falling back: {e}")
                    tools = []

                # Fallback to all tools if none found
                if not tools:
                    tools = self.tools_manager.get_tools(None, request.top_k)
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
            return ToolingGetToolsResponse(tools=[], count=0)

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

            eligible_candidates = []
            for candidate in self._remote_tooling_candidates():
                if not candidate.eligible:
                    if request.include_unavailable:
                        providers.append(
                            self._candidate_provider_info(candidate, cache_status="blocked")
                        )
                    continue
                eligible_candidates.append(candidate)

            remote_results = await asyncio.gather(
                *[
                    self._get_remote_provider_tools(candidate, request)
                    for candidate in eligible_candidates
                ],
                return_exceptions=True,
            )
            for candidate, result in zip(eligible_candidates, remote_results, strict=False):
                if isinstance(result, Exception):
                    peer_id = candidate.peer.peer_id
                    service_instance_id = self._provider_service_instance_id(peer_id)
                    provider = ToolingCatalogProviderInfo(
                        provider_peer_id=peer_id,
                        provider_service_instance_id=service_instance_id,
                        provider_kind="mesh_peer",
                        eligible=False,
                        reason_code="provider_request_failed",
                        reason=f"remote Tooling.GetTools request failed: {type(result).__name__}",
                        cache_status="failed",
                    )
                    remote_tools = []
                else:
                    provider, remote_tools = result

                if request.include_unavailable or provider.eligible:
                    providers.append(provider)
                for tool in remote_tools:
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
        """Replace the current in-memory Tooling sharing policy."""

        self._sharing_policy = request.policy
        await self._audit_tooling_event(
            "tooling.policy.set",
            principal_id=request.actor_principal_id,
            details={
                "correlation_id": request.correlation_id,
                "default_share": request.policy.default_share,
                "default_approval_mode": request.policy.default_approval_mode,
                "rule_count": len(request.policy.rules),
            },
        )
        return ToolingSetSharingPolicyResponse(
            ok=True,
            policy=self._sharing_policy,
            correlation_id=request.correlation_id,
        )

    async def _prepare_execution_response(
        self, request: ToolingExecuteToolRequest
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
        self, request: ToolingTestSharingPolicyRequest
    ) -> ToolingTestSharingPolicyResponse:
        """Evaluate Tooling sharing policy without creating approval state."""

        prepared = await self._prepare_execution_response(request)
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
        self, request: ToolingPrepareExecutionRequest
    ) -> ToolingPrepareExecutionResponse:
        """Prepare execution and emit an audit record for the decision."""

        prepared = await self._prepare_execution_response(request)
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
        self, request: ToolingRequestApprovalRequest
    ) -> ToolingRequestApprovalResponse:
        """Create a pending approval request for an approval-required execution."""

        prepared = await self._prepare_execution_response(request)
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
        }
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
        self, request: ToolingConfirmExecutionRequest
    ) -> ToolingConfirmExecutionResponse:
        """Approve or deny a pending execution request."""

        pending = self._approval_requests.get(request.approval_request_id)
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
                principal_id=request.approver_principal_id,
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
        pending["used"] = True
        if not request.approve:
            await self._audit_tooling_event(
                "tooling.approval.denied",
                principal_id=request.approver_principal_id,
                details={
                    "approval_request_id": request.approval_request_id,
                    "correlation_id": correlation_id,
                    "decision_id": prepared.policy_decision.decision_id,
                    "reason": request.reason,
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
            approver_principal_id=request.approver_principal_id,
        )
        self._approval_tokens[token] = claims
        await self._audit_tooling_event(
            "tooling.approval.approved",
            principal_id=request.approver_principal_id,
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
        self, request: ToolingExecuteToolRequest
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
                )

            except Exception as tool_error:
                error_type = type(tool_error).__name__
                error_msg = f"Tool execution failed: {error_type}"
                log_context = self._execution_log_context(
                    request,
                    local_tool_name=local_tool_name,
                    global_tool_id=global_tool_id,
                    provider_peer_id=provider_peer_id,
                    status="failed",
                    error_code="tool_execution_failed",
                    error_type=error_type,
                )
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
                    data=None,
                    status="failed",
                    error_code="tool_execution_failed",
                    correlation_id=request.correlation_id,
                    provider_peer_id=provider_peer_id,
                    global_tool_id=global_tool_id,
                    policy_decision_id=prepared_for_audit.policy_decision.decision_id,
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
            )
