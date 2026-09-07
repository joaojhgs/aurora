"""Unit tests for backend TTS streaming service support."""

from __future__ import annotations

import asyncio
import base64
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import Envelope
from app.services.tts.service import TTSService
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.tts import (
    TTSAudioChunkEvent,
    TTSMethods,
    TTSRequest,
    TTSStopRequest,
    TTSStreamChunkRequest,
    TTSStreamEndRequest,
    TTSStreamPrepareRequest,
    TTSStreamPrepareResponse,
    TTSStreamStartRequest,
    TTSSynthesizeRequest,
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
    synth_requests: list[dict[str, object]] = []
    svc.test_synth_requests = synth_requests

    async def synthesize(text: str, **kwargs) -> tuple[bytes, int]:
        synth_requests.append({"text": text, **kwargs})
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
    peer_id: str | None = "peer-a",
    principal_id: str | None = "principal-a",
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


def _logged_messages(mock_log) -> str:
    return "\n".join(str(call.args[0]) for call in mock_log.call_args_list)


async def _start_external_stream(
    service: TTSService,
    *,
    stream_id: str,
    peer_id: str | None = "peer-a",
    principal_id: str | None = "principal-a",
    correlation_id: str = "corr-a",
    voice: str | None = None,
    language: str | None = None,
) -> tuple[TTSStreamPrepareResponse, Envelope]:
    """Exercise the required prepare/start handshake for routed streams."""
    envelope = _envelope(
        topic=TTSMethods.STREAM_START,
        peer_id=peer_id,
        principal_id=principal_id,
        correlation_id=correlation_id,
    )
    admission = await service.prepare_speech_stream(
        TTSStreamPrepareRequest(
            operation_id=f"operation-{stream_id}",
            attempt_id=f"attempt-{stream_id}",
            request_id=f"request-{stream_id}",
            generation=0,
            config_revision=0,
            route_revision="route-1",
            capability_revision=0,
            voice=voice,
            language=language,
        ),
        envelope,
    )
    assert admission.status == "admitted"
    assert admission.session_id is not None
    session_id = admission.session_id
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id=session_id,
            format="wav",
            interrupt=False,
            play_on_server=False,
            voice=voice,
            language=language,
            correlation_id=correlation_id,
        ),
        envelope,
    )
    return admission, envelope


async def _external_chunk(
    service: TTSService,
    admission: TTSStreamPrepareResponse,
    envelope: Envelope,
    *,
    sequence: int,
    text: str,
    is_final: bool = False,
) -> None:
    assert admission.session_id is not None
    await service._on_stream_chunk(
        TTSStreamChunkRequest(
            stream_id=admission.session_id,
            session_id=admission.session_id,
            attempt_id=admission.attempt_id,
            generation=admission.generation,
            sequence=sequence,
            text=text,
            is_final=is_final,
        ),
        envelope,
    )


async def _external_end(
    service: TTSService,
    admission: TTSStreamPrepareResponse,
    envelope: Envelope,
    *,
    final_sequence: int | None,
    correlation_id: str | None = None,
) -> None:
    assert admission.session_id is not None
    await service._on_stream_end(
        TTSStreamEndRequest(
            stream_id=admission.session_id,
            final_sequence=final_sequence,
            correlation_id=correlation_id,
        ),
        envelope,
    )


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
async def test_tts_service_logs_text_metadata_without_private_speech(service: TTSService, mock_bus):
    private_text = "read my private recovery phrase aloud"

    with patch("app.services.tts.service.log_info") as mock_log_info:
        await service._on_tts_request(TTSRequest(text=private_text))

    logged = _logged_messages(mock_log_info)
    assert private_text not in logged
    assert "text_chars=37" in logged
    assert "interrupt=True" in logged
    assert "Playing TTS" in logged

    started_events = [
        call.args[1]
        for call in mock_bus.publish.await_args_list
        if call.args[0] == TTSMethods.STARTED
    ]
    assert started_events
    assert started_events[-1].text == private_text


