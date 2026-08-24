import asyncio
import contextlib
import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.acl.identity import Identity
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.policy_store import MeshPolicyStore
from app.services.gateway.webrtc.rpc import (
    RPCHandler,
    WebRTCFrameParseError,
    WebRTCParserLimits,
    parse_webrtc_frame,
    parse_webrtc_json_frame,
)
from app.services.orchestrator.service import OrchestratorService
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.gateway import GatewayMethods, MethodInfo, ServiceAnnouncement
from app.shared.contracts.models.orchestrator import (
    OrchestratorInferChatRequest,
    OrchestratorMethods,
    OrchestratorProcessRequest,
)
from app.shared.contracts.models.scheduler import (
    SchedulerCancelJobRequest,
    SchedulerListJobsRequest,
    SchedulerMethods,
    SchedulerScheduleActionRequest,
    SchedulerScheduleJobRequest,
)
from app.shared.contracts.models.speech import (
    SpeechMethodConstraints,
    SpeechRouteBinding,
    compute_speech_projection_binding_revision,
)
from app.shared.contracts.models.tooling import (
    ToolingConfirmExecutionRequest,
    ToolingCreateApprovalGrantRequest,
    ToolingExecuteToolRequest,
    ToolingGetToolByNameRequest,
    ToolingGetToolsRequest,
    ToolingMethods,
    ToolingPrepareExecutionRequest,
    ToolingRequestApprovalRequest,
    ToolingRevokeApprovalGrantRequest,
    ToolingSetPolicyModeRequest,
    ToolingSetSharingPolicyRequest,
    ToolingSharingPolicy,
    ToolingUpsertSourcePolicyRequest,
    ToolingUpsertToolPolicyOverrideRequest,
)
from app.shared.contracts.models.tts import TTSMethods, TTSRequest
from app.shared.contracts.registry import all_contracts, clear_registry
from app.shared.contracts.speech_routing import compute_speech_route_requirement_digest_for_payload
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


@pytest.fixture
def mock_bus():
    return AsyncMock()


@pytest.fixture
def mock_registry():
    return AsyncMock()


@pytest.fixture
def mock_send_fn():
    return MagicMock()


@pytest.fixture
def mock_acl_provider():
    """Returns an Identity with limited permissions."""
    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset(["user"]),
        source="webrtc_peer",
    )
    return MagicMock(return_value=identity)


@pytest.fixture
def rpc_handler(mock_bus, mock_registry, mock_send_fn, mock_acl_provider):
    return RPCHandler(mock_bus, mock_registry, mock_send_fn, mock_acl_provider)


def test_rpc_error_response_is_best_effort_after_transport_loss(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    handler = RPCHandler(mock_bus, mock_registry, mock_send_fn, mock_acl_provider)
    mock_send_fn.side_effect = RuntimeError("canonical DataChannel is unavailable")

    sent = handler._send_error(  # noqa: SLF001
        "request-after-close",
        500,
        "Service request failed",
        correlation_id="correlation-after-close",
    )

    assert sent is False
    mock_send_fn.assert_called_once()


def _make_acl_with_perms(*perms: str):
    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset(perms),
        source="webrtc_peer",
    )
    return MagicMock(return_value=identity)


def _orchestrator_method_info(name: str, topic: str, input_model):
    method_info = MagicMock(spec=MethodInfo)
    method_info.name = name
    method_info.bus_topic = topic
    method_info.exposure = "external"
    method_info.input_model = input_model
    method_info.required_perms = ["Orchestrator.use"]
    method_info.method_type = "use"
    return method_info


def _registry_with_method(mock_registry, module: str, method_info):
    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement


def test_orchestrator_rpc_contract_metadata_is_hardened():
    clear_registry()
    OrchestratorService()

    contracts = all_contracts()
    assert contracts[OrchestratorMethods.USER_INPUT].exposure == "internal"
    assert contracts[OrchestratorMethods.USER_INPUT].required_perms == ["Orchestrator.use"]
    assert contracts[OrchestratorMethods.EXTERNAL_USER_INPUT].exposure == "external"
    assert contracts[OrchestratorMethods.EXTERNAL_USER_INPUT].required_perms == ["Orchestrator.use"]
    assert contracts[OrchestratorMethods.TOOL_RESULT].exposure == "internal"
    assert contracts[OrchestratorMethods.TOOL_RESULT].required_perms == ["Orchestrator.use"]


@pytest.mark.parametrize(
    "method_name",
    [OrchestratorMethods.USER_INPUT, OrchestratorMethods.TOOL_RESULT],
)
@pytest.mark.asyncio
async def test_internal_orchestrator_methods_denied_over_rpc_even_with_permission(
    mock_bus,
    mock_registry,
    mock_send_fn,
    method_name,
):
    short_name = method_name.split(".", 1)[1]
    method_info = MethodInfo(
        name=short_name,
        bus_topic=method_name,
        exposure="internal",
        input_model=None,
        required_perms=["Orchestrator.use"],
        method_type="use",
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Orchestrator", version="1.0", methods=[method_info]
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Orchestrator.use"),
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "orch-internal", "method": method_name, "params": {}})
    )

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403
    assert response["error"]["message"] == "Method is not exposed for WebRTC RPC"
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_external_user_input_denied_without_orchestrator_use_permission(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "ExternalUserInput"
    method_info.bus_topic = OrchestratorMethods.EXTERNAL_USER_INPUT
    method_info.exposure = "external"
    method_info.input_model = OrchestratorProcessRequest
    method_info.required_perms = ["Orchestrator.use"]
    method_info.method_type = "use"
    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement
    handler = RPCHandler(mock_bus, mock_registry, mock_send_fn, _make_acl_with_perms("user"))

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "orch-denied",
                "method": OrchestratorMethods.EXTERNAL_USER_INPUT,
                "params": {"text": "hello"},
            }
        )
    )

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403
    assert response["error"]["message"] == "Forbidden"
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_external_user_input_allowed_with_orchestrator_use_permission(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "ExternalUserInput"
    method_info.bus_topic = OrchestratorMethods.EXTERNAL_USER_INPUT
    method_info.exposure = "external"
    method_info.input_model = OrchestratorProcessRequest
    method_info.required_perms = ["Orchestrator.use"]
    method_info.method_type = "use"
    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement
    mock_bus.request.return_value = QueryResult(ok=True, data={"text": "ok"})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Orchestrator.use"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "orch-allowed",
                "method": OrchestratorMethods.EXTERNAL_USER_INPUT,
                "params": {"text": "hello"},
            }
        )
    )

    mock_bus.request.assert_called_once()
    assert mock_bus.request.call_args.args[0] == OrchestratorMethods.EXTERNAL_USER_INPUT
    typed_request = mock_bus.request.call_args.args[1]
    assert isinstance(typed_request, OrchestratorProcessRequest)
    assert typed_request.text == "hello"
    assert mock_bus.request.call_args.kwargs["principal_id"] == "peer-user"
    assert mock_bus.request.call_args.kwargs["effective_perms"] == ["Orchestrator.use"]
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "result"


@pytest.mark.asyncio
async def test_typed_payload_validation_failure_returns_400_without_bus_request(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "ExternalUserInput"
    method_info.bus_topic = OrchestratorMethods.EXTERNAL_USER_INPUT
    method_info.exposure = "external"
    method_info.input_model = OrchestratorProcessRequest
    method_info.required_perms = ["Orchestrator.use"]
    method_info.method_type = "use"
    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Orchestrator.use"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "invalid-typed",
                "method": OrchestratorMethods.EXTERNAL_USER_INPUT,
                "params": {},
            }
        )
    )

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 400
    assert response["error"]["message"] == "Invalid request payload"
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "selector_payload",
    [
        {"dispatch_selector": {"peer_id": "assistant-peer"}},
        {"mesh_selector": {"peer_id": "assistant-peer"}},
        {"selector": {"peer_id": "assistant-peer"}},
    ],
)
async def test_external_user_input_runtime_dispatch_allowed_with_orchestrator_use(
    mock_bus,
    mock_registry,
    mock_send_fn,
    selector_payload,
):
    method_info = _orchestrator_method_info(
        "ExternalUserInput",
        OrchestratorMethods.EXTERNAL_USER_INPUT,
        OrchestratorProcessRequest,
    )
    _registry_with_method(mock_registry, "Orchestrator", method_info)
    mock_bus.request.return_value = QueryResult(ok=True, data={"text": "ok"})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Orchestrator.use"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "orch-dispatch-use",
                "method": OrchestratorMethods.EXTERNAL_USER_INPUT,
                "params": {"text": "hello", **selector_payload},
            }
        )
    )

    mock_bus.request.assert_called_once()
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "result"


@pytest.mark.asyncio
async def test_external_user_input_runtime_dispatch_allowed_with_remote_dispatch_permission(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    method_info = _orchestrator_method_info(
        "ExternalUserInput",
        OrchestratorMethods.EXTERNAL_USER_INPUT,
        OrchestratorProcessRequest,
    )
    _registry_with_method(mock_registry, "Orchestrator", method_info)
    mock_bus.request.return_value = QueryResult(ok=True, data={"text": "ok"})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Orchestrator.*"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "orch-dispatch-allowed",
                "method": OrchestratorMethods.EXTERNAL_USER_INPUT,
                "params": {"text": "hello", "dispatch_selector": {"peer_id": "assistant-peer"}},
            }
        )
    )

    mock_bus.request.assert_called_once()
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "result"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "override_payload",
    [
        {"inference_selector": {"peer_id": "model-peer"}},
        {"inference_provider_id": "openai"},
        {"inference_model_id": "gpt-test"},
    ],
)
async def test_external_user_input_runtime_inference_allowed_with_orchestrator_use(
    mock_bus,
    mock_registry,
    mock_send_fn,
    override_payload,
):
    method_info = _orchestrator_method_info(
        "ExternalUserInput",
        OrchestratorMethods.EXTERNAL_USER_INPUT,
        OrchestratorProcessRequest,
    )
    _registry_with_method(mock_registry, "Orchestrator", method_info)
    mock_bus.request.return_value = QueryResult(ok=True, data={"text": "ok"})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Orchestrator.use"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "orch-inference-use",
                "method": OrchestratorMethods.EXTERNAL_USER_INPUT,
                "params": {"text": "hello", **override_payload},
            }
        )
    )

    mock_bus.request.assert_called_once()
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "result"


@pytest.mark.asyncio
async def test_external_user_input_runtime_inference_allowed_with_remote_inference_permission(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    method_info = _orchestrator_method_info(
        "ExternalUserInput",
        OrchestratorMethods.EXTERNAL_USER_INPUT,
        OrchestratorProcessRequest,
    )
    _registry_with_method(mock_registry, "Orchestrator", method_info)
    mock_bus.request.return_value = QueryResult(ok=True, data={"text": "ok"})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Orchestrator.use"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "orch-inference-allowed",
                "method": OrchestratorMethods.EXTERNAL_USER_INPUT,
                "params": {"text": "hello", "inference_provider_id": "openai"},
            }
        )
    )

    mock_bus.request.assert_called_once()
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "result"


