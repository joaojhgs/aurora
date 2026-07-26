"""Config admin contract behavior tests."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.messaging import QueryResult
from app.services.config.config_manager import ConfigManager
from app.services.config.messages import UpdateConfigCommand
from app.services.config.service import ConfigService
from app.shared.contracts.models.config import (
    ConfigChange,
    ConfigCommitChangeSetRequest,
    ConfigDiffPreviewRequest,
    ConfigMethods,
    ConfigReloadImpactRequest,
    ConfigRollbackRequest,
    ConfigSchemaMetadataRequest,
    ConfigVersionHistoryRequest,
)
from app.shared.contracts.registry import list_modules


@pytest.fixture
def config_service(tmp_path, monkeypatch):
    ConfigManager._instance = None
    config_path = tmp_path / "config.json"
    monkeypatch.setenv("AURORA_CONFIG_FILE", str(config_path))
    service = ConfigService()
    yield service
    ConfigManager._instance = None


@pytest.mark.asyncio
async def test_config_admin_contracts_are_exposed_with_permissions(config_service):
    contract = list_modules()["Config"]
    methods = {method.bus_topic: method for method in contract.methods}

    assert methods[ConfigMethods.GET_SCHEMA_METADATA].exposure == "both"
    assert methods[ConfigMethods.GET_SCHEMA_METADATA].method_type == "use"
    assert methods[ConfigMethods.PREVIEW_DIFF].required_perms == [ConfigMethods.PREVIEW_DIFF]
    assert methods[ConfigMethods.GET_VERSION_HISTORY].method_type == "use"
    assert methods[ConfigMethods.PREVIEW_RELOAD_IMPACT].method_type == "use"
    assert methods[ConfigMethods.ROLLBACK].exposure == "both"
    assert methods[ConfigMethods.ROLLBACK].method_type == "manage"
    assert methods[ConfigMethods.ROLLBACK].required_perms == [ConfigMethods.ROLLBACK]
    assert methods[ConfigMethods.COMMIT_CHANGE_SET].exposure == "both"
    assert methods[ConfigMethods.COMMIT_CHANGE_SET].method_type == "manage"
    assert methods[ConfigMethods.COMMIT_CHANGE_SET].required_perms == [
        ConfigMethods.COMMIT_CHANGE_SET
    ]


@pytest.mark.asyncio
async def test_schema_metadata_redacts_secret_values_and_reports_source(config_service):
    config_service.config_manager.set("services.gateway.api.token_secret", "secret-value")

    response = await config_service._handle_get_schema_metadata(
        ConfigSchemaMetadataRequest(section="services.gateway.api")
    )
    fields = {field.key_path: field for field in response.fields}

    token_secret = fields["services.gateway.api.token_secret"]
    assert token_secret.secret is True
    assert token_secret.current_value == "[REDACTED]"
    assert token_secret.default is None
    assert token_secret.source_layer == "config"
    assert token_secret.restart_required is True
    assert token_secret.affected_services == ["gateway"]
    assert response.secrets_redacted is True


@pytest.mark.asyncio
async def test_diff_preview_is_redacted_and_does_not_persist(config_service):
    before = config_service.config_manager.get("services.gateway.api.token_secret")

    response = await config_service._handle_preview_diff(
        ConfigDiffPreviewRequest(
            changes=[
                ConfigChange(
                    key_path="services.gateway.api.token_secret",
                    value="new-secret",
                )
            ]
        )
    )

    assert response.valid is True
    assert response.diffs[0].old_value is None
    assert response.diffs[0].new_value == "[REDACTED]"
    assert response.diffs[0].secret is True
    assert response.diffs[0].restart_required is True
    assert response.base_revision == 0
    assert response.preview_token
    assert config_service.config_manager.get("services.gateway.api.token_secret") == before


@pytest.mark.asyncio
async def test_diff_preview_recursively_redacts_secrets_in_broad_config_rows(config_service):
    gateway = config_service.config_manager.get("services.gateway")
    original_token_secret = config_service.config_manager.get("services.gateway.api.token_secret")
    original_webrtc_password = config_service.config_manager.get("services.gateway.webrtc.password")
    gateway["api"]["token_secret"] = "raw-token-secret"
    gateway["webrtc"]["password"] = "raw-room-password"

    response = await config_service._handle_preview_diff(
        ConfigDiffPreviewRequest(changes=[ConfigChange(key_path="services.gateway", value=gateway)])
    )

    assert response.valid is True
    assert response.diffs[0].new_value["api"]["token_secret"] == "[REDACTED]"
    assert response.diffs[0].new_value["webrtc"]["password"] == "[REDACTED]"
    serialized = json.dumps(response.model_dump())
    assert "raw-token-secret" not in serialized
    assert "raw-room-password" not in serialized
    assert config_service.config_manager.get("services.gateway.api.token_secret") == (
        original_token_secret
    )
    assert (
        config_service.config_manager.get("services.gateway.webrtc.password")
        == original_webrtc_password
    )


@pytest.mark.asyncio
async def test_diff_preview_includes_effective_mirror_rows(config_service):
    response = await config_service._handle_preview_diff(
        ConfigDiffPreviewRequest(
            changes=[
                ConfigChange(
                    key_path="services.tts.mesh_routing.prefer",
                    value="network",
                )
            ]
        )
    )

    assert response.valid is True
    assert [diff.key_path for diff in response.diffs] == [
        "services.tts.mesh_routing.prefer",
        "services.tts.mesh_sharing.prefer",
    ]
    assert response.changed_paths == [
        "services.tts.mesh_routing.prefer",
        "services.tts.mesh_sharing.prefer",
    ]


@pytest.mark.asyncio
async def test_commit_change_set_is_atomic_and_rejects_replay_stale_and_mismatch(
    config_service,
):
    observer_events = []
    config_service.config_manager.add_observer(
        lambda key, old, new, metadata=None: observer_events.append((key, metadata))
    )
    changes = [
        ConfigChange(key_path="services.tts.mesh_sharing.share", value=True),
        ConfigChange(key_path="services.tts.mesh_routing.prefer", value="network"),
    ]
    preview = await config_service._handle_preview_diff(ConfigDiffPreviewRequest(changes=changes))

    committed = await config_service._handle_commit_change_set(
        ConfigCommitChangeSetRequest(
            changes=changes,
            base_revision=preview.base_revision or 0,
            preview_token=preview.preview_token or "",
        )
    )

    assert committed.success is True
    assert committed.revision == 1
    assert committed.changed_paths == [
        "services.tts.mesh_sharing.share",
        "services.tts.mesh_routing.prefer",
        "services.tts.mesh_sharing.prefer",
    ]
    assert config_service.config_manager.get("services.tts.mesh_sharing.prefer") == "network"
    assert config_service.config_manager.get("services.tts.mesh_routing.prefer") == "network"
    assert len(observer_events) == 1
    assert observer_events[0][0] == "services.tts"
    assert observer_events[0][1]["changed_paths"] == committed.changed_paths

    replay = await config_service._handle_commit_change_set(
        ConfigCommitChangeSetRequest(
            changes=changes,
            base_revision=preview.base_revision or 0,
            preview_token=preview.preview_token or "",
        )
    )
    assert replay.success is False
    assert replay.error_code == "config_revision_conflict"
    assert replay.diff is not None
    assert replay.diff.preview_token is None

    stale_preview = await config_service._handle_preview_diff(
        ConfigDiffPreviewRequest(
            changes=[ConfigChange(key_path="services.tts.mesh_routing.fallback", value="error")]
        )
    )
    config_service.config_manager.set("services.scheduler.mesh_sharing.share", True)
    stale = await config_service._handle_commit_change_set(
        ConfigCommitChangeSetRequest(
            changes=[ConfigChange(key_path="services.tts.mesh_routing.fallback", value="error")],
            base_revision=stale_preview.base_revision or 0,
            preview_token=stale_preview.preview_token or "",
        )
    )
    assert stale.success is False
    assert stale.error_code == "config_revision_conflict"
    assert stale.diff is not None
    assert stale.diff.preview_token is None


@pytest.mark.asyncio
async def test_commit_change_set_rejects_actor_mismatch(config_service):
    changes = [ConfigChange(key_path="services.tts.mesh_sharing.share", value=True)]
    preview = await config_service._handle_preview_diff(
        ConfigDiffPreviewRequest(changes=changes),
        envelope=SimpleNamespace(
            principal_id="alice", caller_peer_id=None, identity_source="token"
        ),
    )

    response = await config_service._handle_commit_change_set(
        ConfigCommitChangeSetRequest(
            changes=changes,
            base_revision=preview.base_revision or 0,
            preview_token=preview.preview_token or "",
        ),
        envelope=SimpleNamespace(principal_id="bob", caller_peer_id=None, identity_source="token"),
    )

    assert response.success is False
    assert response.error_code == "config_revision_conflict"
    assert response.diff is not None
    assert response.diff.preview_token is None
    assert config_service.config_manager.get("services.tts.mesh_sharing.share") is False


@pytest.mark.asyncio
async def test_commit_conflicts_do_not_mint_preview_tokens(config_service):
    changes = [ConfigChange(key_path="services.tts.mesh_sharing.share", value=True)]
    preview = await config_service._handle_preview_diff(ConfigDiffPreviewRequest(changes=changes))
    before_tokens = dict(config_service.config_manager._preview_tokens)

    await config_service._handle_commit_change_set(
        ConfigCommitChangeSetRequest(
            changes=changes,
            base_revision=preview.base_revision or 0,
            preview_token="bad-token",
        )
    )

    assert config_service.config_manager._preview_tokens == before_tokens


@pytest.mark.asyncio
async def test_version_history_and_rollback_redact_secret_values(config_service):
    config_service.config_manager.set("services.gateway.api.token_secret", "first-secret")
    config_service.config_manager.set("services.gateway.api.token_secret", "second-secret")

    history = await config_service._handle_get_version_history(
        ConfigVersionHistoryRequest(key_path="services.gateway.api.token_secret")
    )
    latest = history.versions[0]
    assert latest.old_value == "[REDACTED]"
    assert latest.new_value == "[REDACTED]"
    assert latest.secret is True

    rollback = await config_service._handle_rollback(
        ConfigRollbackRequest(version_id=latest.version_id)
    )

    assert rollback.success is True
    assert rollback.rolled_back_to == "[REDACTED]"
    assert config_service.config_manager.get("services.gateway.api.token_secret") == "first-secret"


@pytest.mark.asyncio
async def test_rollback_single_dict_path_does_not_infer_multi_change(config_service):
    original = dict(config_service.config_manager.get("services.gateway.signaling_mqtt"))
    replacement = {**original, "brokers": ["mqtt://one"], "topic_root": "custom/root"}
    config_service.config_manager.set("services.gateway.signaling_mqtt", replacement)
    history = await config_service._handle_get_version_history(
        ConfigVersionHistoryRequest(key_path="services.gateway.signaling_mqtt")
    )

    rollback = await config_service._handle_rollback(
        ConfigRollbackRequest(version_id=history.versions[0].version_id)
    )

    assert rollback.success is True
    assert rollback.rolled_back_to == original
    assert config_service.config_manager.get("services.gateway.signaling_mqtt") == original


@pytest.mark.asyncio
async def test_multi_change_history_and_rollback_are_structured_and_secret_safe(
    config_service,
):
    observer_events = []
    config_service.config_manager.add_observer(
        lambda key, old, new, metadata=None: observer_events.append((key, metadata))
    )
    changes = [
        ConfigChange(key_path="services.gateway.api.token_secret", value="second-secret"),
        ConfigChange(key_path="services.tts.mesh_sharing.share", value=True),
    ]
    actor_envelope = SimpleNamespace(principal_id="admin", caller_peer_id=None)
    preview = await config_service._handle_preview_diff(
        ConfigDiffPreviewRequest(changes=changes),
        envelope=actor_envelope,
    )
    committed = await config_service._handle_commit_change_set(
        ConfigCommitChangeSetRequest(
            changes=changes,
            base_revision=preview.base_revision or 0,
            preview_token=preview.preview_token or "",
        ),
        envelope=actor_envelope,
    )
    assert committed.success is True

    history = await config_service._handle_get_version_history(ConfigVersionHistoryRequest())
    latest = history.versions[0]
    assert latest.changed_paths == committed.changed_paths
    assert latest.actor == "principal_id:admin"
    assert latest.affected_sections == [
        "services",
        "services.gateway",
        "services.gateway.api",
        "services.gateway.api.token_secret",
        "services.tts",
        "services.tts.mesh_sharing",
        "services.tts.mesh_sharing.share",
    ]
    assert latest.old_value["services.gateway.api.token_secret"] is None
    assert latest.new_value["services.gateway.api.token_secret"] == "[REDACTED]"
    assert "second-secret" not in json.dumps(latest.model_dump())

    rollback = await config_service._handle_rollback(
        ConfigRollbackRequest(version_id=latest.version_id),
        envelope=actor_envelope,
    )
    assert rollback.success is True
    assert rollback.affected_sections == latest.affected_sections
    assert rollback.rolled_back_to["services.gateway.api.token_secret"] is None
    assert config_service.config_manager.get("services.tts.mesh_sharing.share") is False
    assert config_service.config_manager.get("services.gateway.api.token_secret", None) is None
    history_after_rollback = config_service.config_manager.get_version_history()
    assert len(history_after_rollback) == 2
    assert history_after_rollback[0]["transaction_kind"] == "rollback"
    assert history_after_rollback[0]["actor"] == "principal_id:admin"
    assert history_after_rollback[0]["affected_sections"] == latest.affected_sections


@pytest.mark.asyncio
async def test_config_updated_event_recursively_redacts_nested_secrets_and_carries_actor(
    config_service,
    monkeypatch,
):
    publish = AsyncMock()
    monkeypatch.setattr(
        "app.shared.services.base_service.get_bus_singleton",
        lambda: SimpleNamespace(publish=publish),
    )

    config_service.config_manager._notify_observers(
        "services.gateway.api",
        {},
        {
            "token": "raw-token",
            "nested": [
                {"password": "raw-password"},
                {"client_secret": "raw-secret"},
                {"public": "visible"},
            ],
        },
        {
            "transaction_id": "tx-redact",
            "config_revision": 7,
            "changed_paths": ["services.gateway.api"],
            "actor": "principal_id:admin",
        },
    )
    await asyncio.sleep(0)

    publish.assert_awaited_once()
    topic, event = publish.await_args.args[:2]
    kwargs = publish.await_args.kwargs
    assert topic == ConfigMethods.UPDATED
    assert kwargs["event"] is True
    assert kwargs["mesh"] is False
    assert event.actor == "principal_id:admin"
    assert event.transaction_id == "tx-redact"
    assert event.new_value["token"] == "[REDACTED]"
    assert event.new_value["nested"][0]["password"] == "[REDACTED]"
    assert event.new_value["nested"][1]["client_secret"] == "[REDACTED]"
    assert event.new_value["nested"][2]["public"] == "visible"
    assert "raw-token" not in json.dumps(event.model_dump())
    assert "raw-password" not in json.dumps(event.model_dump())
    assert "raw-secret" not in json.dumps(event.model_dump())


@pytest.mark.asyncio
async def test_rollback_config_updated_event_carries_envelope_actor(config_service, monkeypatch):
    publish = AsyncMock()
    monkeypatch.setattr(
        "app.shared.services.base_service.get_bus_singleton",
        lambda: SimpleNamespace(publish=publish),
    )
    actor_envelope = SimpleNamespace(principal_id="admin", caller_peer_id=None)
    config_service.config_manager.set("services.tts.mesh_sharing.share", True)
    await asyncio.sleep(0)
    publish.reset_mock()

    history = await config_service._handle_get_version_history(ConfigVersionHistoryRequest())
    rollback = await config_service._handle_rollback(
        ConfigRollbackRequest(version_id=history.versions[0].version_id),
        envelope=actor_envelope,
    )
    await asyncio.sleep(0)

    assert rollback.success is True
    publish.assert_awaited_once()
    event = publish.await_args.args[1]
    assert event.actor == "principal_id:admin"
    assert event.changed_paths == ["services.tts.mesh_sharing.share"]


@pytest.mark.asyncio
async def test_update_config_set_uses_envelope_actor_in_history_and_event(
    config_service,
    monkeypatch,
):
    publish = AsyncMock()
    monkeypatch.setattr(
        "app.shared.services.base_service.get_bus_singleton",
        lambda: SimpleNamespace(publish=publish),
    )
    envelope = SimpleNamespace(principal_id="external-admin", caller_peer_id=None)

    response = await config_service._handle_update_config(
        UpdateConfigCommand(key_path="services.tts.mesh_sharing.share", value=True),
        envelope=envelope,
    )
    await asyncio.sleep(0)

    assert response.success is True
    history = config_service.config_manager.get_version_history()
    assert history[0]["actor"] == "principal_id:external-admin"
    publish.assert_awaited_once()
    event = publish.await_args.args[1]
    assert event.actor == "principal_id:external-admin"
    assert event.changed_paths == ["services.tts.mesh_sharing.share"]


def test_transaction_notifications_are_grouped_by_actual_service_row(config_service):
    events = []
    config_service.config_manager.add_observer(
        lambda key, old, new, metadata=None: events.append((key, old, new, metadata))
    )

    config_service.config_manager._apply_changes_locked(
        [
            {"key_path": "services.stt.coordinator.mesh_sharing.share", "value": True},
            {"key_path": "services.stt.wakeword.mesh_sharing.share", "value": True},
            {"key_path": "services.gateway.api.port", "value": 8123},
        ],
        actor="test",
    )

    by_key = {event[0]: event for event in events}
    assert "services.stt.coordinator" in by_key
    assert "services.stt.wakeword" in by_key
    assert "services.gateway.api.port" in by_key
    assert by_key["services.stt.coordinator"][3]["changed_paths"] == [
        "services.stt.coordinator.mesh_sharing.share"
    ]
    assert by_key["services.stt.wakeword"][3]["changed_paths"] == [
        "services.stt.wakeword.mesh_sharing.share"
    ]


def test_unchanged_mirror_request_does_not_create_effective_history_or_notification(
    config_service,
):
    events = []
    manager = config_service.config_manager
    manager.add_observer(lambda key, old, new, metadata=None: events.append((key, metadata)))
    current = manager.get("services.tts.mesh_routing.prefer")
    with manager.config_lock:
        manager._set_path(manager._config, "services.tts.mesh_sharing.prefer", current)
    preview = manager.preview_diff(
        [{"key_path": "services.tts.mesh_routing.prefer", "value": current}],
        actor="actor",
    )

    assert preview["diffs"][0]["key_path"] == "services.tts.mesh_routing.prefer"
    assert preview["diffs"][0]["changed"] is False
    assert "services.tts.mesh_sharing.prefer" not in preview["changed_paths"]

    result = manager.commit_change_set(
        [{"key_path": "services.tts.mesh_routing.prefer", "value": current}],
        base_revision=preview["base_revision"],
        preview_token=preview["preview_token"],
        actor="actor",
    )

    assert result["success"] is True
    assert result["version_id"] is None
    assert manager.get_version_history() == []
    assert events == []


def test_observer_arity_without_typeerror_retry(config_service):
    calls = []

    def three_arg(key, old, new):
        calls.append((key, old, new))

    def four_arg_raises(key, old, new, metadata=None):
        calls.append((key, metadata))
        raise TypeError("callback body error")

    config_service.config_manager.add_observer(three_arg)
    config_service.config_manager.add_observer(four_arg_raises)

    config_service.config_manager._notify_observers(
        "services.tts.mesh_sharing.share",
        False,
        True,
        {"changed_paths": ["services.tts.mesh_sharing.share"]},
    )

    assert calls == [
        ("services.tts.mesh_sharing.share", False, True),
        (
            "services.tts.mesh_sharing.share",
            {"changed_paths": ["services.tts.mesh_sharing.share"]},
        ),
    ]


@pytest.mark.asyncio
async def test_reload_impact_preview_classifies_restart_and_reload(config_service):
    response = await config_service._handle_preview_reload_impact(
        ConfigReloadImpactRequest(
            key_paths=[
                "services.gateway.api.port",
                "services.tts.model_file_path",
            ]
        )
    )
    impacts = {impact.key_path: impact for impact in response.impacts}

    assert impacts["services.gateway.api.port"].restart_required is True
    assert impacts["services.gateway.api.port"].affected_services == ["gateway"]
    assert impacts["services.tts.model_file_path"].restart_required is False
    assert impacts["services.tts.model_file_path"].reload_required is True
    assert impacts["services.tts.model_file_path"].affected_services == ["tts"]


@pytest.mark.asyncio
async def test_preview_diff_reports_validation_errors_without_saving(config_service):
    response = await config_service._handle_preview_diff(
        ConfigDiffPreviewRequest(
            changes=[ConfigChange(key_path="services.config.enabled", value=False)]
        )
    )

    assert response.valid is False
    assert "ConfigService must remain active" in json.dumps(response.errors)
    assert config_service.config_manager.get("services.config.enabled") is True


@pytest.mark.asyncio
async def test_auth_preflight_retries_then_success(config_service, monkeypatch):
    monkeypatch.setattr("app.services.config.service.asyncio.sleep", AsyncMock())
    config_service.bus.request = AsyncMock(
        side_effect=[
            QueryResult(ok=False, error="not ready"),
            QueryResult(ok=True, data={"peers": []}),
        ]
    )

    report = await config_service.refresh_mesh_policy_rbac_preflight(
        max_attempts=2,
        backoff_seconds=0,
    )

    assert report is not None
    assert config_service.bus.request.await_count == 2
    assert config_service.config_manager.mesh_policy_rbac_report_path.endswith(
        "config.json.mesh-policy-rbac.json"
    )


@pytest.mark.asyncio
async def test_auth_preflight_reuses_persisted_original_allowlist_evidence(
    config_service,
):
    manager = config_service.config_manager
    config_path = manager.config_file
    data = manager.get_config_dict()
    data["services"]["tts"]["mesh_sharing"]["share"] = True
    data["services"]["tts"]["mesh_sharing"]["allowed_peers"] = ["legacy-peer"]
    data["services"]["tts"]["mesh_routing"] = {"allowed_provider_peer_ids": []}
    with open(config_path, "w") as handle:
        json.dump(data, handle)

    ConfigManager._instance = None
    reloaded_manager = ConfigManager()
    assert reloaded_manager.mesh_policy_legacy_allowlist_evidence["tts"] == ["legacy-peer"]

    ConfigManager._instance = None
    service = ConfigService()
    service.bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data={
                "peers": [
                    {
                        "peer_id": "legacy-peer",
                        "outbound_status": "approved",
                        "outbound_permissions": ["TTS.use"],
                    },
                    {
                        "peer_id": "blocked-peer",
                        "outbound_status": "approved",
                        "outbound_permissions": ["TTS.use"],
                    },
                ]
            },
        )
    )

    report = await service.refresh_mesh_policy_rbac_preflight(
        max_attempts=1,
        backoff_seconds=0,
    )

    by_service = {entry["service"]: entry for entry in report["services"]}
    assert by_service["tts"]["blocking_peer_ids"] == ["blocked-peer"]
    assert report["legacy_allowlist_evidence"]["tts"] == ["legacy-peer"]
    assert service.config_manager.mesh_policy_legacy_allowlist_evidence["tts"] == ["legacy-peer"]


@pytest.mark.asyncio
async def test_auth_preflight_task_is_cancelled_on_stop(config_service):
    async def never_finish(*args, **kwargs):
        await asyncio.Event().wait()

    config_service._mesh_policy_rbac_task = asyncio.create_task(never_finish())
    await asyncio.sleep(0)

    await config_service.on_stop()

    assert config_service._mesh_policy_rbac_task.cancelled()