@pytest.mark.asyncio
async def test_tts_synthesize_logs_metadata_without_private_speech(service: TTSService):
    private_text = "convert this private sentence into audio"

    with patch("app.services.tts.service.log_info") as mock_log_info:
        response = await service.synthesize(TTSSynthesizeRequest(text=private_text, format="raw"))

    logged = _logged_messages(mock_log_info)
    assert private_text not in logged
    assert "text_chars=40" in logged
    assert "format=raw" in logged
    assert response.text == private_text


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
        (0, 0, None),
        (1, 1, None),
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
async def test_stream_synthesis_receives_logical_voice_speed_and_sample_rate(service: TTSService):
    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id="voice-stream",
            voice="standard:test:voice-a",
            speed=0.8,
            sample_rate=24000,
            format="raw",
            play_on_server=False,
        )
    )

    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="voice-stream", sequence=0, text="voice audio")
    )

    assert service.test_synth_requests[-1]["text"] == "voice audio"
    assert service.test_synth_requests[-1]["voice"] == "standard:test:voice-a"
    assert service.test_synth_requests[-1]["speed"] == 0.8
    assert service.test_synth_requests[-1]["sample_rate"] == 24000
    assert service.test_synth_requests[-1]["request_id"] == "voice-stream:0"


@pytest.mark.asyncio
async def test_targeted_stream_emits_ordered_and_final_audio_to_calling_peer(
    service: TTSService, mock_bus
):
    admission, envelope = await _start_external_stream(service, stream_id="peer-stream")
    await _external_chunk(service, admission, envelope, sequence=0, text="hello peer")
    await _external_end(service, admission, envelope, final_sequence=0)

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
async def test_external_stream_requires_prepare_before_legacy_frames(service: TTSService, mock_bus):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="unprepared-stream", format="raw", play_on_server=False),
        _envelope(topic=TTSMethods.STREAM_START),
    )

    assert "unprepared-stream" not in service._stream_states
    assert any(call.args[0] == TTSMethods.ERROR for call in mock_bus.publish.await_args_list)


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
        (None, False),
        (None, True),
    ]
    assert service.stream.feed.call_args_list[0].args == ("local audio",)


@pytest.mark.asyncio
async def test_mismatched_peer_cannot_append_or_end_targeted_stream(service: TTSService, mock_bus):
    admission, envelope = await _start_external_stream(
        service, stream_id="protected-stream", peer_id="peer-a"
    )
    assert admission.session_id is not None

    await service._on_stream_chunk(
        TTSStreamChunkRequest(
            stream_id=admission.session_id,
            session_id=admission.session_id,
            attempt_id=admission.attempt_id,
            generation=admission.generation,
            sequence=0,
            text="wrong peer",
        ),
        _envelope(peer_id="peer-b"),
    )
    await service._on_stream_end(
        TTSStreamEndRequest(stream_id=admission.session_id, final_sequence=0),
        _envelope(topic=TTSMethods.STREAM_END, peer_id="peer-b"),
    )

    assert _audio_publish_calls(mock_bus) == []
    assert admission.session_id in service._stream_states

    await _external_chunk(service, admission, envelope, sequence=0, text="right peer")
    await _external_end(service, admission, envelope, final_sequence=0)

    events = _audio_events(mock_bus)
    assert [(event.text, event.is_final) for event in events] == [
        (None, False),
        (None, True),
    ]


@pytest.mark.asyncio
async def test_same_peer_different_request_correlation_can_end_targeted_stream(
    service: TTSService, mock_bus
):
    admission, envelope = await _start_external_stream(
        service,
        stream_id="protected-correlation",
        peer_id="peer-a",
        correlation_id="corr-a",
    )
    await _external_chunk(service, admission, envelope, sequence=0, text="right correlation")

    await service._on_stream_end(
        TTSStreamEndRequest(
            stream_id=admission.session_id,
            final_sequence=0,
            correlation_id="corr-b",
        ),
        _envelope(topic=TTSMethods.STREAM_END, peer_id="peer-a", correlation_id="corr-b"),
    )

    calls = _audio_publish_calls(mock_bus)
    assert calls[-1].args[1].is_final is True
    assert calls[-1].kwargs["caller_peer_id"] == "peer-a"
    assert calls[-1].kwargs["correlation_id"] == "corr-a"


@pytest.mark.asyncio
async def test_prepared_stream_start_is_idempotent_across_request_correlations(
    service: TTSService, mock_bus
):
    admission, envelope = await _start_external_stream(
        service,
        stream_id="start-correlation",
        peer_id="peer-a",
        correlation_id="corr-a",
    )
    assert admission.session_id is not None
    original_state = service._stream_states[admission.session_id]

    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id=admission.session_id,
            format="wav",
            play_on_server=False,
            correlation_id="corr-b",
        ),
        _envelope(topic=TTSMethods.STREAM_START, peer_id="peer-a", correlation_id="corr-b"),
    )

    assert _audio_publish_calls(mock_bus) == []
    assert service._stream_states[admission.session_id] is original_state
    assert service._stream_states[admission.session_id].correlation_id == "corr-a"
    assert service._stream_states[admission.session_id].audio_format == "wav"


