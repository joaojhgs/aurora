"""Security contract tests for mesh invite signaling credentials."""

from unittest.mock import AsyncMock

import pytest

from app.services.gateway.config import Settings, WebRTCSettings
from app.services.gateway.route_generator import _admin_action_required
from app.services.gateway.service import GatewayService
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.gateway import GatewayMethods
from app.shared.contracts.registry import clear_registry, list_modules
from app.shared.mesh.tracing import redacted_copy


def test_mesh_invite_config_contract_is_admin_gated_without_confirmation_ceremony():
    clear_registry()
    GatewayService()
    methods = {method.bus_topic: method for method in list_modules()["Gateway"].methods}

    contract = methods[GatewayMethods.GET_MESH_INVITE_CONFIG]
    assert contract.exposure == "external"
    assert contract.method_type == "manage"
    assert contract.required_perms == ["Gateway.manage"]
    assert _admin_action_required(GatewayMethods.GET_MESH_INVITE_CONFIG, "manage") is False
    clear_registry()


@pytest.mark.asyncio
async def test_mesh_invite_config_returns_only_required_signaling_material():
    service = GatewayService()
    service._get_gateway_config = AsyncMock(
        return_value=Settings(
            webrtc=WebRTCSettings(
                app_id="aurora-app-private",
                room="aurora-room-private",
                password="room-secret",
                turn_username="must-not-leak",
                turn_password="must-not-leak",
            )
        )
    )

    response = await service.get_mesh_invite_config(EmptyInput())

    assert response.model_dump() == {
        "app_id": "aurora-app-private",
        "room": "aurora-room-private",
        "room_password": "room-secret",
    }
    assert "room-secret" not in repr(response)
    assert "room-secret" not in repr(redacted_copy(response))
