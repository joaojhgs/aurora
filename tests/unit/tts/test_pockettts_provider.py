"""PocketTTS provider tests."""

from __future__ import annotations

import asyncio
import inspect
import threading
import time

import pytest

from app.services.tts.providers.base import (
    TTSProviderError,
    TTSSynthesisRequest,
    VoiceSelectionMode,
)
from app.services.tts.providers.pockettts import (
    POCKETTTS_CONFIGS,
    PocketTTSProvider,
    PocketTTSProviderConfig,
    PocketTTSVoiceStateConfig,
    resolve_pockettts_config,
)


class FakePocketTTSModel:
    load_calls: list[dict[str, object]] = []
    generation_calls: list[dict[str, object]] = []
    active_entries = 0
    max_active_entries = 0
    fail_load = False
    loaded_device = "cpu"
    block_generation: threading.Event | None = None
    block_stream_after_first: threading.Event | None = None
    forever_stream_after_first = False
    stream_completed = False

    def __init__(self, language: str) -> None:
        self.language = language
        self.sample_rate = 24000
        self.device = type(self).loaded_device
        self.origin = type("Origin", (), {"name": f"{language}.safetensors"})()
        self.state_calls: list[str] = []
        self.generated_texts: list[str] = []

    @classmethod
    def reset(cls) -> None:
        cls.load_calls = []
        cls.generation_calls = []
        cls.active_entries = 0
        cls.max_active_entries = 0
        cls.fail_load = False
        cls.loaded_device = "cpu"
        cls.block_generation = None
        cls.block_stream_after_first = None
        cls.forever_stream_after_first = False
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
        if cls.fail_load:
            raise RuntimeError("/secret/model/path failed")
        call = {"language": language, "quantize": quantize}
        if temp is not None:
            call["temp"] = temp
        if lsd_decode_steps is not None:
            call["lsd_decode_steps"] = lsd_decode_steps
        if noise_clamp is not None:
            call["noise_clamp"] = noise_clamp
        if eos_threshold is not None:
            call["eos_threshold"] = eos_threshold
        cls.load_calls.append(call)
        return cls(language)

    def get_state_for_audio_prompt(self, voice: str) -> dict[str, str]:
        self.state_calls.append(voice)
        return {"voice": voice, "language": self.language}

    def generate_audio(
        self,
        state,
        text: str,
        **kwargs,
    ) -> list[float]:
        type(self).active_entries += 1
        type(self).max_active_entries = max(
            type(self).max_active_entries, type(self).active_entries
        )
        try:
            event = type(self).block_generation
            if event is not None:
                while not event.is_set():
                    time.sleep(0.005)
            assert kwargs["max_tokens"] == 4
            assert kwargs["frames_after_eos"] == 1
            assert kwargs["copy_state"] is True
            type(self).generation_calls.append({"state": state, "text": text, **kwargs})
            self.generated_texts.append(text)
            return [0.0, 0.5, -0.5]
        finally:
            type(self).active_entries -= 1

    def generate_audio_stream(
        self,
        state,
        text: str,
        **kwargs,
    ):
        assert state["voice"]
        assert text
        assert kwargs["max_tokens"] == 4
        assert kwargs["frames_after_eos"] == 1
        assert kwargs["copy_state"] is True
        type(self).generation_calls.append({"state": state, "text": text, **kwargs})
        yield [0.25]
        if type(self).forever_stream_after_first:
            while True:
                time.sleep(0.05)
        event = type(self).block_stream_after_first
        if event is not None:
            while not event.is_set():
                time.sleep(0.005)
        yield [-0.25]
        type(self).stream_completed = True


@pytest.fixture(autouse=True)
def reset_fake_model():
    FakePocketTTSModel.reset()


