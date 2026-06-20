"""Config admin contract behavior tests."""

from __future__ import annotations

import json

import pytest

from app.services.config.config_manager import ConfigManager
from app.services.config.service import ConfigService
from app.shared.contracts.models.config import (
    ConfigChange,
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
    assert config_service.config_manager.get("services.gateway.api.token_secret") == before


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
