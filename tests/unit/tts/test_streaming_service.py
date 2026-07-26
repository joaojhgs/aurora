"""Unit tests for backend TTS streaming service support."""

from __future__ import annotations

import asyncio
import base64
from unittest.mock import AsyncMock, Mock

import pytest

from app.messaging import Envelope
from app.services.tts.service import TTSService
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.tts import (
    TTSAudioChunkEvent,
    TTSMethods,
    TTSStopRequest,
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


def _envelope(
    *,
    topic: str = TTSMethods.STREAM_CHUNK,
    peer_id: str = "peer-a",
    principal_id: str = "principal-a",
    correlation_id: str = "corr-a",
) -> Envelope:
    return Envelope(
        type=topic,
        payload={},
        caller_peer_id=peer_id,
        principal_id=principal_id,
        correlation_id=correlation_id,
    )


def _audio_publish_calls(mock_bus):
    return [
        call for call in mock_bus.publish.await_args_list if call.args[0] == TTSMethods.AUDIO_CHUNK
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
    assert TTSService._on_stop._contract_metadata["input_model"] is TTSStopRequest
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
async def test_targeted_stream_emits_ordered_and_final_audio_to_calling_peer(
    service: TTSService, mock_bus
):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="peer-stream", format="raw", play_on_server=False),
        _envelope(topic=TTSMethods.STREAM_START),
    )

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="peer-stream", sequence=0, text="hello peer"),
        _envelope(),
    )
    await service._on_stream_end(
        TTSStreamEndRequest(stream_id="peer-stream", final_sequence=0),
        _envelope(topic=TTSMethods.STREAM_END),
    )

    calls = _audio_publish_calls(mock_bus)
    assert [(call.args[1].sequence, call.args[1].is_final) for call in calls] == [
        (0, False),
        (1, True),
    ]
    assert all(call.kwargs["event"] is True for call in calls)
    assert all(call.kwargs["mesh"] is True for call in calls)
    assert all(call.kwargs["caller_peer_id"] == "peer-a" for call in calls)
    assert all(call.kwargs["principal_id"] == "principal-a" for call in calls)
    assert all(call.kwargs["correlation_id"] == "corr-a" for call in calls)
    service.stream.feed.assert_not_called()
    service.stream.play_async.assert_not_called()


@pytest.mark.asyncio
async def test_local_server_playback_stream_remains_untargeted_and_unmeshed(
    service: TTSService, mock_bus
):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stt", format="raw", play_on_server=True)
    )

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="local-stt", sequence=0, text="local audio")
    )

    call = _audio_publish_calls(mock_bus)[0]
    assert call.kwargs["mesh"] is False
    assert call.kwargs["caller_peer_id"] is None
    assert call.kwargs["correlation_id"] is None
    assert service.stream.feed.call_args_list[0].args == ("local audio",)


@pytest.mark.asyncio
async def test_remote_peer_cannot_mutate_or_end_local_stream_with_colliding_id(
    service: TTSService, mock_bus
):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-collision", format="raw", play_on_server=True)
    )

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="local-collision", sequence=0, text="remote hijack"),
        _envelope(peer_id="peer-a"),
    )
    await service._on_stream_end(
        TTSStreamEndRequest(stream_id="local-collision", final_sequence=0),
        _envelope(topic=TTSMethods.STREAM_END, peer_id="peer-a"),
    )

    assert _audio_publish_calls(mock_bus) == []
    assert "local-collision" in service._stream_states
    service.stream.feed.assert_not_called()

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="local-collision", sequence=0, text="local audio")
    )
    await service._on_stream_end(TTSStreamEndRequest(stream_id="local-collision", final_sequence=0))

    events = _audio_events(mock_bus)
    assert [(event.text, event.is_final) for event in events] == [
        ("local audio", False),
        (None, True),
    ]
    assert service.stream.feed.call_args_list[0].args == ("local audio",)


@pytest.mark.asyncio
async def test_mismatched_peer_cannot_append_or_end_targeted_stream(service: TTSService, mock_bus):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="protected-stream", format="raw", play_on_server=False),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a"),
    )

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="protected-stream", sequence=0, text="wrong peer"),
        _envelope(peer_id="peer-b"),
    )
    await service._on_stream_end(
        TTSStreamEndRequest(stream_id="protected-stream", final_sequence=0),
        _envelope(topic=TTSMethods.STREAM_END, peer_id="peer-b"),
    )

    assert _audio_publish_calls(mock_bus) == []
    assert "protected-stream" in service._stream_states

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="protected-stream", sequence=0, text="right peer"),
        _envelope(peer_id="peer-a"),
    )
    await service._on_stream_end(
        TTSStreamEndRequest(stream_id="protected-stream", final_sequence=0),
        _envelope(topic=TTSMethods.STREAM_END, peer_id="peer-a"),
    )

    events = _audio_events(mock_bus)
    assert [(event.text, event.is_final) for event in events] == [
        ("right peer", False),
        (None, True),
    ]


