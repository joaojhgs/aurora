"""Unit tests for the negotiation protocol."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.models import ManifestAck, PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.negotiation import (
    _validate_service_feature_objects,
    finalize_recipient_projection_evidence,
    generate_manifest,
    generate_manifest_ack,
    manifest_ack_to_dict,
    manifest_projection_digest,
    manifest_to_dict,
    parse_manifest,
    parse_manifest_ack,
)
from app.services.gateway.mesh.provider_export import ACTIVE_MANIFEST_PROTOCOL, SUPPORTED_PROTOCOLS
from app.shared.contracts.mesh_surface import (
    feature_contracts_for_module,
    feature_contracts_for_topic,
)
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
from app.shared.contracts.registry import ModuleContract
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


def _module_features(module: str):
    return list(feature_contracts_for_module(module))


def _topic_features(topic: str):
    return list(feature_contracts_for_topic(topic))


def _verified_remote_manifest(service: PeerServiceInfo) -> PeerManifest:
    manifest = PeerManifest(
        peer_id="peer-2",
        shared_services=[service],
        active_protocol=ACTIVE_MANIFEST_PROTOCOL,
        active_version="v1",
        active_tier="projection",
        supported_protocols=list(SUPPORTED_PROTOCOLS),
        projection_supported=True,
        projection_active=True,
    )
    evidence = finalize_recipient_projection_evidence(
        {
            "provider_peer_id": "peer-2",
            "recipient_peer_id": "local-peer",
            "registry_revision": "registry-7",
            "registry_digest": "registry-digest",
            "policy_revision": "export-9",
            "policy_digest": "policy-digest",
            "auth_grant_revision": 4,
            "auth_grant_state": "active",
            "auth_grant_digest": "",
            "grants_digest": "",
            "protocol_tier": ACTIVE_MANIFEST_PROTOCOL,
            "projection_digest": manifest_projection_digest(manifest),
            "evidence_digest": "",
            "grants": [{"permission": "*", "source": "effective"}],
        }
    )
    return manifest.model_copy(update={"recipient_projection_evidence": evidence})


def _tts_service(*, version: str = "1.5.0", capabilities: list[str] | None = None):
    return PeerServiceInfo(
        module="TTS",
        version=version,
        capabilities=capabilities or [],
        available_feature_ids=["tts.synthesis"],
        methods=[
            MethodInfo(
                name="Synthesize",
                bus_topic="TTS.Synthesize",
                exposure="external",
                method_type="use",
                required_perms=["TTS.use"],
            )
        ],
    )


@pytest.fixture
def mesh_config_sharing():
    """MeshConfig with sharing enabled for TTS."""
    return MeshConfig(
        enabled=True,
        node_name="test-node",
        services={
            "TTS": mesh_policy(share=True, max_concurrent=5),
            "DB": mesh_policy(share=False),
        },
    )


@pytest.fixture
def mesh_config_routing():
    """MeshConfig with routing preferences."""
    return MeshConfig(
        enabled=True,
        node_name="test-node",
        services={
            "TTS": mesh_policy(
                prefer="network",
                fallback="local",
                min_version="1.0.0",
            ),
            "Scheduler": mesh_policy(prefer="local"),
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
            callable_feature_ids=["speech_synthesis"],
            callable_features=_topic_features("TTS.Synthesize"),
            input_model=type("TTSRequest", (), {"__name__": "TTSRequest"}),
            output_model=type("TTSResponse", (), {"__name__": "TTSResponse"}),
            method_type="use",
        )
        tts_contract = SimpleNamespace(
            version="1.2.0",
            capabilities=["streaming"],
            callable_features=_module_features("TTS"),
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
    def test_g004_manifest_remains_unfiltered_despite_feature_exclusions(
        self, mock_version, mock_list_modules
    ):
        mock_version.return_value = "0.5.0"
        synthesize = SimpleNamespace(
            name="Synthesize",
            summary="Text to speech",
            bus_topic="TTS.Synthesize",
            exposure="external",
            required_perms=["TTS.Synthesize"],
            callable_feature_ids=["speech_synthesis"],
            callable_features=_topic_features("TTS.Synthesize"),
            input_model=None,
            output_model=None,
            method_type="use",
        )
        request = SimpleNamespace(
            name="Request",
            summary="Play text",
            bus_topic="TTS.Request",
            exposure="external",
            required_perms=["TTS.Request"],
            callable_feature_ids=["speech_playback"],
            callable_features=_topic_features("TTS.Request"),
            input_model=None,
            output_model=None,
            method_type="use",
        )
        mock_list_modules.return_value = {
            "TTS": SimpleNamespace(
                version="1.2.0",
                capabilities=["streaming", "playback"],
                callable_features=_module_features("TTS"),
                methods=[synthesize, request],
            )
        }
        mesh_config = MeshConfig(
            enabled=True,
            services={
                "TTS": mesh_policy(
                    share=True,
                    unshared_feature_ids=["playback"],
                    unshared_method_ids=["TTS.Request"],
                )
            },
        )

        manifest = generate_manifest("peer-1", mesh_config)

        assert mesh_config.services["TTS"].export.unshared_feature_ids == ("playback",)
        assert mesh_config.services["TTS"].export.unshared_method_ids == ("TTS.Request",)
        assert [method.bus_topic for method in manifest.shared_services[0].methods] == [
            "TTS.Synthesize",
            "TTS.Request",
        ]

    @patch("app.shared.contracts.registry.list_modules")
    @patch("app.shared.contracts.registry._get_package_version")
    def test_excludes_non_shared_modules(
        self, mock_version, mock_list_modules, mesh_config_sharing
    ):
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
            callable_feature_ids=[],
            callable_features=[],
            input_model=None,
            output_model=None,
        )
        tts_contract = SimpleNamespace(
            version="1.0.0",
            capabilities=[],
            callable_features=_module_features("TTS"),
            methods=[tts_method],
        )

        mock_list_modules.return_value = {"TTS": tts_contract}

        manifest = generate_manifest("peer-1", mesh_config_sharing)
        assert len(manifest.shared_services) == 1
        assert len(manifest.shared_services[0].methods) == 0  # Internal excluded

    @patch("app.shared.contracts.registry.list_modules")
    @patch("app.shared.contracts.registry._get_package_version")
    def test_invalid_mesh_callable_metadata_is_rejected_from_manifest(
        self, mock_version, mock_list_modules, mesh_config_sharing
    ):
        mock_version.return_value = "0.1.0"
        valid = SimpleNamespace(
            name="Synthesize",
            summary="Text to speech",
            bus_topic="TTS.Synthesize",
            exposure="both",
            required_perms=["TTS.Synthesize"],
            callable_feature_ids=["speech_synthesis"],
            callable_features=_topic_features("TTS.Synthesize"),
            input_model=None,
            output_model=None,
            method_type="use",
        )
        missing_feature = SimpleNamespace(
            name="Request",
            summary="Play text",
            bus_topic="TTS.Request",
            exposure="both",
            required_perms=["TTS.Request"],
            callable_feature_ids=[],
            input_model=None,
            output_model=None,
            method_type="use",
        )
        missing_permission = SimpleNamespace(
            name="StreamStart",
            summary="Start stream",
            bus_topic="TTS.StreamStart",
            exposure="both",
            required_perms=[],
            callable_feature_ids=["speech_streaming"],
            input_model=None,
            output_model=None,
            method_type="use",
        )
        mock_list_modules.return_value = {
            "TTS": SimpleNamespace(
                version="1.0.0",
                capabilities=[],
                callable_features=_module_features("TTS"),
                methods=[valid, missing_feature, missing_permission],
            )
        }

        with pytest.raises(ValueError, match="Invalid callable method"):
            generate_manifest("peer-1", mesh_config_sharing)

    @patch("app.shared.contracts.registry.list_modules")
    @patch("app.shared.contracts.registry._get_package_version")
    def test_local_manifest_rejects_wholly_legacy_mesh_service(
        self, mock_version, mock_list_modules, mesh_config_sharing
    ):
        mock_version.return_value = "0.1.0"
        mock_list_modules.return_value = {
            "TTS": SimpleNamespace(
                version="1.0.0",
                capabilities=[],
                callable_features=[],
                methods=[],
            )
        }

        with pytest.raises(ValueError, match="callable features mismatch"):
            generate_manifest("peer-1", mesh_config_sharing)

    def test_default_validation_rejects_wholly_legacy_mesh_service(self):
        with pytest.raises(ValueError, match="callable features mismatch"):
            _validate_service_feature_objects(
                module="TTS",
                callable_features=[],
                methods=[],
            )

    def test_process_manifest_rejects_wholly_legacy_mesh_service(self, mesh_config_sharing):
        process_registry = SimpleNamespace(
            snapshot_services=lambda: {
                "TTS": ServiceAnnouncement(
                    module="TTS",
                    version="1.0.0",
                    capabilities=[],
                    callable_features=[],
                    methods=[],
                )
            }
        )

        with pytest.raises(ValueError, match="callable features mismatch"):
            generate_manifest("peer-1", mesh_config_sharing, registry=process_registry)

    @patch("app.shared.contracts.registry.list_modules")
    @patch("app.shared.contracts.registry._get_package_version")
    def test_thread_and_process_manifest_generation_are_behaviorally_identical(
        self,
        mock_version,
        mock_list_modules,
        mesh_config_sharing,
    ):
        """Equivalent registries produce identical manifests in thread and process modes."""

        mock_version.return_value = "0.5.0"
        input_model = type("TTSRequest", (), {"__name__": "TTSRequest"})
        output_model = type("TTSResponse", (), {"__name__": "TTSResponse"})
        local_methods = [
            SimpleNamespace(
                name="Synthesize",
                summary="Text to speech",
                bus_topic="TTS.Synthesize",
                exposure="both",
                required_perms=["TTS.use"],
                callable_feature_ids=["speech_synthesis"],
                callable_features=_topic_features("TTS.Synthesize"),
                input_model=input_model,
                output_model=output_model,
                method_type="use",
            ),
            SimpleNamespace(
                name="InternalHelper",
                summary="Internal only",
                bus_topic="TTS.InternalHelper",
                exposure="internal",
                required_perms=[],
                callable_feature_ids=[],
                callable_features=[],
                input_model=None,
                output_model=None,
                method_type="manage",
            ),
        ]
        mock_list_modules.return_value = {
            "TTS": SimpleNamespace(
                version="1.2.0",
                capabilities=["streaming"],
                callable_features=_module_features("TTS"),
                methods=local_methods,
            )
        }
        process_registry = SimpleNamespace(
            snapshot_services=lambda: {
                "TTS": ServiceAnnouncement(
                    module="TTS",
                    version="1.2.0",
                    capabilities=["streaming"],
                    methods=[
                        MethodInfo(
                            name="Synthesize",
                            summary="Text to speech",
                            bus_topic="TTS.Synthesize",
                            exposure="both",
                            required_perms=["TTS.use"],
                            callable_feature_ids=["speech_synthesis"],
                            callable_features=_topic_features("TTS.Synthesize"),
                            input_model="TTSRequest",
                            output_model="TTSResponse",
                            method_type="use",
                        ),
                        MethodInfo(
                            name="InternalHelper",
                            summary="Internal only",
                            bus_topic="TTS.InternalHelper",
                            exposure="internal",
                            callable_feature_ids=[],
                            callable_features=[],
                            method_type="manage",
                        ),
                    ],
                    callable_features=_module_features("TTS"),
                )
            }
        )

        thread_manifest = generate_manifest(
            "peer-1",
            mesh_config_sharing,
            granted_permissions=["TTS.use"],
        )
        process_manifest = generate_manifest(
            "peer-1",
            mesh_config_sharing,
            registry=process_registry,
            granted_permissions=["TTS.use"],
        )

        assert thread_manifest.model_dump(exclude={"timestamp"}) == process_manifest.model_dump(
            exclude={"timestamp"}
        )
        assert [method.name for method in thread_manifest.shared_services[0].methods] == [
            "Synthesize"
        ]


class TestGenerateManifestAck:
    """Tests for generate_manifest_ack()."""

    def test_compatible_service(self, mesh_config_routing):
        remote_manifest = _verified_remote_manifest(_tts_service())
        ack = generate_manifest_ack(remote_manifest, mesh_config_routing)
        assert "TTS" in ack.compatible_services
        assert ack.protocol_revision == "v1"
        assert ack.registry_revision == "registry-7"
        assert ack.export_policy_revision == "export-9"
        assert ack.auth_grant_revision == 4
        assert ack.services[0].reason_codes == []

    def test_incompatible_version(self, mesh_config_routing):
        remote_manifest = _verified_remote_manifest(_tts_service(version="0.5.0"))
        ack = generate_manifest_ack(remote_manifest, mesh_config_routing)
        assert "TTS" in ack.incompatible_services
        assert ack.services[0].reason_codes == ["incompatible_version"]

    def test_unused_service(self, mesh_config_routing):
        remote_manifest = PeerManifest(
            peer_id="peer-2",
            shared_services=[
                PeerServiceInfo(module="Unknown", version="1.0.0", capabilities=[]),
            ],
        )
        ack = generate_manifest_ack(remote_manifest, mesh_config_routing)
        assert "Unknown" in ack.unused_services

    def test_local_prefer_remains_compatible_for_explicit_selection(self, mesh_config_routing):
        """A local automatic preference must not hide explicit remote routes."""
        remote_manifest = _verified_remote_manifest(
            PeerServiceInfo(
                module="Scheduler",
                version="1.0.0",
                methods=[
                    MethodInfo(
                        name="ListJobs",
                        bus_topic="Scheduler.ListJobs",
                        exposure="external",
                        method_type="use",
                        required_perms=["Scheduler.use"],
                    )
                ],
            )
        )
        ack = generate_manifest_ack(remote_manifest, mesh_config_routing)
        assert "Scheduler" in ack.compatible_services
        assert "Scheduler" not in ack.unused_services

    def test_required_capabilities_missing(self):
        config = MeshConfig(
            enabled=True,
            services={
                "TTS": mesh_policy(
                    prefer="network",
                    min_version="1.0.0",
                    required_capabilities=["streaming"],
                ),
            },
        )
        remote_manifest = _verified_remote_manifest(_tts_service())
        ack = generate_manifest_ack(remote_manifest, config)
        assert "TTS" in ack.incompatible_services
        assert ack.services[0].reason_codes == ["missing_required_capability_tags"]

    def test_required_provider_feature_ids_are_reported_by_ack(self):
        config = MeshConfig(
            enabled=True,
            services={
                "TTS": mesh_policy(
                    prefer="network",
                    min_version="1.0.0",
                    required_provider_feature_ids=["future-feature"],
                ),
            },
        )
        remote_manifest = _verified_remote_manifest(_tts_service())

        ack = generate_manifest_ack(remote_manifest, config)

        assert config.services["TTS"].routing.required_provider_feature_ids == ("future-feature",)
        assert "TTS" in ack.incompatible_services
        assert ack.services[0].reason_codes == ["missing_required_features"]


class TestSerialization:
    """Tests for manifest/ack serialization helpers."""

    def test_manifest_to_dict(self):
        manifest = PeerManifest(
            peer_id="peer-1",
            node_name="test",
            shared_services=[
                PeerServiceInfo(module="TTS", callable_features=_module_features("TTS"))
            ],
        )
        d = manifest_to_dict(manifest)
        assert d["type"] == "manifest"
        assert d["peer_id"] == "peer-1"

    def test_manifest_ack_to_dict(self):
        ack = ManifestAck(compatible_services=["TTS"])
        d = manifest_ack_to_dict(ack)
        assert d["type"] == "manifest_ack"
        assert d["compatible_services"] == ["TTS"]

    def test_structured_manifest_ack_roundtrip_retains_legacy_arrays(self):
        ack = generate_manifest_ack(
            _verified_remote_manifest(_tts_service()),
            MeshConfig(services={"TTS": mesh_policy(prefer="network")}),
        )

        parsed = parse_manifest_ack(manifest_ack_to_dict(ack))

        assert parsed is not None
        assert parsed.compatible_services == ["TTS"]
        assert parsed.protocol_revision == "v1"
        assert parsed.services[0].service_id == "TTS"

    @pytest.mark.parametrize(
        "payload",
        [
            {
                "compatible_services": [],
                "services": [
                    {
                        "service_id": "TTS",
                        "status": "compatible",
                        "reason_codes": [],
                    }
                ],
            },
            {
                "compatible_services": ["TTS"],
                "services": [
                    {
                        "service_id": "TTS",
                        "status": "compatible",
                        "reason_codes": ["eligible"],
                    }
                ],
            },
            {
                "incompatible_services": ["TTS", "TTS"],
                "services": [
                    {
                        "service_id": "TTS",
                        "status": "incompatible",
                        "reason_codes": ["permission_denied"],
                    },
                    {
                        "service_id": "TTS",
                        "status": "incompatible",
                        "reason_codes": ["permission_denied"],
                    },
                ],
            },
        ],
    )
    def test_structured_manifest_ack_rejects_contradictions(self, payload):
        assert parse_manifest_ack({"type": "manifest_ack", **payload}) is None

    def test_legacy_arrays_only_manifest_ack_remains_accepted(self):
        parsed = parse_manifest_ack(
            {
                "type": "manifest_ack",
                "compatible_services": ["TTS"],
                "incompatible_services": [],
                "unused_services": [],
            }
        )

        assert parsed is not None
        assert parsed.services == []

    @pytest.mark.parametrize(
        "mutation",
        [
            {"request_payload": {"prompt": "secret"}},
            {
                "services": [
                    {
                        "service_id": "TTS",
                        "status": "compatible",
                        "reason_codes": [],
                        "reason": "api_key=secret",
                    }
                ]
            },
            {
                "services": [
                    {
                        "service_id": "TTS",
                        "status": "incompatible",
                        "reason_codes": ["unknown_remote_reason"],
                    }
                ],
                "compatible_services": [],
                "incompatible_services": ["TTS"],
            },
            {
                "services": [
                    {
                        "service_id": "TTS",
                        "service_label": "Remote secret label",
                        "status": "compatible",
                        "reason_codes": [],
                    }
                ]
            },
        ],
    )
    def test_structured_manifest_ack_rejects_remote_presentation_and_unknown_fields(self, mutation):
        payload = {
            "type": "manifest_ack",
            "compatible_services": ["TTS"],
            "incompatible_services": [],
            "unused_services": [],
            "services": [
                {
                    "service_id": "TTS",
                    "status": "compatible",
                    "reason_codes": [],
                }
            ],
        }
        payload.update(mutation)

        assert parse_manifest_ack(payload) is None

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

    def test_parse_manifest_rejects_missing_wire_callable_feature_objects(self):
        result = parse_manifest(
            {
                "type": "manifest",
                "peer_id": "peer-1",
                "shared_services": [
                    {
                        "module": "TTS",
                        "version": "1.0.0",
                        "methods": [
                            {
                                "name": "Synthesize",
                                "bus_topic": "TTS.Synthesize",
                                "exposure": "both",
                                "required_perms": ["TTS.Synthesize"],
                                "callable_feature_ids": ["speech_synthesis"],
                            }
                        ],
                    }
                ],
            }
        )

        assert result is None

    def test_parse_manifest_accepts_wholly_legacy_zero_method_service(self):
        result = parse_manifest(
            {
                "type": "manifest",
                "peer_id": "peer-1",
                "shared_services": [
                    {
                        "module": "TTS",
                        "version": "1.0.0",
                        "methods": [],
                    }
                ],
            }
        )

        assert result is not None
        assert result.shared_services[0] == PeerServiceInfo(module="TTS", version="1.0.0")

    def test_parse_manifest_accepts_wholly_legacy_multi_method_service(self):
        result = parse_manifest(
            {
                "type": "manifest",
                "peer_id": "peer-1",
                "shared_services": [
                    {
                        "module": "TTS",
                        "version": "1.0.0",
                        "methods": [
                            {
                                "name": "Request",
                                "bus_topic": "TTS.Request",
                                "exposure": "both",
                            },
                            {
                                "name": "Synthesize",
                                "bus_topic": "TTS.Synthesize",
                                "exposure": "both",
                            },
                        ],
                    }
                ],
            }
        )

        assert result is not None
        assert [method.bus_topic for method in result.shared_services[0].methods] == [
            "TTS.Request",
            "TTS.Synthesize",
        ]

    @pytest.mark.parametrize(
        "service",
        [
            pytest.param(
                {
                    "module": "TTS",
                    "version": "1.0.0",
                    "methods": [
                        {
                            "name": "Request",
                            "bus_topic": "TTS.Request",
                            "exposure": "both",
                            "required_perms": ["TTS.Request"],
                            "callable_feature_ids": ["speech_playback"],
                        }
                    ],
                },
                id="ids-only",
            ),
            pytest.param(
                {
                    "module": "TTS",
                    "version": "1.0.0",
                    "methods": [
                        {
                            "name": "Request",
                            "bus_topic": "TTS.Request",
                            "exposure": "both",
                            "required_perms": ["TTS.Request"],
                            "callable_features": [
                                feature.model_dump(mode="json")
                                for feature in _topic_features("TTS.Request")
                            ],
                        }
                    ],
                },
                id="objects-only",
            ),
            pytest.param(
                {
                    "module": "TTS",
                    "version": "1.0.0",
                    "callable_features": [
                        feature.model_dump(mode="json") for feature in _module_features("TTS")
                    ],
                    "methods": [],
                },
                id="service-only-objects",
            ),
            pytest.param(
                {
                    "module": "TTS",
                    "version": "1.0.0",
                    "callable_features": [
                        feature.model_dump(mode="json") for feature in _module_features("TTS")
                    ],
                    "methods": [
                        {
                            "name": "Request",
                            "bus_topic": "TTS.Request",
                            "exposure": "both",
                        }
                    ],
                },
                id="service-only-objects-with-legacy-method",
            ),
            pytest.param(
                {
                    "module": "TTS",
                    "version": "1.0.0",
                    "methods": [
                        {
                            "name": "Request",
                            "bus_topic": "TTS.Request",
                            "exposure": "both",
                        },
                        {
                            "name": "Synthesize",
                            "bus_topic": "TTS.Synthesize",
                            "exposure": "both",
                            "required_perms": ["TTS.Synthesize"],
                            "callable_feature_ids": ["speech_synthesis"],
                            "callable_features": [
                                feature.model_dump(mode="json")
                                for feature in _topic_features("TTS.Synthesize")
                            ],
                        },
                    ],
                },
                id="mixed-legacy-new",
            ),
            pytest.param(
                {
                    "module": "TTS",
                    "version": "1.0.0",
                    "callable_features": [
                        feature.model_dump(mode="json") for feature in _module_features("TTS")
                    ],
                    "methods": [
                        {
                            "name": "Request",
                            "bus_topic": "TTS.Request",
                            "exposure": "both",
                            "required_perms": ["TTS.Request"],
                            "callable_feature_ids": ["speech_playback"],
                            "callable_features": [
                                feature.model_dump(mode="json")
                                for feature in _topic_features("TTS.Synthesize")
                            ],
                        }
                    ],
                },
                id="spoofed-objects",
            ),
        ],
    )
    def test_parse_manifest_rejects_any_non_canonical_feature_evidence(self, service):
        result = parse_manifest(
            {
                "type": "manifest",
                "peer_id": "peer-1",
                "shared_services": [service],
            }
        )

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
            shared_services=[
                PeerServiceInfo(
                    module="TTS",
                    version="1.0.0",
                )
            ],
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
