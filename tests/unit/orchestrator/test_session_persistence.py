"""Focused orchestrator tests for persisted principal chat sessions."""

from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import Envelope, MessageBus, QueryResult
from app.services.orchestrator.service import OrchestratorService
from app.shared.contracts.models.db import (
    DBMethods,
    DBSaveMessageResponse,
    DBSessionRecord,
    DBSessionResponse,
)
from app.shared.contracts.models.orchestrator import AssistantStreamEvent, OrchestratorMethods
from app.shared.messaging.models.stt_coordinator_models import STTUserSpeechCaptured


def _session(session_id: str = "chat-session", principal_id: str = "user-1") -> DBSessionRecord:
    return DBSessionRecord(
        id=session_id,
        principal_id=principal_id,
        type="chat",
        title=None,
        created_at="2026-07-11T12:00:00+00:00",
        updated_at="2026-07-11T12:00:00+00:00",
        last_active_at="2026-07-11T12:00:00+00:00",
        message_count=0,
    )


def _service(monkeypatch: pytest.MonkeyPatch) -> tuple[OrchestratorService, Mock]:
    bus = Mock(spec=MessageBus)
    bus.subscribe = Mock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock()
    monkeypatch.setattr(
        "app.shared.services.base_service.get_bus_singleton",
        lambda: bus,
    )
    return OrchestratorService(), bus


@pytest.mark.asyncio
async def test_local_external_chat_persists_both_turns_for_envelope_principal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A local thin client writes user and assistant rows to its owned chat session."""

    service, bus = _service(monkeypatch)
    graph = Mock()
    graph.stream_graph_updates = AsyncMock(return_value="Persisted answer")
    service.orchestrator = graph
    session = _session()

    async def request(topic, payload, **_kwargs):
        if topic == DBMethods.ENSURE_SESSION:
            return QueryResult(ok=True, data=DBSessionResponse(session=session))
        if topic == DBMethods.SAVE_MESSAGE:
            return QueryResult(ok=True, data=DBSaveMessageResponse(message_id=0, success=True))
        raise AssertionError(f"unexpected DB request: {topic}")

    bus.request.side_effect = request
    with patch.object(
        service,
        "_assistant_response_metadata",
        new_callable=AsyncMock,
        return_value={},
    ):
        response = await service._process_input(
            "Persist this",
            source="external",
            session_id=session.id,
            return_response=True,
            caller_principal_id=session.principal_id,
            caller_identity_source="gateway_http",
        )

    assert response == "Persisted answer"
    db_calls = [call for call in bus.request.await_args_list if call.args[0].startswith("DB.")]
    assert [call.args[0] for call in db_calls] == [
        DBMethods.ENSURE_SESSION,
        DBMethods.SAVE_MESSAGE,
        DBMethods.SAVE_MESSAGE,
    ]
    ensure = db_calls[0].args[1]
    user_message = db_calls[1].args[1]
    assistant_message = db_calls[2].args[1]
    assert ensure.principal_id == "user-1"
    assert ensure.type == "chat"
    assert ensure.session_id == "chat-session"
    assert (user_message.role, user_message.content) == ("user", "Persist this")
    assert (assistant_message.role, assistant_message.content) == (
        "assistant",
        "Persisted answer",
    )
    assert user_message.principal_id == assistant_message.principal_id == "user-1"
    assert user_message.session_type == assistant_message.session_type == "chat"
    assert user_message.metadata == {"source_type": "Text"}
    assert assistant_message.metadata == {
        "source_type": "Text",
        "execution": "local",
        "source": "external",
        "stream": False,
        "session_id": "chat-session",
    }

    response_publish = next(
        call for call in bus.publish.await_args_list if call.args[0] == OrchestratorMethods.RESPONSE
    )
    assert response_publish.kwargs["principal_id"] == "user-1"
    assert response_publish.kwargs["mesh"] is False


@pytest.mark.asyncio
async def test_rejected_session_ownership_does_not_run_the_graph(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A principal cannot fall through to an ephemeral graph thread on DB rejection."""

    service, bus = _service(monkeypatch)
    graph = Mock()
    graph.stream_graph_updates = AsyncMock(return_value="must not run")
    service.orchestrator = graph
    bus.request.return_value = QueryResult(
        ok=False,
        error="session belongs to another principal",
    )

    response = await service._process_input(
        "Do not cross principals",
        source="external",
        session_id="owned-by-someone-else",
        return_response=True,
        caller_principal_id="user-2",
        caller_identity_source="gateway_http",
    )

    assert response == "Error: session belongs to another principal"
    graph.stream_graph_updates.assert_not_awaited()
    failure_publish = next(
        call for call in bus.publish.await_args_list if call.args[0] == OrchestratorMethods.RESPONSE
    )
    assert failure_publish.kwargs["principal_id"] == "user-2"
    assert failure_publish.kwargs["mesh"] is False