@pytest.mark.asyncio
@pytest.mark.parametrize("override_payload", [{"provider_id": "openai"}, {"model_id": "gpt-test"}])
async def test_stream_infer_chat_provider_model_override_allowed_with_orchestrator_use(
    mock_bus,
    mock_registry,
    mock_send_fn,
    override_payload,
):
    method_info = _orchestrator_method_info(
        "StreamInferChat",
        OrchestratorMethods.STREAM_INFER_CHAT,
        OrchestratorInferChatRequest,
    )
    method_info.required_perms = [OrchestratorMethods.REMOTE_INFERENCE]
    _registry_with_method(mock_registry, "Orchestrator", method_info)
    mock_bus.stream_request = None
    mock_bus.request.return_value = QueryResult(ok=True, data={"text": "ok"})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Orchestrator.use"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "stream-inference-use",
                "method": OrchestratorMethods.STREAM_INFER_CHAT,
                "params": {"messages": [{"role": "user", "content": "hi"}], **override_payload},
            }
        )
    )

    mock_bus.request.assert_called_once()
    assert mock_bus.request.call_args.args[0] == OrchestratorMethods.INFER_CHAT
    response_messages = [json.loads(call.args[0]) for call in mock_send_fn.call_args_list]
    assert response_messages[-1] == {"type": "eof", "id": "stream-inference-use"}


@pytest.mark.asyncio
async def test_stream_infer_chat_provider_model_override_allowed_with_remote_inference_permission(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    method_info = _orchestrator_method_info(
        "StreamInferChat",
        OrchestratorMethods.STREAM_INFER_CHAT,
        OrchestratorInferChatRequest,
    )
    method_info.required_perms = [OrchestratorMethods.REMOTE_INFERENCE]
    _registry_with_method(mock_registry, "Orchestrator", method_info)
    mock_bus.stream_request = None
    mock_bus.request.return_value = QueryResult(ok=True, data={"text": "ok"})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(OrchestratorMethods.REMOTE_INFERENCE),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "stream-inference-allowed",
                "method": OrchestratorMethods.STREAM_INFER_CHAT,
                "params": {
                    "messages": [{"role": "user", "content": "hi"}],
                    "provider_id": "openai",
                },
            }
        )
    )

    mock_bus.request.assert_called_once()
    assert mock_bus.request.call_args.args[0] == OrchestratorMethods.INFER_CHAT
    response_messages = [json.loads(call.args[0]) for call in mock_send_fn.call_args_list]
    assert response_messages[-1] == {"type": "eof", "id": "stream-inference-allowed"}


@pytest.mark.asyncio
async def test_stream_infer_chat_exception_is_redacted(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    method_info = _orchestrator_method_info(
        "StreamInferChat",
        OrchestratorMethods.STREAM_INFER_CHAT,
        OrchestratorInferChatRequest,
    )
    _registry_with_method(mock_registry, "Orchestrator", method_info)
    secret = "token=super-secret-native-stream-error"

    async def failing_stream_request(*_args, **_kwargs):
        raise RuntimeError(secret)
        yield  # pragma: no cover - keeps this function an async generator

    mock_bus.stream_request = failing_stream_request
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Orchestrator.use"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "stream-inference-error",
                "method": OrchestratorMethods.STREAM_INFER_CHAT,
                "params": {"messages": [{"role": "user", "content": "hi"}]},
            }
        )
    )

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["error"] == {
        "code": 500,
        "message": "Response stream failed",
        "reason_code": "response_stream_failed",
    }
    assert secret not in json.dumps(response)


@pytest.mark.asyncio
async def test_on_message_invalid_json(rpc_handler):
    await rpc_handler.on_message("invalid json")
    rpc_handler._send.assert_not_called()


@pytest.mark.asyncio
async def test_on_message_rejects_oversized_frame_before_registry_or_bus(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    handler = RPCHandler(mock_bus, mock_registry, mock_send_fn, _make_acl_with_perms("Svc.Call"))

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "oversized",
                "method": "Svc.Call",
                "params": {"payload": "x" * (256 * 1024 + 1)},
            }
        )
    )

    mock_registry.get_service.assert_not_called()
    mock_bus.request.assert_not_called()
    mock_send_fn.assert_not_called()


@pytest.mark.asyncio
async def test_on_message_rejects_deep_frame_before_registry_or_bus(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    nested: object = "leaf"
    for _ in range(18):
        nested = {"next": nested}
    handler = RPCHandler(mock_bus, mock_registry, mock_send_fn, _make_acl_with_perms("Svc.Call"))

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "deep",
                "method": "Svc.Call",
                "params": nested,
            }
        )
    )

    mock_registry.get_service.assert_not_called()
    mock_bus.request.assert_not_called()
    mock_send_fn.assert_not_called()


@pytest.mark.asyncio
async def test_on_message_rejects_malformed_subscribe_before_handler_work(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    handler = RPCHandler(mock_bus, mock_registry, mock_send_fn, _make_acl_with_perms("Svc.Call"))

    await handler.on_message(json.dumps({"type": "subscribe", "id": "sub-1", "topics": ["Svc.*"]}))

    mock_registry.get_service.assert_not_called()
    mock_bus.request.assert_not_called()
    mock_send_fn.assert_not_called()


@pytest.mark.asyncio
async def test_on_message_ignore_non_call(rpc_handler):
    await rpc_handler.on_message(json.dumps({"type": "not_call"}))
    rpc_handler._send.assert_not_called()


@pytest.mark.asyncio
async def test_handle_call_missing_method(rpc_handler):
    await rpc_handler.on_message(json.dumps({"type": "call", "id": "1"}))
    rpc_handler._send.assert_not_called()
    rpc_handler._bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_handle_call_method_not_found(rpc_handler, mock_registry):
    mock_registry.get_service.return_value = None
    mock_registry.get_external_methods.return_value = []

    await rpc_handler.on_message(
        json.dumps({"type": "call", "id": "1", "method": "Svc.NonExistent"})
    )

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 404


@pytest.mark.asyncio
async def test_handle_call_forbidden(rpc_handler, mock_registry, mock_acl_provider):
    method_info = MethodInfo(name="Secret", required_perms=["admin"], exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )
    # The default mock_acl_provider only has "user" permission, not "admin"

    await rpc_handler.on_message(json.dumps({"type": "call", "id": "1", "method": "Svc.Secret"}))

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403


@pytest.mark.asyncio
async def test_handle_call_success(rpc_handler, mock_registry, mock_bus):
    method_info = MethodInfo(name="Greet", bus_topic="Svc.Greet", exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )

    mock_bus.request.return_value = QueryResult(ok=True, data={"greeting": "hello"})

    await rpc_handler.on_message(
        json.dumps(
            {"type": "call", "id": "req-123", "method": "Svc.Greet", "params": {"name": "Alice"}}
        )
    )

    mock_bus.request.assert_called_once_with(
        "Svc.Greet",
        {"name": "Alice"},
        timeout=30.0,
        origin="external",
        principal_id="peer-user",
        effective_perms=["user"],
        identity_source="webrtc_rpc",
        method_type="use",
        caller_peer_id=None,
        auth_grant_revision=None,
        manifest_revision=None,
        correlation_id="req-123",
    )

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "result"
    assert response["id"] == "req-123"
    assert response["result"] == {"greeting": "hello"}


@pytest.mark.asyncio
async def test_handle_tooling_execute_injects_trusted_remote_provenance(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "ExecuteTool"
    method_info.bus_topic = ToolingMethods.EXECUTE_TOOL
    method_info.input_model = ToolingExecuteToolRequest
    method_info.required_perms = []
    method_info.method_type = "use"
    method_info.exposure = "external"
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Tooling", version="1.0", methods=[method_info]
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"ok": True})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(ToolingMethods.EXECUTE_TOOL),
        **_g007_mesh_projection_kwargs("Tooling", ToolingMethods.EXECUTE_TOOL),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "rpc-123",
                "method": ToolingMethods.EXECUTE_TOOL,
                "params": {
                    "tool_name": "switch_on",
                    "arguments": {"target": "lamp"},
                    "caller_peer_id": "spoofed",
                    "caller_principal_id": "spoofed-principal",
                },
            }
        )
    )

    mock_bus.request.assert_called_once()
    typed_request = mock_bus.request.call_args.args[1]
    assert isinstance(typed_request, ToolingExecuteToolRequest)
    assert typed_request.caller_peer_id == "remote-peer"
    assert typed_request.caller_principal_id == "peer-user"
    assert typed_request.correlation_id == "rpc-123"
    assert mock_bus.request.call_args.kwargs["correlation_id"] == "rpc-123"


@pytest.mark.asyncio
async def test_handle_call_uses_explicit_correlation_id(
    rpc_handler,
    mock_registry,
    mock_bus,
):
    method_info = MethodInfo(name="Greet", bus_topic="Svc.Greet", exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"greeting": "hello"})

    await rpc_handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "rpc-transport-id",
                "correlation_id": "trace-abc",
                "method": "Svc.Greet",
                "params": {"name": "Alice"},
            }
        )
    )

    assert mock_bus.request.call_args.kwargs["correlation_id"] == "trace-abc"
    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["id"] == "rpc-transport-id"


@pytest.mark.parametrize(
    ("topic", "method_name", "input_model", "params"),
    [
        (
            SchedulerMethods.SCHEDULE,
            "Schedule",
            SchedulerScheduleJobRequest,
            {
                "name": "spoof schedule",
                "action": "noop",
                "schedule": "* * * * *",
                "caller_peer_id": "victim-peer",
                "caller_principal_id": "victim-principal",
                "correlation_id": "spoofed-correlation",
            },
        ),
        (
            SchedulerMethods.SCHEDULE_ACTION,
            "ScheduleAction",
            SchedulerScheduleActionRequest,
            {
                "name": "spoof typed schedule",
                "schedule": "* * * * *",
                "action_spec": {
                    "kind": "tooling.execute",
                    "binding": {"tool_name": "reminder"},
                    "arguments": {"message": "hello"},
                    "caller_peer_id": "victim-peer",
                    "caller_principal_id": "victim-principal",
                },
                "caller_peer_id": "victim-peer",
                "caller_principal_id": "victim-principal",
                "correlation_id": "spoofed-correlation",
            },
        ),
        (
            SchedulerMethods.CANCEL,
            "Cancel",
            SchedulerCancelJobRequest,
            {
                "job_id": "job-1",
                "caller_peer_id": "victim-peer",
                "caller_principal_id": "victim-principal",
            },
        ),
        (
            SchedulerMethods.LIST_JOBS,
            "ListJobs",
            SchedulerListJobsRequest,
            {
                "caller_peer_id": "victim-peer",
                "caller_principal_id": "victim-principal",
            },
        ),
    ],
)
@pytest.mark.asyncio
async def test_handle_scheduler_methods_inject_trusted_remote_provenance(
    mock_bus,
    mock_registry,
    mock_send_fn,
    topic,
    method_name,
    input_model,
    params,
):
    method_info = MagicMock(spec=MethodInfo)
    method_info.name = method_name
    method_info.bus_topic = topic
    method_info.input_model = input_model
    method_info.required_perms = []
    method_info.method_type = "use"
    method_info.exposure = "external"
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Scheduler", version="1.0", methods=[method_info]
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"ok": True})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(topic),
        **_g007_mesh_projection_kwargs("Scheduler", topic, peer_id="real-peer"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "rpc-456",
                "method": topic,
                "params": params,
            }
        )
    )

    mock_bus.request.assert_called_once()
    typed_request = mock_bus.request.call_args.args[1]
    assert isinstance(typed_request, input_model)
    assert typed_request.caller_peer_id == "real-peer"
    assert typed_request.caller_principal_id == "peer-user"
    if topic in {SchedulerMethods.SCHEDULE, SchedulerMethods.SCHEDULE_ACTION}:
        assert typed_request.correlation_id == "rpc-456"
    if topic == SchedulerMethods.SCHEDULE_ACTION:
        assert typed_request.action_spec.caller_peer_id == "victim-peer"
        assert typed_request.action_spec.caller_principal_id == "victim-principal"


