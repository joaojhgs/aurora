"""Module Contract Registry for declaring and discovering service capabilities.

This provides a thin contract layer for:
- Declaring message schemas and service methods
- Enforcing exposure and ACL for connectivity layers
- Service discovery and capability introspection
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Callable
from functools import lru_cache
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# Optional imports for version detection
try:
    from importlib.metadata import version as get_package_version_from_metadata
except ImportError:
    get_package_version_from_metadata = None

try:
    import toml
except ImportError:
    toml = None


class IOModel(BaseModel):
    """Base class for input/output models in method contracts."""

    pass


class CallableFeatureContract(BaseModel):
    """Stable callable feature metadata for mesh-exposed service methods."""

    feature_id: str
    module: str
    label: str = ""
    summary: str = ""
    method_ids: tuple[str, ...] = Field(default_factory=tuple)

    model_config = ConfigDict(frozen=True)


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
        method_type: Access level - "use" (read/invoke) or "manage" (write/admin)
        input_model: Pydantic model for input validation
        output_model: Pydantic model for output (optional)
        exposure: Visibility level ("internal" | "external" | "both")
        always_available: Keep this method subscribed on the bus even while the
            service is lifecycle-disabled by config. Reserved for infrastructure
            sinks (e.g. audit storage) that other services depend on regardless
            of whether this service's feature surface is enabled.
    """

    module: str
    module_version: str
    name: str
    summary: str = ""
    bus_topic: str | None = None
    default_priority: int = 50
    allow_origins: list[str] = ["internal"]
    required_perms: list[str] = []
    callable_feature_ids: list[str] = []
    callable_features: list[CallableFeatureContract] = []
    public_infrastructure: bool = False
    method_type: str = "use"
    input_model: type[BaseModel]
    output_model: type[BaseModel] | None = None
    exposure: str = "internal"
    always_available: bool = False

    class Config:
        arbitrary_types_allowed = True


class ModuleContract(BaseModel):
    """Contract specification for a module (collection of methods).

    Attributes:
        module: Module name (e.g., "TTS", "DB", "Orchestrator")
        version: Semantic version string (e.g., "1.0.0")
        summary: Human-readable description of the module
        capabilities: List of feature flags (e.g., ["streaming", "multilingual"])
        depends_on: Dictionary of required modules with version ranges
        methods: List of method contracts provided by this module
    """

    module: str
    version: str
    summary: str = ""
    capabilities: list[str] = Field(default_factory=list)
    depends_on: dict[str, str] = Field(default_factory=dict)
    methods: list[MethodContract] = Field(default_factory=list)
    callable_features: list[CallableFeatureContract] = Field(default_factory=list)

    class Config:
        arbitrary_types_allowed = True


class RegistryExport(BaseModel):
    """Exportable representation of the registry.

    Attributes:
        modules: List of all registered modules with their methods
        digest: SHA256 hash of the serialized modules for quick equality checks
    """

    modules: list[dict[str, Any]]
    digest: str


# Global registry
_registry: dict[str, MethodContract] = {}
_impls: dict[str, Callable[..., Any]] = {}
_modules: dict[str, ModuleContract] = {}


def register_module(
    module: str,
    version: str | None = None,
    summary: str = "",
    capabilities: list[str] | None = None,
    depends_on: dict[str, str] | None = None,
) -> ModuleContract:
    """Register a module in the global registry.

    Args:
        module: Module name (e.g., "TTS", "STT", "DB")
        version: Module version (defaults to package version from pyproject.toml)
        summary: Brief description of the module
        capabilities: List of capability tags
        depends_on: Dictionary of module dependencies with version ranges

    Returns:
        The registered ModuleContract
    """
    # Auto-detect version from pyproject.toml if not provided
    if version is None:
        version = _get_package_version()

    # Check if module already exists (e.g. created by decorators)
    if module in _modules:
        existing = _modules[module]
        # Update fields but preserve methods
        existing.version = version
        existing.summary = summary
        existing.capabilities = capabilities or []
        existing.depends_on = depends_on or {}
        existing.callable_features = _callable_features_for_module(module)
        return existing

    contract = ModuleContract(
        module=module,
        version=version,
        summary=summary,
        capabilities=capabilities or [],
        depends_on=depends_on or {},
        callable_features=_callable_features_for_module(module),
        methods=[],
    )
    _modules[module] = contract
    return contract


@lru_cache(maxsize=1)
def validate_canonical_taxonomy() -> None:
    """Fail closed unless the canonical callable taxonomy is internally valid."""

    from app.shared.contracts.mesh_surface import validate_taxonomy

    violations = validate_taxonomy()
    if violations:
        raise ValueError(f"Invalid callable feature taxonomy: {'; '.join(violations)}")


