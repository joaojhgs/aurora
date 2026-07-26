"""Unit tests for gateway config hot-reload (auth settings)."""

from __future__ import annotations

import asyncio
import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from app.messaging.bus import QueryResult
from app.services.config.config_manager import ConfigManager
from app.services.gateway.acl.identity import Identity
from app.services.gateway.config import MeshConfig, PermissionSettings, Settings
from app.services.gateway.webrtc.rpc import RPCHandler
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


def _active_projection(*, services: list, recipient: str = "stable-peer"):
    return SimpleNamespace(
        cache_key=SimpleNamespace(recipient_peer_id=recipient, provider_peer_id="provider-a"),
        readiness="ready",
        routable=True,
        services=services,
    )


def _projected_service(module: str, *topics: str):
    return SimpleNamespace(
        service_id=module,
        capacity={"max_concurrent": 0},
        methods=[
            SimpleNamespace(
                topic=topic,
                required_permissions=(topic,),
                method_type="use",
            )
            for topic in topics
        ],
    )


@pytest.fixture
def mock_gateway_service():
    """Create a GatewayService instance with mocked internals."""
    from app.services.gateway.service import GatewayService

    service = GatewayService()
    service._gateway_enabled = True
    return service


@pytest.mark.asyncio
async def test_reload_auth_config_updates_rtc_timeout(mock_gateway_service):
    """Config reload updates the WebRTC auth timeout on the RTCClient."""
    service = mock_gateway_service

    # Mock RTCClient
    mock_rtc = MagicMock()
    mock_rtc._auth_timeout = 10.0
    service._rtc_client = mock_rtc

    # Mock _get_gateway_config to return settings with new timeout
    new_settings = Settings()
    new_settings.permissions.webrtc_auth_timeout_seconds = 30.0

    service._get_gateway_config = AsyncMock(return_value=new_settings)

    await service._reload_auth_config()

    # Verify timeout was updated
    assert mock_rtc._auth_timeout == 30.0


@pytest.mark.asyncio
async def test_reload_auth_config_no_rtc_client(mock_gateway_service):
    """Config reload doesn't crash when RTCClient is None."""
    service = mock_gateway_service
    service._rtc_client = None

    new_settings = Settings()
    new_settings.permissions.webrtc_auth_timeout_seconds = 20.0
    service._get_gateway_config = AsyncMock(return_value=new_settings)

    # Should not raise
    await service._reload_auth_config()


@pytest.mark.asyncio
async def test_reload_calls_auth_config(mock_gateway_service):
    """GatewayService.reload() calls _reload_auth_config."""
    service = mock_gateway_service

    service._reload_gateway_config = AsyncMock()
    service._reload_auth_config = AsyncMock()

    await service.reload(config_section="gateway")

    service._reload_gateway_config.assert_called_once()
    service._reload_auth_config.assert_called_once()


@pytest.mark.asyncio
async def test_reload_none_section_triggers_auth_reload(mock_gateway_service):
    """reload(None) triggers auth config reload."""
    service = mock_gateway_service

    service._reload_gateway_config = AsyncMock()
    service._reload_auth_config = AsyncMock()

    await service.reload(config_section=None)

    service._reload_auth_config.assert_called_once()


def test_permission_settings_defaults():
    """PermissionSettings has sensible defaults."""
    ps = PermissionSettings()
    assert ps.default_pairing_permissions == []
    assert ps.webrtc_auth_timeout_seconds == 10.0


def test_settings_includes_permissions():
    """Settings model includes the permissions section."""
    s = Settings()
    assert hasattr(s, "permissions")
    assert isinstance(s.permissions, PermissionSettings)


def _active_mesh_settings() -> Settings:
    settings = Settings()
    settings.api.enabled = True
    settings.mesh = settings.mesh.model_copy(update={"enabled": True})
    settings.webrtc.enabled = True
    settings.webrtc.app_id = "private-app-id"
    settings.webrtc.room = "private-room"
    settings.webrtc.password = "private-password"
    return settings


def _set_nested_attr(target: object, path: str, value: object) -> None:
    parent = target
    parts = path.split(".")
    for part in parts[:-1]:
        parent = getattr(parent, part)
    setattr(parent, parts[-1], value)


