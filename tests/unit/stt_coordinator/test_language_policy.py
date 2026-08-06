from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.messaging import MessageBus, TranscriptionControl
from app.services.stt_coordinator.service import STTCoordinatorService
from app.shared.config.models import (
    AmbientTranscription,
    AudioInput,
    Coordinator,
    System,
)
from app.shared.contracts.models.stt import TranscriptionMethods


def _coordinator_config() -> Coordinator:
    return Coordinator(
        session_timeout_s=5.0,
        multi_turn_enabled=False,
        pause_tts_on_listen=False,
        ambient_transcription=AmbientTranscription(enable=False),
        audio_input=AudioInput(
            sample_rate=16000,
            channels=1,
            chunk_size=1024,
            device_index=None,
        ),
    )


@contextmanager
def _service_with_config(system: System):
    bus = MagicMock(spec=MessageBus)
    bus.subscribe = MagicMock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock(return_value=MagicMock(ok=True))

    with (
        patch("app.shared.services.base_service.get_bus_singleton", return_value=bus),
        patch("app.services.stt_coordinator.service.pyaudio") as mock_pyaudio,
        patch("app.services.stt_coordinator.service.config_api") as mock_config,
    ):
        mock_pyaudio.PyAudio.return_value = MagicMock()
        mock_pyaudio.paInt16 = 8

        async def aget(key, default_or_model=None, *args, **kwargs):
            if default_or_model is Coordinator:
                return _coordinator_config()
            if default_or_model is System:
                return system
            raise AssertionError(f"unexpected config request: {key}")

        mock_config.aget = AsyncMock(side_effect=aget)
        yield STTCoordinatorService(), bus


@pytest.mark.asyncio
async def test_fixed_language_is_sent_to_transcription_on_session_start() -> None:
    with _service_with_config(System(primary_language="en", voice_language="fr")) as (
        service,
        bus,
    ):
        await service._load_config()

        await service._start_session("manual", session_id="fixed-session")

        set_language_calls = [
            call
            for call in bus.publish.call_args_list
            if call.args[:2]
            == (
                TranscriptionMethods.CONTROL,
                TranscriptionControl(action="set_language", language="fr"),
            )
        ]
        assert set_language_calls


@pytest.mark.asyncio
async def test_auto_language_sends_auto_to_transcription_with_primary_policy() -> None:
    with _service_with_config(System(primary_language="pt", voice_language="auto")) as (
        service,
        bus,
    ):
        await service._load_config()

        await service._start_session("manual", session_id="auto-session")

        assert service._language_policy.primary_language == "pt"
        assert service._language_policy.model_language == "pt"
        set_language_calls = [
            call
            for call in bus.publish.call_args_list
            if call.args[:2]
            == (
                TranscriptionMethods.CONTROL,
                TranscriptionControl(action="set_language", language=None),
            )
        ]
        assert set_language_calls
