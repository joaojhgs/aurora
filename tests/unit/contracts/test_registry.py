"""Unit tests for the contract registry."""

import json
from types import SimpleNamespace

import pytest

from app.shared.contracts.mesh_surface import (
    duplicate_feature_keys,
    feature_contracts_for_topic,
    validate_callable_method_surface,
)
from app.shared.contracts.registry import (
    CallableFeatureContract,
    IOModel,
    all_contracts,
    clear_registry,
    export,
    get_contract,
    import_registry,
    list_modules,
    method_contract,
    register_module,
)


# Test models
class TestInput(IOModel):
    text: str


class TestOutput(IOModel):
    result: str


@pytest.fixture(autouse=True)
def clean_registry():
    """Clear registry before and after each test."""
    clear_registry()
    yield
    clear_registry()


def test_register_module():
    """Test module registration."""
    register_module("TestModule", "1.0.0", summary="Test module", capabilities=["test"])

    modules = list_modules()
    assert "TestModule" in modules
    assert modules["TestModule"].version == "1.0.0"
    assert modules["TestModule"].summary == "Test module"
    assert modules["TestModule"].capabilities == ["test"]


def test_method_contract_decorator():
    """Test that @method_contract registers methods and auto-creates modules."""
    from app.shared.contracts.registry import register_method

    # Register module first
    register_module("TestModule", "1.0.0", summary="Test module", capabilities=["test"])

    @method_contract(
        method_id="TestModule.TestMethod",
        summary="Test method",
        input_model=TestInput,
        output_model=TestOutput,
        exposure="both",
    )
    async def test_method(req: TestInput) -> TestOutput:
        return TestOutput(result=f"Processed: {req.text}")

    # Manually register the method (normally done by BaseService)
    register_method("TestModule", "TestMethod", test_method, test_method._contract_metadata)

    # Check method is registered (by full bus_topic)
    contract = get_contract("TestModule.TestMethod")
    assert contract is not None
    assert contract.module == "TestModule"
    assert contract.name == "TestMethod"
    assert contract.exposure == "both"

    # Check module exists
    modules = list_modules()
    assert "TestModule" in modules
    assert len(modules["TestModule"].methods) == 1
    assert modules["TestModule"].methods[0].name == "TestMethod"


def test_export_import_roundtrip():
    """Test that export() and import_registry() work correctly."""
    from app.shared.contracts.registry import register_method

    # Register a module and method
    register_module("TTS", "1.0.0", summary="Text-to-Speech", capabilities=["streaming"])

    @method_contract(
        method_id="TTS.Request",
        summary="Synthesize speech",
        input_model=TestInput,
        output_model=None,
        exposure="both",
        required_perms=["TTS.Request"],
        callable_feature_ids=["speech_playback"],
    )
    async def tts_request(req: TestInput) -> None:
        pass

    # Manually register the method
    register_method("TTS", "Request", tts_request, tts_request._contract_metadata)

    # Export registry
    exported = export()
    assert exported is not None

    # Parse export
    data = json.loads(exported)
    assert "modules" in data
    assert "digest" in data
    assert len(data["digest"]) == 64  # SHA256 hex digest

    # Check module data
    assert len(data["modules"]) == 1
    module_data = data["modules"][0]
    assert module_data["module"] == "TTS"
    assert module_data["version"] == "1.0.0"
    assert module_data["summary"] == "Text-to-Speech"
    assert module_data["capabilities"] == ["streaming"]

    # Check method data
    assert len(module_data["methods"]) == 1
    method_data = module_data["methods"][0]
    assert method_data["name"] == "Request"
    assert method_data["exposure"] == "both"
    assert method_data["required_perms"] == ["TTS.Request"]
    assert method_data["callable_feature_ids"] == ["speech_playback"]
    assert method_data["callable_features"][0]["feature_id"] == "speech_playback"

    # Test import
    imported_data = import_registry(exported)
    assert imported_data["digest"] == data["digest"]


