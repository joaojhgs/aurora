from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from app.services.config.mesh_policy_migration import (
    MESH_SERVICE_PATHS,
    build_rbac_preflight_report,
    bytes_sha256,
    content_sha256,
    create_secure_migration_artifacts,
    create_tooling_downgrade_receipt,
    load_rbac_preflight_report,
    migrate_mesh_service_policies,
    persist_rbac_preflight_report,
    preflight_tooling_downgrade_start,
    reverse_migrate_service_policy,
    synchronize_legacy_mirrors,
)


def test_tooling_downgrade_receipt_preflight_missing_tampered_and_idempotent(tmp_path) -> None:
    snapshot = _tooling_export_snapshot(
        mesh_switches={
            "provider_mesh_tooling_enabled": False,
            "consumer_mesh_tooling_enabled": False,
        }
    )
    config = reverse_migrate_service_policy(
        migrate_mesh_service_policies(_minimal_config()).config,
        tooling_export_snapshot=snapshot,
    ).config
    output = tmp_path / "legacy.json"

    missing = preflight_tooling_downgrade_start(
        output_config=config,
        output_file=str(output),
        tooling_export_snapshot=snapshot,
    )
    assert not missing.ok and missing.reason == "unsafe_downgrade_blocked"

    first = create_tooling_downgrade_receipt(
        output_config=config,
        output_file=str(output),
        tooling_export_snapshot=snapshot,
    )
    second = create_tooling_downgrade_receipt(
        output_config=config,
        output_file=str(output),
        tooling_export_snapshot=snapshot,
    )
    assert first == second and first.stat().st_mode & 0o777 == 0o600
    assert preflight_tooling_downgrade_start(
        output_config=config,
        output_file=str(output),
        tooling_export_snapshot=snapshot,
    ).ok

    tampered = json.loads(first.read_text())
    tampered["snapshot_sha256"] = "0" * 64
    first.write_text(json.dumps(tampered))
    first.chmod(0o600)
    assert not preflight_tooling_downgrade_start(
        output_config=config,
        output_file=str(output),
        tooling_export_snapshot=snapshot,
    ).ok


def test_tooling_downgrade_receipt_refuses_enabled_switches(tmp_path) -> None:
    snapshot = _tooling_export_snapshot()
    config = reverse_migrate_service_policy(
        migrate_mesh_service_policies(_minimal_config()).config,
        tooling_export_snapshot=snapshot,
    ).config
    with pytest.raises(RuntimeError, match="both Tooling mesh switches"):
        create_tooling_downgrade_receipt(
            output_config=config,
            output_file=str(tmp_path / "legacy.json"),
            tooling_export_snapshot=snapshot,
        )


def _minimal_config() -> dict:
    services: dict = {}
    for path in MESH_SERVICE_PATHS:
        ref = services
        parts = path.split(".")[1:]
        for part in parts[:-1]:
            ref = ref.setdefault(part, {})
        ref[parts[-1]] = {
            "mesh_sharing": {
                "share": True,
                "max_concurrent": 3,
                "allowed_peers": ["peer-a"],
                "prefer": "network",
                "fallback": "error",
                "min_version": "1.2.3",
                "required_capabilities": ["gpu"],
                "require_explicit_selector": True,
                "legacy_unknown": "kept",
            },
            "unknown_service_key": "kept",
        }
    return {"services": services, "unknown_root": "kept"}


def test_forward_migrates_all_services_and_preserves_exact_allowlist_semantics() -> None:
    config = _minimal_config()
    states = [None, [], ["peer-z"]]
    for index, path in enumerate(MESH_SERVICE_PATHS[:3]):
        sharing = _lookup(config, f"{path}.mesh_sharing")
        sharing["allowed_peers"] = states[index]

    result = migrate_mesh_service_policies(config)

    assert set(result.migrated_services) == {
        p.removeprefix("services.") for p in MESH_SERVICE_PATHS
    }
    assert result.config["unknown_root"] == "kept"
    for path in MESH_SERVICE_PATHS:
        sharing = _lookup(result.config, f"{path}.mesh_sharing")
        routing = _lookup(result.config, f"{path}.mesh_routing")
        assert routing["allowed_provider_peer_ids"] == sharing["allowed_peers"]
        assert routing["prefer"] == "network"
        assert routing["fallback"] == "error"
        assert routing["min_version"] == "1.2.3"
        assert routing["required_provider_capability_tags"] == ["gpu"]
        assert routing["required_provider_feature_ids"] == []
        assert sharing["unshared_feature_ids"] == []
        assert sharing["unshared_method_ids"] == []
        assert sharing["share"] is True
        assert sharing["max_concurrent"] == 3
        assert sharing["legacy_unknown"] == "kept"


