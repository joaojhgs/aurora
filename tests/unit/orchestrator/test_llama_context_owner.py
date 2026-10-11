"""Production-path tests for one exclusive, request-owned Llama context."""

from __future__ import annotations

import asyncio
import contextvars
import inspect
import sys
import threading
from contextlib import suppress
from types import FunctionType, ModuleType, SimpleNamespace

import pytest
from langchain_core.messages import HumanMessage

from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
from app.services.orchestrator.llama_context_owner import (
    MAX_LLAMA_WAITERS,
    NativeContextUnavailableError,
    canonical_native_owner,
    generation_for,
    make_owned_llama_class,
    native_context,
    retirement_blocked,
    retirement_close_binding,
)
from app.services.orchestrator.native_request_completion import (
    RequestBinding,
    RequestCompletionStatus,
    bind_request_group,
    create_request_group,
    current_request_member,
)
from app.services.orchestrator.native_worker import (
    ProviderUnavailableError,
    RetirementStatus,
    direct_native_call,
    provider_owner,
    retire_native,
    run_native,
    stream_native,
)

# The formatter template is rebound to a controlled module dictionary below.
formatter_marker: dict[str, str] = {}
_unsettled_native_test_workers: list[tuple[object, ...]] = []


def _backend(
    monkeypatch: pytest.MonkeyPatch | None = None,
    *,
    waits: dict[str, tuple[threading.Event | asyncio.Event, threading.Event]] | None = None,
    tail_waits: dict[str, tuple[threading.Event, threading.Event]] | None = None,
    terminal_chat_stream: bool = False,
    yield_values: dict[str, tuple[object, ...]] | None = None,
    synchronization_failure: bool = False,
    registry_handler: bool = False,
    specialized_registry_handler: bool = False,
    lazy_registry_handler: bool = False,
    opaque_handler: bool = False,
    real_jinja_handler: bool = False,
    custom_tokenizer: bool = False,
    stop_token_ids: tuple[int, ...] = (2,),
    no_close_completion: bool = False,
):
    syncs = []
    trace = []

    if real_jinja_handler:
        import importlib

        format_module = importlib.import_module("llama_cpp.llama_chat_format")
    else:
        format_module = ModuleType("llama_cpp.llama_chat_format")
        format_module.formatter_marker = {"mode": "original"}
        format_module.__dict__["formatter_marker"] = format_module.formatter_marker

    class FakeJinja2ChatFormatter:
        def __init__(self):
            self.template = "controlled template"
            self.eos_token = "<eos>"
            self.bos_token = "<bos>"
            self.add_generation_prompt = True
            self.stop_token_ids = set(stop_token_ids)

        def __call__(self, **kwargs):
            return {"stream": kwargs.get("stream", False)}

    FakeJinja2ChatFormatter.__module__ = format_module.__name__

    class SpecializedChatFormatter:
        def __call__(self, **kwargs):
            return {"stream": kwargs.get("stream", False)}

    class OpaqueChatHandler:
        def __call__(self, **kwargs):
            llama = kwargs["llama"]
            return llama.create_completion(stream=kwargs.get("stream", False))

    SpecializedChatFormatter.__module__ = format_module.__name__

    def standard_formatter_template(**kwargs):
        format_module_marker = formatter_marker.get("mode")
        del format_module_marker
        return {"stream": kwargs.get("stream", False)}

    standard_formatter = FunctionType(
        standard_formatter_template.__code__,
        format_module.__dict__,
        "standard_formatter",
    )

    def chat_formatter_to_chat_completion_handler(chat_formatter):
        if lazy_registry_handler:

            def chat_completion_handler(**kwargs):
                formatted = chat_formatter(**kwargs)
                for token in kwargs["llama"].create_completion(**formatted):
                    yield token["token"] if isinstance(token, dict) else token
        else:

            def chat_completion_handler(**kwargs):
                formatted = chat_formatter(**kwargs)
                return kwargs["llama"].create_completion(**formatted)

        chat_completion_handler.__module__ = format_module.__name__
        return chat_completion_handler

    if not real_jinja_handler:
        format_module.__dict__["format_module"] = format_module
        chat_formatter_to_chat_completion_handler = FunctionType(
            chat_formatter_to_chat_completion_handler.__code__,
            format_module.__dict__,
            "chat_formatter_to_chat_completion_handler",
            chat_formatter_to_chat_completion_handler.__defaults__,
            chat_formatter_to_chat_completion_handler.__closure__,
        )
        chat_formatter_to_chat_completion_handler.__module__ = format_module.__name__
        format_module.__file__ = standard_formatter.__code__.co_filename
        format_module.Jinja2ChatFormatter = FakeJinja2ChatFormatter
        format_module.chat_formatter_to_chat_completion_handler = (
            chat_formatter_to_chat_completion_handler
        )
    if real_jinja_handler:
        selected_formatter = format_module.Jinja2ChatFormatter(
            template="{{ messages[0].content }}{{ eos_token }}",
            eos_token="<eos>",
            bos_token="<bos>",
            stop_token_ids=stop_token_ids,
        )
    else:
        selected_formatter = (
            SpecializedChatFormatter()
            if specialized_registry_handler
            else standard_formatter
            if registry_handler
            else FakeJinja2ChatFormatter()
        )
    if registry_handler:
        standard_formatter.__module__ = format_module.__name__
    handler = (
        format_module.chat_formatter_to_chat_completion_handler(selected_formatter)
        if real_jinja_handler
        else chat_formatter_to_chat_completion_handler(selected_formatter)
    )
    if not real_jinja_handler:
        handler.__module__ = format_module.__name__
    handler_default = handler

    class FakeLlama:
        __module__ = "llama_cpp.llama"
        constructor_calls = []

        def __init__(self):
            type(self).__mro__[1].constructor_calls.append(id(self))
            self._ctx = object()
            self.ctx = object()
            if custom_tokenizer:
                self.tokenizer_ = object()
            self.chat_format = "test-format"
            self.chat_handler = OpaqueChatHandler() if opaque_handler else None
            self._chat_handlers = (
                {"test-format": handler} if real_jinja_handler or not registry_handler else {}
            )
            self.generate_calls = 0
            self.evaluations = []
            self.on_generation_step = None
            self.close_calls = 0
            self.iterator_close_calls = 0
            self.generation_error = None
            self.on_iterator_close = None
            self.on_close = None
            self.stopping_criteria_calls = []

        def generate(self, label, **kwargs):
            try:
                self.generate_calls += 1
                self.evaluations.append(("factory", label))
                trace.append(("factory", label))
                stopping_criteria = kwargs.get("stopping_criteria")
                if stopping_criteria is not None:
                    self.active_stopping_criteria = stopping_criteria

                self.evaluations.append(("start", label))
                if waits is not None and label in waits:
                    entered, release = waits[label]
                    if isinstance(entered, asyncio.Event):
                        # asyncio.Event cannot be awaited from the worker; the
                        # event loop was captured when the backend was built.
                        loop.call_soon_threadsafe(entered.set)
                    else:
                        entered.set()
                    if not release.wait(timeout=5):
                        raise TimeoutError("controlled generation did not release")
                if self.generation_error is not None:
                    raise self.generation_error
                if self.on_generation_step is not None:
                    self.on_generation_step()
                self.eval(label)
                self.sample(label)
                if stopping_criteria is not None:
                    input_ids = self._input_ids[:]
                    self.stopping_criteria_calls.append(tuple(input_ids))
                    self.evaluations.append(("criteria", tuple(input_ids)))
                    if stopping_criteria(input_ids, None):
                        return
                yield from (yield_values or {}).get(label, (label,))
                self.evaluations.append(("tail", label))
                if tail_waits is not None and label in tail_waits:
                    entered, release = tail_waits[label]
                    entered.set()
                    if not release.wait(timeout=5):
                        raise TimeoutError("controlled cache tail did not release")
            finally:
                self.iterator_close_calls += 1
                if self.on_iterator_close is not None:
                    self.on_iterator_close()

        def eval(self, label):
            self.evaluations.append(("eval", label))
            self._input_ids = [7, 8]

        def sample(self, label):
            self.evaluations.append(("sample", label))
            return 1

        def _create_completion(self, stream=False, **kwargs):
            if real_jinja_handler:
                stopping_criteria = kwargs.get("stopping_criteria")
                iterator = self.generate("completion", stopping_criteria=stopping_criteria)
                try:
                    if stream:
                        for token in iterator:
                            yield {
                                "id": "controlled",
                                "created": 1,
                                "model": "controlled",
                                "choices": [
                                    {
                                        "text": token,
                                        "logprobs": None,
                                        "finish_reason": None,
                                    }
                                ],
                            }
                    else:
                        yield {
                            "id": "controlled",
                            "created": 1,
                            "model": "controlled",
                            "choices": [
                                {
                                    "text": next(iterator),
                                    "logprobs": None,
                                    "finish_reason": "stop",
                                }
                            ],
                            "usage": {
                                "prompt_tokens": 2,
                                "completion_tokens": 1,
                                "total_tokens": 3,
                            },
                        }
                finally:
                    iterator.close()
                return
            iterator = self.generate("completion")
            try:
                if stream:
                    for token in iterator:
                        yield {"token": token}
                else:
                    yield {"token": next(iterator)}
            finally:
                iterator.close()

        def tokenize(self, prompt, *, add_bos, special):
            self.evaluations.append(("tokenize", prompt, add_bos, special))
            return [7, 8]

        def create_completion(self, stream=False, **kwargs):
            if real_jinja_handler:
                self.evaluations.append(("completion-options", kwargs.copy()))
                result = self._create_completion(stream=stream, **kwargs)
                return result if stream else next(result)
            iterator = self._create_completion(stream=stream)
            if stream:
                return iterator
            return next(iterator)

        def create_chat_completion(self, messages=None, stream=False, **kwargs):
            handler = self.chat_handler or handler_default
            result = handler(
                llama=self,
                messages=messages,
                stream=stream,
                **kwargs,
            )
            if real_jinja_handler:
                return result
            if stream and lazy_registry_handler:
                return result
            if stream and terminal_chat_stream:
                tokens = result

                def chat_chunks():
                    try:
                        for token in tokens:
                            yield {
                                "choices": [
                                    {
                                        "delta": {"content": token["token"]},
                                        "finish_reason": "stop",
                                    }
                                ]
                            }
                    finally:
                        close = getattr(tokens, "close", None)
                        if callable(close):
                            close()

                return chat_chunks()
            if stream and not terminal_chat_stream:
                return (token["token"] if isinstance(token, dict) else token for token in result)
            if not stream and isinstance(result, dict) and "choices" not in result:
                # The pinned chat handler converts the native completion DTO
                # into the OpenAI-compatible chat response consumed by Aurora.
                return _chat_response(result.get("token", "completion"))
            return result

        def close(self):
            self.close_calls += 1
            if self.on_close is not None:
                self.on_close()

    loop = (
        asyncio.get_running_loop()
        if waits is not None
        and any(isinstance(entered, asyncio.Event) for entered, _ in waits.values())
        else None
    )

    def synchronize(pointer):
        if synchronization_failure:
            raise RuntimeError("controlled synchronization failure")
        syncs.append(pointer)
        trace.append(("sync", pointer))

    low_level = SimpleNamespace(llama_synchronize=synchronize)
    low_level.__name__ = "llama_cpp.llama_cpp"
    llama_module = ModuleType("llama_cpp.llama")
    llama_module.Llama = FakeLlama
    llama_module.llama_cpp = low_level
    if real_jinja_handler:
        if monkeypatch is None:
            raise AssertionError("real Jinja fixture requires monkeypatch")
        monkeypatch.setattr(format_module, "llama", llama_module)
        llama_module.StoppingCriteriaList = importlib.import_module(
            "llama_cpp.llama"
        ).StoppingCriteriaList
    if no_close_completion:

        class NoCloseIterator:
            def __init__(self):
                self.returned = False

            def __iter__(self):
                return self

            def __next__(self):
                if self.returned:
                    raise StopIteration
                self.returned = True
                return {"token": "controlled"}

        def no_close_factory(self, stream=False, **kwargs):
            del self, stream, kwargs
            return NoCloseIterator()

        FakeLlama._create_completion = no_close_factory
    if registry_handler:
        registry = SimpleNamespace(_chat_handlers={"test-format": handler})
        format_module._test_registry = registry
        format_module.get_chat_completion_handler = lambda name: registry._chat_handlers[name]
    elif not real_jinja_handler:
        format_module.get_chat_completion_handler = lambda _name: handler
    backend = ModuleType("llama_cpp")
    backend.Llama = FakeLlama
    backend.llama = llama_module
    backend.llama_chat_format = format_module
    sys.modules.update(
        {
            "llama_cpp": backend,
            "llama_cpp.llama": llama_module,
            "llama_cpp.llama_cpp": low_level,
            "llama_cpp.llama_chat_format": format_module,
        }
    )
    owned_llama = make_owned_llama_class(backend)
    client = owned_llama()
    client.trace = trace
    return client, backend, syncs


@pytest.fixture(autouse=True)
def _restore_fake_llama_package_modules():
    names = (
        "llama_cpp",
        "llama_cpp.llama",
        "llama_cpp.llama_cpp",
        "llama_cpp.llama_chat_format",
    )
    previous = {name: sys.modules.get(name) for name in names}
    yield
    for name, module in previous.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module


def _binding(name: str) -> RequestBinding:
    return RequestBinding("trusted-test-owner", None, f"s-{name}", f"r-{name}", f"g-{name}")


def _chat_response(content: str) -> dict[str, object]:
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {},
    }


@pytest.mark.asyncio
async def test_two_queued_aliases_do_not_consume_single_worker_or_operation_slot(monkeypatch):
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(monkeypatch, waits={"first": (entered, release)})
    alias_one = SimpleNamespace(client=client)
    alias_two = SimpleNamespace(client=client)
    alias_three = SimpleNamespace(client=client)
    assert generation_for(alias_one) is generation_for(alias_two)
    assert canonical_native_owner(alias_one) is client
    assert canonical_native_owner(alias_two) is client

    async def infer(alias, label):
        return await run_native(alias, lambda: list(alias.client.generate(label)))

    loop = asyncio.get_running_loop()
    prior_executor = loop._default_executor
    from concurrent.futures import ThreadPoolExecutor

    from app.services.orchestrator import native_worker

    monkeypatch.setattr(native_worker, "MAX_PROVIDER_OPERATIONS", 1)
    single_worker = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(single_worker)
    first = asyncio.create_task(infer(alias_one, "first"))
    second = third = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        second = asyncio.create_task(infer(alias_two, "second"))
        third = asyncio.create_task(infer(alias_three, "third"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert client.generate_calls == 1
        generation = generation_for(client)
        assert generation is not None
        assert len(generation._gate.waiters) == 2
        assert retirement_blocked(alias_one) is True
        lifecycle = native_worker._get_lifecycle(client, loop, create=False)
        assert len(lifecycle.operations) == 1

        release.set()
        assert await asyncio.wait_for(first, timeout=3) == ["first"]
        assert await asyncio.wait_for(second, timeout=3) == ["second"]
        assert await asyncio.wait_for(third, timeout=3) == ["third"]
        assert [item for item in client.evaluations if item[0] == "start"] == [
            ("start", "first"),
            ("start", "second"),
            ("start", "third"),
        ]
        assert syncs == [client.ctx, client.ctx, client.ctx]
        assert retirement_blocked(alias_one) is False
    finally:
        release.set()
        for queued in (second, third):
            if queued is not None and not queued.done():
                await asyncio.gather(queued, return_exceptions=True)
        if not first.done():
            await asyncio.gather(first, return_exceptions=True)
        if prior_executor is None:
            loop._default_executor = None
        else:
            loop.set_default_executor(prior_executor)
        single_worker.shutdown(wait=True)


@pytest.mark.asyncio
async def test_stopped_request_rejects_copied_context_without_starting_child():
    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("stale"))

    with bind_request_group(group):
        async with native_context(client):
            iterator = await run_native(client, lambda: client.generate("accepted"))
            copied = contextvars.copy_context()
            group.begin_stop()
            copied_attempt = copied.run(
                asyncio.create_task,
                run_native(client, lambda: next(iterator)),
            )
            with pytest.raises(ProviderUnavailableError):
                await copied_attempt
            # The enclosing native context owns the accepted child and closes
            # it during its checked exit. Do not use a copied-context worker
            # call as a substitute cleanup authority.

    result = await group.stop_and_wait(timeout=2)
    assert result.status is RequestCompletionStatus.COMPLETE
    assert result.stopped is True
    assert result.cache_tail_completed is False
    assert client.generate_calls == 0
    assert client.evaluations == []
    assert syncs == [client.ctx]
    assert retirement_blocked(client) is False


@pytest.mark.asyncio
async def test_inherited_context_lease_rejects_a_different_client():
    client_a, backend, syncs_a = _backend()
    from app.services.orchestrator.llama_context_owner import make_owned_llama_class

    client_b = make_owned_llama_class(backend)()
    syncs_b = syncs_a
    group = create_request_group(_binding("different-client-lease"))

    with bind_request_group(group):
        async with native_context(client_a):
            with pytest.raises(NativeContextUnavailableError):
                client_b.generate("wrong-client")
            assert client_b.generate_calls == 0

    result = await group.complete_and_wait(timeout=2)
    assert result.status is RequestCompletionStatus.COMPLETE
    assert result.cache_tail_completed is False
    assert client_a.generate_calls == 0
    assert client_b.generate_calls == 0
    assert syncs_a == []
    assert syncs_b == []


@pytest.mark.asyncio
async def test_stopping_one_group_does_not_close_shared_client_or_other_group():
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"group-b-active": (entered, release)})
    alias_a = SimpleNamespace(client=client)
    alias_b = SimpleNamespace(client=client)
    group_a = create_request_group(_binding("a"))
    group_b = create_request_group(_binding("b"))

    async def infer(group, alias, label):
        with bind_request_group(group):
            return await run_native(alias, lambda: list(alias.client.generate(label)))

    assert await infer(group_a, alias_a, "group-a") == ["group-a"]
    # Stop group A while the second group owns the context through an alias.
    second = asyncio.create_task(infer(group_b, alias_b, "group-b-active"))
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        group_a.begin_stop()
        assert group_b.is_open
        assert client.generate_calls == 2
        release.set()
        assert await asyncio.wait_for(second, timeout=3) == ["group-b-active"]
    finally:
        release.set()
        if not second.done():
            await asyncio.gather(second, return_exceptions=True)

    result_a, result_b = await asyncio.gather(
        group_a.stop_and_wait(timeout=2), group_b.complete_and_wait(timeout=2)
    )
    assert result_a.status is RequestCompletionStatus.COMPLETE
    assert result_a.stopped is True
    assert result_b.status is RequestCompletionStatus.COMPLETE
    assert result_b.stopped is False
    assert len(syncs) == 2


@pytest.mark.asyncio
async def test_direct_registered_client_close_cannot_bypass_active_alias_retirement():
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, _syncs = _backend(waits={"active-close-guard": (entered, release)})
    alias = SimpleNamespace(client=client)
    task = asyncio.create_task(
        run_native(alias, lambda: list(alias.client.generate("active-close-guard")))
    )
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        with pytest.raises(NativeContextUnavailableError):
            client.close()
        assert client.close_calls == 0
        release.set()
        assert await asyncio.wait_for(task, timeout=3) == ["active-close-guard"]
        result = await asyncio.wait_for(retire_native(alias, close_target=client), timeout=3)
        assert result.status.value == "complete"
        assert client.close_calls == 1
    finally:
        release.set()
        if not task.done():
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_registered_retirement_rejects_unrelated_close_target():
    client, _backend_value, _syncs = _backend()
    unrelated, _other_backend, _other_syncs = _backend()

    result = await retire_native(client, close_target=unrelated, timeout=2)

    assert result.status.value == "unknown"
    assert client.close_calls == 0
    assert unrelated.close_calls == 0
    assert retirement_blocked(client) is True


def test_iterator_close_callback_cannot_start_another_native_iterator():
    client, _backend_value, syncs = _backend()
    rejected = []

    def close_callback():
        try:
            client.generate("iterator-close-callback")
        except NativeContextUnavailableError:
            rejected.append(True)

    iterator = client.generate("close-callback")
    client.on_iterator_close = close_callback
    assert next(iterator) == "close-callback"
    iterator.close()

    assert rejected == [True]
    assert client.generate_calls == 1
    assert syncs == [client.ctx]


def test_iterator_close_callback_cannot_join_its_own_finalizer():
    client, _backend_value, syncs = _backend()
    finalizing = client.generate("self-close")
    owned = finalizing.iterator
    rejected = []

    def close_callback():
        try:
            owned.close()
        except NativeContextUnavailableError:
            rejected.append(True)

    client.on_iterator_close = close_callback
    assert next(finalizing) == "self-close"
    with pytest.raises(NativeContextUnavailableError):
        finalizing.close()

    assert rejected == [True]
    assert syncs == []


def test_concurrent_duplicate_iterator_close_joins_one_checked_finalizer():
    entered = threading.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend()
    finalizing = client.generate("duplicate-close")
    assert next(finalizing) == "duplicate-close"
    close_errors = []
    first_finished = threading.Event()
    second_finished = threading.Event()

    def close_callback():
        entered.set()
        if not release.wait(timeout=2):
            raise RuntimeError("close latch timed out")

    client.on_iterator_close = close_callback

    def close(finished):
        try:
            finalizing.close()
        except BaseException as error:
            close_errors.append(error)
        finally:
            finished.set()

    first = threading.Thread(target=close, args=(first_finished,))
    second = threading.Thread(target=close, args=(second_finished,))
    first.start()
    assert entered.wait(timeout=2)
    second.start()
    assert not second_finished.wait(timeout=0.05)
    release.set()
    first.join(timeout=3)
    second.join(timeout=3)

    assert not first.is_alive()
    assert not second.is_alive()
    assert first_finished.is_set() and second_finished.is_set()
    assert close_errors == []
    assert syncs == [client.ctx]


