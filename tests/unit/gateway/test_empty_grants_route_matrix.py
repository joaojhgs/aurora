from __future__ import annotations

import json
from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient

import app.services.gateway.dependencies as deps
from app.messaging.bus import QueryResult
from app.services.gateway.acl.identity import Identity
from app.services.gateway.auth import GatewayAuth
from app.services.gateway.route_generator import RouteGenerator
from app.services.gateway.webrtc.event_subscriptions import MeshEventSubscriptionRegistry
from app.services.gateway.webrtc.peer_protocol import CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1
from app.services.gateway.webrtc.rpc import RPCHandler
from app.shared.contracts.models.auth import (
    AuthMethods,
    LoginRequest,
    LoginResponse,
    PairingConnectRequest,
    PairingConnectResponse,
    PairingExchangeRequest,
    PairingExchangeResponse,
    PairingStartRequest,
    PairingStartResponse,
    WhoAmIRequest,
)
from app.shared.contracts.models.config import ConfigMethods, ConfigSetRequest
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.tooling import ToolingGetToolsRequest, ToolingMethods
from app.shared.contracts.models.tts import TTSMethods, TTSRequest
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


@dataclass(frozen=True)
class RouteCase:
    case_id: str
    module: str
    method: MethodInfo
    path: str
    payload: dict[str, object]


class _RouteMatrixRegistry:
    def __init__(self, cases: list[RouteCase]) -> None:
        self._cases = cases

    def on_registry_change(self, _callback) -> None:
        pass

    async def get_external_methods(self) -> list[tuple[str, MethodInfo]]:
        return [(case.module, case.method) for case in self._cases]

    def is_service_available(self, module_name: str) -> bool:
        return any(case.module == module_name for case in self._cases)


class _TokenAuth:
    async def authenticate_token(self, token_str: str) -> object | None:
        return object() if token_str == "paired-empty-token" else None

    async def build_identity_from_token(self, _token: object, *, source: str) -> Identity:
        return _empty_paired_identity(source=source)


def _method(
    *,
    name: str,
    topic: str,
    input_model: type,
    output_model: type,
    required_perms: list[str] | None = None,
    method_type: str = "use",
    exposure: str = "both",
) -> MethodInfo:
    return MethodInfo(
        name=name,
        summary=name,
        bus_topic=topic,
        exposure=exposure,
        method_type=method_type,
        required_perms=required_perms or [],
        input_model=input_model.__name__,
        output_model=getattr(output_model, "__name__", "Object"),
        input_schema=input_model.model_json_schema(),
        output_schema=output_model.model_json_schema()
        if hasattr(output_model, "model_json_schema")
        else {"type": "object"},
    )


def _empty_paired_identity(*, source: str = "webrtc_peer") -> Identity:
    return Identity(
        principal_id="peer-empty",
        principal_name="paired-empty-peer",
        is_admin=False,
        effective_perms=frozenset(),
        source=source,
    )


def _projected_service(module: str, topic: str) -> SimpleNamespace:
    return SimpleNamespace(
        service_id=module,
        capacity={"max_concurrent": 0},
        methods=[
            SimpleNamespace(
                topic=topic,
                required_permissions=("TTS.use",),
                method_type="use",
                speech_constraints=None,
            )
        ],
    )


def _active_projection() -> SimpleNamespace:
    return SimpleNamespace(
        cache_key=SimpleNamespace(recipient_peer_id="peer-empty", provider_peer_id="provider-a"),
        readiness="ready",
        routable=True,
        services=[_projected_service("TTS", TTSMethods.REQUEST)],
    )


def _announcement(method: MethodInfo) -> ServiceAnnouncement:
    return ServiceAnnouncement(
        module=method.bus_topic.split(".", 1)[0],
        version="1.0",
        methods=[method],
    )


def _response_payload_for(topic: str) -> dict[str, object]:
    if topic == AuthMethods.LOGIN:
        return {
            "token": "token",
            "user_id": "peer-empty",
            "username": "paired-empty-peer",
            "permissions": [],
            "is_admin": False,
        }
    if topic == AuthMethods.PAIRING_START:
        return {"code": "123456", "expires_in_seconds": 300}
    if topic == AuthMethods.PAIRING_CONNECT:
        return {"request_id": "req", "device_name": "phone", "status": "pending"}
    if topic == AuthMethods.PAIRING_EXCHANGE:
        return {"token": "token", "device_id": "device", "user_id": "peer-empty"}
    if topic == AuthMethods.WHO_AM_I:
        return {"principal_id": "peer-empty", "effective_perms": []}
    return {"ok": True}


