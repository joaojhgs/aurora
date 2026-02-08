"""Unit tests for gateway config hot-reload (auth settings)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.gateway.config import PermissionSettings, Settings


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
    assert ps.default_device_permissions == []
    assert ps.webrtc_auth_timeout_seconds == 10.0


def test_settings_includes_permissions():
    """Settings model includes the permissions section."""
    s = Settings()
    assert hasattr(s, "permissions")
    assert isinstance(s.permissions, PermissionSettings)
