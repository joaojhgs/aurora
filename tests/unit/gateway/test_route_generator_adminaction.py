"""AdminAction safeguards for generated gateway routes."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

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
from app.shared.contracts.models.backup import (
    BackupCreateRequest,
    BackupCreateResponse,
    BackupMethods,
)
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.config import (
    ConfigMethods,
    ConfigRollbackRequest,
    ConfigRollbackResponse,
    ConfigSetRequest,
    ConfigSetResponse,
)
from app.shared.contracts.models.db import DBMethods
from app.shared.contracts.models.gateway import GatewayMethods, MethodInfo, RouteExplainRequest
from app.shared.contracts.models.orchestrator import (
    OrchestratorInferChatRequest,
    OrchestratorMethods,
    OrchestratorProcessRequest,
    OrchestratorResponse,
)
from app.shared.contracts.models.tooling import ToolingMethods


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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "secret"),
    [
        (
            {
                "topic": GatewayMethods.EXPLAIN_ROUTE,
                "text": "top-level route secret",
                "audio": "top-level audio secret",
                "payload": {"token": "top-level payload secret"},
            },
            "top-level route secret",
        ),
        (
            {
                "topic": GatewayMethods.EXPLAIN_ROUTE,
                "speech": {
                    "language_requirement": {"mode": "exact", "language": "en"},
                    "text": "nested speech secret",
                },
            },
            "nested speech secret",
        ),
        (
            {
                "topic": GatewayMethods.EXPLAIN_ROUTE,
                "selector": {
                    "peer_id": "peer-1",
                    "unknown_selector_field": "selector unknown secret",
                },
            },
            "selector unknown secret",
        ),
        (
            {
                "topic": GatewayMethods.EXPLAIN_ROUTE,
                "selector": {
                    "peer_id": "peer-1",
                    "payload": "selector raw secret",
                },
            },
            "selector raw secret",
        ),
    ],
)
async def test_explain_route_generated_http_rejects_unsafe_payloads_without_echoing_values(
    generated_route_app, payload, secret
):
    app, router, generator, bus, _ = generated_route_app("Gateway", _explain_route_method())
    await _start_app(app, router, generator)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/Gateway/ExplainRoute", json=payload)

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid route explanation request."}
    assert secret not in response.text
    assert "top-level audio secret" not in response.text
    assert "top-level payload secret" not in response.text
    bus.request.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", ["malformed route secret", ["malformed route secret"]])
async def test_explain_route_generated_http_rejects_non_object_json_without_dispatch(
    generated_route_app, payload
):
    app, router, generator, bus, _ = generated_route_app("Gateway", _explain_route_method())
    await _start_app(app, router, generator)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/Gateway/ExplainRoute", json=payload)

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid route explanation request."}
    assert "malformed route secret" not in response.text
    bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_explain_route_generated_http_rejects_malformed_json_without_dispatch(
    generated_route_app,
):
    app, router, generator, bus, _ = generated_route_app("Gateway", _explain_route_method())
    await _start_app(app, router, generator)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Gateway/ExplainRoute",
            content='{"topic": "Gateway.ExplainRoute", "text": "malformed route secret"',
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid route explanation request."}
    assert "malformed route secret" not in response.text
    bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_explain_route_generated_http_valid_payload_reaches_bus_unchanged(
    generated_route_app,
):
    app, router, generator, bus, _ = generated_route_app("Gateway", _explain_route_method())
    bus.request.return_value = QueryResult(ok=True, data={"selected_target": "remote"})
    await _start_app(app, router, generator)
    payload = {
        "topic": "TTS.Synthesize",
        "selector": {
            "peer_id": "peer-1",
            "resource_namespace": "speaker",
        },
        "speech": {
            "language_requirement": {"mode": "exact", "language": "en"},
            "voice_id": "standard:piper:amy",
        },
        "include_candidates": False,
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/Gateway/ExplainRoute", json=payload)

    assert response.status_code == 200
    assert response.json() == {"selected_target": "remote"}
    bus.request.assert_awaited_once()
    expected_payload = RouteExplainRequest.model_validate(payload).model_dump(exclude_unset=True)
    assert bus.request.await_args.args[:2] == (GatewayMethods.EXPLAIN_ROUTE, expected_payload)


@pytest.mark.asyncio
async def test_explain_route_generated_http_retains_request_body_schema(
    generated_route_app,
):
    app, router, generator, _bus, _ = generated_route_app("Gateway", _explain_route_method())
    await _start_app(app, router, generator)

    operation = app.openapi()["paths"]["/api/Gateway/ExplainRoute"]["post"]
    schema = operation["requestBody"]["content"]["application/json"]["schema"]
    assert schema["title"] == "RouteExplainRequest"
    assert {"topic", "selector", "speech", "include_candidates"}.issubset(schema["properties"])


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


def _explain_route_method() -> MethodInfo:
    return MethodInfo(
        name="ExplainRoute",
        summary="Explain route",
        bus_topic=GatewayMethods.EXPLAIN_ROUTE,
        exposure="external",
        method_type="use",
        required_perms=["Gateway.use"],
        input_model="RouteExplainRequest",
        output_model="RouteExplainResponse",
        input_schema=RouteExplainRequest.model_json_schema(),
        output_schema={"type": "object", "properties": {"selected_target": {"type": "string"}}},
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
    app, router, generator, bus, _manager = generated_route_app("Config", _config_rollback_method())
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
    assert forward_call.kwargs["identity_source"] == "gateway_admin_action"


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


@pytest.mark.asyncio
async def test_generated_handler_uses_updated_bus_for_mesh_selector_route():
    """Existing generated handlers must dispatch through set_bus() after mesh starts."""
    raw_bus = AsyncMock()
    raw_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"bus": "raw"}))
    mesh_bus = AsyncMock()
    mesh_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"bus": "mesh"}))
    method_info = MethodInfo(
        name="ExternalUserInput",
        summary="Process user input",
        bus_topic=OrchestratorMethods.EXTERNAL_USER_INPUT,
        exposure="external",
        method_type="use",
        required_perms=[OrchestratorMethods.EXTERNAL_USER_INPUT],
        input_model="OrchestratorProcessRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorProcessRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    generator = RouteGenerator(
        bus=raw_bus,
        registry=_SingleMethodRegistry("Orchestrator", method_info),
    )
    handler = generator._create_handler("Orchestrator", method_info)

    generator.set_bus(mesh_bus)
    result = await handler(
        {
            "text": "hello",
            "mesh_selector": {"peer_id": "assistant-peer"},
        },
        principal_id="principal-1",
        effective_perms=["Orchestrator.RemoteDispatch"],
        identity_source="test",
    )

    assert result == {"bus": "mesh"}
    raw_bus.request.assert_not_awaited()
    mesh_bus.request.assert_awaited_once()
    assert mesh_bus.request.await_args.args[0] == OrchestratorMethods.EXTERNAL_USER_INPUT
    assert mesh_bus.request.await_args.args[1]["mesh_selector"] == {"peer_id": "assistant-peer"}


@pytest.mark.asyncio
async def test_remote_tool_execution_outlives_provider_local_approval_window():
    """A mobile allow/deny decision returns before the gateway abandons the call."""
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"ok": False}))
    method_info = MethodInfo(
        name="ExecuteTool",
        summary="Execute a tool",
        bus_topic=ToolingMethods.EXECUTE_TOOL,
        exposure="external",
        method_type="use",
        required_perms=[ToolingMethods.EXECUTE_TOOL],
    )
    generator = RouteGenerator(
        bus=bus,
        registry=_SingleMethodRegistry("Tooling", method_info),
        request_timeout=30.0,
    )
    handler = generator._create_handler("Tooling", method_info)

    await handler(
        {
            "tool_name": "aurora-tool:v1:mobile:Tooling:share-text",
            "arguments": {"text": "hello"},
            "mesh_selector": {"peer_id": "mobile-peer"},
        },
        principal_id="principal-1",
        effective_perms=[ToolingMethods.EXECUTE_TOOL],
        identity_source="test",
    )

    assert bus.request.await_args.kwargs["timeout"] == 75.0


@pytest.mark.asyncio
async def test_generated_handler_maps_projection_authority_failure_to_forbidden():
    """Projection-only provider routes fail closed without looking like server faults."""

    bus = AsyncMock()
    bus.request = AsyncMock(
        return_value=QueryResult(ok=False, error="projection_authority_unknown")
    )
    method_info = MethodInfo(
        name="GetExportCatalog",
        summary="Get export catalog",
        bus_topic=ToolingMethods.GET_EXPORT_CATALOG,
        exposure="external",
        method_type="use",
        required_perms=[ToolingMethods.GET_TOOLS],
    )
    generator = RouteGenerator(
        bus=bus,
        registry=_SingleMethodRegistry("Tooling", method_info),
    )
    handler = generator._create_handler("Tooling", method_info)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await handler(
            {},
            principal_id="principal-1",
            effective_perms=[ToolingMethods.GET_TOOLS],
            identity_source="gateway_http",
        )

    assert exc.value.status_code == 403
    assert exc.value.detail == "projection_authority_unknown"


@pytest.mark.asyncio
async def test_generated_handler_maps_mesh_permission_denial_to_forbidden():
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=False, error="permission_denied"))
    method_info = MethodInfo(
        name="ExecuteTool",
        summary="Execute a tool",
        bus_topic=ToolingMethods.EXECUTE_TOOL,
        exposure="external",
        method_type="use",
        required_perms=[ToolingMethods.EXECUTE_TOOL],
    )
    handler = RouteGenerator(
        bus=bus,
        registry=_SingleMethodRegistry("Tooling", method_info),
    )._create_handler("Tooling", method_info)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await handler(
            {},
            principal_id="principal-1",
            effective_perms=[ToolingMethods.EXECUTE_TOOL],
            identity_source="gateway_http",
        )

    assert exc.value.status_code == 403
    assert exc.value.detail == "permission_denied"


@pytest.mark.asyncio
async def test_generated_handler_maps_authentication_required_to_unauthorized():
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=False, error="authentication_required"))
    method_info = MethodInfo(
        name="WhoAmI",
        summary="Get current identity",
        bus_topic=AuthMethods.WHO_AM_I,
        exposure="external",
        method_type="use",
        required_perms=[],
    )
    handler = RouteGenerator(
        bus=bus,
        registry=_SingleMethodRegistry("Auth", method_info),
    )._create_handler("Auth", method_info)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await handler(
            {},
            principal_id="anonymous",
            effective_perms=[],
            identity_source="none",
        )

    assert exc.value.status_code == 401
    assert exc.value.detail == "authentication_required"


@pytest.mark.asyncio
async def test_generated_handler_does_not_reclassify_unknown_principal_errors():
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=False, error="Principal not found"))
    method_info = MethodInfo(
        name="WhoAmI",
        summary="Get current identity",
        bus_topic=AuthMethods.WHO_AM_I,
        exposure="external",
        method_type="use",
        required_perms=[],
    )
    handler = RouteGenerator(
        bus=bus,
        registry=_SingleMethodRegistry("Auth", method_info),
    )._create_handler("Auth", method_info)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await handler(
            {},
            principal_id="missing-principal",
            effective_perms=[],
            identity_source="gateway_http",
        )

    assert exc.value.status_code == 500
    assert exc.value.detail == "Principal not found"


@pytest.mark.asyncio
async def test_dispatched_assistant_turn_is_persisted_only_on_origin_bus():
    """A remote answer is committed to the caller's session after dispatch returns."""

    bus = AsyncMock()

    async def request(topic, payload, **_kwargs):
        if topic == OrchestratorMethods.EXTERNAL_USER_INPUT:
            return QueryResult(
                ok=True,
                data=OrchestratorResponse(
                    text="Remote answer",
                    session_id="origin-session",
                    request_id="request-1",
                    metadata={
                        "provider": "openai",
                        "provider_label": "OpenAI",
                        "model": "gpt-4o",
                    },
                ),
            )
        if topic == GatewayMethods.GET_MESH_STATUS:
            return QueryResult(
                ok=True,
                data={
                    "peers": [
                        {
                            "peer_id": "assistant-peer",
                            "node_name": "studio",
                        }
                    ]
                },
            )
        if topic == DBMethods.ENSURE_SESSION:
            return QueryResult(ok=True, data={"session": {"id": "origin-session"}})
        if topic == DBMethods.SAVE_MESSAGE:
            return QueryResult(ok=True, data={"message_id": 0, "success": True})
        raise AssertionError(f"unexpected bus request: {topic}")

    bus.request = AsyncMock(side_effect=request)
    method_info = MethodInfo(
        name="ExternalUserInput",
        summary="Process user input",
        bus_topic=OrchestratorMethods.EXTERNAL_USER_INPUT,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        input_model="OrchestratorProcessRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorProcessRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    generator = RouteGenerator(
        bus=bus,
        registry=_SingleMethodRegistry("Orchestrator", method_info),
    )
    handler = generator._create_handler("Orchestrator", method_info)

    response = await handler(
        {
            "text": "Remote question",
            "session_id": "origin-session",
            "request_id": "request-1",
            "dispatch_selector": {"peer_id": "assistant-peer"},
        },
        principal_id="principal-1",
        effective_perms=["Orchestrator.use", "Orchestrator.RemoteDispatch"],
        identity_source="gateway_http",
    )

    assert response["text"] == "Remote answer"
    assert [call.args[0] for call in bus.request.await_args_list] == [
        OrchestratorMethods.EXTERNAL_USER_INPUT,
        GatewayMethods.GET_MESH_STATUS,
        DBMethods.ENSURE_SESSION,
        DBMethods.SAVE_MESSAGE,
        DBMethods.SAVE_MESSAGE,
    ]
    ensure_session = bus.request.await_args_list[2].args[1]
    user_message = bus.request.await_args_list[3].args[1]
    assistant_message = bus.request.await_args_list[4].args[1]
    assert ensure_session.principal_id == "principal-1"
    assert ensure_session.session_id == "origin-session"
    assert (user_message.role, user_message.content) == ("user", "Remote question")
    assert (assistant_message.role, assistant_message.content) == (
        "assistant",
        "Remote answer",
    )
    assert user_message.principal_id == assistant_message.principal_id == "principal-1"
    assert (
        user_message.metadata
        == assistant_message.metadata
        == {
            "source_type": "Text",
            "execution": "remote_dispatch",
            "dispatch_selector": {"peer_id": "assistant-peer"},
            "execution_peer_id": "assistant-peer",
            "execution_peer_name": "studio",
            "provider": "openai",
            "provider_label": "OpenAI",
            "model": "gpt-4o",
        }
    )


