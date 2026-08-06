"""Unit tests for Gateway capability catalog and route explain contracts."""

import pytest

from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.capability_catalog import build_capability_catalog, explain_route
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.policy_store import MeshPolicySnapshot
from app.services.gateway.mesh.routing_table import RoutingTable
from app.services.gateway.service import GatewayService
from app.shared.contracts.mesh_surface import (
    feature_contracts_for_module,
    feature_contracts_for_topic,
)
from app.shared.contracts.models.gateway import (
    CapabilityCatalogRequest,
    GatewayMethods,
    MethodInfo,
    RouteExplainRequest,
    RouteExplainSpeechConstraints,
    ServiceAnnouncement,
)
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.speech import SpeechLanguageRequirement, SpeechMethodConstraints
from app.shared.contracts.models.stt import (
    AudioSessionMethods,
    TranscriptionMethods,
    WakeWordMethods,
)
from app.shared.contracts.models.tts import TTSMethods
from app.shared.contracts.registry import clear_registry, list_modules
from tests.unit.gateway.mesh_policy_helpers import mesh_policy
from tests.unit.gateway.verified_manifest_helpers import verified_peer_manifest


def _method(
    module: str,
    name: str = "Execute",
    method_type: str = "use",
    input_schema: dict | None = None,
) -> MethodInfo:
    return MethodInfo(
        name=name,
        summary=f"{module} {name}",
        bus_topic=f"{module}.{name}",
        exposure="external",
        method_type=method_type,
        required_perms=[f"{module}.{name}"],
        input_model=f"{name}Request",
        output_model=f"{name}Response",
        input_schema=input_schema,
        output_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
    )


def _remote_service(module: str, version: str, max_concurrent: int = 4) -> PeerServiceInfo:
    return PeerServiceInfo(
        module=module,
        version=version,
        capabilities=["tools", "basic"],
        available_feature_ids=["basic_feature"],
        methods=[_method(module)],
        max_concurrent=max_concurrent,
        digest=f"digest-{module}-{version}",
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


@pytest.mark.asyncio
async def test_catalog_exposes_multiple_providers_bindability_and_redacted_schemas():
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
        ),
    )
    await registry.update_latency("peer-a", 10.0)

    await registry.register_peer("peer-b", "beta")
    await registry.update_manifest(
        "peer-b",
        verified_peer_manifest(
            "peer-b",
            [_remote_service("Tooling", "2.0.0", max_concurrent=1)],
            node_name="beta",
        ),
    )
    await registry.increment_active_calls("peer-b")

    await registry.register_peer("peer-c", "gamma")
    await registry.update_manifest(
        "peer-c",
        verified_peer_manifest(
            "peer-c",
            [_remote_service("Tooling", "3.0.0")],
            node_name="gamma",
        ),
    )

    local_services = {
        "Tooling": ServiceAnnouncement(
            module="Tooling",
            version="9.0.0",
            methods=[
                _method(
                    "Tooling",
                    input_schema={
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "api_token": {"type": "string", "default": "secret-token"},
                            "file_path": {"type": "string", "default": "/home/user/private"},
                        },
                    },
                )
            ],
        )
    }

    catalog = build_capability_catalog(
        request=CapabilityCatalogRequest(modules=["Tooling"]),
        mesh_config=mesh_config,
        local_services=local_services,
        registry=registry,
        local_peer_id="local-peer",
    )

    assert catalog.secrets_redacted is True
    assert {provider.peer_id: provider.node_name for provider in catalog.providers} == {
        "local-peer": "local-node",
        "peer-a": "alpha",
        "peer-b": "beta",
        "peer-c": "gamma",
    }
    assert catalog.provider_index["Tooling"] == [
        "local:local-peer:Tooling",
        "remote:peer-a:Tooling",
        "remote:peer-b:Tooling",
        "remote:peer-c:Tooling",
    ]

    peer_a_action = next(action for action in catalog.actions if action.peer_id == "peer-a")
    assert peer_a_action.selector.peer_id == "peer-a"
    assert peer_a_action.selector.provider_id == "remote:peer-a:Tooling"
    assert peer_a_action.selector.service_instance_id == peer_a_action.service_instance_id
    assert peer_a_action.service_instance_id == "remote:peer-a:Tooling"
    assert peer_a_action.bindability == "approval-required"
    assert peer_a_action.policy.safety_class == "delegated_action"
    assert peer_a_action.policy.required_permissions == ["Tooling.Execute"]
    assert peer_a_action.policy.allowed_provider_peer_ids == ["peer-a", "peer-b"]
    assert "allowed_peers" not in peer_a_action.policy.model_dump()
    assert peer_a_action.freshness.registry_digest == "digest-Tooling-1.0.0"

    peer_c_provider = next(
        provider for provider in catalog.providers if provider.peer_id == "peer-c"
    )
    assert peer_c_provider.eligible is False
    assert peer_c_provider.reason_code == "provider_not_allowed"

    local_action = next(action for action in catalog.actions if action.peer_id == "local-peer")
    assert local_action.service_instance_id == "local:local-peer:Tooling"
    assert local_action.selector.provider_id == "local:local-peer:Tooling"
    assert local_action.selector.service_instance_id == local_action.service_instance_id
    assert local_action.input_schema["properties"]["query"]["type"] == "string"
    assert local_action.input_schema["properties"]["api_token"]["description"] == "redacted"
    assert local_action.input_schema["properties"]["file_path"]["description"] == "redacted"
    dumped = catalog.model_dump_json()
    assert "secret-token" not in dumped
    assert "/home/user/private" not in dumped


