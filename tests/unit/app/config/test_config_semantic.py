"""Semantic behavior for ConfigManager.get() and validate_config() paths."""

import threading

import pytest

from app.services.config.config_manager import ConfigManager


def _minimal_manager(general: dict) -> ConfigManager:
    """Bare instance with only fields validate_config / get need."""
    cm = ConfigManager.__new__(ConfigManager)
    cm.config_lock = threading.RLock()
    cm._config = {"general": general}
    return cm


@pytest.mark.unit
class TestConfigGetUnsetFallback:
    def test_empty_string_falls_through_to_default(self) -> None:
        cm = _minimal_manager({"llm": {"provider": ""}})
        assert cm.get("general.llm.provider", default="openai") == "openai"

    def test_missing_key_returns_default(self) -> None:
        cm = _minimal_manager({"llm": {}})
        assert cm.get("general.llm.provider", default="x") == "x"


@pytest.mark.unit
class TestValidateConfigGeneralPaths:
    def test_hardware_acceleration_bools_under_general(self) -> None:
        general = {
            "llm": {
                "provider": "openai",
                "third_party": {
                    "openai": {"options": {"model": "gpt-4o", "api_key": "", "temperature": 0.7, "max_tokens": 512}}
                },
            },
            "text_to_speech": {"model_file_path": ""},
            "hardware_acceleration": {
                "tts": False,
                "stt": False,
                "ocr_bg": False,
                "ocr_curr": False,
                "llm": False,
            },
        }
        cm = _minimal_manager(general)
        errors = cm.validate_config()
        hw_errs = [e for e in errors if "hardware_acceleration" in e]
        assert not hw_errs, f"Unexpected HW errors: {hw_errs}"
