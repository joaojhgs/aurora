"""Gateway public Auth route bypass regression tests."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import APIRouter, FastAPI, Request
from fastapi.security import SecurityScopes
from httpx import ASGITransport, AsyncClient

import app.services.gateway.dependencies as deps
from app.messaging.bus import QueryResult
from app.services.gateway.acl.identity import ANONYMOUS, SYSTEM
from app.services.gateway.auth import (
    GatewayAuth,
    _resolve_identity_and_check,
    create_auth_middleware,
)
from app.services.gateway.route_generator import RouteGenerator
from app.shared.contracts.models.auth import AuthMethods, LoginRequest, LoginResponse
from app.shared.contracts.models.gateway import MethodInfo


class _SingleMethodRegistry:
    def __init__(self, module_name: str, method_info: MethodInfo):
        self.module_name = module_name
        self.method_info = method_info

    def on_registry_change(self, _callback):
        pass

    async def get_external_methods(self):
        return [(self.module_name, self.method_info)]

    def is_service_available(self, module_name: str) -> bool:
        return module_name == self.module_name


def _login_method(required_perms: list[str] | None = None) -> MethodInfo:
    return MethodInfo(
        name="Login",
        summary="Login",
        bus_topic=AuthMethods.LOGIN,
        exposure="both",
        method_type="use",
        required_perms=required_perms or [],
        input_model="LoginRequest",
        output_model="LoginResponse",
        input_schema=LoginRequest.model_json_schema(),
        output_schema=LoginResponse.model_json_schema(),
    )


@pytest.mark.parametrize(
    "path",
    [
        "/api/Auth/Login",
        "/api/Auth/PairingStart",
        "/api/Auth/PairingConnect",
        "/api/Auth/PairingExchange",
        "/api/auth/login",
        "/api/auth/pairing/start",
        "/api/auth/pairing/connect",
        "/api/auth/pairing/exchange",
    ],
)
def test_gateway_auth_bypasses_canonical_and_legacy_public_auth_paths(path):
    auth = GatewayAuth(enabled=True)

    assert auth.should_bypass(path)


@pytest.mark.parametrize(
    "path",
    [
        "/api/Auth/LoginDebug",
        "/api/Auth/Login-debug",
        "/api/auth/login-debug",
        "/api/Auth/PairingApprove",
        "/api/auth/pairing/approve",
    ],
)
def test_gateway_auth_bypass_does_not_match_protected_prefixes(path):
    auth = GatewayAuth(enabled=True)

    assert not auth.should_bypass(path)


@pytest.mark.asyncio
async def test_bypass_middleware_sets_anonymous_identity():
    auth = GatewayAuth(enabled=True)
    app = FastAPI()
    app.middleware("http")(create_auth_middleware(auth))

    @app.post("/api/Auth/Login")
    async def login(request: Request):
        identity = request.state.identity
        return {
            "principal_id": identity.principal_id,
            "is_admin": identity.is_admin,
            "effective_perms": list(identity.effective_perms),
        }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/Auth/Login", json={})

    assert response.status_code == 200
    assert response.json() == {
        "principal_id": ANONYMOUS.principal_id,
        "is_admin": False,
        "effective_perms": [],
    }


@pytest.mark.asyncio
async def test_bypass_security_dependency_returns_anonymous_not_system():
    auth = GatewayAuth(enabled=True)
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/Auth/Login",
            "headers": [],
            "query_string": b"",
            "server": ("testserver", 80),
            "client": ("testclient", 50000),
            "scheme": "http",
        }
    )

    identity = await _resolve_identity_and_check(
        request,
        SecurityScopes(scopes=[]),
        bearer=None,
        api_key_header=None,
        auth=auth,
    )

    assert identity == ANONYMOUS
    assert identity != SYSTEM


@pytest.mark.asyncio
async def test_auth_disabled_security_dependency_returns_system():
    auth = GatewayAuth(enabled=False)
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/Auth/Login",
            "headers": [],
            "query_string": b"",
            "server": ("testserver", 80),
            "client": ("testclient", 50000),
            "scheme": "http",
        }
    )

    identity = await _resolve_identity_and_check(
        request,
        SecurityScopes(scopes=[]),
        bearer=None,
        api_key_header=None,
        auth=auth,
    )

    assert identity == SYSTEM


@pytest.mark.asyncio
async def test_generated_canonical_login_route_bypasses_auth_as_anonymous():
    old_gateway_auth = deps._gateway_auth
    deps._gateway_auth = GatewayAuth(enabled=True)
    try:
        bus = AsyncMock()
        bus.request = AsyncMock(
            return_value=QueryResult(
                ok=True,
                data={
                    "token": "token-1",
                    "user_id": "user-1",
                    "username": "alice",
                    "permissions": [],
                    "is_admin": False,
                    "expires_at": None,
                },
            )
        )
        app = FastAPI()
        router = APIRouter()
        generator = RouteGenerator(
            bus=bus,
            registry=_SingleMethodRegistry("Auth", _login_method()),
        )
        generator.set_router(router)
        await generator.start()
        app.include_router(router)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/Auth/Login",
                json={"username": "alice", "password": "secret"},
            )

        assert response.status_code == 200
        assert response.json()["token"] == "token-1"
        bus.request.assert_awaited_once()
        assert bus.request.await_args.kwargs["origin"] == "external"
        assert bus.request.await_args.kwargs["principal_id"] == ANONYMOUS.principal_id
    finally:
        deps._gateway_auth = old_gateway_auth


@pytest.mark.asyncio
async def test_generated_public_auth_route_with_permissions_still_checks_anonymous_scope():
    old_gateway_auth = deps._gateway_auth
    deps._gateway_auth = GatewayAuth(enabled=True)
    try:
        bus = AsyncMock()
        bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"success": True}))
        app = FastAPI()
        router = APIRouter()
        generator = RouteGenerator(
            bus=bus,
            registry=_SingleMethodRegistry("Auth", _login_method([AuthMethods.LOGIN])),
        )
        generator.set_router(router)
        await generator.start()
        app.include_router(router)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/Auth/Login",
                json={"username": "alice", "password": "secret"},
            )

        assert response.status_code == 403
        bus.request.assert_not_awaited()
    finally:
        deps._gateway_auth = old_gateway_auth