@pytest.mark.asyncio
async def test_handle_call_bus_error_is_redacted(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    audit_fn = AsyncMock()
    method_info = MethodInfo(name="Fail", exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        audit_fn=audit_fn,
    )

    secret = "api_key=super-secret-service-error"
    mock_bus.request.return_value = QueryResult(ok=False, error=secret)

    await handler.on_message(json.dumps({"type": "call", "id": "1", "method": "Svc.Fail"}))

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"] == {
        "code": 500,
        "message": "Service request failed",
        "reason_code": "service_request_failed",
    }
    assert response["correlation_id"] == "1"
    assert secret not in json.dumps(response)

    audit_fn.assert_awaited_once()
    audit_details = audit_fn.await_args.args[2]
    assert audit_details["details"]["service_error"] is True
    assert secret not in json.dumps(audit_details)


@pytest.mark.asyncio
async def test_handle_call_exception_is_redacted(rpc_handler, mock_registry, mock_bus):
    method_info = MethodInfo(name="Explode", exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )
    secret = "token=super-secret-exception"
    mock_bus.request.side_effect = RuntimeError(secret)

    await rpc_handler.on_message(
        json.dumps({"type": "call", "id": "exception-1", "method": "Svc.Explode"})
    )

    response = json.loads(rpc_handler._send.call_args.args[0])
    assert response["error"] == {
        "code": 500,
        "message": "Service request failed",
        "reason_code": "service_request_failed",
    }
    assert secret not in json.dumps(response)


@pytest.mark.asyncio
async def test_handle_call_returns_typed_contract_denial_payload(
    rpc_handler, mock_registry, mock_bus
):
    """A service-level `ok: false` response is data, not a transport failure."""

    method_info = MethodInfo(name="Prepare", exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )
    denial = {
        "ok": False,
        "policy_decision": {"allowed": False, "reason": "schema_hash_mismatch"},
    }
    mock_bus.request.return_value = QueryResult(ok=False, data=denial)

    await rpc_handler.on_message(json.dumps({"type": "call", "id": "2", "method": "Svc.Prepare"}))

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response == {"type": "result", "id": "2", "result": denial}


@pytest.mark.asyncio
async def test_handle_call_timeout(rpc_handler, mock_registry, mock_bus):
    method_info = MethodInfo(name="Slow", exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )

    mock_bus.request.side_effect = TimeoutError()

    await rpc_handler.on_message(json.dumps({"type": "call", "id": "1", "method": "Svc.Slow"}))

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 504
    assert response["correlation_id"] == "1"


@pytest.mark.asyncio
async def test_cancel_frame_cancels_active_non_stream_bus_request(
    mock_registry,
    mock_send_fn,
):
    started = asyncio.Event()
    cancelled = asyncio.Event()
    completed = False
    bus = AsyncMock()

    async def request(*args, **kwargs):
        nonlocal completed
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        completed = True
        return QueryResult(ok=True, data={"ok": True})

    bus.request.side_effect = request
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc",
        version="1.0",
        methods=[MethodInfo(name="Slow", bus_topic="Svc.Slow", exposure="external")],
    )
    handler = RPCHandler(bus, mock_registry, mock_send_fn, _make_acl_with_perms("Svc.Slow"))

    active = asyncio.create_task(
        handler.on_message(json.dumps({"type": "call", "id": "slow-1", "method": "Svc.Slow"}))
    )
    await started.wait()
    await handler.on_message(json.dumps({"type": "cancel", "id": "slow-1"}))

    with contextlib.suppress(asyncio.CancelledError):
        await active
    assert cancelled.is_set()
    assert completed is False
    assert handler._active_rpc_tasks == {}  # noqa: SLF001


@pytest.mark.asyncio
async def test_duplicate_active_call_id_rejected_without_overwriting_active_task(
    mock_registry,
    mock_send_fn,
):
    started = asyncio.Event()
    cancelled = asyncio.Event()
    bus = AsyncMock()

    async def request(*args, **kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    bus.request.side_effect = request
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc",
        version="1.0",
        methods=[MethodInfo(name="Slow", bus_topic="Svc.Slow", exposure="external")],
    )
    handler = RPCHandler(bus, mock_registry, mock_send_fn, _make_acl_with_perms("Svc.Slow"))

    active = asyncio.create_task(
        handler.on_message(json.dumps({"type": "call", "id": "slow-1", "method": "Svc.Slow"}))
    )
    await started.wait()
    tracked_task = handler._active_rpc_tasks["slow-1"]  # noqa: SLF001

    await handler.on_message(json.dumps({"type": "call", "id": "slow-1", "method": "Svc.Slow"}))

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response == {
        "type": "error",
        "id": "slow-1",
        "correlation_id": "slow-1",
        "error": {"code": 409, "message": "Duplicate active request id"},
    }
    assert bus.request.await_count == 1
    assert handler._active_rpc_tasks["slow-1"] is tracked_task  # noqa: SLF001

    await handler.on_message(json.dumps({"type": "cancel", "id": "slow-1"}))
    with contextlib.suppress(asyncio.CancelledError):
        await active
    assert cancelled.is_set()
    assert handler._active_rpc_tasks == {}  # noqa: SLF001


@pytest.mark.asyncio
async def test_call_id_reuse_after_active_task_cleanup_allowed(
    mock_registry,
    mock_send_fn,
):
    bus = AsyncMock()
    bus.request.return_value = QueryResult(ok=True, data={"ok": True})
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc",
        version="1.0",
        methods=[MethodInfo(name="Fast", bus_topic="Svc.Fast", exposure="external")],
    )
    handler = RPCHandler(bus, mock_registry, mock_send_fn, _make_acl_with_perms("Svc.Fast"))

    frame = json.dumps({"type": "call", "id": "reuse-1", "method": "Svc.Fast"})
    await handler.on_message(frame)
    await handler.on_message(frame)

    assert bus.request.await_count == 2
    responses = [json.loads(call.args[0]) for call in mock_send_fn.call_args_list]
    assert responses == [
        {"type": "result", "id": "reuse-1", "result": {"ok": True}},
        {"type": "result", "id": "reuse-1", "result": {"ok": True}},
    ]
    assert handler._active_rpc_tasks == {}  # noqa: SLF001


def test_parser_limits_frame_json_by_utf8_bytes():
    json_text = json.dumps(
        {"type": "result", "id": "emoji", "result": {"value": "🙂"}},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    byte_length = len(json_text.encode("utf-8"))

    assert (
        parse_webrtc_json_frame(
            json_text,
            limits=WebRTCParserLimits(max_string_length=byte_length),
        )["id"]
        == "emoji"
    )
    with pytest.raises(WebRTCFrameParseError, match="bounded string"):
        parse_webrtc_json_frame(
            json_text,
            limits=WebRTCParserLimits(max_string_length=byte_length - 1),
        )


def test_parser_limits_nested_strings_by_utf8_bytes():
    frame = {"type": "result", "id": "emoji", "result": {"value": "🙂🙂"}}

    assert (
        parse_webrtc_frame(frame, limits=WebRTCParserLimits(max_string_length=8))["id"] == "emoji"
    )
    with pytest.raises(WebRTCFrameParseError, match="oversized string"):
        parse_webrtc_frame(frame, limits=WebRTCParserLimits(max_string_length=7))


@pytest.mark.asyncio
async def test_handle_call_forbidden_audits_redacted_correlation(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    audit_fn = AsyncMock()
    method_info = MethodInfo(name="Secret", required_perms=["admin"], exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        audit_fn=audit_fn,
        **_g007_mesh_projection_kwargs("Svc", "Svc.Secret"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "rpc-1",
                "correlation_id": "trace-denied",
                "method": "Svc.Secret",
                "params": {"api_key": "super-secret", "safe": "value"},
            }
        )
    )

    audit_fn.assert_awaited_once()
    event, principal_id, details = audit_fn.await_args.args
    assert event == "access.denied.rpc"
    assert principal_id == "peer-user"
    assert details["peer_id"] == "remote-peer"
    assert details["correlation_id"] == "trace-denied"
    assert details["reason"] == "permission_denied"
    assert details["details"]["params"]["api_key"]["redacted"] is True
    assert details["details"]["params"]["safe"] == "value"


@pytest.mark.asyncio
async def test_handle_call_streaming(rpc_handler, mock_registry, mock_bus):
    method_info = MethodInfo(name="Stream", exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )

    async def mock_stream():
        yield "part1"
        yield b"part2"

    mock_bus.request.return_value = QueryResult(ok=True, data=mock_stream())

    await rpc_handler.on_message(json.dumps({"type": "call", "id": "s1", "method": "Svc.Stream"}))

    assert rpc_handler._send.call_count == 3

    calls = [json.loads(call[0][0]) for call in rpc_handler._send.call_args_list]
    assert calls[0] == {"type": "chunk", "id": "s1", "data": "part1"}
    assert calls[1] == {"type": "chunk", "id": "s1", "data": "part2"}
    assert calls[2] == {"type": "eof", "id": "s1"}


@pytest.mark.asyncio
async def test_handle_call_stream_error_is_redacted(rpc_handler, mock_registry, mock_bus):
    method_info = MethodInfo(name="Stream", exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )
    secret = "api_key=super-secret-stream-error"

    async def failing_stream():
        raise RuntimeError(secret)
        yield  # pragma: no cover - keeps this function an async generator

    mock_bus.request.return_value = QueryResult(ok=True, data=failing_stream())

    await rpc_handler.on_message(
        json.dumps({"type": "call", "id": "stream-error", "method": "Svc.Stream"})
    )

    response = json.loads(rpc_handler._send.call_args.args[0])
    assert response["error"] == {
        "code": 500,
        "message": "Response stream failed",
        "reason_code": "response_stream_failed",
    }
    assert secret not in json.dumps(response)


# ── Mesh sharing gate tests ─────────────────────────────────────────────


def _make_mesh_config(enabled: bool = True, sharing: dict | None = None):
    """Create a mock mesh config object."""
    cfg = MagicMock()
    cfg.enabled = enabled
    cfg.services = sharing or {}
    return cfg


def _make_sharing_entry(share: bool = True, allowed_peers=None, max_concurrent: int = 0):
    return mesh_policy(
        share=share,
        allowed_peers=allowed_peers,
        max_concurrent=max_concurrent,
    )


@pytest.mark.asyncio
async def test_mesh_gate_blocks_unshared_service(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    """Canonical method resolution happens before mesh sharing checks."""
    mesh_config = _make_mesh_config(enabled=True, sharing={})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        mesh_config=mesh_config,
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("TTS", "TTS.Request")]
        ),
    )
    await handler.on_message(json.dumps({"type": "call", "id": "m1", "method": "TTS.Request"}))
    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == 404


