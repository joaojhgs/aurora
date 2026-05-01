"""Semantic behavior for ConfigManager.get() and validate_config() paths."""

import threading

import pytest

from app.services.config.config_manager import ConfigManager


def _minimal_manager_orchestrator_llm(llm: dict) -> ConfigManager:
    """Bare instance with only fields validate_config / get need for LLM paths."""
    cm = ConfigManager.__new__(ConfigManager)
    cm.config_lock = threading.RLock()
    cm._config = {"services": {"orchestrator": {"llm": llm}}}
    return cm


@pytest.mark.unit
class TestConfigGetUnsetFallback:
    def test_empty_string_falls_through_to_default(self) -> None:
        cm = _minimal_manager_orchestrator_llm({"provider": ""})
        assert cm.get("services.orchestrator.llm.provider", default="openai") == "openai"

    def test_missing_key_returns_default(self) -> None:
        cm = _minimal_manager_orchestrator_llm({})
        assert cm.get("services.orchestrator.llm.provider", default="x") == "x"