def test_duplicate_lease_finalizer_waits_outside_its_ownership_lock():
    from app.services.orchestrator.llama_context_owner import _IteratorRecord

    entered = threading.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    lease = generation._gate.acquire_sync(generation)
    lease.started = True
    lease.inference_seen = True
    close_calls = []

    class BlockingClose:
        def close(self):
            close_calls.append(True)
            entered.set()
            if not release.wait(timeout=3):
                raise TimeoutError("lease finalizer latch timed out")

    lease.children.append(_IteratorRecord(lease, BlockingClose()))
    errors = []
    first_done = threading.Event()
    second_done = threading.Event()

    def finish(done):
        try:
            lease.finish_sync()
        except BaseException as error:
            errors.append(error)
        finally:
            done.set()

    first = threading.Thread(target=finish, args=(first_done,))
    second = threading.Thread(target=finish, args=(second_done,))
    first.start()
    assert entered.wait(timeout=2)

    loop_errors = []

    async def finish_from_loop():
        try:
            lease.finish_sync()
        except BaseException as error:
            loop_errors.append(error)

    loop_observer = threading.Thread(target=lambda: asyncio.run(finish_from_loop()))
    loop_observer.start()
    loop_observer.join(timeout=1)
    assert not loop_observer.is_alive()
    assert len(loop_errors) == 1
    assert isinstance(loop_errors[0], NativeContextUnavailableError)
    assert lease.unknown is False

    second.start()
    assert not second_done.wait(timeout=0.05)
    release.set()
    first.join(timeout=3)
    second.join(timeout=3)

    assert not first.is_alive()
    assert not second.is_alive()
    assert first_done.is_set() and second_done.is_set()
    assert errors == []
    assert close_calls == [True]
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_provider_close_callback_cannot_start_another_native_iterator():
    client, _backend_value, syncs = _backend()
    assert await asyncio.to_thread(lambda: list(client.generate("before-provider-close"))) == [
        "before-provider-close"
    ]
    rejected = []

    def close_callback():
        try:
            client.generate("provider-close-callback")
        except NativeContextUnavailableError:
            rejected.append(True)

    client.on_close = close_callback
    result = await retire_native(client, timeout=2)

    assert result.status.value == "complete"
    assert rejected == [True]
    assert client.generate_calls == 1
    assert client.close_calls == 1
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_stopping_queued_group_records_native_work_as_not_submitted():
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"active": (entered, release)})
    alias = SimpleNamespace(client=client)
    group = create_request_group(_binding("queued-stop"))

    async def active_inference():
        return await run_native(alias, lambda: list(alias.client.generate("active")))

    async def queued_inference():
        with bind_request_group(group):
            return await run_native(alias, lambda: list(alias.client.generate("queued")))

    active = asyncio.create_task(active_inference())
    queued = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        queued = asyncio.create_task(queued_inference())
        for _ in range(20):
            generation = generation_for(client)
            if generation is not None and generation._gate.waiters:
                break
            await asyncio.sleep(0)
        assert generation is not None and len(generation._gate.waiters) == 1
        group.begin_stop()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(queued, timeout=2)
        result = await group.stop_and_wait(timeout=1)
        assert result.status is RequestCompletionStatus.COMPLETE
        assert result.stopped is True
        assert client.generate_calls == 1
        release.set()
        assert await asyncio.wait_for(active, timeout=3) == ["active"]
        assert syncs == [client.ctx]
    finally:
        release.set()
        for task in (active, queued):
            if task is not None and not task.done():
                await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_stop_after_gate_grant_before_waiter_delivery_is_not_submitted(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"active": (entered, release)})
    alias = SimpleNamespace(client=client)
    group = create_request_group(_binding("grant-delivery-stop"))

    async def active_inference():
        return await run_native(alias, lambda: list(alias.client.generate("active")))

    async def queued_inference():
        with bind_request_group(group):
            return await run_native(alias, lambda: list(alias.client.generate("must-not-start")))

    active = asyncio.create_task(active_inference())
    queued = None
    original_setter = llama_context_owner._set_waiter_result

    def stop_before_delivery(waiter, lease):
        if waiter.member is not None and waiter.member.group is group:
            group.begin_stop()
        original_setter(waiter, lease)

    monkeypatch.setattr(llama_context_owner, "_set_waiter_result", stop_before_delivery)
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        queued = asyncio.create_task(queued_inference())
        generation = generation_for(client)
        assert generation is not None
        for _ in range(50):
            if generation._gate.waiters:
                break
            await asyncio.sleep(0)
        assert len(generation._gate.waiters) == 1
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(queued, timeout=3)
        active_result = await asyncio.wait_for(active, timeout=3)
        stopped = await asyncio.wait_for(group.stop_and_wait(timeout=2), timeout=3)
        assert active_result == ["active"]
        assert stopped.status is RequestCompletionStatus.COMPLETE
        assert stopped.stopped is True
        assert client.generate_calls == 1
        assert syncs == [client.ctx]
    finally:
        release.set()
        for task in (active, queued):
            if task is not None and not task.done():
                await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_retirement_revokes_unstarted_context_before_native_entry():
    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("unstarted-retirement"))
    context_acquired = asyncio.Event()
    continue_context = asyncio.Event()

    async def request():
        with bind_request_group(group):
            async with native_context(client):
                context_acquired.set()
                await continue_context.wait()
                with pytest.raises(NativeContextUnavailableError):
                    client.generate("must-not-start")
                group.begin_stop()

    pending = asyncio.create_task(request())
    try:
        await asyncio.wait_for(context_acquired.wait(), timeout=2)
        generation = generation_for(client)
        assert generation is not None and generation._gate.owner is not None
        assert generation._gate.owner.started is False

        retirement = await asyncio.wait_for(retire_native(client, close_target=client), timeout=2)
        assert retirement.status.value == "complete"
        assert client.close_calls == 1
        assert generation._gate.owner is None
        continue_context.set()
        await asyncio.wait_for(pending, timeout=2)
        result = await asyncio.wait_for(group.stop_and_wait(timeout=2), timeout=3)
        assert result.status is RequestCompletionStatus.COMPLETE
        assert result.stopped is True
        assert client.generate_calls == 0
        assert syncs == []
    finally:
        continue_context.set()
        if not pending.done():
            await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_idle_alias_retirement_waits_for_active_alias_and_closes_once():
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"active": (entered, release)})
    idle_alias = SimpleNamespace(client=client)
    active_alias = SimpleNamespace(client=client)
    other_alias = SimpleNamespace(client=client)

    async def infer():
        return await run_native(active_alias, lambda: list(active_alias.client.generate("active")))

    active = asyncio.create_task(infer())
    queued = None
    retirement_one = retirement_two = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        queued = asyncio.create_task(
            run_native(idle_alias, lambda: list(idle_alias.client.generate("queued")))
        )
        for _ in range(20):
            generation = generation_for(client)
            if generation is not None and generation._gate.waiters:
                break
            await asyncio.sleep(0)
        assert generation is not None
        assert len(generation._gate.waiters) == 1
        retirement_one = asyncio.create_task(retire_native(idle_alias, close_target=client))
        retirement_two = asyncio.create_task(retire_native(other_alias, close_target=client))
        for _ in range(20):
            generation = generation_for(client)
            if generation is not None and generation._gate.retiring:
                break
            await asyncio.sleep(0)
        assert generation is not None and generation._gate.retiring is True
        assert retirement_blocked(active_alias) is True
        assert client.close_calls == 0
        with pytest.raises(NativeContextUnavailableError):
            await asyncio.wait_for(queued, timeout=2)
        assert client.generate_calls == 1
        with pytest.raises(NativeContextUnavailableError):
            client.generate("after-retirement")
        assert client.generate_calls == 1
        release.set()
        assert await asyncio.wait_for(active, timeout=3) == ["active"]
        first_result, second_result = await asyncio.wait_for(
            asyncio.gather(retirement_one, retirement_two), timeout=3
        )
        assert first_result.status.value == "complete"
        assert second_result is first_result
        assert client.close_calls == 1
        assert syncs == [client.ctx]
    finally:
        release.set()
        for task in (active, queued, retirement_one, retirement_two):
            if task is not None and not task.done():
                await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_retirement_deadline_remains_sticky_after_prior_iterator_close_failure():
    from app.services.orchestrator.native_worker import _get_lifecycle

    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("prior-iterator-close-failure"))
    native_iterators = []
    outer_iterators = []
    outer_close_calls = []
    native_close_calls = []

    class FailingOuterIterator:
        def __init__(self, native_iterator):
            self.native_iterator = native_iterator
            self.closed = False

        def __iter__(self):
            return self

        def __next__(self):
            return next(self.native_iterator)

        def close(self):
            if self.closed:
                return
            self.closed = True
            outer_close_calls.append("entered")
            self.native_iterator.close()
            outer_close_calls.append("native-closed")
            raise RuntimeError("controlled outer iterator cleanup failure")

    def record_native_close():
        native_close_calls.append("closed")

    def iterator_factory():
        native_iterator = client.generate("prior-close-failure")
        native_iterators.append(native_iterator)
        outer_iterator = FailingOuterIterator(native_iterator)
        outer_iterators.append(outer_iterator)
        return outer_iterator

    client.on_iterator_close = record_native_close
    with bind_request_group(group):
        stream = stream_native(client, iterator_factory)
        values = [value async for value in stream]
    assert values == ["prior-close-failure"]
    assert len(outer_iterators) == 1
    assert outer_close_calls == ["entered", "native-closed"]
    assert native_close_calls == ["closed"]
    assert client.generate_calls == 1
    assert len(native_iterators) == 1
    native_record = native_iterators[0]._record
    assert native_record.exhausted is True
    assert native_record.close_checked is True
    assert native_record.close_failed is False
    assert client.evaluations[-3:] == [
        ("eval", "prior-close-failure"),
        ("sample", "prior-close-failure"),
        ("tail", "prior-close-failure"),
    ]
    assert syncs == [client.ctx]
    lifecycle = _get_lifecycle(client, asyncio.get_running_loop(), create=False)
    assert lifecycle is not None
    with lifecycle.lock:
        assert lifecycle.failure == "iterator_close_failed"
        assert lifecycle.uncertain is False
        assert lifecycle.streams == {}
        assert lifecycle.operations == {}
    generation = generation_for(client)
    assert generation is not None
    with generation._gate.lock:
        assert generation._gate.quarantined is False

    close_entered = asyncio.Event()
    release_close = threading.Event()
    loop = asyncio.get_running_loop()

    def blocked_provider_close():
        loop.call_soon_threadsafe(close_entered.set)
        if not release_close.wait(timeout=3):
            raise TimeoutError("provider close latch did not release")

    client.on_close = blocked_provider_close
    owner_observer = None
    try:
        owner_observer = asyncio.create_task(retire_native(client))
        await asyncio.wait_for(close_entered.wait(), timeout=2)
        with lifecycle.lock:
            retained_owner = lifecycle.retirement_owner
            retained_target = lifecycle.retirement_close_target
            retirement_task = lifecycle.retirement_task
        assert retained_owner is client
        assert retained_target is client
        assert retirement_task is not None and not retirement_task.done()
        first = await retire_native(client, timeout=0.02)
        assert first.status is RetirementStatus.DEADLINE_EXCEEDED
        assert first.failure == "iterator_close_failed"
        with lifecycle.lock:
            assert lifecycle.retirement_task is retirement_task
            assert lifecycle.retirement_owner is client
            assert lifecycle.retirement_close_target is client
        assert client.close_calls == 1
        release_close.set()
        owner_result = await asyncio.wait_for(owner_observer, timeout=3)
        assert owner_result is first
        with lifecycle.lock:
            assert lifecycle.terminal_result is first
            assert lifecycle.retirement_task is retirement_task
            assert retirement_task.done()
            assert lifecycle.retirement_owner is None
            assert lifecycle.retirement_close_target is None
            assert lifecycle.operations == {}
            assert lifecycle.streams == {}
            assert lifecycle.progress_credits == {}
            assert lifecycle.direct_operations == 0
            assert lifecycle.progress_reservations == 0
            assert lifecycle.cleanup_reservations == 0
            assert any(
                reference is outer_iterators[0] for reference in lifecycle.cleanup_references
            )
        with generation._gate.lock:
            assert generation._gate.retiring is True
            assert generation._gate.owner is None
            assert not generation._gate.waiters
            assert generation._gate.quarantined is False
        later = await retire_native(client, timeout=3)
        assert later is first
        assert client.close_calls == 1
    finally:
        release_close.set()
        if owner_observer is not None and not owner_observer.done():
            pending = (await asyncio.wait((owner_observer,), timeout=1))[1]
            if pending:
                _unsettled_native_test_workers.append((owner_observer, lifecycle, release_close))
        with lifecycle.lock:
            task = lifecycle.retirement_task
        if task is not None and not task.done():
            pending = (await asyncio.wait((task,), timeout=1))[1]
            if pending:
                _unsettled_native_test_workers.append((task, lifecycle, release_close))
    group_result = await group.complete_and_wait(timeout=2)
    assert group_result.status is RequestCompletionStatus.FAILED
    assert group_result.reason == "iterator_close_failed"


@pytest.mark.asyncio
async def test_stream_native_keeps_group_and_context_until_true_iterator_exhaustion():
    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("stream"))
    values = []

    with bind_request_group(group):
        async for value in stream_native(
            SimpleNamespace(client=client),
            lambda: client.generate("stream"),
        ):
            values.append(value)

    result = await group.stop_and_wait(timeout=2)
    assert values == ["stream"]
    assert ("tail", "stream") in client.evaluations
    assert syncs == [client.ctx]
    assert result.status is RequestCompletionStatus.COMPLETE
    assert result.stopped is True
    assert result.cache_tail_completed is True


@pytest.mark.asyncio
async def test_stream_stop_waits_for_blocked_cache_tail_before_context_sync():
    tail_entered = threading.Event()
    release_tail = threading.Event()
    client, _backend_value, syncs = _backend(
        tail_waits={"completion": (tail_entered, release_tail)},
        terminal_chat_stream=True,
    )
    group = create_request_group(_binding("tail-stop"))
    stream = None
    try:
        with bind_request_group(group):
            stream = stream_native(
                SimpleNamespace(client=client),
                lambda: client.create_chat_completion(stream=True),
            )
            first_chunk = await asyncio.wait_for(anext(stream), timeout=2)
            assert first_chunk["choices"][0]["finish_reason"] == "stop"
            # Advancing once more reaches the actual tracked native tail. It is
            # deliberately still running when the request closes admission.
            await asyncio.wait_for(asyncio.to_thread(tail_entered.wait, 2), timeout=3)
            group.begin_stop()
            assert syncs == []
    finally:
        release_tail.set()
        if stream is not None:
            with suppress(asyncio.CancelledError, NativeContextUnavailableError):
                await asyncio.wait_for(stream.aclose(), timeout=3)

    result = await group.stop_and_wait(timeout=3)
    assert result.status is RequestCompletionStatus.COMPLETE
    assert result.stopped is True
    assert result.cache_tail_completed is True
    assert ("tail", "completion") in client.evaluations
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_active_stream_reserves_progress_before_queued_alias_handoff(monkeypatch):
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"owner-stream": (entered, release)})
    alias = SimpleNamespace(client=client)
    from concurrent.futures import ThreadPoolExecutor

    from app.services.orchestrator import native_worker

    loop = asyncio.get_running_loop()
    old_executor = loop._default_executor
    one_worker = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(one_worker)
    monkeypatch.setattr(native_worker, "MAX_PROVIDER_OPERATIONS", 1)

    async def collect():
        result = []
        async for value in stream_native(alias, lambda: client.generate("owner-stream")):
            result.append(value)
        return result

    active = asyncio.create_task(collect())
    successor = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        successor = asyncio.create_task(
            run_native(alias, lambda: list(client.generate("successor")))
        )
        for _ in range(50):
            generation = generation_for(client)
            if generation is not None and generation._gate.waiters:
                break
            await asyncio.sleep(0)
        generation = generation_for(client)
        assert generation is not None and len(generation._gate.waiters) == 1
        lifecycle = native_worker._lifecycles[id(client)]
        with lifecycle.lock:
            assert len(lifecycle.operations) == native_worker.MAX_PROVIDER_OPERATIONS == 1
            assert any(
                operation.state.value == "body_running"
                for operation in lifecycle.operations.values()
            )
        assert not active.done()
        assert not successor.done()

        release.set()
        assert await asyncio.wait_for(active, timeout=3) == ["owner-stream"]
        assert await asyncio.wait_for(successor, timeout=3) == ["successor"]
        assert syncs == [client.ctx, client.ctx]
        assert client.generate_calls == 2
        assert client.trace.index(("sync", client.ctx)) < client.trace.index(
            ("factory", "successor")
        )
    finally:
        release.set()
        for task in (active, successor):
            if task is not None and not task.done():
                await asyncio.gather(task, return_exceptions=True)
        if old_executor is None:
            loop._default_executor = None
        else:
            loop.set_default_executor(old_executor)
        one_worker.shutdown(wait=True)


@pytest.mark.asyncio
async def test_queued_known_stream_waits_for_context_before_operation_reservation(monkeypatch):
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"first-stream": (entered, release)})
    alias = SimpleNamespace(client=client)
    from concurrent.futures import ThreadPoolExecutor

    from app.services.orchestrator import native_worker

    loop = asyncio.get_running_loop()
    old_executor = loop._default_executor
    one_worker = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(one_worker)
    monkeypatch.setattr(native_worker, "MAX_PROVIDER_OPERATIONS", 1)

    async def collect(label):
        return [value async for value in stream_native(alias, lambda: client.generate(label))]

    first = asyncio.create_task(collect("first-stream"))
    successor = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        successor = asyncio.create_task(collect("queued-stream"))
        for _ in range(50):
            generation = generation_for(client)
            if generation is not None and generation._gate.waiters:
                break
            await asyncio.sleep(0)
        generation = generation_for(client)
        assert generation is not None and len(generation._gate.waiters) == 1
        lifecycle = native_worker._lifecycles[id(client)]
        with lifecycle.lock:
            assert len(lifecycle.operations) == 1
            assert lifecycle.progress_reservations == 0
            assert len(lifecycle.streams) == 2
        assert not first.done()
        assert not successor.done()

        release.set()
        assert await asyncio.wait_for(first, timeout=3) == ["first-stream"]
        assert await asyncio.wait_for(successor, timeout=3) == ["queued-stream"]
        assert syncs == [client.ctx, client.ctx]
        assert client.generate_calls == 2
    finally:
        release.set()
        for task in (first, successor):
            if task is not None and not task.done():
                await asyncio.gather(task, return_exceptions=True)
        if old_executor is None:
            loop._default_executor = None
        else:
            loop.set_default_executor(old_executor)
        one_worker.shutdown(wait=True)


@pytest.mark.asyncio
async def test_context_successor_waits_for_actual_runner_worker_return(monkeypatch):
    client, _backend_value, syncs = _backend()
    from app.services.orchestrator import native_worker

    loop = asyncio.get_running_loop()
    diagnostic_context = contextvars.ContextVar("test_unrelated_native_context")
    diagnostic_values = []
    diagnostic_token = diagnostic_context.set("caller-context-retained")
    client.on_generation_step = lambda: diagnostic_values.append(diagnostic_context.get(None))
    sync_body_returned = asyncio.Event()
    release_runner = threading.Event()
    runner_thread_ids = set()
    original_run_body = native_worker._run_body

    def hold_after_sync_body(operation, function, args, kwargs):
        original_run_body(operation, function, args, kwargs)
        runner_thread_ids.add(threading.get_ident())
        if function.__name__ == "_finish_lease_on_worker":
            loop.call_soon_threadsafe(sync_body_returned.set)
            if not release_runner.wait(timeout=5):
                raise TimeoutError("controlled runner return did not release")

    monkeypatch.setattr(native_worker, "_run_body", hold_after_sync_body)
    alias = SimpleNamespace(client=client)

    async def first_owner():
        async with native_context(client):
            return await run_native(alias, lambda: list(client.generate("first")))

    first = asyncio.create_task(first_owner())
    successor = None
    try:
        await asyncio.wait_for(sync_body_returned.wait(), timeout=2)
        successor = asyncio.create_task(
            run_native(alias, lambda: list(client.generate("successor")))
        )
        generation = generation_for(client)
        assert generation is not None
        for _ in range(50):
            if generation._gate.waiters:
                break
            await asyncio.sleep(0)
        assert len(generation._gate.waiters) == 1
        assert not first.done()
        assert not successor.done()
        assert syncs == [client.ctx]

        release_runner.set()
        assert await asyncio.wait_for(first, timeout=3) == ["first"]
        assert await asyncio.wait_for(successor, timeout=3) == ["successor"]
        assert syncs == [client.ctx, client.ctx]
        assert len(runner_thread_ids) == 1
        assert diagnostic_values == ["caller-context-retained"] * 2
    finally:
        release_runner.set()
        for task in (first, successor):
            if task is not None and not task.done():
                await asyncio.gather(task, return_exceptions=True)
        diagnostic_context.reset(diagnostic_token)


@pytest.mark.asyncio
async def test_context_waiters_do_not_consume_workers_or_operation_slots(monkeypatch):
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"active-stream": (entered, release)})
    from concurrent.futures import ThreadPoolExecutor

    from app.services.orchestrator import native_worker

    loop = asyncio.get_running_loop()
    old_executor = loop._default_executor
    one_worker = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(one_worker)
    monkeypatch.setattr(native_worker, "MAX_PROVIDER_OPERATIONS", 1)
    alias = SimpleNamespace(client=client)

    async def infer(label):
        return await run_native(alias, lambda: list(client.generate(label)))

    async def collect_active_stream():
        return [
            value async for value in stream_native(alias, lambda: client.generate("active-stream"))
        ]

    active = asyncio.create_task(collect_active_stream())
    waiters = []
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        waiters = [asyncio.create_task(infer(f"queued-{index}")) for index in range(3)]
        generation = generation_for(client)
        assert generation is not None
        for _ in range(100):
            if len(generation._gate.waiters) == len(waiters):
                break
            await asyncio.sleep(0)
        assert len(generation._gate.waiters) == len(waiters)
        lifecycle = native_worker._lifecycles[id(client)]
        with lifecycle.lock:
            assert len(lifecycle.operations) == 1
            assert lifecycle.progress_reservations == 0
            runner = next(iter(lifecycle.operations.values())).runner
            assert runner is not None and runner.worker_returned.is_set() is False
        assert one_worker._work_queue.qsize() == 0
        assert not active.done()
        assert all(not waiter.done() for waiter in waiters)

        release.set()
        assert await asyncio.wait_for(active, timeout=3) == ["active-stream"]
        results = await asyncio.wait_for(asyncio.gather(*waiters), timeout=5)
        assert results == [[f"queued-{index}"] for index in range(3)]
        assert syncs == [client.ctx] * 4
        assert client.generate_calls == 4
        assert client.trace.index(("sync", client.ctx)) < client.trace.index(
            ("factory", "queued-0")
        )
    finally:
        release.set()
        if not active.done():
            await asyncio.gather(active, return_exceptions=True)
        for task in waiters:
            if not task.done():
                await asyncio.gather(task, return_exceptions=True)
        if old_executor is None:
            loop._default_executor = None
        else:
            loop.set_default_executor(old_executor)
        one_worker.shutdown(wait=True)


@pytest.mark.asyncio
async def test_cancelled_finite_callable_settles_before_context_successor(
    monkeypatch: pytest.MonkeyPatch,
):
    from concurrent.futures import ThreadPoolExecutor

    from app.services.orchestrator import native_worker

    client, _backend_value, syncs = _backend()
    loop = asyncio.get_running_loop()
    old_executor = loop._default_executor
    one_worker = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(one_worker)
    entered = asyncio.Event()
    release = threading.Event()
    first_group = create_request_group(_binding("cancel-finite-active"))
    second_group = create_request_group(_binding("cancel-finite-successor"))

    def finite_callable():
        loop.call_soon_threadsafe(entered.set)
        if not release.wait(timeout=4):
            raise TimeoutError("finite callable latch timed out")
        return list(client.generate("finite-after-cancel"))

    async def run_first():
        with bind_request_group(first_group):
            return await run_native(client, finite_callable)

    async def run_second():
        with bind_request_group(second_group):
            return await run_native(client, lambda: list(client.generate("successor")))

    first = asyncio.create_task(run_first())
    second = None
    first_completion = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        second = asyncio.create_task(run_second())
        generation = generation_for(client)
        for _ in range(50):
            if generation is not None and generation._gate.waiters:
                break
            await asyncio.sleep(0)
        assert generation is not None
        assert len(generation._gate.waiters) == 1
        lifecycle = native_worker._get_lifecycle(client, loop, create=False)
        assert lifecycle is not None
        assert len(lifecycle.operations) == 1
        operation = next(iter(lifecycle.operations.values()))
        assert operation.state.value == "body_running"
        assert not operation.worker_returned.is_set()
        first_completion = asyncio.create_task(first_group.complete_and_wait(timeout=2))

        first.cancel()
        await asyncio.sleep(0)
        assert not first.done()
        assert not second.done()
        assert not first_completion.done()
        assert generation._gate.owner is not None
        assert syncs == []

        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(first, timeout=4)
        assert operation.worker_returned.is_set()
        assert await asyncio.wait_for(second, timeout=4) == ["successor"]
        first_result, second_result = await asyncio.gather(
            first_completion,
            second_group.complete_and_wait(timeout=1),
        )

        assert first_result.status is not RequestCompletionStatus.UNKNOWN
        assert second_result.status is RequestCompletionStatus.COMPLETE
        assert client.generate_calls == 2
        assert syncs == [client.ctx, client.ctx]
        assert retirement_blocked(client) is False
    finally:
        release.set()
        for task in (first, second, first_completion):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (first, second, first_completion) if task is not None),
            return_exceptions=True,
        )
        if old_executor is None:
            loop._default_executor = None
        else:
            loop.set_default_executor(old_executor)
        one_worker.shutdown(wait=True)


