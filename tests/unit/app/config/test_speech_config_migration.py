"""Speech configuration migration and validation behavior."""

from __future__ import annotations

import json
import threading
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.services.config.config_manager import ConfigManager


def _manager() -> ConfigManager:
    manager = ConfigManager.__new__(ConfigManager)
    manager.config_lock = threading.RLock()
    manager._config = {}
    manager._schema = manager._get_config_schema()
    manager._speech_config_warning_emitted = False
    return manager


def _normalize(config: dict) -> dict:
    return _manager()._normalize_config(deepcopy(config))


def test_flat_piper_config_migrates_in_memory_without_mutating_source() -> None:
    source = {
        "services": {
            "tts": {
                "model_file_path": "legacy.onnx",
                "model_config_file_path": "legacy.onnx.json",
                "model_sample_rate": 16000,
                "piper_path": "/usr/bin/piper",
            }
        }
    }
    original = deepcopy(source)

    normalized = _normalize(source)

    assert source == original
    assert normalized["services"]["tts"]["providers"]["piper"] == {
        "cache_dir": "voice_models/piper",
        "model_file_path": "legacy.onnx",
        "model_config_file_path": "legacy.onnx.json",
        "model_sample_rate": 16000,
        "executable_path": "/usr/bin/piper",
    }
    assert "providers" not in source["services"]["tts"]


def test_nested_piper_config_wins_over_flat_legacy_config() -> None:
    normalized = _normalize(
        {
            "services": {
                "tts": {
                    "model_file_path": "legacy.onnx",
                    "providers": {
                        "piper": {
                            "model_file_path": "nested.onnx",
                            "model_config_file_path": "nested.onnx.json",
                            "model_sample_rate": 24000,
                            "executable_path": "/opt/piper",
                        }
                    },
                }
            }
        }
    )

    piper = normalized["services"]["tts"]["providers"]["piper"]
    assert piper["model_file_path"] == "nested.onnx"
    assert piper["model_config_file_path"] == "nested.onnx.json"
    assert piper["model_sample_rate"] == 24000
    assert piper["executable_path"] == "/opt/piper"


def test_legacy_stt_language_seeds_missing_central_speech_languages() -> None:
    normalized = _normalize({"services": {"stt": {"language": "pt"}}})

    assert normalized["system"]["primary_language"] == "pt"
    assert normalized["system"]["voice_language"] == "pt"


def test_legacy_empty_stt_language_keeps_primary_default_and_sets_voice_auto() -> None:
    normalized = _normalize({"services": {"stt": {"language": ""}}})

    assert normalized["system"]["primary_language"] == "en"
    assert normalized["system"]["voice_language"] == "auto"


def test_explicit_central_speech_language_wins_over_legacy_stt_language() -> None:
    normalized = _normalize(
        {
            "system": {"primary_language": "de", "voice_language": "auto"},
            "services": {"stt": {"language": "pt"}},
        }
    )

    assert normalized["system"]["primary_language"] == "de"
    assert normalized["system"]["voice_language"] == "auto"


def test_flat_speech_config_logs_one_structured_deprecation_warning() -> None:
    manager = _manager()

    from app.services.config import config_manager as config_manager_module

    calls: list[str] = []
    original_warning = config_manager_module.log_warning
    config_manager_module.log_warning = lambda message, *args, **kwargs: calls.append(str(message))
    try:
        manager._normalize_config({"services": {"tts": {"model_file_path": "one.onnx"}}})
        manager._normalize_config({"services": {"tts": {"model_file_path": "two.onnx"}}})
    finally:
        config_manager_module.log_warning = original_warning

    deprecation_calls = [
        call for call in calls if call.startswith("deprecated_speech_config_loaded")
    ]
    assert deprecation_calls == [
        "deprecated_speech_config_loaded "
        "migration_path=system.primary_language,system.voice_language,"
        "services.tts.providers.piper "
        "source=flat_tts_piper persisted=false"
    ]


