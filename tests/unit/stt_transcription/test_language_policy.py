from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.stt_transcription.service import TranscriptionService
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import (
    AccurateModel,
    RealtimeModel,
    Stt,
    System,
    Transcription,
)
from app.shared.speech_language_policy import resolve_speech_language_policy


def test_resolver_fixed_language_pins_stt_and_models() -> None:
    policy = resolve_speech_language_policy("en", "pt")

    assert policy.primary_language == "en"
    assert policy.voice_language == "pt"
    assert policy.stt_language == "pt"
    assert policy.model_language == "pt"
    assert policy.is_auto is False


def test_resolver_auto_uses_primary_for_language_bound_models() -> None:
    policy = resolve_speech_language_policy("pt", "auto")

    assert policy.primary_language == "pt"
    assert policy.voice_language == "auto"
    assert policy.stt_language is None
    assert policy.model_language == "pt"
    assert policy.is_auto is True


def _stt_config(language: str = "en") -> Stt:
    return Stt(
        language=language,
        transcription=Transcription(
            realtime_model=RealtimeModel(
                enabled=True,
                model_size="tiny",
                device="cpu",
                compute_type="int8",
            ),
            accurate_model=AccurateModel(
                enabled=True,
                model_size="base",
                device="cpu",
                compute_type="int8",
            ),
        ),
    )


def _stt_config_payload(language: str = "en") -> dict:
    return _stt_config(language=language).model_dump()


@pytest.mark.asyncio
async def test_fixed_voice_language_controls_transcription_language() -> None:
    with (
        patch("app.shared.services.base_service.get_bus_singleton"),
        patch("app.services.stt_transcription.service._create_vad"),
        patch("app.services.stt_transcription.service._create_whisper_model") as create_model,
        patch("app.services.stt_transcription.service.config_api") as mock_config,
    ):
        create_model.return_value = MagicMock()

        async def aget(key, default_or_model=None, *args, **kwargs):
            if key == ConfigKeys.services.stt and kwargs.get("default") == {}:
                return _stt_config_payload()
            if default_or_model is Stt:
                return _stt_config()
            if default_or_model is System:
                return System(primary_language="en", voice_language="pt")
            raise AssertionError(f"unexpected config request: {key}")

        mock_config.aget = AsyncMock(side_effect=aget)
        service = TranscriptionService()

        await service._load_config()
        await service._load_models()

        assert service._language == "pt"
        assert service._language_policy.model_language == "pt"


@pytest.mark.asyncio
async def test_auto_voice_language_keeps_transcription_auto_with_primary_hint() -> None:
    with (
        patch("app.shared.services.base_service.get_bus_singleton"),
        patch("app.services.stt_transcription.service._create_vad"),
        patch("app.services.stt_transcription.service._create_whisper_model") as create_model,
        patch("app.services.stt_transcription.service.config_api") as mock_config,
    ):
        create_model.return_value = MagicMock()

        async def aget(key, default_or_model=None, *args, **kwargs):
            if key == ConfigKeys.services.stt and kwargs.get("default") == {}:
                return _stt_config_payload(language="fr")
            if default_or_model is Stt:
                return _stt_config(language="fr")
            if default_or_model is System:
                return System(primary_language="pt", voice_language="auto")
            raise AssertionError(f"unexpected config request: {key}")

        mock_config.aget = AsyncMock(side_effect=aget)
        service = TranscriptionService()

        await service._load_config()
        await service._load_models()

        assert service._language == ""
        assert service._language_policy.primary_language == "pt"
        assert service._language_policy.model_language == "pt"


@pytest.mark.asyncio
async def test_failed_reload_clears_failed_selected_role() -> None:
    with (
        patch("app.shared.services.base_service.get_bus_singleton"),
        patch("app.services.stt_transcription.service._create_vad"),
        patch("app.services.stt_transcription.service._create_whisper_model") as create_model,
        patch("app.services.stt_transcription.service.config_api") as mock_config,
    ):
        old_realtime = MagicMock(name="old_realtime")
        old_accurate = MagicMock(name="old_accurate")
        new_accurate = MagicMock(name="new_accurate")
        created: list[str] = []

        def create_model_side_effect(model_size: str, *args, **kwargs):
            created.append(model_size)
            if len(created) == 1:
                return old_realtime
            if len(created) == 2:
                return old_accurate
            if model_size == "tiny":
                raise RuntimeError("load failed for /private/models/tiny")
            if model_size == "base":
                return new_accurate
            raise AssertionError(f"unexpected model size: {model_size}")

        create_model.side_effect = create_model_side_effect

        async def aget(key, default_or_model=None, *args, **kwargs):
            if key == ConfigKeys.services.stt and kwargs.get("default") == {}:
                return _stt_config_payload()
            if default_or_model is Stt:
                return _stt_config()
            if default_or_model is System:
                return System(primary_language="en", voice_language="pt")
            raise AssertionError(f"unexpected config request: {key}")

        mock_config.aget = AsyncMock(side_effect=aget)
        service = TranscriptionService()
        await service._load_config()
        await service._load_models()

        service._language = "old"
        await service.reload("services.stt")

        assert service._language == "pt"
        assert service._realtime_model is None
        assert service._accurate_model is new_accurate
        assert service._model_status["realtime"] == "unavailable"
        assert service._model_status_message["realtime"] == "RuntimeError"
        assert service._model_status["accurate"] == "ready"
        assert service._model_status_message["accurate"] == "model_ready"
