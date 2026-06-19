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
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.config import ConfigMethods, ConfigSetRequest, ConfigSetResponse
from app.shared.contracts.models.gateway import MethodInfo


class _ConfigRegistry:
    def on_registry_change(self, _callback):
        pass

    async def get_external_methods(self):
        return [
            (
                "Config",
                MethodInfo(
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
                ),
            )
        ]

    def is_service_available(self, module_name: str) -> bool:
        return module_name == "Config"


@pytest.fixture
def generated_config_app():
    old_gateway_auth = deps._gateway_auth
    deps._gateway_auth = GatewayAuth(enabled=False)

    bus = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"success": True}))
    app = FastAPI()
    router = APIRouter()
    generator = RouteGenerator(bus=bus, registry=_ConfigRegistry())
    generator.set_router(router)

    yield app, router, generator, bus

    deps._gateway_auth = old_gateway_auth


async def _start_app(app: FastAPI, router: APIRouter, generator: RouteGenerator) -> None:
    await generator.start()
    app.include_router(router)


@pytest.mark.asyncio
async def test_generated_config_set_requires_admin_action_headers(generated_config_app):
    app, router, generator, bus = generated_config_app
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
    generated_config_app,
):
    app, router, generator, bus = generated_config_app
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
    generated_config_app,
):
    app, router, generator, bus = generated_config_app
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
