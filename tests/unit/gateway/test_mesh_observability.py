"""Unit tests for mesh event stream and support-bundle observability."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.messaging.bus import Envelope, QueryResult
from app.services.auth.auth_manager import _audit_event_matches_trace
from app.services.gateway.service import GatewayService, _event_from_envelope
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.aurora import AuroraMethods
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.gateway import (
    CapabilityCatalogResponse,
    CapabilityProviderInfo,
    GatewayListEventsRequest,
    GatewayMethods,
    GatewaySupportBundleRequest,
    GetMeshStatusResponse,
    MethodInfo,
    MeshLocalStatus,
    MeshRouteDiagnostic,
    ServiceInfo,
)
from app.shared.contracts.models.stt import AudioSessionEvent
from app.shared.contracts.models.tooling import ToolingExecuteToolResponse
from app.shared.contracts.registry import clear_registry, list_modules


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
    assert methods[GatewayMethods.LIST_EVENTS].exposure == "external"
    assert methods[GatewayMethods.LIST_EVENTS].required_perms == ["Gateway.manage"]
    assert methods[GatewayMethods.GET_SUPPORT_BUNDLE].method_type == "manage"
    assert methods[GatewayMethods.GET_REGISTRY].required_perms == ["Gateway.manage"]
    clear_registry()


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
            payload={"device_name": "phone", "code": "123456"},
        )
    )

    assert config_event.category == "config"
    assert pairing_event.category == "pairing"


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
