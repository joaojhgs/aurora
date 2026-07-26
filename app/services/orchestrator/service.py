"""Orchestrator Service for Aurora's parallel architecture.

This service:
- Consumes input messages (from STT, UI, external sources)
- Runs LangGraph agent for processing
- Produces responses and tool requests
- Coordinates with other services via message bus
- Integrates with LangGraph stream_graph_updates
"""

from __future__ import annotations

import asyncio
import importlib
import json
import re
import time
from collections.abc import AsyncIterator
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.helpers.getUseHardwareAcceleration import get_use_hardware_acceleration
from app.messaging import (
    Envelope,
    MessageBus,
)
from app.messaging.priority_helpers import get_interactive_priority, get_system_priority
from app.services.orchestrator.graph import GraphOrchestrator, set_orchestrator
from app.shared.config.interface import ConfigAPI
from app.shared.contracts.models.auth import AuthMethods, StoreAuditEventRequest
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.db import (
    DBEnsureSessionRequest,
    DBMethods,
    DBRAGStoreRequest,
    DBResolveDaemonSessionRequest,
    DBSaveMessageRequest,
    DBSessionRecord,
    DBSessionResponse,
)
from app.shared.contracts.models.orchestrator import (
    AssistantStreamEvent,
    AttachmentContextIngestRequest,
    AttachmentContextIngestResponse,
    AttachmentContextItem,
    AttachmentContextItemResult,
    AttachmentContextPrivacyClass,
    AttachmentContextStatus,
    AttachmentContextStoragePolicy,
    ModelRuntimeBenchmarkInfo,
    ModelRuntimeCatalogRequest,
    ModelRuntimeCatalogResponse,
    ModelRuntimeFileInfo,
    ModelRuntimeModelInfo,
    ModelRuntimeOperationRequest,
    ModelRuntimeOperationResponse,
    ModelRuntimeOperationStatusRequest,
    ModelRuntimeProgressInfo,
    ModelRuntimeProviderInfo,
    ModelRuntimeRequest,
    ModelRuntimeResponse,
    OrchestratorChatMessage,
    OrchestratorEvents,
    OrchestratorInferChatChunk,
    OrchestratorInferChatRequest,
    OrchestratorInferChatResponse,
    OrchestratorInterruptedEvent,
    OrchestratorInterruptRequest,
    OrchestratorInterruptResponse,
    OrchestratorInterruptScope,
    OrchestratorInterruptScopeResult,
    OrchestratorListPendingToolApprovalsRequest,
    OrchestratorListPendingToolApprovalsResponse,
    OrchestratorMethods,
    OrchestratorModule,
    OrchestratorProcessRequest,
    OrchestratorResponse,
    OrchestratorResumeToolApprovalRequest,
    OrchestratorResumeToolApprovalResponse,
    OrchestratorToolResultRequest,
)
from app.shared.contracts.models.stt import STTMethods
from app.shared.contracts.models.tooling import ToolingExecuteToolResponse
from app.shared.contracts.models.tts import (
    TTSMethods,
    TTSRequest,
    TTSStopRequest,
    TTSStreamChunkRequest,
    TTSStreamEndRequest,
    TTSStreamStartRequest,
)
from app.shared.contracts.registry import get_contract, method_contract
from app.shared.messaging.models.stt_coordinator_models import STTUserSpeechCaptured
from app.shared.services.base_service import BaseService

_SECRET_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[^'\"\s]+"), "credential"),
    (re.compile(r"(?i)bearer\s+[a-z0-9._~+/=-]{16,}"), "bearer_token"),
    (re.compile(r"\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b"), "api_key"),
)
_SENSITIVE_METADATA_KEY_PATTERN = re.compile(
    r"(?i)(api[_-]?key|auth|authorization|bearer|cookie|credential|password|secret|signature|token)"
)
_URI_IN_TEXT_PATTERN = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s'\"]+", re.IGNORECASE)
_REMOTE_INFERENCE_PERMS = {
    "*",
    "Orchestrator.manage",
    "Orchestrator.RemoteInference",
    "Orchestrator.remote_inference",
}
_MAX_INFERENCE_MESSAGES = 64
_MAX_INFERENCE_MESSAGE_BYTES = 64 * 1024
_MAX_INFERENCE_TOTAL_BYTES = 256 * 1024
_MAX_INFERENCE_TOOLS = 64
_MAX_INFERENCE_TOOLS_BYTES = 256 * 1024
_OPENAI_NON_CHAT_MODEL_MARKERS = (
    "embedding",
    "audio",
    "whisper",
    "tts",
    "dall-e",
    "image",
    "moderation",
    "babbage",
    "davinci",
    "instruct",
    "realtime",
)
_OPENAI_CHAT_MODEL_PREFIXES = ("gpt-", "chatgpt-", "o1", "o3", "o4")


class _SessionPersistenceError(RuntimeError):
    """A DB session request failed and the local turn must not continue ephemerally."""


def _coerce_mesh_selector(value: Any) -> Any | None:
    from app.shared.contracts.models.mesh import MeshAddressSelector

    if isinstance(value, MeshAddressSelector):
        return value if value.has_routing_target() else None
    if isinstance(value, dict):
        selector = MeshAddressSelector(
            peer_id=value.get("peer_id") or value.get("peerId"),
            provider_id=value.get("provider_id") or value.get("providerId"),
            service_instance_id=value.get("service_instance_id") or value.get("serviceInstanceId"),
            resource_namespace=value.get("resource_namespace")
            or value.get("resourceNamespace")
            or "inference",
        )
        return selector if selector.has_routing_target() else None
    return None


