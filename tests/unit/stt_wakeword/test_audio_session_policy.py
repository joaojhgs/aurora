"""Tests for WakeWord.ProcessAudio audio session policy."""

# ruff: noqa: E402

import sys
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

sys.modules["openwakeword"] = MagicMock()
sys.modules["openwakeword.model"] = MagicMock()
sys.modules["pvporcupine"] = MagicMock()

from app.messaging import MessageBus
from app.messaging.bus import QueryResult
from app.services.stt_wakeword.service import WakeWordService
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.stt import AudioSessionMethods, STTAudioChunk


@pytest.fixture
def mock_bus():
    bus = Mock(spec=MessageBus)
    bus.publish = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True))
    return bus


@pytest.fixture
def service(mock_bus):
    with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
        service = WakeWordService()
        service._process_audio_data = AsyncMock()
        yield service


def _chunk(**overrides):
    data = {
        "data": b"\x00\x01" * 160,
        "sample_rate": 16000,
        "channels": 1,
        "format": "pcm_s16le",
        "mesh_selector": MeshAddressSelector(peer_id="peer-a", hardware_target="mic"),
        "session_id": "session-1",
        "consent_token": "token-1",
        "caller_peer_id": "caller-peer",
        "target_peer_id": "peer-a",
        "correlation_id": "corr-1",
    }
    data.update(overrides)
    return STTAudioChunk(**data)


@pytest.mark.asyncio
async def test_wakeword_streaming_denies_missing_selector(service, mock_bus):
    with pytest.raises(PermissionError, match="explicit mesh selector"):
        await service._on_external_audio(_chunk(mesh_selector=None))

    mock_bus.request.assert_not_called()
    mock_bus.publish.assert_awaited_once()
    event = mock_bus.publish.call_args.args[1]
    assert event.event_type == "stream_denied"
    assert event.payload["reason"] == "selector_required"


@pytest.mark.asyncio
async def test_wakeword_streaming_denies_missing_consent_token(service, mock_bus):
    with pytest.raises(PermissionError, match="consent token"):
        await service._on_external_audio(_chunk(consent_token=None))

    mock_bus.request.assert_not_called()
    event = mock_bus.publish.call_args.args[1]
    assert event.payload["reason"] == "consent_token_required"


@pytest.mark.asyncio
async def test_wakeword_streaming_validates_session_and_accepts_chunk(service, mock_bus):
    await service._on_external_audio(_chunk())

    mock_bus.request.assert_awaited_once()
    assert mock_bus.request.call_args.args[0] == AudioSessionMethods.START
    request = mock_bus.request.call_args.args[1]
    assert request.session_id == "session-1"
    assert request.consent_token == "token-1"
    service._process_audio_data.assert_awaited_once()
    assert mock_bus.publish.call_args.args[0] == AudioSessionMethods.EVENTS
    assert mock_bus.publish.call_args.args[1].event_type == "wakeword_audio_accepted"


@pytest.mark.asyncio
async def test_wakeword_streaming_rejects_invalid_sample_format(service, mock_bus):
    with pytest.raises(ValueError, match="sample_rate"):
        await service._on_external_audio(_chunk(sample_rate=96000))

    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_wakeword_streaming_denies_failed_session_validation(service, mock_bus):
    mock_bus.request.return_value = QueryResult(ok=False, error="expired")

    with pytest.raises(PermissionError, match="expired"):
        await service._on_external_audio(_chunk())

    event = mock_bus.publish.call_args.args[1]
    assert event.event_type == "stream_denied"
    assert event.payload["reason"] == "expired"
