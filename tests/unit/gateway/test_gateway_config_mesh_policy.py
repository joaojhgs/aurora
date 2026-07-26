"""Gateway mesh policy config loading tests."""

import pytest
from pydantic import ValidationError

from app.services.gateway.service import GatewayService
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import Auth, Gateway, MeshRouting, MeshSharing


@pytest.mark.asyncio
@pytest.mark.unit
async def test_gateway_config_preserves_require_explicit_selector(monkeypatch) -> None:
    services = _raw_services()
    services["db"]["mesh_routing"] = {"require_explicit_selector": True}
    services["tooling"]["mesh_routing"] = {"require_explicit_selector": True}
    services["scheduler"]["mesh_routing"] = {"require_explicit_selector": True}

    class FakeConfigAPI:
        async def aget(self, key, model=None, config_timeout=None, default=None):
            if key == ConfigKeys.services.gateway:
                return Gateway(mesh_network={"enabled": True})
            if key == ConfigKeys.services.auth:
                return Auth()
            if key == ConfigKeys.services:
                return services
            return default

    monkeypatch.setattr("app.shared.config.interface.ConfigAPI", FakeConfigAPI)

    config = await GatewayService()._get_gateway_config()

    assert config.mesh.services["DB"].routing.require_explicit_selector is True
    assert config.mesh.services["Tooling"].routing.require_explicit_selector is True
    assert config.mesh.services["Scheduler"].routing.require_explicit_selector is True
    assert config.mesh.services["TTS"].routing.require_explicit_selector is False


@pytest.mark.asyncio
@pytest.mark.unit
async def test_gateway_config_activates_new_first_mesh_routing(monkeypatch) -> None:
    services = _raw_services()
    services["db"]["mesh_sharing"] = MeshSharing(
        share=True,
        allowed_peers=["legacy-db-peer"],
        prefer="local",
        fallback="local",
        required_capabilities=["legacy-db"],
    ).model_dump(mode="python")
    services["db"]["mesh_routing"] = MeshRouting(
        allowed_provider_peer_ids=[],
        prefer="network_only",
        fallback="error",
        required_provider_feature_ids=["shadow-feature"],
        required_provider_capability_tags=["new-db-tag"],
        require_explicit_selector=True,
    ).model_dump(mode="python")

    class FakeConfigAPI:
        async def aget(self, key, model=None, config_timeout=None, default=None):
            if key == ConfigKeys.services.gateway:
                return Gateway(mesh_network={"enabled": True})
            if key == ConfigKeys.services.auth:
                return Auth()
            if key == ConfigKeys.services:
                return services
            return default

    monkeypatch.setattr("app.shared.config.interface.ConfigAPI", FakeConfigAPI)

    config = await GatewayService()._get_gateway_config()
    db_policy = config.mesh.services["DB"]

    assert db_policy.export.share is True
    assert db_policy.legacy_inbound_allowed_peer_ids == ("legacy-db-peer",)
    assert db_policy.routing.allowed_provider_peer_ids == ()
    assert db_policy.routing.prefer == "network_only"
    assert db_policy.routing.fallback == "error"
    assert db_policy.routing.required_provider_feature_ids == ("shadow-feature",)
    assert db_policy.routing.required_provider_capability_tags == ("new-db-tag",)
    assert db_policy.routing.require_explicit_selector is True


@pytest.mark.asyncio
@pytest.mark.unit
async def test_gateway_config_empty_mesh_routing_is_authoritative(monkeypatch) -> None:
    services = _raw_services()
    services["db"]["mesh_sharing"] = MeshSharing(
        allowed_peers=["legacy-db-peer"],
        prefer="network",
        fallback="error",
        required_capabilities=["legacy-db"],
    ).model_dump(mode="python")
    services["db"]["mesh_routing"] = {}

    class FakeConfigAPI:
        async def aget(self, key, model=None, config_timeout=None, default=None):
            if key == ConfigKeys.services.gateway:
                return Gateway(mesh_network={"enabled": True})
            if key == ConfigKeys.services.auth:
                return Auth()
            if key == ConfigKeys.services:
                return services
            return default

    monkeypatch.setattr("app.shared.config.interface.ConfigAPI", FakeConfigAPI)

    config = await GatewayService()._get_gateway_config()
    db_policy = config.mesh.services["DB"]

    assert db_policy.routing.allowed_provider_peer_ids is None
    assert db_policy.routing.prefer == "local"
    assert db_policy.routing.fallback == "local"
    assert db_policy.routing.required_provider_capability_tags == ()


@pytest.mark.asyncio
@pytest.mark.unit
async def test_gateway_config_null_mesh_routing_falls_back_to_legacy(monkeypatch) -> None:
    services = _raw_services()
    services["db"]["mesh_sharing"] = MeshSharing(
        allowed_peers=[],
        prefer="network",
        fallback="error",
        required_capabilities=["legacy-db"],
    ).model_dump(mode="python")
    services["db"]["mesh_routing"] = None

    class FakeConfigAPI:
        async def aget(self, key, model=None, config_timeout=None, default=None):
            if key == ConfigKeys.services.gateway:
                return Gateway(mesh_network={"enabled": True})
            if key == ConfigKeys.services.auth:
                return Auth()
            if key == ConfigKeys.services:
                return services
            return default

    monkeypatch.setattr("app.shared.config.interface.ConfigAPI", FakeConfigAPI)

    config = await GatewayService()._get_gateway_config()
    db_policy = config.mesh.services["DB"]

    assert db_policy.routing.allowed_provider_peer_ids == ()
    assert db_policy.routing.prefer == "network"
    assert db_policy.routing.fallback == "error"
    assert db_policy.routing.required_provider_capability_tags == ("legacy-db",)


@pytest.mark.unit
def test_generated_mesh_sharing_rejects_unsupported_routing_values() -> None:
    with pytest.raises(ValidationError):
        MeshSharing(prefer="remote")

    with pytest.raises(ValidationError):
        MeshSharing(fallback="silent")


def _raw_services() -> dict:
    return {
        "stt": {
            "coordinator": {"mesh_sharing": {}, "mesh_routing": None},
            "wakeword": {"mesh_sharing": {}, "mesh_routing": None},
            "transcription": {"mesh_sharing": {}, "mesh_routing": None},
        },
        "db": {"mesh_sharing": {}, "mesh_routing": None},
        "tts": {"mesh_sharing": {}, "mesh_routing": None},
        "tooling": {"mesh_sharing": {}, "mesh_routing": None},
        "scheduler": {"mesh_sharing": {}, "mesh_routing": None},
        "orchestrator": {"mesh_sharing": {}, "mesh_routing": None},
    }
