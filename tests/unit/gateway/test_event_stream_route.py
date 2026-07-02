from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.messaging.bus import QueryResult
from app.services.gateway.fastapi_app import (
    _sse_payload,
    _stream_backfill_events,
    create_gateway_app,
)
from app.shared.contracts.models.aurora import AuroraEventStreamEvent, AuroraMethods
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.gateway import GatewayListEventsResponse, GatewayMethods


class _DummyBus:
    def __init__(self, *, events: list[AuroraEventStreamEvent] | None = None) -> None:
        self.events = events or []
        self.requests: list[tuple[str, Any]] = []

    def subscribe(self, topic, handler) -> None:
        pass

    def unsubscribe(self, topic, handler) -> None:
        pass

    async def request(self, topic, payload, **kwargs):
        self.requests.append((topic, payload))
        if topic == AuthMethods.VALIDATE_TOKEN:
            return QueryResult(
                ok=True,
                data={
                    "valid": True,
                    "principal_id": "principal-sdk",
                    "principal_name": "SDK",
                    "is_admin": False,
                    "permissions": ["Orchestrator.use"],
                    "effective_perms": ["Orchestrator.use"],
                },
            )
        if topic == GatewayMethods.LIST_EVENTS:
            return QueryResult(
                ok=True,
                data=GatewayListEventsResponse(events=self.events, total=len(self.events)),
            )
        return QueryResult(ok=False, error=f"unexpected topic {topic}")


class _DummyRegistry:
    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def get_services(self):
        return []

    def on_registry_change(self, callback) -> None:
        pass

    async def get_external_methods(self):
        return []


class _StopStreamingError(Exception):
    pass


def test_event_stream_route_is_auth_gated_when_gateway_auth_enabled():
    app = create_gateway_app(
        bus=_DummyBus(),
        registry=_DummyRegistry(),
        auth_enabled=True,
        auth_api_keys=[],
    )

    with TestClient(app) as client:
        response = client.get("/api/events/stream")

    assert response.status_code == 401


def test_event_stream_route_is_documented_as_sse_builtin():
    app = create_gateway_app(
        bus=_DummyBus(),
        registry=_DummyRegistry(),
        auth_enabled=False,
    )

    schema = app.openapi()
    route_schema = schema["paths"]["/api/events/stream"]["get"]

    assert route_schema["summary"] == "Stream unified Aurora events"
    assert route_schema["responses"]["200"]["content"]["text/event-stream"]
    assert AuroraMethods.EVENT_STREAM == "Aurora.EventStream"


@pytest.mark.asyncio
async def test_event_stream_backfill_formats_filtered_sse_events():
    event = AuroraEventStreamEvent(
        event_id="evt-1",
        topic="Orchestrator.Response",
        kind="assistant.completed",
        category="assistant",
        action="Response",
        status="completed",
        correlation_id="corr-1",
        redacted_payload={
            "text": {"redacted": True, "sha256": "abc"},
            "session_id": "session-1",
            "request_id": "corr-1",
        },
        payload_sha256="hash",
    )
    bus = _DummyBus(events=[event])
    events = [
        item
        async for item in _stream_backfill_events(
            bus,
            topics=["Orchestrator.Response"],
            categories=set(),
            kinds={"assistant.completed"},
            correlation_id="corr-1",
            last_event_id=None,
            replay_from=None,
        )
    ]
    sse = _sse_payload(events[0])

    assert sse.startswith("id: evt-1\nevent: assistant.completed\n")
    assert '"correlation_id":"corr-1"' in sse
    assert bus.requests[0][0] == GatewayMethods.LIST_EVENTS
    assert bus.requests[0][1].topics == ["Orchestrator.Response"]
    assert bus.requests[0][1].kinds == ["assistant.completed"]
    assert bus.requests[0][1].correlation_id == "corr-1"


def test_event_stream_route_denies_broad_stream_without_gateway_manage():
    app = create_gateway_app(
        bus=_DummyBus(),
        registry=_DummyRegistry(),
        auth_enabled=True,
        auth_api_keys=[],
    )

    with TestClient(app) as client:
        response = client.get(
            "/api/events/stream?kind=audit&backfill=true",
            headers={"Authorization": "Bearer sdk-token"},
        )

    assert response.status_code == 403
    assert "Gateway.manage is required" in response.json()["error"]


@pytest.mark.asyncio
async def test_event_stream_route_delivers_backfilled_event_over_http_sse():
    event = AuroraEventStreamEvent(
        event_id="evt-http-1",
        topic="Orchestrator.Response",
        kind="assistant.completed",
        category="assistant",
        action="Response",
        status="completed",
        correlation_id="corr-http-1",
        redacted_payload={
            "text": {"redacted": True, "sha256": "text-hash"},
            "session_id": "session-http",
            "request_id": "corr-http-1",
        },
        payload_sha256="payload-hash",
    )
    app = create_gateway_app(
        bus=_DummyBus(events=[event]),
        registry=_DummyRegistry(),
        auth_enabled=False,
    )

    messages: list[dict[str, Any]] = []
    request_sent = False
    never_disconnect = asyncio.Event()

    async def receive() -> dict[str, Any]:
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await never_disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)
        if message["type"] == "http.response.body" and message.get("body"):
            raise _StopStreamingError

    with pytest.raises(_StopStreamingError):
        await app(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/api/events/stream",
                "raw_path": b"/api/events/stream",
                "query_string": (
                    b"topic=Orchestrator.Response"
                    b"&kind=assistant.completed"
                    b"&correlation_id=corr-http-1"
                    b"&backfill=true"
                ),
                "headers": [],
                "client": ("testclient", 50000),
                "server": ("testserver", 80),
            },
            receive,
            send,
        )

    start = next(message for message in messages if message["type"] == "http.response.start")
    body = next(message["body"] for message in messages if message["type"] == "http.response.body")
    lines = body.decode().splitlines()

    assert start["status"] == 200
    assert lines[0] == "id: evt-http-1"
    assert lines[1] == "event: assistant.completed"
    assert '"correlation_id":"corr-http-1"' in lines[2]
    assert '"payload_sha256":"payload-hash"' in lines[2]
    assert '"redacted":true' in lines[2]
