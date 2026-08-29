"""Principal isolation for assistant event streams used by persisted chat sessions."""

from dataclasses import dataclass

import pytest
from fastapi import HTTPException

from app.messaging import QueryResult
from app.services.gateway.fastapi_app import (
    _authorize_event_stream_request,
    _event_visible_to_principal,
    _stream_backfill_events,
)
from app.shared.contracts.models.aurora import AuroraEventStreamEvent
from app.shared.contracts.models.gateway import GatewayListEventsResponse
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.tts import TTSMethods


def _assistant_event(event_id: str, principal_id: str | None) -> AuroraEventStreamEvent:
    return AuroraEventStreamEvent(
        event_id=event_id,
        topic=OrchestratorMethods.RESPONSE,
        kind="assistant.completed",
        category="assistant",
        action="Response",
        status="completed",
        principal_id=principal_id,
        redacted_payload={"session_id": f"session-{event_id}"},
        payload_sha256=f"hash-{event_id}",
    )


@dataclass
class _Identity:
    permissions: set[str]

    def can(self, permission: str, *, method_type: str | None = None) -> bool:
        del method_type
        return permission in self.permissions


class _BackfillBus:
    def __init__(self, events: list[AuroraEventStreamEvent]) -> None:
        self.events = events

    async def request(self, *_args, **_kwargs) -> QueryResult:
        return QueryResult(
            ok=True,
            data=GatewayListEventsResponse(events=self.events, total=len(self.events)),
        )


def test_assistant_events_are_visible_only_to_their_principal() -> None:
    matching = _assistant_event("matching", "user-a")
    different = _assistant_event("different", "user-b")
    unowned = _assistant_event("unowned", None)

    assert _event_visible_to_principal(matching, "user-a") is True
    assert _event_visible_to_principal(different, "user-a") is False
    assert _event_visible_to_principal(unowned, "user-a") is False


@pytest.mark.asyncio
async def test_backfill_drops_other_principals_assistant_turns() -> None:
    bus = _BackfillBus(
        [
            _assistant_event("user-a", "user-a"),
            _assistant_event("user-b", "user-b"),
        ]
    )

    events = [
        event
        async for event in _stream_backfill_events(
            bus,
            topics=[OrchestratorMethods.RESPONSE],
            categories={"assistant"},
            kinds={"assistant.completed"},
            correlation_id=None,
            last_event_id=None,
            replay_from=None,
            principal_id="user-a",
        )
    ]

    assert [event.event_id for event in events] == ["user-a"]


def test_regular_user_can_stream_correlated_principal_scoped_voice_responses_only() -> None:
    identity = _Identity({"Orchestrator.use"})

    _authorize_event_stream_request(
        identity,
        topics=[OrchestratorMethods.RESPONSE],
        categories={"assistant"},
        kinds={"assistant.completed"},
        correlation_id="corr-1",
    )
    _authorize_event_stream_request(
        identity,
        topics=[OrchestratorMethods.RESPONSE, TTSMethods.AUDIO_CHUNK],
        categories={"assistant"},
        kinds={"assistant.completed", "tts.audio_chunk"},
        correlation_id="corr-1",
    )

    with pytest.raises(HTTPException, match="Gateway.manage is required"):
        _authorize_event_stream_request(
            identity,
            topics=[OrchestratorMethods.RESPONSE],
            categories={"assistant"},
            kinds={"assistant.completed"},
            correlation_id=None,
        )

    with pytest.raises(HTTPException, match="Gateway.manage is required"):
        _authorize_event_stream_request(
            identity,
            topics=[OrchestratorMethods.RESPONSE, TTSMethods.AUDIO_CHUNK],
            categories={"assistant"},
            kinds={"assistant.completed"},
            correlation_id=None,
        )

    with pytest.raises(HTTPException, match="Gateway.manage is required"):
        _authorize_event_stream_request(
            identity,
            topics=[OrchestratorMethods.RESPONSE, "Tooling.ExecuteTool"],
            categories={"assistant"},
            kinds={"assistant.completed"},
            correlation_id="corr-1",
        )
