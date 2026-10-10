"""Production-path coverage for the pinned llama.cpp default chat handler."""

from __future__ import annotations

import json
import sys
from types import ModuleType
from typing import Any

import pytest

from app.services.orchestrator.llama_context_owner import (
    NativeContextUnavailableError,
    generation_for,
    make_owned_llama_class,
)


def _completion(text: str, *, stream: bool = False) -> dict[str, Any]:
    return {
        "id": "controlled",
        "object": "text_completion",
        "created": 1,
        "model": "controlled",
        "choices": [
            {
                "text": text,
                "index": 0,
                "logprobs": None,
                "finish_reason": None if stream else "stop",
            }
        ],
        **(
            {}
            if stream
            else {
                "usage": {
                    "prompt_tokens": 2,
                    "completion_tokens": 1,
                    "total_tokens": 3,
                }
            }
        ),
    }


def _client(monkeypatch: pytest.MonkeyPatch, outputs: list[str]):
    import importlib

    installed_backend = importlib.import_module("llama_cpp")
    format_module = importlib.import_module("llama_cpp.llama_chat_format")
    outputs = list(outputs)
    syncs: list[Any] = []

    class FakeLlama:
        __module__ = "llama_cpp.llama"

        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            self._ctx = object()
            self.ctx = object()
            self.chat_format = "chatml-function-calling"
            self.chat_handler = None
            self._chat_handlers: dict[str, Any] = {}
            self.verbose = False
            self.completion_requests: list[dict[str, Any]] = []
            self.raw_close_count = 0

        def generate(self, *_args: Any, **_kwargs: Any):
            yield 1

        def _create_completion(self, *, stream: bool = False, **kwargs: Any):
            self.completion_requests.append({"stream": stream, **kwargs})
            try:
                if stream:
                    stream_text = outputs.pop(0) if outputs else "hello"
                    yield _completion(stream_text, stream=True)
                    yield _completion("", stream=True) | {
                        "choices": [
                            {
                                "text": "",
                                "index": 0,
                                "logprobs": None,
                                "finish_reason": "stop",
                            }
                        ]
                    }
                    return
                if not outputs:
                    raise AssertionError("unexpected finite completion stage")
                yield _completion(outputs.pop(0))
            finally:
                self.raw_close_count += 1

        def create_completion(self, *, stream: bool = False, **kwargs: Any):
            raw = self._create_completion(stream=stream, **kwargs)
            if stream:
                return raw
            try:
                return next(raw)
            finally:
                raw.close()

        def create_chat_completion(
            self,
            messages: list[dict[str, Any]] | None = None,
            *,
            stream: bool = False,
            **kwargs: Any,
        ):
            handler = format_module.get_chat_completion_handler(self.chat_format)
            return handler(
                llama=self,
                messages=messages or [{"role": "user", "content": "hello"}],
                stream=stream,
                **kwargs,
            )

        def eval(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def sample(self, *_args: Any, **_kwargs: Any) -> int:
            return 1

        def tokenize(self, *_args: Any, **_kwargs: Any) -> list[int]:
            return [1]

        def detokenize(self, *_args: Any, **_kwargs: Any) -> bytes:
            return b"hello"

        def reset(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def set_seed(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def load_state(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def save_state(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def embed(self, *_args: Any, **_kwargs: Any) -> list[float]:
            return [0.0]

        def create_embedding(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
            return {}

        def _init_sampler(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def close(self) -> None:
            return None

    FakeLlama.__init__.__module__ = "llama_cpp.llama"
    for name in (
        "generate",
        "_create_completion",
        "create_completion",
        "create_chat_completion",
        "eval",
        "sample",
        "tokenize",
        "detokenize",
        "reset",
        "set_seed",
        "load_state",
        "save_state",
        "embed",
        "create_embedding",
        "_init_sampler",
        "close",
    ):
        getattr(FakeLlama, name).__module__ = "llama_cpp.llama"

    llama_module = ModuleType("llama_cpp.llama")
    llama_module.Llama = FakeLlama
    llama_module.LlamaGrammar = installed_backend.LlamaGrammar
    llama_module.StoppingCriteriaList = installed_backend.llama.StoppingCriteriaList
    llama_module.LogitsProcessorList = getattr(installed_backend.llama, "LogitsProcessorList", list)
    llama_module.verbose = False
    low_level = ModuleType("llama_cpp.llama_cpp")
    low_level.llama_synchronize = lambda pointer: syncs.append(pointer)
    llama_module.llama_cpp = low_level
    backend = ModuleType("llama_cpp")
    backend.Llama = FakeLlama
    backend.LlamaGrammar = installed_backend.LlamaGrammar
    backend.llama = llama_module
    backend.llama_chat_format = format_module

    monkeypatch.setattr(format_module, "llama", llama_module)
    monkeypatch.setitem(sys.modules, "llama_cpp", backend)
    monkeypatch.setitem(sys.modules, "llama_cpp.llama", llama_module)
    monkeypatch.setitem(sys.modules, "llama_cpp.llama_cpp", low_level)
    monkeypatch.setitem(sys.modules, "llama_cpp.llama_chat_format", format_module)

    client = make_owned_llama_class(backend)()
    return client, syncs


@pytest.fixture
def tool_spec() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "echo",
                "description": "Return the supplied value.",
                "parameters": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                },
            },
        }
    ]


def test_default_chatml_handler_returns_finite_chat_completion(
    monkeypatch: pytest.MonkeyPatch,
    tool_spec: list[dict[str, Any]],
):
    client, syncs = _client(monkeypatch, ["hello from the default handler"])
    generation = generation_for(client)

    assert generation is not None
    assert generation.handler_mode == "chatml_function_calling"
    assert generation.qualified is True
    response = client.create_chat_completion(stream=False)

    assert response["choices"][0]["message"]["content"] == "hello from the default handler"
    assert len(client.completion_requests) == 1
    assert syncs == [client.ctx]

    from langchain_core.messages import HumanMessage

    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
    from app.services.orchestrator.llama_context_owner import bind_native_wrapper

    stream_client, stream_syncs = _client(
        monkeypatch,
        ["functions.echo", '{"value":"ok"}', "functions.done"],
    )
    stream_generation = generation_for(stream_client)
    assert stream_generation is not None
    assert stream_generation.qualified is True
    wrapper = ChatLlamaCpp.model_construct(
        model_path="controlled.gguf",
        client=stream_client,
        streaming=True,
    )
    bind_native_wrapper(wrapper, stream_client)
    assert generation_for(stream_client) is stream_generation

    chunks = list(
        wrapper._stream(
            [HumanMessage(content="echo ok")],
            tools=tool_spec,
            tool_choice="auto",
        )
    )
    tool_call_chunks = [
        tool_call for chunk in chunks for tool_call in chunk.message.tool_call_chunks
    ]
    assert any(tool_call.get("name") == "echo" for tool_call in tool_call_chunks)
    assert any(
        json.loads(tool_call.get("args", "{}")) == {"value": "ok"} for tool_call in tool_call_chunks
    )
    assert len(stream_client.completion_requests) == 3
    assert stream_client.raw_close_count == 3
    assert stream_syncs == [stream_client.ctx]

    mutated_client, _mutated_syncs = _client(monkeypatch, ["must not run"])
    mutated_generation = generation_for(mutated_client)
    assert mutated_generation is not None
    template_class = sys.modules["jinja2.environment"].Template

    def changed_render(self: Any, *_args: Any, **_kwargs: Any) -> str:
        del self
        return "changed"

    with monkeypatch.context() as changed_method:
        changed_method.setattr(template_class, "render", changed_render)
        with pytest.raises(NativeContextUnavailableError):
            mutated_client.create_chat_completion(stream=False)

    assert mutated_generation._quarantined is True
    assert mutated_client.completion_requests == []


def test_default_chatml_handler_stream_tracks_and_closes_native_child(
    monkeypatch: pytest.MonkeyPatch,
):
    client, syncs = _client(monkeypatch, [])

    response = client.create_chat_completion(stream=True)
    chunks = list(response)

    assert any(chunk["choices"][0]["delta"].get("content") == "hello" for chunk in chunks)
    assert client.raw_close_count == 1
    assert syncs == [client.ctx]


def test_default_chatml_handler_auto_tool_choice_uses_all_bounded_stages(
    monkeypatch: pytest.MonkeyPatch,
    tool_spec: list[dict[str, Any]],
):
    client, syncs = _client(monkeypatch, ["functions.echo", '{"value":"ok"}', "functions.done"])

    response = client.create_chat_completion(
        messages=[{"role": "user", "content": "echo ok"}],
        tools=tool_spec,
        tool_choice="auto",
    )

    message = response["choices"][0]["message"]
    assert message["tool_calls"][0]["function"] == {
        "name": "echo",
        "arguments": '{"value":"ok"}',
    }
    assert len(client.completion_requests) == 3
    assert syncs == [client.ctx]


def test_default_chatml_handler_named_tool_choice_runs_once(
    monkeypatch: pytest.MonkeyPatch,
    tool_spec: list[dict[str, Any]],
):
    client, syncs = _client(monkeypatch, ['{"value":"named"}'])

    response = client.create_chat_completion(
        messages=[{"role": "user", "content": "echo named"}],
        tools=tool_spec,
        tool_choice={"type": "function", "function": {"name": "echo"}},
    )

    assert (
        response["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        == '{"value":"named"}'
    )
    assert len(client.completion_requests) == 1
    assert syncs == [client.ctx]


def test_default_chatml_stream_cancellation_closes_once_and_synchronizes(
    monkeypatch: pytest.MonkeyPatch,
):
    client, syncs = _client(monkeypatch, [])

    response = client.create_chat_completion(stream=True)
    next(response)
    response.close()

    assert client.raw_close_count == 1
    assert syncs == [client.ctx]