def test_raw_iterator_close_waits_for_the_active_next_to_settle():
    entered = threading.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"racing-next": (entered, release)})
    finalizing = client.generate("racing-next")
    owned = finalizing.iterator
    next_result = []
    next_error = []
    close_error = []
    next_finished = threading.Event()
    close_started = threading.Event()

    def advance():
        try:
            next_result.append(next(owned))
        except BaseException as error:
            next_error.append(error)
        finally:
            next_finished.set()

    def close():
        close_started.set()
        try:
            finalizing.close()
        except BaseException as error:
            close_error.append(error)

    advancing_thread = threading.Thread(target=advance)
    closing_thread = threading.Thread(target=close)
    advancing_thread.start()
    assert entered.wait(timeout=2)
    closing_thread.start()
    assert close_started.wait(timeout=2)
    assert not next_finished.wait(timeout=0.05)
    assert not owned._record.close_checked

    release.set()
    advancing_thread.join(timeout=2)
    closing_thread.join(timeout=3)
    assert not advancing_thread.is_alive()
    assert not closing_thread.is_alive()
    assert next_result == ["racing-next"]
    assert next_error == []
    assert close_error == []
    assert owned._record.close_checked
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_stream_consumer_yields_without_native_tokens_across_task_close():
    tail_entered = threading.Event()
    release_tail = threading.Event()
    client, _backend_value, syncs = _backend(
        tail_waits={"completion": (tail_entered, release_tail)},
        terminal_chat_stream=True,
    )
    group = create_request_group(_binding("yield-context"))
    stream = None
    try:
        with bind_request_group(group):
            stream = stream_native(
                SimpleNamespace(client=client),
                lambda: client.create_chat_completion(stream=True),
            )
            first = await asyncio.wait_for(anext(stream), timeout=2)
            from app.services.orchestrator.llama_context_owner import _current_lease

            assert _current_lease.get() is None
            assert current_request_member() is None
            assert first["choices"][0]["finish_reason"] == "stop"
            await asyncio.wait_for(asyncio.to_thread(tail_entered.wait, 2), timeout=3)
        close = asyncio.create_task(stream.aclose())
        await asyncio.sleep(0)
        assert not close.done()
        release_tail.set()
        await asyncio.wait_for(close, timeout=3)
    finally:
        release_tail.set()
        if stream is not None:
            with suppress(asyncio.CancelledError, NativeContextUnavailableError):
                await asyncio.wait_for(stream.aclose(), timeout=3)

    result = await group.complete_and_wait(timeout=3)
    assert result.status is RequestCompletionStatus.COMPLETE
    assert result.stopped is True
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_stopping_active_group_keeps_queued_independent_group_admitted():
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"active-a": (entered, release)})
    alias = SimpleNamespace(client=client)
    group_a = create_request_group(_binding("active-a"))
    group_b = create_request_group(_binding("queued-b"))

    async def infer(group, label):
        with bind_request_group(group):
            return await run_native(alias, lambda: list(client.generate(label)))

    active_a = asyncio.create_task(infer(group_a, "active-a"))
    queued_b = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        queued_b = asyncio.create_task(infer(group_b, "queued-b"))
        for _ in range(50):
            generation = generation_for(client)
            if generation is not None and generation._gate.waiters:
                break
            await asyncio.sleep(0)
        generation = generation_for(client)
        assert generation is not None and len(generation._gate.waiters) == 1
        group_a.begin_stop()
        assert group_b.is_open

        release.set()
        await asyncio.gather(active_a, return_exceptions=True)
        assert await asyncio.wait_for(queued_b, timeout=3) == ["queued-b"]
        result_a, result_b = await asyncio.gather(
            group_a.stop_and_wait(timeout=2), group_b.complete_and_wait(timeout=2)
        )
        assert result_a.status in (
            RequestCompletionStatus.COMPLETE,
            RequestCompletionStatus.UNKNOWN,
        )
        assert result_b.status is RequestCompletionStatus.COMPLETE
        assert client.close_calls == 0
        assert syncs
        assert client.trace.index(("sync", client.ctx)) < client.trace.index(
            ("factory", "queued-b")
        )
    finally:
        release.set()
        for task in (active_a, queued_b):
            if task is not None and not task.done():
                await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_sealing_group_preserves_its_already_queued_context_member():
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"active": (entered, release)})
    group_a = create_request_group(_binding("seal-active-a"))
    group_b = create_request_group(_binding("seal-queued-b"))

    async def infer(group, label):
        with bind_request_group(group):
            return await run_native(client, lambda: list(client.generate(label)))

    active = asyncio.create_task(infer(group_a, "active"))
    queued = None
    completion = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        queued = asyncio.create_task(infer(group_b, "queued"))
        for _ in range(50):
            generation = generation_for(client)
            if generation is not None and generation._gate.waiters:
                break
            await asyncio.sleep(0)
        generation = generation_for(client)
        assert generation is not None and len(generation._gate.waiters) == 1

        completion = asyncio.create_task(group_b.complete_and_wait(timeout=3))
        for _ in range(20):
            if not group_b.is_open:
                break
            await asyncio.sleep(0)
        assert not group_b.is_open

        release.set()
        assert await asyncio.wait_for(active, timeout=3) == ["active"]
        assert await asyncio.wait_for(queued, timeout=3) == ["queued"]
        result_b = await asyncio.wait_for(completion, timeout=3)
        result_a = await group_a.complete_and_wait(timeout=2)
        assert result_a.status is RequestCompletionStatus.COMPLETE
        assert result_b.status is RequestCompletionStatus.COMPLETE
        assert client.generate_calls == 2
        assert syncs == [client.ctx, client.ctx]
    finally:
        release.set()
        pending = {
            task for task in (active, queued, completion) if task is not None and not task.done()
        }
        if pending:
            done, pending = await asyncio.wait(pending, timeout=2)
            if pending:
                for task in pending:
                    task.cancel()
                _done, pending = await asyncio.wait(pending, timeout=1)
            if pending:
                _unsettled_native_test_workers.append((release, group_a, group_b, *done, *pending))


@pytest.mark.asyncio
async def test_retained_chat_child_cannot_resume_after_context_release():
    client, _backend_value, syncs = _backend()
    escaped = None

    async with native_context(client):
        escaped = await asyncio.to_thread(client.create_chat_completion, stream=True)
        # The pinned native generator is lazy: constructing the chat stream
        # owns it without executing its body.
        assert client.evaluations == []

    assert syncs == [client.ctx]
    with pytest.raises(StopIteration):
        next(escaped)
    assert client.evaluations == []
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_context_waiter_capacity_is_bounded_without_executor_waiters():
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, _syncs = _backend(waits={"active": (entered, release)})
    alias = SimpleNamespace(client=client)

    async def infer(label):
        return await run_native(alias, lambda: list(alias.client.generate(label)))

    active = asyncio.create_task(infer("active"))
    queued = []
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        queued = [
            asyncio.create_task(infer(f"queued-{index}")) for index in range(MAX_LLAMA_WAITERS)
        ]
        for _ in range(100):
            generation = generation_for(client)
            if generation is not None and len(generation._gate.waiters) == MAX_LLAMA_WAITERS:
                break
            await asyncio.sleep(0)
        generation = generation_for(client)
        assert generation is not None
        assert len(generation._gate.waiters) == MAX_LLAMA_WAITERS
        with pytest.raises(NativeContextUnavailableError):
            await infer("overflow")
        assert client.generate_calls == 1
        release.set()
        assert await asyncio.wait_for(active, timeout=3) == ["active"]
        results = await asyncio.wait_for(asyncio.gather(*queued), timeout=8)
        assert len(results) == MAX_LLAMA_WAITERS
        assert all(len(result) == 1 for result in results)
        assert client.generate_calls == MAX_LLAMA_WAITERS + 1
    finally:
        release.set()
        for task in [active, *queued]:
            if not task.done():
                task.cancel()
        await asyncio.gather(active, *queued, return_exceptions=True)


@pytest.mark.asyncio
async def test_known_context_rejects_use_from_a_different_event_loop():
    client, _backend_value, syncs = _backend()
    assert await run_native(client, lambda: list(client.generate("primary-loop"))) == [
        "primary-loop"
    ]
    result = []

    def run_on_other_loop():
        async def infer_elsewhere():
            return await run_native(client, lambda: list(client.generate("wrong-loop")))

        try:
            result.append(asyncio.run(infer_elsewhere()))
        except BaseException as error:
            result.append(error)

    thread = threading.Thread(target=run_on_other_loop)
    thread.start()
    await asyncio.to_thread(thread.join, 3)
    assert not thread.is_alive()
    assert len(result) == 1
    assert isinstance(result[0], NativeContextUnavailableError)
    assert client.generate_calls == 1
    assert syncs == [client.ctx]


def test_qualified_chat_completion_tracks_nested_native_children():
    client, _backend_value, syncs = _backend()

    assert list(client.create_chat_completion(stream=True)) == ["completion"]
    assert ("tail", "completion") in client.evaluations
    assert syncs == [client.ctx]
    assert retirement_blocked(client) is False


def test_package_registry_formatter_uses_selected_factory_provenance():
    client, _backend_value, syncs = _backend(registry_handler=True)
    generation = generation_for(client)

    assert generation is not None
    assert generation.handler_mode == "standard_formatter"
    assert list(client.create_chat_completion(stream=True)) == ["completion"]
    assert syncs == [client.ctx]


def test_lazy_selected_handler_binds_child_to_exact_live_chat_record():
    client, _backend_value, syncs = _backend(registry_handler=True, lazy_registry_handler=True)
    generation = generation_for(client)

    assert generation is not None
    assert generation.handler_mode == "standard_formatter"
    assert list(client.create_chat_completion(stream=True)) == ["completion"]
    assert ("tail", "completion") in client.evaluations
    assert syncs == [client.ctx]
    assert retirement_blocked(client) is False


def test_mutated_selected_formatter_state_quarantines_constructed_generation():
    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None and generation.qualified is True
    handler = client._chat_handlers["test-format"]
    formatter = inspect.getclosurevars(handler).nonlocals["chat_formatter"]

    formatter.template = "changed after client construction"
    with pytest.raises(NativeContextUnavailableError):
        client.create_chat_completion(stream=False)

    assert generation._quarantined is True
    assert client.generate_calls == 0
    assert syncs == []


@pytest.mark.asyncio
async def test_cancel_after_context_gate_grant_before_delivery_is_not_submitted(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    held = generation._gate.acquire_sync(generation)
    group = create_request_group(_binding("cancel-granted-before-delivery"))
    task = None

    async def acquire_context():
        async with native_context(client):
            pytest.fail("a cancelled gate waiter entered native_context")

    original_set_result = llama_context_owner._set_waiter_result

    def grant_then_cancel(waiter, lease):
        original_set_result(waiter, lease)
        if waiter.member is not None and waiter.member.group is group:
            assert task is not None
            task.cancel()

    monkeypatch.setattr(llama_context_owner, "_set_waiter_result", grant_then_cancel)
    try:
        with bind_request_group(group):
            task = asyncio.create_task(acquire_context())
        for _ in range(50):
            if generation._gate.waiters:
                break
            await asyncio.sleep(0)
        assert len(generation._gate.waiters) == 1

        held.release_unstarted()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)

        result = await group.complete_and_wait(timeout=1)
        assert result.status is RequestCompletionStatus.COMPLETE
        assert result.cache_tail_completed is False
        assert generation._gate.owner is None
        assert not generation._gate.waiters
        assert client.generate_calls == 0
        assert syncs == []
    finally:
        if held.active:
            held.release_unstarted()
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def test_unfingerprintable_selected_formatter_state_is_quarantined():
    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None and generation.qualified is True
    handler = client._chat_handlers["test-format"]
    formatter = inspect.getclosurevars(handler).nonlocals["chat_formatter"]
    cyclic_state = []
    cyclic_state.append(cyclic_state)
    formatter.template = cyclic_state

    with pytest.raises(NativeContextUnavailableError):
        client.create_chat_completion(stream=False)

    assert generation._quarantined is True
    assert client.generate_calls == 0
    assert syncs == []


def test_formatter_fingerprint_rejects_over_budget_container_before_copying():
    from app.services.orchestrator.llama_context_owner import (
        _handler_state_fingerprint,
    )

    client, backend, _syncs = _backend()
    handler = client._chat_handlers["test-format"]
    formatter = inspect.getclosurevars(handler).nonlocals["chat_formatter"]
    formatter.template = list(range(5000))

    assert _handler_state_fingerprint(formatter, backend.llama_chat_format) is None


def test_mutated_selected_standard_formatter_global_quarantines_generation():
    client, backend, syncs = _backend(registry_handler=True)
    generation = generation_for(client)
    assert generation is not None and generation.qualified is True
    handler = backend.llama_chat_format.get_chat_completion_handler("test-format")
    formatter = inspect.getclosurevars(handler).nonlocals["chat_formatter"]
    assert formatter.__globals__ is backend.llama_chat_format.__dict__
    backend.llama_chat_format.formatter_marker["mode"] = "changed"

    with pytest.raises(NativeContextUnavailableError):
        client.create_chat_completion(stream=False)

    assert generation._quarantined is True
    assert client.generate_calls == 0
    assert syncs == []


def test_same_formatter_code_with_replacement_globals_is_not_same_provenance():
    from app.services.orchestrator.llama_context_owner import (
        _handler_state_fingerprint,
    )

    client, backend, _syncs = _backend(registry_handler=True)
    handler = backend.llama_chat_format.get_chat_completion_handler("test-format")
    formatter = inspect.getclosurevars(handler).nonlocals["chat_formatter"]
    original = _handler_state_fingerprint(formatter, backend.llama_chat_format)
    assert original is not None
    replacement_globals = dict(formatter.__globals__)
    replacement_globals["formatter_marker"] = {"mode": "changed"}
    replacement = FunctionType(
        formatter.__code__,
        replacement_globals,
        formatter.__name__,
        formatter.__defaults__,
        formatter.__closure__,
    )

    assert _handler_state_fingerprint(replacement, backend.llama_chat_format) != original


def test_callable_provenance_rejects_oversized_closure_before_walk():
    from app.services.orchestrator.llama_context_owner import _callable_provenance

    empty_code = (lambda: None).__code__
    freevars = tuple(f"captured_{index}" for index in range(513))
    code = empty_code.replace(co_freevars=freevars)
    cells = tuple((lambda item: lambda: item)(index).__closure__[0] for index in range(513))
    callback = FunctionType(code, {}, closure=cells)

    assert _callable_provenance(callback) is None


def test_jinja_function_names_and_closure_share_one_traversal_budget(
    monkeypatch: pytest.MonkeyPatch,
):
    client, backend, _syncs = _backend(monkeypatch, real_jinja_handler=True)
    generation = generation_for(client)
    assert generation is not None
    formatter = inspect.getclosurevars(generation.handler).nonlocals["chat_formatter"]
    module = backend.llama_chat_format
    names = tuple(f"global_{index}" for index in range(3000))
    freevars = tuple(f"captured_{index}" for index in range(1200))
    code = (lambda self, **_kwargs: None).__code__.replace(co_names=names, co_freevars=freevars)
    cells = tuple(
        (lambda item: lambda: item)(index).__closure__[0] for index in range(len(freevars))
    )
    oversized_call = FunctionType(code, module.__dict__, "__call__", closure=cells)
    monkeypatch.setattr(module.Jinja2ChatFormatter, "__call__", oversized_call)

    from app.services.orchestrator.llama_context_owner import (
        _handler_state_fingerprint,
    )

    assert _handler_state_fingerprint(formatter, module) is None


@pytest.mark.asyncio
async def test_constructor_custom_tokenizer_is_not_qualified_for_native_completion():
    client, _backend_value, syncs = _backend(custom_tokenizer=True)
    generation = generation_for(client)
    assert generation is not None
    assert generation.tokenizer_qualified is False
    assert generation.qualified is False
    group = create_request_group(_binding("constructor-custom-tokenizer"))

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        await run_native(
            client,
            client.create_chat_completion,
            messages=[{"role": "user", "content": "hello"}],
            stream=False,
        )

    result = await group.complete_and_wait(timeout=2)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert client.generate_calls == 0
    assert syncs == []


def test_default_tokenizer_binding_pins_pinned_implementation_methods(
    monkeypatch: pytest.MonkeyPatch,
):
    import importlib

    tokenizer_module = importlib.import_module("llama_cpp.llama_tokenizer")

    class Model:
        def tokenize(self, text, add_bos=True, special=True):
            return [1]

        def detokenize(self, tokens, special=True):
            return b"token"

    model = Model()
    tokenizer = object.__new__(tokenizer_module.LlamaTokenizer)
    tokenizer._model = model
    client = SimpleNamespace(tokenizer_=tokenizer, _model=model)
    backend = SimpleNamespace(__name__="llama_cpp", __file__="pinned-backend")

    from app.services.orchestrator.llama_context_owner import (
        _default_tokenizer_provenance,
    )

    original = _default_tokenizer_provenance(client, backend)
    assert original is not None

    def replacement_tokenize(self, text, add_bos=True, special=True):
        return []

    tokenizer._model.tokenize = replacement_tokenize.__get__(
        tokenizer._model, type(tokenizer._model)
    )
    assert _default_tokenizer_provenance(client, backend) is None


def test_default_tokenizer_provenance_pins_delegated_model_methods(
    monkeypatch: pytest.MonkeyPatch,
):
    import importlib

    tokenizer_module = importlib.import_module("llama_cpp.llama_tokenizer")

    class Model:
        def tokenize(self, text, add_bos=True, special=True):
            return [1]

        def detokenize(self, tokens, special=True):
            return b"token"

    model = Model()
    tokenizer = object.__new__(tokenizer_module.LlamaTokenizer)
    tokenizer._model = model
    client = SimpleNamespace(tokenizer_=tokenizer, _model=model)
    backend = SimpleNamespace(__name__="llama_cpp", __file__="pinned-backend")

    from app.services.orchestrator.llama_context_owner import (
        _default_tokenizer_provenance,
    )

    original = _default_tokenizer_provenance(client, backend)
    assert original is not None

    def replacement_tokenize(self, text, add_bos=True, special=True):
        return [2]

    model.tokenize = replacement_tokenize.__get__(model, type(model))
    assert _default_tokenizer_provenance(client, backend) != original


@pytest.mark.asyncio
async def test_specialized_registry_formatter_stays_opaque_without_losing_value():
    client, _backend_value, syncs = _backend(
        registry_handler=True, specialized_registry_handler=True
    )
    group = create_request_group(_binding("specialized-handler"))

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        await run_native(
            client,
            client.create_chat_completion,
            stream=False,
        )

    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert result.reason == "native_handler_unqualified"
    assert client.generate_calls == 0
    assert syncs == []


@pytest.mark.asyncio
async def test_opaque_selected_handler_preserves_safe_nonstream_value_and_reports_unknown():
    client, _backend_value, syncs = _backend(opaque_handler=True)
    group = create_request_group(_binding("opaque-handler"))

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        await run_native(
            client,
            client.create_chat_completion,
            stream=False,
        )

    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert client.generate_calls == 0
    assert syncs == []


