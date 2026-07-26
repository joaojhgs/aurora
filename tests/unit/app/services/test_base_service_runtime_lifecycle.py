"""BaseService runtime config lifecycle tests."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from app.messaging.local_bus import LocalBus
from app.services.config.messages import ConfigChangedEvent
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.registry import clear_registry, method_contract
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


class CallableFeatureAnnouncementService(BaseService):
    def __init__(self) -> None:
        super().__init__(module="TTS", summary="Feature announcement test")

    async def _is_runtime_enabled(self) -> bool:
        return True

    async def on_start(self) -> None:
        return None

    async def on_stop(self) -> None:
        return None

    async def reload(self, config_section: str | None = None) -> None:
        return None

    @method_contract(
        method_id="TTS.Synthesize",
        summary="Synthesize test audio",
        input_model=EmptyInput,
        output_model=RuntimeTestResponse,
        exposure="both",
        method_type="use",
        required_perms=["TTS.Synthesize"],
        callable_feature_ids=["speech_synthesis"],
    )
    async def synthesize(self, _data: EmptyInput) -> RuntimeTestResponse:
        return RuntimeTestResponse()


class InvalidPermissionlessCallableService(BaseService):
    def __init__(self) -> None:
        super().__init__(module="TTS", summary="Invalid callable test")

    async def _is_runtime_enabled(self) -> bool:
        return True

    async def on_start(self) -> None:
        return None

    async def on_stop(self) -> None:
        return None

    async def reload(self, config_section: str | None = None) -> None:
        return None

    @method_contract(
        method_id="TTS.Request",
        summary="Invalid permissionless external callable",
        input_model=EmptyInput,
        output_model=RuntimeTestResponse,
        exposure="both",
        method_type="use",
        callable_feature_ids=["speech_playback"],
    )
    async def request(self, _data: EmptyInput) -> RuntimeTestResponse:
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
async def test_service_announcement_carries_callable_feature_metadata(local_bus) -> None:
    from app.shared.contracts.models.gateway import GatewayMethods, ServiceAnnouncement

    clear_registry()
    announcements: list[ServiceAnnouncement] = []
    announcement_received = asyncio.Event()

    async def capture(envelope) -> None:
        announcements.append(envelope.payload)
        announcement_received.set()

    local_bus.subscribe(GatewayMethods.SERVICE_ANNOUNCE, capture)
    try:
        service = CallableFeatureAnnouncementService()
        await service.start()

        await asyncio.wait_for(announcement_received.wait(), timeout=1)
        announcement = announcements[-1]
        assert announcement.module == "TTS"
        assert [feature.feature_id for feature in announcement.callable_features] == [
            "speech_playback",
            "speech_streaming",
            "speech_synthesis",
        ]
        assert [method.bus_topic for method in announcement.methods] == ["TTS.Synthesize"]
        method = announcement.methods[0]
        assert method.required_perms == ["TTS.Synthesize"]
        assert method.callable_feature_ids == ["speech_synthesis"]
        assert method.callable_features[0].feature_id == "speech_synthesis"
        await service.stop()
    finally:
        local_bus.unsubscribe(GatewayMethods.SERVICE_ANNOUNCE, capture)
        clear_registry()


@pytest.mark.asyncio
async def test_invalid_permissionless_callable_contract_never_subscribes(local_bus) -> None:
    """BaseService construction failure prevents the old raw-decorator startup bypass."""

    clear_registry()

    with pytest.raises(ValueError, match="missing required_perms"):
        InvalidPermissionlessCallableService()

    assert "TTS.Request" not in local_bus._subs
    clear_registry()


@pytest.mark.asyncio
async def test_default_reload_routes_service_leaf_to_owning_service_section(local_bus) -> None:
    """A Gateway leaf update must not look like a broad all-services reload."""
    service = RuntimeLifecycleService()
    service.reload = AsyncMock()

    event = ConfigChangedEvent(
        key_path="services.gateway.webrtc.room",
        affected_sections=[
            "services",
            "services.gateway",
            "services.gateway.webrtc",
            "services.gateway.webrtc.room",
        ],
        old_value="old-room",
        new_value="new-room",
    )

    await BaseService.reload_config(service, event)

    service.reload.assert_awaited_once_with("services.gateway")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key_path", "expected_section"),
    [
        ("services.tooling.mcp.servers.local.command", "services.tooling.mcp"),
        ("services.tooling.plugins.github.activate", "services.tooling.plugins"),
        (
            "services.tooling.approval_policy.default_share",
            "services.tooling",
        ),
    ],
)
async def test_default_reload_preserves_tooling_runtime_manager_boundaries(
    local_bus, key_path: str, expected_section: str
) -> None:
    """Only manager-owned Tooling subtrees receive a manager-specific reload."""
    service = RuntimeLifecycleService()
    service.reload = AsyncMock()
    parts = key_path.split(".")
    affected_sections = [".".join(parts[:index]) for index in range(1, len(parts) + 1)]

    await BaseService.reload_config(
        service,
        ConfigChangedEvent(
            key_path=key_path,
            affected_sections=affected_sections,
            old_value=None,
            new_value=True,
        ),
    )

    service.reload.assert_awaited_once_with(expected_section)


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
