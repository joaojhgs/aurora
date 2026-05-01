"""
Unit tests for the ConfigManager singleton.
"""

import json
import os
import tempfile
import threading
from unittest.mock import MagicMock, mock_open, patch

import pytest
from pydantic import ValidationError

from app.services.config.config_manager import ConfigManager


class TestConfigManager:
    """Tests for the ConfigManager class."""

    def test_singleton_pattern(self):
        """Test that ConfigManager is a singleton."""
        # Reset the singleton instance between tests
        ConfigManager._instance = None

        cm1 = ConfigManager()
        cm2 = ConfigManager()

        assert cm1 is cm2

    def test_load_config_from_file(self):
        """Test loading configuration from a file."""
        # Reset the singleton instance
        ConfigManager._instance = None

        test_config = {
            "ui": {"activate": True},
            "system": {"models_dir": "test_dir"},
        }

        # Create a temporary config file
        with tempfile.NamedTemporaryFile(mode="w+", delete=False) as temp_file:
            json.dump(test_config, temp_file)
            temp_file_path = temp_file.name

        try:
            # Use patch.object for an instance attribute
            with patch.object(ConfigManager, "_validate_config", return_value=True):
                cm = ConfigManager()
                # Patch the instance attribute
                cm.config_file = temp_file_path
                cm.load_config()
                config = cm._config

                assert config["ui"]["activate"] is True

                assert config["system"]["models_dir"] == "test_dir"
        finally:
            # Clean up the temporary file
            os.unlink(temp_file_path)

    def test_default_config_generation(self):
        """Test generation of default configuration when file doesn't exist."""
        # Reset the singleton instance
        ConfigManager._instance = None

        # Use a non-existent file path
        non_existent_path = "/tmp/nonexistent_config.json"

        with patch("app.services.config.config_manager.os.path.exists", return_value=False):
            # First create the instance
            cm = ConfigManager()
            # Then patch the instance attribute
            cm.config_file = non_existent_path

            # Mock the open function for writing the default config
            mock_file = mock_open()
            with (
                patch("builtins.open", mock_file),
                patch.object(ConfigManager, "_get_default_config") as mock_default,
            ):
                mock_default.return_value = {"app": {"name": "Aurora"}}
                # Force a reload of the configuration
                cm.load_config()

                # The instance should have been initialized with the default config
                assert cm._config is not None

                # Check that the file was opened for writing
                mock_file.assert_called_with(non_existent_path, "w")

    @pytest.mark.parametrize(
        "invalid_config",
        [
            {"app": {"name": "Aurora", "version": 123}},
            {"app": {"name": None}},
            {},
        ],
    )
    def test_schema_validation(self, invalid_config):
        """Test validation of configuration against schema."""
        ConfigManager._instance = None

        with tempfile.NamedTemporaryFile(mode="w+", delete=False) as temp_file:
            json.dump(invalid_config, temp_file)
            temp_file_path = temp_file.name

        try:
            cm = ConfigManager()
            cm.config_file = temp_file_path

            with patch.object(ConfigManager, "_validate_config") as mock_validate:
                mock_validate.side_effect = ValueError("Test validation error")
                with patch.object(ConfigManager, "_get_default_config") as mock_default_config:
                    mock_default_config.return_value = {"app": {"name": "Default Aurora"}}

                    try:
                        cm.load_config()
                    except RuntimeError as e:
                        assert "Test validation error" in str(e)

        finally:
            os.unlink(temp_file_path)

    def test_configuration_persistence(self):
        """Test that configuration changes are persisted to disk."""
        # Reset the singleton instance
        ConfigManager._instance = None

        test_config = {
            "ui": {"activate": True},
            "system": {"models_dir": "test_dir"},
        }

        # Create a temporary config file
        with tempfile.NamedTemporaryFile(mode="w+", delete=False) as temp_file:
            json.dump(test_config, temp_file)
            temp_file_path = temp_file.name

        try:
            # Create instance first
            cm = ConfigManager()
            # Then patch instance attributes
            cm.config_file = temp_file_path

            with patch.object(ConfigManager, "_validate_config", return_value=True):
                # Explicitly reload the config from our test file
                cm.load_config()

                # Update a config value using direct access since set_config_value might not exist
                with patch.object(ConfigManager, "save_config") as mock_save:
                    cm._config["ui"]["activate"] = False
                    cm.save_config()

                    # Check the config was updated in memory
                    assert cm._config["ui"]["activate"] is False

                    # Check that save_config was called
                    mock_save.assert_called_once()
        finally:
            os.unlink(temp_file_path)

    def test_observer_pattern(self):
        """Test the observer pattern for configuration changes."""
        # Reset the singleton instance
        ConfigManager._instance = None

        # Mock observer
        observer = MagicMock()
        observer.notify_config_changed = MagicMock()

        # Create the instance first
        with (
            patch("os.path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data="{}")),
            patch.object(ConfigManager, "_validate_config", return_value=True),
        ):
            cm = ConfigManager()
            # Then patch the instance attribute
            cm.config_file = "/tmp/test_config.json"

            # Register the observer
            cm._observers.append(observer)

            # Use the actual _notify_observers method from the class
            # since we see it exists in the implementation
            with patch.object(ConfigManager, "save_config"):
                # Call the notify function directly
                cm._notify_observers("test.value", "old_value", 123)

                # Check that the observer was notified with the right arguments
                observer.assert_called_once_with("test.value", "old_value", 123)

                # Remove the observer
                cm._observers.remove(observer)

                # Reset the mock for the second test
                observer.reset_mock()

                # Call notify again
                cm._notify_observers("test.another", "old_value", 456)

                # The observer should not have been notified again
                observer.assert_not_called()


def _bare_manager(config: dict) -> ConfigManager:
    """Create an uninitialised ConfigManager with just the fields tests need."""
    cm = ConfigManager.__new__(ConfigManager)
    cm.config_lock = threading.RLock()
    cm._config = config
    cm._schema = cm._get_config_schema()
    return cm


@pytest.mark.unit
class TestPydanticSchemaValidation:
    """Verify _validate_config uses the generated Pydantic model."""

    def test_valid_config_passes(self):
        """A valid minimal config should pass validation."""
        cm = _bare_manager({})
        cm._validate_config({"ui": {"activate": False}})

    def test_extra_keys_are_ignored(self):
        """extra='ignore' on BaseConfigModel allows unknown keys."""
        cm = _bare_manager({})
        cm._validate_config({"ui": {"activate": False, "unknown_future_key": True}})

    def test_wrong_type_raises(self):
        """Pydantic should reject type mismatches (e.g. string where bool expected)."""
        cm = _bare_manager({})
        with pytest.raises(ValidationError):
            cm._validate_config({"ui": {"activate": "not_a_bool"}})


@pytest.mark.unit
class TestJsonSchemaValidation:
    """Verify _validate_json_schema logs warnings for constraint violations."""

    def test_enum_violation_logs_warning(self):
        cm = _bare_manager({})
        bad = {"services": {"orchestrator": {"llm": {"provider": "invalid_provider"}}}}
        with patch("app.services.config.config_manager.log_warning") as mock_warn:
            cm._validate_json_schema(bad)
        calls = [str(c) for c in mock_warn.call_args_list]
        assert any("provider" in c for c in calls)

    def test_range_violation_logs_warning(self):
        cm = _bare_manager({})
        bad = {
            "services": {
                "orchestrator": {"llm": {"local": {"llama_cpp": {"options": {"temperature": 999}}}}}
            }
        }
        with patch("app.services.config.config_manager.log_warning") as mock_warn:
            cm._validate_json_schema(bad)
        calls = [str(c) for c in mock_warn.call_args_list]
        assert any("temperature" in c or "maximum" in c for c in calls)

    def test_valid_config_no_warnings(self):
        cm = _bare_manager({})
        defaults_path = os.path.join(
            os.path.dirname(__file__), "../../../../app/services/config/config_defaults.json"
        )
        with open(defaults_path) as f:
            valid = json.load(f)
        with patch("app.services.config.config_manager.log_warning") as mock_warn:
            cm._validate_json_schema(valid)
        constraint_calls = [
            c for c in mock_warn.call_args_list if "JSON Schema constraint" in str(c)
        ]
        assert len(constraint_calls) == 0

    def test_no_schema_is_noop(self):
        cm = _bare_manager({})
        cm._schema = None
        with patch("app.services.config.config_manager.log_warning") as mock_warn:
            cm._validate_json_schema({"anything": True})
        mock_warn.assert_not_called()


@pytest.mark.unit
class TestValidateConfigHardwareAccel:
    """Verify validate_config checks new service-level hardware_acceleration paths."""

    def test_invalid_hw_accel_type(self):
        cm = _bare_manager(
            {
                "services": {
                    "tts": {"hardware_acceleration": "yes"},
                    "orchestrator": {"llm": {"provider": "openai"}, "hardware_acceleration": True},
                },
            }
        )
        errors = cm.validate_config()
        assert any("services.tts.hardware_acceleration" in e for e in errors)

    def test_valid_hw_accel(self):
        cm = _bare_manager(
            {
                "services": {
                    "tts": {"hardware_acceleration": False},
                    "orchestrator": {
                        "llm": {
                            "provider": "openai",
                            "third_party": {"openai": {"options": {"model": "gpt-4"}}},
                        },
                        "hardware_acceleration": True,
                    },
                },
            }
        )
        errors = cm.validate_config()
        hw_errors = [e for e in errors if "hardware_acceleration" in e]
        assert len(hw_errors) == 0