@pytest.mark.asyncio
async def test_actual_chat_wrapper_generate_to_stream_uses_one_structural_child():
    client, _backend_value, syncs = _backend(terminal_chat_stream=True)
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf",
        client=client,
        streaming=True,
    )
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    bind_native_wrapper(model, client)

    def try_independent_same_method_child():
        child = model._stream([HumanMessage(content="independent")])
        with pytest.raises(ProviderUnavailableError):
            next(child)

    client.on_generation_step = try_independent_same_method_child
    group = create_request_group(_binding("chat-wrapper"))
    with bind_request_group(group):
        result = await run_native(model, model._generate, [HumanMessage(content="hello")])

    completion = await group.complete_and_wait(timeout=2)
    assert result.generations[0].message.content == "completion"
    assert completion.status is RequestCompletionStatus.COMPLETE
    assert client.close_calls == 0
    assert client.generate_calls == 1
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_sealed_accepted_generate_can_construct_its_stream_child(
    monkeypatch: pytest.MonkeyPatch,
):
    client, _backend_value, syncs = _backend(terminal_chat_stream=True)
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    bind_native_wrapper(model, client)
    parameters_entered = threading.Event()
    release_parameters = threading.Event()
    original_get_parameters = ChatLlamaCpp._get_parameters

    def block_before_stream_child(self, stop):
        parameters_entered.set()
        if not release_parameters.wait(timeout=4):
            raise TimeoutError("accepted generation did not reach stream construction")
        return original_get_parameters(self, stop)

    monkeypatch.setattr(ChatLlamaCpp, "_get_parameters", block_before_stream_child)
    group = create_request_group(_binding("sealed-before-stream-child"))
    generation = None
    with bind_request_group(group):
        generation = asyncio.create_task(
            run_native(model, model._generate, [HumanMessage(content="hello")])
        )
    try:
        assert await asyncio.to_thread(parameters_entered.wait, 2)
        assert len(group._members) == 1
        group.seal()
        assert len(group._members) == 1
        release_parameters.set()
        result = await asyncio.wait_for(generation, timeout=4)
        completion = await group.complete_and_wait(timeout=2)
    finally:
        release_parameters.set()
        if generation is not None and not generation.done():
            done, pending = await asyncio.wait((generation,), timeout=1)
            if pending:
                _unsettled_native_test_workers.append((generation, model, group))
            else:
                generation.result()

    assert result.generations[0].message.content == "completion"
    assert completion.status is RequestCompletionStatus.COMPLETE
    assert client.generate_calls == 1
    assert client.iterator_close_calls == 1
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_actual_chat_stream_keeps_single_worker_progress_ahead_of_queued_alias(
    monkeypatch,
):
    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(
        waits={"completion": (entered, release)},
        terminal_chat_stream=True,
        registry_handler=True,
    )
    from concurrent.futures import ThreadPoolExecutor

    from app.services.orchestrator import native_worker
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    monkeypatch.setattr(native_worker, "MAX_PROVIDER_OPERATIONS", 1)
    monkeypatch.setattr(native_worker, "MAX_PROVIDER_CLEANUP_REFERENCES", 128)
    one_worker = ThreadPoolExecutor(max_workers=1)
    loop = asyncio.get_running_loop()
    prior_executor = loop._default_executor
    loop.set_default_executor(one_worker)
    first_model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    queued_model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    bind_native_wrapper(first_model, client)
    bind_native_wrapper(queued_model, client)
    first_group = create_request_group(_binding("chat-stream-first"))
    queued_group = create_request_group(_binding("chat-stream-queued"))

    async def collect(model):
        return await model._agenerate([HumanMessage(content="hello")])

    with bind_request_group(first_group):
        first = asyncio.create_task(collect(first_model))
    queued = None
    entered_waiter = asyncio.create_task(entered.wait())
    try:
        done, _pending = await asyncio.wait(
            (first, entered_waiter),
            timeout=2,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if first in done:
            await first
        assert entered_waiter in done
        await entered_waiter
        generation = generation_for(client)
        assert generation is not None
        lifecycle = native_worker._get_lifecycle(client, loop, create=False)
        assert lifecycle is not None
        with lifecycle.lock:
            direct_record = native_worker._direct_calls[id(client)]
            direct_tokens = tuple(direct_record.tokens.values())
            assert len(direct_tokens) == 1
            assert direct_tokens[0].progress_cleanup_credit > 0
            assert len(lifecycle.cleanup_references) + lifecycle.cleanup_reservations == (
                native_worker.MAX_PROVIDER_CLEANUP_REFERENCES
            )
            assert (
                sum(
                    reservation.cleanup_reservations
                    for reservation in lifecycle.progress_credits.values()
                )
                + sum(stream.cleanup_reservations for stream in lifecycle.streams.values())
                + sum(operation.cleanup_reservations for operation in lifecycle.operations.values())
                + sum(token.cleanup_reservations for token in direct_tokens)
                == lifecycle.cleanup_reservations
            )
        with bind_request_group(queued_group):
            queued = asyncio.create_task(collect(queued_model))
        for _ in range(50):
            generation = generation_for(client)
            if generation is not None and generation._gate.waiters:
                break
            await asyncio.sleep(0)

        assert generation is not None
        assert len(generation._gate.waiters) == 1
        lifecycle = native_worker._get_lifecycle(client, loop, create=False)
        with lifecycle.lock:
            assert len(lifecycle.operations) == 1
            assert (
                sum(
                    operation.state.value == "body_running"
                    for operation in lifecycle.operations.values()
                )
                == 1
            )
        assert client.generate_calls == 1
        assert not first.done()
        assert not queued.done()
        assert syncs == []

        release.set()
        first_result = await asyncio.wait_for(first, timeout=3)
        queued_result = await asyncio.wait_for(queued, timeout=3)
        assert first_result.generations[0].message.content == "completion"
        assert queued_result.generations[0].message.content == "completion"
        assert first_result.generations[0].generation_info["finish_reason"] == "stop"
        assert queued_result.generations[0].generation_info["finish_reason"] == "stop"
        first_completion, queued_completion = await asyncio.gather(
            first_group.complete_and_wait(timeout=2),
            queued_group.complete_and_wait(timeout=2),
        )
        assert first_completion.status is RequestCompletionStatus.COMPLETE
        assert queued_completion.status is RequestCompletionStatus.COMPLETE
        assert client.generate_calls == 2
        assert syncs == [client.ctx, client.ctx]
        assert [item[0] for item in client.evaluations].count("factory") == 2
        with lifecycle.lock:
            assert lifecycle.operations == {}
            assert lifecycle.streams == {}
            assert lifecycle.cleanup_references == []
            assert lifecycle.cleanup_reservations == 0
            assert lifecycle.progress_reservations == 0
        factory_positions = [
            index for index, item in enumerate(client.trace) if item == ("factory", "completion")
        ]
        sync_positions = [
            index for index, item in enumerate(client.trace) if item == ("sync", client.ctx)
        ]
        assert len(factory_positions) == len(sync_positions) == 2
        assert factory_positions[0] < sync_positions[0]
        assert sync_positions[0] < factory_positions[1] < sync_positions[1]
    finally:
        release.set()
        if not entered_waiter.done():
            entered_waiter.cancel()
        await asyncio.gather(entered_waiter, return_exceptions=True)
        for task in (first, queued):
            if task is not None and not task.done():
                await asyncio.gather(task, return_exceptions=True)
        if prior_executor is None:
            loop._default_executor = None
        else:
            loop.set_default_executor(prior_executor)
        one_worker.shutdown(wait=True)


@pytest.mark.asyncio
async def test_actual_astream_sync_failure_replaces_only_pending_success():
    client, _backend_value, syncs = _backend(
        synchronization_failure=True,
        registry_handler=True,
        terminal_chat_stream=True,
    )
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    bind_native_wrapper(model, client)
    group = create_request_group(_binding("actual-astream-sync-failure"))

    async def collect():
        chunks = []
        async for chunk in model._astream([HumanMessage(content="hello")]):
            chunks.append(chunk)
        return chunks

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        await asyncio.wait_for(collect(), timeout=3)
    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert client.generate_calls == 1
    assert syncs == []


@pytest.mark.asyncio
async def test_actual_astream_reserves_worker_and_cleanup_before_queued_alias(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    from app.services.orchestrator import native_worker
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(
        waits={"completion": (entered, release)}, terminal_chat_stream=True
    )
    loop = asyncio.get_running_loop()
    old_executor = loop._default_executor
    one_worker = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(one_worker)
    first_model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    queued_model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    bind_native_wrapper(first_model, client)
    bind_native_wrapper(queued_model, client)
    first_group = create_request_group(_binding("actual-astream-first"))
    queued_group = create_request_group(_binding("actual-astream-queued"))
    generation = generation_for(client)
    assert generation is not None
    observed_runners = []
    ensure_runner = native_worker._ensure_native_runner

    async def observe_created_runner(reservation):
        runner = await ensure_runner(reservation)
        if runner not in observed_runners:
            observed_runners.append(runner)
        return runner

    monkeypatch.setattr(native_worker, "_ensure_native_runner", observe_created_runner)

    def observe_runner():
        lease = generation._gate.owner
        reservation = lease.progress_reservation if lease is not None else None
        runner = reservation.runner if reservation is not None else None
        if runner is not None and runner not in observed_runners:
            observed_runners.append(runner)

    client.on_generation_step = observe_runner
    monkeypatch.setattr(native_worker, "MAX_PROVIDER_CLEANUP_REFERENCES", 128)
    monkeypatch.setattr(native_worker, "MAX_PROVIDER_OPERATIONS", 1)

    async def collect(model):
        return [chunk async for chunk in model._astream([HumanMessage(content="hello")])]

    with bind_request_group(first_group):
        first = asyncio.create_task(collect(first_model))
    queued = None
    entered_waiter = asyncio.create_task(entered.wait())
    try:
        done, _pending = await asyncio.wait(
            (first, entered_waiter),
            timeout=2,
            return_when=asyncio.FIRST_COMPLETED,
        )
        assert done, "neither the native call nor its entry latch completed"
        if first in done:
            # Surface setup/producer errors instead of reporting a misleading
            # latch timeout. The assertions below still require the real
            # native call to enter before the alias is queued.
            await first
        assert entered_waiter in done and entered_waiter.result() is True
        generation = generation_for(client)
        assert generation is not None and generation._gate.owner is not None
        first_lease = generation._gate.owner
        reservation = first_lease.progress_reservation
        assert reservation is not None and reservation.active
        assert reservation.cleanup_reservations == 126
        with bind_request_group(queued_group):
            queued = asyncio.create_task(collect(queued_model))
        for _ in range(50):
            if generation._gate.waiters:
                break
            await asyncio.sleep(0)
        assert len(generation._gate.waiters) == 1
        lifecycle = native_worker._get_lifecycle(client, loop, create=False)
        with lifecycle.lock:
            assert len(lifecycle.operations) == 1
            assert (
                sum(item.state.value == "body_running" for item in lifecycle.operations.values())
                == 1
            )
            assert (
                len(lifecycle.cleanup_references) + lifecycle.cleanup_reservations
                == native_worker.MAX_PROVIDER_CLEANUP_REFERENCES
            )
            direct_record = native_worker._direct_calls[id(client)]
            direct_tokens = tuple(direct_record.tokens.values())
            assert len(direct_tokens) == 1
            assert direct_tokens[0].lease_cleanup_credit == 1
            assert direct_tokens[0].progress_cleanup_credit == 0
            assert sum(
                reservation.cleanup_reservations
                for reservation in lifecycle.progress_credits.values()
            ) + sum(stream.cleanup_reservations for stream in lifecycle.streams.values()) + sum(
                operation.cleanup_reservations for operation in lifecycle.operations.values()
            ) + sum(token.cleanup_reservations for token in direct_tokens) == (
                lifecycle.cleanup_reservations
            )
        assert client.generate_calls == 1
        assert not first.done()
        assert not queued.done()

        release.set()
        first_chunks = await asyncio.wait_for(first, timeout=4)
        queued_chunks = await asyncio.wait_for(queued, timeout=4)
        assert first_chunks[0].generation_info["finish_reason"] == "stop"
        assert queued_chunks[0].generation_info["finish_reason"] == "stop"
        first_result, queued_result = await asyncio.gather(
            first_group.complete_and_wait(timeout=2),
            queued_group.complete_and_wait(timeout=2),
        )
        assert first_result.status is RequestCompletionStatus.COMPLETE
        assert queued_result.status is RequestCompletionStatus.COMPLETE
        assert client.generate_calls == 2
        assert syncs == [client.ctx, client.ctx]
        assert len(observed_runners) == 2
        assert all(
            runner.worker_returned.is_set() and runner.future.done() for runner in observed_runners
        )
        with lifecycle.lock:
            assert lifecycle.operations == {}
            assert lifecycle.streams == {}
            assert lifecycle.cleanup_references == []
            assert lifecycle.cleanup_reservations == 0
            assert lifecycle.progress_reservations == 0
            assert lifecycle.direct_operations == 0
    finally:
        primary_error = sys.exc_info()[1]
        release.set()
        if not entered_waiter.done():
            entered_waiter.cancel()
        stream_tasks = [task for task in (first, queued) if task is not None]
        pending_tasks = [task for task in stream_tasks if not task.done()]
        for task in pending_tasks:
            task.cancel()
        _done, pending = await asyncio.wait([entered_waiter, *stream_tasks], timeout=3)
        await asyncio.gather(entered_waiter, return_exceptions=True)
        workers_returned = all(
            runner.worker_returned.is_set() and runner.future.done() for runner in observed_runners
        )
        if old_executor is None:
            loop._default_executor = None
        else:
            loop.set_default_executor(old_executor)
        if not pending and workers_returned:
            one_worker.shutdown(wait=True)
        else:
            # The native command worker may still own unsettled work. Retain
            # both its executor and exact runner handles rather than detaching
            # them or pretending a nonblocking shutdown proves completion.
            _unsettled_native_test_workers.append((one_worker, *observed_runners))
            if primary_error is None:
                raise AssertionError("Native stream fixture cleanup remained unsettled.")
            add_note = getattr(primary_error, "add_note", None)
            if callable(add_note):
                add_note("Native stream fixture cleanup remained unsettled.")


@pytest.mark.asyncio
async def test_abandoned_stream_terminal_publication_settles_with_buffered_chunk():
    from app.services.orchestrator.native_worker import _get_lifecycle

    provider = SimpleNamespace()
    close_calls = []

    def iterator_factory():
        try:
            yield "first"
            yield "buffered-final"
        finally:
            close_calls.append(True)

    stream = stream_native(provider, iterator_factory)
    assert await asyncio.wait_for(anext(stream), timeout=2) == "first"
    lifecycle = _get_lifecycle(provider, asyncio.get_running_loop(), create=False)
    assert lifecycle is not None
    with lifecycle.lock:
        assert len(lifecycle.streams) == 1
        lease = next(iter(lifecycle.streams.values()))
    assert lease.terminal_waiting is not None
    await asyncio.wait_for(lease.terminal_waiting.wait(), timeout=2)

    await asyncio.wait_for(stream.aclose(), timeout=2)

    with lifecycle.lock:
        assert lifecycle.streams == {}
        assert lifecycle.operations == {}
    assert close_calls == [True]


@pytest.mark.asyncio
async def test_retirement_wakes_post_close_terminal_publication():
    from app.services.orchestrator.native_worker import _get_lifecycle

    class Provider:
        def __init__(self):
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    provider = Provider()
    iterator_closes = []

    def iterator_factory():
        try:
            yield "first"
            yield "buffered-final"
        finally:
            iterator_closes.append(True)

    stream = stream_native(provider, iterator_factory)
    assert await asyncio.wait_for(anext(stream), timeout=2) == "first"
    lifecycle = _get_lifecycle(provider, asyncio.get_running_loop(), create=False)
    assert lifecycle is not None
    with lifecycle.lock:
        lease = next(iter(lifecycle.streams.values()))
    assert lease.terminal_waiting is not None
    await asyncio.wait_for(lease.terminal_waiting.wait(), timeout=2)
    assert lease.close_started is True
    assert lease.cleanup_complete is True
    assert iterator_closes == [True]

    result = await asyncio.wait_for(retire_native(provider), timeout=3)
    assert result.status.value == "complete"
    assert provider.close_calls == 1
    with lifecycle.lock:
        assert lifecycle.streams == {}
        assert lifecycle.operations == {}
    await asyncio.wait_for(stream.aclose(), timeout=2)


@pytest.mark.asyncio
async def test_generic_stream_transfers_prepaid_iterator_cleanup_credit():
    from app.services.orchestrator import native_worker

    provider = SimpleNamespace()
    entered = threading.Event()
    release = threading.Event()
    close_calls = []

    def factory():
        entered.set()
        if not release.wait(timeout=3):
            raise TimeoutError("generic stream factory did not release")

        def values():
            try:
                yield "value"
            finally:
                close_calls.append("closed")

        return values()

    async def collect():
        return [value async for value in stream_native(provider, factory)]

    consumer = asyncio.create_task(collect())
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        lifecycle = native_worker._get_lifecycle(provider, asyncio.get_running_loop(), create=False)
        with lifecycle.lock:
            assert len(lifecycle.streams) == 1
            lease = next(iter(lifecycle.streams.values()))
            operation = next(iter(lifecycle.operations.values()))
            assert lease.cleanup_reservations == 1
            assert operation.lease_cleanup_reservations == 1
            assert operation.transfer_required is True
        release.set()
        assert await asyncio.wait_for(consumer, timeout=3) == ["value"]
        with lifecycle.lock:
            assert not lifecycle.streams
            assert lifecycle.cleanup_reservations == 0
            assert not lifecycle.cleanup_references
        assert close_calls == ["closed"]
    finally:
        release.set()
        if not consumer.done():
            await asyncio.gather(consumer, return_exceptions=True)


@pytest.mark.asyncio
async def test_unsupported_native_callback_options_are_rejected_before_entry():
    client, _backend_value, syncs = _backend()
    client.draft_model = object()
    group = create_request_group(_binding("unsupported-draft-model"))

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        await run_native(client, client.generate, "must-not-enter")

    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert result.reason == "native_option_binding_unverified"
    generation = generation_for(client)
    assert generation is not None and generation._gate.owner is not None
    assert generation._gate.owner.unknown is True
    assert generation._gate.owner.reason == "native_option_binding_unverified"
    assert client.generate_calls == 0
    assert syncs == []


@pytest.mark.asyncio
async def test_group_stop_after_grant_requests_owned_astream_producer_stop(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import (
        llama_context_owner as owner_module,
        native_worker,
    )

    entered = asyncio.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(
        waits={"completion": (entered, release)}, terminal_chat_stream=True
    )
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    bind_native_wrapper(model, client)
    group = create_request_group(_binding("group-stop-after-grant"))
    close_calls = []
    checked_closes = []
    client.on_iterator_close = lambda: close_calls.append("closed")
    original_close_record = owner_module._close_record

    def observe_close_record(record):
        first_close = not record.close_started and not record.close_checked
        if record.kind == "token_generation" and first_close:
            checked_closes.append(("entered", record, len(syncs)))
        try:
            return original_close_record(record)
        finally:
            if record.kind == "token_generation" and first_close:
                checked_closes.append(("returned", record, record.close_checked, len(syncs)))

    monkeypatch.setattr(owner_module, "_close_record", observe_close_record)

    async def consume():
        async for _chunk in model._astream([HumanMessage(content="hello")]):
            pass

    with bind_request_group(group):
        consumer = asyncio.create_task(consume())
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        generation = generation_for(client)
        assert generation is not None and generation._gate.owner is not None
        lease = generation._gate.owner
        stream_lease = next(iter(native_worker._lifecycles[id(client)].streams.values()))
        assert lease.stop_callback is stream_lease.stop_callback
        assert lease.started is True

        group.begin_stop()
        assert stream_lease.stop_requested is True
        assert stream_lease.task is not None and not stream_lease.task.done()
        assert not consumer.done()
        release.set()
        with suppress(asyncio.CancelledError, NativeContextUnavailableError):
            await asyncio.wait_for(consumer, timeout=4)
        result = await group.stop_and_wait(timeout=2)
        assert result.status is RequestCompletionStatus.COMPLETE
        assert result.stopped is True
        assert client.generate_calls == 1
        assert close_calls == ["closed"]
        close_entries = [event for event in checked_closes if event[0] == "entered"]
        close_returns = [event for event in checked_closes if event[0] == "returned"]
        assert close_entries
        assert len(close_entries) == len(close_returns)
        assert len({id(event[1]) for event in close_entries}) == len(close_entries)
        returned_by_record = {id(event[1]): event for event in close_returns}
        assert len(returned_by_record) == len(close_returns)
        assert {id(event[1]) for event in close_entries} == set(returned_by_record)
        for entered_event in close_entries:
            returned_event = returned_by_record[id(entered_event[1])]
            assert entered_event[2] == 0
            assert returned_event[2] is True
            assert returned_event[3] == 0
        assert syncs == [client.ctx]
    finally:
        release.set()
        if not consumer.done():
            await asyncio.gather(consumer, return_exceptions=True)


@pytest.mark.asyncio
async def test_grouped_actual_agenerate_uses_selected_handler_and_checked_context():
    client, _backend_value, syncs = _backend(registry_handler=True)
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf",
        client=client,
        streaming=False,
    )
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    bind_native_wrapper(model, client)
    group = create_request_group(_binding("grouped-agenerate"))
    with bind_request_group(group):
        result = await model._agenerate([HumanMessage(content="hello")])

    completion = await group.complete_and_wait(timeout=2)
    assert result.generations[0].message.content == "completion"
    assert completion.status is RequestCompletionStatus.COMPLETE
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_grouped_direct_sync_wrapper_owns_its_request_member():
    client, _backend_value, syncs = _backend()
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf",
        client=client,
        streaming=False,
    )
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    bind_native_wrapper(model, client)
    group = create_request_group(_binding("grouped-direct-sync"))

    with bind_request_group(group):
        result = await run_native(model, model._generate, [HumanMessage(content="hello")])

    completion = await group.complete_and_wait(timeout=2)
    assert result.generations[0].message.content == "completion"
    assert completion.status is RequestCompletionStatus.COMPLETE
    assert group._members == {}
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_direct_stream_cannot_move_from_its_construction_request():
    client, _backend_value, syncs = _backend()
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf",
        client=client,
        streaming=True,
    )
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    bind_native_wrapper(model, client)
    group_a = create_request_group(_binding("stream-origin-a"))
    group_b = create_request_group(_binding("stream-origin-b"))
    with bind_request_group(group_a):
        stream = model._stream([HumanMessage(content="hello")])

    assert group_a._members
    stopping = asyncio.create_task(group_a.stop_and_wait(timeout=2))
    await asyncio.sleep(0)
    with bind_request_group(group_b), pytest.raises(ProviderUnavailableError):
        await run_native(client, lambda: next(stream))

    result_a = await asyncio.wait_for(stopping, timeout=2)
    result_b = await group_b.complete_and_wait(timeout=1)
    assert result_a.status is RequestCompletionStatus.COMPLETE
    assert result_b.status is RequestCompletionStatus.UNKNOWN
    assert client.generate_calls == 0
    assert syncs == []


@pytest.mark.asyncio
async def test_ungrouped_registered_direct_callback_quarantines_native_owner():
    from app.services.orchestrator import native_worker

    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None

    @direct_native_call
    def callback(_provider):
        return "preserved callback value"

    try:
        value = await run_native(client, callback, client)

        assert value == "preserved callback value"
        assert generation._quarantined is True
        assert generation._gate.quarantined is True
        assert client.generate_calls == 0
        assert syncs == []
        with pytest.raises(NativeContextUnavailableError):
            async with native_context(client):
                pytest.fail("uncertain ungrouped callback reopened native admission")
    finally:
        with native_worker._registry_guard:
            lifecycle = native_worker._lifecycles.pop(id(client), None)
            native_worker._direct_calls.pop(id(client), None)
            native_worker._direct_cleanups.pop(id(client), None)
        if lifecycle is not None:
            with lifecycle.lock:
                lifecycle.cleanup_references.clear()
                lifecycle.strong_owner = None


@pytest.mark.asyncio
async def test_known_direct_stream_rejects_blocking_advance_on_request_loop():
    client, _backend_value, syncs = _backend()
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf",
        client=client,
        streaming=True,
    )
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    bind_native_wrapper(model, client)
    group = create_request_group(_binding("direct-stream-loop-owner"))
    with bind_request_group(group):
        stream = model._stream([HumanMessage(content="hello")])
        with pytest.raises(ProviderUnavailableError):
            next(stream)

    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.COMPLETE
    assert result.cache_tail_completed is False
    assert client.generate_calls == 0
    assert syncs == []


def test_ungrouped_sync_iterator_rejects_advance_on_any_event_loop():
    client, _backend_value, syncs = _backend()
    iterator = client.generate("created-outside-loop")

    async def advance():
        with pytest.raises(NativeContextUnavailableError):
            next(iterator)
        with pytest.raises(NativeContextUnavailableError):
            iterator.close()

    asyncio.run(advance())

    assert client.generate_calls == 0
    assert syncs == []


def test_owned_iterator_condition_wait_rejects_other_running_loop():
    entered = threading.Event()
    release = threading.Event()
    client, _backend_value, syncs = _backend(waits={"blocked-before-yield": (entered, release)})
    iterator = client.generate("blocked-before-yield")
    outcomes = []

    def advance_from_worker():
        try:
            outcomes.append(next(iterator))
        except BaseException as error:
            outcomes.append(error)

    worker = threading.Thread(target=advance_from_worker)
    worker.start()
    try:
        assert entered.wait(timeout=2)

        async def observe_from_loop():
            with pytest.raises(NativeContextUnavailableError):
                next(iterator)

        asyncio.run(observe_from_loop())
    finally:
        release.set()
        worker.join(timeout=3)

    assert not worker.is_alive()
    assert len(outcomes) == 1
    assert client.generate_calls == 1
    # The competing event-loop observation is uncertain progress, so it cannot
    # turn the worker's eventual raw yield into a clean context handoff.
    assert syncs == []


@pytest.mark.asyncio
async def test_structural_direct_child_keeps_generate_origin_before_first_advance():
    client, _backend_value, syncs = _backend()

    class Wrapper:
        def __init__(self, wrapped_client):
            self.client = wrapped_client

        def __getattr__(self, name):
            return getattr(self.client, name)

        @direct_native_call
        def _stream(self):
            yield from self.generate("escaped-child")

        @direct_native_call(cleanup_slots=2)
        def _generate(self):
            return self._stream()

    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    wrapper = Wrapper(client)
    bind_native_wrapper(wrapper, client)

    group_a = create_request_group(_binding("nested-stream-origin-a"))
    group_b = create_request_group(_binding("nested-stream-origin-b"))

    with bind_request_group(group_a):
        escaped = wrapper._generate()

    assert group_a._members
    from app.services.orchestrator import native_worker

    record = native_worker._direct_calls[id(client)]
    assert record.active == 1
    assert len(record.tokens) == 1
    stopping = asyncio.create_task(group_a.stop_and_wait(timeout=2))
    await asyncio.sleep(0)
    with bind_request_group(group_b), pytest.raises(ProviderUnavailableError):
        await run_native(client, lambda: next(escaped))

    result_a = await asyncio.wait_for(stopping, timeout=2)
    result_b = await group_b.complete_and_wait(timeout=1)
    assert result_a.status is RequestCompletionStatus.COMPLETE
    assert result_b.status is RequestCompletionStatus.UNKNOWN
    assert client.generate_calls == 0
    assert syncs == []


@pytest.mark.asyncio
async def test_grouped_direct_iterator_continues_only_through_its_retained_member():
    client, _backend_value, syncs = _backend()

    class Wrapper:
        def __init__(self, wrapped_client):
            self.client = wrapped_client

        def __getattr__(self, name):
            return getattr(self.client, name)

        @direct_native_call
        def _stream(self):
            yield from self.generate("retained-member-stream")

    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    wrapper = Wrapper(client)
    bind_native_wrapper(wrapper, client)
    group = create_request_group(_binding("retained-member-continuation"))
    with bind_request_group(group):
        stream = wrapper._stream()

    with bind_request_group(group):
        first = await run_native(client, next, stream)
        await run_native(client, stream.close)

    result = await group.complete_and_wait(timeout=2)
    assert first == "retained-member-stream"
    assert result.status is RequestCompletionStatus.COMPLETE
    assert client.generate_calls == 1
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_grouped_direct_iterator_retains_one_context_across_multiple_yields():
    client, _backend_value, syncs = _backend(yield_values={"retained-stream": ("first", "second")})

    class Wrapper:
        def __init__(self, wrapped_client):
            self.client = wrapped_client

        def __getattr__(self, name):
            return getattr(self.client, name)

        @direct_native_call
        def _stream(self):
            yield from self.client.generate("retained-stream")

    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    wrapper = Wrapper(client)
    bind_native_wrapper(wrapper, client)
    group = create_request_group(_binding("retained-multi-yield"))
    with bind_request_group(group):
        stream = wrapper._stream()

    with bind_request_group(group):
        first = await run_native(client, next, stream)
        from app.services.orchestrator.llama_context_owner import _current_lease
        from app.services.orchestrator.native_request_completion import _active_member
        from app.services.orchestrator.native_worker import _direct_call_tokens

        assert _current_lease.get() is None
        assert _active_member.get() is None
        assert current_request_member() is None
        assert _direct_call_tokens.get() == ()
        assert syncs == []
        assert client.iterator_close_calls == 0
        assert group._members
        generation = generation_for(client)
        assert generation is not None and generation._gate.owner is not None
        lease = generation._gate.owner
        runner = lease.progress_reservation.runner
        assert runner is not None and not runner.worker_returned.is_set()
        second = await run_native(client, next, stream)
        assert _current_lease.get() is None
        assert _active_member.get() is None
        assert current_request_member() is None
        assert _direct_call_tokens.get() == ()
        assert syncs == []
        assert client.iterator_close_calls == 0
        assert generation._gate.owner is lease
        assert lease.progress_reservation.runner is runner
        assert not runner.worker_returned.is_set()
        assert group._members
        end_marker = object()
        end = await run_native(client, next, stream, end_marker)

    result = await group.complete_and_wait(timeout=2)
    assert (first, second) == ("first", "second")
    assert end is end_marker
    assert result.status is RequestCompletionStatus.COMPLETE
    assert client.generate_calls == 1
    assert client.iterator_close_calls == 1
    assert syncs == [client.ctx]
    assert generation._gate.owner is None
    assert runner.worker_returned.is_set()
    assert group._members == {}