PROTECTED_HTTP_ROUTE_CASES = [
    RouteCase(
        case_id="http-protected-tts-empty-grant",
        module="TTS",
        method=_method(
            name="Request",
            topic=TTSMethods.REQUEST,
            input_model=TTSRequest,
            output_model=SimpleNamespace,
            required_perms=["TTS.use"],
        ),
        path="/api/TTS/Request",
        payload={"text": "hello"},
    ),
    RouteCase(
        case_id="http-protected-tooling-read-empty-grant",
        module="Tooling",
        method=_method(
            name="GetTools",
            topic=ToolingMethods.GET_TOOLS,
            input_model=ToolingGetToolsRequest,
            output_model=SimpleNamespace,
            required_perms=["Tooling.read"],
            method_type="read",
        ),
        path="/api/Tooling/GetTools",
        payload={},
    ),
    RouteCase(
        case_id="http-protected-config-manage-empty-grant",
        module="Config",
        method=_method(
            name="Set",
            topic=ConfigMethods.SET,
            input_model=ConfigSetRequest,
            output_model=SimpleNamespace,
            required_perms=["Config.manage"],
            method_type="manage",
        ),
        path="/api/Config/Set",
        payload={"key": "voice.enabled", "value": True},
    ),
]

HTTP_BOOTSTRAP_ROUTE_CASES = [
    RouteCase(
        case_id="http-bootstrap-login-exception",
        module="Auth",
        method=_method(
            name="Login",
            topic=AuthMethods.LOGIN,
            input_model=LoginRequest,
            output_model=LoginResponse,
        ),
        path="/api/Auth/Login",
        payload={"username": "alice", "password": "secret"},
    ),
    RouteCase(
        case_id="http-bootstrap-pairing-start-exception",
        module="Auth",
        method=_method(
            name="PairingStart",
            topic=AuthMethods.PAIRING_START,
            input_model=PairingStartRequest,
            output_model=PairingStartResponse,
        ),
        path="/api/Auth/PairingStart",
        payload={"device_name": "phone"},
    ),
]

HTTP_ROUTE_CASES = PROTECTED_HTTP_ROUTE_CASES + HTTP_BOOTSTRAP_ROUTE_CASES


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROTECTED_HTTP_ROUTE_CASES, ids=lambda case: case.case_id)
async def test_http_contract_routes_with_empty_grants_deny_before_dispatch(
    case: RouteCase,
) -> None:
    old_gateway_auth = deps._gateway_auth
    deps._gateway_auth = GatewayAuth(auth_service=_TokenAuth(), enabled=True)
    try:
        bus = AsyncMock()
        bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"unexpected": True}))
        app = FastAPI()
        router = APIRouter()
        generator = RouteGenerator(bus=bus, registry=_RouteMatrixRegistry(HTTP_ROUTE_CASES))
        generator.set_router(router)
        await generator.start()
        app.include_router(router)

        generated = {
            route.path for route in app.routes if getattr(route, "path", "").startswith("/api/")
        }
        assert len(generated) >= len(HTTP_ROUTE_CASES)
        assert {case.path for case in HTTP_ROUTE_CASES}.issubset(generated)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                case.path,
                json=case.payload,
                headers={"Authorization": "Bearer paired-empty-token"},
            )

        assert response.status_code == 403, case.case_id
        bus.request.assert_not_awaited()
    finally:
        deps._gateway_auth = old_gateway_auth


@pytest.mark.asyncio
@pytest.mark.parametrize("case", HTTP_BOOTSTRAP_ROUTE_CASES, ids=lambda case: case.case_id)
async def test_http_bootstrap_login_and_pairing_exceptions_still_dispatch(case: RouteCase) -> None:
    old_gateway_auth = deps._gateway_auth
    deps._gateway_auth = GatewayAuth(enabled=True)
    try:
        bus = AsyncMock()
        bus.request = AsyncMock(
            return_value=QueryResult(ok=True, data=_response_payload_for(case.method.bus_topic))
        )
        app = FastAPI()
        router = APIRouter()
        generator = RouteGenerator(bus=bus, registry=_RouteMatrixRegistry([case]))
        generator.set_router(router)
        await generator.start()
        app.include_router(router)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(case.path, json=case.payload)

        assert response.status_code == 200, case.case_id
        bus.request.assert_awaited_once()
        assert bus.request.await_args.args[0] == case.method.bus_topic
    finally:
        deps._gateway_auth = old_gateway_auth