def test_v2_conflicts_win_and_rewrite_legacy_mirrors() -> None:
    config = _minimal_config()
    sharing = _lookup(config, "services.tts.mesh_sharing")
    _lookup(config, "services.tts")["mesh_routing"] = {
        "allowed_provider_peer_ids": [],
        "prefer": "local_only",
        "fallback": "none",
        "required_provider_capability_tags": [],
        "required_provider_feature_ids": ["speech"],
    }

    result = migrate_mesh_service_policies(config)

    sharing = _lookup(result.config, "services.tts.mesh_sharing")
    assert result.conflict_count >= 4
    assert sharing["allowed_peers"] == []
    assert sharing["prefer"] == "local_only"
    assert sharing["fallback"] == "none"
    assert sharing["required_capabilities"] == []
    assert _lookup(result.config, "services.tts.mesh_routing.required_provider_feature_ids") == [
        "speech"
    ]


def test_synchronize_legacy_and_v2_write_shapes() -> None:
    config = migrate_mesh_service_policies(_minimal_config()).config

    legacy_candidate = json.loads(json.dumps(config))
    _lookup(legacy_candidate, "services.tts.mesh_sharing")["allowed_peers"] = []
    synced = synchronize_legacy_mirrors(
        legacy_candidate,
        ["services.tts.mesh_sharing.allowed_peers"],
    ).config
    assert _lookup(synced, "services.tts.mesh_routing.allowed_provider_peer_ids") == []

    v2_candidate = json.loads(json.dumps(config))
    _lookup(v2_candidate, "services.tts.mesh_routing")["allowed_provider_peer_ids"] = ["peer-new"]
    synced = synchronize_legacy_mirrors(
        v2_candidate,
        ["services.tts.mesh_routing.allowed_provider_peer_ids"],
    ).config
    assert _lookup(synced, "services.tts.mesh_sharing.allowed_peers") == ["peer-new"]

    conflict_candidate = json.loads(json.dumps(config))
    _lookup(conflict_candidate, "services.tts.mesh_sharing")["prefer"] = "local"
    _lookup(conflict_candidate, "services.tts.mesh_routing")["prefer"] = "network_only"
    synced = synchronize_legacy_mirrors(
        conflict_candidate,
        ["services.tts.mesh_sharing.prefer", "services.tts.mesh_routing.prefer"],
    ).config
    assert _lookup(synced, "services.tts.mesh_sharing.prefer") == "network_only"


def test_synchronize_only_touched_mirror_field_and_block_replacement_defaults() -> None:
    config = migrate_mesh_service_policies(_minimal_config()).config
    _lookup(config, "services.tts.mesh_sharing")["allowed_peers"] = ["legacy-peer"]
    _lookup(config, "services.tts.mesh_routing")["allowed_provider_peer_ids"] = ["v2-peer"]
    _lookup(config, "services.tts.mesh_routing")["prefer"] = "network"

    leaf_candidate = json.loads(json.dumps(config))
    _lookup(leaf_candidate, "services.tts.mesh_sharing")["allowed_peers"] = ["legacy-new"]
    synced = synchronize_legacy_mirrors(
        leaf_candidate,
        ["services.tts.mesh_sharing.allowed_peers"],
    ).config

    assert _lookup(synced, "services.tts.mesh_routing.allowed_provider_peer_ids") == ["legacy-new"]
    assert _lookup(synced, "services.tts.mesh_routing.prefer") == "network"

    block_candidate = json.loads(json.dumps(config))
    _lookup(block_candidate, "services.tts")["mesh_sharing"] = {
        "share": True,
        "allowed_peers": ["replacement"],
        "prefer": "local",
        "fallback": "local",
        "min_version": None,
        "required_capabilities": [],
        "require_explicit_selector": False,
        "unshared_feature_ids": [],
        "unshared_method_ids": [],
    }
    synced = synchronize_legacy_mirrors(
        block_candidate,
        ["services.tts.mesh_sharing"],
    ).config
    assert _lookup(synced, "services.tts.mesh_routing.allowed_provider_peer_ids") == ["replacement"]
    assert _lookup(synced, "services.tts.mesh_routing.prefer") == "local"