def _mock_transport_lifecycle(service, new_settings: Settings) -> MagicMock:
    """Attach stateful lifecycle mocks so later reload phases see real transitions."""
    lifecycle = MagicMock()

    async def stop_mesh() -> None:
        service._mesh_bus = None

    async def stop_webrtc() -> None:
        service._rtc_client = None
        service._rtc_transport_fingerprint = None

    async def start_webrtc(_settings: Settings | None = None) -> None:
        from app.services.gateway.service import _rtc_transport_config_fingerprint

        replacement = MagicMock()
        replacement._settings = new_settings
        service._rtc_client = replacement
        service._rtc_transport_fingerprint = _rtc_transport_config_fingerprint(new_settings)

    async def start_mesh() -> None:
        service._mesh_bus = MagicMock()

    for name, side_effect in (
        ("stop_mesh", stop_mesh),
        ("stop_webrtc", stop_webrtc),
        ("start_webrtc", start_webrtc),
        ("start_mesh", start_mesh),
    ):
        mock = AsyncMock(side_effect=side_effect)
        setattr(service, f"_{name}", mock)
        lifecycle.attach_mock(mock, name)

    return lifecycle


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("changed_path", "new_value"),
    [
        ("webrtc.app_id", "different-private-app-id"),
        ("webrtc.room", "different-private-room"),
        ("webrtc.password", "different-private-password"),
        ("webrtc.strategy", "memory"),
        ("signaling_mqtt.brokers", ["wss://mqtt.example.test:443/mqtt"]),
    ],
)
async def test_transport_fingerprint_change_restarts_rtc_then_mesh(
    mock_gateway_service,
    changed_path,
    new_value,
):
    """Live signaling changes require rebuilding RTC and its dependent mesh graph."""
    service = mock_gateway_service

    old_settings = _active_mesh_settings()
    new_settings = old_settings.model_copy(deep=True)
    _set_nested_attr(new_settings, changed_path, new_value)

    old_rtc = MagicMock()
    old_rtc._settings = old_settings
    service._rtc_client = old_rtc
    service._mesh_bus = MagicMock()
    service._get_gateway_config = AsyncMock(return_value=new_settings)
    service._ensure_mesh_prerequisites = AsyncMock(return_value=True)
    from app.services.gateway.service import _rtc_transport_config_fingerprint

    service._rtc_transport_fingerprint = _rtc_transport_config_fingerprint(old_settings)
    lifecycle = _mock_transport_lifecycle(service, new_settings)

    event = SimpleNamespace(
        key_path=f"services.gateway.{changed_path}",
        affected_sections=[],
        old_value=None,
        new_value=new_value,
    )
    await service.reload_config(event)

    assert lifecycle.mock_calls == [
        call.stop_mesh(),
        call.stop_webrtc(),
        call.start_webrtc(new_settings),
        call.start_mesh(),
    ]


@pytest.mark.asyncio
async def test_enabling_mesh_restarts_standalone_rtc_before_mesh_bootstrap(
    mock_gateway_service,
):
    """Open standalone sessions cannot survive the transition into mesh auth."""
    service = mock_gateway_service
    old_settings = _active_mesh_settings()
    old_settings.mesh = old_settings.mesh.model_copy(update={"enabled": False})
    old_settings.permissions.enabled = False
    new_settings = old_settings.model_copy(deep=True)
    new_settings.mesh = new_settings.mesh.model_copy(update={"enabled": True})

    old_rtc = MagicMock()
    old_rtc._settings = old_settings
    service._rtc_client = old_rtc
    service._mesh_bus = None
    service._get_gateway_config = AsyncMock(return_value=new_settings)
    service._ensure_mesh_prerequisites = AsyncMock(return_value=True)
    from app.services.gateway.service import _rtc_transport_config_fingerprint

    service._rtc_transport_fingerprint = _rtc_transport_config_fingerprint(old_settings)
    lifecycle = _mock_transport_lifecycle(service, new_settings)

    await service.reload_config(
        SimpleNamespace(
            key_path="services.gateway.mesh_network.enabled",
            affected_sections=[],
            old_value=False,
            new_value=True,
        )
    )

    assert lifecycle.mock_calls == [
        call.stop_mesh(),
        call.stop_webrtc(),
        call.start_webrtc(new_settings),
        call.start_mesh(),
    ]


