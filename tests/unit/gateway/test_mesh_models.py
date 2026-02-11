"""Unit tests for mesh P2P data models."""

import pytest
from pydantic import ValidationError

from app.services.gateway.mesh.models import (
    CapacityUpdate,
    ManifestAck,
    PeerManifest,
    PeerServiceInfo,
    PeerState,
    RouteDecision,
)
from app.shared.contracts.models.gateway import MethodInfo


class TestPeerServiceInfo:
    """Tests for PeerServiceInfo model."""

    def test_minimal_creation(self):
        svc = PeerServiceInfo(module="TTS")
        assert svc.module == "TTS"
        assert svc.version == "0.0.0"
        assert svc.capabilities == []
        assert svc.methods == []
        assert svc.max_concurrent == 10
        assert svc.digest == ""

    def test_full_creation(self):
        method = MethodInfo(
            name="Synthesize",
            summary="Text to speech",
            bus_topic="TTS.Synthesize",
            exposure="both",
        )
        svc = PeerServiceInfo(
            module="TTS",
            version="1.2.3",
            capabilities=["streaming", "multilingual"],
            methods=[method],
            max_concurrent=5,
            digest="abc123",
        )
        assert svc.module == "TTS"
        assert svc.version == "1.2.3"
        assert len(svc.capabilities) == 2
        assert len(svc.methods) == 1
        assert svc.methods[0].name == "Synthesize"
        assert svc.max_concurrent == 5
        assert svc.digest == "abc123"

    def test_serialization_roundtrip(self):
        svc = PeerServiceInfo(
            module="TTS",
            version="1.0.0",
            capabilities=["fast"],
            max_concurrent=3,
        )
        data = svc.model_dump()
        svc2 = PeerServiceInfo.model_validate(data)
        assert svc == svc2

    def test_json_roundtrip(self):
        svc = PeerServiceInfo(module="Orchestrator", version="2.1.0")
        json_str = svc.model_dump_json()
        svc2 = PeerServiceInfo.model_validate_json(json_str)
        assert svc == svc2


class TestPeerManifest:
    """Tests for PeerManifest model."""

    def test_minimal_creation(self):
        manifest = PeerManifest(peer_id="peer-1")
        assert manifest.peer_id == "peer-1"
        assert manifest.node_name == ""
        assert manifest.aurora_version == ""
        assert manifest.shared_services == []
        assert manifest.timestamp == ""

    def test_with_services(self):
        svc = PeerServiceInfo(module="TTS", version="1.0.0")
        manifest = PeerManifest(
            peer_id="peer-1",
            node_name="my-node",
            aurora_version="0.5.0",
            shared_services=[svc],
            timestamp="2025-01-01T00:00:00Z",
        )
        assert len(manifest.shared_services) == 1
        assert manifest.shared_services[0].module == "TTS"
        assert manifest.node_name == "my-node"

    def test_serialization_roundtrip(self):
        svc = PeerServiceInfo(module="DB", version="1.0.0")
        manifest = PeerManifest(
            peer_id="peer-2",
            node_name="other",
            shared_services=[svc],
        )
        data = manifest.model_dump()
        manifest2 = PeerManifest.model_validate(data)
        assert manifest == manifest2


class TestManifestAck:
    """Tests for ManifestAck model."""

    def test_empty_ack(self):
        ack = ManifestAck()
        assert ack.compatible_services == []
        assert ack.incompatible_services == []
        assert ack.unused_services == []

    def test_populated_ack(self):
        ack = ManifestAck(
            compatible_services=["TTS", "DB"],
            incompatible_services=["STT"],
            unused_services=["Scheduler"],
        )
        assert len(ack.compatible_services) == 2
        assert "TTS" in ack.compatible_services
        assert "STT" in ack.incompatible_services
        assert "Scheduler" in ack.unused_services


class TestPeerState:
    """Tests for PeerState model."""

    def test_defaults(self):
        state = PeerState(peer_id="p1")
        assert state.peer_id == "p1"
        assert state.node_name == ""
        assert state.manifest is None
        assert state.latency_ms == float("inf")
        assert state.last_ping == 0.0
        assert state.last_manifest == 0.0
        assert state.active_calls == 0
        assert state.status == "connected"

    def test_with_manifest(self):
        manifest = PeerManifest(peer_id="p1", node_name="node-1")
        state = PeerState(
            peer_id="p1",
            manifest=manifest,
            status="negotiated",
            latency_ms=42.5,
        )
        assert state.manifest is not None
        assert state.manifest.peer_id == "p1"
        assert state.status == "negotiated"
        assert state.latency_ms == 42.5

    def test_status_values(self):
        for status in ["connected", "authenticated", "negotiated", "stale"]:
            state = PeerState(peer_id="p1", status=status)
            assert state.status == status


class TestRouteDecision:
    """Tests for RouteDecision model."""

    def test_local_route(self):
        route = RouteDecision(target="local", module="TTS")
        assert route.target == "local"
        assert route.peer_id is None
        assert route.module == "TTS"

    def test_remote_route(self):
        route = RouteDecision(
            target="remote",
            peer_id="peer-1",
            module="TTS",
            version="1.0.0",
            latency_ms=25.0,
        )
        assert route.target == "remote"
        assert route.peer_id == "peer-1"
        assert route.latency_ms == 25.0

    def test_error_route(self):
        route = RouteDecision(target="error", module="TTS")
        assert route.target == "error"

    def test_none_route(self):
        route = RouteDecision(target="none", module="TTS")
        assert route.target == "none"


class TestCapacityUpdate:
    """Tests for CapacityUpdate model."""

    def test_defaults(self):
        cap = CapacityUpdate(module="TTS")
        assert cap.module == "TTS"
        assert cap.available == 0
        assert cap.max_concurrent == 10

    def test_custom(self):
        cap = CapacityUpdate(module="Orchestrator", available=3, max_concurrent=5)
        assert cap.available == 3
        assert cap.max_concurrent == 5
