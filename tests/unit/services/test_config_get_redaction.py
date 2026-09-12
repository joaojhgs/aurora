"""External Config.Get must never expose runtime secrets."""

from unittest.mock import MagicMock

import pytest

from app.messaging import Envelope
from app.services.config.messages import GetConfigQuery
from app.services.config.service import ConfigService


@pytest.mark.asyncio
async def test_external_config_get_recursively_redacts_secrets() -> None:
    service = ConfigService()
    service.config_manager = MagicMock()
    service.config_manager.get.return_value = {
        "gateway": {
            "api": {"token_secret": "gateway-secret", "host": "127.0.0.1"},
            "webrtc": {"password": "room-password", "room": "mesh-room"},
        },
        "provider": {"api_key": "provider-key", "model": "local"},
    }

    from app.services.config.config_manager import ConfigManager

    redactor = object.__new__(ConfigManager)
    service.config_manager.redact_external_config.side_effect = redactor.redact_external_config

    response = await service._handle_get_config(
        GetConfigQuery(section="services"),
        envelope=Envelope(
            type="Config.Get",
            payload={},
            origin="external",
            identity_source="gateway_http",
        ),
    )

    assert response.config == {
        "gateway": {
            "api": {"token_secret": "[REDACTED]", "host": "127.0.0.1"},
            "webrtc": {"password": "[REDACTED]", "room": "mesh-room"},
        },
        "provider": {"api_key": "[REDACTED]", "model": "local"},
    }


@pytest.mark.asyncio
async def test_internal_config_get_preserves_service_credentials() -> None:
    service = ConfigService()
    service.config_manager = MagicMock()
    raw = {"gateway": {"webrtc": {"password": "room-password"}}}
    service.config_manager.get.return_value = raw

    response = await service._handle_get_config(
        GetConfigQuery(section="services"),
        envelope=Envelope(type="Config.Get", payload={}, origin="internal"),
    )

    assert response.config == raw
    service.config_manager.redact_external_config.assert_not_called()


@pytest.mark.asyncio
async def test_config_get_propagates_manager_failures() -> None:
    service = ConfigService()
    service.config_manager = MagicMock()
    service.config_manager.get.side_effect = RuntimeError("config read failed")

    with pytest.raises(RuntimeError, match="config read failed"):
        await service._handle_get_config(GetConfigQuery(section="system"))
