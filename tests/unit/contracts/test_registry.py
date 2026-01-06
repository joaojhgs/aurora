"""Unit tests for the contract registry."""

import json

import pytest

from app.shared.contracts.registry import (
    IOModel,
    MethodContract,
    ModuleContract,
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

    # Check method is registered (by method name, not full method_id)
    contract = get_contract("TestMethod")
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

    # Test import
    imported_data = import_registry(exported)
    assert imported_data["digest"] == data["digest"]


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
    assert "Method1" in contracts
    assert "Method2" in contracts


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

    register_method("ExplicitModule", "ExplicitMethod", explicit_method, explicit_method._contract_metadata)

    modules = list_modules()
    module = modules["ExplicitModule"]
    assert module.summary == "Explicit module"
    assert module.capabilities == ["cap1", "cap2"]
    assert module.depends_on == {"OtherModule": ">=1.0.0"}
    assert len(module.methods) == 1