def test_mesh_callable_method_requires_permissions_and_feature_membership():
    """Ordinary mesh-callable methods fail closed without both required metadata fields."""

    from app.shared.contracts.registry import register_method

    register_module("TTS", "1.0.0")

    @method_contract(
        method_id="TTS.Request",
        input_model=TestInput,
        exposure="both",
        required_perms=["TTS.Request"],
    )
    async def missing_feature(req: TestInput) -> None:
        pass

    with pytest.raises(ValueError, match="missing callable feature membership"):
        register_method("TTS", "Request", missing_feature, missing_feature._contract_metadata)

    @method_contract(
        method_id="TTS.Synthesize",
        input_model=TestInput,
        exposure="both",
        callable_feature_ids=["speech_synthesis"],
    )
    async def missing_perms(req: TestInput) -> None:
        pass

    with pytest.raises(ValueError, match="missing required_perms"):
        register_method("TTS", "Synthesize", missing_perms, missing_perms._contract_metadata)


def test_mesh_callable_method_rejects_invalid_feature_membership():
    """Feature IDs are exact stable IDs, not inferred from topic names."""

    from app.shared.contracts.registry import register_method

    register_module("TTS", "1.0.0")

    @method_contract(
        method_id="TTS.Request",
        input_model=TestInput,
        exposure="both",
        required_perms=["TTS.Request"],
        callable_feature_ids=["speech_synthesis"],
    )
    async def invalid_feature(req: TestInput) -> None:
        pass

    with pytest.raises(ValueError, match="invalid callable feature IDs"):
        register_method("TTS", "Request", invalid_feature, invalid_feature._contract_metadata)


def test_mesh_callable_method_rejects_internal_feature_membership():
    """Internal-only methods are not mesh-callable and cannot claim callable groups."""

    from app.shared.contracts.registry import register_method

    register_module("TTS", "1.0.0")

    @method_contract(
        method_id="TTS.Request",
        input_model=TestInput,
        exposure="internal",
        callable_feature_ids=["speech_playback"],
    )
    async def internal_feature(req: TestInput) -> None:
        pass

    with pytest.raises(ValueError, match="internal methods must not declare callable features"):
        register_method("TTS", "Request", internal_feature, internal_feature._contract_metadata)


def test_callable_taxonomy_validation_fails_closed(monkeypatch):
    """Canonical taxonomy mutations fail closed before registry use."""

    from app.shared.contracts import mesh_surface
    from app.shared.contracts.registry import validate_canonical_taxonomy

    validate_canonical_taxonomy.cache_clear()
    baseline_features = mesh_surface.CALLABLE_FEATURES
    baseline_modules = mesh_surface.MESH_CAPABLE_MODULES

    def assert_invalid(
        features, modules=baseline_modules, match="Invalid callable feature taxonomy"
    ):
        monkeypatch.setattr(mesh_surface, "CALLABLE_FEATURES", features)
        monkeypatch.setattr(mesh_surface, "MESH_CAPABLE_MODULES", modules)
        validate_canonical_taxonomy.cache_clear()
        with pytest.raises(ValueError, match=match):
            validate_canonical_taxonomy()

    first = baseline_features[0]
    duplicate_group = first.model_copy(update={"method_ids": ("STTCoordinator.StopListening",)})
    assert_invalid((first, duplicate_group, *baseline_features[2:]))

    duplicate_topic = baseline_features[1].model_copy(update={"method_ids": first.method_ids})
    assert_invalid((first, duplicate_topic, *baseline_features[2:]))

    empty_id = first.model_copy(update={"feature_id": ""})
    assert_invalid((empty_id, *baseline_features[1:]))

    invalid_id = first.model_copy(update={"feature_id": "Bad ID"})
    assert_invalid((invalid_id, *baseline_features[1:]))

    missing_classification = tuple(
        feature for feature in baseline_features if feature.module != "WakeWord"
    )
    assert_invalid(missing_classification)

    wrong_module_topic = first.model_copy(update={"method_ids": ("TTS.Request",)})
    assert_invalid((wrong_module_topic, *baseline_features[1:]))

    malformed = (object(), *baseline_features[1:])
    assert_invalid(malformed)

    monkeypatch.setattr(mesh_surface, "CALLABLE_FEATURES", baseline_features)
    monkeypatch.setattr(mesh_surface, "MESH_CAPABLE_MODULES", baseline_modules)
    validate_canonical_taxonomy.cache_clear()
    validate_canonical_taxonomy()