def test_load_config_does_not_rewrite_flat_speech_config_file(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "config.json"
    payload = {"services": {"tts": {"model_file_path": "legacy.onnx"}}}
    serialized = json.dumps(payload, separators=(",", ":"))
    config_path.write_text(serialized, encoding="utf-8")
    original_instance = ConfigManager._instance
    ConfigManager._instance = None
    monkeypatch.setenv("AURORA_CONFIG_FILE", str(config_path))

    try:
        with patch(
            "app.services.config.config_manager.migrate_mesh_service_policies",
            return_value=SimpleNamespace(changed=False),
        ):
            manager = ConfigManager()
        assert manager.get("services.tts.providers.piper.model_file_path") == "legacy.onnx"
        assert config_path.read_text(encoding="utf-8") == serialized
    finally:
        ConfigManager._instance = original_instance


def test_speech_config_accepts_and_normalizes_open_language_tags() -> None:
    normalized = _normalize(
        {
            "system": {
                "primary_language": "pt_BR",
                "voice_language": "ZH-Hant-TW",
            }
        }
    )

    assert normalized["system"]["primary_language"] == "pt-br"
    assert normalized["system"]["voice_language"] == "zh-hant-tw"


@pytest.mark.parametrize("tag", ["-en", "en--US", "en US", "x"])
def test_speech_config_rejects_malformed_language(tag: str) -> None:
    with pytest.raises(ValueError, match="system.primary_language"):
        _normalize({"system": {"primary_language": tag}})


def test_speech_config_rejects_unknown_new_provider_field() -> None:
    with pytest.raises(ValueError, match="services.tts.providers.piper"):
        _normalize({"services": {"tts": {"providers": {"piper": {"surprise": True}}}}})


@pytest.mark.parametrize(
    ("payload", "match"),
    [
        (
            {"services": {"tts": {"providers": []}}},
            "services.tts.providers",
        ),
        (
            {"services": {"tts": {"providers": {"piper": []}}}},
            "services.tts.providers.piper",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": []}}}},
            "services.tts.providers.pockettts",
        ),
        (
            {"services": {"tts": {"voice_registry": []}}},
            "services.tts.voice_registry",
        ),
    ],
)
def test_malformed_canonical_speech_objects_are_rejected_before_defaults(
    payload: dict, match: str
) -> None:
    with pytest.raises(ValueError, match=match):
        _normalize(payload)


@pytest.mark.parametrize(
    ("payload", "match"),
    [
        (
            {"system": {"primary_language": 42}},
            "system.primary_language",
        ),
        (
            {"system": {"voice_language": ["en"]}},
            "system.voice_language",
        ),
        (
            {"services": {"tts": {"providers": {"piper": {"model_sample_rate": 7999}}}}},
            "model_sample_rate",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"quality_tier": "ultra"}}}}},
            "quality_tier",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"device": "cuda"}}}}},
            "device",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"max_concurrent_requests": 2}}}}},
            "max_concurrent_requests",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"request_timeout_s": 0}}}}},
            "request_timeout_s",
        ),
        (
            {"services": {"tts": {"voice_registry": {"accepted_import_formats": ["wav", "exe"]}}}},
            "accepted_import_formats",
        ),
    ],
)
def test_invalid_speech_schema_values_are_strictly_rejected(payload: dict, match: str) -> None:
    with pytest.raises(ValueError, match=match):
        _normalize(payload)