@pytest.mark.asyncio
async def test_unchanged_transport_fingerprint_does_not_restart_rtc_or_mesh(
    mock_gateway_service,
):
    """Non-transport reloads must leave healthy RTC and mesh sessions intact."""
    service = mock_gateway_service

    old_settings = _active_mesh_settings()
    new_settings = old_settings.model_copy(deep=True)
    old_rtc = MagicMock()
    old_rtc._settings = old_settings
    service._rtc_client = old_rtc
    service._mesh_bus = MagicMock()
    service._get_gateway_config = AsyncMock(return_value=new_settings)
    service._ensure_mesh_prerequisites = AsyncMock(return_value=True)
    from app.services.gateway.service import _rtc_transport_config_fingerprint

    service._rtc_transport_fingerprint = _rtc_transport_config_fingerprint(old_settings)
    lifecycle = _mock_transport_lifecycle(service, new_settings)

    event = SimpleNamespace(
        key_path="services.auth.webrtc_auth_timeout_seconds",
        affected_sections=[],
        old_value=10.0,
        new_value=20.0,
    )
    await service.reload_config(event)

    assert lifecycle.mock_calls == []


@pytest.mark.asyncio
async def test_service_mesh_sharing_change_triggers_gateway_mesh_reload(
    mock_gateway_service,
):
    """Service sharing policy is part of Gateway's live mesh configuration."""
    service = mock_gateway_service
    service._reload_gateway_config = AsyncMock()
    service._reload_auth_config = AsyncMock()
    service._reload_mesh_config = AsyncMock()

    await service.reload_config(
        SimpleNamespace(
            key_path="services.tooling.mesh_sharing.share",
            affected_sections=["services.tooling.mesh_sharing"],
            old_value=False,
            new_value=True,
        )
    )

    service._reload_gateway_config.assert_awaited_once()
    service._reload_auth_config.assert_awaited_once()
    service._reload_mesh_config.assert_awaited_once()


@pytest.mark.asyncio
async def test_grouped_service_row_changed_paths_trigger_single_gateway_reload(
    mock_gateway_service,
):
    service = mock_gateway_service
    service._reload_gateway_config = AsyncMock()
    service._reload_auth_config = AsyncMock()
    service._reload_mesh_config = AsyncMock()

    await service.reload_config(
        SimpleNamespace(
            key_path="services.tts",
            affected_sections=["services", "services.tts"],
            changed_paths=[
                "services.tts.mesh_sharing.prefer",
                "services.tts.mesh_routing.prefer",
            ],
            old_value=None,
            new_value=None,
        )
    )

    service._reload_gateway_config.assert_awaited_once()
    service._reload_auth_config.assert_awaited_once()
    service._reload_mesh_config.assert_awaited_once()


@pytest.mark.asyncio
async def test_manager_grouped_legacy_service_row_event_triggers_single_gateway_reload(
    mock_gateway_service,
    monkeypatch,
    tmp_path,
):
    original = ConfigManager._instance
    ConfigManager._instance = None
    monkeypatch.setenv("AURORA_CONFIG_FILE", str(tmp_path / "config.json"))
    try:
        manager = ConfigManager()
        events = []
        manager.add_observer(
            lambda key, old, new, metadata=None: events.append((key, old, new, metadata))
        )
        old_shape = deepcopy(manager.get("services.tts"))
        old_shape.pop("mesh_routing", None)
        old_shape["mesh_sharing"]["prefer"] = "network"

        manager.set("services.tts", old_shape)

        service = mock_gateway_service
        service._reload_gateway_config = AsyncMock()
        service._reload_auth_config = AsyncMock()
        service._reload_mesh_config = AsyncMock()
        key_path, old_value, new_value, metadata = events[0]
        await service.reload_config(
            SimpleNamespace(
                key_path=key_path,
                affected_sections=metadata["affected_sections"],
                changed_paths=metadata["changed_paths"],
                old_value=old_value,
                new_value=new_value,
            )
        )

        assert key_path == "services.tts"
        assert "services.tts.mesh_sharing.prefer" in metadata["changed_paths"]
        service._reload_gateway_config.assert_awaited_once()
        service._reload_auth_config.assert_awaited_once()
        service._reload_mesh_config.assert_awaited_once()
    finally:
        ConfigManager._instance = original