def test_callable_taxonomy_feature_uniqueness_is_module_scoped():
    """Feature IDs may repeat across modules, but not within the same module."""

    first = CallableFeatureContract(
        feature_id="shared_id",
        module="TTS",
        method_ids=("TTS.Request",),
    )
    cross_module = CallableFeatureContract(
        feature_id="shared_id",
        module="DB",
        method_ids=("DB.GetMessages",),
    )
    same_module = CallableFeatureContract(
        feature_id="shared_id",
        module="TTS",
        method_ids=("TTS.Synthesize",),
    )

    assert duplicate_feature_keys((first, cross_module)) == []
    assert duplicate_feature_keys((first, same_module)) == [("TTS", "shared_id")]


def test_only_exact_auth_bootstrap_methods_accept_public_infrastructure_marker():
    """The public infrastructure marker is a narrow allowlist."""

    from app.shared.contracts.registry import register_method

    register_module("Auth", "1.0.0")

    @method_contract(
        method_id="Auth.PairingStart",
        input_model=TestInput,
        exposure="both",
    )
    async def unmarked_pairing_start(req: TestInput) -> None:
        pass

    with pytest.raises(ValueError, match="missing public_infrastructure marker"):
        register_method(
            "Auth",
            "PairingStart",
            unmarked_pairing_start,
            unmarked_pairing_start._contract_metadata,
        )

    @method_contract(
        method_id="Auth.Login",
        input_model=TestInput,
        exposure="both",
        public_infrastructure=True,
    )
    async def login(req: TestInput) -> None:
        pass

    register_method("Auth", "Login", login, login._contract_metadata)
    assert get_contract("Auth.Login").public_infrastructure is True

    @method_contract(
        method_id="Auth.WhoAmI",
        input_model=TestInput,
        exposure="both",
        public_infrastructure=True,
    )
    async def whoami(req: TestInput) -> None:
        pass

    with pytest.raises(ValueError, match="not an allowed public infrastructure method"):
        register_method("Auth", "WhoAmI", whoami, whoami._contract_metadata)


def test_public_infrastructure_wire_surface_rejects_spoofed_auth_topic_and_features():
    """Wire metadata cannot spoof Auth bootstrap or attach callable feature membership."""

    spoofed_auth_topic = SimpleNamespace(
        module="TTS",
        name="Login",
        bus_topic="Auth.Login",
        exposure="both",
        required_perms=[],
        callable_feature_ids=[],
        callable_features=[],
        public_infrastructure=True,
    )
    assert validate_callable_method_surface(spoofed_auth_topic) == [
        "Auth.Login public infrastructure must be in Auth",
        "Auth.Login public infrastructure module/topic mismatch: module=TTS",
    ]

    feature_bearing_auth = SimpleNamespace(
        module="Auth",
        name="Login",
        bus_topic="Auth.Login",
        exposure="both",
        required_perms=[],
        callable_feature_ids=["speech_playback"],
        callable_features=list(feature_contracts_for_topic("TTS.Request")),
        public_infrastructure=True,
    )
    assert validate_callable_method_surface(feature_bearing_auth) == [
        "Auth.Login public infrastructure must not declare callable features"
    ]


