"""Unit tests for backend TTS streaming service support."""

from __future__ import annotations

import asyncio
import base64
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.tts.service import TTSService
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.tts import (
    TTSAudioChunkEvent,
    TTSMethods,
    TTSStreamChunkRequest,
    TTSStreamEndRequest,
    TTSStreamStartRequest,
)
from app.shared.messaging import bus_init


@pytest.fixture
def mock_bus():
    bus = Mock()
    bus.publish = AsyncMock()
    bus_init.set_bus(bus)
    yield bus
    bus_init._bus = None


@pytest.fixture
def service(mock_bus, monkeypatch):
    svc = TTSService()
    svc.stream = Mock()
    svc.stream.stop = Mock()

    async def synthesize(text: str) -> tuple[bytes, int]:
        return f"pcm:{text}".encode(), 22050

    monkeypatch.setattr(svc, "_synthesize_to_bytes", synthesize)
    return svc


def _audio_events(mock_bus) -> list[TTSAudioChunkEvent]:
    return [
        call.args[1]
        for call in mock_bus.publish.await_args_list
        if call.args[0] == TTSMethods.AUDIO_CHUNK
    ]


def test_tts_stream_contracts_require_use_permissions():
    assert TTSService._on_tts_request._contract_metadata["required_perms"] == [TTSMethods.REQUEST]
    assert TTSService._on_stream_start._contract_metadata["required_perms"] == [
        TTSMethods.STREAM_START
    ]
    assert TTSService._on_stream_chunk._contract_metadata["required_perms"] == [
        TTSMethods.STREAM_CHUNK
    ]
    assert TTSService._on_stream_end._contract_metadata["required_perms"] == [TTSMethods.STREAM_END]
    assert TTSService.synthesize._contract_metadata["required_perms"] == [TTSMethods.SYNTHESIZE]


@pytest.mark.asyncio
async def test_stream_chunks_are_synthesized_in_sequence_when_received_out_of_order(
    service: TTSService, mock_bus
):
    await service._on_stream_start(TTSStreamStartRequest(stream_id="stream-1", format="raw"))

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="stream-1", sequence=1, text="second")
    )
    assert _audio_events(mock_bus) == []

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="stream-1", sequence=0, text="first")
    )
    await service._on_stream_end(TTSStreamEndRequest(stream_id="stream-1", final_sequence=1))

    events = _audio_events(mock_bus)
    assert [(event.sequence, event.source_sequence, event.text) for event in events] == [
        (0, 0, "first"),
        (1, 1, "second"),
        (2, None, None),
    ]
    assert base64.b64decode(events[0].audio_data) == b"pcm:first"
    assert events[0].format == "raw"
    assert events[0].sample_rate == 22050
    assert events[-1].is_final is True
    assert events[-1].sample_rate == 22050
    assert events[-1].reason == "completed"


@pytest.mark.asyncio
async def test_stream_chunk_marked_final_closes_after_ordered_drain(service: TTSService, mock_bus):
    await service._on_stream_start(TTSStreamStartRequest(stream_id="stream-final", format="raw"))

    await service._on_stream_chunk(
        TTSStreamChunkRequest(
            stream_id="stream-final",
            sequence=0,
            text="only chunk",
            is_final=True,
        )
    )

    events = _audio_events(mock_bus)
    assert [(event.sequence, event.is_final) for event in events] == [(0, False), (1, True)]
    assert "stream-final" not in service._stream_states


@pytest.mark.asyncio
async def test_stop_clears_stream_state_and_emits_terminal_audio_chunk(
    service: TTSService, mock_bus
):
    await service._on_stream_start(TTSStreamStartRequest(stream_id="stream-stop", format="raw"))
    assert "stream-stop" in service._stream_states

    await service._on_stop(EmptyInput())

    assert "stream-stop" not in service._stream_states
    events = _audio_events(mock_bus)
    assert len(events) == 1
    assert events[0].stream_id == "stream-stop"
    assert events[0].is_final is True
    assert events[0].reason == "stopped"


@pytest.mark.asyncio
async def test_stream_start_interrupt_stops_playback_and_existing_streams(
    service: TTSService, mock_bus
):
    service._playing = True
    service._current_request_id = "playback-1"
    await service._on_stream_start(TTSStreamStartRequest(stream_id="old", format="raw"))

    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="new", format="raw", interrupt=True)
    )

    service.stream.stop.assert_called_once()
    assert "old" not in service._stream_states
    assert "new" in service._stream_states
    topics = [call.args[0] for call in mock_bus.publish.await_args_list]
    assert TTSMethods.STOPPED in topics
    terminal_events = [event for event in _audio_events(mock_bus) if event.stream_id == "old"]
    assert terminal_events[-1].is_final is True
    assert terminal_events[-1].reason == "interrupted"


@pytest.mark.asyncio
async def test_stream_start_can_disable_server_audio_playback(service: TTSService):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="client-only", format="raw", play_on_server=False)
    )

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="client-only", sequence=0, text="client audio")
    )

    service.stream.feed.assert_not_called()
    service.stream.play_async.assert_not_called()


@pytest.mark.asyncio
async def test_stream_start_plays_server_audio_when_enabled(service: TTSService):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="daemon-voice", format="raw", play_on_server=True)
    )

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="daemon-voice", sequence=0, text="daemon audio")
    )
    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="daemon-voice", sequence=1, text=" continues")
    )

    assert service.stream.feed.call_args_list[0].args == ("daemon audio",)
    assert service.stream.feed.call_args_list[1].args == (" continues",)
    service.stream.play_async.assert_called_once()


@pytest.mark.asyncio
async def test_concurrent_stream_chunk_delivery_keeps_audio_order(
    service: TTSService, mock_bus, monkeypatch
):
    async def delayed_synthesize(text: str) -> tuple[bytes, int]:
        if text == "first":
            await asyncio.sleep(0.02)
        return f"pcm:{text}".encode(), 22050

    monkeypatch.setattr(service, "_synthesize_to_bytes", delayed_synthesize)

    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="stream-concurrent", format="raw")
    )
    await asyncio.gather(
        service._on_stream_chunk(
            TTSStreamChunkRequest(stream_id="stream-concurrent", sequence=0, text="first")
        ),
        service._on_stream_chunk(
            TTSStreamChunkRequest(stream_id="stream-concurrent", sequence=1, text="second")
        ),
    )
    await service._on_stream_end(
        TTSStreamEndRequest(stream_id="stream-concurrent", final_sequence=1)
    )

    events = _audio_events(mock_bus)
    assert [(event.sequence, event.text, event.is_final) for event in events] == [
        (0, "first", False),
        (1, "second", False),
        (2, None, True),
    ]
