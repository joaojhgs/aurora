"""Module Contract Registry for declaring and discovering service capabilities.

This provides a thin contract layer for:
- Declaring message schemas and service methods
- Enforcing exposure and ACL for connectivity layers
- Service discovery and capability introspection
"""

from __future__ import annotations

from typing import Any, Callable

from pydantic import BaseModel


class IOModel(BaseModel):
    """Base class for input/output models in method contracts."""

    pass


class MethodContract(BaseModel):
    """Contract specification for a service method.

    Attributes:
        module: Module name (e.g., "TTS", "STT", "Orchestrator")
        module_version: Module version string
        name: Method name (e.g., "play", "transcribe")
        summary: Human-readable description
        bus_topic: Bus topic for this method (e.g., "TTS.Request")
        default_priority: Default message priority
        allow_origins: Allowed message origins
        required_perms: Required permissions to invoke
        input_model: Pydantic model for input validation
        output_model: Pydantic model for output (optional)
        exposure: Visibility level ("internal" | "external" | "both")
    """

    module: str
    module_version: str
    name: str
    summary: str = ""
    bus_topic: str | None = None
    default_priority: int = 50
    allow_origins: list[str] = ["internal"]
    required_perms: list[str] = []
    input_model: type[IOModel]
    output_model: type[IOModel] | None = None
    exposure: str = "internal"

    class Config:
        arbitrary_types_allowed = True


# Global registry
_registry: dict[str, MethodContract] = {}
_impls: dict[str, Callable[..., Any]] = {}


def method_contract(**kwargs):
    """Decorator to register a method contract.

    Usage:
        @method_contract(
            module="TTS",
            module_version="1.0.0",
            name="play",
            summary="Play text-to-speech audio",
            bus_topic="TTS.Request",
            default_priority=10,
            allow_origins=["internal", "external"],
            input_model=TTSRequest,
            output_model=TTSResponse,
            exposure="both"
        )
        async def play_tts(request: TTSRequest) -> TTSResponse:
            ...

    Args:
        **kwargs: MethodContract fields

    Returns:
        Decorator function
    """

    def decorator(fn: Callable[..., Any]):
        mc = MethodContract(**kwargs)
        _registry[mc.name] = mc
        _impls[mc.name] = fn
        return fn

    return decorator


def get_contract(name: str) -> MethodContract | None:
    """Get a contract by method name.

    Args:
        name: Method name

    Returns:
        MethodContract if found, None otherwise
    """
    return _registry.get(name)


def all_contracts() -> dict[str, MethodContract]:
    """Get all registered contracts.

    Returns:
        Dictionary mapping method names to contracts
    """
    return dict(_registry)


def get_implementation(name: str) -> Callable[..., Any] | None:
    """Get the implementation function for a method.

    Args:
        name: Method name

    Returns:
        Implementation function if found, None otherwise
    """
    return _impls.get(name)


def clear_registry() -> None:
    """Clear all registered contracts (useful for testing)."""
    _registry.clear()
    _impls.clear()
