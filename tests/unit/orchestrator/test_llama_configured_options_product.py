"""Configured llama.cpp option routing at the wrapper boundary."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from app.services.orchestrator import chat_llama_cpp


class _ResponseIterator:
    def __init__(self, values):
        self._values = iter(values)
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._values)

    def close(self):
        self.closed = True


def _install_backend(monkeypatch):
    class FakeLlama:
        constructor_calls = []
        completion_calls = []

        def __init__(self, model_path, chat_format=None, **kwargs):
            self.model_path = model_path
            self.chat_format = chat_format
            self.constructor_options = dict(kwargs)
            type(self).constructor_calls.append((model_path, chat_format, dict(kwargs)))

        def create_chat_completion(self, messages, stream=False, min_p=None, **kwargs):
            type(self).completion_calls.append((messages, stream, min_p, dict(kwargs)))
            if stream:
                return _ResponseIterator(
                    [{"choices": [{"delta": {"content": "reply"}, "finish_reason": None}]}]
                )
            return {"choices": [{"message": {"role": "assistant", "content": "reply"}}]}

    FakeLlama._aurora_owned_base = FakeLlama
    backend = SimpleNamespace(Llama=FakeLlama, LlamaGrammar=object)
    monkeypatch.setattr(
        "app.services.orchestrator.llama_cpp_compat.load_llama_cpp_backend",
        lambda: backend,
    )
    monkeypatch.setattr(chat_llama_cpp, "make_owned_llama_class", lambda _: FakeLlama)
    monkeypatch.setattr(chat_llama_cpp, "bind_native_wrapper", lambda *_: None)
    FakeLlama.constructor_calls.clear()
    FakeLlama.completion_calls.clear()
    return FakeLlama


def test_configured_chat_format_uses_advanced_precedence_and_stable_identity(monkeypatch):
    fake_llama = _install_backend(monkeypatch)
    advanced = {"chat_format": "advanced-format", "min_p": 0.9, "kept_option": 3}
    model = chat_llama_cpp.ChatLlamaCpp(
        model_path="controlled.gguf",
        chat_format="field-format",
        min_p=0.25,
        model_kwargs=advanced,
    )

    assert len(fake_llama.constructor_calls) == 1
    model_path, constructor_format, constructor_options = fake_llama.constructor_calls[0]
    assert model_path == "controlled.gguf"
    assert constructor_format == "advanced-format"
    assert constructor_options["min_p"] == 0.9
    assert constructor_options["kept_option"] == 3
    assert constructor_options["n_batch"] == 8
    assert advanced == {
        "chat_format": "advanced-format",
        "min_p": 0.9,
        "kept_option": 3,
    }
    assert model._identifying_params["chat_format"] == "advanced-format"
    assert model._identifying_params["min_p"] == 0.25
    cache_key = model._get_llm_string()

    model.chat_format = "later-field-value"
    model.model_kwargs["chat_format"] = "later-dictionary-value"
    assert model._identifying_params["chat_format"] == "advanced-format"
    assert model._get_llm_string() == cache_key


def test_none_chat_format_keeps_legacy_constructor_and_identity_omission(monkeypatch):
    fake_llama = _install_backend(monkeypatch)
    model = chat_llama_cpp.ChatLlamaCpp(
        model_path="controlled.gguf",
        chat_format="field-format",
        model_kwargs={"chat_format": None},
    )

    assert len(fake_llama.constructor_calls) == 1
    model_path, constructor_format, constructor_options = fake_llama.constructor_calls[0]
    assert model_path == "controlled.gguf"
    assert constructor_format is None
    assert constructor_options["n_batch"] == 8
    assert "min_p" not in constructor_options
    assert "chat_format" not in model._identifying_params
    assert "min_p" not in model._default_params


def test_min_p_zero_and_per_call_overrides_reach_finite_and_stream_calls(monkeypatch):
    fake_llama = _install_backend(monkeypatch)
    model = chat_llama_cpp.ChatLlamaCpp(
        model_path="controlled.gguf",
        chat_format="controlled-format",
        min_p=0.4,
        streaming=False,
    )

    assert "min_p" not in fake_llama.constructor_calls[0][2]
    assert model._get_parameters(None)["min_p"] == 0.4

    finite = model._generate.__wrapped__(model, [HumanMessage(content="hello")], min_p=0.0)
    assert finite.generations[0].message.content == "reply"
    assert fake_llama.completion_calls[-1][2] == 0.0

    chunks = model._stream.__wrapped__(model, [HumanMessage(content="hello")], min_p=None)
    try:
        assert next(chunks).text == "reply"
        assert fake_llama.completion_calls[-1][2] is None
    finally:
        chunks.close()


@pytest.mark.asyncio
async def test_auto_tool_astream_uses_one_finite_result_and_preserves_tool_calls(monkeypatch):
    fake_llama = _install_backend(monkeypatch)
    model = chat_llama_cpp.ChatLlamaCpp(
        model_path="controlled.gguf",
        streaming=True,
    )
    tools = [{"type": "function", "function": {"name": "lookup"}}]
    sync_result = model._generate.__wrapped__(
        model,
        [HumanMessage(content="Find Oslo")],
        tools=tools,
        tool_choice=None,
    )
    assert sync_result.generations[0].message.content == "reply"
    assert fake_llama.completion_calls[-1][1] is False
    assert fake_llama.completion_calls[-1][3]["tool_choice"] == "auto"
    sync_chunks = list(
        model._stream(
            [HumanMessage(content="Find Oslo")],
            tools=tools,
            tool_choice=None,
        )
    )
    assert len(sync_chunks) == 1
    assert sync_chunks[0].message.content == "reply"
    assert fake_llama.completion_calls[-1][1] is False
    assert fake_llama.completion_calls[-1][3]["tool_choice"] == "auto"

    calls = []
    message = AIMessage(
        content="",
        tool_calls=[{"name": "lookup", "args": {"city": "Oslo"}, "id": "call-1"}],
        usage_metadata={"input_tokens": 4, "output_tokens": 2, "total_tokens": 6},
    )

    async def finite_generation(self, messages, *, stop=None, run_manager=None, **kwargs):
        calls.append((messages, stop, kwargs))
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=message,
                    generation_info={"finish_reason": "tool_calls"},
                )
            ],
            llm_output={},
        )

    def unexpected_stream(*_args, **_kwargs):
        raise AssertionError("AUTO tool requests must use the finite completion path")

    monkeypatch.setattr(chat_llama_cpp.ChatLlamaCpp, "_agenerate", finite_generation)
    monkeypatch.setattr(chat_llama_cpp, "stream_native", unexpected_stream)
    for choice in (None, "auto"):
        chunks = [
            chunk
            async for chunk in model._astream(
                [HumanMessage(content="Find Oslo")], tools=tools, tool_choice=choice
            )
        ]
        assert len(chunks) == 1
        assert chunks[0].message.tool_calls == message.tool_calls
        assert chunks[0].message.usage_metadata == message.usage_metadata
        assert chunks[0].generation_info == {"finish_reason": "tool_calls"}

    assert len(calls) == 2
    assert all(call[2] == {"tools": tools, "tool_choice": "auto"} for call in calls)