@pytest.mark.asyncio
async def test_dispatch_persistence_failure_does_not_discard_remote_answer():
    """A DB outage is logged but cannot turn a successful dispatch into HTTP failure."""

    bus = AsyncMock()

    async def request(topic, _payload, **_kwargs):
        if topic == OrchestratorMethods.EXTERNAL_USER_INPUT:
            return QueryResult(
                ok=True,
                data=OrchestratorResponse(
                    text="Still return this",
                    session_id="origin-session",
                ),
            )
        if topic == DBMethods.ENSURE_SESSION:
            return QueryResult(ok=False, error="db unavailable")
        raise AssertionError(f"unexpected bus request: {topic}")

    bus.request = AsyncMock(side_effect=request)
    method_info = MethodInfo(
        name="ExternalUserInput",
        summary="Process user input",
        bus_topic=OrchestratorMethods.EXTERNAL_USER_INPUT,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        input_model="OrchestratorProcessRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorProcessRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    generator = RouteGenerator(
        bus=bus,
        registry=_SingleMethodRegistry("Orchestrator", method_info),
    )
    handler = generator._create_handler("Orchestrator", method_info)

    response = await handler(
        {
            "text": "Remote question",
            "session_id": "origin-session",
            "dispatch_selector": {"peer_id": "assistant-peer"},
        },
        principal_id="principal-1",
        effective_perms=["Orchestrator.use", "Orchestrator.RemoteDispatch"],
        identity_source="gateway_http",
    )

    assert response["text"] == "Still return this"
    assert [call.args[0] for call in bus.request.await_args_list] == [
        OrchestratorMethods.EXTERNAL_USER_INPUT,
        GatewayMethods.GET_MESH_STATUS,
        DBMethods.ENSURE_SESSION,
    ]


