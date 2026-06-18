"""Unit tests for the mesh RoutingTable."""

import pytest

from app.services.gateway.config import MeshConfig, MeshServiceConfig
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo, PeerState, RouteDecision
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable, _extract_module
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.stt import TranscriptionMethods
from app.shared.contracts.models.tts import TTSMethods


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
            "TTS": MeshServiceConfig(prefer="network", fallback="local"),
            "DB": MeshServiceConfig(prefer="local"),
            "STT": MeshServiceConfig(prefer="network_only", fallback="error"),
            "Transcription": MeshServiceConfig(prefer="network", fallback="local"),
            "Scheduler": MeshServiceConfig(prefer="local_only"),
            "Tooling": MeshServiceConfig(prefer="local", require_explicit_selector=True),
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
    services = [
        PeerServiceInfo(module=m, version="1.0.0", max_concurrent=max_concurrent) for m in modules
    ]
    manifest = PeerManifest(peer_id=peer_id, shared_services=services)
    return PeerState(
        peer_id=peer_id,
        manifest=manifest,
        status="negotiated",
        latency_ms=latency_ms,
    )


class TestRoutingTableResolve:
    """Tests for RoutingTable.resolve()."""

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
        mesh_config.services["DB"] = MeshServiceConfig(prefer="local", allowed_peers=["peer-2"])
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
        mesh_config.services["DB"] = MeshServiceConfig(prefer="local", min_version="2.0.0")
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


class TestRoutingTableResolveFallback:
    """Tests for RoutingTable.resolve_fallback()."""

    def test_fallback_local(self, routing_table):
        route = routing_table.resolve_fallback(TTSMethods.SYNTHESIZE, failed_peer_id="peer-1")
        assert route.target == "local"

    @pytest.mark.asyncio
    async def test_fallback_network_finds_another_peer(self, mesh_config, peer_registry):
        mesh_config.services["TTS"] = MeshServiceConfig(prefer="network", fallback="network")
        routing_table = RoutingTable(mesh_config, peer_registry)

        # Register two peers
        for pid, lat in [("peer-1", 20.0), ("peer-2", 30.0)]:
            await peer_registry.register_peer(pid)
            manifest = PeerManifest(
                peer_id=pid,
                shared_services=[PeerServiceInfo(module="TTS", version="1.0.0")],
            )
            await peer_registry.update_manifest(pid, manifest)
            await peer_registry.update_latency(pid, lat)

        fallback = routing_table.resolve_fallback(TTSMethods.SYNTHESIZE, failed_peer_id="peer-1")
        assert fallback.target == "remote"
        assert fallback.peer_id == "peer-2"

    def test_fallback_error(self, routing_table):
        config = MeshServiceConfig(prefer="network_only", fallback="error")
        route = routing_table.resolve_fallback("STT.Request", routing_config=config)
        assert route.target == "error"

    def test_no_routing_config_returns_local(self, routing_table):
        route = routing_table.resolve_fallback("Unknown.Topic")
        assert route.target == "local"
