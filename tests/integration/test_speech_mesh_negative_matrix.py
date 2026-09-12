"""Cross-boundary negative tests for speech mesh routing."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging.bus import QueryResult
from app.messaging.mesh_bus import MeshBus
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.capability_catalog import explain_route
from app.services.gateway.mesh.models import PeerServiceInfo, ProviderLeaseState
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable
from app.shared.contracts.models.gateway import (
    MethodInfo,
    RouteExplainRequest,
    RouteExplainSpeechConstraints,
)
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.speech import SpeechLanguageRequirement, SpeechMethodConstraints
from app.shared.contracts.models.tts import TTSMethods, TTSSynthesizeRequest
from tests.unit.gateway.mesh_policy_helpers import mesh_policy
from tests.unit.gateway.verified_manifest_helpers import verified_peer_manifest


def _tts_service(
    speech_constraints: SpeechMethodConstraints | None,
) -> PeerServiceInfo:
    return PeerServiceInfo(
        module="TTS",
        version="1.0.0",
        available_feature_ids=["speech_synthesis"],
        methods=[
            MethodInfo(
                name="Synthesize",
                bus_topic=TTSMethods.SYNTHESIZE,
                exposure="both",
                method_type="use",
                required_perms=[TTSMethods.SYNTHESIZE],
                callable_feature_ids=["speech_synthesis"],
                speech_constraints=speech_constraints,
            )
        ],
        max_concurrent=4,
    )


def _speech_constraints(language: str, *, revision: int) -> SpeechMethodConstraints:
    return SpeechMethodConstraints(
        exact_languages=[language],
        resident_model_identity_digest=f"{revision:x}" * 64,
        speech_capability_revision=revision,
    )


async def _register_provider(
    registry: PeerRegistry,
    peer_id: str,
    constraints: SpeechMethodConstraints | None,
    *,
    latency_ms: float,
    revision: int,
) -> None:
    await registry.register_peer(peer_id, peer_id)
    await registry.update_manifest(
        peer_id,
        verified_peer_manifest(peer_id, [_tts_service(constraints)]),
    )
    assert await registry.apply_provider_lease(
        ProviderLeaseState(
            peer_id=peer_id,
            connection_epoch=f"epoch-{peer_id}",
            availability_revision=revision,
            issued_at_ms=1_000,
            expires_at_ms=9_999_999_999_999,
        ),
        now_ms=1_000,
    )
    await registry.update_latency(peer_id, latency_ms)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_incompatible_and_legacy_speech_peers_are_explained_but_never_dispatched() -> None:
    """Only the compatible peer may receive text under exact-language routing."""

    mesh_config = MeshConfig(
        enabled=True,
        node_name="speech-negative-matrix",
        services={
            "TTS": mesh_policy(
                share=True,
                prefer="network",
                fallback="error",
            )
        },
        peer_selection="lowest_latency",
    )
    registry = PeerRegistry(mesh_config)
    await _register_provider(registry, "peer-legacy", None, latency_ms=1.0, revision=1)
    await _register_provider(
        registry,
        "peer-en",
        _speech_constraints("en", revision=2),
        latency_ms=2.0,
        revision=2,
    )
    await _register_provider(
        registry,
        "peer-de",
        _speech_constraints("de", revision=3),
        latency_ms=3.0,
        revision=3,
    )
    routing_table = RoutingTable(mesh_config, registry)
    inner_bus = AsyncMock()
    inner_bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"provider": "local"}))
    inner_bus.subscribe = MagicMock()
    peer_bridge = AsyncMock()
    peer_bridge.call = AsyncMock(return_value=QueryResult(ok=True, data={"provider": "peer-de"}))
    mesh_bus = MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)

    result = await mesh_bus.request(
        TTSMethods.SYNTHESIZE,
        TTSSynthesizeRequest(text="Guten Tag", language="de"),
    )

    assert result == QueryResult(ok=True, data={"provider": "peer-de"})
    peer_bridge.call.assert_awaited_once()
    assert peer_bridge.call.await_args.args[:2] == ("peer-de", TTSMethods.SYNTHESIZE)
    inner_bus.request.assert_not_awaited()

    explanation = explain_route(
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
    candidates = {candidate.peer_id: candidate for candidate in explanation.candidates}
    assert explanation.selected_peer_id == "peer-de"
    assert candidates["peer-de"].selected is True
    assert candidates["peer-de"].reason_code == "eligible"
    assert candidates["peer-en"].reason_code == "language_incompatible"
    assert candidates["peer-legacy"].reason_code == "language_capability_unknown"

    for incompatible_peer in ("peer-en", "peer-legacy"):
        peer_bridge.call.reset_mock()
        inner_bus.request.reset_mock()
        rejected = await mesh_bus.request(
            TTSMethods.SYNTHESIZE,
            TTSSynthesizeRequest(
                text="Guten Tag",
                language="de",
                mesh_selector=MeshAddressSelector(peer_id=incompatible_peer),
            ),
        )

        assert rejected.ok is False
        peer_bridge.call.assert_not_awaited()
        inner_bus.request.assert_not_awaited()
