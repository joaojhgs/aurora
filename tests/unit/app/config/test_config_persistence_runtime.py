"""Runtime config persistence behavior."""

from __future__ import annotations

import json
from copy import deepcopy
from unittest.mock import MagicMock, patch

import pytest

from app.services.config.config_manager import ConfigManager
from app.services.config.mesh_policy_migration import MESH_SERVICE_PATHS


@pytest.fixture(autouse=True)
def reset_config_manager(monkeypatch: pytest.MonkeyPatch, tmp_path):
    original = ConfigManager._instance
    ConfigManager._instance = None
    config_path = tmp_path / "config.json"
    monkeypatch.setenv("AURORA_CONFIG_FILE", str(config_path))
    yield config_path
    ConfigManager._instance = original


def test_config_save_is_json_safe_with_secret_values(reset_config_manager) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()

    metadata = manager.set("services.gateway.api.token_secret", "runtime-secret")
    manager.set("services.auth.enabled", False)

    data = json.loads(config_path.read_text())
    assert data["services"]["gateway"]["api"]["token_secret"] == "runtime-secret"
    assert data["services"]["auth"]["enabled"] is False
    assert metadata["affected_sections"] == [
        "services",
        "services.gateway",
        "services.gateway.api",
        "services.gateway.api.token_secret",
    ]

    ConfigManager._instance = None
    reloaded = ConfigManager()
    assert reloaded.get("services.gateway.api.token_secret") == "runtime-secret"
    assert reloaded.get("services.auth.enabled") is False


def test_setting_unchanged_value_skips_persistence_and_reload_notification(
    reset_config_manager,
) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    key_path = "services.gateway.signaling_mqtt.brokers"
    current_value = deepcopy(manager.get(key_path))
    file_before = config_path.read_bytes()
    history_before = manager.get_version_history(key_path=key_path)

    with (
        patch.object(manager, "save_config") as save_config,
        patch.object(manager, "_validate_config") as validate_config,
        patch.object(manager, "_validate_runtime_lifecycle_policy") as validate_lifecycle,
        patch.object(manager, "_notify_observers") as notify_observers,
        patch.object(manager, "_record_version") as record_version,
    ):
        metadata = manager.set(key_path, deepcopy(current_value))

    save_config.assert_not_called()
    validate_config.assert_not_called()
    validate_lifecycle.assert_not_called()
    notify_observers.assert_not_called()
    record_version.assert_not_called()
    assert config_path.read_bytes() == file_before
    assert manager.get_version_history(key_path=key_path) == history_before
    assert metadata == {
        "key_path": key_path,
        "old_value": current_value,
        "new_value": current_value,
        "affected_sections": [
            "services",
            "services.gateway",
            "services.gateway.signaling_mqtt",
            key_path,
        ],
    }


def test_repeated_set_only_persists_and_notifies_the_first_change(
    reset_config_manager,
) -> None:
    manager = ConfigManager()
    key_path = "services.gateway.signaling_mqtt.brokers"
    old_value = deepcopy(manager.get(key_path))
    new_value = ["wss://mesh.example.test/mqtt"]
    observer = MagicMock()
    manager.add_observer(observer)

    with patch.object(
        manager,
        "_write_candidate_atomic",
        wraps=manager._write_candidate_atomic,
    ) as write_candidate:
        manager.set(key_path, deepcopy(new_value))
        manager.set(key_path, deepcopy(new_value))

    write_candidate.assert_called_once()
    observer.assert_called_once_with(key_path, old_value, new_value)
    history = manager.get_version_history(key_path=key_path)
    assert len(history) == 1
    assert history[0]["old_value"] == old_value
    assert history[0]["new_value"] == new_value