@pytest.mark.asyncio
async def test_catalog_preserves_callable_feature_objects_local_and_remote():
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
                    callable_features=list(feature_contracts_for_module("TTS")),
                    methods=[_canonical_method(TTSMethods.SYNTHESIZE)],
                )
            ],
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

    catalog = build_capability_catalog(
        request=CapabilityCatalogRequest(modules=["TTS"]),
        mesh_config=mesh_config,
        local_services=local_services,
        registry=registry,
        local_peer_id="local-peer",
    )

    local_action = next(action for action in catalog.actions if action.peer_id == "local-peer")
    remote_action = next(action for action in catalog.actions if action.peer_id == "peer-a")
    assert local_action.callable_feature_ids == ["speech_synthesis"]
    assert local_action.callable_features == list(
        feature_contracts_for_topic(TTSMethods.SYNTHESIZE)
    )
    assert remote_action.callable_features == list(
        feature_contracts_for_topic(TTSMethods.SYNTHESIZE)
    )


@pytest.mark.asyncio
async def test_route_explain_reports_selected_remote_stale_denied_and_local_candidates():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        peer_selection="lowest_latency",
        services={
            "Tooling": mesh_policy(
                share=True,
                prefer="network",
                fallback="local",
                allowed_provider_peer_ids=["peer-a", "peer-stale"],
                required_capabilities=["tools"],
            ),
        },
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)

    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        verified_peer_manifest("peer-a", [_remote_service("Tooling", "1.0.0")]),
    )
    await registry.update_latency("peer-a", 15.0)

    await registry.register_peer("peer-denied", "denied")
    await registry.update_manifest(
        "peer-denied",
        verified_peer_manifest("peer-denied", [_remote_service("Tooling", "1.0.0")]),
    )

    await registry.register_peer("peer-stale", "stale")
    await registry.update_manifest(
        "peer-stale",
        verified_peer_manifest("peer-stale", [_remote_service("Tooling", "1.0.0")]),
    )
    registry.get_peer("peer-stale").status = "stale"

    response = explain_route(
        request=RouteExplainRequest(topic="Tooling.Execute"),
        mesh_config=mesh_config,
        local_services={
            "Tooling": ServiceAnnouncement(
                module="Tooling", version="local", methods=[_method("Tooling")]
            )
        },
        registry=registry,
        routing_table=routing_table,
        local_peer_id="local-peer",
    )

    assert response.selected_target == "remote"
    assert response.selected_peer_id == "peer-a"
    assert response.selected_provider_id == "remote:peer-a:Tooling"
    assert response.fallback_behavior == "remote_selected; fallback=local"

    by_peer = {candidate.peer_id: candidate for candidate in response.candidates}
    assert by_peer["local-peer"].included is True
    assert by_peer["local-peer"].transport == "local_bus"
    assert by_peer["local-peer"].privacy_class == "personal"
    assert by_peer["local-peer"].auth_rbac_state == "permission_required"
    assert by_peer["peer-a"].selected is True
    assert by_peer["peer-a"].transport == "mesh_webrtc"
    assert by_peer["peer-a"].policy.required_permissions == ["Tooling.Execute"]
    assert by_peer["peer-a"].policy.approval_required is True
    assert by_peer["peer-a"].freshness.source == "remote_manifest"
    assert by_peer["peer-a"].privacy_class == "personal"
    assert by_peer["peer-a"].auth_rbac_state == "permission_required"
    assert by_peer["peer-denied"].reason_code == "provider_not_allowed"
    assert by_peer["peer-denied"].blockers[0].security_privacy is True
    assert by_peer["peer-denied"].policy.denial_reasons == ["provider_not_allowed"]
    assert by_peer["peer-denied"].auth_rbac_state == "blocked"
    assert by_peer["peer-stale"].reason_code == "manifest_projection_stale"
    assert by_peer["peer-stale"].freshness.stale is True


