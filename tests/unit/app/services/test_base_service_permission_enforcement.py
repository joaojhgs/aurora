"""Bus-ingress permission enforcement tests for BaseService contracts."""

import pytest

from app.messaging.local_bus import LocalBus
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.registry import method_contract
from app.shared.messaging.bus_init import set_bus
from app.shared.services.base_service import BaseService


class PermissionedTestService(BaseService):
    def __init__(self):
        self.executed = False
        super().__init__("PermissionedTest", summary="permission test service")

    async def on_start(self) -> None:
        return None

    async def on_stop(self) -> None:
        return None

    async def reload(self, config_section: str | None = None) -> None:
        return None

    @method_contract(
        method_id="PermissionedTest.DoThing",
        summary="Do a permissioned thing",
        input_model=EmptyInput,
        output_model=EmptyOutput,
        exposure="both",
        method_type="manage",
        required_perms=["PermissionedTest.manage"],
    )
    async def do_thing(self, request: EmptyInput) -> EmptyOutput:
        self.executed = True
        return EmptyOutput()


@pytest.mark.asyncio
async def test_external_bus_ingress_without_required_permissions_is_denied():
    bus = LocalBus(validate_topics=False)
    await bus.start()
    set_bus(bus)
    service = PermissionedTestService()
    await service._subscribe_registered_contracts()
    try:
        result = await bus.request(
            "PermissionedTest.DoThing",
            EmptyInput(),
            origin="external",
            identity_source="gateway_http",
            principal_id="principal-1",
            effective_perms=["PermissionedTest.read"],
            method_type="manage",
            timeout=1.0,
        )

        assert result.ok is False
        assert result.error == "Forbidden"
        assert result.data["code"] == "FORBIDDEN"
        assert service.executed is False
    finally:
        await bus.stop()


@pytest.mark.parametrize(
    "effective_perms",
    [
        ["PermissionedTest.manage"],
        ["PermissionedTest.*"],
        ["*"],
    ],
)
@pytest.mark.asyncio
async def test_external_bus_ingress_accepts_type_wildcard_and_superuser_permissions(
    effective_perms,
):
    bus = LocalBus(validate_topics=False)
    await bus.start()
    set_bus(bus)
    service = PermissionedTestService()
    await service._subscribe_registered_contracts()
    try:
        result = await bus.request(
            "PermissionedTest.DoThing",
            EmptyInput(),
            origin="external",
            identity_source="gateway_http",
            principal_id="principal-1",
            effective_perms=effective_perms,
            method_type="manage",
            timeout=1.0,
        )

        assert result.ok is True
        assert service.executed is True
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_external_bus_ingress_without_effective_permissions_is_denied():
    bus = LocalBus(validate_topics=False)
    await bus.start()
    set_bus(bus)
    service = PermissionedTestService()
    await service._subscribe_registered_contracts()
    try:
        result = await bus.request(
            "PermissionedTest.DoThing",
            EmptyInput(),
            origin="external",
            identity_source="mesh_peer",
            principal_id="principal-1",
            effective_perms=[],
            method_type="manage",
            caller_peer_id="peer-low-permission",
            timeout=1.0,
        )

        assert result.ok is False
        assert result.error == "Forbidden"
        assert result.data["code"] == "FORBIDDEN"
        assert service.executed is False
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_internal_bus_ingress_keeps_system_bypass_for_service_calls():
    bus = LocalBus(validate_topics=False)
    await bus.start()
    set_bus(bus)
    service = PermissionedTestService()
    await service._subscribe_registered_contracts()
    try:
        result = await bus.request(
            "PermissionedTest.DoThing",
            EmptyInput(),
            origin="system",
            identity_source="internal_service",
            method_type="manage",
            timeout=1.0,
        )

        assert result.ok is True
        assert service.executed is True
    finally:
        await bus.stop()