@pytest.mark.parametrize(
    ("payload", "match"),
    [
        (
            {"services": {"tts": {"default_voice_id": 12}}},
            "services.tts.default_voice_id",
        ),
        (
            {"services": {"tts": {"providers": {"piper": {"model_file_path": 12}}}}},
            "services.tts.providers.piper.model_file_path",
        ),
        (
            {"services": {"tts": {"providers": {"piper": {"model_config_file_path": False}}}}},
            "services.tts.providers.piper.model_config_file_path",
        ),
        (
            {"services": {"tts": {"providers": {"piper": {"executable_path": []}}}}},
            "services.tts.providers.piper.executable_path",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"custom_config_path": 12}}}}},
            "services.tts.providers.pockettts.custom_config_path",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"cache_dir": False}}}}},
            "services.tts.providers.pockettts.cache_dir",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"voice_state_dir": []}}}}},
            "services.tts.providers.pockettts.voice_state_dir",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"preload_model": "yes"}}}}},
            "services.tts.providers.pockettts.preload_model",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"preload_voice_ids": "v1"}}}}},
            "services.tts.providers.pockettts.preload_voice_ids",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"preload_voice_ids": [7]}}}}},
            "services.tts.providers.pockettts.preload_voice_ids.0",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"temperature": "warm"}}}}},
            "services.tts.providers.pockettts.temperature",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"noise_clamp": "quiet"}}}}},
            "services.tts.providers.pockettts.noise_clamp",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"eos_threshold": "low"}}}}},
            "services.tts.providers.pockettts.eos_threshold",
        ),
        (
            {"services": {"tts": {"providers": {"pockettts": {"quantize": "false"}}}}},
            "services.tts.providers.pockettts.quantize",
        ),
        (
            {"services": {"tts": {"voice_registry": {"manifest_path": False}}}},
            "services.tts.voice_registry.manifest_path",
        ),
        (
            {"services": {"tts": {"voice_registry": {"asset_base_url": 42}}}},
            "services.tts.voice_registry.asset_base_url",
        ),
        (
            {"services": {"tts": {"voice_registry": {"cache_dir": []}}}},
            "services.tts.voice_registry.cache_dir",
        ),
        (
            {"services": {"tts": {"voice_registry": {"verify_sha256": "yes"}}}},
            "services.tts.voice_registry.verify_sha256",
        ),
        (
            {"services": {"tts": {"voice_registry": {"standard_pack_enabled": "true"}}}},
            "services.tts.voice_registry.standard_pack_enabled",
        ),
        (
            {"services": {"tts": {"voice_registry": {"cloning_enabled": "true"}}}},
            "services.tts.voice_registry.cloning_enabled",
        ),
        (
            {"services": {"tts": {"voice_registry": {"retain_clone_source": "false"}}}},
            "services.tts.voice_registry.retain_clone_source",
        ),
        (
            {"services": {"tts": {"voice_registry": {"clone_min_duration_s": "6"}}}},
            "services.tts.voice_registry.clone_min_duration_s",
        ),
        (
            {"services": {"tts": {"voice_registry": {"clone_max_duration_s": []}}}},
            "services.tts.voice_registry.clone_max_duration_s",
        ),
        (
            {"services": {"tts": {"voice_registry": {"clone_max_source_bytes": 1.5}}}},
            "services.tts.voice_registry.clone_max_source_bytes",
        ),
        (
            {"services": {"tts": {"voice_registry": {"clone_max_wire_bytes": "2097152"}}}},
            "services.tts.voice_registry.clone_max_wire_bytes",
        ),
        (
            {"services": {"tts": {"voice_registry": {"accepted_import_formats": "wav"}}}},
            "services.tts.voice_registry.accepted_import_formats",
        ),
        (
            {"services": {"tts": {"voice_registry": {"accepted_import_formats": [7]}}}},
            "services.tts.voice_registry.accepted_import_formats",
        ),
    ],
)
def test_new_speech_schema_type_errors_fail_closed(payload: dict, match: str) -> None:
    with pytest.raises(ValueError, match=match):
        _normalize(payload)


def test_unrelated_schema_violations_remain_advisory_for_compatibility() -> None:
    manager = _manager()

    from app.services.config import config_manager as config_manager_module

    calls: list[str] = []
    original_warning = config_manager_module.log_warning
    config_manager_module.log_warning = lambda message, *args, **kwargs: calls.append(str(message))
    try:
        manager._validate_config({"ui": {"window_width": -1}})
    finally:
        config_manager_module.log_warning = original_warning

    assert any("JSON Schema constraint violation" in call for call in calls)


def test_unknown_fields_outside_new_speech_objects_stay_compatible() -> None:
    manager = _manager()
    manager._validate_config({"ui": {"activate": False, "unknown_future_key": True}})


def test_invalid_speech_change_rolls_back_in_memory_and_on_disk(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({"services": {"tts": {"provider": "piper"}}}),
        encoding="utf-8",
    )
    original_instance = ConfigManager._instance
    ConfigManager._instance = None
    monkeypatch.setenv("AURORA_CONFIG_FILE", str(config_path))

    try:
        manager = ConfigManager()
        before = json.loads(config_path.read_text(encoding="utf-8"))
        with pytest.raises(ValueError, match="services.tts.provider"):
            manager.set("services.tts.provider", "not-a-provider")
        assert manager.get("services.tts.provider") == "piper"
        assert json.loads(config_path.read_text(encoding="utf-8")) == before
    finally:
        ConfigManager._instance = original_instance