@pytest.mark.asyncio
async def test_route_explain_reports_absent_service_candidate():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={"TTS": mesh_policy(share=True, prefer="network", fallback="error")},
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)
    await registry.register_peer("peer-db", "database")
    await registry.update_manifest(
        "peer-db",
        verified_peer_manifest("peer-db", [_remote_service("DB", "1.0.0")]),
    )

    response = explain_route(
        request=RouteExplainRequest(topic=TTSMethods.SYNTHESIZE),
        mesh_config=mesh_config,
        registry=registry,
        routing_table=routing_table,
        local_peer_id="local-peer",
    )

    by_peer = {candidate.peer_id: candidate for candidate in response.candidates}
    assert response.selected_target == "error"
    assert by_peer["peer-db"].module == "TTS"
    assert by_peer["peer-db"].service_instance_id == "remote:peer-db:TTS"
    assert by_peer["peer-db"].included is False
    assert by_peer["peer-db"].reason_code == "service_not_advertised"
    assert by_peer["peer-db"].max_concurrent == 0


@pytest.mark.asyncio
async def test_route_explain_threads_one_policy_snapshot_to_routing_and_candidates(monkeypatch):
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={"Tooling": mesh_policy(share=True, prefer="network")},
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)
    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        verified_peer_manifest("peer-a", [_remote_service("Tooling", "1.0.0")]),
    )
    snapshot = MeshPolicySnapshot(revision=99, source_revision="test", mesh_config=mesh_config)
    observed: list[tuple[str, int]] = []

    original_resolve = routing_table.resolve
    original_candidates = registry.get_provider_candidates

    def resolve_spy(*args, **kwargs):
        observed.append(("resolve", kwargs["policy_snapshot"].revision))
        return original_resolve(*args, **kwargs)

    def candidates_spy(*args, **kwargs):
        observed.append(("candidates", kwargs["policy_snapshot"].revision))
        return original_candidates(*args, **kwargs)

    monkeypatch.setattr(routing_table, "resolve", resolve_spy)
    monkeypatch.setattr(registry, "get_provider_candidates", candidates_spy)

    response = explain_route(
        request=RouteExplainRequest(topic="Tooling.Execute"),
        mesh_config=mesh_config,
        registry=registry,
        routing_table=routing_table,
        policy_snapshot=snapshot,
        local_peer_id="local-peer",
    )

    assert response.selected_peer_id == "peer-a"
    assert observed[0] == ("resolve", 99)
    assert observed.count(("candidates", 99)) == 2


