"""Regression locks for the current Piper-backed TTS service behavior."""

from __future__ import annotations

import asyncio
import base64
import io
import subprocess
import sys
import types
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.tts.service import TTSService
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.gateway import GatewayMethods
from app.shared.contracts.models.tts import (
    TTSMethods,
    TTSRequest,
    TTSSynthesizeRequest,
)
from app.shared.messaging import bus_init


@pytest.fixture
def mock_bus():
    bus = Mock()
    bus.publish = AsyncMock()
    bus.subscribe = Mock()
    bus.unsubscribe = Mock()
    bus_init.set_bus(bus)
    yield bus
    bus_init._bus = None
    bus_init._service_buses.clear()


@pytest.fixture
def service(mock_bus):
    svc = TTSService()
    svc.stream = Mock()
    svc.stream.stop = Mock()
    svc.stream.pause = Mock()
    svc.stream.resume = Mock()
    svc.stream.feed = Mock()
    svc.stream.play_async = Mock()
    return svc


@pytest.fixture
def fake_realtimetts(monkeypatch):
    module = types.ModuleType("RealtimeTTS")

    class PiperVoice:
        def __init__(self, *, model_file: str, config_file: str | None = None) -> None:
            self.model_file = model_file
            self.config_file = config_file

    class TextToAudioStream:
        instances: list[TextToAudioStream] = []

        def __init__(self, engine, **kwargs) -> None:
            self.engine = engine
            self.kwargs = kwargs
            self.stop = Mock()
            self.pause = Mock()
            self.resume = Mock()
            self.feed = Mock()
            self.play_async = Mock()
            self.__class__.instances.append(self)

    module.PiperVoice = PiperVoice
    module.TextToAudioStream = TextToAudioStream
    monkeypatch.setitem(sys.modules, "RealtimeTTS", module)
    return module


@pytest.fixture
def fake_piper_engine(monkeypatch):
    module = types.ModuleType("app.services.tts.piper_engine")

    class PiperEngine:
        instances: list[PiperEngine] = []

        def __init__(self, *, piper_path, voice, sample_rate) -> None:
            self.piper_path = piper_path
            self.voice = voice
            self._sample_rate = sample_rate
            self._use_cuda = "disabled"
            self.__class__.instances.append(self)

    module.PiperEngine = PiperEngine
    monkeypatch.setitem(sys.modules, "app.services.tts.piper_engine", module)
    return module


def _decode_wav(encoded_audio: str) -> tuple[bytes, int, int, int]:
    with wave.open(io.BytesIO(base64.b64decode(encoded_audio)), "rb") as wav_file:
        return (
            wav_file.readframes(wav_file.getnframes()),
            wav_file.getframerate(),
            wav_file.getnchannels(),
            wav_file.getsampwidth(),
        )


@pytest.mark.asyncio
async def test_synthesize_returns_golden_wav_container_for_piper_pcm(
    service: TTSService, monkeypatch
) -> None:
    """returns a mono 16-bit WAV container when Piper finite synthesis requests wav."""
    pcm = b"\x01\x00\x02\x00\x03\x00\x04\x00"

    async def synthesize(text: str) -> tuple[bytes, int]:
        assert text == "golden text"
        return pcm, 22050

    monkeypatch.setattr(service, "_synthesize_to_bytes", synthesize)

    response = await service.synthesize(TTSSynthesizeRequest(text="golden text", format="wav"))

    assert response.format == "wav"
    assert response.sample_rate == 22050
    assert response.channels == 1
    assert response.duration_ms == pytest.approx(4 / 22050 * 1000)
    assert _decode_wav(response.audio_data) == (pcm, 22050, 1, 2)


@pytest.mark.asyncio
async def test_synthesize_returns_golden_raw_pcm_for_piper_pcm(
    service: TTSService, monkeypatch
) -> None:
    """returns raw PCM bytes when Piper finite synthesis requests raw."""
    pcm = b"\x10\x00\x20\x00"

    async def synthesize(_text: str) -> tuple[bytes, int]:
        return pcm, 24000

    monkeypatch.setattr(service, "_synthesize_to_bytes", synthesize)

    response = await service.synthesize(TTSSynthesizeRequest(text="raw text", format="raw"))

    assert response.format == "raw"
    assert response.sample_rate == 24000
    assert base64.b64decode(response.audio_data) == pcm
    assert response.duration_ms == pytest.approx(2 / 24000 * 1000)