def _get_package_version() -> str:
    """Get package version from pyproject.toml or __init__.py.

    Returns:
        Package version string (e.g., "1.0.0")
    """
    try:
        # Try to get version from package metadata (works after installation)
        if get_package_version_from_metadata:
            return get_package_version_from_metadata("aurora")
    except Exception:
        pass

    try:
        # Fallback: Read from pyproject.toml
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
        pyproject_path = os.path.join(project_root, "pyproject.toml")
        if os.path.exists(pyproject_path):
            with open(pyproject_path) as f:
                data = toml.load(f)
                return data.get("project", {}).get("version", "0.0.0")
    except Exception:
        pass

    # Final fallback
    return "0.0.0"


def method_contract(
    method_id: str,
    summary: str = "",
    input_model: type[IOModel] | None = None,
    output_model: type[IOModel] | None = None,
    exposure: str = "internal",
    default_priority: int = 50,
    method_type: str = "use",
    always_available: bool = False,
    callable_feature_ids: list[str] | tuple[str, ...] | None = None,
    public_infrastructure: bool = False,
    **kwargs,
):
    """Register a method contract.

    Args:
        method_id: Full method identifier (e.g., "TTS.Request")
        summary: Brief description of what this method does
        input_model: Pydantic model for input validation
        output_model: Pydantic model for output (optional)
        exposure: "internal", "external", or "both"
        default_priority: Default message priority (0-100)
        method_type: "use" (read/invoke) or "manage" (write/admin)

    Example:
        @method_contract(
            method_id=TTSMethods.REQUEST,
            summary="Process TTS request",
            input_model=TTSRequest,
            output_model=EmptyOutput,
            exposure="both"
        )
        async def _on_tts_request(self, request: TTSRequest) -> EmptyOutput:
            ...
    """

    def decorator(fn: Callable):
        # Store metadata for late binding in BaseService
        fn._contract_metadata = {
            "method_id": method_id,
            "summary": summary,
            "input_model": input_model,
            "output_model": output_model,
            "exposure": exposure,
            "default_priority": default_priority,
            "method_type": method_type,
            "always_available": always_available,
            "callable_feature_ids": list(callable_feature_ids or []),
            "public_infrastructure": public_infrastructure,
            **kwargs,
        }
        return fn

    return decorator


def register_method(
    module_name: str, method_name: str, fn: Callable[..., Any], metadata: dict[str, Any]
) -> None:
    """Register a method contract (called by BaseService).

    Args:
        module_name: Name of the module
        method_name: Name of the method (e.g. "StoreMessage")
        fn: The implementation function
        metadata: Contract metadata from decorator
    """
    # Inject module name
    metadata["module"] = module_name

    # Ensure name is set
    if "name" not in metadata:
        metadata["name"] = method_name

    # Auto-populate module_version
    if "module_version" not in metadata and module_name in _modules:
        metadata["module_version"] = _modules[module_name].version
    elif "module_version" not in metadata:
        metadata["module_version"] = _get_package_version()

    # Ensure bus_topic is always set (used as registry key)
    if "bus_topic" not in metadata or not metadata["bus_topic"]:
        metadata["bus_topic"] = metadata.get("method_id") or f"{module_name}.{method_name}"

    metadata["callable_feature_ids"] = list(metadata.get("callable_feature_ids") or [])
    metadata["callable_features"] = _callable_features_for_method(
        module_name,
        metadata["bus_topic"],
        metadata["callable_feature_ids"],
    )

    # Create and register contract — key by full bus_topic to avoid
    # cross-module collisions (e.g. "DB.CreateToken" vs "Auth.CreateToken").
    mc = MethodContract(**metadata)
    violations = validate_method_contract(mc)
    if violations:
        raise ValueError(
            f"Invalid callable surface contract for {mc.bus_topic}: {'; '.join(violations)}"
        )
    registry_key = mc.bus_topic or f"{mc.module}.{mc.name}"
    _registry[registry_key] = mc
    _impls[registry_key] = fn

    # Add to module
    if module_name in _modules:
        module = _modules[module_name]
        # Check if already exists to avoid duplicates
        if not any(m.name == mc.name for m in module.methods):
            module.methods.append(mc)
    else:
        # Should not happen if register_module called first
        _modules[module_name] = ModuleContract(
            module=module_name,
            version=mc.module_version,
            methods=[mc],
        )


def unregister_method(registry_key: str) -> None:
    """Remove a specific method contract from the registry by its bus topic."""
    if registry_key in _registry:
        mc = _registry.pop(registry_key)
        _impls.pop(registry_key, None)
        # Also remove from module
        if mc.module in _modules:
            module = _modules[mc.module]
            module.methods = [
                m for m in module.methods if (m.bus_topic or f"{m.module}.{m.name}") != registry_key
            ]