@pytest.mark.asyncio
async def test_wakeword_uses_resolved_active_session_and_persists_voice_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Daemon STT uses the DB-resolved active chat rather than its audio session ID."""

    service, bus = _service(monkeypatch)
    active_session = _session("active-chat", "user-a")

    class StreamingGraph:
        async def stream_graph_events(self, *_args, **_kwargs):
            yield AssistantStreamEvent(
                kind="assistant.completed",
                text="Voice answer",
                is_final=True,
            )

    service.orchestrator = StreamingGraph()

    async def request(topic, payload, **_kwargs):
        if topic == DBMethods.RESOLVE_DAEMON_SESSION:
            assert payload.type == "chat"
            assert payload.stale_after_seconds == 86_400
            return QueryResult(ok=True, data=DBSessionResponse(session=active_session))
        if topic == DBMethods.SAVE_MESSAGE:
            return QueryResult(ok=True, data=DBSaveMessageResponse(message_id=0, success=True))
        raise AssertionError(f"unexpected DB request: {topic}")

    bus.request.side_effect = request
    event = STTUserSpeechCaptured(
        text="Wakeword prompt",
        is_final=True,
        session_id="audio-capture-session",
    )
    with patch.object(
        service,
        "_assistant_response_metadata",
        new_callable=AsyncMock,
        return_value={},
    ):
        await service._on_transcription(Envelope(type="STT.UserSpeechCaptured", payload=event))

    saves = [
        call.args[1]
        for call in bus.request.await_args_list
        if call.args[0] == DBMethods.SAVE_MESSAGE
    ]
    assert [(save.role, save.content) for save in saves] == [
        ("user", "Wakeword prompt"),
        ("assistant", "Voice answer"),
    ]
    assert {save.session_id for save in saves} == {"active-chat"}
    assert {save.principal_id for save in saves} == {"user-a"}

    assistant_events = [
        call for call in bus.publish.await_args_list if call.args[0] == OrchestratorMethods.RESPONSE
    ]
    assert assistant_events
    assert all(call.kwargs["principal_id"] == "user-a" for call in assistant_events)
    assert all(call.kwargs["mesh"] is False for call in assistant_events)


@pytest.mark.asyncio
async def test_peer_chat_remains_ephemeral_and_does_not_touch_session_db(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Existing peer inference can run, but it cannot create or write local sessions."""

    service, bus = _service(monkeypatch)
    graph = Mock()
    graph.stream_graph_updates = AsyncMock(return_value="Remote answer")
    service.orchestrator = graph

    with patch.object(
        service,
        "_assistant_response_metadata",
        new_callable=AsyncMock,
        return_value={},
    ):
        response = await service._process_input(
            "Remote prompt",
            source="external",
            session_id="peer-ephemeral",
            return_response=True,
            caller_principal_id="peer-principal",
            caller_peer_id="peer-1",
            caller_identity_source="webrtc_rpc",
        )

    assert response == "Remote answer"
    assert bus.request.await_count == 0
    response_publish = next(
        call for call in bus.publish.await_args_list if call.args[0] == OrchestratorMethods.RESPONSE
    )
    assert response_publish.kwargs["mesh"] is True