@pytest.mark.asyncio
async def test_piper_finite_synthesis_invokes_cli_off_event_loop(
    service: TTSService, tmp_path, monkeypatch
) -> None:
    """runs the Piper CLI through asyncio.to_thread for finite synthesis."""
    model_path = tmp_path / "voice.onnx"
    config_path = tmp_path / "voice.onnx.json"
    model_path.write_bytes(b"model")
    config_path.write_text("{}", encoding="utf-8")
    service.engine = SimpleNamespace(piper_path="/usr/bin/piper", _use_cuda="disabled")
    run_calls: list[dict[str, object]] = []
    to_thread_calls: list[object] = []

    async def get_model_paths() -> tuple[str, str]:
        return str(model_path), str(config_path)

    def fake_run(cmd, *, input, capture_output, check, shell):
        output_path = cmd[cmd.index("-f") + 1]
        with wave.open(output_path, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(16000)
            wav_file.writeframes(b"\x05\x00\x06\x00")
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

    monkeypatch.setattr(service, "_get_model_paths", get_model_paths)
    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)

    audio, sample_rate = await service._synthesize_to_bytes("threaded")

    assert audio == b"\x05\x00\x06\x00"
    assert sample_rate == 16000
    assert to_thread_calls == [fake_run]
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
async def test_synthesize_maps_piper_failure_without_echoing_request_text(
    service: TTSService, monkeypatch
) -> None:
    """maps Piper failures without including the requested text in the error."""

    async def fail_synthesis(_text: str) -> tuple[bytes, int]:
        raise subprocess.CalledProcessError(
            returncode=1,
            cmd=["piper"],
            stderr=b"model unavailable",
        )

    monkeypatch.setattr(service, "_synthesize_to_bytes", fail_synthesis)

    with pytest.raises(RuntimeError) as exc_info:
        await service.synthesize(TTSSynthesizeRequest(text="private words", format="wav"))

    assert str(exc_info.value) == "Piper synthesis failed: model unavailable"
    assert "private words" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_tts_request_error_event_does_not_include_request_text(
    service: TTSService, mock_bus, monkeypatch
) -> None:
    """publishes a TTS error event without copying request text into the payload."""

    async def fail_playback(_text: str, _request_id: str) -> None:
        raise RuntimeError("audio output unavailable")

    monkeypatch.setattr(service, "_play_text", fail_playback)

    await service._on_tts_request(TTSRequest(text="do not echo this"))

    error_call = next(
        call for call in mock_bus.publish.await_args_list if call.args[0] == TTSMethods.ERROR
    )
    assert error_call.args[1].error == "audio output unavailable"
    assert not hasattr(error_call.args[1], "text")
    assert error_call.kwargs["event"] is True
    assert error_call.kwargs["mesh"] is False


@pytest.mark.asyncio
async def test_pause_controls_current_playback(service: TTSService, mock_bus) -> None:
    """pauses active playback and emits the typed paused event."""
    service._playing = True

    await service._on_pause(EmptyInput())

    assert service._paused is True
    service.stream.pause.assert_called_once_with()
    paused_call = next(
        call for call in mock_bus.publish.await_args_list if call.args[0] == TTSMethods.PAUSED
    )
    assert paused_call.kwargs["event"] is True
    assert paused_call.kwargs["mesh"] is False


@pytest.mark.asyncio
async def test_resume_controls_paused_playback(service: TTSService, mock_bus) -> None:
    """resumes paused playback and emits the typed resumed event."""
    service._playing = True
    service._paused = True

    await service._on_resume(EmptyInput())

    assert service._paused is False
    service.stream.resume.assert_called_once_with()
    resumed_call = next(
        call for call in mock_bus.publish.await_args_list if call.args[0] == TTSMethods.RESUMED
    )
    assert resumed_call.kwargs["event"] is True
    assert resumed_call.kwargs["mesh"] is False