@pytest.mark.asyncio
async def test_mesh_gate_disabled_snapshot_blocks_non_infrastructure_without_dispatch(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    """A live disabled policy snapshot fails closed for normal RPC calls."""

    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=_make_mesh_config(
            enabled=False,
            sharing={"TTS": _make_sharing_entry(share=True)},
        ),
        peer_id="ephemeral-session",
        stable_peer_id_provider=lambda: "stable-peer",
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "disabled", "method": "TTS.Request"})
    )

    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 404
    mock_registry.get_service.assert_awaited_once()
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_mesh_gate_allows_shared_service(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    """When a service IS shared, calls pass through the mesh gate."""
    mesh_config = _make_mesh_config(
        enabled=True,
        sharing={"TTS": _make_sharing_entry(share=True)},
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=mesh_config,
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("TTS", "TTS.Request")]
        ),
    )

    method_info = MethodInfo(name="Request", exposure="external")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[method_info],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"status": "ok"})

    await handler.on_message(json.dumps({"type": "call", "id": "m2", "method": "TTS.Request"}))
    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "result"


def _speech_constraints(revision: int = 11) -> SpeechMethodConstraints:
    return SpeechMethodConstraints(
        exact_languages=["en"],
        ready_voice_ids=["standard:en:nova"],
        resident_model_identity_digest="a" * 64,
        speech_capability_revision=revision,
    )


def _provider_readiness(*, revision: int = 3) -> SimpleNamespace:
    return SimpleNamespace(
        connection_epoch="epoch-1",
        projection_digest="b" * 64,
        registry_revision="registry-1",
        export_policy_revision="policy-1",
        auth_grant_revision=1,
        compatible_services=("TTS",),
        revision=revision,
    )


def _speech_binding(payload, *, readiness: SimpleNamespace, capability_revision: int = 11):
    return SpeechRouteBinding(
        service_instance_id="remote:provider-a:TTS",
        projection_digest=readiness.projection_digest,
        projection_revision=compute_speech_projection_binding_revision(
            projection_digest=readiness.projection_digest,
            registry_revision=readiness.registry_revision,
            policy_revision=readiness.export_policy_revision,
            auth_grant_revision=readiness.auth_grant_revision,
        ),
        provider_lease_epoch=readiness.connection_epoch,
        provider_lease_revision=readiness.revision,
        speech_capability_revision=capability_revision,
        requirement_digest=compute_speech_route_requirement_digest_for_payload(
            TTSMethods.REQUEST,
            payload,
        ),
    )


@pytest.mark.asyncio
async def test_speech_route_binding_validates_before_rpc_dispatch(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    payload = SimpleNamespace(text="hi", language="en", voice="standard:en:nova")
    readiness = _provider_readiness()
    binding = _speech_binding(payload, readiness=readiness)
    constraints = _speech_constraints()
    projection = _active_projection(
        services=[
            _projected_service("TTS", TTSMethods.REQUEST, speech_constraints=constraints),
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(TTSMethods.REQUEST),
        mesh_config=_make_mesh_config(
            enabled=True,
            sharing={"TTS": _make_sharing_entry(share=True)},
        ),
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: projection,
        provider_readiness_provider=lambda service_id: service_id == "TTS",
        provider_binding_state_provider=lambda: (readiness, readiness.revision),
    )
    handler._find_method = AsyncMock(  # noqa: SLF001
        return_value=(
            "TTS",
            SimpleNamespace(
                name="Request",
                bus_topic=TTSMethods.REQUEST,
                exposure="external",
                required_perms=[TTSMethods.REQUEST],
                method_type="use",
                input_model=TTSRequest,
            ),
        )
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"accepted": True})

    await handler.on_parsed_message(
        {
            "type": "call",
            "id": "speech-ok",
            "method": TTSMethods.REQUEST,
            "params": {"text": "hi", "language": "en", "voice": "standard:en:nova"},
            "identity": {"speech_route_binding": binding.model_dump(mode="json")},
        }
    )

    mock_bus.request.assert_awaited_once()
    assert mock_bus.request.call_args.kwargs["speech_route_binding"] == binding


@pytest.mark.asyncio
async def test_speech_route_boundary_capability_changed_maps_to_sanitized_rpc_result(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    payload = SimpleNamespace(text="hi", language="en", voice="standard:en:nova")
    readiness = _provider_readiness()
    binding = _speech_binding(payload, readiness=readiness)
    constraints = _speech_constraints()
    projection = _active_projection(
        services=[
            _projected_service("TTS", TTSMethods.REQUEST, speech_constraints=constraints),
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(TTSMethods.REQUEST),
        mesh_config=_make_mesh_config(
            enabled=True,
            sharing={"TTS": _make_sharing_entry(share=True)},
        ),
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: projection,
        provider_readiness_provider=lambda service_id: service_id == "TTS",
        provider_binding_state_provider=lambda: (readiness, readiness.revision),
    )
    handler._find_method = AsyncMock(  # noqa: SLF001
        return_value=(
            "TTS",
            SimpleNamespace(
                name="Request",
                bus_topic=TTSMethods.REQUEST,
                exposure="external",
                required_perms=[TTSMethods.REQUEST],
                method_type="use",
                input_model=TTSRequest,
            ),
        )
    )
    mock_bus.request.return_value = QueryResult(
        ok=False,
        error="capability_changed",
        data={"code": "CAPABILITY_CHANGED"},
    )

    await handler.on_parsed_message(
        {
            "type": "call",
            "id": "speech-boundary-change",
            "method": TTSMethods.REQUEST,
            "params": {"text": "hi", "language": "en", "voice": "standard:en:nova"},
            "identity": {"speech_route_binding": binding.model_dump(mode="json")},
        }
    )

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "result"
    assert response["result"]["accepted"] is False
    assert response["result"]["reason_code"] == "capability_changed"


@pytest.mark.asyncio
async def test_speech_route_binding_in_params_is_ignored_in_favor_of_identity(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    payload = SimpleNamespace(text="hi", language="en", voice="standard:en:nova")
    readiness = _provider_readiness()
    binding = _speech_binding(payload, readiness=readiness)
    forged = binding.model_copy(update={"provider_lease_revision": 99})
    constraints = _speech_constraints()
    projection = _active_projection(
        services=[
            _projected_service("TTS", TTSMethods.REQUEST, speech_constraints=constraints),
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(TTSMethods.REQUEST),
        mesh_config=_make_mesh_config(
            enabled=True,
            sharing={"TTS": _make_sharing_entry(share=True)},
        ),
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: projection,
        provider_readiness_provider=lambda service_id: service_id == "TTS",
        provider_binding_state_provider=lambda: (readiness, readiness.revision),
    )
    handler._find_method = AsyncMock(  # noqa: SLF001
        return_value=(
            "TTS",
            SimpleNamespace(
                name="Request",
                bus_topic=TTSMethods.REQUEST,
                exposure="external",
                required_perms=[TTSMethods.REQUEST],
                method_type="use",
                input_model=TTSRequest,
            ),
        )
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"accepted": True})

    await handler.on_parsed_message(
        {
            "type": "call",
            "id": "speech-param-forge",
            "method": TTSMethods.REQUEST,
            "params": {
                "text": "hi",
                "language": "en",
                "voice": "standard:en:nova",
                "speech_route_binding": forged.model_dump(mode="json"),
            },
            "identity": {"speech_route_binding": binding.model_dump(mode="json")},
        }
    )

    mock_bus.request.assert_awaited_once()
    assert mock_bus.request.call_args.kwargs["speech_route_binding"] == binding
    typed_request = mock_bus.request.call_args.args[1]
    assert not hasattr(typed_request, "speech_route_binding")


@pytest.mark.parametrize(
    "mutator",
    [
        pytest.param(lambda b: b.model_copy(update={"provider_lease_revision": 2}), id="lease"),
        pytest.param(
            lambda b: b.model_copy(update={"projection_digest": "c" * 64}), id="projection"
        ),
        pytest.param(
            lambda b: b.model_copy(update={"service_instance_id": "remote:other:TTS"}),
            id="service-instance",
        ),
        pytest.param(
            lambda b: b.model_copy(update={"speech_capability_revision": 99}),
            id="capability",
        ),
        pytest.param(lambda b: b.model_copy(update={"requirement_digest": "d" * 64}), id="need"),
    ],
)
@pytest.mark.asyncio
async def test_speech_route_binding_adversarial_changes_fail_pre_dispatch(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mutator,
):
    payload = SimpleNamespace(text="hi", language="en", voice="standard:en:nova")
    readiness = _provider_readiness()
    constraints = _speech_constraints()
    projection = _active_projection(
        services=[
            _projected_service("TTS", TTSMethods.REQUEST, speech_constraints=constraints),
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(TTSMethods.REQUEST),
        mesh_config=_make_mesh_config(
            enabled=True,
            sharing={"TTS": _make_sharing_entry(share=True)},
        ),
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: projection,
        provider_readiness_provider=lambda service_id: service_id == "TTS",
        provider_binding_state_provider=lambda: (readiness, readiness.revision),
    )
    handler._find_method = AsyncMock(  # noqa: SLF001
        return_value=(
            "TTS",
            SimpleNamespace(
                name="Request",
                bus_topic=TTSMethods.REQUEST,
                exposure="external",
                required_perms=[TTSMethods.REQUEST],
                method_type="use",
                input_model=TTSRequest,
            ),
        )
    )
    binding = mutator(_speech_binding(payload, readiness=readiness))

    await handler.on_parsed_message(
        {
            "type": "call",
            "id": "speech-stale",
            "method": TTSMethods.REQUEST,
            "params": {
                "text": "hi",
                "language": "en",
                "voice": "standard:en:nova",
                "speech_route_binding": binding.model_dump(mode="json"),
            },
            "identity": {"speech_route_binding": binding.model_dump(mode="json")},
        }
    )

    mock_bus.request.assert_not_called()
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "result"
    assert response["result"] == {
        "accepted": False,
        "reason_code": "capability_changed",
        "error": "capability_changed",
    }


@pytest.mark.parametrize(
    ("allowed_peers", "peer_id", "expected_type"),
    [
        pytest.param(None, "peer-a", "result", id="null-allows-authenticated-peer"),
        pytest.param([], "peer-a", "result", id="empty-no-longer-denies"),
        pytest.param(["peer-a"], "peer-a", "result", id="populated-allows-member"),
        pytest.param(["peer-b"], "peer-a", "result", id="populated-no-longer-denies"),
    ],
)
@pytest.mark.asyncio
async def test_legacy_inbound_allowed_peers_semantics_are_locked(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
    allowed_peers,
    peer_id,
    expected_type,
):
    """Legacy inbound allowed-peer lists no longer gate direct RPC."""

    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=_make_mesh_config(
            enabled=True,
            sharing={
                "TTS": _make_sharing_entry(
                    share=True,
                    allowed_peers=allowed_peers,
                )
            },
        ),
        peer_id=f"session-for-{peer_id}",
        stable_peer_id_provider=lambda peer_id=peer_id: peer_id,
        active_projection_provider=lambda peer_id=peer_id: _active_projection(
            recipient=peer_id,
            services=[_projected_service("TTS", "TTS.Request")],
        ),
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[MethodInfo(name="Request", exposure="external")],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"status": "ok"})

    await handler.on_message(
        json.dumps({"type": "call", "id": "legacy-allowlist", "method": "TTS.Request"})
    )

    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == expected_type
    mock_bus.request.assert_awaited_once()


@pytest.mark.asyncio
async def test_legacy_inbound_allowed_peers_denies_matching_ephemeral_only_id(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    """Session-id allowlist matches no longer deny direct RPC."""

    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        mesh_config=_make_mesh_config(
            enabled=True,
            sharing={"TTS": _make_sharing_entry(share=True, allowed_peers=["ephemeral-session"])},
        ),
        peer_id="ephemeral-session",
        stable_peer_id_provider=lambda: None,
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[MethodInfo(name="Request", exposure="external")],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"status": "ok"})

    await handler.on_message(
        json.dumps({"type": "call", "id": "legacy-ephemeral", "method": "TTS.Request"})
    )

    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["message"] == "Authority is not available"
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_live_policy_swap_unshared_denies_existing_handler_without_bus_dispatch(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    store = MeshPolicyStore()
    store.replace(
        MeshConfig(
            enabled=True,
            services={
                "TTS": mesh_policy(
                    share=True,
                    unshared_feature_ids=["future-feature"],
                    unshared_method_ids=[],
                    max_concurrent=2,
                )
            },
        ),
        source_revision=1,
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=store.current().mesh_config,
        policy_provider=store.provider(),
        peer_id="peer-a",
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=(
                [_projected_service("TTS", "TTS.Request")]
                if store.current().mesh_config.services["TTS"].export.share
                and "TTS.Request"
                not in store.current().mesh_config.services["TTS"].export.unshared_method_ids
                else []
            )
        ),
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[MethodInfo(name="Request", bus_topic="TTS.Request", exposure="external")],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"status": "ok"})

    await handler.on_message(json.dumps({"type": "call", "id": "before", "method": "TTS.Request"}))
    first = json.loads(mock_send_fn.call_args[0][0])
    assert first["type"] == "result"
    assert store.current().mesh_config.services["TTS"].export.unshared_feature_ids == (
        "future-feature",
    )
    mock_bus.request.assert_awaited_once()

    mock_bus.request.reset_mock()
    store.replace(
        MeshConfig(enabled=True, services={"TTS": mesh_policy(share=False)}),
        source_revision=2,
    )

    await handler.on_message(json.dumps({"type": "call", "id": "after", "method": "TTS.Request"}))

    second = json.loads(mock_send_fn.call_args[0][0])
    assert second["type"] == "error"
    assert second["error"]["code"] == 403
    assert second["error"]["message"] == "Service TTS is not shared"
    assert store.current().source_revision == 2
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_mesh_gate_skips_pairing_methods(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    """Pairing/auth infrastructure methods bypass the mesh sharing gate entirely."""
    # ANONYMOUS identity so we also verify ANON allowlist works together
    anon_identity = Identity(
        principal_id="anonymous",
        principal_name="anonymous",
        is_admin=False,
        effective_perms=frozenset(),
        source="webrtc_peer",
    )
    acl_provider = MagicMock(return_value=anon_identity)

    mesh_config = _make_mesh_config(enabled=True, sharing={})  # No services shared
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        acl_provider,
        mesh_config=mesh_config,
        pairing_context_provider=lambda: {
            "pairing_session_id": "a" * 64,
            "verification_code": "48271935",
            "device_name": "test",
            "remote_peer_id": "stable-test-peer",
            "remote_node_name": "test",
            "room_name": "private-room",
        },
    )

    method_info = MethodInfo(name="PairingStart")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Auth",
        version="1.0",
        methods=[method_info],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"code": "123456"})

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "p1",
                "method": "Auth.PairingStart",
                "params": {
                    "device_name": "test",
                    "remote_peer_id": "stable-test-peer",
                    "remote_node_name": "test",
                    "pairing_session_id": "a" * 64,
                    "verification_code": "48271935",
                    "room_name": "private-room",
                },
            }
        )
    )
    resp = json.loads(mock_send_fn.call_args[0][0])
    # Should NOT be blocked by mesh gate — pairing is infrastructure
    assert resp["type"] == "result"
    assert resp["result"]["code"] == "123456"