@pytest.mark.asyncio
async def test_route_explain_threads_speech_constraints_to_route_and_candidates(monkeypatch):
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={"TTS": mesh_policy(share=True, prefer="network", fallback="error")},
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)
    method = _canonical_method(TTSMethods.SYNTHESIZE)
    method.speech_constraints = SpeechMethodConstraints(
        exact_languages=["en"],
        resident_model_identity_digest="a" * 64,
        speech_capability_revision=1,
    )
    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        verified_peer_manifest(
            "peer-a",
            [
                PeerServiceInfo(
                    module="TTS",
                    version="1.0.0",
                    methods=[method],
                    max_concurrent=4,
                    digest="digest-tts",
                )
            ],
        ),
    )
    observed = []
    original_resolve = routing_table.resolve
    original_candidates = registry.get_provider_candidates

    def resolve_spy(*args, **kwargs):
        observed.append(("resolve", kwargs.get("speech_constraints")))
        return original_resolve(*args, **kwargs)

    def candidates_spy(*args, **kwargs):
        observed.append(("candidates", kwargs.get("speech_constraints")))
        return original_candidates(*args, **kwargs)

    monkeypatch.setattr(routing_table, "resolve", resolve_spy)
    monkeypatch.setattr(registry, "get_provider_candidates", candidates_spy)

    response = explain_route(
        request=RouteExplainRequest(
            topic=TTSMethods.SYNTHESIZE,
            speech=RouteExplainSpeechConstraints(
                language_requirement=SpeechLanguageRequirement(mode="exact", language="de")
            ),
        ),
        mesh_config=mesh_config,
        registry=registry,
        routing_table=routing_table,
        local_peer_id="local-peer",
    )

    assert response.selected_target == "error"
    assert response.candidates[0].reason_code == "language_incompatible"
    assert response.candidates[0].blockers[0].message == (
        "No compatible device can handle this voice request."
    )
    assert all(item[1] is not None for item in observed)
    assert {item[1].requirement_digest for item in observed} == {observed[0][1].requirement_digest}


@pytest.mark.asyncio
async def test_route_explain_ignores_speech_hints_for_non_speech_topics(monkeypatch):
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={"Tooling": mesh_policy(share=True, prefer="network")},
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)
    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        verified_peer_manifest("peer-a", [_remote_service("Tooling", "1.0.0")]),
    )
    observed = []
    original_resolve = routing_table.resolve
    original_candidates = registry.get_provider_candidates

    def resolve_spy(*args, **kwargs):
        observed.append(kwargs.get("speech_constraints"))
        return original_resolve(*args, **kwargs)

    def candidates_spy(*args, **kwargs):
        observed.append(kwargs.get("speech_constraints"))
        return original_candidates(*args, **kwargs)

    monkeypatch.setattr(routing_table, "resolve", resolve_spy)
    monkeypatch.setattr(registry, "get_provider_candidates", candidates_spy)

    response = explain_route(
        request=RouteExplainRequest(
            topic="Tooling.Execute",
            speech=RouteExplainSpeechConstraints(
                language_requirement=SpeechLanguageRequirement(mode="exact", language="de")
            ),
        ),
        mesh_config=mesh_config,
        registry=registry,
        routing_table=routing_table,
        local_peer_id="local-peer",
    )

    assert response.selected_target == "remote"
    assert all(item is None for item in observed)


def test_route_explain_rejects_voice_hints_for_transcription():
    mesh_config = MeshConfig(enabled=True, services={"Transcription": mesh_policy(share=True)})

    with pytest.raises(ValueError, match="voice hints"):
        explain_route(
            request=RouteExplainRequest(
                topic=TranscriptionMethods.TRANSCRIBE,
                speech=RouteExplainSpeechConstraints(voice_id="standard:core:default"),
            ),
            mesh_config=mesh_config,
        )


def test_route_explain_rejects_tts_auto_language_hints():
    mesh_config = MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)})

    with pytest.raises(ValueError, match="exact speech language"):
        explain_route(
            request=RouteExplainRequest(
                topic=TTSMethods.SYNTHESIZE,
                speech=RouteExplainSpeechConstraints(
                    language_requirement=SpeechLanguageRequirement(
                        mode="auto",
                        auto_language_candidates=["en", "de"],
                    )
                ),
            ),
            mesh_config=mesh_config,
        )


def test_route_explain_speech_hints_reject_raw_payload_extras_without_echoing_values():
    with pytest.raises(ValueError) as exc_info:
        RouteExplainRequest(
            topic=TTSMethods.SYNTHESIZE,
            speech={"text": "raw secret text", "audio": "raw-audio-bytes"},
        )

    error_text = str(exc_info.value)
    assert "speech route hints must not include request payload fields" in error_text
    assert "raw secret text" not in error_text
    assert "raw-audio-bytes" not in error_text


