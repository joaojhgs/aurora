from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.services.stt_wakeword.messages import WakeWordBackendType
from app.services.stt_wakeword.service import WakeWordService
from app.shared.config.models import System, Wakeword


@pytest.mark.asyncio
async def test_wakeword_uses_primary_language_policy_in_auto_mode() -> None:
    with (
        patch("app.services.stt_wakeword.service.config_api") as mock_config,
        patch("app.shared.services.base_service.get_bus_singleton"),
        patch("app.shared.path_utils.resolve_path", side_effect=lambda p: Path(p)),
    ):

        async def aget(key, default_or_model=None, *args, **kwargs):
            if default_or_model is Wakeword:
                return Wakeword(backend="oww", threshold=0.5, model_path="voice_models/jarvis.onnx")
            if default_or_model is System:
                return System(primary_language="pt", voice_language="auto")
            raise AssertionError(f"unexpected config request: {key}")

        mock_config.aget = AsyncMock(side_effect=aget)
        service = WakeWordService()

        await service._load_config()

        assert service._language_policy.model_language == "pt"


@pytest.mark.asyncio
async def test_wakeword_ignores_legacy_env_model_path(monkeypatch) -> None:
    monkeypatch.setenv("AURORA_WAKE_WORD_MODEL_PATH", "voice_models/from-env.onnx")
    with (
        patch("app.services.stt_wakeword.service.config_api") as mock_config,
        patch("app.shared.services.base_service.get_bus_singleton"),
        patch("app.shared.path_utils.resolve_path", side_effect=lambda p: Path(p)),
    ):

        async def aget(key, default_or_model=None, *args, **kwargs):
            if default_or_model is Wakeword:
                return Wakeword(
                    backend="oww",
                    threshold=0.5,
                    model_path="voice_models/from-config.onnx",
                )
            if default_or_model is System:
                return System(primary_language="en", voice_language="auto")
            raise AssertionError(f"unexpected config request: {key}")

        mock_config.aget = AsyncMock(side_effect=aget)
        service = WakeWordService()

        await service._load_config()

        assert service._wake_words == ["from-config"]
        assert service._model_paths == ["voice_models/from-config.onnx"]


@pytest.mark.asyncio
async def test_failed_reload_retains_previous_backend_and_paths() -> None:
    old_backend = Mock()
    old_backend.cleanup = AsyncMock()

    with (
        patch("app.services.stt_wakeword.service.config_api") as mock_config,
        patch("app.shared.services.base_service.get_bus_singleton"),
        patch("app.shared.path_utils.resolve_path", side_effect=lambda p: Path(p)),
        patch("app.services.stt_wakeword.service.OpenWakeWordBackend") as backend_cls,
    ):
        new_backend = Mock()
        new_backend.initialize = AsyncMock(side_effect=RuntimeError("backend failed"))
        backend_cls.return_value = new_backend

        async def aget(key, default_or_model=None, *args, **kwargs):
            if default_or_model is Wakeword:
                return Wakeword(backend="oww", threshold=0.8, model_path="voice_models/new.onnx")
            if default_or_model is System:
                return System(primary_language="pt", voice_language="auto")
            raise AssertionError(f"unexpected config request: {key}")

        mock_config.aget = AsyncMock(side_effect=aget)
        service = WakeWordService()
        service._backend = old_backend
        service._backend_type = WakeWordBackendType.OPENWAKEWORD
        service._model_paths = ["voice_models/old.onnx"]
        service._wake_words = ["old"]
        service._sensitivity = 0.4

        await service.reload("services.stt")

        assert service._backend is old_backend
        assert service._model_paths == ["voice_models/old.onnx"]
        assert service._wake_words == ["old"]
        old_backend.cleanup.assert_not_awaited()
        assert service._readiness_status == "unavailable"
        assert service._readiness_message == "models_missing"
