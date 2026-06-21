"""Model runtime/catalog contract tests."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.services.orchestrator.service import OrchestratorService
from app.shared.contracts.models.orchestrator import (
    ModelRuntimeCatalogRequest,
    ModelRuntimeOperationRequest,
    ModelRuntimeOperationStatusRequest,
    OrchestratorMethods,
)
from app.shared.contracts.registry import all_contracts, clear_registry  # noqa: E402


def _services_config(model_path: Path) -> dict:
    return {
        "orchestrator": {
            "hardware_acceleration": True,
            "llm": {
                "provider": "llama_cpp",
                "third_party": {
                    "openai": {
                        "options": {
                            "api_key": "sk-secret-value",
                            "model": "gpt-4o",
                            "max_tokens": 512,
                        }
                    },
                    "huggingface_endpoint": {
                        "options": {
                            "endpoint_url": "https://token.example/inference",
                            "model": "org/model",
                            "max_tokens": 256,
                        }
                    },
                },
                "local": {
                    "huggingface_pipeline": {
                        "options": {
                            "model": "microsoft/DialoGPT-medium",
                            "device": "cuda",
                            "torch_dtype": "float16",
                            "max_tokens": 128,
                        }
                    },
                    "llama_cpp": {
                        "options": {
                            "model_path": str(model_path),
                            "n_ctx": 4096,
                            "max_tokens": 1024,
                            "n_gpu_layers": 12,
                            "n_batch": 512,
                        }
                    },
                },
            },
        }
    }


def test_model_runtime_contracts_register_with_permissions():
    clear_registry()
    OrchestratorService()

    contracts = all_contracts()
    assert contracts[OrchestratorMethods.INTERRUPT].exposure == "external"
    assert contracts[OrchestratorMethods.INTERRUPT].method_type == "use"
    assert contracts[OrchestratorMethods.INTERRUPT].required_perms == ["Orchestrator.use"]

    assert contracts[OrchestratorMethods.GET_MODEL_CATALOG].exposure == "external"
    assert contracts[OrchestratorMethods.GET_MODEL_CATALOG].method_type == "use"
    assert contracts[OrchestratorMethods.GET_MODEL_CATALOG].required_perms == ["Orchestrator.use"]

    assert contracts[OrchestratorMethods.IMPORT_MODEL].exposure == "external"
    assert contracts[OrchestratorMethods.IMPORT_MODEL].method_type == "manage"
    assert contracts[OrchestratorMethods.IMPORT_MODEL].required_perms == ["Orchestrator.manage"]
    assert contracts[OrchestratorMethods.DOWNLOAD_MODEL].method_type == "manage"
    assert contracts[OrchestratorMethods.BENCHMARK_MODEL].method_type == "manage"


@pytest.mark.asyncio
async def test_model_catalog_reports_configured_providers_and_redacts_secrets(tmp_path):
    model_file = tmp_path / "private-model.gguf"
    model_file.write_bytes(b"gguf")
    config_api = AsyncMock()
    config_api.aget_config = AsyncMock(return_value=_services_config(model_file))

    service = OrchestratorService()
    with patch("app.services.orchestrator.service.ConfigAPI", return_value=config_api):
        catalog = await service.get_model_catalog(ModelRuntimeCatalogRequest())

    assert catalog.selected_provider_id == "llama_cpp"
    assert catalog.provider_index["selected"] == ["llama_cpp"]
    assert catalog.secrets_redacted is True

    llama = next(provider for provider in catalog.providers if provider.provider_id == "llama_cpp")
    assert llama.selected is True
    assert llama.backend_kind == "llama_cpp"
    assert llama.context_window == 4096
    assert llama.model_files[0].display_name == "private-model.gguf"
    assert llama.model_files[0].exists is True
    assert llama.model_files[0].path_redacted is True

    openai = next(provider for provider in catalog.providers if provider.provider_id == "openai")
    assert openai.health == "available"
    dumped = catalog.model_dump_json()
    assert "sk-secret-value" not in dumped
    assert str(tmp_path) not in dumped
    assert "token.example/inference" not in dumped
    assert "https://redacted" in dumped


@pytest.mark.asyncio
async def test_model_runtime_operations_are_explicitly_unsupported_and_queryable():
    service = OrchestratorService()

    response = await service.import_model(
        ModelRuntimeOperationRequest(
            provider_id="llama_cpp",
            model_id="private-model.gguf",
            source_uri="https://example.invalid/private-model.gguf",
        )
    )

    assert response.status == "unsupported"
    assert response.reason_code == "operation_not_supported"
    assert response.audit_event == "model_runtime.import.unsupported"
    assert response.secrets_redacted is True

    lookup = await service.get_model_operation(
        ModelRuntimeOperationStatusRequest(operation_id=response.operation_id)
    )
    assert lookup == response

    missing = await service.get_model_operation(
        ModelRuntimeOperationStatusRequest(operation_id="missing")
    )
    assert missing.status == "unknown"
    assert missing.reason_code == "operation_not_found"
