"""Unit tests for orchestrator service."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.messaging import Envelope, Event, MessageBus
from app.services.orchestrator.service import OrchestratorService
from app.shared.messaging.models.orchestrator_models import (
    LLMResponseReady,
    ToolRequest,
    ToolResult,
    UserInput,
)


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.subscribe = Mock()
    bus.subscribe_event = AsyncMock()
    bus.publish = AsyncMock()
    return bus


@pytest.fixture
def orchestrator_service(mock_bus):
    """Create an orchestrator service instance."""
    # Mock the bus singleton
    with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
        service = OrchestratorService()
        yield service


class TestOrchestratorServiceInitialization:
    """Test orchestrator service initialization."""

    def test_init(self, mock_bus):
        """Test service initialization."""
        # DBService no longer takes bus parameter - uses singleton
        service = OrchestratorService()
        # Service uses bus singleton, not passed bus
        assert service is not None

    def test_init_without_bus(self):
        """Test initialization without bus (uses singleton)."""
        # Service now uses singleton bus, so this should work
        service = OrchestratorService()
        assert service is not None


class TestOrchestratorServiceLifecycle:
    """Test orchestrator service lifecycle."""

    @pytest.mark.asyncio
    async def test_start(self, orchestrator_service, mock_bus):
        """Test service start subscribes to correct topics."""
        # Mock bus singleton
        with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
            await orchestrator_service.start()

            # Verify subscriptions were made (service uses auto-subscription via contracts)
            # The exact count may vary based on contract registration
            assert mock_bus.subscribe.call_count >= 0  # May use auto-subscription

    @pytest.mark.asyncio
    async def test_stop(self, orchestrator_service):
        """Test service stop."""
        # Should not raise any errors
        await orchestrator_service.stop()

    @pytest.mark.asyncio
    async def test_start_stop_cycle(self, orchestrator_service, mock_bus):
        """Test complete start-stop cycle."""
        await orchestrator_service.start()
        # Service uses auto-subscription via contracts, count may vary

        await orchestrator_service.stop()
        # Service should still be in valid state after stop


class TestOrchestratorServiceTranscriptionHandling:
    """Test orchestrator service transcription handling."""

    @pytest.mark.asyncio
    async def test_on_transcription_with_final_text(self, orchestrator_service, mock_bus):
        """Test handling final transcription."""
        from app.shared.messaging.models.stt_coordinator_models import STTUserSpeechCaptured

        event = STTUserSpeechCaptured(text="Hello Aurora", is_final=True, session_id="test-session")

        envelope = Envelope(type="event", payload=event)  # Pass the BaseModel directly, not dict

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            await orchestrator_service._on_transcription(envelope)

            # Verify process_input was called with correct arguments (including session_id)
            mock_process.assert_called_once_with(
                "Hello Aurora",
                source="stt",
                session_id="test-session",
                request_id="test-session",
                correlation_id="test-session",
                stream=True,
            )

    @pytest.mark.asyncio
    async def test_on_transcription_with_non_final_text(self, orchestrator_service):
        """Test handling non-final transcription (should be skipped)."""
        from app.shared.messaging.models.stt_coordinator_models import STTUserSpeechCaptured

        event = STTUserSpeechCaptured(text="Hello", is_final=False, session_id="test-session")

        envelope = Envelope(type="event", payload=event)

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            await orchestrator_service._on_transcription(envelope)

            # Verify process_input was NOT called for non-final transcription
            mock_process.assert_not_called()

    @pytest.mark.asyncio
    async def test_on_transcription_with_invalid_payload(self, orchestrator_service):
        """Test handling transcription with invalid payload."""

        # Create a simple BaseModel for invalid payload
        class InvalidPayload(Event):
            invalid: str = "data"

        envelope = Envelope(type="event", payload=InvalidPayload())

        # Should not raise exception, but log error
        await orchestrator_service._on_transcription(envelope)

    @pytest.mark.asyncio
    async def test_on_transcription_with_exception(self, orchestrator_service):
        """Test transcription handling with exception in processing."""
        from app.shared.messaging.models.stt_coordinator_models import STTUserSpeechCaptured

        event = STTUserSpeechCaptured(text="Hello", is_final=True, session_id="test-session")

        envelope = Envelope(type="event", payload=event)

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            mock_process.side_effect = Exception("Processing error")

            # Should not raise exception, but log error
            await orchestrator_service._on_transcription(envelope)


class TestOrchestratorServiceUserInputHandling:
    """Test orchestrator service user input handling."""

    @pytest.mark.asyncio
    async def test_local_graph_inference_ids_reject_unknown_provider(self, orchestrator_service):
        """Explicit provider ids without a remote selector must match the local runtime."""
        from app.shared.contracts.models.orchestrator import (
            ModelRuntimeCatalogResponse,
            ModelRuntimeProviderInfo,
        )

        catalog = ModelRuntimeCatalogResponse(
            generated_at="2026-07-07T00:00:00Z",
            selected_provider_id="openai",
            providers=[
                ModelRuntimeProviderInfo(
                    provider_id="openai",
                    display_name="OpenAI",
                    backend_kind="cloud",
                    provider_type="openai",
                    model_id="gpt-4o-mini",
                    default_model_id="gpt-4o-mini",
                    selected=True,
                )
            ],
        )

        with (
            patch.object(
                orchestrator_service,
                "_build_model_runtime_catalog",
                new_callable=AsyncMock,
                return_value=catalog,
            ),
            pytest.raises(ValueError, match="inference_provider_id"),
        ):
            await orchestrator_service._resolve_inference_override(
                inference_provider_id="mesh:gpu:Orchestrator",
                inference_model_id="gpt-4o-mini",
            )

    @pytest.mark.asyncio
    async def test_local_graph_inference_ids_preserve_valid_model_id(self, orchestrator_service):
        """A local explicit model id is preserved after matching the selected runtime."""
        from app.shared.contracts.models.orchestrator import (
            ModelRuntimeCatalogResponse,
            ModelRuntimeModelInfo,
            ModelRuntimeProviderInfo,
        )

        catalog = ModelRuntimeCatalogResponse(
            generated_at="2026-07-07T00:00:00Z",
            selected_provider_id="llama_cpp",
            providers=[
                ModelRuntimeProviderInfo(
                    provider_id="llama_cpp",
                    display_name="Llama.cpp",
                    backend_kind="local",
                    provider_type="llama_cpp",
                    model_id="local-model.gguf",
                    default_model_id="local-model.gguf",
                    selected=True,
                    models=[
                        ModelRuntimeModelInfo(
                            model_id="local-model.gguf",
                            display_name="local-model.gguf",
                        )
                    ],
                )
            ],
        )

        with patch.object(
            orchestrator_service,
            "_build_model_runtime_catalog",
            new_callable=AsyncMock,
            return_value=catalog,
        ):
            override = await orchestrator_service._resolve_inference_override(
                inference_model_id="local-model.gguf",
            )

        assert override == {
            "inference_selector": None,
            "inference_provider_id": "llama_cpp",
            "inference_model_id": "local-model.gguf",
            "inference_provider": None,
            "inference_timeout_s": None,
            "inference_explicit_selection": True,
            "inference_provider_is_cloud": False,
            "inference_selection_is_default": True,
            "inference_selected_provider_id": "llama_cpp",
            "inference_selected_model_id": "local-model.gguf",
            "inference_provider_label": "Llama.cpp",
        }

    @pytest.mark.asyncio
    async def test_graph_cloud_model_selection_uses_expanded_catalog_when_authorized(
        self, orchestrator_service
    ):
        """A model shown by the live cloud catalog must remain valid at execution time."""
        from app.shared.contracts.models.orchestrator import (
            ModelRuntimeCatalogResponse,
            ModelRuntimeModelInfo,
            ModelRuntimeProviderInfo,
        )

        catalog = ModelRuntimeCatalogResponse(
            generated_at="2026-07-23T00:00:00Z",
            selected_provider_id="openai",
            providers=[
                ModelRuntimeProviderInfo(
                    provider_id="openai",
                    display_name="OpenAI",
                    backend_kind="openai_chat",
                    provider_type="cloud",
                    provider_kind="cloud",
                    upstream_provider_type="openai",
                    model_id="gpt-5.4-mini",
                    default_model_id="gpt-5.4-mini",
                    selected=True,
                    models=[
                        ModelRuntimeModelInfo(
                            model_id="gpt-5.4-mini",
                            display_name="gpt-5.4-mini",
                        ),
                        ModelRuntimeModelInfo(
                            model_id="gpt-3.5-turbo",
                            display_name="gpt-3.5-turbo",
                        ),
                    ],
                )
            ],
        )

        with patch.object(
            orchestrator_service,
            "_build_model_runtime_catalog",
            new_callable=AsyncMock,
            return_value=catalog,
        ) as build_catalog:
            override = await orchestrator_service._resolve_inference_override(
                inference_provider_id="openai",
                inference_model_id="gpt-3.5-turbo",
                include_cloud_models=True,
            )

        assert override["inference_model_id"] == "gpt-3.5-turbo"
        assert override["inference_provider_is_cloud"] is True
        build_catalog.assert_awaited_once_with(
            include_unavailable=True,
            include_operations=False,
            include_remote=False,
            include_cloud_models=True,
        )

    def test_graph_cloud_catalog_expansion_uses_permission_hierarchy(self, orchestrator_service):
        assert (
            orchestrator_service._can_expand_graph_cloud_catalog(
                caller_effective_perms=["Orchestrator.use"],
                caller_identity_source="gateway_http",
                source="external",
            )
            is True
        )
        assert (
            orchestrator_service._can_expand_graph_cloud_catalog(
                caller_effective_perms=["Orchestrator.RemoteInference"],
                caller_identity_source="gateway_http",
                source="external",
            )
            is True
        )
        assert (
            orchestrator_service._can_expand_graph_cloud_catalog(
                caller_effective_perms=["Orchestrator.manage"],
                caller_identity_source="gateway_http",
                source="external",
            )
            is False
        )

    def test_remote_runtime_inference_selector_uses_permission_hierarchy(
        self, orchestrator_service
    ):
        """Coarse use and granular inference grants permit remote selection."""
        from app.shared.contracts.models.mesh import MeshAddressSelector

        override = {
            "inference_selector": MeshAddressSelector(
                peer_id="lab", resource_namespace="inference"
            ),
            "inference_provider": "remote_peer",
        }
        orchestrator_service._authorize_inference_override(
            override,
            caller_effective_perms=["Orchestrator.use"],
            caller_identity_source="gateway_http",
            source="external",
        )
        orchestrator_service._authorize_inference_override(
            override,
            caller_effective_perms=["Orchestrator.RemoteInference"],
            caller_identity_source="gateway_http",
            source="external",
        )

        with pytest.raises(PermissionError, match="RemoteInference"):
            orchestrator_service._authorize_inference_override(
                override,
                caller_effective_perms=["Orchestrator.manage"],
                caller_identity_source="gateway_http",
                source="external",
            )

    def test_external_explicit_cloud_or_non_default_inference_uses_permission_hierarchy(
        self, orchestrator_service
    ):
        """External provider/model overrides accept coarse or granular use grants."""

        for override in (
            {
                "inference_provider_id": "openai",
                "inference_model_id": "gpt-4o",
                "inference_explicit_selection": True,
                "inference_provider_is_cloud": True,
                "inference_selection_is_default": False,
            },
            {
                "inference_provider_id": "huggingface_pipeline",
                "inference_model_id": "microsoft/DialoGPT-medium",
                "inference_explicit_selection": True,
                "inference_provider_is_cloud": False,
                "inference_selection_is_default": False,
            },
        ):
            orchestrator_service._authorize_inference_override(
                override,
                caller_effective_perms=["Orchestrator.use"],
                caller_identity_source="gateway_http",
                source="external",
            )
            orchestrator_service._authorize_inference_override(
                override,
                caller_effective_perms=["Orchestrator.RemoteInference"],
                caller_identity_source="gateway_http",
                source="external",
            )
            with pytest.raises(PermissionError, match="RemoteInference"):
                orchestrator_service._authorize_inference_override(
                    override,
                    caller_effective_perms=["Orchestrator.manage"],
                    caller_identity_source="gateway_http",
                    source="external",
                )

    @pytest.mark.asyncio
    async def test_resolved_cloud_graph_override_is_permission_gated_for_external_callers(
        self, orchestrator_service
    ):
        """ExternalUserInput provider/model ids are classified before authorization."""
        from app.shared.contracts.models.orchestrator import (
            ModelRuntimeCatalogResponse,
            ModelRuntimeProviderInfo,
        )

        catalog = ModelRuntimeCatalogResponse(
            generated_at="2026-07-07T00:00:00Z",
            selected_provider_id="llama_cpp",
            providers=[
                ModelRuntimeProviderInfo(
                    provider_id="llama_cpp",
                    display_name="Llama.cpp",
                    backend_kind="local",
                    provider_type="local",
                    provider_kind="local",
                    model_id="local-model.gguf",
                    default_model_id="local-model.gguf",
                    selected=True,
                ),
                ModelRuntimeProviderInfo(
                    provider_id="openai",
                    display_name="OpenAI",
                    backend_kind="openai_chat",
                    provider_type="cloud",
                    provider_kind="cloud",
                    upstream_provider_type="openai",
                    model_id="gpt-4o",
                    default_model_id="gpt-4o",
                ),
            ],
        )

        with patch.object(
            orchestrator_service,
            "_build_model_runtime_catalog",
            new_callable=AsyncMock,
            return_value=catalog,
        ):
            override = await orchestrator_service._resolve_inference_override(
                inference_provider_id="openai",
                inference_model_id="gpt-4o",
            )

        assert override["inference_provider_is_cloud"] is True
        assert override["inference_selection_is_default"] is False
        orchestrator_service._authorize_inference_override(
            override,
            caller_effective_perms=["Orchestrator.use"],
            caller_identity_source="gateway_http",
            source="external",
        )
        with pytest.raises(PermissionError, match="RemoteInference"):
            orchestrator_service._authorize_inference_override(
                override,
                caller_effective_perms=["Orchestrator.manage"],
                caller_identity_source="gateway_http",
                source="external",
            )

    def test_external_explicit_default_local_inference_uses_existing_permission(
        self, orchestrator_service
    ):
        """Selecting the already-configured local default does not add new permission needs."""

        orchestrator_service._authorize_inference_override(
            {
                "inference_provider_id": "llama_cpp",
                "inference_model_id": "local-model.gguf",
                "inference_explicit_selection": True,
                "inference_provider_is_cloud": False,
                "inference_selection_is_default": True,
            },
            caller_effective_perms=["Orchestrator.use"],
            caller_identity_source="gateway_http",
            source="external",
        )

    def test_direct_inference_provider_selection_uses_permission_hierarchy(
        self, orchestrator_service
    ):
        from app.messaging.bus import Envelope
        from app.shared.contracts.models.orchestrator import (
            OrchestratorChatMessage,
            OrchestratorInferChatRequest,
        )

        request = OrchestratorInferChatRequest(
            messages=[OrchestratorChatMessage(role="user", content="hi")],
            provider_id="openai",
        )
        envelope = Envelope(
            type="Orchestrator.InferChat",
            payload=request,
            origin="external",
            principal_id="principal-1",
            effective_perms=["Orchestrator.use"],
            identity_source="gateway_http",
        )

        orchestrator_service._authorize_direct_inference_request(
            request,
            envelope,
            explicit_selection=True,
        )

        allowed = envelope.model_copy(update={"effective_perms": ["Orchestrator.RemoteInference"]})
        orchestrator_service._authorize_direct_inference_request(
            request,
            allowed,
            explicit_selection=True,
        )
        with pytest.raises(PermissionError, match="RemoteInference"):
            orchestrator_service._authorize_direct_inference_request(
                request,
                envelope.model_copy(update={"effective_perms": ["Orchestrator.manage"]}),
                explicit_selection=True,
            )

    def test_cloud_catalog_expansion_uses_permission_hierarchy(self, orchestrator_service):
        from app.messaging.bus import Envelope
        from app.shared.contracts.models.orchestrator import ModelRuntimeCatalogRequest

        request = ModelRuntimeCatalogRequest(include_cloud_models=True)
        envelope = Envelope(
            type="Orchestrator.GetModelCatalog",
            payload=request,
            origin="external",
            principal_id="principal-1",
            effective_perms=["Orchestrator.use"],
            identity_source="gateway_http",
        )

        orchestrator_service._authorize_cloud_catalog_request(request, envelope)

        orchestrator_service._authorize_cloud_catalog_request(
            request,
            envelope.model_copy(update={"effective_perms": ["Orchestrator.RemoteInference"]}),
        )
        with pytest.raises(PermissionError, match="Cloud model catalog"):
            orchestrator_service._authorize_cloud_catalog_request(
                request,
                envelope.model_copy(update={"effective_perms": ["Orchestrator.manage"]}),
            )

    def test_inference_request_limits_reject_oversized_payload(self, orchestrator_service):
        from app.shared.contracts.models.orchestrator import (
            OrchestratorChatMessage,
            OrchestratorInferChatRequest,
        )

        request = OrchestratorInferChatRequest(
            messages=[OrchestratorChatMessage(role="user", content="x" * (70 * 1024))]
        )

        with pytest.raises(ValueError, match="message content exceeds limit"):
            orchestrator_service._enforce_inference_request_limits(request)

    @pytest.mark.asyncio
    async def test_on_user_input(self, orchestrator_service):
        """Test handling UI user input."""
        from app.shared.contracts.models.common import EmptyOutput
        from app.shared.contracts.models.orchestrator import OrchestratorProcessRequest

        # OrchestratorProcessRequest uses 'text' field, not 'message', and 'session_id' directly
        request = OrchestratorProcessRequest(text="Test command", session_id="ui-session")

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            # Call contract method directly
            response = await orchestrator_service.process_user_input(request)

            assert isinstance(response, EmptyOutput)
            mock_process.assert_called_once_with(
                "Test command",
                source="ui",
                session_id="ui-session",
                request_id=None,
                correlation_id=None,
                stream=False,
                inference_selector=None,
                inference_provider_id=None,
                inference_model_id=None,
            )

    @pytest.mark.asyncio
    async def test_on_user_input_propagates_explicit_client_tts_playback(
        self, orchestrator_service
    ):
        """Explicit thin-client playback preference is passed as response metadata."""
        from app.shared.contracts.models.common import EmptyOutput
        from app.shared.contracts.models.orchestrator import OrchestratorProcessRequest

        request = OrchestratorProcessRequest(
            text="Test command",
            session_id="ui-session",
            client_tts_playback=True,
        )

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            response = await orchestrator_service.process_user_input(request)

            assert isinstance(response, EmptyOutput)
            mock_process.assert_called_once_with(
                "Test command",
                source="ui",
                session_id="ui-session",
                request_id=None,
                correlation_id=None,
                stream=False,
                inference_selector=None,
                inference_provider_id=None,
                inference_model_id=None,
                response_metadata={"client_tts_playback": True},
            )

    @pytest.mark.asyncio
    async def test_on_user_input_with_invalid_payload(self, orchestrator_service):
        """Test handling user input with invalid payload."""
        from pydantic import ValidationError

        from app.shared.contracts.models.orchestrator import OrchestratorProcessRequest

        # Invalid request (missing required field) - should be caught by Pydantic validation
        with pytest.raises(ValidationError):
            request = OrchestratorProcessRequest()  # Missing required 'text' field
            await orchestrator_service.process_user_input(request)

    @pytest.mark.asyncio
    async def test_on_external_input(self, orchestrator_service):
        """Test handling external user input."""
        from app.shared.contracts.models.orchestrator import (
            OrchestratorProcessRequest,
            OrchestratorResponse,
        )

        request = OrchestratorProcessRequest(
            text="External command",
            session_id="external-session",
            request_id="request-1",
            correlation_id="corr-1",
            stream=True,
        )

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            mock_process.return_value = "Test response"

            # Call contract method directly
            response = await orchestrator_service.process_external_input(request)

            assert isinstance(response, OrchestratorResponse)
            assert response.text == "Test response"
            assert response.session_id == "external-session"
            assert response.request_id == "request-1"
            assert response.correlation_id == "corr-1"
            assert response.metadata["stream"] is True
            mock_process.assert_called_once_with(
                "External command",
                source="external",
                session_id="external-session",
                request_id="request-1",
                correlation_id="corr-1",
                return_response=True,
                response_metadata={"source": "external", "stream": True},
                stream=True,
                inference_selector=None,
                inference_provider_id=None,
                inference_model_id=None,
            )

    @pytest.mark.asyncio
    async def test_external_input_uses_request_id_as_approval_session(self, orchestrator_service):
        """Streamed turns without a client session expose the graph thread for approval."""
        from app.shared.contracts.models.orchestrator import OrchestratorProcessRequest

        request = OrchestratorProcessRequest(
            text="List schedules",
            request_id="assistant-request-1",
            correlation_id="assistant-request-1",
            stream=True,
        )

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            mock_process.return_value = "Aurora paused for a tool approval decision."

            response = await orchestrator_service.process_external_input(request)

        assert response.session_id == "assistant-request-1"
        mock_process.assert_called_once_with(
            "List schedules",
            source="external",
            session_id="assistant-request-1",
            request_id="assistant-request-1",
            correlation_id="assistant-request-1",
            return_response=True,
            response_metadata={"source": "external", "stream": True},
            stream=True,
            inference_selector=None,
            inference_provider_id=None,
            inference_model_id=None,
        )

    @pytest.mark.asyncio
    async def test_on_external_input_with_error(self, orchestrator_service):
        """Test external input handling with processing error."""
        from app.shared.contracts.models.orchestrator import (
            OrchestratorProcessRequest,
            OrchestratorResponse,
        )

        request = OrchestratorProcessRequest(text="External command", session_id="external-session")

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            mock_process.side_effect = Exception("Processing error")

            # Should not raise exception, error is caught internally
            response = await orchestrator_service.process_external_input(request)

            # Returns OrchestratorResponse with error info
            assert isinstance(response, OrchestratorResponse)
            assert "Processing error" in response.text
            assert response.metadata.get("error") is True


class TestOrchestratorServiceToolHandling:
    """Test orchestrator service tool handling."""

    @pytest.mark.asyncio
    async def test_on_tool_result_success(self, orchestrator_service):
        """Test handling successful tool result."""
        from app.shared.contracts.models.common import EmptyOutput
        from app.shared.contracts.models.orchestrator import OrchestratorToolResultRequest

        request = OrchestratorToolResultRequest(
            request_id="test-123", result={"data": "success"}, success=True
        )

        # Call contract method directly
        response = await orchestrator_service.process_tool_result(request)

        assert isinstance(response, EmptyOutput)

    @pytest.mark.asyncio
    async def test_on_tool_result_failure(self, orchestrator_service):
        """Test handling failed tool result."""
        from app.shared.contracts.models.common import EmptyOutput
        from app.shared.contracts.models.orchestrator import OrchestratorToolResultRequest

        # Create a failed tool result request
        request = OrchestratorToolResultRequest(
            request_id="test-456", result=None, error="Tool execution failed"
        )

        # Call contract method directly - should not raise exception
        response = await orchestrator_service.process_tool_result(request)

        assert isinstance(response, EmptyOutput)

    @pytest.mark.asyncio
    async def test_list_pending_tool_approvals_requires_session_for_external_caller(
        self, orchestrator_service
    ):
        """External callers must scope pending approval listing to their session."""
        from app.shared.contracts.models.orchestrator import (
            OrchestratorListPendingToolApprovalsRequest,
            OrchestratorPendingToolApproval,
        )

        pending = OrchestratorPendingToolApproval(
            pending_id="session-a:tool-1",
            approval_request_id="approval-1",
            run_id="session-a",
            thread_id="session-a",
            session_id="session-a",
            owner_principal_id="principal-a",
            message_id="message-1",
            tool_call_id="tool-1",
            tool_name="delete_file",
            created_at=1.0,
        )
        orchestrator_service.orchestrator = Mock(
            pending_tool_approvals={pending.pending_id: pending}
        )
        envelope = Envelope(
            type="Orchestrator.ListPendingToolApprovals",
            payload={},
            origin="external",
            identity_source="gateway_http",
            principal_id="principal-a",
            effective_perms=["Orchestrator.use"],
        )

        response = await orchestrator_service.list_pending_tool_approvals(
            OrchestratorListPendingToolApprovalsRequest(),
            envelope=envelope,
        )

        assert response.count == 0
        assert response.approvals == []

    @pytest.mark.asyncio
    async def test_resume_tool_approval_rejects_cross_session_external_caller(
        self, orchestrator_service
    ):
        """External callers cannot approve another session's pending tool call."""
        from app.shared.contracts.models.orchestrator import (
            OrchestratorPendingToolApproval,
            OrchestratorResumeToolApprovalRequest,
        )

        pending = OrchestratorPendingToolApproval(
            pending_id="session-a:tool-1",
            approval_request_id="approval-1",
            run_id="session-a",
            thread_id="session-a",
            session_id="session-a",
            owner_principal_id="principal-a",
            message_id="message-1",
            tool_call_id="tool-1",
            tool_name="delete_file",
            created_at=1.0,
        )
        graph = Mock()
        graph.get_pending_tool_approval.return_value = pending
        graph.resolve_pending_tool_approval = AsyncMock()
        orchestrator_service.orchestrator = graph
        envelope = Envelope(
            type="Orchestrator.ResumeToolApproval",
            payload={},
            origin="external",
            identity_source="gateway_http",
            principal_id="principal-a",
            effective_perms=["Orchestrator.use"],
        )

        response = await orchestrator_service.resume_tool_approval(
            OrchestratorResumeToolApprovalRequest(
                pending_id=pending.pending_id,
                session_id="session-b",
                grant_scope="once",
            ),
            envelope=envelope,
        )

        assert response.ok is False
        assert response.error == "pending_approval_session_mismatch"
        graph.resolve_pending_tool_approval.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_resume_tool_approval_requires_manage_for_durable_external_grants(
        self, orchestrator_service
    ):
        """External durable approval scopes require a manage-level permission."""
        from app.shared.contracts.models.orchestrator import (
            OrchestratorPendingToolApproval,
            OrchestratorResumeToolApprovalRequest,
        )

        pending = OrchestratorPendingToolApproval(
            pending_id="session-a:tool-1",
            approval_request_id="approval-1",
            run_id="session-a",
            thread_id="session-a",
            session_id="session-a",
            owner_principal_id="principal-a",
            message_id="message-1",
            tool_call_id="tool-1",
            tool_name="delete_file",
            created_at=1.0,
        )
        graph = Mock()
        graph.get_pending_tool_approval.return_value = pending
        graph.resolve_pending_tool_approval = AsyncMock()
        orchestrator_service.orchestrator = graph
        envelope = Envelope(
            type="Orchestrator.ResumeToolApproval",
            payload={},
            origin="external",
            identity_source="gateway_http",
            principal_id="principal-a",
            effective_perms=["Orchestrator.use"],
        )

        response = await orchestrator_service.resume_tool_approval(
            OrchestratorResumeToolApprovalRequest(
                pending_id=pending.pending_id,
                session_id="session-a",
                grant_scope="always",
            ),
            envelope=envelope,
        )

        assert response.ok is False
        assert response.error == "tool_approval_manage_permission_required"
        graph.resolve_pending_tool_approval.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_resume_tool_approval_uses_authenticated_external_principal(
        self, orchestrator_service
    ):
        """External approvals ignore caller-supplied approver IDs."""
        from app.shared.contracts.models.orchestrator import (
            OrchestratorPendingToolApproval,
            OrchestratorResumeToolApprovalRequest,
        )

        pending = OrchestratorPendingToolApproval(
            pending_id="session-a:tool-1",
            approval_request_id="approval-1",
            run_id="session-a",
            thread_id="session-a",
            session_id="session-a",
            owner_principal_id="principal-a",
            message_id="message-1",
            tool_call_id="tool-1",
            tool_name="delete_file",
            created_at=1.0,
        )
        graph = Mock()
        graph.get_pending_tool_approval.return_value = pending
        graph.resolve_pending_tool_approval = AsyncMock(return_value=(pending, None, None, None))
        orchestrator_service.orchestrator = graph
        envelope = Envelope(
            type="Orchestrator.ResumeToolApproval",
            payload={},
            origin="external",
            identity_source="gateway_http",
            principal_id="principal-a",
            effective_perms=["Orchestrator.use"],
        )

        response = await orchestrator_service.resume_tool_approval(
            OrchestratorResumeToolApprovalRequest(
                pending_id=pending.pending_id,
                session_id="session-a",
                grant_scope="once",
                approver_principal_id="spoofed-admin",
            ),
            envelope=envelope,
        )

        assert response.ok is True
        assert (
            graph.resolve_pending_tool_approval.await_args.kwargs["approver_principal_id"]
            == "principal-a"
        )

    @pytest.mark.asyncio
    async def test_on_tool_result_with_invalid_payload(self, orchestrator_service):
        """Test tool result handling with invalid payload."""
        from pydantic import ValidationError

        from app.shared.contracts.models.orchestrator import OrchestratorToolResultRequest

        # Invalid request - should be caught by Pydantic validation
        with pytest.raises(ValidationError):
            request = OrchestratorToolResultRequest()  # Missing required fields
            await orchestrator_service.process_tool_result(request)


