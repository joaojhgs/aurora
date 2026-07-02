"""Unit tests for mesh event stream and support-bundle observability."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.messaging.bus import Envelope, QueryResult
from app.messaging.local_bus import LocalBus
from app.services.auth.auth_manager import _audit_event_matches_trace
from app.services.gateway.service import (
    GatewayService,
    _diagnostic_redacted_copy,
    _event_from_envelope,
)
from app.shared.contracts.models.aurora import AuroraMethods
from app.shared.contracts.models.auth import AuthMethods, PairingLifecycleEvent
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.gateway import (
    CapabilityCatalogResponse,
    CapabilityProviderInfo,
    GatewayListEventsRequest,
    GatewayMethods,
    GatewaySupportBundleRequest,
    GetMeshStatusResponse,
    MeshLocalStatus,
    MeshRouteDiagnostic,
    MethodInfo,
    ServiceInfo,
    WebRTCDiagnosticsResponse,
)
from app.shared.contracts.models.stt import AudioSessionEvent
from app.shared.contracts.models.tooling import ToolingExecuteToolResponse
from app.shared.contracts.registry import clear_registry, list_modules
from app.shared.messaging.bus_init import set_bus


def test_gateway_observability_contracts_are_registered():
    clear_registry()
    GatewayService()
    gateway = list_modules()["Gateway"]
    methods = {method.bus_topic: method for method in gateway.methods}

    assert GatewayMethods.LIST_EVENTS in methods
    assert GatewayMethods.GET_SUPPORT_BUNDLE in methods
    assert GatewayMethods.GET_REGISTRY in methods
    assert GatewayMethods.GET_SERVICES in methods
    assert GatewayMethods.GET_SERVICE_HEALTH in methods
    assert GatewayMethods.GET_DEPLOYMENT_TOPOLOGY in methods
    assert GatewayMethods.GET_WEBRTC_DIAGNOSTICS in methods
    assert methods[GatewayMethods.LIST_EVENTS].exposure == "external"
    assert methods[GatewayMethods.LIST_EVENTS].required_perms == ["Gateway.manage"]
    assert methods[GatewayMethods.GET_SUPPORT_BUNDLE].method_type == "manage"
    assert methods[GatewayMethods.GET_REGISTRY].required_perms == ["Gateway.manage"]
    assert methods[GatewayMethods.GET_DEPLOYMENT_TOPOLOGY].required_perms == ["Gateway.manage"]
    assert methods[GatewayMethods.GET_WEBRTC_DIAGNOSTICS].method_type == "manage"
    assert methods[GatewayMethods.GET_WEBRTC_DIAGNOSTICS].required_perms == ["Gateway.manage"]
    clear_registry()


@pytest.mark.asyncio
async def test_deployment_topology_reports_thread_mode_without_redis():
    bus = LocalBus(validate_topics=False)
    set_bus(bus)
    service = GatewayService()
    service._mode = "threads"
    service._get_services_snapshot = AsyncMock(
        return_value=[
            ServiceInfo(
                module="Gateway",
                version="0.1.0",
                method_count=4,
                last_seen="2026-06-20T00:00:00Z",
                status="healthy",
            )
        ]
    )
    service.get_mesh_status = AsyncMock(return_value=GetMeshStatusResponse())

    response = await service.get_deployment_topology(EmptyInput())

    assert response.architecture_mode == "threads"
    assert response.runtime_mode == "thread-local"
    assert response.bus_backend == "LocalBus"
    assert response.redis_url_redacted is None
    assert response.redis_reachable is None
    assert response.bullmq_queue_health.status == "healthy"
    assert response.service_process_topology[0].topology == "thread"
    assert "thread_mode_no_process_controls" in response.mode_capability_degradations
    assert response.secrets_redacted is True


class _FakeRedis:
    def __init__(self, *, reachable: bool = True):
        self.reachable = reachable

    async def ping(self):
        if not self.reachable:
            raise ConnectionError("redis unavailable")
        return True


class BullMQBus:
    redis_url = "redis://:secret-pass@redis.internal:6379/0"
    _available = True

    def __init__(self, *, reachable: bool = True):
        self._fake_redis = _FakeRedis(reachable=reachable)

    def get_stats(self):
        return {"published": 10, "delivered": 8, "retries": 1, "dead_letters": 0}

    async def _get_redis(self):
        return self._fake_redis


@pytest.mark.asyncio
async def test_deployment_topology_reports_process_mode_and_redacts_redis_url():
    bus = BullMQBus()
    set_bus(bus)
    service = GatewayService()
    service._mode = "processes"
    service._get_services_snapshot = AsyncMock(
        return_value=[
            ServiceInfo(
                module="Gateway",
                version="0.1.0",
                method_count=4,
                last_seen="2026-06-20T00:00:00Z",
                status="healthy",
            ),
            ServiceInfo(
                module="Auth",
                version="0.1.0",
                method_count=4,
                last_seen="2026-06-20T00:00:00Z",
                status="degraded",
                instance_id="auth-a",
            ),
        ]
    )
    service.get_mesh_status = AsyncMock(return_value=GetMeshStatusResponse())

    response = await service.get_deployment_topology(EmptyInput())
    dumped = json.dumps(response.model_dump(mode="json"))

    assert response.architecture_mode == "processes"
    assert response.runtime_mode == "process-server"
    assert response.bus_backend == "BullMQBus"
    assert response.redis_reachable is True
    assert response.redis_url_redacted == "redis://<redacted>@redis.internal:6379/0"
    assert "secret-pass" not in dumped
    assert response.bullmq_queue_health.status == "degraded"
    assert "bullmq_queue_lag_unknown" in response.mode_capability_degradations
    assert "process_registry_stale" in response.mode_capability_degradations
    assert response.container_topology_hints.gateway_service == "gateway-service"
    auth_topology = next(
        item for item in response.service_process_topology if item.module == "Auth"
    )
    assert auth_topology.container_hint == "auth-service"
    assert auth_topology.stale is True


@pytest.mark.asyncio
async def test_deployment_topology_reports_redis_unreachable_without_secret_leakage():
    bus = BullMQBus(reachable=False)
    set_bus(bus)
    service = GatewayService()
    service._mode = "processes"
    service._get_services_snapshot = AsyncMock(return_value=[])
    service.get_mesh_status = AsyncMock(return_value=GetMeshStatusResponse())

    response = await service.get_deployment_topology(EmptyInput())
    dumped = json.dumps(response.model_dump(mode="json"))

    assert response.redis_reachable is False
    assert response.bullmq_queue_health.status == "unhealthy"
    assert "redis_unreachable" in response.mode_capability_degradations
    assert "secret-pass" not in dumped


def test_event_normalization_redacts_payload_and_extracts_correlation():
    envelope = Envelope(
        type="AudioSession.Events",
        payload=AudioSessionEvent(
            session_id="sess-1",
            event_type="denied",
            status="denied",
            source_peer_id="peer-a",
            target_peer_id="peer-b",
            correlation_id="corr-1",
            payload={"token": "secret-token", "file_path": "/home/user/audio.wav"},
        ),
        correlation_id="corr-1",
        timestamp=datetime.now(UTC),
    )

    event = _event_from_envelope(envelope)

    assert event.category == "audio"
    assert event.action == "denied"
    assert event.status == "denied"
    assert event.severity == "error"
    assert event.correlation_id == "corr-1"
    assert event.source_peer_id == "peer-a"
    assert event.target_peer_id == "peer-b"
    dumped = json.dumps(event.redacted_payload)
    assert "secret-token" not in dumped
    assert "/home/user/audio.wav" not in dumped
    assert event.payload_sha256


def test_diagnostic_redaction_omits_personal_content_fields():
    payload = {
        "text": "call my doctor tomorrow",
        "message": "private chat message",
        "query": "sensitive RAG lookup",
        "prompt": "personal assistant prompt",
        "result": {"output": "private tool output"},
        "safe_status": "denied",
        "details": json.dumps(
            {
                "response": "assistant transcript",
                "transcription": "wakeword captured speech",
            }
        ),
    }

    redacted = _diagnostic_redacted_copy(payload)
    dumped = json.dumps(redacted)

    assert "call my doctor" not in dumped
    assert "private chat message" not in dumped
    assert "sensitive RAG lookup" not in dumped
    assert "personal assistant prompt" not in dumped
    assert "private tool output" not in dumped
    assert "assistant transcript" not in dumped
    assert "wakeword captured speech" not in dumped
    assert redacted["safe_status"] == "denied"
    assert redacted["text"]["redacted"] is True
    assert redacted["details"]["response"]["redacted"] is True


@pytest.mark.asyncio
async def test_gateway_event_buffer_filters_by_peer_tool_and_policy():
    service = GatewayService()
    tool_event = _event_from_envelope(
        Envelope(
            type="Tooling.ExecuteTool",
            payload=ToolingExecuteToolResponse(
                ok=False,
                status="denied",
                error_code="approval_required",
                correlation_id="corr-tool",
                provider_peer_id="peer-tool",
                global_tool_id="peer-tool:danger",
                policy_decision_id="pd-1",
            ),
            correlation_id="corr-tool",
        )
    )
    service._event_stream.appendleft(tool_event)

    response = await service.list_events(
        GatewayListEventsRequest(
            categories=["tool_execution"],
            peer_id="peer-tool",
            tool_id="peer-tool:danger",
            policy_decision_id="pd-1",
        )
    )

    assert response.total == 1
    assert response.events[0].correlation_id == "corr-tool"
    assert response.subscription_topic == AuroraMethods.EVENT_STREAM
    assert response.secrets_redacted is True


@pytest.mark.asyncio
async def test_gateway_capture_republishes_normalized_aurora_event_stream():
    service = GatewayService()
    service.bus.publish = AsyncMock()

    await service._capture_gateway_event(
        Envelope(
            type="Tooling.ExecuteTool",
            payload={
                "correlation_id": "corr-capture",
                "status": "success",
                "global_tool_id": "peer-tool:lookup",
            },
            correlation_id="corr-capture",
        )
    )

    assert len(service._event_stream) == 1
    event = service._event_stream[0]
    assert event.category == "tool_execution"
    assert event.tool_id == "peer-tool:lookup"
    service.bus.publish.assert_awaited_once()
    topic, published_event = service.bus.publish.await_args.args
    assert topic == AuroraMethods.EVENT_STREAM
    assert published_event.correlation_id == "corr-capture"
    assert service.bus.publish.await_args.kwargs["mesh"] is False


@pytest.mark.asyncio
async def test_gateway_list_events_filters_topic_kind_and_last_event_id():
    service = GatewayService()
    old_event = _event_from_envelope(
        Envelope(
            type="Orchestrator.Response",
            payload={"text": "old", "correlation_id": "corr-stream"},
            correlation_id="corr-stream",
        )
    )
    old_event.event_id = "old-event"
    new_event = _event_from_envelope(
        Envelope(
            type="Orchestrator.Response",
            payload={"text": "new", "correlation_id": "corr-stream"},
            correlation_id="corr-stream",
        )
    )
    new_event.event_id = "new-event"
    service._event_stream.appendleft(old_event)
    service._event_stream.appendleft(new_event)

    response = await service.list_events(
        GatewayListEventsRequest(
            topics=["Orchestrator.Response"],
            kinds=["assistant.completed"],
            correlation_id="corr-stream",
            last_event_id="old-event",
        )
    )

    assert response.total == 1
    assert response.events[0].event_id == "new-event"
    assert response.events[0].kind == "assistant.completed"


def test_gateway_event_categories_cover_config_and_pairing():
    config_event = _event_from_envelope(
        Envelope(
            type=ConfigMethods.UPDATED,
            payload={"key_path": "services.gateway.api.enabled"},
        )
    )
    pairing_event = _event_from_envelope(
        Envelope(
            type=AuthMethods.PAIRING_REQUESTED,
            payload={
                "device_name": "phone",
                "code_sha256": "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
            },
        )
    )

    assert config_event.category == "config"
    assert pairing_event.category == "pairing"
    assert "123456" not in json.dumps(pairing_event.redacted_payload)


def test_pairing_lifecycle_event_stream_omits_raw_pairing_code():
    raw_code = "123456"
    event = _event_from_envelope(
        Envelope(
            type=AuthMethods.PAIRING_DENIED,
            payload=PairingLifecycleEvent(
                request_id="pair-1",
                event_type="PairingDenied",
                status="denied",
                code_sha256="8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
                device_name="phone",
                actor_principal_id="admin-1",
            ),
        )
    )

    dumped = json.dumps(event.redacted_payload, sort_keys=True)
    assert event.category == "pairing"
    assert "code_sha256" in event.redacted_payload
    assert raw_code not in dumped
    assert 'code": ' not in dumped


@pytest.mark.asyncio
async def test_support_bundle_redacts_config_and_collects_correlation_ids():
    service = GatewayService()
    service.bus.request = AsyncMock(
        return_value=QueryResult(ok=True, data=SimpleNamespace(success=True))
    )
    service._registry_aggregator = SimpleNamespace(
        get_registry_export=AsyncMock(
            return_value={
                "modules": [
                    {
                        "module": "Gateway",
                        "version": "1.0.0",
                        "summary": "gateway",
                        "capabilities": ["http"],
                        "methods": [
                            MethodInfo(
                                name="GetSupportBundle",
                                bus_topic=GatewayMethods.GET_SUPPORT_BUNDLE,
                                exposure="external",
                                method_type="manage",
                                required_perms=["Gateway.manage"],
                            )
                        ],
                    }
                ],
                "digest": "digest-registry",
                "service_count": 1,
                "method_count": 1,
            }
        ),
        get_services=AsyncMock(
            return_value=[
                ServiceInfo(
                    module="Gateway",
                    version="1.0.0",
                    method_count=1,
                    last_seen="2026-06-20T00:00:00Z",
                    status="healthy",
                )
            ]
        ),
    )
    service._get_recent_audit_events = AsyncMock(
        return_value=[
            {
                "event": "tool.execution.denied",
                "details": json.dumps(
                    {
                        "correlation_id": "corr-tool",
                        "token": "raw-token",
                        "model_path": "/models/private.bin",
                    }
                ),
            }
        ],
    )
    service.get_mesh_status = AsyncMock(
        return_value=GetMeshStatusResponse(
            local=MeshLocalStatus(peer_id="local-peer"),
            routes=[MeshRouteDiagnostic(module="Tooling", decision_target="error")],
        )
    )
    service.get_webrtc_diagnostics = AsyncMock(
        return_value=WebRTCDiagnosticsResponse(
            enabled=True,
            started=True,
            local_mesh_peer_id="local-peer",
            connected_peer_count=1,
        )
    )
    service.get_capability_catalog = AsyncMock(
        return_value=CapabilityCatalogResponse(
            providers=[
                CapabilityProviderInfo(
                    provider_id="local",
                    peer_id="local-peer",
                    service_instance_id="local",
                    module="Tooling",
                )
            ],
        )
    )
    service._get_gateway_config = AsyncMock(
        return_value=SimpleNamespace(
            model_dump=lambda mode="json": {
                "api": {"token_secret": "secret", "redis_url": "redis://localhost:6379"},
                "model_path": "/models/private.bin",
                "mesh": {"node_name": "local"},
            }
        )
    )
    service._event_stream.appendleft(
        _event_from_envelope(
            Envelope(
                type="Tooling.ExecuteTool",
                payload={"correlation_id": "corr-tool", "tool_name": "danger"},
                correlation_id="corr-tool",
            )
        )
    )

    bundle = await service.get_support_bundle(
        GatewaySupportBundleRequest(correlation_id="corr-tool")
    )

    assert bundle.correlation_ids == ["corr-tool"]
    assert bundle.registry.digest == "digest-registry"
    assert bundle.services[0].module == "Gateway"
    assert bundle.service_health[0].status == "healthy"
    assert bundle.webrtc_diagnostics.started is True
    assert bundle.webrtc_diagnostics.connected_peer_count == 1
    assert bundle.native_capabilities[0].status == "unavailable"
    assert bundle.sidecar_logs[0].status == "metadata_only"
    assert bundle.audit_receipt and bundle.audit_receipt.startswith("support_bundle:")
    assert bundle.audit_error is None
    assert bundle.capability_catalog_summary.providers == 1
    assert bundle.route_diagnostics[0].module == "Tooling"
    dumped = bundle.model_dump_json()
    assert "raw-token" not in dumped
    assert "redis://localhost:6379" not in dumped
    assert "/models/private.bin" not in dumped
    assert bundle.secrets_redacted is True
    audit_request = service.bus.request.await_args.args[1]
    assert service.bus.request.await_args.args[0] == AuthMethods.STORE_AUDIT_EVENT
    assert audit_request.event == "diagnostics.support_bundle.exported"
    assert "digest-registry" in (audit_request.details or "")


@pytest.mark.asyncio
async def test_support_bundle_surfaces_audit_storage_failure_without_raw_payloads():
    service = GatewayService()
    service.bus.request = AsyncMock(return_value=QueryResult(ok=False, error="audit offline"))
    service.get_mesh_status = AsyncMock(return_value=GetMeshStatusResponse())
    service.get_webrtc_diagnostics = AsyncMock(return_value=WebRTCDiagnosticsResponse())
    service.get_capability_catalog = AsyncMock(return_value=CapabilityCatalogResponse())
    service._get_recent_audit_events = AsyncMock(return_value=[])
    service._get_gateway_config = AsyncMock(
        return_value=SimpleNamespace(model_dump=lambda mode="json": {})
    )

    bundle = await service.get_support_bundle(GatewaySupportBundleRequest(event_limit=0))

    assert bundle.audit_receipt is None
    assert bundle.audit_error == "audit offline"
    assert bundle.secrets_redacted is True


def test_audit_trace_filters_mesh_operator_fields_and_aliases():
    audit_event = {
        "details": json.dumps(
            {
                "correlation_id": "corr-1",
                "target_peer_id": "peer-b",
                "provider_id": "provider-b",
                "global_tool_id": "provider-b:danger",
                "action": "execute",
                "policy_decision_id": "pd-1",
                "route_target": "remote",
            }
        )
    }

    assert _audit_event_matches_trace(
        audit_event,
        correlation_id="corr-1",
        peer_id="peer-b",
        provider_id="provider-b",
        tool_id="provider-b:danger",
        action="execute",
        policy_decision_id="pd-1",
        route="remote",
    )
    assert not _audit_event_matches_trace(audit_event, tool_id="other")