@pytest.mark.asyncio
async def test_same_peer_wrong_correlation_cannot_end_targeted_stream(
    service: TTSService, mock_bus
):
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="protected-correlation",
            format="raw",
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-a"),
    )
    await service._on_stream_chunk(
        TTSStreamChunkRequest(
            stream_id="protected-correlation",
            sequence=0,
            text="right correlation",
            correlation_id="corr-a",
        ),
        _envelope(peer_id="peer-a", correlation_id="corr-a"),
    )

    await service._on_stream_end(
        TTSStreamEndRequest(
            stream_id="protected-correlation",
            final_sequence=0,
            correlation_id="corr-b",
        ),
        _envelope(topic=TTSMethods.STREAM_END, peer_id="peer-a", correlation_id="corr-b"),
    )

    assert "protected-correlation" in service._stream_states
    assert _audio_events(mock_bus) == [
        event for event in _audio_events(mock_bus) if not event.is_final
    ]

    await service._on_stream_end(
        TTSStreamEndRequest(
            stream_id="protected-correlation",
            final_sequence=0,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_END, peer_id="peer-a", correlation_id="corr-a"),
    )

    calls = _audio_publish_calls(mock_bus)
    assert calls[-1].args[1].is_final is True
    assert calls[-1].kwargs["caller_peer_id"] == "peer-a"
    assert calls[-1].kwargs["correlation_id"] == "corr-a"


@pytest.mark.asyncio
async def test_wrong_correlation_stream_start_cannot_interrupt_or_retarget_existing_stream(
    service: TTSService, mock_bus
):
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="start-correlation",
            format="raw",
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-a"),
    )
    original_state = service._stream_states["start-correlation"]

    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="start-correlation",
            format="wav",
            play_on_server=False,
            correlation_id="corr-b",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-b"),
    )

    assert _audio_publish_calls(mock_bus) == []
    assert service._stream_states["start-correlation"] is original_state
    assert service._stream_states["start-correlation"].correlation_id == "corr-a"
    assert service._stream_states["start-correlation"].audio_format == "raw"


@pytest.mark.asyncio
async def test_remote_interrupt_does_not_clear_local_or_other_peer_streams(
    service: TTSService, mock_bus
):
    service._playing = True
    service._current_request_id = "local-playback"
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=False)
    )
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="peer-b-stream",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-b",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-b", correlation_id="corr-b"),
    )

    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="peer-a-stream",
            format="raw",
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-a"),
    )

    assert set(service._stream_states) == {
        "local-stream",
        "peer-a-stream",
        "peer-b-stream",
    }
    assert _audio_publish_calls(mock_bus) == []
    service.stream.stop.assert_not_called()


@pytest.mark.asyncio
async def test_remote_stream_start_interrupt_clears_only_same_peer_correlation(
    service: TTSService, mock_bus
):
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="peer-a-corr-a",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-a"),
    )
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="peer-a-corr-b",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-b",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-b"),
    )

    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="peer-a-corr-b-new",
            format="raw",
            interrupt=True,
            play_on_server=False,
            correlation_id="corr-b",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-b"),
    )

    assert set(service._stream_states) == {"peer-a-corr-a", "peer-a-corr-b-new"}
    calls = _audio_publish_calls(mock_bus)
    assert len(calls) == 1
    assert calls[0].args[1].stream_id == "peer-a-corr-b"
    assert calls[0].kwargs["caller_peer_id"] == "peer-a"
    assert calls[0].kwargs["correlation_id"] == "corr-b"


@pytest.mark.asyncio
async def test_local_interrupt_does_not_clear_remote_streams(service: TTSService, mock_bus):
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="remote-stream",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-a"),
    )
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=True)
    )

    assert set(service._stream_states) == {"local-stream", "remote-stream"}
    assert _audio_publish_calls(mock_bus) == []


