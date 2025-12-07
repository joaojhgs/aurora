"""
Tests for configuration field metadata extraction
"""

import pytest

from app.config.config_manager import ConfigManager


class TestConfigFieldMetadata:
    """Tests for the field metadata functionality in ConfigManager."""

    @pytest.fixture
    def config_manager(self):
        """Get a ConfigManager instance for testing."""
        return ConfigManager()

    def test_get_field_metadata_returns_dict(self, config_manager):
        """Test that get_field_metadata returns a dictionary."""
        metadata = config_manager.get_field_metadata()
        assert isinstance(metadata, dict)
        assert len(metadata) > 0

    def test_ui_fields_metadata(self, config_manager):
        """Test that UI fields have correct metadata."""
        metadata = config_manager.get_field_metadata()

        # Test ui.activate
        ui_activate = metadata.get("ui.activate")
        assert ui_activate is not None
        assert ui_activate["type"] == "bool"
        assert "Enable graphical user interface" in ui_activate["description"]

        # Test ui.dark_mode
        ui_dark_mode = metadata.get("ui.dark_mode")
        assert ui_dark_mode is not None
        assert ui_dark_mode["type"] == "bool"
        assert "dark mode" in ui_dark_mode["description"].lower()

    def test_llm_provider_choice_field(self, config_manager):
        """Test that LLM provider has correct choice metadata."""
        metadata = config_manager.get_field_metadata()

        llm_provider = metadata.get("general.llm.provider")
        assert llm_provider is not None
        assert llm_provider["type"] == "choice"
        assert "choices" in llm_provider

        expected_choices = ["llama_cpp", "openai", "huggingface_endpoint", "huggingface_pipeline"]
        assert llm_provider["choices"] == expected_choices
        assert "LLM provider" in llm_provider["description"]

    def test_numeric_fields_with_constraints(self, config_manager):
        """Test that numeric fields have correct min/max constraints."""
        metadata = config_manager.get_field_metadata()

        # Test temperature field
        temp_field = metadata.get("general.llm.local.llama_cpp.options.temperature")
        assert temp_field is not None
        assert temp_field["type"] == "float"
        assert temp_field["min"] == 0
        assert temp_field["max"] == 2
        assert "temperature" in temp_field["description"].lower()

        # Test n_ctx field
        n_ctx_field = metadata.get("general.llm.local.llama_cpp.options.n_ctx")
        assert n_ctx_field is not None
        assert n_ctx_field["type"] == "int"
        assert n_ctx_field["min"] == 512
        assert n_ctx_field["max"] == 32768

    def test_plugin_activation_fields(self, config_manager):
        """Test that plugin activation fields have correct metadata."""
        metadata = config_manager.get_field_metadata()

        plugins = {
            "jira": "jira",
            "openrecall": "openrecall",
            "brave_search": "brave search",
            "github": "github",
            "slack": "slack",
            "gmail": "gmail",
            "gcalendar": "google calendar",
        }

        for plugin, expected_name in plugins.items():
            activate_field = metadata.get(f"plugins.{plugin}.activate")
            assert activate_field is not None
            assert activate_field["type"] == "bool"
            assert "description" in activate_field
            assert expected_name.lower() in activate_field["description"].lower()

    def test_hardware_acceleration_fields(self, config_manager):
        """Test that hardware acceleration fields have correct metadata."""
        metadata = config_manager.get_field_metadata()

        hw_accel_fields = ["tts", "stt", "ocr_bg", "ocr_curr", "llm"]

        for field in hw_accel_fields:
            hw_field = metadata.get(f"general.hardware_acceleration.{field}")
            assert hw_field is not None
            assert hw_field["type"] == "bool"
            assert "hardware acceleration" in hw_field["description"].lower()

    def test_nested_field_paths(self, config_manager):
        """Test that deeply nested configuration paths work correctly."""
        metadata = config_manager.get_field_metadata()

        # Test a deeply nested field
        nested_field = metadata.get("general.llm.local.llama_cpp.options.repeat_penalty")
        assert nested_field is not None
        assert nested_field["type"] == "float"
        assert nested_field["min"] == 0.1
        assert nested_field["max"] == 2.0

    def test_speech_language_choices(self, config_manager):
        """Test that speech to text language field has correct choices."""
        metadata = config_manager.get_field_metadata()

        lang_field = metadata.get("general.speech_to_text.language")
        assert lang_field is not None
        assert lang_field["type"] == "choice"

        expected_langs = ["", "en", "pt", "es", "fr", "de", "it", "ja", "ko", "zh"]
        assert lang_field["choices"] == expected_langs
        assert "auto-detect" in lang_field["description"]

    def test_special_dict_handling(self, config_manager):
        """Test that special dict fields are handled correctly."""
        metadata = config_manager.get_field_metadata()

        # Test the special case for jira env
        jira_env = metadata.get("plugins.jira.env")
        assert jira_env is not None
        assert jira_env["type"] == "dict"
        assert jira_env["expand_dict"] is False
        assert "environment variables" in jira_env["description"].lower()

    def test_mcp_enabled_field(self, config_manager):
        """Test that MCP enabled field has correct metadata."""
        metadata = config_manager.get_field_metadata()

        mcp_enabled = metadata.get("mcp.enabled")
        assert mcp_enabled is not None
        assert mcp_enabled["type"] == "bool"
        assert "model context protocol" in mcp_enabled["description"].lower()
