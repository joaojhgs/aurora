"""AdminAction safeguards for generated gateway routes."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient

import app.services.gateway.dependencies as deps
from app.messaging.bus import QueryResult
from app.services.gateway.acl.identity import SYSTEM
from app.services.gateway.auth import GatewayAuth
from app.services.gateway.route_generator import RouteGenerator, _admin_action_digest
from app.shared.contracts.models.auth import (
    AuthMethods,
    DeviceDeleteRequest,
    DeviceDeleteResponse,
    PasswordChangeRequest,
    PasswordChangeResponse,
)
from app.shared.contracts.models.config import ConfigMethods, ConfigSetRequest, ConfigSetResponse
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


@pytest.fixture
def generated_route_app():
    old_gateway_auth = deps._gateway_auth
    deps._gateway_auth = GatewayAuth(enabled=False)

    def build(module_name: str, method_info: MethodInfo):
        bus = AsyncMock()
        bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"success": True}))
        app = FastAPI()
        router = APIRouter()
        generator = RouteGenerator(
            bus=bus,
            registry=_SingleMethodRegistry(module_name, method_info),
        )
        generator.set_router(router)
        return app, router, generator, bus

    yield build

    deps._gateway_auth = old_gateway_auth


async def _start_app(app: FastAPI, router: APIRouter, generator: RouteGenerator) -> None:
    await generator.start()
    app.include_router(router)


def _config_set_method() -> MethodInfo:
    return MethodInfo(
        name="Set",
        summary="Set config",
        bus_topic=ConfigMethods.SET,
        exposure="external",
        method_type="manage",
        required_perms=[ConfigMethods.SET],
        input_model="ConfigSetRequest",
        output_model="ConfigSetResponse",
        input_schema=ConfigSetRequest.model_json_schema(),
        output_schema=ConfigSetResponse.model_json_schema(),
    )


def _auth_change_password_method() -> MethodInfo:
    return MethodInfo(
        name="ChangePassword",
        summary="Change password",
        bus_topic=AuthMethods.CHANGE_PASSWORD,
        exposure="external",
        method_type="use",
        required_perms=[AuthMethods.CHANGE_PASSWORD],
        input_model="PasswordChangeRequest",
        output_model="PasswordChangeResponse",
        input_schema=PasswordChangeRequest.model_json_schema(),
        output_schema=PasswordChangeResponse.model_json_schema(),
    )


def _auth_delete_device_method() -> MethodInfo:
    return MethodInfo(
        name="DeleteDevice",
        summary="Delete device",
        bus_topic=AuthMethods.DELETE_DEVICE,
        exposure="external",
        method_type="manage",
        required_perms=[AuthMethods.DELETE_DEVICE],
        input_model="DeviceDeleteRequest",
        output_model="DeviceDeleteResponse",
        input_schema=DeviceDeleteRequest.model_json_schema(),
        output_schema=DeviceDeleteResponse.model_json_schema(),
    )


@pytest.mark.asyncio
async def test_generated_config_set_requires_admin_action_headers(generated_route_app):
    app, router, generator, bus = generated_route_app("Config", _config_set_method())
    await _start_app(app, router, generator)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Config/Set",
            json={"key": "services.gateway.enabled", "value": True},
        )

    assert response.status_code == 428
    assert response.json()["detail"]["code"] == "admin_action_required"
    bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_generated_config_set_rejects_admin_action_digest_mismatch(
    generated_route_app,
):
    app, router, generator, bus = generated_route_app("Config", _config_set_method())
    await _start_app(app, router, generator)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Config/Set",
            json={"key": "services.gateway.enabled", "value": True},
            headers={
                "X-Aurora-AdminAction-Id": "admin-action-1",
                "X-Aurora-AdminAction-Digest": "bad-digest",
                "X-Aurora-AdminAction-Reason": "test change",
                "X-Aurora-AdminAction-Reauth": "confirmed",
            },
        )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "admin_action_digest_mismatch"
    bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_generated_config_set_audits_admin_action_before_forwarding(
    generated_route_app,
):
    app, router, generator, bus = generated_route_app("Config", _config_set_method())
    await _start_app(app, router, generator)
    payload = {"key": "services.gateway.enabled", "value": True}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Config/Set",
            json=payload,
            headers={
                "X-Aurora-AdminAction-Id": "admin-action-1",
                "X-Aurora-AdminAction-Digest": _admin_action_digest(
                    ConfigMethods.SET,
                    SYSTEM.principal_id,
                    payload,
                ),
                "X-Aurora-AdminAction-Reason": "test change",
                "X-Aurora-AdminAction-Reauth": "confirmed",
            },
        )

    assert response.status_code == 200
    assert response.json() == {"success": True}

    audit_call, forward_call = bus.request.await_args_list
    assert audit_call.args[0] == AuthMethods.STORE_AUDIT_EVENT
    assert audit_call.args[1].event == "admin.action.confirmed"
    assert forward_call.args[0] == ConfigMethods.SET
    assert forward_call.args[1] == payload


@pytest.mark.asyncio
async def test_generated_auth_change_password_requires_admin_action_headers(
    generated_route_app,
):
    app, router, generator, bus = generated_route_app("Auth", _auth_change_password_method())
    await _start_app(app, router, generator)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Auth/ChangePassword",
            json={
                "user_id": "user-1",
                "old_password": "old",
                "new_password": "new",
            },
        )

    assert response.status_code == 428
    assert response.json()["detail"]["code"] == "admin_action_required"
    bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_generated_auth_delete_device_audits_admin_action_before_forwarding(
    generated_route_app,
):
    app, router, generator, bus = generated_route_app("Auth", _auth_delete_device_method())
    await _start_app(app, router, generator)
    payload = {"device_id": "device-1"}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Auth/DeleteDevice",
            json=payload,
            headers={
                "X-Aurora-AdminAction-Id": "admin-action-2",
                "X-Aurora-AdminAction-Digest": _admin_action_digest(
                    AuthMethods.DELETE_DEVICE,
                    SYSTEM.principal_id,
                    payload,
                ),
                "X-Aurora-AdminAction-Reason": "remove stale paired device",
                "X-Aurora-AdminAction-Reauth": "confirmed",
            },
        )

    assert response.status_code == 200
    assert response.json() == {"success": True}

    audit_call, forward_call = bus.request.await_args_list
    assert audit_call.args[0] == AuthMethods.STORE_AUDIT_EVENT
    assert audit_call.args[1].event == "admin.action.confirmed"
    assert forward_call.args[0] == AuthMethods.DELETE_DEVICE
    assert forward_call.args[1] == payload
