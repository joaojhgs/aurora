"""Regression tests for secure mesh activation prerequisites."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.config import Settings
from app.shared.contracts.models.auth import AuthMethods

pytest.importorskip("aiortc", reason="Gateway WebRTC tests require aiortc")


_PATCH_CONFIG_API = "app.shared.config.interface.ConfigAPI"
_PATCH_RTC = "app.services.gateway.webrtc.rtc_client.RTCClient"
_PATCH_SET_RTC = "app.services.gateway.dependencies.set_rtc_client"


@pytest.mark.asyncio
async def test_auth_pairing_readiness_probe_is_storage_free():
    """Gateway readiness must not poll/audit the pending-pairing database queue."""
    from app.services.gateway.service import GatewayService

    service = GatewayService()
    mock_bus = AsyncMock()
    mock_bus.request.return_value = QueryResult(ok=True, data={"success": True})

    with patch.object(
        GatewayService,
        "bus",
        new_callable=PropertyMock,
        return_value=mock_bus,
    ):
        assert await service._wait_for_auth_pairing_service() is True

    assert mock_bus.request.await_args.args[0] == AuthMethods.PAIRING_READY
    assert mock_bus.request.await_args.kwargs["origin"] == "internal"


@pytest.mark.asyncio
async def test_auth_pairing_readiness_waits_for_late_availability():
    """Transient unavailable probes keep retrying until Auth announces readiness."""
    from app.services.gateway.service import GatewayService

    service = GatewayService()
    mock_bus = AsyncMock()
    mock_bus.request.side_effect = [
        RuntimeError("auth not subscribed yet"),
        QueryResult(ok=True, data={"success": False}),
        QueryResult(ok=True, data={"success": True}),
    ]

    with (
        patch.object(
            GatewayService,
            "bus",
            new_callable=PropertyMock,
            return_value=mock_bus,
        ),
        patch("app.services.gateway.service.asyncio.sleep", new_callable=AsyncMock),
    ):
        assert await service._wait_for_auth_pairing_service() is True

    assert mock_bus.request.await_count == 3


@pytest.mark.asyncio
async def test_auth_pairing_readiness_terminal_failure_logs_safe_diagnostic():
    """Terminal failure stays fail-closed and reports only exception category."""
    from app.services.gateway.service import GatewayService

    service = GatewayService()
    mock_bus = AsyncMock()
    mock_bus.request.side_effect = RuntimeError("raw-peer-id raw-token")

    with (
        patch.object(
            GatewayService,
            "bus",
            new_callable=PropertyMock,
            return_value=mock_bus,
        ),
        patch("app.services.gateway.service.asyncio.sleep", new_callable=AsyncMock),
        patch("app.services.gateway.service.log_debug") as mock_debug,
        patch("app.services.gateway.service.log_warning") as mock_warning,
    ):
        assert await service._wait_for_auth_pairing_service() is False

    assert mock_bus.request.await_count == 10
    diagnostic = mock_debug.call_args.args[0]
    warning = mock_warning.call_args.args[0]
    assert "category=bus_exception" in diagnostic
    assert "reason=RuntimeError" in diagnostic
    assert "mesh_transport=stopped" in warning
    assert "raw-peer-id" not in diagnostic + warning
    assert "raw-token" not in diagnostic + warning


@pytest.mark.asyncio
async def test_enabling_mesh_provisions_auth_and_secure_webrtc_before_mesh_start():
    """A single mesh activation must create every prerequisite before joining."""
    from app.services.gateway.service import GatewayService

    service = GatewayService()
    service._bus = MagicMock()
    service._registry_aggregator = AsyncMock()
    service._gateway_enabled = True

    settings = Settings()
    settings.api.auth_enabled = False
    settings.mesh = settings.mesh.model_copy(update={"enabled": True})
    settings.webrtc.enabled = False
    settings.webrtc.app_id = "aurora"
    settings.webrtc.room = "default"
    settings.webrtc.password = ""
    service._get_gateway_config = AsyncMock(return_value=settings)

    saved_values: dict[str, object] = {}
    mock_config_api = MagicMock()

    async def read_config(_key, **_kwargs):
        return settings.api.token_secret

    async def persist(key, value, **_kwargs):
        key = str(key)
        saved_values[key] = value
        if key == "services.gateway.webrtc.enabled":
            settings.webrtc.enabled = bool(value)
        elif key == "services.gateway.webrtc.app_id":
            settings.webrtc.app_id = str(value)
        elif key == "services.gateway.webrtc.room":
            settings.webrtc.room = str(value)
        elif key == "services.gateway.webrtc.password":
            settings.webrtc.password = str(value)
        elif key == "services.gateway.mesh_network.node_name":
            settings.mesh = settings.mesh.model_copy(update={"node_name": str(value)})
        return True

    mock_config_api.aupdate_config = AsyncMock(side_effect=persist)
    mock_config_api.aget = AsyncMock(side_effect=read_config)

    with (
        patch(_PATCH_CONFIG_API, return_value=mock_config_api),
        patch(_PATCH_RTC) as mock_rtc_cls,
        patch(_PATCH_SET_RTC),
        patch.object(
            service,
            "_wait_for_auth_pairing_service",
            new_callable=AsyncMock,
            return_value=True,
        ),
        patch.object(service, "_start_mesh", new_callable=AsyncMock) as mock_start_mesh,
    ):
        mock_rtc_cls.return_value = AsyncMock()

        await service.reload_config(
            SimpleNamespace(
                key_path="services.gateway.mesh_network.enabled",
                affected_sections=[],
                old_value=False,
                new_value=True,
            )
        )

    assert saved_values["services.auth.enabled"] is True
    assert saved_values["services.gateway.webrtc.enabled"] is True

    generated_node_name = saved_values["services.gateway.mesh_network.node_name"]
    assert isinstance(generated_node_name, str)
    assert generated_node_name.startswith("aurora-node-")
    assert len(generated_node_name) > len("aurora-node-")
    assert settings.mesh.node_name == generated_node_name

    generated_app_id = saved_values["services.gateway.webrtc.app_id"]
    generated_room = saved_values["services.gateway.webrtc.room"]
    generated_password = saved_values["services.gateway.webrtc.password"]
    assert isinstance(generated_app_id, str)
    assert generated_app_id not in {"", "aurora"}
    assert len(generated_app_id) >= 16
    assert isinstance(generated_room, str)
    assert generated_room not in {"", "default"}
    assert len(generated_room) >= 16
    assert isinstance(generated_password, str)
    assert len(generated_password) >= 32

    mock_rtc_cls.assert_called_once()
    mock_start_mesh.assert_awaited_once()


@pytest.mark.asyncio
async def test_startup_mesh_provisions_disabled_webrtc_before_transport_start():
    """A persisted mesh activation must repair prerequisites on the next startup."""
    from app.services.gateway.service import GatewayService

    service = GatewayService()
    service._bus = MagicMock()

    settings = Settings()
    settings.mesh = settings.mesh.model_copy(update={"enabled": True})
    settings.webrtc.enabled = False
    settings.webrtc.app_id = "aurora"
    settings.webrtc.room = "default"
    settings.webrtc.password = ""

    async def provision(current_settings):
        assert current_settings is settings
        current_settings.permissions.enabled = True
        current_settings.webrtc.enabled = True
        current_settings.webrtc.app_id = "private-app-id"
        current_settings.webrtc.room = "private-room"
        current_settings.webrtc.password = "private-room-password"
        return True

    service._get_gateway_config = AsyncMock(return_value=settings)
    service._ensure_mesh_prerequisites = AsyncMock(side_effect=provision)

    with (
        patch(_PATCH_RTC) as mock_rtc_cls,
        patch(_PATCH_SET_RTC),
        patch("app.services.gateway.registry_aggregator.RegistryAggregator") as mock_registry_cls,
    ):
        mock_rtc_cls.return_value = AsyncMock()
        mock_registry_cls.return_value = AsyncMock()

        await service._start_webrtc()

    service._ensure_mesh_prerequisites.assert_awaited_once_with(settings)
    mock_rtc_cls.assert_called_once()
    mock_rtc_cls.return_value.start.assert_awaited_once_with(join_room=False)