@pytest.mark.asyncio
async def test_grouped_mesh_routing_only_changed_paths_trigger_gateway_reload(
    mock_gateway_service,
):
    service = mock_gateway_service
    service._reload_gateway_config = AsyncMock()
    service._reload_auth_config = AsyncMock()
    service._reload_mesh_config = AsyncMock()

    await service.reload_config(
        SimpleNamespace(
            key_path="services.tts",
            affected_sections=["services", "services.tts"],
            changed_paths=[
                "services.tts.mesh_routing.prefer",
                "services.tts.mesh_routing.fallback",
            ],
            old_value=None,
            new_value=None,
        )
    )

    service._reload_gateway_config.assert_awaited_once()
    service._reload_auth_config.assert_awaited_once()
    service._reload_mesh_config.assert_awaited_once()


@pytest.mark.asyncio
async def test_reload_mesh_config_updates_rtc_and_reannounces_manifest(
    mock_gateway_service,
):
    """A live sharing change reaches manifest generation without a restart."""
    service = mock_gateway_service
    settings = _active_mesh_settings()
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._mesh_bus = MagicMock()
    service._mesh_peer_registry = MagicMock()
    service._mesh_routing_table = MagicMock()
    service._mesh_peer_bridge = MagicMock()
    service._rtc_client = MagicMock()
    service._rtc_client.reannounce_manifest = AsyncMock()

    await service._reload_mesh_config()

    service._rtc_client.update_mesh_config.assert_called_once_with(
        settings.mesh,
        policy_provider=service._mesh_policy_provider,
    )
    service._rtc_client.reannounce_manifest.assert_awaited_once()


@pytest.mark.asyncio
async def test_reload_mesh_config_swap_survives_reannounce_failure_and_schedules_retry(
    mock_gateway_service,
):
    service = mock_gateway_service
    settings = _active_mesh_settings()
    settings.mesh = MeshConfig(
        enabled=True,
        services={"TTS": mesh_policy(share=False)},
    )
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._mesh_bus = MagicMock()
    service._mesh_peer_registry = MagicMock()
    service._mesh_routing_table = MagicMock()
    service._rtc_client = MagicMock()
    service._rtc_client.reannounce_manifest = AsyncMock(side_effect=RuntimeError("boom"))

    await service._reload_mesh_config(source_revision=44)

    assert service._mesh_policy_store.current().source_revision == 44
    assert service._mesh_policy_store.current().mesh_config.services["TTS"].export.share is False
    assert service._mesh_policy_retry_task is not None
    assert service._mesh_policy_retry_revision == service._mesh_policy_store.current().revision
    service._rtc_client.reannounce_manifest.assert_awaited_once()

    retry_task = service._cancel_mesh_policy_retry()
    if retry_task:
        with pytest.raises(asyncio.CancelledError):
            await retry_task


@pytest.mark.asyncio
async def test_reload_mesh_config_partial_reannounce_schedules_retry(mock_gateway_service):
    service = mock_gateway_service
    settings = _active_mesh_settings()
    settings.mesh = MeshConfig(
        enabled=True,
        services={"TTS": mesh_policy(share=True)},
    )
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._mesh_bus = MagicMock()
    service._mesh_peer_registry = MagicMock()
    service._mesh_routing_table = MagicMock()
    service._rtc_client = MagicMock()
    service._rtc_client.reannounce_manifest = AsyncMock(return_value=False)

    await service._reload_mesh_config(source_revision=45)

    assert service._mesh_policy_retry_revision == service._mesh_policy_store.current().revision
    retry_task = service._cancel_mesh_policy_retry()
    if retry_task:
        with pytest.raises(asyncio.CancelledError):
            await retry_task


