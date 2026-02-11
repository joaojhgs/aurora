"""Unit tests for the negotiation protocol."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.gateway.config import MeshConfig, ServiceRoutingConfig, ServiceSharingConfig
from app.services.gateway.mesh.models import ManifestAck, PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.negotiation import (
    generate_manifest,
    generate_manifest_ack,
    manifest_ack_to_dict,
    manifest_to_dict,
    parse_manifest,
    parse_manifest_ack,
)
from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.registry import ModuleContract


@pytest.fixture
def mesh_config_sharing():
    """MeshConfig with sharing enabled for TTS."""
    return MeshConfig(
        enabled=True,
        node_name="test-node",
        sharing={
            "TTS": ServiceSharingConfig(share=True, max_concurrent=5),
            "DB": ServiceSharingConfig(share=False),
        },
        routing={},
    )


@pytest.fixture
def mesh_config_routing():
    """MeshConfig with routing preferences."""
    return MeshConfig(
        enabled=True,
        node_name="test-node",
        sharing={},
        routing={
            "TTS": ServiceRoutingConfig(
                prefer="network",
                fallback="local",
                min_version="1.0.0",
            ),
            "Scheduler": ServiceRoutingConfig(prefer="local"),
        },
        version_policy="compatible",
    )


class TestGenerateManifest:
    """Tests for generate_manifest()."""

    @patch("app.shared.contracts.registry.list_modules")
    @patch("app.shared.contracts.registry._get_package_version")
    def test_generates_manifest_for_shared_services(
        self, mock_version, mock_list_modules, mesh_config_sharing
    ):
        mock_version.return_value = "0.5.0"

        # Create a fake module contract for TTS using SimpleNamespace
        # (MagicMock's .name attribute is special and returns a Mock, not a string)
        tts_method = SimpleNamespace(
            name="Synthesize",
            summary="Text to speech",
            bus_topic="TTS.Synthesize",
            exposure="both",
            required_perms=["TTS.*"],
            input_model=type("TTSRequest", (), {"__name__": "TTSRequest"}),
            output_model=type("TTSResponse", (), {"__name__": "TTSResponse"}),
        )
        tts_contract = SimpleNamespace(
            version="1.2.0",
            capabilities=["streaming"],
            methods=[tts_method],
        )

        # DB contract — not shared, should be excluded
        db_contract = SimpleNamespace(
            version="1.0.0",
            capabilities=[],
            methods=[],
        )

        mock_list_modules.return_value = {
            "TTS": tts_contract,
            "DB": db_contract,
        }

        manifest = generate_manifest("peer-1", mesh_config_sharing)

        assert manifest.peer_id == "peer-1"
        assert manifest.node_name == "test-node"
        assert manifest.aurora_version == "0.5.0"
        assert len(manifest.shared_services) == 1
        assert manifest.shared_services[0].module == "TTS"
        assert manifest.shared_services[0].version == "1.2.0"
        assert manifest.shared_services[0].max_concurrent == 5
        assert len(manifest.shared_services[0].methods) == 1

    @patch("app.shared.contracts.registry.list_modules")
    @patch("app.shared.contracts.registry._get_package_version")
    def test_excludes_non_shared_modules(self, mock_version, mock_list_modules, mesh_config_sharing):
        mock_version.return_value = "0.5.0"

        db_contract = SimpleNamespace(
            version="1.0.0",
            capabilities=[],
            methods=[],
        )

        mock_list_modules.return_value = {"DB": db_contract}

        manifest = generate_manifest("peer-1", mesh_config_sharing)
        assert len(manifest.shared_services) == 0

    @patch("app.shared.contracts.registry.list_modules")
    @patch("app.shared.contracts.registry._get_package_version")
    def test_excludes_internal_methods(self, mock_version, mock_list_modules, mesh_config_sharing):
        mock_version.return_value = "0.1.0"

        tts_method = SimpleNamespace(
            name="InternalHelper",
            summary="Internal only",
            bus_topic="TTS.InternalHelper",
            exposure="internal",  # Not external
            required_perms=[],
            input_model=None,
            output_model=None,
        )
        tts_contract = SimpleNamespace(
            version="1.0.0",
            capabilities=[],
            methods=[tts_method],
        )

        mock_list_modules.return_value = {"TTS": tts_contract}

        manifest = generate_manifest("peer-1", mesh_config_sharing)
        assert len(manifest.shared_services) == 1
        assert len(manifest.shared_services[0].methods) == 0  # Internal excluded


class TestGenerateManifestAck:
    """Tests for generate_manifest_ack()."""

    def test_compatible_service(self, mesh_config_routing):
        remote_manifest = PeerManifest(
            peer_id="peer-2",
            shared_services=[
                PeerServiceInfo(module="TTS", version="1.5.0", capabilities=[]),
            ],
        )
        ack = generate_manifest_ack(remote_manifest, mesh_config_routing)
        assert "TTS" in ack.compatible_services

    def test_incompatible_version(self, mesh_config_routing):
        remote_manifest = PeerManifest(
            peer_id="peer-2",
            shared_services=[
                PeerServiceInfo(module="TTS", version="0.5.0", capabilities=[]),
            ],
        )
        ack = generate_manifest_ack(remote_manifest, mesh_config_routing)
        assert "TTS" in ack.incompatible_services

    def test_unused_service(self, mesh_config_routing):
        remote_manifest = PeerManifest(
            peer_id="peer-2",
            shared_services=[
                PeerServiceInfo(module="Unknown", version="1.0.0", capabilities=[]),
            ],
        )
        ack = generate_manifest_ack(remote_manifest, mesh_config_routing)
        assert "Unknown" in ack.unused_services

    def test_local_prefer_marked_unused(self, mesh_config_routing):
        """Services with prefer=local should be marked unused."""
        remote_manifest = PeerManifest(
            peer_id="peer-2",
            shared_services=[
                PeerServiceInfo(module="Scheduler", version="1.0.0"),
            ],
        )
        ack = generate_manifest_ack(remote_manifest, mesh_config_routing)
        assert "Scheduler" in ack.unused_services

    def test_required_capabilities_missing(self):
        config = MeshConfig(
            enabled=True,
            routing={
                "TTS": ServiceRoutingConfig(
                    prefer="network",
                    min_version="1.0.0",
                    required_capabilities=["streaming"],
                ),
            },
        )
        remote_manifest = PeerManifest(
            peer_id="peer-2",
            shared_services=[
                PeerServiceInfo(module="TTS", version="1.5.0", capabilities=[]),
            ],
        )
        ack = generate_manifest_ack(remote_manifest, config)
        assert "TTS" in ack.incompatible_services


class TestSerialization:
    """Tests for manifest/ack serialization helpers."""

    def test_manifest_to_dict(self):
        manifest = PeerManifest(
            peer_id="peer-1",
            node_name="test",
            shared_services=[PeerServiceInfo(module="TTS")],
        )
        d = manifest_to_dict(manifest)
        assert d["type"] == "manifest"
        assert d["peer_id"] == "peer-1"

    def test_manifest_ack_to_dict(self):
        ack = ManifestAck(compatible_services=["TTS"])
        d = manifest_ack_to_dict(ack)
        assert d["type"] == "manifest_ack"
        assert d["compatible_services"] == ["TTS"]

    def test_parse_manifest(self):
        data = {
            "type": "manifest",
            "peer_id": "peer-1",
            "node_name": "test",
            "aurora_version": "0.1.0",
            "shared_services": [],
            "timestamp": "",
        }
        manifest = parse_manifest(data)
        assert manifest is not None
        assert manifest.peer_id == "peer-1"

    def test_parse_manifest_invalid(self):
        result = parse_manifest({"type": "manifest", "invalid": True})
        assert result is None

    def test_parse_manifest_ack(self):
        data = {
            "type": "manifest_ack",
            "compatible_services": ["TTS"],
            "incompatible_services": [],
            "unused_services": ["DB"],
        }
        ack = parse_manifest_ack(data)
        assert ack is not None
        assert "TTS" in ack.compatible_services

    def test_parse_manifest_ack_invalid(self):
        # ManifestAck has defaults so even invalid data may parse
        result = parse_manifest_ack({"type": "manifest_ack"})
        # Should return a valid ManifestAck with defaults
        assert result is not None

    def test_roundtrip_manifest(self):
        manifest = PeerManifest(
            peer_id="peer-1",
            node_name="node",
            shared_services=[PeerServiceInfo(module="TTS", version="1.0.0")],
        )
        d = manifest_to_dict(manifest)
        parsed = parse_manifest(d)
        assert parsed is not None
        assert parsed.peer_id == manifest.peer_id
        assert len(parsed.shared_services) == len(manifest.shared_services)

    def test_roundtrip_ack(self):
        ack = ManifestAck(
            compatible_services=["TTS"],
            incompatible_services=["STT"],
            unused_services=["DB"],
        )
        d = manifest_ack_to_dict(ack)
        parsed = parse_manifest_ack(d)
        assert parsed is not None
        assert parsed.compatible_services == ack.compatible_services
