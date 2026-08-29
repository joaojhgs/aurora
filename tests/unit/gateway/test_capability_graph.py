"""Unit tests for mesh capability graph projection."""

from unittest.mock import AsyncMock

import pytest

from app.services.gateway.config import MeshConfig, Settings
from app.services.gateway.mesh.capability_graph import build_capability_graph
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.policy_store import MeshPolicySnapshot
from app.services.gateway.service import GatewayService
from app.shared.contracts.mesh_surface import (
    feature_contracts_for_module,
    feature_contracts_for_topic,
)
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.gateway import (
    CapabilityAddressInfo,
    CapabilityResourceInfo,
    MethodInfo,
    ServiceAnnouncement,
)
from app.shared.contracts.models.stt import TranscriptionMethods, WakeWordMethods
from app.shared.contracts.models.tts import TTSMethods
from tests.unit.gateway.mesh_policy_helpers import mesh_policy
from tests.unit.gateway.verified_manifest_helpers import verified_peer_manifest


def _method(module: str, name: str = "Execute", method_type: str = "use") -> MethodInfo:
    return MethodInfo(
        name=name,
        summary=f"{module} {name}",
        bus_topic=f"{module}.{name}",
        exposure="external",
        method_type=method_type,
        required_perms=[f"{module}.{name}"],
        input_model=f"{name}Request",
        output_model=f"{name}Response",
    )


def _method_from_topic(topic: str) -> MethodInfo:
    module, name = topic.split(".", 1)
    return _method(module, name)


def _canonical_method(topic: str) -> MethodInfo:
    module, name = topic.split(".", 1)
    return MethodInfo(
        name=name,
        summary=f"{module} {name}",
        bus_topic=topic,
        exposure="external",
        method_type="use",
        required_perms=[topic],
        callable_feature_ids=[feature.feature_id for feature in feature_contracts_for_topic(topic)],
        callable_features=list(feature_contracts_for_topic(topic)),
        input_model=f"{name}Request",
        output_model=f"{name}Response",
    )


def _remote_service(module: str, version: str, max_concurrent: int = 4) -> PeerServiceInfo:
    return PeerServiceInfo(
        module=module,
        version=version,
        capabilities=["tools", "basic"],
        methods=[_method(module)],
        max_concurrent=max_concurrent,
        digest=f"digest-{module}-{version}",
    )


@pytest.mark.asyncio
async def test_capability_graph_aggregates_multiple_providers_for_same_module():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={
            "Tooling": mesh_policy(
                share=True,
                prefer="network",
                allowed_provider_peer_ids=["peer-a", "peer-b"],
                required_capabilities=["tools"],
            ),
            "DB": mesh_policy(share=False, prefer="local"),
        },
    )
    registry = PeerRegistry(mesh_config)

    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        verified_peer_manifest(
            "peer-a",
            [_remote_service("Tooling", "1.0.0")],
            node_name="alpha",
            timestamp="2026-06-16T00:00:00Z",
        ),
    )
    await registry.update_latency("peer-a", 12.5)

    await registry.register_peer("peer-b", "beta")
    await registry.update_manifest(
        "peer-b",
        verified_peer_manifest(
            "peer-b",
            [_remote_service("Tooling", "2.0.0", max_concurrent=2)],
            node_name="beta",
            timestamp="2026-06-16T00:01:00Z",
        ),
    )
    await registry.update_latency("peer-b", 30.0)
    await registry.increment_active_calls("peer-b")

    await registry.register_peer("peer-c", "gamma")
    await registry.update_manifest(
        "peer-c",
        verified_peer_manifest(
            "peer-c",
            [_remote_service("Tooling", "2.1.0")],
            node_name="gamma",
            timestamp="2026-06-16T00:02:00Z",
        ),
    )

    local_services = {
        "Tooling": ServiceAnnouncement(
            module="Tooling",
            version="3.0.0",
            summary="local tools",
            capabilities=["tools", "local"],
            methods=[_method("Tooling"), _method("Tooling", "Reload", method_type="manage")],
        ),
        "DB": ServiceAnnouncement(
            module="DB",
            version="3.0.0",
            summary="local database",
            capabilities=["rag"],
            methods=[_method("DB", "Search")],
        ),
    }

    graph = build_capability_graph(
        mesh_config=mesh_config,
        local_services=local_services,
        registry=registry,
        local_peer_id="local-peer",
    )

    assert graph.local_peer_id == "local-peer"
    assert graph.local_node_name == "local-node"
    assert graph.secrets_redacted is True
    assert graph.provider_index["Tooling"] == [
        "local:local-peer:Tooling",
        "remote:peer-a:Tooling",
        "remote:peer-b:Tooling",
    ]
    assert graph.candidate_provider_index["Tooling"] == [
        "local:local-peer:Tooling",
        "remote:peer-a:Tooling",
        "remote:peer-b:Tooling",
        "remote:peer-c:Tooling",
    ]

    tooling_services = [svc for svc in graph.services if svc.module == "Tooling"]
    assert len(tooling_services) == 4
    assert {svc.peer_id for svc in tooling_services} == {
        "local-peer",
        "peer-a",
        "peer-b",
        "peer-c",
    }

    peer_b_service = next(svc for svc in tooling_services if svc.peer_id == "peer-b")
    assert peer_b_service.available_capacity == 1
    assert peer_b_service.latency_ms == 30.0
    assert peer_b_service.policy.allowed_provider_peer_ids == ["peer-a", "peer-b"]
    assert peer_b_service.policy.safety_class == "delegated_action"
    assert peer_b_service.routable is True

    peer_c_service = next(svc for svc in tooling_services if svc.peer_id == "peer-c")
    assert peer_c_service.routable is False
    assert peer_c_service.route_blockers == ["provider_not_allowed"]

    local_reload = next(
        method
        for svc in tooling_services
        if svc.peer_id == "local-peer"
        for method in svc.methods
        if method.name == "Reload"
    )
    assert local_reload.policy.explicit_selector_required is True
    assert local_reload.policy.safety_class == "admin"

    local_db = next(svc for svc in graph.services if svc.module == "DB")
    assert local_db.share is False
    assert local_db.routable is True
    assert local_db.policy.local_only is True
    assert local_db.policy.mesh_visible is False


