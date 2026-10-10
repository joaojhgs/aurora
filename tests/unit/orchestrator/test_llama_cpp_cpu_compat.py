"""Regression coverage for CPU-only llama.cpp initialization."""

from __future__ import annotations

import asyncio
import importlib
import sys
import threading
from contextlib import suppress
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk

from app.services.orchestrator import llama_cpp_compat
from app.services.orchestrator.agents import chatbot
from app.services.orchestrator.service import OrchestratorService
from app.shared.config.models import Orchestrator as OrchestratorConfig


def test_provider_owner_does_not_probe_dynamic_bound_attribute():
    """Provider discovery must not materialize arbitrary proxy attributes."""

    from app.services.orchestrator.native_worker import provider_owner

    class DynamicProxy:
        def __getattr__(self, name):
            if name == "bound":
                raise AssertionError("dynamic .bound lookup must not be attempted")
            raise AttributeError(name)

    provider = DynamicProxy()

    assert provider_owner(provider) is provider


def test_provider_owner_unwraps_langchain_runnable_binding():
    """A real LangChain binding still resolves to its underlying runnable."""

    from langchain_core.runnables import RunnableLambda

    from app.services.orchestrator.native_worker import provider_owner

    provider = RunnableLambda(lambda value: value)
    bound = provider.bind()

    assert provider_owner(bound) is provider


def test_provider_owner_handles_plain_nested_and_cyclic_wrappers():
    """Static wrapper chains unwrap safely while cycles retain the input owner."""

    from app.services.orchestrator.native_worker import provider_owner

    class Wrapper:
        def __init__(self, bound):
            self.bound = bound

    provider = object()
    assert provider_owner(provider) is provider
    assert provider_owner(Wrapper(Wrapper(provider))) is provider

    first = Wrapper(None)
    second = Wrapper(first)
    first.bound = second

    assert provider_owner(first) is first


@pytest.fixture
def standard_llama_cpp_backend(monkeypatch):
    """Install a minimal standard backend without requiring the optional wheel."""

    backend = ModuleType("llama_cpp")
    backend.llama = ModuleType("llama_cpp.llama")
    backend.llama_grammar = ModuleType("llama_cpp.llama_grammar")
    backend.llama_types = ModuleType("llama_cpp.llama_types")
    chat_format = ModuleType("llama_cpp.llama_chat_format")

    def passthrough(*args, **kwargs):
        return args, kwargs

    def register_chat_completion_handler(_name):
        return lambda handler: handler

    chat_format._convert_completion_to_chat = passthrough
    chat_format._convert_completion_to_chat_function = passthrough
    chat_format._convert_text_completion_logprobs_to_chat = passthrough
    chat_format._grammar_for_response_format = passthrough
    chat_format.register_chat_completion_handler = register_chat_completion_handler
    modules = {
        "llama_cpp": backend,
        "llama_cpp.llama": backend.llama,
        "llama_cpp.llama_grammar": backend.llama_grammar,
        "llama_cpp.llama_types": backend.llama_types,
        "llama_cpp.llama_chat_format": chat_format,
    }
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)

    handler_name = "app.services.orchestrator.chat_llama_cpp_fn_handler"
    existing_handler = sys.modules.pop(handler_name, None)
    try:
        yield backend
    finally:
        sys.modules.pop(handler_name, None)
        if existing_handler is not None:
            sys.modules[handler_name] = existing_handler


def test_function_call_handler_imports_with_standard_llama_cpp_only(
    monkeypatch,
    standard_llama_cpp_backend,
):
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


def test_function_call_handler_log_shape_does_not_expose_content(
    standard_llama_cpp_backend,
):
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


def test_function_handler_does_not_mask_chat_format_import_failure(
    monkeypatch,
    standard_llama_cpp_backend,
):
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
async def test_llama_cpp_initialization_retries_after_transient_import_failure(
    monkeypatch,
    standard_llama_cpp_backend,
):
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


@pytest.mark.asyncio
async def test_llama_cpp_real_initialization_is_off_loop_cancel_safe_and_reload_safe(
    monkeypatch,
    standard_llama_cpp_backend,
):
    """The production initialization path shares construction and rejects stale reloads."""

    raw_services = {
        "orchestrator": {
            "llm": {
                "provider": "llama_cpp",
                "local": {"llama_cpp": {"options": {"model_path": "model.gguf"}}},
            }
        }
    }
    typed_config = OrchestratorConfig.model_validate(raw_services["orchestrator"])
    monkeypatch.setattr(chatbot.config_api, "aget_config", AsyncMock(return_value=raw_services))
    monkeypatch.setattr(chatbot.config_api, "aget", AsyncMock(return_value=typed_config))
    monkeypatch.setenv("AURORA_LLAMA_CPP_MODEL_PATH", "model.gguf")
    monkeypatch.setattr(chatbot, "llm", None)
    monkeypatch.setattr(chatbot, "_llm_initialized", False)
    monkeypatch.setattr(chatbot, "_llm_initialization_task", None)
    monkeypatch.setattr(chatbot, "_llm_generation", 0)

    import app.services.orchestrator.chat_llama_cpp as llama_module

    started = [threading.Event(), threading.Event()]
    release = [threading.Event(), threading.Event()]
    models = []

    class FakeModel:
        def __init__(self, index):
            self.index = index
            self.closed = False

        def close(self):
            self.closed = True

    def blocking_constructor(**_kwargs):
        index = len(models)
        started[index].set()
        assert release[index].wait(timeout=2)
        model = FakeModel(index)
        models.append(model)
        return model

    monkeypatch.setattr(llama_module, "ChatLlamaCpp", blocking_constructor)

    first = asyncio.create_task(chatbot._initialize_llm())
    await asyncio.to_thread(started[0].wait, 2)

    loop_responsive = asyncio.Event()

    async def probe_loop():
        loop_responsive.set()

    probe = asyncio.create_task(probe_loop())
    await asyncio.wait_for(loop_responsive.wait(), timeout=1)
    await probe

    cancelled_waiter = asyncio.create_task(chatbot._initialize_llm())
    await asyncio.sleep(0)
    cancelled_waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_waiter

    reload = asyncio.create_task(chatbot.invalidate_llm())
    while chatbot._llm_generation == 0:
        await asyncio.sleep(0)
    release[0].set()
    await reload
    await first

    assert len(models) == 1
    assert models[0].closed is True
    assert chatbot.llm is None
    assert chatbot._llm_initialized is False

    second = asyncio.create_task(chatbot._initialize_llm())
    await asyncio.to_thread(started[1].wait, 2)
    release[1].set()
    await second

    assert len(models) == 2
    assert models[1].closed is False
    assert chatbot.llm is models[1]
    assert chatbot._llm_initialized is True


@pytest.mark.asyncio
async def test_orchestrator_stop_drains_generation_before_disposing_detached_llm(monkeypatch):
    """Stop fences new use, drains tracked work, then closes the detached provider."""

    class FakeBus:
        def unsubscribe(self, *_args):
            return None

    class FakeModel:
        closed = False

        def close(self):
            self.closed = True

    service = OrchestratorService.__new__(OrchestratorService)
    service._bus = FakeBus()
    service._generation_lock = asyncio.Lock()
    service._generation_tasks = {}
    service._stopping = False
    service._on_transcription = object()

    model = FakeModel()
    monkeypatch.setattr(chatbot, "llm", model)
    monkeypatch.setattr(chatbot, "_llm_initialized", True)
    monkeypatch.setattr(chatbot, "_llm_initialization_task", None)
    monkeypatch.setattr(chatbot, "_llm_generation", 0)

    started = asyncio.Event()
    release = asyncio.Event()

    async def active_generation():
        started.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            await release.wait()

    generation = asyncio.create_task(active_generation())
    service._generation_tasks[generation] = None
    stop = asyncio.create_task(service.on_stop())
    await started.wait()
    await asyncio.sleep(0)

    assert model.closed is False
    assert stop.done() is False
    release.set()
    await stop

    assert generation.done()
    assert model.closed is True
    assert chatbot.llm is None
    assert chatbot._llm_initialized is False


