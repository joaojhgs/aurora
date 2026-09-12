"""Auth must keep its audit sink subscribed while lifecycle-disabled.

The gateway fails AdminAction confirmations closed when Auth.StoreAuditEvent is
unreachable, so a node with services.auth.enabled=false (the default) must still
store audit events or every admin-gated action 500s with
``admin_action_audit_failed``.
"""

from __future__ import annotations

import pytest

from app.messaging.local_bus import LocalBus
from app.services.auth.service import AuthService
from app.shared.contracts.models.auth import AuthMethods, StoreAuditEventRequest
from app.shared.contracts.models.db import DBExecuteSQLResponse, DBMethods


@pytest.fixture
async def disabled_auth_service(monkeypatch: pytest.MonkeyPatch):
    import app.messaging.bus_runtime as bus_runtime
    import app.shared.messaging.bus_init as bus_init

    bus = LocalBus(validate_topics=False)
    monkeypatch.setattr(bus_init, "_bus", bus)
    monkeypatch.setattr(bus_runtime, "_bus", bus)
    service = AuthService()
    service._bus = bus

    async def runtime_disabled() -> bool:
        return False

    service._is_runtime_enabled = runtime_disabled
    await service.start()
    yield service, bus
    await service.stop()


@pytest.mark.asyncio
async def test_audit_sink_subscribed_while_auth_disabled(disabled_auth_service):
    service, bus = disabled_auth_service
    assert service._runtime_state == "inactive"

    captured: list[str] = []

    async def fake_execute_sql(envelope):
        captured.append(str(envelope.payload))
        if envelope.reply_to:
            await bus.publish(
                envelope.reply_to,
                DBExecuteSQLResponse(rows=[], rowcount=1),
                event=False,
                correlation_id=envelope.correlation_id,
            )

    bus.subscribe(DBMethods.EXECUTE_SQL, fake_execute_sql)

    result = await bus.request(
        AuthMethods.STORE_AUDIT_EVENT,
        StoreAuditEventRequest(
            event="admin.action.confirmed",
            principal_id="admin",
            details="{}",
        ),
        timeout=5.0,
        origin="internal",
    )

    assert result.ok, result.error
    assert isinstance(result.data, dict)
    assert result.data.get("success") is True
    assert captured, "audit insert should have reached the DB sink"


@pytest.mark.asyncio
async def test_feature_methods_stay_unsubscribed_while_auth_disabled(disabled_auth_service):
    service, bus = disabled_auth_service
    assert service._runtime_state == "inactive"

    from app.shared.contracts.models.mesh import MeshPeerListRequest

    result = await bus.request(
        AuthMethods.MESH_LIST_PEERS,
        MeshPeerListRequest(),
        timeout=0.3,
        origin="internal",
    )
    assert not result.ok, "feature methods must stay offline while auth is disabled"