@pytest.mark.asyncio
async def test_exhausted_raw_iterator_without_close_stays_unknown_and_retained():
    client, _backend_value, syncs = _backend(no_close_completion=True)
    group = create_request_group(_binding("exhausted-raw-without-close"))

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        await run_native(
            client,
            lambda: list(client.create_completion(stream=True)),
        )

    result = await group.stop_and_wait(timeout=2)
    generation = generation_for(client)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert generation is not None and generation._gate.owner is not None
    lease = generation._gate.owner
    assert lease.unknown is True
    assert len(lease.children) == 1
    record = lease.children[0]
    assert record.exhausted is True
    assert record.close_checked is True
    assert record.close_failed is True
    assert syncs == []


@pytest.mark.asyncio
async def test_grouped_direct_iterator_keeps_lease_until_blocked_raw_close_returns():
    client, _backend_value, syncs = _backend()
    close_entered = threading.Event()
    release_close = threading.Event()

    def blocked_close_callback():
        close_entered.set()
        if not release_close.wait(timeout=3):
            raise TimeoutError("retained raw close latch did not release")

    client.on_iterator_close = blocked_close_callback

    class Wrapper:
        def __init__(self, wrapped_client):
            self.client = wrapped_client

        def __getattr__(self, name):
            return getattr(self.client, name)

        @direct_native_call
        def _stream(self):
            yield from self.client.generate("blocked-retained-close")

    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    wrapper = Wrapper(client)
    bind_native_wrapper(wrapper, client)
    group = create_request_group(_binding("retained-blocked-close"))
    with bind_request_group(group):
        stream = wrapper._stream()
        first = await run_native(client, next, stream)

    generation = generation_for(client)
    assert generation is not None and generation._gate.owner is not None
    lease = generation._gate.owner
    close_task = None
    try:
        with bind_request_group(group):
            group.begin_stop()
            with pytest.raises(ProviderUnavailableError):
                await run_native(client, next, stream)
            assert client.generate_calls == 1
            assert generation._gate.owner is lease
            assert syncs == []
            assert group._members
            close_task = asyncio.create_task(run_native(client, stream.close))
        assert await asyncio.wait_for(asyncio.to_thread(close_entered.wait, 2), timeout=3)
        assert not close_task.done()
        assert generation._gate.owner is lease
        assert syncs == []
        assert group._members
        # The loop cannot block on the owned close. A duplicate observation
        # must reject without poisoning the worker's already accepted close.
        with pytest.raises(ProviderUnavailableError):
            stream.close()
        assert not close_task.done()
        assert generation._gate.owner is lease
        assert syncs == []
        release_close.set()
        await asyncio.wait_for(close_task, timeout=3)
    finally:
        release_close.set()
        if close_task is not None and not close_task.done():
            done, pending = await asyncio.wait({close_task}, timeout=1)
            if pending:
                _unsettled_native_test_workers.append(
                    (close_task, release_close, generation, group)
                )
            else:
                await asyncio.gather(*done, return_exceptions=True)

    result = await group.stop_and_wait(timeout=2)
    assert first == "blocked-retained-close"
    assert result.status is RequestCompletionStatus.COMPLETE
    assert result.stopped is True
    assert client.iterator_close_calls == 1
    assert syncs == [client.ctx]
    assert generation._gate.owner is None
    assert not group._members


@pytest.mark.asyncio
async def test_stream_setup_failure_wakes_consumer_and_settles_member_unknown(monkeypatch):
    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("stream-setup-failure"))
    owner_module = sys.modules["app.services.orchestrator.llama_context_owner"]

    def unavailable_generation(_provider, *, retained_owner=False):
        raise RuntimeError("setup failure")

    monkeypatch.setattr(owner_module, "generation_for", unavailable_generation)

    with bind_request_group(group):
        stream = stream_native(client, lambda: iter(("unused",)))
        with pytest.raises(RuntimeError, match="setup failure"):
            await asyncio.wait_for(anext(stream), timeout=1)

    result = await asyncio.wait_for(group.complete_and_wait(timeout=1), timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert client.generate_calls == 0
    assert syncs == []


@pytest.mark.asyncio
async def test_grouped_direct_iterator_continues_after_complete_and_wait_seals_group():
    from app.services.orchestrator.native_request_completion import bind_request_member

    client, _backend_value, syncs = _backend(yield_values={"sealed": ("one", "two")})

    class Wrapper:
        def __init__(self, wrapped_client):
            self.client = wrapped_client

        def __getattr__(self, name):
            return getattr(self.client, name)

        @direct_native_call
        def _stream(self):
            yield from self.client.generate("sealed")

    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    wrapper = Wrapper(client)
    bind_native_wrapper(wrapper, client)
    group = create_request_group(_binding("sealed-direct-continuation"))
    with bind_request_group(group):
        stream = wrapper._stream()
        first = await run_native(client, next, stream)
        retained_member = next(iter(group._members.values()))

    completion = asyncio.create_task(group.complete_and_wait(timeout=3))

    async def close_retained_stream():
        with bind_request_member(retained_member):
            await run_native(client, stream.close)

    try:
        for _ in range(100):
            if not group.is_open:
                break
            await asyncio.sleep(0)
        assert not group.is_open
        assert not group.is_stopping
        assert group._members
        end_marker = object()
        with bind_request_member(retained_member):
            second = await run_native(client, next, stream)
            end = await run_native(client, next, stream, end_marker)
        result = await asyncio.wait_for(completion, timeout=3)
    finally:
        if not stream._finished:
            group.begin_stop()
            close_task = asyncio.create_task(close_retained_stream())
            done, pending = await asyncio.wait((close_task,), timeout=1)
            if pending:
                _unsettled_native_test_workers.append((close_task, stream, retained_member, group))
            elif not close_task.cancelled():
                close_task.exception()
        if not completion.done():
            done, pending = await asyncio.wait((completion,), timeout=1)
            if pending:
                _unsettled_native_test_workers.append((completion, stream, group))

    assert (first, second) == ("one", "two")
    assert end is end_marker
    assert result.status is RequestCompletionStatus.COMPLETE
    assert client.generate_calls == 1
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_selected_standard_chat_handler_uses_its_exact_completion_child():
    client, _backend_value, syncs = _backend(registry_handler=True)
    group = create_request_group(_binding("selected-chat-handler"))

    with bind_request_group(group):
        result = await run_native(
            client,
            lambda: client.create_chat_completion(messages=[], stream=False),
        )

    completion = await group.complete_and_wait(timeout=2)
    assert result == _chat_response("completion")
    assert completion.status is RequestCompletionStatus.COMPLETE
    assert syncs == [client.ctx]


def test_disposal_owner_uses_pinned_wrapper_binding_before_mutable_client():
    client, _backend_value, _syncs = _backend()
    replacement, _replacement_backend, _replacement_syncs = _backend()
    wrapper = SimpleNamespace(client=client)
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    bind_native_wrapper(wrapper, client)
    wrapper.client = replacement

    assert provider_owner(wrapper) is client


@pytest.mark.asyncio
async def test_primary_native_error_identity_survives_context_cleanup():
    client, _backend_value, syncs = _backend()
    primary = RuntimeError("controlled primary failure")
    client.generation_error = primary

    with pytest.raises(RuntimeError) as caught:
        await run_native(client, lambda: list(client.generate("raises")))

    assert caught.value is primary
    assert syncs == [client.ctx]
    assert generation_for(client).qualified is True


@pytest.mark.asyncio
async def test_generic_callable_result_does_not_claim_native_completion():
    provider = SimpleNamespace()
    group = create_request_group(_binding("generic-callable"))
    with bind_request_group(group):
        result = await run_native(provider, lambda: {"safe": "value"})

    completion = await group.complete_and_wait(timeout=2)
    assert result == {"safe": "value"}
    assert completion.status is RequestCompletionStatus.UNKNOWN


@pytest.mark.asyncio
async def test_ordinary_bound_inference_does_not_probe_unrelated_lifetime_descriptor():
    class OrdinaryProvider:
        def __init__(self):
            self.lifetime_reads = 0
            self.close_calls = 0
            self.expected_result = object()

        @property
        def _lifetime(self):
            self.lifetime_reads += 1
            raise AssertionError("ordinary provider lifetime must not be inspected")

        def infer(self):
            return self.expected_result

        def close(self):
            self.close_calls += 1

    provider = OrdinaryProvider()
    result = await run_native(provider, provider.infer)

    assert result is provider.expected_result
    assert provider.lifetime_reads == 0
    assert provider.close_calls == 0

    retirement = await asyncio.wait_for(retire_native(provider), timeout=2)

    assert retirement.status is RetirementStatus.COMPLETE
    assert provider.close_calls == 1
    assert provider.lifetime_reads == 0


@pytest.mark.asyncio
async def test_registered_direct_decorator_result_is_unknown_after_callable_runs():
    from app.services.orchestrator import native_worker

    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("registered-direct-callable"))
    calls = []
    members = []

    @direct_native_call
    def safe_direct_value(provider):
        calls.append(provider)
        members.append(current_request_member())
        return {"kept": "direct-value"}

    with bind_request_group(group):
        value = safe_direct_value(client)

    result = await group.complete_and_wait(timeout=2)
    (member,) = members
    generation = generation_for(client)
    assert generation is not None
    assert value == {"kept": "direct-value"}
    assert calls == [client]
    assert member is not None and member.resource is client
    assert member.kind == "native_operation"
    assert member.scope_finished is True
    assert member.native_seen is False
    assert member.native_not_submitted is False
    assert member.native_status == "unknown"
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert group._unresolved.get(member.sequence) is member
    assert group._members == {}
    assert native_worker._direct_calls.get(id(client)) is None
    pending = native_worker._direct_cleanups[id(client)]
    assert pending.owner() is client
    assert pending.uncertain is True
    assert pending.failure == "native_entry_unverified"
    assert generation._quarantined is True
    assert retirement_blocked(client) is True
    retained = [
        reference
        for reference in pending.references
        if reference is member or getattr(reference, "request_member", None) is member
    ]
    assert len(retained) == 1
    assert client.generate_calls == 0
    assert syncs == []

    later_group = create_request_group(_binding("registered-direct-later-inference"))
    with (
        bind_request_group(later_group),
        pytest.raises((NativeContextUnavailableError, ProviderUnavailableError)),
    ):
        await run_native(
            client,
            lambda: list(client.generate("must-not-enter-after-unknown-direct-call")),
        )
    later_result = await later_group.complete_and_wait(timeout=1)
    assert later_result.status is RequestCompletionStatus.UNKNOWN
    assert client.generate_calls == 0
    assert syncs == []

    retirement = await retire_native(client, timeout=1)
    assert retirement.status is not RetirementStatus.COMPLETE
    assert client.close_calls == 0
    lifecycle = native_worker._get_lifecycle(client, asyncio.get_running_loop(), create=False)
    assert lifecycle.uncertain is True
    assert lifecycle.admission_open is False
    assert lifecycle.strong_owner is client
    assert any(
        getattr(reference, "request_member", None) is member
        for reference in lifecycle.cleanup_references
    )


@pytest.mark.asyncio
async def test_known_client_callable_without_native_entry_joins_runner_and_stays_unknown():
    from concurrent.futures import ThreadPoolExecutor

    loop = asyncio.get_running_loop()
    old_executor = loop._default_executor
    one_worker = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(one_worker)
    safe_client, _backend_value, _safe_syncs = _backend()
    safe_group = create_request_group(_binding("known-safe-no-entry"))
    try:
        with bind_request_group(safe_group):
            safe_value = await run_native(safe_client, lambda: "safe-value")
        assert safe_value == "safe-value"
        safe_generation = generation_for(safe_client)
        assert safe_generation is not None
        safe_lease = safe_generation._gate.owner
        assert safe_lease is not None and safe_lease.unknown is True
        assert safe_lease.progress_reservation is not None
        safe_runner = safe_lease.progress_reservation.runner
        assert safe_runner is not None and safe_runner.worker_returned.is_set()
        assert safe_runner.future is not None and safe_runner.future.done()
        assert safe_group._members == {}
        assert retirement_blocked(safe_client) is True
        safe_result = await safe_group.complete_and_wait(timeout=1)
        assert safe_result.status is RequestCompletionStatus.UNKNOWN

        error_client, _error_backend, _error_syncs = _backend()
        error_group = create_request_group(_binding("known-error-no-entry"))
        primary = RuntimeError("controlled callable failure")
        with pytest.raises(RuntimeError) as caught, bind_request_group(error_group):
            await run_native(error_client, lambda: (_ for _ in ()).throw(primary))
        assert caught.value is primary
        error_generation = generation_for(error_client)
        assert error_generation is not None
        error_lease = error_generation._gate.owner
        assert error_lease is not None and error_lease.unknown is True
        assert error_lease.progress_reservation is not None
        error_runner = error_lease.progress_reservation.runner
        assert error_runner is not None and error_runner.worker_returned.is_set()
        assert error_runner.future is not None and error_runner.future.done()
        assert error_group._members == {}
        assert retirement_blocked(error_client) is True
        error_result = await error_group.complete_and_wait(timeout=1)
        assert error_result.status is RequestCompletionStatus.UNKNOWN
    finally:
        if old_executor is None:
            loop._default_executor = None
        else:
            loop.set_default_executor(old_executor)
        one_worker.shutdown(wait=True)


@pytest.mark.asyncio
async def test_runner_submission_queued_then_raised_exits_idle_worker_but_stays_unknown(
    monkeypatch: pytest.MonkeyPatch,
):
    from concurrent.futures import ThreadPoolExecutor

    loop = asyncio.get_running_loop()
    old_executor = loop._default_executor
    one_worker = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(one_worker)
    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("runner-queued-then-raised"))
    original_run_in_executor = loop.run_in_executor
    accepted_futures = []

    def queue_then_raise(executor, function, *args):
        future = original_run_in_executor(executor, function, *args)
        accepted_futures.append(future)
        raise RuntimeError("executor handoff became ambiguous")

    monkeypatch.setattr(loop, "run_in_executor", queue_then_raise)
    callable_calls = []
    try:
        with bind_request_group(group), pytest.raises(ProviderUnavailableError):
            await run_native(
                client,
                lambda: callable_calls.append("must-not-run"),
            )

        generation = generation_for(client)
        assert generation is not None
        lease = generation._gate.owner
        assert lease is not None and lease.unknown is True
        reservation = lease.progress_reservation
        assert reservation is not None and reservation.active
        runner = reservation.runner
        assert runner is not None and runner.unknown is True
        assert runner.future is None
        assert len(accepted_futures) == 1
        await asyncio.wait_for(asyncio.shield(accepted_futures[0]), timeout=2)
        assert runner.worker_returned.is_set()
        assert lease.unknown is True
        assert callable_calls == []
        assert client.generate_calls == 0
        result = await group.complete_and_wait(timeout=1)
        assert result.status is RequestCompletionStatus.UNKNOWN
        assert retirement_blocked(client) is True
        assert syncs == []
    finally:
        if old_executor is None:
            loop._default_executor = None
        else:
            loop.set_default_executor(old_executor)
        if accepted_futures and accepted_futures[0].done():
            one_worker.shutdown(wait=True)
        else:
            _unsettled_native_test_workers.append((one_worker, *accepted_futures))


def test_owned_constructor_never_falls_back_when_backend_cannot_be_qualified():
    client, backend, _syncs = _backend()
    constructor_calls = tuple(backend.Llama.constructor_calls)
    backend.llama_cpp = SimpleNamespace()
    sys.modules["llama_cpp.llama_cpp"] = SimpleNamespace()
    unqualified_type = make_owned_llama_class(backend)
    with pytest.raises(NativeContextUnavailableError):
        unqualified_type()

    assert tuple(backend.Llama.constructor_calls) == constructor_calls
    assert client.generate_calls == 0


def test_unsupported_constructor_close_surface_is_rejected_before_backend_init(
    monkeypatch: pytest.MonkeyPatch,
):
    _client, backend, _syncs = _backend()
    constructor_calls = tuple(backend.Llama.constructor_calls)
    monkeypatch.setattr(backend.Llama, "close", property(lambda _self: None))

    with pytest.raises(NativeContextUnavailableError):
        make_owned_llama_class(backend)

    assert tuple(backend.Llama.constructor_calls) == constructor_calls


def test_constructor_binding_change_is_rejected_before_backend_entry(
    monkeypatch: pytest.MonkeyPatch,
):
    _client, backend, _syncs = _backend()
    owned_type = make_owned_llama_class(backend)
    constructor_calls = tuple(backend.Llama.constructor_calls)
    replacement_calls = []

    def replacement_init(self):
        replacement_calls.append(self)

    monkeypatch.setattr(backend.Llama, "__init__", replacement_init)

    with pytest.raises(NativeContextUnavailableError):
        owned_type()

    assert replacement_calls == []
    assert tuple(backend.Llama.constructor_calls) == constructor_calls


def test_constructor_code_change_is_rejected_before_backend_entry():
    _client, backend, _syncs = _backend()
    owned_type = make_owned_llama_class(backend)
    original_init = backend.Llama.__init__
    original_code = original_init.__code__
    constructor_calls = tuple(backend.Llama.constructor_calls)

    def replacement_init(self):
        type(self).constructor_calls.append(id(self))

    replacement_code = replacement_init.__code__.replace(co_freevars=original_code.co_freevars)
    assert len(replacement_code.co_freevars) == len(original_code.co_freevars)
    original_init.__code__ = replacement_code
    try:
        with pytest.raises(NativeContextUnavailableError):
            owned_type()
        assert tuple(backend.Llama.constructor_calls) == constructor_calls
    finally:
        original_init.__code__ = original_code