@pytest.mark.asyncio
async def test_finite_inference_is_tracked_until_provider_resolution(monkeypatch):
    """Stop cancels a finite request paused before its provider is resolved."""

    class FakeBus:
        def unsubscribe(self, *_args):
            return None

    service = OrchestratorService.__new__(OrchestratorService)
    service._bus = FakeBus()
    service._generation_lock = asyncio.Lock()
    service._generation_tasks = {}
    service._stopping = False
    service._on_transcription = object()

    started = asyncio.Event()

    async def blocked_provider_resolution(_data):
        started.set()
        await asyncio.Event().wait()

    data = SimpleNamespace(
        provider_id=None,
        model_id=None,
        messages=[],
        tools=[],
        tool_choice=None,
        params={},
        correlation_id="corr-finite",
        session_id="session-finite",
        request_id="request-finite",
        metadata={},
    )
    monkeypatch.setattr(
        service, "_authorize_direct_inference_request", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(service, "_can_expand_cloud_catalog", lambda *args, **kwargs: False)
    monkeypatch.setattr(
        service,
        "_validated_inference_request",
        AsyncMock(side_effect=lambda request, **kwargs: request),
    )
    monkeypatch.setattr(service, "_invoke_inference_llm", blocked_provider_resolution)

    request = asyncio.create_task(service.infer_chat(data))
    started_wait = asyncio.create_task(started.wait())
    done, _pending = await asyncio.wait(
        {started_wait, request},
        timeout=5.0,
        return_when=asyncio.FIRST_COMPLETED,
    )
    if request in done and started_wait not in done:
        started_wait.cancel()
        await asyncio.gather(started_wait, return_exceptions=True)
        await request
        pytest.fail("finite inference returned before provider resolution")
    if started_wait not in done:
        started_wait.cancel()
        request.cancel()
        await asyncio.gather(started_wait, request, return_exceptions=True)
        pytest.fail("finite inference did not reach provider resolution before timeout")
    assert request in service._generation_tasks

    stop = asyncio.create_task(service.on_stop())
    await stop
    with pytest.raises(asyncio.CancelledError):
        await request
    assert service._generation_tasks == {}


@pytest.mark.asyncio
async def test_cancelled_native_worker_drains_before_provider_close():
    """A cancelled request keeps its native worker alive until completion."""

    class FakeModel:
        closed = False

        def close(self):
            self.closed = True

    model = FakeModel()
    started = threading.Event()
    release = threading.Event()

    def blocking_inference():
        started.set()
        release.wait(timeout=2)
        return "done"

    request = asyncio.create_task(chatbot._run_native_llm(model, blocking_inference))
    await asyncio.to_thread(started.wait, 2)
    request.cancel()
    await asyncio.sleep(0)
    disposal = asyncio.create_task(chatbot.dispose_llm(model))
    await asyncio.sleep(0)
    request.cancel()

    assert model.closed is False
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await request
    await disposal
    assert model.closed is True


@pytest.mark.asyncio
async def test_chat_llama_cpp_stream_next_drains_before_provider_close(
    monkeypatch,
    standard_llama_cpp_backend,
):
    """The owned async adapter drains a blocked native iterator advancement."""

    import app.services.orchestrator.chat_llama_cpp as llama_module

    started = threading.Event()
    release = threading.Event()

    class FakeClient:
        closed = False

        def close(self):
            self.closed = True

    client = FakeClient()
    model = llama_module.ChatLlamaCpp.model_construct(
        model_path="model.gguf",
        client=client,
    )

    def blocked_stream(_self, *_args, **_kwargs):
        yield ChatGenerationChunk(message=AIMessageChunk(content="first"))
        started.set()
        release.wait(timeout=2)
        yield ChatGenerationChunk(message=AIMessageChunk(content="second"))

    monkeypatch.setattr(llama_module.ChatLlamaCpp, "_stream", blocked_stream)
    stream = model.astream([])
    consumer = asyncio.create_task(stream.__anext__())
    first = await consumer
    assert isinstance(first, AIMessageChunk)
    await asyncio.to_thread(started.wait, 2)

    disposal = asyncio.create_task(chatbot.dispose_llm(model))
    await asyncio.sleep(0)
    assert client.closed is False

    release.set()
    await disposal
    await stream.aclose()
    assert client.closed is True


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_stage", ["factory", "first_next", "after_first"])
async def test_native_stream_preserves_provider_error(failure_stage):
    """Native construction and iteration errors retain their original meaning."""

    import app.services.orchestrator.native_worker as native_worker

    provider = object()
    failure = RuntimeError("native stream failed")

    def failing_iterator():
        if failure_stage == "after_first":
            yield "first"
        raise failure

    def iterator_factory():
        if failure_stage == "factory":
            raise failure
        return failing_iterator()

    stream = native_worker.stream_native(provider, iterator_factory)
    if failure_stage == "after_first":
        assert await stream.__anext__() == "first"

    with pytest.raises(RuntimeError) as raised:
        await stream.__anext__()

    assert raised.value is failure
    assert not native_worker._stream_tasks
    assert not native_worker._worker_tasks


@pytest.mark.asyncio
async def test_stream_eof_cancel_discards_queued_item_before_terminal_marker(monkeypatch):
    """A canceled producer blocked publishing EOF cannot leak its last queued item."""

    import app.services.orchestrator.native_worker as native_worker

    provider = object()
    second = object()
    second_queued = asyncio.Event()
    terminal_attempted = asyncio.Event()
    terminal_release = asyncio.Event()
    queue_type = asyncio.Queue

    class BarrierQueue(queue_type):
        async def put(self, item):
            if item == ("item", second):
                await super().put(item)
                second_queued.set()
                return
            if item == ("done", None):
                terminal_attempted.set()
                await terminal_release.wait()
            await super().put(item)

    monkeypatch.setattr(native_worker.asyncio, "Queue", BarrierQueue)

    def finite_iterator():
        yield "first"
        yield second

    stream = native_worker.stream_native(provider, finite_iterator)
    assert await stream.__anext__() == "first"
    await second_queued.wait()
    await terminal_attempted.wait()

    await native_worker.drain_native(provider)
    with pytest.raises(asyncio.CancelledError):
        await stream.__anext__()
    assert not native_worker._stream_tasks
    assert not native_worker._worker_tasks


@pytest.mark.asyncio
async def test_chat_llama_cpp_owned_astream_preserves_chunks_and_callbacks(
    monkeypatch,
    standard_llama_cpp_backend,
):
    """The owned adapter preserves ordering and the synchronous callback bridge."""

    import app.services.orchestrator.chat_llama_cpp as llama_module

    model = llama_module.ChatLlamaCpp.model_construct(model_path="model.gguf")
    callbacks = []

    class SyncManager:
        def on_llm_new_token(self, token, **_kwargs):
            callbacks.append(token)

    class AsyncManager:
        def get_sync(self):
            return SyncManager()

    expected = [
        ChatGenerationChunk(message=AIMessageChunk(content="first")),
        ChatGenerationChunk(message=AIMessageChunk(content="second")),
    ]

    def normal_stream(_self, *_args, run_manager=None, **_kwargs):
        if run_manager is not None:
            run_manager.on_llm_new_token("first")
        yield from expected

    monkeypatch.setattr(llama_module.ChatLlamaCpp, "_stream", normal_stream)
    public_received = []
    async for chunk in model.bind_tools([]).astream([]):
        public_received.append(chunk)

    assert [chunk.content for chunk in public_received] == ["first", "second"]

    received = []
    async for chunk in model._astream([], run_manager=AsyncManager()):
        received.append(chunk)

    assert received == expected
    assert callbacks == ["first"]


@pytest.mark.asyncio
async def test_service_stream_pause_is_tracked_before_stop_disposes_provider(monkeypatch):
    """A public stream paused after its first chunk is drained before provider close."""

    import app.services.orchestrator.chat_llama_cpp as llama_module
    import app.services.orchestrator.native_worker as native_worker

    class FakeBus:
        def unsubscribe(self, *_args):
            return None

    class FakeClient:
        closed = False

        def close(self):
            self.closed = True

    release = threading.Event()
    client = FakeClient()
    model = llama_module.ChatLlamaCpp.model_construct(model_path="model.gguf", client=client)

    def blocked_stream(_self, *_args, **_kwargs):
        yield ChatGenerationChunk(message=AIMessageChunk(content="first"))
        release.wait(timeout=2)
        yield ChatGenerationChunk(message=AIMessageChunk(content="second"))

    monkeypatch.setattr(llama_module.ChatLlamaCpp, "_stream", blocked_stream)

    service = OrchestratorService.__new__(OrchestratorService)
    service._bus = FakeBus()
    service._generation_lock = asyncio.Lock()
    service._generation_tasks = {}
    service._stopping = False
    service._on_transcription = object()

    monkeypatch.setattr(chatbot, "llm", model)
    monkeypatch.setattr(chatbot, "_llm_initialized", True)
    monkeypatch.setattr(chatbot, "_llm_initialization_task", None)
    monkeypatch.setattr(chatbot, "_llm_generation", 0)
    monkeypatch.setattr(
        service, "_authorize_direct_inference_request", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(service, "_can_expand_cloud_catalog", lambda *args, **kwargs: False)
    monkeypatch.setattr(
        service, "_validated_inference_request", AsyncMock(side_effect=lambda data, **kwargs: data)
    )
    monkeypatch.setattr(service, "_bound_inference_llm", AsyncMock(return_value=model))

    data = SimpleNamespace(
        provider_id=None,
        model_id=None,
        messages=[],
        tools=[],
        tool_choice=None,
        params={},
        correlation_id="corr-1",
        session_id="session-1",
        request_id="request-1",
        metadata={},
    )
    stream = await service.stream_infer_chat(data)
    first_ready = asyncio.get_running_loop().create_future()

    async def consume_stream():
        async for chunk in stream:
            if not first_ready.done():
                first_ready.set_result(chunk)
            await asyncio.Event().wait()

    consumer = asyncio.create_task(consume_stream())
    first = await first_ready
    assert first.is_final is False

    stop = asyncio.create_task(service.on_stop())
    await asyncio.sleep(0)
    assert client.closed is False
    release.set()
    await stop
    with pytest.raises(asyncio.CancelledError):
        await consumer
    with pytest.raises((asyncio.CancelledError, StopAsyncIteration)):
        await stream.__anext__()
    assert client.closed is True
    assert service._generation_tasks == {}
    assert not native_worker._stream_tasks
    assert not native_worker._worker_tasks


@pytest.mark.asyncio
async def test_llama_cpp_construction_does_not_block_loop_or_duplicate(monkeypatch):
    """Concurrent first use shares one off-loop blocking model construction."""

    started = threading.Event()
    release = threading.Event()
    constructor_calls = 0

    def blocking_constructor():
        nonlocal constructor_calls
        constructor_calls += 1
        started.set()
        assert release.wait(timeout=2)
        return object()

    async def initialize_once():
        model = await chatbot._construct_llama_model(blocking_constructor, {})
        chatbot.llm = model
        chatbot._llm_initialized = True

    monkeypatch.setattr(chatbot, "llm", None)
    monkeypatch.setattr(chatbot, "_llm_initialized", False)
    monkeypatch.setattr(chatbot, "_llm_init_lock", asyncio.Lock())
    monkeypatch.setattr(chatbot, "_llm_initialization_task", None)
    monkeypatch.setattr(chatbot, "_initialize_llm_unlocked", initialize_once)

    first = asyncio.create_task(chatbot._initialize_llm())
    second = asyncio.create_task(chatbot._initialize_llm())
    await asyncio.to_thread(started.wait, 2)

    loop_responsive = asyncio.Event()

    async def prove_loop_progress():
        await asyncio.sleep(0)
        loop_responsive.set()

    await prove_loop_progress()
    assert loop_responsive.is_set()
    release.set()
    await asyncio.gather(first, second)

    assert constructor_calls == 1
    assert chatbot.llm is not None
    assert chatbot._llm_initialized is True


@pytest.mark.asyncio
async def test_retirement_waits_for_repeatedly_cancelled_native_call():
    """Repeated observer cancellation cannot close a provider before body return."""

    from app.services.orchestrator.native_worker import RetirementStatus, retire_native, run_native

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    provider = Provider()
    started = threading.Event()
    release = threading.Event()

    def blocking_call():
        started.set()
        assert release.wait(timeout=5)
        return "finished"

    request = asyncio.create_task(run_native(provider, blocking_call))
    assert await asyncio.wait_for(asyncio.to_thread(started.wait, 2), timeout=3)
    request.cancel()
    await asyncio.sleep(0)
    request.cancel()
    retirement = asyncio.create_task(retire_native(provider))
    await asyncio.sleep(0)
    assert provider.close_calls == 0
    assert not retirement.done()

    release.set()
    with pytest.raises(asyncio.CancelledError):
        await request
    result = await asyncio.wait_for(retirement, timeout=3)
    assert result.status is RetirementStatus.COMPLETE
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_retirement_rejects_new_work_but_keeps_distinct_provider_usable():
    """The admission barrier is exact-provider scoped and waits for old work."""

    from app.services.orchestrator.native_worker import (
        ProviderUnavailableError,
        RetirementStatus,
        retire_native,
        run_native,
    )

    class Provider:
        def __init__(self):
            self.close_calls = 0
            self.calls = 0

        def close(self):
            self.close_calls += 1

    first = Provider()
    other = Provider()
    started = threading.Event()
    release = threading.Event()

    def blocked():
        first.calls += 1
        started.set()
        assert release.wait(timeout=5)
        return "first"

    active = asyncio.create_task(run_native(first, blocked))
    assert await asyncio.wait_for(asyncio.to_thread(started.wait, 2), timeout=3)
    retirement = asyncio.create_task(retire_native(first))
    await asyncio.sleep(0)
    with pytest.raises(ProviderUnavailableError):
        await run_native(first, lambda: setattr(first, "calls", first.calls + 1))
    assert await run_native(other, lambda: "other") == "other"
    assert other.close_calls == 0
    assert first.close_calls == 0

    release.set()
    assert await active == "first"
    result = await asyncio.wait_for(retirement, timeout=3)
    assert result.status is RetirementStatus.COMPLETE
    assert first.calls == 1
    assert first.close_calls == 1


@pytest.mark.asyncio
async def test_dropped_retirement_observer_rejoins_one_close_operation():
    """A dropped waiter and a later waiter share the retained provider close."""

    from app.services.orchestrator.native_worker import RetirementStatus, retire_native

    class Provider:
        def __init__(self):
            self.close_calls = 0
            self.started = threading.Event()
            self.release = threading.Event()

        def close(self):
            self.close_calls += 1
            self.started.set()
            assert self.release.wait(timeout=5)

    provider = Provider()
    first = asyncio.create_task(retire_native(provider))
    assert await asyncio.wait_for(asyncio.to_thread(provider.started.wait, 2), timeout=3)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    second = asyncio.create_task(retire_native(provider))
    await asyncio.sleep(0)
    assert not second.done()
    assert provider.close_calls == 1
    second.cancel()
    await asyncio.sleep(0)
    second.cancel()
    await asyncio.sleep(0)
    provider.release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(second, timeout=3)
    result = await asyncio.wait_for(retire_native(provider), timeout=3)
    assert result.status is RetirementStatus.COMPLETE
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_retirement_deadline_remains_sticky_after_actual_close():
    """A timed-out observer cannot turn eventual close into a clean result."""

    from app.services.orchestrator.native_worker import RetirementStatus, retire_native

    class Provider:
        def __init__(self):
            self.close_calls = 0
            self.started = threading.Event()
            self.release = threading.Event()

        def close(self):
            self.close_calls += 1
            self.started.set()
            assert self.release.wait(timeout=5)

    provider = Provider()
    timed = await retire_native(provider, timeout=0.01)
    assert timed.status is RetirementStatus.DEADLINE_EXCEEDED
    assert await asyncio.wait_for(asyncio.to_thread(provider.started.wait, 2), timeout=3)
    provider.release.set()
    # Waiting for a second call also waits on the same retained retirement task.
    final = await asyncio.wait_for(retire_native(provider), timeout=3)
    assert final.status is RetirementStatus.DEADLINE_EXCEEDED
    assert provider.close_calls == 1
    assert await retire_native(provider, timeout=0) == final
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_stream_retirement_waits_for_blocked_next_before_iterator_close():
    """The exact iterator is not closed until its active advancement returns."""

    from app.services.orchestrator.native_worker import (
        RetirementStatus,
        retire_native,
        stream_native,
    )

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class BlockingIterator:
        def __init__(self):
            self.calls = 0
            self.started = threading.Event()
            self.release = threading.Event()
            self.closed = threading.Event()
            self.overlap = False

        def __iter__(self):
            return self

        def __next__(self):
            self.calls += 1
            if self.calls == 1:
                return "first"
            self.started.set()
            assert self.release.wait(timeout=5)
            return "second"

        def close(self):
            if self.started.is_set() and not self.release.is_set():
                self.overlap = True
            self.closed.set()

    provider = Provider()
    iterator = BlockingIterator()
    stream = stream_native(provider, lambda: iterator)
    assert await stream.__anext__() == "first"
    consumer = asyncio.create_task(stream.__anext__())
    assert await asyncio.wait_for(asyncio.to_thread(iterator.started.wait, 2), timeout=3)
    retirement = asyncio.create_task(retire_native(provider))
    await asyncio.sleep(0)
    assert not iterator.closed.is_set()
    assert provider.close_calls == 0

    iterator.release.set()
    with pytest.raises((asyncio.CancelledError, StopAsyncIteration)):
        await asyncio.wait_for(consumer, timeout=3)
    result = await asyncio.wait_for(retirement, timeout=3)
    assert result.status is RetirementStatus.COMPLETE
    assert iterator.closed.is_set()
    assert iterator.overlap is False
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_stream_retirement_waits_for_blocked_iterator_close_before_provider_close():
    """Provider close follows the actual return of the iterator close call."""

    from app.services.orchestrator.native_worker import (
        RetirementStatus,
        retire_native,
        stream_native,
    )

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class BlockingCloseIterator:
        def __init__(self):
            self.sent = False
            self.next_started = threading.Event()
            self.release_next = threading.Event()
            self.close_started = threading.Event()
            self.release_close = threading.Event()
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                self.next_started.set()
                assert self.release_next.wait(timeout=5)
                raise StopIteration
            self.sent = True
            return "chunk"

        def close(self):
            self.close_calls += 1
            self.close_started.set()
            assert self.release_close.wait(timeout=5)

    provider = Provider()
    iterator = BlockingCloseIterator()
    stream = stream_native(provider, lambda: iterator)
    assert await stream.__anext__() == "chunk"
    consumer = asyncio.create_task(stream.__anext__())
    assert await asyncio.wait_for(asyncio.to_thread(iterator.next_started.wait, 2), timeout=3)
    consumer.cancel()
    iterator.release_next.set()
    assert await asyncio.wait_for(asyncio.to_thread(iterator.close_started.wait, 2), timeout=3)

    retirement = asyncio.create_task(retire_native(provider))
    await asyncio.sleep(0)
    assert not retirement.done()
    assert iterator.close_calls == 1
    assert provider.close_calls == 0

    iterator.release_close.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(consumer, timeout=3)
    result = await asyncio.wait_for(retirement, timeout=3)
    assert result.status is RetirementStatus.COMPLETE
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_retirement_does_not_cancel_iterator_close_after_natural_eof():
    """Retirement waits for an already-running close instead of cancelling it."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class BlockingCloseIterator:
        def __init__(self):
            self.sent = False
            self.close_started = threading.Event()
            self.release_close = threading.Event()
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return "chunk"

        def close(self):
            self.close_calls += 1
            self.close_started.set()
            assert self.release_close.wait(timeout=5)

    provider = Provider()
    iterator = BlockingCloseIterator()
    stream = native_worker.stream_native(provider, lambda: iterator)
    assert await stream.__anext__() == "chunk"
    consumer = asyncio.create_task(stream.__anext__())
    assert await asyncio.wait_for(asyncio.to_thread(iterator.close_started.wait, 2), timeout=3)

    lifecycle = native_worker._lifecycles[id(provider)]
    lease = next(iter(lifecycle.streams.values()))
    assert lease.close_started is True
    assert lease.stop_requested is False

    retirement = asyncio.create_task(native_worker.retire_native(provider))
    await asyncio.sleep(0)
    assert not retirement.done()
    assert lease.stop_requested is False
    assert provider.close_calls == 0

    iterator.release_close.set()
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(consumer, timeout=3)
    result = await asyncio.wait_for(retirement, timeout=3)
    assert result.status is native_worker.RetirementStatus.COMPLETE
    assert iterator.close_calls == 1
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_internal_executor_cancellation_retains_untransferred_factory_iterator():
    """A cancelled executor waiter cannot erase an actual factory result."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class ReturnedIterator:
        def __iter__(self):
            return self

        def __next__(self):
            raise StopIteration

        def close(self):
            raise AssertionError("untransferred iterator must not be closed")

    provider = Provider()
    iterator = ReturnedIterator()
    started = threading.Event()
    release = threading.Event()

    def factory():
        started.set()
        assert release.wait(timeout=5)
        return iterator

    stream = native_worker.stream_native(provider, factory)
    consumer = asyncio.create_task(stream.__anext__())
    assert await asyncio.wait_for(asyncio.to_thread(started.wait, 2), timeout=3)
    owner_id = id(native_worker.provider_owner(provider))
    tasks = tuple(native_worker._worker_tasks[owner_id])
    assert len(tasks) == 1
    tasks[0].cancel()
    await asyncio.sleep(0)
    with pytest.raises(native_worker.ProviderUnavailableError):
        await asyncio.wait_for(consumer, timeout=3)

    lifecycle = native_worker._lifecycles[owner_id]
    lifecycle.actual_changed.clear()
    release.set()
    assert await asyncio.wait_for(asyncio.to_thread(lifecycle.actual_changed.wait, 3), timeout=4)
    # Wait for the real synchronous wrapper to publish its outcome; the test
    # checks the record, not the cancelled asyncio task's state.
    with lifecycle.lock:
        retained = any(
            operation.outcome is not None and operation.outcome.value is iterator
            for operation in lifecycle.operations.values()
        )
    assert retained
    result = await native_worker.retire_native(provider)
    assert result.status is native_worker.RetirementStatus.UNKNOWN
    assert provider.close_calls == 0


@pytest.mark.asyncio
async def test_cancelled_stream_observer_transfers_then_closes_factory_iterator():
    """Caller cancellation waits for the actual factory result and its close."""

    from app.services.orchestrator.native_worker import (
        RetirementStatus,
        retire_native,
        stream_native,
    )

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class ReturnedIterator:
        def __init__(self):
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            return "first"

        def close(self):
            self.close_calls += 1

    provider = Provider()
    iterator = ReturnedIterator()
    started = threading.Event()
    release = threading.Event()

    def factory():
        started.set()
        assert release.wait(timeout=5)
        return iterator

    stream = stream_native(provider, factory)
    consumer = asyncio.create_task(stream.__anext__())
    assert await asyncio.wait_for(asyncio.to_thread(started.wait, 2), timeout=3)
    consumer.cancel()
    assert iterator.close_calls == 0
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(consumer, timeout=3)

    assert iterator.close_calls == 1
    result = await asyncio.wait_for(retire_native(provider), timeout=3)
    assert result.status is RetirementStatus.COMPLETE
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_native_stream_iterator_close_failure_survives_later_clean_work():
    """Producer cleanup failure stays attached to the same provider lifecycle."""

    from app.services.orchestrator.native_worker import (
        ProviderUnavailableError,
        RetirementStatus,
        retire_native,
        run_native,
        stream_native,
    )

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class FailingCloseIterator:
        def __init__(self):
            self.sent = False
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return "chunk"

        def close(self):
            self.close_calls += 1
            raise RuntimeError("iterator cleanup failed")

    provider = Provider()
    iterator = FailingCloseIterator()
    assert [item async for item in stream_native(provider, lambda: iterator)] == ["chunk"]
    assert iterator.close_calls == 1

    assert await run_native(provider, lambda: "later clean operation") == "later clean operation"
    retired = await retire_native(provider)
    assert retired.status is RetirementStatus.FAILED
    assert retired.failure == "iterator_close_failed"
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_original_loop_loss_retains_factory_result_without_close_success():
    """A closed owner loop cannot lose a blocked factory's eventual iterator."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class ReturnedIterator:
        def __iter__(self):
            return self

        def __next__(self):
            raise StopIteration

        def close(self):
            raise AssertionError("loop loss cannot authorize iterator close")

    provider = Provider()
    iterator = ReturnedIterator()
    started = threading.Event()
    release = threading.Event()
    loop_closed = threading.Event()
    worker_error: list[BaseException] = []
    lifecycle_box = []

    def factory():
        started.set()
        assert release.wait(timeout=5)
        return iterator

    def original_loop_worker():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def consume_factory():
            stream = native_worker.stream_native(provider, factory)
            consumer = asyncio.create_task(stream.__anext__())
            await asyncio.to_thread(started.wait, 2)
            key = id(native_worker.provider_owner(provider))
            lifecycle = native_worker._lifecycles[key]
            lifecycle_box.append(lifecycle)
            operation_tasks = tuple(native_worker._worker_tasks[key])
            assert len(operation_tasks) == 1
            operation_tasks[0].cancel()
            with pytest.raises(native_worker.ProviderUnavailableError):
                await asyncio.wait_for(consumer, timeout=3)

        try:
            loop.run_until_complete(consume_factory())
        except BaseException as error:
            worker_error.append(error)
        finally:
            loop.close()
            asyncio.set_event_loop(None)
            loop_closed.set()

    thread = threading.Thread(target=original_loop_worker)
    thread.start()
    assert await asyncio.wait_for(asyncio.to_thread(loop_closed.wait, 3), timeout=4)
    assert worker_error == []
    lifecycle = lifecycle_box[0]
    lifecycle.actual_changed.clear()
    release.set()
    assert await asyncio.wait_for(asyncio.to_thread(lifecycle.actual_changed.wait, 3), timeout=4)
    await asyncio.to_thread(thread.join, 3)
    assert not thread.is_alive()

    with lifecycle.lock:
        retained = [
            operation
            for operation in lifecycle.operations.values()
            if operation.outcome is not None and operation.outcome.value is iterator
        ]
        assert lifecycle.loop_lost is True
        assert lifecycle.admission_open is False
    assert len(retained) == 1
    assert retained[0].transfer_acknowledged is False
    assert retained[0].state is native_worker._OperationState.UNKNOWN
    assert provider.close_calls == 0
    later_observation = await native_worker.retire_native(provider)
    assert later_observation.status is native_worker.RetirementStatus.UNKNOWN
    assert later_observation.failure == "provider_lifecycle_unavailable"
    assert provider.close_calls == 0


@pytest.mark.asyncio
async def test_unknown_stream_next_retains_iterator_without_overlapping_close():
    """An unobserved next keeps the iterator owned and blocks provider close."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class BlockingIterator:
        def __init__(self):
            self.calls = 0
            self.started = threading.Event()
            self.release = threading.Event()
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            self.calls += 1
            if self.calls == 1:
                return "first"
            self.started.set()
            assert self.release.wait(timeout=5)
            return "second"

        def close(self):
            self.close_calls += 1

    provider = Provider()
    iterator = BlockingIterator()
    stream = native_worker.stream_native(provider, lambda: iterator)
    assert await stream.__anext__() == "first"
    consumer = asyncio.create_task(stream.__anext__())
    assert await asyncio.wait_for(asyncio.to_thread(iterator.started.wait, 2), timeout=3)

    owner_id = id(native_worker.provider_owner(provider))
    operation_tasks = tuple(native_worker._worker_tasks[owner_id])
    assert len(operation_tasks) == 1
    operation_tasks[0].cancel()
    with pytest.raises(native_worker.ProviderUnavailableError):
        await asyncio.wait_for(consumer, timeout=3)

    lifecycle = native_worker._lifecycles[owner_id]
    assert iterator.close_calls == 0
    assert provider.close_calls == 0
    later_observation = await native_worker.retire_native(provider)
    assert later_observation.status is native_worker.RetirementStatus.UNKNOWN
    assert later_observation.failure == lifecycle.failure
    assert iterator.close_calls == 0
    assert provider.close_calls == 0
    lifecycle.actual_changed.clear()
    iterator.release.set()
    assert await asyncio.wait_for(asyncio.to_thread(lifecycle.actual_changed.wait, 3), timeout=4)
    assert iterator.close_calls == 0
    assert provider.close_calls == 0
    after_settlement = await native_worker.retire_native(provider)
    assert after_settlement.status is native_worker.RetirementStatus.UNKNOWN
    assert after_settlement.failure == lifecycle.failure
    assert iterator.close_calls == 0
    assert provider.close_calls == 0


@pytest.mark.asyncio
async def test_stream_close_descriptor_failure_retains_iterator_and_blocks_provider_close():
    """A raising native iterator descriptor is unknown, not a close success."""

    import app.services.orchestrator.native_worker as native_worker
    from app.services.orchestrator.native_worker import (
        RetirementStatus,
        retire_native,
        stream_native,
    )

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class Iterator:
        def __init__(self):
            self.sent = False
            self.close_lookups = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return "chunk"

        @property
        def close(self):
            self.close_lookups += 1
            raise RuntimeError("iterator descriptor detail must not escape")

    provider = Provider()
    iterator = Iterator()
    assert [item async for item in stream_native(provider, lambda: iterator)] == ["chunk"]

    result = await retire_native(provider)
    assert result.status is RetirementStatus.UNKNOWN
    assert result.failure == "iterator_close_unknown"
    assert iterator.close_lookups == 1
    assert provider.close_calls == 0
    lifecycle = native_worker._lifecycles[id(provider)]
    assert any(reference is iterator for reference in lifecycle.cleanup_references)
    assert len(lifecycle.streams) == 1
    assert next(iter(lifecycle.streams.values())).iterator is iterator

    result = await native_worker.retire_native(provider)
    assert result.status is native_worker.RetirementStatus.UNKNOWN
    assert iterator.close_lookups == 1
    assert provider.close_calls == 0


@pytest.mark.asyncio
async def test_retirement_close_descriptor_failure_is_unknown_off_loop():
    """A raising close descriptor is inspected only after admission closes."""

    import app.services.orchestrator.native_worker as native_worker
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native

    loop_thread = threading.get_ident()

    class Provider:
        def __init__(self):
            self.lookup_thread = None

        @property
        def close(self):
            self.lookup_thread = threading.get_ident()
            raise RuntimeError("descriptor contents must not escape")

    provider = Provider()
    result = await retire_native(provider)
    assert result.status is RetirementStatus.UNKNOWN
    assert result.failure == "provider_close_unknown"
    assert provider.lookup_thread is not None
    assert provider.lookup_thread != loop_thread
    lifecycle = native_worker._lifecycles[id(provider)]
    assert lifecycle.retirement_owner is provider
    assert lifecycle.retirement_close_target is provider


@pytest.mark.asyncio
async def test_async_provider_close_is_unknown_and_is_not_awaited():
    """An asynchronous close hook cannot report a synchronous retirement."""

    from app.services.orchestrator.native_worker import RetirementStatus, retire_native

    class Provider:
        async def close(self):
            raise AssertionError("the async provider close must not be awaited")

    result = await retire_native(Provider())
    assert result.status is RetirementStatus.UNKNOWN
    assert result.failure == "provider_close_unknown"


@pytest.mark.asyncio
async def test_terminal_close_failure_is_sticky_for_zero_deadline_observer():
    """The first actual close error is retained and the provider is never retried."""

    from app.services.orchestrator.native_worker import RetirementStatus, retire_native

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1
            raise RuntimeError("provider details must not escape")

    provider = Provider()
    first = await retire_native(provider)
    assert first.status is RetirementStatus.FAILED
    assert first.failure == "provider_close_failed"
    assert await retire_native(provider, timeout=0) == first
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_terminal_success_is_immutable_for_zero_deadline_observer():
    """A later zero deadline cannot rewrite one already completed close."""

    from app.services.orchestrator.native_worker import RetirementStatus, retire_native

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    provider = Provider()
    completed = await retire_native(provider)
    assert completed.status is RetirementStatus.COMPLETE
    assert await retire_native(provider, timeout=0) == completed
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_cancelled_retirement_owner_is_sticky_and_never_retries_close():
    """Cancelling the retained owner yields doubt without a second close."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0
            self.started = threading.Event()
            self.release = threading.Event()

        def close(self):
            self.close_calls += 1
            self.started.set()
            assert self.release.wait(timeout=5)

    provider = Provider()
    observer = asyncio.create_task(native_worker.retire_native(provider))
    assert await asyncio.wait_for(asyncio.to_thread(provider.started.wait, 2), timeout=3)
    lifecycle = native_worker._lifecycles[id(provider)]
    assert lifecycle.retirement_task is not None
    lifecycle.retirement_task.cancel()
    provider.release.set()

    result = await asyncio.wait_for(observer, timeout=3)
    assert result.status is native_worker.RetirementStatus.UNKNOWN
    assert result.failure == "retirement_owner_cancelled"
    assert lifecycle.retirement_owner is provider
    assert lifecycle.retirement_close_target is provider
    assert await native_worker.retire_native(provider) == result
    assert provider.close_calls == 1


@pytest.mark.asyncio
async def test_retirement_owner_cancelled_before_first_poll_is_sticky_unknown():
    """A pre-start task cancellation cannot strand or restart retirement."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    provider = Provider()
    loop = asyncio.get_running_loop()
    previous_factory = loop.get_task_factory()
    owner_tasks = []

    def cancel_owner_before_poll(task_loop, coroutine, context=None):
        if getattr(getattr(coroutine, "cr_code", None), "co_name", None) == "_retirement_owner":
            task = asyncio.Task(coroutine, loop=task_loop, context=context)
            owner_tasks.append(task)
            task.cancel()
            return task
        if previous_factory is not None:
            return previous_factory(task_loop, coroutine, context=context)
        return asyncio.Task(coroutine, loop=task_loop, context=context)

    loop.set_task_factory(cancel_owner_before_poll)
    try:
        result = await native_worker.retire_native(provider, close_target=provider)
    finally:
        loop.set_task_factory(previous_factory)

    assert len(owner_tasks) == 1
    assert owner_tasks[0].cancelled()
    assert result.status is native_worker.RetirementStatus.UNKNOWN
    assert result.failure == "retirement_owner_cancelled"
    lifecycle = native_worker._lifecycles[id(provider)]
    assert lifecycle.terminal_result == result
    assert lifecycle.retirement_task is owner_tasks[0]
    assert lifecycle.retirement_owner is provider
    assert lifecycle.retirement_close_target is provider
    assert await native_worker.retire_native(provider, close_target=provider) == result
    assert provider.close_calls == 0


@pytest.mark.asyncio
async def test_retirement_task_creation_failure_is_sticky_unknown_without_retry():
    """A loop task-factory fault cannot reopen or retry provider cleanup."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    provider = Provider()
    loop = asyncio.get_running_loop()
    previous_factory = loop.get_task_factory()
    retirement_attempts = 0

    def fail_retirement_creation(task_loop, coroutine, context=None):
        nonlocal retirement_attempts
        if getattr(getattr(coroutine, "cr_code", None), "co_name", None) == "_retirement_owner":
            retirement_attempts += 1
            raise RuntimeError("private task-factory detail")
        if previous_factory is not None:
            return previous_factory(task_loop, coroutine, context=context)
        return asyncio.Task(coroutine, loop=task_loop, context=context)

    loop.set_task_factory(fail_retirement_creation)
    try:
        result = await native_worker.retire_native(provider, close_target=provider)
    finally:
        loop.set_task_factory(previous_factory)

    lifecycle = native_worker._lifecycles[id(provider)]
    assert result.status is native_worker.RetirementStatus.UNKNOWN
    assert result.failure == "retirement_task_creation_failed"
    assert lifecycle.terminal_result == result
    assert lifecycle.retirement_task is None
    assert lifecycle.retirement_owner is provider
    assert lifecycle.retirement_close_target is provider
    assert await native_worker.retire_native(provider, close_target=provider) == result
    assert retirement_attempts == 1
    assert provider.close_calls == 0


@pytest.mark.asyncio
async def test_direct_stream_is_drained_before_provider_retirement():
    """Direct sync streaming reserves the exact provider before client work."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native

    class ClientIterator:
        def __init__(self):
            self.entered = threading.Event()
            self.release = threading.Event()
            self.close_calls = 0
            self.advanced = False

        def __iter__(self):
            return self

        def __next__(self):
            if self.advanced:
                raise StopIteration
            self.entered.set()
            assert self.release.wait(timeout=5)
            self.advanced = True
            return {"choices": [{"delta": {"content": "chunk"}, "finish_reason": None}]}

        def close(self):
            self.close_calls += 1
            raise RuntimeError("iterator close detail")

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            return self.iterator

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=True)
    stream = model._stream([])

    def consume_one_and_close():
        try:
            next(stream)
        finally:
            with suppress(RuntimeError):
                stream.close()

    consumer = asyncio.create_task(asyncio.to_thread(consume_one_and_close))
    assert await asyncio.wait_for(asyncio.to_thread(client.iterator.entered.wait, 2), timeout=3)
    retiring = asyncio.create_task(retire_native(model, close_target=client))
    await asyncio.sleep(0)
    assert not retiring.done()
    assert client.close_calls == 0

    client.iterator.release.set()
    await asyncio.wait_for(consumer, timeout=3)
    result = await asyncio.wait_for(retiring, timeout=3)
    assert result.status is RetirementStatus.FAILED
    assert result.failure == "iterator_close_failed"
    assert client.iterator.close_calls == 1
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_unmodified_astream_drains_blocked_nested_iterator_before_close():
    """The real ChatLlamaCpp async path drains its nested client iterator."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native

    class ClientIterator:
        def __init__(self):
            self.calls = 0
            self.next_started = threading.Event()
            self.release_next = threading.Event()
            self.close_calls = 0
            self.overlapped = False

        def __iter__(self):
            return self

        def __next__(self):
            self.calls += 1
            if self.calls == 1:
                return {"choices": [{"delta": {"content": "first"}, "finish_reason": None}]}
            self.next_started.set()
            assert self.release_next.wait(timeout=5)
            return {"choices": [{"delta": {"content": "second"}, "finish_reason": None}]}

        def close(self):
            self.close_calls += 1
            self.overlapped = self.next_started.is_set() and not self.release_next.is_set()
            raise RuntimeError("nested close failure")

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            return self.iterator

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=True)
    stream = model._astream([])
    first = await stream.__anext__()
    assert first.message.content == "first"
    consumer = asyncio.create_task(stream.__anext__())
    retirement = None
    try:
        assert await asyncio.wait_for(
            asyncio.to_thread(client.iterator.next_started.wait, 2), timeout=3
        )

        retirement = asyncio.create_task(retire_native(model, close_target=client))
        await asyncio.sleep(0)
        assert not retirement.done()
        assert client.iterator.close_calls == 0
        assert client.close_calls == 0

        client.iterator.release_next.set()
        with pytest.raises((asyncio.CancelledError, StopAsyncIteration)):
            await asyncio.wait_for(consumer, timeout=3)
        result = await asyncio.wait_for(retirement, timeout=3)
        assert result.status is RetirementStatus.FAILED
        assert result.failure == "iterator_close_failed"
        assert client.iterator.close_calls == 1
        assert client.iterator.overlapped is False
        assert client.close_calls == 1
    finally:
        client.iterator.release_next.set()
        if not consumer.done():
            consumer.cancel()
        with suppress(BaseException):
            await asyncio.wait_for(consumer, timeout=3)
        if retirement is not None:
            with suppress(BaseException):
                await asyncio.wait_for(retirement, timeout=3)


@pytest.mark.asyncio
async def test_paused_direct_stream_blocks_retirement_and_closes_cross_context():
    """A paused direct generator keeps ownership without leaking its context token."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import (
        ProviderUnavailableError,
        RetirementStatus,
        retire_native,
    )

    class ClientIterator:
        def __init__(self):
            self.sent = False
            self.close_started = threading.Event()
            self.release_close = threading.Event()
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return {"choices": [{"delta": {"content": "first"}, "finish_reason": None}]}

        def close(self):
            self.close_calls += 1
            self.close_started.set()
            assert self.release_close.wait(timeout=5)

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.create_calls = 0
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            self.create_calls += 1
            return self.iterator

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=True)
    stream = model._stream([])
    assert next(stream).text == "first"

    retirement = asyncio.create_task(retire_native(model, close_target=client))
    await asyncio.sleep(0)
    assert not retirement.done()
    with pytest.raises(ProviderUnavailableError):
        model._generate([])
    assert client.create_calls == 1

    close_task = asyncio.create_task(asyncio.to_thread(stream.close))
    assert await asyncio.wait_for(
        asyncio.to_thread(client.iterator.close_started.wait, 2), timeout=3
    )
    assert not retirement.done()
    client.iterator.release_close.set()
    await asyncio.wait_for(close_task, timeout=3)
    result = await asyncio.wait_for(retirement, timeout=3)
    assert result.status is RetirementStatus.COMPLETE
    assert client.iterator.close_calls == 1
    assert client.close_calls == 1


