"""Tooling Service for Aurora's parallel architecture.

This service:
- Manages all tools (core, plugin, MCP)
- Handles tool initialization and lifecycle
- Exposes tool queries via message bus
- Emits events when tools change
"""

from __future__ import annotations

import re
from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import MessageBus
from app.messaging.priority_helpers import get_interactive_priority, get_system_priority
from app.services.tooling.tools_manager import ToolsManager, set_tools_manager
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.tooling import (
    ToolingExecuteToolRequest,
    ToolingExecuteToolResponse,
    ToolingGetMCPStatusRequest,
    ToolingGetMCPStatusResponse,
    ToolingGetStatsRequest,
    ToolingGetStatsResponse,
    ToolingGetToolByNameRequest,
    ToolingGetToolByNameResponse,
    ToolingGetToolsRequest,
    ToolingGetToolsResponse,
    ToolingMethods,
    ToolingModule,
    ToolingReloadMCPRequest,
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
    def _provider_context(
        cls, request: ToolingDiscoveryRequest
    ) -> tuple[str, str, str, str]:
        """Return provider peer, service instance, source type, and namespace."""

        selector = request.mesh_selector
        if selector and (
            selector.peer_id or selector.provider_id or selector.service_instance_id
        ):
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
                    serialized_tools.append(self._serialize_tool(tool, request))

                except Exception as tool_error:
                    log_warning(f"Failed to serialize tool {tool.name}: {tool_error}")
                    continue

            # Return response
            return ToolingGetToolsResponse(tools=serialized_tools, count=len(serialized_tools))

        except Exception as e:
            log_error(f"Error handling get tools query: {e}", exc_info=True)
            return ToolingGetToolsResponse(tools=[], count=0)

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
    )
    async def _on_execute_tool(
        self, request: ToolingExecuteToolRequest
    ) -> ToolingExecuteToolResponse:
        """Handle execute tool command.

        Args:
            request: Request containing tool name and arguments
        """
        try:
            log_debug(f"Executing tool: {request.tool_name} with args: {request.arguments}")

            # Get the tool
            local_tool_name = self._resolve_tool_name(request)
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

                return ToolingExecuteToolResponse(ok=False, error=error_msg, data=None)

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
                log_debug(f"Tool {local_tool_name} executed successfully: {result}")

                # Return response
                return ToolingExecuteToolResponse(ok=True, data=result, error=None)

            except Exception as tool_error:
                error_msg = f"Tool execution failed: {str(tool_error)}"
                log_error(error_msg, exc_info=True)
                return ToolingExecuteToolResponse(ok=False, error=error_msg, data=None)

        except Exception as e:
            log_error(f"Error handling execute tool command: {e}", exc_info=True)
            return ToolingExecuteToolResponse(ok=False, error=str(e), data=None)