def test_route_explain_rejects_top_level_raw_payload_fields_without_echoing_values():
    with pytest.raises(ValueError) as exc_info:
        RouteExplainRequest.model_validate(
            {
                "topic": TTSMethods.SYNTHESIZE,
                "text": "top-level raw secret text",
                "audio": "top-level-raw-audio",
                "payload": {"token": "top-level-raw-token"},
            }
        )

    error_text = str(exc_info.value)
    assert "route explanations must not include request payload fields" in error_text
    assert "top-level raw secret text" not in error_text
    assert "top-level-raw-audio" not in error_text
    assert "top-level-raw-token" not in error_text


def test_route_explain_rejects_recursive_raw_payload_fields_without_echoing_values():
    with pytest.raises(ValueError) as exc_info:
        RouteExplainRequest.model_validate(
            {
                "topic": TTSMethods.SYNTHESIZE,
                "selector": {
                    "peer_id": "peer-1",
                    "data_scope": {"payload": "nested selector raw secret"},
                },
            }
        )

    error_text = str(exc_info.value)
    assert "route explanations must not include request payload fields" in error_text
    assert "nested selector raw secret" not in error_text


def test_route_explain_rejects_unknown_selector_fields_without_echoing_values():
    with pytest.raises(ValueError) as exc_info:
        RouteExplainRequest.model_validate(
            {
                "topic": TTSMethods.SYNTHESIZE,
                "selector": {
                    "peer_id": "peer-1",
                    "unknown_selector_field": "selector secret value",
                },
            }
        )

    error_text = str(exc_info.value)
    assert "route explanation selectors must use typed selector fields" in error_text
    assert "selector secret value" not in error_text


@pytest.mark.asyncio
async def test_catalog_selectors_round_trip_through_route_explain():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        peer_selection="lowest_latency",
        services={
            "Tooling": mesh_policy(
                share=True,
                prefer="network",
                fallback="local",
                allowed_provider_peer_ids=["peer-a", "peer-stale"],
                required_capabilities=["tools"],
            ),
        },
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)

    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        verified_peer_manifest("peer-a", [_remote_service("Tooling", "1.0.0")]),
    )
    await registry.update_latency("peer-a", 5.0)

    await registry.register_peer("peer-denied", "denied")
    await registry.update_manifest(
        "peer-denied",
        verified_peer_manifest("peer-denied", [_remote_service("Tooling", "1.0.0")]),
    )

    await registry.register_peer("peer-stale", "stale")
    await registry.update_manifest(
        "peer-stale",
        verified_peer_manifest("peer-stale", [_remote_service("Tooling", "1.0.0")]),
    )
    registry.get_peer("peer-stale").status = "stale"

    local_services = {
        "Tooling": ServiceAnnouncement(
            module="Tooling",
            version="local",
            methods=[_method("Tooling")],
        )
    }
    catalog = build_capability_catalog(
        request=CapabilityCatalogRequest(modules=["Tooling"]),
        mesh_config=mesh_config,
        local_services=local_services,
        registry=registry,
        local_peer_id="local-peer",
    )
    actions_by_peer = {action.peer_id: action for action in catalog.actions}
    for action in actions_by_peer.values():
        assert action.selector.service_instance_id == action.service_instance_id

    local_response = explain_route(
        request=RouteExplainRequest(
            topic="Tooling.Execute",
            selector=actions_by_peer["local-peer"].selector,
        ),
        mesh_config=mesh_config,
        local_services=local_services,
        registry=registry,
        routing_table=routing_table,
        local_peer_id="local-peer",
    )
    assert local_response.selected_target == "local"
    assert local_response.selector_valid is True
    assert local_response.selected_service_instance_id == "local:local-peer:Tooling"
    assert local_response.selected_provider_id == "local:local-peer:Tooling"
    local_route = routing_table.resolve(
        "Tooling.Execute",
        routing_config=mesh_config.services["Tooling"],
        selector=actions_by_peer["local-peer"].selector,
    )
    assert local_route.target == "local"

    remote_response = explain_route(
        request=RouteExplainRequest(
            topic="Tooling.Execute",
            selector=actions_by_peer["peer-a"].selector,
        ),
        mesh_config=mesh_config,
        local_services=local_services,
        registry=registry,
        routing_table=routing_table,
        local_peer_id="local-peer",
    )
    assert remote_response.selected_target == "remote"
    assert remote_response.selected_peer_id == "peer-a"
    assert remote_response.selector_valid is True
    assert remote_response.selected_service_instance_id == "remote:peer-a:Tooling"
    assert remote_response.selected_provider_id == "remote:peer-a:Tooling"
    remote_route = routing_table.resolve(
        "Tooling.Execute",
        routing_config=mesh_config.services["Tooling"],
        selector=actions_by_peer["peer-a"].selector,
    )
    assert remote_route.target == "remote"
    assert remote_route.peer_id == "peer-a"

    denied_response = explain_route(
        request=RouteExplainRequest(
            topic="Tooling.Execute",
            selector=actions_by_peer["peer-denied"].selector,
        ),
        mesh_config=mesh_config,
        local_services=local_services,
        registry=registry,
        routing_table=routing_table,
        local_peer_id="local-peer",
    )
    assert denied_response.selected_target == "error"
    assert denied_response.selector_valid is False
    assert denied_response.selector_validation_code == "selector_peer_unauthorized"
    assert any(blocker.code == "provider_not_allowed" for blocker in denied_response.blockers)
    denied_route = routing_table.resolve(
        "Tooling.Execute",
        routing_config=mesh_config.services["Tooling"],
        selector=actions_by_peer["peer-denied"].selector,
    )
    assert denied_route.target == "error"
    assert denied_route.error_code == "selector_peer_unauthorized"

    stale_response = explain_route(
        request=RouteExplainRequest(
            topic="Tooling.Execute",
            selector=actions_by_peer["peer-stale"].selector,
        ),
        mesh_config=mesh_config,
        local_services=local_services,
        registry=registry,
        routing_table=routing_table,
        local_peer_id="local-peer",
    )
    assert stale_response.selected_target == "error"
    assert stale_response.selector_valid is False
    assert stale_response.selector_validation_code == "selector_peer_stale"
    assert any(blocker.code == "manifest_projection_stale" for blocker in stale_response.blockers)
    stale_route = routing_table.resolve(
        "Tooling.Execute",
        routing_config=mesh_config.services["Tooling"],
        selector=actions_by_peer["peer-stale"].selector,
    )
    assert stale_route.target == "error"
    assert stale_route.error_code == "selector_peer_stale"