def test_direct_stream_reserves_cleanup_before_client_iterator_creation(monkeypatch):
    """A direct wrapper refuses work before acquiring an untrackable iterator."""

    import app.services.orchestrator.native_worker as native_worker
    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import ProviderUnavailableError

    class Client:
        def __init__(self):
            self.create_calls = 0

        def create_chat_completion(self, **_kwargs):
            self.create_calls += 1
            return iter(())

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client)
    monkeypatch.setattr(native_worker, "MAX_PROVIDER_CLEANUP_REFERENCES", 0)
    with pytest.raises(ProviderUnavailableError) as rejected:
        next(model._stream([]))
    assert str(rejected.value) == "Aurora cannot complete this request right now."
    assert "capacity" not in str(rejected.value)
    assert client.create_calls == 0


@pytest.mark.asyncio
async def test_nested_generate_reserves_both_cleanup_paths_before_provider_work(monkeypatch):
    """A nested wrapper cannot consume work with only one cleanup slot."""

    import app.services.orchestrator.native_worker as native_worker
    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp

    class Client:
        def __init__(self):
            self.create_calls = 0

        def create_chat_completion(self, **_kwargs):
            self.create_calls += 1
            return iter(())

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=True)
    monkeypatch.setattr(native_worker, "MAX_PROVIDER_CLEANUP_REFERENCES", 1)
    with pytest.raises(native_worker.ProviderUnavailableError):
        await native_worker.run_native(model, lambda: model._generate([]))
    assert client.create_calls == 0