@pytest.mark.asyncio
async def test_generated_handler_denies_runtime_dispatch_with_manage_only_permission():
    raw_bus = AsyncMock()
    raw_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"bus": "raw"}))
    method_info = MethodInfo(
        name="ExternalUserInput",
        summary="Process user input",
        bus_topic=OrchestratorMethods.EXTERNAL_USER_INPUT,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        input_model="OrchestratorProcessRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorProcessRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    generator = RouteGenerator(
        bus=raw_bus,
        registry=_SingleMethodRegistry("Orchestrator", method_info),
    )
    handler = generator._create_handler("Orchestrator", method_info)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await handler(
            {"text": "hello", "mesh_selector": {"peer_id": "assistant-peer"}},
            principal_id="principal-1",
            effective_perms=["Orchestrator.manage"],
            identity_source="gateway_http",
        )

    assert exc.value.status_code == 403
    assert "RemoteDispatch" in str(exc.value.detail)
    raw_bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_generated_handler_denies_runtime_remote_inference_with_manage_only_permission():
    raw_bus = AsyncMock()
    raw_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"bus": "raw"}))
    method_info = MethodInfo(
        name="ExternalUserInput",
        summary="Process user input",
        bus_topic=OrchestratorMethods.EXTERNAL_USER_INPUT,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        input_model="OrchestratorProcessRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorProcessRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    generator = RouteGenerator(
        bus=raw_bus,
        registry=_SingleMethodRegistry("Orchestrator", method_info),
    )
    handler = generator._create_handler("Orchestrator", method_info)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await handler(
            {
                "text": "hello",
                "inference_selector": {"peer_id": "model-peer"},
            },
            principal_id="principal-1",
            effective_perms=["Orchestrator.manage"],
            identity_source="gateway_http",
        )

    assert exc.value.status_code == 403
    assert "RemoteInference" in str(exc.value.detail)
    raw_bus.request.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "override_payload",
    [
        {"inference_provider_id": "openai"},
        {"inference_model_id": "gpt-test"},
    ],
)
async def test_generated_handler_allows_runtime_inference_provider_model_override_with_use(
    override_payload,
):
    raw_bus = AsyncMock()
    raw_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"bus": "raw"}))
    method_info = MethodInfo(
        name="ExternalUserInput",
        summary="Process user input",
        bus_topic=OrchestratorMethods.EXTERNAL_USER_INPUT,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        input_model="OrchestratorProcessRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorProcessRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    generator = RouteGenerator(
        bus=raw_bus,
        registry=_SingleMethodRegistry("Orchestrator", method_info),
    )
    handler = generator._create_handler("Orchestrator", method_info)

    result = await handler(
        {"text": "hello", **override_payload},
        principal_id="principal-1",
        effective_perms=["Orchestrator.use"],
        identity_source="gateway_http",
    )

    assert result == {"bus": "raw"}
    raw_bus.request.assert_awaited_once()