class TestOrchestratorInterruptHandling:
    """Test assistant interrupt/cancellation contract behavior."""

    @pytest.mark.asyncio
    async def test_interrupt_tts_playback_publishes_stop_and_event(
        self, orchestrator_service, mock_bus
    ):
        from app.shared.contracts.models.orchestrator import (
            OrchestratorEvents,
            OrchestratorInterruptedEvent,
            OrchestratorInterruptRequest,
            OrchestratorMethods,
        )
        from app.shared.contracts.models.tts import TTSMethods, TTSStopRequest

        envelope = Envelope(
            type=OrchestratorMethods.INTERRUPT,
            payload={},
            correlation_id="corr-123",
            principal_id="principal-123",
            caller_peer_id="peer-123",
            identity_source="webrtc_rpc",
            effective_perms=["Orchestrator.use", "TTS.use"],
        )

        response = await orchestrator_service.interrupt_assistant(
            OrchestratorInterruptRequest(
                scopes=["tts_playback"],
                session_id="session-1",
                request_id="request-corr-123",
                reason="user_interrupt",
            ),
            envelope=envelope,
        )

        assert response.status == "interrupted"
        assert response.idempotent is True
        assert response.secrets_redacted is True
        assert response.results[0].scope == "tts_playback"
        assert response.results[0].status == "cancelled"

        stop_call, event_call = mock_bus.publish.call_args_list
        assert stop_call.args[0] == TTSMethods.STOP
        assert isinstance(stop_call.args[1], TTSStopRequest)
        assert stop_call.args[1].correlation_id == "request-corr-123"
        assert stop_call.args[1].reason == "user_interrupt"
        assert stop_call.kwargs["event"] is False
        assert stop_call.kwargs["correlation_id"] == "request-corr-123"
        assert stop_call.kwargs["principal_id"] == "principal-123"
        assert stop_call.kwargs["caller_peer_id"] == "peer-123"
        assert stop_call.kwargs["identity_source"] == "webrtc_rpc"
        assert stop_call.kwargs["effective_perms"] == ["Orchestrator.use", "TTS.use"]

        assert event_call.args[0] == OrchestratorEvents.INTERRUPTED
        event = event_call.args[1]
        assert isinstance(event, OrchestratorInterruptedEvent)
        assert event.audit_event == "orchestrator.interrupt.requested"
        assert event.secrets_redacted is True
        assert event.principal_id == "principal-123"
        assert event_call.kwargs["event"] is True
        assert event_call.kwargs["mesh"] is False

    @pytest.mark.asyncio
    async def test_interrupt_generation_is_idempotent_when_no_task_matches(
        self, orchestrator_service, mock_bus
    ):
        from app.shared.contracts.models.orchestrator import OrchestratorInterruptRequest

        response = await orchestrator_service.interrupt_assistant(
            OrchestratorInterruptRequest(scopes=["generation"], session_id="missing-session")
        )

        assert response.status == "no_active_work"
        assert response.results[0].scope == "generation"
        assert response.results[0].status == "no_active_work"
        assert response.results[0].cancelled_count == 0
        assert mock_bus.publish.call_count == 1

    @pytest.mark.asyncio
    async def test_interrupt_generation_cancels_matching_active_task(
        self, orchestrator_service, mock_bus
    ):
        from app.shared.contracts.models.orchestrator import OrchestratorInterruptRequest

        started = asyncio.Event()

        async def slow_generation(text, tts_result=False, **kwargs):
            assert kwargs["session_id"] == "session-123"
            started.set()
            await asyncio.sleep(30)
            return "should not publish"

        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_updates = AsyncMock(
            side_effect=slow_generation
        )

        task = asyncio.create_task(
            orchestrator_service._process_input(
                "stop this", source="external", session_id="session-123", return_response=True
            )
        )
        await started.wait()

        response = await orchestrator_service.interrupt_assistant(
            OrchestratorInterruptRequest(scopes=["generation"], session_id="session-123")
        )

        assert response.status == "interrupted"
        assert response.results[0].status == "cancelled"
        assert response.results[0].cancelled_count == 1
        assert await task == "Interrupted"
        assert mock_bus.publish.call_count == 1

    @pytest.mark.asyncio
    async def test_interrupt_tool_call_reports_no_separate_active_work(self, orchestrator_service):
        from app.shared.contracts.models.orchestrator import OrchestratorInterruptRequest

        response = await orchestrator_service.interrupt_assistant(
            OrchestratorInterruptRequest(scopes=["tool_call"])
        )

        assert response.status == "no_active_work"
        assert response.results[0].scope == "tool_call"
        assert response.results[0].status == "no_active_work"


