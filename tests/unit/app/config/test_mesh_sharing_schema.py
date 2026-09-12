"""Parity tests for generated mesh sharing configuration artifacts."""

import json
from pathlib import Path

import pytest

from app.shared.config.keys import ConfigKeys
from app.shared.config.models import MeshRouting, MeshSharing, Model

ROOT = Path(__file__).resolve().parents[4]
SCHEMA_PATH = ROOT / "app/services/config/config_schema.json"
DEFAULTS_PATH = ROOT / "app/services/config/config_defaults.json"

LEGACY_MESH_SHARING_FIELDS = {
    "share": False,
    "max_concurrent": 10,
    "allowed_peers": None,
    "prefer": "local",
    "fallback": "local",
    "min_version": None,
    "required_capabilities": [],
    "require_explicit_selector": False,
}

TRANSITIONAL_MESH_SHARING_FIELDS = {
    **LEGACY_MESH_SHARING_FIELDS,
    "unshared_feature_ids": [],
    "unshared_method_ids": [],
}

MESH_ROUTING_FIELDS = {
    "prefer": "local",
    "fallback": "local",
    "allowed_provider_peer_ids": None,
    "min_version": None,
    "required_provider_feature_ids": [],
    "required_provider_capability_tags": [],
    "require_explicit_selector": False,
}

MESH_SHAREABLE_SERVICE_PATHS = (
    ("stt", "coordinator"),
    ("stt", "transcription"),
    ("stt", "wakeword"),
    ("db",),
    ("orchestrator",),
    ("scheduler",),
    ("tooling",),
    ("tts",),
)


@pytest.mark.unit
def test_mesh_sharing_schema_retains_legacy_shape_and_adds_subtractive_exclusions() -> None:
    schema = json.loads(SCHEMA_PATH.read_text())
    schema_properties = schema["$defs"]["mesh_sharing"]["properties"]

    assert list(schema_properties) == list(TRANSITIONAL_MESH_SHARING_FIELDS)
    assert set(TRANSITIONAL_MESH_SHARING_FIELDS) <= set(MeshSharing.model_fields)

    for field_name, default in TRANSITIONAL_MESH_SHARING_FIELDS.items():
        assert schema_properties[field_name]["default"] == default

    assert "Subtractive" in schema_properties["unshared_feature_ids"]["description"]
    assert "stable feature IDs" in schema_properties["unshared_feature_ids"]["description"]
    assert (
        "Unknown or stale IDs are retained"
        in schema_properties["unshared_feature_ids"]["description"]
    )
    assert "canonical full bus topics" in schema_properties["unshared_method_ids"]["description"]
    assert "empty means no exclusions" in schema_properties["unshared_method_ids"]["description"]


@pytest.mark.unit
def test_mesh_routing_schema_has_exact_transition_shape_and_semantics() -> None:
    schema = json.loads(SCHEMA_PATH.read_text())
    schema_properties = schema["$defs"]["mesh_routing"]["properties"]

    assert list(schema_properties) == list(MESH_ROUTING_FIELDS)
    for field_name, default in MESH_ROUTING_FIELDS.items():
        assert schema_properties[field_name]["default"] == default

    assert schema_properties["prefer"]["enum"] == [
        "local",
        "network",
        "network_only",
        "local_only",
    ]
    assert schema_properties["fallback"]["enum"] == ["local", "network", "error", "none"]
    assert (
        "Null means any otherwise-eligible provider"
        in schema_properties["allowed_provider_peer_ids"]["description"]
    )
    assert (
        "empty array denies network providers"
        in schema_properties["allowed_provider_peer_ids"]["description"]
    )
    assert (
        "Never grants inbound authority"
        in schema_properties["allowed_provider_peer_ids"]["description"]
    )
    assert (
        "All-of stable feature IDs"
        in schema_properties["required_provider_feature_ids"]["description"]
    )
    assert (
        "separate from feature IDs"
        in schema_properties["required_provider_capability_tags"]["description"]
    )
    assert (
        "never grant authority"
        in schema_properties["required_provider_capability_tags"]["description"]
    )


@pytest.mark.unit
def test_generated_mesh_models_and_defaults_include_transition_fields() -> None:
    defaults = json.loads(DEFAULTS_PATH.read_text())
    default_tts = defaults["services"]["tts"]

    assert default_tts["mesh_sharing"] == TRANSITIONAL_MESH_SHARING_FIELDS
    assert default_tts["mesh_routing"] == MESH_ROUTING_FIELDS
    assert list(MeshSharing.model_fields) == list(TRANSITIONAL_MESH_SHARING_FIELDS)
    assert list(MeshRouting.model_fields) == list(MESH_ROUTING_FIELDS)
    assert MeshSharing().required_capabilities == []
    assert MeshSharing().require_explicit_selector is False
    assert MeshSharing().unshared_feature_ids == []
    assert MeshSharing().unshared_method_ids == []
    assert MeshRouting().required_provider_feature_ids == []
    assert MeshRouting().required_provider_capability_tags == []
    assert MeshRouting().require_explicit_selector is False


