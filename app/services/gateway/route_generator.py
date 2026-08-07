"""Dynamic Route Generator for FastAPI.

This module generates FastAPI routes dynamically from the contract registry.
Uses lazy generation - routes are created when registry changes, not at startup.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError, create_model

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging.priority_helpers import get_system_priority
from app.services.gateway.admin_action import (
    ADMIN_ACTION_DIGEST_HEADER,
    ADMIN_ACTION_ID_HEADER,
    ADMIN_ACTION_REQUIRED_HEADERS,
    ADMIN_ACTION_TOKEN_HEADER,
    AdminActionManager,
    AdminActionReceipt,
    admin_action_digest,
)
from app.services.gateway.orchestrator_runtime_policy import (
    remote_data_movement_denial_reason,
    runtime_dispatch_selector_present,
    selector_from_mapping,
)
from app.shared.config.interface import ConfigAPI
from app.shared.contracts.models.auth import AuthMethods, StoreAuditEventRequest
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.db import (
    DBEnsureSessionRequest,
    DBMethods,
    DBSaveMessageRequest,
)
from app.shared.contracts.models.gateway import GatewayMethods, MethodInfo, RouteExplainRequest
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.mesh.tracing import redacted_copy

if TYPE_CHECKING:
    from fastapi import APIRouter

    from app.messaging.bus import MessageBus
    from app.services.gateway.registry_aggregator import RegistryAggregator


# Base class for dynamic models - ignore extra fields for clean schemas
class DynamicModelBase(BaseModel):
    """Base class for dynamically created models."""

    # Use "ignore" to silently drop extra fields without adding
    # additionalProperties to the schema (avoids additionalProp1 in Swagger)
    model_config = ConfigDict(extra="ignore")


_ADMIN_ACTION_REQUIRED_TOPICS = {
    AuthMethods.CREATE_PRINCIPAL,
    AuthMethods.UPDATE_PRINCIPAL,
    AuthMethods.DELETE_PRINCIPAL,
    AuthMethods.SET_PERMISSIONS,
    AuthMethods.PATCH_PERMISSIONS,
    AuthMethods.CHANGE_PASSWORD,
    AuthMethods.CREATE_TOKEN,
    AuthMethods.UPDATE_TOKEN_SCOPES,
    AuthMethods.REVOKE_TOKEN,
    AuthMethods.DELETE_DEVICE,
    AuthMethods.MESH_APPROVE_PEER,
    AuthMethods.MESH_DENY_PEER,
    AuthMethods.MESH_UPDATE_PEER_PERMISSIONS,
    AuthMethods.MESH_REMOVE_PEER,
    ConfigMethods.SET,
    ConfigMethods.SET_PLUGIN,
}

_ADMIN_ACTION_EXEMPT_TOPICS = {
    AuthMethods.AUDIT_LOG,
    AuthMethods.LIST_DEVICES,
    AuthMethods.LIST_PENDING_PAIRINGS,
    AuthMethods.LIST_PRINCIPALS,
    AuthMethods.LIST_TOKENS,
    GatewayMethods.ADMIN_ACTION_DRAFT,
    GatewayMethods.ADMIN_ACTION_CONFIRM,
    GatewayMethods.EXPLAIN_ROUTE,
    GatewayMethods.GET_CAPABILITY_CATALOG,
    GatewayMethods.GET_CAPABILITY_GRAPH,
    GatewayMethods.GET_MESH_STATUS,
    GatewayMethods.GET_MESH_INVITE_CONFIG,
    GatewayMethods.GET_SUPPORT_BUNDLE,
    GatewayMethods.LIST_EVENTS,
    # Tooling management read models: contract-level method_type stays "manage"
    # (RBAC still requires Tooling.manage), but pure reads must not demand a
    # per-request AdminAction confirmation ceremony.
    ToolingMethods.GET_SHARING_POLICY,
    ToolingMethods.GET_POLICY_SUMMARY,
    ToolingMethods.GET_TOOL_SOURCE_DETAIL,
    ToolingMethods.GET_ONBOARDING_STATUS,
    ToolingMethods.LIST_APPROVAL_GRANTS,
    ToolingMethods.LIST_PENDING_APPROVALS,
    ToolingMethods.LIST_POLICY_AUDIT_EVENTS,
    ToolingMethods.LIST_TOOL_SOURCES,
    ToolingMethods.TEST_SHARING_POLICY,
}

_admin_action_digest = admin_action_digest

# Provider-local confirmation is intentionally allowed to wait for up to one
# minute on the device that owns a sensitive feature. The gateway must outlive
# that window so a deny/allow decision returns as an application response
# instead of becoming an ambiguous transport timeout.
_REMOTE_TOOL_APPROVAL_REQUEST_TIMEOUT_SECONDS = 75.0
_SERVICE_AUTHORIZATION_ERROR_CODES = {
    "permission_denied",
    "projection_authority_unknown",
    "projection_ledger_unavailable",
    "projection_restart_required",
    "provider_mesh_tooling_disabled",
}


def _service_error_status_code(error: str | None) -> int:
    """Map explicit service authorization failures without hiding real faults."""

    if error in _SERVICE_AUTHORIZATION_ERROR_CODES:
        return 403
    return 500


def _request_timeout_for(topic: str, payload: Any, default_timeout: float) -> float:
    if (
        topic == ToolingMethods.EXECUTE_TOOL
        and isinstance(payload, Mapping)
        and payload.get("mesh_selector")
    ):
        return max(default_timeout, _REMOTE_TOOL_APPROVAL_REQUEST_TIMEOUT_SECONDS)
    return default_timeout


async def _apply_orchestrator_dispatch_default(topic: str, payload: Any) -> Any:
    if topic != OrchestratorMethods.EXTERNAL_USER_INPUT or not isinstance(payload, dict):
        return payload
    if runtime_dispatch_selector_present(topic, payload):
        return payload
    try:
        services = await ConfigAPI().aget_config("services", timeout=5.0)
    except Exception as exc:
        log_debug(f"Could not load orchestrator dispatch default: {exc}")
        return payload
    orchestrator = services.get("orchestrator", {}) if isinstance(services, dict) else {}
    routing = orchestrator.get("routing", {}) if isinstance(orchestrator, dict) else {}
    dispatch_default = routing.get("dispatch_default", {}) if isinstance(routing, dict) else {}
    if not isinstance(dispatch_default, Mapping) or not dispatch_default.get("enabled", False):
        return payload
    selector = selector_from_mapping(dispatch_default)
    if selector is None:
        return payload
    updated = dict(payload)
    updated["dispatch_selector"] = selector.model_dump(exclude_none=True)
    return updated


def _response_mapping(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return value
    if hasattr(value, "model_dump"):
        dumped = value.model_dump()
        return dumped if isinstance(dumped, Mapping) else None
    return None


async def _dispatch_peer_name(
    bus: MessageBus,
    *,
    peer_id: str,
    principal_id: str,
) -> str | None:
    """Resolve a stable peer ID to its current human-readable mesh node name."""

    try:
        result = await bus.request(
            GatewayMethods.GET_MESH_STATUS,
            EmptyInput(),
            timeout=5.0,
            priority=get_system_priority(),
            origin="internal",
            principal_id=principal_id,
        )
        if not result.ok:
            return None
        status = _response_mapping(result.data)
        peers = status.get("peers") if status is not None else None
        if not isinstance(peers, list):
            return None
        for peer in peers:
            peer_data = _response_mapping(peer)
            if peer_data is None or peer_data.get("peer_id") != peer_id:
                continue
            node_name = peer_data.get("node_name")
            return node_name.strip() if isinstance(node_name, str) and node_name.strip() else None
    except Exception as exc:
        log_debug(f"Could not resolve dispatched peer display name for {peer_id}: {exc}")
    return None


async def _persist_dispatched_assistant_turn(
    bus: MessageBus,
    *,
    payload: Mapping[str, Any],
    response_data: Any,
    principal_id: str | None,
) -> None:
    """Persist a remotely executed chat turn on the device that originated it."""

    response = _response_mapping(response_data)
    user_text = payload.get("text")
    assistant_text = response.get("text") if response is not None else None
    session_id = (
        (response.get("session_id") if response is not None else None)
        or payload.get("session_id")
        or payload.get("request_id")
        or payload.get("correlation_id")
    )
    if (
        not isinstance(user_text, str)
        or not isinstance(assistant_text, str)
        or not isinstance(session_id, str)
        or not session_id.strip()
    ):
        log_warning(
            "Skipping origin persistence for dispatched assistant turn because "
            "the response did not include persistable text/session data"
        )
        return

    owner_principal_id = principal_id or "system"
    selector = next(
        (
            selector_from_mapping(payload.get(key))
            for key in ("dispatch_selector", "mesh_selector", "selector")
            if selector_from_mapping(payload.get(key)) is not None
        ),
        None,
    )
    dispatch_metadata = {
        "source_type": "Text",
        "execution": "remote_dispatch",
    }
    if response is not None and isinstance(response.get("metadata"), Mapping):
        dispatch_metadata.update(response["metadata"])
        dispatch_metadata["source_type"] = "Text"
        dispatch_metadata["execution"] = "remote_dispatch"
    if selector is not None:
        dispatch_metadata["dispatch_selector"] = selector.model_dump(exclude_none=True)
        if selector.peer_id:
            dispatch_metadata["execution_peer_id"] = selector.peer_id
            peer_name = await _dispatch_peer_name(
                bus,
                peer_id=selector.peer_id,
                principal_id=owner_principal_id,
            )
            if peer_name:
                dispatch_metadata["execution_peer_name"] = peer_name

    ensure_result = await bus.request(
        DBMethods.ENSURE_SESSION,
        DBEnsureSessionRequest(
            principal_id=owner_principal_id,
            type="chat",
            session_id=session_id,
            title=user_text.strip()[:80] or None,
            activate=True,
        ),
        timeout=10.0,
        priority=get_system_priority(),
        origin="internal",
        principal_id=owner_principal_id,
    )
    if not ensure_result.ok:
        raise RuntimeError(ensure_result.error or "DB.EnsureSession failed")

    for role, content in (("user", user_text), ("assistant", assistant_text)):
        save_result = await bus.request(
            DBMethods.SAVE_MESSAGE,
            DBSaveMessageRequest(
                content=content,
                role=role,
                session_id=session_id,
                principal_id=owner_principal_id,
                session_type="chat",
                metadata=dict(dispatch_metadata),
            ),
            timeout=10.0,
            priority=get_system_priority(),
            origin="internal",
            principal_id=owner_principal_id,
        )
        if not save_result.ok:
            raise RuntimeError(save_result.error or f"DB.SaveMessage failed for {role} turn")
        success = (
            save_result.data.get("success")
            if isinstance(save_result.data, Mapping)
            else getattr(save_result.data, "success", False)
        )
        if not success:
            raise RuntimeError(f"DB.SaveMessage did not commit the {role} turn")

    log_info(f"Persisted remotely dispatched assistant turn in origin session {session_id}")


def _admin_action_required(topic: str, method_type: str | None = None) -> bool:
    if topic in _ADMIN_ACTION_EXEMPT_TOPICS:
        return False
    return topic in _ADMIN_ACTION_REQUIRED_TOPICS or method_type == "manage"


async def _enforce_admin_action(
    bus: MessageBus,
    manager: AdminActionManager,
    *,
    topic: str,
    principal_id: str | None,
    payload: dict[str, Any],
    headers: Mapping[str, str],
) -> AdminActionReceipt:
    """Require explicit AdminAction confirmation for high-risk generated routes."""
    from fastapi import HTTPException

    action_id = headers.get(ADMIN_ACTION_ID_HEADER, "").strip()
    confirmation_token = headers.get(ADMIN_ACTION_TOKEN_HEADER, "").strip()
    digest = headers.get(ADMIN_ACTION_DIGEST_HEADER, "").strip()

    missing = [
        name
        for name, value in (
            (ADMIN_ACTION_ID_HEADER, action_id),
            (ADMIN_ACTION_TOKEN_HEADER, confirmation_token),
            (ADMIN_ACTION_DIGEST_HEADER, digest),
        )
        if not value
    ]
    if missing:
        raise HTTPException(
            status_code=428,
            detail={
                "code": "admin_action_required",
                "message": "AdminAction confirmation is required",
                "missing_headers": missing,
                "required_headers": list(ADMIN_ACTION_REQUIRED_HEADERS),
            },
        )

    receipt = manager.consume(
        action_id=action_id,
        confirmation_token=confirmation_token,
        digest=digest,
        method_id=topic,
        principal_id=principal_id,
        payload=payload,
    )

    details = {
        "action_id": receipt.action_id,
        "audit_receipt": receipt.audit_receipt,
        "topic": topic,
        "principal_id": principal_id,
        "reason": receipt.reason,
        "request_digest": digest,
        "affected_resources": receipt.affected_resources,
        "reauth_confirmed": True,
    }
    try:
        result = await bus.request(
            AuthMethods.STORE_AUDIT_EVENT,
            StoreAuditEventRequest(
                event="admin.action.confirmed",
                principal_id=principal_id,
                details=json.dumps(details, sort_keys=True),
            ),
            timeout=5.0,
            origin="internal",
            principal_id=principal_id,
        )
        if hasattr(result, "ok") and not result.ok:
            raise RuntimeError(result.error or "audit storage failed")
        if hasattr(result, "data") and hasattr(result.data, "success") and not result.data.success:
            raise RuntimeError(getattr(result.data, "message", None) or "audit storage failed")
    except Exception as exc:
        log_warning(f"Failed to audit AdminAction for {topic}: {exc}")
        raise HTTPException(
            status_code=500,
            detail={
                "code": "admin_action_audit_failed",
                "message": "AdminAction audit storage failed; request was not forwarded",
            },
        ) from exc
    return receipt


def _resolve_refs(schema: dict[str, Any], defs: dict[str, Any] | None = None) -> dict[str, Any]:
    """Resolve $ref references in a JSON schema by inlining $defs.

    This fixes OpenAPI schema generation where Pydantic v2 uses $defs
    but FastAPI needs them resolved inline.

    Args:
        schema: JSON Schema dictionary (may contain $ref)
        defs: Definitions dictionary (from $defs key)

    Returns:
        Schema with all $ref references resolved inline
    """
    if defs is None:
        defs = schema.get("$defs", {})

    result = {}

    for key, value in schema.items():
        if key == "$defs":
            # Skip $defs - we'll inline them instead
            continue
        elif key == "$ref":
            # Resolve reference
            ref_path = value
            if ref_path.startswith("#/$defs/"):
                def_name = ref_path.replace("#/$defs/", "")
                if def_name in defs:
                    # Recursively resolve the referenced definition
                    return _resolve_refs(defs[def_name], defs)
                else:
                    log_warning(f"Reference not found: {ref_path}")
                    return {"type": "object"}
            else:
                # External reference - keep as is
                result[key] = value
        elif isinstance(value, dict):
            result[key] = _resolve_refs(value, defs)
        elif isinstance(value, list):
            result[key] = [
                _resolve_refs(item, defs) if isinstance(item, dict) else item for item in value
            ]
        else:
            result[key] = value

    return result


def _strip_additional_properties(schema: dict[str, Any] | None) -> dict[str, Any] | None:
    """Recursively strip additionalProperties from a JSON schema.

    This prevents Swagger UI from showing 'additionalProp1' example fields
    for dict-typed fields in Pydantic models.

    Args:
        schema: JSON Schema dictionary

    Returns:
        Cleaned schema without additionalProperties
    """
    if schema is None:
        return None

    # First resolve $ref references
    schema = _resolve_refs(schema)

    # Create a copy to avoid modifying the original
    result = {}

    for key, value in schema.items():
        # Skip additionalProperties at any level
        if key == "additionalProperties":
            continue

        # Recursively process nested objects
        if isinstance(value, dict):
            result[key] = _strip_additional_properties(value)
        elif isinstance(value, list):
            result[key] = [
                _strip_additional_properties(item) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            result[key] = value

    return result


def _python_type_from_json_schema(
    prop_schema: dict[str, Any],
    defs: dict[str, Any] | None = None,
) -> Any:
    """Convert a JSON Schema property definition to a Python type annotation.

    Handles ``type``, ``anyOf`` (Pydantic v2 ``Optional``), ``$ref``,
    nested objects, and typed arrays.

    Args:
        prop_schema: Single property schema dict.
        defs: Top-level ``$defs`` for resolving ``$ref``.

    Returns:
        A Python type suitable for ``create_model()``.
    """
    if defs is None:
        defs = {}

    # ── $ref → inline and recurse ────────────────────────────────────
    if "$ref" in prop_schema:
        ref_path = prop_schema["$ref"]
        if ref_path.startswith("#/$defs/"):
            def_name = ref_path.replace("#/$defs/", "")
            if def_name in defs:
                return _python_type_from_json_schema(defs[def_name], defs)
        return Any

    # ── anyOf / oneOf (Pydantic v2 unions & Optional) ────────────────
    any_of = prop_schema.get("anyOf") or prop_schema.get("oneOf")
    if any_of:
        non_null = [s for s in any_of if s.get("type") != "null"]
        has_null = len(non_null) < len(any_of)

        if len(non_null) == 1:
            inner = _python_type_from_json_schema(non_null[0], defs)
            return inner | None if has_null else inner  # type: ignore[return-value]
        elif len(non_null) > 1:
            # Multi-type union — simplify to Any
            return Any
        else:
            return type(None)

    # ── Scalar type ──────────────────────────────────────────────────
    json_type = prop_schema.get("type")
    enum_values = prop_schema.get("enum")

    if json_type == "array":
        items_schema = prop_schema.get("items", {})
        item_type = _python_type_from_json_schema(items_schema, defs)
        return list[item_type]  # type: ignore[valid-type]

    if json_type == "object":
        # Nested object with known properties → dict (could refine later)
        return dict

    # ── enum → Literal (preserves enum values from WithJsonSchema) ───
    if enum_values and json_type == "string":
        return Literal.__getitem__(tuple(enum_values))  # type: ignore[valid-type]

    simple_map: dict[str, type] = {
        "string": str,
        "integer": int,
        "number": float,
        "boolean": bool,
        "null": type(None),
    }
    return simple_map.get(json_type, Any) if json_type else Any  # type: ignore[return-value]


def _create_model_from_schema(
    name: str,
    schema: dict[str, Any] | None,
) -> type[BaseModel]:
    """Create a Pydantic model from a JSON Schema.

    Properly handles Pydantic v2 schemas including ``anyOf`` unions,
    typed arrays (``items``), ``$ref`` / ``$defs``, and default values.

    Args:
        name: Model name
        schema: JSON Schema dictionary

    Returns:
        Pydantic model class
    """
    if schema is None:
        return create_model(name, __base__=DynamicModelBase)

    # Resolve top-level $defs for reference lookup
    defs = schema.get("$defs", {})
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))

    field_definitions: dict[str, Any] = {}

    for prop_name, prop_schema in properties.items():
        python_type = _python_type_from_json_schema(prop_schema, defs)

        # Determine default value
        has_default = "default" in prop_schema
        default_value = prop_schema.get("default")

        if prop_name in required and not has_default:
            field_definitions[prop_name] = (python_type, ...)
        elif has_default:
            field_definitions[prop_name] = (python_type, default_value)
        else:
            # Optional field with no explicit default → None
            field_definitions[prop_name] = (python_type | None, None)  # type: ignore[assignment]

    model = create_model(name, __base__=DynamicModelBase, **field_definitions)

    if "description" in schema:
        model.__doc__ = schema["description"]

    return model


class RouteGenerator:
    """Generates FastAPI routes from the contract registry.

    Uses lazy generation strategy:
    - Routes are generated when registry changes
    - Regenerates when services announce/depart
    - Tracks which routes belong to which service for cleanup
    """

    def __init__(
        self,
        bus: MessageBus,
        registry: RegistryAggregator,
        request_timeout: float = 30.0,
        admin_action_manager: AdminActionManager | None = None,
    ):
        """Initialize the route generator.

        Args:
            bus: Message bus instance
            registry: Registry aggregator instance
            request_timeout: Timeout for bus requests (seconds)
        """
        self._bus = bus
        self._registry = registry
        self._request_timeout = request_timeout
        self._admin_action_manager = admin_action_manager or AdminActionManager()

        # Track generated routes per service
        self._service_routes: dict[str, list[str]] = {}

        # The router that will be mounted
        self._router: APIRouter | None = None

        # Route handlers (path -> handler function)
        self._handlers: dict[str, Callable] = {}

        # Lock for thread-safe route updates
        self._lock = asyncio.Lock()

        # Flag to track if initial generation has happened
        self._initialized = False

    def set_router(self, router: APIRouter) -> None:
        """Set the FastAPI router to add routes to.

        Args:
            router: FastAPI APIRouter instance
        """
        self._router = router

    def set_bus(self, bus: MessageBus) -> None:
        """Replace the bus used by existing and future generated handlers."""
        self._bus = bus

    async def start(self) -> None:
        """Start the route generator.

        Subscribes to registry changes and performs initial route generation.
        """
        # Subscribe to registry changes
        self._registry.on_registry_change(self._on_registry_change)

        # Initial route generation
        await self._regenerate_routes()
        self._initialized = True

        log_info("RouteGenerator started")

    async def stop(self) -> None:
        """Stop the route generator."""
        log_info("RouteGenerator stopped")

    async def _on_registry_change(self) -> None:
        """Handle registry changes by regenerating routes."""
        if self._initialized:
            await self._regenerate_routes()

    async def _regenerate_routes(self) -> None:
        """Regenerate all routes from the registry."""
        if self._router is None:
            log_warning("Router not set, cannot generate routes")
            return

        try:
            async with self._lock:
                # Get all external methods
                external_methods = await self._registry.get_external_methods()

                # Track new routes
                new_routes: dict[str, list[str]] = {}
                current_paths = set()

                for module_name, method_info in external_methods:
                    path = self._generate_path(module_name, method_info)
                    current_paths.add(path)

                    # Track by service
                    if module_name not in new_routes:
                        new_routes[module_name] = []
                    new_routes[module_name].append(path)

                    # Create handler if not exists
                    if path not in self._handlers:
                        handler = self._create_handler(module_name, method_info)
                        self._handlers[path] = handler
                        self._add_route_to_router(path, handler, method_info, module_name)
                        log_debug(f"Added route: POST {path}")

                # Remove routes for departed services
                for old_path in list(self._handlers.keys()):
                    if old_path not in current_paths:
                        # Note: FastAPI doesn't support removing routes dynamically
                        # We keep the handler but it will return 503 if service unavailable
                        log_debug(f"Route orphaned (service departed): {old_path}")

                self._service_routes = new_routes

                log_info(
                    f"Routes regenerated: {len(self._handlers)} routes for "
                    f"{len(new_routes)} services"
                )

        except Exception as e:
            log_error(f"Error regenerating routes: {e}", exc_info=True)

    def _generate_path(self, module_name: str, method_info: MethodInfo) -> str:
        """Generate the API path for a method.

        Args:
            module_name: Name of the service module
            method_info: Method information

        Returns:
            API path (e.g., "/api/TTS/Request")
        """
        method_name = method_info.name
        return f"/api/{module_name}/{method_name}"

    def _create_handler(self, module_name: str, method_info: MethodInfo) -> Callable:
        """Create a route handler for a method.

        Args:
            module_name: Name of the service module
            method_info: Method information

        Returns:
            Async handler function
        """
        registry = self._registry
        timeout = self._request_timeout
        topic = method_info.bus_topic or f"{module_name}.{method_info.name}"

        async def handler(
            request: Any = None,
            principal_id: str | None = None,
            effective_perms: list[str] | None = None,
            identity_source: str | None = None,
        ) -> dict[str, Any]:
            """Handle API request by forwarding to service via bus."""
            from fastapi import HTTPException

            # Check if service is available
            if not registry.is_service_available(module_name):
                raise HTTPException(
                    status_code=503,
                    detail=f"Service '{module_name}' is not available",
                    headers={"Retry-After": "5"},
                )

            try:
                # Determine request body
                request_body = None
                if request is not None:
                    if hasattr(request, "model_dump"):
                        # Use exclude_unset to only include explicitly set fields
                        request_body = request.model_dump(exclude_unset=True)
                    elif isinstance(request, dict):
                        request_body = request
                    elif hasattr(request, "body"):
                        # FastAPI Request object
                        try:
                            request_body = await request.json()
                        except Exception:
                            request_body = {}
                    else:
                        request_body = request

                # Send the request body directly to the bus as a dict
                # The service will validate it against its own input model
                payload = request_body if request_body else {}
                remote_data_reason = remote_data_movement_denial_reason(
                    topic, payload, effective_perms
                )
                if remote_data_reason:
                    raise HTTPException(status_code=403, detail=remote_data_reason)
                payload = await _apply_orchestrator_dispatch_default(topic, payload)
                request_timeout = _request_timeout_for(topic, payload, timeout)

                # Make the bus request
                log_debug(
                    f"Gateway forwarding to {topic} with payload: "
                    f"{redacted_copy(payload, method_id=topic)}"
                )
                result = await self._bus.request(
                    topic,
                    payload,
                    timeout=request_timeout,
                    origin="external",
                    principal_id=principal_id,
                    effective_perms=effective_perms,
                    identity_source=identity_source or "gateway_http",
                    method_type=method_info.method_type or "use",
                    correlation_id=payload.get("correlation_id")
                    if isinstance(payload, dict)
                    else None,
                )
                log_debug(
                    "Gateway received result: "
                    f"ok={result.ok}, data={redacted_copy(result.data, method_id=topic)}"
                )

                if result.ok:
                    if isinstance(payload, Mapping) and runtime_dispatch_selector_present(
                        topic, payload
                    ):
                        try:
                            await _persist_dispatched_assistant_turn(
                                self._bus,
                                payload=payload,
                                response_data=result.data,
                                principal_id=principal_id,
                            )
                        except Exception as exc:
                            # The remote answer already completed successfully. Persistence
                            # failures must be visible in logs without discarding that answer.
                            log_error(
                                "Could not persist remotely dispatched assistant turn "
                                f"on the origin device: {exc}",
                                exc_info=True,
                            )
                    # Return the data
                    if result.data is None:
                        response = {"success": True}
                    elif hasattr(result.data, "model_dump"):
                        response = result.data.model_dump()
                    elif isinstance(result.data, dict):
                        response = result.data if result.data else {"success": True}
                    else:
                        response = {"data": result.data}
                    log_debug(
                        f"Gateway returning response: {redacted_copy(response, method_id=topic)}"
                    )
                    return response
                else:
                    # Service returned an error
                    status_code = _service_error_status_code(result.error)
                    if status_code < 500:
                        log_warning(f"Service request denied: {result.error}")
                    else:
                        log_error(f"Service error: {result.error}")
                    raise HTTPException(
                        status_code=status_code,
                        detail=result.error or "Service request failed",
                    )

            except HTTPException:
                raise
            except TimeoutError as e:
                raise HTTPException(
                    status_code=504,
                    detail=f"Service '{module_name}' request timed out",
                ) from e
            except Exception as e:
                log_error(f"Error handling request to {topic}: {e}")
                raise HTTPException(
                    status_code=500,
                    detail=str(e),
                ) from e

        # Set function metadata for OpenAPI docs
        handler.__name__ = f"{module_name}_{method_info.name}"
        handler.__doc__ = method_info.summary or f"Invoke {module_name}.{method_info.name}"

        return handler

    def _add_route_to_router(
        self,
        path: str,
        handler: Callable,
        method_info: MethodInfo,
        module_name: str,
    ) -> None:
        """Add a route to the FastAPI router.

        Args:
            path: API path
            handler: Handler function
            method_info: Method information for OpenAPI docs
            module_name: Name of the service module
        """
        if self._router is None:
            return

        # Create request model from schema for input validation
        request_model_name = f"{module_name}_{method_info.name}_Request"

        method_id = method_info.bus_topic or f"{module_name}.{method_info.name}"
        request_model_cls = (
            RouteExplainRequest
            if method_id == GatewayMethods.EXPLAIN_ROUTE
            else _create_model_from_schema(
                request_model_name,
                method_info.input_schema,
            )
        )

        # Rebuild model to ensure it's fully defined
        request_model_cls.model_rebuild()
        admin_action_manager = self._admin_action_manager

        # Create handler factory to properly capture the model types
        def create_typed_handler(
            inner_handler: Callable,
            req_model: type[BaseModel],
            scopes: list[str],
            method_type: str = "use",
        ) -> Callable:
            from fastapi import Request, Security

            from app.services.gateway.auth import create_scoped_auth_check

            # Create a scoped auth check that knows this method's type
            auth_check = create_scoped_auth_check(method_type=method_type)

            # Use closure default value to bind scopes
            # FastAPI requires Security() in defaults for dependency injection
            def auth_dependency(
                _auth: Any = Security(auth_check, scopes=scopes),  # noqa: B008
            ) -> Any:
                return _auth

            async def dispatch_validated_body(
                http_request: Request,
                request_body: req_model,
                _auth: Any,
            ) -> dict[str, Any]:
                from fastapi.responses import JSONResponse

                # Extract principal_id from the resolved Identity
                pid = getattr(_auth, "principal_id", None) if _auth else None
                effective_perms = list(getattr(_auth, "effective_perms", []) or []) if _auth else []
                identity_source = getattr(_auth, "source", None) if _auth else None

                # Use exclude_unset=True to only send fields that were explicitly
                # provided, allowing the service's model to use its own defaults
                payload = request_body.model_dump(exclude_unset=True) if request_body else {}
                admin_action_receipt = None
                if _admin_action_required(method_id, method_info.method_type):
                    admin_action_receipt = await _enforce_admin_action(
                        self._bus,
                        admin_action_manager,
                        topic=method_id,
                        principal_id=pid,
                        payload=payload,
                        headers=http_request.headers,
                    )

                result = await inner_handler(
                    payload,
                    principal_id=pid,
                    effective_perms=effective_perms,
                    identity_source=(
                        "gateway_admin_action" if admin_action_receipt else identity_source
                    ),
                )
                # Return the raw result dict - don't filter through response model
                # This preserves all fields from the service response
                if result is None:
                    response_data = {"success": True}
                elif isinstance(result, dict):
                    response_data = result if result else {"success": True}
                elif hasattr(result, "model_dump"):
                    response_data = result.model_dump()
                else:
                    response_data = {"data": result}

                log_debug(
                    f"typed_handler returning: {redacted_copy(response_data, method_id=method_id)}"
                )
                # Return JSONResponse to ensure proper serialization
                headers = {}
                if admin_action_receipt:
                    headers["X-Aurora-AdminAction-Audit-Receipt"] = (
                        admin_action_receipt.audit_receipt
                    )
                return JSONResponse(content=response_data, headers=headers)

            if method_id == GatewayMethods.EXPLAIN_ROUTE:

                async def typed_handler(
                    http_request: Request,
                    _auth: Any = Security(auth_dependency),  # noqa: B008
                ) -> dict[str, Any]:
                    from fastapi import HTTPException

                    try:
                        raw_body = await http_request.json()
                    except Exception:
                        raw_body = None
                    if not isinstance(raw_body, dict):
                        raise HTTPException(
                            status_code=422,
                            detail="Invalid route explanation request.",
                        )
                    try:
                        request_body = RouteExplainRequest.model_validate(raw_body)
                    except ValidationError as exc:
                        log_warning(
                            "Invalid ExplainRoute request body rejected before dispatch: "
                            f"{exc.error_count()} validation error(s)"
                        )
                        raise HTTPException(
                            status_code=422,
                            detail="Invalid route explanation request.",
                        ) from None
                    return await dispatch_validated_body(http_request, request_body, _auth)

            else:

                async def typed_handler(
                    http_request: Request,
                    request_body: req_model,
                    _auth: Any = Security(auth_dependency),  # noqa: B008
                ) -> dict[str, Any]:  # type: ignore[valid-type]
                    return await dispatch_validated_body(http_request, request_body, _auth)

            # Explicitly set annotations to actual model classes (not strings)
            typed_handler.__annotations__ = {
                "http_request": Request,
                "return": dict[str, Any],
            }
            if method_id != GatewayMethods.EXPLAIN_ROUTE:
                typed_handler.__annotations__["request_body"] = req_model
            return typed_handler

        scopes = list(method_info.required_perms) if method_info.required_perms else []

        wrapped_handler = create_typed_handler(
            handler,
            request_model_cls,
            scopes,
            method_type=method_info.method_type or "use",
        )

        # Copy metadata to wrapper
        wrapped_handler.__name__ = handler.__name__
        wrapped_handler.__doc__ = handler.__doc__

        # Build human-readable description for Swagger UI
        description_parts: list[str] = []

        # Lead with the contract summary if available
        if method_info.summary:
            description_parts.append(f"{method_info.summary}\n")

        # Method type badge — tells users what access level is needed
        module_prefix = method_id.split(".")[0] if "." in method_id else module_name
        if method_info.method_type == "manage":
            description_parts.append(
                f"\n🔧 **Type**: `manage` — requires `{module_prefix}.manage` or higher\n"
            )
        else:
            description_parts.append(
                f"\n📡 **Type**: `use` — requires `{module_prefix}.use` or higher\n"
            )

        # Technical details in a smaller section
        bus_topic_for_description = method_info.bus_topic or method_id
        detail_lines = [f"**Bus topic**: `{bus_topic_for_description}`"]
        if method_info.input_model:
            detail_lines.append(f"**Input**: `{method_info.input_model}`")
        if method_info.output_model:
            detail_lines.append(f"**Output**: `{method_info.output_model}`")
        description_parts.append("\n---\n" + " · ".join(detail_lines))

        # Build OpenAPI response schema from the output schema
        # Strip additionalProperties to avoid "additionalProp1" in Swagger UI
        response_schema = _strip_additional_properties(method_info.output_schema) or {
            "type": "object"
        }
        responses = {
            200: {
                "description": "Successful response",
                "content": {
                    "application/json": {
                        "schema": response_schema,
                    }
                },
            }
        }

        # Build OpenAPI request body schema from input schema
        # Strip additionalProperties to avoid "additionalProp1" in Swagger UI
        request_body_schema = None
        if method_info.input_schema:
            cleaned_input_schema = _strip_additional_properties(method_info.input_schema)
            request_body_schema = {
                "content": {
                    "application/json": {
                        "schema": cleaned_input_schema,
                    }
                }
            }

        # Add POST route
        # Note: We don't use response_model to avoid filtering - instead we
        # use 'responses' for OpenAPI schema and return raw dicts.
        self._router.add_api_route(
            path,
            wrapped_handler,
            methods=["POST"],
            summary=method_info.summary or f"{method_info.name}",
            description="".join(description_parts),
            tags=[module_name],
            responses=responses,
            openapi_extra={"requestBody": request_body_schema} if request_body_schema else None,
        )

    def get_route_count(self) -> int:
        """Get the number of generated routes.

        Returns:
            Number of routes
        """
        return len(self._handlers)

    def get_routes_by_service(self) -> dict[str, list[str]]:
        """Get routes grouped by service.

        Returns:
            Dictionary mapping service names to their routes
        """
        return dict(self._service_routes)
