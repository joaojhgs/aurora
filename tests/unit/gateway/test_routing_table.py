"""Unit tests for the mesh RoutingTable."""

import pytest

from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo, PeerState, RouteDecision
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.policy_store import MeshPolicyStore
from app.services.gateway.mesh.routing_table import RoutingTable, _extract_module
from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.stt import TranscriptionMethods, WakeWordMethods
from app.shared.contracts.models.tts import TTSMethods
from tests.unit.gateway.mesh_policy_helpers import mesh_policy
from tests.unit.gateway.verified_manifest_helpers import verified_peer_manifest


class TestExtractModule:
    """Tests for _extract_module helper."""

    def test_dotted_topic(self):
        assert _extract_module("TTS.Request") == "TTS"

    def test_multi_dotted_topic(self):
        assert _extract_module("TTS.Request.Extra") == "TTS"

    def test_plain_topic(self):
        assert _extract_module("TTS") == "TTS"


@pytest.fixture
def mesh_config():
    return MeshConfig(
        enabled=True,
        node_name="test-node",
        services={
            "TTS": mesh_policy(prefer="network", fallback="local"),
            "DB": mesh_policy(prefer="local"),
            "STT": mesh_policy(prefer="network_only", fallback="error"),
            "Transcription": mesh_policy(prefer="network", fallback="local"),
            "Scheduler": mesh_policy(prefer="local_only"),
            "Tooling": mesh_policy(prefer="local", require_explicit_selector=True),
            "Orchestrator": mesh_policy(prefer="local"),
        },
    )


@pytest.fixture
def peer_registry(mesh_config):
    return PeerRegistry(mesh_config)


@pytest.fixture
def routing_table(mesh_config, peer_registry):
    return RoutingTable(mesh_config, peer_registry)


def _make_negotiated_peer(peer_id, modules, latency_ms=50.0, *, max_concurrent=10):
    """Create a negotiated PeerState with given modules."""
    topics = {
        "DB": "DB.GetMessages",
        "TTS": TTSMethods.SYNTHESIZE,
        "Transcription": TranscriptionMethods.PROCESS_AUDIO,
        "WakeWord": WakeWordMethods.PROCESS_AUDIO,
        "Orchestrator": OrchestratorMethods.INFER_CHAT,
    }
    topic_sets = {
        "TTS": [TTSMethods.SYNTHESIZE, TTSMethods.REQUEST],
    }
    services = [
        PeerServiceInfo(
            module=m,
            version="1.0.0",
            available_feature_ids=["basic_feature"],
            methods=[
                MethodInfo(
                    name=topic.split(".", 1)[1],
                    bus_topic=topic,
                    exposure="external",
                    required_perms=[topic],
                )
                for topic in topic_sets.get(m, [topics.get(m, f"{m}.Execute")])
            ],
            max_concurrent=max_concurrent,
        )
        for m in modules
    ]
    manifest = verified_peer_manifest(peer_id, services)
    return PeerState(
        peer_id=peer_id,
        manifest=manifest,
        status="negotiated",
        latency_ms=latency_ms,
    )


def _config_with_service(mesh_config: MeshConfig, module: str, policy) -> MeshConfig:
    services = dict(mesh_config.services)
    services[module] = policy
    return mesh_config.model_copy(update={"services": services})