async def configured_provider_inference_llm(provider_id: str, model_id: str | None) -> Any:
    """Instantiate an advertised provider/model using configured options only."""

    services_config = await ConfigAPI().aget_config("services", timeout=15.0)
    llm_config = (services_config.get("orchestrator", {}) or {}).get("llm", {}) or {}
    third_party = llm_config.get("third_party") or {}
    local = llm_config.get("local") or {}

    if provider_id == "openai":
        from langchain_openai import ChatOpenAI

        openai_options = (third_party.get("openai") or {}).get("options") or {}
        api_key = str(openai_options.get("api_key") or "").strip()
        if not api_key:
            raise RuntimeError("configured OpenAI API key is not available")
        opts = {key: value for key, value in openai_options.items() if value is not None}
        if model_id:
            opts["model"] = model_id
        return ChatOpenAI(**opts)

    if provider_id == "huggingface_endpoint":
        from langchain_huggingface import ChatHuggingFace, HuggingFaceEndpoint

        endpoint_options = (
            (third_party.get("huggingface_endpoint") or {}).get("options") or {}
        ).copy()
        if model_id:
            endpoint_options["model"] = model_id
        if "access_token" in endpoint_options:
            endpoint_options["huggingfacehub_api_token"] = endpoint_options.pop("access_token")
        if "max_tokens" in endpoint_options:
            endpoint_options["max_new_tokens"] = endpoint_options.pop("max_tokens")
        endpoint_options = {
            key: value for key, value in endpoint_options.items() if value is not None
        }
        return ChatHuggingFace(llm=HuggingFaceEndpoint(**endpoint_options))

    if provider_id == "huggingface_pipeline":
        from langchain_huggingface import ChatHuggingFace, HuggingFacePipeline

        pipeline_options = ((local.get("huggingface_pipeline") or {}).get("options") or {}).copy()
        configured_model = pipeline_options.pop("model", None)
        selected_model = model_id or configured_model
        if not selected_model:
            raise RuntimeError("configured HuggingFace pipeline model is not available")
        pipeline_kwargs = pipeline_options.pop("pipeline_kwargs", {})
        model_kwargs = pipeline_options.pop("model_kwargs", {})
        for key, value in pipeline_options.items():
            if key not in {"temperature", "max_tokens"} and value is not None:
                model_kwargs[key] = value
        device_value = 0 if get_use_hardware_acceleration("llm") == "cuda" else -1
        pipeline = HuggingFacePipeline.from_model_id(
            model_id=selected_model,
            task="text-generation",
            device=device_value,
            pipeline_kwargs=pipeline_kwargs,
            model_kwargs=model_kwargs,
        )
        return ChatHuggingFace(llm=pipeline, verbose=True, model_id=selected_model)

    if provider_id == "llama_cpp":
        import app.services.orchestrator.chat_llama_cpp_fn_handler  # noqa: F401
        from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
        from app.shared.path_utils import resolve_path

        llama_options = ((local.get("llama_cpp") or {}).get("options") or {}).copy()
        model_path = llama_options.get("model_path")
        if not model_path:
            raise RuntimeError("configured llama.cpp model_path is not available")
        llama_options["model_path"] = str(resolve_path(model_path))
        llama_options["disable_streaming"] = True
        return ChatLlamaCpp(**llama_options)

    raise RuntimeError(f"provider_id {provider_id!r} is not supported by the inference factory")


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
        self._model_catalog_cache: dict[str, dict[str, Any]] = {}
        self._generation_tasks: dict[asyncio.Task, str | None] = {}
        self._generation_lock = asyncio.Lock()
        self._ui_automatic_tts_readback = False

    async def on_start(self) -> None:
        """Start the orchestrator service and subscribe to inputs."""
        log_info("Starting Orchestrator service...")
        await self._load_ui_assistant_config()

        # Initialize graph orchestrator with bus dependency injection
        self.orchestrator = GraphOrchestrator(bus=self.bus)
        await self.orchestrator.initialize_durable_pending_approvals()
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
        await self._cancel_generation_tasks(session_id=None)

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading OrchestratorService configuration: section={config_section}")
        if config_section is None or str(config_section).startswith("ui"):
            await self._load_ui_assistant_config()
        # Reload orchestrator if LLM config changed
        if config_section is None or str(config_section).startswith("services.orchestrator"):
            log_info("Reloading orchestrator due to LLM config change...")
            # Reinitialize orchestrator with new config
            await self.stop()
            await self.start()
        log_info("OrchestratorService configuration reloaded")

    async def _load_ui_assistant_config(self) -> None:
        """Load UI-origin assistant behavior without reading config files directly."""
        try:
            value = await ConfigAPI().aget(
                "ui.assistant.automatic_tts_readback",
                default=False,
                config_timeout=15.0,
            )
            self._ui_automatic_tts_readback = bool(value)
        except Exception as e:
            self._ui_automatic_tts_readback = False
            log_error(f"Failed to load UI assistant config: {e}", exc_info=True)

    async def reload_config(self, event) -> None:
        """Reload only for Orchestrator-owned config changes."""
        key_path = getattr(event, "key_path", "") or ""
        affected_sections = getattr(event, "affected_sections", []) or []
        if key_path.startswith(("services.orchestrator", "ui")) or any(
            str(section).startswith(("services.orchestrator", "ui"))
            for section in affected_sections
        ):
            await self.reload(key_path)
            return
        log_debug(f"Ignoring unrelated config change for OrchestratorService: {key_path}")

    @staticmethod
    def _session_response(data: Any, operation: str) -> DBSessionRecord:
        """Validate one DB session response without depending on transport shape."""

        try:
            response = (
                data
                if isinstance(data, DBSessionResponse)
                else DBSessionResponse.model_validate(data)
            )
            return response.session
        except Exception as exc:
            raise RuntimeError(f"{operation} returned an invalid session response") from exc

    async def _ensure_chat_session(
        self,
        *,
        principal_id: str,
        session_id: str,
        title: str | None = None,
    ) -> DBSessionRecord:
        """Validate ownership or create one explicitly typed chat session."""

        result = await self.bus.request(
            DBMethods.ENSURE_SESSION,
            DBEnsureSessionRequest(
                principal_id=principal_id,
                type="chat",
                session_id=session_id,
                title=title,
                activate=True,
            ),
            timeout=10.0,
            priority=get_system_priority(),
            origin="internal",
            principal_id=principal_id,
        )
        if not result.ok:
            raise _SessionPersistenceError(result.error or "DB.EnsureSession failed")
        return self._session_response(result.data, "DB.EnsureSession")

    async def _resolve_daemon_chat_session(self) -> DBSessionRecord:
        """Resolve the local wakeword target using the 24-hour active window."""

        result = await self.bus.request(
            DBMethods.RESOLVE_DAEMON_SESSION,
            DBResolveDaemonSessionRequest(type="chat", stale_after_seconds=86_400),
            timeout=10.0,
            priority=get_system_priority(),
            origin="internal",
        )
        if not result.ok:
            raise _SessionPersistenceError(result.error or "DB.ResolveDaemonSession failed")
        return self._session_response(result.data, "DB.ResolveDaemonSession")

    async def _persist_chat_message(
        self,
        *,
        principal_id: str,
        session_id: str,
        role: str,
        content: str,
        source: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Persist one chat turn after the session owner has been resolved."""

        message_metadata = dict(metadata or {})
        message_metadata.setdefault(
            "source_type",
            "STT" if source == "stt" and role == "user" else "Text",
        )
        result = await self.bus.request(
            DBMethods.SAVE_MESSAGE,
            DBSaveMessageRequest(
                content=content,
                role=role,
                session_id=session_id,
                principal_id=principal_id,
                session_type="chat",
                metadata=message_metadata,
            ),
            timeout=10.0,
            priority=get_system_priority(),
            origin="internal",
            principal_id=principal_id,
        )
        if not result.ok:
            raise RuntimeError(result.error or "DB.SaveMessage failed")
        success = (
            bool(getattr(result.data, "success", False))
            if not isinstance(result.data, dict)
            else bool(result.data.get("success"))
        )
        if not success:
            raise RuntimeError("DB.SaveMessage did not commit the chat message")

    @staticmethod
    def _session_persistence_is_local(
        *,
        caller_peer_id: str | None,
        caller_identity_source: str | None,
    ) -> bool:
        """Keep persisted chat sessions out of mesh and peer RPC paths."""

        return not (
            caller_peer_id or caller_identity_source in {"webrtc_rpc", "mesh_peer", "remote_peer"}
        )

    async def _prepare_chat_session(
        self,
        *,
        text: str,
        source: str,
        session_id: str | None,
        request_id: str | None,
        correlation_id: str | None,
        caller_principal_id: str | None,
        caller_peer_id: str | None,
        caller_identity_source: str | None,
    ) -> tuple[str | None, str | None, bool]:
        """Resolve a local persisted session, degrading to the existing ephemeral flow."""

        if not self._session_persistence_is_local(
            caller_peer_id=caller_peer_id,
            caller_identity_source=caller_identity_source,
        ):
            return session_id, caller_principal_id, False

        try:
            if source == "stt":
                session = await self._resolve_daemon_chat_session()
            else:
                requested_session_id = (
                    session_id or request_id or correlation_id or f"assistant-session-{uuid4().hex}"
                )
                session = await self._ensure_chat_session(
                    principal_id=caller_principal_id or "system",
                    session_id=requested_session_id,
                    title=text.strip()[:80] or None,
                )
            return session.id, session.principal_id, True
        except _SessionPersistenceError:
            raise
        except Exception as exc:
            if caller_principal_id:
                raise _SessionPersistenceError(
                    "DB returned an invalid persisted session response"
                ) from exc
            log_error(f"Chat session persistence is unavailable; continuing ephemerally: {exc}")
            return session_id, caller_principal_id, False

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
            voice_request_id = event.session_id or f"voice-{uuid4().hex}"
            await self._process_input(
                event.text,
                source="stt",
                session_id=event.session_id,
                request_id=voice_request_id,
                correlation_id=voice_request_id,
                stream=True,
            )

        except Exception as e:
            log_error(f"Error processing transcription: {e}", exc_info=True)

    @method_contract(
        method_id=OrchestratorMethods.USER_INPUT,
        summary="Process user input",
        input_model=OrchestratorProcessRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
        required_perms=["Orchestrator.use"],
    )
    async def process_user_input(self, cmd: OrchestratorProcessRequest) -> EmptyOutput:
        """Handle UI user input command."""
        try:
            log_info(f"Processing UI input: {cmd.text}")
            process_kwargs: dict[str, Any] = {}
            if cmd.client_tts_playback is not None:
                process_kwargs["response_metadata"] = {
                    "client_tts_playback": cmd.client_tts_playback
                }
            await self._process_input(
                cmd.text,
                source="ui",
                session_id=cmd.session_id,
                request_id=cmd.request_id,
                correlation_id=cmd.correlation_id,
                stream=cmd.stream,
                inference_selector=cmd.inference_selector,
                inference_provider_id=cmd.inference_provider_id,
                inference_model_id=cmd.inference_model_id,
                **process_kwargs,
            )
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
        required_perms=["Orchestrator.use"],
        callable_feature_ids=["assistant_conversation"],
    )
    async def process_external_input(
        self,
        cmd: OrchestratorProcessRequest,
        envelope: Envelope | None = None,
    ) -> OrchestratorResponse:
        """Handle external user input command and return the response."""
        session_id = (
            cmd.session_id
            or cmd.request_id
            or cmd.correlation_id
            or f"assistant-session-{uuid4().hex}"
        )
        try:
            source = cmd.source or "external"
            log_info(f"Processing external input: {cmd.text}")
            metadata: dict[str, Any] = {"source": source, "stream": cmd.stream}
            if cmd.client_tts_playback is not None:
                metadata["client_tts_playback"] = cmd.client_tts_playback
            caller_context: dict[str, Any] = {}
            if envelope is not None:
                caller_context = {
                    "caller_principal_id": getattr(envelope, "principal_id", None),
                    "caller_peer_id": getattr(envelope, "caller_peer_id", None),
                    "caller_effective_perms": list(
                        getattr(envelope, "effective_perms", None) or []
                    ),
                    "caller_identity_source": getattr(envelope, "identity_source", None),
                }
            response_text = await self._process_input(
                cmd.text,
                source=source,
                session_id=session_id,
                request_id=cmd.request_id,
                correlation_id=cmd.correlation_id,
                return_response=True,  # Return the response for external API
                response_metadata=metadata,
                stream=cmd.stream,
                inference_selector=cmd.inference_selector,
                inference_provider_id=cmd.inference_provider_id,
                inference_model_id=cmd.inference_model_id,
                **caller_context,
            )
            return OrchestratorResponse(
                text=response_text or "",
                session_id=session_id,
                request_id=cmd.request_id,
                correlation_id=cmd.correlation_id,
                metadata=metadata,
            )

        except Exception as e:
            log_error(f"Error processing external input: {e}", exc_info=True)
            return OrchestratorResponse(
                text=f"Error: {e!s}",
                session_id=session_id,
                request_id=cmd.request_id,
                correlation_id=cmd.correlation_id,
                metadata={"source": cmd.source or "external", "stream": cmd.stream, "error": True},
            )

    @method_contract(
        method_id=OrchestratorMethods.INFER_CHAT,
        summary="Run inference-only chat on this orchestrator runtime",
        input_model=OrchestratorInferChatRequest,
        output_model=OrchestratorInferChatResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        callable_feature_ids=["inference"],
    )
    async def infer_chat(
        self,
        data: OrchestratorInferChatRequest,
        envelope: Envelope | None = None,
    ) -> OrchestratorInferChatResponse:
        """Run a local LLM inference for mesh callers without executing tools."""
        explicit_selection = bool(data.provider_id or data.model_id)
        self._authorize_direct_inference_request(
            data, envelope, explicit_selection=explicit_selection
        )
        data = await self._validated_inference_request(
            data,
            include_cloud_models=self._can_expand_cloud_catalog(
                envelope, explicit_selection=explicit_selection
            ),
        )
        response_message = await self._invoke_inference_llm(data)
        return self._infer_response_from_message(data, response_message)

    @method_contract(
        method_id=OrchestratorMethods.STREAM_INFER_CHAT,
        summary="Stream inference-only chat from this orchestrator runtime",
        input_model=OrchestratorInferChatRequest,
        output_model=OrchestratorInferChatChunk,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        callable_feature_ids=["inference"],
    )
    async def stream_infer_chat(
        self,
        data: OrchestratorInferChatRequest,
        envelope: Envelope | None = None,
    ) -> AsyncIterator[OrchestratorInferChatChunk]:
        """Stream local LLM chunks for mesh callers without executing tools."""
        explicit_selection = bool(data.provider_id or data.model_id)
        self._authorize_direct_inference_request(
            data, envelope, explicit_selection=explicit_selection
        )
        data = await self._validated_inference_request(
            data,
            include_cloud_models=self._can_expand_cloud_catalog(
                envelope, explicit_selection=explicit_selection
            ),
        )
        return self._stream_inference_llm(data)

    @method_contract(
        method_id=OrchestratorMethods.INGEST_CONTEXT,
        summary="Ingest assistant attachment and shared context metadata",
        input_model=AttachmentContextIngestRequest,
        output_model=AttachmentContextIngestResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        callable_feature_ids=["assistant_conversation"],
    )
    async def ingest_context(
        self, data: AttachmentContextIngestRequest
    ) -> AttachmentContextIngestResponse:
        """Accept redacted text context for assistant use with policy and audit metadata."""
        correlation_id = data.correlation_id or f"context-{uuid4().hex[:12]}"
        accepted_items: list[AttachmentContextItemResult] = []
        rejected_items: list[AttachmentContextItemResult] = []
        total_bytes = 0

        if len(data.items) > data.limits.max_items:
            response = self._context_response(
                data=data,
                accepted_items=[],
                rejected_items=[
                    self._context_result(
                        item=AttachmentContextItem(kind="text"),
                        index=0,
                        status="rejected",
                        storage_policy=data.storage_policy,
                        privacy_class=data.privacy_class,
                        reason_code="too_many_items",
                        message=f"Context item count exceeds limit {data.limits.max_items}",
                    )
                ],
                total_bytes=0,
                correlation_id=correlation_id,
            )
            await self._audit_context_ingestion(data, response)
            return response

        for index, item in enumerate(data.items):
            item_bytes = self._context_item_size(item)
            total_bytes += item_bytes

            if data.storage_policy == "reject":
                rejected_items.append(
                    self._context_result(
                        item=item,
                        index=index,
                        status="rejected",
                        storage_policy=data.storage_policy,
                        privacy_class=data.privacy_class,
                        reason_code="storage_policy_reject",
                        message="Storage policy rejects attachment/context ingestion",
                    )
                )
                continue

            if data.privacy_class in {"secret", "credential", "raw-audio"}:
                rejected_items.append(
                    self._context_result(
                        item=item,
                        index=index,
                        status="rejected",
                        storage_policy=data.storage_policy,
                        privacy_class=data.privacy_class,
                        accepted_bytes=item_bytes,
                        reason_code="privacy_class_blocked",
                        message="Privacy class is not accepted for assistant context ingestion",
                    )
                )
                continue

            if item_bytes > data.limits.max_item_bytes:
                rejected_items.append(
                    self._context_result(
                        item=item,
                        index=index,
                        status="rejected",
                        storage_policy=data.storage_policy,
                        privacy_class=data.privacy_class,
                        accepted_bytes=item_bytes,
                        reason_code="item_too_large",
                        message=f"Context item exceeds limit {data.limits.max_item_bytes} bytes",
                    )
                )
                continue

            if total_bytes > data.limits.max_total_bytes:
                rejected_items.append(
                    self._context_result(
                        item=item,
                        index=index,
                        status="rejected",
                        storage_policy=data.storage_policy,
                        privacy_class=data.privacy_class,
                        accepted_bytes=item_bytes,
                        reason_code="total_too_large",
                        message=f"Context batch exceeds limit {data.limits.max_total_bytes} bytes",
                    )
                )
                continue

            text = self._context_item_text(item)
            if not text:
                rejected_items.append(
                    self._context_result(
                        item=item,
                        index=index,
                        status="unsupported",
                        storage_policy=data.storage_policy,
                        privacy_class=data.privacy_class,
                        reason_code="no_text_context",
                        message="Only text-like attachment/context content is supported",
                    )
                )
                continue

            sanitized_text, redaction_reasons = self._sanitize_context_text(
                text,
                max_chars=data.limits.max_text_chars,
            )
            status: AttachmentContextStatus = "redacted" if redaction_reasons else "accepted"
            result = self._context_result(
                item=item,
                index=index,
                status=status,
                storage_policy=data.storage_policy,
                privacy_class=data.privacy_class,
                accepted_bytes=item_bytes,
                redacted=bool(redaction_reasons),
                redaction_reasons=redaction_reasons,
                message="Context accepted for assistant use",
            )

            if data.storage_policy == "rag":
                stored_key, final_redaction_reasons = await self._store_context_in_rag(
                    data=data,
                    item=item,
                    item_id=result.item_id,
                    text=sanitized_text,
                    redacted=bool(redaction_reasons),
                    redaction_reasons=redaction_reasons,
                    correlation_id=correlation_id,
                )
                result.status = "stored"
                result.stored_namespace = data.namespace
                result.stored_key = stored_key
                result.redaction_reasons = final_redaction_reasons
                result.redacted = bool(final_redaction_reasons)

            accepted_items.append(result)

        response = self._context_response(
            data=data,
            accepted_items=accepted_items,
            rejected_items=rejected_items,
            total_bytes=total_bytes,
            correlation_id=correlation_id,
        )
        await self._audit_context_ingestion(data, response)
        return response

    @method_contract(
        method_id=OrchestratorMethods.TOOL_RESULT,
        summary="Process tool execution result",
        input_model=OrchestratorToolResultRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
        required_perms=["Orchestrator.use"],
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
        method_id=OrchestratorMethods.LIST_PENDING_TOOL_APPROVALS,
        summary="List pending assistant tool approval pauses",
        input_model=OrchestratorListPendingToolApprovalsRequest,
        output_model=OrchestratorListPendingToolApprovalsResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        callable_feature_ids=["tool_approval"],
    )
    async def list_pending_tool_approvals(
        self,
        data: OrchestratorListPendingToolApprovalsRequest,
        envelope: Envelope | None = None,
    ) -> OrchestratorListPendingToolApprovalsResponse:
        """Return backend pending approval state for active assistant tool calls."""

        if self.orchestrator is None:
            return OrchestratorListPendingToolApprovalsResponse()
        approvals = list(self.orchestrator.pending_tool_approvals.values())
        if self._external_approval_request(envelope):
            if not data.session_id:
                return OrchestratorListPendingToolApprovalsResponse()
            principal_id = getattr(envelope, "principal_id", None)
            caller_peer_id = getattr(envelope, "caller_peer_id", None)
            if not self._can_manage_tool_approvals(envelope):
                approvals = [
                    approval
                    for approval in approvals
                    if approval.owner_principal_id == principal_id
                    or (
                        approval.owner_principal_id is None
                        and approval.owner_peer_id is not None
                        and approval.owner_peer_id == caller_peer_id
                    )
                ]
        if data.run_id:
            approvals = [approval for approval in approvals if approval.run_id == data.run_id]
        if data.session_id:
            approvals = [
                approval
                for approval in approvals
                if approval.session_id == data.session_id or approval.thread_id == data.session_id
            ]
        if data.status:
            approvals = [approval for approval in approvals if approval.status == data.status]
        return OrchestratorListPendingToolApprovalsResponse(
            approvals=approvals,
            count=len(approvals),
        )

    @method_contract(
        method_id=OrchestratorMethods.RESUME_TOOL_APPROVAL,
        summary="Resolve an exact assistant tool approval and execute the pending call",
        input_model=OrchestratorResumeToolApprovalRequest,
        output_model=OrchestratorResumeToolApprovalResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        callable_feature_ids=["tool_approval"],
    )
    async def resume_tool_approval(
        self,
        data: OrchestratorResumeToolApprovalRequest,
        envelope: Envelope | None = None,
    ) -> OrchestratorResumeToolApprovalResponse:
        """Approve/deny a pending assistant tool call using backend Tooling contracts."""

        if self.orchestrator is None:
            return OrchestratorResumeToolApprovalResponse(
                ok=False,
                status="failed",
                error="orchestrator_not_started",
                correlation_id=data.correlation_id,
            )
        pending_for_auth = self.orchestrator.get_pending_tool_approval(
            pending_id=data.pending_id,
            approval_request_id=data.approval_request_id,
        )
        auth_error = self._approval_resume_authorization_error(
            data,
            pending=pending_for_auth,
            envelope=envelope,
        )
        if auth_error is not None:
            return OrchestratorResumeToolApprovalResponse(
                ok=False,
                status=pending_for_auth.status if pending_for_auth is not None else "failed",
                pending=pending_for_auth,
                error=auth_error,
                correlation_id=data.correlation_id
                or (pending_for_auth.correlation_id if pending_for_auth else None),
            )
        approver_principal_id = (
            getattr(envelope, "principal_id", None)
            if self._external_approval_request(envelope)
            else data.approver_principal_id
        )
        (
            pending,
            tool_result_data,
            assistant_text,
            error,
        ) = await self.orchestrator.resolve_pending_tool_approval(
            pending_id=data.pending_id,
            approval_request_id=data.approval_request_id,
            approve=data.approve,
            grant_scope=data.grant_scope,
            approver_principal_id=approver_principal_id,
            expires_at=data.expires_at,
            include_future_tools=data.include_future_tools,
            reason=data.reason,
            correlation_id=data.correlation_id,
        )
        tool_result = None
        if isinstance(tool_result_data, ToolingExecuteToolResponse):
            tool_result = tool_result_data
        elif isinstance(tool_result_data, dict):
            try:
                tool_result = ToolingExecuteToolResponse.model_validate(tool_result_data)
            except Exception:
                tool_result = None
        return OrchestratorResumeToolApprovalResponse(
            ok=error is None,
            status=pending.status if pending is not None else "failed",
            pending=pending,
            tool_result=tool_result,
            assistant_text=assistant_text,
            error=error,
            correlation_id=data.correlation_id or (pending.correlation_id if pending else None),
        )

    @staticmethod
    def _external_approval_request(envelope: Envelope | None) -> bool:
        """Return whether approval/listing came from an authenticated external boundary."""

        if envelope is None:
            return False
        identity_source = getattr(envelope, "identity_source", None)
        origin = getattr(envelope, "origin", "internal")
        return origin == "external" or identity_source in {
            "gateway_http",
            "webrtc_rpc",
            "mesh_peer",
            "remote_peer",
            "token",
        }

    @staticmethod
    def _can_manage_tool_approvals(envelope: Envelope | None) -> bool:
        """Return whether the caller may manage durable assistant tool approvals."""

        if envelope is None:
            return True
        if not OrchestratorService._external_approval_request(envelope):
            return True
        from app.shared.auth.permissions import has_permission

        effective = set(getattr(envelope, "effective_perms", None) or [])
        return any(
            has_permission(required, effective, method_type="manage")
            for required in {"Tooling.manage", "Orchestrator.manage"}
        )

    def _approval_resume_authorization_error(
        self,
        data: OrchestratorResumeToolApprovalRequest,
        *,
        pending: Any | None,
        envelope: Envelope | None,
    ) -> str | None:
        """Validate external approval ownership and durable-grant authority."""

        if not self._external_approval_request(envelope):
            return None
        if pending is None:
            return "pending_approval_not_found"
        if not data.session_id:
            return "session_id_required"
        if pending.session_id != data.session_id and pending.thread_id != data.session_id:
            return "pending_approval_session_mismatch"

        principal_id = getattr(envelope, "principal_id", None)
        caller_peer_id = getattr(envelope, "caller_peer_id", None)
        can_manage = self._can_manage_tool_approvals(envelope)
        if not can_manage:
            if not principal_id and not caller_peer_id:
                return "approval_caller_identity_required"
            if pending.owner_principal_id and pending.owner_principal_id != principal_id:
                return "pending_approval_owner_mismatch"
            if (
                pending.owner_principal_id is None
                and pending.owner_peer_id
                and pending.owner_peer_id != caller_peer_id
            ):
                return "pending_approval_owner_mismatch"

        durable_scopes = {"session", "until_expiry", "always", "scheduled_execution", "deny_always"}
        if data.grant_scope in durable_scopes and not can_manage:
            return "tool_approval_manage_permission_required"
        return None

    @method_contract(
        method_id=OrchestratorMethods.INTERRUPT,
        summary="Interrupt active assistant generation, tool work, TTS playback, or a session",
        input_model=OrchestratorInterruptRequest,
        output_model=OrchestratorInterruptResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        callable_feature_ids=["assistant_control"],
    )
    async def interrupt_assistant(
        self,
        data: OrchestratorInterruptRequest,
        envelope: Envelope | None = None,
    ) -> OrchestratorInterruptResponse:
        """Handle an idempotent assistant interrupt request."""
        interrupt_id = f"interrupt-{uuid4().hex[:12]}"
        scopes = _dedupe_scopes(data.scopes)
        results: list[OrchestratorInterruptScopeResult] = []

        generation_cancelled_by_session = False
        for scope in scopes:
            if scope == "generation":
                cancelled = await self._cancel_generation_tasks(session_id=data.session_id)
                generation_cancelled_by_session = generation_cancelled_by_session or cancelled > 0
                results.append(
                    OrchestratorInterruptScopeResult(
                        scope=scope,
                        status="cancelled" if cancelled else "no_active_work",
                        cancelled_count=cancelled,
                        message=(
                            f"Cancelled {cancelled} active generation task(s)"
                            if cancelled
                            else "No active generation task matched the interrupt request"
                        ),
                    )
                )
            elif scope == "tool_call":
                results.append(
                    OrchestratorInterruptScopeResult(
                        scope=scope,
                        status="no_active_work",
                        message=(
                            "No separately cancellable tool call is active; graph-level "
                            "generation cancellation covers current tool-bound runs"
                        ),
                    )
                )
            elif scope == "tts_playback":
                tts_correlation_id = data.request_id or getattr(envelope, "correlation_id", None)
                await self.bus.publish(
                    TTSMethods.STOP,
                    TTSStopRequest(correlation_id=tts_correlation_id, reason=data.reason),
                    event=False,
                    priority=get_interactive_priority(),
                    origin="internal",
                    correlation_id=tts_correlation_id,
                    principal_id=getattr(envelope, "principal_id", None),
                    identity_source=getattr(envelope, "identity_source", None),
                    caller_peer_id=getattr(envelope, "caller_peer_id", None),
                )
                results.append(
                    OrchestratorInterruptScopeResult(
                        scope=scope,
                        status="cancelled",
                        cancelled_count=1,
                        message="TTS stop command sent",
                    )
                )
            elif scope == "session":
                cancelled = await self._cancel_generation_tasks(session_id=data.session_id)
                generation_cancelled_by_session = generation_cancelled_by_session or cancelled > 0
                results.append(
                    OrchestratorInterruptScopeResult(
                        scope=scope,
                        status="cancelled" if cancelled else "no_active_work",
                        cancelled_count=cancelled,
                        message=(
                            f"Cancelled {cancelled} active session task(s)"
                            if cancelled
                            else "No active session task matched the interrupt request"
                        ),
                    )
                )

        if generation_cancelled_by_session:
            log_info(
                f"Orchestrator interrupt {interrupt_id} cancelled generation "
                f"for session={data.session_id or '*'}"
            )

        status = _interrupt_status(results)
        response = OrchestratorInterruptResponse(
            interrupt_id=interrupt_id,
            status=status,
            requested_scopes=scopes,
            results=results,
            session_id=data.session_id,
            request_id=data.request_id,
            audit_event="orchestrator.interrupt.requested",
            idempotent=True,
            secrets_redacted=True,
        )
        await self.bus.publish(
            OrchestratorEvents.INTERRUPTED,
            OrchestratorInterruptedEvent(
                interrupt_id=response.interrupt_id,
                status=response.status,
                requested_scopes=response.requested_scopes,
                results=response.results,
                session_id=response.session_id,
                request_id=response.request_id,
                reason=data.reason,
                principal_id=getattr(envelope, "principal_id", None),
                audit_event=response.audit_event,
                secrets_redacted=True,
            ),
            event=True,
            mesh=False,
            priority=get_interactive_priority(),
            origin="internal",
            correlation_id=getattr(envelope, "correlation_id", None),
            principal_id=getattr(envelope, "principal_id", None),
        )
        return response

    @method_contract(
        method_id=OrchestratorMethods.GET_MODEL_RUNTIME,
        summary="Get current model runtime state",
        input_model=ModelRuntimeRequest,
        output_model=ModelRuntimeResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        callable_feature_ids=["model_observability"],
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
                (
                    candidate
                    for candidate in catalog.providers
                    if candidate.provider_id == data.provider_id
                ),
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
        callable_feature_ids=["model_observability"],
    )
    async def get_model_catalog(
        self,
        data: ModelRuntimeCatalogRequest,
        envelope: Envelope | None = None,
    ) -> ModelRuntimeCatalogResponse:
        """Return a redacted provider catalog for UI/SDK availability decisions."""
        self._authorize_cloud_catalog_request(data, envelope)
        catalog_selector = (
            data.catalog_selector or data.remote_catalog_selector or data.mesh_selector
        )
        return await self._build_model_runtime_catalog(
            include_unavailable=data.include_unavailable,
            include_operations=data.include_operations,
            include_remote=data.include_remote,
            include_cloud_models=data.include_cloud_models,
            mesh_selector=catalog_selector,
        )

    @method_contract(
        method_id=OrchestratorMethods.GET_MODEL_OPERATION,
        summary="Get model runtime operation progress",
        input_model=ModelRuntimeOperationStatusRequest,
        output_model=ModelRuntimeOperationResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        callable_feature_ids=["model_observability"],
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
        callable_feature_ids=["model_management"],
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
        callable_feature_ids=["model_management"],
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
        callable_feature_ids=["model_management"],
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
        request_id: str | None = None,
        correlation_id: str | None = None,
        return_response: bool = False,
        response_metadata: dict[str, Any] | None = None,
        stream: bool = False,
        caller_principal_id: str | None = None,
        caller_peer_id: str | None = None,
        inference_selector: Any | None = None,
        inference_provider_id: str | None = None,
        inference_model_id: str | None = None,
        caller_effective_perms: list[str] | None = None,
        caller_identity_source: str | None = None,
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
        current_task = asyncio.current_task()
        if current_task is not None:
            await self._track_generation_task(current_task, session_id)
        metadata = response_metadata if response_metadata is not None else {}
        metadata.setdefault("source", source)
        metadata.setdefault("stream", stream)
        persist_session = False
        mesh_response = not self._session_persistence_is_local(
            caller_peer_id=caller_peer_id,
            caller_identity_source=caller_identity_source,
        )
        inference_override = await self._resolve_inference_override(
            inference_selector=inference_selector,
            inference_provider_id=inference_provider_id,
            inference_model_id=inference_model_id,
            include_cloud_models=self._can_expand_graph_cloud_catalog(
                caller_effective_perms=caller_effective_perms,
                caller_identity_source=caller_identity_source,
                source=source,
            ),
        )
        self._authorize_inference_override(
            inference_override,
            caller_effective_perms=caller_effective_perms,
            caller_identity_source=caller_identity_source,
            source=source,
        )
        try:
            log_debug(f"Processing input from {source}: {text}")

            # Run LangGraph agent via orchestrator instance
            # DON'T use TTS internally - orchestrator handles TTS via message bus
            if self.orchestrator is None:
                raise RuntimeError("Orchestrator not initialized")

            session_id, caller_principal_id, persist_session = await self._prepare_chat_session(
                text=text,
                source=source,
                session_id=session_id,
                request_id=request_id,
                correlation_id=correlation_id,
                caller_principal_id=caller_principal_id,
                caller_peer_id=caller_peer_id,
                caller_identity_source=caller_identity_source,
            )
            if current_task is not None:
                await self._track_generation_task(current_task, session_id)
            if session_id:
                metadata["session_id"] = session_id
            metadata.update(await self._assistant_response_metadata())
            if inference_override:
                selected_provider_id = inference_override.get("inference_provider_id")
                selected_model_id = inference_override.get("inference_model_id")
                selected_provider_label = inference_override.get("inference_provider_label")
                if selected_provider_id:
                    metadata["provider"] = selected_provider_id
                if selected_provider_label:
                    metadata["provider_label"] = selected_provider_label
                if selected_model_id:
                    metadata["model"] = selected_model_id

            if persist_session:
                if not session_id or not caller_principal_id:
                    raise RuntimeError("persisted chat requires a session and principal")
                await self._persist_chat_message(
                    principal_id=caller_principal_id,
                    session_id=session_id,
                    role="user",
                    content=text,
                    source=source,
                )

            if stream:
                response_text = await self._process_streaming_input(
                    text=text,
                    source=source,
                    session_id=session_id,
                    request_id=request_id,
                    correlation_id=correlation_id,
                    metadata=metadata,
                    caller_principal_id=caller_principal_id,
                    caller_peer_id=caller_peer_id,
                    inference_override=inference_override,
                    persist_session=persist_session,
                    mesh_response=mesh_response,
                )
            else:
                response_text = await self.orchestrator.stream_graph_updates(
                    text,
                    tts_result=False,
                    thread_id=session_id or request_id or correlation_id,
                    session_id=session_id,
                    owner_principal_id=caller_principal_id,
                    owner_peer_id=caller_peer_id,
                    inference_override=inference_override,
                )

            log_info(f"🤖 LLM response: {response_text[:100]}...")

            # If we got a response, emit it. LangGraph's END sentinel is a
            # successful terminal state, not a user-visible assistant answer.
            # Still publish a completion event so voice/chat clients do not
            # remain stuck in "processing" when the graph decides no natural
            # language response is needed.
            publish_text = response_text
            skip_tts = False
            if response_text == "END":
                publish_text = "Done."
                skip_tts = True
                metadata["terminal_reason"] = "graph_end"
                metadata["tts_status"] = "skipped"
                metadata["tts_reason"] = "Graph ended without a speakable assistant answer."

            if publish_text and persist_session and not stream:
                await self._persist_chat_message(
                    principal_id=caller_principal_id or "system",
                    session_id=session_id or "",
                    role="assistant",
                    content=publish_text,
                    source=source,
                    metadata={**metadata, "execution": "local"},
                )

            if publish_text and not stream:
                # Emit response event
                # We need to use the new OrchestratorResponse model if we want to be consistent,
                # but LLMResponseReady is what listeners expect currently.
                # For now, keep using LLMResponseReady for backward compatibility with UI/TTS
                from app.shared.messaging.models.orchestrator_models import LLMResponseReady

                await self.bus.publish(
                    OrchestratorMethods.RESPONSE,
                    LLMResponseReady(
                        text=publish_text,
                        session_id=session_id,
                        metadata={
                            "source": source,
                            "request_id": request_id,
                            "correlation_id": correlation_id,
                            **metadata,
                        },
                    ),
                    event=True,  # Broadcast to all subscribers (UI, TTS, etc.)
                    priority=get_interactive_priority(),
                    origin="internal",
                    correlation_id=correlation_id,
                    principal_id=caller_principal_id,
                    caller_peer_id=caller_peer_id,
                    mesh=mesh_response,
                )

                # Voice-origin requests keep voice-to-voice playback. Typed UI and
                # external requests stay silent by default so the chat can finish as soon
                # as text arrives; UI-origin auto-readback is an explicit UI config opt-in.
                should_request_tts = source == "stt" or (
                    source in {"ui", "external"} and self._ui_automatic_tts_readback
                )
                if skip_tts:
                    pass
                elif not should_request_tts:
                    metadata["tts_status"] = "skipped"
                    metadata["tts_reason"] = (
                        "Typed assistant requests do not auto-play TTS unless "
                        "ui.assistant.automatic_tts_readback is enabled."
                    )
                elif get_contract(TTSMethods.REQUEST) is None:
                    metadata["tts_status"] = "unavailable"
                    metadata["tts_reason"] = (
                        f"Optional TTS contract {TTSMethods.REQUEST} is not registered."
                    )
                    log_info(
                        "Assistant response returned; optional TTS request skipped because TTS is disabled"
                    )
                else:
                    try:
                        await self.bus.publish(
                            TTSMethods.REQUEST,
                            TTSRequest(text=publish_text, interrupt=True),
                            event=False,  # Command, not event
                            priority=get_interactive_priority(),
                            origin="internal",
                        )
                        metadata["tts_status"] = "requested"
                    except Exception as e:
                        metadata["tts_status"] = "unavailable"
                        metadata["tts_reason"] = str(e).splitlines()[0]
                        log_error(f"Assistant response returned; optional TTS request skipped: {e}")

            # Return response if requested (for external API calls)
            if return_response:
                return response_text

        except asyncio.CancelledError:
            log_info(f"Orchestrator input processing interrupted for session={session_id}")
            if return_response:
                return "Interrupted"
        except Exception as e:
            log_error(f"Error processing input: {e}", exc_info=True)
            try:
                if stream:
                    await self._publish_assistant_stream_event(
                        AssistantStreamEvent(
                            kind="assistant.failed",
                            text="Aurora could not complete that voice request. Check diagnostics for details.",
                            session_id=session_id,
                            request_id=request_id,
                            correlation_id=correlation_id,
                            is_final=True,
                            metadata={
                                "source": source,
                                "request_id": request_id,
                                "correlation_id": correlation_id,
                                "error": True,
                                "error_type": type(e).__name__,
                            },
                        ),
                        sequence=1,
                        principal_id=caller_principal_id,
                        caller_peer_id=caller_peer_id,
                        mesh=mesh_response,
                    )
                else:
                    from app.shared.messaging.models.orchestrator_models import LLMResponseReady

                    await self.bus.publish(
                        OrchestratorMethods.RESPONSE,
                        LLMResponseReady(
                            text="Aurora could not complete that voice request. Check diagnostics for details.",
                            session_id=session_id,
                            metadata={
                                "source": source,
                                "request_id": request_id,
                                "correlation_id": correlation_id,
                                "error": True,
                                "error_type": type(e).__name__,
                            },
                        ),
                        event=True,
                        priority=get_interactive_priority(),
                        origin="internal",
                        correlation_id=correlation_id,
                        principal_id=caller_principal_id,
                        caller_peer_id=caller_peer_id,
                        mesh=mesh_response,
                    )
            except Exception as publish_error:
                log_error(
                    f"Failed to publish assistant failure event: {publish_error}",
                    exc_info=True,
                )
            if return_response:
                return f"Error: {e!s}"
        finally:
            if current_task is not None:
                await self._untrack_generation_task(current_task)

        return None

    async def _process_streaming_input(
        self,
        *,
        text: str,
        source: str,
        session_id: str | None,
        request_id: str | None,
        correlation_id: str | None,
        metadata: dict[str, Any],
        caller_principal_id: str | None = None,
        caller_peer_id: str | None = None,
        inference_override: dict[str, Any] | None = None,
        persist_session: bool = False,
        mesh_response: bool = True,
    ) -> str:
        """Publish correlated assistant stream events while graph generation runs."""

        if self.orchestrator is None:
            raise RuntimeError("Orchestrator not initialized")

        sequence = 0
        response_text = ""
        tts_stream_id: str | None = None
        tts_text_sequence = 0
        tts_buffer = ""
        client_tts_playback = metadata.get("client_tts_playback") is True
        should_stream_tts = source == "stt" or (
            source in {"ui", "external"}
            and (self._ui_automatic_tts_readback or client_tts_playback)
        )
        if should_stream_tts and get_contract(TTSMethods.STREAM_START) is not None:
            tts_stream_id = f"tts-{request_id or correlation_id or uuid4().hex}"
            await self.bus.publish(
                TTSMethods.STREAM_START,
                TTSStreamStartRequest(
                    stream_id=tts_stream_id,
                    interrupt=True,
                    play_on_server=self._should_play_tts_on_server(source, metadata),
                    correlation_id=correlation_id,
                ),
                event=False,
                priority=get_interactive_priority(),
                origin="internal",
                principal_id=caller_principal_id,
                caller_peer_id=caller_peer_id,
                correlation_id=correlation_id,
            )
            metadata["tts_status"] = "streaming"
            metadata["tts_stream_id"] = tts_stream_id

        async for event in self.orchestrator.stream_graph_events(
            text,
            thread_id=session_id or request_id or correlation_id,
            session_id=session_id,
            owner_principal_id=caller_principal_id,
            owner_peer_id=caller_peer_id,
            inference_override=inference_override,
        ):
            sequence += 1
            if event.kind == "assistant.delta":
                response_text = event.text or f"{response_text}{event.delta}"
                if tts_stream_id and event.delta:
                    tts_buffer, tts_text_sequence = await self._flush_tts_stream_chunks(
                        stream_id=tts_stream_id,
                        buffer=f"{tts_buffer}{event.delta}",
                        next_sequence=tts_text_sequence,
                        correlation_id=correlation_id,
                        principal_id=caller_principal_id,
                        caller_peer_id=caller_peer_id,
                        final=False,
                    )
            elif event.kind == "assistant.completed" and event.text:
                response_text = event.text
            await self._publish_assistant_stream_event(
                event,
                sequence=sequence,
                session_id=session_id,
                request_id=request_id,
                correlation_id=correlation_id,
                metadata=metadata,
                principal_id=caller_principal_id,
                caller_peer_id=caller_peer_id,
                mesh=mesh_response,
            )

        publish_text = response_text
        terminal_metadata = dict(metadata)
        if publish_text == "END":
            publish_text = "Done."
            terminal_metadata["terminal_reason"] = "graph_end"
            terminal_metadata["tts_status"] = "skipped"
            terminal_metadata["tts_reason"] = "Graph ended without a speakable assistant answer."

        if tts_stream_id:
            tts_buffer, tts_text_sequence = await self._flush_tts_stream_chunks(
                stream_id=tts_stream_id,
                buffer=tts_buffer,
                next_sequence=tts_text_sequence,
                correlation_id=correlation_id,
                principal_id=caller_principal_id,
                caller_peer_id=caller_peer_id,
                final=True,
            )
            await self.bus.publish(
                TTSMethods.STREAM_END,
                TTSStreamEndRequest(
                    stream_id=tts_stream_id,
                    final_sequence=tts_text_sequence - 1 if tts_text_sequence > 0 else None,
                    reason="completed",
                    correlation_id=correlation_id,
                ),
                event=False,
                priority=get_interactive_priority(),
                origin="internal",
                principal_id=caller_principal_id,
                caller_peer_id=caller_peer_id,
                correlation_id=correlation_id,
            )
        elif publish_text and publish_text != "Done.":
            await self._request_response_tts(
                text=publish_text,
                source=source,
                metadata=terminal_metadata,
                skip_tts=False,
            )

        if publish_text and persist_session:
            await self._persist_chat_message(
                principal_id=caller_principal_id or "system",
                session_id=session_id or "",
                role="assistant",
                content=publish_text,
                source=source,
                metadata={**terminal_metadata, "execution": "local"},
            )

        sequence += 1
        await self._publish_assistant_stream_event(
            AssistantStreamEvent(
                kind="assistant.completed",
                text=publish_text,
                is_final=True,
            ),
            sequence=sequence,
            session_id=session_id,
            request_id=request_id,
            correlation_id=correlation_id,
            metadata=terminal_metadata,
            principal_id=caller_principal_id,
            caller_peer_id=caller_peer_id,
            mesh=mesh_response,
        )
        return publish_text

    async def _flush_tts_stream_chunks(
        self,
        *,
        stream_id: str,
        buffer: str,
        next_sequence: int,
        correlation_id: str | None,
        principal_id: str | None,
        caller_peer_id: str | None,
        final: bool,
    ) -> tuple[str, int]:
        """Flush sentence-sized TTS stream text chunks over the typed bus."""

        def split_ready(text_buffer: str) -> tuple[list[str], str]:
            chunks: list[str] = []
            start = 0
            for match in re.finditer(r"(?<=[.!?;:])\s+", text_buffer):
                end = match.end()
                chunk = text_buffer[start:end].strip()
                if chunk:
                    chunks.append(chunk)
                start = end
            remainder = text_buffer[start:]
            # Flush earlier than sentence boundaries so voice-to-voice playback
            # can start while tokens are still arriving. Prefer whitespace cuts
            # to avoid feeding half-words to the TTS engine.
            if not final and 48 <= len(remainder) < 140:
                split_at = max(remainder.rfind(" ", 0, 96), remainder.rfind(",", 0, 96))
                if split_at >= 32:
                    chunks.append(remainder[: split_at + 1].strip())
                    remainder = remainder[split_at + 1 :]
            if not final and len(remainder) < 140:
                return chunks, remainder
            if final and remainder.strip() or len(remainder) >= 180:
                chunks.append(remainder.strip())
                remainder = ""
            return chunks, remainder

        chunks, remainder = split_ready(buffer)
        for chunk in chunks:
            await self.bus.publish(
                TTSMethods.STREAM_CHUNK,
                TTSStreamChunkRequest(
                    stream_id=stream_id,
                    sequence=next_sequence,
                    text=chunk,
                    is_final=final and chunk == chunks[-1] and not remainder,
                    correlation_id=correlation_id,
                ),
                event=False,
                priority=get_interactive_priority(),
                origin="internal",
                principal_id=principal_id,
                caller_peer_id=caller_peer_id,
                correlation_id=correlation_id,
            )
            next_sequence += 1
        return remainder, next_sequence

    async def _publish_assistant_stream_event(
        self,
        event: AssistantStreamEvent,
        *,
        sequence: int,
        session_id: str | None = None,
        request_id: str | None = None,
        correlation_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        principal_id: str | None = None,
        caller_peer_id: str | None = None,
        mesh: bool = True,
    ) -> None:
        """Publish one typed assistant stream event with propagated identifiers."""

        merged_metadata = {
            **(metadata or {}),
            **(event.metadata or {}),
        }
        payload = event.model_copy(
            update={
                "session_id": event.session_id or session_id,
                "request_id": event.request_id or request_id,
                "correlation_id": event.correlation_id or correlation_id,
                "message_id": event.message_id
                or event.request_id
                or request_id
                or event.correlation_id
                or correlation_id,
                "sequence": sequence,
                "metadata": merged_metadata,
            }
        )
        await self.bus.publish(
            OrchestratorMethods.RESPONSE,
            payload,
            event=True,
            mesh=mesh,
            priority=get_interactive_priority(),
            origin="internal",
            correlation_id=payload.correlation_id,
            principal_id=principal_id,
            caller_peer_id=caller_peer_id,
        )

    def _should_play_tts_on_server(self, source: str, metadata: dict[str, Any]) -> bool:
        """Return whether streamed TTS should use the server audio device."""
        if source == "stt":
            return True
        if source in {"ui", "external"} and metadata.get("client_tts_playback") is True:
            return False
        if source in {"ui", "external"} and self._ui_automatic_tts_readback:
            return metadata.get("client_tts_playback") is False
        return False

    async def _request_response_tts(
        self,
        *,
        text: str,
        source: str,
        metadata: dict[str, Any],
        skip_tts: bool,
    ) -> None:
        """Request server-side TTS for a completed assistant response when enabled."""

        should_request_tts = source == "stt" or (
            source in {"ui", "external"}
            and self._ui_automatic_tts_readback
            and metadata.get("client_tts_playback") is False
        )
        if skip_tts:
            return
        if not should_request_tts:
            metadata["tts_status"] = "skipped"
            metadata["tts_reason"] = (
                "Typed assistant requests do not auto-play TTS unless "
                "ui.assistant.automatic_tts_readback is enabled."
            )
            return
        if get_contract(TTSMethods.REQUEST) is None:
            metadata["tts_status"] = "unavailable"
            metadata["tts_reason"] = (
                f"Optional TTS contract {TTSMethods.REQUEST} is not registered."
            )
            log_info(
                "Assistant response returned; optional TTS request skipped because TTS is disabled"
            )
            return
        try:
            await self.bus.publish(
                TTSMethods.REQUEST,
                TTSRequest(text=text, interrupt=True),
                event=False,
                priority=get_interactive_priority(),
                origin="internal",
            )
            metadata["tts_status"] = "requested"
        except Exception as e:
            metadata["tts_status"] = "unavailable"
            metadata["tts_reason"] = str(e).splitlines()[0]
            log_error(f"Assistant response returned; optional TTS request skipped: {e}")

    async def _assistant_response_metadata(self) -> dict[str, Any]:
        """Return redacted selected-model metadata for assistant UI state."""
        try:
            services_config = await ConfigAPI().aget_config("services", timeout=15.0)
            orchestrator_config = services_config.get("orchestrator", {})
            llm_config = orchestrator_config.get("llm", {})
            provider = str(llm_config.get("provider") or "openai")
            model = _selected_llm_model(llm_config, provider)
            metadata: dict[str, Any] = {
                "provider": provider,
                "provider_label": _provider_display_name(provider),
            }
            if model:
                metadata["model"] = model
            return metadata
        except Exception as e:
            log_error(f"Failed to build assistant response metadata: {e}", exc_info=True)
            return {}

    async def _track_generation_task(
        self,
        task: asyncio.Task,
        session_id: str | None,
    ) -> None:
        async with self._generation_lock:
            self._generation_tasks[task] = session_id

    async def _untrack_generation_task(self, task: asyncio.Task) -> None:
        async with self._generation_lock:
            self._generation_tasks.pop(task, None)

    async def _cancel_generation_tasks(self, session_id: str | None) -> int:
        current_task = asyncio.current_task()
        async with self._generation_lock:
            candidates = [
                task
                for task, task_session_id in self._generation_tasks.items()
                if task is not current_task
                and not task.done()
                and (session_id is None or task_session_id == session_id)
            ]

        for task in candidates:
            task.cancel()

        if candidates:
            await asyncio.gather(*candidates, return_exceptions=True)
        return len(candidates)

    async def _resolve_inference_override(
        self,
        *,
        inference_selector: Any | None = None,
        inference_provider_id: str | None = None,
        inference_model_id: str | None = None,
        include_cloud_models: bool = False,
    ) -> dict[str, Any] | None:
        """Resolve per-request/default inference routing without affecting dispatch."""

        selector = _coerce_mesh_selector(inference_selector)
        provider = None
        timeout_s: float | None = None
        explicit_provider_model_selection = bool(inference_provider_id or inference_model_id)
        if selector is None and not inference_provider_id and not inference_model_id:
            try:
                services = await ConfigAPI().aget_config("services", timeout=5.0)
            except Exception as exc:
                log_debug(f"Could not load orchestrator inference default: {exc}")
                services = {}
            orchestrator = services.get("orchestrator", {}) if isinstance(services, dict) else {}
            routing = orchestrator.get("routing", {}) if isinstance(orchestrator, dict) else {}
            default = routing.get("inference_default", {}) if isinstance(routing, dict) else {}
            if isinstance(default, dict):
                provider = default.get("provider")
                inference_provider_id = default.get("provider_id") or default.get("providerId")
                inference_model_id = default.get("model_id") or default.get("modelId")
                timeout_raw = default.get("timeout_s") or default.get("timeoutSeconds")
                try:
                    timeout_s = float(timeout_raw) if timeout_raw is not None else None
                except (TypeError, ValueError):
                    timeout_s = None
                if (
                    provider in {"remote_peer", "mesh_peer"}
                    or default.get("peer_id")
                    or default.get("service_instance_id")
                    or default.get("serviceInstanceId")
                ):
                    selector = _coerce_mesh_selector(default)
        remote_selector_active = selector is not None or provider in {"remote_peer", "mesh_peer"}
        selection_policy: dict[str, Any] = {}
        if not remote_selector_active and (inference_provider_id or inference_model_id):
            (
                inference_provider_id,
                inference_model_id,
                selection_policy,
            ) = await self._validate_local_graph_inference_ids(
                provider_id=inference_provider_id,
                model_id=inference_model_id,
                include_cloud_models=include_cloud_models,
            )
        if (
            selector is None
            and not inference_provider_id
            and not inference_model_id
            and provider in (None, "configured")
        ):
            return None
        return {
            "inference_selector": selector,
            "inference_provider_id": inference_provider_id,
            "inference_model_id": inference_model_id,
            "inference_provider": provider,
            "inference_timeout_s": timeout_s,
            "inference_explicit_selection": explicit_provider_model_selection,
            **selection_policy,
        }

    def _authorize_inference_override(
        self,
        inference_override: dict[str, Any] | None,
        *,
        caller_effective_perms: list[str] | None,
        caller_identity_source: str | None,
        source: str,
    ) -> None:
        """Fail closed for external runtime routing to remote inference providers.

        A normal ``Orchestrator.use`` call may run the configured/default local
        model. Choosing a mesh peer at runtime moves prompt content to another
        device, so explicit remote-inference permission is required for
        external callers. Internal UI/STT calls keep using configured defaults.
        """

        if not inference_override:
            return
        provider = inference_override.get("inference_provider")
        selector = inference_override.get("inference_selector")
        provider_id = str(inference_override.get("inference_provider_id") or "")
        is_remote = (
            provider in {"remote_peer", "mesh_peer"}
            or selector is not None
            or provider_id.startswith(("remote:", "mesh:"))
        )
        explicit_selection = bool(inference_override.get("inference_explicit_selection"))
        cloud_or_non_default = explicit_selection and (
            bool(inference_override.get("inference_provider_is_cloud"))
            or not bool(inference_override.get("inference_selection_is_default"))
        )
        if not is_remote and not cloud_or_non_default:
            return

        externalish = source == "external" or caller_identity_source in {
            "gateway_http",
            "webrtc_rpc",
            "mesh_peer",
            "remote_peer",
            "token",
        }
        if not externalish:
            return

        effective = set(caller_effective_perms or [])
        if effective.intersection(_REMOTE_INFERENCE_PERMS):
            return
        raise PermissionError(
            "Runtime inference provider/model selection requires Orchestrator.RemoteInference permission"
        )

    def _can_expand_graph_cloud_catalog(
        self,
        *,
        caller_effective_perms: list[str] | None,
        caller_identity_source: str | None,
        source: str,
    ) -> bool:
        """Allow live cloud-model validation only for trusted or authorized callers."""

        externalish = source == "external" or caller_identity_source in {
            "gateway_http",
            "webrtc_rpc",
            "mesh_peer",
            "remote_peer",
            "token",
        }
        if not externalish:
            return True
        return bool(set(caller_effective_perms or []).intersection(_REMOTE_INFERENCE_PERMS))

    async def _validate_local_graph_inference_ids(
        self,
        *,
        provider_id: str | None,
        model_id: str | None,
        include_cloud_models: bool = False,
    ) -> tuple[str, str | None, dict[str, Any]]:
        """Validate explicit graph inference ids against advertised local/cloud providers."""

        catalog = await self._build_model_runtime_catalog(
            include_unavailable=True,
            include_operations=False,
            include_remote=False,
            include_cloud_models=include_cloud_models,
        )
        provider, selected_model_id = self._validate_advertised_provider_from_catalog(
            catalog=catalog,
            provider_id=provider_id,
            model_id=model_id,
            provider_field="inference_provider_id",
            model_field="inference_model_id",
        )
        return (
            provider.provider_id,
            selected_model_id,
            self._inference_selection_policy_metadata(catalog, provider, selected_model_id),
        )

    async def _validated_inference_request(
        self, data: OrchestratorInferChatRequest, *, include_cloud_models: bool = False
    ) -> OrchestratorInferChatRequest:
        """Validate provider/model labels against this peer's advertised catalog.

        Callers may select provider/model ids already advertised by this
        orchestrator runtime. The receiving runtime still owns instantiation and
        uses only its configured provider credentials/options; caller ``params``
        are accepted for tracing only and never applied as generation settings.
        """

        self._enforce_inference_request_limits(data)
        provider, model_id = await self._validated_advertised_inference_provider(
            provider_id=data.provider_id,
            model_id=data.model_id,
            include_cloud_models=include_cloud_models,
            provider_field="provider_id",
            model_field="model_id",
        )
        return data.model_copy(
            update={
                "provider_id": provider.provider_id,
                "model_id": model_id,
            }
        )

    @staticmethod
    def _json_size(value: Any) -> int:
        try:
            return len(json.dumps(value, default=str).encode("utf-8"))
        except Exception:
            return len(str(value).encode("utf-8"))

    def _enforce_inference_request_limits(self, data: OrchestratorInferChatRequest) -> None:
        """Bound caller-supplied inference payloads before provider invocation."""

        if len(data.messages) > _MAX_INFERENCE_MESSAGES:
            raise ValueError(
                f"messages exceeds limit {_MAX_INFERENCE_MESSAGES} for inference requests"
            )
        total_message_bytes = 0
        for message in data.messages:
            size = len((message.content or "").encode("utf-8"))
            if size > _MAX_INFERENCE_MESSAGE_BYTES:
                raise ValueError(
                    f"message content exceeds limit {_MAX_INFERENCE_MESSAGE_BYTES} bytes"
                )
            total_message_bytes += self._json_size(message.model_dump(mode="json"))
        if total_message_bytes > _MAX_INFERENCE_TOTAL_BYTES:
            raise ValueError(f"messages payload exceeds limit {_MAX_INFERENCE_TOTAL_BYTES} bytes")
        if len(data.tools) > _MAX_INFERENCE_TOOLS:
            raise ValueError(f"tools exceeds limit {_MAX_INFERENCE_TOOLS} for inference requests")
        tools_bytes = self._json_size(data.tools)
        if tools_bytes > _MAX_INFERENCE_TOOLS_BYTES:
            raise ValueError(f"tools payload exceeds limit {_MAX_INFERENCE_TOOLS_BYTES} bytes")

    def _authorize_direct_inference_request(
        self,
        data: OrchestratorInferChatRequest,
        envelope: Envelope | None,
        *,
        explicit_selection: bool,
    ) -> None:
        """Require explicit permission before external callers select provider/model.

        Direct InferChat/StreamInferChat are mesh transport primitives. A default
        request may use the receiving peer's configured model under
        ``Orchestrator.use``. Choosing a concrete provider/model can spend cloud
        quota or select non-default local resources, so external callers need the
        same remote-inference capability used by conversation runtime overrides.
        """

        del data
        if not explicit_selection or envelope is None:
            return
        identity_source = getattr(envelope, "identity_source", None)
        origin = getattr(envelope, "origin", "internal")
        externalish = origin == "external" or identity_source in {
            "gateway_http",
            "webrtc_rpc",
            "mesh_peer",
            "remote_peer",
            "token",
        }
        if not externalish:
            return
        effective = set(getattr(envelope, "effective_perms", None) or [])
        if effective.intersection(_REMOTE_INFERENCE_PERMS):
            return
        raise PermissionError(
            "Explicit inference provider/model selection requires Orchestrator.RemoteInference permission"
        )

    def _authorize_cloud_catalog_request(
        self,
        data: ModelRuntimeCatalogRequest,
        envelope: Envelope | None,
    ) -> None:
        """Protect live cloud-provider catalog expansion from unprivileged callers."""

        if not data.include_cloud_models:
            return
        if self._can_expand_cloud_catalog(envelope, explicit_selection=True):
            return
        raise PermissionError(
            "Cloud model catalog expansion requires Orchestrator.RemoteInference permission"
        )

    def _can_expand_cloud_catalog(
        self, envelope: Envelope | None, *, explicit_selection: bool
    ) -> bool:
        """Return whether a request may trigger live cloud model catalog fetching."""

        if not explicit_selection:
            return False
        if envelope is None:
            return True
        identity_source = getattr(envelope, "identity_source", None)
        origin = getattr(envelope, "origin", "internal")
        externalish = origin == "external" or identity_source in {
            "gateway_http",
            "webrtc_rpc",
            "mesh_peer",
            "remote_peer",
            "token",
        }
        if not externalish:
            return True
        effective = set(getattr(envelope, "effective_perms", None) or [])
        return bool(effective.intersection(_REMOTE_INFERENCE_PERMS))

    async def _validated_advertised_inference_provider(
        self,
        *,
        provider_id: str | None,
        model_id: str | None,
        include_cloud_models: bool,
        provider_field: str,
        model_field: str,
    ) -> tuple[ModelRuntimeProviderInfo, str | None]:
        catalog = await self._build_model_runtime_catalog(
            include_unavailable=True,
            include_operations=False,
            include_remote=False,
            include_cloud_models=include_cloud_models,
        )
        return self._validate_advertised_provider_from_catalog(
            catalog=catalog,
            provider_id=provider_id,
            model_id=model_id,
            provider_field=provider_field,
            model_field=model_field,
        )

    def _validate_advertised_provider_from_catalog(
        self,
        *,
        catalog: ModelRuntimeCatalogResponse,
        provider_id: str | None,
        model_id: str | None,
        provider_field: str,
        model_field: str,
    ) -> tuple[ModelRuntimeProviderInfo, str | None]:
        """Validate provider/model labels against an already-built catalog."""

        requested_provider_id = provider_id or catalog.selected_provider_id
        provider = _catalog_provider_by_id(catalog, requested_provider_id)
        if provider is None:
            raise ValueError(
                f"{provider_field} {requested_provider_id!r} is not advertised by this orchestrator runtime"
            )

        selected_model_id = model_id or _default_model_id_for_provider(provider)
        if selected_model_id is not None and not _provider_advertises_model(
            provider, selected_model_id
        ):
            raise ValueError(
                f"{model_field} {selected_model_id!r} is not advertised for provider "
                f"{provider.provider_id!r}"
            )
        return provider, selected_model_id

    def _inference_selection_policy_metadata(
        self,
        catalog: ModelRuntimeCatalogResponse,
        provider: ModelRuntimeProviderInfo,
        selected_model_id: str | None,
    ) -> dict[str, Any]:
        """Describe whether a validated selection can move data or spend quota."""

        selected_provider = _catalog_provider_by_id(catalog, catalog.selected_provider_id)
        selected_default_model_id = (
            _default_model_id_for_provider(selected_provider) if selected_provider else None
        )
        provider_is_cloud = (
            provider.provider_kind == "cloud"
            or provider.provider_type == "cloud"
            or provider.upstream_provider_type in {"openai", "huggingface_endpoint"}
        )
        selection_is_default = (
            provider.provider_id == catalog.selected_provider_id
            and selected_model_id == selected_default_model_id
        )
        return {
            "inference_provider_is_cloud": provider_is_cloud,
            "inference_selection_is_default": selection_is_default,
            "inference_selected_provider_id": catalog.selected_provider_id,
            "inference_selected_model_id": selected_model_id,
            "inference_provider_label": provider.display_name,
        }

    async def _inference_llm(self, data: OrchestratorInferChatRequest | None = None) -> Any:
        """Return a target-owned chat LLM for an advertised inference request."""
        chatbot_module = importlib.import_module("app.services.orchestrator.agents.chatbot")
        selected_provider_id = None
        configured_model_id = None
        try:
            services_config = await ConfigAPI().aget_config("services", timeout=15.0)
            llm_config = (services_config.get("orchestrator", {}) or {}).get("llm", {}) or {}
            selected_provider_id = str(llm_config.get("provider") or "openai")
            configured_model_id = _selected_llm_model(llm_config, selected_provider_id)
        except Exception:
            selected_provider_id = None
        if (
            data is None
            or not data.provider_id
            or (data.provider_id == selected_provider_id and data.model_id == configured_model_id)
        ):
            if not getattr(chatbot_module, "_llm_initialized", False):
                await chatbot_module._initialize_llm()
            llm = getattr(chatbot_module, "llm", None)
            if llm is None:
                raise RuntimeError("local orchestrator LLM is not initialized")
            return llm
        return await self._configured_provider_inference_llm(data.provider_id, data.model_id)

    async def _configured_provider_inference_llm(
        self, provider_id: str, model_id: str | None
    ) -> Any:
        """Instantiate an advertised provider/model using configured options only."""
        return await configured_provider_inference_llm(provider_id, model_id)

    def _infer_prompt_messages(self, data: OrchestratorInferChatRequest) -> list[dict[str, Any]]:
        """Convert contract chat messages to provider-neutral message dicts."""
        return [
            {
                key: value
                for key, value in message.model_dump(mode="json").items()
                if value not in (None, [], {})
            }
            for message in data.messages
        ]

    async def _bound_inference_llm(self, data: OrchestratorInferChatRequest) -> Any:
        """Bind caller-provided tool schemas only; never execute local tools."""
        llm = await self._inference_llm(data)
        if data.tools and hasattr(llm, "bind_tools"):
            return llm.bind_tools(data.tools, tool_choice=data.tool_choice)
        return llm

    async def _invoke_inference_llm(self, data: OrchestratorInferChatRequest) -> Any:
        """Invoke the configured chat model without applying caller params."""
        llm = await self._bound_inference_llm(data)
        messages = self._infer_prompt_messages(data)
        if hasattr(llm, "ainvoke"):
            maybe_response = llm.ainvoke(messages)
            if hasattr(maybe_response, "__await__"):
                return await maybe_response
            return maybe_response
        if hasattr(llm, "invoke"):
            return await asyncio.to_thread(llm.invoke, messages)
        raise RuntimeError("configured LLM does not support invoke")

    async def _stream_inference_llm(
        self, data: OrchestratorInferChatRequest
    ) -> AsyncIterator[OrchestratorInferChatChunk]:
        """Stream the configured chat model and normalize chunks."""
        llm = await self._bound_inference_llm(data)
        messages = self._infer_prompt_messages(data)
        sequence = 0
        cumulative = ""
        if hasattr(llm, "astream"):
            async for raw_chunk in llm.astream(messages):
                delta = self._message_text(raw_chunk)
                cumulative += delta
                yield OrchestratorInferChatChunk(
                    delta=delta,
                    text=cumulative,
                    sequence=sequence,
                    is_final=False,
                    model_id=data.model_id,
                    provider_id=data.provider_id,
                    correlation_id=data.correlation_id,
                    session_id=data.session_id,
                    request_id=data.request_id,
                    tool_call_chunks=self._message_tool_call_chunks(raw_chunk),
                    metadata={
                        "caller_params_ignored": bool(data.params),
                        **data.metadata,
                    },
                )
                sequence += 1
            yield OrchestratorInferChatChunk(
                delta="",
                text=cumulative,
                sequence=sequence,
                is_final=True,
                model_id=data.model_id,
                provider_id=data.provider_id,
                finish_reason="stop",
                correlation_id=data.correlation_id,
                session_id=data.session_id,
                request_id=data.request_id,
                metadata={"caller_params_ignored": bool(data.params), **data.metadata},
            )
            return

        response = await self._invoke_inference_llm(data)
        text = self._message_text(response)
        yield OrchestratorInferChatChunk(
            delta=text,
            text=text,
            sequence=0,
            is_final=True,
            model_id=data.model_id,
            provider_id=data.provider_id,
            finish_reason="stop",
            correlation_id=data.correlation_id,
            session_id=data.session_id,
            request_id=data.request_id,
            tool_call_chunks=self._message_tool_call_chunks(response),
            metadata={"caller_params_ignored": bool(data.params), **data.metadata},
        )

    def _infer_response_from_message(
        self, data: OrchestratorInferChatRequest, message: Any
    ) -> OrchestratorInferChatResponse:
        """Build a contract response from a LangChain-style message."""
        text = self._message_text(message)
        return OrchestratorInferChatResponse(
            text=text,
            message=OrchestratorChatMessage(
                role="assistant",
                content=text,
                tool_calls=self._message_tool_calls(message),
                metadata=self._message_metadata(message),
            ),
            model_id=data.model_id,
            provider_id=data.provider_id,
            finish_reason=self._finish_reason(message),
            correlation_id=data.correlation_id,
            session_id=data.session_id,
            request_id=data.request_id,
            metadata={"caller_params_ignored": bool(data.params), **data.metadata},
        )

    @staticmethod
    def _message_text(message: Any) -> str:
        content = getattr(message, "content", None)
        if isinstance(content, str):
            return content
        if isinstance(message, dict):
            return str(message.get("content") or message.get("text") or message.get("delta") or "")
        if content is None:
            return "" if message is None else str(message)
        return str(content)

    @staticmethod
    def _message_tool_calls(message: Any) -> list[dict[str, Any]]:
        calls = getattr(message, "tool_calls", None)
        if isinstance(calls, list):
            return [
                dict(call) if isinstance(call, dict) else {"value": str(call)} for call in calls
            ]
        if isinstance(message, dict) and isinstance(message.get("tool_calls"), list):
            return list(message["tool_calls"])
        return []

    @staticmethod
    def _message_tool_call_chunks(message: Any) -> list[dict[str, Any]]:
        chunks = getattr(message, "tool_call_chunks", None)
        if isinstance(chunks, list):
            return [
                dict(chunk) if isinstance(chunk, dict) else {"value": str(chunk)}
                for chunk in chunks
            ]
        if isinstance(message, dict) and isinstance(message.get("tool_call_chunks"), list):
            return list(message["tool_call_chunks"])
        return []

    @staticmethod
    def _message_metadata(message: Any) -> dict[str, Any]:
        metadata = getattr(message, "response_metadata", None)
        return dict(metadata) if isinstance(metadata, dict) else {}

    @staticmethod
    def _finish_reason(message: Any) -> str | None:
        metadata = getattr(message, "response_metadata", None)
        if isinstance(metadata, dict):
            reason = metadata.get("finish_reason")
            return str(reason) if reason is not None else None
        if isinstance(message, dict):
            reason = message.get("finish_reason")
            return str(reason) if reason is not None else None
        return None

    async def _build_model_runtime_catalog(
        self,
        *,
        include_unavailable: bool = True,
        include_operations: bool = True,
        include_remote: bool = False,
        include_cloud_models: bool = False,
        mesh_selector: Any = None,
    ) -> ModelRuntimeCatalogResponse:
        """Build a redacted model provider catalog from current configuration."""
        services_config = await ConfigAPI().aget_config("services", timeout=15.0)
        orchestrator_config = services_config.get("orchestrator", {})
        llm_config = orchestrator_config.get("llm", {})
        selected_provider = str(llm_config.get("provider") or "openai")
        cloud_model_catalog: dict[str, dict[str, Any]] = {}
        if include_cloud_models:
            openai_options = ((llm_config.get("third_party") or {}).get("openai") or {}).get(
                "options"
            ) or {}
            openai_catalog = await _fetch_openai_model_catalog(
                api_key=openai_options.get("api_key"),
                cache=self._model_catalog_cache,
            )
            cloud_model_catalog["openai"] = openai_catalog
        providers = _configured_model_providers(
            llm_config=llm_config,
            hardware_acceleration=bool(orchestrator_config.get("hardware_acceleration", False)),
            selected_provider=selected_provider,
            operations=self._model_runtime_operations if include_operations else {},
            cloud_model_catalog=cloud_model_catalog,
        )
        if include_remote and mesh_selector is not None and self.bus is not None:
            remote_result = await self.bus.request(
                OrchestratorMethods.GET_MODEL_CATALOG,
                ModelRuntimeCatalogRequest(
                    include_unavailable=include_unavailable,
                    include_operations=include_operations,
                    include_remote=False,
                    include_cloud_models=include_cloud_models,
                    dispatch_selector=mesh_selector,
                ),
                priority=get_interactive_priority(),
                timeout=15.0,
                origin="internal",
            )
            if remote_result.ok:
                remote_catalog = (
                    remote_result.data
                    if isinstance(remote_result.data, ModelRuntimeCatalogResponse)
                    else ModelRuntimeCatalogResponse.model_validate(remote_result.data)
                )
                providers.extend(
                    _remote_model_providers(
                        remote_catalog.providers,
                        peer_id=_remote_peer_id_from_selector(mesh_selector),
                    )
                )
            else:
                log_debug(f"Remote model runtime catalog request failed: {remote_result.error}")
        elif include_remote:
            log_debug(
                "Remote model runtime catalog requested without a mesh selector; "
                "returning local catalog only"
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

    def _context_item_size(self, item: AttachmentContextItem) -> int:
        if item.size_bytes is not None:
            return max(0, item.size_bytes)
        text = self._context_item_text(item)
        return len(text.encode("utf-8"))

    def _context_item_text(self, item: AttachmentContextItem) -> str:
        if item.content_text:
            return item.content_text
        if item.kind == "url" and item.url:
            return f"{item.title or item.url}\n{item.url}"
        return ""

    def _sanitize_context_text(self, text: str, *, max_chars: int) -> tuple[str, list[str]]:
        reasons: list[str] = []
        sanitized = text[:max_chars]
        if len(text) > max_chars:
            reasons.append("truncated")
        for pattern, reason in _SECRET_PATTERNS:
            sanitized, count = pattern.subn("[REDACTED]", sanitized)
            if count:
                reasons.append(reason)
        uri_reasons: list[str] = []

        def sanitize_uri_match(match: re.Match[str]) -> str:
            sanitized_uri, match_reasons = self._sanitize_context_uri(match.group(0))
            uri_reasons.extend(f"embedded_{reason}" for reason in match_reasons)
            return sanitized_uri or "[REDACTED]"

        sanitized = _URI_IN_TEXT_PATTERN.sub(sanitize_uri_match, sanitized)
        reasons.extend(uri_reasons)
        return sanitized, sorted(set(reasons))

    def _sanitize_context_scalar(self, value: str | None) -> tuple[str | None, list[str]]:
        if value is None:
            return None, []
        sanitized, reasons = self._sanitize_context_text(value, max_chars=len(value))
        return sanitized, reasons

    def _sanitize_context_uri(self, uri: str | None) -> tuple[str | None, list[str]]:
        if not uri:
            return uri, []

        reasons: list[str] = []
        parsed = urlsplit(uri)
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            netloc = parsed.hostname or ""
            if parsed.port is not None:
                netloc = f"{netloc}:{parsed.port}"
            origin = urlunsplit((parsed.scheme, netloc, "", "", ""))
            if parsed.username or parsed.password:
                reasons.append("uri_credentials")
            if parsed.query:
                reasons.append("uri_query")
            if parsed.fragment:
                reasons.append("uri_fragment")
            path_reasons = self._sanitize_context_text(
                parsed.path,
                max_chars=len(parsed.path),
            )[1]
            if path_reasons:
                reasons.extend(f"uri_{reason}" for reason in path_reasons)
            if reasons:
                return f"{origin}/[REDACTED]", sorted(set(reasons))
            return urlunsplit((parsed.scheme, netloc, parsed.path, "", "")), []

        if parsed.scheme == "file" or uri.startswith(("/", "~")) or "\\" in uri:
            return "[REDACTED_PATH]", ["local_path"]

        if parsed.scheme:
            return f"{parsed.scheme}://[REDACTED]", ["uri_provenance"]

        sanitized, scalar_reasons = self._sanitize_context_scalar(uri)
        return sanitized, scalar_reasons

    def _sanitize_context_metadata(self, value: Any) -> tuple[Any, list[str]]:
        reasons: list[str] = []
        if isinstance(value, dict):
            sanitized: dict[str, Any] = {}
            for raw_key, raw_value in value.items():
                key = str(raw_key)
                if _SENSITIVE_METADATA_KEY_PATTERN.search(key):
                    reasons.append("metadata_key")
                    continue
                sanitized_value, value_reasons = self._sanitize_context_metadata(raw_value)
                reasons.extend(value_reasons)
                sanitized[key] = sanitized_value
            return sanitized, sorted(set(reasons))
        if isinstance(value, list):
            sanitized_items: list[Any] = []
            for item in value:
                sanitized_item, item_reasons = self._sanitize_context_metadata(item)
                reasons.extend(item_reasons)
                sanitized_items.append(sanitized_item)
            return sanitized_items, sorted(set(reasons))
        if isinstance(value, str):
            if "://" in value or value.startswith(("/", "~")) or "\\" in value:
                sanitized_uri, uri_reasons = self._sanitize_context_uri(value)
                return sanitized_uri, uri_reasons
            sanitized_scalar, scalar_reasons = self._sanitize_context_scalar(value)
            return sanitized_scalar, scalar_reasons
        return value, []

    def _context_rag_value(
        self,
        *,
        data: AttachmentContextIngestRequest,
        item: AttachmentContextItem,
        text: str,
        redacted: bool,
        redaction_reasons: list[str],
        correlation_id: str,
    ) -> tuple[dict[str, Any], list[str]]:
        storage_reasons: list[str] = []
        title, title_reasons = self._sanitize_context_scalar(item.title)
        filename, filename_reasons = self._sanitize_context_uri(item.filename)
        url, url_reasons = self._sanitize_context_uri(item.url)
        source, source_reasons = self._sanitize_context_metadata(
            item.source.model_dump(exclude_none=True)
        )
        metadata, metadata_reasons = self._sanitize_context_metadata(item.metadata)
        storage_reasons.extend(f"title_{reason}" for reason in title_reasons)
        storage_reasons.extend(f"filename_{reason}" for reason in filename_reasons)
        storage_reasons.extend(f"url_{reason}" for reason in url_reasons)
        storage_reasons.extend(f"source_{reason}" for reason in source_reasons)
        storage_reasons.extend(f"metadata_{reason}" for reason in metadata_reasons)
        final_reasons = sorted(set(redaction_reasons + storage_reasons))
        value = {
            "text": text,
            "kind": item.kind,
            "title": title,
            "filename": filename,
            "url": url,
            "mime_type": item.mime_type,
            "privacy_class": data.privacy_class,
            "source": source,
            "metadata": metadata,
            "redacted": redacted or bool(storage_reasons),
            "redaction_reasons": final_reasons,
            "policy_decision_id": data.policy_decision_id,
            "correlation_id": correlation_id,
            "schema_version": "assistant-context.v1",
        }
        return value, final_reasons

    def _context_result(
        self,
        *,
        item: AttachmentContextItem,
        index: int,
        status: AttachmentContextStatus,
        storage_policy: AttachmentContextStoragePolicy,
        privacy_class: AttachmentContextPrivacyClass,
        accepted_bytes: int = 0,
        redacted: bool = False,
        redaction_reasons: list[str] | None = None,
        reason_code: str | None = None,
        message: str = "",
    ) -> AttachmentContextItemResult:
        return AttachmentContextItemResult(
            item_id=f"context-{index}-{uuid4().hex[:12]}",
            kind=item.kind,
            status=status,
            storage_policy=storage_policy,
            privacy_class=privacy_class,
            accepted_bytes=accepted_bytes,
            redacted=redacted,
            redaction_reasons=redaction_reasons or [],
            reason_code=reason_code,
            message=message,
        )

    def _context_response(
        self,
        *,
        data: AttachmentContextIngestRequest,
        accepted_items: list[AttachmentContextItemResult],
        rejected_items: list[AttachmentContextItemResult],
        total_bytes: int,
        correlation_id: str,
    ) -> AttachmentContextIngestResponse:
        return AttachmentContextIngestResponse(
            accepted=bool(accepted_items),
            rejected=bool(rejected_items),
            total_items=len(data.items),
            accepted_items=accepted_items,
            rejected_items=rejected_items,
            total_bytes=total_bytes,
            storage_policy=data.storage_policy,
            privacy_class=data.privacy_class,
            correlation_id=correlation_id,
            secrets_redacted=True,
        )

    async def _store_context_in_rag(
        self,
        *,
        data: AttachmentContextIngestRequest,
        item: AttachmentContextItem,
        item_id: str,
        text: str,
        redacted: bool,
        redaction_reasons: list[str],
        correlation_id: str,
    ) -> tuple[str, list[str]]:
        stored_key = item_id
        value, final_redaction_reasons = self._context_rag_value(
            data=data,
            item=item,
            text=text,
            redacted=redacted,
            redaction_reasons=redaction_reasons,
            correlation_id=correlation_id,
        )
        await self.bus.request(
            DBMethods.RAG_STORE,
            DBRAGStoreRequest(
                key=stored_key,
                value=json.dumps(value, sort_keys=True),
                namespace=data.namespace,
            ),
            timeout=10.0,
            origin="internal",
            principal_id=data.caller_principal_id,
            correlation_id=correlation_id,
        )
        return stored_key, final_redaction_reasons

    async def _audit_context_ingestion(
        self,
        data: AttachmentContextIngestRequest,
        response: AttachmentContextIngestResponse,
    ) -> None:
        details = {
            "session_id": data.session_id,
            "namespace": data.namespace,
            "storage_policy": data.storage_policy,
            "privacy_class": data.privacy_class,
            "policy_decision_id": data.policy_decision_id,
            "correlation_id": response.correlation_id,
            "total_items": response.total_items,
            "accepted_count": len(response.accepted_items),
            "rejected_count": len(response.rejected_items),
            "total_bytes": response.total_bytes,
            "redacted_count": sum(1 for item in response.accepted_items if item.redacted),
            "rejection_codes": [
                item.reason_code for item in response.rejected_items if item.reason_code
            ],
        }
        try:
            await self.bus.request(
                AuthMethods.STORE_AUDIT_EVENT,
                StoreAuditEventRequest(
                    event=response.audit_event,
                    principal_id=data.caller_principal_id,
                    details=json.dumps(details, sort_keys=True),
                ),
                timeout=5.0,
                origin="internal",
                principal_id=data.caller_principal_id,
                correlation_id=response.correlation_id,
            )
        except Exception as e:
            log_error(f"Failed to audit context ingestion: {e}", exc_info=True)


def _utc_now() -> str:
    return datetime.utcnow().isoformat()


def _dedupe_scopes(
    scopes: list[OrchestratorInterruptScope],
) -> list[OrchestratorInterruptScope]:
    seen: set[str] = set()
    deduped: list[OrchestratorInterruptScope] = []
    for scope in scopes:
        if scope in seen:
            continue
        seen.add(scope)
        deduped.append(scope)
    return deduped


def _interrupt_status(results: list[OrchestratorInterruptScopeResult]) -> str:
    if not results:
        return "no_op"
    if any(result.status == "failed" for result in results):
        return "partial" if any(result.status == "cancelled" for result in results) else "failed"
    if any(result.status == "cancelled" for result in results):
        return "interrupted"
    if all(result.status == "no_active_work" for result in results):
        return "no_active_work"
    return "not_supported"


def _catalog_provider_by_id(
    catalog: ModelRuntimeCatalogResponse, provider_id: str | None
) -> ModelRuntimeProviderInfo | None:
    """Return a provider from a runtime catalog by id."""

    if not provider_id:
        return None
    return next(
        (provider for provider in catalog.providers if provider.provider_id == provider_id),
        None,
    )


def _default_model_id_for_provider(provider: ModelRuntimeProviderInfo) -> str | None:
    """Return the configured/default model id advertised for a provider."""

    if provider.model_id:
        return provider.model_id
    if provider.default_model_id:
        return provider.default_model_id
    default_model = next((model for model in provider.models if model.default), None)
    if default_model is not None:
        return default_model.model_id
    if provider.models:
        return provider.models[0].model_id
    return None


def _provider_advertises_model(provider: ModelRuntimeProviderInfo, model_id: str) -> bool:
    """Return whether a model id is present in provider catalog/config fields."""

    advertised = {value for value in (provider.model_id, provider.default_model_id) if value}
    advertised.update(model.model_id for model in provider.models)
    return model_id in advertised


def _configured_model_providers(
    *,
    llm_config: dict[str, Any],
    hardware_acceleration: bool,
    selected_provider: str,
    operations: dict[str, ModelRuntimeOperationResponse],
    cloud_model_catalog: dict[str, dict[str, Any]] | None = None,
) -> list[ModelRuntimeProviderInfo]:
    third_party = llm_config.get("third_party") or {}
    local = llm_config.get("local") or {}
    openai_options = (third_party.get("openai") or {}).get("options") or {}
    hf_endpoint_options = (third_party.get("huggingface_endpoint") or {}).get("options") or {}
    hf_pipeline_options = (local.get("huggingface_pipeline") or {}).get("options") or {}
    llama_options = (local.get("llama_cpp") or {}).get("options") or {}

    cloud_model_catalog = cloud_model_catalog or {}
    openai_models, openai_catalog_metadata = _provider_models_with_catalog(
        provider_id="openai",
        provider_kind="cloud",
        upstream_provider_type="openai",
        default_model_id=openai_options.get("model"),
        configured_source="provider-managed",
        capabilities=["chat", "tool_calling"],
        fetched_catalog=cloud_model_catalog.get("openai"),
    )
    hf_endpoint_models, hf_endpoint_catalog_metadata = _provider_models_with_catalog(
        provider_id="huggingface_endpoint",
        provider_kind="cloud",
        upstream_provider_type="huggingface_endpoint",
        default_model_id=hf_endpoint_options.get("model"),
        configured_source=hf_endpoint_options.get("endpoint_url") or "provider-managed",
        capabilities=["chat"],
        fetched_catalog=None,
    )
    hf_pipeline_models, hf_pipeline_catalog_metadata = _provider_models_with_catalog(
        provider_id="huggingface_pipeline",
        provider_kind="local",
        upstream_provider_type="huggingface_pipeline",
        default_model_id=hf_pipeline_options.get("model"),
        configured_source="huggingface_hub",
        capabilities=["chat", "local_execution"],
        fetched_catalog=None,
    )
    llama_model_id = _display_model_id(llama_options.get("model_path"))
    llama_models, llama_catalog_metadata = _provider_models_with_catalog(
        provider_id="llama_cpp",
        provider_kind="local",
        upstream_provider_type="llama_cpp",
        default_model_id=llama_model_id,
        configured_source="local_file",
        capabilities=["chat", "local_execution", "gguf"],
        context_window=llama_options.get("n_ctx"),
        generation_limit=llama_options.get("max_tokens"),
        fetched_catalog=None,
    )

    return [
        _provider_info(
            provider_id="openai",
            display_name="OpenAI",
            backend_kind="openai_chat",
            provider_type="cloud",
            provider_kind="cloud",
            upstream_provider_type="openai",
            selected_provider=selected_provider,
            model_id=openai_options.get("model"),
            default_model_id=openai_options.get("model"),
            source="provider-managed",
            license_name="provider_terms",
            context_window=None,
            generation_limit=openai_options.get("max_tokens"),
            hardware={},
            models=openai_models,
            model_catalog=openai_catalog_metadata,
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
            provider_kind="cloud",
            upstream_provider_type="huggingface_endpoint",
            selected_provider=selected_provider,
            model_id=hf_endpoint_options.get("model"),
            default_model_id=hf_endpoint_options.get("model"),
            source=hf_endpoint_options.get("endpoint_url") or "provider-managed",
            license_name="model_card",
            context_window=None,
            generation_limit=hf_endpoint_options.get("max_tokens"),
            hardware={},
            models=hf_endpoint_models,
            model_catalog=hf_endpoint_catalog_metadata,
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
            provider_kind="local",
            upstream_provider_type="huggingface_pipeline",
            selected_provider=selected_provider,
            model_id=hf_pipeline_options.get("model"),
            default_model_id=hf_pipeline_options.get("model"),
            source="huggingface_hub",
            license_name="model_card",
            context_window=None,
            generation_limit=hf_pipeline_options.get("max_tokens"),
            hardware={
                "device": hf_pipeline_options.get("device") or "auto",
                "torch_dtype": hf_pipeline_options.get("torch_dtype") or "auto",
                "hardware_acceleration": hardware_acceleration,
            },
            models=hf_pipeline_models,
            model_catalog=hf_pipeline_catalog_metadata,
            capabilities=["chat", "local_execution"],
            health="available" if hf_pipeline_options.get("model") else "misconfigured",
            health_reason=None if hf_pipeline_options.get("model") else "model is not configured",
            operations=operations,
        ),
        _provider_info(
            provider_id="llama_cpp",
            display_name="llama.cpp",
            backend_kind="llama_cpp",
            provider_type="local",
            provider_kind="local",
            upstream_provider_type="llama_cpp",
            selected_provider=selected_provider,
            model_id=llama_model_id,
            default_model_id=llama_model_id,
            source="local_file",
            license_name="user_supplied",
            context_window=llama_options.get("n_ctx"),
            generation_limit=llama_options.get("max_tokens"),
            hardware={
                "n_gpu_layers": llama_options.get("n_gpu_layers", 0),
                "n_batch": llama_options.get("n_batch"),
                "hardware_acceleration": hardware_acceleration,
            },
            models=llama_models,
            model_catalog=llama_catalog_metadata,
            model_files=_model_files(llama_options.get("model_path")),
            capabilities=["chat", "local_execution", "gguf"],
            health=_file_health(llama_options.get("model_path")),
            health_reason=_file_health_reason(llama_options.get("model_path")),
            operations=operations,
        ),
    ]


def _selected_llm_model(llm_config: dict[str, Any], provider: str) -> str | None:
    """Read the configured model identifier for a selected LLM provider."""
    third_party = llm_config.get("third_party") or {}
    local = llm_config.get("local") or {}
    if provider == "openai":
        return ((third_party.get("openai") or {}).get("options") or {}).get("model")
    if provider == "huggingface_endpoint":
        return ((third_party.get("huggingface_endpoint") or {}).get("options") or {}).get("model")
    if provider == "huggingface_pipeline":
        return ((local.get("huggingface_pipeline") or {}).get("options") or {}).get("model")
    if provider == "llama_cpp":
        return _display_model_id(
            ((local.get("llama_cpp") or {}).get("options") or {}).get("model_path")
        )
    return None


def _provider_models_with_catalog(
    *,
    provider_id: str,
    provider_kind: str,
    upstream_provider_type: str,
    default_model_id: Any,
    configured_source: str | None,
    capabilities: list[str],
    fetched_catalog: dict[str, Any] | None,
    context_window: Any = None,
    generation_limit: Any = None,
) -> tuple[list[ModelRuntimeModelInfo], dict[str, Any]]:
    """Build model entries plus redacted catalog metadata for one provider."""

    default_model = str(default_model_id) if default_model_id else None
    catalog = fetched_catalog or {}
    model_entries: list[ModelRuntimeModelInfo] = []
    seen: set[str] = set()

    for raw_model in catalog.get("models") or []:
        if isinstance(raw_model, ModelRuntimeModelInfo):
            model = raw_model
        elif isinstance(raw_model, dict):
            raw_model_id = raw_model.get("model_id") or raw_model.get("id")
            if not raw_model_id:
                continue
            model = ModelRuntimeModelInfo(
                model_id=str(raw_model_id),
                display_name=raw_model.get("display_name") or str(raw_model_id),
                provider_id=provider_id,
                provider_kind=provider_kind,
                upstream_provider_type=upstream_provider_type,
                source=_redacted_source(raw_model.get("source") or configured_source),
                context_window=raw_model.get("context_window")
                if isinstance(raw_model.get("context_window"), int)
                else None,
                generation_limit=raw_model.get("generation_limit")
                if isinstance(raw_model.get("generation_limit"), int)
                else None,
                capabilities=list(raw_model.get("capabilities") or capabilities),
                default=str(raw_model_id) == default_model,
                available=raw_model.get("available", True),
                metadata=_redact_metadata(raw_model.get("metadata") or {}),
                secrets_redacted=True,
            )
        else:
            continue
        if model.model_id in seen:
            continue
        seen.add(model.model_id)
        model_entries.append(model)

    if default_model and default_model not in seen:
        model_entries.insert(
            0,
            ModelRuntimeModelInfo(
                model_id=default_model,
                display_name=default_model,
                provider_id=provider_id,
                provider_kind=provider_kind,
                upstream_provider_type=upstream_provider_type,
                source=_redacted_source(configured_source),
                context_window=context_window if isinstance(context_window, int) else None,
                generation_limit=generation_limit if isinstance(generation_limit, int) else None,
                capabilities=capabilities,
                default=True,
                available=True,
                metadata={"configured": True},
                secrets_redacted=True,
            ),
        )

    for model in model_entries:
        model.default = model.model_id == default_model

    metadata = {
        "source": catalog.get("source") or "configured",
        "status": catalog.get("status") or ("available" if model_entries else "not_configured"),
        "fetched_at": catalog.get("fetched_at"),
        "cache_hit": bool(catalog.get("cache_hit", False)),
        "count": len(model_entries),
        "secrets_redacted": True,
    }
    if catalog.get("reason"):
        metadata["reason"] = catalog.get("reason")
    if catalog.get("error"):
        metadata["error"] = _redact_text(str(catalog.get("error")))
    return model_entries, metadata


async def _fetch_openai_model_catalog(
    *,
    api_key: Any,
    cache: dict[str, dict[str, Any]],
    ttl_seconds: float = 300.0,
    client_factory: Any = None,
) -> dict[str, Any]:
    """Fetch OpenAI model ids with a small in-process cache.

    The helper is intentionally injectable/patchable so unit tests never need a
    real API key or network call.
    """

    if not api_key:
        return {
            "source": "openai_api",
            "status": "skipped",
            "reason": "api_key is not configured",
            "models": [],
            "fetched_at": None,
            "secrets_redacted": True,
        }

    now = time.time()
    cache_key = "openai.models"
    cached = cache.get(cache_key)
    if cached and float(cached.get("expires_at", 0.0)) > now:
        payload = dict(cached.get("payload") or {})
        payload["cache_hit"] = True
        return payload

    try:
        if client_factory is None:
            from openai import AsyncOpenAI  # type: ignore

            client_factory = AsyncOpenAI
        client = client_factory(api_key=str(api_key))
        response = client.models.list()
        if hasattr(response, "__await__"):
            response = await response
        raw_models = getattr(response, "data", response)
        if isinstance(raw_models, dict) and "data" in raw_models:
            raw_models = raw_models.get("data")
        models: list[dict[str, Any]] = []
        for raw_model in raw_models or []:
            model_id = getattr(raw_model, "id", None)
            if model_id is None and isinstance(raw_model, dict):
                model_id = raw_model.get("id") or raw_model.get("model_id")
            if not model_id:
                continue
            model_id_text = str(model_id)
            if not _is_openai_chat_model_id(model_id_text):
                continue
            metadata: dict[str, Any] = {}
            owned_by = getattr(raw_model, "owned_by", None)
            created = getattr(raw_model, "created", None)
            if isinstance(raw_model, dict):
                owned_by = raw_model.get("owned_by", owned_by)
                created = raw_model.get("created", created)
            if owned_by:
                metadata["owned_by"] = owned_by
            if created:
                metadata["created"] = created
            models.append(
                {
                    "model_id": str(model_id),
                    "display_name": model_id_text,
                    "source": "provider-managed",
                    "available": True,
                    "metadata": metadata,
                    "capabilities": ["chat"],
                }
            )
        payload = {
            "source": "openai_api",
            "status": "available",
            "models": sorted(models, key=lambda item: item["model_id"]),
            "fetched_at": _utc_now(),
            "secrets_redacted": True,
        }
        cache[cache_key] = {"expires_at": now + ttl_seconds, "payload": payload}
        return payload
    except Exception as exc:  # pragma: no cover - exact SDK failures vary
        payload = {
            "source": "openai_api",
            "status": "unavailable",
            "error": _redact_text(str(exc)),
            "models": [],
            "fetched_at": _utc_now(),
            "secrets_redacted": True,
        }
        cache[cache_key] = {"expires_at": now + min(ttl_seconds, 30.0), "payload": payload}
        return payload


def _is_openai_chat_model_id(model_id: str) -> bool:
    """Best-effort filter for OpenAI models usable through chat interfaces."""

    normalized = model_id.lower()
    if any(marker in normalized for marker in _OPENAI_NON_CHAT_MODEL_MARKERS):
        return False
    return normalized.startswith(_OPENAI_CHAT_MODEL_PREFIXES)


def _provider_display_name(provider: str) -> str:
    """Return a production-facing display name for a configured provider id."""
    return {
        "openai": "OpenAI",
        "huggingface_endpoint": "HuggingFace Endpoint",
        "huggingface_pipeline": "HuggingFace Pipeline",
        "llama_cpp": "llama.cpp",
    }.get(provider, provider)


def _provider_info(
    *,
    provider_id: str,
    display_name: str,
    backend_kind: str,
    provider_type: str,
    provider_kind: str | None,
    upstream_provider_type: str | None,
    selected_provider: str,
    model_id: str | None,
    default_model_id: str | None,
    source: str | None,
    license_name: str | None,
    context_window: int | None,
    generation_limit: int | None,
    hardware: dict[str, Any],
    models: list[ModelRuntimeModelInfo],
    model_catalog: dict[str, Any],
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
        provider_kind=provider_kind,
        upstream_provider_type=upstream_provider_type,
        provider_peer_id="local",
        provider_service_instance_id="local:Orchestrator",
        enabled=True,
        selected=provider_id == selected_provider,
        health=health,
        health_reason=health_reason,
        model_id=model_id,
        default_model_id=default_model_id,
        source=_redacted_source(source),
        license=license_name,
        context_window=context_window if isinstance(context_window, int) else None,
        generation_limit=generation_limit if isinstance(generation_limit, int) else None,
        hardware=hardware,
        models=models,
        model_catalog=model_catalog,
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
        "local": [
            provider.provider_id for provider in providers if provider.provider_type == "local"
        ],
        "cloud": [
            provider.provider_id for provider in providers if provider.provider_type == "cloud"
        ],
        "remote": [
            provider.provider_id for provider in providers if provider.provider_type == "remote"
        ],
        "selected": [provider.provider_id for provider in providers if provider.selected],
    }


def _remote_peer_id_from_selector(mesh_selector: Any) -> str:
    """Normalize a peer id from explicit remote catalog selector fields."""

    for attr in ("peer_id", "provider_id", "service_instance_id"):
        value = getattr(mesh_selector, attr, None)
        if value:
            parsed = _parse_remote_peer_id(str(value))
            if parsed:
                return parsed
    return "remote-peer"


def _parse_remote_peer_id(value: str) -> str | None:
    value = value.strip()
    if not value:
        return None
    parts = value.split(":")
    if len(parts) >= 3 and parts[0] == "remote" and parts[1]:
        return parts[1]
    return value


def _remote_model_providers(
    providers: list[ModelRuntimeProviderInfo],
    *,
    peer_id: str,
) -> list[ModelRuntimeProviderInfo]:
    """Return redacted provider entries representing a selected remote peer."""
    remote: list[ModelRuntimeProviderInfo] = []
    service_instance_id = f"remote:{peer_id}:Orchestrator"
    for provider in providers:
        upstream_provider_id = provider.provider_id
        remote_provider_id = f"{service_instance_id}:{upstream_provider_id}"
        models = [
            model.model_copy(
                update={
                    "provider_id": remote_provider_id,
                    "provider_kind": "remote_peer",
                    "metadata": {
                        **model.metadata,
                        "remote_provider_id": upstream_provider_id,
                        "runtime_provider_id": upstream_provider_id,
                        "remote_model_provider_id": model.provider_id,
                        "provider_peer_id": peer_id,
                        "provider_service_instance_id": service_instance_id,
                    },
                    "secrets_redacted": True,
                }
            )
            for model in provider.models
        ]
        remote.append(
            provider.model_copy(
                update={
                    "provider_id": remote_provider_id,
                    "display_name": f"{provider.display_name} ({peer_id})",
                    "provider_type": "remote",
                    "provider_kind": "remote_peer",
                    "provider_peer_id": peer_id,
                    "provider_service_instance_id": service_instance_id,
                    "selected": False,
                    "models": models,
                    "model_catalog": {
                        **provider.model_catalog,
                        "remote_provider_id": upstream_provider_id,
                        "runtime_provider_id": upstream_provider_id,
                        "provider_peer_id": peer_id,
                        "provider_service_instance_id": service_instance_id,
                    },
                    "secrets_redacted": True,
                }
            )
        )
    return remote


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


def _redact_text(value: str) -> str:
    redacted = value
    for pattern, label in _SECRET_PATTERNS:
        redacted = pattern.sub(f"[redacted:{label}]", redacted)
    redacted = _URI_IN_TEXT_PATTERN.sub(
        lambda match: _redacted_source(match.group(0)) or "", redacted
    )
    return redacted


def _redact_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in metadata.items():
        if _SENSITIVE_METADATA_KEY_PATTERN.search(str(key)):
            redacted[str(key)] = "[redacted]"
        elif isinstance(value, str):
            redacted[str(key)] = _redact_text(value)
        elif isinstance(value, (int, float, bool)) or value is None:
            redacted[str(key)] = value
        else:
            redacted[str(key)] = str(type(value).__name__)
    return redacted


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
        (
            candidate
            for candidate in reversed(operations)
            if candidate.operation_type == operation_type
        ),
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
        (
            candidate
            for candidate in reversed(operations)
            if candidate.operation_type == "benchmark"
        ),
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