@pytest.mark.asyncio
async def test_generated_handler_allows_runtime_inference_provider_model_override_with_permission():
    raw_bus = AsyncMock()
    raw_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"bus": "raw"}))
    method_info = MethodInfo(
        name="ExternalUserInput",
        summary="Process user input",
        bus_topic=OrchestratorMethods.EXTERNAL_USER_INPUT,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        input_model="OrchestratorProcessRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorProcessRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    generator = RouteGenerator(
        bus=raw_bus,
        registry=_SingleMethodRegistry("Orchestrator", method_info),
    )
    handler = generator._create_handler("Orchestrator", method_info)

    result = await handler(
        {"text": "hello", "inference_provider_id": "openai"},
        principal_id="principal-1",
        effective_perms=["Orchestrator.*"],
        identity_source="gateway_http",
    )

    assert result == {"bus": "raw"}
    raw_bus.request.assert_awaited_once()
    assert raw_bus.request.await_args.args[1]["inference_provider_id"] == "openai"


@pytest.mark.asyncio
@pytest.mark.parametrize("override_payload", [{"provider_id": "openai"}, {"model_id": "gpt-test"}])
async def test_generated_infer_chat_denies_plain_provider_model_override_with_manage_only(
    override_payload,
):
    raw_bus = AsyncMock()
    raw_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"text": "ok"}))
    method_info = MethodInfo(
        name="InferChat",
        summary="Infer chat",
        bus_topic=OrchestratorMethods.INFER_CHAT,
        exposure="external",
        method_type="use",
        required_perms=[OrchestratorMethods.REMOTE_INFERENCE],
        input_model="OrchestratorInferChatRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorInferChatRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    generator = RouteGenerator(
        bus=raw_bus,
        registry=_SingleMethodRegistry("Orchestrator", method_info),
    )
    handler = generator._create_handler("Orchestrator", method_info)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await handler(
            {"messages": [{"role": "user", "content": "hi"}], **override_payload},
            principal_id="principal-1",
            effective_perms=["Orchestrator.manage"],
            identity_source="gateway_http",
        )

    assert exc.value.status_code == 403
    assert "RemoteInference" in str(exc.value.detail)
    raw_bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_generated_infer_chat_allows_plain_provider_model_override_with_permission():
    raw_bus = AsyncMock()
    raw_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"text": "ok"}))
    method_info = MethodInfo(
        name="InferChat",
        summary="Infer chat",
        bus_topic=OrchestratorMethods.INFER_CHAT,
        exposure="external",
        method_type="use",
        required_perms=[OrchestratorMethods.REMOTE_INFERENCE],
        input_model="OrchestratorInferChatRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorInferChatRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    generator = RouteGenerator(
        bus=raw_bus,
        registry=_SingleMethodRegistry("Orchestrator", method_info),
    )
    handler = generator._create_handler("Orchestrator", method_info)

    result = await handler(
        {"messages": [{"role": "user", "content": "hi"}], "provider_id": "openai"},
        principal_id="principal-1",
        effective_perms=[OrchestratorMethods.REMOTE_INFERENCE],
        identity_source="gateway_http",
    )

    assert result == {"text": "ok"}
    raw_bus.request.assert_awaited_once()
    assert raw_bus.request.await_args.args[0] == OrchestratorMethods.INFER_CHAT
    assert raw_bus.request.await_args.args[1]["provider_id"] == "openai"