@pytest.mark.asyncio
async def test_remote_interrupt_does_not_clear_local_or_other_peer_streams(
    service: TTSService, mock_bus
):
    service._playing = True
    service._current_request_id = "local-playback"
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=False)
    )
    peer_b_admission, _ = await _start_external_stream(
        service, stream_id="peer-b-stream", peer_id="peer-b", correlation_id="corr-b"
    )
    peer_a_admission, _ = await _start_external_stream(
        service, stream_id="peer-a-stream", peer_id="peer-a", correlation_id="corr-a"
    )

    assert set(service._stream_states) == {
        "local-stream",
        peer_a_admission.session_id,
        peer_b_admission.session_id,
    }
    assert _audio_publish_calls(mock_bus) == []
    service.stream.stop.assert_not_called()


@pytest.mark.asyncio
async def test_remote_stream_start_interrupt_clears_only_same_peer_correlation(
    service: TTSService, mock_bus
):
    first_admission, _ = await _start_external_stream(
        service, stream_id="peer-a-corr-a", peer_id="peer-a", correlation_id="corr-a"
    )
    second_admission, _ = await _start_external_stream(
        service, stream_id="peer-a-corr-b", peer_id="peer-a", correlation_id="corr-b"
    )

    # A routed stream cannot opt into server playback/interruption after admission.
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

    assert set(service._stream_states) == {first_admission.session_id, second_admission.session_id}
    assert _audio_publish_calls(mock_bus) == []


@pytest.mark.asyncio
async def test_local_interrupt_does_not_clear_remote_streams(service: TTSService, mock_bus):
    remote_admission, _ = await _start_external_stream(
        service, stream_id="remote-stream", peer_id="peer-a", correlation_id="corr-a"
    )
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=True)
    )

    assert set(service._stream_states) == {"local-stream", remote_admission.session_id}
    assert _audio_publish_calls(mock_bus) == []


@pytest.mark.asyncio
async def test_external_peer_stop_targets_only_exact_correlation(service: TTSService, mock_bus):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=False)
    )
    peer_a_corr_a, _ = await _start_external_stream(
        service, stream_id="peer-a-corr-a", peer_id="peer-a", correlation_id="corr-a"
    )
    peer_a_corr_b, _ = await _start_external_stream(
        service, stream_id="peer-a-corr-b", peer_id="peer-a", correlation_id="corr-b"
    )
    peer_b_corr_a, _ = await _start_external_stream(
        service, stream_id="peer-b-corr-a", peer_id="peer-b", correlation_id="corr-a"
    )

    await service._on_stop(
        TTSStopRequest(correlation_id="corr-a", reason="user_interrupt"),
        _envelope(topic=TTSMethods.STOP, peer_id="peer-a", correlation_id="corr-a"),
    )

    assert set(service._stream_states) == {
        "local-stream",
        peer_a_corr_b.session_id,
        peer_b_corr_a.session_id,
    }
    calls = _audio_publish_calls(mock_bus)
    assert len(calls) == 1
    assert calls[0].args[1].stream_id == peer_a_corr_a.session_id
    assert calls[0].args[1].reason == "user_interrupt"
    assert calls[0].kwargs["caller_peer_id"] == "peer-a"
    assert calls[0].kwargs["correlation_id"] == "corr-a"
    service.stream.stop.assert_not_called()


@pytest.mark.asyncio
async def test_peer_stop_without_correlation_fails_closed(service: TTSService, mock_bus):
    admission, _ = await _start_external_stream(
        service, stream_id="peer-stream", peer_id="peer-a", correlation_id="corr-a"
    )

    await service._on_stop(
        TTSStopRequest(),
        _envelope(topic=TTSMethods.STOP, peer_id="peer-a", correlation_id=""),
    )

    assert set(service._stream_states) == {admission.session_id}
    assert _audio_publish_calls(mock_bus) == []
    service.stream.stop.assert_not_called()


@pytest.mark.asyncio
async def test_legacy_internal_empty_stop_remains_global(service: TTSService, mock_bus):
    service._playing = True
    service._current_request_id = "local-playback"
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=False)
    )
    remote_admission, _ = await _start_external_stream(
        service, stream_id="remote-stream", peer_id="peer-a", correlation_id="corr-a"
    )

    await service._on_stop(EmptyInput())

    assert service._stream_states == {}
    stopped_topics = [call.args[0] for call in mock_bus.publish.await_args_list]
    assert TTSMethods.STOPPED in stopped_topics
    terminal_stream_ids = {call.args[1].stream_id for call in _audio_publish_calls(mock_bus)}
    assert terminal_stream_ids == {"local-stream", remote_admission.session_id}