@pytest.mark.asyncio
async def test_mesh_gate_skips_login_method(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    """Auth.Login bypasses the mesh sharing gate."""
    anon_identity = Identity(
        principal_id="anonymous",
        principal_name="anonymous",
        is_admin=False,
        effective_perms=frozenset(),
        source="webrtc_peer",
    )
    acl_provider = MagicMock(return_value=anon_identity)

    mesh_config = _make_mesh_config(enabled=True, sharing={})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        acl_provider,
        mesh_config=mesh_config,
    )

    method_info = MethodInfo(name="Login")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Auth",
        version="1.0",
        methods=[method_info],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"token": "abc"})

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "l1",
                "method": "Auth.Login",
                "params": {"username": "admin", "password": "pass"},
            }
        )
    )
    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "result"


@pytest.mark.asyncio
async def test_mesh_gate_does_not_skip_non_auth_login_short_name(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    """Only fully-qualified Auth infrastructure methods bypass mesh sharing."""
    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset({"Svc.use"}),
        source="webrtc_peer",
    )
    mesh_config = _make_mesh_config(enabled=True, sharing={})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        MagicMock(return_value=identity),
        mesh_config=mesh_config,
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(services=[]),
    )

    method_info = MethodInfo(
        name="Login",
        bus_topic="Svc.Login",
        exposure="internal",
        required_perms=["Svc.use"],
        method_type="use",
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc",
        version="1.0",
        methods=[method_info],
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "svc-login", "method": "Svc.Login", "params": {}})
    )

    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == 403
    assert resp["error"]["message"] == "Service Svc is not shared"
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_internal_non_auth_login_not_exposure_bypassed_when_service_shared(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    """A shared internal Svc.Login remains denied by exposure/auth gates."""
    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset({"Svc.use"}),
        source="webrtc_peer",
    )
    mesh_config = _make_mesh_config(
        enabled=True,
        sharing={"Svc": _make_sharing_entry(share=True)},
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        MagicMock(return_value=identity),
        mesh_config=mesh_config,
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("Svc", "Svc.Login")]
        ),
    )
    method_info = MethodInfo(
        name="Login",
        bus_topic="Svc.Login",
        exposure="internal",
        required_perms=["Svc.use"],
        method_type="use",
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc",
        version="1.0",
        methods=[method_info],
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "svc-login-2", "method": "Svc.Login", "params": {}})
    )

    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == 403
    assert resp["error"]["message"] == "Method is not exposed for WebRTC RPC"
    mock_bus.request.assert_not_called()


@pytest.mark.parametrize(
    ("effective_perms", "expected_type", "expected_message"),
    [
        pytest.param(
            ["Svc.use"], "error", "Method is not exposed for WebRTC RPC", id="rbac-allows"
        ),
        pytest.param([], "error", "Method is not exposed for WebRTC RPC", id="rbac-denies"),
    ],
)
@pytest.mark.asyncio
async def test_shared_internal_non_login_legacy_exposure_bypass_still_requires_rbac(
    mock_bus,
    mock_registry,
    mock_send_fn,
    effective_perms,
    expected_type,
    expected_message,
):
    """Shared internal methods are no longer exposure-bypassed."""

    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset(effective_perms),
        source="webrtc_peer",
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        MagicMock(return_value=identity),
        mesh_config=_make_mesh_config(
            enabled=True,
            sharing={"Svc": _make_sharing_entry(share=True)},
        ),
        peer_id="peer-a",
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("Svc", "Svc.InternalAction")]
        ),
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc",
        version="1.0",
        methods=[
            MethodInfo(
                name="InternalAction",
                bus_topic="Svc.InternalAction",
                exposure="internal",
                required_perms=["Svc.use"],
                method_type="use",
            )
        ],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"status": "ok"})

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "legacy-internal",
                "method": "Svc.InternalAction",
                "params": {},
            }
        )
    )

    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == expected_type
    if expected_message is not None:
        assert response["error"]["message"] == expected_message
        mock_bus.request.assert_not_called()
    else:
        mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_mesh_gate_capacity_exceeded(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    """When a shared service is at capacity, calls are rejected 429."""
    sharing = _make_sharing_entry(share=True, max_concurrent=1)
    mesh_config = _make_mesh_config(
        enabled=True,
        sharing={"TTS": sharing},
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=mesh_config,
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("TTS", "TTS.Request", capacity=1)]
        ),
    )
    # Simulate an active call already
    handler._active_remote_calls["TTS"] = 1
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[MethodInfo(name="Request", exposure="external")],
    )

    await handler.on_message(json.dumps({"type": "call", "id": "c1", "method": "TTS.Request"}))
    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == 429


@pytest.mark.asyncio
async def test_mesh_capacity_notification_errors_do_not_leak_or_mask_success(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    notify_calls: list[tuple[str, int, int]] = []

    def notify(module: str, available: int, max_concurrent: int) -> None:
        notify_calls.append((module, available, max_concurrent))
        raise RuntimeError("notify failed")

    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=_make_mesh_config(
            enabled=True,
            sharing={"TTS": _make_sharing_entry(share=True, max_concurrent=1)},
        ),
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("TTS", "TTS.Request", capacity=1)]
        ),
        capacity_notify_fn=notify,
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[MethodInfo(name="Request", bus_topic="TTS.Request", exposure="external")],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"ok": True})

    await handler.on_message(
        json.dumps({"type": "call", "id": "notify-ok", "method": "TTS.Request"})
    )

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "result"
    assert response["result"] == {"ok": True}
    assert handler._active_remote_calls["TTS"] == 0
    assert notify_calls == [("TTS", 0, 1), ("TTS", 1, 1)]


@pytest.mark.asyncio
async def test_mesh_capacity_releases_on_cancel_and_rejects_concurrent_n_plus_one(
    mock_registry,
    mock_send_fn,
):
    started = asyncio.Event()
    release = asyncio.Event()
    bus = AsyncMock()

    async def request(*args, **kwargs):
        started.set()
        await release.wait()
        return QueryResult(ok=True, data={"ok": True})

    bus.request.side_effect = request
    handler = RPCHandler(
        bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=_make_mesh_config(
            enabled=True,
            sharing={"TTS": _make_sharing_entry(share=True, max_concurrent=1)},
        ),
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("TTS", "TTS.Request", capacity=1)]
        ),
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[MethodInfo(name="Request", bus_topic="TTS.Request", exposure="external")],
    )

    first = asyncio.create_task(
        handler.on_message(
            json.dumps({"type": "call", "id": "capacity-1", "method": "TTS.Request"})
        )
    )
    await started.wait()

    await handler.on_message(
        json.dumps({"type": "call", "id": "capacity-2", "method": "TTS.Request"})
    )
    second_response = json.loads(mock_send_fn.call_args.args[0])
    assert second_response["type"] == "error"
    assert second_response["error"]["code"] == 429
    assert handler._active_remote_calls["TTS"] == 1

    first.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await first
    assert handler._active_remote_calls["TTS"] == 0
    release.set()


