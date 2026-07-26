"""Validation contract for the checked mesh security-surface inventory."""

from __future__ import annotations

import ast
import json
from pathlib import Path

from jsonschema import Draft202012Validator

from app.shared.contracts.mesh_surface import (
    CALLABLE_FEATURES,
    MESH_CAPABLE_MODULES,
    all_callable_method_topics,
    validate_taxonomy,
)
from scripts.generate_mesh_security_surface_inventory import (
    INVENTORY_PATH as GENERATOR_INVENTORY_PATH,
    build_inventory,
    main as generate_mesh_inventory_main,
    render_inventory,
)

ROOT = Path(__file__).resolve().parents[3]
INVENTORY_PATH = ROOT / "docs/security/mesh-security-surface-inventory.json"
SCHEMA_PATH = ROOT / "docs/security/mesh-security-surface-inventory.schema.json"

EXPECTED_METHOD_COUNT = 80
EXPECTED_PERMISSIONLESS_METHOD_COUNT = 0
EXPECTED_MESH_PUBLISHER_COUNT = 0
EXPECTED_PERMISSIONLESS_TOPICS: set[str] = set()
EXPECTED_METHOD_COUNTS_BY_MODULE = {
    "DB": 11,
    "Orchestrator": 13,
    "Scheduler": 6,
    "STTCoordinator": 2,
    "TTS": 5,
    "Tooling": 39,
    "Transcription": 2,
    "WakeWord": 2,
}
EXPECTED_FEATURE_IDS_BY_MODULE = {
    module: {feature.feature_id for feature in CALLABLE_FEATURES if feature.module == module}
    for module in MESH_CAPABLE_MODULES
}
EXPECTED_TOOLING_SELECTOR_FIELDS = {
    "caller_device_id",
    "caller_peer_id",
    "caller_permissions",
    "caller_principal_id",
    "data_scope",
    "execution_location",
    "global_tool_id",
    "hardware_target",
    "operation_class",
    "provider_peer_id",
    "provider_service_instance_id",
    "resource_namespace",
    "route_privacy_class",
    "safety_class",
    "source_type",
    "tool_name",
    "toolkit_name",
}
EXPECTED_STABLE_IDENTITY_FIELDS = {
    "approval_grant_tool_key",
    "authenticated_peer_id",
    "bindable_tool_name",
    "global_tool_id",
    "local_core_source_id",
    "local_rag_tool_key",
    "mcp_source_id",
    "plugin_source_id",
    "provider_service_instance_id",
    "remote_catalog_snapshot_key",
    "remote_source_id",
    "share_group_id",
    "tool_contract_id",
}

EXPECTED_REPAIRED_PERMISSIONS = {
    "DB.GetMessages": ["DB.GetMessages"],
    "DB.GetMessagesForDate": ["DB.GetMessagesForDate"],
    "Tooling.GetMCPStatus": ["Tooling.GetMCPStatus"],
    "Tooling.GetStats": ["Tooling.GetStats"],
    "Tooling.GetToolByName": ["Tooling.GetTools"],
    "Tooling.GetToolCatalog": ["Tooling.GetTools"],
    "Tooling.GetTools": ["Tooling.GetTools"],
    "Transcription.ProcessAudio": ["Transcription.ProcessAudio"],
    "Transcription.Transcribe": ["Transcription.Transcribe"],
    "WakeWord.Detect": ["WakeWord.Detect"],
    "WakeWord.ProcessAudio": ["WakeWord.ProcessAudio"],
}


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_mesh_security_inventory_and_schema_are_valid_json_documents():
    """The checked inventory remains machine-valid."""

    schema = _load_json(SCHEMA_PATH)
    inventory = _load_json(INVENTORY_PATH)

    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(inventory)


def test_mesh_security_inventory_matches_dedicated_generator():
    """The checked JSON is reproducible by the canonical generator command."""

    assert GENERATOR_INVENTORY_PATH == INVENTORY_PATH
    assert INVENTORY_PATH.read_text(encoding="utf-8") == render_inventory(build_inventory())