def test_pockettts_official_api_signature_conformance_without_model_download() -> None:
    pocket_tts = pytest.importorskip("pocket_tts")
    load_signature = inspect.signature(pocket_tts.TTSModel.load_model)
    finite_signature = inspect.signature(pocket_tts.TTSModel.generate_audio)
    stream_signature = inspect.signature(pocket_tts.TTSModel.generate_audio_stream)

    assert "device" not in load_signature.parameters
    for name in ("temp", "lsd_decode_steps", "noise_clamp", "eos_threshold"):
        assert name in load_signature.parameters
        assert name not in finite_signature.parameters
        assert name not in stream_signature.parameters
    for signature in (finite_signature, stream_signature):
        assert {"max_tokens", "frames_after_eos", "copy_state"}.issubset(signature.parameters)


def test_pockettts_inventory_contains_exact_pinned_configs() -> None:
    assert set(POCKETTTS_CONFIGS) == {
        "english",
        "english_2026-01",
        "english_2026-04",
        "french_24l",
        "german",
        "german_24l",
        "italian",
        "italian_24l",
        "portuguese",
        "portuguese_24l",
        "spanish",
        "spanish_24l",
    }


@pytest.mark.parametrize(
    ("language", "tier", "expected"),
    [
        ("en", "compact", "english_2026-04"),
        ("english", "quality", "english_2026-04"),
        ("de", "compact", "german"),
        ("de", "quality", "german_24l"),
        ("pt-BR", "compact", "portuguese"),
        ("pt", "quality", "portuguese_24l"),
        ("it", "compact", "italian"),
        ("it", "quality", "italian_24l"),
        ("es", "compact", "spanish"),
        ("es", "quality", "spanish_24l"),
        ("fr", "quality", "french_24l"),
    ],
)
def test_pockettts_resolves_language_and_quality_to_config(
    language: str, tier: str, expected: str
) -> None:
    assert resolve_pockettts_config(language, tier).config_id == expected


def test_pockettts_rejects_plain_french_and_missing_compact_french() -> None:
    with pytest.raises(TTSProviderError) as plain_french:
        resolve_pockettts_config("fr", "quality", config_id="french")
    with pytest.raises(TTSProviderError) as compact_french:
        resolve_pockettts_config("fr", "compact")

    assert plain_french.value.code == "unsupported_voice"
    assert compact_french.value.code == "unsupported_voice"


def test_pockettts_allows_english_legacy_configs_only_as_explicit_compatibility() -> None:
    assert resolve_pockettts_config("en", "compact", config_id="english").config_id == "english"
    assert (
        resolve_pockettts_config("en", "compact", config_id="english_2026-01").config_id
        == "english_2026-01"
    )
    assert resolve_pockettts_config("en", "compact").config_id == "english_2026-04"


def test_pockettts_rejects_explicit_tier_mismatch_and_custom_config() -> None:
    with pytest.raises(TTSProviderError) as tier_mismatch:
        resolve_pockettts_config("de", "quality", config_id="german")
    with pytest.raises(TTSProviderError) as custom_config:
        resolve_pockettts_config("de", "compact", config_id="custom_german")

    assert tier_mismatch.value.code == "unsupported_voice"
    assert custom_config.value.code == "unsupported_voice"


