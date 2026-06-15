"""BaseService runtime config lifecycle tests."""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from app.messaging.local_bus import LocalBus
from app.services.config.messages import ConfigChangedEvent
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.registry import method_contract
from app.shared.messaging.bus_init import set_bus as set_shared_bus
from app.shared.services.base_service import BaseService


class RuntimeTestResponse(EmptyInput):
    handled: bool = True


class RuntimeLifecycleService(BaseService):
    def __init__(self) -> None:
        self.enabled = True
        self.starts = 0
        self.stops = 0
        self.reload_events: list[ConfigChangedEvent] = []
        super().__init__(
            module="Auth",
            summary="Runtime lifecycle test service",
            capabilities=["testing"],
        )

    async def _is_runtime_enabled(self) -> bool:
        return self.enabled

    async def on_start(self) -> None:
        self.starts += 1

    async def on_stop(self) -> None:
        self.stops += 1

    async def reload(self, config_section: str | None = None) -> None:
        return None

    async def reload_config(self, event: ConfigChangedEvent) -> None:
        self.reload_events.append(event)

    @method_contract(
        method_id="Auth.RuntimeLifecycleTest",
        summary="Runtime lifecycle test method",
        input_model=EmptyInput,
        output_model=RuntimeTestResponse,
        exposure="internal",
    )
    async def handle_runtime_test(self, _data: EmptyInput) -> RuntimeTestResponse:
        return RuntimeTestResponse()


@pytest_asyncio.fixture
async def local_bus():
    bus = LocalBus(validate_topics=False)
    await bus.start()
    set_shared_bus(bus)
    yield bus
    await bus.stop()


@pytest.mark.asyncio
async def test_config_event_decodes_dict_and_pydantic_payloads(local_bus) -> None:
    service = RuntimeLifecycleService()
    await service.start()

    await service._handle_config_changed(
        {
            "key_path": "services.auth.audit_enabled",
            "affected_sections": ["services", "services.auth", "services.auth.audit_enabled"],
            "old_value": False,
            "new_value": True,
        }
    )
    await service._handle_config_changed(
        ConfigChangedEvent(
            key_path="services.auth.default_pairing_permissions",
            affected_sections=[
                "services",
                "services.auth",
                "services.auth.default_pairing_permissions",
            ],
            old_value=[],
            new_value=["TTS.use"],
        )
    )

    assert [event.key_path for event in service.reload_events] == [
        "services.auth.audit_enabled",
        "services.auth.default_pairing_permissions",
    ]
    assert service._config_change_subscription is not None

    await service.stop()


@pytest.mark.asyncio
async def test_enabled_config_deactivates_and_reactivates_contracts(local_bus) -> None:
    service = RuntimeLifecycleService()
    await service.start()

    active = await local_bus.request(
        "Auth.RuntimeLifecycleTest",
        EmptyInput(),
        timeout=1.0,
        max_attempts=1,
    )
    assert active.ok is True
    assert service.starts == 1
    assert service._runtime_state == "active"

    service.enabled = False
    await service._handle_config_changed(
        {
            "key_path": "services.auth.enabled",
            "affected_sections": ["services", "services.auth", "services.auth.enabled"],
            "old_value": True,
            "new_value": False,
        }
    )
    assert service._runtime_state == "inactive"
    assert service.stops == 1
    assert service._contract_subscriptions == []

    inactive = await local_bus.request(
        "Auth.RuntimeLifecycleTest",
        EmptyInput(),
        timeout=0.1,
        max_attempts=1,
    )
    assert inactive.ok is False

    service.enabled = True
    await service._handle_config_changed(
        {
            "key_path": "services.auth.enabled",
            "affected_sections": ["services", "services.auth", "services.auth.enabled"],
            "old_value": False,
            "new_value": True,
        }
    )
    await asyncio.sleep(0)

    reactivated = await local_bus.request(
        "Auth.RuntimeLifecycleTest",
        EmptyInput(),
        timeout=1.0,
        max_attempts=1,
    )
    assert reactivated.ok is True
    assert service.starts == 2
    assert service._runtime_state == "active"

    await service.stop()
