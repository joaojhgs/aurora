"""Dynamic Route Generator for FastAPI.

This module generates FastAPI routes dynamically from the contract registry.
Uses lazy generation - routes are created when registry changes, not at startup.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, create_model

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.shared.contracts.models.gateway import MethodInfo

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
        bus = self._bus
        registry = self._registry
        timeout = self._request_timeout
        topic = method_info.bus_topic or f"{module_name}.{method_info.name}"

        async def handler(request: Any = None, principal_id: str | None = None) -> dict[str, Any]:
            """Handle API request by forwarding to service via bus."""
            from fastapi import HTTPException, Request
            from pydantic import BaseModel

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

                # Make the bus request
                log_debug(f"Gateway forwarding to {topic} with payload: {payload}")
                result = await bus.request(
                    topic,
                    payload,
                    timeout=timeout,
                    origin="external",
                    principal_id=principal_id,
                )
                log_debug(f"Gateway received result: ok={result.ok}, data={result.data}")

                if result.ok:
                    # Return the data
                    if result.data is None:
                        response = {"success": True}
                    elif hasattr(result.data, "model_dump"):
                        response = result.data.model_dump()
                    elif isinstance(result.data, dict):
                        response = result.data if result.data else {"success": True}
                    else:
                        response = {"data": result.data}
                    log_debug(f"Gateway returning response: {response}")
                    return response
                else:
                    # Service returned an error
                    log_error(f"Service error: {result.error}")
                    raise HTTPException(
                        status_code=500,
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

        request_model_cls = _create_model_from_schema(
            request_model_name,
            method_info.input_schema,
        )

        # Rebuild model to ensure it's fully defined
        request_model_cls.model_rebuild()

        # Create handler factory to properly capture the model types
        def create_typed_handler(
            inner_handler: Callable,
            req_model: type[BaseModel],
            scopes: list[str],
            method_type: str = "use",
        ) -> Callable:
            from fastapi import Security

            from app.services.gateway.auth import create_scoped_auth_check

            # Create a scoped auth check that knows this method's type
            auth_check = create_scoped_auth_check(method_type=method_type)

            # Use closure default value to bind scopes
            # FastAPI requires Security() in defaults for dependency injection
            def auth_dependency(
                _auth: Any = Security(auth_check, scopes=scopes),  # noqa: B008
            ) -> Any:
                return _auth

            async def typed_handler(
                request_body: req_model,
                _auth: Any = Security(auth_dependency),  # noqa: B008
            ) -> dict[str, Any]:  # type: ignore[valid-type]
                from fastapi.responses import JSONResponse

                # Extract principal_id from the resolved Identity
                pid = getattr(_auth, "principal_id", None) if _auth else None

                # Use exclude_unset=True to only send fields that were explicitly
                # provided, allowing the service's model to use its own defaults
                result = await inner_handler(
                    request_body.model_dump(exclude_unset=True) if request_body else {},
                    principal_id=pid,
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

                log_debug(f"typed_handler returning: {response_data}")
                # Return JSONResponse to ensure proper serialization
                return JSONResponse(content=response_data)

            # Explicitly set annotations to actual model classes (not strings)
            typed_handler.__annotations__ = {
                "request_body": req_model,
                "return": dict[str, Any],
            }
            return typed_handler

        method_id = method_info.bus_topic or f"{module_name}.{method_info.name}"
        scopes = list(method_info.required_perms) if method_info.required_perms else [method_id]

        wrapped_handler = create_typed_handler(
            handler,
            request_model_cls,
            scopes,
            method_type=method_info.method_type,
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
        detail_lines = [f"**Bus topic**: `{method_info.bus_topic}`"]
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
