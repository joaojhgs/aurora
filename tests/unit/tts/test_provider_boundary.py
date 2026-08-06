"""Provider-boundary tests for TTS engines."""

from __future__ import annotations

import asyncio
import importlib
import subprocess
import sys
import types
import wave

import pytest

from app.services.tts.providers import (
    PiperTTSProvider,
    PiperVoiceConfig,
    TTSProviderCapabilities,
    TTSProviderError,
    TTSSynthesisRequest,
    VoiceSelectionMode,
)


def test_piper_capabilities_are_active_only_with_one_resident_base_model(tmp_path) -> None:
    model_path = tmp_path / "voice.onnx"
    config_path = tmp_path / "voice.onnx.json"
    model_path.write_bytes(b"model")
    config_path.write_text("{}", encoding="utf-8")
    provider = PiperTTSProvider(
        piper_path="piper",
        voice=PiperVoiceConfig(
            voice_id="default",
            model_file=str(model_path),
            config_file=str(config_path),
        ),
    )

    assert isinstance(provider.capabilities, TTSProviderCapabilities)
    assert provider.capabilities.provider_id == "piper"
    assert provider.capabilities.voice_selection_mode is VoiceSelectionMode.ACTIVE_ONLY
    assert provider.capabilities.max_resident_base_models == 1
    assert provider.capabilities.supports_inflight_cancel is False
    assert provider.base_identity.startswith("piper:default:sha256:")
    assert str(model_path) not in provider.base_identity
    assert str(config_path) not in provider.base_identity


@pytest.mark.asyncio
async def test_piper_rejects_non_active_voice_without_invoking_cli(tmp_path, monkeypatch) -> None:
    model_path = tmp_path / "voice.onnx"
    model_path.write_bytes(b"model")
    invoked = False

    async def fake_to_thread(*_args, **_kwargs):
        nonlocal invoked
        invoked = True

    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    provider = PiperTTSProvider(
        piper_path="piper",
        voice=PiperVoiceConfig(voice_id="default", model_file=str(model_path)),
    )
    await provider.start()

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.synthesize(TTSSynthesisRequest(text="hello", voice="separate"))

    assert exc_info.value.code == "unsupported_voice"
    assert invoked is False
    health = await provider.health()
    assert health.ready is True
    assert health.active_voice == "default"