class TestRoutingTableResolve:
    """Tests for RoutingTable.resolve()."""

    @pytest.mark.parametrize(
        ("topic", "selector"),
        [
            pytest.param("Unknown.Topic", None, id="implicit-local-disabled"),
            pytest.param(TTSMethods.SYNTHESIZE, None, id="automatic-remote-disabled"),
            pytest.param(
                "DB.GetMessages",
                MeshAddressSelector(peer_id="local", provider_id="local:DB"),
                id="explicit-local-disabled",
            ),
            pytest.param(
                "DB.GetMessages",
                MeshAddressSelector(peer_id="peer-1"),
                id="explicit-remote-disabled",
            ),
        ],
    )
    def test_disabled_mesh_config_fails_closed_for_all_resolution_shapes(
        self, peer_registry, topic, selector
    ):
        routing_table = RoutingTable(MeshConfig(enabled=False), peer_registry)

        route = routing_table.resolve(topic, selector=selector)

        assert route.target == "error"
        assert route.error_code == "mesh_disabled"

    def test_no_routing_config_returns_local(self, routing_table):
        route = routing_table.resolve("Unknown.Topic")
        assert route.target == "local"
        assert route.module == "Unknown"

    def test_prefer_local_returns_local(self, routing_table):
        route = routing_table.resolve("DB.Query")
        assert route.target == "local"
        assert route.module == "DB"

    def test_prefer_local_only_returns_local(self, routing_table):
        route = routing_table.resolve("Scheduler.Schedule")
        assert route.target == "local"
        assert route.module == "Scheduler"

    @pytest.mark.asyncio
    async def test_prefer_network_no_peer_falls_back_to_local(self, routing_table):
        """No peers registered, so network preference falls back."""
        route = routing_table.resolve(TTSMethods.SYNTHESIZE)
        assert route.target == "local"
        assert route.module == "TTS"

    @pytest.mark.asyncio
    async def test_prefer_network_with_peer(self, routing_table, peer_registry):
        peer = _make_negotiated_peer("peer-1", ["TTS"], latency_ms=20.0)
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)
        await peer_registry.update_latency("peer-1", 20.0)

        route = routing_table.resolve(TTSMethods.SYNTHESIZE)
        assert route.target == "remote"
        assert route.peer_id == "peer-1"
        assert route.module == "TTS"

    @pytest.mark.asyncio
    async def test_required_provider_feature_ids_block_automatic_route(
        self, mesh_config, peer_registry
    ):
        mesh_config = _config_with_service(
            mesh_config,
            "TTS",
            mesh_policy(
                prefer="network",
                fallback="error",
                required_provider_feature_ids=["future-feature"],
            ),
        )
        routing_table = RoutingTable(mesh_config, peer_registry)
        peer = _make_negotiated_peer("peer-1", ["TTS"], latency_ms=20.0)
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)

        route = routing_table.resolve(TTSMethods.SYNTHESIZE)

        assert mesh_config.services["TTS"].routing.required_provider_feature_ids == (
            "future-feature",
        )
        assert route.target == "error"

    @pytest.mark.asyncio
    async def test_required_provider_feature_ids_block_explicit_route(
        self, mesh_config, peer_registry
    ):
        mesh_config = _config_with_service(
            mesh_config,
            "TTS",
            mesh_policy(
                prefer="local",
                required_provider_feature_ids=["future-feature"],
            ),
        )
        routing_table = RoutingTable(mesh_config, peer_registry)
        peer = _make_negotiated_peer("peer-1", ["TTS"], latency_ms=20.0)
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)

        route = routing_table.resolve(
            TTSMethods.SYNTHESIZE,
            selector=MeshAddressSelector(peer_id="peer-1"),
        )

        assert route.target == "error"
        assert route.error_code == "selector_missing_required_features"

    @pytest.mark.asyncio
    async def test_explicit_resolution_captures_one_policy_snapshot(
        self, mesh_config, peer_registry
    ):
        store = MeshPolicyStore()
        store.replace(mesh_config, source_revision=1)
        calls = 0

        def provider():
            nonlocal calls
            calls += 1
            return store.current()

        routing_table = RoutingTable(mesh_config, peer_registry, policy_provider=provider)
        peer = _make_negotiated_peer("peer-1", ["DB"])
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)

        route = routing_table.resolve(
            "DB.GetMessages",
            selector=MeshAddressSelector(peer_id="peer-1"),
        )

        assert route.target == "remote"
        assert calls == 1

    @pytest.mark.asyncio
    async def test_prefer_network_only_no_peer(self, routing_table):
        """network_only with no peer → none (fallback=error maps to error)."""
        route = routing_table.resolve("STT.Transcribe")
        # STT routing has prefer=network_only, no peers → target=none
        # Because network_only can't fall back to local
        assert route.target in ("none", "error")

    @pytest.mark.asyncio
    async def test_exclude_peer(self, routing_table, peer_registry):
        peer = _make_negotiated_peer("peer-1", ["TTS"])
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)

        route = routing_table.resolve(TTSMethods.SYNTHESIZE, exclude=["peer-1"])
        # Peer excluded, no other peers → fallback
        assert route.target == "local"

    @pytest.mark.asyncio
    async def test_explicit_peer_overrides_local_preference(self, routing_table, peer_registry):
        peer = _make_negotiated_peer("peer-1", ["DB"], latency_ms=15.0)
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)
        await peer_registry.update_latency("peer-1", 15.0)

        route = routing_table.resolve(
            "DB.GetMessages",
            selector=MeshAddressSelector(peer_id="peer-1", resource_namespace="journal"),
        )

        assert route.target == "remote"
        assert route.peer_id == "peer-1"
        assert route.selector.resource_namespace == "journal"

    @pytest.mark.asyncio
    async def test_explicit_missing_peer_returns_actionable_error(self, routing_table):
        route = routing_table.resolve(
            "DB.GetMessages",
            selector=MeshAddressSelector(peer_id="missing-peer"),
        )

        assert route.target == "error"
        assert route.error_code == "selector_peer_not_found"
        assert "missing-peer" in route.error_message

    @pytest.mark.asyncio
    async def test_explicit_peer_not_allowed_returns_unauthorized(self, mesh_config, peer_registry):
        mesh_config = _config_with_service(
            mesh_config,
            "DB",
            mesh_policy(prefer="local", allowed_peers=["peer-2"]),
        )
        routing_table = RoutingTable(mesh_config, peer_registry)
        peer = _make_negotiated_peer("peer-1", ["DB"])
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)

        route = routing_table.resolve(
            "DB.GetMessages",
            selector=MeshAddressSelector(provider_id="peer-1"),
        )

        assert route.target == "error"
        assert route.error_code == "selector_peer_unauthorized"

    @pytest.mark.parametrize(
        ("allowed_peers", "expected_target", "expected_error"),
        [
            pytest.param(None, "remote", None, id="null-allows-any-provider"),
            pytest.param([], "error", "selector_peer_unauthorized", id="empty-denies-all"),
            pytest.param(["peer-1"], "remote", None, id="populated-allows-member"),
            pytest.param(
                ["peer-2"],
                "error",
                "selector_peer_unauthorized",
                id="populated-denies-nonmember",
            ),
        ],
    )
    @pytest.mark.asyncio
    async def test_explicit_outbound_legacy_allowed_peers_semantics_are_locked(
        self,
        mesh_config,
        peer_registry,
        allowed_peers,
        expected_target,
        expected_error,
    ):
        """Explicit outbound selectors preserve legacy null/empty/list allowlist meaning."""

        mesh_config = _config_with_service(
            mesh_config,
            "DB",
            mesh_policy(
                prefer="local",
                allowed_peers=allowed_peers,
            ),
        )
        routing_table = RoutingTable(mesh_config, peer_registry)
        peer = _make_negotiated_peer("peer-1", ["DB"])
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)

        route = routing_table.resolve(
            "DB.GetMessages",
            selector=MeshAddressSelector(peer_id="peer-1"),
        )

        assert route.target == expected_target
        assert route.error_code == expected_error
        if expected_target == "remote":
            assert route.peer_id == "peer-1"

    @pytest.mark.asyncio
    async def test_explicit_stale_peer_returns_actionable_error(self, routing_table, peer_registry):
        peer = _make_negotiated_peer("peer-1", ["DB"])
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)
        peer_registry.get_peer("peer-1").status = "stale"

        route = routing_table.resolve(
            "DB.GetMessages",
            selector=MeshAddressSelector(peer_id="peer-1"),
        )

        assert route.target == "error"
        assert route.error_code == "selector_peer_stale"
        assert "not negotiated" in route.error_message

    @pytest.mark.asyncio
    async def test_explicit_peer_version_mismatch_returns_actionable_error(
        self, mesh_config, peer_registry
    ):
        mesh_config = _config_with_service(
            mesh_config,
            "DB",
            mesh_policy(prefer="local", min_version="2.0.0"),
        )
        routing_table = RoutingTable(mesh_config, peer_registry)
        peer = _make_negotiated_peer("peer-1", ["DB"])
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)

        route = routing_table.resolve(
            "DB.GetMessages",
            selector=MeshAddressSelector(peer_id="peer-1"),
        )

        assert route.target == "error"
        assert route.error_code == "selector_incompatible_version"
        assert "2.0.0" in route.error_message

    @pytest.mark.asyncio
    async def test_explicit_peer_capacity_returns_actionable_error(
        self, routing_table, peer_registry
    ):
        peer = _make_negotiated_peer("peer-1", ["DB"], max_concurrent=1)
        peer.active_calls = 1
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)
        peer_registry.get_peer("peer-1").active_calls = 1

        route = routing_table.resolve(
            "DB.GetMessages",
            selector=MeshAddressSelector(peer_id="peer-1"),
        )

        assert route.target == "error"
        assert route.error_code == "selector_provider_at_capacity"
        assert "at capacity" in route.error_message

    def test_policy_can_require_explicit_selector(self, routing_table):
        route = routing_table.resolve("Tooling.ExecuteTool")

        assert route.target == "error"
        assert route.error_code == "selector_required"

    def test_remote_playback_requires_explicit_selector(self, routing_table):
        route = routing_table.resolve(TTSMethods.REQUEST)

        assert route.target == "error"
        assert route.error_code == "selector_required"

    def test_batch_synthesize_can_use_transparent_routing(self, routing_table):
        route = routing_table.resolve(TTSMethods.SYNTHESIZE)

        assert route.target == "local"
        assert route.module == "TTS"

    def test_streaming_transcription_requires_explicit_selector(self, routing_table):
        route = routing_table.resolve(TranscriptionMethods.PROCESS_AUDIO)

        assert route.target == "error"
        assert route.error_code == "selector_required"

    def test_batch_transcription_can_use_transparent_routing(self, routing_table):
        route = routing_table.resolve(TranscriptionMethods.TRANSCRIBE)

        assert route.target == "local"
        assert route.module == "Transcription"

    def test_batch_wakeword_detect_can_use_transparent_routing(self, routing_table):
        route = routing_table.resolve(WakeWordMethods.DETECT)

        assert route.target == "local"
        assert route.module == "WakeWord"

    @pytest.mark.asyncio
    async def test_explicit_audio_selector_routes_to_selected_peer(
        self, routing_table, peer_registry
    ):
        peer = _make_negotiated_peer("speaker-peer", ["TTS"], latency_ms=20.0)
        await peer_registry.register_peer("speaker-peer")
        await peer_registry.update_manifest("speaker-peer", peer.manifest)

        route = routing_table.resolve(
            TTSMethods.REQUEST,
            selector=MeshAddressSelector(
                peer_id="speaker-peer",
                hardware_target="living-room-speaker",
            ),
        )

        assert route.target == "remote"
        assert route.peer_id == "speaker-peer"
        assert route.selector.hardware_target == "living-room-speaker"

    def test_conflicting_explicit_selectors_return_error(self, routing_table):
        route = routing_table.resolve(
            "Tooling.ExecuteTool",
            selector=MeshAddressSelector(peer_id="peer-1", provider_id="peer-2"),
        )

        assert route.target == "error"
        assert route.error_code == "selector_conflict"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "provider_id",
        [
            "remote:studio-gpu:Orchestrator",
            "studio-gpu:Orchestrator",
            "mesh:studio-gpu:Orchestrator",
        ],
    )
    async def test_orchestrator_provider_aliases_route_to_selected_peer(
        self, routing_table, peer_registry, provider_id
    ):
        peer = _make_negotiated_peer("studio-gpu", ["Orchestrator"], latency_ms=12.0)
        await peer_registry.register_peer("studio-gpu")
        await peer_registry.update_manifest("studio-gpu", peer.manifest)
        await peer_registry.update_latency("studio-gpu", 12.0)

        route = routing_table.resolve(
            OrchestratorMethods.INFER_CHAT,
            selector=MeshAddressSelector(provider_id=provider_id),
        )

        assert route.target == "remote"
        assert route.peer_id == "studio-gpu"
        assert route.module == "Orchestrator"

    @pytest.mark.asyncio
    async def test_infer_chat_selector_from_sdk_mesh_provider_alias_routes_to_peer(
        self, routing_table, peer_registry
    ):
        peer = _make_negotiated_peer("studio-gpu", ["Orchestrator"], latency_ms=12.0)
        await peer_registry.register_peer("studio-gpu")
        await peer_registry.update_manifest("studio-gpu", peer.manifest)
        await peer_registry.update_latency("studio-gpu", 12.0)

        route = routing_table.resolve(
            OrchestratorMethods.INFER_CHAT,
            selector=MeshAddressSelector(
                peer_id="studio-gpu",
                service_instance_id="remote:studio-gpu:Orchestrator",
            ),
        )

        assert route.target == "remote"
        assert route.peer_id == "studio-gpu"
        assert route.module == "Orchestrator"
        assert route.selector.service_instance_id == "remote:studio-gpu:Orchestrator"

    @pytest.mark.asyncio
    async def test_wrong_module_mesh_alias_returns_conflict(self, routing_table, peer_registry):
        peer = _make_negotiated_peer("studio-gpu", ["Orchestrator"])
        await peer_registry.register_peer("studio-gpu")
        await peer_registry.update_manifest("studio-gpu", peer.manifest)

        route = routing_table.resolve(
            OrchestratorMethods.INFER_CHAT,
            selector=MeshAddressSelector(provider_id="mesh:studio-gpu:TTS"),
        )

        assert route.target == "error"
        assert route.error_code == "selector_conflict"
        assert "targets TTS, not Orchestrator" in route.error_message