@pytest.mark.asyncio
async def test_direct_generate_under_other_provider_operation_is_drained():
    """An unrelated active operation cannot hide direct work on this provider."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native, run_native

    class Client:
        def __init__(self):
            self.started = threading.Event()
            self.release = threading.Event()
            self.close_calls = 0
            self.create_calls = 0

        def create_chat_completion(self, **_kwargs):
            self.create_calls += 1
            self.started.set()
            assert self.release.wait(timeout=5)
            return {
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "completed"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {},
            }

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=False)
    other_provider = object()
    generation = asyncio.create_task(run_native(other_provider, model._generate, []))
    retirement = None
    try:
        assert await asyncio.wait_for(asyncio.to_thread(client.started.wait, 2), timeout=3)

        retirement = asyncio.create_task(retire_native(model, close_target=client))
        await asyncio.sleep(0)
        assert not retirement.done()
        assert client.close_calls == 0

        client.release.set()
        generated = await asyncio.wait_for(generation, timeout=3)
        assert generated.generations[0].message.content == "completed"
        result = await asyncio.wait_for(retirement, timeout=3)
        assert result.status is RetirementStatus.COMPLETE
        assert client.create_calls == 1
        assert client.close_calls == 1
    finally:
        client.release.set()
        if not generation.done():
            generation.cancel()
        with suppress(BaseException):
            await asyncio.wait_for(generation, timeout=3)
        if retirement is not None:
            with suppress(BaseException):
                await asyncio.wait_for(retirement, timeout=3)


@pytest.mark.asyncio
async def test_drain_native_settles_unstarted_stream_without_repeated_stop():
    """Compatibility drain settles a producer canceled before its first poll."""

    import app.services.orchestrator.native_worker as native_worker

    provider = object()
    factory_calls = 0

    def factory():
        nonlocal factory_calls
        factory_calls += 1
        return iter(("unexpected",))

    stream = native_worker.stream_native(provider, factory)
    consumer = asyncio.create_task(stream.__anext__())
    draining = asyncio.create_task(native_worker.drain_native(provider))
    await asyncio.wait_for(draining, timeout=3)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(consumer, timeout=3)

    lifecycle = native_worker._lifecycles[id(provider)]
    assert factory_calls == 0
    assert lifecycle.streams == {}


@pytest.mark.asyncio
async def test_stream_producer_task_creation_failure_is_sticky_unknown_without_retry():
    """A producer-task creation fault retains the lease and never retries."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    provider = Provider()
    factory_calls = 0
    producer_submissions = 0
    failure = RuntimeError("private task-factory detail")

    def iterator_factory():
        nonlocal factory_calls
        factory_calls += 1
        return iter(("unexpected",))

    loop = asyncio.get_running_loop()
    previous_factory = loop.get_task_factory()

    def fail_producer_creation(task_loop, coroutine, context=None):
        nonlocal producer_submissions
        if getattr(getattr(coroutine, "cr_code", None), "co_name", None) == "_produce_stream":
            producer_submissions += 1
            raise failure
        if previous_factory is not None:
            return previous_factory(task_loop, coroutine, context=context)
        return asyncio.Task(coroutine, loop=task_loop, context=context)

    stream = native_worker.stream_native(provider, iterator_factory)
    loop.set_task_factory(fail_producer_creation)
    try:
        consumer = asyncio.create_task(stream.__anext__())
        with pytest.raises(RuntimeError) as raised:
            await asyncio.wait_for(consumer, timeout=3)
    finally:
        loop.set_task_factory(previous_factory)

    assert raised.value is failure
    lifecycle = native_worker._lifecycles[id(provider)]
    lease = next(iter(lifecycle.streams.values()))
    assert lease.task is None
    assert lease.stop_requested
    assert lease.cleanup_unknown
    assert lifecycle.uncertain
    assert not lifecycle.admission_open
    assert factory_calls == 0
    assert producer_submissions == 1
    assert provider.close_calls == 0

    result = await asyncio.wait_for(
        native_worker.retire_native(provider, close_target=provider), timeout=3
    )
    assert result.status is native_worker.RetirementStatus.UNKNOWN
    assert result.failure == "stream_producer_task_creation_unknown"
    assert provider.close_calls == 0
    assert producer_submissions == 1
    assert await native_worker.retire_native(provider, close_target=provider) == result


