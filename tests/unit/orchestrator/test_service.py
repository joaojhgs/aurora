"""Unit tests for orchestrator service."""

import sys
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.messaging import Envelope, Event, MessageBus
from app.orchestrator.service import (
    LLMResponseReady,
    OrchestratorService,
    ToolRequest,
    ToolResult,
    UserInput,
)

# Mock the problematic imports before they're loaded
sys.modules["app.orchestrator.graph"] = MagicMock()
sys.modules["app.orchestrator.agents.chatbot"] = MagicMock()


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.subscribe = Mock()
    bus.publish = AsyncMock()
    return bus


@pytest.fixture
def orchestrator_service(mock_bus):
    """Create an orchestrator service instance."""
    return OrchestratorService(bus=mock_bus)


class TestOrchestratorServiceInitialization:
    """Test orchestrator service initialization."""

    def test_init(self, mock_bus):
        """Test service initialization."""
        service = OrchestratorService(bus=mock_bus)
        assert service.bus == mock_bus

    def test_init_with_none_bus(self):
        """Test initialization with None bus raises error."""
        with pytest.raises((AttributeError, TypeError)):
            service = OrchestratorService(bus=None)
            # Try to use the service to trigger error
            service.bus.subscribe("test", lambda x: x)


class TestOrchestratorServiceLifecycle:
    """Test orchestrator service lifecycle."""

    @pytest.mark.asyncio
    async def test_start(self, orchestrator_service, mock_bus):
        """Test service start subscribes to correct topics."""
        await orchestrator_service.start()

        # Verify subscriptions were made
        assert mock_bus.subscribe.call_count == 4

        # Get all subscription calls
        calls = [call[0] for call in mock_bus.subscribe.call_args_list]

        # Verify correct topics were subscribed to
        from app.messaging import OrchestratorTopics, STTCoordinatorTopics

        subscribed_topics = [call[0] for call in calls]
        assert STTCoordinatorTopics.USER_SPEECH_CAPTURED in subscribed_topics
        assert OrchestratorTopics.USER_INPUT in subscribed_topics
        assert OrchestratorTopics.EXTERNAL_USER_INPUT in subscribed_topics
        assert OrchestratorTopics.TOOL_RESULT in subscribed_topics

    @pytest.mark.asyncio
    async def test_stop(self, orchestrator_service):
        """Test service stop."""
        # Should not raise any errors
        await orchestrator_service.stop()

    @pytest.mark.asyncio
    async def test_start_stop_cycle(self, orchestrator_service, mock_bus):
        """Test complete start-stop cycle."""
        await orchestrator_service.start()
        assert mock_bus.subscribe.call_count == 4

        await orchestrator_service.stop()
        # Service should still be in valid state after stop


class TestOrchestratorServiceTranscriptionHandling:
    """Test orchestrator service transcription handling."""

    @pytest.mark.asyncio
    async def test_on_transcription_with_final_text(self, orchestrator_service, mock_bus):
        """Test handling final transcription."""
        from app.stt_coordinator import STTUserSpeechCaptured

        event = STTUserSpeechCaptured(text="Hello Aurora", is_final=True, session_id="test-session")

        envelope = Envelope(type="event", payload=event)  # Pass the BaseModel directly, not dict

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            await orchestrator_service._on_transcription(envelope)

            # Verify process_input was called with correct arguments
            mock_process.assert_called_once_with("Hello Aurora", source="stt")

    @pytest.mark.asyncio
    async def test_on_transcription_with_non_final_text(self, orchestrator_service):
        """Test handling non-final transcription (should be skipped)."""
        from app.stt_coordinator import STTUserSpeechCaptured

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
        from app.stt_coordinator import STTUserSpeechCaptured

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
    async def test_on_user_input(self, orchestrator_service):
        """Test handling UI user input."""
        cmd = UserInput(text="Test command", source="ui", session_id="ui-session")

        envelope = Envelope(type="command", payload=cmd)

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            await orchestrator_service._on_user_input(envelope)

            mock_process.assert_called_once_with(
                "Test command", source="ui", session_id="ui-session"
            )

    @pytest.mark.asyncio
    async def test_on_user_input_with_invalid_payload(self, orchestrator_service):
        """Test handling user input with invalid payload."""

        class InvalidPayload(Event):
            invalid: str = "data"

        envelope = Envelope(type="command", payload=InvalidPayload())

        # Should not raise exception
        await orchestrator_service._on_user_input(envelope)

    @pytest.mark.asyncio
    async def test_on_external_input(self, orchestrator_service):
        """Test handling external user input."""
        cmd = UserInput(text="External command", source="external", session_id="external-session")

        envelope = Envelope(type="command", payload=cmd)

        with patch.object(
            orchestrator_service, "_process_input", new_callable=AsyncMock
        ) as mock_process:
            await orchestrator_service._on_external_input(envelope)

            mock_process.assert_called_once_with(
                "External command", source="external", session_id="external-session"
            )

    @pytest.mark.asyncio
    async def test_on_external_input_with_error(self, orchestrator_service):
        """Test external input handling with error."""

        class InvalidPayload(Event):
            invalid: str = "payload"

        envelope = Envelope(type="command", payload=InvalidPayload())

        # Should not raise exception
        await orchestrator_service._on_external_input(envelope)


class TestOrchestratorServiceToolHandling:
    """Test orchestrator service tool handling."""

    @pytest.mark.asyncio
    async def test_on_tool_result_success(self, orchestrator_service):
        """Test handling successful tool result."""
        result = ToolResult(request_id="test-123", result={"data": "success"}, success=True)

        envelope = Envelope(type="event", payload=result)

        # Should not raise exception
        await orchestrator_service._on_tool_result(envelope)

    @pytest.mark.asyncio
    async def test_on_tool_result_failure(self, orchestrator_service):
        """Test handling failed tool result."""
        result = ToolResult(
            request_id="test-456", result=None, success=False, error="Tool execution failed"
        )

        envelope = Envelope(type="event", payload=result)

        # Should not raise exception
        await orchestrator_service._on_tool_result(envelope)

    @pytest.mark.asyncio
    async def test_on_tool_result_with_invalid_payload(self, orchestrator_service):
        """Test tool result handling with invalid payload."""

        class InvalidPayload(Event):
            invalid: str = "data"

        envelope = Envelope(type="event", payload=InvalidPayload())

        # Should not raise exception
        await orchestrator_service._on_tool_result(envelope)


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
            from app.messaging import OrchestratorTopics

            assert first_call[0][0] == OrchestratorTopics.LLM_RESPONSE

    @pytest.mark.asyncio
    async def test_process_input_with_end_response(self, orchestrator_service, mock_bus):
        """Test input processing when response is END."""
        orchestrator_service.orchestrator = MagicMock()
        orchestrator_service.orchestrator.stream_graph_updates = AsyncMock(return_value="END")

        await orchestrator_service._process_input(text="Test input", source="stt")

        # Verify no messages were published (END response)
        mock_bus.publish.assert_not_called()

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

        # Verify no messages were published due to error
        mock_bus.publish.assert_not_called()

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
            assert mock_bus.publish.call_count == 2


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
