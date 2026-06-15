"""Unit tests for the Gateway module.

Tests the gateway components:
- RegistryAggregator
- RouteGenerator
- FastAPI app creation
- Service announcements
"""

import asyncio
from datetime import datetime, timedelta

import pytest
import pytest_asyncio

from app.messaging.bus_runtime import set_bus
from app.messaging.local_bus import LocalBus
from app.shared.contracts.models.gateway import (
    GatewayMethods,
    GatewayModule,
    MethodInfo,
    ServiceAnnouncement,
    ServiceDeparture,
)
from app.shared.messaging.bus_init import set_bus as set_shared_bus


@pytest_asyncio.fixture
async def bus():
    """Create and start a LocalBus for testing."""
    _bus = LocalBus()
    await _bus.start()
    set_bus(_bus)
    set_shared_bus(_bus)
    yield _bus
    await _bus.stop()


class TestGatewayModels:
    """Test gateway model definitions."""

    def test_gateway_module_name(self):
        """Test GatewayModule.NAME is correct."""
        assert GatewayModule.NAME == "Gateway"

    def test_gateway_methods(self):
        """Test GatewayMethods constants."""
        assert GatewayMethods.SERVICE_ANNOUNCE == "Gateway.ServiceAnnounce"
        assert GatewayMethods.SERVICE_DEPART == "Gateway.ServiceDepart"
        assert GatewayMethods.SERVICE_HEARTBEAT == "Gateway.ServiceHeartbeat"

    def test_method_info_model(self):
        """Test MethodInfo model."""
        method = MethodInfo(
            name="TestMethod",
            summary="Test method",
            bus_topic="Test.Method",
            exposure="external",
        )
        assert method.name == "TestMethod"
        assert method.exposure == "external"
        assert method.bus_topic == "Test.Method"

    def test_service_announcement_model(self):
        """Test ServiceAnnouncement model."""
        announcement = ServiceAnnouncement(
            module="TestService",
            version="1.0.0",
            summary="Test service",
            capabilities=["test"],
            methods=[
                MethodInfo(
                    name="Method1",
                    summary="Method 1",
                    exposure="external",
                )
            ],
        )
        assert announcement.module == "TestService"
        assert announcement.version == "1.0.0"
        assert len(announcement.methods) == 1

    def test_service_departure_model(self):
        """Test ServiceDeparture model."""
        departure = ServiceDeparture(
            module="TestService",
            reason="shutdown",
        )
        assert departure.module == "TestService"
        assert departure.reason == "shutdown"


class TestRegistryAggregator:
    """Test RegistryAggregator functionality."""

    @pytest.mark.asyncio
    async def test_create_aggregator(self, bus):
        """Test creating a RegistryAggregator."""
        from app.services.gateway.registry_aggregator import RegistryAggregator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        assert aggregator is not None

    @pytest.mark.asyncio
    async def test_start_stop_aggregator(self, bus):
        """Test starting and stopping the aggregator."""
        from app.services.gateway.registry_aggregator import RegistryAggregator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        await aggregator.start()
        await aggregator.stop()

    @pytest.mark.asyncio
    async def test_get_services_empty(self, bus):
        """Test getting services when empty."""
        from app.services.gateway.registry_aggregator import RegistryAggregator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        await aggregator.start()

        services = await aggregator.get_services()
        # Might have services from local registry or be empty
        assert isinstance(services, list)

        await aggregator.stop()

    @pytest.mark.asyncio
    async def test_handle_service_announcement(self, bus):
        """Test handling service announcements."""
        from app.messaging import Envelope
        from app.services.gateway.registry_aggregator import RegistryAggregator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        await aggregator.start()

        # Create announcement
        announcement = ServiceAnnouncement(
            module="TestService",
            version="1.0.0",
            summary="Test service",
            methods=[
                MethodInfo(name="Method1", exposure="external"),
            ],
        )

        # Publish announcement
        await bus.publish(
            GatewayMethods.SERVICE_ANNOUNCE,
            announcement,
            event=True,
        )

        # Wait for processing
        await asyncio.sleep(0.1)

        # Check service is registered
        services = await aggregator.get_services()
        test_services = [s for s in services if s.module == "TestService"]
        assert len(test_services) == 1
        assert test_services[0].version == "1.0.0"

        await aggregator.stop()

    @pytest.mark.asyncio
    async def test_handle_service_departure(self, bus):
        """Test handling service departures."""
        from app.services.gateway.registry_aggregator import RegistryAggregator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        await aggregator.start()

        # Announce a service
        announcement = ServiceAnnouncement(
            module="DepartingService",
            version="1.0.0",
        )
        await bus.publish(GatewayMethods.SERVICE_ANNOUNCE, announcement, event=True)
        await asyncio.sleep(0.1)

        # Verify it's there
        services = await aggregator.get_services()
        assert any(s.module == "DepartingService" for s in services)

        # Send departure
        departure = ServiceDeparture(module="DepartingService", reason="shutdown")
        await bus.publish(GatewayMethods.SERVICE_DEPART, departure, event=True)
        await asyncio.sleep(0.1)

        # Verify it's gone
        services = await aggregator.get_services()
        assert not any(s.module == "DepartingService" for s in services)

        await aggregator.stop()

    @pytest.mark.asyncio
    async def test_prune_stale_services_removes_process_mode_routes(self, bus):
        """Test stale process-mode services are removed from the registry."""
        from app.services.gateway.registry_aggregator import RegistryAggregator

        aggregator = RegistryAggregator(bus=bus, mode="processes", heartbeat_timeout_s=1.0)
        await aggregator.start()

        announcement = ServiceAnnouncement(module="StaleService", version="1.0.0")
        await bus.publish(GatewayMethods.SERVICE_ANNOUNCE, announcement, event=True)
        await asyncio.sleep(0.1)

        async with aggregator._lock:
            aggregator._last_seen["StaleService"] = datetime.utcnow() - timedelta(seconds=3)

        expired = await aggregator.prune_stale_services()

        assert expired == ["StaleService"]
        assert await aggregator.get_service("StaleService") is None

        await aggregator.stop()

    @pytest.mark.asyncio
    async def test_gateway_methods_loaded_in_local_registry(self, bus):
        """Gateway service methods (PairingStart, Login, etc.) must be
        discoverable via the registry so that WebRTC RPC calls can find them.

        Regression: Gateway was previously skipped in _load_from_local_registry,
        causing all Gateway.* RPC calls to return 404."""
        from app.services.gateway.registry_aggregator import RegistryAggregator
        from app.shared.contracts.registry import (
            IOModel,
            clear_registry,
            register_method,
            register_module,
        )

        # Ensure a clean slate – other tests may have cleared the global
        # registry, so register the modules fresh here.
        clear_registry()

        # Minimal Pydantic model for the contract requirement
        class _Dummy(IOModel):
            pass

        # Simulate what BaseService.__init__ does for the Auth service:
        # register_module + register_method for pairing contracts.
        register_module("Auth", summary="Auth service")
        for method_name, method_id in [
            ("PairingStart", "Auth.PairingStart"),
            ("Login", "Auth.Login"),
        ]:
            register_method(
                "Auth",
                method_name,
                lambda: None,  # dummy impl
                {
                    "method_id": method_id,
                    "name": method_name,
                    "module": "Auth",
                    "bus_topic": method_id,
                    "exposure": "both",
                    "summary": f"{method_name} method",
                    "input_model": _Dummy,
                    "output_model": None,
                    "default_priority": 50,
                },
            )

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        await aggregator.start()

        # get_service should return the Auth announcement
        svc = await aggregator.get_service("Auth")
        assert svc is not None, "Auth must be loaded in registry (needed for WebRTC pairing)"

        # Verify pairing-related methods are present
        method_names = {m.name for m in svc.methods}
        for expected in ("PairingStart", "Login"):
            assert expected in method_names, (
                f"{expected} not found in Gateway registry methods: {method_names}"
            )

        await aggregator.stop()

        # Clean up global state to avoid polluting other tests
        clear_registry()


