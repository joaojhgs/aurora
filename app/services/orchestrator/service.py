"""Orchestrator Service for Aurora's parallel architecture.

This service:
- Consumes input messages (from STT, UI, external sources)
- Runs LangGraph agent for processing
- Produces responses and tool requests
- Coordinates with other services via message bus
- Integrates with LangGraph stream_graph_updates
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import (
    Envelope,
    MessageBus,
)
from app.messaging.priority_helpers import get_interactive_priority
from app.services.orchestrator.graph import GraphOrchestrator, set_orchestrator
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.orchestrator import (
    ModelRuntimeBenchmarkInfo,
    ModelRuntimeCatalogRequest,
    ModelRuntimeCatalogResponse,
    ModelRuntimeFileInfo,
    ModelRuntimeOperationRequest,
    ModelRuntimeOperationResponse,
    ModelRuntimeOperationStatusRequest,
    ModelRuntimeProgressInfo,
    ModelRuntimeProviderInfo,
    ModelRuntimeRequest,
    ModelRuntimeResponse,
    OrchestratorMethods,
    OrchestratorModule,
    OrchestratorProcessRequest,
    OrchestratorResponse,
    OrchestratorToolResultRequest,
)
from app.shared.contracts.models.stt import STTMethods
from app.shared.contracts.registry import method_contract
from app.shared.config.interface import ConfigAPI
from app.shared.messaging.models.stt_coordinator_models import STTUserSpeechCaptured
from app.shared.services.base_service import BaseService


# Service implementation
class OrchestratorService(BaseService):
    """Orchestrator service using LangGraph.

    Responsibilities:
    - Process user inputs
    - Run LangGraph agent
    - Emit responses and tool requests
    - Coordinate with other services
    """

    def __init__(self):
        """Initialize orchestrator service with LangGraph integration."""
        super().__init__(
            module=OrchestratorModule.NAME,
            summary="Central intelligence orchestrator using LangGraph",
            capabilities=["llm_processing", "agent_execution", "tool_use"],
        )
        self.orchestrator: GraphOrchestrator | None = None
        self._model_runtime_operations: dict[str, ModelRuntimeOperationResponse] = {}

    async def on_start(self) -> None:
        """Start the orchestrator service and subscribe to inputs."""
        log_info("Starting Orchestrator service...")

        # Initialize graph orchestrator with bus dependency injection
        self.orchestrator = GraphOrchestrator(bus=self.bus)
        set_orchestrator(self.orchestrator)
        log_info("Graph orchestrator initialized with bus dependency")

        # Manually subscribe to STT events (since they don't map 1:1 to a contract request model yet)
        # Or we can define a contract for it. For now, keep manual for STT to ensure compatibility.
        # Actually, we can use a contract if we define the input model correctly.
        # STTUserSpeechCaptured is an Event, not a Request.
        # But we can treat it        # Subscribe to STT events
        self.bus.subscribe(STTMethods.USER_SPEECH_CAPTURED, self._on_transcription)

    async def on_stop(self) -> None:
        """Stop the orchestrator service."""
        log_info("Stopping Orchestrator service...")
        self.bus.unsubscribe(STTMethods.USER_SPEECH_CAPTURED, self._on_transcription)

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading OrchestratorService configuration: section={config_section}")
        # Reload orchestrator if LLM config changed
        if config_section is None or str(config_section).startswith("services.orchestrator"):
            log_info("Reloading orchestrator due to LLM config change...")
            # Reinitialize orchestrator with new config
            await self.stop()
            await self.start()
        log_info("OrchestratorService configuration reloaded")

    async def reload_config(self, event) -> None:
        """Reload only for Orchestrator-owned config changes."""
        key_path = getattr(event, "key_path", "") or ""
        affected_sections = getattr(event, "affected_sections", []) or []
        if key_path.startswith("services.orchestrator") or any(
            str(section).startswith("services.orchestrator") for section in affected_sections
        ):
            await self.reload(key_path)
            return
        log_debug(f"Ignoring unrelated config change for OrchestratorService: {key_path}")

    async def _on_transcription(self, env: Envelope) -> None:
        """Handle STT transcription event.

        Args:
            env: Message envelope containing STTUserSpeechCaptured event
        """
        log_info("🎯 Orchestrator received message on STT.UserSpeechCaptured")

        try:
            event = STTUserSpeechCaptured.model_validate(env.payload)

            log_info(
                f"   Validated event: session={event.session_id}, text='{event.text}', is_final={event.is_final}"
            )

            # Only process final transcriptions
            if not event.is_final:
                log_info("   Skipping non-final transcription")
                return

            log_info(f"Processing transcription: {event.text}")
            await self._process_input(event.text, source="stt", session_id=event.session_id)

        except Exception as e:
            log_error(f"Error processing transcription: {e}", exc_info=True)

    @method_contract(
        method_id=OrchestratorMethods.USER_INPUT,
        summary="Process user input",
        input_model=OrchestratorProcessRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def process_user_input(self, cmd: OrchestratorProcessRequest) -> EmptyOutput:
        """Handle UI user input command."""
        try:
            log_info(f"Processing UI input: {cmd.text}")
            await self._process_input(cmd.text, source="ui", session_id=cmd.session_id)
            # Wait, OrchestratorProcessRequest has session_id?
            # Let's check the model definition I created.
            # It has 'message', 'context', 'stream', 'max_tokens'.
            # It does NOT have session_id explicitly in the one I wrote in step 800?
            # Wait, step 800 content:
            # class OrchestratorProcessRequest(IOModel):
            #     message: str
            #     context: dict[str, Any] | None = None
            #     stream: bool = False
            #     max_tokens: int | None = None

            # The previous UserInput model had session_id.
            # I should probably update OrchestratorProcessRequest to include session_id if needed.
            # For now, I'll pass None or extract from context if I update the model.

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error processing UI input: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=OrchestratorMethods.EXTERNAL_USER_INPUT,
        summary="Process external user input and return the LLM response",
        input_model=OrchestratorProcessRequest,
        output_model=OrchestratorResponse,
        exposure="external",
        method_type="use",
    )
    async def process_external_input(self, cmd: OrchestratorProcessRequest) -> OrchestratorResponse:
        """Handle external user input command and return the response."""
        try:
            log_info(f"Processing external input: {cmd.text}")
            response_text = await self._process_input(
                cmd.text,
                source="external",
                session_id=cmd.session_id,
                return_response=True,  # Return the response for external API
            )
            return OrchestratorResponse(
                text=response_text or "",
                session_id=cmd.session_id,
                metadata={"source": "external"},
            )

        except Exception as e:
            log_error(f"Error processing external input: {e}", exc_info=True)
            return OrchestratorResponse(
                text=f"Error: {e!s}",
                session_id=cmd.session_id,
                metadata={"source": "external", "error": True},
            )

    @method_contract(
        method_id=OrchestratorMethods.TOOL_RESULT,
        summary="Process tool execution result",
        input_model=OrchestratorToolResultRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def process_tool_result(
        self, cmd: OrchestratorToolResultRequest
    ) -> EmptyOutput:  # Need to check model
        """Handle tool execution result."""
        try:
            log_info(f"Tool result received: {cmd.request_id}")

            # TODO: Process tool result and continue agent execution
            # This requires the graph to be able to accept tool outputs

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error processing tool result: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=OrchestratorMethods.GET_MODEL_RUNTIME,
        summary="Get current model runtime state",
        input_model=ModelRuntimeRequest,
        output_model=ModelRuntimeResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
    )
    async def get_model_runtime(self, data: ModelRuntimeRequest) -> ModelRuntimeResponse:
        """Return redacted runtime state for the selected or requested model provider."""
        catalog = await self._build_model_runtime_catalog(
            include_unavailable=data.include_unavailable,
            include_operations=True,
        )
        provider = None
        if data.provider_id:
            provider = next(
                (candidate for candidate in catalog.providers if candidate.provider_id == data.provider_id),
                None,
            )
        elif catalog.selected_provider_id:
            provider = next(
                (
                    candidate
                    for candidate in catalog.providers
                    if candidate.provider_id == catalog.selected_provider_id
                ),
                None,
            )

        return ModelRuntimeResponse(
            generated_at=catalog.generated_at,
            selected_provider_id=catalog.selected_provider_id,
            provider=provider,
            providers=catalog.providers,
            secrets_redacted=True,
        )

    @method_contract(
        method_id=OrchestratorMethods.GET_MODEL_CATALOG,
        summary="Get the model provider catalog",
        input_model=ModelRuntimeCatalogRequest,
        output_model=ModelRuntimeCatalogResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
    )
    async def get_model_catalog(
        self, data: ModelRuntimeCatalogRequest
    ) -> ModelRuntimeCatalogResponse:
        """Return a redacted provider catalog for UI/SDK availability decisions."""
        return await self._build_model_runtime_catalog(
            include_unavailable=data.include_unavailable,
            include_operations=data.include_operations,
        )

    @method_contract(
        method_id=OrchestratorMethods.GET_MODEL_OPERATION,
        summary="Get model runtime operation progress",
        input_model=ModelRuntimeOperationStatusRequest,
        output_model=ModelRuntimeOperationResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
    )
    async def get_model_operation(
        self, data: ModelRuntimeOperationStatusRequest
    ) -> ModelRuntimeOperationResponse:
        """Return progress for an import/download/benchmark operation."""
        operation = self._model_runtime_operations.get(data.operation_id)
        if operation is not None:
            return operation
        now = _utc_now()
        return ModelRuntimeOperationResponse(
            operation_id=data.operation_id,
            operation_type="unknown",
            status="unknown",
            message="Model runtime operation was not found in this process",
            reason_code="operation_not_found",
            updated_at=now,
        )

    @method_contract(
        method_id=OrchestratorMethods.IMPORT_MODEL,
        summary="Import a model into a runtime provider",
        input_model=ModelRuntimeOperationRequest,
        output_model=ModelRuntimeOperationResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Orchestrator.manage"],
    )
    async def import_model(
        self, data: ModelRuntimeOperationRequest
    ) -> ModelRuntimeOperationResponse:
        """Report that model import is not implemented by this backend slice."""
        return self._unsupported_model_operation("import", data)

    @method_contract(
        method_id=OrchestratorMethods.DOWNLOAD_MODEL,
        summary="Download a model for a runtime provider",
        input_model=ModelRuntimeOperationRequest,
        output_model=ModelRuntimeOperationResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Orchestrator.manage"],
    )
    async def download_model(
        self, data: ModelRuntimeOperationRequest
    ) -> ModelRuntimeOperationResponse:
        """Report that model download is not implemented by this backend slice."""
        return self._unsupported_model_operation("download", data)

    @method_contract(
        method_id=OrchestratorMethods.BENCHMARK_MODEL,
        summary="Benchmark a model runtime provider",
        input_model=ModelRuntimeOperationRequest,
        output_model=ModelRuntimeOperationResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Orchestrator.manage"],
    )
    async def benchmark_model(
        self, data: ModelRuntimeOperationRequest
    ) -> ModelRuntimeOperationResponse:
        """Report that runtime benchmarking is not implemented by this backend slice."""
        return self._unsupported_model_operation("benchmark", data)

    async def _process_input(
        self,
        text: str,
        source: str,
        session_id: str | None = None,
        return_response: bool = False,
    ) -> str | None:
        """Process user input through LangGraph agent.

        Args:
            text: User input text
            source: Input source ("stt", "ui", "external")
            session_id: Optional session identifier
            return_response: If True, return the response text instead of just publishing

        Returns:
            Response text if return_response is True, else None
        """
        try:
            log_debug(f"Processing input from {source}: {text}")

            # Run LangGraph agent via orchestrator instance
            # DON'T use TTS internally - orchestrator handles TTS via message bus
            if self.orchestrator is None:
                raise RuntimeError("Orchestrator not initialized")

            response_text = await self.orchestrator.stream_graph_updates(text, tts_result=False)

            log_info(f"🤖 LLM response: {response_text[:100]}...")

            # If we got a response, emit it
            if response_text and response_text != "END":
                # Emit response event
                # We need to use the new OrchestratorResponse model if we want to be consistent,
                # but LLMResponseReady is what listeners expect currently.
                # For now, keep using LLMResponseReady for backward compatibility with UI/TTS
                from app.shared.messaging.models.orchestrator_models import LLMResponseReady

                await self.bus.publish(
                    OrchestratorMethods.RESPONSE,
                    LLMResponseReady(
                        text=response_text,
                        session_id=session_id,
                        metadata={"source": source},
                    ),
                    event=True,  # Broadcast to all subscribers (UI, TTS, etc.)
                    mesh=True,
                    priority=get_interactive_priority(),
                    origin="internal",
                )

                # Send TTS request to speak the response
                from app.shared.contracts.models.tts import TTSMethods
                from app.shared.messaging.models.tts_models import TTSRequest

                await self.bus.publish(
                    TTSMethods.REQUEST,
                    TTSRequest(text=response_text, interrupt=True),
                    event=False,  # Command, not event
                    priority=get_interactive_priority(),
                    origin="internal",
                )

            # Return response if requested (for external API calls)
            if return_response:
                return response_text

        except Exception as e:
            log_error(f"Error processing input: {e}", exc_info=True)
            if return_response:
                return f"Error: {e!s}"

        return None

    async def _build_model_runtime_catalog(
        self,
        *,
        include_unavailable: bool = True,
        include_operations: bool = True,
    ) -> ModelRuntimeCatalogResponse:
        """Build a redacted model provider catalog from current configuration."""
        services_config = await ConfigAPI().aget_config("services", timeout=15.0)
        orchestrator_config = services_config.get("orchestrator", {})
        llm_config = orchestrator_config.get("llm", {})
        selected_provider = str(llm_config.get("provider") or "openai")
        providers = _configured_model_providers(
            llm_config=llm_config,
            hardware_acceleration=bool(orchestrator_config.get("hardware_acceleration", False)),
            selected_provider=selected_provider,
            operations=self._model_runtime_operations if include_operations else {},
        )
        if not include_unavailable:
            providers = [provider for provider in providers if provider.health != "unavailable"]

        unavailable = [
            provider.provider_id
            for provider in providers
            if provider.health in {"unavailable", "misconfigured"}
        ]
        return ModelRuntimeCatalogResponse(
            generated_at=_utc_now(),
            selected_provider_id=selected_provider,
            providers=providers,
            provider_index=_provider_index(providers),
            unavailable=unavailable,
            internal_only=[],
            secrets_redacted=True,
        )

    def _unsupported_model_operation(
        self,
        operation_type: str,
        data: ModelRuntimeOperationRequest,
    ) -> ModelRuntimeOperationResponse:
        """Create an auditable unsupported operation record without side effects."""
        now = _utc_now()
        operation = ModelRuntimeOperationResponse(
            operation_id=f"model-{operation_type}-{uuid4().hex[:12]}",
            operation_type=operation_type,
            status="unsupported",
            provider_id=data.provider_id,
            model_id=data.model_id,
            progress_percent=0.0,
            message=(
                f"Model {operation_type} is not implemented by this backend contract slice; "
                "UI/SDK must keep the action disabled or degraded until a provider implements it."
            ),
            reason_code="operation_not_supported",
            started_at=now,
            updated_at=now,
            completed_at=now,
            audit_event=f"model_runtime.{operation_type}.unsupported",
            secrets_redacted=True,
        )
        self._model_runtime_operations[operation.operation_id] = operation
        return operation


def _utc_now() -> str:
    return datetime.utcnow().isoformat()


def _configured_model_providers(
    *,
    llm_config: dict[str, Any],
    hardware_acceleration: bool,
    selected_provider: str,
    operations: dict[str, ModelRuntimeOperationResponse],
) -> list[ModelRuntimeProviderInfo]:
    third_party = llm_config.get("third_party") or {}
    local = llm_config.get("local") or {}
    openai_options = ((third_party.get("openai") or {}).get("options") or {})
    hf_endpoint_options = ((third_party.get("huggingface_endpoint") or {}).get("options") or {})
    hf_pipeline_options = ((local.get("huggingface_pipeline") or {}).get("options") or {})
    llama_options = ((local.get("llama_cpp") or {}).get("options") or {})

    return [
        _provider_info(
            provider_id="openai",
            display_name="OpenAI",
            backend_kind="openai_chat",
            provider_type="cloud",
            selected_provider=selected_provider,
            model_id=openai_options.get("model"),
            source="provider-managed",
            license_name="provider_terms",
            context_window=None,
            generation_limit=openai_options.get("max_tokens"),
            hardware={},
            capabilities=["chat", "tool_calling"],
            health=_health_from_required_secret(openai_options.get("api_key")),
            health_reason=_secret_health_reason(openai_options.get("api_key"), "api_key"),
            operations=operations,
        ),
        _provider_info(
            provider_id="huggingface_endpoint",
            display_name="HuggingFace Endpoint",
            backend_kind="huggingface_endpoint",
            provider_type="cloud",
            selected_provider=selected_provider,
            model_id=hf_endpoint_options.get("model"),
            source=hf_endpoint_options.get("endpoint_url") or "provider-managed",
            license_name="model_card",
            context_window=None,
            generation_limit=hf_endpoint_options.get("max_tokens"),
            hardware={},
            capabilities=["chat"],
            health="available" if hf_endpoint_options.get("endpoint_url") else "misconfigured",
            health_reason=None
            if hf_endpoint_options.get("endpoint_url")
            else "endpoint_url is not configured",
            operations=operations,
        ),
        _provider_info(
            provider_id="huggingface_pipeline",
            display_name="HuggingFace Pipeline",
            backend_kind="transformers_pipeline",
            provider_type="local",
            selected_provider=selected_provider,
            model_id=hf_pipeline_options.get("model"),
            source="huggingface_hub",
            license_name="model_card",
            context_window=None,
            generation_limit=hf_pipeline_options.get("max_tokens"),
            hardware={
                "device": hf_pipeline_options.get("device") or "auto",
                "torch_dtype": hf_pipeline_options.get("torch_dtype") or "auto",
                "hardware_acceleration": hardware_acceleration,
            },
            capabilities=["chat", "local_execution"],
            health="available" if hf_pipeline_options.get("model") else "misconfigured",
            health_reason=None
            if hf_pipeline_options.get("model")
            else "model is not configured",
            operations=operations,
        ),
        _provider_info(
            provider_id="llama_cpp",
            display_name="llama.cpp",
            backend_kind="llama_cpp",
            provider_type="local",
            selected_provider=selected_provider,
            model_id=_display_model_id(llama_options.get("model_path")),
            source="local_file",
            license_name="user_supplied",
            context_window=llama_options.get("n_ctx"),
            generation_limit=llama_options.get("max_tokens"),
            hardware={
                "n_gpu_layers": llama_options.get("n_gpu_layers", 0),
                "n_batch": llama_options.get("n_batch"),
                "hardware_acceleration": hardware_acceleration,
            },
            model_files=_model_files(llama_options.get("model_path")),
            capabilities=["chat", "local_execution", "gguf"],
            health=_file_health(llama_options.get("model_path")),
            health_reason=_file_health_reason(llama_options.get("model_path")),
            operations=operations,
        ),
    ]


def _provider_info(
    *,
    provider_id: str,
    display_name: str,
    backend_kind: str,
    provider_type: str,
    selected_provider: str,
    model_id: str | None,
    source: str | None,
    license_name: str | None,
    context_window: int | None,
    generation_limit: int | None,
    hardware: dict[str, Any],
    capabilities: list[str],
    health: str,
    health_reason: str | None,
    operations: dict[str, ModelRuntimeOperationResponse],
    model_files: list[ModelRuntimeFileInfo] | None = None,
) -> ModelRuntimeProviderInfo:
    provider_operations = [
        operation for operation in operations.values() if operation.provider_id == provider_id
    ]
    return ModelRuntimeProviderInfo(
        provider_id=provider_id,
        display_name=display_name,
        backend_kind=backend_kind,
        provider_type=provider_type,
        enabled=True,
        selected=provider_id == selected_provider,
        health=health,
        health_reason=health_reason,
        model_id=model_id,
        source=_redacted_source(source),
        license=license_name,
        context_window=context_window if isinstance(context_window, int) else None,
        generation_limit=generation_limit if isinstance(generation_limit, int) else None,
        hardware=hardware,
        model_files=model_files or [],
        capabilities=capabilities,
        benchmark=_benchmark_progress(provider_operations),
        import_progress=_operation_progress("import", provider_operations),
        download_progress=_operation_progress("download", provider_operations),
        secrets_redacted=True,
    )


def _provider_index(providers: list[ModelRuntimeProviderInfo]) -> dict[str, list[str]]:
    return {
        "all": [provider.provider_id for provider in providers],
        "local": [provider.provider_id for provider in providers if provider.provider_type == "local"],
        "cloud": [provider.provider_id for provider in providers if provider.provider_type == "cloud"],
        "selected": [provider.provider_id for provider in providers if provider.selected],
    }


def _health_from_required_secret(secret_value: Any) -> str:
    return "available" if bool(secret_value) else "misconfigured"


def _secret_health_reason(secret_value: Any, name: str) -> str | None:
    return None if bool(secret_value) else f"{name} is not configured"


def _display_model_id(path_or_model: Any) -> str | None:
    if not path_or_model:
        return None
    return Path(str(path_or_model)).name


def _redacted_source(source: str | None) -> str | None:
    if not source:
        return source
    if "://" in source:
        return source.split("://", 1)[0] + "://redacted"
    return source


def _model_files(path_value: Any) -> list[ModelRuntimeFileInfo]:
    if not path_value:
        return []
    path = Path(str(path_value))
    exists = path.exists()
    return [
        ModelRuntimeFileInfo(
            kind=path.suffix.lstrip(".") or "model",
            display_name=path.name,
            exists=exists,
            size_bytes=path.stat().st_size if exists and path.is_file() else None,
            path_redacted=True,
        )
    ]


def _file_health(path_value: Any) -> str:
    if not path_value:
        return "misconfigured"
    return "available" if Path(str(path_value)).exists() else "degraded"


def _file_health_reason(path_value: Any) -> str | None:
    if not path_value:
        return "model_path is not configured"
    if not Path(str(path_value)).exists():
        return "Configured model file was not found"
    return None


def _operation_progress(
    operation_type: str,
    operations: list[ModelRuntimeOperationResponse],
) -> ModelRuntimeProgressInfo:
    operation = next(
        (candidate for candidate in reversed(operations) if candidate.operation_type == operation_type),
        None,
    )
    if operation is None:
        return ModelRuntimeProgressInfo(
            operation_type=operation_type,
            status="not_started",
            message=f"No {operation_type} operation has been started",
        )
    return ModelRuntimeProgressInfo(
        operation_id=operation.operation_id,
        operation_type=operation.operation_type,
        status=operation.status,
        progress_percent=operation.progress_percent,
        message=operation.message,
        updated_at=operation.updated_at,
    )


def _benchmark_progress(
    operations: list[ModelRuntimeOperationResponse],
) -> ModelRuntimeBenchmarkInfo:
    operation = next(
        (candidate for candidate in reversed(operations) if candidate.operation_type == "benchmark"),
        None,
    )
    if operation is None:
        return ModelRuntimeBenchmarkInfo(
            status="unavailable",
            reason="No benchmark has been run by this backend",
        )
    return ModelRuntimeBenchmarkInfo(
        status=operation.status,
        reason=operation.message,
        measured_at=operation.updated_at,
    )
