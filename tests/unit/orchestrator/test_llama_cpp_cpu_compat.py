"""Regression coverage for CPU-only llama.cpp initialization."""

from __future__ import annotations

import asyncio
import importlib
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.orchestrator import llama_cpp_compat
from app.services.orchestrator.agents import chatbot
from app.shared.config.models import Orchestrator as OrchestratorConfig


def test_function_call_handler_imports_with_standard_llama_cpp_only(monkeypatch):
    """The optional CUDA distribution must not be required by CPU installs."""

    real_import = __import__

    def import_without_cuda(name, *args, **kwargs):
        if name == "llama_cpp_cuda" or name.startswith("llama_cpp_cuda."):
            raise ModuleNotFoundError("llama_cpp_cuda is intentionally unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", import_without_cuda)
    sys.modules.pop("app.services.orchestrator.chat_llama_cpp_fn_handler", None)

    handler = importlib.import_module("app.services.orchestrator.chat_llama_cpp_fn_handler")

    assert handler.llama.__name__.startswith("llama_cpp")


def test_function_call_handler_log_shape_does_not_expose_content():
    handler = importlib.import_module("app.services.orchestrator.chat_llama_cpp_fn_handler")
    sensitive_text = "private llama prompt"

    shape = handler._text_log_shape(sensitive_text)

    assert sensitive_text not in shape
    assert f"bytes={len(sensitive_text.encode('utf-8'))}" in shape


def test_llama_cpp_verbose_output_is_disabled_by_default():
    """Local inference must not emit backend prompt details unless opted in."""

    llama_module = importlib.import_module("app.services.orchestrator.chat_llama_cpp")

    assert llama_module.ChatLlamaCpp.model_fields["verbose"].default is False


def test_llama_cpp_backend_falls_back_only_when_standard_package_is_absent(monkeypatch):
    cuda_backend = SimpleNamespace(__name__="llama_cpp_cuda")
    imports = []

    def import_backend(name):
        imports.append(name)
        if name == "llama_cpp":
            raise ModuleNotFoundError("standard backend absent", name="llama_cpp")
        return cuda_backend

    monkeypatch.setattr(llama_cpp_compat.importlib, "import_module", import_backend)

    assert llama_cpp_compat.load_llama_cpp_backend() is cuda_backend
    assert imports == ["llama_cpp", "llama_cpp_cuda"]


def test_llama_cpp_backend_does_not_mask_transitive_import_failure(monkeypatch):
    imports = []

    def import_backend(name):
        imports.append(name)
        raise ModuleNotFoundError("broken standard dependency", name="diskcache")

    monkeypatch.setattr(llama_cpp_compat.importlib, "import_module", import_backend)

    with pytest.raises(ModuleNotFoundError, match="broken standard dependency"):
        llama_cpp_compat.load_llama_cpp_backend()
    assert imports == ["llama_cpp"]


def test_function_handler_does_not_mask_chat_format_import_failure(monkeypatch):
    real_import_module = importlib.import_module
    module_name = "app.services.orchestrator.chat_llama_cpp_fn_handler"
    existing_handler = sys.modules.get(module_name)

    def import_with_broken_chat_format(name, *args, **kwargs):
        if name == "llama_cpp.llama_chat_format":
            raise ModuleNotFoundError("broken chat format dependency", name="jinja2")
        if name == "llama_cpp_cuda" or name.startswith("llama_cpp_cuda."):
            pytest.fail("CUDA backend must not mask a broken standard backend")
        return real_import_module(name, *args, **kwargs)

    monkeypatch.setattr(importlib, "import_module", import_with_broken_chat_format)
    sys.modules.pop(module_name, None)

    try:
        with pytest.raises(ModuleNotFoundError, match="broken chat format dependency"):
            importlib.import_module(module_name)
    finally:
        if existing_handler is not None:
            sys.modules[module_name] = existing_handler


@pytest.mark.asyncio
async def test_llama_cpp_initialization_retries_after_transient_import_failure(monkeypatch):
    """A failed first import must not poison LLM initialization for the process."""

    raw_services = {
        "orchestrator": {
            "llm": {
                "provider": "llama_cpp",
                "local": {
                    "llama_cpp": {
                        "options": {
                            "model_path": "model.gguf",
                            "n_gpu_layers": 0,
                        }
                    }
                },
            }
        }
    }
    typed_config = OrchestratorConfig.model_validate(raw_services["orchestrator"])
    monkeypatch.setattr(
        chatbot.config_api,
        "aget_config",
        AsyncMock(return_value=raw_services),
    )
    monkeypatch.setattr(
        chatbot.config_api,
        "aget",
        AsyncMock(return_value=typed_config),
    )
    monkeypatch.setattr(chatbot, "llm", None)
    monkeypatch.setattr(chatbot, "_llm_initialized", False)
    monkeypatch.setenv("AURORA_LLAMA_CPP_MODEL_PATH", "model.gguf")

    import app.services.orchestrator.chat_llama_cpp as llama_module

    initialized_llm = object()
    monkeypatch.setattr(llama_module, "ChatLlamaCpp", lambda **_kwargs: initialized_llm)

    real_import = __import__
    failed_once = False

    def transient_llama_import_failure(name, *args, **kwargs):
        nonlocal failed_once
        if name == "app.services.orchestrator.chat_llama_cpp" and not failed_once:
            failed_once = True
            raise ImportError("transient llama.cpp import failure")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", transient_llama_import_failure)

    await chatbot._initialize_llm()

    assert chatbot.llm is None
    assert chatbot._llm_initialized is False

    await chatbot._initialize_llm()

    assert chatbot.llm is initialized_llm
    assert chatbot._llm_initialized is True


@pytest.mark.asyncio
async def test_llama_cpp_initialization_serializes_concurrent_requests(monkeypatch):
    initialized_llm = object()
    initialize_calls = 0

    async def initialize_once():
        nonlocal initialize_calls
        initialize_calls += 1
        await asyncio.sleep(0)
        chatbot.llm = initialized_llm
        chatbot._llm_initialized = True

    monkeypatch.setattr(chatbot, "llm", None)
    monkeypatch.setattr(chatbot, "_llm_initialized", False)
    monkeypatch.setattr(chatbot, "_llm_init_lock", asyncio.Lock())
    monkeypatch.setattr(chatbot, "_initialize_llm_unlocked", initialize_once)

    await asyncio.gather(chatbot._initialize_llm(), chatbot._initialize_llm())

    assert initialize_calls == 1
    assert chatbot.llm is initialized_llm
    assert chatbot._llm_initialized is True