@pytest.mark.asyncio
async def test_mesh_gate_blocks_broad_auth_admin_when_not_shared(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    """Auth admin methods are not routed unless Auth is explicitly shared."""
    admin_identity = Identity(
        principal_id="admin",
        principal_name="admin",
        is_admin=True,
        effective_perms=frozenset(["*"]),
        source="webrtc_peer",
    )
    acl_provider = MagicMock(return_value=admin_identity)
    mesh_config = _make_mesh_config(enabled=True, sharing={})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        acl_provider,
        mesh_config=mesh_config,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "auth-admin",
                "method": "Auth.ListPrincipals",
                "params": {},
            }
        )
    )

    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == 404
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_mesh_gate_blocks_config_mutation_when_not_shared(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    """Config mutation is not transparently routed by default."""
    admin_identity = Identity(
        principal_id="admin",
        principal_name="admin",
        is_admin=True,
        effective_perms=frozenset(["*"]),
        source="webrtc_peer",
    )
    acl_provider = MagicMock(return_value=admin_identity)
    mesh_config = _make_mesh_config(enabled=True, sharing={})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        acl_provider,
        mesh_config=mesh_config,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "config-set",
                "method": "Config.Set",
                "params": {"key_path": "services.gateway.enabled", "value": True},
            }
        )
    )

    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == 404
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_explicit_auth_share_still_requires_method_permissions(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    """An explicit Auth share does not bypass normal Auth method permissions."""
    mesh_config = _make_mesh_config(
        enabled=True,
        sharing={"Auth": _make_sharing_entry(share=True)},
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        mesh_config=mesh_config,
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("Auth", "Auth.ListPrincipals")]
        ),
    )
    method_info = MethodInfo(
        name="ListPrincipals",
        required_perms=["Auth.manage"],
        method_type="manage",
        exposure="external",
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Auth",
        version="1.0",
        methods=[method_info],
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "auth-shared", "method": "Auth.ListPrincipals"})
    )

    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == 403
    assert resp["error"]["message"] == "Forbidden"
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_tts_manage_rpc_uses_registry_method_type_not_forged_caller_metadata(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    """A caller cannot downgrade a registered manage method by forging use metadata."""

    topic = TTSMethods.LIST_VOICE_PROFILES
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[
            MethodInfo(
                name="ListVoiceProfiles",
                bus_topic=topic,
                exposure="both",
                required_perms=["TTS.manage"],
                method_type="manage",
            )
        ],
    )
    projected_method = SimpleNamespace(
        topic=topic,
        required_permissions=("TTS.manage",),
        method_type="use",
        speech_constraints=None,
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.use"),
        mesh_config=_make_mesh_config(
            enabled=True,
            sharing={"TTS": _make_sharing_entry(share=True)},
        ),
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[
                SimpleNamespace(
                    service_id="TTS",
                    capacity={"max_concurrent": 0},
                    methods=[projected_method],
                )
            ]
        ),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "tts-forged-manage",
                "method": topic,
                "identity": {"method_type": "use"},
                "params": {"method_type": "use", "include_unavailable": True},
            }
        )
    )

    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == 403
    assert resp["error"]["message"] == "Forbidden"
    mock_bus.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_call_datetime_in_response(rpc_handler, mock_registry, mock_bus):
    """RPC result containing a datetime must be serialized via ISO-8601."""
    from datetime import datetime, timedelta

    method_info = MethodInfo(name="PairingConnect", bus_topic="Auth.PairingConnect")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Auth", version="1.0", methods=[method_info]
    )

    expires = datetime(2025, 7, 1, 12, 0, 0)
    mock_bus.request.return_value = QueryResult(
        ok=True,
        data={
            "request_id": "abc",
            "device_name": "dev",
            "status": "pending",
            "expires_at": expires,
        },
    )

    await rpc_handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "dt-1",
                "method": "Auth.PairingConnect",
                "params": {"code": "123456"},
            }
        )
    )

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "result"
    assert response["id"] == "dt-1"
    assert response["result"]["expires_at"] == "2025-07-01T12:00:00"


@pytest.mark.parametrize(
    "claimed_peer_id,claimed_provider_id,claimed_service_instance_id",
    [
        ("local", "local", "local:Tooling"),
        ("victim-peer", "victim-provider", "remote:victim-peer:Tooling"),
    ],
)
@pytest.mark.asyncio
async def test_legacy_forwarded_tooling_catalog_event_is_rejected_without_fallback(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
    claimed_peer_id,
    claimed_provider_id,
    claimed_service_instance_id,
):
    """G013 never accepts a legacy full-catalog event as a projection baseline."""

    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        mesh_config=MeshConfig(enabled=True, services={"Tooling": mesh_policy(share=True)}),
        peer_id="stable-remote-peer",
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": ToolingMethods.REMOTE_CATALOG_ANNOUNCED,
                "params": {
                    "peer_id": claimed_peer_id,
                    "service_instance_id": claimed_service_instance_id,
                    "provider_id": claimed_provider_id,
                    "catalog_epoch": 1,
                    "generated_at": "2026-07-05T00:00:00Z",
                    "full_schema_hash": "hash",
                    "tools": [],
                    "shared_by_policy": True,
                },
                "correlation_id": "catalog-sync-1",
            }
        )
    )

    mock_bus.publish.assert_not_awaited()


@pytest.mark.parametrize(
    "topic,event_payload",
    [
        (
            ToolingMethods.REMOTE_CATALOG_ANNOUNCED,
            {
                "full_schema_hash": "hash",
                "tools": [],
                "shared_by_policy": True,
            },
        ),
        (
            ToolingMethods.REMOTE_CATALOG_DELTA_ANNOUNCED,
            {
                "upserted_tools": [],
                "removed_global_tool_ids": [],
            },
        ),
        (ToolingMethods.REMOTE_CATALOG_REMOVED, {"reason": "peer-request"}),
    ],
)
@pytest.mark.asyncio
async def test_legacy_forwarded_tooling_catalog_events_are_all_rejected(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
    topic,
    event_payload,
):
    """Legacy catalog/delta/removal frames cannot become a projection baseline."""

    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        mesh_config=MeshConfig(enabled=True, services={"Tooling": mesh_policy(share=True)}),
        peer_id="stable-remote-peer",
    )
    claimed_authority = {
        "granted_permissions": ["*"],
        "provider_granted_permissions": ["*"],
        "provider_permissions": ["*"],
        "provider_available": True,
        "provider_authorized": True,
    }

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": topic,
                "params": {
                    "peer_id": "forged-peer",
                    "service_instance_id": "remote:forged-peer:Tooling",
                    "provider_id": "forged-provider",
                    "catalog_epoch": 1,
                    "generated_at": "2026-07-05T00:00:00Z",
                    **event_payload,
                    **claimed_authority,
                },
            }
        )
    )

    mock_bus.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_forwarded_event_live_disabled_policy_blocks_publish_same_handler(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    store = MeshPolicyStore()
    store.replace(
        MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)}),
        source_revision=1,
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        mesh_config=store.current().mesh_config,
        policy_provider=store.provider(),
        peer_id="session-peer",
        stable_peer_id_provider=lambda: "stable-peer",
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": "TTS.Started",
                "params": {"utterance_id": "u1"},
            }
        )
    )

    mock_bus.publish.assert_not_called()

    mock_bus.publish.reset_mock()
    store.replace(
        MeshConfig(enabled=False, services={"TTS": mesh_policy(share=True)}),
        source_revision=2,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": "TTS.Started",
                "params": {"utterance_id": "u2"},
            }
        )
    )

    mock_bus.publish.assert_not_called()


@pytest.mark.parametrize(
    ("allowed_peers", "stable_peer_id", "should_publish"),
    [
        pytest.param(None, "peer-a", False, id="null-rejects-unsafe"),
        pytest.param([], "peer-a", False, id="empty-rejects-unsafe"),
        pytest.param(["peer-a"], "peer-a", False, id="member-rejects-unsafe"),
        pytest.param(["peer-b"], "peer-a", False, id="nonmember-rejects-unsafe"),
    ],
)
@pytest.mark.asyncio
async def test_forwarded_events_enforce_stable_legacy_inbound_allowlist(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
    allowed_peers,
    stable_peer_id,
    should_publish,
):
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        mesh_config=MeshConfig(
            enabled=True,
            services={"TTS": mesh_policy(share=True, allowed_peers=allowed_peers)},
        ),
        peer_id="ephemeral-session",
        stable_peer_id_provider=lambda: stable_peer_id,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": "TTS.Started",
                "params": {"utterance_id": "u1"},
            }
        )
    )

    if should_publish:
        mock_bus.publish.assert_awaited_once()
    else:
        mock_bus.publish.assert_not_called()


@pytest.mark.asyncio
async def test_forwarded_event_does_not_enforce_g006_granular_export_exclusions(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        mesh_config=MeshConfig(
            enabled=True,
            services={
                "TTS": mesh_policy(
                    share=True,
                    unshared_feature_ids=["future-feature"],
                    unshared_method_ids=["TTS.Started"],
                )
            },
        ),
        peer_id="stable-peer",
        stable_peer_id_provider=lambda: "stable-peer",
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": "TTS.Started",
                "params": {"utterance_id": "u1"},
            }
        )
    )

    mock_bus.publish.assert_not_called()


@pytest.mark.asyncio
async def test_stream_infer_chat_without_stream_request_degrades_to_single_chunk(
    mock_registry,
    mock_send_fn,
):
    class _ProcessBusWithoutStreaming:
        def __init__(self) -> None:
            self.request = AsyncMock(
                return_value=QueryResult(
                    ok=True,
                    data={
                        "text": "process fallback",
                        "provider_id": "openai",
                        "model_id": "gpt-test",
                    },
                )
            )

    process_bus = _ProcessBusWithoutStreaming()
    method_info = MethodInfo(
        name="StreamInferChat",
        bus_topic=OrchestratorMethods.STREAM_INFER_CHAT,
        exposure="external",
        required_perms=["Orchestrator.use"],
        method_type="use",
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Orchestrator", version="1.0", methods=[method_info]
    )
    handler = RPCHandler(
        process_bus,  # type: ignore[arg-type]
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Orchestrator.use"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "stream-no-path",
                "method": OrchestratorMethods.STREAM_INFER_CHAT,
                "params": {"messages": [{"role": "user", "content": "hi"}]},
            }
        )
    )

    process_bus.request.assert_awaited_once()
    assert process_bus.request.await_args.args[0] == OrchestratorMethods.INFER_CHAT
    sent = [json.loads(call.args[0]) for call in mock_send_fn.call_args_list]
    assert sent[0]["type"] == "chunk"
    assert sent[0]["data"]["delta"] == "process fallback"
    assert sent[0]["data"]["is_final"] is True
    assert sent[1] == {"type": "eof", "id": "stream-no-path"}


def _active_projection(
    *,
    recipient: str = "peer-a",
    services: list | None = None,
    readiness: str = "ready",
    routable: bool = True,
):
    return SimpleNamespace(
        cache_key=SimpleNamespace(
            recipient_peer_id=recipient,
            provider_peer_id="provider-a",
            registry_revision="registry-1",
            policy_revision="policy-1",
            authority_revision=1,
        ),
        readiness=readiness,
        routable=routable,
        services=services or [],
    )