def test_capability_graph_models_support_explicit_resource_selectors():
    resource = CapabilityResourceInfo(
        resource_id="db:memories:home",
        resource_type="db_namespace",
        owner_peer_id="peer-a",
        service_instance_id="remote:peer-a:DB",
        namespace="memories/home",
        capabilities=["rag_search"],
        address=CapabilityAddressInfo(
            peer_id="peer-a",
            module="DB",
            service_instance_id="remote:peer-a:DB",
            resource_id="db:memories:home",
            namespace="memories/home",
        ),
    )

    data = resource.model_dump()
    assert data["namespace"] == "memories/home"
    assert data["address"]["resource_id"] == "db:memories:home"


def test_capability_graph_classifies_audio_boundaries():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={
            "TTS": mesh_policy(share=True, prefer="network"),
            "Transcription": mesh_policy(share=True, prefer="network"),
            "WakeWord": mesh_policy(share=True, prefer="network"),
        },
    )
    local_services = {
        "TTS": ServiceAnnouncement(
            module="TTS",
            version="1.0.0",
            methods=[
                _method_from_topic(TTSMethods.REQUEST),
                _method_from_topic(TTSMethods.SYNTHESIZE),
            ],
        ),
        "Transcription": ServiceAnnouncement(
            module="Transcription",
            version="1.0.0",
            methods=[
                _method_from_topic(TranscriptionMethods.PROCESS_AUDIO),
                _method_from_topic(TranscriptionMethods.TRANSCRIBE),
            ],
        ),
        "WakeWord": ServiceAnnouncement(
            module="WakeWord",
            version="1.0.0",
            methods=[
                _method_from_topic(WakeWordMethods.PROCESS_AUDIO),
                _method_from_topic(WakeWordMethods.DETECT),
            ],
        ),
    }

    graph = build_capability_graph(
        mesh_config=mesh_config,
        local_services=local_services,
        local_peer_id="local-peer",
    )

    methods = {method.bus_topic: method for service in graph.services for method in service.methods}

    synthesize = methods[TTSMethods.SYNTHESIZE]
    assert synthesize.policy.safety_class == "standard"
    assert synthesize.policy.operation_class == "batch_synthesize"
    assert synthesize.policy.explicit_selector_required is False
    assert synthesize.policy.consent_required is False
    assert synthesize.policy.privacy_indicator_required is False

    playback = methods[TTSMethods.REQUEST]
    assert playback.policy.safety_class == "hardware"
    assert playback.policy.operation_class == "remote_playback"
    assert playback.policy.resource_scope == "output_device"
    assert playback.policy.explicit_selector_required is True
    assert playback.policy.consent_required is True
    assert playback.policy.privacy_indicator_required is True

    batch_transcribe = methods[TranscriptionMethods.TRANSCRIBE]
    assert batch_transcribe.policy.safety_class == "standard"
    assert batch_transcribe.policy.operation_class == "batch_transcription"
    assert batch_transcribe.policy.explicit_selector_required is False

    stream_transcribe = methods[TranscriptionMethods.PROCESS_AUDIO]
    assert stream_transcribe.policy.operation_class == "transcription_streaming"
    assert stream_transcribe.policy.explicit_selector_required is True
    assert stream_transcribe.policy.bandwidth_check_required is True

    wakeword = methods[WakeWordMethods.PROCESS_AUDIO]
    assert wakeword.policy.operation_class == "wakeword_streaming"
    assert wakeword.policy.explicit_selector_required is True
    assert wakeword.policy.privacy_indicator_required is True
    assert wakeword.policy.consent_required is True

    wakeword_detect = methods[WakeWordMethods.DETECT]
    assert wakeword_detect.policy.safety_class == "standard"
    assert wakeword_detect.policy.operation_class == "wakeword_detection"
    assert wakeword_detect.policy.resource_scope == "submitted_audio"
    assert wakeword_detect.policy.explicit_selector_required is False
    assert wakeword_detect.policy.consent_required is False