@pytest.mark.asyncio
async def test_to_thread_task_factory_raises_after_queue_and_retains_factory_result():
    """A queued worker remains owned when its task factory then raises."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class Iterator:
        def __init__(self):
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            raise StopIteration

        def close(self):
            self.close_calls += 1

    provider = Provider()
    iterator = Iterator()
    loop = asyncio.get_running_loop()
    body_started = asyncio.Event()
    release_body = threading.Event()
    factory_calls = 0
    queued_workers: list[asyncio.Task] = []
    submission_error = RuntimeError("private task factory detail")
    previous_factory = loop.get_task_factory()

    def iterator_factory():
        nonlocal factory_calls
        factory_calls += 1
        loop.call_soon_threadsafe(body_started.set)
        if not release_body.wait(timeout=4):
            raise TimeoutError("test worker release was not signaled")
        return iterator

    def queue_then_raise(task_loop, coroutine, context=None):
        if getattr(getattr(coroutine, "cr_code", None), "co_name", None) == "to_thread":
            worker = asyncio.Task(coroutine, loop=task_loop, context=context)
            queued_workers.append(worker)
            raise submission_error
        if previous_factory is not None:
            return previous_factory(task_loop, coroutine, context=context)
        return asyncio.Task(coroutine, loop=task_loop, context=context)

    stream = native_worker.stream_native(provider, iterator_factory)
    consumer = None
    loop.set_task_factory(queue_then_raise)
    try:
        consumer = asyncio.create_task(stream.__anext__())
        assert await asyncio.wait_for(body_started.wait(), timeout=3)
        with pytest.raises(RuntimeError) as raised:
            await asyncio.wait_for(consumer, timeout=3)
        assert raised.value is submission_error
        assert len(queued_workers) == 1
        assert not queued_workers[0].done()

        lifecycle = native_worker._lifecycles[id(provider)]
        operation = next(
            operation
            for operation in lifecycle.operations.values()
            if operation.transfer_required and operation.stream_action == "factory"
        )
        lease = operation.lease
        assert lease is not None
        assert operation.state is native_worker._OperationState.UNKNOWN
        assert operation.retained
        assert operation.cleanup_reservations > 0
        assert lease.cleanup_unknown
        assert lifecycle.uncertain
        assert not lifecycle.admission_open
        assert factory_calls == 1
        assert provider.close_calls == 0

        retirement = await asyncio.wait_for(
            native_worker.retire_native(provider, close_target=provider), timeout=3
        )
        assert retirement.status is native_worker.RetirementStatus.UNKNOWN
        assert retirement.failure == "operation_submission_unknown"
        assert provider.close_calls == 0

        release_body.set()
        await asyncio.wait_for(asyncio.shield(queued_workers[0]), timeout=3)
        await asyncio.wait_for(operation.settled.wait(), timeout=3)
        assert operation.state is native_worker._OperationState.UNKNOWN
        assert operation.outcome is not None
        assert operation.outcome.returned
        assert operation.outcome.value is iterator
        assert operation in lifecycle.operations.values()
        assert lease.cleanup_unknown
        assert iterator.close_calls == 0
        assert provider.close_calls == 0
        assert await native_worker.retire_native(provider, close_target=provider) == retirement
        assert provider.close_calls == 0
    finally:
        loop.set_task_factory(previous_factory)
        release_body.set()
        for worker in queued_workers:
            if not worker.done():
                with suppress(BaseException):
                    await asyncio.wait_for(asyncio.shield(worker), timeout=3)
        if consumer is not None and not consumer.done():
            consumer.cancel()
            with suppress(BaseException):
                await asyncio.wait_for(consumer, timeout=3)


@pytest.mark.asyncio
async def test_internal_executor_cancel_after_body_error_preserves_primary(monkeypatch):
    """Cancelling the wrapper after a body error is not observer cancellation."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    provider = Provider()
    loop = asyncio.get_running_loop()
    outcome_published = asyncio.Event()
    worker_returned = asyncio.Event()
    release_worker = threading.Event()
    operations = []
    primary = RuntimeError("primary body failure")
    original_submit = native_worker._submit_operation

    class GatedWorkerReturned:
        def __init__(self):
            self.event = threading.Event()

        def set(self):
            loop.call_soon_threadsafe(outcome_published.set)
            release_worker.wait(timeout=5)
            self.event.set()
            loop.call_soon_threadsafe(worker_returned.set)

        def wait(self, timeout=None):
            return self.event.wait(timeout)

        def is_set(self):
            return self.event.is_set()

    async def submit_with_return_gate(*args, **kwargs):
        operation = await original_submit(*args, **kwargs)
        operation.worker_returned = GatedWorkerReturned()
        operations.append(operation)
        return operation

    def fail_with_primary():
        raise primary

    monkeypatch.setattr(native_worker, "_submit_operation", submit_with_return_gate)
    observer = asyncio.create_task(native_worker.run_native(provider, fail_with_primary))
    try:
        await asyncio.wait_for(outcome_published.wait(), timeout=3)
        assert len(operations) == 1
        operation = operations[0]
        assert operation.state is native_worker._OperationState.BODY_RAISED
        assert operation.outcome is not None
        assert operation.outcome.error is primary
        assert operation.task is not None
        assert not operation.task.done()

        operation.task.cancel()
        await asyncio.sleep(0)
        assert operation.task.cancelled()
        assert not observer.done()

        release_worker.set()
        with pytest.raises(RuntimeError) as raised:
            await asyncio.wait_for(observer, timeout=3)
        assert raised.value is primary
        await asyncio.wait_for(worker_returned.wait(), timeout=3)
        lifecycle = native_worker._lifecycles[id(provider)]
        assert lifecycle.operations == {}
        assert not lifecycle.uncertain
        assert provider.close_calls == 0
    finally:
        release_worker.set()
        if not observer.done():
            observer.cancel()
            with suppress(BaseException):
                await asyncio.wait_for(observer, timeout=3)


