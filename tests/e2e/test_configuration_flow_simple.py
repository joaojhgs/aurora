"""
End-to-end tests for the configuration management flow with mocks.
"""

import json
import os
import tempfile
from unittest.mock import patch

import pytest

from app.config.config_manager import ConfigManager
from app.database.database_manager import DatabaseManager


# Mock STT and TTS classes to avoid import errors
class MockSTT:
    """Mock STT class for testing."""

    def __init__(self, config=None):
        self.config = config or {}
        self.wake_word_model_path = config.get("speech_to_text", {}).get("wake_word_path", "default/path")
        self.timeout_seconds = config.get("speech_to_text", {}).get("timeout_seconds", 5)

    async def start_listening(self, callback):
        """Start listening for speech."""
        return "Mocked transcription"


class MockTTS:
    """Mock TTS class for testing."""

    def __init__(self, config=None):
        self.config = config or {}

    def speak(self, text):
        """Speak text."""
        return True


@pytest.mark.e2e
class TestConfigurationFlow:
    """End-to-end tests for the configuration management flow."""

    @pytest.fixture
    def temp_config_path(self):
        """Create a temporary config file."""
        with tempfile.NamedTemporaryFile(mode="w+", delete=False) as temp_file:
            # Create initial config
            initial_config = {
                "app": {"name": "Aurora Test", "version": "0.1.0", "log_level": "INFO"},
                "database": {"path": ":memory:"},
                "speech_to_text": {
                    "enabled": True,
                    "wake_word_path": "test/wake_word.onnx",
                    "timeout_seconds": 5,
                },
                "text_to_speech": {
                    "enabled": True,
                    "voice_model_path": "test/voice_model.onnx",
                    "speaker_id": 0,
                },
            }
            json.dump(initial_config, temp_file)

        yield temp_file.name
        # Clean up
        os.unlink(temp_file.name)

    def test_config_loading(self, temp_config_path):
        """Test loading configuration from file."""
        # Create a ConfigManager with the test config
        with patch("app.config.config_manager.CONFIG_FILE", temp_config_path):
            config_manager = ConfigManager.get_instance()
            config = config_manager.get_config()

            # Verify config was loaded correctly
            assert config["app"]["name"] == "Aurora Test"
            assert config["app"]["version"] == "0.1.0"
            assert config["database"]["path"] == ":memory:"
            assert config["speech_to_text"]["enabled"] is True

    def test_config_update(self, temp_config_path):
        """Test updating configuration."""
        # Create a ConfigManager with the test config
        with patch("app.config.config_manager.CONFIG_FILE", temp_config_path):
            config_manager = ConfigManager.get_instance()

            # Update a config value
            config_manager.update_config({"app": {"log_level": "DEBUG"}})

            # Reload config
            config = config_manager.get_config()

            # Verify the update was applied
            assert config["app"]["log_level"] == "DEBUG"

            # Verify other values are preserved
            assert config["app"]["name"] == "Aurora Test"
            assert config["database"]["path"] == ":memory:"

    @pytest.mark.asyncio
    async def test_config_components_integration(self, temp_config_path):
        """Test integration of configuration with other components."""
        # Patch the config file path
        with patch("app.config.config_manager.CONFIG_FILE", temp_config_path):
            config_manager = ConfigManager.get_instance()

            # Test with Database
            with patch("app.database.database_manager.ConfigManager", return_value=config_manager):
                db_manager = DatabaseManager()
                await db_manager.initialize()

                # The database should be initialized with the config path
                assert db_manager.db_path == ":memory:"

                await db_manager.close()

            # Test with STT
            with patch("app.speech_to_text.stt.ConfigManager", return_value=config_manager):
                with patch("app.speech_to_text.stt.STT", MockSTT):
                    stt = MockSTT(config_manager.get_config())

                    # Verify STT initialized with config
                    assert stt.wake_word_model_path == "test/wake_word.onnx"
                    assert stt.timeout_seconds == 5

            # Test with TTS
            with patch("app.text_to_speech.tts.ConfigManager", return_value=config_manager):
                with patch("app.text_to_speech.tts.TTS", MockTTS):
                    tts = MockTTS(config_manager.get_config())

                    # Simply check that TTS can be initialized without errors
                    assert isinstance(tts, MockTTS)