def test_missing_required_executable_provenance_rejects_before_construction(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    client, backend, _syncs = _backend()
    constructor_calls = tuple(backend.Llama.constructor_calls)
    original_provenance = llama_context_owner._callable_provenance

    for unpinned in (
        backend.Llama.close,
        backend.Llama.generate,
        backend.Llama.sample,
    ):

        def missing_provenance(callback, *, selected=unpinned):
            function = getattr(callback, "__func__", callback)
            if function is selected:
                return None
            return original_provenance(callback)

        with monkeypatch.context() as patch:
            patch.setattr(llama_context_owner, "_callable_provenance", missing_provenance)
            with pytest.raises(NativeContextUnavailableError):
                make_owned_llama_class(backend)

    assert tuple(backend.Llama.constructor_calls) == constructor_calls
    assert generation_for(client) is not None


def test_constructor_close_change_is_rejected_before_backend_entry(
    monkeypatch: pytest.MonkeyPatch,
):
    _client, backend, _syncs = _backend()
    owned_type = make_owned_llama_class(backend)
    constructor_calls = tuple(backend.Llama.constructor_calls)
    replacement_calls = []

    def replacement_close(self):
        replacement_calls.append(self)

    monkeypatch.setattr(backend.Llama, "close", replacement_close)

    with pytest.raises(NativeContextUnavailableError):
        owned_type()

    assert replacement_calls == []
    assert tuple(backend.Llama.constructor_calls) == constructor_calls


def test_nonfunction_constructor_binding_is_rejected_before_backend_init(
    monkeypatch: pytest.MonkeyPatch,
):
    _client, backend, _syncs = _backend()
    constructor_calls = tuple(backend.Llama.constructor_calls)
    monkeypatch.setattr(backend.Llama, "__init__", property(lambda _self: None))

    with pytest.raises(NativeContextUnavailableError):
        make_owned_llama_class(backend)

    assert tuple(backend.Llama.constructor_calls) == constructor_calls


@pytest.mark.asyncio
async def test_live_generation_rejects_constructor_binding_change_before_native_entry(
    monkeypatch: pytest.MonkeyPatch,
):
    client, backend, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    group = create_request_group(_binding("constructor-binding-change"))

    def replacement_init(self):
        self.untrusted_constructor_entered = True

    monkeypatch.setattr(backend.Llama, "__init__", replacement_init)
    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        await run_native(client, client.generate, "must-not-enter")

    result = await group.complete_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert client.generate_calls == 0
    assert syncs == []
    assert generation._quarantined is True


@pytest.mark.asyncio
async def test_cuda_namespace_ownership_does_not_claim_completion_qualification(
    monkeypatch: pytest.MonkeyPatch,
):
    _client, cpu_backend, _syncs = _backend(monkeypatch)

    class CudaLlama(cpu_backend.Llama):
        pass

    CudaLlama.__module__ = "llama_cpp_cuda.llama"
    cuda_llama = ModuleType("llama_cpp_cuda.llama")
    cuda_llama.Llama = CudaLlama
    cuda_low_level = SimpleNamespace(
        __name__="llama_cpp_cuda.llama_cpp",
        llama_synchronize=cpu_backend.llama.llama_cpp.llama_synchronize,
    )
    cuda_llama.llama_cpp = cuda_low_level
    cuda_format = ModuleType("llama_cpp_cuda.llama_chat_format")
    cuda_format.get_chat_completion_handler = (
        cpu_backend.llama_chat_format.get_chat_completion_handler
    )
    cuda_backend = ModuleType("llama_cpp_cuda")
    cuda_backend.Llama = CudaLlama
    cuda_backend.llama = cuda_llama
    cuda_backend.llama_chat_format = cuda_format
    monkeypatch.setitem(sys.modules, "llama_cpp_cuda", cuda_backend)
    monkeypatch.setitem(sys.modules, "llama_cpp_cuda.llama", cuda_llama)
    monkeypatch.setitem(sys.modules, "llama_cpp_cuda.llama_chat_format", cuda_format)
    monkeypatch.setitem(sys.modules, "llama_cpp_cuda.llama_cpp", cuda_low_level)

    owned_type = make_owned_llama_class(cuda_backend)
    cuda_client = owned_type()
    generation = generation_for(cuda_client)

    assert generation is not None
    assert generation.validate() is cuda_client
    assert generation.qualified is False
    assert generation.handler_qualified is False
    assert generation.tokenizer_qualified is False
    group = create_request_group(_binding("cuda-owned-unknown"))
    with bind_request_group(group):
        value = await run_native(cuda_client, lambda: "safe-value")
    result = await group.complete_and_wait(timeout=2)

    assert value == "safe-value"
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert _client.generate_calls == 0
    assert cuda_client.generate_calls == 0


def test_owned_constructor_reserves_registry_capacity_before_backend_init(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    _client, backend, _syncs = _backend()
    calls_before = tuple(backend.Llama.constructor_calls)
    monkeypatch.setattr(llama_context_owner, "MAX_LLAMA_GENERATIONS", 0)
    owned_type = make_owned_llama_class(backend)

    with pytest.raises(NativeContextUnavailableError):
        owned_type()

    assert tuple(backend.Llama.constructor_calls) == calls_before


def test_concurrent_owned_constructors_release_only_their_reservation(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    _client, backend, _syncs = _backend()
    prior_qualifier = llama_context_owner._qualify_handler_with_provenance
    qualify_entered = threading.Event()
    allow_qualify = threading.Event()
    created = []
    failures = []

    with llama_context_owner._generations_lock:
        existing = sum(
            generation.client is not None
            for generation in llama_context_owner._generations.values()
        ) + len(llama_context_owner._failed_construction_owners)
        reservations_before = llama_context_owner._generation_construction_reservations
        tokens_before = set(llama_context_owner._generation_construction_tokens)
    monkeypatch.setattr(llama_context_owner, "MAX_LLAMA_GENERATIONS", existing + 1)

    def blocked_qualifier(client, selected_backend):
        qualify_entered.set()
        if not allow_qualify.wait(timeout=2):
            raise TimeoutError("controlled constructor did not release")
        return prior_qualifier(client, selected_backend)

    monkeypatch.setattr(
        llama_context_owner,
        "_qualify_handler_with_provenance",
        blocked_qualifier,
    )
    owned_type = make_owned_llama_class(backend)

    def construct_first():
        try:
            created.append(owned_type())
        except BaseException as error:
            failures.append(error)

    constructor = threading.Thread(target=construct_first)
    constructor.start()
    try:
        assert qualify_entered.wait(timeout=2)
        with llama_context_owner._generations_lock:
            assert (
                llama_context_owner._generation_construction_reservations == reservations_before + 1
            )
            assert len(llama_context_owner._generation_construction_tokens - tokens_before) == 1
            assert tokens_before <= llama_context_owner._generation_construction_tokens
        calls_before_second = tuple(backend.Llama.constructor_calls)
        with pytest.raises(NativeContextUnavailableError):
            owned_type()
        assert tuple(backend.Llama.constructor_calls) == calls_before_second
    finally:
        allow_qualify.set()
        constructor.join(timeout=2)

    assert not constructor.is_alive()
    assert failures == []
    assert len(created) == 1
    assert generation_for(created[0]) is not None
    with llama_context_owner._generations_lock:
        assert llama_context_owner._generation_construction_reservations == reservations_before
        assert llama_context_owner._generation_construction_tokens == tokens_before


def test_owned_constructor_retains_resource_when_post_init_registration_fails(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    _client, backend, _syncs = _backend()
    registered = []

    def fail_qualification(client, selected_backend):
        registered.append((client, selected_backend))
        raise RuntimeError("controlled qualification failure")

    monkeypatch.setattr(
        llama_context_owner,
        "_qualify_handler_with_provenance",
        fail_qualification,
    )
    owned_type = make_owned_llama_class(backend)

    with pytest.raises(NativeContextUnavailableError):
        owned_type()

    assert len(registered) == 1
    failed_client, selected_backend = registered[0]
    assert selected_backend is backend
    assert failed_client.close_calls == 1
    assert id(failed_client) not in llama_context_owner._failed_construction_owners
    assert llama_context_owner._generation_construction_reservations == 0
    assert generation_for(failed_client) is None


def test_owned_constructor_releases_exact_token_when_registrar_stub_returns_false(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    _client, backend, _syncs = _backend()
    captured = []
    original_init = backend.Llama.__init__

    def capture_init(self):
        original_init(self)
        captured.append(self)

    monkeypatch.setattr(backend.Llama, "__init__", capture_init)
    monkeypatch.setattr(
        llama_context_owner,
        "_register_constructed_client",
        lambda *_args, **_kwargs: False,
    )
    with llama_context_owner._generations_lock:
        reservations_before = llama_context_owner._generation_construction_reservations
        tokens_before = set(llama_context_owner._generation_construction_tokens)
    owned_type = make_owned_llama_class(backend)

    with pytest.raises(NativeContextUnavailableError):
        owned_type()

    assert len(captured) == 1
    failed_client = captured[0]
    assert failed_client.close_calls == 1
    assert id(failed_client) not in llama_context_owner._failed_construction_owners
    with llama_context_owner._generations_lock:
        assert llama_context_owner._generation_construction_reservations == reservations_before
        assert llama_context_owner._generation_construction_tokens == tokens_before


def test_failed_constructor_retains_owner_when_checked_backend_close_fails(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    _client, backend, _syncs = _backend()

    def fail_qualification(client, selected_backend):
        raise RuntimeError("controlled qualification failure")

    monkeypatch.setattr(
        llama_context_owner,
        "_qualify_handler_with_provenance",
        fail_qualification,
    )

    def fail_close(self):
        self.close_calls += 1
        raise RuntimeError("controlled close failure")

    monkeypatch.setattr(backend.Llama, "close", fail_close)
    owned_type = make_owned_llama_class(backend)
    client_id = None
    try:
        with pytest.raises(NativeContextUnavailableError):
            owned_type()
        client_id = backend.Llama.constructor_calls[-1]
        failed_client = llama_context_owner._failed_construction_owners[client_id]
        assert failed_client.close_calls == 1
        assert llama_context_owner._generation_construction_reservations == 0
    finally:
        if client_id is not None:
            llama_context_owner._failed_construction_owners.pop(client_id, None)


def test_constructor_exception_retains_partial_owner_after_close_code_changes(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    _client, backend, _syncs = _backend()
    original_init = backend.Llama.__init__
    constructor_error = RuntimeError("controlled partial allocation failure")
    replacement_calls = []

    def initialize_then_fail(self):
        original_init(self)
        type(self).close = replacement_close
        raise constructor_error

    def replacement_close(self):
        replacement_calls.append(self)

    monkeypatch.setattr(backend.Llama, "__init__", initialize_then_fail)
    owned_type = make_owned_llama_class(backend)
    client_id = None
    try:
        with pytest.raises(RuntimeError) as raised:
            owned_type()
        assert raised.value is constructor_error
        client_id = backend.Llama.constructor_calls[-1]
        partial_client = llama_context_owner._failed_construction_owners[client_id]
        assert replacement_calls == []
        assert partial_client.close_calls == 0
        assert partial_client._aurora_native_registration_failed is True
        assert llama_context_owner._generation_construction_reservations == 0
    finally:
        if client_id is not None:
            with llama_context_owner._generations_lock:
                llama_context_owner._failed_construction_owners.pop(client_id, None)
                llama_context_owner._failed_construction_close_states.pop(client_id, None)
                llama_context_owner._failed_construction_close_awaitables.pop(client_id, None)
                llama_context_owner._failed_construction_close_tasks.pop(client_id, None)


def test_retained_partial_constructor_cannot_be_initialized_again(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    _client, backend, _syncs = _backend()
    original_init = backend.Llama.__init__
    constructor_error = RuntimeError("controlled partial construction")

    def initialize_then_fail(self):
        original_init(self)
        raise constructor_error

    monkeypatch.setattr(backend.Llama, "__init__", initialize_then_fail)
    owned_type = make_owned_llama_class(backend)
    client_id = None
    try:
        with pytest.raises(RuntimeError) as raised:
            owned_type()
        assert raised.value is constructor_error
        client_id = backend.Llama.constructor_calls[-1]
        partial = llama_context_owner._failed_construction_owners[client_id]
        original_context = partial._ctx
        calls = tuple(backend.Llama.constructor_calls)

        with pytest.raises(NativeContextUnavailableError):
            type(partial).__init__(partial)

        assert tuple(backend.Llama.constructor_calls) == calls
        assert partial._ctx is original_context
        assert llama_context_owner._failed_construction_owners[client_id] is partial
    finally:
        if client_id is not None:
            with llama_context_owner._generations_lock:
                llama_context_owner._failed_construction_owners.pop(client_id, None)
                llama_context_owner._failed_construction_close_states.pop(client_id, None)
                llama_context_owner._failed_construction_close_awaitables.pop(client_id, None)
                llama_context_owner._failed_construction_close_tasks.pop(client_id, None)


def test_partial_constructor_retains_owner_after_captured_close_code_mutation(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    _client, backend, _syncs = _backend()
    original_init = backend.Llama.__init__
    captured_close = backend.Llama.close
    original_close_code = captured_close.__code__
    replacement_close_code = (
        lambda self: setattr(self, "replacement_close_called", True)
    ).__code__.replace(co_freevars=original_close_code.co_freevars)
    constructor_error = RuntimeError("partial allocation after close mutation")

    def initialize_mutate_close_then_fail(self):
        original_init(self)
        captured_close.__code__ = replacement_close_code
        raise constructor_error

    monkeypatch.setattr(backend.Llama, "__init__", initialize_mutate_close_then_fail)
    owned_type = make_owned_llama_class(backend)
    client_id = None
    try:
        with pytest.raises(RuntimeError) as raised:
            owned_type()
        assert raised.value is constructor_error
        client_id = backend.Llama.constructor_calls[-1]
        partial = llama_context_owner._failed_construction_owners[client_id]
        assert backend.Llama.close is captured_close
        assert captured_close.__code__ is replacement_close_code
        assert not hasattr(partial, "replacement_close_called")
        assert partial.close_calls == 0
        assert llama_context_owner._failed_construction_owners[client_id] is partial
    finally:
        captured_close.__code__ = original_close_code
        if client_id is not None:
            with llama_context_owner._generations_lock:
                llama_context_owner._failed_construction_owners.pop(client_id, None)
                llama_context_owner._failed_construction_close_states.pop(client_id, None)
                llama_context_owner._failed_construction_close_awaitables.pop(client_id, None)
                llama_context_owner._failed_construction_close_tasks.pop(client_id, None)


@pytest.mark.asyncio
async def test_failed_constructor_close_is_deferred_off_loop_and_releases_exact_owner(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    _client, backend, _syncs = _backend()

    def fail_qualification(client, selected_backend):
        raise RuntimeError("controlled qualification failure")

    monkeypatch.setattr(
        llama_context_owner,
        "_qualify_handler_with_provenance",
        fail_qualification,
    )
    original_to_thread = asyncio.to_thread
    close_body_returned = asyncio.Event()
    allow_task_settlement = asyncio.Event()

    async def hold_after_close_body(function, /, *args, **kwargs):
        result = await original_to_thread(function, *args, **kwargs)
        close_body_returned.set()
        await allow_task_settlement.wait()
        return result

    monkeypatch.setattr(llama_context_owner.asyncio, "to_thread", hold_after_close_body)
    owned_type = make_owned_llama_class(backend)
    created_client_ids: list[int] = []

    try:
        with pytest.raises(NativeContextUnavailableError):
            owned_type()

        failed_client_id = backend.Llama.constructor_calls[-1]
        created_client_ids.append(failed_client_id)
        failed_client = llama_context_owner._failed_construction_owners[failed_client_id]
        assert failed_client.close_calls == 0
        close_state = llama_context_owner._failed_construction_close_states[failed_client_id]
        assert close_state[0] is failed_client
        assert close_state[1] == "deferred"
        close_task = llama_context_owner._failed_construction_close_tasks[failed_client_id]
        await asyncio.wait_for(close_body_returned.wait(), timeout=2)
        assert failed_client.close_calls == 1
        assert not close_task.done()
        assert llama_context_owner._failed_construction_owners[failed_client_id] is failed_client
        close_state = llama_context_owner._failed_construction_close_states[failed_client_id]
        assert close_state[0] is failed_client
        assert close_state[1] == "body_returned"
        allow_task_settlement.set()
        assert await asyncio.wait_for(asyncio.shield(close_task), timeout=2) is True
        await asyncio.sleep(0)
        assert failed_client_id not in llama_context_owner._failed_construction_owners
        assert failed_client_id not in llama_context_owner._failed_construction_close_states
        assert llama_context_owner._generation_construction_reservations == 0
        assert llama_context_owner._generation_construction_tokens == set()

        close_body_returned.clear()
        allow_task_settlement.clear()
        with pytest.raises(NativeContextUnavailableError):
            owned_type()
        cancelled_client_id = backend.Llama.constructor_calls[-1]
        created_client_ids.append(cancelled_client_id)
        cancelled_client = llama_context_owner._failed_construction_owners[cancelled_client_id]
        cancelled_task = llama_context_owner._failed_construction_close_tasks[cancelled_client_id]
        await asyncio.wait_for(close_body_returned.wait(), timeout=2)
        assert cancelled_client.close_calls == 1
        assert not cancelled_task.done()
        cancelled_task.cancel()
        await asyncio.gather(cancelled_task, return_exceptions=True)
        assert cancelled_task.cancelled()
        assert (
            llama_context_owner._failed_construction_owners[cancelled_client_id] is cancelled_client
        )
        assert (
            llama_context_owner._failed_construction_close_states[cancelled_client_id][1]
            == "body_returned"
        )
    finally:
        allow_task_settlement.set()
        with llama_context_owner._generations_lock:
            for client_id in created_client_ids:
                llama_context_owner._failed_construction_owners.pop(client_id, None)
                llama_context_owner._failed_construction_close_states.pop(client_id, None)
                llama_context_owner._failed_construction_close_tasks.pop(client_id, None)
                llama_context_owner._failed_construction_close_awaitables.pop(client_id, None)


@pytest.mark.asyncio
async def test_failed_constructor_ambiguous_task_creation_retains_closed_owner(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import llama_context_owner

    _client, backend, _syncs = _backend()

    def fail_qualification(client, selected_backend):
        raise RuntimeError("controlled qualification failure")

    monkeypatch.setattr(
        llama_context_owner,
        "_qualify_handler_with_provenance",
        fail_qualification,
    )
    loop = asyncio.get_running_loop()
    previous_factory = loop.get_task_factory()
    queued_tasks: list[asyncio.Task] = []

    def enqueue_then_raise(loop, coroutine, context=None):
        if context is None:
            task = asyncio.tasks.Task(coroutine, loop=loop)
        else:
            task = asyncio.tasks.Task(coroutine, loop=loop, context=context)
        queued_tasks.append(task)
        raise RuntimeError("task handoff became ambiguous")

    owned_type = make_owned_llama_class(backend)
    failed_client_id = None
    try:
        loop.set_task_factory(enqueue_then_raise)
        with pytest.raises(NativeContextUnavailableError):
            owned_type()
        failed_client_id = backend.Llama.constructor_calls[-1]
        failed_client = llama_context_owner._failed_construction_owners[failed_client_id]
    finally:
        loop.set_task_factory(previous_factory)

    assert len(queued_tasks) == 1
    assert await asyncio.wait_for(asyncio.shield(queued_tasks[0]), timeout=3) is True
    assert failed_client.close_calls == 1
    assert llama_context_owner._failed_construction_owners[failed_client_id] is failed_client
    assert (
        llama_context_owner._failed_construction_close_states[failed_client_id][1]
        == "body_returned"
    )
    assert failed_client_id not in llama_context_owner._failed_construction_close_tasks
    try:
        assert (
            llama_context_owner._failed_construction_close_awaitables[failed_client_id]
            is queued_tasks[0].get_coro()
        )
    finally:
        with llama_context_owner._generations_lock:
            llama_context_owner._failed_construction_owners.pop(failed_client_id, None)
            llama_context_owner._failed_construction_close_states.pop(failed_client_id, None)
            llama_context_owner._failed_construction_close_awaitables.pop(failed_client_id, None)


@pytest.mark.asyncio
async def test_unexpected_runner_failure_cannot_complete_known_context(
    monkeypatch: pytest.MonkeyPatch,
):
    from concurrent.futures import ThreadPoolExecutor

    from app.services.orchestrator import native_worker

    loop = asyncio.get_running_loop()
    old_executor = loop._default_executor
    one_worker = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(one_worker)
    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("runner-body-failure"))
    original_runner = native_worker._run_native_command_runner

    def fail_after_worker_return(runner):
        original_runner(runner)
        raise RuntimeError("controlled executor settlement failure")

    monkeypatch.setattr(native_worker, "_run_native_command_runner", fail_after_worker_return)
    try:
        with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
            await asyncio.wait_for(
                run_native(client, lambda: list(client.generate("settled-body"))),
                timeout=2,
            )
        generation = generation_for(client)
        assert generation is not None
        lease = generation._gate.owner
        assert lease is not None and lease.unknown is True
        assert lease.progress_reservation is not None
        runner = lease.progress_reservation.runner
        assert runner is not None and runner.unknown is True
        assert runner.worker_returned.is_set()
        assert runner.future is not None and runner.future.done()
        assert client.generate_calls == 1
        result = await group.complete_and_wait(timeout=1)
        assert result.status is RequestCompletionStatus.UNKNOWN
        assert syncs == [client.ctx]
        assert retirement_blocked(client) is True
        assert result.reason == "native_runner_task_failed"
    finally:
        if old_executor is None:
            loop._default_executor = None
        else:
            loop.set_default_executor(old_executor)
        one_worker.shutdown(wait=True)


@pytest.mark.asyncio
async def test_native_synchronization_failure_keeps_group_unknown_and_gate_closed():
    client, _backend_value, syncs = _backend(synchronization_failure=True)
    alias = SimpleNamespace(client=client)
    group = create_request_group(_binding("sync-failure"))

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        await run_native(alias, lambda: list(alias.client.generate("sync-failure")))

    result = await group.stop_and_wait(timeout=1)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert syncs == []
    assert retirement_blocked(client) is True
    with pytest.raises(NativeContextUnavailableError):
        client.generate("after-sync-failure")


def test_known_client_rejects_reentrant_inference_from_token_callback():
    client, _backend_value, syncs = _backend()
    client.on_generation_step = lambda: client.generate("reentrant")
    iterator = client.generate("outer")

    # The generated token body is the only child allowed to evaluate.  A
    # callback that tries to start a second top-level generation cannot reuse
    # the active lease.
    from app.services.orchestrator.llama_context_owner import _current_lease

    assert _current_lease.get() is None
    with pytest.raises(NativeContextUnavailableError):
        next(iterator)
    iterator.close()

    assert client.generate_calls == 1
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_caught_nested_async_callback_admission_preserves_original_owner():
    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("nested-callback-admission"))
    observer_rejections = []

    def attempt_nested_async_operation():
        try:
            asyncio.run(
                run_native(
                    client,
                    lambda: list(client.generate("nested-callback")),
                )
            )
        except RuntimeError:
            observer_rejections.append("rejected")

    client.on_generation_step = attempt_nested_async_operation
    with bind_request_group(group):
        result_value = await run_native(
            client, lambda: list(client.generate("accepted-callback-owner"))
        )

    result = await group.complete_and_wait(timeout=2)
    assert result_value == ["accepted-callback-owner"]
    assert observer_rejections == ["rejected"]
    assert result.status is RequestCompletionStatus.COMPLETE
    assert client.generate_calls == 1
    assert syncs == [client.ctx]


def _release_quiescent_direct_cleanup_for_test(client, generation):
    from app.services.orchestrator import native_worker

    owner_id = id(client)
    with native_worker._registry_guard:
        assert native_worker._lifecycles.get(owner_id) is None
        assert native_worker._direct_calls.get(owner_id) is None
        assert native_worker._worker_tasks.get(owner_id) is None
        assert native_worker._stream_tasks.get(owner_id) is None
        assert generation._gate.owner is None

        pending = native_worker._direct_cleanups.get(owner_id)
        assert pending is not None
        assert pending.key == owner_id
        assert pending.owner() is client
        assert pending.uncertain is True
        assert len(pending.references) == 1
        (token,) = pending.references
        assert isinstance(token, native_worker._DirectCallToken)
        assert token.owner is client

        direct_record = token.record
        assert direct_record.owner is client
        assert direct_record.lifecycle is None
        assert direct_record.active == 0
        assert direct_record.tokens == {}
        assert token.active_depth == 0
        assert token.active_thread_id is None
        assert token.native_entry_attempted is False
        assert token.retained_context_state == "none"
        assert token.retained_context_manager is None
        assert token.retained_context_lease is None
        assert token.iterator is None
        assert token.cleanup_reservations == 0
        assert token.lease_cleanup_credit == 0
        assert token.progress_cleanup_credit == 0
        assert token.independent_cleanup_credit == 0
        assert token.lease_cleanup_source is None
        assert token.progress_cleanup_source is None
        assert native_worker._direct_cleanups.get(owner_id) is pending
        native_worker._direct_cleanups.pop(owner_id)


def test_structural_child_rejects_rebound_callable_with_matching_method_name():
    from types import MethodType

    client, _backend_value, syncs = _backend()

    class Wrapper:
        def __init__(self, wrapped_client):
            self.client = wrapped_client

        @direct_native_call
        def _stream(self):
            yield from self.client.generate("intended-stream")

        @direct_native_call(cleanup_slots=2)
        def _generate(self):
            self._stream = MethodType(rebound_stream, self)
            return self._stream()

    @direct_native_call
    def rebound_stream(self):
        yield from self.client.generate("rebound-stream")

    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    wrapper = Wrapper(client)
    bind_native_wrapper(wrapper, client)
    generation = generation_for(client)
    assert generation is not None
    escaped = wrapper._generate()
    rejected_advance = False
    try:
        with pytest.raises(ProviderUnavailableError):
            next(escaped)
        rejected_advance = True

        assert client.generate_calls == 0
        assert syncs == []
    finally:
        if rejected_advance:
            _release_quiescent_direct_cleanup_for_test(client, generation)


def test_deferred_direct_iterator_duplicate_close_has_one_checked_owner():
    entered = threading.Event()
    release = threading.Event()
    close_calls = []

    class DirectProvider:
        @direct_native_call
        def stream(self):
            try:
                yield "first"
            finally:
                close_calls.append(threading.get_ident())
                entered.set()
                if not release.wait(timeout=3):
                    raise TimeoutError("direct iterator close latch did not release")

    iterator = DirectProvider().stream()
    assert next(iterator) == "first"
    outcomes = []

    def close():
        try:
            iterator.close()
            outcomes.append("closed")
        except BaseException as error:
            outcomes.append(type(error))

    first = threading.Thread(target=close)
    second = threading.Thread(target=close)
    first.start()
    assert entered.wait(timeout=2)
    second.start()
    assert second.is_alive()
    release.set()
    first.join(timeout=3)
    second.join(timeout=3)

    assert not first.is_alive() and not second.is_alive()
    assert outcomes == ["closed", "closed"]
    assert len(close_calls) == 1


@pytest.mark.asyncio
async def test_registered_direct_iterator_close_can_finish_during_retirement():
    from app.services.orchestrator import native_worker
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    client, _backend_value, syncs = _backend(terminal_chat_stream=True)
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    bind_native_wrapper(model, client)
    group = create_request_group(_binding("retiring-direct-stream-close"))

    with bind_request_group(group):
        stream = model._stream([HumanMessage(content="hello")])
        first = await run_native(client, next, stream)
    assert first.message.content
    lifecycle = native_worker._get_lifecycle(client, asyncio.get_running_loop(), create=False)
    assert lifecycle is not None
    generation = generation_for(client)
    assert generation is not None
    lease = generation._gate.owner
    assert lease is not None and lease.progress_reservation is not None
    runner = lease.progress_reservation.runner
    assert runner is not None and runner.future is not None
    retirement = asyncio.create_task(retire_native(client))
    try:
        for _ in range(100):
            with lifecycle.lock:
                retiring = lifecycle.state == "retiring"
            if retiring:
                break
            await asyncio.sleep(0)
        assert retiring
        assert not retirement.done()

        with bind_request_group(group):
            await run_native(client, stream.close)

        result = await asyncio.wait_for(asyncio.shield(retirement), timeout=3)
        assert result.status is RetirementStatus.COMPLETE
        assert client.iterator_close_calls == 1
        assert client.close_calls == 1
        assert syncs == [client.ctx]
        assert runner.worker_returned.is_set()
        assert runner.future.done() and not runner.future.cancelled()
        assert runner.future.exception() is None
        with lifecycle.lock:
            assert lifecycle.retirement_task is not None
            assert lifecycle.retirement_task.done()
            assert lifecycle.terminal_result is result
            assert lifecycle.direct_operations == 0
            assert lifecycle.operations == {}
    finally:
        if not retirement.done():
            retirement.cancel()
            _unsettled_native_test_workers.append((retirement, stream, client))

    completion = await group.complete_and_wait(timeout=2)
    assert completion.status is RequestCompletionStatus.COMPLETE


@pytest.mark.asyncio
async def test_duplicate_registered_close_rejects_without_poisoning_owner(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import native_worker
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    loop = asyncio.get_running_loop()
    close_entered = asyncio.Event()
    release_close = threading.Event()
    client, _backend_value, syncs = _backend(terminal_chat_stream=True)

    def block_raw_close():
        loop.call_soon_threadsafe(close_entered.set)
        if not release_close.wait(timeout=5):
            raise TimeoutError("controlled close did not release")

    client.on_iterator_close = block_raw_close
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    bind_native_wrapper(model, client)
    group = create_request_group(_binding("duplicate-retiring-direct-close"))

    with bind_request_group(group):
        stream = model._stream([HumanMessage(content="hello")])
        first = await run_native(client, next, stream)
    assert first.message.content

    generation = generation_for(client)
    assert generation is not None
    lease = generation._gate.owner
    assert lease is not None and lease.progress_reservation is not None
    runner = lease.progress_reservation.runner
    assert runner is not None and runner.future is not None
    lifecycle = native_worker._get_lifecycle(client, asyncio.get_running_loop(), create=False)
    assert lifecycle is not None
    settlement_callback_entered = asyncio.Event()
    release_settlement_callback = asyncio.Event()
    accepted_operation = None
    settlement_tasks = []
    original_runner_operation_settled = native_worker._runner_operation_settled

    def defer_accepted_settlement(operation):
        if operation is not accepted_operation:
            original_runner_operation_settled(operation)
            return

        settlement_callback_entered.set()

        async def publish_after_test_observation():
            await release_settlement_callback.wait()
            original_runner_operation_settled(operation)

        settlement_tasks.append(
            asyncio.get_running_loop().create_task(publish_after_test_observation())
        )

    monkeypatch.setattr(native_worker, "_runner_operation_settled", defer_accepted_settlement)
    retirement = asyncio.create_task(retire_native(client))
    close_task = None
    try:
        for _ in range(100):
            with lifecycle.lock:
                retiring = lifecycle.state == "retiring"
            if retiring:
                break
            await asyncio.sleep(0)
        assert retiring

        with bind_request_group(group):
            close_task = asyncio.create_task(run_native(client, stream.close))
        await asyncio.wait_for(close_entered.wait(), timeout=2)

        with lifecycle.lock:
            assert len(lifecycle.operations) == 1
            accepted_operation = next(iter(lifecycle.operations.values()))
            assert accepted_operation.registered_close_iterator is stream
            accepted_operation.references = ("mutable diagnostic replacement",)

        with bind_request_group(group), pytest.raises(ProviderUnavailableError):
            await asyncio.wait_for(run_native(client, stream.close), timeout=2)

        assert client.iterator_close_calls == 1
        assert lease.unknown is False
        with lifecycle.lock:
            assert lifecycle.uncertain is False
            assert lifecycle.failure is None
            assert len(lifecycle.operations) == 1
            assert accepted_operation.references == ("mutable diagnostic replacement",)
            assert accepted_operation.registered_close_iterator is stream
        assert group.contains_active_member(lease.request_member)

        release_close.set()
        await asyncio.wait_for(settlement_callback_entered.wait(), timeout=2)
        assert accepted_operation.worker_returned.is_set()
        assert accepted_operation.state is native_worker._OperationState.BODY_RETURNED
        assert accepted_operation.runner_returned.is_set()
        assert accepted_operation.retained is True
        assert accepted_operation.runner_settled is not None
        assert not accepted_operation.runner_settled.done()
        assert accepted_operation.registered_close_iterator is stream

        with bind_request_group(group), pytest.raises(ProviderUnavailableError):
            await asyncio.wait_for(run_native(client, stream.close), timeout=2)
        assert lease.unknown is False
        with lifecycle.lock:
            assert lifecycle.uncertain is False
            assert lifecycle.failure is None
            assert lifecycle.operations == {accepted_operation.sequence: accepted_operation}
            assert accepted_operation.registered_close_iterator is stream
        assert group.contains_active_member(lease.request_member)

        release_settlement_callback.set()
        await asyncio.wait_for(asyncio.shield(close_task), timeout=3)
        result = await asyncio.wait_for(asyncio.shield(retirement), timeout=3)
        assert result.status is RetirementStatus.COMPLETE
        assert client.iterator_close_calls == 1
        assert client.close_calls == 1
        assert syncs == [client.ctx]
        assert runner.worker_returned.is_set()
        assert runner.future.done() and not runner.future.cancelled()
        assert runner.future.exception() is None
        assert accepted_operation.registered_close_iterator is None
        with lifecycle.lock:
            assert lifecycle.retirement_task is not None
            assert lifecycle.retirement_task.done()
            assert lifecycle.terminal_result is result
            assert lifecycle.operations == {}
            assert lifecycle.direct_operations == 0
    finally:
        release_close.set()
        release_settlement_callback.set()
        pending = [task for task in (close_task, retirement, *settlement_tasks) if task is not None]
        if pending:
            _, unresolved = await asyncio.wait(pending, timeout=1)
            if unresolved:
                _unsettled_native_test_workers.append((tuple(unresolved), stream, client))

    completion = await group.complete_and_wait(timeout=2)
    assert completion.status is RequestCompletionStatus.COMPLETE


def test_provider_owner_cycle_with_prefix_preserves_original_input():
    prefix = SimpleNamespace()
    first = SimpleNamespace()
    second = SimpleNamespace()
    prefix.bound = first
    first.bound = second
    second.bound = first

    assert provider_owner(prefix) is prefix


def test_handler_binding_change_quarantines_the_constructed_generation():
    client, _backend_value, _syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    client._chat_handlers = {"test-format": object()}

    with pytest.raises(NativeContextUnavailableError):
        generation.validate()
    assert generation.qualified is False


def test_constructed_generation_rejects_instance_native_method_replacement():
    client, _backend_value, _syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    client.sample = lambda *_args, **_kwargs: 999

    with pytest.raises(NativeContextUnavailableError):
        generation.validate()
    assert generation.qualified is False


def test_constructed_generation_pins_exact_base_native_helper_code(
    monkeypatch: pytest.MonkeyPatch,
):
    client, backend, _syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    original = backend.Llama.tokenize

    def replacement(self, prompt, *, add_bos, special):
        return original(self, prompt, add_bos=add_bos, special=special)

    monkeypatch.setattr(backend.Llama, "tokenize", replacement)

    with pytest.raises(NativeContextUnavailableError):
        generation.validate()

    assert generation.qualified is False
    assert client.generate_calls == 0


def test_constructed_generation_rejects_same_code_with_rebound_globals(
    monkeypatch: pytest.MonkeyPatch,
):
    from types import FunctionType

    client, backend, _syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    original = backend.Llama.tokenize
    rebound = FunctionType(
        original.__code__,
        dict(original.__globals__),
        original.__name__,
        original.__defaults__,
        original.__closure__,
    )
    rebound.__kwdefaults__ = original.__kwdefaults__
    monkeypatch.setattr(backend.Llama, "tokenize", rebound)

    with pytest.raises(NativeContextUnavailableError):
        generation.validate()

    assert generation.qualified is False
    assert client.generate_calls == 0


def test_positional_stream_arguments_keep_the_upstream_iterator_lifetime():
    client, _backend_value, syncs = _backend()

    completion = client.create_completion(True)
    assert list(completion) == [{"token": "completion"}]
    chat = client.create_chat_completion([], True)
    assert list(chat) == ["completion"]
    assert syncs == [client.ctx, client.ctx]


@pytest.mark.asyncio
async def test_real_pinned_jinja_handler_runs_through_owned_chat_adapter(
    monkeypatch: pytest.MonkeyPatch,
):
    client, backend, syncs = _backend(monkeypatch, real_jinja_handler=True)
    generation = generation_for(client)
    assert generation is not None and generation.handler_mode == "gguf_template"
    assert generation.qualified is True
    group = create_request_group(_binding("real-pinned-jinja"))

    with bind_request_group(group):
        result = await run_native(
            client,
            client.create_chat_completion,
            messages=[{"role": "user", "content": "hello"}],
            stream=False,
        )

    completion = await group.complete_and_wait(timeout=2)
    assert result["choices"][0]["message"]["content"] == "completion"
    assert completion.status is RequestCompletionStatus.COMPLETE
    assert [event[0] for event in client.evaluations] == [
        "tokenize",
        "completion-options",
        "factory",
        "start",
        "eval",
        "sample",
        "criteria",
    ]
    assert client.evaluations[0][1] == b"hello<eos>"
    assert client.evaluations[1][1]["stopping_criteria"] is not None
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_real_pinned_jinja_streaming_keeps_criteria_through_raw_generation(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    client, _backend_value, syncs = _backend(monkeypatch, real_jinja_handler=True)
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    bind_native_wrapper(model, client)
    group = create_request_group(_binding("real-pinned-jinja-stream"))

    async def collect():
        return [chunk async for chunk in model._astream([HumanMessage(content="hello")])]

    with bind_request_group(group):
        chunks = await asyncio.wait_for(collect(), timeout=4)
    completion = await group.complete_and_wait(timeout=2)

    assert len(chunks) == 2
    assert chunks[0].message.content == ""
    assert chunks[1].message.content == "completion"
    assert completion.status is RequestCompletionStatus.COMPLETE
    assert [event[0] for event in client.evaluations] == [
        "tokenize",
        "completion-options",
        "factory",
        "start",
        "eval",
        "sample",
        "criteria",
        "tail",
    ]
    assert client.evaluations[1][1]["stopping_criteria"] is not None
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_mutated_pinned_stopping_criteria_quarantines_before_next_token(
    monkeypatch: pytest.MonkeyPatch,
):
    client, _backend_value, syncs = _backend(monkeypatch, real_jinja_handler=True)
    group = create_request_group(_binding("mutated-stopping-criteria"))

    def mutate_after_first_validation():
        criteria = client.active_stopping_criteria
        assert criteria is not None
        criteria.append(lambda tokens, logits: False)

    client.on_generation_step = mutate_after_first_validation

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        await run_native(
            client,
            lambda: list(
                client.create_chat_completion(
                    messages=[{"role": "user", "content": "hello"}],
                    stream=True,
                )
            ),
        )

    result = await group.complete_and_wait(timeout=2)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert client.generate_calls == 1
    assert syncs == []


@pytest.mark.asyncio
async def test_original_worker_rejects_foreign_stopping_criteria_as_unknown(
    monkeypatch: pytest.MonkeyPatch,
):
    client, _backend_value, syncs = _backend(monkeypatch, real_jinja_handler=True)
    group = create_request_group(_binding("foreign-stopping-criteria"))
    callback_errors: list[BaseException] = []

    def pass_foreign_criteria_from_the_admitted_worker():
        try:
            client.create_completion(
                stream=True,
                stopping_criteria=[lambda tokens, logits: False],
            )
        except BaseException as error:
            callback_errors.append(error)
            raise

    client.on_generation_step = pass_foreign_criteria_from_the_admitted_worker

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        await run_native(
            client,
            lambda: list(
                client.create_chat_completion(
                    messages=[{"role": "user", "content": "hello"}],
                    stream=True,
                )
            ),
        )

    assert len(callback_errors) == 1
    assert isinstance(callback_errors[0], NativeContextUnavailableError)
    generation = generation_for(client)
    assert generation is not None
    lease = generation._gate.owner
    assert lease is not None and lease.unknown is True
    assert lease.reason == "native_option_binding_unverified"
    result = await group.complete_and_wait(timeout=2)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert result.reason == "native_option_binding_unverified"
    assert client.generate_calls == 1
    assert ("eval", "completion") not in client.evaluations
    assert syncs == []


@pytest.mark.asyncio
async def test_copied_stopping_criteria_context_cannot_reenter_live_lease(
    monkeypatch: pytest.MonkeyPatch,
):
    client, _backend_value, syncs = _backend(monkeypatch, real_jinja_handler=True)
    group = create_request_group(_binding("copied-stopping-criteria-context"))
    captured_contexts: list[contextvars.Context] = []
    captured_criteria: list[object] = []
    entered = threading.Event()
    release = threading.Event()
    copied_errors: list[BaseException] = []

    def capture_live_generation_context():
        copied = contextvars.copy_context()
        captured_contexts.append(copied)
        criteria = client.active_stopping_criteria
        assert criteria is not None
        captured_criteria.append(criteria)
        # Replay the exact live criteria and copied lease from another thread.
        # ContextVar identity alone must not authorize concurrent native work.
        for entrypoint, call_kwargs in (
            (
                client._create_completion,
                {"stream": True, "stopping_criteria": criteria},
            ),
            (
                client.create_chat_completion,
                {
                    "messages": [{"role": "user", "content": "replayed"}],
                    "stream": True,
                    "stopping_criteria": criteria,
                },
            ),
        ):
            observer_context = copied.copy()

            def replay_live_context(
                context=observer_context, method=entrypoint, kwargs=call_kwargs
            ):
                try:
                    context.run(method, **kwargs)
                except BaseException as error:
                    copied_errors.append(error)

            observer = threading.Thread(target=replay_live_context)
            observer.start()
            observer.join(timeout=2)
            if observer.is_alive():
                copied_errors.append(TimeoutError("copied observer did not return"))
        entered.set()
        if not release.wait(timeout=4):
            raise TimeoutError("controlled generation did not release")

    client.on_generation_step = capture_live_generation_context

    with bind_request_group(group):
        generation = asyncio.create_task(
            run_native(
                client,
                lambda: list(
                    client.create_chat_completion(
                        messages=[{"role": "user", "content": "hello"}],
                        stream=True,
                    )
                ),
            )
        )

    try:
        assert await asyncio.to_thread(entered.wait, 2)
        assert len(captured_contexts) == 1
        assert len(copied_errors) == 2
        assert all(isinstance(error, NativeContextUnavailableError) for error in copied_errors)
        lease = generation_for(client)._gate.owner
        assert lease is not None and lease.unknown is False
        assert lease.reason is None
        assert client.active_stopping_criteria is captured_criteria[0]
        assert client.generate_calls == 1
    finally:
        release.set()

    await asyncio.wait_for(generation, timeout=3)
    result = await group.complete_and_wait(timeout=2)
    assert result.status is RequestCompletionStatus.COMPLETE
    assert client.evaluations.count(("eval", "completion")) == 1
    assert client.generate_calls == 1
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_structural_child_rechecks_captured_callable_code_before_first_advance():
    client, _backend_value, syncs = _backend()
    model = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf", client=client, streaming=True
    )
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    bind_native_wrapper(model, client)
    group = create_request_group(_binding("mutated-structural-child"))
    target = ChatLlamaCpp._stream.__wrapped__
    original_code = target.__code__

    def replacement(self, messages, stop=None, run_manager=None, **kwargs):
        self._replacement_entered = True
        del self, messages, stop, run_manager, kwargs
        yield "replacement must not execute"

    assert len(replacement.__code__.co_freevars) == len(target.__code__.co_freevars)
    with bind_request_group(group):
        stream = model._stream([HumanMessage(content="hello")])
    try:
        target.__code__ = replacement.__code__
        with bind_request_group(group), pytest.raises(ProviderUnavailableError):
            await run_native(client, next, stream)
    finally:
        target.__code__ = original_code

    result = await group.stop_and_wait(timeout=2)
    generation = generation_for(client)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert generation is not None and generation._gate.owner is not None
    assert getattr(model, "_replacement_entered", False) is False
    assert generation._gate.owner.request_member.group is group
    assert client.generate_calls == 0
    assert syncs == []
    from app.services.orchestrator import native_worker

    lifecycle = native_worker._get_lifecycle(client, asyncio.get_running_loop(), create=False)
    assert lifecycle is not None
    with lifecycle.lock:
        assert lifecycle.uncertain is True
        assert lifecycle.admission_open is False
        assert lifecycle.failure == "iterator_close_unknown"
        assert any(reference is stream for reference in lifecycle.cleanup_references)


@pytest.mark.asyncio
async def test_draft_callback_added_after_generator_construction_is_rejected():
    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("draft-added-before-advance"))
    reached = {"constructed": False, "mutated": False, "rejected_advance": False}

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        async with native_context(client):
            iterator = await run_native(
                client,
                lambda: client.generate("draft-added-before-advance"),
            )
            reached["constructed"] = True
            client.draft_model = object()
            reached["mutated"] = True
            with pytest.raises(NativeContextUnavailableError):
                await run_native(client, next, iterator)
            reached["rejected_advance"] = True

    assert reached == {
        "constructed": True,
        "mutated": True,
        "rejected_advance": True,
    }
    result = await group.stop_and_wait(timeout=2)
    generation = generation_for(client)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert result.reason == "native_option_binding_unverified"
    assert generation is not None and generation._gate.owner is not None
    assert client.generate_calls == 0
    assert syncs == []


@pytest.mark.asyncio
async def test_draft_callback_added_between_yields_is_rejected_before_next_token():
    client, _backend_value, syncs = _backend(
        yield_values={"draft-between-yields": ("first", "second")}
    )
    group = create_request_group(_binding("draft-added-between-yields"))
    reached = {
        "constructed": False,
        "first_yield": False,
        "mutated": False,
        "rejected_advance": False,
    }

    with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
        async with native_context(client):
            iterator = await run_native(
                client,
                lambda: client.generate("draft-between-yields"),
            )
            reached["constructed"] = True
            assert await run_native(client, next, iterator) == "first"
            reached["first_yield"] = True
            client.draft_model = object()
            reached["mutated"] = True
            with pytest.raises(NativeContextUnavailableError):
                await run_native(client, next, iterator)
            reached["rejected_advance"] = True

    assert reached == {
        "constructed": True,
        "first_yield": True,
        "mutated": True,
        "rejected_advance": True,
    }
    result = await group.stop_and_wait(timeout=2)
    generation = generation_for(client)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert result.reason == "native_option_binding_unverified"
    assert generation is not None and generation._gate.owner is not None
    assert client.generate_calls == 1
    assert [item for item in client.evaluations if item[0] == "start"] == [
        ("start", "draft-between-yields")
    ]
    assert syncs == []


@pytest.mark.asyncio
async def test_real_jinja_stopping_criteria_stops_before_any_token_yield(
    monkeypatch: pytest.MonkeyPatch,
):
    client, _backend_value, syncs = _backend(
        monkeypatch, real_jinja_handler=True, stop_token_ids=(8,)
    )
    group = create_request_group(_binding("real-jinja-stop-before-yield"))

    with bind_request_group(group):
        chunks = await run_native(
            client,
            lambda: list(
                client.create_chat_completion(
                    messages=[{"role": "user", "content": "hello"}],
                    stream=True,
                )
            ),
        )

    result = await group.complete_and_wait(timeout=2)
    assert chunks == []
    assert result.status is RequestCompletionStatus.COMPLETE
    assert [event[0] for event in client.evaluations] == [
        "tokenize",
        "completion-options",
        "factory",
        "start",
        "eval",
        "sample",
        "criteria",
    ]
    assert client.stopping_criteria_calls == [(7, 8)]
    assert client.generate_calls == 1
    assert client.iterator_close_calls == 1
    assert syncs == [client.ctx]


def test_pinned_jinja_handler_fingerprint_covers_real_template_and_converter(
    monkeypatch: pytest.MonkeyPatch,
):
    import importlib

    module = importlib.import_module("llama_cpp.llama_chat_format")
    formatter = module.Jinja2ChatFormatter(
        template="{{ messages[0].content }}{{ eos_token }}",
        eos_token="<eos>",
        bos_token="<bos>",
        stop_token_ids={1, 2},
    )
    handler = module.chat_formatter_to_chat_completion_handler(formatter)
    client = SimpleNamespace(
        chat_handler=None,
        chat_format="controlled-format",
        _chat_handlers={"controlled-format": handler},
    )
    backend = SimpleNamespace(__name__="llama_cpp", llama_chat_format=module)
    from app.services.orchestrator.llama_context_owner import (
        _qualify_handler_with_provenance,
    )

    mode, selected, qualified, provenance = _qualify_handler_with_provenance(client, backend)
    assert selected is handler
    assert selected is client._chat_handlers[client.chat_format]
    assert mode == "gguf_template"
    assert qualified is True

    class CompletionRecorder:
        verbose = False

        def __init__(self):
            self.prompts = []
            self.completion_calls = []

        def tokenize(self, prompt, *, add_bos, special):
            self.prompts.append((prompt, add_bos, special))
            return [7, 8]

        def create_completion(self, **kwargs):
            self.completion_calls.append(kwargs)
            return {
                "id": "controlled",
                "created": 1,
                "model": "controlled",
                "choices": [
                    {
                        "text": "answer",
                        "logprobs": None,
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3},
            }

    llama = CompletionRecorder()
    response = handler(
        llama=llama,
        messages=[{"role": "user", "content": "hello"}],
        stream=False,
    )
    assert llama.prompts == [(b"hello<eos>", False, True)]
    assert len(llama.completion_calls) == 1
    assert llama.completion_calls[0]["prompt"] == [7, 8]
    assert llama.completion_calls[0]["stop"] == ["<eos>"]
    assert response["choices"][0]["message"]["content"] == "answer"

    formatter.stop_token_ids.add(987654)
    _mode, _selected, still_qualified, changed = _qualify_handler_with_provenance(client, backend)
    assert still_qualified is True
    assert changed != provenance

    class ChangedStoppingCriteriaList(list):
        pass

    monkeypatch.setattr(module.llama, "StoppingCriteriaList", ChangedStoppingCriteriaList)
    _mode, _selected, still_qualified, replaced = _qualify_handler_with_provenance(client, backend)
    assert still_qualified is True
    assert replaced != changed


@pytest.mark.asyncio
async def test_instance_sampler_replacement_is_rejected_before_native_entry():
    client, _backend_value, syncs = _backend()
    group = create_request_group(_binding("sampler-binding-change"))
    generation = generation_for(client)
    assert generation is not None

    def replacement_sampler(_self):
        return object()

    client._init_sampler = replacement_sampler.__get__(client, type(client))
    try:
        with bind_request_group(group), pytest.raises(NativeContextUnavailableError):
            await run_native(client, client.generate, "must-not-enter")

        result = await group.complete_and_wait(timeout=1)
        assert result.status is RequestCompletionStatus.UNKNOWN
        assert client.generate_calls == 0
        assert syncs == []
        assert generation._quarantined is True
    finally:
        delattr(client, "_init_sampler")


@pytest.mark.asyncio
async def test_replaced_owned_close_cannot_report_generation_retired(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import native_worker

    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    replacement_calls = []

    def replacement_close(self):
        replacement_calls.append(self)

    pinned_close = retirement_close_binding(client)
    assert pinned_close is not None
    select_close = native_worker._select_retirement_close
    replaced = False

    def select_then_replace(owner, requested_target):
        nonlocal replaced
        selection = select_close(owner, requested_target)
        if not replaced:
            assert selection.pinned_method is pinned_close
            monkeypatch.setattr(type(client), "close", replacement_close)
            replaced = True
        return selection

    monkeypatch.setattr(native_worker, "_select_retirement_close", select_then_replace)
    result = await retire_native(client, timeout=1)

    assert retirement_close_binding(client) is None
    assert result.status.name in ("FAILED", "UNKNOWN")
    assert result.status.name != "COMPLETE"
    assert replacement_calls == []
    assert syncs == []
    assert generation.client is client
    assert retirement_blocked(client) is True


@pytest.mark.asyncio
async def test_owned_close_code_change_before_retirement_retains_owner(
    monkeypatch: pytest.MonkeyPatch,
):
    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    replacement_calls = []

    def replacement_close(self):
        replacement_calls.append(self)

    monkeypatch.setattr(type(client), "close", replacement_close)
    result = await retire_native(client, timeout=1)

    assert result.status in (RetirementStatus.FAILED, RetirementStatus.UNKNOWN)
    assert result.status is not RetirementStatus.COMPLETE
    assert replacement_calls == []
    assert syncs == []
    assert generation.client is client
    assert retirement_blocked(client) is True


@pytest.mark.asyncio
async def test_captured_base_close_code_mutation_retains_ordinary_generation():
    client, backend, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    captured_close = backend.Llama.close
    original_code = captured_close.__code__
    mutated_code = (lambda self: setattr(self, "replacement_close_called", True)).__code__.replace(
        co_freevars=original_code.co_freevars
    )
    assert captured_close is backend.Llama.close

    captured_close.__code__ = mutated_code
    try:
        result = await retire_native(client, timeout=1)
        assert result.status in (RetirementStatus.FAILED, RetirementStatus.UNKNOWN)
        assert result.status is not RetirementStatus.COMPLETE
        assert not hasattr(client, "replacement_close_called")
        assert client.close_calls == 0
        assert syncs == []
        assert generation.client is client
        assert retirement_blocked(client) is True
    finally:
        captured_close.__code__ = original_code


@pytest.mark.asyncio
async def test_registered_close_import_error_is_one_observed_failed_invocation():
    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None

    def raise_import_error():
        raise ImportError("controlled close body failure")

    client.on_close = raise_import_error
    result = await retire_native(client, timeout=1)

    assert result.status is RetirementStatus.FAILED
    assert client.close_calls == 1
    assert syncs == []
    assert generation.client is client
    assert retirement_blocked(client) is True


@pytest.mark.asyncio
async def test_close_authorization_rejection_is_unknown_before_body_entry(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services.orchestrator import native_worker

    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    monkeypatch.setattr(native_worker, "retirement_close_is_authorized", lambda _target: False)

    result = await retire_native(client, timeout=1)

    assert result.status is RetirementStatus.UNKNOWN
    assert client.close_calls == 0
    assert syncs == []
    assert generation.client is client
    assert retirement_blocked(client) is True


@pytest.mark.asyncio
async def test_close_body_authorization_error_is_one_observed_failure():
    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None

    def raise_authorization_error():
        raise NativeContextUnavailableError()

    client.on_close = raise_authorization_error
    result = await retire_native(client, timeout=1)

    assert result.status is RetirementStatus.FAILED
    assert client.close_calls == 1
    assert syncs == []
    assert generation.client is client
    assert retirement_blocked(client) is True


@pytest.mark.asyncio
async def test_duplicate_outer_finalizer_rejects_any_running_event_loop(monkeypatch):
    client, _backend_value, _syncs = _backend()
    iterator = await asyncio.to_thread(client.generate, "unstarted")
    generation = generation_for(client)
    assert generation is not None
    lease = generation._gate.owner
    assert lease is not None and lease.loop is None
    entered = threading.Event()
    release = threading.Event()
    original_finish = lease.finish_sync

    def blocked_finish(*, stopped=False):
        entered.set()
        if not release.wait(timeout=3):
            raise TimeoutError("outer finalizer did not release")
        return original_finish(stopped=stopped)

    monkeypatch.setattr(lease, "finish_sync", blocked_finish)
    first_errors = []

    def finish_first():
        try:
            iterator.close()
        except BaseException as error:
            first_errors.append(error)

    first = threading.Thread(target=finish_first)
    first.start()
    loop_errors = []

    async def finish_from_other_loop():
        try:
            iterator.close()
        except BaseException as error:
            loop_errors.append(error)

    second = threading.Thread(target=lambda: asyncio.run(finish_from_other_loop()))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        second.start()
        await asyncio.to_thread(second.join, 1)
        assert not second.is_alive()
        assert len(loop_errors) == 1
        assert isinstance(loop_errors[0], NativeContextUnavailableError)
    finally:
        release.set()
        await asyncio.to_thread(first.join, 3)
        if second.ident is not None:
            await asyncio.to_thread(second.join, 1)

    assert not first.is_alive()
    assert first_errors == []
    assert generation._gate.owner is None
    assert retirement_blocked(client) is False


@pytest.mark.asyncio
async def test_duplicate_outer_raw_close_rejects_loop_without_poisoning_owner():
    client, _backend_value, syncs = _backend()
    close_entered = threading.Event()
    release_close = threading.Event()

    def blocked_close_callback():
        close_entered.set()
        if not release_close.wait(timeout=3):
            raise TimeoutError("raw iterator close latch did not release")

    client.on_iterator_close = blocked_close_callback
    iterator = await asyncio.to_thread(client.generate, "raw-close-owner")
    assert await asyncio.to_thread(next, iterator) == "raw-close-owner"
    first_errors = []

    def close_first():
        try:
            iterator.close()
        except BaseException as error:
            first_errors.append(error)

    first = threading.Thread(target=close_first)
    first.start()
    loop_errors = []

    async def close_from_loop():
        try:
            iterator.close()
        except BaseException as error:
            loop_errors.append(error)

    second = threading.Thread(target=lambda: asyncio.run(close_from_loop()))
    try:
        assert await asyncio.to_thread(close_entered.wait, 2)
        second.start()
        await asyncio.to_thread(second.join, 1)
        assert not second.is_alive()
        assert len(loop_errors) == 1
        assert isinstance(loop_errors[0], NativeContextUnavailableError)
    finally:
        release_close.set()
        await asyncio.to_thread(first.join, 3)
        if second.ident is not None:
            await asyncio.to_thread(second.join, 1)

    assert not first.is_alive()
    assert first_errors == []
    generation = generation_for(client)
    assert generation is not None and generation._gate.owner is None
    assert syncs == [client.ctx]
    assert retirement_blocked(client) is False


@pytest.mark.asyncio
async def test_executed_direct_callback_quarantines_its_registered_generation():
    client, _backend_value, syncs = _backend()
    generation = generation_for(client)
    assert generation is not None
    group = create_request_group(_binding("executed-direct-callback"))
    calls = []
    value = object()

    @direct_native_call
    def accepted_callback(provider):
        calls.append(provider)
        return value

    callback_returned = False
    try:
        with bind_request_group(group):
            result_value = accepted_callback(client)
        callback_returned = True

        result = await group.complete_and_wait(timeout=1)
        assert result_value is value
        assert calls == [client]
        assert result.status is RequestCompletionStatus.UNKNOWN
        assert generation._quarantined is True
        assert len(group._unresolved) == 1
        assert syncs == []
    finally:
        if callback_returned:
            _release_quiescent_direct_cleanup_for_test(client, generation)


@pytest.mark.asyncio
async def test_cancelled_idle_runner_future_exits_worker_and_retains_unknown(
    monkeypatch: pytest.MonkeyPatch,
):
    from concurrent.futures import ThreadPoolExecutor

    from app.services.orchestrator import native_worker
    from app.services.orchestrator.native_worker import _get_lifecycle

    client, _backend_value, syncs = _backend()
    loop = asyncio.get_running_loop()
    previous_executor = loop._default_executor
    one_worker = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(one_worker)
    group = create_request_group(_binding("cancelled-idle-runner"))
    worker_returned = asyncio.Event()
    runner_mailboxes: list[object] = []
    waiting_lock = threading.Lock()
    worker_waiting_on_mailbox = False
    second_next_phase = threading.Event()
    idle_between_commands = asyncio.Event()
    original_queue_get = native_worker.thread_queue.Queue.get
    original_ensure_runner = native_worker._ensure_native_runner
    original_worker = native_worker._run_native_command_runner
    original_submit = native_worker._submit_operation
    observed_runners = []
    second_next_waiting = asyncio.Event()
    release_second_next = asyncio.Event()
    next_calls = 0

    async def capture_runner(reservation):
        runner = await original_ensure_runner(reservation)
        if all(existing is not runner for existing in observed_runners):
            observed_runners.append(runner)
            runner_mailboxes.append(runner.mailbox)
        return runner

    def observe_mailbox_get(mailbox, block=True, timeout=None):
        nonlocal worker_waiting_on_mailbox
        selected = any(mailbox is item for item in runner_mailboxes)
        if selected and mailbox.empty():
            with waiting_lock:
                worker_waiting_on_mailbox = True
                phase_active = second_next_phase.is_set()
            if phase_active:
                loop.call_soon_threadsafe(idle_between_commands.set)
        try:
            return original_queue_get(mailbox, block, timeout)
        finally:
            if selected:
                with waiting_lock:
                    worker_waiting_on_mailbox = False

    def observe_worker_return(runner):
        try:
            return original_worker(runner)
        finally:
            loop.call_soon_threadsafe(worker_returned.set)

    async def pause_second_stream_advance(*args, **kwargs):
        nonlocal next_calls
        if kwargs.get("stream_action") == "next":
            next_calls += 1
            if next_calls == 2:
                second_next_phase.set()
                runner = observed_runners[0]
                with waiting_lock:
                    already_idle = worker_waiting_on_mailbox
                if already_idle and runner.mailbox.empty():
                    idle_between_commands.set()
                second_next_waiting.set()
                await release_second_next.wait()
        return await original_submit(*args, **kwargs)

    monkeypatch.setattr(native_worker, "_ensure_native_runner", capture_runner)
    monkeypatch.setattr(native_worker, "_run_native_command_runner", observe_worker_return)
    monkeypatch.setattr(native_worker, "_submit_operation", pause_second_stream_advance)
    monkeypatch.setattr(native_worker.thread_queue.Queue, "get", observe_mailbox_get)

    stream = None
    consumer = None
    lifecycle = None
    try:
        with bind_request_group(group):
            stream = stream_native(client, lambda: client.generate("idle-runner-stream"))
            assert await asyncio.wait_for(anext(stream), timeout=3) == "idle-runner-stream"
            consumer = asyncio.create_task(anext(stream))

        await asyncio.wait_for(second_next_waiting.wait(), timeout=3)
        await asyncio.wait_for(idle_between_commands.wait(), timeout=3)
        runner = observed_runners[0]
        assert runner.mailbox.empty()
        assert not runner.worker_returned.is_set()
        assert runner.future is not None and not runner.future.done()

        # This is the exact retained executor Future whose worker is now blocked
        # on the empty mailbox between the two actual stream-next commands.
        assert runner.future.cancel() is True
        await asyncio.wait_for(worker_returned.wait(), timeout=3)
        assert runner.worker_returned.is_set()
        assert runner.future.cancelled()
        assert runner.unknown is True

        release_second_next.set()
        done, _pending = await asyncio.wait((consumer,), timeout=3)
        assert consumer in done
        with pytest.raises((ProviderUnavailableError, NativeContextUnavailableError)):
            await consumer

        lifecycle = _get_lifecycle(client, loop, create=False)
        generation = generation_for(client)
        assert lifecycle is not None and generation is not None
        with lifecycle.lock:
            assert lifecycle.uncertain is True
            assert lifecycle.admission_open is False
            assert lifecycle.streams
            retained_lease = next(iter(lifecycle.streams.values()))
            assert retained_lease.cleanup_unknown is True
            assert retained_lease.context_lease is not None
        assert generation._quarantined is True
        assert group._unresolved
        result = await group.complete_and_wait(timeout=2)
        assert result.status is RequestCompletionStatus.UNKNOWN
        assert client.close_calls == 0
        assert client.generate_calls == 1
        assert syncs == []
    finally:
        primary_error = sys.exc_info()[1]
        cleanup_failures = []
        release_second_next.set()
        if consumer is not None:
            if not consumer.done():
                consumer.cancel()
            done, pending = await asyncio.wait((consumer,), timeout=1)
            if pending:
                cleanup_failures.append("consumer task remained unsettled after bounded wait")
            elif not consumer.cancelled():
                # The test body already awaits and asserts the expected
                # ProviderUnavailableError/NativeContextUnavailableError.
                # Retrieve the task outcome here without reclassifying that
                # already-observed request result as teardown failure.
                consumer.exception()
        consumer_settled = consumer is None or consumer.done()
        if stream is not None and consumer_settled:
            close_task = asyncio.create_task(stream.aclose())
            done, pending = await asyncio.wait((close_task,), timeout=1)
            if pending:
                close_task.cancel()
                _unsettled_native_test_workers.append((stream, close_task))
                cleanup_failures.append("stream close task remained unsettled after bounded wait")
            elif not close_task.cancelled():
                close_error = close_task.exception()
                if close_error is not None:
                    cleanup_failures.append(
                        f"stream close task ended with {type(close_error).__name__}"
                    )
        elif stream is not None:
            _unsettled_native_test_workers.append((stream, consumer))
            cleanup_failures.append("stream retained because its consumer task is unsettled")
        if observed_runners and observed_runners[0].worker_returned.is_set():
            try:
                one_worker.shutdown(wait=True)
            except BaseException as exc:
                cleanup_failures.append(f"executor shutdown raised {type(exc).__name__}")
        else:
            _unsettled_native_test_workers.append((one_worker, *observed_runners, stream, consumer))
            cleanup_failures.append("executor retained because worker return was not observed")
        try:
            if previous_executor is None:
                loop._default_executor = None
            else:
                loop.set_default_executor(previous_executor)
        except BaseException as exc:
            cleanup_failures.append(f"default executor restoration raised {type(exc).__name__}")
        if cleanup_failures:
            detail = "; ".join(cleanup_failures)
            if primary_error is not None:
                primary_error.add_note(f"bounded test teardown: {detail}")
            else:
                raise AssertionError(f"bounded test teardown: {detail}")


@pytest.mark.asyncio
async def test_terminal_publication_first_task_queue_then_raise_wakes_consumer_unknown():
    import types

    from app.services.orchestrator import native_worker
    from app.services.orchestrator.native_worker import _get_lifecycle

    loop = asyncio.get_running_loop()
    tail_entered = asyncio.Event()
    release_tail = threading.Event()

    class LoopEventSignal:
        def set(self):
            loop.call_soon_threadsafe(tail_entered.set)

    client, _backend_value, syncs = _backend(
        tail_waits={"publication-first-task": (LoopEventSignal(), release_tail)},
        yield_values={"publication-first-task": ("publication-first-task", "buffered-final")},
    )
    group = create_request_group(_binding("terminal-publication-first-task"))
    previous_factory = loop.get_task_factory()
    created_tasks = []
    eligible_codes = set()
    eligible_attempts = []
    stream = None
    consumer = None
    lifecycle = None

    for publisher in native_worker._produce_stream.__code__.co_consts:
        if isinstance(publisher, types.CodeType) and publisher.co_name == "publish_terminal":
            eligible_codes = {
                item
                for item in publisher.co_consts
                if isinstance(item, types.CodeType)
                and item.co_name in {"put_terminal", "wait_for_stop"}
            }
            break
    assert len(eligible_codes) == 2

    try:
        with bind_request_group(group):
            stream = stream_native(client, lambda: client.generate("publication-first-task"))
            assert await asyncio.wait_for(anext(stream), timeout=3) == "publication-first-task"
        await asyncio.wait_for(tail_entered.wait(), timeout=3)

        lifecycle = _get_lifecycle(client, loop, create=False)
        assert lifecycle is not None
        with lifecycle.lock:
            assert len(lifecycle.streams) == 1
            lease = next(iter(lifecycle.streams.values()))
        assert lease.stop_requested is False
        original_factory = previous_factory

        def delegate_factory(task_loop, coroutine, context=None):
            if original_factory is not None:
                if context is None:
                    return original_factory(task_loop, coroutine)
                return original_factory(task_loop, coroutine, context=context)
            if context is None:
                return asyncio.tasks.Task(coroutine, loop=task_loop)
            return context.run(asyncio.tasks.Task, coroutine, loop=task_loop)

        def queue_then_raise(task_loop, coroutine, context=None):
            if (
                any(coroutine is retained for retained in lease.publication_coroutines)
                and getattr(coroutine, "cr_code", None) in eligible_codes
            ):
                eligible_attempts.append(coroutine.cr_code.co_name)
                task = delegate_factory(task_loop, coroutine, context)
                created_tasks.append(task)
                if len(eligible_attempts) == 1:
                    raise RuntimeError("terminal observer task queued before failure")
                return task
            return delegate_factory(task_loop, coroutine, context)

        loop.set_task_factory(queue_then_raise)
        release_tail.set()
        assert lease.task is not None
        producer_done, _pending = await asyncio.wait((lease.task,), timeout=4)
        assert lease.task in producer_done
        assert eligible_attempts == ["put_terminal"]
        assert lease.publication_unknown is True
        consumer = asyncio.create_task(anext(stream))
        done, _pending = await asyncio.wait((consumer,), timeout=4)
        assert consumer in done
    finally:
        primary_error = sys.exc_info()[1]
        cleanup_failures = []
        loop.set_task_factory(previous_factory)
        release_tail.set()
        if consumer is not None and not consumer.done():
            consumer.cancel()
        if consumer is not None:
            done, pending = await asyncio.wait((consumer,), timeout=1)
            if pending:
                _unsettled_native_test_workers.append((stream, consumer, *created_tasks))
                cleanup_failures.append("consumer task remained unsettled after bounded wait")
            elif not consumer.cancelled():
                # Preserve the body assertion/await as the authority for this
                # consumer result; teardown only drains its observation state.
                consumer.exception()
        pending_observers = tuple(task for task in created_tasks if not task.done())
        if pending_observers:
            done, pending = await asyncio.wait(pending_observers, timeout=1)
            if pending:
                _unsettled_native_test_workers.append((stream, *pending))
                cleanup_failures.append(
                    f"{len(pending)} terminal observer task(s) remained unsettled after bounded wait"
                )
        for task in created_tasks:
            if task.done() and not task.cancelled():
                observer_error = task.exception()
                if observer_error is not None and observer_error is not primary_error:
                    cleanup_failures.append(
                        f"terminal observer task ended with {type(observer_error).__name__}"
                    )
        consumer_settled = consumer is None or consumer.done()
        if stream is not None and consumer_settled:
            close_task = asyncio.create_task(stream.aclose())
            done, pending = await asyncio.wait((close_task,), timeout=1)
            if pending:
                close_task.cancel()
                _unsettled_native_test_workers.append((stream, close_task, *created_tasks))
                cleanup_failures.append("stream close task remained unsettled after bounded wait")
            elif not close_task.cancelled():
                close_error = close_task.exception()
                if close_error is not None:
                    cleanup_failures.append(
                        f"stream close task ended with {type(close_error).__name__}"
                    )
        if cleanup_failures:
            detail = "; ".join(cleanup_failures)
            if primary_error is not None:
                primary_error.add_note(f"bounded test teardown: {detail}")
            else:
                raise AssertionError(f"bounded test teardown: {detail}")

    with pytest.raises(asyncio.CancelledError):
        await consumer
    assert eligible_attempts == ["put_terminal"]
    assert len(created_tasks) == 1 and all(task.done() for task in created_tasks)
    assert lifecycle is not None
    with lifecycle.lock:
        assert lifecycle.uncertain is True
        assert lifecycle.admission_open is False
        assert len(lifecycle.streams) == 1
        lease = next(iter(lifecycle.streams.values()))
        assert lease.active is True
        assert lease.publication_unknown is True
        assert lease.cleanup_unknown is True
        assert created_tasks[0] in lease.publication_tasks
        assert all(task.done() for task in lease.publication_tasks)
        assert len(lease.publication_coroutines) == 1
    result = await group.complete_and_wait(timeout=2)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert group._unresolved
    assert client.close_calls == 0
    assert client.generate_calls == 1
    assert syncs == [client.ctx]


@pytest.mark.asyncio
async def test_terminal_publication_second_task_queue_then_raise_wakes_consumer_unknown():
    import types

    from app.services.orchestrator import native_worker
    from app.services.orchestrator.native_worker import _get_lifecycle

    loop = asyncio.get_running_loop()
    tail_entered = asyncio.Event()
    release_tail = threading.Event()

    class LoopEventSignal:
        def set(self):
            loop.call_soon_threadsafe(tail_entered.set)

    client, _backend_value, syncs = _backend(
        tail_waits={"publication-second-task": (LoopEventSignal(), release_tail)},
        yield_values={"publication-second-task": ("publication-second-task", "buffered-final")},
    )
    group = create_request_group(_binding("terminal-publication-second-task"))
    previous_factory = loop.get_task_factory()
    created_tasks = []
    eligible_codes = set()
    eligible_attempts = []
    stream = None
    consumer = None
    lifecycle = None

    for publisher in native_worker._produce_stream.__code__.co_consts:
        if isinstance(publisher, types.CodeType) and publisher.co_name == "publish_terminal":
            eligible_codes = {
                item
                for item in publisher.co_consts
                if isinstance(item, types.CodeType)
                and item.co_name in {"put_terminal", "wait_for_stop"}
            }
            break
    assert len(eligible_codes) == 2

    try:
        with bind_request_group(group):
            stream = stream_native(client, lambda: client.generate("publication-second-task"))
            assert await asyncio.wait_for(anext(stream), timeout=3) == "publication-second-task"
        await asyncio.wait_for(tail_entered.wait(), timeout=3)

        lifecycle = _get_lifecycle(client, loop, create=False)
        assert lifecycle is not None
        with lifecycle.lock:
            assert len(lifecycle.streams) == 1
            lease = next(iter(lifecycle.streams.values()))
        assert lease.stop_requested is False
        original_factory = previous_factory

        def delegate_factory(task_loop, coroutine, context=None):
            if original_factory is not None:
                if context is None:
                    return original_factory(task_loop, coroutine)
                return original_factory(task_loop, coroutine, context=context)
            if context is None:
                return asyncio.tasks.Task(coroutine, loop=task_loop)
            return context.run(asyncio.tasks.Task, coroutine, loop=task_loop)

        def queue_then_raise(task_loop, coroutine, context=None):
            if (
                any(coroutine is retained for retained in lease.publication_coroutines)
                and getattr(coroutine, "cr_code", None) in eligible_codes
            ):
                eligible_attempts.append(coroutine.cr_code.co_name)
                task = delegate_factory(task_loop, coroutine, context)
                created_tasks.append(task)
                if len(eligible_attempts) == 2:
                    raise RuntimeError("terminal observer task queued before failure")
                return task
            return delegate_factory(task_loop, coroutine, context)

        loop.set_task_factory(queue_then_raise)
        release_tail.set()
        assert lease.task is not None
        producer_done, _pending = await asyncio.wait((lease.task,), timeout=4)
        assert lease.task in producer_done
        assert eligible_attempts == ["put_terminal", "wait_for_stop"]
        assert lease.publication_unknown is True
        consumer = asyncio.create_task(anext(stream))
        done, _pending = await asyncio.wait((consumer,), timeout=4)
        assert consumer in done
    finally:
        primary_error = sys.exc_info()[1]
        cleanup_failures = []
        loop.set_task_factory(previous_factory)
        release_tail.set()
        if consumer is not None and not consumer.done():
            consumer.cancel()
        if consumer is not None:
            done, pending = await asyncio.wait((consumer,), timeout=1)
            if pending:
                _unsettled_native_test_workers.append((stream, consumer, *created_tasks))
                cleanup_failures.append("consumer task remained unsettled after bounded wait")
            elif not consumer.cancelled():
                # Preserve the body assertion/await as the authority for this
                # consumer result; teardown only drains its observation state.
                consumer.exception()
        pending_observers = tuple(task for task in created_tasks if not task.done())
        if pending_observers:
            done, pending = await asyncio.wait(pending_observers, timeout=1)
            if pending:
                _unsettled_native_test_workers.append((stream, *pending))
                cleanup_failures.append(
                    f"{len(pending)} terminal observer task(s) remained unsettled after bounded wait"
                )
        for task in created_tasks:
            if task.done() and not task.cancelled():
                observer_error = task.exception()
                if observer_error is not None and observer_error is not primary_error:
                    cleanup_failures.append(
                        f"terminal observer task ended with {type(observer_error).__name__}"
                    )
        consumer_settled = consumer is None or consumer.done()
        if stream is not None and consumer_settled:
            close_task = asyncio.create_task(stream.aclose())
            done, pending = await asyncio.wait((close_task,), timeout=1)
            if pending:
                close_task.cancel()
                _unsettled_native_test_workers.append((stream, close_task, *created_tasks))
                cleanup_failures.append("stream close task remained unsettled after bounded wait")
            elif not close_task.cancelled():
                close_error = close_task.exception()
                if close_error is not None:
                    cleanup_failures.append(
                        f"stream close task ended with {type(close_error).__name__}"
                    )
        if cleanup_failures:
            detail = "; ".join(cleanup_failures)
            if primary_error is not None:
                primary_error.add_note(f"bounded test teardown: {detail}")
            else:
                raise AssertionError(f"bounded test teardown: {detail}")

    with pytest.raises(asyncio.CancelledError):
        await consumer
    assert eligible_attempts == ["put_terminal", "wait_for_stop"]
    assert len(created_tasks) == 2 and all(task.done() for task in created_tasks)
    assert lifecycle is not None
    with lifecycle.lock:
        assert lifecycle.uncertain is True
        assert lifecycle.admission_open is False
        assert len(lifecycle.streams) == 1
        lease = next(iter(lifecycle.streams.values()))
        assert lease.active is True
        assert lease.publication_unknown is True
        assert lease.cleanup_unknown is True
        assert all(task in lease.publication_tasks for task in created_tasks)
        assert all(task.done() for task in lease.publication_tasks)
        assert len(lease.publication_coroutines) == 2
    result = await group.complete_and_wait(timeout=2)
    assert result.status is RequestCompletionStatus.UNKNOWN
    assert group._unresolved
    assert client.close_calls == 0
    assert client.generate_calls == 1
    assert syncs == [client.ctx]