@pytest.mark.unit
def test_generated_config_keys_include_mesh_sharing_and_routing_leaf_paths() -> None:
    sharing_keys = ConfigKeys.services.tts.mesh_sharing
    routing_keys = ConfigKeys.services.tts.mesh_routing

    assert sharing_keys.allowed_peers == "services.tts.mesh_sharing.allowed_peers"
    assert sharing_keys.min_version == "services.tts.mesh_sharing.min_version"
    assert (
        sharing_keys.require_explicit_selector
        == "services.tts.mesh_sharing.require_explicit_selector"
    )
    assert sharing_keys.required_capabilities == "services.tts.mesh_sharing.required_capabilities"
    assert sharing_keys.unshared_feature_ids == "services.tts.mesh_sharing.unshared_feature_ids"
    assert sharing_keys.unshared_method_ids == "services.tts.mesh_sharing.unshared_method_ids"
    assert routing_keys.prefer == "services.tts.mesh_routing.prefer"
    assert routing_keys.fallback == "services.tts.mesh_routing.fallback"
    assert (
        routing_keys.allowed_provider_peer_ids
        == "services.tts.mesh_routing.allowed_provider_peer_ids"
    )
    assert (
        routing_keys.required_provider_feature_ids
        == "services.tts.mesh_routing.required_provider_feature_ids"
    )
    assert (
        routing_keys.required_provider_capability_tags
        == "services.tts.mesh_routing.required_provider_capability_tags"
    )


@pytest.mark.unit
def test_all_mesh_shareable_services_expose_complete_transition_artifacts() -> None:
    defaults = json.loads(DEFAULTS_PATH.read_text())["services"]

    for path in MESH_SHAREABLE_SERVICE_PATHS:
        default_node = defaults
        key_node = ConfigKeys.services
        for part in path:
            default_node = default_node[part]
            key_node = getattr(key_node, part)

        assert default_node["mesh_sharing"] == TRANSITIONAL_MESH_SHARING_FIELDS
        assert default_node["mesh_routing"] == MESH_ROUTING_FIELDS

        sharing_keys = key_node.mesh_sharing
        for field_name in TRANSITIONAL_MESH_SHARING_FIELDS:
            expected_path = f"services.{'.'.join(path)}.mesh_sharing.{field_name}"
            assert getattr(sharing_keys, field_name) == expected_path

        routing_keys = key_node.mesh_routing
        for field_name in MESH_ROUTING_FIELDS:
            expected_path = f"services.{'.'.join(path)}.mesh_routing.{field_name}"
            assert getattr(routing_keys, field_name) == expected_path


@pytest.mark.unit
def test_mesh_routing_null_and_empty_provider_lists_remain_distinct() -> None:
    null_routing = MeshRouting(allowed_provider_peer_ids=None).model_dump()
    deny_all_routing = MeshRouting(allowed_provider_peer_ids=[]).model_dump()
    narrowed_routing = MeshRouting(allowed_provider_peer_ids=["peer-a"]).model_dump()

    assert null_routing["allowed_provider_peer_ids"] is None
    assert deny_all_routing["allowed_provider_peer_ids"] == []
    assert narrowed_routing["allowed_provider_peer_ids"] == ["peer-a"]


@pytest.mark.unit
def test_mesh_sharing_subtractive_ids_retain_unknown_or_stale_values() -> None:
    sharing = MeshSharing(
        unshared_feature_ids=["stable-feature", "removed-feature"],
        unshared_method_ids=["TTS.Request", "Removed.Topic"],
    )

    assert sharing.model_dump()["unshared_feature_ids"] == [
        "stable-feature",
        "removed-feature",
    ]
    assert sharing.model_dump()["unshared_method_ids"] == ["TTS.Request", "Removed.Topic"]


@pytest.mark.unit
def test_legacy_only_raw_config_remains_backward_readable() -> None:
    legacy_values = {
        "share": True,
        "max_concurrent": 3,
        "allowed_peers": ["peer-a", "peer-b"],
        "prefer": "network",
        "fallback": "error",
        "min_version": "1.2.3",
        "required_capabilities": ["tts"],
        "require_explicit_selector": True,
    }

    config = Model.model_validate({"services": {"tts": {"mesh_sharing": legacy_values}}})
    tts = config.services.tts

    assert tts.mesh_routing is None
    for field_name, expected in legacy_values.items():
        assert getattr(tts.mesh_sharing, field_name) == expected
    assert tts.mesh_sharing.unshared_feature_ids == []
    assert tts.mesh_sharing.unshared_method_ids == []


@pytest.mark.unit
def test_auth_and_config_do_not_advertise_mesh_sharing_or_mesh_routing() -> None:
    schema = json.loads(SCHEMA_PATH.read_text())
    services = schema["properties"]["services"]["properties"]
    defaults = json.loads(DEFAULTS_PATH.read_text())["services"]

    assert "mesh_sharing" not in services["auth"]["properties"]
    assert "mesh_sharing" not in services["config"]["properties"]
    assert "mesh_routing" not in services["auth"]["properties"]
    assert "mesh_routing" not in services["config"]["properties"]
    assert "mesh_sharing" not in defaults["auth"]
    assert "mesh_sharing" not in defaults["config"]
    assert "mesh_routing" not in defaults["auth"]
    assert "mesh_routing" not in defaults["config"]
    assert not hasattr(ConfigKeys.services.auth, "mesh_sharing")
    assert not hasattr(ConfigKeys.services.config, "mesh_sharing")
    assert not hasattr(ConfigKeys.services.auth, "mesh_routing")
    assert not hasattr(ConfigKeys.services.config, "mesh_routing")