@pytest.mark.asyncio
async def test_dual_cancel_propagates_observer_cancellation(monkeypatch):
    """An inner cancellation must not hide a simultaneous caller cancellation."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def close(self):
            raise AssertionError("the test does not retire the provider")

    provider = Provider()
    loop = asyncio.get_running_loop()
    outcome_published = asyncio.Event()
    settle_started = asyncio.Event()
    worker_returned = asyncio.Event()
    release_worker = threading.Event()
    operations = []
    primary = RuntimeError("primary body failure")
    original_submit = native_worker._submit_operation

    class GatedWorkerReturned:
        def __init__(self):
            self.event = threading.Event()

        def set(self):
            loop.call_soon_threadsafe(outcome_published.set)
            release_worker.wait(timeout=5)
            self.event.set()
            loop.call_soon_threadsafe(worker_returned.set)

        def wait(self, timeout=None):
            return self.event.wait(timeout)

        def is_set(self):
            return self.event.is_set()

    async def submit_with_return_gate(*args, **kwargs):
        operation = await original_submit(*args, **kwargs)
        operation.worker_returned = GatedWorkerReturned()
        operations.append(operation)
        return operation

    original_settle = native_worker._settle_executor_wrapper

    async def observe_settle(operation):
        settle_started.set()
        return await original_settle(operation)

    def fail_with_primary():
        raise primary

    monkeypatch.setattr(native_worker, "_submit_operation", submit_with_return_gate)
    monkeypatch.setattr(native_worker, "_settle_executor_wrapper", observe_settle)
    observer = asyncio.create_task(native_worker.run_native(provider, fail_with_primary))
    try:
        await asyncio.wait_for(outcome_published.wait(), timeout=3)
        await asyncio.wait_for(settle_started.wait(), timeout=3)
        await asyncio.sleep(0)
        assert len(operations) == 1
        operation = operations[0]
        assert operation.state is native_worker._OperationState.BODY_RAISED
        assert operation.outcome is not None
        assert operation.outcome.error is primary
        assert operation.task is not None
        assert not operation.task.done()

        # Both cancellation requests happen before either task gets another
        # turn; the actual synchronous body remains held until both are seen.
        operation.task.cancel()
        observer.cancel()
        await asyncio.sleep(0)
        assert operation.task.cancelled()
        assert not observer.done()

        release_worker.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(observer, timeout=3)
        await asyncio.wait_for(worker_returned.wait(), timeout=3)
        assert operation.outcome is None
        assert not operation.retained
        assert not operation.settlement_unknown
        assert native_worker._lifecycles[id(provider)].operations == {}
    finally:
        release_worker.set()
        if not observer.done():
            observer.cancel()
            with suppress(BaseException):
                await asyncio.wait_for(observer, timeout=3)


@pytest.mark.asyncio
async def test_fallback_waiter_task_factory_failure_retains_primary_and_unknown(monkeypatch):
    """An ambiguously queued wrapper waiter cannot replace a primary error."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    provider = Provider()
    loop = asyncio.get_running_loop()
    outcome_published = asyncio.Event()
    waiter_creation_attempted = asyncio.Event()
    worker_returned = asyncio.Event()
    release_worker = threading.Event()
    operations = []
    queued_to_threads: list[asyncio.Task] = []
    submission_count = 0
    primary = RuntimeError("primary body failure")
    waiter_creation_error = RuntimeError("private waiter task-factory detail")
    original_submit = native_worker._submit_operation
    previous_factory = loop.get_task_factory()

    class GatedWorkerReturned:
        def __init__(self):
            self.event = threading.Event()

        def set(self):
            loop.call_soon_threadsafe(outcome_published.set)
            release_worker.wait(timeout=5)
            self.event.set()
            loop.call_soon_threadsafe(worker_returned.set)

        def wait(self, timeout=None):
            return self.event.wait(timeout)

        def is_set(self):
            return self.event.is_set()

    async def submit_with_return_gate(*args, **kwargs):
        operation = await original_submit(*args, **kwargs)
        operation.worker_returned = GatedWorkerReturned()
        operations.append(operation)
        return operation

    def queue_waiter_then_raise(task_loop, coroutine, context=None):
        nonlocal submission_count
        if getattr(getattr(coroutine, "cr_code", None), "co_name", None) == "to_thread":
            submission_count += 1
            task = asyncio.Task(coroutine, loop=task_loop, context=context)
            queued_to_threads.append(task)
            if submission_count == 2:
                waiter_creation_attempted.set()
                raise waiter_creation_error
            return task
        if previous_factory is not None:
            return previous_factory(task_loop, coroutine, context=context)
        return asyncio.Task(coroutine, loop=task_loop, context=context)

    def fail_with_primary():
        raise primary

    monkeypatch.setattr(native_worker, "_submit_operation", submit_with_return_gate)
    loop.set_task_factory(queue_waiter_then_raise)
    observer = asyncio.create_task(native_worker.run_native(provider, fail_with_primary))
    try:
        await asyncio.wait_for(outcome_published.wait(), timeout=3)
        assert len(operations) == 1
        operation = operations[0]
        assert operation.state is native_worker._OperationState.BODY_RAISED
        assert operation.outcome is not None
        assert operation.outcome.error is primary
        assert operation.task is queued_to_threads[0]

        operation.task.cancel()
        await asyncio.sleep(0)
        assert operation.task.cancelled()
        await asyncio.wait_for(waiter_creation_attempted.wait(), timeout=3)
        assert submission_count == 2
        assert len(queued_to_threads) == 2

        with pytest.raises(RuntimeError) as raised:
            await asyncio.wait_for(observer, timeout=3)
        assert raised.value is primary

        lifecycle = native_worker._lifecycles[id(provider)]
        assert operation.settlement_unknown
        assert operation.retained
        assert operation in lifecycle.operations.values()
        assert operation.outcome is not None
        assert operation.outcome.error is primary
        assert lifecycle.uncertain
        assert not lifecycle.admission_open
        assert lifecycle.failure == "executor_wrapper_settlement_unknown"
        assert provider.close_calls == 0

        retirement = await asyncio.wait_for(
            native_worker.retire_native(provider, close_target=provider), timeout=3
        )
        assert retirement.status is native_worker.RetirementStatus.UNKNOWN
        assert retirement.failure == "executor_wrapper_settlement_unknown"
        assert provider.close_calls == 0

        release_worker.set()
        await asyncio.wait_for(worker_returned.wait(), timeout=3)
        await asyncio.wait_for(asyncio.shield(queued_to_threads[1]), timeout=3)
        assert operation.state is native_worker._OperationState.BODY_RAISED
        assert operation.settlement_unknown
        assert operation.outcome is not None
        assert operation.outcome.error is primary
        assert operation in lifecycle.operations.values()
        assert await native_worker.retire_native(provider, close_target=provider) == retirement
        assert provider.close_calls == 0
    finally:
        loop.set_task_factory(previous_factory)
        release_worker.set()
        for task in queued_to_threads:
            if not task.done():
                with suppress(BaseException):
                    await asyncio.wait_for(asyncio.shield(task), timeout=3)
        if not observer.done():
            observer.cancel()
            with suppress(BaseException):
                await asyncio.wait_for(observer, timeout=3)