@pytest.mark.asyncio
async def test_pockettts_start_loads_model_and_multiple_voice_states() -> None:
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(
            effective_language="de",
            quality_tier="quality",
            max_tokens=4,
            voices=(
                PocketTTSVoiceStateConfig("standard:anna", "anna", "Anna"),
                PocketTTSVoiceStateConfig("clone:local", "clone.wav", "Local"),
            ),
        ),
        model_class=FakePocketTTSModel,
    )

    await provider.start()

    assert FakePocketTTSModel.load_calls == [{"language": "german_24l", "quantize": False}]
    assert provider.capabilities.voice_selection_mode is VoiceSelectionMode.SHARED_MODEL_STATE
    assert provider.capabilities.max_resident_base_models == 1
    assert provider.capabilities.supports_inflight_cancel is False
    health = await provider.health()
    assert health.ready is True
    assert health.active_voice == "standard:anna"
    assert health.base_identity is not None
    assert health.base_identity.startswith("pockettts:german:german_24l:layers-24:sha256:")
    assert "clone.wav" not in health.base_identity
    voices = await provider.list_voices()
    assert [
        (voice.voice_id, voice.display_name, voice.ready, voice.language) for voice in voices
    ] == [
        ("standard:anna", "Anna", True, "german"),
        ("clone:local", "Local", True, "german"),
    ]
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_preload_false_lazy_loads_once_for_concurrent_requests() -> None:
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="en", max_tokens=4, preload=False),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    assert FakePocketTTSModel.load_calls == []
    first, second = await asyncio.gather(
        provider.synthesize(TTSSynthesisRequest(text="one")),
        provider.synthesize(TTSSynthesisRequest(text="two")),
    )

    assert first.audio
    assert second.audio
    assert FakePocketTTSModel.load_calls == [{"language": "english_2026-04", "quantize": False}]
    assert FakePocketTTSModel.max_active_entries == 1
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_restart_after_stop_recreates_executor() -> None:
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    await provider.synthesize(TTSSynthesisRequest(text="before"))
    await provider.stop()

    await provider.start()
    result = await provider.synthesize(TTSSynthesisRequest(text="after"))

    assert result.audio
    assert FakePocketTTSModel.load_calls == [
        {"language": "english_2026-04", "quantize": False},
        {"language": "english_2026-04", "quantize": False},
    ]
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_synthesizes_provider_neutral_pcm_and_wav() -> None:
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    raw = await provider.synthesize(
        TTSSynthesisRequest(text="hello", voice="standard:alba", audio_format="raw")
    )
    wav = await provider.synthesize(
        TTSSynthesisRequest(text="hello", voice="standard:alba", audio_format="wav")
    )

    assert raw.audio == b"\x00\x00\x00@\x00\xc0"
    assert raw.audio_format == "raw"
    assert raw.sample_rate == 24000
    assert raw.channels == 1
    assert raw.duration_ms == pytest.approx(3 / 24000 * 1000)
    assert raw.voice == "standard:alba"
    assert wav.audio.startswith(b"RIFF")
    assert wav.audio_format == "wav"
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_stream_normalizes_ordered_chunks() -> None:
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="es", quality_tier="quality", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    chunks = [
        chunk
        async for chunk in provider.stream(
            TTSSynthesisRequest(text="hola", voice="standard:alba", request_id="stream-1")
        )
    ]

    assert [(chunk.sequence, chunk.audio, chunk.is_final) for chunk in chunks] == [
        (0, b"\x00 ", False),
        (1, b"\x00\xe0", False),
        (2, b"", True),
    ]
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_stream_yields_first_chunk_before_generator_completion() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_stream_after_first = release
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="es", quality_tier="quality", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    stream = provider.stream(TTSSynthesisRequest(text="hola", request_id="stream-1"))

    first = await asyncio.wait_for(stream.__anext__(), timeout=1)

    assert first.sequence == 0
    assert first.audio == b"\x00 "
    assert FakePocketTTSModel.stream_completed is False
    release.set()
    rest = [chunk async for chunk in stream]
    assert [(chunk.sequence, chunk.is_final) for chunk in rest] == [(1, False), (2, True)]
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_stream_cancellation_stops_delivery_without_state_leak() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_stream_after_first = release
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="es", quality_tier="quality", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    stream = provider.stream(TTSSynthesisRequest(text="hola", request_id="stream-1"))
    first = await stream.__anext__()

    await provider.cancel("stream-1")
    release.set()
    with pytest.raises(TTSProviderError) as exc_info:
        await stream.__anext__()

    assert first.audio
    assert exc_info.value.code == "cancelled"
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_stream_cancel_wakes_forever_generator_without_default_thread_leak() -> (
    None
):
    FakePocketTTSModel.forever_stream_after_first = True
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(
            effective_language="es",
            quality_tier="quality",
            max_tokens=4,
            queue_timeout_s=0.05,
            request_timeout_s=5,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    stream = provider.stream(TTSSynthesisRequest(text="hola", request_id="stream-forever"))
    first = await asyncio.wait_for(stream.__anext__(), timeout=1)

    await provider.cancel("stream-forever")
    with pytest.raises(TTSProviderError) as exc_info:
        await asyncio.wait_for(stream.__anext__(), timeout=0.5)
    with pytest.raises(TTSProviderError) as busy:
        await provider.synthesize(TTSSynthesisRequest(text="blocked"))
    await asyncio.wait_for(provider.stop(), timeout=0.5)

    assert first.audio == b"\x00 "
    assert exc_info.value.code == "cancelled"
    assert busy.value.code == "resource_exhausted"


@pytest.mark.asyncio
async def test_pockettts_stream_completion_hands_gate_to_queued_synthesis_until_done() -> None:
    release_stream = threading.Event()
    release_synthesis = threading.Event()
    FakePocketTTSModel.block_stream_after_first = release_stream
    FakePocketTTSModel.block_generation = release_synthesis
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(
            effective_language="es",
            quality_tier="quality",
            max_tokens=4,
            queue_timeout_s=0.05,
            request_timeout_s=5,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    stream = provider.stream(TTSSynthesisRequest(text="hola", request_id="stream-race"))
    first = await asyncio.wait_for(stream.__anext__(), timeout=1)
    queued_synthesis = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="queued", request_id="synth-race"))
    )

    release_stream.set()
    rest = [chunk async for chunk in stream]
    deadline = asyncio.get_running_loop().time() + 1
    while FakePocketTTSModel.active_entries == 0:
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail("queued synthesis did not enter after stream completion")
        await asyncio.sleep(0.01)
    with pytest.raises(TTSProviderError) as busy:
        blocked_stream = provider.stream(TTSSynthesisRequest(text="blocked", request_id="stream-2"))
        await blocked_stream.__anext__()

    assert first.audio == b"\x00 "
    assert [(chunk.sequence, chunk.is_final) for chunk in rest] == [(1, False), (2, True)]
    assert busy.value.code == "resource_exhausted"
    assert FakePocketTTSModel.max_active_entries == 1
    release_synthesis.set()
    result = await queued_synthesis
    assert result.audio
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_serializes_model_entry_and_cancels_active_delivery() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_generation = release
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(
            effective_language="en",
            max_tokens=4,
            request_timeout_s=5,
            queue_timeout_s=5,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    first = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="one", request_id="request-1"))
    )
    await asyncio.sleep(0.05)
    second = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="two", request_id="request-2"))
    )
    await asyncio.sleep(0.05)

    await provider.cancel("request-1")
    release.set()

    with pytest.raises(TTSProviderError) as exc_info:
        await first
    await second

    assert exc_info.value.code == "cancelled"
    assert FakePocketTTSModel.max_active_entries == 1
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_timeout_keeps_entry_gate_until_blocking_call_finishes() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_generation = release
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(
            effective_language="en",
            max_tokens=4,
            request_timeout_s=0.05,
            queue_timeout_s=0.05,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    with pytest.raises(TTSProviderError) as timed_out:
        await provider.synthesize(TTSSynthesisRequest(text="blocked", request_id="request-1"))
    with pytest.raises(TTSProviderError) as still_busy:
        await provider.synthesize(TTSSynthesisRequest(text="queued", request_id="request-2"))

    assert timed_out.value.code == "resource_exhausted"
    assert still_busy.value.code == "resource_exhausted"
    assert FakePocketTTSModel.max_active_entries == 1
    release.set()
    await asyncio.sleep(0.1)
    result = await provider.synthesize(TTSSynthesisRequest(text="after"))
    assert result.audio
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_reload_rejects_new_work_while_draining_then_swaps() -> None:
    release = threading.Event()
    FakePocketTTSModel.block_generation = release
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    active = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="active", request_id="request-1"))
    )
    await asyncio.sleep(0.05)
    reload_task = asyncio.create_task(
        provider.reload(
            PocketTTSProviderConfig(effective_language="de", quality_tier="quality", max_tokens=4)
        )
    )
    await asyncio.sleep(0.05)

    with pytest.raises(TTSProviderError) as rejected:
        await provider.synthesize(TTSSynthesisRequest(text="during-reload"))

    assert rejected.value.code == "capability_changed"
    release.set()
    await active
    await reload_task
    health = await provider.health()
    assert health.ready is True
    assert health.base_identity is not None
    assert ":german:german_24l:" in health.base_identity
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_failed_reload_retains_old_healthy_state() -> None:
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    original_health = await provider.health()

    FakePocketTTSModel.fail_load = True
    with pytest.raises(TTSProviderError) as exc_info:
        await provider.reload(
            PocketTTSProviderConfig(effective_language="de", quality_tier="quality", max_tokens=4)
        )

    assert exc_info.value.code == "unavailable"
    health = await provider.health()
    assert health.ready is True
    assert health.base_identity == original_health.base_identity
    result = await provider.synthesize(TTSSynthesisRequest(text="still works"))
    assert result.voice == "standard:alba"
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_forwards_supported_settings_and_omits_null_temperature() -> None:
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(
            effective_language="pt",
            quality_tier="quality",
            max_tokens=4,
            quantize=True,
            device="cpu",
            temperature=None,
            lsd_decode_steps=8,
            noise_clamp=0.25,
            eos_threshold=0.5,
        ),
        model_class=FakePocketTTSModel,
    )
    await provider.start()

    await provider.synthesize(TTSSynthesisRequest(text="settings"))

    assert FakePocketTTSModel.load_calls == [
        {
            "language": "portuguese_24l",
            "quantize": True,
            "lsd_decode_steps": 8,
            "noise_clamp": 0.25,
            "eos_threshold": 0.5,
        }
    ]
    generation = FakePocketTTSModel.generation_calls[-1]
    assert "temp" not in generation
    assert "lsd_decode_steps" not in generation
    assert "noise_clamp" not in generation
    assert "eos_threshold" not in generation
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_rejects_unsupported_provider_and_request_settings() -> None:
    unsupported_device = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="en", max_tokens=4, device="cuda"),
        model_class=FakePocketTTSModel,
    )
    with pytest.raises(TTSProviderError) as device_error:
        await unsupported_device.start()

    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )
    await provider.start()
    for request in (
        TTSSynthesisRequest(text="bad-format", audio_format="mp3"),  # type: ignore[arg-type]
        TTSSynthesisRequest(text="bad-rate", sample_rate=16000),
        TTSSynthesisRequest(text="bad-speed", speed=1.2),
    ):
        with pytest.raises(TTSProviderError) as request_error:
            await provider.synthesize(request)
        assert request_error.value.code == "invalid_audio"

    assert device_error.value.code == "unavailable"
    assert await provider.tracked_request_count() == 0
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_rejects_loaded_non_cpu_model() -> None:
    FakePocketTTSModel.loaded_device = "cuda"
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.start()

    assert exc_info.value.code == "unavailable"
    assert str(exc_info.value) == "PocketTTS device is unavailable"
    await provider.stop()


@pytest.mark.asyncio
async def test_pockettts_unavailable_errors_are_sanitized() -> None:
    FakePocketTTSModel.fail_load = True
    provider = PocketTTSProvider(
        PocketTTSProviderConfig(effective_language="en", max_tokens=4),
        model_class=FakePocketTTSModel,
    )

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.start()

    assert exc_info.value.code == "unavailable"
    assert str(exc_info.value) == "PocketTTS synthesis failed"
    assert "/secret/model/path" not in str(exc_info.value)
    await provider.stop()
