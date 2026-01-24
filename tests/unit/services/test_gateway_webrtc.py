import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.gateway.config import Settings
from app.services.gateway.service import GatewayService
from app.services.gateway.webrtc.rtc_client import RTCClient


@pytest.fixture
def mock_bus():
    return AsyncMock()


@pytest.fixture
def mock_settings():
    settings = Settings()
    settings.api.enabled = False
    settings.webrtc.enabled = True
    settings.webrtc.strategy = "mqtt"
    return settings


@pytest.mark.asyncio
async def test_gateway_service_starts_stops_webrtc(mock_bus, mock_settings):
    with patch("app.shared.config.interface.ConfigAPI") as mock_config_api_cls:
        mock_config_api = mock_config_api_cls.return_value
        mock_config_api.aget_config = AsyncMock(return_value=mock_settings.model_dump())

        service = GatewayService()
        service._bus = mock_bus

        with patch("app.services.gateway.webrtc.rtc_client.RTCClient") as mock_rtc_client_cls:
            mock_rtc_client = mock_rtc_client_cls.return_value
            mock_rtc_client.start = AsyncMock()
            mock_rtc_client.close = AsyncMock()

            with patch(
                "app.services.gateway.registry_aggregator.RegistryAggregator"
            ) as mock_reg_cls:
                mock_reg = mock_reg_cls.return_value
                mock_reg.start = AsyncMock()
                mock_reg.stop = AsyncMock()

                await service.on_start()

                mock_rtc_client_cls.assert_called_once()
                mock_rtc_client.start.assert_called_once()

                await service.on_stop()
                mock_rtc_client.close.assert_called_once()


@pytest.mark.asyncio
async def test_rtc_client_initialization_and_signaling_config(mock_bus, mock_settings):
    mock_registry = AsyncMock()

    with patch("app.services.gateway.webrtc.rtc_client.MQTTSignaling") as mock_mqtt_signaling_cls:
        mock_mqtt_signaling = mock_mqtt_signaling_cls.return_value
        mock_mqtt_signaling.connect = AsyncMock()
        mock_mqtt_signaling.join_room = AsyncMock()
        mock_mqtt_signaling.on_message = MagicMock()

        client = RTCClient(settings=mock_settings, bus=mock_bus, registry=mock_registry)
        await client.start()

        mock_mqtt_signaling_cls.assert_called_once_with(
            brokers=mock_settings.signaling_mqtt.brokers,
            topic_root=mock_settings.signaling_mqtt.topic_root,
            username=mock_settings.signaling_mqtt.username,
            password=mock_settings.signaling_mqtt.password,
        )

        mock_mqtt_signaling.connect.assert_called_once()
        mock_mqtt_signaling.join_room.assert_called_once_with(
            mock_settings.webrtc.app_id, mock_settings.webrtc.room, client._peer_id
        )


@pytest.mark.asyncio
async def test_rtc_client_respects_ice_servers_config(mock_bus, mock_settings):
    mock_settings.webrtc.stun_servers = ["stun:custom.stun.com"]
    mock_settings.webrtc.turn_servers = ["turn:custom.turn.com"]
    mock_settings.webrtc.turn_username = "user"
    mock_settings.webrtc.turn_password = "pass"

    mock_registry = AsyncMock()
    client = RTCClient(settings=mock_settings, bus=mock_bus, registry=mock_registry)

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection") as mock_pc_cls:
        mock_pc = mock_pc_cls.return_value
        mock_pc.on = MagicMock()
        mock_pc.createDataChannel = MagicMock()

        await client._ensure_pc("test-peer")

        mock_pc_cls.assert_called_once()
        config = mock_pc_cls.call_args.kwargs.get("configuration")
        assert config is not None

        ice_servers = config.iceServers
        assert len(ice_servers) == 2
        assert ice_servers[0].urls == ["stun:custom.stun.com"]
        assert ice_servers[1].urls == ["turn:custom.turn.com"]
        assert ice_servers[1].username == "user"
        assert ice_servers[1].credential == "pass"