def _projected_service(
    module: str,
    *topics: str,
    capacity: int = 0,
    speech_constraints: SpeechMethodConstraints | None = None,
):
    return SimpleNamespace(
        service_id=module,
        capacity={"max_concurrent": capacity},
        methods=[
            SimpleNamespace(
                topic=topic,
                required_permissions=(topic,),
                method_type="use",
                speech_constraints=speech_constraints.model_dump(mode="json")
                if speech_constraints is not None
                else None,
            )
            for topic in topics
        ],
    )


def _g007_mesh_projection_kwargs(
    module: str,
    *topics: str,
    peer_id: str = "remote-peer",
) -> dict:
    projected_topics = list(topics)
    if module == "Tooling" and any(
        topic
        in {
            ToolingMethods.GET_EXPORT_CATALOG,
            ToolingMethods.GET_TOOLS,
            ToolingMethods.GET_TOOL_BY_NAME,
            ToolingMethods.PREPARE_EXECUTION,
            ToolingMethods.EXECUTE_TOOL,
            ToolingMethods.REQUEST_APPROVAL,
        }
        for topic in projected_topics
    ):
        projected_topics = list(
            dict.fromkeys(
                [
                    *projected_topics,
                    ToolingMethods.GET_TOOLS,
                    ToolingMethods.GET_EXPORT_CATALOG,
                    ToolingMethods.PREPARE_EXECUTION,
                    ToolingMethods.EXECUTE_TOOL,
                    ToolingMethods.REQUEST_APPROVAL,
                ]
            )
        )
    return {
        "mesh_config": MeshConfig(enabled=True, services={module: mesh_policy(share=True)}),
        "peer_id": peer_id,
        "stable_peer_id_provider": lambda: peer_id,
        "active_projection_provider": lambda: _active_projection(
            recipient=peer_id,
            services=[_projected_service(module, *projected_topics)],
        ),
        "tooling_authority_revision_provider": lambda: (7, 9),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "topic",
    [
        GatewayMethods.GET_REGISTRY,
        GatewayMethods.GET_SERVICES,
        GatewayMethods.GET_SERVICE_HEALTH,
        GatewayMethods.GET_DEPLOYMENT_TOPOLOGY,
        GatewayMethods.GET_MESH_STATUS,
        GatewayMethods.GET_WEBRTC_DIAGNOSTICS,
        GatewayMethods.GET_CAPABILITY_GRAPH,
        GatewayMethods.GET_CAPABILITY_CATALOG,
        GatewayMethods.EXPLAIN_ROUTE,
    ],
)
async def test_authenticated_gateway_bootstrap_reads_bypass_mesh_export_policy(
    mock_bus,
    mock_registry,
    mock_send_fn,
    topic,
):
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Gateway",
        version="1.0",
        methods=[
            MethodInfo(
                name=topic.rsplit(".", 1)[-1],
                bus_topic=topic,
                exposure="external",
                required_perms=["Gateway.use"],
                method_type="use",
            )
        ],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"secrets_redacted": True})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Gateway.use"),
        mesh_config=MeshConfig(enabled=True, services={}),
        peer_id="gateway-thin-session",
        stable_peer_id_provider=lambda: "gateway-thin-peer",
        authenticated_peer_validator=lambda: True,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": f"bootstrap-{topic}",
                "method": topic,
                "params": {},
            }
        )
    )

    mock_bus.request.assert_awaited_once()
    assert mock_bus.request.await_args.args[0] == topic
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "result"
    assert response["result"]["secrets_redacted"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("topic", "required_perms"),
    [
        (AuthMethods.WHO_AM_I, []),
        (AuthMethods.MESH_LIST_PEERS, []),
        (AuthMethods.MESH_GET_PEER, []),
        (AuthMethods.LIST_PENDING_PAIRINGS, ["Auth.manage"]),
    ],
)
async def test_authenticated_auth_bootstrap_reads_bypass_mesh_export_policy(
    mock_bus,
    mock_registry,
    mock_send_fn,
    topic,
    required_perms,
):
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Auth",
        version="1.0",
        methods=[
            MethodInfo(
                name=topic.rsplit(".", 1)[-1],
                bus_topic=topic,
                exposure="both",
                required_perms=required_perms,
                method_type="use",
            )
        ],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"secrets_redacted": True})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(*(required_perms or ["member"])),
        mesh_config=MeshConfig(enabled=True, services={}),
        peer_id="auth-thin-session",
        stable_peer_id_provider=lambda: "auth-thin-peer",
        authenticated_peer_validator=lambda: True,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": f"bootstrap-{topic}",
                "method": topic,
                "params": {},
            }
        )
    )

    mock_bus.request.assert_awaited_once()
    assert mock_bus.request.await_args.args[0] == topic
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "result"
    assert response["result"]["secrets_redacted"] is True


@pytest.mark.asyncio
async def test_authenticated_auth_manage_bootstrap_read_still_requires_permission(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    topic = AuthMethods.LIST_PENDING_PAIRINGS
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Auth",
        version="1.0",
        methods=[
            MethodInfo(
                name="ListPendingPairings",
                bus_topic=topic,
                exposure="both",
                required_perms=["Auth.manage"],
                method_type="manage",
            )
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("member"),
        mesh_config=MeshConfig(enabled=True, services={}),
        peer_id="auth-thin-session",
        stable_peer_id_provider=lambda: "auth-thin-peer",
        authenticated_peer_validator=lambda: True,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "auth-bootstrap-forbidden",
                "method": topic,
                "params": {},
            }
        )
    )

    mock_bus.request.assert_not_awaited()
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403
    assert response["error"]["message"] == "Forbidden"


@pytest.mark.asyncio
async def test_authenticated_gateway_bootstrap_read_still_requires_gateway_permission(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    topic = GatewayMethods.GET_CAPABILITY_CATALOG
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Gateway",
        version="1.0",
        methods=[
            MethodInfo(
                name="GetCapabilityCatalog",
                bus_topic=topic,
                exposure="external",
                required_perms=["Gateway.use"],
                method_type="use",
            )
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("user"),
        mesh_config=MeshConfig(enabled=True, services={}),
        peer_id="gateway-thin-session",
        stable_peer_id_provider=lambda: "gateway-thin-peer",
        authenticated_peer_validator=lambda: True,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "bootstrap-forbidden",
                "method": topic,
                "params": {},
            }
        )
    )

    mock_bus.request.assert_not_awaited()
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403
    assert response["error"]["message"] == "Forbidden"


@pytest.mark.asyncio
async def test_authenticated_gateway_bootstrap_read_still_requires_external_exposure(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    topic = GatewayMethods.GET_CAPABILITY_CATALOG
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Gateway",
        version="1.0",
        methods=[
            MethodInfo(
                name="GetCapabilityCatalog",
                bus_topic=topic,
                exposure="internal",
                required_perms=["Gateway.use"],
                method_type="use",
            )
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Gateway.use"),
        mesh_config=MeshConfig(enabled=True, services={}),
        peer_id="gateway-thin-session",
        stable_peer_id_provider=lambda: "gateway-thin-peer",
        authenticated_peer_validator=lambda: True,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "bootstrap-internal-contract",
                "method": topic,
                "params": {},
            }
        )
    )

    mock_bus.request.assert_not_awaited()
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403
    assert response["error"]["message"] == "Method is not exposed for WebRTC RPC"


@pytest.mark.asyncio
async def test_gateway_secret_read_does_not_bypass_mesh_export_policy(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    topic = GatewayMethods.GET_MESH_INVITE_CONFIG
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Gateway",
        version="1.0",
        methods=[
            MethodInfo(
                name="GetMeshInviteConfig",
                bus_topic=topic,
                exposure="external",
                required_perms=["Gateway.manage"],
                method_type="manage",
            )
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("Gateway.manage"),
        mesh_config=MeshConfig(enabled=True, services={}),
        peer_id="gateway-thin-session",
        stable_peer_id_provider=lambda: "gateway-thin-peer",
        authenticated_peer_validator=lambda: True,
        active_projection_provider=lambda: _active_projection(
            recipient="gateway-thin-peer",
            services=[],
        ),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "gateway-secret-denied",
                "method": topic,
                "params": {},
            }
        )
    )

    mock_bus.request.assert_not_awaited()
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403
    assert response["error"]["message"] == "Service Gateway is not shared"


@pytest.mark.asyncio
async def test_g007_ready_projection_accepts_exact_shared_method(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    method_info = MethodInfo(
        name="Request",
        bus_topic="TTS.Request",
        exposure="external",
        required_perms=["TTS.Request"],
        method_type="use",
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS", version="1.0", methods=[method_info]
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"status": "ok"})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)}),
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("TTS", "TTS.Request")]
        ),
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "g007-ok", "method": "TTS.Request", "params": {}})
    )

    mock_bus.request.assert_awaited_once()
    assert json.loads(mock_send_fn.call_args.args[0])["type"] == "result"


