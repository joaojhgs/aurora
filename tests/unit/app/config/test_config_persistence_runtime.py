"""Runtime config persistence behavior."""

from __future__ import annotations

import json

import pytest

from app.services.config.config_manager import ConfigManager


@pytest.fixture(autouse=True)
def reset_config_manager(monkeypatch: pytest.MonkeyPatch, tmp_path):
    original = ConfigManager._instance
    ConfigManager._instance = None
    config_path = tmp_path / "config.json"
    monkeypatch.setenv("AURORA_CONFIG_FILE", str(config_path))
    yield config_path
    ConfigManager._instance = original


def test_config_save_is_json_safe_with_secret_values(reset_config_manager) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()

    metadata = manager.set("services.gateway.api.token_secret", "runtime-secret")
    manager.set("services.auth.enabled", False)

    data = json.loads(config_path.read_text())
    assert data["services"]["gateway"]["api"]["token_secret"] == "runtime-secret"
    assert data["services"]["auth"]["enabled"] is False
    assert metadata["affected_sections"] == [
        "services",
        "services.gateway",
        "services.gateway.api",
        "services.gateway.api.token_secret",
    ]

    ConfigManager._instance = None
    reloaded = ConfigManager()
    assert reloaded.get("services.gateway.api.token_secret") == "runtime-secret"
    assert reloaded.get("services.auth.enabled") is False


def test_failed_save_does_not_corrupt_existing_config(reset_config_manager) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    before = config_path.read_text()

    manager._config["services"]["auth"]["enabled"] = object()
    with pytest.raises(RuntimeError):
        manager.save_config()

    assert config_path.read_text() == before
    json.loads(config_path.read_text())


def test_config_service_cannot_be_disabled_at_runtime(reset_config_manager) -> None:
    manager = ConfigManager()

    with pytest.raises(ValueError, match="ConfigService must remain active"):
        manager.set("services.config.enabled", False)

    assert manager.get("services.config.enabled") is True
