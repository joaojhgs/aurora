"""Regression coverage for CPU-only llama.cpp initialization."""

from __future__ import annotations

import asyncio
import importlib
import sys
import threading
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
