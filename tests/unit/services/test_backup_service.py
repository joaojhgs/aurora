"""BackupService contract behavior tests."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.messaging.bus import QueryResult
from app.services.backup import BackupService
from app.services.config.messages import GetConfigQuery
from app.shared.contracts.models.backup import (
    BackupCreateRequest,
    BackupListRequest,
    BackupMethods,
    BackupModule,
    BackupRestoreRequest,
    BackupRollbackRequest,
    BackupStorageTarget,
    BackupVerifyRequest,
)
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.db import DBMethods, DBRAGListNamespacesResponse
from app.shared.contracts.registry import list_modules
from app.shared.messaging.bus_init import set_bus


@pytest.fixture
def mock_bus():
    bus = AsyncMock()

    async def request(topic, payload, **_kwargs):
        if topic == ConfigMethods.GET:
            return QueryResult(
                ok=True,
                data={"config": {"services": {"gateway": {"token_secret": "secret-value"}}}},
            )
        if topic == DBMethods.RAG_LIST_NAMESPACES:
            return QueryResult(ok=True, data=DBRAGListNamespacesResponse(namespaces=[]))
        return QueryResult(ok=True, data={})

    bus.request.side_effect = request
    set_bus(bus)
    return bus


@pytest.mark.asyncio
async def test_backup_contracts_are_external_manage_methods(tmp_path, mock_bus):
    BackupService(backup_dir=tmp_path)
    contract = list_modules()[BackupModule.NAME]

    methods = {
        method.bus_topic: method
        for method in contract.methods
        if method.bus_topic in vars(BackupMethods).values()
    }

    assert methods[BackupMethods.CREATE].exposure == "external"
    assert methods[BackupMethods.CREATE].method_type == "manage"
    assert methods[BackupMethods.CREATE].required_perms == ["Backup.manage"]
    assert methods[BackupMethods.RESTORE].method_type == "manage"
    assert methods[BackupMethods.ROLLBACK].required_perms == ["Backup.manage"]


@pytest.mark.asyncio
async def test_create_list_and_verify_backup_manifest_redacts_storage(tmp_path, mock_bus):
    service = BackupService(backup_dir=tmp_path)
    await service.on_start()

    response = await service.create_backup(
        BackupCreateRequest(
            reason="pre-upgrade",
            storage=BackupStorageTarget(
                encryption="passphrase",
                key_ref="operator-key",
                credential_ref="raw-secret-ref",
                metadata={"api_key": "secret", "region": "local"},
            ),
        )
    )

    assert response.status == "ok"
    assert response.backup is not None
    assert response.backup.encrypted is True
    assert response.backup.secrets_redacted is True
    assert response.backup.storage.credential_ref is None
    assert response.backup.storage.metadata["api_key"] == "[redacted]"
    assert any(component.component == "config" for component in response.backup.components)
    assert response.audit_receipt.startswith("bar_")

    listed = await service.list_backups(BackupListRequest())
    assert listed.total == 1
    assert listed.backups[0].backup_id == response.backup.backup_id

    verified = await service.verify_backup(BackupVerifyRequest(backup_id=response.backup.backup_id))
    assert verified.status == "ok"
    assert verified.verified is True

    mock_bus.request.assert_any_await(
        ConfigMethods.GET,
        GetConfigQuery(section=None),
        timeout=10.0,
    )


@pytest.mark.asyncio
async def test_restore_dry_run_returns_admin_critical_impact_plan(tmp_path, mock_bus):
    service = BackupService(backup_dir=tmp_path)
    await service.on_start()
    created = await service.create_backup(BackupCreateRequest(reason="before restore test"))
    assert created.backup is not None

    response = await service.restore_backup(
        BackupRestoreRequest(backup_id=created.backup.backup_id, reason="verify impact")
    )

    assert response.status == "ok"
    assert response.restored is False
    assert response.impact_plan.admin_critical is True
    assert response.impact_plan.requires_quiesce is True
    assert response.impact_plan.requires_restart is True
    assert {impact.service for impact in response.impact_plan.affected_services} >= {
        "ConfigService",
        "DBService",
        "GatewayService",
    }


@pytest.mark.asyncio
async def test_destructive_restore_and_rollback_are_explicitly_unsupported(tmp_path, mock_bus):
    service = BackupService(backup_dir=tmp_path)
    await service.on_start()
    created = await service.create_backup(BackupCreateRequest(reason="before restore test"))
    assert created.backup is not None

    restore = await service.restore_backup(
        BackupRestoreRequest(
            backup_id=created.backup.backup_id,
            reason="attempt destructive restore",
            dry_run=False,
        )
    )
    rollback = await service.rollback_restore(
        BackupRollbackRequest(
            rollback_backup_id=created.backup.backup_id,
            reason="attempt destructive rollback",
            dry_run=False,
        )
    )

    assert restore.status == "unsupported"
    assert restore.restored is False
    assert rollback.status == "unsupported"
    assert rollback.rolled_back is False