@pytest.mark.asyncio
async def test_external_peer_stop_targets_only_exact_correlation(service: TTSService, mock_bus):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=False)
    )
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="peer-a-corr-a",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-a"),
    )
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="peer-a-corr-b",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-b",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-b"),
    )
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="peer-b-corr-a",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-b", correlation_id="corr-a"),
    )

    await service._on_stop(
        TTSStopRequest(correlation_id="corr-a", reason="user_interrupt"),
        _envelope(topic=TTSMethods.STOP, peer_id="peer-a", correlation_id="corr-a"),
    )

    assert set(service._stream_states) == {
        "local-stream",
        "peer-a-corr-b",
        "peer-b-corr-a",
    }
    calls = _audio_publish_calls(mock_bus)
    assert len(calls) == 1
    assert calls[0].args[1].stream_id == "peer-a-corr-a"
    assert calls[0].args[1].reason == "user_interrupt"
    assert calls[0].kwargs["caller_peer_id"] == "peer-a"
    assert calls[0].kwargs["correlation_id"] == "corr-a"
    service.stream.stop.assert_not_called()


@pytest.mark.asyncio
async def test_peer_stop_without_correlation_fails_closed(service: TTSService, mock_bus):
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="peer-stream",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-a"),
    )

    await service._on_stop(
        TTSStopRequest(),
        _envelope(topic=TTSMethods.STOP, peer_id="peer-a", correlation_id=""),
    )

    assert set(service._stream_states) == {"peer-stream"}
    assert _audio_publish_calls(mock_bus) == []
    service.stream.stop.assert_not_called()


@pytest.mark.asyncio
async def test_legacy_internal_empty_stop_remains_global(service: TTSService, mock_bus):
    service._playing = True
    service._current_request_id = "local-playback"
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=False)
    )
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="remote-stream",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-a"),
    )

    await service._on_stop(EmptyInput())

    assert service._stream_states == {}
    stopped_topics = [call.args[0] for call in mock_bus.publish.await_args_list]
    assert TTSMethods.STOPPED in stopped_topics
    terminal_stream_ids = {call.args[1].stream_id for call in _audio_publish_calls(mock_bus)}
    assert terminal_stream_ids == {"local-stream", "remote-stream"}


@pytest.mark.asyncio
async def test_authenticated_no_peer_stop_does_not_collide_with_local_stream(
    service: TTSService, mock_bus
):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=False)
    )
    principal_envelope = Envelope(
        type=TTSMethods.STREAM_START,
        payload={},
        principal_id="principal-http",
        correlation_id="corr-http",
    )
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="http-stream",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-http",
        ),
        principal_envelope,
    )

    await service._on_stop(
        TTSStopRequest(correlation_id="corr-http"),
        principal_envelope.model_copy(update={"type": TTSMethods.STOP}),
    )

    assert set(service._stream_states) == {"local-stream"}
    calls = _audio_publish_calls(mock_bus)
    assert len(calls) == 1
    assert calls[0].args[1].stream_id == "http-stream"
    assert calls[0].kwargs["caller_peer_id"] is None
    assert calls[0].kwargs["principal_id"] == "principal-http"
    assert calls[0].kwargs["correlation_id"] == "corr-http"


@pytest.mark.asyncio
async def test_authenticated_no_peer_stream_start_interrupt_is_principal_scoped(
    service: TTSService, mock_bus
):
    service._playing = True
    service._current_request_id = "local-playback"
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=False)
    )
    http_corr_a = Envelope(
        type=TTSMethods.STREAM_START,
        payload={},
        principal_id="principal-http",
        correlation_id="corr-a",
    )
    http_corr_b = Envelope(
        type=TTSMethods.STREAM_START,
        payload={},
        principal_id="principal-http",
        correlation_id="corr-b",
    )
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="http-corr-a",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-a",
        ),
        http_corr_a,
    )
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="http-corr-b",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-b",
        ),
        http_corr_b,
    )

    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="http-corr-b-new",
            format="raw",
            interrupt=True,
            play_on_server=True,
            correlation_id="corr-b",
        ),
        http_corr_b,
    )

    assert set(service._stream_states) == {"local-stream", "http-corr-a", "http-corr-b-new"}
    service.stream.stop.assert_not_called()
    calls = _audio_publish_calls(mock_bus)
    assert len(calls) == 1
    assert calls[0].args[1].stream_id == "http-corr-b"
    assert calls[0].kwargs["caller_peer_id"] is None
    assert calls[0].kwargs["principal_id"] == "principal-http"
    assert calls[0].kwargs["correlation_id"] == "corr-b"