@pytest.mark.asyncio
async def test_piper_synthesis_runs_cli_off_event_loop(tmp_path, monkeypatch) -> None:
    model_path = tmp_path / "voice.onnx"
    config_path = tmp_path / "voice.onnx.json"
    model_path.write_bytes(b"model")
    config_path.write_text("{}", encoding="utf-8")
    to_thread_calls: list[object] = []
    run_calls: list[dict[str, object]] = []

    def fake_run(cmd, *, input, capture_output, check, shell):
        output_path = cmd[cmd.index("-f") + 1]
        with wave.open(output_path, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(16000)
            wav_file.writeframes(b"\x01\x00\x02\x00")
        run_calls.append(
            {
                "cmd": cmd,
                "input": input,
                "capture_output": capture_output,
                "check": check,
                "shell": shell,
            }
        )

    async def fake_to_thread(func, *args, **kwargs):
        to_thread_calls.append(func)
        return func(*args, **kwargs)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    provider = PiperTTSProvider(
        piper_path="/usr/bin/piper",
        voice=PiperVoiceConfig(
            voice_id="default",
            model_file=str(model_path),
            config_file=str(config_path),
        ),
    )
    await provider.start()

    result = await provider.synthesize(TTSSynthesisRequest(text="threaded", audio_format="raw"))

    assert result.audio == b"\x01\x00\x02\x00"
    assert result.sample_rate == 16000
    assert result.duration_ms == pytest.approx(2 / 16000 * 1000)
    assert result.voice == "default"
    assert to_thread_calls
    assert run_calls[0]["cmd"][:6] == [
        "/usr/bin/piper",
        "-m",
        str(model_path),
        "-f",
        run_calls[0]["cmd"][4],
        "-c",
    ]
    assert run_calls[0]["cmd"][6] == str(config_path)
    assert run_calls[0]["input"] == b"threaded"
    assert run_calls[0]["capture_output"] is True
    assert run_calls[0]["check"] is True
    assert run_calls[0]["shell"] is False


@pytest.mark.asyncio
async def test_piper_synthesis_maps_cli_failure_without_request_text_or_stderr(
    tmp_path, monkeypatch
) -> None:
    model_path = tmp_path / "voice.onnx"
    model_path.write_bytes(b"model")

    def fake_run(*_args, **_kwargs):
        raise subprocess.CalledProcessError(
            returncode=1,
            cmd=["piper"],
            stderr=b"model unavailable /secret/path private request text",
        )

    async def fake_to_thread(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    provider = PiperTTSProvider(
        piper_path="/usr/bin/piper",
        voice=PiperVoiceConfig(voice_id="default", model_file=str(model_path)),
    )
    await provider.start()

    with pytest.raises(TTSProviderError) as exc_info:
        await provider.synthesize(TTSSynthesisRequest(text="private request text"))

    assert exc_info.value.code == "unavailable"
    assert str(exc_info.value) == "Piper synthesis failed"
    assert "private request text" not in str(exc_info.value)
    assert "/secret/path" not in str(exc_info.value)
    assert "model unavailable" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_piper_stream_emits_audio_then_final_marker(tmp_path, monkeypatch) -> None:
    model_path = tmp_path / "voice.onnx"
    model_path.write_bytes(b"model")

    async def fake_synthesize(_request):
        from app.services.tts.providers.base import TTSSynthesisResult

        return TTSSynthesisResult(
            audio=b"pcm",
            audio_format="raw",
            sample_rate=22050,
            channels=1,
            duration_ms=1.0,
            voice="default",
        )

    provider = PiperTTSProvider(
        piper_path="piper",
        voice=PiperVoiceConfig(voice_id="default", model_file=str(model_path)),
    )
    await provider.start()
    monkeypatch.setattr(provider, "synthesize", fake_synthesize)

    chunks = [chunk async for chunk in provider.stream(TTSSynthesisRequest(text="hello"))]

    assert [(chunk.sequence, chunk.audio, chunk.is_final) for chunk in chunks] == [
        (0, b"pcm", False),
        (1, b"", True),
    ]
    assert chunks[-1].sample_rate == 22050


@pytest.mark.asyncio
async def test_piper_unknown_late_cancel_does_not_grow_state(tmp_path) -> None:
    model_path = tmp_path / "voice.onnx"
    model_path.write_bytes(b"model")
    provider = PiperTTSProvider(
        piper_path="piper",
        voice=PiperVoiceConfig(voice_id="default", model_file=str(model_path)),
    )
    await provider.start()

    await provider.cancel("unknown")
    await provider.cancel("unknown")

    assert await provider.tracked_request_count() == 0


@pytest.mark.asyncio
async def test_piper_cancel_queued_request_prevents_synthesis(tmp_path, monkeypatch) -> None:
    model_path = tmp_path / "voice.onnx"
    model_path.write_bytes(b"model")
    invoked = False
    first_entered = asyncio.Event()
    release_first = asyncio.Event()

    async def fake_to_thread(*_args, **_kwargs):
        nonlocal invoked
        invoked = True
        first_entered.set()
        await release_first.wait()
        return b"\x01\x00", 16000

    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    provider = PiperTTSProvider(
        piper_path="piper",
        voice=PiperVoiceConfig(voice_id="default", model_file=str(model_path)),
    )
    await provider.start()
    first_task = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="first", request_id="request-1"))
    )
    await first_entered.wait()
    queued_task = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="second", request_id="request-2"))
    )
    await asyncio.sleep(0)

    await provider.cancel("request-2")
    release_first.set()
    await first_task
    with pytest.raises(TTSProviderError) as exc_info:
        await queued_task

    assert exc_info.value.code == "cancelled"
    assert invoked is True
    assert await provider.tracked_request_count() == 0


@pytest.mark.asyncio
async def test_piper_cancel_active_request_drops_delivery_after_generation(
    tmp_path, monkeypatch
) -> None:
    model_path = tmp_path / "voice.onnx"
    model_path.write_bytes(b"model")
    entered = asyncio.Event()
    release = asyncio.Event()

    async def fake_to_thread(*_args, **_kwargs):
        entered.set()
        await release.wait()
        return b"\x01\x00", 16000

    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    provider = PiperTTSProvider(
        piper_path="piper",
        voice=PiperVoiceConfig(voice_id="default", model_file=str(model_path)),
    )
    await provider.start()
    task = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="hello", request_id="request-1"))
    )
    await entered.wait()

    await provider.cancel("request-1")
    release.set()

    with pytest.raises(TTSProviderError) as exc_info:
        await task

    assert exc_info.value.code == "cancelled"
    assert await provider.tracked_request_count() == 0