def test_mesh_security_inventory_check_mode_detects_drift(tmp_path, capsys):
    """--check fails with an actionable regeneration message when inventory drifts."""

    drifted = tmp_path / "mesh-security-surface-inventory.json"
    drifted.write_text(
        INVENTORY_PATH.read_text(encoding="utf-8").replace(
            '"inventory_status": "complete"', '"inventory_status": "scaffold"', 1
        ),
        encoding="utf-8",
    )

    assert generate_mesh_inventory_main(["--check", "--output", str(drifted)]) == 1
    captured = capsys.readouterr()
    assert "is out of date" in captured.err
    assert "uv run python scripts/generate_mesh_security_surface_inventory.py" in captured.err


def test_mesh_security_inventory_domain_invariants():
    """A completed inventory is exhaustive, canonical, and remediation-owned."""

    inventory = _load_json(INVENTORY_PATH)
    methods = inventory["methods"]
    publishers = inventory["mesh_publishers"]
    selectors = inventory["tooling_rule_selectors"]["selectors"]
    identities = inventory["stable_identity"]

    method_topics = [method["bus_topic"] for method in methods]
    assert len(method_topics) == len(set(method_topics))
    for method in methods:
        assert method["bus_topic"].startswith(f"{method['module']}.")
        assert bool(method["required_perms"]) is (method["permission_status"] == "protected")
        _assert_source_exists(method["source"])
        assert _decorator_callable_feature_ids(method) == [method["proposed_feature_id"]]

    publisher_sites = [
        (publisher["source"]["file"], publisher["source"]["line"]) for publisher in publishers
    ]
    assert len(publisher_sites) == len(set(publisher_sites))
    for publisher in publishers:
        _assert_source_exists(publisher["source"])
        if not publisher["safe_for_service_wide_broadcast"]:
            assert publisher["remediation_goal"] in {"G007", "G013"} or publisher["blocker_reason"]

    selector_fields = [selector["field"] for selector in selectors]
    assert len(selector_fields) == len(set(selector_fields))
    identity_fields = [identity["field"] for identity in identities]
    assert len(identity_fields) == len(set(identity_fields))
    for identity in identities:
        _assert_source_exists(identity["source"])

    if inventory["inventory_status"] == "scaffold":
        assert not methods
        assert not publishers
        assert not selectors
        assert not identities
        return

    assert inventory["inventory_status"] == "complete"
    assert not validate_taxonomy()
    assert len(methods) == EXPECTED_METHOD_COUNT
    assert len(publishers) == EXPECTED_MESH_PUBLISHER_COUNT
    method_sites = {(method["source"]["file"], method["source"]["line"]) for method in methods}
    assert method_sites == _external_method_contract_sites(
        {method["source"]["file"] for method in methods}
    )
    assert publisher_sites == []
    assert set(publisher_sites) == _mesh_publish_call_sites()
    assert (
        sum(method["permission_status"] == "ordinary_permissionless" for method in methods)
        == EXPECTED_PERMISSIONLESS_METHOD_COUNT
    )
    assert {
        method["bus_topic"]
        for method in methods
        if method["permission_status"] == "ordinary_permissionless"
    } == EXPECTED_PERMISSIONLESS_TOPICS
    methods_by_topic = {method["bus_topic"]: method for method in methods}
    assert {
        topic: methods_by_topic[topic]["required_perms"] for topic in EXPECTED_REPAIRED_PERMISSIONS
    } == EXPECTED_REPAIRED_PERMISSIONS
    assert set(inventory["mesh_capable_modules"]) == {method["module"] for method in methods}
    assert set(inventory["mesh_capable_modules"]) == set(MESH_CAPABLE_MODULES)
    assert set(method_topics) == set(all_callable_method_topics())
    assert {
        module: sum(method["module"] == module for method in methods)
        for module in inventory["mesh_capable_modules"]
    } == EXPECTED_METHOD_COUNTS_BY_MODULE
    assert {
        module: {method["proposed_feature_id"] for method in methods if method["module"] == module}
        for module in inventory["mesh_capable_modules"]
    } == EXPECTED_FEATURE_IDS_BY_MODULE
    methods_by_feature = {
        (module, feature_id): {
            method["bus_topic"]
            for method in methods
            if method["module"] == module and method["proposed_feature_id"] == feature_id
        }
        for module in inventory["mesh_capable_modules"]
        for feature_id in EXPECTED_FEATURE_IDS_BY_MODULE[module]
    }
    assert methods_by_feature == {
        (feature.module, feature.feature_id): set(feature.method_ids)
        for feature in CALLABLE_FEATURES
    }
    assert set(selector_fields) == EXPECTED_TOOLING_SELECTOR_FIELDS
    assert set(identity_fields) == EXPECTED_STABLE_IDENTITY_FIELDS
    assert all(identity["gaps"] for identity in identities)
    assert inventory["tooling_rule_selectors"]["matching_semantics"] == (
        "non_null_conjunctive_exact_match"
    )
    assert inventory["tooling_rule_selectors"]["precedence"] == "first_match_wins"

    selectors_by_field = {selector["field"]: selector for selector in selectors}
    assert (
        "never_matches_when_non_null" in selectors_by_field["caller_permissions"]["match_semantics"]
    )
    assert (
        "missing_from_schema_generated_config_enum"
        in selectors_by_field["source_type"]["match_semantics"]
    )

    identities_by_field = {identity["field"]: identity for identity in identities}
    assert identities_by_field["global_tool_id"]["stable"] is True
    assert identities_by_field["tool_contract_id"]["stable"] is True
    assert identities_by_field["share_group_id"]["stable"] is True
    assert identities_by_field["mcp_source_id"]["stable"] is True
    assert "aurora-tool:v1" in identities_by_field["global_tool_id"]["derivation"]
    assert (
        "routing instance"
        in identities_by_field["provider_service_instance_id"]["derivation"].lower()
    )

    assert publishers == []