class TestRouteGenerator:
    """Test RouteGenerator functionality."""

    @pytest.mark.asyncio
    async def test_create_route_generator(self, bus):
        """Test creating a RouteGenerator."""
        from app.services.gateway.registry_aggregator import RegistryAggregator
        from app.services.gateway.route_generator import RouteGenerator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        generator = RouteGenerator(bus=bus, registry=aggregator)
        assert generator is not None

    @pytest.mark.asyncio
    async def test_generate_path(self, bus):
        """Test path generation."""
        from app.services.gateway.registry_aggregator import RegistryAggregator
        from app.services.gateway.route_generator import RouteGenerator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        generator = RouteGenerator(bus=bus, registry=aggregator)

        method = MethodInfo(name="TestMethod", exposure="external")
        path = generator._generate_path("TestModule", method)
        assert path == "/api/TestModule/TestMethod"


class TestFastAPIApp:
    """Test FastAPI app creation."""

    @pytest.mark.asyncio
    async def test_create_app(self, bus):
        """Test creating the FastAPI app."""
        from app.services.gateway.fastapi_app import create_gateway_app
        from app.services.gateway.registry_aggregator import RegistryAggregator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        app = create_gateway_app(bus=bus, registry=aggregator)

        assert app is not None
        assert app.title == "Aurora Gateway API"

    @pytest.mark.asyncio
    async def test_app_has_health_endpoint(self, bus):
        """Test that app has health endpoint."""
        from fastapi.testclient import TestClient

        from app.services.gateway.fastapi_app import create_gateway_app
        from app.services.gateway.registry_aggregator import RegistryAggregator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        app = create_gateway_app(bus=bus, registry=aggregator)

        with TestClient(app) as client:
            response = client.get("/api/health")
            assert response.status_code == 200
            data = response.json()
            assert "status" in data

    @pytest.mark.asyncio
    async def test_app_has_registry_endpoint(self, bus):
        """Test that app has registry endpoint."""
        from fastapi.testclient import TestClient

        from app.services.gateway.fastapi_app import create_gateway_app
        from app.services.gateway.registry_aggregator import RegistryAggregator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        app = create_gateway_app(bus=bus, registry=aggregator)

        with TestClient(app) as client:
            response = client.get("/api/registry")
            assert response.status_code == 200
            data = response.json()
            assert "modules" in data

    @pytest.mark.asyncio
    async def test_app_has_services_endpoint(self, bus):
        """Test that app has services endpoint."""
        from fastapi.testclient import TestClient

        from app.services.gateway.fastapi_app import create_gateway_app
        from app.services.gateway.registry_aggregator import RegistryAggregator

        aggregator = RegistryAggregator(bus=bus, mode="threads")
        app = create_gateway_app(bus=bus, registry=aggregator)

        with TestClient(app) as client:
            response = client.get("/api/services")
            assert response.status_code == 200
            data = response.json()
            assert "services" in data