@pytest.mark.asyncio
async def test_capability_graph_preserves_callable_feature_objects_local_and_remote():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={"TTS": mesh_policy(share=True, prefer="network")},
    )
    registry = PeerRegistry(mesh_config)
    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        verified_peer_manifest(
            "peer-a",
            [
                PeerServiceInfo(
                    module="TTS",
                    version="1.0.0",
                    available_feature_ids=["speech_synthesis"],
                    callable_features=list(feature_contracts_for_module("TTS")),
                    methods=[_canonical_method(TTSMethods.SYNTHESIZE)],
                )
            ],
            node_name="alpha",
        ),
    )
    local_services = {
        "TTS": ServiceAnnouncement(
            module="TTS",
            version="1.0.0",
            callable_features=list(feature_contracts_for_module("TTS")),
            methods=[_canonical_method(TTSMethods.SYNTHESIZE)],
        )
    }

    graph = build_capability_graph(
        mesh_config=mesh_config,
        local_services=local_services,
        registry=registry,
        local_peer_id="local-peer",
    )

    local = next(service for service in graph.services if service.peer_id == "local-peer")
    remote = next(service for service in graph.services if service.peer_id == "peer-a")
    assert local.callable_features == list(feature_contracts_for_module("TTS"))
    assert remote.callable_features == list(feature_contracts_for_module("TTS"))
    assert local.methods[0].callable_feature_ids == ["speech_synthesis"]
    assert local.methods[0].callable_features == list(
        feature_contracts_for_topic(TTSMethods.SYNTHESIZE)
    )
    assert remote.methods[0].callable_features == list(
        feature_contracts_for_topic(TTSMethods.SYNTHESIZE)
    )


@pytest.mark.asyncio
async def test_capability_graph_treats_empty_allowed_provider_ids_as_allow_none():
    mesh_config = MeshConfig(
        enabled=True,
        services={
            "Tooling": mesh_policy(
                share=True,
                prefer="network",
                allowed_provider_peer_ids=[],
            )
        },
    )
    registry = PeerRegistry(mesh_config)
    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        verified_peer_manifest("peer-a", [_remote_service("Tooling", "1.0.0")]),
    )

    graph = build_capability_graph(
        mesh_config=mesh_config,
        registry=registry,
        local_peer_id="local-peer",
    )
    remote_tooling = next(svc for svc in graph.services if svc.module == "Tooling")

    assert graph.provider_index == {}
    assert graph.candidate_provider_index["Tooling"] == ["remote:peer-a:Tooling"]
    assert remote_tooling.routable is False
    assert remote_tooling.policy.allowed_provider_peer_ids == []
    assert remote_tooling.route_blockers == ["provider_not_allowed"]


@pytest.mark.asyncio
async def test_capability_graph_uses_registry_blocker_oracle_with_supplied_policy_snapshot(
    monkeypatch,
):
    mesh_config = MeshConfig(
        enabled=True,
        services={"Tooling": mesh_policy(share=True, prefer="network")},
    )
    registry = PeerRegistry(mesh_config)
    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        verified_peer_manifest("peer-a", [_remote_service("Tooling", "1.0.0")]),
    )
    snapshot = MeshPolicySnapshot(revision=42, source_revision="test", mesh_config=mesh_config)
    observed_revisions: list[int] = []

    def fake_route_blockers(**kwargs):
        observed_revisions.append(kwargs["policy_snapshot"].revision)
        return ["sentinel_blocker"]

    monkeypatch.setattr(registry, "get_service_route_blockers", fake_route_blockers)

    graph = build_capability_graph(
        mesh_config=mesh_config,
        registry=registry,
        policy_snapshot=snapshot,
        local_peer_id="local-peer",
    )
    remote_tooling = next(svc for svc in graph.services if svc.module == "Tooling")

    assert observed_revisions == [42]
    assert remote_tooling.route_blockers == ["sentinel_blocker"]
    assert remote_tooling.routable is False


@pytest.mark.asyncio
async def test_gateway_capability_graph_output_is_redacted():
    mesh_config = MeshConfig(enabled=True, node_name="local")
    service = GatewayService()
    service._get_gateway_config = AsyncMock(return_value=Settings(mesh=mesh_config))
    service._mesh_peer_id = "local-peer"

    response = await service.get_capability_graph(EmptyInput())
    payload = response.model_dump_json().lower()

    assert response.secrets_redacted is True
    assert "password" not in payload
    assert "token" not in payload
    assert "api_key" not in payload