@pytest.mark.asyncio
async def test_authenticated_no_peer_stop_does_not_collide_with_local_stream(
    service: TTSService, mock_bus
):
    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="local-stream", format="raw", interrupt=False)
    )
    admission, principal_envelope = await _start_external_stream(
        service,
        stream_id="http-stream",
        peer_id=None,
        principal_id="principal-http",
        correlation_id="corr-http",
    )

    await service._on_stop(
        TTSStopRequest(correlation_id="corr-http"),
        principal_envelope.model_copy(update={"type": TTSMethods.STOP}),
    )

    assert set(service._stream_states) == {"local-stream"}
    calls = _audio_publish_calls(mock_bus)
    assert len(calls) == 1
    assert calls[0].args[1].stream_id == admission.session_id
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
    first_admission, _ = await _start_external_stream(
        service,
        stream_id="http-corr-a",
        peer_id=None,
        principal_id="principal-http",
        correlation_id="corr-a",
    )
    second_admission, http_corr_b = await _start_external_stream(
        service,
        stream_id="http-corr-b",
        peer_id=None,
        principal_id="principal-http",
        correlation_id="corr-b",
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

    assert set(service._stream_states) == {
        "local-stream",
        first_admission.session_id,
        second_admission.session_id,
    }
    service.stream.stop.assert_not_called()
    assert _audio_publish_calls(mock_bus) == []


@pytest.mark.asyncio
async def test_prepared_stream_rejects_legacy_interrupt_replacement(service: TTSService, mock_bus):
    admission, envelope = await _start_external_stream(
        service, stream_id="replace-stream", peer_id="peer-a", correlation_id="corr-a"
    )
    assert admission.session_id is not None
    original_state = service._stream_states[admission.session_id]

    await service._on_stream_start(
        TTSStreamStartRequest(
            stream_id=admission.session_id,
            format="wav",
            interrupt=True,
            play_on_server=False,
            correlation_id="corr-a",
        ),
        envelope,
    )

    assert _audio_publish_calls(mock_bus) == []
    assert service._stream_states[admission.session_id] is original_state


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
    admission, envelope = await _start_external_stream(
        service, stream_id="target-stop", peer_id="peer-a", principal_id="principal-a"
    )

    await service._on_stop(EmptyInput())
    await service._on_stop(EmptyInput())
    await service._on_stream_chunk(
        TTSStreamChunkRequest(
            stream_id=admission.session_id,
            session_id=admission.session_id,
            attempt_id=admission.attempt_id,
            generation=admission.generation,
            sequence=0,
            text="late",
        ),
        envelope,
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

    async def blocked_synthesize(text: str, **kwargs) -> tuple[bytes, int]:
        synthesis_started.set()
        await release_synthesis.wait()
        return f"pcm:{text}".encode(), 22050

    monkeypatch.setattr(service, "_synthesize_to_bytes", blocked_synthesize)
    admission, envelope = await _start_external_stream(
        service, stream_id="target-race", peer_id="peer-a", principal_id="principal-a"
    )

    chunk_task = asyncio.create_task(
        service._on_stream_chunk(
            TTSStreamChunkRequest(
                stream_id=admission.session_id,
                session_id=admission.session_id,
                attempt_id=admission.attempt_id,
                generation=admission.generation,
                sequence=0,
                text="late audio",
            ),
            envelope,
        )
    )
    await synthesis_started.wait()

    await service._on_stop(EmptyInput())
    restarted_admission, _ = await _start_external_stream(
        service,
        stream_id="target-race-restarted",
        peer_id="peer-a",
        principal_id="principal-a",
        correlation_id="corr-restarted",
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
    assert restarted_admission.session_id in service._stream_states
    assert service._stream_states[restarted_admission.session_id].correlation_id == "corr-restarted"
    assert service._stream_states[restarted_admission.session_id].next_text_sequence == 0
    service.stream.feed.assert_not_called()
    service.stream.play_async.assert_not_called()


@pytest.mark.asyncio
async def test_concurrent_stream_chunk_delivery_keeps_audio_order(
    service: TTSService, mock_bus, monkeypatch
):
    async def delayed_synthesize(text: str, **kwargs) -> tuple[bytes, int]:
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
        (0, None, False),
        (1, None, False),
        (2, None, True),
    ]
