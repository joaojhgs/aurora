"""PocketTTS provider tests."""

from __future__ import annotations

import asyncio
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
    block_generation: threading.Event | None = None
    block_stream_after_first: threading.Event | None = None
    stream_completed = False

    def __init__(self, language: str) -> None:
        self.language = language
        self.sample_rate = 24000
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
        cls.block_generation = None
        cls.block_stream_after_first = None
        cls.stream_completed = False

    @classmethod
    def load_model(cls, *, language: str, quantize: bool, device: str) -> FakePocketTTSModel:
        if cls.fail_load:
            raise RuntimeError("/secret/model/path failed")
        cls.load_calls.append({"language": language, "quantize": quantize, "device": device})
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
        event = type(self).block_stream_after_first
        if event is not None:
            while not event.is_set():
                time.sleep(0.005)
        yield [-0.25]
        type(self).stream_completed = True


@pytest.fixture(autouse=True)
def reset_fake_model():
    FakePocketTTSModel.reset()


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

    assert FakePocketTTSModel.load_calls == [
        {"language": "german_24l", "quantize": False, "device": "cpu"}
    ]
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
    assert FakePocketTTSModel.load_calls == [
        {"language": "english_2026-04", "quantize": False, "device": "cpu"}
    ]
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
        {"language": "english_2026-04", "quantize": False, "device": "cpu"},
        {"language": "english_2026-04", "quantize": False, "device": "cpu"},
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
        {"language": "portuguese_24l", "quantize": True, "device": "cpu"}
    ]
    generation = FakePocketTTSModel.generation_calls[-1]
    assert "temperature" not in generation
    assert generation["lsd_decode_steps"] == 8
    assert generation["noise_clamp"] == 0.25
    assert generation["eos_threshold"] == 0.5
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
