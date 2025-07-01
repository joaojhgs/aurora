"""
End-to-end tests for the configuration management flow.
"""

import json
import os
import tempfile
from unittest.mock import patch

import pytest

from app.config.config_manager import ConfigManager
from app.speech_to_text.stt import STT
from app.text_to_speech.tts import TTS


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
                    "wake_word_path": "test_wake_word.onnx",
                    "timeout_seconds": 5,
                },
                "text_to_speech": {
                    "enabled": True,
                    "voice_model_path": "test_voice_model.onnx",
                    "speaker_id": 0,
                },
            }

            json.dump(initial_config, temp_file)
            temp_file_path = temp_file.name

        yield temp_file_path
        os.unlink(temp_file_path)

    @pytest.mark.asyncio
    async def test_config_changes_affect_system_components(self, temp_config_path):
        """Test that configuration changes propagate to system components."""
        # Reset the ConfigManager singleton
        ConfigManager._ConfigManager__instance = None

        with patch("app.config.config_manager.DEFAULT_CONFIG_PATH", temp_config_path):
            # 1. Initialize the ConfigManager
            config_manager = ConfigManager.get_instance()

            # 2. Initialize components with the initial config
            with patch("app.speech_to_text.stt.ConfigManager.get_instance", return_value=config_manager):
                with patch("app.text_to_speech.tts.ConfigManager.get_instance", return_value=config_manager):
                    # Create the STT and TTS components
                    with patch("app.speech_to_text.stt.AudioRecorder"):
                        stt = STT()
                        assert stt.timeout_seconds == 5

                    with patch("app.text_to_speech.tts.PiperEngine"):
                        tts = TTS()
                        assert tts.voice_model_path == "test_voice_model.onnx"
                        assert tts.speaker_id == 0

                    # 3. Register observers for configuration changes
                    config_manager.register_observer(stt)
                    config_manager.register_observer(tts)

                    # 4. Change the configuration
                    config_manager.set_config_value("speech_to_text.timeout_seconds", 10)
                    config_manager.set_config_value("text_to_speech.speaker_id", 2)

                    # 5. Verify components received the updates
                    assert stt.timeout_seconds == 10
                    assert tts.speaker_id == 2

                    # 6. Verify the changes were saved to the config file
                    with open(temp_config_path) as f:
                        saved_config = json.load(f)
                        assert saved_config["speech_to_text"]["timeout_seconds"] == 10
                        assert saved_config["text_to_speech"]["speaker_id"] == 2

    @pytest.mark.asyncio
    async def test_config_system_restart(self, temp_config_path):
        """Test that configuration persists across system restarts."""
        # Reset the ConfigManager singleton
        ConfigManager._ConfigManager__instance = None

        with patch("app.config.config_manager.DEFAULT_CONFIG_PATH", temp_config_path):
            # 1. Initialize the ConfigManager
            config_manager = ConfigManager.get_instance()

            # 2. Make configuration changes
            config_manager.set_config_value("app.log_level", "DEBUG")
            config_manager.set_config_value("speech_to_text.enabled", False)

            # 3. Simulate system restart by resetting the singleton
            ConfigManager._ConfigManager__instance = None

            # 4. Initialize a new instance (simulating restart)
            new_config_manager = ConfigManager.get_instance()

            # 5. Verify the configuration was loaded correctly
            config = new_config_manager.get_config()
            assert config["app"]["log_level"] == "DEBUG"
            assert config["speech_to_text"]["enabled"] is False

    @pytest.mark.asyncio
    async def test_invalid_config_handling(self, temp_config_path):
        """Test that the system handles invalid configuration gracefully."""
        # Reset the ConfigManager singleton
        ConfigManager._ConfigManager__instance = None

        # 1. Create an invalid config file
        with open(temp_config_path, "w") as f:
            f.write('{"app": {"name": "Aurora", "version": null}}')  # invalid value

        with patch("app.config.config_manager.DEFAULT_CONFIG_PATH", temp_config_path):
            # 2. Initialize with validation that should fail
            with patch("app.config.config_manager.ConfigManager._validate_config", return_value=False):
                with patch("app.config.config_manager.ConfigManager._load_default_config") as mock_default:
                    ConfigManager.get_instance()

                    # 3. Verify default config was loaded
                    mock_default.assert_called_once()

    @pytest.mark.asyncio
    async def test_config_migration_between_versions(self, temp_config_path):
        """Test migration between config versions."""
        # Reset the ConfigManager singleton
        ConfigManager._ConfigManager__instance = None

        # 1. Create an older version config
        old_config = {
            "app": {"name": "Aurora", "version": "0.1.0"},
            "database": {"path": "old_db.sqlite"},
            # Missing newer settings
        }

        with open(temp_config_path, "w") as f:
            json.dump(old_config, f)

        with patch("app.config.config_manager.DEFAULT_CONFIG_PATH", temp_config_path):
            # 2. Initialize with the older config
            config_manager = ConfigManager.get_instance()

            # 3. Verify that default values were added for missing settings
            config = config_manager.get_config()
            assert "speech_to_text" in config
            assert "text_to_speech" in config

            # 4. Verify the original settings were preserved
            assert config["app"]["name"] == "Aurora"
            assert config["database"]["path"] == "old_db.sqlite"