def unregister_module(module_name: str) -> None:
    """Remove a module and all its method contracts from the registry."""
    if module_name in _modules:
        module = _modules.pop(module_name)
        for mc in module.methods:
            registry_key = mc.bus_topic or f"{mc.module}.{mc.name}"
            _registry.pop(registry_key, None)
            _impls.pop(registry_key, None)


def get_contract(name: str) -> MethodContract | None:
    """Get a contract by bus topic (e.g. ``"DB.CreateToken"``).

    Args:
        name: Full bus topic ("Module.Method")

    Returns:
        MethodContract if found, None otherwise
    """
    return _registry.get(name)


def all_contracts() -> dict[str, MethodContract]:
    """Get all registered contracts.

    Returns:
        Dictionary mapping bus topics ("Module.Method") to contracts
    """
    return dict(_registry)


def get_implementation(name: str) -> Callable[..., Any] | None:
    """Get the implementation function for a method.

    Args:
        name: Full bus topic ("Module.Method")

    Returns:
        Implementation function if found, None otherwise
    """
    return _impls.get(name)


def list_modules() -> dict[str, ModuleContract]:
    """Get all registered modules.

    Returns:
        Dictionary mapping module names to ModuleContract objects
    """
    return dict(_modules)


def export() -> str:
    """Export the registry as JSON with a digest for quick equality checks.

    Returns:
        JSON string containing modules and a SHA256 digest
    """
    # Serialize modules (exclude type references for JSON compatibility)
    modules_data = []
    for module in _modules.values():
        module_dict = {
            "module": module.module,
            "version": module.version,
            "summary": module.summary,
            "capabilities": module.capabilities,
            "depends_on": module.depends_on,
            "callable_features": [
                feature.model_dump(mode="json") for feature in module.callable_features
            ],
            "methods": [
                {
                    "module": m.module,
                    "module_version": m.module_version,
                    "name": m.name,
                    "summary": m.summary,
                    "bus_topic": m.bus_topic,
                    "default_priority": m.default_priority,
                    "allow_origins": m.allow_origins,
                    "required_perms": m.required_perms,
                    "callable_feature_ids": m.callable_feature_ids,
                    "callable_features": [
                        feature.model_dump(mode="json") for feature in m.callable_features
                    ],
                    "public_infrastructure": m.public_infrastructure,
                    "method_type": m.method_type,
                    "exposure": m.exposure,
                    "input_model": m.input_model.__name__ if m.input_model else None,
                    "output_model": m.output_model.__name__ if m.output_model else None,
                }
                for m in module.methods
            ],
        }
        modules_data.append(module_dict)

    # Create stable JSON for digest calculation
    stable_json = json.dumps(modules_data, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(stable_json.encode()).hexdigest()

    # Create export object
    export_obj = {"modules": modules_data, "digest": digest}

    return json.dumps(export_obj, indent=2)


def import_registry(data: str) -> dict[str, Any]:
    """Import a registry from JSON export.

    Args:
        data: JSON string from export()

    Returns:
        Parsed registry data (modules and digest)
    """
    return json.loads(data)


def clear_registry() -> None:
    """Clear all registered contracts and modules (useful for testing)."""
    _registry.clear()
    _impls.clear()
    _modules.clear()


def _callable_features_for_module(module_name: str) -> list[CallableFeatureContract]:
    validate_canonical_taxonomy()
    from app.shared.contracts.mesh_surface import feature_contracts_for_module

    return list(feature_contracts_for_module(module_name))


def _callable_features_for_method(
    module_name: str,
    bus_topic: str,
    feature_ids: list[str],
) -> list[CallableFeatureContract]:
    validate_canonical_taxonomy()
    if not feature_ids:
        return []
    from app.shared.contracts.mesh_surface import feature_contracts_for_topic

    features = feature_contracts_for_topic(bus_topic)
    feature_by_id = {feature.feature_id: feature for feature in features}
    missing = [feature_id for feature_id in feature_ids if feature_id not in feature_by_id]
    if missing:
        raise ValueError(f"{bus_topic} declares invalid callable feature IDs: {missing}")
    return [feature_by_id[feature_id] for feature_id in feature_ids]


def validate_method_contract(contract: MethodContract) -> list[str]:
    """Return deterministic callable surface violations for one method contract."""

    validate_canonical_taxonomy()
    from app.shared.contracts.mesh_surface import validate_callable_method_surface

    return validate_callable_method_surface(contract)


def method_contract_advertisable(contract: MethodContract) -> bool:
    """Whether a contract may be advertised outside its service process."""

    return not validate_method_contract(contract)
