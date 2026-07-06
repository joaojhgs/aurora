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
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import (
    Envelope,
    MessageBus,
)
from app.messaging.priority_helpers import get_interactive_priority
from app.services.orchestrator.graph import GraphOrchestrator, set_orchestrator
from app.shared.config.interface import ConfigAPI
from app.shared.contracts.models.auth import AuthMethods, StoreAuditEventRequest
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.db import DBMethods, DBRAGStoreRequest
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
    ModelRuntimeOperationRequest,
    ModelRuntimeOperationResponse,
    ModelRuntimeOperationStatusRequest,
    ModelRuntimeProgressInfo,
    ModelRuntimeProviderInfo,
    ModelRuntimeRequest,
    ModelRuntimeResponse,
    OrchestratorEvents,
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
    )
    async def process_user_input(self, cmd: OrchestratorProcessRequest) -> EmptyOutput:
        """Handle UI user input command."""
        try:
            log_info(f"Processing UI input: {cmd.text}")
            await self._process_input(
                cmd.text,
                source="ui",
                session_id=cmd.session_id,
                request_id=cmd.request_id,
                correlation_id=cmd.correlation_id,
                stream=cmd.stream,
            )
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
    async def process_external_input(
        self,
        cmd: OrchestratorProcessRequest,
        envelope: Envelope | None = None,
    ) -> OrchestratorResponse:
        """Handle external user input command and return the response."""
        try:
            source = cmd.source or "external"
            log_info(f"Processing external input: {cmd.text}")
            metadata: dict[str, Any] = {"source": source, "stream": cmd.stream}
            if cmd.client_tts_playback is not None:
                metadata["client_tts_playback"] = cmd.client_tts_playback
            caller_context: dict[str, str | None] = {}
            if envelope is not None:
                caller_context = {
                    "caller_principal_id": getattr(envelope, "principal_id", None),
                    "caller_peer_id": getattr(envelope, "caller_peer_id", None),
                }
            response_text = await self._process_input(
                cmd.text,
                source=source,
                session_id=cmd.session_id,
                request_id=cmd.request_id,
                correlation_id=cmd.correlation_id,
                return_response=True,  # Return the response for external API
                response_metadata=metadata,
                stream=cmd.stream,
                **caller_context,
            )
            return OrchestratorResponse(
                text=response_text or "",
                session_id=cmd.session_id,
                request_id=cmd.request_id,
                correlation_id=cmd.correlation_id,
                metadata=metadata,
            )

        except Exception as e:
            log_error(f"Error processing external input: {e}", exc_info=True)
            return OrchestratorResponse(
                text=f"Error: {e!s}",
                session_id=cmd.session_id,
                request_id=cmd.request_id,
                correlation_id=cmd.correlation_id,
                metadata={"source": cmd.source or "external", "stream": cmd.stream, "error": True},
            )

    @method_contract(
        method_id=OrchestratorMethods.INGEST_CONTEXT,
        summary="Ingest assistant attachment and shared context metadata",
        input_model=AttachmentContextIngestRequest,
        output_model=AttachmentContextIngestResponse,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
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
                await self.bus.publish(
                    TTSMethods.STOP,
                    EmptyInput(),
                    event=False,
                    priority=get_interactive_priority(),
                    origin="internal",
                    correlation_id=getattr(envelope, "correlation_id", None),
                    principal_id=getattr(envelope, "principal_id", None),
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
            mesh=True,
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
        request_id: str | None = None,
        correlation_id: str | None = None,
        return_response: bool = False,
        response_metadata: dict[str, Any] | None = None,
        stream: bool = False,
        caller_principal_id: str | None = None,
        caller_peer_id: str | None = None,
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
        try:
            log_debug(f"Processing input from {source}: {text}")

            # Run LangGraph agent via orchestrator instance
            # DON'T use TTS internally - orchestrator handles TTS via message bus
            if self.orchestrator is None:
                raise RuntimeError("Orchestrator not initialized")

            metadata.update(await self._assistant_response_metadata())

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
                )
            else:
                response_text = await self.orchestrator.stream_graph_updates(
                    text,
                    tts_result=False,
                    thread_id=session_id or request_id or correlation_id,
                    session_id=session_id,
                    owner_principal_id=caller_principal_id,
                    owner_peer_id=caller_peer_id,
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
                    mesh=True,
                    priority=get_interactive_priority(),
                    origin="internal",
                    correlation_id=correlation_id,
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
                        mesh=True,
                        priority=get_interactive_priority(),
                        origin="internal",
                        correlation_id=correlation_id,
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
    ) -> str:
        """Publish correlated assistant stream events while graph generation runs."""

        if self.orchestrator is None:
            raise RuntimeError("Orchestrator not initialized")

        sequence = 0
        response_text = ""
        tts_stream_id: str | None = None
        tts_text_sequence = 0
        tts_buffer = ""
        should_stream_tts = source == "stt" or (
            source in {"ui", "external"} and self._ui_automatic_tts_readback
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
                        final=False,
                    )
            await self._publish_assistant_stream_event(
                event,
                sequence=sequence,
                session_id=session_id,
                request_id=request_id,
                correlation_id=correlation_id,
                metadata=metadata,
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
                correlation_id=correlation_id,
            )
        elif publish_text and publish_text != "Done.":
            await self._request_response_tts(
                text=publish_text,
                source=source,
                metadata=terminal_metadata,
                skip_tts=False,
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
        )
        return publish_text

    async def _flush_tts_stream_chunks(
        self,
        *,
        stream_id: str,
        buffer: str,
        next_sequence: int,
        correlation_id: str | None,
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
            mesh=True,
            priority=get_interactive_priority(),
            origin="internal",
            correlation_id=payload.correlation_id,
        )

    def _should_play_tts_on_server(self, source: str, metadata: dict[str, Any]) -> bool:
        """Return whether streamed TTS should use the server audio device."""
        if source == "stt":
            return True
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


def _configured_model_providers(
    *,
    llm_config: dict[str, Any],
    hardware_acceleration: bool,
    selected_provider: str,
    operations: dict[str, ModelRuntimeOperationResponse],
) -> list[ModelRuntimeProviderInfo]:
    third_party = llm_config.get("third_party") or {}
    local = llm_config.get("local") or {}
    openai_options = (third_party.get("openai") or {}).get("options") or {}
    hf_endpoint_options = (third_party.get("huggingface_endpoint") or {}).get("options") or {}
    hf_pipeline_options = (local.get("huggingface_pipeline") or {}).get("options") or {}
    llama_options = (local.get("llama_cpp") or {}).get("options") or {}

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
            health_reason=None if hf_pipeline_options.get("model") else "model is not configured",
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
        "local": [
            provider.provider_id for provider in providers if provider.provider_type == "local"
        ],
        "cloud": [
            provider.provider_id for provider in providers if provider.provider_type == "cloud"
        ],
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