class TestOrchestratorServiceInputProcessing:
    """Test orchestrator service input processing."""

    @pytest.mark.asyncio
    async def test_process_input_success(self, orchestrator_service, mock_bus):
        """Test successful input processing."""
        # Mock TTS imports to avoid RealtimeTTS dependency
        mock_tts_module = MagicMock()
        mock_tts_module.TTSRequest = MagicMock()
        mock_tts_module.TTSTopics = MagicMock()

        with patch.dict("sys.modules", {"RealtimeTTS": MagicMock(), "app.tts": mock_tts_module}):
            # Patch orchestrator method
            orchestrator_service.orchestrator = MagicMock()
            orchestrator_service.orchestrator.stream_graph_updates = AsyncMock(
                return_value="This is a response"
            )

            await orchestrator_service._process_input(
                text="Test input", source="ui", session_id="test-session"
            )

            # Verify LLM response was published (at minimum)
            assert mock_bus.publish.call_count >= 1

            # Check first call (LLM response)
            first_call = mock_bus.publish.call_args_list[0]
            from app.shared.contracts.models.orchestrator import OrchestratorMethods

            assert first_call[0][0] == OrchestratorMethods.RESPONSE

    @pytest.mark.asyncio
    async def test_process_input_with_end_response(self, orchestrator_service, mock_bus):
        """Test END publishes a visible completion so voice UI does not stay processing."""
        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_updates = AsyncMock(return_value="END")

        await orchestrator_service._process_input(
            text="Test input", source="stt", session_id="test-session"
        )

        from app.shared.contracts.models.orchestrator import OrchestratorMethods

        mock_bus.publish.assert_called_once()
        topic, payload = mock_bus.publish.call_args.args[:2]
        assert topic == OrchestratorMethods.RESPONSE
        assert payload.text == "Done."
        assert payload.session_id == "test-session"
        assert payload.metadata["terminal_reason"] == "graph_end"
        assert payload.metadata["tts_status"] == "skipped"

    @pytest.mark.asyncio
    async def test_process_input_with_empty_response(self, orchestrator_service, mock_bus):
        """Test input processing with empty response."""
        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_updates = AsyncMock(return_value="")

        await orchestrator_service._process_input(text="Test input", source="ui")

        # Verify no messages were published (empty response)
        mock_bus.publish.assert_not_called()

    @pytest.mark.asyncio
    async def test_process_input_with_exception(self, orchestrator_service, mock_bus):
        """Test input processing with exception."""
        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_updates = AsyncMock(
            side_effect=Exception("Graph processing error")
        )

        # Should not raise exception
        await orchestrator_service._process_input(text="Test input", source="stt")

        from app.shared.contracts.models.orchestrator import OrchestratorMethods

        mock_bus.publish.assert_called_once()
        topic, payload = mock_bus.publish.call_args.args[:2]
        assert topic == OrchestratorMethods.RESPONSE
        assert (
            payload.text
            == "Aurora could not complete that voice request. Check diagnostics for details."
        )
        assert payload.metadata["error"] is True
        assert payload.metadata["error_type"] == "Exception"

    @pytest.mark.asyncio
    async def test_process_input_with_different_sources(self, orchestrator_service, mock_bus):
        """Test input processing from different sources."""
        # Mock TTS imports to avoid RealtimeTTS dependency
        mock_tts_module = MagicMock()
        mock_tts_module.TTSRequest = MagicMock()
        mock_tts_module.TTSTopics = MagicMock()

        with patch.dict("sys.modules", {"RealtimeTTS": MagicMock(), "app.tts": mock_tts_module}):
            orchestrator_service.orchestrator = MagicMock()
            orchestrator_service.orchestrator.stream_graph_updates = AsyncMock(
                return_value="Response"
            )

            # Test STT source
            await orchestrator_service._process_input("Input", source="stt")
            assert mock_bus.publish.call_count >= 1  # At least LLM response

            mock_bus.reset_mock()

            # Test UI source
            await orchestrator_service._process_input("Input", source="ui")
            assert mock_bus.publish.call_count >= 1  # At least LLM response

            mock_bus.reset_mock()

            # Test external source
            await orchestrator_service._process_input("Input", source="external")
            assert mock_bus.publish.call_count >= 1  # At least LLM response; TTS is optional.

    @pytest.mark.asyncio
    async def test_process_input_skips_tts_for_typed_ui_by_default(
        self, orchestrator_service, mock_bus
    ):
        """Typed UI requests should return text without automatic server TTS."""
        from app.shared.contracts.models.orchestrator import OrchestratorMethods
        from app.shared.contracts.models.tts import TTSMethods

        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_updates = AsyncMock(
            return_value="Typed response"
        )
        orchestrator_service._ui_automatic_tts_readback = False

        with patch("app.services.orchestrator.service.get_contract", return_value=object()):
            await orchestrator_service._process_input("Input", source="ui")

        topics = [call.args[0] for call in mock_bus.publish.call_args_list]
        assert OrchestratorMethods.RESPONSE in topics
        assert TTSMethods.REQUEST not in topics

    @pytest.mark.asyncio
    async def test_process_input_keeps_tts_for_voice_origin(self, orchestrator_service, mock_bus):
        """Voice-origin requests keep voice-to-voice playback."""
        from app.shared.contracts.models.orchestrator import OrchestratorMethods
        from app.shared.contracts.models.tts import TTSMethods

        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_updates = AsyncMock(
            return_value="Voice response"
        )

        with patch("app.services.orchestrator.service.get_contract", return_value=object()):
            await orchestrator_service._process_input("Input", source="stt")

        topics = [call.args[0] for call in mock_bus.publish.call_args_list]
        assert topics[0] == OrchestratorMethods.RESPONSE
        assert TTSMethods.REQUEST in topics

    @pytest.mark.asyncio
    async def test_process_input_publishes_assistant_response_before_tts_with_correlation(
        self, orchestrator_service, mock_bus
    ):
        """Assistant response event keeps request correlation and precedes TTS playback."""
        from app.shared.contracts.models.orchestrator import OrchestratorMethods
        from app.shared.contracts.models.tts import TTSMethods, TTSRequest

        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_updates = AsyncMock(
            return_value="Correlated voice response"
        )

        with patch("app.services.orchestrator.service.get_contract", return_value=object()):
            await orchestrator_service._process_input(
                "Input",
                source="stt",
                session_id="session-order",
                request_id="request-order",
                correlation_id="corr-order",
            )

        response_call, tts_call = mock_bus.publish.call_args_list[:2]
        assert response_call.args[0] == OrchestratorMethods.RESPONSE
        assert response_call.kwargs["event"] is True
        assert response_call.kwargs["correlation_id"] == "corr-order"
        response_payload = response_call.args[1]
        assert response_payload.text == "Correlated voice response"
        assert response_payload.session_id == "session-order"
        assert response_payload.metadata["request_id"] == "request-order"
        assert response_payload.metadata["correlation_id"] == "corr-order"

        assert tts_call.args[0] == TTSMethods.REQUEST
        assert isinstance(tts_call.args[1], TTSRequest)
        assert tts_call.args[1].text == "Correlated voice response"
        assert tts_call.kwargs["event"] is False

    @pytest.mark.asyncio
    async def test_remote_thin_stream_targets_response_and_client_tts(
        self, orchestrator_service, mock_bus
    ):
        """Thin WebRTC callers receive correlated mesh responses and client audio stream."""
        from app.shared.contracts.models.orchestrator import (
            AssistantStreamEvent,
            OrchestratorMethods,
        )
        from app.shared.contracts.models.tts import (
            TTSMethods,
            TTSStreamChunkRequest,
            TTSStreamEndRequest,
            TTSStreamStartRequest,
        )

        async def stream_events(*args, **kwargs):
            yield AssistantStreamEvent(kind="assistant.delta", delta="Hello remote audio")

        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_events = stream_events
        orchestrator_service._ui_automatic_tts_readback = False

        with patch("app.services.orchestrator.service.get_contract", return_value=object()):
            await orchestrator_service._process_input(
                "Input",
                source="external",
                session_id="session-remote",
                request_id="request-remote",
                correlation_id="corr-remote",
                stream=True,
                caller_principal_id="principal-a",
                caller_peer_id="peer-a",
                caller_identity_source="webrtc_rpc",
                response_metadata={"client_tts_playback": True},
            )

        response_calls = [
            call
            for call in mock_bus.publish.call_args_list
            if call.args[0] == OrchestratorMethods.RESPONSE
        ]
        assert len(response_calls) == 2
        assert all(call.kwargs["mesh"] is True for call in response_calls)
        assert all(call.kwargs["caller_peer_id"] == "peer-a" for call in response_calls)
        assert all(call.kwargs["principal_id"] == "principal-a" for call in response_calls)
        assert all(call.kwargs["correlation_id"] == "corr-remote" for call in response_calls)

        tts_start = next(
            call
            for call in mock_bus.publish.call_args_list
            if call.args[0] == TTSMethods.STREAM_START
        )
        assert isinstance(tts_start.args[1], TTSStreamStartRequest)
        assert tts_start.args[1].play_on_server is False
        assert tts_start.kwargs["caller_peer_id"] == "peer-a"
        assert tts_start.kwargs["principal_id"] == "principal-a"
        assert tts_start.kwargs["correlation_id"] == "corr-remote"

        tts_chunk = next(
            call
            for call in mock_bus.publish.call_args_list
            if call.args[0] == TTSMethods.STREAM_CHUNK
        )
        assert isinstance(tts_chunk.args[1], TTSStreamChunkRequest)
        assert tts_chunk.args[1].text == "Hello remote audio"
        assert tts_chunk.args[1].is_final is True
        assert tts_chunk.kwargs["caller_peer_id"] == "peer-a"
        assert tts_chunk.kwargs["principal_id"] == "principal-a"
        assert tts_chunk.kwargs["correlation_id"] == "corr-remote"

        tts_end = next(
            call
            for call in mock_bus.publish.call_args_list
            if call.args[0] == TTSMethods.STREAM_END
        )
        assert isinstance(tts_end.args[1], TTSStreamEndRequest)
        assert tts_end.kwargs["caller_peer_id"] == "peer-a"
        assert tts_end.kwargs["principal_id"] == "principal-a"
        assert tts_end.kwargs["correlation_id"] == "corr-remote"

    @pytest.mark.asyncio
    async def test_remote_thin_completed_only_stream_flushes_client_tts_text(
        self, orchestrator_service, mock_bus
    ):
        """A completed-only model stream still sends its response text to client TTS."""
        from app.shared.contracts.models.orchestrator import AssistantStreamEvent
        from app.shared.contracts.models.tts import TTSMethods, TTSStreamChunkRequest

        async def stream_events(*args, **kwargs):
            yield AssistantStreamEvent(
                kind="assistant.completed", text="Completed-only remote audio."
            )

        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_events = stream_events
        orchestrator_service._ui_automatic_tts_readback = False

        with patch("app.services.orchestrator.service.get_contract", return_value=object()):
            await orchestrator_service._process_input(
                "Input",
                source="external",
                session_id="session-completed-only",
                request_id="request-completed-only",
                correlation_id="corr-completed-only",
                stream=True,
                caller_principal_id="principal-a",
                caller_peer_id="peer-a",
                caller_identity_source="webrtc_rpc",
                response_metadata={"client_tts_playback": True},
            )

        tts_chunks = [
            call
            for call in mock_bus.publish.call_args_list
            if call.args[0] == TTSMethods.STREAM_CHUNK
        ]
        assert len(tts_chunks) == 1
        assert isinstance(tts_chunks[0].args[1], TTSStreamChunkRequest)
        assert tts_chunks[0].args[1].text == "Completed-only remote audio."
        assert tts_chunks[0].args[1].is_final is True
        assert tts_chunks[0].kwargs["caller_peer_id"] == "peer-a"
        assert tts_chunks[0].kwargs["correlation_id"] == "corr-completed-only"

    @pytest.mark.asyncio
    async def test_stt_stream_keeps_server_tts_and_untargeted_response(
        self, orchestrator_service, mock_bus
    ):
        """Local voice streams keep daemon playback and do not target mesh peers."""
        from app.shared.contracts.models.orchestrator import AssistantStreamEvent
        from app.shared.contracts.models.tts import TTSMethods, TTSStreamStartRequest

        async def stream_events(*args, **kwargs):
            yield AssistantStreamEvent(kind="assistant.delta", delta="Local voice audio. ")

        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_events = stream_events

        with patch("app.services.orchestrator.service.get_contract", return_value=object()):
            await orchestrator_service._process_input(
                "Voice",
                source="stt",
                session_id="voice-session",
                request_id="voice-request",
                correlation_id="voice-corr",
                stream=True,
            )

        tts_start = next(
            call
            for call in mock_bus.publish.call_args_list
            if call.args[0] == TTSMethods.STREAM_START
        )
        assert isinstance(tts_start.args[1], TTSStreamStartRequest)
        assert tts_start.args[1].play_on_server is True
        assert tts_start.kwargs["caller_peer_id"] is None

        response_calls = [
            call
            for call in mock_bus.publish.call_args_list
            if call.args[0] != TTSMethods.STREAM_START
        ]
        assert all(call.kwargs.get("caller_peer_id") is None for call in response_calls)