@pytest.mark.asyncio
async def test_stale_copied_operation_context_cannot_bypass_retirement():
    """A copied ContextVar is not authority after its callable has returned."""

    import contextvars

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import (
        ProviderUnavailableError,
        RetirementStatus,
        retire_native,
        run_native,
    )

    class Client:
        def __init__(self):
            self.create_calls = 0
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            self.create_calls += 1
            return {
                "choices": [
                    {"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
                ],
                "usage": {},
            }

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client)
    captured: contextvars.Context | None = None

    def capture_context():
        nonlocal captured
        captured = contextvars.copy_context()
        return "captured"

    assert await run_native(model, capture_context) == "captured"
    assert captured is not None
    retired = await retire_native(model, close_target=client)
    assert retired.status is RetirementStatus.COMPLETE
    assert client.close_calls == 1
    with pytest.raises(ProviderUnavailableError):
        await asyncio.to_thread(captured.run, model._generate, [])
    assert client.create_calls == 0


@pytest.mark.asyncio
async def test_direct_nested_iterator_cleanup_is_retained_for_exact_provider():
    """A synchronous wrapper cleanup without an operation context is retained."""

    import gc
    import weakref

    from app.services.orchestrator import native_worker
    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus

    primary = RuntimeError("primary generation error")

    class Client:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class Iterator:
        def __iter__(self):
            return self

        def __next__(self):
            raise primary

        def close(self):
            raise RuntimeError("nested cleanup detail must not escape")

    class ClientWithStream(Client):
        def __init__(self):
            super().__init__()
            self.iterator = Iterator()

        def create_chat_completion(self, **_kwargs):
            return self.iterator

    client = ClientWithStream()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=True)
    with pytest.raises(RuntimeError) as raised:
        model._generate([])
    assert raised.value is primary

    owner_ref = weakref.ref(model)
    raised.value.__traceback__ = None
    primary.__traceback__ = None
    del raised
    del model
    gc.collect()
    assert owner_ref() is not None
    cleanup = native_worker._direct_cleanups[id(owner_ref())]
    assert cleanup.owner() is owner_ref()
    assert any(reference is client.iterator for reference in cleanup.references)

    result = await chatbot.dispose_llm(owner_ref())
    assert result.status is RetirementStatus.FAILED
    assert result.failure == "iterator_close_failed"
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_stream_callback_nested_generate_reserves_distinct_cleanup_paths(monkeypatch):
    """A nested generate reserves its two iterator owners before client work."""

    from app.services.orchestrator import native_worker
    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native

    class ClientIterator:
        def __init__(self):
            self.sent = False
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return {"choices": [{"delta": {"content": "nested callback"}, "finish_reason": None}]}

        def close(self):
            self.close_calls += 1
            raise RuntimeError("iterator cleanup failed")

    class Client:
        def __init__(self):
            self.iterators = []
            self.close_calls = 0
            self.model = None

        def create_chat_completion(self, **_kwargs):
            if self.iterators:
                record = native_worker._direct_calls[id(self.model)]
                assert record.cleanup_reservations == 3
            iterator = ClientIterator()
            self.iterators.append(iterator)
            return iterator

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=True)
    client.model = model
    monkeypatch.setattr(native_worker, "MAX_PROVIDER_CLEANUP_REFERENCES", 3)

    class Callback:
        called = False

        def on_llm_new_token(self, _token, **_kwargs):
            if self.called:
                return
            self.called = True
            with pytest.raises(RuntimeError):
                model._generate([])

    with pytest.raises(RuntimeError):
        list(model._stream([], run_manager=Callback()))

    cleanup = native_worker._direct_cleanups[id(model)]
    assert len(client.iterators) == 2
    assert all(iterator.close_calls == 1 for iterator in client.iterators)
    assert len(cleanup.references) == 2
    assert all(
        any(reference is iterator for reference in cleanup.references)
        for iterator in client.iterators
    )
    assert native_worker._direct_cleanup_overflow is False

    result = await retire_native(model, close_target=client)
    assert result.status is RetirementStatus.FAILED
    assert result.failure == "iterator_close_failed"
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_direct_async_nested_iterator_close_is_unknown_and_blocks_client_close():
    """A synchronous wrapper cannot count an unawaited nested close as complete."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp, _close_native_iterator
    from app.services.orchestrator.native_worker import RetirementStatus

    class Client:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class AsyncCloseIterator:
        async def close(self):
            raise AssertionError("the async close must not be awaited")

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client)
    close_error = _close_native_iterator(AsyncCloseIterator(), provider=model)
    assert isinstance(close_error, RuntimeError)

    result = await chatbot.dispose_llm(model)
    assert result.status is RetirementStatus.UNKNOWN
    assert result.failure == "iterator_close_unknown"
    assert client.close_calls == 0


@pytest.mark.asyncio
async def test_generate_close_descriptor_failure_preserves_primary_and_retains_iterator():
    """A raising nested close descriptor cannot replace the generation error."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus

    primary = RuntimeError("primary generation failure")

    class Client:
        def __init__(self):
            self.close_calls = 0
            self.iterator = Iterator()

        def create_chat_completion(self, **_kwargs):
            return self.iterator

        def close(self):
            self.close_calls += 1

    class Iterator:
        def __iter__(self):
            return self

        def __next__(self):
            raise primary

        @property
        def close(self):
            raise RuntimeError("descriptor detail must not escape")

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=True)
    with pytest.raises(RuntimeError) as raised:
        model._generate([])
    assert raised.value is primary

    result = await chatbot.dispose_llm(model)
    assert result.status is RetirementStatus.UNKNOWN
    assert result.failure == "iterator_close_unknown"
    assert client.close_calls == 0


@pytest.mark.asyncio
async def test_dispose_bound_chat_llama_alias_closes_canonical_client():
    """A LangChain bound alias still retires the underlying ChatLlama client."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus

    class Client:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client)
    bound = model.bind(stop=["finished"])

    result = await chatbot.dispose_llm(bound)
    assert result.status is RetirementStatus.COMPLETE
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_generate_consumer_failure_closes_nested_iterator_and_preserves_primary(monkeypatch):
    """The real _generate cleanup closes its nested stream on consumer failure."""

    import app.services.orchestrator.chat_llama_cpp as llama_module
    from app.services.orchestrator.native_worker import run_native

    primary = RuntimeError("stream consumer failure")

    class ClientIterator:
        def __init__(self):
            self.sent = False
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return {"choices": [{"delta": {"content": "first"}, "finish_reason": None}]}

        def close(self):
            self.close_calls += 1

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()

        def create_chat_completion(self, **_kwargs):
            return self.iterator

    client = Client()
    model = llama_module.ChatLlamaCpp.model_construct(
        model_path="unused", client=client, streaming=True
    )

    def fail_after_one_chunk(stream):
        next(iter(stream))
        raise primary

    monkeypatch.setattr(llama_module, "generate_from_stream", fail_after_one_chunk)
    with pytest.raises(RuntimeError) as raised:
        await run_native(model, model._generate, [])
    assert raised.value is primary
    assert client.iterator.close_calls == 1


@pytest.mark.asyncio
async def test_stream_eof_waits_for_iterator_close_without_cancelling_cleanup():
    """Natural EOF waits for its actual iterator close and keeps the result clean."""

    from app.services.orchestrator.native_worker import (
        RetirementStatus,
        retire_native,
        stream_native,
    )

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class BlockingCloseIterator:
        def __init__(self):
            self.sent = False
            self.close_started = threading.Event()
            self.release_close = threading.Event()
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return "chunk"

        def close(self):
            self.close_calls += 1
            self.close_started.set()
            assert self.release_close.wait(timeout=5)

    provider = Provider()
    iterator = BlockingCloseIterator()
    stream = stream_native(provider, lambda: iterator)

    async def consume_all():
        return [item async for item in stream]

    consumer = asyncio.create_task(consume_all())
    assert await asyncio.wait_for(asyncio.to_thread(iterator.close_started.wait, 2), timeout=3)
    assert not consumer.done()
    assert provider.close_calls == 0

    consumer.cancel()
    await asyncio.sleep(0)
    consumer.cancel()

    iterator.release_close.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(consumer, timeout=3)
    result = await retire_native(provider)
    assert result.status is RetirementStatus.COMPLETE
    assert iterator.close_calls == 1
    assert provider.close_calls == 1


def test_weak_owner_lifecycle_is_reclaimed_after_actual_owner_dies():
    """The identity table does not retain weak-referenceable providers."""

    import gc
    import weakref

    from app.services.orchestrator.native_worker import _lifecycles, run_native

    class Provider:
        pass

    provider = Provider()
    owner_id = id(provider)
    reference = weakref.ref(provider)
    asyncio.run(run_native(provider, lambda: "completed"))
    assert owner_id in _lifecycles
    del provider
    gc.collect()
    assert reference() is None
    assert owner_id not in _lifecycles


@pytest.mark.asyncio
async def test_provider_lifecycle_capacity_rejects_before_callable_execution():
    """The bounded identity registry refuses overflow without side effects."""

    import app.services.orchestrator.native_worker as native_worker
    from app.services.orchestrator.native_worker import run_native

    class Provider:
        pass

    retained_owners = []
    while len(native_worker._lifecycles) < native_worker.MAX_PROVIDER_LIFECYCLES:
        owner = Provider()
        await run_native(owner, lambda: None)
        retained_owners.append(owner)

    overflow = Provider()
    invoked = False

    def must_not_run():
        nonlocal invoked
        invoked = True

    with pytest.raises(native_worker.ProviderUnavailableError):
        await run_native(overflow, must_not_run)
    assert invoked is False


@pytest.mark.asyncio
async def test_direct_provider_identity_capacity_counts_existing_lifecycles(monkeypatch):
    """Direct admission shares the bounded identity budget with async owners."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        pass

    first = Provider()
    second = Provider()
    current = native_worker._retained_identity_count()
    monkeypatch.setattr(native_worker, "MAX_PROVIDER_LIFECYCLES", current + 1)
    assert await native_worker.run_native(first, lambda: "done") == "done"
    entered = False
    with (
        pytest.raises(native_worker.ProviderUnavailableError),
        native_worker.direct_native_operation(second),
    ):
        entered = True
    assert entered is False


@pytest.mark.asyncio
async def test_provider_operation_capacity_rejects_before_executor_submission():
    """Per-provider admission is bounded before the executor sees overflow."""

    import app.services.orchestrator.native_worker as native_worker

    class Provider:
        pass

    provider = Provider()
    started = threading.Event()
    release = threading.Event()
    invoked_overflow = False

    def blocked():
        started.set()
        assert release.wait(timeout=5)
        return "completed"

    tasks = [
        asyncio.create_task(native_worker.run_native(provider, blocked))
        for _ in range(native_worker.MAX_PROVIDER_OPERATIONS)
    ]
    assert await asyncio.wait_for(asyncio.to_thread(started.wait, 2), timeout=3)
    lifecycle = native_worker._lifecycles[id(provider)]

    async def wait_until_admitted():
        while True:
            with lifecycle.lock:
                if len(lifecycle.operations) == native_worker.MAX_PROVIDER_OPERATIONS:
                    return
            await asyncio.sleep(0.001)

    await asyncio.wait_for(wait_until_admitted(), timeout=3)

    def must_not_run():
        nonlocal invoked_overflow
        invoked_overflow = True

    with pytest.raises(native_worker.ProviderUnavailableError):
        await native_worker.run_native(provider, must_not_run)
    assert invoked_overflow is False

    release.set()
    assert (
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)
        == ["completed"] * native_worker.MAX_PROVIDER_OPERATIONS
    )


@pytest.mark.asyncio
async def test_nonweak_provider_uses_bounded_strong_identity_fallback():
    """Providers without weakref support remain retained under the cap."""

    import app.services.orchestrator.native_worker as native_worker

    class NonWeakProvider:
        __slots__ = ()

    provider = NonWeakProvider()
    assert await native_worker.run_native(provider, lambda: "finished") == "finished"
    lifecycle = native_worker._lifecycles[id(provider)]
    assert lifecycle.weak_referenceable is False
    assert lifecycle.strong_owner is provider