def test_synchronize_does_not_report_unchanged_derived_mirror_path() -> None:
    config = migrate_mesh_service_policies(_minimal_config()).config
    candidate = json.loads(json.dumps(config))

    result = synchronize_legacy_mirrors(
        candidate,
        ["services.tts.mesh_routing.prefer"],
    )

    assert _lookup(result.config, "services.tts.mesh_sharing.prefer") == "network"
    assert "services.tts.mesh_sharing.prefer" not in result.effective_paths


def test_rbac_preflight_reports_empty_populated_and_incomplete_without_mutation() -> None:
    config = migrate_mesh_service_policies(_minimal_config()).config
    _lookup(config, "services.tts.mesh_sharing")["allowed_peers"] = []
    _lookup(config, "services.db.mesh_sharing")["allowed_peers"] = ["peer-allowed"]
    peers = [
        {
            "peer_id": "peer-blocked",
            "outbound_status": "approved",
            "outbound_permissions": ["tts.use", "db.*"],
        },
        {
            "peer_id": "peer-pending",
            "outbound_status": "pending",
            "outbound_permissions": ["*"],
        },
    ]

    report = build_rbac_preflight_report(config, peers=peers, inventory_complete=True)

    by_service = {entry["service"]: entry for entry in report["services"]}
    assert by_service["tts"]["blocking_peer_ids"] == ["peer-blocked"]
    assert by_service["db"]["blocking_peer_ids"] == ["peer-blocked"]
    assert report["release_blocking"] is True
    assert report["legacy_allowlist_evidence"] == {}

    incomplete = build_rbac_preflight_report(config, peers=None, inventory_complete=False)
    assert incomplete["release_blocking"] is True


def test_rbac_preflight_exact_service_grant_reaches_empty_legacy_allowlist() -> None:
    config = migrate_mesh_service_policies(_minimal_config()).config
    _lookup(config, "services.tts.mesh_sharing")["allowed_peers"] = []
    _lookup(config, "services.tts.mesh_sharing")["share"] = True

    report = build_rbac_preflight_report(
        config,
        peers=[
            {
                "peer_id": "peer-with-exact-grant",
                "outbound_status": "approved",
                "outbound_permissions": ["TTS.Synthesize"],
            }
        ],
        inventory_complete=True,
    )

    by_service = {entry["service"]: entry for entry in report["services"]}
    assert by_service["tts"]["severity"] == "release_blocking"
    assert by_service["tts"]["blocking_peer_ids"] == ["peer-with-exact-grant"]
    assert report["release_blocking"] is True

    _lookup(config, "services.tts.mesh_sharing")["share"] = False
    nonblocking = build_rbac_preflight_report(
        config,
        peers=[
            {
                "peer_id": "peer-with-exact-grant",
                "outbound_status": "approved",
                "outbound_permissions": ["TTS.Synthesize"],
            }
        ],
        inventory_complete=True,
    )
    by_service = {entry["service"]: entry for entry in nonblocking["services"]}
    assert by_service["tts"]["severity"] == "informational"
    assert by_service["tts"]["blocking_peer_ids"] == []
    assert nonblocking["release_blocking"] is False