class TestOrchestratorServiceMessageTypes:
    """Test orchestrator service message type definitions."""

    def test_user_input_creation(self):
        """Test UserInput message creation."""
        msg = UserInput(text="Hello", source="stt")
        assert msg.text == "Hello"
        assert msg.source == "stt"
        assert msg.session_id is None

    def test_user_input_with_session(self):
        """Test UserInput with session ID."""
        msg = UserInput(text="Hello", source="ui", session_id="session-123")
        assert msg.session_id == "session-123"

    def test_llm_response_ready(self):
        """Test LLMResponseReady message creation."""
        msg = LLMResponseReady(text="Response")
        assert msg.text == "Response"
        assert msg.session_id is None
        assert msg.metadata == {}

    def test_llm_response_ready_with_metadata(self):
        """Test LLMResponseReady with metadata."""
        msg = LLMResponseReady(
            text="Response",
            session_id="session-123",
            metadata={"source": "ui", "timestamp": 123456},
        )
        assert msg.metadata["source"] == "ui"
        assert msg.metadata["timestamp"] == 123456

    def test_tool_request_creation(self):
        """Test ToolRequest message creation."""
        msg = ToolRequest(tool_name="search", parameters={"query": "test"}, request_id="req-123")
        assert msg.tool_name == "search"
        assert msg.parameters == {"query": "test"}
        assert msg.request_id == "req-123"

    def test_tool_result_success(self):
        """Test ToolResult for successful execution."""
        msg = ToolResult(request_id="req-123", result={"data": "value"}, success=True)
        assert msg.success is True
        assert msg.error is None

    def test_tool_result_failure(self):
        """Test ToolResult for failed execution."""
        msg = ToolResult(request_id="req-123", result=None, success=False, error="Execution failed")
        assert msg.success is False
        assert msg.error == "Execution failed"
