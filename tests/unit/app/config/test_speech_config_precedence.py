"""Speech config precedence across canonical, legacy, env, and defaults."""

from __future__ import annotations

import threading
from copy import deepcopy

from app.services.config.config_manager import ConfigManager


def _normalize(config: dict) -> dict:
    manager = ConfigManager.__new__(ConfigManager)
    manager.config_lock = threading.RLock()
    manager._config = {}
    manager._schema = manager._get_config_schema()
    manager._speech_config_warning_emitted = False
    return manager._normalize_config(deepcopy(config))


def test_nested_piper_path_wins_over_flat_and_env(monkeypatch) -> None:
    monkeypatch.setenv("AURORA_TTS_MODEL_FILE_PATH", "env.onnx")

    normalized = _normalize(
        {
            "services": {
                "tts": {
                    "model_file_path": "flat.onnx",
                    "providers": {"piper": {"model_file_path": "nested.onnx"}},
                }
            }
        }
    )

    assert normalized["services"]["tts"]["providers"]["piper"]["model_file_path"] == "nested.onnx"


def test_flat_piper_path_wins_over_env(monkeypatch) -> None:
    monkeypatch.setenv("AURORA_TTS_MODEL_FILE_PATH", "env.onnx")

    normalized = _normalize({"services": {"tts": {"model_file_path": "flat.onnx"}}})

    assert normalized["services"]["tts"]["providers"]["piper"]["model_file_path"] == "flat.onnx"


def test_env_alias_wins_over_generated_default_when_config_omits_value(monkeypatch) -> None:
    monkeypatch.setenv("AURORA_TTS_MODEL_FILE_PATH", "env.onnx")
    monkeypatch.setenv("AURORA_TTS_MODEL_CONFIG_FILE_PATH", "env.onnx.json")
    monkeypatch.setenv("AURORA_TTS_MODEL_SAMPLE_RATE", "24000")
    monkeypatch.setenv("PIPER_PATH", "/opt/env-piper")

    normalized = _normalize({"services": {"tts": {}}})
    piper = normalized["services"]["tts"]["providers"]["piper"]

    assert piper == {
        "model_file_path": "env.onnx",
        "model_config_file_path": "env.onnx.json",
        "model_sample_rate": 24000,
        "executable_path": "/opt/env-piper",
    }


def test_generated_defaults_apply_when_no_nested_flat_or_env(monkeypatch) -> None:
    monkeypatch.delenv("AURORA_TTS_MODEL_FILE_PATH", raising=False)
    monkeypatch.delenv("AURORA_TTS_MODEL_CONFIG_FILE_PATH", raising=False)
    monkeypatch.delenv("AURORA_TTS_MODEL_SAMPLE_RATE", raising=False)
    monkeypatch.delenv("PIPER_PATH", raising=False)

    normalized = _normalize({"services": {"tts": {}}})
    piper = normalized["services"]["tts"]["providers"]["piper"]

    assert piper["model_file_path"] == "voice_models/en_US-lessac-medium.onnx"
    assert piper["model_config_file_path"] == "voice_models/en_US-lessac-medium.onnx.txt"
    assert piper["model_sample_rate"] == 22050
    assert piper["executable_path"] == ""


def test_legacy_stt_language_wins_over_env_language_aliases(monkeypatch) -> None:
    monkeypatch.setenv("AURORA_PRIMARY_LANGUAGE", "de")
    monkeypatch.setenv("AURORA_VOICE_LANGUAGE", "auto")

    normalized = _normalize({"services": {"stt": {"language": "pt"}}})

    assert normalized["system"]["primary_language"] == "pt"
    assert normalized["system"]["voice_language"] == "pt"


def test_env_language_aliases_win_when_central_and_legacy_are_omitted(monkeypatch) -> None:
    monkeypatch.setenv("AURORA_PRIMARY_LANGUAGE", "de")
    monkeypatch.setenv("AURORA_VOICE_LANGUAGE", "fr")

    normalized = _normalize({"services": {"stt": {}}})

    assert normalized["system"]["primary_language"] == "de"
    assert normalized["system"]["voice_language"] == "fr"


def test_legacy_stt_language_env_seeds_central_language_before_defaults(monkeypatch) -> None:
    monkeypatch.setenv("STT_LANGUAGE", "pt")
    monkeypatch.setenv("AURORA_PRIMARY_LANGUAGE", "de")
    monkeypatch.setenv("AURORA_VOICE_LANGUAGE", "fr")

    normalized = _normalize({"services": {"stt": {}}})

    assert normalized["system"]["primary_language"] == "pt"
    assert normalized["system"]["voice_language"] == "pt"


def test_empty_legacy_stt_language_env_sets_voice_auto_before_defaults(monkeypatch) -> None:
    monkeypatch.setenv("STT_LANGUAGE", "")
    monkeypatch.setenv("AURORA_PRIMARY_LANGUAGE", "de")
    monkeypatch.setenv("AURORA_VOICE_LANGUAGE", "fr")

    normalized = _normalize({"services": {"stt": {}}})

    assert normalized["system"]["primary_language"] == "de"
    assert normalized["system"]["voice_language"] == "auto"


def test_legacy_stt_env_joins_single_structured_deprecation_warning(monkeypatch) -> None:
    monkeypatch.setenv("STT_LANGUAGE", "pt")
    manager = ConfigManager.__new__(ConfigManager)
    manager.config_lock = threading.RLock()
    manager._config = {}
    manager._schema = manager._get_config_schema()
    manager._speech_config_warning_emitted = False

    from app.services.config import config_manager as config_manager_module

    calls: list[str] = []
    original_warning = config_manager_module.log_warning
    config_manager_module.log_warning = lambda message, *args, **kwargs: calls.append(str(message))
    try:
        manager._normalize_config({"services": {"tts": {"model_file_path": "flat.onnx"}}})
        manager._normalize_config({"services": {"tts": {"model_file_path": "again.onnx"}}})
    finally:
        config_manager_module.log_warning = original_warning

    deprecation_calls = [
        call for call in calls if call.startswith("deprecated_speech_config_loaded")
    ]
    assert deprecation_calls == [
        "deprecated_speech_config_loaded "
        "migration_path=system.primary_language,system.voice_language,"
        "services.tts.providers.piper "
        "source=STT_LANGUAGE,flat_tts_piper persisted=false"
    ]