@pytest.mark.asyncio
async def test_tooling_export_dispatch_stamps_authenticated_exact_projection_evidence(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    method_info = MethodInfo(
        name="GetExportCatalog",
        bus_topic=ToolingMethods.GET_EXPORT_CATALOG,
        exposure="external",
        required_perms=[ToolingMethods.GET_TOOLS],
        method_type="use",
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Tooling", version="1.0", methods=[method_info]
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"complete": True})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(ToolingMethods.GET_TOOLS, ToolingMethods.GET_EXPORT_CATALOG),
        mesh_config=MeshConfig(enabled=True, services={"Tooling": mesh_policy(share=True)}),
        peer_id="session-a",
        stable_peer_id_provider=lambda: "peer-a",
        authenticated_peer_validator=lambda: True,
        active_projection_provider=lambda: _active_projection(
            services=[
                _projected_service(
                    "Tooling",
                    ToolingMethods.GET_TOOLS,
                    ToolingMethods.GET_EXPORT_CATALOG,
                    ToolingMethods.PREPARE_EXECUTION,
                    ToolingMethods.EXECUTE_TOOL,
                )
            ]
        ),
        tooling_authority_revision_provider=lambda: (7, 9),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "projection-evidence",
                "method": ToolingMethods.GET_EXPORT_CATALOG,
                "params": {},
            }
        )
    )

    kwargs = mock_bus.request.await_args.kwargs
    assert kwargs["auth_grant_revision"] == 7
    assert kwargs["manifest_revision"] == 9
    assert kwargs["projected_service_id"] == "Tooling"
    assert kwargs["projected_method_id"] == ToolingMethods.GET_EXPORT_CATALOG
    expected_topics = sorted(
        [
            ToolingMethods.GET_TOOLS,
            ToolingMethods.GET_EXPORT_CATALOG,
            ToolingMethods.PREPARE_EXECUTION,
            ToolingMethods.EXECUTE_TOOL,
        ]
    )
    assert kwargs["projected_method_topics"] == expected_topics
    assert (
        kwargs["projected_method_set_digest"]
        == hashlib.sha256(json.dumps(expected_topics, separators=(",", ":")).encode()).hexdigest()
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("topic", "input_model"),
    [
        (ToolingMethods.PREPARE_EXECUTION, ToolingPrepareExecutionRequest),
        (ToolingMethods.EXECUTE_TOOL, ToolingExecuteToolRequest),
        (ToolingMethods.REQUEST_APPROVAL, ToolingRequestApprovalRequest),
    ],
)
async def test_tooling_execution_dispatch_stamps_exact_projection_evidence(
    mock_bus,
    mock_registry,
    mock_send_fn,
    topic,
    input_model,
):
    method_info = MethodInfo(
        name=topic.rsplit(".", 1)[-1],
        bus_topic=topic,
        exposure="external",
        required_perms=[topic],
        method_type="use",
    )
    method_info.input_model = input_model
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Tooling", version="1.0", methods=[method_info]
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"ok": True})
    projected_topics = sorted(
        [
            ToolingMethods.GET_TOOLS,
            ToolingMethods.GET_EXPORT_CATALOG,
            ToolingMethods.PREPARE_EXECUTION,
            ToolingMethods.EXECUTE_TOOL,
            ToolingMethods.REQUEST_APPROVAL,
        ]
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(topic),
        mesh_config=MeshConfig(enabled=True, services={"Tooling": mesh_policy(share=True)}),
        peer_id="session-a",
        stable_peer_id_provider=lambda: "peer-a",
        authenticated_peer_validator=lambda: True,
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("Tooling", *projected_topics)]
        ),
        tooling_authority_revision_provider=lambda: (11, 13),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": f"projection-evidence-{topic}",
                "method": topic,
                "params": {"tool_name": "demo", "arguments": {}},
            }
        )
    )

    kwargs = mock_bus.request.await_args.kwargs
    assert kwargs["auth_grant_revision"] == 11
    assert kwargs["manifest_revision"] == 13
    assert kwargs["projected_service_id"] == "Tooling"
    assert kwargs["projected_method_id"] == topic
    assert kwargs["projected_method_topics"] == projected_topics


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("topic", "input_model", "params"),
    [
        (ToolingMethods.GET_TOOLS, ToolingGetToolsRequest, {}),
        (ToolingMethods.GET_TOOL_BY_NAME, ToolingGetToolByNameRequest, {"name": "demo"}),
    ],
)
async def test_tooling_discovery_dispatch_stamps_exact_projection_evidence(
    mock_bus,
    mock_registry,
    mock_send_fn,
    topic,
    input_model,
    params,
):
    method_info = MethodInfo(
        name=topic.rsplit(".", 1)[-1],
        bus_topic=topic,
        exposure="external",
        required_perms=[ToolingMethods.GET_TOOLS],
        method_type="use",
    )
    method_info.input_model = input_model
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Tooling", version="1.0", methods=[method_info]
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"tools": [], "count": 0})
    projected_topics = sorted([ToolingMethods.GET_TOOLS, ToolingMethods.GET_TOOL_BY_NAME])
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(ToolingMethods.GET_TOOLS, topic),
        mesh_config=MeshConfig(enabled=True, services={"Tooling": mesh_policy(share=True)}),
        peer_id="session-a",
        stable_peer_id_provider=lambda: "peer-a",
        authenticated_peer_validator=lambda: True,
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("Tooling", *projected_topics)]
        ),
        tooling_authority_revision_provider=lambda: (17, 19),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": f"discovery-evidence-{topic}",
                "method": topic,
                "params": params,
            }
        )
    )

    kwargs = mock_bus.request.await_args.kwargs
    assert kwargs["auth_grant_revision"] == 17
    assert kwargs["manifest_revision"] == 19
    assert kwargs["projected_service_id"] == "Tooling"
    assert kwargs["projected_method_id"] == topic
    assert kwargs["projected_method_topics"] == projected_topics


@pytest.mark.asyncio
async def test_g007_projection_exclusion_denies_before_bus_dispatch(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    audit = AsyncMock()
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[MethodInfo(name="Request", bus_topic="TTS.Request", exposure="external")],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("*"),
        audit_fn=audit,
        mesh_config=MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)}),
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(services=[_projected_service("TTS")]),
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "g007-deny", "method": "TTS.Request", "params": {}})
    )

    mock_bus.request.assert_not_called()
    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["error"]["code"] == 403
    audit_details = audit.await_args.args[2]
    assert audit_details["reason"] == "method_not_shared"


@pytest.mark.asyncio
async def test_g007_mesh_rpc_missing_policy_denies_before_bus_dispatch(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[
            MethodInfo(
                name="Request",
                bus_topic="TTS.Request",
                exposure="external",
                required_perms=["TTS.Request"],
                method_type="use",
            )
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        peer_id="peer-a",
        policy_provider=lambda: SimpleNamespace(mesh_config=None),
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "g007-missing-policy", "method": "TTS.Request"})
    )

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403
    assert response["error"]["message"] == "Authority is not available"
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_g007_mesh_rpc_missing_projection_provider_denies_before_bus_dispatch(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[
            MethodInfo(
                name="Request",
                bus_topic="TTS.Request",
                exposure="external",
                required_perms=["TTS.Request"],
                method_type="use",
            )
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)}),
        peer_id="peer-a",
        stable_peer_id_provider=lambda: "peer-a",
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "g007-missing-provider", "method": "TTS.Request"})
    )

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403
    assert response["error"]["message"] == "Authority is not available"
    mock_bus.request.assert_not_called()


@pytest.mark.asyncio
async def test_g007_forwarded_mesh_event_missing_policy_denies_publish(
    mock_bus,
    mock_registry,
    mock_send_fn,
    mock_acl_provider,
):
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        mock_acl_provider,
        peer_id="peer-a",
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": ToolingMethods.REMOTE_CATALOG_ANNOUNCED,
                "params": {"catalog_epoch": 1, "generated_at": "now", "tools": []},
            }
        )
    )

    mock_bus.publish.assert_not_called()


@pytest.mark.asyncio
async def test_g007_internal_method_still_denied_even_when_projected(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc",
        version="1.0",
        methods=[
            MethodInfo(
                name="InternalAction",
                bus_topic="Svc.InternalAction",
                exposure="internal",
                required_perms=["Svc.use"],
            )
        ],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("*"),
        mesh_config=MeshConfig(enabled=True, services={"Svc": mesh_policy(share=True)}),
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("Svc", "Svc.InternalAction")]
        ),
    )

    await handler.on_message(
        json.dumps(
            {"type": "call", "id": "g007-internal", "method": "Svc.InternalAction", "params": {}}
        )
    )

    mock_bus.request.assert_not_called()
    assert json.loads(mock_send_fn.call_args.args[0])["error"]["message"] == (
        "Method is not exposed for WebRTC RPC"
    )


@pytest.mark.asyncio
async def test_g007_tooling_request_binds_authenticated_stable_peer(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Tooling",
        version="1.0",
        methods=[
            MethodInfo(
                name="ExecuteTool",
                bus_topic=ToolingMethods.EXECUTE_TOOL,
                exposure="external",
                required_perms=[ToolingMethods.EXECUTE_TOOL],
            )
        ],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"status": "ok"})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(ToolingMethods.EXECUTE_TOOL),
        mesh_config=MeshConfig(enabled=True, services={"Tooling": mesh_policy(share=True)}),
        peer_id="session-a",
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[
                _projected_service(
                    "Tooling",
                    ToolingMethods.GET_TOOLS,
                    ToolingMethods.GET_EXPORT_CATALOG,
                    ToolingMethods.PREPARE_EXECUTION,
                    ToolingMethods.EXECUTE_TOOL,
                )
            ]
        ),
        tooling_authority_revision_provider=lambda: (7, 9),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "g007-tooling",
                "method": ToolingMethods.EXECUTE_TOOL,
                "params": {
                    "tool_name": "demo",
                    "peer_id": "forged",
                    "provider_id": "forged",
                    "caller_peer_id": "forged",
                },
            }
        )
    )

    params = mock_bus.request.await_args.args[1]
    assert params["caller_peer_id"] == "peer-a"
    assert params["caller_principal_id"] == "peer-user"
    assert "peer_id" not in params
    assert "provider_id" not in params


@pytest.mark.parametrize(
    ("topic", "input_model", "params", "expected_field"),
    [
        pytest.param(
            ToolingMethods.SET_SHARING_POLICY,
            ToolingSetSharingPolicyRequest,
            {
                "policy": ToolingSharingPolicy().model_dump(),
                "actor_principal_id": "forged",
            },
            "actor_principal_id",
            id="set-sharing-policy",
        ),
        pytest.param(
            ToolingMethods.SET_POLICY_MODE,
            ToolingSetPolicyModeRequest,
            {
                "policy_mode": "enforce",
                "actor_principal_id": "forged",
                "reason": "test",
            },
            "actor_principal_id",
            id="set-policy-mode",
        ),
        pytest.param(
            ToolingMethods.CONFIRM_EXECUTION,
            ToolingConfirmExecutionRequest,
            {"approval_request_id": "approval-1", "approver_principal_id": "forged"},
            "approver_principal_id",
            id="confirm-execution",
        ),
        pytest.param(
            ToolingMethods.CREATE_APPROVAL_GRANT,
            ToolingCreateApprovalGrantRequest,
            {"grant_scope": "always", "created_by": "forged"},
            "created_by",
            id="create-approval-grant",
        ),
        pytest.param(
            ToolingMethods.REVOKE_APPROVAL_GRANT,
            ToolingRevokeApprovalGrantRequest,
            {"grant_id": "grant-1", "revoked_by": "forged"},
            "revoked_by",
            id="revoke-approval-grant",
        ),
        pytest.param(
            ToolingMethods.UPSERT_SOURCE_POLICY,
            ToolingUpsertSourcePolicyRequest,
            {
                "source_id": "source-1",
                "trust_tier": "trusted",
                "actor_principal_id": "forged",
                "reason": "test",
            },
            "actor_principal_id",
            id="upsert-source-policy",
        ),
        pytest.param(
            ToolingMethods.UPSERT_TOOL_POLICY_OVERRIDE,
            ToolingUpsertToolPolicyOverrideRequest,
            {
                "global_tool_id": "tool-1",
                "trust_tier": "trusted",
                "actor_principal_id": "forged",
                "reason": "test",
            },
            "actor_principal_id",
            id="upsert-tool-policy-override",
        ),
    ],
)
@pytest.mark.asyncio
async def test_g007_tooling_actor_identity_fields_are_bound_before_model_construction(
    mock_bus,
    mock_registry,
    mock_send_fn,
    topic,
    input_model,
    params,
    expected_field,
):
    method_name = topic.split(".", 1)[1]
    method_info = MagicMock(spec=MethodInfo)
    method_info.name = method_name
    method_info.bus_topic = topic
    method_info.exposure = "external"
    method_info.input_model = input_model
    method_info.required_perms = [topic]
    method_info.method_type = "manage"
    _registry_with_method(mock_registry, "Tooling", method_info)
    mock_bus.request.return_value = QueryResult(ok=True, data={"ok": True})
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms(topic),
        **_g007_mesh_projection_kwargs("Tooling", topic, peer_id="peer-a"),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": f"g007-{method_name}",
                "method": topic,
                "params": {
                    **params,
                    "caller_principal_id": "forged-caller",
                    "principal_id": "forged-principal",
                },
            }
        )
    )

    typed_request = mock_bus.request.await_args.args[1]
    assert isinstance(typed_request, input_model)
    assert getattr(typed_request, expected_field) == "peer-user"
    assert typed_request.correlation_id == f"g007-{method_name}"