def _assert_source_exists(source: dict) -> None:
    source_path = ROOT / source["file"]
    assert source_path.is_file(), source_path
    assert source["line"] <= len(source_path.read_text(encoding="utf-8").splitlines())


def _decorator_callable_feature_ids(method: dict) -> list[str]:
    tree = ast.parse((ROOT / method["source"]["file"]).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name != method["handler"]:
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call):
                continue
            if not isinstance(decorator.func, ast.Name) or decorator.func.id != "method_contract":
                continue
            for keyword in decorator.keywords:
                if keyword.arg == "callable_feature_ids":
                    return ast.literal_eval(keyword.value)
    return []


def _external_method_contract_sites(source_files: set[str]) -> set[tuple[str, int]]:
    sites: set[tuple[str, int]] = set()
    for source_file in source_files:
        tree = ast.parse((ROOT / source_file).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call):
                    continue
                if (
                    not isinstance(decorator.func, ast.Name)
                    or decorator.func.id != "method_contract"
                ):
                    continue
                exposure = next(
                    (keyword.value for keyword in decorator.keywords if keyword.arg == "exposure"),
                    None,
                )
                if isinstance(exposure, ast.Constant) and exposure.value in {"external", "both"}:
                    sites.add((source_file, decorator.lineno))
    return sites


def _mesh_publish_call_sites() -> set[tuple[str, int]]:
    sites: set[tuple[str, int]] = set()
    for source_path in (ROOT / "app").rglob("*.py"):
        source_file = str(source_path.relative_to(ROOT))
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if any(
                keyword.arg == "mesh"
                and isinstance(keyword.value, ast.Constant)
                and keyword.value.value is True
                for keyword in node.keywords
            ):
                sites.add((source_file, node.lineno))
    return sites