@pytest.mark.asyncio
async def test_mesh_policy_retry_coalesces_to_latest_revision(mock_gateway_service, monkeypatch):
    import app.services.gateway.service as gateway_service_module

    monkeypatch.setattr(gateway_service_module, "_MESH_START_RETRY_INITIAL_DELAY_S", 0.001)
    monkeypatch.setattr(gateway_service_module, "_MESH_START_RETRY_MAX_DELAY_S", 0.001)

    service = mock_gateway_service
    service._rtc_client = MagicMock()
    calls = 0

    async def reannounce() -> bool:
        nonlocal calls
        calls += 1
        if calls == 1:
            service._mesh_policy_retry_revision = 2
        else:
            service._mesh_policy_retry_revision = None
        return True

    service._rtc_client.reannounce_manifest = AsyncMock(side_effect=reannounce)
    service._mesh_policy_retry_revision = 1
    await service._mesh_policy_retry_loop()

    assert calls == 2


@pytest.mark.asyncio
async def test_mesh_policy_retry_treats_false_then_true_as_retry(mock_gateway_service, monkeypatch):
    import app.services.gateway.service as gateway_service_module

    monkeypatch.setattr(gateway_service_module, "_MESH_START_RETRY_INITIAL_DELAY_S", 0.001)
    monkeypatch.setattr(gateway_service_module, "_MESH_START_RETRY_MAX_DELAY_S", 0.001)

    service = mock_gateway_service
    service._rtc_client = MagicMock()
    service._rtc_client.reannounce_manifest = AsyncMock(side_effect=[False, True])
    service._mesh_policy_retry_revision = 1

    await service._mesh_policy_retry_loop()

    assert service._rtc_client.reannounce_manifest.await_count == 2
    assert service._mesh_policy_retry_revision is None


@pytest.mark.asyncio
async def test_mesh_policy_retry_schedule_is_single_latest_task(mock_gateway_service):
    service = mock_gateway_service

    service._schedule_mesh_policy_retry(1)
    first_task = service._mesh_policy_retry_task
    service._schedule_mesh_policy_retry(2)

    assert service._mesh_policy_retry_task is first_task
    assert service._mesh_policy_retry_revision == 2
    retry_task = service._cancel_mesh_policy_retry()
    if retry_task:
        with pytest.raises(asyncio.CancelledError):
            await retry_task


@pytest.mark.asyncio
async def test_stop_mesh_cancels_policy_retry(mock_gateway_service):
    service = mock_gateway_service
    service._mesh_bus = None
    service._schedule_mesh_policy_retry(1)
    retry_task = service._mesh_policy_retry_task

    await service._stop_mesh()

    assert service._mesh_policy_retry_task is None
    assert service._mesh_policy_retry_revision is None
    assert retry_task is None or retry_task.cancelled()


@pytest.mark.asyncio
async def test_stop_mesh_once_cleans_partial_mesh_without_mesh_bus(mock_gateway_service):
    service = mock_gateway_service
    inner_bus = MagicMock()
    service._mesh_policy_store.replace(
        MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)}),
        source_revision=1,
    )

    announcer = MagicMock()
    announcer.stop = AsyncMock(side_effect=RuntimeError("announcer failed"))
    latency_monitor = MagicMock()
    latency_monitor.stop = AsyncMock()
    registry = MagicMock()
    registry.stop = AsyncMock()
    bridge = MagicMock()
    bridge.cancel_all = AsyncMock()
    rtc_client = MagicMock()

    service._mesh_bus = None
    service._mesh_announcer = announcer
    service._mesh_latency_monitor = latency_monitor
    service._mesh_peer_registry = registry
    service._mesh_peer_bridge = bridge
    service._mesh_routing_table = MagicMock()
    service._mesh_peer_id = "local-peer"
    service._rtc_client = rtc_client

    with (
        patch("app.messaging.bus_runtime.set_bus") as set_runtime_bus,
        patch("app.shared.messaging.bus_init.set_bus") as set_shared_bus,
    ):
        await service._stop_mesh_once(inner_bus=inner_bus)

    announcer.stop.assert_awaited_once()
    latency_monitor.stop.assert_awaited_once()
    registry.stop.assert_awaited_once()
    bridge.cancel_all.assert_awaited_once()
    set_runtime_bus.assert_called_once_with(inner_bus)
    set_shared_bus.assert_called_once_with(inner_bus)
    rtc_client.set_rpc_bus.assert_called_once_with(inner_bus)
    rtc_client.set_on_token_saved.assert_called_once_with(None)
    rtc_client.disable_mesh.assert_called_once_with(policy_provider=service._mesh_policy_provider)
    assert service._mesh_announcer is None
    assert service._mesh_latency_monitor is None
    assert service._mesh_peer_registry is None
    assert service._mesh_peer_bridge is None
    assert service._mesh_routing_table is None
    assert service._mesh_bus is None
    assert service._mesh_peer_id is None
    assert service._mesh_policy_store.current().mesh_config.enabled is False


