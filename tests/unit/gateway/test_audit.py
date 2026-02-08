"""Unit tests for the audit logging helper."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.services.gateway.acl.audit import audit_event


@pytest.fixture
def mock_db_manager():
    db = AsyncMock()
    db.store_audit_event = AsyncMock()
    return db


@pytest.mark.asyncio
async def test_audit_event_basic(mock_db_manager):
    """Basic audit event is stored with all fields."""
    await audit_event(
        mock_db_manager,
        "auth.login",
        principal_id="user-1",
        details={"method": "password"},
        ip_address="192.168.1.1",
    )

    mock_db_manager.store_audit_event.assert_called_once()
    call_kwargs = mock_db_manager.store_audit_event.call_args[1]
    assert call_kwargs["event"] == "auth.login"
    assert call_kwargs["principal_id"] == "user-1"
    assert '"method": "password"' in call_kwargs["details"]
    assert call_kwargs["ip_address"] == "192.168.1.1"
    # event_id should be a UUID string
    assert len(call_kwargs["event_id"]) == 36


@pytest.mark.asyncio
async def test_audit_event_minimal(mock_db_manager):
    """Audit event with only event name."""
    await audit_event(mock_db_manager, "peer.connected")

    mock_db_manager.store_audit_event.assert_called_once()
    call_kwargs = mock_db_manager.store_audit_event.call_args[1]
    assert call_kwargs["event"] == "peer.connected"
    assert call_kwargs["principal_id"] is None
    assert call_kwargs["details"] is None
    assert call_kwargs["ip_address"] is None


@pytest.mark.asyncio
async def test_audit_event_with_details_dict(mock_db_manager):
    """Details dict is serialized to JSON string."""
    await audit_event(
        mock_db_manager,
        "access.denied.rpc",
        details={"method": "Svc.Secret", "required": ["admin"]},
    )

    call_kwargs = mock_db_manager.store_audit_event.call_args[1]
    import json

    details = json.loads(call_kwargs["details"])
    assert details["method"] == "Svc.Secret"
    assert details["required"] == ["admin"]


@pytest.mark.asyncio
async def test_audit_event_db_failure_does_not_raise(mock_db_manager):
    """If the DB call fails, audit_event swallows the exception."""
    mock_db_manager.store_audit_event.side_effect = RuntimeError("DB down")

    # Should NOT raise
    await audit_event(mock_db_manager, "some.event", principal_id="user-1")


@pytest.mark.asyncio
async def test_audit_event_empty_details(mock_db_manager):
    """Empty details dict is treated as falsy → stored as None."""
    await audit_event(mock_db_manager, "test.event", details={})

    call_kwargs = mock_db_manager.store_audit_event.call_args[1]
    # Empty dict is falsy in Python, so audit_event stores None
    assert call_kwargs["details"] is None


@pytest.mark.asyncio
async def test_audit_event_none_details(mock_db_manager):
    """None details is stored as None."""
    await audit_event(mock_db_manager, "test.event", details=None)

    call_kwargs = mock_db_manager.store_audit_event.call_args[1]
    assert call_kwargs["details"] is None