@pytest.mark.asyncio
async def test_start_initializes_piper_stream_and_stop_stops_it(
    service: TTSService,
    fake_realtimetts,
    fake_piper_engine,
    monkeypatch,
) -> None:
    """starts the current Piper stream and stops it during shutdown."""

    async def get_model_paths() -> tuple[str, str]:
        return "/tmp/current.onnx", "/tmp/current.onnx.json"

    async def fake_config(*_args, **_kwargs):
        return SimpleNamespace(model_sample_rate=16000, piper_path="/opt/piper")

    monkeypatch.setattr(service, "_get_model_paths", get_model_paths)
    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.shutil.which", lambda _name: None)

    await service.on_start()
    await service.on_stop()

    engine = fake_piper_engine.PiperEngine.instances[-1]
    stream = fake_realtimetts.TextToAudioStream.instances[-1]
    assert service._loop is asyncio.get_running_loop()
    assert engine.piper_path == "/opt/piper"
    assert engine._sample_rate == 16000
    assert stream.engine is engine
    stream.stop.assert_called_once_with()


@pytest.mark.asyncio
async def test_base_service_thread_lifecycle_subscribes_and_departures(
    mock_bus,
    fake_realtimetts,
    fake_piper_engine,
    monkeypatch,
) -> None:
    """uses BaseService start/stop lifecycle for TTS in thread mode."""
    service = TTSService()

    async def fake_initialize_engine() -> None:
        service.stream = Mock()
        service.stream.stop = Mock()

    async def runtime_enabled() -> bool:
        return True

    monkeypatch.setattr(service, "_initialize_engine", fake_initialize_engine)
    monkeypatch.setattr(service, "_is_runtime_enabled", runtime_enabled)

    await service.start()
    await service.stop()

    subscribed_topics = [call.args[0] for call in mock_bus.subscribe.call_args_list]
    unsubscribed_topics = [call.args[0] for call in mock_bus.unsubscribe.call_args_list]
    published_topics = [call.args[0] for call in mock_bus.publish.await_args_list]
    assert TTSMethods.REQUEST in subscribed_topics
    assert TTSMethods.SYNTHESIZE in subscribed_topics
    assert TTSMethods.STREAM_START in subscribed_topics
    assert TTSMethods.STOP in subscribed_topics
    assert TTSMethods.REQUEST in unsubscribed_topics
    assert GatewayMethods.SERVICE_ANNOUNCE in published_topics
    assert GatewayMethods.SERVICE_DEPART in published_topics
    service.stream.stop.assert_called_once_with()


@pytest.mark.asyncio
async def test_process_entrypoint_starts_and_stops_tts_service(monkeypatch) -> None:
    """starts and stops the TTS service through the process-mode entrypoint."""
    from app.services.tts import __main__ as tts_main

    events: list[str] = []
    bus = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())
    service = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())

    class ShutdownSignalWaiter:
        def __init__(self, service_name: str) -> None:
            events.append(f"install:{service_name}")

        async def wait(self) -> None:
            events.append("wait")

        def close(self) -> None:
            events.append("close")

    monkeypatch.setattr(tts_main, "register_all_service_topics", lambda: events.append("topics"))
    monkeypatch.setattr(
        tts_main,
        "initialize_bus_for_service",
        lambda service_name: events.append(service_name) or bus,
    )
    monkeypatch.setattr(tts_main, "TTSService", lambda: service)
    monkeypatch.setattr(tts_main, "ShutdownSignalWaiter", ShutdownSignalWaiter)

    await tts_main.main()

    assert events == ["install:TTSService", "topics", "TTSService", "wait", "close"]
    bus.start.assert_awaited_once_with()
    service.start.assert_awaited_once_with()
    service.stop.assert_awaited_once_with()
    bus.stop.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_process_entrypoint_stops_bus_when_tts_service_stop_fails(
    monkeypatch,
) -> None:
    """stops the process bus even when service cleanup raises."""
    from app.services.tts import __main__ as tts_main

    class ShutdownSignalWaiter:
        def __init__(self, _service_name: str) -> None:
            pass

        async def wait(self) -> None:
            pass

        def close(self) -> None:
            pass

    bus = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())
    service = SimpleNamespace(
        start=AsyncMock(),
        stop=AsyncMock(side_effect=RuntimeError("stop failed")),
    )

    monkeypatch.setattr(tts_main, "register_all_service_topics", lambda: None)
    monkeypatch.setattr(tts_main, "initialize_bus_for_service", lambda _service_name: bus)
    monkeypatch.setattr(tts_main, "TTSService", lambda: service)
    monkeypatch.setattr(tts_main, "ShutdownSignalWaiter", ShutdownSignalWaiter)

    with pytest.raises(RuntimeError, match="stop failed"):
        await tts_main.main()

    service.stop.assert_awaited_once_with()
    bus.stop.assert_awaited_once_with()