class TestRoutingTableResolveFallback:
    """Tests for RoutingTable.resolve_fallback()."""

    def test_disabled_mesh_config_fails_closed_for_fallback(self, peer_registry):
        routing_table = RoutingTable(MeshConfig(enabled=False), peer_registry)

        route = routing_table.resolve_fallback(TTSMethods.SYNTHESIZE, failed_peer_id="peer-1")

        assert route.target == "error"
        assert route.error_code == "mesh_disabled"

    def test_fallback_local(self, routing_table):
        route = routing_table.resolve_fallback(TTSMethods.SYNTHESIZE, failed_peer_id="peer-1")
        assert route.target == "local"

    @pytest.mark.asyncio
    async def test_fallback_network_finds_another_peer(self, mesh_config, peer_registry):
        mesh_config = _config_with_service(
            mesh_config,
            "TTS",
            mesh_policy(prefer="network", fallback="network"),
        )
        routing_table = RoutingTable(mesh_config, peer_registry)

        # Register two peers
        for pid, lat in [("peer-1", 20.0), ("peer-2", 30.0)]:
            await peer_registry.register_peer(pid)
            manifest = verified_peer_manifest(
                pid,
                [
                    PeerServiceInfo(
                        module="TTS",
                        version="1.0.0",
                        methods=[
                            MethodInfo(
                                name="Synthesize",
                                bus_topic=TTSMethods.SYNTHESIZE,
                                exposure="external",
                                required_perms=[TTSMethods.SYNTHESIZE],
                            )
                        ],
                    )
                ],
            )
            await peer_registry.update_manifest(pid, manifest)
            await peer_registry.update_latency(pid, lat)

        fallback = routing_table.resolve_fallback(TTSMethods.SYNTHESIZE, failed_peer_id="peer-1")
        assert fallback.target == "remote"
        assert fallback.peer_id == "peer-2"

    def test_fallback_error(self, routing_table):
        config = mesh_policy(prefer="network_only", fallback="error")
        route = routing_table.resolve_fallback("STT.Request", routing_config=config)
        assert route.target == "error"

    def test_no_routing_config_returns_local(self, routing_table):
        route = routing_table.resolve_fallback("Unknown.Topic")
        assert route.target == "local"

    def test_fallback_resolution_captures_one_policy_snapshot(self, mesh_config, peer_registry):
        store = MeshPolicyStore()
        store.replace(mesh_config, source_revision=1)
        calls = 0

        def provider():
            nonlocal calls
            calls += 1
            return store.current()

        routing_table = RoutingTable(mesh_config, peer_registry, policy_provider=provider)

        route = routing_table.resolve_fallback(TTSMethods.SYNTHESIZE, failed_peer_id="peer-1")

        assert route.target == "local"
        assert calls == 1
