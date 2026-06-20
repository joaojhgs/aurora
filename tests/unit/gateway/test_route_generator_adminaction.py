"""AdminAction safeguards for generated gateway routes."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient

import app.services.gateway.dependencies as deps
from app.messaging.bus import QueryResult
from app.services.gateway.acl.identity import SYSTEM
from app.services.gateway.admin_action import (
    ADMIN_ACTION_DIGEST_HEADER,
    ADMIN_ACTION_ID_HEADER,
    ADMIN_ACTION_TOKEN_HEADER,
    AdminActionManager,
)
from app.services.gateway.auth import GatewayAuth
from app.services.gateway.route_generator import RouteGenerator, _admin_action_digest
from app.shared.contracts.models.auth import (
    AuthMethods,
    DeviceDeleteRequest,
    DeviceDeleteResponse,
    PasswordChangeRequest,
    PasswordChangeResponse,
)
from app.shared.contracts.models.backup import BackupCreateRequest, BackupCreateResponse, BackupMethods
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.config import (
    ConfigMethods,
    ConfigRollbackRequest,
    ConfigRollbackResponse,
    ConfigSetRequest,
    ConfigSetResponse,
)
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
        admin_action_manager = AdminActionManager()
        app = FastAPI()
        router = APIRouter()
        generator = RouteGenerator(
            bus=bus,
            registry=_SingleMethodRegistry(module_name, method_info),
            admin_action_manager=admin_action_manager,
        )
        generator.set_router(router)
        return app, router, generator, bus, admin_action_manager

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


def _config_rollback_method() -> MethodInfo:
    return MethodInfo(
        name="Rollback",
        summary="Rollback config",
        bus_topic=ConfigMethods.ROLLBACK,
        exposure="external",
        method_type="manage",
        required_perms=[ConfigMethods.ROLLBACK],
        input_model="ConfigRollbackRequest",
        output_model="ConfigRollbackResponse",
        input_schema=ConfigRollbackRequest.model_json_schema(),
        output_schema=ConfigRollbackResponse.model_json_schema(),
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


def _generic_manage_method() -> MethodInfo:
    return MethodInfo(
        name="DoManage",
        summary="Generic manage operation",
        bus_topic="Test.DoManage",
        exposure="external",
        method_type="manage",
        required_perms=["Test.DoManage"],
        input_model="EmptyInput",
        output_model="EmptyInput",
        input_schema=EmptyInput.model_json_schema(),
        output_schema=EmptyInput.model_json_schema(),
    )


def _backup_create_method() -> MethodInfo:
    return MethodInfo(
        name="Create",
        summary="Create backup",
        bus_topic=BackupMethods.CREATE,
        exposure="external",
        method_type="manage",
        required_perms=["Backup.manage"],
        input_model="BackupCreateRequest",
        output_model="BackupCreateResponse",
        input_schema=BackupCreateRequest.model_json_schema(),
        output_schema=BackupCreateResponse.model_json_schema(),
    )


def _confirmed_headers(
    manager: AdminActionManager,
    *,
    method_id: str,
    payload: dict,
    reason: str = "test change",
) -> dict[str, str]:
    from app.shared.contracts.models.gateway import (
        AdminActionConfirmRequest,
        AdminActionDraftRequest,
    )

    draft = manager.draft(
        AdminActionDraftRequest(method_id=method_id, payload=payload),
        principal_id=SYSTEM.principal_id,
    )
    confirm = manager.confirm(
        AdminActionConfirmRequest(
            action_id=draft.action_id,
            nonce=draft.nonce,
            digest=draft.digest,
            reason=reason,
            reauth_confirmed=True,
            phrase=draft.required_phrase,
        ),
        principal_id=SYSTEM.principal_id,
    )
    return {
        ADMIN_ACTION_ID_HEADER: confirm.action_id,
        ADMIN_ACTION_TOKEN_HEADER: confirm.confirmation_token,
        ADMIN_ACTION_DIGEST_HEADER: confirm.digest,
    }


@pytest.mark.asyncio
async def test_generated_config_set_requires_admin_action_headers(generated_route_app):
    app, router, generator, bus, _manager = generated_route_app("Config", _config_set_method())
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
async def test_generated_config_rollback_requires_admin_action_headers(generated_route_app):
    app, router, generator, bus, _manager = generated_route_app(
        "Config", _config_rollback_method()
    )
    await _start_app(app, router, generator)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Config/Rollback",
            json={"version_id": "cfgv_test"},
        )

    assert response.status_code == 428
    assert response.json()["detail"]["code"] == "admin_action_required"
    bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_generated_config_set_rejects_admin_action_digest_mismatch(
    generated_route_app,
):
    app, router, generator, bus, manager = generated_route_app("Config", _config_set_method())
    await _start_app(app, router, generator)
    payload = {"key": "services.gateway.enabled", "value": True}
    headers = _confirmed_headers(manager, method_id=ConfigMethods.SET, payload=payload)
    headers[ADMIN_ACTION_DIGEST_HEADER] = "bad-digest"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Config/Set",
            json=payload,
            headers=headers,
        )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "admin_action_digest_mismatch"
    bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_generated_config_set_audits_admin_action_before_forwarding(
    generated_route_app,
):
    app, router, generator, bus, manager = generated_route_app("Config", _config_set_method())
    await _start_app(app, router, generator)
    payload = {"key": "services.gateway.enabled", "value": True}
    headers = _confirmed_headers(
        manager,
        method_id=ConfigMethods.SET,
        payload=payload,
        reason="test change",
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Config/Set",
            json=payload,
            headers=headers,
        )

    assert response.status_code == 200
    assert response.json() == {"success": True}
    assert response.headers["X-Aurora-AdminAction-Audit-Receipt"].startswith("aar_")

    audit_call, forward_call = bus.request.await_args_list
    assert audit_call.args[0] == AuthMethods.STORE_AUDIT_EVENT
    assert audit_call.args[1].event == "admin.action.confirmed"
    details = json.loads(audit_call.args[1].details)
    assert details["action_id"] == headers[ADMIN_ACTION_ID_HEADER]
    assert details["reason"] == "test change"
    assert details["affected_resources"] == ["key:services.gateway.enabled"]
    assert forward_call.args[0] == ConfigMethods.SET
    assert forward_call.args[1] == payload


@pytest.mark.asyncio
async def test_generated_auth_change_password_requires_admin_action_headers(
    generated_route_app,
):
    app, router, generator, bus, _manager = generated_route_app(
        "Auth", _auth_change_password_method()
    )
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
    app, router, generator, bus, manager = generated_route_app("Auth", _auth_delete_device_method())
    await _start_app(app, router, generator)
    payload = {"device_id": "device-1"}
    headers = _confirmed_headers(
        manager,
        method_id=AuthMethods.DELETE_DEVICE,
        payload=payload,
        reason="remove stale paired device",
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Auth/DeleteDevice",
            json=payload,
            headers=headers,
        )

    assert response.status_code == 200
    assert response.json() == {"success": True}

    audit_call, forward_call = bus.request.await_args_list
    assert audit_call.args[0] == AuthMethods.STORE_AUDIT_EVENT
    assert audit_call.args[1].event == "admin.action.confirmed"
    assert forward_call.args[0] == AuthMethods.DELETE_DEVICE
    assert forward_call.args[1] == payload


@pytest.mark.asyncio
async def test_generated_config_set_rejects_legacy_raw_confirmation_headers(
    generated_route_app,
):
    app, router, generator, bus, _manager = generated_route_app("Config", _config_set_method())
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

    assert response.status_code == 428
    assert response.json()["detail"]["code"] == "admin_action_required"
    assert ADMIN_ACTION_TOKEN_HEADER in response.json()["detail"]["missing_headers"]
    bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_generated_manage_route_requires_admin_action_even_when_not_allowlisted(
    generated_route_app,
):
    app, router, generator, bus, _manager = generated_route_app("Test", _generic_manage_method())
    await _start_app(app, router, generator)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/Test/DoManage", json={})

    assert response.status_code == 428
    assert response.json()["detail"]["code"] == "admin_action_required"
    bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_generated_backup_create_requires_admin_action_headers(generated_route_app):
    app, router, generator, bus, _manager = generated_route_app("Backup", _backup_create_method())
    await _start_app(app, router, generator)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/Backup/Create", json={"reason": "pre-upgrade"})

    assert response.status_code == 428
    assert response.json()["detail"]["code"] == "admin_action_required"
    bus.request.assert_not_awaited()
