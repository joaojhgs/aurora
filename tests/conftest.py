"""
Global test fixtures and configuration for Aurora test suite.
"""
import os
import sys
import pytest
import tempfile
import sqlite3
import asyncio
from unittest.mock import MagicMock, patch
from pathlib import Path

# Add the parent directory to the path so we can import app modules
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Register custom markers
def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line("markers", "unit: Unit tests")
    config.addinivalue_line("markers", "integration: Integration tests")
    config.addinivalue_line("markers", "e2e: End-to-end tests")
    config.addinivalue_line("markers", "slow: Slow running tests")
    config.addinivalue_line("markers", "gpu: Tests requiring GPU")
    config.addinivalue_line("markers", "ui: Tests requiring UI components")
    config.addinivalue_line("markers", "external: Tests requiring external services")

# Import app modules
from app.config.config_manager import ConfigManager
from app.database.database_manager import DatabaseManager
from app.database.models import Message


@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for each test session."""
    policy = asyncio.get_event_loop_policy()
    loop = policy.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def mock_config_manager():
    """Mock the ConfigManager singleton."""
    with patch('app.config.config_manager.ConfigManager') as mock:
        instance = MagicMock()
        mock.get_instance.return_value = instance
        yield instance


@pytest.fixture
def test_config():
    """Create a test configuration."""
    return {
        "app": {
            "name": "Aurora Test",
            "version": "0.1.0",
            "log_level": "DEBUG"
        },
        "database": {
            "path": ":memory:"
        },
        "speech_to_text": {
            "enabled": False,
            "wake_word_path": "test_wake_word.onnx",
            "timeout_seconds": 5
        },
        "text_to_speech": {
            "enabled": False,
            "voice_model_path": "test_voice_model.onnx",
            "speaker_id": 0
        },
        "scheduler": {
            "enabled": False
        },
        "langgraph": {
            "model_path": "test_model.gguf",
            "max_tokens": 100
        }
    }


@pytest.fixture
def temp_db_path():
    """Create a temporary database path."""
    fd, path = tempfile.mkstemp(suffix=".db")
    yield path
    os.close(fd)
    os.unlink(path)


@pytest.fixture
async def in_memory_db():
    """Create an in-memory SQLite database for testing."""
    conn = sqlite3.connect(":memory:")
    yield conn
    conn.close()


@pytest.fixture
async def test_database_manager(temp_db_path):
    """Create a test DatabaseManager instance with a temporary database."""
    db_manager = DatabaseManager(db_path=temp_db_path)
    await db_manager.initialize()
    yield db_manager
    await db_manager.close()


@pytest.fixture
def mock_audio_device():
    """Mock audio recording device."""
    with patch('app.speech_to_text.audio_recorder.AudioRecorder') as mock:
        instance = MagicMock()
        mock.return_value = instance
        yield instance


@pytest.fixture
def mock_tts_engine():
    """Mock text-to-speech engine."""
    with patch('app.text_to_speech.tts.TTS') as mock:
        instance = MagicMock()
        mock.return_value = instance
        yield instance


@pytest.fixture
def mock_llm_engine():
    """Mock LLM engine."""
    with patch('app.langgraph.ChatLlamaCpp.LlamaCppChat') as mock:
        instance = MagicMock()
        mock.return_value = instance
        yield instance


@pytest.fixture
def sample_message():
    """Create a sample message for testing."""
    return Message(
        id=1,
        content="Hello, this is a test message",
        role="user",
        created_at="2023-01-01T00:00:00",
        message_type="TEXT",
        metadata={"test": True}
    )


@pytest.fixture
def mock_gpu_available():
    """Mock GPU availability detection."""
    with patch('app.helpers.getUseHardwareAcceleration.is_cuda_available', return_value=True):
        yield


@pytest.fixture
def mock_gpu_unavailable():
    """Mock GPU unavailability."""
    with patch('app.helpers.getUseHardwareAcceleration.is_cuda_available', return_value=False):
        yield