def test_preflight_uses_original_allowlist_evidence_and_share_false_is_nonblocking() -> None:
    config = _minimal_config()
    _lookup(config, "services.tts.mesh_sharing")["allowed_peers"] = ["legacy-peer"]
    _lookup(config, "services.tts")["mesh_routing"] = {"allowed_provider_peer_ids": []}
    migration = migrate_mesh_service_policies(config)

    report = build_rbac_preflight_report(
        migration.config,
        peers=None,
        inventory_complete=False,
        legacy_allowlist_evidence=migration.legacy_allowlist_evidence,
    )
    by_service = {entry["service"]: entry for entry in report["services"]}
    assert by_service["tts"]["allowlist_state"] == "populated"
    assert report["legacy_allowlist_evidence"]["tts"] == ["legacy-peer"]

    for path in MESH_SERVICE_PATHS:
        _lookup(migration.config, f"{path}.mesh_sharing")["share"] = False
    report = build_rbac_preflight_report(
        migration.config,
        peers=[
            {
                "peer_id": "peer-blocked",
                "outbound_status": "approved",
                "outbound_permissions": ["*"],
            }
        ],
        inventory_complete=True,
    )
    assert report["release_blocking"] is False
    assert {entry["severity"] for entry in report["services"]} == {"informational"}
    assert all(entry["blocking_peer_ids"] == [] for entry in report["services"])


def test_reverse_migration_refuses_or_fails_closed_for_unrepresentable_policy() -> None:
    config = migrate_mesh_service_policies(_minimal_config()).config
    _lookup(config, "services.tts.mesh_sharing")["unshared_method_ids"] = ["TTS.Stop"]
    _lookup(config, "services.tts.mesh_routing")["required_provider_feature_ids"] = ["speech"]

    refused = reverse_migrate_service_policy(config)
    assert refused.refused_reasons

    converted = reverse_migrate_service_policy(
        config,
        fail_closed_required_provider_features=True,
    )
    sharing = _lookup(converted.config, "services.tts.mesh_sharing")
    assert sharing["share"] is False
    assert sharing["prefer"] == "local_only"
    assert sharing["fallback"] == "error"
    assert "mesh_routing" not in converted.config["services"]["tts"]
    assert "unshared_method_ids" not in sharing
    assert "tts" in converted.changed_services


def _tooling_export_snapshot(**overrides: object) -> dict:
    snapshot = {
        "policy": {
            "default_state": "shared",
            "revision": 3,
            "initialized": True,
            "migrated_from_legacy": True,
        },
        "rules": [],
        "stale_tool_ids": [],
        "stale_group_ids": [],
        "mesh_switches": {
            "provider_mesh_tooling_enabled": True,
            "consumer_mesh_tooling_enabled": True,
            "revision": 0,
        },
        "secrets_redacted": True,
    }
    snapshot.update(overrides)
    return snapshot


def test_tooling_export_reverse_migration_maps_only_representable_global_default() -> None:
    config = migrate_mesh_service_policies(_minimal_config()).config

    shared = reverse_migrate_service_policy(
        config,
        tooling_export_snapshot=_tooling_export_snapshot(),
    )
    assert shared.tooling_export_fail_closed is False
    assert shared.tooling_mesh_switches_must_disable == []
    assert _lookup(shared.config, "services.tooling.mesh_sharing.share") is True
    assert _lookup(shared.config, "services.tooling.approval_policy.default_share") is True

    unshared_snapshot = _tooling_export_snapshot()
    unshared_snapshot["policy"]["default_state"] = "unshared"
    unshared = reverse_migrate_service_policy(
        config,
        tooling_export_snapshot=unshared_snapshot,
    )
    assert unshared.tooling_export_fail_closed is False
    assert _lookup(unshared.config, "services.tooling.mesh_sharing.share") is False
    assert _lookup(unshared.config, "services.tooling.approval_policy.default_share") is False


