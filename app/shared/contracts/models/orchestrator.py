from __future__ import annotations

from typing import Any, Literal

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
    INGEST_CONTEXT = f"{OrchestratorModule.NAME}.IngestContext"
    TOOL_RESULT = f"{OrchestratorModule.NAME}.ToolResult"
    INTERRUPT = f"{OrchestratorModule.NAME}.Interrupt"
    RESPONSE = f"{OrchestratorModule.NAME}.Response"
    GET_MODEL_RUNTIME = f"{OrchestratorModule.NAME}.GetModelRuntime"
    GET_MODEL_CATALOG = f"{OrchestratorModule.NAME}.GetModelCatalog"
    GET_MODEL_OPERATION = f"{OrchestratorModule.NAME}.GetModelOperation"
    IMPORT_MODEL = f"{OrchestratorModule.NAME}.ImportModel"
    DOWNLOAD_MODEL = f"{OrchestratorModule.NAME}.DownloadModel"
    BENCHMARK_MODEL = f"{OrchestratorModule.NAME}.BenchmarkModel"
    HEALTH_CHECK = f"{OrchestratorModule.NAME}.HealthCheck"


class OrchestratorEvents:
    """Broadcast event identifiers for Orchestrator service."""

    INTERRUPTED = f"{OrchestratorModule.NAME}.Interrupted"


OrchestratorInterruptScope = Literal["generation", "tool_call", "tts_playback", "session"]
OrchestratorInterruptStatus = Literal[
    "cancelled",
    "no_active_work",
    "not_supported",
    "failed",
]


class OrchestratorProcessRequest(IOModel):
    """Request to process user input."""

    text: str
    source: str = "external"
    session_id: str | None = None
    request_id: str | None = None
    correlation_id: str | None = None
    stream: bool = False


class OrchestratorResponse(IOModel):
    """Response from orchestrator."""

    text: str
    session_id: str | None = None
    request_id: str | None = None
    correlation_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


AttachmentContextKind = Literal["text", "url", "file", "image"]
AttachmentContextPrivacyClass = Literal[
    "public",
    "personal",
    "sensitive",
    "secret",
    "credential",
    "raw-audio",
]
AttachmentContextSourceChannel = Literal[
    "chat",
    "api",
    "desktop",
    "mobile_share_sheet",
    "deep_link",
    "browser_extension",
]
AttachmentContextStoragePolicy = Literal["ephemeral", "rag", "reject"]
AttachmentContextStatus = Literal[
    "accepted",
    "stored",
    "rejected",
    "redacted",
    "unsupported",
]


class AttachmentContextLimits(IOModel):
    """Client-visible limits for assistant attachment/context ingestion."""

    max_items: int = 8
    max_item_bytes: int = 262_144
    max_total_bytes: int = 1_048_576
    max_text_chars: int = 120_000


class AttachmentContextSource(IOModel):
    """Redacted provenance for context shared into an assistant session."""

    channel: AttachmentContextSourceChannel = "api"
    display_name: str | None = None
    uri: str | None = None
    mime_type: str | None = None
    platform: str | None = None
    originating_app: str | None = None
    shared_at: str | None = None
    principal_id: str | None = None
    device_id: str | None = None
    peer_id: str | None = None


class AttachmentContextItem(IOModel):
    """One text-like attachment or shared context item for assistant ingestion."""

    kind: AttachmentContextKind
    content_text: str | None = None
    url: str | None = None
    title: str | None = None
    filename: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    source: AttachmentContextSource = Field(default_factory=AttachmentContextSource)
    metadata: dict[str, Any] = Field(default_factory=dict)


class AttachmentContextIngestRequest(IOModel):
    """Request to ingest redacted attachment/context metadata for assistant use."""

    items: list[AttachmentContextItem] = Field(default_factory=list)
    session_id: str | None = None
    namespace: str = "assistant.attachments"
    storage_policy: AttachmentContextStoragePolicy = "ephemeral"
    privacy_class: AttachmentContextPrivacyClass = "personal"
    caller_principal_id: str | None = None
    correlation_id: str | None = None
    policy_decision_id: str | None = None
    limits: AttachmentContextLimits = Field(default_factory=AttachmentContextLimits)


class AttachmentContextItemResult(IOModel):
    """Per-item ingestion outcome without echoing raw attachment content."""

    item_id: str
    kind: AttachmentContextKind
    status: AttachmentContextStatus
    storage_policy: AttachmentContextStoragePolicy
    privacy_class: AttachmentContextPrivacyClass
    accepted_bytes: int = 0
    stored_namespace: str | None = None
    stored_key: str | None = None
    redacted: bool = False
    redaction_reasons: list[str] = Field(default_factory=list)
    reason_code: str | None = None
    message: str = ""


class AttachmentContextIngestResponse(IOModel):
    """Summary returned after context ingestion and audit recording."""

    accepted: bool
    rejected: bool
    total_items: int
    accepted_items: list[AttachmentContextItemResult] = Field(default_factory=list)
    rejected_items: list[AttachmentContextItemResult] = Field(default_factory=list)
    total_bytes: int = 0
    storage_policy: AttachmentContextStoragePolicy
    privacy_class: AttachmentContextPrivacyClass
    audit_event: str = "assistant.context.ingested"
    correlation_id: str | None = None
    secrets_redacted: bool = True


class OrchestratorToolResultRequest(IOModel):
    """Request to process a tool result."""

    request_id: str
    result: Any
    error: str | None = None


class OrchestratorInterruptRequest(IOModel):
    """Request to interrupt active assistant work.

    Scopes:
    - ``generation``: cancel in-flight LLM/graph work tracked by Orchestrator.
    - ``tool_call``: cancel active tool execution when a cancellable tool handle exists.
    - ``tts_playback``: stop server-side TTS playback through the TTS service contract.
    - ``session``: cancel all tracked work for a session and stop playback.
    """

    scopes: list[OrchestratorInterruptScope] = Field(
        default_factory=lambda: ["generation", "tool_call", "tts_playback", "session"]
    )
    session_id: str | None = None
    request_id: str | None = None
    reason: str = "user_interrupt"


class OrchestratorInterruptScopeResult(IOModel):
    """Cancellation result for one requested scope."""

    scope: OrchestratorInterruptScope
    status: OrchestratorInterruptStatus
    message: str = ""
    cancelled_count: int = 0


class OrchestratorInterruptResponse(IOModel):
    """Idempotent response returned by Orchestrator.Interrupt."""

    interrupt_id: str
    status: str
    requested_scopes: list[OrchestratorInterruptScope] = Field(default_factory=list)
    results: list[OrchestratorInterruptScopeResult] = Field(default_factory=list)
    session_id: str | None = None
    request_id: str | None = None
    event_topic: str = OrchestratorEvents.INTERRUPTED
    audit_event: str = "orchestrator.interrupt.requested"
    idempotent: bool = True
    secrets_redacted: bool = True


class OrchestratorInterruptedEvent(IOModel):
    """Event emitted after an interrupt request is handled."""

    interrupt_id: str
    status: str
    requested_scopes: list[OrchestratorInterruptScope] = Field(default_factory=list)
    results: list[OrchestratorInterruptScopeResult] = Field(default_factory=list)
    session_id: str | None = None
    request_id: str | None = None
    reason: str = "user_interrupt"
    principal_id: str | None = None
    audit_event: str = "orchestrator.interrupt.requested"
    secrets_redacted: bool = True


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
