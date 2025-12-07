"""
Tests for file field functionality in the configuration system
"""

import pytest

from app.config.config_manager import ConfigManager


class TestFileFieldMetadata:
    """Tests for file field metadata functionality."""

    @pytest.fixture
    def config_manager(self):
        """Get a ConfigManager instance for testing."""
        return ConfigManager()

    def test_file_fields_detected(self, config_manager):
        """Test that file fields are properly detected with correct metadata."""
        metadata = config_manager.get_field_metadata()

        # Filter to only file type fields
        file_fields = {k: v for k, v in metadata.items() if v.get("type") == "file"}

        # Verify we have the expected file fields
        expected_file_fields = [
            "general.text_to_speech.model_file_path",
            "general.text_to_speech.model_config_file_path",
            "general.text_to_speech.piper_path",
            "general.llm.local.llama_cpp.options.model_path",
            "plugins.google.credentials_file",
        ]

        for field_path in expected_file_fields:
            assert field_path in file_fields, f"File field {field_path} not found"

        assert len(file_fields) == len(expected_file_fields), f"Expected {len(expected_file_fields)} file fields, got {len(file_fields)}"

    def test_tts_model_file_metadata(self, config_manager):
        """Test TTS model file field has correct metadata."""
        metadata = config_manager.get_field_metadata()

        field = metadata.get("general.text_to_speech.model_file_path")
        assert field is not None
        assert field["ui_type"] == "file"
        assert "file_filter" in field
        assert "ONNX files" in field["file_filter"]
        assert "*.onnx" in field["file_filter"]
        assert "All files" in field["file_filter"]
        assert "TTS model file" in field["description"]

    def test_tts_config_file_metadata(self, config_manager):
        """Test TTS config file field has correct metadata."""
        metadata = config_manager.get_field_metadata()

        field = metadata.get("general.text_to_speech.model_config_file_path")
        assert field is not None
        assert field["ui_type"] == "file"
        assert "file_filter" in field
        assert "Text files" in field["file_filter"]
        assert "*.txt" in field["file_filter"]
        assert "configuration file" in field["description"]

    def test_piper_executable_metadata(self, config_manager):
        """Test Piper executable field has correct metadata."""
        metadata = config_manager.get_field_metadata()

        field = metadata.get("general.text_to_speech.piper_path")
        assert field is not None
        assert field["ui_type"] == "file"
        assert "file_filter" in field
        assert "Executable files" in field["file_filter"]
        assert "*.exe" in field["file_filter"]
        assert "Piper TTS executable" in field["description"]

    def test_llama_model_file_metadata(self, config_manager):
        """Test Llama.cpp model file field has correct metadata."""
        metadata = config_manager.get_field_metadata()

        field = metadata.get("general.llm.local.llama_cpp.options.model_path")
        assert field is not None
        assert field["ui_type"] == "file"
        assert "file_filter" in field
        assert "GGUF files" in field["file_filter"]
        assert "*.gguf" in field["file_filter"]
        assert "model file" in field["description"]

    def test_google_credentials_metadata(self, config_manager):
        """Test Google credentials file field has correct metadata."""
        metadata = config_manager.get_field_metadata()

        field = metadata.get("plugins.google.credentials_file")
        assert field is not None
        assert field["ui_type"] == "file"
        assert "file_filter" in field
        assert "JSON files" in field["file_filter"]
        assert "*.json" in field["file_filter"]
        assert "Google credentials" in field["description"]

    def test_file_filter_format(self, config_manager):
        """Test that file filters are in the correct Windows format."""
        metadata = config_manager.get_field_metadata()

        file_fields = {k: v for k, v in metadata.items() if v.get("ui_type") == "file"}

        for field_path, field_meta in file_fields.items():
            file_filter = field_meta.get("file_filter", "")

            # Should be in Windows format: "Description (*.ext)|*.ext|All files (*.*)|*.*"
            assert "|" in file_filter, f"File filter for {field_path} should be in Windows format"

            parts = file_filter.split("|")
            assert len(parts) >= 2, f"File filter for {field_path} should have at least 2 parts"
            assert len(parts) % 2 == 0, f"File filter for {field_path} should have even number of parts"

            # Check that we have description and pattern pairs
            for i in range(0, len(parts), 2):
                description = parts[i]
                pattern = parts[i + 1] if i + 1 < len(parts) else ""

                assert "(" in description and ")" in description, f"Description '{description}' should contain parentheses"
                assert "*." in pattern or "*" == pattern, f"Pattern '{pattern}' should contain file extension pattern"