@pytest.mark.asyncio
async def test_existing_rpc_handler_observes_reload_policy_before_failed_reannounce(
    mock_gateway_service,
):
    service = mock_gateway_service
    initial = MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)})
    service._mesh_policy_store.replace(initial, source_revision=1)

    bus = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"status": "ok"}))
    registry = AsyncMock()
    registry.get_service = AsyncMock(
        return_value=ServiceAnnouncement(
            module="TTS",
            version="1.0",
            methods=[MethodInfo(name="Request", bus_topic="TTS.Request", exposure="external")],
        )
    )
    registry.get_external_methods = AsyncMock(return_value=[])
    sent: list[str] = []
    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset({"TTS.Request"}),
        source="webrtc_peer",
    )
    handler = RPCHandler(
        bus,
        registry,
        sent.append,
        lambda: identity,
        mesh_config=initial,
        peer_id="session-peer",
        stable_peer_id_provider=lambda: "stable-peer",
        policy_provider=service._mesh_policy_provider,
        active_projection_provider=lambda: _active_projection(
            services=(
                [_projected_service("TTS", "TTS.Request")]
                if service._mesh_policy_provider().mesh_config.services["TTS"].export.share
                else []
            )
        ),
    )

    await handler.on_message(json.dumps({"type": "call", "id": "before", "method": "TTS.Request"}))
    assert json.loads(sent[-1])["type"] == "result"
    assert bus.request.await_count == 1

    settings = _active_mesh_settings()
    settings.mesh = MeshConfig(enabled=True, services={"TTS": mesh_policy(share=False)})
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._mesh_bus = MagicMock()
    service._mesh_peer_registry = MagicMock()
    service._mesh_routing_table = MagicMock()
    service._rtc_client = MagicMock()
    service._rtc_client.update_mesh_config = MagicMock()
    service._rtc_client.reannounce_manifest = AsyncMock(return_value=False)

    await service._reload_mesh_config(source_revision=2)

    assert service._mesh_policy_store.current().source_revision == 2
    assert service._mesh_policy_retry_revision == service._mesh_policy_store.current().revision
    service._rtc_client.reannounce_manifest.assert_awaited_once()

    await handler.on_message(json.dumps({"type": "call", "id": "after", "method": "TTS.Request"}))
    response = json.loads(sent[-1])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403
    assert response["error"]["message"] == "Service TTS is not shared"
    assert bus.request.await_count == 1

    retry_task = service._cancel_mesh_policy_retry()
    if retry_task:
        with pytest.raises(asyncio.CancelledError):
            await retry_task


@pytest.mark.asyncio
async def test_reload_mesh_config_duplicate_policy_does_not_reannounce(mock_gateway_service):
    service = mock_gateway_service
    settings = _active_mesh_settings()
    settings.mesh = MeshConfig(
        enabled=True,
        services={"TTS": mesh_policy(share=True)},
    )
    service._mesh_policy_store.replace(settings.mesh, source_revision=10)
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._mesh_bus = MagicMock()
    service._mesh_peer_registry = MagicMock()
    service._mesh_routing_table = MagicMock()
    service._rtc_client = MagicMock()
    service._rtc_client.reannounce_manifest = AsyncMock()

    await service._reload_mesh_config(source_revision=10)

    service._rtc_client.reannounce_manifest.assert_not_awaited()