def test_tooling_export_reverse_migration_unshared_disables_retained_allow_rules() -> None:
    config = migrate_mesh_service_policies(_minimal_config()).config
    approval = _lookup(config, "services.tooling").setdefault("approval_policy", {})
    approval["rules"] = [
        {
            "rule_id": "existing-allow",
            "share": True,
            "approval_mode": "ask_each_time",
            "peer_id": "peer-a",
        }
    ]
    snapshot = _tooling_export_snapshot()
    snapshot["policy"]["default_state"] = "unshared"

    result = reverse_migrate_service_policy(config, tooling_export_snapshot=snapshot)

    assert result.tooling_export_fail_closed is False
    assert _lookup(result.config, "services.tooling.approval_policy.rules") == [
        {
            "rule_id": "existing-allow",
            "share": False,
            "approval_mode": "ask_each_time",
            "peer_id": "peer-a",
        }
    ]


def test_reverse_cli_requires_redacted_tooling_export_snapshot(tmp_path) -> None:
    input_path = tmp_path / "config.json"
    output_path = tmp_path / "legacy.json"
    input_path.write_text(json.dumps(_minimal_config()))

    completed = subprocess.run(
        [
            sys.executable,
            "scripts/migrate_mesh_service_config.py",
            str(input_path),
            "--reverse",
            "--output",
            str(output_path),
        ],
        cwd=os.getcwd(),
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 2
    assert "--reverse requires --tooling-export-snapshot" in completed.stderr
    assert not output_path.exists()


@pytest.mark.parametrize(
    "snapshot",
    [
        _tooling_export_snapshot(
            rules=[
                {
                    "rule_id": "peer-tool",
                    "peer_id": "peer-a",
                    "scope_type": "tool",
                    "scope_id": "aurora-tool:v1:peer:Tooling:t",
                    "state": "shared",
                }
            ]
        ),
        _tooling_export_snapshot(stale_group_ids=["removed-group"]),
        _tooling_export_snapshot(
            mesh_switches={
                "provider_mesh_tooling_enabled": True,
                "consumer_mesh_tooling_enabled": False,
            }
        ),
        _tooling_export_snapshot(policy={"default_state": "shared", "initialized": False}),
    ],
)
def test_tooling_export_reverse_migration_fails_closed_without_deleting_snapshot(
    snapshot: dict,
) -> None:
    config = migrate_mesh_service_policies(_minimal_config()).config
    approval = _lookup(config, "services.tooling").setdefault("approval_policy", {})
    approval["default_share"] = True
    approval["rules"] = [{"rule_id": "existing", "share": True, "approval_mode": "ask_each_time"}]
    original_snapshot = json.loads(json.dumps(snapshot))

    result = reverse_migrate_service_policy(config, tooling_export_snapshot=snapshot)

    assert result.tooling_export_fail_closed is True
    assert result.refused_reasons == []
    assert result.tooling_export_reasons
    assert result.tooling_mesh_switches_must_disable == [
        "provider_mesh_tooling_enabled",
        "consumer_mesh_tooling_enabled",
    ]
    assert _lookup(result.config, "services.tooling.mesh_sharing.share") is False
    downgraded_approval = _lookup(result.config, "services.tooling.approval_policy")
    assert downgraded_approval["default_share"] is False
    assert downgraded_approval["rules"] == [
        {"rule_id": "existing", "share": False, "approval_mode": "ask_each_time"}
    ]
    assert snapshot == original_snapshot


def test_tooling_export_reverse_migration_adds_deterministic_deny_all() -> None:
    config = migrate_mesh_service_policies(_minimal_config()).config
    _lookup(config, "services.tooling")["approval_policy"] = {"rules": []}
    snapshot = _tooling_export_snapshot(rules=None)

    result = reverse_migrate_service_policy(config, tooling_export_snapshot=snapshot)

    assert _lookup(result.config, "services.tooling.approval_policy.rules") == [
        {
            "rule_id": "downgrade-tooling-export-deny-all",
            "share": False,
            "approval_mode": "deny_all",
        }
    ]


def test_secure_artifacts_are_exact_idempotent_and_reject_insecure_reuse(tmp_path) -> None:
    config_file = tmp_path / "config.json"
    original_bytes = b'{\n  "services": {"tts": {"mesh_sharing": {"allowed_peers": []}}}\n}\n'
    original = {"services": {"tts": {"mesh_sharing": {"allowed_peers": []}}}}
    migrated = {"services": {"tts": {"mesh_sharing": {"allowed_peers": []}, "mesh_routing": {}}}}
    config_file.write_bytes(original_bytes)

    backup, receipt = create_secure_migration_artifacts(
        original_config=original,
        migrated_config=migrated,
        config_file=str(config_file),
        migrated_services=["tts"],
        conflict_count=0,
        original_bytes=original_bytes,
    )

    assert backup.read_bytes() == original_bytes
    assert backup.stat().st_mode & 0o777 == 0o600
    assert receipt.stat().st_mode & 0o777 == 0o600
    create_secure_migration_artifacts(
        original_config=original,
        migrated_config=migrated,
        config_file=str(config_file),
        migrated_services=["tts"],
        conflict_count=0,
        original_bytes=original_bytes,
    )

    backup.unlink()
    backup.symlink_to(config_file)
    with pytest.raises(RuntimeError, match="insecure"):
        create_secure_migration_artifacts(
            original_config=original,
            migrated_config=migrated,
            config_file=str(config_file),
            migrated_services=["tts"],
            conflict_count=0,
            original_bytes=original_bytes,
        )

    backup.unlink()
    backup.write_text("wrong")
    os.chmod(backup, 0o600)
    with pytest.raises(RuntimeError, match="non-matching"):
        create_secure_migration_artifacts(
            original_config=original,
            migrated_config=migrated,
            config_file=str(config_file),
            migrated_services=["tts"],
            conflict_count=0,
            original_bytes=original_bytes,
        )

    assert bytes_sha256(original_bytes) in receipt.read_text()
    assert content_sha256(migrated) in receipt.read_text()


def test_secure_receipts_include_full_original_and_migrated_identity(tmp_path) -> None:
    config_file = tmp_path / "config.json"
    migrated = {"services": {"tts": {"mesh_sharing": {"allowed_peers": []}, "mesh_routing": {}}}}
    original_a = b'{"services":{"tts":{"mesh_sharing":{"allowed_peers":[]}}}}\n'
    original_b = b'{\n  "services": {"tts": {"mesh_sharing": {"allowed_peers": []}}}\n}\n'
    config_file.write_bytes(original_a)

    _, receipt_a = create_secure_migration_artifacts(
        original_config=json.loads(original_a),
        migrated_config=migrated,
        config_file=str(config_file),
        migrated_services=["tts"],
        conflict_count=0,
        original_bytes=original_a,
    )
    _, receipt_a_again = create_secure_migration_artifacts(
        original_config=json.loads(original_a),
        migrated_config=migrated,
        config_file=str(config_file),
        migrated_services=["tts"],
        conflict_count=0,
        original_bytes=original_a,
    )
    _, receipt_b = create_secure_migration_artifacts(
        original_config=json.loads(original_b),
        migrated_config=migrated,
        config_file=str(config_file),
        migrated_services=["tts"],
        conflict_count=0,
        original_bytes=original_b,
    )

    assert receipt_a == receipt_a_again
    assert receipt_a != receipt_b
    assert bytes_sha256(original_a) in receipt_a.name
    assert content_sha256(migrated) in receipt_a.name
    assert bytes_sha256(original_b) in receipt_b.name
    assert receipt_a.stat().st_mode & 0o777 == 0o600
    assert receipt_b.stat().st_mode & 0o777 == 0o600


def test_stable_rbac_report_replaces_and_loads(tmp_path) -> None:
    config_file = tmp_path / "config.json"
    config_file.write_text("{}")
    first = {"kind": "mesh_service_policy_rbac_preflight", "release_blocking": True}
    second = {"kind": "mesh_service_policy_rbac_preflight", "release_blocking": False}

    path = persist_rbac_preflight_report(str(config_file), first)
    assert path.name == "config.json.mesh-policy-rbac.json"
    assert path.stat().st_mode & 0o777 == 0o600
    assert load_rbac_preflight_report(str(config_file))[0] == first

    assert persist_rbac_preflight_report(str(config_file), second) == path
    assert load_rbac_preflight_report(str(config_file))[0] == second


def _lookup(config: dict, path: str):
    value = config
    for part in path.split("."):
        value = value[part]
    return value