@pytest.mark.asyncio
async def test_valid_same_owner_interrupt_replaces_stream_and_emits_terminal(
    service: TTSService, mock_bus
):
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="replace-stream",
            format="raw",
            interrupt=False,
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-a"),
    )
    original_state = service._stream_states["replace-stream"]

    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="replace-stream",
            format="wav",
            interrupt=True,
            play_on_server=False,
            correlation_id="corr-a",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-a"),
    )

    calls = _audio_publish_calls(mock_bus)
    assert len(calls) == 1
    assert calls[0].args[1].stream_id == "replace-stream"
    assert calls[0].args[1].is_final is True
    assert calls[0].args[1].reason == "interrupted"
    assert calls[0].kwargs["caller_peer_id"] == "peer-a"
    assert calls[0].kwargs["correlation_id"] == "corr-a"
    assert service._stream_states["replace-stream"] is not original_state
    assert service._stream_states["replace-stream"].audio_format == "wav"
    assert service._stream_states["replace-stream"].correlation_id == "corr-a"


@pytest.mark.asyncio
async def test_targeted_stream_error_does_not_mesh_broadcast(service: TTSService, mock_bus):
    await service._on_stream_chunk(
        TTSStreamChunkRequest(
            stream_id="missing-targeted-stream",
            sequence=0,
            text="missing",
            correlation_id="corr-a",
        ),
        _envelope(peer_id="peer-a", correlation_id="corr-a"),
    )

    error_call = next(
        call for call in mock_bus.publish.await_args_list if call.args[0] == TTSMethods.ERROR
    )
    assert error_call.kwargs["mesh"] is False
    assert error_call.kwargs["caller_peer_id"] == "peer-a"
    assert error_call.kwargs["correlation_id"] == "corr-a"


@pytest.mark.asyncio
async def test_stop_emits_targeted_terminal_marker_once_and_clears_stream(
    service: TTSService, mock_bus
):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="target-stop", format="raw", play_on_server=False),
        _envelope(topic=TTSMethods.STREAM_START),
    )

    await service._on_stop(EmptyInput())
    await service._on_stop(EmptyInput())
    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="target-stop", sequence=0, text="late"),
        _envelope(),
    )

    calls = _audio_publish_calls(mock_bus)
    assert len(calls) == 1
    call = calls[0]
    assert call.args[1].is_final is True
    assert call.args[1].reason == "stopped"
    assert call.kwargs["mesh"] is True
    assert call.kwargs["caller_peer_id"] == "peer-a"
    assert call.kwargs["principal_id"] == "principal-a"
    assert call.kwargs["correlation_id"] == "corr-a"


@pytest.mark.asyncio
async def test_stop_during_in_flight_synthesis_suppresses_late_audio_chunk(
    service: TTSService, mock_bus, monkeypatch
):
    synthesis_started = asyncio.Event()
    release_synthesis = asyncio.Event()

    async def blocked_synthesize(text: str) -> tuple[bytes, int]:
        synthesis_started.set()
        await release_synthesis.wait()
        return f"pcm:{text}".encode(), 22050

    monkeypatch.setattr(service, "_synthesize_to_bytes", blocked_synthesize)
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="target-race", format="raw", play_on_server=False),
        _envelope(topic=TTSMethods.STREAM_START),
    )

    chunk_task = asyncio.create_task(
        service._on_stream_chunk(
            TTSStreamChunkRequest(stream_id="target-race", sequence=0, text="late audio"),
            _envelope(),
        )
    )
    await synthesis_started.wait()

    await service._on_stop(EmptyInput())
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="target-race", format="raw", play_on_server=False),
        _envelope(
            topic=TTSMethods.STREAM_START,
            peer_id="peer-a",
            correlation_id="corr-restarted",
        ),
    )
    release_synthesis.set()
    await chunk_task

    calls = _audio_publish_calls(mock_bus)
    assert len(calls) == 1
    terminal = calls[0]
    assert terminal.args[1].is_final is True
    assert terminal.args[1].reason == "stopped"
    assert terminal.kwargs["mesh"] is True
    assert terminal.kwargs["caller_peer_id"] == "peer-a"
    assert terminal.kwargs["principal_id"] == "principal-a"
    assert terminal.kwargs["correlation_id"] == "corr-a"
    assert [call for call in calls if not call.args[1].is_final] == []
    assert "target-race" in service._stream_states
    assert service._stream_states["target-race"].correlation_id == "corr-restarted"
    assert service._stream_states["target-race"].next_text_sequence == 0
    service.stream.feed.assert_not_called()
    service.stream.play_async.assert_not_called()


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
