"""
Performance tests for Aurora components using mocks.
"""
import pytest
import time
import asyncio
from unittest.mock import patch, MagicMock, AsyncMock

from app.database.models import Message, MessageType


class MockSTT:
    """Mock STT implementation for testing."""
    
    async def transcribe_audio(self, audio_data):
        """Simulate audio transcription with controlled latency."""
        await asyncio.sleep(0.05)  # 50ms latency
        return "This is a mock transcription"


class MockTTS:
    """Mock TTS implementation for testing."""
    
    async def speak_text(self, text):
        """Simulate text-to-speech with controlled latency."""
        await asyncio.sleep(0.08)  # 80ms latency
        return True


class MockLLM:
    """Mock LLM implementation for testing."""
    
    async def generate(self, prompt, **kwargs):
        """Simulate LLM generation with controlled latency."""
        await asyncio.sleep(0.2)  # 200ms latency
        return "This is a mock response"


class MockGraph:
    """Mock LangGraph implementation for testing."""
    
    async def ainvoke(self, input_data, **kwargs):
        """Simulate graph execution with controlled latency."""
        await asyncio.sleep(0.25)  # 250ms latency
        return {
            "messages": [
                {"role": "user", "content": input_data.get("content", "")},
                {"role": "assistant", "content": "This is a mock response"}
            ]
        }


class MockDatabaseManager:
    """Mock DatabaseManager implementation for testing."""
    
    async def store_message(self, message):
        """Simulate storing a message with controlled latency."""
        await asyncio.sleep(0.02)  # 20ms latency
        return 1  # Mock ID


@pytest.mark.performance
class TestPerformanceMetricsSimple:
    """Test performance metrics using mocks."""
    
    @pytest.fixture
    def mock_stt(self):
        """Create a mock STT instance."""
        return MockSTT()
    
    @pytest.fixture
    def mock_tts(self):
        """Create a mock TTS instance."""
        return MockTTS()
    
    @pytest.fixture
    def mock_llm(self):
        """Create a mock LLM instance."""
        return MockLLM()
    
    @pytest.fixture
    def mock_graph(self):
        """Create a mock LangGraph instance."""
        return MockGraph()
    
    @pytest.fixture
    def mock_db_manager(self):
        """Create a mock DatabaseManager instance."""
        return MockDatabaseManager()

    @pytest.mark.asyncio
    async def test_stt_performance(self, mock_stt):
        """Test STT performance."""
        # Measure transcription latency
        start_time = time.time()
        result = await mock_stt.transcribe_audio(b"mock_audio_data")
        elapsed_time = time.time() - start_time
        
        # Verify result and performance within expected range
        assert isinstance(result, str)
        assert 0.04 <= elapsed_time <= 0.15  # Allow some buffer for execution variance
    
    @pytest.mark.asyncio
    async def test_tts_performance(self, mock_tts):
        """Test TTS performance."""
        # Measure TTS latency
        start_time = time.time()
        result = await mock_tts.speak_text("This is a test message")
        elapsed_time = time.time() - start_time
        
        # Verify result and performance within expected range
        assert result is True
        assert 0.07 <= elapsed_time <= 0.2  # Allow some buffer for execution variance
    
    @pytest.mark.asyncio
    async def test_llm_performance(self, mock_llm):
        """Test LLM performance."""
        # Measure LLM latency
        start_time = time.time()
        result = await mock_llm.generate("What is the weather today?")
        elapsed_time = time.time() - start_time
        
        # Verify result and performance within expected range
        assert isinstance(result, str)
        assert 0.18 <= elapsed_time <= 0.3  # Allow some buffer for execution variance
    
    @pytest.mark.asyncio
    async def test_graph_performance(self, mock_graph):
        """Test LangGraph performance."""
        # Measure graph latency
        start_time = time.time()
        result = await mock_graph.ainvoke({"content": "What is the weather today?"})
        elapsed_time = time.time() - start_time
        
        # Verify result and performance within expected range
        assert "messages" in result
        assert 0.23 <= elapsed_time <= 0.35  # Allow some buffer for execution variance
    
    @pytest.mark.asyncio
    async def test_database_performance(self, mock_db_manager):
        """Test database performance."""
        # Measure database latency
        mock_message = {
            "content": "Test message",
            "role": "user",
            "timestamp": time.time()
        }
        
        start_time = time.time()
        result = await mock_db_manager.store_message(mock_message)
        elapsed_time = time.time() - start_time
        
        # Verify result and performance within expected range
        assert result == 1  # Mock ID
        assert 0.01 <= elapsed_time <= 0.1  # Allow some buffer for execution variance
    
    @pytest.mark.asyncio
    async def test_end_to_end_flow_performance(self, mock_stt, mock_llm, mock_tts, mock_db_manager):
        """Test end-to-end flow performance."""
        # Measure complete flow latency
        start_time = time.time()
        
        # Simulate the whole flow
        transcription = await mock_stt.transcribe_audio(b"mock_audio_data")
        response = await mock_llm.generate(transcription)
        spoke = await mock_tts.speak_text(response)
        
        # Store both messages
        await mock_db_manager.store_message({
            "content": transcription,
            "role": "user",
            "timestamp": time.time()
        })
        
        await mock_db_manager.store_message({
            "content": response,
            "role": "assistant",
            "timestamp": time.time()
        })
        
        elapsed_time = time.time() - start_time
        
        # Verify overall performance
        assert 0.3 <= elapsed_time <= 0.5  # Allow some buffer for execution variance
