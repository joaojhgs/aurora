from __future__ import annotations

from fastapi.testclient import TestClient

from app.services.gateway.fastapi_app import create_gateway_app
from app.shared.contracts.models.aurora import AuroraMethods


class _DummyBus:
    def subscribe(self, topic, handler) -> None:
        pass

    def unsubscribe(self, topic, handler) -> None:
        pass


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
