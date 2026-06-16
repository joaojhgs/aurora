"""Parity tests for generated mesh sharing configuration artifacts."""

import json
from pathlib import Path

import pytest

from app.services.gateway.config import MeshServiceConfig
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import MeshSharing

ROOT = Path(__file__).resolve().parents[4]
SCHEMA_PATH = ROOT / "app/services/config/config_schema.json"
DEFAULTS_PATH = ROOT / "app/services/config/config_defaults.json"

MESH_POLICY_FIELDS = {
    "share": False,
    "max_concurrent": 10,
    "allowed_peers": None,
    "prefer": "local",
    "fallback": "local",
    "min_version": None,
    "required_capabilities": [],
}


@pytest.mark.unit
def test_mesh_sharing_schema_matches_runtime_policy_fields() -> None:
    schema = json.loads(SCHEMA_PATH.read_text())
    schema_properties = schema["$defs"]["mesh_sharing"]["properties"]

    assert set(MESH_POLICY_FIELDS) <= set(schema_properties)
    assert set(MESH_POLICY_FIELDS) <= set(MeshServiceConfig.model_fields)

    for field_name, default in MESH_POLICY_FIELDS.items():
        assert schema_properties[field_name]["default"] == default


@pytest.mark.unit
def test_generated_mesh_sharing_model_and_defaults_include_policy_fields() -> None:
    defaults = json.loads(DEFAULTS_PATH.read_text())
    default_mesh_sharing = defaults["services"]["tts"]["mesh_sharing"]

    assert default_mesh_sharing == MESH_POLICY_FIELDS
    assert set(MESH_POLICY_FIELDS) <= set(MeshSharing.model_fields)
    assert MeshSharing().required_capabilities == []


@pytest.mark.unit
def test_generated_config_keys_include_mesh_policy_leaf_paths() -> None:
    mesh_keys = ConfigKeys.services.tts.mesh_sharing

    assert mesh_keys.allowed_peers == "services.tts.mesh_sharing.allowed_peers"
    assert mesh_keys.min_version == "services.tts.mesh_sharing.min_version"
    assert (
        mesh_keys.required_capabilities
        == "services.tts.mesh_sharing.required_capabilities"
    )