WEBRTC_CALL_CASES = [
    RouteCase(
        case_id="webrtc-protected-tts-empty-grant",
        module="TTS",
        method=_method(
            name="Request",
            topic=TTSMethods.REQUEST,
            input_model=TTSRequest,
            output_model=SimpleNamespace,
            required_perms=["TTS.use"],
        ),
        path="",
        payload={"text": "hello"},
    ),
    RouteCase(
        case_id="webrtc-bootstrap-login-exception",
        module="Auth",
        method=_method(
            name="Login",
            topic=AuthMethods.LOGIN,
            input_model=LoginRequest,
            output_model=LoginResponse,
        ),
        path="",
        payload={"username": "alice", "password": "secret"},
    ),
    RouteCase(
        case_id="webrtc-bootstrap-pairing-connect-exception",
        module="Auth",
        method=_method(
            name="PairingConnect",
            topic=AuthMethods.PAIRING_CONNECT,
            input_model=PairingConnectRequest,
            output_model=PairingConnectResponse,
        ),
        path="",
        payload={"code": "123456"},
    ),
    RouteCase(
        case_id="webrtc-bootstrap-pairing-exchange-exception",
        module="Auth",
        method=_method(
            name="PairingExchange",
            topic=AuthMethods.PAIRING_EXCHANGE,
            input_model=PairingExchangeRequest,
            output_model=PairingExchangeResponse,
        ),
        path="",
        payload={"code": "123456"},
    ),
    RouteCase(
        case_id="webrtc-authenticated-bootstrap-whoami-exception",
        module="Auth",
        method=_method(
            name="WhoAmI",
            topic=AuthMethods.WHO_AM_I,
            input_model=WhoAmIRequest,
            output_model=SimpleNamespace,
        ),
        path="",
        payload={},
    ),
]


@pytest.mark.asyncio
async def test_webrtc_calls_events_and_subscriptions_with_empty_grants_fail_before_dispatch() -> (
    None
):
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"unexpected": True}))
    bus.publish = AsyncMock()
    registry = AsyncMock()
    registry.get_service.return_value = _announcement(WEBRTC_CALL_CASES[0].method)
    send = MagicMock()
    mesh_config = SimpleNamespace(enabled=True, services={"TTS": mesh_policy(share=True)})
    handler = RPCHandler(
        bus,
        registry,
        send,
        MagicMock(return_value=_empty_paired_identity()),
        mesh_config=mesh_config,
        stable_peer_id_provider=lambda: "peer-empty",
        active_projection_provider=_active_projection,
        event_subscription_registry=MeshEventSubscriptionRegistry(),
        peer_supports_capability=lambda capability: capability == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
        authenticated_peer_validator=lambda: True,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "call-denied",
                "method": TTSMethods.REQUEST,
                "params": {"text": "hello"},
            }
        )
    )
    call_response = json.loads(send.call_args.args[0])
    assert call_response["type"] == "error"
    assert call_response["error"]["code"] == 403
    assert call_response["error"]["message"] == "Forbidden"
    bus.request.assert_not_awaited()

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": TTSMethods.STARTED,
                "params": {"utterance_id": "u1"},
                "correlation_id": "corr-event",
            }
        )
    )
    bus.publish.assert_not_awaited()

    await handler.on_message(
        json.dumps(
            {
                "type": "subscribe",
                "id": "sub-denied",
                "topics": [OrchestratorMethods.RESPONSE],
                "correlation_ids": ["corr-sub"],
            }
        )
    )
    subscribe_response = json.loads(send.call_args.args[0])
    assert subscribe_response["type"] == "subscribe_rejected"
    assert subscribe_response["id"] == "sub-denied"
    assert subscribe_response["reason"] == "unauthorized_topic"
    assert subscribe_response["accepted_topics"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("case", WEBRTC_CALL_CASES[1:], ids=lambda case: case.case_id)
async def test_webrtc_bootstrap_login_pairing_and_auth_reads_still_dispatch(
    case: RouteCase,
) -> None:
    bus = AsyncMock()
    bus.request = AsyncMock(
        return_value=QueryResult(ok=True, data=_response_payload_for(case.method.bus_topic))
    )
    registry = AsyncMock()
    registry.get_service.return_value = _announcement(case.method)
    send = MagicMock()
    handler = RPCHandler(
        bus,
        registry,
        send,
        MagicMock(return_value=_empty_paired_identity()),
        mesh_config=SimpleNamespace(enabled=True, services={}),
        stable_peer_id_provider=lambda: "peer-empty",
        active_projection_provider=lambda: None,
        authenticated_peer_validator=lambda: True,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": case.case_id,
                "method": case.method.bus_topic,
                "params": case.payload,
            }
        )
    )

    response = json.loads(send.call_args.args[0])
    assert response["type"] == "result", case.case_id
    bus.request.assert_awaited_once()
    assert bus.request.await_args.args[0] == case.method.bus_topic
