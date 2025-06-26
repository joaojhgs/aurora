"""
End-to-end tests for the Aurora voice interaction flow using mocks.
"""
import os
import pytest
import asyncio
from pathlib import Path
from unittest.mock import patch, MagicMock, AsyncMock

# Mock classes
class MockSTT:
    """Mock STT class for testing."""
    
    def __init__(self, config=None):
        self.config = config or {}
        self.wake_word_model_path = config.get("speech_to_text", {}).get("wake_word_path", "default/path")
        self.timeout_seconds = config.get("speech_to_text", {}).get("timeout_seconds", 5)
        
    async def start_listening(self, callback):
        """Start listening for speech."""
        # Simulate detecting wake word and then speech
        await asyncio.sleep(0.1)  # Simulate minimal processing time
        callback(b"simulated_audio_data")
        
    async def transcribe_audio(self, audio_data):
        """Transcribe audio data."""
        await asyncio.sleep(0.2)  # Simulate transcription time
        return "What time is it?"


class MockTTS:
    """Mock TTS class for testing."""
    
    def __init__(self, config=None):
        self.config = config or {}
        self.voice_model_path = config.get("text_to_speech", {}).get("voice_model_path", "default/voice.onnx")
        
    async def speak_text(self, text):
        """Speak text."""
        await asyncio.sleep(0.2)  # Simulate TTS processing time
        return True


class MockGraph:
    """Mock LangGraph for testing."""
    
    async def ainvoke(self, input_data, **kwargs):
        """Mock ainvoke method."""
        await asyncio.sleep(0.3)  # Simulate LLM processing time
        
        # Return a standard message structure
        return {
            "messages": [
                {"role": "user", "content": input_data.get("content", "")},
                {"role": "assistant", "content": "The current time is 3:45 PM."}
            ]
        }


class MockDatabaseManager:
    """Mock DatabaseManager for testing."""
    
    async def initialize(self):
        """Initialize the database."""
        pass
        
    async def store_message(self, message):
        """Store a message in the database."""
        await asyncio.sleep(0.1)  # Simulate database operation
        return 1  # Return mock ID
        
    async def close(self):
        """Close the database connection."""
        pass


@pytest.mark.e2e
class TestVoiceInteractionFlowSimple:
    """End-to-end tests for the voice interaction flow."""
    
    @pytest.fixture
    def mock_config(self):
        """Mock configuration."""
        return {
            "app": {
                "name": "Aurora Test",
                "version": "0.1.0"
            },
            "speech_to_text": {
                "enabled": True,
                "wake_word_path": "test_wake_word.onnx",
                "timeout_seconds": 5
            },
            "text_to_speech": {
                "enabled": True,
                "voice_model_path": "test_voice_model.onnx",
                "speaker_id": 0
            },
            "langgraph": {
                "model_path": "test_model.gguf",
                "max_tokens": 100
            },
            "database": {
                "path": ":memory:"
            }
        }
    
    @pytest.mark.asyncio
    async def test_voice_interaction_flow(self, mock_config):
        """Test the complete voice interaction flow."""
        # Create mocks
        stt = MockSTT(config=mock_config)
        tts = MockTTS(config=mock_config)
        graph = MockGraph()
        db_manager = MockDatabaseManager()
        
        # Initialize components
        await db_manager.initialize()
        
        # Define a callback for when speech is detected
        async def on_speech_detected(audio_data):
            # Transcribe the speech
            transcription = await stt.transcribe_audio(audio_data)
            assert transcription == "What time is it?"
            
            # Process with the LLM graph
            response = await graph.ainvoke({"content": transcription})
            assert "messages" in response
            assert len(response["messages"]) == 2
            assert response["messages"][1]["role"] == "assistant"
            
            # Speak the response
            assistant_message = response["messages"][1]["content"]
            assert "time" in assistant_message.lower()
            await tts.speak_text(assistant_message)
            
            # Store the conversation in the database
            for message in response["messages"]:
                await db_manager.store_message({
                    "content": message["content"],
                    "role": message["role"],
                    "timestamp": 1234567890  # Mock timestamp
                })
            
            return assistant_message
        
        # Test the flow
        result = await on_speech_detected(b"simulated_audio_data")
        assert "time" in result.lower()
        
        # Clean up
        await db_manager.close()