@pytest.mark.asyncio
async def test_piper_late_cancel_after_completion_does_not_grow_state(
    tmp_path, monkeypatch
) -> None:
    model_path = tmp_path / "voice.onnx"
    model_path.write_bytes(b"model")

    async def fake_to_thread(*_args, **_kwargs):
        return b"\x01\x00", 16000

    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    provider = PiperTTSProvider(
        piper_path="piper",
        voice=PiperVoiceConfig(voice_id="default", model_file=str(model_path)),
    )
    await provider.start()

    await provider.synthesize(TTSSynthesisRequest(text="hello", request_id="request-1"))
    await provider.cancel("request-1")

    assert await provider.tracked_request_count() == 0


@pytest.mark.asyncio
async def test_piper_stop_during_active_synthesis_rejects_stale_audio(
    tmp_path, monkeypatch
) -> None:
    model_path = tmp_path / "voice.onnx"
    model_path.write_bytes(b"model")
    entered = asyncio.Event()
    release = asyncio.Event()

    async def fake_to_thread(*_args, **_kwargs):
        entered.set()
        await release.wait()
        return b"\x01\x00", 16000

    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    provider = PiperTTSProvider(
        piper_path="piper",
        voice=PiperVoiceConfig(voice_id="default", model_file=str(model_path)),
    )
    await provider.start()
    task = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="hello", request_id="request-1"))
    )
    await entered.wait()
    stop_task = asyncio.create_task(provider.stop())
    await asyncio.sleep(0)

    assert stop_task.done() is False
    release.set()
    await stop_task

    with pytest.raises(TTSProviderError) as exc_info:
        await task

    assert exc_info.value.code == "cancelled"
    assert await provider.tracked_request_count() == 0
    health = await provider.health()
    assert health.ready is False
    assert health.base_identity is None


@pytest.mark.asyncio
async def test_piper_serializes_cli_entry(tmp_path, monkeypatch) -> None:
    model_path = tmp_path / "voice.onnx"
    model_path.write_bytes(b"model")
    active_entries = 0
    max_entries = 0
    entered = asyncio.Event()
    release = asyncio.Event()

    async def fake_to_thread(*_args, **_kwargs):
        nonlocal active_entries, max_entries
        active_entries += 1
        max_entries = max(max_entries, active_entries)
        entered.set()
        await release.wait()
        active_entries -= 1
        return b"\x01\x00", 16000

    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    provider = PiperTTSProvider(
        piper_path="piper",
        voice=PiperVoiceConfig(voice_id="default", model_file=str(model_path)),
    )
    await provider.start()
    first = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="first", request_id="request-1"))
    )
    await entered.wait()
    second = asyncio.create_task(
        provider.synthesize(TTSSynthesisRequest(text="second", request_id="request-2"))
    )
    await asyncio.sleep(0)

    assert max_entries == 1
    release.set()
    await first
    await second

    assert max_entries == 1
    assert await provider.tracked_request_count() == 0


def test_realtimetts_piper_engine_uses_shared_cli_helper(monkeypatch) -> None:
    realtime_tts = types.ModuleType("RealtimeTTS")

    class BaseEngine:
        pass

    pyaudio = types.ModuleType("pyaudio")
    pyaudio.paInt16 = object()
    realtime_tts.BaseEngine = BaseEngine
    monkeypatch.setitem(sys.modules, "RealtimeTTS", realtime_tts)
    monkeypatch.setitem(sys.modules, "pyaudio", pyaudio)

    module = importlib.import_module("app.services.tts.piper_engine")
    calls: list[dict[str, object]] = []

    def fake_synthesize_piper_cli(**kwargs):
        calls.append(kwargs)
        return b"\x01\x00", 16000

    monkeypatch.setattr(module, "synthesize_piper_cli", fake_synthesize_piper_cli)
    monkeypatch.setattr(
        "app.helpers.getUseHardwareAcceleration.get_use_hardware_acceleration",
        lambda _service: "disabled",
    )
    engine = module.PiperEngine(
        piper_path="/usr/bin/piper",
        voice=module.PiperVoice(model_file="/tmp/voice.onnx", config_file="/tmp/voice.json"),
        sample_rate=16000,
    )

    assert engine.synthesize("hello") is True
    assert engine.queue.get_nowait() == b"\x01\x00"
    assert calls == [
        {
            "piper_path": "/usr/bin/piper",
            "voice": module.PiperVoiceConfig(
                voice_id="active",
                model_file="/tmp/voice.onnx",
                config_file="/tmp/voice.json",
            ),
            "text": "hello",
            "use_cuda": False,
            "debug": False,
        }
    ]
