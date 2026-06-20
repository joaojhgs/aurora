from __future__ import annotations

from typing import Any

from pydantic import Field

from app.shared.contracts.registry import IOModel


# Module identifier
class OrchestratorModule:
    """Module identifier for Orchestrator service."""

    NAME = "Orchestrator"


# Method identifiers
class OrchestratorMethods:
    """Full method identifiers for Orchestrator service."""

    USER_INPUT = f"{OrchestratorModule.NAME}.UserInput"
    EXTERNAL_USER_INPUT = f"{OrchestratorModule.NAME}.ExternalUserInput"
    TOOL_RESULT = f"{OrchestratorModule.NAME}.ToolResult"
    RESPONSE = f"{OrchestratorModule.NAME}.Response"
    GET_MODEL_RUNTIME = f"{OrchestratorModule.NAME}.GetModelRuntime"
    GET_MODEL_CATALOG = f"{OrchestratorModule.NAME}.GetModelCatalog"
    GET_MODEL_OPERATION = f"{OrchestratorModule.NAME}.GetModelOperation"
    IMPORT_MODEL = f"{OrchestratorModule.NAME}.ImportModel"
    DOWNLOAD_MODEL = f"{OrchestratorModule.NAME}.DownloadModel"
    BENCHMARK_MODEL = f"{OrchestratorModule.NAME}.BenchmarkModel"
    HEALTH_CHECK = f"{OrchestratorModule.NAME}.HealthCheck"


class OrchestratorProcessRequest(IOModel):
    """Request to process user input."""

    text: str
    source: str = "external"
    session_id: str | None = None


class OrchestratorResponse(IOModel):
    """Response from orchestrator."""

    text: str
    session_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class OrchestratorToolResultRequest(IOModel):
    """Request to process a tool result."""

    request_id: str
    result: Any
    error: str | None = None


class ModelRuntimeFileInfo(IOModel):
    """Redacted model file metadata for a provider."""

    kind: str
    display_name: str
    exists: bool | None = None
    size_bytes: int | None = None
    path_redacted: bool = True


class ModelRuntimeBenchmarkInfo(IOModel):
    """Last-known or planned benchmark state for a provider/model."""

    status: str = "unavailable"
    tokens_per_second: float | None = None
    latency_ms: float | None = None
    measured_at: str | None = None
    reason: str | None = None


class ModelRuntimeProgressInfo(IOModel):
    """Progress state for model import/download/benchmark operations."""

    operation_id: str | None = None
    operation_type: str
    status: str = "not_started"
    progress_percent: float = 0.0
    message: str = ""
    updated_at: str | None = None


class ModelRuntimeProviderInfo(IOModel):
    """One model provider/runtime candidate known to the backend."""

    provider_id: str
    display_name: str
    backend_kind: str
    provider_type: str
    enabled: bool = True
    selected: bool = False
    health: str = "unknown"
    health_reason: str | None = None
    model_id: str | None = None
    source: str | None = None
    license: str | None = None
    context_window: int | None = None
    generation_limit: int | None = None
    hardware: dict[str, Any] = Field(default_factory=dict)
    model_files: list[ModelRuntimeFileInfo] = Field(default_factory=list)
    capabilities: list[str] = Field(default_factory=list)
    benchmark: ModelRuntimeBenchmarkInfo = Field(default_factory=ModelRuntimeBenchmarkInfo)
    import_progress: ModelRuntimeProgressInfo = Field(
        default_factory=lambda: ModelRuntimeProgressInfo(operation_type="import")
    )
    download_progress: ModelRuntimeProgressInfo = Field(
        default_factory=lambda: ModelRuntimeProgressInfo(operation_type="download")
    )
    secrets_redacted: bool = True


class ModelRuntimeRequest(IOModel):
    """Request model runtime/provider state."""

    provider_id: str | None = None
    include_unavailable: bool = True


class ModelRuntimeCatalogRequest(IOModel):
    """Request the model provider catalog."""

    include_unavailable: bool = True
    include_operations: bool = True


class ModelRuntimeCatalogResponse(IOModel):
    """Backend-proven model provider catalog."""

    generated_at: str
    selected_provider_id: str | None = None
    providers: list[ModelRuntimeProviderInfo] = Field(default_factory=list)
    provider_index: dict[str, list[str]] = Field(default_factory=dict)
    unavailable: list[str] = Field(default_factory=list)
    internal_only: list[str] = Field(default_factory=list)
    secrets_redacted: bool = True


class ModelRuntimeResponse(IOModel):
    """Selected or requested model runtime state."""

    generated_at: str
    selected_provider_id: str | None = None
    provider: ModelRuntimeProviderInfo | None = None
    providers: list[ModelRuntimeProviderInfo] = Field(default_factory=list)
    secrets_redacted: bool = True


class ModelRuntimeOperationRequest(IOModel):
    """Request an import, download, or benchmark operation."""

    provider_id: str | None = None
    model_id: str | None = None
    source_uri: str | None = None
    target_name: str | None = None
    options: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = True


class ModelRuntimeOperationStatusRequest(IOModel):
    """Lookup a model runtime operation."""

    operation_id: str


class ModelRuntimeOperationResponse(IOModel):
    """Model runtime operation state."""

    operation_id: str
    operation_type: str
    status: str
    provider_id: str | None = None
    model_id: str | None = None
    progress_percent: float = 0.0
    message: str = ""
    reason_code: str | None = None
    started_at: str | None = None
    updated_at: str | None = None
    completed_at: str | None = None
    audit_event: str | None = None
    secrets_redacted: bool = True