def test_secret_migration_keeps_value_effective_in_current_process(
    reset_config_manager,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("AURORA_WEBRTC_PASSWORD", raising=False)
    manager = ConfigManager()
    manager.set("services.gateway.webrtc.password", "shared-room-password")

    assert manager.migrate_secrets_to_env() is True

    persisted = json.loads(reset_config_manager.read_text())
    assert persisted["services"]["gateway"]["webrtc"]["password"] == ""
    assert manager.get("services.gateway.webrtc.password") == "shared-room-password"
    assert manager.get("services.gateway")["webrtc"]["password"] == ("shared-room-password")
    assert manager.get_config_dict()["services"]["gateway"]["webrtc"]["password"] == (
        "shared-room-password"
    )
    assert "AURORA_WEBRTC_PASSWORD='shared-room-password'" in (tmp_path / ".env").read_text()


def test_secret_migration_honors_native_runtime_env_file(
    reset_config_manager,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    env_path = tmp_path / "native-runtime" / ".env"
    monkeypatch.setenv("AURORA_ENV_FILE", str(env_path))
    monkeypatch.delenv("AURORA_WEBRTC_PASSWORD", raising=False)
    manager = ConfigManager()
    manager.set("services.gateway.webrtc.password", "native-room-password")

    assert manager.migrate_secrets_to_env() is True

    assert env_path.is_file()
    assert "AURORA_WEBRTC_PASSWORD='native-room-password'" in env_path.read_text()
    assert not (tmp_path / ".env").exists()


def test_failed_save_does_not_corrupt_existing_config(reset_config_manager) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    before = config_path.read_text()

    manager._config["services"]["auth"]["enabled"] = object()
    with pytest.raises(RuntimeError):
        manager.save_config()

    assert config_path.read_text() == before
    json.loads(config_path.read_text())


def test_config_service_cannot_be_disabled_at_runtime(reset_config_manager) -> None:
    manager = ConfigManager()

    with pytest.raises(ValueError, match="ConfigService must remain active"):
        manager.set("services.config.enabled", False)

    assert manager.get("services.config.enabled") is True


def test_raw_mesh_policy_migration_creates_secure_backup_and_is_idempotent(
    reset_config_manager,
) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    data = manager.get_config_dict()
    for path in MESH_SERVICE_PATHS:
        service = data
        for part in path.split("."):
            service = service[part]
        service.pop("mesh_routing", None)
        service["mesh_sharing"]["allowed_peers"] = []
        service["mesh_sharing"]["prefer"] = "network"
    config_path.write_text(json.dumps(data))

    ConfigManager._instance = None
    migrated = ConfigManager()
    backups = list(config_path.parent.glob("config.json.mesh-policy-v1.*.backup.json"))
    receipts = list(config_path.parent.glob("config.json.mesh-policy-v1.*.receipt.json"))
    assert len(backups) == 1
    assert len(receipts) == 1
    assert backups[0].stat().st_mode & 0o077 == 0
    receipt = json.loads(receipts[0].read_text())
    assert "token_secret" not in receipts[0].read_text()
    assert receipt["service_count"] == len(MESH_SERVICE_PATHS)
    assert migrated.get("services.tts.mesh_routing.allowed_provider_peer_ids") == []

    before = config_path.read_bytes()
    ConfigManager._instance = None
    ConfigManager()
    assert config_path.read_bytes() == before
    assert len(list(config_path.parent.glob("config.json.mesh-policy-v1.*.backup.json"))) == 1


def test_mesh_policy_migration_validates_before_artifacts(
    reset_config_manager,
) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    data = manager.get_config_dict()
    data["services"]["config"]["enabled"] = False
    data["services"]["tts"].pop("mesh_routing", None)
    config_path.write_text(json.dumps(data))

    ConfigManager._instance = None
    with (
        patch("app.services.config.config_manager.create_secure_migration_artifacts") as artifacts,
        pytest.raises(RuntimeError, match="ConfigService must remain active"),
    ):
        ConfigManager()

    artifacts.assert_not_called()


def test_mesh_policy_migration_backup_uses_exact_raw_bytes(reset_config_manager) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    data = manager.get_config_dict()
    data["services"]["tts"].pop("mesh_routing", None)
    raw = json.dumps(data, separators=(",", ":"), sort_keys=False).encode() + b"\n\n"
    config_path.write_bytes(raw)

    ConfigManager._instance = None
    ConfigManager()

    backup = next(config_path.parent.glob("config.json.mesh-policy-v1.*.backup.json"))
    assert backup.read_bytes() == raw


def test_legacy_service_row_write_constructs_v2_without_unrelated_notifications(
    reset_config_manager,
) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    old_shape = deepcopy(manager.get("services.tts"))
    old_shape.pop("mesh_routing", None)
    old_shape["mesh_sharing"]["allowed_peers"] = None
    old_shape["mesh_sharing"]["prefer"] = "network"
    events = []
    manager.add_observer(lambda key, old, new, metadata=None: events.append((key, metadata)))

    metadata = manager.set("services.tts", old_shape)

    assert manager.get("services.tts.mesh_sharing.allowed_peers") is None
    assert manager.get("services.tts.mesh_routing.allowed_provider_peer_ids") is None
    assert manager.get("services.tts.mesh_routing.prefer") == "network"
    persisted = json.loads(config_path.read_text())
    assert persisted["services"]["tts"]["mesh_routing"]["allowed_provider_peer_ids"] is None
    assert persisted["services"]["tts"]["mesh_routing"]["prefer"] == "network"
    assert metadata["changed_paths"] == [
        "services.tts",
        "services.tts.mesh_sharing.prefer",
        "services.tts.mesh_routing.prefer",
    ]
    assert len(events) == 1
    assert events[0][0] == "services.tts"
    assert events[0][1]["changed_paths"] == metadata["changed_paths"]
    assert all(not path.startswith("services.db.") for path in metadata["changed_paths"])


def test_legacy_services_root_write_constructs_exact_v2_paths_only(
    reset_config_manager,
) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    services = deepcopy(manager.get("services"))
    services["tts"].pop("mesh_routing", None)
    services["tts"]["mesh_sharing"]["allowed_peers"] = []
    services["tts"]["mesh_sharing"]["prefer"] = "local"
    services["scheduler"].pop("mesh_routing", None)
    services["scheduler"]["mesh_sharing"]["allowed_peers"] = ["scheduler-peer"]
    events = []
    manager.add_observer(lambda key, old, new, metadata=None: events.append((key, metadata)))

    metadata = manager.set("services", services)

    assert manager.get("services.tts.mesh_routing.allowed_provider_peer_ids") == []
    assert manager.get("services.tts.mesh_routing.prefer") == "local"
    assert manager.get("services.scheduler.mesh_routing.allowed_provider_peer_ids") == [
        "scheduler-peer"
    ]
    persisted = json.loads(config_path.read_text())
    assert persisted["services"]["tts"]["mesh_routing"]["allowed_provider_peer_ids"] == []
    assert persisted["services"]["scheduler"]["mesh_routing"]["allowed_provider_peer_ids"] == [
        "scheduler-peer"
    ]
    assert metadata["changed_paths"][0] == "services"
    assert set(metadata["changed_paths"][1:]) == {
        "services.tts.mesh_sharing.allowed_peers",
        "services.tts.mesh_routing.allowed_provider_peer_ids",
        "services.scheduler.mesh_sharing.allowed_peers",
        "services.scheduler.mesh_routing.allowed_provider_peer_ids",
    }
    by_key = dict(events)
    assert by_key["services.tts"]["changed_paths"] == [
        "services.tts.mesh_sharing.allowed_peers",
        "services.tts.mesh_routing.allowed_provider_peer_ids",
    ]
    assert by_key["services.scheduler"]["changed_paths"] == [
        "services.scheduler.mesh_sharing.allowed_peers",
        "services.scheduler.mesh_routing.allowed_provider_peer_ids",
    ]
    assert by_key["services"]["changed_paths"] == ["services"]
    assert "services.db" not in by_key


@pytest.mark.parametrize(
    "changes",
    [
        [
            {"key_path": "services.tts", "value": {}},
            {"key_path": "services.tts.mesh_sharing.share", "value": True},
        ],
        [
            {"key_path": "services.tts.mesh_sharing.share", "value": True},
            {"key_path": "services.tts", "value": {}},
        ],
    ],
)
def test_overlapping_change_paths_are_rejected_without_writes(
    reset_config_manager,
    changes,
) -> None:
    manager = ConfigManager()
    old_revision = manager.config_revision
    old_history = manager.get_version_history()
    expected_error = (
        "Overlapping configuration change paths are not allowed: "
        "services.tts and services.tts.mesh_sharing.share"
    )

    with (
        patch.object(manager, "_write_candidate_atomic") as write_candidate,
        pytest.raises(ValueError) as exc_info,
    ):
        manager._apply_changes_locked(changes)

    assert str(exc_info.value) == expected_error
    write_candidate.assert_not_called()
    assert manager.config_revision == old_revision
    assert manager.get_version_history() == old_history


def test_write_candidate_failure_restores_exact_old_bytes(reset_config_manager) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    old_bytes = config_path.read_bytes()
    original_write = manager._write_config_file

    def fail_after_replace(candidate):
        original_write(candidate)
        raise RuntimeError("post replace failure")

    with (
        patch.object(manager, "_write_config_file", side_effect=fail_after_replace),
        pytest.raises(RuntimeError, match="post replace failure"),
    ):
        manager.set("services.tts.mesh_sharing.share", True)

    assert config_path.read_bytes() == old_bytes
    assert manager.config_revision == 0
    assert manager.get_version_history() == []


def test_commit_change_set_write_failure_restores_disk_memory_revision_and_history(
    reset_config_manager,
) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    old_bytes = config_path.read_bytes()
    old_export = manager.get_config_dict()
    old_revision = manager.config_revision
    old_history = manager.get_version_history()
    original_write = manager._write_config_file
    preview = manager.preview_diff(
        [
            {"key_path": "services.tts.mesh_sharing.share", "value": True},
            {"key_path": "services.tts.mesh_routing.prefer", "value": "network"},
        ],
        actor="actor",
    )

    def fail_after_replace(candidate):
        original_write(candidate)
        raise RuntimeError("post replace failure")

    with (
        patch.object(manager, "_write_config_file", side_effect=fail_after_replace),
        pytest.raises(RuntimeError, match="post replace failure"),
    ):
        manager.commit_change_set(
            [
                {"key_path": "services.tts.mesh_sharing.share", "value": True},
                {"key_path": "services.tts.mesh_routing.prefer", "value": "network"},
            ],
            base_revision=preview["base_revision"],
            preview_token=preview["preview_token"],
            actor="actor",
        )

    assert config_path.read_bytes() == old_bytes
    assert manager.get_config_dict() == old_export
    assert manager.get("services.tts.mesh_sharing.share") is False
    assert (
        manager.get("services.tts.mesh_routing.prefer")
        == old_export["services"]["tts"]["mesh_routing"]["prefer"]
    )
    assert (
        manager.get("services.tts.mesh_sharing.prefer")
        == old_export["services"]["tts"]["mesh_sharing"]["prefer"]
    )
    assert manager.config_revision == old_revision
    assert manager.get_version_history() == old_history


def test_commit_with_bad_token_writes_nothing(
    reset_config_manager,
) -> None:
    config_path = reset_config_manager
    manager = ConfigManager()
    before_disk = config_path.read_text()

    result = manager.commit_change_set(
        [{"key_path": "services.tts.mesh_sharing.share", "value": True}],
        base_revision=manager.config_revision,
        preview_token="bad-token",
        actor="actor",
    )

    assert result["success"] is False
    assert result["error_code"] == "config_revision_conflict"
    assert result["diff"]["preview_token"] is None
    assert config_path.read_text() == before_disk
    assert manager.get("services.tts.mesh_sharing.share") is False
    assert manager._preview_tokens == {}


def test_preview_token_expiry_and_bounds(reset_config_manager) -> None:
    manager = ConfigManager()
    for index in range(140):
        manager.preview_diff(
            [{"key_path": "services.tts.mesh_sharing.max_concurrent", "value": index}]
        )

    assert len(manager._preview_tokens) <= 128
    token = next(iter(manager._preview_tokens))
    manager._preview_tokens[token]["expires_at"] = "2000-01-01T00:00:00+00:00"
    result = manager.commit_change_set(
        [{"key_path": "services.tts.mesh_sharing.max_concurrent", "value": 139}],
        base_revision=manager.config_revision,
        preview_token=token,
        actor="internal",
    )

    assert result["success"] is False
    assert result["error_code"] == "config_revision_conflict"
    assert token not in manager._preview_tokens