def test_gateway_service_rewire_updates_app_state_and_route_generator_bus():
    """Mesh startup can repoint already-mounted HTTP dynamic routes to MeshBus."""
    from app.services.gateway.service import GatewayService

    service = GatewayService()
    route_generator = SimpleNamespace(set_bus=Mock())
    mesh_bus = object()
    service._gateway_app = SimpleNamespace(
        state=SimpleNamespace(bus=object(), route_generator=route_generator)
    )

    service._rewire_gateway_app_bus(mesh_bus)

    assert service._gateway_app.state.bus is mesh_bus
    route_generator.set_bus.assert_called_once_with(mesh_bus)


@pytest.mark.asyncio
async def test_orchestrator_dispatch_default_applied_only_when_runtime_selector_absent(
    generated_route_app, monkeypatch
):
    method = MethodInfo(
        name="ExternalUserInput",
        summary="External user input",
        bus_topic=OrchestratorMethods.EXTERNAL_USER_INPUT,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        input_model="OrchestratorProcessRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorProcessRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    app, router, generator, bus, _ = generated_route_app("Orchestrator", method)

    fake_config = AsyncMock()
    fake_config.aget_config = AsyncMock(
        return_value={
            "orchestrator": {
                "routing": {
                    "dispatch_default": {
                        "enabled": True,
                        "peer_id": "assistant-peer",
                        "resource_namespace": "assistant",
                    }
                }
            }
        }
    )
    monkeypatch.setattr("app.services.gateway.route_generator.ConfigAPI", lambda: fake_config)
    await _start_app(app, router, generator)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/Orchestrator/ExternalUserInput", json={"text": "hi"})
        assert response.status_code == 200
        response = await client.post(
            "/api/Orchestrator/ExternalUserInput",
            json={"text": "hi", "mesh_selector": {"peer_id": "runtime-peer"}},
        )
        assert response.status_code == 200

    first_payload = bus.request.await_args_list[0].args[1]
    second_payload = bus.request.await_args_list[1].args[1]
    assert first_payload["dispatch_selector"] == {
        "peer_id": "assistant-peer",
        "resource_namespace": "assistant",
    }
    assert "dispatch_selector" not in second_payload
    assert second_payload["mesh_selector"] == {"peer_id": "runtime-peer"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtime_selector_payload",
    [
        {"mesh_selector": {}},
        {"mesh_selector": {"peer_id": None}},
        {"selector": {}},
    ],
)
async def test_orchestrator_dispatch_default_ignores_empty_runtime_selectors(
    generated_route_app, monkeypatch, runtime_selector_payload
):
    method = MethodInfo(
        name="ExternalUserInput",
        summary="External user input",
        bus_topic=OrchestratorMethods.EXTERNAL_USER_INPUT,
        exposure="external",
        method_type="use",
        required_perms=["Orchestrator.use"],
        input_model="OrchestratorProcessRequest",
        output_model="OrchestratorResponse",
        input_schema=OrchestratorProcessRequest.model_json_schema(),
        output_schema=OrchestratorResponse.model_json_schema(),
    )
    app, router, generator, bus, _ = generated_route_app("Orchestrator", method)

    fake_config = AsyncMock()
    fake_config.aget_config = AsyncMock(
        return_value={
            "orchestrator": {
                "routing": {
                    "dispatch_default": {
                        "enabled": True,
                        "peer_id": "assistant-peer",
                        "resource_namespace": "assistant",
                    }
                }
            }
        }
    )
    monkeypatch.setattr("app.services.gateway.route_generator.ConfigAPI", lambda: fake_config)
    await _start_app(app, router, generator)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/Orchestrator/ExternalUserInput",
            json={"text": "hi", **runtime_selector_payload},
        )

    assert response.status_code == 200
    payload = bus.request.await_args.args[1]
    assert payload["dispatch_selector"] == {
        "peer_id": "assistant-peer",
        "resource_namespace": "assistant",
    }