@pytest.mark.asyncio
async def test_chat_llama_generate_preserves_primary_error_and_closes_nested_iterator():
    """The finite streaming wrapper closes nested iteration on conversion errors."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native, run_native

    primary = RuntimeError("primary generation failure")

    class ClientIterator:
        def __init__(self):
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            raise primary

        def close(self):
            self.close_calls += 1

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            return self.iterator

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=True)
    with pytest.raises(RuntimeError) as raised:
        await run_native(model, model._generate, [])
    assert raised.value is primary
    assert client.iterator.close_calls == 1
    assert await run_native(model, lambda: "later clean operation") == "later clean operation"
    result = await retire_native(model, close_target=client)
    assert result.status is RetirementStatus.COMPLETE
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_chat_llama_generate_cleanup_failure_keeps_primary_error_sticky():
    """The real finite wrapper preserves its error while recording close doubt."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native, run_native

    primary = RuntimeError("primary generation failure")

    class ClientIterator:
        def __init__(self):
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            raise primary

        def close(self):
            self.close_calls += 1
            raise RuntimeError("nested iterator close failed")

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            return self.iterator

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=True)
    with pytest.raises(RuntimeError) as raised:
        await run_native(model, model._generate, [])
    assert raised.value is primary
    assert client.iterator.close_calls == 1
    assert await run_native(model, lambda: "later clean operation") == "later clean operation"
    result = await retire_native(model, close_target=client)
    assert result.status is RetirementStatus.FAILED
    assert result.failure == "iterator_close_failed"
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_chat_llama_stream_closes_nested_iterator_and_preserves_callbacks():
    """The real wrapper closes the backend iterator after preserving chunks."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native, run_native

    class ClientIterator:
        def __init__(self):
            self.index = 0
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.index >= 2:
                raise StopIteration
            self.index += 1
            return {
                "choices": [{"delta": {"content": f"part-{self.index}"}, "finish_reason": None}]
            }

        def close(self):
            self.close_calls += 1

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            return self.iterator

        def close(self):
            self.close_calls += 1

    class Callback:
        def __init__(self):
            self.tokens = []

        def on_llm_new_token(self, token, **_kwargs):
            self.tokens.append(token)

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client)
    callback = Callback()
    chunks = await run_native(model, lambda: list(model._stream([], run_manager=callback)))
    assert [chunk.text for chunk in chunks] == ["part-1", "part-2"]
    assert callback.tokens == ["part-1", "part-2"]
    assert client.iterator.close_calls == 1
    result = await retire_native(model, close_target=client)
    assert result.status is RetirementStatus.COMPLETE
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_chat_llama_generate_closes_nested_iterator_on_success():
    """The real _generate path closes its outer and nested streaming iterators."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native, run_native

    class ClientIterator:
        def __init__(self):
            self.used = False
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.used:
                raise StopIteration
            self.used = True
            return {"choices": [{"delta": {"content": "complete"}, "finish_reason": "stop"}]}

        def close(self):
            self.close_calls += 1

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            return self.iterator

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client)
    result = await run_native(model, model._generate, [])
    assert result.generations[0].message.content == "complete"
    assert client.iterator.close_calls == 1
    retired = await retire_native(model, close_target=client)
    assert retired.status is RetirementStatus.COMPLETE
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_chat_llama_stream_cleanup_only_error_is_fixed_and_sticky():
    """A close-only exception is redacted while the real stream still fails closed."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native, run_native

    sentinel = "private /home/user/model token=stream-secret"

    class ClientIterator:
        def __init__(self):
            self.sent = False
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return {"choices": [{"delta": {"content": "safe"}, "finish_reason": "stop"}]}

        def close(self):
            self.close_calls += 1
            raise RuntimeError(sentinel)

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            return self.iterator

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client)
    with pytest.raises(
        RuntimeError, match="^Aurora cannot complete this request right now\\.$"
    ) as raised:
        await run_native(model, lambda: list(model._stream([])))
    assert sentinel not in str(raised.value)
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None
    assert client.iterator.close_calls == 1

    retired = await retire_native(model, close_target=client)
    assert retired.status is RetirementStatus.FAILED
    assert retired.failure == "iterator_close_failed"
    assert client.iterator.close_calls == 1
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_chat_llama_generate_cleanup_only_error_is_fixed_and_sticky():
    """The actual finite generation path never exposes a backend close message."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native, run_native

    sentinel = "private /home/user/model token=generate-secret"

    class ClientIterator:
        def __init__(self):
            self.sent = False
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return {"choices": [{"delta": {"content": "safe"}, "finish_reason": "stop"}]}

        def close(self):
            self.close_calls += 1
            raise RuntimeError(sentinel)

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            return self.iterator

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=True)
    with pytest.raises(
        RuntimeError, match="^Aurora cannot complete this request right now\\.$"
    ) as raised:
        await run_native(model, model._generate, [])
    assert sentinel not in str(raised.value)
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None
    assert client.iterator.close_calls == 1

    retired = await retire_native(model, close_target=client)
    assert retired.status is RetirementStatus.FAILED
    assert retired.failure == "iterator_close_failed"
    assert client.iterator.close_calls == 1
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_cleanup_callbacks_cannot_admit_new_provider_streams():
    """Iterator and provider close callbacks cannot reopen inference admission."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import (
        ProviderUnavailableError,
        RetirementStatus,
        retire_native,
        run_native,
    )

    class ClientIterator:
        def __init__(self):
            self.sent = False
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return {"choices": [{"delta": {"content": "safe"}, "finish_reason": "stop"}]}

        def close(self):
            self.close_calls += 1
            attempt_cleanup_stream("iterator-close")

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.create_calls = 0
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            self.create_calls += 1
            return self.iterator

        def close(self):
            self.close_calls += 1
            attempt_cleanup_stream("provider-close")

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client)
    rejections = []

    def attempt_cleanup_stream(source):
        try:
            next(model._stream([]))
        except ProviderUnavailableError:
            rejections.append(source)
        else:
            raise AssertionError("cleanup callback admitted new inference")

    chunks = await run_native(model, lambda: list(model._stream([])))
    assert [chunk.text for chunk in chunks] == ["safe"]
    assert rejections == ["iterator-close"]
    assert client.create_calls == 1
    assert client.iterator.close_calls == 1

    result = await retire_native(model, close_target=client)
    assert rejections == ["iterator-close", "provider-close"]
    assert result.status is RetirementStatus.COMPLETE
    assert client.create_calls == 1
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_nested_stream_transfers_reserved_lifetime_beyond_generate_return():
    """An escaped nested stream remains owned after its finite parent returns."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import (
        ProviderUnavailableError,
        RetirementStatus,
        retire_native,
        run_native,
    )

    class ClientIterator:
        def __init__(self):
            self.sent = False
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return {"choices": [{"delta": {"content": "child"}, "finish_reason": None}]}

        def close(self):
            self.close_calls += 1

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.model = None
            self.child = None
            self.child_chunk = None
            self.child_created = False
            self.create_calls = 0
            self.close_calls = 0

        def create_chat_completion(self, **kwargs):
            self.create_calls += 1
            if kwargs.get("stream"):
                return self.iterator
            if not self.child_created:
                self.child_created = True
                self.child = self.model._stream([])
                self.child_chunk = next(self.child)
            return {
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "parent"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {},
            }

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client, streaming=False)
    client.model = model

    generated = await run_native(model, model._generate, [])
    assert generated.generations[0].message.content == "parent"
    assert client.child is not None
    assert client.child_chunk is not None
    assert client.child_chunk.text == "child"
    assert client.iterator.close_calls == 0

    retirement = asyncio.create_task(retire_native(model, close_target=client))
    await asyncio.sleep(0)
    assert not retirement.done()
    assert client.close_calls == 0
    with pytest.raises(ProviderUnavailableError):
        await run_native(model, model._generate, [])

    client.child.close()
    result = await asyncio.wait_for(retirement, timeout=3)
    assert result.status is RetirementStatus.COMPLETE
    assert client.iterator.close_calls == 1
    assert client.create_calls == 2
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_nested_iterator_cleanup_failure_stays_sticky_and_preserves_primary_error():
    """Nested close failure is sticky while the primary provider error is preserved."""

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.native_worker import RetirementStatus, retire_native, run_native

    primary = RuntimeError("primary operation failure")

    class ClientIterator:
        def __iter__(self):
            return self

        def __next__(self):
            raise primary

        def close(self):
            raise RuntimeError("cleanup failure")

    class Client:
        def __init__(self):
            self.iterator = ClientIterator()
            self.close_calls = 0

        def create_chat_completion(self, **_kwargs):
            return self.iterator

        def close(self):
            self.close_calls += 1

    client = Client()
    model = ChatLlamaCpp.model_construct(model_path="unused", client=client)
    with pytest.raises(RuntimeError) as raised:
        await run_native(model, lambda: list(model._stream([])))
    assert raised.value is primary
    assert await run_native(model, lambda: "later clean operation") == "later clean operation"
    result = await retire_native(model, close_target=client)
    assert result.status is RetirementStatus.FAILED
    assert result.failure == "iterator_close_failed"
    assert client.close_calls == 1


@pytest.mark.asyncio
async def test_missing_nested_iterator_close_is_unknown_and_blocks_client_close():
    """An iterator without the required close capability cannot retire cleanly."""

    from app.services.orchestrator.native_worker import (
        RetirementStatus,
        retire_native,
        stream_native,
    )

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    class NoCloseIterator:
        def __init__(self):
            self.sent = False

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            return "chunk"

    provider = Provider()
    iterator = NoCloseIterator()
    assert [chunk async for chunk in stream_native(provider, lambda: iterator)] == ["chunk"]
    result = await retire_native(provider)
    assert result.status is RetirementStatus.UNKNOWN
    assert result.failure == "iterator_close_unknown"
    assert provider.close_calls == 0


@pytest.mark.asyncio
async def test_retirement_rejects_observation_from_a_different_loop():
    """A second loop cannot adopt an existing provider lifecycle."""

    import concurrent.futures

    from app.services.orchestrator.native_worker import (
        ProviderUnavailableError,
        RetirementStatus,
        retire_native,
        run_native,
    )

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    provider = Provider()
    started = threading.Event()
    release = threading.Event()

    def blocked():
        started.set()
        assert release.wait(timeout=5)
        return "old loop result"

    original = asyncio.create_task(run_native(provider, blocked))
    assert await asyncio.wait_for(asyncio.to_thread(started.wait, 2), timeout=3)
    cross_loop_result: concurrent.futures.Future = concurrent.futures.Future()

    def observe_other_loop():
        async def attempt():
            try:
                await run_native(provider, lambda: pytest.fail("must not execute on another loop"))
            except BaseException as error:
                cross_loop_result.set_result(error)

        asyncio.run(attempt())

    thread = threading.Thread(target=observe_other_loop)
    thread.start()
    other_loop_error = await asyncio.wait_for(asyncio.wrap_future(cross_loop_result), timeout=3)
    await asyncio.to_thread(thread.join, 3)
    assert isinstance(other_loop_error, ProviderUnavailableError)

    release.set()
    assert await original == "old loop result"
    retired = await retire_native(provider)
    assert retired.status is RetirementStatus.COMPLETE
    assert provider.close_calls == 1
