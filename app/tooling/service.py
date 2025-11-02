"""Tooling Service for Aurora's parallel architecture.

This service:
- Manages all tools (core, plugin, MCP)
- Handles tool initialization and lifecycle
- Exposes tool queries via message bus
- Emits events when tools change
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import Command, Envelope, Event, MessageBus, Query, ToolingTopics
from app.tooling.tools_manager import ToolsManager, set_tools_manager


# Message definitions
class ToolsInitialized(Event):
    """Event emitted when tools are initialized."""

    total_tools: int
    mcp_tools_loaded: bool


class ToolsReloaded(Event):
    """Event emitted when tools are reloaded."""

    total_tools: int


class GetToolsQuery(Query):
    """Query to get available tools."""

    query: str | None = None
    top_k: int = 10


class GetToolsResponse(BaseModel):
    """Response for GetToolsQuery.

    This response will be wrapped in QueryResult by the message bus,
    so it should not have an 'ok' field.
    """

    tools: list[dict[str, Any]] = []
    count: int = 0


class GetToolByNameQuery(Query):
    """Query to get a specific tool by name."""

    name: str


class ReloadMCPToolsCommand(Command):
    """Command to reload MCP tools."""

    pass


class GetToolStatsQuery(Query):
    """Query to get tooling statistics."""

    pass


class ExecuteToolCommand(Command):
    """Command to execute a tool by name."""

    tool_name: str
    arguments: dict[str, Any] = {}


class ExecuteToolResponse(BaseModel):
    """Response for ExecuteToolCommand."""

    ok: bool
    data: Any = None
    error: str | None = None


# Service implementation
class ToolingService:
    """Tooling service.

    Responsibilities:
    - Initialize ToolsManager
    - Load all tools in correct order
    - Handle tool queries via message bus
    - Manage tool lifecycle
    """

    def __init__(self, bus: MessageBus):
        """Initialize tooling service.

        Args:
            bus: MessageBus instance
        """
        self.bus = bus
        self.tools_manager = ToolsManager()
        self._started = False

    async def start(self) -> None:
        """Start the tooling service and initialize tools."""
        if self._started:
            log_warning("ToolingService already started")
            return

        log_info("Starting Tooling service...")

        # Set as global instance
        set_tools_manager(self.tools_manager)

        # Subscribe to commands and queries using typed topics
        self.bus.subscribe(ToolingTopics.GET_TOOLS, self._on_get_tools)
        self.bus.subscribe(ToolingTopics.GET_TOOL_BY_NAME, self._on_get_tool_by_name)
        self.bus.subscribe(ToolingTopics.GET_STATS, self._on_get_stats)
        self.bus.subscribe(ToolingTopics.RELOAD_MCP_TOOLS, self._on_reload_mcp)
        self.bus.subscribe(ToolingTopics.EXECUTE_TOOL, self._on_execute_tool)

        # Initialize tools
        log_info("Initializing tools...")
        await self.tools_manager.initialize()

        # Emit initialization event
        stats = self.tools_manager.get_stats()
        await self.bus.publish(
            ToolingTopics.TOOLS_INITIALIZED,
            ToolsInitialized(total_tools=stats["total_tools"], mcp_tools_loaded=stats["mcp_tools_loaded"]),
            event=True,
            priority=50,
            origin="internal",
        )

        self._started = True
        log_info(f"Tooling service started with {stats['total_tools']} tools")

    async def stop(self) -> None:
        """Stop the tooling service."""
        log_info("Stopping Tooling service...")
        self._started = False
        log_info("Tooling service stopped")

    async def _on_get_tools(self, env: Envelope) -> None:
        """Handle get tools query.

        Serializes tools to send through the bus (name, description, and argument descriptions only).
        The bus remains agnostic - it just transports the serialized data.

        Args:
            env: Message envelope containing GetToolsQuery
        """
        try:
            query = GetToolsQuery.model_validate(env.payload)
            log_debug(f"Getting tools with query: {query.query}")

            tools = self.tools_manager.get_tools(query.query, query.top_k)

            # Serialize tools to send through bus (only name, description, and argument descriptions)
            serialized_tools = []
            for tool in tools:
                try:
                    # Extract tool schema information - only what's needed for LLM binding
                    tool_schema = {
                        "name": tool.name,
                        "description": tool.description or "",
                    }

                    # Get the args schema if available
                    if hasattr(tool, "args_schema") and tool.args_schema:
                        try:
                            # Get the full JSON schema
                            # Some schemas may contain non-serializable types (e.g., BaseStore)
                            # We'll catch the error and filter out problematic fields
                            try:
                                full_schema = tool.args_schema.model_json_schema()
                            except Exception as json_schema_error:
                                # If schema generation fails due to non-serializable types,
                                # try to manually build a schema excluding problematic fields
                                log_debug(f"Direct schema generation failed for {tool.name}, attempting manual extraction: {json_schema_error}")

                                # Try to get schema fields directly and filter out non-serializable ones
                                if hasattr(tool.args_schema, "model_fields"):
                                    filtered_properties = {}
                                    required_fields = []

                                    for field_name, field_info in tool.args_schema.model_fields.items():
                                        # Skip runtime-injected parameters (bus, store, etc.)
                                        if field_name in ["bus", "store"]:
                                            continue

                                        # Skip fields with non-serializable types
                                        field_type = field_info.annotation

                                        # Handle Annotated types (e.g., Annotated[BaseStore, InjectedStore])
                                        if hasattr(field_type, "__origin__") and hasattr(field_type.__origin__, "__name__"):
                                            if field_type.__origin__.__name__ == "Annotated":
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

                                                filtered_properties[field_name] = {"type": type_str, "description": field_info.description or ""}
                                        except Exception:
                                            # Skip fields we can't process
                                            continue

                                    if filtered_properties:
                                        tool_schema["args_schema"] = {
                                            "type": "object",
                                            "properties": filtered_properties,
                                            **({"required": required_fields} if required_fields else {}),
                                        }
                                    else:
                                        tool_schema["args_schema"] = {"type": "object", "properties": {}}
                                else:
                                    # Fallback to empty schema
                                    tool_schema["args_schema"] = {"type": "object", "properties": {}}

                                # Skip the rest of the schema processing
                                serialized_tools.append(tool_schema)
                                continue

                            # Extract only properties and required fields (filter out injected params)
                            if "properties" in full_schema:
                                filtered_properties = {}
                                for prop_name, prop_value in full_schema["properties"].items():
                                    # Skip runtime-injected parameters (bus, store, etc.)
                                    # These are injected at execution time and shouldn't be in the LLM schema
                                    if prop_name not in ["bus", "store"]:
                                        filtered_properties[prop_name] = prop_value

                                # Build minimal args_schema with type, properties, and required fields
                                args_schema = {
                                    "type": "object",
                                    "properties": filtered_properties,
                                }

                                # Include required fields if they exist and filter out injected params
                                if "required" in full_schema:
                                    filtered_required = [r for r in full_schema["required"] if r not in ["bus", "store"]]
                                    if filtered_required:
                                        args_schema["required"] = filtered_required

                                tool_schema["args_schema"] = args_schema
                            else:
                                # No properties - use empty object schema
                                tool_schema["args_schema"] = {"type": "object", "properties": {}}
                        except Exception as schema_error:
                            log_warning(f"Failed to generate JSON schema for {tool.name}: {schema_error}")
                            tool_schema["args_schema"] = {"type": "object", "properties": {}}
                    else:
                        # No arguments schema available - use empty object schema
                        tool_schema["args_schema"] = {"type": "object", "properties": {}}

                    serialized_tools.append(tool_schema)

                except Exception as tool_error:
                    log_warning(f"Failed to serialize tool {tool.name}: {tool_error}")
                    continue

            # Send response
            if env.reply_to:
                response = GetToolsResponse(tools=serialized_tools, count=len(serialized_tools))
                await self.bus.publish(env.reply_to, response, origin="internal", event=False, reliable=False)

        except Exception as e:
            log_error(f"Error handling get tools query: {e}", exc_info=True)
            if env.reply_to:
                from app.messaging.bus import QueryResult

                error_response = QueryResult(ok=False, error=str(e), data=None)
                await self.bus.publish(env.reply_to, error_response, origin="internal", event=False, reliable=False)

    async def _on_get_tool_by_name(self, env: Envelope) -> None:
        """Handle get tool by name query.

        Args:
            env: Message envelope containing GetToolByNameQuery
        """
        try:
            query = GetToolByNameQuery.model_validate(env.payload)
            log_debug(f"Getting tool: {query.name}")

            tool = self.tools_manager.get_tool_by_name(query.name)

            # Send response
            if env.reply_to:
                if tool:
                    response = {"found": True, "name": tool.name, "description": getattr(tool, "description", "")}
                else:
                    response = {"found": False, "name": query.name}
                await self.bus.publish(env.reply_to, response, origin="internal")

        except Exception as e:
            log_error(f"Error handling get tool by name query: {e}", exc_info=True)
            if env.reply_to:
                await self.bus.publish(env.reply_to, {"error": str(e)}, origin="internal")

    async def _on_get_stats(self, env: Envelope) -> None:
        """Handle get stats query.

        Args:
            env: Message envelope containing GetToolStatsQuery
        """
        try:
            stats = self.tools_manager.get_stats()
            log_debug(f"Tool stats: {stats}")

            # Send response
            if env.reply_to:
                await self.bus.publish(env.reply_to, stats, origin="internal")

        except Exception as e:
            log_error(f"Error handling get stats query: {e}", exc_info=True)
            if env.reply_to:
                await self.bus.publish(env.reply_to, {"error": str(e)}, origin="internal")

    async def _on_reload_mcp(self, env: Envelope) -> None:
        """Handle reload MCP tools command.

        Args:
            env: Message envelope containing ReloadMCPToolsCommand
        """
        try:
            log_info("Reloading MCP tools...")
            await self.tools_manager.reload_mcp_tools()

            # Emit reloaded event
            stats = self.tools_manager.get_stats()
            await self.bus.publish("Tooling.Reloaded", ToolsReloaded(total_tools=stats["total_tools"]), event=True, priority=50, origin="internal")

            log_info("MCP tools reloaded successfully")

        except Exception as e:
            log_error(f"Error reloading MCP tools: {e}", exc_info=True)

    async def _on_execute_tool(self, env: Envelope) -> None:
        """Handle execute tool command.

        Args:
            env: Message envelope containing ExecuteToolCommand
        """
        try:
            command = ExecuteToolCommand.model_validate(env.payload)
            log_debug(f"Executing tool: {command.tool_name} with args: {command.arguments}")

            # Get the tool
            tool = self.tools_manager.get_tool_by_name(command.tool_name)
            if not tool:
                # Try to find similar tool names (case-insensitive, partial match)
                all_tool_names = self.tools_manager.get_all_tool_names()
                similar_tools = [
                    name for name in all_tool_names if command.tool_name.lower() in name.lower() or name.lower() in command.tool_name.lower()
                ]

                error_msg = f"Tool not found: '{command.tool_name}'"
                if similar_tools:
                    error_msg += f". Similar tools found: {', '.join(similar_tools)}"
                else:
                    available = all_tool_names[:10]
                    error_msg += f". Available tools ({len(all_tool_names)} total): {', '.join(available)}"
                    if len(all_tool_names) > 10:
                        error_msg += f" ... and {len(all_tool_names) - 10} more"

                log_error(error_msg)
                log_debug(f"Tool lookup contains: {list(self.tools_manager.tool_lookup.keys())}")

                if env.reply_to:
                    response = ExecuteToolResponse(ok=False, error=error_msg, data=None)
                    await self.bus.publish(env.reply_to, response, origin="internal", event=False)
                return

            # Execute the tool
            try:
                # Always inject the bus into tool arguments
                tool_args = command.arguments.copy()
                tool_args["bus"] = self.bus

                # Execute the tool - LangChain will handle argument validation
                # The bus parameter is injected at runtime and not in the schema
                result = await tool.ainvoke(tool_args) if hasattr(tool, "ainvoke") else tool.invoke(tool_args)
                log_debug(f"Tool {command.tool_name} executed successfully: {result}")

                # Send response
                if env.reply_to:
                    response = ExecuteToolResponse(ok=True, data=result, error=None)
                    await self.bus.publish(env.reply_to, response, origin="internal", event=False)

            except Exception as tool_error:
                error_msg = f"Tool execution failed: {str(tool_error)}"
                log_error(error_msg, exc_info=True)
                if env.reply_to:
                    response = ExecuteToolResponse(ok=False, error=error_msg, data=None)
                    await self.bus.publish(env.reply_to, response, origin="internal", event=False)

        except Exception as e:
            log_error(f"Error handling execute tool command: {e}", exc_info=True)
            if env.reply_to:
                response = ExecuteToolResponse(ok=False, error=str(e), data=None)
                await self.bus.publish(env.reply_to, response, origin="internal", event=False)
