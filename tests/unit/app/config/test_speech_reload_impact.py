"""Reload impact metadata for centralized speech config."""

from __future__ import annotations

import threading

from app.services.config.config_manager import ConfigManager


def _manager() -> ConfigManager:
    manager = ConfigManager.__new__(ConfigManager)
    manager.config_lock = threading.RLock()
    manager._config = {}
    manager._schema = manager._get_config_schema()
    return manager


def test_central_language_changes_affect_all_speech_projection_services() -> None:
    impact = _manager().get_reload_impact(["system.voice_language"])[0]

    assert impact["reload_required"] is True
    assert impact["restart_required"] is False
    assert impact["affected_services"] == [
        "tts",
        "stt_transcription",
        "stt_wakeword",
        "stt_coordinator",
        "gateway",
    ]


def test_tts_provider_object_changes_affect_tts_and_gateway_projection() -> None:
    impact = _manager().get_reload_impact(["services.tts.providers.pockettts.quality_tier"])[0]

    assert impact["reload_required"] is True
    assert impact["restart_required"] is False
    assert impact["affected_services"] == ["tts", "gateway"]
