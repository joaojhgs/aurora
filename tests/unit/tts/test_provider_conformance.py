"""Provider conformance tests for direct TTS adapters."""

from __future__ import annotations

import asyncio
import io
import math
import threading
import time
import wave
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import pytest

from app.services.tts.providers.base import (
    TTSProviderError,
    TTSSynthesisRequest,
)
from app.services.tts.providers.piper import PiperTTSProvider, PiperVoiceConfig
from app.services.tts.providers.pockettts import (
    PocketTTSProvider,
    PocketTTSProviderConfig,
    PocketTTSVoiceStateConfig,
)

ProviderName = str


class FakePocketTTSModel:
    """Small deterministic PocketTTS stand-in for provider conformance tests."""

    load_calls: list[dict[str, object]] = []
    active_entries = 0
    max_active_entries = 0
    sample_rate = 24000
    block_generation: threading.Event | None = None
    block_stream_after_first: threading.Event | None = None
    generation_started: threading.Event | None = None
    generation_calls: list[dict[str, object]] = []
    stream_completed = False

    def __init__(self, language: str) -> None:
        self.language = language
        self.sample_rate = type(self).sample_rate
        self.device = "cpu"
        self.origin = type("Origin", (), {"name": f"{language}.safetensors"})()

    @classmethod
    def reset(cls) -> None:
        cls.load_calls = []
        cls.active_entries = 0
        cls.max_active_entries = 0
        cls.sample_rate = 24000
        cls.block_generation = None
        cls.block_stream_after_first = None
        cls.generation_started = None
        cls.generation_calls = []
        cls.stream_completed = False

    @classmethod
    def load_model(
        cls,
        *,
        language: str,
        quantize: bool,
        temp: float | None = None,
        lsd_decode_steps: int | None = None,
        noise_clamp: float | None = None,
        eos_threshold: float | None = None,
    ) -> FakePocketTTSModel:
        del quantize, temp, lsd_decode_steps, noise_clamp, eos_threshold
        cls.load_calls.append({"language": language})
        return cls(language)

    def get_state_for_audio_prompt(self, voice: str) -> dict[str, str]:
        return {"voice": voice, "language": self.language}

    def generate_audio(self, state: Any, text: str, **kwargs: object) -> list[float]:
        type(self).active_entries += 1
        type(self).max_active_entries = max(
            type(self).max_active_entries, type(self).active_entries
        )
        if type(self).generation_started is not None:
            type(self).generation_started.set()
        try:
            if type(self).block_generation is not None:
                while not type(self).block_generation.is_set():
                    time.sleep(0.005)
            type(self).generation_calls.append({"state": state, "text": text, **kwargs})
            return [0.0, 0.5, -0.5]
        finally:
            type(self).active_entries -= 1

    def generate_audio_stream(self, state: Any, text: str, **kwargs: object) -> Any:
        type(self).generation_calls.append({"state": state, "text": text, **kwargs})
        yield [0.25]
        if type(self).block_stream_after_first is not None:
            while not type(self).block_stream_after_first.is_set():
                time.sleep(0.005)
        yield [-0.25]
        type(self).stream_completed = True


@dataclass(frozen=True)
class ProviderCase:
    name: ProviderName
    default_voice: str
    alternate_voice: str
    sample_rate: int
    expected_raw_audio: bytes


PROVIDERS = (
    ProviderCase(
        name="piper",
        default_voice="active",
        alternate_voice="other",
        sample_rate=16000,
        expected_raw_audio=b"\x00\x00\x00@",
    ),
    ProviderCase(
        name="pockettts",
        default_voice="standard:alba",
        alternate_voice="standard:bruno",
        sample_rate=24000,
        expected_raw_audio=b"\x00\x00\x00@\x00\xc0",
    ),
)


@pytest.fixture(autouse=True)
def reset_fake_pockettts_model() -> None:
    FakePocketTTSModel.reset()


def _provider_id(case: ProviderCase) -> str:
    return case.name


async def _fake_piper_to_thread(func: Callable[..., object], *args: object, **kwargs: object):
    del func, args, kwargs
    return b"\x00\x00\x00@", 16000