def test_route_explain_coerces_http_selector_objects_to_mesh_selectors():
    request = RouteExplainRequest(
        topic="Scheduler.ScheduleJob",
        selector={"peer_id": "studio-peer", "resource_namespace": "household"},
    )

    assert isinstance(request.selector, MeshAddressSelector)
    assert request.selector.peer_id == "studio-peer"
    assert request.selector.resource_namespace == "household"
    assert request.selector.has_routing_target() is True


def test_catalog_exposes_audio_streaming_as_consent_required_and_batch_detect_invokable():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={"WakeWord": mesh_policy(share=True, prefer="network")},
    )
    local_services = {
        "WakeWord": ServiceAnnouncement(
            module="WakeWord",
            version="1.0.0",
            methods=[
                _method_from_topic(WakeWordMethods.PROCESS_AUDIO),
                _method_from_topic(WakeWordMethods.DETECT),
            ],
        )
    }

    catalog = build_capability_catalog(
        request=CapabilityCatalogRequest(modules=["WakeWord"]),
        mesh_config=mesh_config,
        local_services=local_services,
        local_peer_id="local-peer",
    )

    actions = {action.topic: action for action in catalog.actions}
    streaming = actions[WakeWordMethods.PROCESS_AUDIO]
    assert streaming.policy.consent_required is True
    assert streaming.policy.privacy_indicator_required is True
    assert streaming.policy.operation_class == "wakeword_streaming"
    assert streaming.bindability == "approval-required"

    batch_detect = actions[WakeWordMethods.DETECT]
    assert batch_detect.policy.consent_required is False
    assert batch_detect.policy.operation_class == "wakeword_detection"
    assert batch_detect.bindability == "model-bindable"


