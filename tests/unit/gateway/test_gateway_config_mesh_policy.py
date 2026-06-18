"""Gateway mesh policy config loading tests."""

import pytest
from pydantic import ValidationError

from app.services.gateway.service import GatewayService
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import Auth, Gateway, MeshSharing


@pytest.mark.asyncio
@pytest.mark.unit
async def test_gateway_config_preserves_require_explicit_selector(monkeypatch) -> None:
    mesh_values = {
        ConfigKeys.services.stt.coordinator.mesh_sharing: MeshSharing(),
        ConfigKeys.services.stt.wakeword.mesh_sharing: MeshSharing(),
        ConfigKeys.services.stt.transcription.mesh_sharing: MeshSharing(),
        ConfigKeys.services.db.mesh_sharing: MeshSharing(require_explicit_selector=True),
        ConfigKeys.services.tts.mesh_sharing: MeshSharing(),
        ConfigKeys.services.tooling.mesh_sharing: MeshSharing(require_explicit_selector=True),
        ConfigKeys.services.scheduler.mesh_sharing: MeshSharing(require_explicit_selector=True),
        ConfigKeys.services.orchestrator.mesh_sharing: MeshSharing(),
    }

    class FakeConfigAPI:
        async def aget(self, key, model=None, config_timeout=None):
            if key == ConfigKeys.services.gateway:
                return Gateway(mesh_network={"enabled": True})
            if key == ConfigKeys.services.auth:
                return Auth()
            return mesh_values[key]

    monkeypatch.setattr("app.shared.config.interface.ConfigAPI", FakeConfigAPI)

    config = await GatewayService()._get_gateway_config()

    assert config.mesh.services["DB"].require_explicit_selector is True
    assert config.mesh.services["Tooling"].require_explicit_selector is True
    assert config.mesh.services["Scheduler"].require_explicit_selector is True
    assert config.mesh.services["TTS"].require_explicit_selector is False


@pytest.mark.unit
def test_generated_mesh_sharing_rejects_unsupported_routing_values() -> None:
    with pytest.raises(ValidationError):
        MeshSharing(prefer="remote")

    with pytest.raises(ValidationError):
        MeshSharing(fallback="silent")