async def _make_provider(
    case: ProviderCase,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    piper_to_thread: Callable[..., object] | None = None,
):
    if case.name == "piper":
        model_path = tmp_path / "voice.onnx"
        config_path = tmp_path / "voice.onnx.json"
        model_path.write_bytes(b"model")
        config_path.write_text("{}", encoding="utf-8")
        monkeypatch.setattr(asyncio, "to_thread", piper_to_thread or _fake_piper_to_thread)
        return PiperTTSProvider(
            piper_path="piper",
            voice=PiperVoiceConfig(
                voice_id=case.default_voice,
                model_file=str(model_path),
                config_file=str(config_path),
                display_name="Default Voice",
                expected_sample_rate=case.sample_rate,
            ),
        )
    return PocketTTSProvider(
        PocketTTSProviderConfig(
            effective_language="en",
            max_tokens=4,
            voices=(
                PocketTTSVoiceStateConfig(
                    voice_id=case.default_voice,
                    audio_prompt="alba",
                    display_name="Default Voice",
                ),
                PocketTTSVoiceStateConfig(
                    voice_id=case.alternate_voice,
                    audio_prompt="bruno",
                    display_name="Alternate Voice",
                ),
            ),
        ),
        model_class=FakePocketTTSModel,
    )


@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
def test_capabilities_limit_providers_to_one_resident_base_model(case: ProviderCase) -> None:
    provider = (
        PiperTTSProvider(
            piper_path="piper",
            voice=PiperVoiceConfig(voice_id=case.default_voice, model_file="/tmp/missing"),
        )
        if case.name == "piper"
        else PocketTTSProvider(
            PocketTTSProviderConfig(effective_language="en"),
            model_class=FakePocketTTSModel,
        )
    )

    capabilities = provider.capabilities

    assert capabilities.provider_id == case.name
    assert capabilities.max_resident_base_models == 1
    assert capabilities.supports_finite_synthesis is True
    assert capabilities.supports_streaming is True
    assert capabilities.supports_cancel is True
    assert capabilities.supports_inflight_cancel is False
    assert set(capabilities.supported_formats) == {"raw", "wav"}


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_health_reports_not_ready_before_start_ready_after_start_and_not_ready_after_stop(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = await _make_provider(case, tmp_path, monkeypatch)

    before = await provider.health()
    await provider.start()
    started = await provider.health()
    await provider.stop()
    stopped = await provider.health()

    assert before.ready is False
    assert before.base_identity is None
    assert started.ready is True
    assert started.active_voice == case.default_voice
    assert started.base_identity is not None
    assert stopped.ready is False
    assert stopped.base_identity is None


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_synthesize_without_voice_uses_default_logical_voice(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = await _make_provider(case, tmp_path, monkeypatch)
    await provider.start()

    result = await provider.synthesize(TTSSynthesisRequest(text="hello"))
    voices = await provider.list_voices()

    assert result.voice == case.default_voice
    assert voices[0].voice_id == case.default_voice
    assert voices[0].ready is True
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_synthesize_normalizes_raw_and_wav_audio(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = await _make_provider(case, tmp_path, monkeypatch)
    await provider.start()

    raw = await provider.synthesize(TTSSynthesisRequest(text="hello", audio_format="raw"))
    wav = await provider.synthesize(TTSSynthesisRequest(text="hello", audio_format="wav"))

    assert raw.audio == case.expected_raw_audio
    assert raw.audio_format == "raw"
    assert raw.sample_rate == case.sample_rate
    assert raw.channels == 1
    assert raw.duration_ms > 0
    assert wav.audio_format == "wav"
    assert wav.audio.startswith(b"RIFF")
    with wave.open(io.BytesIO(wav.audio), "rb") as wav_file:
        assert wav_file.getframerate() == case.sample_rate
        assert wav_file.getnchannels() == 1
        assert wav_file.getsampwidth() == 2
    await provider.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_rejects_unsupported_sample_rate_with_invalid_audio_error(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    piper_calls: list[object] = []

    async def counted_piper_to_thread(func: Callable[..., object], *args: object, **kwargs: object):
        del func, args, kwargs
        piper_calls.append(object())
        return b"\x00\x00", case.sample_rate

    provider = await _make_provider(
        case,
        tmp_path,
        monkeypatch,
        piper_to_thread=counted_piper_to_thread if case.name == "piper" else None,
    )
    await provider.start()

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.synthesize(
            TTSSynthesisRequest(text="hello", sample_rate=case.sample_rate + 1000)
        )

    assert exc_info.value.code == "invalid_audio"
    assert str(case.sample_rate + 1000) not in str(exc_info.value)
    assert piper_calls == []
    assert FakePocketTTSModel.generation_calls == []
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_lazy_sample_rate_mismatch_rejects_before_model_load(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="en", max_tokens=4, preload=False),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.synthesize(
            TTSSynthesisRequest(text="hello", request_id="lazy-rate", sample_rate=16000)
        )

    assert exc_info.value.code == "invalid_audio"
    assert FakePocketTTSModel.load_calls == []
    assert FakePocketTTSModel.generation_calls == []
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_unknown_voice_errors_are_sanitized_and_do_not_invoke_synthesis(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = await _make_provider(case, tmp_path, monkeypatch)
    await provider.start()

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.synthesize(
            TTSSynthesisRequest(
                text="private text",
                voice="/secret/path/private-voice",
                request_id="unknown-voice",
            )
        )

    assert exc_info.value.code == "unsupported_voice"
    assert "/secret/path" not in str(exc_info.value)
    assert "private text" not in str(exc_info.value)
    assert await provider.tracked_request_count() == 0
    assert FakePocketTTSModel.generation_calls == []
    await provider.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_empty_text_rejects_before_provider_entry_and_cleans_state(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    piper_calls: list[object] = []

    async def counted_piper_to_thread(func: Callable[..., object], *args: object, **kwargs: object):
        del func, args, kwargs
        piper_calls.append(object())
        return b"\x00\x00", 16000

    provider = await _make_provider(
        case,
        tmp_path,
        monkeypatch,
        piper_to_thread=counted_piper_to_thread if case.name == "piper" else None,
    )
    await provider.start()

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.synthesize(TTSSynthesisRequest(text="", request_id="empty"))

    assert exc_info.value.code == "invalid_audio"
    assert piper_calls == []
    assert FakePocketTTSModel.generation_calls == []
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_oversized_text_rejects_before_provider_entry_and_cleans_state(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    piper_calls: list[object] = []

    async def counted_piper_to_thread(func: Callable[..., object], *args: object, **kwargs: object):
        del func, args, kwargs
        piper_calls.append(object())
        return b"\x00\x00", 16000

    provider = await _make_provider(
        case,
        tmp_path,
        monkeypatch,
        piper_to_thread=counted_piper_to_thread if case.name == "piper" else None,
    )
    await provider.start()

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.synthesize(TTSSynthesisRequest(text="x" * 20_000, request_id="oversized"))

    assert exc_info.value.code == "resource_exhausted"
    assert piper_calls == []
    assert FakePocketTTSModel.generation_calls == []
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tts_request", "expected_code"),
    [
        (TTSSynthesisRequest(text="hello", audio_format="mp3"), "invalid_audio"),  # type: ignore[arg-type]
        (TTSSynthesisRequest(text="hello", speed=1.25), "invalid_audio"),
        (TTSSynthesisRequest(text="hello", speed=True), "invalid_audio"),  # type: ignore[arg-type]
        (TTSSynthesisRequest(text="hello", speed=math.inf), "invalid_audio"),
        (TTSSynthesisRequest(text="hello", sample_rate=0), "invalid_audio"),
        (TTSSynthesisRequest(text=None), "invalid_audio"),  # type: ignore[arg-type]
    ],
)
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_invalid_request_shape_rejects_before_provider_entry_and_cleans_state(
    case: ProviderCase,
    tts_request: TTSSynthesisRequest,
    expected_code: str,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    piper_calls: list[object] = []

    async def counted_piper_to_thread(func: Callable[..., object], *args: object, **kwargs: object):
        del func, args, kwargs
        piper_calls.append(object())
        return b"\x00\x00", 16000

    provider = await _make_provider(
        case,
        tmp_path,
        monkeypatch,
        piper_to_thread=counted_piper_to_thread if case.name == "piper" else None,
    )
    await provider.start()

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.synthesize(tts_request)

    assert exc_info.value.code == expected_code
    assert "hello" not in str(exc_info.value)
    assert "None" not in str(exc_info.value)
    assert piper_calls == []
    assert FakePocketTTSModel.generation_calls == []
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_invalid_stream_request_cleans_state(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = await _make_provider(case, tmp_path, monkeypatch)
    await provider.start()

    with pytest.raises(TTSProviderError) as exc_info:
        async for _chunk in provider.stream(
            TTSSynthesisRequest(text=" ", request_id="invalid-stream")
        ):
            pass

    assert exc_info.value.code == "invalid_audio"
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_unknown_cancel_before_work_does_not_grow_request_state(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = await _make_provider(case, tmp_path, monkeypatch)
    await provider.start()

    await provider.cancel("missing")
    await provider.cancel("missing")

    assert await provider.tracked_request_count() == 0
    await provider.stop()


async def _make_blocking_provider(
    case: ProviderCase,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    release: asyncio.Event | threading.Event,
    entered: asyncio.Event,
):
    if case.name == "piper":

        async def blocking_to_thread(func: Callable[..., object], *args: object, **kwargs: object):
            del func, args, kwargs
            entered.set()
            await release.wait()  # type: ignore[attr-defined]
            return b"\x00\x00\x00@", 16000

    else:
        FakePocketTTSModel.block_generation = release  # type: ignore[assignment]
        FakePocketTTSModel.generation_started = threading.Event()
        blocking_to_thread = None
    provider = await _make_provider(
        case,
        tmp_path,
        monkeypatch,
        piper_to_thread=blocking_to_thread if case.name == "piper" else None,
    )
    await provider.start()
    return provider


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_cancelled_queued_request_is_rejected_before_provider_entry(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release: asyncio.Event | threading.Event
    release = asyncio.Event() if case.name == "piper" else threading.Event()
    entered = asyncio.Event()
    provider = await _make_blocking_provider(case, tmp_path, monkeypatch, release, entered)
    first = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="first", request_id="request-1"))
    )
    if case.name == "piper":
        await entered.wait()
    else:
        assert FakePocketTTSModel.generation_started is not None
        await asyncio.to_thread(FakePocketTTSModel.generation_started.wait)
    second = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="second", request_id="request-2"))
    )
    await asyncio.sleep(0)

    await provider.cancel("request-2")
    release.set()
    await first
    with pytest.raises(TTSProviderError) as exc_info:
        await second

    assert exc_info.value.code == "cancelled"
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", PROVIDERS, ids=_provider_id)
async def test_cancelled_active_request_drops_delivery_after_generation(
    case: ProviderCase, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release = asyncio.Event() if case.name == "piper" else threading.Event()
    entered = asyncio.Event()
    provider = await _make_blocking_provider(case, tmp_path, monkeypatch, release, entered)
    task = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="first", request_id="request-1"))
    )
    if case.name == "piper":
        await entered.wait()
    else:
        assert FakePocketTTSModel.generation_started is not None
        await asyncio.to_thread(FakePocketTTSModel.generation_started.wait)

    await provider.cancel("request-1")
    release.set()

    with pytest.raises(TTSProviderError) as exc_info:
        await task

    assert exc_info.value.code == "cancelled"
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_stream_emits_ordered_audio_chunks_and_final_marker(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = await _make_provider(PROVIDERS[1], tmp_path, monkeypatch)
    await provider.start()

    chunks = [
        chunk
        async for chunk in provider.stream(
            TTSSynthesisRequest(text="stream", voice="standard:bruno", request_id="stream-1")
        )
    ]

    assert [(chunk.sequence, chunk.audio, chunk.is_final) for chunk in chunks] == [
        (0, b"\x00 ", False),
        (1, b"\x00\xe0", False),
        (2, b"", True),
    ]
    assert all(chunk.sample_rate == 24000 for chunk in chunks)
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_serializes_one_base_model_entry_across_two_logical_voices(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release = threading.Event()
    FakePocketTTSModel.block_generation = release
    FakePocketTTSModel.generation_started = threading.Event()
    provider = await _make_provider(PROVIDERS[1], tmp_path, monkeypatch)
    await provider.start()
    first = asyncio.create_task(
        provider.synthesize(
            TTSSynthesisRequest(
                text="first",
                voice="standard:alba",
                request_id="voice-state-1",
            )
        )
    )
    await asyncio.to_thread(FakePocketTTSModel.generation_started.wait)
    second = asyncio.create_task(
        provider.synthesize(
            TTSSynthesisRequest(
                text="second",
                voice="standard:bruno",
                request_id="voice-state-2",
            )
        )
    )
    await asyncio.sleep(0.05)

    assert FakePocketTTSModel.active_entries == 1
    release.set()
    results = await asyncio.gather(first, second)

    assert [result.voice for result in results] == ["standard:alba", "standard:bruno"]
    assert FakePocketTTSModel.max_active_entries == 1
    assert await provider.tracked_request_count() == 0
    await provider.stop()
