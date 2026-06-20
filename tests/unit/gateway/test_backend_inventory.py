"""Backend inventory and generated-route casing tests."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.auth import GatewayAuth
from app.services.gateway.route_generator import RouteGenerator
from app.shared.contracts.models.auth import AuthMethods, LoginRequest, LoginResponse
from app.shared.contracts.models.gateway import GatewayMethods, MethodInfo
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from scripts.generate_backend_inventory import (
    build_inventory,
    validate_ui_fixture_references,
)


def test_backend_inventory_includes_contract_route_schema_and_source_file():
    inventory = build_inventory()
    methods = {method["bus_topic"]: method for method in inventory["methods"]}

    assert AuthMethods.LOGIN in methods
    login = methods[AuthMethods.LOGIN]
    assert login["module"] == "Auth"
    assert login["name"] == "Login"
    assert login["routePath"] == "/api/Auth/Login"
    assert login["exposure"] == "both"
    assert login["method_type"] == "use"
    assert login["input_model"] == "LoginRequest"
    assert login["output_model"] == "LoginResponse"
    assert login["input_schema"]["title"] == "LoginRequest"
    assert login["source_file"].startswith("app/services/auth/service.py:")


def test_backend_inventory_classifies_gateway_builtins_and_fixture_references():
    inventory = build_inventory()
    builtins = {route["routePath"]: route for route in inventory["gateway_builtins"]}

    assert "/api/health" in builtins
    assert builtins["/api/health"]["route_kind"] == "gateway_builtin"
    assert builtins["/api/admin/peers"]["required_perms"] == ["Auth.manage"]
    assert inventory["ui_fixture_validation"]["ok"] is True


def test_backend_inventory_supports_admin_overview_manifest_contract():
    inventory = build_inventory()
    methods = {method["bus_topic"]: method for method in inventory["methods"]}
    builtins = {route["routePath"]: route for route in inventory["gateway_builtins"]}

    for topic in (
        GatewayMethods.GET_CAPABILITY_CATALOG,
        GatewayMethods.EXPLAIN_ROUTE,
        GatewayMethods.GET_SUPPORT_BUNDLE,
    ):
        assert topic in methods
        assert methods[topic]["exposure"] == "external"
        assert methods[topic]["method_type"] == "manage"
        assert methods[topic]["required_perms"] == ["Gateway.manage"]
        assert methods[topic]["routePath"] == f"/api/Gateway/{topic.split('.', 1)[1]}"

    assert builtins["/api/health"]["method_type"] == "gateway"
    assert builtins["/api/registry"]["route_kind"] == "gateway_builtin"
    assert builtins["/api/services"]["route_kind"] == "gateway_builtin"
    assert builtins["/api/routes"]["exposure"] == "gateway_builtin"
    assert builtins["/api/admin/peers"]["method_type"] == "manage"
    assert builtins["/api/admin/peers"]["required_perms"] == ["Auth.manage"]


def test_backend_inventory_includes_model_runtime_contracts():
    inventory = build_inventory()
    methods = {method["bus_topic"]: method for method in inventory["methods"]}

    read_method = methods[OrchestratorMethods.GET_MODEL_CATALOG]
    assert read_method["routePath"] == "/api/Orchestrator/GetModelCatalog"
    assert read_method["exposure"] == "external"
    assert read_method["method_type"] == "use"
    assert read_method["required_perms"] == ["Orchestrator.use"]
    assert read_method["input_model"] == "ModelRuntimeCatalogRequest"
    assert read_method["output_model"] == "ModelRuntimeCatalogResponse"

    for topic in (
        OrchestratorMethods.IMPORT_MODEL,
        OrchestratorMethods.DOWNLOAD_MODEL,
        OrchestratorMethods.BENCHMARK_MODEL,
    ):
        assert methods[topic]["exposure"] == "external"
        assert methods[topic]["method_type"] == "manage"
        assert methods[topic]["required_perms"] == ["Orchestrator.manage"]


def test_ui_fixture_validation_fails_for_unmarked_missing_public_reference(tmp_path: Path):
    fixture = tmp_path / "data.ts"
    fixture.write_text(
        """
        export const services = [{
          methods: [
            {
              name: 'Ghost',
              busTopic: 'Ghost.DoThing',
              methodType: 'use',
              exposure: 'both',
              permissions: [],
              routePath: '/api/Ghost/DoThing',
              backendCoverage: 'implemented',
            },
            {
              name: 'Future',
              busTopic: 'Future.DoThing',
              methodType: 'planned',
              exposure: 'planned',
              permissions: [],
              backendCoverage: 'planned',
            },
            {
              name: 'Internal',
              busTopic: 'Internal.DoThing',
              methodType: 'use',
              exposure: 'internal',
              permissions: [],
              backendCoverage: 'internal_only',
            },
          ],
        }]
        """
    )

    result = validate_ui_fixture_references([], [], fixture)

    assert result["ok"] is False
    assert result["errors"] == [{"bus_topic": "Ghost.DoThing", "error": "missing_backend_method"}]


def test_gateway_auth_bypasses_pascalcase_generated_auth_routes_and_lowercase_aliases():
    auth = GatewayAuth(enabled=True)

    assert auth.should_bypass("/api/Auth/Login")
    assert auth.should_bypass("/api/Auth/PairingStart")
    assert auth.should_bypass("/api/Auth/PairingConnect")
    assert auth.should_bypass("/api/Auth/PairingExchange")
    assert auth.should_bypass("/api/auth/login")
    assert auth.should_bypass("/api/auth/pairing/start")
    assert not auth.should_bypass("/api/Auth/LoginDebug")
    assert not auth.should_bypass("/api/auth/login-debug")


class _SingleMethodRegistry:
    def __init__(self, module_name: str, method_info: MethodInfo):
        self.module_name = module_name
        self.method_info = method_info

    def on_registry_change(self, _callback):
        return None

    async def get_external_methods(self):
        return [(self.module_name, self.method_info)]

    def is_service_available(self, module_name: str) -> bool:
        return module_name == self.module_name


@pytest.mark.asyncio
async def test_inventory_dynamic_route_matches_generated_openapi_path():
    fastapi = pytest.importorskip("fastapi")

    inventory = build_inventory()
    login = next(
        method for method in inventory["methods"] if method["bus_topic"] == AuthMethods.LOGIN
    )
    method_info = MethodInfo(
        name=login["name"],
        summary=login["summary"],
        bus_topic=login["bus_topic"],
        exposure=login["exposure"],
        method_type=login["method_type"],
        required_perms=login["required_perms"],
        input_model=login["input_model"],
        output_model=login["output_model"],
        input_schema=LoginRequest.model_json_schema(),
        output_schema=LoginResponse.model_json_schema(),
    )

    bus = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"success": True}))
    app = fastapi.FastAPI()
    router = fastapi.APIRouter()
    generator = RouteGenerator(
        bus=bus,
        registry=_SingleMethodRegistry("Auth", method_info),
    )
    generator.set_router(router)
    await generator.start()
    app.include_router(router)

    assert login["routePath"] == "/api/Auth/Login"
    assert login["routePath"] in app.openapi()["paths"]