def test_internal_wire_surface_rejects_id_or_object_callable_membership():
    """Internal methods cannot bypass validation with object-only callable metadata."""

    id_membership = SimpleNamespace(
        module="TTS",
        name="Request",
        bus_topic="TTS.Request",
        exposure="internal",
        required_perms=[],
        callable_feature_ids=["speech_playback"],
        callable_features=[],
        public_infrastructure=False,
    )
    object_membership = SimpleNamespace(
        module="TTS",
        name="Request",
        bus_topic="TTS.Request",
        exposure="internal",
        required_perms=[],
        callable_feature_ids=[],
        callable_features=list(feature_contracts_for_topic("TTS.Request")),
        public_infrastructure=False,
    )

    assert "TTS.Request internal methods must not declare callable features" in (
        validate_callable_method_surface(id_membership)
    )
    assert validate_callable_method_surface(object_membership) == [
        "TTS.Request internal methods must not declare callable features"
    ]


def test_digest_changes_on_modification():
    """Test that digest changes when registry content changes."""
    from app.shared.contracts.registry import register_method

    register_module("Module1", "1.0.0")

    @method_contract(
        method_id="Module1.Method1",
        input_model=TestInput,
    )
    async def method1(req: TestInput) -> None:
        pass

    register_method("Module1", "Method1", method1, method1._contract_metadata)

    export1 = export()
    data1 = json.loads(export1)
    digest1 = data1["digest"]

    # Add another method
    @method_contract(
        method_id="Module1.Method2",
        input_model=TestInput,
    )
    async def method2(req: TestInput) -> None:
        pass

    register_method("Module1", "Method2", method2, method2._contract_metadata)

    export2 = export()
    data2 = json.loads(export2)
    digest2 = data2["digest"]

    # Digests should be different
    assert digest1 != digest2


def test_all_contracts():
    """Test retrieving all contracts."""
    from app.shared.contracts.registry import register_method

    register_module("Mod1", "1.0.0")

    @method_contract(
        method_id="Mod1.Method1",
        input_model=TestInput,
    )
    async def m1(req: TestInput) -> None:
        pass

    @method_contract(
        method_id="Mod1.Method2",
        input_model=TestInput,
    )
    async def m2(req: TestInput) -> None:
        pass

    register_method("Mod1", "Method1", m1, m1._contract_metadata)
    register_method("Mod1", "Method2", m2, m2._contract_metadata)

    contracts = all_contracts()
    assert len(contracts) == 2
    assert "Mod1.Method1" in contracts
    assert "Mod1.Method2" in contracts


def test_module_auto_creation():
    """Test that modules are automatically created when using @method_contract."""
    from app.shared.contracts.registry import register_method

    # Note: With new API, modules can be auto-created if not registered
    # when register_method is called
    @method_contract(
        method_id="AutoModule.AutoMethod",
        input_model=TestInput,
    )
    async def auto_method(req: TestInput) -> None:
        pass

    # Register method - this will auto-create module if it doesn't exist
    register_method("AutoModule", "AutoMethod", auto_method, auto_method._contract_metadata)

    modules = list_modules()
    assert "AutoModule" in modules
    assert modules["AutoModule"].version is not None  # Auto-detected
    assert len(modules["AutoModule"].methods) == 1


def test_explicit_module_registration_preserves_metadata():
    """Test that explicitly registering a module preserves its metadata."""
    from app.shared.contracts.registry import register_method

    register_module(
        "ExplicitModule",
        "3.0.0",
        summary="Explicit module",
        capabilities=["cap1", "cap2"],
        depends_on={"OtherModule": ">=1.0.0"},
    )

    @method_contract(
        method_id="ExplicitModule.ExplicitMethod",
        input_model=TestInput,
    )
    async def explicit_method(req: TestInput) -> None:
        pass

    register_method(
        "ExplicitModule", "ExplicitMethod", explicit_method, explicit_method._contract_metadata
    )

    modules = list_modules()
    module = modules["ExplicitModule"]
    assert module.summary == "Explicit module"
    assert module.capabilities == ["cap1", "cap2"]
    assert module.depends_on == {"OtherModule": ">=1.0.0"}
    assert len(module.methods) == 1
