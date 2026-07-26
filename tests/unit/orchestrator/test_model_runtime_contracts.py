"""Model runtime/catalog contract tests."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.messaging import Envelope
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable
from app.services.orchestrator.service import (
    OrchestratorService,
    _fetch_openai_model_catalog,
    _remote_model_providers,
)
from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import (
    ModelRuntimeCatalogRequest,
    ModelRuntimeCatalogResponse,
    ModelRuntimeModelInfo,
    ModelRuntimeOperationRequest,
    ModelRuntimeOperationStatusRequest,
    ModelRuntimeProviderInfo,
    OrchestratorChatMessage,
    OrchestratorInferChatRequest,
    OrchestratorMethods,
)
from app.shared.contracts.registry import all_contracts, clear_registry  # noqa: E402
from tests.unit.gateway.mesh_policy_helpers import mesh_policy
from tests.unit.gateway.verified_manifest_helpers import verified_peer_manifest


class _FakeInferenceMessage:
    def __init__(self, content: str = "ok") -> None:
        self.content = content
        self.response_metadata = {"finish_reason": "stop"}


class _FakeInferenceLLM:
    def __init__(self) -> None:
        self.messages = None

    async def ainvoke(self, messages):
        self.messages = messages
        return _FakeInferenceMessage("configured runtime response")

    async def astream(self, messages):
        self.messages = messages
        yield _FakeInferenceMessage("chunk")


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
    assert contracts[OrchestratorMethods.INFER_CHAT].exposure == "external"
    assert contracts[OrchestratorMethods.INFER_CHAT].method_type == "use"
    assert contracts[OrchestratorMethods.INFER_CHAT].required_perms == ["Orchestrator.use"]
    assert contracts[OrchestratorMethods.STREAM_INFER_CHAT].exposure == "external"
    assert contracts[OrchestratorMethods.STREAM_INFER_CHAT].method_type == "use"
    assert contracts[OrchestratorMethods.STREAM_INFER_CHAT].required_perms == ["Orchestrator.use"]

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
    assert llama.provider_type == "local"
    assert llama.provider_kind == "local"
    assert llama.upstream_provider_type == "llama_cpp"
    assert llama.provider_peer_id == "local"
    assert llama.provider_service_instance_id == "local:Orchestrator"
    assert llama.enabled is True
    assert llama.health == "available"
    assert set(catalog.provider_index["local"]) == {"llama_cpp", "huggingface_pipeline"}
    assert llama.backend_kind == "llama_cpp"
    assert llama.default_model_id == "private-model.gguf"
    assert llama.models[0].model_id == "private-model.gguf"
    assert llama.models[0].default is True
    assert llama.models[0].provider_kind == "local"
    assert llama.model_catalog["source"] == "configured"
    assert llama.model_catalog["count"] == 1
    assert llama.context_window == 4096
    assert llama.model_files[0].display_name == "private-model.gguf"
    assert llama.model_files[0].exists is True
    assert llama.model_files[0].path_redacted is True

    openai = next(provider for provider in catalog.providers if provider.provider_id == "openai")
    assert openai.health == "available"
    assert openai.provider_kind == "cloud"
    assert openai.upstream_provider_type == "openai"
    assert openai.default_model_id == "gpt-4o"
    assert [model.model_id for model in openai.models] == ["gpt-4o"]
    dumped = catalog.model_dump_json()
    assert "sk-secret-value" not in dumped
    assert str(tmp_path) not in dumped
    assert "token.example/inference" not in dumped
    assert "https://redacted" in dumped


@pytest.mark.asyncio
async def test_model_catalog_can_include_mocked_openai_cloud_models(tmp_path):
    model_file = tmp_path / "private-model.gguf"
    model_file.write_bytes(b"gguf")
    config_api = AsyncMock()
    config_api.aget_config = AsyncMock(return_value=_services_config(model_file))
    fetched_catalog = {
        "source": "openai_api",
        "status": "available",
        "models": [
            {
                "model_id": "gpt-4.1",
                "metadata": {"owned_by": "openai", "api_key": "sk-should-redact"},
            },
            {"model_id": "gpt-4o"},
        ],
        "fetched_at": "2026-07-06T00:00:00Z",
        "secrets_redacted": True,
    }

    service = OrchestratorService()
    with (
        patch("app.services.orchestrator.service.ConfigAPI", return_value=config_api),
        patch(
            "app.services.orchestrator.service._fetch_openai_model_catalog",
            new=AsyncMock(return_value=fetched_catalog),
        ) as fetch_models,
    ):
        catalog = await service.get_model_catalog(
            ModelRuntimeCatalogRequest(include_cloud_models=True, include_remote=True)
        )

    fetch_models.assert_awaited_once()
    openai = next(provider for provider in catalog.providers if provider.provider_id == "openai")
    assert openai.model_catalog["source"] == "openai_api"
    assert openai.model_catalog["status"] == "available"
    assert openai.model_catalog["count"] == 2
    assert [model.model_id for model in openai.models] == ["gpt-4.1", "gpt-4o"]
    assert next(model for model in openai.models if model.model_id == "gpt-4o").default is True
    assert (
        next(model for model in openai.models if model.model_id == "gpt-4.1").metadata["api_key"]
        == "[redacted]"
    )
    assert "sk-secret-value" not in catalog.model_dump_json()
    assert "sk-should-redact" not in catalog.model_dump_json()


@pytest.mark.asyncio
async def test_openai_model_catalog_helper_uses_cache_without_real_api():
    class FakeModels:
        def __init__(self):
            self.calls = 0

        async def list(self):
            self.calls += 1
            return {"data": [{"id": "gpt-test", "owned_by": "openai"}]}

    class FakeClient:
        models = FakeModels()

        def __init__(self, *, api_key: str):
            assert api_key == "sk-test-value"

    cache: dict = {}
    first = await _fetch_openai_model_catalog(
        api_key="sk-test-value",
        cache=cache,
        client_factory=FakeClient,
    )
    second = await _fetch_openai_model_catalog(
        api_key="sk-test-value",
        cache=cache,
        client_factory=FakeClient,
    )

    assert first["status"] == "available"
    assert first["models"][0]["model_id"] == "gpt-test"
    assert second["cache_hit"] is True
    assert FakeClient.models.calls == 1


@pytest.mark.asyncio
async def test_openai_model_catalog_filters_non_chat_models():
    class FakeModels:
        async def list(self):
            return {
                "data": [
                    {"id": "gpt-4o"},
                    {"id": "text-embedding-3-small"},
                    {"id": "tts-1"},
                    {"id": "dall-e-3"},
                    {"id": "omni-moderation-latest"},
                ]
            }

    class FakeClient:
        models = FakeModels()

        def __init__(self, *, api_key: str):
            assert api_key == "sk-test-value"

    catalog = await _fetch_openai_model_catalog(
        api_key="sk-test-value",
        cache={},
        client_factory=FakeClient,
    )

    assert [model["model_id"] for model in catalog["models"]] == ["gpt-4o"]
    assert catalog["models"][0]["capabilities"] == ["chat"]


def test_remote_model_providers_preserve_distinct_runtime_provider_ids():
    providers = [
        ModelRuntimeProviderInfo(
            provider_id="openai",
            display_name="OpenAI",
            backend_kind="langchain",
            provider_type="cloud",
            provider_kind="cloud",
            provider_peer_id="local",
            provider_service_instance_id="local:Orchestrator",
            models=[
                ModelRuntimeModelInfo(
                    model_id="gpt-4o",
                    provider_id="openai",
                    provider_kind="cloud",
                    upstream_provider_type="openai",
                )
            ],
        ),
        ModelRuntimeProviderInfo(
            provider_id="llama_cpp",
            display_name="llama.cpp",
            backend_kind="langchain",
            provider_type="local",
            provider_kind="local",
            provider_peer_id="local",
            provider_service_instance_id="local:Orchestrator",
            models=[
                ModelRuntimeModelInfo(
                    model_id="local.gguf",
                    provider_id="llama_cpp",
                    provider_kind="local",
                    upstream_provider_type="llama_cpp",
                )
            ],
        ),
    ]

    remote = _remote_model_providers(providers, peer_id="lab")

    assert [provider.provider_id for provider in remote] == [
        "remote:lab:Orchestrator:openai",
        "remote:lab:Orchestrator:llama_cpp",
    ]
    assert remote[0].provider_service_instance_id == "remote:lab:Orchestrator"
    assert remote[0].models[0].metadata["runtime_provider_id"] == "openai"


@pytest.mark.asyncio
async def test_model_runtime_operations_are_explicitly_unsupported_and_queryable():
    service = OrchestratorService()

    operations = [
        ("import", service.import_model),
        ("download", service.download_model),
        ("benchmark", service.benchmark_model),
    ]

    for operation_type, handler in operations:
        response = await handler(
            ModelRuntimeOperationRequest(
                provider_id="llama_cpp",
                model_id="private-model.gguf",
                source_uri="https://example.invalid/private-model.gguf",
                dry_run=True,
            )
        )

        assert response.operation_type == operation_type
        assert response.status == "unsupported"
        assert response.reason_code == "operation_not_supported"
        assert response.audit_event == f"model_runtime.{operation_type}.unsupported"
        assert "UI/SDK must keep the action disabled or degraded" in response.message
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


@pytest.mark.asyncio
async def test_model_catalog_remote_merge_normalizes_service_instance_selector_peer_id(tmp_path):
    model_file = tmp_path / "private-model.gguf"
    model_file.write_bytes(b"gguf")
    config_api = AsyncMock()
    config_api.aget_config = AsyncMock(return_value=_services_config(model_file))
    remote_catalog = ModelRuntimeCatalogResponse(
        generated_at="2026-07-06T00:00:00Z",
        selected_provider_id="llama_cpp",
        providers=[
            ModelRuntimeProviderInfo(
                provider_id="llama_cpp",
                display_name="Remote Llama",
                backend_kind="llama_cpp",
                provider_type="local",
                provider_kind="local",
                models=[
                    ModelRuntimeModelInfo(
                        model_id="remote-model.gguf",
                        provider_id="llama_cpp",
                        provider_kind="local",
                    )
                ],
            )
        ],
        provider_index={},
    )
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=type("Result", (), {"ok": True, "data": remote_catalog})())

    service = OrchestratorService()
    from app.shared.messaging.bus_init import set_bus

    set_bus(bus)
    with patch("app.services.orchestrator.service.ConfigAPI", return_value=config_api):
        catalog = await service.get_model_catalog(
            ModelRuntimeCatalogRequest(
                include_remote=True,
                catalog_selector=MeshAddressSelector(
                    service_instance_id="remote:raspi-lab:Orchestrator"
                ),
            )
        )

    remote = next(provider for provider in catalog.providers if provider.provider_type == "remote")
    assert remote.provider_id == "remote:raspi-lab:Orchestrator:llama_cpp"
    assert remote.provider_peer_id == "raspi-lab"
    assert remote.provider_service_instance_id == "remote:raspi-lab:Orchestrator"
    assert remote.model_catalog["remote_provider_id"] == "llama_cpp"
    assert remote.models[0].provider_id == "remote:raspi-lab:Orchestrator:llama_cpp"
    assert remote.models[0].metadata["provider_peer_id"] == "raspi-lab"
    assert remote.models[0].metadata["remote_provider_id"] == "llama_cpp"
    remote_request = bus.request.await_args.args[1]
    assert remote_request.dispatch_selector.service_instance_id == "remote:raspi-lab:Orchestrator"
    assert remote_request.catalog_selector is None

    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-test",
        services={"Orchestrator": mesh_policy(prefer="local")},
    )
    peer_registry = PeerRegistry(mesh_config)
    await peer_registry.register_peer("raspi-lab")
    await peer_registry.update_manifest(
        "raspi-lab",
        verified_peer_manifest(
            "raspi-lab",
            [
                PeerServiceInfo(
                    module="Orchestrator",
                    version="1.0.0",
                    methods=[
                        MethodInfo(
                            name="InferChat",
                            bus_topic=OrchestratorMethods.INFER_CHAT,
                            exposure="external",
                            method_type="use",
                            required_perms=["Orchestrator.use"],
                        )
                    ],
                )
            ],
        ),
    )
    route = RoutingTable(mesh_config, peer_registry).resolve(
        OrchestratorMethods.INFER_CHAT,
        selector=MeshAddressSelector(provider_id=remote.provider_id),
    )

    assert route.target == "remote"
    assert route.peer_id == "raspi-lab"
    assert route.module == "Orchestrator"


@pytest.mark.asyncio
async def test_infer_chat_defaults_to_configured_provider_model_and_ignores_params(tmp_path):
    model_file = tmp_path / "private-model.gguf"
    model_file.write_bytes(b"gguf")
    config_api = AsyncMock()
    config_api.aget_config = AsyncMock(return_value=_services_config(model_file))
    service = OrchestratorService()
    fake_llm = _FakeInferenceLLM()

    with (
        patch("app.services.orchestrator.service.ConfigAPI", return_value=config_api),
        patch.object(service, "_inference_llm", new=AsyncMock(return_value=fake_llm)),
    ):
        response = await service.infer_chat(
            OrchestratorInferChatRequest(
                messages=[OrchestratorChatMessage(role="user", content="hello")],
                params={"temperature": 99, "model": "caller-override"},
            )
        )

    assert response.provider_id == "llama_cpp"
    assert response.model_id == "private-model.gguf"
    assert response.text == "configured runtime response"
    assert response.metadata["caller_params_ignored"] is True
    assert fake_llm.messages == [{"role": "user", "content": "hello"}]


@pytest.mark.asyncio
async def test_infer_chat_allows_advertised_non_default_provider_model_without_params(tmp_path):
    model_file = tmp_path / "private-model.gguf"
    model_file.write_bytes(b"gguf")
    config_api = AsyncMock()
    config_api.aget_config = AsyncMock(return_value=_services_config(model_file))
    service = OrchestratorService()
    fake_llm = _FakeInferenceLLM()
    provider_llm = AsyncMock(return_value=fake_llm)

    with (
        patch("app.services.orchestrator.service.ConfigAPI", return_value=config_api),
        patch.object(service, "_configured_provider_inference_llm", new=provider_llm),
    ):
        response = await service.infer_chat(
            OrchestratorInferChatRequest(
                messages=[OrchestratorChatMessage(role="user", content="hello")],
                provider_id="openai",
                model_id="gpt-4o",
                params={"api_key": "caller-secret-must-not-be-used", "temperature": 99},
            )
        )

    assert response.provider_id == "openai"
    assert response.model_id == "gpt-4o"
    assert response.metadata["caller_params_ignored"] is True
    provider_llm.assert_awaited_once_with("openai", "gpt-4o")
    assert fake_llm.messages == [{"role": "user", "content": "hello"}]


@pytest.mark.asyncio
async def test_infer_chat_denies_explicit_external_selection_before_cloud_catalog_fetch(tmp_path):
    model_file = tmp_path / "private-model.gguf"
    model_file.write_bytes(b"gguf")
    service = OrchestratorService()
    request = OrchestratorInferChatRequest(
        messages=[OrchestratorChatMessage(role="user", content="hello")],
        provider_id="openai",
        model_id="gpt-4.1",
    )
    envelope = Envelope(
        type=OrchestratorMethods.INFER_CHAT,
        payload=request,
        origin="external",
        principal_id="principal-1",
        effective_perms=["Orchestrator.use"],
        identity_source="gateway_http",
    )

    with (
        patch.object(
            service,
            "_build_model_runtime_catalog",
            new=AsyncMock(side_effect=AssertionError("catalog should not be fetched")),
        ) as build_catalog,
        patch.object(service, "_inference_llm", new=AsyncMock()) as inference_llm,
        pytest.raises(PermissionError, match="RemoteInference"),
    ):
        await service.infer_chat(request, envelope=envelope)

    build_catalog.assert_not_awaited()
    inference_llm.assert_not_awaited()


@pytest.mark.asyncio
async def test_stream_infer_chat_denies_explicit_external_selection_before_cloud_catalog_fetch(
    tmp_path,
):
    model_file = tmp_path / "private-model.gguf"
    model_file.write_bytes(b"gguf")
    service = OrchestratorService()
    request = OrchestratorInferChatRequest(
        messages=[OrchestratorChatMessage(role="user", content="hello")],
        provider_id="openai",
        model_id="gpt-4.1",
        stream=True,
    )
    envelope = Envelope(
        type=OrchestratorMethods.STREAM_INFER_CHAT,
        payload=request,
        origin="external",
        principal_id="principal-1",
        effective_perms=["Orchestrator.use"],
        identity_source="gateway_http",
    )

    with (
        patch.object(
            service,
            "_build_model_runtime_catalog",
            new=AsyncMock(side_effect=AssertionError("catalog should not be fetched")),
        ) as build_catalog,
        patch.object(service, "_inference_llm", new=AsyncMock()) as inference_llm,
        pytest.raises(PermissionError, match="RemoteInference"),
    ):
        await service.stream_infer_chat(request, envelope=envelope)

    build_catalog.assert_not_awaited()
    inference_llm.assert_not_awaited()


@pytest.mark.asyncio
async def test_infer_chat_permitted_explicit_selection_may_fetch_cloud_catalog(tmp_path):
    model_file = tmp_path / "private-model.gguf"
    model_file.write_bytes(b"gguf")
    config_api = AsyncMock()
    config_api.aget_config = AsyncMock(return_value=_services_config(model_file))
    service = OrchestratorService()
    fake_llm = _FakeInferenceLLM()
    request = OrchestratorInferChatRequest(
        messages=[OrchestratorChatMessage(role="user", content="hello")],
        provider_id="openai",
        model_id="gpt-4.1",
    )
    envelope = Envelope(
        type=OrchestratorMethods.INFER_CHAT,
        payload=request,
        origin="external",
        principal_id="principal-1",
        effective_perms=["Orchestrator.RemoteInference"],
        identity_source="gateway_http",
    )
    fetched_catalog = {
        "source": "openai_api",
        "status": "available",
        "models": [{"model_id": "gpt-4.1"}, {"model_id": "gpt-4o"}],
        "secrets_redacted": True,
    }

    with (
        patch("app.services.orchestrator.service.ConfigAPI", return_value=config_api),
        patch(
            "app.services.orchestrator.service._fetch_openai_model_catalog",
            new=AsyncMock(return_value=fetched_catalog),
        ) as fetch_models,
        patch.object(
            service, "_configured_provider_inference_llm", new=AsyncMock(return_value=fake_llm)
        ),
    ):
        response = await service.infer_chat(request, envelope=envelope)

    fetch_models.assert_awaited_once()
    assert response.provider_id == "openai"
    assert response.model_id == "gpt-4.1"


@pytest.mark.asyncio
async def test_infer_chat_rejects_unadvertised_provider_or_model_before_invocation(tmp_path):
    model_file = tmp_path / "private-model.gguf"
    model_file.write_bytes(b"gguf")
    config_api = AsyncMock()
    config_api.aget_config = AsyncMock(return_value=_services_config(model_file))
    service = OrchestratorService()
    inference_llm = AsyncMock(return_value=_FakeInferenceLLM())

    with (
        patch("app.services.orchestrator.service.ConfigAPI", return_value=config_api),
        patch.object(service, "_inference_llm", new=inference_llm),
    ):
        with pytest.raises(ValueError, match="provider_id 'evil' is not advertised"):
            await service.infer_chat(
                OrchestratorInferChatRequest(
                    messages=[OrchestratorChatMessage(role="user", content="hello")],
                    provider_id="evil",
                )
            )

        with pytest.raises(ValueError, match="model_id 'evil-model' is not advertised"):
            await service.infer_chat(
                OrchestratorInferChatRequest(
                    messages=[OrchestratorChatMessage(role="user", content="hello")],
                    provider_id="llama_cpp",
                    model_id="evil-model",
                )
            )

    inference_llm.assert_not_awaited()


@pytest.mark.asyncio
async def test_stream_infer_chat_uses_validated_configured_labels(tmp_path):
    model_file = tmp_path / "private-model.gguf"
    model_file.write_bytes(b"gguf")
    config_api = AsyncMock()
    config_api.aget_config = AsyncMock(return_value=_services_config(model_file))
    service = OrchestratorService()
    fake_llm = _FakeInferenceLLM()

    with (
        patch("app.services.orchestrator.service.ConfigAPI", return_value=config_api),
        patch.object(service, "_inference_llm", new=AsyncMock(return_value=fake_llm)),
    ):
        stream = await service.stream_infer_chat(
            OrchestratorInferChatRequest(
                messages=[OrchestratorChatMessage(role="user", content="hello")],
                stream=True,
            )
        )
        chunks = [chunk async for chunk in stream]

    assert [chunk.model_id for chunk in chunks] == ["private-model.gguf", "private-model.gguf"]
    assert [chunk.provider_id for chunk in chunks] == ["llama_cpp", "llama_cpp"]
    assert chunks[-1].is_final is True