def test_route_explain_reports_audio_privacy_candidate_policy():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={"WakeWord": mesh_policy(share=True, prefer="local")},
    )
    local_services = {
        "WakeWord": ServiceAnnouncement(
            module="WakeWord",
            version="1.0.0",
            methods=[_method_from_topic(WakeWordMethods.PROCESS_AUDIO)],
        )
    }

    response = explain_route(
        request=RouteExplainRequest(topic=WakeWordMethods.PROCESS_AUDIO),
        mesh_config=mesh_config,
        local_services=local_services,
        local_peer_id="local-peer",
    )

    candidate = response.candidates[0]
    assert candidate.selected is True
    assert candidate.transport == "local_bus"
    assert candidate.policy.consent_required is True
    assert candidate.policy.privacy_indicator_required is True
    assert candidate.policy.operation_class == "wakeword_streaming"
    assert candidate.privacy_class == "raw-audio"
    assert candidate.auth_rbac_state == "permission_required"


@pytest.mark.asyncio
async def test_route_explain_reports_selector_validation_failure():
    mesh_config = MeshConfig(
        enabled=True,
        services={"Tooling": mesh_policy(share=True, prefer="network")},
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)

    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        verified_peer_manifest("peer-a", [_remote_service("Tooling", "1.0.0")]),
    )

    response = explain_route(
        request=RouteExplainRequest(
            topic="Tooling.Execute",
            selector=MeshAddressSelector(peer_id="missing-peer"),
        ),
        mesh_config=mesh_config,
        registry=registry,
        routing_table=routing_table,
    )

    assert response.selected_target == "error"
    assert response.selector_valid is False
    assert response.selector_validation_code == "selector_peer_not_found"
    assert response.selector_validation_message == "The selected device is unavailable."
    assert response.security_privacy_blockers[0].code == "selector_peer_not_found"


def test_gateway_service_registers_capability_catalog_and_explain_contracts():
    clear_registry()
    GatewayService()
    gateway = list_modules()["Gateway"]
    audio_session = list_modules()["AudioSession"]
    methods = {method.bus_topic: method for method in gateway.methods}
    audio_methods = {method.bus_topic: method for method in audio_session.methods}

    assert GatewayMethods.GET_CAPABILITY_CATALOG in methods
    assert GatewayMethods.EXPLAIN_ROUTE in methods
    assert AudioSessionMethods.PREPARE in audio_methods
    assert AudioSessionMethods.LIST_EVENTS in audio_methods
    assert methods[GatewayMethods.GET_CAPABILITY_CATALOG].exposure == "external"
    assert methods[GatewayMethods.GET_CAPABILITY_CATALOG].method_type == "use"
    assert audio_methods[AudioSessionMethods.PREPARE].required_perms == ["AudioSession.manage"]
    assert methods[GatewayMethods.EXPLAIN_ROUTE].required_perms == ["Gateway.use"]
    clear_registry()


@pytest.mark.asyncio
async def test_gateway_openapi_exposes_capability_catalog_and_explain_routes():
    fastapi = pytest.importorskip("fastapi")

    from app.services.gateway.route_generator import RouteGenerator

    clear_registry()
    GatewayService()
    gateway = list_modules()["Gateway"]

    class _GatewayRegistry:
        def on_registry_change(self, _callback):
            return None

        async def get_external_methods(self):
            methods = []
            for method in gateway.methods:
                if method.exposure not in {"external", "both"}:
                    continue
                input_schema = (
                    method.input_model.model_json_schema() if method.input_model else None
                )
                output_schema = (
                    method.output_model.model_json_schema() if method.output_model else None
                )
                methods.append(
                    (
                        "Gateway",
                        MethodInfo(
                            name=method.name,
                            summary=method.summary,
                            bus_topic=method.bus_topic,
                            exposure=method.exposure,
                            input_model=method.input_model.__name__ if method.input_model else None,
                            output_model=method.output_model.__name__
                            if method.output_model
                            else None,
                            required_perms=method.required_perms,
                            method_type=method.method_type,
                            input_schema=input_schema,
                            output_schema=output_schema,
                        ),
                    )
                )
            return methods

    app = fastapi.FastAPI()
    router = fastapi.APIRouter()
    generator = RouteGenerator(bus=object(), registry=_GatewayRegistry())
    generator.set_router(router)
    await generator.start()
    app.include_router(router)

    openapi_paths = app.openapi()["paths"]
    assert "/api/Gateway/GetCapabilityCatalog" in openapi_paths
    assert "/api/Gateway/ExplainRoute" in openapi_paths
    clear_registry()
