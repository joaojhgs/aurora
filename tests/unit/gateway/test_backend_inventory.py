"""Backend inventory and generated-route casing tests."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.auth import GatewayAuth
from app.services.gateway.registry_aggregator import RegistryAggregator
from app.services.gateway.route_generator import RouteGenerator
from app.shared.contracts.mesh_surface import (
    CALLABLE_FEATURES,
    MESH_CAPABLE_MODULES,
    feature_contracts_for_module,
    feature_contracts_for_topic,
)
from app.shared.contracts.models.auth import AuthMethods, LoginRequest, LoginResponse
from app.shared.contracts.models.gateway import GatewayMethods, MethodInfo, ServiceAnnouncement
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from scripts.generate_backend_inventory import (
    SERVICE_SOURCES,
    _load_contract_namespace,
    _static_contracts_from_source,
    build_inventory,
    validate_ui_fixture_references,
)
from tests.unit.gateway.test_mesh_security_surface_inventory import (
    EXPECTED_REPAIRED_PERMISSIONS,
    INVENTORY_PATH as SECURITY_INVENTORY_PATH,
)

EXPECTED_CALLABLE_METHOD_COUNTS_BY_MODULE = {
    "DB": 11,
    "Orchestrator": 13,
    "Scheduler": 6,
    "STTCoordinator": 2,
    "TTS": 5,
    "Tooling": 39,
    "Transcription": 2,
    "WakeWord": 2,
}


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


def test_backend_inventory_callable_surface_matches_canonical_taxonomy():
    inventory = build_inventory()
    callable_methods = [method for method in inventory["methods"] if method["callable_feature_ids"]]
    namespace = _load_contract_namespace()
    static_by_topic = {}
    for source_path in SERVICE_SOURCES:
        static_by_topic.update(_static_contracts_from_source(source_path, namespace))
    security_methods = {
        method["bus_topic"]: method
        for method in json.loads(SECURITY_INVENTORY_PATH.read_text())["methods"]
    }

    assert inventory["import_errors"] == []
    assert len(callable_methods) == 80
    assert {method["module"] for method in callable_methods} == set(MESH_CAPABLE_MODULES)
    assert Counter(method["module"] for method in callable_methods) == Counter(
        EXPECTED_CALLABLE_METHOD_COUNTS_BY_MODULE
    )
    assert {
        (method["module"], feature_id)
        for method in callable_methods
        for feature_id in method["callable_feature_ids"]
    } == {(feature.module, feature.feature_id) for feature in CALLABLE_FEATURES}
    assert {method["bus_topic"] for method in callable_methods} == {
        topic for feature in CALLABLE_FEATURES for topic in feature.method_ids
    }
    for method in callable_methods:
        topic = method["bus_topic"]
        static = static_by_topic[topic]
        security = security_methods[topic]
        expected_features = [
            feature.model_dump(mode="json") for feature in feature_contracts_for_topic(topic)
        ]
        expected_feature_ids = [feature["feature_id"] for feature in expected_features]

        for field in (
            "module",
            "name",
            "bus_topic",
            "exposure",
            "method_type",
            "required_perms",
            "callable_feature_ids",
            "public_infrastructure",
        ):
            assert method[field] == static[field], (topic, field)
        assert method["callable_feature_ids"] == expected_feature_ids
        assert method["callable_features"] == expected_features
        assert method["required_perms"]
        assert method["public_infrastructure"] is False
        assert method["source"] == "live_registry"
        assert method["source_file"] == f"{security['source']['file']}:{security['source']['line']}"
        assert method["module"] == security["module"]
        assert method["bus_topic"] == security["bus_topic"]
        assert method["exposure"] == security["exposure"]
        assert method["method_type"] == security["method_type"]
        assert method["required_perms"] == security["required_perms"]
        assert method["callable_feature_ids"] == [security["proposed_feature_id"]]


def test_backend_inventory_live_decorators_match_static_source_metadata():
    inventory = build_inventory()
    namespace = _load_contract_namespace()
    static_by_topic = {}
    for source_path in SERVICE_SOURCES:
        static_by_topic.update(_static_contracts_from_source(source_path, namespace))

    assert inventory["import_errors"] == []
    assert inventory["method_count"] == len(inventory["methods"])
    for method in inventory["methods"]:
        static = static_by_topic[method["bus_topic"]]
        for field in (
            "module",
            "name",
            "bus_topic",
            "exposure",
            "method_type",
            "required_perms",
            "callable_feature_ids",
            "public_infrastructure",
        ):
            assert method[field] == static[field], (method["bus_topic"], field)
        assert method["source"] in {"live_registry", "static_contract"}
        assert method["source_file"] == static["source_file"]


def test_backend_inventory_binds_repaired_permissions_to_live_inventory():
    inventory = build_inventory()
    methods = {method["bus_topic"]: method for method in inventory["methods"]}
    security_methods = {
        method["bus_topic"]: method
        for method in json.loads(SECURITY_INVENTORY_PATH.read_text())["methods"]
    }

    for topic, expected_perms in EXPECTED_REPAIRED_PERMISSIONS.items():
        method = methods[topic]
        security = security_methods[topic]
        expected_features = [
            feature.model_dump(mode="json") for feature in feature_contracts_for_topic(topic)
        ]

        assert method["source"] == "live_registry"
        assert method["source_file"] == f"{security['source']['file']}:{security['source']['line']}"
        assert method["module"] == security["module"]
        assert method["name"] == topic.split(".", 1)[1]
        assert method["bus_topic"] == topic
        assert method["exposure"] == security["exposure"]
        assert method["method_type"] == security["method_type"]
        assert method["required_perms"] == expected_perms == security["required_perms"]
        assert method["callable_feature_ids"] == [security["proposed_feature_id"]]
        assert method["callable_features"] == expected_features
        assert method["public_infrastructure"] is False


def test_backend_inventory_classifies_gateway_builtins_and_fixture_references():
    inventory = build_inventory()
    builtins = {route["routePath"]: route for route in inventory["gateway_builtins"]}

    assert "/api/health" in builtins
    assert builtins["/api/health"]["route_kind"] == "gateway_builtin"
    assert builtins["/api/admin/peers"]["required_perms"] == ["Auth.manage"]
    assert inventory["ui_fixture_validation"]["ok"] is True


@pytest.mark.asyncio
async def test_registry_export_propagates_announcement_callable_features():
    aggregator = RegistryAggregator(bus=object())
    announcement = ServiceAnnouncement(
        module="TTS",
        version="1.0.0",
        callable_features=list(feature_contracts_for_module("TTS")),
        methods=[
            MethodInfo(
                name="Synthesize",
                bus_topic="TTS.Synthesize",
                exposure="both",
                required_perms=["TTS.Synthesize"],
                callable_feature_ids=["speech_synthesis"],
                callable_features=list(feature_contracts_for_topic("TTS.Synthesize")),
            )
        ],
    )
    aggregator._services["TTS"] = RegistryAggregator._validated_announcement(announcement)

    exported = await aggregator.get_registry_export()

    module = exported["modules"][0]
    assert module.callable_features == list(feature_contracts_for_module("TTS"))
    assert module.methods[0].callable_features == list(
        feature_contracts_for_topic("TTS.Synthesize")
    )


def test_registry_aggregator_rejects_missing_wire_feature_objects():
    announcement = ServiceAnnouncement(
        module="TTS",
        version="1.0.0",
        methods=[
            MethodInfo(
                name="Synthesize",
                bus_topic="TTS.Synthesize",
                exposure="both",
                required_perms=["TTS.Synthesize"],
                callable_feature_ids=["speech_synthesis"],
            )
        ],
    )

    with pytest.raises(ValueError, match="callable features mismatch"):
        RegistryAggregator._validated_announcement(announcement)


def test_backend_inventory_supports_admin_overview_manifest_contract():
    inventory = build_inventory()
    methods = {method["bus_topic"]: method for method in inventory["methods"]}
    builtins = {route["routePath"]: route for route in inventory["gateway_builtins"]}

    for topic in (
        GatewayMethods.GET_CAPABILITY_CATALOG,
        GatewayMethods.GET_DEPLOYMENT_TOPOLOGY,
        GatewayMethods.EXPLAIN_ROUTE,
    ):
        assert topic in methods
        assert methods[topic]["exposure"] == "external"
        assert methods[topic]["method_type"] == "use"
        assert methods[topic]["required_perms"] == ["Gateway.use"]
        assert methods[topic]["routePath"] == f"/api/Gateway/{topic.split('.', 1)[1]}"

    assert methods[GatewayMethods.GET_SUPPORT_BUNDLE]["exposure"] == "external"
    assert methods[GatewayMethods.GET_SUPPORT_BUNDLE]["method_type"] == "manage"
    assert methods[GatewayMethods.GET_SUPPORT_BUNDLE]["required_perms"] == ["Gateway.manage"]
    assert (
        methods[GatewayMethods.GET_SUPPORT_BUNDLE]["routePath"] == "/api/Gateway/GetSupportBundle"
    )

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
    assert read_method["required_perms"] == [OrchestratorMethods.REMOTE_INFERENCE]
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


def test_backend_inventory_includes_attachment_context_ingestion_contract():
    inventory = build_inventory()
    methods = {method["bus_topic"]: method for method in inventory["methods"]}

    ingest = methods[OrchestratorMethods.INGEST_CONTEXT]
    assert ingest["routePath"] == "/api/Orchestrator/IngestContext"
    assert ingest["exposure"] == "external"
    assert ingest["method_type"] == "use"
    assert ingest["required_perms"] == ["Orchestrator.use"]
    assert ingest["input_model"] == "AttachmentContextIngestRequest"
    assert ingest["output_model"] == "AttachmentContextIngestResponse"
    assert ingest["input_schema"]["title"] == "AttachmentContextIngestRequest"
    assert ingest["output_schema"]["title"] == "AttachmentContextIngestResponse"
    assert ingest["source_file"].startswith("app/services/orchestrator/service.py:")


def test_backend_inventory_includes_admin_pending_pairing_queue_contract():
    inventory = build_inventory()
    methods = {method["bus_topic"]: method for method in inventory["methods"]}

    pending = methods[AuthMethods.LIST_PENDING_PAIRINGS]
    assert pending["routePath"] == "/api/Auth/ListPendingPairings"
    assert pending["exposure"] == "both"
    assert pending["method_type"] == "manage"
    assert pending["required_perms"] == ["Auth.manage"]
    assert pending["input_model"] == "ListPendingPairingsRequest"
    assert pending["output_model"] == "ListPendingPairingsResponse"

    approve = methods[AuthMethods.PAIRING_APPROVE]
    assert approve["method_type"] == "manage"
    assert approve["required_perms"] == ["Auth.manage"]

    deny = methods[AuthMethods.PAIRING_DENY]
    assert deny["routePath"] == "/api/Auth/PairingDeny"
    assert deny["method_type"] == "manage"
    assert deny["required_perms"] == ["Auth.manage"]


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
    assert not auth.should_bypass("/api/Auth/ListPendingPairings")
    assert not auth.should_bypass("/api/Auth/PairingDeny")
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
